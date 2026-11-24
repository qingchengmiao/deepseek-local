// 检索库：把会话切成片段，建两套索引 —— 稀疏词面（BM25）+ 确定性哈希向量。
//
// 设计取舍（看完再改代码）：
// - **两套索引各有分工**：词面负责「关键词/路径/报错原文」，向量负责「换了说法但意思一样」。
//   实测纯哈希向量在中文短查询上几乎没用（recall@1 13%），纯词面 79% —— 所以词面是主、向量是辅，
//   粗排用词面，最后再掺向量分。反过来做（先向量粗排）会把词面命中在门口筛掉。
// - **存片段正文（前 320 字）**：不存正文就得每次搜索现读会话 JSON（44MB），而且没法算 IDF。
//   320 字足够覆盖命中范围，索引文件约 1KB/片段。
// - **IDF 在加载时现算**：postings 从片段正文现建（一次 ~300ms，之后常驻），过期靠 `builtAt|条数` 判定。
// - **按会话签名增量**：`updatedAt|消息条数` 变了才重算这个会话的片段。
//
// 三道闸门：`score >= minScore`、`coverage >= minCoverage`、`top1 - top2 >= minMargin`（最后这个只在
// 「模型自动注入」时用：人搜的时候不该因为两句差不多就不给结果）。

import path from 'node:path';
import fsp from 'node:fs/promises';
import { VEC_DIM, embedFloat, embedQuant, quantToB64, quantFromB64, normalizeForEmbed } from './vectors.mjs';

const INDEX_VERSION = 3;
const SNIPPET_CHARS = 320;
const BM25_K1 = 1.2;
const BM25_B = 0.62;
/** 最终分权重：词面为主，向量只在词面打平时帮忙 */
const W_LEX = 0.68;
const W_VEC = 0.32;

/** 汉字/假名/韩文的连续段 */
const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g;
/** 拉丁词/标识符（路径、包名、报错名） */
const LATIN = /[a-z0-9][a-z0-9_./-]{1,}/g;

/** 切 token：汉字二元组 + 拉丁整词。查询和文档走同一套。 */
function tokensOf(text) {
  const s = normalizeForEmbed(text);
  const out = [];
  for (const run of s.match(CJK_RUN) || []) {
    if (run.length === 1) { out.push(run); continue; }
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  for (const w of s.match(LATIN) || []) if (w.length >= 2) out.push(w);
  return out;
}

/** 片段正文里截一段「命中点附近」的预览 */
function snippetAround(text, qTokens) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= SNIPPET_CHARS) return flat;
  let at = -1;
  for (const t of qTokens) {
    const i = flat.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const from = at < 0 ? 0 : Math.max(0, at - 60);
  return (from > 0 ? '…' : '') + flat.slice(from, from + SNIPPET_CHARS) + (from + SNIPPET_CHARS < flat.length ? '…' : '');
}

function emptyState() {
  return { version: INDEX_VERSION, dim: VEC_DIM, sigs: {}, titles: {}, entries: [], builtAt: 0 };
}

/**
 * @param {object} deps
 * @param {string} deps.dataDir
 * @param {() => Promise<Array<{id:string,title?:string}>>} deps.listConversations
 * @param {(id:string) => Promise<any>} deps.loadConversation
 * @param {(msgs:Array, opts:object) => Array<{from:number,to:number,text:string}>} deps.chunkMessages
 */
export function createVectorIndex({ dataDir, listConversations, loadConversation, chunkMessages }) {
  const file = path.join(dataDir, 'vector-index.json');
  let state = null;
  let building = null;
  let postings = null; // { key, df:Map<token,number>, pl:Map<token,Int32Array>, len:Int32Array, avgLen, n }
  let matrix = null; // { key, n, data:Int8Array, norms:Float32Array }

  async function load() {
    if (state) return state;
    const raw = await readJson(file);
    if (raw && raw.version === INDEX_VERSION && raw.dim === VEC_DIM && Array.isArray(raw.entries)) {
      state = {
        version: INDEX_VERSION,
        dim: VEC_DIM,
        sigs: raw.sigs && typeof raw.sigs === 'object' ? raw.sigs : {},
        titles: raw.titles && typeof raw.titles === 'object' ? raw.titles : {},
        entries: raw.entries,
        builtAt: Number(raw.builtAt) || 0,
      };
    } else {
      state = emptyState();
    }
    return state;
  }

  async function readJson(f) {
    try {
      return JSON.parse(await fsp.readFile(f, 'utf8'));
    } catch {
      return null;
    }
  }

  async function save() {
    const tmp = `${file}.tmp`;
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(tmp, JSON.stringify(state), 'utf8');
      await fsp.rename(tmp, file);
    } catch {
      try { await fsp.unlink(tmp); } catch { /* 忽略 */ }
    }
  }

  function sigOf(conv) {
    const n = Array.isArray(conv.messages) ? conv.messages.length : 0;
    return `${Number(conv.updatedAt) || 0}|${n}`;
  }

  function entriesForConv(conv) {
    const msgs = Array.isArray(conv.messages) ? conv.messages : [];
    const chunks = chunkMessages(msgs, { maxTokens: 700, minTokens: 30 }) || [];
    const out = [];
    chunks.forEach((ch) => {
      const text = String(ch.text || '').trim();
      if (text.length < 12) return;
      const { q, norm } = embedQuant(text.slice(0, 4000));
      if (!norm) return;
      const firstMsg = msgs[ch.from] || msgs[0] || {};
      out.push({
        c: String(conv.id),
        f: ch.from,
        t: ch.to,
        ts: Number(firstMsg.createdAt) || Number(conv.updatedAt) || 0,
        v: quantToB64(q),
        n: Math.round(norm * 1000) / 1000,
        s: text.slice(0, SNIPPET_CHARS),
      });
    });
    return out;
  }

  /**
   * 增量建库：只重算签名变了的会话。
   * @param {{force?:boolean}} [opts]
   */
  async function refresh({ force = false } = {}) {
    if (building) return building;
    building = (async () => {
      const st = await load();
      let list = [];
      try { list = (await listConversations()) || []; } catch { list = []; }
      const alive = new Set();
      const nextSig = { ...(force ? {} : st.sigs) };
      const nextTitles = {};
      const kept = force ? [] : st.entries.slice();
      const keptByConv = new Map();
      for (const e of kept) {
        if (!keptByConv.has(e.c)) keptByConv.set(e.c, []);
        keptByConv.get(e.c).push(e);
      }
      const fresh = [];
      for (const item of list) {
        const id = String(item.id || '');
        if (!id) continue;
        alive.add(id);
        nextTitles[id] = String(item.title || '');
        let conv;
        try { conv = await loadConversation(id); } catch { continue; }
        if (!conv) continue;
        nextTitles[id] = String(item.title || conv.title || '');
        const sig = sigOf(conv);
        if (!force && st.sigs[id] === sig && keptByConv.has(id)) continue;
        fresh.push(...entriesForConv(conv));
        nextSig[id] = sig;
      }
      const merged = kept.filter((e) => alive.has(e.c) && !fresh.some((f) => f.c === e.c)).concat(fresh);
      st.entries = merged.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      st.sigs = nextSig;
      st.titles = nextTitles;
      st.builtAt = Date.now();
      postings = null;
      matrix = null;
      await save();
      return { ok: true, entries: st.entries.length, conversations: alive.size, bytes: 0 };
    })();
    try {
      return await building;
    } finally {
      building = null;
    }
  }

  /** 稀疏索引：token -> 片段下标 + 词频，配 docLen 与 avgLen（BM25 用） */
  function buildPostings(st) {
    const key = `${st.builtAt}|${st.entries.length}`;
    if (postings && postings.key === key) return postings;
    const n = st.entries.length;
    const len = new Int32Array(n);
    const pl = new Map();
    const df = new Map();
    let total = 0;
    for (let i = 0; i < n; i++) {
      const toks = tokensOf(st.entries[i].s || '');
      len[i] = toks.length;
      total += toks.length;
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      for (const [t, c] of tf) {
        let arr = pl.get(t);
        if (!arr) { arr = []; pl.set(t, arr); }
        arr.push(i, c);
        df.set(t, (df.get(t) || 0) + 1);
      }
    }
    const packed = new Map();
    for (const [t, arr] of pl) packed.set(t, Int32Array.from(arr));
    postings = {
      key,
      n,
      df,
      pl: packed,
      len,
      avgLen: n ? total / n : 0,
      entries: st.entries,
    };
    return postings;
  }

  /** 向量矩阵：加载时一次性解码，粗排时直接扫（比每次 base64 解码快一个量级） */
  function matrixOf(st) {
    const key = `${st.builtAt}|${st.entries.length}`;
    if (matrix && matrix.key === key) return matrix;
    const n = st.entries.length;
    const data = new Int8Array(n * VEC_DIM);
    const norms = new Float32Array(n);
    let keep = 0;
    for (let i = 0; i < n; i++) {
      const e = st.entries[i];
      const v = quantFromB64(e.v);
      if (!v) continue;
      data.set(v, keep * VEC_DIM);
      norms[keep] = Number(e.n) || 0;
      keep++;
    }
    matrix = { key, n: keep, data, norms };
    return matrix;
  }

  /**
   * 搜：词面 BM25 出分 → 前 coarse 个算精确覆盖率 + 向量余弦 → 混合排序。
   * @returns {Promise<{hits:Array, scanned:number, entries:number, ms:number}>}
   */
  async function search(q, { topK = 30, coarse = 240, minScore = 0.12, minCoverage = 0.3, needMargin = 0 } = {}) {
    const t0 = Date.now();
    const query = String(q || '').trim();
    const st = await load();
    if (!query || !st.entries.length) return { hits: [], scanned: 0, entries: st.entries.length, ms: 0 };
    const px = buildPostings(st);
    const qTokens = tokensOf(query);
    const qSet = new Set(qTokens);
    if (!qSet.size) return { hits: [], scanned: 0, entries: st.entries.length, ms: 0 };

    // BM25：只累加命中的片段（稀疏），没命中词面的片段不进入候选
    const scores = new Map();
    for (const t of qSet) {
      const arr = px.pl.get(t);
      if (!arr) continue;
      const df = px.df.get(t) || 1;
      const idf = Math.log(1 + (px.n - df + 0.5) / (df + 0.5));
      for (let i = 0; i < arr.length; i += 2) {
        const idx = arr[i];
        const tf = arr[i + 1];
        const dl = px.len[idx] || 1;
        const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / (px.avgLen || 1));
        const add = idf * ((tf * (BM25_K1 + 1)) / (denom || 1));
        scores.set(idx, (scores.get(idx) || 0) + add);
      }
    }
    const order = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const shortlist = order.slice(0, Math.max(1, coarse));
    const bestLex = shortlist.length ? shortlist[0][1] : 0;

    const qf = embedFloat(query);
    const mx = matrixOf(st);
    const hits = [];
    for (const [idx, lexScore] of shortlist) {
      const e = st.entries[idx];
      const text = e.s || '';
      // 精确覆盖率：查询词有多少比例出现在片段里（闸门用）
      let hit = 0;
      for (const t of qSet) if (text.includes(t)) hit++;
      const coverage = qSet.size ? hit / qSet.size : 0;
      if (coverage < minCoverage) continue;
      let cos = 0;
      if (idx < mx.n) {
        let dot = 0;
        const base = idx * VEC_DIM;
        for (let d = 0; d < VEC_DIM; d++) dot += qf.vec[d] * mx.data[base + d];
        const norm = mx.norms[idx];
        cos = norm > 0 ? dot / norm : 0;
      }
      const lexNorm = bestLex > 0 ? lexScore / bestLex : 0;
      const score = W_LEX * lexNorm + W_VEC * Math.max(0, cos);
      if (score < minScore) continue;
      hits.push({
        conversationId: e.c,
        title: st.titles[e.c] || '',
        from: e.f,
        to: e.t,
        ts: e.ts,
        score,
        cosine: cos,
        coverage,
        bm25: lexScore,
        snippet: snippetAround(st.entries[idx].s, qTokens),
      });
    }
    hits.sort((a, b) => b.score - a.score);

    let out = hits;
    if (needMargin > 0 && hits.length >= 2) {
      const margin = hits[0].score - hits[1].score;
      if (margin < needMargin) out = [];
    }
    return { hits: out.slice(0, Math.max(1, topK)), scanned: shortlist.length, entries: st.entries.length, ms: Date.now() - t0 };
  }

  async function status() {
    const st = await load();
    let bytes = 0;
    try { bytes = (await fsp.stat(file)).size; } catch { /* 还没建 */ }
    const byConv = new Map();
    for (const e of st.entries) byConv.set(e.c, (byConv.get(e.c) || 0) + 1);
    return {
      ok: true,
      file,
      dim: st.dim,
      version: st.version,
      entries: st.entries.length,
      conversations: Object.keys(st.sigs).length,
      bytes,
      builtAt: st.builtAt || 0,
      perConv: [...byConv.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id, n]) => ({ id, chunks: n })),
    };
  }

  async function reset() {
    state = emptyState();
    postings = null;
    matrix = null;
    await save();
    return { ok: true, entries: 0 };
  }

  return { file, refresh, search, status, reset, _state: () => state };
}

export default { createVectorIndex };
