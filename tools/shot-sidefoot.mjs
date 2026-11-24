// 拍左下角图标条：收起 / 展开两态，并核对设置按钮已在右上角
// 用法：node tools/shot-sidefoot.mjs [BASE]
import { writeFileSync } from 'node:fs';
import { launch, sleep } from './cdp.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const { cdp, ev, goto, waitFor, close } = await launch({ width: 1360, height: 860, port: 9368 });

const state = () => `(() => {
  const box = document.querySelector('#sideFoot');
  const btns = [...box.querySelectorAll('.foot-btn')];
  const r = box.getBoundingClientRect();
  const top = document.querySelector('#topbar #settingsBtn');
  const tr = top ? top.getBoundingClientRect() : null;
  return {
    box: { w: Math.round(r.width), h: Math.round(r.height) },
    expanded: box.classList.contains('expanded'),
    rows: new Set(btns.map(b => Math.round(b.getBoundingClientRect().top))).size,
    count: btns.length,
    labelsVisible: btns.filter(b => getComputedStyle(b.querySelector('.foot-label')).display !== 'none').length,
    settingsInTopbar: !!top,
    settingsAt: tr ? { x: Math.round(tr.x), y: Math.round(tr.y) } : null,
  };
})()`;

try {
  await goto(BASE);
  await waitFor(`!!document.querySelector('#convList')`, 15000);
  await sleep(900);

  await ev(`localStorage.removeItem('dsh.sideFootExpanded'); location.reload(); true`);
  await waitFor(`!!document.querySelector('#footMore')`, 15000);
  await sleep(900);
  console.log('收起态:', JSON.stringify(await ev(state())));
  let s = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('data/shots/104-左下角-收起.png', Buffer.from(s.data, 'base64'));

  await ev(`document.querySelector('#footMore').click(); true`);
  await sleep(500);
  console.log('展开态:', JSON.stringify(await ev(state())));
  s = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('data/shots/105-左下角-展开.png', Buffer.from(s.data, 'base64'));

  // 刷新后应记住展开
  await ev(`location.reload(); true`);
  await waitFor(`!!document.querySelector('#footMore')`, 15000);
  await sleep(900);
  console.log('刷新后:', JSON.stringify(await ev(state())));

  console.log('shot data/shots/104-左下角-收起.png, data/shots/105-左下角-展开.png');
} finally {
  await close();
}
