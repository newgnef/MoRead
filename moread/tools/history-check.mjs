/**
 * 历史列表验证：排序 / 打开 / 缺失置灰 / 启动时校验 / 清空 / 持久化
 *
 * 用法：
 *   node tools/history-check.mjs [--width 1200] [--out <目录>]
 *
 * 自建一份独立工作区（从 moread-ws-tabs 拷 5 篇），因为本测试要**真的删掉**
 * 其中一篇来验证置灰 —— 复用公共工作区会把别的测试的素材也删了。
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
const PORT = Number(args.port ?? 9241);
const CDP_BASE = `http://127.0.0.1:${PORT}`;
const WIDTH = Number(args.width ?? 1200);
const HEIGHT = Number(args.height ?? 800);
const SRC = args.src ?? `${TMP}/moread-ws-tabs`;
const WS = args.ws ?? `${TMP}/moread-ws-history`;
const OUT = args.out ?? `${TMP}/moread-history`;
const APP = `http://127.0.0.1:1420/?theme=light&nowatch=1&ws=${encodeURIComponent(WS)}`;

fs.mkdirSync(OUT, { recursive: true });

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `   ${String(detail).slice(0, 170)}` : ''}`);
}

/* ---------------- 独立工作区 ---------------- */
fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(WS, { recursive: true });
const NAMES = ['doc-1.md', 'doc-2.md', 'doc-3.md', 'doc-4.md', 'doc-5.md'];
for (const n of NAMES) {
  const from = path.join(SRC, n);
  const body = fs.existsSync(from)
    ? fs.readFileSync(from)
    : `# ${n}\n\n这是历史测试用的文档，内容随便写一点。\n`;
  fs.writeFileSync(path.join(WS, n), body);
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
  '--headless=old', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--disable-sync',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  `--window-size=${WIDTH},${HEIGHT}`, 'about:blank',
], { stdio: 'ignore' });

const STATE = `(() => {
  const rows = [...document.querySelectorAll('.hist')];
  return {
    count: rows.length,
    emptyText: document.querySelector('.sidebar .empty__t')?.textContent.trim() ?? '',
    activeTab: document.querySelector('.tab--active .tab__name')?.textContent.trim() ?? '',
    tabCount: document.querySelectorAll('.tab').length,
    items: rows.map((r) => ({
      name: r.querySelector('.hist__name')?.textContent.trim() ?? '',
      parent: r.querySelector('.hist__parent')?.textContent.trim() ?? '',
      time: r.querySelector('.hist__time')?.textContent.trim() ?? '',
      tag: r.querySelector('.hist__tag')?.textContent.trim() ?? '',
      missing: r.classList.contains('is-missing'),
      disabled: r.disabled,
      current: r.classList.contains('is-current'),
    })),
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
  await cdp.send('Storage.clearDataForOrigin', {
    origin: 'http://127.0.0.1:1420', storageTypes: 'local_storage',
  });
  await cdp.send('Page.navigate', { url: APP });
  await waitFor(cdp, `!!document.querySelector('.sidebar')`, { timeoutMs: 60000, label: '侧栏' });
  await sleep(600);

  async function shot(name, clip) {
    const params = { format: 'png' };
    if (clip) params.clip = { ...clip, scale: 1 };
    const { data } = await cdp.send('Page.captureScreenshot', params);
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  async function toHistory() {
    await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      [...document.querySelectorAll('.sidebar__tab')].find(b => b.textContent.trim() === '历史')?.click();
      await wait(450);
    })()`);
    await sleep(250);
  }

  async function toFiles() {
    await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      [...document.querySelectorAll('.sidebar__tab')].find(b => b.textContent.trim() === '文件')?.click();
      await wait(300);
    })()`);
  }

  /* ---------------- 1. 侧栏的三个页签 ---------------- */
  const modes = await cdp.eval(`[...document.querySelectorAll('.sidebar__tab')].map(b => b.textContent.trim())`);
  check('侧栏页签变成 大纲 / 文件 / 历史（大纲第一）',
    JSON.stringify(modes) === JSON.stringify(['大纲', '文件', '历史']), JSON.stringify(modes));
  check('侧栏里已经没有搜索入口', await cdp.eval(`!document.querySelector('.search-input')`));

  /* ---------------- 2. 打开 5 篇，攒出历史 ---------------- */
  const opened = await cdp.eval(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const names = ${JSON.stringify(NAMES)};
    for (const n of names) {
      const row = [...document.querySelectorAll('.trow--file')].find(r => r.textContent.includes(n));
      if (row) row.click();
      await wait(420);
    }
    return document.querySelectorAll('.tab').length;
  })()`);
  check('5 篇都打开了（每篇一个标签）', opened >= 5, `标签数 ${opened}`);

  await toHistory();
  const list = await cdp.eval(STATE);
  check('历史列出了刚打开的 5 篇', list.items.filter((i) => !i.missing).length >= 5,
    `${list.count} 条：${list.items.map((i) => i.name).join(' / ')}`);
  check('最近打开的排最前', list.items[0]?.name === 'doc-5.md', `第一项 ${list.items[0]?.name}`);
  check('每一项都带父目录', list.items.every((i) => i.parent.length > 0),
    list.items.map((i) => i.parent).join(' | ').slice(0, 90));
  check('每一项都带相对时间', list.items.every((i) => i.time.length > 0),
    list.items.map((i) => i.time).join(' | '));
  check('当前打开的那篇被标出来', list.items.some((i) => i.current), 'is-current');
  check('目录记录没有混进历史（只有文件）',
    list.items.every((i) => /\.md$/.test(i.name)), list.items.map((i) => i.name).join(','));

  await shot('history-normal.png', { x: 0, y: 0, width: 420, height: 340 });

  /* ---------------- 3. 删掉一篇 → 刷新 → 应该已经灰了 ---------------- */
  const gone = path.join(WS, 'doc-3.md');
  fs.rmSync(gone, { force: true });

  await cdp.send('Page.reload');
  await waitFor(cdp, `!!document.querySelector('.sidebar')`, { timeoutMs: 60000, label: '重载' });
  await sleep(900); // 给启动时的探测留出时间
  await toHistory();

  const afterDelete = await cdp.eval(STATE);
  const dead = afterDelete.items.find((i) => i.name === 'doc-3.md');
  check('被删的那篇还在列表里（不是直接消失）', !!dead, `找到 ${!!dead}`);
  check('被删的那篇标为 is-missing', !!dead?.missing);
  check('被删的那篇不可点击（disabled）', dead?.disabled === true);
  check('被删的那篇显示"已不存在"', dead?.tag === '已不存在', dead?.tag ?? '(无)');
  check('其余条目仍然可点', afterDelete.items.filter((i) => !i.missing).every((i) => !i.disabled));

  await shot('history-missing.png', { x: 0, y: 0, width: 420, height: 340 });

  /* ---------------- 4. 点灰项没有反应 ---------------- */
  const beforeClick = await cdp.eval(STATE);
  await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('.hist')].find(r => r.textContent.includes('doc-3.md'));
    row?.click();
  })()`);
  await sleep(400);
  const afterClick = await cdp.eval(STATE);
  check('点被删的那一项不会打开任何东西',
    afterClick.tabCount === beforeClick.tabCount && afterClick.activeTab === beforeClick.activeTab,
    `${beforeClick.tabCount}→${afterClick.tabCount} 标签，当前 ${afterClick.activeTab}`);

  /* ---------------- 5. 点可用项 → 切到那篇 ---------------- */
  const targetName = (await cdp.eval(STATE)).items.find((i) => !i.missing && !i.current)?.name;
  await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('.hist')].find(r => !r.classList.contains('is-missing') && !r.classList.contains('is-current'));
    row?.click();
  })()`);
  await sleep(700);
  const afterOpen = await cdp.eval(STATE);
  check('点历史条目会切到那篇文档', afterOpen.activeTab === targetName,
    `点了 ${targetName}，当前 ${afterOpen.activeTab}`);

  /* ---------------- 6. 清空 ---------------- */
  await cdp.eval(`document.querySelector('.hist-bar__clear').click()`);
  await sleep(400);
  const cleared = await cdp.eval(STATE);
  check('清空后一条都不剩', cleared.count === 0, `${cleared.count} 条`);
  check('清空后给出空态说明', cleared.emptyText.includes('还没有打开过'), cleared.emptyText);

  const storedAfterClear = await cdp.eval(`localStorage.getItem('moread.recents')`);
  check('清空立刻写回 localStorage', storedAfterClear === '[]', String(storedAfterClear));

  await cdp.send('Page.reload');
  await waitFor(cdp, `!!document.querySelector('.sidebar')`, { timeoutMs: 60000, label: '重载' });
  await sleep(600);
  await toHistory();
  const persisted = await cdp.eval(STATE);
  /*
    刷新后会多出一篇 —— 那是重开工作区时自动打开的第一篇，属于"真的打开过"。
    所以判据是"旧的 5 条没有回来"，而不是"一定是 0 条"。
  */
  check('刷新后旧记录没有回来（只剩自动打开的那篇）',
    persisted.count <= 1 && !persisted.items.some((i) => i.name === 'doc-3.md'),
    `${persisted.count} 条：${persisted.items.map((i) => i.name).join(',')}`);

  /* ---------------- 7. 默认页签：大纲 ---------------- */
  /*
    模拟一次真实启动：URL 上不带 ?ws，只把工作区留在 localStorage 里让它自己恢复。
    带 ?ws 是"显式指定目录"，按约定直接落到文件树，代表不了默认行为。
  */
  await cdp.eval(`localStorage.setItem('moread.workspace', ${JSON.stringify(WS)})`);
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:1420/?theme=light&nowatch=1' });
  await waitFor(cdp, `!!document.querySelector('.sidebar')`, { timeoutMs: 60000, label: '恢复会话' });
  await sleep(1000);

  const boot = await cdp.eval(`(() => ({
    tabs: [...document.querySelectorAll('.sidebar__tab')].map(b => b.textContent.trim()),
    active: document.querySelector('.sidebar__tab.is-active')?.textContent.trim() ?? '',
    hasTree: !!document.querySelector('.trow--file'),
    outlineRows: document.querySelectorAll('.outline-item').length,
  }))()`);
  check('页签顺序是 大纲 / 文件 / 历史',
    JSON.stringify(boot.tabs) === JSON.stringify(['大纲', '文件', '历史']), JSON.stringify(boot.tabs));
  check('恢复上次会话后默认停在大纲', boot.active === '大纲', boot.active);
  check('默认不铺文件树（那是文件页签的内容）', !boot.hasTree);
  check('大纲里已经有条目（自动打开的那篇）', boot.outlineRows > 0, `${boot.outlineRows} 行`);

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
