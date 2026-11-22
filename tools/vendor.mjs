// 把前端用的第三方静态资源抓到 public/vendor（离线可用，不依赖 CDN）
// 用法: node tools/vendor.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'vendor');
const CDN = 'https://cdnjs.cloudflare.com/ajax/libs';

const FILES = [
  [`${CDN}/highlight.js/11.10.0/highlight.min.js`, 'highlight.min.js'],
  [`${CDN}/highlight.js/11.10.0/styles/github.min.css`, 'github.min.css'],
  [`${CDN}/highlight.js/11.10.0/styles/github-dark.min.css`, 'github-dark.min.css'],
  [`${CDN}/KaTeX/0.16.11/katex.min.js`, 'katex.min.js'],
  [`${CDN}/KaTeX/0.16.11/katex.min.css`, 'katex.min.css'],
];

async function get(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch(url, { signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      last = e;
      await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw last;
}

await fs.mkdir(path.join(OUT, 'fonts'), { recursive: true });

for (const [url, name] of FILES) {
  process.stdout.write(`→ ${name} ... `);
  const buf = await get(url);
  await fs.writeFile(path.join(OUT, name), buf);
  console.log(`${buf.length} bytes`);
}

// katex.min.css 里引用的字体，全部抓下来
const css = await fs.readFile(path.join(OUT, 'katex.min.css'), 'utf8');
const fonts = [...new Set([...css.matchAll(/url\(fonts\/([^)"']+)\)/g)].map(m => m[1]))];
console.log(`字体 ${fonts.length} 个`);
let ok = 0;
for (const f of fonts) {
  try {
    const buf = await get(`${CDN}/KaTeX/0.16.11/fonts/${f}`);
    await fs.writeFile(path.join(OUT, 'fonts', f), buf);
    ok++;
  } catch (e) {
    console.log(`  ✗ ${f}: ${e.message}`);
  }
}
console.log(`完成：字体 ${ok}/${fonts.length}`);
