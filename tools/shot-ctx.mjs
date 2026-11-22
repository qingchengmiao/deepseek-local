// 截「上下文与记忆」面板 + 设置里的上下文区块
// 用法：node tools/shot-ctx.mjs [convId]
import { writeFile, mkdir } from 'node:fs/promises';
import { launch, sleep } from './cdp.mjs';

const APP = 'http://127.0.0.1:8787';
const OUT = 'data/shots';
const id = process.argv[2];
const query = process.argv[3] || '弹震症';
if (!id) { console.error('用法: node tools/shot-ctx.mjs <convId> [查询词]'); process.exit(1); }
await mkdir(OUT, { recursive: true });

const b = await launch({ port: 9351, width: 1440, height: 1000 });
const shot = async name => {
  await sleep(700);
  const r = await b.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  console.log('截了', `${OUT}/${name}.png`);
};
try {
  await b.goto(APP);
  await b.waitFor(`typeof S === 'object'`, 15000);
  await b.ev(`applyTheme('dark')`);
  await b.ev(`openConversation(${JSON.stringify(id)})`);
  await b.waitFor(`!document.querySelector('#ctxBadge').classList.contains('hidden')`, 10000);
  await sleep(500);

  await b.ev(`document.querySelector('#ctxBadge').click()`);
  await b.waitFor(`!!document.querySelector('.modal .ctx-meter')`, 8000);
  await b.ev(`(() => { const i = document.querySelector('#ctxQuery'); i.value = ${JSON.stringify(query)}; document.querySelector('#ctxPreview').click(); })()`);
  await b.waitFor(`document.querySelectorAll('.modal .ctx-hit').length > 0`, 10000);
  await b.ev(`(() => { const h = document.querySelector('.modal'); if (h) h.scrollTop = 0; })()`);
  await shot('13-上下文面板-暗色');

  // 压缩记录 + 展开原文（分档概要、关键词、遗忘标记）
  const hasRecords = await b.ev(`document.querySelectorAll('.modal .ctx-record').length > 0`);
  if (hasRecords) {
    await b.ev(`(() => { const r = document.querySelector('.modal .ctx-record'); r.scrollIntoView({ block: 'start' }); })()`);
    await b.ev(`(() => { const r = document.querySelector('.modal .ctx-record [data-activate]'); if (r) r.click(); })()`);
    await sleep(1200);
    await b.ev(`(() => { const o = document.querySelector('.modal #ctxOriginal'); if (o) o.scrollIntoView({ block: 'center' }); })()`);
    await shot('16-压缩记录与展开');
  }

  // 设置里的上下文区块（浅色）
  await b.ev(`(() => { const b = [...document.querySelectorAll('.modal [data-x]')].find(x => x.textContent.includes('关掉')); if (b) b.click(); })()`);
  await sleep(300);
  await b.ev(`applyTheme('light')`);
  await b.ev(`document.querySelector('#moreBtn').click()`);
  await sleep(250);
  await b.ev(`(() => { const it = [...document.querySelectorAll('#ctxMenu button')].find(x => x.textContent.includes('设置')); if (it) it.click(); })()`);
  await b.waitFor(`!!document.querySelector('#setCtxCompress')`, 8000);
  await b.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1240, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  await b.ev(`(() => { const f = document.querySelector('#setCtxSummarizer'); f.closest('.field').scrollIntoView({ block: 'start' }); })()`);
  await shot('14-设置-上下文与记忆');

  // 读链接的兜底设置
  await b.ev(`(() => { const f = document.querySelector('#setReadLinkMode'); if (f) f.closest('.field').scrollIntoView({ block: 'center' }); })()`);
  await shot('17-设置-读链接兜底');

  // 自动路由设置
  await b.ev(`(() => { const f = document.querySelector('#setAutoRoute'); if (f) f.closest('.switch-row').scrollIntoView({ block: 'center' }); })()`);
  await sleep(300);
  await shot('20-设置-自动路由');
} finally {
  await b.close();
}
