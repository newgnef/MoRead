#!/usr/bin/env node
/**
 * 按需截图工具
 *
 * 无头浏览器自带的 `--screenshot` 只能截首屏，而 MoRead 里值得看的东西
 * （代码高亮、表格、虚拟滚动中途的位置）大多不在首屏。这里用 CDP 精确控制：
 * 导航 → 等正文落地 → 滚到指定锚点 → 截图。
 *
 * 用法：
 *   node tools/shoot.mjs --url <地址> --out <文件> [--anchor <选择器>|ratio:0.5] [--settle 900]
 *   node tools/shoot.mjs --url <地址> --eval "<表达式>"                      # 只取值，不截图
 *   node tools/shoot.mjs --url <地址> --out <文件> --eval "<表达式>"          # 先把页面调到该状态，再截图
 *
 * 前置：Edge 以 --remote-debugging-port=9222 启动。
 */

import fs from 'node:fs';
import path from 'node:path';
import { attach, sleep, waitFor } from './cdp.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}

const APP = args.url;
const OUT = args.out;
const ANCHOR = args.anchor ?? '';
const SETTLE = Number(args.settle ?? 900);
const EVAL = args.eval ?? '';
const CDP_BASE = args.cdp ?? 'http://127.0.0.1:9222';

if (!APP || (!OUT && !EVAL)) {
  console.error('用法：node tools/shoot.mjs --url <地址> --out <文件> [--anchor <选择器>|ratio:0.5]');
  process.exit(2);
}

/*
  --nonav 用于 Tauri 桌面版：那边的 WebView2 已经载入了应用，
  再 Page.navigate 一次等于平白重载，还可能打断 IPC 通道。
  走 CDP 只截当前页面即可。
*/
const NONAV = args.nonav === '1' || args.nonav === 'true';

const cdp = await attach(CDP_BASE, NONAV ? null : APP);
if (!NONAV) {
  await cdp.send('Page.navigate', { url: APP });
}
// 等应用外壳就绪即可。不能用 .mr-article —— 空态下没有正文，
// 那样会白等两分钟才超时，而空态本身也是需要截图的场景。
await waitFor(cdp, `!!document.querySelector('.content')`, { timeoutMs: 120000, label: '应用外壳出现' });

if (ANCHOR) {
  const done = await cdp.eval(`(async () => {
    const sc = document.querySelector('.content');
    if (!sc) return '没有滚动容器';
    ${ANCHOR.startsWith('ratio:')
      ? `sc.scrollTop = (sc.scrollHeight - sc.clientHeight) * ${Number(ANCHOR.slice(6))};`
      : `const el = document.querySelector(${JSON.stringify(ANCHOR)});
         if (!el) return '找不到锚点：${ANCHOR}';
         sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 120;`}
    // 滚动后虚拟化需要几帧把新块渲染出来，代码高亮也是分片做的
    await new Promise((r) => setTimeout(r, ${SETTLE}));
    return 'ok';
  })()`);
  if (done !== 'ok') console.warn('锚点提示：', done);
}

// 等一帧，确保最后的绘制落盘
await sleep(320);

/*
  --eval 有两个用法：
    只给 --eval          → 取值不截图（诊断用）
    同时给 --out         → 先把页面调到目标状态，再截图
  后者是必需的：要验证「搜索面板长什么样」，就得先把搜索跑起来再截，
  而这一步只能在页面里做。
*/
let evalValue = null;
if (EVAL) {
  evalValue = await cdp.eval(EVAL);
  if (OUT) await sleep(SETTLE);
}

if (!OUT) {
  console.log(JSON.stringify(evalValue, null, 2));
  cdp.close();
  process.exit(0);
}

// --clip x,y,w,h[,scale]：只截一块区域并放大，用来核对小尺寸细节（图标、1px 线）
const CLIP = args.clip ? (() => {
  const [x, y, w, h, s] = String(args.clip).split(',').map(Number);
  return { x, y, width: w, height: h, scale: s || 1 };
})() : null;

const { data } = await cdp.send('Page.captureScreenshot', {
  format: 'png',
  ...(CLIP ? { clip: CLIP } : {}),
});
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.from(data, 'base64'));

const size = fs.statSync(OUT).size;
console.log(JSON.stringify({ file: OUT, bytes: size, anchor: ANCHOR || '(首屏)', eval: evalValue }, null, 2));

cdp.close();
process.exit(0);
