// 外链读取：本机兜底（HTTP → 内嵌内核）+ 聊天里预读注入
// 用法：node tools/link-test.mjs       （服务得先在 8787 上跑着）
import { liveGuard } from './_guard.mjs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { htmlToText, titleOf, extractUrls, httpRead, readUrl, hasBrowser } from '../fetchlink.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
await liveGuard(BASE, 'link-test');
const MOCK = 'http://127.0.0.1:8899';
const RECORD = path.join('data', 'mock-last.json');

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

// ---------------------------------------------------------------- 1. 纯函数
console.log('1) HTML 抽正文');
{
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>标题一 · 站点</title>
    <style>body{color:red}</style><script>var secret = '不该出现';</script></head>
    <body><nav>导航不该要</nav><article><h1>大标题</h1><p>第一段 &amp; 实体&nbsp;空格。</p>
    <ul><li>条目一</li><li>条目二</li></ul></article><aside>侧栏</aside><footer>版权</footer></body></html>`;
  const text = htmlToText(html);
  check('去掉 script/style 内容', !text.includes('不该出现') && !text.includes('color:red'));
  check('去掉导航/侧栏/页脚', !text.includes('导航不该要') && !text.includes('侧栏') && !text.includes('版权'));
  check('保留正文', text.includes('大标题') && text.includes('第一段 & 实体 空格。'));
  check('li 变成 · 列表', text.includes('· 条目一'));
  check('实体被还原', text.includes('&') && !text.includes('&amp;'));
  check('标题抽取', titleOf(html) === '标题一 · 站点');
  check('正文没有多余空行', !/\n{3,}/.test(text));
}

console.log('2) 链接抽取');
{
  const urls = extractUrls('看这个 https://a.example/x ，还有（https://b.example/y?a=1）。');
  check('抽到两条', urls.length === 2, urls.join(' '));
  check('去掉了尾部标点', urls[0] === 'https://a.example/x');
  check('带查询串也完整', urls[1].includes('?a=1'));
  check('最多 3 条', extractUrls('https://1.x https://2.x https://3.x https://4.x').length === 3);
  check('没有链接就是空数组', extractUrls('没有链接').length === 0);
}

// ---------------------------------------------------------------- 2. 本地 HTTP 页
function serve() {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>本地测试页</title></head>
    <body><article><p>这是本地测试页的正文，长度足够超过三百个字符的门槛，用来验证 HTTP 抓取那一级能正常抽出内容。</p>
    <p>${'补齐长度用的段落。'.repeat(30)}</p></article></body></html>`;
  const jsPage = `<!doctype html><html><head><meta charset="utf-8"><title>需要 JS 的页</title></head>
    <body><div id="app">加载中</div><script>document.getElementById('app').textContent = ${JSON.stringify('脚本渲染出来的正文'.repeat(40))};</script></body></html>`;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/js')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(jsPage); }
    if (req.url.startsWith('/sse')) { res.writeHead(500); return res.end('boom'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

console.log('3) HTTP 那一级');
const { server, port } = await serve();
const pageUrl = `http://127.0.0.1:${port}/page`;
{
  const r = await httpRead(pageUrl);
  check('抓到了', r.ok && r.tier === 'http', `${r.chars} 字 / ${r.ms}ms`);
  check('标题对', r.title === '本地测试页');
  check('正文里没有 HTML 标签', !/<[a-z/][^>]*>/i.test(r.text));
  check('坏地址不炸', (await httpRead(`http://127.0.0.1:${port}/sse`)).ok === false);
  check('连不上的地址不炸', (await httpRead('http://127.0.0.1:1/none')).ok === false);
}

console.log('4) 读不到时的兜底顺序');
{
  const r = await readUrl(pageUrl);
  check('静态页走 HTTP 就够了（不用上内核）', r.tier === 'http' && r.ok);
  check('记录了两级尝试', Array.isArray(r.tried) && r.tried[0].tier === 'http');
  const browserHere = await hasBrowser();
  console.log(`  · 当前进程有内嵌内核：${browserHere}`);
  const js = await readUrl(`http://127.0.0.1:${port}/js`);
  if (browserHere) {
    check('JS 渲染页用内嵌内核拿到正文', js.tier === 'browser' && js.text.includes('脚本渲染出来的正文'), `${js.chars} 字`);
  } else {
    check('没有内核时如实返回 HTTP 结果（不假装读到）', js.chars < 300, `${js.tier} / ${js.chars} 字 / ${js.error}`);
    check('写明内核不可用', js.browserUnavailable === true && /没有内嵌内核/.test(String(js.error)), String(js.error));
  }
}

// ---------------------------------------------------------------- 3. 接口
async function mathJson(p, opts) {
  const res = await fetch(BASE + p, opts);
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  return { res, data };
}
const put = (p, o) => mathJson(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const post = (p, o) => mathJson(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) });

console.log('5) POST /api/read-url');
{
  const r = await post('/api/read-url', { url: pageUrl });
  check('接口返回 200', r.res.status === 200);
  check('拿到正文', r.data.ok === true && r.data.tier === 'http' && r.data.chars > 300, `${r.data.chars} 字`);
  check('带 browser 能力位', typeof r.data.browser === 'boolean', String(r.data.browser));
  const bad = await post('/api/read-url', { url: 'ftp://x/y' });
  check('非 http(s) 被拒', bad.res.status === 400);
  const dead = await post('/api/read-url', { url: 'http://127.0.0.1:1/none' });
  check('读不到时 ok=false 且有原因', dead.data.ok === false && !!dead.data.error, dead.data.error);
}

// ---------------------------------------------------------------- 4. 聊天里预读注入
async function mockUp() {
  try {
    const r = await fetch(MOCK + '/models', { signal: AbortSignal.timeout(600) });
    if (r.ok) return null;
  } catch { /* 没起 */ }
  const child = spawn(process.execPath, ['tools/mock-upstream.mjs'], { stdio: 'ignore', detached: true });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 150));
    try {
      const r = await fetch(MOCK + '/models', { signal: AbortSignal.timeout(500) });
      if (r.ok) return child;
    } catch { /* 等 */ }
  }
  throw new Error('假上游没起来');
}

function parseSse(text) {
  const events = [];
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find(l => l.startsWith('data: '));
    if (!line) continue;
    const raw = line.slice(6);
    if (raw === '[DONE]') continue;
    try { events.push(JSON.parse(raw)); } catch { /* 忽略坏块 */ }
  }
  return events;
}

console.log('6) 聊天：本机预读进上下文');
const before = (await mathJson('/api/settings')).data;
let convId = '';
try {
  await mockUp();
  await put('/api/settings', { apiKey: 'sk-mock-link-key', baseUrl: MOCK, readLink: true, readLinkMode: 'auto', readLinkLocal: true });
  const created = await post('/api/conversations', { title: '链接测试', model: 'deepseek-flash' });
  convId = created.data.conversation?.id || created.data.id;
  check('建了测试会话', !!convId);

  const chat = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: convId, mode: 'send', content: `读一下这个页面并总结：${pageUrl}`, webSearch: false, thinking: false, autoTitle: false }),
  });
  const events = parseSse(await chat.text());
  const link = events.find(e => e.type === 'link');
  check('SSE 有 link 事件', !!link, link ? `${link.items?.length} 条 / ${link.ms}ms` : '没有');
  check('link 事件说走的是 HTTP', !!link && link.items?.[0]?.tier === 'http', link?.items?.[0]?.tier);
  check('link 事件带了字数与标题', !!link && link.items?.[0]?.chars > 300 && link.items?.[0]?.title === '本地测试页');

  const rec = JSON.parse(await readFile(RECORD, 'utf8'));
  const sys = (rec.body.messages || []).filter(m => m.role === 'system').map(m => String(m.content));
  const block = sys.find(s => s.includes('【本机预读的网页】'));
  check('上游收到了预读块', !!block);
  check('预读块里有正文', !!block && block.includes('这是本地测试页的正文'));
  check('预读块写了来源与级别', !!block && block.includes('HTTP 抓取') && block.includes(pageUrl));
  const lastUser = [...(rec.body.messages || [])].reverse().find(m => m.role === 'user');
  check('预读块在最后一条 user 之前', !!block && (rec.body.messages || []).indexOf(sys.find(s => s === block)) < (rec.body.messages || []).indexOf(lastUser));
  check('仍然声明了读链接工具（API 首选没被拿掉）', (rec.body.tools || []).some(t => String(t.type).includes('read_url')));
} catch (e) {
  check('聊天端到端没抛异常', false, e.message);
} finally {
  server.close();
  if (convId) await fetch(`${BASE}/api/conversations/${convId}`, { method: 'DELETE' }).catch(() => {});
  await put('/api/settings', {
    apiKey: before.apiKey || '',
    baseUrl: before.baseUrl || 'https://api.deepseek.com',
    readLink: before.readLink !== false,
    readLinkMode: before.readLinkMode || 'auto',
    readLinkLocal: before.readLinkLocal !== false,
  }).catch(() => {});
  await rm(RECORD, { force: true }).catch(() => {});
  const after = (await mathJson('/api/settings')).data;
  check('settings 已还原（没有留下 mock key）', !String(after.apiKey || '').includes('mock'), String(after.apiKey || '').slice(0, 8));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
