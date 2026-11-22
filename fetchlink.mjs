// 外链读取的本地兜底。
//
// 顺序是产品定的：能靠 DeepSeek 的 deepseek_read_url 工具读的，就走 API（那边有渲染农场、干净正文、
// 还能带引用）；工具读不到的站（反爬、必须 JS 渲染、需要登录态之外的跳转），本地补两次：
//
//   1. httpRead  —— 直接抓 HTML，抽正文。零依赖、快，静态页/服务端渲染页够用。
//   2. browserRead —— 内嵌 Chromium（Electron 里才有）打开页面，等脚本跑完取 innerText。
//                    纯 node 起服务时这一级自动跳过，不会报错。
//
// 两者都拿不到就老实返回失败，让调用方去提示用户，不假装读到。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const BLOCK_TAGS = /<\/?(?:p|div|section|article|main|header|footer|aside|nav|ul|ol|li|dl|dt|dd|table|thead|tbody|tr|td|th|h[1-6]|blockquote|pre|figure|figcaption|form|fieldset|hr)[^>]*>/gi;
const DROP_TAGS = ['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed', 'nav', 'aside', 'footer'];

export function extractUrls(text, max = 3) {
  const out = [];
  const re = /https?:\/\/[^\s<>"'）)】\]，。；、]+/gi;
  let m;
  while ((m = re.exec(String(text || ''))) && out.length < max) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

export function titleOf(html) {
  const m = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(String(html || ''));
  return m ? collapse(decodeEntities(m[1])).slice(0, 200) : '';
}

function collapse(s) {
  return String(s || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 从 HTML 抽正文：优先 article/main，去掉脚本样式，块级标签转换行。 */
export function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of DROP_TAGS) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
    s = s.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), ' ');
  }
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(s);
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(s);
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(s);
  const core = (article && article[1].length > 200 ? article[1] : null) || (main && main[1].length > 200 ? main[1] : null) || (body ? body[1] : s);
  let out = core
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n· ')
    .replace(BLOCK_TAGS, '\n');
  out = out.replace(/<[^>]+>/g, ' ');
  return collapse(decodeEntities(out));
}

function charsetOf(contentType, head) {
  const fromHeader = /charset=([\w-]+)/i.exec(String(contentType || ''));
  if (fromHeader) return fromHeader[1].toLowerCase();
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(head);
  return fromMeta ? fromMeta[1].toLowerCase() : 'utf-8';
}

function decodeBody(buf, contentType) {
  const head = new TextDecoder('latin1').decode(buf.subarray(0, Math.min(buf.length, 4096)));
  const cs = charsetOf(contentType, head);
  const candidates = [cs, 'utf-8', 'gb18030'];
  for (const c of candidates) {
    try {
      return new TextDecoder(c).decode(buf);
    } catch { /* 换下一个 */ }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

/** 第一级：直接 HTTP 抓。 */
export async function httpRead(url, { timeoutMs = 15000, maxBytes = 6 * 1024 * 1024 } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    const buf = Buffer.from(await res.arrayBuffer()).subarray(0, maxBytes);
    const ct = res.headers.get('content-type') || '';
    const raw = decodeBody(buf, ct);
    const isHtml = /html|xml/i.test(ct) || /^\s*<(!doctype|html)/i.test(raw);
    const text = collapse(isHtml ? htmlToText(raw) : raw);
    const title = isHtml ? titleOf(raw) : '';
    return {
      ok: res.ok && text.length > 0,
      tier: 'http',
      status: res.status,
      url,
      finalUrl: res.url || url,
      title,
      text,
      chars: text.length,
      contentType: ct,
      ms: Date.now() - t0,
      error: res.ok ? '' : `HTTP ${res.status}`,
    };
  } catch (e) {
    return { ok: false, tier: 'http', url, title: '', text: '', chars: 0, ms: Date.now() - t0, error: e?.name === 'TimeoutError' ? '抓取超时' : String(e?.message || e) };
  }
}

let electronRef;
async function electronApi() {
  if (electronRef !== undefined) return electronRef;
  try {
    const mod = await import('electron');
    electronRef = mod && mod.BrowserWindow && mod.app ? mod : false;
  } catch {
    electronRef = false;
  }
  return electronRef;
}

export async function hasBrowser() {
  return !!(await electronApi());
}

/** 第二级：内嵌 Chromium 渲染后取 innerText。纯 node 环境返回 null（不抛）。 */
export async function browserRead(url, { timeoutMs = 25000, settleMs = 1200, maxChars = 300000 } = {}) {
  const t0 = Date.now();
  const el = await electronApi();
  if (!el) {
    return { ok: false, tier: 'browser', url, title: '', text: '', chars: 0, ms: Date.now() - t0, error: '没有内嵌内核（当前是纯 node 跑的服务）' };
  }
  let win;
  try {
    win = new el.BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        images: false,
        backgroundThrottling: false,
      },
    });
    const loaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('页面加载超时')), timeoutMs);
      win.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
      win.webContents.once('did-fail-load', (_e, code, desc) => { clearTimeout(timer); reject(new Error(desc || `加载失败 ${code}`)); });
    });
    await win.loadURL(url, { userAgent: UA });
    await loaded;
    await new Promise(r => setTimeout(r, settleMs));
    const data = await win.webContents.executeJavaScript(
      `(() => ({ title: document.title || '', text: (document.body ? document.body.innerText : '').slice(0, ${maxChars}), url: location.href }))()`,
      true,
    );
    const text = collapse(data?.text || '');
    const title = collapse(data?.title || '').slice(0, 200);
    return {
      ok: text.length > 0,
      tier: 'browser',
      url,
      finalUrl: data?.url || url,
      title,
      text,
      chars: text.length,
      ms: Date.now() - t0,
      error: text.length ? '' : '页面渲染完没有正文',
    };
  } catch (e) {
    return { ok: false, tier: 'browser', url, title: '', text: '', chars: 0, ms: Date.now() - t0, error: String(e?.message || e) };
  } finally {
    try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* 忽略 */ }
  }
}

/**
 * 两级兜底读取：先 HTTP，正文太短/失败就上内嵌内核。
 * 返回 { ok, tier, title, text, chars, ms, error, tried:[...] }。
 */
export async function readUrl(url, { allowBrowser = true, minHttpChars = 300, timeoutMs = 15000 } = {}) {
  const tried = [];
  const first = await httpRead(url, { timeoutMs });
  tried.push({ tier: 'http', ok: first.ok, chars: first.chars, error: first.error });
  if (first.ok && first.chars >= minHttpChars) return { ...first, tried };
  if (!allowBrowser) return { ...first, tried };
  const second = await browserRead(url);
  tried.push({ tier: 'browser', ok: second.ok, chars: second.chars, error: second.error });
  if (second.ok && second.chars > (first.ok ? first.chars : 0)) return { ...second, tried };
  // 内核本来就没有（浏览器里打开、或纯 node 起服务）时，保留第一级更具体的原因
  if (/没有内嵌内核/.test(second.error || '')) {
    return {
      ...first,
      tried,
      browserUnavailable: true,
      error: first.ok ? `正文太少（${first.chars} 字），本机没有内嵌内核可渲染` : first.error,
    };
  }
  const best = first.ok ? first : second;
  return { ...best, tried };
}
