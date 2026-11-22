// 导入数据审计：会话 / 消息 / 附件引用 / 媒体文件，逐条核到能打开
// 用法：node tools/audit-media.mjs [--sample 3]
import { readdir, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const DATA = process.env.DSAPP_DATA || 'data';
const args = process.argv.slice(2);
const SAMPLE = Number((args.find(a => a.startsWith('--sample=')) || '').split('=')[1] || 0);

const j = async p => {
  const r = await fetch(BASE + p, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${p} → HTTP ${r.status}`);
  return r.json();
};

const state = await j('/api/state');
const convs = state.conversations || [];
console.log(`会话总数：${convs.length}`);

const perConv = [];
const urlRefs = new Map(); // url -> { conv, msgIndex, kind, name }
let totalMsgs = 0, totalReasoning = 0, totalAtt = 0;
const byKind = {};
const missing = [];
const suspicious = [];
const emptyContent = [];

for (const c of convs) {
  const d = await j('/api/conversations/' + c.id);
  const conv = d.conversation || d;
  const msgs = conv.messages || [];
  totalMsgs += msgs.length;
  let imgs = 0, files = 0, media = 0, reasoning = 0;
  msgs.forEach((m, i) => {
    if (m.reasoning) reasoning++;
    if (m.role === 'user' && !String(m.content || '').trim() && !(m.attachments || []).length) {
      emptyContent.push(`${c.title}#${i}`);
    }
    for (const a of m.attachments || []) {
      totalAtt++;
      const kind = a.kind || 'file';
      byKind[kind] = (byKind[kind] || 0) + 1;
      if (kind === 'image') imgs++;
      else if (kind === 'file') files++;
      else media++;
      if (a.url) urlRefs.set(a.url, { conv: c.title, msgIndex: i, kind, name: a.name });
      else if (kind === 'image') missing.push(`${c.title}#${i} 图片没有 url（name=${a.name}）`);
    }
  });
  totalReasoning += reasoning;
  perConv.push({ title: c.title, msgs: msgs.length, imgs, files, media, reasoning, id: c.id });
}

console.log(`消息总数：${totalMsgs}（带思考过程 ${totalReasoning}）`);
console.log(`附件引用：${totalAtt} → ${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
console.log('');

// 逐个 URL 核到真的能取
let okCount = 0, badUrl = 0, zeroBytes = 0;
const badList = [];
const kindStat = {};
const sizes = [];
const urls = [...urlRefs.keys()];
const CONCURRENCY = 8;
for (let i = 0; i < urls.length; i += CONCURRENCY) {
  await Promise.all(urls.slice(i, i + CONCURRENCY).map(async url => {
    const ref = urlRefs.get(url);
    try {
      const r = await fetch(BASE + url, { signal: AbortSignal.timeout(15000) });
      const buf = Buffer.from(await r.arrayBuffer());
      if (!r.ok) { badUrl++; badList.push(`${url} → HTTP ${r.status}（${ref.conv}）`); return; }
      const type = r.headers.get('content-type') || '?';
      if (!buf.length) { zeroBytes++; badList.push(`${url} → 0 字节（${ref.conv}）`); return; }
      okCount++;
      sizes.push(buf.length);
      const key = `${ref.kind}|${type.split(';')[0]}`;
      kindStat[key] = (kindStat[key] || 0) + 1;
      // 图片再做一次「是不是真图片」的粗检：webp/gif/png/jpeg 的魔数
      if (ref.kind === 'image') {
        const head = buf.subarray(0, 12);
        const isWebp = head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
        const isGif = head.subarray(0, 3).toString('latin1') === 'GIF';
        const isPng = head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        const isJpg = head[0] === 0xff && head[1] === 0xd8;
        if (!(isWebp || isGif || isPng || isJpg)) suspicious.push(`${url} 魔数不像图片：${head.toString('hex')}`);
      }
    } catch (e) {
      badUrl++;
      badList.push(`${url} → ${e.message}（${ref.conv}）`);
    }
  }));
}

console.log(`媒体 URL 去重后 ${urls.length} 个：可读取 ${okCount}，失败 ${badUrl}，空文件 ${zeroBytes}`);
const totalBytes = sizes.reduce((a, b) => a + b, 0);
if (sizes.length) {
  sizes.sort((a, b) => a - b);
  const avg = Math.round(totalBytes / sizes.length);
  console.log(`体积：合计 ${(totalBytes / 1048576).toFixed(1)} MB，平均 ${(avg / 1024).toFixed(0)} KB，最小 ${sizes[0]} B，中位 ${(sizes[Math.floor(sizes.length / 2)] / 1024).toFixed(0)} KB，最大 ${(sizes[sizes.length - 1] / 1048576).toFixed(1)} MB`);
}
console.log('按类型：' + Object.entries(kindStat).map(([k, v]) => `${k} ${v}`).join(' | '));
if (badList.length) {
  console.log(`\n取不到的（前 20）：`);
  badList.slice(0, 20).forEach(x => console.log('  ✗ ' + x));
}
if (suspicious.length) {
  console.log(`\n可疑文件（前 10）：`);
  suspicious.slice(0, 10).forEach(x => console.log('  ! ' + x));
}
if (missing.length) {
  console.log(`\n没有 url 的图片（前 10）：`);
  missing.slice(0, 10).forEach(x => console.log('  ! ' + x));
}

// 孤儿文件：磁盘上有没有没被任何消息引用的
let diskFiles = 0;
const mediaDirs = path.join(DATA, 'media');
const referenced = new Set(urls.map(u => decodeURIComponent(u.split('/').pop())));
const orphans = [];
if (existsSync(mediaDirs)) {
  for (const dir of await readdir(mediaDirs, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const abs = path.join(mediaDirs, dir.name);
    for (const f of await readdir(abs)) {
      diskFiles++;
      const st = await stat(path.join(abs, f));
      if (!st.size) orphans.push(`${dir.name}/${f} → 0 字节`);
      if (!referenced.has(f) && dir.name.startsWith('imported-')) orphans.push(`${dir.name}/${f} → 没被引用`);
    }
  }
}
console.log(`\n磁盘上的媒体文件：${diskFiles} 个（data/media/）`);
if (orphans.length) {
  console.log(`  可疑：${orphans.length} 个（前 10）`);
  orphans.slice(0, 10).forEach(x => console.log('  ! ' + x));
} else {
  console.log('  没有孤儿、没有 0 字节文件');
}

console.log('\n每个会话：标题 · 消息 · 图 · 文档 · 音视频 · 思考');
for (const c of perConv.sort((a, b) => b.msgs - a.msgs)) {
  console.log(`  ${String(c.msgs).padStart(5)}  ${String(c.imgs).padStart(4)}图 ${String(c.files).padStart(2)}档 ${String(c.media).padStart(2)}媒 ${String(c.reasoning).padStart(5)}想  ${c.title}`);
}

// 抽样：真在页面里渲染一遍，看 img 有没有真的解码出来
if (SAMPLE > 0) {
  const { launch, sleep } = await import('./cdp.mjs');
  const targets = perConv.filter(c => c.imgs > 0).slice(0, SAMPLE);
  console.log(`\n页面渲染抽查（${targets.length} 个有图的会话）：`);
  const b = await launch({ port: 9337, width: 1440, height: 1000 });
  try {
    await b.goto(BASE + '/');
    await b.waitFor(`document.querySelectorAll('#convList .conv-item').length > 0`, 20000);
    for (const t of targets) {
      await b.ev(`(() => { const it = [...document.querySelectorAll('#convList .conv-item')].find(x => x.dataset.id === ${JSON.stringify(t.id)}); if (it) it.click(); })()`);
      await b.waitFor(`document.querySelectorAll('#messages .msg').length > 0`, 20000);
      await sleep(600);
      // 一直点「载入更早的」，直到没有按钮了（或点满 40 次）
      let clicks = 0;
      for (let i = 0; i < 40; i++) {
        const hit = await b.ev(`(() => { const b = document.querySelector('#messages .load-more'); if (!b) return false; b.click(); return true; })()`);
        if (!hit) break;
        clicks++;
        await sleep(350);
      }
      await sleep(1500);
      // 图片是 loading="lazy"：不滚动就只有视口里那几张会解码，所以整条滚一遍再数
      const scroller = `document.querySelector('#scroller')`;
      const h = await b.ev(`(() => { const s = ${scroller}; return { h: s.scrollHeight, v: s.clientHeight }; })()`);
      const step = Math.max(200, Math.floor(h.v * 0.6));
      for (let y = 0; y < h.h; y += step) {
        await b.ev(`(() => { ${scroller}.scrollTop = ${y}; })()`);
        await sleep(90);
      }
      await sleep(1200);
      // 再逐张滚进视口，确保每张 lazy 图都真的请求过
      const tagCount = await b.ev(`document.querySelectorAll('#messages .att-img img').length`);
      for (let k = 0; k < tagCount; k++) {
        await b.ev(`(() => { const im = document.querySelectorAll('#messages .att-img img')[${k}]; if (im) im.scrollIntoView({ block: 'center' }); })()`);
        await sleep(60);
      }
      await sleep(1500);
      const r = await b.ev(`(() => {
        const imgs = [...document.querySelectorAll('#messages .att-img img')];
        const loaded = imgs.filter(i => i.complete && i.naturalWidth > 0);
        return {
          rendered: document.querySelectorAll('#messages .msg').length,
          imgTags: imgs.length,
          decoded: loaded.length,
          minW: imgs.length ? Math.min(...loaded.map(i => i.naturalWidth)) : 0,
        };
      })()`);
      console.log(`  ${t.title}：载入 ${r.rendered} 条、整条滚动一遍后，页面 img 标签 ${r.imgTags} 个，解码成功 ${r.decoded} 个（最小宽 ${r.minW}px；该会话共 ${t.imgs} 张图）`);
    }
  } finally {
    await b.close();
  }
}
