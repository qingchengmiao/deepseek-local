// 给「QQ 通道 · 隔离实例（C++ 宿主）」那张卡拍图，并顺手核对状态接口。
// 用法：node tools/shot-napcat-host.mjs [BASE]
import { writeFileSync } from 'node:fs';
import { launch, sleep } from './cdp.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8811';
const { cdp, ev, waitFor, close } = await launch({ width: 1360, height: 900, port: 9361 });
const shot = async (name) => {
  const s = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`data/shots/${name}`, Buffer.from(s.data, 'base64'));
  console.log('shot', name);
};

try {
  await cdp('Page.navigate', { url: BASE });
  await waitFor("document.documentElement.dataset.ready === '1'", 20000);
  await sleep(600);
  await ev(`document.querySelector('#qqNavBtn').click()`);
  await sleep(900);

  // 点「刷新状态」，让卡片把宿主 JSON 画出来
  const clicked = await ev(`(() => {
    const b = document.querySelector('[data-x="napHostStatus"]');
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(2500);
  const box = await ev(`(() => (document.querySelector('#napHostBox') || {}).textContent || '')()`);
  console.log('找到卡:', clicked, '| 状态行:', String(box).replace(/\s+/g, ' ').slice(0, 200));

  // 顺手验证接口本身
  const st = await ev(`(async () => (await (await fetch('/api/napcat/host')).json()))()`);
  console.log('host api:', JSON.stringify({
    ok: st.ok, running: st.running, pids: st.processCount, httpUp: st.httpUp,
    loggedIn: st.loggedIn, shell: st.shell, login: st.login, qrHash: st.qr && st.qr.hash,
  }));

  await ev(`(() => { const c = document.querySelector('#napHostCard'); if (c) c.scrollIntoView({ block: 'center' }); })()`);
  await sleep(400);
  await shot('98-隔离实例-宿主卡片.png');
} finally {
  await close();
}
