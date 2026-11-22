// 日历/时钟的本机实现：纯函数，零依赖。
// 事件形状：{ id, title, date: 'YYYY-MM-DD', time?: 'HH:MM', end?: 'HH:MM', note?, done?, convId? }
// 存在 data/calendar.json 里，只有本机读得到。

const pad = n => String(n).padStart(2, '0');

/** 本地日期串 YYYY-MM-DD */
export function dateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本地时间串 HH:MM */
export function timeStr(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 'YYYY-MM-DD' → Date（本地零点）；坏值返回 null */
export function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? dt : null;
}

/** 两个日期差几天（b - a，按本地零点算） */
export function daysBetween(a, b) {
  const da = parseDate(a);
  const db = parseDate(b);
  if (!da || !db) return 0;
  return Math.round((db - da) / 86400000);
}

/** 某天的星期几（0=周日），坏值回 0 */
export function weekdayOf(s) {
  const d = parseDate(s);
  return d ? d.getDay() : 0;
}

export const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 一个月（或跨到相邻月）的 6×7 网格，每格 { date, day, inMonth, isToday, weekday }
 * month 是 1..12
 */
export function monthGrid(year, month, today = dateStr()) {
  const first = new Date(year, month - 1, 1);
  const startOffset = first.getDay(); // 周日开头
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(year, month - 1, 1 - startOffset + i);
    const ds = dateStr(d);
    cells.push({
      date: ds,
      day: d.getDate(),
      inMonth: d.getMonth() === month - 1,
      isToday: ds === today,
      weekday: d.getDay(),
    });
  }
  return cells;
}

/** 事件排序：先按日期，再按时间（全天在当日最前），最后按标题 */
export function sortEvents(list) {
  return [...list].sort((a, b) => {
    const da = String(a.date || '');
    const db = String(b.date || '');
    if (da !== db) return da < db ? -1 : 1;
    const ta = a.time || '00:00';
    const tb = b.time || '00:00';
    if (ta !== tb) return ta < tb ? -1 : 1;
    return String(a.title || '').localeCompare(String(b.title || ''), 'zh');
  });
}

/** 某天的事件（已排序） */
export function eventsOn(events, date) {
  return sortEvents((events || []).filter(e => e && e.date === date));
}

/** 从某天起的未来 n 天内的事件（含当天），按日期时间排序 */
export function upcoming(events, from = dateStr(), days = 7) {
  const groups = new Map();
  for (const e of events || []) {
    if (!e || !parseDate(e.date) || e.done) continue;
    const diff = daysBetween(from, e.date);
    if (diff < 0 || diff >= days) continue;
    if (!groups.has(e.date)) groups.set(e.date, []);
    groups.get(e.date).push(e);
  }
  return [...groups.keys()].sort().map(date => ({ date, items: sortEvents(groups.get(date)) }));
}

/** 今天还没到点（或全天）的事件 */
export function restOfDay(events, now = new Date()) {
  const ds = dateStr(now);
  const hm = timeStr(now);
  return eventsOn(events, ds).filter(e => !e.done && (!e.time || e.time >= hm));
}

/** 新事件：合法化 + 补 id */
export function makeEvent(input, makeId) {
  const title = String(input?.title || '').trim().slice(0, 120);
  const rawDate = String(input?.date || '');
  const date = parseDate(rawDate) ? rawDate : dateStr();
  const time = TIME_RE.test(String(input?.time || '')) ? String(input.time) : '';
  const end = TIME_RE.test(String(input?.end || '')) ? String(input.end) : '';
  return {
    id: String(input?.id || '') || makeId(),
    title,
    date,
    time,
    end,
    note: String(input?.note || '').slice(0, 500),
    done: !!input?.done,
    convId: String(input?.convId || ''),
    createdAt: Number(input?.createdAt) || Date.now(),
  };
}

/** 改动合并（只接受认识的键） */
export function patchEvent(ev, input) {
  const out = { ...ev };
  if (typeof input?.title === 'string') out.title = input.title.trim().slice(0, 120) || out.title;
  if (parseDate(String(input?.date || ''))) out.date = String(input.date);
  if (typeof input?.time === 'string') out.time = TIME_RE.test(input.time) ? input.time : '';
  if (typeof input?.end === 'string') out.end = TIME_RE.test(input.end) ? input.end : '';
  if (typeof input?.note === 'string') out.note = input.note.slice(0, 500);
  if (typeof input?.done === 'boolean') out.done = input.done;
  if (typeof input?.convId === 'string') out.convId = input.convId;
  return out;
}

/** 给模型看的日程块；没有事件返回空串 */
export function scheduleText(events, now = new Date(), days = 3) {
  const ds = dateStr(now);
  const today = eventsOn(events, ds);
  const soon = [];
  for (let i = 1; i < days; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const list = eventsOn(events, dateStr(d));
    if (list.length) soon.push({ date: dateStr(d), items: list });
  }
  if (!today.length && !soon.length) return '';
  const fmt = e => `${e.time ? e.time + ' ' : ''}${e.title}${e.done ? '（已完成）' : ''}${e.note ? ` —— ${e.note}` : ''}`;
  const lines = [];
  lines.push(`今天是 ${ds}（${WEEKDAYS[weekdayOf(ds)]}），现在 ${timeStr(now)}。`);
  if (today.length) {
    lines.push(`今天的日程（${today.length} 条）：`);
    today.forEach(e => lines.push(`- ${fmt(e)}`));
  } else {
    lines.push('今天没有日程。');
  }
  for (const g of soon) {
    lines.push(`${g.date}（${WEEKDAYS[weekdayOf(g.date)]}）：`);
    g.items.forEach(e => lines.push(`- ${fmt(e)}`));
  }
  return lines.join('\n');
}
