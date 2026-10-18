/**
 * 长文档虚拟滚动的纯逻辑层
 *
 * 为什么不直接把整篇 HTML 塞进 DOM：
 * WebView2/Chromium 在几万行文档上会直接卡死 —— 布局树、样式重算、滚动合成
 * 全都退化成 O(文档长度)。阅读器的正文是「一串块级元素」，天然适合按块虚拟化：
 * 只把视口附近的那几十个块放进 DOM，其余用上下留白顶住高度。
 *
 * 这里只放**与框架无关的纯函数**，方便单独推演和测试；组件那边负责测量、
 * 滚动补偿这些必须碰 DOM 的事。
 *
 * 坐标约定（整个模块统一）：
 *   块 i 的「占位高度」 H_i = marginTop_i + contentHeight_i
 *   块 i 的「内容顶部」在文档里的 y = offsets[i] + marginTop_i
 * 之所以把 margin 算进占位高度，是因为虚拟化后「当前第一个渲染的块」在 DOM 里
 * 没有前置兄弟，CSS 的 `.mr-article > * + *` 不会给它 margin —— 必须由
 * 上下留白把这份间距补回来，否则每次滚动都会看到正文跳一下。
 */

/** 正文容器的默认内容宽度（与 tokens.css 的 --mr-reading-w 对齐） */
export const DEFAULT_CONTENT_WIDTH = 680;

/** 正文行高 / 代码行高（与 tokens.css 对齐），用于高度估算 */
const BODY_LINE = 26;
const CODE_LINE = 20;

/** 超过这个块数才启用虚拟化：短文档全量渲染更快、也更不容易出细节问题 */
export const VIRTUAL_THRESHOLD = 120;

export interface Block {
  /** 该块的 outerHTML，直接交给 {@html} */
  html: string;
  /** 小写标签名 */
  tag: string;
  /** class 串（判断 footnotes / math 等特例） */
  cls: string;
  /** 纯文本，用于估算高度与全文检索 */
  text: string;
  /** 代码块的原行数；非代码块为 0 */
  lines: number;
  /** 表格行数 */
  rows: number;
  /** 列表项数 */
  items: number;
  /** 该块内的全部锚点 id（标题、脚注等） */
  ids: string[];
}

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

/**
 * 把渲染好的 HTML 拆成顶层块。
 *
 * 用 detached 的 div 而非 DOMParser：不触发资源加载，且结果是可用的 HTML 元素。
 * 输入已经过 DOMPurify 净化，这里可以放心 innerHTML。
 */
export function parseBlocks(html: string): Block[] {
  const host = document.createElement('div');
  host.innerHTML = html;

  const out: Block[] = [];
  for (const node of Array.from(host.children)) {
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const text = el.textContent ?? '';
    const ids = [el.id, ...Array.from(el.querySelectorAll<HTMLElement>('[id]')).map((n) => n.id)]
      .filter(Boolean);

    out.push({
      html: el.outerHTML,
      tag,
      cls: el.className || '',
      text,
      lines: tag === 'pre' ? countLines(text) : countPreLines(el),
      rows: tag === 'table' ? el.querySelectorAll('tr').length : 0,
      items: tag === 'ul' || tag === 'ol' ? el.children.length : 0,
      ids,
    });
  }
  return out;
}

function countLines(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** 代码块外面套着 .mr-codeblock，行数要从内层 pre 数 */
function countPreLines(el: HTMLElement): number {
  if (!el.classList.contains('mr-codeblock')) return 0;
  const pre = el.querySelector('pre');
  return pre ? countLines(pre.textContent ?? '') : 0;
}

/* ------------------------------------------------------------------ */
/* 高度估算                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把一段文本折算成「等效中文字符数」。
 * 中文按 1、空白 0.3、其余（拉丁字母/数字）0.55 —— 这个比例足够支撑
 * ±15% 的估算精度，而首屏之后实测会把误差全部抹平。
 */
export function effectiveChars(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32) n += 0.3;
    else if (c > 0x2e80) n += 1;
    else n += 0.55;
  }
  return n;
}

/**
 * 估算单个块的内容高度（不含 margin）。
 *
 * `scale` 是正文字号相对 15px 的倍率（与 CSS 的 --mr-read-scale 同一个数）。
 * 行高、标题高、代码行高都按它线性缩放；换行用的"每行装得下几个字"
 * 则是**反比** —— 字大了，同样的列宽装得下的字就少了。
 * 不传就按默认字号算，老调用点行为不变。
 *
 * 块间距（margin）不参与缩放：它由 app.css 的固定 px 决定，估算必须跟渲染一致。
 */
export function estimateContentHeight(
  b: Block,
  contentWidth = DEFAULT_CONTENT_WIDTH,
  scale = 1,
): number {
  const perLine = Math.max(8, Math.floor(contentWidth / (15.2 * scale)));

  switch (b.tag) {
    case 'h1':
      return 46 * scale;
    case 'h2':
      return 31 * scale;
    case 'h3':
      return 26 * scale;
    case 'h4':
    case 'h5':
    case 'h6':
      return 24 * scale;

    case 'hr':
      return 1;

    case 'pre':
      return b.lines * CODE_LINE * scale + 46 * scale;

    case 'blockquote': {
      // 引用是衬线体、字号更大（--mr-fs-lead），每行装得下的字更少
      const quotePerLine = Math.max(4, perLine - 8);
      const lines = Math.max(1, Math.ceil(effectiveChars(b.text) / quotePerLine));
      return lines * 28 * scale + 30 * scale;
    }

    case 'table':
      return Math.max(1, b.rows) * 42 * scale + 2;

    case 'ul':
    case 'ol': {
      // 列表项各自独占行，必要时换行
      const perItem = Math.max(1, Math.ceil(effectiveChars(b.text) / Math.max(8, b.items) / Math.max(4, perLine - 3)));
      return b.items * perItem * BODY_LINE * scale + b.items * 6 * scale + 6 * scale;
    }

    default: {
      // 段落：按字符量折行；空段落至少占一行
      const lines = Math.max(1, Math.ceil(effectiveChars(b.text) / perLine));
      return lines * BODY_LINE * scale;
    }
  }
}

/**
 * 块的上外边距。
 *
 * 必须与 app.css 的实际规则一一对应 —— 那里块间距主要是
 * `.mr-article > * + * { margin-top: 16px }`，个别元素有更高的特异性规则把它覆盖掉。
 */
export function marginTopOf(b: Block, index: number): number {
  if (index === 0) return 0; // 首块在文档最顶端，没有前置兄弟
  switch (b.tag) {
    case 'h1':
      return 0;
    case 'h2':
      return 34;
    case 'h3':
      return 26;
    case 'hr':
      return 32;
    case 'blockquote':
      return 0;
    default:
      return b.cls.includes('footnotes') ? 32 : 16;
  }
}

/** 估算全部块的占位高度 */
export function estimateHeights(
  blocks: Block[],
  contentWidth = DEFAULT_CONTENT_WIDTH,
  scale = 1,
): number[] {
  return blocks.map((b, i) => marginTopOf(b, i) + estimateContentHeight(b, contentWidth, scale));
}

/* ------------------------------------------------------------------ */
/* 前缀和与查找                                                        */
/* ------------------------------------------------------------------ */

/** offsets[i] = 前 i 块的占位高度之和；长度 n+1，offsets[n] 即全文总高 */
export function buildOffsets(heights: number[]): number[] {
  const out = new Array<number>(heights.length + 1);
  out[0] = 0;
  for (let i = 0; i < heights.length; i++) out[i + 1] = out[i] + heights[i];
  return out;
}

/** 第一个 offsets[i] >= y 的 i（即「包含 y 的块」的后一个边界） */
export function lowerBound(offsets: number[], y: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] < y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 根据滚动位置算出需要渲染的块区间 [start, end)。
 * 上下各留 OVERSCAN 像素，避免快速滚动时出现空白。
 */
export function visibleRange(
  offsets: number[],
  scrollTop: number,
  viewHeight: number,
  total: number,
  overscan = 900,
): { start: number; end: number } {
  if (total === 0) return { start: 0, end: 0 };

  const anchorStart = Math.max(0, lowerBound(offsets, scrollTop) - 1);
  const anchorEnd = Math.min(total, lowerBound(offsets, scrollTop + viewHeight) + 1);

  let start = anchorStart;
  while (start > 0 && offsets[start] > scrollTop - overscan) start--;

  let end = anchorEnd;
  while (end < total && offsets[end] < scrollTop + viewHeight + overscan) end++;

  return { start, end };
}

/* ------------------------------------------------------------------ */
/* 全文检索索引                                                        */
/* ------------------------------------------------------------------ */

export interface TextIndex {
  /** 所有块的纯文本拼起来，用于定位第 N 次出现 */
  full: string;
  /** 每块文本在 full 中的起始下标 */
  starts: number[];
}

export function buildTextIndex(blocks: Block[]): TextIndex {
  const starts: number[] = new Array(blocks.length);
  let full = '';
  for (let i = 0; i < blocks.length; i++) {
    starts[i] = full.length;
    full += blocks[i].text;
  }
  return { full, starts };
}

/** 字符下标 → 所属块索引 */
export function blockIndexAt(index: TextIndex, charPos: number): number {
  return Math.max(0, lowerBound(index.starts, charPos + 1) - 1);
}

/**
 * 找出 needle 第 ordinal 次（从 0 计）出现所在的块，返回块索引与块内字符偏移。
 * 找不到返回 null。
 */
export function locateOccurrence(
  index: TextIndex,
  needle: string,
  ordinal: number,
): { block: number; offset: number } | null {
  if (!needle) return null;
  const hay = index.full.toLowerCase();
  const pin = needle.toLowerCase();

  let seen = 0;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(pin, from);
    if (i < 0) return null;
    if (seen === ordinal) {
      const block = blockIndexAt(index, i);
      return { block, offset: i - index.starts[block] };
    }
    seen++;
    from = i + pin.length;
  }
}
