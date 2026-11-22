// 验二维码自动刷新：自己造两张不同的二维码图，先放第一张，页面读它；再换第二张，看是否自动换图 + 计数 + 倒计时
// 不依赖本机 NapCat 的图，跑完还原设置、删临时目录。
// 用法：起一个隔离数据目录的测试服务（端口自定），然后
//   BASE=http://127.0.0.1:8901 node tools/qr-refresh-test.mjs
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { launch, sleep } from './cdp.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8901';
const AUTO = Number(process.env.QR_AUTO || '3');

// ---- 造一张 21×21 的假二维码（黑块按 seed 摆，尺寸不同方便肉眼分辨） ----
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function fakeQr(seed, cells = 21, scale = 8) {
  const w = cells * scale, h = cells * scale;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  const inFinder = (x, y) => {
    const near = (cx, cy) => x >= cx && x < cx + 7 && y >= cy && y < cy + 7 &&
      !(x > cx + 1 && x < cx + 5 && y > cy + 1 && y < cy + 5 && !(x === cx + 3 || y === cy + 3));
    return near(0, 0) || near(cells - 7, 0) || near(0, cells - 7);
  };
  for (let y = 0; y < h; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const gx = Math.floor(x / scale), gy = Math.floor(y / scale);
      const black = inFinder(gx, gy) || ((gx * 7 + gy * 13 + seed * 29) % 5 < 2);
      const v = black ? 0 : 255;
      raw[p++] = v; raw[p++] = v; raw[p++] = v;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const api = async (p, opt) => (await fetch(BASE + p, opt)).json();
const putSettings = patch => api('/api/settings', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
});

const work = await mkdtemp(path.join(tmpdir(), 'dsapp-qr-'));
const qrDir = path.join(work, 'NapCat.Test.Shell', 'cache');
await mkdir(qrDir, { recursive: true });
const qrA = fakeQr(1, 21), qrB = fakeQr(2, 29); // 两张尺寸、内容都不同
await writeFile(path.join(qrDir, 'qrcode.png'), qrA);
console.log('临时 NapCat 目录：', qrDir, `（图 A ${qrA.length}B / 图 B ${qrB.length}B）`);

const old = (await api('/api/settings')).qqNapCatDir;
await putSettings({ qqNapCatDir: qrDir });
await sleep(300);
const seeded = await api('/api/napcat/qr');
console.log('服务端读到：', seeded.qr && seeded.qr.hash, seeded.qr && seeded.qr.size, 'B');

let failed = [];
const check = (name, cond, extra = '') => {
  if (!cond) failed.push(name);
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
};

const b = await launch({ port: 9346, width: 1400, height: 980 });
try {
  await b.goto(`${BASE}/?qrAuto=${AUTO}`);
  await b.waitFor(`document.querySelectorAll('#convList .conv-item').length > 0`, 20000);
  await b.ev(`document.querySelector('#qqNavBtn').click()`);
  check('QQ 页出现二维码图', await b.waitFor(`!!document.querySelector('#qqQrImg')`, 10000));
  await sleep(700);

  const readState = () => b.ev(`(() => {
    const img = document.querySelector('#qqQrImg');
    const meta = document.querySelector('#qqQrMeta');
    const cnt = document.querySelector('#qqQrCount');
    return {
      hash: img ? img.dataset.hash : '',
      srcLen: img ? img.getAttribute('src').length : 0,
      nw: img ? img.naturalWidth : 0,
      meta: meta ? meta.textContent.replace(/\\s+/g, ' ').trim() : '',
      count: cnt ? cnt.textContent : '',
    };
  })()`);

  const first = await readState();
  check('起手拿到 hash', !!first.hash, first.hash);
  check('起手图解码成功', first.nw > 0, first.nw + 'px');

  // 换码
  await writeFile(path.join(qrDir, 'qrcode.png'), qrB);
  console.log(`已换码（A → B），等 ${AUTO}+4 秒看自动刷新…`);
  await sleep((AUTO + 4) * 1000);
  const second = await readState();
  check('hash 变了', first.hash !== second.hash && !!second.hash, `${first.hash} → ${second.hash}`);
  check('<img src> 换了', first.srcLen !== second.srcLen);
  check('新图解码成功且尺寸变了', second.nw > 0 && second.nw !== first.nw, `${first.nw} → ${second.nw}px`);
  check('计数到「第 2 次刷新」', /第 2 次刷新/.test(second.meta));
  check('倒计时在跑', /^\d{2}:\d{2}$/.test(second.count), second.count);
  check('页面写了自动刷新间隔', /约每 \d+ 秒自动刷新/.test(second.meta));

  // 倒计时连续采样，确认不被重绘冲掉
  const samples = [];
  for (let i = 0; i < 4; i++) { samples.push(await b.ev(`(document.querySelector('#qqQrCount')||{}).textContent || ''`)); await sleep(1000); }
  check('倒计时稳定不闪', samples.every(t => /^\d{2}:\d{2}$/.test(t)), samples.join(' → '));

  // 手动刷新同一张图
  await b.ev(`document.querySelector('[data-x="napRefresh"]').click()`);
  await sleep(1500);
  const third = await readState();
  check('手动刷新后 hash 不变', third.hash === second.hash);
  const toastText = await b.ev(`document.querySelector('#toast') ? document.querySelector('#toast').textContent.trim() : ''`);
  check('手动刷新给了提示', /还是同一张码|二维码有更新/.test(toastText), toastText);

  const shot = await b.cdp('Page.captureScreenshot', { format: 'png' });
  await mkdir('data/shots', { recursive: true });
  await writeFile('data/shots/30-QQ-二维码自动刷新.png', Buffer.from(shot.data, 'base64'));
  console.log('截图：data/shots/30-QQ-二维码自动刷新.png');
} finally {
  await b.close();
  await putSettings({ qqNapCatDir: old });
  await rm(work, { recursive: true, force: true });
  console.log('已还原 NapCat 目录并清掉临时图：', old);
}
console.log(failed.length ? '失败：' + failed.join('、') : '全部通过');
process.exit(failed.length ? 1 : 0);
