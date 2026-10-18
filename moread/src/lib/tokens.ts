/**
 * MoRead · 设计令牌 (TypeScript)
 * v1.0 · 2026-10-16
 *
 * 用法（Svelte 5）：
 *   import { tokens, theme, setTheme } from '$lib/tokens';
 *   主题：setTheme('dark' | 'light' | 'system')
 *
 * 说明：颜色令牌以「语义名 → CSS 变量名」映射为主，真实色值只存在于 tokens.css。
 *      需要真实色值的场合（Canvas / Mermaid / Shiki 主题）用 `palette`。
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

/**
 * 主题族（色调）。
 *
 * 两轴模型：mode 决定浅深，palette 决定颜色走向。
 * 三族 × 两档 = 六套，但只有 palette 需要新增色值 —— 浅深切换复用同一套块。
 * 色值只存在于 tokens.css（`[data-palette="…"]` / `[data-palette="…"][data-theme="dark"]`），
 * 这里的 PALETTES 只是给界面用的清单（名字 + id）。
 */
export type ThemePalette = 'paper' | 'moss' | 'blue';

export const PALETTES: { id: ThemePalette; name: string; hint: string }[] = [
  { id: 'paper', name: '暖纸', hint: '暖白纸面，墨绿点缀' },
  { id: 'moss', name: '竹青', hint: '青宣底色，松墨绿' },
  { id: 'blue', name: '天青', hint: '雨过天青，靛蓝' },
];

export function isPalette(x: unknown): x is ThemePalette {
  return x === 'paper' || x === 'moss' || x === 'blue';
}

export const paletteName = (p: ThemePalette): string =>
  PALETTES.find((x) => x.id === p)?.name ?? '暖纸';

/** CSS 变量引用（推荐：样式一律走这里，主题切换零改动） */
export const v = {
  // 表面
  chrome: 'var(--mr-chrome)',
  canvas: 'var(--mr-canvas)',
  surface: 'var(--mr-surface)',
  surfaceCode: 'var(--mr-surface-code)',
  surfaceTint: 'var(--mr-surface-tint)',
  surfaceTrack: 'var(--mr-surface-track)',
  // 描边
  border: 'var(--mr-border)',
  borderSoft: 'var(--mr-border-soft)',
  borderStrong: 'var(--mr-border-strong)',
  // 文字
  text1: 'var(--mr-text-1)',
  text2: 'var(--mr-text-2)',
  text3: 'var(--mr-text-3)',
  text4: 'var(--mr-text-4)',
  text5: 'var(--mr-text-5)',
  text6: 'var(--mr-text-6)',
  // 强调
  accent: 'var(--mr-accent)',
  accentStrong: 'var(--mr-accent-strong)',
  accentSoft: 'var(--mr-accent-soft)',
  accentArmor: 'var(--mr-accent-armor)',
  bronze: 'var(--mr-bronze)',
  warnBg: 'var(--mr-warn-bg)',
  warn: 'var(--mr-warn)',
} as const;

/** 字体族 */
export const font = {
  sans: 'var(--mr-font-sans)',
  serif: 'var(--mr-font-serif)',
  mono: 'var(--mr-font-mono)',
  latin: 'var(--mr-font-latin)',
} as const;

/** 字号阶梯：{ size, lineHeight, weight, family, usage } */
export const type = {
  display: { size: 38, lineHeight: 46, weight: 700, family: 'serif', usage: '文档 H1' },
  h1:      { size: 30, lineHeight: 38, weight: 700, family: 'serif', usage: '空态字标' },
  h2:      { size: 23, lineHeight: 30, weight: 600, family: 'serif', usage: '文档 H2' },
  h3:      { size: 18, lineHeight: 26, weight: 500, family: 'sans',  usage: '文档 H3' },
  section: { size: 15, lineHeight: 22, weight: 500, family: 'sans',  usage: '分区标题' },
  lead:    { size: 15.5, lineHeight: 27, weight: 400, family: 'serif', usage: '引用块' },
  body:    { size: 15, lineHeight: 26, weight: 400, family: 'sans',  usage: '正文' },
  bodySm:  { size: 13.5, lineHeight: 24, weight: 400, family: 'sans', usage: '说明段落' },
  ui:      { size: 13, lineHeight: 20, weight: 500, family: 'sans',  usage: '设置项 / 按钮' },
  uiSm:    { size: 12.5, lineHeight: 18, weight: 500, family: 'sans', usage: '标签页 / 树项' },
  meta:    { size: 12, lineHeight: 18, weight: 400, family: 'sans',  usage: '次要说明' },
  metaSm:  { size: 11.5, lineHeight: 17, weight: 400, family: 'sans', usage: '字段描述 / 搜索片段' },
  metaXs:  { size: 11, lineHeight: 16, weight: 400, family: 'sans',  usage: '计数 / 提示' },
  code:    { size: 12.5, lineHeight: 20, weight: 400, family: 'mono', usage: '代码' },
} as const;

/** 圆角 */
export const radius = { xs: 3, sm: 4, md: 6, lg: 8, pill: 11 } as const;

/** 间距（4 基准） */
export const space = [0, 4, 8, 12, 16, 20, 24, 32, 40, 64] as const;

/** 布局常量 */
export const layout = {
  titlebarH: 40,
  tabH: 30,
  tabStripH: 34,
  toolbarH: 48,
  sidebarW: 240,      // 可调 200 – 480
  sidebarMinW: 200,
  sidebarMaxW: 480,
  rowH: 28,
  listRowH: 56,
  btnH: 38,
  ctrlH: 30,
  inputH: 32,
  readingW: 680,      // 可调 600 – 1400
  readingMinW: 600,
  readingMaxW: 1400,
  settingsW: 820,
  emptyPanelW: 560,
} as const;

/**
 * 正文字号（px）。
 *
 * 只有一个旋钮、按 1px 步进 —— 阅读器调字号是"再大一点/再小一点"的手感活，
 * 不是选档位。12–22 覆盖了从"想在 13 寸屏上一眼看更多"到"年纪大了"的两端，
 * 再大就会把 680px 的阅读列压成七拐八弯的窄条。
 */
export const readSize = { min: 12, max: 22, def: 15, step: 1 } as const;

/** 动效 */
export const motion = {
  hover: 120,
  panel: 200,
  theme: 0,           // 主题切换刻意不做过渡
  easeOut: 'cubic-bezier(0.2, 0, 0, 1)',
} as const;

/**
 * 真实色值（历史遗留，只覆盖暖纸 / 暖墨两套）
 *
 * 现在六套主题的色值只存在于 tokens.css，且预览色卡是直接给元素挂
 * `data-palette` / `data-theme` 让浏览器自己算出来的 —— 不再需要 JS 侧
 * 抄一遍十六进制。往这里补竹青 / 天青只会制造两处会漂移的真相，故不加。
 */
export const palette = {
  light: {
    chrome: '#F4F0E8', canvas: '#FBFAF7', surface: '#FFFFFF',
    surfaceCode: '#F5F2EA', surfaceTint: '#F1EDE4', surfaceTrack: '#E9E4D9',
    border: '#E5DFD0', borderSoft: '#EFECE6', borderStrong: '#D4CCB5',
    text1: '#1F1E1B', text2: '#3A3833', text3: '#5C5A55',
    text4: '#8A8578', text5: '#938D80', text6: '#A39D8F',
    accent: '#2F6B4F', accentStrong: '#245B41', accentSoft: '#E3E9DE',
    accentArmor: '#DCE4D8', bronze: '#B89968', warnBg: '#FBF0DC', warn: '#B89968',
  },
  dark: {
    chrome: '#141413', canvas: '#1C1B19', surface: '#2A2825',
    surfaceCode: '#232220', surfaceTint: '#232220', surfaceTrack: '#201F1C',
    border: '#302E29', borderSoft: '#262521', borderStrong: '#3A3833',
    text1: '#EDE9E1', text2: '#C9C4BB', text3: '#A9A49A',
    text4: '#8A8578', text5: '#7A756C', text6: '#6E6963',
    accent: '#7FB894', accentStrong: '#9CCBAB', accentSoft: '#26332A',
    accentArmor: '#2E3A32', bronze: '#C8A876', warnBg: '#2E2519', warn: '#C8A876',
  },
} as const;

/**
 * 代码高亮主题映射（Shiki）
 * 亮色用 github-light 系，暗色用 github-dark 系，保证与阅读主题同调
 */
export const shikiTheme = { light: 'github-light', dark: 'github-dark' } as const;

/* ------------------------------------------------------------------
   主题管理（无依赖实现，Svelte 5 runes 友好）
   ------------------------------------------------------------------ */

const STORAGE_KEY = 'moread.theme';
const PALETTE_KEY = 'moread.palette';

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * 把主题写进 DOM。
 *
 * 两个属性分别落 `data-theme`（浅/深）和 `data-palette`（色调）：
 * tokens.css 里就是按这两个属性组合选中色值块的，所以任何元素带上这两个属性
 * 都能局部预览某个主题 —— 设置面板里的色卡正是这么做的，不必手抄十六进制。
 */
export function applyTheme(mode: ThemeMode, palette: ThemePalette = 'paper'): ResolvedTheme {
  const resolved = resolveTheme(mode);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.palette = palette;
  return resolved;
}

export function setTheme(mode: ThemeMode, palette: ThemePalette = 'paper'): ResolvedTheme {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
    localStorage.setItem(PALETTE_KEY, palette);
  } catch { /* 隐私模式等场景静默忽略 */ }
  return applyTheme(mode, palette);
}

export function readStoredTheme(): ThemeMode {
  return (localStorage.getItem(STORAGE_KEY) as ThemeMode | null) ?? 'light';
}

export function readStoredPalette(): ThemePalette {
  try {
    const v = localStorage.getItem(PALETTE_KEY);
    return isPalette(v) ? v : 'paper';
  } catch {
    return 'paper';
  }
}

/** 跟随系统时的监听器；调用方负责在组件卸载时 removeEventListener */
export function watchSystemTheme(onChange: (t: ResolvedTheme) => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => { if (readStoredTheme() === 'system') onChange(resolveTheme('system')); };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}

/* ------------------------------------------------------------------
   正文字号
   ------------------------------------------------------------------ */

const READ_SIZE_KEY = 'moread.fs';

export function clampReadSize(px: number): number {
  if (!Number.isFinite(px)) return readSize.def;
  return Math.min(readSize.max, Math.max(readSize.min, Math.round(px)));
}

/**
 * 把字号写进 DOM：只改 `--mr-read-scale`，由 .mr-article 自己换算字号与行高。
 *
 * 顺带落一个 `data-fs` 属性：自动化测试要断言"字号真的变了"，
 * 读 attribute 比逐个 getComputedStyle 稳，也方便截图核对时一眼看出当前档位。
 */
export function applyReadSize(px: number): number {
  const n = clampReadSize(px);
  const root = document.documentElement;
  root.style.setProperty('--mr-read-scale', String(n / readSize.def));
  root.dataset.fs = String(n);
  return n;
}

export function readStoredReadSize(): number {
  try {
    const raw = localStorage.getItem(READ_SIZE_KEY);
    return raw === null ? readSize.def : clampReadSize(Number(raw));
  } catch {
    return readSize.def;
  }
}

export function setReadSize(px: number): number {
  const n = applyReadSize(px);
  try { localStorage.setItem(READ_SIZE_KEY, String(n)); } catch { /* 忽略 */ }
  return n;
}
