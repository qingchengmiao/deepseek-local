// 截「日历 / 时钟 / QQ」面板三张图（走 CDP，真页面）
// 用法：node tools/shot-day.mjs
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { launch, sleep } from './cdp.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const PORT = 3100;

async function j(pathname, opts = {}) {
  const r = await fetch(BASE + pathname, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  return r.json().catch(() => null);
}

// 假 OneBot：让 QQ 面板显示成「已连上」
const sent = [];
const onebot = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const action = req.url.replace(/^\//, '');
  const ok = data => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', retcode: 0, data })); };
  if (action === 'get_login_info') return ok({ user_id: 3979605697, nickname: '演示号' });
  if (action === 'send_private_msg') { sent.push(1); return ok({ message_id: 9000 + sent.length }); }
  if (action === 'send_group_msg') { sent.push(1); return ok({ message_id: 9100 + sent.length }); }
  if (action === 'get_friend_msg_history') return ok({ messages: [] });
  return ok({});
});

const saved = await j('/api/settings');
const createdEvents = [];
await mkdir('data/shots', { recursive: true });
await new Promise(r => onebot.listen(PORT, '127.0.0.1', r));

try {
  // 造几天日程（截完删掉）
  const today = new Date();
  const d = n => {
    const x = new Date(today);
    x.setDate(x.getDate() + n);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  };
  for (const ev of [
    { title: '牙医复诊', date: d(0), time: '15:30', end: '16:00', note: '带上次的片子' },
    { title: '把上下文压缩的回归跑完', date: d(0), time: '20:00', note: 'context-test / dom-check' },
    { title: '交周报', date: d(1), time: '10:00' },
    { title: '和运维对一下备份策略', date: d(2), time: '14:00', note: '问清楚保留多久' },
  ]) {
    const r = await j('/api/calendar', { method: 'POST', body: ev });
    if (r?.event) createdEvents.push(r.event.id);
  }

  await j('/api/settings', { method: 'PUT', body: { qqMode: 'send', qqBaseUrl: `http://127.0.0.1:${PORT}`, qqUid: '3979605697', qqCallName: '阿汐' } });
  await j('/api/qq/test', { method: 'POST', body: {} });
  await j('/api/qq/send', { method: 'POST', body: { text: '今晚八点先把回归跑完，别熬太晚。' } });

  const b = await launch({ port: 9336, width: 1440, height: 1000 });
  const shot = async (name) => {
    const s = await b.cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(`data/shots/${name}.png`, Buffer.from(s.data, 'base64'));
    console.log('截了 data/shots/' + name + '.png');
  };
  try {
    await b.goto(BASE + '/');
    await b.waitFor(`!!document.querySelector('#clockBtn')`, 15000);
    await sleep(600);
    await b.ev(`document.querySelector('#clockBtn').click()`);
    await b.waitFor(`!!document.querySelector('.cal-grid')`, 10000);
    await sleep(700);
    await shot('21-日历面板');
    await b.ev(`(() => { const t = [...document.querySelectorAll('.day-tab')].find(x => x.dataset.tab === 'clock'); if (t) t.click(); })()`);
    await b.waitFor(`!!document.querySelector('.clock-big')`, 8000);
    await sleep(600);
    await shot('22-时钟面板');
    await b.ev(`(() => { const t = [...document.querySelectorAll('.day-tab')].find(x => x.dataset.tab === 'qq'); if (t) t.click(); })()`);
    await b.waitFor(`!!document.querySelector('#qqMode')`, 10000);
    await sleep(800);
    await shot('23-QQ面板');
  } finally {
    await b.close();
  }
} finally {
  // 还原：删演示日程、恢复 QQ 设置、关假后端
  for (const id of createdEvents) await j('/api/calendar/' + id, { method: 'DELETE' }).catch(() => {});
  await j('/api/settings', {
    method: 'PUT',
    body: {
      qqMode: saved.qqMode, qqBaseUrl: saved.qqBaseUrl, qqUid: saved.qqUid,
      qqGroup: saved.qqGroup, qqCallName: saved.qqCallName, qqPollMs: saved.qqPollMs,
    },
  }).catch(() => {});
  await new Promise(r => onebot.close(r));
  console.log('已还原日程与 QQ 设置');
}
