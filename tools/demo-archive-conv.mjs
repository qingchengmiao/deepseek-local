import { liveGuard } from './_guard.mjs';
// 临时脚本：造一个带「压缩记忆 + 原文归档」的演示会话，方便截图；跑完自己删。
// 用法：node tools/demo-archive-conv.mjs [--clean]
const BASE = 'http://127.0.0.1:8787';
await liveGuard(BASE, 'demo-archive-conv');
const MOCK = 'http://127.0.0.1:8899';

const clean = process.argv.includes('--clean');
const j = async (p, o) => (await fetch(BASE + p, o)).json();

if (clean) {
  const id = process.argv[process.argv.indexOf('--clean') + 1];
  if (id) {
    await fetch(BASE + '/api/conversations/' + id, { method: 'DELETE' });
    const { rm } = await import('node:fs/promises');
    await rm('data/archive/' + id, { recursive: true, force: true });
    console.log('已删演示会话', id);
  }
  process.exit(0);
}

const orig = await j('/api/settings');
await fetch(BASE + '/api/settings', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    apiKey: 'sk-mock-demo-key', baseUrl: MOCK, model: 'deepseek-flash',
    ctxCompress: true, ctxBudget: 4000, ctxRag: true, ctxTopK: 4, ctxHalfLifeDays: 30,
    ctxSummarizer: 'auto', ctxArchive: true,
    ctxStepRatio: 0.33, ctxForgetRatio: 0.5, ctxProgressive: true, ctxActivateScore: 0.5,
  }),
});

const filler = '项目部先把数据库备份跑完，再改 schema，最后核对导出脚本的时区是否已经改成 UTC 存储。'.repeat(20);
const c = await j('/api/conversations', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: '归档演示', model: 'deepseek-flash' }),
});
const id = c.conversation.id;

const send = async content => {
  const r = await fetch(BASE + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: id, mode: 'send', content, webSearch: false, thinking: false, autoTitle: false }),
  });
  await r.text();
};

const topics = [
  '记住：我家蓝鲸的心率是每分钟八次，这个数别记错。',
  '决定：数据库迁移放到下周一，先备份再动 schema。',
  '偏好：回答尽量短，代码注释用中文，别写「当然可以」。',
  '未完成：把导出脚本的时区 bug 修掉，改成 UTC 存储。',
  '提醒：不要在周五晚上做上线操作。',
];
for (const t of topics) await send(t + filler);
await send('最后一轮：' + filler);
// 这一轮把相关度阈值调高，让老片段变成「记忆索引卡」，演示渐进激活
await send('蓝鲸 心率 每分钟几次？' + filler);
// 再说一句展开，演示逐步恢复（原文会写进系统段）
await send('展开第 1 条');

// 标题会被上游的自动标题事件覆盖，收尾时改回来
await fetch(BASE + '/api/conversations/' + id, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: '归档演示：蓝鲸心率与迁移决定' }),
});

await fetch(BASE + '/api/settings', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    apiKey: '', baseUrl: orig.baseUrl || 'https://api.deepseek.com', model: orig.model || 'deepseek-flash',
    ctxBudget: orig.ctxBudget ?? 24000, ctxRag: orig.ctxRag ?? true, ctxCompress: orig.ctxCompress ?? true,
    ctxSummarizer: orig.ctxSummarizer ?? 'auto', ctxArchive: orig.ctxArchive ?? true,
    ctxStepRatio: orig.ctxStepRatio ?? 0.33, ctxForgetRatio: orig.ctxForgetRatio ?? 0.5,
    ctxProgressive: orig.ctxProgressive ?? true, ctxActivateScore: orig.ctxActivateScore ?? 0.2,
  }),
});
console.log(id);
