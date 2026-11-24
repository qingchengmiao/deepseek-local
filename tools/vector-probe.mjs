// 向量库探针：不用起服务，直接在命令行建索引、跑几条查询看分数分布。
// 用途：①第一次建库看耗时和体积 ②调闸门阈值（minScore / minCoverage）③比对词面检索
//
// node tools/vector-probe.mjs [会话目录] [查询1] [查询2] ...

import path from 'node:path';
import fsp from 'node:fs/promises';
import { createVectorIndex } from '../vector-index.mjs';
import { chunkMessages } from '../context.mjs';

const convDir = process.argv[2] || path.join(process.cwd(), 'dist', 'DeepSeek-win32-x64', 'data', 'conversations');
const queries = process.argv.slice(3);
const dataDir = path.join(process.cwd(), 'data', '_vecprobe');

async function listConversations() {
  const files = await fsp.readdir(convDir);
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    out.push({ id: path.basename(f, '.json') });
  }
  return out;
}

async function loadConversation(id) {
  const file = path.join(convDir, `${id}.json`);
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

const t0 = Date.now();
const idx = createVectorIndex({ dataDir, listConversations, loadConversation, chunkMessages });
const r = await idx.refresh();
const st = await idx.status();
console.log(`建库 ${Date.now() - t0}ms`, JSON.stringify({ ...r, ...st, perConv: undefined }));

if (!queries.length) {
  queries.push('QQ 图片看不到', '自学习 群聊 画像', '首字 卡死 性能', '浏览器指纹 伪装成真机');
}

for (const q of queries) {
  const t = Date.now();
  const { hits, entries } = await idx.search(q, { topK: 6, minScore: 0, minCoverage: 0 });
  console.log(`\n=== ${q}  (${Date.now() - t}ms, 片段库 ${entries})`);
  for (const h of hits) {
    console.log(
      `  ${h.score.toFixed(3)}  cos=${h.cosine.toFixed(3)} lex=${h.coverage.toFixed(2)}  ${String(h.title).slice(0, 18)} [${h.from}-${h.to}]`
    );
    console.log(`      ${h.snippet.slice(0, 90)}`);
  }
}
