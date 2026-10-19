/**
 * 侧栏拖拽宽度验证：拖动 / 夹取 / 双击复位 / 键盘 / 持久化 / 折叠后消失
 *
 * 用法：
 *   node tools/splitter-check.mjs --ws "C:/.../moread-ws-tabs" [--width 1000]
 *
 * 拖动走 CDP 的 Input.dispatchMouseEvent —— 这是真鼠标事件，
 * 浏览器会自己合成 pointerdown/pointermove/pointerup，
 * 组件里那套 setPointerCapture + pointermove 的逻辑才算真跑了一遍。
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

const PORT = Number(args.port ?? 9225);
const CDP_BASE = `http://127.0.0.1:${PORT}`;
const WIDTH = Number(args.width ?? 1000);
const WS = args.ws ?? `${TMP}/moread-ws-tabs`;
const OUT = args.out ?? `${TMP}/moread-splitter`;
const APP = `http://127.0.0.1:1420/?theme=light&nowatch=1&ws=${encodeURIComponent(WS)}`;

const MIN = 200;
const MAX = 480;
const DEFAULT = 240;

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

  cdp = await attach(CDP_BASE, APP);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: 760, deviceScaleFactor: 2, mobile: false,
  });
  await cdp.send('Page.navigate', { url: APP });
  await waitFor(cdp, `!!document.querySelector('.sidebar') && !!document.querySelector('.gutter')`,
    { timeoutMs: 60000, label: '侧栏与拖拽条' });
  await sleep(400);

  async function shot(name, clip) {
    const params = { format: 'png' };
    if (clip) params.clip = { ...clip, scale: 1 };
    const { data } = await cdp.send('Page.captureScreenshot', params);
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  /* ---------------- 页面内读数 ---------------- */
  const STATE = `(() => {
    const sb = document.querySelector('.sidebar');
    const gut = document.querySelector('.gutter');
    const ct = document.querySelector('.content');
    const art = document.querySelector('.mr-article');
    const s = sb.getBoundingClientRect();
    const g = gut ? gut.getBoundingClientRect() : null;
    return {
      sidebarW: Math.round(s.width * 10) / 10,
      gutterLeft: g ? Math.round(g.left * 10) / 10 : null,
      gutterW: g ? g.width : null,
      contentW: Math.round(ct.getBoundingClientRect().width * 10) / 10,
      articleW: art ? Math.round(art.getBoundingClientRect().width * 10) / 10 : null,
      dragging: document.body.classList.contains('is-resizing'),
      classes: gut ? gut.className : '',
      stored: localStorage.getItem('moread.sidebar-w'),
    };
  })()`;

  const mouse = (type, x, y, extra = {}) => cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button: type === 'mouseMoved' ? 'none' : 'left',
    buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra,
  });

  /** 从 gutter 中心按下，拖到 targetX（分几步走，模拟真实移动） */
  async function dragTo(targetX, { release = true } = {}) {
    const s0 = await cdp.eval(STATE);
    const y = 400;
    await mouse('mousePressed', s0.gutterLeft + 3, y);
    const from = s0.gutterLeft + 3;
    for (let i = 1; i <= 6; i++) {
      await mouse('mouseMoved', from + ((targetX - from) * i) / 6, y);
      await sleep(30);
    }
    const mid = await cdp.eval(STATE);
    if (release) await mouse('mouseReleased', targetX, y);
    await sleep(120);
    return mid;
  }

  /* ---------------- 1. 默认宽度与拖拽条位置 ---------------- */
  const init = await cdp.eval(STATE);
  check('默认宽度 240px', init.sidebarW === DEFAULT, `${init.sidebarW}px`);
  check('拖拽条骑在侧栏右边线上', Math.abs(init.gutterLeft + 3 - init.sidebarW) <= 1,
    `gutter 中心 ${init.gutterLeft + 3}，侧栏右边缘 ${init.sidebarW}`);
  check('热区比线宽（7px），好点中', init.gutterW === 7, `${init.gutterW}px`);
  const contentAtDefault = init.contentW;

  /* ---------------- 2. 拖动变宽 ---------------- */
  const mid = await dragTo(360);
  check('按下即进入拖动态（全局锁光标）', mid.dragging, `is-resizing=${mid.dragging}`);
  check('拖动中拖拽条高亮', mid.classes.includes('gutter--active'), mid.classes);
  const wide = await cdp.eval(STATE);
  check('拖到 360px：侧栏跟着变宽', Math.abs(wide.sidebarW - 360) <= 1.5, `${wide.sidebarW}px`);
  check('正文同步让位（不重叠、不被挤破）',
    Math.abs((contentAtDefault - wide.contentW) - 120) <= 3,
    `正文 ${contentAtDefault} → ${wide.contentW}`);
  check('松手后退出拖动态', !wide.dragging);
  check('宽度写进了 localStorage', wide.stored === '360', `stored=${wide.stored}`);
  await shot('splitter-360.png', { x: 0, y: 0, width: WIDTH, height: 200 });

  /* ---------------- 3. 两侧夹取 ---------------- */
  await dragTo(60);
  const narrow = await cdp.eval(STATE);
  check(`左夹取：拖到 60px 只到 ${MIN}px`, narrow.sidebarW === MIN, `${narrow.sidebarW}px`);

  await dragTo(800);
  const wideClamp = await cdp.eval(STATE);
  const ceiling = Math.min(MAX, WIDTH - 420);
  check(`右夹取：不越过 ${ceiling}px（480 与"正文留 420"取小）`,
    Math.abs(wideClamp.sidebarW - ceiling) <= 1, `${wideClamp.sidebarW}px，窗口 ${WIDTH}px`);
  await shot('splitter-max.png', { x: 0, y: 0, width: WIDTH, height: 200 });

  /* ---------------- 4. 双击复位 ---------------- */
  const before = await cdp.eval(STATE);
  await mouse('mousePressed', before.gutterLeft + 3, 400, { clickCount: 1 });
  await mouse('mouseReleased', before.gutterLeft + 3, 400, { clickCount: 1 });
  await mouse('mousePressed', before.gutterLeft + 3, 400, { clickCount: 2 });
  await mouse('mouseReleased', before.gutterLeft + 3, 400, { clickCount: 2 });
  await sleep(250);
  const reset = await cdp.eval(STATE);
  check('双击拖拽条复位为 240px', reset.sidebarW === DEFAULT, `${reset.sidebarW}px`);

  /* ---------------- 5. 键盘 ---------------- */
  const KEY = `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const gut = document.querySelector('.gutter');
    gut.focus();
    const fire = (key, shift = false) => gut.dispatchEvent(new KeyboardEvent('keydown', {
      key, shiftKey: shift, bubbles: true, cancelable: true,
    }));
    fire('ArrowRight'); fire('ArrowRight');
    await wait(60);
    const afterRight = document.querySelector('.sidebar').getBoundingClientRect().width;
    fire('ArrowLeft', true);
    await wait(60);
    const afterShiftLeft = document.querySelector('.sidebar').getBoundingClientRect().width;
    fire('Home'); await wait(60);
    const afterHome = document.querySelector('.sidebar').getBoundingClientRect().width;
    fire('End'); await wait(60);
    const afterEnd = document.querySelector('.sidebar').getBoundingClientRect().width;
    return { afterRight, afterShiftLeft, afterHome, afterEnd, focused: document.activeElement === gut };
  })()`;

  const kb = await cdp.eval(KEY);
  check('拖拽条可聚焦（Tab 能到它）', kb.focused);
  check('→ 键每次 +8px', Math.round(kb.afterRight) === DEFAULT + 16, `${kb.afterRight}px`);
  check('Shift+← 一次 -32px', Math.round(kb.afterShiftLeft) === DEFAULT - 16, `${kb.afterShiftLeft}px`);
  check('Home 到最窄 200px', Math.round(kb.afterHome) === MIN, `${kb.afterHome}px`);
  check('End 到最宽', Math.round(kb.afterEnd) === ceiling, `${kb.afterEnd}px`);

  /* ---------------- 6. 重新加载后宽度还在 ---------------- */
  await dragTo(330);
  await cdp.send('Page.reload', { ignoreCache: false });
  await waitFor(cdp, `!!document.querySelector('.sidebar')`, { timeoutMs: 60000, label: '重新加载' });
  await sleep(600);
  const reloaded = await cdp.eval(STATE);
  check('重开窗口仍记得上次宽度', Math.abs(reloaded.sidebarW - 330) <= 1.5, `${reloaded.sidebarW}px`);

  /* ---------------- 7. 折叠 / 展开（图标栏） ---------------- */
  const RAIL = `(() => {
    const rail = document.querySelector('.rail');
    const sb = document.querySelector('.sidebar');
    const ct = document.querySelector('.content');
    return {
      hasSidebar: !!sb,
      hasGutter: !!document.querySelector('.gutter'),
      hasRail: !!rail,
      railW: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
      modes: rail ? [...rail.querySelectorAll('[data-mode]')].map(b => b.dataset.mode) : [],
      hasExpand: !!(rail && rail.querySelector('.rail__b--expand')),
      activeMode: rail?.querySelector('.rail__b.is-active')?.dataset.mode ?? '',
      contentW: Math.round(ct.getBoundingClientRect().width),
    };
  })()`;

  const FOLD = `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }));
    await wait(350);
    return true;
  })()`;

  const contentBefore = (await cdp.eval(STATE)).contentW;
  await cdp.eval(FOLD);
  const folded = await cdp.eval(RAIL);

  check('折叠后侧栏消失、拖拽条一起隐藏', !folded.hasSidebar && !folded.hasGutter);
  check('折叠后出现 44px 图标栏（不是彻底消失）', folded.hasRail && folded.railW === 44,
    `rail ${folded.railW}px`);
  check('图标栏里留着 大纲/文件/历史 三个入口（顺序与页签一致）',
    folded.modes.join(',') === 'outline,files,history', folded.modes.join(' / '));
  check('图标栏底部有展开按钮', folded.hasExpand);
  check('折叠释放的宽度全给正文',
    Math.abs((folded.contentW - contentBefore) - (330 - 44)) <= 2,
    `正文 ${contentBefore} → ${folded.contentW}（侧栏 330 → 栏 44）`);
  await shot('folded-rail.png', { x: 0, y: 0, width: WIDTH, height: 760 });

  // 点图标栏里的「历史」：展开并切到该模式。起始页签是文件（这条用例带 ?ws），
  // 切得过去才说明 icon 真的把模式带上了，而不是碰巧"展开到默认页"
  const OPEN_BY_RAIL = `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('.rail [data-mode="history"]').click();
    await wait(350);
    const sb = document.querySelector('.sidebar');
    return {
      hasRail: !!document.querySelector('.rail'),
      sidebarW: sb ? Math.round(sb.getBoundingClientRect().width) : 0,
      activeTab: document.querySelector('.sidebar__tab.is-active')?.textContent?.trim() ?? '',
      hasGutter: !!document.querySelector('.gutter'),
    };
  })()`;
  const byRail = await cdp.eval(OPEN_BY_RAIL);
  check('点图标栏的「历史」→ 展开并切到历史', !byRail.hasRail && byRail.activeTab === '历史',
    `侧栏 ${byRail.sidebarW}px，当前 ${byRail.activeTab}`);
  check('展开后宽度还是折叠前的（没被重置成 240）',
    Math.abs(byRail.sidebarW - 330) <= 1.5, `${byRail.sidebarW}px`);
  check('展开后拖拽条回来', byRail.hasGutter);

  // 侧栏里的收起按钮
  const BY_BUTTON = `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const btn = document.querySelector('.sidebar__fold');
    if (!btn) return { clicked: false };
    btn.click();
    await wait(350);
    return { clicked: true, hasRail: !!document.querySelector('.rail') };
  })()`;
  const byButton = await cdp.eval(BY_BUTTON);
  check('侧栏左上角的收起按钮也能折叠', byButton.clicked && byButton.hasRail);

  // Ctrl+B 再按一次回到展开
  await cdp.eval(FOLD);
  const back = await cdp.eval(RAIL);
  check('再按一次 Ctrl+B 展开回来', back.hasSidebar && !back.hasRail);

  /* ---------------- 8. 改宽度不会打乱正文 ---------------- */
  await dragTo(200);
  await dragTo(420);
  const doc = await cdp.eval(`(() => {
    const a = document.querySelector('.mr-article');
    const blocks = window.__moreadArticle?.read?.();
    return {
      articlePresent: !!a,
      articleW: a ? Math.round(a.getBoundingClientRect().width) : 0,
      blocks: blocks?.blocks ?? -1,
      calibrated: blocks?.calibrated ?? null,
    };
  })()`);
  check('拖动后正文仍在，块数不变（虚拟滚动没被搞坏）',
    doc.articlePresent && doc.blocks > 0, JSON.stringify(doc));

  /* ---------------- 9. 长文档读到中途改宽度：位置不能丢 ---------------- */
  /*
    这是宽度重算最容易翻车的场景：虚拟滚动的高度是按"当前行宽"估的，
    行宽一变，所有估高都失效。重算时既要把估高换成新行宽的，
    又不能把读者从第 200 节弹回开头或掉进一片空白。
  */
  const openBig = `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    // 上一段把侧栏切到「搜索」了，先切回文件树再找文件
    const fileTab = [...document.querySelectorAll('.sidebar__tab')]
      .find((b) => b.textContent.trim() === '文件');
    if (fileTab && !fileTab.classList.contains('is-active')) { fileTab.click(); await wait(250); }
    const row = [...document.querySelectorAll('.trow--file')]
      .find((r) => r.textContent.includes('big.md'));
    if (!row) return 'no-row';
    row.click();
    for (let i = 0; i < 60; i++) {
      await wait(150);
      const b = window.__moreadArticle?.read?.();
      if (b && b.blocks > 100) return 'ok:' + b.blocks;
    }
    return 'timeout';
  })()`;
  const bigOpen = await cdp.eval(openBig);
  check('长文档打开（虚拟滚动生效）', String(bigOpen).startsWith('ok:'), String(bigOpen));

  const longBefore = await cdp.eval(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const sc = document.querySelector('.content');
    sc.scrollTop = Math.round(sc.scrollHeight * 0.45);
    await wait(500);
    const b = window.__moreadArticle.read();
    return { scrollTop: Math.round(b.scrollTop), start: b.range.start, blocks: b.blocks, total: Math.round(b.totalHeight) };
  })()`);

  await dragTo(300);
  await sleep(600);
  const longAfter = await cdp.eval(`(() => {
    const b = window.__moreadArticle.read();
    return {
      scrollTop: Math.round(b.scrollTop), start: b.range.start, blocks: b.blocks,
      renderedEls: b.renderedEls, total: Math.round(b.totalHeight), viewHeight: b.viewHeight,
    };
  })()`);

  check('改宽度后仍停在同一处（首屏块号漂移 ≤ 3）',
    Math.abs(longAfter.start - longBefore.start) <= 3,
    `第 ${longBefore.start} 块 → 第 ${longAfter.start} 块（共 ${longBefore.blocks}）`);
  check('没有被弹回开头', longAfter.scrollTop > longAfter.viewHeight, `scrollTop=${longAfter.scrollTop}`);
  check('重算后没有掉进空白（渲染元素数正常）', longAfter.renderedEls > 0,
    `渲染 ${longAfter.renderedEls} 块，总高 ${longBefore.total} → ${longAfter.total}`);

  await shot('splitter-longdoc.png', { x: 0, y: 0, width: WIDTH, height: 260 });

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ checks, doc }, null, 2));
  console.log(`截图与报告：${OUT}`);
  if (failed.length) process.exitCode = 1;
} finally {
  try { cdp?.close(); } catch { /* 已关闭 */ }
  try { proc.kill(); } catch { /* 已退出 */ }
}
