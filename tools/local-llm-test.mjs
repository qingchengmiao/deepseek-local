// 本地推理自检：PATH 注入是否生效、探测到哪个后端、能不能真的出字。
//
// 用法：
//   node tools/local-llm-test.mjs <model.gguf>
//   不给 gguf 就只做「路径 + 探测」，不加载模型。

import path from 'node:path';
import { setRootDir, binsDir, findCudaRuntime, prepareDllPath, detectBackend, preparedPaths } from '../local-llm.mjs';

const appRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
setRootDir(appRoot);

const out = { appRoot, steps: [] };
const modelPath = process.argv[2] ? path.resolve(process.argv[2]) : '';

const cudaBins = binsDir('cuda');
const rt = findCudaRuntime();
out.binsDir = cudaBins;
out.cudaRuntime = rt;
out.steps.push({ step: 'look', cudaBins: !!cudaBins, cublas13: !!(rt && rt.hasCublasLt) });
console.log(JSON.stringify(out, null, 2));

if (!cudaBins) {
  console.error('没有 win-x64-cuda 的 bins 目录：node-llama-cpp 的后端二进制没下载（npm postinstall 被跳过？）');
  process.exit(2);
}

const prep = prepareDllPath('cuda');
console.log(JSON.stringify({ prepared: prep, nowOnPath: preparedPaths() }, null, 2));

const det = await detectBackend();
console.log(JSON.stringify({ detect: { kind: det.kind, gpu: det.gpu, ms: det.ms, tried: det.tried } }, null, 2));

if (!det.llama) {
  console.error('没有可用后端');
  process.exit(3);
}

if (!modelPath) {
  await det.llama.dispose();
  console.log(JSON.stringify({ ok: true, backend: det.kind, note: '只探测，没给 gguf' }, null, 2));
  process.exit(det.kind === 'cuda' ? 0 : 0);
}

const { LlamaChatSession } = await import('node-llama-cpp');
const t0 = Date.now();
const model = await det.llama.loadModel({ modelPath });
const loadMs = Date.now() - t0;
const context = await model.createContext({ contextSize: 2048 });
const session = new LlamaChatSession({ contextSequence: context.getSequence() });
const t1 = Date.now();
const a1 = await session.prompt('用一句话说你在哪台机器上跑。', { maxTokens: 64, temperature: 0.3 });
const firstMs = Date.now() - t1;
const t2 = Date.now();
const a2 = await session.prompt('再说一遍，短一点。', { maxTokens: 32, temperature: 0.3 });
const secondMs = Date.now() - t2;

console.log(JSON.stringify({
  ok: true,
  backend: det.kind,
  loadMs,
  firstMs,
  secondMs,
  answer: a1.slice(0, 120),
  answer2: a2.slice(0, 60),
}, null, 2));

context.dispose();
await det.llama.dispose();
