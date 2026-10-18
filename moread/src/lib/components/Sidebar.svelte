<script lang="ts">
  import Icon from './Icon.svelte';
  import type { Heading } from '../markdown';
  import {
    normalizePath,
    type Hit,
    type HitGroup,
    type SearchInfo,
    type SearchScope,
    type SearchState,
    type SidebarMode,
    type TreeNode,
    type TreeState,
  } from '../types';

  interface Props {
    mode: SidebarMode;
    onMode: (m: SidebarMode) => void;
    /** 工作区展示名（目录名） */
    workspace: string;
    /** 工作区绝对路径，空串表示尚未打开 */
    workspacePath: string;
    tree: TreeNode[];
    treeState: TreeState;
    treeError: string;
    activePath: string;
    onOpenPath: (node: TreeNode) => void;
    onRefresh: () => void;
    onOpenFolder: () => void;
    outline: Heading[];
    currentId: string;
    onJump: (id: string) => void;
    query: string;
    onQuery: (q: string) => void;
    /** 搜索结果，已按文件聚合 */
    groups: HitGroup[];
    scope: SearchScope;
    searchState: SearchState;
    searchInfo: SearchInfo | null;
    onHit: (hit: Hit) => void;
    /** 收起成左侧图标栏 */
    onCollapse: () => void;
  }

  let {
    mode, onMode, workspace, workspacePath, tree, treeState, treeError,
    activePath, onOpenPath, onRefresh, onOpenFolder,
    outline, currentId, onJump, query, onQuery,
    groups, scope, searchState, searchInfo, onHit,
    onCollapse,
  }: Props = $props();

  /** 目录折叠状态：默认全部展开，只记「被折叠的」 */
  let collapsed = $state<Record<string, boolean>>({});
  /** 搜索结果里被折叠的文件组，同样只记「被折叠的」 */
  let collapsedGroups = $state<Record<string, boolean>>({});
  let searchInput = $state<HTMLInputElement | null>(null);

  const MODES: { id: SidebarMode; label: string }[] = [
    { id: 'files', label: '文件' },
    { id: 'outline', label: '大纲' },
    { id: 'search', label: '搜索' },
  ];

  function toggleDir(path: string) {
    const key = normalizePath(path);
    collapsed = { ...collapsed, [key]: !collapsed[key] };
  }

  function isCollapsed(path: string) {
    return !!collapsed[normalizePath(path)];
  }

  function toggleGroup(key: string) {
    collapsedGroups = { ...collapsedGroups, [key]: !collapsedGroups[key] };
  }

  /** 是否被任一祖先目录折叠隐藏（用分隔符判定，避免 notes 误伤 notes2） */
  function visible(node: TreeNode) {
    const self = normalizePath(node.path);
    for (const n of tree) {
      if (n.kind !== 'dir' || n.depth >= node.depth) continue;
      if (!isCollapsed(n.path)) continue;
      if (self.startsWith(normalizePath(n.path) + '/')) return false;
    }
    return true;
  }

  /**
   * 把片段按关键词切成「命中 / 非命中」两段式，交给模板逐段渲染。
   * 刻意不用 {@html} —— 片段来自文件内容，拼 HTML 就是把用户的文档当模板执行。
   */
  function segments(text: string, q: string): { t: string; hit: boolean }[] {
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

  // 切到搜索页签即聚焦，Ctrl+F 之后可以直接打字
  $effect(() => {
    if (mode === 'search') searchInput?.focus();
  });

  const fileCount = $derived(tree.filter((n) => n.kind === 'file').length);
  const dirCount = $derived(tree.filter((n) => n.kind === 'dir').length);
</script>

<aside class="sidebar">
  <div class="sidebar__head">
    <div class="sidebar__tabs" role="tablist">
      {#each MODES as m (m.id)}
        <button
          class="sidebar__tab"
          class:is-active={mode === m.id}
          role="tab"
          aria-selected={mode === m.id}
          type="button"
          onclick={() => onMode(m.id)}
        >{m.label}</button>
      {/each}
    </div>
    <button
      class="sidebar__fold"
      type="button"
      title="收起侧栏 (Ctrl+B)"
      aria-label="收起侧栏"
      onclick={onCollapse}
    >
      <Icon name="chevronLeft" size={13} />
    </button>
  </div>

  {#if mode === 'files'}
    <div class="ws-head">
      <button class="ws-head__main" type="button" onclick={onOpenFolder} title={workspacePath || '打开文件夹'}>
        <Icon name="folder" size={14} />
        <span class="ws-head__name">{workspace || '未打开工作区'}</span>
      </button>
      {#if workspacePath}
        <button
          class="ws-head__btn"
          class:is-busy={treeState === 'loading'}
          type="button"
          title="重新扫描工作区"
          aria-label="重新扫描工作区"
          onclick={onRefresh}
        >
          <Icon name="refresh" size={13} />
        </button>
      {/if}
    </div>
    {#if workspacePath}
      <p class="ws-meta">
        {#if treeState === 'ready'}{dirCount} 个目录 · {fileCount} 篇文档{:else if treeState === 'loading'}正在扫描…{:else}&nbsp;{/if}
      </p>
    {/if}
  {:else if mode === 'search'}
    <div class="ws-head">
      <div class="ws-head__main ws-head__main--static">
        <Icon name="search" size={14} />
        <span class="ws-head__name">{scope === 'workspace' ? '工作区搜索' : '文档搜索'}</span>
      </div>
    </div>
  {/if}

  <div class="sidebar__scroll">
    <!-- ---------------- 文件树 ---------------- -->
    {#if mode === 'files'}
      {#if !workspacePath}
        <div class="empty">
          <p class="empty__t">还没有打开工作区</p>
          <p class="empty__d">选一个存放 Markdown 的文件夹，这里会列出全部文档。</p>
          <button class="empty__btn" type="button" onclick={onOpenFolder}>
            <Icon name="folder" size={13} />
            <span>打开文件夹</span>
          </button>
        </div>

      {:else if treeState === 'loading' && tree.length === 0}
        <div class="skel-list" aria-label="正在扫描">
          {#each Array(7) as _, i (i)}
            <div class="skel" style:width={`${[78, 62, 70, 54, 74, 58, 66][i]}%`}></div>
          {/each}
        </div>

      {:else if treeState === 'error'}
        <div class="empty">
          <p class="empty__t">无法读取工作区</p>
          <p class="empty__d">{treeError}</p>
          <button class="empty__btn" type="button" onclick={onRefresh}>
            <Icon name="refresh" size={13} />
            <span>重试</span>
          </button>
        </div>

      {:else if tree.length === 0}
        <div class="empty">
          <p class="empty__t">这个目录里没有 Markdown</p>
          <p class="empty__d">已递归扫描子目录。支持 .md 与 .markdown 两种扩展名。</p>
        </div>

      {:else}
        {#each tree as node (node.path)}
          {#if visible(node)}
            {#if node.kind === 'dir'}
              <button
                class="trow"
                type="button"
                style:padding-left={node.depth === 0 ? '4px' : `${4 + node.depth * 10}px`}
                aria-expanded={!isCollapsed(node.path)}
                onclick={() => toggleDir(node.path)}
              >
                <Icon name={isCollapsed(node.path) ? 'chevronRight' : 'chevronDown'} size={12} />
                <span class="trow__name">{node.name}</span>
              </button>
            {:else}
              <button
                class="trow trow--file"
                class:is-selected={normalizePath(activePath) === normalizePath(node.path)}
                type="button"
                style:padding-left={`${4 + node.depth * 10 + 14}px`}
                title={node.path}
                onclick={() => onOpenPath(node)}
              >
                <Icon name="doc" size={13} />
                <span class="trow__name">{node.name}</span>
              </button>
            {/if}
          {/if}
        {/each}
      {/if}

    <!-- ---------------- 大纲 ---------------- -->
    {:else if mode === 'outline'}
      {#if outline.length === 0}
        <p class="sidebar__note">当前文档没有标题</p>
      {:else}
        <nav aria-label="文档大纲">
          {#each outline as h (h.id)}
            <button
              class="outline-item"
              class:is-current={currentId === h.id}
              data-level={h.level}
              type="button"
              onclick={() => onJump(h.id)}
            >{h.text}</button>
          {/each}
        </nav>
      {/if}

    <!-- ---------------- 搜索 ---------------- -->
    {:else}
      <div class="search-input">
        <Icon name="search" size={13} />
        <input
          bind:this={searchInput}
          type="search"
          placeholder={scope === 'workspace' ? '搜索工作区内全部文档' : '搜索已打开的文档'}
          aria-label="全文搜索"
          value={query}
          oninput={(e) => onQuery((e.currentTarget as HTMLInputElement).value)}
          onkeydown={(e) => { if (e.key === 'Escape') onQuery(''); }}
        />
        {#if searchState === 'loading'}
          <span class="search-input__spin" aria-label="搜索中"></span>
        {:else if query}
          <button
            class="search-input__clear"
            type="button"
            aria-label="清空搜索"
            title="清空"
            onclick={() => onQuery('')}
          >
            <Icon name="close" size={10} />
          </button>
        {/if}
      </div>

      <p class="search-meta">
        {#if !query.trim()}
          {scope === 'workspace' ? '跨整个工作区检索，含未打开的文档' : '输入关键词，跨已打开文档检索'}
        {:else if searchState === 'loading'}
          正在搜索…
        {:else if searchState === 'error'}
          搜索失败，请重试
        {:else if groups.length === 0}
          没有匹配。搜索基于纯文本，不区分大小写
        {:else}
          {searchInfo?.totalMatches ?? 0} 处命中 · {groups.length} 个文件
          {#if searchInfo?.truncated}（已截断）{/if}
        {/if}
      </p>

      {#if searchInfo?.truncated}
        <p class="search-warn">
          命中过多，仅显示前 {searchInfo.totalMatches} 条 —— 换个更具体的关键词
        </p>
      {/if}

      <div class="search-results">
        {#each groups as g (g.path || g.name)}
          {@const key = g.path || g.name}
          <section class="grp" class:is-current={!!g.path && normalizePath(g.path) === normalizePath(activePath)}>
            <button
              class="grp__head"
              type="button"
              aria-expanded={!collapsedGroups[key]}
              onclick={() => toggleGroup(key)}
            >
              <Icon name={collapsedGroups[key] ? 'chevronRight' : 'chevronDown'} size={11} />
              <Icon name="doc" size={12} />
              <span class="grp__name" title={g.path || g.name}>{g.name}</span>
              <span class="grp__count">{g.total}</span>
            </button>

            {#if g.relPath && g.relPath !== g.name}
              <p class="grp__path" title={g.relPath}>{g.relPath}</p>
            {/if}

            {#if !collapsedGroups[key]}
              {#each g.hits as h (h.line + ':' + h.ordinal)}
                <button class="hit" type="button" title={`第 ${h.line} 行`} onclick={() => onHit(h)}>
                  <span class="hit__ln">{h.line}</span>
                  <span class="hit__s">
                    {#each segments(h.snippet, query) as seg}{#if seg.hit}<mark>{seg.t}</mark>{:else}{seg.t}{/if}{/each}
                  </span>
                </button>
              {/each}
              {#if g.total > g.hits.length}
                <p class="grp__more">该文件另有 {g.total - g.hits.length} 处未列出</p>
              {/if}
            {/if}
          </section>
        {/each}
      </div>
    {/if}
  </div>
</aside>

<style>
  /* ---------- 工作区头 ---------- */
  .ws-head {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 2px;
  }
  .ws-head__main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 4px 5px;
    border-radius: var(--mr-radius-sm);
    color: var(--mr-text-2);
    text-align: left;
  }
  .ws-head__main:hover { background: var(--mr-surface-track); }
  .ws-head__main--static { cursor: default; }
  .ws-head__main--static:hover { background: transparent; }
  .ws-head__name {
    font: 500 12.5px var(--mr-font-sans);
    color: var(--mr-text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ws-head__btn {
    width: 24px;
    height: 24px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: var(--mr-radius-sm);
    color: var(--mr-text-4);
  }
  .ws-head__btn:hover { background: var(--mr-surface-track); color: var(--mr-text-1); }
  .ws-head__btn.is-busy { animation: spin 900ms linear infinite; color: var(--mr-accent); }
  @keyframes spin { to { transform: rotate(360deg); } }

  .ws-meta {
    margin: 6px 4px 0;
    font: 400 10.5px var(--mr-font-mono);
    color: var(--mr-text-5);
  }

  /* ---------- 空态 / 骨架 ---------- */
  .empty {
    margin: 18px 4px 0;
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .empty__t {
    margin: 0;
    font: 500 12.5px var(--mr-font-sans);
    color: var(--mr-text-3);
  }
  .empty__d {
    margin: 0;
    font: 400 11.5px/1.7 var(--mr-font-sans);
    color: var(--mr-text-5);
  }
  .empty__btn {
    align-self: flex-start;
    margin-top: 4px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 30px;
    padding: 0 12px;
    border: 1px solid var(--mr-border-strong);
    border-radius: var(--mr-radius-sm);
    font: 500 12px var(--mr-font-sans);
    color: var(--mr-text-1);
  }
  .empty__btn:hover { border-color: var(--mr-accent); color: var(--mr-accent); }

  .skel-list { display: flex; flex-direction: column; gap: 11px; margin: 12px 5px 0; }
  .skel {
    height: 9px;
    border-radius: 3px;
    background: var(--mr-surface-track);
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .5; } }

  /* ---------- 树行 ---------- */
  .trow--file { padding-left: 18px; }

  /* ---------- 搜索框附加件 ---------- */
  .search-input__spin {
    flex: none;
    width: 11px;
    height: 11px;
    border: 1.5px solid var(--mr-border-strong);
    border-top-color: var(--mr-accent);
    border-radius: 50%;
    animation: spin 700ms linear infinite;
  }
  .search-input__clear {
    flex: none;
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--mr-text-5);
  }
  .search-input__clear:hover { background: var(--mr-surface-track); color: var(--mr-text-1); }

  .search-warn {
    margin: 8px 2px 0;
    padding: 6px 8px;
    border-radius: var(--mr-radius-sm);
    background: color-mix(in srgb, var(--mr-warn, #b89968) 12%, transparent);
    font: 400 10.5px/1.6 var(--mr-font-sans);
    color: var(--mr-text-3);
  }

  /* ---------- 搜索结果 ---------- */
  .search-results {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 10px;
  }

  .grp { margin-bottom: 2px; }

  .grp__head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: 26px;
    padding: 0 6px 0 2px;
    border-radius: var(--mr-radius-sm);
    text-align: left;
    color: var(--mr-text-4);
  }
  .grp__head:hover { background: var(--mr-surface-track); }
  .grp__name {
    flex: 1;
    min-width: 0;
    font: 500 12px var(--mr-font-sans);
    color: var(--mr-text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .grp.is-current .grp__name { color: var(--mr-accent); }
  .grp__count {
    flex: none;
    font: 400 10px var(--mr-font-mono);
    color: var(--mr-text-5);
  }

  .grp__path {
    margin: 0 0 3px 27px;
    font: 400 10.5px var(--mr-font-sans);
    color: var(--mr-text-5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hit {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    border-radius: var(--mr-radius-sm);
    text-align: left;
    border-left: 2px solid transparent;
  }
  .hit:hover {
    background: var(--mr-surface-track);
    border-left-color: var(--mr-accent);
  }
  .hit__ln {
    flex: none;
    width: 26px;
    padding-top: 1px;
    text-align: right;
    font: 400 10px var(--mr-font-mono);
    color: var(--mr-text-5);
  }
  .hit__s {
    flex: 1;
    min-width: 0;
    font: 400 11.5px/1.55 var(--mr-font-sans);
    color: var(--mr-text-3);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }
  .hit__s :global(mark) {
    /*
      和画布色混合而不是与 transparent 混合：侧栏是密集的小字号文本，
      纯透明叠加出来的底色在米白背景上几乎看不见。混进画布色后，
      亮暗两套主题下都能得到确定、够看的对比度。
    */
    background: color-mix(in srgb, var(--mr-accent) 22%, var(--mr-canvas));
    color: var(--mr-accent);
    font-weight: 500;
    border-radius: 2px;
    padding: 0 1px;
  }

  .grp__more {
    margin: 2px 0 4px 42px;
    font: 400 10.5px var(--mr-font-sans);
    color: var(--mr-text-5);
  }

  /* ---------- 其余复用 app.css ---------- */
  .sidebar__note {
    margin: 14px 4px 0;
    font: 400 11px/1.6 var(--mr-font-sans);
    color: var(--mr-text-5);
  }
</style>
