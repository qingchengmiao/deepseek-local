// 验「Shell 副本（没有 .bat 启动器）走 C++ 宿主」这条路：
//   1) 目录里只有 NapCatWinBootMain.exe 时，/api/napcat/start 不再报「没找到启动器」，而是转给宿主
//   2) 实例活着（已登录 / OneBot 端口通）时，/api/napcat/restart 不硬杀，直接说没动它
//   3) 实例确实挂掉时，/api/napcat/restart 才 stop + start
// 宿主用假的 .mjs 冒充（runCli 会用 node 跑 .mjs），日志写文件看它到底被调了哪些动词。
//   node tools/napcat-hostpath-test.mjs
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 18931);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(ROOT, 'data', '_hostpath_test');
const FAKE_SHELL = path.join(DATA, 'ShellCopy');   // 只有 boot main，没有 bat
const FAKE_LOG = path.join(DATA, 'host-calls.log');
const FAKE_HOST = path.join(DATA, 'fake-host.mjs');
const FAKE_QR = path.join(DATA, 'qrcode.png');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

// 一份 1x1 的 PNG，够当二维码用
const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const FAKE_SRC = `
import { appendFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
const verb = args[0] || 'status';
const get = (k, d = '') => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
appendFileSync(${JSON.stringify(FAKE_LOG)}, verb + '\\n');
const state = process.env.FAKE_STATE || 'broken';
const qr = ${JSON.stringify(FAKE_QR)};
if (verb === 'status') {
  const alive = state === 'alive' || state === 'portup';
  const out = { ok: true, phase: alive ? 'online' : 'waiting-login', running: true, processCount: 5,
    httpUp: state === 'alive' || state === 'portup', loggedIn: state === 'alive',
    shell: get('shell'), login: get('login'), qrExists: false, pids: [111] };
  console.log(JSON.stringify(out));
} else if (verb === 'stop') {
  console.log(JSON.stringify({ ok: true, killed: [111, 222], processCount: 0 }));
} else if (verb === 'start') {
  console.log(JSON.stringify({ ok: true, running: true, processCount: 2, pids: [111] }));
} else {
  console.log(JSON.stringify({ ok: true, qrExists: true, qrPath: qr, qrMtime: Math.floor(Date.now() / 1000) }));
}
`;

// 起服务（独立数据目录 + 独立端口），宿主指到假 exe，state 用来切「活/挂」
async function startServer(state) {
  process.env.DSAPP_DATA = DATA;
  process.env.PORT = String(PORT);
  process.env.FAKE_STATE = state;
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT, env: { ...process.env, DSAPP_DATA: DATA, PORT: String(PORT), FAKE_STATE: state },
    stdio: 'ignore', windowsHide: true,
  });
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 250));
    try { const r = await fetch(BASE + '/api/state'); if (r.ok) return child; } catch { /* 还没起来 */ }
  }
  throw new Error('实例没起来');
}

const put = (obj) => fetch(BASE + '/api/settings', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj),
}).then(r => r.json());

const post = async (p) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const calls = async () => {
  try { return (await readFile(FAKE_LOG, 'utf8')).split('\n').filter(Boolean); } catch { return []; }
};

async function main() {
  await rm(DATA, { recursive: true, force: true });
  await mkdir(FAKE_SHELL, { recursive: true });
  await writeFile(path.join(FAKE_SHELL, 'NapCatWinBootMain.exe'), 'fake'); // 有 boot main，没有 .bat
  await writeFile(path.join(FAKE_SHELL, 'napcat.mjs'), 'export {};');
  await writeFile(FAKE_HOST, FAKE_SRC, 'utf8');
  await writeFile(FAKE_QR, PNG1);

  let child = await startServer('broken');
  try {
    await put({
      autoImport: false, apiKey: '', pushEnabled: false,
      napcatShell: FAKE_SHELL, qqNapCatDir: FAKE_SHELL, napcatHost: FAKE_HOST,
      napcatLogin: path.join(DATA, 'login'),
    });

    // ---- 1) 只有 boot main 的目录：start 不该报「没找到启动器」
    let r = await post('/api/napcat/start');
    ok('start 走宿主成功', r.status === 200 && r.body && r.body.ok === true, JSON.stringify(r.body).slice(0, 120));
    ok('start 说是经宿主拉起的', !!(r.body && r.body.via === 'host'), String(r.body && r.body.launcher));
    ok('start 没再报「没找到启动器」', !(r.body && /没在.*找到启动器/.test(String(r.body.error || ''))));
    ok('宿主真被调了 start', (await calls()).includes('start'));

    // ---- 2) 实例活着（已登录）：restart 不许硬杀
    await writeFile(FAKE_LOG, '');
    child.kill();
    child = await startServer('alive');
    r = await post('/api/napcat/restart');
    ok('活着时 restart 返回 ok', r.status === 200 && r.body && r.body.ok === true);
    ok('活着时 restart 跳过', !!(r.body && r.body.skipped), String((r.body && r.body.skipped) || '').slice(0, 40));
    const cs1 = await calls();
    ok('活着时没有调 stop', !cs1.includes('stop'), 'calls=' + JSON.stringify(cs1));
    ok('活着时没等出码', r.body && Number(r.body.waitedMs) === 0, String(r.body && r.body.waitedMs));

    // ---- 3) 只是端口通（还没登录完）也不许杀
    await writeFile(FAKE_LOG, '');
    child.kill();
    child = await startServer('portup');
    r = await post('/api/napcat/restart');
    ok('端口通时也跳过', !!(r.body && r.body.skipped), String((r.body && r.body.skipped) || '').slice(0, 40));
    ok('端口通时没有调 stop', !(await calls()).includes('stop'));

    // ---- 4) 确实挂了：才 stop + start
    await writeFile(FAKE_LOG, '');
    child.kill();
    child = await startServer('broken');
    r = await post('/api/napcat/restart');
    ok('挂掉时 restart 真的重启', r.status === 200 && r.body && r.body.ok === true && r.body.rebuilt !== undefined);
    const cs2 = await calls();
    ok('挂掉时先 stop', cs2.includes('stop'), 'calls=' + JSON.stringify(cs2));
    ok('挂掉时再 start', cs2.includes('start'));
    ok('挂掉时报告杀掉的进程数', !!(r.body && Array.isArray(r.body.killed) && r.body.killed.length === 2), JSON.stringify(r.body && r.body.killed));
  } finally {
    try { child.kill(); } catch { /* 已退出 */ }
    await new Promise(r => setTimeout(r, 400));
    await rm(DATA, { recursive: true, force: true }).catch(() => {});
  }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('跑挂了：', e && e.message); process.exit(1); });
