/**
 * 生成 MoRead 的应用图标。
 *
 * 设计源是 `icons/icon.svg`（矢量，手绘）。这个脚本负责把它栅格化成
 * 各档 PNG，再封成 Windows 需要的 .ico。
 *
 * 为什么不再是「用点内测试自己画」：图形一旦有了曲线（笔锋的收尖、
 * 圆弧的笔身），用位运算画就写不动了。改成 SVG 只画一次，
 * 尺寸由栅格化负责，源文件还能被设计工具打开。
 *
 * 产出（src-tauri/icons/）：
 *   icon.ico            16/24/32/48/64/128/256，PNG 载荷（Vista+）
 *   icon.png            512          NSIS / 商店图标
 *   128x128.png         128
 *   128x128@2x.png      256
 *   32x32.png           32
 *
 * 用法：
 *   node tools/make-icons.mjs                 # 用 icons/icon.svg
 *   node tools/make-icons.mjs --svg a.svg     # 换源（对比候选时用）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSVG, encodeICO, cornerAlpha, closeBrowser } from './icon-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../src-tauri/icons');

const argv = process.argv.slice(2);
const svgArg = argv.indexOf('--svg') >= 0 ? argv[argv.indexOf('--svg') + 1] : null;
const SRC = path.resolve(HERE, '..', svgArg ?? 'icons/icon.svg');

if (!fs.existsSync(SRC)) {
  console.error(`找不到图标源：${SRC}`);
  process.exit(2);
}

/* ------------------------------- 渲染 ------------------------------- */

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const cache = new Map();

for (const size of ICO_SIZES.concat([512])) {
  const png = await renderSVG(SRC, size);
  const alpha = cornerAlpha(png);
  if (alpha.some((a) => a !== 0)) {
    throw new Error(`${size}px 的四角不是全透明（${alpha.join(',')}）—— 背景没被抠掉`);
  }
  cache.set(size, png);
}

/* ------------------------------- 写盘 ------------------------------- */

fs.mkdirSync(OUT, { recursive: true });

const icoPath = path.join(OUT, 'icon.ico');
fs.writeFileSync(
  icoPath,
  encodeICO(ICO_SIZES.map((size) => ({ size, data: cache.get(size) }))),
);

const pngs = [
  ['icon.png', 512],
  ['128x128@2x.png', 256],
  ['128x128.png', 128],
  ['32x32.png', 32],
];

for (const [name, size] of pngs) {
  fs.writeFileSync(path.join(OUT, name), cache.get(size));
}

/* ------------------------------ 自检 ------------------------------ */

const ico = fs.readFileSync(icoPath);
const count = ico.readUInt16LE(4);
if (count !== ICO_SIZES.length) throw new Error(`ICO 目录项数不对：${count}`);

console.log(`源文件     ${path.relative(process.cwd(), SRC)}`);
console.log(`icon.ico   ${ico.length} bytes   ${count} 档  ${ICO_SIZES.join('/')}`);
for (const [name, size] of pngs) {
  console.log(`${name.padEnd(11)} ${String(size).padStart(3)}px  ${fs.statSync(path.join(OUT, name)).size} bytes`);
}
console.log(`输出目录   ${OUT}`);

closeBrowser();
