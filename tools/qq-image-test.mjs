// QQ 入站图片：验证「对方从 QQ 发一张图，模型真的看得到」这条链。
// 手法：假 OneBot（history 里给一段 image）+ 本地假图 + 假上游记录 payload + 隔离实例。
// 用法：node tools/qq-image-test.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const APP = path.resolve('.');
const PORT = Number(process.env.TEST_PORT || 18943);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.resolve('data/_qq_image_test');
const OB_PORT = Number(process.env.OB_PORT || 18944);
const UP_PORT = Number(process.env.UP_PORT || 18945);

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const json = async (p, opt = {}) => {
  const body = opt.body && typeof opt.body !== 'string' ? JSON.stringify(opt.body) : opt.body;
  const r = await fetch(BASE + p, { headers: { 'Content-Type': 'application/json' }, ...opt, body });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

// ---------------------------------------------------------------- 一张真 PNG（16x16 纯色）
function makePng(w = 16, h = 16, rgb = [128, 0, 128]) {
  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body), 0);
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // truecolor
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    row[0] = 0;
    for (let x = 0; x < w; x++) {
      row[1 + x * 3] = rgb[0];
      row[2 + x * 3] = rgb[1];
      row[3 + x * 3] = rgb[2];
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const PNG = makePng();

// ---------------------------------------------------------------- 假 OneBot
const ob = { msgId: 7001, sent: [], history: [], asks: [] };
let obServer = null;
function startOnebot() {
  obServer = http.createServer(async (req, res) => {
    if (req.url === '/img.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length });
      return res.end(PNG);
    }
    if (req.url === '/wrong.png') {
      // 内容其实是 PNG，但 content-type 谎称 jpeg —— 必须按文件头认，不能信它
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': PNG.length });
      return res.end(PNG);
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
    const action = req.url.replace(/^\//, '').split('?')[0];
    ob.asks.push({ action, body });
    const ok = (data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
    };
    if (action === 'get_login_info') return ok({ user_id: 3810187208, nickname: 'delta' });
    if (action === 'get_friend_msg_history') return ok({ messages: ob.history });
    if (action === 'send_private_msg') { ob.sent.push(body); return ok({ message_id: 9000 + ob.sent.length }); }
    if (action === 'get_image') {
      // 真实 NapCat 会给本地文件路径；这里故意只给 url，验「拿不到本地就退回直链」
      return ok({ file: `http://127.0.0.1:${OB_PORT}/img.png` });
    }
    return ok({});
  });
  return new Promise((resolve, reject) => {
    obServer.once('error', reject);
    obServer.listen(OB_PORT, '127.0.0.1', resolve);
  });
}
// ---------------------------------------------------------------- 假上游（记录 payload）
const up = { payloads: [], answer: '图看到了，紫色方块' };
let upServer = null;
function startUpstream() {
  upServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (req.url === '/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }));
    }
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch {}
    up.payloads.push({ url: req.url, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'x', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: up.answer }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  });
  return new Promise((resolve, reject) => {
    upServer.once('error', reject);
    upServer.listen(UP_PORT, '127.0.0.1', resolve);
  });
}

// ---------------------------------------------------------------- 隔离实例
let srv = null;
async function startApp() {
  await rm(DATA, { recursive: true, force: true });
  await mkdir(DATA, { recursive: true });
  srv = spawn(process.execPath, ['server.mjs'], {
    cwd: APP,
    env: { ...process.env, PORT: String(PORT), DSAPP_DATA: DATA },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 250));
    try {
      const r = await fetch(BASE + '/api/state', { signal: AbortSignal.timeout(800) });
      if (r.ok) return;
    } catch {}
  }
  throw new Error('实例起不来');
}

try {
  await startUpstream();
  await startOnebot();
  await startApp();

  // 设置：假上游 + 假 OneBot + 绑定对象 + 自动回复
  const put = await json('/api/settings', {
    method: 'PUT',
    body: {
      apiKey: 'sk-local-test', baseUrl: `http://127.0.0.1:${UP_PORT}`,
      qqBaseUrl: `http://127.0.0.1:${OB_PORT}`, qqUid: '3979605697',
      qqMode: 'both', qqPollMs: 600000, qqCallName: '青',
      learnAuto: false, autoTitle: false,
    },
  });

  check('设置写进去了', put.status === 200 && put.data.hasKey !== false, put.status + ' ' + JSON.stringify(put.data).slice(0, 140));

  console.log('\n1. 冷启动（历史全算已读，不补答）');
  ob.history = [{ message_id: ob.msgId, time: Math.floor(Date.now() / 1000), sender: { user_id: 3979605697, nickname: '青' }, message: [{ type: 'text', data: { text: '早' } }] }];
  const warm = await json('/api/qq/poll', { method: 'POST', body: {} });
  check('冷启动 warm-start', warm.data.ok && (warm.data.skipped === 'warm-start' || warm.data.fresh === 0), JSON.stringify(warm.data).slice(0, 120));

  console.log('\n2. 对方发一张图');
  ob.msgId += 1;
  ob.history.push({
    message_id: ob.msgId,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: 3979605697, nickname: '青' },
    message: [
      { type: 'text', data: { text: '这个颜色好看吗' } },
      { type: 'image', data: { file: 'abc.image', url: `http://127.0.0.1:${OB_PORT}/img.png`, summary: '[图片]' } },
    ],
  });
  const poll = await json('/api/qq/poll', { method: 'POST', body: {} });
  check('poll 返回有回复', poll.data.ok && poll.data.replied >= 1, JSON.stringify(poll.data).slice(0, 160));

  console.log('\n3. 图片落成附件');
  const state = await json('/api/state');
  const convId = state.data.settings?.qqConvId;
  check('拿到 QQ 会话 id', !!convId, convId);
  const hist = await json('/api/conversations/' + convId);
  const msgs = hist.data.conversation?.messages || [];
  const withAtt = msgs.filter(m => (m.attachments || []).some(a => a.kind === 'image'));
  check('会话里有带图的用户消息', withAtt.length === 1, `${withAtt.length} 条`);
  const att = withAtt[0]?.attachments?.find(a => a.kind === 'image');
  check('附件有 uploadId', !!att?.uploadId, att?.uploadId);
  check('附件有 url', /^\/api\/uploads\//.test(att?.url || ''), att?.url);
  check('附件 mime 是 image/png', att?.mime === 'image/png', att?.mime);
  check('附件 size 是图的实际大小', att?.size === PNG.length, `${att?.size} vs ${PNG.length}`);
  const fileOnDisk = await readFile(path.join(DATA, 'uploads', path.basename(att?.uploadId || 'x'))).catch(() => null);
  check('图片真的写进 uploads', !!fileOnDisk && fileOnDisk.equals(PNG), `${fileOnDisk?.length} 字节`);
  const served = await fetch(BASE + att.url);
  check('GET /api/uploads/... 能取回', served.status === 200 && (await served.arrayBuffer()).byteLength === PNG.length, String(served.status));

  console.log('\n4. 模型确实收到了图');
  const last = up.payloads.filter(p => p.url.includes('chat')).pop();
  check('上游收到 chat 请求', !!last, last?.body?.model);
  const parts = (last?.body?.messages || []).flatMap(m => (Array.isArray(m.content) ? m.content : []));
  const imgPart = parts.find(p => p.type === 'image_url');
  check('请求里有 image_url 块', !!imgPart, imgPart ? String(imgPart.image_url?.url || '').slice(0, 40) : '');
  check('image_url 是 base64 data url', /^data:image\/png;base64,/.test(imgPart?.image_url?.url || ''), '');
  check('带图时走能看图的模型（flash）', /flash/i.test(String(last?.body?.model || '')), last?.body?.model);

  console.log('\n5. 回给对方的文字还是分条发');
  check('发回去了', ob.sent.length >= 1, `${ob.sent.length} 条`);

  console.log('\n6. 纯文字消息不被当成图');
  const before = up.payloads.filter(p => p.url.includes('chat')).length;
  ob.msgId += 1;
  ob.history.push({
    message_id: ob.msgId, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 3979605697, nickname: '青' },
    message: [{ type: 'text', data: { text: '那明天见' } }],
  });
  await json('/api/qq/poll', { method: 'POST', body: {} });
  const chats = up.payloads.filter(p => p.url.includes('chat'));
  check('又多了一次 chat', chats.length === before + 1, `${before} -> ${chats.length}`);
  // 历史里那张图的 image_url 还会带着（靠模型看上下文），这里只看「最后一条 user 消息」
  const msgs2 = chats[chats.length - 1]?.body?.messages || [];
  const lastUser = [...msgs2].reverse().find(m => m.role === 'user');
  const lastParts = Array.isArray(lastUser?.content) ? lastUser.content : [];
  check('最后一条 user 消息没有 image_url', !lastParts.find(p => p.type === 'image_url'), lastUser ? String(lastUser.content).slice(0, 30) : '');
  console.log('\n7. content-type 撒谎时按文件头认类型');
  ob.msgId += 1;
  ob.history.push({
    message_id: ob.msgId, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 3979605697, nickname: '青' },
    message: [{ type: 'image', data: { file: 'wrong.image', url: `http://127.0.0.1:${OB_PORT}/wrong.png` } }],
  });
  await json('/api/qq/poll', { method: 'POST', body: {} });
  const hist2 = await json('/api/conversations/' + convId);
  const imgs = (hist2.data.conversation?.messages || []).flatMap(m => (m.attachments || []).filter(a => a.kind === 'image'));
  const lastImg = imgs[imgs.length - 1];
  check('存下来的 mime 是 image/png（按字节认，不信 jpeg 的谎）', lastImg?.mime === 'image/png', lastImg?.mime);
  const chats3 = up.payloads.filter(p => p.url.includes('chat'));
  const parts3 = (chats3[chats3.length - 1]?.body?.messages || []).flatMap(m => (Array.isArray(m.content) ? m.content : []));
  const img3 = parts3.filter(p => p.type === 'image_url').pop();
  check('发给上游的 data url 也是 png', /^data:image\/png;base64,/.test(img3?.image_url?.url || ''), String(img3?.image_url?.url || '').slice(0, 32));
} catch (e) {
  fail += 1;
  console.log('  ✗ 异常：' + e.message);
} finally {
  try { srv?.kill(); } catch {}
  try { obServer?.close(); } catch {}
  try { upServer?.close(); } catch {}
  await new Promise(r => setTimeout(r, 400));
  await rm(DATA, { recursive: true, force: true }).catch(() => {});
  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
