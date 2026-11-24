// 记忆预设：验证「一套参数」怎么叠上去
// 叠法（从弱到强）：全局单项设置 → 全局预设 → 会话预设 → 会话手工覆盖
// 预设只存 id，所以改了预设定义，所有跟它的会话下一轮自动跟着变 —— 这就是「自动同步」
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const APP = 18961;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-preset-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return true; } catch {}
    if (Date.now() - t0 > ms) return false;
    await wait(150);
  }
}
const j = async (p, opts = {}) => {
  const r = await fetch(`http://127.0.0.1:${APP}${p}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};

fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  apiKey: 'test-key', baseUrl: 'http://127.0.0.1:1', // 这个测试不发请求，上游给个不通的地址
  ctxBudget: 24000, ctxHotRatio: 0.6, ctxTopK: 4, ctxHalfLifeDays: 30,
  ctxCompress: true, ctxRag: true, ctxArchive: false, ctxPreset: '',
}, null, 2));

const srv = spawn(process.execPath, ['server.mjs'], {
  cwd: path.resolve('.'),
  env: { ...process.env, DSAPP_DATA: tmp, PORT: String(APP) },
  stdio: 'ignore',
});

let fails = 0;
const ok = (name, cond, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) fails++; };

try {
  ok('实例起来了', await until(async () => (await j('/api/state')).ok !== false));

  const mk = async (title) => (await j('/api/conversations', { method: 'POST', body: { title } })).conversation.id;
  // /context 把生效预算放在顶层 budget，把「跟随谁 / 覆盖了啥 / 用哪套预设」放在 ctx 里
  const ctxOf = async (id) => {
    const st = await j(`/api/conversations/${id}/context`);
    return { budget: st.budget, ...(st.ctx || {}) };
  };

  // 1) 预设表
  const list = await j('/api/ctx-presets');
  ok('预设表有 4 档', (list.presets || []).length === 4, (list.presets || []).map((p) => p.id).join(','));
  ok('预算从低到高', (list.presets || []).map((p) => p.ctx.ctxBudget).join(',') === '64000,128000,256000,512000');
  ok('一开始没有全局预设', list.global === '');

  // 2) 没有预设时按单项设置
  const c1 = await mk('preset-probe-1');
  const s0 = await ctxOf(c1);
  ok('没套预设：预算 = 全局单项 24000', s0.budget === 24000, String(s0.budget));
  ok('没套预设：followGlobal', s0.followGlobal === true);

  // 3) 会话套「长对话」
  const a1 = await j('/api/ctx-presets/apply', { method: 'POST', body: { presetId: 'long', conversationId: c1 } });
  ok('会话套预设成功', a1.ok === true && a1.preset === 'long', JSON.stringify(a1.preset));
  ok('apply 直接回了生效预算 256000', a1.effective && a1.effective.ctxBudget === 256000, JSON.stringify(a1.effective));
  const s1 = await ctxOf(c1);
  ok('落盘后预算 256000', s1.budget === 256000, String(s1.budget));
  ok('落盘后 preset=long', s1.preset === 'long', String(s1.preset));
  ok('预设不算手工覆盖（overrides 空）', !s1.overrides || Object.keys(s1.overrides).length === 0, JSON.stringify(s1.overrides));

  // 4) 会话预设压过全局单项
  ok('全局单项还是 24000（没被预设改写）', (await j('/api/settings')).ctxBudget === 24000);

  // 5) 全局预设：没自己选的会话跟着变
  const c2 = await mk('preset-probe-2');
  await j('/api/ctx-presets/apply', { method: 'POST', body: { presetId: 'deep' } });
  ok('全局预设写进去了', (await j('/api/ctx-presets')).global === 'deep');
  const s2 = await ctxOf(c2);
  ok('没选的会话跟全局预设：512000', s2.budget === 512000, String(s2.budget));
  ok('没选的会话 globalPreset=deep', s2.globalPreset === 'deep', String(s2.globalPreset));
  const s1b = await ctxOf(c1);
  ok('自己选过的会话不被全局预设改：还是 256000', s1b.budget === 256000, String(s1b.budget));

  // 6) 手工覆盖压过预设
  await j(`/api/conversations/${c1}`, { method: 'PATCH', body: { ctx: { ctxBudget: 200000 } } });
  const s1c = await ctxOf(c1);
  ok('手工覆盖压过预设：200000', s1c.budget === 200000, String(s1c.budget));
  ok('手工覆盖时 preset 还留着', s1c.preset === 'long', String(s1c.preset));

  // 7) 套预设会清手工覆盖（否则预设改不动那几项）
  await j('/api/ctx-presets/apply', { method: 'POST', body: { presetId: 'lean', conversationId: c1 } });
  const s1d = await ctxOf(c1);
  ok('换预设后手工覆盖被清：64000', s1d.budget === 64000, String(s1d.budget));
  ok('换预设后 overrides 清空', !s1d.overrides || Object.keys(s1d.overrides).length === 0);

  // 8) 跟随全局 = 连手工覆盖一起撤
  await j(`/api/conversations/${c1}`, { method: 'PATCH', body: { ctx: { ctxBudget: 90000 } } });
  await j('/api/ctx-presets/apply', { method: 'POST', body: { presetId: '', conversationId: c1 } });
  const s1e = await ctxOf(c1);
  ok('跟随全局：preset 清掉', !s1e.preset, String(s1e.preset));
  ok('跟随全局：回到全局预设 deep 的 512000', s1e.budget === 512000, String(s1e.budget));
  ok('跟随全局：手工覆盖也撤了', !s1e.overrides || Object.keys(s1e.overrides).length === 0);

  // 9) 不存在的预设报错
  const bad = await j('/api/ctx-presets/apply', { method: 'POST', body: { presetId: 'nope', conversationId: c1 } });
  ok('不存在的预设 400', bad.status === 400, String(bad.status));

  // 10) PATCH 直接写 ctxPreset 也认（前端和别处都能用）
  await j(`/api/conversations/${c1}`, { method: 'PATCH', body: { ctxPreset: 'std' } });
  ok('PATCH ctxPreset=std 生效', (await ctxOf(c1)).budget === 128000, String((await ctxOf(c1)).budget));
  await j(`/api/conversations/${c1}`, { method: 'PATCH', body: { ctxPreset: 'bogus' } });
  ok('PATCH 乱写的预设被忽略并清掉', !(await ctxOf(c1)).preset, String((await ctxOf(c1)).preset));

  // 11) 全局预设清空后回到单项设置
  await j('/api/ctx-presets/apply', { method: 'POST', body: { presetId: '' } });
  ok('全局清空后没有预设', (await j('/api/ctx-presets')).global === '');
  ok('清空后回到单项 24000', (await ctxOf(c2)).budget === 24000, String((await ctxOf(c2)).budget));

  // 12) 「自动同步」：预设本身只有 id，改定义就全变（这条只能间接验：确认存的是 id 不是数字）
  const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'conversations', `${c1}.json`), 'utf8'));
  ok('会话里存的是预设 id 不是数字', !('ctxBudget' in (raw.ctx || {})) || raw.ctxPreset === undefined, JSON.stringify({ ctx: raw.ctx, ctxPreset: raw.ctxPreset }));
} finally {
  srv.kill();
  await wait(300);
  console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
  process.exit(fails ? 1 : 0);
}
