// 给设置页的「技能包」拍一张，顺手核对技能列表与勾选状态。
// 用法：node tools/shot-skills.mjs [BASE]
import { writeFileSync } from 'node:fs';
import { launch, sleep } from './cdp.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const { cdp, ev, goto, waitFor, close } = await launch({ width: 1360, height: 900, port: 9363 });

try {
  await goto(BASE);
  await waitFor(`!!document.querySelector('#settingsBtn')`, 15000);
  await sleep(500);
  await ev(`(() => { document.querySelector('#settingsBtn')?.click(); return true; })()`);
  await sleep(1200);

  const info = await ev(`(() => {
    const box = document.querySelector('#setSkills');
    const rows = [...document.querySelectorAll('#setSkills .skill-row')];
    return {
      hasBox: !!box,
      rows: rows.length,
      picks: [...document.querySelectorAll('.skill-pick')].map(i => ({ id: i.value, checked: i.checked })),
      names: rows.map(r => r.querySelector('.lbl')?.textContent || ''),
    };
  })()`);
  console.log('技能控件:', JSON.stringify(info));

  await ev(`(() => {
    const box = document.querySelector('#setSkills');
    if (box) box.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  await sleep(600);

  const s = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('data/shots/100-设置-技能包.png', Buffer.from(s.data, 'base64'));
  console.log('shot data/shots/100-设置-技能包.png');
} finally {
  await close();
}
