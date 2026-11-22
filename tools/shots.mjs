// 截几张界面图（无头 Edge）。用假上游造一条带联网/引用/思考的会话，截完自动清掉。
// 用法：先起服务（8787），再 node tools/shots.mjs
import { liveGuard } from './_guard.mjs';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { launch, sleep } from './cdp.mjs';

const APP = 'http://127.0.0.1:8787';
await liveGuard(APP, 'shots');
const MOCK = 'http://127.0.0.1:8899';
const OUT = 'data/shots';

async function json(path, opts) {
  const res = await fetch(APP + path, opts);
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  return { res, data };
}
const putSettings = patch => json('/api/settings', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
});
async function mockUp() {
  try { const r = await fetch(MOCK + '/models', { signal: AbortSignal.timeout(600) }); if (r.ok) return null; } catch {}
  const child = spawn(process.execPath, ['tools/mock-upstream.mjs'], { stdio: 'ignore', detached: true });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    try { const r = await fetch(MOCK + '/models', { signal: AbortSignal.timeout(500) }); if (r.ok) return child; } catch {}
  }
  throw new Error('假上游没起来');
}

await mkdir(OUT, { recursive: true });
const orig = (await json('/api/settings')).data;
const mockChild = await mockUp();
const beforeIds = (await json('/api/state')).data.conversations.map(c => c.id);
const b = await launch({ port: 9336 });
const shots = [];

async function shot(name) {
  await sleep(600);
  const r = await b.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = `${OUT}/${name}.png`;
  await writeFile(file, Buffer.from(r.data, 'base64'));
  shots.push(file);
  console.log('截了', file);
}

try {
  await putSettings({ apiKey: 'sk-mock-ui-key', baseUrl: MOCK, model: 'deepseek-flash', webSearch: true, thinking: true, autoTitle: true, safetyLevel: 'off', readLink: true });
  const conv = (await json('/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '示例：联网问答', model: 'deepseek-flash' }) })).data.conversation;
  await fetch(APP + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: conv.id, mode: 'send', content: '帮我查一下今天的新闻，顺便看看 example.com 讲了什么', webSearch: true, thinking: true, autoTitle: true }),
  }).then(r => r.text());

  // 1) 暗色：联网过程 + 引用角标
  await putSettings({ theme: 'dark' });
  await b.goto(APP);
  await b.waitFor(`typeof S === 'object'`, 12000);
  await b.ev(`applyTheme('dark')`);
  await b.ev(`(() => { const it = [...document.querySelectorAll('#convList .conv-item')].find(el => el.dataset.id === '${conv.id}') || [...document.querySelectorAll('#convList .conv-item')][1]; if (it) it.click(); })()`);
  await b.waitFor(`document.querySelectorAll('#messages .tool-card').length > 0`, 12000);
  // 展开联网过程卡片（默认是折叠的，这里为了把来源列表也截进去）
  for (let i = 0; i < 3; i++) {
    await b.ev(`(() => { const d = document.querySelector('#messages .tool-card'); if (d && !d.open) { const s = d.querySelector('summary'); if (s) s.click(); else d.open = true; } })()`);
    await sleep(400);
    if (await b.ev(`document.querySelector('#messages .tool-card')?.open === true`)) break;
  }
  console.log('  联网卡片展开：', await b.ev(`document.querySelector('#messages .tool-card')?.open === true`));
  await shot('01-对话-联网过程-暗色');

  // 2) 欢迎页暗色
  await b.ev(`document.querySelector('#newChatBtn').click()`);
  await sleep(400);
  await shot('02-欢迎页-暗色');

  // 3) 欢迎页浅色
  await putSettings({ theme: 'light' });
  await b.goto(APP);
  await b.waitFor(`typeof S === 'object'`, 12000);
  await b.ev(`applyTheme('light')`);
  await b.ev(`document.querySelector('#newChatBtn').click()`);
  await sleep(500);
  await shot('03-欢迎页-浅色');

  // 4) 设置面板（先把地址换回真的，别把测试上游写进图里）
  await putSettings({ baseUrl: 'https://api.deepseek.com', apiKey: '' });
  await b.goto(APP);
  await b.waitFor(`typeof S === 'object'`, 12000);
  await b.ev(`applyTheme('light')`);
  await b.ev(`document.querySelector('#settingsBtn').click()`);
  await b.waitFor(`!!document.querySelector('#modalRoot .modal')`, 6000);
  await sleep(500);
  await shot('04-设置-浅色');
  await b.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(300);

  // 5) 手机宽度
  await b.cdp('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });
  await b.goto(APP);
  await b.waitFor(`typeof S === 'object'`, 12000);
  await b.ev(`document.querySelector('#newChatBtn').click()`);
  await sleep(800);
  await shot('05-手机宽度');
  await b.cdp('Emulation.clearDeviceMetricsOverride');
} finally {
  await b.close();
  try {
    const list = (await json('/api/state')).data.conversations;
    for (const c of list) {
      if (!beforeIds.includes(c.id)) await json('/api/conversations/' + c.id, { method: 'DELETE' });
    }
  } catch {}
  const restore = {
    baseUrl: orig.baseUrl, model: orig.model || 'deepseek-flash',
    webSearch: !!orig.webSearch, readLink: orig.readLink !== false, autoTitle: orig.autoTitle !== false,
    safetyLevel: orig.safetyLevel || 'off', thinking: orig.thinking !== false, reasoningEffort: orig.reasoningEffort || 'high',
    theme: orig.theme || 'auto',
  };
  if (!orig.hasKey) restore.apiKey = '';
  await putSettings(restore);
  if (mockChild) { try { process.kill(-mockChild.pid); } catch { try { mockChild.kill(); } catch {} } }
}
console.log('完成：', shots.join(', '));
