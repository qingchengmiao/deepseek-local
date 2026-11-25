// 假上游：模拟 DeepSeek 全家桶 API 的响应，用来在没 Key 的情况下验证整条链路
// 监听 8899，记录每个请求体到 data/mock-last.json
import http from 'node:http';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.env.MOCK_PORT || 8899);
const RECORD = process.env.MOCK_RECORD || path.join('data', 'mock-last.json');

const SSE_HEAD = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const SOURCE = {
  url: 'https://example.com/a',
  title: '示例来源：一个网页',
  snippet: '这是摘要片段',
  site_name: 'example.com',
  site_icon: 'https://example.com/favicon.ico',
  published_at: '2026-11-01',
  type: 'url',
};

function finalMessage() {
  return {
    id: 'mock-' + Date.now(),
    role: 'assistant',
    content: '这是第一句。 根据资料。',
    reasoning_content: '再想想，然后收尾。',
    annotations: [{ type: 'url_citation', url_citation: { url: SOURCE.url, title: SOURCE.title, start_index: 0, end_index: 12 } }],
    server_tool_calls: [
      {
        index: 0,
        reasoning_content: '第一步：先搜一下。',
        calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'deepseek_web_search',
            kind: 'search',
            action: { type: 'search', queries: ['测试查询'] },
            status: 'completed',
            sources: [SOURCE],
            signature: 'sig-mock-1',
          },
        ],
      },
    ],
  };
}

async function handleChat(req, res, body) {
  const payload = JSON.parse(body.toString('utf8') || '{}');
  await mkdir(path.dirname(RECORD), { recursive: true });
  await writeFile(RECORD, JSON.stringify({ path: req.url, body: payload }, null, 2));
  // 按请求顺序记一条流水，路由测试靠它看「综合模式是不是走了两次」
  const seqFile = process.env.MOCK_SEQ || path.join('data', 'mock-seq.json');
  let seq = [];
  try { seq = JSON.parse(await readFile(seqFile, 'utf8')); } catch {}
  if (!Array.isArray(seq)) seq = [];
  const msgs0 = Array.isArray(payload.messages) ? payload.messages : [];
  seq.push({
    n: seq.length + 1,
    model: payload.model || '',
    stream: payload.stream !== false,
    hasOutlinePrompt: msgs0.some(m => typeof m.content === 'string' && m.content.includes('只为这条请求写一份写作大纲')),
    hasOutlineBlock: msgs0.some(m => typeof m.content === 'string' && m.content.includes('【V4.1 Flash 起草的大纲】')),
    hasDigestPrompt: msgs0.some(m => typeof m.content === 'string' && m.content.includes('你在给下一轮写回答打底')),
    hasDigestBlock: msgs0.some(m => typeof m.content === 'string' && m.content.includes('【V4.1 Flash 看完这段音视频后扒出来的要点】')),
    hasImageParts: msgs0.some(m => Array.isArray(m.content) && m.content.some(b => b && b.type === 'image_url')),
    // 上下文压缩后，正常聊天请求里应该带上「【对话记忆 …】」那段 system。
    // 记进流水是因为 mock-last.json 只留最后一条，而最后一轮未必是带记忆的那一轮。
    hasMemoryBlock: msgs0.some(m => typeof m.content === 'string' && m.content.includes('【对话记忆')),
    temperature: typeof payload.temperature === 'number' ? payload.temperature : null,
    tunePrompt: (msgs0.find(m => typeof m.content === 'string' && m.content.includes('【这一轮的临时设定')) || {}).content || '',
    at: Date.now(),
  });
  await writeFile(seqFile, JSON.stringify(seq, null, 2));

  // 上下文压缩请求（context.mjs 的 MEMORY_SYSTEM 以「你是上下文压缩器」开头）
  const msgs = Array.isArray(payload.messages) ? payload.messages : [];
  const isCompress = msgs.some(m => typeof m.content === 'string' && m.content.startsWith('你是上下文压缩器'));
  if (isCompress) {
    return sendJson(res, 200, {
      id: 'mock-compact',
      object: 'chat.completion',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: '## 事实\n- 用户在做一个本地 DeepSeek 客户端\n- 测试用摘要：第 1 条到第 N 条已压缩\n\n## 决定与理由\n- 向量索引必须本地算（DeepSeek 没有 embeddings）\n\n## 偏好与要求\n- 回答要短、先给判断\n\n## 未完成\n- 真机验证麦克风',
        },
      }],
      usage: { prompt_tokens: 800, completion_tokens: 120, total_tokens: 920 },
    });
  }

  // 长期记忆概括（context.mjs 的 CONSOLIDATE_SYSTEM 以「你是长期记忆整理器」开头）
  const isConsolidate = msgs.some(m => typeof m.content === 'string' && m.content.startsWith('你是长期记忆整理器'));
  if (isConsolidate) {
    return sendJson(res, 200, {
      id: 'mock-consolidate',
      object: 'chat.completion',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: '## 长期事实\n- 用户家的蓝鲸心率每分钟八次（早段，只留结论）\n\n## 已定的事\n- 索引必须本地算\n\n## 偏好与硬要求\n- 回答要短、先给判断\n\n## 未完成\n- 真机验证麦克风\n\n## 关键词索引\n- 蓝鲸心率 → 每分钟八次\n- 索引 → 本地 BM25',
        },
      }],
      usage: { prompt_tokens: 600, completion_tokens: 110, total_tokens: 710 },
    });
  }

  if (!payload.stream) {
    return sendJson(res, 200, {
      id: 'mock',
      object: 'chat.completion',
      choices: [{ index: 0, finish_reason: 'stop', message: { ...finalMessage(), title: '测试标题' } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, server_tool_use: { tool_search: 1, tool_fetch: 0, tool_image_search: 0 } },
    });
  }

  res.writeHead(200, SSE_HEAD);
  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const delta = d => send({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: d, finish_reason: null }] });
  const toolEvent = ev => send({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, server_tool_event: ev, finish_reason: null }] });

  let closed = false;
  res.on('close', () => { closed = true; });
  const step = (ms) => new Promise(r => setTimeout(r, ms));

  const call = {
    index: 0,
    id: 'call_1',
    type: 'deepseek_web_search',
    kind: 'search',
    action: { type: 'search', queries: ['测试查询'] },
    status: 'running',
  };

  delta({ role: 'assistant', reasoning_content: '先想想这个问题。' });
  await step(20);
  toolEvent({ type: 'call_started', step: 0, call });
  await step(20);
  toolEvent({ type: 'call_completed', step: 0, call: { ...call, status: 'completed', sources: [SOURCE] } });
  await step(20);
  delta({ reasoning_content: '资料够了，开始回答。' });
  toolEvent({ type: 'step_reasoning_done', step: 0 });
  await step(20);
  delta({ content: '这是第一句。' });
  await step(30);
  delta({ content: ' 根据资料。' });
  await step(20);
  if (closed) { res.end(); return; }

  send({
    id: 'mock',
    object: 'chat.completion.chunk',
    choices: [
      {
        index: 0,
        delta: {
          ...finalMessage(),
          title: '测试标题',
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, server_tool_use: { tool_search: 1, tool_fetch: 0, tool_image_search: 0 } },
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];
  const body = await readBody(req);

  if (url === '/models') {
    return sendJson(res, 200, { object: 'list', data: [{ id: 'deepseek-flash', object: 'model' }, { id: 'deepseek-v4-pro', object: 'model' }] });
  }
  if (url === '/chat/completions' || url === '/beta/chat/completions') {
    try { return await handleChat(req, res, body); } catch (e) { return sendJson(res, 500, { error: 'mock 崩了：' + e.message }); }
  }
  if (url === '/files') {
    const text = body.toString('utf8');
    const purpose = (text.match(/name="purpose"[\s\S]*?\r?\n\r?\n([^\r\n]+)/) || [, 'user_data'])[1];
    return sendJson(res, 200, { id: 'file-api-mock', object: 'file', bytes: body.length, created_at: Math.floor(Date.now() / 1000), filename: 'mock.pdf', purpose });
  }
  if (url === '/v1/tools/asr') {
    return sendJson(res, 200, { request_id: 'mock-asr', text: '这是语音识别出来的文字', duration_ms: 1234 });
  }
  if (url === '/v1/tools/tts') {
    // 一个 44 字节的空 WAV 头
    const buf = Buffer.alloc(44 + 800);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + 800, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(24000, 24);
    buf.writeUInt32LE(48000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(800, 40);
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': buf.length });
    return res.end(buf);
  }
  sendJson(res, 404, { error: 'mock 没有这个路由：' + url });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock 上游已启动：http://127.0.0.1:${PORT}`);
});
