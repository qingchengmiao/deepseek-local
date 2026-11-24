// 截图：会话面板的记忆预设芯片 + 设置页的全局预设行
import fs from 'node:fs';
import path from 'node:path';
import { launch } from './cdp.mjs';

const BASE = 'http://127.0.0.1:8787';
const CID = process.argv[2] || 'c_mEslcTXCJoga';
const OUT = path.resolve('data/shots');
fs.mkdirSync(OUT, { recursive: true });
const { cdp, ev, goto, waitFor, close } = await launch({ width: 1400, height: 1200, port: 9391 });

async function shot(name, sel) {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log(name, fs.statSync(file).size, 'B', sel || '');
}

try {
  await goto(`${BASE}/#c/${CID}`);
  await waitFor('#ctxBadge', 20000);
  console.log('面板芯片:', await ev(`(async () => {
    document.querySelector('#ctxBadge').click();
    for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 100)); if (document.querySelector('[data-preset]')) break; }
    const chips = [...document.querySelectorAll('[data-preset]')].map(b => b.textContent.trim() + (b.classList.contains('on') ? '*' : ''));
    const lbl = document.querySelector('.modal-mask .field label');
    return JSON.stringify({ chips, masks: document.querySelectorAll('.modal-mask').length });
  })()`));
  await shot('112-面板-记忆预设.png');

  // 设置页
  await ev(`document.querySelector('.modal-mask .modal-foot .btn, .modal-mask [data-x="close"]')?.click() ?? document.querySelector('#ctxBadge').click()`);
  await ev(`(async () => { const b = document.querySelector('[data-open-settings]') || document.querySelector('#settingsBtn'); b.click(); for (let i=0;i<80;i++){ await new Promise(r=>setTimeout(r,100)); if (document.querySelector('[data-gpreset]')) break; } return 'ok'; })()`);
  console.log('全局预设:', await ev(`(() => {
    const chips = [...document.querySelectorAll('[data-gpreset]')].map(b => b.textContent.trim() + (b.classList.contains('on') ? '*' : ''));
    return JSON.stringify({ chips });
  })()`));
  await ev(`document.querySelector('[data-gpreset]')?.scrollIntoView({ block: 'center' })`);
  await shot('113-设置-全局记忆预设.png');

  // 清理：把会话恢复成跟随全局（探针会改状态）
  console.log('恢复:', await ev(`(async () => {
    const r = await fetch('/api/ctx-presets/apply', { method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ presetId: '', conversationId: ${JSON.stringify(CID)} }) });
    return JSON.stringify({ status: r.status, body: await r.json() });
  })()`));
} finally {
  await close();
}
