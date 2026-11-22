// 拍 QQ 页：旧码（过期提示 + 重启按钮）与刷新后的状态
import { launch, sleep } from './cdp.mjs';
import { mkdir, writeFile } from 'node:fs/promises';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT1 = 'data/shots/32-QQ-过期提示与重启按钮.png';
const OUT2 = 'data/shots/33-QQ-手动刷新结果.png';

const b = await launch({ port: 9336, width: 1400, height: 980 });
try {
  await b.goto(BASE + '/');
  await b.waitFor(`document.querySelectorAll('#convList .conv-item').length > 0`, 25000);
  await sleep(600);
  await b.ev(`document.querySelector('#qqNavBtn').click()`);
  await b.waitFor(`!!document.querySelector('#qqQrImg')`, 12000);
  await sleep(1200);
  await mkdir('data/shots', { recursive: true });

  const state = await b.ev(`(() => {
    const box = document.querySelector('.qr-box');
    const warn = box && box.querySelector('.warn');
    return {
      warn: warn ? warn.textContent.trim() : '',
      hasRestart: !!document.querySelector('[data-x="napRestart"]'),
      meta: (document.querySelector('#qqQrMeta') || {}).textContent,
      count: (document.querySelector('#qqQrCount') || {}).textContent,
    };
  })()`);
  console.log('二维码卡片：', JSON.stringify(state));
  let shot = await b.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(OUT1, Buffer.from(shot.data, 'base64'));
  console.log('截图：', OUT1);

  // 点手动刷新，把 toast 一起拍下来
  await b.ev(`document.querySelector('[data-x="napRefresh"]').click()`);
  await sleep(2500);
  const after = await b.ev(`({
    toast: (document.querySelector('#toast') || {}).textContent,
    toastShown: !document.querySelector('#toast').classList.contains('hidden'),
    meta: (document.querySelector('#qqQrMeta') || {}).textContent,
  })`);
  console.log('刷新后：', JSON.stringify(after));
  shot = await b.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(OUT2, Buffer.from(shot.data, 'base64'));
  console.log('截图：', OUT2);
} finally {
  await b.close();
}
