// 只看输入区：截一张 940x220 的近景，方便对比「内套矩形」问题
import { launch, sleep } from './cdp.mjs';
import { writeFile } from 'node:fs/promises';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const TAG = process.env.TAG || 'composer';

const b = await launch({ port: 9343, width: 1000, height: 700 });
try {
  await b.cdp('Network.enable');
  await b.cdp('Network.setCacheDisabled', { cacheDisabled: true });
  await b.goto(BASE + '/?_=' + Date.now());
  await sleep(1200);
  await b.ev(`(() => {
    const ta = document.querySelector('#input');
    if (ta) { ta.focus(); ta.value = '帮我看一眼这个输入框的边距'; ta.dispatchEvent(new Event('input', { bubbles: true })); }
  })()`);
  await sleep(500);
  const rect = await b.ev(`(() => {
    const w = document.querySelector('#composerWrap').getBoundingClientRect();
    const c = document.querySelector('#composer').getBoundingClientRect();
    const t = document.querySelector('#input').getBoundingClientRect();
    return { wrap: [w.x, w.y, w.width, w.height], composer: [c.x, c.y, c.width, c.height], input: [t.x, t.y, t.width, t.height] };
  })()`);
  console.log(JSON.stringify(rect));
  const clip = { x: Math.max(0, rect.composer[0] - 16), y: Math.max(0, rect.composer[1] - 16), width: rect.composer[2] + 32, height: rect.composer[3] + 32, scale: 2 };
  for (const theme of ['light', 'dark']) {
    await b.ev(`(() => { document.documentElement.dataset.theme = '${theme}'; })()`);
    await sleep(400);
    const png = await b.cdp('Page.captureScreenshot', { format: 'png', clip });
    const file = `data/shots/${TAG}-${theme}.png`;
    await writeFile(file, Buffer.from(png.data, 'base64'));
    console.log('截图：', file);
  }
} finally {
  await b.close();
}
