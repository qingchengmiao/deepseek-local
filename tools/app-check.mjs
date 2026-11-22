// 连上正在运行的 Electron 应用（需要带 --remote-debugging-port=9333 启动），
// 检查窗口里的页面真的活了：标题、会话列表、消息区、上下文徽标、主题。
import { writeFile, mkdir } from 'node:fs/promises';

const PORT = Number(process.env.APP_DEBUG_PORT || 9333);
const OUT = 'data/shots/15-应用窗口-会话.png';

async function listTargets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(4000) });
  return r.json();
}

const targets = await listTargets();
const page = targets.find(t => t.type === 'page' && /127\.0\.0\.1|localhost/.test(t.url));
if (!page) {
  console.error('没找到应用页面。现有目标：', targets.map(t => `${t.type} ${t.url}`).join(' | '));
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', () => rej(new Error('连不上调试端口')), { once: true });
});

function cdp(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate 失败');
  return r.result.value;
}

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const title = await evaluate('document.title');
// 应用窗口停在设置/插件页时标题是「设置 · DeepSeek Local」，同样算过
check('页面标题是 DeepSeek Local', /DeepSeek Local$/.test(String(title || '').trim()), title);

const ready = await evaluate(`typeof S === 'object' && !!S.settings && Array.isArray(S.conversations)`);
check('前端状态 S 已就绪', ready === true);

const convCount = await evaluate('S.conversations.length');
check('会话列表有数据', convCount >= 2, `${convCount} 个`);

const modelLabel = await evaluate(`document.querySelector('#modelLabel')?.textContent?.trim() || ''`);
check('模型标签有内容', /Flash|Pro|自动/.test(modelLabel), modelLabel);

const hasComposer = await evaluate(`['attachChip','webChip','thinkChip','micChip','sendBtn'].every(id => !!document.getElementById(id))`);
check('输入区五个控件都在', hasComposer === true);

const navWorks = await evaluate(`(() => {
  const it = document.querySelector('#convList .conv-item');
  if (!it) return false;
  it.click();
  return true;
})()`);
await new Promise(r => setTimeout(r, 1200));
const msgCount = await evaluate(`document.querySelectorAll('#messages .msg').length`);
check('点开会话能渲染消息', navWorks === true && msgCount > 0, `${msgCount} 条`);

const ctxBadge = await evaluate(`(() => { const b = document.getElementById('ctxBadge'); return b ? !b.classList.contains('hidden') : false; })()`);
check('上下文徽标出现', ctxBadge === true);

const theme = await evaluate(`document.documentElement.dataset.theme || ''`);
check('主题已应用', theme === 'light' || theme === 'dark', theme);

const noConsoleError = await evaluate(`!!window.MD && !!window.hljs && !!window.katex`);
check('KaTeX / highlight.js / md.js 都在', noConsoleError === true);

// 内嵌 Chromium 那一级：本地起一个只靠脚本渲染的页面，让服务用内核打开它
const { createServer } = await import('node:http');
const jsPage = `<!doctype html><html><head><meta charset="utf-8"><title>内核渲染测试</title></head><body>
<div id="app">加载中</div><script>document.getElementById('app').textContent = ${JSON.stringify('脚本渲染出来的正文。'.repeat(40))};</script></body></html>`;
const local = await new Promise(resolve => {
  const s = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(jsPage); });
  s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
});
try {
  const linkRead = await evaluate(`fetch('/api/read-url', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'http://127.0.0.1:${local.port}/js' })
  }).then(r => r.json())`);
  check('应用里有内嵌内核', linkRead?.browser === true, String(linkRead?.browser));
  check('JS 渲染页用内核读到正文', linkRead?.tier === 'browser' && linkRead?.chars > 200, `${linkRead?.tier} / ${linkRead?.chars} 字`);
  check('内核读到的正文是脚本渲染的内容', String(linkRead?.text || '').includes('脚本渲染出来的正文'));
} finally {
  local.server.close();
}

await mkdir('data/shots', { recursive: true });
const shot = await cdp('Page.captureScreenshot', { format: 'png' });
await writeFile(OUT, Buffer.from(shot.data, 'base64'));
console.log(`\n截图：${OUT}`);

const bad = checks.filter(c => !c.ok).length;
console.log(`结果：${checks.length - bad} 通过 / ${bad} 失败`);
ws.close();
process.exit(bad ? 1 : 0);
