// 给顶栏的「逐对话说话口径」下拉拍一张，并核对它真的能改到会话上。
// 用法：node tools/shot-voice-select.mjs [BASE]
import { writeFileSync } from 'node:fs';
import { launch, sleep } from './cdp.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const { cdp, ev, goto, waitFor, close } = await launch({ width: 1360, height: 900, port: 9367 });

try {
  await goto(BASE);
  await waitFor(`!!document.querySelector('#voiceSel')`, 15000);
  await sleep(600);

  // 打开第一条会话（顶栏才有口径下拉）
  const opened = await ev(`(() => {
    const el = document.querySelector('.conv-item');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  console.log('打开会话:', opened);
  await sleep(1400);

  const info = await ev(`(() => {
    const sel = document.querySelector('#voiceSel');
    if (!sel) return { missing: true };
    return {
      hidden: sel.classList.contains('hidden'),
      value: sel.value,
      options: [...sel.options].map(o => ({ v: o.value, t: o.textContent })),
      title: sel.title,
      on: sel.classList.contains('on'),
    };
  })()`);
  console.log('口径下拉:', JSON.stringify(info));

  // 选成 QQ 熟人，看 PATCH 有没有落到会话上
  const changed = await ev(`(() => {
    const sel = document.querySelector('#voiceSel');
    if (!sel) return false;
    sel.value = 'qq';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(900);
  const after = await ev(`(() => {
    const sel = document.querySelector('#voiceSel');
    return { value: sel.value, on: sel.classList.contains('on'), title: sel.title };
  })()`);
  console.log('改成 qq 后:', JSON.stringify(after), 'dispatched:', changed);

  // 拍顶栏
  const s = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('data/shots/103-顶栏-说话口径.png', Buffer.from(s.data, 'base64'));
  console.log('shot data/shots/103-顶栏-说话口径.png');
} finally {
  await close();
}
