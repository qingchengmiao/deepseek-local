// QQ 通道（OneBot 11 HTTP）：假后端 + 真服务端整链路
// 用法：node tools/qq-test.mjs   （先起服务：node server.mjs）
import { liveGuard } from './_guard.mjs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
await liveGuard(BASE, 'qq-test');
const MOCK_API = 'http://127.0.0.1:8899';
const ONEBOT_PORT = 3100;

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function j(pathname, opts = {}) {
  const r = await fetch(BASE + pathname, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

// ---------------------------------------------------------------- 假 OneBot 后端
const ob = {
  server: null,
  received: [],   // 收到的 action 调用
  private: [],    // send_private_msg 历史
  group: [],      // send_group_msg 历史
  friendMsgs: [], // get_friend_msg_history 返回
  groupMsgs: [],  // get_group_msg_history 返回
  loginNick: '测试号',
  loginUid: 3979605697,
  fail: false,
};

function onebotMock() {
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch {}
    const action = req.url.replace(/^\//, '').split('?')[0];
    ob.received.push({ action, body });
    const ok = (data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
    };
    if (ob.fail) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'failed', retcode: 100, message: '假后端被要求失败' }));
    }
    if (action === 'get_login_info') return ok({ user_id: ob.loginUid, nickname: ob.loginNick });
    if (action === 'send_private_msg') {
      ob.private.push(body);
      return ok({ message_id: 1000 + ob.private.length });
    }
    if (action === 'send_group_msg') {
      ob.group.push(body);
      return ok({ message_id: 2000 + ob.group.length });
    }
    if (action === 'get_friend_msg_history') return ok({ messages: ob.friendMsgs });
    if (action === 'get_group_msg_history') return ok({ messages: ob.groupMsgs });
    return ok({});
  });
}

async function startOnebot() {
  ob.server = onebotMock();
  await new Promise((resolve, reject) => {
    ob.server.once('error', reject);
    ob.server.listen(ONEBOT_PORT, '127.0.0.1', resolve);
  });
}
async function stopOnebot() {
  if (!ob.server) return;
  await new Promise(r => ob.server.close(r));
  ob.server = null;
}

const RUN = Date.now().toString(36);
function inbound({ id, uid = 88888888, nick = '小明', text = '', at = Date.now(), group = 0 }) {
  return {
    message_id: id,
    time: Math.floor(at / 1000),
    message_type: group ? 'group' : 'private',
    group_id: group || undefined,
    sender: { user_id: uid, nickname: nick, card: nick },
    message: [{ type: 'text', data: { text } }],
  };
}

async function ensureMockApi() {
  try {
    const r = await fetch(MOCK_API + '/models', { signal: AbortSignal.timeout(700) });
    if (r.ok) return true;
  } catch {}
  const child = spawn(process.execPath, ['tools/mock-upstream.mjs'], { stdio: 'ignore', detached: true });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250));
    try {
      const r = await fetch(MOCK_API + '/models', { signal: AbortSignal.timeout(600) });
      if (r.ok) return true;
    } catch {}
  }
  return false;
}

let savedSettings = null;
const touchedConvs = [];

async function restore() {
  await stopOnebot();
  if (savedSettings) {
    await j('/api/settings', {
      method: 'PUT',
      body: {
        apiKey: '',
        baseUrl: savedSettings.baseUrl,
        qqMode: savedSettings.qqMode,
        qqBaseUrl: savedSettings.qqBaseUrl,
        qqUid: savedSettings.qqUid,
        qqGroup: savedSettings.qqGroup,
        qqPollMs: savedSettings.qqPollMs,
        qqConvId: savedSettings.qqConvId,
        qqCallName: savedSettings.qqCallName,
        autoTitle: savedSettings.autoTitle,
        safetyLevel: savedSettings.safetyLevel,
      },
    }).catch(() => {});
  }
  for (const id of touchedConvs) await j('/api/conversations/' + id, { method: 'DELETE' }).catch(() => {});
  // 顺手清掉历次跑测试留下的 QQ 会话
  const all = await j('/api/state').catch(() => ({ data: {} }));
  for (const c of all.data?.conversations || []) {
    if (c.source === 'qq') await j('/api/conversations/' + c.id, { method: 'DELETE' }).catch(() => {});
  }
}

try {
  console.log('\n1. 后端没起来时的表现');
  {
    savedSettings = (await j('/api/settings')).data;
    check('读到当前设置', !!savedSettings?.qqBaseUrl, savedSettings?.qqBaseUrl);
    // 先把 qqBaseUrl 指到一个没人监听的端口
    await j('/api/settings', { method: 'PUT', body: { qqBaseUrl: `http://127.0.0.1:${ONEBOT_PORT + 7}`, qqUid: '', qqGroup: '', qqMode: 'off' } });
    const st = await j('/api/qq/state');
    check('GET /api/qq/state 200', st.status === 200 && st.data.mode === 'off');
    const t = await j('/api/qq/test', { method: 'POST', body: {} });
    check('后端连不上时 test 返回 ok:false', t.status === 200 && t.data.ok === false, String(t.data.info?.error || '').slice(0, 40));
    const poll = await j('/api/qq/poll', { method: 'POST', body: {} });
    check('mode=off 时 poll 跳过', poll.status === 200 && poll.data.skipped === 'mode-off', poll.data.skipped);
    const send = await j('/api/qq/send', { method: 'POST', body: { text: 'hi' } });
    check('没填号码发送 400', send.status === 400 && /号码|私聊/.test(String(send.data.error)), String(send.data.error));
  }

  console.log('\n2. 假 OneBot 后端：登录 / 只发');
  {
    await startOnebot();
    await j('/api/settings', { method: 'PUT', body: { qqBaseUrl: `http://127.0.0.1:${ONEBOT_PORT}`, qqUid: String(ob.loginUid), qqMode: 'send', qqPollMs: 2000 } });
    const t = await j('/api/qq/test', { method: 'POST', body: {} });
    check('test 连上假后端', t.status === 200 && t.data.ok === true, `${t.data.info?.nick} / ${t.data.info?.uid}`);
    check('昵称与号对得上', t.data.info?.uid === String(ob.loginUid) && t.data.info?.nick === ob.loginNick);

    const st = await j('/api/qq/state');
    check('state 带 mode/baseUrl/uid', st.data.mode === 'send' && st.data.baseUrl.includes(String(ONEBOT_PORT)) && st.data.uid === String(ob.loginUid));

    ob.private.length = 0;
    const s = await j('/api/qq/send', { method: 'POST', body: { text: '来自本机的一条' } });
    check('私聊发送 200', s.status === 200 && s.data.to === 'private' && !!s.data.messageId, JSON.stringify(s.data));
    check('假后端收到 send_private_msg', ob.private.length === 1 && ob.private[0].user_id === ob.loginUid);
    check('文本走 message 段', ob.private[0]?.message?.[0]?.type === 'text' && ob.private[0].message[0].data.text === '来自本机的一条');

    const st2 = await j('/api/qq/state');
    check('state 记了发送数与最近记录', st2.data.sent >= 1 && (st2.data.recent || []).some(r => r.dir === 'out'));
  }

  console.log('\n3. 收消息（只发模式不回话 / 去重）');
  {
    const now = Date.now();
    ob.friendMsgs = [
      inbound({ id: 'm1-' + RUN, text: '在吗', at: now - 60000 }),
      inbound({ id: 'm2-' + RUN, text: '帮我看下这个', at: now - 1000 }),
      // 自己发的应该被过滤
      inbound({ id: 'm3-' + RUN, uid: ob.loginUid, nick: '我', text: '我自己', at: now - 500 }),
    ];
    const before = ob.private.length;
    const p1 = await j('/api/qq/poll', { method: 'POST', body: {} });
    check('收到 2 条（过滤掉自己）', p1.status === 200 && p1.data.fresh === 2, JSON.stringify({ fresh: p1.data.fresh, replied: p1.data.replied }));
    check('只发模式不回复', p1.data.replied === 0 && ob.private.length === before, `private ${before} → ${ob.private.length}`);
    const p2 = await j('/api/qq/poll', { method: 'POST', body: {} });
    check('再收一次不重复', p2.data.fresh === 0, String(p2.data.fresh));
  }

  console.log('\n4. 收发模式：收进来跑一轮再回过去（假上游）');
  {
    const apiOk = await ensureMockApi();
    check('假上游可用', apiOk, MOCK_API);
    if (apiOk) {
      await j('/api/settings', { method: 'PUT', body: { apiKey: 'sk-mock-qq-test', baseUrl: MOCK_API, qqMode: 'both', qqUid: String(ob.loginUid), qqBaseUrl: `http://127.0.0.1:${ONEBOT_PORT}`, qqConvId: '', autoTitle: false, safetyLevel: 'off' } });
      ob.private.length = 0;
      ob.friendMsgs.push(inbound({ id: 'm4-' + RUN, text: '今天几点开会？', at: Date.now() }));
      const p = await j('/api/qq/poll', { method: 'POST', body: {} });
      check('收发模式回了 1 条', p.status === 200 && p.data.replied === 1, JSON.stringify({ fresh: p.data.fresh, replied: p.data.replied, err: p.data.status?.lastError }));
      check('回答发回了 QQ', ob.private.length === 1 && ob.private[0].user_id === ob.loginUid);
      const sentText = ob.private[0]?.message?.[0]?.data?.text || '';
      check('发回去的是模型回答', sentText.length > 0, sentText.slice(0, 40));
      const st = await j('/api/qq/state');
      const convId = st.data.convId || '';
      check('建立了 QQ 会话', !!convId, convId);
      if (convId) {
        touchedConvs.push(convId);
        const conv = await j('/api/conversations/' + convId);
        const c = conv.data?.conversation || {};
        const msgs = c.messages || [];
        check('会话里有 user + assistant', msgs.some(m => m.role === 'user' && /来自 QQ/.test(m.content)) && msgs.some(m => m.role === 'assistant' && m.content));
        check('QQ 会话标题是 QQ', c.title === 'QQ', c.title);
      }
    }
  }

  console.log('\n5. 群模式');
  {
    await j('/api/settings', { method: 'PUT', body: { qqGroup: '1234567', qqMode: 'send' } });
    ob.groupMsgs = [inbound({ id: 'g1-' + RUN, uid: 999, nick: '群里的人', text: '群消息一条', group: 1234567, at: Date.now() })];
    ob.group.length = 0;
    const s = await j('/api/qq/send', { method: 'POST', body: { text: '发到群里' } });
    check('有群号时发群', s.status === 200 && s.data.to === 'group' && s.data.group === '1234567', JSON.stringify(s.data));
    check('假后端收到 send_group_msg', ob.group.length === 1 && ob.group[0].group_id === 1234567);
    // 后台轮询可能先吃掉上一条，这里换一条新的 id 再手动收
    ob.groupMsgs.push(inbound({ id: 'g2-' + RUN, uid: 999, nick: '群里的人', text: '第二条群消息', group: 1234567, at: Date.now() }));
    const p = await j('/api/qq/poll', { method: 'POST', body: {} });
    check('群历史取到新消息', p.data.fresh >= 1, JSON.stringify({ fresh: p.data.fresh, skipped: p.data.skipped }));
    await j('/api/settings', { method: 'PUT', body: { qqGroup: '' } });
  }

  console.log('\n6. 后端故障要被看见');
  {
    ob.fail = true;
    const t = await j('/api/qq/test', { method: 'POST', body: {} });
    check('后端 failed 时 test 报 ok:false', t.data.ok === false && /失败/.test(String(t.data.info?.error || t.data.error || '')), String(t.data.info?.error || t.data.error || '').slice(0, 60));
    const s = await j('/api/qq/send', { method: 'POST', body: { text: '发不出去' } });
    check('发送失败返回 400', s.status === 400, String(s.data.error).slice(0, 60));
    ob.fail = false;
  }

  console.log('\n7. 设置校验');
  {
    const r = await j('/api/settings', { method: 'PUT', body: { qqMode: '乱写', qqPollMs: 999999, qqUid: 'abc123-456', qqCallName: '' } });
    check('非法 mode 回落 off', r.data.qqMode === 'off', r.data.qqMode);
    check('pollMs 夹到 60000', r.data.qqPollMs === 60000, String(r.data.qqPollMs));
    check('qqUid 只留数字', r.data.qqUid === '123456', r.data.qqUid);
    check('称呼空回落「对方」', r.data.qqCallName === '对方', r.data.qqCallName);
    const r2 = await j('/api/settings', { method: 'PUT', body: { qqPollMs: 100 } });
    check('pollMs 下限 2000', r2.data.qqPollMs === 2000, String(r2.data.qqPollMs));
  }

  console.log('\n8. 从 dsh-qq-bridge 配置里读地址');
  {
    const r = await j('/api/qq/import-config', { method: 'POST', body: {} });
    if (r.status === 200) {
      const f = r.data.found || {};
      check('读到地址/号码字段', typeof f.baseUrl === 'string' && typeof f.uid === 'string', JSON.stringify({ baseUrl: f.baseUrl, uid: f.uid && '有', group: f.group && '有' }));
      check('默认不落盘（applied=false）', r.data.applied === false);
      const after = (await j('/api/settings')).data;
      check('没有偷偷改设置', after.qqPollMs !== undefined);
    } else {
      console.log('  - 跳过：本机没有插件配置（' + r.data.error + '）');
    }
  }
} catch (e) {
  fail++;
  console.log('  ✗ 测试抛错：' + e.message);
} finally {
  await restore();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
