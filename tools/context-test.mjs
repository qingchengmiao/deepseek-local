// 上下文管理测试：先跑纯函数（token 估算 / 分段 / 向量检索 / 时间衰减 / 裁剪），
// 再把服务端指向本地假上游，验证「自动压缩 + 向量召回 + 时间权重」真的接进了对话链路。
//
// 用法：node tools/context-test.mjs
//   - 会临时改 data/settings.json（baseUrl → 假上游、预算调小），跑完还原
//   - 只在本机没存真 Key 时跑集成部分；有 Key 的话跳过（免得把真 Key 覆盖掉）
import { liveGuard } from './_guard.mjs';
import { readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import {
  estimateTokens,
  estimateMessageTokens,
  chunkMessages,
  buildIndex,
  retrieve,
  decayWeight,
  trimByAge,
  tokenize,
  MEMORY_SYSTEM,
  memoryUserPrompt,
  CTX_DEFAULTS,
  cosineDense,
  keywordsOf,
  parseActivateRequest,
  CONSOLIDATE_SYSTEM,
  consolidateUserPrompt,
} from '../context.mjs';

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

const BASE = process.env.CTX_BASE || process.env.BASE || 'http://127.0.0.1:8787';
await liveGuard(BASE, 'context-test');
const MOCK = 'http://127.0.0.1:8899';
const DATA_DIR = process.env.DSAPP_DATA || 'data';
const RECORD = process.env.MOCK_RECORD || 'data/mock-last.json';
const SEQ = process.env.MOCK_SEQ || 'data/mock-seq.json';

// ---------------------------------------------------------------- 纯函数

console.log('1) token 估算');
{
  const zh = estimateTokens('你好世界');
  const en = estimateTokens('hello world');
  const mixed = estimateTokens('中文 English 混排 123');
  check('中文 4 字 ≈ 4~5 token', zh >= 4 && zh <= 6, String(zh));
  check('英文 11 字符 ≈ 3~4 token', en >= 3 && en <= 5, String(en));
  check('混排是两者的和附近', mixed > 4 && mixed < 20, String(mixed));
  check('空串是 0', estimateTokens('') === 0);
  const msg = { role: 'user', content: '一二三四五', reasoning: '想了很多很多很多', attachments: [{ kind: 'image' }] };
  const t = estimateMessageTokens(msg);
  check('消息估算把图片算进去（+800 上下）', t >= 800 && t < 900, String(t));
  check('比只算正文大', t > estimateTokens(msg.content));
}

console.log('2) 分词与分段');
{
  const toks = tokenize('蓝鲸的心率是多少 Blue Whale 42');
  check('中文出了二元组', toks.includes('蓝鲸') && toks.includes('心率'), toks.slice(0, 6).join(','));
  check('英文单词保留', toks.includes('blue') && toks.includes('whale'));
  check('单个字符也留', tokenize('鲸').includes('鲸'));

  const msgs = [];
  for (let i = 0; i < 12; i++) {
    msgs.push({ role: i % 2 ? 'assistant' : 'user', content: '这是一段用于测试分段的文字，'.repeat(6) + `第${i}条` });
  }
  const chunks = chunkMessages(msgs, { maxTokens: 120 });
  check('分成了多段', chunks.length > 1, String(chunks.length));
  check('段覆盖全部消息', chunks[0].from === 0 && chunks[chunks.length - 1].to === msgs.length - 1);
  check('每段不超过阈值太多', chunks.every(c => c.tokens < 200), chunks.map(c => c.tokens).join(','));
  check('每段有角色前缀', /^(我|助手)：/.test(chunks[0].text));
}

console.log('3) 向量索引与召回');
{
  const msgs = [
    { role: 'user', content: '我家蓝鲸的心率是每分钟八次' },
    { role: 'assistant', content: '蓝鲸心率通常很低，潜水时会更慢' },
    { role: 'user', content: '帮我写一个批量重命名的 PowerShell 脚本' },
    { role: 'assistant', content: '可以这样写：Get-ChildItem | Rename-Item' },
    { role: 'user', content: '今天天气怎么样' },
    { role: 'assistant', content: '今天多云，气温 21 度' },
  ];
  const chunks = chunkMessages(msgs, { maxTokens: 20, minTokens: 5 });
  const index = buildIndex(chunks);
  check('词表维度非空（不再哈希降维）', index.dims > 0 && index.dims === index.terms.size, 'dims=' + index.dims + ' chunks=' + chunks.length);
  check('每段都有向量', index.chunks.every(c => Array.isArray(c.vec) && c.vec.length > 0));

  const hits = retrieve({ index, query: '蓝鲸 心率', topK: 3 });
  check('能召回蓝鲸那段', hits.length > 0 && hits[0].chunk.text.includes('蓝鲸'), hits[0]?.chunk.text.slice(0, 24));
  const ps = retrieve({ index, query: 'powershell 重命名', topK: 3 });
  check('换个词换召回对象', ps.length > 0 && ps[0].chunk.text.includes('Rename-Item') === false && ps[0].chunk.text.includes('重命名'), ps[0]?.chunk.text.slice(0, 24));
  const none = retrieve({ index, query: '量子纠缠退相干', topK: 3 });
  check('完全不相关的查询召回为空（阈值生效）', none.length === 0);

  const all = retrieve({ index, query: '蓝鲸 心率', topK: 5, minScore: 0 });
  check('minScore=0 时按分数降序', all.every((h, i) => i === 0 || all[i - 1].score >= h.score));
}

console.log('4) 时间衰减');
{
  check('0 天 = 1', decayWeight(0, 7) === 1);
  check('一个半衰期 = 0.5', Math.abs(decayWeight(7, 7) - 0.5) < 1e-9);
  check('两个半衰期 = 0.25', Math.abs(decayWeight(14, 7) - 0.25) < 1e-9);
  check('半衰期可调', Math.abs(decayWeight(1, 1) - 0.5) < 1e-9);
  check('负年龄当 0 处理', decayWeight(-5, 7) === 1);

  // 同样相关度的两段，老的排序被压下去
  const msgs = [
    { role: 'user', content: '蓝鲸心率很低' },
    { role: 'assistant', content: '是的，蓝鲸心率很低' },
    { role: 'user', content: '别的话题' },
    { role: 'assistant', content: '别的话题的回答' },
  ];
  const chunks = chunkMessages(msgs, { maxTokens: 20, minTokens: 5 });
  const index = buildIndex(chunks);
  const base = retrieve({ index, query: '蓝鲸心率', topK: 4 });
  const aged = retrieve({
    index,
    query: '蓝鲸心率',
    topK: 4,
    weightOf: c => (c.from === 0 ? decayWeight(30, 7) : 1),
  });
  check('老片段权重被打下去后仍能召回，但分更低', aged.length > 0 && aged[0].score < base[0].score, `${aged[0].score.toFixed(3)} < ${base[0].score.toFixed(3)}`);
}

console.log('5) 按时间裁剪正文');
{
  const long = '开头很重要。' + '中间是很多很多细节。'.repeat(80) + '结尾也有用。';
  const fresh = trimByAge(long, 0.1, 7, 240);
  check('半衰期内不动', fresh.trimmed === false && fresh.text === long);
  const old = trimByAge(long, 30, 7, 240);
  check('很久以前的会被压短', old.trimmed === true && old.text.length < long.length);
  check('压短后留了提示', old.text.includes('按时间降权压缩'));
  const short = trimByAge('很短的一句话', 30, 7, 240);
  check('本来就短的不动', short.trimmed === false);
}

console.log('6) 压缩提示词');
{
  check('系统提示词带标记（假上游靠它识别压缩请求）', MEMORY_SYSTEM.startsWith('你是上下文压缩器'));
  check('提示词要求不编造', MEMORY_SYSTEM.includes('不许推测'));
  const p = memoryUserPrompt('旧记忆内容', '我：新对话内容');
  check('带上已有记忆', p.includes('【已有记忆】') && p.includes('旧记忆内容'));
  check('带上新对话', p.includes('【旧对话】') && p.includes('新对话内容'));
  const longp = memoryUserPrompt('', 'x'.repeat(30000), 1000);
  check('超长会被截断', longp.length < 1400, String(longp.length));
}

console.log('6.5) 稠密向量（给归档用的）');
{
  check('同向向量余弦 = 1', Math.abs(cosineDense([1, 0, 1], [1, 0, 1]) - 1) < 1e-9);
  check('正交 = 0', cosineDense([1, 0], [0, 1]) === 0);
  check('维度不一致返回 0（不炸）', cosineDense([1, 0], [1, 0, 0]) === 0);
  check('空向量返回 0', cosineDense([], []) === 0);
  const half = cosineDense([1, 1], [1, 0]);
  check('部分相似在 0~1 之间', half > 0.5 && half < 0.8, String(Math.round(half * 1000) / 1000));
}

console.log('6.6) 记忆关键词 / 展开指令 / 时间加权概括');
{
  const kw = keywordsOf('我家蓝鲸的心率是每分钟八次。蓝鲸心率这个数别记错，心率数据很重要。');
  check('关键词能抽出来', Array.isArray(kw) && kw.length > 0, kw.join('、'));
  check('关键词里没有单字噪声', kw.every(k => k.length >= 2), kw.join('、'));
  check('解析「展开第 3 条」', parseActivateRequest('展开第 3 条') === 3);
  check('解析「展开 #2」', parseActivateRequest('展开 #2') === 2);
  check('解析「恢复记忆 4」', parseActivateRequest('恢复记忆 4') === 4);
  check('普通问题不误判', parseActivateRequest('心率是多少？') === 0);
  check('概括提示写明了时间权重', CONSOLIDATE_SYSTEM.includes('时间权重') && CONSOLIDATE_SYSTEM.includes('关键词索引'));
  const cp = consolidateUserPrompt('旧记忆', [{ from: 0, to: 3, keywords: '心率', gist: '蓝鲸心率八次' }], '原文节选');
  check('概括输入拼了分段与关键词', cp.includes('【分段 #1】') && cp.includes('心率') && cp.includes('【原文节选】'), String(cp.length));
}

// ---------------------------------------------------------------- 集成

async function mathJson(path, opts) {
  const res = await fetch(BASE + path, opts);
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  return { res, data };
}
const put = (p, o) => mathJson(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const post = (p, o) => mathJson(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) });

async function mockUp() {
  try {
    const r = await fetch(MOCK + '/models', { signal: AbortSignal.timeout(600) });
    if (r.ok) return null;
  } catch {}
  const child = spawn(process.execPath, ['tools/mock-upstream.mjs'], { stdio: 'ignore', detached: true });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 150));
    try {
      const r = await fetch(MOCK + '/models', { signal: AbortSignal.timeout(500) });
      if (r.ok) return child;
    } catch {}
  }
  throw new Error('假上游没起来');
}

function parseSse(text) {
  const events = [];
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find(l => l.startsWith('data:'));
    if (!line) continue;
    const raw = line.slice(5).trim();
    if (raw === '[DONE]') continue;
    try { events.push(JSON.parse(raw)); } catch {}
  }
  return events;
}

async function live() {
  let orig;
  try {
    orig = (await mathJson('/api/settings')).data;
  } catch (e) {
    console.log('\n（服务没起，跳过集成部分：' + e.message + '）');
    return;
  }
  if (orig.hasKey) {
    console.log('\n（本机已存真 Key，跳过集成部分，避免覆盖）');
    return;
  }

  await mockUp();
  // 记一个时间点：假上游的流水（data/mock-seq.json）里每条都带 at，
  // 只看这之后发的请求，免得被上一次跑测留下的记录骗过去。
  const mockT0 = Date.now();
  const convIds = [];
  const filler = '这段是填充，用来撑大上下文预算，看看压缩会不会触发。'.repeat(14);
  try {
    console.log('7) 接进对话链路（假上游）');
    await put('/api/settings', { apiKey: 'sk-mock-ctx-key', baseUrl: MOCK, model: 'deepseek-flash', ctxCompress: true, ctxBudget: 4000, ctxRag: true, ctxTopK: 4, ctxHalfLifeDays: 7 });

    const c = await post('/api/conversations', { title: '上下文测试', model: 'deepseek-flash' });
    const convId = c.data.conversation.id;
    convIds.push(convId);

    const send = async content => {
      const res = await fetch(BASE + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: convId, mode: 'send', content, webSearch: false, thinking: true, autoTitle: false }),
      });
      return parseSse(await res.text());
    };

    const chatOn = async (id, content) => {
      const res = await fetch(BASE + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: id, mode: 'send', content, webSearch: false, thinking: false, autoTitle: false }),
      });
      return parseSse(await res.text());
    };

    const first = await send('记住：我家蓝鲸的心率是每分钟八次。' + filler);
    let types = first.map(e => e.type);
    check('有 context 事件', types.includes('context'), types.join(','));
    const ctxEv = first.find(e => e.type === 'context');
    check('context 带预算与原文占用', ctxEv && ctxEv.budget === 4000 && typeof ctxEv.tokens === 'number', ctxEv ? `budget=${ctxEv.budget} tokens=${ctxEv.tokens}` : '');
    check('第一轮还没压缩', !ctxEv || !ctxEv.memory);

    for (let i = 0; i < 9; i++) await send(`第 ${i + 2} 轮：继续聊 ${filler}`);

    // 压缩是后台任务：排进去后延迟 1.5s 才跑，本机小模型写摘要还要 1~3s，
    // 所以轮次一结束就立刻读状态会读到「还没压」。这里轮询等它落地，最多 40 秒。
    let st = (await mathJson('/api/conversations/' + convId + '/context')).data;
    for (let i = 0; i < 80 && !(st && st.memory && st.memory.covered > 0); i++) {
      await new Promise(r => setTimeout(r, 500));
      st = (await mathJson('/api/conversations/' + convId + '/context')).data;
    }
    // 压缩是后台任务：记忆落库之后，**下一轮**聊天才会把「对话记忆」拼进 system。
    // 前面那 10 轮都在压缩之前，流水里自然一条都没有；这里补发一轮让记忆块真的发出去。
    await send('压缩完再来一轮：蓝鲸心率还是每分钟八次吧？' + filler);
    // 本机推理是进程内的（2026-11-25 起不再问 ollama 端口）：data/models 里有没有 gguf，
    // 直接决定摘要引擎是 local 还是按设计回落 API。
    const lmNow = (await mathJson('/api/local-models')).data;
    const hasLocal = !!(lmNow && lmNow.alive);
    check('长对话后建了向量索引', st.indexChunks > 0, `chunks=${st.indexChunks}`);
    check('触发了自动压缩', !!st.memory && st.memory.covered > 0, st.memory ? `covered=${st.memory.covered}, tokens=${st.memory.tokens}, calls=${st.memory.calls}` : '没压缩');
    check('记忆里是模型写的结构化摘要', !!st.memory && (/##\s*(事实|长期事实)/.test(st.memory.text) || st.memory.text.includes('关键词索引')), st.memory ? st.memory.text.slice(0, 20) : '');
    check('上下文状态报得出摘要引擎', !!st.summarizer && ['local', 'api', 'none'].includes(st.summarizer.engine), JSON.stringify(st.summarizer || {}));
    // 默认优先本机：data/models 里有 gguf 时 engine 必须是 local；没有 gguf 就按设计回落 API。
    // （单段记忆仍可能因为「本地摘要质量不合格」回落到 API —— summaryLooksBad 的质检，设计内的）
    check('摘要引擎按有没有本机 gguf 决定（有就 local，没有回落 API）',
      !!st.summarizer && (hasLocal ? ['local', 'auto'].includes(st.summarizer.engine) : st.summarizer.engine === 'api'),
      `${JSON.stringify(st.summarizer || {})} hasLocal=${hasLocal}`);
    const memModel = String((st.memory && st.memory.model) || '');
    check('压缩确实用的是本机或按质量回落 API', !memModel || /^local:/.test(memModel) || /^deepseek-/.test(memModel), memModel);

    if (st.memory) {
      const payload = JSON.parse(await readFile(RECORD, 'utf8'));
      const body = payload.body || payload;
      const sys = (body.messages || []).filter(m => m.role === 'system').map(m => String(m.content));
      const hasMemInSeq = await (async () => {
        // mock-last.json 只留最后一条请求，而最后一条未必是带记忆块的那轮
        // （压缩请求本身也发到同一个上游，会把记录盖掉）。
        // 所以查假上游的流水：这次跑测发过的请求里，有没有一条带「【对话记忆 …】」。
        for (let i = 0; i < 20; i++) {
          try {
            const seq = JSON.parse(await readFile(SEQ, 'utf8'));
            if (Array.isArray(seq) && seq.some(r => r && r.at >= mockT0 && r.hasMemoryBlock)) return true;
          } catch {}
          await new Promise(r => setTimeout(r, 250));
        }
        return false;
      })();
      check('发给上游的请求里有记忆块', hasMemInSeq, `最后一条 system 条数=${sys.length}`);
      const historyMsgs = (body.messages || []).filter(m => m.role === 'user' || m.role === 'assistant');
      check('老消息没全量塞进去（原文条数被压下来了）', historyMsgs.length < st.historyMessages, `${historyMsgs.length} < ${st.historyMessages}`);
    }

    const pv = await post('/api/conversations/' + convId + '/context' + '/preview', { query: '蓝鲸 心率' });
    check('召回接口可用', pv.res.status === 200 && Array.isArray(pv.data.hits), String(pv.data.hits?.length));
    check('召回会把归档片段也算进来', typeof pv.data.archiveChunks === 'number', `archiveChunks=${pv.data.archiveChunks}`);
    if (pv.data.hits?.length) {
      check('召回命中了最早那条蓝鲸消息', pv.data.hits.some(h => h.text.includes('蓝鲸')), pv.data.hits[0].text.slice(0, 30));
      check('每条命中都带时间权重与年龄', pv.data.hits.every(h => typeof h.weight === 'number' && typeof h.ageDays === 'number'));
    }

    console.log('8) 本机小模型（进程内 gguf，data/models）');
    const lm = lmNow;
    check('能列出本机模型', typeof lm.alive === 'boolean' && Array.isArray(lm.models), `alive=${lm.alive} 模型 ${lm.models?.length || 0} 个`);
    if (lm.alive && lm.pick) {
      check('自动挑了对话模型（不是 embed 模型）', !!lm.pick && !/embed|bge|gte/i.test(lm.pick), lm.pick);
      const t0 = Date.now();
      const tr = (await post('/api/context/summary-test')).data;
      check('本机模型真能写摘要（关掉思考后很快）', tr.ok === true && String(tr.sample || '').length > 0, `${tr.model} ${tr.ms}ms → ${String(tr.sample || tr.error || '').slice(0, 40)}`);
      check('摘要耗时在可接受范围', Date.now() - t0 < 120000, `${Math.round((Date.now() - t0) / 1000)}s`);
    } else {
      console.log('  （data/models 里没有 gguf，跳过真调；压缩会走 API）');
    }

    console.log('9) 压缩前归档原文');
    const ar = (await mathJson('/api/conversations/' + convId + '/archive')).data;
    check('压缩时写了归档文件', ar.entries >= 1 && ar.messages > 0, `entries=${ar.entries} messages=${ar.messages} tokens=${ar.tokens}`);
    check('归档 index.json 有分段', ar.chunks > 0, `chunks=${ar.chunks}`);
    if (ar.list && ar.list.length) {
      const e = ar.list[0];
      let onDisk = false;
      try {
        const raw = JSON.parse(await readFile(DATA_DIR + '/archive/' + convId + '/' + e.file, 'utf8'));
        onDisk = Array.isArray(raw.messages) && raw.messages.length === e.messages;
      } catch {}
      check('归档 JSON 真在盘上且消息数对得上', onDisk, e.file);
      check('归档记了摘要引擎与时间', typeof e.engine === 'string' && e.engine.length > 0 && e.savedAt > 0, `${e.engine} @ ${new Date(e.savedAt).toLocaleTimeString()}`);
    }
    check('归档状态里有向量/词面说明', typeof ar.embedModel === 'string', ar.embedModel ? `向量：${ar.embedModel}` : '纯词面 BM25');

    console.log('9.5) 分档压概要 + 时间加权遗忘');
    const st2 = (await mathJson('/api/conversations/' + convId + '/context')).data;
    const recs = st2.memory?.records || [];
    check('记忆里记了分档概要', recs.length >= 1, `${recs.length} 段`);
    check('每条概要带区间 / 占用比例 / 关键词', recs.every(r => typeof r.from === 'number' && typeof r.rawRatio === 'number' && typeof r.keywords === 'string'), JSON.stringify(recs[0] || {}).slice(0, 120));
    check('记忆档位随占用涨上去', (st2.memory?.step || 0) >= 1, `step=${st2.memory?.step}`);
    // 把遗忘阈值调低，让「按时间权重概括 + 遗忘」这一级能在这条测试会话里触发
    await put('/api/settings', { ctxForgetRatio: 0.25, ctxCompress: true, ctxProgressive: true, ctxActivateScore: 0.9 });
    await send('再补一句：记住蓝鲸心率是每分钟八次。' + filler);
    // 合并成长期记忆也是后台任务（1.5s 延迟 + 本机写摘要），不能发完就问，轮询等它落地
    let st3 = (await mathJson('/api/conversations/' + convId + '/context')).data;
    for (let i = 0; i < 80 && !(st3 && st3.memory && (st3.memory.forgetStep || 0) >= 1); i++) {
      await new Promise(r => setTimeout(r, 500));
      st3 = (await mathJson('/api/conversations/' + convId + '/context')).data;
    }
    check('占用过阈值后做了时间加权概括', (st3.memory?.forgetStep || 0) >= 1 && !!st3.memory?.consolidated, `forgetStep=${st3.memory?.forgetStep} consolidated=${!!st3.memory?.consolidated}`);
    check('概括结果带关键词索引或长期事实段', !!st3.memory && (st3.memory.text.includes('关键词索引') || st3.memory.text.includes('长期事实')), String(st3.memory?.text || '').slice(0, 24));

    console.log('9.6) 渐进激活：关键词索引卡 + 展开原文');
    const ev1 = (await send('蓝鲸 心率 每分钟几次？' + filler)).find(e => e.type === 'context');
    const cards = ev1?.memoryIndex || [];
    check('渐进模式先给记忆索引卡（不直接塞原文）', cards.length > 0, `${cards.length} 张`);
    check('索引卡带关键词与区间', cards.every(c => typeof c.keywords === 'string' && typeof c.from === 'number'), JSON.stringify(cards[0] || {}).slice(0, 120));
    const ev2 = (await send('展开第 1 条')).find(e => e.type === 'context');
    check('说「展开第 1 条」就注入原文', !!ev2?.activated && ev2.activated.chars > 0, JSON.stringify(ev2?.activated || {}));
    if (ev2?.activated) {
      const act = await post('/api/conversations/' + convId + '/context' + '/activate', { from: ev2.activated.from, to: ev2.activated.to });
      check('展开接口能取回原文', act.res.status === 200 && String(act.data.text || '').length > 0, `${String(act.data.text || '').length} 字`);
    }
    await put('/api/settings', { ctxProgressive: false });
    const ev3 = (await send('蓝鲸 心率' + filler)).find(e => e.type === 'context');
    check('关掉渐进后不再给索引卡', !ev3?.memoryIndex || ev3.memoryIndex.length === 0, `${ev3?.memoryIndex?.length ?? 0} 张`);
    await put('/api/settings', { ctxProgressive: true, ctxActivateScore: 0.2 });

    console.log('9.7) 每个会话独立的上下文参数');
    const patchConv = (id, body) => mathJson('/api/conversations/' + id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const p1 = await patchConv(convId, { ctx: { ctxBudget: 8000, ctxTopK: 2, ctxRag: false } });
    check('PATCH 存下了会话级覆盖', p1.data.conversation?.ctx?.ctxBudget === 8000, JSON.stringify(p1.data.conversation?.ctx || {}));
    const c1 = (await mathJson('/api/conversations/' + convId + '/context')).data;
    check('状态里预算按会话走', c1.budget === 8000, 'budget=' + c1.budget);
    check('状态标出不再跟随全局', c1.ctx?.followGlobal === false && c1.ctx?.overrides?.ctxBudget === 8000, JSON.stringify(c1.ctx || {}));
    check('会话里的开关也生效（检索关掉）', c1.settings?.ctxRag === false, 'ctxRag=' + c1.settings?.ctxRag);
    check('状态报了预算上限 1M', c1.ctx?.budgetMax === 1000000, String(c1.ctx?.budgetMax));
    const evB = (await send('预算测试：' + filler)).find(e => e.type === 'context');
    check('发消息时按会话预算组装', evB?.budget === 8000, 'budget=' + evB?.budget);
    await patchConv(convId, { ctx: {} });
    const c2 = (await mathJson('/api/conversations/' + convId + '/context')).data;
    check('清掉覆盖后回到全局预算', c2.budget === 4000 && c2.ctx?.followGlobal === true, `budget=${c2.budget} followGlobal=${c2.ctx?.followGlobal}`);

    console.log('9.8) 记忆整合');
    const fresh = await post('/api/conversations', { title: '整合测试-无记录', model: 'deepseek-flash' });
    const freshId = fresh.data.conversation.id;
    convIds.push(freshId);
    // 先给它一条消息（有内容、但还没压过 → 没有分段记忆）
    await put('/api/settings', { ctxCompress: false });
    await chatOn(freshId, '只有一条消息，还没压过。');
    await put('/api/settings', { ctxCompress: true });
    const nr = await post('/api/conversations/' + freshId + '/context/consolidate');
    check('没有分段记忆时给 400 NO_RECORDS', nr.res.status === 400 && nr.data.code === 'NO_RECORDS', `${nr.res.status} ${nr.data.code || nr.data.error || ''}`);
    const cons = await post('/api/conversations/' + convId + '/context/consolidate');
    check('整合接口可用', cons.res.status === 200 && cons.data.ok === true, JSON.stringify(cons.data).slice(0, 90));
    check('整合结果带前后 token 与段数', typeof cons.data.before === 'number' && typeof cons.data.after === 'number' && typeof cons.data.segments === 'number', `before=${cons.data.before} after=${cons.data.after} segments=${cons.data.segments}`);

    console.log('10) 手动压缩 + 清空记忆');    const cp = await post('/api/conversations/' + convId + '/context' + '/compact');
    check('手动压缩可用', cp.res.status === 200 && cp.data.ok === true, JSON.stringify(cp.data).slice(0, 60));
    check('手动压缩也走了本机模型', !cp.data.memory || !cp.data.memory.model || cp.data.memory.model.startsWith('local:') || !!cp.data.warnings?.length, cp.data.memory?.model || '');

    const rs = await post('/api/conversations/' + convId + '/context' + '/reset');
    check('清空记忆可用', rs.res.status === 200 && !rs.data.memory, 'memory=' + JSON.stringify(rs.data.memory));
    check('清空记忆不动归档原文（原文还能翻）', ((await mathJson('/api/conversations/' + convId + '/archive')).data.entries) >= 1);

    // 关掉检索/压缩后不应再插 system 块
    await put('/api/settings', { ctxRag: false, ctxCompress: false });
    await send('最后一轮：' + filler);
    const payload2 = JSON.parse(await readFile(RECORD, 'utf8'));
    const body2 = payload2.body || payload2;
    const sys2 = (body2.messages || []).filter(m => m.role === 'system').map(m => String(m.content));
    check('关掉检索后不再插【检索到的旧片段】', !sys2.some(s => s.includes('【检索到的旧片段')));
    check('关掉压缩后不再插记忆', !sys2.some(s => s.includes('【对话记忆')));
  } finally {
    // 还原设置（orig 没真 Key 才能走到这里）
    await put('/api/settings', {
      apiKey: '',
      baseUrl: orig.baseUrl || 'https://api.deepseek.com',
      model: orig.model || 'deepseek-flash',
      ctxCompress: orig.ctxCompress ?? CTX_DEFAULTS.ctxCompress,
      ctxBudget: orig.ctxBudget ?? CTX_DEFAULTS.ctxBudget,
      ctxRag: orig.ctxRag ?? CTX_DEFAULTS.ctxRag,
      ctxTopK: orig.ctxTopK ?? CTX_DEFAULTS.ctxTopK,
      ctxHalfLifeDays: orig.ctxHalfLifeDays ?? CTX_DEFAULTS.ctxHalfLifeDays,
      ctxSummarizer: orig.ctxSummarizer ?? CTX_DEFAULTS.ctxSummarizer,
      ctxLocalModel: orig.ctxLocalModel ?? CTX_DEFAULTS.ctxLocalModel,
      ctxEmbedModel: orig.ctxEmbedModel ?? CTX_DEFAULTS.ctxEmbedModel,
      ctxArchive: orig.ctxArchive ?? CTX_DEFAULTS.ctxArchive,
      ctxStepRatio: orig.ctxStepRatio ?? CTX_DEFAULTS.ctxStepRatio,
      ctxForgetRatio: orig.ctxForgetRatio ?? CTX_DEFAULTS.ctxForgetRatio,
      ctxProgressive: orig.ctxProgressive ?? CTX_DEFAULTS.ctxProgressive,
      ctxActivateScore: orig.ctxActivateScore ?? CTX_DEFAULTS.ctxActivateScore,
    }).catch(() => {});
    // 归档是压缩产生的测试数据，清掉
    for (const id of convIds) {
      await mathJson('/api/conversations/' + id, { method: 'DELETE' }).catch(() => {});
      await rm(DATA_DIR + '/archive/' + id, { recursive: true, force: true }).catch(() => {});
    }
  }
}

await live();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
