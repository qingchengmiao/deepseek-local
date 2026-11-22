// 造一个「自动路由」演示会话并截图：综合模式两次调用，消息上带路由标记
// 用法：node tools/demo-route.mjs            造完截图，打印会话 id
//       node tools/demo-route.mjs --clean <id>  删掉演示会话
import { liveGuard } from './_guard.mjs';
import { spawn } from 'node:child_process';
import { rm, mkdir } from 'node:fs/promises';
import { launch, sleep } from './cdp.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
await liveGuard(BASE, 'demo-route');
const MOCK = 'http://127.0.0.1:8899';
const SHOT = 'data/shots/19-自动路由.png';
const TITLE = '自动路由演示：周报';

async function j(path, opts) {
  const r = await fetch(BASE + path, opts);
  const t = r.headers.get('content-type') || '';
  return { r, data: t.includes('json') ? await r.json() : await r.text() };
}
const put = (p, o) => j(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const post = (p, o) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) });

async function mockUp() {
  try { const r = await fetch(MOCK + '/models', { signal: AbortSignal.timeout(600) }); if (r.ok) return; } catch {}
  const child = spawn(process.execPath, ['tools/mock-upstream.mjs'], { stdio: 'ignore', detached: true });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    try { const r = await fetch(MOCK + '/models', { signal: AbortSignal.timeout(500) }); if (r.ok) return; } catch {}
  }
  throw new Error('假上游没起来');
}

const args = process.argv.slice(2);
if (args[0] === '--clean') {
  const id = args[1];
  if (id) await j('/api/conversations/' + id, { method: 'DELETE' });
  console.log('已删演示会话', id || '');
  process.exit(0);
}

const orig = (await j('/api/settings')).data;
if (orig.hasKey) {
  console.error('本机存着真 Key，先清掉再跑这个脚本，别把它覆盖了');
  process.exit(1);
}
await mockUp();
let convId = '';
try {
  await put('/api/settings', {
    apiKey: 'sk-mock-route-demo', baseUrl: MOCK, model: 'auto', autoRoute: true, thinking: false,
    autoTitle: false, readLink: false, ctxCompress: false, ctxRag: false,
    routeChatModel: 'deepseek-v4-pro', routeThinkModel: 'deepseek-flash',
    routeHybridDraftModel: 'deepseek-flash', routeHybridModel: 'deepseek-v4-pro',
  });
  const c = await post('/api/conversations', { title: TITLE, model: 'auto' });
  convId = c.data.conversation.id;

  // 一轮普通对话 + 一轮逻辑思考 + 一轮综合（综合会有两次上游调用）
  const send = async content => {
    const res = await fetch(BASE + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: convId, mode: 'send', content, thinking: false, autoTitle: false }),
    });
    return res.text();
  };
  await send('先随便聊聊：这周数据库迁移的事你记得多少？');
  await send('这段 SQL 为什么没走索引？帮我排查一下。');
  await send('写一份给团队的周报：总结这周的数据库迁移，说明遇到的问题，再给出下周计划。');
  // 假上游会推自动标题事件，把标题改回来
  await j('/api/conversations/' + convId, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: TITLE }),
  });
} finally {
  await put('/api/settings', {
    apiKey: '', baseUrl: orig.baseUrl, model: 'auto', autoRoute: orig.autoRoute !== false,
    routeChatModel: orig.routeChatModel || 'deepseek-v4-pro', routeThinkModel: orig.routeThinkModel || 'deepseek-flash',
    routeHybridDraftModel: orig.routeHybridDraftModel || 'deepseek-flash', routeHybridModel: orig.routeHybridModel || 'deepseek-v4-pro',
    thinking: orig.thinking, readLink: orig.readLink, ctxCompress: orig.ctxCompress, ctxRag: orig.ctxRag,
    readLinkMode: orig.readLinkMode, readLinkLocal: orig.readLinkLocal,
    autoTitle: orig.autoTitle !== false, safetyLevel: orig.safetyLevel || 'off', temperature: orig.temperature ?? 1,
  });
}

console.log('演示会话：', convId);

// 截图（自动滚动到带 route-tag 的最后一条回答）
const b = await launch({ port: 9336, width: 1440, height: 1000 });
try {
  await b.goto(BASE + '/');
  await b.waitFor(`document.querySelectorAll('#convList .conv-item').length > 0`, 20000);
  await b.ev(`(() => { const it = [...document.querySelectorAll('#convList .conv-item')].find(x => x.dataset.id === ${JSON.stringify(convId)}); if (it) it.click(); })()`);
  await b.waitFor(`document.querySelectorAll('#messages .route-tag').length > 0`, 20000);
  await sleep(800);
  await b.ev(`(() => { const tags = document.querySelectorAll('#messages .route-tag'); const last = tags[tags.length - 1]; if (last) last.closest('.msg').scrollIntoView({ block: 'center' }); })()`);
  await sleep(900);
  const info = await b.ev(`(() => ({
    tags: [...document.querySelectorAll('#messages .route-tag')].map(t => t.textContent.trim()),
    msgs: document.querySelectorAll('#messages .msg').length,
  }))()`);
  console.log('路由标记：', JSON.stringify(info.tags));
  await mkdir('data/shots', { recursive: true });
  const shot = await b.cdp('Page.captureScreenshot', { format: 'png' });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(SHOT, Buffer.from(shot.data, 'base64'));
  console.log('截图：', SHOT);
} finally {
  await b.close();
}
