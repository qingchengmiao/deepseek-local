// 事件系统：从对话里认出「事件」，查它大概的时间，到点自己发一条。
//
// 三块能力，各自独立：
//   1) extract —— 把一段对话交给模型，让它只挑「有时间的、将来要发生的事」，输出结构化事件
//   2) lookup  —— 事件没说具体时间（「下个月那部片子」）就去网上查一下时间表，查不到就算了
//   3) tick    —— 每 30 秒看一遍，到点（提前 leadMin 分钟）就把提醒发出去，发过的不重发
//
// 设计上的取舍：
//   · 事件存磁盘（data/events.json），不存内存 —— 重启不能把「明天要提醒」丢了
//   · 只认真正有时间的事件；「他喜欢猫」这种不是事件，是画像，留给记忆系统
//   · 联网查时间表只做「补一个大概日期」，查不准就标 unknown 让人自己改，绝不编时间
//   · 发送走注入的 sendText，可以是 QQ，也可以是应用内推送

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const EXTRACT_SYSTEM = `你是一个只做一件事的抽取器：从对话里挑出「将来某个时间要发生的事」。

今天是 {{TODAY}}（{{WEEKDAY}}），时区 Asia/Shanghai。

日历（小模型容易把「下周三」算错，直接照这张表抄）：
{{CALENDAR}}

规则：
- 只输出确实带着时间的；「以后有空聊」「改天吧」这类不算。
- 时间必须换算成具体日期时间，用 YYYY-MM-DD HH:mm。换算月份天数时先想清楚，别算错。
- 相对日期按下面的口径算，不许凭印象：
  · 「今天」=今天；「明天」=今天+1 天；「后天」=今天+2 天；「大后天」=今天+3 天。
  · 「这周X」= 本周还没到的那天；如果今天已经过了周X，就指下周的周X。
  · 「下周X」= 下个自然周的周X（不是「七天后」）。
  · 「下个月X号」= 下个自然月的 X 号。
- 不知道几点就写 00:00。
- note 只写「这件事为什么重要」的一句话；不知道就写空字符串 ""，绝对不要把示例里的句子抄进去。
- 最多 5 条，宁缺勿滥。
- 只输出 JSON，不要解释，不要代码块围栏：
{"events":[{"title":"不超过 20 字","at":"YYYY-MM-DD HH:mm","note":""}]}
如果一条都没有：{"events":[]}`;

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
/** 模型很爱把示例里的占位句抄进 note，见到了就当没有 */
const NOTE_TEMPLATE = /^(为什么这件事重要|一句话说明|事件说明|说明)/;

/** 「下午三点」「十点半」这种只报时间的条目标题，是模型把时间词当成了事件，要丢掉 */
const TIME_ONLY = /^(上午|下午|晚上|中午|凌晨|早上|傍晚|夜里)?(零|一|二|三|四|五|六|七|八|九|十|十一|十二|\d{1,2})(点|时|:|：)(\d{1,2}分|半)?$/;

const CN_NUM = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12, 日: 0, 天: 0 };
function numOf(s) {
  if (/^\d+$/.test(s)) return Number(s);
  return Object.prototype.hasOwnProperty.call(CN_NUM, s) ? CN_NUM[s] : NaN;
}
function startOfWeekOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // 周一 = 0
  x.setDate(x.getDate() - dow);
  return x;
}
function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/**
 * 把「明天」「下周三」「12 月 3 号」这类相对日期就地换成 <日期:YYYY-MM-DD> 标记。
 *
 * 为什么不交给模型算：实测 qwen2.5-1.5b 就算把整张日历表喂进去，也会把「下周三」算成
 * 昨天（2026-11-25），还会把「下午三点」当成一个独立事件。所以日期由代码算，模型只负责
 * 认「这是什么事 + 几点」。返回 { text, dates }，dates 是去重后的日期锚点。
 */
export function resolveDates(text, now = new Date()) {
  const dates = [];
  let out = String(text || '');
  const mark = d => {
    const s = fmtLocal(d).slice(0, 10);
    if (!dates.includes(s)) dates.push(s);
    return `<日期:${s}>`;
  };
  // 年+月+日 / 月+日（带「号」「日」）
  out = out.replace(/(?:(\d{4})\s*年)?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g, (m, y, mo, da) => {
    const year = y ? Number(y) : now.getFullYear();
    const d = new Date(year, Number(mo) - 1, Number(da));
    return Number.isNaN(d.getTime()) ? m : mark(d);
  });
  // 下个月 X 号 / 这个月 X 号 / 单说 X 号
  out = out.replace(/(下个月|下下个月|这个月|本月)?\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[日号]/g, (m, pre, n) => {
    const day = numOf(n);
    if (!Number.isFinite(day) || day < 1 || day > 31) return m;
    let base = now;
    if (pre === '下个月') base = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    else if (pre === '下下个月') base = new Date(now.getFullYear(), now.getMonth() + 2, 1);
    const d = new Date(base.getFullYear(), base.getMonth(), day);
    if (Number.isNaN(d.getTime())) return m;
    // 只说「X 号」且已经过去，按下个月算
    if (!pre && d.getTime() < now.getTime() - 6 * 3600e3) d.setMonth(d.getMonth() + 1);
    return mark(d);
  });
  // 周X / 星期X / 礼拜X，可带 下周 / 下下周 / 这周
  out = out.replace(/(下下|下|这|本)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/g, (m, pre, w) => {
    const target = numOf(w);
    if (!Number.isFinite(target)) return m;
    const w0 = startOfWeekOf(now);
    const dowIdx = (target + 6) % 7; // 周一 = 0
    let base;
    if (pre === '下下') base = addDays(w0, 14);
    else if (pre === '下') base = addDays(w0, 7);
    else if (pre === '这' || pre === '本') base = w0;
    else {
      // 光说「周三」：本周这天还没过就是本周，过了就是下周
      const thisOne = addDays(w0, dowIdx);
      base = thisOne.getTime() >= now.getTime() - 6 * 3600e3 ? w0 : addDays(w0, 7);
    }
    return mark(addDays(base, dowIdx));
  });
  // 今天 / 明天 / 后天 / 大后天 / 昨天（长的放前面，免得「大后天」被「后天」吃掉）
  out = out.replace(/(大后天|后天|明天|今天|昨天)/g, m => {
    const off = { 大后天: 3, 后天: 2, 明天: 1, 今天: 0, 昨天: -1 }[m];
    return mark(addDays(now, off));
  });
  return { text: out, dates };
}

/**
 * 把「本周/下周每一天」算成具体日期给模型抄。
 * 1.5B 那种小模型自己算「下周三」必错（实测给出周日），所以不指望它，直接喂表。
 */
export function calendarHint(now) {
  const startOfWeek = d => {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dow = (x.getDay() + 6) % 7; // 周一 = 0
    x.setDate(x.getDate() - dow);
    return x;
  };
  const nameOf = d => fmtLocal(d).slice(0, 10);
  const line = (label, base) => {
    const parts = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
      parts.push(`${WEEKDAYS[d.getDay()].replace('星期', '周')} ${nameOf(d)}`);
    }
    return `${label}：${parts.join('、')}`;
  };
  const w0 = startOfWeek(now);
  const w1 = new Date(w0.getFullYear(), w0.getMonth(), w0.getDate() + 7);
  const w2 = new Date(w0.getFullYear(), w0.getMonth(), w0.getDate() + 14);
  const tom = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const d2 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
  const nextM = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return [
    line('本周', w0),
    line('下周', w1),
    line('下下周', w2),
    `明天 ${nameOf(tom)}、后天 ${nameOf(d2)}`,
    `下个月 1 号是 ${nameOf(nextM)}`,
  ].join('\n');
}

const pad = n => String(n).padStart(2, '0');
function fmtLocal(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function parseLocal(s) {
  const m = String(s || '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2}))?/);
  if (!m) return 0;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), 0, 0);
  return d.getTime() || 0;
}

/** 从模型输出里把 JSON 抠出来（它可能包着 ```json 围栏，也可能带两句废话） */
function pickJson(text) {
  const s = String(text || '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : s;
  const a = body.indexOf('{');
  const b = body.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(body.slice(a, b + 1)); } catch { return null; }
}

/**
 * deps: {
 *   dataDir, askModel({system,user}) -> {text}, sendText(text) -> id|null,
 *   appendToConv?(convId, text), convText?(convId, {limit}) -> string, settingsOf?() -> object, log?
 * }
 */
export function createEvents(deps) {
  const {
    dataDir,
    askModel,
    sendText,
    appendToConv = null,
    convText = null,
    settingsOf = async () => ({}),
    log = () => {},
  } = deps;

  const FILE = path.join(dataDir, 'events.json');
  let cache = null;

  async function load() {
    if (cache) return cache;
    try { cache = JSON.parse(await fsp.readFile(FILE, 'utf8')); } catch { cache = null; }
    if (!cache || typeof cache !== 'object') cache = { events: [], scans: [] };
    if (!Array.isArray(cache.events)) cache.events = [];
    if (!Array.isArray(cache.scans)) cache.scans = [];
    return cache;
  }

  async function save() {
    const c = await load();
    await fsp.mkdir(dataDir, { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(c, null, 1));
    await fsp.rename(tmp, FILE);
  }

  /** 事件对象的规范形：at 是毫秒时间戳，atText 是给人看的本地时间 */
  function normalize(raw, meta = {}) {
    const at = Number(raw.at) || parseLocal(raw.atText || raw.at);
    return {
      id: raw.id || 'ev_' + crypto.randomBytes(6).toString('base64url'),
      title: String(raw.title || '').slice(0, 60),
      at,
      atText: at ? fmtLocal(new Date(at)) : '',
      note: String(raw.note || '').slice(0, 200),
      source: raw.source || meta.source || 'chat',
      convId: raw.convId || meta.convId || '',
      status: raw.status || (at && at < Date.now() ? 'past' : 'open'),
      fired: raw.fired === true,
      firedAt: Number(raw.firedAt) || 0,
      createdAt: Number(raw.createdAt) || Date.now(),
      lookup: raw.lookup || null,
    };
  }

  async function list() {
    const c = await load();
    return c.events.slice().sort((a, b) => (a.at || 9e15) - (b.at || 9e15));
  }

  async function add(raw, meta) {
    const ev = normalize(raw, meta);
    if (!ev.title) throw new Error('事件标题不能为空');
    const c = await load();
    // 同一个标题 + 同一个时间就是同一件事，别重复记
    const dup = c.events.find(e => e.title === ev.title && Math.abs((e.at || 0) - (ev.at || 0)) < 60e3);
    if (dup) return dup;
    c.events.push(ev);
    c.events = c.events.slice(-500);
    await save();
    log(`[事件] 记下：${ev.title}${ev.atText ? ' @ ' + ev.atText : ''}`);
    return ev;
  }

  async function remove(id) {
    const c = await load();
    const i = c.events.findIndex(e => e.id === id);
    if (i < 0) return false;
    c.events.splice(i, 1);
    await save();
    return true;
  }

  async function setStatus(id, status) {
    const c = await load();
    const ev = c.events.find(e => e.id === id);
    if (!ev) return null;
    ev.status = status;
    await save();
    return ev;
  }

  /** 拿一段对话，抽事件。meta.convId 会挂到事件上，方便以后知道是哪次聊出来的 */
  async function extractFromText(text, meta = {}) {
    const src = String(text || '').trim();
    if (src.length < 12) return [];
    const nowD = new Date();
    // 日期由代码算好、就地标进文本；模型只认「什么事 + 几点」
    const pre = resolveDates(src, nowD);
    const system = EXTRACT_SYSTEM
      .replace('{{TODAY}}', fmtLocal(nowD))
      .replace('{{WEEKDAY}}', WEEKDAYS[nowD.getDay()])
      .replace('{{CALENDAR}}', calendarHint(nowD))
      + (pre.dates.length
        ? '\n\n原文里的日期已经被标成 <日期:YYYY-MM-DD>：照抄标记里的日期，不要自己换算，也不要改。'
        : '');
    const out = await askModel({
      system,
      user: `对话片段：\n${pre.text.slice(-4000)}\n\n只输出 JSON。`,
    });
    const parsed = pickJson(out && out.text);
    const arr = (parsed && Array.isArray(parsed.events)) ? parsed.events : [];
    const st = await settingsOf().catch(() => ({}));
    const added = [];
    for (const e of arr.slice(0, 5)) {
      if (!e || !e.title) continue;
      const title = String(e.title).trim();
      // 「下午三点」「十点半」这种把时间词当事件的，直接丢
      if (!title || TIME_ONLY.test(title.replace(/\s/g, ''))) continue;
      let at = parseLocal(e.at);
      if (!at) continue; // 没时间的不要：那是画像，不是事件
      // 全文只有一个明确日期时，日期用代码算的、时分用模型给的
      if (pre.dates.length === 1) {
        const m = /^\d{4}-\d{2}-\d{2}\s+(\d{1,2}):(\d{2})$/.exec(String(e.at || '').trim());
        const fixed = parseLocal(`${pre.dates[0]} ${m ? `${m[1]}:${m[2]}` : '00:00'}`);
        if (fixed) at = fixed;
      }
      // 抽出来的时间得说得过去：早于六小时前（已经过去）或远得离谱（两年后）都不认
      if (at < Date.now() - 6 * 3600e3) continue;
      if (at > Date.now() + 730 * 86400e3) continue;
      let note = String(e.note || '').trim().slice(0, 200);
      if (NOTE_TEMPLATE.test(note)) note = ''; // 模型抄了示例里的占位句
      let ev;
      try { ev = await add({ title: e.title, at, note, source: 'chat' }, meta); } catch { continue; }
      // 没说几点（抽出来是 00:00）就去网上看看有没有更准的时间表；查不到就算了，绝不编
      if (st.eventsSearch !== false && !ev.lookup && / 00:00$/.test(ev.atText)) {
        try {
          const lk = await lookup(ev.title);
          if (lk) { ev.lookup = lk; await save(); }
        } catch { /* 联网失败不影响事件本身 */ }
      }
      added.push(ev);
    }
    const c = await load();
    c.scans.push({ at: Date.now(), convId: meta.convId || '', found: added.length });
    c.scans = c.scans.slice(-50);
    await save();
    return added;
  }

  /** 从某个会话（或 QQ 当前会话）抽事件 */
  async function scanConversation(convId, { limit = 40 } = {}) {
    if (!convText) throw new Error('没有接上会话读取');
    const text = await convText(convId, { limit });
    return extractFromText(text, { convId });
  }

  /** 去网上查一件事大概什么时候发生；只取日期，取不到返回 null，绝不编 */
  async function lookup(title) {
    const q = String(title || '').trim();
    if (!q) return null;
    const url = 'https://www.bing.com/search?q=' + encodeURIComponent(q + ' 时间 日期');
    let html = '';
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 9000);
      const r = await fetch(url, {
        signal: ac.signal,
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', 'accept-language': 'zh-CN,zh;q=0.9' },
      });
      clearTimeout(t);
      html = await r.text();
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const plain = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
    const hits = [];
    const re1 = /(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
    const re2 = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
    let m;
    while ((m = re1.exec(plain)) && hits.length < 6) {
      hits.push({ at: `${m[1]}-${pad(m[2])}-${pad(m[3])}`, snippet: plain.slice(Math.max(0, m.index - 30), m.index + 40).trim() });
    }
    if (!hits.length) {
      while ((m = re2.exec(plain)) && hits.length < 6) {
        const y = new Date().getFullYear();
        hits.push({ at: `${y}-${pad(m[1])}-${pad(m[2])}`, snippet: plain.slice(Math.max(0, m.index - 30), m.index + 40).trim() });
      }
    }
    const best = hits[0] || null;
    return { ok: !!best, query: q, hit: best, candidates: hits, fetchedAt: Date.now() };
  }

  /** 到点就发。返回这一轮发出去的提醒 */
  async function tick() {
    const settings = (await settingsOf()) || {};
    if (settings.eventsEnabled === false) return [];
    const leadMin = Math.max(0, Math.min(24 * 60, Number(settings.eventsLeadMin ?? 10)));
    const c = await load();
    const t = Date.now();
    const sent = [];
    for (const ev of c.events) {
      if (!ev.at || ev.fired || ev.status === 'done') continue;
      if (t < ev.at - leadMin * 60e3) continue;
      if (t > ev.at + 6 * 3600e3) { ev.status = 'past'; continue; } // 六小时前的事别补发了
      const when = ev.at > t + 60e3 ? `还有 ${Math.round((ev.at - t) / 60e3)} 分钟` : '到点了';
      const text = `${ev.title} ${when}${ev.atText ? '（' + ev.atText.slice(11) + '）' : ''}${ev.note ? '，' + ev.note : ''}`;
      let id = null;
      try { id = await sendText(text); } catch (e) { log(`[事件] 发送失败：${e.message}`); continue; }
      ev.fired = true;
      ev.firedAt = t;
      ev.status = 'fired';
      sent.push({ id: ev.id, text, messageId: id });
      log(`[事件] 已提醒：${text}`);
      if (appendToConv && ev.convId) {
        try { await appendToConv(ev.convId, `（提醒）${text}`); } catch { /* 记不进去不影响已发出的事 */ }
      }
    }
    if (sent.length) await save();
    else if (c.events.some(e => e.status === 'past')) await save();
    return sent;
  }

  let timer = null;
  function startScheduler(intervalMs = 30e3) {
    if (timer) return;
    timer = setInterval(() => { tick().catch(e => log('[事件] 巡检出错：' + e.message)); }, intervalMs);
    if (timer.unref) timer.unref();
    log(`[事件] 巡检已启动（每 ${Math.round(intervalMs / 1000)} 秒）`);
  }
  function stopScheduler() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** 路由：server.mjs 只负责转发，逻辑都在这儿 */
  async function handle({ pathname, method, body = {}, settings = {} }) {
    if (pathname === '/api/events' && method === 'GET') {
      const events = await list();
      return {
        status: 200,
        json: {
          ok: true,
          enabled: settings.eventsEnabled !== false,
          leadMin: Number(settings.eventsLeadMin ?? 10),
          search: settings.eventsSearch !== false,
          events: events.slice(-100).reverse(),
          next: events.find(e => e.at && !e.fired && e.at > Date.now()) || null,
        },
      };
    }
    if (pathname === '/api/events/scan' && method === 'POST') {
      const convId = String(body.convId || '').trim();
      const added = convId ? await scanConversation(convId, { limit: Number(body.limit) || 40 }) : await extractFromText(body.text || '', { convId: '' });
      return { status: 200, json: { ok: true, added } };
    }
    if (pathname === '/api/events/add' && method === 'POST') {
      const ev = await add({ title: body.title, at: body.at || body.atText, atText: body.atText, note: body.note, convId: body.convId, source: 'manual' });
      return { status: 200, json: { ok: true, event: ev } };
    }
    if (pathname === '/api/events/remove' && method === 'POST') {
      return { status: 200, json: { ok: await remove(String(body.id || '')) } };
    }
    if (pathname === '/api/events/status' && method === 'POST') {
      const ev = await setStatus(String(body.id || ''), String(body.status || 'done'));
      return { status: ev ? 200 : 404, json: { ok: !!ev, event: ev || null } };
    }
    if (pathname === '/api/events/lookup' && method === 'POST') {
      const r = await lookup(body.title || '');
      return { status: 200, json: { ok: !!(r && r.ok), result: r } };
    }
    if (pathname === '/api/events/tick' && method === 'POST') {
      const sent = await tick();
      return { status: 200, json: { ok: true, sent } };
    }
    return null;
  }

  return { load, save, list, add, remove, setStatus, extractFromText, scanConversation, lookup, tick, startScheduler, stopScheduler, handle };
}

export default { createEvents };
