#!/usr/bin/env node
/**
 * 长文档性能验证
 *
 * 虚拟滚动这种东西不能靠"看着挺流畅"来验收，必须把「全量渲染」和
 * 「虚拟滚动」放在同一篇文档上跑同一套测量，用数字对比。
 *
 * 测量项：
 *   1. 打开耗时 —— Page.navigate 到正文出现
 *   2. DOM 节点总数 —— 虚拟化最直接的证据
 *   3. 连续滚动 90 帧的帧间隔（中位 / p95 / 最差）
 *   4. 是否真的滚到了文档末尾（防止 spacer 算错导致滚不到底）
 *
 * 用法：
 *   node tools/perf-check.mjs --url <应用地址> --out <结果目录> [--cdp http://127.0.0.1:9222]
 *
 * 前置：Edge 以 --remote-debugging-port=9222 启动，初始停在 about:blank。
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
/** 文档总节数，用来判断「拖到底能不能看到最后一节」 */
const SECTIONS = Number(args.sections ?? 0);

/* ------------------------------------------------------------------ */
/* 页面内测量脚本                                                      */
/* ------------------------------------------------------------------ */

const PROBE_STATS = `(() => ({
  nodes: document.querySelectorAll('*').length,
  renderedBlocks: document.querySelector('.mr-article')?.children.length ?? -1,
  scrollHeight: document.querySelector('.content')?.scrollHeight ?? -1,
  virtual: !!document.querySelector('.mr-article')?.style.paddingTop,
  highlighted: document.querySelectorAll('.mr-codeblock .shiki').length,
  pendingCode: document.querySelectorAll('pre.mr-code-pending').length,
  inner: window.__moreadArticle?.read?.() ?? null,
}))()`;

const PROBE_SCROLL = `(async () => {
  const sc = document.querySelector('.content');
  const art = document.querySelector('.mr-article');
  if (!sc || !art) return { error: '正文未就绪' };

  sc.scrollTop = 0;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const max = sc.scrollHeight - sc.clientHeight;
  const STEPS = 90;
  const step = Math.max(1, max / STEPS);
  const frames = [];
  let last = performance.now();
  let i = 0;

  await new Promise((resolve) => {
    function tick() {
      const now = performance.now();
      frames.push(now - last);
      last = now;
      sc.scrollTop = Math.min(max, (i + 1) * step);
      i++;
      if (i < STEPS) requestAnimationFrame(tick);
      else resolve();
    }
    requestAnimationFrame(tick);
  });

  // 丢掉第一帧：它含首次布局的开销，不代表稳态
  const f = frames.slice(1).sort((a, b) => a - b);
  const q = (p) => f[Math.min(f.length - 1, Math.floor(f.length * p))];

  // 再拖一次到底：虚拟化下逐块修正会让文档变长，需要验证「吸附」是否奏效
  for (let k = 0; k < 3; k++) {
    sc.scrollTop = sc.scrollHeight - sc.clientHeight;
    await new Promise((r) => setTimeout(r, 260));
  }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const secs = [...art.querySelectorAll('h2')]
    .map((e) => Number((e.textContent.match(/第 (\\d+) 节/) ?? [])[1]))
    .filter((n) => Number.isFinite(n));

  return {
    frames: f.length,
    medianMs: +q(0.5).toFixed(2),
    p95Ms: +q(0.95).toFixed(2),
    worstMs: +f[f.length - 1].toFixed(2),
    fpsFromMedian: +(1000 / Math.max(0.01, q(0.5))).toFixed(1),
    renderedBlocks: art.children.length,
    scrollHeight: sc.scrollHeight,
    reachedEnd: sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4,
    lastSectionVisible: secs.length ? Math.max(...secs) : -1,
    nodes: document.querySelectorAll('*').length,
  };
})()`;

/** 切到大纲页签再跳转：侧栏默认停在「文件」页 */
const PROBE_OUTLINE_JUMP = `(async () => {
  const tabs = [...document.querySelectorAll('.sidebar__tab')];
  const outlineTab = tabs.find((t) => t.textContent.trim() === '大纲');
  if (!outlineTab) return { ok: false, reason: '找不到大纲页签' };
  outlineTab.click();
  await new Promise((r) => setTimeout(r, 300));

  const items = [...document.querySelectorAll('.outline-item')];
  if (items.length < 5) return { ok: false, reason: '大纲项太少：' + items.length };

  // 取中段的一项：末尾项贴近文档底部，会被「贴底」逻辑干扰，测不准跳转本身
  const target = items[Math.floor(items.length * 0.6)];
  const label = target.textContent.trim();
  target.click();

  const sc = document.querySelector('.content');
  const art = document.querySelector('.mr-article');

  // 跳转是平滑滚动，轮询等它稳定
  let delta = NaN;
  const deadline = performance.now() + 4500;
  while (performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 120));
    const h = [...art.querySelectorAll('h1[id],h2[id],h3[id]')]
      .find((e) => e.textContent.trim() === label);
    if (!h) continue;
    delta = h.getBoundingClientRect().top - sc.getBoundingClientRect().top;
    if (Math.abs(delta) < 60) break;
  }

  return {
    ok: Number.isFinite(delta) && Math.abs(delta) < 140,
    label,
    delta: Number.isFinite(delta) ? +delta.toFixed(1) : null,
    renderedBlocks: art.children.length,
    outlineCount: items.length,
  };
})()`;

/* ------------------------------------------------------------------ */
/* 单轮测量                                                            */
/* ------------------------------------------------------------------ */

async function measure(cdp, label, url, { timeoutMs = 120000 } = {}) {
  console.log(`\n── ${label} ─────────────────────────────`);

  const t0 = Date.now();
  await cdp.send('Page.navigate', { url });

  let openMs = -1;
  try {
    await waitFor(cdp, `!!document.querySelector('.mr-article')`, {
      timeoutMs, intervalMs: 100, label: `${label} 正文出现`,
    });
    openMs = Date.now() - t0;
  } catch (err) {
    return { label, failed: true, error: err.message, openMs: Date.now() - t0 };
  }

  // 等估高被实测修正、首屏稳定
  await sleep(1200);

  const stats = await cdp.eval(PROBE_STATS);
  const scroll = await cdp.eval(PROBE_SCROLL);
  const outline = await cdp.eval(PROBE_OUTLINE_JUMP);

  const result = { label, openMs, ...stats, scroll, outline };
  console.log(`   打开耗时        ${openMs} ms`);
  console.log(`   DOM 节点总数    ${stats.nodes}`);
  console.log(`   渲染的块数      ${stats.renderedBlocks}`);
  console.log(`   文档总高        ${stats.scrollHeight} px`);
  console.log(`   滚动帧中位      ${scroll.medianMs} ms（≈ ${scroll.fpsFromMedian} fps）`);
  console.log(`   滚动帧 p95      ${scroll.p95Ms} ms ／ 最差 ${scroll.worstMs} ms`);
  console.log(`   能滚到末尾      ${scroll.reachedEnd}`);
  console.log(`   已高亮的代码块  ${stats.highlighted}（待高亮 ${stats.pendingCode}）`);
  console.log(`   末尾可见到第    ${scroll.lastSectionVisible} 节${SECTIONS ? ` / 共 ${SECTIONS} 节` : ''}`);
  if (stats.inner) {
    const i = stats.inner;
    console.log(`   [内部] 块 ${i.blocks}｜区间 ${i.range.start}–${i.range.end}｜DOM ${i.renderedEls}｜已实测 ${i.measured}｜已校准 ${i.calibrated}`);
    console.log(`   [内部] 估算总高 ${Math.round(i.totalHeight)} px`);
  }
  console.log(`   大纲跳转到「${outline.label ?? '—'}」  ${outline.ok ? '成功' : '失败'}${outline.delta !== null && outline.delta !== undefined ? `（偏差 ${outline.delta} px）` : ''}${outline.reason ? ` — ${outline.reason}` : ''}`);
  return result;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const report = { app: APP, at: new Date().toISOString(), runs: [] };

try {
  const cdp = await attach(CDP_BASE, null);
  await cdp.eval('1');

  const sep = APP.includes('?') ? '&' : '?';
  const base = `${APP}${sep}theme=light&nowatch=1`;

  const virt = await measure(cdp, '虚拟滚动（默认）', base);
  report.runs.push(virt);

  const full = await measure(cdp, '全量渲染（?novirtual=1）', `${base}&novirtual=1`);
  report.runs.push(full);

  /* ---------------- 结论 ---------------- */
  console.log('\n══ 对比 ══════════════════════════════');
  if (virt.failed || full.failed) {
    console.log('有一轮未跑完，无法对比');
    if (virt.error) console.log(`  虚拟滚动：${virt.error}`);
    if (full.error) console.log(`  全量渲染：${full.error}`);
  } else {
    const nodeRatio = full.nodes / Math.max(1, virt.nodes);
    const blockRatio = full.renderedBlocks / Math.max(1, virt.renderedBlocks);
    console.log(`DOM 节点   ${virt.nodes}  vs  ${full.nodes}   → 少 ${(((nodeRatio - 1)) * 100).toFixed(0)}%`);
    console.log(`渲染块数   ${virt.renderedBlocks}  vs  ${full.renderedBlocks}   → 少 ${(((blockRatio - 1)) * 100).toFixed(0)}%`);
    console.log(`打开耗时   ${virt.openMs} ms  vs  ${full.openMs} ms`);
    console.log(`滚动帧中位 ${virt.scroll.medianMs} ms  vs  ${full.scroll.medianMs} ms`);
    console.log(`滚动帧 p95 ${virt.scroll.p95Ms} ms  vs  ${full.scroll.p95Ms} ms`);
    console.log(`末尾可见  第 ${virt.scroll.lastSectionVisible} 节  vs  第 ${full.scroll.lastSectionVisible} 节`);

    const tailOk = SECTIONS ? virt.scroll.lastSectionVisible >= SECTIONS : null;
    console.log(`虚拟化能看到末节  ${tailOk === null ? '（未提供 --sections，跳过）' : tailOk ? '是' : '否'}`);

    report.summary = {
      nodeRatio: +nodeRatio.toFixed(2),
      blockRatio: +blockRatio.toFixed(2),
      fpsSpeedup: +(full.scroll.medianMs / Math.max(0.01, virt.scroll.medianMs)).toFixed(2),
      tailReachable: tailOk,
    };
  }

  cdp.close();
} catch (err) {
  report.error = err.message;
  console.error('测量失败：', err.message);
} finally {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'perf-report.json'), JSON.stringify(report, null, 2));
  console.log(`\n报告：${path.join(OUT, 'perf-report.json')}`);
}
