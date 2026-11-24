// 一次性：把 QQ 那边的历史图片补进已有会话（修复前收的只有 [图片] 文本，没下载过文件）
// 用法：node tools/_backfill-qq-images.mjs [convId] [--apply]
// 不加 --apply 只打印计划，不动文件。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const DATA = path.resolve(process.env.DSAPP_DATA || 'dist/DeepSeek-win32-x64/data');
const CONV_DIR = path.join(DATA, 'conversations');
const UP_DIR = path.join(DATA, 'uploads');
const settings = JSON.parse(await fsp.readFile(path.join(DATA, 'settings.json'), 'utf8'));
const convId = process.argv[2] || settings.qqConvId;
const APPLY = process.argv.includes('--apply');
// 和 effQqConfig 一个口径：没显式配地址就走隔离实例的端口（3200），不是 DSH 那个 3000
const rawBase = String(settings.qqBaseUrl || '').replace(/\/+$/, '');
const baseUrl = (!rawBase || rawBase === 'http://127.0.0.1:3000')
  ? `http://127.0.0.1:${settings.napcatHttpPort || 3200}`
  : rawBase;

const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp' };

async function ob(action, params) {
  const r = await fetch(`${baseUrl}/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (j.retcode) throw new Error(`${action}: ${j.retcode} ${j.message || ''}`);
  return j.data;
}

async function imageBytes(ref) {
  if (/^https?:/i.test(ref)) {
    const r = await fetch(ref, { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://im.qq.com/' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    return { buf: Buffer.from(await r.arrayBuffer()), mime: String(r.headers.get('content-type') || '').split(';')[0] };
  }
  const d = await ob('get_image', { file: ref }).catch(() => null);
  const p = String((d && (d.file || d.path || d.url)) || '');
  if (!p) return null;
  if (/^https?:/i.test(p)) return imageBytes(p);
  try { return { buf: await fsp.readFile(p), mime: '' }; } catch { return null; }
}

const fmt = (sec) => {
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const peer = Number(settings.qqUid || 0);
if (!peer) throw new Error('设置里没有 qqUid');
const hist = await ob('get_friend_msg_history', { user_id: peer, count: 50, message_seq: 0 });
const msgs = hist.messages || [];
const withImg = msgs.filter(m => Array.isArray(m.message) && m.message.some(s => s.type === 'image'));
console.log(`历史 ${msgs.length} 条，带图 ${withImg.length} 条`);

const convFile = path.join(CONV_DIR, `${convId}.json`);
const conv = JSON.parse(await fsp.readFile(convFile, 'utf8'));
let added = 0;

for (const m of withImg) {
  const stamp = fmt(m.time);
  const target = conv.messages.find(x => x.role === 'user' && String(x.content || '').includes(stamp));
  if (!target) { console.log(`  跳过 ${stamp}：会话里没找到对应消息`); continue; }
  if ((target.attachments || []).length) { console.log(`  跳过 ${stamp}：已经有附件`); continue; }
  const atts = [];
  for (const seg of m.message.filter(s => s.type === 'image')) {
    const ref = String(seg.data?.file || seg.data?.url || '');
    const got = await imageBytes(ref);
    if (!got?.buf?.length) { console.log(`  ${stamp} 有一张拉不到：${ref.slice(0, 60)}`); continue; }
    let mime = got.mime in EXT ? got.mime : '';
    if (!mime) mime = got.buf.slice(0, 4).toString('hex') === '89504e47' ? 'image/png' : 'image/jpeg';
    const uploadId = `u_bf${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${EXT[mime]}`;
    if (APPLY) await fsp.writeFile(path.join(UP_DIR, uploadId), got.buf);
    atts.push({ kind: 'image', name: `QQ-历史-${atts.length + 1}${EXT[mime]}`, mime, size: got.buf.length, uploadId, url: `/api/uploads/${uploadId}` });
  }
  if (!atts.length) continue;
  target.attachments = atts;
  added += atts.length;
  console.log(`  ${stamp} → 补 ${atts.length} 张（${atts.map(a => a.uploadId).join(', ')}）`);
  if (APPLY) await fsp.writeFile(convFile, JSON.stringify(conv, null, 2));
}

console.log(`\n${APPLY ? '已写盘' : '演练'}：补了 ${added} 张，会话 ${convId}`);
if (!APPLY) console.log('加 --apply 真写');
