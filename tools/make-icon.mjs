// 生成应用图标：用 dsh-whale-widget 的图标当底图，做成多尺寸 .ico
// 用法：node tools/make-icon.mjs [源图]
//   默认源图：%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-whale-widget\icon.png
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || 'D:\\ffmpeg-9.0-full_build\\bin\\ffmpeg.exe';
const OUT_DIR = path.resolve('assets');
const SRC_DEFAULT = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-whale-widget', 'icon.png');
const SRC = process.argv[2] || SRC_DEFAULT;

if (!existsSync(SRC)) { console.error('找不到源图：', SRC); process.exit(1); }
await mkdir(OUT_DIR, { recursive: true });

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const pngs = [];
for (const s of SIZES) {
  const out = path.join(OUT_DIR, `icon-${s}.png`);
  await run(FFMPEG, [
    '-y', '-v', 'error', '-i', SRC,
    '-vf', `scale=${s}:${s}:flags=lanczos`,
    '-frames:v', '1', out,
  ], { timeout: 60000 });
  pngs.push({ size: s, file: out, buf: await readFile(out) });
  console.log(`画好 ${s}×${s}`);
}
// 顺手留一张 256 的预览和圆角版，方便肉眼确认
await copyFile(path.join(OUT_DIR, 'icon-256.png'), path.join(OUT_DIR, 'icon-preview.png'));

// 打包 ICO：每个尺寸一条 directory entry，数据直接内嵌 PNG（Vista+ 支持）
const count = pngs.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(count, 4);
const entries = Buffer.alloc(16 * count);
let offset = 6 + 16 * count;
pngs.forEach((p, i) => {
  const b = i * 16;
  entries.writeUInt8(p.size >= 256 ? 0 : p.size, b + 0);
  entries.writeUInt8(p.size >= 256 ? 0 : p.size, b + 1);
  entries.writeUInt8(0, b + 2);              // 调色板
  entries.writeUInt8(0, b + 3);              // 保留
  entries.writeUInt16LE(1, b + 4);           // planes
  entries.writeUInt16LE(32, b + 6);          // bpp
  entries.writeUInt32LE(p.buf.length, b + 8);
  entries.writeUInt32LE(offset, b + 12);
  offset += p.buf.length;
});
const ico = Buffer.concat([header, entries, ...pngs.map(p => p.buf)]);
await writeFile(path.join(OUT_DIR, 'app.ico'), ico);
console.log(`assets/app.ico 写好了：${SIZES.length} 个尺寸，${Math.round(ico.length / 1024)} KB`);
