// 把导入的图片全部交给浏览器真解码一遍：能解码 = 页面一定能显示
// 用法：node tools/audit-decode.mjs
import { launch } from './cdp.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const j = async p => {
  const r = await fetch(BASE + p, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${p} → HTTP ${r.status}`);
  return r.json();
};

const state = await j('/api/state');
const urls = new Set();
const byConv = new Map();
for (const c of state.conversations || []) {
  const d = await j('/api/conversations/' + c.id);
  const conv = d.conversation || d;
  let n = 0;
  for (const m of conv.messages || []) {
    for (const a of m.attachments || []) {
      if (a.kind === 'image' && a.url) { urls.add(a.url); n++; }
    }
  }
  if (n) byConv.set(c.title, n);
}
const list = [...urls];
console.log(`图片 URL 去重后 ${list.length} 个，来自 ${byConv.size} 个会话`);

const b = await launch({ port: 9338, width: 1280, height: 900 });
let ok = 0;
const failed = [];
const t0 = Date.now();
try {
  await b.goto(BASE + '/');
  const CHUNK = 40;
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    const r = await b.ev(`(async () => {
      const urls = ${JSON.stringify(chunk)};
      const out = { ok: 0, bad: [], widths: [] };
      await Promise.all(urls.map(u => new Promise(res => {
        const im = new Image();
        im.onload = () => { out.ok++; out.widths.push(im.naturalWidth); res(); };
        im.onerror = () => { out.bad.push(u); res(); };
        im.src = u;
      })));
      return out;
    })()`);
    ok += r.ok;
    for (const u of r.bad) failed.push(u);
    process.stdout.write(`\r解码进度 ${Math.min(i + CHUNK, list.length)}/${list.length}（成功 ${ok}）`);
  }
} finally {
  await b.close();
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n\n结果：${ok} / ${list.length} 张能在浏览器里解码（${secs}s，平均 ${(list.length / secs).toFixed(1)} 张/秒）`);
if (failed.length) {
  console.log(`失败 ${failed.length} 张：`);
  failed.slice(0, 20).forEach(u => console.log('  ✗ ' + u));
}
console.log('\n有图的会话：' + [...byConv.entries()].map(([t, n]) => `${t} ${n}`).join(' · '));
