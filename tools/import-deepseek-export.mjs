// 把官方 App 导出的整包（deepseek_data-YYYY-MM-DD.zip）导进本地应用。
// 用法：
//   node tools/import-deepseek-export.mjs "C:\...\deepseek_data-2026-11-22.zip"
//   node tools/import-deepseek-export.mjs <zip> --dry        只看会导什么，不写
//   node tools/import-deepseek-export.mjs <zip> --no-replace 标题重名时保留旧的、导成新会话
//
// 零依赖：自己读 ZIP 中央目录（zlib.inflateRawSync 解 deflate），图片落到 data/media/imported-<会话id>/。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const MEDIA = path.join('data', 'media');

// ---------------------------------------------------------------- ZIP

function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('这不是 zip（找不到 EOCD）');
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let k = 0; k < total; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compSize, lho });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: () => [...entries.keys()],
    has: n => entries.has(n),
    read(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`zip 里没有 ${name}`);
      const nameLen = buf.readUInt16LE(e.lho + 26);
      const extraLen = buf.readUInt16LE(e.lho + 28);
      const start = e.lho + 30 + nameLen + extraLen;
      const raw = buf.subarray(start, start + e.compSize);
      if (e.method === 0) return Buffer.from(raw);
      if (e.method === 8) return zlib.inflateRawSync(raw);
      throw new Error(`不支持的压缩方式 ${e.method}（${name}）`);
    },
  };
}

// ---------------------------------------------------------------- 映射

function safeName(name) {
  const clean = String(name).replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^_+/, '');
  return clean || 'file.bin';
}

const SKIP_FRAGMENTS = new Set(['TOOL_SEARCH', 'TOOL_OPEN', 'CONTENT_RISK', 'READ_LINK']);

function sessionToConv(session, zip, opts) {
  const id = session.id;
  const mediaId = `imported-${String(id).replace(/[^A-Za-z0-9_-]/g, '')}`;
  const dir = path.join(MEDIA, mediaId);
  const messages = [];
  const stats = { files: 0, images: 0, thinking: 0, tools: 0, risk: 0, template: 0 };
  let pending = null; // 正在拼的 assistant 消息
  const used = new Set();

  const flush = () => {
    if (pending && (pending.content.trim() || pending.reasoning || (pending.attachments || []).length)) messages.push(pending);
    pending = null;
  };

  for (const m of session.messages || []) {
    const role = String(m.role || '').toUpperCase() === 'USER' ? 'user' : 'assistant';
    const ts = Date.parse(m.inserted_at || m.updated_at || '') || 0;
    for (const f of m.fragments || []) {
      if (f.type === 'REQUEST') {
        if (!pending || pending.role !== 'user') {
          flush();
          pending = { role: 'user', content: '', createdAt: ts || session.inserted_at };
        }
        pending.content = pending.content ? `${pending.content}\n\n${f.content || ''}` : String(f.content || '');
      } else if (f.type === 'RESPONSE' || f.type === 'TEMPLATE_RESPONSE') {
        if (f.type === 'TEMPLATE_RESPONSE') stats.template += 1;
        if (!pending || pending.role !== 'assistant') {
          flush();
          pending = { role: 'assistant', content: '', createdAt: ts || session.updated_at };
        }
        pending.content = pending.content ? `${pending.content}\n\n${f.content || ''}` : String(f.content || '');
      } else if (f.type === 'THINK') {
        stats.thinking += 1;
        if (!pending || pending.role !== 'assistant') {
          flush();
          pending = { role: 'assistant', content: '', createdAt: ts || session.updated_at };
        }
        pending.reasoning = pending.reasoning ? `${pending.reasoning}\n\n${f.content || ''}` : String(f.content || '');
      } else if (f.type === 'FILE') {
        for (const file of f.files || []) {
          stats.files += 1;
          const exportPath = String(file.export_path || '');
          if (!exportPath || !zip.has(exportPath)) continue;
          let name = safeName(file.file_name || path.basename(exportPath));
          if (used.has(name)) name = `${used.size}-${name}`;
          used.add(name);
          if (file.is_image) stats.images += 1;
          if (!opts.dry) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, name), zip.read(exportPath));
          }
          if (!pending || pending.role !== role) {
            flush();
            pending = { role, content: '', createdAt: ts || session.inserted_at };
          }
          pending.attachments = pending.attachments || [];
          pending.attachments.push({
            kind: file.is_image ? 'image' : 'file',
            name: String(file.file_name || name),
            url: `/api/media/${mediaId}/${name}`,
          });
        }
      } else if (SKIP_FRAGMENTS.has(f.type)) {
        stats.tools += 1;
      }
    }
  }
  flush();

  return {
    conv: {
      title: session.title || '导入的对话',
      pinned: !!session.pinned,
      createdAt: Date.parse(session.inserted_at || '') || undefined,
      updatedAt: Date.parse(session.updated_at || '') || undefined,
      source: `导入：${opts.filename}#${id}`,
      messages,
    },
    stats,
    mediaId,
  };
}

// ---------------------------------------------------------------- 主流程

const args = process.argv.slice(2);
const zipPath = args.find(a => !a.startsWith('--'));
if (!zipPath) {
  console.error('用法：node tools/import-deepseek-export.mjs <导出的 zip> [--dry] [--no-replace]');
  process.exit(1);
}
const dry = args.includes('--dry');
const replace = !args.includes('--no-replace');

const buf = fs.readFileSync(zipPath);
const zip = readZip(buf);
console.log(`压缩包：${path.basename(zipPath)}（${(buf.length / 1048576).toFixed(1)} MB，${zip.names().length} 个条目）`);

const index = JSON.parse(zip.read('chat_session_index.json').toString('utf8'));
const opts = { filename: path.basename(zipPath), dry };
const conversations = [];
let totals = { convs: 0, messages: 0, images: 0, files: 0, thinking: 0, tools: 0 };

for (const meta of index) {
  const entry = `chat_sessions/${meta.id}.json`;
  if (!zip.has(entry)) { console.log(`  ! 缺文件：${entry}`); continue; }
  const session = JSON.parse(zip.read(entry).toString('utf8'));
  const { conv, stats } = sessionToConv(session, zip, opts);
  conversations.push(conv);
  totals.convs += 1;
  totals.messages += conv.messages.length;
  totals.images += stats.images;
  totals.files += stats.files - stats.images;
  totals.thinking += stats.thinking;
  totals.tools += stats.tools;
  console.log(`  · ${conv.title} — ${conv.messages.length} 条消息（图片 ${stats.images}，思考段 ${stats.thinking}）`);
}

console.log(`\n共 ${totals.convs} 个会话 / ${totals.messages} 条消息 / 图片 ${totals.images} / 其它附件 ${totals.files} / 跳过工具过程 ${totals.tools}`);
if (dry) { console.log('--dry：什么都没写'); process.exit(0); }

const res = await fetch(BASE + '/api/import', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ filename: opts.filename, replace, conversations }),
});
const out = await res.json();
if (!res.ok) {
  console.error('导入失败：', out.error || out);
  process.exit(1);
}
console.log(`导入成功：${out.imported.length} 个会话${out.replaced?.length ? `，替换重名 ${out.replaced.length} 个（${out.replaced.join('、')}）` : ''}`);
if (out.errors?.length) console.log('有问题的：', out.errors.join(' | '));
