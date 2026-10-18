/**
 * 图标构建的公共库：SVG 栅格化 + PNG 编解码 + ICO 封装。
 *
 * 为什么用无头 Edge 当栅格化器而不是装 sharp / resvg：
 *   这台机器上本来就有 Edge，而图标只是个位数张、构建时跑一次。
 *   为它引一套原生图像库（要编译、要匹配 ABI）不划算。
 *
 * 为什么还要自己写 PNG 解码：
 *   必须能断言「截出来的图真的带透明通道」。Edge 若忽略了
 *   --default-background-color，四角会是白色，而这个错误在
 *   深色任务栏上才看得出来 —— 构建阶段就该拦住。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { attach, waitFor } from './cdp.mjs';

/* ------------------------------------------------------------------ */
/* PNG 编码                                                            */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

/** rgba: Buffer(w*h*4) → PNG Buffer */
export function encodePNG(rgba, w, h) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* PNG 解码（只支持 8bit、非隔行 —— 浏览器截图与图标都是这个子集）      */
/* ------------------------------------------------------------------ */

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** PNG Buffer → { w, h, rgba } */
export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');

  let off = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let colorType = 0;
  const idat = [];

  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);

    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行 PNG');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }

  if (depth !== 8) throw new Error(`不支持位深 ${depth}`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`不支持的颜色类型 ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));

    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      switch (filter) {
        case 1: line[i] = (line[i] + a) & 0xff; break;
        case 2: line[i] = (line[i] + b) & 0xff; break;
        case 3: line[i] = (line[i] + ((a + b) >> 1)) & 0xff; break;
        case 4: line[i] = (line[i] + paeth(a, b, c)) & 0xff; break;
        default: break; // 0 = None
      }
    }

    for (let x = 0; x < w; x++) {
      const s = x * channels;
      const d = (y * w + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }

  return { w, h, rgba: out };
}

/* ------------------------------------------------------------------ */
/* ICO                                                                 */
/* ------------------------------------------------------------------ */

/** entries: [{ size, data }] —— data 为 PNG Buffer */
export function encodeICO(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;

  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size; // 256 记作 0
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(e.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.data.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

/* ------------------------------------------------------------------ */
/* SVG 栅格化（无头 Edge + CDP）                                       */
/* ------------------------------------------------------------------ */

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function findEdge() {
  for (const p of EDGE_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('找不到 msedge.exe，无法栅格化 SVG');
}

/** 把 SVG 源码塞进一个正好铺满视口的页面 */
function pageFor(svgSource) {
  const inner = svgSource
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<svg([^>]*?)\swidth="[^"]*"/, '<svg$1')
    .replace(/<svg([^>]*?)\sheight="[^"]*"/, '<svg$1')
    .replace(/<svg/, '<svg style="display:block;width:100%;height:100%"');

  return `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent}
</style>
${inner}
`;
}

const TMP = path.join(os.tmpdir(), 'moread-icon-build');
const PORT = 9339;

let browser = null;

/**
 * 起一个常驻的无头 Edge，所有尺寸共用。
 *
 * 为什么不用 `--screenshot`：本机 Edge 上它静默失效（退出码 0、不出图，
 * 连 `--dump-dom` 都是空的），排查了三组参数都一样。CDP 这条路在本项目里
 * 一直可用，而且能精确指定视口尺寸、用 setDefaultBackgroundColorOverride
 * 拿到真正的透明底 —— 比 `--screenshot` 更可控。
 */
async function ensureBrowser() {
  if (browser) return browser;

  fs.mkdirSync(TMP, { recursive: true });
  const proc = spawn(findEdge(), [
    '--headless=old',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(TMP, 'profile')}`,
    '--window-size=400,400',
    'about:blank',
  ], { stdio: 'ignore' });

  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${base}/json/version`);
      if (r.ok) break;
    } catch { /* 还没起来 */ }
    await delay(200);
  }

  const cdp = await attach(base, null);
  browser = { proc, cdp };
  return browser;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 进程退出时收掉浏览器，避免留下孤儿进程 */
export function closeBrowser() {
  if (!browser) return;
  try { browser.cdp.close(); } catch { /* 已关闭 */ }
  try { browser.proc.kill(); } catch { /* 已退出 */ }
  browser = null;
}

process.on('exit', closeBrowser);

/**
 * 渲染一档尺寸，返回 PNG Buffer（带 alpha）。
 *
 * 先导航再覆盖视口指标：反过来会给页面一个 S×S 的布局初值，
 * SVG 的百分比尺寸在极小的 16px 下容易出现半个像素的偏移。
 */
export async function renderSVG(svgPath, size) {
  const { cdp } = await ensureBrowser();

  const html = path.join(TMP, `icon-${size}.html`);
  fs.writeFileSync(html, pageFor(fs.readFileSync(svgPath, 'utf8')), 'utf8');

  await cdp.send('Page.navigate', { url: `file:///${html.replace(/\\/g, '/')}` });
  await waitFor(cdp, `document.readyState === 'complete' && !!document.querySelector('svg')`, {
    timeoutMs: 20000, label: 'SVG 载入',
  });

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: size, height: size, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', {
    color: { r: 0, g: 0, b: 0, a: 0 },
  });
  await delay(40);

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(data, 'base64');

  const { w, h } = decodePNG(buf);
  if (w !== size || h !== size) {
    throw new Error(`截出的尺寸不对：期望 ${size}×${size}，实际 ${w}×${h}`);
  }
  return buf;
}

/** 读四角 alpha，验证透明通道真的生效 */
export function cornerAlpha(pngBuffer) {
  const { w, h, rgba } = decodePNG(pngBuffer);
  const at = (x, y) => rgba[(y * w + x) * 4 + 3];
  return [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)];
}

/** 截一张普通网页（对照表用），高度按内容自适应 */
export async function shotPage(url, width) {
  const { cdp } = await ensureBrowser();

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send('Page.navigate', { url });
  await waitFor(cdp, `document.readyState === 'complete'`, { timeoutMs: 20000, label: '页面载入' });
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 255, g: 255, b: 255, a: 1 } });

  const height = await cdp.eval('Math.ceil(document.documentElement.scrollHeight)');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });
  await delay(120);

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  return Buffer.from(data, 'base64');
}
