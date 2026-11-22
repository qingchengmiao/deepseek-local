// 补齐 katex.min.css 引用的字体：只抓 woff2（cdnjs 上 ttf 不存在），已存在就跳过
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'vendor', 'fonts');
const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/fonts';

const css = await fs.readFile(path.join(ROOT, 'public', 'vendor', 'katex.min.css'), 'utf8');
const all = [...new Set([...css.matchAll(/url\(fonts\/([^)"']+)\)/g)].map(m => m[1]))];
const want = all.filter(f => f.endsWith('.woff2'));

async function get(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 25000);
      const r = await fetch(url, { signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      last = e;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw last;
}

await fs.mkdir(OUT, { recursive: true });
let ok = 0, skip = 0, fail = 0;
for (const f of want) {
  const dest = path.join(OUT, f);
  try { await fs.access(dest); skip++; continue; } catch {}
  try {
    const buf = await get(`${CDN}/${f}`);
    await fs.writeFile(dest, buf);
    ok++;
  } catch (e) {
    fail++;
    console.log(`✗ ${f}: ${e.message}`);
  }
}
console.log(`woff2 补齐：新下 ${ok} / 已有 ${skip} / 失败 ${fail}（css 共引用 ${all.length} 个字体文件）`);
