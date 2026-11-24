// QQ 群聊自学习：把群消息存成可分析的形状，然后按语境做统计。
//
// 这里只有两类东西：
//   1. Store   —— 落盘与去重（一个群一个 messages.jsonl，追加写，重启不重采）
//   2. analyze —— 纯函数，喂进一堆规范化消息，吐出画像 / 关系图 / 节奏 / 情绪 / 梗 / 周结算
//
// 设计上刻意不依赖任何三方库，也不碰 SQLite：群聊一年的量也就几十万条，JSONL + 按周聚合够用。

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- 规范化

const SEG_TEXT = 1, SEG_AT = 2, SEG_FACE = 3, SEG_IMAGE = 4, SEG_REPLY = 5;

function segsOf(msg) {
  if (Array.isArray(msg)) return msg;
  if (msg && typeof msg === 'object') return [msg];
  return [];
}

function textOfSegs(segs) {
  let out = '';
  for (const s of segs) {
    const t = s && s.type;
    if (t === 'text') out += (s.data && s.data.text) || '';
    else if (t === 'at') out += ' @' + ((s.data && (s.data.qq || s.data.name)) || '');
    else if (t === 'face' || t === 'mface') out += '[表情]';
    else if (t === 'image') out += '[图片]';
    else if (t === 'record' || t === 'video') out += '[语音]';
    else if (t === 'forward') out += '[转发]';
  }
  return out;
}

/** OneBot 群消息 → 我们自己的扁平记录。拿不准的一律留空，不猜。 */
export function normalizeOneBotMessage(m, gidHint = '') {
  if (!m || typeof m !== 'object') return null;
  const mid = m.message_id ?? m.messageId ?? null;
  if (!mid) return null;
  const segs = segsOf(m.message);
  const sender = m.sender || {};
  const at = [];
  let replyTo = null;
  let kinds = [];
  for (const s of segs) {
    if (!s || !s.type) continue;
    if (!kinds.includes(s.type)) kinds.push(s.type);
    if (s.type === 'at' && s.data) {
      const q = String(s.data.qq ?? '');
      if (q && q !== 'all') at.push(q);
    }
    if (s.type === 'reply' && s.data && s.data.id) replyTo = String(s.data.id);
  }
  const ts = Number(m.time) || 0;
  return {
    gid: String(m.group_id ?? gidHint ?? ''),
    mid: String(mid),
    uid: String(m.user_id ?? ''),
    nick: String(sender.card || sender.nickname || m.sender?.nickname || ''),
    ts,
    text: textOfSegs(segs).trim(),
    at,
    replyTo,
    kinds,
    self: !!m.self_id && String(m.user_id) === String(m.self_id),
  };
}

// ---------------------------------------------------------------- 存储

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function isoWeek(ts) {
  const d = new Date((Number(ts) || 0) * 1000);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function safeGid(gid) {
  const s = String(gid || '').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 24);
  return s || 'unknown';
}

export class GroupStore {
  constructor(rootDir) {
    this.root = rootDir;
    this.cache = new Map(); // gid -> {seen:Set, msgs:[]}
  }

  dirOf(gid) {
    return path.join(this.root, safeGid(gid));
  }

  fileOf(gid) {
    return path.join(this.dirOf(gid), 'messages.jsonl');
  }

  load(gid) {
    const key = safeGid(gid);
    if (this.cache.has(key)) return this.cache.get(key);
    const msgs = [];
    const seen = new Set();
    const file = this.fileOf(key);
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        if (!r || !r.mid || seen.has(r.mid)) continue;
        seen.add(r.mid);
        msgs.push(r);
      }
      msgs.sort((a, b) => a.ts - b.ts || String(a.mid).localeCompare(String(b.mid)));
    }
    const hit = { seen, msgs };
    this.cache.set(key, hit);
    return hit;
  }

  /** 追加一批（自动去重、按 ts 排序）。返回新进来的条数。 */
  append(gid, records) {
    const key = safeGid(gid);
    const st = this.load(key);
    const fresh = [];
    for (const r of records || []) {
      if (!r || !r.mid || st.seen.has(r.mid)) continue;
      st.seen.add(r.mid);
      fresh.push(r);
    }
    if (!fresh.length) return 0;
    fresh.sort((a, b) => a.ts - b.ts);
    fs.mkdirSync(this.dirOf(key), { recursive: true });
    fs.appendFileSync(this.fileOf(key), fresh.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    st.msgs = st.msgs.concat(fresh).sort((a, b) => a.ts - b.ts);
    return fresh.length;
  }

  list(gid, { since = 0, until = Infinity } = {}) {
    return this.load(gid).msgs.filter((r) => r.ts >= since && r.ts <= until);
  }

  stats(gid) {
    const st = this.load(gid);
    const first = st.msgs[0], last = st.msgs[st.msgs.length - 1];
    return {
      gid: safeGid(gid),
      count: st.msgs.length,
      people: new Set(st.msgs.map((r) => r.uid)).size,
      firstTs: first ? first.ts : null,
      lastTs: last ? last.ts : null,
    };
  }

  groups() {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(this.root, d.name, 'messages.jsonl')))
      .map((d) => this.stats(d.name));
  }
}

// ---------------------------------------------------------------- 词表

const POS = ['好', '棒', '赞', '喜欢', '爱', '开心', '高兴', '爽', '笑死', '哈哈', '牛', '强', '香', '漂亮', '可爱', '感谢', '谢谢', '厉害', '牛逼', '绝了', '舒服', '满意', '期待', '有意思', '好玩', '治愈', '稳', '靠谱', '赚', '便宜', '快', '顺'];
const NEG = ['差', '烂', '垃圾', '恶心', '烦', '气', '哭', '崩', '寄', '死', '难受', '失望', '坑', '贵', '慢', '卡', '吵', '累', '无语', '服了', '离谱', '离谱', '傻', '丑', '崩了', '糟糕', '痛', '慌', '怕', 'emo', '破防', '离谱'];
const MODAL = ['啊', '吧', '呢', '呗', '嘛', '咯', '呀', '哦', '噢', '诶', '欸', '唉', '哎', '哈', '啦', '嗷', '喔', '捏', '呐', '嘞'];
const LAUGH = ['哈哈', 'hhh', '233', '笑死', '嘿嘿', '嘻嘻', '草', '乐'];
const PUNCTS = ['，', '。', '！', '？', '、', '…', '~', '—', ',', '.', '!', '?'];
const END_PUNCT_RE = /[。！？.!?…~～]$/;
const SENT_SPLIT = /[。！？!?；;\n]+/;
const PRONOUN_RE = /^(我|你|他|她|它|我们|你们|他们|咱们|大家|自己|俺|咱)/;
const CLAUSE_SPLIT = /[，,、；;]/;

function countAny(text, dict) {
  let n = 0;
  for (const w of dict) {
    let i = 0;
    while ((i = text.indexOf(w, i)) >= 0) { n++; i += w.length; }
  }
  return n;
}

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quantile(arr, q) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * q)));
  return s[i];
}

function round(x, n = 2) {
  if (x === null || x === undefined || Number.isNaN(x)) return null;
  const p = 10 ** n;
  return Math.round(x * p) / p;
}

function per100(n, chars) {
  if (!chars) return null;
  return round((n / chars) * 100, 2);
}

// ---------------------------------------------------------------- 情绪

export function sentimentOf(text) {
  const t = String(text || '');
  if (!t) return 0;
  const pos = countAny(t, POS);
  const neg = countAny(t, NEG);
  const laugh = countAny(t, LAUGH);
  const bang = (t.match(/[！!]/g) || []).length;
  const q = (t.match(/[？?]/g) || []).length;
  let s = pos - neg + (laugh ? 0.6 : 0) + Math.min(bang, 2) * 0.25 - Math.min(q, 1) * 0.1;
  // 语气词多通常更松弛，算轻微正向
  s += countAny(t, MODAL) * 0.08;
  return round(Math.max(-3, Math.min(3, s)), 2);
}

// ---------------------------------------------------------------- 正文切分

function splitSentences(text) {
  return String(text || '').split(SENT_SPLIT).map((s) => s.trim()).filter(Boolean);
}

function splitClauses(text) {
  return String(text || '').split(CLAUSE_SPLIT).map((s) => s.trim()).filter(Boolean);
}

function noEndPunct(text) {
  const t = String(text || '').trim();
  return t ? !END_PUNCT_RE.test(t) : false;
}

/** 省略主语：一句话是「谓语起头」而不是「我/你/他起头」。中文群聊里这是最明显的口语标志。 */
function proDropOf(sentences) {
  const hit = sentences.filter((s) => !PRONOUN_RE.test(s));
  return sentences.length ? round(hit.length / sentences.length, 3) : null;
}

// ---------------------------------------------------------------- 画像

function profileOf(records) {
  const texts = records.map((r) => r.text).filter(Boolean);
  const sentences = texts.flatMap(splitSentences);
  const clauses = sentences.flatMap(splitClauses);
  const lens = texts.map((t) => t.length);
  const sentLens = sentences.map((s) => s.length);
  const clauseLens = clauses.map((s) => s.length);
  const chars = texts.reduce((a, t) => a + t.length, 0);
  const hours = new Array(24).fill(0);
  const minutes = new Array(60).fill(0);
  for (const r of records) {
    const d = new Date(r.ts * 1000);
    hours[d.getHours()]++;
    minutes[d.getMinutes()]++;
  }
  const punct = {};
  for (const t of texts) for (const p of PUNCTS) punct[p] = (punct[p] || 0) + (t.split(p).length - 1);
  const atCount = records.filter((r) => r.at.length).length;
  const replyCount = records.filter((r) => r.replyTo).length;
  return {
    msgs: records.length,
    people: new Set(records.map((r) => r.uid)).size,
    chars,
    charsMedian: median(lens),
    sentenceMedian: median(sentLens),
    sentenceMean: sentLens.length ? round(sentLens.reduce((a, b) => a + b, 0) / sentLens.length, 2) : null,
    clauseMedian: median(clauseLens),
    shortRatio: sentLens.length ? round(sentLens.filter((n) => n <= 8).length / sentLens.length, 3) : null,
    longRatio: sentLens.length ? round(sentLens.filter((n) => n >= 30).length / sentLens.length, 3) : null,
    commaPer100: per100(countAny(texts.join(''), ['，', ',']), chars),
    questionRatio: texts.length ? round(texts.filter((t) => /[？?]/.test(t)).length / texts.length, 3) : null,
    exclaimRatio: texts.length ? round(texts.filter((t) => /[！!]/.test(t)).length / texts.length, 3) : null,
    noEndPunctRatio: texts.length ? round(texts.filter(noEndPunct).length / texts.length, 3) : null,
    modalPer100: per100(countAny(texts.join(''), MODAL), chars),
    laughPer100: per100(countAny(texts.join(''), LAUGH), chars),
    emojiPer100: per100((texts.join('').match(/\[表情\]|[\u{1F300}-\u{1FAFF}]/gu) || []).length, chars),
    proDropRatio: proDropOf(sentences),
    punctTop: Object.entries(punct).sort((a, b) => b[1] - a[1]).slice(0, 5),
    atPer100Msgs: records.length ? round((atCount / records.length) * 100, 1) : null,
    replyPer100Msgs: records.length ? round((replyCount / records.length) * 100, 1) : null,
    hours,
    minutes,
    avgSentiment: records.length
      ? round(records.reduce((a, r) => a + sentimentOf(r.text), 0) / records.length, 3)
      : null,
  };
}

// ---------------------------------------------------------------- 关系与节奏

function replyEdges(records) {
  const byMid = new Map(records.map((r) => [r.mid, r]));
  const edges = new Map(); // from->to
  const quoted = new Map(); // mid -> count
  const latencies = new Map(); // from->to -> []
  for (const r of records) {
    if (!r.replyTo) continue;
    const parent = byMid.get(String(r.replyTo));
    if (!parent) continue;
    const k = `${r.uid}>${parent.uid}`;
    const e = edges.get(k) || { from: r.uid, to: parent.uid, count: 0, gaps: [] };
    e.count++;
    const gap = r.ts - parent.ts;
    if (gap >= 0 && gap < 86400) e.gaps.push(gap);
    edges.set(k, e);
    quoted.set(parent.mid, (quoted.get(parent.mid) || 0) + 1);
  }
  const list = [...edges.values()].map((e) => ({
    from: e.from, to: e.to, count: e.count,
    medianGapS: median(e.gaps), p90GapS: quantile(e.gaps, 0.9),
  })).sort((a, b) => b.count - a.count);
  const quoteHist = {};
  for (const c of quoted.values()) quoteHist[c] = (quoteHist[c] || 0) + 1;
  return { edges: list, quoted, quoteHist };
}

function atEdges(records) {
  const edges = new Map();
  for (const r of records) {
    for (const target of r.at) {
      const k = `${r.uid}>${target}`;
      const e = edges.get(k) || { from: r.uid, to: target, count: 0, gaps: [] };
      e.count++;
      edges.set(k, e);
    }
  }
  return [...edges.values()].map((e) => ({ from: e.from, to: e.to, count: e.count }))
    .sort((a, b) => b.count - a.count);
}

/** 被 @ 之后有没有回应：按被 @ 的下一批消息里同一人开口算。 */
function atReplyBehavior(records, withinS = 300) {
  const out = new Map();
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!r.at.length) continue;
    for (const target of r.at) {
      const st = out.get(target) || { uid: target, atReceived: 0, replied: 0, gaps: [] };
      st.atReceived++;
      for (let j = i + 1; j < records.length; j++) {
        const nxt = records[j];
        if (nxt.ts - r.ts > withinS) break;
        if (nxt.uid === target) { st.replied++; st.gaps.push(nxt.ts - r.ts); break; }
      }
      out.set(target, st);
    }
  }
  return [...out.values()].map((s) => ({
    uid: s.uid,
    atReceived: s.atReceived,
    replied: s.replied,
    replyRate: s.atReceived ? round(s.replied / s.atReceived, 3) : null,
    medianReplyS: median(s.gaps),
  })).sort((a, b) => b.atReceived - a.atReceived);
}

function rhythmOf(records) {
  const gaps = [];
  for (let i = 1; i < records.length; i++) {
    const g = records[i].ts - records[i - 1].ts;
    if (g >= 0 && g < 6 * 3600) gaps.push(g);
  }
  // 5 分钟一格的活跃度
  const buckets = new Map();
  for (const r of records) {
    const b = Math.floor(r.ts / 300) * 300;
    buckets.set(b, (buckets.get(b) || 0) + 1);
  }
  const perBucket = [...buckets.values()];
  const replyGaps = [];
  const byMid = new Map(records.map((r) => [r.mid, r]));
  for (const r of records) {
    if (!r.replyTo) continue;
    const p = byMid.get(String(r.replyTo));
    if (p && r.ts >= p.ts) replyGaps.push(r.ts - p.ts);
  }
  return {
    gapMedianS: median(gaps),
    gapP90S: quantile(gaps, 0.9),
    gapsUnder10s: gaps.length ? round(gaps.filter((g) => g <= 10).length / gaps.length, 3) : null,
    replyGapMedianS: median(replyGaps),
    activeBucketMedian: median(perBucket),
    activeBucketMax: perBucket.length ? Math.max(...perBucket) : null,
    peakHours: (() => {
      const hours = new Array(24).fill(0);
      for (const r of records) hours[new Date(r.ts * 1000).getHours()]++;
      return hours.map((n, h) => ({ h, n })).sort((a, b) => b.n - a.n).slice(0, 5);
    })(),
  };
}

// ---------------------------------------------------------------- 梗

const MEME_MIN_COUNT = 5;
const MEME_MIN_SENDERS = 3;

function memesOf(records, { minCount = MEME_MIN_COUNT, minSenders = MEME_MIN_SENDERS } = {}) {
  const texts = records.map((r) => ({ uid: r.uid, ts: r.ts, text: r.text })).filter((r) => r.text);
  const counts = new Map(); // phrase -> {count, senders:Map, first, last, mid}
  for (const r of texts) {
    const t = r.text;
    for (let n = 2; n <= 8; n++) {
      for (let i = 0; i + n <= t.length; i++) {
        const p = t.slice(i, i + n);
        if (/^[\s\p{P}\p{S}]+$/u.test(p)) continue;
        if (/^\[(表情|图片|语音|转发)\]$/.test(p)) continue;
        if (/^\d+$/.test(p)) continue;
        const c = counts.get(p) || { count: 0, senders: new Map(), first: r.ts, last: r.ts, days: new Set() };
        c.count++;
        c.senders.set(r.uid, (c.senders.get(r.uid) || 0) + 1);
        c.first = Math.min(c.first, r.ts);
        c.last = Math.max(c.last, r.ts);
        c.days.add(new Date(r.ts * 1000).toISOString().slice(0, 10));
        counts.set(p, c);
      }
    }
  }
  let cands = [...counts.entries()]
    .filter(([, c]) => c.count >= minCount && c.senders.size >= minSenders && c.days.size >= 2)
    .map(([p, c]) => ({
      phrase: p, count: c.count, senders: c.senders.size,
      firstTs: c.first, lastTs: c.last, activeDays: c.days.size,
      spreadPerDay: round(c.senders.size / Math.max(1, c.days.size), 2),
      topSenders: [...c.senders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([uid, n]) => ({ uid, n })),
    }));
  // 去重叠：保留更长且频率不掉太多的那个
  cands.sort((a, b) => b.phrase.length - a.phrase.length || b.count - a.count);
  const kept = [];
  for (const c of cands) {
    if (kept.some((k) => k.phrase.includes(c.phrase) && k.count >= c.count * 0.8)) continue;
    if (kept.some((k) => c.phrase.includes(k.phrase) && k.count >= c.count * 0.8)) continue;
    kept.push(c);
  }
  return kept.sort((a, b) => b.count - a.count).slice(0, 40).map((c) => ({
    ...c,
    firstISO: new Date(c.firstTs * 1000).toISOString(),
    lastISO: new Date(c.lastTs * 1000).toISOString(),
  }));
}

// ---------------------------------------------------------------- 情绪随话题变化

function sentimentFlow(records, n = 6) {
  const scored = records.map((r) => ({ mid: r.mid, ts: r.ts, uid: r.uid, text: r.text, s: sentimentOf(r.text) }));
  const base = scored.length ? round(scored.reduce((a, x) => a + x.s, 0) / scored.length, 3) : null;
  const spikes = scored
    .map((x, i) => ({ ...x, i }))
    .filter((x) => Math.abs(x.s) >= 1.5 && x.text.length >= 2)
    .sort((a, b) => Math.abs(b.s) - Math.abs(a.s))
    .slice(0, 20)
    .map((x) => {
      const before = scored.slice(Math.max(0, x.i - n), x.i);
      const after = scored.slice(x.i + 1, x.i + 1 + n);
      const mean = (arr) => (arr.length ? round(arr.reduce((a, y) => a + y.s, 0) / arr.length, 3) : null);
      return {
        mid: x.mid, ts: x.ts, uid: x.uid, text: x.text.slice(0, 60), score: x.s,
        beforeMean: mean(before), afterMean: mean(after),
        delta: before.length && after.length ? round(mean(after) - mean(before), 3) : null,
      };
    });
  // 滑动窗口的话题 + 情绪
  const windows = [];
  const size = Math.max(20, Math.min(80, Math.round(records.length / 40) || 20));
  for (let i = 0; i + size <= records.length; i += Math.max(1, Math.floor(size / 2))) {
    const chunk = records.slice(i, i + size);
    const texts = chunk.map((r) => r.text).join(' ');
    const grams = new Map();
    for (let n2 = 2; n2 <= 4; n2++) {
      for (let k = 0; k + n2 <= texts.length; k++) {
        const p = texts.slice(k, k + n2);
        if (/^[\s\p{P}\p{S}]+$/u.test(p)) continue;
        grams.set(p, (grams.get(p) || 0) + 1);
      }
    }
    windows.push({
      fromTs: chunk[0].ts, toTs: chunk[chunk.length - 1].ts,
      msgs: chunk.length,
      sentiment: round(chunk.reduce((a, r) => a + sentimentOf(r.text), 0) / chunk.length, 3),
      topics: [...grams.entries()].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p]) => p),
    });
  }
  return { base, spikes, windows };
}

// ---------------------------------------------------------------- 主分析

export function analyze(records, opts = {}) {
  const n = Number(opts.n) || 6;
  const sorted = records.slice().sort((a, b) => a.ts - b.ts);
  if (!sorted.length) {
    return {
      empty: true, count: 0, people: 0, spanS: 0,
      overall: null, peopleTop: [], graph: { edges: [], atEdges: [], quoteHist: {} },
      rhythm: null, sentiment: { base: null, spikes: [], windows: [] }, memes: [],
      byHour: null,
    };
  }
  const { edges, quoted, quoteHist } = replyEdges(sorted);
  const ats = atEdges(sorted);
  const byUid = new Map();
  for (const r of sorted) {
    if (!byUid.has(r.uid)) byUid.set(r.uid, []);
    byUid.get(r.uid).push(r);
  }
  const peopleTop = [...byUid.entries()]
    .map(([uid, rs]) => ({ uid, nick: (rs.find((x) => x.nick) || {}).nick || '', ...profileOf(rs) }))
    .sort((a, b) => b.msgs - a.msgs)
    .slice(0, 20);
  const flow = sentimentFlow(sorted, n);
  return {
    empty: false,
    count: sorted.length,
    people: byUid.size,
    firstTs: sorted[0].ts,
    lastTs: sorted[sorted.length - 1].ts,
    spanS: sorted[sorted.length - 1].ts - sorted[0].ts,
    overall: profileOf(sorted),
    peopleTop,
    graph: { edges: edges.slice(0, 60), atEdges: ats.slice(0, 60), quoteHist, quotedTotal: quoted.size },
    rhythm: rhythmOf(sorted),
    atBehavior: atReplyBehavior(sorted),
    sentiment: flow,
    memes: memesOf(sorted, opts.meme || {}),
    weeks: weeklyOf(sorted),
  };
}

// ---------------------------------------------------------------- 周结算

function weeklyOf(records) {
  const byWeek = new Map();
  for (const r of records) {
    const w = isoWeek(r.ts);
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w).push(r);
  }
  return [...byWeek.entries()].sort().map(([week, rs]) => {
    const prof = profileOf(rs);
    const memes = memesOf(rs).slice(0, 8);
    const { edges } = replyEdges(rs);
    return {
      week,
      msgs: rs.length,
      people: prof.people,
      charsMedian: prof.charsMedian,
      sentenceMedian: prof.sentenceMedian,
      shortRatio: prof.shortRatio,
      modalPer100: prof.modalPer100,
      proDropRatio: prof.proDropRatio,
      noEndPunctRatio: prof.noEndPunctRatio,
      avgSentiment: prof.avgSentiment,
      topReplyPair: edges[0] || null,
      memes: memes.map((m) => ({ phrase: m.phrase, count: m.count, senders: m.senders })),
      topPeople: [...new Set(rs.map((r) => r.uid))].length,
    };
  });
}

export function renderWeeklyMarkdown(report, { name = '' } = {}) {
  const lines = [];
  lines.push(`# 群聊自学习周报 ${report.week}${name ? ' · ' + name : ''}`);
  lines.push('');
  lines.push(`- 消息 ${report.msgs} 条，${report.people} 人开口`);
  if (report.charsMedian !== null) lines.push(`- 句长中位 ${report.charsMedian} 字，小句中位 ${report.sentenceMedian} 字，≤8 字占 ${Math.round((report.shortRatio || 0) * 100)}%`);
  if (report.modalPer100 !== null) lines.push(`- 语气词 ${report.modalPer100}/100 字，省略主语 ${Math.round((report.proDropRatio || 0) * 100)}%，不写句末标点 ${Math.round((report.noEndPunctRatio || 0) * 100)}%`);
  if (report.avgSentiment !== null) lines.push(`- 平均情绪 ${report.avgSentiment}`);
  if (report.topReplyPair) lines.push(`- 最爱接话：${report.topReplyPair.from} → ${report.topReplyPair.to}（${report.topReplyPair.count} 次）`);
  if (report.memes && report.memes.length) {
    lines.push('');
    lines.push('## 这周冒出来的内部梗');
    for (const m of report.memes) lines.push(`- 「${m.phrase}」${m.count} 次，${m.senders} 个人在用`);
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- 喂给模型的画像

export function buildLearnedProfile(analysis, { maxChars = 1200 } = {}) {
  if (!analysis || analysis.empty) return '';
  const o = analysis.overall || {};
  const bits = [];
  bits.push('【这个群的说话样子（从历史消息里量出来的，跟着用就行，不用解释）】');
  bits.push(`句长：多数 ${o.sentenceMedian ?? '?'} 字上下，≤8 字的短句占 ${Math.round((o.shortRatio || 0) * 100)}%；一句里逗号 ${o.commaPer100 ?? '?'}/100 字。`);
  if (o.modalPer100 !== null) bits.push(`语气词 ${o.modalPer100}/100 字；省略主语 ${Math.round((o.proDropRatio || 0) * 100)}%；不写句末标点 ${Math.round((o.noEndPunctRatio || 0) * 100)}%。`);
  if (o.avgSentiment !== null) bits.push(`平均情绪 ${o.avgSentiment}（-3 到 3），别突然热情也别突然丧。`);
  const r = analysis.rhythm;
  if (r && r.gapMedianS !== null) {
    bits.push(`节奏：两条消息间隔中位 ${r.gapMedianS}s，回复别人的间隔中位 ${r.replyGapMedianS ?? '?'}s，${Math.round((r.gapsUnder10s || 0) * 100)}% 的接话在 10 秒内。`);
  }
  const g = analysis.graph && analysis.graph.edges && analysis.graph.edges[0];
  if (g) bits.push(`最常接话的一对是 ${g.from} → ${g.to}，别打乱这种顺位。`);
  if (analysis.memes && analysis.memes.length) {
    const hot = analysis.memes.slice(0, 3).map((m) => `「${m.phrase}」`).join('、');
    bits.push(`这阵子在用的内部梗：${hot}（用就用原样，别解释）。`);
  }
  const s = bits.join('');
  return s.length > maxChars ? s.slice(0, maxChars) + '…' : s;
}

export default { normalizeOneBotMessage, GroupStore, analyze, isoWeek, renderWeeklyMarkdown, buildLearnedProfile, sentimentOf };
