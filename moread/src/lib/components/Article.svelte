<script lang="ts">
  import { untrack } from 'svelte';
  import type { ScrollAnchor } from '../types';
  import { highlightDiagnostics, highlightIn } from '../markdown';
  import {
    DEFAULT_CONTENT_WIDTH, VIRTUAL_THRESHOLD,
    blockIndexAt, buildOffsets, buildTextIndex, estimateHeights,
    locateOccurrence, lowerBound, marginTopOf, parseBlocks, visibleRange,
    type Block, type TextIndex,
  } from '../virtual';

  interface Props {
    html: string;
    /** 滚动容器（App 持有），虚拟滚动与定位跳转都需要它 */
    container: HTMLElement | null;
    /** 正文字号（px）。只影响阅读域，UI 不跟着放大 */
    fontSize?: number;
    onOpenLink?: (href: string) => void;
  }

  let { html, container, fontSize = 15, onOpenLink }: Props = $props();

  /**
   * 字号倍率，与 CSS 的 --mr-read-scale 同一个数。
   *
   * 虚拟滚动的高度是按"每行装几个字 × 行高"估出来的，两者都跟字号直接相关：
   * 字号一改，全部估高立刻失效。所以它必须是重建 effect 的显式依赖。
   */
  const readScale = $derived(Math.max(0.5, fontSize / 15));

  let root = $state<HTMLDivElement | null>(null);

  /* ==================================================================
     虚拟滚动状态
     ================================================================== */

  // 块数组可能上千，用 raw 避免深层代理带来的无谓开销
  let blocks = $state.raw<Block[]>([]);
  /** 当前生效的高度（估算起步，逐块被实测覆盖） */
  let heights = $state.raw<number[]>([]);
  /** 原始估算值，只增不改 —— 校准要拿它跟实测比，拿 heights 比会恒等于 1 */
  let estimated = $state.raw<number[]>([]);
  let offsets = $state.raw<number[]>([]);
  let textIndex = $state.raw<TextIndex>({ full: '', starts: [] });

  let useVirtual = $state(false);
  let range = $state({ start: 0, end: 0 });

  let lastHtml = '';
  let measuredWidth = 0;
  /** 上次重算时用的字号倍率，用来判断"估高该不该重来" */
  let measuredScale = 1;

  /**
   * 宽度变化计数器。
   *
   * 正文宽度是在 untrack 里量的（不能进依赖图，否则每次测量都触发重算），
   * 结果就是"容器尺寸变了"这件事本身不会让重建 effect 重跑。
   * 之前只有换文档 / 首次挂载会重算估高；窗口变窄或拖拽侧栏时，
   * 行宽变了而估高还是按旧行宽算的，虚拟滚动的位置就会漂。
   * 由 ResizeObserver 显式踢一脚，值一变 effect 就重跑。
   */
  let widthToken = $state(0);

  /**
   * 记下"视口顶端停在哪一块、块内偏了多少"。
   *
   * 行宽一变，所有估高都得按新行宽重算，绝对滚动像素就没有可比性了：
   * 2832 块的文档里重排一次总高会变一万多像素，scrollTop 原样保留
   * 等于把读者往前推了几百块。块号 + 块内比例这个坐标在重排前后都成立。
   */
  function anchorAtPx(top: number): { index: number; frac: number } | null {
    if (heights.length === 0) return null;
    const i = Math.max(0, Math.min(heights.length - 1, lowerBound(offsets, top) - 1));
    const h = heights[i] || 1;
    return { index: i, frac: Math.max(0, Math.min(1, (top - offsets[i]) / h)) };
  }

  /** 已经实测过高度的块；未实测的仍用估算值 */
  const measuredIdx = new Set<number>();
  /** 是否已用首屏样本校准过全局估算偏差 */
  let calibrated = false;
  /** 上一帧是否贴在底部，用于修正后继续贴底 */
  let atBottom = false;

  /**
   * 最近一次 revealText 的落点，仅供开发期诊断。
   * 自动化测试靠它断言「点到第 N 条命中，确实滚到了第 N 次出现」——
   * 光看滚动后视口里有关键词是不够的，那无法区分第 1 处和第 4 处。
   */
  let lastReveal: { needle: string; ordinal: number; block: number; offset: number } | null = null;

  /**
   * ?novirtual=1 强制全量渲染。
   * 这是性能对比实验的对照组 —— 只有把同一篇文档在两种模式下测一遍，
   * 「虚拟滚动到底有没有用」才是个能被验证的结论，而不是一句主张。
   */
  const FORCE_FULL = typeof location !== 'undefined'
    && new URLSearchParams(location.search).get('novirtual') === '1';

  const HEAD_SEL = 'h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]';

  /** 首屏先渲染这么多块，避免打开瞬间白屏 */
  const INITIAL_CHUNK = 24;

  const topPad = $derived.by(() => {
    if (!useVirtual) return 0;
    const i = range.start;
    if (i >= blocks.length) return 0;
    return offsets[i] + marginTopOf(blocks[i], i);
  });

  const bottomPad = $derived.by(() => {
    if (!useVirtual) return 0;
    return Math.max(0, offsets[blocks.length] - offsets[range.end]);
  });

  const slice = $derived.by(() => {
    if (!useVirtual) return [] as { i: number; html: string }[];
    const out: { i: number; html: string }[] = [];
    for (let i = range.start; i < range.end && i < blocks.length; i++) {
      out.push({ i, html: blocks[i].html });
    }
    return out;
  });

  /* ==================================================================
     解析 / 重建
     ================================================================== */

  function contentWidth(): number {
    const sc = container;
    if (!sc) return DEFAULT_CONTENT_WIDTH;
    const cs = getComputedStyle(sc);
    const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    return Math.max(320, Math.min(sc.clientWidth - pad, DEFAULT_CONTENT_WIDTH));
  }

  function rebuild(width: number, scale: number) {
    const list = parseBlocks(html);
    blocks = list;
    estimated = estimateHeights(list, width, scale);
    heights = estimated.slice();
    offsets = buildOffsets(heights);
    textIndex = buildTextIndex(list);

    measuredIdx.clear();
    calibrated = false;
    atBottom = false;

    // 短文档不虚拟化：全量渲染在这种量级上更快，也不会引入边缘问题
    useVirtual = !FORCE_FULL && list.length > VIRTUAL_THRESHOLD;

    range = { start: 0, end: Math.min(list.length, INITIAL_CHUNK) };
    measuredWidth = width;
    measuredScale = scale;
  }

  // 内容变化 → 重新解析；容器就绪 → 用真实宽度估算
  $effect(() => {
    void widthToken; // 宽度变了要重算（见 widthToken 的说明），但别让测量本身进依赖图
    void readScale;  // 字号变了同理：行高与每行字数都变，估高必须重来
    const h = html;
    const sc = container;
    const hasContainer = !!sc;

    untrack(() => {
      const width = hasContainer ? contentWidth() : DEFAULT_CONTENT_WIDTH;
      const scale = readScale;
      if (h !== lastHtml) {
        lastHtml = h;
        rebuild(width, scale);
        // 换文档要把滚动位置归零，否则会停在上一篇的位置上
        if (sc) sc.scrollTop = 0;
        return;
      }
      // 只是容器尺寸 / 字号变了（首次挂载 / 窗口缩放 / 拖拽侧栏 / Ctrl+滚轮）：
      // 行宽和折行都变了，之前攒下的实测值也不再有效
      const widthChanged = Math.abs(width - measuredWidth) > 8;
      const scaleChanged = Math.abs(scale - measuredScale) > 1e-6;
      if (useVirtual && (widthChanged || scaleChanged)) {
        // 先记锚点再重算，否则 scrollTop 会按旧总高解释，位置整体跑掉
        const anchor = sc ? anchorAtPx(sc.scrollTop) : null;
        estimated = estimateHeights(blocks, width, scale);
        heights = estimated.slice();
        offsets = buildOffsets(heights);
        measuredIdx.clear();
        calibrated = false;
        measuredWidth = width;
        measuredScale = scale;
        if (sc && anchor) {
          sc.scrollTop = offsets[anchor.index] + anchor.frac * heights[anchor.index];
        }
        // offsets 换了，可见区间也必须按新表重算一次，否则这一帧还按旧偏移渲染
        scheduleRange();
      }
    });
  });

  /* ==================================================================
     可见区间
     ================================================================== */

  let rafId = 0;

  function scheduleRange() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      applyRange();
    });
  }

  function applyRange() {
    const sc = container;
    if (!sc || !useVirtual || blocks.length === 0) return;
    atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4;
    const next = visibleRange(offsets, sc.scrollTop, sc.clientHeight, blocks.length);
    if (next.start !== range.start || next.end !== range.end) range = next;
  }

  $effect(() => {
    const sc = container;
    if (!sc) return;

    const onScroll = () => scheduleRange();
    const ro = new ResizeObserver(() => {
      scheduleRange();
      // 行宽变了超过 8px 才重算，避免像素级抖动把估算反复推倒重来
      if (Math.abs(contentWidth() - measuredWidth) > 8) widthToken++;
    });

    sc.addEventListener('scroll', onScroll, { passive: true });
    ro.observe(sc);
    scheduleRange();

    return () => {
      sc.removeEventListener('scroll', onScroll);
      ro.disconnect();
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    };
  });

  /* ==================================================================
     渲染后测量 → 修正估算
     ================================================================== */

  /**
   * 估高必然有误差，所以每次可见区间变化后都实测一遍，把真实高度写回。
   *
   * 关键在补偿：如果某个块的实测高度变了，而它整体位于视口**上方**，
   * 它下方所有内容都会跟着位移。不把这个差值补回 scrollTop，用户就会看到
   * 正文在滚动时"抖一下"。
   */
  function measureVisible() {
    const r = root;
    const sc = container;
    if (!r || !sc || !useVirtual) return;

    const n = range.end - range.start;
    // 渲染出来的元素数必须与请求的块数一致，否则说明结构被包了一层，放弃测量
    if (n <= 0 || r.children.length !== n) return;

    const next = heights.slice();
    let deltaAbove = 0;
    let changed = false;

    for (let k = 0; k < n; k++) {
      const el = r.children[k] as HTMLElement;
      const i = range.start + k;
      measuredIdx.add(i);

      const want = marginTopOf(blocks[i], i) + el.offsetHeight;
      const old = next[i];
      if (Math.abs(want - old) <= 1) continue;

      if (offsets[i] + old <= sc.scrollTop) deltaAbove += want - old;
      next[i] = want;
      changed = true;
    }

    if (changed) {
      heights = next;
      offsets = buildOffsets(next);
      if (deltaAbove !== 0) sc.scrollTop += deltaAbove;
    }

    calibrateFromSample(sc, r);

    // 逐块修正会让文档逐渐变长。如果用户本来已经贴在底部，
    // 就把他继续留在底部 —— 否则拖到底会看不到最后一屏。
    if (changed && atBottom) sc.scrollTop = sc.scrollHeight - sc.clientHeight;

    scheduleRange();
  }

  /**
   * 用首屏样本校准全局估高偏差，只做一次。
   *
   * 估高不可能完全准。放任不管的话，累计误差会让滚动条长度明显失真 ——
   * 用户拖到底却发现还剩一大截。这里拿已渲染块的真实高度算出「实测／估算」
   * 比例，一次性摊到其余未实测的块上，把偏差压到感知阈值以下。
   */
  function calibrateFromSample(sc: HTMLElement, r: HTMLElement) {
    if (calibrated) return;
    const n = range.end - range.start;
    if (n < 8) return;
    calibrated = true;

    let estSum = 0;
    let realSum = 0;
    for (let k = 0; k < n; k++) {
      const i = range.start + k;
      // 必须拿**原始估算**当分母；heights 里已经被逐块改成实测值了，比出来的比例恒为 1
      estSum += estimated[i];
      realSum += marginTopOf(blocks[i], i) + (r.children[k] as HTMLElement).offsetHeight;
    }
    if (estSum <= 0) return;

    const ratio = realSum / estSum;
    // 偏差在 3% 以内就不折腾；超出 0.75–1.4 视为样本异常，不采信
    if (!Number.isFinite(ratio)) return;
    if (ratio > 0.97 && ratio < 1.03) return;
    if (ratio < 0.75 || ratio > 1.4) return;

    const next = heights.slice();
    let deltaAbove = 0;
    for (let i = 0; i < next.length; i++) {
      if (measuredIdx.has(i)) continue;
      const old = next[i];
      const val = old * ratio;
      if (offsets[i] + old <= sc.scrollTop) deltaAbove += val - old;
      next[i] = val;
    }

    heights = next;
    offsets = buildOffsets(next);
    if (deltaAbove !== 0) sc.scrollTop += deltaAbove;
  }

  /**
   * 单帧最多高亮多少个代码块。
   *
   * 权衡很直接：批量越大，代码块着色越快，但单帧被拉长约 1.5–2 ms/块。
   * 实测 12 块时滚动 p95 会到 25 ms（掉到 40 fps 边缘），降到 6 之后
   * 最差帧回到 20 ms 以内，而着色速度仍然是每秒 360 块 —— 够用。
   */
  const PAINT_BATCH = 6;
  let paintPending = false;
  const paintLog = { rounds: 0, lastRemaining: 0, error: null as string | null };

  /**
   * 给刚进入 DOM 的代码块上色。
   * 每帧只处理一批，剩下的排到下一帧 —— 否则一次滚动就能把当帧拖长几十毫秒。
   */
  function paintCode() {
    paintPending = false;
    const r = root;
    if (!r) return;
    try {
      const remaining = highlightIn(r, PAINT_BATCH);
      paintLog.rounds++;
      paintLog.lastRemaining = remaining;
      paintLog.error = null;
      if (remaining > 0 && !paintPending) {
        paintPending = true;
        requestAnimationFrame(paintCode);
      }
    } catch (err) {
      paintLog.error = err instanceof Error ? err.message : String(err);
    }
  }

  $effect(() => {
    // 依赖可见区间与当前块集合
    void range.start;
    void range.end;
    if (!useVirtual) return;
    const id = requestAnimationFrame(() => {
      paintCode();
      measureVisible();
    });
    return () => cancelAnimationFrame(id);
  });

  /**
   * 开发期把内部状态挂到 window 上。
   * 虚拟滚动的 bug 大多出在「估算 vs 实测」「可见区间」「滚动补偿」这三者的
   * 交互上，光看画面判断不出来，必须能读到这些数字。
   */
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__moreadArticle = {
      read: () => ({
        useVirtual,
        blocks: blocks.length,
        range: { ...range },
        totalHeight: offsets[blocks.length] ?? 0,
        renderedEls: root?.children.length ?? -1,
        measured: measuredIdx.size,
        calibrated,
        atBottom,
        paint: { ...paintLog, ...highlightDiagnostics() },
        pendingCode: root ? root.querySelectorAll('pre.mr-code-pending').length : -1,
        shikiBlocks: root ? root.querySelectorAll('.mr-codeblock .shiki').length : -1,
        lastReveal,
        scrollTop: container?.scrollTop ?? -1,
        viewHeight: container?.clientHeight ?? -1,
      }),
    };
  }

  /* ==================================================================
     点击委托：复制代码 / 链接
     ================================================================== */

  function handleClick(e: MouseEvent) {
    const el = e.target as HTMLElement | null;
    if (!el) return;

    const copyBtn = el.closest<HTMLElement>('[data-copy]');
    if (copyBtn) {
      const block = copyBtn.closest('.mr-codeblock');
      const text = block?.querySelector('code')?.textContent ?? '';
      navigator.clipboard?.writeText(text).then(
        () => {
          copyBtn.textContent = '已复制';
          window.setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
        },
        () => { copyBtn.textContent = '复制失败'; },
      );
      return;
    }

    const a = el.closest<HTMLAnchorElement>('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('#')) return;
    e.preventDefault();
    if (/^https?:/i.test(href)) {
      window.open(href, '_blank', 'noopener,noreferrer');
    } else if (/\.(md|markdown)(#.*)?$/i.test(href)) {
      onOpenLink?.(href);
    }
  }

  // 委托挂在容器上：虚拟化后块会被反复销毁重建，逐块绑定既浪费也会漏
  $effect(() => {
    const sc = container;
    if (!sc) return;
    sc.addEventListener('click', handleClick);
    return () => sc.removeEventListener('click', handleClick);
  });

  /* ==================================================================
     非虚拟化路径：编号 + 直接查询
     ================================================================== */

  function indexBlocks() {
    const r = root;
    if (!r || useVirtual) return;
    Array.from(r.children).forEach((el, i) => {
      (el as HTMLElement).dataset.bi = String(i);
    });
  }

  $effect(() => {
    void html;
    if (!useVirtual) {
      requestAnimationFrame(() => {
        indexBlocks();
        paintCode();
      });
    }
  });

  /* ==================================================================
     对外能力
     ================================================================== */

  /** 让第 idx 块进入 DOM 并滚到它顶上 */
  function scrollToBlock(idx: number, offsetWithinBlock = 0) {
    const sc = container;
    if (!sc || !blocks[idx]) return;
    const target = offsets[idx] + marginTopOf(blocks[idx], idx) + offsetWithinBlock - 20;
    sc.scrollTop = Math.max(0, target);
    applyRange();
    // 估算高度可能不准，等实测修正后再对一次
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = root?.children[idx - range.start] as HTMLElement | undefined;
      if (!el) return;
      const delta = el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 20;
      if (Math.abs(delta) > 2) sc.scrollTop += delta;
    }));
  }

  /** 滚动到某个标题 */
  export function jumpToHeading(id: string): void {
    const sc = container;
    if (!sc) return;

    if (useVirtual) {
      const idx = blocks.findIndex((b) => b.ids.includes(id));
      if (idx >= 0) { scrollToBlock(idx); return; }
    }

    const r = root;
    if (!r) return;
    const el = r.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
    if (!el) return;
    const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 20;
    sc.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  /** 在渲染后的 DOM 里按字符偏移找位置 */
  function scrollToChar(el: HTMLElement, charOffset: number, needleLen: number): boolean {
    const sc = container;
    if (!sc) return false;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let acc = 0;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const t = node.textContent ?? '';
      if (acc + t.length > charOffset) {
        const local = Math.max(0, Math.min(charOffset - acc, t.length));
        const rangeObj = document.createRange();
        rangeObj.setStart(node, local);
        rangeObj.setEnd(node, Math.min(local + needleLen, t.length));
        const rect = rangeObj.getBoundingClientRect();
        if (rect.height > 0) {
          sc.scrollTop += rect.top - sc.getBoundingClientRect().top - 130;
          return true;
        }
      }
      acc += t.length;
    }
    return false;
  }

  /**
   * 定位到第 ordinal 个（从 0 计）出现的文本。
   * 虚拟化下先在全文纯文本索引里算出「属于哪一块、块内什么位置」，
   * 再滚动 + 渲染 + 精确定位。
   */
  export function revealText(needle: string, ordinal: number): boolean {
    const sc = container;
    if (!sc || !needle) return false;

    if (useVirtual) {
      const hit = locateOccurrence(textIndex, needle, ordinal);
      if (!hit) { lastReveal = null; return false; }
      lastReveal = { needle, ordinal, block: hit.block, offset: hit.offset };
      scrollToBlock(hit.block, 0);
      const blockIdx = hit.block;
      const offset = hit.offset;
      // 目标块需要先进入 DOM 才能测量
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const el = root?.children[blockIdx - range.start] as HTMLElement | undefined;
        if (el) scrollToChar(el, offset, needle.length);
      }));
      return true;
    }

    const r = root;
    if (!r) { lastReveal = null; return false; }
    const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
    const target = needle.toLowerCase();
    let seen = 0;
    let node: Node | null;

    while ((node = walker.nextNode())) {
      const text = node.textContent?.toLowerCase() ?? '';
      let from = 0;
      for (;;) {
        const i = text.indexOf(target, from);
        if (i < 0) break;
        if (seen === ordinal) {
          lastReveal = { needle, ordinal, block: -1, offset: i };
          const rangeObj = document.createRange();
          rangeObj.setStart(node, i);
          rangeObj.setEnd(node, Math.min(i + target.length, (node.textContent ?? '').length));
          const rect = rangeObj.getBoundingClientRect();
          sc.scrollBy({ top: rect.top - sc.getBoundingClientRect().top - 130, behavior: 'smooth' });
          return true;
        }
        seen++;
        from = i + target.length;
      }
    }
    lastReveal = null;
    return false;
  }

  /**
   * 记录「现在看到哪儿了」。
   * 只记 scrollTop 不够 —— 外部改文件后内容长度会变，scrollTop 对应的
   * 已经不是同一段文字。所以再抓住当前锚点块及其块内偏移。
   */
  export function captureAnchor(): ScrollAnchor {
    const sc = container;
    if (!sc) return { scrollTop: 0, blockIndex: -1, blockOffset: 0, headingId: '' };

    // 虚拟化：直接从几何关系反推块序号，不依赖 DOM 里存在哪些块
    if (useVirtual && blocks.length > 0) {
      const idx = Math.max(0, lowerBound(offsets, sc.scrollTop) - 1);
      const block = blocks[idx];
      const heading = block?.ids.find((id) => /^[^:]*$/.test(id)) ?? '';
      return {
        scrollTop: sc.scrollTop,
        blockIndex: idx,
        blockOffset: sc.scrollTop - offsets[idx],
        headingId: heading,
      };
    }

    const r = root;
    if (!r) return { scrollTop: sc.scrollTop, blockIndex: -1, blockOffset: 0, headingId: '' };
    const base = sc.getBoundingClientRect().top;
    const kids = Array.from(r.children) as HTMLElement[];

    for (let i = 0; i < kids.length; i++) {
      const rect = kids[i].getBoundingClientRect();
      if (rect.bottom - base > 0) {
        return {
          scrollTop: sc.scrollTop,
          blockIndex: i,
          blockOffset: rect.top - base,
          headingId: kids[i].matches(HEAD_SEL) ? kids[i].id : '',
        };
      }
    }
    return { scrollTop: sc.scrollTop, blockIndex: -1, blockOffset: 0, headingId: '' };
  }

  /** 还原到锚点位置 */
  export function restoreAnchor(a: ScrollAnchor): void {
    const sc = container;
    if (!sc) return;

    if (useVirtual && blocks.length > 0) {
      // 内容变了，优先用标题这个语义锚点
      if (a.headingId) {
        const idx = blocks.findIndex((b) => b.ids.includes(a.headingId));
        if (idx >= 0) { scrollToBlock(idx); return; }
      }
      if (a.blockIndex >= 0 && a.blockIndex < blocks.length) {
        sc.scrollTop = Math.max(0, offsets[a.blockIndex] + a.blockOffset);
        applyRange();
        return;
      }
      sc.scrollTop = Math.min(a.scrollTop, Math.max(0, offsets[blocks.length] - sc.clientHeight));
      return;
    }

    const r = root;
    if (!r) return;
    const base = sc.getBoundingClientRect().top;

    if (a.headingId) {
      const h = r.querySelector<HTMLElement>(`[id="${CSS.escape(a.headingId)}"]`);
      if (h) {
        sc.scrollTop += (h.getBoundingClientRect().top - base) - 20;
        return;
      }
    }
    if (a.blockIndex >= 0) {
      const el = r.querySelector<HTMLElement>(`[data-bi="${a.blockIndex}"]`);
      if (el) {
        sc.scrollTop += (el.getBoundingClientRect().top - base) - a.blockOffset;
        return;
      }
    }
    sc.scrollTop = Math.min(a.scrollTop, Math.max(0, sc.scrollHeight - sc.clientHeight));
  }
</script>

{#if useVirtual}
  <!--
    虚拟化：只渲染视口附近的块（slice），上下用 padding 顶住总高度。
    块之间不加包装元素 —— `.mr-article > * + *` 那套排版规则依赖直接子元素关系。
    each 刻意排成紧凑单行，避免在正文里插入多余的空白文本节点。
  -->
  <article
    class="mr-article"
    bind:this={root}
    style:padding-top="{topPad}px"
    style:padding-bottom="{bottomPad}px"
  >{#each slice as b (b.i)}{@html b.html}{/each}</article>
{:else}
  <article class="mr-article" bind:this={root}>
    <!-- 内容已在 markdown.ts 里经 markdown-it 渲染 + DOMPurify 净化 -->
    {@html html}
  </article>
{/if}
