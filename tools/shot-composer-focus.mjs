// 输入区聚焦态取证：点一下输入框，量 outline / box-shadow，再截一张局部图
// 用法：node tools/shot-composer-focus.mjs <输出png> [BASE]
import { launch, sleep } from './cdp.mjs';
import { writeFileSync } from 'node:fs';

const BASE = process.argv[3] || process.env.BASE || 'http://127.0.0.1:8787';
const out = process.argv[2] || 'data/shots/80-输入区-聚焦.png';

const { cdp, ev, waitFor, close } = await launch({ width: 1280, height: 900, port: 9343 });
await cdp('Page.navigate', { url: BASE + '/' });
await waitFor("document.documentElement.dataset.ready === '1'", 15000);
await sleep(700);

const theme = process.argv[4] || '';
if (theme) {
  await ev(`(() => { document.documentElement.dataset.theme = ${JSON.stringify(theme)}; return 1; })()`);
  await sleep(250);
}

const box = await ev(`(() => { const r = document.querySelector('#input').getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + 14) }; })()`);
await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
await sleep(350);
await cdp('Input.insertText', { text: '量一下焦点框' });
await sleep(300);

const info = await ev(`(() => {
  const ta = document.querySelector('#input');
  const comp = document.querySelector('#composer');
  const a = getComputedStyle(ta); const b = getComputedStyle(comp);
  const r = comp.getBoundingClientRect();
  return {
    focused: document.activeElement === ta,
    focusVisible: ta.matches(':focus-visible'),
    taOutline: a.outlineWidth + ' ' + a.outlineStyle + ' ' + a.outlineColor,
    taShadow: a.boxShadow,
    taBg: a.backgroundColor,
    compShadow: b.boxShadow,
    compBg: b.backgroundColor,
    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
  };
})()`);
console.log(JSON.stringify(info, null, 2));

const r = info.rect;
const clip = { x: Math.max(0, r.x - 16), y: Math.max(0, r.y - 14), width: Math.min(900, r.w + 32), height: r.h + 34, scale: 2 };
writeFileSync(out, Buffer.from((await cdp('Page.captureScreenshot', { format: 'png', clip })).data, 'base64'));
console.log('shot', out);
await close();
