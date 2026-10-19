//! MoRead 主进程
//!
//! V1 的核心约束：**对用户文档只读，零写入**。
//! 因此这里只暴露「读」的命令，不提供任何写文件能力 ——
//! 连删除、重命名、另存为都没有，这是刻意的。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Instant, UNIX_EPOCH};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
#[cfg(desktop)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
#[cfg(desktop)]
use tauri::WindowEvent;

const MD_EXTS: [&str; 2] = ["md", "markdown"];

/// 读取文件时直接拒绝的二进制扩展名，避免把可执行文件塞进渲染管线
const BINARY_EXTS: [&str; 24] = [
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svgz",
    "zip", "7z", "rar", "gz", "tar", "xz",
    "exe", "dll", "so", "dylib", "msi", "bin", "class", "jar", "pdf",
];

/// 遍历时跳过的目录：既省时间，也避免撞上超大树
const SKIP_DIRS: [&str; 12] = [
    "node_modules", "target", "dist", "build", "out",
    ".git", ".svn", ".hg", ".idea", ".vscode", "__pycache__", ".venv",
];

fn is_markdown(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| MD_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn should_skip_dir(name: &str) -> bool {
    name.starts_with('.') || SKIP_DIRS.contains(&name) || name == "AppData"
}

/* ------------------------------------------------------------------ */
/* 宿主环境                                                            */
/* ------------------------------------------------------------------ */

#[derive(Serialize)]
pub struct HostInfo {
    /// 进程工作目录，首次启动时用它作为默认工作区候选
    pub cwd: String,
    pub home: String,
    /// 可读的盘符，用来给「打开文件夹」提供快捷入口
    pub drives: Vec<String>,
}

#[tauri::command]
fn host_info() -> HostInfo {
    let mut drives = Vec::new();
    for letter in ['C', 'D', 'E', 'F', 'G', 'H'] {
        let root = format!("{letter}:\\");
        if Path::new(&root).is_dir() {
            drives.push(root);
        }
    }

    HostInfo {
        cwd: std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        home: dirs_home(),
        drives,
    }
}

/// 不引入 dirs crate，用环境变量拿主目录就够了
fn dirs_home() -> String {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default()
}

/* ------------------------------------------------------------------ */
/* 读文件                                                              */
/* ------------------------------------------------------------------ */

#[derive(Debug, Serialize)]
pub struct FilePayload {
    pub content: String,
    pub mtime: Option<u64>,
    pub size: u64,
    /// 实际使用的解码方式：'utf-8' | 'gb18030' | 'utf-8-lossy'
    pub encoding: &'static str,
}

/// 读取一个文本文件的内容与元信息。
///
/// 编码处理与开发期的 `tools/dev-fs.ts` 保持一致：先严格试 UTF-8，
/// 失败再退到 GB18030（GBK 的超集）—— 中文环境下老工具导出的 Markdown
/// 经常是 GBK，直接按 UTF-8 读会得到满屏乱码。
#[tauri::command]
async fn read_text_file(path: String) -> Result<FilePayload, String> {
    let p = PathBuf::from(&path);

    if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
        if BINARY_EXTS.contains(&ext.to_ascii_lowercase().as_str()) {
            return Err(format!("不支持读取二进制文件（{ext}）"));
        }
    }

    let meta = std::fs::metadata(&p).map_err(|e| format!("读取文件属性失败：{e}"))?;
    if meta.is_dir() {
        return Err("目标是目录，不是文件".into());
    }

    let buf = std::fs::read(&p).map_err(|e| format!("读取文件失败：{e}"))?;

    // 含 NUL 字节判定为二进制
    if buf.iter().take(8192).any(|b| *b == 0) {
        return Err("检测到二进制内容，已拒绝读取".into());
    }

    let (content, encoding) = decode_text(&buf);
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);

    Ok(FilePayload {
        content,
        mtime,
        size: meta.len(),
        encoding,
    })
}

fn decode_text(buf: &[u8]) -> (String, &'static str) {
    // 有 BOM 就照 BOM 走
    if buf.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return (String::from_utf8_lossy(&buf[3..]).into_owned(), "utf-8");
    }

    match std::str::from_utf8(buf) {
        Ok(s) => (s.to_string(), "utf-8"),
        Err(_) => {
            let (cow, _, had_errors) = encoding_rs::GB18030.decode(buf);
            let encoding = if had_errors { "utf-8-lossy" } else { "gb18030" };
            (cow.into_owned(), encoding)
        }
    }
}

/* ------------------------------------------------------------------ */
/* 列目录                                                              */
/* ------------------------------------------------------------------ */

#[derive(Serialize)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    /// "dir" | "file"
    pub kind: &'static str,
    pub depth: u32,
    pub size: Option<u64>,
    pub mtime: Option<u64>,
}

/// 递归列目录，只保留 Markdown 文件与「含有 Markdown 的目录」。
///
/// 返回扁平数组（每项自带 depth），前端直接顺序渲染即可 ——
/// 省掉一层递归结构，也让「展开/折叠」纯粹变成过滤。
/// 路径是否是一个存在的**文件**。
///
/// 历史记录在启动时要一次性校验二十几条旧路径。若用 `read_text_file` 去试，
/// 等于把每篇文档都读进内存（几百 KB × 24），只为回答一个是/否；
/// 而且 GBK 文件、大文件会让这件事更贵。这里只做一次 stat。
///
/// 目录返回 false：历史列表里可以点的都是文档，目录不该被当成"存在"。
/// 权限不足等错误也一律当不存在 —— 打不开的路径对用户和不存在没区别。
#[tauri::command]
fn path_exists(path: String) -> bool {
    let p = path.trim();
    !p.is_empty() && std::path::Path::new(p).is_file()
}

#[tauri::command]
async fn list_dir(root: String, max_depth: Option<u32>) -> Result<Vec<TreeNode>, String> {
    let cap = max_depth.unwrap_or(12).min(24);
    let base = PathBuf::from(&root);
    if !base.is_dir() {
        return Err(format!("目录不存在：{root}"));
    }
    let mut out = Vec::new();
    collect(&base, 0, cap, &mut out)?;
    Ok(out)
}

fn collect(dir: &Path, depth: u32, cap: u32, out: &mut Vec<TreeNode>) -> Result<bool, String> {
    if depth > cap {
        return Ok(false);
    }

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(false), // 无权限 / 已删除 → 跳过，不中断整棵树
    };

    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut files: Vec<PathBuf> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if should_skip_dir(&name) {
            continue;
        }
        if path.is_dir() {
            dirs.push(path);
        } else if is_markdown(&path) {
            files.push(path);
        }
    }

    dirs.sort();
    files.sort();

    let mut kept = false;

    // 文件排在目录前 —— 与开发期 dev-fs.ts 的顺序严格一致，
    // 否则两套后端会给出不一样的树
    for path in files {
        kept = true;
        out.push(node_of(&path, depth, "file"));
    }

    for path in dirs {
        let mut sub = Vec::new();
        if collect(&path, depth + 1, cap, &mut sub)? {
            kept = true;
            out.push(node_of(&path, depth, "dir"));
            out.extend(sub);
        }
    }

    Ok(kept)
}

fn node_of(path: &Path, depth: u32, kind: &'static str) -> TreeNode {
    let (size, mtime) = if kind == "file" {
        match std::fs::metadata(path) {
            Ok(m) => (
                Some(m.len()),
                m.modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64),
            ),
            Err(_) => (None, None),
        }
    } else {
        (None, None)
    };

    TreeNode {
        name: path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string(),
        path: path.to_string_lossy().to_string(),
        kind,
        depth,
        size,
        mtime,
    }
}

/* ------------------------------------------------------------------ */
/* 目录监听                                                            */
/* ------------------------------------------------------------------ */

/// 已建立的监听器。key 是工作区根目录，value 是 watcher（drop 即停止监听）
#[derive(Default)]
struct WatchState(Mutex<HashMap<String, RecommendedWatcher>>);

/// 前端监听的事件名，与 platform.ts 中的 listen('moread://fs') 对应
const FS_EVENT: &str = "moread://fs";

#[derive(Clone, Serialize)]
struct FsEvent {
    /// "change" | "rename"
    kind: &'static str,
    path: String,
}

/// 开始监听一个目录下的 Markdown 变更（递归）。
///
/// 前端按需调用；同一个目录重复调用是幂等的。
#[tauri::command]
fn watch_workspace(
    app: AppHandle,
    state: tauri::State<'_, WatchState>,
    root: String,
) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    if map.contains_key(&root) {
        return Ok(());
    }

    let handle = app.clone();
    let mut watcher = notify::recommended_watcher(
        move |res: Result<notify::Event, notify::Error>| {
            let event = match res {
                Ok(e) => e,
                Err(_) => return,
            };
            // 创建/删除用 rename 表达，前端据此刷新文件树；内容变化用 change
            let kind = match event.kind {
                EventKind::Create(_) | EventKind::Remove(_) => "rename",
                _ => "change",
            };
            for path in event.paths {
                if !is_markdown(&path) {
                    continue; // 只关心 Markdown，避免构建产物、日志刷屏
                }
                let _ = handle.emit(
                    FS_EVENT,
                    FsEvent { kind, path: path.to_string_lossy().to_string() },
                );
            }
        },
    )
    .map_err(|e| format!("创建监听器失败：{e}"))?;

    watcher
        .watch(Path::new(&root), RecursiveMode::Recursive)
        .map_err(|e| format!("监听目录失败：{e}"))?;

    map.insert(root, watcher);
    Ok(())
}

#[tauri::command]
fn unwatch_workspace(state: tauri::State<'_, WatchState>, root: String) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    map.remove(&root); // drop watcher 即停止监听
    Ok(())
}

/* ------------------------------------------------------------------ */
/* 全文搜索                                                            */
/* ------------------------------------------------------------------ */

/// 单文件最多返回的命中条数，与 src/lib/search.ts 的 MAX_HITS_PER_FILE 一致
const MAX_HITS_PER_FILE: usize = 30;

/// 单文件参与搜索的体积上限：超过就跳过，别为了搜索把巨物整个读进内存
const MAX_SEARCH_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// 1 起的行号，仅用于展示
    pub line: u32,
    /// 行内起始列（字符数，不是字节数）
    pub col: u32,
    /// 在整个文件里这是第几次出现（0 起）—— 前端靠它精确定位
    pub ordinal: u32,
    pub snippet: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileGroup {
    pub path: String,
    pub name: String,
    /// 相对工作区的路径，用于展示归属
    pub rel_path: String,
    /// 该文件的总命中数，可能大于 matches.len()
    pub count: u32,
    pub matches: Vec<SearchHit>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub query: String,
    pub root: String,
    pub files: Vec<SearchFileGroup>,
    pub total_matches: u32,
    pub scanned_files: u32,
    /// 因 limit 提前收工
    pub truncated: bool,
    pub elapsed_ms: u64,
}

/// 把一行里「不会出现在渲染结果中」的片段按字符数抹成空格。
///
/// 这是 `src/lib/search.ts` 里 `maskNonVisible` 的等价实现，两边必须保持一致，
/// 否则同一个关键词在两套后端下会给出不同的序号，跳转就会错位。
///
/// 处理两类：`](...)` 链接目标、`<...>` 行内标签。
/// 用 char 而非 byte 遍历 —— 替换后的字符数必须与原串严格相同，
/// 否则列号与行内截取的上下文都会偏。
fn mask_non_visible(line: &str) -> String {
    if !line.contains(']') && !line.contains('<') {
        return line.to_string();
    }

    let mut cs: Vec<char> = line.chars().collect();
    let n = cs.len();
    let mut i = 0usize;

    while i < n {
        // ]( ... ) ：只抹掉括号与其内部，方括号里的文字在正文里可见，保留
        if cs[i] == ']' && i + 1 < n && cs[i + 1] == '(' {
            let mut j = i + 2;
            while j < n && cs[j] != ')' && cs[j] != '\n' {
                j += 1;
            }
            if j < n && cs[j] == ')' {
                for k in (i + 1)..=j {
                    cs[k] = ' ';
                }
                i = j + 1;
                continue;
            }
        }

        // < ... > ：整段抹掉（标签本身不显示，但标签之间的文字保留）
        if cs[i] == '<' {
            let mut j = i + 1;
            while j < n && cs[j] != '>' && cs[j] != '<' && j - i < 300 {
                j += 1;
            }
            if j < n && cs[j] == '>' {
                for k in i..=j {
                    cs[k] = ' ';
                }
                i = j + 1;
                continue;
            }
        }

        i += 1;
    }

    cs.into_iter().collect()
}

/// 截取命中位置前后一小段上下文，两侧按需加省略号。
/// 与 TS 侧 `snippetAround` 的 pad 默认值保持一致（34）。
fn snippet_around(raw: &str, col: usize, len: usize) -> String {
    const PAD: usize = 34;
    let cs: Vec<char> = raw.chars().collect();
    let from = col.saturating_sub(PAD);
    let to = (col + len + PAD).min(cs.len());
    if from >= to {
        return String::new();
    }

    let body: String = cs[from..to].iter().collect();
    let mut out = String::new();
    if from > 0 {
        out.push('…');
    }
    out.push_str(body.trim());
    if to < cs.len() {
        out.push('…');
    }
    out
}

/// 在一段文本里查找关键词。
///
/// `ordinal` **总是**递增，即使该条命中因为超出 max_hits 没被收录 ——
/// 少算一次就会让后面所有命中的序号整体前移，点击直接跳错位置。
fn search_in_text(
    text: &str,
    needle: &str,
    case_sensitive: bool,
    max_hits: usize,
) -> (Vec<SearchHit>, u32) {
    let mut matches: Vec<SearchHit> = Vec::new();
    let mut count: u32 = 0;

    if needle.is_empty() {
        return (matches, count);
    }

    let pin_owned;
    let pin: &str = if case_sensitive {
        needle
    } else {
        pin_owned = needle.to_lowercase();
        &pin_owned
    };
    // 片段长度按**原始**关键词的字符数算，避免某些字符小写化后长度变化
    let needle_chars = needle.chars().count();

    for (idx, raw) in text.split('\n').enumerate() {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        let masked = mask_non_visible(raw);

        let hay_owned;
        let hay: &str = if case_sensitive {
            masked.as_str()
        } else {
            hay_owned = masked.to_lowercase();
            &hay_owned
        };

        let mut from = 0usize;
        while from <= hay.len() {
            let Some(pos) = hay[from..].find(pin) else { break };
            let byte_start = from + pos;
            let byte_end = byte_start + pin.len();

            count += 1;
            if matches.len() < max_hits {
                let col = hay[..byte_start].chars().count();
                matches.push(SearchHit {
                    line: (idx + 1) as u32,
                    col: col as u32,
                    ordinal: count - 1,
                    snippet: snippet_around(raw, col, needle_chars),
                });
            }

            // 至少推进一个字符，避免空关键词导致的死循环
            from = byte_end.max(byte_start + 1);
        }
    }

    (matches, count)
}

/// 收集工作区内全部 Markdown 文件路径（复用与列目录相同的跳过规则）
fn collect_files(dir: &Path, depth: u32, cap: u32, out: &mut Vec<PathBuf>) {
    if depth > cap {
        return;
    }

    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if should_skip_dir(name) {
            continue;
        }
        if path.is_dir() {
            collect_files(&path, depth + 1, cap, out);
        } else if is_markdown(&path) {
            out.push(path);
        }
    }
}

fn rel_path(base: &Path, p: &Path) -> String {
    p.strip_prefix(base)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| p.to_string_lossy().to_string())
}

/// 工作区级全文搜索（只读）。
///
/// 与 `tools/dev-fs.ts` 的 `/__fs/search` 是同一份契约，前端在两者之间无感切换。
/// 刻意不建索引：目标量级下流式扫描的延迟已经低于感知阈值，
/// 而索引要额外维护一整套失效逻辑，收益为负。
#[tauri::command]
async fn search_workspace(
    root: String,
    query: String,
    limit: Option<usize>,
    depth: Option<u32>,
    case_sensitive: Option<bool>,
) -> Result<SearchResult, String> {
    let base = PathBuf::from(&root);
    if !base.is_dir() {
        return Err(format!("目录不存在：{root}"));
    }

    let started = Instant::now();
    let limit = limit.unwrap_or(300).clamp(1, 2000);
    let cap = depth.unwrap_or(12).min(24);
    let case_sensitive = case_sensitive.unwrap_or(false);

    let needle = query.trim().to_string();
    if needle.is_empty() {
        return Ok(SearchResult {
            query,
            root,
            files: Vec::new(),
            total_matches: 0,
            scanned_files: 0,
            truncated: false,
            elapsed_ms: 0,
        });
    }

    let mut paths: Vec<PathBuf> = Vec::new();
    collect_files(&base, 0, cap, &mut paths);
    paths.sort();
    let scanned = paths.len() as u32;

    let mut files: Vec<SearchFileGroup> = Vec::new();
    let mut total: usize = 0;
    let mut truncated = false;

    for p in &paths {
        if total >= limit {
            truncated = true;
            break;
        }

        let Ok(meta) = std::fs::metadata(p) else { continue };
        if meta.len() > MAX_SEARCH_BYTES {
            continue;
        }

        let Ok(buf) = std::fs::read(p) else { continue };
        // 含 NUL 判定为二进制，跳过（与读文件时的规则一致）
        if buf.iter().take(8192).any(|b| *b == 0) {
            continue;
        }

        let (content, _) = decode_text(&buf);
        let (matches, count) = search_in_text(&content, &needle, case_sensitive, MAX_HITS_PER_FILE);
        if matches.is_empty() {
            continue;
        }

        total += matches.len();
        files.push(SearchFileGroup {
            path: p.to_string_lossy().to_string(),
            name: p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string(),
            rel_path: rel_path(&base, p),
            count,
            matches,
        });

        if total >= limit {
            truncated = true;
        }
    }

    Ok(SearchResult {
        query: needle,
        root,
        files,
        total_matches: total as u32,
        scanned_files: scanned,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/* ------------------------------------------------------------------ */
/* 文件关联：把命令行里的 .md 路径交给前端                              */
/* ------------------------------------------------------------------ */

/// 等前端来取的「要打开的文件」队列。
///
/// 为什么不能只靠事件：
///   冷启动（双击 .md → 进程带参数启动）时前端还没挂载，那一刻 emit 出去没人收。
///   所以先入队，前端 onMount 时 `take_pending_open` 取走。
///   运行中的第二实例则「入队 + emit」双保险：前端在听事件就立刻开，
///   万一事件漏了，下次取队列也能捞回来。
pub struct PendingOpen(Mutex<Vec<String>>);

impl Default for PendingOpen {
    fn default() -> Self {
        Self(Mutex::new(Vec::new()))
    }
}

/// 从命令行里挑出 Markdown 路径。
///
/// 第 0 个参数是 exe 自身，必须跳过 —— 否则会试图把 moread.exe 当文档打开。
/// Windows 的文件关联调用会带引号，这里统一剥掉。
fn md_args(argv: &[String]) -> Vec<String> {
    argv.iter()
        .skip(1)
        .map(|a| a.trim().trim_matches('"').to_string())
        .filter(|a| !a.is_empty() && is_markdown(Path::new(a)))
        .collect()
}

/// 入队并（可选）通知前端。`notify=false` 用于冷启动：此时没有监听者，省一次无用广播。
fn queue_open(app: &AppHandle, argv: &[String], notify: bool) -> Vec<String> {
    let files = md_args(argv);
    if files.is_empty() {
        return files;
    }

    if let Some(q) = app.try_state::<PendingOpen>() {
        if let Ok(mut v) = q.0.lock() {
            // 去重：同一个路径可能被 shell 与关联机制各传一次
            for f in &files {
                if !v.iter().any(|x| x.eq_ignore_ascii_case(f)) {
                    v.push(f.clone());
                }
            }
        }
    }

    if notify {
        for f in &files {
            let _ = app.emit("moread://open-file", f.clone());
        }
    }

    files
}

/// 前端启动后调用一次，取走期间攒下的待打开文件（取完即清空）。
#[tauri::command]
fn take_pending_open(state: tauri::State<'_, PendingOpen>) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(mut v) = state.0.lock() {
        out.append(&mut v);
    }
    out
}

/* ------------------------------------------------------------------ */
/* 窗口与托盘                                                          */
/* ------------------------------------------------------------------ */

/// 把主窗口叫回前台。
///
/// 三个调用缺一不可：`show` 只负责让它可见，曾被最小化的窗口仍是最小化
/// 状态，`set_focus` 才会把焦点抢过来 —— 少任何一个，用户都会以为程序没反应。
#[cfg(desktop)]
fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 右下角托盘：左键显示主界面，右键菜单给出「显示 / 退出」。
#[cfg(desktop)]
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主界面", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 MoRead", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &sep, &quit])?;

    let mut builder = TrayIconBuilder::with_id("moread-tray")
        .menu(&menu)
        // 左键留给「显示窗口」；菜单只在右键弹，符合 Windows 托盘习惯
        .show_menu_on_left_click(false)
        .tooltip("MoRead · 左键显示，右键退出")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            // 这是唯一真正退出的入口：走 app.exit 而不是关窗，
            // 否则又会被 CloseRequested 拦下来，变成关不掉
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_main_window(tray.app_handle()),
            _ => {}
        });

    // Windows 上这张图来自 exe 里嵌的 ico 资源（tauri-build 写入），
    // 不需要额外读 PNG —— 所以 Cargo.toml 里也不必开 image-png。
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // 单实例必须第一个注册：托盘应用若允许开第二份，就会出现两个托盘图标、
    // 两份内存，而且用户完全分不清哪个才是真的。
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(
            |app, argv, _cwd| {
                // 第二实例多半是「双击了另一个 .md」：把路径转交给已在跑的窗口
                let files = queue_open(app, &argv, true);
                if !files.is_empty() {
                    log::info!("第二实例请求打开 {} 个文档：{:?}", files.len(), files);
                }
                show_main_window(app);
            },
        ));
    }

    builder
        .plugin(
            tauri_plugin_log::Builder::new()
                .max_file_size(5 * 1024 * 1024) // 滚动 5MB × 3
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(WatchState::default())
        .manage(PendingOpen::default())
        .setup(|app| {
            #[cfg(desktop)]
            {
                // 冷启动：双击 .md 时进程就是带参数起来的。
                // 此刻前端还没挂载，先攒进队列，等它 onMount 时来取。
                let argv: Vec<String> = std::env::args().collect();
                let queued = queue_open(app.handle(), &argv, false);
                if !queued.is_empty() {
                    log::info!("启动参数里发现 {} 个待打开文档：{:?}", queued.len(), queued);
                }

                build_tray(app.handle())?;

                // 关窗 = 收起到托盘，而不是退出。
                // 拦在 CloseRequested 上，Alt+F4、自绘关闭按钮、系统菜单
                // 三条路都会走到这里，不用分别处理。
                if let Some(window) = app.get_webview_window("main") {
                    let handle = app.handle().clone();
                    window.on_window_event(move |event| {
                        if let WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            if let Some(w) = handle.get_webview_window("main") {
                                let _ = w.hide();
                            }
                        }
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            host_info,
            read_text_file,
            path_exists,
            list_dir,
            search_workspace,
            watch_workspace,
            unwatch_workspace,
            take_pending_open,
        ])
        .run(tauri::generate_context!())
        .expect("MoRead 启动失败");
}

/* ------------------------------------------------------------------ */
/* 测试                                                                */
/* ------------------------------------------------------------------ */

/*
  编译通过只证明类型对，不证明命令真能跑。
  这里直接调用命令本体（它们都是普通函数，只有 watch_* 依赖 State 所以不测），
  用真实文件系统验证契约。

  跑：cd src-tauri && cargo test
*/
#[cfg(test)]
mod tests {
    use super::*;

    /// 每个用例一个独立目录，避免并行执行时互相踩
    fn workdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("moread-rust-{tag}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("创建临时目录");
        d
    }

    fn write(dir: &Path, rel: &str, body: &[u8]) -> PathBuf {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).expect("创建父目录");
        }
        std::fs::write(&p, body).expect("写测试文件");
        p
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    /* ------------------------- 启动参数 / 文件关联 ------------------------- */

    /// 只挑 .md / .markdown，跳过 exe 自身，剥掉引号。
    /// 这条链路的失败会表现为「双击 .md 打开了程序但一片空白」，
    /// 从界面看不出来，所以必须有测试钉住。
    #[test]
    fn md_args_picks_markdown_paths_only() {
        let argv: Vec<String> = [
            r"C:\Program Files\MoRead\moread.exe",
            r"C:\notes\guide.md",
            r#""D:\我的笔记\复卷报表 说明.markdown""#,
            "C:\\notes\\photo.png",
            "--some-flag",
            "",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();

        let got = md_args(&argv);

        assert_eq!(got.len(), 2, "应只挑出两个 Markdown 路径，实际 {got:?}");
        assert_eq!(got[0], r"C:\notes\guide.md");
        // 带引号且路径含空格的，引号要去掉、空格要保留
        assert_eq!(got[1], r"D:\我的笔记\复卷报表 说明.markdown");
        assert!(
            !got.iter().any(|p| p.contains("moread.exe")),
            "exe 自身不该被当成文档"
        );
    }

    #[test]
    fn md_args_accepts_uppercase_extension() {
        let argv: Vec<String> = ["moread.exe", r"C:\x\README.MD"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(md_args(&argv).len(), 1);
    }

    #[test]
    fn md_args_returns_empty_without_files() {
        let argv: Vec<String> = ["moread.exe"].iter().map(|s| s.to_string()).collect();
        assert!(md_args(&argv).is_empty());
    }

    /* ---------------------------- host_info ---------------------------- */

    #[test]
    fn host_info_reports_home_and_drives() {
        let h = host_info();
        assert!(!h.home.is_empty(), "home 不应为空");
        assert!(!h.cwd.is_empty(), "cwd 不应为空");
        assert!(!h.drives.is_empty(), "至少应识别出一个可读盘符");
        for d in &h.drives {
            assert!(d.ends_with(":\\"), "盘符格式应为 X:\\，实际 {d}");
            assert!(Path::new(d).is_dir(), "{d} 应该真的存在");
        }
    }

    /* ----------------------------- list_dir ---------------------------- */

    #[test]
    fn list_dir_keeps_markdown_and_skips_noise() {
        let d = workdir("list");
        write(&d, "docs/guide.md", b"# guide\n");
        write(&d, "docs/api.md", b"# api\n");
        write(&d, "notes/子目录/备忘.md", b"# memo\n");
        write(&d, "node_modules/pkg/hidden.md", "# 该被跳过\n".as_bytes());
        write(&d, "target/debug/hidden.md", "# 该被跳过\n".as_bytes());
        write(&d, ".secret/hidden.md", "# 点目录应跳过\n".as_bytes());
        write(&d, "cover.png", b"not markdown");

        let nodes = tauri::async_runtime::block_on(list_dir(s(&d), None)).expect("列目录应成功");
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();

        assert!(names.contains(&"guide.md"), "应包含 guide.md：{names:?}");
        assert!(names.contains(&"api.md"));
        assert!(names.contains(&"备忘.md"), "中文文件名不应出问题");
        assert!(
            !names.contains(&"hidden.md"),
            "node_modules / target / 点目录应被跳过：{names:?}"
        );
        assert!(!names.contains(&"cover.png"), "非 Markdown 文件不应出现");

        let docs = nodes.iter().find(|n| n.name == "docs").expect("docs 目录应出现");
        assert_eq!(docs.kind, "dir");
        assert_eq!(docs.depth, 0, "顶层节点 depth 应为 0（前端据此算缩进）");

        let guide = nodes.iter().find(|n| n.name == "guide.md").expect("guide.md 应出现");
        assert_eq!(guide.kind, "file");
        assert_eq!(guide.depth, 1, "docs 之下的文件 depth 应为 1");
        assert!(guide.size.is_some(), "文件应带 size");
        assert!(guide.mtime.is_some(), "文件应带 mtime");
        assert!(guide.path.ends_with("guide.md"));

        let memo = nodes.iter().find(|n| n.name == "备忘.md").unwrap();
        assert_eq!(memo.depth, 2, "两级目录下的文件 depth 应为 2");
    }

    #[test]
    fn list_dir_rejects_missing_and_file_targets() {
        let d = workdir("list-bad");
        let missing = d.join("nope");
        assert!(tauri::async_runtime::block_on(list_dir(s(&missing), None)).is_err());

        let f = write(&d, "a.md", b"# a\n");
        assert!(
            tauri::async_runtime::block_on(list_dir(s(&f), None)).is_err(),
            "传文件而不是目录应报错"
        );
    }

    #[test]
    fn list_dir_respects_depth_cap() {
        let d = workdir("list-depth");
        write(&d, "a/b/c/d/deep.md", b"# deep\n");
        let nodes = tauri::async_runtime::block_on(list_dir(s(&d), Some(1))).expect("应成功");
        assert!(
            nodes.iter().all(|n| n.depth <= 1),
            "depth 上限应生效：{:?}",
            nodes.iter().map(|n| (n.name.as_str(), n.depth)).collect::<Vec<_>>()
        );
    }

    /* -------------------------- read_text_file ------------------------- */

    #[test]
    fn read_text_file_decodes_utf8_and_gbk() {
        let d = workdir("read");

        // 纯 UTF-8
        let utf8 = write(&d, "utf8.md", "# 标题\n\n正文内容。\n".as_bytes());
        let r = tauri::async_runtime::block_on(read_text_file(s(&utf8))).expect("应成功");
        assert_eq!(r.encoding, "utf-8");
        assert!(r.content.contains("正文内容"));
        assert_eq!(r.size, "# 标题\n\n正文内容。\n".len() as u64);
        assert!(r.mtime.is_some());

        // UTF-8 BOM：应剥掉 BOM，不让它混进正文
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice("# 带 BOM\n".as_bytes());
        let bomp = write(&d, "bom.md", &bom);
        let r = tauri::async_runtime::block_on(read_text_file(s(&bomp))).expect("应成功");
        assert_eq!(r.encoding, "utf-8");
        assert!(r.content.starts_with("# 带 BOM"), "BOM 应被剥掉，实际开头 {:?}", &r.content[..r.content.len().min(8)]);

        // GB18030：中文环境下老工具导出的笔记很常见
        let (gbk, _, _) = encoding_rs::GB18030.encode("中文编码测试\n");
        let g = write(&d, "gbk.md", &gbk);
        let r = tauri::async_runtime::block_on(read_text_file(s(&g))).expect("应成功");
        assert_eq!(r.encoding, "gb18030", "应识别为 GB18030");
        assert!(r.content.contains("中文编码测试"), "GBK 内容应正确还原");
    }

    #[test]
    fn read_text_file_refuses_binary_dir_and_missing() {
        let d = workdir("read-bad");

        let png = write(&d, "cover.png", b"\x89PNG\r\n\x1a\n");
        let e = tauri::async_runtime::block_on(read_text_file(s(&png))).unwrap_err();
        assert!(e.contains("二进制"), "按扩展名应被拒：{e}");

        // 扩展名无害但内容含 NUL：也要拦
        let sneaky = write(&d, "sneaky.md", b"abc\x00def");
        let e = tauri::async_runtime::block_on(read_text_file(s(&sneaky))).unwrap_err();
        assert!(e.contains("二进制"), "含 NUL 应被拒：{e}");

        let e = tauri::async_runtime::block_on(read_text_file(s(&d))).unwrap_err();
        assert!(e.contains("目录"), "传目录应被拒：{e}");

        let missing = d.join("missing.md");
        assert!(tauri::async_runtime::block_on(read_text_file(s(&missing))).is_err());
    }

    /* ---------------------------- path_exists -------------------------- */

    /// 历史记录的可点状态全靠它判断，判错的后果是：
    /// 真文件被画成灰的（点不动）、或已删除的文件看着能点（点了报错）。
    #[test]
    fn path_exists_tells_file_from_gone_and_dir() {
        let d = workdir("path-exists");
        let f = write(&d, "keep.md", b"# hi");

        assert!(path_exists(s(&f)), "存在的文件应为 true");
        assert!(!path_exists(s(&d)), "目录不算文件");
        assert!(!path_exists(s(&d.join("gone.md"))), "不存在的路径应为 false");
        assert!(!path_exists(String::new()), "空路径应为 false");
        assert!(!path_exists("   ".into()), "纯空白应为 false");
    }

    /* ------------------------- search_workspace ------------------------ */

    fn search(root: &Path, q: &str) -> SearchResult {
        tauri::async_runtime::block_on(search_workspace(s(root), q.to_string(), None, None, None))
            .expect("搜索应成功")
    }

    #[test]
    fn search_counts_multi_hits_and_numbers_them_in_order() {
        let d = workdir("search-order");
        // 行号：1 标题 / 2 空 / 3 两处 / 4 空 / 5 链接 / 6 空 / 7 一处
        write(
            &d,
            "a.md",
            "# 标题\n\n报表A 与 报表B 同行。\n\n参考 [报表规范](https://example.com/报表/目标)\n\n末尾 报表C\n"
                .as_bytes(),
        );

        let r = search(&d, "报表");
        assert_eq!(r.scanned_files, 1, "应扫到 1 个文件");
        assert_eq!(r.files.len(), 1);

        let g = &r.files[0];
        assert_eq!(g.name, "a.md");
        assert_eq!(g.rel_path, "a.md", "相对路径不含工作区前缀");

        // 链接目标里那处必须被抹掉 —— 正文渲染后它并不存在，
        // 算进来的话前端点第 N 条会跳到第 N+1 处
        assert_eq!(
            g.count, 4,
            "应命中 4 处（URL 里那处不计），实际片段：{:?}",
            g.matches.iter().map(|m| m.snippet.as_str()).collect::<Vec<_>>()
        );

        let ordinals: Vec<u32> = g.matches.iter().map(|m| m.ordinal).collect();
        assert_eq!(ordinals, vec![0, 1, 2, 3], "序号必须连续递增且从 0 起");

        let lines: Vec<u32> = g.matches.iter().map(|m| m.line).collect();
        assert_eq!(lines, vec![3, 3, 5, 7], "行号应为 1 起且保持文件顺序");

        // 同一行两处按列号递增
        assert_eq!(g.matches[0].col, 0, "行首匹配列号应为 0");
        assert!(
            g.matches[1].col > g.matches[0].col,
            "同行第二处列号应更大：{} vs {}",
            g.matches[1].col,
            g.matches[0].col
        );
        // 掩码是等长替换，所以第 5 行的列号仍按原始行算
        assert!(g.matches[2].snippet.contains("报表"), "链接文字应保留在片段里");

        assert_eq!(r.total_matches, 4);
        assert!(!r.truncated);
    }

    #[test]
    fn search_masks_link_targets_but_keeps_visible_text() {
        let d = workdir("search-mask");
        write(
            &d,
            "m.md",
            // ZZZUNIQUE 出现三次：链接目标 / 标签之间 / 裸文本
            "链接目标 [正常文字](https://example.com/ZZZUNIQUE) 结束。\n\n标签之间 <span>ZZZUNIQUE</span> 结束。\n\n裸文本 ZZZUNIQUE 结束。\n"
                .as_bytes(),
        );

        let r = search(&d, "ZZZUNIQUE");
        let g = &r.files[0];
        assert_eq!(
            g.count, 2,
            "链接目标应被抹掉，标签之间的文字应保留（渲染后可见）：{:?}",
            g.matches.iter().map(|m| m.snippet.as_str()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn search_is_case_insensitive_by_default_and_can_be_tightened() {
        let d = workdir("search-case");
        write(&d, "c.md", b"report Report REPORT\n");

        let loose = search(&d, "REPORT");
        assert_eq!(loose.files[0].count, 3, "默认应忽略大小写");

        let tight = tauri::async_runtime::block_on(search_workspace(
            s(&d),
            "REPORT".to_string(),
            None,
            None,
            Some(true),
        ))
        .expect("应成功");
        assert_eq!(tight.files[0].count, 1, "区分大小写时只应命中一处");
    }

    #[test]
    fn search_truncates_at_limit_and_flags_it() {
        let d = workdir("search-limit");
        write(&d, "a.md", b"needle\n");
        write(&d, "b.md", b"needle\n");
        write(&d, "c.md", b"needle\n");

        let r = tauri::async_runtime::block_on(search_workspace(
            s(&d),
            "needle".to_string(),
            Some(1),
            None,
            None,
        ))
        .expect("应成功");

        assert_eq!(r.files.len(), 1, "limit=1 只应返回一个文件");
        assert!(r.truncated, "被截断时 truncated 必须为 true，前端据此提示用户");
        assert_eq!(r.scanned_files, 3, "scanned_files 仍应报告真实扫描量");
    }

    #[test]
    fn search_handles_empty_query_and_empty_tree() {
        let d = workdir("search-empty");
        write(&d, "a.md", b"content\n");

        let r = tauri::async_runtime::block_on(search_workspace(
            s(&d),
            "   ".to_string(),
            None,
            None,
            None,
        ))
        .expect("空白查询应正常返回");
        assert_eq!(r.total_matches, 0);
        assert!(r.files.is_empty());

        let e = workdir("search-nodir");
        let missing = e.join("nope");
        assert!(tauri::async_runtime::block_on(search_workspace(
            s(&missing),
            "x".to_string(),
            None,
            None,
            None,
        ))
        .is_err());
    }

    #[test]
    fn search_skips_binary_and_huge_files() {
        let d = workdir("search-skip");
        write(&d, "ok.md", b"needle\n");
        // 含 NUL 的 .md：内容上是二进制，应跳过
        write(&d, "bin.md", b"needle\x00\x00\n");
        // 超过 8MB 上限
        let mut big = Vec::with_capacity(9 * 1024 * 1024);
        big.extend_from_slice(b"needle\n");
        big.resize(9 * 1024 * 1024, b'x');
        write(&d, "big.md", &big);

        let r = search(&d, "needle");
        assert_eq!(r.scanned_files, 3, "三个文件都应被扫描到");
        assert_eq!(r.files.len(), 1, "只有 ok.md 应产生命中");
        assert_eq!(r.files[0].name, "ok.md");
    }
}
