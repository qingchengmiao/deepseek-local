// 压缩包 → 对话：拖进来的 zip 在这里被拆开、认类型、整理成可以直接接着聊的会话。
//
// 三种类型：
//   1. deepseek-export  官方 App 导出的整套（chat_session_index.json + chat_sessions/*.json + 附件）
//   2. bundle           本应用或别人导出的 JSON 整包（{ conversations: [...] } 或会话数组）
//   3. archive          其它任意压缩包 —— 按顶层目录分组，把文本文件整理成材料会话
//
// 零依赖：自己读 ZIP 中央目录（deflate 用 zlib.inflateRawSync）。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

/** 类型 → 人话，导入页和 toast 共用 */
export const KIND_LABEL = {
  'deepseek-export': 'DeepSeek 导出包',
  bundle: '对话 JSON 整包',
  archive: '资料包 / 单个文件',
};

/** 读 ZIP：返回 names()/has()/read()/size()，够本地用 */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('这不是 zip（找不到 EOCD）');
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let k = 0; k < total; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (!name.endsWith('/')) entries.set(name, { method, compSize, size, lho });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    count: entries.size,
    names: () => [...entries.keys()],
    has: (n) => entries.has(n),
    size: (n) => entries.get(n)?.size || 0,
    read(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`zip 里没有 ${name}`);
      const nameLen = buf.readUInt16LE(e.lho + 26);
      const extraLen = buf.readUInt16LE(e.lho + 28);
      const start = e.lho + 30 + nameLen + extraLen;
      const raw = buf.subarray(start, start + e.compSize);
      if (e.method === 0) return Buffer.from(raw);
      if (e.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: 64 * 1024 * 1024 });
      throw new Error(`不支持的压缩方式 ${e.method}（${name}）`);
    },
  };
}

/** 文本类文件才值得读进对话 */
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.log', '.rst',
  '.html', '.htm', '.xml', '.yml', '.yaml', '.ini', '.toml', '.conf', '.env',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.c', '.h', '.cpp', '.hpp',
  '.java', '.kt', '.swift', '.php', '.sh', '.ps1', '.bat', '.sql', '.css', '.scss', '.tex',
]);

const TEXT_NAME = /(^|\/)(readme|license|changelog|notice|authors)(\.|$)/i;

function isTextEntry(name) {
  const base = path.basename(name);
  if (base.startsWith('.')) return false;
  if (/\.(png|jpe?g|gif|webp|bmp|ico|svg|mp3|wav|m4a|mp4|mov|webm|zip|7z|rar|gz|pdf|docx?|xlsx?|pptx?|exe|dll|bin|so|dylib)$/i.test(base)) {
    return false;
  }
  if (TEXT_EXT.has(path.extname(base).toLowerCase())) return true;
  return TEXT_NAME.test(name);
}

function safeName(name) {
  const clean = String(name).replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^_+/, '');
  return clean || 'file.bin';
}

function decodeText(buf) {
  const head = buf.subarray(0, 4);
  if (head[0] === 0xff && head[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (head[0] === 0xfe && head[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  let text = buf.toString('utf8');
  if (text.includes('\uFFFD')) {
    try { text = new TextDecoder('gb18030').decode(buf); } catch { /* 保持 utf8 */ }
  }
  return text;
}

function clip(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n…（后面还有 ${text.length - max} 字）`;
}

// ------------------------------------------------------------ 官方 App 导出

const SKIP_FRAGMENTS = new Set(['TOOL_SEARCH', 'TOOL_OPEN', 'CONTENT_RISK', 'READ_LINK']);

function sessionToConv(session, zip, { filename, mediaRoot, dryRun = false }) {
  const id = session.id;
  const mediaId = `imported-${String(id).replace(/[^A-Za-z0-9_-]/g, '')}`;
  const dir = path.join(mediaRoot, mediaId);
  const messages = [];
  const stats = { files: 0, images: 0, thinking: 0, tools: 0 };
  let pending = null;
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
        if (!pending || pending.role !== 'user') { flush(); pending = { role: 'user', content: '', createdAt: ts || session.inserted_at }; }
        pending.content = pending.content ? `${pending.content}\n\n${f.content || ''}` : String(f.content || '');
      } else if (f.type === 'RESPONSE' || f.type === 'TEMPLATE_RESPONSE') {
        if (!pending || pending.role !== 'assistant') { flush(); pending = { role: 'assistant', content: '', createdAt: ts || session.updated_at }; }
        pending.content = pending.content ? `${pending.content}\n\n${f.content || ''}` : String(f.content || '');
      } else if (f.type === 'THINK') {
        stats.thinking += 1;
        if (!pending || pending.role !== 'assistant') { flush(); pending = { role: 'assistant', content: '', createdAt: ts || session.updated_at }; }
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
          if (dryRun) continue;
          try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, name), zip.read(exportPath));
          } catch { continue; }
          if (!pending || pending.role !== role) { flush(); pending = { role, content: '', createdAt: ts || session.inserted_at }; }
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
      source: `导入：${filename}#${id}`,
      messages,
    },
    stats,
  };
}

function deepseekExport(zip, { filename, mediaRoot, dryRun = false }) {
  const index = JSON.parse(zip.read('chat_session_index.json').toString('utf8'));
  const conversations = [];
  const totals = { convs: 0, messages: 0, images: 0, files: 0, thinking: 0, tools: 0 };
  for (const meta of Array.isArray(index) ? index : []) {
    const entry = `chat_sessions/${meta.id}.json`;
    if (!zip.has(entry)) continue;
    const session = JSON.parse(zip.read(entry).toString('utf8'));
    const { conv, stats } = sessionToConv(session, zip, { filename, mediaRoot, dryRun });
    if (!conv.messages.length) continue;
    conversations.push(conv);
    totals.convs += 1;
    totals.messages += conv.messages.length;
    totals.images += stats.images;
    totals.files += stats.files - stats.images;
    totals.thinking += stats.thinking;
    totals.tools += stats.tools;
  }
  return { kind: 'deepseek-export', conversations, totals };
}

// ------------------------------------------------------------ 本应用的 JSON 整包

function collectBundle(node, out, depth = 0) {
  if (!node || depth > 3) return;
  if (Array.isArray(node)) {
    for (const item of node) collectBundle(item, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  if (Array.isArray(node.conversations)) { out.push(...node.conversations); return; }
  if (Array.isArray(node.messages) && (node.title || node.id)) { out.push(node); return; }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object' && (v.conversations || v.messages)) collectBundle(v, out, depth + 1);
  }
}

function bundleFromValue(parsed) {
  const convs = [];
  collectBundle(parsed, convs);
  if (!convs.length) return null;
  const conversations = convs.map((c) => ({
    title: String(c.title || c.name || '导入的对话').slice(0, 80),
    messages: (Array.isArray(c.messages) ? c.messages : []).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content ?? m.text ?? ''),
      reasoning: m.reasoning ? String(m.reasoning) : undefined,
      createdAt: Number(m.createdAt || 0) || undefined,
    })).filter((m) => m.content.trim() || m.reasoning),
    createdAt: Number(c.createdAt || 0) || undefined,
    updatedAt: Number(c.updatedAt || 0) || undefined,
    pinned: !!c.pinned,
    source: c.source ? String(c.source).slice(0, 200) : undefined,
  })).filter((c) => c.messages.length);
  if (!conversations.length) return null;
  return { kind: 'bundle', conversations, totals: { convs: conversations.length, messages: conversations.reduce((n, c) => n + c.messages.length, 0) } };
}

// ------------------------------------------------------------ 任意压缩包 → 材料会话

function bundleFromJson(zip, name) {
  let parsed;
  try { parsed = JSON.parse(zip.read(name).toString('utf8')); } catch { return null; }
  return bundleFromValue(parsed);
}

const MAX_FILES = 60;
const MAX_CHARS_PER_FILE = 6000;
const MAX_CHARS_PER_CONV = 40000;

function groupOf(name) {
  const parts = name.split('/').filter(Boolean);
  if (parts.length <= 1) return '';
  return parts[0];
}

function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function buildMaterialConversation(title, entries, zip, { filename }) {
  let budget = MAX_CHARS_PER_CONV;
  const chunks = [];
  const listing = entries.map((e) => `· ${e.name}（${humanSize(e.size)}）`).join('\n');
  chunks.push(`【${title}】\n来自压缩包 ${filename}，共 ${entries.length} 个文本文件：\n${listing}`);
  for (const e of entries) {
    if (budget <= 400) {
      chunks.push(`\n…（后面还有 ${entries.length - chunks.length + 1} 个文件没展开，先按目录看）`);
      break;
    }
    let text = '';
    try { text = decodeText(zip.read(e.name)); } catch { text = '（读不出来，可能是二进制）'; }
    text = clip(text.trim(), Math.min(MAX_CHARS_PER_FILE, budget));
    budget -= text.length;
    chunks.push(`\n—— ${e.name} ——\n${text || '（空文件）'}`);
  }
  return {
    title: title.slice(0, 80),
    source: `压缩包：${filename}`,
    messages: [{ role: 'user', content: chunks.join('\n') }],
  };
}

function archiveToConversations(zip, { filename }) {
  const names = zip.names().filter((n) => isTextEntry(n) && zip.size(n) > 0).sort();
  if (!names.length) throw new Error('这个压缩包里没有可读的文本文件（只有图片/文档/二进制？）');
  const picked = names.slice(0, MAX_FILES).map((name) => ({ name, size: zip.size(name) }));
  const base = path.basename(filename, path.extname(filename)).slice(0, 40) || '资料包';

  const groups = new Map();
  for (const e of picked) {
    const g = groupOf(e.name);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }
  const useGroups = groups.size >= 2 && groups.size <= 6 && ![...groups.keys()].includes('');
  const conversations = [];
  if (useGroups) {
    for (const [g, entries] of groups) conversations.push(buildMaterialConversation(`${base} · ${g}`, entries, zip, { filename }));
  } else {
    conversations.push(buildMaterialConversation(base, picked, zip, { filename }));
  }
  return {
    kind: 'archive',
    conversations,
    totals: { convs: conversations.length, messages: conversations.length, files: picked.length, skipped: names.length - picked.length },
  };
}

// ------------------------------------------------------------ 入口

/**
 * 把一个拖进来的包整理成会话数组。
 * @param {Buffer} buf 原始字节
 * @param {string} filename 原始文件名（带扩展名）
 * @param {string} mediaRoot 附件落盘根目录（data/media）
 */
export function organizeArchive(buf, filename, mediaRoot, opts = {}) {
  const dryRun = !!opts.dryRun;
  let zip = null;
  let zipError = null;
  try { zip = readZip(buf); } catch (e) { zipError = e; }

  if (zip) {
    if (zip.has('chat_session_index.json')) return deepseekExport(zip, { filename, mediaRoot, dryRun });
    const jsonNames = zip.names().filter((n) => /\.json$/i.test(n) && zip.size(n) < 40 * 1024 * 1024).slice(0, 12);
    for (const name of jsonNames) {
      const bundle = bundleFromJson(zip, name);
      if (bundle) return bundle;
    }
    return archiveToConversations(zip, { filename });
  }

  // 不是 zip：先看是不是「对话 JSON」（本应用整包 / 官方导出数组 / 单个会话）
  const text = decodeText(buf).trim();
  if (/^[[{]/.test(text)) {
    try {
      const bundle = bundleFromValue(JSON.parse(text));
      if (bundle) return bundle;
    } catch { /* 不是合法 JSON，按普通材料处理 */ }
  }

  // 剩下的当一份材料
  if (isTextEntry(filename)) {
    const clipped = clip(text, MAX_CHARS_PER_CONV);
    return {
      kind: 'archive',
      conversations: [{
        title: path.basename(filename, path.extname(filename)).slice(0, 60) || '拖进来的材料',
        source: `拖入：${filename}`,
        messages: [{ role: 'user', content: `【材料 · ${filename}】\n${clipped || '（空文件）'}` }],
      }],
      totals: { convs: 1, messages: 1, files: 1 },
    };
  }
  throw new Error(zipError ? `读不了这个压缩包：${zipError.message}` : '不支持这种文件');
}

/** 识别但不落库：导入页拿它做「这是什么、会生成什么」的预览 */
export function previewArchive(buf, filename) {
  const organized = organizeArchive(buf, filename, '', { dryRun: true });
  const totals = organized.totals || {};
  const list = (organized.conversations || []).map((c) => ({
    title: String(c.title || '未命名').slice(0, 80),
    count: (c.messages || []).length,
  }));
  return {
    kind: organized.kind,
    label: KIND_LABEL[organized.kind] || organized.kind,
    totals,
    conversations: list.slice(0, 12),
    more: Math.max(0, list.length - 12),
    count: list.length,
  };
}
