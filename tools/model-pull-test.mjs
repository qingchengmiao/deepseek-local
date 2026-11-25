// 摘要模型自动拉取的小测试：模拟「data/models 里没有 gguf + 镜像可用」。
// 2026-11-25 起拉模型只下 GGUF 到 data/models（进程内直接跑），不再调 ollama pull / ollama create，
// 所以这个测试里没有假 ollama server、也没有假 ollama CLI，只有一个假镜像吐几百字节。
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PORT_MIRROR = 18802;
const PORT_APP = 18803;
const DATA = path.join(ROOT, 'data', '_pulltest');
const BASE = `http://127.0.0.1:${PORT_APP}`;

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

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

const TARGET = 'qwen2.5-1.5b-instruct-q4_k_m.gguf';
let app;
try {
  await listen(mirror, PORT_MIRROR);

  app = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(PORT_APP),
      DSAPP_DATA: DATA,
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

  // 设置里打开自动拉（不再有 ctxLocalUrl 这种端口地址了）
  await fetch(`${BASE}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ctxSummarizer: 'auto', ctxAutoPull: true }),
  });

  const idle = await (await fetch(`${BASE}/api/context/model-pull`)).json();
  check('初始没有在拉', idle.running === false, JSON.stringify({ running: idle.running, step: idle.step }));
  check('镜像列表里能看到注入的镜像', Array.isArray(idle.mirrors) && idle.mirrors.includes('假镜像'), (idle.mirrors || []).join('/'));

  // 手动触发一次
  const started = await (await fetch(`${BASE}/api/context/model-pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  check('POST 之后进入拉取状态', started.running === true || started.ok === true, JSON.stringify({ running: started.running, ok: started.ok }));

  // 等它完成
  let snap = started;
  for (let i = 0; i < 160; i += 1) {
    snap = await (await fetch(`${BASE}/api/context/model-pull`)).json();
    if (!snap.running) break;
    await sleep(250);
  }
  check('拉取结束', snap.running === false);
  check('结果成功', snap.ok === true, JSON.stringify({ ok: snap.ok, error: snap.error || '' }));
  check('来源是注入的镜像', snap.source === '假镜像', String(snap.source));
  check('模型名就是落地的 gguf 文件名', snap.model === TARGET, String(snap.model));

  const ggufPath = path.join(DATA, 'models', TARGET);
  check('GGUF 落到 data/models/', existsSync(ggufPath) && statSync(ggufPath).size === gguf.length, existsSync(ggufPath) ? `${statSync(ggufPath).size}B` : '没这个文件');

  const modelfile = path.join(DATA, 'models', 'qwen2.5-1.5b-instruct.Modelfile');
  check('没再写 Modelfile（不碰 ollama）', !existsSync(modelfile));

  const stepText = (snap.log || []).map(x => x.text).join(' | ');
  check('日志里记了从镜像下载', /从假镜像下载/.test(stepText), stepText.slice(0, 80));
  check('日志里记了下好了', /下好了/.test(stepText));

  // 落地后本机推理就该认得它（这是「取缔 ollama」的关键：一个文件就能用）
  const lm = await (await fetch(`${BASE}/api/local-models`)).json();
  check('/api/local-models 认得这个模型', lm.alive === true && (lm.models || []).some(m => m.name === TARGET), `${(lm.models || []).map(m => m.name).join(',')}`);
  check('报告了推理后端', typeof lm.backend === 'string' && lm.backend.length > 0, String(lm.backend));
} catch (e) {
  fail += 1;
  console.log('  ✗ 测试自身出错：' + e.message);
} finally {
  try { app && app.kill(); } catch { /* 进程可能已经退了 */ }
  mirror.close();
  await sleep(300);
  rmSync(DATA, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
