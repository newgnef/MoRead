/** 应用内的共享类型 */

export interface DocTab {
  /** 唯一 id：有真实路径时用绝对路径，浏览器单文件用 `file:<name>` */
  id: string;
  /** 标签上显示的文件名 */
  name: string;
  /** 完整路径（展示与比对用） */
  path: string;
  /** 原始 Markdown 源文本（只读，永不回写） */
  source: string;
  /** 相对展示用的"最后修改"文案 */
  openedAt?: string;
  /** 字节数 */
  size?: number;
  /** 修改时间（毫秒） */
  mtime?: number;
  /** 文本编码，非 UTF-8 时用于提示 */
  encoding?: string;
  /** 外部文件已不存在 / 不可读 */
  missing?: boolean;
  /** 磁盘上的内容变了但尚未重新加载 */
  stale?: boolean;
  /**
   * 已固定。固定标签不出现关闭按钮，也不参与任何「批量关闭」。
   * 这是防误关的承诺，必须在逻辑层拦住，只藏按钮是不够的 ——
   * Ctrl+W、中键、右键菜单都会绕过按钮。
   */
  pinned?: boolean;
}

/** 侧栏文件树节点（由 platform 层的 FsNode 转换而来，纯 UI 结构） */
export interface TreeNode {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  depth: number;
  size?: number;
  mtime?: number;
}

/**
 * 一条搜索命中。
 *
 * 文档内检索与工作区检索共用这个结构，差别只在来源字段：
 * 工作区命中带 relPath 与真实行号，文档内命中带 tabId。
 * 定位统一走 `ordinal`（该文件内第几次出现），不依赖行号 ——
 * 文档内命中拿不到源文件行号，用 ordinal 才能两条路径共用同一套跳转逻辑。
 */
export interface Hit {
  /** 所属文件的绝对路径（无磁盘位置时为空串） */
  path: string;
  /** 文件名 */
  name: string;
  /** 相对工作区的路径；文档内命中没有这一项 */
  relPath?: string;
  /** 行号，仅用于展示 */
  line: number;
  /** 该文件内第几次出现（从 0 计） */
  ordinal: number;
  snippet: string;
  /** 命中来自已打开的标签时给出其 id */
  tabId?: string;
}

/** 搜索结果按文件聚合后的一组 */
export interface HitGroup {
  path: string;
  name: string;
  relPath: string;
  /** 该文件的总命中数，可能大于 hits.length（超出单文件上限只展示前若干条） */
  total: number;
  hits: Hit[];
}

export type SidebarMode = 'files' | 'outline' | 'history';

/**
 * 批量关闭的口径。锚点是右键点中的那个标签，其余按它的相对位置算。
 * `self` 是「关闭当前」，`all` 是「关闭全部」，两者都不受锚点影响。
 */
export type TabCloseMode = 'self' | 'others' | 'left' | 'right' | 'all';

/** 工作区搜索的异步状态 */
export type SearchState = 'idle' | 'loading' | 'ready' | 'error';

/** 搜索结果的统计信息，用于侧栏状态行 */
export interface SearchInfo {
  totalMatches: number;
  scannedFiles: number;
  truncated: boolean;
  elapsedMs: number;
}

/**
 * 搜索范围：
 * - `active`    只搜当前标签页（读到哪篇就在哪篇里找）
 * - `tabs`      所有已打开的标签页
 * - `workspace` 整个工作区（含没打开的文档）
 */
export type SearchScope = 'active' | 'tabs' | 'workspace';

export interface RecentItem {
  name: string;
  path: string;
  time: string;
  kind: 'file' | 'dir';
  /** 时间戳，用于排序与重算相对时间；旧记录可能没有 */
  timeMs?: number;
}

/**
 * 历史列表里的一行。
 *
 * 与 `RecentItem` 分开，是因为这里多了 `missing` —— 它不是一个存储字段，
 * 而是每次启动时探测出来的**当下事实**。混进 RecentItem 会让 localStorage
 * 里存着一份会过期的"文件还在"的判断。
 */
export interface HistoryItem {
  name: string;
  path: string;
  time: string;
  /** 磁盘上已经找不到这个文件 */
  missing: boolean;
}

/** 工作区加载状态机 */
export type TreeState = 'idle' | 'loading' | 'ready' | 'error';

/**
 * 阅读位置锚点。
 *
 * 外部文件被改动后重载内容时，光靠 scrollTop 是回不到原处的 —— 内容长度变了，
 * scrollTop 指向的已经是另一段文字。所以要同时记住「视口顶部那个正文块」
 * （blockIndex + blockOffset）以及该处最近的标题 id（headingId）。
 */
export interface ScrollAnchor {
  scrollTop: number;
  blockIndex: number;
  blockOffset: number;
  headingId: string;
}

/** 轻量提示 */
export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'warn' | 'error';
}

/** 路径归一化：统一分隔符与大小写，用于 Windows 下的路径比对 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

/** 把绝对路径压成「父目录名 / 文件名」这种紧凑展示形式 */
export function compactPath(p: string, keep = 2): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-keep).join(' / ');
}

export function formatBytes(n?: number): string {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 把毫秒时间戳转成「刚刚 / 12 分钟前 / 昨天 18:42」 */
export function relativeTime(ms?: number): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  if (isToday) return `今天 ${hh}:${mm}`;
  const y = new Date(today.getTime() - 86400_000);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hh}:${mm}`;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}
