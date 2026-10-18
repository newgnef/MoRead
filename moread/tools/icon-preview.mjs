/**
 * 图标候选对照表：把若干 SVG 渲成多尺寸，拼一张「亮/暗底 + 小尺寸放大」的对照图。
 *
 * 为什么要放大 16px 看：图标真正的考场是 16px。按原尺寸看只会得到
 * “还行”的错觉，放大到 8 倍才看得出笔画是不是糊成一团、留白够不够。
 *
 * 用法：
 *   node tools/icon-preview.mjs --out <目录> icons/a.svg icons/b.svg icons/c.svg
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { renderSVG, cornerAlpha, closeBrowser, shotPage } from './icon-lib.mjs';

/* 临时目录一律走 os.tmpdir()：不写死某台机器的路径，换个人跑脚本也不用改 */
const TMP = os.tmpdir().replace(/\\/g, '/');

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const OUT = outIdx >= 0 ? argv[outIdx + 1] : `${TMP}/moread-icons`;
const svgs = argv.filter((a) => a.endsWith('.svg'));

if (svgs.length === 0) {
  console.error('用法：node tools/icon-preview.mjs --out <目录> <a.svg> [b.svg ...]');
  process.exit(2);
}

fs.mkdirSync(OUT, { recursive: true });

const SIZES = [16, 32, 48, 64, 128, 256];
const rendered = new Map(); // svgPath -> Map(size -> { b64, alpha })

for (const svg of svgs) {
  const per = new Map();
  for (const size of SIZES) {
    const png = await renderSVG(svg, size);
    const alpha = cornerAlpha(png);
    per.set(size, { b64: png.toString('base64'), alpha });

    const name = `${path.basename(svg, '.svg')}-${size}.png`;
    fs.writeFileSync(path.join(OUT, name), png);
  }
  rendered.set(svg, per);
}

/* ---------------------------- 对照表 ---------------------------- */

const cell = (svg, size, bg, zoom) => {
  const { b64 } = rendered.get(svg).get(size);
  const scale = zoom ?? 1;
  const style = [
    `width:${size * scale}px`,
    `height:${size * scale}px`,
    scale > 1 ? 'image-rendering:pixelated' : 'image-rendering:auto',
  ].join(';');
  return `<img src="data:image/png;base64,${b64}" style="${style}" alt="">`;
};

const row = (svg, bgClass) => {
  const name = path.basename(svg, '.svg');
  return `<tr>
    <td class="nm">${name}</td>
    <td class="c ${bgClass}">${cell(svg, 16, 'l', 8)}</td>
    <td class="c ${bgClass}">${cell(svg, 32, 'l', 4)}</td>
    <td class="c ${bgClass}">${cell(svg, 48, 'l', 2)}</td>
    <td class="c ${bgClass}">${cell(svg, 128, 'l')}</td>
    <td class="c dk">${cell(svg, 16, 'd', 8)}</td>
    <td class="c dk">${cell(svg, 32, 'd', 4)}</td>
    <td class="c dk">${cell(svg, 128, 'd')}</td>
  </tr>`;
};

const html = `<!doctype html><meta charset="utf-8">
<style>
  body { margin:0; padding:22px 24px; background:#fff; color:#1f1e1b;
         font:400 13px "Segoe UI","Microsoft YaHei",sans-serif; }
  h1 { margin:0 0 4px; font:600 16px "Segoe UI","Microsoft YaHei",sans-serif; }
  p.sub { margin:0 0 16px; color:#6b665c; font-size:12px; }
  table { border-collapse:separate; border-spacing:0 10px; }
  th { font:500 11px "Segoe UI",sans-serif; color:#8a8578; padding:0 14px 0 0; text-align:left; }
  td.nm { font:500 12px "Consolas",monospace; color:#3a3833; padding-right:18px; white-space:nowrap; }
  td.c { padding:0 12px 0 0; vertical-align:middle; }
  td.c.l { background:#f3f3f3; }
  td.c.dk { background:#202020; }
  td.c { border-radius:0; }
  tr td.c.l { box-shadow: inset 0 0 0 1px #e6e6e6; }
</style>
<h1>MoRead 图标候选</h1>
<p class="sub">左三列：亮底下的 16 / 32 / 48 / 128（小尺寸按 8× / 4× / 2× 放大，像素化）　右三列：暗底对照</p>
<table>
  <tr>
    <th></th>
    <th>16px ×8</th><th>32px ×4</th><th>48px ×2</th><th>128px</th>
    <th>16px ×8（暗）</th><th>32px ×4（暗）</th><th>128px（暗）</th>
  </tr>
  ${svgs.map((s) => row(s, '')).join('\n')}
</table>
`;

const sheet = path.join(OUT, 'contact-sheet.html');
fs.writeFileSync(sheet, html, 'utf8');

const sheetPng = path.join(OUT, 'contact-sheet.png');
fs.writeFileSync(sheetPng, await shotPage(`file:///${sheet.replace(/\\/g, '/')}`, 1180));

/* 对照表的 alpha 自检：四个角必须全透明，否则说明背景没被抠掉 */
for (const [svg, per] of rendered) {
  const a = per.get(256).alpha;
  const ok = a.every((v) => v === 0);
  console.log(`${path.basename(svg).padEnd(16)} 角 alpha = [${a.join(', ')}]  ${ok ? '透明 OK' : '⚠ 不是透明'}`);
}

closeBrowser();

console.log(`\n对照表：${sheetPng}`);
console.log(`单尺寸 PNG：${OUT}`);
