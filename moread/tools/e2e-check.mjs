#!/usr/bin/env node
/**
 * MoRead 冒烟测试（CDP 驱动）
 *
 * 为什么不用 `--screenshot`：
 * 无头浏览器的截图默认发生在 `load` 事件之后，而工作区扫描、文件读取、
 * 代码高亮都是 `load` 之后的异步过程 —— 截到的往往是空态。更要命的是，
 * 文件监听用的是 SSE 长连接，「外部改了文件，页面是否自动重载」这种场景
 * 根本没法用一次性截图验证。
 *
 * 这里改用 Chrome DevTools Protocol：连上正在跑的页面，用
 * `Runtime.evaluate` 轮询真实状态、用 `Page.captureScreenshot` 在任意时刻
 * 取图。于是下面这条链路可以被真正端到端验证：
 *
 *   打开工作区 → 渲染磁盘上的真实文档 → 外部改写文件
 *   → 页面自动重载 → 滚动位置保留 → 内容与提示都正确
 *
 * 用法：
 *   node tools/e2e-check.mjs --url <页面地址> --doc <被监视的 md 绝对路径> --out <截图目录>
 *
 * 前置：以 `--remote-debugging-port=9222` 启动 Edge/Chrome 并打开 --url。
 * 退出码 0 = 全部通过，1 = 有检查项失败。
 */

import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, '');
    if (k) out[k] = argv[i + 1];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const DOC = args.doc;
const OUT = args.out ?? '.';
const APP_URL = args.url ?? '';
const CDP_BASE = args.cdp ?? 'http://127.0.0.1:9222';

if (!DOC) {
  console.error('缺少 --doc 参数（要被改写的 Markdown 文件绝对路径）');
  process.exit(2);
}

const MARKER = `外部追加于 ${new Date().toISOString().slice(11, 19)}`;

/* ------------------------------------------------------------------ */
/* CDP 客户端（基于 Node 内置 WebSocket，零依赖）                       */
/* ------------------------------------------------------------------ */

class Cdp {
  #ws; #seq = 0; #waiting = new Map();

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg.id) return;
      const slot = this.#waiting.get(msg.id);
      if (!slot) return;
      this.#waiting.delete(msg.id);
      msg.error ? slot.reject(new Error(msg.error.message)) : slot.resolve(msg.result);
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 8000);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('CDP WebSocket 连接失败')); }, { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, timeoutMs = 25000) {
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.#waiting.has(id)) {
          this.#waiting.delete(id);
          reject(new Error(`CDP 调用超时：${method}`));
        }
      }, timeoutMs);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? '页面脚本异常');
    }
    return r.result?.value;
  }

  async shot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  close() { try { this.#ws.close(); } catch { /* 已关闭 */ } }
}

/** 轮询直到表达式为真 */
async function waitFor(cdp, expression, { timeoutMs = 15000, intervalMs = 200, label = expression } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await cdp.eval(expression);
      if (last) return last;
    } catch (err) {
      last = `异常：${err.message}`;
    }
    await sleep(intervalMs);
  }
  throw new Error(`等待超时（${label}），最后的值：${JSON.stringify(last)}`);
}

async function findPage() {
  const want = args.url ? new URL(args.url) : null;
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`${CDP_BASE}/json/list`)).json();
      const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);

      // Edge 会自己弹出 edge://sync-confirmation-dialog 之类的页面，
      // 「第一个 page」经常不是我们的应用 —— 必须按 URL 认领。
      let hit = null;
      if (want) {
        // 先比完整地址（含 query）：所有用例都挂在同一个 `/` 上，区别全在 `?ws=`
        hit = pages.find((t) => {
          try {
            const u = new URL(t.url);
            return u.origin === want.origin
              && u.pathname === want.pathname
              && u.search === want.search;
          } catch { return false; }
        }) ?? null;
        hit ??= pages.find((t) => {
          try {
            const u = new URL(t.url);
            return u.origin === want.origin && u.pathname === want.pathname;
          } catch { return false; }
        });
      }
      hit ??= pages.find((t) => /^https?:/.test(t.url));
      if (hit) return hit;
    } catch { /* 调试端口还没起来 */ }
    await sleep(400);
  }
  throw new Error('找不到目标页面，请确认 Edge 已用 --remote-debugging-port 打开应用地址');
}

/* ------------------------------------------------------------------ */
/* 断言                                                                */
/* ------------------------------------------------------------------ */

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  const mark = ok ? '  PASS' : '× FAIL';
  console.log(`${mark}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const report = { doc: DOC, startedAt: new Date().toISOString() };

try {
  const page = await findPage();
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  /*
    主动导航一次，而不是指望浏览器已经停在目标地址上。
    否则上一轮用例的页面还开着时，这条脚本会对着别人的工作区做断言，
    失败信息会指向完全不相干的文件（踩过一次）。
  */
  if (APP_URL) {
    await cdp.send('Page.navigate', { url: APP_URL });
    await waitFor(cdp, `!!document.querySelector('.app')`, { timeoutMs: 60000, label: '应用挂载' });
  }

  // ── 1. 工作区已打开，且渲染的是磁盘上那篇文档 ──────────────────
  await waitFor(cdp, `!!document.querySelector('.mr-article')`, { label: '正文出现' });

  const state = await cdp.eval(`(() => ({
    tabs:  [...document.querySelectorAll('.tab__name')].map((e) => e.textContent),
    rows:  document.querySelectorAll('.trow').length,
    files: document.querySelectorAll('.trow--file').length,
    meta:  (document.querySelector('.ws-meta')?.textContent ?? '').trim(),
    ws:    document.querySelector('.ws-head__name')?.textContent ?? '',
    h1:    document.querySelector('.mr-article h1')?.textContent ?? '',
    text:  document.querySelector('.mr-article')?.textContent ?? '',
    backend: document.documentElement.dataset.backend ?? '',
    scrollTop: document.querySelector('.content')?.scrollTop ?? -1,
  }))()`);

  check('文件树从真实工作区读取', state.rows > 0, `${state.files} 篇文档 / ${state.rows} 行`);
  check('工作区名来自磁盘路径', state.ws.length > 0, state.ws);
  check('正文渲染了磁盘上的文档', state.text.includes('监听测试'), `h1 = ${state.h1 || '(空)'}`);

  // ── 2. 滚动到中部，为「重载后保留位置」建立基线 ────────────────
  const baseline = await cdp.eval(`(() => {
    const el = document.querySelector('.content');
    // 先把正文撑高，确保可滚动
    el.scrollTop = Math.round(el.scrollHeight * 0.35);
    const kids = [...document.querySelector('.mr-article').children];
    const base = el.getBoundingClientRect().top;
    const first = kids.find((k) => k.getBoundingClientRect().bottom - base > 0);
    return {
      scrollTop: el.scrollTop,
      text: first?.textContent?.trim().slice(0, 40) ?? '',
    };
  })()`);
  await sleep(300);

  const before = await cdp.eval(`(() => {
    const el = document.querySelector('.content');
    const kids = [...document.querySelector('.mr-article').children];
    const base = el.getBoundingClientRect().top;
    const first = kids.find((k) => k.getBoundingClientRect().bottom - base > 0);
    return { scrollTop: el.scrollTop, anchor: first?.textContent?.trim().slice(0, 40) ?? '' };
  })()`);
  await cdp.shot(path.join(OUT, 'e2e-1-before.png'));

  // ── 3. 外部改写文件（模拟编辑器保存） ─────────────────────────
  const original = fs.readFileSync(DOC, 'utf8');
  const patched = `${original}\n\n## 外部追加章节\n\n${MARKER}\n`;
  fs.writeFileSync(DOC, patched);

  // ── 4. 等页面自动重载 ─────────────────────────────────────────
  let reloaded = true;
  try {
    await waitFor(
      cdp,
      `(document.querySelector('.mr-article')?.textContent ?? '').includes(${JSON.stringify(MARKER)})`,
      { timeoutMs: 15000, label: '自动重载' },
    );
  } catch {
    reloaded = false;
  }
  check('外部改写后自动重载', reloaded, reloaded ? '内容已更新' : '15 秒内未重载');

  // ── 5. 重载后滚动位置是否还停在原来那段文字上 ──────────────────
  const after = await cdp.eval(`(() => {
    const el = document.querySelector('.content');
    const kids = [...document.querySelector('.mr-article').children];
    const base = el.getBoundingClientRect().top;
    const first = kids.find((k) => k.getBoundingClientRect().bottom - base > 0);
    const toast = [...document.querySelectorAll('.toast')].map((t) => t.textContent);
    return {
      scrollTop: el.scrollTop,
      anchor: first?.textContent?.trim().slice(0, 40) ?? '',
      toast,
      hasNew: (document.querySelector('.mr-article')?.textContent ?? '').includes('外部追加章节'),
    };
  })()`);

  check('重载后仍在同一段文字上', after.anchor === before.anchor,
    `前「${before.anchor}」→ 后「${after.anchor}」`);
  const drift = Math.abs(after.scrollTop - before.scrollTop);
  check('滚动量没有大幅跳动', drift < 120, `Δ = ${drift}px`);
  check('给出了重载提示', Array.isArray(after.toast) && after.toast.length > 0,
    (after.toast ?? []).join(' / ') || '无提示');
  check('新增内容已渲染', after.hasNew);

  await cdp.shot(path.join(OUT, 'e2e-2-after.png'));

  // ── 6. 收尾：把文件改回去（测试不该留下副作用） ─────────────────
  fs.writeFileSync(DOC, original);

  report.state = state;
  report.before = before;
  report.after = after;
  cdp.close();
} catch (err) {
  check('测试执行未抛异常', false, err.message);
  report.error = err.message;
} finally {
  report.checks = checks;
  report.passed = checks.filter((c) => c.ok).length;
  report.total = checks.length;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'e2e-report.json'), JSON.stringify(report, null, 2));
  console.log(`\n结果：${report.passed}/${report.total} 通过`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}
