// 摘要模型自动拉取的小测试：模拟「没装模型 + 官方源拉不动 + 国内镜像可用」。
// 不碰真的 ollama，也不会下载真的模型（假镜像只吐几百字节）。
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PORT_OLLAMA = 18801;
const PORT_MIRROR = 18802;
const PORT_APP = 18803;
const DATA = path.join(ROOT, 'data', '_pulltest');
const TMP = path.join(ROOT, 'data', '_pulltest_tmp');
const BASE = `http://127.0.0.1:${PORT_APP}`;

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

rmSync(DATA, { recursive: true, force: true });
rmSync(TMP, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
mkdirSync(TMP, { recursive: true });

// 假 ollama：/api/tags 永远返回空列表（模拟没装摘要模型）
const ollama = createServer((req, res) => {
  if (req.url === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ models: [] }));
  }
  res.writeHead(404);
  res.end('');
});

// 假镜像：吐一小坨「GGUF」
const gguf = Buffer.alloc(4096, 7);
const mirror = createServer((req, res) => {
  if (req.url && req.url.endsWith('.gguf')) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': gguf.length });
    return res.end(gguf);
  }
  res.writeHead(404);
  res.end('');
});

// 假 ollama CLI：pull 一律失败，create 记一笔
const fakeCli = path.join(TMP, 'fake-ollama.mjs');
const createdLog = path.join(TMP, 'created.txt');
writeFileSync(fakeCli, `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const log = ${JSON.stringify(createdLog)};
if (args[0] === 'pull') {
  console.error('pull failed: registry blocked');
  process.exit(1);
}
if (args[0] === 'create') {
  appendFileSync(log, args[1] + '\\n');
  console.log('success');
  process.exit(0);
}
process.exit(1);
`, 'utf8');

const waitPort = async (url, tries = 80) => {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(800) });
      if (r.status < 500) return true;
    } catch { /* 还没起来 */ }
    await sleep(150);
  }
  return false;
};

const listen = (srv, port) => new Promise((ok, bad) => srv.listen(port, '127.0.0.1', ok).on('error', bad));

let app;
try {
  await listen(ollama, PORT_OLLAMA);
  await listen(mirror, PORT_MIRROR);

  app = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(PORT_APP),
      DSAPP_DATA: DATA,
      DSAPP_OLLAMA_CLI: fakeCli,
      DSAPP_PULL_MIRRORS: JSON.stringify([
        { id: 'fakemirror', label: '假镜像', url: `http://127.0.0.1:${PORT_MIRROR}/qwen.gguf` },
      ]),
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  app.on('error', () => {});

  const up = await waitPort(`${BASE}/api/state`);
  check('测试用服务起来了', up, BASE);
  if (!up) throw new Error('服务没起来');

  // 设置里指到假 ollama
  await fetch(`${BASE}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ctxLocalUrl: `http://127.0.0.1:${PORT_OLLAMA}`, ctxSummarizer: 'auto', ctxAutoPull: true }),
  });

  const idle = await (await fetch(`${BASE}/api/context/model-pull`)).json();
  check('初始没有在拉', idle.running === false, JSON.stringify({ running: idle.running, step: idle.step }));
  check('镜像列表里能看到注入的镜像', Array.isArray(idle.mirrors) && idle.mirrors.includes('假镜像'), (idle.mirrors || []).join('/'));

  // 手动触发一次
  const started = await (await fetch(`${BASE}/api/context/model-pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  check('POST 之后进入拉取状态', started.running === true || started.ok === true, JSON.stringify({ running: started.running, ok: started.ok }));

  // 等它完成
  let snap = started;
  for (let i = 0; i < 120; i += 1) {
    snap = await (await fetch(`${BASE}/api/context/model-pull`)).json();
    if (!snap.running) break;
    await sleep(250);
  }
  check('拉取结束', snap.running === false);
  check('结果成功', snap.ok === true, JSON.stringify({ ok: snap.ok, error: snap.error || '' }));
  check('来源是国内镜像（官方源失败后换的）', snap.source === '假镜像', String(snap.source));
  check('装好的模型名是 qwen2.5:1.5b-instruct', snap.model === 'qwen2.5:1.5b-instruct', String(snap.model));

  const ggufPath = path.join(DATA, 'models', 'qwen2.5-1.5b-instruct-q4_k_m.gguf');
  check('GGUF 落到 data/models/', existsSync(ggufPath) && statSync(ggufPath).size === gguf.length, existsSync(ggufPath) ? `${statSync(ggufPath).size}B` : '没这个文件');

  const modelfile = path.join(DATA, 'models', 'qwen2.5-1.5b-instruct.Modelfile');
  check('写了 Modelfile', existsSync(modelfile) && /FROM /.test(readFileSync(modelfile, 'utf8')));

  check('调用了 ollama create（官方 pull 失败了）', existsSync(createdLog) && readFileSync(createdLog, 'utf8').includes('qwen2.5:1.5b-instruct'), existsSync(createdLog) ? 'created.txt 有记录' : '没有 created.txt');

  const stepText = (snap.log || []).map(x => x.text).join(' | ');
  check('日志里记了「官方源没成 → 换国内镜像」', /官方源没成/.test(stepText) && /假镜像/.test(stepText));
  check('日志里记了 ollama create', /ollama create/.test(stepText));
} catch (e) {
  fail += 1;
  console.log('  ✗ 测试自身出错：' + e.message);
} finally {
  try { app && app.kill(); } catch { /* 进程可能已经退了 */ }
  ollama.close();
  mirror.close();
  await sleep(300);
  rmSync(DATA, { recursive: true, force: true });
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
