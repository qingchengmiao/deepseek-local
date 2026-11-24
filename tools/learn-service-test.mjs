// learn-service 的端到端测试：塞一个假 OneBot，看「抽消息 → 画像 → 周结算 → 喂模型」整条链路。
// 不需要真的 QQ，也不起 HTTP。
//
// 跑：node tools/learn-service-test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLearnService } from '../learn-service.mjs';
import { isoWeek } from '../qqgroup.mjs';

let pass = 0, fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`); }
}
function eq(a, b, label) {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `拿到 ${JSON.stringify(a)} 期望 ${JSON.stringify(b)}`);
}

const ROOT = path.join(os.tmpdir(), `learn-svc-${Date.now()}`);
fs.mkdirSync(ROOT, { recursive: true });

const GID = '900001';
const UIDS = ['10001', '10002', '10003'];
const NICKS = { 10001: '青', 10002: '老四', 10003: '小满' };

// 两周的假消息：有回复链、有 @、有内部梗、有强情绪句
function fakeMessages(count = 120) {
  const now = Math.floor(Date.now() / 1000);
  const out = [];
  for (let i = 0; i < count; i++) {
    const uid = UIDS[i % 3];
    const isMeme = i % 7 === 0;
    const isStrong = i % 11 === 0;
    const text = isMeme ? '又是电子木鱼的一天' : isStrong ? '这也太离谱了吧！！' : (i % 4 === 0 ? '好耶' : '这个我也试过，好像不太行啊');
    const segs = [{ type: 'text', data: { text } }];
    if (i % 9 === 0) segs.unshift({ type: 'at', data: { qq: '10002' } });
    if (i > 0 && i % 5 === 0) segs.push({ type: 'reply', data: { id: String(1000000 + i - 1) } });
    out.push({
      message_id: 1000000 + i,
      user_id: Number(uid),
      time: now - (count - i) * 3600 * 6 - (i < count / 2 ? 7 * 86400 : 0),
      group_id: Number(GID),
      sender: { user_id: Number(uid), nickname: NICKS[uid], card: NICKS[uid] },
      message: segs,
    });
  }
  return out;
}

const messages = fakeMessages();
let fetchCalls = 0;
async function onebot(cfg, action, params) {
  fetchCalls++;
  if (action === 'get_group_list') {
    return { status: 'ok', data: [{ group_id: Number(GID), group_name: '测试群', member_count: 12 }] };
  }
  if (action === 'get_group_msg_history') {
    // 第一页给最新 100 条；带 message_seq 时给更早那批
    const seq = params.message_seq;
    const sorted = messages.slice().sort((a, b) => a.message_id - b.message_id);
    const upto = seq ? sorted.filter((m) => m.message_id < Number(seq)) : sorted;
    const page = upto.slice(-Math.min(params.count || 100, upto.length));
    return { status: 'ok', data: { messages: page } };
  }
  throw new Error(`unexpected action ${action}`);
}

let settings = {
  learnAuto: true,
  learnInject: false,
  learnGroups: [],
  learnGroupMeta: {},
  learnN: 6,
  learnPages: 3,
  learnLastSettledWeek: '',
  __qq: { baseUrl: 'http://127.0.0.1:1', token: '', uid: '', group: '', mode: 'off' },
};
const patches = [];
async function saveSettings(patch) {
  patches.push(patch);
  settings = { ...settings, ...patch };
  return settings;
}
const svc = createLearnService({
  dataDir: ROOT,
  onebot,
  getSettings: async () => settings,
  saveSettings,
});

console.log('\n[1] 拉群列表');
const groups = await svc.refreshGroups();
eq(groups.length, 1, '一个群');
eq(groups[0].gid, GID, '群号对');
eq(groups[0].name, '测试群', '群名对');
ok(patches.some((p) => p.learnGroupMeta && p.learnGroupMeta[GID]), '群元数据写进设置');

console.log('\n[2] 抽消息（分页往回翻）');
const r1 = await svc.ingest({ gids: [GID], pages: 3 });
ok(r1[0].added >= 100, '抽到至少 100 条', `实际 ${r1[0].added}`);
const total = svc.store.stats(GID).count;
ok(total >= 100, '库里条数够', `实际 ${total}`);
ok(fetchCalls >= 2, '确实翻了不止一页', `fetch ${fetchCalls} 次`);

console.log('\n[3] 重复抽不重复入库');
const r2 = await svc.ingest({ gids: [GID], pages: 3 });
eq(r2[0].added, 0, '第二次新增 0（按 message_id 去重）');

console.log('\n[4] 分析：画像 / 关系 / 情绪 / 内部梗');
const a = await svc.analysisFor({ gid: GID, n: 6 });
ok(!a.empty, '不是空的');
eq(a.gid, GID, 'gid 回传');
ok(a.overall.charsMedian > 0, '句长中位有值');
ok(a.overall.modalPer100 >= 0, '语气词密度是数');
ok(a.overall.proDropRatio >= 0 && a.overall.proDropRatio <= 1, '省略主语比例 0..1');
ok(a.people === 3, '三个人', `实际 ${a.people}`);
ok(a.graph.edges.length > 0, '有回复关系边');
ok(a.graph.quoteHist && typeof a.graph.quoteHist === 'object', '引用次数有直方图');
ok(Array.isArray(a.atBehavior) && a.atBehavior.length > 0 && 'replyRate' in a.atBehavior[0], '@ 回复行为有');
ok(a.sentiment && typeof a.sentiment.base === 'number', '情绪基线有');
ok(Array.isArray(a.sentiment.spikes), '情绪突变点有');
ok(a.sentiment.spikes.length > 0 && 'afterMean' in a.sentiment.spikes[0], '突变点带后面 n 条的均值');
ok(a.memes.some((m) => m.phrase.includes('电子木鱼')), '内部梗被捞出来');
ok(a.memes[0].firstTs > 0 && a.memes[0].lastTs >= a.memes[0].firstTs, '梗有时间跨度');
ok(a.rhythm && a.rhythm.gapMedianS >= 0, '节奏间隔有值');
ok(Array.isArray(a.series) && a.series.length > 0, '情绪曲线有数据点');
ok(a.peopleTop.length === 3, '人物画像三条');
ok(Array.isArray(a.weekStats) && a.weekStats.length >= 1, '周统计有');
ok(a.weekNow === isoWeek(Date.now() / 1000), '当前周对');
ok(Array.isArray(a.wanted) && a.wanted.length === 1, 'wanted 里有群');

console.log('\n[5] 周结算：一个群一周一份 json + md');
const settled = await svc.settle();
ok(settled.length >= 1, '至少结算了一周', `实际 ${settled.length}`);
const weeks = svc.listWeeks({ gid: GID });
ok(weeks.length >= 1, '周报列表有');
ok(weeks[0].msgs > 0, '周报记着条数');
const md = svc.weekMarkdown(GID, weeks[0].week);
ok(!!md && md.includes('周报'), '周报是 markdown 且带标题');
ok(!!md && /句长|语气词|情绪/.test(md), '周报里有画像栏目');
const jsonFile = path.join(svc.root, 'weeks', `${GID}__${weeks[0].week}.json`);
ok(fs.existsSync(jsonFile), 'json 落盘');
const parsed = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
ok(parsed.gid === GID && parsed.week === weeks[0].week, 'json 里 gid/week 对');
ok(typeof parsed.closed === 'boolean', 'json 标了这周是否结束');

console.log('\n[6] 不 force 不重写已结算的周');
const before = fs.statSync(jsonFile).mtimeMs;
await new Promise((r) => setTimeout(r, 12));
await svc.settle();
ok(fs.statSync(jsonFile).mtimeMs === before, '没 force 就不动已结算的那份');

console.log('\n[7] 画像文本（喂模型那段）');
const prof = await svc.profileFor({ gid: GID, maxChars: 600 });
ok(typeof prof === 'string' && prof.length > 30, '画像文本有内容');
ok(prof.length <= 620, '不超过 maxChars 太多', `实际 ${prof.length}`);

console.log('\n[8] status 能看全');
const st = await svc.status();
ok(st.ok === true, 'status ok');
eq(st.dir, svc.root, '目录对');
ok(st.store.length === 1 && st.store[0].count > 0, 'store 里有群有条数');
eq(st.auto, true, '自动开着');
eq(st.inject, false, '注入默认关');

console.log('\n[9] tick：关掉自动就跳过');
settings = { ...settings, learnAuto: false };
eq((await svc.tick()).skipped, 'auto-off', '关自动跳过');
settings = { ...settings, learnAuto: true, __qq: null };
eq((await svc.tick()).skipped, 'qq-off', '没接 QQ 跳过');
settings = { ...settings, __qq: { baseUrl: 'http://127.0.0.1:1' }, learnGroups: [] };
// 库里有群 → groupsWanted 会回落到已存群，所以这里还应该真跑一轮
const t = await svc.tick({ pages: 1 });
ok(t.added !== undefined || t.skipped !== 'no-groups', '有已存群时仍会跑', JSON.stringify(t));

console.log('\n[10] 清理');
fs.rmSync(ROOT, { recursive: true, force: true });
ok(!fs.existsSync(ROOT), '临时目录已删');

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
