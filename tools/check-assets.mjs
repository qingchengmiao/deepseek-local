// 检查 index.html 里引用的每个本地资源是否真的能拿到（404 会让页面白屏/无样式）
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const html = readFileSync('public/index.html', 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1])
  .filter(u => !/^(https?:|data:|#|mailto:)/.test(u));

let bad = 0;
for (const u of [...new Set(refs)]) {
  const path = u.startsWith('/') ? u : '/' + u;
  const r = await fetch(BASE + path);
  const len = Number(r.headers.get('content-length') || 0);
  if (r.status !== 200) { bad++; console.log(`  ✗ ${u} — HTTP ${r.status}`); }
  else console.log(`  ✓ ${u} — ${len}B`);
}
console.log(bad ? `\n${bad} 个资源拿不到` : `\n${refs.length} 个本地资源全部可访问`);
process.exit(bad ? 1 : 0);
