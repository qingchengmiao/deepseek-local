// QQ 消息处理流水线 —— 把原来堆在 qqProcessItems 里的 if 链拆成有序阶段。
//
// 为什么拆：以前「去重 / 记账 / 只记不回 / 生成 / 分段 / 发送」全挤在一个函数里，
// 想加一个「白名单」「限流」「群聊里先判断该不该接话」「发完把事件记下来」，
// 就得往中间插 if，插几次之后没人敢动。拆成阶段后：新增能力 = 新增一段，
// 顺序一眼能看出来，每段还能各自报耗时（ctx.trace），出问题知道是哪一段慢/炸的。
//
// 阶段约定：run(ctx) 可以抛（默认视为致命，整批放弃），也可以返回 { stop: true } 提前收尾。
// 标了 optional: true 的阶段抛错只记进 trace，不影响后面。

/** 跑一组阶段；返回同一个 ctx，ctx.trace 里是每段的名字、耗时、是否停下 */
export function createPipeline(stages) {
  return async function run(ctx) {
    const trace = [];
    ctx.trace = trace;
    for (const st of stages) {
      const t0 = Date.now();
      let out;
      try {
        out = await st.run(ctx);
      } catch (e) {
        trace.push({ stage: st.name, ms: Date.now() - t0, error: e.message });
        if (!st.optional) throw e;
        continue;
      }
      trace.push({ stage: st.name, ms: Date.now() - t0, stop: !!(out && out.stop) });
      if (out && out.stop) break;
    }
    return ctx;
  };
}

/**
 * QQ 收到一批消息后的标准阶段表。
 * d 由 server.mjs 注入（那边有 qqState、持久化、模型、发送通道）。
 */
export function qqStages(d) {
  const {
    state, pickNew, saveQqSeen, qqRemember, qqConversation,
    qqImageAttachments, qqUserPrompt, chatOnce, qqSemanticParts,
    qqSendText, newMessage, saveConversation,
    qqEnrichItem = null, // 补料：引用原文、文件本地路径、文本类文件预览（没有就跳过）
    sleep = ms => new Promise(r => setTimeout(r, ms)),
    now = Date.now, log = () => {},
    onConversation = null, // 每轮聊完的回调（事件系统在这里捞事件）
  } = d;

  return [
    {
      // 1. 去重：只留没见过的，并且把「见过」立刻落盘——不然重启会补答一堆旧消息
      name: 'dedupe',
      async run(ctx) {
        const { fresh, seen } = pickNew(ctx.list, state.seen);
        // ★ 这里原来写的是「长度变了才落盘」。seen 到 300 上限之后，进来一条也还是 300，
        //   于是那个 id 永远进不了 seen —— 同一条消息每轮都被当成新的，客户端无限复读、QQ 那头被刷屏。
        //   判据只能是「这一轮确实有新的」，不能再靠长度。
        const changed = fresh.length > 0 || seen.length !== state.seen.length;
        if (changed) {
          state.seen = seen;
          await saveQqSeen();
        }
        state.lastPollAt = now();
        state.lastPollMs = state.lastPollAt - ctx.t0;
        // 只回「刚说的」：历史接口会把最近的旧消息一起带回来，超过 3 分钟的一律只记账、不回，
        // 免得重启 / 重连之后对着几分钟前的旧话连发一串回答。
        const t = now();
        const AGE_MS = 3 * 60e3;
        const usableFresh = fresh.filter(item => {
          const at = Number(item.time) || 0;
          return !at || t - at <= AGE_MS;
        });
        ctx.staleSkipped = fresh.length - usableFresh.length;
        ctx.freshList = usableFresh;
        // 「有内容可回」的判据：光有文字，或者是图片 / 文件 / 语音 / 视频 / 引用别人的某一句话。
        // 少了后四种，纯文件消息和纯引用消息会被当成空消息直接丢掉（以前就是这样）。
        ctx.usable = usableFresh.filter(item => item.text
          || (item.images && item.images.length)
          || (item.files && item.files.length)
          || (item.records && item.records.length)
          || (item.videos && item.videos.length)
          || item.replyId);
        ctx.usableText = ctx.usable.slice(); // 阶段之间不改同一个数组
      },
    },
    {
      // 2. 补料：引用回复把被引用的原文取回来，文件/语音把本地路径和文本预览补上。
      //    放在记账之前 —— 记账记的才是「补完料的、能看懂的那句话」。
      name: 'enrich',
      optional: true,
      async run(ctx) {
        if (!qqEnrichItem) return;
        for (const item of ctx.usable) {
          try {
            await qqEnrichItem(ctx.cfg, item);
          } catch (e) {
            log('[QQ] 补料失败：' + e.message);
          }
        }
      },
    },
    {
      // 2. 记账：本地留痕（谁说了什么），出问题能翻
      name: 'record',
      async run(ctx) {
        for (const item of ctx.usable) {
          state.received += 1;
          qqRemember({
            dir: 'in', text: item.text, uid: item.uid, nick: item.nick || '',
            messageId: item.messageId, images: item.images.length,
          });
        }
        if (!ctx.usable.length) return { stop: true };
      },
    },
    {
      // 3. 只记不回：模式是 send / 或者这次不该回，就把话记进会话，界面能看见，但不说话
      name: 'logOnly',
      async run(ctx) {
        if (ctx.reply && ctx.cfg.mode === 'both') return;
        const conv = await qqConversation();
        try {
          for (const item of ctx.usable) {
            const atts = await qqImageAttachments(ctx.cfg, item);
            // 会话里只存对方说的原话。【来自 QQ…】那种抬头是装配时才加的壳，
            // 存进来只会让界面和模型的历史里全是括号机器话。
            const extra = { relay: item };
            if (atts.length) extra.attachments = atts;
            conv.messages.push(newMessage('user', item.text || '', extra));
          }
          conv.updatedAt = now();
          await saveConversation(conv);
        } catch { /* 记不进去就算了，别影响发送 */ }
        ctx.done = true;
        return { stop: true };
      },
    },
    {
      // 4. 备料：把每条消息变成「这一轮要问模型的话」+ 附件，和真正发请求分开
      name: 'compose',
      async run(ctx) {
        ctx.work = [];
        for (const item of ctx.usable) {
          // 这里只备「对方说了什么」，不拼抬头也不拼指令——
          // 抬头（来自谁、几点）和「像在手机上说话」的口吻都由 chatOnce/buildMessages 在装配时加。
          const atts = await qqImageAttachments(ctx.cfg, item);
          ctx.work.push({ item, ask: String(item.text || ''), atts });
        }
      },
    },
    {
      // 5. 生成 + 发送：一条消息一轮完整对话（不合并成一批），逐段发、段间留节奏
      name: 'reply',
      async run(ctx) {
        const conv = await qqConversation();
        ctx.conv = conv;
        for (const { item, ask, atts } of ctx.work) {
          try {
            const res = await chatOnce(conv, ask, ctx.settings, { attachments: atts, relay: item, mobile: true });
            const parts = qqSemanticParts(res.answer, { maxParts: 3, paraMax: 140, lineMax: 90 });
            const ids = [];
            for (let i = 0; i < parts.length; i++) {
              if (i) await sleep(700);
              const sent = await qqSendText(parts[i]);
              if (sent) ids.push(sent);
            }
            ctx.outs.push({ messageId: item.messageId, answer: res.answer.slice(0, 120), parts: parts.length, sentIds: ids });
          } catch (e) {
            state.lastError = '回复失败：' + e.message;
            qqRemember({ dir: 'error', text: e.message });
            log('[QQ] 回复失败：' + e.message);
          }
        }
      },
    },
    {
      // 6. 收尾：把这一轮聊出来的东西交给事件系统（谁约了几点、什么要到期）
      name: 'after',
      optional: true,
      async run(ctx) {
        if (!onConversation) return;
        const conv = ctx.conv || null;
        if (!conv) return;
        await onConversation({ conv, items: ctx.usable, outs: ctx.outs, settings: ctx.settings, cfg: ctx.cfg });
      },
    },
  ];
}

export default { createPipeline, qqStages };
