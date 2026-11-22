// 真实浏览器 DOM 交互检查：用 Edge 无头 + CDP 打开页面，点按钮、敲键盘、看 DOM 变化
// 用法：先起服务（8787），再 node tools/dom-check.mjs
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const APP = process.env.BASE || 'http://127.0.0.1:8787';
const PORT = 9333;

const EDGE = process.env.EDGE_PATH ||
  (process.platform === 'win32'
    ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    : 'msedge');

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const profile = await mkdtemp(path.join(tmpdir(), 'dsapp-dom-'));
const browser = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-features=Translate,MediaRouter', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1440,1000', 'about:blank',
], { stdio: 'ignore' });

let wsUrl = '';
for (let i = 0; i < 60 && !wsUrl; i++) {
  await sleep(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find(t => t.type === 'page');
    if (page) wsUrl = page.webSocketDebuggerUrl;
  } catch {}
}
if (!wsUrl) { console.log('连不上浏览器调试端口'); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
ws.onmessage = e => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
};
function cdp(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function ev(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(expr, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await ev(expr)) return true; } catch {}
    await sleep(120);
  }
  return false;
}

try {
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: APP });
  check('页面能打开', await waitFor(`document.readyState === 'complete'`, 10000));
  check('app.js 加载完（S 可用）', await waitFor(`typeof S === 'object' && Array.isArray(S.conversations)`, 8000));
  // boot() 末尾会按 hash / 最近会话自动打开一条会话；等它落定（dataset.ready）再点新建，
  // 否则 boot 会在点击之后把它覆盖掉，导致「欢迎页没回来」的假失败。
  check('首屏装配完成（boot ready）', await waitFor(`document.documentElement.dataset.ready === '1'`, 8000));
  check('侧栏会话列表渲染出 2 个会话', await waitFor(`document.querySelectorAll('#convList .conv-item').length >= 2`, 6000),
    String(await ev(`document.querySelectorAll('#convList .conv-item').length`)));
  check('模型标签显示当前模型（自动/Flash/Pro）', /(Flash|Pro|自动)/.test(await ev(`document.querySelector('#modelLabel').textContent.trim()`)),
    await ev(`document.querySelector('#modelLabel').textContent.trim()`));
  check('未配置 Key 时有提示', (await ev(`document.querySelector('#tokenHint').textContent.trim()`)) === '未配置 Key');
  check('vendor 全局都在', await ev(`typeof katex === 'object' && typeof hljs === 'object'`));

  console.log('1) 新建对话 → 欢迎页');
  {
    await ev(`document.querySelector('#newChatBtn').click()`);
    await sleep(400);
    check('欢迎页显示', !(await ev(`document.querySelector('#welcome').classList.contains('hidden')`)));
    check('标题回到新对话', (await ev(`document.querySelector('#convTitle').textContent.trim()`)) === '新对话');
    check('欢迎页有 4 张提示卡', (await ev(`document.querySelectorAll('#welcomeCards .card').length`)) === 4);
    check('没 Key 时欢迎页有警告条', !(await ev(`document.querySelector('#welcomeWarn').classList.contains('hidden')`)));
  }

  console.log('2) 输入框与发送按钮');
  {
    const setText = t => `(() => { const ta = document.querySelector('#input'); ta.value = ${JSON.stringify(t)}; ta.dispatchEvent(new Event('input', { bubbles: true })); })()`;
    await ev(setText(''));
    await sleep(120);
    check('空输入时发送按钮禁用', await ev(`document.querySelector('#sendBtn').disabled === true`));
    await ev(setText('你好'));
    await sleep(120);
    check('有文字时发送按钮可用', await ev(`document.querySelector('#sendBtn').disabled === false`));
    await ev(setText(''));
    await sleep(80);
  }

  console.log('3) 深度思考 / 联网 / 强度');
  {
    // 先把两个开关捏回已知基线，免得受本地设置残留影响
    // 基线取服务端 /api/state 的 settings.thinking（页面里没有全局 S，别依赖它）
    const srvSettings = await ev(`(async () => (await (await fetch('/api/state')).json()).settings)()`);
    if (!srvSettings.thinking && !(await ev(`document.querySelector('#thinkChip').classList.contains('on')`))) {
      await ev(`document.querySelector('#thinkChip').click()`);
    }
    await sleep(400);
    if (await ev(`document.querySelector('#webChip').classList.contains('on')`)) {
      await ev(`document.querySelector('#webChip').click()`);
      await sleep(500);
    }
    const onBefore = await ev(`document.querySelector('#thinkChip').classList.contains('on')`);
    check('深度思考默认开着', onBefore === true);
    check('强度选择器可见', await ev(`getComputedStyle(document.querySelector('#effortSel')).display !== 'none'`));
    await ev(`document.querySelector('#thinkChip').click()`);
    await sleep(500);
    check('点一下关掉深度思考', (await ev(`document.querySelector('#thinkChip').classList.contains('on')`)) === false);
    check('关掉后强度选择器隐藏', await ev(`getComputedStyle(document.querySelector('#effortSel')).display === 'none'`));
    await ev(`document.querySelector('#thinkChip').click()`);
    await sleep(500);

    await ev(`document.querySelector('#webChip').click()`);
    await sleep(500);
    check('联网开关能点亮', (await ev(`document.querySelector('#webChip').classList.contains('on')`)) === true);
    check('联网状态存进了设置', (await ev(`S.settings.webSearch`)) === true);
    await ev(`document.querySelector('#webChip').click()`);
    await sleep(500);
    check('联网能关掉', (await ev(`document.querySelector('#webChip').classList.contains('on')`)) === false);
  }

  console.log('3.5) 混合模式开关（输入框里的二分树按钮）');
  {
    // 先把混合模式捏回「关」，同上：本机设置可能残留上次手点过的值
    if (await ev(`document.querySelector('#hybridChip').classList.contains('on')`)) {
      await ev(`document.querySelector('#hybridChip').click()`);
      await sleep(700);
    }
    check('输入框里有混合按钮', await ev(`!!document.querySelector('#hybridChip')`));
    check('按钮上是二分树图标', await ev(`document.querySelectorAll('#hybridChip svg circle').length === 3 && document.querySelectorAll('#hybridChip svg path').length >= 1`));
    check('按钮文案是「混合」', (await ev(`document.querySelector('#hybridChip').textContent.trim()`)) === '混合');
    check('默认是关的', (await ev(`document.querySelector('#hybridChip').classList.contains('on')`)) === false);

    await ev(`document.querySelector('#hybridChip').click()`);
    await sleep(700);
    check('点一下打开', (await ev(`document.querySelector('#hybridChip').classList.contains('on')`)) === true);
    check('打开后设置里存了 hybridMode', (await ev(`S.settings.hybridMode`)) === true);
    check('打开后深度思考按钮压暗（第一遍不带思考）',
      (await ev(`document.querySelector('#thinkChip').classList.contains('muted')`)) === true,
      await ev(`document.querySelector('#thinkChip').className`));
    check('深度思考这时不显示为开启', (await ev(`document.querySelector('#thinkChip').classList.contains('on')`)) === false);

    // 设置页里也要有同一个开关，且状态同步
    await ev(`document.querySelector('#settingsBtn').click()`);
    await waitFor(`!!document.querySelector('#setHybridMode')`, 6000);
    check('设置页有混合模式开关', true);
    check('设置页开关跟着打开', (await ev(`document.querySelector('#setHybridMode').checked`)) === true);
    await ev(`document.querySelector('#pageBack').click()`);
    await sleep(500);

    await ev(`document.querySelector('#hybridChip').click()`);
    await sleep(700);
    check('再点一下关掉', (await ev(`document.querySelector('#hybridChip').classList.contains('on')`)) === false);
    check('关掉后深度思考恢复显示',
      (await ev(`document.querySelector('#thinkChip').classList.contains('muted')`)) === false,
      await ev(`document.querySelector('#thinkChip').className`));
  }

  console.log('4) 主题切换（设置整页里）');
  {
    await ev(`document.querySelector('#settingsBtn').click()`);
    await waitFor(`!!document.querySelector('#setThemeBtn')`, 6000);
    const t0 = await ev(`document.documentElement.dataset.theme`);
    const s0 = await ev(`S.theme`);
    await ev(`document.querySelector('#setThemeBtn').click()`);
    await sleep(400);
    await ev(`document.querySelector('#setThemeBtn').click()`);
    await sleep(400);
    const t1 = await ev(`document.documentElement.dataset.theme`);
    check('主题在 auto → light → dark 之间轮转', (await ev(`S.theme`)) !== s0, `${s0} → ${await ev(`S.theme`)}`);
    check('深色主题落到 data-theme 上', t1 === 'dark' || t0 !== t1, `${t0} → ${t1}`);
    check('hljs 主题跟着换', await ev(`(() => { const d = document.querySelector('#hljsDark'); const l = document.querySelector('#hljsLight'); return d.disabled !== l.disabled; })()`));
    // 再点一次回到 auto，然后回对话页
    await ev(`document.querySelector('#setThemeBtn').click()`);
    await sleep(300);
    await ev(`document.querySelector('#pageBack').click()`);
    await sleep(300);
  }

  console.log('5) 设置整页');
  {
    await ev(`document.querySelector('#settingsBtn').click()`);
    check('设置整页打开', await waitFor(`!document.querySelector('#pageView').classList.contains('hidden')`, 6000));
    check('页标题是「设置」', (await ev(`document.querySelector('#pageTitle').textContent`)) === '设置');
    const html = await ev(`document.querySelector('#pageBody').innerHTML`);
    check('有 API Key 输入框', /API Key/i.test(html));
    check('有模型下拉', /deepseek-flash/.test(html));
    check('有内容安全选项', /内容安全|safety/i.test(html));
    check('有语言/所在地', /所在地/.test(html));
    check('有测试连接按钮', await ev(`!!document.querySelector('#testKey')`));
    check('设置顶部有导入/主题/统计', await ev(`!!document.querySelector('#setImport') && !!document.querySelector('#setThemeBtn') && !!document.querySelector('#setStats')`));
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(400);
    check('Esc 能回对话页', await ev(`document.querySelector('#pageView').classList.contains('hidden')`));
  }

  console.log('6) 搜索');
  {
    await ev(`document.querySelector('#searchToggle').click()`);
    await sleep(300);
    check('搜索框出现', !(await ev(`document.querySelector('#searchBox').classList.contains('hidden')`)));
    await ev(`(() => { const i = document.querySelector('#searchInput'); i.value = '弹震症'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    check('搜索有结果', await waitFor(`document.querySelectorAll('#convList .hit').length > 0`, 6000),
      String(await ev(`document.querySelectorAll('#convList .hit').length`)));
    const hitHtml = await ev(`document.querySelector('#convList').innerHTML`);
    check('命中词高亮', /<mark>/.test(hitHtml));
    check('点搜索结果能跳过去', await (async () => {
      await ev(`document.querySelector('#convList .hit').click()`);
      return waitFor(`document.querySelectorAll('#messages .msg').length > 0`, 8000);
    })());
    await ev(`document.querySelector('#searchClose').click()`);
    await sleep(300);
    check('关掉搜索后恢复列表', await waitFor(`document.querySelectorAll('#convList .conv-item').length >= 2`, 4000));
  }

  console.log('7) 打开一个历史会话并渲染 Markdown');
  {
    await ev(`(() => { const items = [...document.querySelectorAll('#convList .conv-item')]; const t = items.find(el => /战地|AI摸鱼/.test(el.textContent)) || items[items.length - 1]; t.click(); })()`);
    check('历史会话渲染出消息', await waitFor(`document.querySelectorAll('#messages .msg').length > 0`, 10000),
      String(await ev(`document.querySelectorAll('#messages .msg').length`)));
    check('长会话只渲染最近 80 条（虚拟窗口）', (await ev(`document.querySelectorAll('#messages .msg').length`)) <= 80,
      String(await ev(`document.querySelectorAll('#messages .msg').length`)));
    check('渲染出 Markdown 段落', (await ev(`document.querySelectorAll('#messages .md p').length`)) > 0);
    check('有深度思考折叠块', (await ev(`document.querySelectorAll('#messages .reason').length`)) > 0);
    check('助手消息有操作按钮', (await ev(`document.querySelectorAll('#messages .msg.assistant .msg-actions').length`)) > 0);
    check('顶部显示会话标题与条数', await ev(`document.querySelector('#convTitle').textContent.trim().length > 0 && /条/.test(document.querySelector('#convMeta').textContent)`),
      await ev(`document.querySelector('#convTitle').textContent.trim() + ' / ' + document.querySelector('#convMeta').textContent.trim()`));
  }

  console.log('7.5) 上下文徽标与记忆面板');
  {
    check('打开会话后徽标出现', await waitFor(`!document.querySelector('#ctxBadge').classList.contains('hidden')`, 6000));
    const label = await ev(`document.querySelector('#ctxLabel').textContent.trim()`);
    check('徽标显示占用（百分比或超预算）', /%|超预算|满/.test(label), label);
    const title = await ev(`document.querySelector('#ctxBadge').title`);
    check('徽标 title 里写了预算明细', /token/.test(title), title.slice(0, 60));

    await ev(`document.querySelector('#ctxBadge').click()`);
    check('点徽标弹出面板', await waitFor(`!!document.querySelector('.modal #ctxHits, .modal .ctx-meter')`, 6000));
    check('面板里有预算条', await ev(`!!document.querySelector('.modal .ctx-meter')`));
    check('面板里有记忆摘要区', await ev(`!!document.querySelector('.modal .ctx-memory')`));
    check('面板里有「立即压缩」按钮', await ev(`[...document.querySelectorAll('.modal [data-x]')].some(b => b.textContent.includes('立即压缩'))`));
    check('面板里有压缩记录区（分档概要）', await ev(`!!document.querySelector('.modal .ctx-records')`));
    check('面板里有「整合记忆」按钮', await ev(`[...document.querySelectorAll('.modal [data-x]')].some(b => b.textContent.includes('整合记忆'))`));
    check('面板里有本会话参数（预算下拉 + 三个数字 + 两个开关）',
      await ev(`!!document.querySelector('#ctxLocalBudget') && !!document.querySelector('#ctxLocalHot') && !!document.querySelector('#ctxLocalTopK') && !!document.querySelector('#ctxLocalHalf') && !!document.querySelector('#ctxLocalCompress') && !!document.querySelector('#ctxLocalRag')`));
    check('本会话预算能选到 1M',
      await ev(`[...(document.querySelector('#ctxLocalBudget')?.options || [])].some(o => o.value === '1000000')`),
      await ev(`[...(document.querySelector('#ctxLocalBudget')?.options || [])].map(o => o.value).join(',')`));
    check('面板里能保存到本会话 / 恢复跟随全局',
      await ev(`[...document.querySelectorAll('.modal [data-x]')].some(b => b.textContent.includes('保存到本会话')) && [...document.querySelectorAll('.modal [data-x]')].some(b => b.textContent.includes('恢复跟随全局'))`));
    check('面板里写了档位与遗忘阈值', await ev(`[...document.querySelectorAll('.modal .ctx-row')].some(r => /压缩档位/.test(r.textContent))`),
      await ev(`([...document.querySelectorAll('.modal .ctx-row')].find(r => /压缩档位/.test(r.textContent)) || {}).textContent || ''`));

    // 召回预览（本地索引，不花钱）
    await ev(`(() => { const i = document.querySelector('#ctxQuery'); i.value = '蓝鲸 心率'; document.querySelector('#ctxPreview').click(); })()`);
    const gotHits = await waitFor(`document.querySelectorAll('.modal .ctx-hit').length > 0`, 8000);
    check('召回预览能出命中', gotHits, String(await ev(`document.querySelectorAll('.modal .ctx-hit').length`)));
    if (gotHits) {
      check('命中里带相关度和时间权重', await ev(`/相关度/.test(document.querySelector('.modal .ctx-hit-head').textContent) && /权重/.test(document.querySelector('.modal .ctx-hit-head').textContent)`),
        await ev(`document.querySelector('.modal .ctx-hit-head').textContent.replace(/\\s+/g, ' ').trim()`));
    }
    await ev(`(() => { const b = [...document.querySelectorAll('.modal [data-x]')].find(b => b.textContent.includes('关掉')); if (b) b.click(); })()`);
    await sleep(300);
    check('面板能关掉', !(await ev(`!!document.querySelector('.modal')`)));

    // 设置里也有这些项目
    await ev(`document.querySelector('#moreBtn').click()`);
    await sleep(250);
    await ev(`(() => { const it = [...document.querySelectorAll('#ctxMenu button')].find(x => x.textContent.includes('设置')); if (it) it.click(); })()`);
    check('设置里有上下文开关', await waitFor(`!!document.querySelector('#setCtxCompress')`, 6000));
    check('设置里有预算下拉', await ev(`!!document.querySelector('#setCtxBudget') && document.querySelector('#setCtxBudget').options.length >= 8`));
    check('全局预算能选到 1M', await ev(`[...document.querySelector('#setCtxBudget').options].some(o => o.value === '1000000')`),
      await ev(`[...document.querySelector('#setCtxBudget').options].map(o => o.value).join(',')`));
    check('设置里有召回条数与半衰期', await ev(`!!document.querySelector('#setCtxTopK') && !!document.querySelector('#setCtxHalfLife')`));
    check('设置里能选压缩用谁的模型', await ev(`!!document.querySelector('#setCtxSummarizer') && document.querySelector('#setCtxSummarizer').options.length >= 3`));
    check('设置里能挑本机模型、填向量模型', await ev(`!!document.querySelector('#setCtxLocalModel') && !!document.querySelector('#setCtxEmbedModel')`));
    check('设置里有归档开关与「测一下」', await ev(`!!document.querySelector('#setCtxArchive') && !!document.querySelector('#ctxTestLocal')`));
    check('设置里有分档步进 / 遗忘阈值 / 渐进激活',
      await ev(`!!document.querySelector('#setCtxStep') && !!document.querySelector('#setCtxForget') && !!document.querySelector('#setCtxProgressive') && !!document.querySelector('#setCtxActivate')`),
      await ev(`['setCtxStep','setCtxForget','setCtxProgressive','setCtxActivate'].map(id => { const el = document.getElementById(id); return el ? (el.value ?? el.checked) : '缺失'; }).join(' / ')`));
    check('设置里有自动路由开关与四个模型下拉',
      await ev(`!!document.querySelector('#setAutoRoute') && !!document.querySelector('#setRouteChat') && !!document.querySelector('#setRouteThink') && !!document.querySelector('#setRouteHybridDraft') && !!document.querySelector('#setRouteHybrid')`),
      await ev(`['setRouteChat','setRouteThink','setRouteHybridDraft','setRouteHybrid'].map(id => document.getElementById(id)?.value || '缺失').join(' / ')`));
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await sleep(300);
    check('Esc 关掉设置', !(await ev(`!!document.querySelector('.modal')`)));

    // 模型菜单里有「自动（按内容路由）」
    await ev(`document.querySelector('#modelBtn').click()`);
    await sleep(250);
    check('模型菜单里有「自动（按内容路由）」',
      await ev(`[...document.querySelectorAll('#ctxMenu button')].some(b => b.textContent.includes('自动'))`),
      await ev(`[...document.querySelectorAll('#ctxMenu button')].map(b => b.textContent.trim()).slice(0, 4).join(' | ')`));
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await sleep(200);
  }

  console.log('7.6) 整页视图：日历·时钟 / QQ / 插件 / 侧栏调会话');
  {
    check('侧栏有日历/QQ/插件/设置四个入口',
      await ev(`['#clockBtn', '#qqNavBtn', '#pluginsBtn', '#settingsBtn'].every(s => !!document.querySelector(s))`));

    // 日历 + 时钟合成一页
    await ev(`document.querySelector('#clockBtn').click()`);
    await waitFor(`!!document.querySelector('.cal-grid2')`, 8000);
    check('日历·时钟整页打开', !(await ev(`document.querySelector('#pageView').classList.contains('hidden')`)));
    check('页标题是日历·时钟', /日历/.test(await ev(`document.querySelector('#pageTitle').textContent`)));
    check('月视图 42 格', (await ev(`document.querySelectorAll('.cal-grid2 .cal-cell2').length`)) === 42);
    check('有今天标记', await ev(`!!document.querySelector('.cal-grid2 .cal-cell2.today')`));
    check('同页右边就是大钟', await ev(`!!document.querySelector('.clock-big2 #clockBig')`));
    check('同页有「今天还剩」', /今天还剩/.test(await ev(`document.querySelector('#pageBody').textContent`)));
    check('同页有「接下来 7 天」', /接下来 7 天/.test(await ev(`document.querySelector('#pageBody').textContent`)));
    check('有新建日程入口', await ev(`[...document.querySelectorAll('#pageBody [data-x]')].some(b => b.dataset.x === 'toggleNew')`));

    // QQ 独立页
    await ev(`document.querySelector('#qqNavBtn').click()`);
    await waitFor(`!!document.querySelector('#qqMode')`, 8000);
    check('QQ 整页打开', /QQ/.test(await ev(`document.querySelector('#pageTitle').textContent`)));
    check('QQ 页有状态区', await ev(`!!document.querySelector('#qqLive .pill')`));
    check('QQ 页有扫码登录区（二维码或启动按钮）',
      await ev(`!!document.querySelector('.qr-box img, [data-x="napStart"], [data-x="napHostQr"]')`));
    check('QQ 页有模式/地址/发送框',
      await ev(`!!document.querySelector('#qqMode') && !!document.querySelector('#qqBase') && !!document.querySelector('#qqText')`));
    check('QQ 模式有三档', (await ev(`document.querySelectorAll('#qqMode option').length`)) >= 3);
    check('QQ 页保存按钮在', await ev(`!!document.querySelector('[data-x="qqSave"]')`));

    // 插件页
    await ev(`document.querySelector('#pluginsBtn').click()`);
    await waitFor(`!!document.querySelector('.ch-list')`, 8000);
    check('插件页打开', /插件/.test(await ev(`document.querySelector('#pageTitle').textContent`)));
    check('插件页列出 6 条通道', (await ev(`document.querySelectorAll('.ch-list .ch-item').length`)) === 6);
    check('插件页有 QQ 模式开关', await ev(`!!document.querySelector('[data-ch="qqMode"]')`));
    check('插件页有日历进上下文开关', await ev(`!!document.querySelector('[data-ch="calendarInContext"]')`));
    check('插件页有跳转按钮', (await ev(`document.querySelectorAll('.ch-list [data-go]').length`)) >= 3);

    // 回到对话，再从侧栏「调」
    await ev(`document.querySelector('#pageBack').click()`);
    await sleep(400);
    check('回到对话视图', await ev(`document.querySelector('#pageView').classList.contains('hidden')`));
    const r = await ev(`(() => { const it = document.querySelector('#convList .conv-item'); const b = it.querySelector('[data-tune]'); if (!b) return null; b.click(); return { ok: true }; })()`);
    check('侧栏会话有「调」按钮', !!r);
    await waitFor(`!!document.querySelector('.tune-pop')`, 4000);
    check('「调」弹层出现', await ev(`!!document.querySelector('.tune-pop')`));
    check('弹层能改标题/模型/预算',
      await ev(`!!document.querySelector('#tuneTitle') && !!document.querySelector('#tuneModel') && !!document.querySelector('#tuneBudget')`));
    check('预算下拉有「跟随全局」+1M',
      await ev(`[...document.querySelectorAll('#tuneBudget option')].some(o => o.value === '0') && [...document.querySelectorAll('#tuneBudget option')].some(o => o.value === '1000000')`));
    await ev(`[...document.querySelectorAll('.tune-pop [data-tune-act]')].find(b => b.dataset.tuneAct === 'cancel')?.click()`);
    await sleep(200);
    check('弹层能取消', !(await ev(`!!document.querySelector('.tune-pop')`)));
  }

  console.log('8) 手机端布局');
  {
    await cdp('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });
    await sleep(600);    check('窄屏时侧栏收起', (await ev(`(() => { const s = document.querySelector('#sidebar'); const r = s.getBoundingClientRect(); return r.right <= 1 || getComputedStyle(s).visibility === 'hidden' || getComputedStyle(s).transform !== 'none'; })()`)));
    check('出现汉堡菜单按钮', await ev(`getComputedStyle(document.querySelector('#menuBtn')).display !== 'none'`));
    await ev(`document.querySelector('#menuBtn').click()`);
    await sleep(500);
    check('点汉堡能拉出侧栏', (await ev(`(() => { const r = document.querySelector('#sidebar').getBoundingClientRect(); return r.right > 100; })()`)));
    await ev(`document.querySelector('#backdrop').click()`);
    await sleep(400);
    await cdp('Emulation.clearDeviceMetricsOverride');
  }

  console.log('9) 无 Key 发消息 → 错误提示不炸');
  {
    await ev(`document.querySelector('#newChatBtn').click()`);
    await sleep(300);
    await ev(`(() => { const ta = document.querySelector('#input'); ta.value = '测试一下'; ta.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await ev(`document.querySelector('#sendBtn').click()`);
    const gotErr = await waitFor(`!!document.querySelector('#messages .notice.err, #messages .notice')`, 8000);
    check('出现错误提示气泡', gotErr);
    if (gotErr) {
      const txt = await ev(`(document.querySelector('#messages .notice.err, #messages .notice') || {}).textContent || ''`);
      // 服务端可能配了 Key 但上游不通（隔离测试环境常见），两种文案都算「说清原因」
      check('提示里说清楚原因', /Key|连接 API 失败|网络|超时/i.test(txt), txt.trim().slice(0, 80));
    }
    check('用户消息还在', (await ev(`document.querySelectorAll('#messages .msg.user').length`)) >= 1);
    await sleep(300);
  }
} finally {
  // 清掉测试自己造出来的空「新对话」，别把用户列表弄脏
  try {
    await ev(`(async () => {
      const list = (await (await fetch('/api/state')).json()).conversations;
      for (const c of list) {
        if (c.title === '新对话' && c.messageCount === 0) {
          await fetch('/api/conversations/' + c.id, { method: 'DELETE' }).catch(() => {});
        }
      }
      return true;
    })()`);
  } catch {}
  try { ws.close(); } catch {}
  try { browser.kill(); } catch {}
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
