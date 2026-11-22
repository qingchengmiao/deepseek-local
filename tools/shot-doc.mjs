// 把打印版 HTML 按 A4 宽（794px@96dpi）切页截图，用于目检 PDF 排版
// 用法：node tools/shot-doc.mjs "file:///.../docs/feature.html" [输出前缀]
import { launch, sleep } from './cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const url = process.argv[2];
const prefix = process.argv[3] || 'data/shots/doc-page';
if (!url) {
  console.log('用法: node tools/shot-doc.mjs <file:///...html> [前缀]');
  process.exit(1);
}

const W = 794;
const H = 1123; // A4 210x297mm @96dpi

const page = await launch({ port: 9337, width: W, height: H });
await page.cdp('Emulation.setDeviceMetricsOverride', {
  width: W,
  height: H,
  deviceScaleFactor: 1.5,
  mobile: false,
});
await page.goto(url);
await sleep(1600);

const metrics = await page.cdp('Runtime.evaluate', {
  expression: 'JSON.stringify({h: document.body.scrollHeight, imgs: Array.from(document.images).map(i => ({src: i.src.split("/").pop(), w: i.naturalWidth, h: i.naturalHeight}))})',
  returnByValue: true,
});
const info = JSON.parse(metrics.result.result.value || '{}');
console.log('页面高度', info.h, 'px →', Math.ceil(info.h / H), '屏');
const broken = (info.imgs || []).filter((i) => !i.w);
console.log('图片', (info.imgs || []).length, '张，坏图', broken.length);
if (broken.length) console.log('坏图:', broken.map((b) => b.src).join(', '));

mkdirSync(path.dirname(prefix), { recursive: true });
const shots = [0, 1, 2, 3, 5, 7, 9];
for (const i of shots) {
  const y = i * H;
  if (y >= info.h) break;
  const r = await page.cdp('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y, width: W, height: Math.min(H, info.h - y), scale: 1 },
  });
  const file = `${prefix}-${String(i + 1).padStart(2, '0')}.png`;
  writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  console.log('写出', file);
}
await page.close();
