// 用户对话学习：从「我自己打过的字」里量出这个人的说话样子。
//
// 群学习（learn-service.mjs + qqgroup.mjs）看的是「一群人怎么说话」；
// 这一层只看一个人：网页里打的字、QQ 上发来的消息，都算同一个人的语。
// 量出来的东西有三个用途：①学习页上给人看；②按需注入 system，让模型照着他的语感说话；
// ③往后可以拿它做「像我」的改写基线。
import fs from 'node:fs';
import path from 'node:path';
import { analyze } from './qqgroup.mjs';

// QQ 消息进库时被套了两层壳：抬头是「【来自 QQ 上的对方（uid），时间】」，
// 尾巴是我们自己塞给模型的手机打字口径。都不是他说的话，量之前先剥掉。
const PHONE_TAIL = /\n*【这条回在手机上】[^\n]*/g;
const QQ_HEAD = /^【来自 QQ 上的对方（([^）]*)），([^】]*)】\n*/;

export function stripUserText(raw) {
  let body = String(raw == null ? '' : raw).replace(PHONE_TAIL, '');
  body = body.replace(QQ_HEAD, '');
  body = body.replace(/^【来自 QQ 上的对方[^\n]*】\n*/m, '');
  return body.trim();
}

function tsOf(m) {
  const t = m && (m.createdAt || m.ts || m.time);
  if (typeof t === 'number' && Number.isFinite(t)) return t > 1e12 ? Math.floor(t / 1000) : Math.floor(t);
  const d = Date.parse(String(t || ''));
  return Number.isFinite(d) ? Math.floor(d / 1000) : Math.floor(Date.now() / 1000);
}

// 会话数组 → 一条条「我发的」记录（形状对齐 qqgroup 的 records）
export function ownRecords(convs) {
  const records = [];
  let images = 0;
  let convsWithWords = 0;
  for (const conv of Array.isArray(convs) ? convs : []) {
    if (!conv || !Array.isArray(conv.messages)) continue;
    const src = conv.source === 'qq' ? 'qq' : 'web';
    let used = 0;
    for (const m of conv.messages) {
      if (!m || m.role !== 'user') continue;
      if (Array.isArray(m.attachments)) images += m.attachments.filter((a) => a && a.kind === 'image').length;
      const text = stripUserText(m.content);
      if (!text) continue;
      used++;
      records.push({
        gid: src, uid: 'me', nick: '我', ts: tsOf(m), text,
        at: [], replyTo: null, kinds: [], self: false, src,
      });
    }
    if (used) convsWithWords++;
  }
  records.sort((a, b) => a.ts - b.ts);
  return { records, images, convsWithWords };
}

function topIndexes(arr, k) {
  return (arr || [])
    .map((n, i) => ({ i, n }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, k)
    .map((x) => x.i);
}

// 常挂在嘴边的开头字（「行」「那」「我」「不」这种），只统计消息第一条小句的头两个字
function openersOf(records, k = 8) {
  const counts = new Map();
  for (const r of records) {
    const head = String(r.text).replace(/^[\s，,。.！!？?、~～]+/, '').slice(0, 2);
    if (head.length < 1) continue;
    counts.set(head, (counts.get(head) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([word, count]) => ({ word, count }));
}

// 泛词表：这些词出现得多不代表是口头禅，它们只是中文本身
const COMMON = new Set([
  '一个', '什么', '东西', '这个', '那个', '就是', '我们', '你们', '他们', '自己', '没有', '知道',
  '觉得', '现在', '时候', '可以', '应该', '因为', '所以', '但是', '如果', '这样', '那样', '怎么',
  '为什么', '还是', '已经', '不是', '真的', '有点', '比较', '一下', '一样', '一些', '这种', '那种',
  '其实', '然后', '而且', '不过', '可能', '需要', '问题', '东西', '地方', '开始', '最后', '第一',
]);

// 口头禅：只认「成块的、反复出现的」东西——整条短消息重复、小句的开头、小句的结尾。
// 不用 n-gram 是因为切出来全是「了，」「，我」这种碎片，看着像数据其实没信息。
function ticsOf(records, { max = 8 } = {}) {
  // 语料少的时候（新装/刚聊几句）门槛要跟着降，否则一条口头禅都出不来说明「学不到东西」
  const small = records.length < 50;
  const minShort = small ? 2 : 3;
  const minEdge = small ? 2 : 8;
  const short = new Map();   // 整条短消息
  const head = new Map();    // 小句开头 2–3 字
  const tail = new Map();    // 小句结尾 2–3 字
  const han = /^[\u4e00-\u9fff]{2,6}$/;
  const bump = (m, key) => m.set(key, (m.get(key) || 0) + 1);
  for (const r of records) {
    const text = String(r.text || '').trim();
    if (!text) continue;
    if (text.length >= 2 && text.length <= 12 && han.test(text)) bump(short, text);
    for (const clause of text.split(/[，,。.！!？?；;、\n]+/)) {
      const c = clause.trim();
      if (c.length < 3) continue;
      for (const n of [3, 2]) {
        if (c.length < n) continue;
        const h = c.slice(0, n);
        const t = c.slice(-n);
        if (han.test(h)) bump(head, h);
        if (han.test(t)) bump(tail, t);
      }
    }
  }
  const pick = (m, min) => [...m.entries()].filter(([w, n]) => n >= min && !COMMON.has(w));
  const cands = [
    ...pick(short, minShort).map(([phrase, count]) => ({ phrase, count, kind: '整句' })),
    ...pick(head, minEdge).map(([phrase, count]) => ({ phrase, count, kind: '开头' })),
    ...pick(tail, minEdge).map(([phrase, count]) => ({ phrase, count, kind: '收尾' })),
  ].sort((a, b) => b.count - a.count || b.phrase.length - a.phrase.length);
  const kept = [];
  for (const c of cands) {
    if (kept.some((k) => k.phrase.includes(c.phrase) || c.phrase.includes(k.phrase))) continue;
    kept.push(c);
    if (kept.length >= max) break;
  }
  return kept;
}

export function analyzeOwn(convs) {
  const { records, images, convsWithWords } = ownRecords(convs);
  const total = Array.isArray(convs) ? convs.length : 0;
  const base = {
    ok: true, convs: total, convsWithWords, images,
  };
  if (!records.length) return { ...base, empty: true, count: 0, profile: null, memes: [], phrases: [], openers: [], hours: [], sources: {} };
  // 单人语料：默认要求 3 个发送者的内部梗规则在他身上永远命中不了，所以把门槛放开
  const a = analyze(records, { n: 6, meme: { minCount: 3, minSenders: 1 } });
  const o = a.overall || {};
  const sources = records.reduce((acc, r) => { acc[r.src] = (acc[r.src] || 0) + 1; return acc; }, {});
  const days = a.firstTs && a.lastTs ? new Set(records.map((r) => new Date(r.ts * 1000).toISOString().slice(0, 10))).size : 0;
  return {
    ...base,
    empty: false,
    count: a.count,
    firstTs: a.firstTs,
    lastTs: a.lastTs,
    days,
    sources,
    profile: o,
    memes: a.memes.slice(0, 15),
    phrases: ticsOf(records),
    openers: openersOf(records),
    hours: topIndexes(o.hours, 4),
    rhythm: a.rhythm,
    avgSentiment: o.avgSentiment,
    weekly: (a.weeks || []).slice(-8).map((w) => ({
      week: w.week, msgs: w.msgs, sentenceMedian: w.sentenceMedian,
      modalPer100: w.modalPer100, avgSentiment: w.avgSentiment,
    })),
  };
}

const pct = (v) => (v == null ? '?' : `${Math.round(v * 100)}%`);

// 给模型看的那一段。别说「我发现你」，就当背景知识用。
export function buildOwnProfileText(a, { maxChars = 400 } = {}) {
  if (!a || a.empty || !a.profile) return '';
  const o = a.profile;
  const bits = [];
  bits.push('【对方平时怎么说话（从他自己发过的消息里量的，照着这个语感回，别复述这段）】');
  bits.push(`一条消息 ${o.charsMedian ?? '?'} 字上下，小句 ${o.sentenceMedian ?? '?'} 字，≤8 字的短句占 ${pct(o.shortRatio)}；一句里逗号 ${o.commaPer100 ?? '?'}/100 字。`);
  bits.push(`语气词 ${o.modalPer100 ?? '?'}/100 字，省略主语 ${pct(o.proDropRatio)}，不写句末标点 ${pct(o.noEndPunctRatio)}，问句占 ${pct(o.questionRatio)}。`);
  if (o.avgSentiment != null) bits.push(`平均情绪 ${o.avgSentiment}（-3 到 3），别突然热情也别突然丧。`);
  if (a.phrases && a.phrases.length) {
    bits.push(`他反复用的话：${a.phrases.slice(0, 4).map((m) => `「${m.phrase}」`).join('、')}（要接就接原样，别解释）。`);
  }
  if (a.hours && a.hours.length) bits.push(`常出没时段：${a.hours.map((h) => `${h} 点`).join('、')}。`);
  if (a.images > 0) bits.push('他会直接甩图，不配字。');
  const s = bits.join('');
  return s.length > maxChars ? s.slice(0, maxChars) + '…' : s;
}

// 学习页用的人话摘要
export function summaryOf(a) {
  if (!a || a.empty) return { ok: true, empty: true, hint: '还没有你自己发的消息，先在网页或 QQ 上说两句' };
  const o = a.profile;
  return {
    ok: true,
    empty: false,
    count: a.count,
    convs: a.convsWithWords,
    days: a.days,
    images: a.images,
    metrics: [
      { k: '消息条数', v: String(a.count), h: `${a.days} 天 · ${a.convsWithWords} 段对话` },
      { k: '一条多少字', v: o.charsMedian == null ? '—' : `${o.charsMedian} 字`, h: `小句中位 ${o.sentenceMedian ?? '—'}` },
      { k: '短句占比', v: pct(o.shortRatio), h: '≤8 字' },
      { k: '语气词密度', v: o.modalPer100 == null ? '—' : String(o.modalPer100), h: '每 100 字' },
      { k: '省略主语', v: pct(o.proDropRatio), h: '默认不说「我」' },
      { k: '不写句末标点', v: pct(o.noEndPunctRatio), h: '句号问号都不加' },
      { k: '问句占比', v: pct(o.questionRatio), h: '带问号的条数' },
      { k: '平均情绪', v: o.avgSentiment == null ? '—' : String(o.avgSentiment), h: '-3 到 3' },
    ],
    phrases: a.phrases.map((m) => ({ phrase: m.phrase, count: m.count })),
    openers: a.openers,
    hours: a.hours,
    sources: a.sources,
    weekly: a.weekly,
  };
}

export function createUserLearnService({ dataDir, loadConversations, now = () => Date.now(), ttlMs = 30000 } = {}) {
  const root = path.join(dataDir, 'user-learn');
  const file = path.join(root, 'profile.json');
  let cache = null;
  let cacheAt = 0;

  async function build({ write = false, force = false } = {}) {
    if (!force && cache && now() - cacheAt < ttlMs) return cache;
    const convs = typeof loadConversations === 'function' ? await loadConversations() : [];
    const a = analyzeOwn(convs);
    a.builtAt = new Date(now()).toISOString();
    cache = a;
    cacheAt = now();
    if (write) {
      try {
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(a, null, 2), 'utf8');
      } catch { /* 落盘失败不影响内存里的结果 */ }
    }
    return a;
  }

  async function profileFor({ maxChars = 400 } = {}) {
    try {
      const a = await build();
      return a && !a.empty ? buildOwnProfileText(a, { maxChars }) : '';
    } catch { return ''; }
  }

  async function summary() {
    return summaryOf(await build());
  }

  return { root, file, build, profileFor, summary, reset() { cache = null; cacheAt = 0; } };
}
