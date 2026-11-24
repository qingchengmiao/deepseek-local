// 自调整：模型在回答里带 ```tune {...}``` 改自己的温度/口径，能落盘、能生效、能撤回
// 假上游先吐一次带调整块的回答，之后看下一轮 payload.temperature 和 system 里到底有没有那条口径
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const UP = 18982, APP = 18981;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'self-tune-'));
const seen = [];
let reply = '好';

const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    try { seen.push(JSON.parse(body || '{}')); } catch { seen.push(null); }
    // 必须回 SSE：server.mjs:4940 是按 '\n\n' 切块、读 choices[0].delta.content 的，
    // 回一次性 JSON 的话正文永远是空的（助手消息存不进去）。
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`);
    res.end('data: [DONE]\n\n');
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
// autoTitle 必须关：开着的话第一轮会让上游起标题（upstreamTitle=true），
// 而 server.mjs:4863 的 samplingAllowed 要求 !upstreamTitle —— 温度压根不会进 payload，
// 断言就没法验「温度真的按调的走」。
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  apiKey: 'test-key', baseUrl: `http://127.0.0.1:${UP}`, model: 'deepseek-flash',
  temperature: 1, adaptiveTurn: false, webSearch: false, readLink: false, autoTitle: false,
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
  // /api/chat 回的是 SSE 流，不能用 r.json() 解；要验「存进库的正文」，就直接读会话。
  const convOf = async (id) => (await j(`/api/conversations/${id}?tail=50`)).conversation;
  const send = async (id, text = '在吗') => {
    seen.length = 0;
    const before = (await convOf(id)).messages.length;
    await fetch(`http://127.0.0.1:${APP}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: id, content: text, model: 'deepseek-flash', reasoning: false }),
    }).then((r) => r.text()).catch(() => '');
    const done = await until(async () => {
      const c = await convOf(id);
      const last = c.messages[c.messages.length - 1];
      return c.messages.length > before && last && last.role === 'assistant' && String(last.content || '').trim();
    }, 12000);
    if (!done) console.log('  （等落库超时）');
    const conv = await convOf(id);
    const lastAssistant = conv.messages.filter((m) => m.role === 'assistant').slice(-1)[0] || {};
    await until(() => seen.length > 0, 3000);
    const ms = (seen[0] && seen[0].messages) || [];
    return {
      content: String(lastAssistant.content || ''),
      selfTune: lastAssistant.selfTune || null,
      payload: seen[0] || {},
      system: ms.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n---\n'),
    };
  };

  // 1) 平时带指令不带口径
  const c1 = await mk('probe-1');
  const r1 = await send(c1, '你是谁');
  ok('默认注入「你可以调整自己」', r1.system.includes('你可以调整自己'), String(r1.payload.temperature));
  ok('默认没有自我调整口径段', !r1.system.includes('这些是你自己之前决定要改的'));
  ok('默认温度还是设置的 1', Number(r1.payload.temperature) === 1, String(r1.payload.temperature));

  // 2) 模型自己调：temperature 0.6 + human 档口径
  //    口径用「少用破折号」这种指令示例里没有的串，否则断言会撞上示例文本（假通过）。
  reply = [
    '先给结论：我在。',
    '',
    '```tune',
    JSON.stringify({ temperature: 0.6, addendum: '少用破折号，别抢话', scope: 'human', why: '测试自调' }),
    '```',
  ].join('\n');
  const r2 = await send(c1, '以后回答直接一点');
  const st2 = await j('/api/self-tune');
  ok('落盘：温度 0.6', Number(st2.temp) === 0.6, JSON.stringify(st2.temp));
  ok('落盘：human 档口径', String(st2.addendum && st2.addendum.human || '').includes('少用破折号'));
  ok('落盘：记了一条历史', Array.isArray(st2.history) && st2.history.length === 1 && st2.history[0].by === 'model', JSON.stringify(st2.history && st2.history[0]));
  ok('回答里不再显示调整块', !r2.content.includes('```tune'), JSON.stringify(r2.content.slice(0, 60)));
  ok('回的是剥过块的正文', r2.content.includes('先给结论：我在'), JSON.stringify(r2.content.slice(0, 60)));
  ok('落库那轮记下了 selfTune', !!r2.selfTune, JSON.stringify(r2.selfTune));

  // 3) 下一轮真的用上了
  reply = '好';
  const r3 = await send(c1, '再说一句');
  ok('下一轮温度变成 0.6', Number(r3.payload.temperature) === 0.6, String(r3.payload.temperature));
  ok('下一轮 system 带口径', r3.system.includes('少用破折号'));

  // 4) 撤回之后回退
  const rv = await j('/api/self-tune/revert', { method: 'POST', body: {} });
  ok('撤回成功', rv.ok === true && rv.temp == null, JSON.stringify({ ok: rv.ok, temp: rv.temp }));
  const r4 = await send(c1, '还在吗');
  ok('撤回后温度回 1', Number(r4.payload.temperature) === 1, String(r4.payload.temperature));
  ok('撤回后 system 不再带口径', !r4.system.includes('少用破折号'));

  // 5) 人手动改（global 档 + 温度 1.2）
  const put = await j('/api/self-tune', { method: 'POST', body: { temperature: 1.2, addendum: '别用感叹号', scope: 'global', why: '手动' } });
  ok('手动改成功', put.ok === true && Number(put.temp) === 1.2 && String(put.addendum && put.addendum.global || '').includes('别用感叹号'), JSON.stringify({ temp: put.temp, add: put.addendum }));
  const r5 = await send(c1, '嗯');
  ok('手动温度生效', Number(r5.payload.temperature) === 1.2, String(r5.payload.temperature));
  ok('global 档在网页会话里生效', r5.system.includes('别用感叹号'));

  // 6) 关掉开关：不再注入指令、也不再接受改动
  await j('/api/settings', { method: 'PUT', body: { selfTune: false } });
  const settle = await j('/api/self-tune');
  ok('关掉后 enabled=false', settle.enabled === false, String(settle.enabled));
  const r6 = await send(c1, '关掉试试');
  ok('关掉后不注入指令', !r6.system.includes('你可以调整自己'));
  ok('关掉后温度不再被覆盖', Number(r6.payload.temperature) === 1, String(r6.payload.temperature));
  reply = '好\n\n```tune\n{"temperature":1.9}\n```';
  await send(c1, '再调一次');
  const after = await j('/api/self-tune');
  ok('关掉后不接受模型改动', Number(after.temp) === 1.2, String(after.temp));

  // 7) 清空
  await j('/api/settings', { method: 'PUT', body: { selfTune: true } });
  const rs = await j('/api/self-tune/reset', { method: 'POST', body: {} });
  ok('清空后没有温度', rs.temp == null);
  ok('清空后没有口径', !String(rs.addendum && (rs.addendum.global || rs.addendum.human || rs.addendum.qq) || '').trim());
} catch (e) {
  console.log('✗ 测试中途炸了：', e && e.message);
  fails++;
} finally {
  try { srv.kill('SIGKILL'); } catch {}
  try { upstream.close(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
  process.exit(fails ? 1 : 0);
}
