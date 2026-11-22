import { launch, sleep } from './cdp.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const { cdp, ev, waitFor, close } = await launch({ width: 1280, height: 900, port: 9338 });
try {
  await cdp('Page.navigate', { url: BASE + '/' });
  await waitFor("document.documentElement.dataset.ready === '1'", 15000);
  await sleep(800);

  // 装监听，记录 selectionchange / scroll / mousedown / 隐藏时刻
  await ev(`(() => {
    window.__trace = [];
    const t = (k, extra) => window.__trace.push({ t: Date.now(), k, ...extra });
    document.addEventListener('selectionchange', () => {
      const s = window.getSelection();
      t('selectionchange', { collapsed: s ? s.isCollapsed : null, len: s ? s.toString().length : 0 });
    });
    window.addEventListener('scroll', (e) => t('scroll', { target: e.target && e.target.id || String(e.target) }), true);
    document.addEventListener('mousedown', (e) => t('mousedown', { tag: e.target && e.target.id || (e.target && e.target.className) || '' }), true);
    const b = document.querySelector('#selCopy');
    t('init', { hidden: b.classList.contains('hidden') });
    return true;
  })()`);

  const sel = await ev(`(() => {
    const box = document.querySelector('#messages .bubble') || document.querySelector('#messages .md');
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    let n = null, picked = null;
    while ((n = walker.nextNode())) { if (n.nodeValue && n.nodeValue.trim().length > 6) { picked = n; break; } }
    const r = document.createRange();
    r.setStart(picked, 0); r.setEnd(picked, Math.min(12, picked.nodeValue.length));
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    return { text: s.toString(), anchor: picked.parentElement && picked.parentElement.className };
  })()`);
  console.log('选区:', JSON.stringify(sel));

  for (let i = 0; i < 8; i += 1) {
    await sleep(120);
    const st = await ev(`(() => { const b = document.querySelector('#selCopy'); const s = window.getSelection(); return { hidden: b.classList.contains('hidden'), left: b.style.left, selLen: s ? s.toString().length : -1, collapsed: s ? s.isCollapsed : null }; })()`);
    console.log(`t+${(i + 1) * 120}ms`, JSON.stringify(st));
  }
  const trace = await ev('window.__trace');
  console.log('trace:', JSON.stringify(trace, null, 1));
} finally {
  await close();
}
