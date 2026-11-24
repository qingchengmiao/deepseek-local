// user-learn 的测试：从「我自己发过的消息」里量说话样子。
// 不起 HTTP、不碰真数据，全部造样本。
//
// 跑：node tools/user-learn-test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripUserText, ownRecords, analyzeOwn, buildOwnProfileText, summaryOf, createUserLearnService } from '../user-learn.mjs';

let pass = 0, fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`); }
}
function eq(a, b, label) {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `拿到 ${JSON.stringify(a)} 期望 ${JSON.stringify(b)}`);
}

const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);

// 一段网页会话 + 一段 QQ 会话。QQ 那条带着两层壳，要剥干净才算他说的话。
function fakeConvs() {
  const web = {
    id: 'c_web1', title: '测试网页', source: 'web',
    messages: [
      { role: 'user', content: '说起这个，我昨天也试了一下', createdAt: NOW - 3 * DAY },
      { role: 'assistant', content: '这只是一条回复，不该被量进去' },
      { role: 'user', content: '我觉得还行吧，不过有点慢', createdAt: NOW - 3 * DAY + 60 },
      { role: 'user', content: '【图片】', createdAt: NOW - 2 * DAY, attachments: [{ kind: 'image', uploadId: 'u_1.png' }] },
      { role: 'user', content: '说起那个事儿，其实我早就想说了', createdAt: NOW - 2 * DAY + 30 },
      { role: 'user', content: '毕竟是自己一点点弄出来的', createdAt: NOW - DAY },
    ],
  };
  const qq = {
    id: 'c_qq1', title: 'QQ 1', source: 'qq',
    messages: [
      {
        role: 'user',
        content: '【来自 QQ 上的对方（3979605697），2026/11/25 04:33:30】\n说起这个我也想问\n\n【这条回在手机上】按语义分段：每段单独发一条，段与段之间空一行。',
        createdAt: '2026-11-25T04:33:30.000Z',
      },
      { role: 'assistant', content: '嗯' },
      {
        role: 'user',
        content: '【来自 QQ 上的对方（3979605697），2026/11/25 04:35:00】\n我觉得这个挺离谱的',
        createdAt: '2026-11-25T04:35:00.000Z',
      },
    ],
  };
  return [web, qq];
}

console.log('stripUserText');
eq(stripUserText('【来自 QQ 上的对方（3979605697），2026/11/25 04:33:30】\n说起这个我也想问'), '说起这个我也想问', '剥掉 QQ 抬头');
eq(stripUserText('正文\n\n【这条回在手机上】按语义分段：每段单独发一条，段与段之间空一行。'), '正文', '剥掉手机打字口径尾巴');
eq(stripUserText('【来自 QQ 上的对方（1），今天】\n正文\n\n【这条回在手机上】口径'), '正文', '两层壳一起剥');
eq(stripUserText('  纯文字  '), '纯文字', '去首尾空白');
eq(stripUserText(null), '', 'null 不炸');

console.log('ownRecords');
const convs = fakeConvs();
const { records, images, convsWithWords } = ownRecords(convs);
eq(records.length, 7, '只收 user 消息（6 网页 + 2 QQ - 1 只有图 = 7）');
eq(records.filter((r) => r.uid === 'me').length, records.length, 'uid 统一成 me');
eq(images, 1, '图片数单独记');
eq(convsWithWords, 2, '两段对话都有话');
ok(records.every((r) => !/这条回在手机上|来自 QQ 上的对方/.test(r.text)), '记录里没有残留的壳');
ok(records.every((r, i) => i === 0 || records[i - 1].ts <= r.ts), '按时间排好序');
eq(records.filter((r) => r.src === 'qq').length, 2, 'QQ 来的算 2 条');
eq(records.filter((r) => r.src === 'web').length, 5, '网页打的算 5 条');

console.log('analyzeOwn');
const a = analyzeOwn(convs);
ok(!a.empty, '有数据不空');
eq(a.count, records.length, 'count 对');
eq(a.convs, 2, '对话数');
eq(a.convsWithWords, 2, '有字的对话数');
eq(a.sources, { web: 5, qq: 2 }, '来源分布');
ok(a.days >= 2, '跨了不止一天', `days=${a.days}`);
ok(a.profile && a.profile.sentenceMedian !== null, '句长中位有值');
ok(a.profile.charsMedian > 0, '一条多少字有值');
ok(a.profile.proDropRatio !== null, '省略主语比例有值');
ok(a.profile.noEndPunctRatio !== null, '不写句末标点比例有值');
ok(Array.isArray(a.phrases) && a.phrases.length > 0, '口头禅抓到了', JSON.stringify(a.phrases));
ok(a.phrases.every((p) => /^[\u4e00-\u9fff]{2,6}$/.test(p.phrase)), '口头禅是纯汉字块', JSON.stringify(a.phrases));
ok(a.phrases.some((p) => p.phrase === '说起'), '「说起」被认成口头禅', JSON.stringify(a.phrases));
ok(a.openers.some((o) => o.word.startsWith('说起')), '开头习惯里有「说起」');
ok(a.hours.length > 0, '出没时段有值');
ok(a.avgSentiment !== null, '平均情绪有值');
ok(!a.phrases.some((p) => /[，,。！？\s]/.test(p.phrase)), '口头禅里没有标点碎片');

console.log('空数据');
const empty = analyzeOwn([]);
ok(empty.empty === true, '空数组判 empty');
eq(empty.count, 0, 'count 0');
eq(buildOwnProfileText(empty), '', '空数据不产出文本');
eq(summaryOf(empty).hint.length > 0, true, '空数据给一句提示');

console.log('buildOwnProfileText');
const txt = buildOwnProfileText(a, { maxChars: 400 });
ok(txt.includes('对方平时怎么说话'), '有抬头');
ok(txt.includes('字'), '写了句长');
ok(txt.includes('语气词'), '写了语气词');
ok(txt.includes('「说起」'), '带上口头禅原文');
ok(txt.length <= 400, '不超过字数上限', `len=${txt.length}`);
const shortTxt = buildOwnProfileText(a, { maxChars: 60 });
ok(shortTxt.length <= 61, '上限小的时候会截断', `len=${shortTxt.length}`);

console.log('summaryOf');
const sum = summaryOf(a);
eq(sum.empty, false, '非空');
eq(sum.metrics.length, 8, '八个指标');
ok(sum.metrics.some((m) => m.k === '消息条数'), '有消息条数');
ok(sum.phrases.length > 0, '摘要带口头禅');
ok(sum.hours.length > 0, '摘要带时段');

console.log('service');
const ROOT = path.join(os.tmpdir(), `user-learn-${Date.now()}`);
fs.mkdirSync(ROOT, { recursive: true });
let loads = 0;
const svc = createUserLearnService({
  dataDir: ROOT,
  loadConversations: async () => { loads++; return fakeConvs(); },
});
const built = await svc.build({ write: true });
ok(built.count > 0, 'build 出结果');
ok(fs.existsSync(path.join(ROOT, 'user-learn', 'profile.json')), 'profile.json 落盘');
const saved = JSON.parse(fs.readFileSync(path.join(ROOT, 'user-learn', 'profile.json'), 'utf8'));
eq(saved.count, built.count, '落盘内容和返回值一致');
const again = await svc.build();
eq(loads, 1, '缓存生效，没重复读会话');
svc.reset();
await svc.build();
eq(loads, 2, 'reset 之后重新读');
const prof = await svc.profileFor({ maxChars: 300 });
ok(prof.includes('对方平时怎么说话'), 'profileFor 拿到文本');
ok(prof.length <= 300, 'profileFor 守上限');
const s2 = await svc.summary();
eq(s2.metrics.length, 8, 'summary 走同一条路');
fs.rmSync(ROOT, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
