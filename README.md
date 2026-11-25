# S26-1 课程知识库

2026 年秋季学期 · 九门课的学习记录与静态阅读站。

## 三种交互方式

### 1. 人类自己导航（浏览器阅读站）

**[进入在线阅读站 →](https://isui.ren/repo/S26-1_202609/)**

顶栏与阅读控件说明：

- **导航树（`#drawer-toggle`）**：左侧汉堡按钮展开/收起课程导航树（边界可拖宽），右侧附当前页小节目录跳转。
- **全站搜索（`#search-toggle`）**：顶栏放大镜按钮（或快捷键 `/`、`Ctrl+K`）打开全站搜索面板，中文按字面子串精准匹配。
- **调色盘与昼夜（`#palette-toggle`）**：切换主题强调色色相、明暗主题（昼夜/深浅）与正文字号。
- **能力包与计算笔记本（`#pack-toggle` / `#notebook-toggle`）**：右上角胶囊左半可按需下载`公式编辑器`（MathLive）、`计算内核`（Octave / Pyodide）与公式渲染器，下载后可原地点击编辑公式并在页面内直接求值；右半为计算笔记本，不下载时全站保持只读。
- **作业渐进提示**：作业页提示与解答分层折叠——先独立演算，卡住再逐层展开。

### 2. 机器直读 `/machine/`（全站源文镜像）

- **全站入口**：[`https://isui.ren/repo/S26-1_202609/machine/Birthright.html`](https://isui.ren/repo/S26-1_202609/machine/Birthright.html) —— 全站目录树，每个叶子节点均为完整 URL，点开或抓取即可，无需自行拼接规则。
- **路径映射**：`.html` 页面与 `.json` 源文一一对应，将页面路径中的 `.html` 替换为 `.json` 并加 `machine/` 前缀（例如 `…/课程总览/工程数学/Walkthrough.html` → `…/machine/课程总览/工程数学/Walkthrough.json`），返回渲染前整篇源文（原始 Markdown、TeX 公式源码、图片完整 URL）。
- **大页面分片**：整页过大时可读取同目录下的 `_index.json`（列出各小节的 `heading`、字数与文件名），按需抓取 `<页面>/<file>`。

### 3. 客户端浏览器 WebMCP 接口（交互 + `Skill.md`）

已打开站点页面时，可通过浏览器侧 WebMCP（`document.modelContext` / `navigator.modelContext`）直接操控页面导航、展开折叠解答、点开符号气泡、按图转码与截图：

- **线上纯文本契约（推荐直接喂给 Agent / 小模型）**：[`https://isui.ren/repo/S26-1_202609/Skill.md`](https://isui.ren/repo/S26-1_202609/Skill.md)
- **仓内源文件**：`./站点/Skill.md`（[GitHub 查看](https://github.com/ArchivalEra/S26-1_202609/blob/main/%E7%AB%99%E7%82%B9/Skill.md)）· 架构说明：`./站点/README-WebMCP.md`
- **开启方式**：访问站点时在 URL 追加 `?relay=1`（或 `?webmcp=1`，亦可设 `localStorage.webmcp_relay = 'on'`），配合本机 `@mcp-b/webmcp-local-relay`（默认 `ws://127.0.0.1:9333`）或 `./站点/Skill.md` 附带的零依赖 WebSocket 转发器示例，即可列出并调用全部 11 个 `site_*` 工具。

<!-- COURSE-STATUS:START -->

## 课程状态

**本表是各课状态的唯一产地**：课程页与各资料页顶端的状态都从这里继承，不要在别处另写。
只允许两档——**开课**（本学期还在上）与**结课**（已结束）；不设其他档。

| 课程 | 状态 |
| :--- | :--- |
| 工程数学 | 开课 |
| 电力大数据与人工智能 | 开课 |
| 形势与政策 | 结课 |
| 电路原理 | 开课 |
| 电子技术 | 开课 |
| 电机学 | 开课 |
| 劳动教育 | 开课 |
| 电气前沿 | 开课 |
| 通用电气 | 开课 |

<!-- COURSE-STATUS:END -->

<!-- AUTO-CATALOG:START -->

## 课程目录

| 课程 | 资料数 | 入口 |
| :--- | ---: | :--- |
| 劳动教育 | 1 | [进入](./%E8%AF%BE%E7%A8%8B%E6%80%BB%E8%A7%88/%E5%8A%B3%E5%8A%A8%E6%95%99%E8%82%B2/index.md) |
| 工程数学 | 34 | [进入](./%E8%AF%BE%E7%A8%8B%E6%80%BB%E8%A7%88/%E5%B7%A5%E7%A8%8B%E6%95%B0%E5%AD%A6/index.md) |
| 形势与政策 | 4 | [进入](./%E8%AF%BE%E7%A8%8B%E6%80%BB%E8%A7%88/%E5%BD%A2%E5%8A%BF%E4%B8%8E%E6%94%BF%E7%AD%96/index.md) |
| 电力大数据与人工智能 | 8 | [进入](./%E8%AF%BE%E7%A8%8B%E6%80%BB%E8%A7%88/%E7%94%B5%E5%8A%9B%E5%A4%A7%E6%95%B0%E6%8D%AE%E4%B8%8E%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD/index.md) |
| 电子技术 | 46 | [进入](./%E8%AF%BE%E7%A8%8B%E6%80%BB%E8%A7%88/%E7%94%B5%E5%AD%90%E6%8A%80%E6%9C%AF/index.md) |
| 电机学 | 17 | [进入](./%E8%AF%BE%E7%A8%8B%E6%80%BB%E8%A7%88/%E7%94%B5%E6%9C%BA%E5%AD%A6/index.md) |
| 电气前沿 | 1 | [进入](./%E8%AF%BE%E7%A8%8B%E6%80%BB%E8%A7%88/%E7%94%B5%E6%B0%94%E5%89%8D%E6%B2%BF/index.md) |
| 电路原理 | 198 | [进入](./%E8%AF%BE%E7%A8%8B%E6%80%BB%E8%A7%88/%E7%94%B5%E8%B7%AF%E5%8E%9F%E7%90%86/index.md) |
| 通用电气 | 0 | [进入](./%E8%AF%BE%E7%A8%8B%E6%80%BB%E8%A7%88/%E9%80%9A%E7%94%A8%E7%94%B5%E6%B0%94/index.md) |

共 **9** 门课程、**309** 份资料。
<!-- 仓库内容摘要（不含 README）：72bfbb38fa6290d110dc6f31e0589dcaf43a55846415f8f0f0ee6921124e5a92 -->

<!-- AUTO-CATALOG:END -->

## 规则与维护

- 原则与判定：`PRINCIPLES.md` · 常驻规则：`AGENTS.md` · 活状态：`STATE.md` · 变更历史：`HISTORY.md`
- 仓库根层文档（含 `PRINCIPLES.md`、`AGENTS.md`、`STATE.md`、`HISTORY.md`）仅随 Git 仓库提供，不编入阅读站页面
- 各课程首页登记本课全部材料（文件名 + SHA-256）；教材照片原件不入库，存本地 `/mnt/hdd/study/`
- 缺什么、待补什么：看 [GitHub issues](https://github.com/ArchivalEra/S26-1_202609/issues)（open = 没补，closed = 补了）

## 许可

- 自研代码（`站点/`）与原创文字：AGPL-3.0-only，署名 ArchivalEra；完整成分与许可链接见 [`licenses.json`](https://isui.ren/repo/S26-1_202609/licenses.json)（仓内 `./站点/licenses.json`）
- 教材题目与章节结构：归原书作者与出版社；本仓解析仅作学习用途引用
- 站点主题 Shirone M3 Reader（MIT）；KaTeX、MathLive、marked、js-yaml 等第三方库依其自身许可证分发
