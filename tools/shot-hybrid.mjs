// 截混合模式开关：输入框特写 + 整窗
import { launch, sleep } from './cdp.mjs';
import { writeFile } from 'node:fs/promises';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const b = await launch({ port: 9361, width: 1400, height: 980 });
const shot = async (f, clip) => {
  const opt = { format: 'png' };
  if (clip) opt.clip = { ...clip, scale: 1 };
  const r = await b.cdp('Page.captureScreenshot', opt);
  await writeFile('data/shots/' + f, Buffer.from(r.data, 'base64'));
  console.log('截图', f);
};
try {
  await b.goto(BASE + '/');
  await b.waitFor(`!!document.querySelector('#hybridChip')`, 20000);
  await sleep(600);
  const wasOn = await b.ev(`document.querySelector('#hybridChip').classList.contains('on')`);
  if (!wasOn) await b.ev(`document.querySelector('#hybridChip').click()`);
  await sleep(3200);
  const state = await b.ev(`(() => {
    const c = document.querySelector('#hybridChip');
    const t = document.querySelector('#thinkChip');
    const r = document.querySelector('.composer').getBoundingClientRect();
    return { on: c.classList.contains('on'), muted: t.classList.contains('muted'), label: c.textContent.trim(),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
  })()`);
  console.log('状态：', JSON.stringify(state));
  await shot('47-混合模式-输入框.png', { x: state.rect.x - 6, y: state.rect.y - 10, width: state.rect.w + 12, height: state.rect.h + 20 });
  await shot('47-混合模式-整窗.png');
  // 设置页里的同一开关
  await b.ev(`document.querySelector('#settingsBtn').click()`);
  await b.waitFor(`!!document.querySelector('#setHybridMode')`, 8000);
  await sleep(500);
  await b.ev(`document.querySelector('#setHybridMode').closest('.switch-row').scrollIntoView({block:'center'})`);
  await sleep(600);
  await shot('48-设置-混合模式.png');
  const checked = await b.ev(`document.querySelector('#setHybridMode').checked`);
  console.log('设置页开关：', checked);
  // 收尾：关回默认关（截图要的是开着的状态）
  await b.ev(`document.querySelector('#pageBack').click()`);
  await sleep(400);
  if (await b.ev(`document.querySelector('#hybridChip').classList.contains('on')`)) {
    await b.ev(`document.querySelector('#hybridChip').click()`);
    await sleep(600);
  }
  console.log('收尾状态：', await b.ev(`document.querySelector('#hybridChip').classList.contains('on')`));
} finally {
  await b.close();
}
