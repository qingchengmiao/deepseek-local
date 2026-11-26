// 日程表 + 日志（面向模型的那一份）
//
// 要求来自用户：日程表和日志是给**模型**看的，不是给人看的报表；在不活跃时段自己写，
// 用来做强化记忆。所以：
//   · calendar.md  —— 「接下来要做什么」，模型每次装配上下文时读它
//   · journal/*.md —— 「之前发生过什么」，按天一段，模型读最近几天
//   · 只在没人的时候写（距最后一次活动超过 idleMin 分钟），不抢实时回复的算力
//
// 一个原则：**能用代码算的不要问模型。** 本机只有 qwen2.5-1.5b，让它生成结构化清单会
// 退化成「11:00-12:00：洗碗 / 12:00-13:00：洗碗 …」这种复读。所以：
//   · 日程表 = 事件库里的未完成事项，代码排好直接写文件（模型不参与）
//   · 日志   = 模型只写「三五句人话」，出来后再做去重/截断的清洗；清洗不干净就整段丢掉，
//              绝不覆盖已有的日志
//
// 写不进去就跳过，不要因为日志写不出来而影响聊天。全部 try/catch 兜住。

import fsp from 'node:fs/promises';
import path from 'node:path';

const pad = n => String(n).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function stamp(d = new Date()) { return `${dayKey(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
const clip = (s, n) => { const t = String(s || ''); return t.length > n ? t.slice(0, n) + '…' : t; };

// 只写日志，不写日程表——日程表由代码排
const SYS = [
  '你在写今天的工作日志，写给自己看。',
  '只要事实：聊了什么、定下什么、做到哪一步、下一步干什么、踩了什么坑。',
  '三句话，每句一行，不要开头客套，不要小标题，不要复述原话。',
  '不知道的别编，宁可不写。',
].join('\n');

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

  /** 从事件库排日程表：只留还没到点的、未完成的，最多 12 条 */
  async function buildCalendar(now = Date.now()) {
    let list = [];
    try { list = (await upcoming()) || []; } catch { list = []; }
    const rows = list
      .filter(e => e && e.title && Number(e.at) > now - 3600e3 && e.status !== 'done' && e.status !== 'fired')
      .sort((a, b) => a.at - b.at)
      .slice(0, 12)
      .map(e => {
        const d = new Date(Number(e.at));
        const day = dayKey(d) === dayKey(new Date(now)) ? '今天' : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        return `- ${day} ${pad(d.getHours())}:${pad(d.getMinutes())}　${String(e.title).trim()}`;
      });
    return rows.length ? rows.join('\n') : '- （手上没有排定的事）';
  }

  /** 清掉模型复读出来的垃圾：单行去重、整行重复超过一次的直接丢、最多 4 行 */
  function cleanJournal(raw) {
    const lines = String(raw || '')
      .split(/\r?\n/)
      .map(s => s.replace(/^\s*[-*·•]\s*/, '').replace(/^#+\s*/, '').trim())
      .filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const line of lines) {
      if (line.length < 4) continue;
      const key = line.replace(/\s/g, '');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
      if (out.length >= 4) break;
    }
    // 句子里同一个短语重复三次以上 = 退化，整段不要
    const joined = out.join('\n');
    if (/^(.{2,12})\1{2,}/.test(joined.replace(/\n/g, ''))) return '';
    return clip(joined, 420);
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
      // 1) 日程表：代码排，不经过模型
      const calBody = await buildCalendar();
      const calText = `# 日程表\n\n_更新于 ${stamp()}_\n\n${calBody}\n`;
      if (calText !== await readText(calendarPath)) { await writeText(calendarPath, calText); wroteCal = true; }

      // 2) 日志：模型写三五句，人话，出来清洗
      const text = clip(String(await recentText({ hours: 24, maxChars: 2600 }) || '').trim(), 2600);
      if (text) {
        const today = dayKey(new Date());
        const prevJr = await readJournal(today);
        const user = [
          `现在是 ${stamp()}。`,
          '下面是今天聊过的片段：',
          text,
          '',
          '写三句话（每句一行）当今天的日志。',
        ].join('\n');
        journal = cleanJournal(await chat(SYS, user));
        if (journal) {
          const block = `## ${stamp().slice(11)}\n${journal}\n`;
          const head = prevJr ? '' : `# ${today}\n\n`;
          await writeText(path.join(journalDir, `${today}.md`), `${head}${prevJr ? prevJr.trimEnd() + '\n\n' : ''}${block}`);
        }
      }
      if (!wroteCal && !journal) { state.lastReason = '没有新的东西可写'; return { ok: false, error: state.lastReason }; }
      state.lastWriteAt = Date.now();
      state.lastReason = reason;
      state.wrote += 1;
      state.lastError = '';
      log(`[日志] 写完了（${reason}）日程 ${wroteCal ? '重排' : '没变'} / 日志 ${journal ? journal.length + ' 字' : '空'}`);
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
