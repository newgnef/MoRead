/**
 * 开发期文件系统桥（仅 `vite dev` 生效，生产构建完全不含此代码）
 *
 * 为什么需要它：
 * 浏览器预览模式（`npm run dev`）拿不到宿主文件系统，导致文件树、文件监听这些
 * 能力只能在 Tauri 里验证 —— 而 Tauri 需要 Rust + MSVC 工具链，门槛高、迭代慢。
 *
 * 这个中间件把「读目录 / 读文件 / 监听变更」三个能力用 HTTP 暴露出来，
 * 让前端逻辑在浏览器里就能端到端跑通。Rust 侧实现同一组命令，
 * 前端靠 platform.ts 做适配，两边行为保持一致。
 *
 * 契约（与 src-tauri/src/lib.rs 的命令一一对应）：
 *   GET /__fs/ping                        → { ok, cwd, home, drives }
 *   GET /__fs/list?root=<abs>&depth=<n>   → TreeNode[]（扁平，含 depth）
 *   GET /__fs/read?path=<abs>             → { content, size, mtime, encoding }
 *   GET /__fs/exists?path=<abs>           → { exists: boolean }（只认文件）
 *   GET /__fs/watch?root=<abs>            → SSE，推送 { kind, path }
 *   GET /__fs/search?root=<abs>&q=&limit= → SearchResult（按文件分组的命中）
 *
 * 安全边界：**只读**。没有任何写入端点，与 V1「不修改用户文档」的定位一致。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Plugin } from 'vite';
import { MAX_HITS_PER_FILE, searchInText } from '../src/lib/search';

/** 会被收录的文件扩展名 —— 与 Rust 侧保持一致 */
const MD_EXTS = new Set(['.md', '.markdown']);

/** 读取文本时直接拒绝的二进制扩展名 */
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.svgz',
  '.zip', '.7z', '.rar', '.gz', '.tar', '.xz', '.bz2',
  '.exe', '.dll', '.so', '.dylib', '.msi', '.bin', '.class', '.jar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flac',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.db', '.sqlite', '.sqlite3', '.dat', '.pdb', '.lib', '.obj',
]);

/** 遍历时跳过的目录：既省时间，也避免撞上超大树 */
const SKIP_DIRS = new Set([
  'node_modules', 'target', 'dist', 'build', 'out', '.git', '.svn', '.hg',
  '.idea', '.vscode', '.vs', '__pycache__', '.venv', 'venv', '.next', '.nuxt',
  'coverage', '.gradle', '.m2', 'AppData',
]);

export interface DevFsTreeNode {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  depth: number;
  size?: number;
  mtime?: number;
}

/* ------------------------------------------------------------------ */
/* 目录遍历                                                            */
/* ------------------------------------------------------------------ */

function collect(dir: string, depth: number, cap: number, out: DevFsTreeNode[]): boolean {
  if (depth > cap) return false;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false; // 无权限 / 已删除 → 静默跳过，不中断整棵树
  }

  const dirs: string[] = [];
  const files: string[] = [];

  for (const e of entries) {
    const name = e.name;
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    if (e.isDirectory()) dirs.push(full);
    else if (MD_EXTS.has(path.extname(name).toLowerCase())) files.push(full);
  }

  dirs.sort((a, b) => a.localeCompare(b, 'zh'));
  files.sort((a, b) => a.localeCompare(b, 'zh'));

  let kept = false;

  // 文件排在目录前 —— 与 Rust 侧 collect() 的顺序严格一致
  for (const f of files) {
    kept = true;
    out.push(nodeOf(f, depth, 'file'));
  }

  for (const d of dirs) {
    const sub: DevFsTreeNode[] = [];
    if (collect(d, depth + 1, cap, sub)) {
      kept = true;
      out.push(nodeOf(d, depth, 'dir'));
      out.push(...sub);
    }
  }

  return kept;
}

function nodeOf(p: string, depth: number, kind: 'dir' | 'file'): DevFsTreeNode {
  const node: DevFsTreeNode = { name: path.basename(p), path: p, kind, depth };
  if (kind === 'file') {
    try {
      const st = fs.statSync(p);
      node.size = st.size;
      node.mtime = Math.round(st.mtimeMs);
    } catch {
      /* 忽略：仅用于展示 */
    }
  }
  return node;
}

/* ------------------------------------------------------------------ */
/* 文本读取（含编码探测）                                               */
/* ------------------------------------------------------------------ */

/**
 * 读出文本，自动处理编码。
 *
 * 中文环境下 GBK/GB18030 的 Markdown 并不罕见（老工具导出、Windows 记事本默认）。
 * 直接按 UTF-8 读会得到满屏乱码，因此这里先严格试 UTF-8，失败再退到 GB18030。
 * TextDecoder 的 gb18030 是 GBK 的超集，能覆盖绝大多数中文文档。
 */
function readText(p: string): { content: string; size: number; mtime: number; encoding: string } {
  const ext = path.extname(p).toLowerCase();
  if (BINARY_EXTS.has(ext)) {
    throw new Error(`不支持读取二进制文件（${ext}）`);
  }

  const buf = fs.readFileSync(p);
  const st = fs.statSync(p);

  // 含 NUL 字节 → 判定为二进制，拒绝（防止把 exe 当文本塞进渲染管线）
  const probe = buf.subarray(0, Math.min(buf.length, 8192));
  if (probe.includes(0)) {
    throw new Error('检测到二进制内容，已拒绝读取');
  }

  let encoding = 'utf-8';
  let content: string;

  // 有 BOM 就直接按 BOM 指定的编码解
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    content = new TextDecoder('utf-8').decode(buf.subarray(3));
  } else {
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      // UTF-8 严格解码失败 → 大概率是 GBK/GB18030
      encoding = 'gb18030';
      try {
        content = new TextDecoder('gb18030').decode(buf);
      } catch {
        encoding = 'utf-8(replace)';
        content = new TextDecoder('utf-8').decode(buf);
      }
    }
  }

  return { content, size: st.size, mtime: Math.round(st.mtimeMs), encoding };
}

/* ------------------------------------------------------------------ */
/* 全文搜索                                                            */
/* ------------------------------------------------------------------ */

export interface SearchHit {
  line: number;
  col: number;
  /** 在整个文件里这是第几次出现（从 0 计）—— 前端靠它精确定位 */
  ordinal: number;
  snippet: string;
}

export interface SearchFileGroup {
  path: string;
  name: string;
  /** 相对工作区的路径，用于展示归属 */
  relPath: string;
  /** 该文件的总命中数（可能大于 matches.length） */
  count: number;
  matches: SearchHit[];
}

export interface SearchResult {
  query: string;
  root: string;
  files: SearchFileGroup[];
  /** 返回的命中条数 */
  totalMatches: number;
  /** 参与扫描的 Markdown 文件数 */
  scannedFiles: number;
  /** 因 limit 提前收工 */
  truncated: boolean;
  /** 扫描耗时（毫秒），排查大工作区卡顿时看这个 */
  elapsedMs: number;
}

/** 单文件参与搜索的体积上限：超过就跳过，别为了搜索把巨物整个读进内存 */
const MAX_SEARCH_BYTES = 8 * 1024 * 1024;

/** 收集工作区内全部 Markdown 文件路径（复用与列目录相同的跳过规则） */
function collectFiles(dir: string, depth: number, cap: number, out: string[]): void {
  if (depth > cap) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const e of entries) {
    const name = e.name;
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    if (e.isDirectory()) collectFiles(full, depth + 1, cap, out);
    else if (MD_EXTS.has(path.extname(name).toLowerCase())) out.push(full);
  }
}

/**
 * 扫描单个文件。
 *
 * 匹配逻辑（含等长屏蔽 Link/HTML 片段）统一走 src/lib/search.ts ——
 * 前端在已打开文档上做同样的检索，两边口径必须完全一致，
 * 否则「同一个关键词」在两处会给出不同结果。
 */
function searchOne(abs: string, needle: string, caseSensitive: boolean): { matches: SearchHit[]; count: number } | null {
  const st = fs.statSync(abs);
  if (st.size > MAX_SEARCH_BYTES) return null;

  const { content } = readText(abs);
  return searchInText(content, needle, { caseSensitive, maxHits: MAX_HITS_PER_FILE });
}

/**
 * 工作区级全文搜索。
 *
 * 刻意**不建索引**：目标量级（≤ 2 万文件）下，流式扫描的端到端延迟已经低于
 * 用户感知阈值，而索引要额外维护一套失效逻辑（文件增删改、编码变化），
 * 收益为负。真到了十万文件量级再换 tantivy，接口不变。
 */
function searchWorkspace(
  root: string,
  query: string,
  limit: number,
  depth: number,
  caseSensitive: boolean,
): SearchResult {
  const abs = path.resolve(root);
  const started = Date.now();

  const paths: string[] = [];
  collectFiles(abs, 0, depth, paths);
  paths.sort((a, b) => a.localeCompare(b, 'zh'));

  const files: SearchFileGroup[] = [];
  let totalMatches = 0;
  let truncated = false;

  for (const p of paths) {
    if (totalMatches >= limit) {
      truncated = true;
      break;
    }

    let hit: { matches: SearchHit[]; count: number } | null = null;
    try {
      hit = searchOne(p, query, caseSensitive);
    } catch {
      continue; // 单个文件读不动（权限 / 二进制 / 编码）不能拖垮整次搜索
    }
    if (!hit || hit.matches.length === 0) continue;

    totalMatches += hit.matches.length;
    files.push({
      path: p,
      name: path.basename(p),
      relPath: path.relative(abs, p).replace(/\\/g, '/'),
      count: hit.count,
      matches: hit.matches,
    });

    if (totalMatches >= limit) truncated = true;
  }

  return {
    query,
    root: abs,
    files,
    totalMatches,
    scannedFiles: paths.length,
    truncated,
    elapsedMs: Date.now() - started,
  };
}

/* ------------------------------------------------------------------ */
/* 监听（SSE）                                                         */
/* ------------------------------------------------------------------ */

interface WatchClient {
  close: () => void;
}

function normalized(p: string): string {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

/**
 * 为一次 SSE 连接建立目录监听。
 * 编辑器「保存」在 Windows 上常触发多个事件，这里做 160ms 合并。
 */
function watchDir(root: string, emit: (kind: string, file: string) => void): WatchClient {
  let timer: NodeJS.Timeout | null = null;
  const pending = new Map<string, string>();

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const rel = filename.toString();
      // 只关心 Markdown，避免构建产物、日志刷屏
      if (!MD_EXTS.has(path.extname(rel).toLowerCase())) return;

      const kind = eventType === 'rename' ? 'rename' : 'change';
      pending.set(rel, kind);

      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const batch = [...pending.entries()];
        pending.clear();
        for (const [file, k] of batch) {
          emit(k, path.join(root, file));
        }
      }, 160);
    });
  } catch {
    /* 目录不存在或不可监听 → 交给心跳维持连接，前端会退化为手动刷新 */
  }

  return {
    close() {
      if (timer) clearTimeout(timer);
      watcher?.close();
    },
  };
}

/* ------------------------------------------------------------------ */
/* 中间件                                                              */
/* ------------------------------------------------------------------ */

function sendJson(res: any, code: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

export function devFsPlugin(): Plugin {
  // 同一份中间件同时挂在 dev server 与 preview server 上：
  // preview 跑的是打包产物，用它测出来的耗时才是用户实际会遇到的数字。
  const middleware = (req: any, res: any, next: () => void) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/__fs/')) return next();

    // 只接受本机来源：这个桥能读任意路径，不能让它被外部页面调用
    const host = String(req.headers.host ?? '');
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) {
      return sendJson(res, 403, { error: '仅允许本机访问' });
    }

    const q = url.searchParams;

    try {
      switch (url.pathname) {
        /* ---------------- 探活 + 环境信息 ---------------- */
        case '/__fs/ping': {
          const drives: string[] = [];
          for (const d of 'CDEFGH') {
            const root = `${d}:\\`;
            try {
              fs.accessSync(root, fs.constants.R_OK);
              drives.push(root);
            } catch {
              /* 该盘不存在 */
            }
          }
          return sendJson(res, 200, {
            ok: true,
            cwd: process.cwd(),
            home: os.homedir(),
            drives,
            platform: process.platform,
          });
        }

        /* ---------------- 列目录 ---------------- */
        case '/__fs/list': {
          const root = q.get('root');
          if (!root) return sendJson(res, 400, { error: '缺少 root 参数' });

          const abs = path.resolve(root);
          let st: fs.Stats;
          try {
            st = fs.statSync(abs);
          } catch {
            return sendJson(res, 404, { error: `目录不存在：${abs}` });
          }
          if (!st.isDirectory()) {
            return sendJson(res, 400, { error: `不是目录：${abs}` });
          }

          const cap = Math.min(Number(q.get('depth') ?? 12) || 12, 24);
          const out: DevFsTreeNode[] = [];
          collect(abs, 0, cap, out);
          return sendJson(res, 200, { root: abs, nodes: out });
        }

        /* ---------------- 读文件 ---------------- */
        case '/__fs/read': {
          const target = q.get('path');
          if (!target) return sendJson(res, 400, { error: '缺少 path 参数' });

          const abs = path.resolve(target);
          const st = fs.statSync(abs); // 不存在会抛，由外层 catch 转 500
          if (st.isDirectory()) {
            return sendJson(res, 400, { error: '目标是目录，不是文件' });
          }
          return sendJson(res, 200, { path: abs, ...readText(abs) });
        }

        /* ---------------- 路径存在性 ---------------- */
        /*
          与 Rust 侧 `path_exists` 同一份契约：只回答"是不是一个存在的文件"。
          目录、权限不足、路径拼错一律 false —— 历史列表里能被点开的只有文档。
        */
        case '/__fs/exists': {
          const target = q.get('path');
          if (!target) return sendJson(res, 400, { error: '缺少 path 参数' });
          let exists = false;
          try {
            exists = fs.statSync(path.resolve(target)).isFile();
          } catch {
            exists = false;
          }
          return sendJson(res, 200, { exists });
        }

        /* ---------------- 全文搜索 ---------------- */
        case '/__fs/search': {
          const root = q.get('root');
          if (!root) return sendJson(res, 400, { error: '缺少 root 参数' });

          const query = q.get('q') ?? '';
          const abs = path.resolve(root);

          let st: fs.Stats;
          try {
            st = fs.statSync(abs);
          } catch {
            return sendJson(res, 404, { error: `目录不存在：${abs}` });
          }
          if (!st.isDirectory()) {
            return sendJson(res, 400, { error: `不是目录：${abs}` });
          }

          // 空关键词直接返回空结果：不要让前端把整个工作区都当成命中
          if (!query.trim()) {
            return sendJson(res, 200, {
              query, root: abs, files: [], totalMatches: 0,
              scannedFiles: 0, truncated: false, elapsedMs: 0,
            } satisfies SearchResult);
          }

          const limit = Math.min(Math.max(Number(q.get('limit') ?? 300) || 300, 1), 2000);
          const depth = Math.min(Number(q.get('depth') ?? 12) || 12, 24);
          const caseSensitive = q.get('case') === '1';

          return sendJson(
            res, 200,
            searchWorkspace(abs, query, limit, depth, caseSensitive),
          );
        }

        /* ---------------- 监听（SSE） ---------------- */
        case '/__fs/watch': {
          const root = q.get('root');
          if (!root) return sendJson(res, 400, { error: '缺少 root 参数' });
          const abs = path.resolve(root);

          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          res.write(`event: ready\ndata: ${JSON.stringify({ root: abs })}\n\n`);

          const client = watchDir(abs, (kind, file) => {
            res.write(`event: fs\ndata: ${JSON.stringify({ kind, path: file })}\n\n`);
          });

          // 心跳：防止中间的代理 / 浏览器把空闲连接掐掉
          const beat = setInterval(() => res.write(': ping\n\n'), 25_000);

          const cleanup = () => {
            clearInterval(beat);
            client.close();
          };
          req.on('close', cleanup);
          req.on('error', cleanup);
          return;
        }

        default:
          return sendJson(res, 404, { error: `未知的 __fs 端点：${url.pathname}` });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return sendJson(res, 500, { error: msg });
    }
  };

  return {
    name: 'moread-dev-fs',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

/** 供 vite.config.ts 复用的路径比较工具（前端也用同一套规则） */
export { normalized as normalizePath };
