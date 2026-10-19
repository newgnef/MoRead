/**
 * 平台适配层
 *
 * 同一份 UI 要跑在三种环境里，靠**运行时探测**选择后端，业务代码不感知差异：
 *
 *   1. Tauri 容器   → 走 Rust 命令（`invoke`），能力最全
 *   2. 浏览器 + dev → 走 Vite 开发中间件 `/__fs/*`（见 tools/dev-fs.ts），用于快速验证
 *   3. 纯静态托管   → 无文件系统能力，退化为「拖拽 / 选择文件」模式
 *
 * 所有 Tauri 模块都用**动态 import**：浏览器里不会被求值，因此不会因为
 * 缺少 `__TAURI_INTERNALS__` 而报错。
 */

/* ------------------------------------------------------------------ */
/* 后端探测                                                            */
/* ------------------------------------------------------------------ */

export const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export type BackendKind = 'tauri' | 'http' | 'none';

export interface HostInfo {
  /** 进程工作目录 —— 开发时用作默认工作区 */
  cwd: string;
  /** 用户主目录 */
  home: string;
  /** 可读的盘符 */
  drives: string[];
}

let backend: BackendKind = isTauri ? 'tauri' : 'none';
let hostInfo: HostInfo | null = null;
let probe: Promise<BackendKind> | null = null;

/** 探测一次宿主能力（幂等）。App 启动时 await 一次即可。 */
export function detectBackend(): Promise<BackendKind> {
  if (!probe) {
    probe = (async () => {
      if (isTauri) {
        backend = 'tauri';
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          hostInfo = await invoke<HostInfo>('host_info');
        } catch {
          hostInfo = { cwd: '', home: '', drives: [] };
        }
        return backend;
      }
      try {
        const r = await fetch('/__fs/ping', { headers: { accept: 'application/json' } });
        if (r.ok) {
          const data = (await r.json()) as HostInfo & { ok: boolean };
          hostInfo = { cwd: data.cwd, home: data.home, drives: data.drives ?? [] };
          backend = 'http';
          return backend;
        }
      } catch {
        /* 没有桥 → 静态模式 */
      }
      backend = 'none';
      return backend;
    })();
  }
  return probe;
}

export function currentBackend(): BackendKind {
  return backend;
}

export function getHostInfo(): HostInfo | null {
  return hostInfo;
}

/* ------------------------------------------------------------------ */
/* 共享类型                                                            */
/* ------------------------------------------------------------------ */

export interface FsNode {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  depth: number;
  size?: number;
  mtime?: number;
}

export interface ReadResult {
  content: string;
  size: number;
  mtime: number;
  /** 'utf-8' | 'gb18030' … 仅用于提示，不改行为 */
  encoding?: string;
}

export interface OpenedFile {
  name: string;
  path: string;
  source: string;
  size: number;
  mtime: number;
  encoding?: string;
}

export interface FsEvent {
  kind: 'change' | 'rename';
  path: string;
}

/* ------------------------------------------------------------------ */
/* 全文搜索（契约类型）                                                 */
/* ------------------------------------------------------------------ */

export interface SearchHit {
  line: number;
  col: number;
  /** 在整个文件里这是第几次出现（从 0 计）—— 交给 revealText 精确定位 */
  ordinal: number;
  snippet: string;
}

export interface SearchFileGroup {
  path: string;
  name: string;
  /** 相对工作区的路径，用于展示归属 */
  relPath: string;
  /** 该文件的总命中数，可能大于 matches.length */
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
  elapsedMs: number;
}

export interface SearchOptions {
  /** 命中条数上限，默认 300 */
  limit?: number;
  /** 目录遍历深度上限，默认 12 */
  depth?: number;
  caseSensitive?: boolean;
}

function emptySearch(query: string, root: string): SearchResult {
  return {
    query, root, files: [], totalMatches: 0,
    scannedFiles: 0, truncated: false, elapsedMs: 0,
  };
}

/* ------------------------------------------------------------------ */
/* 读文件                                                              */
/* ------------------------------------------------------------------ */

function basename(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() ?? p;
}

async function readViaHttp(path: string): Promise<ReadResult> {
  const r = await fetch(`/__fs/read?path=${encodeURIComponent(path)}`);
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    throw new Error((msg as { error?: string }).error ?? `读取失败（${r.status}）`);
  }
  return (await r.json()) as ReadResult;
}

/**
 * 读取一个 Markdown 文件（只读，永不写回）。
 * 无文件系统能力时抛错，调用方负责回退到 <input type="file">。
 */
export async function readDoc(path: string): Promise<OpenedFile> {
  if (backend === 'tauri') {
    const { invoke } = await import('@tauri-apps/api/core');
    const res = await invoke<ReadResult>('read_text_file', { path });
    return { name: basename(path), path, source: res.content, size: res.size, mtime: res.mtime, encoding: res.encoding };
  }
  if (backend === 'http') {
    const res = await readViaHttp(path);
    return { name: basename(path), path, source: res.content, size: res.size, mtime: res.mtime, encoding: res.encoding };
  }
  throw new Error('当前环境不支持直接读取磁盘文件');
}

/* ------------------------------------------------------------------ */
/* 存在性探测                                                          */
/* ------------------------------------------------------------------ */

/**
 * 这个路径现在还是一个可读的文档吗？
 *
 * 历史记录要靠它决定"灰色不可点"。**不要用 readDoc 去试**：
 * 那是把整篇文档读进内存再丢掉，二十几条记录就要读几 MB。
 * 两套后端的契约一致：只认文件，目录 / 权限不足 / 路径拼错一律 false。
 *
 * 无可用的文件系统时返回 false —— 此时历史本来也点不开。
 */
export async function pathExists(path: string): Promise<boolean> {
  const p = path.trim();
  if (!p) return false;
  try {
    if (backend === 'tauri') {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<boolean>('path_exists', { path: p });
    }
    if (backend === 'http') {
      const r = await fetch(`/__fs/exists?path=${encodeURIComponent(p)}`);
      if (!r.ok) return false;
      return Boolean((await r.json() as { exists?: boolean }).exists);
    }
  } catch {
    return false;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 列目录                                                              */
/* ------------------------------------------------------------------ */

/** 递归列出工作区内的 Markdown 树（扁平数组，含 depth） */
export async function listWorkspace(root: string, depth = 12): Promise<FsNode[]> {
  if (backend === 'tauri') {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<FsNode[]>('list_dir', { root, maxDepth: depth });
  }
  if (backend === 'http') {
    const r = await fetch(`/__fs/list?root=${encodeURIComponent(root)}&depth=${depth}`);
    if (!r.ok) {
      const msg = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
      throw new Error((msg as { error?: string }).error ?? `列目录失败（${r.status}）`);
    }
    const data = (await r.json()) as { root: string; nodes: FsNode[] };
    return data.nodes;
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* 全文搜索                                                            */
/* ------------------------------------------------------------------ */

/**
 * 工作区级全文搜索（只读）。
 *
 * 刻意不建索引：目标量级下流式扫描的延迟已经在感知阈值以内，
 * 而索引要额外维护一整套失效逻辑，收益为负。
 *
 * 并发/乱序由调用方用请求序号解决 —— 这里不做取消，
 * 因为 Tauri 的 invoke 没有 AbortSignal 通道，统一在调用侧处理更干净。
 */
export async function searchWorkspace(
  root: string,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResult> {
  if (!query.trim() || backend === 'none') return emptySearch(query, root);

  const limit = opts.limit ?? 300;
  const depth = opts.depth ?? 12;
  const caseSensitive = opts.caseSensitive ?? false;

  if (backend === 'tauri') {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<SearchResult>('search_workspace', {
      root, query, limit, depth, caseSensitive,
    });
  }

  const params = new URLSearchParams({
    root,
    q: query,
    limit: String(limit),
    depth: String(depth),
  });
  if (caseSensitive) params.set('case', '1');

  const r = await fetch(`/__fs/search?${params}`);
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    throw new Error((msg as { error?: string }).error ?? `搜索失败（${r.status}）`);
  }
  return (await r.json()) as SearchResult;
}

/* ------------------------------------------------------------------ */
/* 目录 / 文件选择                                                     */
/* ------------------------------------------------------------------ */

export async function pickFolder(): Promise<string | null> {
  if (backend === 'tauri') {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ multiple: false, directory: true });
    return typeof picked === 'string' ? picked : null;
  }
  return null; // 浏览器无法弹原生目录选择；由 App 侧提供「输入路径」兜底
}

export async function pickMarkdownFile(): Promise<string | null> {
  if (backend === 'tauri') {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    });
    return typeof picked === 'string' ? picked : null;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 监听                                                                */
/* ------------------------------------------------------------------ */

/**
 * 监听一个目录下的 Markdown 变更（递归）。
 *
 * 返回清理函数；目录不可监听时返回一个 no-op，调用方无需特判。
 * 事件已按「只关心 .md / 160ms 合并」处理，前端拿到即可直接用。
 */
export async function watchWorkspace(
  root: string,
  onEvent: (e: FsEvent) => void,
): Promise<() => void> {
  if (backend === 'tauri') {
    const [{ listen }, { invoke }] = await Promise.all([
      import('@tauri-apps/api/event'),
      import('@tauri-apps/api/core'),
    ]);
    const unlisten = await listen<FsEvent>('moread://fs', (ev) => onEvent(ev.payload));
    try {
      await invoke('watch_workspace', { root });
    } catch (err) {
      console.warn('[moread] 目录监听启动失败：', err);
      unlisten();
      return () => {};
    }
    return () => {
      unlisten();
      void invoke('unwatch_workspace', { root }).catch(() => {});
    };
  }

  if (backend === 'http') {
    const es = new EventSource(`/__fs/watch?root=${encodeURIComponent(root)}`);
    es.addEventListener('fs', (ev) => {
      try {
        onEvent(JSON.parse((ev as MessageEvent).data) as FsEvent);
      } catch {
        /* 忽略畸形事件 */
      }
    });
    // EventSource 会自动重连，这里不需要额外补偿
    return () => es.close();
  }

  return () => {};
}

/* ------------------------------------------------------------------ */
/* 窗口控制（仅 Tauri 有效）                                            */
/* ------------------------------------------------------------------ */

async function currentWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

export async function minimizeWindow(): Promise<void> {
  if (!isTauri) return;
  await (await currentWindow()).minimize();
}

export async function toggleMaximizeWindow(): Promise<void> {
  if (!isTauri) return;
  await (await currentWindow()).toggleMaximize();
}

export async function closeWindow(): Promise<void> {
  if (!isTauri) return;
  await (await currentWindow()).close();
}

/**
 * 同步窗口标题。
 *
 * 自绘标题栏不显示它，但 Windows 需要：任务栏悬停、Alt+Tab 切换器、
 * 以及「窗口」菜单里都读这个标题。为空时退回品牌名。
 */
export async function setWindowTitle(title: string): Promise<void> {
  const t = title || 'MoRead';
  if (!isTauri) {
    document.title = t;
    return;
  }
  try {
    await (await currentWindow()).setTitle(t);
  } catch (err) {
    // 权限没配（capabilities 缺 core:window:allow-set-title）时会走到这里。
    // 不要静默：标题失败本身不致命，但排查时没有这条日志会白绕一圈。
    console.warn('[moread] 设置窗口标题失败：', err);
  }
}

/* ------------------------------------------------------------------ */
/* 文件关联（仅 Tauri 有效）                                            */
/* ------------------------------------------------------------------ */

/**
 * 取走「启动时被要求打开、但当时前端还没挂载」的文件路径（取完即清空）。
 *
 * 冷启动双击 `.md` 时，Rust 侧在 setup 阶段就把路径攒进了队列 ——
 * 那时候 emit 事件没有任何监听者，只能靠这个补。
 */
export async function takePendingOpen(): Promise<string[]> {
  if (!isTauri) return [];
  try {
    // 与其他 Tauri 调用一致：动态 import，浏览器里不会被求值
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string[]>('take_pending_open');
  } catch (err) {
    console.warn('[moread] 读取待打开文件失败：', err);
    return [];
  }
}

/**
 * 监听「用 MoRead 打开某个文件」。
 *
 * 触发时机：程序已在托盘里，用户又双击了一个 `.md` ——
 * 第二个实例被单实例插件拦下，把路径转交给已在跑的窗口。
 *
 * 必须**先**注册监听、**再**调 takePendingOpen，否则两步之间进来的请求会丢。
 */
export async function onOpenFileRequested(
  cb: (path: string) => void,
): Promise<() => void> {
  if (!isTauri) return () => {};
  try {
    const { listen } = await import('@tauri-apps/api/event');
    return await listen<string>('moread://open-file', (e) => {
      if (typeof e.payload === 'string' && e.payload) cb(e.payload);
    });
  } catch (err) {
    console.warn('[moread] 文件关联监听不可用：', err);
    return () => {};
  }
}
