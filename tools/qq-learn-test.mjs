// QQ 群聊自学习：用造出来的消息验证统计口径（不碰真群、不联网）。
//
// 跑法：node tools/qq-learn-test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GroupStore, analyze, isoWeek, renderWeeklyMarkdown, buildLearnedProfile, normalizeOneBotMessage, sentimentOf } from '../qqgroup.mjs';

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, detail ? `— ${detail}` : ''); }
}
function eq(name, got, want) {
  ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}
function near(name, got, want, tol = 0.02) {
  ok(name, got !== null && Math.abs(got - want) <= tol, `got ${got} want ~${want}`);
}

const T0 = Date.UTC(2026, 10, 9, 2, 0, 0) / 1000; // 2026-11-09 10:00 (Asia/Shanghai)
const DAY = 86400;

// ---- 造 3 个人、两周、带回复链与 @ 的对话 ----
const MEME = '电子木鱼';
function mk(uid, ts, text, extra = {}) {
  const m = {
    gid: '123',
    mid: `${uid}-${ts}`,
    uid: String(uid),
    nick: { 1001: '青', 1002: '老四', 1003: '小鹿' }[uid] || uid,
    ts,
    text,
    at: extra.at || [],
    replyTo: extra.replyTo || null,
    kinds: ['text'],
    self: false,
  };
  return m;
}

const msgs = [];
// 第一周：青话密、短、多语气词；老四话长、爱反问；小鹿温和
for (let i = 0; i < 40; i++) {
  const ts = T0 + i * 90 + (i % 3) * 7;
  const speaker = i % 3 === 0 ? 1001 : i % 3 === 1 ? 1002 : 1003;
  let text;
  if (speaker === 1001) text = i % 4 === 0 ? `真服了啊${MEME}又来了` : '行吧，那我明天再看一眼';
  else if (speaker === 1002) text = '你们有没有发现这个逻辑其实是反的？我一直觉得这里面有个坑，说不上来在哪，但就是别扭';
  else text = i % 9 === 0 ? '太爽了绝了牛逼' : i % 11 === 0 ? '垃圾东西真恶心，气死了' : i % 2 === 0 ? '好耶' : '哈哈哈笑死，这个也太离谱了吧';
  msgs.push(mk(speaker, ts, text));
}
// 第二周：更密，回复链、@
let prev = null;
for (let i = 0; i < 60; i++) {
  const ts = T0 + 7 * DAY + i * 40;
  const speaker = [1001, 1002, 1003][i % 3];
  const text = i % 7 === 0
    ? `@老四 你说的那个${MEME}到底啥意思啊`
    : i % 5 === 0 ? `不是，${MEME}这个梗你们是真玩不腻啊` : '嗯嗯，那就这么定了呗';
  const m = mk(speaker, ts, text, { replyTo: i % 4 === 0 && prev ? prev.mid : null, at: i % 7 === 0 ? ['1002'] : [] });
  msgs.push(m);
  prev = m;
}

console.log('规范化和情绪');
{
  const r = normalizeOneBotMessage({
    group_id: 12345, message_id: 9, user_id: 1001, time: T0,
    sender: { nickname: '青', card: '青' },
    message: [{ type: 'reply', data: { id: '7' } }, { type: 'at', data: { qq: '1002' } }, { type: 'text', data: { text: '你在吗' } }],
  });
  eq('replyTo 取到', r.replyTo, '7');
  eq('at 列表取到', JSON.stringify(r.at), '["1002"]');
  eq('gid 有值', r.gid, '12345');
  eq('text 拼装', r.text, '@1002你在吗');
  ok('没有 message_id 就丢', normalizeOneBotMessage({ message_id: null }) === null);
  ok('正面词打正分', sentimentOf('笑死，这也太好笑了') > 0);
  ok('负面词打负分', sentimentOf('真的烦，破防了') < 0);
  ok('空文本 0 分', sentimentOf('') === 0);
}

console.log('存储与去重');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqlearn-'));
try {
  const store = new GroupStore(tmp);
  eq('空目录没有群', store.groups().length, 0);
  eq('首轮写入 100 条', store.append('123', msgs), 100);
  eq('重复写不增长', store.append('123', msgs), 0);
  eq('再写一条增量', store.append('123', [mk(1001, T0 + 30 * DAY, '补一条')]), 1);
  const st = store.stats('123');
  eq('统计条数', st.count, 101);
  eq('统计人数', st.people, 3);
  ok('时间戳有首尾', st.firstTs === T0 && st.lastTs > T0);
  const reopened = new GroupStore(tmp);
  eq('重开进程能读回', reopened.list('123').length, 101);
  const filtered = reopened.list('123', { since: T0 + 7 * DAY, until: T0 + 8 * DAY });
  ok('按时间窗取子集', filtered.length === 60, `got ${filtered.length}`);
  ok('拒绝非法 gid 名', reopened.stats('../../etc').gid === 'etc', reopened.stats('../../etc').gid);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('画像与关系图');
{
  const a = analyze(msgs, { n: 6 });
  eq('条数', a.count, 100);
  eq('人数', a.people, 3);
  ok('句长中位是数字', typeof a.overall.charsMedian === 'number', String(a.overall.charsMedian));
  ok('语气词有密度', a.overall.modalPer100 > 0, String(a.overall.modalPer100));
  ok('省略主语比例 0~1', a.overall.proDropRatio >= 0 && a.overall.proDropRatio <= 1, String(a.overall.proDropRatio));
  ok('不写句末标点比例', a.overall.noEndPunctRatio > 0, String(a.overall.noEndPunctRatio));
  ok('短句占比 0~1', a.overall.shortRatio >= 0 && a.overall.shortRatio <= 1, String(a.overall.shortRatio));
  ok('短句和长句都有（造的数据里两种都在）', a.overall.shortRatio > 0 && a.overall.charsMedian > 8,
    'short ' + a.overall.shortRatio + ' charsMedian ' + a.overall.charsMedian);
  ok('标点排行榜非空', a.overall.punctTop.length > 0);
  ok('24 小时分布有 24 格', a.overall.hours.length === 24);

  ok('有回复边', a.graph.edges.length > 0, String(a.graph.edges.length));
  const e0 = a.graph.edges[0];
  ok('边上有次数和间隔', e0.count >= 1 && (e0.medianGapS === null || e0.medianGapS >= 0));
  ok('被引用统计有数', Object.keys(a.graph.quoteHist).length > 0, JSON.stringify(a.graph.quoteHist));
  ok('@ 边存在（老四被 @）', a.graph.atEdges.some((x) => x.to === '1002'), JSON.stringify(a.graph.atEdges));

  ok('节奏间隔中位', a.rhythm.gapMedianS !== null);
  ok('回复间隔中位', a.rhythm.replyGapMedianS !== null);
  ok('高峰小时排了 5 个', a.rhythm.peakHours.length === 5);

  const atb = a.atBehavior.find((x) => x.uid === '1002');
  ok('老四被 @ 后有统计', atb && atb.atReceived >= 1, JSON.stringify(atb));
  ok('@ 回复率是 0~1', atb && atb.replyRate !== null && atb.replyRate >= 0 && atb.replyRate <= 1);

  ok('情绪基线是数字', typeof a.sentiment.base === 'number');
  ok('情绪窗口有话题', a.sentiment.windows.length > 0 && a.sentiment.windows[0].topics.length > 0);
  const spike = a.sentiment.spikes.find((s) => s.delta !== null);
  ok('有带 before/after 的突变点', !!spike, String(a.sentiment.spikes.length));

  ok('梗里能捞到那个词', a.memes.some((m) => m.phrase.includes(MEME)), JSON.stringify(a.memes.slice(0, 3).map((m) => m.phrase)));
  const meme = a.memes.find((m) => m.phrase.includes(MEME));
  ok('梗带首末时间和扩散人数', meme.firstISO && meme.lastISO && meme.senders >= 2, JSON.stringify(meme));
  ok('梗按条数降序', a.memes.every((m, i) => i === 0 || a.memes[i - 1].count >= m.count));

  ok('周结算有两周', a.weeks.length === 2, String(a.weeks.length));
  eq('周标签形状', a.weeks[0].week, isoWeek(T0));
  ok('周里带梗摘要', Array.isArray(a.weeks[1].memes));

  const md = renderWeeklyMarkdown(a.weeks[1], { name: '测试群' });
  ok('周报 markdown 有标题与条数', md.includes('周报') && md.includes('消息'), md.slice(0, 80));
  ok('周报里写了句长', md.includes('句长中位'), md.slice(0, 200));

  const prof = buildLearnedProfile(a);
  ok('画像文本非空', prof.length > 40, String(prof.length));
  ok('画像里有句长与语气词', prof.includes('句长') && prof.includes('语气词'), prof.slice(0, 120));
  ok('画像受长度上限约束', buildLearnedProfile(a, { maxChars: 80 }).length <= 81);

  const empty = analyze([]);
  ok('空数据不炸', empty.empty === true && buildLearnedProfile(empty) === '');
}

console.log('人物画像');
{
  const a = analyze(msgs);
  const qing = a.peopleTop.find((p) => p.uid === '1001');
  const laosi = a.peopleTop.find((p) => p.uid === '1002');
  ok('两个人的画像都在', qing && laosi);
  ok('老四句长比青长（造的数据就是这设定）', laosi.charsMedian > qing.charsMedian,
    `${laosi.charsMedian} vs ${qing.charsMedian}`);
  ok('青语气词更密', qing.modalPer100 > laosi.modalPer100, `${qing.modalPer100} vs ${laosi.modalPer100}`);
  ok('人物按条数降序', a.peopleTop.every((p, i) => i === 0 || a.peopleTop[i - 1].msgs >= p.msgs));
  ok('人物有昵称', qing.nick.length > 0, qing.nick);
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
