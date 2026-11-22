// 静态一致性检查：HTML 里的 id/handler ↔ app.js 引用、CSS 类、vendor 全局变量
import { readFileSync } from 'node:fs';

const html = readFileSync('public/index.html', 'utf8');
const app = readFileSync('public/app.js', 'utf8');
const css = readFileSync('public/styles.css', 'utf8');
const md = readFileSync('public/md.js', 'utf8');
const server = readFileSync('server.mjs', 'utf8');

const problems = [];
const ok = [];

// 1) id 引用：HTML 里声明的 ∪ app.js 模板串里静态声明的
const ids = new Set([
  ...[...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]),
  ...[...app.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map(m => m[1]), // 不含 ${} 的动态 id
]);
const refs = [...new Set([...app.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]))];
const getById = [...new Set([...app.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]))];
const missing = [...new Set([...refs, ...getById])].filter(id => !ids.has(id));
if (missing.length) problems.push(`引用了不存在的 id：${missing.join(', ')}`);
else ok.push(`id 引用全部存在（查 ${refs.length + getById.length} 个）`);

// 2) app.js / html 里用到的关键类是否在 CSS 里定义（app.js 动态插入的这些类必须能渲染出样子）
const keyClasses = ['messages', 'msg', 'md', 'bubble', 'reason', 'code-block', 'welcome', 'composer', 'ctx', 'modal', 'toast', 'conv-item', 'load-more', 'typing-cursor', 'msg-time', 'hit', 'side-search', 'side-list', 'topbar', 'scroller', 'main',
  'attach-bar', 'att-chip', 'att-img', 'att-file', 'tool-card', 'tc-row', 'tc-src', 'cite', 'notice', 'chip-select', 'stat-grid', 'act-speak', 'att-del', 'mic-label'];
const missCss = keyClasses.filter(c => !new RegExp('\\.' + c + '(?![\\w-])').test(css));
if (missCss.length) problems.push(`CSS 里找不到这些类：${missCss.join(', ')}`);
else ok.push(`关键 class 在 CSS 里都有定义（查 ${keyClasses.length} 个）`);

// 3) HTML 里内联事件处理器指向的函数是否在 app.js 定义
const inline = new Set([...html.matchAll(/on(?:click|change|input|keydown)="([A-Za-z0-9_$]+)\(/g)].map(m => m[1]));
const undef = [...inline].filter(fn => !new RegExp(`function\\s+${fn}\\b|const\\s+${fn}\\s*=|window\\.${fn}\\s*=`).test(app));
if (undef.length) problems.push(`内联事件指向未定义函数：${undef.join(', ')}`);
else ok.push(`内联事件处理器都有定义（${inline.size} 个）`);

// 4) vendor 全局
for (const [file, globals] of [['vendor/katex.min.js', ['katex']], ['vendor/highlight.min.js', ['hljs']]]) {
  const src = readFileSync('public/' + file, 'utf8');
  const bad = globals.filter(g => !new RegExp(`\\b${g}\\b`).test(src));
  if (bad.length) problems.push(`${file} 里没找到 ${bad.join(', ')}`);
}
if (!problems.some(p => p.includes('vendor'))) ok.push('vendor 全局（katex / hljs）都在');

// 5) md.js 是否真的调到了这两个库
const mdCalls = ['KATEX.renderToString', 'HLJS.getLanguage', 'HLJS.highlight', 'HLJS.highlightAuto'];
const missCall = mdCalls.filter(c => !md.includes(c));
if (missCall.length) problems.push(`md.js 缺少调用：${missCall.join(', ')}`);
else ok.push('md.js 的 KaTeX / hljs 调用点齐全');

// 6) 脚本顺序：md.js 必须在 app.js 之前
const iMd = html.indexOf('md.js'), iApp = html.indexOf('app.js');
if (iMd < 0 || iApp < 0 || iMd > iApp) problems.push('index.html 里 md.js 必须在 app.js 之前引入');
else ok.push('md.js 在 app.js 之前加载');

// 7) 主题：CSS 选择器 ↔ app.js 写入的属性要一致
const cssThemeAttr = /html\[data-theme="(dark|light)"\]/g.test(css);
const appSetsAttr = /documentElement\.dataset\.theme/.test(app);
if (!cssThemeAttr || !appSetsAttr) problems.push(`主题机制不一致：CSS 用 data-theme 选择器=${cssThemeAttr}，app.js 写 dataset.theme=${appSetsAttr}`);
else ok.push('主题：CSS 选择器与 app.js 写入一致（html[data-theme]）');

// 8) 深浅主题的两套 hljs 样式都引了
for (const f of ['github.min.css', 'github-dark.min.css']) {
  if (!html.includes(f)) problems.push(`index.html 没引入 ${f}`);
}
ok.push('hljs 深浅两套主题都引入了');

// 9) CSS 变量完整性：app.js 用到的 var(--x) 是否在 :root/html 里定义
const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]));
const def = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]));
const noDef = [...used].filter(v => !def.has(v));
if (noDef.length) problems.push(`CSS 里用了但没定义的变量：${noDef.join(', ')}`);
else ok.push(`CSS 变量齐全（用 ${used.size} 个，全有定义）`);

// 10) app.js 里 fetch/写死的 /api 路径，server.mjs 都要有对应处理
const apiPaths = [...new Set(
  [...app.matchAll(/['"`](\/api\/[A-Za-z0-9_\-/]*)['"`]/g)].map(m => m[1])
)].map(p => p.replace(/\/+$/, ''));
const missApi = apiPaths.filter(p => !server.includes(p));
if (missApi.length) problems.push(`app.js 调了但 server.mjs 里没有的接口：${missApi.join(', ')}`);
else ok.push(`前端调用的 ${apiPaths.length} 个 /api 接口在 server.mjs 里都有`);

// 11) 新功能的前端点：chips / 附件 / 语音 / 朗读 是否都绑了事件
const needBind = ['attachChip', 'attachInput', 'webChip', 'thinkChip', 'effortSel', 'micChip'];
const noBind = needBind.filter(id => !new RegExp(`\\$\\('#${id}'\\)\\.addEventListener`).test(app) && !new RegExp(`\\$\\('#${id}'\\)`).test(app));
if (noBind.length) problems.push(`这些输入区控件没有引用：${noBind.join(', ')}`);
else ok.push(`全家桶控件都在 app.js 里绑了事件（查 ${needBind.length} 个）`);

for (const o of ok) console.log('  ✓ ' + o);
for (const p of problems) console.log('  ✗ ' + p);
console.log(problems.length ? `\n${problems.length} 个问题` : '\n前端静态一致性检查全部通过');
process.exit(problems.length ? 1 : 0);