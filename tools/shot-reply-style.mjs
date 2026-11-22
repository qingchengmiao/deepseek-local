// 给设置页的「回复风格」拍一张，顺手核对默认值真的是 human。
// 用法：node tools/shot-reply-style.mjs [BASE]
import { writeFileSync } from 'node:fs';
import { launch, sleep } from './cdp.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const { cdp, ev, goto, waitFor, close } = await launch({ width: 1360, height: 900, port: 9362 });

try {
  await goto(BASE);
  await waitFor(`!!document.querySelector('#settingsBtn')`, 15000);
  await sleep(500);

  // 左下角「设置」
  const okNav = await ev(`(() => {
    const el = document.querySelector('#settingsBtn');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  console.log('进设置页:', okNav);
  await sleep(900);

  const info = await ev(`(() => {
    const sel = document.querySelector('#setReplyStyle');
    const sys = document.querySelector('#setSystem');
    return {
      hasSelect: !!sel,
      value: sel ? sel.value : '',
      options: sel ? [...sel.options].map(o => o.value) : [],
      hasSystem: !!sys,
      tip: sel ? (sel.closest('.field')?.querySelector('.tip')?.textContent || '') : '',
    };
  })()`);
  console.log('回复风格控件:', JSON.stringify(info));

  // 滚到那一行再截
  await ev(`(() => {
    const sel = document.querySelector('#setReplyStyle');
    if (sel) sel.closest('.field').scrollIntoView({ block: 'center' });
    return true;
  })()`);
  await sleep(600);

  const s = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('data/shots/99-设置-回复风格.png', Buffer.from(s.data, 'base64'));
  console.log('shot data/shots/99-设置-回复风格.png');
} finally {
  await close();
}
