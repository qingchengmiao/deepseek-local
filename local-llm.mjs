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

export default { setRootDir, binsDir, findCudaRuntime, prepareDllPath, detectBackend, preparedPaths };
