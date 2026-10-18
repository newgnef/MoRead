/**
 * Markdown 渲染管线
 *
 * 顺序：markdown-it（GFM + 数学 + 锚点） → DOMPurify 净化 → 交由组件注入
 *
 * 关键约束（见需求方案 §5.4）：
 * - 高亮器只初始化一次；initHighlighter() 之后 renderMarkdown() 是同步的
 * - 代码块走 Shiki 双主题，颜色以 CSS 变量承载，切主题不需要重新解析
 * - 任何一步失败都降级为纯文本，不允许整页崩掉
 */

import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import taskLists from 'markdown-it-task-lists';
import footnote from 'markdown-it-footnote';
import deflist from 'markdown-it-deflist';
import katex from 'katex';
// KaTeX 的样式表必须引：它负责把 MathML 那层视觉隐藏（clip 到 1px），
// 否则 htmlAndMathml 双输出会同时显示，公式看起来是渲染了两遍。
import 'katex/dist/katex.min.css';
import DOMPurify from 'dompurify';
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import { shikiTheme } from './tokens';

/**
 * 语言包**必须逐个静态写出来**，不能用 `import(`shiki/langs/${x}.mjs`)` 拼路径——
 * 那样 Vite 无法静态分析，语言包不会进产物。
 *
 * 顺带解决了另一个问题：直接 `import { createHighlighter } from 'shiki'`
 * 会把**全部 200+ 种语言**打进构建产物（实测 cpp 697kB、emacs-lisp 804kB）。
 * 走细粒度入口后，产物里只有下面这 13 种。
 */
const LANG_LOADERS = [
  () => import('shiki/langs/bash.mjs'),
  () => import('shiki/langs/shellscript.mjs'),
  () => import('shiki/langs/javascript.mjs'),
  () => import('shiki/langs/typescript.mjs'),
  () => import('shiki/langs/java.mjs'),
  () => import('shiki/langs/sql.mjs'),
  () => import('shiki/langs/json.mjs'),
  () => import('shiki/langs/yaml.mjs'),
  () => import('shiki/langs/markdown.mjs'),
  () => import('shiki/langs/xml.mjs'),
  () => import('shiki/langs/html.mjs'),
  () => import('shiki/langs/css.mjs'),
  () => import('shiki/langs/python.mjs'),
];

let highlighter: HighlighterCore | null = null;
let initPromise: Promise<void> | null = null;

/** 初始化高亮器（幂等）。App 启动时 await 一次即可 */
export function initHighlighter(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        const langs = await Promise.all(LANG_LOADERS.map((load) => load()));
        highlighter = await createHighlighterCore({
          themes: [
            import('shiki/themes/github-light.mjs'),
            import('shiki/themes/github-dark.mjs'),
          ],
          langs: langs.map((m) => m.default as never),
          /*
           * engine **必须显式提供**。
           *
           * `shiki/core` 只是 import 了内联的 wasm 模块，并不会调用 loadWasm；
           * 不传 engine 时 createHighlighterCore 照样成功返回，直到第一次
           * codeToHtml 才抛「Must invoke loadWasm first」。
           *
           * 这里曾经吃过亏：因为失败被 catch 成「降级为纯文本」，界面上看不出
           * 任何异常，只是代码块一直没有颜色。所以下面加了显式的错误提示。
           */
          engine: createOnigurumaEngine(import('shiki/wasm')),
        });
      } catch (err) {
        // 高亮失败不能拖垮阅读：降级为纯文本代码块
        console.error('[moread] Shiki 初始化失败，代码块将没有语法着色：', err);
        highlighter = null;
      }
    })();
  }
  return initPromise;
}

/* ------------------------------------------------------------------ */
/* markdown-it 实例                                                    */
/* ------------------------------------------------------------------ */

const md: MarkdownIt = new MarkdownIt({
  html: true,        // 允许原始 HTML（<details>/<kbd>），但下面统一净化
  linkify: true,
  breaks: false,
  typographer: false,
});

md.use(anchor, {
  permalink: false,
  slugify: (s: string) =>
    encodeURIComponent(String(s).trim().toLowerCase().replace(/\s+/g, '-')),
});
md.use(taskLists, { label: true, labelAfter: true });
md.use(footnote);
md.use(deflist);

const esc = (s: string) => md.utils.escapeHtml(s);

/* --------------------------- 数学公式 --------------------------- */

// 块级：$$ ... $$
md.block.ruler.before(
  'fence',
  'math_block',
  (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    const first = state.src.slice(start, max).trim();
    if (!first.startsWith('$$')) return false;
    if (silent) return true;

    let nextLine = startLine;
    let body = '';
    const rest = first.slice(2);

    if (rest.length >= 2 && rest.endsWith('$$')) {
      body = rest.slice(0, -2);
      nextLine = startLine + 1;
    } else {
      body = rest;
      let closed = false;
      for (nextLine = startLine + 1; nextLine < endLine; nextLine++) {
        const line = state.src.slice(
          state.bMarks[nextLine] + state.tShift[nextLine],
          state.eMarks[nextLine],
        );
        if (line.trim().endsWith('$$')) {
          body += '\n' + line.replace(/\$\$\s*$/, '');
          closed = true;
          nextLine++;
          break;
        }
        body += '\n' + line;
      }
      if (!closed) return false;
    }

    const token = state.push('math_block', 'math', 0);
    token.block = true;
    token.content = body.trim();
    token.map = [startLine, nextLine];
    state.line = nextLine;
    return true;
  },
  { alt: ['paragraph', 'reference', 'blockquote', 'list'] },
);

md.renderer.rules.math_block = (tokens, idx) => {
  try {
    return `<div class="mr-math mr-math--block">${katex.renderToString(tokens[idx].content, {
      displayMode: true,
      throwOnError: false,
      output: 'htmlAndMathml',
    })}</div>`;
  } catch {
    return `<pre class="mr-math-fallback">${esc(tokens[idx].content)}</pre>`;
  }
};

// 行内：$ ... $
md.inline.ruler.before('emphasis', 'math_inline', (state, silent) => {
  const start = state.pos;
  if (state.src[start] !== '$') return false;
  if (state.src[start + 1] === '$') return false; // 块级交给上面

  let pos = start + 1;
  let end = -1;
  while (pos < state.posMax) {
    const ch = state.src[pos];
    if (ch === '\\') { pos += 2; continue; }
    if (ch === '\n') return false;   // 行内公式不跨行
    if (ch === '$') { end = pos; break; }
    pos++;
  }
  if (end < 0 || end === start + 1 || state.src[end + 1] === '$') return false;

  if (!silent) {
    const token = state.push('math_inline', 'math', 0);
    token.content = state.src.slice(start + 1, end);
  }
  state.pos = end + 1;
  return true;
});

md.renderer.rules.math_inline = (tokens, idx) => {
  try {
    return `<span class="mr-math">${katex.renderToString(tokens[idx].content, {
      displayMode: false,
      throwOnError: false,
      output: 'htmlAndMathml',
    })}</span>`;
  } catch {
    return `<code>${esc(tokens[idx].content)}</code>`;
  }
};

/* --------------------------- 代码块 --------------------------- */

/**
 * 渲染阶段**只做转义，不做高亮**。
 *
 * 高亮交给 highlightIn()，在块真正进入 DOM 后才按需执行。原因很实际：
 * 一篇 2.5MB 的文档有两千个代码块，同步高亮会让打开时间多出好几秒，
 * 而虚拟滚动下其中绝大多数块根本不会被渲染出来。把高亮从「渲染时」
 * 挪到「可见时」，是这套管线里收益最大的一处改动。
 */
md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const info = (token.info || '').trim().split(/\s+/)[0];
  const label = info || 'text';

  return (
    `<div class="mr-codeblock">` +
      `<div class="mr-codeblock__head">` +
        `<span class="mr-codeblock__lang">${esc(label)}</span>` +
        `<button type="button" class="mr-codeblock__copy" data-copy>复制</button>` +
      `</div>` +
      `<div class="mr-codeblock__body">` +
        `<pre class="mr-code-pending" data-lang="${esc(label)}"><code>${esc(token.content)}</code></pre>` +
      `</div>` +
    `</div>`
  );
};

/* ------------------------------------------------------------------ */
/* 懒高亮                                                              */
/* ------------------------------------------------------------------ */

/** 高亮失败的最近一次原因，供开发期诊断（生产环境不会被读） */
let lastHighlightError: string | null = null;
/** 失败提示只打一次，避免滚动时刷屏 */
let warnedHighlightFailure = false;

export function highlightDiagnostics(): { ready: boolean; lastError: string | null } {
  return { ready: !!highlighter, lastError: lastHighlightError };
}

/**
 * 把容器里所有待高亮的代码块交给 Shiki。
 *
 * `limit` 限制单次调用的处理量：快速滚动时一帧内可能新进来几十个块，
 * 一次性全高亮会把这帧拖长。分片处理后剩下的交给下一帧继续，
 * 视觉上是代码逐块着色，但滚动始终不掉帧。
 *
 * 返回**剩余未处理**的块数，调用方据此决定是否再排一帧。
 *
 * 高亮后的 `<pre>` 与原纯文本 `<pre>` 行数一致、都没有内边距，
 * 所以替换不会改变块高度 —— 虚拟滚动的坐标不会因此错位。
 */
export function highlightIn(root: ParentNode, limit = Infinity): number {
  if (!highlighter) return 0;
  const pending = Array.from(root.querySelectorAll<HTMLElement>('pre.mr-code-pending'));
  if (pending.length === 0) return 0;

  const loaded = highlighter.getLoadedLanguages();
  let i = 0;

  for (; i < pending.length && i < limit; i++) {
    const pre = pending[i];
    const raw = pre.dataset.lang ?? 'text';
    const lang = loaded.includes(raw as never) ? raw : 'plaintext';
    try {
      const html = highlighter.codeToHtml(pre.textContent ?? '', {
        lang,
        themes: { light: shikiTheme.light, dark: shikiTheme.dark },
      });
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      const next = tmp.firstElementChild;
      if (next) {
        pre.replaceWith(next);
        continue;
      }
      lastHighlightError = `codeToHtml 返回的内容里没有元素（lang=${lang}）`;
    } catch (err) {
      lastHighlightError = err instanceof Error ? `${err.message}（lang=${lang}）` : String(err);
      if (import.meta.env.DEV && !warnedHighlightFailure) {
        warnedHighlightFailure = true;
        // 这条以前是静默的，结果代码块很久都没有颜色却没人察觉
        console.warn('[moread] 代码高亮失败，已降级为纯文本：', err);
      }
    }
    // 高亮不了就保留纯文本，去掉标记避免每次滚动都重试
    pre.classList.remove('mr-code-pending');
  }

  return pending.length - i;
}

/* --------------------------- 净化 --------------------------- */

const PURIFY_CONFIG: DOMPurify.Config = {
  USE_PROFILES: { html: true, svg: true, mathMl: true },
  // data-lang 是代码块的语言标记，高亮阶段要用它；ALLOW_DATA_ATTR 关着，
  // 所以必须在这里显式放行，否则属性会被剥掉、高亮只能一律按 plaintext
  ADD_ATTR: ['style', 'class', 'id', 'target', 'rel', 'data-copy', 'data-lang', 'checked', 'disabled'],
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'link', 'meta'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'srcdoc'],
  ALLOW_DATA_ATTR: false,
};

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

export interface Heading {
  id: string;
  text: string;
  level: number;
}

export interface RenderResult {
  html: string;
  headings: Heading[];
}

/** 从已渲染的 DOM 里抽取大纲（比再解析一遍源文本更准） */
export function extractHeadings(html: string): Heading[] {
  const out: Heading[] = [];
  const re = /<h([1-3])[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const text = m[3]
      .replace(/<[^>]+>/g, '')
      .replace(/&[a-z]+;/gi, '')
      .trim();
    if (text) out.push({ id: m[2], text, level: Number(m[1]) });
  }
  return out;
}

/** 渲染 Markdown → 安全 HTML + 大纲 */
export function renderMarkdown(source: string): RenderResult {
  let raw: string;
  try {
    raw = md.render(source);
  } catch (err) {
    console.error('[moread] Markdown 解析失败：', err);
    raw = `<pre>${esc(source)}</pre>`;
  }
  const html = DOMPurify.sanitize(raw, PURIFY_CONFIG) as unknown as string;
  return { html, headings: extractHeadings(html) };
}

/** 渲染单个行内片段（用于搜索命中高亮等场景） */
export function renderInline(source: string): string {
  return DOMPurify.sanitize(md.renderInline(source), PURIFY_CONFIG) as unknown as string;
}
