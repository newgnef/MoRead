/**
 * 共享的 DevTools Protocol 客户端
 *
 * 无头浏览器的 `--screenshot` 只在 load 事件后截一次，而 MoRead 的正文渲染、
 * 工作区扫描、文件监听全是 load 之后的异步过程，一次性截图验证不了。
 * 走 CDP 才能按需取图、按需读页面真实状态。
 *
 * 只用 Node 内置的全局 WebSocket，不引第三方依赖。
 */

import { setTimeout as sleep } from 'node:timers/promises';

export { sleep };

export class Cdp {
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

  send(method, params = {}, timeoutMs = 120000) {
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

  close() { try { this.#ws.close(); } catch { /* 已关闭 */ } }
}

/**
 * 认领目标页面。
 * Edge 会自己弹出 edge://sync-confirmation-dialog 这类页面，所以「第一个 page」
 * 经常不是我们的应用，必须按 URL 匹配。
 */
export async function findPage(cdpBase, wantUrl) {
  const want = wantUrl ? new URL(wantUrl) : null;
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`${cdpBase}/json/list`)).json();
      const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);

      if (want) {
        /*
          先按「含 query 的完整地址」精确匹配，再退到 origin+path。
          只比 origin+path 是不够的：MoRead 的所有用例都挂在同一个 `/` 上，
          区别全在 `?ws=` 里 —— 上一轮的页面还开着时，就会抓到上一个工作区，
          表现成"测试失败"，其实是抓错了窗口。
        */
        const exact = pages.find((t) => {
          try {
            const u = new URL(t.url);
            return u.origin === want.origin
              && u.pathname === want.pathname
              && u.search === want.search;
          } catch { return false; }
        });
        if (exact) return exact;

        const samePath = pages.find((t) => {
          try {
            const u = new URL(t.url);
            return u.origin === want.origin && u.pathname === want.pathname;
          } catch { return false; }
        });
        if (samePath) return samePath;
      }
      const fallback = pages.find((t) => /^https?:/.test(t.url)) ?? pages[0];
      if (fallback) return fallback;
    } catch { /* 调试端口还没起来 */ }
    await sleep(400);
  }
  throw new Error('找不到目标页面，请确认 Edge 已用 --remote-debugging-port 打开应用地址');
}

/** 轮询直到表达式为真 */
export async function waitFor(cdp, expression, { timeoutMs = 15000, intervalMs = 200, label = expression } = {}) {
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

/** 连上页面并启用基础域 */
export async function attach(cdpBase, appUrl) {
  const page = await findPage(cdpBase, appUrl);
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return cdp;
}
