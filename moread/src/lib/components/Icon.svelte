<script lang="ts">
  /**
   * 统一图标出口。全部为 24×24 描边 SVG，颜色一律 currentColor，
   * 由外层文字色决定 —— 这样选中态、悬停态不需要单独传色。
   * （规范第 7 章：禁止用 emoji / Unicode 字形当图标）
   */
  interface Props {
    name: string;
    size?: number;
  }
  let { name, size = 14 }: Props = $props();

  const P: Record<string, string> = {
    doc: '<path d="M6 3h7.5L18 7.5V21H6z" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="M13 3v5h5" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>',
    folder:
      '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>',
    chevronDown:
      '<path d="M6 9.5l6 6 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
    chevronRight:
      '<path d="M9.5 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
    chevronLeft:
      '<path d="M14.5 6l-6 6 6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
    search:
      '<circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="1.9"/><path d="M16 16l4.5 4.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
    // 历史：钟面 + 时针分针。不用"逆时针箭头"，14px 下那个弧线会糊成一团
    clock:
      '<circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.9"/><path d="M12 7.6V12l3.1 1.9" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
    close:
      '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
    plus: '<path d="M12 6v12M6 12h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    minus: '<path d="M5 12h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    maximize:
      '<rect x="5.5" y="5.5" width="13" height="13" stroke="currentColor" stroke-width="1.5"/>',
    sun: '<circle cx="12" cy="12" r="4.2" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    moon: '<path d="M20.2 13.8A8.2 8.2 0 0 1 10.2 3.8a6.8 6.8 0 1 0 10 10z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
    apps: '<path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
    copy: '<rect x="8" y="8" width="11.5" height="11.5" rx="2.5" stroke="currentColor" stroke-width="1.9"/><path d="M5.5 15.5V6a2 2 0 0 1 2-2h9" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
    refresh:
      '<path d="M20 12a8 8 0 1 1-2.6-5.9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M20 4v4.5h-4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    download:
      '<path d="M12 3.5v11M7.5 10l4.5 4.5L16.5 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 19.5h15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    warn: '<path d="M12 4.5v10" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="19" r="1.6" fill="currentColor"/>',
    // 竖式图钉：**实心钉头**。11px 下描边版只剩一团细线，看不出是钉子，
    // 而固定标签恰恰靠这个图标一眼辨认，所以这里牺牲精细度换取可读性。
    pin: '<path d="M9.3 4.2h5.4a.7.7 0 0 1 .7.7v4.2l1.9 2.8a.7.7 0 0 1-.6 1.1H7.3a.7.7 0 0 1-.6-1.1l1.9-2.8V4.9a.7.7 0 0 1 .7-.7z" fill="currentColor"/><path d="M12 13v6.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  };
</script>

<svg
  viewBox="0 0 24 24"
  fill="none"
  width={size}
  height={size}
  aria-hidden="true"
  focusable="false"
>
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  {@html P[name] ?? ''}
</svg>
