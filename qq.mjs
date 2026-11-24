// QQ 通道（OneBot 11 的 HTTP 半边）。
// 插件 dsh-qq-bridge 用的就是同一套接口，这里直接说 OneBot 11，不依赖 DSH 进程。
// 只做四件事：查登录、发私聊/群、拉最近消息、把消息段拆成文字+图片。

const DEFAULT_BASE = 'http://127.0.0.1:3000';

/** 把设置里的字段归一成一份连接配置 */
export function qqConfig(settings = {}) {
  const baseUrl = String(settings.qqBaseUrl || DEFAULT_BASE).trim().replace(/\/+$/, '');
  return {
    baseUrl: /^https?:\/\//i.test(baseUrl) ? baseUrl : DEFAULT_BASE,
    token: String(settings.qqToken || '').trim(),
    uid: String(settings.qqUid || '').trim(),
    group: String(settings.qqGroup || '').trim(),
    mode: ['off', 'send', 'both'].includes(settings.qqMode) ? settings.qqMode : 'off',
    pollMs: Math.min(60000, Math.max(2000, Number(settings.qqPollMs) || 5000)),
  };
}

/** 调 OneBot 11 的一个 action；失败抛错，带 HTTP 状态和一小段响应 */
export async function onebot(cfg, action, params = {}, { timeoutMs = 8000 } = {}) {
  const url = `${cfg.baseUrl}/${action}`;
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  const r = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 160)}`);
  let data = null;
  try { data = JSON.parse(text); } catch { throw new Error(`返回不是 JSON：${text.slice(0, 120)}`); }
  if (data && data.status === 'failed') throw new Error(`OneBot 失败：${data.message || data.wording || '未知原因'}`);
  return data;
}

/** 登录信息 → { uid, nick, online }；连不上返回 { ok:false, error } */
export async function loginInfo(cfg) {
  try {
    const d = await onebot(cfg, 'get_login_info');
    const d2 = d?.data || {};
    return { ok: true, uid: String(d2.user_id || ''), nick: String(d2.nickname || ''), raw: d2 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function sendPrivate(cfg, text) {
  if (!cfg.uid) throw new Error('没填私聊 QQ 号');
  const d = await onebot(cfg, 'send_private_msg', { user_id: Number(cfg.uid), message: [{ type: 'text', data: { text } }] });
  return d?.data || {};
}

export async function sendGroup(cfg, text) {
  if (!cfg.group) throw new Error('没填群号');
  const d = await onebot(cfg, 'send_group_msg', { group_id: Number(cfg.group), message: [{ type: 'text', data: { text } }] });
  return d?.data || {};
}

/** 把 OneBot 的消息段摊平成文字 + 图片文件标识 */
export function flattenSegments(message) {
  const segs = Array.isArray(message) ? message : [];
  const parts = [];
  const images = [];
  for (const s of segs) {
    const t = s?.type;
    const d = s?.data || {};
    if (t === 'text') parts.push(String(d.text || ''));
    else if (t === 'at') parts.push(`@${d.qq === 'all' ? '全体' : d.qq}`);
    else if (t === 'image') {
      images.push(String(d.file || d.url || ''));
      parts.push('[图片]');
    } else if (t === 'face') parts.push('[表情]');
    else if (t === 'record') parts.push('[语音]');
    else if (t === 'video') parts.push('[视频]');
    else if (t === 'file') parts.push(`[文件 ${d.name || ''}]`);
  }
  return { text: parts.join('').trim(), images };
}

/** 历史接口返回的数组（兼容 data 包一层） */
function historyArray(d) {
  const data = d?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.messages)) return data.messages;
  return [];
}

/** 拉私聊历史；返回 [{ messageId, uid, time, text, images, raw }]（按时间正序） */
export async function friendHistory(cfg, { count = 20 } = {}) {
  if (!cfg.uid) return [];
  const d = await onebot(cfg, 'get_friend_msg_history', { user_id: Number(cfg.uid), count });
  return historyArray(d).map(m => ({
    messageId: String(m.message_id || m.msgId || ''),
    uid: String(m.sender?.user_id || m.user_id || cfg.uid),
    time: Number(m.time || 0) * 1000 || Date.now(),
    ...flattenSegments(m.message),
    raw: m,
  })).sort((a, b) => a.time - b.time);
}

/** 拉群历史 */
export async function groupHistory(cfg, { count = 20 } = {}) {
  if (!cfg.group) return [];
  const d = await onebot(cfg, 'get_group_msg_history', { group_id: Number(cfg.group), count });
  return historyArray(d).map(m => ({
    messageId: String(m.message_id || m.msgId || ''),
    uid: String(m.sender?.user_id || m.user_id || ''),
    nick: String(m.sender?.card || m.sender?.nickname || ''),
    groupId: String(m.group_id || cfg.group),
    time: Number(m.time || 0) * 1000 || Date.now(),
    ...flattenSegments(m.message),
    raw: m,
  })).sort((a, b) => a.time - b.time);
}

/** 过滤出「比 seen 新」的消息；同时返回新的 seen 集合（最多留 300 条 id） */
export function pickNew(list, seenIds = []) {
  const seen = new Set(seenIds);
  const fresh = list.filter(m => m.messageId && !seen.has(m.messageId));
  const nextSeen = [...seenIds, ...fresh.map(m => m.messageId)].slice(-300);
  return { fresh, seen: nextSeen };
}

/** 发给模型的提示词：告诉它这条来自 QQ */
export function qqUserPrompt(item, { callName = '对方' } = {}) {
  const who = item.groupId ? `QQ 群 ${item.groupId} 里的 ${item.nick || item.uid}` : `QQ 上的${callName}（${item.uid}）`;
  return `【来自 ${who}，${new Date(item.time).toLocaleString('zh-CN')}】\n${item.text || '（只有图片，没有文字）'}`;
}

/** 把 OneBot 的 message 事件（push 过来的）转成和历史接口一样的形状；不是消息事件返回 null */
export function eventToItem(ev) {
  if (!ev || ev.post_type !== 'message') return null;
  const mt = String(ev.message_type || '');
  const gid = mt === 'group' ? String(ev.group_id || '') : '';
  const segs = Array.isArray(ev.message) ? ev.message : [];
  const flat = flattenSegments(segs);
  return {
    messageId: String(ev.message_id || ev.msgId || ''),
    uid: String(ev.user_id || ''),
    nick: String(ev.sender?.card || ev.sender?.nickname || ''),
    groupId: gid,
    time: Number(ev.time || 0) * 1000 || Date.now(),
    ...flat,
    raw: ev,
  };
}
