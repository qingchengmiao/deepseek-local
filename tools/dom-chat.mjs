// 浏览器端整链路：把设置指向假上游 → 在真浏览器里发一条联网消息 → 检查流式渲染
// 用法：先起服务（8787），再 node tools/dom-chat.mjs
import { liveGuard } from './_guard.mjs';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { launch, sleep } from './cdp.mjs';

const APP = process.env.BASE || 'http://127.0.0.1:8787';
await liveGuard(APP, 'dom-chat');
const MOCK = 'http://127.0.0.1:8899';

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

async function json(path, opts) {
  const res = await fetch(APP + path, opts);
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  return { res, data };
}

async function mockUp() {
  try {
    const r = await fetch(MOCK + '/models', { signal: AbortSignal.timeout(600) });
    if (r.ok) return null;
  } catch {}
  const child = spawn(process.execPath, ['tools/mock-upstream.mjs'], { stdio: 'ignore', detached: true });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    try {
      const r = await fetch(MOCK + '/models', { signal: AbortSignal.timeout(500) });
      if (r.ok) return child;
    } catch {}
  }
  throw new Error('假上游没起来');
}

const orig = (await json('/api/settings')).data;
const mockChild = await mockUp();
const beforeIds = (await json('/api/state')).data.conversations.map(c => c.id);

const b = await launch({ port: 9335 });
try {
  // 指向假上游
  await json('/api/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: 'sk-mock-ui-key', baseUrl: MOCK, model: 'deepseek-flash', webSearch: true, thinking: true, autoTitle: true, safetyLevel: 'off', readLink: true }),
  });

  await b.goto(APP);
  check('页面打开', await b.waitFor(`typeof S === 'object' && document.readyState === 'complete'`, 10000));
  check('Key 状态已更新', await b.waitFor(`S.settings.hasKey === true`, 6000));
  check('联网开关默认点亮', await b.waitFor(`document.querySelector('#webChip').classList.contains('on')`, 5000));

  console.log('1) 发一条会联网的消息');
  await b.ev(`document.querySelector('#newChatBtn').click()`);
  await sleep(500);
  await b.ev(`(() => { const ta = document.querySelector('#input'); ta.value = '查一下今天的新闻'; ta.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(200);
  check('发送按钮可用', await b.ev(`document.querySelector('#sendBtn').disabled === false`));
  await b.ev(`document.querySelector('#sendBtn').click()`);

  check('出现深度思考折叠块', await b.waitFor(`document.querySelectorAll('#messages .msg.assistant .reason').length > 0`, 10000));
  check('思考过程有文字', await b.waitFor(`/先想想这个问题/.test(document.querySelector('#messages').textContent)`, 10000));
  check('出现联网过程卡片', await b.waitFor(`document.querySelectorAll('#messages .tool-card').length > 0`, 10000));
  check('卡片里有搜索词', await b.waitFor(`/测试查询/.test(document.querySelector('#messages').textContent)`, 10000));
  check('卡片里有来源标题', await b.waitFor(`/示例来源：一个网页/.test(document.querySelector('#messages').textContent)`, 12000));
  check('正文流式打到页面上', await b.waitFor(`/这是第一句/.test(document.querySelector('#messages').textContent)`, 12000));
  check('出现正文引用角标', await b.waitFor(`document.querySelectorAll('#messages sup.cite a').length > 0`, 15000));
  {
    const href = await b.ev(`(document.querySelector('#messages sup.cite a') || {}).href || ''`);
    check('角标指向真实来源', href.includes('example.com'), href);
  }
  check('流式结束后停用停止状态', await b.waitFor(`document.querySelector('#sendBtn').classList.contains('stop') === false`, 15000));
  check('标题被自动改成「测试标题」', await b.waitFor(`document.querySelector('#convTitle').textContent.trim() === '测试标题'`, 10000),
    await b.ev(`document.querySelector('#convTitle').textContent.trim()`));
  check('用量显示 token 数', await b.waitFor(`/↑\\s*100/.test(document.querySelector('#messages').textContent)`, 8000),
    (await b.ev(`(document.querySelector('#messages .msg-time') || {}).textContent || ''`)).trim());
  check('助手消息有「继续」和「朗读」', await b.ev(`!!document.querySelector('#messages .act-continue, [data-act="continue"]') || /继续/.test(document.querySelector('#messages').textContent)`) &&
    !!await b.ev(`!!document.querySelector('#messages [data-act="speak"], .act-speak')`));

  console.log('2) 刷新后历史还在（落盘正确）');
  {
    await b.goto(APP);
    check('重新加载后能读到会话', await b.waitFor(`typeof S === 'object' && S.conversations.some(c => c.title === '测试标题')`, 12000));
    await b.ev(`(() => { const it = [...document.querySelectorAll('#convList .conv-item')].find(el => /测试标题/.test(el.textContent)); if (it) it.click(); })()`);
    check('打开后正文完整', await b.waitFor(`/这是第一句/.test(document.querySelector('#messages').textContent)`, 12000));
    check('打开后引用角标还在', await b.waitFor(`document.querySelectorAll('#messages sup.cite a').length > 0`, 8000));
    check('打开后工具卡片还在', await b.waitFor(`document.querySelectorAll('#messages .tool-card').length > 0`, 8000));
  }

  console.log('3) 朗读按钮（TTS）');
  {
    check('朗读按钮存在', await b.ev(`!!document.querySelector('#messages .act-speak')`));
    check('有 audio 容器', await b.ev(`!!document.querySelector('#audioHost')`));
  }

  console.log('4) 附件选择器与语音按钮接线');
  {
    check('附件按钮存在且能点', await b.ev(`!!document.querySelector('#attachChip')`));
    check('附件 input 接受图片和文档', await b.ev(`(() => { const a = document.querySelector('#attachInput').accept; return a.includes('image/png') && a.includes('.pdf') && a.includes('.docx'); })()`));
    check('语音按钮存在', await b.ev(`!!document.querySelector('#micChip')`));

  console.log('上下文徽标（发完一轮应该更新）');
  {
    check('发完一轮后徽标不隐藏', await b.ev("!document.querySelector('#ctxBadge').classList.contains('hidden')"));
    const label = await b.ev("document.querySelector('#ctxLabel').textContent.trim()");
    check('徽标有占用数字', /%|超预算/.test(label), label);
    check('徽标 title 提到 token 预算', /token/.test(await b.ev("document.querySelector('#ctxBadge').title")));

    await b.ev("document.querySelector('#ctxBadge').click()");
    check('上下文面板能打开', await b.waitFor("!!document.querySelector('.modal .ctx-meter')", 6000));
    check('面板显示预算', /token/.test(await b.ev("document.querySelector('.modal .sub').textContent")));
    await b.ev("(() => { const b = [...document.querySelectorAll('.modal [data-x]')].find(x => x.textContent.includes('关掉')); if (b) b.click(); })()");
  }
  }
} finally {
  await b.close();
  // 清掉这轮造出来的会话 + 还原设置
  try {
    const list = (await json('/api/state')).data.conversations;
    for (const c of list) {
      if (!beforeIds.includes(c.id)) await json('/api/conversations/' + c.id, { method: 'DELETE' });
    }
  } catch {}
  const restore = {
    baseUrl: orig.baseUrl,
    model: orig.model || 'deepseek-flash',
    webSearch: !!orig.webSearch,
    readLink: orig.readLink !== false,
    autoTitle: orig.autoTitle !== false,
    safetyLevel: orig.safetyLevel || 'off',
    thinking: orig.thinking !== false,
    reasoningEffort: orig.reasoningEffort || 'high',
  };
  if (!orig.hasKey) restore.apiKey = '';
  await json('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(restore) });
  if (mockChild) { try { process.kill(-mockChild.pid); } catch { try { mockChild.kill(); } catch {} } }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
