// 导入页的端到端 UI 测试：底栏按钮进入 → 造一个 bundle.json 丢进去 → 认出 → 真导入 → 会话数 +2 → 截图。
// 用法：node tools/import-page-test.mjs [BASE] [shotsDir]
// 只在传进来的实例上操作（默认 8799 隔离实例），不要指向正在用的 8787。
import { launch, sleep } from './cdp.mjs';
import { writeFileSync } from 'node:fs';

const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:8799';
const SHOTS = process.argv[3] || 'data/shots';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const bundle = {
  conversations: [
    { title: '导入页试验甲', messages: [{ role: 'user', content: '第一条' }, { role: 'assistant', content: '收到' }] },
    { title: '导入页试验乙', messages: [{ role: 'user', content: '第二条' }] },
  ],
};

async function apiState() {
  const r = await fetch(`${BASE}/api/state`);
  return r.json();
}

const { cdp, ev, waitFor, close } = await launch({ width: 1360, height: 900, port: 9347 });
try {
  const before = (await apiState()).conversations || [];
  console.log(`目标: ${BASE}（导入前 ${before.length} 个会话）\n`);

  await cdp('Page.navigate', { url: `${BASE}/` });
  await waitFor("document.documentElement.dataset.ready === '1'", 15000);
  await sleep(600);

  console.log('1) 底栏按钮进页');
  const navText = await ev(`(() => { const b = document.querySelector('#importNavBtn'); return b ? b.textContent.trim() : ''; })()`);
  check('底栏有「导入」按钮', navText === '导入', `text=${navText}`);
  await ev(`document.querySelector('#importNavBtn').click()`);
  await sleep(700);
  const page = await ev(`(() => ({
    pageShown: !document.querySelector('#pageView')?.classList.contains('hidden'),
    title: document.querySelector('#pageTitle')?.textContent.trim() || '',
    hasDrop: !!document.querySelector('.imp-drop'),
    hasList: !!document.querySelector('#impList'),
    hasTips: !!document.querySelector('.imp-tips'),
    runDisabled: document.querySelector('#impRun')?.disabled,
    activeNav: document.querySelector('#importNavBtn')?.classList.contains('on') ? 'y' : 'n',
  }))()`);
  check('切到了整页视图', page.pageShown === true, `pageShown=${page.pageShown}`);
  check('页标题是「导入对话」', page.title === '导入对话', `title=${page.title}`);
  check('有拖放区 / 列表 / 说明', page.hasDrop && page.hasList && page.hasTips);
  check('空态时「开始导入」是灰的', page.runDisabled === true);
  check('底栏按钮高亮', page.activeNav === 'y');

  console.log('\n2) 塞一个 JSON 整包进去 → 自动辨认');
  await ev(`(async () => {
    const file = new File([${JSON.stringify(JSON.stringify(bundle))}], 'bundle.json', { type: 'application/json' });
    await addImportFiles([file]);
    return 1;
  })()`);
  await sleep(1500);
  const item = await ev(`(() => {
    const el = document.querySelector('.imp-item');
    return {
      n: document.querySelectorAll('.imp-item').length,
      cls: el?.className || '',
      name: el?.querySelector('.imp-name')?.textContent.trim() || '',
      meta: el?.querySelector('.imp-meta')?.textContent.trim() || '',
      runDisabled: document.querySelector('#impRun')?.disabled,
      runText: document.querySelector('#impRun')?.textContent.trim() || '',
    };
  })()`);
  check('列表里有一项', item.n === 1, `n=${item.n}`);
  check('认出来了（不是 err）', !item.cls.includes('err'), `class=${item.cls}`);
  check('显示文件名', item.name.includes('bundle.json'), `name=${item.name}`);
  check('显示识别结论与预计对话数', item.meta.includes('对话 JSON 整包') && item.meta.includes('2 个对话'), `meta=${item.meta}`);
  check('「开始导入」变成可点', item.runDisabled === false, `text=${item.runText}`);

  {
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${SHOTS}/90-导入页-识别后.png`, Buffer.from(shot.data, 'base64'));
  }

  console.log('\n3) 点「开始导入」→ 真的落库');
  await ev(`document.querySelector('#impRun').click()`);
  let done = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(300);
    const st = await ev(`(() => ({ cls: document.querySelector('.imp-item')?.className || '', toast: document.querySelector('#toast')?.textContent || '' }))()`);
    if (st.cls.includes('done')) { done = true; break; }
  }
  check('该项变成 done', done);
  await sleep(400);
  const after = (await apiState()).conversations || [];
  check('会话数 +2', after.length === before.length + 2, `${before.length} → ${after.length}`);
  const titles = after.map(c => c.title);
  check('新会话标题进列表', titles.includes('导入页试验甲') && titles.includes('导入页试验乙'), titles.slice(0, 4).join(','));

  {
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${SHOTS}/91-导入页-导入完成.png`, Buffer.from(shot.data, 'base64'));
  }

  console.log('\n4) 从设置页也能进来');
  await ev(`document.querySelector('#settingsBtn').click()`);
  await sleep(700);
  await ev(`document.querySelector('#setImport').click()`);
  await sleep(700);
  const back = await ev(`(() => ({ on: document.querySelector('#importNavBtn')?.classList.contains('on') ? 'y' : 'n', title: document.querySelector('#pageTitle')?.textContent.trim() || '' }))()`);
  check('设置页入口跳到导入页', back.on === 'y' && back.title === '导入对话', `on=${back.on} title=${back.title}`);
} finally {
  await close();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
