<script lang="ts">
  import Icon from './Icon.svelte';
  import type { HostInfo } from '../platform';

  interface Props {
    open: boolean;
    host: HostInfo | null;
    /** 最近用过的工作区绝对路径 */
    recents: string[];
    onPick: (path: string) => void;
    onClose: () => void;
  }

  let { open, host, recents, onPick, onClose }: Props = $props();

  let typed = $state('');
  let inputEl = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (open) {
      typed = '';
      // 弹窗出现后自动聚焦，符合原生目录选择器的肌肉记忆
      queueMicrotask(() => inputEl?.focus());
    }
  });

  const shortcuts = $derived.by(() => {
    if (!host) return [] as { label: string; path: string; hint: string }[];
    const list: { label: string; path: string; hint: string }[] = [];
    for (const d of host.drives ?? []) list.push({ label: d, path: d, hint: '磁盘根目录' });
    if (host.home) list.push({ label: '主目录', path: host.home, hint: host.home });
    if (host.cwd) list.push({ label: '当前工程', path: host.cwd, hint: host.cwd });
    return list;
  });

  function submit() {
    const v = typed.trim();
    if (!v) return;
    onPick(v.replace(/^"|"$/g, ''));
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  }
</script>

{#if open}
  <div class="veil" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="打开文件夹">
      <header class="sheet__h">
        <Icon name="folder" size={15} />
        <span class="sheet__t">打开文件夹</span>
        <button class="sheet__x" type="button" aria-label="关闭" onclick={onClose}>
          <Icon name="close" size={11} />
        </button>
      </header>

      <div class="sheet__b">
        <label class="field">
          <span class="field__l">文件夹路径</span>
          <div class="field__box">
            <input
              bind:this={inputEl}
              bind:value={typed}
              onkeydown={onKey}
              placeholder="例如 D:\notes"
              spellcheck="false"
              autocomplete="off"
              aria-label="文件夹路径"
            />
            <button class="btn btn--primary" type="button" onclick={submit} disabled={!typed.trim()}>
              打开
            </button>
          </div>
        </label>

        {#if shortcuts.length > 0}
          <div class="group">
            <p class="group__t">快速定位</p>
            {#each shortcuts as s (s.path)}
              <button class="qrow" type="button" onclick={() => onPick(s.path)}>
                <Icon name={s.label.length === 3 ? 'folder' : 'folder'} size={13} />
                <span class="qrow__n">{s.label}</span>
                <span class="qrow__p">{s.hint}</span>
              </button>
            {/each}
          </div>
        {/if}

        {#if recents.length > 0}
          <div class="group">
            <p class="group__t">最近工作区</p>
            {#each recents as r (r)}
              <button class="qrow" type="button" onclick={() => onPick(r)}>
                <Icon name="folder" size={13} />
                <span class="qrow__n">{r.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? r}</span>
                <span class="qrow__p">{r}</span>
              </button>
            {/each}
          </div>
        {/if}

        {#if !host}
          <p class="note">
            当前环境不提供目录选择能力。可手动粘贴路径（仅开发预览模式支持读取本机磁盘）。
          </p>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .veil {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--mr-canvas) 74%, transparent);
    backdrop-filter: saturate(1.1) blur(2px);
  }
  .sheet {
    width: 520px;
    max-height: 74vh;
    display: flex;
    flex-direction: column;
    background: var(--mr-surface);
    border: 1px solid var(--mr-border);
    border-radius: var(--mr-radius-lg);
    box-shadow: var(--mr-shadow-popover);
    overflow: hidden;
  }
  .sheet__h {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 13px 14px;
    border-bottom: 1px solid var(--mr-border);
    color: var(--mr-text-2);
  }
  .sheet__t {
    flex: 1;
    font: 500 13px var(--mr-font-sans);
    color: var(--mr-text-1);
  }
  .sheet__x {
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    border-radius: var(--mr-radius-sm);
    color: var(--mr-text-4);
  }
  .sheet__x:hover { background: var(--mr-surface-track); color: var(--mr-text-1); }

  .sheet__b {
    padding: 14px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .field__l {
    display: block;
    margin-bottom: 6px;
    font: 500 11.5px var(--mr-font-sans);
    color: var(--mr-text-4);
  }
  .field__box { display: flex; gap: 8px; }
  .field__box input {
    flex: 1;
    height: 34px;
    padding: 0 10px;
    border: 1px solid var(--mr-border-strong);
    border-radius: var(--mr-radius-sm);
    background: var(--mr-canvas);
    font: 400 12.5px var(--mr-font-mono);
    color: var(--mr-text-1);
  }
  .field__box input:focus {
    outline: none;
    border-color: var(--mr-accent);
  }

  .btn {
    height: 34px;
    padding: 0 16px;
    border-radius: var(--mr-radius-sm);
    font: 500 12.5px var(--mr-font-sans);
  }
  .btn--primary {
    background: var(--mr-accent);
    color: #fff;
  }
  .btn--primary:disabled { opacity: .45; cursor: default; }

  .group__t {
    margin: 0 0 6px 2px;
    font: 500 11px var(--mr-font-sans);
    color: var(--mr-text-5);
  }
  .qrow {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 8px 10px;
    border-radius: var(--mr-radius-sm);
    color: var(--mr-text-2);
    text-align: left;
  }
  .qrow:hover { background: var(--mr-surface-track); }
  .qrow__n {
    font: 500 12.5px var(--mr-font-sans);
    color: var(--mr-text-1);
    flex: none;
  }
  .qrow__p {
    flex: 1;
    text-align: right;
    font: 400 11px var(--mr-font-mono);
    color: var(--mr-text-5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
  }
  .note {
    margin: 0;
    font: 400 11.5px/1.7 var(--mr-font-sans);
    color: var(--mr-text-5);
  }
</style>
