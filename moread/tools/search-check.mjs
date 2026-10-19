/**
 * 工作区搜索的端到端验证
 *
 * 光看「搜索框里出现了一堆结果」说明不了什么 —— 真正容易错的是**点击之后**：
 * 命中来自一个尚未打开的文档时，能不能自动打开、并精确滚到那一次出现。
 *
 * 所以测试文档里埋了 5 处「报表A…E」，分散在足够远的距离上，彼此不会同时
 * 落进一屏。点第 4 处，就必须看到「报表D」，且看不到「报表A」——
 * 这条断言能直接抓住「序号算错」或「一律跳到第一次出现」这类问题。
 *
 * 用法（Edge 需以 --remote-debugging-port=9222 打开应用地址）：
 *   node tools/search-check.mjs --url <应用地址> --out <报告目录>
 */

import fs from 'node:fs';
import path from 'node:path';
import { attach, sleep, waitFor } from './cdp.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}

const APP = args.url ?? 'http://127.0.0.1:1420/';
const OUT = args.out ?? '.';
const CDP_BASE = args.cdp ?? 'http://127.0.0.1:9222';
const KEYWORD = args.keyword ?? '报表';
const TARGET_FILE = args.file ?? 'target.md';
/** 期望点击的那一处正文里的上下文标记 */
const WANT = args.want ?? '报表D';
/** 它上面的那一处，用来确认没有「一律跳第一处」 */
const NOT_WANT = args.notWant ?? '报表A';

fs.mkdirSync(OUT, { recursive: true });

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail !== undefined && detail !== null ? `  — ${detail}` : ''}`);
}

/* ------------------------------------------------------------------ */
/* 页面内探针                                                          */
/* ------------------------------------------------------------------ */

/** 读出侧栏的分组结构与命中条目 */
const PROBE_GROUPS = `(() => {
  const groups = [...document.querySelectorAll('.grp')];
  return groups.map((g) => ({
    name: g.querySelector('.grp__name')?.textContent ?? '',
    count: Number(g.querySelector('.grp__count')?.textContent ?? 0),
    current: g.classList.contains('is-current'),
    hits: [...g.querySelectorAll('.hit')].map((h) => ({
      line: h.querySelector('.hit__ln')?.textContent ?? '',
      text: h.querySelector('.hit__s')?.textContent ?? '',
    })),
  }));
})()`;

/** 统计「几何上确实落在视口内」的关键词出现，避免被 overscan 渲染的块干扰 */
const probeVisible = (needle) => `(() => {
  const sc = document.querySelector('.content');
  const art = document.querySelector('.mr-article');
  if (!sc || !art) return { error: '正文未就绪' };

  const base = sc.getBoundingClientRect();
  const pin = ${JSON.stringify(needle)}.toLowerCase();
  const walker = document.createTreeWalker(art, NodeFilter.SHOW_TEXT);
  const seen = [];
  let node;

  while ((node = walker.nextNode())) {
    const text = node.textContent ?? '';
    const low = text.toLowerCase();
    let from = 0;
    for (;;) {
      const i = low.indexOf(pin, from);
      if (i < 0) break;
      const r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, Math.min(i + pin.length, text.length));
      const rect = r.getBoundingClientRect();
      const top = rect.top - base.top;
      // 允许一点余量：定位后目标是「靠近视口顶部」而不是精确贴边
      if (top > -70 && top < base.height + 30) {
        seen.push({
          top: Math.round(top),
          ctx: text.slice(Math.max(0, i - 8), i + pin.length + 2),
        });
      }
      from = i + pin.length;
    }
  }
  return { viewHeight: Math.round(base.height), hits: seen };
})()`;

/* ------------------------------------------------------------------ */

console.log('工作区搜索 · 端到端验证\n');
console.log(`应用：${APP}\n关键词：${KEYWORD}\n`);

const cdp = await attach(CDP_BASE, APP);

/* 1. 应用就绪 */
await waitFor(cdp, `document.querySelectorAll('.trow--file').length > 0`, {
  label: '文件树就绪', timeoutMs: 20000,
});
const tree = await cdp.eval(`(() => ({
  files: document.querySelectorAll('.trow--file').length,
  tabs: document.querySelectorAll('.tab').length,
  active: document.querySelector('.tab--active .tab__name')?.textContent ?? '',
}))()`);
check('工作区文件树已加载', tree.files > 0, `${tree.files} 篇文档`);

/* 2. 打开右侧搜索栏，并切到「工作区」—— 本用例要搜的正是还没打开的那篇 */
const switched = await cdp.eval(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const btn = document.querySelector('.icon-btn[aria-label="搜索"]');
  if (!btn) return false;
  btn.click();
  await wait(320);
  const ws = [...document.querySelectorAll('.sp__scope')].find((b) => b.textContent.trim() === '工作区');
  if (!ws) return false;
  ws.click();
  await wait(320);
  return true;
})()`);
check('打开右侧搜索栏并切到「工作区」', switched);
await sleep(250);

/* 3. 输入关键词 */
await cdp.eval(`(() => {
  const input = document.querySelector('.sp__input input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(KEYWORD)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input.value;
})()`);

await waitFor(cdp, `document.querySelectorAll('.sp .grp').length > 0`, {
  label: '搜索结果出现', timeoutMs: 10000, intervalMs: 150,
});

const groups = await cdp.eval(PROBE_GROUPS);
const totalHits = groups.reduce((n, g) => n + g.hits.length, 0);

check('返回了跨文件的分组结果', groups.length >= 3, `${groups.length} 个文件 · ${totalHits} 条命中`);
check(
  '当前打开的文档被排到最前并标记',
  groups[0]?.current === true,
  `${groups[0]?.name}${groups[0]?.current ? '（当前）' : ''}`,
);

const target = groups.find((g) => g.name === TARGET_FILE);
check(`结果里含 ${TARGET_FILE}`, !!target, target ? `${target.hits.length} 条展示 / 共 ${target.count} 处` : '缺失');

/* 4. 断言未打开的文档确实还没打开 */
const beforeTabs = await cdp.eval(`[...document.querySelectorAll('.tab__name')].map((e) => e.textContent)`);
check(
  `${TARGET_FILE} 点击前尚未打开`,
  !beforeTabs.includes(TARGET_FILE),
  `已打开：${beforeTabs.join(' / ')}`,
);

/* 5. 点击「报表D」那一条命中 */
const clicked = await cdp.eval(`(() => {
  const g = [...document.querySelectorAll('.grp')]
    .find((x) => x.querySelector('.grp__name')?.textContent === ${JSON.stringify(TARGET_FILE)});
  if (!g) return { ok: false, reason: '找不到目标文件分组' };

  const hit = [...g.querySelectorAll('.hit')]
    .find((h) => h.textContent.includes(${JSON.stringify(WANT)}));
  if (!hit) return { ok: false, reason: 'no-matching-hit', seen: [...g.querySelectorAll('.hit')].map(h=>h.textContent.trim().slice(0,30)) };

  hit.click();
  return { ok: true };
})()`);
check(`点击「${WANT}」所在的那条命中`, clicked.ok, clicked.ok ? null : JSON.stringify(clicked));

await sleep(1200);

/* 6. 断言文件被打开 + 定位准确 */
const after = await cdp.eval(`(() => ({
  tabs: [...document.querySelectorAll('.tab__name')].map((e) => e.textContent),
  active: document.querySelector('.tab--active .tab__name')?.textContent ?? '',
  h1: document.querySelector('.mr-article h1')?.textContent ?? '',
  diag: window.__moreadArticle?.read?.() ?? null,
}))()`);

check('未打开的文件被自动打开', after.tabs.includes(TARGET_FILE), `已打开：${after.tabs.join(' / ')}`);
check('且成为当前标签', after.active === TARGET_FILE, `当前：${after.active}`);
check('正文换成了目标文档', after.h1 === '定位验证', `h1 = ${after.h1}`);

const reveal = after.diag?.lastReveal;
check(
  '定位用的是点击那一条的序号',
  reveal && reveal.ordinal === 5,
  reveal ? `needle=${reveal.needle} ordinal=${reveal.ordinal} block=${reveal.block}` : '没有定位记录',
);

const visible = await cdp.eval(probeVisible('报表'));
const ctxs = (visible.hits ?? []).map((h) => h.ctx);
check(
  `视口内出现「${WANT}」`,
  ctxs.some((c) => c.includes(WANT)),
  `视口内命中：${ctxs.length ? ctxs.map((c) => c.replace(/\s+/g, '')).join(' | ') : '（无）'}`,
);
check(
  `视口内没有「${NOT_WANT}」—— 确认不是跳到了第一处`,
  !ctxs.some((c) => c.includes(NOT_WANT)),
  `视口高度 ${visible.viewHeight}px`,
);

/* 7. 截图留档 */
try {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'search-jump.png'), Buffer.from(shot.data, 'base64'));
  console.log(`\n  截图：${path.join(OUT, 'search-jump.png')}`);
} catch (err) {
  console.log(`\n  截图失败：${err.message}`);
}

/* ------------------------------------------------------------------ */

const report = {
  url: APP,
  keyword: KEYWORD,
  groups,
  checks,
  passed: checks.filter((c) => c.ok).length,
  total: checks.length,
};
fs.writeFileSync(path.join(OUT, 'search-report.json'), JSON.stringify(report, null, 2));

console.log(`\n结果：${report.passed}/${report.total} 通过`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
