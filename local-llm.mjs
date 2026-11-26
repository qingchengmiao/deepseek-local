// 本地小模型：进程内跑 gguf，不开端口、不装服务。
//
// 为什么要这个文件：node-llama-cpp 的预编译 CUDA 后端（ggml-cuda.dll）是「动态链」的，
// 它 import 的是 cublas64_13.dll / cublasLt64_13.dll（CUDA 13）。而 Windows 在解析一个
// DLL 的依赖时**不会去搜这个 DLL 自己所在的目录**，只搜系统目录 + PATH。
// 于是 ggml 的动态后端加载器加载 ggml-cuda.dll 失败（静默，不打日志），只注册了 CPU，
// 库接着判「这个 CUDA 二进制和当前系统不兼容」，抛 NoBinaryFoundError —— 表现就是
// CUDA 机器上也永远走 CPU。
//
// 修法就是把「放 cublas 的目录」和「放 ggml-cuda.dll 的 bins 目录」一起塞进 PATH，
// 然后再 import node-llama-cpp。实测（RTX 5070 / 驱动 13.5 / compute 12.0）：
//   CPU 81 tok/s、Vulkan 120 tok/s、CUDA 590 tok/s。

import fs from 'node:fs';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';

// 各后端在 node_modules 里的位置（预编译包名 → bins 目录名）
const BACKEND_PKG = {
  cuda: 'win-x64-cuda',
  vulkan: 'win-x64-vulkan',
  cpu: 'win-x64',
  arm64: 'win-arm64',
};

let rootDir = null;
let prepared = false;
const preparedDirs = [];

export function setRootDir(dir) {
  rootDir = dir;
}

function baseDir() {
  if (rootDir) return rootDir;
  // local-llm.mjs 放在 app 根目录，node_modules 就在旁边
  return path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
}

/** 某个后端的 bins 目录（预编译包里的 DLL 都在这），没有就 null */
export function binsDir(kind) {
  const pkg = BACKEND_PKG[kind];
  if (!pkg) return null;
  const dir = path.join(baseDir(), 'node_modules', '@node-llama-cpp', pkg, 'bins', pkg);
  return fs.existsSync(dir) ? dir : null;
}

/** 找一份 CUDA 13 的 cuBLAS（ggml-cuda.dll 硬依赖 cublas64_13.dll） */
export function findCudaRuntime() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const candidates = [
    process.env.DS_CUDA_RUNTIME_DIR,
    path.join(baseDir(), 'data', 'local-llm', 'cuda'),
    // Ollama 自带的运行时（用户装了 Ollama 就有，这是最常见的现成来源）
    // 默认装到 %LOCALAPPDATA%\Programs\Ollama，也有装到 %LOCALAPPDATA%\Ollama 或 Program Files 的
    path.join(localAppData, 'Programs', 'Ollama', 'lib', 'ollama', 'cuda_v13'),
    path.join(localAppData, 'Ollama', 'lib', 'ollama', 'cuda_v13'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Ollama', 'lib', 'ollama', 'cuda_v13'),
    'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v13.5\\bin',
    'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v13.0\\bin',
  ].filter(Boolean);
  // CUDA Toolkit 其它 13.x 版本也认
  const toolkit = 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA';
  try {
    for (const d of fs.readdirSync(toolkit)) {
      if (/^v13\./.test(d)) candidates.push(path.join(toolkit, d, 'bin'));
    }
  } catch {}
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const hits = fs.readdirSync(dir).filter((f) => /^cublas64_13\.dll$/i.test(f));
    if (hits.length) {
      const lt = fs.readdirSync(dir).some((f) => /^cublasLt64_13\.dll$/i.test(f));
      return { dir, hasCublasLt: lt };
    }
  }
  return null;
}

/**
 * 把 cublas 目录和后端 bins 目录塞进 PATH。
 * 必须在 import node-llama-cpp / 调 getLlama 之前跑；子进程（绑定测试）继承环境变量，所以也生效。
 */
export function prepareDllPath(kind = 'cuda') {
  if (!IS_WIN) return { changed: false, dirs: [] };
  const dirs = [];
  const bins = binsDir(kind);
  if (bins) dirs.unshift(bins);
  if (kind === 'cuda') {
    const rt = findCudaRuntime();
    if (rt) dirs.push(rt.dir);
  }
  const parts = (process.env.PATH || '').split(path.delimiter);
  const have = new Set(parts.map((p) => p.toLowerCase().replace(/[\\/]+$/, '')));
  const add = [];
  for (const d of dirs) {
    const key = d.toLowerCase().replace(/[\\/]+$/, '');
    if (!have.has(key)) {
      add.push(d);
      have.add(key);
    }
  }
  if (!add.length) return { changed: false, dirs };
  process.env.PATH = [...add, ...parts].join(path.delimiter);
  for (const d of add) preparedDirs.push(d);
  return { changed: true, dirs: add };
}

/**
 * 探测能用的后端：cuda → vulkan → cpu，各试一次 getLlama（build:'never' 禁掉源码编译）。
 * 返回 { kind, gpu, ms, tried }，kind ∈ 'cuda'|'vulkan'|'cpu'。
 */
export async function detectBackend({ timeoutMs = 20000 } = {}) {
  prepareDllPath('cuda');
  const tried = [];
  for (const kind of ['cuda', 'vulkan', 'cpu']) {
    const t0 = Date.now();
    const gpu = kind === 'cpu' ? false : kind;
    if (kind !== 'cpu') prepareDllPath(kind);
    let llama = null;
    try {
      const { getLlama, LlamaLogLevel } = await import('node-llama-cpp');
      llama = await getLlama({
        gpu,
        // 关键：不让它发现没有预编译包就跑去 git clone 源码现编译（要 CUDA toolkit + 几十分钟）
        build: 'never',
        logLevel: LlamaLogLevel.error,
      });
      tried.push({ kind, ok: true, ms: Date.now() - t0 });
      return { kind, gpu, ms: Date.now() - t0, tried, llama };
    } catch (err) {
      tried.push({ kind, ok: false, ms: Date.now() - t0, error: err?.name || String(err) });
    } finally {
      // 探测成功的那一次保留 llama 实例给调用方；失败的这里没有实例
      if (llama && tried[tried.length - 1].ok) {
        // 由调用方 dispose
      } else if (llama) {
        try { await llama.dispose(); } catch {}
      }
    }
  }
  return { kind: null, gpu: false, ms: 0, tried, llama: null };
}

/** PATH 被改过哪些目录（诊断用） */
export function preparedPaths() {
  return [...preparedDirs];
}

// ---------------------------------------------------------------- 模型与推理
// 模型就是 data/models 下的 .gguf 文件。没有 HTTP、没有 ollama、没有 11434 端口。

let modelDir = null;
let runtime = null;              // { kind, llama } —— 探测一次，全局复用
const modelCache = new Map();    // gguf 绝对路径 → LlamaModel
let chain = Promise.resolve();   // 串行队列：别让两路推理同时抢显存

export function setModelDir(dir) {
  modelDir = dir;
}

export function getModelDir() {
  return modelDir;
}

/** data/models 里现有的 gguf */
export function listModels() {
  if (!modelDir) return [];
  try {
    return fs.readdirSync(modelDir)
      .filter((f) => /\.gguf$/i.test(f))
      .map((f) => ({ name: f, path: path.join(modelDir, f), bytes: safeSize(path.join(modelDir, f)) }));
  } catch { return []; }
}

function safeSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function isEmbedFile(name) {
  return /embed|bge|gte|minilm|rerank/i.test(name);
}

/**
 * 按名字找 gguf：给了名字就按名字（带不带 .gguf 都行），没给就挑一个「不像向量模型」的。
 * 找不到返回 null —— 调用方据此回落 API。
 */
export function resolveModelPath(name = '') {
  const models = listModels();
  if (!models.length) return null;
  const want = String(name || '').trim();
  if (want) {
    const hit = models.find((m) => m.name === want)
      || models.find((m) => m.name.toLowerCase() === `${want.toLowerCase()}.gguf`)
      || models.find((m) => m.name.toLowerCase().includes(want.toLowerCase()));
    if (hit) return hit.path;
  }
  const chat = models.filter((m) => !isEmbedFile(m.name));
  if (chat.length) return chat.sort((a, b) => a.bytes - b.bytes)[0].path;
  return null;
}

export function resolveEmbedModelPath(name = '') {
  const models = listModels();
  const want = String(name || '').trim();
  if (want && want !== 'auto' && want !== 'off') {
    const hit = models.find((m) => m.name === want || m.name.toLowerCase().includes(want.toLowerCase()));
    if (hit) return hit.path;
  }
  const emb = models.filter((m) => isEmbedFile(m.name));
  return emb.length ? emb[0].path : null;
}

/** 探测并缓存后端的 llama 实例 */
async function getRuntime() {
  if (runtime?.llama) return runtime;
  const found = await detectBackend();
  if (!found.llama) {
    const why = found.tried.map((t) => `${t.kind}:${t.ok ? 'ok' : t.error}`).join(' ');
    throw new Error(`本机没有可用的推理后端（${why}）`);
  }
  runtime = { kind: found.kind, llama: found.llama, tried: found.tried };
  return runtime;
}

async function loadModel(modelPath) {
  if (modelCache.has(modelPath)) return modelCache.get(modelPath);
  const { llama } = await getRuntime();
  const model = await llama.loadModel({ modelPath });
  modelCache.set(modelPath, model);
  return model;
}

/** 串行跑，避免并发推理把显存撑爆 */
function queue(fn) {
  const next = chain.then(fn, fn);
  // 无论成败都让队列继续
  chain = next.then(() => {}, () => {});
  return next;
}

/**
 * 进程内对话补全（摘要/整理用）。
 * 返回 { text, model }；找不到模型抛错，由调用方决定回落 API。
 */
export async function chat({ model: modelName, system = '', user, maxTokens = 700, temperature = 0.2, contextSize = 16384 } = {}) {
  const modelPath = resolveModelPath(modelName);
  if (!modelPath) throw new Error('本机没有 gguf 对话模型（data/models 里没有 .gguf）');
  return queue(async () => {
    const { LlamaChatSession } = await import('node-llama-cpp');
    const model = await loadModel(modelPath);
    // 上下文按需给：摘要长文要给大，别一上来就按最大分配显存
    const ctx = await model.createContext({ contextSize: Math.min(contextSize, model.trainContextSize || contextSize) });
    try {
      const session = new LlamaChatSession({ contextSequence: ctx.getSequence(), systemPrompt: system || undefined });
      const text = String(await session.prompt(user, { maxTokens, temperature }) || '').trim();
      if (!text) throw new Error('本地模型返回了空内容');
      return { text, model: path.basename(modelPath) };
    } finally {
      try { await ctx.dispose(); } catch {}
    }
  });
}

/** 进程内向量（可选增强；没有向量 gguf 就返回 null，调用方退回词面检索） */
export async function embed({ model: modelName, texts = [] } = {}) {
  const modelPath = resolveEmbedModelPath(modelName);
  if (!modelPath) return null;
  if (!texts.length) return [];
  return queue(async () => {
    const model = await loadModel(modelPath);
    const ctx = await model.createEmbeddingContext({ contextSize: 8192 });
    try {
      const out = [];
      for (const t of texts) {
        const r = await ctx.getEmbeddingFor(String(t));
        out.push(Array.from(r.vector));
      }
      return out;
    } finally {
      try { await ctx.dispose(); } catch {}
    }
  });
}

/** 状态：用哪个后端、有哪些模型（给 /api/local/* 与设置页） */
export async function status() {
  let kind = runtime?.kind || null;
  let error = '';
  if (!kind) {
    try {
      const { kind: k } = await getRuntime();
      kind = k;
    } catch (e) { error = String(e.message || e); }
  }
  const models = listModels();
  return {
    kind,
    error,
    dir: modelDir,
    models: models.map((m) => m.name),
    chatModel: resolveModelPath('') ? path.basename(resolveModelPath('')) : '',
    embedModel: resolveEmbedModelPath('') ? path.basename(resolveEmbedModelPath('')) : '',
    cached: modelCache.size,
  };
}

/** 释放全部模型与后端（退出时调用；测试里也用它清场） */
export async function disposeAll() {
  for (const m of modelCache.values()) { try { await m.dispose(); } catch {} }
  modelCache.clear();
  if (runtime?.llama) { try { await runtime.llama.dispose(); } catch {} }
  runtime = null;
}

/**
 * 能力枚举：把「这台机器现在能干什么」摊平成一张表，别让调用方靠「有没有报错」猜。
 * 以后接 STT / TTS / 重排，只是往这张表里加一个键，上层不用改判断逻辑。
 */
export const CAPS = {
  CHAT: 'chat',
  EMBED: 'embed',
  RERANK: 'rerank',
  STT: 'stt',
  TTS: 'tts',
};

/** 列一遍各能力现在能不能用；不可用的给出原因（不是抛异常） */
export function capabilities() {
  const models = listModels();
  const chatPath = resolveModelPath('');
  const embedPath = resolveEmbedModelPath('');
  const out = {};
  out[CAPS.CHAT] = chatPath ? { ok: true, model: path.basename(chatPath) } : { ok: false, reason: models.length ? '没有非向量 gguf' : '模型目录里没有 gguf' };
  out[CAPS.EMBED] = embedPath ? { ok: true, model: path.basename(embedPath) } : { ok: false, reason: '没有向量模型（名字带 embed/bge/gte/minilm/rerank）' };
  out[CAPS.RERANK] = { ok: false, reason: '还没接重排模型' };
  out[CAPS.STT] = { ok: false, reason: '还没接语音识别' };
  out[CAPS.TTS] = { ok: false, reason: '还没接语音合成' };
  return out;
}

/** 只要布尔值的一道快问：上层决定走本机还是走 API 时用 */
export function hasCap(name) {
  const c = capabilities()[name];
  return !!(c && c.ok);
}

export default {
  setRootDir, binsDir, findCudaRuntime, prepareDllPath, detectBackend, preparedPaths,
  setModelDir, getModelDir, listModels, resolveModelPath, resolveEmbedModelPath,
  chat, embed, status, disposeAll, capabilities, hasCap, CAPS,
};
