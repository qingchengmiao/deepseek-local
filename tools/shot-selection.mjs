import { launch, sleep } from './cdp.mjs';
import { writeFileSync } from 'node:fs';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const { cdp, ev, waitFor, close } = await launch({ width: 1280, height: 900, port: 9339 });
await cdp('Page.navigate', { url: BASE + '/' });
await waitFor("document.documentElement.dataset.ready === '1'", 15000);
let last = -1;
for (let i = 0; i < 20; i += 1) {
  const pos = await ev(`(() => { const sc = document.querySelector('#scroller'); return sc ? Math.round(sc.scrollTop) : 0; })()`);
  if (pos === last) break;
  last = pos; await sleep(250);
}
await sleep(300);
const sel = await ev(`(() => {
  const sc = document.querySelector('#scroller'); const scR = sc.getBoundingClientRect();
  const boxes = [...document.querySelectorAll('#messages .bubble, #messages .md')].reverse();
  for (const box of boxes) {
    const br = box.getBoundingClientRect();
    if (br.bottom < scR.top + 40 || br.top > scR.bottom - 40) continue;
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    let n = null;
    while ((n = walker.nextNode())) {
      if (!n.nodeValue || n.nodeValue.trim().length < 12) continue;
      const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, Math.min(18, n.nodeValue.length));
      const rc = r.getBoundingClientRect();
      if (!rc || !rc.width) continue;
      if (rc.top < scR.top + 8 || rc.bottom > scR.bottom - 8) continue;
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      return { ok: true };
    }
  }
  return { ok: false };
})()`);
await sleep(700);
const rect = await ev(`(() => { const b = document.querySelector('#selCopy'); const r = b.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, text: b.textContent.trim() }; })()`);
console.log('sel', JSON.stringify(sel), 'bar', JSON.stringify(rect));
const clip = { x: Math.max(0, rect.x - 200), y: Math.max(0, rect.y - 60), width: 520, height: 200, scale: 2 };
writeFileSync('data/shots/74-选中复制浮条-放大.png', Buffer.from((await cdp('Page.captureScreenshot', { format: 'png', clip })).data, 'base64'));
writeFileSync('data/shots/73-选中复制浮条.png', Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
console.log('shots rewritten');
await close();
