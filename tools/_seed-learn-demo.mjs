// 造一份假的群聊数据，给自学习页看用（不接真 QQ）。
// 用法：node tools/_seed-learn-demo.mjs [dataDir]
import fs from 'node:fs';
import path from 'node:path';

const DATA = process.argv[2] || path.join('data', '_learn_ui');
const GID = '728100111';
const dir = path.join(DATA, 'qq-learn', GID);
fs.mkdirSync(dir, { recursive: true });

const UIDS = ['300111', '300222', '300333', '300444', '300555'];
const NICKS = { 300111: '青', 300222: '老四', 300333: '小满', 300444: '阿柴', 300555: '半仙' };
const LINES = [
  '这个我也试过，好像不太行啊',
  '好耶',
  '又是电子木鱼的一天',
  '这也太离谱了吧！！',
  '我先睡了明天再说',
  '笑死，评论区比正片好看',
  '？？？',
  '有点东西',
  '蹲一个后续',
  'emmm 怎么说呢',
  '别急，等我十分钟',
  '我这边网络又抽风了',
  '电子木鱼敲起来',
  '讲真这个逻辑我没看懂',
  '可以可以，学到了',
  '这波啊，这波是白给',
];

const now = Math.floor(Date.now() / 1000);
const rows = [];
for (let i = 0; i < 260; i++) {
  const uid = UIDS[(i * 7) % UIDS.length];
  // 两条线程，其中一条偏负面（好让情绪曲线有起伏）
  const pool = i > 150 && i < 200 ? ['这也太离谱了吧！！', '讲真这个逻辑我没看懂', '？？？', '别急，等我十分钟'] : LINES;
  const text = pool[i % pool.length];
  const at = i % 13 === 0 ? [UIDS[(i + 2) % UIDS.length]] : [];
  rows.push({
    gid: GID,
    mid: String(7300000 + i),
    uid,
    nick: NICKS[uid],
    ts: now - (260 - i) * 900 - (i < 130 ? 8 * 86400 : 0),
    text,
    at,
    replyTo: i > 3 && i % 3 === 0 ? String(7300000 + i - 1) : '',
    kinds: ['text'],
    self: false,
  });
}

const file = path.join(dir, 'messages.jsonl');
fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
console.log(`写好了 ${rows.length} 条 → ${file}`);
