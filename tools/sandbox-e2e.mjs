// 一次性沙盒端到端：装好的那份应用能聊天、能开新会话、能存盘、标题能自动生成
// 用法：node tools/sandbox-e2e.mjs [BASE]
// 依赖：BASE 指向装好的应用（默认 http://127.0.0.1:8787），上游必须是 tools/mock-upstream.mjs

const BASE = process.argv[2] || 'http://127.0.0.1:8787';

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

const j = async (path, options) => {
  const res = await fetch(BASE + path, options);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
};

// 读 SSE，收集所有事件
async function chatStream(body) {
  const res = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const events = [];
  if (!res.ok) return { status: res.status, events, raw: await res.text() };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      const line = part.split('\n').find(l => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { events.push(JSON.parse(payload)); } catch { /* 忽略半包 */ }
    }
  }
  return { status: res.status, events };
}

console.log(`沙盒端到端：${BASE}\n`);

const state = await j('/api/state');
check('应用在线', state.status === 200, `status=${state.status}`);
check('全新数据目录（0 个会话）', (state.data?.conversations || []).length === 0, `conversations=${(state.data?.conversations || []).length}`);

// 1. 先建一个会话（前端也是这么做的：POST /api/conversations → conversation.id）
const created0 = await j('/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
const convId0 = created0.data?.conversation?.id || '';
check('能新建会话', created0.status === 200 && !!convId0, convId0 || `status=${created0.status}`);

// 2. 第一轮对话（payload 与前端一致：conversationId + mode + content）
const first = await chatStream({ conversationId: convId0, mode: 'send', content: '你好，用一句话介绍你自己' });
check('发消息返回 SSE', first.status === 200, `status=${first.status}`);
const deltas = first.events.filter(e => e.type === 'content').map(e => e.text || '').join('');
check('收到流式正文', deltas.length > 0, `${deltas.length} 字：${deltas.slice(0, 30)}`);
const done1 = first.events.find(e => e.type === 'done');
check('收到 done 事件', !!done1);
check('会话已落盘（返回 conversation）', !!done1?.conversation?.id, done1?.conversation?.id || '');
const convId = done1?.conversation?.id || '';

// 2. 自动标题（mock 上游会给短标题；autoTitle 开着时第一轮后触发）
for (let i = 0; i < 40 && convId; i++) {
  await new Promise(r => setTimeout(r, 300));
  const one = await j(`/api/conversations/${convId}`);
  const title = one.data?.conversation?.title || '';
  if (title && title !== '新对话') {
    check('第一轮后自动生成标题', true, `标题「${title}」`);
    break;
  }
  if (i === 39) check('第一轮后自动生成标题', false, '40 次轮询仍是「新对话」');
}

// 3. 第二轮（带上下文）+ 校验上游收到的消息条数在增长
const second = await chatStream({ conversationId: convId, mode: 'send', content: '那我刚才问了你什么？' });
const done2 = second.events.find(e => e.type === 'done');
check('第二轮正常返回', second.status === 200 && !!done2);
const conv = (await j(`/api/conversations/${convId}`)).data?.conversation;
check('会话里累计 4 条消息', (conv?.messages || []).length === 4, `messages=${(conv?.messages || []).length}`);
const asst = (conv?.messages || []).filter(m => m.role === 'assistant');
check('助手消息带正文', asst.length > 0 && asst.every(m => (m.content || '').length > 0), `${asst.length} 条助手消息`);

// 4. 设置读写往返
const set0 = (await j('/api/settings')).data?.settings || (await j('/api/settings')).data;
const set1 = (await j('/api/settings', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ temperature: 0.42 }),
})).data;
check('设置可以写回', Math.abs((set1?.temperature ?? 0) - 0.42) < 1e-6, `temperature=${set1?.temperature}`);
await j('/api/settings', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ temperature: set0.temperature }),
});

// 5. 列表里应该是 1 个会话（第一轮那个）
const list = (await j('/api/state')).data?.conversations || [];
check('侧栏列表 1 条', list.length === 1, `conversations=${list.length}`);

// 6. 媒体/上传接口在装好这版里是通的（不上传真文件，只看路由在）
const up = await fetch(BASE + '/api/upload', { method: 'POST', body: new Uint8Array([1, 2, 3]) });
check('/api/upload 路由存在（坏请求也应回 JSON）', [200, 400, 500].includes(up.status), `status=${up.status}`);

// 7. 本地静态资源（装好的包必须自带前端）
for (const [name, path] of [['index.html', '/'], ['app.js', '/app.js'], ['styles.css', '/styles.css'], ['吉祥物图', '/assets/dsniang.png']]) {
  const r = await fetch(BASE + path);
  check(`静态资源可访问：${name}`, r.status === 200, `status=${r.status}`);
}


// 8. 全家桶事件：思考 / 联网工具 / 自动路由 / 上下文
const rich = await chatStream({ conversationId: convId0, mode: 'send', content: '帮我查一下今天的新闻，顺便讲讲理由' });
check('有思考过程事件（reasoning）', rich.events.some((e) => e.type === 'reasoning' && (e.text || '').length > 0));
check('有联网工具事件（tool started+completed）', rich.events.some((e) => e.type === 'tool' && e.event === 'started') && rich.events.some((e) => e.type === 'tool' && e.event === 'completed'));
await j("/api/settings", {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'auto' }),
});
const routed = await chatStream({ conversationId: convId0, mode: 'send', content: '这段 SQL 为什么没走索引？帮我排查一下' });
check('有自动路由事件（route）', routed.events.some((e) => e.type === 'route' && e.kind), 'status=' + routed.status + ' events=' + routed.events.map((e) => e.type).join(',') + ' raw=' + String(routed.raw || '').slice(0, 120));
check('有上下文装配事件（context）', rich.events.some((e) => e.type === 'context'));
check('有引用来源', JSON.stringify(rich.events).includes('sources'));

// 9. 拖入压缩包 -> 整理成会话（自造最小 zip，store 不压缩）
function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function makeZip(entries) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = enc.encode(e.body);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true);
    dv.setUint16(8, 0, true); dv.setUint16(10, 0, true); dv.setUint16(12, 0, true);
    dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true);
    dv.setUint16(26, name.length, true); dv.setUint16(28, 0, true);
    local.set(name, 30);
    chunks.push(local, data);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true); cv.setUint16(12, 0, true); cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true); cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true); ev.setUint16(20, 0, true);
  return Buffer.concat([...chunks, ...central, end].map((u) => Buffer.from(u)));
}
const zipBuf = makeZip([
  { name: '笔记/需求.md', body: '# 需求\n要做三件事：说话短、判断准、能干活。' },
  { name: '笔记/待办.md', body: '# 待办\n1. 验收安装包\n2. 写功能介绍' },
]);
const zipRes = await fetch(BASE + '/api/import/zip?name=' + encodeURIComponent('沙盒资料.zip'), {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: zipBuf,
});
const zipData = await zipRes.json();
check('压缩包能整理成会话', zipRes.status === 200 && (zipData.imported || []).length >= 1, String((zipData.imported || []).length) + ' 个会话');

// 10. 日历：加一条、读回来
const calAdd = await j("/api/calendar", {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: '沙盒验收', date: '2026-11-22', start: '15:00', end: '15:30', note: '来自端到端测试' }),
});
const calList = await j("/api/calendar");
check('日历能加能读', calAdd.status === 200 && JSON.stringify(calList.data).includes('沙盒验收'), 'status=' + calAdd.status);
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
