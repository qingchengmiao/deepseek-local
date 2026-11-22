// 媒体解析链路自测（不需要真 Key，指向假上游）
// 用法：先重启服务，再 node tools/media-smoke.mjs
import { liveGuard } from './_guard.mjs';
import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, stat, access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { sleep } from './cdp.mjs';
const run = promisify(execFile);

const APP = process.env.BASE || 'http://127.0.0.1:8787';
await liveGuard(APP, 'media-smoke');
const MOCK = process.env.MOCK || 'http://127.0.0.1:8899';

/** 测试素材：缺了就现场用 ffmpeg 造一份（9 秒视频 + 4 秒音） */
async function ensureTestMedia(ffmpeg) {
  const missing = async p => { try { await access(p); return false; } catch { return true; } };
  if (await missing('data/test-media.mp4')) {
    await run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15:duration=9',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=9', '-c:v', 'libx264', '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', 'data/test-media.mp4'], { timeout: 180000 });
  }
  if (await missing('data/test-tone.wav')) {
    await run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-ar', '16000', '-ac', '1', 'data/test-tone.wav'], { timeout: 60000 });
  }
}
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

async function api(path, opts = {}) {
  const res = await fetch(APP + path, opts);
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
}
const putSettings = patch => api('/api/settings', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
});

async function mockUp() {
  try { const r = await fetch(MOCK + '/models', { signal: AbortSignal.timeout(600) }); if (r.ok) return null; } catch {}
  const child = spawn(process.execPath, ['tools/mock-upstream.mjs'], { stdio: 'ignore', detached: true });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    try { const r = await fetch(MOCK + '/models', { signal: AbortSignal.timeout(500) }); if (r.ok) return child; } catch {}
  }
  throw new Error('假上游没起来');
}

const orig = (await api('/api/settings')).data;
const mockChild = await mockUp();
await ensureTestMedia(process.env.FFMPEG_PATH || 'D:\\ffmpeg-9.0-full_build\\bin\\ffmpeg.exe');
await putSettings({ apiKey: 'sk-mock-media', baseUrl: MOCK, mediaFrames: 6, mediaChunkSec: 110, model: 'auto', autoRoute: true, mediaTwoStage: true });

try {
  console.log('1) 视频：9 秒 mp4（含音轨）');
  const vbuf = await readFile('data/test-media.mp4');
  const t0 = Date.now();
  const v = await api('/api/media', {
    method: 'POST',
    headers: { 'Content-Type': 'video/mp4', 'x-filename': encodeURIComponent('test-media.mp4') },
    body: vbuf,
  });
  console.log(`   用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  check('视频解析 200', v.status === 200, v.status === 200 ? '' : JSON.stringify(v.data).slice(0, 200));
  const m = v.data;
  check('识别为 video', m.kind === 'video', m.kind);
  check('时长约 9 秒', Math.abs((m.duration || 0) - 9) < 1.5, m.duration);
  check('抽到关键帧', (m.frames || []).length >= 1, `${(m.frames || []).length} 帧`);
  check('转写有文字', String(m.text || '').length > 0, JSON.stringify(String(m.text || '').slice(0, 40)));
  check('转写带时间轴', Array.isArray(m.transcript) && m.transcript.length > 0, JSON.stringify(m.transcript?.[0] || null).slice(0, 120));
  check('有元信息文件', !!(await api('/api/media/' + m.mediaId)).data.mediaId);
  {
    const f = await fetch(APP + m.frames[0].url);
    const buf = Buffer.from(await f.arrayBuffer());
    check('关键帧能取回且是 jpg', f.status === 200 && buf[0] === 0xff && buf[1] === 0xd8, `${f.status}, ${buf.length}B`);
  }

  console.log('2) 音频：4 秒 wav');
  const abuf = await readFile('data/test-tone.wav');
  const a = await api('/api/media', {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav', 'x-filename': encodeURIComponent('test-tone.wav') },
    body: abuf,
  });
  check('音频解析 200', a.status === 200, a.status === 200 ? '' : JSON.stringify(a.data).slice(0, 200));
  check('识别为 audio', a.data.kind === 'audio', a.data.kind);
  check('音频没有帧', (a.data.frames || []).length === 0, String((a.data.frames || []).length));
  check('音频也有转写', String(a.data.text || '').length > 0);

  console.log('3) 带视频发一轮（两段式：Flash 看帧扒要点 → Pro 写正文）');
  const conv = (await api('/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '媒体测试' }) })).data.conversation;
  await writeFile('data/mock-seq.json', '[]');
  const chat = await fetch(APP + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: conv.id, mode: 'send', content: '这个视频讲了什么？',
      webSearch: false, autoTitle: false, thinking: false,
      attachments: [{ mediaId: m.mediaId, kind: 'video', name: m.name, duration: m.duration, text: m.text, transcript: m.transcript, frames: m.frames, mime: m.mime, size: m.size }],
    }),
  });
  const sse = await chat.text();
  check('SSE 正常结束', /"type":"done"/.test(sse), sse.slice(0, 80));
  check('route 事件判成音视频档', /"type":"route"/.test(sse) && /"kind":"media"/.test(sse), (sse.match(/"type":"route"[^\n]*/) || [''])[0].slice(0, 160));
  check('route 事件带要点字数', /"draft":\{[^}]*"chars":\d+/.test(sse), (sse.match(/"draft":\{[^}]*\}/) || [''])[0].slice(0, 120));
  const saved = (await api('/api/conversations/' + conv.id)).data.conversation;
  check('附件落盘在消息里', saved.messages[0].attachments?.[0]?.mediaId === m.mediaId);

  const seq = JSON.parse(await readFile('data/mock-seq.json', 'utf8'));
  check('两段式：上游被调了两次', seq.length === 2, `${seq.length} 次`);
  check('第一遍是 Flash 看转写+抽帧扒要点（非流式）',
    seq[0] && seq[0].model === 'deepseek-flash' && seq[0].hasDigestPrompt === true && seq[0].stream === false && seq[0].hasImageParts === true,
    seq[0] ? JSON.stringify(seq[0]) : '');
  check('第二遍是 V4 Pro 按要点写正文',
    seq[1] && seq[1].model === 'deepseek-v4-pro' && seq[1].hasDigestBlock === true && seq[1].stream === true,
    seq[1] ? JSON.stringify(seq[1]) : '');
  check('第二遍不再带图片块（Pro 看不了图）', seq[1] && seq[1].hasImageParts === false);

  const mock = JSON.parse(await readFile('data/mock-last.json', 'utf8'));
  const msgs = mock.body?.messages || mock.messages || [];
  const lastUser = [...msgs].reverse().find(x => x.role === 'user');
  check('第二遍的 user content 已是纯文本', typeof lastUser.content === 'string', typeof lastUser.content);
  check('转写文字还在（没丢）', /视频转写/.test(String(lastUser.content || '')));
  check('要点块进了 system', msgs.some(x => x.role === 'system' && typeof x.content === 'string' && x.content.includes('【V4.1 Flash 看完这段音视频后扒出来的要点】')));

  // 清理这个测试会话
  await api('/api/conversations/' + conv.id, { method: 'DELETE' });
} finally {
  const restore = {
    baseUrl: orig.baseUrl, model: orig.model || 'deepseek-flash',
    webSearch: !!orig.webSearch, readLink: orig.readLink !== false, autoTitle: orig.autoTitle !== false,
    safetyLevel: orig.safetyLevel || 'off', thinking: orig.thinking !== false,
    reasoningEffort: orig.reasoningEffort || 'high', mediaFrames: orig.mediaFrames ?? 6, mediaChunkSec: orig.mediaChunkSec ?? 110,
  };
  if (!orig.hasKey) restore.apiKey = '';
  await putSettings(restore);
  if (mockChild) { try { process.kill(-mockChild.pid); } catch { try { mockChild.kill(); } catch {} } }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
