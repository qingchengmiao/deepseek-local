// 悬停提示（圆角气泡）验收：真 hover 一次，看气泡是否圆角、文字对不对、系统 title 是否被收走
// 用法：node tools/hover-tip-test.mjs [BASE]
import { writeFileSync } from 'node:fs';
import { launch, sleep } from './cdp.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const { cdp, ev, waitFor, close } = await launch({ width: 1280, height: 900, port: 9355 });
try {
  await cdp('Page.navigate', { url: BASE });
  await waitFor("document.documentElement.dataset.ready === '1'", 15000);
  await sleep(600);

  console.log('\n1) 悬停「附件」胶囊');
  const rect = await ev(`(() => { const el = document.querySelector('#attachChip'); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, title: el.getAttribute('title') }; })()`);
  check('胶囊有 title', !!rect.title, rect.title);

  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none' });
  await sleep(520);

  const tip = await ev(`(() => { const t = document.querySelector('#hoverTip'); if (!t) return { exists: false }; const cs = getComputedStyle(t); const r = t.getBoundingClientRect(); return { exists: true, on: t.classList.contains('on'), text: t.textContent, radius: cs.borderRadius, position: cs.position, z: cs.zIndex, opacity: cs.opacity, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  check('气泡元素在', tip.exists === true);
  check('气泡已显示', tip.on === true, `opacity=${tip.opacity}`);
  check('文案等于 title', tip.text === rect.title, `${tip.text}`);
  check('圆角 10px', tip.radius === '10px', tip.radius);
  check('固定浮层定位', tip.position === 'fixed' && Number(tip.z) >= 300, `${tip.position} z=${tip.z}`);
  const above = tip.y + tip.h <= Math.round(rect.y) + 2;
  const below = tip.y >= Math.round(rect.y) - 2;
  check('落在胶囊外侧（不压字）', (above || below) && tip.w > 0 && tip.h > 0, `气泡 ${tip.x},${tip.y} ${tip.w}×${tip.h} / 胶囊 y=${Math.round(rect.y)}`);
  check('系统 title 被收走（不冒方块气泡）', (await ev(`document.querySelector('#attachChip').getAttribute('title')`)) === '', '');
  check('文字存进 data-tip', (await ev(`document.querySelector('#attachChip').dataset.tip`)) === rect.title);

  {
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync('data/shots/96-悬停提示-圆角.png', Buffer.from(shot.data, 'base64'));
  }

  console.log('\n2) 移开鼠标就收起');
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 20, button: 'none' });
  await sleep(260);
  check('气泡收起', (await ev(`document.querySelector('#hoverTip').classList.contains('on')`)) === false);

  console.log('\n3) 底栏按钮也能用');
  const b = await ev(`(() => { const el = document.querySelector('#importNavBtn'); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none' });
  await sleep(520);
  const tip2 = await ev(`(() => { const t = document.querySelector('#hoverTip'); return { on: t.classList.contains('on'), text: t.textContent, radius: getComputedStyle(t).borderRadius }; })()`);
  check('底栏按钮气泡显示', tip2.on === true);
  check('底栏按钮文案正确', /导入/.test(tip2.text), tip2.text);
  check('仍是圆角', tip2.radius === '10px', tip2.radius);
} finally {
  await close();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
