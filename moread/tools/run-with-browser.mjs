/**
 * 起一个带调试端口的 Edge，跑指定测试脚本，跑完把浏览器收掉。
 *
 * 为什么需要它：`e2e-check` / `search-check` / `search-virtual` / `tabs-check`
 * 这四个脚本用的是一条持久化的 CDP 会话（它们要在同一次会话里导航多次、
 * 还要读 localStorage），所以没有自己 spawn 浏览器；其余脚本自己起。
 * 这条命令把"起浏览器 + 传 --cdp"这一步补上，让 11 套测试的调用方式一致。
 *
 * 用法：
 *   node tools/run-with-browser.mjs <脚本> --url <应用地址> --out <结果目录> [--port 9222] [-- <脚本自己的参数>]
 *
 * 例：
 *   node tools/run-with-browser.mjs tools/e2e-check.mjs \
 *     --url "http://127.0.0.1:1420/?ws=C:/tmp/ws" --out C:/tmp/e2e-out
 *
 * 前置：开发服务器已在 1420 跑着（npm run dev / preview）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  console.log(`用法: node tools/run-with-browser.mjs <脚本> --url <地址> --out <目录> [--port 9222] [-- 额外参数]`);
  process.exit(argv.length === 0 ? 1 : 0);
}

const script = argv[0];
// `--` 之后的原样透传给被测脚本（例如 e2e-check 的 --doc）
const split = argv.indexOf('--');
const head = split < 0 ? argv.slice(1) : argv.slice(1, split);
const extra = split < 0 ? [] : argv.slice(split + 1);

const opts = {};
for (let i = 0; i < head.length; i += 2) {
  opts[head[i].replace(/^--/, '')] = head[i + 1];
}

if (!opts.url || !opts.out) {
  console.error('缺少 --url 或 --out');
  process.exit(2);
}

const port = Number(opts.port ?? 9222);
const TMP = os.tmpdir().replace(/\\/g, '/');
const CDP = `http://127.0.0.1:${port}`;

function findBrowser() {
  for (const p of [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ]) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Edge / Chrome');
}

const profile = path.join(TMP, `moread-edge-${port}`);
fs.rmSync(profile, { recursive: true, force: true });

const browser = spawn(findBrowser(), [
  '--headless=old', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--disable-sync',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,820',
  // 直接打开被测地址：e2e-check 这类脚本要按"完整查询串"找页面，
  // 从 about:blank 起步时找不到目标页（它不会自己新建标签）。
  opts.url,
], { stdio: 'ignore' });

let ready = false;
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${CDP}/json/version`)).ok) { ready = true; break; }
  } catch { /* 还没起来 */ }
  await new Promise((r) => setTimeout(r, 150));
}

if (!ready) {
  browser.kill();
  console.error(`浏览器没有在 ${CDP} 起来（端口被占？）`);
  process.exit(3);
}

const child = spawn(process.execPath, [
  script,
  '--url', opts.url,
  '--cdp', CDP,
  '--out', opts.out,
  ...extra,
], { stdio: 'inherit', cwd: process.cwd() });

const code = await new Promise((r) => child.on('exit', r));
browser.kill();
process.exit(code ?? 0);
