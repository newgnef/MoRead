/**
 * 纯文本检索的共享逻辑
 *
 * 为什么要有这个模块：搜索在**源 Markdown 文本**上做，而跳转发生在
 * **渲染后的正文**里。这两者的匹配序号必须对齐，否则「点第 3 条命中」
 * 会跳到第 5 处 —— 因为源文本里多出来的那些匹配，渲染后根本不显示。
 *
 * 典型来源：`[文字](https://example.com/文字)` 的 URL、`<span>文字</span>`
 * 的标签名。用户搜「文字」时，源文本命中 2 次，正文里只有 1 次。
 *
 * 解法是**等长屏蔽**：把这类不会出现在正文里的片段按字符数替换成空格。
 * 行号、列号、行的字符长度全部保持不变，只是那些位置再也匹配不上。
 *
 * 同一份实现被三处复用，避免口径漂移：
 *   - tools/dev-fs.ts（浏览器预览下的开发期文件系统桥）
 *   - src/lib/components/... 经 App.svelte（已打开文档内的即时检索）
 *   - src-tauri/src/lib.rs 是等价的 Rust 重写（无法直接共享代码）
 */

/** 单个文件里最多返回多少条命中，超出只计数不返回 */
export const MAX_HITS_PER_FILE = 30;

/** 每行被屏蔽片段的最大扫描长度，防止一行超长时退化成 O(n²) */
const MASK_WINDOW = 300;

/**
 * 把一行里「不会出现在渲染结果中」的片段按字符数抹成空格。
 *
 * 处理两类：
 *   1. `](...)` —— 链接与图片的目标地址
 *   2. `<...>` —— 行内 HTML 标签
 *
 * 用码点遍历而非正则替换：替换后的字符数必须与原串严格一致，
 * 否则列号与行内截取的上下文都会错位。
 */
export function maskNonVisible(line: string): string {
  // 没有任何可疑符号时直接短路，避免为每一行都拆一次数组
  if (line.indexOf(']') < 0 && line.indexOf('<') < 0) return line;

  const cs = [...line];
  const n = cs.length;
  let i = 0;

  while (i < n) {
    // ]( ... ) ：只抹掉括号及其内部，方括号内的文字是可见的，保留
    if (cs[i] === ']' && i + 1 < n && cs[i + 1] === '(') {
      let j = i + 2;
      while (j < n && cs[j] !== ')' && cs[j] !== '\n') j++;
      if (j < n && cs[j] === ')') {
        for (let k = i + 1; k <= j; k++) cs[k] = ' ';
        i = j + 1;
        continue;
      }
    }

    // < ... > ：整段抹掉
    if (cs[i] === '<') {
      let j = i + 1;
      while (j < n && cs[j] !== '>' && cs[j] !== '<' && j - i < MASK_WINDOW) j++;
      if (j < n && cs[j] === '>') {
        for (let k = i; k <= j; k++) cs[k] = ' ';
        i = j + 1;
        continue;
      }
    }

    i++;
  }

  return cs.join('');
}

/** 按行拆分，兼容 CRLF */
export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** 截取命中位置前后一小段上下文，两侧按需加省略号 */
export function snippetAround(raw: string, col: number, len: number, pad = 34): string {
  const cs = [...raw];
  const from = Math.max(0, col - pad);
  const to = Math.min(cs.length, col + len + pad);
  const body = cs.slice(from, to).join('').trim();
  return (from > 0 ? '…' : '') + body + (to < cs.length ? '…' : '');
}

export interface TextMatch {
  /** 1 起的行号 */
  line: number;
  /** 行内起始列（码点索引） */
  col: number;
  /** 在整个文本里这是第几次出现（0 起）—— 定位用它，不是行号 */
  ordinal: number;
  snippet: string;
}

/**
 * 在一段纯文本里查找关键词。
 *
 * ordinal **总是**递增，即使该条命中因为超出 maxHits 没被收录 ——
 * 少算一次就会让后面所有命中的序号整体前移，点击直接跳错位置。
 */
export function searchInText(
  text: string,
  needle: string,
  opts: { caseSensitive?: boolean; maxHits?: number } = {},
): { matches: TextMatch[]; count: number } {
  const caseSensitive = opts.caseSensitive ?? false;
  const maxHits = opts.maxHits ?? MAX_HITS_PER_FILE;

  const pin = caseSensitive ? needle : needle.toLowerCase();
  const matches: TextMatch[] = [];
  let count = 0;

  if (!pin) return { matches, count };

  const lines = splitLines(text);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const masked = maskNonVisible(raw);
    const hay = caseSensitive ? masked : masked.toLowerCase();

    let from = 0;
    for (;;) {
      const col = hay.indexOf(pin, from);
      if (col < 0) break;

      if (matches.length < maxHits) {
        matches.push({
          line: i + 1,
          col,
          ordinal: count,
          snippet: snippetAround(raw, col, needle.length),
        });
      }
      count++;
      from = col + Math.max(1, pin.length);
    }
  }

  return { matches, count };
}

/**
 * 把片段按关键词切成「命中 / 非命中」两段式，交给模板逐段渲染。
 *
 * 刻意不用 {@html} —— 片段来自用户的文件内容，拼 HTML 等于把文档当模板执行。
 * 大小写按 `toLowerCase` 对齐，与 `searchInText` 的匹配口径一致。
 */
export function segments(text: string, q: string): { t: string; hit: boolean }[] {
  const plain = [{ t: text, hit: false }];
  const needle = q.trim();
  if (!needle) return plain;

  const low = text.toLowerCase();
  const pin = needle.toLowerCase();
  const out: { t: string; hit: boolean }[] = [];
  let from = 0;

  for (;;) {
    const i = low.indexOf(pin, from);
    if (i < 0) break;
    if (i > from) out.push({ t: text.slice(from, i), hit: false });
    out.push({ t: text.slice(i, i + pin.length), hit: true });
    from = i + pin.length;
  }
  if (from < text.length) out.push({ t: text.slice(from), hit: false });
  return out.length > 0 ? out : plain;
}
