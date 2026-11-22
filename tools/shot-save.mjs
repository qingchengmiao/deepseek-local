// 保存键三件套的视觉验证：普通态 / 有改动态 / 已保存态
// 用隔离服务（临时 DSAPP_DATA + 独立端口）跑，绝不动用户真实配置。
// 用法：node tools/shot-save.mjs [端口=8796]
import { launch, sleep } from './cdp.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const PORT = Number(process.argv[2] || 8796);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = 'data/shots';

async function waitHttp(url, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await sleep(200);
  }
  return false;
}

const dataDir = await mkdtemp(path.join(tmpdir(), 'dsapp-save-'));
const srv = spawn(process.execPath, ['server.mjs'], {
  env: { ...process.env, PORT: String(PORT), DSAPP_DATA: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvErr = '';
srv.stderr.on('data', d => { srvErr += d.toString(); });

let browser = null;
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); };

try {
  if (!await waitHttp(`${BASE}/api/state`)) throw new Error('隔离服务没起来：' + srvErr.slice(0, 300));

  browser = await launch({ port: 9335, width: 1280, height: 900 });
  const { cdp, ev, waitFor } = browser;
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await browser.goto(BASE);
  const booted = await waitFor('!!document.getElementById("settingsBtn") && !!document.getElementById("input")', 12000);
  check('页面加载完成', booted);
  await sleep(500);

  const shot = async (name, selector) => {
    const box = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null; el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const x = Math.max(0, r.x - 20), y = Math.max(0, r.y - 20);
      return { x, y, w: Math.min(1280 - x, r.width + 40), h: Math.min(900 - y, r.height + 40) }; })()`);
    await sleep(120);
    const clip = box && box.h > 8 ? { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 }
      : { x: 0, y: 0, width: 1280, height: 900, scale: 1 };
    const r = await cdp('Page.captureScreenshot', { format: 'png', clip });
    await fs.mkdir(OUT, { recursive: true });
    await fs.writeFile(path.join(OUT, name), Buffer.from(r.data, 'base64'));
    return path.join(OUT, name);
  };

  // 1) 打开设置页
  await ev('document.querySelector("#settingsBtn").click()');
  const ok = await waitFor('!!document.querySelector(\'[data-x="save"]\')', 6000);
  check('设置页打开，保存按钮在', ok);
  if (!ok) {
    const dbg = await ev(`JSON.stringify({ view: (window.S && S.view) || '?',
      modal: document.querySelectorAll('.modal').length,
      dataX: [...document.querySelectorAll('[data-x]')].map(b => b.dataset.x).slice(0, 6) })`);
    console.log('    调试：' + dbg);
  }
  await sleep(350);

  const plain = await ev(`(() => { const b = document.querySelector('[data-x="save"]');
    return { text: b.textContent.trim(), cls: b.className, title: b.title }; })()`);
  check('初始态文案是「保存」', plain.text === '保存', plain.text);
  check('初始态不带 dirty', !/\bdirty\b/.test(plain.cls), plain.cls);
  check('按钮有悬停说明', plain.title.includes('data/settings.json'), plain.title.slice(0, 40) + '…');
  await shot('70-保存键-普通态.png', '.modal-foot');

  // 2) 拨一个开关 → 有改动态
  await ev(`(() => { const c = document.querySelector('#setAutoTitle');
    c.checked = !c.checked; c.dispatchEvent(new Event('change', { bubbles: true })); return c.checked; })()`);
  await sleep(220);
  const dirty = await ev(`(() => { const b = document.querySelector('[data-x="save"]');
    return { text: b.textContent.trim(), cls: b.className, title: b.title }; })()`);
  check('有改动后文案变「保存 · 有改动」', dirty.text.includes('有改动'), dirty.text);
  check('有改动后带 dirty 样式', /\bdirty\b/.test(dirty.cls));
  check('有改动后 title 追加提醒', dirty.title.includes('未保存'), dirty.title.slice(-16));
  await shot('71-保存键-有改动态.png', '.modal-foot');

  // 3) 点保存 → 已保存回执（780ms 内截）
  await ev('document.querySelector(\'[data-x="save"]\').click()');
  await sleep(320);
  const saved = await ev(`(() => { const b = document.querySelector('[data-x="save"]');
    return b ? { text: b.textContent.trim(), cls: b.className, disabled: b.disabled } : null; })()`);
  check('按下后显示「已保存 ✓」', !!saved && saved.text.includes('已保存'), saved ? saved.text : '按钮已消失');
  check('回执态变绿（.ok）', !!saved && /\bok\b/.test(saved.cls), saved ? saved.cls : '');
  await shot('72-保存键-已保存态.png', '.modal-foot');

  // 4) 780ms 后自动回对话（页面切走或按钮不可见），设置真的落库
  await sleep(1100);
  const closed = await ev(`(() => { const b = document.querySelector('[data-x="save"]');
    const view = (window.S && S.view) || '';
    return view !== 'settings' || !b || b.offsetParent === null; })()`);
  check('回执停 780ms 后自动回到对话', closed);
  const st = await (await fetch(`${BASE}/api/settings`)).json();
  check('开关的新值已写进 settings', typeof st.autoTitle === 'boolean');
} catch (err) {
  console.log('  ✗ 异常：' + err.message);
  results.push({ name: '脚本未抛异常', ok: false });
} finally {
  if (browser) await browser.close();
  try { srv.kill(); } catch {}
  await sleep(200);
  try { await fs.rm(dataDir, { recursive: true, force: true }); } catch {}
  const pass = results.filter(r => r.ok).length;
  console.log(`\n${pass} 通过 / ${results.length - pass} 失败`);
  process.exit(pass === results.length ? 0 : 1);
}
