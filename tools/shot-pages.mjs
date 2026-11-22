// 截新版整页视图：日历·时钟 / QQ / 插件 / 设置 / 侧栏「调」弹层
import { mkdir, writeFile } from 'node:fs/promises';
import { launch, sleep } from './cdp.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
await mkdir('data/shots', { recursive: true });

const b = await launch({ port: 9337, width: 1500, height: 1020 });
const shot = async name => {
  const s = await b.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(`data/shots/${name}.png`, Buffer.from(s.data, 'base64'));
  console.log('截了', name);
};
const errors = [];
b.on?.('Runtime.exceptionThrown', e => errors.push(e));

try {
  await b.goto(BASE + '/');
  await b.waitFor(`document.querySelectorAll('#convList .conv-item').length > 0`, 20000);
  await sleep(600);

  // 造两条日程，方便截图
  const today = new Date();
  const d = n => {
    const x = new Date(today);
    x.setDate(x.getDate() + n);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  };
  const made = [];
  for (const ev of [
    { title: '牙医复诊', date: d(0), time: '15:30', end: '16:00', note: '带上次的片子' },
    { title: '把回归跑完', date: d(0), time: '20:00' },
  ]) {
    const r = await fetch(BASE + '/api/calendar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev) }).then(r => r.json());
    if (r.event) made.push(r.event.id);
  }

  // 1) 日历 · 时钟
  await b.ev(`document.querySelector('#clockBtn').click()`);
  await b.waitFor(`!!document.querySelector('.cal-grid2')`, 10000);
  await sleep(700);
  await shot('25-页面-日历与时钟');

  // 2) QQ
  await b.ev(`document.querySelector('#qqNavBtn').click()`);
  await b.waitFor(`!!document.querySelector('#qqMode')`, 10000);
  await sleep(700);
  await shot('26-页面-QQ');

  // 3) 插件
  await b.ev(`document.querySelector('#pluginsBtn').click()`);
  await b.waitFor(`!!document.querySelector('.ch-list')`, 12000);
  await sleep(700);
  await shot('27-页面-插件');

  // 4) 设置
  await b.ev(`document.querySelector('#settingsBtn').click()`);
  await b.waitFor(`!!document.querySelector('#setCtxBudget')`, 12000);
  await sleep(700);
  await shot('28-页面-设置');

  // 5) 侧栏「调」弹层（先把鼠标真的移到会话行上，触发 hover 显出按钮）
  await b.ev(`document.querySelector('#pageBack').click()`);
  await sleep(500);
  const box = await b.ev(`(() => { const it = document.querySelector('#convList .conv-item'); const r = it.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  await b.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
  await sleep(400);
  await b.ev(`(() => { const btn = document.querySelector('#convList .conv-item [data-tune]'); btn && btn.click(); })()`);
  await sleep(900);
  const pop = await b.ev(`!!document.querySelector('.tune-pop')`);
  console.log('调弹层出现：', pop);
  await shot('29-侧栏-调这个会话');

  const state = await b.ev(`({ title: document.querySelector('#pageTitle').textContent, view: location.hash })`);
  console.log('状态：', JSON.stringify(state));
  console.log('页面异常：', errors.length ? JSON.stringify(errors) : '无');

  // 清掉演示日程
  for (const id of made) await fetch(BASE + '/api/calendar/' + id, { method: 'DELETE' });
} finally {
  await b.close();
}
