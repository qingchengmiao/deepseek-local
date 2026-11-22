// 截图：拖拽覆盖层（真实浏览器渲染）
import { launch, sleep } from './cdp.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.argv[2] || 8795);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.resolve('data/shots');

const b = await launch({ port: 9334, width: 1370, height: 885 });
const { cdp, ev, goto, close } = b;
try {
  await goto(BASE + '/');
  await sleep(1500);
  const shot = async (name) => {
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    await fs.mkdir(OUT, { recursive: true });
    const p = path.join(OUT, name);
    await fs.writeFile(p, Buffer.from(r.data, 'base64'));
    console.log('写出', p);
  };
  await shot('56-拖拽层-未激活.png');
  await ev(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([80,75,3,4])], '资料包.zip', { type: 'application/zip' }));
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
    return true;
  })()`);
  await sleep(500);
  const cls = await ev(`document.querySelector('#dropZone')?.className || ''`);
  const title = await ev(`document.querySelector('.drop-title')?.textContent || ''`);
  console.log('覆盖层:', cls, '|', title);
  await shot('57-拖拽层-激活.png');
} finally {
  await close();
}
