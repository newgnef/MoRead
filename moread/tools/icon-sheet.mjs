/**
 * 生成图标验收图（归档 / 评审用）。
 *
 * 三块内容：
 *   ① 大图：浅色 / 深色环境各一枚 256
 *   ② 尺寸阶梯：128/64/48/32/24/16 按原尺寸排，不做放大 —— 那才是用户真正看到的大小
 *   ③ 任务栏模拟：深色条里放几枚中性占位图标，看它在真实环境里是否立得住
 *
 * 用法：node tools/icon-sheet.mjs [--svg icons/icon.svg] [--out <png>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSVG, shotPage, closeBrowser } from './icon-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, dflt) => (argv.indexOf(name) >= 0 ? argv[argv.indexOf(name) + 1] : dflt);

const SRC = path.resolve(HERE, '..', arg('--svg', 'icons/icon.svg'));
const OUT = arg('--out', path.resolve(HERE, '../../outputs/app/图标-预览.png'));
const TMP = path.join(path.resolve(HERE, '..'), 'node_modules/.cache/icon-sheet');

const sizes = [128, 64, 48, 32, 24, 16];
const ladder = new Map();
for (const s of sizes) {
  ladder.set(s, (await renderSVG(SRC, s)).toString('base64'));
}
const big = (await renderSVG(SRC, 256)).toString('base64');

const row = (bg, label) => `
  <div class="ladder ${bg}">
    <span class="tag">${label}</span>
    ${sizes.map((s) => `
      <span class="cell">
        <img src="data:image/png;base64,${ladder.get(s)}" style="width:${s}px;height:${s}px">
        <i>${s}</i>
      </span>`).join('')}
  </div>`;

const other = (g) => `<span class="other">${g}</span>`;

const html = `<!doctype html><meta charset="utf-8">
<style>
  *{box-sizing:border-box}
  body{margin:0;padding:26px 30px 30px;background:#fff;color:#1f1e1b;
       font:400 13px "Segoe UI","Microsoft YaHei",sans-serif}
  h1{margin:0;font:600 19px "Source Han Serif SC","Songti SC",serif}
  .sub{margin:5px 0 22px;color:#6b665c;font-size:12px}
  .hero{display:flex;gap:20px;margin-bottom:24px}
  .tile{width:230px;height:230px;display:grid;place-items:center;border-radius:12px}
  .tile.l{background:#f4f0e8;box-shadow:inset 0 0 0 1px #e5dfd0}
  .tile.d{background:#202020}
  .tile img{width:160px;height:160px}
  .cap{margin-top:7px;font:400 11px "Consolas",monospace;color:#8a8578}
  .ladder{display:flex;align-items:flex-end;gap:18px;padding:14px 18px;border-radius:8px;margin-bottom:10px}
  .ladder.lbg{background:#f4f0e8;box-shadow:inset 0 0 0 1px #e5dfd0}
  .ladder.dbg{background:#202020}
  .tag{width:42px;font:400 11px "Consolas",monospace;color:#8a8578}
  .cell{display:flex;flex-direction:column;align-items:center;gap:6px}
  .cell i{font:400 10px "Consolas",monospace;font-style:normal;color:#8a8578}
  .tb{display:flex;align-items:center;gap:9px;height:46px;padding:0 13px;border-radius:8px;
      background:#202020;margin:16px 0 22px;width:max-content}
  .other{display:grid;place-items:center;width:24px;height:24px;border-radius:6px;
         background:#3a3a3a;color:#9a9a9a;font:600 11px "Segoe UI",sans-serif}
  .notes{display:grid;grid-template-columns:1fr 1fr;gap:11px 34px;font-size:12px;color:#3a3833}
  .notes b{display:block;font:600 10.5px "Segoe UI",sans-serif;color:#8a8578;
           letter-spacing:.08em;margin-bottom:2px}
  .sw{display:inline-flex;align-items:center;gap:5px;font:400 11px "Consolas",monospace;color:#5c5a55}
  .sw i{width:10px;height:10px;border-radius:3px;display:inline-block}
</style>

<h1>MoRead 应用图标</h1>
<p class="sub">一本翻开的书 · 松墨绿为墨 · 暖纸为书页　—　16 / 24 / 32 / 48 / 64 / 128 / 256 共七档</p>

<div class="hero">
  <div>
    <div class="tile l"><img src="data:image/png;base64,${big}"></div>
    <div class="cap">256 · 浅色环境</div>
  </div>
  <div>
    <div class="tile d"><img src="data:image/png;base64,${big}"></div>
    <div class="cap">256 · 深色环境</div>
  </div>
</div>

${row('lbg', '浅底')}
${row('dbg', '深底')}

<div class="tb">
  ${other('W')}${other('⌘')}
  <img src="data:image/png;base64,${ladder.get(24)}">
  ${other('✉')}${other('♫')}
</div>

<div class="notes">
  <div><b>墨 · 底色</b>
    <span class="sw"><i style="background:#3E7E5E"></i>#3E7E5E</span> →
    <span class="sw"><i style="background:#245039"></i>#245039</span>　松墨绿，与 App 内强调色同源
  </div>
  <div><b>纸 · 书页</b>　<span class="sw"><i style="background:#FDFAF3"></i>#FDFAF3</span> →
    <span class="sw"><i style="background:#EBE3D1"></i>#EBE3D1</span>　不用纯白，留暖调
  </div>
  <div><b>书脊 · 折缝</b>　<span class="sw"><i style="background:#1B3A2C"></i>#1B3A2C</span>　宽 3.6，16px 下约 1px，再窄就消失</div>
  <div><b>外角必须上翘</b>　一放平，16px 就退化成白方块 ——「张开」只存在于那两个尖上</div>
  <div><b>两页底部相连</b>　外轮廓是 U 而不是两条独立白条，否则会被读成暂停键</div>
  <div><b>底色不用近黑</b>　近黑贴深色任务栏会整块隐身，只剩一页纸浮着</div>
</div>
`;

fs.mkdirSync(TMP, { recursive: true });
const file = path.join(TMP, 'icon-sheet.html');
fs.writeFileSync(file, html, 'utf8');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, await shotPage(`file:///${file.replace(/\\/g, '/')}`, 640));

closeBrowser();
console.log(OUT);
