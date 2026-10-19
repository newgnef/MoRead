/**
 * 虚拟化下的搜索定位验证
 *
 * 短文档走的是「全量渲染 + 遍历 DOM 找第 N 次出现」，长文档走的是
 * 「按全文纯文本索引算块号 → 滚动 → 渲染 → 块内精修」。两条路径完全不同，
 * 前面那套测试覆盖不到这里。
 *
 * 用 tools/make-big-doc.mjs 生成的文档做靶子，它的每一节都带一个唯一类名
 * （Section<N>Plugin），于是「能不能定位到第 1000 节」变成一个可断言的命题。
 *
 * 用法（Edge 需以 --remote-debugging-port=9222 打开应用地址）：
 *   node tools/search-virtual.mjs --url <应用地址> --out <报告目录>
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
const FILE = args.file ?? 'big.md';

fs.mkdirSync(OUT, { recursive: true });

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail !== undefined && detail !== null ? `  — ${detail}` : ''}`);
}

/** 输入关键词并等结果稳定 */
async function search(cdp, keyword) {
  await cdp.eval(`(() => {
    const input = document.querySelector('.sp__input input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(keyword)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  await waitFor(cdp, `document.querySelectorAll('.sp .grp').length > 0`, {
    label: `「${keyword}」的结果`, timeoutMs: 20000, intervalMs: 200,
  });
  return cdp.eval(`(() => {
    const g = [...document.querySelectorAll('.sp .grp')]
      .find((x) => x.querySelector('.grp__name')?.textContent === ${JSON.stringify(FILE)});
    if (!g) return null;
    return {
      count: Number(g.querySelector('.grp__count')?.textContent ?? 0),
      hits: [...g.querySelectorAll('.hit')].map((h) => ({
        line: h.querySelector('.hit__ln')?.textContent ?? '',
        text: h.querySelector('.hit__s')?.textContent ?? '',
      })),
    };
  })()`);
}

/** 点第 idx 条命中，返回定位后的状态 */
async function clickHit(cdp, keyword, idx) {
  await search(cdp, keyword);
  const clicked = await cdp.eval(`(() => {
    const g = [...document.querySelectorAll('.sp .grp')]
      .find((x) => x.querySelector('.grp__name')?.textContent === ${JSON.stringify(FILE)});
    const hits = [...g.querySelectorAll('.hit')];
    if (!hits[${idx}]) return { ok: false, total: hits.length };
    hits[${idx}].click();
    return { ok: true, total: hits.length };
  })()`);
  if (!clicked.ok) return { clicked, state: null };

  await sleep(1500);
  const state = await cdp.eval(`(() => {
    const diag = window.__moreadArticle?.read?.() ?? null;
    const sc = document.querySelector('.content');
    const art = document.querySelector('.mr-article');
    const base = sc.getBoundingClientRect();
    const viewH = Math.round(base.height);

    // 视口内可见的标题，用来确认「停在了第几节」
    const heads = [...art.querySelectorAll('h1,h2,h3')]
      .map((h) => ({ t: h.textContent.trim(), top: h.getBoundingClientRect().top - base.top }))
      .filter((h) => h.top > -80 && h.top < base.height);

    /*
      几何定位目标文本。
      注意不能用 innerText 判断「可见」—— 滚动容器的 innerText 会把 overscan
      渲染出来的块也一并返回，那些块其实在视口之外。
    */
    const needle = ${JSON.stringify(keyword)};
    const walker = document.createTreeWalker(art, NodeFilter.SHOW_TEXT);
    let node;
    let target = null;
    let total = 0;

    while ((node = walker.nextNode())) {
      const text = node.textContent ?? '';
      const i = text.indexOf(needle);
      if (i < 0) continue;
      total++;
      if (target) continue;
      const r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, Math.min(i + needle.length, text.length));
      const rect = r.getBoundingClientRect();
      const top = rect.top - base.top;
      target = {
        top: Math.round(top),
        visible: top > -60 && top < base.height - 10,
        ctx: text.slice(Math.max(0, i - 20), i + needle.length + 16).replace(/\\s+/g, ' '),
      };
    }

    return {
      useVirtual: diag?.useVirtual ?? null,
      lastReveal: diag?.lastReveal ?? null,
      blocks: diag?.blocks ?? null,
      renderedEls: diag?.renderedEls ?? null,
      scrollTop: Math.round(sc.scrollTop),
      viewHeight: viewH,
      visibleHeads: heads.map((h) => h.t),
      renderedTargets: total,
      target,
    };
  })()`);
  return { clicked, state };
}

console.log('虚拟化搜索定位 · 端到端验证\n');
console.log(`应用：${APP}\n目标文件：${FILE}\n`);

const cdp = await attach(CDP_BASE, APP);

await waitFor(cdp, `document.querySelectorAll('.trow--file').length > 0`, {
  label: '文件树就绪', timeoutMs: 20000,
});

// 打开右侧搜索栏（默认「所有标签」就够用：目标文档已经打开）
await cdp.eval(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('.icon-btn[aria-label="搜索"]')?.click();
  await wait(320);
  return !!document.querySelector('.sp__input input');
})()`);
await sleep(200);

/* ---------- 1. 深处唯一命中 ---------- */
const DEEP = 'Section1000Plugin';

const r1 = await clickHit(cdp, DEEP, 0);
check(`搜到「${DEEP}」`, r1.clicked.ok, r1.state ? `${r1.clicked.total} 条命中` : JSON.stringify(r1.clicked));

if (r1.state) {
  const s = r1.state;
  check('长文档确实走虚拟化路径', s.useVirtual === true, `blocks=${s.blocks} 渲染元素=${s.renderedEls}`);

  check(
    '点击后滚动位置不在文档开头',
    s.scrollTop > 5000,
    `scrollTop=${s.scrollTop}`,
  );

  check(
    '目标代码在视口内可见',
    s.target?.visible === true,
    s.target ? `top=${s.target.top}px / 视口 ${s.viewHeight}px · ${s.target.ctx}` : '未在渲染范围内找到',
  );

  check(
    '视口内的节标题不早于第 1000 节',
    s.visibleHeads.length > 0 && s.visibleHeads.every((t) => {
      const m = /第\s*(\d+)\s*节/.exec(t);
      return !m || Number(m[1]) >= 1000;
    }),
    s.visibleHeads.join(' | ') || '（视口内无节标题）',
  );

  check(
    '定位记录指向本次点击的序号',
    s.lastReveal?.ordinal === 0 && s.lastReveal?.needle === DEEP,
    JSON.stringify(s.lastReveal),
  );
}

const deepBlock = r1.state?.lastReveal?.block ?? -1;

/* ---------- 2. 同一关键词的多条命中应落在不同块 ---------- */
const MULTI = 'PC-1000';

const r2a = await clickHit(cdp, MULTI, 0);
const r2b = await clickHit(cdp, MULTI, 1);

check(
  `「${MULTI}」在同一节内有多处命中`,
  (r2a.clicked.total ?? 0) >= 2,
  `${r2a.clicked.total} 条`,
);

if (r2a.state && r2b.state) {
  check(
    '第 1 条命中定位到列表项所在块',
    r2a.state.lastReveal?.ordinal === 0,
    `ordinal=${r2a.state.lastReveal?.ordinal} block=${r2a.state.lastReveal?.block}`,
  );
  check(
    '第 2 条命中定位到另一个块',
    r2b.state.lastReveal?.ordinal === 1
      && r2b.state.lastReveal?.block !== r2a.state.lastReveal?.block,
    `ordinal=${r2b.state.lastReveal?.ordinal} block=${r2b.state.lastReveal?.block}`,
  );
  check(
    '两次定位的滚动位置不同',
    r2a.state.scrollTop !== r2b.state.scrollTop,
    `${r2a.state.scrollTop} → ${r2b.state.scrollTop}`,
  );
}

/* ---------- 3. 深处的命中块号应该很大 ---------- */
check(
  '深处命中的块号与文档尺寸相称',
  deepBlock > 1000,
  `block=${deepBlock}`,
);

/* ---------- 截图 ---------- */
try {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'search-virtual.png'), Buffer.from(shot.data, 'base64'));
  console.log(`\n  截图：${path.join(OUT, 'search-virtual.png')}`);
} catch (err) {
  console.log(`\n  截图失败：${err.message}`);
}

const report = {
  url: APP,
  checks,
  passed: checks.filter((c) => c.ok).length,
  total: checks.length,
  sample: { deep: DEEP, multi: MULTI, deepBlock },
};
fs.writeFileSync(path.join(OUT, 'search-virtual-report.json'), JSON.stringify(report, null, 2));

console.log(`\n结果：${report.passed}/${report.total} 通过`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
