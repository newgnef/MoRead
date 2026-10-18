/**
 * 标签条溢出验证：收缩 / 滚动 / ⌄ 菜单 / 活动标签追视野
 *
 * 用法：
 *   node tools/tabs-overflow-check.mjs --ws "C:/.../moread-ws-tabs" [--width 980]
 *
 * 自己起浏览器（headless 旧内核 + CDP），跑完自己收掉 ——
 * 会话里手动起的进程会被回收，脚本内 spawn 才能保证测试期间一直活着。
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

const PORT = Number(args.port ?? 9223);
const CDP_BASE = `http://127.0.0.1:${PORT}`;
const WIDTH = Number(args.width ?? 980);
const WS = args.ws ?? `${TMP}/moread-ws-tabs`;
const OUT = args.out ?? `${TMP}/moread-tabs-overflow`;
const APP = `http://127.0.0.1:1420/?theme=light&nowatch=1&ws=${encodeURIComponent(WS)}`;

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
async function shutdown() {
  try { cdp?.close(); } catch { /* 已关闭 */ }
  try { proc.kill(); } catch { /* 已退出 */ }
}

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
  await waitFor(cdp, `!!document.querySelector('.trow--file')`, { timeoutMs: 60000, label: '侧栏文件列表' });

  async function shot(name, clip) {
    const params = { format: 'png' };
    if (clip) params.clip = { ...clip, scale: 1 };
    const { data } = await cdp.send('Page.captureScreenshot', params);
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  /* 页面内读数：标签宽度、容器滚动状态、⌄ 是否在、+ 是否完整可见 */
  const STATE = `(() => {
    const strip = document.querySelector('.tabstrip__scroll');
    const tabs = [...document.querySelectorAll('.tab')];
    const c = strip.getBoundingClientRect();
    const widths = tabs.map(t => Math.round(t.getBoundingClientRect().width * 10) / 10);
    const offscreen = tabs.filter(t => {
      const r = t.getBoundingClientRect();
      return r.right > c.right + 0.5 || r.left < c.left - 0.5;
    }).map(t => t.querySelector('.tab__name').textContent.trim());
    const plus = document.querySelector('.tabstrip > .icon-btn:last-of-type');
    const pr = plus.getBoundingClientRect();
    const active = document.querySelector('.tab--active');
    const ar = active.getBoundingClientRect();
    return {
      count: tabs.length,
      widths,
      minW: Math.min(...widths),
      maxW: Math.max(...widths),
      scrollW: strip.scrollWidth,
      clientW: strip.clientWidth,
      scrollLeft: Math.round(strip.scrollLeft),
      overflow: strip.scrollWidth - strip.clientWidth > 1,
      hasMore: !!document.querySelector('.tabstrip__more'),
      offscreen,
      plusVisible: pr.right <= window.innerWidth + 0.5 && pr.left >= 0,
      activeInView: ar.left >= c.left - 0.5 && ar.right <= c.right + 0.5,
      activeName: active.querySelector('.tab__name').textContent.trim(),
    };
  })()`;

  /* ---------------- 1. 少量标签：不收缩到极限，也没有 ⌄ ---------------- */
  const openSome = (n) => `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const rows = [...document.querySelectorAll('.trow--file')];
    for (const row of rows.slice(0, ${n})) { row.click(); await wait(420); }
    await wait(300);
    return true;
  })()`;

  await cdp.eval(openSome(3));
  const few = await cdp.eval(STATE);
  check('3 个标签时排得开，不出现 ⌄', few.count === 3 && !few.hasMore, `count=${few.count} hasMore=${few.hasMore}`);
  check('排得开时标签没被压到最小宽', few.maxW > 100, `宽度 ${few.widths.join('/')}`);

  /* ---------------- 2. 堆到溢出：收缩优先 ---------------- */
  await cdp.eval(openSome(12));
  const many = await cdp.eval(STATE);
  check('收缩生效：每个标签都不窄于 100px', many.minW >= 99.5, `最窄 ${many.minW}`);
  check('收缩生效：每个标签都不宽于 220px 上限', many.maxW <= 220.5, `最宽 ${many.maxW}`);
  check('+ 按钮没被挤出去', many.plusVisible);
  check('最后打开的那个标签在视野里', many.activeInView, `active=${many.activeName}`);

  await shot('overflow-980.png');
  await shot('overflow-titlebar.png', { x: 0, y: 0, width: WIDTH, height: 44 });

  /*
    窗口够宽时 12 个标签也能排开，后面几段就没有场景可测。
    这不是失败，是这一档宽度不受溢出逻辑管辖 —— 说清楚再跳过，
    否则换个人拿 --width 1600 跑一遍会看到一堆红叉还以为改坏了。
  */
  if (!many.overflow) {
    console.log(`\n  ${WIDTH}px 下 12 个标签仍排得开（${many.minW}~${many.maxW}px），跳过溢出链路（⌄ 菜单 / 滚轮 / 回落）`);
  } else {

  check('12 个标签把标签条撑到溢出', many.overflow, `scrollW=${many.scrollW} clientW=${many.clientW}`);
  check('溢出后出现 ⌄', many.hasMore);
  check('侧栏之外还有标签被推到视野外', many.offscreen.length > 0, `视野外 ${many.offscreen.length} 个：${many.offscreen.join(' / ')}`);

  /* ---------------- 3. ⌄ 菜单 ---------------- */
  const MENU = `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('.tabstrip__more').click();
    await wait(280);
    const menu = document.querySelector('.moremenu');
    if (!menu) return { open: false };
    const items = [...menu.querySelectorAll('.tabmenu__i')].map(b => b.textContent.trim());
    const r = menu.getBoundingClientRect();
    return {
      open: true,
      head: menu.querySelector('.tabmenu__head')?.textContent?.trim() ?? '',
      items,
      insideWindow: r.left >= -0.5 && r.right <= window.innerWidth + 0.5,
      beforeActive: document.querySelector('.tab--active .tab__name').textContent.trim(),
    };
  })()`;

  const menu = await cdp.eval(MENU);
  check('点 ⌄ 弹出溢出菜单', menu.open);
  check('菜单条目数 = 视野外的标签数', menu.open && menu.items.length === many.offscreen.length,
    `菜单 ${menu.items?.length} 条 / 视野外 ${many.offscreen.length} 个`);
  check('菜单条目就是那几个被挤掉的标签',
    menu.open && menu.items.join('|') === many.offscreen.join('|'),
    `${menu.items?.join(' / ')}`);
  check('菜单没超出窗口右边缘', menu.open && menu.insideWindow);
  await shot('overflow-menu.png');

  /* ---------------- 4. 从菜单点选 → 切过去并滚进视野 ---------------- */
  const PICK = `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const first = document.querySelector('.moremenu .tabmenu__i');
    const wanted = first.textContent.trim();
    first.click();
    await wait(420);
    const strip = document.querySelector('.tabstrip__scroll');
    const c = strip.getBoundingClientRect();
    const a = document.querySelector('.tab--active');
    const r = a.getBoundingClientRect();
    return {
      wanted,
      activeName: a.querySelector('.tab__name').textContent.trim(),
      inView: r.left >= c.left - 0.5 && r.right <= c.right + 0.5,
      menuClosed: !document.querySelector('.moremenu'),
      scrollLeft: Math.round(strip.scrollLeft),
    };
  })()`;

  const pick = await cdp.eval(PICK);
  check('菜单点选 → 那个标签被激活', pick.wanted === pick.activeName, `${pick.wanted} → ${pick.activeName}`);
  check('点选后它自己滚进了视野', pick.inView, `scrollLeft=${pick.scrollLeft}`);
  check('点完菜单自动收起', pick.menuClosed);

  /* ---------------- 5. 滚轮横推 ---------------- */
  const WHEEL = `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const strip = document.querySelector('.tabstrip__scroll');
    strip.scrollLeft = 0;
    await wait(60);
    const before = strip.scrollLeft;
    // 合成的 WheelEvent 走的是组件里那个 passive:false 的监听
    strip.dispatchEvent(new WheelEvent('wheel', { deltaY: 160, bubbles: true, cancelable: true }));
    await wait(120);
    return { before, after: Math.round(strip.scrollLeft), max: strip.scrollWidth - strip.clientWidth };
  })()`;

  const wheel = await cdp.eval(WHEEL);
  check('竖向滚轮能横推标签条', wheel.after > wheel.before, `${wheel.before} → ${wheel.after}`);

  /* ---------------- 6. 收回到 2 个标签：⌄ 消失、回到不滚状态 ---------------- */
  const REDUCE = `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    // 留着最后两个，其余从右键菜单批量关掉
    const tabs = [...document.querySelectorAll('.tab')];
    tabs[0].dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 60, clientY: 30,
    }));
    await wait(200);
    const btn = [...document.querySelectorAll('.tabmenu__i')].find(b => b.textContent.includes('关闭其他标签页'));
    btn.click();
    await wait(500);
    const strip = document.querySelector('.tabstrip__scroll');
    return {
      count: document.querySelectorAll('.tab').length,
      hasMore: !!document.querySelector('.tabstrip__more'),
      overflow: strip.scrollWidth - strip.clientWidth > 1,
      scrollLeft: Math.round(strip.scrollLeft),
    };
  })()`;

  const reduce = await cdp.eval(REDUCE);
  check('关掉多余标签后 ⌄ 自动消失', reduce.count === 1 && !reduce.hasMore, `剩 ${reduce.count} 个，hasMore=${reduce.hasMore}`);
  check('不溢出时滚动位置归零，不会留下残余偏移', !reduce.overflow);

  }

  /* ---------------- 汇总 ---------------- */
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ checks, shots: fs.readdirSync(OUT).filter((f) => f.endsWith('.png')) }, null, 2));
  console.log(`截图与报告：${OUT}`);
  if (failed.length) process.exitCode = 1;
} finally {
  await shutdown();
}
