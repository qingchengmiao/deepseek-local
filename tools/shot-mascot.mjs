// 拍吉祥物：对话页右下角 + 点一下说话 + 换页自动收起
import { launch, sleep } from './cdp.mjs';
import { mkdir, writeFile } from 'node:fs/promises';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const b = await launch({ port: 9338, width: 1400, height: 980 });
try {
  await b.goto(BASE + '/');
  await b.waitFor(`document.querySelectorAll('#convList .conv-item').length > 0`, 25000);
  await sleep(900);
  await mkdir('data/shots', { recursive: true });

  const info = await b.ev(`(() => {
    const m = document.querySelector('#mascot');
    const img = m && m.querySelector('img');
    const r = m && m.getBoundingClientRect();
    return { exists: !!m, imgLoaded: !!(img && img.complete && img.naturalWidth > 0),
             w: img && img.naturalWidth, rect: r && { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width) },
             view: (window.S && S.view) || '' };
  })()`);
  console.log('吉祥物：', JSON.stringify(info));
  let shot = await b.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile('data/shots/35-吉祥物-对话页.png', Buffer.from(shot.data, 'base64'));

  // 点一下，气泡说话
  const r = info.rect;
  await b.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x + Math.round(r.w / 2), y: r.y + Math.round(r.w / 2), button: 'none' });
  await sleep(300);
  await b.ev(`document.querySelector('#mascot').click()`);
  await sleep(700);
  const bubble = await b.ev(`(() => { const el = document.querySelector('#mascotBubble'); return { hidden: el.classList.contains('hidden'), text: el.textContent }; })()`);
  console.log('气泡：', JSON.stringify(bubble));
  shot = await b.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile('data/shots/36-吉祥物-说话.png', Buffer.from(shot.data, 'base64'));

  // 切到日历页：应自动收起
  await b.ev(`document.querySelector('#clockBtn').click()`);
  await sleep(900);
  const gone = await b.ev(`document.querySelector('#mascot').classList.contains('gone')`);
  console.log('开日历页时吉祥物收起：', gone);
  await b.ev(`document.querySelector('#pageBack').click()`);
  await sleep(400);
  console.log('回对话后恢复：', !(await b.ev(`document.querySelector('#mascot').classList.contains('gone')`)));
} finally {
  await b.close();
}
