// 回复风格：验「活人感」提示真的进了 system 那一层，而不是只存了个设置。
// 手法：起假上游（记最后一个请求体）→ 起隔离实例指过去 → 发一句话 → 回头看上游收到什么。
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const APP = path.resolve('.');
const MOCK_PORT = Number(process.env.MOCK_PORT || 18871);
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const PORT = Number(process.env.TEST_PORT || 18872);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.resolve('data/_style_test');
const RECORD = path.join(DATA, 'mock-last.json');

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const json = async (p, opt = {}) => {
  const r = await fetch(BASE + p, { headers: { 'Content-Type': 'application/json' }, ...opt });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const put = (p, obj) => json(p, { method: 'PUT', body: JSON.stringify(obj) });

await rm(DATA, { recursive: true, force: true });
await mkdir(DATA, { recursive: true });
await mkdir(path.join(DATA, 'uploads'), { recursive: true });

const mock = spawn(process.execPath, ['tools/mock-upstream.mjs'], {
  cwd: APP,
  env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_RECORD: RECORD },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
mock.stderr.on('data', d => console.log('[mock err]', String(d).trim()));
mock.on('exit', c => console.log('[mock exit]', c));
const srv = spawn(process.execPath, ['server.mjs'], {
  cwd: APP,
  env: { ...process.env, PORT: String(PORT), DSAPP_DATA: DATA },
  stdio: 'ignore',
});

const up = async (url, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    await sleep(200);
    try { if ((await fetch(url)).ok) return true; } catch {}
  }
  return false;
};

const lastSystem = async () => {
  const raw = JSON.parse(await readFile(RECORD, 'utf8'));
  const sys = (raw.body?.messages || []).find(m => m.role === 'system');
  return { sys: String(sys?.content || ''), all: raw.body?.messages || [] };
};

const send = async (text) => {
  await rm(RECORD, { force: true });
  // /api/chat 要 conversationId + content，和 integration.mjs 一个形状
  const conv = await json('/api/conversations', { method: 'POST', body: JSON.stringify({ title: '风格试验' }) });
  const convId = conv.data?.id || conv.data?.conversation?.id || '';
  const r = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: convId, mode: 'send', content: text }),
  });
  const body = await r.text().catch(() => '');
  if (!r.ok) console.log('[chat status]', r.status, body.slice(0, 160));
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    try { await readFile(RECORD, 'utf8'); return; } catch {}
  }
};

try {
  check('假上游起来了', await up(`${MOCK}/models`));
  check('实例起来了', await up(`${BASE}/api/state`));

  // 默认应该是活人感
  let st = await json('/api/state');
  check('默认风格是活人感', st.data.settings?.replyStyle === 'human', String(st.data.settings?.replyStyle));

  const okSet = await put('/api/settings', {
    apiKey: 'sk-mock-style-key',
    baseUrl: MOCK,
    model: 'deepseek-flash',
    thinking: false,
    webSearch: false,
    readLink: false,
    autoTitle: false,
    replyStyle: 'human',
  });
  check('设置写进去了', okSet.data?.replyStyle === 'human', String(okSet.data?.replyStyle));

  try { await send('这个方案行不行'); } catch (e) { console.log('[send err]', e.message); }
  let got = await lastSystem().catch(e => { console.log('[record err]', e.message); return { sys: '', all: [] }; });
  check('活人感：上游收到 system', got.sys.length > 0, `${got.sys.length} 字`);
  check('活人感：含「第一句就给答案」', got.sys.includes('第一句就给答案'));
  check('活人感：含「别重述问题」', got.sys.includes('别重述问题'));
  check('活人感：含「要清单照给」这条兜底', got.sys.includes('照给'));
  const sysAll = got.all.filter(m => m.role === 'system');
  const styleHits = sysAll.filter(m => String(m.content).includes('第一句就给答案')).length;
  check('风格提示只注入一次', styleHits === 1, `命中 ${styleHits} 次`);
  check('system 不超过 2 条（原生本来就有 1 条基本提示）', sysAll.length <= 2, `${sysAll.length} 条`);

  // 原生：不该注入
  await put('/api/settings', { replyStyle: 'native' });
  await send('这个方案行不行');
  got = await lastSystem();
  check('原生：没有风格提示', !got.sys.includes('第一句就给答案'), `${got.sys.length} 字`);

  // 自定义：只用自己的
  await put('/api/settings', { replyStyle: 'custom', systemPrompt: '你是一个只回一句话的助手。' });
  await send('这个方案行不行');
  got = await lastSystem();
  check('自定义：用自己的提示词', got.sys.includes('只回一句话'));
  check('自定义：不带风格提示', !got.sys.includes('第一句就给答案'));

  // 活人感 + 自己的：两段都在
  await put('/api/settings', { replyStyle: 'human' });
  await send('这个方案行不行');
  got = await lastSystem();
  check('活人感+自定义：两段都在', got.sys.includes('第一句就给答案') && got.sys.includes('只回一句话'), `${got.sys.length} 字`);

  // 非法值回落到活人感
  const bad = await put('/api/settings', { replyStyle: 'nonsense' });
  check('非法风格值回落成活人感', bad.data?.replyStyle === 'human', String(bad.data?.replyStyle));
} finally {
  try { srv.kill(); } catch {}
  try { process.kill(-mock.pid); } catch { try { mock.kill(); } catch {} }
  await sleep(400);
  await rm(DATA, { recursive: true, force: true }).catch(() => {});
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
