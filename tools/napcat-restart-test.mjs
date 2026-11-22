// 验「重启 NapCat 出新码」：造一个假 NapCat 目录（启动脚本会写一张新二维码），
// 调 POST /api/napcat/restart，确认它真的重跑了启动脚本、并把新码读回来。
// 必须指定 BASE（非 8787）：别在真机上把用户的 NapCat 启起来。
//   BASE=http://127.0.0.1:8901 node tools/napcat-restart-test.mjs
import { mkdir, writeFile, mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const BASE = process.env.BASE || '';
if (!BASE) { console.error('缺 BASE（例：BASE=http://127.0.0.1:8901）'); process.exit(2); }
if (/:8787\/?$/.test(BASE)) { console.error('拒绝在 8787（真机服务）上跑：会真的启动 NapCat'); process.exit(2); }

function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
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
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      const gx = Math.floor(x / scale), gy = Math.floor(y / scale);
      const black = ((gx * 7 + gy * 13 + seed * 31) % 5 < 2);
      const v = black ? 0 : 255;
      raw[p++] = v; raw[p++] = v; raw[p++] = v;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const api = async (p, opt) => (await fetch(BASE + p, opt)).json();
const putSettings = patch => api('/api/settings', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
});

const work = await mkdtemp(path.join(tmpdir(), 'dsapp-napcat-'));
const napDir = path.join(work, 'NapCat.Test.Shell');
const cache = path.join(napDir, 'cache');
await mkdir(cache, { recursive: true });
const qrOld = fakeQr(3, 21);
const qrNew = fakeQr(4, 29);
await writeFile(path.join(cache, 'qrcode.png'), qrOld);
const seedPath = path.join(napDir, 'seed.png');
await writeFile(seedPath, qrNew);

// 假启动脚本：2 秒后把 seed.png 覆盖进 cache/qrcode.png，并写一个标记文件
const bat = [
  '@echo off',
  'ping -n 3 127.0.0.1 >nul', // 约 2 秒，不依赖 timeout 的交互行为
  `copy /y "${seedPath}" "${path.join(cache, 'qrcode.png')}" >nul`,
  `echo launched> "${path.join(napDir, 'launched.txt')}"`,
  'exit /b 0',
].join('\r\n');
await writeFile(path.join(napDir, 'start-napcat-A.bat'), bat + '\r\n');

const old = (await api('/api/settings')).qqNapCatDir;
await putSettings({ qqNapCatDir: napDir });
await new Promise(r => setTimeout(r, 300));

let failed = [];
const check = (name, cond, extra = '') => { if (!cond) failed.push(name); console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); };

try {
  const before = await api('/api/napcat/qr');
  check('起手读到旧码', !!before.qr, before.qr && before.qr.hash);
  check('旧码被标成过期（造的是 21 格新图，但 mtime 是现在 → fresh 应为 true）',
    !!before.qr && before.qr.fresh === true, 'fresh=' + (before.qr && before.qr.fresh));

  const t0 = Date.now();
  const r = await api('/api/napcat/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const ms = Date.now() - t0;
  check('restart 返回 ok', r.ok === true, `${ms}ms`);
  check('重跑了启动脚本', !!r.launcher, r.launcher);
  check('等到了新码（rebuilt）', r.rebuilt === true, JSON.stringify(r.qr));

  const launched = await readFile(path.join(napDir, 'launched.txt'), 'utf8').then(t => t.includes('launched')).catch(() => false);
  check('启动脚本确实执行了（标记文件在）', launched);

  const after = await api('/api/napcat/qr');
  check('接口读到的 hash 变了', before.qr.hash !== after.qr.hash, `${before.qr.hash} → ${after.qr.hash}`);
  check('新码尺寸变了（21 格 → 29 格）', after.qr.size !== before.qr.size, `${before.qr.size}B → ${after.qr.size}B`);
  check('新码是新鲜的', after.qr.fresh === true);
} finally {
  await putSettings({ qqNapCatDir: old });
  await rm(work, { recursive: true, force: true });
  console.log('已还原 qqNapCatDir 并清掉假 NapCat 目录');
}
console.log(failed.length ? '失败：' + failed.join('、') : '全部通过');
process.exit(failed.length ? 1 : 0);
