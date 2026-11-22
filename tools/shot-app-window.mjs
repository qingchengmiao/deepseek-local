// 连上已经在跑的应用窗口（--remote-debugging-port=9333），截一张「日历 · 时钟」整页
import { writeFile } from 'node:fs/promises';

const PORT = process.env.CDP_PORT || 9333;
const OUT = process.env.OUT || 'data/shots/24-应用窗口-日历.png';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /127\.0\.0\.1/.test(t.url || ''));
if (!page) { console.error('没找到页面目标', list.map(t => t.type + ':' + t.url)); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const waiting = new Map();
ws.addEventListener('message', e => {
  const msg = JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString('utf8'));
  if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
});
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
const send = (method, params = {}) => new Promise(res => {
  const myId = ++id;
  waiting.set(myId, res);
  ws.send(JSON.stringify({ id: myId, method, params }));
});
const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.result?.value;
const wait = ms => new Promise(r => setTimeout(r, ms));

await ev(`document.querySelector('#clockBtn')?.click()`);
await wait(900);
const ok = await ev(`!!document.querySelector('.cal-grid2')`);
console.log('日历·时钟页：', ok);
const cells = await ev(`document.querySelectorAll('.cal-grid2 .cal-cell2').length`);
console.log('页标题：', await ev(`document.querySelector('#pageTitle').textContent`));
console.log('月网格格数：', cells);
const shot = await send('Page.captureScreenshot', { format: 'png' });
await writeFile(OUT, Buffer.from(shot.result.data, 'base64'));
console.log('截图：', OUT);
ws.close();
