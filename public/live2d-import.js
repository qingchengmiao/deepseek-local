/* DSL 客户端吉祥物：一键导入 Live2D
 * 用法：点吉祥物左下角的小按钮「L2D」→ 选「包含 model3.json 的那一层目录」；
 *      右键同一个按钮 → 清除，回到原来的静态图。
 * 模型（model3.json / .moc3 / 贴图 / 动作）整个存进 IndexedDB，刷新后自动还原。
 * 回滚：删掉本文件 + 去掉 index.html 里的 <script>，再删掉 #mascot 下的 .mascot-l2d 即可。
 */
(function () {
  'use strict';
  if (window.mascotL2D) return;

  var CDN = {
    pixi: 'https://cdn.jsdelivr.net/npm/pixi.js@7.4.2/dist/pixi.min.js',
    core: 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js',
    cubism4: 'https://cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0/dist/cubism4.min.js'
  };
  var LOCAL = {
    pixi: '/assets/live2d/pixi.min.js',
    core: '/assets/live2d/live2dcubismcore.min.js',
    cubism4: '/assets/live2d/cubism4.min.js'
  };
  var DB_NAME = 'dsl-mascot-l2d';
  var STORE = 'files';
  var KEY = 'current';

  var state = {
    ready: false,
    runtime: 'idle', // idle | loading | ok | err
    app: null,
    model: null,
    host: null,
    btn: null,
    img: null,
    current: null
  };

  function toast(msg, ms) {
    var el = document.getElementById('mascotL2DTip');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mascotL2DTip';
      el.className = 'mascot-l2d-tip';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, ms || 4200);
    try { console.log('[mascot-l2d] ' + msg); } catch (e) {}
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(src); };
      s.onerror = function () { reject(new Error('加载失败：' + src)); };
      document.head.appendChild(s);
    });
  }

  function tryFirst(list) {
    var i = 0;
    function next(err) {
      if (i >= list.length) throw (err || new Error('全部来源都失败'));
      var src = list[i++];
      return loadScript(src).catch(next);
    }
    return next();
  }

  function ensureRuntime() {
    if (window.PIXI && window.Live2DCubismCore && window.PIXI.live2d) {
      state.runtime = 'ok';
      return Promise.resolve();
    }
    state.runtime = 'loading';
    markButton();
    return Promise.resolve()
      .then(function () {
        if (window.PIXI) return;
        return tryFirst([LOCAL.pixi, CDN.pixi]);
      })
      .then(function () {
        if (window.Live2DCubismCore) return;
        return tryFirst([LOCAL.core, CDN.core]);
      })
      .then(function () {
        if (window.PIXI.live2d) return;
        return tryFirst([LOCAL.cubism4, CDN.cubism4]);
      })
      .then(function () {
        if (!window.PIXI || !window.Live2DCubismCore || !window.PIXI.live2d) {
          throw new Error('Live2D 运行时没装上（pixi / cubism core / cubism4）');
        }
        state.runtime = 'ok';
        markButton();
      })
      .catch(function (err) {
        state.runtime = 'err';
        markButton();
        throw err;
      });
  }

  /* ---------- IndexedDB ---------- */
  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB 打不开')); };
    });
  }

  function dbPut(value) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, KEY);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function dbGet() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).get(KEY);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function dbDel() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(KEY);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  /* ---------- DOM ---------- */
  function mascotRoot() {
    return document.getElementById('mascot');
  }

  function ensureHost() {
    var root = mascotRoot();
    if (!root) return null;
    if (state.host && state.host.parentNode === root) return state.host;
    var host = document.createElement('div');
    host.className = 'mascot-l2d';
    root.appendChild(host);
    state.host = host;
    state.img = root.querySelector('img');
    return host;
  }

  function ensureApp() {
    var host = ensureHost();
    if (!host) return null;
    if (state.app) return state.app;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var app = new window.PIXI.Application({
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: dpr,
      width: Math.max(1, host.clientWidth),
      height: Math.max(1, host.clientHeight)
    });
    var canvas = app.view;
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    host.appendChild(canvas);
    state.app = app;
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { fitModel(); });
      ro.observe(host);
    }
    return app;
  }

  function fitModel() {
    var app = state.app;
    var model = state.model;
    if (!app || !model || !state.host || !model.internalModel) return;
    var w = Math.max(1, state.host.clientWidth);
    var h = Math.max(1, state.host.clientHeight);
    app.renderer.resize(w, h);
    var mw = model.internalModel.width || model.width || 1;
    var mh = model.internalModel.height || model.height || 1;
    var scale = Math.min(w / mw, h / mh) * 1.04;
    model.scale.set(scale);
    model.anchor.set(0.5, 1);
    model.position.set(w / 2, h);
  }

  function hideSprite(hide) {
    if (state.img) state.img.style.visibility = hide ? 'hidden' : '';
    var root = mascotRoot();
    if (root) root.classList.toggle('l2d-on', !!hide);
  }

  function startIdle() {
    var model = state.model;
    if (!model || !model.internalModel) return;
    try { model.internalModel.motionManager.stopAllMotions(); } catch (e) {}
    var groups = (model.internalModel.motionManager.definitions || {});
    var names = Object.keys(groups);
    var idle = names.find(function (n) { return /idle|待机|tap_body|桃/i.test(n); }) || names[0];
    if (!idle) return;
    var list = groups[idle] || [];
    clearInterval(state._idle);
    state._idle = setInterval(function () {
      try {
        model.motion(idle, Math.floor(Math.random() * Math.max(1, list.length)));
      } catch (e) {}
    }, 12000);
  }

  function destroyModel() {
    clearInterval(state._idle);
    if (state.model) {
      try { state.model.destroy(); } catch (e) {}
      state.model = null;
    }
  }

  /* ---------- 模型装配 ---------- */
  function blobUrl(blob) {
    return URL.createObjectURL(blob);
  }

  function rewriteSettings(settings, resolve) {
    var out = JSON.parse(JSON.stringify(settings));
    var fr = out.FileReferences || {};
    if (fr.Moc && resolve(fr.Moc)) fr.Moc = resolve(fr.Moc);
    if (Array.isArray(fr.Textures)) {
      fr.Textures = fr.Textures.map(function (p) { return resolve(p) || p; });
    }
    ['Physics', 'Pose'].forEach(function (k) {
      if (fr[k] && resolve(fr[k])) fr[k] = resolve(fr[k]);
    });
    if (Array.isArray(fr.Expressions)) {
      fr.Expressions.forEach(function (e) { if (e && e.File && resolve(e.File)) e.File = resolve(e.File); });
    }
    if (fr.Motions) {
      Object.keys(fr.Motions).forEach(function (g) {
        fr.Motions[g].forEach(function (m) { if (m && m.File && resolve(m.File)) m.File = resolve(m.File); });
      });
    }
    out.FileReferences = fr;
    return out;
  }

  function buildModelUrl(jsonText, entries) {
    var map = {};
    var baseName = {};
    entries.forEach(function (it) {
      map[it.path] = it;
      var b = it.path.split('/').pop();
      baseName[b] = baseName[b] || it;
    });
    var missing = [];
    function resolve(p) {
      if (!p) return '';
      var key = String(p).replace(/\\/g, '/');
      var hit = map[key] || map[key.replace(/^\.\//, '')] || baseName[key.split('/').pop()];
      if (!hit) { missing.push(key); return ''; }
      return blobUrl(hit.blob);
    }
    var settings = rewriteSettings(JSON.parse(jsonText), resolve);
    var blob = new Blob([JSON.stringify(settings)], { type: 'application/json' });
    return { url: blobUrl(blob), settings: settings, missing: missing };
  }

  // 随包带的默认模型：现在留空 —— 开机就是原来的静态图，要点 L2D 自己选目录才会换。
  // 以后拿到定稿的三视图、用 PSD2Live 转好模型，把路径填回这里就会自动加载。
  var DEFAULT_MODEL = '';

  function attach(model) {
    state.app.stage.removeChildren();
    state.app.stage.addChild(model);
    state.model = model;
    hideSprite(true);
    fitModel();
    setTimeout(fitModel, 120);
    startIdle();
    return model;
  }

  function mountUrl(url) {
    return ensureRuntime()
      .then(function () {
        if (!ensureApp()) throw new Error('吉祥物还没出来（换个视图再试）');
        destroyModel();
        return window.PIXI.live2d.Live2DModel.from(url, { autoInteract: false });
      })
      .then(attach);
  }

  function mount(built) {
    return mountUrl(built.url);
  }

  // 没导入过模型时，用同源自带的那个（服务器上真没有就安静地退回静态图）
  function mountDefault() {
    if (!DEFAULT_MODEL || state.model) return Promise.resolve(null);
    return fetch(DEFAULT_MODEL, { method: 'HEAD' })
      .then(function (r) {
        if (!r.ok) return null;
        return mountUrl(DEFAULT_MODEL).then(function (model) {
          state.current = { name: 'rig_sd_v6（自带）' };
          markButton();
          return model;
        });
      })
      .catch(function () { return null; });
  }

  /* ---------- 导入 ---------- */
  function entriesFromFiles(files) {
    var picked = Array.prototype.slice.call(files || []);
    var json = picked.find(function (f) {
      return /\.model3\.json$/i.test(f.name) || /\.model\.json$/i.test(f.name);
    });
    if (!json) throw new Error('没找到 model3.json，请选「包含 model3.json 的那一层目录」');
    var rel = (json.webkitRelativePath || json.name).replace(/\\/g, '/');
    var rootDir = rel.indexOf('/') >= 0 ? rel.slice(0, rel.indexOf('/')) : '';
    var entries = [];
    picked.forEach(function (f) {
      var p = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
      if (rootDir && p.indexOf(rootDir + '/') === 0) p = p.slice(rootDir.length + 1);
      if (/\.(model3\.json|model\.json|moc3|moc|png|jpg|jpeg|webp|json|wav|mp3|motion3\.json)$/i.test(f.name)) {
        entries.push({ path: p, blob: f, type: f.type || '' });
      }
    });
    return { json: json, rel: rel, rootDir: rootDir, entries: entries };
  }

  function readFile(f) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result || '')); };
      r.onerror = function () { reject(r.error || new Error('读文件失败')); };
      r.readAsText(f);
    });
  }

  function pickFolder() {
    var input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
    input.style.display = 'none';
    input.onchange = function () {
      var files = input.files;
      if (!files || !files.length) return;
      importFiles(files).catch(function (e) { toast('导入失败：' + (e && e.message ? e.message : e)); });
      input.remove();
    };
    document.body.appendChild(input);
    input.click();
  }

  function importFiles(files) {
    var packed = entriesFromFiles(files);
    return readFile(packed.json)
      .then(function (jsonText) {
        var built = buildModelUrl(jsonText, packed.entries);
        if (built.missing.length) {
          toast('有 ' + built.missing.length + ' 个文件没对上，可能显示不全：' + built.missing.slice(0, 3).join('、'));
        }
        return mount(built).then(function () {
          state.current = { name: packed.rootDir || packed.json.name };
          var record = {
            name: packed.rootDir || packed.json.name,
            at: Date.now(),
            rootDir: packed.rootDir,
            jsonPath: packed.rel,
            jsonText: jsonText,
            files: packed.entries.map(function (it) { return { path: it.path, blob: it.blob, type: it.type }; })
          };
          return dbPut(record).catch(function () {});
        });
      })
      .then(function () {
        toast('Live2D 已导入：' + (state.current ? state.current.name : '') + '（右键 L2D 按钮可清除）', 6000);
      });
  }

  function restore() {
    return dbGet()
      .then(function (rec) {
        if (!rec || !rec.jsonText || !rec.files || !rec.files.length) return null;
        var built = buildModelUrl(rec.jsonText, rec.files);
        return mount(built).then(function () {
          state.current = { name: rec.name || '' };
          return rec;
        });
      })
      .catch(function (e) {
        console.warn('[mascot-l2d] 还原失败', e);
      });
  }

  function clearModel() {
    destroyModel();
    hideSprite(false);
    state.current = null;
    dbDel().catch(function () {});
    toast('已回到原来的静态图');
  }

  /* ---------- 按钮 ---------- */
  function markButton() {
    var btn = state.btn;
    if (!btn) return;
    var map = {
      idle: ['L2D', 'rgba(150,170,200,.75)', '点我导入 Live2D 模型（右键清除）'],
      loading: ['L2D…', 'rgba(230,200,120,.9)', '正在装 Live2D 运行时…'],
      ok: ['L2D OK', 'rgba(110,220,150,.9)', '点我导入 Live2D 模型（运行时已就绪，右键清除）'],
      err: ['L2D X', 'rgba(240,120,140,.9)', 'Live2D 运行时没装上（点我看提示）']
    };
    var cfg = map[state.runtime] || map.idle;
    btn.textContent = cfg[0];
    btn.style.borderColor = cfg[1];
    btn.title = cfg[2] + (state.current ? '\n当前：' + state.current.name : '');
  }

  function ensureButton() {
    // 不挂在 #mascot 里：那个容器会被缩放、被裁，按钮贴它左下角经常看不见。
    // 直接挂 body + 内联样式，位置和大小都不依赖 styles.css。
    var host = document.body || document.documentElement;
    if (!host) return null;
    if (state.btn && state.btn.parentNode === host) return state.btn;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'mascotL2DBtn';
    btn.className = 'mascot-l2d-btn';
    btn.style.cssText = 'position:fixed;left:auto;right:206px;bottom:26px;width:58px;height:26px;'
      + 'z-index:2147483000;opacity:1;border:1px solid rgba(150,170,200,.9);border-radius:6px;'
      + 'background:rgba(20,26,38,.88);color:#cfe6ff;font:600 12px/24px -apple-system,"Segoe UI",sans-serif;'
      + 'letter-spacing:.5px;cursor:pointer;padding:0;pointer-events:auto;box-shadow:0 2px 8px rgba(0,0,0,.25)';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (state.runtime === 'err') {
        ensureRuntime().then(function () { pickFolder(); }).catch(function (err) { toast(String(err.message || err)); });
        return;
      }
      ensureRuntime().then(function () { pickFolder(); }).catch(function (err) { toast(String(err.message || err)); });
    });
    btn.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      clearModel();
    });
    host.appendChild(btn);
    state.btn = btn;
    markButton();
    return btn;
  }

  function boot() {
    // 按钮不依赖 #mascot：有 body 就装得上。
    if (!document.body) return false;
    ensureButton();
    ensureRuntime()
      .then(function () { markButton(); return restore(); })
      .then(function () { return mountDefault(); })
      .catch(function (err) {
        markButton();
        toast('Live2D 运行时没装上：' + (err && err.message ? err.message : err), 8000);
      });
    return true;
  }

  state.ready = true;
  window.mascotL2D = {
    import: pickFolder,
    clear: clearModel,
    mount: mount,
    state: state
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  var tries = 0;
  var timer = setInterval(function () {
    tries += 1;
    if (boot() || tries > 240) clearInterval(timer);
  }, 500);
})();
