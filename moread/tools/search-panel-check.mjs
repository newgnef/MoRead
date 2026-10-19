/**
 * 右侧搜索栏验证：开合 / 三档范围 / 结果跳转 / 快捷键 / 偏好持久化
 *
 * 用法：
 *   node tools/search-panel-check.mjs [--width 1280] [--out <目录>]
 *
 * 自建工作区，故意留一篇**不打开**的 hidden.md：
 * 只有它能区分"所有标签"（2 篇）与"工作区"（3 篇），
 * 否则这三档看起来一模一样，测了等于没测。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { attach, sleep, waitFor } from './cdp.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}

const TMP = os.tmpdir().replace(/\\/g, '/');
const PORT = Number(args.port ?? 9242);
const CDP_BASE = `http://127.0.0.1:${PORT}`;
const WIDTH = Number(args.width ?? 1280);
const HEIGHT = Number(args.height ?? 820);
const WS = args.ws ?? `${TMP}/moread-ws-search`;
const OUT = args.out ?? `${TMP}/moread-search-panel`;
const BASE = 'http://127.0.0.1:1420/';
const APP = `${BASE}?theme=light&nowatch=1&ws=${encodeURIComponent(WS)}`;

fs.mkdirSync(OUT, { recursive: true });

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `   ${String(detail).slice(0, 170)}` : ''}`);
}

/* ---------------- 工作区：两篇打开 + 一篇藏着 ---------------- */
fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(WS, { recursive: true });
const KEY = '复卷上机';
fs.writeFileSync(path.join(WS, 'doc-a.md'),
  `# 甲文档\n\n${KEY}之前要先核对母卷的批次号。\n\n另一段也提到${KEY}的条件。\n`);
fs.writeFileSync(path.join(WS, 'doc-b.md'),
  `# 乙文档\n\n这份只出现一次${KEY}，用来区分命中数。\n`);
fs.writeFileSync(path.join(WS, 'hidden.md'),
  `# 藏着的那篇\n\n${KEY}在这里出现，但这份文档没有被打开。\n`);

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
  '--headless=old', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--disable-sync',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  `--window-size=${WIDTH},${HEIGHT}`, 'about:blank',
], { stdio: 'ignore' });

const STATE = `(() => {
  const sp = document.querySelector('.sp');
  const art = document.querySelector('.mr-article');
  const active = document.querySelector('.sp__scope.is-active')?.textContent.trim() ?? '';
  const groups = [...document.querySelectorAll('.sp .grp__name')].map(n => n.textContent.trim());
  return {
    open: !!sp,
    spW: sp ? Math.round(sp.getBoundingClientRect().width) : 0,
    artW: art ? Math.round(art.getBoundingClientRect().width) : 0,
    scope: active,
    scopes: [...document.querySelectorAll('.sp__scope')].map(b => ({
      label: b.textContent.trim(), disabled: b.disabled, active: b.classList.contains('is-active'),
    })),
    groups,
    hits: document.querySelectorAll('.sp .hit').length,
    meta: (document.querySelector('.sp__meta')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
    tabCount: document.querySelectorAll('.tab').length,
    activeTab: document.querySelector('.tab--active .tab__name')?.textContent.trim() ?? '',
    focused: document.activeElement?.tagName === 'INPUT'
      && document.activeElement.closest('.sp__input') !== null,
  };
})()`;

let cdp;
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${CDP_BASE}/json/version`)).ok) break; } catch { /* 还没起来 */ }
    await sleep(150);
  }

  cdp = await attach(CDP_BASE, 'about:blank');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false,
  });
  await cdp.send('Storage.clearDataForOrigin', { origin: BASE.replace(/\/$/, ''), storageTypes: 'local_storage' });
  await cdp.send('Page.navigate', { url: APP });
  await waitFor(cdp, `!!document.querySelector('.sidebar')`, { timeoutMs: 60000, label: '侧栏' });
  await sleep(700);

  async function shot(name, clip) {
    const params = { format: 'png' };
    if (clip) params.clip = { ...clip, scale: 1 };
    const { data } = await cdp.send('Page.captureScreenshot', params);
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  /* ---------------- 1. 打开另外两篇（hidden 保持未打开） ---------------- */
  const opened = await cdp.eval(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    for (const n of ['doc-a.md', 'doc-b.md']) {
      const row = [...document.querySelectorAll('.trow--file')].find(r => r.textContent.includes(n));
      row?.click();
      await wait(450);
    }
    return {
      tabs: [...document.querySelectorAll('.tab__name')].map(t => t.textContent.trim()),
      active: document.querySelector('.tab--active .tab__name')?.textContent.trim() ?? '',
    };
  })()`);
  check('打开两篇（第三篇 hidden.md 留在磁盘上不打开）',
    opened.tabs.includes('doc-a.md') && opened.tabs.includes('doc-b.md') && !opened.tabs.includes('hidden.md'),
    JSON.stringify(opened.tabs));

  const before = await cdp.eval(STATE);
  check('默认不展开搜索栏', !before.open);
  check('默认正文是 680 的标准列宽', Math.abs(before.artW - 680) <= 1, `${before.artW}px`);

  /* ---------------- 2. 点放大镜打开右侧栏 ---------------- */
  await cdp.eval(`document.querySelector('.icon-btn[aria-label="搜索"]').click()`);
  await sleep(400);
  const openState = await cdp.eval(STATE);
  check('点放大镜出现右侧栏', openState.open);
  check('右侧栏宽度在 260–340 之间（按 34vw 收）',
    openState.spW >= 260 && openState.spW <= 341, `${openState.spW}px`);
  check('右侧栏占位后正文自动收窄，不再被裁', openState.artW < before.artW,
    `${before.artW} → ${openState.artW}px`);
  check('打开后输入框自动聚焦', openState.focused);
  check('默认范围是「所有标签」', openState.scope === '所有标签', openState.scope);
  check('三档范围都在，工作区可选',
    JSON.stringify(openState.scopes.map((s) => s.label)) === JSON.stringify(['当前标签', '所有标签', '工作区'])
    && openState.scopes.every((s) => !s.disabled),
    JSON.stringify(openState.scopes));

  /* ---------------- 3. 三个范围的差异 ---------------- */
  const search = async () => {
    await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const input = document.querySelector('.sp__input input');
      input.value = ${JSON.stringify(KEY)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(700);
    })()`);
    await sleep(200);
    return cdp.eval(STATE);
  };

  const tabsScope = await search();
  check('「所有标签」只在已打开的两篇里命中',
    tabsScope.groups.length === 2 && !tabsScope.groups.includes('hidden.md'),
    `${tabsScope.groups.join(' / ')} · ${tabsScope.hits} 处`);

  await cdp.eval(`[...document.querySelectorAll('.sp__scope')].find(b => b.textContent.trim() === '当前标签').click()`);
  await sleep(500);
  const activeScope = await cdp.eval(STATE);
  check('「当前标签」只出当前这一篇', activeScope.groups.length === 1 && activeScope.groups[0] === 'doc-b.md',
    `${activeScope.groups.join(' / ')} · 当前 ${activeScope.activeTab}`);

  await cdp.eval(`[...document.querySelectorAll('.sp__scope')].find(b => b.textContent.trim() === '工作区').click()`);
  await sleep(900);
  const wsScope = await cdp.eval(STATE);
  check('「工作区」会把没打开的 hidden.md 也搜出来',
    wsScope.groups.includes('hidden.md') && wsScope.groups.length === 3,
    `${wsScope.groups.join(' / ')} · ${wsScope.meta}`);
  check('工作区范围的状态行给出扫描篇数', /扫描 \d+ 篇/.test(wsScope.meta), wsScope.meta);

  await shot('search-workspace.png');
  await shot('search-panel.png', { x: WIDTH - 350, y: 0, width: 350, height: 420 });

  /* ---------------- 4. 点命中 → 打开未打开的那篇 ---------------- */
  const jumped = await cdp.eval(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const grp = [...document.querySelectorAll('.sp .grp')].find(g => g.textContent.includes('hidden.md'));
    grp?.querySelector('.hit')?.click();
    await wait(1200);
    return {
      tabs: document.querySelectorAll('.tab').length,
      active: document.querySelector('.tab--active .tab__name')?.textContent.trim() ?? '',
      scrollTop: Math.round(document.querySelector('.content')?.scrollTop ?? 0),
    };
  })()`);
  check('点未打开文档的命中会把它打开', jumped.active === 'hidden.md' && jumped.tabs === 3,
    `当前 ${jumped.active}，${jumped.tabs} 个标签`);

  /*
    点完之后结果列表不能重排。
    这里点的是排在最后的 hidden.md，如果还有「当前文档置顶」那套逻辑，
    它会瞬间跳到第一位 —— 用户正要点第二条时目标就换地方了。
  */
  const afterJump = await cdp.eval(STATE);
  check('跳转后结果顺序不变（当前文档不置顶）',
    JSON.stringify(afterJump.groups) === JSON.stringify(wsScope.groups),
    `${wsScope.groups.join(' / ')} → ${afterJump.groups.join(' / ')}`);
  check('当前文档改用高亮标出，位置仍在原处',
    await cdp.eval(`(() => {
      const cur = document.querySelector('.sp .grp.is-current .grp__name');
      return cur?.textContent.trim() === 'hidden.md'
        && [...document.querySelectorAll('.sp .grp__name')].indexOf(cur) === 2;
    })()`),
    afterJump.groups.join(' / '));

  /* ---------------- 5. 收起 → 正文回宽 ---------------- */
  await cdp.eval(`document.querySelector('.sp__fold').click()`);
  await sleep(400);
  const closed = await cdp.eval(STATE);
  check('收起按钮能关掉右侧栏', !closed.open);
  check('收起后正文恢复到标准列宽', Math.abs(closed.artW - 680) <= 1, `${closed.artW}px`);

  /* ---------------- 6. 快捷键 ---------------- */
  const key = async (k, code, vk, modifiers = 2) => {
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', {
        type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers,
      });
    }
    await sleep(280);
  };

  await key('f', 'KeyF', 70);
  const byKey = await cdp.eval(STATE);
  check('Ctrl+F 打开右侧栏并聚焦输入框', byKey.open && byKey.focused);

  // Esc：有内容先清空，再按才关
  await search();
  await key('Escape', 'Escape', 27, 0);
  const esc1 = await cdp.eval(STATE);
  check('第一次 Esc 只清空关键词，不关面板', esc1.open && (await cdp.eval(`!document.querySelector('.sp__input input').value`)));

  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(300);
  check('关键词已空时再按 Esc 关掉搜索栏', !(await cdp.eval(STATE)).open);

  /* ---------------- 7. 范围偏好持久化 ---------------- */
  await cdp.eval(`document.querySelector('.icon-btn[aria-label="搜索"]').click()`);
  await sleep(300);
  await cdp.eval(`[...document.querySelectorAll('.sp__scope')].find(b => b.textContent.trim() === '工作区').click()`);
  await sleep(300);
  await cdp.send('Page.reload');
  await waitFor(cdp, `!!document.querySelector('.sidebar')`, { timeoutMs: 60000, label: '重载' });
  await sleep(700);
  await cdp.eval(`document.querySelector('.icon-btn[aria-label="搜索"]').click()`);
  await sleep(400);
  const remembered = await cdp.eval(STATE);
  check('刷新后仍记得上次选的范围', remembered.scope === '工作区', remembered.scope);

  /* ---------------- 8. 没有工作区时「工作区」不可选 ---------------- */
  await cdp.send('Storage.clearDataForOrigin', { origin: BASE.replace(/\/$/, ''), storageTypes: 'local_storage' });
  await cdp.send('Page.navigate', { url: `${BASE}?theme=light&nowatch=1` });
  await waitFor(cdp, `!!document.querySelector('.empty') || !!document.querySelector('.mr-article')`,
    { timeoutMs: 60000, label: '空态' });
  await sleep(600);
  await cdp.eval(`document.querySelector('.icon-btn[aria-label="搜索"]').click()`);
  await sleep(400);
  const noWs = await cdp.eval(STATE);
  const wsBtn = noWs.scopes.find((s) => s.label === '工作区');
  check('无工作区时「工作区」这一档置灰', wsBtn?.disabled === true, JSON.stringify(noWs.scopes));
  check('范围自动落到标签搜索', noWs.scope !== '工作区', noWs.scope);

  const fails = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - fails.length}/${checks.length} 通过`);
  if (fails.length) console.log(fails.map((f) => `  ✗ ${f.name}  ${f.detail}`).join('\n'));
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({
    width: WIDTH, total: checks.length, failed: fails.length, checks,
  }, null, 2));
  console.log(`插图与报告：${OUT}`);
  process.exitCode = fails.length ? 1 : 0;
} finally {
  try { cdp?.close(); } catch { /* 忽略 */ }
  proc.kill();
}
