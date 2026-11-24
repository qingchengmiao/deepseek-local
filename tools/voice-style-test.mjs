// 说话口径与反八股：验证「逐对话口径 + 反八股」到底往 system 里塞了什么
// 假上游记 payload，隔离实例跑真 server.mjs，几种口径各发一轮，比对 system 文本
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const UP = 18972, APP = 18971;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-style-'));
const seen = [];

const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    try { seen.push(JSON.parse(body || '{}')); } catch { seen.push(null); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: '好' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
  });
});

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
  return r.json();
};

await new Promise((r) => upstream.listen(UP, r));
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  apiKey: 'test-key', baseUrl: `http://127.0.0.1:${UP}`, model: 'deepseek-flash',
  replyStyle: 'human', antiBaGu: true, qqStyle: true, webSearch: false, readLink: false,
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

  const mk = async (title, patch) => {
    const r = await j('/api/conversations', { method: 'POST', body: { title } });
    const id = r.conversation.id;
    if (patch) await j(`/api/conversations/${id}`, { method: 'PATCH', body: patch });
    return id;
  };

  const send = async (id, text = '在吗') => {
    seen.length = 0;
    await j('/api/chat', { method: 'POST', body: { conversationId: id, content: text, model: 'deepseek-flash', reasoning: false } }).catch(() => ({}));
    await until(() => seen.length > 0, 8000);
    const ms = (seen[0] && seen[0].messages) || [];
    return ms.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n---\n');
  };

  // 1) 网页会话，跟随全局（human）
  const c1 = await mk('probe-human');
  const s1 = await send(c1);
  ok('网页会话带活人感', s1.includes('跟人说话'), s1.slice(0, 24));
  ok('网页会话带反八股', s1.includes('模板腔'));
  ok('网页会话不带 QQ 手机打字口径', !s1.includes('手机'));

  // 2) 逐对话改成 qq
  const c2 = await mk('probe-qq', { replyStyle: 'qq' });
  const s2 = await send(c2);
  ok('qq 口径带手机打字那套', s2.includes('手机'));
  ok('qq 口径也带反八股', s2.includes('模板腔'));

  // 3) 逐对话改成 native：不带活人感也不带反八股
  const c3 = await mk('probe-native', { replyStyle: 'native' });
  const s3 = await send(c3);
  ok('native 不带活人感', !s3.includes('跟人说话'));
  ok('native 不带反八股', !s3.includes('模板腔'));

  // 4) custom：只留用户自己的 systemPrompt（反八股仍可用，可全局关）
  const c4 = await mk('probe-custom', { replyStyle: 'custom', systemPrompt: '你是一只猫。' });
  const s4 = await send(c4);
  ok('custom 带自己的提示', s4.includes('你是一只猫'));
  ok('custom 不塞活人感', !s4.includes('跟人说话'));

  // 5) 空串 = 跟随全局
  const c5 = await mk('probe-reset', { replyStyle: 'qq' });
  await j(`/api/conversations/${c5}`, { method: 'PATCH', body: { replyStyle: '' } });
  const conv = (await j(`/api/conversations/${c5}`)).conversation;
  ok('空串清掉本会话口径', !conv.replyStyle, JSON.stringify(conv.replyStyle));
  const s5 = await send(c5);
  ok('清掉后回到全局活人感', s5.includes('跟人说话'));

  // 6) 全局关掉反八股 → 不再注入
  await j('/api/settings', { method: 'PUT', body: { antiBaGu: false } });
  const s6 = await send(c1);
  ok('反八股可全局关掉', !s6.includes('模板腔'));

  // 7) QQ 会话不设逐对话口径时，自动吃 qqq 口径
  for (const [gid, wantQQ] of [['728100111', true]]) {
    const r = await j('/api/qq/bind', { method: 'POST', body: { convId: c1, gid } }).catch(() => ({ ok: false }));
    if (r && r.ok) {
      const cq = r.conversation && r.conversation.id ? r.conversation.id : c1;
      await j('/api/settings', { method: 'PUT', body: { antiBaGu: true } });
      const sq = await send(cq);
      ok(`绑定群 ${gid} 的会话默认走 QQ 口径`, sq.includes('手机') === wantQQ);
    }
  }
  // 8) 用户对话学习：打开 meInject 后，system 里应该出现「对方平时怎么说话」那段
  await j('/api/settings', { method: 'PUT', body: { meInject: false } });
  const s7 = await send(c1);
  ok('默认不带我说话的画像', !s7.includes('对方平时怎么说话'));
  const me = await j('/api/learn/me');
  ok('能读到自己的画像摘要', me && me.ok === true, JSON.stringify(me).slice(0, 80));
  await j('/api/settings', { method: 'PUT', body: { meInject: true, meMax: 400 } });
  const s8 = await send(c1);
  ok('打开后带上我说话的画像', s8.includes('对方平时怎么说话'), s8.slice(-120));
  ok('画像里写了量出来的东西', /句长|一条消息/.test(s8));
  ok('画像不超过字数上限', (s8.split('对方平时怎么说话')[1] || '').length <= 460);
  const rf = await j('/api/learn/me/refresh', { method: 'POST', body: {} });
  ok('重新量一遍能落盘', rf && rf.ok === true && typeof rf.profile === 'string');
  await j('/api/settings', { method: 'PUT', body: { meInject: false } });
} finally {
  srv.kill();
  upstream.close();
  await wait(300);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
process.exit(fails ? 1 : 0);
