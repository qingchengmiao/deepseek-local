// 截 QQ 页「回话用哪个会话」卡片（浅色 + 深色）
import { launch, sleep } from './cdp.mjs';
import { writeFileSync } from 'node:fs';

const BASE = (process.argv[2] || process.env.BASE || 'http://127.0.0.1:8799').replace(/\/+$/, '');
const { cdp, ev, waitFor, close } = await launch({ width: 1360, height: 940, port: 9351 });
try {
  await cdp('Page.navigate', { url: `${BASE}/` });
  await waitFor("document.documentElement.dataset.ready === '1'", 15000);
  await ev(`document.querySelector('#qqNavBtn').click()`);
  await sleep(900);
  await ev(`(() => { const el = document.querySelector('#qqConvSel'); if (el) el.scrollIntoView({ block: 'center' }); return 1; })()`);
  await sleep(400);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('data/shots/93-QQ页-回话会话-浅色.png', Buffer.from(shot.data, 'base64'));

  await ev(`(() => { document.documentElement.dataset.theme = 'dark'; return 1; })()`);
  await sleep(500);
  const shot2 = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('data/shots/93-QQ页-回话会话-深色.png', Buffer.from(shot2.data, 'base64'));
  await ev(`(() => { document.documentElement.dataset.theme = 'light'; return 1; })()`);
  console.log('已写出 93-QQ页-回话会话-浅色.png / 93-QQ页-回话会话-深色.png');
} finally {
  await close();
}
