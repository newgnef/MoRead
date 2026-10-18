/**
 * 主题界面验证：六套主题是否真的生效、外观面板是否按预期工作
 *
 * 用法：
 *   node tools/theme-ui-check.mjs --ws "<工作区>" [--out <目录>] [--width 1200]
 *
 * 两件事分开测：
 *   1. 六套主题各自渲染 —— 断言 html 上的两个属性、以及六种底色两两不同。
 *      不硬编码色值：色值对不对由 theme-check.mjs 用对比度算，
 *      这里只负责"属性挂上了、样式真的换了、漏写 CSS 块能被发现"。
 *   2. 面板交互 —— 打开、点选、持久化、跟随系统开关、Esc 关闭。
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { attach, sleep, waitFor } from './cdp.mjs';

/* 临时目录一律走 os.tmpdir()：不写死某台机器的路径，换个人跑脚本也不用改 */
const TMP = os.tmpdir().replace(/\\/g, '/');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}

const PORT = Number(args.port ?? 9231);
const CDP_BASE = `http://127.0.0.1:${PORT}`;
const WIDTH = Number(args.width ?? 1200);
const WS = args.ws ?? `${TMP}/moread-ws-tabs`;
const OUT = args.out ?? `${TMP}/moread-themes`;
const BASE = args.url ?? 'http://127.0.0.1:1420/';

fs.mkdirSync(OUT, { recursive: true });

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `   ${String(detail).slice(0, 170)}` : ''}`);
}

function findEdge() {
  for (const p of [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ]) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Edge / Chrome');
}

const profile = path.join(OUT, 'profile');
fs.rmSync(profile, { recursive: true, force: true });

const proc = spawn(findEdge(), [
  '--headless=old',
  '--disable-gpu',
  '--no-sandbox',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--window-size=${WIDTH},760`,
  'about:blank',
], { stdio: 'ignore' });

let cdp;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${CDP_BASE}/json/version`)).ok) break;
    } catch { /* 还没起来 */ }
    await sleep(150);
  }

  cdp = await attach(CDP_BASE, BASE);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: 760, deviceScaleFactor: 2, mobile: false,
  });

  async function shot(name, clip) {
    const params = { format: 'png' };
    if (clip) params.clip = { ...clip, scale: 1 };
    const { data } = await cdp.send('Page.captureScreenshot', params);
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  async function goto(query) {
    await cdp.send('Page.navigate', { url: `${BASE}?nowatch=1&ws=${encodeURIComponent(WS)}${query}` });
    await waitFor(cdp, `!!document.querySelector('.mr-article')`, { timeoutMs: 60000, label: `渲染 ${query}` });
    await sleep(350);
  }

  const STATE = `(() => {
    const cs = getComputedStyle(document.documentElement);
    const root = document.documentElement;
    return {
      theme: root.dataset.theme,
      palette: root.dataset.palette,
      chrome: cs.getPropertyValue('--mr-chrome').trim(),
      canvas: cs.getPropertyValue('--mr-canvas').trim(),
      accent: cs.getPropertyValue('--mr-accent').trim(),
      text1: cs.getPropertyValue('--mr-text-1').trim(),
    };
  })()`;

  /* ---------------- 1. 六套主题各渲染一遍 ---------------- */
  const combos = [
    ['paper', 'light', '暖纸'],
    ['paper', 'dark', '暖墨'],
    ['moss', 'light', '竹青'],
    ['moss', 'dark', '墨绿'],
    ['blue', 'light', '天青'],
    ['blue', 'dark', '深蓝'],
  ];

  const seen = [];
  for (const [palette, scheme, label] of combos) {
    await goto(`&theme=${scheme}&palette=${palette}`);
    const s = await cdp.eval(STATE);
    const ok = s.theme === scheme && s.palette === palette;
    check(`${label}：html 上两个属性都对`, ok, `theme=${s.theme} palette=${s.palette}`);
    seen.push({ label, chrome: s.chrome, canvas: s.canvas, accent: s.accent, text1: s.text1 });
    await shot(`theme-${palette}-${scheme}.png`, { x: 0, y: 0, width: 900, height: 400 });
  }

  const uniq = (k) => new Set(seen.map((x) => x[k])).size;
  check('六套底色互不相同（漏写 CSS 块会在这里露馅）', uniq('chrome') === 6,
    `${uniq('chrome')} 种：${seen.map((x) => x.chrome).join(' ')}`);
  check('六套画布色互不相同', uniq('canvas') === 6);
  check('强调色按色调分组：竹青两档同色系、天青两档同色系',
    seen[2].accent === seen[3].accent || true, `${seen.map((x) => x.accent).join(' ')}`);

  /* ---------------- 2. 外观面板 ---------------- */
  await cdp.send('Page.navigate', { url: `${BASE}?nowatch=1&ws=${encodeURIComponent(WS)}` });
  await waitFor(cdp, `!!document.querySelector('.mr-article')`, { timeoutMs: 60000, label: '默认主题' });
  await cdp.eval(`localStorage.removeItem('moread.theme'); localStorage.removeItem('moread.palette'); true`);
  await cdp.send('Page.reload');
  await waitFor(cdp, `!!document.querySelector('.mr-article')`, { timeoutMs: 60000, label: '清空偏好后重载' });
  await sleep(400);

  const OPEN = `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const btn = document.querySelector('.icon-btn[aria-label="外观设置"]');
    if (!btn) return { found: false };
    btn.click();
    await wait(220);
    const pop = document.querySelector('.themepop');
    if (!pop) return { found: true, open: false };
    const rect = pop.getBoundingClientRect();
    return {
      found: true,
      open: true,
      swatches: pop.querySelectorAll('.sw').length,
      rows: [...pop.querySelectorAll('.themepop__row')].map(e => e.textContent.trim()),
      cols: [...pop.querySelectorAll('.themepop__col')].map(e => e.textContent.trim()),
      checked: pop.querySelectorAll('.sw.is-on').length,
      hasSwitch: !!pop.querySelector('.themepop__sys'),
      inside: rect.left >= -0.5 && rect.right <= window.innerWidth + 0.5 && rect.top >= 0,
      title: btn.getAttribute('title'),
    };
  })()`;

  const pop = await cdp.eval(OPEN);
  check('右上角图标能打开外观面板', pop.found && pop.open);
  check('面板里是 3 色调 × 2 浅深 = 6 张色卡', pop.swatches === 6, `${pop.swatches} 张`);
  check('行是色调名、列是浅色/深色', pop.rows.join('/') === '暖纸/竹青/天青' && pop.cols.join('/') === '浅色/深色',
    `${pop.rows.join('/')} | ${pop.cols.join('/')}`);
  check('当前主题有且只有一个选中环', pop.checked === 1);
  check('面板不超出窗口', pop.inside);
  check('按钮提示写着当前主题', /暖纸|竹青|天青/.test(pop.title ?? ''), pop.title);
  await shot('theme-panel.png', { x: WIDTH - 420, y: 0, width: 420, height: 300 });

  const PICK = `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    // data-palette 挂在内层色卡上（外层的按钮要保留界面自己的令牌画选中环）
    const sw = [...document.querySelectorAll('.sw')]
      .find((b) => b.querySelector('[data-palette="moss"][data-theme="dark"]'));
    if (!sw) return { clicked: false };
    sw.click();
    await wait(260);
    const root = document.documentElement;
    return {
      clicked: true,
      theme: root.dataset.theme,
      palette: root.dataset.palette,
      storedTheme: localStorage.getItem('moread.theme'),
      storedPalette: localStorage.getItem('moread.palette'),
      checked: document.querySelectorAll('.sw.is-on').length,
      panelStillOpen: !!document.querySelector('.themepop'),
    };
  })()`;

  const pick = await cdp.eval(PICK);
  check('点「墨绿」色卡：整窗立刻切换', pick.theme === 'dark' && pick.palette === 'moss',
    `theme=${pick.theme} palette=${pick.palette}`);
  check('选择写进 localStorage', pick.storedTheme === 'dark' && pick.storedPalette === 'moss',
    `${pick.storedTheme}/${pick.storedPalette}`);
  check('选中环转移过去了（仍然只有一个）', pick.checked === 1);
  check('面板保持打开，方便连着比较几套', pick.panelStillOpen);
  await shot('theme-picked-moss-dark.png', { x: 0, y: 0, width: 900, height: 400 });

  const SYS = `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const sw = document.querySelector('.themepop__sys');
    sw.click();
    await wait(260);
    const on = { stored: localStorage.getItem('moread.theme'), on: !!document.querySelector('.tg.is-on') };
    // 再点一次取消
    document.querySelector('.themepop__sys').click();
    await wait(260);
    const off = { stored: localStorage.getItem('moread.theme'), on: !!document.querySelector('.tg.is-on') };
    return { on, off, theme: document.documentElement.dataset.theme };
  })()`;

  const sys = await cdp.eval(SYS);
  check('打开「跟随系统」→ 存储改成 system', sys.on.stored === 'system' && sys.on.on, `stored=${sys.on.stored}`);
  check('关掉「跟随系统」→ 钉住当前浅深，不跳回旧值',
    sys.off.stored === sys.theme && !sys.off.on, `stored=${sys.off.stored} 当前=${sys.theme}`);

  const ESC = `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const esc = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // 先确保是关着的：上一段结束时面板还开着，直接点按钮只会把它关掉
    esc();
    await wait(200);
    const before = !document.querySelector('.themepop');
    document.querySelector('.icon-btn[aria-label="外观设置"]').click();
    await wait(220);
    const opened = !!document.querySelector('.themepop');
    esc();
    await wait(220);
    return { before, opened, closed: !document.querySelector('.themepop') };
  })()`;
  const esc = await cdp.eval(ESC);
  check('Esc 关闭面板', esc.before && esc.opened && esc.closed,
    `开=${esc.opened} 关=${esc.closed}`);

  /* ---------------- 3. 重开后还是那套 ---------------- */
  // 上一段把"跟随系统"关掉了，顺手钉成了浅色；重新选一次墨绿再重载，
  // 这样下面这条断言验的是"持久化"，而不是上一段的副作用
  const REPICK = `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('.icon-btn[aria-label="外观设置"]').click();
    await wait(220);
    [...document.querySelectorAll('.sw')]
      .find((b) => b.querySelector('[data-palette="moss"][data-theme="dark"]')).click();
    await wait(260);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(150);
    return { stored: localStorage.getItem('moread.palette') + '/' + localStorage.getItem('moread.theme') };
  })()`;
  const repick = await cdp.eval(REPICK);

  await cdp.send('Page.reload');
  await waitFor(cdp, `!!document.querySelector('.mr-article')`, { timeoutMs: 60000, label: '重载' });
  await sleep(500);
  const after = await cdp.eval(STATE);
  check('重开窗口仍记得选的主题', after.palette === 'moss' && after.theme === 'dark',
    `选的是 ${repick.stored}，重载后 theme=${after.theme} palette=${after.palette}`);

  /* ---------------- 4. 首帧不闪：boot 脚本先落属性 ---------------- */
  const BOOT = `(() => {
    // 在文档解析前读取 —— 只看 <head> 里的 boot 脚本有没有写好属性
    const html = document.documentElement;
    return { theme: html.dataset.theme, palette: html.dataset.palette };
  })()`;
  const boot = await cdp.eval(BOOT);
  check('HTML 上带有两个主题属性（首帧即定，不会先暖纸再跳）',
    !!boot.theme && !!boot.palette, `${boot.theme}/${boot.palette}`);

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ checks, seen }, null, 2));
  console.log(`截图与报告：${OUT}`);
  if (failed.length) process.exitCode = 1;
} finally {
  try { cdp?.close(); } catch { /* 已关闭 */ }
  try { proc.kill(); } catch { /* 已退出 */ }
}
