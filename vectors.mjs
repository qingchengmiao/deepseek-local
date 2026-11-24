// 确定性哈希嵌入 + 向量库（零依赖、不调模型、不需要联网）
//
// 为什么这么做：
//   DeepSeek 没有 embeddings 接口（v1/embeddings 返回 404），而本机 ollama 不一定在。
//   所以这里用**纯函数**把文本变成向量：同一条文本永远得到同一个向量，不需要模型、不需要
//   网络、不需要首字延迟。原理是「特征哈希 + 随机符号投影」（hashing trick / sign random
//   projection，思路借鉴 dsh-neural-memory 的 embedTextHybrid）：
//     - 汉字按 1/2/3 元组切（权重 0.5 / 1.0 / 1.0），英文按词切
//     - 每个特征哈希两次，投到两个维度上，符号由哈希最高位决定（±1）
//     - 加权累加后 L2 归一化，余弦相似度就等价于点积
//
// 它能做什么：找「说的是同一件事但用词不同」的对话片段（语义近邻），比 BM25 的词面匹配宽。
// 它不能做什么：它不懂语义。同义词（「卡死」vs「卡住」）不会自己靠近，只能靠二元组部分重合；
//   真正的语义召回还是得靠模型向量。这点别自欺。
//
// 存储形态：int8 量化（量化误差 ≤ 1/254，余弦上噪声 ~0.2%），一维 256 维只占 256 字节，
//   一万条片段 2.5MB，直接进 JSON 也不用 gzip。

export const VEC_DIM = 256;

const K_SALT = 0x9e3779b1;
const V_SALT = 0x85ebca6b;
const PROJECTIONS = 2;
const SCALE = 1 / Math.SQRT2; // 两次投影，单次权重压一下，避免同向叠加放大

// n=1/2/3 的权重：单字信息量低（「的」「我」到处都是），二字三字才是语义单元
const NGRAM_W = [0.5, 1.0, 1.0];

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const CJK_RUN_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g;
const WORD_RE = /[a-z0-9_][a-z0-9_./:#-]*/g;

// 虚词表：整串都是这些字的 gram 降权（参考 dsh-neural-memory 的 STOP_CHARS）
const STOP_CHARS = new Set('的了是在有和与及或把被对从向个这那哪谁什么么呢吧啊吗呀很也都就还又才我你他她它咱们'.split(''));
const STOP_WORDS = new Set('a an the and or but if then of to in on at for with is are was were be been it its this that these those as by from not no'.split(' '));

function fnv1a(str, seed = 0) {
  let h = (0x811c9dc5 ^ (seed >>> 0)) >>> 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h = Math.imul(h ^ (c & 0xff), 0x01000193) >>> 0;
    h = Math.imul(h ^ (c >>> 8), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// murmur3 fmix32：把低位和高位都搅散，否则 % dim 会偏
function mix32(h) {
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** 归一化：NFKC（全角转半角）、小写、去掉大多数符号（保留 + # . _ / : - 这些在代码/路径里有意义） */
export function normalizeForEmbed(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#._/:\-\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isStopGram(g) {
  for (const ch of g) if (!STOP_CHARS.has(ch)) return false;
  return true;
}

/** 抽特征：返回 Map<特征串, 权重>，同特征取最大权重（不是累加，避免长文里的高频词统治向量） */
export function featuresOf(text) {
  const s = normalizeForEmbed(text);
  const feats = new Map();
  const put = (key, w) => {
    if (!(w > 0)) return;
    const old = feats.get(key);
    if (old === undefined || w > old) feats.set(key, w);
  };

  // 汉字 + 日文假名 + 韩文：1/2/3 元组
  for (const run of s.match(CJK_RUN_RE) || []) {
    for (let n = 1; n <= 3; n++) {
      if (run.length < n) break;
      for (let i = 0; i + n <= run.length; i++) {
        const g = run.slice(i, i + n);
        let w = NGRAM_W[n - 1] * SCALE;
        if (isStopGram(g)) w *= 0.4;
        put(`c${n}:${g}`, w);
      }
    }
  }

  // 拉丁词/数字/标识符：词频用 1+ln(tf) 次线性放大
  const tf = new Map();
  for (const w0 of s.match(WORD_RE) || []) {
    if (w0.length < 2 && !CJK_RE.test(w0)) {
      // 单字母词（a / i）没信息量，除非数字
      if (!/\d/.test(w0)) continue;
    }
    tf.set(w0, (tf.get(w0) || 0) + 1);
  }
  for (const [w0, n] of tf) {
    let base;
    if (STOP_WORDS.has(w0)) base = 0.35 * SCALE;
    else if (/[_/.#:\d-]/.test(w0)) base = 1.85 * SCALE; // 路径/版本号/函数名
    else base = 1.25 * SCALE;
    put(`w:${w0}`, base * (1 + Math.log(n)));
  }

  return feats;
}

/** 浮点向量（查询侧用）。返回 { vec:Float32Array, norm:number } */
export function embedFloat(text, dim = VEC_DIM) {
  const vec = new Float32Array(dim);
  const feats = featuresOf(text);
  for (const [key, w] of feats) {
    for (let p = 0; p < PROJECTIONS; p++) {
      const h = mix32(fnv1a(key, p === 0 ? K_SALT : (K_SALT + p * 0x27d4eb2d) >>> 0));
      const idx = h % dim;
      const sign = (h >>> 31) ? -1 : 1;
      vec[idx] += sign * w;
    }
  }
  let sum = 0;
  for (let i = 0; i < dim; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < dim; i++) vec[i] /= norm;
  return { vec, norm: norm > 0 ? 1 : 0 };
}

/** 量化成 int8（索引侧用）：值域 −127..127，配一个 L2 范数一起存 */
export function embedQuant(text, dim = VEC_DIM) {
  const { vec } = embedFloat(text, dim);
  const q = new Int8Array(dim);
  let sum = 0;
  for (let i = 0; i < dim; i++) {
    const v = Math.max(-1, Math.min(1, vec[i]));
    const qi = Math.round(v * 127);
    q[i] = qi;
    sum += qi * qi;
  }
  return { q, norm: Math.sqrt(sum) };
}

export function quantToB64(q) {
  return Buffer.from(q.buffer, q.byteOffset, q.byteLength).toString('base64');
}

export function quantFromB64(b64) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  // 长度不对就是坏数据（旧版本 / 截断），返回 null 让调用方跳过
  if (buf.byteLength !== VEC_DIM) return null;
  return new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** 余弦：q 已归一化（|q|=1），所以点积除以条目的 int8 范数就是 cos */
export function cosineInt8(qFloat, eQ, eNorm) {
  if (!qFloat || !eQ || !eNorm) return 0;
  let dot = 0;
  for (let i = 0; i < qFloat.length; i++) dot += qFloat[i] * eQ[i];
  return dot / eNorm;
}

/**
 * 覆盖率（借鉴 dsh-neural-memory 的 coverage 闸）：
 * 查询的「实词二元组」有多少出现在这段文本里。用来看这段是不是真在说同一件事，
 * 而不是靠一两个高频词撞上。
 */
export function coverageOf(query, target) {
  const qb = bigramSet(query);
  if (!qb.size) return 1; // 查询里没有汉字二元组（纯英文/纯数字），不设门槛
  const tb = bigramSet(target);
  let hit = 0;
  for (const g of qb) if (tb.has(g)) hit++;
  return hit / qb.size;
}

function bigramSet(text) {
  const s = normalizeForEmbed(text);
  const out = new Set();
  for (const run of s.match(CJK_RUN_RE) || []) {
    for (let i = 0; i + 1 < run.length; i++) {
      const g = run.slice(i, i + 2);
      if (!isStopGram(g)) out.add(g);
    }
  }
  return out;
}

/** 一次算齐：给检索结果打分用 */
export function similarity(queryFloat, entry) {
  const score = cosineInt8(queryFloat, entry.q, entry.norm);
  return {
    score,
    coverage: coverageOf(entry.queryText || '', entry.text || ''),
  };
}

// ---------------------------------------------------------------------------
// 片段指纹（64 位 bloom）：粗排阶段用。
//
// 为什么需要它：单纯用向量粗排（取 cos 前 240）会把「词面对得上但向量分不高」的片段直接
// 丢掉——实测召回率只有 3%。而最终打分又是靠词面覆盖率，等于把好东西在门口筛掉了。
// 所以粗排改成「词面指纹 + 向量」混合：每个汉字二元组打 3 个 bit 进 64 位，
// 查询和片段做按位与、数 popcount，就是「这个片段里出现了查询的多少词」。
// 只存两个 uint32（8 B/片段），比存倒排表省得多。
// ---------------------------------------------------------------------------

export const BLOOM_BITS = 64;

/** 文本 → 64 位 bloom（[lo, hi] 两个 uint32），只用非虚词汉字二元组 + 英文词 */
export function bloomOf(text) {
  let lo = 0;
  let hi = 0;
  const grams = bigramSet(text);
  const words = normalizeForEmbed(text).match(WORD_RE) || [];
  for (const g of grams) {
    for (let k = 0; k < 3; k++) {
      const b = mix32(fnv1a(g, 0x51ed2701 + k * 0x9e3779b1)) % BLOOM_BITS;
      if (b < 32) lo = (lo | (1 << b)) >>> 0;
      else hi = (hi | (1 << (b - 32))) >>> 0;
    }
  }
  // 英文/路径这类查询没有汉字二元组，得靠词
  for (const w of words) {
    if (w.length < 2) continue;
    const b = mix32(fnv1a(w, 0x2545f491)) % BLOOM_BITS;
    if (b < 32) lo = (lo | (1 << b)) >>> 0;
    else hi = (hi | (1 << (b - 32))) >>> 0;
  }
  return [lo >>> 0, hi >>> 0];
}

export function popcount32(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(x, 0x01010101) >>> 24) & 0xff;
}

/** 查询指纹命中比例（0..1）；qPop 是查询自己的 bit 数 */
export function bloomScore(qLo, qHi, cLo, cHi, qPop) {
  if (!qPop) return 0;
  return (popcount32((qLo & cLo) >>> 0) + popcount32((qHi & cHi) >>> 0)) / qPop;
}

