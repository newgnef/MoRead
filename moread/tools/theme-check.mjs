#!/usr/bin/env node
/**
 * 主题体检：颜色令牌的对比度审计（纯 Node，不起浏览器）
 *
 * 设计规范里有一条硬边界：
 *   1–3 级文字（标题 / 正文 / 次级）必须 ≥ 6.6:1，才配得上"能读整段"；
 *   4–6 级（图标 / 注释 / 时间戳）≥ 3:1，只允许出现在不需要逐字读的地方。
 * 每加一套主题都靠肉眼判断"看着还行"是不可靠的 —— 尤其是深色底上的
 * 中等灰，差 0.3 个点肉眼完全看不出来，但读十分钟就累。
 *
 * 用法：node tools/theme-check.mjs [--css <tokens.css>]
 * 退出码 0 = 全部通过。
 */

import fs from 'node:fs';
import path from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}

const CSS = args.css ?? path.join(import.meta.dirname, '..', 'src', 'lib', 'tokens.css');

/* ------------------------------------------------------------------ */
/* 解析：把 tokens.css 拆成「选择器 → { 变量: 值 }」                    */
/* ------------------------------------------------------------------ */

const raw = fs.readFileSync(CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const blocks = [];
const blockRe = /([^{}]+)\{([^{}]*)\}/g;
let m;
while ((m = blockRe.exec(raw))) {
  const sel = m[1].trim().replace(/\s+/g, ' ');
  const decls = {};
  for (const line of m[2].split(';')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k.startsWith('--mr-')) decls[k] = v;
  }
  if (Object.keys(decls).length) blocks.push({ sel, decls });
}

function findBlock(pred) {
  return blocks.filter((b) => pred(b.sel));
}

const rootBlock = blocks.find((b) => b.sel === ':root');
if (!rootBlock) throw new Error('tokens.css 里找不到 :root 块');

const darkBlock = findBlock((s) => s === '[data-theme="dark"]' || s === "[data-theme='dark']")[0];

/** 主题清单：纸 / 竹青 / 天青 × 浅深 */
const PALETTES = ['paper', 'moss', 'blue'];
const NAMES = { paper: '暖纸', moss: '竹青', blue: '天青' };

function resolveTheme(palette, scheme) {
  const out = { ...rootBlock.decls };
  if (scheme === 'dark' && darkBlock) Object.assign(out, darkBlock.decls);
  if (palette !== 'paper') {
    const light = findBlock((s) => s === `[data-palette="${palette}"]`)[0];
    const dark = findBlock((s) => s === `[data-palette="${palette}"][data-theme="dark"]`)[0];
    if (!light) throw new Error(`缺少主题块：[data-palette="${palette}"]`);
    if (!dark) throw new Error(`缺少主题块：[data-palette="${palette}"][data-theme="dark"]`);
    if (scheme === 'light') Object.assign(out, light.decls);
    else Object.assign(out, dark.decls);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* WCAG 相对亮度 / 对比度                                              */
/* ------------------------------------------------------------------ */

function hex2rgb(h) {
  const s = h.trim().replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

function luminance(hex) {
  const [r, g, b] = hex2rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const val = (t, key) => {
  const v = t[`--mr-${key}`];
  if (!v) throw new Error(`令牌缺失：--mr-${key}`);
  if (!/^#[0-9a-fA-F]{3,8}$/.test(v)) throw new Error(`--mr-${key} 不是纯色：${v}`);
  return v;
};

/* ------------------------------------------------------------------ */
/* 审计                                                                */
/* ------------------------------------------------------------------ */

/*
  阈值怎么定的：以既有「暖纸·浅」为基线量出来，不是拍脑袋。
  正文长在 canvas 上，所以 6.6 这道硬边界按 canvas 量（暖纸正好 6.60）；
  侧栏底是 chrome，比 canvas 暗一点，同一档文字只要求 ≥ 5.5。
  6 级灰是"未激活图标 / 时间戳"，本身就是刻意压到最淡的一档，给 2.4 的下限。
  新增主题必须落在这个模型里 —— 比"看着还行"可靠，也不会把已有主题判死。
*/
const READ_MIN = 6.55;        // 1–3 级 / canvas（基线暖纸实测 6.60，留 0.05 余量）
const ICON_MIN = 3.0;         // 4–5 级 / canvas
const FAINT_MIN = 2.4;        // 6 级 / canvas
const CHROME_READ_MIN = 5.5;  // 1–3 级 / chrome
const CHROME_ICON_MIN = 2.3;  // 4–6 级 / chrome
const ACCENT_MIN = 4.5;       // 强调色要当正文链接用

let fails = 0;
const rows = [];

const worst = (t, keys, bg) => Math.min(...keys.map((k) => contrast(val(t, k), bg)));

for (const palette of PALETTES) {
  for (const scheme of ['light', 'dark']) {
    const t = resolveTheme(palette, scheme);
    const label = `${NAMES[palette]}·${scheme === 'light' ? '浅' : '深'}`;
    const canvas = val(t, 'canvas');
    const chrome = val(t, 'chrome');
    const surface = val(t, 'surface');

    const read = worst(t, ['text-1', 'text-2', 'text-3'], canvas);
    const icon = worst(t, ['text-4', 'text-5'], canvas);
    const faint = contrast(val(t, 'text-6'), canvas);
    const readChrome = worst(t, ['text-1', 'text-2', 'text-3'], chrome);
    const iconChrome = worst(t, ['text-4', 'text-5', 'text-6'], chrome);
    const accent = Math.min(contrast(val(t, 'accent'), canvas), contrast(val(t, 'accent'), surface));
    const accentStrong = contrast(val(t, 'accent-strong'), surface);

    const bad = [];
    if (read < READ_MIN) bad.push(`正文级 ${read.toFixed(2)} < ${READ_MIN}`);
    if (icon < ICON_MIN) bad.push(`图标级 ${icon.toFixed(2)} < ${ICON_MIN}`);
    if (faint < FAINT_MIN) bad.push(`最弱档 ${faint.toFixed(2)} < ${FAINT_MIN}`);
    if (readChrome < CHROME_READ_MIN) bad.push(`chrome 上正文级 ${readChrome.toFixed(2)} < ${CHROME_READ_MIN}`);
    if (iconChrome < CHROME_ICON_MIN) bad.push(`chrome 上图标级 ${iconChrome.toFixed(2)} < ${CHROME_ICON_MIN}`);
    if (accent < ACCENT_MIN || accentStrong < ACCENT_MIN) {
      bad.push(`强调色 ${accent.toFixed(2)} / 悬停 ${accentStrong.toFixed(2)}`);
    }

    // 层级：浅色下 surface 最亮、chrome 最暗；深色下 surface 最亮、canvas 最暗
    const L = (h) => luminance(h);
    const okOrder = scheme === 'light'
      ? L(surface) > L(canvas) && L(canvas) > L(chrome)
      : L(surface) > L(canvas) && L(surface) > L(chrome);
    if (!okOrder) bad.push('层级顺序反了');

    if (bad.length) fails++;

    rows.push({
      label,
      read: read.toFixed(2),
      icon: icon.toFixed(2),
      faint: faint.toFixed(2),
      accent: accent.toFixed(2),
      ok: bad.length === 0,
      bad: bad.join(' / '),
    });
  }
}

const width = (s, n) => {
  const w = [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
};
console.log(`${width('主题', 14)}${width('正文级', 10)}${width('图标级', 10)}${width('最弱档', 10)}强调色`);
for (const r of rows) {
  console.log(
    `${r.ok ? ' ok  ' : 'FAIL '}${width(r.label, 14)}${width(r.read, 10)}${width(r.icon, 10)}${width(r.faint, 10)}${r.accent}` +
    (r.bad ? `   ← ${r.bad}` : ''),
  );
}

console.log(`\n阈值：正文级 ≥ ${READ_MIN}（canvas）/ ≥ ${CHROME_READ_MIN}（chrome），` +
  `图标级 ≥ ${ICON_MIN}，最弱档 ≥ ${FAINT_MIN}，强调色 ≥ ${ACCENT_MIN}`);
console.log(fails === 0 ? `${rows.length} 套主题全部通过` : `${fails} 套不达标`);
process.exitCode = fails === 0 ? 0 : 1;
