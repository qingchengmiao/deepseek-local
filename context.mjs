// 上下文管理：token 估算、分段、本地词面索引（BM25）、时间衰减、压缩摘要、原文归档
//
// 说明（写给以后看代码的人，也写给用户）：
// - DeepSeek 没有 embeddings 接口（v1/embeddings 返回 404），所以检索默认走**本地词面索引**
//   （汉字二元组 + 英文单词，词表即维度，BM25 打分）。这是词面匹配，不是语义匹配。
// - 如果想要语义召回，可以放一个向量 gguf（bge / gte / minilm 之类）到 data/models：
//   归档片段会存一份稠密向量，查询时和 BM25 分数混合排序。模型不可用时自动退回纯 BM25。
// - 时间衰减用半衰期：weight = 0.5 ** (ageDays / halfLifeDays)。老的片段在召回排序里被压下去。
// - 压缩摘要优先用本机小模型（进程内跑 gguf，2026-11-25 起不再走 ollama 端口），没有就退回 DeepSeek API，
//   都不可用时降级丢掉老消息。

export const CTX_DEFAULTS = {
  ctxCompress: true, // 自动压缩
  ctxBudget: 24000, // 上下文预算（token）
  ctxHotRatio: 0.6, // 最近原文占预算的比例
  ctxMinCompress: 1200, // 老消息累计超过这么多 token 才值得压缩
  ctxRag: true, // 向量检索
  ctxTopK: 4, // 每次召回几条
  ctxHalfLifeDays: 30, // 时间衰减半衰期（天）
  ctxTrimChars: 240, // 超过一个半衰期的长消息，正文压到这么长
  ctxRagMinScore: 0.08,
  // ---- 摘要与归档
  ctxSummarizer: 'auto', // auto | local | api —— 压缩摘要用谁写
  ctxLocalModel: '', // 留空 = 自动挑一个最小的对话模型（data/models 里的 gguf）
  ctxAutoPull: true, // 本机没可用小模型时，自动从国内镜像拉一个
  ctxEmbedModel: 'auto', // auto | off | 具体模型名（如 nomic-embed-text）
  ctxArchive: true, // 压缩前把原文另存成 JSON，并纳入检索
  // ---- 渐进压缩与记忆激活
  ctxStepRatio: 0.33, // 占用每涨 33% 压一档（记一条概要）
  ctxForgetRatio: 0.5, // 占用到 50% 起按时间权重概括，老段转为「遗忘」（只留关键词，原文还在归档里）
  ctxProgressive: true, // 记忆渐进激活：先给关键词索引卡，需要时才展开原文
  ctxActivateScore: 0.2, // 相关度高于这个就直给片段，低于就只给索引卡等「展开」
};

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const CJK_RUN_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g;
const WORD_RE = /[a-z0-9_]+/g;

export const DIMS = 512;

// ---------------------------------------------------------------- token 估算

/** 粗估 token：汉字按 1 个算，其余字符按 3.6 个字符 1 个 token。偏保守，宁多不少。 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (CJK_RE.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 1.05 + other / 3.6);
}

// 一条消息的 token 估算会被反复问到（热区边界、预算、压缩判断每轮都要走几千条），
// 正文没变就直接用上次的数。用 WeakMap：消息对象被回收，缓存跟着走。
const tokCache = new WeakMap();

/** 一条消息的 token 估算：正文 + 思考（打折，因为不回传上游）+ 附件/媒体（按张数估） */
export function estimateMessageTokens(m) {
  if (!m) return 0;
  const sig = `${typeof m.content === 'string' ? m.content.length : 0}|${m.reasoning ? m.reasoning.length : 0}|${(m.attachments || []).length}`;
  const hit = tokCache.get(m);
  if (hit && hit.sig === sig) return hit.t;
  let t = estimateTokens(m.content);
  if (m.reasoning) t += Math.ceil(estimateTokens(m.reasoning) * 0.15);
  for (const a of m.attachments || []) {
    if (a.kind === 'image') t += 800;
    else if (a.kind === 'video' || a.kind === 'audio') t += 800 * (Array.isArray(a.frames) ? a.frames.length : 0) + estimateTokens(a.text);
    else t += 3000;
  }
  tokCache.set(m, { sig, t });
  return t;
}

export function estimateMessagesTokens(messages) {
  return (messages || []).reduce((n, m) => n + estimateMessageTokens(m), 0);
}

// ---------------------------------------------------------------- 分词 / 向量

export function tokenize(text) {
  const lower = String(text ?? '').toLowerCase();
  const out = [];
  for (const w of lower.match(WORD_RE) || []) if (w.length > 1) out.push(w);
  for (const run of lower.match(CJK_RUN_RE) || []) {
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function l2normalize(map) {
  let sum = 0;
  for (const v of map.values()) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  const pairs = [];
  for (const [d, v] of map) pairs.push([d, Math.round((v / norm) * 1e5) / 1e5]);
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs;
}

/** chunk = 连续几条消息拼起来的一段；maxTokens 控制粒度 */
export function chunkMessages(messages, { maxTokens = 700, minTokens = 30 } = {}) {
  const chunks = [];
  let cur = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const body = String(m.content || '').trim();
    if (!body) continue;
    const text = (m.role === 'user' ? '我：' : '助手：') + body;
    const t = estimateTokens(body);
    if (cur && cur.tokens + t > maxTokens && cur.tokens >= minTokens) {
      chunks.push(cur);
      cur = null;
    }
    if (!cur) cur = { from: i, to: i, tokens: 0, parts: [] };
    cur.to = i;
    cur.tokens += t;
    cur.parts.push(text.length > 1200 ? text.slice(0, 1200) + '…' : text);
  }
  if (cur) chunks.push(cur);
  return chunks.map(c => ({ from: c.from, to: c.to, tokens: c.tokens, text: c.parts.join('\n') }));
}

/**
 * 在 chunks 上建索引（纯本地）：词表做维度 + BM25 词频，不哈希降维。
 * 检索用 BM25 打分（按查询词覆盖率归一），比余弦更稳：短查询也能命中，噪声也压得住。
 */
export function buildIndex(chunks) {
  const tokenized = chunks.map(c => tokenize(c.text));
  const df = new Map();
  for (const toks of tokenized) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = chunks.length || 1;
  const idf = new Map();
  for (const [t, n] of df) idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));

  const terms = new Map();
  for (const t of df.keys()) terms.set(t, terms.size);

  const lens = tokenized.map(t => t.length || 1);
  const avgLen = lens.reduce((a, b) => a + b, 0) / (lens.length || 1);

  const withVec = chunks.map((c, i) => {
    const tf = new Map();
    for (const t of tokenized[i]) tf.set(t, (tf.get(t) || 0) + 1);
    // 存「词 id -> 原始词频」，打分时现算 BM25；vec 保留给旧调用（余弦）用
    const tfs = new Map();
    const vec = new Map();
    for (const [t, f] of tf) {
      const id = terms.get(t);
      tfs.set(id, f);
      const w = (idf.get(t) || 0) * (f / (f + 1.2 * (0.25 + 0.75 * (lens[i] / avgLen))));
      if (w > 0) vec.set(id, w);
    }
    return { ...c, tfs, vec: l2normalize(vec) };
  });

  return {
    version: 1,
    dims: terms.size,
    size: withVec.length,
    chunks: withVec,
    terms,
    idf,
    avgLen,
    builtAt: Date.now(),
  };
}

export function embedQuery(index, text) {
  const toks = tokenize(text);
  if (!toks.length || !index || !index.chunks.length) return [];
  const tf = new Map();
  for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
  const N = index.chunks.length;
  const maxIdf = Math.log(1 + (N + 0.5) / 0.5);
  const map = new Map();
  for (const [t, f] of tf) {
    const id = index.terms ? index.terms.get(t) : undefined;
    if (id === undefined) continue;
    const idf = index.idf && index.idf.has(t) ? index.idf.get(t) : maxIdf;
    map.set(id, (map.get(id) || 0) + idf);
  }
  return l2normalize(map);
}

/**
 * BM25 覆盖率打分（0..1）：
 * - 分母是「查询里所有词」的满权重，不管这些词在这一段里有没有出现
 * - 分子只累计实际出现的词，词频用 BM25 饱和，长段自动降权
 * 这样查「蓝鲸心率」不会因为只有「心率」撞上就拿到高分；OOV 词也会拉低分数。
 */
export function bm25Score(index, chunk, queryTerms, k1 = 1.2, b = 0.75) {
  const uniq = [...new Set(queryTerms)];
  if (!uniq.length || !chunk || !chunk.tfs) return 0;
  const maxIdf = Math.log(1 + ((index.size || 1) + 0.5) / 0.5);
  const len = chunk.tokens || 1;
  const avg = index.avgLen || 300;
  let hitW = 0;
  let totalW = 0;
  for (const t of uniq) {
    const idf = index.idf.get(t);
    const w = idf ? Math.min(1, idf / maxIdf) : 1;
    totalW += w;
    if (!idf) continue;
    const f = chunk.tfs.get(index.terms.get(t));
    if (!f) continue;
    const sat = f / (f + k1 * (1 - b + b * (len / avg)));
    hitW += w * sat;
  }
  return totalW > 0 ? hitW / totalW : 0;
}

/**
 * 时间衰减：halfLifeDays 天后权重减半。细节在「逐时间降低对话权重」里用它。
 */
export function decayWeight(ageDays, halfLifeDays) {
  const hl = Math.max(0.5, Number(halfLifeDays) || 7);
  return Math.pow(0.5, Math.max(0, Number(ageDays) || 0) / hl);
}

export function retrieve({ index, query, topK = 4, weightOf = () => 1, minScore = 0.05, upto = Infinity }) {
  if (!index || !index.chunks.length) return [];
  const queryTerms = tokenize(query);
  if (!queryTerms.length) return [];
  // 这些词一个都不在索引里，捞不出东西
  if (!queryTerms.some(t => index.terms.has(t))) return [];
  const scored = [];
  index.chunks.forEach((c, i) => {
    if (i >= upto) return;
    const base = bm25Score(index, c, queryTerms);
    // 阈值只看相关度：时间衰减只影响排序优先级，不该把老内容直接判死
    if (base < minScore) return;
    const score = base * (weightOf(c, i) ?? 1);
    scored.push({ chunk: c, index: i, score, base });
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, topK));
}

// ---------------------------------------------------------------- 压缩摘要

export const MEMORY_MARKER = '你是上下文压缩器';
export const MEMORY_SYSTEM = `${MEMORY_MARKER}。你在给未来的自己留一张交接便条 —— 未来的你读不到这段对话，只有这张便条。

开头第一行固定写：这份便条可以被推翻，以眼前证据为准。

要求：
- 只写对话里真出现过的东西，不许推测、不许补全、不许替自己圆场
- **证据分级**：能指到具体工具输出 / 文件 / 行号 / 命令结果的，写成「已验证：…」并带上那个证据（路径、行号、数字）；只是推断、没跑过的，写成「⚠️ 未验证：…」。不要把推断写成事实
- 保留：确定的数字与路径、已做出的决定**及理由**、用户的偏好与硬性要求、踩过的坑与断掉的死路（以及为什么断）
- 丢掉：寒暄、重复、临时试错、已经从上下文里消失的中间产物
- 用密集条目，不要分段散文；总长 200～900 字
- 如果给了【已有记忆】，把新内容合并进去（新的覆盖旧的），不要重复；旧条目如果被这次对话推翻了，改写成新的结论并注明推翻了什么

输出格式（没有内容的段落写「无」）：
## 事实
## 决定与理由
## 偏好与要求
## 未完成与待验证（专记没做成、没验成、还欠着的东西）
## 关键词索引（每行：关键词 → 说的是什么）`;

/** 惊讶度：新便条里有多少内容是旧便条没有的（0=完全重复，1=全新）。用汉字/字母二元组覆盖率当代理，不调模型。 */
export function memoryNovelty(prevText, nextText) {
  const a = String(prevText || '');
  const b = String(nextText || '');
  if (!a.trim()) return 1;
  if (!b.trim()) return 0;
  const grams = (s) => {
    const set = new Set();
    const t = s.replace(/[^\p{L}\p{N}]+/gu, '');
    for (let i = 0; i + 1 < t.length; i++) set.add(t.slice(i, i + 2));
    return set;
  };
  const gb = grams(b);
  if (!gb.size) return 0;
  const ga = grams(a);
  let hit = 0;
  for (const g of gb) if (ga.has(g)) hit += 1;
  return Math.round((1 - hit / gb.size) * 1000) / 1000;
}

export function memoryUserPrompt(previous, transcript, limitChars = 24000) {
  const prev = String(previous || '').trim();
  let body = String(transcript || '').trim();
  if (body.length > limitChars) body = body.slice(0, limitChars) + '\n…（更早的部分已省略）';
  return `${prev ? `【已有记忆】\n${prev}\n\n` : ''}【旧对话】\n${body}`;
}

// ---------------------------------------------------------------- 时间加权概括（第二级）

export const CONSOLIDATE_MARKER = '你是长期记忆整理器';
export const CONSOLIDATE_SYSTEM = `${CONSOLIDATE_MARKER}。你在把【分段记忆】和【原文节选】并成一张更短的交接便条，给未来的自己用 —— 它会被后来的证据推翻，所以每条都要能追溯。

开头第一行固定写：这份便条可以被推翻，以眼前证据为准。

要求：
- 只写出现过的内容，不许推测、不许补全
- **按时间权重处理**：越靠前的段越简略（可能只留一句或一个数字），越靠后的段保留细节
- 半衰期以外的老内容，只保留「以后还可能有用的结论」（人名/数字/偏好/未完成的决定），过程一律丢掉
- **证据分级**：能指到具体工具输出 / 文件 / 行号 / 命令结果的，写「已验证：…」并带证据；只是推断的写「⚠️ 未验证：…」
- 被这次对话推翻的旧结论，改写成新结论并注明「推翻了：…」
- 每条保留一句「关键词：…」，方便以后按关键词把原文找回来
- 总长 150～600 字

输出格式：
## 长期事实
## 已定的事（理由可省）
## 偏好与硬要求
## 未完成与待验证（专记没做成、没验成、还欠着的东西）
## 关键词索引（每行：关键词 → 说的是什么）`;

export function consolidateUserPrompt(prevText, records, transcript, limitChars = 20000) {
  const segs = (records || [])
    .map((r, i) => `【分段 #${i + 1}】第 ${r.from + 1}–${r.to + 1} 条 · 关键词 ${r.keywords || '—'}\n${String(r.gist || '').slice(0, 800)}`)
    .join('\n\n');
  let body = String(transcript || '').trim();
  if (body.length > limitChars) body = body.slice(0, limitChars) + '\n…（更早的部分已省略）';
  return `${prevText ? `【当前记忆】\n${prevText}\n\n` : ''}${segs ? `${segs}\n\n` : ''}${body ? `【原文节选】\n${body}` : ''}`;
}

/** 从一段文本里抽关键词（给记忆索引卡用）：按词频排序，去掉太短的与纯数字噪声 */
const STOP_CHARS = new Set('的了是我你他她它在不也就都还有和或与这那哪个些么什上下大小多少来去说要想会能看做得过把被给从对到很再又已但却因为如果所以一次段轮这样子'.split(''));
// 含这些字的二元组基本是跨词边界切出来的：把数、本的、部先、的了……
const HARD_STOP = new Set('把被给得对从向在的了着过于是就不也都要会能可还这那个些么什与和或'.split(''));
function junkTerm(term) {
  if ([...term].some(ch => HARD_STOP.has(ch))) return true;
  return [...term].every(ch => STOP_CHARS.has(ch));
}
export function keywordsOf(text, max = 8) {
  const freq = new Map();
  for (const term of tokenize(String(text || '').slice(0, 12000))) {
    if (term.length < 2) continue;
    if (/^\d+$/.test(term)) continue;
    // 汉字二元组里，两个字都是虚词/高频字的，基本是跨词边界切出来的噪声
    if (junkTerm(term)) continue;
    freq.set(term, (freq.get(term) || 0) + 1);
  }
  return [...freq.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([t]) => t);
}

/** 解析「展开第 3 条 / 展开 #3 / 恢复记忆 3」这类指令，返回 1-based 序号或 0 */
export function parseActivateRequest(text) {
  const s = String(text || '');
  const m = s.match(/展开(?:记忆|片段)?\s*(?:第)?\s*#?(\d{1,3})\s*(?:条|段)?/) || s.match(/恢复(?:记忆|片段)?\s*(?:第)?\s*#?(\d{1,3})\s*(?:条|段)?/);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 && n <= 200 ? n : 0;
}

/**
 * 按「出现在几条消息里」抽关键词：跨消息都出现的词才像主题，单条里重复几十遍的不算。
 * 给记忆概要打索引标签用（关键词提示的第一步：没看到原文也能知道这段在讲什么）。
 */
export function keywordsFromMessages(texts, max = 8) {
  const df = new Map();
  for (const t of texts || []) {
    const seen = new Set();
    for (const term of tokenize(String(t || '').slice(0, 8000))) {
      if (term.length < 2) continue;
      if (/^\d+$/.test(term)) continue;
      if (junkTerm(term)) continue;
      if (seen.has(term)) continue;
      seen.add(term);
      df.set(term, (df.get(term) || 0) + 1);
    }
  }
  return [...df.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([t]) => t);
}

// ---------------------------------------------------------------- 索引缓存（进程内）

const cache = new Map(); // convId -> { key, index }

export function getCachedIndex(conv, messages) {
  // 以前 key 里带 conv.updatedAt，等于每发一条消息就要把几千条重建一遍索引（300ms+）。
  // 改成「长度差不到 8 条就复用」：热区边界挪几条不影响检索，重建频率从每轮降到十几轮一次。
  const len = messages.length;
  const hit = cache.get(conv.id);
  if (hit && Math.abs(len - hit.len) < 8) return hit.index;
  const chunks = chunkMessages(messages);
  const index = buildIndex(chunks);
  cache.set(conv.id, { len, index });
  if (cache.size > 64) cache.delete(cache.keys().next().value);
  return index;
}

export function dropCachedIndex(convId) {
  cache.delete(convId);
}

/** 消息年龄（天）：有 createdAt 用真实时间，没有就按位置线性估算 */
export function messageAgeDays(conv, msg, i, total) {
  const t = Number(msg?.createdAt || 0);
  if (t > 0) return Math.max(0, (Date.now() - t) / 86400000);
  const start = Number(conv.createdAt || 0) || Date.now();
  const end = Number(conv.updatedAt || 0) || start;
  const span = Math.max(0.5, (end - start) / 86400000);
  return span * (1 - (i + 1) / Math.max(1, total + 1)) + 0.01;
}

/** 稠密向量余弦（本机向量 gguf 算出来的用；两向量维度不一致算 0） */
export function cosineDense(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

/** 长消息按时间降权的正文裁剪：保留头部与结尾一小段 */
export function trimByAge(text, ageDays, halfLifeDays, trimChars = 240) {
  const s = String(text || '');
  const w = decayWeight(ageDays, halfLifeDays);
  if (w > 0.5) return { text: s, weight: w, trimmed: false }; // 半衰期内原样
  const keep = Math.max(120, Math.round(trimChars * Math.max(0.2, w) * 2));
  if (s.length <= keep * 1.6) return { text: s, weight: w, trimmed: false };
  return { text: s.slice(0, keep) + '\n…（较早的内容已按时间降权压缩）', weight: w, trimmed: true };
}
