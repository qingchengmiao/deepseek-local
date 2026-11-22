// QQ 回话会话：接口三态 + 页面卡片端到端（只读，不产生对话；绑定状态会改）
import { launch, sleep } from './cdp.mjs';

const BASE = (process.argv[2] || process.env.BASE || 'http://127.0.0.1:8799').replace(/\/+$/, '');
let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
};
const getJson = async p => (await fetch(BASE + p)).json();

console.log(`目标: ${BASE}`);

/* ---------------- 1) 接口三态 ---------------- */
console.log('\n1) /api/qq/bind 三态');
const st0 = await getJson('/api/state');
const before = st0.conversations.length;

const created = await post('/api/qq/bind', { convId: '' });
check('空值 → 新建 QQ 会话', created.status === 200 && created.data.created === true, `title=${created.data?.conv?.title}`);
check('返回体带 state（前端可直接刷新）', !!created.data?.status?.conv?.title, `convId=${created.data?.status?.convId}`);
const createdId = created.data?.conv?.id || '';

const again = await post('/api/qq/bind', { convId: '' });
check('再新建一个 → 名字不重复', again.data?.conv?.title && again.data.conv.title !== created.data?.conv?.title, `title=${again.data?.conv?.title}`);

const victim = st0.conversations.find(c => c.source !== 'qq');
if (victim) {
  const bound = await post('/api/qq/bind', { convId: victim.id });
  check('绑已有对话', bound.status === 200 && bound.data.created === false && bound.data.conv.id === victim.id, `title=${bound.data?.conv?.title}`);
  const stQq = await getJson('/api/qq/state');
  check('状态里能看到绑的是哪个', stQq.conv && stQq.conv.id === victim.id && !stQq.conv.missing, `title=${stQq.conv?.title} messages=${stQq.conv?.messages}`);
}

const bad = await post('/api/qq/bind', { convId: 'c_not_exist_123' });
check('绑不存在的对话 → 400 + 说明', bad.status === 400 && /不在了/.test(bad.data?.error || ''), `status=${bad.status}`);

const after = (await getJson('/api/state')).conversations.length;
check('只加了两个 QQ 会话', after === before + 2, `${before} → ${after}`);

/* ---------------- 2) 页面卡片 ---------------- */
console.log('\n2) QQ 页「回话用哪个会话」');
const { cdp, ev, waitFor, close } = await launch({ width: 1360, height: 940, port: 9349 });
try {
  await cdp('Page.navigate', { url: `${BASE}/` });
  await waitFor("document.documentElement.dataset.ready === '1'", 15000);

  // 点底栏 QQ
  await ev(`(() => { document.querySelector('#qqNavBtn').click(); return 1; })()`);
  await sleep(700);
  const card = await ev(`(() => {
    const sel = document.querySelector('#qqConvSel');
    return { has: !!sel, opts: sel ? sel.options.length : 0, label: document.querySelector('#qqBindNow')?.textContent || '' };
  })()`);
  check('有会话选择器', card.has === true);
  check('选项含「自动」+ 现有对话', card.opts >= 3, `n=${card.opts}`);
  check('有「现在往哪个对话里说」的说明', /往「|还没绑定|不在了/.test(card.label), card.label.slice(0, 40));

  // 选一个真实对话并点「用它回话」
  const pick = await ev(`(() => {
    const sel = document.querySelector('#qqConvSel');
    const cur = (window.DAY && DAY.qq && DAY.qq.conv && DAY.qq.conv.id) || '';
    const opt = [...sel.options].find(o => o.value && o.value !== cur);
    if (!opt) return { ok: false };
    sel.value = opt.value;
    document.querySelector('[data-x="qqBind"]').click();
    return { ok: true, id: opt.value, text: opt.textContent };
  })()`);
  check('能选中并点「用它回话」', pick.ok === true, pick.text || '');
  await sleep(1200);
  const bound2 = await ev(`(() => {
    const sel = document.querySelector('#qqConvSel');
    return { now: document.querySelector('#qqBindNow')?.textContent || '', selVal: sel ? sel.value : '', toast: document.querySelector('#toast')?.textContent || '' };
  })()`);
  check('状态文字跟着变', /现在往「/.test(bound2.now) && bound2.now.includes((await getJson('/api/qq/state')).conv?.title || '§'), bound2.now.slice(0, 46));
  check('下拉框停在选中的那个', bound2.selVal === pick.id, `sel=${bound2.selVal}`);
  check('弹了「现在回话用…」提示', /回话用/.test(bound2.toast), bound2.toast.slice(0, 30));

  // 打开这个会话 → 应切到聊天页
  await ev(`document.querySelector('[data-x="qqOpenConv"]').click()`);
  await sleep(900);
  const opened = await ev(`(() => ({
    chatShown: !document.querySelector('#chatView')?.classList.contains('hidden'),
    title: document.querySelector('#convTitle')?.textContent || '',
  }))()`);
  check('「打开这个会话」切到聊天页', opened.chatShown === true, `title=${opened.title}`);

  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  writeFileSync('data/shots/92-QQ页-回话会话.png', Buffer.from(shot.data, 'base64'));
  console.log('  截图: data/shots/92-QQ页-回话会话.png');
} finally {
  await close();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
