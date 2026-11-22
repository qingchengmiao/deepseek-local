// UI 基线截图：浅色对话页 / 深色对话页 / 手机宽度
import { launch, sleep } from './cdp.mjs';
import { writeFile, mkdir } from 'node:fs/promises';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const TAG = process.env.TAG || 'ui';

async function shot(b, file) {
  await mkdir('data/shots', { recursive: true });
  const png = await b.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(`data/shots/${file}`, Buffer.from(png.data, 'base64'));
  console.log('截图：', file);
}

async function openChat(b) {
  await b.goto(BASE + '/');
  await b.waitFor(`document.querySelectorAll('#convList .conv-item').length > 0`, 25000);
  await sleep(700);
  await b.ev(`(() => {
    const items = [...document.querySelectorAll('#convList .conv-item')];
    const want = items.find(x => (x.querySelector('.t-title') || {}).textContent === '国内科技三条新闻');
    (want || items[0]).click();
  })()`);
  await b.waitFor(`document.querySelectorAll('#messages .msg').length > 0`, 20000);
  await sleep(1200);
}

const desk = await launch({ port: 9341, width: 1400, height: 980 });
try {
  await openChat(desk);
  await desk.ev(`(() => { if (document.documentElement.dataset.theme !== 'light') document.documentElement.dataset.theme = 'light'; })()`);
  await sleep(500);
  await shot(desk, `${TAG}-浅色-对话.png`);

  await desk.ev(`(() => { document.documentElement.dataset.theme = 'dark'; })()`);
  await sleep(600);
  await shot(desk, `${TAG}-深色-对话.png`);

  // 深色下的空状态
  await desk.ev(`(() => { document.documentElement.dataset.theme = 'light'; document.querySelector('#newChatBtn').click(); })()`);
  await sleep(700);
  await shot(desk, `${TAG}-浅色-空状态.png`);
} finally {
  await desk.close();
}

const phone = await launch({ port: 9342, width: 430, height: 920 });
try {
  await openChat(phone);
  await shot(phone, `${TAG}-手机-对话.png`);
} finally {
  await phone.close();
}
