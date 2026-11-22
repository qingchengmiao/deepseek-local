// 设置页截图（看自适应开关那一块）
import { launch, sleep } from './cdp.mjs';
import { writeFile } from 'node:fs/promises';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const TAG = process.env.TAG || 'settings';

const b = await launch({ port: 9344, width: 1400, height: 1000 });
try {
  await b.cdp('Network.enable');
  await b.cdp('Network.setCacheDisabled', { cacheDisabled: true });
  await b.goto(BASE + '/?_=' + Date.now());
  await sleep(1500);
  await b.ev(`(() => { document.querySelector('#settingsBtn').click(); })()`);
  await sleep(1200);
  const info = await b.ev(`(() => {
    const sw = document.querySelector('#setAdaptiveTurn');
    if (!sw) return { found: false };
    sw.scrollIntoView({ block: 'center' });
    const r = sw.closest('.switch-row').getBoundingClientRect();
    return { found: true, checked: sw.checked, rect: [r.x, r.y, r.width, r.height] };
  })()`);
  console.log(JSON.stringify(info));
  await sleep(600);
  for (const theme of ['light', 'dark']) {
    await b.ev(`(() => { document.documentElement.dataset.theme = '${theme}'; })()`);
    await sleep(400);
    const png = await b.cdp('Page.captureScreenshot', { format: 'png' });
    const file = `data/shots/${TAG}-${theme}.png`;
    await writeFile(file, Buffer.from(png.data, 'base64'));
    console.log('截图：', file);
  }
} finally {
  await b.close();
}
