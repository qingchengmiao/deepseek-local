// 拖入压缩包 → 整理成对话：真实浏览器里的 DOM 验收
// 用法：node tools/dom-drop.mjs [port]
// 自己起一个隔离服务（临时数据目录），再开无头 Edge 去拖
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.argv[2] || 8913);
const CDP_PORT = 9336;
const BASE = `http://127.0.0.1:${PORT}`;

const EDGE = process.env.EDGE_PATH || (process.platform === 'win32'
  ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  : 'msedge');

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- 最小 zip 写入器（store，够构造测试包） ---------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(raw);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);           // store
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, raw);
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(raw.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);
    offset += local.length + raw.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

// 一个「两份说明 + 一份清单」的小资料包，拖进去应该整理成 2 个对话
const zipBuf = makeZip([
  { name: '笔记/需求.md', data: '# 需求\n\n登录页要能记住上次的账号。\n' },
  { name: '笔记/实现.txt', data: '本地存 settings.json，不写注册表。\n' },
  { name: '数据/清单.md', data: '- 甲\n- 乙\n- 丙\n' },
]);
const zipB64 = zipBuf.toString('base64');

/* ---------------- 起隔离服务 ---------------- */
const dataDir = await mkdtemp(path.join(tmpdir(), 'dsapp-drop-'));
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), DSAPP_DATA: dataDir, NO_OPEN: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', d => { serverOut += d.toString(); });
server.stderr.on('data', d => { serverOut += d.toString(); });
for (let i = 0; i < 60; i++) {
  await sleep(200);
  try { const r = await fetch(`${BASE}/api/state`); if (r.ok) break; } catch {}
}

/* ---------------- 起无头 Edge ---------------- */
const profile = await mkdtemp(path.join(tmpdir(), 'dsapp-drop-cdp-'));
const browser = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-features=Translate,MediaRouter', '--hide-scrollbars', '--mute-audio',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1440,1000', 'about:blank',
], { stdio: 'ignore' });

let wsUrl = '';
for (let i = 0; i < 80 && !wsUrl; i++) {
  await sleep(200);
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const page = list.find(t => t.type === 'page');
    if (page) wsUrl = page.webSocketDebuggerUrl;
  } catch {}
}
if (!wsUrl) { console.log('连不上浏览器调试端口'); browser.kill(); server.kill(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
};
function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result?.value;
}

try {
  console.log('\n拖入压缩包 → 整理成对话（真实浏览器 DOM）\n');
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: BASE + '/' });
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    const ok = await evaluate(`!!document.querySelector('#dropZone') && !!document.querySelector('#fileInput')`);
    if (ok) break;
  }

  // 1. 覆盖层默认隐藏
  check('拖拽覆盖层默认隐藏', await evaluate(`document.querySelector('#dropZone').classList.contains('hidden')`));

  // 2. 导入入口接受压缩包
  const accept = await evaluate(`document.querySelector('#fileInput').accept`);
  check('#fileInput accept 含 .zip', /\.zip/.test(accept || ''), accept);
  // 设置弹层里才有 #setImport，先点开设置
  await evaluate(`document.querySelector('#settingsBtn')?.click()`);
  let setLabel = '';
  for (let i = 0; i < 20; i++) {
    await sleep(150);
    setLabel = await evaluate(`document.querySelector('#setImport')?.textContent || ''`);
    if (setLabel) break;
  }
  check('设置页按钮改成「导入对话或压缩包」', setLabel.includes('压缩包'), setLabel);
  await evaluate(`document.querySelector('#modalRoot')?.querySelector('.modal-close, [data-close]')?.click?.(); document.querySelector('#closeSettings')?.click(); true`);
  await sleep(200);

  // 3. dragenter 显示、dragleave 收起
  const enter = await evaluate(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'a.zip', { type: 'application/zip' }));
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
    window.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true }));
    return !document.querySelector('#dropZone').classList.contains('hidden');
  })()`);
  check('dragenter 后覆盖层出现', enter === true);
  const title = await evaluate(`document.querySelector('.drop-title')?.textContent || ''`);
  check('覆盖层文案「松手，整理成对话」', title.includes('松手'), title);
  const leave = await evaluate(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'a.zip', { type: 'application/zip' }));
    window.dispatchEvent(new DragEvent('dragleave', { dataTransfer: dt, bubbles: true }));
    return document.querySelector('#dropZone').classList.contains('hidden');
  })()`);
  check('dragleave 后覆盖层收起', leave === true);

  // 4. 真拖一个资料包进去 → 对话页收到 zip 会转去「导入」页（自识别，不闷头灌）
  const dropped = await evaluate(`(async () => {
    const bin = Uint8Array.from(atob(${JSON.stringify(zipB64)}), c => c.charCodeAt(0));
    const file = new File([bin], '资料包.zip', { type: 'application/zip' });
    const dt = new DataTransfer();
    dt.items.add(file);
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
    return true;
  })()`);
  check('drop 事件已派发', dropped === true);

  // 4a) 应该跳到导入页，并且把这一包认出来
  let pageTitle = '', itemCount = 0, itemText = '';
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    pageTitle = await evaluate(`document.querySelector('#pageTitle')?.textContent || ''`);
    const info = await evaluate(`(() => {
      const items = [...document.querySelectorAll('#impList .imp-item')];
      return { n: items.length, t: items.map(el => el.textContent).join(' | ').slice(0, 120) };
    })()`);
    itemCount = info.n;
    itemText = info.t;
    if (/导入/.test(pageTitle) && itemCount >= 1) break;
  }
  check('zip 拖入后转到「导入」页', /导入/.test(pageTitle), pageTitle || '（空）');
  check('导入页把它认出来了', itemCount >= 1, `条目 ${itemCount}：${itemText}`);

  // 4b) 点「开始导入」→ 落库并切到新对话
  await evaluate(`document.querySelector('#impRun')?.click()`);
  let toastText = '', convCount = -1, activeTitle = '', msgCount = 0;
  for (let i = 0; i < 100; i++) {
    await sleep(250);
    toastText = await evaluate(`document.querySelector('#toast')?.textContent || ''`);
    convCount = await evaluate(`document.querySelectorAll('.conv-item').length`);
    activeTitle = await evaluate(`document.querySelector('.conv-item.active .t-title')?.textContent || ''`);
    if (/导入完成|已导入|整理完成/.test(toastText) && activeTitle) break;
  }
  check('导入后有完成提示', /导入完成|已导入|整理完成/.test(toastText), toastText.slice(0, 40));
  check('侧栏出现导入出来的对话', convCount >= 2, `会话数 ${convCount}`);

  // 侧栏重绘可能比 DOM 查询晚一拍：点开导入出来的那条（不依赖应用是否自动切过去）
  const opened = await evaluate(`(() => {
    const items = [...document.querySelectorAll('.conv-item')];
    const hit = items.find(el => /资料包/.test(el.textContent || ''));
    if (!hit) return false;
    hit.click();
    return true;
  })()`);
  check('侧栏能找到「资料包」这条对话', opened === true);
  for (let i = 0; i < 25 && !/资料包/.test(activeTitle); i++) {
    await sleep(200);
    activeTitle = await evaluate(`document.querySelector('.conv-item.active .t-title')?.textContent || ''`);
  }
  msgCount = await evaluate(`document.querySelectorAll('.msg').length`);
  check('打开的是导入出来的对话', /资料包/.test(activeTitle), activeTitle || '（空）');
  check('打开后有消息内容', msgCount >= 1, `消息数 ${msgCount}`);

  // 正文渲染同样可能晚一拍
  let sample = '';
  for (let i = 0; i < 25; i++) {
    sample = await evaluate(`(document.querySelector('.bubble')?.innerText || '').slice(0, 240)`);
    if (sample) break;
    await sleep(200);
  }
  check('正文带「资料包」标题与文件清单', /资料包/.test(sample) && /.md/.test(sample), sample.replace(/\s+/g, ' ').slice(0, 70));

  // 5. 服务端确实落盘了
  const state = await (await fetch(`${BASE}/api/state`)).json();
  check('服务端会话列表已更新', Array.isArray(state.conversations) && state.conversations.length >= 2,
    `${state.conversations?.length} 个`);
} finally {
  try { ws.close(); } catch {}
  browser.kill();
  server.kill();
  await sleep(400);
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
