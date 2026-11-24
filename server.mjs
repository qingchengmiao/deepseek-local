#!/usr/bin/env node
/**
 * DeepSeek API 客户端 —— 本地服务端（零依赖）
 *
 * 对齐 DeepSeek 官方 App（全家桶应用 API，2026-11-13）：
 *   联网搜索 / 深度思考搜索 / 阅读链接 / 图片理解 / 文档解析(Files API)
 *   内容安全 / 自动标题 / 用户元信息 / 语音识别(ASR) / 语音合成(TTS)
 *
 * - 静态资源：public/
 * - 会话存储：data/conversations/*.json（一个会话一个文件）
 * - 附件缓存：data/uploads/
 * - 设置：data/settings.json（API Key 只留在本机，接口只回掩码）
 * - 对话：POST /api/chat，SSE 转发 api.deepseek.com 的流式响应
 *
 * 只监听 127.0.0.1，不对外暴露。
 */
import http from 'node:http';
import fs, { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  CTX_DEFAULTS,
  MEMORY_SYSTEM,
  memoryUserPrompt,
  estimateTokens,
  estimateMessagesTokens,
  estimateMessageTokens,
  chunkMessages,
  buildIndex,
  getCachedIndex,
  dropCachedIndex,
  retrieve,
  decayWeight,
  messageAgeDays,
  trimByAge,
  cosineDense,
  keywordsOf,
  keywordsFromMessages,
  parseActivateRequest,
  CONSOLIDATE_SYSTEM,
  consolidateUserPrompt,
} from './context.mjs';
import { organizeArchive, previewArchive, KIND_LABEL, readZip } from './archive.mjs';
import { readUrl as readLinkUrl, extractUrls, hasBrowser } from './fetchlink.mjs';
import {
  dateStr as calDateStr,
  timeStr as calTimeStr,
  parseDate as calParseDate,
  monthGrid,
  eventsOn,
  upcoming,
  restOfDay,
  sortEvents,
  makeEvent,
  patchEvent,
  scheduleText,
} from './calendar.mjs';
import { qqConfig, onebot, loginInfo, sendPrivate, sendGroup, friendHistory, groupHistory, pickNew, qqUserPrompt } from './qq.mjs';
import { createLearnService } from './learn-service.mjs';
import { isoWeek } from './qqgroup.mjs';

const execFileAsync = promisify(execFile);

// 打包成桌面应用时，代码在 asar/只读目录里，数据要放到可写的地方：
// 用 DSAPP_DATA 指过去（不设就跟代码放一起，也就是开发时的行为）。
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.DSAPP_DATA ? path.resolve(process.env.DSAPP_DATA) : path.join(ROOT, 'data');
const CONV_DIR = path.join(DATA, 'conversations');
const UPLOAD_DIR = path.join(DATA, 'uploads');
const INDEX_FILE = path.join(CONV_DIR, 'index.json');
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const RUNTIME_FILE = path.join(DATA, 'server.json');
const CALENDAR_FILE = path.join(DATA, 'calendar.json');

const BASE_PORT = Number(process.env.PORT || 8787);
const HOST = '127.0.0.1';

// 官方 App 现役模型（GET /models 可查）
const MODELS = [
  {
    id: 'deepseek-flash',
    label: 'DeepSeek V4.1 Flash',
    note: '图片 · 联网 · 深度思考',
    vision: true,
    tools: true,
    contextWindow: 1048576,
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    note: '纯文本，更强推理',
    vision: false,
    tools: true,
    contextWindow: 1048576,
  },
];

const LANGUAGES = ['中文', 'English', '中文繁體', '日本語', '한국어', 'Русский', 'Deutsch', 'Français', 'Español', 'Português'];

// ---------------------------------------------------------------- 自动路由
// 对话 → V4 Pro（更像人在聊，不乱推理）；逻辑思考 → V4.1 Flash（会想、会算、能调工具）；
// 综合 → Flash 先出大纲，Pro 按大纲润色填充。附件只能走 Flash（Pro 是纯文本）。
const ROUTE_LABELS = { chat: '对话', think: '逻辑思考', hybrid: '混合', media: '音视频', vision: '看附件' };

const THINK_HINTS = /(代码|函数|报错|bug|debug|算法|复杂度|推导|证明|计算|算一下|求解|数学|概率|统计|回归|逻辑|漏洞|为什么|原因|原理|架构|设计模式|重构|优化|性能|实现|正则|SQL|接口|排查|分析一下|对比一下|评估|公式)/i;
const HYBRID_HINTS = /(写一份|写个|起草|草拟|方案|计划|报告|总结|大纲|提纲|润色|改写|扩写|续写|长文|文案|脚本|剧本|小说|故事|邮件|演讲稿|推文|公众号|策划|落地|文档)/i;

function routeFor({ text, thinking = false, attachments = [], mode = 'send' }) {
  const t = String(text || '');
  const hasFiles = (attachments || []).some(a => a && (a.kind || a.uploadId || a.mediaId));
  if (mode === 'continue') return { kind: 'chat', model: 'deepseek-v4-pro', thinking: false, reason: '续写走对话模型，保持语气连贯' };
  if (hasFiles) return { kind: 'vision', model: 'deepseek-flash', thinking: !!thinking, reason: '带了附件，只有 V4.1 Flash 能看图片/文档/音视频' };
  if (thinking) return { kind: 'think', model: 'deepseek-flash', thinking: true, reason: '你手动打开了深度思考' };
  if (HYBRID_HINTS.test(t) && t.length >= 12) return { kind: 'hybrid', model: 'deepseek-v4-pro', thinking: false, reason: '要成篇的东西：先让 Flash 出大纲，Pro 再润色填充' };
  if (THINK_HINTS.test(t)) return { kind: 'think', model: 'deepseek-flash', thinking: true, reason: '像要推理/排错/计算的活，交给会想的模型' };
  return { kind: 'chat', model: 'deepseek-v4-pro', thinking: false, reason: '普通对话，交给更会聊的模型' };
}

const OUTLINE_SYSTEM = [
  '你在给下一轮写作打底：只为这条请求写一份写作大纲，供另一个模型照着写成最终回答。',
  '要求：',
  '1. 用编号列结构（3–8 条），每条一句话说清这一段要讲什么、给什么结论；',
  '2. 只写大纲，不要写成段落，不要寒暄，不要重复用户的提问；',
  '3. 如果请求里需要引用前文的事实、数字、决定，在大纲对应条目里点名要用哪个；',
  '4. 中文输出，不超过 400 字。',
].join('\n');

// 每一档路由对应哪个模型，都可以在设置里改
const ROUTE_SETTING = {
  chat: 'routeChatModel',
  think: 'routeThinkModel',
  vision: 'routeThinkModel',
  media: 'routeHybridModel',
  hybrid: 'routeHybridModel',
};

/** 音视频附件（走两段式）；图片/文档仍按「看附件」单遍 */
function isMediaAttachment(a) {
  return !!a && (a.kind === 'video' || a.kind === 'audio');
}

function resolveRoute(settings, input) {
  const r = routeFor(input);
  const key = ROUTE_SETTING[r.kind] || 'routeChatModel';
  const want = normalizeModel(settings[key] || r.model);
  // 音视频：Flash 先扒要点（转写 + 画面），Pro 再写正文
  const hasMedia = (input.attachments || []).some(isMediaAttachment);
  if (r.kind === 'vision' && hasMedia && settings.mediaTwoStage !== false) {
    const pro = normalizeModel(settings.routeHybridModel || 'deepseek-v4-pro');
    return {
      kind: 'media',
      model: pro === 'auto' ? 'deepseek-v4-pro' : pro,
      thinking: false,
      draftModel: normalizeModel(settings.routeHybridDraftModel || 'deepseek-flash'),
      reason: '音视频两段式：V4.1 Flash 先扒要点（转写 + 画面），V4 Pro 按要点写正文',
    };
  }
  return {
    ...r,
    model: want === 'auto' ? r.model : want,
    draftModel: normalizeModel(settings.routeHybridDraftModel || 'deepseek-flash'),
  };
}

/** 综合模式的第一遍：让 Flash 出一份大纲（非流式，不要思考） */
async function draftOutline(settings, apiKey, ctx, model) {
  const messages = [
    { role: 'system', content: OUTLINE_SYSTEM },
    ...ctx.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role, content: m.content })),
  ];
  const { chat } = apiEndpoints(settings.baseUrl);
  const t0 = Date.now();
  const r = await fetch(chat, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model === 'auto' ? 'deepseek-flash' : model,
      messages,
      stream: false,
      thinking: { type: 'disabled' },
      max_tokens: 800,
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const text = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('模型返回了空大纲');
  return { text, ms: Date.now() - t0 };
}

// 音视频两段式的第一遍提示词：只要「能拿来写的材料」，不要成文
const MEDIA_DIGEST_SYSTEM = [
  '你在给下一轮写回答打底：面前是一段音视频的转写文字，可能还有若干抽帧画面。',
  '请把它整理成一份「要点清单」，供另一个模型据此写出最终回答。',
  '要求：',
  '1. 先用一两句说这段音视频整体是什么（内容类型、大概讲了什么）；',
  '2. 再按时间顺序列关键点，能标时间就标（如 00:12），每条一句话：说了什么 / 画面里出现什么；',
  '3. 单独列出可核对的硬信息：数字、名称、地点、结论、待办；没有就写「无」；',
  '4. 画面里读不清的文字不要猜，写「画面文字看不清」；',
  '5. 只写清单，不要成段叙述，不要寒暄；中文，不超过 500 字。',
].join('\n');

/** 音视频两段式的第一遍：Flash 看转写 + 抽帧，先扒出一份要点（非流式，不要思考） */
async function draftMediaDigest(settings, apiKey, ctx, model) {
  const messageParts = [];
  for (let i = ctx.length - 1; i >= 0; i--) {
    const m = ctx[i];
    if (m.role !== 'user') continue;
    messageParts.push(m);
    break;
  }
  const last = messageParts[0];
  const messages = [{ role: 'system', content: MEDIA_DIGEST_SYSTEM }];
  const lastIdx = ctx.lastIndexOf(last);
  for (let i = 0; i < lastIdx; i++) {
    const m = ctx[i];
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = typeof m.content === 'string' ? m.content : '';
    if (text.trim()) messages.push({ role: m.role, content: text.slice(0, 4000) });
  }
  if (last) messages.push({ role: 'user', content: last.content });
  const { chat } = apiEndpoints(settings.baseUrl);
  const t0 = Date.now();
  const r = await fetch(chat, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model === 'auto' ? 'deepseek-flash' : model,
      messages,
      stream: false,
      thinking: { type: 'disabled' },
      max_tokens: 900,
      temperature: 0.4,
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const text = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('模型返回了空要点');
  return { text, ms: Date.now() - t0 };
}


// 「活人感」风格提示词：治 AI 腔。故意写得短——禁则列一长串，模型会把回答也捆成清单。
const HUMAN_STYLE_PROMPT = `你不是在写报告，是在跟人说话。第一句就给答案或判断，别重述问题、别铺垫。
每句话尽量带具体的东西：数字、时间、名字、哪个文件、哪一步。说不准就说"这块我不确定，得查"，别硬凑。
句子可以短，可以说一半，可以说错了当场改口。
允许有偏向和情绪，可以说"我觉得""我倾向这个"。
别用三段排比，别在每段末尾再总结一句刚说过的话，别用"值得注意的是""综上所述""由此可见"串场。
短回答不用硬编号，也别给每个名词加粗。但用户明确要清单、步骤、表格、代码时照给，别为了口气把东西讲糊。
语气词该用就用：啊、吧、呢、呗、嘛、咯，放句尾，别堆。可以自嘲、可以说"我也菜"。
一个梗最多一个，而且别解释梗；对不熟的人别用"典""孝""急了"这种带刺的。
别一句话塞一串逗号——真人宁可断成两句；句子过半要短（十个字以内），转折放在前半段，别先摆结论再硬拐。
短了就别写句号；一个暗喻就够，别在三十个字里塞两个比喻。`;

// QQ 上的说话方式：按 cn-net-voice + human-voice 那套实测参数来（18.3 万话轮量出来的）
// 能省就省：手机上打字，一条能说完就别拖两条；数字是硬指标，别写成口号
const QQ_VOICE_PROMPT = `【在 QQ 上跟熟人说话】手机打字，一条能说完就别拖两条。
小句 4–12 字，短句（8 字以内）占一半；主语能省就省，中文真话里八成句子不带「我/你」。
每两三句得有一个能核对的东西：几点了、多少钱、哪张图、哪个文件，别拿「很明显」「提升很大」糊过去。
转折放在前中段：先认一半，再说但书，别一条道走到黑才翻。
情绪别拉满：感叹号一条最多一个，笑声词一个，emoji 不超过两个且放句尾。
不写「值得注意的是」「综上所述」「希望对你有帮助」这类串场词，也不打清单、不加小标题。
收尾要么直接停，要么把话头抛回去，别总结自己刚说过的话。
语气词少量放句尾：啊/吧/呢/呗/嘛，一条最多一两个；不用「典」「孝」「急了」这种带刺的。
不知道就说不知道，说错了当场改口，别硬凑。`;

// 反向提示：把「鱼八股」（AI 模板腔）列出来禁掉，比只说「别像 AI」有用
const ANTI_BA_GOO_PROMPT = `【下面这些是模板腔，一条都别写】
不是……而是…… / 不仅……更是…… 这类对仗；一段里顶多一次。
首先/其次/最后、第一/第二/第三 给日常聊天排秩序。
值得注意的是 / 综上所述 / 总的来说 / 换句话说 / 与此同时 这类过渡词。
「在这个……的时代」「随着……的发展」起手。
「让我们一起」「希望对你有所帮助」「如果你需要，我可以……」收尾。
赋能 / 闭环 / 抓手 / 颗粒度 / 对齐认知 这套 PPT 词。
每段末尾复述一遍刚说过的话；给每个名词加粗；三连排比。
客服腔：「我理解你的感受」「很抱歉给你带来不便」「感谢你的耐心」。
自己刚用的梗还要解释一句。
要表达同样的意思，就换成一句具体的、能核对的话。`;

// ---- 技能包：skills/<id>/SKILL.md，YAML front matter 给 name/description，正文就是注入内容
// 技能目录：默认放在数据目录下（data/skills），这样覆盖 dist 里的代码不会把自装的技能换掉。
// DSAPP_SKILLS 仍然可以指到别处（测试用）。
const SKILLS_DIR = process.env.DSAPP_SKILLS
  ? path.resolve(process.env.DSAPP_SKILLS)
  : path.join(DATA, 'skills');
// 代码里自带的技能（开发态是 skills/，装好后是 resources\app\skills）：只用来首次播种
const BUNDLED_SKILLS_DIR = path.join(ROOT, 'skills');
const SKILL_MAX_CHARS = 6000; // 单个技能注入上限，防止把上下文挤爆

function parseSkillMeta(text) {
  const out = { name: '', description: '', body: text };
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^\s*(name|description)\s*:\s*(.*)$/.exec(line);
      if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
    out.body = text.slice(m[0].length);
  }
  if (!out.name) {
    const h = /^#\s+(.+)$/m.exec(out.body);
    if (h) out.name = h[1].trim();
  }
  if (!out.description) {
    const p = out.body.split(/\r?\n/).map(s => s.trim()).find(s => s && !s.startsWith('#'));
    if (p) out.description = p.slice(0, 160);
  }
  return out;
}

function listSkills() {
  let dirs = [];
  try {
    dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } catch {
    return [];
  }
  const out = [];
  for (const id of dirs.sort()) {
    const file = path.join(SKILLS_DIR, id, 'SKILL.md');
    if (!existsSync(file)) continue;
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const meta = parseSkillMeta(text);
    let files = 1;
    try {
      files = fs.readdirSync(path.join(SKILLS_DIR, id), { recursive: true })
        .filter(n => fs.statSync(path.join(SKILLS_DIR, id, n)).isFile()).length;
    } catch {}
    out.push({
      id,
      name: meta.name || id,
      description: meta.description || '',
      chars: meta.body.trim().length,
      files,
      file,
    });
  }
  return out;
}

/**
 * 第一次跑的时候把随包技能播到 SKILLS_DIR。
 * 已存在的目录一律不动 —— 这样覆盖 dist 里的代码、升级版本，都不会把你自装的/改过的技能换掉。
 * 返回 { fresh, seeded }：fresh = 之前连 settings.json 都没有（全新装置），seeded = 这次播进去的 id。
 */
function seedSkillsFromBundle() {
  const out = { fresh: !existsSync(SETTINGS_FILE), seeded: [] };
  try {
    // 显式指了 DSAPP_SKILLS 就完全听它的（测试/多开实例：别往里播东西）
    if (process.env.DSAPP_SKILLS) return out;
    if (!existsSync(BUNDLED_SKILLS_DIR)) return out;
    if (path.resolve(BUNDLED_SKILLS_DIR) === path.resolve(SKILLS_DIR)) return out;
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    for (const d of fs.readdirSync(BUNDLED_SKILLS_DIR, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const src = path.join(BUNDLED_SKILLS_DIR, d.name);
      const dst = path.join(SKILLS_DIR, d.name);
      if (existsSync(dst)) continue;
      if (!existsSync(path.join(src, 'SKILL.md'))) continue;
      fs.cpSync(src, dst, { recursive: true });
      out.seeded.push(d.name);
      log(`技能播种：${d.name} → ${dst}`);
    }
  } catch (e) {
    log('技能播种失败（不影响启动）：', e.message);
  }
  return out;
}

// 只读已启用的技能，按 settings.enabledSkills 的顺序拼成一段
function skillsPrompt(settings) {
  const ids = Array.isArray(settings && settings.enabledSkills) ? settings.enabledSkills : [];
  if (!ids.length) return '';
  const known = new Map(listSkills().map(s => [s.id, s]));
  const parts = [];
  for (const id of ids) {
    const meta = known.get(id);
    if (!meta) continue;
    let body = '';
    try {
      body = parseSkillMeta(fs.readFileSync(meta.file, 'utf8')).body.trim();
    } catch {
      continue;
    }
    if (!body) continue;
    if (body.length > SKILL_MAX_CHARS) body = body.slice(0, SKILL_MAX_CHARS) + '\n…（技能过长已截断）';
    parts.push(`【技能：${meta.name}】\n${body}`);
  }
  return parts.length ? `以下是用户启用的技能，说话/写作时按它来（没触发就别硬套）：\n\n${parts.join('\n\n')}` : '';
}

// ---- 技能包安装：拖进来的 .md / .zip / 文件夹（多文件）都落到 skills/<id>/
const SKILL_FILE_LIMIT = 2 * 1024 * 1024;      // 单个文件
const SKILL_TOTAL_LIMIT = 24 * 1024 * 1024;    // 一个技能包总量
const SKILL_ALLOW_EXT = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonl', '.csv', '.yaml', '.yml',
  '.js', '.mjs', '.cjs', '.py', '.sh', '.ps1',
]);

function skillSlug(raw) {
  const s = String(raw || '').trim();
  // 中文目录名也能用（只在 URL query 里出现过，客户端会 encodeURIComponent）
  const ascii = s.replace(/\s+/g, '-').replace(/[^\p{Script=Han}a-zA-Z0-9_-]+/gu, '-').replace(/^-+|-+$/g, '');
  if (ascii.length >= 2) return ascii.slice(0, 48);
  return 'skill-' + crypto.createHash('sha1').update(s || String(Date.now())).digest('hex').slice(0, 8);
}

function skillDirOf(id) {
  const root = path.resolve(SKILLS_DIR);
  const dir = path.resolve(root, String(id || ''));
  if (!dir.startsWith(root + path.sep)) throw new Error('技能目录不合法');
  return dir;
}

/** 把一组文件写进 skills/<id>/：rel 用 / 分隔，SKILL.md 必须在里面 */
function installSkillFiles(files, { id, name } = {}) {
  let total = 0;
  const clean = [];
  for (const f of files) {
    const rel = String(f.rel || f.filename || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) continue;
    if (!SKILL_ALLOW_EXT.has(path.extname(rel).toLowerCase())) continue;
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data ?? ''), 'utf8');
    if (!data.length || data.length > SKILL_FILE_LIMIT) continue;
    total += data.length;
    if (total > SKILL_TOTAL_LIMIT) throw new Error('技能包太大（上限 24 MB）');
    clean.push({ rel, data });
  }
  if (!clean.length) throw new Error('没找到可用的文本文件（支持 .md/.txt/.json/.js/.py/.sh 等）');

  // 找 SKILL.md（大小写不敏感，取层级最浅的那个）
  const mains = clean.filter(f => path.basename(f.rel).toLowerCase() === 'skill.md');
  if (!mains.length) throw new Error('这个包里没有 SKILL.md——技能包的根目录里要有一个 SKILL.md');
  mains.sort((a, b) => a.rel.split('/').length - b.rel.split('/').length);
  const main = mains[0];
  const prefix = main.rel.includes('/') ? main.rel.slice(0, main.rel.lastIndexOf('/') + 1) : '';

  // id：显式给的 > SKILL.md 上层目录名 > front matter 的 name > 文件名
  const text = main.data.toString('utf8');
  const meta = parseSkillMeta(text);
  const baseGuess = id || (prefix ? prefix.replace(/\/$/, '').split('/').pop() : '') || meta.name || name || '';
  let finalId = skillSlug(baseGuess);
  const used = new Set(listSkills().map(s => s.id));
  if (used.has(finalId)) {
    let n = 2;
    while (used.has(`${finalId}-${n}`)) n += 1;
    finalId = `${finalId}-${n}`;
  }

  const dir = skillDirOf(finalId);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of clean) {
    const rel = prefix && f.rel.startsWith(prefix) ? f.rel.slice(prefix.length) : f.rel;
    if (!rel || rel.split('/').includes('..')) continue;
    const dest = path.resolve(dir, rel);
    if (!dest.startsWith(dir + path.sep)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.data);
  }
  const written = fs.readdirSync(dir, { recursive: true }).filter(x => fs.statSync(path.join(dir, x)).isFile());
  const saved = listSkills().find(s => s.id === finalId);
  return { id: finalId, dir, files: written.length, skill: saved || null };
}

/** 一个上传体 → 技能文件：zip 就拆，纯文本就当 SKILL.md */
function skillFilesFromUpload(buf, filename) {
  const filename0 = String(filename || 'SKILL.md');
  if (buf.length > SKILL_TOTAL_LIMIT) throw new Error('文件太大（上限 24 MB）');
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b) {
    const zip = readZip(buf);
    const names = zip.names().filter(n => !n.split('/').includes('__MACOSX'));
    return { files: names.map(n => ({ rel: n, data: zip.read(n) })), name: filename0 };
  }
  const ext = path.extname(filename0).toLowerCase();
  if (!ext || ext === '.md' || ext === '.markdown' || ext === '.txt') {
    // 单文件：本身就成为 SKILL.md，文件名（去掉扩展名）用来定 id
    return { files: [{ rel: 'SKILL.md', data: buf }], name: path.basename(filename0, ext) };
  }
  throw new Error(`不认识的文件类型：${ext}（拖 .md 或 .zip，或者整个文件夹）`);
}



const DEFAULT_SETTINGS = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  thinking: true,
  reasoningEffort: 'high', // low | high | max
  webSearch: false,
  readLink: true,
  // API 的读链接工具读不到时，允许本机补：先 HTTP 抓 HTML，再不行用内嵌 Chromium 渲染
  readLinkLocal: true,
  readLinkMode: 'auto', // auto = 本机预读 + API 工具都可用；api = 只信 API 工具；local = 只本机抓
  safetyLevel: 'off', // off | low | high
  autoTitle: true,
  temperature: 1.0,
  systemPrompt: '',
  replyStyle: 'human', // native=原生（不注入）| human=活人感 | custom=只用自己的 systemPrompt
  antiBaGu: true, // 反向提示：把 AI 模板腔（对仗句/首先其次/综上所述/赋能闭环）列出来禁掉
  enabledSkills: [], // 用户手动启用的技能 id（skills/<id>/SKILL.md）
  maxHistoryMessages: 0, // 0 = 不截断
  theme: 'auto',
  language: '中文',
  location: '',
  platform: 'Web',
  ttsVoice: 'stella',
  autoImport: true,
  // 自动路由：对话走 V4 Pro、逻辑思考走 V4.1 Flash、综合（Flash 出大纲 + Pro 润色）走两次
  autoRoute: true,
  routeChatModel: 'deepseek-v4-pro',
  routeThinkModel: 'deepseek-flash',
  routeHybridDraftModel: 'deepseek-flash',
  routeHybridModel: 'deepseek-v4-pro',
  // 混合模式开关（输入框里那个二分树图标）：打开就强制 Flash 起草 + Pro 写正文
  hybridMode: false,
  // 音视频两段式：带视频/音频附件时，Flash 先扒要点（转写+画面），Pro 写正文
  mediaTwoStage: true,
  // 自适应：按这一轮的对话（内容类型 + 对话长度 + 附件）临时调 system 提示词和温度
  adaptiveTurn: true,
  mediaFrames: 6, // 视频抽几帧（0 = 不抽，只转写）
  mediaChunkSec: 110, // ASR 单次最长 120 秒，留点余量
  ffmpegPath: '', // 留空自动找（PATH / D:\ffmpeg-9.0-full_build\bin）
  // ---- 上下文管理（自动压缩 / 向量检索 / 时间衰减）
  ...CTX_DEFAULTS,
  // ---- 日历：要不要把当天/接下来的日程塞进上下文
  calendarInContext: true,
  calendarDays: 3, // 往后看几天
  // ---- QQ 通道（OneBot 11 HTTP，和 dsh-qq-bridge 用同一个后端）
  qqMode: 'off', // off | send（只发） | both（收 + 回）
  qqBaseUrl: 'http://127.0.0.1:3000',
  qqToken: '',
  qqUid: '', // 私聊 QQ 号
  qqGroup: '', // 群号（填了就往群里发）
  qqPollMs: 5000,
  qqConvId: '', // 收进来的消息接到哪个会话；空 = 自动建一个「QQ」
  qqCallName: '对方',
  qqStyle: true, // QQ 回话按真人语料那套口径说（关掉就只剩通用的活人感提示）
  qqNapCatDir: 'D:\\NapCatOneKey', // NapCat 装在哪：扫码登录、找二维码都从这里翻
  // 隔离实例（C++ 宿主）：自己的 Shell 副本 + 自己的 QQ 号 + 自己的端口，跟 DSH 的 echo 实例互不相干
  napcatShell: 'D:\\NapCatDSL\\Shell',
  napcatLogin: '', // QQ 的 --user-data-dir；空 = 宿主默认用 <exeDir>\\login
  napcatHost: '', // 宿主 exe；空 = 自动找 <应用目录>\\napcat\\DSLNapCatHost.exe
  napcatStatusPath: '', // 宿主状态文件；空 = 宿主默认（<exeDir>\\state\\host-status.json），沙盒演练时指到别处
  napcatHttpPort: 3200,
  napcatWsPort: 3201,
  napcatWebuiPort: 6209,
  napcatAutoHeal: true, // 90 秒一轮自检：缺 OneBot 配置就补、登录态坏了就重置并提示重扫
  // ---- 推送：允许应用主动往 QQ 推消息（一道权限门，关掉后推送接口一律 403）
  pushEnabled: true,
  pushUid: '', // 推给谁；空 = 回落到 qqUid
  // ---- 群聊自学习：按语境/人物/时间学一团人怎么说话（数据只留在本机 data/qq-learn）
  learnAuto: true, // 后台每 10 分钟抽一批群消息
  learnInject: false, // 打开后，绑了群号的会话会带上这个群的说话画像
  learnGroups: [], // 要学的群号；空 = 已存过的全部
  learnGroupMeta: {}, // { gid: { name, members } }
  learnN: 6, // 情绪突变看的后续条数
  learnPages: 2, // 每轮翻几页历史
  learnLastSettledWeek: '', // 上次跨周结算的周
};

// ---------------------------------------------------------------- 小工具

/** 老版本里存过的模型名 → 现在的名字（deepseek-chat/reasoner 已下线） */
const LEGACY_MODELS = {
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
};

function normalizeModel(id) {
  const m = String(id || '').trim();
  if (m === 'auto') return 'auto'; // 自动路由：每次发消息前按内容挑模型
  if (LEGACY_MODELS[m]) return LEGACY_MODELS[m];
  return MODELS.some(x => x.id === m) ? m : 'deepseek-flash';
}

/** 模型 id → 给人看的名字（日志和提示里用） */
function modelLabel(id) {
  const m = MODELS.find(x => x.id === id);
  return m ? m.label : String(id || '');
}

const now = () => Date.now();

/** 数字夹取：坏值回落到默认值 */
function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

// ---------------------------------------------------------------- 每个会话的上下文参数
// conv.ctx 只存「这个会话自己改过的」键，其余跟随全局 settings。
const CTX_BUDGET_MAX = 1000000; // deepseek-flash 的窗口是 1M，允许顶到窗口
const CTX_OVERRIDE_NUMS = {
  ctxBudget: [4000, CTX_BUDGET_MAX, CTX_DEFAULTS.ctxBudget],
  ctxHotRatio: [0.2, 0.95, CTX_DEFAULTS.ctxHotRatio],
  ctxMinCompress: [200, 100000, CTX_DEFAULTS.ctxMinCompress],
  ctxTopK: [0, 20, CTX_DEFAULTS.ctxTopK],
  ctxHalfLifeDays: [0.5, 3650, CTX_DEFAULTS.ctxHalfLifeDays],
  ctxTrimChars: [60, 8000, CTX_DEFAULTS.ctxTrimChars],
  ctxRagMinScore: [0, 1, CTX_DEFAULTS.ctxRagMinScore],
  ctxStepRatio: [0.1, 0.9, CTX_DEFAULTS.ctxStepRatio],
  ctxForgetRatio: [0.2, 0.95, CTX_DEFAULTS.ctxForgetRatio],
  ctxActivateScore: [0, 1, CTX_DEFAULTS.ctxActivateScore],
};
const CTX_OVERRIDE_BOOLS = ['ctxCompress', 'ctxRag', 'ctxArchive', 'ctxProgressive'];

/** 把 conv.ctx 里认识、合法的键留下（null/'' 表示删掉这条覆盖，回到全局） */
function normalizeCtxOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined || v === '') continue;
    if (k in CTX_OVERRIDE_NUMS) {
      const [lo, hi, dflt] = CTX_OVERRIDE_NUMS[k];
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = Math.min(hi, Math.max(lo, k === 'ctxBudget' || k === 'ctxTopK' || k === 'ctxMinCompress' || k === 'ctxTrimChars' ? Math.floor(n) : n));
      else if (v === true) out[k] = dflt;
    } else if (CTX_OVERRIDE_BOOLS.includes(k)) {
      out[k] = v === true || v === 'true' || v === 1 || v === '1';
    } else if (k === 'ctxSummarizer') {
      if (['auto', 'local', 'api'].includes(v)) out[k] = v;
    }
  }
  return out;
}

function ctxOverridesOf(conv) {
  return normalizeCtxOverrides(conv && conv.ctx);
}

/** 生效参数 = 全局 settings 被 conv.ctx 覆盖 */
function ctxSettingsFor(conv, settings) {
  const ov = ctxOverridesOf(conv);
  return Object.keys(ov).length ? { ...settings, ...ov } : settings;
}

const uid = (prefix = 'm') => prefix + '_' + crypto.randomBytes(9).toString('base64url');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ensureDirs() {
  await fsp.mkdir(CONV_DIR, { recursive: true });
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  await fsp.mkdir(MEDIA_DIR, { recursive: true });
  await fsp.mkdir(path.join(DATA, 'archive'), { recursive: true });
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file, obj) {
  // 目录可能被用户手动删掉（比如「清理数据」），写之前先补回来，避免 ENOENT
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 0));
  await fsp.rename(tmp, file);
}

// 同一个会话的写操作串行化，避免并发写坏文件
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  next.finally(() => {
    if (locks.get(key) === next) locks.delete(key);
  });
  return next;
}

/** 把用户填的 baseUrl 归一成根地址（去掉 /v1、/beta 之类后缀） */
function apiBase(baseUrl) {
  return String(baseUrl || DEFAULT_SETTINGS.baseUrl)
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(v1|beta|chat|completions)$/i, '');
}

function apiEndpoints(baseUrl) {
  const root = apiBase(baseUrl);
  return {
    root,
    models: `${root}/models`,
    chat: `${root}/chat/completions`,
    betaChat: `${root}/beta/chat/completions`,
    files: `${root}/files`,
    asr: `${root}/v1/tools/asr`,
    tts: `${root}/v1/tools/tts`,
  };
}

function cleanText(s) {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_>#~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function autoTitle(content) {
  const t = cleanText(content).split('\n')[0] || '新对话';
  return t.length > 28 ? t.slice(0, 28) + '…' : t;
}

function maskKey(key) {
  if (!key) return '';
  const k = String(key).trim();
  if (k.length <= 10) return '****';
  return `${k.slice(0, 5)}…${k.slice(-4)}`;
}

const WEEKDAY_ZH = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const WEEKDAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** latest_reminder 的 content：<date>,<weekday>,<location>,<platform>,<language> */
function latestReminderContent(settings) {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const lang = String(settings.language || '中文');
  const zhWeeks = { 中文: WEEKDAY_ZH, 中文繁體: WEEKDAY_ZH };
  const weekday = (zhWeeks[lang] || WEEKDAY_EN)[d.getDay()];
  const location = String(settings.location || '').replace(/[\r\n]/g, ' ').trim();
  const platform = settings.platform === 'App' ? 'App' : 'Web';
  return [date, weekday, location, platform, lang].join(',');
}

// ---------------------------------------------------------------- 存储

async function loadSettings() {
  const s = await readJsonFile(SETTINGS_FILE, {});
  const merged = { ...DEFAULT_SETTINGS, ...s };
  merged.model = normalizeModel(merged.model);
  return merged;
}

async function saveSettings(patch) {
  const cur = await loadSettings();
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    if (k === 'apiKey') next.apiKey = String(v || '').trim();
    else if (k === 'baseUrl') next.baseUrl = String(v || '').trim() || DEFAULT_SETTINGS.baseUrl;
    else if (k === 'temperature') next.temperature = Math.min(2, Math.max(0, Number(v) || 0));
    else if (k === 'maxHistoryMessages') next.maxHistoryMessages = Math.max(0, Math.floor(Number(v) || 0));
    else if (k === 'mediaFrames') next.mediaFrames = Math.max(0, Math.min(12, Math.floor(Number(v) || 0)));
    else if (k === 'mediaChunkSec') next.mediaChunkSec = Math.max(20, Math.min(115, Math.floor(Number(v) || 110)));
    else if (k === 'reasoningEffort') next.reasoningEffort = ['low', 'high', 'max'].includes(v) ? v : 'high';
    else if (k === 'ctxBudget') next.ctxBudget = Math.max(4000, Math.min(CTX_BUDGET_MAX, Math.floor(Number(v) || CTX_DEFAULTS.ctxBudget)));
    else if (k === 'ctxHotRatio') next.ctxHotRatio = Math.max(0.2, Math.min(0.95, Number(v) || CTX_DEFAULTS.ctxHotRatio));
    else if (k === 'ctxMinCompress') next.ctxMinCompress = Math.max(200, Math.min(100000, Math.floor(Number(v) || CTX_DEFAULTS.ctxMinCompress)));
    else if (k === 'ctxTopK') next.ctxTopK = Math.max(0, Math.min(20, Math.floor(Number(v) || 0)));
    else if (k === 'ctxHalfLifeDays') next.ctxHalfLifeDays = Math.max(0.5, Math.min(3650, Number(v) || CTX_DEFAULTS.ctxHalfLifeDays));
    else if (k === 'ctxTrimChars') next.ctxTrimChars = Math.max(60, Math.min(8000, Math.floor(Number(v) || CTX_DEFAULTS.ctxTrimChars)));
    else if (k === 'ctxRagMinScore') next.ctxRagMinScore = Math.max(0, Math.min(1, Number(v) || 0));
    else if (k === 'ctxSummarizer') next.ctxSummarizer = ['auto', 'local', 'api'].includes(v) ? v : 'auto';
    else if (k === 'readLinkMode') next.readLinkMode = ['auto', 'api', 'local'].includes(v) ? v : 'auto';
    else if (k === 'ctxLocalUrl') next.ctxLocalUrl = String(v || '').trim() || CTX_DEFAULTS.ctxLocalUrl;
    else if (k === 'ctxLocalModel') next.ctxLocalModel = String(v || '').trim().slice(0, 120);
    else if (k === 'ctxEmbedModel') {
      const s = String(v || '').trim().slice(0, 120);
      next.ctxEmbedModel = s === '' ? 'off' : s;
    }
    else if (k === 'ctxStepRatio') next.ctxStepRatio = Math.max(0.1, Math.min(0.9, Number(v) || CTX_DEFAULTS.ctxStepRatio));
    else if (k === 'ctxForgetRatio') next.ctxForgetRatio = Math.max(0.2, Math.min(0.95, Number(v) || CTX_DEFAULTS.ctxForgetRatio));
    else if (k === 'ctxActivateScore') {
      const n = Number(v);
      next.ctxActivateScore = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : CTX_DEFAULTS.ctxActivateScore;
    }
    else if (k === 'routeChatModel' || k === 'routeThinkModel' || k === 'routeHybridDraftModel' || k === 'routeHybridModel') {
      const id = String(v || '').trim();
      next[k] = MODELS.some(m => m.id === id) ? id : DEFAULT_SETTINGS[k];
    }
    else if (k === 'qqMode') next.qqMode = ['off', 'send', 'both'].includes(v) ? v : 'off';
    else if (k === 'qqBaseUrl') next.qqBaseUrl = String(v || '').trim().slice(0, 200) || DEFAULT_SETTINGS.qqBaseUrl;
    else if (k === 'qqToken') next.qqToken = String(v || '').trim().slice(0, 200);
    else if (k === 'qqUid') next.qqUid = String(v || '').replace(/[^\d]/g, '').slice(0, 20);
    else if (k === 'qqGroup') next.qqGroup = String(v || '').replace(/[^\d]/g, '').slice(0, 20);
    else if (k === 'qqConvId') next.qqConvId = String(v || '').trim().slice(0, 60);
    else if (k === 'qqCallName') next.qqCallName = String(v || '').trim().slice(0, 20) || '对方';
    else if (k === 'qqStyle') next.qqStyle = v !== false;
    else if (k === 'qqPollMs') next.qqPollMs = Math.max(2000, Math.min(60000, Math.floor(Number(v) || 5000)));
    else if (k === 'qqNapCatDir') next.qqNapCatDir = String(v || '').trim().slice(0, 240) || DEFAULT_SETTINGS.qqNapCatDir;
    else if (k === 'napcatShell') next.napcatShell = String(v || '').trim().slice(0, 240) || DEFAULT_SETTINGS.napcatShell;
    else if (k === 'napcatLogin') next.napcatLogin = String(v || '').trim().slice(0, 240);
    else if (k === 'napcatHost') next.napcatHost = String(v || '').trim().slice(0, 240);
    else if (k === 'napcatStatusPath') next.napcatStatusPath = String(v || '').trim().slice(0, 240);
    else if (k === 'napcatHttpPort') next.napcatHttpPort = Math.max(1, Math.min(65535, Math.floor(Number(v) || 3200)));
    else if (k === 'napcatWsPort') next.napcatWsPort = Math.max(1, Math.min(65535, Math.floor(Number(v) || 3201)));
    else if (k === 'napcatWebuiPort') next.napcatWebuiPort = Math.max(1, Math.min(65535, Math.floor(Number(v) || 6209)));
    else if (k === 'pushUid') next.pushUid = String(v || '').replace(/[^\d]/g, '').slice(0, 20);
    else if (k === 'pushEnabled') next.pushEnabled = v !== false;
    else if (k === 'napcatAutoHeal') next.napcatAutoHeal = v !== false;
    else if (k === 'calendarDays') next.calendarDays = Math.max(1, Math.min(30, Math.floor(Number(v) || 3)));
    else if (k === 'safetyLevel') next.safetyLevel = ['off', 'low', 'high'].includes(v) ? v : 'off';
    else if (k === 'ttsVoice') next.ttsVoice = v === 'tide' ? 'tide' : 'stella';
    else if (k === 'language') next.language = LANGUAGES.includes(v) ? v : '中文';
    else if (k === 'replyStyle') next.replyStyle = ['native', 'human', 'custom'].includes(v) ? v : 'human';
    else if (k === 'antiBaGu') next.antiBaGu = v !== false;
    else if (k === 'enabledSkills') {
      const ids = new Set(listSkills().map(s => s.id));
      const arr = Array.isArray(v) ? v : [];
      next.enabledSkills = [...new Set(arr.map(x => String(x || '').trim()).filter(x => ids.has(x)))];
    }
    else if (k === 'learnGroups') {
      const arr = Array.isArray(v) ? v : [];
      next.learnGroups = [...new Set(arr.map(x => String(x || '').replace(/[^0-9A-Za-z_-]/g, '')).filter(Boolean))].slice(0, 50);
    }
    else if (k === 'learnGroupMeta') {
      const src = v && typeof v === 'object' ? v : {};
      const out = {};
      for (const [gid, meta] of Object.entries(src)) {
        const g = String(gid || '').replace(/[^0-9A-Za-z_-]/g, '');
        if (!g) continue;
        out[g] = {
          name: String((meta && meta.name) || '').slice(0, 80),
          members: meta && meta.members != null ? Math.max(0, Math.floor(Number(meta.members) || 0)) : null,
        };
        if (Object.keys(out).length >= 200) break;
      }
      next.learnGroupMeta = out;
    }
    else if (k === 'learnN') next.learnN = Math.max(1, Math.min(30, Math.floor(Number(v) || 6)));
    else if (k === 'learnPages') next.learnPages = Math.max(1, Math.min(20, Math.floor(Number(v) || 2)));
    else if (k === 'learnLastSettledWeek') next.learnLastSettledWeek = String(v || '').slice(0, 20);
    else if (typeof v === 'boolean') next[k] = v;
    else next[k] = v;
  }
  // 谁改了设置都记一笔（只记字段名与 Key 长度，绝不含 Key 内容）——
  // 免得再出现「Key 存了又被重置」时只能靠猜。日志：data/settings-audit.log
  try {
    const changed = Object.keys(patch || {}).filter(k => k in DEFAULT_SETTINGS);
    const keyNote = changed.includes('apiKey')
      ? (next.apiKey ? `apiKey=写入(${next.apiKey.length}字符)` : 'apiKey=清空')
      : 'apiKey=未动';
    await fs.promises.appendFile(
      path.join(DATA, 'settings-audit.log'),
      `${new Date().toISOString()} pid=${process.pid} ${keyNote} 字段=${changed.join(',') || '(无)'}\n`,
    );
  } catch {}
  await writeJsonFile(SETTINGS_FILE, next);
  return next;
}

async function loadIndex() {
  const idx = await readJsonFile(INDEX_FILE, []);
  return Array.isArray(idx) ? idx : [];
}

async function saveIndex(list) {
  await withLock('__index__', () => writeJsonFile(INDEX_FILE, list));
}

// ---------------------------------------------------------------- 日历
async function loadCalendar() {
  const d = await readJsonFile(CALENDAR_FILE, { events: [] });
  const events = Array.isArray(d?.events) ? d.events.filter(e => e && typeof e === 'object' && e.date) : [];
  return { events, updatedAt: Number(d?.updatedAt) || 0 };
}

async function saveCalendar(store) {
  store.updatedAt = now();
  await withLock('__calendar__', () => writeJsonFile(CALENDAR_FILE, { events: store.events, updatedAt: store.updatedAt }));
}

const calId = () => 'cal_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** 日历状态（前端面板直接用） */
async function calendarState(today = calDateStr()) {
  const store = await loadCalendar();
  return {
    today,
    now: calTimeStr(),
    weekday: new Date().getDay(),
    events: sortEvents(store.events),
    todayEvents: eventsOn(store.events, today),
    restOfDay: restOfDay(store.events),
    upcoming: upcoming(store.events, today, 7),
    updatedAt: store.updatedAt,
  };
}

// ---------------------------------------------------------------- QQ 通道（OneBot 11）
const qqState = {
  startedAt: 0,
  lastPollAt: 0,
  lastPollMs: 0,
  lastError: '',
  info: null,      // { ok, uid, nick }
  seen: [],        // 已转进来的 message_id
  recent: [],      // 最近收发记录（前端展示）
  timer: null,
  busy: false,
  sent: 0,
  received: 0,
};

// QQ 回话的排版：长回答拆成一串短句、一句一行，句末不留句号（照他平时的说话习惯）。
// 只动标点和分行，不改内容；切太碎就靠 maxLines 兜住。
// 把回答拆成一条一条短消息。分段由模型自己按语义决定（它写的时候就用空行分段），
// 这里只做兜底：段落太长（>60 字）才按句末标点再断，段尾的句号、分号、逗号去掉。
function qqSemanticParts(text, { maxParts = 8, paraMax = 60, lineMax = 40 } = {}) {
  const raw = String(text || '').replace(/\r/g, '').trim();
  if (!raw) return [];
  const clean = s => s.replace(/[。；;，,、\s]+$/, '').trim();
  const chunks = raw.split(/\n\s*\n/).map(s => s.replace(/\n+/g, ' ').trim()).filter(Boolean);
  const parts = [];
  for (const chunk of chunks) {
    if (chunk.length <= paraMax) { parts.push(clean(chunk)); continue; }
    // 太长的段落：按句末标点断，两句拼一条，别切成一字一句
    const sentences = chunk.split(/(?<=[。！？!?；;…~～])/).map(s => s.trim()).filter(Boolean);
    let buf = '';
    for (const s of sentences) {
      const t = s.replace(/^[。，,、；;]+/, '').trim();
      if (!t) continue;
      if (!buf) { buf = t; continue; }
      if ((buf + t).length <= lineMax) { buf = buf.replace(/[。；;]$/, '') + t; } else { parts.push(clean(buf)); buf = t; }
    }
    if (buf) parts.push(clean(buf));
  }
  return parts.filter(Boolean).slice(0, maxParts);
}

// 一条消息里用换行分句（推送、样张用这个）
function qqShortLines(text, opts = {}) {
  return qqSemanticParts(text, opts).join('\n');
}

function qqRemember(entry) {
  qqState.recent.push({ at: now(), ...entry });
  if (qqState.recent.length > 60) qqState.recent.splice(0, qqState.recent.length - 60);
}

// 已读清单要落盘：只放内存的话，每次重启都把最近 20 条当新的，会一口气补发一堆回答
const QQ_SEEN_FILE = path.join(DATA, 'qq-seen.json');
let qqSeenLoaded = false;
async function loadQqSeen() {
  try {
    const raw = JSON.parse(await fsp.readFile(QQ_SEEN_FILE, 'utf8'));
    const ids = Array.isArray(raw) ? raw : (Array.isArray(raw.ids) ? raw.ids : []);
    const keep = ids.map(x => String(x)).filter(Boolean);
    if (keep.length) qqState.seen = keep.slice(-300);
  } catch { /* 没有文件就是第一次跑 */ }
  return qqState.seen;
}
async function saveQqSeen() {
  try {
    const ids = qqState.seen.slice(-300);
    await fsp.mkdir(DATA, { recursive: true });
    await fsp.writeFile(QQ_SEEN_FILE, JSON.stringify({ at: now(), ids }, null, 0), 'utf8');
  } catch { /* 存不下就算了，别把轮询搞崩 */ }
}

// QQ 通道用哪个后端：默认用「隔离实例」（自己那份 delta、端口 napcatHttpPort），
// 而不是 DSH 那个 echo 的 3000 —— 不然两边抢同一个实例。设置里 qqUseIsoInstance=false 可退回 qqBaseUrl。
function effQqConfig(settings = {}) {
  const base = qqConfig(settings);
  const shell = String(settings.napcatShell || '').trim();
  if (!shell || settings.qqUseIsoInstance === false) return base;
  // 用户/测试显式配过 qqBaseUrl（跟默认值不同）就以他为准：不然测试打假后端、
  // 或者有人故意接别的 OneBot，都会被这里强行改回隔离实例。
  const explicit = String(settings.qqBaseUrl || '').trim();
  const dflt = String(DEFAULT_SETTINGS.qqBaseUrl || '').trim();
  if (explicit && explicit !== dflt) return base;
  const port = Number(settings.napcatHttpPort) || 3200;
  return { ...base, baseUrl: `http://127.0.0.1:${port}` };
}

// 群聊自学习：数据落在 <DATA>/qq-learn，跟着应用数据目录走（覆盖 dist 代码不会丢）
const learn = createLearnService({
  dataDir: DATA,
  onebot,
  // 设置是异步读的；这里把「实际生效的 OneBot 地址」一并塞进去（隔离实例是 3200，不是 3000）
  getSettings: async () => {
    const s = await loadSettings();
    return { ...s, __qq: effQqConfig(s) };
  },
  saveSettings: (patch) => saveSettings(patch),
});
async function qqStatus() {
  const settings = await loadSettings();
  const cfg = effQqConfig(settings);
  // 已绑定的回话会话：让前端能显示「现在往哪个对话里说」；会话被删了就标出来
  const boundId = settings.qqConvId || '';
  let bound = null;
  if (boundId) {
    const conv = await loadConversation(boundId).catch(() => null);
    bound = conv
      ? { id: conv.id, title: conv.title, messages: conv.messages.length, updatedAt: conv.updatedAt, source: conv.source || '' }
      : { id: boundId, missing: true };
  }
  return {
    conv: bound,
    mode: cfg.mode,
    baseUrl: cfg.baseUrl,
    uid: cfg.uid,
    group: cfg.group,
    pollMs: cfg.pollMs,
    convId: settings.qqConvId || '',
    callName: settings.qqCallName || '对方',
    started: !!qqState.timer,
    lastPollAt: qqState.lastPollAt,
    lastPollMs: qqState.lastPollMs,
    lastError: qqState.lastError,
    info: qqState.info,
    received: qqState.received,
    sent: qqState.sent,
    seen: qqState.seen.length,
    recent: qqState.recent.slice(-20),
  };
}

/** 发一条到 QQ（私聊优先，有群号就发群） */
async function qqSendText(text) {
  const settings = await loadSettings();
  const cfg = effQqConfig(settings);
  if (!text || !String(text).trim()) throw new Error('内容为空');
  if (cfg.group) {
    const r = await sendGroup(cfg, String(text));
    qqState.sent += 1;
    qqRemember({ dir: 'out', text: String(text), messageId: String(r.message_id || ''), to: 'group:' + cfg.group });
    return { ok: true, to: 'group', group: cfg.group, messageId: String(r.message_id || '') };
  }
  const r = await sendPrivate(cfg, String(text));
  qqState.sent += 1;
  qqRemember({ dir: 'out', text: String(text), messageId: String(r.message_id || ''), to: 'private:' + cfg.uid });
  return { ok: true, to: 'private', uid: cfg.uid, messageId: String(r.message_id || '') };
}

/** 能跑一轮对话却不走 SSE 的最小实现（给 QQ 回话用） */
async function chatOnce(conv, text, settings, { attachments = [] } = {}) {
  const apiKey = settings.apiKey || process.env.DEEPSEEK_API_KEY || '';
  if (!apiKey) throw new Error('没填 API Key，回不了话');
  const userMessage = newMessage('user', text, attachments.length ? { attachments } : {});
  conv.messages.push(userMessage);
  if (conv.title === '新对话' || !conv.title) conv.title = autoTitle(text);
  await saveConversation(conv);

  const ctxSettings = ctxSettingsFor(conv, settings);
  const built = await buildMessages(conv, ctxSettings, { withTools: false });
  let model = normalizeModel(conv.model || settings.model || 'deepseek-flash');
  if (model === 'auto') {
    // 带图就只能走能看图的模型（V4.1 Flash）；老对话里存过图也算
    const hasImage = attachments.some(a => a && a.kind === 'image')
      || conv.messages.some(m => Array.isArray(m.attachments) && m.attachments.some(x => x && x.kind === 'image'));
    model = hasImage
      ? normalizeModel(settings.routeThinkModel || 'deepseek-flash')
      : normalizeModel(settings.routeChatModel || 'deepseek-v4-pro');
  }
  // 装配完再兜一次底：模型不能看图却带着图，等于白带（附件是 base64 内联的，不看就是浪费）
  const imgBlocks = built.messages.reduce((n, m) =>
    n + (Array.isArray(m.content) ? m.content.filter(p => p && p.type === 'image_url').length : 0), 0);
  if (imgBlocks > 0) {
    const meta = MODELS.find(x => x.id === model);
    if (meta && meta.vision === false) model = normalizeModel(settings.routeThinkModel || 'deepseek-flash');
  }
  if (imgBlocks > 0 || attachments.length) {
    const lastUser = [...built.messages].reverse().find(x => x.role === 'user');
    const shape = !lastUser ? null : Array.isArray(lastUser.content)
      ? lastUser.content.map(p => (p && p.type === 'image_url')
        ? `image(${String(p.image_url?.url || '').split(',').pop()?.length || 0}b)`
        : String((p && p.text) || '').slice(0, 60))
      : String(lastUser.content).slice(0, 120);
    await fsp.appendFile(path.join(DATA, 'qq-debug.jsonl'), JSON.stringify({
      at: new Date().toISOString(), model, msgs: built.messages.length, imgBlocks,
      attached: attachments.length, shape,
    }) + '\n').catch(() => {});
  }
  const { chat } = apiEndpoints(settings.baseUrl);
  const r = await fetch(chat, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model === 'auto' ? (settings.routeChatModel || 'deepseek-v4-pro') : model,
      messages: built.messages,
      stream: false,
      thinking: { type: settings.thinking ? 'enabled' : 'disabled' },
      ...(settings.thinking ? { reasoning_effort: settings.reasoningEffort || 'high' } : {}),
      temperature: settings.temperature ?? 1,
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const msg = data?.choices?.[0]?.message || {};
  const answer = String(msg.content || '').trim();
  if (!answer) throw new Error('模型返回了空回答');
  const assistant = newMessage('assistant', answer, msg.reasoning_content ? { reasoning: String(msg.reasoning_content) } : {});
  conv.messages.push(assistant);
  await saveConversation(conv);
  return { answer, conv, model };
}

/** 找/建 QQ 专用会话 */
async function qqConversation() {
  const settings = await loadSettings();
  const id = settings.qqConvId;
  if (id) {
    const found = await loadConversation(id);
    if (found) return found;
  }
  const conv = {
    id: uid('c'),
    title: 'QQ',
    createdAt: now(),
    updatedAt: now(),
    messages: [],
    source: 'qq',
    model: settings.model === 'auto' ? 'deepseek-v4-pro' : (settings.model || 'deepseek-flash'),
  };
  await saveConversation(conv);
  // 记住这个会话，下次收消息接着往里放
  await saveSettings({ qqConvId: conv.id });
  return conv;
}

/** 没配 qqUid 时自己找一个默认对象：最近联系人优先，其次好友列表第一个 */
async function qqDiscoverUid(cfg) {
  const pickNumber = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? String(n) : '';
  };
  try {
    const r = await onebot(cfg, 'get_recent_contact', { count: 20 });
    for (const it of [].concat((r && r.data) || [])) {
      const type = Number(it && it.chat_type);
      const uid = pickNumber(it && (it.peerUin || it.user_id || it.target_id));
      if (uid && (type === 1 || type === 0 || !type)) return uid;
    }
  } catch { /* 老版本没这个接口 */ }
  try {
    const r = await onebot(cfg, 'get_friend_list', {});
    for (const it of [].concat((r && r.data) || [])) {
      const uid = pickNumber(it && (it.user_id || it.uin));
      if (uid) return uid;
    }
  } catch { /* 没登录时拿不到 */ }
  return '';
}

/** 换 / 建 QQ 回话会话：'' 或 'new' 新建一个；否则绑定已有会话（上下文直接续） */
async function qqBindConversation(rawId) {
  const id = String(rawId == null ? '' : rawId).trim();
  const settings = await loadSettings();
  if (!id || id === 'new') {
    const list = await loadIndex().catch(() => []);
    const used = new Set(list.filter(c => /^QQ/.test(String(c.title || ''))).map(c => String(c.title)));
    let title = 'QQ';
    for (let n = 2; used.has(title); n += 1) title = `QQ ${n}`;
    const conv = newConversation({
      title,
      source: 'qq',
      model: settings.model === 'auto' ? 'deepseek-v4-pro' : (settings.model || 'deepseek-flash'),
    });
    await saveConversation(conv);
    await saveSettings({ qqConvId: conv.id });
    return { ok: true, created: true, conv: { id: conv.id, title: conv.title, messages: 0 } };
  }
  const conv = await loadConversation(id);
  if (!conv) throw new Error('这个对话不在了（可能刚被删掉）');
  await saveSettings({ qqConvId: conv.id });
  return { ok: true, created: false, conv: { id: conv.id, title: conv.title, messages: conv.messages.length } };
}

// QQ 发来的图片：OneBot 里只给了 file/url，得自己下回来存成 upload，模型才看得见
const QQ_IMAGE_MAX = 12 * 1024 * 1024;
const QQ_IMAGE_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp' };

/** 图片二进制（先试直链，再请 OneBot 取本地文件） */
async function qqImageBytes(cfg, ref) {
  const src = String(ref || '').trim();
  if (!src) return null;
  if (/^https?:\/\//i.test(src)) {
    const r = await fetch(src, {
      headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://im.qq.com/' },
      signal: AbortSignal.timeout(20000),
    }).catch(() => null);
    if (r && r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length && buf.length <= QQ_IMAGE_MAX) return { buf, mime: String(r.headers.get('content-type') || '').split(';')[0] || '' };
    }
    return null;
  }
  // file 名 / 本地路径：找 OneBot 要
  const got = await onebot(cfg, 'get_image', { file: src }, { timeoutMs: 20000 }).catch(() => null);
  const d = (got && (got.data || got)) || {};
  const p = String(d.file || d.path || d.url || '');
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) return qqImageBytes(cfg, p);
  try {
    const buf = await fsp.readFile(p);
    if (buf.length && buf.length <= QQ_IMAGE_MAX) return { buf, mime: d.mime || '' };
  } catch { /* 拿不到就算了 */ }
  return null;
}

/** 把一条 QQ 消息里的图片落成附件（和网页上传的附件同一种形状） */
async function qqImageAttachments(cfg, item, { limit = 4 } = {}) {
  const out = [];
  for (const ref of (item.images || []).slice(0, limit)) {
    try {
      const got = await qqImageBytes(cfg, ref);
      if (!got || !got.buf) {
        await fsp.appendFile(path.join(DATA, 'qq-debug.jsonl'), JSON.stringify({ at: new Date().toISOString(), stage: 'download-fail', ref: String(ref).slice(0, 120) }) + '\n').catch(() => {});
        continue;
      }
      let mime = sniffImageMime(got.buf) || got.mime;
      if (!(mime in QQ_IMAGE_EXT)) mime = 'image/png';
      const ext = QQ_IMAGE_EXT[mime];
      const uploadId = `${uid('u')}${ext}`;
      await fsp.writeFile(path.join(UPLOAD_DIR, uploadId), got.buf);
      out.push({
        kind: 'image',
        name: String(item.nick || 'QQ') + '-' + (out.length + 1) + ext,
        mime,
        size: got.buf.length,
        uploadId,
        url: `/api/uploads/${uploadId}`,
      });
    } catch { /* 单张失败不影响别的 */ }
  }
  return out;
}

/** 轮询一次：拉新消息 → 接进会话 → 让模型回 → 发回 QQ */
async function qqPollOnce({ reply = true } = {}) {
  const settings = await loadSettings();
  const cfg = effQqConfig(settings);
  if (cfg.mode === 'off') return { skipped: 'mode-off' };
  // 没配对象：先自己去 OneBot 里找一个（最近联系人 → 好友列表），找到就存下来
  if (!cfg.uid && !cfg.group) {
    const guess = await qqDiscoverUid(cfg).catch(() => '');
    if (guess) {
      cfg.uid = guess;
      await saveSettings({ qqUid: guess }).catch(() => null);
    }
  }
  if (!cfg.uid && !cfg.group) return { skipped: 'no-target' };
  const t0 = now();
  let list = [];
  if (cfg.group) list = await groupHistory(cfg, { count: 20 });
  else list = await friendHistory(cfg, { count: 20 });
  // 只认对方发来的（群消息里过滤掉自己）
  const me = qqState.info?.uid || '';
  if (me) list = list.filter(m => m.uid !== me);
  // 已读记到盘上：不记的话每次重启都把最近 20 条当成新的，会一口气补发一堆回答
  if (!qqSeenLoaded) {
    qqSeenLoaded = true;
    await loadQqSeen();
    // 冷启动：历史一律算「已经看过」，不补答旧消息
    if (!qqState.seen.length) {
      qqState.seen = list.map(m => String(m.messageId)).filter(Boolean);
      await saveQqSeen();
      qqState.lastPollAt = now();
      return { skipped: 'warm-start', history: list.length };
    }
  }
  const { fresh, seen } = pickNew(list, qqState.seen);
  if (seen.length !== qqState.seen.length) {
    qqState.seen = seen;
    await saveQqSeen();
  }
  qqState.lastPollAt = now();
  qqState.lastPollMs = qqState.lastPollAt - t0;
  const outs = [];
  const usable = fresh.filter(item => item.text || item.images.length);
  for (const item of usable) {
    qqState.received += 1;
    qqRemember({ dir: 'in', text: item.text, uid: item.uid, nick: item.nick || '', messageId: item.messageId, images: item.images.length });
  }
  if (!usable.length) return { fresh: 0, replied: 0, outs, ms: now() - t0 };
  const conv = await qqConversation();
  if (!reply || cfg.mode !== 'both') {
    // 只发不回：收到的话也要记进会话，不然界面上什么都看不到
    try {
      for (const item of usable) {
        const atts = await qqImageAttachments(cfg, item);
        conv.messages.push(newMessage('user', qqUserPrompt(item, { callName: settings.qqCallName || '对方' }), atts.length ? { attachments: atts } : {}));
      }
      conv.updatedAt = now();
      await saveConversation(conv);
    } catch { /* 记不进去就算了 */ }
    return { fresh: usable.length, replied: 0, outs, ms: now() - t0 };
  }
  // 他说一句就回一轮：每条消息都是一次完整对话（不再合并成一批），
  // 但绝不去补答重启前的旧消息——那才是之前「一直发回答」的原因。
  for (const item of usable) {
    try {
      const ask = qqUserPrompt(item, { callName: settings.qqCallName || '对方' })
        + '\n\n【这条回在手机上】像平时跟人聊天那样说话：一两段连着说完就行，别为了「分段」把一句话拆成好几行；真要分，最多两段，中间空一行。句末不加句号，别啰嗦。';
      const atts = await qqImageAttachments(cfg, item);
      const res = await chatOnce(conv, ask, settings, { attachments: atts });
      // 一句一条地发，中间留点间隔，像人打字
      const parts = qqSemanticParts(res.answer, { maxParts: 3, paraMax: 140, lineMax: 90 });
      const ids = [];
      for (let i = 0; i < parts.length; i++) {
        if (i) await new Promise(r => setTimeout(r, 700));
        const sent = await qqSendText(parts[i]);
        if (sent) ids.push(sent);
      }
      outs.push({ messageId: item.messageId, answer: res.answer.slice(0, 120), parts: parts.length, sentIds: ids });
    } catch (e) {
      qqState.lastError = '回复失败：' + e.message;
      qqRemember({ dir: 'error', text: e.message });
    }
  }
  return { fresh: usable.length, replied: outs.length, outs, ms: now() - t0 };
}

// ---------------------------------------------------------------- NapCat（QQ 登录）
/** 目录里挑一个能用的启动器 */
function napcatLauncher(dir) {
  for (const name of ['扫码登录.bat', 'start-napcat-A.bat', 'start.bat', '启动.bat']) {
    const p = path.join(dir, name);
    if (existsSync(p)) return p;
  }
  return '';
}

/** 这份目录是不是 NapCat 的 Shell 副本（有 boot main / napcat.mjs，但没有 .bat 启动器） */
function isNapcatShellDir(dir) {
  if (!dir || !existsSync(dir)) return false;
  return existsSync(path.join(dir, 'NapCatWinBootMain.exe')) || existsSync(path.join(dir, 'napcat.mjs'));
}

/** 隔离实例的 Shell 目录（老 NapCat 目录跟 Shell 副本要分开认） */
function isoShellDir(settings) {
  const shell = String(settings.napcatShell || '').trim();
  if (shell && isNapcatShellDir(shell)) return shell;
  return '';
}

/** 找最新的二维码图（NapCat 扫码时会把二维码落成 png） */
async function findNapcatQr(dir) {
  const hits = [];
  const walk = async (d, depth) => {
    if (depth < 0) return;
    let list = [];
    try { list = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { await walk(p, depth - 1); continue; }
      if (!/\.png$/i.test(e.name)) continue;
      if (!/二维码|qrcode|qr/i.test(e.name)) continue;
      try {
        const st = await fsp.stat(p);
        if (st.size > 0 && st.size < 4 * 1024 * 1024) hits.push({ file: p, mtime: st.mtimeMs, size: st.size });
      } catch { /* 忽略 */ }
    }
  };
  await walk(dir, 2);
  hits.sort((a, b) => b.mtime - a.mtime);
  const best = hits[0];
  if (!best) return null;
  const fresh = now() - best.mtime < 10 * 60 * 1000; // 十分钟内算新鲜
  return { ...best, fresh };
}

/** 端口通不通（NapCat 的 OneBot 默认 3000） */
function portOpen(host, port, timeoutMs = 600) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    const done = ok => { try { sock.destroy(); } catch { /* 已关 */ } resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, host);
  });
}

// NapCat 覆盖写二维码时有时不改 mtime：只看 mtime 会把新码当旧的，只看"第一次见到"又会把
// 一张九天前的旧码当新的。所以记两件事：上次看到的是哪张（用来发现"换了"）、以及某张换上来
// 的时间（只有换上来过才算新鲜）。
const QR_SEEN = new Map();
let QR_LAST_HASH = '';
function markQrSeen(hash) {
  if (!hash) return 0;
  QR_SEEN.set(hash, Date.now());
  if (QR_SEEN.size > 32) QR_SEEN.delete(QR_SEEN.keys().next().value);
  return QR_SEEN.get(hash);
}
function observeQr(hash, mtime) {
  if (hash && QR_LAST_HASH && QR_LAST_HASH !== hash) markQrSeen(hash); // 亲眼看到它换了
  if (hash) QR_LAST_HASH = hash;
  const seen = hash ? (QR_SEEN.get(hash) || 0) : 0;
  const newest = Math.max(Number(mtime) || 0, seen || 0);
  return Date.now() - newest < 10 * 60 * 1000;
}

async function napcatQrOnly(settings) {
  const dir = settings.qqNapCatDir || DEFAULT_SETTINGS.qqNapCatDir;
  const listedAt = Date.now();
  if (!existsSync(dir)) return { dir, exists: false, qr: null, listedAt };
  const found = await findNapcatQr(dir);
  if (!found) return { dir, exists: true, qr: null, listedAt };
  try {
    const buf = await fsp.readFile(found.file);
    return {
      dir,
      exists: true,
      listedAt,
      qr: (() => {
        const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
        return {
          file: found.file,
          mtime: found.mtime,
          fresh: observeQr(hash, found.mtime),
          size: buf.length,
          hash,
          dataUrl: 'data:image/png;base64,' + buf.toString('base64'),
          servedAt: Date.now(),
        };
      })(),
    };
  } catch (e) {
    return { dir, exists: true, qr: null, listedAt, error: e.message };
  }
}

async function napcatStatus(settings) {
  const dir = settings.qqNapCatDir || DEFAULT_SETTINGS.qqNapCatDir;
  const exists = existsSync(dir);
  const launcher = exists ? napcatLauncher(dir) : '';
  // 通道总览这一栏也要认隔离实例的端口，不然卡片会一直显示「NapCat 没起来」
  let base = DEFAULT_SETTINGS.qqBaseUrl;
  try { base = new URL(effQqConfig(settings).baseUrl || DEFAULT_SETTINGS.qqBaseUrl); } catch { base = new URL(DEFAULT_SETTINGS.qqBaseUrl); }
  const open = await portOpen(base.hostname, Number(base.port) || 80);
  let qr = null;
  if (exists) {
    const found = await findNapcatQr(dir);
    if (found) {
      try {
        const buf = await fsp.readFile(found.file);
        const qhash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
        qr = {
          file: found.file,
          mtime: found.mtime,
          fresh: observeQr(qhash, found.mtime),
          size: buf.length,
          hash: qhash,
          dataUrl: 'data:image/png;base64,' + buf.toString('base64'),
          servedAt: Date.now(),
        };
      } catch { /* 读不到就算了 */ }
    }
  }
  let login = { ok: false };
  if (open) {
    try { login = await loginInfo(effQqConfig(settings)); } catch (e) { login = { ok: false, error: e.message }; }
  }
  return { dir, exists, launcher, port: base.port, portOpen: open, qr, login };
}

async function startNapcat(settings) {
  const dir = settings.qqNapCatDir || DEFAULT_SETTINGS.qqNapCatDir;
  const launcher = napcatLauncher(dir);
  // Shell 副本里没有 .bat 启动器，只有 NapCatWinBootMain.exe：交给 C++ 宿主拉起，
  // 它才知道要带 --user-data-dir（不带的后果是 QQ 快速登录别的号、永远不出码）。
  const shell = isoShellDir(settings);
  if (shell && (!launcher || shell === dir)) {
    const r = await napcatHostRun(settings, 'start');
    if (!r.ok && Number(r.code) !== 3) throw new Error(r.error || '宿主没把 NapCat 拉起来');
    return { ok: true, via: 'host', launcher: '(C++ 宿主)', shell, running: !!r.running, already: Number(r.code) === 3 };
  }
  if (!launcher) throw new Error(`没在 ${dir} 里找到启动器（扫码登录.bat / start-napcat-A.bat），也不是 Shell 副本（NapCatWinBootMain.exe）`);
  const child = spawn('cmd.exe', ['/c', launcher], { cwd: dir, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return { ok: true, via: 'bat', launcher };
}

// 找出占着 OneBot 端口 / 跑在 NapCat 目录里的进程，杀掉（重启 NapCat 才能让它重出二维码）
async function napcatPids(settings) {
  const dir = settings.qqNapCatDir || DEFAULT_SETTINGS.qqNapCatDir;
  const dirHint = path.basename(dir).toLowerCase(); // 只认命令行里带这个目录名的进程，别误杀别的
  const skip = new Set([process.pid, process.ppid].filter(Boolean));
  const pids = new Set();
  // ① 占着 OneBot 端口的那个
  try {
    let base = DEFAULT_SETTINGS.qqBaseUrl;
    try { base = new URL(settings.qqBaseUrl || DEFAULT_SETTINGS.qqBaseUrl); } catch { base = new URL(DEFAULT_SETTINGS.qqBaseUrl); }
    const port = Number(base.port) || 80;
    const text = await execFileAsync('netstat', ['-ano', '-p', 'TCP'], { timeout: 15000, windowsHide: true }).then(r => r.stdout).catch(() => '');
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes(':' + port + ' ') && !line.includes(':' + port + '\t')) continue;
      const m = line.trim().match(/\s(\d+)$/);
      const pid = m && Number(m[1]);
      if (pid && !skip.has(pid)) pids.add(pid);
    }
  } catch { /* 拿不到就只靠命令行匹配 */ }
  // ② 命令行里带 NapCat 目录名的进程（NapCat 本体 / 它拉起的 QQ）
  try {
    const ps = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
    ], { timeout: 20000, windowsHide: true });
    const raw = JSON.parse(String(ps.stdout || '[]').trim() || '[]');
    for (const it of [].concat(raw)) {
      const cmd = String((it && it.CommandLine) || '').toLowerCase();
      const pid = Number(it && it.ProcessId);
      if (!pid || skip.has(pid)) continue;
      if (cmd.includes('napcat-restart-test') || cmd.includes('qr-refresh-test')) continue; // 测试脚本自己
      if (!cmd.includes('napcat')) continue;
      if (!cmd.includes(dirHint) && !cmd.includes('napcatonekey')) continue;
      pids.add(pid);
    }
  } catch { /* 没权限就算了 */ }
  return [...pids];
}

function killPids(pids) {
  const killed = [];
  for (const pid of pids) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); killed.push(pid); } catch { /* 已经没了 */ }
  }
  return killed;
}

// 手动的「出新的码」：杀掉旧 NapCat → 重跑启动器 → 等目录里出现新二维码（最多 60 秒）
async function restartNapcat(settings) {
  const dir = settings.qqNapCatDir || DEFAULT_SETTINGS.qqNapCatDir;
  // Shell 副本：走宿主（stop + start）。已经登录的实例不硬杀——强杀会把登录 profile 写坏，
  // 代价是要重新扫码，这个坑踩过两次了。
  const shell = isoShellDir(settings);
  if (shell && (!napcatLauncher(dir) || shell === dir)) {
    const before = await napcatHostState(settings).catch(() => null);
    // 端口通 = 会话活着；这时去 stop 就等于把它杀了，代价是重新扫码。宁可不给码。
    if (before && (before.loggedIn || before.httpUp)) {
      return {
        ok: true, via: 'host', shell,
        skipped: '实例活着（已登录 / OneBot 端口通），没动它。真要换号，先点「停止」再重新扫码。',
        rebuilt: false, waitedMs: 0, qr: null,
        login: before.uid ? { uid: before.uid, nick: before.nick || '' } : null,
      };
    }
    const beforeHash = (before && before.qr && before.qr.hash) || '';
    const killed = await napcatHostRun(settings, 'stop').then(r => r.killed || []).catch(() => []);
    await new Promise(r => setTimeout(r, 1200));
    const t0 = Date.now();
    const started = await napcatHostRun(settings, 'start');
    if (!started.ok && Number(started.code) !== 3) throw new Error(started.error || '宿主没把 NapCat 拉起来');
    let st = before;
    let rebuilt = false;
    while (Date.now() - t0 < 60000) {
      await new Promise(r => setTimeout(r, 1200));
      st = await napcatHostState(settings).catch(() => null);
      if (!st) continue;
      if (st.loggedIn) { rebuilt = false; break; } // 已经登录就不用再等码
      const hash = (st.qr && st.qr.hash) || '';
      if (hash && hash !== beforeHash) { rebuilt = true; break; }
    }
    const qr = st && st.qr ? { file: st.qr.file, mtime: st.qr.mtime, fresh: st.qr.fresh } : null;
    return {
      ok: true, via: 'host', shell, killed, rebuilt, waitedMs: Date.now() - t0, qr,
      launcher: '(C++ 宿主)',
    };
  }
  const before = await findNapcatQr(dir).catch(() => null);
  const pids = await napcatPids(settings);
  const killed = killPids(pids);
  await new Promise(r => setTimeout(r, 1200));
  const started = await startNapcat(settings);
  const t0 = Date.now();
  const hashOf = async f => {
    if (!f) return '';
    try { return crypto.createHash('sha1').update(await fsp.readFile(f.file)).digest('hex').slice(0, 16); } catch { return ''; }
  };
  const beforeHash = await hashOf(before);
  let qr = before;
  let rebuilt = false;
  while (Date.now() - t0 < 60000) {
    await new Promise(r => setTimeout(r, 1200));
    const found = await findNapcatQr(dir).catch(() => null);
    if (!found) continue;
    qr = found;
    const hash = await hashOf(found);
    // 内容变了就算换码（mtime 在 copy 覆盖时可能不变，不能只信它）
    if (!before || hash !== beforeHash || found.file !== before.file || found.mtime > (before.mtime || 0)) {
      rebuilt = true;
      markQrSeen(hash);
      break;
    }
  }
  const changed = rebuilt;
  return {
    ok: true,
    launcher: started.launcher,
    killed,
    rebuilt: changed,
    waitedMs: Date.now() - t0,
    qr: qr ? { file: qr.file, mtime: qr.mtime, fresh: qr.fresh } : null,
  };
}

// ---------------------------------------------------------------- NapCat 宿主（C++ / 隔离实例）
// 为什么要它：一个 NapCat 实例只能挂一个 QQ 号，DSH 那边已经占了 echo（3000），
// DeepSeek Local 这边要自己有一份 Shell 副本、自己的号、自己的端口，否则两边抢同一个实例。
// 宿主的进程判定/端口探测/二维码读取全在 C++ 里（napcat/host.cpp），这里只负责拉起和转发。
function napcatHostExe(settings) {
  const custom = String(settings.napcatHost || '').trim();
  if (custom && existsSync(custom)) return custom;
  // 打包后：<app>\napcat\DSLNapCatHost.exe；开发态：<repo>\napcat\out\DSLNapCatHost.exe
  const cands = [
    path.join(ROOT, 'napcat', 'DSLNapCatHost.exe'),
    path.join(ROOT, 'napcat', 'out', 'DSLNapCatHost.exe'),
  ];
  for (const p of cands) if (existsSync(p)) return p;
  return '';
}

function napcatHostArgs(settings) {
  const args = [];
  const shell = String(settings.napcatShell || '').trim();
  if (shell) args.push('--shell', shell);
  const login = String(settings.napcatLogin || '').trim();
  if (login) args.push('--login', login);
  args.push('--http-port', String(settings.napcatHttpPort || 3200));
  args.push('--ws-port', String(settings.napcatWsPort || 3201));
  args.push('--webui-port', String(settings.napcatWebuiPort || 6209));
  // 状态文件可指定：沙盒里拿一份伪造的 fails 去演练纠错，不碰真实例（也方便多实例并排）
  const statusPath = String(settings.napcatStatusPath || '').trim();
  if (statusPath) args.push('--status', statusPath);
  return args;
}

async function napcatHostRun(settings, verb, extraArgs = []) {
  const exe = napcatHostExe(settings);
  if (!exe) return { ok: false, error: '没找到 DSLNapCatHost.exe（先跑 napcat/build.ps1 编译）', exe: '' };
  const r = await runCli(exe, [verb, ...napcatHostArgs(settings), ...extraArgs], { timeoutMs: 90000 });
  // 宿主默认输出缩进过的 JSON（多行），先整体解析；解析不了再退化成「取最后一行」
  let data = null;
  const text = String(r.out || '').trim();
  try { data = JSON.parse(text); } catch {
    try { data = JSON.parse(text.split(/\r?\n/).filter(Boolean).pop() || 'null'); } catch { data = null; }
  }
  // 宿主还会在 JSON 前后打几行人话（例如「[host] 已停止 2 个进程」），
  // 整体和末行都不成立时，把第一对 { } 之间那段抠出来再试一次。
  if (!data) {
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try { data = JSON.parse(text.slice(a, b + 1)); } catch { data = null; }
    }
  }
  if (!data) {
    // start / stop 这类动词宿主只回一行人话（退出码 0 = 成功、3 = 已经在跑），没有 JSON
    const msg = String(text || r.err || '').trim();
    const code = Number(r.code);
    if (verb === 'start' || verb === 'stop') {
      return { ok: code === 0 || code === 3, verb, message: msg, alreadyRunning: code === 3, exe, code };
    }
    return { ok: false, error: (msg || '宿主没有输出 JSON').slice(0, 400), exe, code };
  }
  return { ...data, exe, code: r.code, hostOk: r.ok };
}

/** 一份隔离实例的完整状态：宿主 JSON + 二维码 dataUrl */
async function napcatHostState(settings) {
  const st = await napcatHostRun(settings, 'status');
  // fails / warning 只活在「看门狗那个进程」的内存里：单独跑一次 status 永远是 0，
  // 所以这里把状态文件里持久化的那两样读出来盖上去，纠错才看得见真实的失败次数。
  try {
    const persistedPath = String(settings.napcatStatusPath || '').trim() ||
      path.join(path.dirname(String(settings.napcatHost || napcatHostExe(settings) || '')), 'state', 'host-status.json');
    if (persistedPath && existsSync(persistedPath)) {
      const saved = JSON.parse(await fsp.readFile(persistedPath, 'utf8'));
      if (saved && typeof saved === 'object') {
        if (Number(saved.fails) > 0) st.fails = Number(saved.fails);
        if (saved.warning) st.warning = String(saved.warning);
        if (saved.phase && !st.phase) st.phase = String(saved.phase);
        st.persistedAt = saved.ts || '';
      }
    }
  } catch { /* 状态文件读不到就当没有 */ }
  if (st.ok && st.qrExists && st.qrPath) {
    try {
      const buf = await fsp.readFile(st.qrPath);
      const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
      st.qr = {
        file: st.qrPath, mtime: st.qrMtime * 1000, size: buf.length, hash,
        fresh: observeQr(hash, st.qrMtime * 1000),
        dataUrl: 'data:image/png;base64,' + buf.toString('base64'),
        servedAt: Date.now(),
      };
    } catch { st.qr = null; }
  }
  return st;
}

// ---------------------------------------------------------------- 推送（把消息主动推到 QQ）
// 一道权限门：settings.pushEnabled（默认开）。关掉之后所有推送接口一律 403，免得误触。
// 推的对象：优先 body 里给的 uid/group，其次 settings.pushUid，最后回落到 qqUid。
async function pushSend({ text, uid = '', group = '', kind = 'manual' } = {}) {
  const settings = await loadSettings();
  if (settings.pushEnabled === false) {
    const e = new Error('推送权限关着（设置 → QQ 推送：打开「允许主动推送」）');
    e.code = 'PUSH_OFF';
    throw e;
  }
  const body = String(text || '').trim();
  if (!body) throw new Error('推送内容为空');
  if (body.length > 4000) throw new Error('推送内容太长（上限 4000 字）');
  const cfg = effQqConfig(settings);
  const toGroup = String(group || '').replace(/[^\d]/g, '');
  const toUid = String(uid || settings.pushUid || settings.qqUid || '').replace(/[^\d]/g, '');
  if (!toUid && !toGroup) throw new Error('没有推送目标：先填一个 QQ 号');
  const target = toGroup ? { ...cfg, group: toGroup, uid: '' } : { ...cfg, uid: toUid, group: '' };
  const r = toGroup ? await sendGroup(target, body) : await sendPrivate(target, body);
  qqState.sent += 1;
  qqRemember({ dir: 'out', text: body, messageId: String(r.message_id || ''), to: toGroup ? 'group:' + toGroup : 'private:' + toUid, kind });
  return {
    ok: true,
    to: toGroup ? 'group' : 'private',
    uid: toGroup ? '' : toUid,
    group: toGroup,
    messageId: String(r.message_id || ''),
  };
}

// ---------------------------------------------------------------- 自动纠错（隔离实例的自愈）
// 只做「能自动判断 + 能自动修」的三件：
//   1) 差 OneBot 配置（账号换过/配置丢了）→ 按当前账号补一份 3200/3201 的，然后重启实例；
//   2) 进程反复起不来、二维码一直不变（登录态被写坏）→ 把登录目录改名备份、建新的，标记需要重新扫码；
//   3) 修完推一条 QQ 消息告诉人（如果那时候通道是通的）。
// 不做的事：不去猜模型错误、不自动改 Key。
const healState = { at: 0, rounds: 0, actions: [], needLogin: false, lastError: '', log: [] };

function healLog(line) {
  const s = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${line}`;
  healState.log.push(s);
  if (healState.log.length > 40) healState.log.splice(0, healState.log.length - 40);
  fs.promises.appendFile(path.join(DATA, 'napcat-heal.log'), s + '\n').catch(() => {});
}

function onebotTemplate(httpPort, wsPort) {
  return {
    network: {
      httpServers: [{ name: 'dsl-http', enable: true, port: httpPort, host: '127.0.0.1', enableCors: true, enableWebsocket: false, messagePostFormat: 'array', token: '' }],
      httpSseServers: [],
      httpClients: [],
      websocketServers: [{ name: 'dsl-ws', enable: true, host: '127.0.0.1', port: wsPort, messagePostFormat: 'array', reportSelfMessage: false, token: '', enableForcePushEvent: true }],
      websocketClients: [],
      plugins: [],
    },
    musicSignUrl: '',
    enableLocalFile2Url: false,
    parseMultMsg: false,
    imageDownloadProxy: '',
  };
}

/** 当前已经登录过的账号（config 里 napcat_<uin>.json 的 uin） */
function napcatUins(shell) {
  try {
    return fs.readdirSync(path.join(shell, 'config'))
      .map(n => /^napcat_(\d+)\.json$/.exec(n))
      .filter(Boolean).map(m => m[1]);
  } catch { return []; }
}

/** 差一 OneBot 配置就补；返回补过的 uin 列表 */
function ensureOnebotConfigs(settings) {
  const shell = String(settings.napcatShell || '').trim();
  if (!shell) return [];
  const httpPort = Number(settings.napcatHttpPort) || 3200;
  const wsPort = Number(settings.napcatWsPort) || 3201;
  const fixed = [];
  for (const uin of napcatUins(shell)) {
    const f = path.join(shell, 'config', `onebot11_${uin}.json`);
    let need = false;
    if (!existsSync(f)) need = true;
    else {
      try {
        const cur = JSON.parse(fs.readFileSync(f, 'utf8'));
        const http = (cur?.network?.httpServers || [])[0];
        const ws = (cur?.network?.websocketServers || [])[0];
        if (!http || !ws || Number(http.port) !== httpPort || Number(ws.port) !== wsPort) need = true;
      } catch { need = true; }
    }
    if (need) {
      fs.writeFileSync(f, JSON.stringify(onebotTemplate(httpPort, wsPort), null, 2), 'utf8');
      fixed.push(uin);
      healLog(`补了 OneBot 配置：config/onebot11_${uin}.json（${httpPort}/${wsPort}）`);
    }
  }
  return fixed;
}

/** 登录目录轮换：把可疑的旧目录改成 login-broken-<时间戳>，再建一个空的 */
function rotateLoginDir(login) {
  const dir = String(login || '').trim();
  if (!dir) return '';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bak = `${dir}-broken-${stamp}`;
  try {
    if (existsSync(dir)) fs.renameSync(dir, bak);
    fs.mkdirSync(dir, { recursive: true });
    healLog(`登录目录重置：旧目录改名成 ${path.basename(bak)}（可以删），新建了空目录，需要重新扫码`);
    return bak;
  } catch (e) {
    healLog(`登录目录重置失败：${e.message}`);
    return '';
  }
}

/**
 * 跑一轮自检 + 自修。force=true 时不看节流，立刻动手。
 * 返回 { actions, state }：actions 是本轮真做过的事。
 */
async function napcatHealOnce({ force = false } = {}) {
  const settings = await loadSettings();
  if (settings.napcatAutoHeal === false && !force) return { ok: true, skipped: 'auto-heal-off', actions: [] };
  const st = await napcatHostState(settings).catch(e => ({ ok: false, error: e.message }));
  const actions = [];
  healState.at = Date.now();
  healState.rounds += 1;
  healState.actions = [];
  healState.lastError = '';
  if (!st || st.ok === false) {
    healState.lastError = (st && st.error) || '读不到宿主状态';
    // 宿主本身都没法问 → 交给计划任务/看门狗，这里不动手
    return { ok: false, actions, state: healState };
  }
  if (st.loggedIn) {
    // 在线：顺手把 OneBot 配置校一遍（有些版本会在登录后重写配置，端口可能被改回默认）
    const fixed = ensureOnebotConfigs(settings);
    if (fixed.length) {
      await napcatHostRun(settings, 'stop').catch(() => null);
      await napcatHostRun(settings, 'start').catch(() => null);
      const a = `在线但 OneBot 配置不对，已补 (${fixed.join(',')}) 并重启实例`;
      actions.push(a); healLog(a);
    }
    healState.needLogin = false;
  } else {
    const fails = Number(st.fails) || 0;
    if (fails >= 2) {
      const fixed = ensureOnebotConfigs(settings);
      if (fixed.length) {
        await napcatHostRun(settings, 'stop').catch(() => null);
        await napcatHostRun(settings, 'start').catch(() => null);
        const a = `起不来但 OneBot 配置缺，已补 (${fixed.join(',')}) 并重启`;
        actions.push(a); healLog(a);
      }
    }
    if (fails >= 4) {
      // 反复起不来：最可能是登录 profile 被写坏（QQ 起来就退）
      const bak = rotateLoginDir(settings.napcatLogin);
      if (bak) {
        await napcatHostRun(settings, 'stop').catch(() => null);
        await napcatHostRun(settings, 'start').catch(() => null);
        healState.needLogin = true;
        const a = '进程反复起不来，判定登录态坏了：已重置登录目录并重启，需要重新扫码';
        actions.push(a); healLog(a);
      }
    } else if (st.qrExists && !st.loggedIn) {
      healState.needLogin = true; // 等扫码，不算故障
    }
  }
  if (actions.length) {
    healState.actions = actions;
    if (settings.pushEnabled !== false) {
      const text = `【自动纠错】${actions.join('；')}`;
      pushSend({ text, kind: 'heal' }).catch(() => null); // 通道不通时静默失败
    }
  }
  return { ok: true, actions, state: { ...healState, status: { running: st.running, loggedIn: st.loggedIn, fails: st.fails, phase: st.phase } } };
}

/** 后台自检定时器：默认 90 秒一轮，可用 napcatAutoHeal=false 关掉 */
let healTimer = null;
function startHealLoop() {
  if (healTimer) return;
  healTimer = setInterval(() => {
    napcatHealOnce().catch(() => null);
  }, 90 * 1000);
  if (healTimer.unref) healTimer.unref();
}

// 群聊自学习：10 分钟抽一轮历史（只在实例在线、设了群、没关自动时才真干活）
let learnTimer = null;
let learnBusy = false;
function startLearnLoop() {
  if (learnTimer) return;
  learnTimer = setInterval(async () => {
    if (learnBusy) return;
    learnBusy = true;
    try {
      const r = await learn.tick({ pages: (await loadSettings()).learnPages || 2 });
      if (r && (r.added || r.settled)) log(`自学习：新增 ${r.added || 0} 条消息，结算 ${r.settled || 0} 个周报`);
    } catch (e) {
      log('自学习这一轮跳过：', e.message);
    } finally {
      learnBusy = false;
    }
  }, 10 * 60 * 1000);
  if (learnTimer.unref) learnTimer.unref();
  // 起来先跑一次（不阻塞启动）
  setTimeout(() => {
    if (learnBusy) return;
    learnBusy = true;
    learn.tick({ pages: 1 }).catch(() => null).finally(() => { learnBusy = false; });
  }, 20 * 1000).unref?.();
}
function stopLearnLoop() {
  if (learnTimer) clearInterval(learnTimer);
  learnTimer = null;
}

// ---------------------------------------------------------------- 通道总览（插件页）
async function channelsState() {
  const settings = await loadSettings();
  const [napcat, cal] = await Promise.all([napcatStatus(settings).catch(() => null), loadCalendar().catch(() => ({ events: [] }))]);
  let local = { ok: false, models: 0, chat: settings.ctxLocalModel || '' };
  try {
    const r = await fetch(settings.ctxLocalUrl + '/api/tags', { signal: AbortSignal.timeout(1200) });
    if (r.ok) {
      const d = await r.json();
      const models = d.models || [];
      local = { ok: true, models: models.length, chat: settings.ctxLocalModel || (await pickLocalChatModel(settings).catch(() => '')) || '' };
    }
  } catch { /* 没开 ollama 而已 */ }
  return {
    qq: {
      mode: settings.qqMode, uid: settings.qqUid, group: settings.qqGroup,
      convId: settings.qqConvId, pollMs: settings.qqPollMs,
      napcat: napcat ? { exists: napcat.exists, portOpen: napcat.portOpen, login: napcat.login } : null,
      received: qqState.received, sent: qqState.sent,
    },
    calendar: { events: (cal.events || []).length, today: (cal.events || []).filter(e => e.date === calDateStr() && !e.done).length, inContext: settings.calendarInContext !== false, days: settings.calendarDays },
    link: { local: settings.readLinkLocal !== false, mode: settings.readLinkMode, browser: !!hasBrowser() },
    route: { autoRoute: settings.autoRoute !== false, hybridMode: settings.hybridMode === true, chat: settings.routeChatModel, think: settings.routeThinkModel, draft: settings.routeHybridDraftModel, hybrid: settings.routeHybridModel },
    ctx: { compress: settings.ctxCompress !== false, rag: settings.ctxRag !== false, budget: settings.ctxBudget, summarizer: settings.ctxSummarizer, archive: settings.ctxArchive !== false },
    local,
  };
}

function startQQBridge() {
  if (qqState.timer) return;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const settings = await loadSettings();
      const cfg = effQqConfig(settings);
      // 没配对象也要跑：qqPollOnce 会自己去 OneBot 里挑一个（最近联系人 → 好友列表），
      // 挑到了就存进设置，之后就是正常轮询。
      if (cfg.mode !== 'off') {
        if (!qqState.info || !qqState.info.ok) qqState.info = await loginInfo(cfg);
        // both = 收 + 回；send = 只收不自动回（但也要收，不然界面上看不到）
        if (cfg.mode === 'both' || cfg.mode === 'send') {
          const r = await qqPollOnce();
          if (r && r.skipped) qqState.lastError = '';
        }
      }
    } catch (e) {
      qqState.lastError = e.message;
    }
    const s = await loadSettings().catch(() => ({ qqPollMs: 5000 }));
    const wait = Math.max(2000, Math.min(60000, Number(s.qqPollMs) || 5000));
    if (!stopped) qqState.timer = setTimeout(tick, wait);
  };
  qqState.startedAt = now();
  qqState.timer = setTimeout(tick, 1200);
}

function stopQQBridge() {
  if (qqState.timer) clearTimeout(qqState.timer);
  qqState.timer = null;
}

function summarize(conv) {
  return {
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    pinned: !!conv.pinned,
    source: conv.source || '',
    model: conv.model ? normalizeModel(conv.model) : '',
    messageCount: conv.messages.length,
    preview: previewOf(conv),
  };
}

function previewOf(conv) {
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m.role === 'assistant' && m.content) {
      const t = cleanText(m.content);
      return t.length > 60 ? t.slice(0, 60) + '…' : t;
    }
  }
  const first = conv.messages.find(m => m.role === 'user');
  return first ? (cleanText(first.content).slice(0, 60) || '') : '';
}

async function loadConversation(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const conv = await readJsonFile(path.join(CONV_DIR, `${id}.json`), null);
  if (!conv) return null;
  if (conv.model) conv.model = normalizeModel(conv.model);
  return conv;
}

async function saveConversation(conv, opts = {}) {
  // 导入历史时保留原始时间：updatedAt 决定索引排序与上下文里的「多少天前」
  if (!opts.keepUpdatedAt) conv.updatedAt = now();
  await withLock(conv.id, () => writeJsonFile(path.join(CONV_DIR, `${conv.id}.json`), conv));
  await bumpIndex(conv);
}

async function bumpIndex(conv) {
  const list = await loadIndex();
  const i = list.findIndex(c => c.id === conv.id);
  const item = summarize(conv);
  if (i >= 0) list[i] = item;
  else list.push(item);
  list.sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.updatedAt - a.updatedAt));
  await saveIndex(list);
}

async function deleteConversation(id) {
  await withLock(id, async () => {
    try { await fsp.unlink(path.join(CONV_DIR, `${id}.json`)); } catch {}
  });
  const list = await loadIndex();
  await saveIndex(list.filter(c => c.id !== id));
}

function newConversation({ title = '新对话', source = '', model = '', systemPrompt = '', createdAt = now(), messages = [] } = {}) {
  return {
    id: uid('c'),
    title,
    createdAt,
    updatedAt: createdAt,
    pinned: false,
    source,
    model,
    systemPrompt,
    messages,
  };
}

function newMessage(role, content, extra = {}) {
  return { id: uid('m'), role, content: String(content ?? ''), createdAt: now(), ...extra };
}

// ---------------------------------------------------------------- 导入 app 端导出

/** 从 app 导出的 JSON 里取出消息数组，容忍几种常见形状 */
function extractMessages(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return null;
  const candidates = [
    raw.messages, raw.data?.messages, raw.chat?.messages, raw.conversation?.messages,
    raw.chat_messages, raw.history, raw.data?.chat_messages,
  ];
  for (const c of candidates) if (Array.isArray(c)) return c;
  return null;
}

function normalizeRole(r) {
  const role = String(r || '').toLowerCase();
  if (role === 'assistant' || role === 'ai' || role === 'bot' || role === 'model' || role === 'deepseek') return 'assistant';
  if (role === 'user' || role === 'human' || role === 'me') return 'user';
  if (role === 'system') return 'system';
  return role || 'user';
}

function messageContent(m) {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map(p => (typeof p === 'string' ? p : p?.text || p?.content || ''))
      .filter(Boolean).join('\n');
  }
  if (typeof m.text === 'string') return m.text;
  return '';
}

function normalizeExport(raw) {
  const msgs = extractMessages(raw);
  if (!msgs) throw new Error('无法识别的导出格式：找不到 messages 数组');
  const out = [];
  let system = '';
  for (const m of msgs) {
    const role = normalizeRole(m.role ?? m.sender ?? m.author?.role ?? m.from);
    const content = messageContent(m);
    const reasoning = typeof m.reasoning === 'string' ? m.reasoning
      : typeof m.reasoning_content === 'string' ? m.reasoning_content
      : typeof m.think === 'string' ? m.think
      : typeof m.thinking === 'string' ? m.thinking : '';
    if (role === 'system') { if (content) system += (system ? '\n\n' : '') + content; continue; }
    if (role !== 'user' && role !== 'assistant') continue;
    if (!content.trim() && !reasoning.trim()) continue;
    const ts = Number(m.createdAt || m.created_at || m.timestamp || 0);
    out.push({
      id: uid('m'),
      role,
      content,
      ...(reasoning ? { reasoning } : {}),
      ...(ts ? { createdAt: ts } : {}),
      ...(m.usage && typeof m.usage === 'object' ? { usage: m.usage } : {}),
    });
  }
  return { messages: out, systemPrompt: system };
}

const IMPORTED_FLAG = path.join(DATA, '.auto-imported.json');

/** 首次启动时自动导入工作区里找到的 app 导出记录 */
async function autoImportOnFirstRun() {
  const settings = await loadSettings();
  if (!settings.autoImport) return;
  const done = await readJsonFile(IMPORTED_FLAG, null);
  if (done) return;

  const candidates = [
    path.join(ROOT, '..', 'AI摸鱼写游戏.json'),
    path.join(ROOT, '..', 'delta', '战地1弹震症士兵.json'),
  ];
  const imported = [];
  for (const file of candidates) {
    try {
      const stat = await fsp.stat(file);
      const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
      const { messages, systemPrompt } = normalizeExport(raw);
      if (!messages.length) continue;
      const conv = newConversation({
        title: path.basename(file, path.extname(file)).slice(0, 40),
        source: file,
        createdAt: stat.mtimeMs || now(),
        systemPrompt,
        messages,
      });
      conv.updatedAt = conv.createdAt;
      await saveConversation(conv);
      imported.push({ title: conv.title, count: messages.length });
      log(`自动导入：${conv.title}（${messages.length} 条）`);
    } catch (e) {
      if (e.code !== 'ENOENT') log(`自动导入失败 ${file}: ${e.message}`);
    }
  }
  await writeJsonFile(IMPORTED_FLAG, { at: now(), imported });
}

// ---------------------------------------------------------------- HTTP 工具

function log(...args) {
  console.log(new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...args);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      const buf = Buffer.concat(chunks);
      const type = String(req.headers['content-type'] || '');
      if (type.includes('application/json')) {
        try { resolve(JSON.parse(buf.toString('utf8'))); } catch (e) { reject(new Error('JSON 解析失败：' + e.message)); }
      } else resolve(buf.toString('utf8'));
    });
    req.on('error', reject);
  });
}

function readBodyBuffer(req, limit = 220 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sseHead(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
}

function sseSend(res, obj) {
  if (res.writableEnded) return false;
  try { res.write(`data: ${JSON.stringify(obj)}\n\n`); return true; } catch { return false; }
}

function sseEnd(res) {
  if (res.writableEnded) return;
  try { res.end(); } catch {}
}

// ---------------------------------------------------------------- multipart

/** 极简 multipart/form-data 解析（够用即可） */
function parseMultipart(buf, contentType) {
  const m = /boundary=("?)([^";]+)\1/i.exec(String(contentType || ''));
  if (!m) throw new Error('缺少 multipart boundary');
  const boundary = Buffer.from('--' + m[2]);
  const sep = Buffer.from('\r\n' + '--' + m[2]);
  const parts = [];
  let pos = buf.indexOf(boundary);
  while (pos >= 0) {
    let from = pos + boundary.length;
    if (buf[from] === 0x2d && buf[from + 1] === 0x2d) break; // 结束标记 --
    if (buf[from] === 0x0d) from += 2;
    const headEnd = buf.indexOf('\r\n\r\n', from);
    if (headEnd < 0) break;
    const head = buf.toString('utf8', from, headEnd);
    const bodyStart = headEnd + 4;
    const next = buf.indexOf(sep, bodyStart);
    const bodyEnd = next < 0 ? buf.length : next;
    const nameM = /name="([^"]*)"/i.exec(head);
    const fileM = /filename="([^"]*)"/i.exec(head);
    const typeM = /content-type:\s*([^\r\n]+)/i.exec(head);
    parts.push({
      name: nameM ? nameM[1] : '',
      filename: fileM ? fileM[1] : '',
      contentType: typeM ? typeM[1].trim() : 'application/octet-stream',
      data: buf.subarray(bodyStart, bodyEnd),
    });
    pos = next;
  }
  return parts;
}

function buildMultipart(fields) {
  const boundary = '----dsapp' + crypto.randomBytes(10).toString('hex');
  const chunks = [];
  for (const f of fields) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"`;
    if (f.filename) head += `; filename="${f.filename}"`;
    head += '\r\n';
    if (f.contentType) head += `Content-Type: ${f.contentType}\r\n`;
    head += '\r\n';
    chunks.push(Buffer.from(head, 'utf8'), f.data, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

// ---------------------------------------------------------------- 上游 API

async function listModels(settings) {
  const { models } = apiEndpoints(settings.baseUrl);
  const r = await fetch(models, { headers: { Authorization: `Bearer ${settings.apiKey}` } });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status} ${text.slice(0, 300)}`);
  }
  return r.json();
}

function parseSseBlock(block) {
  const lines = block.split(/\r?\n/);
  const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
  if (!data || data === '[DONE]') return data === '[DONE]' ? { done: true } : null;
  try { return JSON.parse(data); } catch { return null; }
}

function upstreamErrorText(status, text) {
  let msg = `HTTP ${status}`;
  try {
    const j = JSON.parse(text);
    msg = j.error?.message || j.message || msg;
  } catch { if (text) msg += ' ' + String(text).slice(0, 300); }
  if (status === 400 && /Content Exists Risk/i.test(text || '')) msg = '内容安全审核未通过（Content Exists Risk）：换个说法再试。';
  // 上游明确说：服务端工具（联网/读链接）和自动标题只有 flash 支持，pro 会整条被拒
  if (/server-side tool calls|title generation feature are unavailable/i.test(text || '')) {
    const m = (text.match(/model\s+(deepseek-[a-z0-9.-]+)/i) || [])[1];
    msg = `${m || '这个模型'} 不支持服务端工具（联网搜索/读链接）和自动标题，只有 V4.1 Flash 支持；`
      + '请把模型切到「DeepSeek V4.1 Flash」或「自动（按内容路由）」再试。';
  }
  return msg;
}

// ---------------------------------------------------------------- 附件

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const USER_DATA_EXT = new Set(['.txt', '.md', '.csv', '.json', '.xlsx', '.xls', '.epub', '.mobi', '.js', '.ts', '.py', '.html', '.css', '.xml', '.yaml', '.yml', '.log', '.ini', '.toml']);

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
};

function attachmentKind(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return IMAGE_EXT.has(ext) ? 'image' : 'file';
}

function purposeFor(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (USER_DATA_EXT.has(ext)) return 'user_data';
  return 'text_recognition';
}

async function uploadToFilesApi(settings, buf, filename) {
  const { files } = apiEndpoints(settings.baseUrl);
  const fd = new FormData();
  fd.append('purpose', purposeFor(filename)); // purpose 必须在 file 之前
  fd.append('file', new Blob([buf]), filename);
  const r = await fetch(files, {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.apiKey}` },
    body: fd,
    signal: AbortSignal.timeout(300000),
  });
  const text = await r.text().catch(() => '');
  if (!r.ok) throw new Error(upstreamErrorText(r.status, text));
  try {
    const j = JSON.parse(text);
    if (!j.id) throw new Error('Files API 没返回 file id');
    return j;
  } catch (e) {
    throw new Error('Files API 返回异常：' + e.message);
  }
}

async function readUpload(uploadId) {
  if (!/^[A-Za-z0-9_.-]+$/.test(String(uploadId || ''))) return null;
  const file = path.join(UPLOAD_DIR, uploadId);
  if (!path.resolve(file).startsWith(path.resolve(UPLOAD_DIR))) return null;
  try { return { file, data: await fsp.readFile(file) }; } catch { return null; }
}

/** 看文件头认图片类型：QQ 那边给的 content-type 经常是 octet-stream，照它写 mime 会传成「假 png」 */
function sniffImageMime(buf) {
  if (!buf || !buf.length) return '';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 6 && buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length > 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return '';
}

/** 把附件的本地缓存转成请求里的 content 块 */
async function attachmentPayload(att, toolsUsed) {
  if (!att || !att.uploadId) return null;
  const got = await readUpload(att.uploadId);
  if (att.kind === 'image') {
    // 图片：base64 内联（模型能直接看；不用 Files API 免得占文档额度）
    const data = got ? got.data : null;
    if (!data) return null;
    const mime = sniffImageMime(data) || att.mime || MIME_BY_EXT[path.extname(att.uploadId).toLowerCase()] || 'image/png';
    return { type: 'image_url', image_url: { url: `data:${mime};base64,${data.toString('base64')}`, detail: 'high' } };
  }
  if (att.fileId) return { type: 'file', file_id: att.fileId };
  return null;
}

// ---------------------------------------------------------------- 视频 / 音频解析
//
// DeepSeek API 没有「视频理解」这种接口，所以视频解析在这里是靠本地 ffmpeg + 官方已有的能力拼出来的：
//   视频 → 抽音轨 → 按 ≤110 秒切片 → /v1/tools/asr 转写 → 再均匀抽关键帧（jpg）
//   音频 → 切片转写
// 发消息时：转写文字作为文本块、关键帧作为图片块（deepseek-flash 支持图片）一起给模型。

const MEDIA_DIR = path.join(DATA, 'media');
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.flv', '.wmv', '.mpg', '.mpeg', '.ts']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.oga', '.flac', '.aac', '.opus', '.wma', '.amr']);

const MEDIA_MIME = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo', '.m4v': 'video/x-m4v', '.flv': 'video/x-flv', '.wmv': 'video/x-ms-wmv',
  '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.ts': 'video/mp2t',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.flac': 'audio/flac', '.aac': 'audio/aac', '.opus': 'audio/opus', '.wma': 'audio/x-ms-wma', '.amr': 'audio/amr',
};

function mediaKindOf(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return '';
}

/** 找可执行文件：设置里指定的 → 环境变量 → 本机常见路径 → PATH */
async function findBin(name, settings) {
  const envKey = name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH';
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates = [
    settings && settings.ffmpegPath ? path.join(settings.ffmpegPath, exe) : '',
    settings && settings.ffmpegPath && path.extname(settings.ffmpegPath) ? settings.ffmpegPath.replace(/ffmpeg(probe)?/i, name) : '',
    process.env[envKey] || '',
    process.platform === 'win32' ? `D:\\ffmpeg-9.0-full_build\\bin\\${exe}` : '',
    process.platform === 'win32' ? `C:\\ffmpeg\\bin\\${exe}` : '/usr/local/bin/' + name,
    '/usr/bin/' + name,
    name,
  ].filter(Boolean);
  for (const c of candidates) {
    if (!c.includes('/') && !c.includes('\\')) return c; // 交给 PATH 解析
    try { await fsp.access(c); return c; } catch {}
  }
  return name;
}

function runBin(bin, args, { timeout = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || '').split('\n').filter(Boolean).slice(-3).join(' ');
        reject(new Error(msg || `${bin} 执行失败`));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** ffprobe 看时长与有没有音轨/视频轨 */
async function probeMedia(file, settings) {
  const ffprobe = await findBin('ffprobe', settings);
  const out = await runBin(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 60000 });
  let j = {};
  try { j = JSON.parse(out.stdout || '{}'); } catch { throw new Error('ffprobe 返回无法解析'); }
  const streams = j.streams || [];
  const v = streams.find(s => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = streams.find(s => s.codec_type === 'audio');
  const duration = Number(j.format?.duration) || Number(v?.duration) || Number(a?.duration) || 0;
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    hasVideo: !!v,
    hasAudio: !!a,
    width: Number(v?.width) || 0,
    height: Number(v?.height) || 0,
    videoCodec: v?.codec_name || '',
    audioCodec: a?.codec_name || '',
  };
}

/** 抽成 16kHz 单声道 16bit PCM（ASR 只吃这个和 Ogg Opus） */
async function extractAudio(file, outWav, settings) {
  const ffmpeg = await findBin('ffmpeg', settings);
  await runBin(ffmpeg, ['-y', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outWav], { timeout: 600000 });
  const st = await fsp.stat(outWav);
  return st.size;
}

/** 按秒切 WAV，返回 [{file, start, dur}] */
async function splitWav(wavFile, totalSec, chunkSec, workDir, settings) {
  const ffmpeg = await findBin('ffmpeg', settings);
  const parts = [];
  const step = Math.max(20, Math.min(115, Number(chunkSec) || 110));
  for (let start = 0, i = 0; start < totalSec - 0.2; start += step, i++) {
    const dur = Math.min(step, totalSec - start);
    const out = path.join(workDir, `part_${i}.wav`);
    await runBin(ffmpeg, ['-y', '-v', 'error', '-ss', String(start), '-t', String(dur), '-i', wavFile, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out], { timeout: 300000 });
    parts.push({ file: out, start, dur });
  }
  return parts;
}

/** 一段 WAV → 文字（走官方 /v1/tools/asr） */
async function transcribeWav(settings, buf) {
  const { asr } = apiEndpoints(settings.baseUrl);
  const form = buildMultipart([{ name: 'file', filename: 'speech.wav', contentType: 'audio/wav', data: buf }]);
  const r = await fetch(asr, {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': form.contentType },
    body: form.body,
    signal: AbortSignal.timeout(600000),
  });
  const text = await r.text().catch(() => '');
  if (!r.ok) throw new Error(upstreamErrorText(r.status, text));
  let j = {};
  try { j = JSON.parse(text); } catch { throw new Error('ASR 返回异常'); }
  return { text: String(j.text || '').trim(), duration: Number(j.duration_ms || 0) / 1000 };
}

/** 均匀抽关键帧（跳过片头片尾一点点） */
async function extractFrames(file, duration, count, workDir, settings) {
  const ffmpeg = await findBin('ffmpeg', settings);
  const frames = [];
  const n = Math.max(0, Math.min(12, Number(count) || 0));
  if (!n || !duration) return frames;
  for (let i = 0; i < n; i++) {
    const t = duration * ((i + 0.5) / n);
    const file_i = path.join(workDir, `frame_${i}.jpg`);
    try {
      await runBin(ffmpeg, ['-y', '-v', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '4', file_i], { timeout: 120000 });
      const st = await fsp.stat(file_i);
      if (st.size > 0) frames.push({ time: Math.round(t * 10) / 10, file: `frame_${i}.jpg` });
    } catch (e) {
      log(`抽帧失败 @${t.toFixed(1)}s：${e.message}`);
    }
  }
  return frames;
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** 完整解析一个视频/音频文件 */
async function analyzeMedia(settings, { name, buf, mime }) {
  const kind = mediaKindOf(name);
  if (!kind) throw Object.assign(new Error('不认识的音视频格式'), { code: 'UNSUPPORTED' });
  const mediaId = uid(kind === 'video' ? 'v' : 'a');
  const dir = path.join(MEDIA_DIR, mediaId);
  await fsp.mkdir(dir, { recursive: true });
  const ext = (path.extname(name).toLowerCase() || (kind === 'video' ? '.mp4' : '.mp3')).replace(/[^.a-z0-9]/g, '');
  const original = path.join(dir, 'original' + ext);
  await fsp.writeFile(original, buf);

  const warnings = [];
  let info;
  try {
    info = await probeMedia(original, settings);
  } catch (e) {
    throw Object.assign(new Error(`读不出这个文件的音视频信息（ffprobe：${e.message}）`), { code: 'FFMPEG' });
  }
  const duration = info.duration || 0;

  // 1) 转写
  const transcript = [];
  let fullText = '';
  if (info.hasAudio) {
    const wav = path.join(dir, 'audio.wav');
    try {
      await extractAudio(original, wav, settings);
      const parts = await splitWav(wav, duration || info.duration, settings.mediaChunkSec, dir, settings);
      for (const p of parts) {
        try {
          const data = await fsp.readFile(p.file);
          if (!data.length) continue;
          const r = await transcribeWav(settings, data);
          const seg = { start: Math.round(p.start * 10) / 10, end: Math.round((p.start + p.dur) * 10) / 10, text: r.text };
          transcript.push(seg);
          if (r.text) fullText += (fullText ? '\n' : '') + r.text;
        } catch (e) {
          warnings.push(`${fmtDuration(p.start)} 这一段没转出来：${e.message}`);
        } finally {
          await fsp.rm(p.file, { force: true }).catch(() => {});
        }
      }
    } catch (e) {
      warnings.push(`音轨抽取失败：${e.message}`);
    } finally {
      await fsp.rm(wav, { force: true }).catch(() => {});
    }
    if (!fullText) warnings.push('没有识别到语音内容');
  } else {
    warnings.push(kind === 'video' ? '这个视频没有音轨，只能看画面' : '这个音频文件没有可识别的音轨');
  }

  // 2) 视频抽帧
  let frames = [];
  if (kind === 'video') {
    const want = Number(settings.mediaFrames) || 0;
    frames = await extractFrames(original, duration, want, dir, settings);
    if (!frames.length) warnings.push('没抽出关键帧');
  }

  const meta = {
    mediaId,
    name,
    kind,
    mime: mime || MEDIA_MIME[ext] || 'application/octet-stream',
    size: buf.length,
    duration,
    hasAudio: info.hasAudio,
    hasVideo: info.hasVideo,
    width: info.width,
    height: info.height,
    text: fullText,
    transcript,
    frames: frames.map(f => ({ time: f.time, url: `/api/media/${mediaId}/${f.file}` })),
    warnings,
    createdAt: now(),
  };
  await fsp.rm(original, { force: true }).catch(() => {}); // 原文件不留（体积大、且已经抽完）
  await writeJsonFile(path.join(dir, 'meta.json'), meta);
  return meta;
}

async function readMediaMeta(mediaId) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(mediaId || ''))) return null;
  return readJsonFile(path.join(MEDIA_DIR, mediaId, 'meta.json'), null);
}

/** GET /api/media/<id>/<file> —— 关键帧 */
async function serveMediaFile(res, mediaId, fileName) {
  if (!/^[A-Za-z0-9_-]+$/.test(mediaId) || !/^[A-Za-z0-9_.-]+$/.test(fileName)) return sendText(res, 400, 'Bad request');
  const file = path.join(MEDIA_DIR, mediaId, fileName);
  if (!path.resolve(file).startsWith(path.resolve(MEDIA_DIR))) return sendText(res, 400, 'Bad request');
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'private, max-age=86400',
    });
    return res.end(data);
  } catch {
    return sendText(res, 404, 'Not found');
  }
}

/** POST /api/media —— 原始字节上传，解析成 { transcript, frames } */
async function handleMedia(req, res) {
  const settings = await loadSettings();
  if (!settings.apiKey) return sendJson(res, 400, { error: '还没填 API Key', code: 'NO_KEY' });
  const name = decodeURIComponent(String(req.headers['x-filename'] || 'media')).slice(0, 200) || 'media';
  if (!mediaKindOf(name)) return sendJson(res, 415, { error: `不认识的音视频格式：${path.extname(name) || name}`, code: 'UNSUPPORTED' });
  const buf = await readBodyBuffer(req, 400 * 1024 * 1024);
  if (!buf || !buf.length) return sendJson(res, 400, { error: '空文件' });
  if (buf.length > 300 * 1024 * 1024) return sendJson(res, 413, { error: '文件超过 300 MiB', code: 'TOO_LARGE' });

  const t0 = Date.now();
  try {
    const meta = await analyzeMedia(settings, { name, buf, mime: String(req.headers['content-type'] || '') });
    log(`解析 ${name}（${fmtDuration(meta.duration)}）：转写 ${meta.text.length} 字，${meta.frames.length} 帧，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return sendJson(res, 200, meta);
  } catch (e) {
    log(`解析失败 ${name}：${e.message}`);
    return sendJson(res, 502, { error: `解析失败：${e.message}`, code: e.code || 'MEDIA' });
  }
}

/** 附件 → content 块（媒体附件会变成「转写文字 + 关键帧图片」） */
async function mediaBlocks(att) {
  const blocks = [];
  if (!att || !att.mediaId) return blocks;
  const isVideo = att.kind === 'video';
  const dur = fmtDuration(att.duration || 0);
  if (String(att.text || '').trim()) {
    blocks.push({
      type: 'text',
      text: `【${isVideo ? '视频' : '音频'}转写 · ${att.name || ''} · 时长 ${dur}】\n${att.text}`,
    });
  }
  if (isVideo && Array.isArray(att.frames) && att.frames.length) {
    const imgs = [];
    for (const f of att.frames.slice(0, 12)) {
      const base = path.basename(String(f.url || ''));
      if (!base) continue;
      try {
        const data = await fsp.readFile(path.join(MEDIA_DIR, att.mediaId, base));
        imgs.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data.toString('base64')}`, detail: 'high' } });
      } catch {}
    }
    if (imgs.length) {
      blocks.push({ type: 'text', text: `下面是这个视频按时间均匀抽的 ${imgs.length} 帧画面（约每 ${(Number(att.duration || 0) / imgs.length).toFixed(1)} 秒一帧）。` });
      blocks.push(...imgs);
    }
  }
  return blocks;
}

// ---------------------------------------------------------------- 业务：发消息 / 重新生成 / 编辑重发 / 继续生成

function wantsReadLink(text) {
  return /https?:\/\//i.test(String(text || ''));
}

// ---------------------------------------------------------------- 本机小模型（ollama）
// 压缩摘要优先交给本机 ollama 的小模型写：不走网络、不花 API 钱。
// 它只是「写摘要」，挂了不影响聊天：降级到 DeepSeek API，再不行就丢掉老消息。

const ARCHIVE_DIR = path.join(DATA, 'archive');

// ---------------------------------------------------------------- 摘要模型自动拉取
// 本机 ollama 里没有可用的小模型时，自动拉一个：先走 ollama 官方源，
// 拉不动（国内网络常见）就换成国内镜像下 GGUF，再用 ollama create 装进去。

const MODEL_DIR = path.join(DATA, 'models');

/** 候选摘要模型：从小到大，先试小的（省流量也够写摘要） */
const PULL_TARGETS = [
  {
    tag: 'qwen2.5:1.5b-instruct',
    repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF',
    file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    size: '约 1.0 GB',
  },
  {
    tag: 'qwen2.5:0.5b-instruct',
    repo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
    file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
    size: '约 0.4 GB',
  },
];

/** 国内镜像：按顺序试，前一个失败自动换下一个 */
const PULL_MIRRORS = [
  { id: 'modelscope', label: '魔搭 ModelScope', url: (t) => `https://modelscope.cn/models/${t.repo}/resolve/master/${t.file}` },
  { id: 'hf-mirror', label: 'HF 镜像 hf-mirror.com', url: (t) => `https://hf-mirror.com/${t.repo}/resolve/main/${t.file}` },
];

const MIRROR_OVERRIDE = (() => {
  try {
    const raw = process.env.DSAPP_PULL_MIRRORS;
    if (!raw) return null;
    const list = JSON.parse(raw);
    return Array.isArray(list) && list.length ? list : null;
  } catch {
    return null;
  }
})();

function pullMirrors() {
  if (MIRROR_OVERRIDE) return MIRROR_OVERRIDE.slice();
  return PULL_MIRRORS.map(m => ({ ...m, url: m.url }));
}

function findOllamaCli() {
  if (process.env.DSAPP_OLLAMA_CLI) return process.env.DSAPP_OLLAMA_CLI;
  const names = process.platform === 'win32' ? ['ollama.exe', 'ollama.cmd'] : ['ollama'];
  const dirs = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama') : '',
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Ollama') : '',
    process.env.ProgramW6432 ? path.join(process.env.ProgramW6432, 'Ollama') : '',
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Programs', 'Ollama') : '',
  ].filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const f = path.join(dir, name);
      if (existsSync(f)) return f;
    }
  }
  return 'ollama';
}

let modelPull = {
  running: false,
  ok: false,
  startedAt: 0,
  finishedAt: 0,
  step: '',
  source: '',
  model: '',
  bytes: 0,
  total: 0,
  error: '',
  log: [],
};

function pullLog(line) {
  const text = String(line || '').slice(0, 400);
  if (!text) return;
  modelPull.step = text;
  modelPull.log.push({ at: Date.now(), text });
  if (modelPull.log.length > 60) modelPull.log.splice(0, modelPull.log.length - 60);
}

function pullSnapshot() {
  return {
    running: modelPull.running,
    ok: modelPull.ok,
    startedAt: modelPull.startedAt,
    finishedAt: modelPull.finishedAt,
    step: modelPull.step,
    source: modelPull.source,
    model: modelPull.model,
    bytes: modelPull.bytes,
    total: modelPull.total,
    error: modelPull.error,
    mirrors: pullMirrors().map(m => m.label || m.id || ''),
    log: modelPull.log.slice(-20),
  };
}

function runCli(exe, args, { timeoutMs = 180000, cwd } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      // 测试注入的假 ollama 是一个 .mjs 脚本，用 node 跑起来
      if (/\.m?js$/i.test(exe)) child = spawn(process.execPath, [exe, ...args], { cwd, windowsHide: true, env: process.env });
      else child = spawn(exe, args, { cwd, windowsHide: true, env: process.env });
    } catch (e) {
      return resolve({ ok: false, code: -1, out, err: String(e.message || e) });
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已经退了 */ }
    }, timeoutMs);
    child.stdout?.on('data', (d) => { out += String(d); if (out.length > 4000) out = out.slice(-4000); });
    child.stderr?.on('data', (d) => { err += String(d); if (err.length > 4000) err = err.slice(-4000); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: -1, out, err: String(e.message || e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code: code ?? -1, out, err }); });
  });
}

/** 把远端文件流到本地（带进度），失败返回 ok:false */
async function downloadTo(url, dest) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30 * 60 * 1000), redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
  const total = Number(r.headers.get('content-length') || 0);
  modelPull.total = total;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const ws = fs.createWriteStream(tmp);
  const reader = r.body.getReader();
  let got = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      modelPull.bytes = got;
      if (got % (2 * 1024 * 1024) < value.length) {
        pullLog(`下载中 ${(got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`);
      }
      if (!ws.write(Buffer.from(value))) await new Promise(res => ws.once('drain', res));
    }
  } finally {
    await new Promise(res => ws.end(res));
  }
  await fsp.rename(tmp, dest);
  return { bytes: got, total };
}

function modelfileFor(target, ggufPath) {
  return [
    `FROM ${ggufPath.replace(/\\/g, '/')}`,
    'PARAMETER num_ctx 8192',
    'PARAMETER temperature 0.3',
    'TEMPLATE """{{ if .System }}<|im_start|>system',
    '{{ .System }}<|im_end|>',
    '{{ end }}{{ if .Prompt }}<|im_start|>user',
    '{{ .Prompt }}<|im_end|>',
    '{{ end }}<|im_start|>assistant',
    '{{ .Response }}<|im_end|>',
    '"""',
    '',
  ].join('\n');
}

/** 检查 ollama 里有没有可用的对话模型（摘要用） */
async function hasChatModel(settings) {
  const tags = await ollamaTags(settings);
  if (!tags) return { alive: false, model: '' };
  const model = await pickLocalChatModel(settings);
  return { alive: true, model: model && tags.some(n => n === model || n.startsWith(model)) ? model : model };
}

/**
 * 拉一个摘要模型：官方源 → 国内镜像（GGUF + ollama create）。
 * 整个过程在后台跑，进度写进 modelPull，状态接口可查。
 */
async function pullSummaryModel(settings, { reason = '' } = {}) {
  if (modelPull.running) return pullSnapshot();
  modelPull = { running: true, ok: false, startedAt: Date.now(), finishedAt: 0, step: '', source: '', model: '', bytes: 0, total: 0, error: '', log: [] };
  pullLog(reason ? `开始：${reason}` : '开始拉摘要模型');

  const tags = await ollamaTags(settings);
  if (!tags) {
    modelPull.running = false;
    modelPull.finishedAt = Date.now();
    modelPull.error = '本机 ollama 没起来，拉不了模型';
    pullLog(modelPull.error);
    return pullSnapshot();
  }
  const existing = await pickLocalChatModel(settings);
  if (existing && tags.some(n => n === existing || n.startsWith(`${existing}:`) || existing.startsWith(n))) {
    modelPull.running = false;
    modelPull.finishedAt = Date.now();
    modelPull.ok = true;
    modelPull.model = existing;
    modelPull.source = '已有';
    pullLog(`已经有了：${existing}`);
    return pullSnapshot();
  }

  const cli = findOllamaCli();
  pullLog(`ollama 命令：${cli}`);

  for (const target of PULL_TARGETS) {
    // 1) 官方源
    pullLog(`试官方源：ollama pull ${target.tag}`);
    const pulled = await runCli(cli, ['pull', target.tag], { timeoutMs: 20 * 60 * 1000 });
    if (pulled.ok) {
      modelPull.ok = true;
      modelPull.model = target.tag;
      modelPull.source = 'ollama 官方源';
      pullLog(`官方源拉好了：${target.tag}`);
      break;
    }
    pullLog(`官方源没成（exit=${pulled.code}），换国内镜像`);

    // 2) 国内镜像：下 GGUF → ollama create
    const mirrors = pullMirrors();
    for (const mirror of mirrors) {
      const url = typeof mirror.url === 'function' ? mirror.url(target) : String(mirror.url || '');
      if (!url) continue;
      const label = mirror.label || mirror.id || '镜像';
      const gguf = path.join(MODEL_DIR, target.file);
      const modelFile = path.join(MODEL_DIR, `${target.tag.replace(/[:\/]/g, '-')}.Modelfile`);
      try {
        modelPull.bytes = 0;
        modelPull.total = 0;
        if (!existsSync(gguf)) {
          pullLog(`从${label}下载 ${target.file}（${target.size}）`);
          await downloadTo(url, gguf);
        } else {
          pullLog(`已经有现成的 GGUF：${target.file}`);
        }
        await fsp.mkdir(MODEL_DIR, { recursive: true });
        await fsp.writeFile(modelFile, modelfileFor(target, gguf), 'utf8');
        pullLog(`用 ollama create 装成 ${target.tag}`);
        const created = await runCli(cli, ['create', target.tag, '-f', modelFile], { timeoutMs: 10 * 60 * 1000 });
        if (!created.ok) throw new Error((created.err || created.out || `exit=${created.code}`).trim().slice(0, 200));
        modelPull.ok = true;
        modelPull.model = target.tag;
        modelPull.source = label;
        pullLog(`装好了：${target.tag}（来源 ${label}）`);
        break;
      } catch (e) {
        pullLog(`${label}失败：${String(e.message || e).slice(0, 160)}`);
      }
    }
    if (modelPull.ok) break;
  }

  if (!modelPull.ok) modelPull.error = modelPull.error || '官方源和国内镜像都没拉成（检查网络或手动 ollama pull）';
  modelPull.running = false;
  modelPull.finishedAt = Date.now();
  return pullSnapshot();
}

function startModelPull(settings, opts = {}) {
  if (modelPull.running) return pullSnapshot();
  pullSummaryModel(settings, opts).catch((e) => {
    modelPull.running = false;
    modelPull.finishedAt = Date.now();
    modelPull.error = String(e.message || e);
    pullLog(`失败：${modelPull.error}`);
  });
  return pullSnapshot();
}


let ollamaAliveCache = { at: 0, alive: false };

function ollamaBase(settings) {
  return String(settings.ctxLocalUrl || CTX_DEFAULTS.ctxLocalUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
}

function isEmbedName(name) {
  return /embed|bge|gte|minilm|rerank/i.test(String(name || ''));
}

/** 本地 ollama 有哪些模型；null = 服务没起来 */
async function ollamaTags(settings) {
  try {
    const r = await fetch(`${ollamaBase(settings)}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    const list = Array.isArray(j?.models) ? j.models.map(m => String(m.name || '')).filter(Boolean) : [];
    ollamaAliveCache = { at: now(), alive: true };
    return list;
  } catch {
    ollamaAliveCache = { at: now(), alive: false };
    return null;
  }
}

const SMALL_CHAT_HINTS = ['qwen2.5:1.5b', 'qwen2.5:0.5b', 'qwen3:1.7b', 'qwen3:0.6b', 'qwen3.5:4b', 'llama3.2:1b', 'gemma4:2b'];

/** 挑一个写摘要的本地模型：设置里指定的优先，否则按「小」的顺序猜 */
async function pickLocalChatModel(settings) {
  const want = String(settings.ctxLocalModel || '').trim();
  if (want) return want;
  const names = await ollamaTags(settings);
  if (!names || !names.length) return '';
  const chat = names.filter(n => !isEmbedName(n));
  for (const hint of SMALL_CHAT_HINTS) {
    const hit = chat.find(n => n === hint || n.startsWith(hint) || n.startsWith(hint.split(':')[0] + ':'));
    if (hit) return hit;
  }
  return chat[0] || '';
}

/** 挑一个向量模型：off/空 = 关；auto = 找名字里带 embed 的 */
async function pickEmbedModel(settings) {
  const want = String(settings.ctxEmbedModel || '').trim();
  if (!want || want === 'off') return '';
  if (want !== 'auto') return want;
  const names = await ollamaTags(settings);
  if (!names) return '';
  return names.find(n => isEmbedName(n)) || '';
}

async function ollamaChat(settings, { model, system, user, maxTokens = 700 }) {
  const m = model || (await pickLocalChatModel(settings));
  if (!m) throw new Error('本机 ollama 里没有可用的对话模型');
  const ask = async withThink => {
    const r = await fetch(`${ollamaBase(settings)}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: m,
        stream: false,
        ...(withThink ? { think: false } : {}),
        options: { temperature: 0.2, num_ctx: 16384, num_predict: maxTokens },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(300000),
    });
    return r;
  };
  // 带思考的模型（qwen3 系列等）会把正文塞进 thinking、content 留空，先要求它别思考
  let r = await ask(true);
  if (!r.ok && r.status === 400) r = await ask(false);
  if (!r.ok) throw new Error(`本地模型 HTTP ${r.status}`);
  const j = await r.json().catch(() => null);
  let text = String(j?.message?.content || '').trim();
  if (!text) {
    // 实在关不掉思考：把思考内容当摘要（去掉明显的推理前缀）
    text = String(j?.message?.thinking || '').trim();
    if (text) text = text.replace(/^(思考|Thinking)[:：]?/i, '').trim();
  }
  if (!text) throw new Error('本地模型返回了空摘要');
  return { text, model: m };
}

async function ollamaEmbed(settings, model, texts) {
  const out = [];
  const batch = 16;
  for (let i = 0; i < texts.length; i += batch) {
    const part = texts.slice(i, i + batch);
    const r = await fetch(`${ollamaBase(settings)}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: part }),
      signal: AbortSignal.timeout(300000),
    });
    if (!r.ok) throw new Error(`本地向量 HTTP ${r.status}`);
    const j = await r.json().catch(() => null);
    const vecs = Array.isArray(j?.embeddings) ? j.embeddings : [];
    if (vecs.length !== part.length) throw new Error('本地向量返回数量不对');
    out.push(...vecs);
  }
  return out;
}

// ---------------------------------------------------------------- 原文归档
// 压缩会把老消息换成摘要，原文就该留一份：data/archive/<convId>/<from>-<to>.json
// 一个压缩区间一个文件；index.json 记着这些区间和切好的片段，检索时一起参与召回。
// 这样摘要再粗，原始那句也还能被搜回来。

const archiveCache = new Map(); // convId -> { key, index }
const indexCardsCache = new Map(); // convId -> 上一轮给模型看过的记忆索引卡（「展开第 k 条」靠它）

function archiveDirOf(convId) {
  return path.join(ARCHIVE_DIR, String(convId));
}

async function readArchiveIndex(convId) {
  const j = await readJsonFile(path.join(archiveDirOf(convId), 'index.json'), null);
  if (!j || !Array.isArray(j.entries)) return { version: 1, convId, entries: [], chunks: [], embedModel: '' };
  return { version: 1, convId, chunks: [], embedModel: '', ...j };
}

async function writeArchiveIndex(convId, idx) {
  await fsp.mkdir(archiveDirOf(convId), { recursive: true });
  await writeJsonFile(path.join(archiveDirOf(convId), 'index.json'), idx);
  archiveCache.delete(convId);
}

/** 把 [from,to) 的原文落盘，并加进归档索引（有向量模型就顺手算一条区间向量） */
async function archiveRange(conv, settings, slice, from, to, engine) {
  const payload = {
    convId: conv.id,
    title: conv.title || '',
    from,
    to,
    savedAt: now(),
    engine,
    messages: slice.map(m => ({
      role: m.role,
      content: String(m.content || ''),
      ...(m.reasoning ? { reasoning: String(m.reasoning) } : {}),
      ...(m.createdAt ? { createdAt: m.createdAt } : {}),
    })),
  };
  await fsp.mkdir(archiveDirOf(conv.id), { recursive: true });
  const file = path.join(archiveDirOf(conv.id), `${from}-${to}.json`);
  await writeJsonFile(file, payload);

  const idx = await readArchiveIndex(conv.id);
  idx.entries = (idx.entries || []).filter(e => !(Number(e.from) === from && Number(e.to) === to));
  idx.chunks = (idx.chunks || []).filter(c => !(c.from >= from && c.to <= to));

  const chunks = chunkMessages(payload.messages, { maxTokens: 700, minTokens: 30 })
    .map(c => ({ from: c.from + from, to: c.to + from, tokens: c.tokens, text: c.text }));

  const entry = {
    from,
    to,
    file: path.basename(file),
    messages: slice.length,
    tokens: estimateMessagesTokens(slice),
    savedAt: payload.savedAt,
    engine,
  };

  const embedModel = await pickEmbedModel(settings).catch(() => '');
  if (embedModel) {
    try {
      const probe = payload.messages.map(m => `${m.role === 'user' ? '我' : '助手'}：${m.content.slice(0, 1200)}`).join('\n').slice(0, 6000);
      const [vec] = await ollamaEmbed(settings, embedModel, [probe]);
      if (vec && vec.length) {
        entry.vec = vec.map(v => Math.round(v * 10000) / 10000);
        idx.embedModel = embedModel;
        idx.dims = vec.length;
      }
    } catch (e) {
      log(`归档向量算失败（不影响词面检索）：${e.message}`);
    }
  }

  idx.entries.push(entry);
  idx.entries.sort((a, b) => a.from - b.from);
  idx.chunks.push(...chunks);
  idx.chunks.sort((a, b) => a.from - b.from);
  await writeArchiveIndex(conv.id, idx);
  log(`原文已归档：${path.relative(ROOT, file)}（${slice.length} 条 / ${chunks.length} 片）`);
  return entry;
}

/** 归档检索：BM25 打词面；有向量就按区间混一点语义分 */
async function retrieveArchive(conv, settings, query, { topK = 4, minScore = 0.08, weightOf } = {}) {
  const idx = await readArchiveIndex(conv.id);
  if (!idx.chunks || !idx.chunks.length) return { hits: [], index: null, indexChunks: 0 };
  const key = `${idx.chunks.length}:${idx.entries.length}`;
  let cached = archiveCache.get(conv.id);
  if (!cached || cached.key !== key) {
    const index = buildIndex(idx.chunks);
    cached = { key, index };
    archiveCache.set(conv.id, cached);
    if (archiveCache.size > 32) archiveCache.delete(archiveCache.keys().next().value);
  }
  const entryOf = from => idx.entries.find(e => e.from <= from && from <= e.to);
  let qvec = null;
  if (idx.embedModel && idx.dims) {
    try {
      const [v] = await ollamaEmbed(settings, idx.embedModel, [String(query).slice(0, 2000)]);
      if (v && v.length === idx.dims) qvec = v;
    } catch {}
  }
  const scored = retrieve({
    index: cached.index,
    query,
    topK: topK * 3,
    minScore: 0,
    weightOf: c => (weightOf ? weightOf(c) : 1),
  });
  const merged = scored.map(h => {
    const entry = entryOf(h.chunk.from);
    let score = h.score;
    if (qvec && entry?.vec) {
      const cos = Math.max(0, cosineDense(qvec, entry.vec));
      score = Math.max(score, h.score * 0.6 + cos * 0.4);
    }
    return { ...h, score, entry };
  })
    .filter(h => h.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  return { hits: merged, index: cached.index, indexChunks: idx.chunks.length, entries: idx.entries.length };
}

/** 归档目录概况（给面板显示） */
async function archiveStats(convId) {
  const idx = await readArchiveIndex(convId);
  let bytes = 0;
  for (const e of idx.entries) {
    try {
      const st = await fsp.stat(path.join(archiveDirOf(convId), e.file));
      bytes += st.size;
    } catch {}
  }
  return {
    entries: idx.entries.length,
    messages: idx.entries.reduce((s, e) => s + (e.messages || 0), 0),
    tokens: idx.entries.reduce((s, e) => s + (e.tokens || 0), 0),
    chunks: idx.chunks.length,
    bytes,
    embedModel: idx.embedModel || '',
    dims: idx.dims || 0,
    dir: path.relative(ROOT, archiveDirOf(convId)),
  };
}

/** 该用谁写摘要：设置说了算，auto 就本地优先；没模型时顺手去国内镜像拉一个 */
async function summarizerPlan(settings) {
  const mode = ['auto', 'local', 'api'].includes(settings.ctxSummarizer) ? settings.ctxSummarizer : 'auto';
  const hasKey = !!String(settings.apiKey || '').trim();
  const tags = mode === 'api' ? null : await ollamaTags(settings);
  const localModel = tags ? await pickLocalChatModel(settings) : '';
  const local = !!(tags && localModel);
  if (!local && tags && mode !== 'api' && settings.ctxAutoPull !== false) {
    startModelPull(settings, { reason: '压缩要用本机摘要模型' });
  }
  const pulling = !local && tags && mode !== 'api' && settings.ctxAutoPull !== false;
  if (mode === 'local') {
    return {
      engine: local ? 'local' : 'none', localModel, local, hasKey, pulling,
      reason: local ? '' : (pulling ? '正在从国内镜像拉本机小模型…' : '本机 ollama 没有可用模型'),
    };
  }
  if (mode === 'api') return { engine: hasKey ? 'api' : 'none', localModel, local, hasKey, pulling: false, reason: hasKey ? '' : '没填 API Key' };
  if (local) return { engine: 'local', localModel, local, hasKey, pulling: false, reason: '' };
  return {
    engine: hasKey ? 'api' : 'none', localModel, local, hasKey, pulling,
    reason: hasKey ? '' : (pulling ? '本机 ollama 没模型（正在拉），也没填 API Key' : '本机 ollama 没起来，也没填 API Key'),
  };
}

/** 会话语义切片：把 [0, upto) 的老消息压成一段记忆。本地小模型优先，失败回落 API。 */
async function compactMemory(conv, settings, history, upto, { force = false, level = 1, step = 0, rawRatio = 0 } = {}) {
  const prev = conv.memory && Number.isInteger(conv.memory.upTo) ? conv.memory : null;
  if (!force && prev && prev.upTo >= upto - 1) return { ok: true, skipped: true };
  const from = prev ? prev.upTo + 1 : 0;
  const slice = history.slice(from, upto);
  if (!slice.length) return { ok: true, skipped: true };

  const plan = await summarizerPlan(settings);
  if (plan.engine === 'none') return { ok: false, error: plan.reason === '没填 API Key' ? 'NO_KEY' : plan.reason };

  const transcript = slice
    .map(m => `${m.role === 'user' ? '我' : '助手'}：${String(m.content || '').slice(0, 6000)}`)
    .join('\n');
  // 本机小模型（1.5b 这类）喂太长会直接复述原文，给它的输入收窄到 6000 字；API 那边可以给满
  const userPrompt = plan.engine === 'local'
    ? memoryUserPrompt(prev?.text, transcript, 6000)
    : memoryUserPrompt(prev?.text, transcript);

  // 压缩前先把原文存一份（存不下来就继续，摘要本身更重要）
  let archived = null;
  if (settings.ctxArchive) {
    try {
      archived = await archiveRange(conv, settings, slice, from, upto - 1, plan.engine === 'local' ? `local:${plan.localModel}` : 'deepseek-flash');
    } catch (e) {
      log(`原文归档失败（继续写摘要）：${e.message}`);
    }
  }

  let text = '';
  let engineLabel = '';
  const warnings = [];

  const useLocal = plan.engine === 'local';
  if (useLocal) {
    try {
      const r = await ollamaChat(settings, {
        model: plan.localModel,
        system: MEMORY_SYSTEM,
        user: userPrompt,
        maxTokens: 900,
      });
      // 小模型偶尔会把提示词/原文复述回来，那不是摘要：长度接近原文、没有结论性标题，就判它不合格
      const bad = summaryLooksBad(r.text, userPrompt);
      if (bad) {
        warnings.push(`本地模型写的不像摘要（${bad}），改用 API`);
        log(`本地摘要不合格：${bad}`);
      } else {
        text = r.text;
        engineLabel = `local:${r.model}`;
      }
    } catch (e) {
      warnings.push(`本地模型失败（${e.message}），改用 API`);
      log(`本地摘要失败：${e.message}`);
    }
  }

  if (!text) {
    const apiKey = String(settings.apiKey || '').trim();
    if (!apiKey) {
      return { ok: false, error: warnings.length ? `本地模型失败：${warnings[0]}` : 'NO_KEY' };
    }
    const { chat } = apiEndpoints(settings.baseUrl);
    let upstream;
    try {
      upstream = await fetch(chat, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'deepseek-flash',
          stream: false,
          thinking: { type: 'disabled' },
          temperature: 0.3,
          max_tokens: 1500,
          messages: [
            { role: 'system', content: MEMORY_SYSTEM },
            { role: 'user', content: userPrompt },
          ],
        }),
        signal: AbortSignal.timeout(90000),
      });
    } catch (e) {
      return { ok: false, error: `请求失败：${e.message}` };
    }
    if (!upstream.ok) {
      const t = await upstream.text().catch(() => '');
      return { ok: false, error: `HTTP ${upstream.status}：${upstreamErrorText(upstream.status, t)}` };
    }
    const json = await upstream.json().catch(() => null);
    text = String(json?.choices?.[0]?.message?.content || '').trim();
    engineLabel = 'deepseek-flash';
  }
  if (!text) return { ok: false, error: '模型返回了空摘要' };

  const records = Array.isArray(prev?.records) ? prev.records.slice() : [];
  let kw = keywordsFromMessages(slice.map(m => m.content), 8);
  if (!kw.length) kw = keywordsOf(transcript, 8); // 两三条短消息凑不出共同词时，退回词频
  records.push({
    level,
    from,
    to: upto - 1,
    rawRatio: Math.round(rawRatio * 1000) / 1000,
    at: Date.now(),
    keywords: kw.join('、'),
    gist: String(text).replace(/\s+/g, ' ').slice(0, 200),
    tokens: estimateTokens(text),
    engine: engineLabel,
    forgotten: false,
    file: archived ? archived.file : '',
  });

  conv.memory = {
    text,
    upTo: upto - 1,
    coveredFrom: 0,
    coveredTo: upto - 1,
    tokens: estimateTokens(text),
    calls: (prev?.calls || 0) + 1,
    model: engineLabel,
    engine: engineLabel.startsWith('local:') ? 'local' : 'api',
    step: Math.max(Number(prev?.step || 0), step || 0),
    forgetStep: Number(prev?.forgetStep || 0),
    records,
    keywords: kw.join('、'),
    consolidated: prev?.consolidated || null,
    archive: archived
      ? { from: archived.from, to: archived.to, file: archived.file, messages: archived.messages, tokens: archived.tokens }
      : prev?.archive || null,
    updatedAt: now(),
  };
  await saveConversation(conv);
  log(
    `上下文压缩：「${conv.title}」第 ${from + 1}–${upto} 条 → ${conv.memory.tokens} token 概要` +
      `（第 ${records.length} 段｜occupied ${Math.round(rawRatio * 100)}%｜${engineLabel}｜第 ${conv.memory.calls} 次${archived ? `｜原文 ${archived.file}` : ''}）`
  );
  return { ok: true, memory: conv.memory, warnings };
}

/**
 * 第二级：占用过半后，把分段记忆按时间权重合并成一段长期记忆。
 * 早的段越简略，超过半衰期的段标记 forgotten（正文从这段记忆里消失，原文还在归档里，可被关键词再激活）。
 */
async function consolidateMemory(conv, settings, history, { rawRatio = 0, forgetStep = 0, upto = 0 } = {}) {
  const prev = conv.memory && Array.isArray(conv.memory.records) ? conv.memory : null;
  if (!prev) return { ok: true, skipped: true };
  const halfLife = clampNum(settings.ctxHalfLifeDays, 0.5, 3650, CTX_DEFAULTS.ctxHalfLifeDays);
  const total = history.length;
  const records = prev.records.map(r => {
    const m = history[r.to] || {};
    const age = messageAgeDays(conv, m, r.to, total);
    return { ...r, ageDays: Math.round(age * 10) / 10, forgotten: age > halfLife };
  });
  const alive = records.filter(r => !r.forgotten);
  if (!alive.length) return { ok: true, skipped: true };

  const plan = await summarizerPlan(settings);
  if (plan.engine === 'none') return { ok: false, error: plan.reason };

  const transcript = history
    .slice(0, Math.min(upto || history.length, history.length))
    .map(m => `${m.role === 'user' ? '我' : '助手'}：${String(m.content || '').slice(0, 1200)}`)
    .join('\n')
    .slice(0, 20000);
  const userPrompt = consolidateUserPrompt(prev.text, alive, transcript);

  let text = '';
  let engineLabel = '';
  const warnings = [];
  if (plan.engine === 'local') {
    try {
      const r = await ollamaChat(settings, { model: plan.localModel, system: CONSOLIDATE_SYSTEM, user: userPrompt, maxTokens: 800 });
      const bad = summaryLooksBad(r.text, userPrompt, { needSections: true });
      if (bad) {
        warnings.push(`本地模型写的不像概括（${bad}），改用 API`);
        log(`本地概括不合格：${bad}`);
      } else {
        text = r.text;
        engineLabel = `local:${r.model}`;
      }
    } catch (e) {
      warnings.push(`本地模型失败（${e.message}），改用 API`);
    }
  }
  if (!text) {
    const apiKey = String(settings.apiKey || '').trim();
    if (!apiKey) return { ok: false, error: warnings[0] || 'NO_KEY', warnings };
    const { chat } = apiEndpoints(settings.baseUrl);
    try {
      const upstream = await fetch(chat, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'deepseek-flash',
          stream: false,
          thinking: { type: 'disabled' },
          temperature: 0.3,
          max_tokens: 1200,
          messages: [
            { role: 'system', content: CONSOLIDATE_SYSTEM },
            { role: 'user', content: userPrompt },
          ],
        }),
        signal: AbortSignal.timeout(90000),
      });
      if (!upstream.ok) {
        const t = await upstream.text().catch(() => '');
        return { ok: false, error: `HTTP ${upstream.status}：${upstreamErrorText(upstream.status, t)}`, warnings };
      }
      const json = await upstream.json().catch(() => null);
      text = String(json?.choices?.[0]?.message?.content || '').trim();
      engineLabel = 'deepseek-flash';
    } catch (e) {
      return { ok: false, error: `请求失败：${e.message}`, warnings };
    }
  }
  if (!text) return { ok: false, error: '模型返回了空摘要', warnings };

  conv.memory = {
    ...prev,
    text,
    tokens: estimateTokens(text),
    model: engineLabel,
    engine: engineLabel.startsWith('local:') ? 'local' : 'api',
    step: Number(prev.step || 0),
    forgetStep: Math.max(Number(prev.forgetStep || 0), forgetStep),
    records,
    keywords: keywordsOf(text).join('、'),
    consolidated: {
      at: now(),
      rawRatio: Math.round(rawRatio * 1000) / 1000,
      segments: records.length,
      forgotten: records.filter(r => r.forgotten).map((r, i) => i + 1),
      tokens: estimateTokens(text),
      engine: engineLabel,
    },
    updatedAt: now(),
  };
  await saveConversation(conv);
  log(
    `记忆概括：「${conv.title}」${records.length} 段 → ${conv.memory.tokens} token 长期记忆` +
      `（占用 ${Math.round(rawRatio * 100)}%｜遗忘 ${conv.memory.consolidated.forgotten.length} 段｜${engineLabel}）`
  );
  return { ok: true, memory: conv.memory, warnings };
}

/** 把 [from, to] 这段原文捞出来（优先内存里的历史，没有就读归档 JSON） */
async function loadRangeText(conv, settings, history, from, to, maxChars = 4000) {
  const inMem = history.slice(from, to + 1).filter(m => m.role === 'user' || m.role === 'assistant');
  if (inMem.length) {
    return inMem.map(m => `${m.role === 'user' ? '我' : '助手'}：${String(m.content || '')}`).join('\n').slice(0, maxChars);
  }
  const idx = await readArchiveIndex(conv.id);
  const entry = (idx.entries || []).find(e => from >= e.from && from <= e.to);
  if (!entry) return '';
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(archiveDirOf(conv.id), entry.file), 'utf8'));
    const off = from - entry.from;
    const seg = (raw.messages || []).slice(off, off + Math.max(1, to - from + 1));
    return seg.map(m => `${m.role === 'user' ? '我' : '助手'}：${String(m.content || '')}`).join('\n').slice(0, maxChars);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- 自适应：按这一轮对话调提示词与温度
// 不猜「用户是谁」，只认这一轮的硬信号：问了什么（代码/计算/创作/事实/闲聊）、
// 对话到了多长（轮数 + 上下文 token 估算）、有没有附件、这一条是不是长材料。
const TUNE_LABELS = { code: '代码', math: '计算', creative: '创作', factual: '事实', chat: '闲聊', longform: '长文', attach: '附件', longconv: '长对话', longinput: '长材料' };
const TUNE_HINTS = {
  code: '这轮偏代码：先给能直接跑的片段（标明语言），再补关键说明；改别人的代码只贴改动的那几行。',
  math: '这轮偏推导：把中间步骤写出来，最后单独一行给结论。',
  creative: '这轮偏创作：保留具体细节和语气，别写成说明书或总结报告。',
  factual: '这轮偏事实：结论放在最前面，给出处；没把握就直接说没把握。',
  chat: '这轮是短问：直接回答，不要开场客套，也不要结尾总结段。',
  longform: '这轮要交付完整的东西：先给结构（分几块），再逐块写实，别停在提纲。',
  attach: '带了附件：先点出附件里和他问题最相关的那部分，再决定要不要展开。',
  longinput: '他贴了较长的材料：先找准他真正要问的那件事，再逐条回答，别整段复述。',
};

function adaptiveTune(settings, { history = [], tokens = 0, attachments = [] } = {}) {
  const base = Math.min(2, Math.max(0, Number(settings?.temperature ?? 1)));
  if (settings?.adaptiveTurn === false) return { on: false, base, temperature: base, tags: [], label: '', prompt: '' };

  const real = (history || []).filter(m => m && (m.role === 'user' || m.role === 'assistant'));
  const turns = real.filter(m => m.role === 'user').length;
  const lastUser = [...real].reverse().find(m => m.role === 'user');
  const text = String(typeof lastUser?.content === 'string' ? lastUser.content : '').trim();

  const codeLike = /```|\bfunction\b|\bclass\b|\bconst\b|\bimport\b|#include|报错|异常|堆栈|编译|脚本|正则|\b(npm|git|pip|python|node|sql|tsx?|jsx?|c\+\+|rust|go)\b|怎么改|为什么不|接口|api/i.test(text);
  const mathLike = /计算|求解|证明|推导|方程|积分|导数|概率|矩阵|向量|多少(分|秒|小时|天|元|公里|斤)|[\d.]+\s*[+\-*/×÷^]\s*[\d.]+/.test(text);
  const creativeLike = /写(一|个|篇|段|首|封)|小说|故事|诗|文案|歌词|剧本|台词|拟人|扮演|角色扮演|语气|润色|续写/.test(text);
  const factualLike = /新闻|最新|今天|昨天|最近|查一下|帮我查|资料|来源|引用|出处|数据|排名|是谁|什么时候|历史|事实|真的吗/.test(text);
  const longformLike = /总结|报告|方案|计划|分析|对比|梳理|大纲|提纲|论文|ppt|演讲稿|复盘|清单/.test(text);
  const shortChat = text.length > 0 && text.length <= 24 && !codeLike && !mathLike && !longformLike;

  const longConv = turns >= 12 || tokens >= 12000;
  const longInput = text.length >= 1200;
  const hasAttach = Array.isArray(attachments) && attachments.length > 0;

  let temp = base;
  const tags = [];
  const notes = [];
  const tag = (t, hint) => {
    if (!tags.includes(t)) {
      tags.push(t);
      if (hint) notes.push(hint);
    }
  };

  if (codeLike) { temp = Math.min(base, 0.35); tag('code', TUNE_HINTS.code); }
  else if (mathLike) { temp = Math.min(base, 0.3); tag('math', TUNE_HINTS.math); }
  else if (creativeLike) { temp = Math.min(1.3, base + 0.15); tag('creative', TUNE_HINTS.creative); }
  else if (factualLike) { temp = Math.min(base, 0.55); tag('factual', TUNE_HINTS.factual); }
  else if (shortChat) { temp = Math.min(base, 0.85); tag('chat', TUNE_HINTS.chat); }

  if (longformLike) tag('longform', TUNE_HINTS.longform);
  if (hasAttach) tag('attach', TUNE_HINTS.attach);
  if (longConv) {
    temp = Math.max(0.2, temp - 0.15);
    tag('longconv', `这段对话已经 ${turns} 轮、上下文约 ${Math.round(tokens / 1000)}k token：别复述背景和上面说过的细节，直接接着往下说。`);
  }
  if (longInput) {
    temp = Math.max(0.2, temp - 0.05);
    tag('longinput', TUNE_HINTS.longinput);
  }

  temp = Math.round(Math.min(2, Math.max(0, temp)) * 100) / 100;
  const label = tags.map(t => TUNE_LABELS[t] || t).join(' · ');
  const prompt = notes.length
    ? ['【这一轮的临时设定（按他的问法和对话状态自动调的，不用向用户解释）】', ...notes.map(n => `- ${n}`)].join('\n')
    : '';
  return { on: true, base, temperature: temp, tags, label, prompt };
}

/**
 * 历史消息 → API messages。
 * 装配顺序：系统提示 → 记忆摘要 → 检索到的旧片段 → 最近原文（越老越按时间降权裁剪）
 * 返回 { messages, meta }，meta 给前端显示预算占用/记忆/召回，也进 SSE 的 context 事件。
 */
async function buildMessages(conv, settings, { withTools = false } = {}) {
  const budget = clampNum(settings.ctxBudget, 4000, CTX_BUDGET_MAX, CTX_DEFAULTS.ctxBudget);
  const hotRatio = clampNum(settings.ctxHotRatio, 0.2, 0.95, CTX_DEFAULTS.ctxHotRatio);
  const halfLife = clampNum(settings.ctxHalfLifeDays, 0.5, 3650, CTX_DEFAULTS.ctxHalfLifeDays);
  const trimChars = clampNum(settings.ctxTrimChars, 60, 8000, CTX_DEFAULTS.ctxTrimChars);

  let history = conv.messages.filter(m => (m.role === 'user' || m.role === 'assistant'));
  const maxHist = Number(settings.maxHistoryMessages) || 0;
  if (maxHist > 0 && history.length > maxHist) {
    history = history.slice(-maxHist);
    while (history.length && history[0].role !== 'user') history.shift();
  }
  const total = history.length;
  const meta = {
    budget,
    tokens: 0,
    hotFrom: total,
    hotMessages: 0,
    trimmed: 0,
    dropped: 0,
    indexChunks: 0,
    memory: null,
    rag: [],
    warnings: [],
  };

  // ---- 热区：从最新往回数，累计不超过预算的 hotRatio
  const hotTarget = budget * hotRatio;
  let acc = 0;
  let hotFrom = total;
  for (let i = total - 1; i >= 0; i--) {
    const t = estimateMessageTokens(history[i]);
    if (acc + t > hotTarget && total - i >= 2) break;
    acc += t;
    hotFrom = i;
  }
  while (hotFrom < total && history[hotFrom].role !== 'user') hotFrom++;

  // ---- 记忆：覆盖 [0, hotFrom)
  let memory = conv.memory && Number.isInteger(conv.memory.upTo) ? conv.memory : null;
  const stepRatio = clampNum(settings.ctxStepRatio, 0.1, 0.9, CTX_DEFAULTS.ctxStepRatio);
  const forgetRatio = clampNum(settings.ctxForgetRatio, 0.2, 0.95, CTX_DEFAULTS.ctxForgetRatio);
  const allTokens = estimateMessagesTokens(history);
  const hotTokens = estimateMessagesTokens(history.slice(hotFrom));
  const headTokens = hotFrom > 0 && memory ? estimateMessagesTokens(history.slice(0, memory.upTo + 1)) : 0;
  const rawRatio = budget > 0 ? allTokens / budget : 0;
  const stepIdx = Math.floor(rawRatio / stepRatio + 1e-9);
  const forgetIdx = Math.floor(rawRatio / forgetRatio + 1e-9);
  if (hotFrom > 0) {
    const staleFrom = memory ? memory.upTo + 1 : 0;
    const oldTokens = Math.max(0, allTokens - hotTokens - headTokens);
    const minCompress = clampNum(settings.ctxMinCompress, 200, 100000, CTX_DEFAULTS.ctxMinCompress);
    // 第一级：占用每涨一个 step（默认 33%）就把新露出来的老消息压成一条概要，记进 records
    if (settings.ctxCompress && stepIdx > Number(memory?.step || 0) && oldTokens > 0) {
      const r = await compactMemory(conv, settings, history, hotFrom, {
        level: 1,
        step: stepIdx,
        rawRatio,
        force: oldTokens < minCompress && stepIdx - Number(memory?.step || 0) >= 2,
      });
      if (r.ok && r.memory) {
        memory = r.memory;
        for (const w of r.warnings || []) meta.warnings.push(w);
      } else if (!r.skipped) {
        meta.warnings.push(r.error === 'NO_KEY'
          ? '自动压缩已开启，但本机没有可用的小模型、也没填 API Key：写不了摘要，超出预算的老消息会直接丢掉'
          : `自动压缩失败：${r.error}`);
      }
    }
    // 第二级：占用到 forgetRatio（默认 50%）起，按时间权重把分段记忆合并成长期记忆，老段转为「遗忘」
    if (settings.ctxCompress && forgetIdx > Number(memory?.forgetStep || 0) && Array.isArray(memory?.records) && memory.records.length) {
      const r = await consolidateMemory(conv, settings, history, { rawRatio, forgetStep: forgetIdx, upto: hotFrom });
      if (r.ok && r.memory) {
        memory = r.memory;
        for (const w of r.warnings || []) meta.warnings.push(w);
      } else if (!r.skipped) {
        meta.warnings.push(`记忆概括失败：${r.error}`);
      }
    }
    if (!memory || memory.upTo < hotFrom - 1) {
      const lost = history.slice(memory ? memory.upTo + 1 : 0, hotFrom).length;
      if (lost > 0) {
        meta.dropped = lost;
        meta.warnings.push(`较早的 ${lost} 条消息超出上下文预算，这一轮没发给模型`);
      }
    }
  }
  meta.step = Number(memory?.step || 0);
  meta.forgetStep = Number(memory?.forgetStep || 0);
  meta.rawRatio = Math.round(rawRatio * 1000) / 1000;

  // ---- 向量检索：从热区之前的老消息里捞相关片段
  let ragHits = [];
  const q = [...conv.messages].reverse().find(m => m.role === 'user')?.content || '';
  const topK = Math.floor(clampNum(settings.ctxTopK, 0, 20, CTX_DEFAULTS.ctxTopK));
  const minScore = clampNum(settings.ctxRagMinScore, 0, 1, CTX_DEFAULTS.ctxRagMinScore);
  if (settings.ctxRag && hotFrom > 0) {
    const older = history.slice(0, hotFrom);
    const index = getCachedIndex(conv, older);
    meta.indexChunks = index.size;
    if (topK > 0 && q.trim()) {
      ragHits = retrieve({
        index,
        query: q,
        topK,
        minScore,
        weightOf: c => decayWeight(messageAgeDays(conv, older[c.to], c.to, older.length), halfLife),
      });
    }
  }

  // ---- 归档检索：压缩掉的原文另存了 JSON，也能被搜回来
  if (settings.ctxRag && settings.ctxArchive && topK > 0 && q.trim()) {
    try {
      const r = await retrieveArchive(conv, settings, q, {
        topK,
        minScore,
        weightOf: chunk => decayWeight(messageAgeDays(conv, history[chunk.to] || {}, chunk.to, total), halfLife),
      });
      meta.archiveChunks = r.indexChunks || 0;
      for (const h of r.hits) {
        if (ragHits.some(x => x.chunk.from === h.chunk.from && x.chunk.to === h.chunk.to)) continue;
        ragHits.push({ ...h, source: 'archive' });
      }
      ragHits.sort((a, b) => b.score - a.score);
      ragHits = ragHits.slice(0, Math.max(topK, 1));
    } catch (e) {
      log(`归档检索失败（不影响本轮）：${e.message}`);
    }
  }

  // ---- 渐进激活：高分直给片段，低分只给「记忆索引卡」，等用户说「展开第 N 条」再取原文
  const progressive = !!settings.ctxProgressive;
  const activateScore = clampNum(settings.ctxActivateScore, 0, 1, CTX_DEFAULTS.ctxActivateScore);
  const directHits = progressive ? ragHits.filter(h => h.score >= activateScore) : ragHits;
  const indexHits = progressive ? ragHits.filter(h => h.score < activateScore) : [];
  meta.progressive = progressive;
  meta.activateScore = activateScore;

  meta.rag = directHits.map(h => ({
    from: h.chunk.from,
    to: h.chunk.to,
    score: Math.round(h.score * 1000) / 1000,
    source: h.source || 'history',
    preview: h.chunk.text.slice(0, 140),
  }));
  meta.memoryIndex = indexHits.map((h, i) => ({
    k: i + 1,
    from: h.chunk.from,
    to: h.chunk.to,
    score: Math.round(h.score * 1000) / 1000,
    keywords: keywordsOf(h.chunk.text, 6).join('、'),
    gist: h.chunk.text.replace(/\s+/g, ' ').slice(0, 80),
    source: h.source || 'history',
  }));

  // 用户说「展开第 N 条 / 恢复记忆 N」→ 把那段原文捞回来注入
  // 索引卡可能来自上一轮（用户回的就是上一轮给的 k），所以留一份按会话的缓存
  if (meta.memoryIndex.length) {
    indexCardsCache.set(conv.id, meta.memoryIndex);
    if (indexCardsCache.size > 32) indexCardsCache.delete(indexCardsCache.keys().next().value);
  }
  const lastUser = [...conv.messages].reverse().find(m => m.role === 'user');
  const askK = progressive ? parseActivateRequest(lastUser?.content || '') : 0;
  const cards = meta.memoryIndex.length ? meta.memoryIndex : (indexCardsCache.get(conv.id) || []);
  let activated = null;
  if (askK > 0 && cards[askK - 1]) {
    const card = cards[askK - 1];
    meta.memoryIndex = meta.memoryIndex.length ? meta.memoryIndex : cards;
    const text = await loadRangeText(conv, settings, history, card.from, card.to);
    if (text) {
      activated = { ...card, chars: text.length, text };
      meta.activated = { k: card.k, from: card.from, to: card.to, chars: text.length };
      meta.warnings.push(`已展开记忆 #${card.k}（第 ${card.from + 1}–${card.to + 1} 条，${text.length} 字）`);
    } else {
      meta.warnings.push(`记忆 #${askK} 找不到原文了（归档里没有这一段）`);
    }
  }

  // ---- 拼消息
  const out = [];
  const ownPrompt = String(conv.systemPrompt || settings.systemPrompt || '').trim();
  // 说话口径：会话自己的选择 > QQ 会话默认走熟人语气 > 全局设置
  const isQQConv = conv.source === 'qq' || (settings.qqConvId && conv.id === settings.qqConvId);
  const style = String(conv.replyStyle || (isQQConv ? 'qq' : (settings.replyStyle || 'human')));
  // 「活人感」是给日常对话治 AI 腔用的：只留最有效的几条，长篇禁则反而会把回答捆住
  const styleParts = [];
  if (style === 'human' || style === 'qq') styleParts.push(HUMAN_STYLE_PROMPT);
  if (style === 'qq' && settings.qqStyle !== false) styleParts.push(QQ_VOICE_PROMPT);
  if (style !== 'native' && settings.antiBaGu !== false) styleParts.push(ANTI_BA_GOO_PROMPT);
  const systemPrompt = [...styleParts, ownPrompt].filter(Boolean).join('\n\n');
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
  if (style) meta.style = style;

  // 技能包：跟在系统提示词后面，单独一条，别和活人感混成一大段
  const skillText = skillsPrompt(settings);
  if (skillText) {
    out.push({ role: 'system', content: skillText });
    meta.skills = (settings.enabledSkills || []).slice();
  }

  // 群聊自学习：会话如果绑了某个群，就带上那群人说话的画像（句长/语气词/省略主语/节奏/在用的梗）
  if (settings.learnInject === true && conv.qqGid) {
    try {
      const prof = await learn.profileFor({ gid: String(conv.qqGid), maxChars: 600 });
      if (prof) {
        out.push({ role: 'system', content: prof });
        meta.learn = { gid: String(conv.qqGid), chars: prof.length };
      }
    } catch { /* 画像拿不到就当没开 */ }
  }

  // 日历：把今天 / 接下来几天的日程带上（模型能主动说「你下午三点有会」）
  if (settings.calendarInContext !== false) {
    try {
      const store = await loadCalendar();
      const days = clampNum(settings.calendarDays, 1, 30, 3);
      const text = scheduleText(store.events, new Date(), days);
      if (text) {
        out.push({ role: 'system', content: `【日程 · 本机日历】\n${text}\n（日程来自用户自己的日历；聊到时间安排时按它说，不确定就问。）` });
        meta.schedule = {
          today: eventsOn(store.events, calDateStr()).length,
          days,
          tokens: estimateTokens(text),
        };
      }
    } catch { /* 日历坏了不影响对话 */ }
  }

  if (memory && memory.text) {
    const covered = memory.upTo + 1;
    out.push({
      role: 'system',
      content: `【对话记忆 · 更早的 ${covered} 条已压缩成这段摘要，细节可能不全】\n${memory.text}`,
    });
    meta.memory = {
      upTo: memory.upTo,
      covered,
      tokens: memory.tokens || estimateTokens(memory.text),
      calls: memory.calls || 1,
      updatedAt: memory.updatedAt || 0,
      text: memory.text,
      step: Number(memory.step || 0),
      forgetStep: Number(memory.forgetStep || 0),
      keywords: String(memory.keywords || ''),
      records: Array.isArray(memory.records)
        ? memory.records.map((r, i) => ({
            n: i + 1,
            level: r.level || 1,
            from: r.from,
            to: r.to,
            rawRatio: r.rawRatio || 0,
            keywords: r.keywords || '',
            gist: r.gist || '',
            tokens: r.tokens || 0,
            engine: r.engine || '',
            forgotten: !!r.forgotten,
            at: r.at || 0,
          }))
        : [],
      consolidated: memory.consolidated || null,
    };
  }

  if (directHits.length) {
    const lines = directHits.map((h, i) => {
      const age = messageAgeDays(conv, history[h.chunk.to], h.chunk.to, total);
      const when = age < 1 ? '最近' : `${Math.round(age)} 天前`;
      return `#${i + 1}（第 ${h.chunk.from + 1}–${h.chunk.to + 1} 条 · ${when} · 相关度 ${h.score.toFixed(2)}）\n${h.chunk.text.slice(0, 900)}`;
    });
    out.push({
      role: 'system',
      content: `【检索到的旧片段】以下是从更早对话里按相关度和时间挑出来的原文，需要时对照引用，不要原样复述：\n\n${lines.join('\n\n')}`,
    });
  }

  // 记忆索引卡：只给关键词和一句话，不占正文预算；用户要细节时再说「展开第 N 条」
  if (meta.memoryIndex.length) {
    const cards = meta.memoryIndex.map(c =>
      `#${c.k} 第 ${c.from + 1}–${c.to + 1} 条 · 相关度 ${c.score.toFixed(2)} · 关键词：${c.keywords || '—'}\n   ${c.gist}`
    );
    out.push({
      role: 'system',
      content:
        `【记忆索引】可能是老对话里的相关片段，只给了线索（正文没展开）：\n\n${cards.join('\n')}\n\n` +
        '这些原文你现在没看到。如果回答确实需要其中某段细节，就告诉用户「回一句『展开第 k 条』，我就能把那段原文取回来」；不需要就别提它，也不要假装记得。',
    });
  }

  if (activated) {
    out.push({
      role: 'system',
      content: `【已展开的记忆 #${activated.k} · 第 ${activated.from + 1}–${activated.to + 1} 条原文】\n${activated.text}`,
    });
  }

  for (let i = hotFrom; i < total; i++) {
    const m = history[i];
    const age = messageAgeDays(conv, m, i, total);
    const trim = trimByAge(String(m.content || ''), age, halfLife, trimChars);
    if (trim.trimmed) meta.trimmed++;
    if (m.role === 'assistant') {
      if (!trim.text.trim() && !m.serverToolCalls) continue;
      const msg = { role: 'assistant', content: trim.text };
      if (withTools && m.reasoning) msg.reasoning_content = m.reasoning;
      if (withTools && Array.isArray(m.serverToolCalls) && m.serverToolCalls.length) msg.server_tool_calls = m.serverToolCalls;
      if (m.prefix) msg.prefix = true;
      out.push(msg);
    } else {
      const parts = [];
      for (const att of m.attachments || []) {
        if (att.kind === 'video' || att.kind === 'audio') {
          const blocks = await mediaBlocks(att);
          parts.push(...blocks);
          continue;
        }
        const block = await attachmentPayload(att, withTools);
        if (block) parts.push(block);
      }
      if (parts.length) {
        parts.push({ type: 'text', text: trim.text });
        out.push({ role: 'user', content: parts });
      } else {
        out.push({ role: 'user', content: trim.text });
      }
    }
  }

  meta.hotFrom = hotFrom;
  meta.hotMessages = total - hotFrom;
  meta.tokens = out.reduce((n, m) => n + (typeof m.content === 'string' ? estimateTokens(m.content) : 0), 0);
  return { messages: out, meta };
}

/** 上下文面板用：不发起上游请求，算一遍装配结果与索引情况 */
async function contextStatus(conv, settings) {
  const history = conv.messages.filter(m => m.role === 'user' || m.role === 'assistant');
  const budget = clampNum(settings.ctxBudget, 4000, CTX_BUDGET_MAX, CTX_DEFAULTS.ctxBudget);
  const halfLife = clampNum(settings.ctxHalfLifeDays, 0.5, 3650, CTX_DEFAULTS.ctxHalfLifeDays);
  const index = history.length ? getCachedIndex(conv, history) : buildIndex([]);
  const totalTokens = estimateMessagesTokens(history);
  const plan = await summarizerPlan(settings);
  const archive = await archiveStats(conv.id);
  return {
    budget,
    historyMessages: history.length,
    historyTokens: totalTokens,
    ratio: budget ? Math.round((totalTokens / budget) * 100) / 100 : 0,
    indexChunks: index.size,
    dims: index.dims,
    memory: (conv.memory && typeof conv.memory.text === 'string' && Number.isInteger(conv.memory.upTo)) ? {
      upTo: conv.memory.upTo,
      covered: Number(conv.memory.upTo) + 1,
      tokens: conv.memory.tokens || 0,
      calls: conv.memory.calls || 1,
      model: String(conv.memory.model || ''),
      updatedAt: conv.memory.updatedAt || 0,
      text: String(conv.memory.text || ''),
      step: Number(conv.memory.step || 0),
      forgetStep: Number(conv.memory.forgetStep || 0),
      keywords: String(conv.memory.keywords || ''),
      consolidated: conv.memory.consolidated || null,
      records: Array.isArray(conv.memory.records)
        ? conv.memory.records.map((r, i) => ({
            n: i + 1,
            level: r.level || 1,
            from: r.from,
            to: r.to,
            rawRatio: r.rawRatio || 0,
            keywords: r.keywords || '',
            gist: r.gist || '',
            tokens: r.tokens || 0,
            engine: r.engine || '',
            forgotten: !!r.forgotten,
            at: r.at || 0,
            file: r.file || '',
          }))
        : [],
    } : null,
    summarizer: {
      mode: settings.ctxSummarizer || 'auto',
      engine: plan.engine,
      localUrl: settings.ctxLocalUrl || CTX_DEFAULTS.ctxLocalUrl,
      localModel: plan.localModel || '',
      model: (conv.memory && conv.memory.model) || '',
      alive: ollamaAliveCache.alive,
      reason: plan.reason || '',
      pulling: !!plan.pulling,
      autoPull: settings.ctxAutoPull !== false,
      pull: pullSnapshot(),
    },
    archive,
    settings: {
      ctxCompress: settings.ctxCompress,
      ctxRag: settings.ctxRag,
      ctxArchive: settings.ctxArchive,
      ctxSummarizer: settings.ctxSummarizer,
      ctxLocalUrl: settings.ctxLocalUrl,
      ctxLocalModel: settings.ctxLocalModel,
      ctxEmbedModel: settings.ctxEmbedModel,
      ctxTopK: settings.ctxTopK,
      ctxHalfLifeDays: halfLife,
      ctxHotRatio: settings.ctxHotRatio,
      ctxMinCompress: settings.ctxMinCompress,
      ctxTrimChars: settings.ctxTrimChars,
      ctxStepRatio: clampNum(settings.ctxStepRatio, 0.1, 0.9, CTX_DEFAULTS.ctxStepRatio),
      ctxForgetRatio: clampNum(settings.ctxForgetRatio, 0.2, 0.95, CTX_DEFAULTS.ctxForgetRatio),
      ctxProgressive: settings.ctxProgressive !== false,
      ctxActivateScore: clampNum(settings.ctxActivateScore, 0, 1, CTX_DEFAULTS.ctxActivateScore),
    },
    progressive: {
      enabled: settings.ctxProgressive !== false,
      activateScore: clampNum(settings.ctxActivateScore, 0, 1, CTX_DEFAULTS.ctxActivateScore),
    },
    // 每个会话自己的参数：overrides 里有的键就不跟全局走
    ctx: {
      followGlobal: !Object.keys(ctxOverridesOf(conv)).length,
      overrides: ctxOverridesOf(conv),
      budgetMax: CTX_BUDGET_MAX,
    },
  };
}

async function handleChat(req, res) {
  const body = await readBody(req);
  if (!body || typeof body !== 'object') return sendJson(res, 400, { error: '缺少请求体' });

  const conv = await loadConversation(body.conversationId);
  if (!conv) return sendJson(res, 404, { error: '会话不存在' });

  const settings = await loadSettings();
  const apiKey = (body.apiKey || settings.apiKey || '').trim();
  if (!apiKey) return sendJson(res, 400, { error: '还没填 API Key：点左下角「设置」填入 DeepSeek API Key（sk-…）', code: 'NO_KEY' });

  const mode = body.mode || 'send'; // send | regenerate | edit | continue
  let userMessage = null;
  let continueBase = '';

  if (mode === 'edit') {
    const idx = conv.messages.findIndex(m => m.id === body.messageId);
    if (idx < 0) return sendJson(res, 404, { error: '要编辑的消息不存在' });
    if (conv.messages[idx].role !== 'user') return sendJson(res, 400, { error: '只能编辑自己的消息' });
    conv.messages[idx].content = String(body.content ?? '');
    conv.messages[idx].attachments = Array.isArray(body.attachments) ? body.attachments.filter(a => a && (a.uploadId || a.mediaId)) : (conv.messages[idx].attachments || []);
    conv.messages[idx].editedAt = now();
    conv.messages = conv.messages.slice(0, idx + 1);
    userMessage = conv.messages[idx];
  } else if (mode === 'regenerate') {
    while (conv.messages.length && conv.messages[conv.messages.length - 1].role === 'assistant') conv.messages.pop();
    if (!conv.messages.some(m => m.role === 'user')) return sendJson(res, 400, { error: '没有可重新生成的内容' });
  } else if (mode === 'continue') {
    const last = conv.messages[conv.messages.length - 1];
    if (!last || last.role !== 'assistant') return sendJson(res, 400, { error: '最后一条不是回答，无法继续生成' });
    if (Array.isArray(last.serverToolCalls) && last.serverToolCalls.length) {
      return sendJson(res, 400, { error: '这条回答用过联网工具，API 不支持续写' });
    }
    continueBase = String(last.content || '');
    conv.messages.pop();
  } else {
    const content = String(body.content ?? '');
    const attachments = Array.isArray(body.attachments)
      ? body.attachments.filter(a => a && (a.uploadId || a.mediaId)).map(a => {
        const mk = (a.kind === 'video' || a.kind === 'audio') ? a.kind : (a.kind === 'image' ? 'image' : 'file');
        const base = {
          kind: mk,
          name: String(a.name || '').slice(0, 200),
          mime: String(a.mime || ''),
          size: Number(a.size) || 0,
        };
        if (mk === 'video' || mk === 'audio') {
          return {
            ...base,
            mediaId: String(a.mediaId),
            duration: Number(a.duration) || 0,
            text: String(a.text || '').slice(0, 200000),
            transcript: Array.isArray(a.transcript) ? a.transcript.slice(0, 500).map(s => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || '').slice(0, 20000) })) : [],
            frames: Array.isArray(a.frames) ? a.frames.slice(0, 24).map(f => ({ time: Number(f.time) || 0, url: String(f.url || '') })) : [],
          };
        }
        return {
          ...base,
          uploadId: String(a.uploadId),
          // url 一定要存：附件气泡靠它渲染图片，只有 uploadId 的话历史里就变成一块「文件」
          url: String(a.url || `/api/uploads/${a.uploadId}`),
          ...(a.fileId ? { fileId: String(a.fileId) } : {}),
        };
      })
      : [];
    if (!content.trim() && !attachments.length) return sendJson(res, 400, { error: '消息不能为空' });
    userMessage = newMessage('user', content, attachments.length ? { attachments } : {});
    conv.messages.push(userMessage);
    if (conv.title === '新对话' || !conv.title) conv.title = autoTitle(content || attachments[0]?.name || '新对话');
  }

  const wantedModel = normalizeModel(body.model || conv.model || settings.model || 'deepseek-flash');
  let model = wantedModel;
  const autoMode = wantedModel === 'auto' && settings.autoRoute !== false;
  if (!autoMode) conv.model = model;

  let thinking = body.thinking === undefined ? !!settings.thinking : !!body.thinking;
  const effort = ['low', 'high', 'max'].includes(body.reasoningEffort) ? body.reasoningEffort : settings.reasoningEffort;
  const webSearch = mode === 'continue' ? false : (body.webSearch === undefined ? !!settings.webSearch : !!body.webSearch);
  const safetyLevel = ['off', 'low', 'high'].includes(body.safetyLevel) ? body.safetyLevel : settings.safetyLevel;
  const autoTitleOn = body.autoTitle === undefined ? !!settings.autoTitle : !!body.autoTitle;
  const lastUser = [...conv.messages].reverse().find(m => m.role === 'user');
  const lastMsgAtts = mode === 'continue' ? [] : (conv.messages[conv.messages.length - 1]?.attachments || []);

  // ---- 路由：显式「混合模式」开关优先，其次才是自动判断（手动选模型的会话不受自动路由影响）
  const forceHybrid = mode !== 'continue' && body.hybrid === true;
  let route = null;
  if (forceHybrid) {
    const mediaAtts = lastMsgAtts.some(isMediaAttachment);
    if (mediaAtts && settings.mediaTwoStage !== false) {
      const hm = normalizeModel(settings.routeHybridModel || 'deepseek-v4-pro');
      route = {
        kind: 'media',
        model: hm === 'auto' ? 'deepseek-v4-pro' : hm,
        thinking: false,
        draftModel: normalizeModel(settings.routeHybridDraftModel || 'deepseek-flash'),
        reason: '你打开了混合模式：V4.1 Flash 先扒要点（转写 + 画面），V4 Pro 按要点写正文',
      };
    } else if (lastMsgAtts.length) {
      route = {
        kind: 'vision',
        model: normalizeModel(settings.routeThinkModel || 'deepseek-flash'),
        thinking: !!thinking,
        reason: '混合模式要先出大纲，但附件只有 V4.1 Flash 能看，这条走看附件',
      };
    } else {
      const hm = normalizeModel(settings.routeHybridModel || 'deepseek-v4-pro');
      route = {
        kind: 'hybrid',
        model: hm === 'auto' ? 'deepseek-v4-pro' : hm,
        thinking: false,
        draftModel: normalizeModel(settings.routeHybridDraftModel || 'deepseek-flash'),
        reason: '你打开了混合模式：V4.1 Flash 先出大纲，V4 Pro 按大纲写正文',
      };
    }
    model = route.model;
    thinking = route.thinking;
  } else if (autoMode) {
    route = resolveRoute(settings, { text: lastUser?.content || '', thinking, attachments: lastMsgAtts, mode });
    model = route.model;
    thinking = route.thinking;
  }
  if (!MODELS.some(m => m.id === model)) model = 'deepseek-flash';
  // 对话里存着的图也算附件：看不见的模型会答「我没有读图能力」，所以这段对话有图就走能看图的
  const historyHasImage = conv.messages.some(m => Array.isArray(m.attachments) && m.attachments.some(a => a && a.kind === 'image'));
  if (historyHasImage) {
    const cur = MODELS.find(m => m.id === model);
    if (cur && cur.vision === false) {
      const vm = normalizeModel(settings.routeThinkModel || 'deepseek-flash');
      if (route) { route.kind = 'vision'; route.model = vm; route.reason = '这段对话里有图，只有 V4.1 Flash 能看'; }
      model = vm;
    }
  }
  const readLinkOn = mode !== 'continue' && !!(body.readLink === undefined ? settings.readLink : body.readLink)
    && wantedUrl(lastUser?.content);

  const linkMode = ['auto', 'api', 'local'].includes(settings.readLinkMode) ? settings.readLinkMode : 'auto';
  const localPreRead = readLinkOn && linkMode !== 'api' && settings.readLinkLocal !== false;
  const urls = localPreRead ? extractUrls(lastUser?.content, 3) : [];

  const tools = [];
  if (webSearch) tools.push({ type: 'deepseek_web_search' });
  if (readLinkOn && linkMode !== 'local') tools.push({ type: 'deepseek_read_url' });
  const withTools = tools.length > 0;

  // 上游限制：服务端工具（联网搜索 deepseek_web_search / 读链接 deepseek_read_url）只有 V4.1 Flash 支持，
  // 带 tools 用 Pro 发出去整条会被 400 拒掉 —— 这种必须换模型。
  // title（让上游起标题）也只有 Flash 支持，但不值得为它换模型：本地在 L2807 已经用 autoTitle()
  // 起好了标题，所以 Pro 上直接跳过「上游起标题」这一步，别把用户选的 Pro 偷偷换成 Flash。
  let downgraded = '';
  let upstreamTitle = autoTitleOn;
  if (model !== 'deepseek-flash') {
    if (withTools) {
      downgraded = `这一轮要用联网/读链接（服务端工具），只有 V4.1 Flash 支持，已从「${modelLabel(model)}」自动切到「${modelLabel('deepseek-flash')}」`;
      model = 'deepseek-flash';
      if (route) route.model = model;
    } else if (upstreamTitle) {
      upstreamTitle = false;
      downgraded = `「${modelLabel(model)}」不支持让上游起标题，这一轮标题先用本地摘要（想用上游标题就把模型切到「${modelLabel('deepseek-flash')}」）`;
    }
  }

  const assistant = newMessage('assistant', '', { model, streaming: true });
  if (route) {
    assistant.route = { kind: route.kind, model, reason: route.reason, thinking };
    assistant.model = model;
  }
  const startedAt = now();

  sseHead(res);
  const ac = new AbortController();
  let ended = false;
  const finish = () => { ended = true; sseEnd(res); };
  res.on('close', () => {
    if (ended) return;
    ac.abort();
  });

  sseSend(res, {
    type: 'start',
    conversationId: conv.id,
    userMessage,
    assistant: { id: assistant.id, createdAt: assistant.createdAt },
    title: conv.title,
    model,
    withTools,
    webSearch,
    thinking,
  });
  // 混合 / 音视频两段式的 route 事件要等第一遍写完，带上字数再发
  const twoStage = !!route && (route.kind === 'hybrid' || route.kind === 'media') && mode !== 'continue';
  if (route && !twoStage) {
    sseSend(res, {
      type: 'route',
      kind: route.kind,
      label: ROUTE_LABELS[route.kind] || route.kind,
      model,
      reason: route.reason,
      thinking,
      auto: !forceHybrid,
      forced: forceHybrid,
    });
  }

  // ---- 组装请求（自动压缩 + 向量检索 + 时间衰减都在这里发生）
  // 每个会话可以有自己的上下文参数（conv.ctx 覆盖全局 settings）
  const ctxSettings = ctxSettingsFor(conv, settings);
  const built = await buildMessages(conv, ctxSettings, { withTools });
  let ctx = built.messages;
  const ctxMeta = built.meta;
  if (!Array.isArray(ctxMeta.warnings)) ctxMeta.warnings = [];
  if (downgraded) {
    ctxMeta.warnings.push(downgraded);
    log(downgraded);
  }

  // ---- 自适应：按这一轮的状态临时加一段 system 提示 + 调温度（可在设置里关掉）
  const tune = adaptiveTune(ctxSettings, {
    history: conv.messages,
    tokens: Number(ctxMeta.tokens) || 0,
    attachments: lastMsgAtts,
  });
  ctxMeta.tune = { on: !!tune.on, temperature: tune.temperature, base: tune.base, label: tune.label || '', tags: tune.tags || [] };
  if (tune.on && tune.prompt) {
    ctxMeta.tune.applied = true;
    // 并进开头连续的 system 区里（最后一条），不再单开一条——
    // 两条 system 接口虽然收，但语义上本就该是同一段提示词。
    let at = 0;
    while (at < ctx.length && ctx[at] && ctx[at].role === 'system') at++;
    if (at > 0) {
      const prev = ctx[at - 1];
      const base = typeof prev.content === 'string' ? prev.content : '';
      prev.content = base ? `${base}\n\n${tune.prompt}` : tune.prompt;
    } else {
      ctx.splice(0, 0, { role: 'system', content: tune.prompt });
    }
  }
  if (tune.on) sseSend(res, { type: 'tune', ...ctxMeta.tune });

  // ---- 外链：API 的读链接工具是首选（模型自己决定要不要读、读哪一段）；
  // 本机预读是兜底：API 读不到的站（反爬 / 必须 JS 渲染）在这里先抓一遍，
  // 正文作为 system 块插到最后一条 user 之前；模型仍然可以再用工具读一次更完整的版本。
  let linkPages = [];
  if (urls.length) {
    const t0 = Date.now();
    for (const u of urls) {
      try {
        const r = await readLinkUrl(u, { allowBrowser: true });
        linkPages.push({ ...r, url: u });
      } catch (e) {
        linkPages.push({ ok: false, tier: 'none', url: u, title: '', chars: 0, text: '', ms: 0, error: String(e?.message || e) });
      }
    }
    const okPages = linkPages.filter(p => p.ok && p.chars >= 120);
    sseSend(res, {
      type: 'link',
      ms: Date.now() - t0,
      items: linkPages.map(p => ({ url: p.url, ok: !!p.ok, tier: p.tier, title: p.title, chars: p.chars, ms: p.ms, error: p.error || '', tried: p.tried || [] })),
    });
    for (const p of linkPages) {
      if (!p.ok) {
        ctxMeta.warnings.push(`本机没读到 ${p.url}：${p.error || '空内容'}（已交给 API 的读链接工具）`);
      } else if (p.chars < 120) {
        ctxMeta.warnings.push(`本机只读到 ${p.chars} 字（${p.url}），可能被登录墙挡了；已交给 API 的读链接工具`);
      }
    }
    if (okPages.length) {
      const block = linkContextBlock(okPages);
      const userIdx = ctx.map(m => m.role).lastIndexOf('user');
      if (userIdx > 0) ctx.splice(userIdx, 0, { role: 'system', content: block });
      else ctx.splice(1, 0, { role: 'system', content: block });
      ctxMeta.links = okPages.map(p => ({ url: p.url, tier: p.tier, title: p.title, chars: p.chars }));
      ctxMeta.warnings.push(`本机预读了 ${okPages.length} 个网页：${okPages.map(p => `${p.title || p.url}（${p.tier === 'browser' ? '内嵌内核' : 'HTTP'} · ${p.chars} 字）`).join('、')}`);
    }
  }
  sseSend(res, { type: 'context', ...ctxMeta, title: conv.title });
  for (const w of ctxMeta.warnings) sseSend(res, { type: 'warning', message: w });
  // ---- 两段式：混合模式 = Flash 出大纲；音视频 = Flash 先扒要点（转写 + 画面），Pro 再写正文
  if (twoStage) {
    const isMedia = route.kind === 'media';
    try {
      const draft = isMedia
        ? await draftMediaDigest(settings, apiKey, ctx, route.draftModel)
        : await draftOutline(settings, apiKey, ctx, route.draftModel);
      const userIdx = ctx.map(m => m.role).lastIndexOf('user');
      const block = isMedia
        ? [
          '【V4.1 Flash 看完这段音视频后扒出来的要点】',
          draft.text,
          '',
          '请据此写出最终回答：先把整体说清楚，再按你判断的顺序讲清关键信息；',
          '要点里提到的时间点可以保留（像 00:12 这样写），画面里的文字如果要点说看不清就不要编；',
          '不要提到「要点」「清单」「Flash」「转写」这些词，也不要照着列条目复述。',
        ].join('\n')
        : [
          '【V4.1 Flash 起草的大纲】',
          draft.text,
          '',
          '请按这份大纲把最终回答写完整：展开每一节，写成自然的段落，补上必要的细节和过渡；',
          '不要提到「大纲」「草稿」「Flash」这些词，也不要照着列条目复述大纲。',
        ].join('\n');
      if (userIdx > 0) ctx.splice(userIdx, 0, { role: 'system', content: block });
      else ctx.splice(1, 0, { role: 'system', content: block });
      if (isMedia) {
        // 第二遍是 Pro：它看不了图，把帧删掉、只留文字，画面信息已经写进要点里了
        for (const m of ctx) {
          if (!Array.isArray(m.content)) continue;
          const texts = m.content.filter(b => b && b.type === 'text' && String(b.text || '').trim());
          m.content = texts.length ? texts.map(b => b.text).join('\n\n') : '（这段媒体的画面要点见上面的清单）';
        }
      }
      route.draft = { model: route.draftModel, ms: draft.ms, chars: draft.text.length };
      assistant.route = { ...assistant.route, draft: route.draft };
      sseSend(res, { type: 'route', kind: route.kind, label: ROUTE_LABELS[route.kind], model, reason: route.reason, thinking, draft: route.draft, auto: !forceHybrid, forced: forceHybrid });
    } catch (e) {
      const msg = `${isMedia ? '要点' : '大纲'}没写出来（${String(e?.message || e).slice(0, 120)}），直接让 V4 Pro 写`;
      ctxMeta.warnings.push(msg);
      sseSend(res, { type: 'warning', message: msg });
      sseSend(res, {
        type: 'route',
        kind: route.kind,
        label: ROUTE_LABELS[route.kind] || route.kind,
        model,
        reason: route.reason,
        thinking,
        auto: true,
      });
    }
  }

  // 用户元信息（latest_reminder）：只有 deepseek-flash 认这个角色。
  // 两条硬约束（都踩过上游 400）：
  // ① 它必须紧跟最后一条 user —— 所以所有会往「最后一条 user 前面插 system」的步骤
  //    （读链接预读、两段式大纲/要点）都必须在它之前完成，否则拼出 [latest_reminder, system, user]；
  // ② v4-pro 会直接拒：The latest_reminder message is unavailable for model deepseek-v4-pro，
  //    所以两段式的第二遍（Pro 写正文）绝不能带它，一律按目标模型判断。
  const reminderModel = normalizeModel(model);
  if (reminderModel === 'deepseek-flash') {
    const reminderIdx = ctx.map(m => m.role).lastIndexOf('user');
    if (reminderIdx >= 0) {
      ctx.splice(reminderIdx, 0, { role: 'latest_reminder', content: latestReminderContent(settings) });
    }
  } else {
    // 换模型重试时可能还留着上一次塞进去的 reminder，清掉再发
    for (let i = ctx.length - 1; i >= 0; i -= 1) {
      if (ctx[i].role === 'latest_reminder') ctx.splice(i, 1);
    }
  }

  // 继续生成：最后一条 assistant 加 prefix 标记，走 beta 接口
  if (mode === 'continue') {
    ctx.push({ role: 'assistant', content: continueBase, prefix: true });
  }

  const payload = {
    model,
    messages: ctx,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (thinking) {
    payload.thinking = { type: 'enabled' };
    payload.reasoning_effort = effort;
  } else {
    payload.thinking = { type: 'disabled' };
  }
  if (withTools) payload.tools = tools;
  if (safetyLevel !== 'off') payload.safety_check = { level: safetyLevel };
  if (upstreamTitle) payload.title = { enabled: true };
  const samplingAllowed = !withTools && safetyLevel === 'off' && !upstreamTitle;
  if (samplingAllowed) payload.temperature = typeof body.temperature === 'number' ? body.temperature : (ctxMeta.tune?.on ? ctxMeta.tune.temperature : settings.temperature);

  const { chat, betaChat } = apiEndpoints(settings.baseUrl);
  const endpoint = mode === 'continue' ? betaChat : chat;

  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
  } catch (e) {
    await saveConversation(conv); // 用户消息留着，方便重试
    // fetch failed 本身没有信息量：把底层 cause（DNS / 连接重置 / 超时）一起带出来
    const cause = e?.cause
      ? [e.cause.code, e.cause.message].filter(Boolean).join(' ')
      : '';
    const detail = [e?.message || String(e), cause ? `（${cause}）` : ''].join('');
    log(`请求 ${endpoint} 失败：${detail}`);
    sseSend(res, { type: 'error', message: ac.signal.aborted ? '已停止' : `连接 API 失败：${detail}` });
    sseEnd(res);
    return;
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    const msg = upstreamErrorText(upstream.status, text);
    log(`上游返回 ${upstream.status}：${msg.slice(0, 160)}`);
    await saveConversation(conv);
    sseSend(res, { type: 'error', message: msg, status: upstream.status });
    sseEnd(res);
    return;
  }

  // ---- 解析上游 SSE
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = null;
  let reasoningText = '';
  let contentText = '';
  let finishReason = null;
  let upstreamError = null;
  let annotations = [];
  let title = '';
  const steps = []; // 流式过程中的工具步骤（final 会被完整 server_tool_calls 覆盖）
  const callIndex = new Map(); // call.id -> {step, call}

  function putCall(step, call, replace) {
    if (!call) return;
    let bucket = steps[step];
    if (!bucket) { bucket = steps[step] = { index: step, calls: [] }; }
    const key = String(call.id || `${step}:${call.index}:${call.type}`);
    const at = bucket.calls.findIndex(c => String(c.id || `${step}:${c.index}:${c.type}`) === key);
    if (at >= 0) {
      if (replace) bucket.calls[at] = call;
      else bucket.calls[at] = { ...bucket.calls[at], ...call };
    } else {
      bucket.calls.push(call);
    }
    callIndex.set(key, bucket.calls.find(c => String(c.id || `${step}:${c.index}:${c.type}`) === key));
  }

  try {
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let sep;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = parseSseBlock(block);
        if (!data || data.done) continue;
        if (data.error) { upstreamError = data.error.message || JSON.stringify(data.error); continue; }
        if (data.usage) usage = data.usage;
        const choice = data.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const ev = choice.server_tool_event;
        if (ev && ev.type) {
          if (ev.type === 'call_started' && ev.call) {
            putCall(Number(ev.step) || 0, ev.call, false);
            sseSend(res, { type: 'tool', event: 'started', step: Number(ev.step) || 0, call: ev.call });
          } else if (ev.type === 'call_completed' && ev.call) {
            putCall(Number(ev.step) || 0, ev.call, true);
            sseSend(res, { type: 'tool', event: 'completed', step: Number(ev.step) || 0, call: ev.call });
          } else if (ev.type === 'step_reasoning_done') {
            sseSend(res, { type: 'tool', event: 'step_done', step: Number(ev.step) || 0 });
          }
        }

        const d = choice.delta || {};
        // 注意：带 finish_reason 的末块可能把全量 content/reasoning 再下发一次，
        // 直接追加会和已流式累积的文本重复，这里做去重。
        if (d.reasoning_content) {
          const piece = d.reasoning_content;
          const dup = finishReason && reasoningText && (piece === reasoningText || (piece.length > 2 && reasoningText.endsWith(piece)));
          if (!dup) {
            reasoningText += piece;
            sseSend(res, { type: 'reasoning', text: piece });
          }
        }
        if (d.content) {
          let piece = d.content;
          if (finishReason && contentText) {
            if (piece === contentText) piece = '';
            else if (piece.length > contentText.length && piece.startsWith(contentText)) piece = piece.slice(contentText.length);
          }
          if (piece) {
            contentText += piece;
            sseSend(res, { type: 'content', text: piece });
          }
        }
        // 最后一个 chunk 一次性带全量工具调用、引用与标题
        if (Array.isArray(d.server_tool_calls) && d.server_tool_calls.length) {
          steps.length = 0;
          for (const s of d.server_tool_calls) steps[Number(s.index) || 0] = s;
        }
        if (Array.isArray(d.annotations)) annotations = d.annotations;
        if (typeof d.title === 'string' && d.title) title = d.title;
      }
    }
  } catch (e) {
    if (!ac.signal.aborted) upstreamError = upstreamError || e.message;
  }

  // ---- 落盘
  const durationMs = now() - startedAt;
  const fullContent = (mode === 'continue' ? continueBase : '') + contentText;
  assistant.content = fullContent;
  if (reasoningText) assistant.reasoning = reasoningText;
  assistant.model = model;
  if (usage) assistant.usage = usage;
  assistant.durationMs = durationMs;
  delete assistant.streaming;
  if (finishReason) assistant.finishReason = finishReason;
  const finalSteps = steps.filter(Boolean);
  if (finalSteps.length) assistant.serverToolCalls = finalSteps;
  if (annotations.length) assistant.annotations = annotations;
  if (thinking) assistant.thinking = { enabled: true, effort };
  if (withTools) assistant.tools = tools.map(t => t.type);
  if (ctxMeta.tune?.on) assistant.tune = { temperature: ctxMeta.tune.temperature, base: ctxMeta.tune.base, label: ctxMeta.tune.label, tags: ctxMeta.tune.tags };

  if (title) {
    conv.title = String(title).slice(0, 100);
    conv.autoTitled = true;
  }

  if (finishReason === 'content_filter') {
    conv.messages.push(assistant);
    await saveConversation(conv);
    sseSend(res, { type: 'done', message: assistant, stopped: false, conversation: summarize(conv), contentFiltered: true });
    sseEnd(res);
    return;
  }

  if (upstreamError && !contentText && !reasoningText) {
    await saveConversation(conv); // 只保留用户消息
    sseSend(res, { type: 'error', message: upstreamError });
    sseEnd(res);
    return;
  }

  if (contentText || reasoningText || finalSteps.length) conv.messages.push(assistant);
  if (!conv.messages.length && !userMessage) {
    sseEnd(res);
    return;
  }
  await saveConversation(conv);

  // 收尾事件顺序：usage → title → warning → done（done 是终结信号，必须最后）
  if (usage) sseSend(res, { type: 'usage', usage });
  if (title) sseSend(res, { type: 'title', title: conv.title });
  if (upstreamError) sseSend(res, { type: 'warning', message: upstreamError });
  sseSend(res, {
    type: 'done',
    message: assistant,
    stopped: ac.signal.aborted,
    conversation: summarize(conv),
    context: ctxMeta,
  });
  sseEnd(res);
}

function wantedUrl(text) {
  return wantsReadLink(text);
}

/**
 * 本机小模型（尤其 1.5b）偶尔会把提示词、原文、甚至「请按四段输出」这种指令复述回来。
 * 那不是摘要：判它不合格，交给 API 重写，而不是把复述塞进记忆里污染后面的对话。
 * 返回空串 = 合格；否则返回不合格的原因。
 */
function summaryLooksBad(text, prompt, { needSections = false } = {}) {
  const t = String(text || '').trim();
  if (t.length < 40) return '太短';
  if (prompt && prompt.length > 1200 && t.length > prompt.length * 0.55) return '长度接近原文';
  if (!/##|事实|决定|偏好|未完成|关键词/.test(t)) return '没有结论性小标题';
  // 长期记忆必须有「长期事实 / 关键词索引」这类分段，否则等于没整理
  if (needSections && !/(关键词索引|长期事实)/.test(t)) return '没有关键词索引或长期事实段';
  if (/以下|请按|请把|你是上下文压缩器|你是长期记忆整理器/.test(t.slice(0, 80))) return '在复述提示词';
  return '';
}

// 本机预读到的网页正文：截断后塞成一段 system，告诉模型这是哪一级拿到的、可能不全。
const LINK_BLOCK_CHARS = 2500;

function linkContextBlock(pages) {
  const parts = ['【本机预读的网页】API 的读链接工具可能没读到这些页面（反爬 / 需要 JS 渲染 / 要登录），所以本机先抓了一遍。正文可能被截断、也可能混进导航或广告。'];
  pages.forEach((p, i) => {
    const tier = p.tier === 'browser' ? '内嵌 Chromium 渲染' : 'HTTP 抓取';
    const head = `${i + 1}. 《${p.title || '无标题'}》 ${p.url}（${tier} · ${p.chars} 字${p.finalUrl && p.finalUrl !== p.url ? ` · 跳转到 ${p.finalUrl}` : ''}）`;
    parts.push(`${head}\n${String(p.text || '').slice(0, LINK_BLOCK_CHARS)}`);
  });
  parts.push('需要更完整或更权威的内容时，可以再调用 deepseek_read_url 工具读一次；引用这些内容时说明来源。');
  return parts.join('\n\n');
}

// ---------------------------------------------------------------- 业务：其它接口

/** 整包导入：一个导出压缩包拆出来的多个会话（消息可带 attachments，图片路径已由工具落到 data/media/imported-*） */
async function importBundle(res, filename, conversations, replace, extra = null) {
  const imported = [];
  const replaced = [];
  const errors = [];
  const existing = await loadIndex();

  for (const raw of conversations) {
    try {
      if (!raw || typeof raw !== 'object') { errors.push('会话格式不对'); continue; }
      const title = String(raw.title || '导入的对话').trim().slice(0, 80) || '导入的对话';
      const messages = [];
      for (const m of Array.isArray(raw.messages) ? raw.messages : []) {
        const role = normalizeRole(m.role);
        if (role !== 'user' && role !== 'assistant') continue;
        const content = String(m.content ?? '');
        const reasoning = String(m.reasoning ?? '');
        const atts = Array.isArray(m.attachments)
          ? m.attachments.filter(a => a && typeof a.url === 'string' && /^\/api\/media\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(a.url))
            .map(a => ({ kind: a.kind === 'image' ? 'image' : 'file', name: String(a.name || '').slice(0, 200), url: a.url }))
          : [];
        if (!content.trim() && !reasoning.trim() && !atts.length) continue;
        const msg = newMessage(role, content, {
          ...(reasoning ? { reasoning } : {}),
          ...(atts.length ? { attachments: atts } : {}),
        });
        const ts = Number(m.createdAt || 0);
        if (ts > 0) msg.createdAt = ts;
        messages.push(msg);
      }
      if (!messages.length) { errors.push(`${title}：没有可用消息`); continue; }

      if (replace) {
        const dup = existing.find(c => c.title === title);
        if (dup) {
          await deleteConversation(dup.id);
          replaced.push(dup.title);
        }
      }

      const createdAt = Number(raw.createdAt || 0) || messages[0]?.createdAt || now();
      const conv = newConversation({
        title,
        source: String(raw.source || (filename ? `导入：${filename}` : '导入')).slice(0, 200),
        createdAt,
        messages,
      });
      conv.updatedAt = Number(raw.updatedAt || 0) || messages[messages.length - 1]?.createdAt || createdAt;
      if (raw.pinned) conv.pinned = true;
      if (raw.systemPrompt) conv.systemPrompt = String(raw.systemPrompt).slice(0, 8000);
      await saveConversation(conv, { keepUpdatedAt: true });
      imported.push({ id: conv.id, title: conv.title, count: messages.length, createdAt });
    } catch (e) {
      errors.push(e.message);
    }
  }

  if (!imported.length) return sendJson(res, 400, { error: errors[0] || '导入失败', errors, ...(extra || {}) });
  log(`整包导入 ${imported.length} 个会话（替换 ${replaced.length} 个）：${imported.map(i => `${i.title}(${i.count})`).join('，')}`);
  sendJson(res, 200, { imported, replaced, errors, conversations: await loadIndex(), ...(extra || {}) });
}

async function handleImportPreview(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const filename = String(url.searchParams.get('name') || '拖入的文件').slice(0, 200);
  let buf;
  try {
    buf = await readBodyBuffer(req, 200 * 1024 * 1024);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  if (!buf || !buf.length) return sendJson(res, 400, { error: '空文件' });
  try {
    const preview = previewArchive(buf, filename);
    return sendJson(res, 200, {
      ok: true,
      name: filename,
      size: buf.length,
      ...preview,
      label: preview.label || KIND_LABEL[preview.kind] || preview.kind,
    });
  } catch (e) {
    return sendJson(res, 200, { ok: false, name: filename, size: buf.length, error: e.message });
  }
}

async function handleImportZip(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const filename = String(url.searchParams.get('name') || '拖入的文件').slice(0, 200);
  let buf;
  try {
    buf = await readBodyBuffer(req, 200 * 1024 * 1024);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  if (!buf || !buf.length) return sendJson(res, 400, { error: '空文件' });
  log(`收到拖入包：${filename}（${(buf.length / 1048576).toFixed(1)} MB）`);

  let organized;
  try {
    organized = organizeArchive(buf, filename, MEDIA_DIR);
  } catch (e) {
    log(`拆包失败：${filename} —— ${e.message}`);
    return sendJson(res, 400, { error: e.message });
  }
  if (!organized.conversations?.length) return sendJson(res, 400, { error: '这个包里没整理出可用内容' });
  log(`拆包完成：${organized.kind}，${organized.conversations.length} 个会话`);

  return importBundle(res, filename, organized.conversations, true, {
    kind: organized.kind,
    totals: organized.totals || null,
  });
}

async function handleImport(req, res) {
  const body = await readBody(req);
  if (!body) return sendJson(res, 400, { error: '空请求' });
  const filename = String(body.filename || '').slice(0, 200);

  // 「整包」导入：工具把官方 App 的导出压缩包拆好（含图片），按会话数组一次性交上来
  if (Array.isArray(body.conversations)) return importBundle(res, filename, body.conversations, !!body.replace);

  let data = body.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (e) { return sendJson(res, 400, { error: 'JSON 解析失败：' + e.message }); }
  }
  const rawList = Array.isArray(data) && data.every(x => x && typeof x === 'object' && !Array.isArray(x.messages) && !x.role)
    ? data : [data];

  const imported = [];
  const errors = [];
  for (const raw of rawList) {
    try {
      const { messages, systemPrompt } = normalizeExport(raw);
      if (!messages.length) { errors.push('没有可导入的消息'); continue; }
      const conv = newConversation({
        title: (raw.title && String(raw.title).slice(0, 40))
          || (filename ? path.basename(filename, path.extname(filename)).slice(0, 40) : '')
          || autoTitle(messages.find(m => m.role === 'user')?.content || '导入的对话'),
        source: filename ? `导入：${filename}` : '导入',
        systemPrompt,
        messages,
      });
      await saveConversation(conv);
      imported.push({ id: conv.id, title: conv.title, count: messages.length });
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (!imported.length) return sendJson(res, 400, { error: errors[0] || '导入失败', errors });
  log(`导入 ${imported.length} 个会话：${imported.map(i => `${i.title}(${i.count})`).join('，')}`);
  sendJson(res, 200, { imported, errors, conversations: await loadIndex() });
}

/** POST /api/upload —— 原始字节上传（前端直接把 File 当 body 发） */
async function handleUpload(req, res) {
  const settings = await loadSettings();
  if (!settings.apiKey) return sendJson(res, 400, { error: '还没填 API Key', code: 'NO_KEY' });
  const name = decodeURIComponent(String(req.headers['x-filename'] || 'file')).slice(0, 200) || 'file';
  const buf = await readBodyBuffer(req);
  if (!buf || !buf.length) return sendJson(res, 400, { error: '空文件' });
  if (buf.length > 100 * 1024 * 1024) return sendJson(res, 413, { error: '文件超过 100 MiB' });

  const ext = (path.extname(name).toLowerCase() || '.bin').replace(/[^.a-z0-9]/g, '');
  const kind = attachmentKind(name);
  const uploadId = `${uid('u')}${ext}`;
  await fsp.writeFile(path.join(UPLOAD_DIR, uploadId), buf);

  const out = {
    uploadId,
    name,
    size: buf.length,
    mime: MIME_BY_EXT[ext] || String(req.headers['content-type'] || 'application/octet-stream'),
    kind,
    url: `/api/uploads/${uploadId}`,
  };

  if (kind === 'file') {
    try {
      const j = await uploadToFilesApi(settings, buf, name);
      out.fileId = j.id;
      out.purpose = j.purpose;
    } catch (e) {
      log(`文档解析失败 ${name}：${e.message}`);
      return sendJson(res, 502, { error: `文档解析失败：${e.message}` });
    }
  }
  sendJson(res, 200, out);
}

/** POST /api/asr —— 原始 WAV 字节转发到 /v1/tools/asr */
async function handleAsr(req, res) {
  const settings = await loadSettings();
  if (!settings.apiKey) return sendJson(res, 400, { error: '还没填 API Key', code: 'NO_KEY' });
  const buf = await readBodyBuffer(req, 32 * 1024 * 1024);
  if (!buf || !buf.length) return sendJson(res, 400, { error: '没有音频数据' });
  if (buf.length > 8 * 1024 * 1024) return sendJson(res, 413, { error: '录音超过 8 MiB（约 2 分钟）' });
  const { asr } = apiEndpoints(settings.baseUrl);
  const form = buildMultipart([{ name: 'file', filename: 'speech.wav', contentType: 'audio/wav', data: buf }]);
  try {
    const r = await fetch(asr, {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': form.contentType },
      body: form.body,
      signal: AbortSignal.timeout(300000),
    });
    const text = await r.text().catch(() => '');
    if (!r.ok) return sendJson(res, r.status, { error: upstreamErrorText(r.status, text) });
    let j = {};
    try { j = JSON.parse(text); } catch { return sendJson(res, 502, { error: 'ASR 返回异常' }); }
    return sendJson(res, 200, { text: j.text || '', durationMs: j.duration_ms || 0 });
  } catch (e) {
    return sendJson(res, 502, { error: `语音识别失败：${e.message}` });
  }
}

/** POST /api/tts —— 转发到 /v1/tools/tts，把音频字节直接回给浏览器 */
async function handleTts(req, res) {
  const settings = await loadSettings();
  const body = await readBody(req) || {};
  if (!settings.apiKey) return sendJson(res, 400, { error: '还没填 API Key', code: 'NO_KEY' });
  const text = String(body.text || '').trim();
  if (!text) return sendJson(res, 400, { error: '没有可朗读的文本' });
  if (text.length > 10000) return sendJson(res, 413, { error: '文本太长（上限 10000 字符）' });
  const { tts } = apiEndpoints(settings.baseUrl);
  const payload = {
    text,
    voice_id: body.voiceId === 'tide' ? 'tide' : settings.ttsVoice === 'tide' ? 'tide' : 'stella',
    format: 'wav',
    filter_markdown: body.filterMarkdown !== false,
  };
  try {
    const r = await fetch(tts, {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300000),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return sendJson(res, r.status, { error: upstreamErrorText(r.status, t) });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, {
      'Content-Type': r.headers.get('content-type') || 'audio/wav',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch (e) {
    sendJson(res, 502, { error: `语音合成失败：${e.message}` });
  }
}

async function searchConversations(q, limit = 60) {
  const list = await loadIndex();
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return [];
  const hits = [];
  for (const item of list) {
    const conv = await loadConversation(item.id);
    if (!conv) continue;
    let perConv = 0;
    for (let i = 0; i < conv.messages.length && perConv < 3; i++) {
      const m = conv.messages[i];
      const hay = `${m.content || ''}\n${m.reasoning || ''}`.toLowerCase();
      const at = hay.indexOf(needle);
      if (at < 0) continue;
      const content = m.content || m.reasoning || '';
      const ctxStart = Math.max(0, at - 40);
      const snippet = (ctxStart > 0 ? '…' : '') + content.slice(ctxStart, at + needle.length + 60) + '…';
      hits.push({
        conversationId: conv.id,
        title: conv.title,
        messageId: m.id,
        role: m.role,
        index: i,
        inReasoning: !(m.content || '').toLowerCase().includes(needle),
        snippet,
        date: m.createdAt || conv.updatedAt,
      });
      perConv++;
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

async function stats() {
  const list = await loadIndex();
  let messages = 0, chars = 0, reasoningChars = 0, tokens = 0, imported = 0, attachments = 0;
  for (const item of list) {
    const conv = await loadConversation(item.id);
    if (!conv) continue;
    if (conv.source && conv.source.startsWith('导入')) imported++;
    for (const m of conv.messages) {
      messages++;
      chars += (m.content || '').length;
      reasoningChars += (m.reasoning || '').length;
      attachments += (m.attachments || []).length;
      if (m.usage?.total_tokens) tokens += m.usage.total_tokens;
    }
  }
  return { conversations: list.length, messages, chars, reasoningChars, tokens, importedConversations: imported, attachments };
}

function convToMarkdown(conv) {
  const lines = [`# ${conv.title}`, ''];
  lines.push(`> 从 DeepSeek API 客户端导出 · ${new Date().toLocaleString('zh-CN')} · ${conv.messages.length} 条消息`, '');
  for (const m of conv.messages) {
    if (m.role === 'user') {
      lines.push('## 你', '');
      for (const att of m.attachments || []) {
        if (att.kind === 'video' || att.kind === 'audio') {
          lines.push(`- ${att.kind === 'video' ? '🎬 视频' : '🎵 音频'}：${att.name || att.mediaId}（时长 ${fmtDuration(att.duration)}）`);
          if (String(att.text || '').trim()) {
            lines.push('', '<details><summary>转写文字</summary>', '', '```text', String(att.text).trim(), '```', '', '</details>', '');
          }
          if ((att.frames || []).length) {
            lines.push('');
            for (const f of att.frames) lines.push(`![${fmtDuration(f.time)}](${f.url})`);
            lines.push('');
          }
        } else {
          lines.push(`- 附件：${att.name || att.uploadId}`);
        }
      }
      if ((m.attachments || []).length) lines.push('');
      lines.push(m.content.trim(), '');
    } else {
      lines.push('## DeepSeek', '');
      if (m.reasoning) {
        lines.push('<details><summary>已深度思考</summary>', '', '```text', m.reasoning.trim(), '```', '', '</details>', '');
      }
      lines.push(m.content.trim(), '');
      const sources = collectSources(m);
      if (sources.length) {
        lines.push('**参考来源**', '');
        for (const s of sources) lines.push(`- [${s.title || s.url}](${s.url})`);
        lines.push('');
      }
    }
  }
  return lines.join('\n');
}

function collectSources(msg) {
  const out = [];
  const seen = new Set();
  for (const step of msg.serverToolCalls || []) {
    for (const call of step.calls || []) {
      for (const s of call.sources || []) {
        if (!s || !s.url || seen.has(s.url)) continue;
        seen.add(s.url);
        out.push(s);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- 路由

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/state' && method === 'GET') {
    const settings = await loadSettings();
    const conversations = await loadIndex();
    return sendJson(res, 200, {
      conversations,
      settings: {
        ...settings,
        apiKey: maskKey(settings.apiKey),
        hasKey: !!settings.apiKey,
      },
      models: MODELS,
      languages: LANGUAGES,
      stats: await stats(),
      version: 2,
    });
  }

  if (pathname === '/api/models' && method === 'GET') {
    return sendJson(res, 200, { models: MODELS });
  }

  // ---------------- 群聊自学习（说话画像来自真实群聊，数据只在 data/qq-learn）
  if (pathname === '/api/learn/status' && method === 'GET') {
    return sendJson(res, 200, await learn.status());
  }
  if (pathname === '/api/learn/groups' && method === 'POST') {
    try {
      const groups = await learn.refreshGroups();
      return sendJson(res, 200, { ok: true, groups });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }
  if (pathname === '/api/learn/ingest' && method === 'POST') {
    let body = {};
    try { body = await readBody(req, 64 * 1024); } catch { body = {}; }
    try {
      const r = await learn.ingest({
        gids: Array.isArray(body.gids) ? body.gids : null,
        pages: Number(body.pages) || 3,
      });
      return sendJson(res, 200, { ok: true, result: r, status: await learn.status() });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }
  if (pathname === '/api/learn/analysis' && method === 'GET') {
    const q = url.searchParams;
    return sendJson(res, 200, await learn.analysisFor({
      gid: q.get('gid') || '',
      since: Number(q.get('since')) || 0,
      until: Number(q.get('until')) || 0,
      n: Number(q.get('n')) || 6,
    }));
  }
  if (pathname === '/api/learn/settle' && method === 'POST') {
    let body = {};
    try { body = await readBody(req, 64 * 1024); } catch { body = {}; }
    const done = await learn.settle({
      gids: Array.isArray(body.gids) ? body.gids : null,
      force: body.force === true,
    });
    return sendJson(res, 200, { ok: true, settled: done, weeks: learn.listWeeks().slice(0, 12) });
  }
  if (pathname === '/api/learn/weeks' && method === 'GET') {
    return sendJson(res, 200, { weeks: learn.listWeeks({ gid: url.searchParams.get('gid') || '' }) });
  }
  if (pathname === '/api/learn/week' && method === 'GET') {
    const gid = url.searchParams.get('gid') || '';
    const week = url.searchParams.get('week') || '';
    const md = gid && week ? learn.weekMarkdown(gid, week) : null;
    if (!md) return sendJson(res, 404, { error: '这一周的周报还没结算' });
    return sendJson(res, 200, { gid, week, markdown: md });
  }
  if (pathname === '/api/learn/profile' && method === 'GET') {
    const md = await learn.profileFor({
      gid: url.searchParams.get('gid') || '',
      maxChars: Number(url.searchParams.get('max')) || 600,
    });
    return sendJson(res, 200, { profile: md });
  }

  // ---------------- 技能包（skills/<id>/SKILL.md）
  if (pathname === '/api/skills' && method === 'GET') {
    const settings = await loadSettings();
    const enabled = new Set(Array.isArray(settings.enabledSkills) ? settings.enabledSkills : []);
    return sendJson(res, 200, {
      dir: SKILLS_DIR,
      skills: listSkills().map(s => ({ ...s, file: s.file, enabled: enabled.has(s.id) })),
    });
  }

  // 粘贴一段 SKILL.md 就装：{ name?, id?, content }
  if (pathname === '/api/skills' && method === 'POST') {
    let body = null;
    try {
      body = await readBody(req, 8 * 1024 * 1024);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    const content = typeof body === 'object' && body ? String(body.content || '') : String(body || '');
    if (!content.trim()) return sendJson(res, 400, { error: '内容是空的——把 SKILL.md 全文贴进来' });
    if (content.length > SKILL_FILE_LIMIT) return sendJson(res, 400, { error: '单个技能文件上限 2 MB' });
    let r;
    try {
      r = installSkillFiles([{ rel: 'SKILL.md', data: Buffer.from(content, 'utf8') }], {
        id: body && body.id ? String(body.id) : '',
        name: body && body.name ? String(body.name) : '',
      });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    const settings = await loadSettings();
    const arr = Array.isArray(settings.enabledSkills) ? settings.enabledSkills.slice() : [];
    if (!arr.includes(r.id)) arr.push(r.id);
    const next = await saveSettings({ enabledSkills: arr });
    log(`技能装好：${r.id}（${r.files} 个文件）`);
    return sendJson(res, 200, { ok: true, ...r, enabledSkills: next.enabledSkills });
  }

  // 拖文件：单 .md / .zip / 多文件（multipart，filename 里可以带相对路径）
  if (pathname === '/api/skills/upload' && method === 'POST') {
    const url = new URL(req.url, 'http://127.0.0.1');
    let buf;
    try {
      buf = await readBodyBuffer(req, 64 * 1024 * 1024);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    if (!buf || !buf.length) return sendJson(res, 400, { error: '空文件' });
    const ctype = String(req.headers['content-type'] || '');
    let files = [];
    let name = String(url.searchParams.get('name') || '');
    try {
      if (ctype.includes('multipart/form-data')) {
        const parts = parseMultipart(buf, ctype);
        files = parts.filter(p => p.filename).map(p => ({ rel: p.filename, data: p.data }));
        if (!files.length) return sendJson(res, 400, { error: '没收到文件' });
      } else {
        const got = skillFilesFromUpload(buf, name || 'SKILL.md');
        files = got.files;
        name = got.name;
      }
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    let r;
    try {
      r = installSkillFiles(files, { name });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    const settings = await loadSettings();
    const arr = Array.isArray(settings.enabledSkills) ? settings.enabledSkills.slice() : [];
    if (!arr.includes(r.id)) arr.push(r.id);
    const next = await saveSettings({ enabledSkills: arr });
    log(`收到技能包：${name || '(未命名)'} → ${r.id}（${r.files} 个文件）`);
    return sendJson(res, 200, { ok: true, ...r, enabledSkills: next.enabledSkills });
  }

  // 启用 / 停用
  if (pathname === '/api/skills/enable' && method === 'POST') {
    const body = (await readBody(req)) || {};
    const id = String(body.id || '');
    if (!listSkills().some(s => s.id === id)) return sendJson(res, 404, { error: `没有这个技能：${id}` });
    const settings = await loadSettings();
    const arr = new Set(Array.isArray(settings.enabledSkills) ? settings.enabledSkills : []);
    if (body.enabled === false) arr.delete(id); else arr.add(id);
    const next = await saveSettings({ enabledSkills: [...arr] });
    return sendJson(res, 200, { ok: true, enabledSkills: next.enabledSkills });
  }

  // 删除（只动 skills/ 下面的目录）
  if (pathname === '/api/skills/delete' && method === 'POST') {
    const body = (await readBody(req)) || {};
    const id = String(body.id || '');
    let dir;
    try {
      dir = skillDirOf(id);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    if (!existsSync(path.join(dir, 'SKILL.md'))) return sendJson(res, 404, { error: `没有这个技能：${id}` });
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      return sendJson(res, 500, { error: `删不掉：${e.message}` });
    }
    const settings = await loadSettings();
    const arr = (Array.isArray(settings.enabledSkills) ? settings.enabledSkills : []).filter(x => x !== id);
    const next = await saveSettings({ enabledSkills: arr });
    log(`技能删掉：${id}`);
    return sendJson(res, 200, { ok: true, id, enabledSkills: next.enabledSkills });
  }

  // ---------------- 日历
  if (pathname === '/api/calendar' && method === 'GET') {
    return sendJson(res, 200, await calendarState());
  }

  if (pathname === '/api/calendar' && method === 'POST') {
    const body = await readBody(req) || {};
    if (!String(body.title || '').trim()) return sendJson(res, 400, { error: '标题不能为空' });
    if (body.date && !calParseDate(String(body.date))) return sendJson(res, 400, { error: `日期不合法：${body.date}` });
    let ev;
    try {
      ev = makeEvent(body, calId);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    const store = await loadCalendar();
    store.events.push(ev);
    await saveCalendar(store);
    return sendJson(res, 200, { ok: true, event: ev, ...(await calendarState()) });
  }

  if (pathname.startsWith('/api/calendar/') && (method === 'PATCH' || method === 'DELETE')) {
    const id = pathname.slice('/api/calendar/'.length);
    const store = await loadCalendar();
    const i = store.events.findIndex(e => e.id === id);
    if (i < 0) return sendJson(res, 404, { error: '没有这条日程' });
    if (method === 'DELETE') {
      const [gone] = store.events.splice(i, 1);
      await saveCalendar(store);
      return sendJson(res, 200, { ok: true, deleted: gone.id, ...(await calendarState()) });
    }
    const body = await readBody(req) || {};
    try {
      store.events[i] = patchEvent(store.events[i], body);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    await saveCalendar(store);
    return sendJson(res, 200, { ok: true, event: store.events[i], ...(await calendarState()) });
  }

  // ---------------- QQ 通道
  if (pathname === '/api/qq/state' && method === 'GET') {
    const st = await qqStatus();
    if (st.mode !== 'off' && (st.uid || st.group)) {
      try {
        const info = await loginInfo(effQqConfig(await loadSettings()));
        qqState.info = info;
        st.info = info;
      } catch (e) {
        st.lastError = e.message;
      }
    }
    return sendJson(res, 200, st);
  }

  if (pathname === '/api/qq/test' && method === 'POST') {
    try {
      const cfg = effQqConfig(await loadSettings());
      const info = await loginInfo(cfg);
      qqState.info = info;
      return sendJson(res, 200, { ok: !!info.ok, info, baseUrl: cfg.baseUrl });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (pathname === '/api/qq/send' && method === 'POST') {
    const body = await readBody(req) || {};
    const text = String(body.text || '').trim();
    if (!text) return sendJson(res, 400, { error: '内容不能为空' });
    try {
      return sendJson(res, 200, await qqSendText(text));
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // 选一个对话当 QQ 的回话会话（'' / 'new' = 新建一个）
  if (pathname === '/api/qq/bind' && method === 'POST') {
    const body = await readBody(req) || {};
    try {
      const r = await qqBindConversation(body.convId);
      return sendJson(res, 200, { ...r, status: await qqStatus() });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (pathname === '/api/qq/poll' && method === 'POST') {
    try {
      const r = await qqPollOnce({ reply: true });
      return sendJson(res, 200, { ok: true, ...r, status: await qqStatus() });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // ---------------- NapCat：状态 / 启动 / 二维码
  if (pathname === '/api/napcat' && method === 'GET') {
    return sendJson(res, 200, await napcatStatus(await loadSettings()));
  }

  if (pathname === '/api/napcat/qr' && method === 'GET') {
    return sendJson(res, 200, await napcatQrOnly(await loadSettings()));
  }

  if (pathname === '/api/napcat/restart' && method === 'POST') {
    try {
      return sendJson(res, 200, await restartNapcat(await loadSettings()));
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (pathname === '/api/napcat/start' && method === 'POST') {
    try {
      return sendJson(res, 200, await startNapcat(await loadSettings()));
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  // 隔离实例（C++ 宿主）：状态 / 启动 / 停止 / 取码
  if (pathname === '/api/napcat/host' && method === 'GET') {
    return sendJson(res, 200, await napcatHostState(await loadSettings()));
  }

  if (pathname === '/api/napcat/host/start' && method === 'POST') {
    const st = await napcatHostRun(await loadSettings(), 'start');
    return sendJson(res, st.ok ? 200 : 400, st);
  }

  if (pathname === '/api/napcat/host/stop' && method === 'POST') {
    const st = await napcatHostRun(await loadSettings(), 'stop');
    return sendJson(res, st.ok ? 200 : 400, st);
  }

  // 自动纠错：GET 看最近一轮结论，POST 手动立刻跑一轮（force）
  if (pathname === '/api/napcat/heal' && method === 'GET') {
    return sendJson(res, 200, { ok: true, state: healState });
  }

  if (pathname === '/api/napcat/heal' && method === 'POST') {
    try {
      return sendJson(res, 200, await napcatHealOnce({ force: true }));
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  // 推送：允许应用主动往 QQ 推一条（权限门 pushEnabled）
  if (pathname === '/api/push' && method === 'POST') {
    const body = await readBody(req) || {};
    try {
      return sendJson(res, 200, await pushSend({ text: body.text, uid: body.uid, group: body.group, kind: body.kind || 'manual' }));
    } catch (e) {
      return sendJson(res, e.code === 'PUSH_OFF' ? 403 : 400, { ok: false, error: e.message, code: e.code || '' });
    }
  }

  if (pathname === '/api/channels' && method === 'GET') {
    return sendJson(res, 200, await channelsState());
  }

  // 从 dsh-qq-bridge 的配置里只读 3 个非敏感字段（地址 / 私聊号 / 群号），默认不落盘
  if (pathname === '/api/qq/import-config' && method === 'POST') {
    const body = await readBody(req) || {};
    const p = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'qq-bridge-config.json');
    let raw;
    try {
      raw = JSON.parse(await fsp.readFile(p, 'utf8'));
    } catch (e) {
      return sendJson(res, 404, { ok: false, error: `没读到插件配置（${p}）：${e.message}` });
    }
    const pick = (...keys) => {
      for (const k of keys) {
        const v = raw[k];
        if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
      }
      return '';
    };
    const found = {
      baseUrl: pick('NapCat', 'napcat', 'baseUrl'),
      uid: pick('私聊QQ', 'qq', 'uid').replace(/[^\d]/g, ''),
      group: pick('群号', 'group').replace(/[^\d]/g, ''),
      callName: pick('称呼', 'callName'),
      from: p,
    };
    if (!body.apply) return sendJson(res, 200, { ok: true, applied: false, found });
    const patch = { qqBaseUrl: found.baseUrl || undefined, qqUid: found.uid || undefined, qqGroup: found.group || undefined, qqCallName: found.callName || undefined };
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
    const s = await saveSettings(patch);
    return sendJson(res, 200, { ok: true, applied: true, found, settings: { ...s, apiKey: maskKey(s.apiKey), hasKey: !!s.apiKey } });
  }

  // 只允许本机关闭（桌面窗口里的「退出」按钮、启动脚本、node server.mjs --stop 都用它）
  if (pathname === '/api/shutdown' && method === 'POST') {
    const from = req.socket.remoteAddress || '';
    if (!/^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(from)) {
      return sendJson(res, 403, { error: '只允许本机关闭' });
    }
    sendJson(res, 200, { ok: true, pid: process.pid });
    log('收到关闭请求，正在退出。');
    stopQQBridge();
    setTimeout(async () => {
      try { await fsp.unlink(RUNTIME_FILE); } catch {}
      process.exit(0);
    }, 300);
    return;
  }

  if (pathname === '/api/settings') {
    if (method === 'GET') {
      const s = await loadSettings();
      return sendJson(res, 200, { ...s, apiKey: maskKey(s.apiKey), hasKey: !!s.apiKey });
    }
    if (method === 'PUT' || method === 'POST') {
      const body = await readBody(req) || {};
      // 掩码原样传回来时不要覆盖真实 Key
      if (typeof body.apiKey === 'string' && body.apiKey.includes('…')) delete body.apiKey;
      if (body.apiKey === '' && body.keepKey) delete body.apiKey;
      const s = await saveSettings(body);
      return sendJson(res, 200, { ...s, apiKey: maskKey(s.apiKey), hasKey: !!s.apiKey });
    }
  }

  if (pathname === '/api/settings/test' && method === 'POST') {
    const body = await readBody(req) || {};
    const s = await loadSettings();
    const key = String(body.apiKey && !String(body.apiKey).includes('…') ? body.apiKey : s.apiKey || '').trim();
    if (!key) return sendJson(res, 400, { error: '没有 API Key' });
    try {
      const data = await listModels({ ...s, apiKey: key, baseUrl: body.baseUrl || s.baseUrl });
      const models = (data.data || []).map(m => m.id).filter(Boolean);
      return sendJson(res, 200, { ok: true, models });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (pathname === '/api/conversations' && method === 'POST') {
    const body = await readBody(req) || {};
    const conv = newConversation({ title: body.title || '新对话', model: body.model || '' });
    await saveConversation(conv);
    return sendJson(res, 200, { conversation: conv, conversations: await loadIndex() });
  }

  const mConv = pathname.match(/^\/api\/conversations\/([A-Za-z0-9_-]+)(?:\/(.*))?$/);
  if (mConv) {
    const id = mConv[1];
    const rest = mConv[2] || '';
    const conv = await loadConversation(id);
    if (!conv) return sendJson(res, 404, { error: '会话不存在' });

    if (!rest && method === 'GET') return sendJson(res, 200, { conversation: conv });
    if (!rest && method === 'PATCH') {
      const body = await readBody(req) || {};
      if (typeof body.title === 'string') conv.title = body.title.trim().slice(0, 80) || conv.title;
      if (typeof body.pinned === 'boolean') conv.pinned = body.pinned;
      if (typeof body.systemPrompt === 'string') conv.systemPrompt = body.systemPrompt;
      if (typeof body.model === 'string' && body.model) conv.model = body.model;
      // 每个会话自己的说话口径：'' = 跟随设置；native/human/qq/custom 见 buildMessages
      if (typeof body.replyStyle === 'string') {
        const v = body.replyStyle.trim();
        if (['native', 'human', 'qq', 'custom'].includes(v)) conv.replyStyle = v;
        else delete conv.replyStyle;
      }
      // 每个会话自己的上下文参数：传 {} 或 null = 全部改回跟随全局
      if ('ctx' in body) {
        const ov = normalizeCtxOverrides(body.ctx);
        if (Object.keys(ov).length) conv.ctx = ov;
        else delete conv.ctx;
      }
      await saveConversation(conv);
      return sendJson(res, 200, { conversation: conv, conversations: await loadIndex() });
    }
    if (!rest && method === 'DELETE') {
      await deleteConversation(id);
      return sendJson(res, 200, { ok: true, conversations: await loadIndex() });
    }

    if (rest === 'export' && method === 'GET') {
      const format = url.searchParams.get('format') || 'md';
      if (format === 'json') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(conv.title + '.json')}`,
        });
        return res.end(JSON.stringify({ title: conv.title, messages: conv.messages }, null, 2));
      }
      const md = convToMarkdown(conv);
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(conv.title + '.md')}`,
      });
      return res.end(md);
    }

    const mMsg = rest.match(/^messages\/([A-Za-z0-9_-]+)$/);
    if (mMsg && method === 'DELETE') {
      const mid = mMsg[1];
      const idx = conv.messages.findIndex(m => m.id === mid);
      if (idx < 0) return sendJson(res, 404, { error: '消息不存在' });
      const target = conv.messages[idx];
      const next = conv.messages[idx + 1];
      conv.messages.splice(idx, (target.role === 'user' && next && next.role === 'assistant') ? 2 : 1);
      await saveConversation(conv);
      return sendJson(res, 200, { conversation: conv, conversations: await loadIndex() });
    }

    if (rest === 'fork' && method === 'POST') {
      const body = await readBody(req) || {};
      const upto = conv.messages.findIndex(m => m.id === body.messageId);
      const msgs = (upto >= 0 ? conv.messages.slice(0, upto + 1) : conv.messages).map(m => ({ ...m, id: uid('m') }));
      const fork = newConversation({
        title: conv.title + '（分支）',
        source: '分支自 ' + conv.title,
        model: conv.model,
        systemPrompt: conv.systemPrompt,
        messages: msgs,
      });
      await saveConversation(fork);
      return sendJson(res, 200, { conversation: fork, conversations: await loadIndex() });
    }

    // ---- 上下文与记忆
    if (rest === 'context' && method === 'GET') {
      const settings = ctxSettingsFor(conv, await loadSettings());
      return sendJson(res, 200, await contextStatus(conv, settings));
    }

    if (rest === 'context/compact' && method === 'POST') {
      const settings = ctxSettingsFor(conv, await loadSettings());
      const history = conv.messages.filter(m => m.role === 'user' || m.role === 'assistant');
      if (history.length < 2) return sendJson(res, 400, { error: '消息太少，没什么可压的' });
      const upto = history.length - 1; // 最后一条留原文
      const r = await compactMemory(conv, settings, history, upto, { force: true });
      if (!r.ok) {
        return sendJson(res, 400, {
          error: r.error === 'NO_KEY' ? '本机没有可用的小模型、也没填 API Key，压不了（摘要得模型写）' : r.error,
          code: r.error === 'NO_KEY' ? 'NO_KEY' : 'COMPACT_FAILED',
        });
      }
      return sendJson(res, 200, { ok: true, memory: conv.memory, warnings: r.warnings || [], ...(await contextStatus(conv, settings)) });
    }

    // 记忆整合：把分段记忆按时间权重合并成一段长期记忆（早的段只留关键词，原文还在归档里）
    if (rest === 'context/consolidate' && method === 'POST') {
      const settings = ctxSettingsFor(conv, await loadSettings());
      const history = conv.messages.filter(m => m.role === 'user' || m.role === 'assistant');
      if (!history.length) return sendJson(res, 400, { error: '这个会话还没有消息' });
      if (!conv.memory || !Array.isArray(conv.memory.records) || !conv.memory.records.length) {
        return sendJson(res, 400, { error: '还没有分段记忆：先压一次（自动或手动），再整合', code: 'NO_RECORDS' });
      }
      const before = Number(conv.memory.tokens || 0);
      const curStep = Number(conv.memory.forgetStep || 0);
      const r = await consolidateMemory(conv, settings, history, {
        rawRatio: 0,
        forgetStep: curStep + 1,
        upto: history.length,
      });
      if (!r.ok) {
        return sendJson(res, 400, {
          error: r.error === 'NO_KEY' ? '本机没有可用的小模型、也没填 API Key，整合不了（概括得模型写）' : r.error,
          code: r.error === 'NO_KEY' ? 'NO_KEY' : 'CONSOLIDATE_FAILED',
        });
      }
      return sendJson(res, 200, {
        ok: true,
        skipped: !!r.skipped,
        before,
        after: Number(conv.memory.tokens || 0),
        forgotten: (conv.memory.consolidated && conv.memory.consolidated.forgotten) || [],
        segments: (conv.memory.records || []).length,
        engine: conv.memory.model || '',
        warnings: r.warnings || [],
        ...(await contextStatus(conv, settings)),
      });
    }

    if (rest === 'context/reset' && method === 'POST') {
      delete conv.memory;
      dropCachedIndex(conv.id);
      await saveConversation(conv);
      const settings = ctxSettingsFor(conv, await loadSettings());
      return sendJson(res, 200, { ok: true, ...(await contextStatus(conv, settings)) });
    }

    if (rest === 'context/preview' && method === 'POST') {
      const body = await readBody(req) || {};
      const settings = ctxSettingsFor(conv, await loadSettings());
      const history = conv.messages.filter(m => m.role === 'user' || m.role === 'assistant');
      const q = String(body.query || '').trim()
        || [...history].reverse().find(m => m.role === 'user')?.content
        || '';
      if (!history.length) return sendJson(res, 200, { query: q, hits: [] });
      const halfLife = clampNum(settings.ctxHalfLifeDays, 0.5, 3650, CTX_DEFAULTS.ctxHalfLifeDays);
      const index = getCachedIndex(conv, history);
      const topK = Math.floor(clampNum(body.topK ?? settings.ctxTopK, 1, 20, 5));
      const minScore = clampNum(settings.ctxRagMinScore, 0, 1, CTX_DEFAULTS.ctxRagMinScore);
      const hits = retrieve({
        index,
        query: q,
        topK,
        minScore,
        weightOf: c => decayWeight(messageAgeDays(conv, history[c.to], c.to, history.length), halfLife),
      });
      // 归档里的原文也算命中（压缩掉的旧对话）
      let archiveHits = [];
      if (settings.ctxArchive) {
        try {
          const r = await retrieveArchive(conv, settings, q, {
            topK,
            minScore,
            weightOf: chunk => decayWeight(messageAgeDays(conv, history[chunk.to] || {}, chunk.to, history.length), halfLife),
          });
          archiveHits = r.hits.filter(h => !hits.some(x => x.chunk.from === h.chunk.from && x.chunk.to === h.chunk.to));
        } catch (e) {
          log(`归档预览检索失败：${e.message}`);
        }
      }
      const merged = [
        ...hits.map(h => ({ h, source: 'history' })),
        ...archiveHits.map(h => ({ h, source: 'archive' })),
      ].sort((a, b) => b.h.score - a.h.score).slice(0, topK);
      const archive = await archiveStats(conv.id);
      return sendJson(res, 200, {
        query: q,
        minScore,
        chunks: index.size,
        archiveChunks: archive.chunks,
        archiveEntries: archive.entries,
        embedModel: archive.embedModel,
        hits: merged.map(({ h, source }) => {
          const ageDays = messageAgeDays(conv, history[h.chunk.to] || {}, h.chunk.to, history.length);
          return {
            from: h.chunk.from,
            to: h.chunk.to,
            tokens: h.chunk.tokens,
            score: Math.round(h.score * 1000) / 1000,
            ageDays: Math.round(ageDays * 10) / 10,
            weight: Math.round(decayWeight(ageDays, halfLife) * 1000) / 1000,
            source,
            text: h.chunk.text.slice(0, 600),
          };
        }),
      });
    }

    if (rest === 'context/activate' && method === 'POST') {
      const body = await readBody(req) || {};
      const settings = await loadSettings();
      const history = conv.messages.filter(m => m.role === 'user' || m.role === 'assistant');
      const from = Math.max(0, Math.floor(Number(body.from) || 0));
      const to = Math.min(history.length - 1, Math.floor(Number(body.to ?? body.from) || 0));
      if (to < from) return sendJson(res, 400, { error: '区间不对' });
      const text = await loadRangeText(conv, settings, history, from, to, 6000);
      if (!text) return sendJson(res, 404, { error: '这段原文找不到了（归档里也没有）' });
      return sendJson(res, 200, { ok: true, from, to, chars: text.length, text });
    }

    if (rest === 'archive' && method === 'GET') {
      const idx = await readArchiveIndex(conv.id);
      const stats = await archiveStats(conv.id);
      return sendJson(res, 200, {
        ...stats,
        list: idx.entries.map(e => ({
          from: e.from,
          to: e.to,
          file: e.file,
          messages: e.messages,
          tokens: e.tokens,
          savedAt: e.savedAt,
          engine: e.engine,
          hasVec: !!e.vec,
        })),
      });
    }
  }

  if (pathname === '/api/chat' && method === 'POST') {
    return withLock('chat', () => handleChat(req, res));
  }

  if (pathname === '/api/import' && method === 'POST') return handleImport(req, res);
  if (pathname === '/api/import/preview' && method === 'POST') return handleImportPreview(req, res);
  if (pathname === '/api/import/zip' && method === 'POST') return handleImportZip(req, res);
  if (pathname === '/api/upload' && method === 'POST') return handleUpload(req, res);
  if (pathname === '/api/media' && method === 'POST') return handleMedia(req, res);
  if (pathname === '/api/asr' && method === 'POST') return handleAsr(req, res);
  if (pathname === '/api/tts' && method === 'POST') return handleTts(req, res);

  const mMedia = pathname.match(/^\/api\/media\/([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_.-]+))?$/);
  if (mMedia && method === 'GET') {
    if (mMedia[2]) return serveMediaFile(res, mMedia[1], mMedia[2]);
    const meta = await readMediaMeta(mMedia[1]);
    if (!meta) return sendJson(res, 404, { error: '没有这个媒体' });
    return sendJson(res, 200, meta);
  }

  const mUp = pathname.match(/^\/api\/uploads\/([A-Za-z0-9_.-]+)$/);
  if (mUp && method === 'GET') {
    const got = await readUpload(mUp[1]);
    if (!got) return sendText(res, 404, 'Not found');
    const ext = path.extname(got.file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_BY_EXT[ext] || 'application/octet-stream', 'Cache-Control': 'private, max-age=86400' });
    return res.end(got.data);
  }

  if (pathname === '/api/search' && method === 'GET') {
    const q = url.searchParams.get('q') || '';
    return sendJson(res, 200, { hits: await searchConversations(q), query: q });
  }

  if (pathname === '/api/context/summary-test' && method === 'POST') {
    const settings = await loadSettings();
    const plan = await summarizerPlan(settings);
    if (plan.engine === 'local') {
      const t0 = Date.now();
      try {
        const r = await ollamaChat(settings, {
          model: plan.localModel,
          system: '你是一个摘要器，只输出要点，不要寒暄。',
          user: '把这句话压缩成一条要点：用户希望回答尽量短，代码注释用中文。',
          maxTokens: 120,
        });
        return sendJson(res, 200, { ok: true, engine: 'local', model: r.model, ms: Date.now() - t0, sample: r.text.slice(0, 300) });
      } catch (e) {
        return sendJson(res, 200, { ok: false, engine: 'local', model: plan.localModel, error: e.message });
      }
    }
    return sendJson(res, 200, {
      ok: plan.engine === 'api',
      engine: plan.engine,
      model: plan.engine === 'api' ? 'deepseek-flash' : '',
      error: plan.reason || '',
    });
  }

  if (pathname === '/api/context/model-pull' && method === 'GET') {
    return sendJson(res, 200, pullSnapshot());
  }

  if (pathname === '/api/context/model-pull' && method === 'POST') {
    const settings = await loadSettings();
    return sendJson(res, 200, startModelPull(settings, { reason: '手动拉一个摘要模型' }));
  }

  if (pathname === '/api/local-models' && method === 'GET') {
    const settings = await loadSettings();
    const list = await ollamaTags(settings);
    const sizes = new Map();
    if (Array.isArray(list)) {
      try {
        const r = await fetch(`${ollamaBase(settings)}/api/tags`, { signal: AbortSignal.timeout(2500) });
        const j = r.ok ? await r.json() : null;
        for (const m of (j?.models || [])) sizes.set(String(m.name || ''), Number(m.size) || 0);
      } catch {}
    }
    const models = (list || []).map(name => ({ name, size: sizes.get(name) || 0, embed: isEmbedName(name) }));
    return sendJson(res, 200, {
      alive: Array.isArray(list),
      url: ollamaBase(settings),
      models,
      chat: models.filter(m => !m.embed).map(m => m.name),
      embed: models.filter(m => m.embed).map(m => m.name),
      pick: await pickLocalChatModel(settings),
      embedPick: await pickEmbedModel(settings),
    });
  }

  // 手动/调试用：读一个外链（HTTP → 内嵌内核），返回正文与用了哪一级
  if (pathname === '/api/read-url' && method === 'POST') {
    const body = await readBody(req) || {};
    const target = String(body.url || '').trim();
    if (!/^https?:\/\//i.test(target)) return sendJson(res, 400, { error: '只接受 http(s) 链接' });
    const r = await readLinkUrl(target, { allowBrowser: body.browser !== false });
    return sendJson(res, 200, {
      ok: !!r.ok,
      tier: r.tier,
      url: r.url,
      finalUrl: r.finalUrl || r.url,
      title: r.title || '',
      chars: r.chars || 0,
      ms: r.ms || 0,
      status: r.status || 0,
      error: r.error || '',
      tried: r.tried || [],
      browser: await hasBrowser(),
      text: String(r.text || '').slice(0, 20000),
    });
  }

  // 调试/测试用：只跑一次路由判断，不发请求
  if (pathname === '/api/route/test' && method === 'POST') {
    const body = await readBody(req) || {};
    const settings = await loadSettings();
    const wantHybrid = body.hybrid === true && settings.hybridMode === true;
    const atts = Array.isArray(body.attachments) ? body.attachments : [];
    if (wantHybrid && !atts.length) {
      const hm = normalizeModel(settings.routeHybridModel || 'deepseek-v4-pro');
      const route = {
        kind: 'hybrid',
        model: hm === 'auto' ? 'deepseek-v4-pro' : hm,
        thinking: false,
        reason: '你打开了混合模式：V4.1 Flash 先出大纲，V4 Pro 按大纲写正文',
        draftModel: normalizeModel(settings.routeHybridDraftModel || 'deepseek-flash'),
        forced: true,
      };
      return sendJson(res, 200, {
        autoRoute: settings.autoRoute !== false,
        hybridMode: settings.hybridMode === true,
        forced: true,
        route: { ...route, label: ROUTE_LABELS[route.kind] },
      });
    }
    if (wantHybrid && atts.length) {
      const mediaAtts = atts.some(isMediaAttachment);
      const route = mediaAtts && settings.mediaTwoStage !== false
        ? {
          kind: 'media',
          model: normalizeModel(settings.routeHybridModel || 'deepseek-v4-pro'),
          thinking: false,
          draftModel: normalizeModel(settings.routeHybridDraftModel || 'deepseek-flash'),
          forced: true,
          reason: '你打开了混合模式：V4.1 Flash 先扒要点（转写 + 画面），V4 Pro 按要点写正文',
        }
        : {
          kind: 'vision',
          model: normalizeModel(settings.routeThinkModel || 'deepseek-flash'),
          thinking: false,
          forced: true,
          reason: '混合模式要先出大纲，但附件只有 V4.1 Flash 能看，这条走看附件',
        };
      return sendJson(res, 200, {
        autoRoute: settings.autoRoute !== false,
        hybridMode: settings.hybridMode === true,
        forced: true,
        route: { ...route, label: ROUTE_LABELS[route.kind] },
      });
    }
    if (settings.autoRoute === false) return sendJson(res, 200, { autoRoute: false, hybridMode: settings.hybridMode === true, route: null });
    const route = resolveRoute(settings, {
      text: String(body.text || ''),
      thinking: !!body.thinking,
      attachments: Array.isArray(body.attachments) ? body.attachments : [],
      mode: ['send', 'regenerate', 'edit', 'continue'].includes(body.mode) ? body.mode : 'send',
    });
    return sendJson(res, 200, {
      autoRoute: true,
      hybridMode: settings.hybridMode === true,
      route: { ...route, forced: false, label: ROUTE_LABELS[route.kind] || route.kind },
    });
  }

  if (pathname === '/api/stats' && method === 'GET') return sendJson(res, 200, await stats());

  sendJson(res, 404, { error: '接口不存在' });
}

// ---------------------------------------------------------------- 静态资源

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return sendText(res, 403, 'Forbidden');
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('not file');
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'Content-Length': stat.size,
    };
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  } catch {
    // SPA 兜底
    try {
      const html = await fsp.readFile(path.join(PUBLIC, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      res.end(html);
    } catch {
      sendText(res, 404, 'Not found');
    }
  }
}

// ---------------------------------------------------------------- 启动

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

/* ---- 桌面模式：用 Edge/Chrome 的 --app 开一个没有地址栏的独立窗口（不需要装 Electron） ---- */

const APP_BROWSERS = process.platform === 'win32'
  ? [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ]
  : [];

function findAppBrowser() {
  const env = process.env.DSAPP_BROWSER;
  if (env && existsSync(env)) return env;
  for (const p of APP_BROWSERS) if (existsSync(p)) return p;
  return '';
}

/** 开一个应用窗口；返回 true 表示成功用到 --app 模式 */
function openAppWindow(url) {
  const exe = findAppBrowser();
  if (!exe) { openBrowser(url); return false; }
  try {
    const args = [
      `--app=${url}`,
      `--user-data-dir=${path.join(DATA, 'app-profile')}`,
      '--start-maximized',
      '--no-first-run', '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
    ];
    spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch (e) {
    log('打开应用窗口失败，退回浏览器：' + e.message);
    openBrowser(url);
    return false;
  }
}

/* ---- 关机：给启动脚本/第二实例用 ---- */
async function requestShutdown() {
  const prev = await readJsonFile(RUNTIME_FILE, null).catch(() => null);
  if (!prev || !prev.port) { console.log('没有在跑的服务。'); process.exitCode = 1; return; }
  try {
    const r = await fetch(`http://${HOST}:${prev.port}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3000) });
    console.log(r.ok ? `已停止：${prev.url}` : `停止请求返回 ${r.status}`);
    process.exitCode = r.ok ? 0 : 1;
  } catch {
    console.log('服务没在跑（或已经退出了）。');
    try { await fsp.unlink(RUNTIME_FILE); } catch {}
  }
}

async function main() {
  const argv = process.argv;
  if (argv.includes('--stop') || argv.includes('--quit')) return requestShutdown();

  const DESKTOP = argv.includes('--desktop') || argv.includes('--app');

  // 已经有一个在跑？直接打开它，别再起第二个（想再起一个加 --force）
  if (!argv.includes('--force')) {
    const prev = await readJsonFile(RUNTIME_FILE, null).catch(() => null);
    if (prev && prev.port) {
      const alive = await fetch(`http://${HOST}:${prev.port}/api/state`, { signal: AbortSignal.timeout(1000) })
        .then(r => r.ok).catch(() => false);
      if (alive) {
        const running = `http://${HOST}:${prev.port}`;
        log(`已经有一个在跑了：${running}`);
        if (DESKTOP) {
          log('已经帮你打开应用窗口了。');
          openAppWindow(running);
        } else if (argv.includes('--open')) {
          log('已经帮你打开那个窗口了。');
          openBrowser(running);
        }
        process.exitCode = 3; // 给启动脚本一个信号：这次没起新服务，别提示「退出了」
        return;
      }
    }
  }

  await ensureDirs();
  const seeded = seedSkillsFromBundle();
  if (seeded.fresh && seeded.seeded.length) {
    // 全新装置：随包技能默认打开，省得装了白装；有设置文件的（升级）一律尊重用户勾选
    await saveSettings({ enabledSkills: seeded.seeded });
  }
  await autoImportOnFirstRun();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || HOST}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
      } else {
        await serveStatic(req, res, url.pathname);
      }
    } catch (e) {
      log('请求出错:', e?.stack || e);
      if (!res.headersSent) sendJson(res, 500, { error: e.message || '服务器内部错误' });
      else sseEnd(res);
    }
  });

  server.on('clientError', (err, socket) => {
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
  });

  // 端口占用就往后找
  let port = BASE_PORT;
  for (let i = 0; i < 30; i++) {
    const ok = await new Promise(resolve => {
      const onError = e => { server.removeListener('listening', onListen); resolve(e.code !== 'EADDRINUSE'); };
      const onListen = () => { server.removeListener('error', onError); resolve(true); };
      server.once('error', onError);
      server.once('listening', onListen);
      server.listen(port, HOST);
    });
    if (ok && server.listening) break;
    port++;
  }

  const address = server.address();
  const actualPort = address.port;
  const url = `http://${HOST}:${actualPort}`;
  await writeJsonFile(RUNTIME_FILE, { url, port: actualPort, pid: process.pid, startedAt: now(), node: process.version });
  log(`DeepSeek API 客户端已启动：${url}`);
  log(`数据目录：${DATA}`);

  if (DESKTOP) {
    const ok = openAppWindow(url);
    if (!ok) log('没找到 Edge/Chrome，改成用默认浏览器打开。');
  } else if (argv.includes('--open')) openBrowser(url);

  startQQBridge();
  startHealLoop(); // 隔离实例的自动纠错（90 秒一轮，设置里 napcatAutoHeal 可关）
  startLearnLoop(); // 群聊自学习：10 分钟抽一轮、跨周自动结算（设置里 learnAuto 可关）

  const shutdown = async () => {
    log('正在关闭…');
    stopQQBridge();
    stopLearnLoop();
    server.close();
    try { await fsp.unlink(RUNTIME_FILE); } catch {}
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(e => {
  console.error('启动失败:', e);
  process.exit(1);
});
