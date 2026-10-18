/**
 * 主题 / 字号的引导脚本
 *
 * 必须是一个**独立的外链脚本**，并且用经典 <script> 同步加载：
 * 1. 内联 <script> 会被严格 CSP（script-src 'self'）拦掉；
 * 2. 放进 main.ts 又太晚，会先渲染浅色再跳深色，闪一下。
 *
 * 两轴都要在这里落定：data-theme（浅/深）与 data-palette（色调）。
 * 少写一个，开机就会先按暖纸画一遍再跳到竹青/天青 —— 和只写 theme 时
 * 那个毛病一样，只是更隐蔽。
 *
 * 字号同理：--mr-read-scale 也在这里写。少了这一步，正文会先按 15px
 * 排一遍、再被拉大一档，看得见"跳一下"。
 *
 * 支持 ?theme=dark|light|system、?palette=paper|moss|blue、?fs=<12..22>
 * 强制指定，便于调试与截图核对。
 */
(function () {
  var PALETTES = ['paper', 'moss', 'blue'];
  var FS_MIN = 12;
  var FS_MAX = 22;
  var FS_DEF = 15;

  var mode = 'light';
  var palette = 'paper';
  var fs = FS_DEF;

  try {
    var q = new URLSearchParams(location.search);
    mode = q.get('theme') || localStorage.getItem('moread.theme') || 'light';
    palette = q.get('palette') || localStorage.getItem('moread.palette') || 'paper';
    fs = parseInt(q.get('fs') || localStorage.getItem('moread.fs') || String(FS_DEF), 10);
  } catch (e) {
    /* localStorage 不可用（隐私模式）时静默回退到浅色 + 暖纸 + 15px */
  }

  if (PALETTES.indexOf(palette) < 0) palette = 'paper';
  if (!(fs >= FS_MIN && fs <= FS_MAX)) fs = FS_DEF;

  var resolved =
    mode === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : mode;

  var root = document.documentElement;
  root.dataset.theme = resolved === 'dark' ? 'dark' : 'light';
  root.dataset.palette = palette;
  root.dataset.fs = String(fs);
  root.style.setProperty('--mr-read-scale', String(fs / FS_DEF));
})();
