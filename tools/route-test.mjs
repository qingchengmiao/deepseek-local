// 自动路由自测：判断表 + 三条真链路（假上游）
// 用法：node tools/route-test.mjs        （服务要跑在 8787）
import { liveGuard } from './_guard.mjs';
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
await liveGuard(BASE, 'route-test');
const MOCK = process.env.MOCK || 'http://127.0.0.1:8899';
const SEQ = 'data/mock-seq.json';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function mathJson(path, opts) {
  const res = await fetch(BASE + path, opts);
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  return { res, data };
}
const put = (p, o) => mathJson(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const post = (p, o) => mathJson(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) });
const del = p => mathJson(p, { method: 'DELETE' });

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

function parseSse(text) {
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

async function routeOf(body) {
  const r = await post('/api/route/test', body);
  return r.data && r.data.route ? r.data.route : null;
}

// ---------------------------------------------------------------- 集成
async function live() {
  let orig;
  try {
    orig = (await mathJson('/api/settings')).data;
  } catch (e) {
    console.log('\n（服务没起，跳过集成部分：' + e.message + '）');
    return;
  }
  if (orig.hasKey) {
    console.log('\n（本机已存真 Key，跳过集成部分，避免覆盖）');
    return;
  }

  await mockUp();
  const convIds = [];
  try {
    await put('/api/settings', {
      apiKey: 'sk-mock-route-key',
      baseUrl: MOCK,
      autoRoute: true,
      thinking: false,
      autoTitle: false,
      readLink: false,
      ctxCompress: false,
      ctxRag: false,
      routeChatModel: 'deepseek-v4-pro',
      routeThinkModel: 'deepseek-flash',
      routeHybridDraftModel: 'deepseek-flash',
      routeHybridModel: 'deepseek-v4-pro',
    });

    const c = await post('/api/conversations', { title: '路由测试', model: 'auto' });
    const convId = c.data.conversation.id;
    convIds.push(convId);
    check('能建「自动」会话', c.data.conversation.model === 'auto', String(c.data.conversation.model));

    const send = async (content, extra = {}) => {
      const res = await fetch(BASE + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: convId, mode: 'send', content, webSearch: false, thinking: false, autoTitle: false, ...extra }),
      });
      return parseSse(await res.text());
    };
    const resetSeq = async () => { try { await rm(SEQ); } catch {} };
    const readSeq = async () => { try { return JSON.parse(await readFile(SEQ, 'utf8')); } catch { return []; } };

    console.log('\n8) 普通对话 → V4 Pro');
    await resetSeq();
    {
      const evs = await send('今天有点累，陪我聊两句吧。');
      const rt = evs.find(e => e.type === 'route');
      const start = evs.find(e => e.type === 'start');
      const seq = await readSeq();
      check('发了 route 事件', !!rt, rt ? `${rt.kind}/${rt.model}` : '没有');
      check('判成对话档', rt && rt.kind === 'chat', rt ? rt.kind : '');
      check('用的是 V4 Pro', rt && rt.model === 'deepseek-v4-pro' && start && start.model === 'deepseek-v4-pro', start ? start.model : '');
      check('只发了 1 次请求（没有额外草案）', seq.length === 1, `${seq.length} 次`);
      check('这次没有带大纲提示', seq[0] && !seq[0].hasOutlinePrompt);
      const done = evs.find(e => e.type === 'done');
      check('回答保存了 route 标记', !!(done && done.message && done.message.route && done.message.route.kind === 'chat'),
        done && done.message && done.message.route ? JSON.stringify(done.message.route) : '没有');
    }

    console.log('\n9) 逻辑思考 → V4.1 Flash（带思考）');
    await resetSeq();
    {
      const evs = await send('这段 SQL 为什么报错？帮我排查一下索引没走的问题。');
      const rt = evs.find(e => e.type === 'route');
      const start = evs.find(e => e.type === 'start');
      const seq = await readSeq();
      check('判成逻辑思考档', rt && rt.kind === 'think', rt ? `${rt.kind}/${rt.reason}` : '');
      check('用的是 V4.1 Flash', rt && rt.model === 'deepseek-flash' && start && start.model === 'deepseek-flash', start ? start.model : '');
      check('thinking 打开了', rt && rt.thinking === true);
      check('还是一轮请求', seq.length === 1, `${seq.length} 次`);
      // 回归：Flash 认 latest_reminder，且它必须紧跟 user（顺序错了上游就 400）
      {
        const lastBody = JSON.parse(await readFile('data/mock-last.json', 'utf8'));
        const roles = ((lastBody.body && lastBody.body.messages) || []).map(m => m.role);
        const at = roles.lastIndexOf('latest_reminder');
        check('Flash 请求带 latest_reminder 且紧跟 user', at >= 1 && roles[at + 1] === 'user',
          `尾部角色=${roles.slice(-3).join(',')}`);
      }
    }

    console.log('\n10) 综合模式 → Flash 出大纲 + Pro 写正文（两次）');
    await resetSeq();
    {
      const evs = await send('写一份给团队的周报，总结这周的数据库迁移，还要给出下周计划。');
      const rt = evs.find(e => e.type === 'route');
      const start = evs.find(e => e.type === 'start');
      const seq = await readSeq();
      check('判成综合档', rt && rt.kind === 'hybrid', rt ? `${rt.kind}/${rt.reason}` : '');
      check('正文用 V4 Pro', start && start.model === 'deepseek-v4-pro', start ? start.model : '');
      check('上游被调了两次', seq.length === 2, `${seq.length} 次`);
      check('第一次是 Flash 出大纲（非流式 + 大纲提示）', seq[0] && seq[0].model === 'deepseek-flash' && seq[0].hasOutlinePrompt === true && seq[0].stream === false,
        seq[0] ? JSON.stringify(seq[0]) : '');
      check('第二次是 Pro 写正文且带大纲块', seq[1] && seq[1].model === 'deepseek-v4-pro' && seq[1].hasOutlineBlock === true && seq[1].stream === true,
        seq[1] ? JSON.stringify(seq[1]) : '');
      check('route 事件里有草案信息', rt && rt.draft && rt.draft.model === 'deepseek-flash' && rt.draft.chars > 0, rt && rt.draft ? JSON.stringify(rt.draft) : '没有');
    }

    console.log('\n11) 附件 / 续写 / 关掉路由');
    {
      const rv = await routeOf({ text: '这张图里写了什么', attachments: [{ kind: 'image', name: 'a.png' }] });
      check('带附件走看附件档（Flash）', rv && rv.kind === 'vision' && rv.model === 'deepseek-flash', rv ? `${rv.kind}/${rv.model}` : '');
      const rvm = await routeOf({ text: '这个视频讲了什么', attachments: [{ kind: 'video', name: 'a.mp4' }] });
      check('带视频走音视频两段式（Pro 写正文）', rvm && rvm.kind === 'media' && rvm.model === 'deepseek-v4-pro',
        rvm ? `${rvm.kind}/${rvm.model}/${rvm.draftModel}` : '');
      const rva = await routeOf({ text: '这段录音说了啥', attachments: [{ kind: 'audio', name: 'a.wav' }] });
      check('带音频也走音视频两段式', rva && rva.kind === 'media' && rva.draftModel === 'deepseek-flash', rva ? `${rva.kind}/${rva.draftModel}` : '');
      await put('/api/settings', { mediaTwoStage: false });
      const rvoff = await routeOf({ text: '这个视频讲了什么', attachments: [{ kind: 'video', name: 'a.mp4' }] });
      check('关掉两段式后回落到看附件（Flash 一遍）', rvoff && rvoff.kind === 'vision', rvoff ? rvoff.kind : '');
      await put('/api/settings', { mediaTwoStage: true });
      const rc = await routeOf({ text: '继续', mode: 'continue' });
      check('续写走对话档（Pro）', rc && rc.kind === 'chat' && rc.model === 'deepseek-v4-pro', rc ? `${rc.kind}/${rc.model}` : '');

      await put('/api/settings', { autoRoute: false });
      const off = (await post('/api/route/test', { text: '写一份报告' })).data;
      check('关掉自动路由后不再给路由', off && off.autoRoute === false && off.route === null, JSON.stringify(off));
      await put('/api/settings', { autoRoute: true });
    }

    console.log('\n12) 手动选模型的会话不受路由影响');
    {
      const c2 = await post('/api/conversations', { title: '手动模型测试', model: 'deepseek-flash' });
      convIds.push(c2.data.conversation.id);
      await resetSeq();
      const res = await fetch(BASE + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: c2.data.conversation.id, mode: 'send', content: '写一份给团队的周报。', thinking: false, autoTitle: false }),
      });
      const evs = parseSse(await res.text());
      const rt = evs.find(e => e.type === 'route');
      const seq = await readSeq();
      check('手动会话没有 route 事件', !rt);
      check('手动会话仍用自己选的模型', seq.length === 1 && seq[0].model === 'deepseek-flash', seq.length ? String(seq[0].model) : '0 次');
    }
    console.log('\n13) 混合模式开关：手动会话也强制 Flash 起草 + Pro 写正文');
    {
      await put('/api/settings', { hybridMode: true });
      const st = await (await fetch(BASE + '/api/state')).json();
      check('设置里开着混合模式', st.settings && st.settings.hybridMode === true, String(st.settings && st.settings.hybridMode));
      const ch = await (await fetch(BASE + '/api/channels')).json();
      check('/api/channels 的 route 也带 hybridMode', !!ch.route && ch.route.hybridMode === true, JSON.stringify(ch.route));

      // 手动选了 Flash 的会话，打开混合也应该被接管
      const c3 = await post('/api/conversations', { title: '混合模式测试', model: 'deepseek-flash' });
      convIds.push(c3.data.conversation.id);
      await resetSeq();
      const res = await fetch(BASE + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: c3.data.conversation.id, mode: 'send', content: '今天天气不错。', thinking: false, autoTitle: false, hybrid: true }),
      });
      const evs3 = parseSse(await res.text());
      const rt3 = evs3.find(e => e.type === 'route');
      const start3 = evs3.find(e => e.type === 'start');
      const seq3 = await readSeq();
      check('混合模式给了 route 事件', !!rt3, rt3 ? rt3.kind : '没有');
      check('判成混合档', rt3 && rt3.kind === 'hybrid', rt3 ? rt3.kind : '');
      check('标了 forced（不是自动路由挑的）', rt3 && rt3.forced === true && rt3.auto === false, rt3 ? JSON.stringify({ forced: rt3.forced, auto: rt3.auto }) : '');
      check('正文用 V4 Pro', start3 && start3.model === 'deepseek-v4-pro', start3 ? start3.model : '');
      check('上游两次：Flash 起草 → Pro 写正文', seq3.length === 2, `${seq3.length} 次`);
      check('第一次 Flash 非流式带大纲提示', seq3[0] && seq3[0].model === 'deepseek-flash' && seq3[0].stream === false && seq3[0].hasOutlinePrompt === true,
        seq3[0] ? JSON.stringify(seq3[0]) : '');
      check('第二次 Pro 流式带大纲块', seq3[1] && seq3[1].model === 'deepseek-v4-pro' && seq3[1].stream === true && seq3[1].hasOutlineBlock === true,
        seq3[1] ? JSON.stringify(seq3[1]) : '');
      const done3 = evs3.find(e => e.type === 'done');
      check('保存的 route 标记是混合档', !!(done3 && done3.message && done3.message.route && done3.message.route.kind === 'hybrid'),
        done3 && done3.message && done3.message.route ? JSON.stringify(done3.message.route) : '没有');

      // 回归：latest_reminder 的两条硬约束（都踩过上游 400）。
      // ① 只有 deepseek-flash 认这个角色（v4-pro 会报 "The latest_reminder message is unavailable for model deepseek-v4-pro"），
      //    所以两段式的第二遍（Pro 写正文）里不该出现它；
      // ② 出现时必须紧跟 user（两段式会往「最后一条 user 之前」插 system 块，顺序反了就 400）。
      {
        const lastBody = JSON.parse(await readFile('data/mock-last.json', 'utf8'));
        const model = (lastBody.body && lastBody.body.model) || '';
        const roles = ((lastBody.body && lastBody.body.messages) || []).map(m => m.role);
        check('两段式第二遍（Pro）不带 latest_reminder',
          model === 'deepseek-v4-pro' && !roles.includes('latest_reminder'),
          `model=${model} 角色尾部=${roles.slice(-3).join(',')}`);
      }

      // 关掉自动路由，混合模式照样生效（这是它比自动路由「硬」的地方）
      await put('/api/settings', { autoRoute: false });
      const rt4 = (await post('/api/route/test', { text: '随便聊聊', hybrid: true })).data;
      check('关掉自动路由，混合模式仍然接管', rt4 && rt4.route && rt4.route.kind === 'hybrid' && rt4.route.forced === true,
        JSON.stringify(rt4 && rt4.route));
      const plain = (await post('/api/route/test', { text: '随便聊聊' })).data;
      check('不带 hybrid 时仍然没有路由（自动路由是关的）', plain && plain.route === null, JSON.stringify(plain && plain.route));
      await put('/api/settings', { autoRoute: true });

      // 带附件时降级成看附件档
      const rv = (await post('/api/route/test', { text: '这图写了啥', hybrid: true, attachments: [{ kind: 'image', name: 'a.png' }] })).data;
      check('混合 + 附件 → 降级看附件（Flash）', rv && rv.route && rv.route.kind === 'vision' && rv.route.model === 'deepseek-flash',
        JSON.stringify(rv && rv.route));

      // 手动会话不该被自动路由接管，但混合模式是用户按的，应该生效
      await put('/api/settings', { hybridMode: false });
      const offRt = (await post('/api/route/test', { text: '随便聊聊', hybrid: true })).data;
      check('关掉混合后请求里带 hybrid 也不接管', offRt && (offRt.route === null || offRt.route.kind !== 'hybrid'), JSON.stringify(offRt && offRt.route));
    }

  } finally {
    await put('/api/settings', {
      apiKey: '',
      baseUrl: orig.baseUrl,
      autoRoute: orig.autoRoute !== false,
      hybridMode: orig.hybridMode === true,
      mediaTwoStage: orig.mediaTwoStage !== false,
      routeChatModel: orig.routeChatModel || 'deepseek-v4-pro',
      routeThinkModel: orig.routeThinkModel || 'deepseek-flash',
      routeHybridDraftModel: orig.routeHybridDraftModel || 'deepseek-flash',
      routeHybridModel: orig.routeHybridModel || 'deepseek-v4-pro',
      readLink: orig.readLink,
      ctxCompress: orig.ctxCompress,
      ctxRag: orig.ctxRag,
    });
    for (const id of convIds) { try { await del('/api/conversations/' + id); } catch {} }
    if (existsSync(SEQ)) await rm(SEQ).catch(() => {});
  }
}

// ---------------------------------------------------------------- 跑
console.log('1) 路由判断表（不发请求，纯看判得对不对）');
{
  // 这里只验判断函数的行为，通过 /api/route/test；服务没起时跳过
  let up = false;
  try { const r = await fetch(BASE + '/api/state', { signal: AbortSignal.timeout(800) }); up = r.ok; } catch {}
  if (!up) {
    console.log('  （服务没起，跳过判断表）');
  } else {
    await put('/api/settings', { autoRoute: true });
    const cases = [
      ['今天有点累，陪我聊两句吧。', 'chat'],
      ['这段代码为什么报错，帮我 debug 一下', 'think'],
      ['算一下 17 的阶乘是多少', 'think'],
      ['写一份给老板的周报，要有点结构', 'hybrid'],
      ['帮我把这段润色一下，再扩写', 'hybrid'],
      ['你好', 'chat'],
    ];
    for (const [text, want] of cases) {
      const r = await routeOf({ text });
      check(`${text.slice(0, 14)}… → ${want}`, r && r.kind === want, r ? `${r.kind}/${r.model}` : 'null');
    }
    const v = await routeOf({ text: '看看这张图', attachments: [{ kind: 'image', name: 'x.png' }] });
    check('带图 → 看附件（Flash）', v && v.kind === 'vision' && v.model === 'deepseek-flash', v ? `${v.kind}/${v.model}` : '');
    const t = await routeOf({ text: '随便聊聊', thinking: true });
    check('手动开了思考 → 逻辑思考档', t && t.kind === 'think', t ? t.kind : '');
  }
}

await live();

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
