<script lang="ts">
  import { onMount, tick } from 'svelte';
  import TitleBar from './lib/components/TitleBar.svelte';
  import Sidebar from './lib/components/Sidebar.svelte';
  import SidebarRail from './lib/components/SidebarRail.svelte';
  import Article from './lib/components/Article.svelte';
  import EmptyState from './lib/components/EmptyState.svelte';
  import FolderPicker from './lib/components/FolderPicker.svelte';
  import { initHighlighter, renderMarkdown } from './lib/markdown';
  import {
    applyReadSize, applyTheme, clampReadSize, isPalette, readSize,
    readStoredPalette, readStoredReadSize, readStoredTheme, setReadSize, watchSystemTheme,
    type ResolvedTheme, type ThemeMode, type ThemePalette,
  } from './lib/tokens';
  import {
    relativeTime, samePath,
    type DocTab, type Hit, type HitGroup, type RecentItem, type ScrollAnchor,
    type SearchInfo, type SearchScope, type SearchState,
    type SidebarMode, type TabCloseMode, type Toast, type TreeNode, type TreeState,
  } from './lib/types';
  import {
    detectBackend, getHostInfo, isTauri, listWorkspace,
    onOpenFileRequested, pickFolder, pickMarkdownFile, readDoc,
    searchWorkspace, setWindowTitle, takePendingOpen, watchWorkspace,
    type BackendKind, type FsEvent, type HostInfo, type OpenedFile, type SearchResult,
  } from './lib/platform';
  import { MAX_HITS_PER_FILE, searchInText } from './lib/search';
  import sampleDoc from './lib/sample-doc.md?raw';

  /* ------------------------------------------------------------------
     常量
     ------------------------------------------------------------------ */

  const LS = {
    ws: 'moread.workspace',
    wss: 'moread.workspaces',
    recents: 'moread.recents',
    sidebarW: 'moread.sidebar-w',
  } as const;

  const SAMPLE_PATH = 'moread://sample/guide.md';

  /* ------------------------------------------------------------------
     状态
     ------------------------------------------------------------------ */

  // 宿主能力
  let backend = $state<BackendKind>('none');
  let host = $state<HostInfo | null>(null);

  // 工作区
  let workspacePath = $state('');
  let tree = $state<TreeNode[]>([]);
  let treeState = $state<TreeState>('idle');
  let treeError = $state('');
  let recentWorkspaces = $state<string[]>([]);
  let pickerOpen = $state(false);

  // 文档
  let ready = $state(false);
  let tabs = $state<DocTab[]>([]);
  let activeId = $state('');
  let recents = $state<RecentItem[]>([]);

  // 界面
  let sidebarMode = $state<SidebarMode>('outline');
  let sidebarCollapsed = $state(false);
  let query = $state('');
  let themeMode = $state<ThemeMode>('light');
  let themePalette = $state<ThemePalette>('paper');
  let resolved = $state<ResolvedTheme>('light');
  /** 正文字号（px），只作用于阅读域 */
  let fontSize = $state<number>(readSize.def);
  let currentHeadingId = $state('');
  let progress = $state(0);
  let dropped = $state(false);

  /* ------------------------------------------------------------------
     侧栏宽度（可拖拽）
     ------------------------------------------------------------------ */

  /**
   * 240px 默认、200–480px 手动可调 —— 这个区间是 tokens.css 里早就写下的，
   * 之前只是没法改。上限还要受窗口约束：480 在 900px 宽的窗口里会把正文挤没，
   * 所以再压一道 "留 420px 给正文"。
   */
  const SIDEBAR_MIN = 200;
  const SIDEBAR_MAX = 480;
  const SIDEBAR_DEFAULT = 240;
  /** 正文至少留这么多，超了不许再往右拖 */
  const CONTENT_MIN = 420;

  let sidebarW = $state(SIDEBAR_DEFAULT);
  let resizing = $state(false);

  function clampSidebarW(w: number): number {
    const ceiling = Math.max(
      SIDEBAR_MIN,
      Math.min(SIDEBAR_MAX, window.innerWidth - CONTENT_MIN),
    );
    return Math.round(Math.min(Math.max(w, SIDEBAR_MIN), ceiling));
  }

  function persistSidebarW() {
    try { localStorage.setItem(LS.sidebarW, String(sidebarW)); } catch { /* 同上 */ }
  }

  /**
   * 拖动改宽度。
   *
   * 宽度直接取指针的 clientX，而不是累加每次的位移：
   * 侧栏永远贴着窗口左边缘，一次绝对取值就够；累加式在掉帧或指针移出窗口
   * 再回来时会把误差留下来，越拖越偏。
   *
   * 监听挂在 window 上，指针捕获只当额外保险 —— 实测有些环境（CDP 注入的
   * 合成鼠标事件）setPointerCapture 会**返回成功却不真的重定向事件**，
   * 于是 pointermove 全落在 window 上、拖拽条一动不动。与其赌捕获生效，
   * 不如收 window 的事件：捕获有效时事件照样冒泡到 window，两条路都通。
   */
  function startSidebarDrag(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    try { handle.setPointerCapture(e.pointerId); } catch { /* 不支持就算了 */ }
    resizing = true;

    const onMove = (ev: PointerEvent) => {
      // 键盘/程序里丢过一次 pointerup 时，这里兜住：没有按键按下就说明已经松手了
      if (ev.buttons === 0) { onEnd(); return; }
      sidebarW = clampSidebarW(ev.clientX);
    };
    const onEnd = () => {
      resizing = false;
      try { handle.releasePointerCapture(e.pointerId); } catch { /* 早就没了 */ }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      window.removeEventListener('blur', onEnd);
      persistSidebarW();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    window.addEventListener('blur', onEnd);
  }

  /** 键盘也能调（无障碍）：←/→ 8px，Shift 32px，Home/End 到两端 */
  function onGutterKey(e: KeyboardEvent) {
    const step = e.shiftKey ? 32 : 8;
    if (e.key === 'ArrowLeft') sidebarW = clampSidebarW(sidebarW - step);
    else if (e.key === 'ArrowRight') sidebarW = clampSidebarW(sidebarW + step);
    else if (e.key === 'Home') sidebarW = clampSidebarW(SIDEBAR_MIN);
    else if (e.key === 'End') sidebarW = clampSidebarW(SIDEBAR_MAX);
    else return;
    e.preventDefault();
    persistSidebarW();
  }

  function resetSidebarW() {
    sidebarW = clampSidebarW(SIDEBAR_DEFAULT);
    persistSidebarW();
  }

  // 拖动期间锁住全局光标与选区：否则移到正文上光标变 I 形、还会顺手选中一段文字
  $effect(() => {
    const on = resizing;
    document.body.classList.toggle('is-resizing', on);
    return () => document.body.classList.remove('is-resizing');
  });
  let toasts = $state<Toast[]>([]);

  let contentEl = $state<HTMLElement | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  // Svelte 5 的组件实例类型在模板里不好收窄，这里显式放开
  let articleRef = $state<any>(null);

  let nextId = 0;
  let toastSeq = 0;

  const activeTab = $derived(tabs.find((t) => t.id === activeId) ?? null);

  const workspaceName = $derived.by(() => {
    if (!workspacePath) return '';
    const parts = workspacePath.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts[parts.length - 1] ?? workspacePath;
  });

  /** 渲染当前文档（净化后的 HTML + 大纲） */
  const rendered = $derived.by(() => {
    if (!ready || !activeTab) {
      return { html: '', headings: [] as ReturnType<typeof renderMarkdown>['headings'] };
    }
    return renderMarkdown(activeTab.source);
  });

  /* ------------------------------------------------------------------
     搜索
     ------------------------------------------------------------------ */

  /** 防抖窗口：更短的停顿不值得发一次全盘扫描 */
  const SEARCH_DEBOUNCE = 220;

  let searchState = $state<SearchState>('idle');
  let hitGroups = $state<HitGroup[]>([]);
  let searchInfo = $state<SearchInfo | null>(null);

  /** 有工作区就搜磁盘（含未打开的文档），否则退化为「搜已打开的标签」 */
  const searchScope = $derived<SearchScope>(
    workspacePath && backend !== 'none' ? 'workspace' : 'tabs',
  );

  /** 递增序号：响应回来时若已不是最新一次，直接丢弃，避免旧结果覆盖新结果 */
  let searchSeq = 0;
  let searchTimer: number | null = null;

  /**
   * 分组排序：当前打开的那篇排最前（多半就是用户正在看的），其余按文件名排。
   *
   * 排序放在前端而不是后端，是为了让浏览器桥和 Rust 两套实现不必在
   * 「目录遍历顺序」上强求一致 —— 那是文件系统的脾气，不是产品的语义。
   */
  function activeFirst(groups: HitGroup[], active: string): HitGroup[] {
    const sorted = [...groups].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    if (!active) return sorted;
    const head = sorted.filter((g) => samePath(g.path, active));
    if (head.length === 0) return sorted;
    return [...head, ...sorted.filter((g) => !samePath(g.path, active))];
  }

  const orderedGroups = $derived(activeFirst(hitGroups, activeTab?.path ?? ''));

  /** 已打开文档内的检索：同步完成，给输入即时反馈 */
  function groupsFromTabs(needle: string): { groups: HitGroup[]; total: number } {
    const groups: HitGroup[] = [];
    let total = 0;

    for (const tab of tabs) {
      const { matches, count } = searchInText(tab.source, needle, { maxHits: MAX_HITS_PER_FILE });
      if (matches.length === 0) continue;

      total += matches.length;
      groups.push({
        path: tab.path,
        name: tab.name,
        relPath: '',
        total: count,
        hits: matches.map((m) => ({
          path: tab.path,
          name: tab.name,
          line: m.line,
          ordinal: m.ordinal,
          snippet: m.snippet,
          tabId: tab.id,
        })),
      });
    }

    return { groups, total };
  }

  /** 后端返回的搜索结果 → 侧栏用的分组结构 */
  function groupsFromResult(res: SearchResult): HitGroup[] {
    return res.files.map((f) => ({
      path: f.path,
      name: f.name,
      relPath: f.relPath,
      total: f.count,
      hits: f.matches.map((m) => ({
        path: f.path,
        name: f.name,
        relPath: f.relPath,
        line: m.line,
        ordinal: m.ordinal,
        snippet: m.snippet,
      })),
    }));
  }

  function scheduleSearch(needle: string, scope: SearchScope, root: string) {
    // 任何一次新调用都让在途请求失效
    searchSeq++;
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }

    if (!needle) {
      hitGroups = [];
      searchInfo = null;
      searchState = 'idle';
      return;
    }

    if (scope === 'tabs') {
      const { groups, total } = groupsFromTabs(needle);
      hitGroups = groups;
      searchInfo = {
        totalMatches: total,
        scannedFiles: tabs.length,
        truncated: false,
        elapsedMs: 0,
      };
      searchState = 'ready';
      return;
    }

    searchState = 'loading';
    const seq = searchSeq;

    searchTimer = window.setTimeout(() => {
      searchTimer = null;
      void (async () => {
        try {
          const res = await searchWorkspace(root, needle);
          if (seq !== searchSeq) return; // 更新的搜索已经发出，这份结果作废
          hitGroups = groupsFromResult(res);
          searchInfo = {
            totalMatches: res.totalMatches,
            scannedFiles: res.scannedFiles,
            truncated: res.truncated,
            elapsedMs: res.elapsedMs,
          };
          searchState = 'ready';
        } catch (err) {
          if (seq !== searchSeq) return;
          hitGroups = [];
          searchInfo = null;
          searchState = 'error';
          console.warn('[moread] 工作区搜索失败：', err);
        }
      })();
    }, SEARCH_DEBOUNCE);
  }

  // query 或扫描范围一变就重跑搜索
  $effect(() => {
    const needle = query.trim();
    const scope = searchScope;
    // 只有「标签内检索」需要随标签集合变化重跑；工作区检索与内存里的标签无关
    if (scope === 'tabs') void tabs.length;
    const root = workspacePath;
    scheduleSearch(needle, scope, root);
  });

  // 窗口标题跟随当前文档。自绘标题栏不显示它，但任务栏悬停 / Alt+Tab 读的是这个
  $effect(() => {
    const t = activeTab;
    void setWindowTitle(t ? `${t.name} — MoRead` : 'MoRead');
  });

  /* ------------------------------------------------------------------
     轻提示
     ------------------------------------------------------------------ */

  function toastShow(text: string, kind: Toast['kind'] = 'info', ms = 2600) {
    const id = ++toastSeq;
    toasts = [...toasts, { id, text, kind }];
    window.setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
    }, ms);
  }

  /* ------------------------------------------------------------------
     本地持久化
     ------------------------------------------------------------------ */

  function loadPersisted() {
    try {
      workspacePath = localStorage.getItem(LS.ws) ?? '';
      recentWorkspaces = JSON.parse(localStorage.getItem(LS.wss) ?? '[]');
      recents = JSON.parse(localStorage.getItem(LS.recents) ?? '[]');
      // 上一次拖到的宽度。存的是数值，非法值（被手改过 / 旧版本残留）直接忽略
      const w = Number(localStorage.getItem(LS.sidebarW));
      if (Number.isFinite(w) && w > 0) sidebarW = clampSidebarW(w);
    } catch {
      workspacePath = '';
      recentWorkspaces = [];
      recents = [];
    }
  }

  function persistRecents() {
    try {
      localStorage.setItem(LS.recents, JSON.stringify(recents.slice(0, 8)));
    } catch { /* 隐私模式等场景静默忽略 */ }
  }

  function persistWorkspaces() {
    try {
      localStorage.setItem(LS.wss, JSON.stringify(recentWorkspaces.slice(0, 6)));
    } catch { /* 同上 */ }
  }

  function pushRecent(name: string, path: string, kind: 'file' | 'dir') {
    const timeMs = Date.now();
    const item: RecentItem = { name, path, kind, timeMs, time: relativeTime(timeMs) };
    recents = [item, ...recents.filter((r) => !(r.kind === kind && samePath(r.path, path)))].slice(0, 8);
    persistRecents();
  }

  function pushRecentWorkspace(root: string) {
    recentWorkspaces = [root, ...recentWorkspaces.filter((p) => !samePath(p, root))].slice(0, 6);
    persistWorkspaces();
  }

  /* ------------------------------------------------------------------
     启动
     ------------------------------------------------------------------ */

  // 主题要在首帧前定下来，避免先浅后深闪一下。
  // index.html 里的 boot 脚本已经写过 DOM，这里同步组件状态，保证后续
  // toggleTheme 的判断基准与视觉一致。刻意用局部常量而非读取 state：
  // 在脚本顶层读 $state 只会拿到初始值，属于自找的 bug。
  {
    const params = new URLSearchParams(location.search);
    const forced = params.get('theme');
    const forcedPalette = params.get('palette');
    const initial: ThemeMode =
      forced === 'light' || forced === 'dark' || forced === 'system'
        ? forced
        : readStoredTheme();
    const initialPalette: ThemePalette = isPalette(forcedPalette)
      ? forcedPalette
      : readStoredPalette();
    themeMode = initial;
    themePalette = initialPalette;
    resolved = applyTheme(initial, initialPalette);
  }

  // 字号同样要在首帧前落定，否则正文会先按 15px 排一遍再被拉大
  {
    const forcedFs = Number(new URLSearchParams(location.search).get('fs'));
    fontSize = applyReadSize(Number.isFinite(forcedFs) && forcedFs > 0
      ? forcedFs
      : readStoredReadSize());
  }

  onMount(() => {
    loadPersisted();

    const stopWatchTheme = watchSystemTheme((t) => {
      document.documentElement.dataset.theme = t;
      resolved = t;
    });

    let stopSystemThemeForced = () => {};
    if (!new URLSearchParams(location.search).get('theme')) stopSystemThemeForced = stopWatchTheme;

    /*
      Ctrl / Cmd + 滚轮改正文字号。

      两处容易踩的地方：
      1. 必须显式 passive: false —— 挂在 window 上的 wheel 被 Chrome 默认按 passive 处理，
         那样 preventDefault() 无效，WebView2 会连整页一起缩放，和字号叠加成"双倍放大"。
      2. 要节流：触控板一秒能发几十个 wheel 事件，不节流会把字号从 15 直接推到底。
         一格滚轮（deltaY=100）恰好一档，是用户预期的节奏。
    */
    let lastZoomAt = 0;
    const onWheelZoom = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (e.deltaY === 0) return;
      const now = performance.now();
      if (now - lastZoomAt < 80) return;
      lastZoomAt = now;
      bumpFont(e.deltaY < 0 ? 1 : -1);
    };
    window.addEventListener('wheel', onWheelZoom, { passive: false });

    void initHighlighter().finally(() => { ready = true; });

    let stopNativeDrop: (() => void) | null = null;
    let stopOpenFile: (() => void) | null = null;

    void (async () => {
      backend = await detectBackend();
      host = getHostInfo();

      // ?ws=<路径> 允许直接指定工作区：调试与自动化截图都靠它，优先级高于上次会话
      const wsParam = new URLSearchParams(location.search).get('ws');
      const initialWs = wsParam || workspacePath;

      if (isTauri) {
        stopNativeDrop = await setupNativeDrop();
        sidebarMode = 'files';

        // 文件关联：**先挂监听，再取队列** —— 顺序反过来，
        // 两步之间进来的请求就没人接了（冷启动双击 .md 正是这条路径）。
        stopOpenFile = await onOpenFileRequested((p) => { void openExternalFile(p); });
        const pending = await takePendingOpen();

        if (pending.length > 0) {
          // 用户已经指名了要打开的文件，就别再恢复上次的工作区去抢焦点
          void (async () => {
            for (const p of pending) await openExternalFile(p);
          })();
        } else if (initialWs) {
          void openWorkspace(initialWs, { silent: true });
        }
      } else if (backend === 'http' && initialWs) {
        sidebarMode = 'files';
        void openWorkspace(initialWs, { silent: true });
      }

      // 完全没有文件系统能力时（静态托管），给一篇示例，至少不是白屏
      if (backend === 'none' && tabs.length === 0) {
        loadSample();
        sidebarMode = 'outline';
      }
    })();

    return () => {
      stopSystemThemeForced();
      stopWatch?.();
      stopNativeDrop?.();
      stopOpenFile?.();
      window.removeEventListener('wheel', onWheelZoom);
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  });

  /* ------------------------------------------------------------------
     工作区
     ------------------------------------------------------------------ */

  async function openFolderDialog() {
    // Tauri：原生目录选择器；其余环境：内置选择面板
    if (backend === 'tauri') {
      const picked = await pickFolder();
      if (picked) { await openWorkspace(picked); return; }
      return;
    }
    pickerOpen = true;
  }

  async function openWorkspace(
    root: string,
    opts: { silent?: boolean; skipAutoOpen?: boolean } = {},
  ) {
    pickerOpen = false;
    if (!root) return;

    const changed = !samePath(root, workspacePath);
    workspacePath = root;
    treeState = 'loading';
    treeError = '';
    if (changed) tree = [];

    try {
      localStorage.setItem(LS.ws, root);
    } catch { /* 忽略 */ }

    try {
      const nodes = await listWorkspace(root);
      tree = nodes.map((n) => ({
        name: n.name, path: n.path, kind: n.kind, depth: n.depth,
        size: n.size, mtime: n.mtime,
      }));
      treeState = 'ready';
    } catch (err) {
      treeState = 'error';
      treeError = err instanceof Error ? err.message : String(err);
      if (!opts.silent) toastShow(`打开工作区失败：${treeError}`, 'error', 4200);
      return;
    }

    pushRecentWorkspace(root);
    if (changed) sidebarMode = 'files';

    // 首次进入工作区若还没有打开的文档，自动打开第一篇 —— 少一次点击。
    // 文件关联不走这条：用户点名了要开哪个文件，多开一篇只会添乱。
    if (!opts.skipAutoOpen && tabs.length === 0) {
      const first = tree.find((n) => n.kind === 'file');
      if (first) await openTreeFile(first);
    }

    await startWatch();
  }

  async function refreshTree(opts: { announce?: boolean } = {}) {
    if (!workspacePath) return;
    try {
      const nodes = await listWorkspace(workspacePath);
      tree = nodes.map((n) => ({
        name: n.name, path: n.path, kind: n.kind, depth: n.depth,
        size: n.size, mtime: n.mtime,
      }));
      treeState = 'ready';
      treeError = '';
      if (opts.announce) toastShow('已重新扫描工作区', 'info', 1800);
    } catch (err) {
      treeState = 'error';
      treeError = err instanceof Error ? err.message : String(err);
    }
  }

  let refreshTimer: number | null = null;
  function scheduleTreeRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => { void refreshTree(); }, 420);
  }

  /* ------------------------------------------------------------------
     文件监听
     ------------------------------------------------------------------ */

  let stopWatch: (() => void) | null = null;

  async function startWatch() {
    stopWatch?.();
    stopWatch = null;
    if (!workspacePath || backend === 'none') return;
    // ?nowatch=1 关闭监听。事件流会一直占着连接，自动化截图 / 无头渲染时
    // 拿不到 network-idle，这个开关同时也是排查性能问题的入口。
    if (new URLSearchParams(location.search).get('nowatch') === '1') return;
    stopWatch = await watchWorkspace(workspacePath, onFsEvent);
  }

  function onFsEvent(e: FsEvent) {
    scheduleTreeRefresh();

    const tab = tabs.find((t) => samePath(t.path, e.path));
    if (!tab) return;

    // 外部改动 → 自动重载，并把阅读位置放回原处
    void reloadTab(tab, { keepScroll: tab.id === activeId, announce: true });
  }

  async function reloadTab(tab: DocTab, opts: { keepScroll?: boolean; announce?: boolean } = {}) {
    const anchor: ScrollAnchor | null = opts.keepScroll ? (articleRef?.captureAnchor() ?? null) : null;
    try {
      const file = await readDoc(tab.path);
      tabs = tabs.map((t) => (t.id === tab.id
        ? {
            ...t,
            source: file.source,
            size: file.size,
            mtime: file.mtime,
            encoding: file.encoding,
            missing: false,
            stale: false,
          }
        : t));

      if (anchor) {
        await tick();
        // 等一帧，让 Shiki / KaTeX 的异步内容落位后再对锚点
        requestAnimationFrame(() => articleRef?.restoreAnchor(anchor));
      }
      if (opts.announce) toastShow(`${tab.name} 已在磁盘上更新，已重新载入`, 'info');
    } catch (err) {
      tabs = tabs.map((t) => (t.id === tab.id ? { ...t, missing: true } : t));
      const msg = err instanceof Error ? err.message : String(err);
      toastShow(`${tab.name} 无法读取：${msg}`, 'warn', 4500);
    }
  }

  /* ------------------------------------------------------------------
     打开文档
     ------------------------------------------------------------------ */

  function addTab(file: OpenedFile) {
    const existing = tabs.find((t) => samePath(t.path, file.path));
    if (existing) { activeId = existing.id; return; }

    const id = file.path || `file-${++nextId}`;
    tabs = [...tabs, {
      id,
      name: file.name,
      path: file.path,
      source: file.source,
      size: file.size,
      mtime: file.mtime,
      encoding: file.encoding,
      openedAt: relativeTime(file.mtime),
    }];
    activeId = id;
    currentHeadingId = '';
    pushRecent(file.name, file.path, 'file');
  }

  async function openTreeFile(node: TreeNode) {
    if (tabs.some((t) => samePath(t.path, node.path))) {
      activeId = tabs.find((t) => samePath(t.path, node.path))!.id;
      return;
    }
    try {
      addTab(await readDoc(node.path));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toastShow(`打开失败：${msg}`, 'error', 4200);
    }
  }

  /**
   * 「用 MoRead 打开某个文件」—— 文件关联（双击 .md）与第二实例都走这里。
   *
   * 与拖放的区别：拖放时用户多半已经有工作区，直接开标签就行；
   * 而双击 .md 通常是冷启动，此时侧栏、搜索范围都还空着。
   * 所以没有工作区时，把**文件所在目录**立为工作区 ——
   * 否则用户看到的是一个孤零零的标签，左边空荡荡。
   */
  async function openExternalFile(rawPath: string) {
    const p = rawPath.trim().replace(/^"|"$/g, '');
    if (!p || !/\.(md|markdown)$/i.test(p)) return;

    const dir = p.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    if (!workspacePath && dir) {
      await openWorkspace(dir, { silent: true, skipAutoOpen: true });
    }

    try {
      addTab(await readDoc(p));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toastShow(`无法打开：${msg}`, 'error', 4200);
    }
  }

  async function openFileDialog() {
    if (backend === 'tauri') {
      try {
        const picked = await pickMarkdownFile();
        if (picked) { addTab(await readDoc(picked)); return; }
        return;
      } catch (err) {
        console.error('[moread] 原生文件对话框失败，回退到 Web 选择器：', err);
      }
    }
    fileInput?.click();
  }

  async function onFilePicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      addTab({
        name: file.name,
        path: file.name,
        source: await file.text(),
        size: file.size,
        mtime: file.lastModified,
      });
    } catch (err) {
      console.error('[moread] 读取文件失败：', err);
      toastShow('读取文件失败', 'error');
    }
  }

  function loadSample() {
    if (tabs.some((t) => t.path === SAMPLE_PATH)) {
      activeId = tabs.find((t) => t.path === SAMPLE_PATH)!.id;
      return;
    }
    addTab({
      name: 'guide.md',
      path: SAMPLE_PATH,
      source: sampleDoc,
      size: new Blob([sampleDoc]).size,
      mtime: Date.now(),
    });
  }

  /** 打开「最近」里的一项：目录 → 工作区，文件 → 文档 */
  async function openRecent(item: RecentItem) {
    if (item.kind === 'dir') { await openWorkspace(item.path); return; }
    if (item.path.startsWith('moread://')) { loadSample(); return; }
    try {
      addTab(await readDoc(item.path));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toastShow(`无法打开 ${item.name}：${msg}`, 'error', 4200);
    }
  }

  /* ------------------------------------------------------------------
     文档内相对链接
     ------------------------------------------------------------------ */

  /**
   * 把文内相对链接解析成绝对路径。
   * 只处理 Markdown 之间互链这一种情况，与「只读阅读器」的定位一致。
   */
  function resolveRelative(dir: string, href: string): string {
    const clean = href.split('#')[0].split('?')[0].trim();
    if (!clean) return '';
    const p = clean.replace(/\\/g, '/');
    if (/^[a-zA-Z]:/.test(p) || p.startsWith('/')) return p;

    const segs = dir.replace(/\\/g, '/').split('/').filter(Boolean);
    for (const s of p.split('/')) {
      if (s === '.' || s === '') continue;
      if (s === '..') segs.pop();
      else segs.push(s);
    }
    return segs.join('/');
  }

  async function onOpenLink(href: string) {
    const base = activeTab?.path ?? '';
    if (!base || base.startsWith('moread://') || !base.includes('/')) {
      toastShow('这篇文档没有磁盘位置，无法跳转内部链接', 'warn', 2400);
      return;
    }
    const dir = base.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    const abs = resolveRelative(dir, href);
    if (!abs) return;

    if (tabs.some((t) => samePath(t.path, abs))) {
      activeId = tabs.find((t) => samePath(t.path, abs))!.id;
      return;
    }
    try {
      addTab(await readDoc(abs));
    } catch (err) {
      toastShow(`链接目标打不开：${err instanceof Error ? err.message : String(err)}`, 'warn', 3600);
    }
  }

  /* ------------------------------------------------------------------
     拖放
     ------------------------------------------------------------------ */

  /** 桌面端：拿得到真实路径，拖文件夹可以直接开工作区 */
  async function setupNativeDrop(): Promise<() => void> {
    try {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      return await getCurrentWebview().onDragDropEvent(async (ev) => {
        const p = ev.payload;
        if (p.type === 'over') { dropped = true; return; }
        if (p.type === 'leave') { dropped = false; return; }
        if (p.type !== 'drop') return;
        dropped = false;
        for (const path of p.paths ?? []) handleDroppedPath(path);
      });
    } catch (err) {
      console.warn('[moread] 原生拖放不可用：', err);
      return () => {};
    }
  }

  async function handleDroppedPath(path: string) {
    if (/\.(md|markdown)$/i.test(path)) {
      try {
        addTab(await readDoc(path));
      } catch (err) {
        toastShow(`无法打开：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
      return;
    }
    // 目录（或没有扩展名的路径）按工作区处理
    await openWorkspace(path);
  }

  /** 浏览器预览：只能拿到 File 对象 */
  function onDrop(e: DragEvent) {
    e.preventDefault();
    dropped = false;
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => /\.(md|markdown)$/i.test(f.name));
    if (files.length === 0) {
      toastShow('只支持拖入 .md / .markdown 文件', 'warn');
      return;
    }
    files.forEach(async (file) => {
      try {
        addTab({
          name: file.name,
          path: file.name,
          source: await file.text(),
          size: file.size,
          mtime: file.lastModified,
        });
      } catch (err) {
        console.error('[moread] 读取拖入文件失败：', err);
      }
    });
  }

  /* ------------------------------------------------------------------
     标签
     ------------------------------------------------------------------ */

  function closeTab(id: string) {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;

    // 固定标签的拦截必须放在这里，而不是只藏掉关闭按钮。
    // Ctrl+W、鼠标中键、批量关闭都绕过按钮，只在 UI 上藏是假保护。
    if (tabs[idx].pinned) {
      toastShow('这个标签已固定，先取消固定再关闭', 'warn', 2600);
      return;
    }

    tabs = tabs.filter((t) => t.id !== id);
    if (activeId === id) {
      const next = tabs[Math.min(idx, tabs.length - 1)];
      activeId = next ? next.id : '';
    }
  }

  /**
   * 批量关闭。锚点是被右键点中的那个标签，其余按它左右的位置算。
   * 固定标签在每一档里都跳过 —— 包括「关闭全部」。
   */
  function closeTabsBy(mode: TabCloseMode, anchorId: string) {
    const idx = tabs.findIndex((t) => t.id === anchorId);
    if (idx < 0) return;

    const before = tabs;
    const drop = new Set<string>();
    before.forEach((t, i) => {
      if (t.pinned) return;
      const hit =
        mode === 'all' ? true
        : mode === 'others' ? i !== idx
        : mode === 'left' ? i < idx
        : mode === 'right' ? i > idx
        : i === idx; // 'self'
      if (hit) drop.add(t.id);
    });

    if (drop.size === 0) {
      toastShow('剩下的都是固定标签，不会被关闭', 'warn', 2400);
      return;
    }

    const after = before.filter((t) => !drop.has(t.id));
    tabs = after;

    // 当前标签被关掉时，接管离它最近的那个（同距时取右边的）
    if (!after.some((t) => t.id === activeId)) {
      const activeIdx = before.findIndex((t) => t.id === activeId);
      let bestId = '';
      let bestDist = Number.POSITIVE_INFINITY;
      for (const t of after) {
        const i = before.indexOf(t);
        const dist = Math.abs(i - activeIdx);
        if (dist < bestDist || (dist === bestDist && i > activeIdx)) {
          bestDist = dist;
          bestId = t.id;
        }
      }
      activeId = bestId;
    }
  }

  function togglePin(id: string) {
    tabs = tabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t));
  }

  /** 拖拽换位：把 fromId 插到 toId 的前面或后面 */
  function reorderTab(fromId: string, toId: string, side: 'before' | 'after') {
    if (fromId === toId) return;
    const moving = tabs.find((t) => t.id === fromId);
    if (!moving) return;

    const rest = tabs.filter((t) => t.id !== fromId);
    let at = rest.findIndex((t) => t.id === toId);
    if (at < 0) return;
    if (side === 'after') at += 1;

    tabs = [...rest.slice(0, at), moving, ...rest.slice(at)];
  }

  function cycleTab(dir: number) {
    if (tabs.length < 2) return;
    const idx = tabs.findIndex((t) => t.id === activeId);
    activeId = tabs[(idx + dir + tabs.length) % tabs.length].id;
  }

  /* ------------------------------------------------------------------
     大纲 / 滚动
     ------------------------------------------------------------------ */

  function onScroll() {
    const el = contentEl;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    progress = max > 8 ? Math.min(1, el.scrollTop / max) : 0;

    const heads = el.querySelectorAll<HTMLElement>('.mr-article h1[id], .mr-article h2[id], .mr-article h3[id]');
    const base = el.getBoundingClientRect().top;
    let cur = '';
    for (const h of heads) {
      if (h.getBoundingClientRect().top - base <= 72) cur = h.id;
      else break;
    }
    currentHeadingId = cur;
  }

  function jumpToHeading(id: string) {
    articleRef?.jumpToHeading(id);
  }

  /**
   * 跳到某条命中。
   *
   * 命中可能来自一个**尚未打开**的文件，所以顺序是：先确保目标成为当前标签，
   * 再等渲染完成，最后按 ordinal 精确滚动。
   *
   * 用 ordinal 而不是行号：行号是源文件的坐标，正文里根本没有这个概念 ——
   * 正文只知道「这是第几次出现」。
   */
  async function goToHit(hit: Hit) {
    const needle = query.trim();
    if (!needle) return;

    const opened = tabs.find((t) => samePath(t.path, hit.path));
    if (opened) {
      activeId = opened.id;
    } else {
      try {
        addTab(await readDoc(hit.path));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toastShow(`无法打开 ${hit.name}：${msg}`, 'error', 4200);
        return;
      }
    }

    await tick();
    requestAnimationFrame(() => {
      const ok = articleRef?.revealText(needle, hit.ordinal);
      if (ok === false) toastShow('未能在正文里定位这一处', 'warn', 2200);
    });
  }

  /* ------------------------------------------------------------------
     主题：色调 × 浅深
     ------------------------------------------------------------------ */

  /** 选一套主题：色调 + 浅深同时落定，并写进 localStorage */
  function pickTheme(palette: ThemePalette, scheme: ResolvedTheme) {
    themePalette = palette;
    themeMode = scheme;
    resolved = applyTheme(scheme, palette);
    persistTheme(scheme, palette);
  }

  /**
   * 跟随系统只决定浅深，不动色调 ——
   * "我白天晚上用不同的亮度，但一直是竹青" 是合理诉求，反过来则不是。
   */
  function followSystem(on: boolean) {
    if (on) {
      themeMode = 'system';
      resolved = applyTheme('system', themePalette);
      persistTheme('system', themePalette);
    } else {
      // 关掉时把当前看到的浅深钉住，否则会立刻跳回上一次的固定值
      pickTheme(themePalette, resolved);
    }
  }

  function persistTheme(mode: ThemeMode, palette: ThemePalette) {
    try {
      localStorage.setItem('moread.theme', mode);
      localStorage.setItem('moread.palette', palette);
    } catch { /* 忽略 */ }
  }

  /* ------------------------------------------------------------------
     正文字号
     ------------------------------------------------------------------ */

  /** 只动阅读域字号：UI 尺寸由 tokens.css 的 :root 值决定，这里不碰 */
  function changeFont(next: number) {
    const px = clampReadSize(next);
    if (px === fontSize) return;
    fontSize = px;
    setReadSize(px);
  }

  /** 一次一档；Ctrl+滚轮 / Ctrl+= / Ctrl+- 都走这里 */
  function bumpFont(direction: 1 | -1) {
    changeFont(fontSize + direction * readSize.step);
  }

  /* ------------------------------------------------------------------
     快捷键（规范 §4.4）
     ------------------------------------------------------------------ */

  function onKeydown(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    const inField = (e.target as HTMLElement | null)?.tagName === 'INPUT';

    if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); void openFolderDialog(); return; }
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); void openFileDialog(); return; }
    // 字号：Ctrl + = / - / 0，和浏览器同一套手（Shift 打出 + 也走放大）
    if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); bumpFont(1); return; }
    if (mod && (e.key === '-' || e.key === '_')) { e.preventDefault(); bumpFont(-1); return; }
    if (mod && e.key === '0') { e.preventDefault(); changeFont(readSize.def); return; }
    if (mod && e.key.toLowerCase() === 'w') { e.preventDefault(); if (activeId) closeTab(activeId); return; }
    if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); sidebarCollapsed = !sidebarCollapsed; return; }
    if (mod && e.key.toLowerCase() === 'r' && workspacePath) {
      e.preventDefault();
      void refreshTree({ announce: true });
      return;
    }
    if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      sidebarCollapsed = false;
      sidebarMode = 'search';
      return;
    }
    if (mod && e.key === 'Tab') { e.preventDefault(); cycleTab(e.shiftKey ? -1 : 1); return; }
    if (e.key === 'Escape' && inField) {
      (e.target as HTMLInputElement).blur();
      query = '';
      sidebarMode = 'outline';
    }
  }
</script>

<svelte:window
  onkeydown={onKeydown}
  ondragover={(e) => { e.preventDefault(); if (!isTauri) dropped = true; }}
  ondragleave={() => { if (!isTauri) dropped = false; }}
  ondrop={onDrop}
  onresize={() => { sidebarW = clampSidebarW(sidebarW); }}
/>

<input
  bind:this={fileInput}
  type="file"
  accept=".md,.markdown,text/markdown"
  hidden
  onchange={onFilePicked}
/>

<div class="app">
  <TitleBar
    {tabs}
    {activeId}
    scheme={resolved}
    palette={themePalette}
    themeMode={themeMode}
    onPickTheme={pickTheme}
    onFollowSystem={followSystem}
    {fontSize}
    onFontSize={changeFont}
    onSelect={(id) => { activeId = id; }}
    onClose={closeTab}
    onOpen={openFileDialog}
    onCloseMany={closeTabsBy}
    onTogglePin={togglePin}
    onReorder={reorderTab}
  />

  <div class="body" style:--mr-sidebar-w={`${sidebarW}px`}>
    <!--
      侧栏的显示条件与「有没有标签」解耦：只要还认得工作区就把文件树留着。
      否则关掉最后一个标签后整条左栏消失，用户要再开文件就得重新选一次文件夹，
      而这时主界面明明已经知道工作区在哪。
    -->
    {#if tabs.length > 0 || workspacePath}
      {#if sidebarCollapsed}
        <!-- 收起成 44px 图标栏：留住三个入口，也把"怎么展开"摆在明面上 -->
        <SidebarRail
          mode={sidebarMode}
          onOpenMode={(m) => { sidebarMode = m; sidebarCollapsed = false; }}
          onExpand={() => { sidebarCollapsed = false; }}
        />
      {:else}
      <Sidebar
        mode={sidebarMode}
        onMode={(m) => { sidebarMode = m; }}
        onCollapse={() => { sidebarCollapsed = true; }}
        workspace={workspaceName}
        {workspacePath}
        {tree}
        {treeState}
        {treeError}
        activePath={activeTab?.path ?? ''}
        onOpenPath={openTreeFile}
        onRefresh={() => { void refreshTree({ announce: true }); }}
        onOpenFolder={openFolderDialog}
        outline={rendered.headings}
        currentId={currentHeadingId}
        onJump={jumpToHeading}
        {query}
        onQuery={(q) => { query = q; }}
        groups={orderedGroups}
        scope={searchScope}
        {searchState}
        {searchInfo}
        onHit={goToHit}
      />

      <!--
        拖拽条：绝对定位骑在侧栏那条 1px 分隔线上，热区 7px 向两侧各溢出 3px。
        不占布局空间 —— 用 flex 子项做的话，热区宽度会从正文里扣走，
        而且侧栏宽度与"视觉分界线"之间会差半个热区，拖动时对不上手感。
      -->
      <!--
        ARIA 的 splitter 模式就是「role=separator + tabindex + 方向键」，
        Svelte 的无障碍规则把 separator 当纯装饰元素，这里按规范来、屏蔽它。
      -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="gutter"
        class:gutter--active={resizing}
        style:left={`${sidebarW - 3}px`}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧栏宽度"
        aria-valuenow={sidebarW}
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        tabindex="0"
        title="拖动调整宽度（双击复位为 240）"
        onpointerdown={startSidebarDrag}
        ondblclick={resetSidebarW}
        onkeydown={onGutterKey}
      ></div>
      {/if}
    {/if}

    <main class="content" bind:this={contentEl} onscroll={onScroll} style:position="relative">
      {#if progress > 0.01 && tabs.length > 0}
        <div class="reader-progress" style:width={`${progress * 100}%`}></div>
      {/if}

      {#if tabs.length === 0}
        <EmptyState
          {recents}
          {backend}
          onOpenFolder={openFolderDialog}
          onOpenFile={openFileDialog}
          onLoadSample={loadSample}
          onPickRecent={openRecent}
          onClear={() => { recents = []; persistRecents(); }}
        />
      {:else if !ready}
        <div class="loading" aria-label="正在加载">
          <div class="skel" style:width="62%"></div>
          <div class="skel" style:width="100%"></div>
          <div class="skel" style:width="88%"></div>
          <div class="skel" style:width="96%"></div>
          <div class="skel" style:width="44%"></div>
        </div>
      {:else}
        {#if activeTab?.missing}
          <div class="docbanner" role="status">
            <span class="docbanner__t">这个文件在磁盘上已不存在或被移走</span>
            <button class="docbanner__b" type="button" onclick={() => activeTab && reloadTab(activeTab)}>重试读取</button>
            <button class="docbanner__b" type="button" onclick={() => activeId && closeTab(activeId)}>关闭标签</button>
          </div>
        {/if}
        {#if activeTab?.encoding && activeTab.encoding !== 'utf-8'}
          <div class="docbanner docbanner--info" role="status">
            <span class="docbanner__t">该文件不是 UTF-8 编码（按 {activeTab.encoding} 解码，如有乱码请转存为 UTF-8）</span>
          </div>
        {/if}
        <Article
          bind:this={articleRef}
          html={rendered.html}
          container={contentEl}
          {fontSize}
          onOpenLink={onOpenLink}
        />
      {/if}
    </main>
  </div>
</div>

<FolderPicker
  open={pickerOpen}
  {host}
  recents={recentWorkspaces}
  onPick={(p) => { void openWorkspace(p); }}
  onClose={() => { pickerOpen = false; }}
/>

{#if toasts.length > 0}
  <div class="toasts" role="status" aria-live="polite">
    {#each toasts as t (t.id)}
      <div class="toast toast--{t.kind}">{t.text}</div>
    {/each}
  </div>
{/if}

{#if dropped}
  <div class="dropveil">
    <div class="dropveil__box">松开以打开 Markdown 文件或文件夹</div>
  </div>
{/if}

<style>
  /* ---------- 文档级横幅（缺失 / 编码） ---------- */
  .docbanner {
    position: sticky;
    top: 0;
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 0 auto;
    padding: 9px 14px;
    width: min(680px, 100%);
    border: 1px solid color-mix(in srgb, var(--mr-warn, #b89968) 42%, var(--mr-border));
    border-radius: 0 0 var(--mr-radius-sm) var(--mr-radius-sm);
    background: color-mix(in srgb, var(--mr-warn, #b89968) 12%, var(--mr-canvas));
  }
  .docbanner--info {
    border-color: var(--mr-border);
    background: var(--mr-surface-track);
  }
  .docbanner__t {
    flex: 1;
    font: 400 12px var(--mr-font-sans);
    color: var(--mr-text-2);
  }
  .docbanner__b {
    font: 500 11.5px var(--mr-font-sans);
    color: var(--mr-accent);
    padding: 3px 8px;
    border-radius: var(--mr-radius-sm);
  }
  .docbanner__b:hover { background: var(--mr-surface-track); }

  /* ---------- 提示条 ---------- */
  .toasts {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: flex-end;
    pointer-events: none;
  }
  .toast {
    max-width: 340px;
    padding: 9px 13px;
    border: 1px solid var(--mr-border);
    border-radius: var(--mr-radius-sm);
    background: var(--mr-surface);
    box-shadow: var(--mr-shadow-popover);
    font: 400 12px/1.55 var(--mr-font-sans);
    color: var(--mr-text-1);
    animation: toast-in 140ms ease-out;
  }
  .toast--warn { border-color: color-mix(in srgb, #b89968 55%, var(--mr-border)); }
  .toast--error { border-color: color-mix(in srgb, #b4553f 55%, var(--mr-border)); }
  @keyframes toast-in {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: none; }
  }

  /* ---------- 拖放遮罩 ---------- */
  .dropveil {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--mr-canvas) 82%, transparent);
    pointer-events: none;
  }
  .dropveil__box {
    padding: 18px 28px;
    border: 2px dashed var(--mr-accent);
    border-radius: var(--mr-radius-lg);
    background: var(--mr-surface);
    font: 500 14px var(--mr-font-sans);
    color: var(--mr-accent);
  }
</style>
