// 日历 / 时钟：纯函数 + 接口 + 日程进上下文
// 用法：node tools/calendar-test.mjs   （先起服务：node server.mjs）
import { liveGuard } from './_guard.mjs';
import {
  dateStr, timeStr, parseDate, daysBetween, weekdayOf, WEEKDAYS,
  monthGrid, sortEvents, eventsOn, upcoming, restOfDay,
  makeEvent, patchEvent, scheduleText,
} from '../calendar.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
await liveGuard(BASE, 'calendar-test');
let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function j(pathname, opts = {}) {
  const r = await fetch(BASE + pathname, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

const created = [];
let savedSettings = null;

async function cleanup() {
  for (const id of created) await j('/api/calendar/' + id, { method: 'DELETE' }).catch(() => {});
  if (savedSettings) {
    await j('/api/settings', {
      method: 'PUT',
      body: {
        calendarInContext: savedSettings.calendarInContext,
        calendarDays: savedSettings.calendarDays,
      },
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------- 纯函数
console.log('\n1. 纯函数');
{
  const d = new Date(2026, 10, 22, 9, 5); // 2026-11-22 周日
  check('dateStr 补零', dateStr(d) === '2026-11-22', dateStr(d));
  check('timeStr 补零', timeStr(d) === '09:05', timeStr(d));
  check('parseDate 合法', parseDate('2026-11-22') instanceof Date);
  check('parseDate 坏值 null', parseDate('2026-13-40') === null && parseDate('') === null && parseDate('abc') === null);
  check('daysBetween 正负', daysBetween('2026-11-22', '2026-11-24') === 2 && daysBetween('2026-11-24', '2026-11-22') === -2);
  check('daysBetween 坏值 0', daysBetween('x', '2026-11-24') === 0);
  check('weekdayOf 周日=0', weekdayOf('2026-11-22') === 0, String(WEEKDAYS[0]));
  check('WEEKDAYS 长度', WEEKDAYS.length === 7 && WEEKDAYS[6] === '周六');
}

{
  const grid = monthGrid(2026, 11, '2026-11-22');
  check('monthGrid 42 格', grid.length === 42);
  check('monthGrid 周日开头', grid[0].weekday === 0, `${grid[0].date} 周${grid[0].weekday}`);
  check('monthGrid 今天标记', grid.filter(c => c.isToday).length === 1, grid.find(c => c.isToday)?.date);
  check('monthGrid 含本月 30 天', grid.filter(c => c.inMonth).length === 30);
}

{
  const evs = [
    { id: 'a', title: 'B 事', date: '2026-11-22', time: '15:00' },
    { id: 'b', title: 'A 事', date: '2026-11-22', time: '09:00' },
    { id: 'c', title: '全天事', date: '2026-11-22' },
    { id: 'd', title: '明天', date: '2026-11-23', time: '10:00' },
    { id: 'e', title: '做完了', date: '2026-11-23', time: '08:00', done: true },
  ];
  const sorted = sortEvents(evs);
  check('sortEvents 当天全天在前', sorted[0].id === 'c', sorted.map(e => e.id).join(','));
  check('sortEvents 同一天按时间', sorted[1].id === 'b' && sorted[2].id === 'a', sorted.map(e => e.id).join(','));
  check('sortEvents 先按日期', sorted.slice(3).every(e => e.date === '2026-11-23'), sorted.map(e => e.date).join(','));
  check('eventsOn 只取那天', eventsOn(evs, '2026-11-22').length === 3);
  const up = upcoming(evs, '2026-11-22', 7);
  check('upcoming 分组', up.length === 2 && up[0].date === '2026-11-22' && up[1].date === '2026-11-23', JSON.stringify(up.map(g => g.date + ':' + g.items.length)));
  check('upcoming 跳过 done', up[1].items.every(e => !e.done));
  const rest = restOfDay(evs, new Date(2026, 10, 22, 10, 0));
  check('restOfDay 去掉过点与 done', rest.length === 2 && rest.every(e => e.time !== '09:00'), JSON.stringify(rest.map(e => e.time || '全天')));
}

{
  const mk = () => 'id-x';
  const ev = makeEvent({ title: '  看牙医  ', date: '2026-11-22', time: '15:30', end: '16:00', note: 'x'.repeat(600) }, mk);
  check('makeEvent 去空格截断', ev.title === '看牙医' && ev.note.length === 500 && ev.id === 'id-x');
  check('makeEvent 坏时间丢空', makeEvent({ title: 't', date: '2026-11-22', time: '99:99' }, mk).time === '');
  check('makeEvent 坏日期回落今天', makeEvent({ title: 't', date: '2026-13-40' }, mk).date === dateStr());
  const p = patchEvent(ev, { title: '改过', done: true, time: '16:30', note: '短' });
  check('patchEvent 只改认识的键', p.title === '改过' && p.done === true && p.time === '16:30' && p.date === '2026-11-22' && p.note === '短');
  check('patchEvent 不动 unknown', patchEvent(ev, { hack: 1 }).hack === undefined);
}

{
  const now = new Date(2026, 10, 22, 9, 0);
  const txt = scheduleText([
    { title: '看牙医', date: '2026-11-22', time: '15:30', note: '带医保卡' },
    { title: '评审', date: '2026-11-24' },
  ], now, 3);
  check('scheduleText 带今天与星期', txt.includes('2026-11-22') && txt.includes('周日') && txt.includes('09:00'), txt.split('\n')[0]);
  check('scheduleText 带时间与备注', txt.includes('15:30 看牙医') && txt.includes('带医保卡'));
  check('scheduleText 未来分组', txt.includes('2026-11-24（周二）') && txt.includes('- 评审'));
  check('scheduleText 空日历返回空串', scheduleText([], now, 3) === '');
  check('scheduleText 只看 days 天', !scheduleText([{ title: '远', date: '2026-11-30' }], now, 3).includes('2026-11-30'));
}

// ---------------------------------------------------------------- 接口
console.log('\n2. 接口');
const today = dateStr();

{
  const r = await j('/api/calendar');
  check('GET /api/calendar 200', r.status === 200 && r.data.today === today, JSON.stringify(r.data.today));
  check('返回 now/weekday/events', typeof r.data.now === 'string' && typeof r.data.weekday === 'number' && Array.isArray(r.data.events));
  check('返回 todayEvents/restOfDay/upcoming', Array.isArray(r.data.todayEvents) && Array.isArray(r.data.restOfDay) && Array.isArray(r.data.upcoming));
}

{
  const r = await j('/api/calendar', { method: 'POST', body: {} });
  check('POST 没标题 400', r.status === 400 && /标题/.test(String(r.data.error)), String(r.data.error));
}

{
  const r = await j('/api/calendar', { method: 'POST', body: { title: 'x', date: '2026-02-31' } });
  check('POST 假日期 400', r.status === 400 && /日期/.test(String(r.data.error)), String(r.data.error));
}

{
  const r = await j('/api/calendar', { method: 'POST', body: { title: '日历测试：看牙医', date: today, time: '15:30', end: '16:00', note: '带医保卡' } });
  const ev = r.data?.event;
  if (ev) created.push(ev.id);
  check('POST 建事件 200', r.status === 200 && !!ev && ev.title === '日历测试：看牙医', ev?.id);
  check('POST 返回刷新后的 todayEvents', (r.data.todayEvents || []).some(e => e.id === ev?.id));
  check('时间被收下', ev?.time === '15:30' && ev?.end === '16:00' && ev?.note === '带医保卡');
}

{
  const future = new Date();
  future.setDate(future.getDate() + 2);
  const r = await j('/api/calendar', { method: 'POST', body: { title: '日历测试：未来评审', date: dateStr(future), time: '10:00' } });
  if (r.data?.event) created.push(r.data.event.id);
  check('POST 未来事件进 upcoming', (r.data.upcoming || []).some(g => g.date === dateStr(future)));
}

{
  const id = created[0];
  const r = await j('/api/calendar/' + id, { method: 'PATCH', body: { done: true, title: '日历测试：看牙医（改）' } });
  check('PATCH 改标题与完成', r.status === 200 && r.data.event.done === true && r.data.event.title === '日历测试：看牙医（改）');
  check('PATCH 后 restOfDay 不再含它', !(r.data.restOfDay || []).some(e => e.id === id));
}

{
  const r = await j('/api/calendar/cal_nope', { method: 'PATCH', body: { done: true } });
  check('PATCH 不存在 404', r.status === 404, String(r.data.error));
}

{
  const id = created[0];
  const r = await j('/api/calendar/' + id, { method: 'DELETE' });
  check('DELETE 200', r.status === 200 && r.data.deleted === id);
  check('DELETE 之后列表里没了', !(r.data.events || []).some(e => e.id === id));
  created.shift();
}

// ---------------------------------------------------------------- 日程进上下文
console.log('\n3. 日程进上下文（假上游）');
{
  const mock = 'http://127.0.0.1:8899';
  let mockOk = false;
  try {
    const r = await fetch(mock + '/models', { signal: AbortSignal.timeout(800) });
    mockOk = r.ok;
  } catch {}
  if (!mockOk) {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['tools/mock-upstream.mjs'], { stdio: 'ignore', detached: true });
    child.unref();
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      try {
        const r = await fetch(mock + '/models', { signal: AbortSignal.timeout(600) });
        if (r.ok) { mockOk = true; break; }
      } catch {}
    }
  }
  if (!mockOk) {
    console.log('  - 跳过：假上游没起来');
  } else {
    savedSettings = (await j('/api/settings')).data;
    await j('/api/calendar', { method: 'POST', body: { title: '日历测试：下午三点看牙', date: dateStr(), time: '15:00' } });
    const cal = await j('/api/calendar');
    const evIds = (cal.data.events || []).filter(e => String(e.title).startsWith('日历测试：')).map(e => e.id);
    created.push(...evIds);
    await j('/api/settings', { method: 'PUT', body: { apiKey: 'sk-mock-calendar-test', baseUrl: mock, calendarInContext: true, calendarDays: 3, autoTitle: false, safetyLevel: 'off' } });
    const conv = (await j('/api/conversations', { method: 'POST', body: { title: '日历上下文测试' } })).data;
    const cid = conv?.id || conv?.conversation?.id;
    check('建测试会话', !!cid, String(cid || JSON.stringify(conv).slice(0, 80)));
    if (cid) {
      const resp = await fetch(BASE + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: cid, content: '我下午有什么安排？', model: 'deepseek-flash' }),
      });
      const text = await resp.text();
      const ctxLine = text.split('\n').find(l => l.startsWith('data: ') && l.includes('"type":"context"'));
      let ctx = null;
      try { ctx = JSON.parse(ctxLine.slice(6)); } catch {}
      check('SSE 带 context 事件', !!ctx);
      check('context 事件里有 schedule', ctx?.schedule && typeof ctx.schedule.today === 'number', JSON.stringify(ctx?.schedule || null));
      const rec = await import('node:fs/promises').then(m => m.readFile('data/mock-last.json', 'utf8')).catch(() => '');
      check('上游收到日程 system 块', String(rec).includes('【日程 · 本机日历】'));
      check('日程块里有今天的事件', String(rec).includes('日历测试：下午三点看牙'));
      await j('/api/conversations/' + cid, { method: 'DELETE' }).catch(() => {});
    }
    await j('/api/settings', { method: 'PUT', body: { apiKey: '', baseUrl: savedSettings.baseUrl, calendarInContext: savedSettings.calendarInContext, calendarDays: savedSettings.calendarDays, autoTitle: savedSettings.autoTitle, safetyLevel: savedSettings.safetyLevel } });
  }
}

await cleanup();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
