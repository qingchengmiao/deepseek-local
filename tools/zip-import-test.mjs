// 拖入压缩包 → 整理为对话：端到端自测（不起外部依赖，自带最小 ZIP 写入器）
//
// 覆盖三种包：
//   1. 官方 App 导出（chat_session_index.json + chat_sessions/*.json + 附件）
//   2. 本应用的 JSON 整包（{ conversations: [...] }）
//   3. 任意资料包（按顶层目录分组）
// 外加：重复导入同名会话要替换、附件要真的落到 data/media 下、非文本包要报错。
//
// 用法：node tools/zip-import-test.mjs [port]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PORT = Number(process.argv[2] || 8912);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.log(`  ✗ ${label}${extra ? ` —— ${extra}` : ''}`); }
}

// ---------------------------------------------------------------- 最小 ZIP 写入器

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** store（不压缩）的 zip：够测试用，避免引入依赖 */
function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 名
    local.writeUInt16LE(0, 8); // store
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(body.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const cenBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cenBuf, eocd]);
}

// ---------------------------------------------------------------- 三个样本包

function exportZip() {
  const index = [{ id: 's1', title: '导出的对话', updated_at: '2026-11-20T10:00:00Z' }];
  const session = {
    id: 's1',
    title: '导出的对话',
    inserted_at: '2026-11-20T09:00:00Z',
    updated_at: '2026-11-20T10:00:00Z',
    messages: [
      { role: 'USER', inserted_at: '2026-11-20T09:00:00Z', fragments: [{ type: 'REQUEST', content: '看看这张图说了什么' }] },
      {
        role: 'ASSISTANT',
        inserted_at: '2026-11-20T09:00:05Z',
        fragments: [
          { type: 'THINK', content: '先看图。' },
          { type: 'FILE', files: [{ file_name: 'pic.png', is_image: true, export_path: 'files/s1/pic.png' }] },
          { type: 'RESPONSE', content: '图上写着 hello。' },
        ],
      },
    ],
  };
  return makeZip({
    'chat_session_index.json': JSON.stringify(index),
    'chat_sessions/s1.json': JSON.stringify(session),
    'files/s1/pic.png': Buffer.from('89504e470d0a1a0a', 'hex'),
  });
}

function bundleZip() {
  return makeZip({
    'export/bundle.json': JSON.stringify({
      conversations: [
        { title: '整包会话 A', messages: [{ role: 'user', content: '第一条' }, { role: 'assistant', content: '第二条' }] },
        { title: '整包会话 B', messages: [{ role: 'user', content: '只有一条' }] },
      ],
    }),
  });
}

function archiveZip() {
  return makeZip({
    'docs/说明.md': '# 说明\n这是资料包里的说明文档。\n',
    'docs/放这里.txt': '纯文本一',
    'src/main.js': "console.log('hi');\n",
    'src/util.py': 'print("hi")\n',
    'pics/a.png': Buffer.from('89504e470d0a1a0a', 'hex'),
    'big/empty.md': '',
  });
}

function binaryOnlyZip() {
  return makeZip({ 'a.bin': Buffer.from([0, 1, 2, 3]), 'b.png': Buffer.from('89504e47', 'hex') });
}

// ---------------------------------------------------------------- 起隔离服务

async function waitUp(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/state`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ds-zipimport-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--desktop'], {
    cwd: ROOT,
    env: { ...process.env, DSAPP_DATA: dataDir, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (b) => logs.push(b.toString()));
  child.stderr.on('data', (b) => logs.push(b.toString()));

  try {
    if (!await waitUp()) throw new Error(`服务没起来：\n${logs.join('')}`);
    console.log(`隔离服务已就绪 ${BASE}（数据目录 ${dataDir}）\n`);

    const post = async (name, buf) => {
      const r = await fetch(`${BASE}/api/import/zip?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf,
      });
      return { status: r.status, body: await r.json() };
    };
    const conv = async (id) => {
      const r = await fetch(`${BASE}/api/conversations/${id}`);
      return r.ok ? r.json() : null;
    };

    // ---- 1. 官方导出
    console.log('① 官方 App 导出包');
    const r1 = await post('deepseek-export.zip', exportZip());
    ok(r1.status === 200, `返回 200（实际 ${r1.status} ${JSON.stringify(r1.body).slice(0, 120)}）`);
    ok(r1.body.kind === 'deepseek-export', `识别成 deepseek-export（实际 ${r1.body.kind}）`);
    ok(r1.body.imported?.length === 1 && r1.body.imported[0].title === '导出的对话', '导入了 1 个会话「导出的对话」');
    ok(r1.body.totals?.images === 1, `统计里图片 1 张（实际 ${r1.body.totals?.images}）`);
    const c1 = await conv(r1.body.imported[0].id);
    const msgs1 = c1?.messages || c1?.conversation?.messages || [];
    ok(msgs1.length === 2, `会话里有 2 条消息（实际 ${msgs1.length}）`);
    ok(msgs1[1]?.reasoning?.includes('先看图'), '思考内容保留成 reasoning');
    const att1 = msgs1[1]?.attachments?.[0];
    ok(att1?.kind === 'image' && /^\/api\/media\/imported-s1\/pic\.png$/.test(att1?.url || ''), `附件 URL 正确（${att1?.url}）`);
    const attDisk = path.join(dataDir, 'media', 'imported-s1', 'pic.png');
    ok(fs.existsSync(attDisk), '附件真的落盘了');
    const attRes = await fetch(`${BASE}${att1?.url || ''}`);
    ok(attRes.ok, `附件能通过 /api/media 取回（${attRes.status}）`);

    // ---- 2. 重复导入同名会话 → 替换
    console.log('\n② 重复导入同名会话（应替换）');
    const r2 = await post('deepseek-export.zip', exportZip());
    ok(r2.status === 200 && r2.body.replaced?.length === 1, `替换了 1 个（实际 ${r2.body.replaced?.length}）`);
    const idx = r2.body.conversations || [];
    ok(idx.filter((c) => c.title === '导出的对话').length === 1, '会话列表里仍然只有一个「导出的对话」');

    // ---- 3. JSON 整包
    console.log('\n③ JSON 整包包');
    const r3 = await post('bundle.zip', bundleZip());
    ok(r3.status === 200, `返回 200（实际 ${r3.status}）`);
    ok(r3.body.kind === 'bundle', `识别成 bundle（实际 ${r3.body.kind}）`);
    ok(r3.body.imported?.length === 2, `导入了 2 个会话（实际 ${r3.body.imported?.length}）`);
    const titles3 = (r3.body.imported || []).map((x) => x.title).sort();
    ok(titles3.join(',') === '整包会话 A,整包会话 B', `标题正确：${titles3.join(' / ')}`);

    // ---- 4. 任意资料包 → 按目录分组
    console.log('\n④ 任意资料包（docs/ + src/ → 2 组）');
    const r4 = await post('资料包.zip', archiveZip());
    ok(r4.status === 200, `返回 200（实际 ${r4.status}）`);
    ok(r4.body.kind === 'archive', `识别成 archive（实际 ${r4.body.kind}）`);
    ok(r4.body.imported?.length === 2, `分成 2 个会话（实际 ${r4.body.imported?.length}）`);
    const c4 = await conv(r4.body.imported[0].id);
    const text4 = (c4?.messages || c4?.conversation?.messages || []).map((m) => m.content).join('\n');
    ok(/【资料包 · (docs|src)】/.test(text4), '首条消息带「【资料包 · 分组】」标题');
    ok(/说明\.md|main\.js/.test(text4), '正文里列出了文件名与实际内容');
    ok(fs.existsSync(path.join(dataDir, 'conversations')), '会话已写入隔离数据目录');

    // ---- 5. 纯二进制包 → 明确报错
    console.log('\n⑤ 只有图片/二进制的包');
    const r5 = await post('only-binary.zip', binaryOnlyZip());
    ok(r5.status === 400 && /没有可读的文本文件/.test(r5.body.error || ''), `拒绝并给原因（${r5.status} ${r5.body.error}）`);

    // ---- 6. 单个文本文件也能拖
    console.log('\n⑥ 拖一个 .md 进来');
    const r6 = await post('笔记.md', Buffer.from('# 笔记\n这里是一段内容。\n'));
    ok(r6.status === 200 && r6.body.imported?.length === 1, `当成材料导入了 1 个会话（${r6.status}）`);
    ok(r6.body.imported?.[0]?.title === '笔记', `标题取文件名：${r6.body.imported?.[0]?.title}`);
  } finally {
    child.kill();
    await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('测试崩了：', e);
  process.exit(1);
});
