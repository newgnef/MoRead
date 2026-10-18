<script lang="ts">
  import Icon from './Icon.svelte';
  import type { RecentItem } from '../types';
  import type { BackendKind } from '../platform';

  interface Props {
    recents: RecentItem[];
    backend: BackendKind;
    onOpenFolder: () => void;
    onOpenFile: () => void;
    onLoadSample: () => void;
    onPickRecent: (item: RecentItem) => void;
    onClear: () => void;
  }

  let { recents, backend, onOpenFolder, onOpenFile, onLoadSample, onPickRecent, onClear }: Props = $props();

  const canTouchDisk = $derived(backend !== 'none');
</script>

<div class="empty">
  <!-- 品牌标记：一支毛笔，与 App 图标同构 -->
  <!-- 与安装图标同一个形状（一本翻开的书）；这里不铺绿底块，
       暖白画布上太抢眼，改成墨线勾轮廓 + 淡绿纸面 -->
  <svg viewBox="0 0 64 64" width="58" height="58" aria-hidden="true">
    <path
      d="M32 28.0
         C27.8 23.6 20.6 18.4 15.4 17.4
         Q 11.6 16.6 11.5 19.8
         L12.3 37.4
         C12.6 40.3 14.2 41.6 16.8 42.0
         C22.4 42.9 28.6 43.9 32 45.7
         C35.4 43.9 41.6 42.9 47.2 42.0
         C49.8 41.6 51.4 40.3 51.7 37.4
         L52.5 19.8
         Q 52.4 16.6 48.6 17.4
         C 43.4 18.4 36.2 23.6 32 28.0
         Z"
      fill="var(--mr-accent-soft)"
      stroke="var(--mr-accent)"
      stroke-width="2"
      stroke-linejoin="round"
    />
    <path d="M32 29.4 V 41.2" stroke="var(--mr-accent)" stroke-width="4" stroke-linecap="round" />
  </svg>

  <h1 class="empty__title">MoRead</h1>
  <p class="empty__tag">把本地 Markdown 读到舒服为止 —— 纯只读，不碰你的文件</p>

  <div class="empty__actions">
    <button class="btn btn--primary" type="button" onclick={onOpenFolder} disabled={!canTouchDisk}>
      <Icon name="folder" size={15} />打开文件夹
    </button>
    <button class="btn btn--secondary" type="button" onclick={onOpenFile}>
      <Icon name="doc" size={15} />打开文件
    </button>
  </div>

  <p class="empty__hint">
    {#if canTouchDisk}
      打开一个装满 Markdown 的文件夹，左侧会列出全部文档并在文件被外部修改时自动重载。也可以直接拖进来，或按 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd>
    {:else}
      当前环境不支持直接读磁盘，请把 .md 文件拖进来 —— 或者
      <button class="linkish" type="button" onclick={onLoadSample}>载入示例文档</button>
    {/if}
  </p>

  {#if recents.length > 0}
    <div class="empty__listhead" style:width="var(--mr-empty-panel-w)" style:display="flex">
      <span>最近打开</span>
      <button class="linkish" type="button" onclick={onClear}>清除记录</button>
    </div>
    <div class="empty__list" style:margin-top="0">
      {#each recents as item (item.kind + ':' + item.path)}
        <button class="recent-row" type="button" onclick={() => onPickRecent(item)} title={item.path}>
          <Icon name={item.kind === 'dir' ? 'folder' : 'doc'} size={16} />
          <span class="recent-row__col">
            <span class="recent-row__name">{item.name}</span>
            <span class="recent-row__path">{item.path.startsWith('moread://') ? '内置示例' : item.path}</span>
          </span>
          <span class="recent-row__time">{item.time}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .linkish {
    font: 400 12px var(--mr-font-sans);
    color: var(--mr-text-4);
    padding: 2px 4px;
    border-radius: var(--mr-radius-sm);
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--mr-text-4) 40%, transparent);
    text-underline-offset: 2px;
  }
  .linkish:hover { background: var(--mr-surface-track); color: var(--mr-text-1); }

  .empty__hint kbd {
    font: 400 11px var(--mr-font-mono);
    padding: 1px 5px;
    border: 1px solid var(--mr-border-strong);
    border-bottom-width: 1.5px;
    border-radius: 4px;
    background: var(--mr-canvas);
    color: var(--mr-text-3);
  }

  .empty__actions :global(.btn:disabled) {
    opacity: .45;
    cursor: default;
  }
</style>
