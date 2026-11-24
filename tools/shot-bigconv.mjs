// 打开一个超大 session，量「点开 → 第一条消息出现」的耗时，并验「载入更早」能往前翻。
// 用法：node tools/shot-bigconv.mjs [BASE] [CONV]
import { writeFileSync } from 'node:fs';
import { launch, sleep } from './cdp.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const CONV = process.argv[3] || 'c_perfbig1';
const { cdp, ev, goto, waitFor, close } = await launch({ width: 1360, height: 900, port: 9371 });

try {
  await goto(BASE);
  await waitFor(`!!document.querySelector('.conv-item')`, 20000);

  const t0 = Date.now();
  await ev(`location.hash = '#c/${CONV}'; location.reload(); true`);
  await waitFor(`document.querySelectorAll('#messages .msg').length > 0`, 30000);
  const paintMs = Date.now() - t0;

  const first = await ev(`(() => {
    const msgs = document.querySelectorAll('#messages .msg');
    const more = document.querySelector('.load-more');
    return {
      painted: msgs.length,
      total: (document.querySelector('#title')||{}).textContent,
      meta: (document.querySelector('#meta')||{}).textContent,
      moreLabel: more ? more.textContent : '',
      moreCount: document.querySelectorAll('.load-more').length,
    };
  })()`);
  console.log('首屏:', JSON.stringify({ paintMs, ...first }));

  // 点「载入更早」，看条数有没有涨、滚动位置有没有接住
  const before = await ev(`(() => {
    const s = document.querySelector('#scroller');
    return { painted: document.querySelectorAll('#messages .msg').length, h: s.scrollHeight };
  })()`);
  await ev(`(() => { const b = document.querySelector('.load-more'); if (b) b.click(); return true; })()`);
  await sleep(1200);
  const after = await ev(`(() => {
    const s = document.querySelector('#scroller');
    const more = document.querySelector('.load-more');
    return { painted: document.querySelectorAll('#messages .msg').length, h: s.scrollHeight, moreLabel: more ? more.textContent : '' };
  })()`);
  console.log('翻页:', JSON.stringify({ before, after }));

  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('data/shots/107-大会话首屏.png', Buffer.from(shot.data, 'base64'));
  console.log('shot data/shots/107-大会话首屏.png');
} finally {
  await close();
}
