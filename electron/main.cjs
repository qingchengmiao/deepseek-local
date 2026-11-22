// DeepSeek 本地版 · Electron 外壳
// 职责：在应用进程内把本地服务跑起来（不用外部 node）→ 开自己的窗口 → 退出时一起关掉。
const { app, BrowserWindow, Menu, shell, session, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

// 这台机器上 Chromium 的沙箱初始化会让主进程直接静默退出（双击没反应的根因）。
// 应用只加载 127.0.0.1 的本地页面、外部导航一律拦掉，所以关掉沙箱是可接受的折中；
// 如果哪天想恢复，删掉下面这行即可（也可以从命令行传 --no-sandbox）。
if (process.env.DSAPP_SANDBOX !== '1') {
  app.commandLine.appendSwitch('no-sandbox');
}

// 打包后：代码在 resources/app/，数据放到 exe 旁边的 data/（可写）
// 开发时：代码就是仓库根目录，数据就在仓库的 data/
const CODE_DIR = app.isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '..');
const DATA_DIR = process.env.DSAPP_DATA
  ? path.resolve(process.env.DSAPP_DATA)
  : app.isPackaged
    ? path.join(path.dirname(process.execPath), 'data')
    : path.join(CODE_DIR, 'data');
const RUNTIME_FILE = path.join(DATA_DIR, 'server.json');
const ICON = path.join(CODE_DIR, 'assets', 'app.ico');
const DEFAULT_PORT = 8787;
const PORT_SCAN = 18;

const log = (...a) => console.log('[app]', ...a);

// 启动追踪：出问题时光看窗口是没有线索的，落到 data/app-start.log 里
function trace(stage, extra) {
  try {
    const line = `${new Date().toISOString()} ${stage}${extra === undefined ? '' : ' ' + JSON.stringify(extra)}\n`;
    fs.appendFileSync(path.join(DATA_DIR, 'app-start.log'), line);
  } catch {}
}
trace('boot', {
  argv: process.argv.slice(1),
  isPackaged: app.isPackaged,
  execPath: process.execPath,
  resourcesPath: process.resourcesPath,
  runAsNode: process.env.ELECTRON_RUN_AS_NODE || '',
  dataDir: DATA_DIR,
  pid: process.pid,
});
process.on('uncaughtException', err => {
  trace('uncaughtException', { message: String(err && err.message || err), stack: String(err && err.stack || '').slice(0, 2000) });
  try { dialog.showErrorBox('启动失败', String((err && err.message) || err)); } catch {}
  app.exit(1);
});
process.on('unhandledRejection', err => {
  trace('unhandledRejection', { message: String(err && err.message || err) });
});

let win = null;
let watchdog = null;         // 服务探活定时器（服务被外部重启后自动刷新页面）
let startedServer = false;   // 服务是不是这个进程起的
let ownedPort = 0;

// 右键菜单：不依赖 Ctrl+C / Ctrl+V，鼠标就能复制、剪切、粘贴、全选。
// 只挂在自己页面的 webContents 上；会话列表那块是渲染层自绘菜单，这里不抢。
function installEditMenu(wc) {
  wc.on('context-menu', (event, params) => {
    const f = params.editFlags || {};
    const sel = (params.selectionText || '').trim();
    const isEdit = !!params.isEditable;
    const items = [];

    if (isEdit) {
      items.push({ label: '剪切', accelerator: 'CmdOrCtrl+X', enabled: f.canCut !== false && !!sel, click: () => wc.cut() });
      items.push({ label: '复制', accelerator: 'CmdOrCtrl+C', enabled: f.canCopy !== false && !!sel, click: () => wc.copy() });
      items.push({ label: '粘贴', accelerator: 'CmdOrCtrl+V', enabled: f.canPaste !== false, click: () => wc.paste() });
      items.push({ type: 'separator' });
      items.push({ label: '全选', accelerator: 'CmdOrCtrl+A', enabled: f.canSelectAll !== false, click: () => wc.selectAll() });
    } else if (sel) {
      items.push({ label: '复制', accelerator: 'CmdOrCtrl+C', enabled: f.canCopy !== false, click: () => wc.copy() });
      items.push({ type: 'separator' });
      items.push({ label: '全选', accelerator: 'CmdOrCtrl+A', enabled: f.canSelectAll !== false, click: () => wc.selectAll() });
    } else {
      return;   // 空白处不弹菜单
    }

    trace('context-menu', { editable: isEdit, sel: sel.length, x: params.x, y: params.y });
    Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(wc) });
  });
}

// 所有窗口都挂上（主窗口 + 引用/链接打开的本地子窗口）
app.on('web-contents-created', (e, wc) => {
  if (wc.getType && wc.getType() !== 'window') return;
  installEditMenu(wc);
});

async function ping(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(900) });
    return r.ok;
  } catch {
    return false;
  }
}

async function findRunning() {
  let start = DEFAULT_PORT;
  try {
    const rec = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
    if (Number(rec.port) >= 1024) start = Number(rec.port);
  } catch {}
  for (let i = 0; i < PORT_SCAN; i++) {
    const port = start + i;
    if (port > 65535) break;
    if (await ping(port)) return port;
  }
  return 0;
}

async function startServerInProcess() {
  process.env.DSAPP_DATA = DATA_DIR;
  const entry = path.join(CODE_DIR, 'server.mjs');
  log('在应用进程内启动服务：', entry, '数据目录：', DATA_DIR);
  await import(pathToFileURL(entry).href);
  startedServer = true;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const port = await findRunning();
    if (port) { ownedPort = port; return port; }
    await new Promise(r => setTimeout(r, 350));
  }
  throw new Error('服务在 25 秒内没就绪');
}

function createWindow(port) {  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 420,
    minHeight: 520,
    title: 'DeepSeek Local',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    backgroundColor: '#1f2024',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);

  win.webContents.setWindowOpenHandler(({ url }) => {
    const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url);
    if (local) return { action: 'allow' };
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  win.once('ready-to-show', () => {
    win.show();
    trace('windowShown');
  });
  win.on('closed', () => { win = null; });

  // 窗口别停在「127.0.0.1 拒绝连接」上：服务刚起/刚重启时页面可能抢跑，
  // 加载失败就退避重试几次；渲染进程崩了也直接重载。
  let loadRetry = 0;
  const target = `http://127.0.0.1:${port}/`;
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (!isMain) return;
    trace('did-fail-load', { code, desc, url, retry: loadRetry });
    if (loadRetry >= 8) {
      // 八次都没起来：给一个能自己恢复的页面，而不是浏览器的错误页
      const html = `<meta charset="utf-8"><title>DeepSeek Local</title>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:#1f2024;color:#e8e9ed;font:15px/1.7 'Segoe UI',system-ui,sans-serif">
<div style="text-align:center">
<div style="font-size:17px;font-weight:600;margin-bottom:8px">本地服务还没起来</div>
<div style="color:#9aa0aa;margin-bottom:18px">127.0.0.1:${port} 暂时连不上，通常是服务正在重启。</div>
<button onclick="location.href='${target}'" style="height:36px;padding:0 18px;border:0;border-radius:18px;
background:#4d6bfe;color:#fff;font-size:14px;cursor:pointer">重试</button>
<div style="color:#6b7078;font-size:12px;margin-top:16px">这个页面每 3 秒自动重试一次</div>
</div>
<script>setTimeout(() => location.href = ${JSON.stringify(target)}, 3000);</script>`;
      win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      return;
    }
    loadRetry += 1;
    setTimeout(() => { try { win.loadURL(target); } catch {} }, 400 + loadRetry * 250);
  });
  win.webContents.on('did-finish-load', () => { loadRetry = 0; });
  win.webContents.on('render-process-gone', (e, details) => {
    trace('render-process-gone', details || {});
    setTimeout(() => { try { win.loadURL(target); } catch {} }, 500);
  });

  win.loadURL(target);

  // 看门狗：服务被外部重启（换数据目录、跑测试）时，等它回来就自动刷新页面，
  // 不用用户自己按 F5。3 次探活失败算「断了」，恢复后再刷新一次。
  if (!watchdog) {
    let down = 0;
    watchdog = setInterval(async () => {
      if (!win || win.isDestroyed()) return;
      const alive = await ping(port);
      if (!alive) { down += 1; return; }
      if (down >= 3) {
        down = 0;
        trace('serviceBack', { port });
        try { win.webContents.reload(); } catch {}
      }
      down = 0;
    }, 5000);
    if (watchdog.unref) watchdog.unref();
  }
  return win;
}

// 用户配置放在自己的 data 目录里：官方 DeepSeek 桌面版也用 %APPDATA%\DeepSeek，
// 共用会导致单实例锁互相干扰（一个在跑，另一个就静默退出）。
const PROFILE_DIR = path.join(DATA_DIR, 'app-profile');
try { fs.mkdirSync(PROFILE_DIR, { recursive: true }); } catch {}
app.setPath('userData', PROFILE_DIR);

function focusWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.moveTop();
  win.focus();
  // 从别的窗口后面叫出来：短暂置顶再取消
  try {
    win.setAlwaysOnTop(true, 'floating');
    setTimeout(() => { try { win.setAlwaysOnTop(false); } catch {} }, 600);
  } catch {}
  try { app.focus({ steal: true }); } catch {}
  trace('focusWindow');
}

app.setAppUserModelId('DeepSeek.Local');

const gotLock = app.requestSingleInstanceLock();
trace('singleInstanceLock', { gotLock });
if (!gotLock) {
  // 已经有一个在跑：什么都不用做，那个实例会收到 second-instance 并把窗口叫出来
  trace('quit', { why: '另一个实例占着锁，已通知它把窗口叫到前面' });
  app.quit();
} else {
  app.on('second-instance', () => {
    trace('second-instance', { hasWindow: !!win });
    focusWindow();
  });

  app.whenReady().then(async () => {
    trace('ready');
    // 麦克风只放给本机地址
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
      const ok = permission === 'media' && /^http:\/\/(127\.0\.0\.1|localhost):\d+/.test(wc.getURL());
      cb(ok);
    });

    try {
      let port = await findRunning();
      trace('findRunning', { port });
      if (port) {
        log('已有服务在跑，直接接上：', port);
      } else {
        port = await startServerInProcess();
        log('服务就绪：', port);
        trace('serverReady', { port });
      }
      createWindow(port);
      trace('windowCreated', { port });
    } catch (err) {
      trace('startupFailed', { message: String((err && err.message) || err) });
      dialog.showErrorBox('启动失败', String((err && err.message) || err));
      app.quit();
    }
  });

  let quitting = false;
  app.on('before-quit', async e => {
    if (quitting || !startedServer) return;
    quitting = true;
    const port = ownedPort;
    startedServer = false;
    ownedPort = 0;
    if (port) {
      e.preventDefault();
      try {
        // 这个接口会先删 server.json 再退出进程（服务和我们在同一进程里，退出即收尾）
        await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2500) });
      } catch {}
      app.quit();
    }
  });

  app.on('window-all-closed', () => app.quit());
}
