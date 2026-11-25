// 在没有浏览器的情况下把 md.js 真跑起来：用 vm 起一个假 window，装上真的 KaTeX / highlight.js
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = {};
ctx.window = ctx;
ctx.self = ctx;
ctx.console = console;
vm.createContext(ctx);

for (const f of ['public/vendor/katex.min.js', 'public/vendor/highlight.min.js', 'public/md.js']) {
  vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
}

const MD = ctx.MD;
if (!MD) { console.log('✗ md.js 没导出 window.MD'); process.exit(1); }

let pass = 0, fail = 0;
function t(name, src, checks) {
  let out;
  try { out = MD.render(src); } catch (e) { fail++; console.log(`  ✗ ${name} — 抛异常：${e.message}`); return; }
  const bad = checks.filter(([label, fn]) => { try { return !fn(out); } catch { return true; } });
  if (bad.length) { fail++; console.log(`  ✗ ${name} — ${bad.map(b => b[0]).join(' / ')}`); console.log('     输出：' + out.replace(/\n/g, ' ').slice(0, 300)); return; }
  pass++; console.log(`  ✓ ${name}`);
  if (out.includes('\u0000')) { console.log(`     警告：${name} 有没替换掉的占位符`); }
}

const has = (s, n = 1) => out => (out.match(new RegExp(s, 'g')) || []).length >= n;

console.log('1) 基础块');
t('标题', '# 一级\n## 二级\n### 三级', [['h1', has('<h1>')], ['h2', has('<h2>')], ['h3', has('<h3>')]]);
t('段落换行', '第一行\n第二行\n\n新的一节', [['两段', has('<p>', 2)], ['br', has('<br>')]]);
t('加粗斜体删除线', '**粗** *斜* ~~删~~ `代码`', [['strong', has('<strong>')], ['em', has('<em>')], ['del', has('<del>')], ['code', has('class="inline-code"')]]);
t('链接与图片', '[文字](https://example.com) ![图](https://x/y.png)', [['a', has('<a href="https://example.com"')], ['img', out => out.includes('<img class="md-img"')]]);
t('外链 target', '[a](https://e.com)', [['blank', out => out.includes('target="_blank"')]]);
t('HTML 转义（防注入）', '<script>alert(1)</script> & <b>x</b>', [['无 script 标签', out => !out.includes('<script')], ['转义', out => out.includes('&lt;script&gt;')]]);
t('水平线', 'a\n\n---\n\nb', [['hr', has('<hr')]]);

console.log('1b) 纯文本链接（不说「看这里」也要能点开）');
t('中文全角冒号后面', '链接：https://github.com/qingchengmiao/deepseek-local', [['a', has('<a href="https://github.com/qingchengmiao/deepseek-local"')]]);
t('中文后面直接跟', '地址是https://a.com/e', [['a', has('<a href="https://a.com/e"')]]);
t('粗体里的链接', '**https://a.com/b**', [['strong 包 a', out => out.includes('<strong><a href="https://a.com/b"')], ['一个 a', has('<a href=', 1)]]);
t('删除线里的链接', '~~https://a.com/t~~', [['del 包 a', out => out.includes('<del><a href="https://a.com/t"')]]);
t('不把中文括号算进地址', '见（https://a.com/d）', [['href 干净', out => out.includes('href="https://a.com/d"')]]);
t('不把中文逗号算进地址', 'https://a.com/f，然后呢', [['href 干净', out => out.includes('href="https://a.com/f"')]]);
t('行内代码里的不转', '`https://a.com/g` 和 https://a.com/h', [['只有一个 a', has('<a href=', 1)], ['指的 h', out => out.includes('href="https://a.com/h"')]]);
t('www. 自动补协议', 'www.example.com/a', [['补 https', out => out.includes('href="https://www.example.com/a"')], ['字面还是 www', out => out.includes('>www.example.com/a</a>')]]);
t('markdown 链接不重复包', '[文字](https://a.com/m)', [['一个 a', has('<a href=', 1)], ['href', out => out.includes('href="https://a.com/m"')], ['无残留占位符', out => !out.includes('\u0008')]]);

console.log('2) 列表');
t('无序/有序', '- 一\n- 二\n\n1. 甲\n2. 乙', [['ul', has('<ul>')], ['ol', has('<ol>')], ['li4', has('<li>', 4)]]);
t('嵌套列表', '- 一\n  - 一.a\n  - 一.b\n- 二', [['嵌套 ul', has('<ul>', 2)]]);
t('任务列表', '- [x] 做了\n- [ ] 没做', [['checkbox', out => out.includes('type="checkbox"') || out.includes('task-item')]]);
t('列表里的行内代码', '- 用 `npm test` 跑', [['inline-code', has('inline-code')]]);

console.log('3) 表格');
t('管道表格', '| a | b |\n| --- | ---: |\n| 1 | 2 |', [['table', has('<table')], ['th', has('<th')], ['td', has('<td')], ['右对齐', out => out.includes('text-align:right')]]);
t('表格里的公式', '| 公式 | 说明 |\n| --- | --- |\n| $E=mc^2$ | 质能 |', [['katex', has('class="katex"')]]);

console.log('4) 引用与代码块');
t('引用', '> 引一句\n> 两行\n\n正常段落', [['blockquote', has('<blockquote>')]]);
t('嵌套引用', '> 外\n> > 内', [['两层', has('<blockquote>', 2)]]);
t('围栏代码带语言', '```js\nconst a = 1;\n```', [['code-block', has('class="code-block"')], ['lang', out => out.includes('language-js')], ['高亮 span', has('<span class="hljs-')], ['复制按钮', has('code-copy')]]);
t('围栏代码无语言', '```\n随便写点什么\n```', [['code-block', has('class="code-block"')], ['label text', out => out.includes('>text<')]]);
t('代码里的 HTML 不执行', '```html\n<b>hi</b>\n```', [['转义', out => out.includes('&lt;') && !out.includes('<b>hi')]]);
t('代码里的反引号内容不被当行内码', '```\n`a`\n```', [['没有 inline-code', out => !out.includes('inline-code')]]);

console.log('5) 公式');
t('行内 $', '勾股 $a^2+b^2=c^2$ 定理', [['katex', has('class="katex"')], ['非 display', out => out.includes('katex') && !out.includes('katex-display')]]);
t('块级 $$', '$$\n\\frac{1}{2}\n$$', [['display', has('katex-display')]]);
t('\\( \\) 与 \\[ \\]', '行内 \\(x=1\\) 和块 \\[y=2\\]', [['katex2', has('class="katex"', 2)]]);
t('货币不像公式', '这东西 5$ 一个，另一个 $9，合计 $14', [['无 katex', out => !out.includes('class="katex"')], ['原文保留', out => out.includes('$5') || out.includes('5$')]]);
t('坏公式不炸', '$\\frac{1}{$', [['有输出', out => out.length > 0]]);

console.log('6) 混合与边界');
t('代码块不塞进段落', '说明文字：\n\n```js\nlet a = 1\n```\n\n后面的话', [
  ['无 p>div', out => !out.includes('<p><div')],
  ['正文两段', has('<p>', 2)],
]);
t('段落中间的块公式单独成块', '前面 $$x^2$$ 后面', [['无 p>span katex-display', out => !/<p>[^<]*<span class="katex-display"/.test(out)]]);
t('列表后接有序列表不混', '- 一\n- 二\n\n1. 甲\n2. 乙', [['ul+ol', out => out.includes('<ul>') && out.includes('<ol>')]]);
t('代码块里有公式符号不被渲染', '```\n$not math$\n```', [['无 katex', out => !out.includes('class="katex"')]]);
t('空输入', '', [['空串', out => out === '']]);
t('纯空白', '   \n\n  ', [['空串', out => out === '']]);
t('CRLF', '# 标题\r\n正文\r\n', [['h1', has('<h1>')]]);
t('标题带公式', '## $x$ 是什么', [['h2+katex', out => out.includes('<h2>') && out.includes('class="katex"')]]);
t('连续三个代码块', '```\na\n```\n\n```\nb\n```\n\n```\nc\n```', [['三块', has('class="code-block"', 3)]]);

console.log('7) 真实对话内容（从导出里抽 5 条长的 assistant 消息）');
{
  const raw = JSON.parse(readFileSync('../AI摸鱼写游戏.json', 'utf8'));
  const longs = raw.messages.filter(m => m.role === 'assistant' && m.content && m.content.length > 3000).slice(0, 5);
  for (const [i, m] of longs.entries()) {
    let out = '';
    const t0 = Date.now();
    try { out = MD.render(m.content); } catch (e) { fail++; console.log(`  ✗ 第 ${i + 1} 条（${m.content.length} 字）抛异常：${e.message}`); continue; }
    const ms = Date.now() - t0;
    const left = out.includes('\u0000');
    const unbalanced = (out.match(/<div/g) || []).length !== (out.match(/<\/div>/g) || []).length;
    if (left || unbalanced) { fail++; console.log(`  ✗ 第 ${i + 1} 条：占位符残留=${left} div 不平衡=${unbalanced}`); continue; }
    pass++; console.log(`  ✓ 第 ${i + 1} 条 ${m.content.length} 字 → ${out.length} 字 HTML（${ms}ms）`);
  }
}

console.log('8) 性能：3000 条消息整体渲染');
{
  const raw = JSON.parse(readFileSync('../AI摸鱼写游戏.json', 'utf8'));
  const t0 = Date.now();
  let chars = 0;
  for (const m of raw.messages) chars += MD.render(m.content || '').length;
  const ms = Date.now() - t0;
  const per = (ms / raw.messages.length).toFixed(2);
  const okPerf = ms / raw.messages.length < 20;
  if (okPerf) { pass++; console.log(`  ✓ ${raw.messages.length} 条 ${ms}ms（平均 ${per}ms/条，共产出 ${chars} 字 HTML）`); }
  else { fail++; console.log(`  ✗ 太慢：${ms}ms，平均 ${per}ms/条`); }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
