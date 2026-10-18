<script lang="ts">
  import Icon from './Icon.svelte';
  import type { SidebarMode } from '../types';

  interface Props {
    mode: SidebarMode;
    /** 点某个图标：展开侧栏并切到该模式 */
    onOpenMode: (m: SidebarMode) => void;
    onExpand: () => void;
  }

  let { mode, onOpenMode, onExpand }: Props = $props();

  /**
   * 收起后不彻底消失，留一条 44px 的图标栏。
   * 理由：读长文时想要的是"不占地方"，不是"再也找不到文件树" ——
   * 彻底藏起来之后唯一的回头路是 Ctrl+B，而这正是没人记得住的快捷键。
   * 留三个图标等于把入口缩到最小，同时把"展开"这件事摆到脸上。
   */
  const ITEMS: { id: SidebarMode; icon: string; label: string }[] = [
    { id: 'files', icon: 'folder', label: '文件' },
    { id: 'outline', icon: 'apps', label: '大纲' },
    { id: 'search', icon: 'search', label: '搜索' },
  ];

  function onKey(e: KeyboardEvent, m: SidebarMode) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpenMode(m);
    }
  }
</script>

<aside class="rail" aria-label="侧栏已收起">
  {#each ITEMS as it (it.id)}
    <button
      class="rail__b"
      class:is-active={mode === it.id}
      type="button"
      data-mode={it.id}
      title={`${it.label}（点击展开侧栏）`}
      aria-label={`展开侧栏并切到${it.label}`}
      aria-pressed={mode === it.id}
      onclick={() => onOpenMode(it.id)}
      onkeydown={(e) => onKey(e, it.id)}
    >
      <Icon name={it.icon} size={16} />
    </button>
  {/each}

  <button
    class="rail__b rail__b--expand"
    type="button"
    title="展开侧栏 (Ctrl+B)"
    aria-label="展开侧栏"
    onclick={onExpand}
  >
    <Icon name="chevronRight" size={14} />
  </button>
</aside>

<style>
  .rail {
    flex: none;
    width: var(--mr-rail-w);
    background: var(--mr-chrome);
    border-right: 1px solid var(--mr-border);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 10px 0;
  }

  .rail__b {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: var(--mr-radius-sm);
    color: var(--mr-text-5);
    transition: color var(--mr-dur-hover) var(--mr-ease-out),
                background-color var(--mr-dur-hover) var(--mr-ease-out);
  }
  .rail__b:hover { background: var(--mr-surface-track); color: var(--mr-text-1); }

  /* 当前模式：和激活标签同一套语言 —— 白底 + 墨绿图标，而不是整块高亮 */
  .rail__b.is-active {
    background: var(--mr-surface);
    color: var(--mr-accent);
  }

  /* 展开按钮沉到底部，和上面三个模式图标分开，避免误点 */
  .rail__b--expand {
    margin-top: auto;
    color: var(--mr-text-6);
  }
  .rail__b--expand:hover { color: var(--mr-accent); }
</style>
