// 测 /api/import/preview：三种样本各自的识别结论，以及「预览不落库」。
// 用法：node tools/import-preview-test.mjs [BASE]
// 注意：会建临时 zip / json / md，全部在系统临时目录里，测完删掉；不会写进 conversation 数据。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:8799';
const tmp = mkdtempSync(join(tmpdir(), 'dsimp-'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function state() {
  const r = await fetch(`${BASE}/api/state`);
  if (!r.ok) throw new Error(`/api/state ${r.status}`);
  return r.json();
}

async function preview(name, buf) {
  const r = await fetch(`${BASE}/api/import/preview?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buf,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

function makeZip(file, entryName, text) {
  const data = Buffer.from(text, 'utf8');
  const nameBuf = Buffer.from(entryName, 'utf8');
  const crc = (() => {
    let c = ~0;
    for (const b of data) {
      c ^= b;
      for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  })();

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);

  const head = Buffer.concat([local, nameBuf, data]);
  const cen = Buffer.concat([central, nameBuf]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(cen.length, 12);
  end.writeUInt32LE(head.length, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([head, cen, end]);
}

const bundle = {
  conversations: [
    { title: '预览试验甲', messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '在' }] },
    { title: '预览试验乙', messages: [{ role: 'user', content: '第二段' }] },
  ],
};

try {
  console.log(`目标: ${BASE}\n`);

  const before = await state();
  const convBefore = (before.conversations || []).length;

  console.log('1) JSON 整包（单个 .json 直传）');
  {
    const buf = Buffer.from(JSON.stringify(bundle), 'utf8');
    const { status, data } = await preview('bundle.json', buf);
    check('HTTP 200', status === 200, `status=${status}`);
    check('ok=true', data.ok === true);
    check('kind=bundle', data.kind === 'bundle', `kind=${data.kind}`);
    check('label 是中文', data.label === '对话 JSON 整包', `label=${data.label}`);
    check('认出 2 个对话', data.count === 2, `count=${data.count}`);
    check('消息合计 3', data.totals?.messages === 3, `messages=${data.totals?.messages}`);
    check('预览里带标题', (data.conversations || []).map(c => c.title).join(',') === '预览试验甲,预览试验乙');
    check('文件大小回报', data.size === buf.length, `size=${data.size}`);
  }

  console.log('\n2) 同样的整包，装进 .zip');
  {
    const zip = makeZip('x', 'export/bundle.json', JSON.stringify(bundle));
    const { status, data } = await preview('export.zip', zip);
    check('HTTP 200', status === 200, `status=${status}`);
    check('kind=bundle', data.kind === 'bundle', `kind=${data.kind}`);
    check('认出 2 个对话', data.count === 2, `count=${data.count}`);
  }

  console.log('\n3) 普通资料压缩包');
  {
    const zip = makeZip('x', 'notes/readme.md', '# 说明\n\n这是一个资料包的正文。');
    const { status, data } = await preview('notes.zip', zip);
    check('HTTP 200', status === 200, `status=${status}`);
    check('kind=archive', data.kind === 'archive', `kind=${data.kind}`);
    check('label 是资料包', data.label === '资料包 / 单个文件', `label=${data.label}`);
    check('至少 1 条材料会话', data.count >= 1, `count=${data.count}`);
    check('统计里有 files', Number(data.totals?.files) >= 1, `files=${data.totals?.files}`);
  }

  console.log('\n4) 单个 markdown');
  {
    const buf = Buffer.from('# 单文件\n\n正文一段。\n', 'utf8');
    const { data } = await preview('single.md', buf);
    check('kind=archive', data.kind === 'archive', `kind=${data.kind}`);
    check('count=1', data.count === 1, `count=${data.count}`);
  }

  console.log('\n5) 不认识的东西要给出理由');
  {
    const bin = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const { status, data } = await preview('blob.bin', bin);
    check('HTTP 仍 200（便于前端展示原因）', status === 200, `status=${status}`);
    check('ok=false', data.ok === false);
    check('带 error 文案', typeof data.error === 'string' && data.error.length > 0, `error=${data.error}`);
  }

  console.log('\n6) 预览不落库');
  {
    const after = await state();
    const convAfter = (after.conversations || []).length;
    check('会话数没变', convAfter === convBefore, `${convBefore} → ${convAfter}`);
  }

  // 静态检查：接口与前端接线在位
  console.log('\n7) 接线检查');
  {
    const { readFileSync } = await import('node:fs');
    const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
    check('前端有 openImportPage', app.includes('async function openImportPage'));
    check('前端调预览接口', app.includes('/api/import/preview'));
    check('底栏有导入按钮', html.includes('id="importNavBtn"'));
    check('导入页样式在位', css.includes('.imp-drop') && css.includes('.imp-tips'));
    check('拖任何页面都先进导入页', app.includes('addImportFiles(e.dataTransfer.files)'));
  }
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
