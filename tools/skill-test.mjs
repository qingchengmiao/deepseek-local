// 技能包：验 skills/<id>/SKILL.md 真的被注入到 system，而且只注入勾上的那些。
// 手法：临时技能目录（DSAPP_SKILLS）+ 假上游（记请求体）+ 隔离实例。
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const APP = path.resolve('.');
const MOCK_PORT = Number(process.env.MOCK_PORT || 18881);
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const PORT = Number(process.env.TEST_PORT || 18882);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.resolve('data/_skill_test');
const SKILLS = path.join(DATA, 'skills');
const RECORD = path.join(DATA, 'mock-last.json');

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const json = async (p, opt = {}) => {
  const r = await fetch(BASE + p, { headers: { 'Content-Type': 'application/json' }, ...opt });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const put = (p, obj) => json(p, { method: 'PUT', body: JSON.stringify(obj) });

await rm(DATA, { recursive: true, force: true });
await mkdir(path.join(DATA, 'uploads'), { recursive: true });

// 两个真技能 + 一个超长技能 + 一个没有 front matter 的
const LONG = '长' .repeat(7000);
await mkdir(path.join(SKILLS, 'demo-voice'), { recursive: true });
await writeFile(path.join(SKILLS, 'demo-voice', 'SKILL.md'),
  '---\nname: 演示语感\ndescription: 测试用的技能，正文里有个记号 DEMO_MARK\n---\n\n# 演示语感\n\n写短句，别写总结。DEMO_MARK\n', 'utf8');
await mkdir(path.join(SKILLS, 'other-skill'), { recursive: true });
await writeFile(path.join(SKILLS, 'other-skill', 'SKILL.md'),
  '# 另一个技能\n\n这是第二个技能 OTHER_MARK。\n', 'utf8');
await mkdir(path.join(SKILLS, 'huge-skill'), { recursive: true });
await writeFile(path.join(SKILLS, 'huge-skill', 'SKILL.md'),
  '---\nname: 超长技能\ndescription: 用来验截断\n---\n\n' + LONG, 'utf8');
await mkdir(path.join(SKILLS, 'not-a-skill'), { recursive: true }); // 没有 SKILL.md，应被忽略

const mock = spawn(process.execPath, ['tools/mock-upstream.mjs'], {
  cwd: APP,
  env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_RECORD: RECORD },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
mock.stderr.on('data', d => console.log('[mock err]', String(d).trim()));
const srv = spawn(process.execPath, ['server.mjs'], {
  cwd: APP,
  env: { ...process.env, PORT: String(PORT), DSAPP_DATA: DATA, DSAPP_SKILLS: SKILLS },
  stdio: 'ignore',
});

const up = async (url, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    await sleep(200);
    try { if ((await fetch(url)).ok) return true; } catch {}
  }
  return false;
};

const systems = async () => {
  const raw = JSON.parse(await readFile(RECORD, 'utf8'));
  return (raw.body?.messages || []).filter(m => m.role === 'system').map(m => String(m.content || ''));
};

const send = async (text) => {
  await rm(RECORD, { force: true });
  const conv = await json('/api/conversations', { method: 'POST', body: JSON.stringify({ title: '技能试验' }) });
  const convId = conv.data?.id || conv.data?.conversation?.id || '';
  const r = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: convId, mode: 'send', content: text }),
  });
  if (!r.ok) console.log('[chat status]', r.status, (await r.text().catch(() => '')).slice(0, 160));
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    try { await readFile(RECORD, 'utf8'); return; } catch {}
  }
  return [];
};

try {
  check('假上游起来了', await up(`${MOCK}/models`));
  check('实例起来了', await up(`${BASE}/api/state`));

  const list = await json('/api/skills');
  const ids = (list.data.skills || []).map(s => s.id).sort();
  check('列出技能目录', list.data.dir === SKILLS, String(list.data.dir));
  check('三个技能都被识别', ids.join(',') === 'demo-voice,huge-skill,other-skill', ids.join(','));
  check('没 SKILL.md 的目录被忽略', !ids.includes('not-a-skill'));
  const demo = (list.data.skills || []).find(s => s.id === 'demo-voice') || {};
  check('front matter 的 name 生效', demo.name === '演示语感', String(demo.name));
  check('front matter 的 description 生效', String(demo.description).includes('DEMO_MARK'), String(demo.description));
  const other = (list.data.skills || []).find(s => s.id === 'other-skill') || {};
  check('没有 front matter 时用一级标题当名字', other.name === '另一个技能', String(other.name));
  check('默认谁都没启用', (list.data.skills || []).every(s => !s.enabled));

  await put('/api/settings', {
    apiKey: 'sk-mock-skill-key',
    baseUrl: MOCK,
    model: 'deepseek-flash',
    thinking: false,
    webSearch: false,
    readLink: false,
    autoTitle: false,
    replyStyle: 'human',
    enabledSkills: ['demo-voice'],
  });

  const st = await json('/api/state');
  check('settings 里记下启用的技能', JSON.stringify(st.data.settings?.enabledSkills) === '["demo-voice"]',
    JSON.stringify(st.data.settings?.enabledSkills));
  const list2 = await json('/api/skills');
  check('技能列表回显 enabled', (list2.data.skills || []).find(s => s.id === 'demo-voice')?.enabled === true);

  await send('写条弹幕');
  let sys = await systems();
  const joined = sys.join('\n');
  check('注入的技能带着【技能：名字】抬头', joined.includes('【技能：演示语感】'));
  check('注入的技能正文在', joined.includes('DEMO_MARK'));
  check('没勾的技能不在', !joined.includes('OTHER_MARK'));
  check('活人感提示还在（技能是追加不是替换）', joined.includes('第一句就给答案'));

  // 勾两个：都在
  await put('/api/settings', { enabledSkills: ['demo-voice', 'other-skill'] });
  await send('写条弹幕');
  sys = await systems();
  const j2 = sys.join('\n');
  check('勾两个就都注入', j2.includes('DEMO_MARK') && j2.includes('OTHER_MARK'));

  // 超长技能被截断
  await put('/api/settings', { enabledSkills: ['huge-skill'] });
  await send('写条弹幕');
  sys = await systems();
  const j3 = sys.join('\n');
  const skillMsg = sys.find(m => m.includes('【技能：超长技能】')) || '';
  check('超长技能被截断', j3.includes('技能过长已截断'), `${j3.length} 字`);
  check('截断后这条技能消息不超过 6250 字', skillMsg.length > 0 && skillMsg.length < 6250, `${skillMsg.length} 字`);

  // 非法 id 被过滤
  const bad = await put('/api/settings', { enabledSkills: ['demo-voice', '../etc/passwd', 'nope'] });
  check('非法/不存在的 id 被过滤', JSON.stringify(bad.data?.enabledSkills) === '["demo-voice"]',
    JSON.stringify(bad.data?.enabledSkills));

  // 全关：一点不剩
  await put('/api/settings', { enabledSkills: [] });
  await send('写条弹幕');
  sys = await systems();
  check('关掉后不再注入', !sys.join('\n').includes('DEMO_MARK'));

  // 原生风格 + 技能：技能照样注入（两件事互不影响）
  await put('/api/settings', { replyStyle: 'native', enabledSkills: ['demo-voice'] });
  await send('写条弹幕');
  sys = await systems();
  const j4 = sys.join('\n');
  check('原生风格下技能仍然注入', j4.includes('DEMO_MARK'));
  check('原生风格下没有活人感提示', !j4.includes('第一句就给答案'));
} finally {
  try { srv.kill(); } catch {}
  try { process.kill(-mock.pid); } catch { try { mock.kill(); } catch {} }
  await sleep(400);
  await rm(DATA, { recursive: true, force: true }).catch(() => {});
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
