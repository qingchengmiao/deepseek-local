// 自调整：让模型自己改「以后该怎么说话」——温度和几句追加提示。
//
// 为什么单独一个模块：这两样是会跨轮、跨会话留下来的东西，
// 跟 per-turn 的 adaptiveTune（每轮按内容现算、算完就扔）不是一类。
// 模型改过一次，下一轮就得按新设定走，所以必须落盘、必须有历史、必须能撤回。
//
// 存什么（<data>/self-tune.json）：
//   temp            覆盖全局 temperature（null = 不覆盖，跟设置走）
//   addendum        「以后说话往这边偏」的追加提示，分三档：global / human / qq
//   history         每次改动的 before/after，界面上能逐条撤回
//
// 怎么改：模型在回答末尾给一块
//   ```tune
//   { "temperature": 0.85, "addendum": "别写总结段", "scope": "global", "why": "他连着三次嫌我啰嗦" }
//   ```
// 服务端把这块从正文里剥掉、落盘、下一轮生效。用户也能在设置页手改或撤回。
import fs from 'node:fs';
import path from 'node:path';

export const SELF_TUNE_VERSION = 1;
/** 单档追加提示的上限（字）。太长会把 system 撑满，反而伤效果。 */
export const TUNE_MAX_CHARS = 600;
/** 历史保留条数，够撤回就行，不做无限账本。 */
export const TUNE_MAX_HISTORY = 30;
export const TUNE_SCOPES = ['global', 'human', 'qq'];
/**
 * 告诉模型它能自调。只在 selfTune 打开时注入。
 * 写作要求：默认不写；真觉得「以后都该这样」时才在回答末尾单独加一个块，正文里不提这件事。
 */
export const TUNE_INSTRUCTION = [
  '【你可以调整自己】',
  '如果你发现这轮的做法以后都该沿用（比如回答太干、太爱铺排、该更直接），可以在回答的最后单独加一个块，只加一次：',
  '```tune',
  '{"temperature":0.8,"addendum":"以后回答先给结论，不写铺垫","scope":"human","why":"这轮被要求更直接"}',
  '```',
  'scope 取 human（网页里说话）/ qq（QQ 上说话）/ global（都算）。temperature 范围 0–2，只想改口径就不写它。',
  '平时别加这个块；回答里也不要提你在调自己，用户会在设置页看到记录，也能一键撤回。',
].join('\n');

const clampTemp = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(2, Math.max(0, n)) * 100) / 100;
};

const cleanText = (s) => String(s == null ? '' : s).replace(/\r\n/g, '\n').trim();

function emptyState() {
  return { version: SELF_TUNE_VERSION, temp: null, addendum: { global: '', human: '', qq: '' }, history: [], updatedAt: 0 };
}

function normalizeState(raw) {
  const st = emptyState();
  if (!raw || typeof raw !== 'object') return st;
  st.temp = clampTemp(raw.temp);
  for (const k of TUNE_SCOPES) st.addendum[k] = cleanText(raw.addendum && raw.addendum[k]).slice(0, TUNE_MAX_CHARS);
  st.updatedAt = Number(raw.updatedAt) || 0;
  if (Array.isArray(raw.history)) {
    st.history = raw.history.slice(-TUNE_MAX_HISTORY).map((h) => ({
      id: String(h && h.id ? h.id : ''),
      at: Number(h && h.at) || 0,
      by: String((h && h.by) || 'user'),
      why: cleanText(h && h.why).slice(0, 200),
      before: {
        temp: clampTemp(h && h.before && h.before.temp),
        addendum: {
          global: cleanText(h && h.before && h.before.addendum && h.before.addendum.global),
          human: cleanText(h && h.before && h.before.addendum && h.before.addendum.human),
          qq: cleanText(h && h.before && h.before.addendum && h.before.addendum.qq),
        },
      },
    }));
  }
  return st;
}

/**
 * 从模型回答里抠出调整块。三种写法都认：
 *   ```tune {json} ```
 *   ```json 里带 "selfTune": true ```
 *   [[tune]] {json}
 * 认不出来就返回 null —— 宁可不动，也不猜。
 */
export function parseTuneBlock(text) {
  const src = String(text || '');
  const fence = src.match(/```(?:tune|self-?tune)\s*\n([\s\S]*?)```/i);
  const inline = src.match(/\[\[\s*tune\s*\]\]\s*(\{[\s\S]*?\})\s*(?:\n|$)/i);
  const raw = fence ? fence[1] : inline ? inline[1] : '';
  if (!raw.trim()) return null;
  let obj = null;
  try {
    obj = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const patch = {};
  if (obj.temperature != null) {
    const t = clampTemp(obj.temperature);
    if (t == null) return null;
    patch.temp = t;
  }
  const add = cleanText(obj.addendum || obj.prompt || obj.append);
  if (add) patch.addendum = add.slice(0, TUNE_MAX_CHARS);
  const scope = String(obj.scope || 'global').toLowerCase();
  if (TUNE_SCOPES.includes(scope)) patch.scope = scope;
  const why = cleanText(obj.why || obj.reason).slice(0, 200);
  if (why) patch.why = why;
  if (patch.temp === undefined && !patch.addendum) return null;
  return patch;
}

/** 把调整块从正文里去掉（存库和显示都用剥过的版本）。 */
export function stripTuneBlock(text) {
  return String(text || '')
    .replace(/```(?:tune|self-?tune)\s*\n[\s\S]*?```\s*/gi, '')
    .replace(/\[\[\s*tune\s*\]\]\s*\{[\s\S]*?\}\s*/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function createSelfTune({ dataDir, now = () => Date.now() } = {}) {
  const file = path.join(String(dataDir || '.'), 'self-tune.json');
  let state = null;

  function load() {
    if (state) return state;
    try {
      state = normalizeState(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      state = emptyState();
    }
    return state;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state, null, 2));
    } catch {
      /* 落盘失败不该影响这一轮对话 */
    }
  }

  function snapshot() {
    return {
      temp: state.temp,
      addendum: { ...state.addendum },
    };
  }

  /**
   * 应用一次调整。append=false 时替换那一档，默认追加（模型说「再加一条」比「重写」常见）。
   * 返回 {ok, state, applied}，applied 为空对象表示没有任何改动。
   */
  function apply(patch = {}, { by = 'user', why = '' } = {}) {
    load();
    const applied = {};
    const before = snapshot();
    // temp: 数字 = 设定；null = 取消覆盖（回到设置里那个温度）
    if (patch.temp === null) {
      if (state.temp !== null) {
        state.temp = null;
        applied.temp = null;
      }
    } else if (patch.temp !== undefined) {
      const t = clampTemp(patch.temp);
      if (t != null) {
        state.temp = t;
        applied.temp = t;
      }
    }
    if (patch.addendum && typeof patch.addendum === 'object') {
      // 设置页那种「三档一起写」：给了哪档就整档替换（空串 = 清掉这档）
      const next = {};
      for (const k of TUNE_SCOPES) {
        if (patch.addendum[k] === undefined) continue;
        const v = cleanText(patch.addendum[k]).slice(0, TUNE_MAX_CHARS);
        if (v === state.addendum[k]) continue;
        state.addendum[k] = v;
        next[k] = v;
      }
      if (Object.keys(next).length) applied.addendum = next;
    } else {
      const add = cleanText(patch.addendum);
      if (add) {
        const scope = TUNE_SCOPES.includes(String(patch.scope)) ? String(patch.scope) : 'global';
        const prev = state.addendum[scope] || '';
        const next = (patch.replace ? add : prev ? `${prev}\n${add}` : add).slice(-TUNE_MAX_CHARS);
        state.addendum[scope] = next;
        applied.addendum = { scope, text: add.slice(0, TUNE_MAX_CHARS) };
      }
    }
    if (!Object.keys(applied).length) return { ok: false, error: '没有任何可应用的改动', state: snapshot() };
    state.updatedAt = now();
    state.history.push({
      id: `t${state.updatedAt.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      at: state.updatedAt,
      by: String(by || 'user').slice(0, 20),
      why: cleanText(why || patch.why).slice(0, 200),
      before,
    });
    if (state.history.length > TUNE_MAX_HISTORY) state.history = state.history.slice(-TUNE_MAX_HISTORY);
    save();
    return { ok: true, applied, state: snapshot() };
  }

  /** 撤回：给 id 就回到那次改动之前；不给就回退最近一次。 */
  function revert(idOrIndex) {
    load();
    if (!state.history.length) return { ok: false, error: '没有可撤回的调整' };
    let idx = -1;
    if (typeof idOrIndex === 'string' && idOrIndex) idx = state.history.findIndex((h) => h.id === idOrIndex);
    else if (Number.isInteger(idOrIndex)) idx = idOrIndex >= 0 && idOrIndex < state.history.length ? idOrIndex : -1;
    else idx = state.history.length - 1;
    if (idx < 0) return { ok: false, error: '找不到这条调整' };
    const back = state.history[idx].before;
    state.temp = back.temp;
    state.addendum = { ...back.addendum };
    state.history = state.history.slice(0, idx);
    state.updatedAt = now();
    save();
    return { ok: true, state: snapshot() };
  }

  function reset() {
    load();
    state = emptyState();
    save();
    return { ok: true, state: snapshot() };
  }

  /** 这一档口径该追加的提示（模型自己写的那几句）。 */
  function promptFor(style) {
    load();
    const parts = [state.addendum.global, style === 'qq' ? state.addendum.qq : state.addendum.human]
      .map(cleanText)
      .filter(Boolean);
    if (!parts.length) return '';
    return ['【自我调整：这些是你自己之前决定要改的（不是用户这轮说的），继续照它说】', ...parts.map((p) => p)].join('\n');
  }

  /** 温度：模型调过就用模型的，没调过跟设置走。 */
  function temperature(base) {
    load();
    const b = clampTemp(base);
    if (state.temp == null) return b == null ? 1 : b;
    return state.temp;
  }

  function summary() {
    load();
    return {
      file,
      temp: state.temp,
      addendum: { ...state.addendum },
      updatedAt: state.updatedAt,
      history: state.history.map((h) => ({ id: h.id, at: h.at, by: h.by, why: h.why })),
      active: state.temp != null || Object.values(state.addendum).some(Boolean),
    };
  }

  return { file, load, apply, revert, reset, promptFor, temperature, summary };
}

export default { createSelfTune, parseTuneBlock, stripTuneBlock, TUNE_MAX_CHARS, TUNE_SCOPES, TUNE_INSTRUCTION };
