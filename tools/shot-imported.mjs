// 截一张「导入后的长会话」：验证图片附件、思考过程、时间轴渲染
import { launch, sleep } from './cdp.mjs';
import { mkdir, writeFile } from 'node:fs/promises';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = 'data/shots/18-导入的历史会话.png';
const QUERY = process.env.Q || '暗区突围称号界面';

const b = await launch({ port: 9334, width: 1440, height: 1000 });
try {
  await b.goto(BASE + '/');
  await b.waitFor(`document.querySelectorAll('#convList .conv-item').length > 0`, 20000);

  const st = await (await fetch(BASE + '/api/state')).json();
  const target = st.conversations.find(c => c.title === QUERY) || st.conversations[0];
  await b.ev(`(() => { const it = [...document.querySelectorAll('#convList .conv-item')].find(x => x.dataset.id === ${JSON.stringify(target.id)}); if (it) it.click(); })()`);
  await b.waitFor(`document.querySelectorAll('#messages .msg').length > 0`, 20000);
  await sleep(1500);

  // 「载入更早的」按钮一轮轮点，直到出现带图片的消息
  for (let i = 0; i < 14; i++) {
    const has = await b.ev(`document.querySelectorAll('#messages .att-img img').length > 0`);
    if (has) break;
    const clicked = await b.ev(`(() => { const b = document.querySelector('#messages .load-more'); if (!b) return false; b.click(); return true; })()`);
    await sleep(900);
    if (!clicked) break;
  }
  await b.ev(`(() => { const img = document.querySelector('#messages .att-img img'); if (img) img.closest('.msg').scrollIntoView({ block: 'start' }); })()`);
  await sleep(2000);

  const info = await b.ev(`(() => {
    const imgs = [...document.querySelectorAll('#messages .att-img img')];
    return {
      msgs: document.querySelectorAll('#messages .msg').length,
      imgs: imgs.length,
      loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
      src: imgs[0]?.getAttribute('src') || '',
      think: document.querySelectorAll('#messages .think, #messages .reasoning').length,
      title: document.querySelector('#convTitle')?.textContent?.trim() || '',
    };
  })()`);
  console.log('页面状态：', JSON.stringify(info));
  await mkdir('data/shots', { recursive: true });
  const shot = await b.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(OUT, Buffer.from(shot.data, 'base64'));
  console.log('截图：', OUT);
} finally {
  await b.close();
}
