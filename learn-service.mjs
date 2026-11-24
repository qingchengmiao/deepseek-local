// 自学习的服务层：把 QQ 群消息抽进来、存好、按周结算，并给别的地方提供画像。
//
// 不在这里碰 HTTP：只接一个 onebot(cfg, action, params) 和一个（异步）settings 读取器，
// 这样单测里塞假 onebot 就能把整条链路跑通（tools/qq-learn-test.mjs）。

import fs from 'node:fs';
import path from 'node:path';
import {
  GroupStore, analyze, isoWeek, renderWeeklyMarkdown, buildLearnedProfile, normalizeOneBotMessage, sentimentOf,
} from './qqgroup.mjs';

const WEEK_MS = 7 * 86400 * 1000;

/** 情绪走势：每 25 条算一个点（滑窗），给前端画曲线用。 */
function emotionSeries(records, step = 25) {
  const sorted = records.slice().sort((a, b) => a.ts - b.ts);
  const out = [];
  for (let i = 0; i < sorted.length; i += step) {
    const chunk = sorted.slice(i, i + step);
    let sum = 0;
    for (const r of chunk) sum += sentimentOf(r.text);
    out.push({
      i,
      ts: chunk[0].ts,
      n: chunk.length,
      mean: Math.round((sum / chunk.length) * 100) / 100,
      label: chunk[0].text.slice(0, 24),
    });
  }
  return out;
}

export function createLearnService({ dataDir, onebot, getSettings, saveSettings }) {
  const root = path.join(dataDir, 'qq-learn');
  const weeksDir = path.join(root, 'weeks');
  const store = new GroupStore(root);
  const state = { lastIngestAt: 0, lastSettleAt: 0, rounds: 0, lastError: '' };

  async function settings() {
    try { return (await getSettings()) || {}; } catch { return {}; }
  }

  async function groupsWanted() {
    const s = await settings();
    const picked = Array.isArray(s.learnGroups) ? s.learnGroups.map((x) => String(x).trim()).filter(Boolean) : [];
    if (picked.length) return picked;
    return store.groups().map((g) => g.gid);
  }

  /** 从 OneBot 拉群列表（需要实例在线）。 */
  async function refreshGroups() {
    const s0 = await settings();
    const cfg = s0.__qq || null;
    if (!cfg) throw new Error('还没接上 QQ 通道');
    const d = await onebot(cfg, 'get_group_list', {});
    const list = (d && d.data) || [];
    const groups = list.map((g) => {
      const gid = String(g.group_id ?? '');
      return {
        gid,
        name: String(g.group_name ?? ''),
        members: Number(g.member_count) || null,
        count: gid ? store.stats(gid).count : 0,
      };
    }).filter((g) => g.gid);
    const keep = s0.learnGroupMeta && typeof s0.learnGroupMeta === 'object' ? s0.learnGroupMeta : {};
    const meta = { ...keep };
    for (const g of groups) meta[g.gid] = { name: g.name, members: g.members };
    await saveSettings({ learnGroupMeta: meta });
    return groups;
  }

  /** 抽一批历史消息进来。pages 越大越往前翻。 */
  async function ingest({ gids = null, pages = 3, count = 100 } = {}) {
    const cfg = (await settings()).__qq || null;
    if (!cfg) throw new Error('还没接上 QQ 通道');
    const targets = gids && gids.length ? gids.map(String) : await groupsWanted();
    const out = [];
    for (const gid of targets) {
      if (!gid) continue;
      let added = 0;
      let seqCursor = null;
      let failed = '';
      for (let page = 0; page < Math.max(1, Math.min(20, pages)); page++) {
        const params = { group_id: Number(gid), count: Math.max(1, Math.min(100, count)) };
        if (seqCursor) params.message_seq = seqCursor;
        let d;
        try {
          d = await onebot(cfg, 'get_group_msg_history', params);
        } catch (e) {
          failed = String((e && e.message) || e);
          break;
        }
        const arr = ((d && d.data && (d.data.messages || d.data)) || []).slice() || [];
        if (!arr.length) break;
        const recs = arr.map((m) => normalizeOneBotMessage(m, gid)).filter(Boolean);
        if (!recs.length) break;
        added += store.append(gid, recs);
        const oldest = recs.reduce((a, b) => (a.ts <= b.ts ? a : b));
        if (seqCursor && oldest.mid === seqCursor) break;
        seqCursor = oldest.mid;
        if (recs.length < count) break;
        if (oldest.ts < Date.now() / 1000 - 400 * 86400) break; // 别无限往回翻
      }
      out.push({ gid, added, failed });
    }
    state.lastIngestAt = Date.now();
    state.rounds++;
    const bad = out.find((o) => o.failed);
    state.lastError = bad ? bad.failed : '';
    return out;
  }

  function readWeekFile(gid, week) {
    const f = path.join(weeksDir, `${gid}__${week}.json`);
    if (!fs.existsSync(f)) return null;
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
  }

  function listWeeks({ gid = '' } = {}) {
    if (!fs.existsSync(weeksDir)) return [];
    const out = [];
    for (const name of fs.readdirSync(weeksDir)) {
      if (!name.endsWith('.json')) continue;
      const [g, w] = name.replace(/\.json$/, '').split('__');
      if (gid && g !== String(gid)) continue;
      const data = readWeekFile(g, w);
      if (!data) continue;
      out.push({
        gid: g, week: w, msgs: data.msgs, people: data.people,
        avgSentiment: data.avgSentiment, memes: (data.memes || []).length,
        settledAt: data.settledAt || null, closed: !!data.closed,
      });
    }
    return out.sort((a, b) => (a.week === b.week ? a.gid.localeCompare(b.gid) : b.week.localeCompare(a.week)));
  }

  function weekMarkdown(gid, week) {
    const f = path.join(weeksDir, `${gid}__${week}.md`);
    if (!fs.existsSync(f)) return null;
    return fs.readFileSync(f, 'utf8');
  }

  /** 把还没结算的周写出来（一个群一周一份 json + md）。 */
  async function settle({ gids = null, force = false } = {}) {
    const s0 = await settings();
    const targets = gids && gids.length ? gids.map(String) : store.groups().map((g) => g.gid);
    fs.mkdirSync(weeksDir, { recursive: true });
    const done = [];
    for (const gid of targets) {
      const recs = store.list(gid);
      if (!recs.length) continue;
      const byWeek = new Map();
      for (const r of recs) {
        const w = isoWeek(r.ts);
        if (!byWeek.has(w)) byWeek.set(w, []);
        byWeek.get(w).push(r);
      }
      for (const [week, rs] of byWeek) {
        const existing = readWeekFile(gid, week);
        // 本周还在长：除非 force 或者已经过了那周，否则先不盖
        const weekEnd = (Math.max(...rs.map((r) => r.ts)) + WEEK_MS) * 1000;
        const closed = Date.now() > weekEnd + 86400 * 1000;
        if (existing && !force && !closed) continue;
        if (existing && !force && existing.msgs === rs.length) continue;
        const a = analyze(rs);
        const wk = (a.weeks && a.weeks[0]) || null;
        const report = {
          gid, week, settledAt: new Date().toISOString(),
          msgs: rs.length, people: a.people,
          name: (s0.learnGroupMeta && s0.learnGroupMeta[gid] && s0.learnGroupMeta[gid].name) || '',
          overall: a.overall, rhythm: a.rhythm, sentimentBase: a.sentiment.base,
          avgSentiment: a.sentiment.base && a.sentiment.base.mean,
          topReplyPair: a.graph.edges[0] || null,
          memes: a.memes.slice(0, 12),
          topPeople: a.peopleTop.slice(0, 8),
          closed,
        };
        fs.writeFileSync(path.join(weeksDir, `${gid}__${week}.json`), JSON.stringify(report, null, 2), 'utf8');
        fs.writeFileSync(path.join(weeksDir, `${gid}__${week}.md`),
          renderWeeklyMarkdown(wk || report, { name: report.name }), 'utf8');
        done.push({ gid, week });
      }
    }
    state.lastSettleAt = Date.now();
    return done;
  }

  async function analysisFor({ gid, since = 0, until = 0, n = 6 } = {}) {
    const s0 = await settings();
    const g = String(gid || (await groupsWanted())[0] || '');
    if (!g) return { empty: true, gid: '', groups: [], wanted: [] };
    const recs = store.list(g, {
      since: Number(since) || 0,
      until: Number(until) || Infinity,
    });
    const a = analyze(recs, { n });
    const meta = (s0.learnGroupMeta && s0.learnGroupMeta[g]) || {};
    return {
      ...a,
      series: emotionSeries(recs),
      gid: g,
      nick: meta.name || '',
      members: meta.members || null,
      groups: store.groups(),
      wanted: await groupsWanted(),
      weekNow: isoWeek(Date.now() / 1000),
      weekStats: Array.isArray(a.weeks) ? a.weeks : [],
      weeks: listWeeks({ gid: g }).slice(0, 10),
    };
  }

  async function profileFor({ gid, maxChars = 600 } = {}) {
    const g = String(gid || (await groupsWanted())[0] || '');
    if (!g) return '';
    const a = analyze(store.list(g), { n: 6 });
    if (a.empty) return '';
    return buildLearnedProfile(a, { maxChars });
  }

  async function status() {
    const s = await settings();
    const meta = s.learnGroupMeta && typeof s.learnGroupMeta === 'object' ? s.learnGroupMeta : {};
    return {
      ok: true,
      dir: root,
      store: store.groups().map((g) => ({
        ...g,
        name: (meta[g.gid] && meta[g.gid].name) || '',
        members: (meta[g.gid] && meta[g.gid].members) || null,
      })),
      wanted: await groupsWanted(),
      auto: s.learnAuto !== false,
      inject: s.learnInject === true,
      n: Number(s.learnN) || 6,
      pages: Number(s.learnPages) || 2,
      weeks: listWeeks().slice(0, 12),
      state: { ...state },
    };
  }

  /** 定时那一轮：抽消息 → 跨周就结算。返回一句人话，方便日志里看。 */
  async function tick({ pages = 2 } = {}) {
    const s = await settings();
    if (s.learnAuto === false) return { skipped: 'auto-off' };
    const cfg = s.__qq || null;
    if (!cfg) return { skipped: 'qq-off' };
    const targets = await groupsWanted();
    if (!targets.length) return { skipped: 'no-groups' };
    let added = 0;
    try {
      const res = await ingest({ gids: targets, pages });
      added = res.reduce((a, r) => a + r.added, 0);
    } catch (e) {
      state.lastError = String((e && e.message) || e);
      return { skipped: 'ingest-failed', error: state.lastError };
    }
    const nowWeek = isoWeek(Date.now() / 1000);
    let settled = [];
    if ((s.learnLastSettledWeek || '') !== nowWeek) {
      settled = await settle();
      await saveSettings({ learnLastSettledWeek: nowWeek });
    }
    return { added, settled: settled.length, week: nowWeek };
  }

  return {
    root, store, refreshGroups, ingest, analysisFor, settle,
    listWeeks, weekMarkdown, profileFor, status, tick,
  };
}

export default { createLearnService };
