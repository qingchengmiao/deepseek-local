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

// 消息段里常见 type 的人话名字。不认识的落到「[未知消息段:xxx]」，
// 而不是像以前那样静默丢掉——静默丢掉才是「引用/文件看不见」的根源。
const SEG_LABEL = {
  face: '表情', mface: '表情', bface: '表情',
  json: '卡片消息', xml: '卡片消息', markdown: '富文本',
  forward: '聊天记录', node: '聊天记录',
  dice: '骰子', rps: '猜拳', shake: '窗口抖动', poke: '戳一戳',
  share: '链接', location: '位置', music: '音乐', contact: '名片',
  redbag: '红包', gift: '礼物',
};

/** 17353 → "17.0 KB" */
function fmtSize(n) {
  const v = Number(n) || 0;
  if (!v) return '';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

/** CQ 码字符串 → 消息段数组（NapCat 的 messagePostFormat=string 时会给这种） */
export function parseCqString(s) {
  const str = String(s || '');
  if (!str) return [];
  const out = [];
  const re = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^\]]*)?)\]/g;
  let last = 0;
  let m;
  const unesc = (x) => String(x)
    .replace(/&#91;/g, '[').replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',').replace(/&amp;/g, '&');
  while ((m = re.exec(str))) {
    if (m.index > last) out.push({ type: 'text', data: { text: unesc(str.slice(last, m.index)) } });
    const data = {};
    for (const kv of String(m[2] || '').split(',').slice(1)) {
      const i = kv.indexOf('=');
      if (i > 0) data[kv.slice(0, i)] = unesc(kv.slice(i + 1));
    }
    out.push({ type: m[1], data });
    last = m.index + m[0].length;
  }
  if (last < str.length) out.push({ type: 'text', data: { text: unesc(str.slice(last)) } });
  return out;
}

/** 把 OneBot 的消息段摊平成：文字 + 各类媒体的结构信息。
 *  返回 { text, images, files, records, videos, replyId, replyUid, ats, kinds }
 *  - images   : 字符串（file/url），保持老形状，附件下载逻辑直接吃这个
 *  - files    : [{ name, id, size }]  —— NapCat 的 file 段把名字放 data.file，不是 data.name（旧代码在这读出空名）
 *  - records  : [{ file, url, seconds }]
 *  - videos   : [{ file, url }]
 *  - replyId  : 引用回复指向的 message_id（原来整段被丢掉，所以「引用对话」一直看不见）
 */
export function flattenSegments(message) {
  const segs = Array.isArray(message) ? message : parseCqString(message);
  const parts = [];
  const images = [];
  const files = [];
  const records = [];
  const videos = [];
  const ats = [];
  const kinds = [];
  let replyId = '';
  let replyUid = '';
  for (const s of segs) {
    const t = String(s?.type || '');
    const d = s?.data || {};
    if (t === 'text') {
      const txt = String(d.text || '');
      if (txt) parts.push(txt);
      continue;
    }
    kinds.push(t);
    if (t === 'at') {
      const who = d.qq === 'all' ? '全体' : String(d.qq || '');
      ats.push(who);
      parts.push(`@${who}`);
    } else if (t === 'reply') {
      replyId = String(d.id || '');
      replyUid = String(d.qq || '');
      // 先留一个标记，真正的内容由上层拿 get_msg 补进来
      parts.push('[引用了某条消息]');
    } else if (t === 'image') {
      const ref = String(d.file || d.url || d.path || '');
      if (ref) images.push(ref);
      parts.push('[图片]');
    } else if (t === 'file') {
      const name = String(d.file || d.name || d.file_name || '');
      const id = String(d.file_id || d.id || '');
      const size = Number(d.file_size || d.size || 0) || 0;
      files.push({ name, id, size, url: String(d.url || '') });
      const human = fmtSize(size);
      parts.push(`[文件：${name || '未命名'}${human ? `（${human}）` : ''}]`);
    } else if (t === 'record') {
      const sec = Number(d.seconds || d.duration || 0) || 0;
      records.push({ file: String(d.file || ''), url: String(d.url || ''), seconds: sec });
      parts.push(sec ? `[语音 ${Math.round(sec)} 秒]` : '[语音]');
    } else if (t === 'video') {
      videos.push({ file: String(d.file || ''), url: String(d.url || '') });
      const sec = Number(d.seconds || d.duration || 0) || 0;
      parts.push(sec ? `[视频 ${Math.round(sec)} 秒]` : '[视频]');
    } else if (SEG_LABEL[t]) {
      parts.push(`[${SEG_LABEL[t]}]`);
    } else {
      parts.push(`[未知消息段：${t}]`);
    }
  }
  return { text: parts.join('').trim(), images, files, records, videos, replyId, replyUid, ats, kinds };
}

/** 取一条历史消息的原文（引用回复要用它把被引用的内容捞回来） */
export async function getMessage(cfg, messageId) {
  const id = Number(messageId);
  if (!id) return null;
  const d = await onebot(cfg, 'get_msg', { message_id: id }, { timeoutMs: 12000 });
  const msg = d?.data && (d.data.message || d.data) ? (d.data.message || d.data) : d?.data;
  if (!msg) return null;
  return {
    messageId: String(d?.data?.message_id || id),
    uid: String(d?.data?.sender?.user_id || d?.data?.user_id || ''),
    nick: String(d?.data?.sender?.card || d?.data?.sender?.nickname || ''),
    time: Number(d?.data?.time || 0) * 1000 || 0,
    ...flattenSegments(msg),
  };
}

/** 文件段的本地路径/下载地址（NapCat 一般把收到的文件落到自己的 temp 目录） */
export async function getFileInfo(cfg, fileId, name = '') {
  const id = String(fileId || '').trim();
  if (!id) return null;
  const got = await onebot(cfg, 'get_file', { file_id: id, file: id, name }, { timeoutMs: 15000 }).catch(() => null);
  const d = (got && (got.data || got)) || {};
  const p = String(d.file || d.path || d.url || '');
  if (!p) return null;
  const nm = String(d.file_name || d.name || name || '');
  return { path: p, name: nm, size: Number(d.file_size || d.size || 0) || 0 };
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

/** 发给模型的提示词：告诉它这条来自 QQ，并把「他在回复哪一条」也带上 */
export function qqUserPrompt(item, { callName = '对方' } = {}) {
  const who = item.groupId ? `QQ 群 ${item.groupId} 里的 ${item.nick || item.uid}` : `QQ 上的${callName}（${item.uid}）`;
  const q = item.quote;
  const quoteLine = q && (q.text || (q.images && q.images.length))
    ? `\n（他这条是在回复${q.nick ? ` ${q.nick} ` : ''}之前那条：「${String(q.text || '[图片]').slice(0, 300)}」）`
    : '';
  const fileNote = Array.isArray(item.files) && item.files.length
    ? `\n（带了 ${item.files.length} 个文件：${item.files.map(f => f.name || '未命名').join('、')}）`
    : '';
  return `【来自 ${who}，${new Date(item.time).toLocaleString('zh-CN')}】${quoteLine}${fileNote}\n${item.text || '（只有图片，没有文字）'}`;
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
