/* DeepSeek API 客户端 —— 前端（对齐官方 App） */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const S = {
  conversations: [],
  settings: {},
  stats: {},
  models: [],
  languages: [],
  conv: null,
  streaming: false,
  abort: null,
  searchHits: null,
  renderCount: 80,
  convTotal: 0,     // 这个会话一共有多少条（本地可能只拉了尾巴）
  convFrom: 0,      // 本地数组第一条在全会话里的下标
  theme: 'auto',
  modalOpen: false,
  attachments: [],     // 待发送的附件
  recorder: null,      // 录音中
  audio: null,         // 正在朗读的音频
  audioMsgId: null,
};

const ICON = {
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h8"/></svg>',
  regen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 11-3-6.7"/><path d="M21 4v5h-5"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
  fork: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M6 7v4a2 2 0 002 2h8a2 2 0 002-2V7"/><path d="M12 13v4"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1 6 3 3H7l3-3z"/><path d="M12 13v7"/></svg>',
  dot: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  logo: '<svg viewBox="0 0 32 32" width="18" height="18"><rect width="32" height="32" rx="9" fill="#4d6bfe"/><path d="M10 21V11h3.2c3.2 0 5.3 1.9 5.3 5s-2.1 5-5.3 5H10zm2.6-2.2h.7c1.7 0 2.7-1 2.7-2.8s-1-2.8-2.7-2.8h-.7v5.6z" fill="#fff"/></svg>',
  speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M16 8.5a4.5 4.5 0 010 7"/><path d="M19 6a8 8 0 010 12"/></svg>',
  stopAudio: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  forward: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13"/><path d="M13 6l6 6-6 6"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/></svg>',
};

/* ------------------------------------------------------------------ 基础工具 */

async function api(pathname, opts = {}) {
  const res = await fetch(pathname, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

let toastTimer = 0;
function toast(msg, ms = 2400) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

function debounce(fn, ms) {
  let t = 0;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ---------- 保存键：未保存提醒 / 离开拦截 ---------- */
let saveGuard = null;      // 由设置页注册：{ dirty(): boolean, hint(): string }
let saveGuardArmedAt = 0;  // 上一次拦下的时间；4 秒内再点一次就放行

function registerSaveGuard(g) { saveGuard = g; }
function dropSaveGuard(g) { if (!g || saveGuard === g) saveGuard = null; }
function saveGuardDirty() { return !!(saveGuard && saveGuard.dirty()); }

// 返回 true = 可以离开；第一次带未保存改动离开时拦下来并提示，再点一次才放行。
function leaveSavePage() {
  if (!saveGuardDirty()) return true;
  const now = Date.now();
  if (now - saveGuardArmedAt > 4000) {
    saveGuardArmedAt = now;
    toast(saveGuard.hint ? saveGuard.hint() : '有改动还没保存：再点一次这个入口就放弃改动', 3400);
    return false;
  }
  saveGuardArmedAt = 0;
  saveGuard = null;
  return true;
}

window.addEventListener('beforeunload', e => {
  if (!saveGuardDirty()) return;
  e.preventDefault();
  e.returnValue = '';
});

const fmtNum = n => {
  n = Number(n) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(1) + ' 亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
  return n.toLocaleString('zh-CN');
};

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function shortAgo(ts) {
  if (!ts) return '';
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!t) return '';
  const diff = Date.now() - t;
  const day = 86400000;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.max(1, Math.round(diff / 60000)) + ' 分钟前';
  if (diff < day) return fmtTime(ts);
  if (diff < 2 * day) return '昨天';
  if (diff < 7 * day) return Math.floor(diff / day) + ' 天前';
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtSize(n) {
  n = Number(n) || 0;
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

function groupLabel(ts) {
  if (!ts) return '更早';
  const now = new Date();
  const d = new Date(ts);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= startOfToday) return '今天';
  if (t >= startOfToday - 864e5) return '昨天';
  if (t >= startOfToday - 7 * 864e5) return '最近 7 天';
  if (t >= startOfToday - 30 * 864e5) return '最近 30 天';
  return '更早';
}

const esc = MD.escapeHtml;

function hostOf(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return String(url || ''); }
}

/* ------------------------------------------------------------------ 主题 */

function applyTheme(theme) {
  S.theme = theme || 'auto';
  const dark = S.theme === 'dark' || (S.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#hljsDark').disabled = !dark;
  $('#hljsLight').disabled = dark;
  localStorage.setItem('dsapp-theme', S.theme);
  document.querySelector('meta[name=color-scheme]')?.setAttribute('content', dark ? 'dark' : 'light');
}

/* ------------------------------------------------------------------ 侧栏 */

function renderSidebar() {
  const list = $('#convList');
  if (S.searchHits) return renderHits();
  if (!S.conversations.length) {
    list.innerHTML = '<div class="side-empty">还没有对话<br>点上面「新建对话」，或把导出的压缩包直接拖进窗口</div>';
    return;
  }
  const groups = new Map();
  for (const c of S.conversations) {
    const label = groupLabel(c.updatedAt);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(c);
  }
  const order = ['今天', '昨天', '最近 7 天', '最近 30 天', '更早'];
  let html = '';
  for (const label of order) {
    const items = groups.get(label);
    if (!items || !items.length) continue;
    html += `<div class="side-label">${label}</div>`;
    for (const c of items) html += convItemHTML(c);
  }
  list.innerHTML = html;
}

function convItemHTML(c) {
  const active = S.conv && S.conv.id === c.id;
  return `<div class="conv-item${active ? ' active' : ''}" data-id="${c.id}" title="${esc(c.title)}">
    <div class="t">${c.pinned ? `<span class="pin">${ICON.pin}</span>` : ''}<span class="t-title">${esc(c.title || '新对话')}</span><span class="t-time">${shortAgo(c.updatedAt)}</span></div>
    <div class="p">${esc(c.preview || '')}</div>
    <div class="item-actions">
      <button class="mini" data-tune="${c.id}" title="调这个会话（模型 / 上下文 / 标题）">调</button>
      <button class="mini" data-menu="${c.id}" title="更多">${ICON.dot}</button>
    </div>
  </div>`;
}

function renderHits() {
  const list = $('#convList');
  const hits = S.searchHits || [];
  if (!hits.length) {
    list.innerHTML = '<div class="side-empty">没找到匹配的内容</div>';
    return;
  }
  const q = esc($('#searchInput').value.trim());
  const items = hits.map(h => {
    let snippet = esc(h.snippet);
    if (q) snippet = snippet.replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<mark>${m}</mark>`);
    return `<div class="hit" data-conv="${h.conversationId}" data-msg="${h.messageId}">
      <div class="ht">${esc(h.title)}</div>
      <div class="hs">${h.role === 'user' ? '你：' : 'DeepSeek：'}${snippet}</div>
    </div>`;
  }).join('');
  list.innerHTML = `<div class="side-label">搜索到 ${hits.length} 条</div><div class="hit-list">${items}</div>`;
}

function setActiveSidebar() {
  $$('.conv-item').forEach(el => el.classList.toggle('active', !!S.conv && el.dataset.id === S.conv.id));
}

/* ------------------------------------------------------------------ 会话 */

async function refreshState() {
  const state = await api('/api/state');
  S.conversations = state.conversations;
  S.settings = state.settings;
  S.stats = state.stats;
  S.models = state.models || S.models;
  S.languages = state.languages || S.languages;
  if (!S.models.length) S.models = [{ id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash' }];
  updateKeyState();
}

async function openConversation(id, opts = {}) {
  if (!id) return;
  if (S.streaming) stopGeneration(true);
  try {
    // 大会话只拉尾巴：整包 9MB 的 JSON 光是 parse 就会把界面冻住
    const data = await api('/api/conversations/' + id + (opts.full ? '' : '?tail=80'));
    S.conv = data.conversation;
    S.convTotal = typeof data.totalMessages === 'number' ? data.totalMessages : S.conv.messages.length;
    S.convFrom = typeof data.from === 'number' ? data.from : 0;
    S.renderCount = opts.full ? Math.max(80, S.conv.messages.length) : 80;
    if (!location.hash.endsWith('/' + id)) history.replaceState(null, '', '#c/' + id);
    renderMessages();
    setActiveSidebar();
    updateTopbar();
    syncComposerMode();
    closeSidebar();
    if (opts.scrollTo) {
      requestAnimationFrame(() => scrollToMessage(opts.scrollTo));
    } else if (!opts.keepScroll) {
      scrollToBottom(true);
    }
    refreshCtxBadge();
  } catch (e) {
    toast('打开会话失败：' + e.message);
  }
}

async function newConversation() {
  if (S.streaming) stopGeneration(true);
  const data = await api('/api/conversations', { method: 'POST', body: { title: '新对话', model: S.settings.model } });
  S.conversations = data.conversations;
  renderSidebar();
  S.conv = data.conversation;
  S.convTotal = S.conv.messages.length;
  S.convFrom = 0;
  S.renderCount = 80;
  history.replaceState(null, '', '#c/' + S.conv.id);
  renderMessages();
  updateTopbar();
  syncComposerMode();
  closeSidebar();
  refreshCtxBadge();
  $('#input').focus();
}

function showWelcome() {
  S.conv = null;
  history.replaceState(null, '', location.pathname);
  $('#messages').innerHTML = '';
  const w = $('#welcome');
  w.classList.remove('hidden');
  $('#convTitle').textContent = '新对话';
  $('#convMeta').textContent = '';
  updateTopbar();
  syncComposerMode();
  updateKeyState();
  setActiveSidebar();
  $('#ctxBadge')?.classList.add('hidden');
}

/* ------------------------------------------------------------------ 引用角标 */

const CITE_MARK = /\u0006(\d+)\u0007/g;

/** 把 annotations 按 Unicode 码点插成标记，返回 {text, cites} */
function withCitations(m) {
  const text = String(m.content || '');
  const anns = Array.isArray(m.annotations) ? m.annotations : [];
  const cites = [];
  if (!anns.length) return { text, cites };
  const cps = Array.from(text);
  const inserts = [];
  anns.forEach((a, i) => {
    const c = a && a.url_citation;
    cites[i + 1] = c || null;
    const at = c && Number(c.end_index);
    if (Number.isFinite(at) && at >= 0 && at <= cps.length) inserts.push({ n: i + 1, at });
  });
  inserts.sort((a, b) => b.at - a.at);
  for (const ins of inserts) cps.splice(ins.at, 0, `\u0006${ins.n}\u0007`);
  return { text: cps.join(''), cites };
}

function renderMarkdown(m) {
  const { text, cites } = withCitations(m);
  let html = MD.render(text);
  if (cites.length) {
    html = html.replace(CITE_MARK, (_, n) => {
      const c = cites[Number(n)];
      if (!c || !c.url) return '';
      return `<sup class="cite"><a href="${esc(c.url)}" target="_blank" rel="noopener" title="${esc(c.title || c.url)}">${n}</a></sup>`;
    });
  } else {
    html = html.replace(CITE_MARK, '');
  }
  return html;
}

/* ------------------------------------------------------------------ 联网工具过程 */

function toolCallsOf(m) {
  const out = [];
  for (const step of m.serverToolCalls || []) {
    for (const call of step.calls || []) out.push(call);
  }
  return out;
}

function kindLabel(call) {
  const kind = String(call.kind || '');
  if (kind === 'deep_search') return '深度搜索';
  if (kind === 'read_link') return '阅读链接';
  if (kind === 'image_search' || kind === 'deep_image_search') return '搜图';
  if (kind === 'search') return '搜索';
  if (call.type === 'deepseek_read_url') return '阅读链接';
  if (call.type === 'deepseek_web_search') return '搜索';
  return '联网';
}

function actionText(call) {
  const a = call.action || {};
  if (a.queries && a.queries.length) return a.queries.join(' · ');
  if (a.pattern) return `${a.pattern}（在 ${hostOf(a.url)} 里找）`;
  if (a.url) return a.url;
  return '';
}

function toolRowsHTML(calls) {
  return calls.map(call => {
    const a = call.action || {};
    const queries = Array.isArray(a.queries) ? a.queries : [];
    const srcs = (call.sources || []).slice(0, 8);
    const failed = call.status === 'failed';
    let inner = '';
    if (queries.length) inner += `<div class="tc-q">${queries.map(q => `<span>${esc(q)}</span>`).join('')}</div>`;
    if (a.url) inner += `<div class="tc-url">${esc(a.url)}</div>`;
    if (srcs.length) {
      inner += '<div class="tc-src">' + srcs.map(s => `
        <a href="${esc(s.url || '#')}" target="_blank" rel="noopener">
          <span class="tc-site">${esc(s.site_name || hostOf(s.url))}</span>
          <span class="tc-title">${esc(s.title || s.url || '')}</span>
        </a>`).join('') + '</div>';
    }
    return `<div class="tc-row${failed ? ' tc-fail' : ''}">
      <span class="tc-kind">${failed ? '失败' : kindLabel(call)}</span>
      <div class="tc-body">${inner || esc(actionText(call))}</div>
    </div>`;
  }).join('');
}

function toolCardHTML(m) {
  const calls = toolCallsOf(m);
  if (!calls.length) return '';
  const pages = calls.filter(c => c.action && c.action.url).length;
  const searches = calls.filter(c => c.action && c.action.queries).length;
  const summary = [searches ? `搜索 ${searches} 次` : '', pages ? `打开 ${pages} 个页面` : ''].filter(Boolean).join(' · ') || `${calls.length} 个联网步骤`;
  const srcs = collectSources(m);
  return `<details class="tool-card">
    <summary>${ICON.lantern || '🌐'} ${esc(summary)}</summary>
    <div class="tc-list">${toolRowsHTML(calls)}</div>
    ${srcs.length ? `<div class="tc-foot">参考来源：${srcs.slice(0, 10).map((s, i) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">[${i + 1}] ${esc(s.title || hostOf(s.url))}</a>`).join('')}</div>` : ''}
  </details>`;
}

function collectSources(m) {
  const out = [];
  const seen = new Set();
  for (const c of toolCallsOf(m)) {
    for (const s of c.sources || []) {
      if (!s || !s.url || seen.has(s.url)) continue;
      seen.add(s.url);
      out.push(s);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ 附件 */

/* 视频 / 音频：按扩展名认类别 */
const MEDIA_VIDEO_EXT = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'];
const MEDIA_AUDIO_EXT = ['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac', 'opus'];

function fileExt(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

function isMediaFile(name) {
  const ext = fileExt(name);
  if (MEDIA_VIDEO_EXT.includes(ext)) return 'video';
  if (MEDIA_AUDIO_EXT.includes(ext)) return 'audio';
  return '';
}

/* file.type 为空时按扩展名给一个兜底 MIME */
function mediaMimeOf(name, kind) {
  const map = {
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
    mkv: 'video/x-matroska', avi: 'video/x-msvideo',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
    flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/opus',
  };
  return map[fileExt(name)] || (kind === 'audio' ? 'audio/mpeg' : 'video/mp4');
}

/* 秒 → 2:13（超过 1 小时用 1:02:13） */
function fmtDuration(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(s).padStart(2, '0');
}

/* 秒 → 00:12（转写时间戳用，补零） */
function fmtClock(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return (h ? `${h}:` : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function mediaTranscriptChars(a) {
  const text = String(a.text || '').trim();
  if (text) return text.length;
  const segs = Array.isArray(a.transcript) ? a.transcript : [];
  return segs.map(s => String((s && s.text) || '').trim()).join('').length;
}

/* 附件条里的媒体元信息：· 2:13 · 转写 480 字 · 6 帧 */
function mediaChipMeta(a) {
  const bits = [];
  if (Number(a.duration) > 0) bits.push(fmtDuration(a.duration));
  const chars = mediaTranscriptChars(a);
  if (chars) bits.push(`转写 ${chars} 字`);
  const frames = a.kind !== 'audio' && Array.isArray(a.frames) ? a.frames.length : 0;
  if (frames) bits.push(`${frames} 帧`);
  return bits.length ? '· ' + bits.join(' · ') : '';
}

/* 发送后消息里的媒体块：缩略帧 + 可折叠转写 */
function mediaBlockHTML(a) {
  const kind = a.kind === 'audio' ? 'audio' : 'video';
  const emoji = kind === 'video' ? '🎬' : '🎵';
  const segs = (Array.isArray(a.transcript) ? a.transcript : []).filter(s => s && String(s.text || '').trim());
  const chars = mediaTranscriptChars(a);
  const frames = kind === 'video' && Array.isArray(a.frames) ? a.frames.filter(f => f && f.url) : [];
  const dur = Number(a.duration) > 0 ? fmtDuration(a.duration) : '';
  const title = `<div class="media-title"><span class="media-emoji">${emoji}</span><span class="att-name">${esc(a.name || (kind === 'video' ? '视频' : '音频'))}</span>${dur ? `<span class="att-tag">${esc(dur)}</span>` : ''}</div>`;
  const framesHTML = frames.length
    ? `<div class="media-frames">${frames.map(f => {
        const t = f.time != null && isFinite(Number(f.time)) ? fmtClock(f.time) : '';
        return `<a class="media-frame" href="${esc(f.url)}" target="_blank" rel="noopener"${t ? ` title="${esc(t)}"` : ''}><img src="${esc(f.url)}" alt="${esc(t)}" loading="lazy"></a>`;
      }).join('')}</div>`
    : '';
  let transcriptHTML = '';
  if (chars) {
    const body = segs.length
      ? segs.map(s => `<div class="media-seg"><span class="media-t">[${esc(fmtClock(s.start))}]</span><span class="media-seg-text">${esc(String(s.text || '').trim())}</span></div>`).join('')
      : `<div class="media-seg"><span class="media-seg-text">${esc(String(a.text || '').trim())}</span></div>`;
    transcriptHTML = `<details class="media-transcript"><summary>转写文字 · ${chars} 字</summary><div class="media-segs">${body}</div></details>`;
  }
  return `<div class="media-block">${title}${framesHTML}${transcriptHTML}</div>`;
}

/* 媒体上传：字节直传 /api/media，解析中可被 × 取消 */
async function uploadMedia(file, entry) {
  const kind = entry.kind;
  const ctl = new AbortController();
  entry.abort = ctl;
  try {
    const res = await fetch('/api/media', {
      method: 'POST',
      headers: {
        'Content-Type': file.type || mediaMimeOf(file.name, kind),
        'x-filename': encodeURIComponent(file.name),
      },
      body: file,
      signal: ctl.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.code = data && data.code;
      throw err;
    }
    Object.assign(entry, data, { uploading: false, abort: null, kind: data.kind || kind, name: data.name || file.name });
    if (Array.isArray(data.warnings) && data.warnings.length) toast(data.warnings.join('；'), 6000);
    else toast(`已解析 ${file.name}`, 1500);
  } catch (e) {
    entry.abort = null;
    S.attachments = S.attachments.filter(a => a !== entry);
    if (e.name !== 'AbortError') toast('媒体处理失败：' + e.message, 6000);
  }
  renderAttachBar();
  applySendState();
}

function attachmentsHTML(m) {
  const list = m.attachments || [];
  if (!list.length) return '';
  // 视频 / 音频：整块（缩略帧 + 转写）单独成段，不跟图片/文档挤在 .att-list 的横向行里
  const media = list.filter(a => a.kind === 'video' || a.kind === 'audio');
  const rest = list.filter(a => a.kind !== 'video' && a.kind !== 'audio');
  const mediaHTML = media.map(a => mediaBlockHTML(a)).join('');
  const items = rest.map(a => {
    // 老消息里可能只有 uploadId 没有 url（以前没存），一样要能显示出来
    const src = a.url || (a.uploadId ? `/api/uploads/${a.uploadId}` : '');
    if (a.kind === 'image' && src) {
      return `<a class="att-img" href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt="${esc(a.name || '')}" loading="lazy"></a>`;
    }
    return `<span class="att-file">${ICON.file}<span class="att-name">${esc(a.name || a.uploadId || '文件')}</span>${a.fileId ? '<span class="att-tag">已解析</span>' : ''}</span>`;
  }).join('');
  return mediaHTML + (items ? `<div class="att-list">${items}</div>` : '');
}

function renderAttachBar() {
  const bar = $('#attachBar');
  if (!S.attachments.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  bar.classList.remove('hidden');
  bar.innerHTML = S.attachments.map((a, i) => {
    const media = a.kind === 'video' || a.kind === 'audio';
    const icon = media
      ? `<span class="att-chip-emoji">${a.kind === 'video' ? '🎬' : '🎵'}</span>`
      : (a.kind === 'image' && a.url ? `<img src="${esc(a.url)}" alt="">` : ICON.file);
    const meta = media && !a.uploading ? mediaChipMeta(a) : '';
    const tail = a.uploading
      ? `<span class="att-chip-size">${media ? '转写中…' : '上传中…'}</span>`
      : (meta ? `<span class="att-chip-meta">${esc(meta)}</span>` : `<span class="att-chip-size">${fmtSize(a.size)}</span>`);
    return `
    <span class="att-chip${a.uploading ? ' uploading' : ''}${media ? ' att-chip-media' : ''}">
      ${icon}
      <span class="att-chip-name">${esc(a.name || '')}</span>
      ${tail}
      <button class="att-del" data-att="${i}" title="移除">×</button>
    </span>`;
  }).join('');
}

async function addAttachment(file) {
  const isImage = /^image\//.test(file.type || '') || /\.(jpe?g|png|gif|webp)$/i.test(file.name);
  const mediaKind = isMediaFile(file.name);
  const entry = { name: file.name, mime: file.type || '', size: file.size, kind: mediaKind || (isImage ? 'image' : 'file'), uploading: true };
  S.attachments.push(entry);
  renderAttachBar();
  if (mediaKind) { applySendState(); return uploadMedia(file, entry); }
  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) },
      body: file,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    Object.assign(entry, data, { uploading: false });
    toast(`已添加 ${file.name}`, 1400);
  } catch (e) {
    S.attachments = S.attachments.filter(a => a !== entry);
    toast('附件处理失败：' + e.message, 6000);
  }
  renderAttachBar();
  applySendState();
}

/* ------------------------------------------------------------------ 消息渲染 */

function assistantActionsHTML(isLast) {
  return [
    `<button class="act" data-act="copy" title="复制">${ICON.copy}<span>复制</span></button>`,
    `<button class="act act-speak" data-act="speak" title="朗读这条回答">${ICON.speaker}<span>朗读</span></button>`,
    `<button class="act act-regen" data-act="regenerate" title="重新生成"${isLast ? '' : ' hidden'}>${ICON.regen}<span>重新生成</span></button>`,
    `<button class="act act-continue" data-act="continue" title="接着往下写"${isLast ? '' : ' hidden'}>${ICON.forward}<span>继续</span></button>`,
    `<button class="act" data-act="fork" title="从这个位置开一个分支">${ICON.fork}<span>分支</span></button>`,
    `<button class="act" data-act="delete" title="删除这条回复">${ICON.trash}<span>删除</span></button>`,
  ].join('');
}

function userActionsHTML() {
  return [
    `<button class="act" data-act="copy" title="复制">${ICON.copy}</button>`,
    `<button class="act" data-act="edit" title="编辑并重新发送">${ICON.edit}</button>`,
    `<button class="act" data-act="delete" title="删除">${ICON.trash}</button>`,
  ].join('');
}

function usageHTML(m) {
  const u = m.usage;
  const parts = [];
  if (u) {
    if (u.prompt_tokens) parts.push(`↑${fmtNum(u.prompt_tokens)}`);
    if (u.completion_tokens) parts.push(`↓${fmtNum(u.completion_tokens)}`);
  }
  if (m.durationMs) parts.push(`${(m.durationMs / 1000).toFixed(1)}s`);
  const t = toolCallsOf(m).length;
  if (t) parts.push(`联网 ${t} 步`);
  if (m.model) parts.push(modelLabel(m.model));
  return parts.length ? `<span class="msg-time">${parts.join(' · ')}</span>` : '';
}

/**
 * QQ 会话里的用户消息被服务端包了两层：抬头「【来自 QQ 上的对方（uid），时间】」和
 * 尾巴上的手机打字口径。存着是对的（模型要读），但气泡里没必要显示 →
 * 抬头折成一行小字，口径直接不显示。
 */
function splitQqWrap(text) {
  const raw = String(text || '');
  const body = raw.replace(/\n*【这条回在手机上】[^\n]*/g, '').replace(/\s+$/, '');
  const hit = body.match(/^【来自 QQ 上的对方（([^）]*)），([^】]*)】\n*/);
  if (!hit) return { meta: '', body };
  return { meta: `${hit[1].trim()} · ${hit[2].trim()}`, body: body.slice(hit[0].length) };
}

function messageEl(m) {
  const el = document.createElement('div');
  el.className = 'msg ' + m.role;
  el.dataset.id = m.id;

  if (m.role === 'user') {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.insertAdjacentHTML('beforeend', attachmentsHTML(m));
    const { meta: qqMeta, body: shown } = splitQqWrap(m.content);
    if (qqMeta) {
      const from = document.createElement('div');
      from.className = 'qq-from';
      from.textContent = 'QQ · ' + qqMeta;
      bubble.appendChild(from);
    }
    const md = document.createElement('div');
    md.className = 'md';
    md.innerHTML = MD.render(shown);
    bubble.appendChild(md);
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.innerHTML = userActionsHTML() + `<span class="msg-time">${fmtTime(m.createdAt)}</span>`;
    bubble.appendChild(actions);
    el.appendChild(bubble);
    return el;
  }

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.innerHTML = ICON.logo;
  el.appendChild(avatar);

  const body = document.createElement('div');
  body.className = 'body';

  if (m.route) {
    const tag = document.createElement('div');
    tag.className = 'route-tag';
    const draftWord = m.route.kind === 'media' ? 'Flash 要点' : 'Flash 大纲';
    const d = m.route.draft ? ` · ${draftWord} ${m.route.draft.chars} 字` : '';
    tag.textContent = `自动路由 · ${routeKindLabel(m.route.kind)} · ${modelLabel(m.model || m.route.model)}${d}`;
    body.appendChild(tag);
  }
  if (m.tune && m.tune.temperature !== undefined) {
    const tune = document.createElement('div');
    tune.className = 'tune-tag';
    tune.textContent = `自适应 · 温度 ${fmtTemp(m.tune.temperature)}${m.tune.label ? ' · ' + m.tune.label : ''}`;
    tune.title = `这一轮按对话状态临时调了温度（原 ${fmtTemp(m.tune.base)} → ${fmtTemp(m.tune.temperature)}）`;
    body.appendChild(tune);
  }

  if (m.reasoning) {
    const det = document.createElement('details');
    det.className = 'reason';
    const secs = m.durationMs ? Math.max(1, Math.round(m.durationMs / 1000)) : 0;
    const effort = m.thinking && m.thinking.effort ? ` · ${effortLabel(m.thinking.effort)}` : '';
    det.innerHTML = `<summary>已深度思考${secs ? `（用时 ${secs} 秒${effort}）` : effort}</summary>
      <div class="reason-body"><div class="md">${MD.render(m.reasoning)}</div></div>`;
    body.appendChild(det);
  }

  const callsHTML = toolCardHTML(m);
  if (callsHTML) body.insertAdjacentHTML('beforeend', callsHTML);

  const md = document.createElement('div');
  md.className = 'md';
  md.innerHTML = renderMarkdown(m);
  body.appendChild(md);

  if (m.finishReason === 'content_filter') {
    body.insertAdjacentHTML('beforeend', '<div class="notice warn">这条回答被内容安全审核拦下了。</div>');
  }

  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  actions.innerHTML = assistantActionsHTML(true) + usageHTML(m);
  body.appendChild(actions);
  el.appendChild(body);
  return el;
}

function renderMessages() {
  if (!S.conv) return;
  const total = S.conv.messages.length;
  const from = Math.max(0, total - S.renderCount);
  const moreBefore = (S.convFrom || 0) > 0;
  const wrap = $('#messages');
  const scroller = $('#scroller');
  const prevHeight = scroller.scrollHeight;
  const prevTop = scroller.scrollTop;

  const w = $('#welcome');
  if (total === 0) w.classList.remove('hidden');
  else w.classList.add('hidden');
  const frag = document.createDocumentFragment();
  if (from > 0 || moreBefore) {
    const btn = document.createElement('button');
    btn.className = 'load-more';
    const meTotal = S.convTotal || total + (S.convFrom || 0);
    btn.textContent = `载入更早的 ${Math.min(moreBefore ? (S.convFrom || 0) : from, 60)} 条（共 ${meTotal} 条）`;
    btn.addEventListener('click', () => {
      const anchor = { h: scroller.scrollHeight, t: scroller.scrollTop };
      const done = () => { renderMessages(); scroller.scrollTop = anchor.t + (scroller.scrollHeight - anchor.h); };
      if (moreBefore) loadEarlier().then(done);
      else { S.renderCount += 60; done(); }
    });
    frag.appendChild(btn);
  }
  for (let i = from; i < total; i++) frag.appendChild(messageEl(S.conv.messages[i]));
  wrap.innerHTML = '';
  wrap.appendChild(frag);
  markLastActions();

  if (from === 0 && S.renderCount <= 80 && prevTop === 0) scrollToBottom(true);
  else scroller.scrollTop = prevTop;
  updateTopbar();
}

/** 往前翻一页：找服务端把 [convFrom-60, convFrom) 拿下来，接在本地数组前面 */
async function loadEarlier() {
  if (!S.conv || !(S.convFrom > 0)) return;
  const count = Math.min(60, S.convFrom);
  try {
    const data = await api(`/api/conversations/${S.conv.id}/messages?before=${S.convFrom}&count=${count}`);
    const got = data.messages || [];
    if (!got.length) { S.convFrom = 0; return; }
    S.conv.messages = got.concat(S.conv.messages);
    S.convFrom = typeof data.from === 'number' ? data.from : Math.max(0, S.convFrom - got.length);
    S.renderCount += got.length;
  } catch (e) {
    toast('载入更早的消息失败：' + e.message);
    S.convFrom = 0;
  }
}

function markLastActions() {
  const msgs = $$('.msg.assistant', $('#messages'));
  msgs.forEach((el, i) => {
    const last = i === msgs.length - 1;
    const regen = el.querySelector('.act-regen');
    const cont = el.querySelector('.act-continue');
    if (regen) regen.hidden = !last;
    if (cont) cont.hidden = !last;
  });
}

function scrollToBottom(force) {
  const scroller = $('#scroller');
  if (!force && !nearBottom()) return;
  scroller.scrollTop = scroller.scrollHeight;
}

function nearBottom() {
  const scroller = $('#scroller');
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
}

function scrollToMessage(id) {
  const el = $(`.msg[data-id="${id}"]`);
  if (!el) { toast('这条消息在更早的位置，先点「载入更早的」'); return; }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1800);
}

/* ------------------------------------------------------------------ 顶栏 / 输入区状态 */

function updateTopbar() {
  const title = $('#convTitle');
  const meta = $('#convMeta');
  if (!S.conv) {
    title.textContent = '新对话';
    meta.textContent = '';
    return;
  }
  title.textContent = S.conv.title || '新对话';
  const n = S.convTotal || S.conv.messages.length;
  meta.textContent = n ? `${n} 条消息` : '';
}

function currentModel() {
  return (S.conv && S.conv.model) || S.settings.model || 'deepseek-flash';
}

function voiceLabel(v) {
  return ({ native: '原生', human: '活人感', qq: 'QQ 熟人', custom: '只用自定义提示' })[v] || '活人感';
}

function modelLabel(id) {
  if (id === 'auto') return '自动';
  const m = S.models.find(x => x.id === id);
  return m ? m.label.replace(/^DeepSeek\s*/, '') : String(id || '');
}

function effortLabel(e) {
  return e === 'low' ? '低强度' : e === 'max' ? '最高强度' : '高强度';
}

function fmtTemp(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return String(Math.round(v * 100) / 100);
}

function routeKindLabel(kind) {
  return ({ chat: '对话', think: '逻辑思考', hybrid: '混合', media: '音视频', vision: '看附件' })[kind] || kind || '';
}

function routeOpts(cur) {
  const list = S.models && S.models.length ? S.models : [
    { id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash' },
    { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  ];
  return list.map(m => `<option value="${esc(m.id)}"${m.id === cur ? ' selected' : ''}>${esc(String(m.label || m.id).replace(/^DeepSeek\s*/, ''))}</option>`).join('');
}

function renderRouteTag(st, ev) {
  if (!st || !st.el) return;
  const body = st.el.querySelector('.body');
  if (!body) return;
  let tag = body.querySelector('.route-tag');
  if (!tag) {
    tag = document.createElement('div');
    tag.className = 'route-tag';
    body.insertBefore(tag, body.firstChild);
  }
  const draftWord = ev.kind === 'media' ? 'Flash 要点' : 'Flash 大纲';
  const d = ev.draft ? ` · ${draftWord} ${ev.draft.chars} 字` : '';
  const head = ev.forced ? '混合模式' : '自动路由';
  tag.textContent = `${head} · ${routeKindLabel(ev.kind)} · ${modelLabel(ev.model)}${d}`;
}

function renderTuneTag(st, ev) {
  if (!st || !st.el || !ev || ev.on === false) return;
  const body = st.el.querySelector('.body');
  if (!body) return;
  let tag = body.querySelector('.tune-tag');
  if (!tag) {
    tag = document.createElement('div');
    tag.className = 'tune-tag';
    const anchor = body.querySelector('.route-tag');
    if (anchor && anchor.nextSibling) body.insertBefore(tag, anchor.nextSibling);
    else body.appendChild(tag);
  }
  const label = ev.label ? ` · ${ev.label}` : '';
  tag.textContent = `自适应 · 温度 ${fmtTemp(ev.temperature)}${label}`;
  tag.title = `这一轮按对话状态临时调了温度（原 ${fmtTemp(ev.base)} → ${fmtTemp(ev.temperature)}）${Array.isArray(ev.tags) && ev.tags.length ? `\n判断依据：${ev.tags.join('、')}` : ''}`;
}

function syncComposerMode() {
  const thinking = S.settings.thinking !== false;
  const web = !!S.settings.webSearch;
  const hybrid = S.settings.hybridMode === true;
  $('#hybridChip').classList.toggle('on', hybrid);
  $('#thinkChip').classList.toggle('on', thinking && !hybrid);
  $('#thinkChip').classList.toggle('muted', hybrid);
  $('#thinkChip').title = hybrid ? '混合模式下第一遍不带思考（关掉混合就恢复）' : '深度思考';
  $('#webChip').classList.toggle('on', web);
  $('#effortSel').value = S.settings.reasoningEffort || 'high';
  $('#effortSel').style.display = thinking ? '' : 'none';
  $('#modelLabel').textContent = modelLabel(currentModel());
  $('#modelBtn').title = `当前模型：${currentModel()}（点这里换）`;
  const voice = $('#voiceSel');
  if (voice) {
    const isQQ = S.conv && (S.conv.source === 'qq' || (S.settings.qqConvId && S.conv.id === S.settings.qqConvId));
    const own = (S.conv && S.conv.replyStyle) || '';
    voice.classList.toggle('hidden', !S.conv);
    voice.value = own;
    const eff = own || (isQQ ? 'qq' : (S.settings.replyStyle || 'human'));
    voice.title = S.conv
      ? `这个会话的说话口径：${own ? '' : '跟随设置（'}${voiceLabel(eff)}${own ? '' : '）'}（改了立刻生效）`
      : '';
    voice.classList.toggle('on', !!own && own !== (isQQ ? 'qq' : (S.settings.replyStyle || 'human')));
  }
  $('#composerHint').textContent = S.streaming ? '正在生成…' : '';
  applySendState();
}

function applySendState() {
  const btn = $('#sendBtn');
  const ta = $('#input');
  const hasText = ta.value.trim().length > 0 || S.attachments.some(a => !a.uploading);
  const busy = S.attachments.some(a => a.uploading);
  if (S.streaming) {
    btn.disabled = false;
    btn.classList.add('stop');
    btn.title = '停止生成';
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
  } else {
    btn.classList.remove('stop');
    btn.title = busy ? '附件还在处理…' : '发送';
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
    btn.disabled = !hasText || busy;
  }
}

function updateKeyState() {
  const warn = $('#welcomeWarn');
  if (!warn) return;
  if (S.settings.hasKey) {
    warn.classList.add('hidden');
  } else {
    warn.classList.remove('hidden');
    warn.innerHTML = `还没填 <b>API Key</b> —— 现在只能翻历史记录，发消息会返回错误。<button class="link-btn" id="warnSettings">去填写</button>`;
    const b = $('#warnSettings');
    if (b) b.addEventListener('click', openSettings);
  }
  $('#tokenHint').textContent = S.settings.hasKey ? '' : '未配置 Key';
}

/* ------------------------------------------------------------------ 流式发送 */

async function ensureConversation() {
  if (S.conv) return S.conv;
  const data = await api('/api/conversations', { method: 'POST', body: { title: '新对话', model: S.settings.model } });
  S.conv = data.conversation;
  S.conversations = data.conversations;
  renderSidebar();
  history.replaceState(null, '', '#c/' + S.conv.id);
  $('#welcome').classList.add('hidden');
  $('#messages').innerHTML = '';
  updateTopbar();
  return S.conv;
}

function setStreamingUI(on) {
  S.streaming = on;
  syncComposerMode();
}

async function sendMessage({ mode = 'send', content = '', messageId = null } = {}) {
  if (S.streaming) return;
  const conv = await ensureConversation();
  // 已经是「新建对话」直接建出来的会话（S.conv 已存在）时，ensureConversation 不会走到隐藏欢迎页那一步
  { const w = $('#welcome'); if (w) w.classList.add('hidden'); }

  if (mode === 'send' && !content.trim() && !S.attachments.length) return;

  const wrap = $('#messages');
  const pending = S.attachments.slice();

  if (mode === 'send') {
    const optimistic = {
      id: 'tmp-' + Date.now(), role: 'user', content, createdAt: Date.now(),
      ...(pending.length ? { attachments: pending.map(a => ({ ...a, uploading: false })) } : {}),
    };
    S.conv.messages.push(optimistic);
    S.convTotal = (S.convTotal || S.conv.messages.length) + 2;
    wrap.appendChild(messageEl(optimistic));
    $('#input').value = '';
    S.attachments = [];
    renderAttachBar();
    autoGrow();
  } else if (mode === 'edit') {
    const idx = S.conv.messages.findIndex(m => m.id === messageId);
    if (idx >= 0) {
      S.conv.messages[idx].content = content;
      S.conv.messages = S.conv.messages.slice(0, idx + 1);
    }
    renderMessages();
    $('#input').value = '';
    autoGrow();
  } else if (mode === 'regenerate') {
    while (S.conv.messages.length && S.conv.messages[S.conv.messages.length - 1].role === 'assistant') S.conv.messages.pop();
    renderMessages();
  } else if (mode === 'continue') {
    while (S.conv.messages.length && S.conv.messages[S.conv.messages.length - 1].role === 'assistant') S.conv.messages.pop();
    renderMessages();
  }

  scrollToBottom(true);
  setStreamingUI(true);
  const ac = new AbortController();
  S.abort = ac;

  const st = {
    reasoning: '', content: '', el: null, mdEl: null, reasonDet: null, reasonBody: null,
    toolEl: null, toolCalls: [], reasonPhase: true, raf: 0, startedAt: performance.now(),
    userMessage: null, cites: [],
  };

  const paint = () => {
    st.raf = 0;
    if (!st.el) return;
    if (st.mdEl) {
      st.mdEl.innerHTML = renderMarkdown({ content: st.content, annotations: st.annotations || [] })
        + (S.streaming ? '<span class="typing-cursor"></span>' : '');
    }
    if (st.toolEl && st.toolCalls.length) {
      st.toolEl.querySelector('.tc-list').innerHTML = toolRowsHTML(st.toolCalls);
      st.toolEl.querySelector('summary').textContent = S.streaming ? '正在联网（' + st.toolCalls.length + ' 步）…' : '联网过程（' + st.toolCalls.length + ' 步）';
    }
    if (st.reasonBody) {
      st.reasonBody.innerHTML = MD.render(st.reasoning);
      if (st.reasonPhase) st.reasonDet.open = true;
    }
    if (st.reasonDet) {
      const sum = st.reasonDet.querySelector('summary');
      if (sum && st.reasonPhase) sum.innerHTML = '<span class="spin"></span> 深度思考中…';
      else if (sum && !st.reasonFinished) { sum.textContent = '已深度思考'; st.reasonFinished = true; }
    }
    scrollToBottom(false);
  };
  const schedulePaint = () => {
    if (!st.raf) st.raf = requestAnimationFrame(paint);
  };

  const ensureToolEl = () => {
    if (st.toolEl) return st.toolEl;
    const det = document.createElement('details');
    det.className = 'tool-card';
    det.open = true;
    det.innerHTML = '<summary>正在联网…</summary><div class="tc-list"></div>';
    st.el.querySelector('.body').insertBefore(det, st.mdEl);
    st.toolEl = det;
    return det;
  };

  const ensureStreamEl = () => {
    if (st.el) return;
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML = `<div class="avatar">${ICON.logo}</div><div class="body"></div>`;
    const body = el.querySelector('.body');

    const det = document.createElement('details');
    det.className = 'reason hidden';
    det.open = true;
    det.innerHTML = '<summary><span class="spin"></span> 深度思考中…</summary><div class="reason-body"></div>';
    body.appendChild(det);

    const md = document.createElement('div');
    md.className = 'md';
    md.innerHTML = '<span class="typing-cursor"></span>';
    body.appendChild(md);

    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    body.appendChild(actions);

    $('#messages').appendChild(el);
    st.el = el;
    st.mdEl = md;
    st.reasonDet = det;
    st.reasonBody = det.querySelector('.reason-body');
    scrollToBottom(true);
  };

  const onEvent = ev => {
    if (ev.type === 'start') {
      st.userMessage = ev.userMessage;
      ensureStreamEl();
      st.assistantId = ev.assistant && ev.assistant.id;
      if (ev.assistant) st.el.dataset.id = ev.assistant.id;
      if (mode === 'send' && ev.userMessage) {
        S.conv.messages[S.conv.messages.length - 1] = ev.userMessage;
        const last = $('#messages .msg.user:last-of-type');
        if (last) last.dataset.id = ev.userMessage.id;
      }
    } else if (ev.type === 'reasoning') {
      st.reasonDet.classList.remove('hidden');
      st.reasoning += ev.text;
      schedulePaint();
    } else if (ev.type === 'content') {
      if (st.reasonPhase) {
        st.reasonPhase = false;
        setTimeout(() => { if (st.reasonDet) st.reasonDet.open = false; }, 60);
      }
      st.content += ev.text;
      schedulePaint();
    } else if (ev.type === 'tool') {
      ensureToolEl();
      const call = ev.call || {};
      const key = String(call.id || `${ev.step}:${call.index}:${call.type}`);
      const at = st.toolCalls.findIndex(c => String(c.id || `${ev.step}:${c.index}:${c.type}`) === key);
      if (at >= 0) st.toolCalls[at] = { ...st.toolCalls[at], ...call };
      else st.toolCalls.push(call);
      schedulePaint();
    } else if (ev.type === 'usage') {
      st.usage = ev.usage;
    } else if (ev.type === 'route') {
      st.route = ev;
      const dl = ev.draft ? `（Flash 先出大纲 ${ev.draft.chars} 字 / ${Math.round(ev.draft.ms / 100) / 10}s）` : '';
      toast(`自动路由：${ev.label || ev.kind} → ${modelLabel(ev.model)}${dl}`, 4500);
      if (st.el) renderRouteTag(st, ev);
    } else if (ev.type === 'tune') {
      st.tune = ev;
      if (st.el) renderTuneTag(st, ev);
    } else if (ev.type === 'link') {
      st.links = ev.items || [];
      const ok = (ev.items || []).filter(x => x.ok);
      const bad = (ev.items || []).filter(x => !x.ok);
      if (ok.length) {
        const first = ok[0];
        const how = first.tier === 'browser' ? '内嵌内核' : 'HTTP';
        toast(`本机读了 ${ok.length} 个链接（${how} · ${first.chars} 字）${bad.length ? `，${bad.length} 个没读到` : ''}`, 4000);
      } else if (bad.length) {
        toast(`本机没读到链接，交给 API 的读链接工具：${bad[0].error || ''}`, 5000);
      }
    } else if (ev.type === 'context') {
      S.ctx = ev;
      updateCtxBadge(ev);
    } else if (ev.type === 'title') {
      if (ev.title) { S.conv.title = ev.title; updateTopbar(); }
    } else if (ev.type === 'error') {
      st.error = ev.message;
    } else if (ev.type === 'warning') {
      st.warning = ev.message;
    } else if (ev.type === 'done') {
      st.done = ev;
      if (ev.message) st.finalMessage = ev.message;
      if (ev.contentFiltered) toast('内容被安全审核拦下了', 5000);
      if (ev.conversation) {
        const i = S.conversations.findIndex(c => c.id === ev.conversation.id);
        if (i >= 0) S.conversations[i] = ev.conversation;
        else S.conversations.unshift(ev.conversation);
        S.conversations.sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.updatedAt - a.updatedAt));
        renderSidebar();
        if (S.conv.title !== ev.conversation.title) { S.conv.title = ev.conversation.title; updateTopbar(); }
      }
    }
  };

  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: conv.id,
        mode,
        content,
        messageId,
        model: currentModel(),
        thinking: S.settings.thinking !== false,
        hybrid: S.settings.hybridMode === true,
        reasoningEffort: S.settings.reasoningEffort || 'high',
        webSearch: !!S.settings.webSearch,
        readLink: S.settings.readLink !== false,
        safetyLevel: S.settings.safetyLevel || 'off',
        autoTitle: S.settings.autoTitle !== false,
        temperature: S.settings.temperature,
        ...(mode === 'send' && pending.length ? {
          attachments: pending.map(a => (a.kind === 'video' || a.kind === 'audio')
            ? {
                mediaId: a.mediaId, name: a.name, kind: a.kind, mime: a.mime, size: a.size,
                duration: a.duration, text: a.text, transcript: a.transcript, frames: a.frames,
              }
            : { uploadId: a.uploadId, name: a.name, mime: a.mime, size: a.size, kind: a.kind, fileId: a.fileId }),
        } : {}),
      }),
      signal: ac.signal,
    });

    if (!resp.ok) {
      const data = await resp.json().catch(() => null);
      const err = new Error((data && data.error) || `HTTP ${resp.status}`);
      err.status = resp.status;
      err.code = data && data.code;
      throw err;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = block.split('\n').find(l => l.startsWith('data:'));
        if (!line) continue;
        let ev = null;
        try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        onEvent(ev);
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      toast('已停止');
    } else if (err.code === 'NO_KEY' || /API Key/i.test(err.message)) {
      st.error = '还没填 API Key。点左下角「设置」填上就能发消息了。';
      toast('还没填 API Key');
      openSettings();
    } else {
      st.error = err.message;
      toast('出错了：' + err.message, 5000);
    }
  } finally {
    if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }
    const el = st.el;
    if (el) {
      if (st.finalMessage) {
        el.replaceWith(messageEl(st.finalMessage));
      } else if (st.error && !st.content) {
        el.remove();
        const msg = document.createElement('div');
        msg.className = 'msg assistant';
        msg.innerHTML = `<div class="avatar">${ICON.logo}</div><div class="body"><div class="notice err">${esc(st.error)}</div></div>`;
        $('#messages').appendChild(msg);
      } else if (st.mdEl) {
        st.mdEl.innerHTML = renderMarkdown({ content: st.content, annotations: st.annotations || [] }) || '<p class="muted">（没有内容）</p>';
      }
    } else if (st.error) {
      // 连 start 事件都没等到（比如 400 NO_KEY），也要把原因写出来，别留白
      const msg = document.createElement('div');
      msg.className = 'msg assistant';
      msg.innerHTML = `<div class="avatar">${ICON.logo}</div><div class="body"><div class="notice err">${esc(st.error)}</div></div>`;
      $('#messages').appendChild(msg);
    }
    if (st.warning) toast('提醒：' + st.warning, 5000);
    setStreamingUI(false);
    S.abort = null;
    $('#tokenHint').textContent = '';
    if (ac.signal.aborted) {
      try {
        let data = null;
        for (let i = 0; i < 6; i++) {
          data = await api('/api/conversations/' + conv.id + '?tail=80');
          const msgs = data.conversation.messages;
          const last = msgs[msgs.length - 1];
          const saved = !st.content || (last && last.role === 'assistant' && String(last.content || '').length >= st.content.length);
          if (saved) break;
          await new Promise(r => setTimeout(r, 250));
        }
        if (data) {
          const keep = $('#scroller').scrollTop;
          S.conv = data.conversation;
          S.convTotal = typeof data.totalMessages === 'number' ? data.totalMessages : S.conv.messages.length;
          S.convFrom = typeof data.from === 'number' ? data.from : 0;
          S.renderCount = Math.max(80, S.conv.messages.length);
          renderMessages();
          $('#scroller').scrollTop = keep;
        }
      } catch {}
    } else {
      try { await refreshState(); renderSidebar(); } catch {}
    }
    markLastActions();
    syncComposerMode();
    autoGrow();
    applySendState();
  }
}

function stopGeneration(silent) {
  if (S.abort) {
    S.abort.abort();
    if (!silent) toast('正在停止…');
  }
}

/* ------------------------------------------------------------------ 朗读（TTS） */

function plainText(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[*_~>|]+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stopAudio() {
  if (S.audio) {
    try { S.audio.pause(); } catch {}
    S.audio = null;
    S.audioMsgId = null;
    $$('.act-speak').forEach(b => { b.classList.remove('playing'); const s = b.querySelector('span'); if (s) s.textContent = '朗读'; });
  }
}

async function speakMessage(m) {
  const id = m && m.id;
  if (S.audioMsgId === id) { stopAudio(); return; }
  stopAudio();
  const text = plainText(m.content).slice(0, 9000);
  if (!text) return toast('这条没有可朗读的文字');
  toast('正在合成语音…', 8000);
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voiceId: S.settings.ttsVoice || 'stella' }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error((data && data.error) || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const audio = new Audio(URL.createObjectURL(blob));
    S.audio = audio;
    S.audioMsgId = id;
    const btn = $(`.msg[data-id="${id}"] .act-speak`);
    if (btn) { btn.classList.add('playing'); const s = btn.querySelector('span'); if (s) s.textContent = '停止'; }
    audio.onended = () => stopAudio();
    audio.onerror = () => { stopAudio(); toast('播放失败'); };
    await audio.play();
    const hint = document.getElementById('toast');
    if (hint) hint.classList.add('hidden');
  } catch (e) {
    stopAudio();
    toast('朗读失败：' + e.message, 5000);
  }
}

/* ------------------------------------------------------------------ 语音输入（ASR） */

function encodeWavPCM16(buffer) {
  const ch = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const frames = buffer.length;
  const mono = new Float32Array(frames);
  for (let c = 0; c < ch; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < frames; i++) mono[i] += data[i] / ch;
  }
  const out = new DataView(new ArrayBuffer(44 + frames * 2));
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) out.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  out.setUint32(4, 36 + frames * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, sr, true);
  out.setUint32(28, sr * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  writeStr(36, 'data');
  out.setUint32(40, frames * 2, true);
  let off = 44;
  for (let i = 0; i < frames; i++) {
    const s = Math.max(-1, Math.min(1, mono[i]));
    out.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}

function setMicState(on, label) {
  const btn = $('#micChip');
  btn.classList.toggle('on', !!on);
  btn.classList.toggle('rec', !!on);
  const txt = btn.querySelector('.mic-label');
  if (txt) txt.textContent = label || (on ? '停止' : '语音');
}

function insertAtCursor(text) {
  const ta = $('#input');
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  const before = ta.value.slice(0, start);
  const after = ta.value.slice(end);
  const sep = before && !/\s$/.test(before) ? ' ' : '';
  ta.value = before + sep + text + after;
  ta.selectionStart = ta.selectionEnd = (before + sep + text).length;
  autoGrow();
  applySendState();
  ta.focus();
}

async function toggleRecord() {
  if (S.recorder) {
    try { S.recorder.stop(); } catch {}
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return toast('这个浏览器不支持录音（需要用 https 或 localhost 打开）');
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    return toast('拿不到麦克风：' + e.message, 5000);
  }
  stopAudio();
  const mr = new MediaRecorder(stream);
  const chunks = [];
  mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  S.recorder = mr;
  setMicState(true, '停止');
  toast('开始录音，说完点一下「停止」', 3000);
  const timer = setTimeout(() => { try { mr.stop(); } catch {} }, 110000);
  mr.onstop = async () => {
    clearTimeout(timer);
    S.recorder = null;
    stream.getTracks().forEach(t => t.stop());
    setMicState(false, '识别中');
    if (!chunks.length) { setMicState(false); return; }
    try {
      const raw = await new Blob(chunks, { type: mr.mimeType || 'audio/webm' }).arrayBuffer();
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const actx = new Ctx();
      const audio = await actx.decodeAudioData(raw);
      const wav = encodeWavPCM16(audio);
      actx.close?.();
      if (wav.size > 8 * 1024 * 1024) throw new Error('录音超过 8 MiB（约 2 分钟）');
      const res = await fetch('/api/asr', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
      if (data.text) insertAtCursor(data.text);
      else toast('没听清，再说一次？');
    } catch (e) {
      toast('语音识别失败：' + e.message, 6000);
    } finally {
      setMicState(false);
    }
  };
  mr.start();
}

/* ------------------------------------------------------------------ 消息操作 */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('已复制');
  }
}

function findMessage(id) {
  return S.conv ? S.conv.messages.find(m => m.id === id) : null;
}

async function deleteMessage(id) {
  const m = findMessage(id);
  if (!m) return;
  const ok = await confirmDialog('删除这条消息？', m.role === 'user' ? '这条提问和它下面的回复会一起删掉。' : '只删掉这条回复。');
  if (!ok) return;
  try {
    const data = await api(`/api/conversations/${S.conv.id}/messages/${id}`, { method: 'DELETE' });
    S.conv = data.conversation;
    S.conversations = data.conversations;
    renderMessages();
    renderSidebar();
  } catch (e) {
    toast('删除失败：' + e.message);
  }
}

function startEditMessage(id) {
  const el = $(`.msg[data-id="${id}"]`);
  const m = findMessage(id);
  if (!el || !m) return;
  const bubble = el.querySelector('.bubble');
  const original = bubble.innerHTML;
  bubble.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'edit-box';
  const ta = document.createElement('textarea');
  ta.value = m.content;
  const btns = document.createElement('div');
  btns.className = 'edit-btns';
  btns.innerHTML = `<button class="btn" data-x="cancel">取消</button><button class="btn primary" data-x="save">保存并重新回答</button>`;
  box.appendChild(ta);
  box.appendChild(btns);
  bubble.appendChild(box);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.style.height = Math.min(240, ta.scrollHeight + 4) + 'px';

  const cancel = () => { bubble.innerHTML = original; };
  btns.addEventListener('click', e => {
    const x = e.target.closest('[data-x]');
    if (!x) return;
    if (x.dataset.x === 'cancel') return cancel();
    const text = ta.value.trim();
    if (!text) return toast('内容不能为空');
    sendMessage({ mode: 'edit', content: text, messageId: id });
  });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); btns.querySelector('.primary').click(); }
  });
}

async function forkFrom(id) {
  try {
    const data = await api(`/api/conversations/${S.conv.id}/fork`, { method: 'POST', body: { messageId: id } });
    S.conversations = data.conversations;
    renderSidebar();
    await openConversation(data.conversation.id);
    toast('已从这条消息分支');
  } catch (e) {
    toast('分支失败：' + e.message);
  }
}

/* ------------------------------------------------------------------ 输入框 */

function autoGrow() {
  const ta = $('#input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(220, Math.max(26, ta.scrollHeight)) + 'px';
}

function onInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (S.streaming) return;
    const text = $('#input').value.trim();
    if (text || S.attachments.some(a => !a.uploading)) sendMessage({ mode: 'send', content: text });
  }
}

/* ------------------------------------------------------------------ 弹窗 */

function modal(html, opts = {}) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal" role="dialog">${html}</div>`;
  $('#modalRoot').appendChild(mask);
  S.modalOpen = true;
  const close = () => {
    mask.remove();
    S.modalOpen = false;
    opts.onClose && opts.onClose();
  };
  mask.addEventListener('click', e => { if (e.target === mask) close(); });
  mask.querySelector('.modal').addEventListener('mousedown', e => e.stopPropagation());
  return { mask, close, body: mask.querySelector('.modal') };
}

function confirmDialog(title, desc, okText = '确定') {
  return new Promise(resolve => {
    const { close, body } = modal(`
      <h3>${esc(title)}</h3>
      <p class="sub">${esc(desc || '')}</p>
      <div class="modal-foot">
        <button class="btn" data-x="no">取消</button>
        <button class="btn danger" data-x="yes">${esc(okText)}</button>
      </div>`);
    body.addEventListener('click', e => {
      const x = e.target.closest('[data-x]');
      if (!x) return;
      close();
      resolve(x.dataset.x === 'yes');
    });
  });
}

async function openSettings() {
  let fresh = S.settings;
  try { fresh = await api('/api/settings'); } catch {}
  let stats = S.stats;
  try { stats = await api('/api/stats'); } catch {}
  const models = S.models.length ? S.models : [{ id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash', note: '' }];
  const langs = S.languages.length ? S.languages : ['中文', 'English'];

  const modelOpts = models.map(m => `<option value="${esc(m.id)}">${esc(m.label)}${m.note ? '（' + esc(m.note) + '）' : ''}</option>`).join('');
  const langOpts = langs.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join('');

  // 本机小模型（ollama）：用来写压缩摘要、算归档向量
  let local = { alive: false, models: [], chat: [], embed: [], pick: '', embedPick: '' };
  try { local = await api('/api/local-models'); } catch {}
  const localModelOpts = [
    `<option value="">自动（${esc(local.pick || '没探到')}）</option>`,
    ...(local.chat || []).map(n => `<option value="${esc(n)}">${esc(n)}</option>`),
  ].join('');
  const localTip = local.alive
    ? `本机 ollama 在线：${local.chat.length} 个对话模型、${local.embed.length} 个向量模型，自动选 ${local.pick || '—'}。`
    : '本机 ollama 没连上（127.0.0.1:11434）：压缩会退回 API，装了 ollama 再点「测一下」。';

  const { body, close } = pageShell('设置', 'Key 只保存在本机 data/settings.json，不会上传到任何地方。', `
    <div class="settings-top">
      <button class="btn" id="setImport" title="支持 DeepSeek 导出包 / JSON 整包 / 任意资料压缩包">导入对话或压缩包</button>
      <button class="btn" id="setThemeBtn">切换主题</button>
      <span class="tip" id="setStats"></span>
    </div>

    <div class="field">
      <label>DeepSeek API Key</label>
      <div class="row">
        <input type="password" id="setKey" placeholder="${fresh.hasKey ? '已保存：' + esc(fresh.apiKey) + '（留空则不改）' : 'sk-…'}" autocomplete="off" spellcheck="false">
        <button class="btn" id="testKey">测试</button>
      </div>
      <div class="tip" id="keyTip">没有 Key 也能看历史记录，只是发不出消息。在 platform.deepseek.com 申请。</div>
    </div>

    <div class="field">
      <label>API 地址</label>
      <input type="text" id="setBase" value="${esc(fresh.baseUrl || 'https://api.deepseek.com')}" spellcheck="false">
      <div class="tip">默认 https://api.deepseek.com，一般不用改。</div>
    </div>

    <div class="field">
      <label>默认模型</label>
      <select id="setModel"><option value="auto"${fresh.model === 'auto' ? ' selected' : ''}>自动（按内容路由）</option>${modelOpts}</select>
      <div class="tip">选「自动」时每条消息按内容挑模型；联网、图片、文档这些能力需要 deepseek-flash 那一档。</div>
    </div>

    <div class="switch-row">
      <div>
        <div class="lbl">默认开启深度思考</div>
        <div class="desc">先想再答；输入框里也能临时开关</div>
      </div>
      <input type="checkbox" id="setThinking" ${fresh.thinking ? 'checked' : ''}>
    </div>

    <div class="field">
      <label>思考强度</label>
      <select id="setEffort">
        <option value="low">低（更快）</option>
        <option value="high">高（默认）</option>
        <option value="max">最高（更慢更细）</option>
      </select>
    </div>

    <div class="switch-row">
      <div>
        <div class="lbl">默认开启联网搜索</div>
        <div class="desc">提问里贴了链接会自动读那个页面</div>
      </div>
      <input type="checkbox" id="setWeb" ${fresh.webSearch ? 'checked' : ''}>
    </div>

    <div class="switch-row">
      <div>
        <div class="lbl">自动读链接</div>
        <div class="desc">消息里有 URL 时让模型去打开它</div>
      </div>
      <input type="checkbox" id="setReadLink" ${fresh.readLink ? 'checked' : ''}>
    </div>

    <div class="field">
      <label for="setReadLinkMode">读不到时的兜底</label>
      <select id="setReadLinkMode">
        <option value="auto"${fresh.readLinkMode === 'auto' || !['api', 'local'].includes(fresh.readLinkMode) ? ' selected' : ''}>自动（API 工具 + 本机预读）</option>
        <option value="api"${fresh.readLinkMode === 'api' ? ' selected' : ''}>只用 API 的读链接工具</option>
        <option value="local"${fresh.readLinkMode === 'local' ? ' selected' : ''}>只用本机抓（不发 API 工具）</option>
      </select>
      <div class="desc">API 的读链接工具读不到的站（反爬、必须 JS 渲染），本机补两次：先直接抓 HTML，再不行用内嵌 Chromium 渲染后取正文。</div>
    </div>

    <div class="switch-row">
      <div>
        <div class="lbl">本机预读网页</div>
        <div class="desc">发消息前先把链接本机读一遍，正文随消息一起给模型（不额外花钱）；关掉就只靠 API 工具</div>
      </div>
      <input type="checkbox" id="setReadLinkLocal" ${fresh.readLinkLocal !== false ? 'checked' : ''}>
    </div>

    <div class="switch-row">
      <div>
        <div class="lbl">自动路由</div>
        <div class="desc">按每条消息挑模型：聊天 → V4 Pro，逻辑/计算 → V4.1 Flash（带思考），要成篇的东西 → Flash 先出大纲、Pro 再润色填充</div>
      </div>
      <input type="checkbox" id="setAutoRoute" ${fresh.autoRoute !== false ? 'checked' : ''}>
    </div>

    <div class="switch-row">
      <div>
        <div class="lbl">混合模式（输入框里的二分树按钮）</div>
        <div class="desc">打开后不管内容是什么，都先让 V4.1 Flash 写一份大纲，再让 V4 Pro 按大纲把正文写完整。它比自动路由更硬：不受「自动路由」开关影响，只影响你自己按的那一下。带附件时走不了（附件只有 Flash 能看）。</div>
      </div>
      <input type="checkbox" id="setHybridMode" ${fresh.hybridMode === true ? 'checked' : ''}>
    </div>

    <div class="switch-row">
      <div>
        <div class="lbl">音视频两段式解析</div>
        <div class="desc">发视频或音频时，先让 V4.1 Flash 看转写和抽帧、扒成一份要点清单，再让 V4 Pro 按要点写回答。关掉就还是一遍让 Flash 直接答。带图片/文档的消息不受影响。</div>
      </div>
      <input type="checkbox" id="setMediaTwoStage" ${fresh.mediaTwoStage !== false ? 'checked' : ''}>
    </div>

    <div class="switch-row">
      <div>
        <div class="lbl">按对话自动调提示词与温度</div>
        <div class="desc">每一轮看你的问法和对话状态：代码/计算降温度、创作抬温度、长对话提醒别复述、短问别客套。只影响这一轮，不改你上面设的温度。回答顶部会标一个「自适应 · 温度 x」。</div>
      </div>
      <input type="checkbox" id="setAdaptiveTurn" ${fresh.adaptiveTurn !== false ? 'checked' : ''}>
    </div>

    <div class="field">
      <label for="setRouteChat">各档用哪个模型</label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <select id="setRouteChat" title="对话">
          ${routeOpts(fresh.routeChatModel)}
        </select>
        <select id="setRouteThink" title="逻辑思考 / 看附件">
          ${routeOpts(fresh.routeThinkModel)}
        </select>
        <select id="setRouteHybridDraft" title="综合：先出大纲">
          ${routeOpts(fresh.routeHybridDraftModel)}
        </select>
        <select id="setRouteHybrid" title="综合：写正文">
          ${routeOpts(fresh.routeHybridModel)}
        </select>
      </div>
      <div class="desc">依次是：对话、逻辑思考（附件也走这档）、混合时出大纲的、混合时写正文的。模型菜单里选「自动（按内容路由）」时生效。</div>
    </div>

    <div class="switch-row">
      <div>
        <div class="lbl">自动生成标题</div>
        <div class="desc">第一轮回答后由模型给对话起名</div>
      </div>
      <input type="checkbox" id="setAutoTitle" ${fresh.autoTitle ? 'checked' : ''}>
    </div>

    <div class="field">
      <label>内容安全审核</label>
      <select id="setSafety">
        <option value="off">关闭</option>
        <option value="low">低</option>
        <option value="high">高</option>
      </select>
      <div class="tip">开启后输入输出都会过审，命中会拒答；自己用可以关。</div>
    </div>

    <div class="field">
      <label>温度</label>
      <input type="range" id="setTemp" min="0" max="2" step="0.1" value="${Number(fresh.temperature)}" style="width:100%">
      <div class="tip">越低越稳，越高越发散。开了思考模式或联网工具时这个参数不生效。</div>
    </div>

    <div class="field">
      <label>回复风格</label>
      <select id="setReplyStyle">
        <option value="human">活人感（默认，治 AI 腔）</option>
        <option value="native">原生（不加任何风格提示）</option>
        <option value="custom">自定义（只用下面的系统提示词）</option>
      </select>
      <div class="tip">活人感会加一小段"先给判断、说具体数字、别排比别总结"的提示，压不住时要清单步骤照样会给。自定义 = 只用你自己写的系统提示词。</div>
    </div>

    <div class="field">
      <label>系统提示词</label>
      <textarea id="setSystem" placeholder="例如：你是一个说话直接、不绕弯子的助手。">${esc(fresh.systemPrompt || '')}</textarea>
      <div class="tip">选「活人感」时这段会跟在风格提示后面一起生效；选「自定义」时只生效这一段。</div>
    </div>

    <div class="field">
      <label>技能包</label>
      <div id="setSkills" class="skill-list"><div class="desc">正在读取…</div></div>
      <div class="tip">放在 <code>skills/&lt;名字&gt;/SKILL.md</code> 里的技能，勾上就随每次对话注入。一个技能最多 6000 字，勾太多会挤占上下文。</div>
    </div>

    <div class="field">
      <label>带多少条历史给模型</label>
      <input type="number" id="setHist" min="0" max="500" value="${Number(fresh.maxHistoryMessages) || 0}">
      <div class="tip">0 = 全部带上（长对话注意 token 消耗）。一般不用自己截断，下面的上下文管理会更聪明地处理。</div>
    </div>

    <div class="modal-sep">
      <div class="lbl">上下文与记忆</div>
      <div class="desc">长对话不让模型走神：老消息压成记忆、相关旧片段按向量召回、越早的内容权重越低。</div>
    </div>

    <div class="switch-row">
      <div>
        <div class="lbl">自动压缩老对话</div>
        <div class="desc">超出预算的老消息让模型压成一段结构化记忆（事实 / 决定 / 偏好 / 未完成）</div>
      </div>
      <input type="checkbox" id="setCtxCompress" ${fresh.ctxCompress ? 'checked' : ''}>
    </div>

    <div class="field">
      <label>压缩用谁的模型</label>
      <div class="row">
        <select id="setCtxSummarizer" style="flex:1">
          <option value="auto">自动（本机优先，失败退回 API）</option>
          <option value="local">只用本机小模型（不花钱）</option>
          <option value="api">只用 DeepSeek API</option>
        </select>
        <button class="btn ghost" id="ctxTestLocal" type="button">测一下</button>
      </div>
      <div class="tip" id="ctxLocalTip">${esc(localTip)}</div>
    </div>

    <div class="field" id="ctxLocalBox">
      <label>本机模型</label>
      <div class="row">
        <select id="setCtxLocalModel" style="flex:1">${localModelOpts}</select>
        <input type="text" id="setCtxEmbedModel" style="flex:1" placeholder="向量模型（auto / off / 名字）" value="${esc(fresh.ctxEmbedModel || 'auto')}">
      </div>
      <div class="tip">摘要默认挑本机最小的对话模型；右边填 <code>auto</code> 会用 ollama 里的 embed 模型给归档片段算向量（混合检索），填 <code>off</code> 就纯词面 BM25。</div>
      <input type="text" id="setCtxLocalUrl" value="${esc(fresh.ctxLocalUrl || 'http://127.0.0.1:11434')}" placeholder="http://127.0.0.1:11434">
    </div>

    <div class="switch-row">
      <div>
        <div class="lbl">缺模型时自动拉一个（国内镜像优先）</div>
        <div class="desc">本机 ollama 里没有能写摘要的小模型时，自动拉：先试 ollama 官方源，拉不动就换魔搭 / hf-mirror 下 GGUF 再用 ollama create 装进去</div>
      </div>
      <input type="checkbox" id="setCtxAutoPull" ${fresh.ctxAutoPull !== false ? 'checked' : ''}>
    </div>

    <div class="field" id="ctxPullBox">
      <div class="row" style="align-items:center;gap:8px">
        <button class="btn ghost" id="ctxPullNow" type="button">现在拉一个</button>
        <span class="tip" id="ctxPullState" style="margin:0">—</span>
      </div>
      <div class="tip">拉取进度与来源会写在这里；同一个模型只拉一次，存在 data/models/ 下。<span id="ctxPullLog"></span></div>
    </div>

    <div class="switch-row">
      <div>
        <div class="lbl">压缩前把原文存成 JSON</div>
        <div class="desc">存到 data/archive/&lt;会话&gt;/&lt;起始-结束&gt;.json，摘要丢了细节还能翻原文，也进检索索引</div>
      </div>
      <input type="checkbox" id="setCtxArchive" ${fresh.ctxArchive ? 'checked' : ''}>
    </div>

    <div class="field">
      <label>上下文预算（全局默认）</label>
      <select id="setCtxBudget">
        <option value="8000">8k token（省着用）</option>
        <option value="16000">16k token</option>
        <option value="24000">24k token（推荐）</option>
        <option value="48000">48k token</option>
        <option value="96000">96k token（很长）</option>
        <option value="128000">128k token</option>
        <option value="256000">256k token</option>
        <option value="512000">512k token</option>
        <option value="1000000">1M token（顶满 Flash 窗口）</option>
      </select>
      <div class="tip">模型窗口最多 100 万 token，但注意力会散：预算越小，模型越专注在最近的对话和摘要上。单个会话可以在「上下文与记忆」面板里单独设，不受这里影响。</div>
    </div>

    <div class="switch-row">
      <div>
        <div class="lbl">向量检索旧片段</div>
        <div class="desc">本地 BM25 词面索引（DeepSeek 没有 embeddings 接口），按相关度 × 时间权重召回</div>
      </div>
      <input type="checkbox" id="setCtxRag" ${fresh.ctxRag ? 'checked' : ''}>
    </div>

    <div class="field">
      <label>召回条数</label>
      <input type="number" id="setCtxTopK" min="0" max="8" value="${Number(fresh.ctxTopK) || 0}">
      <div class="tip">每次从老消息里捞几条最相关的塞进上下文；0 = 不检索。</div>
    </div>

    <div class="field">
      <label>时间衰减半衰期（天）</label>
      <input type="number" id="setCtxHalfLife" min="0.5" max="365" step="0.5" value="${Number(fresh.ctxHalfLifeDays) || 30}">
      <div class="tip">每过这么久，旧内容的权重减半：影响召回排序，超过一个半衰期的长消息正文也会被适度压缩。</div>
    </div>

    <div class="field">
      <label>分档压缩步进</label>
      <div class="row">
        <input type="number" id="setCtxStep" min="10" max="90" step="1" value="${Math.round((Number(fresh.ctxStepRatio) || 0.33) * 100)}">
        <span style="align-self:center">% 一档</span>
      </div>
      <div class="tip">占用每涨这么多，就把新露出来的老消息压成一条概要（记进「压缩记录」，带关键词）。</div>
    </div>

    <div class="field">
      <label>时间加权遗忘阈值</label>
      <div class="row">
        <input type="number" id="setCtxForget" min="20" max="95" step="1" value="${Math.round((Number(fresh.ctxForgetRatio) || 0.5) * 100)}">
        <span style="align-self:center">% 起概括</span>
      </div>
      <div class="tip">占用超过这个比例后，按时间权重把分段记忆合成一段长期记忆；超过半衰期的段只留关键词（原文还在归档里，能展开找回）。</div>
    </div>

    <div class="switch-row">
      <div>
        <div class="lbl">渐进激活记忆</div>
        <div class="desc">相关度高的直接给片段；低的只给「关键词索引卡」，你在对话里说「展开第 2 条」才取原文</div>
      </div>
      <input type="checkbox" id="setCtxProgressive" ${fresh.ctxProgressive !== false ? 'checked' : ''}>
    </div>

    <div class="field">
      <label>直给片段的相关度阈值</label>
      <input type="number" id="setCtxActivate" min="0" max="1" step="0.05" value="${Number(fresh.ctxActivateScore) || 0.2}">
      <div class="tip">高于它的命中直接进上下文；低于它的只出索引卡，省 token 也省得模型瞎用。</div>
    </div>

    <div class="field">
      <label>语言 / 所在地（作为用户元信息带上）</label>
      <div class="row">
        <select id="setLang" style="flex:1">${langOpts}</select>
        <input type="text" id="setLocation" value="${esc(fresh.location || '')}" placeholder="所在地，可留空" style="flex:1">
      </div>
      <div class="tip">官方 App 每次请求带 <code>latest_reminder</code>，让模型知道今天几号、你在哪、用什么语言。</div>
    </div>

    <div class="field">
      <label>朗读音色</label>
      <select id="setVoice">
        <option value="stella">stella（海星 · 女声）</option>
        <option value="tide">tide（暗潮 · 男声）</option>
      </select>
    </div>

    <div class="switch-row">
      <div>
        <div class="lbl">主题</div>
        <div class="desc">跟随系统 / 浅色 / 深色</div>
      </div>
      <select id="setTheme" style="width:130px;padding:7px 10px;border-radius:9px;border:1px solid var(--border);background:var(--bg-soft)">
        <option value="auto">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
    </div>

    <div class="switch-row">
      <div>
        <div class="lbl">首次启动自动导入</div>
        <div class="desc">只在第一次启动时找 app 导出的 JSON</div>
      </div>
      <input type="checkbox" id="setAutoImport" ${fresh.autoImport ? 'checked' : ''}>
    </div>

    <div class="field" style="margin-top:16px">
      <label>本机统计</label>
      <div class="stat-grid">
        <div class="stat-card"><div class="n">${fmtNum(stats.conversations)}</div><div class="k">对话</div></div>
        <div class="stat-card"><div class="n">${fmtNum(stats.messages)}</div><div class="k">消息</div></div>
        <div class="stat-card"><div class="n">${fmtNum(stats.chars)}</div><div class="k">总字数</div></div>
        <div class="stat-card"><div class="n">${fmtNum(stats.tokens)}</div><div class="k">已记录 token</div></div>
      </div>
      <div class="tip">数据都在 deepseek-app/data 目录里，直接拷走就是备份。</div>
    </div>

    <div class="modal-foot">
      <button class="btn" data-x="cancel">取消</button>
      <button class="btn primary" data-x="save">保存</button>
    </div>
  `, 'settings');

  body.querySelector('#setModel').value = fresh.model || 'deepseek-flash';
  body.querySelector('#setTheme').value = fresh.theme || 'auto';
  body.querySelector('#setEffort').value = fresh.reasoningEffort || 'high';
  body.querySelector('#setSafety').value = fresh.safetyLevel || 'off';
  // 技能包：拉列表 → 复选框，勾选状态回写到保存 payload 里
  (async () => {
    const box = body.querySelector('#setSkills');
    if (!box) return;
    try {
      const r = await fetch('/api/skills');
      const d = await r.json();
      const list = (d.skills || []);
      if (!list.length) {
        box.innerHTML = '<div class="desc">还没有技能包。在 skills/ 下建一个目录，放 SKILL.md 就会出现。</div>';
        return;
      }
      box.innerHTML = list.map(s => `
        <label class="switch-row skill-row">
          <div>
            <div class="lbl">${esc(s.name)}</div>
            <div class="desc">${esc(s.description || '')}</div>
          </div>
          <input type="checkbox" class="skill-pick" value="${esc(s.id)}" ${s.enabled ? 'checked' : ''}>
        </label>`).join('');
    } catch (e) {
      box.innerHTML = '<div class="desc">读取技能失败：' + esc(String(e && e.message || e)) + '</div>';
    }
  })();
  body.querySelector('#setVoice').value = fresh.ttsVoice || 'stella';
  body.querySelector('#setLang').value = fresh.language || '中文';
  body.querySelector('#setCtxSummarizer').value = fresh.ctxSummarizer || 'auto';
  if (fresh.ctxLocalModel) {
    const lsel = body.querySelector('#setCtxLocalModel');
    if (![...lsel.options].some(o => o.value === fresh.ctxLocalModel)) {
      const opt = document.createElement('option');
      opt.value = fresh.ctxLocalModel;
      opt.textContent = fresh.ctxLocalModel + '（当前）';
      lsel.appendChild(opt);
    }
    lsel.value = fresh.ctxLocalModel;
  }
  body.querySelector('#ctxTestLocal')?.addEventListener('click', async ev => {
    const btn = ev.currentTarget;
    const tip = body.querySelector('#ctxLocalTip');
    btn.disabled = true;
    const saved = tip.textContent;
    tip.textContent = '正在让本机模型写一句话…（首次要加载模型，可能几十秒）';
    try {
      const r = await api('/api/context/summary-test', { method: 'POST', body: {} });
      tip.textContent = r.ok
        ? `本机模型可用：${r.model}，${r.ms}ms，试写「${r.sample}」`
        : `本机模型不可用：${r.error || r.engine}（会把摘要交给 API）`;
    } catch (e) {
      tip.textContent = '测失败：' + e.message;
    } finally {
      btn.disabled = false;
    }
  });

  // 摘要模型自动拉取：状态 + 手动触发
  {
    const stateEl = body.querySelector('#ctxPullState');
    const logEl = body.querySelector('#ctxPullLog');
    const btn = body.querySelector('#ctxPullNow');
    const paint = (p) => {
      if (!p) return;
      if (p.running) {
        stateEl.textContent = `正在拉（${p.source || '准备中'}）… ${p.step || ''}`;
        logEl.textContent = p.bytes ? `已下载 ${(p.bytes / 1048576).toFixed(1)} MB` : '';
        btn.disabled = true;
        return;
      }
      btn.disabled = false;
      if (p.ok) {
        stateEl.textContent = `已就绪：${p.model}（来源 ${p.source || '已有'}）`;
        logEl.textContent = '';
      } else if (p.error) {
        stateEl.textContent = `没拉成：${p.error}`;
        logEl.textContent = '';
      } else {
        stateEl.textContent = '还没拉过';
        logEl.textContent = '';
      }
    };
    let timer = 0;
    const poll = async () => {
      if (!document.body.contains(body)) { clearInterval(timer); return; }
      try { paint(await api('/api/context/model-pull')); } catch { /* 忽略一次失败 */ }
    };
    btn?.addEventListener('click', async () => {
      btn.disabled = true;
      stateEl.textContent = '正在开始…';
      try { paint(await api('/api/context/model-pull', { method: 'POST', body: {} })); } catch (e) { stateEl.textContent = '启动失败：' + e.message; btn.disabled = false; }
      poll();
    });
    poll();
    timer = setInterval(poll, 1500);
  }
  {
    const sel = body.querySelector('#setCtxBudget');
    const v = String(Number(fresh.ctxBudget) || 24000);
    if (![...sel.options].some(o => o.value === v)) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = fmtNum(Number(v)) + ' token（当前）';
      sel.appendChild(opt);
    }
    sel.value = v;
  }

  body.querySelector('#testKey').addEventListener('click', async e => {
    const tip = body.querySelector('#keyTip');
    const key = body.querySelector('#setKey').value.trim();
    const base = body.querySelector('#setBase').value.trim();
    tip.className = 'tip';
    tip.textContent = '正在测试…';
    e.target.disabled = true;
    try {
      const r = await api('/api/settings/test', { method: 'POST', body: { apiKey: key, baseUrl: base } });
      tip.className = 'tip ok';
      tip.textContent = `连上了。可用模型：${(r.models || []).join('、') || '（没返回列表）'}`;
    } catch (err) {
      tip.className = 'tip err';
      tip.textContent = '失败：' + err.message;
    } finally {
      e.target.disabled = false;
    }
  });

  // 这一页所有控件的当前值（Key 单独取，空表示不改）
  const readPatch = () => ({
      baseUrl: body.querySelector('#setBase').value.trim() || 'https://api.deepseek.com',
      model: body.querySelector('#setModel').value,
      thinking: body.querySelector('#setThinking').checked,
      reasoningEffort: body.querySelector('#setEffort').value,
      webSearch: body.querySelector('#setWeb').checked,
      readLink: body.querySelector('#setReadLink').checked,
      readLinkMode: body.querySelector('#setReadLinkMode').value,
      readLinkLocal: body.querySelector('#setReadLinkLocal').checked,
        autoRoute: body.querySelector('#setAutoRoute').checked,
        hybridMode: body.querySelector('#setHybridMode').checked,
        mediaTwoStage: body.querySelector('#setMediaTwoStage').checked,
      adaptiveTurn: body.querySelector('#setAdaptiveTurn').checked,
      routeChatModel: body.querySelector('#setRouteChat').value,
      routeThinkModel: body.querySelector('#setRouteThink').value,
      routeHybridDraftModel: body.querySelector('#setRouteHybridDraft').value,
      routeHybridModel: body.querySelector('#setRouteHybrid').value,
      autoTitle: body.querySelector('#setAutoTitle').checked,
      safetyLevel: body.querySelector('#setSafety').value,
      temperature: Number(body.querySelector('#setTemp').value),
      systemPrompt: body.querySelector('#setSystem').value,
      replyStyle: body.querySelector('#setReplyStyle')?.value || 'human',
      enabledSkills: [...body.querySelectorAll('.skill-pick:checked')].map(i => i.value),
      maxHistoryMessages: Number(body.querySelector('#setHist').value) || 0,
      ctxCompress: body.querySelector('#setCtxCompress').checked,
      ctxBudget: Number(body.querySelector('#setCtxBudget').value) || 24000,
      ctxRag: body.querySelector('#setCtxRag').checked,
      ctxTopK: Number(body.querySelector('#setCtxTopK').value) || 0,
      ctxHalfLifeDays: Number(body.querySelector('#setCtxHalfLife').value) || 30,
      ctxSummarizer: body.querySelector('#setCtxSummarizer').value,
      ctxLocalModel: body.querySelector('#setCtxLocalModel').value,
      ctxEmbedModel: (body.querySelector('#setCtxEmbedModel').value || '').trim() || 'auto',
      ctxLocalUrl: (body.querySelector('#setCtxLocalUrl').value || '').trim(),
      ctxAutoPull: body.querySelector('#setCtxAutoPull').checked,
      ctxArchive: body.querySelector('#setCtxArchive').checked,
      ctxStepRatio: (Number(body.querySelector('#setCtxStep').value) || 33) / 100,
      ctxForgetRatio: (Number(body.querySelector('#setCtxForget').value) || 50) / 100,
      ctxProgressive: body.querySelector('#setCtxProgressive').checked,
      ctxActivateScore: Number(body.querySelector('#setCtxActivate').value) || 0.2,
      language: body.querySelector('#setLang').value,
      location: body.querySelector('#setLocation').value.trim(),
      ttsVoice: body.querySelector('#setVoice').value,
      theme: body.querySelector('#setTheme').value,
      autoImport: body.querySelector('#setAutoImport').checked,
    });

  /* 保存键三件套：悬停说明 / 有改动就亮 / 按下有回执 */
  const saveBtn = body.querySelector('[data-x="save"]');
  const keyInput = body.querySelector('#setKey');
  const saveTitle = '把这一页的改动写进本机 data/settings.json：Key、API 地址、默认模型、'
    + '联网与读链接、自动路由与混合模式、音视频两段式、上下文压缩与检索、主题、语音等；'
    + '没动过的项保持原值。';
  const snapshot = () => JSON.stringify({ p: readPatch(), k: (keyInput ? keyInput.value : '').trim() });
  let baseline = snapshot();
  function isDirty() { return snapshot() !== baseline; }

  function paintSave() {
    if (!saveBtn || saveBtn.dataset.busy) return;
    const dirty = isDirty();
    saveBtn.classList.toggle('dirty', dirty);
    saveBtn.textContent = dirty ? '保存 · 有改动' : '保存';
    saveBtn.title = dirty ? saveTitle + '（现在有未保存的改动）' : saveTitle;
  }

  if (saveBtn) saveBtn.title = saveTitle;
  registerSaveGuard({ dirty: isDirty, hint: () => '设置页还有没保存的改动：再点一次这个入口就放弃改动' });
  body.addEventListener('input', paintSave);
  body.addEventListener('change', paintSave);
  paintSave();

  body.addEventListener('click', async e => {
    const x = e.target.closest('[data-x]');
    if (!x) return;
    if (x.dataset.x === 'cancel') return close();
    if (x.dataset.x !== 'save') return;

    const patch = readPatch();
    const key = (keyInput ? keyInput.value : '').trim();
    if (key) patch.apiKey = key;

    if (saveBtn) {
      saveBtn.dataset.busy = '1';
      saveBtn.disabled = true;
      saveBtn.classList.remove('dirty');
      saveBtn.textContent = '保存中…';
    }
    try {
      const saved = await api('/api/settings', { method: 'PUT', body: patch });
      S.settings = saved;
      applyTheme(saved.theme);
      updateKeyState();
      syncComposerMode();
      baseline = snapshot();
      dropSaveGuard();
      if (saveBtn) {
        delete saveBtn.dataset.busy;
        saveBtn.disabled = false;
        saveBtn.classList.add('ok');
        saveBtn.textContent = '已保存 ✓';
        saveBtn.title = '已写进本机 data/settings.json';
      }
      toast(key ? '已保存，Key 已更新' : '已保存');
      if (S.conversations.length === 0) showWelcome();
      // 让「已保存 ✓」停一下再回到对话，不然一闪就没了
      setTimeout(() => { if (saveBtn && document.body.contains(saveBtn)) close(); }, 780);
    } catch (err) {
      if (saveBtn) {
        delete saveBtn.dataset.busy;
        saveBtn.disabled = false;
        saveBtn.textContent = '保存失败，再试一次';
        setTimeout(paintSave, 1800);
      }
      toast('保存失败：' + err.message);
    }
  });

  const statsTxt = body.querySelector('#setStats');
  if (statsTxt) {
    statsTxt.textContent = `本地 ${stats.conversations || 0} 个会话 · ${fmtNum(stats.messages || 0).replace(/\s+/g, '')}条消息 · ${fmtNum(stats.tokens || 0).replace(/\s+/g, '')} token`;
  }
  body.querySelector('#setImport')?.addEventListener('click', () => openImportPage());
  body.querySelector('#setThemeBtn')?.addEventListener('click', async () => {
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(S.theme) + 1) % order.length];
    applyTheme(next);
    body.querySelector('#setTheme').value = next;
    toast(next === 'auto' ? '主题：跟随系统' : next === 'light' ? '主题：浅色' : '主题：深色', 1200);
    try { await api('/api/settings', { method: 'PUT', body: { theme: next } }); S.settings.theme = next; } catch {}
  });
}

/* ------------------------------------------------------------------ 上下文与记忆 */

function updateCtxBadge(meta) {
  const el = $('#ctxBadge');
  if (!el) return;
  if (!meta || !meta.budget) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const raw = (meta.tokens || 0) / meta.budget;
  const pct = Math.max(0, Math.min(1, raw));
  $('#ctxFill').style.width = Math.round(pct * 100) + '%';
  el.classList.toggle('warn', pct >= 0.85);
  const shown = raw > 1 ? '超预算' : Math.round(raw * 100) + '%';
  const bits = [`上下文 ${Math.round(raw * 100)}%（${fmtNum(meta.tokens || 0)} / ${fmtNum(meta.budget)} token）`];
  if (raw > 1) bits.push('超出预算，老消息会被压缩或丢掉');
  if (meta.memory) bits.push(`记忆覆盖 ${fmtNum(meta.memory.covered)} 条（${fmtNum(meta.memory.tokens || 0)} token）`);
  if (meta.rag && meta.rag.length) bits.push(`本轮召回 ${meta.rag.length} 段旧片段`);
  if (meta.trimmed) bits.push(`按时间降权裁剪 ${meta.trimmed} 条`);
  if (meta.indexChunks) bits.push(`索引 ${fmtNum(meta.indexChunks)} 段`);
  el.title = bits.join(' · ') + '（点开看细节）';
  $('#ctxLabel').textContent = shown + (meta.memory ? '·记' : '');
}

async function refreshCtxBadge() {
  if (!S.conv || !S.conv.id) { $('#ctxBadge')?.classList.add('hidden'); return; }
  try {
    const st = await api('/api/conversations/' + S.conv.id + '/context');
    S.ctxStatus = st;
    updateCtxBadge({ tokens: st.historyTokens, budget: st.budget, memory: st.memory, indexChunks: st.indexChunks });
  } catch {
    $('#ctxBadge')?.classList.add('hidden');
  }
}

async function openContextPanel() {
  if (!S.conv || !S.conv.id) return toast('先打开一个对话');
  let st = null;
  try {
    st = await api('/api/conversations/' + S.conv.id + '/context');
  } catch (e) {
    return toast('读不到上下文状态：' + e.message);
  }
  S.ctxStatus = st;
  const rawPct = Math.round((st.historyTokens / Math.max(1, st.budget)) * 100);
  const pct = Math.max(0, Math.min(100, rawPct));
  const mem = st.memory;
  const sm = st.summarizer || {};
  const sumText = sm.engine === 'local'
    ? `本机 ${esc(sm.localModel || '')}${mem && mem.model ? `（上次：${esc(mem.model)}）` : ''}`
    : sm.engine === 'api'
      ? 'DeepSeek API（deepseek-flash）'
      : `用不了（${esc(sm.reason || '本机没模型、也没 Key')}）`;
  const ar = st.archive || {};
  const arcText = ar.entries
    ? `${ar.entries} 段 / ${fmtNum(ar.messages)} 条 / ${fmtNum(ar.tokens)} token / ${fmtNum(ar.bytes)} 字节${ar.embedModel ? ` · 向量 ${ar.dims} 维` : ' · 纯词面'}`
    : '还没有（压缩时才写）';
  const { body, close } = modal(`
    <h3>上下文与记忆</h3>
    <p class="sub">这个对话 ${fmtNum(st.historyMessages)} 条消息 · ${fmtNum(st.historyTokens)} token；预算 ${fmtNum(st.budget)} token。</p>

    <div class="ctx-meter"><i style="width:${pct}%"></i></div>
    <div class="ctx-row"><span>预算占用</span><b>${rawPct}%${rawPct > 100 ? '（超了，老消息会被压缩/丢掉）' : ''}</b></div>
    <div class="ctx-row"><span>向量索引</span><b>${fmtNum(st.indexChunks)} 段 / ${st.dims} 词（本地 BM25）</b></div>
    <div class="ctx-row"><span>压缩记忆</span><b>${mem ? `${fmtNum(mem.covered)} 条 · ${fmtNum(mem.tokens)} token · 第 ${mem.calls} 次` : '还没有'}</b></div>
    <div class="ctx-row"><span>压缩档位</span><b>${mem ? `已压到第 ${mem.step || 0} 档（每 ${Math.round((st.settings.ctxStepRatio || 0.33) * 100)}% 一档）· 概括至第 ${mem.forgetStep || 0} 级（${Math.round((st.settings.ctxForgetRatio || 0.5) * 100)}% 起）` : '—'}</b></div>
    <div class="ctx-row"><span>摘要引擎</span><b>${sumText}</b></div>
    <div class="ctx-row"><span>原文归档</span><b>${arcText}</b></div>
    <div class="ctx-row"><span>设置</span><b>${st.settings.ctxCompress ? '自动压缩开' : '自动压缩关'} · ${st.settings.ctxRag ? '检索开' : '检索关'} · ${st.settings.ctxProgressive !== false ? '渐进激活开' : '渐进激活关'} · 半衰期 ${st.settings.ctxHalfLifeDays} 天</b></div>

    <div class="field" style="margin-top:14px">
      <label>记忆摘要</label>
      <pre class="ctx-memory">${mem && mem.text ? esc(mem.text) : '（还没压缩过：对话没超预算，或者自动压缩是关的）'}</pre>
    </div>

    <div class="field">
      <label>压缩记录${mem && mem.records && mem.records.length ? `（${mem.records.length} 段）` : ''}</label>
      <div class="ctx-records">${(mem && mem.records && mem.records.length)
        ? mem.records.map(r => `
            <div class="ctx-record${r.forgotten ? ' forgotten' : ''}">
              <div class="ctx-record-head">
                <span class="ctx-hit-n">#${r.n}</span>
                <span class="muted">第 ${r.from + 1}–${r.to + 1} 条 · 占用 ${Math.round((r.rawRatio || 0) * 100)}% 时压 · ${fmtNum(r.tokens)} token${r.forgotten ? ' · 已遗忘（只留关键词）' : ''}</span>
                <button class="btn mini" data-activate="${r.from}|${r.to}" data-k="${r.n}">展开</button>
              </div>
              <div class="ctx-record-kw">关键词：${esc(r.keywords || '—')}</div>
              <div class="ctx-record-gist">${esc(r.gist || '')}</div>
            </div>`).join('')
        : '<div class="tip">还没压过档：占用每涨一个步进才会记一段。</div>'}
      </div>
      <div id="ctxOriginal" class="ctx-original hidden"></div>
    </div>

    <div class="field">
      <label>本会话上下文参数${st.ctx && !st.ctx.followGlobal ? '（这个会话单独设了）' : '（现在跟随全局）'}</label>
      <div class="row">
        <select id="ctxLocalBudget" style="flex:1">
          <option value="">预算跟随全局（${fmtNum(st.budget)}）</option>
          ${[24000, 64000, 128000, 256000, 512000, st.ctx?.budgetMax || 1000000].map(v => `<option value="${v}">${v >= 1000000 ? '1M' : Math.round(v / 1000) + 'k'}（${fmtNum(v)} token）</option>`).join('')}
        </select>
      </div>
      <div class="ctx-local-grid">
        <label>热区比例<input id="ctxLocalHot" type="number" step="0.05" min="0.2" max="0.95"></label>
        <label>召回条数<input id="ctxLocalTopK" type="number" min="0" max="20"></label>
        <label>半衰期（天）<input id="ctxLocalHalf" type="number" step="0.5" min="0.5" max="3650"></label>
      </div>
      <div class="row" style="gap:16px">
        <label class="check-inline"><input type="checkbox" id="ctxLocalCompress"> 自动压缩</label>
        <label class="check-inline"><input type="checkbox" id="ctxLocalRag"> 检索旧片段</label>
      </div>
      <div class="row">
        <button class="btn" data-x="saveCtx">保存到本会话</button>
        <button class="btn" data-x="resetCtx">恢复跟随全局</button>
      </div>
      <div class="tip">1M 是 V4.1 Flash 的窗口上限；预算越小注意力越集中。这里只影响这一个会话。</div>
    </div>

    <div class="field">
      <label>召回预览</label>
      <div class="row">
        <input type="text" id="ctxQuery" placeholder="留空就用这个对话的最后一条提问" spellcheck="false" style="flex:1">
        <button class="btn" id="ctxPreview">试一下</button>
      </div>
      <div id="ctxHits" class="ctx-hits"><div class="tip">检索用本地索引，按「相关度 × 时间权重」排序：越早的对话权重越低。</div></div>
    </div>

    <div class="modal-foot">
      <button class="btn" data-x="reset">清空记忆</button>
      <button class="btn" data-x="consolidate">整合记忆</button>
      <button class="btn" data-x="compact">立即压缩</button>
      <button class="btn primary" data-x="close">关掉</button>
    </div>
  `);

  // 本会话参数：回填当前生效值（有覆盖就是覆盖值，没有就是全局值）
  const ovl = (st.ctx && st.ctx.overrides) || {};
  const fillSel = body.querySelector('#ctxLocalBudget');
  if (fillSel) fillSel.value = ovl.ctxBudget ? String(ovl.ctxBudget) : '';
  const fillNum = (sel, v) => { const el = body.querySelector(sel); if (el) el.value = String(v); };
  fillNum('#ctxLocalHot', st.settings.ctxHotRatio);
  fillNum('#ctxLocalTopK', st.settings.ctxTopK);
  fillNum('#ctxLocalHalf', st.settings.ctxHalfLifeDays);
  const fillChk = (sel, v) => { const el = body.querySelector(sel); if (el) el.checked = v !== false; };
  fillChk('#ctxLocalCompress', st.settings.ctxCompress);
  fillChk('#ctxLocalRag', st.settings.ctxRag);

  body.querySelector('#ctxPreview').addEventListener('click', async e => {
    const hits = body.querySelector('#ctxHits');
    const q = body.querySelector('#ctxQuery').value.trim();
    hits.innerHTML = '<div class="tip">检索中…</div>';
    e.target.disabled = true;
    try {
      const r = await api('/api/conversations/' + S.conv.id + '/context/preview', { method: 'POST', body: { query: q } });
      if (!r.hits.length) {
        hits.innerHTML = `<div class="tip">没有命中（相关度阈值 ${r.minScore ?? 0.05}）：换几个词试试 —— 本地索引认词，不认近义词。</div>`;
      } else {
        hits.innerHTML = r.hits.map((h, i) => `
          <div class="ctx-hit">
            <div class="ctx-hit-head">
              <span class="ctx-hit-n">#${i + 1}</span>
              <span class="muted">第 ${h.from + 1}–${h.to + 1} 条 · ${h.ageDays} 天前 · 相关度 ${h.score}${h.source === 'archive' ? ' · 来自归档' : ''}</span>
              <span class="ctx-hit-w" title="时间权重：半衰期越长，老内容掉得越慢">权重 ${h.weight}</span>
            </div>
            <div class="ctx-hit-text">${esc(h.text)}</div>
          </div>`).join('');
      }
    } catch (err) {
      hits.innerHTML = `<div class="tip err">检索失败：${esc(err.message)}</div>`;
    } finally {
      e.target.disabled = false;
    }
  });

  body.addEventListener('click', async e => {
    const act0 = e.target.closest('[data-activate]');
    if (act0) {
      const [from, to] = act0.dataset.activate.split('|').map(Number);
      const k = act0.dataset.k;
      const box = body.querySelector('#ctxOriginal');
      box.classList.remove('hidden');
      box.innerHTML = `<div class="tip">取第 ${from + 1}–${to + 1} 条原文…</div>`;
      act0.disabled = true;
      try {
        const r = await api('/api/conversations/' + S.conv.id + '/context/activate', { method: 'POST', body: { from, to } });
        box.innerHTML = `<div class="ctx-record-head"><span class="ctx-hit-n">#${esc(k)}</span><span class="muted">第 ${r.from + 1}–${r.to + 1} 条原文 · ${fmtNum(r.chars)} 字</span></div><pre class="ctx-memory">${esc(r.text)}</pre>`;
      } catch (err) {
        box.innerHTML = `<div class="tip err">展开失败：${esc(err.message)}</div>`;
      } finally {
        act0.disabled = false;
      }
      return;
    }
    const x = e.target.closest('[data-x]');
    if (!x) return;
    const act = x.dataset.x;
    if (act === 'close') return close();
    x.disabled = true;
    try {
      if (act === 'compact') {
        toast('正在压缩，等它几秒…', 4000);
        await api('/api/conversations/' + S.conv.id + '/context/compact', { method: 'POST' });
        toast('压缩好了');
      } else if (act === 'consolidate') {
        toast('正在整合记忆…', 6000);
        const r = await api('/api/conversations/' + S.conv.id + '/context/consolidate', { method: 'POST' });
        if (r.skipped) toast('没有可整合的段（只有一段记忆，不用合并）', 5000);
        else toast(`整合好了：${fmtNum(r.before)} → ${fmtNum(r.after)} token${(r.forgotten && r.forgotten.length) ? `，${r.forgotten.length} 段只留关键词` : ''}`, 6000);
      } else if (act === 'reset') {
        await api('/api/conversations/' + S.conv.id + '/context/reset', { method: 'POST' });
        toast('记忆已清空');
      } else if (act === 'saveCtx') {
        const budget = body.querySelector('#ctxLocalBudget').value;
        const ctx = {
          ctxHotRatio: Number(body.querySelector('#ctxLocalHot').value),
          ctxTopK: Number(body.querySelector('#ctxLocalTopK').value),
          ctxHalfLifeDays: Number(body.querySelector('#ctxLocalHalf').value),
          ctxCompress: body.querySelector('#ctxLocalCompress').checked,
          ctxRag: body.querySelector('#ctxLocalRag').checked,
        };
        if (budget) ctx.ctxBudget = Number(budget);
        await api('/api/conversations/' + S.conv.id, { method: 'PATCH', body: { ctx } });
        toast('已保存到这个会话');
      } else if (act === 'resetCtx') {
        await api('/api/conversations/' + S.conv.id, { method: 'PATCH', body: { ctx: {} } });
        toast('已恢复跟随全局');
      }
      close();
      await refreshCtxBadge();
      openContextPanel();
    } catch (err) {
      x.disabled = false;
      const prefix = { compact: '压缩失败：', consolidate: '整合失败：', reset: '清空失败：', saveCtx: '保存失败：', resetCtx: '恢复失败：' }[act] || '出错了：';
      toast(prefix + err.message, 6000);
    }
  });
}

/* ------------------------------------------------------------------ 导入导出 */

/** 走 /api/import/zip：压缩包、单个文本文件都从这里进 */
async function importZipFile(file, name = file.name) {
  const buf = await file.arrayBuffer();
  const r = await fetch(`/api/import/zip?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buf,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `服务器返回 ${r.status}`);
  return data;
}

let dropDepth = 0;

// ---------------------------------------------------------------- 导入页（拖入 → 自识别 → 再落库）

const IMP = { queue: [], seq: 0 };

function humanSize(n) {
  const v = Number(n) || 0;
  if (v >= 1048576) return `${(v / 1048576).toFixed(1)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} B`;
}

function impTotalsText(p) {
  const t = p.totals || {};
  const bits = [];
  if (t.convs) bits.push(`${t.convs} 个对话`);
  if (t.messages) bits.push(`${t.messages.toLocaleString('zh-CN')} 条消息`);
  if (t.images) bits.push(`${t.images} 张图`);
  if (t.files) bits.push(`${t.files} 个附件`);
  if (t.skipped) bits.push(`跳过 ${t.skipped} 个文件`);
  return bits.join(' · ');
}

function impItemHtml(it) {
  const st = it.status;
  const cls = st === 'error' ? ' err' : st === 'done' ? ' done' : '';
  const name = esc(it.name);
  let meta = '';
  let prev = '';
  if (st === 'detecting') meta = '正在辨认…';
  else if (st === 'error') meta = `认不出来：${esc(it.error || '未知文件')}`;
  else if (st === 'done') meta = `已导入 ${it.result?.length || 0} 个对话`;
  else {
    const p = it.preview || {};
    meta = `${esc(p.label || p.kind || '文件')} · ${impTotalsText(p)}`;
    if (p.conversations?.length) {
      prev = p.conversations.slice(0, 3).map(c => `${esc(c.title)}（${c.count} 条）`).join('、')
        + (p.more ? ` 等 ${p.count} 个` : '');
    }
  }
  return `
    <div class="imp-item${cls}" data-id="${it.id}">
      <div class="imp-ico">${st === 'done' ? '✓' : st === 'error' ? '!' : '📦'}</div>
      <div class="imp-main">
        <div class="imp-name">${name}<span class="imp-size">${humanSize(it.size)}</span></div>
        <div class="imp-meta">${meta}</div>
        ${prev ? `<div class="imp-prev">${prev}</div>` : ''}
      </div>
      ${st === 'done' ? '' : '<button class="mini" data-x="rm" title="从列表移除">移除</button>'}
    </div>`;
}

function paintImpList(body) {
  const list = body.querySelector('#impList');
  if (!list) return;
  const ready = IMP.queue.filter(i => i.status === 'ready').length;
  const pending = IMP.queue.some(i => i.status === 'detecting');
  list.innerHTML = IMP.queue.length
    ? IMP.queue.map(impItemHtml).join('')
    : '<div class="imp-empty">还没东西。拖文件进来，或者点上面的「选择文件…」。</div>';
  const run = body.querySelector('#impRun');
  const clear = body.querySelector('#impClear');
  if (run) { run.disabled = !ready || pending || IMP.busy; run.textContent = IMP.busy ? '导入中…' : ready > 1 ? `开始导入 ${ready} 个` : '开始导入'; }
  if (clear) clear.disabled = !IMP.queue.length || IMP.busy;
  const hint = body.querySelector('#impHint');
  if (hint) {
    hint.textContent = pending ? '正在辨认文件…' : ready ? '确认没问题就点「开始导入」，同名会话会被替换。' : '';
  }
}

async function detectImpItem(it, body) {
  try {
    const buf = await it.file.arrayBuffer();
    const r = await fetch(`/api/import/preview?name=${encodeURIComponent(it.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buf,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `服务器返回 ${r.status}`);
    if (data.ok === false) throw new Error(data.error || '认不出来');
    it.preview = data;
    it.status = 'ready';
  } catch (e) {
    it.status = 'error';
    it.error = e.message;
  }
  if (S.view === 'import') paintImpList(body);
}

async function addImportFiles(files, body) {
  const list = Array.from(files || []);
  if (!list.length) return;
  if (S.view !== 'import') await openImportPage();
  const host = $('#pageBody .imp');
  const target = body || host;
  for (const f of list) {
    const it = { id: `imp${++IMP.seq}`, file: f, name: f.name, size: f.size, status: 'detecting' };
    IMP.queue.push(it);
    if (target) paintImpList(target);
    detectImpItem(it, target);
  }
  if (target) paintImpList(target);
}

async function runImport(body) {
  const ready = IMP.queue.filter(i => i.status === 'ready');
  if (!ready.length) return;
  IMP.busy = true;
  paintImpList(body);
  const imported = [];
  const problems = [];
  for (const it of ready) {
    it.status = 'detecting';
    paintImpList(body);
    try {
      const r = await importZipFile(it.file, it.name);
      it.status = 'done';
      it.result = r.imported || [];
      imported.push(...(r.imported || []));
      if (r.errors?.length) problems.push(`${it.name}：${r.errors[0]}`);
    } catch (e) {
      it.status = 'error';
      it.error = e.message;
      problems.push(`${it.name}：${e.message}`);
    }
    paintImpList(body);
  }
  IMP.busy = false;
  paintImpList(body);
  if (imported.length) {
    await refreshState();
    renderSidebar();
    toast(`导入完成：${imported.length} 个对话｜${imported.slice(0, 3).map(i => i.title).join('、')}`, 8000);
  } else {
    toast(`没有导入成功：${problems[0] || '换个文件试试'}`, 7000);
  }
  if (problems.length) toast(`有问题：${problems[0]}`, 7000);
}

async function openImportPage() {
  const html = `
    <div class="imp">
      <div class="imp-drop" id="impDrop">
        <div class="imp-drop-ico">
          <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3"/></svg>
        </div>
        <b>把文件拖到这里</b>
        <p>压缩包（DeepSeek 导出 / 对话 JSON 整包 / 任意资料包）、单个 .json / .md / .txt 都行。先认一遍，确认了再落库。</p>
        <button class="btn" id="impPick">选择文件…</button>
        <input type="file" id="impFile" class="hidden" multiple>
      </div>
      <div class="imp-list" id="impList"></div>
      <div class="imp-acts">
        <button class="btn" id="impRun" disabled>开始导入</button>
        <button class="btn ghost" id="impClear" disabled>清空</button>
        <span class="imp-hint" id="impHint"></span>
      </div>
      <div class="imp-tips">
        <b>它能认出什么</b>
        <ul>
          <li><span class="k">DeepSeek 官方导出包</span>含思考过程、引用、图片 —— 每个会话一条，图片落到 data/media</li>
          <li><span class="k">对话 JSON 整包</span>本应用导出的、或任意 <code>{ conversations: […] }</code> / 会话数组 —— 每段对话一条</li>
          <li><span class="k">普通资料压缩包</span>按顶层目录分 2–6 组，生成「资料包 · 目录名」对话，正文是文件清单 + 内容</li>
          <li><span class="k">单个 .md / .txt / .json</span>当成一份材料，生成一条对话</li>
        </ul>
        <p>限制：单包 ≤ 200 MB；文本类最多 60 个文件；单文件取前 6000 字、单会话累计 4 万字；图片/文档/二进制不会硬塞给模型。同名会话再次导入会替换旧的，不会叠两份。</p>
      </div>
    </div>`;
  const { body } = pageShell('导入对话', '先辨认，再落库；不认识的文件会直接告诉你为什么。', html, 'import');
  paintImpList(body);
  body.querySelector('#impDrop')?.addEventListener('click', (e) => {
    if (e.target.closest('#impPick')) return;
    body.querySelector('#impFile')?.click();
  });
  body.querySelector('#impPick')?.addEventListener('click', (e) => {
    e.stopPropagation();
    body.querySelector('#impFile')?.click();
  });
  body.querySelector('#impFile')?.addEventListener('change', async (e) => {
    const files = e.target.files;
    e.target.value = '';
    await addImportFiles(files, body);
  });
  body.addEventListener('click', async (e) => {
    const x = e.target.closest('[data-x]');
    if (!x) return;
    if (x.dataset.x === 'rm') {
      const card = x.closest('.imp-item');
      IMP.queue = IMP.queue.filter(i => i.id !== card?.dataset.id);
      paintImpList(body);
    }
  });
  body.querySelector('#impRun')?.addEventListener('click', () => runImport(body));
  body.querySelector('#impClear')?.addEventListener('click', () => { IMP.queue = []; paintImpList(body); });
  // 页面内的拖拽也接住（不然会被 window 的拖拽层吃掉）
  body.addEventListener('dragover', (e) => { e.preventDefault(); });
  body.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    e.stopPropagation();
    showDropZone(false);
    await addImportFiles(e.dataTransfer.files, body);
  });
  return { body };
}
const DROP_COPY = {
  attach: {
    title: '松手，加进这条消息',
    hint: '图片、PDF、Word、文本、音视频都行；对话包（zip）请去「导入」页整理',
  },
  import: {
    title: '松手，整理成对话',
    hint: '压缩包（DeepSeek 导出 / JSON 整包 / 任意资料包）、单个 JSON 或文本文件都行',
  },
};

function dropMode() {
  return S.view === 'import' ? 'import' : 'attach';
}

function showDropZone(on, mode = dropMode()) {
  const el = $('#dropZone');
  if (!el) return;
  const copy = DROP_COPY[mode] || DROP_COPY.attach;
  const title = el.querySelector('#dropTitle');
  const hint = el.querySelector('#dropHint');
  if (title) title.textContent = copy.title;
  if (hint) hint.textContent = copy.hint;
  el.dataset.mode = mode;
  el.classList.toggle('hidden', !on);
  el.setAttribute('aria-hidden', on ? 'false' : 'true');
}

/** 对话页拖入：当附件加进这条消息（不导入）。zip 当对话包，转去导入页 */
async function attachDropped(files) {
  const list = Array.from(files || []);
  if (!list.length) return;
  if (S.view !== 'chat') setView('chat');
  const bundles = list.filter(f => /\.zip$/i.test(f.name || ''));
  const rest = list.filter(f => !bundles.includes(f));
  for (const f of rest) await addAttachment(f);
  if (bundles.length) {
    toast(`「${bundles[0].name}」像对话包，交给「导入」页整理`, 5000);
    const page = await openImportPage();
    await addImportFiles(bundles, page && page.body);
  }
}

function initDropZone() {
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dropDepth += 1;
    showDropZone(true);
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dropDepth = Math.max(0, dropDepth - 1);
    if (!dropDepth) showDropZone(false);
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const mode = dropMode();
    dropDepth = 0;
    showDropZone(false);
    if (!e.dataTransfer?.files?.length) return;
    if (mode === 'import') addImportFiles(e.dataTransfer.files);
    else attachDropped(e.dataTransfer.files);
  });
  // Esc 关掉这层
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#dropZone')?.classList.contains('hidden')) showDropZone(false);
  });
}

function exportConversation(format) {
  if (!S.conv) return;
  const a = document.createElement('a');
  a.href = `/api/conversations/${S.conv.id}/export?format=${format}`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function copyWholeConversation() {
  if (!S.conv) return;
  const lines = [];
  for (const m of S.conv.messages) {
    if (m.role === 'user') lines.push('## 你\n\n' + m.content);
    else lines.push('## DeepSeek\n\n' + m.content);
  }
  await copyText(lines.join('\n\n'));
}

/* ------------------------------------------------------------------ 会话菜单 */

/* 退出应用：停掉本地服务，然后把窗口关掉（浏览器标签页里关不掉，只能提示） */
async function quitApp() {
  const ok = await confirmDialog('退出应用？', '会停掉后台的本地服务，窗口也一起关掉。数据都在本机，不受影响。', '退出');
  if (!ok) return;
  toast('正在退出…', 6000);
  try { await fetch('/api/shutdown', { method: 'POST' }); } catch {}
  setTimeout(() => { try { window.close(); } catch {} }, 400);
  setTimeout(() => {
    document.body.innerHTML = '<div style="display:flex;height:100vh;align-items:center;justify-content:center;font:15px/1.8 system-ui;color:#888;text-align:center">已经退出。<br>可以直接关掉这个窗口了。</div>';
  }, 1800);
}

function openConvMenu(id, x, y) {
  const c = S.conversations.find(v => v.id === id);
  if (!c) return;
  const items = [
    { label: '重命名', act: () => renameConversation(id) },
    { label: c.pinned ? '取消置顶' : '置顶', act: () => togglePin(id) },
    { sep: true },
    { label: '导出 Markdown', act: () => { if (S.conv && S.conv.id === id) exportConversation('md'); else toast('先打开这个对话'); } },
    { label: '导出 JSON', act: () => { if (S.conv && S.conv.id === id) exportConversation('json'); else toast('先打开这个对话'); } },
    { sep: true },
    { label: '删除对话', danger: true, act: () => deleteConversation(id) },
  ];
  openMenu(x, y, items);
}

async function renameConversation(id) {
  const c = S.conversations.find(v => v.id === id);
  if (!c) return;
  if (!S.conv || S.conv.id !== id) await openConversation(id);
  const title = $('#convTitle');
  title.contentEditable = 'true';
  title.focus();
  const range = document.createRange();
  range.selectNodeContents(title);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const finish = async save => {
    title.contentEditable = 'false';
    const next = title.textContent.trim();
    if (!save || !next) { title.textContent = c.title; return; }
    try {
      const data = await api('/api/conversations/' + id, { method: 'PATCH', body: { title: next } });
      S.conv = data.conversation;
      S.conversations = data.conversations;
      renderSidebar();
      updateTopbar();
    } catch (e) { toast('重命名失败：' + e.message); }
  };
  title.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  title.onblur = () => { if (title.contentEditable === 'true') finish(true); };
}

async function togglePin(id) {
  const c = S.conversations.find(v => v.id === id);
  if (!c) return;
  try {
    const data = await api('/api/conversations/' + id, { method: 'PATCH', body: { pinned: !c.pinned } });
    S.conversations = data.conversations;
    renderSidebar();
    toast(c.pinned ? '已取消置顶' : '已置顶');
  } catch (e) { toast('操作失败：' + e.message); }
}

async function deleteConversation(id) {
  const c = S.conversations.find(v => v.id === id);
  if (!c) return;
  const ok = await confirmDialog('删除这个对话？', `「${c.title}」里的 ${c.messageCount} 条消息会一起删掉，删了拿不回来。`, '删除');
  if (!ok) return;
  try {
    const data = await api('/api/conversations/' + id, { method: 'DELETE' });
    S.conversations = data.conversations;
    if (S.conv && S.conv.id === id) {
      S.conv = null;
      if (S.conversations[0]) await openConversation(S.conversations[0].id);
      else showWelcome();
    }
    renderSidebar();
    toast('已删除');
  } catch (e) { toast('删除失败：' + e.message); }
}

function openMenu(x, y, items) {
  const menu = $('#ctxMenu');
  menu.innerHTML = items.map((it, i) =>
    it.sep ? '<div class="sep"></div>'
      : `<button data-i="${i}"${it.danger ? ' class="danger"' : ''}>${esc(it.label)}</button>`
  ).join('');
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  menu.onclick = e => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    const it = items[Number(b.dataset.i)];
    closeMenu();
    it && it.act && it.act();
  };
}

function closeMenu() {
  $('#ctxMenu').classList.add('hidden');
  $('#ctxMenu').onclick = null;
}

/* ------------------------------------------------------------------ 搜索 */

const doSearch = debounce(async q => {
  q = q.trim();
  if (!q) { S.searchHits = null; renderSidebar(); return; }
  try {
    const r = await api('/api/search?q=' + encodeURIComponent(q));
    S.searchHits = r.hits;
    renderHits();
  } catch (e) { toast('搜索失败：' + e.message); }
}, 220);

function openSearch() {
  $('#searchBox').classList.remove('hidden');
  const input = $('#searchInput');
  input.focus();
  input.select();
}

function closeSearch() {
  $('#searchBox').classList.add('hidden');
  $('#searchInput').value = '';
  S.searchHits = null;
  renderSidebar();
}

/* ------------------------------------------------------------------ 移动端侧栏 */

function openSidebar() { document.querySelector('.app').classList.add('side-open'); }
function closeSidebar() {
  const app = document.querySelector('.app');
  app.classList.remove('side-open');
  if (window.innerWidth <= 860) app.classList.add('side-collapsed');
}

/* ------------------------------------------------------------------ 事件绑定 */

async function toggleSetting(key, on) {
  S.settings[key] = on;
  syncComposerMode();
  try { await api('/api/settings', { method: 'PUT', body: { [key]: on } }); } catch {}
}

function bindEvents() {
  $('#newChatBtn').addEventListener('click', () => showWelcome());
  $('#brandBtn').addEventListener('click', () => showWelcome());
  $('#collapseBtn').addEventListener('click', () => document.querySelector('.app').classList.toggle('side-collapsed'));
  $('#menuBtn').addEventListener('click', openSidebar);
  $('#backdrop').addEventListener('click', closeSidebar);

  $('#searchToggle').addEventListener('click', () => {
    if ($('#searchBox').classList.contains('hidden')) openSearch();
    else closeSearch();
  });
  $('#searchClose').addEventListener('click', closeSearch);
  $('#searchInput').addEventListener('input', e => doSearch(e.target.value));

  $('#convList').addEventListener('click', e => {
    const tuneBtn = e.target.closest('[data-tune]');
    if (tuneBtn) {
      e.stopPropagation();
      openTunePopover(tuneBtn.dataset.tune, tuneBtn);
      return;
    }
    const menuBtn = e.target.closest('[data-menu]');
    if (menuBtn) {
      e.stopPropagation();
      const r = menuBtn.getBoundingClientRect();
      openConvMenu(menuBtn.dataset.menu, r.right - 4, r.bottom + 4);
      return;
    }
    const hit = e.target.closest('.hit');
    if (hit) {
      const { conv, msg } = hit.dataset;
      closeSearch();
      openConversation(conv, { scrollTo: msg });
      return;
    }
    const item = e.target.closest('.conv-item');
    if (item) openConversation(item.dataset.id);
  });

  $('#fileInput').addEventListener('change', e => {
    const files = e.target.files;
    e.target.value = '';
    addImportFiles(files);
  });

  $('#attachChip').addEventListener('click', () => $('#attachInput').click());
  $('#attachInput').addEventListener('change', e => {
    for (const f of Array.from(e.target.files || [])) addAttachment(f);
    e.target.value = '';
  });
  $('#attachBar').addEventListener('click', e => {
    const del = e.target.closest('[data-att]');
    if (!del) return;
    const idx = Number(del.dataset.att);
    const entry = S.attachments[idx];
    if (entry && entry.abort) entry.abort.abort();   // 解析中的视频/音频：× 直接中止请求
    S.attachments.splice(idx, 1);
    renderAttachBar();
    applySendState();
  });

  $('#settingsBtn').addEventListener('click', openSettings);
  document.querySelectorAll('[data-open-settings]').forEach(b => b.addEventListener('click', openSettings));

  // 左下角：一行图标，点箭头展开成带名字的（记在 localStorage，下次还这样）
  const foot = $('#sideFoot');
  const footMore = $('#footMore');
  const setFootOpen = (open) => {
    foot.classList.toggle('expanded', open);
    footMore.setAttribute('aria-expanded', open ? 'true' : 'false');
    footMore.title = open ? '收起（只留图标）' : '展开（显示名字）';
    try { localStorage.setItem('dsh.sideFootExpanded', open ? '1' : '0'); } catch {}
  };
  try { if (localStorage.getItem('dsh.sideFootExpanded') === '1') setFootOpen(true); } catch {}
  footMore.addEventListener('click', () => setFootOpen(!foot.classList.contains('expanded')));

  $('#clockBtn').addEventListener('click', openDayPage);
  $('#qqNavBtn').addEventListener('click', openQqPage);
  $('#pluginsBtn').addEventListener('click', openPluginsPage);
  $('#importNavBtn').addEventListener('click', openImportPage);
  $('#skillsNavBtn').addEventListener('click', openSkillsPage);
$('#learnNavBtn').addEventListener('click', openLearnPage);
  $('#pageBack').addEventListener('click', () => setView('chat'));
  $('#pageBackBtn').addEventListener('click', () => setView('chat'));

  $('#input').addEventListener('input', () => { autoGrow(); applySendState(); });
  $('#input').addEventListener('keydown', onInputKeydown);
  $('#input').addEventListener('paste', e => {
    const items = Array.from((e.clipboardData && e.clipboardData.files) || []);
    const imgs = items.filter(f => /^image\//.test(f.type));
    if (imgs.length) {
      e.preventDefault();
      for (const f of imgs) addAttachment(f);
    }
  });
  $('#sendBtn').addEventListener('click', () => {
    if (S.streaming) return stopGeneration();
    const text = $('#input').value.trim();
    if (text || S.attachments.some(a => !a.uploading)) sendMessage({ mode: 'send', content: text });
  });

  $('#thinkChip').addEventListener('click', async () => {
    const next = !(S.settings.thinking !== false);
    await toggleSetting('thinking', next);
    toast(next ? '深度思考：开' : '深度思考：关', 1400);
    $('#input').focus();
  });
  $('#hybridChip').addEventListener('click', async () => {
    const turningOn = S.settings.hybridMode !== true;
    if (turningOn && S.attachments.some(a => !a.uploading)) {
      toast('带附件时只有 V4.1 Flash 能看，混合模式这条走不了；先移除附件再开', 4200);
      return;
    }
    await toggleSetting('hybridMode', turningOn);
    toast(turningOn ? '混合模式：开（Flash 起草 → Pro 写正文）' : '混合模式：关', 2200);
    $('#input').focus();
  });
  $('#webChip').addEventListener('click', async () => {
    const next = !S.settings.webSearch;
    await toggleSetting('webSearch', next);
    toast(next ? '联网搜索：开（提问里贴链接会去读）' : '联网搜索：关', 1800);
    $('#input').focus();
  });
  $('#effortSel').addEventListener('change', async e => {
    const v = e.target.value;
    S.settings.reasoningEffort = v;
    try { await api('/api/settings', { method: 'PUT', body: { reasoningEffort: v } }); } catch {}
    toast('思考强度：' + effortLabel(v), 1400);
  });
  $('#micChip').addEventListener('click', toggleRecord);

  $('#ctxBadge').addEventListener('click', openContextPanel);

  $('#voiceSel').addEventListener('change', async e => {
    if (!S.conv) return;
    const v = e.currentTarget.value;
    try {
      const r = await api(`/api/conversations/${S.conv.id}`, { method: 'PATCH', body: { replyStyle: v } });
      if (r && r.conversation) S.conv.replyStyle = r.conversation.replyStyle;
      if (!v) delete S.conv.replyStyle;
      syncComposerMode();
      toast(v ? `这个会话改口径：${voiceLabel(v)}` : '这个会话改回跟随设置', 1800);
    } catch (err) {
      toast('改口径失败：' + err.message, 4000);
    }
  });

  $('#modelBtn').addEventListener('click', e => {    const r = e.currentTarget.getBoundingClientRect();
    const cur = currentModel();
    const items = [{ label: `${cur === 'auto' ? '✓ ' : ''}自动（按内容路由）`, act: () => switchModel('auto') }, { sep: true }];
    for (const m of (S.models.length ? S.models : [{ id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash', note: '' }])) {
      items.push({
        label: `${m.id === cur ? '✓ ' : ''}${m.label}${m.note ? ' · ' + m.note : ''}`,
        act: () => switchModel(m.id),
      });
    }
    items.push({ sep: true }, { label: '打开设置…', act: openSettings });
    openMenu(r.right - 240, r.bottom + 6, items);
  });

  $('#moreBtn').addEventListener('click', e => {
    const r = e.currentTarget.getBoundingClientRect();
    const items = [
      { label: '重命名对话', act: () => S.conv && renameConversation(S.conv.id) },
      { label: S.conv && S.conv.pinned ? '取消置顶' : '置顶对话', act: () => S.conv && togglePin(S.conv.id) },
      { sep: true },
      { label: '导出 Markdown', act: () => exportConversation('md') },
      { label: '导出 JSON', act: () => exportConversation('json') },
      { label: '复制整段对话', act: copyWholeConversation },
      { sep: true },
      { label: '上下文与记忆…', act: openContextPanel },
      { label: '设置…', act: openSettings },
      { label: '删除对话', danger: true, act: () => S.conv && deleteConversation(S.conv.id) },
      { sep: true },
      { label: '退出应用（关掉后台服务）', danger: true, act: quitApp },
    ];
    openMenu(r.right - 180, r.bottom + 6, items);
  });

  // 消息区事件代理
  $('#messages').addEventListener('click', e => {
    const copyBtn = e.target.closest('.code-copy');
    if (copyBtn) {
      const code = copyBtn.closest('.code-block').querySelector('code');
      copyText(code.textContent);
      copyBtn.textContent = '已复制';
      setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
      return;
    }
    const act = e.target.closest('.act');
    if (!act) return;
    const msgEl = act.closest('.msg');
    if (!msgEl) return;
    const id = msgEl.dataset.id;
    const m = findMessage(id);
    if (!m) return;
    const kind = act.dataset.act;
    if (kind === 'copy') return copyText(m.content || '');
    if (kind === 'delete') return deleteMessage(id);
    if (kind === 'edit') return startEditMessage(id);
    if (kind === 'fork') return forkFrom(id);
    if (kind === 'speak') return speakMessage(m);
    if (kind === 'regenerate') {
      if (S.streaming) return;
      sendMessage({ mode: 'regenerate' });
    }
    if (kind === 'continue') {
      if (S.streaming) return;
      sendMessage({ mode: 'continue' });
    }
  });

  $('#welcomeCards').addEventListener('click', e => {
    const card = e.target.closest('.card');
    if (!card) return;
    const input = $('#input');
    input.value = card.dataset.prompt || '';
    autoGrow();
    applySendState();
    input.focus();
  });

  $('#scroller').addEventListener('scroll', () => {
    $('#topbar').classList.toggle('scrolled', $('#scroller').scrollTop > 8);
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#ctxMenu') && !e.target.closest('#moreBtn') && !e.target.closest('[data-menu]') && !e.target.closest('#modelBtn')) closeMenu();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeMenu();
      stopAudio();
      if (S.recorder) { try { S.recorder.stop(); } catch {} }
      if (S.modalOpen) { const masks = $$('.modal-mask'); if (masks.length) masks[masks.length - 1].remove(); S.modalOpen = false; }
      if (S.view && S.view !== 'chat' && !S.modalOpen) setView('chat');
      if (!$('#searchBox').classList.contains('hidden')) closeSearch();
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openSearch();
    }
  });

  window.addEventListener('hashchange', () => {
    const id = (location.hash.match(/^#c\/(.+)$/) || [])[1];
    if (id && (!S.conv || S.conv.id !== id)) openConversation(id);
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (S.theme === 'auto') applyTheme('auto');
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 860) document.querySelector('.app').classList.remove('side-open', 'side-collapsed');
  });
}

async function switchModel(model) {
  if (S.conv) {
    try {
      const data = await api('/api/conversations/' + S.conv.id, { method: 'PATCH', body: { model } });
      S.conv = data.conversation;
    } catch {}
  }
  S.settings.model = model;
  syncComposerMode();
  toast('已切到 ' + modelLabel(model), 1600);
  try { await api('/api/settings', { method: 'PUT', body: { model } }); } catch {}
}

/* ------------------------------------------------------------------ 启动 */

async function boot() {
  bindEvents();
  const savedTheme = localStorage.getItem('dsapp-theme');
  applyTheme(savedTheme || 'auto');
  autoGrow();
  renderAttachBar();

  try {
    await refreshState();
  } catch (e) {
    toast('连不上本地服务：' + e.message, 6000);
    return;
  }
  // 本机没存过主题时，跟随服务端设置（换浏览器/清缓存后仍然是同一个主题）
  if (!savedTheme) applyTheme(S.settings.theme || 'auto');
  renderSidebar();

  const id = (location.hash.match(/^#c\/(.+)$/) || [])[1];
  if (id && S.conversations.some(c => c.id === id)) {
    await openConversation(id);
  } else if (S.conversations[0]) {
    await openConversation(S.conversations[0].id);
  } else {
    showWelcome();
  }
  // 首屏装配完毕的标记：DOM 测试（tools/dom-check.mjs 等）靠它避开时序竞争
  document.documentElement.dataset.ready = '1';
}

/* ------------------------------------------------------- 日历 · 时钟 · QQ */
const DAY = { tab: 'calendar', view: new Date(), selected: '', cal: null, qq: null, qqTimer: null };

const pad2 = n => String(n).padStart(2, '0');
const dayStrOf = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];
function humanDay(s) {
  if (!s) return '';
  const d = new Date(s + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return s;
  return `${d.getMonth() + 1}月${d.getDate()}日 周${WEEK_CN[d.getDay()]}`;
}
function clockNowText() {
  const d = new Date();
  return { hhmm: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`, ss: pad2(d.getSeconds()), day: dayStrOf(d) };
}
function tickClockMini() {
  const el = $('#clockText');
  if (!el) return;
  const { hhmm, day } = clockNowText();
  el.textContent = hhmm;
  const btn = $('#clockBtn');
  if (btn) btn.title = `${day} ${hhmm} · 日历 · 时钟 · QQ`;
}
setInterval(tickClockMini, 15000);

async function loadCalendarState() {
  DAY.cal = await api('/api/calendar');
  if (!DAY.selected) DAY.selected = DAY.cal.today;
  return DAY.cal;
}

/* ------------------------------------------------------------------ 整页视图 */

const VIEW_TITLES = {
  chat: '', day: '日历 · 时钟', qq: 'QQ 通道', plugins: '插件与通道', import: '导入对话', skills: '技能包', learn: '自学习', settings: '设置',
};

// 右下角吉祥物：点一下说句话，换页时让开
const MASCOT_LINES = [
  '这条对话存本机，不上云。',
  '长对话我会自己压摘要，别担心塞不下。',
  '想让它更专注？把「上下文预算」调小一点。',
  '日程写进日历，我每轮都会带上最近几天。',
  '带链接的问题，我会先自己打开念一遍。',
  '觉得我答得散，就把思考强度调到「最高」。',
];
function initMascot() {
  const el = document.getElementById('mascot');
  if (!el) return;
  const bubble = document.getElementById('mascotBubble');
  let i = Math.floor(Math.random() * MASCOT_LINES.length);
  let timer = null;
  el.addEventListener('click', () => {
    bubble.textContent = MASCOT_LINES[i % MASCOT_LINES.length];
    i += 1;
    bubble.classList.remove('hidden');
    clearTimeout(timer);
    timer = setTimeout(() => bubble.classList.add('hidden'), 4200);
  });
}

function setView(view) {
  if (view !== S.view && S.view === 'settings' && !leaveSavePage()) return;
  if (view !== 'settings') dropSaveGuard();
  const mascot = document.getElementById('mascot');
  if (mascot) mascot.classList.toggle('gone', view !== 'chat');
  S.view = view;
  $('#chatView').classList.toggle('hidden', view !== 'chat');
  $('#pageView').classList.toggle('hidden', view === 'chat');
  for (const [id, v] of [['clockBtn', 'day'], ['qqNavBtn', 'qq'], ['pluginsBtn', 'plugins'], ['importNavBtn', 'import'], ['skillsNavBtn', 'skills'], ['learnNavBtn', 'learn'], ['settingsBtn', 'settings']]) {
    $('#' + id)?.classList.toggle('on', view === v);
  }
  document.title = view === 'chat' ? 'DeepSeek Local' : `${VIEW_TITLES[view] || ''} · DeepSeek Local`;
  if (DAY.timer) { clearInterval(DAY.timer); DAY.timer = null; }
  if (DAY.liveTimer) { clearInterval(DAY.liveTimer); DAY.liveTimer = null; }
}

function pageShell(title, sub, html, viewKey) {
  setView(viewKey || 'chat');
  $('#pageTitle').textContent = title;
  $('#pageSub').textContent = sub || '';
  const body = $('#pageBody');
  body.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  if (html) wrap.innerHTML = html;
  body.appendChild(wrap);
  body.scrollTop = 0;
  const close = () => setView('chat');
  return { body: wrap, host: body, close };
}

async function openDayPage() {
  DAY.view = DAY.view || new Date();
  DAY.selected = DAY.selected || dayStrOf();
  const { body, close } = pageShell('日历 · 时钟', '日程只存这台机器（data/calendar.json）；开了「日程进上下文」的话模型也会知道。', null, 'day');
  const paint = () => { body.innerHTML = dayPageHtml(); };
  const refresh = async () => { await loadCalendarState(); paint(); };
  body.addEventListener('click', async e => {
    const x = e.target.closest('[data-x]');
    if (!x) return;
    const act = x.dataset.x;
    try {
      if (act === 'prevMonth') { DAY.view = new Date(DAY.view.getFullYear(), DAY.view.getMonth() - 1, 1); paint(); return; }
      if (act === 'nextMonth') { DAY.view = new Date(DAY.view.getFullYear(), DAY.view.getMonth() + 1, 1); paint(); return; }
      if (act === 'todayMonth') { DAY.view = new Date(); DAY.selected = dayStrOf(); paint(); return; }
      if (act === 'pickDay') { DAY.selected = x.dataset.date; paint(); return; }
      if (act === 'toggleNew') { DAY.newOpen = !DAY.newOpen; paint(); return; }
      if (act === 'addEvent') {
        const title = body.querySelector('#calTitle').value.trim();
        if (!title) { toast('先写个标题'); return; }
        await api('/api/calendar', {
          method: 'POST',
          body: {
            title,
            date: body.querySelector('#calDate').value || DAY.selected,
            time: body.querySelector('#calTime').value || '',
            end: body.querySelector('#calEnd').value || '',
            note: body.querySelector('#calNote').value.trim(),
            convId: S.conv?.id || '',
          },
        });
        DAY.selected = body.querySelector('#calDate').value || DAY.selected;
        DAY.newOpen = false;
        toast('加好了');
        await refresh();
        return;
      }
      if (act === 'delEvent') {
        await api('/api/calendar/' + x.dataset.id, { method: 'DELETE' });
        toast('删掉了');
        await refresh();
        return;
      }
      if (act === 'toggleDone') {
        const ev = DAY.cal.events.find(v => v.id === x.dataset.id);
        await api('/api/calendar/' + x.dataset.id, { method: 'PATCH', body: { done: !ev?.done } });
        await refresh();
        return;
      }
      if (act === 'askEvent') {
        const ev = DAY.cal.events.find(v => v.id === x.dataset.id);
        if (!ev) return;
        const q = `我这${ev.time ? '天 ' + ev.time + ' 有' : '天有'}个安排：「${ev.title}」${ev.note ? '，备注：' + ev.note : ''}。帮我${ev.time ? '倒推一下该几点准备、' : ''}提醒我需要注意什么。`;
        await sendMessage({ content: q });
        return;
      }
    } catch (err) {
      toast(err.message || String(err));
    }
  });
  await refresh();
  DAY.timer = setInterval(() => {
    const n = clockNowText();
    const big = body.querySelector('#clockBig');
    const sec = body.querySelector('#clockSec');
    if (big) big.textContent = n.hhmm;
    if (sec) sec.textContent = n.ss;
  }, 1000);
  close;
}

// 二维码文件多旧了（人话）
function qrAgeText(mtimeMs) {
  const mins = Math.max(1, Math.round((Date.now() - Number(mtimeMs || 0)) / 60000));
  if (!Number.isFinite(mins) || mins > 24 * 60 * 30) return '时间未知';
  if (mins < 60) return `${mins} 分钟前`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

// 二维码自动刷新的间隔：默认 2 分钟；调试可用 ?qrAuto=秒 覆盖
const QR_AUTO_SEC = (() => {
  const v = Number(new URLSearchParams(location.search).get('qrAuto'));
  return v > 0 ? v : 120;
})();

async function openQqPage() {
  const { body } = pageShell('QQ 通道', '走 OneBot 11 的 HTTP，跟 dsh-qq-bridge 同一个后端，但不经过 DSH 进程、也不读插件凭据。', null, 'qq');
  DAY.qrAutoMs = QR_AUTO_SEC * 1000;
  DAY.qrSeen = null;
  DAY.qrNextAt = 0;
  const load = async () => {
    DAY.qq = await api('/api/qq/state').catch(() => ({}));
    DAY.napcat = await api('/api/napcat').catch(() => ({}));
    // 隔离实例的目录配置从 /api/state 的设置里取（宿主 exe 由服务端自动找）
    const st = await api('/api/state').catch(() => null);
    if (st && st.settings) {
      DAY.napHostConf = { shell: st.settings.napcatShell || '', login: st.settings.napcatLogin || '' };
      DAY.pushConf = { enabled: st.settings.pushEnabled !== false, uid: st.settings.pushUid || '', heal: st.settings.napcatAutoHeal !== false };
    } else if (!DAY.napHostConf) {
      DAY.napHostConf = { shell: 'D:\\\\NapCatDSL\\\\Shell', login: '' };
    }
    if (DAY.napcat && DAY.napcat.qr) {
      DAY.qrSeen = { hash: DAY.napcat.qr.hash, at: DAY.napcat.servedAt || Date.now(), count: 1 };
      DAY.qrNextAt = Date.now() + DAY.qrAutoMs;
    }
  };
  const paintCountdown = () => {
    const el = body.querySelector('#qqQrCount');
    if (!el || !DAY.qrNextAt) return;
    const left = Math.max(0, Math.round((DAY.qrNextAt - Date.now()) / 1000));
    el.textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
  };
  // 只读二维码（轻接口），图变了才换 <img src>，顺手把登录态也核对一遍
  const refreshQr = async (manual = false) => {
    const r = await api('/api/napcat/qr').catch(() => null);
    DAY.qrNextAt = Date.now() + DAY.qrAutoMs;
    if (!r) { if (manual) toast('读二维码失败'); return; }
    const next = r.qr || null;
    const changed = !!next && (!DAY.qrSeen || DAY.qrSeen.hash !== next.hash);
    if (next) {
      DAY.napcat = { ...(DAY.napcat || {}), qr: next, dir: r.dir, exists: r.exists };
      DAY.qrSeen = {
        hash: next.hash,
        at: next.servedAt || Date.now(),
        count: changed ? (DAY.qrSeen ? DAY.qrSeen.count + 1 : 1) : (DAY.qrSeen ? DAY.qrSeen.count : 1),
      };
    }
    const img = body.querySelector('#qqQrImg');
    if (img && next) {
      if (changed || manual) img.src = next.dataUrl;
      img.dataset.hash = next.hash || '';
    }
    const meta = body.querySelector('#qqQrMeta');
    if (meta && DAY.qrSeen) {
      meta.innerHTML = `更新于 ${new Date(DAY.qrSeen.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${DAY.qrSeen.count > 1 ? `第 ${DAY.qrSeen.count} 次刷新` : '首次读到的码'} · 约每 ${Math.round(DAY.qrAutoMs / 1000)} 秒自动刷新（<span id="qqQrCount">--:--</span>）`;
      paintCountdown();
    }
    if (!img && (next || manual)) await paintShell(); // 之前没码，现在有码 / 手动刷新时结构变了就重画
    if (manual) {
      if (!next) toast('NapCat 还没出码：先点「启动 NapCat」');
      else if (changed) toast('换了张新码，扫这个');
      else if (!next.fresh) toast(`还是同一张码（${qrAgeText(next.mtime)}的）：NapCat 没在出新的，点「重启 NapCat 出新码」`, 4200);
      else toast('还是同一张码（这张是新的，NapCat 还没重新出码）');
    }
    // 顺手核对登录态：登录上了就把卡片换成账号
    const st = await api('/api/qq/state').catch(() => null);
    if (st) DAY.qq = st;
    const nap = await api('/api/napcat').catch(() => null);
    if (nap) {
      const wasLogin = !!(DAY.napcat && DAY.napcat.login && DAY.napcat.login.ok);
      DAY.napcat = nap;
      if (nap.login && nap.login.ok && !wasLogin) { await paintShell(); toast('NapCat 登录上了：' + (nap.login.nick || '')); }
    }
  };
  const paintShell = async () => {
    await load();
    body.innerHTML = qqPageHtml();
  };
  const paintLive = () => {
    const box = body.querySelector('#qqLive');
    if (box) box.innerHTML = qqLiveHtml();
    const now = body.querySelector('#qqBindNow');
    if (now) now.textContent = qqBindText(DAY.qq || {});
    paintCountdown();
  };
  const paintNapHost = (st) => {
    const box = body.querySelector('#napHostBox');
    if (!box) return;
    DAY.napHost = st || null;
    if (!st) { box.innerHTML = '还没读状态，点一下「刷新状态」。'; return; }
    if (st.ok === false && !st.running) {
      box.innerHTML = `<b style="color:var(--warn,#c07)">没跑起来</b> · ${esc(st.error || '宿主没返回状态')}`;
      return;
    }
    const bits = [];
    bits.push(st.running ? `<b style="color:var(--ok,#0a7)">实例在跑</b>（${esc(String(st.processCount || 0))} 个进程）` : '<b>没在跑</b>');
    bits.push(`端口 ${esc(String(st.httpPort || ''))}${st.httpUp ? ' 通' : ' 不通'}`);
    if (st.loggedIn) bits.push(`<b style="color:var(--ok,#0a7)">已登录</b>`);
    else if (st.qrExists) bits.push('等扫码');
    if (st.shell) bits.push(`shell ${esc(st.shell)}`);
    if (st.login) bits.push(`登录目录 ${esc(st.login)}`);
    box.innerHTML = bits.join(' · ');
    if (st.qr && st.qr.dataUrl && !st.loggedIn) {
      box.innerHTML += `<div class="qr-box" style="margin-top:10px"><img src="${st.qr.dataUrl}" alt="二维码" style="width:220px;height:220px;image-rendering:pixelated"><div class="muted">码会自己换，换了这里会跟着变（点「看二维码」再取一次）</div></div>`;
    }
  };
  const readNapHost = async () => {
    const st = await api('/api/napcat/host', { method: 'GET' }).catch(e => ({ ok: false, error: String(e.message || e) }));
    paintNapHost(st);
    return st;
  };
  body.addEventListener('click', async e => {
    const x = e.target.closest('[data-x]');
    if (!x) return;
    const act = x.dataset.x;
    try {
      if (act === 'napHostStatus') { await readNapHost(); return; }
      if (act === 'napHostQr') {
        const st = await readNapHost();
        if (!st || !st.qr) toast('还没有二维码（实例没起，或者已经登录过了）', 3200);
        return;
      }
      if (act === 'napHostStart' || act === 'napHostStop') {
        const verb = act === 'napHostStart' ? 'start' : 'stop';
        x.disabled = true;
        const old = x.textContent;
        x.textContent = verb === 'start' ? '启动中…' : '停止中…';
        try {
          const r = await api(`/api/napcat/host/${verb}`, { method: 'POST', body: {} }).catch(e => ({ ok: false, error: String(e.message || e) }));
          if (r.ok === false) toast((verb === 'start' ? '启动失败：' : '停止失败：') + (r.error || '未知原因'), 4200);
          else toast(verb === 'start' ? `已拉起（${r.processCount || 0} 个进程），等它出码` : `已停（${(r.killed || []).length} 个进程）`, 3600);
          await new Promise(r2 => setTimeout(r2, 1200));
          await readNapHost();
        } finally { x.disabled = false; x.textContent = old; }
        return;
      }
      if (act === 'napHostSave') {
        const shell = body.querySelector('#napShell').value.trim();
        const login = body.querySelector('#napLogin').value.trim();
        await api('/api/settings', { method: 'PUT', body: { napcatShell: shell || undefined, napcatLogin: login } });
        DAY.napHostConf = { shell, login };
        toast('存好了，下次启停就用这个目录', 3000);
        return;
      }
      if (act === 'napHealNow') {
        const box = body.querySelector('#napHealBox');
        x.disabled = true;
        if (box) box.textContent = '正在自检…';
        try {
          const r = await api('/api/napcat/heal', { method: 'POST', body: {} }).catch(e => ({ ok: false, error: String(e.message || e) }));
          const acts = (r && r.actions) || [];
          if (box) box.textContent = acts.length ? '这一轮修了：' + acts.join('；') : '这一轮没发现要修的东西';
          toast(acts.length ? '自动纠错：' + acts.join('；') : '一切正常，没动手', 4200);
          await readNapHost();
        } finally { x.disabled = false; }
        return;
      }
      if (act === 'pushSave') {
        const enabled = body.querySelector('#pushEnabled').value === '1';
        const uid = body.querySelector('#pushUid').value.trim();
        await api('/api/settings', { method: 'PUT', body: { pushEnabled: enabled, pushUid: uid } });
        DAY.pushConf = { ...(DAY.pushConf || {}), enabled, uid };
        toast(enabled ? '推送开着' + (uid ? `，推给 ${uid}` : '，推给回话那个号') : '推送关掉了，接口会拒绝', 3200);
        return;
      }
      if (act === 'pushTest') {
        const box = body.querySelector('#pushBox');
        x.disabled = true;
        if (box) box.textContent = '正在发…';
        try {
          const uid = body.querySelector('#pushUid').value.trim();
          const r = await api('/api/push', { method: 'POST', body: { text: '【测试】这条是 DeepSeek Local 主动推的，收到就说明推送权限通了。', uid } }).catch(e => ({ ok: false, error: String(e.message || e) }));
          if (r.ok === false) { if (box) box.textContent = '没发出去：' + (r.error || '未知原因'); toast('推送失败：' + (r.error || ''), 4200); }
          else { if (box) box.textContent = `已推送（${r.to === 'group' ? '群 ' + r.group : '私聊 ' + r.uid}）· messageId ${r.messageId || '-'}`; toast('推过去了', 3000); }
        } finally { x.disabled = false; }
        return;
      }
      if (act === 'pushDesktop') {
        if (!('Notification' in window)) { toast('这个浏览器不支持桌面通知', 3200); return; }
        const p = await Notification.requestPermission();
        const box = body.querySelector('#pushBox');
        if (box) box.textContent = p === 'granted' ? '桌面通知已授权：有 QQ 消息进来会弹一下。' : '桌面通知没拿到许可（' + p + '）。';
        toast(p === 'granted' ? '桌面通知开好了' : '没给权限，桌面通知用不了', 3200);
        return;
      }
      if (act === 'napStart') {
        const r = await api('/api/napcat/start', { method: 'POST', body: {} });
        toast('已拉起 NapCat：' + (r.launcher || '') + '（等它出码，二维码每 2 分钟自动刷）', 3200);
        await new Promise(r => setTimeout(r, 2500));
        await paintShell();
        DAY.qrNextAt = Date.now() + DAY.qrAutoMs;
        return;
      }
      if (act === 'napRefresh') {
        x.disabled = true;
        const oldLabel = x.textContent;
        x.textContent = '读取中…';
        try { await refreshQr(true); } finally { x.disabled = false; x.textContent = oldLabel; }
        return;
      }
      if (act === 'napRestart') {
        x.disabled = true;
        const oldLabel = x.textContent;
        x.textContent = '重启中…（最多 60 秒）';
        toast('正在重启 NapCat，等它出一张新码…（会先断开当前登录）', 5000);
        try {
          const r = await api('/api/napcat/restart', { method: 'POST', body: {} }).catch(e => ({ ok: false, error: String(e.message || e) }));
          if (r.ok === false) { toast('重启失败：' + (r.error || '未知原因'), 4200); return; }
          const before = DAY.qrSeen ? DAY.qrSeen.hash : '';
          let swapped = false;
          for (let i = 0; i < 8; i++) {
            await refreshQr(false);
            if (DAY.qrSeen && DAY.qrSeen.hash && DAY.qrSeen.hash !== before) { swapped = true; break; }
            await new Promise(r2 => setTimeout(r2, 1500));
          }
          if (r.killed && r.killed.length) console.log('停掉的 NapCat 进程:', r.killed.join(','));
          await paintShell();
          DAY.qrNextAt = Date.now() + DAY.qrAutoMs;
          toast(swapped ? '新码出来了，扫这个' : (r.ok ? `重启了（${r.waitedMs}ms），但还没看到新码——NapCat 可能在等窗口就绪，稍等再点「刷新二维码」` : '重启完成但没拿到码'), 5200);
        } finally { x.disabled = false; x.textContent = oldLabel; }
        return;
      }
      if (act === 'qqTest') {
        const r = await api('/api/qq/test', { method: 'POST', body: {} });
        toast(r.ok ? `连上了：${r.info?.nick || ''}（${r.info?.uid || ''}）` : '没连上：' + (r.error || ''));
        await paintShell();
        return;
      }
      if (act === 'qqPoll') {
        const r = await api('/api/qq/poll', { method: 'POST', body: {} });
        toast(r.skipped ? '跳过：' + r.skipped : `收到 ${r.fresh || 0} 条，回了 ${r.replied || 0} 条`);
        await paintShell();
        return;
      }
      if (act === 'qqImport') {
        const r = await api('/api/qq/import-config', { method: 'POST', body: {} });
        const f = r.found || {};
        toast(`读到：${f.baseUrl || '（没地址）'} / ${f.uid || '（没号）'}`);
        await api('/api/settings', { method: 'PUT', body: { qqBaseUrl: f.baseUrl || undefined, qqUid: f.uid || undefined, qqGroup: f.group || undefined, qqCallName: f.callName || undefined } });
        await paintShell();
        return;
      }
      if (act === 'qqBind') {
        const sel = body.querySelector('#qqConvSel');
        const r = await api('/api/qq/bind', { method: 'POST', body: { convId: sel ? sel.value : '' } });
        DAY.qq = r.status || DAY.qq;
        toast(`QQ 现在回话用「${(r.conv && r.conv.title) || '新会话'}」`, 4000);
        await paintShell();
        return;
      }
      if (act === 'qqNewConv') {
        x.disabled = true;
        const r = await api('/api/qq/bind', { method: 'POST', body: { convId: 'new' } });
        DAY.qq = r.status || DAY.qq;
        S.conversations = (await api('/api/state')).conversations;
        renderSidebar();
        toast(`新建并切到「${(r.conv && r.conv.title) || 'QQ'}」`, 4000);
        await paintShell();
        return;
      }
      if (act === 'qqOpenConv') {
        const conv = (DAY.qq || {}).conv;
        if (!conv || conv.missing) { toast('还没有绑定的会话'); return; }
        await openConversation(conv.id);
        setView('chat');
        return;
      }
      if (act === 'qqSave') {
        const sec = Math.max(2, Math.min(60, Number(body.querySelector('#qqPollSec').value) || 5));
        await api('/api/settings', {
          method: 'PUT',
          body: {
            qqMode: body.querySelector('#qqMode').value,
            qqBaseUrl: body.querySelector('#qqBase').value.trim(),
            qqUid: body.querySelector('#qqUid').value.trim(),
            qqGroup: body.querySelector('#qqGroup').value.trim(),
            qqPollMs: sec * 1000,
            qqCallName: body.querySelector('#qqCallName').value.trim() || '对方',
            qqNapCatDir: body.querySelector('#qqNapDir').value.trim(),
          },
        });
        S.settings = await api('/api/settings');
        toast('存好了，下一轮轮询就按新设置走');
        await paintShell();
        return;
      }
      if (act === 'qqSend') {
        const t = body.querySelector('#qqText').value.trim();
        if (!t) { toast('写点什么再发'); return; }
        await api('/api/qq/send', { method: 'POST', body: { text: t } });
        body.querySelector('#qqText').value = '';
        toast('发出去了');
        await paintShell();
        return;
      }
    } catch (err) {
      toast(err.message || String(err));
    }
  });
  body.addEventListener('keydown', async e => {
    if (e.target.id !== 'qqText') return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      body.querySelector('[data-x="qqSend"]')?.click();
    }
  });
  await paintShell();
  // 1 秒一次：刷倒计时；到点自动拉一次二维码（图变了才换）
  DAY.timer = setInterval(async () => {
    if (S.view !== 'qq') return;
    paintCountdown();
    if (DAY.qrNextAt && Date.now() >= DAY.qrNextAt) await refreshQr(false);
  }, 1000);
  // 5 秒一次：刷收发状态（不动二维码那张图），顺便把新进来的 QQ 消息弹成桌面通知
  DAY.liveTimer = setInterval(async () => {
    if (S.view !== 'qq') return;
    const prev = DAY.qq;
    DAY.qq = await api('/api/qq/state').catch(() => DAY.qq);
    const seenIds = DAY.notifiedIds || (DAY.notifiedIds = new Set());
    for (const m of (DAY.qq?.recent || [])) {
      if (m.dir !== 'in' || !m.messageId || seenIds.has(m.messageId)) continue;
      seenIds.add(m.messageId);
      // 只提醒「这一轮之后新到的」，避免打开页面时把历史弹一遍
      if (!m.at || Date.now() - new Date(m.at).getTime() > 60000) continue;
      try {
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification('QQ · ' + (m.nick || m.uid || '有人'), { body: String(m.text || '').slice(0, 120), tag: 'qq-' + m.messageId });
        }
      } catch { /* 通知失败不影响页面 */ }
    }
    if (prev && DAY.qq) paintLive();
    else paintLive();
  }, 5000);
}

// ---------------- 技能包页面（拖进来就装）
const SKILLS = { list: [], dir: '' };

function skillRowHtml(s) {
  const on = s.enabled ? 'checked' : '';
  return `<div class="sk-row" data-id="${esc(s.id)}">
    <label class="sk-main">
      <input type="checkbox" class="sk-toggle" data-id="${esc(s.id)}" ${on}>
      <span class="sk-text">
        <span class="sk-name">${esc(s.name || s.id)}</span>
        <span class="sk-desc">${esc(s.description || '（没写说明）')}</span>
        <span class="sk-meta">${esc(s.id)} · ${s.chars || 0} 字${s.files ? ` · ${s.files} 个文件` : ''}</span>
      </span>
    </label>
    <button class="btn ghost sk-del" data-x="skillDel" data-id="${esc(s.id)}" title="删掉这个技能">删除</button>
  </div>`;
}

function skillsListHtml() {
  if (!SKILLS.list.length) return '<div class="muted sk-empty">还没有技能。拖一个 SKILL.md 或 .zip 进来就装好了。</div>';
  return SKILLS.list.map(skillRowHtml).join('');
}

async function loadSkills() {
  try {
    const j = await api('/api/skills');
    SKILLS.list = Array.isArray(j.skills) ? j.skills : [];
    SKILLS.dir = j.dir || '';
  } catch {
    SKILLS.list = [];
  }
  return SKILLS.list;
}

function skillsPageHtml() {
  return `
    <div class="imp">
      <div class="imp-drop" id="skDrop">
        <div class="imp-drop-ico">
          <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A1.5 1.5 0 015.5 4H9l1.6 2H18.5A1.5 1.5 0 0120 7.5v11A1.5 1.5 0 0118.5 20h-13A1.5 1.5 0 014 18.5z"/><path d="M12 11v6"/><path d="M9 14h6"/></svg>
        </div>
        <b>把技能拖到这里</b>
        <p>一个 <code>SKILL.md</code>、装它的整个文件夹、或者打成 <code>.zip</code> 都行 —— 装完自动勾上。</p>
        <button class="btn" id="skPick">选择文件…</button>
        <input type="file" id="skFile" class="hidden" multiple>
      </div>
      <div class="sk-list" id="skList">${skillsListHtml()}</div>
      <div class="imp-tips">
        <b>装好之后</b>
        <ul>
          <li><span class="k">装在哪</span>skills/&lt;id&gt;／，一个文件夹一个技能，主文件必须叫 SKILL.md</li>
          <li><span class="k">怎么生效</span>勾上就每轮带一段 system；单技能最多 6000 字，超了截断</li>
          <li><span class="k">跟回复风格什么关系</span>两回事：活人感管怎么说，技能管说什么</li>
        </ul>
        <p>限制：单文件 ≤ 2 MB、一个技能总共 ≤ 24 MB；只收文本类（.md / .txt / .json / .js / .py / .csv / .yaml 等）。删技能不会碰你的对话。</p>
      </div>
    </div>`;
}

/** 把拖进来的条目（可能是文件夹）摊平成 {file, rel} */
async function walkSkillEntry(entry, prefix, out) {
  if (!entry) return;
  if (entry.isFile) {
    const f = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file: f, rel: (prefix || '') + entry.name });
    return;
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise(res => reader.readEntries(res, () => res([])));
      if (!batch.length) break;
      for (const en of batch) await walkSkillEntry(en, (prefix || '') + entry.name + '/', out);
    }
  }
}

async function postSkillBinary(file, name) {
  const res = await fetch('/api/skills/upload?name=' + encodeURIComponent(name), {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function uploadSkills(items) {
  if (!items.length) return null;
  if (items.length === 1) {
    const it = items[0];
    return postSkillBinary(it.file, it.rel.split('/').pop());
  }
  const fd = new FormData();
  for (const it of items) fd.append('files', it.file, it.rel);
  const res = await fetch('/api/skills/upload', { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------------------------------------------------------------- 自学习（群聊说话画像）
const LEARN = { gid: '', data: null, status: null };

function learnNum(v, digits = 1, unit = '') {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  const n = Number(v);
  return `${n.toFixed(digits)}${unit}`;
}
function learnPct(v) {
  if (v === null || v === undefined) return '—';
  return `${(Number(v) * 100).toFixed(0)}%`;
}
function learnMetric(label, value, hint = '') {
  return `<div class="lt-metric"><span class="lt-k">${esc(label)}</span><b class="lt-v">${esc(value)}</b>${hint ? `<i class="lt-h">${esc(hint)}</i>` : ''}</div>`;
}

function learnGraphSvg(d) {
  const nodes = (d.peopleTop || []).slice(0, 10);
  const edges = (d.graph && d.graph.edges) || [];
  if (nodes.length < 2) return '<p class="muted">人太少，画不出关系图（至少两个人互相说话才有边）。</p>';
  const W = 720, H = 300, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 52;
  const pos = new Map();
  nodes.forEach((n, i) => {
    const ang = (Math.PI * 2 * i) / nodes.length - Math.PI / 2;
    pos.set(n.uid, { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang), n });
  });
  const maxCount = Math.max(1, ...edges.map((e) => e.count || 1));
  const lines = edges.filter((e) => pos.has(e.from) && pos.has(e.to)).map((e) => {
    const a = pos.get(e.from), b = pos.get(e.to);
    const w = 1 + 4 * Math.sqrt((e.count || 1) / maxCount);
    const gapTxt = e.medianGapS ? `${Math.round(e.medianGapS)}s` : '';
    return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="var(--border-strong,#c9d1de)" stroke-width="${w.toFixed(2)}" opacity="0.55"><title>${esc(`${a.n.nick || a.n.uid} → ${b.n.nick || b.n.uid}：${e.count} 次，中位间隔 ${gapTxt}`)}</title></line>`;
  }).join('');
  const dots = nodes.map((n) => {
    const p = pos.get(n.uid);
    const r = 14 + Math.min(14, Math.sqrt((n.msgs || 1)) * 1.2);
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}" fill="var(--accent,#4c7df0)" opacity="0.16"></circle>`
      + `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="var(--accent,#4c7df0)"></circle>`
      + `<text x="${p.x.toFixed(1)}" y="${(p.y + r + 13).toFixed(1)}" text-anchor="middle" font-size="12" fill="var(--text-2,#5b6472)">${esc(n.nick || n.uid)}</text>`;
  }).join('');
  return `<svg class="lt-graph" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${lines}${dots}</svg>`;
}

function learnCurveSvg(d) {
  const series = d.series || [];
  if (series.length < 2) return '<p class="muted">消息还不够，情绪曲线先空着（每 25 条一个点）。</p>';
  const W = 720, H = 160, pad = 18;
  const ys = series.map((s) => Math.max(-3, Math.min(3, Number(s.mean) || 0)));
  const x = (i) => pad + (i * (W - pad * 2)) / Math.max(1, series.length - 1);
  const y = (v) => pad + ((3 - v) / 6) * (H - pad * 2);
  const pts = ys.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const zero = y(0).toFixed(1);
  const spikes = (d.sentiment && d.sentiment.spikes) || [];
  const dots = series.map((s, i) => {
    const v = Math.max(-3, Math.min(3, Number(s.mean) || 0));
    const hot = Math.abs(v) >= 1.2;
    return `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${hot ? 3.6 : 2.2}" fill="${hot ? 'var(--danger,#d9534f)' : 'var(--accent,#4c7df0)'}" opacity="${hot ? 0.95 : 0.6}"><title>${esc(`第 ${s.i} 条起 25 条，平均情绪 ${v}｜${s.label || ''}`)}</title></circle>`;
  }).join('');
  return `<svg class="lt-curve" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`
    + `<line x1="${pad}" y1="${zero}" x2="${W - pad}" y2="${zero}" stroke="var(--border,#e3e7ee)" stroke-dasharray="4 4"></line>`
    + `<polyline points="${pts}" fill="none" stroke="var(--accent,#4c7df0)" stroke-width="1.8"></polyline>${dots}</svg>`
    + `<p class="lt-note">每 25 条一个点，中线是 0；红点是这一段平均情绪绝对值 ≥1.2 的地方（${spikes.length} 个单条突变已单独统计）。</p>`;
}

function learnPageHtml() {
  return `
<div class="wrap">
  <div class="lt-panel">
    <div class="lt-head">
      <div>
        <h3>我自己怎么说话</h3>
        <p class="muted">只量你发出去的话——网页里打的字、QQ 上发来的消息。落在本机 <code>data/user-learn</code>，不出这台机器。</p>
      </div>
      <div class="lt-switches">
        <label class="switch-row"><span>对话里带上<small>让模型照着你的语感回</small></span><input type="checkbox" id="ltMeInject"></label>
      </div>
    </div>
    <div class="lt-actions">
      <button class="btn" data-x="ltMe">重新量一遍</button>
      <span class="muted" id="ltMeHint">正在读…</span>
    </div>
    <div id="ltMeBody"></div>
  </div>
  <div class="lt-panel">
    <div class="lt-head">
      <div>
        <h3>从群里学说话</h3>
        <p class="muted">只读群消息，落在本机 <code>data/qq-learn</code>；一个群一条 JSONL，按星期自动结算。数据和这个群本身的配置都不出这台机器。</p>
      </div>
      <div class="lt-switches">
        <label class="switch-row"><span>自动采集<small>10 分钟一轮</small></span><input type="checkbox" id="ltAuto"></label>
        <label class="switch-row"><span>对话里带上画像<small>绑了群号的会话</small></span><input type="checkbox" id="ltInject"></label>
      </div>
    </div>
    <div class="lt-actions">
      <button class="btn" data-x="ltGroups">刷新群列表</button>
      <button class="btn" data-x="ltIngest">抽一批消息</button>
      <button class="btn" data-x="ltSettle">结算本周</button>
      <span class="muted" id="ltHint">正在读…</span>
    </div>
    <div id="ltGroupList" class="lt-group-list"></div>
  </div>
  <div id="ltBody"></div>
</div>`;
}

async function openLearnPage() {
  const { body } = pageShell('自学习', '量两件事：我自己怎么说话（网页打的字 + QQ 消息），和这群人怎么说话（群聊语料）。', learnPageHtml(), 'learn');
  // 我自己怎么说话：单人语料，指标比群那套少，但多了「口头禅」这种只有一个人身上才成立的维度
  const paintMe = async () => {
    const host = body.querySelector('#ltMeBody');
    const hint = body.querySelector('#ltMeHint');
    const sw = body.querySelector('#ltMeInject');
    if (!host) return;
    const st = await api('/api/settings').catch(() => null);
    if (sw && st) sw.checked = st.meInject === true;
    const d = await api('/api/learn/me').catch((e) => ({ error: e.message }));
    if (d.error) { host.innerHTML = `<p class="muted">读失败：${esc(d.error)}</p>`; return; }
    if (d.empty) {
      if (hint) hint.textContent = '';
      host.innerHTML = `<p class="muted">${esc(d.hint || '还没有你自己发的消息。')}</p>`;
      return;
    }
    if (hint) hint.textContent = `${d.count} 条 · ${d.days} 天 · ${d.convs} 段对话${d.images ? ` · ${d.images} 张图` : ''}`;
    const tics = (d.phrases || []).map((p) => `<span class="lt-meme">${esc(p.phrase)} ×${p.count}</span>`).join('');
    const openers = (d.openers || []).map((o) => `「${esc(o.word)}」${o.count}`).join('、');
    const hours = (d.hours || []).join('、');
    host.innerHTML = `<div class="lt-metrics">${(d.metrics || []).map((m) => learnMetric(m.k, m.v, m.h)).join('')}</div>`
      + (tics ? `<div class="lt-memes"><span class="muted">常挂嘴边</span>${tics}</div>` : '')
      + (openers ? `<p class="lt-note">习惯这样开头：${openers}</p>` : '')
      + (hours ? `<p class="lt-note">常出没：${hours} 点</p>` : '');
  };
  const paintGroups = async () => {
    const st = await api('/api/learn/status');
    LEARN.status = st;
    const auto = body.querySelector('#ltAuto');
    const inj = body.querySelector('#ltInject');
    if (auto) auto.checked = st.auto !== false;
    if (inj) inj.checked = st.inject === true;
    const host = body.querySelector('#ltGroupList');
    if (!host) return;
    const list = st.store || [];
    if (!list.length) {
      host.innerHTML = '<p class="muted">还没有群。先点「刷新群列表」，要保证隔离实例在线、那个号在群里。</p>';
      const hint0 = body.querySelector('#ltHint');
      if (hint0) hint0.textContent = '共 0 个群';
      return;
    }
    const wanted = new Set(st.wanted || []);
    const cur = LEARN.gid || (st.wanted || [])[0] || '';
    host.innerHTML = list.map((g) => {
      const on = wanted.has(g.gid) || !(st.wanted || []).length;
      return `<div class="lt-group${cur === g.gid ? ' on' : ''}" data-gid="${esc(g.gid)}">
        <label class="lt-g-main"><input type="checkbox" class="lt-g-pick" value="${esc(g.gid)}" ${on ? 'checked' : ''}>
          <span class="lt-g-name">${esc(g.name || g.gid)}</span>
          <span class="lt-g-meta">${esc(g.gid)} · ${g.count} 条</span>
        </label>
        <button class="btn ghost" data-x="ltOpen" data-gid="${esc(g.gid)}">看这个群</button>
      </div>`;
    }).join('');
    const hint = body.querySelector('#ltHint');
    if (hint) {
      const s = st.state || {};
      hint.textContent = `共 ${list.length} 个群 · 已存 ${list.reduce((a, g) => a + (g.count || 0), 0)} 条`
        + (s.lastIngestAt ? ` · 上次采集 ${new Date(s.lastIngestAt).toLocaleTimeString()}` : ' · 还没采过')
        + (s.lastError ? ` · 上次出错：${s.lastError}` : '');
    }
  };
  const paintAnalysis = async (gid) => {
    const host = body.querySelector('#ltBody');
    if (!host) return;
    if (!gid) { host.innerHTML = '<div class="lt-panel"><p class="muted">先选一个群。</p></div>'; return; }
    host.innerHTML = '<div class="lt-panel"><p class="muted">算着…</p></div>';
    let d;
    try {
      d = await api(`/api/learn/analysis?gid=${encodeURIComponent(gid)}`);
    } catch (e) {
      host.innerHTML = `<div class="lt-panel"><p class="muted">读失败：${esc(e.message)}</p></div>`;
      return;
    }
    LEARN.gid = gid;
    LEARN.data = d;
    if (d.empty) {
      host.innerHTML = '<div class="lt-panel"><p class="muted">这个群还没采到消息。点上面「抽一批消息」。</p></div>';
      return;
    }
    const o = d.overall || {};
    const rh = d.rhythm || {};
    const at = (d.atBehavior || [])[0] || {};
    const base = typeof d.sentiment?.base === 'number' ? d.sentiment.base : null;
    const memes = (d.memes || []).slice(0, 12);
    const weeks = d.weeks || [];
    host.innerHTML = `
<div class="lt-panel">
  <h3>${esc(d.nick || d.gid)} <small class="muted">${d.count} 条 · ${d.people} 人 · 跨度 ${learnNum((d.spanS || 0) / 86400, 1, ' 天')}</small></h3>
  <div class="lt-metrics">
    ${learnMetric('句长中位', learnNum(o.charsMedian, 1, ' 字'))}
    ${learnMetric('短句占比', learnPct(o.shortRatio), '≤8 字')}
    ${learnMetric('语气词密度', learnNum(o.modalPer100, 2), '每 100 字')}
    ${learnMetric('省略主语', learnPct(o.proDropRatio))}
    ${learnMetric('不写句末标点', learnPct(o.noEndPunctRatio))}
    ${learnMetric('逗号密度', learnNum(o.commaPer100, 2), '每 100 字')}
    ${learnMetric('被引用', learnNum(o.replyPer100Msgs, 1), '每 100 条')}
    ${learnMetric('@ 后回复率', learnPct(at.replyRate), at.medianReplyS ? `中位 ${Math.round(at.medianReplyS)} 秒` : '')}
    ${learnMetric('接话间隔中位', learnNum(rh.gapMedianS, 0, ' 秒'))}
    ${learnMetric('平均情绪', learnNum(base, 2), '−3…3')}
  </div>
</div>
<div class="lt-panel">
  <h3>谁接谁的话</h3>
  <p class="muted">线越粗=接得越多；圆点越大=话越多。鼠标停上去看次数和中位间隔。</p>
  ${learnGraphSvg(d)}
</div>
<div class="lt-panel">
  <h3>情绪走势</h3>
  ${learnCurveSvg(d)}
</div>
<div class="lt-panel">
  <h3>在用的内部梗 <small class="muted">${memes.length} 个</small></h3>
  ${memes.length ? `<div class="lt-memes">${memes.map((m) => `<span class="lt-meme"><b>${esc(m.phrase)}</b><i>${m.count} 次 / ${m.senders} 人 / ${m.activeDays} 天</i></span>`).join('')}</div>` : '<p class="muted">还没形成稳定的梗（要出现 ≥5 次、≥3 个人在用）。</p>'}
</div>
<div class="lt-panel">
  <h3>周报 <small class="muted">自动结算</small></h3>
  ${weeks.length ? `<div class="lt-weeks">${weeks.map((w) => `<button class="btn ghost lt-week" data-week="${esc(w.week)}" data-gid="${esc(w.gid)}">${esc(w.week)} · ${w.msgs} 条${w.closed ? '' : '（进行中）'}</button>`).join('')}</div><pre class="lt-week-body" id="ltWeekBody"></pre>` : '<p class="muted">还没结算过。点上面「结算本周」。</p>'}
</div>`;
  };

  body.addEventListener('change', async (e) => {
    const t = e.target;
    if (!t || !t.id) return;
    if (t.id === 'ltAuto') {
      await api('/api/settings', { method: 'PUT', body: { learnAuto: !!t.checked } }).catch((err) => toast(err.message));
      toast(t.checked ? '自动采集开了' : '自动采集关了');
    }
    if (t.id === 'ltInject') {
      await api('/api/settings', { method: 'PUT', body: { learnInject: !!t.checked } }).catch((err) => toast(err.message));
      toast(t.checked ? '绑了群号的会话会带上这个群的画像' : '不再带画像');
    }
    if (t.id === 'ltMeInject') {
      await api('/api/settings', { method: 'PUT', body: { meInject: !!t.checked } }).catch((err) => toast(err.message));
      toast(t.checked ? '每条对话都会带上你说话的画像' : '不再带你说话的画像');
    }
  });
  body.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-x]');
    const week = e.target.closest('.lt-week');
    if (week) {
      const pre = body.querySelector('#ltWeekBody');
      pre.textContent = '读着…';
      try {
        const r = await api(`/api/learn/week?gid=${encodeURIComponent(week.dataset.gid)}&week=${encodeURIComponent(week.dataset.week)}`);
        pre.textContent = r.markdown || '';
      } catch (err) {
        pre.textContent = `读不到：${err.message}`;
      }
      return;
    }
    const grp = e.target.closest('.lt-group');
    if (btn && btn.dataset.x === 'ltOpen') {
      body.querySelectorAll('.lt-group').forEach((n) => n.classList.remove('on'));
      if (grp) grp.classList.add('on');
      await paintAnalysis(btn.dataset.gid);
      return;
    }
    if (!btn) return;
    const act = btn.dataset.x;
    if (act === 'ltMe') {
      btn.disabled = true;
      btn.textContent = '量着…';
      try {
        await api('/api/learn/me/refresh', { method: 'POST', body: {} });
        await paintMe();
        toast('重新量过了');
      } catch (err) {
        toast(`量失败：${err.message}`);
      } finally { btn.disabled = false; btn.textContent = '重新量一遍'; }
    }
    if (act === 'ltGroups') {
      btn.disabled = true;
      try {
        await api('/api/learn/groups', { method: 'POST', body: {} });
        await paintGroups();
        toast('群列表刷新了');
      } catch (err) {
        toast(`刷新失败：${err.message}`);
      } finally { btn.disabled = false; }
    }
    if (act === 'ltIngest') {
      btn.disabled = true;
      btn.textContent = '抽着…';
      try {
        const r = await api('/api/learn/ingest', { method: 'POST', body: {} });
        const added = (r.result || []).reduce((a, x) => a + (x.added || 0), 0);
        const bad = (r.result || []).find((x) => x.failed);
        toast(bad ? `抽到 ${added} 条，但出错了：${bad.failed}` : `抽到 ${added} 条新消息`);
        await paintGroups();
        if (LEARN.gid) await paintAnalysis(LEARN.gid);
      } catch (err) {
        toast(`抽取失败：${err.message}`);
      } finally { btn.disabled = false; btn.textContent = '抽一批消息'; }
    }
    if (act === 'ltSettle') {
      btn.disabled = true;
      try {
        const r = await api('/api/learn/settle', { method: 'POST', body: {} });
        toast(`结算了 ${(r.settled || []).length} 个周报`);
        if (LEARN.gid) await paintAnalysis(LEARN.gid);
      } catch (err) {
        toast(`结算失败：${err.message}`);
      } finally { btn.disabled = false; }
    }
  });

  await Promise.all([paintMe(), paintGroups()]);
  const firstGid = LEARN.gid || ((LEARN.status && LEARN.status.store && LEARN.status.store[0] && LEARN.status.store[0].gid) || '');
  LEARN.gid = firstGid;
  if (firstGid) await paintAnalysis(firstGid);
  else body.querySelector('#ltBody').innerHTML = '<div class="lt-panel"><p class="muted">还没有可看的群。</p></div>';
}

async function openSkillsPage() {
  const { body } = pageShell('技能包', '拖进来就装好；勾上的技能每轮对话都会带上（和回复风格是两回事）。', skillsPageHtml(), 'skills');
  const paint = () => {
    const host = body.querySelector('#skList');
    if (host) host.innerHTML = skillsListHtml();
  };
  await loadSkills();
  paint();

  const runUpload = async (items) => {
    try {
      toast('正在装…', 4000);
      const r = await uploadSkills(items);
      await loadSkills();
      paint();
      toast(r ? `装好了：${r.id}（${r.files} 个文件）` : '没东西可装');
    } catch (e) {
      toast('没装上：' + e.message, 5200);
    }
  };

  const collectDrop = async (dt) => {
    const entries = Array.from(dt.items || [])
      .map(i => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
      .filter(Boolean);
    const out = [];
    if (entries.length) for (const en of entries) await walkSkillEntry(en, '', out);
    if (!out.length) for (const f of Array.from(dt.files || [])) out.push({ file: f, rel: f.name });
    return out;
  };

  const dropEl = body.querySelector('#skDrop');
  const onDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropEl?.classList.remove('over');
    if (!e.dataTransfer) return;
    await runUpload(await collectDrop(e.dataTransfer));
  };
  const onOver = (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  };
  // 整页都接，别让全局拖放层抢
  body.addEventListener('dragover', onOver);
  body.addEventListener('drop', onDrop);
  if (dropEl) {
    dropEl.addEventListener('dragover', (e) => { onOver(e); dropEl.classList.add('over'); });
    dropEl.addEventListener('dragleave', () => dropEl.classList.remove('over'));
    dropEl.addEventListener('click', (e) => {
      if (e.target.closest('#skPick')) return;
      body.querySelector('#skFile')?.click();
    });
  }
  body.querySelector('#skPick')?.addEventListener('click', (e) => {
    e.stopPropagation();
    body.querySelector('#skFile')?.click();
  });
  body.querySelector('#skFile')?.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []).map(f => ({ file: f, rel: f.webkitRelativePath || f.name }));
    e.target.value = '';
    await runUpload(files);
  });

  body.addEventListener('change', async (e) => {
    const t = e.target.closest('.sk-toggle');
    if (!t) return;
    try {
      await api('/api/skills/enable', { method: 'POST', body: { id: t.dataset.id, enabled: t.checked } });
      await loadSkills();
      paint();
    } catch (err) {
      toast('改不动：' + err.message);
      await loadSkills();
      paint();
    }
  });

  body.addEventListener('click', async (e) => {
    const x = e.target.closest('[data-x="skillDel"]');
    if (!x) return;
    const id = x.dataset.id;
    if (!confirm(`删掉技能「${id}」？文件夹会从 skills/ 里删掉，对话不动。`)) return;
    try {
      await api('/api/skills/delete', { method: 'POST', body: { id } });
      await loadSkills();
      paint();
      toast(`删掉了：${id}`);
    } catch (err) {
      toast('删不掉：' + err.message);
    }
  });
}

async function openPluginsPage() {
  const { body, close } = pageShell('插件与通道', '这些是本应用自己的通道（不是 DSH 的插件），开关只管这里。', null, 'plugins');
  const paint = async () => {
    const ch = await api('/api/channels').catch(() => null);
    body.innerHTML = ch ? pluginsPageHtml(ch) : '<div class="sub">读不到通道状态。</div>';
  };
  body.addEventListener('change', async e => {
    const el = e.target.closest('[data-ch]');
    if (!el) return;
    const key = el.dataset.ch;
    const val = el.type === 'checkbox' ? el.checked : el.value;
    try {
      await api('/api/settings', { method: 'PUT', body: { [key]: val } });
      S.settings = await api('/api/settings');
      toast('改了：' + el.closest('.ch-item')?.querySelector('h5')?.textContent + ' → ' + (typeof val === 'boolean' ? (val ? '开' : '关') : val));
      await paint();
    } catch (err) {
      toast('改失败：' + err.message);
    }
  });
  body.addEventListener('click', async e => {
    const x = e.target.closest('[data-go]');
    if (!x) return;
    const go = x.dataset.go;
    if (go === 'day') openDayPage();
    else if (go === 'qq') openQqPage();
    else if (go === 'settings') openSettings();
    close;
  });
  await paint();
}

/* ---------------- 页面 HTML ---------------- */

function monthCells(view) {
  const y = view.getFullYear();
  const m = view.getMonth();
  const first = new Date(y, m, 1);
  const startPad = first.getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const prevDays = new Date(y, m, 0).getDate();
  const today = dayStrOf();
  const cells = [];
  for (let i = 0; i < 42; i++) {
    let dnum = i - startPad + 1;
    let mm = m, inMonth = true;
    if (dnum < 1) { mm = m - 1; dnum += prevDays; inMonth = false; }
    else if (dnum > daysInMonth) { mm = m + 1; dnum -= daysInMonth; inMonth = false; }
    const dd = new Date(y, mm, 1);
    const date = `${dd.getFullYear()}-${pad2(dd.getMonth() + 1)}-${pad2(dnum)}`;
    cells.push({ date, day: dnum, inMonth, isToday: date === today, weekday: dd.getDay() });
  }
  return cells;
}

function evItemHtml(e) {
  return `<div class="ev-item${e.done ? ' done' : ''}" data-id="${e.id}">
    <div class="t"><b>${e.time ? e.time + (e.end ? '–' + e.end : '') : '全天'}</b><span>${esc(e.title)}</span></div>
    ${e.note ? `<div class="note">${esc(e.note)}</div>` : ''}
    <div class="acts">
      <button class="mini" data-x="toggleDone" data-id="${e.id}">${e.done ? '标记未做' : '标记做完'}</button>
      <button class="mini" data-x="askEvent" data-id="${e.id}">在会话里问</button>
      <button class="mini" data-x="delEvent" data-id="${e.id}">删</button>
    </div>
  </div>`;
}

function calPaneHtml() {
  const cal = DAY.cal;
  const view = DAY.view;
  const sel = DAY.selected;
  const selEvents = cal.events.filter(e => e.date === sel);
  const grid = monthCells(view).map(c => {
    const dayEvents = cal.events.filter(e => e.date === c.date);
    return `<button class="cal-cell2${c.inMonth ? '' : ' out'}${c.isToday ? ' today' : ''}${c.date === sel ? ' sel' : ''}" data-x="pickDay" data-date="${c.date}">
      <span>${c.day}</span>${dayEvents.length ? `<span class="cal-dots2">${dayEvents.slice(0, 3).map(() => '<i></i>').join('')}</span>` : ''}
    </button>`;
  }).join('');
  const list = selEvents.length ? selEvents.map(evItemHtml).join('') : '<div class="sub">这天没有安排。</div>';
  const form = DAY.newOpen ? `
    <div class="cal-form">
      <div class="field"><label>标题</label><input id="calTitle" placeholder="例如：牙医 / 交周报" maxlength="120"></div>
      <div class="cal-form-row">
        <div class="field"><label>日期</label><input id="calDate" type="date" value="${sel}"></div>
        <div class="field"><label>开始</label><input id="calTime" type="time"></div>
        <div class="field"><label>结束</label><input id="calEnd" type="time"></div>
      </div>
      <div class="field"><label>备注</label><textarea id="calNote" rows="2" maxlength="500" placeholder="可选"></textarea></div>
      <div class="cal-form-foot"><button class="btn primary" data-x="addEvent">加到日历</button>
      <button class="btn" data-x="toggleNew">收起</button></div>
    </div>` : `<button class="btn primary" data-x="toggleNew">＋ 新建日程</button>`;
  return `<div class="card-block">
    <div class="cal-head2">
      <button class="mini" data-x="prevMonth">‹</button>
      <b>${view.getFullYear()} 年 ${view.getMonth() + 1} 月</b>
      <button class="mini" data-x="nextMonth">›</button>
      <span class="spacer"></span>
      <button class="mini" data-x="todayMonth">回到今天</button>
    </div>
    <div class="cal-grid2">${WEEK_CN.map(w => `<div class="cal-wd">${w}</div>`).join('')}${grid}</div>
    <div class="cal-sel-title">${humanDay(sel)}${sel === cal.today ? '（今天）' : ''}</div>
    <div class="ev-list">${list}</div>
    <div style="margin-top:12px">${form}</div>
  </div>`;
}

function clockPaneHtml() {
  const cal = DAY.cal;
  const n = clockNowText();
  const wd = new Date(cal.today + 'T00:00:00').getDay();
  const rest = cal.restOfDay.length ? cal.restOfDay.map(e => `
    <div class="ev-item"><div class="t"><b>${esc(e.time || '')}</b><span>${esc(e.title)}</span></div></div>`).join('')
    : '<div class="sub">今天剩下的时间空着。</div>';
  const week = cal.upcoming.length
    ? cal.upcoming.map(g => `<div style="margin-bottom:10px"><div class="cal-sel-title" style="margin:6px 0 6px">${humanDay(g.date)}</div>${g.items.map(e => `
        <div class="ev-item${e.done ? ' done' : ''}"><div class="t"><b>${esc(e.time || '全天')}</b><span>${esc(e.title)}</span></div></div>`).join('')}</div>`).join('')
    : '<div class="sub">接下来 7 天没有安排。</div>';
  return `<div class="card-block">
    <div class="clock-big2"><span id="clockBig">${n.hhmm}</span><span class="sec" id="clockSec">${n.ss}</span></div>
    <div class="clock-sub">${cal.today} · 周${WEEK_CN[wd]} · 今天 ${cal.todayEvents.length} 条安排</div>
  </div>
  <div class="card-block"><h4>今天还剩</h4><div class="ev-list">${rest}</div></div>
  <div class="card-block"><h4>接下来 7 天</h4>${week}</div>`;
}

function dayPageHtml() {
  return `<div class="day-grid"><div>${calPaneHtml()}</div><div>${clockPaneHtml()}</div></div>`;
}

function qqLiveHtml() {
  const q = DAY.qq || {};
  const nap = DAY.napcat || {};
  const login = nap.login && nap.login.ok;
  const pill = login ? '<span class="pill ok">已登录</span>'
    : nap.portOpen ? '<span class="pill warn">端口通了，没登录</span>'
      : nap.exists ? '<span class="pill off">NapCat 没起来</span>' : '<span class="pill off">没找到 NapCat</span>';
  const recent = (q.recent || []).slice().reverse().slice(0, 12).map(r => `
    <div class="qq-line2 ${r.dir || ''}">
      <span class="dir">${r.dir === 'in' ? '收' : r.dir === 'out' ? '发' : '!'}</span>
      <span>${new Date(r.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
      <span>${esc(String(r.text || '').slice(0, 160))}</span>
    </div>`).join('') || '<div class="sub">还没有收发记录。</div>';
  const qr = nap.qr && nap.qr.dataUrl;
  const qrSeen = DAY.qrSeen || null;
  const qrMeta = qrSeen
    ? `更新于 ${new Date(qrSeen.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${qrSeen.count > 1 ? `第 ${qrSeen.count} 次刷新` : '首次读到的码'} · 约每 ${Math.round(DAY.qrAutoMs / 1000)} 秒自动刷新（<span id="qqQrCount">--:--</span>）`
    : '';
  const qrBlock = login ? `
      <div class="card-block"><h4>登录状态</h4>
        <div class="kv"><span>账号</span><span>${esc(nap.login.nick || '')}（${esc(nap.login.uid || '')}）</span>
        <span>后端</span><span>${esc(nap.dir || '')} · 端口 ${esc(String(nap.port || ''))}</span></div>
      </div>` : qr ? `
      <div class="card-block"><h4>扫码登录</h4>
        <div class="qr-box"><img id="qqQrImg" data-hash="${esc((nap.qr && nap.qr.hash) || '')}" src="${qr}" alt="二维码">
          <div class="muted">用手机 QQ 扫这个码</div>
          ${nap.qr.fresh ? '' : `<div class="warn">这张码是 ${qrAgeText(nap.qr.mtime)}的，NapCat 没在出新码——扫码八成会失败。要么「刷新二维码」重新读一次，要么「重启 NapCat 出新码」（会先断开当前登录）。</div>`}
          ${qrMeta ? `<div class="muted" id="qqQrMeta">${qrMeta}</div>` : ''}
        </div>
        <div class="qq-acts qr-acts" style="margin-top:10px">
          <button class="mini" data-x="napRefresh">刷新二维码</button>
          <button class="mini" data-x="napRestart" title="杀掉 NapCat 再重跑启动脚本，逼它出一张新码（会断开当前登录）">重启 NapCat 出新码</button>
          <button class="mini" data-x="qqTest">检查是否已登录</button>
        </div>
      </div>` : `
      <div class="card-block"><h4>扫码登录</h4>
        <div class="sub">还没拿到二维码。先点「启动 NapCat」，等它弹出登录窗口（或在 ${esc(nap.dir || 'D:\\NapCatOneKey')} 里跑「扫码登录.bat」），出码后点「刷新二维码」。</div>
        <div class="qq-acts" style="margin-top:10px">
          <button class="btn primary" data-x="napStart">启动 NapCat</button>
          <button class="mini" data-x="napRefresh">刷新二维码</button>
        </div>
      </div>`;
  return `
    <div class="qq-top">
      <div class="card-block">
        <h4>连接状态 ${pill}</h4>
        <div class="kv">
          <span>模式</span><span>${q.mode === 'both' ? '收发（收进来跑一轮再回过去）' : q.mode === 'send' ? '只发' : '关着'}</span>
          <span>后端</span><span>${esc(q.baseUrl || '')} ${nap.portOpen ? '· 端口通' : '· 端口不通'}</span>
          <span>NapCat</span><span>${esc(nap.dir || '')} ${nap.exists ? '' : '（目录不存在）'}</span>
          <span>轮询</span><span>${(q.mode || 'off') === 'off' ? '关着（选「只发」或「收发」才开始）' : q.started ? '进行中' : '没在轮询'}${q.lastPollAt ? ' · 上次 ' + new Date(q.lastPollAt).toLocaleTimeString('zh-CN') : ''}</span>
          <span>记账</span><span>收到 ${q.received || 0} · 发出 ${q.sent || 0} · 已见 ${q.seen || 0}</span>
        </div>
        ${q.lastError ? `<div class="warn">${esc(q.lastError)}</div>` : ''}
        <div class="qq-acts" style="margin-top:10px">
          <button class="mini" data-x="qqTest">测试连接</button>
          <button class="mini" data-x="qqPoll">立刻收一次</button>
          <button class="mini" data-x="qqImport">从插件配置读地址</button>
        </div>
      </div>
      ${qrBlock}
    </div>
    <div class="card-block" style="margin-top:16px">
      <h4>收进来的消息</h4>
      <div class="qq-lines">${recent}</div>
    </div>`;
}

/** QQ 回话会话的选择项：'' = 自动新建；其余是现有对话 */
function qqConvOptions() {
  const q = DAY.qq || {};
  const cur = q.convId || '';
  const opt = (v, label) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  const list = S.conversations || [];
  const rows = list.map(c => {
    const bits = [`${c.messageCount || 0} 条`];
    if (c.source === 'qq') bits.push('QQ');
    return opt(c.id, `${c.title || '未命名'} · ${bits.join(' · ')}`);
  }).join('');
  return `${opt('', '（自动）新开一个 QQ 会话')}${rows}`;
}

function qqBindText(q) {
  const conv = (q || {}).conv;
  if (!conv) return '还没绑定：下一轮收到消息会自动新建一个「QQ」会话。';
  if (conv.missing) return '原来绑定的对话已经不在了，下一轮会自动新建一个。';
  return `现在往「${conv.title}」里说（${conv.messages || 0} 条消息）——换一个会接着那个对话的历史继续说。`;
}

function qqPageHtml() {
  const q = DAY.qq || {};
  const nap = DAY.napcat || {};
  const hasBound = !!(q.conv && !q.conv.missing);
  return `<div id="napHostCard" class="card-block" style="margin-top:16px">
      <h4>隔离实例（C++ 宿主）</h4>
      <p class="tip" style="margin:2px 0 10px">跟 DSH 那个 echo 实例完全分开：自己的 Shell 副本、自己的 QQ 号、自己的端口（OneBot ${esc(String(DAY.napHost?.httpPort || 3200))} / ${esc(String(DAY.napHost?.wsPort || 3201))}）。</p>
      <div id="napHostBox" class="tip">还没读状态，点一下「刷新状态」。</div>
      <div class="qq-form">
        <div class="field" style="grid-column:1/-1"><label>Shell 目录</label><input id="napShell" value="${esc(DAY.napHostConf?.shell || 'D:\\\\NapCatDSL\\\\Shell')}" placeholder="D:\\NapCatDSL\\Shell"></div>
        <div class="field" style="grid-column:1/-1"><label>登录目录（留空＝宿主默认 <exe 同级>\\login）</label><input id="napLogin" value="${esc(DAY.napHostConf?.login || '')}" placeholder="留空即可"></div>
      </div>
      <div class="cal-form-foot" style="margin-top:10px">
        <button class="btn primary" data-x="napHostStart" title="用 C++ 宿主拉起这份隔离实例（账号、端口都跟 DSH 不共用）">启动隔离实例</button>
        <button class="btn ghost" data-x="napHostStop" title="只停本实例的进程（按 Shell 目录 + 父链判定，不碰你自己的 QQ）">停止</button>
        <button class="btn ghost" data-x="napHostStatus">刷新状态</button>
        <button class="btn ghost" data-x="napHostQr">看二维码</button>
        <button class="btn ghost" data-x="napHostSave">保存目录</button>
        <button class="btn ghost" data-x="napHealNow" title="立刻跑一轮自检：缺 OneBot 配置就补、登录态坏了就重置并提示重扫">自动纠错</button>
      </div>
      <div class="tip" id="napHealBox" style="margin-top:8px">自动纠错：每 90 秒一轮，也可以在按钮上手动跑。</div>
    </div>
    <div id="pushCard" class="card-block" style="margin-top:16px">
      <h4>消息推送</h4>
      <p class="tip" style="margin:2px 0 10px">允许这台机器主动往你 QQ 推消息（提醒、自动纠错结论、任务完成）。关掉之后推送接口一律拒绝。</p>
      <div class="qq-form">
        <div class="field"><label>允许主动推送</label>
          <select id="pushEnabled">
            <option value="1"${DAY.pushConf?.enabled === false ? '' : ' selected'}>开着</option>
            <option value="0"${DAY.pushConf?.enabled === false ? ' selected' : ''}>关着</option>
          </select>
        </div>
        <div class="field"><label>推给谁（QQ 号，留空＝回话那个号）</label><input id="pushUid" value="${esc(DAY.pushConf?.uid || '')}" placeholder="留空＝用上面回话的号"></div>
      </div>
      <div class="cal-form-foot" style="margin-top:10px">
        <button class="btn primary" data-x="pushSave">保存推送设置</button>
        <button class="btn ghost" data-x="pushTest" title="往上面那个号发一条测试（走隔离实例的 OneBot）">发一条测试</button>
        <button class="btn ghost" data-x="pushDesktop" title="浏览器通知权限：有 QQ 消息进来时在桌面弹一下">授权桌面通知</button>
      </div>
      <div class="tip" id="pushBox" style="margin-top:8px">还没推过。</div>
    </div>
    <div id="qqLive">${qqLiveHtml()}</div>
    <div class="card-block" style="margin-top:16px">
      <h4>回话用哪个会话</h4>
      <p class="tip" style="margin:2px 0 10px">QQ 收进来的消息写进这个对话；模式选「收发」时，模型就在这个对话里接着答。</p>
      <div class="qq-form">
        <div class="field" style="grid-column:1/-1"><label>会话</label>
          <select id="qqConvSel">${qqConvOptions()}</select>
        </div>
      </div>
      <div class="cal-form-foot" style="margin-top:10px">
        <button class="btn primary" data-x="qqBind" title="把 QQ 的回话会话换成上面选中的这个">用它回话</button>
        <button class="btn ghost" data-x="qqNewConv" title="新建一个只给 QQ 用的对话，并把 QQ 切过去">新建 QQ 会话</button>
        <button class="btn ghost" data-x="qqOpenConv"${hasBound ? '' : ' disabled'} title="打开当前绑定的对话看看">打开这个会话</button>
      </div>
      <div class="tip" id="qqBindNow" style="margin-top:8px">${qqBindText(q)}</div>
    </div>
    <div class="card-block" style="margin-top:16px">
      <h4>设置</h4>
      <div class="qq-form">
        <div class="field"><label>模式</label>
          <select id="qqMode">
            <option value="off"${q.mode === 'off' ? ' selected' : ''}>关着</option>
            <option value="send"${q.mode === 'send' ? ' selected' : ''}>只发</option>
            <option value="both"${q.mode === 'both' ? ' selected' : ''}>收发（自动回话）</option>
          </select>
        </div>
        <div class="field"><label>NapCat 地址</label><input id="qqBase" value="${esc(q.baseUrl || 'http://127.0.0.1:3000')}" placeholder="http://127.0.0.1:3000"></div>
        <div class="field"><label>私聊 QQ 号</label><input id="qqUid" value="${esc(q.uid || '')}" placeholder="只填数字"></div>
        <div class="field"><label>群号（可选）</label><input id="qqGroup" value="${esc(q.group || '')}" placeholder="填了发群"></div>
        <div class="field"><label>轮询间隔（秒）</label><input id="qqPollSec" type="number" min="2" max="60" value="${Math.round((q.pollMs || 5000) / 1000)}"></div>
        <div class="field"><label>怎么称呼对方</label><input id="qqCallName" value="${esc(q.callName || '对方')}" maxlength="20"></div>
        <div class="field" style="grid-column:1/-1"><label>NapCat 目录</label><input id="qqNapDir" value="${esc(nap.dir || '')}" placeholder="D:\\NapCatOneKey"></div>
      </div>
      <div class="cal-form-foot" style="margin-top:10px"><button class="btn primary" data-x="qqSave" title="把 NapCat 地址、QQ 号、群号、轮询间隔和称呼写进本机 data/settings.json；下一轮轮询就按新设置走">保存 QQ 设置</button></div>
    </div>
    <div class="card-block" style="margin-top:16px">
      <h4>发一条</h4>
      <textarea id="qqText" class="input" rows="2" style="width:100%;border:1px solid var(--border);border-radius:10px;padding:9px 11px;background:var(--bg-soft)" placeholder="发到 QQ（回车发送 / Shift+回车换行）"></textarea>
      <div class="cal-form-foot" style="margin-top:8px"><button class="btn primary" data-x="qqSend">发送</button></div>
    </div>`;
}

function chRow({ title, desc, status, control, go, goLabel }) {
  return `<div class="ch-item">
    <div>
      <h5>${title}</h5>
      <div class="desc">${desc}</div>
      <div class="desc" style="margin-top:4px">${status}</div>
    </div>
    <div class="ctl">${control || ''}${go ? `<button class="mini" data-go="${go}">${goLabel || '打开'}</button>` : ''}</div>
  </div>`;
}

function pluginsPageHtml(ch) {
  const on = v => (v ? '<span class="pill ok">开</span>' : '<span class="pill off">关</span>');
  const q = ch.qq || {};
  const nap = q.napcat || {};
  const qqStatus = nap.login && nap.login.ok ? `已登录 ${esc(nap.login.nick || '')}` : nap.portOpen ? 'NapCat 端口通，未登录' : 'NapCat 未启动';
  const local = ch.local || {};
  return `<div class="ch-list">
    ${chRow({
      title: 'QQ 通道', desc: 'OneBot 11 HTTP。收发模式下会把 QQ 新消息接进来跑一轮再发回去。',
      status: `${on(q.mode !== 'off')} ${q.mode === 'both' ? '收发' : q.mode === 'send' ? '只发' : '关着'} · ${qqStatus} · 收到 ${q.received || 0} / 发出 ${q.sent || 0}`,
      control: `<select data-ch="qqMode" style="padding:6px 9px;border-radius:8px;border:1px solid var(--border);background:var(--bg-soft)">
        <option value="off"${q.mode === 'off' ? ' selected' : ''}>关</option>
        <option value="send"${q.mode === 'send' ? ' selected' : ''}>只发</option>
        <option value="both"${q.mode === 'both' ? ' selected' : ''}>收发</option>
      </select>`,
      go: 'qq', goLabel: '去 QQ 页',
    })}
    ${chRow({
      title: '日历 · 时钟', desc: '本机日程；开着「日程进上下文」时，每次请求会带最近几天的安排。',
      status: `${on(ch.calendar?.inContext)} 进上下文 · ${ch.calendar?.events || 0} 条日程（今天还剩 ${ch.calendar?.today || 0}）`,
      control: `<label style="display:flex;gap:6px;align-items:center;font-size:12.5px"><input type="checkbox" data-ch="calendarInContext"${ch.calendar?.inContext ? ' checked' : ''}> 进上下文</label>`,
      go: 'day', goLabel: '去日历页',
    })}
    ${chRow({
      title: '读链接', desc: 'API 的读链接工具读不到时，本机接着读：先抓 HTML，桌面版再用内嵌内核渲染。',
      status: `${on(ch.link?.local)} 本机预读 · 模式 ${esc(ch.link?.mode || 'auto')} · 内嵌内核 ${ch.link?.browser ? '可用' : '不可用'}`,
      control: `<label style="display:flex;gap:6px;align-items:center;font-size:12.5px"><input type="checkbox" data-ch="readLinkLocal"${ch.link?.local ? ' checked' : ''}> 本机预读</label>`,
      go: 'settings', goLabel: '去设置',
    })}
    ${chRow({
      title: '自动路由', desc: '按每条消息判意图：对话走 Pro、逻辑思考走 Flash、要成篇的先 Flash 出大纲再 Pro 写。',
      status: `${on(ch.route?.autoRoute)} ${ch.route?.autoRoute ? '生效中' : '关着（模型菜单里选「自动」时才生效）'}`,
      control: `<label style="display:flex;gap:6px;align-items:center;font-size:12.5px"><input type="checkbox" data-ch="autoRoute"${ch.route?.autoRoute ? ' checked' : ''}> 开启</label>`,
      go: 'settings', goLabel: '去设置',
    })}
    ${chRow({
      title: '上下文压缩与检索', desc: '超预算的老消息压成分档摘要，原文归档；历史片段按 BM25 + 时间衰减召回。',
      status: `预算 ${Math.round((ch.ctx?.budget || 0) / 1000)}k · 压缩 ${on(ch.ctx?.compress)} · 检索 ${on(ch.ctx?.rag)} · 摘要引擎 ${esc(ch.ctx?.summarizer || 'auto')}`,
      control: `<label style="display:flex;gap:6px;align-items:center;font-size:12.5px"><input type="checkbox" data-ch="ctxCompress"${ch.ctx?.compress ? ' checked' : ''}> 压缩</label>
        <label style="display:flex;gap:6px;align-items:center;font-size:12.5px"><input type="checkbox" data-ch="ctxRag"${ch.ctx?.rag ? ' checked' : ''}> 检索</label>`,
      go: 'settings', goLabel: '去设置',
    })}
    ${chRow({
      title: '本机小模型（ollama）', desc: '压缩摘要优先用本机小模型，失败再回落到 API；归档向量也靠它。',
      status: local.ok ? `在线 · ${local.models} 个模型 · 自动用 ${esc(local.chat || '—')}` : '没连上 127.0.0.1:11434',
      control: '', go: 'settings', goLabel: '去设置',
    })}
  </div>`;
}

/* ---------------- 侧栏「调」：就地改这个会话 ---------------- */

async function openTunePopover(id, anchor) {
  document.querySelectorAll('.tune-pop').forEach(el => el.remove());
  const conv = S.conversations.find(c => c.id === id);
  if (!conv) return;
  let detail = null;
  try { detail = await api('/api/conversations/' + id); } catch {}
  const c = detail?.conversation || {};
  const ctx = c.ctx || {};
  const models = S.models.length ? S.models : [{ id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash' }];
  const modelOpts = [{ id: 'auto', label: '自动（按内容路由）' }, ...models]
    .map(m => `<option value="${esc(m.id)}"${(c.model || '') === m.id ? ' selected' : ''}>${esc(m.label || m.id)}</option>`).join('');
  const budgets = [4000, 8000, 24000, 48000, 128000, 256000, 512000, 1000000];
  const curBudget = Number(ctx.budget) || 0;
  const budgetOpts = [`<option value="0"${!curBudget ? ' selected' : ''}>跟随全局</option>`]
    .concat(budgets.map(b => `<option value="${b}"${curBudget === b ? ' selected' : ''}>${b >= 1000000 ? '1M' : Math.round(b / 1000) + 'k'}</option>`)).join('');
  const pop = document.createElement('div');
  pop.className = 'tune-pop';
  pop.innerHTML = `
    <div style="font-weight:650;font-size:13.5px;margin-bottom:2px">调这个会话</div>
    <div class="desc" style="font-size:12px;color:var(--text-2)">不影响别的会话</div>
    <label>标题</label><input id="tuneTitle" value="${esc(c.title || '')}" maxlength="60">
    <label>模型</label><select id="tuneModel">${modelOpts}</select>
    <div class="row2">
      <div><label>上下文预算</label><select id="tuneBudget">${budgetOpts}</select></div>
      <div><label>召回条数</label><input id="tuneTopK" type="number" min="0" max="20" value="${ctx.topK ?? ''}" placeholder="跟随全局"></div>
    </div>
    <label>半衰期（天，空 = 跟随全局）</label><input id="tuneHalf" type="number" min="0.5" max="3650" step="0.5" value="${ctx.halfLifeDays ?? ''}">
    <div class="foot">
      <button class="btn" data-tune-act="cancel">取消</button>
      <button class="btn primary" data-tune-act="save">保存</button>
    </div>`;
  document.body.appendChild(pop);
  let r = anchor.getBoundingClientRect();
  if (!r.width || !r.height) {
    const item = anchor.closest('.conv-item') || anchor.parentElement;
    if (item) r = item.getBoundingClientRect();
  }
  pop.style.top = Math.max(8, Math.min(window.innerHeight - pop.offsetHeight - 12, r.top - 8)) + 'px';
  const preferRight = r.right + 10;
  const left = preferRight + pop.offsetWidth + 12 <= window.innerWidth ? preferRight : Math.max(8, window.innerWidth - pop.offsetWidth - 12);
  pop.style.left = left + 'px';
  const close = () => pop.remove();
  const onDoc = ev => { if (!pop.contains(ev.target) && !anchor.contains(ev.target)) { close(); document.removeEventListener('mousedown', onDoc); } };
  setTimeout(() => document.addEventListener('mousedown', onDoc), 0);
  pop.addEventListener('click', async e => {
    const b = e.target.closest('[data-tune-act]');
    if (!b) return;
    if (b.dataset.tuneAct === 'cancel') { close(); return; }
    try {
      const budget = Number(pop.querySelector('#tuneBudget').value) || 0;
      const topK = pop.querySelector('#tuneTopK').value.trim();
      const half = pop.querySelector('#tuneHalf').value.trim();
      const ctxPatch = {};
      if (budget) ctxPatch.budget = budget;
      if (topK !== '') ctxPatch.topK = Number(topK);
      if (half !== '') ctxPatch.halfLifeDays = Number(half);
      const body = { model: pop.querySelector('#tuneModel').value, title: pop.querySelector('#tuneTitle').value.trim() || '新对话' };
      if (Object.keys(ctxPatch).length) body.ctx = ctxPatch;
      else if (ctx.followGlobal) body.ctx = {};
      await api('/api/conversations/' + id, { method: 'PATCH', body });
      await refreshState();
      renderConversations();
      if (S.conv && S.conv.id === id) {
        S.conv = (await api('/api/conversations/' + id)).conversation;
        renderMessages();
        updateTopbar();
        refreshCtxBadge();
      }
      toast('改好了');
      close();
    } catch (err) {
      toast('改失败：' + err.message);
    }
  });
}

/* ---------------- 选中文字就能复制（不依赖 Ctrl+C） ---------------- */

function initSelectionCopy() {
  const bar = $('#selCopy');
  if (!bar) return;
  let selText = '';
  let hideTimer = 0;
  let offTimer = 0;

  const hide = () => {
    selText = '';
    bar.classList.add('hidden');
  };

  bar.addEventListener('mousedown', (e) => e.preventDefault());   // 别把选区弄丢
  bar.addEventListener('click', async () => {
    if (!selText) return;
    const text = selText;
    hide();
    await copyText(text);
  });

  const place = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return hide();
    const text = sel.toString();
    if (!text || !text.trim()) return hide();
    // 只在正文区域里浮出（输入框有自己的右键菜单，不需要这条）
    const node = sel.anchorNode;
    const box = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!box || !box.closest('#messages')) return hide();

    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return hide();
    // 选区滚出视口 → 不立刻收，先等 300ms：正文区加载完会自动平滑滚动，滚过去的瞬间不该把条子吞掉
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      clearTimeout(offTimer);
      offTimer = setTimeout(() => {
        const s2 = window.getSelection();
        if (!s2 || s2.isCollapsed) return hide();
        const r2 = s2.getRangeAt(0).getBoundingClientRect();
        if (r2.bottom < 0 || r2.top > window.innerHeight) hide();
        else place();
      }, 300);
      return;
    }
    selText = text;
    bar.classList.remove('hidden');
    const w = bar.offsetWidth || 56;
    const h = bar.offsetHeight || 30;
    const left = Math.min(window.innerWidth - w - 10, Math.max(10, rect.right - w));
    const top = rect.top - h - 8 < 8 ? rect.bottom + 8 : rect.top - h - 8;
    bar.style.left = `${Math.round(left)}px`;
    bar.style.top = `${Math.round(top)}px`;
  };

  document.addEventListener('selectionchange', () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(place, 120);
  });
  document.addEventListener('mousedown', (e) => {
    if (e.target !== bar) hide();
  }, true);
  // 滚动时跟着选区走，而不是一滚就没（正文区会自动平滑滚动到底部）
  // 注意：即便条子当前是隐藏的也要重算，否则选区被自动滚动带出视口后
  // 再也没有事件把它带回来（列表加载完的那 1~2 秒一直在滚）。
  let scrollRaf = 0;
  const onScroll = () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; place(); });
  };
  window.addEventListener('scroll', onScroll, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
}

/* ---------------- 悬停提示（圆角气泡） ---------------- */
// 系统那个 title 气泡是直角方块、还不可控；这里接管所有 [title] / [data-tip]：
// 悬停 300ms 弹圆角气泡，把 title 临时清空免得系统气泡跟着冒出来（文字留在 data-tip 里，
// 下次不用再读 DOM 属性）。
function initHoverTips() {
  const DELAY = 300;
  let tip = document.getElementById('hoverTip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'hoverTip';
    tip.className = 'hover-tip';
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
  }
  let cur = null;
  let timer = 0;
  let shown = false;
  const textOf = (el) => (el && el.dataset && el.dataset.tip) || (el && el.getAttribute('title')) || '';
  const pick = (node) => (node && node.closest ? node.closest('[title],[data-tip]') : null);
  function place(el) {
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const left = Math.min(window.innerWidth - tw - 8, Math.max(8, r.left + r.width / 2 - tw / 2));
    const above = r.top - th - 8;
    const top = above < 8 ? Math.min(window.innerHeight - th - 8, r.bottom + 8) : above;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }
  function hide() {
    if (timer) { clearTimeout(timer); timer = 0; }
    cur = null;
    shown = false;
    tip.classList.remove('on');
  }
  function show(el) {
    const text = textOf(el);
    if (!text) return;
    if (el.getAttribute('title')) { el.dataset.tip = text; el.setAttribute('title', ''); }
    tip.textContent = text;
    tip.style.left = '-9999px';
    tip.style.top = '0px';
    tip.classList.add('on');
    place(el);
    shown = true;
  }
  document.addEventListener('mouseover', (e) => {
    const el = pick(e.target);
    if (el === cur) return;
    hide();
    if (!el || !textOf(el)) return;
    cur = el;
    timer = setTimeout(() => { timer = 0; if (cur === el) show(el); }, DELAY);
  });
  document.addEventListener('mouseout', (e) => {
    const el = pick(e.target);
    if (!el || el !== cur) return;
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    hide();
  });
  document.addEventListener('focusin', (e) => { const el = pick(e.target); if (!el) return; cur = el; show(el); });
  document.addEventListener('focusout', hide);
  document.addEventListener('mousedown', hide, true);
  // 列表会在加载后自己滚一段，这里不能一滚就收起（那样永远弹不出来），改成跟着锚点重新定位
  window.addEventListener('scroll', () => { if (shown && cur) place(cur); }, true);
  window.addEventListener('resize', hide);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
}

/* ---------------- 导航与时钟 ---------------- */

function initClockButton() {
  tickClockMini();
}

initClockButton();
initMascot();
initDropZone();
initSelectionCopy();
initHoverTips();

boot();
