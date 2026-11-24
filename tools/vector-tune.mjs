// 向量参数标定：拿真实会话切片段，从每段里随机截 10 个字当查询，看能不能把自己找回来。
// 这是「召回能不能用」最客观的指标（recall@1 / MRR），比肉眼看几条查询靠谱。
//
// node tools/vector-tune.mjs [会话目录] [样本数]

import path from 'node:path';
import fsp from 'node:fs/promises';
import { chunkMessages } from '../context.mjs';
import { embedFloat, embedQuant, cosineInt8, coverageOf } from '../vectors.mjs';

const convDir = process.argv[2] || path.join(process.cwd(), 'dist', 'DeepSeek-win32-x64', 'data', 'conversations');
const SAMPLES = Number(process.argv[3]) || 24;

const files = (await fsp.readdir(convDir)).filter((f) => f.endsWith('.json') && f !== 'index.json');
const chunks = [];
for (const f of files) {
  let conv;
  try {
    conv = JSON.parse(await fsp.readFile(path.join(convDir, f), 'utf8'));
  } catch {
    continue;
  }
  for (const size of [700, 240]) {
    // 用同一个 conv 分别切两种粒度，后面按 size 分组统计
    const list = chunkMessages(conv.messages || [], { maxTokens: size, minTokens: 20 });
    list.forEach((c, i) => {
      const text = String(c.text || '').trim();
      if (text.length < 60) return;
      chunks.push({ conv: path.basename(f, '.json'), size, i, text, from: c.from, to: c.to });
    });
  }
}

// 固定种子，重跑可比
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const dims = [128, 256, 512];
const results = [];
for (const dim of dims) {
  // 全量量化一遍（每个 dim 一条库）
  const lib = chunks.map((c) => {
    const { q, norm } = embedQuant(c.text.slice(0, 4000), dim);
    return { ...c, q, norm };
  });
  // 抽样：从中文里截 10 字，避开纯标点/数字
  const samples = [];
  const pool = lib.filter((c) => c.size === 700);
  while (samples.length < SAMPLES && pool.length) {
    const c = pool[Math.floor(rnd() * pool.length)];
    const clean = c.text.replace(/\s+/g, ' ');
    const at = Math.floor(rnd() * Math.max(1, clean.length - 12));
    const q = clean.slice(at, at + 10).trim();
    if (q.length >= 6 && /[\u4e00-\u9fff]{4,}/.test(q)) samples.push({ target: c, q });
  }

  for (const wLex of [0, 0.3, 0.5]) {
    let hit1 = 0;
    let mrr = 0;
    for (const { target, q } of samples) {
      const qf = embedFloat(q, dim);
      const scored = lib.map((c) => {
        const cos = cosineInt8(qf.vec, c.q, c.norm);
        const lex = wLex ? coverageOf(q, c.text.slice(0, 1500)) : 0;
        return { c, score: (1 - wLex) * cos + wLex * lex };
      });
      scored.sort((a, b) => b.score - a.score);
      const pos = scored.findIndex((s) => s.c === target);
      if (pos === 0) hit1++;
      if (pos >= 0) mrr += 1 / (pos + 1);
    }
    results.push({ dim, wLex, hit1: hit1 / samples.length, mrr: mrr / samples.length, n: samples.length });
  }
}

console.log(`片段 ${chunks.length}（700 与 240 两种粒度各一套），查询 ${SAMPLES} 条`);
for (const r of results) {
  console.log(`dim=${String(r.dim).padStart(3)} 词面权重=${r.wLex.toFixed(1)}  recall@1=${(r.hit1 * 100).toFixed(0)}%  MRR=${r.mrr.toFixed(3)}`);
}
