// 验证：需要服务端工具（联网/读链接）或自动标题时，模型必须是 deepseek-flash
// 上游明确禁止 deepseek-v4-pro 带 tools / title（400 server-side tool calls ... unavailable）
// 用法：node tools/model-fallback-test.mjs [端口=8931]
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] || 8931);
const MOCK_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
// 本文件在 <项目>/tools/ 下，项目根是它的上一级
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const dataDir = await mkdtemp(path.join(tmpdir(), 'dsapp-fallback-'));
const record = path.join(dataDir, 'mock-last.json');

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, ms = 8000, step = 120) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}

// ---- 尽量隔离：只带走必要的环境，避免继承外部 KEY/端口
const env = { ...process.env, PORT: String(PORT), MOCK_PORT: String(MOCK_PORT), MOCK_RECORD: record, DSAPP_DATA: dataDir };
delete env.DEEPSEEK_API_KEY;

const mock = spawn(process.execPath, [path.join(root, 'tools', 'mock-upstream.mjs')], { cwd: root, env, stdio: 'ignore' });
const srv = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, env, stdio: 'ignore' });

const cleanup = async () => {
  for (const p of [srv, mock]) { try { p.kill(); } catch {} }
  await sleep(300);
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
};
process.on('exit', () => { try { srv.kill(); mock.kill(); } catch {} });

try {
  const up = await waitFor(async () => {
    try { const r = await fetch(`${BASE}/api/state`); return r.ok; } catch { return false; }
  }, 15000);
  if (!up) throw new Error('服务没起来');

  // 指向假上游；打开需要服务端工具和自动标题的那套设置
  await fetch(`${BASE}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: 'sk-mock',
      baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
      model: 'deepseek-v4-pro',   // 故意选 Pro
      webSearch: true,           // 需要 deepseek_web_search 工具
      readLink: true,
      autoTitle: true,           // 需要 title 生成
      autoRoute: false,
      hybridMode: false,
      mediaTwoStage: false,
      adaptiveTurn: false,
      safetyLevel: 'off',
    }),
  });

  // 监听 SSE：取 context 事件里的 warnings 和一次完整对话
  const conv = await (await fetch(`${BASE}/api/conversations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '' }),
  })).json();
  const convId = conv.conversation?.id || conv.id;
  check('新建会话', !!convId);

  const resp = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: convId, mode: 'send', content: '查一下今天的新闻并注明来源' }),
  });
  check('聊天接口返回 200', resp.status === 200, `status=${resp.status}`);

  const raw = await resp.text();
  const events = raw.split('\n').filter(l => l.startsWith('data:')).map(l => {
    try { return JSON.parse(l.slice(5).trim()); } catch { return null; }
  }).filter(Boolean);
  const err = events.find(e => e.type === 'error');
  check('没有报错事件', !err, err ? String(err.message).slice(0, 120) : '');
  const start = events.find(e => e.type === 'start');
  check('start 事件里的模型是 flash', start?.model === 'deepseek-flash', `model=${start?.model}`);
  const ctxEv = events.find(e => e.type === 'context');
  const warned = (ctxEv?.warnings || []).find(w => /自动切到/.test(String(w)));
  check('context 事件带「已自动切到 Flash」的说明', !!warned, warned || '');
  check('done 事件在', !!events.find(e => e.type === 'done'));

  // 上游实际收到的请求体才是铁证
  const rec = await waitFor(async () => {
    try { return JSON.parse(await readFile(record, 'utf8')); } catch { return null; }
  });
  check('假上游收到了请求', !!rec);
  check('上游收到的 model 是 deepseek-flash', rec?.body?.model === 'deepseek-flash', `model=${rec?.body?.model}`);
  check('上游收到的 tools 非空（联网确实开了）', Array.isArray(rec?.body?.tools) && rec.body.tools.length > 0, `tools=${JSON.stringify(rec?.body?.tools || [])}`);
  check('上游收到 title 开关', rec?.body?.title?.enabled === true, JSON.stringify(rec?.body?.title || null));

  // 反向 1：只开着自动标题（不联网）时，不该为了「上游起标题」把 Pro 换掉
  await fetch(`${BASE}/api/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webSearch: false, readLink: false, autoTitle: true }),
  });
  const convB = await (await fetch(`${BASE}/api/conversations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '' }),
  })).json();
  const convBId = convB.conversation?.id || convB.id;
  const rB = await fetch(`${BASE}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: convBId, mode: 'send', content: '写两句对仗工整的话' }),
  });
  const rawB = await rB.text();
  const evB = rawB.split('\n').filter(l => l.startsWith('data:')).map(l => {
    try { return JSON.parse(l.slice(5).trim()); } catch { return null; }
  }).filter(Boolean);
  const recB = JSON.parse(await readFile(record, 'utf8'));
  check('只开自动标题时仍按 Pro 发（不为标题换模型）', recB?.body?.model === 'deepseek-v4-pro', `model=${recB?.body?.model}`);
  check('只开自动标题时不再给上游发 title', !recB?.body?.title, JSON.stringify(recB?.body?.title || null));
  const warnB = (evB.find(e => e.type === 'context')?.warnings || []).find(w => /起标题/.test(String(w)));
  check('context 里说明了「标题先用本地摘要」', !!warnB, warnB || '');

  // 反向 2：关掉联网和自动标题后，Pro 应该原样发出去（不受影响）
  await fetch(`${BASE}/api/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webSearch: false, autoTitle: false }),
  });
  const conv2 = await (await fetch(`${BASE}/api/conversations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '' }),
  })).json();
  const conv2Id = conv2.conversation?.id || conv2.id;
  const r2 = await fetch(`${BASE}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: conv2Id, mode: 'send', content: '随便聊两句' }),
  });
  await r2.text();
  const rec2 = JSON.parse(await readFile(record, 'utf8'));
  check('关掉全家桶后仍按 Pro 发（不被误降级）', rec2?.body?.model === 'deepseek-v4-pro', `model=${rec2?.body?.model}`);
  check('关掉后不再带 tools', !rec2?.body?.tools);
} catch (e) {
  fail += 1;
  console.log('  ✗ 异常：' + (e?.message || e));
} finally {
  await cleanup();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
