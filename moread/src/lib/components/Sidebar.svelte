<script lang="ts">
  import Icon from './Icon.svelte';
  import type { Heading } from '../markdown';
  import {
    normalizePath,
    type HistoryItem,
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
    /**
     * 最近打开过的文档，已按时间倒序。
     * `missing` 表示磁盘上已经没有这个文件了 —— 那一行画灰且不可点，
     * 否则点下去只会弹一个"无法打开"的错误。
     */
    history: HistoryItem[];
    onOpenHistory: (item: HistoryItem) => void;
    onClearHistory: () => void;
    /** 收起成左侧图标栏 */
    onCollapse: () => void;
  }

  let {
    mode, onMode, workspace, workspacePath, tree, treeState, treeError,
    activePath, onOpenPath, onRefresh, onOpenFolder,
    outline, currentId, onJump,
    history, onOpenHistory, onClearHistory,
    onCollapse,
  }: Props = $props();

  /** 目录折叠状态：默认全部展开，只记「被折叠的」 */
  let collapsed = $state<Record<string, boolean>>({});

  const MODES: { id: SidebarMode; label: string }[] = [
    { id: 'files', label: '文件' },
    { id: 'outline', label: '大纲' },
    { id: 'history', label: '历史' },
  ];

  function toggleDir(path: string) {
    const key = normalizePath(path);
    collapsed = { ...collapsed, [key]: !collapsed[key] };
  }

  function isCollapsed(path: string) {
    return !!collapsed[normalizePath(path)];
  }

  /**
   * 历史行里显示的父目录：只取**最后一级**。
   *
   * 240px 宽的侧栏里，"temp/moread-ws-history" 这种两级路径会被截成
   * "temp/moread-ws-histo…"，既占地方又没多给信息 —— 能区分同名文件的
   * 通常就是最后那一级。完整路径在 title 里，需要时可以悬停看。
   */
  function parentOf(p: string): string {
    const parts = normalizePath(p).split('/').filter(Boolean);
    if (parts.length <= 1) return '';
    return parts[parts.length - 2];
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
  {:else if mode === 'history'}
    <div class="hist-bar">
      <span class="hist-bar__t">最近打开</span>
      <button
        class="hist-bar__clear"
        type="button"
        onclick={onClearHistory}
        disabled={history.length === 0}
      >清空</button>
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

    <!-- ---------------- 历史 ---------------- -->
    {:else}
      {#if history.length === 0}
        <div class="empty">
          <p class="empty__t">还没有打开过文档</p>
          <p class="empty__d">打开过的 Markdown 会留在这里，下次一点就能回到上次读的那份。</p>
        </div>
      {:else}
        <div class="hist-list">
          {#each history as h (h.path)}
            <button
              class="hist"
              class:is-missing={h.missing}
              class:is-current={!h.missing && normalizePath(h.path) === normalizePath(activePath)}
              type="button"
              disabled={h.missing}
              title={h.missing ? `${h.path}\n文件已不存在` : h.path}
              onclick={() => onOpenHistory(h)}
            >
              <Icon name="doc" size={13} />
              <span class="hist__body">
                <span class="hist__name">{h.name}</span>
                <span class="hist__parent">{parentOf(h.path)}</span>
              </span>
              {#if h.missing}
                <span class="hist__tag">已不存在</span>
              {:else}
                <span class="hist__time">{h.time}</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
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

  /* ---------- 历史 ---------- */
  .hist-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 22px;
    padding: 0 4px;
    flex: none;
  }
  .hist-bar__t {
    font: 500 11px var(--mr-font-sans);
    color: var(--mr-text-4);
    letter-spacing: 0.02em;
  }
  .hist-bar__clear {
    padding: 2px 5px;
    border-radius: var(--mr-radius-xs);
    font: 400 11px var(--mr-font-sans);
    color: var(--mr-text-5);
  }
  .hist-bar__clear:hover:not(:disabled) {
    background: var(--mr-surface-track);
    color: var(--mr-text-2);
  }
  .hist-bar__clear:disabled { opacity: 0.45; cursor: default; }

  .hist-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin-top: 4px;
  }

  .hist {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 6px 6px 4px;
    border-radius: var(--mr-radius-sm);
    border-left: 2px solid transparent;
    text-align: left;
    color: var(--mr-text-4);
  }
  .hist:hover:not(:disabled) {
    background: var(--mr-surface-track);
    border-left-color: var(--mr-accent);
  }
  .hist:hover:not(:disabled) .hist__name { color: var(--mr-text-1); }

  .hist__body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .hist__name {
    font: 500 12px var(--mr-font-sans);
    color: var(--mr-text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hist__parent {
    font: 400 10px var(--mr-font-mono);
    color: var(--mr-text-5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hist__time {
    flex: none;
    font: 400 10px var(--mr-font-mono);
    color: var(--mr-text-6);
  }
  .hist.is-current .hist__name { color: var(--mr-accent); }

  /*
    文件已删除：整行沉到 6 级灰。不给 hover 任何反馈，是因为它现在
    只是一条"说明"而不是可点的东西 —— 让它有一点点像按钮都是在骗点击。
  */
  .hist.is-missing { cursor: default; }
  .hist.is-missing .hist__name,
  .hist.is-missing .hist__parent { color: var(--mr-text-6); }
  .hist.is-missing .hist__parent { opacity: 0.7; }

  .hist__tag {
    flex: none;
    padding: 1px 5px;
    border: 1px solid var(--mr-border);
    border-radius: var(--mr-radius-xs);
    font: 400 9.5px var(--mr-font-sans);
    color: var(--mr-text-5);
    letter-spacing: 0.02em;
  }

  /* ---------- 其余复用 app.css ---------- */
  .sidebar__note {
    margin: 14px 4px 0;
    font: 400 11px/1.6 var(--mr-font-sans);
    color: var(--mr-text-5);
  }
</style>
