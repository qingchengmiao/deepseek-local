// 给「自学习」页拍一张：点侧栏学习按钮 → 等画像算出来 → 截图。
// 用法：node tools/shot-learn-page.mjs [BASE]
import { writeFileSync } from 'node:fs';
import { launch, sleep } from './cdp.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const OUT = process.argv[3] || 'data/shots/102-自学习页.png';
const { cdp, ev, goto, waitFor, close } = await launch({ width: 1400, height: 1560, port: 9365 });

try {
  await goto(BASE);
  await waitFor(`!!document.querySelector('#learnNavBtn')`, 15000);
  await sleep(400);
  await ev(`(() => { document.querySelector('#learnNavBtn')?.click(); return true; })()`);
  await waitFor(`!!document.querySelector('#ltGroupList')`, 10000);
  // 等画像那块画出来（有 .lt-metric 或者明确写着「还没采到」）
  await waitFor(`!!document.querySelector('.lt-metric') || /还没采到|还没有可看的群/.test(document.querySelector('#ltBody')?.textContent || '')`, 15000);
  await sleep(700);

  const info = await ev(`(() => {
    const metrics = [...document.querySelectorAll('.lt-metric')].map(m => ({
      k: m.querySelector('.lt-k')?.textContent || '',
      v: m.querySelector('.lt-v')?.textContent || '',
    }));
    return {
      title: document.querySelector('#pageTitle')?.textContent || '',
      groups: [...document.querySelectorAll('.lt-group')].map(g => ({
        gid: g.dataset.gid,
        name: g.querySelector('.lt-g-name')?.textContent || '',
        meta: g.querySelector('.lt-g-meta')?.textContent || '',
        on: g.classList.contains('on'),
      })),
      metrics,
      graph: !!document.querySelector('.lt-graph'),
      curve: !!document.querySelector('.lt-curve'),
      memes: [...document.querySelectorAll('.lt-meme b')].slice(0, 6).map(b => b.textContent),
      weeks: [...document.querySelectorAll('.lt-week')].slice(0, 4).map(b => b.textContent),
      hint: document.querySelector('#ltHint')?.textContent || '',
    };
  })()`);
  console.log('自学习页:', JSON.stringify(info));

  const s = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT, Buffer.from(s.data, 'base64'));
  console.log('shot', OUT);
} finally {
  await close();
}
