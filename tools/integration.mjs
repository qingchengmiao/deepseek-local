// 集成测试：把 baseUrl 指向本地假上游，验证全家桶链路（联网/思考/引用/标题/文件/语音/朗读/续写）
// 用法：先起 tools/mock-upstream.mjs，再跑这个（或直接 node tools/integration.mjs 自己拉起来）
import { liveGuard } from './_guard.mjs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
await liveGuard(BASE, 'integration');
const MOCK = 'http://127.0.0.1:8899';
const RECORD = 'data/mock-last.json';

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
const put = (path, obj) => json(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const post = (path, obj) => json(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

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

const orig = (await json('/api/settings')).data;
const child = await mockUp();

try {
  console.log('0) 指向假上游');
  {
    const s = await put('/api/settings', { apiKey: 'sk-mock-key-123456', baseUrl: MOCK, model: 'deepseek-flash', thinking: true, reasoningEffort: 'high', webSearch: true, readLink: true, autoTitle: true, safetyLevel: 'off' });
    check('settings 已指向假上游', s.data.baseUrl === MOCK && s.data.hasKey === true, s.data.baseUrl);
    const t = await post('/api/settings/test', {});
    check('测试 Key 接口能拿到模型列表', t.res.status === 200 && (t.data.models || []).length === 2, JSON.stringify(t.data.models));
  }

  console.log('1) 联网 + 深度思考一轮对话');
  let convId, assistant;
  {
    const c = await post('/api/conversations', { title: '集成测试', model: 'deepseek-flash' });
    convId = c.data.conversation.id;
    const res = await fetch(BASE + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: convId, mode: 'send', content: '查一下今天的新闻', webSearch: true, thinking: true, reasoningEffort: 'high', autoTitle: true }),
    });
    const text = await res.text();
    const evs = parseSse(text);
    const types = evs.map(e => e.type);
    check('SSE 有 start', types.includes('start'), types.join(','));
    check('SSE 有 reasoning 增量', types.includes('reasoning'));
    check('SSE 有 tool 事件（联网过程）', types.includes('tool'), `${evs.filter(e => e.type === 'tool').length} 个`);
    check('SSE 有 content 增量', types.includes('content'));
    check('SSE 有 usage', types.includes('usage'));
    check('SSE 有 title（自动起名）', evs.some(e => e.type === 'title' && e.title), evs.find(e => e.type === 'title')?.title);
    check('SSE 以 done 收尾', types[types.length - 1] === 'done', types[types.length - 1]);
    const done = evs.find(e => e.type === 'done');
    check('done 里带最终消息', !!done.message, done.message ? 'ok' : 'missing');

    const detail = await json('/api/conversations/' + convId);
    const msgs = detail.data.conversation.messages;
    assistant = msgs[msgs.length - 1];
    check('落盘 assistant 正文', assistant.content === '这是第一句。 根据资料。', JSON.stringify(assistant.content));
    check('落盘 reasoning（含工具前各步思考）', assistant.reasoning === '先想想这个问题。资料够了，开始回答。再想想，然后收尾。', JSON.stringify(assistant.reasoning));
    check('落盘 annotations（引用）', (assistant.annotations || []).length === 1, JSON.stringify(assistant.annotations?.[0]?.url_citation?.title));
    check('落盘 server_tool_calls 含来源', (assistant.serverToolCalls || [])[0]?.calls?.[0]?.sources?.length === 1, JSON.stringify(assistant.serverToolCalls?.[0]?.calls?.[0]?.sources?.[0]?.site_name));
    check('落盘 usage', assistant.usage?.prompt_tokens === 100 && assistant.usage?.completion_tokens === 50, JSON.stringify(assistant.usage));
    check('落盘 联网用量', assistant.usage?.server_tool_use?.tool_search === 1, JSON.stringify(assistant.usage?.server_tool_use));
    check('会话标题被自动改', detail.data.conversation.title === '测试标题', detail.data.conversation.title);
  }

  console.log('2) 发给上游的请求长什么样');
  {
    const rec = JSON.parse(await readFile(RECORD, 'utf8'));
    const b = rec.body;
    check('走的是 /chat/completions', rec.path === '/chat/completions', rec.path);
    check('声明了联网工具', (b.tools || []).some(t => t.type === 'deepseek_web_search'), JSON.stringify(b.tools));
    check('带 thinking.enabled', b.thinking?.type === 'enabled', JSON.stringify(b.thinking));
    check('带 reasoning_effort', b.reasoning_effort === 'high', b.reasoning_effort);
    check('带 title.enabled', b.title?.enabled === true, JSON.stringify(b.title));
    check('没带 temperature（工具模式下会被忽略）', b.temperature === undefined);
    const roles = b.messages.map(m => m.role);
    check('有 latest_reminder 且紧跟最后一条 user', roles[roles.length - 2] === 'latest_reminder' && roles[roles.length - 1] === 'user', roles.join(','));
    const reminder = b.messages[b.messages.length - 2].content;
    check('latest_reminder 格式 = 日期,星期,地点,平台,语言', /^\d{4}-\d{2}-\d{2},星期[日一二三四五六],,Web,中文$/.test(reminder), reminder);
    check('带 stream_options.include_usage', b.stream_options?.include_usage === true, JSON.stringify(b.stream_options));
  }

  console.log('3) 多轮回传 reasoning_content + server_tool_calls');
  {
    const res = await fetch(BASE + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: convId, mode: 'send', content: '继续说说', webSearch: true }),
    });
    await res.text();
    const rec = JSON.parse(await readFile(RECORD, 'utf8'));
    const asst = rec.body.messages.filter(m => m.role === 'assistant');
    check('历轮 assistant 带回 reasoning_content', asst.some(m => m.reasoning_content), JSON.stringify(asst.map(m => Object.keys(m))));
    check('历轮 assistant 带回 server_tool_calls', asst.some(m => Array.isArray(m.server_tool_calls) && m.server_tool_calls.length), 'ok');
    check('signature 保留（网页正文能进上下文）', asst.some(m => JSON.stringify(m.server_tool_calls || '').includes('sig-mock-1')), 'ok');
  }

  console.log('4) 继续生成（beta + prefix）');
  {
    const imp = await post('/api/import', { filename: 'poem.json', data: { messages: [{ role: 'user', content: '写首诗' }, { role: 'assistant', content: '床前明月光' }] } });
    const id = imp.data.imported[0].id;
    const res = await fetch(BASE + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: id, mode: 'continue' }),
    });
    const text = await res.text();
    const evs = parseSse(text);
    const rec = JSON.parse(await readFile(RECORD, 'utf8'));
    check('continue 走 /beta/chat/completions', rec.path === '/beta/chat/completions', rec.path);
    const lastMsg = rec.body.messages[rec.body.messages.length - 1];
    check('最后一条 assistant 带 prefix: true', lastMsg.role === 'assistant' && lastMsg.prefix === true, JSON.stringify({ role: lastMsg.role, prefix: lastMsg.prefix }));
    check('continue 不声明工具', !rec.body.tools || rec.body.tools.length === 0, JSON.stringify(rec.body.tools || []));
    check('continue 有输出', evs.some(e => e.type === 'content'), evs.map(e => e.type).join(','));
    const detail = await json('/api/conversations/' + id);
    const last = detail.data.conversation.messages[detail.data.conversation.messages.length - 1];
    check('续写内容接在原回答后面', last.role === 'assistant' && last.content.includes('这是第一句'), JSON.stringify(last.content).slice(0, 60));
    await json('/api/conversations/' + id, { method: 'DELETE' });
  }

  console.log('5) 上传（图片走 base64，文档走 Files API）');
  let imgUpload;
  {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const r = await fetch(BASE + '/api/upload', { method: 'POST', headers: { 'Content-Type': 'image/png', 'x-filename': 'mock.png' }, body: png });
    imgUpload = await r.json();
    check('图片上传 200', r.status === 200, JSON.stringify(imgUpload));
    check('识别为图片', imgUpload.kind === 'image', imgUpload.kind);
    check('有可访问的本地 URL', imgUpload.url?.startsWith('/api/uploads/'), imgUpload.url);
    const got = await fetch(BASE + imgUpload.url);
    check('上传文件能取回', got.status === 200 && (await got.arrayBuffer()).byteLength === png.length);

    const pdf = Buffer.from('%PDF-1.4 mock pdf bytes');
    const r2 = await fetch(BASE + '/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'x-filename': 'mock.pdf' }, body: pdf });
    const up2 = await r2.json();
    check('文档上传走 Files API', r2.status === 200 && up2.fileId === 'file-api-mock', JSON.stringify(up2));
    check('pdf 用 text_recognition 解析', up2.purpose === 'text_recognition', up2.purpose);

    const txt = Buffer.from('# 标题\n\n正文');
    const r3 = await fetch(BASE + '/api/upload', { method: 'POST', headers: { 'Content-Type': 'text/markdown', 'x-filename': 'note.md' }, body: txt });
    const up3 = await r3.json();
    check('md 用 user_data（转 Markdown，不计费）', up3.purpose === 'user_data', up3.purpose);
  }

  console.log('6) 带图片发一轮（验证 content 块数组）');
  {
    const c = await post('/api/conversations', { title: '图片测试', model: 'deepseek-flash' });
    const id = c.data.conversation.id;
    const res = await fetch(BASE + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: id, mode: 'send', content: '这张图是什么',
        attachments: [{ uploadId: imgUpload.uploadId, name: imgUpload.name, mime: imgUpload.mime, size: imgUpload.size, kind: 'image' }],
      }),
    });
    await res.text();
    const rec = JSON.parse(await readFile(RECORD, 'utf8'));
    const last = rec.body.messages[rec.body.messages.length - 1];
    check('user content 是块数组', Array.isArray(last.content), typeof last.content);
    check('含 image_url 且是 data URI', JSON.stringify(last.content).includes('"image_url"') && JSON.stringify(last.content).includes('data:image/png;base64'), JSON.stringify(last.content).slice(0, 120));
    const detail = await json('/api/conversations/' + id);
    const userMsg = detail.data.conversation.messages.find(m => m.role === 'user');
    check('附件落盘在消息里', (userMsg.attachments || []).length === 1, JSON.stringify(userMsg.attachments?.[0]?.name));
    await json('/api/conversations/' + id, { method: 'DELETE' });
  }

  console.log('7) 语音识别');
  {
    const wav = Buffer.alloc(2048);
    wav.write('RIFF', 0); wav.write('WAVE', 8);
    const r = await fetch(BASE + '/api/asr', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
    const data = await r.json();
    check('ASR 200', r.status === 200, JSON.stringify(data));
    check('ASR 返回文字', data.text === '这是语音识别出来的文字', data.text);
    check('ASR 返回时长', data.durationMs === 1234, String(data.durationMs));
  }

  console.log('8) 朗读（TTS 音频流）');
  {
    const r = await fetch(BASE + '/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '你好，世界', voiceId: 'stella' }) });
    const buf = Buffer.from(await r.arrayBuffer());
    check('TTS 200', r.status === 200, String(r.status));
    check('返回 audio/wav', (r.headers.get('content-type') || '').includes('audio/wav'), r.headers.get('content-type'));
    check('有音频字节', buf.length > 44 && buf.subarray(0, 4).toString() === 'RIFF', `${buf.length}B`);
  }

  console.log('9) 内容安全开启时参数正确');
  {
    await put('/api/settings', { webSearch: false, readLink: false });
    const c = await post('/api/conversations', { title: '安全测试', model: 'deepseek-flash' });
    const res = await fetch(BASE + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: c.data.conversation.id, mode: 'send', content: '你好', safetyLevel: 'high', autoTitle: true, thinking: false }),
    });
    await res.text();
    const rec = JSON.parse(await readFile(RECORD, 'utf8'));
    check('带 safety_check.level', rec.body.safety_check?.level === 'high', JSON.stringify(rec.body.safety_check));
    check('带 title.enabled', rec.body.title?.enabled === true, JSON.stringify(rec.body.title));
    check('思考关闭时 thinking 显式 disabled', rec.body.thinking?.type === 'disabled', JSON.stringify(rec.body.thinking));
    check('采样参数被忽略时不带 temperature', rec.body.temperature === undefined, String(rec.body.temperature));
    await json('/api/conversations/' + c.data.conversation.id, { method: 'DELETE' });
  }

  await json('/api/conversations/' + convId, { method: 'DELETE' });
} finally {
  // 恢复原设置（Key 本身不打印；原来有 Key 时不传 apiKey 字段，避免把真 Key 覆盖掉）
  const restore = {
    baseUrl: orig.baseUrl,
    model: orig.model || 'deepseek-flash',
    webSearch: !!orig.webSearch,
    readLink: orig.readLink !== false,
    autoTitle: orig.autoTitle !== false,
    safetyLevel: orig.safetyLevel || 'off',
    thinking: orig.thinking !== false,
    reasoningEffort: orig.reasoningEffort || 'high',
  };
  if (!orig.hasKey) restore.apiKey = '';
  await put('/api/settings', restore);
  if (child) { try { process.kill(-child.pid); } catch { try { child.kill(); } catch {} } }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
