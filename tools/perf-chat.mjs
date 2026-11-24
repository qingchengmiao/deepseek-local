// 量一轮对话的分段耗时：建会话 → 发一句话 → 记 SSE 各事件的到达时刻 → 删会话
// 用法：node tools\perf-chat.mjs [baseUrl] [model] [重复轮数]
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const MODEL = process.argv[3] || 'deepseek-flash';
const ROUNDS = Number(process.argv[4]) || 1;
const FIXED_CONV = process.argv[5] || ''; // 给了就用现成会话（测大历史用），最后不删

async function j(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json().catch(() => null);
}

let id = FIXED_CONV;
if (!id) {
  const created = await j('POST', '/api/conversations', { title: 'perf 探针' });
  id = created?.conversation?.id || created?.id;
  if (!id) {
    console.error('建会话失败', created);
    process.exit(1);
  }
}

for (let round = 1; round <= ROUNDS; round++) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: id,
      content: `第 ${round} 轮：用一句话说明现在几点该怎么回答我。`,
      model: MODEL,
      thinking: false,
      webSearch: false,
      readLink: false,
    }),
  });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const marks = {};
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const line = block.split('\n').find(l => l.startsWith('data:'));
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      const now = Date.now() - t0;
      if (!marks[ev.type]) marks[ev.type] = now;
      if (ev.type === 'content') text += ev.text || '';
      if (ev.type === 'done') marks.doneAt = now;
    }
  }
  console.log(JSON.stringify({
    round,
    start: marks.start ?? null,
    context: marks.context ?? null,
    firstContent: marks.content ?? null,
    done: marks.doneAt ?? null,
    chars: text.length,
    head: text.slice(0, 40).replace(/\n/g, ' '),
  }));
}

if (!FIXED_CONV) {
  await j('DELETE', `/api/conversations/${id}`);
  console.log('perf 探针会话已删：', id);
}
