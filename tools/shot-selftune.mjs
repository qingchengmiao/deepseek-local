// 给设置页的「自我调整」块拍张图（CDP），顺便把读到的状态打出来。
// 跑：node tools/shot-selftune.mjs [baseUrl] [out]
import { writeFileSync } from 'node:fs';
import { launch, sleep } from './cdp.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const OUT = process.argv[3] || 'data/shots/108-设置-自我调整.png';

const { cdp, ev, goto, waitFor, close } = await launch({ width: 1400, height: 1600, port: 9372 });
const state = () => `(() => {
  const box = document.querySelector('#setSelfTune');
  const t = document.querySelector('#stTemp');
  return {
    hasBlock: !!box,
    enabled: box ? box.checked : null,
    temp: t ? t.value : null,
    tempNow: document.querySelector('#stTempNow')?.textContent,
    addendum: {
      human: document.querySelector('#stHuman')?.value,
      qq: document.querySelector('#stQq')?.value,
      global: document.querySelector('#stGlobal')?.value,
    },
    history: [...document.querySelectorAll('#stHist .st-row')].map((n) => n.textContent.trim()),
    saveBtn: !!document.querySelector('#stSave'),
    resetBtn: !!document.querySelector('#stReset'),
  };
})()`;

try {
  await goto(BASE);
  await waitFor(`!!document.querySelector('[data-open-settings]')`, 15000);
  await sleep(500);
  await ev(`document.querySelector('[data-open-settings]').click(); true`);
  await waitFor(`!!document.querySelector('#setSelfTune')`, 15000);
  await sleep(1200);
  console.log('自我调整块:', JSON.stringify(await ev(state())));
  // 滚到这块，只截可视区域，图更清楚
  await ev(`document.querySelector('#setSelfTune').scrollIntoView({ block: 'center' }); true`);
  await sleep(500);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('shot', OUT);
} finally {
  await close();
}
