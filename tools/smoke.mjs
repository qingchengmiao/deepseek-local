import { liveGuard } from './_guard.mjs';
// 冒烟测试：逐项打接口，看关键路径是否通
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
await liveGuard(BASE, 'smoke');

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

async function json(path, opts) {
  const res = await fetch(BASE + path, opts);
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  return { res, data };
}

console.log('1) 静态资源与页面');
{
  const r = await fetch(BASE + '/');
  const html = await r.text();
  check('GET / 返回页面', r.status === 200 && html.includes('composer'), `${r.status} ${html.length}B`);
  for (const p of ['/styles.css', '/app.js', '/md.js', '/vendor/katex.min.js', '/vendor/katex.min.css', '/vendor/highlight.min.js', '/vendor/fonts/KaTeX_Main-Regular.woff2', '/vendor/fonts/KaTeX_Size2-Regular.woff2']) {
    const rr = await fetch(BASE + p);
    check(`静态 ${p}`, rr.status === 200, `${rr.status} ${rr.headers.get('content-length') || ''}`);
  }
  const spa = await fetch(BASE + '/some/deep/route');
  check('SPA 兜底', spa.status === 200 && (await spa.text()).includes('<div id="app"'));
}

console.log('2) /api/state');
let state;
{
  const { res, data } = await json('/api/state');
  state = data;
  check('state 200', res.status === 200);
  check('state.version = 2', data.version === 2, String(data.version));
  const titles = data.conversations.map(c => c.title);
  check('两个导入会话都在', titles.includes('AI摸鱼写游戏') && titles.includes('战地1弹震症士兵'), JSON.stringify(data.conversations.map(c => [c.title, c.messageCount])));
  check('apiKey 是掩码', data.settings.apiKey === '' && data.settings.hasKey === false, JSON.stringify(data.settings.apiKey));
  check('默认模型是自动或具体模型', ['auto', 'deepseek-flash', 'deepseek-v4-pro'].includes(data.settings.model), data.settings.model);
  check('模型列表 ≥ 2 个', Array.isArray(data.models) && data.models.length >= 2, (data.models || []).map(m => m.id).join(','));
  check('语言清单存在', Array.isArray(data.languages) && data.languages.includes('中文'), `${(data.languages || []).length} 种`);
  check('统计有数据', data.stats.messages > 5000, `${data.stats.messages} 条 / ${data.stats.chars} 字 / tokens=${data.stats.tokens}`);
}

// 挑「战地1弹震症士兵」这条长会话做详情/导出/分支的靶子（不依赖列表顺序）
const convId = (state.conversations.find(c => c.title === '战地1弹震症士兵') || state.conversations[0]).id;

console.log('3) 会话详情');
{
  const { res, data } = await json('/api/conversations/' + convId);
  check('详情 200', res.status === 200);
  check('消息数一致', data.conversation.messageCount === undefined ? data.conversation.messages.length === state.conversations.find(c => c.id === convId).messageCount : true, String(data.conversation.messages.length));
  const withReasoning = data.conversation.messages.filter(m => m.reasoning).length;
  check('含深度思考消息', withReasoning > 100, `${withReasoning} 条`);
  const bad = await json('/api/conversations/not-exist');
  check('不存在的会话 404', bad.res.status === 404);
}

console.log('4) 搜索');
{
  const { res, data } = await json('/api/search?q=' + encodeURIComponent('弹震症'));
  check('搜索 200', res.status === 200);
  check('有命中', data.hits.length > 0, `${data.hits.length} 条，首条：${(data.hits[0]?.snippet || '').slice(0, 40)}`);
  const none = await json('/api/search?q=' + encodeURIComponent('这个词一定不存在zzzq'));
  check('无命中返回空', none.data.hits.length === 0);
}

console.log('5) 导出');
{
  const md = await fetch(BASE + `/api/conversations/${convId}/export?format=md`);
  const text = await md.text();
  check('Markdown 导出', md.status === 200 && text.startsWith('# ') && text.length > 1000, `${text.length} 字`);
  check('带下载头', (md.headers.get('content-disposition') || '').includes('attachment'));
  const js = await fetch(BASE + `/api/conversations/${convId}/export?format=json`);
  const j = await js.json();
  check('JSON 导出', js.status === 200 && Array.isArray(j.messages));
}

console.log('6) 无 Key 时发消息 → NO_KEY');
{
  const { res, data } = await json('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: convId, mode: 'send', content: '测试' }),
  });
  check('返回 400', res.status === 400, String(res.status));
  check('code = NO_KEY', data.code === 'NO_KEY', data.error);
}

console.log('7) 新建 / 改标题 / 置顶 / 删除');
let tmpId;
{
  const c = await json('/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '临时测试' }) });
  tmpId = c.data.conversation.id;
  check('新建会话', c.res.status === 200 && c.data.conversation.title === '临时测试');
  const p = await json('/api/conversations/' + tmpId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '改过的标题', pinned: true }) });
  check('PATCH 标题+置顶', p.data.conversation.title === '改过的标题' && p.data.conversation.pinned === true);
  check('置顶排在最前', p.data.conversations[0].id === tmpId, p.data.conversations.map(x => x.title).join(' / '));
  const d = await json('/api/conversations/' + tmpId, { method: 'DELETE' });
  check('删除会话', d.res.status === 200 && !d.data.conversations.some(x => x.id === tmpId));
}

console.log('8) 错误 Key → 优雅报错（不崩）');
{
  await json('/api/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: 'sk-invalid-test-key-000000000000' }),
  });
  const c = await json('/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '错误key测试' }) });
  const id = c.data.conversation.id;
  const res = await fetch(BASE + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: id, mode: 'send', content: '你好' }),
  });
  const raw = await res.text();
  check('SSE 打开且收到错误事件', raw.includes('"type":"start"') && raw.includes('"type":"error"'), raw.replace(/\n/g, ' ').slice(0, 220));
  const after = await json('/api/conversations/' + id);
  check('用户消息保留、无空气泡', after.data.conversation.messages.length === 1 && after.data.conversation.messages[0].role === 'user', `剩 ${after.data.conversation.messages.length} 条`);
  await json('/api/conversations/' + id, { method: 'DELETE' });
  await json('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: '' }) });
  const back = await json('/api/state');
  check('Key 已清空', back.data.settings.hasKey === false);
}

console.log('9) 导入形状容错');
{
  const shapes = [
    { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello', reasoning: '想了下' }] },
    { data: { messages: [{ role: 'user', content: '来自 data.messages' }] } },
    [{ role: 'user', content: '裸数组消息' }, { role: 'assistant', content: '收到' }],
    { messages: [{ role: 'human', content: 'human 角色' }, { role: 'model', content: 'model 角色', thinking: '想了想' }] },
  ];
  let ids = [];
  for (const [i, shape] of shapes.entries()) {
    const r = await json('/api/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: `shape-${i}.json`, data: shape }),
    });
    check(`形状 ${i} 导入`, r.res.status === 200 && r.data.imported.length === 1, JSON.stringify(r.data.imported?.[0] || r.data.error));
    if (r.data.imported) ids.push(r.data.imported[0].id);
  }
  const one = await json('/api/conversations/' + ids[3]);
  check('thinking 映射成 reasoning', one.data.conversation.messages[1].reasoning === '想了想', JSON.stringify(one.data.conversation.messages[1]));
  for (const id of ids) await json('/api/conversations/' + id, { method: 'DELETE' });
}

console.log('10) 分支');
{
  const { data } = await json('/api/conversations/' + convId);
  const mid = data.conversation.messages[10].id;
  const f = await json(`/api/conversations/${convId}/fork`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messageId: mid }),
  });
  check('分支成功', f.res.status === 200 && f.data.conversation.messages.length === 11, `${f.data.conversation.messages.length} 条`);
  await json('/api/conversations/' + f.data.conversation.id, { method: 'DELETE' });
}

console.log('11) 删除消息（user+assistant 成对）');
{
  const c = await json('/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  const id = c.data.conversation.id;
  // 直接构造会话文件内容：没有写接口，用导入代替
  await json('/api/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'pair.json', data: { messages: [
      { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
    ] } }),
  });
  const list = await json('/api/state');
  const pair = list.data.conversations.find(x => x.title === 'pair');
  const full = await json('/api/conversations/' + pair.id);
  const q1 = full.data.conversation.messages[0];
  const d = await json(`/api/conversations/${pair.id}/messages/${q1.id}`, { method: 'DELETE' });
  check('删掉 q1 连带 a1', d.data.conversation.messages.length === 2 && d.data.conversation.messages[0].content === 'q2', d.data.conversation.messages.map(m => m.content).join(','));
  await json('/api/conversations/' + pair.id, { method: 'DELETE' });
  await json('/api/conversations/' + id, { method: 'DELETE' });
}

console.log('12) 设置测试接口（无 key 应报错）');
{
  const r = await json('/api/settings/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  check('无 key 测试返回 400', r.res.status === 400, r.data.error);
}

console.log('13) 全家桶接口');
{
  const m = await json('/api/models');
  check('GET /api/models', m.res.status === 200 && m.data.models.length >= 2, m.data.models.map(x => x.id).join(','));

  const up = await json('/api/upload', { method: 'POST', headers: { 'Content-Type': 'image/png', 'x-filename': 'x.png' }, body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
  check('无 key 上传 → NO_KEY', up.res.status === 400 && up.data.code === 'NO_KEY', up.data.error);

  const asr = await json('/api/asr', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: Buffer.alloc(1024) });
  check('无 key 语音识别 → NO_KEY', asr.res.status === 400 && asr.data.code === 'NO_KEY', asr.data.error);

  const tts = await json('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '你好' }) });
  check('无 key 朗读 → NO_KEY', tts.res.status === 400 && tts.data.code === 'NO_KEY', tts.data.error);

  const cont = await json('/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: convId, mode: 'continue' }),
  });
  check('无 key 继续生成 → NO_KEY', cont.res.status === 400 && cont.data.code === 'NO_KEY', cont.data.error);

  const bad = await json('/api/upload', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'x-filename': 'a.txt' }, body: 'x' });
  check('上传非法文件也有明确报错', bad.res.status >= 400 && !!bad.data.error, bad.data.error);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
