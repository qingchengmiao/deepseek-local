// 技能页：验「拖进来就装」这条链——JSON 直传、单 .md、zip（含子目录）、重名、非法类型、启停、删除、越界 id。
// 手法：临时技能目录（DSAPP_SKILLS）+ 隔离实例，全程不碰真 data/。
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';

const APP = path.resolve('.');
const PORT = Number(process.env.TEST_PORT || 18941);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.resolve('data/_skill_install_test');
const SKILLS = path.join(DATA, 'skills');

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const json = async (p, opt = {}) => {
  const r = await fetch(BASE + p, { headers: { 'Content-Type': 'application/json' }, ...opt });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const raw = async (p, buf, ctype = 'application/octet-stream') => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': ctype }, body: buf });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

/** 最小 zip 写入器：只存不压（method 0），够测解析就行 */
function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.from(f.text, 'utf8');
    const crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (const b of data) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cenBuf, end]);
}

await rm(DATA, { recursive: true, force: true });
await mkdir(SKILLS, { recursive: true });

const srv = spawn(process.execPath, ['server.mjs'], {
  cwd: APP,
  env: { ...process.env, PORT: String(PORT), DSAPP_DATA: DATA, DSAPP_SKILLS: SKILLS },
  stdio: 'ignore',
});
const up = async () => {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(BASE + '/api/skills');
      if (r.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
};

try {
  if (!(await up())) throw new Error('实例没起来');
  console.log('技能安装：');

  // 1 空目录
  let r = await json('/api/skills');
  check('空目录：技能列表为空', r.status === 200 && Array.isArray(r.data.skills) && r.data.skills.length === 0);
  check('空目录：给出技能目录', typeof r.data.dir === 'string' && r.data.dir.length > 0);

  // 2 JSON 直传（贴一段 SKILL.md）
  r = await json('/api/skills', {
    method: 'POST',
    body: JSON.stringify({
      content: '---\nname: 粘贴技能\ndescription: 从 JSON 装进来的 JSONMARK\n---\n\n# 粘贴技能\n\n说话短一点。JSONMARK\n',
    }),
  });
  check('JSON 直传：装成功', r.status === 200 && r.data.ok === true, `id=${r.data.id}`);
  check('JSON 直传：id 用 front matter 的中文名', r.data.id === '粘贴技能', String(r.data.id));
  check('JSON 直传：自动勾上', Array.isArray(r.data.enabledSkills) && r.data.enabledSkills.includes('粘贴技能'));
  check('JSON 直传：文件写进 skills/<id>/SKILL.md',
    (await stat(path.join(SKILLS, '粘贴技能', 'SKILL.md'))).isFile());
  const pasted = await readFile(path.join(SKILLS, '粘贴技能', 'SKILL.md'), 'utf8');
  check('JSON 直传：内容原样落盘', pasted.includes('JSONMARK'));

  // 3 单 .md 上传（文件名当 id）
  r = await raw('/api/skills/upload?name=' + encodeURIComponent('我的技能.md'),
    Buffer.from('# 我的技能\n\n单文件上传 MDMARK\n', 'utf8'));
  check('单 .md：装成功', r.status === 200 && r.data.ok === true, `id=${r.data.id}`);
  check('单 .md：id 用文件名', r.data.id === '我的技能', String(r.data.id));
  const single = await readFile(path.join(SKILLS, '我的技能', 'SKILL.md'), 'utf8');
  check('单 .md：成为 SKILL.md', single.includes('MDMARK'));

  // 4 zip（含子目录 + 附带文件 + __MACOSX 垃圾）
  const zip = makeZip([
    { name: 'zip-skill/SKILL.md', text: '---\nname: 压缩包技能\ndescription: ZIPMARK\n---\n\n# 压缩包技能\n\nZIPMARK 正文\n' },
    { name: 'zip-skill/notes/extra.txt', text: '附带说明 EXTRA' },
    { name: '__MACOSX/._junk', text: 'x' },
  ]);
  r = await raw('/api/skills/upload?name=zip-skill.zip', zip);
  check('zip：装成功', r.status === 200 && r.data.ok === true, `id=${r.data.id} files=${r.data.files}`);
  check('zip：id 取主文件所在目录名', r.data.id === 'zip-skill', String(r.data.id));
  check('zip：带上了子目录里的文件', r.data.files === 2, `files=${r.data.files}`);
  check('zip：子目录文件真的落盘',
    (await stat(path.join(SKILLS, 'zip-skill', 'notes', 'extra.txt'))).isFile());
  r = await json('/api/skills');
  const zipRow = r.data.skills.find(s => s.id === 'zip-skill');
  check('列表：回显 files 计数', Boolean(zipRow) && zipRow.files === 2, `files=${zipRow && zipRow.files}`);
  check('列表：回显 description', Boolean(zipRow) && /ZIPMARK/.test(zipRow.description));

  // 5 重名再加一次
  r = await raw('/api/skills/upload?name=zip-skill.zip', zip);
  check('重名：自动加后缀', r.status === 200 && r.data.id === 'zip-skill-2', String(r.data.id));

  // 6 非法类型
  r = await raw('/api/skills/upload?name=bad.exe', Buffer.from('MZ', 'utf8'));
  check('非法类型：400', r.status === 400 && /不认识/.test(r.data.error || ''), r.data.error || '');

  // 7 路径穿越（zip 里带 ../）
  const evil = makeZip([
    { name: 'evil/SKILL.md', text: '# 正常主文件\n' },
    { name: 'evil/../../../escape.txt', text: 'nope' },
  ]);
  r = await raw('/api/skills/upload?name=evil.zip', evil);
  const escaped = await stat(path.join(DATA, 'escape.txt')).then(() => true).catch(() => false);
  check('路径穿越：没写到技能目录外', escaped === false, `status=${r.status}`);

  // 8 停用 / 启用
  r = await json('/api/skills/enable', { method: 'POST', body: JSON.stringify({ id: '我的技能', enabled: false }) });
  check('停用：从 enabledSkills 移除', r.status === 200 && !r.data.enabledSkills.includes('我的技能'));
  r = await json('/api/skills');
  check('停用：列表里 enabled=false', r.data.skills.find(s => s.id === '我的技能').enabled === false);
  r = await json('/api/skills/enable', { method: 'POST', body: JSON.stringify({ id: '我的技能', enabled: true }) });
  check('启用：加回去', r.status === 200 && r.data.enabledSkills.includes('我的技能'));
  r = await json('/api/skills/enable', { method: 'POST', body: JSON.stringify({ id: '不存在的', enabled: true }) });
  check('启用不存在的：404', r.status === 404, `status=${r.status}`);

  // 9 删除
  r = await json('/api/skills/delete', { method: 'POST', body: JSON.stringify({ id: 'zip-skill-2' }) });
  check('删除：成功', r.status === 200 && r.data.ok === true);
  check('删除：目录没了', await stat(path.join(SKILLS, 'zip-skill-2')).then(() => false).catch(() => true));
  check('删除：从 enabledSkills 剔除', !r.data.enabledSkills.includes('zip-skill-2'));
  r = await json('/api/skills/delete', { method: 'POST', body: JSON.stringify({ id: 'zip-skill-2' }) });
  check('删不存在的：404', r.status === 404, `status=${r.status}`);

  // 10 越界 id
  r = await json('/api/skills/delete', { method: 'POST', body: JSON.stringify({ id: '../..' }) });
  check('越界 id：400', r.status === 400, r.data.error || '');
  const outside = await stat(path.join(APP, 'server.mjs')).then(() => true).catch(() => false);
  const dataKept = await stat(path.join(DATA, 'settings.json')).then(() => true).catch(() => true);
  check('越界 id：没删到外面文件', outside === true && dataKept === true);

  // 11 空内容
  r = await json('/api/skills', { method: 'POST', body: JSON.stringify({ content: '   ' }) });
  check('空内容：400', r.status === 400, r.data.error || '');

  console.log(`\n技能安装：${pass} 通过 / ${fail} 失败`);
} catch (e) {
  console.error('炸了：', e.message);
  fail += 1;
} finally {
  try { srv.kill(); } catch {}
  await new Promise(r => setTimeout(r, 400));
  await rm(DATA, { recursive: true, force: true }).catch(() => {});
  process.exit(fail ? 1 : 0);
}
