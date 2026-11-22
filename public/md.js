/* 轻量 Markdown 渲染：标题/列表/表格/引用/代码高亮/公式（KaTeX），不依赖任何 CDN */
(function (global) {
  'use strict';

  const KATEX = global.katex || null;
  const HLJS = global.hljs || null;

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const H = s => String(s).replace(/[&<>"']/g, c => ESC[c]);

  let stashStore = [];
  const stash = html => {
    stashStore.push(html);
    return '\u0000' + (stashStore.length - 1) + '\u0001';
  };
  // 块级单元（代码块、块公式）用另一种占位符：它们不能被包进 <p>
  const stashBlock = html => {
    stashStore.push(html);
    return '\u0004' + (stashStore.length - 1) + '\u0005';
  };
  function unstash(html) {
    let out = html;
    for (let pass = 0; pass < 6 && /[\u0000\u0004]/.test(out); pass++) {
      out = out.replace(/[\u0000\u0004](\d+)[\u0001\u0005]/g, (_, i) => {
        const v = stashStore[Number(i)];
        return v == null ? '' : v;
      });
    }
    return out;
  }

  function katexHtml(tex, display) {
    if (!KATEX) return H(display ? '$$' + tex + '$$' : '$' + tex + '$');
    try {
      return KATEX.renderToString(tex, {
        displayMode: !!display,
        throwOnError: false,
        strict: 'ignore',
        trust: false,
        output: 'html',
      });
    } catch (e) {
      return `<code class="math-err">${H(display ? '$$' + tex + '$$' : '$' + tex + '$')}</code>`;
    }
  }

  function codeBlock(code, lang) {
    const language = String(lang || '').trim().split(/[\s,{]/)[0].toLowerCase();
    let body;
    if (HLJS) {
      try {
        body = language && HLJS.getLanguage(language)
          ? HLJS.highlight(code, { language, ignoreIllegals: true }).value
          : HLJS.highlightAuto(code).value;
      } catch (e) {
        body = H(code);
      }
    } else {
      body = H(code);
    }
    const label = language || 'text';
    return [
      '<div class="code-block">',
      `<div class="code-head"><span class="code-lang">${H(label)}</span>`,
      '<button class="code-copy" type="button">复制</button></div>',
      `<pre class="code-pre"><code class="hljs language-${H(label)}">${body}</code></pre>`,
      '</div>',
    ].join('');
  }

  function inline(text) {
    let t = H(text);

    // 行内代码先抽出来，避免里面的 * _ 被当成强调
    const codes = [];
    t = t.replace(/`([^`\n]+)`/g, (_, code) => {
      codes.push(`<code class="inline-code">${code}</code>`);
      return `\u0002${codes.length - 1}\u0003`;
    });

    // 图片、链接
    t = t.replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, (_, alt, src) =>
      `<img class="md-img" src="${src}" alt="${alt}" loading="lazy">`);
    t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, label, href) =>
      `<a href="${href}" target="_blank" rel="noopener">${label}</a>`);
    // 裸链接（跳过已生成的 <a ...> 内部）
    t = t.replace(/(^|[\s(（])(https?:\/\/[^\s<)）\]，。]+)/g, (m, pre, href) =>
      `${pre}<a href="${href}" target="_blank" rel="noopener">${href}</a>`);

    t = t.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    t = t.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    t = t.replace(/\n/g, '<br>');

    t = t.replace(/\u0002(\d+)\u0003/g, (_, i) => codes[Number(i)] || '');
    return t;
  }

  function isTableStart(lines, i) {
    if (i + 1 >= lines.length) return false;
    if (lines[i].indexOf('|') < 0) return false;
    const sep = lines[i + 1].trim();
    return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(sep) && sep.indexOf('|') >= 0;
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map(c => c.trim());
  }

  function listBlock(lines, start) {
    const first = lines[start].match(/^(\s*)([-*+]|\d{1,9}[.)])\s+/);
    if (!first) return null;
    const base = first[1].length;
    const ordered = /\d/.test(first[2]);
    const items = [];
    let i = start;

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        // 空行后若还是同级列表项，继续；否则结束
        let k = i + 1;
        while (k < lines.length && !lines[k].trim()) k++;
        if (k < lines.length) {
          const next = lines[k].match(/^(\s*)([-*+]|\d{1,9}[.)])\s+/);
          if (next && next[1].length === base) { i = k; continue; }
        }
        break;
      }
      const m = line.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+([\s\S]*)$/);
      if (!m || m[1].length !== base) break;
      // 有序和无序不能混成一个列表
      if (/\d/.test(m[2]) !== ordered) break;

      const item = { text: m[3], sub: [] };
      i++;
      // 收集缩进的后续行（含嵌套列表）
      while (i < lines.length) {
        const l2 = lines[i];
        if (!l2.trim()) {
          let k = i + 1;
          while (k < lines.length && !lines[k].trim()) k++;
          if (k < lines.length && lines[k].match(/^\s*/)[0].length > base) { item.sub.push(''); i++; continue; }
          break;
        }
        const indent = l2.match(/^\s*/)[0].length;
        if (indent <= base) break;
        item.sub.push(l2.slice(base + 2 > indent ? indent : base + 2));
        i++;
      }
      while (item.sub.length && !item.sub[item.sub.length - 1].trim()) item.sub.pop();
      items.push(item);
    }

    const tag = ordered ? 'ol' : 'ul';
    const startAttr = ordered ? (() => {
      const n = Number((first[2].match(/\d+/) || [1])[0]);
      return n > 1 ? ` start="${n}"` : '';
    })() : '';

    let html = `<${tag}${startAttr}>`;
    for (const it of items) {
      const task = it.text.match(/^\[([ xX])\]\s+([\s\S]*)$/);
      let inner;
      if (task) {
        inner = `<label class="task-item"><input type="checkbox" disabled${task[1].toLowerCase() === 'x' ? ' checked' : ''}> <span>${inline(task[2])}</span></label>`;
      } else {
        inner = inline(it.text);
      }
      if (it.sub.length) inner += blocks(it.sub.join('\n'));
      html += `<li>${inner}</li>`;
    }
    html += `</${tag}>`;
    return { html, next: i };
  }

  function blocks(text) {
    const lines = String(text).split('\n');
    const out = [];
    let para = [];
    const flush = () => {
      if (!para.length) return;
      const raw = para.join('\n');
      para = [];
      // 段落里可能夹着块级单元（代码块 / 块公式）的占位符：拆开，别把 <div> 塞进 <p>
      const parts = raw.split(/(\u0004\d+\u0005)/);
      let acc = '';
      const pushP = () => {
        const s = acc.replace(/^\n+|\n+$/g, '');
        if (s.trim()) out.push(`<p>${inline(s)}</p>`);
        acc = '';
      };
      for (const part of parts) {
        if (/^\u0004\d+\u0005$/.test(part)) { pushP(); out.push(unstash(part)); }
        else acc += part;
      }
      pushP();
    };

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) { flush(); i++; continue; }

      // 代码围栏残留（未闭合的围栏整段当代码）
      if (/^\s*(`{3,}|~{3,})/.test(line)) {
        flush();
        const fence = line.match(/^\s*(`{3,}|~{3,})/)[1];
        const lang = line.trim().slice(fence.length).trim();
        const buf = [];
        i++;
        while (i < lines.length && !new RegExp('^\\s*' + fence[0] + '{' + fence.length + ',}\\s*$').test(lines[i])) {
          buf.push(lines[i]); i++;
        }
        i++;
        out.push(stash(codeBlock(buf.join('\n'), lang)));
        continue;
      }

      // 标题
      const hm = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
      if (hm) {
        flush();
        const lv = Math.min(6, hm[1].length);
        out.push(`<h${lv}>${inline(hm[2].replace(/\s+#+\s*$/, ''))}</h${lv}>`);
        i++; continue;
      }

      // 分割线
      if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }

      // 引用
      if (/^\s{0,3}>/.test(line)) {
        flush();
        const buf = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
          i++;
        }
        out.push(`<blockquote>${blocks(buf.join('\n'))}</blockquote>`);
        continue;
      }

      // 表格
      if (isTableStart(lines, i)) {
        flush();
        const head = splitRow(lines[i]);
        const align = splitRow(lines[i + 1]).map(c =>
          /^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : /^:-+/.test(c) ? 'left' : '');
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        let html = '<div class="table-wrap"><table><thead><tr>';
        head.forEach((c, k) => { html += `<th${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c)}</th>`; });
        html += '</tr></thead><tbody>';
        for (const row of rows) {
          html += '<tr>';
          head.forEach((_, k) => {
            html += `<td${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(row[k] || '')}</td>`;
          });
          html += '</tr>';
        }
        html += '</tbody></table></div>';
        out.push(html);
        continue;
      }

      // 列表
      if (/^\s*([-*+]|\d{1,9}[.)])\s+/.test(line)) {
        flush();
        const res = listBlock(lines, i);
        if (res) { out.push(res.html); i = res.next; continue; }
      }

      para.push(line);
      i++;
    }
    flush();
    return out.join('\n');
  }

  function render(src) {
    stashStore = [];
    let text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    if (!text.trim()) return '';

    // 1) 围栏代码块
    text = text.replace(
      /(^|\n)(`{3,}|~{3,})[ \t]*([\w+#.\-]*)[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g,
      (m, pre, fence, lang, code) => pre + stashBlock(codeBlock(code, lang))
    );

    // 2) 块级公式 \[ … \] 与 $$ … $$
    text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_, tex) => stashBlock(katexHtml(tex.trim(), true)));
    text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_, tex) => stashBlock(katexHtml(tex.trim(), true)));

    // 3) 行内公式 \( … \) 与 $ … $
    text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_, tex) => stash(katexHtml(tex.trim(), false)));
    text = text.replace(/(^|[^\\$])\$(?![\s$])([^$\n]{1,400}?)(?<![\s\\])\$(?!\d)/g,
      (m, pre, tex) => pre + stash(katexHtml(tex.trim(), false)));

    // 4) 行内代码
    text = text.replace(/`([^`\n]+)`/g, (_, code) => stash(`<code class="inline-code">${H(code)}</code>`));

    return unstash(blocks(text));
  }

  global.MD = { render, escapeHtml: H, codeBlock };
})(window);
