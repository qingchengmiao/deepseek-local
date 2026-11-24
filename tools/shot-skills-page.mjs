// 给「技能」页拍一张：点侧栏技能按钮 → 读列表 → 截图。
// 用法：node tools/shot-skills-page.mjs [BASE]
import { writeFileSync } from 'node:fs';
import { launch, sleep } from './cdp.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const { cdp, ev, goto, waitFor, close } = await launch({ width: 1400, height: 920, port: 9364 });

try {
  await goto(BASE);
  await waitFor(`!!document.querySelector('#skillsNavBtn')`, 15000);
  await sleep(400);
  await ev(`(() => { document.querySelector('#skillsNavBtn')?.click(); return true; })()`);
  await waitFor(`!!document.querySelector('#skDrop')`, 10000);
  await sleep(900);

  const info = await ev(`(() => {
    const rows = [...document.querySelectorAll('.sk-row')].map(r => ({
      id: r.dataset.id,
      name: r.querySelector('.sk-name')?.textContent || '',
      desc: (r.querySelector('.sk-desc')?.textContent || '').slice(0, 40),
      meta: r.querySelector('.sk-meta')?.textContent || '',
      checked: !!r.querySelector('.sk-toggle')?.checked,
    }));
    return {
      title: document.querySelector('#pageTitle')?.textContent || '',
      sub: document.querySelector('#pageSub')?.textContent || '',
      hasDrop: !!document.querySelector('#skDrop'),
      rows,
    };
  })()`);
  console.log('技能页:', JSON.stringify(info));

  const s = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('data/shots/101-技能页.png', Buffer.from(s.data, 'base64'));
  console.log('shot data/shots/101-技能页.png');
} finally {
  await close();
}
