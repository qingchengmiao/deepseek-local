// 给「我自己怎么说话」这块拍张图（CDP），顺便把读到的指标打出来。
// 跑：node tools/shot-learn-me.mjs [baseUrl] [out]
import { writeFileSync } from 'node:fs';
import { launch, sleep } from './cdp.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const OUT = process.argv[3] || 'data/shots/106-我自己怎么说话.png';

const { cdp, ev, goto, waitFor, close } = await launch({ width: 1400, height: 1500, port: 9369 });
const state = () => `(() => ({
  metrics: [...document.querySelectorAll('#ltMeBody .lt-metric')].map((n) => ({
    k: n.querySelector('.lt-k')?.textContent, v: n.querySelector('.lt-v')?.textContent,
  })),
  hint: document.querySelector('#ltMeHint')?.textContent,
  tics: [...document.querySelectorAll('#ltMeBody .lt-meme')].map((n) => n.textContent),
  notes: [...document.querySelectorAll('#ltMeBody .lt-note')].map((n) => n.textContent),
  inject: document.querySelector('#ltMeInject')?.checked,
}))()`;

try {
  await goto(BASE);
  await waitFor(`!!document.querySelector('#learnNavBtn')`, 15000);
  await sleep(600);
  await ev(`document.querySelector('#learnNavBtn').click(); true`);
  await waitFor(`!!document.querySelector('#ltMeBody .lt-metric')`, 20000);
  await sleep(800);
  console.log('我自己怎么说话:', JSON.stringify(await ev(state())));
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('shot', OUT);
} finally {
  await close();
}
