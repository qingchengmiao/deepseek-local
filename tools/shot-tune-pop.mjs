// 截图 + 实测：侧栏「调」弹窗改上下文预算（曾经写短名被服务端静默丢掉，且保存后崩在 renderConversations）
import fs from 'node:fs';
import path from 'node:path';
import { launch } from './cdp.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const OUT = path.resolve('data/shots');
fs.mkdirSync(OUT, { recursive: true });
const { cdp, ev, goto, waitFor, close } = await launch({ width: 1400, height: 1100, port: 9391 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log('截图', name, fs.statSync(file).size, 'B');
}

let cid = '';
try {
  // 造一个临时会话，别动真会话的状态（用 Node 侧 fetch，页面还是 about:blank 时相对地址不可用）
  const created = await fetch(BASE + '/api/conversations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '调窗探针' }),
  }).then((r) => r.json());
  cid = (created.conversation && created.conversation.id) || '';
  console.log('临时会话', cid);
  if (!cid) throw new Error('建会话失败');

  await goto(BASE);
  await waitFor(`[data-tune="${cid}"]`, 20000);

  console.log('打开弹窗:', await ev(`(async () => {
    const btn = document.querySelector('[data-tune="${cid}"]');
    btn.click();
    for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 80)); if (document.querySelector('.tune-pop #tuneBudget')) break; }
    const pop = document.querySelector('.tune-pop');
    if (!pop) return JSON.stringify({ ok: false, why: '.tune-pop 没出来' });
    return JSON.stringify({ ok: true, budgetTag: pop.querySelector('#tuneBudget').tagName + '/' + pop.querySelector('#tuneBudget').type,
      budget: pop.querySelector('#tuneBudget').value, topK: pop.querySelector('#tuneTopK').value,
      half: pop.querySelector('#tuneHalf').value, hasFooter: !!pop.querySelector('[data-tune-act="save"]') });
  })()`));
  await shot('114-调这个会话-弹窗.png');

  console.log('保存 200000:', await ev(`(async () => {
    const pop = document.querySelector('.tune-pop');
    const inp = pop.querySelector('#tuneBudget');
    inp.value = '200000';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    const tEl = document.querySelector('#toast'); if (tEl) tEl.textContent = ''; pop.querySelector('[data-tune-act="save"]').click();
    let toastText = '';
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100));
      const t = document.querySelector('#toast');
      if (t && t.textContent.trim()) { toastText = t.textContent.trim(); break; }
    }
    const r = await fetch('/api/conversations/${cid}');
    const b = await r.json();
    return JSON.stringify({ toast: toastText, ctx: (b.conversation && b.conversation.ctx) || null,
      popGone: !document.querySelector('.tune-pop') });
  })()`));

  console.log('重开回显:', await ev(`(async () => {
    document.querySelector('[data-tune="${cid}"]').click();
    for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 80)); if (document.querySelector('.tune-pop #tuneBudget')) break; }
    const v = document.querySelector('.tune-pop #tuneBudget').value;
    document.querySelector('.tune-pop [data-tune-act="cancel"]').click();
    return JSON.stringify({ budget: v });
  })()`));

  console.log('清空回全局:', await ev(`(async () => {
    document.querySelector('[data-tune="${cid}"]').click();
    for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 80)); if (document.querySelector('.tune-pop #tuneBudget')) break; }
    const pop = document.querySelector('.tune-pop');
    pop.querySelector('#tuneBudget').value = '';
    const tEl = document.querySelector('#toast'); if (tEl) tEl.textContent = ''; pop.querySelector('[data-tune-act="save"]').click();
    let toastText = '';
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100));
      const t = document.querySelector('#toast');
      if (t && t.textContent.trim()) { toastText = t.textContent.trim(); break; }
    }
    const r = await fetch('/api/conversations/${cid}');
    const b = await r.json();
    return JSON.stringify({ toast: toastText, ctx: (b.conversation && b.conversation.ctx) || null });
  })()`));
} finally {
  if (cid) {
    try {
      const r = await ev(`(async () => { const x = await fetch('/api/conversations/${cid}', { method: 'DELETE' }); return x.status; })()`);
      console.log('删临时会话', r);
    } catch (e) { console.log('删临时会话失败', e.message); }
  }
  await close();
}
