/**
 * 正文字号验证：Ctrl+滚轮 / 快捷键 / 外观面板 / 持久化 / 长文档不跑位
 *
 * 用法：
 *   node tools/font-check.mjs --ws "C:/.../moread-ws-tabs" [--width 1000]
 *
 * 为什么用 CDP 的真滚轮事件而不是 dispatchEvent(new WheelEvent)：
 * 我们靠 preventDefault() 拦掉 WebView 自带的整页缩放，而 window 上的
 * wheel 被 Chrome 默认按 passive 处理 —— 合成事件压根测不出这一点，
 * 只有真事件才能证明"页面没被浏览器一起放大"。
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

const PORT = Number(args.port ?? 9235);
const CDP_BASE = `http://127.0.0.1:${PORT}`;
const WIDTH = Number(args.width ?? 1000);
const HEIGHT = Number(args.height ?? 760);
const WS = args.ws ?? `${TMP}/moread-ws-tabs`;
const OUT = args.out ?? `${TMP}/moread-font`;
const APP = `http://127.0.0.1:1420/?theme=light&nowatch=1&ws=${encodeURIComponent(WS)}`;

const MIN = 12;
const MAX = 22;
const DEF = 15;

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
  `--window-size=${WIDTH},${HEIGHT}`,
  'about:blank',
], { stdio: 'ignore' });

/* ---------------- 页面内读数 ---------------- */
const STATE = `(() => {
  const root = document.documentElement;
  const px = (el, prop) => el ? parseFloat(getComputedStyle(el)[prop]) : 0;
  const art = document.querySelector('.mr-article');
  const p = art ? art.querySelector(':scope > p') : null;
  const h2 = art ? art.querySelector('h2') : null;
  const pre = art ? art.querySelector('.mr-codeblock__body') : null;
  const quote = art ? art.querySelector('blockquote') : null;
  const tab = document.querySelector('.tab');
  const sbtab = document.querySelector('.sidebar__tab');
  const wm = document.querySelector('.wordmark');
  const read = window.__moreadArticle?.read?.();
  return {
    fs: Number(root.dataset.fs || 0),
    scale: root.style.getPropertyValue('--mr-read-scale').trim(),
    pFont: px(p, 'fontSize'),
    pLine: px(p, 'lineHeight'),
    h2Font: px(h2, 'fontSize'),
    preFont: px(pre, 'fontSize'),
    quoteFont: px(quote, 'fontSize'),
    artFont: px(art, 'fontSize'),
    // UI 侧：这三样必须纹丝不动
    uiTab: px(tab, 'fontSize'),
    uiSbTab: px(sbtab, 'fontSize'),
    uiWordmark: px(wm, 'fontSize'),
    tabH: tab ? Math.round(tab.getBoundingClientRect().height) : 0,
    articleW: art ? Math.round(art.getBoundingClientRect().width) : 0,
    blocks: read?.blocks ?? -1,
  };
})()`;

let cdp;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${CDP_BASE}/json/version`)).ok) break;
    } catch { /* 还没起来 */ }
    await sleep(150);
  }

  cdp = await attach(CDP_BASE, 'about:blank');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false,
  });
  // 字号存在 localStorage：清掉才能确定"默认 15"这条路真的走通了
  await cdp.send('Storage.clearDataForOrigin', {
    origin: 'http://127.0.0.1:1420', storageTypes: 'local_storage',
  });
  await cdp.send('Page.navigate', { url: APP });
  await waitFor(cdp, `!!document.querySelector('.sidebar')`, { timeoutMs: 60000, label: '侧栏' });
  await sleep(400);

  async function shot(name, clip) {
    const params = { format: 'png' };
    if (clip) params.clip = { ...clip, scale: 1 };
    const { data } = await cdp.send('Page.captureScreenshot', params);
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  /* 打开第一篇短文档，之后所有读数都基于它 */
  const opened = await cdp.eval(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const row = document.querySelector('.trow--file');
    if (!row) return 'no-row';
    row.click();
    for (let i = 0; i < 60; i++) {
      await wait(150);
      if (document.querySelector('.mr-article > p')) return 'ok';
    }
    return 'timeout';
  })()`);
  check('打开文档用于读数', opened === 'ok', opened);
  await sleep(300);

  /* ---------------- 1. 默认态 ---------------- */
  const base = await cdp.eval(STATE);
  check('默认字号 15px', base.fs === DEF && Math.abs(base.pFont - 15) < 0.6,
    `data-fs=${base.fs} p=${base.pFont}px`);
  check('默认缩放系数为 1', base.scale === '1', base.scale);
  check('行高随基准（26px）', Math.abs(base.pLine - 26) < 0.8, `${base.pLine}px`);
  check('UI 字号未被阅读域影响', base.uiSbTab > 0 && base.uiTab > 0,
    `侧栏 ${base.uiSbTab}px / 标签 ${base.uiTab}px`);

  const uiBefore = { tab: base.uiTab, sb: base.uiSbTab, wm: base.uiWordmark, tabH: base.tabH };
  await shot('font-15.png', { x: 0, y: 0, width: WIDTH, height: 460 });

  /* ---------------- 2. Ctrl + 滚轮 ---------------- */
  const wheel = async (deltaY, times = 1) => {
    for (let i = 0; i < times; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: Math.round(WIDTH * 0.6), y: 420,
        deltaX: 0, deltaY, modifiers: 2, pointerType: 'mouse',
      });
      await sleep(150); // 组件侧有 80ms 节流，必须跨过去
    }
  };

  await wheel(-120);
  const up1 = await cdp.eval(STATE);
  check('Ctrl+滚轮向上 → 放大一档', up1.fs === 16 && Math.abs(up1.pFont - 16) < 0.6,
    `data-fs=${up1.fs} p=${up1.pFont}px`);

  await wheel(-120, 2);
  const up3 = await cdp.eval(STATE);
  check('连滚两格继续放大', up3.fs === 18, `data-fs=${up3.fs}`);
  check('标题 / 引用 / 代码一起按比例放大',
    Math.abs(up3.h2Font - 23 * 18 / 15) < 0.7
    && Math.abs(up3.quoteFont - 15.5 * 18 / 15) < 0.7
    && Math.abs(up3.preFont - 12.5 * 18 / 15) < 0.7,
    `h2=${up3.h2Font} 引用=${up3.quoteFont} 代码=${up3.preFont}`);
  check('放大后 UI 一个像素都没变',
    up3.uiTab === uiBefore.tab && up3.uiSbTab === uiBefore.sb
    && up3.uiWordmark === uiBefore.wm && up3.tabH === uiBefore.tabH,
    `标签 ${up3.uiTab}px 侧栏 ${up3.uiSbTab}px 标签高 ${up3.tabH}`);
  check('阅读列宽不跟着变（只放大字，不放大版心）',
    Math.abs(up3.articleW - base.articleW) <= 1, `${base.articleW} → ${up3.articleW}`);

  await shot('font-18.png', { x: 0, y: 0, width: WIDTH, height: 460 });

  await wheel(120);
  const down1 = await cdp.eval(STATE);
  check('Ctrl+滚轮向下 → 缩小一档', down1.fs === 17, `data-fs=${down1.fs}`);

  /* ---------------- 3. 上下限 ---------------- */
  await wheel(-120, 12);
  const top = await cdp.eval(STATE);
  check('放大封顶在 22px', top.fs === MAX, `data-fs=${top.fs}`);
  const plusDisabled = await cdp.eval(`(() => {
    document.querySelector('.icon-btn[aria-label="外观设置"]').click();
    return new Promise(r => setTimeout(() => {
      const btns = [...document.querySelectorAll('.fontrow .fbtn')];
      r({ n: btns.length, plus: btns[1]?.disabled ?? null, minus: btns[0]?.disabled ?? null });
    }, 260));
  })()`);
  check('面板里放大的按钮在封顶时禁用', plusDisabled.n === 2 && plusDisabled.plus === true,
    JSON.stringify(plusDisabled));

  /* ---------------- 4. 面板 A− / A+ / 复位 ---------------- */
  const panel = await cdp.eval(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const btns = [...document.querySelectorAll('.fontrow .fbtn')];
    const num = document.querySelector('.fnum');
    const shown0 = num?.textContent.trim();
    btns[0].click();       // A−
    await wait(120);
    const shown1 = num?.textContent.trim();
    const afterMinus = Number(document.documentElement.dataset.fs);
    num.click();           // 点数字复位
    await wait(120);
    return { shown0, shown1, afterMinus, afterReset: Number(document.documentElement.dataset.fs), hasHint: !!document.querySelector('.themepop__hint') };
  })()`);
  check('面板显示当前字号', panel.shown0 === '22px', panel.shown0);
  check('面板 A− 生效并同步数值', panel.afterMinus === 21 && panel.shown1 === '21px',
    `data-fs=${panel.afterMinus} 显示=${panel.shown1}`);
  check('点数字复位到 15px', panel.afterReset === DEF, `data-fs=${panel.afterReset}`);
  check('面板里写了 Ctrl+滚轮的提示', panel.hasHint);

  await shot('font-panel.png');

  await cdp.eval(`document.querySelector('.icon-btn[aria-label="外观设置"]').click()`);
  await sleep(200);

  /* ---------------- 5. 键盘 ---------------- */
  const key = async (k, code, vk) => {
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', {
        type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 2,
      });
    }
    await sleep(160);
  };

  await key('=', 'Equal', 187);
  const kUp = await cdp.eval(STATE);
  check('Ctrl+= 放大', kUp.fs === 16, `data-fs=${kUp.fs}`);

  await key('-', 'Minus', 189);
  await key('-', 'Minus', 189);
  const kDown = await cdp.eval(STATE);
  check('Ctrl+- 缩小', kDown.fs === 14, `data-fs=${kDown.fs}`);

  await key('0', 'Digit0', 48);
  const kReset = await cdp.eval(STATE);
  check('Ctrl+0 复位 15px', kReset.fs === DEF, `data-fs=${kReset.fs}`);

  await wheel(-120, 3); // 18，留给持久化那一段
  await sleep(200);

  /* ---------------- 6. 持久化 + 首帧 ---------------- */
  await cdp.send('Page.reload');
  await waitFor(cdp, `!!document.querySelector('.mr-article > p')`, { timeoutMs: 60000, label: '重载' });
  await sleep(500);
  const after = await cdp.eval(STATE);
  check('刷新后仍是上次的字号', after.fs === 18 && Math.abs(after.pFont - 18) < 0.6,
    `data-fs=${after.fs} p=${after.pFont}px`);
  const boot = await cdp.eval(`(() => ({
    attr: document.documentElement.getAttribute('data-fs'),
    inline: document.documentElement.style.getPropertyValue('--mr-read-scale').trim(),
  }))()`);
  check('首帧脚本已把字号写进 DOM（不会先小后大）',
    boot.attr === '18' && Math.abs(Number(boot.inline) - 1.2) < 0.001, JSON.stringify(boot));

  /* ---------------- 7. 长文档：虚拟滚动不跑位 ---------------- */
  const openBig = await cdp.eval(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const fileTab = [...document.querySelectorAll('.sidebar__tab')].find((b) => b.textContent.trim() === '文件');
    if (fileTab && !fileTab.classList.contains('is-active')) { fileTab.click(); await wait(250); }
    const row = [...document.querySelectorAll('.trow--file')].find((r) => r.textContent.includes('big.md'));
    if (!row) return 'no-row';
    row.click();
    for (let i = 0; i < 80; i++) {
      await wait(150);
      const b = window.__moreadArticle?.read?.();
      if (b && b.blocks > 100) return 'ok:' + b.blocks;
    }
    return 'timeout';
  })()`);
  check('长文档已打开（走虚拟滚动）', String(openBig).startsWith('ok:'), String(openBig));

  const longBefore = await cdp.eval(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const sc = document.querySelector('.content');
    sc.scrollTop = Math.round(sc.scrollHeight * 0.45);
    await wait(600);
    const b = window.__moreadArticle.read();
    return {
      start: b.range.start, blocks: b.blocks, els: b.renderedEls,
      total: Math.round(b.totalHeight), scrollTop: Math.round(b.scrollTop),
      line: parseFloat(getComputedStyle(document.querySelector('.mr-article > p')).lineHeight),
    };
  })()`);

  await wheel(-120, 2); // 18 → 20，只在正文区滚，命中真正打开的长文档
  await sleep(700);

  const longAfter = await cdp.eval(`(() => {
    const b = window.__moreadArticle.read();
    return {
      fs: Number(document.documentElement.dataset.fs),
      start: b.range.start, blocks: b.blocks, els: b.renderedEls,
      total: Math.round(b.totalHeight),
      line: parseFloat(getComputedStyle(document.querySelector('.mr-article > p')).lineHeight),
    };
  })()`);

  check('长文档字号真的到 20px', longAfter.fs === 20, `data-fs=${longAfter.fs}`);
  check('段落行高按比例走（26 × 20/15 ≈ 34.7）', Math.abs(longAfter.line - 34.67) < 0.9,
    `${longAfter.line}px`);
  check('块结构没被字号改动破坏', longAfter.blocks === longBefore.blocks,
    `${longBefore.blocks} → ${longAfter.blocks}`);
  check('全文总高随之变大（不是只有视口内变了）', longAfter.total > longBefore.total,
    `${longBefore.total} → ${longAfter.total}`);
  check('阅读位置没被弹走（漂移 ≤ 3 块）',
    Math.abs(longAfter.start - longBefore.start) <= 3,
    `第 ${longBefore.start} → 第 ${longAfter.start} 块`);
  check('虚拟滚动仍然只渲染视野附近',
    longAfter.els > 0 && longAfter.els < 400, `DOM 块 ${longAfter.els}`);

  await shot('font-20-long.png', { x: 0, y: 0, width: WIDTH, height: HEIGHT });

  const fails = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - fails.length}/${checks.length} 通过`);
  if (fails.length) {
    console.log(fails.map((f) => `  ✗ ${f.name}  ${f.detail}`).join('\n'));
  }
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({
    width: WIDTH, total: checks.length, failed: fails.length, checks,
  }, null, 2));

  process.exitCode = fails.length ? 1 : 0;
} finally {
  try { cdp?.close(); } catch { /* 忽略 */ }
  proc.kill();
}
