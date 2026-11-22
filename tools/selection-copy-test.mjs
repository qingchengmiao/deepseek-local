// 验证「选中正文文字 → 浮出复制条 → 点一下就复制」，全程不用键盘
// 用法：node tools/selection-copy-test.mjs [BASE]
// 只读页面：不改设置、不写会话。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { launch, sleep } from './cdp.mjs';

const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:8787';
let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

// 在「当前视口里的最后一条消息」里造一段选区：不跟页面的自动滚动较劲
const selectVisible = `(() => {
  const sc = document.querySelector('#scroller') || document.querySelector('#messages');
  const scR = sc.getBoundingClientRect();
  const bubbles = [...document.querySelectorAll('#messages .bubble, #messages .md')].reverse();
  for (const box of bubbles) {
    const br = box.getBoundingClientRect();
    if (br.bottom < scR.top + 40 || br.top > scR.bottom - 40) continue;
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    let n = null;
    while ((n = walker.nextNode())) {
      if (!n.nodeValue || n.nodeValue.trim().length < 10) continue;
      const r = document.createRange();
      r.setStart(n, 0);
      r.setEnd(n, Math.min(12, n.nodeValue.length));
      const rc = r.getBoundingClientRect();
      if (!rc || !rc.width) continue;
      if (rc.top < scR.top + 8 || rc.bottom > scR.bottom - 8) continue;
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return { ok: true, text: s.toString(), top: Math.round(rc.top) };
    }
  }
  return { ok: false, why: '视口里没找到可选的文字' };
})()`;

const { cdp, ev, waitFor, close } = await launch({ width: 1280, height: 900, port: 9337 });
try {
  await cdp('Page.navigate', { url: BASE + '/' });
  await waitFor("document.documentElement.dataset.ready === '1'", 15000);
  // 正文区加载完会自己平滑滚到底；等 scrollTop 稳定再动手，否则选区会被滚动带跑
  let last = -1;
  for (let i = 0; i < 20; i += 1) {
    const pos = await ev(`(() => { const sc = document.querySelector('#scroller'); return sc ? Math.round(sc.scrollTop) : 0; })()`);
    if (pos === last) break;
    last = pos;
    await sleep(250);
  }
  await sleep(300);

  // 1) 结构
  check('#selCopy 存在', await ev("!!document.querySelector('#selCopy')"));
  check('默认是隐藏的', await ev("document.querySelector('#selCopy').classList.contains('hidden')"));

  // 2) 选中可见文字 → 浮出
  const sel = await ev(selectVisible);
  check('能造出选区', sel.ok === true, sel.why || '');
  await sleep(700);
  const shown = await ev(`(() => {
    const b = document.querySelector('#selCopy');
    return { hidden: b.classList.contains('hidden'), label: b.textContent.trim(), left: b.style.left, top: b.style.top };
  })()`);
  check('选中后复制条浮出', shown.hidden === false);
  check('按钮文案是「复制」', shown.label === '复制', shown.label);
  check('定位到了选区附近', /^-?\d+px$/.test(shown.left) && /^-?\d+px$/.test(shown.top), JSON.stringify(shown));

  // 3) 点它 → 提示「已复制」并自己收起
  await ev(`document.querySelector('#selCopy').click()`);
  await sleep(500);
  const after = await ev(`(() => {
    const t = document.querySelector('#toast');
    return {
      toast: t && !t.classList.contains('hidden') ? t.textContent.trim() : '',
      hidden: document.querySelector('#selCopy').classList.contains('hidden'),
    };
  })()`);
  check('点完提示「已复制」', after.toast.includes('已复制'), after.toast);
  check('复制完自己收起', after.hidden === true);

  // 4) 输入框里的选区不浮条（那里走右键菜单）
  const inInput = await ev(`(async () => {
    const ta = document.querySelector('#input');
    ta.focus();
    const r = document.createRange();
    r.selectNodeContents(ta);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    await new Promise((x) => setTimeout(x, 400));
    const hidden = document.querySelector('#selCopy').classList.contains('hidden');
    ta.blur();
    return hidden;
  })()`);
  check('输入框里的选区不浮条（那里用右键菜单）', inInput === true);

  // 5) Esc 能收起
  await sleep(300);
  const sel2 = await ev(selectVisible);
  await sleep(400);
  const beforeEsc = await ev("document.querySelector('#selCopy').classList.contains('hidden')");
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(250);
  const afterEsc = await ev("document.querySelector('#selCopy').classList.contains('hidden')");
  check('Esc 收起复制条', sel2.ok === true && beforeEsc === false && afterEsc === true, `sel=${sel2.ok} before=${beforeEsc} after=${afterEsc}`);

  // 6) Electron 侧右键菜单代码在位（浏览器里没有 electron 主进程，只能静态查）
  for (const p of ['electron/main.cjs', 'dist/DeepSeek-win32-x64/resources/app/electron/main.cjs']) {
    let src = '';
    try { src = readFileSync(path.resolve(p), 'utf8'); } catch {}
    const ok = /installEditMenu\(wc\)/.test(src) && /'context-menu'/.test(src) && /label: '粘贴'/.test(src);
    check(`右键菜单代码在位（${p}）`, ok);
  }
} finally {
  await close();
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
