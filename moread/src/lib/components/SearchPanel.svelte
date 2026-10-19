<script lang="ts">
  /**
   * 右侧搜索栏。
   *
   * 为什么从左侧搬到这里：左侧栏回答的是"我的文档在哪"（文件树、大纲、历史），
   * 而搜索是"我在找一段内容"——它是一次临时任务，用完就该收起，
   * 不该占着常驻导航区的位置。右侧栏与正文同高，结果列表也能摊得更长。
   */
  import Icon from './Icon.svelte';
  import { segments } from '../search';
  import {
    normalizePath,
    type Hit,
    type HitGroup,
    type SearchInfo,
    type SearchScope,
    type SearchState,
  } from '../types';

  interface Props {
    query: string;
    onQuery: (q: string) => void;
    scope: SearchScope;
    onScope: (s: SearchScope) => void;
    /** 没有工作区时"工作区"这一档不可选 */
    hasWorkspace: boolean;
    groups: HitGroup[];
    status: SearchState;
    info: SearchInfo | null;
    activePath: string;
    /** 每次自增都重新聚焦输入框（Ctrl+F 连按不会丢焦点） */
    focusToken: number;
    onHit: (hit: Hit) => void;
    onClose: () => void;
  }

  let {
    query, onQuery, scope, onScope, hasWorkspace,
    groups, status, info, activePath, focusToken, onHit, onClose,
  }: Props = $props();

  const SCOPES: { id: SearchScope; label: string; hint: string }[] = [
    { id: 'active', label: '当前标签', hint: '只在当前这一篇里找' },
    { id: 'tabs', label: '所有标签', hint: '在所有已打开的文档里找' },
    { id: 'workspace', label: '工作区', hint: '整个文件夹，含还没打开的文档' },
  ];

  let input = $state<HTMLInputElement | null>(null);
  /** 结果里被折叠的文件组，只记"被折叠的" */
  let collapsed = $state<Record<string, boolean>>({});
  /** 切范围时把折叠状态清掉：上一个范围里的文件名在这里多半不存在 */
  let lastScope: SearchScope | null = null;

  $effect(() => {
    void focusToken;
    input?.focus();
    input?.select();
  });

  $effect(() => {
    // 换了范围，上一个范围里的折叠状态没有意义（文件名大概率不重合）
    const current = scope;
    if (lastScope !== null && current !== lastScope) collapsed = {};
    lastScope = current;
  });

  const isEmpty = $derived(groups.length === 0);
  const scopeHint = $derived(SCOPES.find((s) => s.id === scope)?.hint ?? '');
</script>

<aside class="sp" aria-label="搜索">
  <div class="sp__head">
    <span class="sp__title">搜索</span>
    <button
      class="sp__fold"
      type="button"
      title="收起搜索栏 (Ctrl+F)"
      aria-label="收起搜索栏"
      onclick={onClose}
    >
      <Icon name="chevronRight" size={13} />
    </button>
  </div>

  <div class="sp__scopes" role="radiogroup" aria-label="搜索范围">
    {#each SCOPES as s (s.id)}
      <button
        class="sp__scope"
        class:is-active={scope === s.id}
        type="button"
        role="radio"
        aria-checked={scope === s.id}
        title={s.hint}
        disabled={s.id === 'workspace' && !hasWorkspace}
        onclick={() => onScope(s.id)}
      >{s.label}</button>
    {/each}
  </div>

  <div class="sp__input">
    <Icon name="search" size={13} />
    <input
      bind:this={input}
      type="search"
      placeholder={scope === 'active' ? '在当前文档里搜索' : scope === 'tabs' ? '搜索已打开的文档' : '搜索整个工作区'}
      aria-label="全文搜索"
      value={query}
      oninput={(e) => onQuery((e.currentTarget as HTMLInputElement).value)}
      onkeydown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          if (query) onQuery('');
          else onClose();
        }
      }}
    />
    {#if status === 'loading'}
      <span class="sp__spin" aria-label="搜索中"></span>
    {:else if query}
      <button class="sp__clear" type="button" aria-label="清空搜索" title="清空" onclick={() => onQuery('')}>
        <Icon name="close" size={10} />
      </button>
    {/if}
  </div>

  <p class="sp__meta">
    {#if !query.trim()}
      {scopeHint}
    {:else if status === 'loading'}
      正在搜索…
    {:else if status === 'error'}
      搜索失败，请重试
    {:else if isEmpty}
      没有匹配。搜索基于纯文本，不区分大小写
    {:else}
      {info?.totalMatches ?? 0} 处命中 · {groups.length} 个文件
      {#if scope === 'workspace' && info} · 扫描 {info.scannedFiles} 篇{/if}
    {/if}
  </p>

  {#if info?.truncated}
    <p class="sp__warn">命中过多，仅显示前 {info.totalMatches} 条 —— 换个更具体的关键词</p>
  {/if}

  <div class="sp__results">
    {#if !query.trim()}
      <div class="sp__empty">
        <p class="sp__empty-t">在文档里找一段内容</p>
        <p class="sp__empty-d">
          搜的是纯文本，不区分大小写；点结果会跳到那一次出现的位置。
          换范围可以只在当前标签里找，或者搜遍整个工作区。
        </p>
      </div>
    {:else if isEmpty && status === 'ready'}
      <div class="sp__empty">
        <p class="sp__empty-t">没有找到「{query.trim()}」</p>
        <p class="sp__empty-d">
          {#if scope === 'active'}
            当前标签里没有。试试切到「所有标签」或「工作区」。
          {:else if scope === 'tabs'}
            已打开的 {info?.scannedFiles ?? 0} 篇里都没有。试试切到「工作区」。
          {:else}
            换个关键词，或者确认工作区里确实有这个文件。
          {/if}
        </p>
      </div>
    {/if}

    {#each groups as g (g.path || g.name)}
      {@const key = g.path || g.name}
      <section class="grp" class:is-current={!!g.path && normalizePath(g.path) === normalizePath(activePath)}>
        <button
          class="grp__head"
          type="button"
          aria-expanded={!collapsed[key]}
          onclick={() => { collapsed = { ...collapsed, [key]: !collapsed[key] }; }}
        >
          <Icon name={collapsed[key] ? 'chevronRight' : 'chevronDown'} size={11} />
          <Icon name="doc" size={12} />
          <span class="grp__name" title={g.path || g.name}>{g.name}</span>
          <span class="grp__count">{g.total}</span>
        </button>

        {#if g.relPath && g.relPath !== g.name}
          <p class="grp__path" title={g.relPath}>{g.relPath}</p>
        {/if}

        {#if !collapsed[key]}
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
</aside>

<style>
  .sp {
    flex: none;
    /* 窗口窄时按比例收，但不低于 260 —— 再窄结果行的片段就没法读了 */
    width: clamp(260px, 34vw, var(--mr-search-w));
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 10px 10px 0;
    background: var(--mr-surface);
    border-left: 1px solid var(--mr-border);
  }

  .sp__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 24px;
    flex: none;
  }
  .sp__title {
    font: 500 12px var(--mr-font-sans);
    color: var(--mr-text-3);
    letter-spacing: 0.02em;
  }
  .sp__fold {
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    border-radius: var(--mr-radius-sm);
    color: var(--mr-text-4);
  }
  .sp__fold:hover { background: var(--mr-surface-track); color: var(--mr-text-1); }

  /* 三档范围：等分一行，选中态用白底 + 墨绿字，与侧栏分段控件同一套语言 */
  .sp__scopes {
    display: flex;
    gap: 2px;
    margin-top: 6px;
    padding: 3px;
    background: var(--mr-surface-track);
    border-radius: var(--mr-radius-md);
    flex: none;
  }
  .sp__scope {
    flex: 1;
    height: 22px;
    border-radius: var(--mr-radius-sm);
    font: 500 11.5px var(--mr-font-sans);
    color: var(--mr-text-4);
    white-space: nowrap;
  }
  .sp__scope:hover:not(:disabled):not(.is-active) { color: var(--mr-text-2); }
  .sp__scope.is-active {
    background: var(--mr-surface);
    color: var(--mr-text-1);
  }
  .sp__scope:disabled { opacity: 0.45; cursor: default; }

  .sp__input {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 32px;
    margin-top: 10px;
    padding: 0 9px;
    background: var(--mr-canvas);
    border: 1px solid var(--mr-border);
    border-radius: var(--mr-radius-md);
    color: var(--mr-text-4);
    flex: none;
  }
  .sp__input:focus-within { border-color: var(--mr-accent-armor); }
  .sp__input input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: 0;
    background: none;
    font: 500 12.5px var(--mr-font-sans);
    color: var(--mr-text-1);
  }
  .sp__input input::placeholder { color: var(--mr-text-5); font-weight: 400; }

  .sp__spin {
    flex: none;
    width: 11px;
    height: 11px;
    border: 1.5px solid var(--mr-border-strong);
    border-top-color: var(--mr-accent);
    border-radius: 50%;
    animation: spin 700ms linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .sp__clear {
    flex: none;
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--mr-text-5);
  }
  .sp__clear:hover { background: var(--mr-surface-track); color: var(--mr-text-1); }

  .sp__meta {
    margin: 8px 2px 0;
    font: 400 11px/1.55 var(--mr-font-sans);
    color: var(--mr-text-5);
    flex: none;
  }

  .sp__warn {
    margin: 8px 2px 0;
    padding: 6px 8px;
    border-radius: var(--mr-radius-sm);
    background: color-mix(in srgb, var(--mr-warn, #b89968) 12%, transparent);
    font: 400 10.5px/1.6 var(--mr-font-sans);
    color: var(--mr-text-3);
    flex: none;
  }

  .sp__results {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 10px;
    padding-bottom: 14px;
  }

  .sp__empty { margin: 14px 4px 0; }
  .sp__empty-t {
    margin: 0;
    font: 500 12px var(--mr-font-sans);
    color: var(--mr-text-3);
  }
  .sp__empty-d {
    margin: 6px 0 0;
    font: 400 11.5px/1.75 var(--mr-font-sans);
    color: var(--mr-text-5);
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
    border-left: 2px solid transparent;
    text-align: left;
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
</style>
