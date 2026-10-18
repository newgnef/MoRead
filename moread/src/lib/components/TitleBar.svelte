<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import type { DocTab, TabCloseMode } from '../types';
  import {
    PALETTES, paletteName, readSize,
    type ResolvedTheme, type ThemeMode, type ThemePalette,
  } from '../tokens';
  import { closeWindow, isTauri, minimizeWindow, toggleMaximizeWindow } from '../platform';

  interface Props {
    tabs: DocTab[];
    activeId: string;
    /** 当前浅/深，决定按钮上是太阳还是月亮 */
    scheme: ResolvedTheme;
    palette: ThemePalette;
    themeMode: ThemeMode;
    onPickTheme: (p: ThemePalette, s: ResolvedTheme) => void;
    onFollowSystem: (on: boolean) => void;
    /** 正文字号（px）与它的改变入口；面板里的 A− / A+ 直接调 */
    fontSize: number;
    onFontSize: (px: number) => void;
    onSelect: (id: string) => void;
    onClose: (id: string) => void;
    onOpen: () => void;
    /** 批量关闭：锚点是右键点中的那个标签 */
    onCloseMany: (mode: TabCloseMode, anchorId: string) => void;
    onTogglePin: (id: string) => void;
    /** 拖拽换位：把 fromId 插到 toId 的前面或后面 */
    onReorder: (fromId: string, toId: string, side: 'before' | 'after') => void;
  }

  let {
    tabs, activeId, scheme, palette, themeMode,
    onSelect, onClose, onOpen, onPickTheme, onFollowSystem,
    fontSize, onFontSize,
    onCloseMany, onTogglePin, onReorder,
  }: Props = $props();

  /* ---------------------------- 外观面板 ---------------------------- */

  /**
   * 六个选项（3 色调 × 浅深）一次摆开，不做"先选色调再选深浅"的两步流程 ——
   * 调主题本质上是眼睛在挑，来回点着看最快。
   *
   * 面板选完**不自动关**：连着对比几套是常态，每点一次就收起反而碍事；
   * 点空白处或 Esc 关。
   */
  let themeOpen = $state(false);
  let themePos = $state({ right: 0, top: 0 });
  let themeBtn = $state<HTMLElement | null>(null);

  function openTheme() {
    const btn = themeBtn;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    // 右边缘对齐按钮，面板向左展开 —— 不需要先量宽度，也就不会闪一下
    themePos = { right: Math.max(8, window.innerWidth - r.right), top: r.bottom + 6 };
    themeOpen = true;
  }

  function closeTheme() {
    themeOpen = false;
  }

  const SCHEMES = [
    { id: 'light', label: '浅色' },
    { id: 'dark', label: '深色' },
  ] as const;

  /* ---------------------------- 右键菜单 ---------------------------- */

  let menu = $state<{ x: number; y: number; tabId: string } | null>(null);
  let menuEl = $state<HTMLElement | null>(null);

  const menuIdx = $derived(menu ? tabs.findIndex((t) => t.id === menu!.tabId) : -1);
  const menuTab = $derived(menuIdx >= 0 ? tabs[menuIdx] : null);

  /**
   * 每条批量关闭的可关闭数量。固定标签一律不计入 ——
   * 按钮的禁用态要和真正的行为对得上，否则用户点了没反应更困惑。
   */
  const closableAll = $derived(tabs.filter((t) => !t.pinned).length);
  const closableOthers = $derived(
    tabs.filter((t, i) => i !== menuIdx && !t.pinned).length,
  );
  const closableLeft = $derived(
    menuIdx > 0 ? tabs.slice(0, menuIdx).filter((t) => !t.pinned).length : 0,
  );
  const closableRight = $derived(
    menuIdx >= 0 ? tabs.slice(menuIdx + 1).filter((t) => !t.pinned).length : 0,
  );

  async function openMenu(e: MouseEvent, tabId: string) {
    e.preventDefault();
    e.stopPropagation();
    menu = { x: e.clientX, y: e.clientY, tabId };

    // 先渲染再量真实尺寸，然后贴边收进来。用估算值会有一两像素的偏差，
    // 而菜单贴到窗口右边缘时这种偏差很明显。
    await tick();
    const el = menuEl;
    if (!el || !menu) return;
    const r = el.getBoundingClientRect();
    const pad = 6;
    menu = {
      ...menu,
      x: Math.max(pad, Math.min(menu.x, window.innerWidth - r.width - pad)),
      y: Math.max(pad, Math.min(menu.y, window.innerHeight - r.height - pad)),
    };
  }

  function closeMenu() {
    menu = null;
  }

  function act(mode: TabCloseMode) {
    if (!menu) return;
    const anchor = menu.tabId;
    closeMenu();
    onCloseMany(mode, anchor);
  }

  function actPin() {
    if (!menu) return;
    const id = menu.tabId;
    closeMenu();
    onTogglePin(id);
  }

  function onGlobalKey(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    if (menu) {
      e.preventDefault();
      closeMenu();
    } else if (moreOpen) {
      e.preventDefault();
      closeMore();
    } else if (themeOpen) {
      e.preventDefault();
      closeTheme();
    }
  }

  /* ---------------------------- 标签溢出 ---------------------------- */

  /**
   * 标签多到装不下，三步走 —— 也就是同类产品收敛出来的同一套：
   * ❶ 先缩宽：220px 一路收到 100px，十几份文档通常还都看得见；
   * ❷ 再滚动：标签条横向滚动，滚轮能推，活动标签自动追进视野；
   * ❸ 兜底菜单：⌄ 只列出当前滚出视野的那几个，点一下就切过去，
   *    不必"先猜在哪个方向、再滚几下"。
   * 只有第 ❸ 步进浮层，仍然守住"全站只有浮层有阴影"的规矩。
   */
  let stripEl = $state<HTMLElement | null>(null);
  let moreEl = $state<HTMLElement | null>(null);
  let overflowing = $state(false);
  let hiddenCount = $state(0);
  let moreOpen = $state(false);
  let morePos = $state({ right: 0, top: 0 });
  let hiddenTabs = $state<DocTab[]>([]);

  function findTabNode(id: string): HTMLElement | null {
    const el = stripEl;
    if (!el) return null;
    for (const n of el.querySelectorAll<HTMLElement>('.tab')) {
      if (n.dataset.tabId === id) return n;
    }
    return null;
  }

  /** 视野外（含被左边缘切掉）的标签数量，用来写 ⌄ 的提示语 */
  function countOffscreen(): number {
    const el = stripEl;
    if (!el) return 0;
    const c = el.getBoundingClientRect();
    let n = 0;
    for (const node of el.querySelectorAll<HTMLElement>('.tab')) {
      const r = node.getBoundingClientRect();
      if (r.right > c.right + 0.5 || r.left < c.left - 0.5) n++;
    }
    return n;
  }

  function refreshOverflow() {
    const el = stripEl;
    if (!el) {
      overflowing = false;
      hiddenCount = 0;
      return;
    }
    // 差 1px 属亚像素误差，不能当成"溢出了"，否则窗口刚好够宽时也会冒出 ⌄
    const over = el.scrollWidth - el.clientWidth > 1;
    overflowing = over;
    hiddenCount = over ? countOffscreen() : 0;
  }

  // 标签增删、改名都可能改宽度；等布局落定再量，否则量到的是上一轮的宽度
  $effect(() => {
    void tabs.length;
    void tabs.map((t) => t.name).join('\u0000');
    refreshOverflow();
  });

  // 窗口缩放、字体（首屏换字体会改宽度）都会改可用宽度
  $effect(() => {
    const el = stripEl;
    if (!el) return;
    const ro = new ResizeObserver(() => refreshOverflow());
    ro.observe(el);
    void document.fonts?.ready.then(() => refreshOverflow());
    return () => ro.disconnect();
  });

  // 滚轮横推 + 滚动时更新 ⌄ 的计数
  $effect(() => {
    const el = stripEl;
    if (!el) return;

    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        hiddenCount = countOffscreen();
      });
    };
    // 鼠标只有一个滚轮。不把竖向滚动映射成横向，用户就只能去摸触控板
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth - el.clientWidth <= 1) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // 本来就是横滑，交给浏览器
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  });

  /**
   * 把某个标签追进视野。
   * 用 getBoundingClientRect 做相对位移，而不是 scrollIntoView ——
   * 后者会顺带滚动祖先滚动容器（正文那一栏），读长文时切个标签整页往上跳。
   */
  function revealTab(id: string) {
    const el = stripEl;
    const node = findTabNode(id);
    if (!el || !node) return;
    const c = el.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    const pad = 4;
    if (r.left < c.left) el.scrollLeft += r.left - c.left - pad;
    else if (r.right > c.right) el.scrollLeft += r.right - c.right + pad;
  }

  /**
   * 活动标签必须自己滚进视野：连按 Ctrl+Tab、或从侧栏打开一个排在末尾的文件，
   * 活动项很可能正好在容器外面，不追过去用户会以为"点了没反应"。
   */
  $effect(() => {
    const id = activeId;
    revealTab(id);
  });

  function openMore() {
    const el = stripEl;
    const btn = moreEl;
    if (!el || !btn) return;

    const c = el.getBoundingClientRect();
    hiddenTabs = tabs.filter((t) => {
      const node = findTabNode(t.id);
      if (!node) return false;
      const r = node.getBoundingClientRect();
      return r.right > c.right + 0.5 || r.left < c.left - 0.5;
    });

    // 右边缘对齐按钮：菜单宽度不必先量，也就没有"先渲染再跳位"的闪动
    const br = btn.getBoundingClientRect();
    morePos = { right: Math.max(8, window.innerWidth - br.right), top: br.bottom + 4 };
    moreOpen = true;
  }

  function closeMore() {
    moreOpen = false;
  }

  /* ---------------------------- 拖拽换位 ---------------------------- */

  let dragId = $state<string | null>(null);
  let dropHint = $state<{ id: string; side: 'before' | 'after' } | null>(null);

  /**
   * 最近一次拖拽结束的时间。拖完马上双击很容易被误判成「双击关闭」——
   * 拖拽落点的鼠标抬起与随后的双击在系统看来是同一串按下/抬起，
   * 拿时间差挡一下，比事后解释「为什么拖一下就关了个标签」省事。
   */
  let dragEndedAt = 0;

  /**
   * 双击标签关闭它。
   *
   * 两条必须排除的路：
   * ❶ 落在关闭按钮上 —— 第一次点击已经把标签关掉了，第二次点击多半落在
   *    补位上来的另一个标签的 × 上，会连带关掉第二个（用户只想关一个）。
   * ❷ 刚结束拖拽 —— 见上面 dragEndedAt 的说明。
   *
   * 固定标签不在这里判断：App 的 closeTab() 是唯一的关闭入口，
   * 里面已经有固定守卫并会给出提示，双击绕不过去。
   */
  function onTabDblClick(e: MouseEvent, id: string) {
    if ((e.target as HTMLElement | null)?.closest('.tab__close')) return;
    if (dragId || performance.now() - dragEndedAt < 250) return;
    e.preventDefault();
    onClose(id);
  }

  function onDragStart(e: DragEvent, id: string) {
    dragId = id;
    // 必须 setData，否则部分 WebView 不认为拖拽已开始，drop 不会触发
    e.dataTransfer?.setData('text/plain', id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }

  function onDragOver(e: DragEvent, id: string) {
    if (!dragId || dragId === id) {
      dropHint = null;
      return;
    }
    // 必须掐断冒泡：App 在 window 上挂了「拖文件进来」的处理，
    // 标签之间拖动会一路冒到那里，弹出「只支持拖入 .md」的假提示、
    // 甚至拉起整屏的拖放遮罩。这是实测暴露出来的，不是理论风险。
    e.stopPropagation();
    e.preventDefault(); // 不阻止默认行为就收不到 drop
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

    // 以标签中线为界判定插到前面还是后面 —— 这比「总是插到左边」直观得多
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const side: 'before' | 'after' = e.clientX < r.left + r.width / 2 ? 'before' : 'after';
    if (dropHint?.id !== id || dropHint?.side !== side) dropHint = { id, side };
  }

  function onDrop(e: DragEvent) {
    e.stopPropagation();
    e.preventDefault();
    const from = dragId;
    const hint = dropHint;
    dragId = null;
    dropHint = null;
    if (!from || !hint) return;
    onReorder(from, hint.id, hint.side);
  }

  function onDragEnd() {
    dragId = null;
    dropHint = null;
    dragEndedAt = performance.now();
  }

  /** 拖出整个标签条时清掉指示线，否则会留在原地 */
  function onStripLeave(e: DragEvent) {
    const next = e.relatedTarget as Node | null;
    if (!next || !(e.currentTarget as HTMLElement).contains(next)) dropHint = null;
  }

  function onTabKey(e: KeyboardEvent, id: string) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(id);
    }
  }
</script>

<svelte:window onkeydown={onGlobalKey} onresize={() => { closeMenu(); closeTheme(); }} />

<!-- 标题栏与标签栏合并成一行：省一行高度给正文（规范 §4） -->
<!-- data-tauri-drag-region：无边框窗口下由这里承担拖动职责 -->
<header class="titlebar">
  <div class="titlebar__row" data-tauri-drag-region>
    <!-- 品牌标记 -->
    <!-- 品牌标记：一支毛笔，与 App 图标同构 -->
    <!--
      与安装图标同一个形状（一本翻开的书），缩到 20px。
      书脊缝用 fill-rule=evenodd 挖成真正的透明洞 —— 这样不管标题栏
      是什么底色都对，不必为它硬编码一个颜色。
    -->
    <svg class="app-mark" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill-rule="evenodd"
        fill="var(--mr-accent)"
        d="M12 10.5
           C10.43 8.85 7.73 6.9 5.78 6.53
           Q4.35 6.23 4.31 7.43
           L4.61 14.03
           C4.73 15.11 5.33 15.6 6.3 15.75
           C8.4 16.09 10.73 16.46 12 17.14
           C13.27 16.46 15.6 16.09 17.7 15.75
           C18.68 15.6 19.28 15.11 19.39 14.03
           L19.69 7.43
           Q19.65 6.23 18.23 6.53
           C16.28 6.9 13.57 8.85 12 10.5
           Z
           M11.2 10.9
           a0.8 0.8 0 0 1 1.6 0
           v3.8
           a0.8 0.8 0 0 1 -1.6 0
           z"
      />
    </svg>

    <div class="tabstrip" class:tabstrip--tight={overflowing} role="presentation" ondragleave={onStripLeave}>
      <div
        class="tabstrip__scroll"
        bind:this={stripEl}
        role="tablist"
        aria-label="已打开的文档"
        tabindex="-1"
      >
        {#each tabs as tab (tab.id)}
          <div
            class="tab"
            data-tab-id={tab.id}
            class:tab--active={tab.id === activeId}
            class:tab--pinned={tab.pinned}
            class:tab--dragging={dragId === tab.id}
            class:tab--drop-start={dropHint?.id === tab.id && dropHint.side === 'before'}
            class:tab--drop-end={dropHint?.id === tab.id && dropHint.side === 'after'}
            role="tab"
            tabindex={tab.id === activeId ? 0 : -1}
            aria-selected={tab.id === activeId}
            title={tab.pinned ? `${tab.path}（已固定，不会被关闭）` : `${tab.path}（双击关闭）`}
            draggable="true"
            onclick={() => onSelect(tab.id)}
            ondblclick={(e) => onTabDblClick(e, tab.id)}
            onkeydown={(e) => onTabKey(e, tab.id)}
            onauxclick={(e) => {
              if (e.button === 1) { e.preventDefault(); onClose(tab.id); }
            }}
            oncontextmenu={(e) => openMenu(e, tab.id)}
            ondragstart={(e) => onDragStart(e, tab.id)}
            ondragover={(e) => onDragOver(e, tab.id)}
            ondrop={onDrop}
            ondragend={onDragEnd}
          >
            {#if tab.pinned}
              <span class="tab__pin"><Icon name="pin" size={12} /></span>
            {:else}
              <Icon name="doc" size={13} />
            {/if}
            <span class="tab__name">{tab.name}</span>
            {#if tab.missing}
              <span class="tab__dot tab__dot--err" title="文件已不存在或被移走"></span>
            {:else if tab.stale}
              <span class="tab__dot" title="磁盘上有更新"></span>
            {/if}
            {#if !tab.pinned}
              <button
                class="tab__close"
                type="button"
                aria-label={`关闭 ${tab.name}`}
                onclick={(e) => { e.stopPropagation(); onClose(tab.id); }}
              >
                <Icon name="close" size={11} />
              </button>
            {/if}
          </div>
        {/each}
      </div>

      {#if overflowing}
        <button
          class="icon-btn tabstrip__more"
          bind:this={moreEl}
          type="button"
          title={hiddenCount > 0 ? `还有 ${hiddenCount} 个标签页没显示` : '更多标签页'}
          aria-label="更多标签页"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onclick={openMore}
        >
          <Icon name="chevronDown" size={14} />
        </button>
      {/if}

      <button class="icon-btn" type="button" title="打开文件 (Ctrl+O)" aria-label="打开文件" onclick={onOpen}>
        <Icon name="plus" size={15} />
      </button>
    </div>

    <div class="titlebar__spacer"></div>

    <button
      class="icon-btn"
      class:is-on={themeOpen}
      bind:this={themeBtn}
      type="button"
      title={`外观：${paletteName(palette)} · ${scheme === 'dark' ? '深色' : '浅色'}`}
      aria-label="外观设置"
      aria-haspopup="dialog"
      aria-expanded={themeOpen}
      onclick={() => (themeOpen ? closeTheme() : openTheme())}
    >
      <Icon name={scheme === 'dark' ? 'sun' : 'moon'} size={15} />
    </button>

    <!-- 无边框窗口的自绘控制按钮；浏览器预览下不生效但不报错 -->
    <div class="wincontrols">
      <button type="button" title="最小化" aria-label="最小化" onclick={() => minimizeWindow()}>
        <Icon name="minus" size={11} />
      </button>
      <button type="button" title="最大化 / 还原" aria-label="最大化" onclick={() => toggleMaximizeWindow()}>
        <Icon name="maximize" size={11} />
      </button>
      <button
        type="button"
        title={isTauri ? '收起到托盘（右键托盘图标可退出）' : '关闭'}
        aria-label={isTauri ? '收起到托盘' : '关闭'}
        class="is-close"
        onclick={() => closeWindow()}
      >
        <Icon name="close" size={11} />
      </button>
    </div>
  </div>
</header>

{#if moreOpen}
  <div
    class="menu-veil"
    role="presentation"
    onclick={closeMore}
    oncontextmenu={(e) => { e.preventDefault(); closeMore(); }}
  ></div>

  <div
    class="moremenu"
    role="menu"
    style:right={`${morePos.right}px`}
    style:top={`${morePos.top}px`}
  >
    <div class="tabmenu__head">没显示出来的标签页 · {hiddenTabs.length}</div>
    {#each hiddenTabs as t (t.id)}
      <button
        class="tabmenu__i"
        type="button"
        role="menuitem"
        title={t.path}
        onclick={() => { closeMore(); onSelect(t.id); }}
      >
        {#if t.pinned}
          <span class="tab__pin"><Icon name="pin" size={11} /></span>
        {:else}
          <Icon name="doc" size={11} />
        {/if}
        <span class="tabmenu__label">{t.name}</span>
      </button>
    {:else}
      <!-- 只溢出几个像素时可能一个都没完全出界，给一行说明，别留个空壳 -->
      <div class="tabmenu__head">都在视野里，向左滚一下即可</div>
    {/each}
  </div>
{/if}

{#if themeOpen}
  <div
    class="menu-veil"
    role="presentation"
    onclick={closeTheme}
    oncontextmenu={(e) => { e.preventDefault(); closeTheme(); }}
  ></div>

  <div
    class="themepop"
    role="dialog"
    aria-label="外观"
    style:right={`${themePos.right}px`}
    style:top={`${themePos.top}px`}
  >
    <div class="themepop__h">外观</div>

    <div class="themepop__grid">
      <span></span>
      {#each SCHEMES as s (s.id)}
        <span class="themepop__col">{s.label}</span>
      {/each}

      {#each PALETTES as p (p.id)}
        <span class="themepop__row" title={p.hint}>{p.name}</span>
        {#each SCHEMES as s (s.id)}
          <!--
            色卡不是画出来的色块，而是把 data-palette / data-theme 直接挂到
            卡片上，让 tokens.css 自己算 —— 所以卡片永远和真实主题一致，
            不会出现"色卡是旧配色"的漂移。
          -->
          <button
            class="sw"
            class:is-on={palette === p.id && scheme === s.id}
            type="button"
            role="menuitemradio"
            aria-checked={palette === p.id && scheme === s.id}
            aria-label={`${p.name}${s.label}`}
            title={`${p.hint} · ${s.label}`}
            onclick={() => onPickTheme(p.id, s.id)}
          >
            <span class="sw__card" data-palette={p.id} data-theme={s.id}>
              <span class="sw__bar"></span>
              <span class="sw__dot"></span>
            </span>
          </button>
        {/each}
      {/each}
    </div>

    <div class="themepop__sep"></div>

    <!--
      字号放在主题面板里而不是另开一个入口：这两件事都属于"我读起来舒不舒服"，
      调完深色顺手就把字放大一点，是同一个动作序列。
    -->
    <div class="fontrow">
      <span class="fontrow__label">正文字号</span>
      <div class="fontrow__ctl">
        <button
          class="fbtn"
          type="button"
          aria-label="缩小字号"
          title="缩小（Ctrl + −）"
          disabled={fontSize <= readSize.min}
          onclick={() => onFontSize(fontSize - readSize.step)}
        >−</button>
        <button
          class="fnum"
          type="button"
          title={`恢复默认 ${readSize.def}px`}
          onclick={() => onFontSize(readSize.def)}
        >{fontSize}<i>px</i></button>
        <button
          class="fbtn"
          type="button"
          aria-label="放大字号"
          title="放大（Ctrl + =）"
          disabled={fontSize >= readSize.max}
          onclick={() => onFontSize(fontSize + readSize.step)}
        >+</button>
      </div>
    </div>
    <div class="themepop__hint">Ctrl + 滚轮也可调</div>

    <div class="themepop__sep"></div>

    <button
      class="themepop__sys"
      type="button"
      role="switch"
      aria-checked={themeMode === 'system'}
      onclick={() => onFollowSystem(themeMode !== 'system')}
    >
      <span>跟随系统深浅</span>
      <span class="tg" class:is-on={themeMode === 'system'}><i></i></span>
    </button>
  </div>
{/if}

{#if menu && menuTab}
  <!-- 透明遮罩：点空白处关闭菜单。比挂全局 click 更可靠，也不会误伤其它点击 -->
  <div
    class="menu-veil"
    role="presentation"
    onclick={closeMenu}
    oncontextmenu={(e) => { e.preventDefault(); closeMenu(); }}
  ></div>

  <div class="tabmenu" role="menu" bind:this={menuEl} style:left={`${menu.x}px`} style:top={`${menu.y}px`}>
    <button
      class="tabmenu__i"
      type="button"
      role="menuitem"
      disabled={!!menuTab.pinned}
      onclick={() => act('self')}
    >
      <span>关闭</span><span class="tabmenu__k">Ctrl+W</span>
    </button>
    <button
      class="tabmenu__i"
      type="button"
      role="menuitem"
      disabled={closableOthers === 0}
      onclick={() => act('others')}
    >
      <span>关闭其他标签页</span>
    </button>
    <button
      class="tabmenu__i"
      type="button"
      role="menuitem"
      disabled={closableLeft === 0}
      onclick={() => act('left')}
    >
      <span>关闭左侧标签页</span>
    </button>
    <button
      class="tabmenu__i"
      type="button"
      role="menuitem"
      disabled={closableRight === 0}
      onclick={() => act('right')}
    >
      <span>关闭右侧标签页</span>
    </button>

    <div class="tabmenu__sep"></div>

    <button
      class="tabmenu__i"
      type="button"
      role="menuitem"
      disabled={closableAll === 0}
      onclick={() => act('all')}
    >
      <span>关闭全部标签页</span>
    </button>

    <div class="tabmenu__sep"></div>

    <button class="tabmenu__i" type="button" role="menuitem" onclick={actPin}>
      <span>{menuTab.pinned ? '取消固定标签页' : '固定标签页'}</span>
    </button>
  </div>
{/if}

<style>
  /* ---------------- 标签上的状态点 ---------------- */
  .tab__dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--mr-accent);
  }
  .tab__dot--err {
    background: #b4553f;
  }

  /* ---------------- 固定标签 ---------------- */
  /* 固定标签没有关闭按钮，左右内边距对称，避免看起来"缺了一块" */
  .tab--pinned {
    padding-left: 9px;
    padding-right: 11px;
  }
  .tab__pin {
    flex: none;
    display: grid;
    place-items: center;
    color: var(--mr-accent);
  }
  .tab--pinned .tab__name {
    color: var(--mr-text-2);
  }
  .tab--pinned.tab--active .tab__name {
    color: var(--mr-text-1);
  }

  /* ---------------- 拖拽 ---------------- */
  .tab {
    position: relative;
    cursor: default;
  }
  .tab--dragging {
    opacity: 0.45;
  }
  /* 插入位置指示线：贴在目标标签的左/右边缘，2px 竖线 + 圆角 */
  .tab--drop-start::before,
  .tab--drop-end::after {
    content: '';
    position: absolute;
    top: 4px;
    bottom: 4px;
    width: 2px;
    border-radius: 1px;
    background: var(--mr-accent);
    pointer-events: none;
  }
  .tab--drop-start::before { left: -2px; }
  .tab--drop-end::after { right: -2px; }

  /* ---------------- 右键菜单 ---------------- */
  .menu-veil {
    position: fixed;
    inset: 0;
    z-index: 69;
  }
  .tabmenu {
    position: fixed;
    z-index: 70;
    min-width: 196px;
    padding: 5px;
    display: flex;
    flex-direction: column;
    background: var(--mr-surface);
    border: 1px solid var(--mr-border);
    border-radius: var(--mr-radius-md);
    box-shadow: var(--mr-shadow-popover);
  }
  /* 溢出菜单与右键菜单同一套浮层语言，只是内容不同 */
  .moremenu {
    position: fixed;
    z-index: 70;
    min-width: 208px;
    max-width: min(360px, calc(100vw - 24px));
    max-height: 60vh;
    overflow-y: auto;
    padding: 5px;
    display: flex;
    flex-direction: column;
    background: var(--mr-surface);
    border: 1px solid var(--mr-border);
    border-radius: var(--mr-radius-md);
    box-shadow: var(--mr-shadow-popover);
  }
  .tabmenu__i {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    height: 28px;
    padding: 0 8px;
    border-radius: var(--mr-radius-sm);
    font: 400 12.5px var(--mr-font-sans);
    color: var(--mr-text-1);
    text-align: left;
    white-space: nowrap;
  }
  .tabmenu__i:hover:not(:disabled) {
    background: var(--mr-surface-track);
  }
  .tabmenu__i:disabled {
    color: var(--mr-text-4);
    cursor: default;
  }
  .tabmenu__k {
    font: 400 11px var(--mr-font-mono);
    color: var(--mr-text-5);
  }
  .tabmenu__sep {
    height: 1px;
    margin: 4px 6px;
    background: var(--mr-border);
  }

  /* ---------------- 外观面板 ---------------- */
  .icon-btn.is-on {
    background: var(--mr-surface-track);
    color: var(--mr-text-1);
  }

  .themepop {
    position: fixed;
    z-index: 70;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--mr-surface);
    border: 1px solid var(--mr-border);
    border-radius: var(--mr-radius-lg);
    box-shadow: var(--mr-shadow-popover);
  }
  .themepop__h {
    font: 500 12px var(--mr-font-sans);
    color: var(--mr-text-3);
    letter-spacing: 0.02em;
  }

  /* 三列：色调名 + 浅 + 深。表头一行让"两轴"这件事一眼看懂 */
  .themepop__grid {
    display: grid;
    grid-template-columns: 32px 56px 56px;
    align-items: center;
    gap: 8px;
  }
  .themepop__col {
    font: 400 11px var(--mr-font-sans);
    color: var(--mr-text-5);
    text-align: center;
  }
  .themepop__row {
    font: 400 12px var(--mr-font-sans);
    color: var(--mr-text-3);
    white-space: nowrap;
  }

  .sw {
    padding: 0;
    border: none;
    background: none;
    border-radius: var(--mr-radius-sm);
    line-height: 0;
  }
  /* 选中环画在按钮上：按钮仍用界面自己的令牌，环色才是"当前主题"的强调色 */
  .sw.is-on {
    outline: 2px solid var(--mr-accent);
    outline-offset: 1px;
  }

  .sw__card {
    position: relative;
    display: block;
    width: 56px;
    height: 34px;
    border-radius: var(--mr-radius-sm);
    border: 1px solid var(--mr-border);
    background: var(--mr-canvas);
    overflow: hidden;
  }
  .sw:hover .sw__card { border-color: var(--mr-border-strong); }

  /* 卡内用三笔示意"这是纸、这是字、这是强调"：两道横线 + 一个圆点 */
  .sw__bar {
    position: absolute;
    left: 9px;
    top: 10px;
    width: 24px;
    height: 2px;
    border-radius: 1px;
    background: var(--mr-text-2);
  }
  .sw__bar::after {
    content: '';
    position: absolute;
    left: 0;
    top: 7px;
    width: 15px;
    height: 2px;
    border-radius: 1px;
    background: var(--mr-text-4);
  }
  .sw__dot {
    position: absolute;
    right: 8px;
    bottom: 7px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--mr-accent);
  }

  .themepop__sep {
    height: 1px;
    margin: 0 -2px;
    background: var(--mr-border-soft);
  }

  /* ---------------- 正文字号 ---------------- */
  .fontrow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    height: 26px;
  }
  .fontrow__label {
    font: 400 12px var(--mr-font-sans);
    color: var(--mr-text-2);
    white-space: nowrap;
  }
  .fontrow__ctl {
    display: flex;
    align-items: center;
    gap: 1px;
  }
  .fbtn {
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    border-radius: var(--mr-radius-sm);
    font: 500 14px/1 var(--mr-font-sans);
    color: var(--mr-text-2);
  }
  .fbtn:hover:not(:disabled) {
    background: var(--mr-surface-track);
    color: var(--mr-text-1);
  }
  .fbtn:disabled {
    color: var(--mr-text-6);
    cursor: default;
  }
  .fnum {
    min-width: 42px;
    height: 22px;
    padding: 0 4px;
    border-radius: var(--mr-radius-sm);
    font: 500 12px/1 var(--mr-font-sans);
    color: var(--mr-text-1);
    font-variant-numeric: tabular-nums;
  }
  .fnum:hover { background: var(--mr-surface-track); }
  .fnum i {
    font-style: normal;
    font-size: 10px;
    color: var(--mr-text-5);
    margin-left: 1px;
  }
  .themepop__hint {
    padding: 0 2px;
    font: 400 10.5px var(--mr-font-sans);
    color: var(--mr-text-5);
    white-space: nowrap;
  }

  .themepop__sys {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    height: 26px;
    padding: 0 2px;
    border-radius: var(--mr-radius-sm);
    font: 400 12px var(--mr-font-sans);
    color: var(--mr-text-2);
    white-space: nowrap;
  }
  .themepop__sys:hover { color: var(--mr-text-1); }

  /* 开关：26×15，滑块用 surface 白，开时整条换成强调色 */
  .tg {
    position: relative;
    flex: none;
    width: 26px;
    height: 15px;
    border-radius: var(--mr-radius-full);
    background: var(--mr-surface-track);
    border: 1px solid var(--mr-border);
    transition: background-color var(--mr-dur-hover) var(--mr-ease-out),
                border-color var(--mr-dur-hover) var(--mr-ease-out);
  }
  .tg i {
    position: absolute;
    top: 1px;
    left: 1px;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: var(--mr-text-6);
    transition: transform var(--mr-dur-hover) var(--mr-ease-out),
                background-color var(--mr-dur-hover) var(--mr-ease-out);
  }
  .tg.is-on {
    background: var(--mr-accent);
    border-color: var(--mr-accent);
  }
  .tg.is-on i {
    transform: translateX(11px);
    background: var(--mr-surface);
  }

  /* ---------------- 右侧标签溢出菜单 ---------------- */
  .tabmenu__head {
    padding: 5px 8px 7px;
    font: 400 11px var(--mr-font-sans);
    color: var(--mr-text-5);
    letter-spacing: 0.02em;
    white-space: nowrap;
  }
  /* 列表项左对齐排图标 + 名字，与右键菜单的「左文案 / 右快捷键」不同 */
  .moremenu .tabmenu__i {
    justify-content: flex-start;
    gap: 8px;
    color: var(--mr-text-2);
  }
  .tabmenu__label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
