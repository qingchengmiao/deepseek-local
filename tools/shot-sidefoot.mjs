// 拍左下角图标条（7 个，只留图标）
// 用法：node tools/shot-sidefoot.mjs [BASE]
import { writeFileSync } from 'node:fs';
import { launch, sleep } from './cdp.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const { cdp, ev, goto, waitFor, close } = await launch({ width: 1360, height: 860, port: 9368 });

try {
  await goto(BASE);
  await waitFor(`!!document.querySelector('#convList')`, 15000);
  await sleep(800);
  const info = await ev(`(() => {
    const box = document.querySelector('.side-foot');
    const btns = [...document.querySelectorAll('.foot-btn')];
    const r = box.getBoundingClientRect();
    return {
      box: { w: Math.round(r.width), h: Math.round(r.height) },
      rows: new Set(btns.map(b => Math.round(b.getBoundingClientRect().top))).size,
      count: btns.length,
      each: btns.map(b => ({ id: b.id, w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) })),
    };
  })()`);
  console.log('图标条:', JSON.stringify(info));

  const s = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('data/shots/104-左下角图标条.png', Buffer.from(s.data, 'base64'));
  console.log('shot data/shots/104-左下角图标条.png');
} finally {
  await close();
}
