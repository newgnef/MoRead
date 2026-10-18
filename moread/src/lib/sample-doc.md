# 快速上手

MoRead 是一个**只读**的 Markdown 阅读器。它不会修改你的任何文件 —— 这条约束是刻意的，它让整个应用少了 70% 的复杂度。

## 1 安装

在 Windows 上安装 MoRead 只需要一步：下载安装包后双击运行。首次启动会自动检测 WebView2 运行环境，若缺失会给出引导，不会静默失败。

```powershell
winget install MoRead.MoRead
# 或从官网下载安装包后双击运行
# 首次启动会自动检测 WebView2 运行时
moread.exe D:/notes/docs/guide.md
```

也可以直接从命令行打开指定文件，支持拖拽到窗口、以及资源管理器双击关联。

## 2 主题与排版

主题、字号与内容宽度都可以在设置面板里实时调整，偏好会自动保存，重启后原样恢复。

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| 正文字号 | `15 px` | 可调 12 – 24 px |
| 内容宽度上限 | `680 px` | 可调 600 – 1400 px |
| 行距 | `1.73` | 中文排版最低 1.7 |

> 正文字号 15px、行高 1.73、阅读宽度上限 680px —— 这是长时间阅读最舒服的一组默认值，全部可在设置中调整。

行内公式（如 $E = mc^2$）与块级公式都走 KaTeX 渲染：

$$
P(A \mid B) = \frac{P(B \mid A)\,P(A)}{P(B)}
$$

## 3 阅读能力

- [x] 多标签、会话恢复
- [x] 大纲导航与阅读位置记忆
- [x] 文档内搜索（`Ctrl+F`）
- [ ] 工作区全文搜索（M3）
- [ ] Mermaid 图表（懒加载）

### 3.1 代码高亮

Shiki 提供两套主题，切换时不重新解析 —— 颜色由 CSS 变量承载：

```java
public class DistributionReservedListPlugin extends AbstractListPlugin {
    @Override
    public void afterBindData(EventObject e) {
        Log log = LogFactory.getLog(getClass());
        ListRow row = (ListRow) e.getSource();
        BigDecimal ttlSum = NumberUtils.toBigDecimal(row.get("ttlSum"), BigDecimal.ZERO);
        if (ttlSum.compareTo(BigDecimal.ZERO) > 0) {
            log.info("未预留吨数 {} 已赋给生产计划", ttlSum);
        }
    }
}
```

### 3.2 表格与定义列表

| 优先级 | 需求 | 状态 |
| :-: | --- | :-: |
| P0 | GFM 完整支持 | 已完成 |
| P0 | 代码高亮 | 已完成 |
| P1 | Mermaid 图表 | 待排 |

定义列表也支持：

阅读列宽
: 正文的最大宽度，默认 680px。超过这个值眼睛需要来回扫行。

## 4 快捷键

| 快捷键 | 功能 | 快捷键 | 功能 |
| --- | --- | --- | --- |
| `Ctrl+O` | 打开文件 | `Ctrl+F` | 文档内搜索 |
| `Ctrl+W` | 关闭标签 | `Ctrl+Tab` | 切换标签 |
| `Ctrl+B` | 切换侧栏 | `F11` | 全屏 |

---

<small>MoRead v0.1.0 · 只读阅读器，零编辑能力</small>
