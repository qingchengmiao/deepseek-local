// 日程表 + 日志（面向模型的那一份）
//
// 要求来自用户：日程表和日志都由大模型编辑，是给**模型**看的，不是给人看的报表；
// 在不活跃时段自己写，用来做强化记忆。所以：
//   · calendar.md  —— 「接下来要做什么」，模型每次装配上下文时读它
//   · journal/*.md —— 「之前发生过什么」，按天一段，模型读最近几天
//   · 只在没人的时候写（距最后一次活动超过 idleMin 分钟），不抢实时回复的算力
//
// 两份都由模型写。代码只做三件事：把原料备好（日历里的原始事件、今天的对话片段、
// 上一版日程表）、给死格式、把模型吐出来的东西清洗一遍（去编号/去复读/限行），
// 清洗后不合格就整段丢掉——绝不覆盖已有内容。
//
// 写不进去就跳过，不要因为日志写不出来而影响聊天。全部 try/catch 兜住。

import fsp from 'node:fs/promises';
import path from 'node:path';

const pad = n => String(n).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function stamp(d = new Date()) { return `${dayKey(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
const clip = (s, n) => { const t = String(s || ''); return t.length > n ? t.slice(0, n) + '…' : t; };

const SYS = [
  '你在维护给自己看的两样东西：日程表（接下来要做什么）和日志（今天发生过什么）。',
  '严格按下面这个格式输出，不要别的话：',
  '<日程>',
  '- 2026-12-02 10:00 去医院复查',
  '</日程>',
  '<日志>',
  '今天定下了日程表和日志的写法，日程表改由模型编辑。',
  '顺手把提醒文案里的机器腔去掉了。',
  '</日志>',
  '规则：日程表最多 8 行，每行「- 日期 时间 事项」，按时间从早到晚；只写还没发生的事，',
  '已经过去的、已经做完的删掉。日志三到五句，每句一行，只写事实，不要小标题不要客套。',
  '原料里没有的事不要编。',
].join('\n');

/** 从模型输出里取两段；标签缺了就整段当日志 */
function splitSections(raw) {
  const s = String(raw || '');
  const cal = /<日程>([\s\S]*?)<\/日程>/.exec(s);
  const jr = /<日志>([\s\S]*?)<\/日志>/.exec(s);
  if (cal || jr) return { calendar: cal ? cal[1] : '', journal: jr ? jr[1] : '' };
  return { calendar: '', journal: s };
}

export function createDiary({ dataDir, log = () => {}, chat, settingsOf, recentText, lastActivityAt, upcoming = null }) {
  const root = path.join(dataDir, 'model');
  const calendarPath = path.join(root, 'calendar.md');
  const journalDir = path.join(root, 'journal');
  const state = { lastWriteAt: 0, lastReason: '', writing: false, lastError: '', wrote: 0 };

  const readText = async p => { try { return await fsp.readFile(p, 'utf8'); } catch { return ''; } };
  const writeText = async (p, s) => { await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, s, 'utf8'); };

  async function readCalendar() { return (await readText(calendarPath)).trim(); }

  async function listJournals() {
    try {
      const names = await fsp.readdir(journalDir);
      return names.filter(n => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort().reverse();
    } catch { return []; }
  }

  async function readJournal(day) { return (await readText(path.join(journalDir, `${day}.md`))).trim(); }

  /** 装配进上下文用：日程表 + 最近 N 天日志，限字数 */
  async function readForPrompt({ days = 3, maxChars = 2600 } = {}) {
    const cal = await readCalendar();
    const names = (await listJournals()).slice(0, Math.max(1, Math.min(14, days)));
    const items = [];
    for (const n of names) {
      const text = (await readJournal(n.replace(/\.md$/, ''))).trim();
      if (text) items.push(`### ${n.replace(/\.md$/, '')}\n${text}`);
    }
    if (!cal && !items.length) return '';
    const body = [cal ? `## 日程表（我看的，不是表格）\n${cal}` : '', items.length ? `## 最近的日志\n${items.join('\n\n')}` : '']
      .filter(Boolean).join('\n\n');
    return clip(body, maxChars);
  }

  /** 原料：日历里还没发生、还没完成的事（原样给模型，不给它排好） */
  async function eventMaterial(now = Date.now()) {
    let list = [];
    try { list = (await upcoming()) || []; } catch { list = []; }
    return list
      .filter(e => e && e.title && Number(e.at) > now - 3600e3 && e.status !== 'done' && e.status !== 'fired')
      .sort((a, b) => a.at - b.at)
      .slice(0, 12)
      .map(e => {
        const d = new Date(Number(e.at));
        return `${dayKey(d)} ${pad(d.getHours())}:${pad(d.getMinutes())} ${String(e.title).trim()}`;
      })
      .join('\n');
  }

  /** 清洗模型写的日程：去编号、去复读、限 8 行；不合格返空（调用方保留旧版） */
  function cleanCalendar(raw) {
    const lines = String(raw || '')
      .split(/\r?\n/)
      .map(s => s.replace(/^\s*[-*·•]\s*/, '').replace(/^#+\s*/, '').replace(/^\d+[.、)）]\s*/, '').trim())
      .filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const line of lines) {
      if (line.length < 4 || line.length > 80) continue;
      if (/^(日程表?|日志|今天|明天)$/.test(line)) continue;
      if (line.length <= 14 && /[：:]$/.test(line)) continue;
      const key = line.replace(/\s/g, '');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
      if (out.length >= 8) break;
    }
    const joined = out.join('\n');
    if (!joined) return '';
    if (/^(.{2,12})\1{2,}/.test(joined.replace(/\n/g, ''))) return '';
    // 一条都不带日期时间 = 模型没照格式写，宁可不要
    if (!out.some(l => /\d{1,2}[-/月]\d{1,2}|\d{1,2}:\d{2}|今天|明天|后天/.test(l))) return '';
    return clip(out.map(l => `- ${l}`).join('\n'), 800);
  }

  /** 清掉模型复读出来的垃圾：单行去重、整行重复超过一次的直接丢、最多 5 行 */
  function cleanJournal(raw) {
    const lines = String(raw || '')
      .split(/\r?\n/)
      .map(s => s.replace(/^\s*[-*·•]\s*/, '').replace(/^#+\s*/, '').replace(/^\d+[.、)）]\s*/, '').trim())
      .filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const line of lines) {
      if (line.length < 4) continue;
      // 「今天的工作日志：」这种装饰性抬头丢掉
      if (line.length <= 14 && /[：:]$/.test(line)) continue;
      const key = line.replace(/\s/g, '');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
      if (out.length >= 5) break;
    }
    const joined = out.join('\n');
    if (!joined) return '';
    if (/^(.{2,12})\1{2,}/.test(joined.replace(/\n/g, ''))) return '';
    return clip(joined, 520);
  }

  /** 写一次。force=true 时无视「不活跃」与「刚写过」的闸 */
  async function write({ force = false, reason = 'idle' } = {}) {
    if (state.writing) return { ok: false, error: '上一次还在写' };
    const settings = (await settingsOf()) || {};
    if (settings.diaryEnabled === false) return { ok: false, error: '日志关着' };
    const idleMin = Math.max(5, Math.min(24 * 60, Number(settings.diaryIdleMin ?? 30)));
    const idleMs = idleMin * 60e3;
    const lastAct = typeof lastActivityAt === 'function' ? Number(await lastActivityAt()) || 0 : 0;
    if (!force) {
      if (lastAct && Date.now() - lastAct < idleMs) return { ok: false, error: '人还在说话' };
      if (state.lastWriteAt && Date.now() - state.lastWriteAt < idleMs) return { ok: false, error: '刚写过' };
    }
    state.writing = true;
    let wroteCal = false;
    let journal = '';
    try {
      const mats = await eventMaterial();
      const prevCal = await readCalendar();
      const prevCalBody = prevCal.replace(/^#[^\n]*\n+/, '').replace(/^_更新于[^\n]*_\n*/m, '').trim();
      const text = clip(String(await recentText({ hours: 24, maxChars: 2600 }) || '').trim(), 2600);

      const user = [
        `现在是 ${stamp()}。`,
        mats ? `日历里已经排定的事（原始数据）：\n${mats}` : '日历里还没排定任何事。',
        prevCalBody ? `上一版日程表长这样，在它基础上改（该删的删、该留的留）：\n${prevCalBody}` : '',
        text ? `今天聊过的片段：\n${text}` : '今天还没聊过。',
        '按格式输出日程表和日志。',
      ].filter(Boolean).join('\n\n');

      const parts = splitSections(await chat(SYS, user));
      const calBody = cleanCalendar(parts.calendar);
      if (calBody) {
        const calText = `# 日程表\n\n_更新于 ${stamp()}_\n\n${calBody}\n`;
        if (calText !== await readText(calendarPath)) { await writeText(calendarPath, calText); wroteCal = true; }
      }

      journal = cleanJournal(parts.journal);
      if (journal) {
        const today = dayKey(new Date());
        const prevJr = await readJournal(today);
        const block = `## ${stamp().slice(11)}\n${journal}\n`;
        const head = prevJr ? '' : `# ${today}\n\n`;
        await writeText(path.join(journalDir, `${today}.md`), `${head}${prevJr ? prevJr.trimEnd() + '\n\n' : ''}${block}`);
      }

      if (!wroteCal && !journal) { state.lastReason = '没有新的东西可写'; return { ok: false, error: state.lastReason }; }
      state.lastWriteAt = Date.now();
      state.lastReason = reason;
      state.wrote += 1;
      state.lastError = '';
      log(`[日志] 写完了（${reason}）日程 ${wroteCal ? '已更新' : '没变'} / 日志 ${journal ? journal.length + ' 字' : '空'}`);
      return { ok: true, calendar: wroteCal ? calBody : '', journal };
    } catch (e) {
      state.lastError = e.message;
      log(`[日志] 没写成：${e.message}`);
      return { ok: false, error: e.message };
    } finally {
      state.writing = false;
    }
  }

  async function status() {
    const settings = (await settingsOf()) || {};
    const names = await listJournals();
    return {
      enabled: settings.diaryEnabled !== false,
      idleMin: Math.max(5, Math.min(24 * 60, Number(settings.diaryIdleMin ?? 30))),
      dir: path.relative(process.cwd(), root) || 'data/model',
      calendarPath,
      calendar: clip(await readCalendar(), 4000),
      journals: names.slice(0, 14),
      wrote: state.wrote,
      lastWriteAt: state.lastWriteAt,
      lastReason: state.lastReason,
      lastError: state.lastError,
      writing: state.writing,
    };
  }

  let timer = null;
  function startLoop(intervalMs = 5 * 60e3) {
    if (timer) return;
    timer = setInterval(() => { write({ reason: 'idle' }).catch(() => {}); }, intervalMs);
    if (timer.unref) timer.unref();
    log(`[日志] 空闲检查已启动（每 ${Math.round(intervalMs / 1000)} 秒）`);
  }
  function stopLoop() { if (timer) { clearInterval(timer); timer = null; } }

  return { readCalendar, readJournal, listJournals, readForPrompt, write, status, startLoop, stopLoop, paths: { root, calendarPath, journalDir } };
}
