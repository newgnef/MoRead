# AI 交接说明 · MoRead 墨读

> 这份文件写给**接手的 AI（或人）**：读完它应当能在不改坏既有约定的前提下继续开发。
> 产品是什么、怎么跑、代码长什么样，看 `README.md`；每处设计决定的**理由**看
> `moread/README.md`（723 行，是最详细的一份）；视觉规则看
> `outputs/design-system/design-spec.md`。

---

## 1. 当前状态

| 项 | 值 |
|---|---|
| 产品 | Windows 只读 Markdown 阅读器（不写用户文件一个字节） |
| 版本 | `0.1.0`，功能完整、可日常使用 |
| 仓库 | <https://github.com/newgnef/MoRead>（public，`main`） |
| 技术栈 | Tauri 2 + WebView2 / Svelte 5 + Vite + TypeScript |
| 源码规模 | 22 个源文件，约 8 700 行（`.ts` / `.svelte` / `.rs` / `.css`） |
| 依赖 | 前端 10 个运行时依赖（见 `moread/package.json`），无 UI 框架、无状态库 |
| 产物 | 安装包 2.69 MiB / 免安装单文件 5.05 MiB |
| 测试 | 11 套用例 214 条断言（另 6 套主题对比度体检）+ Rust 16 条，全部有可重跑命令 |
| 已知缺口 | 设置页、Mermaid、导出 PDF、许可证、GitHub Releases |

**它不是编辑器。**没有光标、撤销栈、脏数据、保存按钮。"只读"是一切的起点，
不是暂时没做。

---

## 2. 环境（本机实测过的版本，别凭印象装）

| 组件 | 本机实际 | 备注 |
|---|---|---|
| Windows | 10/11 x64 | WebView2 运行时已装（147.x） |
| Node | 22.12（托管）/ 24.20（系统） | 前端开发只需要它 |
| Rust | 1.96.0 | **只有打包时需要** |
| MSVC | `C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools` | **是 18，不是 2022**；用 `Installer\vswhere.exe` 找，别硬编码版本目录 |
| Windows SDK | 10.0.26100.0（含 `rc.exe`） | |
| NSIS | `%LOCALAPPDATA%\tauri\NSIS`（3.13） | Tauri 首次打包会自己下，网络受限时见 `moread/README.md` 的哈希表 |

```bash
cd moread
npm install
npm run dev          # 开发，1420（有 HMR 开销，别用它测性能）
npm run preview      # 日常使用 / 性能测量，1421
npm run tauri build  # 打包（先 rm -rf dist，见 §7）
cargo test           # 在 src-tauri/ 下跑，16 条
```

> Rust 的 PATH 需要 `export PATH="$HOME/.cargo/bin:$PATH"`。
> 若 `~/.cargo/bin` 里的 shim 是 0 字节，用 `cp rustup.exe <shim名>` 修。

---

## 3. 架构

```
moread/src-tauri/src/lib.rs     Rust：文件系统命令 + 托盘 + 单实例 + 窗口
        ↑ invoke / event
moread/src/lib/platform.ts      唯一 FS 入口，三通道适配（见下）
        ↑
moread/src/App.svelte           编排层：工作区、标签、监听、搜索、快捷键
moread/src/lib/components/      TitleBar / Sidebar / SidebarRail / SearchPanel /
                                Article / EmptyState / FolderPicker / Icon
moread/src/lib/{markdown,virtual,search}.ts   渲染、虚拟滚动、搜索（纯函数）
moread/src/lib/tokens.{css,ts}  设计令牌（唯一色值来源）
```

### 三通道（`platform.ts`）

| 后端 | 何时 | 实现 |
|---|---|---|
| `tauri` | 桌面版 | `invoke` 调 Rust 命令 |
| `http` | 浏览器开发 | Vite 插件 `tools/dev-fs.ts` 暴露 `/__fs/*` |
| `none` | 静态托管 | 降级成内置示例文档 |

**两套真实后端必须同答案**：`src/lib/search.ts`（浏览器侧）与
Rust `search_workspace` 是同一份契约的两个实现。改任一侧都要跑两侧测试。

Rust 命令：`host_info` `read_text_file`（含 GB18030 回退）`path_exists`
`list_dir` `search_workspace` `watch_workspace` `unwatch_workspace` `take_pending_open`。
桥路由：`/__fs/{ping,list,read,exists,watch,search}`（`watch` 是 SSE）。

### 界面骨架（改布局前必看）

- 左侧栏三页签 **大纲 / 文件 / 历史**，启动默认 **大纲**
- 搜索在**右侧栏**（`SearchPanel.svelte`），入口是标题栏主题按钮左边的放大镜，`Ctrl+F`
- 右侧栏三档：当前标签 / 所有标签（默认）/ 工作区
- 正文列宽 `min(var(--mr-reading-w), 100%)`，右侧栏展开时会收窄

---

## 4. 不可破坏的不变式

违反其中任何一条，都会得到"看起来能用但其实是错的"结果。

1. **只读**：任何路径都不得写用户文档。没有保存、没有自动格式化、没有"顺手修一下"。
2. **`platform.ts` 是唯一文件系统入口**。组件里不许直接 `invoke` 或 `fetch('/__fs/...')`。
3. **搜索的 `ordinal` 契约**：命中用"第几次出现"定位，不用行号；屏蔽 `](...)` 与
   `<...>` 时**等长替换**（字符数不变），且序号即使某条未收录也要递增。
   两侧实现各有一组测试（`search-check` / `search-virtual` / `cargo test`）。
4. **虚拟滚动**：`virtual.ts` 里的高度常量必须与 `app.css` 的实际样式一致；
   宽度或字号变化后重算前，**先记"第几块 + 块内比例"再还原**，直接保留 `scrollTop` 会把人推走。
5. **字号只缩放阅读域**：只在 `:root` 放 `--mr-read-scale`，在 `.mr-article` 内重定义字号令牌。
   在 `:root` 上改字号会把标签页和侧栏一起放大。
6. **主题两轴**：`data-theme`（明暗）× `data-palette`（色相）。每加一族调色板必须
   同时写 `[data-palette="x"]` 与 `[data-palette="x"][data-theme="dark"]` 两块，
   漏了深色块 = 深色下还是浅色纸底。`tools/theme-check.mjs` 会查出来。
7. **全站只有一处阴影**（`--mr-shadow-popover`，仅浮层）。其余层级一律 1px 细线。
8. **主题切换零过渡**：有过渡会闪白；`prefers-reduced-motion` 命中时全过渡置零。
9. **搜索结果顺序不随交互重排**：只按文件名排；当前文档只用墨绿文件名标出。
   点一条结果后列表若换位，用户要点的第二条就跑了。
10. **安装包**：`src-tauri/installer-hooks.nsh` 必须纯 ASCII；不要 fork 949 行的 NSIS 模板，
    改行为一律走 `bundle.windows.nsis.installerHooks` 的四个 hook 宏。

---

## 5. 测试怎么跑

前置：开发服务器在 1420（`npm run dev` 或 `npm run preview`）。

**自起浏览器的（直接跑）**：

```bash
node tools/tabs-overflow-check.mjs     # 标签溢出四档，19 条，端口 9223
node tools/splitter-check.mjs          # 侧栏拖宽 / 折叠 / 长文档不跑位，33 条，9225
node tools/theme-check.mjs             # 六套主题对比度（纯 Node，不用浏览器）
node tools/theme-ui-check.mjs          # 主题端到端，24 条，9231
node tools/font-check.mjs              # 字号 / Ctrl+滚轮，29 条，9235
node tools/history-check.mjs           # 历史 + 默认页签，24 条，9241
node tools/search-panel-check.mjs      # 右侧搜索栏，24 条，9242
```

**需要一条持久 CDP 会话的（用 runner，它起浏览器并补 `--cdp`）**：

```bash
node tools/run-with-browser.mjs tools/e2e-check.mjs \
  --url "http://127.0.0.1:1420/?ws=<工作区>" --out <结果目录>
# 同理：search-check（14）、search-virtual（11）、tabs-check（28）
# e2e-check 还要 -- --doc <那一篇文档的绝对路径>
```

Rust 侧：`cd src-tauri && cargo test`（16 条）。

> **测性能前必须重启 dev server**：HMR 累积的旧模块实例会让帧率腰斩
> （59 → 31 fps 的误判就是这么来的）。用 `npm run preview` 更稳。

---

## 6. 下一步该做什么（按价值排）

1. **设置页**（`tauri-plugin-store`）。目前宽度、字号、主题、搜索范围散在
   `localStorage` 的 6 个键里，缺一个可以总览与重置的地方。
2. **固定标签 sticky**：Chrome 把固定标签钉在左侧，当前实现会随横向滚动被滚出视野。
   需要为固定标签单开一个不滚动的左区。
3. **GitHub Releases**：两个 exe 被 `.gitignore` 挡在仓库外，clone 下来拿不到成品。
4. **LICENSE**：公开仓库但没有许可证，法律上别人不能用。建议 MIT。
5. **Mermaid / 导出 PDF**：需求文档里列为 M7 收尾项，一直没做。
6. 桌面版的交互验证目前只能人工过（WebView2 不接受 `--remote-debugging-port`）。

---

## 7. 踩过的坑（按主题，避免重复）

**构建 / 打包**
- `rm -rf dist` 必须在 `npm run tauri build` **之前单独执行**。放在同一条命令里会被
  沙箱的安全删除拦住；而先 `npm run build` 再 `tauri build` 也会在 `beforeBuildCommand`
  的 vite `emptyDir` 处失败。
- 改前端也会让整个 crate 重编（前端资源编进二进制），release 约 2–5 分钟。
- 直接 `grep` exe 找前端字符串找不到：Tauri 把 assets 用了 brotli 压缩。
  判据是构建日志里的 chunk 名是否与单独 `npm run build` 一致。

**测试工具**
- 无头截图用 `msedge --headless=old`；`--screenshot` 遇到 SSE 长连接永远等不到
  network-idle，所以一律走 CDP（`tools/cdp.mjs`，零依赖）。
- 无头环境下 `setPointerCapture` 会**返回成功但不生效**（pointermove 全落在 window 上）。
  拖拽一律把监听挂 `window`，capture 只当额外保险。
- PowerShell 脚本含中文必须存成 **UTF-8 带 BOM**，否则 5.1 按 ANSI 读会语法错；
  `$pid` 是只读自动变量，不能当参数名。

**编码 / 脚本**
- `.bat` **必须 100% ASCII**（cmd 按 GBK 解析 UTF-8，乱码里混进 `& | >` 会把语法搞坏）。
- `installer-hooks.nsh` 同理，纯 ASCII。
- Rust 字节串 `b"..."` 不能含非 ASCII，中文写 `"中文".as_bytes()`。

**平台**
- Tauri 的窗口操作要在 `capabilities/default.json` 逐条授权（`core:window:allow-set-title`），
  漏了会**静默被拒**。
- Git Bash 会改写命令行里的 `C:\...` 参数；模拟真实文件关联要用 PowerShell `Start-Process`。
- `src-tauri/target` 在 `.gitignore` 里必须写全 `moread/src-tauri/target/`，
  只写 `src-tauri/target/` 只匹配仓库根（首次 `git add` 因此装了 9117 个文件，耗时 2m16s）。

---

## 8. 接手时的操作建议

- **改之前先读 `moread/README.md` 对应章节**，那里写了每个决定的理由；很多"看起来可以简化"
  的地方都是踩过坑才写成那样。
- 一次只改一个能力，改完立刻跑对应 check；跨层改动（`platform.ts` ↔ Rust）两侧都跑。
- 提交信息用中文 `type: 简述`（feat / fix / chore / refactor / docs）。
- 不要动 `.workbuddy/`（会话记忆与内部状态，已 gitignore）。
- 截图、测试报告、安装包统一放 `outputs/app/`，文件名带阶段号（如 `M14-侧栏-默认大纲.png`）。
- 需要视觉核对时**必须看截图**，不要凭 CSS 推断：16px 图标、行高、对齐这些问题
  在原尺寸下看不出来，要放大看。
