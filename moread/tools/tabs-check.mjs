/**
 * 标签页交互验证：拖拽换位 / 右键菜单 / 固定标签
 *
 * 用法：
 *   node tools/tabs-check.mjs --url "http://127.0.0.1:1420/?theme=light&nowatch=1&ws=<工作区>" [--out <目录>]
 *
 * 前置：Edge 以 --remote-debugging-port=9222 启动，且已打开上面那个地址。
 *
 * 拖拽部分用合成的 DragEvent 驱动 —— HTML5 拖放在 CDP 里没有"真鼠标"接口，
 * 但事件的走向（dragstart → dragover → drop）与真实拖拽完全一致，
 * 组件里那套判定逻辑（中线分左右、落点计算）是真跑了一遍的。
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { attach, sleep, waitFor } from './cdp.mjs';

/* 临时目录一律走 os.tmpdir()：不写死某台机器的路径，换个人跑脚本也不用改 */
const TMP = os.tmpdir().replace(/\\/g, '/');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}

const APP = args.url ?? 'http://127.0.0.1:1420/';
const OUT = args.out ?? `${TMP}/moread-tabs`;
const CDP_BASE = args.cdp ?? 'http://127.0.0.1:9222';

fs.mkdirSync(OUT, { recursive: true });

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `   ${String(detail).slice(0, 160)}` : ''}`);
}

const cdp = await attach(CDP_BASE, APP);
await cdp.send('Page.navigate', { url: APP });
await waitFor(cdp, `!!document.querySelector('.mr-article')`, { timeoutMs: 60000, label: '首篇文档渲染完成' });

async function shot(name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

/** 页面内的公共工具：把标签名按当前顺序读出来 */
const NAMES = `[...document.querySelectorAll('.tab')].map(t => ({
  name: t.querySelector('.tab__name')?.textContent?.trim() ?? '',
  pinned: t.classList.contains('tab--pinned'),
  hasClose: !!t.querySelector('.tab__close'),
}))`;

/** 打开三个标签，作为后续所有操作的基础 */
const SETUP = `(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const rows = [...document.querySelectorAll('.trow--file')];
  for (const row of rows.slice(0, 4)) {
    row.click();
    await wait(650);
  }
  return ${NAMES};
})()`;

const initial = await cdp.eval(SETUP);
check('打开文件即新增标签', initial.length >= 4, `${initial.length} 个：${initial.map((t) => t.name).join(' / ')}`);

/* ------------------------------------------------------------------ */
/* 1. 左键拖拽换位                                                     */
/* ------------------------------------------------------------------ */

const DRAG = `(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const tabs = () => [...document.querySelectorAll('.tab')];
  const names = () => tabs().map(t => t.querySelector('.tab__name').textContent.trim());

  const before = names();
  const from = tabs()[0];
  const to = tabs()[2];

  const dt = new DataTransfer();
  const fire = (el, type, x) => el.dispatchEvent(new DragEvent(type, {
    bubbles: true, cancelable: true, dataTransfer: dt,
    clientX: x ?? 0, clientY: 20,
  }));

  // 拖 1 号到 3 号的后半段 → 应插到 3 号右边
  fire(from, 'dragstart');
  const r = to.getBoundingClientRect();
  fire(to, 'dragover', r.left + r.width * 0.8);
  await wait(80); // 等 Svelte 把插入指示线画到 DOM 上再读

  const hint = [...document.querySelectorAll('.tab--drop-end, .tab--drop-start')]
    .map(t => t.className);

  fire(to, 'drop');
  fire(from, 'dragend');
  await wait(250);

  // 再把它拖回最左：插到当前第 1 个之前
  const after1 = names();
  const moving = tabs()[after1.length - 1];
  const movingName = moving.querySelector('.tab__name').textContent.trim();
  const firstTarget = tabs()[0];
  const dt2 = new DataTransfer();
  const fire2 = (el, type, x) => el.dispatchEvent(new DragEvent(type, {
    bubbles: true, cancelable: true, dataTransfer: dt2,
    clientX: x ?? 0, clientY: 20,
  }));
  fire2(moving, 'dragstart');
  const r2 = firstTarget.getBoundingClientRect();
  fire2(firstTarget, 'dragover', r2.left + r2.width * 0.1);
  fire2(firstTarget, 'drop');
  fire2(moving, 'dragend');
  await wait(250);

  return { before, hintShown: hint.length, afterForward: after1, movingName, afterBack: names() };
})()`;

const drag = await cdp.eval(DRAG);
check('拖到目标右半段 → 插到它后面', drag.afterForward[2] === drag.before[0], `${drag.afterForward.join(' / ')}`);
check('拖回最左 → 插到最前', drag.afterBack[0] === drag.movingName, `${drag.afterBack.join(' / ')}`);
check('拖拽过程有插入指示线', drag.hintShown > 0, `${drag.hintShown} 处`);

/* ------------------------------------------------------------------ */
/* 2. 右键菜单                                                         */
/* ------------------------------------------------------------------ */

const MENU_OPEN = `(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const tabs = [...document.querySelectorAll('.tab')];
  const target = tabs[1];
  const r = target.getBoundingClientRect();
  target.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true,
    clientX: Math.round(r.left + 20), clientY: Math.round(r.bottom),
  }));
  await wait(200);
  const menu = document.querySelector('.tabmenu');
  if (!menu) return { open: false };
  const items = [...menu.querySelectorAll('.tabmenu__i')].map(b => ({
    label: b.textContent.trim().replace(/\\s+/g, ' '),
    disabled: b.disabled,
  }));
  const box = menu.getBoundingClientRect();
  return { open: true, items, box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) } };
})()`;

const menuOpen = await cdp.eval(MENU_OPEN);
check('右键标签弹出菜单', menuOpen.open === true);
check(
  '菜单含 5 类关闭 + 固定',
  menuOpen.open && menuOpen.items.length === 6,
  menuOpen.items?.map((i) => i.label).join(' | '),
);
check(
  '菜单被收进窗口内',
  menuOpen.open && menuOpen.box.x >= 0 && menuOpen.box.y >= 0
    && menuOpen.box.x + menuOpen.box.w <= 1440,
  JSON.stringify(menuOpen.box),
);
await shot('tabs-menu.png');

/* -------- 关闭左侧：锚点在第 2 个（索引 1）-------- */
const CLOSE_LEFT = `(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const before = ${NAMES};
  const btn = [...document.querySelectorAll('.tabmenu__i')]
    .find(b => b.textContent.includes('关闭左侧'));
  btn.click();
  await wait(400);
  return { before, after: ${NAMES}, menuGone: !document.querySelector('.tabmenu') };
})()`;

const closeLeft = await cdp.eval(CLOSE_LEFT);
check(
  '关闭左侧只关掉左边的标签',
  closeLeft.after.length === closeLeft.before.length - 1,
  `${closeLeft.before.map((t) => t.name).join('/')} → ${closeLeft.after.map((t) => t.name).join('/')}`,
);
check('点菜单项后菜单关闭', closeLeft.menuGone);

/* ------------------------------------------------------------------ */
/* 3. 固定标签                                                         */
/* ------------------------------------------------------------------ */

const PIN = `(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const tabs = [...document.querySelectorAll('.tab')];
  const target = tabs[1];
  const r = target.getBoundingClientRect();
  target.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: Math.round(r.left + 20), clientY: Math.round(r.bottom),
  }));
  await wait(200);
  const pinBtn = [...document.querySelectorAll('.tabmenu__i')].find(b => b.textContent.includes('固定'));
  const label = pinBtn.textContent.trim();
  const closeBtn = [...document.querySelectorAll('.tabmenu__i')].find(b => b.textContent.startsWith('关闭'));
  const closeDisabledOnPinned = closeBtn?.disabled ?? null;
  pinBtn.click();
  await wait(300);

  const pinnedTab = document.querySelector('.tab--pinned');
  return {
    label,
    closeDisabledOnPinned,
    pinnedCount: document.querySelectorAll('.tab--pinned').length,
    hasPinIcon: !!pinnedTab?.querySelector('.tab__pin'),
    hasCloseBtn: !!pinnedTab?.querySelector('.tab__close'),
    pinnedName: pinnedTab?.querySelector('.tab__name')?.textContent?.trim() ?? null,
  };
})()`;

const pin = await cdp.eval(PIN);
check('菜单里是「固定标签页」', pin.label === '固定标签页', pin.label);
check('固定后不再有关闭按钮', pin.pinnedCount === 1 && pin.hasCloseBtn === false && pin.hasPinIcon, `${pin.pinnedName}`);
await shot('tabs-pinned.png');

/* -------- 固定标签要挡住三条关闭路径 -------- */
const PIN_GUARD = `(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const count = () => document.querySelectorAll('.tab').length;
  const start = count();

  // ① Ctrl+W（会作用在当前激活标签上）——先把固定标签设为激活
  document.querySelector('.tab--pinned').click();
  await wait(200);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true }));
  await wait(300);
  const afterCtrlW = count();
  const toast = document.querySelector('.toast--warn')?.textContent?.trim() ?? null;

  // ② 中键
  document.querySelector('.tab--pinned').dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
  await wait(300);
  const afterMiddle = count();

  // ③ 右键菜单里的「关闭」在固定标签上应处于禁用态
  const p = document.querySelector('.tab--pinned');
  const r = p.getBoundingClientRect();
  p.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.bottom }));
  await wait(200);
  const items = [...document.querySelectorAll('.tabmenu__i')].map(b => ({ label: b.textContent.trim().replace(/\\s+/g, ' '), disabled: b.disabled }));
  // 第一项就是「关闭」；用 label 精确匹配会被 "关闭Ctrl+W" 这种拼接文本坑到
  const closeItem = items[0];

  // 关掉菜单
  document.querySelector('.menu-veil')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await wait(150);

  return { start, afterCtrlW, afterMiddle, toast, closeItem, items };
})()`;

const guard = await cdp.eval(PIN_GUARD);
check('Ctrl+W 关不掉固定标签', guard.afterCtrlW === guard.start, `${guard.start} → ${guard.afterCtrlW}`);
check('并给出提示而不是静默失败', typeof guard.toast === 'string' && guard.toast.includes('固定'), guard.toast ?? '');
check('中键也关不掉固定标签', guard.afterMiddle === guard.start, `${guard.afterMiddle}`);
check('固定标签上「关闭」菜单项是禁用态', guard.closeItem?.disabled === true, JSON.stringify(guard.closeItem));

/* -------- 关闭全部要跳过固定标签 -------- */
const CLOSE_ALL = `(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const before = ${NAMES};
  const anyTab = [...document.querySelectorAll('.tab')].find(t => !t.classList.contains('tab--pinned'));
  const r = anyTab.getBoundingClientRect();
  anyTab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.bottom }));
  await wait(200);
  [...document.querySelectorAll('.tabmenu__i')].find(b => b.textContent.includes('关闭全部')).click();
  await wait(500);
  return { before, after: ${NAMES}, empty: !!document.querySelector('.empty') };
})()`;

const closeAll = await cdp.eval(CLOSE_ALL);
check(
  '关闭全部只留下固定标签',
  closeAll.after.length === closeAll.before.filter((t) => t.pinned).length,
  `${closeAll.before.map((t) => t.name).join('/')} → ${closeAll.after.map((t) => t.name).join('/')}`,
);
await shot('tabs-only-pinned.png');

/* -------- 取消固定后恢复可关闭 -------- */
const UNPIN = `(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const p = document.querySelector('.tab--pinned');
  const r = p.getBoundingClientRect();
  p.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.bottom }));
  await wait(200);
  const btn = [...document.querySelectorAll('.tabmenu__i')].find(b => b.textContent.includes('取消固定'));
  const label = btn?.textContent?.trim() ?? null;
  btn?.click();
  await wait(300);
  return {
    label,
    pinnedCount: document.querySelectorAll('.tab--pinned').length,
    hasCloseBtn: !!document.querySelector('.tab .tab__close'),
  };
})()`;

const unpin = await cdp.eval(UNPIN);
check('菜单变成「取消固定标签页」', unpin.label === '取消固定标签页', unpin.label ?? '');
check('取消固定后关闭按钮回来了', unpin.pinnedCount === 0 && unpin.hasCloseBtn === true);

/* ------------------------------------------------------------------ */
/* 4. 双击关闭                                                         */
/* ------------------------------------------------------------------ */

/** 先把标签补回 3 个，好验证「关掉的是被双击的那个」 */
const DBLC_SETUP = `(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const rows = [...document.querySelectorAll('.trow--file')];
  for (const row of rows.slice(0, 4)) {
    row.click();
    await wait(600);
  }
  return ${NAMES};
})()`;

const dblcReady = await cdp.eval(DBLC_SETUP);
check('补足 3 个标签用于双击测试', dblcReady.length >= 3, dblcReady.map((t) => t.name).join(' / '));

const DBLC_CLOSE = `(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const tabs = () => [...document.querySelectorAll('.tab')];
  const names = () => tabs().map(t => t.querySelector('.tab__name').textContent.trim());

  const before = names();
  const target = tabs()[1];
  const gone = target.querySelector('.tab__name').textContent.trim();
  const title = target.getAttribute('title');

  target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  await wait(350);

  return { before, gone, title, after: names(), count: tabs().length };
})()`;

const dblc = await cdp.eval(DBLC_CLOSE);
check(
  '双击标签即关闭',
  dblc.count === dblc.before.length - 1,
  `${dblc.before.length} → ${dblc.count}`,
);
check(
  '关掉的是被双击的那一个',
  !dblc.after.includes(dblc.gone),
  `双击「${dblc.gone}」，剩下：${dblc.after.join(' / ')}`,
);
check(
  '其余标签原样保留',
  dblc.after.length === dblc.before.length - 1
    && dblc.before.filter((n) => n !== dblc.gone).every((n) => dblc.after.includes(n)),
  dblc.after.join(' / '),
);
check('提示里写明了双击关闭', /双击关闭/.test(dblc.title ?? ''), dblc.title ?? '');

/* -------- 固定标签：双击同样关不掉 -------- */
const DBLC_PINNED = `(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const count = () => document.querySelectorAll('.tab').length;

  // 把第 1 个固定掉
  const t = document.querySelectorAll('.tab')[0];
  const r = t.getBoundingClientRect();
  t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.bottom }));
  await wait(200);
  [...document.querySelectorAll('.tabmenu__i')].find(b => b.textContent.includes('固定')).click();
  await wait(300);

  const pinned = document.querySelector('.tab--pinned');
  const start = count();
  // 提示条可能还残留着上一次的，先记个基线
  const toastBefore = document.querySelector('.toast--warn')?.textContent?.trim() ?? null;

  pinned.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  await wait(400);

  return {
    start,
    after: count(),
    pinnedTitle: pinned.getAttribute('title'),
    toast: document.querySelector('.toast--warn')?.textContent?.trim() ?? null,
    toastBefore,
  };
})()`;

const dblcPinned = await cdp.eval(DBLC_PINNED);
check(
  '双击固定标签也关不掉',
  dblcPinned.after === dblcPinned.start,
  `${dblcPinned.start} → ${dblcPinned.after}`,
);
check(
  '并给出固定提示',
  typeof dblcPinned.toast === 'string' && dblcPinned.toast.includes('固定'),
  dblcPinned.toast ?? '',
);
check(
  '固定标签的提示语不同',
  /已固定/.test(dblcPinned.pinnedTitle ?? ''),
  dblcPinned.pinnedTitle ?? '',
);

/* -------- 双击落在关闭按钮上，不能连带关掉补位上来的邻居 -------- */
const DBLC_ON_X = `(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const tabs = () => [...document.querySelectorAll('.tab')];
  const before = tabs().map(t => t.querySelector('.tab__name').textContent.trim());

  // 取第一个带关闭按钮的标签，对着它的 × 派发 dblclick
  const victim = tabs().find(t => t.querySelector('.tab__close'));
  const x = victim.querySelector('.tab__close');
  const idx = tabs().indexOf(victim);
  x.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));

  await wait(350);
  return { before, idx, after: tabs().map(t => t.querySelector('.tab__name').textContent.trim()) };
})()`;

const onX = await cdp.eval(DBLC_ON_X);
check(
  '双击落在 × 上不会连带关掉邻居',
  onX.after.length === onX.before.length,
  `${onX.before.length} → ${onX.after.length}`,
);

/* -------- 真实鼠标双击：由浏览器自己合成 dblclick，不是我们手搓事件 -------- */
const realTarget = await cdp.eval(`(() => {
  const t = [...document.querySelectorAll('.tab')].find(x => !x.classList.contains('tab--pinned'));
  const r = t.getBoundingClientRect();
  return {
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    name: t.querySelector('.tab__name').textContent.trim(),
    count: document.querySelectorAll('.tab').length,
  };
})()`);

const mouse = (type, clickCount) => cdp.send('Input.dispatchMouseEvent', {
  type, x: realTarget.x, y: realTarget.y, button: 'left', clickCount,
});

await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: realTarget.x, y: realTarget.y });
await mouse('mousePressed', 1);
await mouse('mouseReleased', 1);
await sleep(40);
await mouse('mousePressed', 2);
await mouse('mouseReleased', 2);
await sleep(400);

const afterReal = await cdp.eval(`({
  count: document.querySelectorAll('.tab').length,
  names: [...document.querySelectorAll('.tab')].map(t => t.querySelector('.tab__name').textContent.trim()),
})`);

check(
  '真实鼠标双击也能关闭（浏览器合成的 dblclick）',
  afterReal.count === realTarget.count - 1 && !afterReal.names.includes(realTarget.name),
  `双击「${realTarget.name}」：${realTarget.count} → ${afterReal.count}，剩 ${afterReal.names.join(' / ')}`,
);

const report = {
  url: APP,
  passed: checks.filter((c) => c.ok).length,
  total: checks.length,
  checks,
  drag,
  menuBox: menuOpen.box,
  screenshots: fs.readdirSync(OUT).filter((f) => f.endsWith('.png')),
};
fs.writeFileSync(path.join(OUT, 'tabs-report.json'), JSON.stringify(report, null, 2));

console.log(`\n结果：${report.passed}/${report.total} 通过`);
cdp.close();
process.exit(report.passed === report.total ? 0 : 1);
