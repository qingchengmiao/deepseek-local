// 自适应（按对话窗口调 system 提示词 + 温度）自测
// 用法：BASE=http://127.0.0.1:8790 MOCK=http://127.0.0.1:8899 node tools/tune-test.mjs
// 需要一个假上游（脚本会自己拉起来）+ 一个可写的服务实例（别打真 Key 的主服务）
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const MOCK = process.env.MOCK || 'http://127.0.0.1:8899';
const SEQ = 'data/mock-seq.json';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function json(path, opts) {
  const res = await fetch(BASE + path, opts);
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  return { res, data };
}
const put = (p, o) => json(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

async function mockUp() {
  try {
    const r = await fetch(MOCK + '/models', { signal: AbortSignal.timeout(600) });
    if (r.ok) return null;
  } catch {}
  const child = spawn(process.execPath, ['tools/mock-upstream.mjs'], { stdio: 'ignore', detached: true });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 150));
    try {
      const r = await fetch(MOCK + '/models', { signal: AbortSignal.timeout(500) });
      if (r.ok) return child;
    } catch {}
  }
  throw new Error('假上游没起来');
}

async function seqTail(n = 1) {
  const all = JSON.parse(await readFile(SEQ, 'utf8'));
  return all.slice(-n);
}

async function send(convId, content, extra = {}) {
  await writeFile(SEQ, '[]');
  const res = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: convId, mode: 'send', content, webSearch: false, thinking: false, autoTitle: false, ...extra }),
  });
  const text = await res.text();
  const events = [];
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find(l => l.startsWith('data:'));
    if (!line) continue;
    const raw = line.slice(5).trim();
    if (raw === '[DONE]') continue;
    try { events.push(JSON.parse(raw)); } catch {}
  }
  return events;
}

async function main() {
  let orig;
  try {
    orig = (await json('/api/settings')).data;
  } catch (e) {
    console.log('服务没起，跳过：' + e.message);
    process.exit(1);
  }
  if (orig.hasKey && !process.env.ALLOW_REAL_KEY) {
    console.log('本机已存真 Key；换一个隔离实例再跑（BASE=…:8790 DSAPP_DATA=data\\_ttest）。');
    process.exit(2);
  }

  await mockUp();
  const convIds = [];
  try {
    await put('/api/settings', {
      apiKey: 'sk-mock-tune-key',
      baseUrl: MOCK,
      temperature: 1,
      adaptiveTurn: true,
      autoRoute: false,
      thinking: false,
      autoTitle: false,
      readLink: false,
      ctxCompress: false,
      ctxRag: false,
      model: 'deepseek-v4-pro',
    });

    const mk = async title => {
      const r = await json('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, model: 'deepseek-v4-pro' }),
      });
      const id = r.data.conversation.id;
      convIds.push(id);
      return id;
    };

    // ---- 1. 短问：温度压低到 0.85 以内 + 短问提示
    console.log('\n[1] 短问');
    {
      const id = await mk('调温度-短问');
      const evs = await send(id, '在吗');
      const ev = evs.find(e => e.type === 'tune');
      check('SSE 发了 tune 事件', !!ev, ev ? `温度 ${ev.temperature}` : '没有');
      check('短问算「闲聊」', !!ev && ev.tags.includes('chat'), ev ? ev.tags.join(',') : '');
      check('温度 ≤ 0.85', !!ev && ev.temperature <= 0.85, String(ev?.temperature));
      const [last] = await seqTail(1);
      check('上游真的收到这个温度', last.temperature === ev.temperature, `${last.temperature} vs ${ev.temperature}`);
      check('上游收到临时设定块', /短问/.test(last.tunePrompt), last.tunePrompt.slice(0, 40));
      const done = evs.find(e => e.type === 'done');
      check('温度写进了消息（刷新后还能看到）', done?.message?.tune?.temperature === ev.temperature, JSON.stringify(done?.message?.tune || null));
    }

    // ---- 2. 代码：温度更低（≤0.35）+ 代码提示
    console.log('\n[2] 代码');
    {
      const id = await mk('调温度-代码');
      const evs = await send(id, '这段 js 报错 Cannot read properties of undefined (reading x)，怎么改？贴个能跑的改法');
      const ev = evs.find(e => e.type === 'tune');
      check('识别成「代码」', !!ev && ev.tags.includes('code'), ev ? ev.tags.join(',') : '');
      check('温度 ≤ 0.35', !!ev && ev.temperature <= 0.35, String(ev?.temperature));
      const [last] = await seqTail(1);
      check('上游收到代码提示', /附代码|偏代码/.test(last.tunePrompt), last.tunePrompt.slice(0, 40));
      check('上游温度已降', last.temperature <= 0.35, String(last.temperature));
    }

    // ---- 3. 创作：温度抬高（>1）
    console.log('\n[3] 创作');
    {
      const id = await mk('调温度-创作');
      const evs = await send(id, '写一段小说的开头：凌晨四点的便利店，一个人坐在窗边吃关东煮。');
      const ev = evs.find(e => e.type === 'tune');
      check('识别成「创作」', !!ev && ev.tags.includes('creative'), ev ? ev.tags.join(',') : '');
      check('温度 > 1', !!ev && ev.temperature > 1, String(ev?.temperature));
      const [last] = await seqTail(1);
      check('上游收到创作提示', /创作/.test(last.tunePrompt), last.tunePrompt.slice(0, 40));
    }

    // ---- 4. 长对话：轮数攒到 12 之后温度再降、加「别复述」提示
    console.log('\n[4] 长对话');
    {
      const id = await mk('调温度-长对话');
      for (let i = 0; i < 12; i++) {
        await send(id, `第 ${i + 1} 句：接着说。`);
      }
      const evs = await send(id, '继续');
      const ev = evs.find(e => e.type === 'tune');
      check('认出长对话', !!ev && ev.tags.includes('longconv'), ev ? ev.tags.join(',') : '');
      const [last] = await seqTail(1);
      check('提示里写了别复述背景', /别复述背景/.test(last.tunePrompt), last.tunePrompt.slice(0, 60));
      check('长对话温度比短问低（≤0.7）', !!ev && ev.temperature <= 0.7, String(ev?.temperature));
    }

    // ---- 5. 关掉开关：不发 tune、温度回到 settings
    console.log('\n[5] 关掉自适应');
    {
      await put('/api/settings', { adaptiveTurn: false });
      const id = await mk('调温度-关');
      const evs = await send(id, '在吗');
      check('关掉后不发 tune 事件', !evs.find(e => e.type === 'tune'));
      const [last] = await seqTail(1);
      check('温度回到设置值 1', last.temperature === 1, String(last.temperature));
      check('没有临时设定块', !last.tunePrompt, last.tunePrompt.slice(0, 30));
    }
  } finally {
    // 还原设置（尽力而为）
    try {
      await put('/api/settings', {
        adaptiveTurn: orig.adaptiveTurn !== false,
        temperature: typeof orig.temperature === 'number' ? orig.temperature : 1,
      });
    } catch {}
    for (const id of convIds) {
      try { await fetch(BASE + '/api/conversations/' + id, { method: 'DELETE' }); } catch {}
    }
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => {
  console.error('崩了：', e);
  process.exit(1);
});
