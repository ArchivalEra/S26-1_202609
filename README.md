# S26-1 课程知识库

2026 年秋季学期 · 九门课的学习记录与静态阅读站。

## 在线阅读与界面功能

**[进入在线阅读站 →](https://isui.ren/repo/S26-1_202609/)**

顶栏与页内阅读功能：

- **导航树（`#drawer-toggle`）**：左上角汉堡按钮展开或收起课程导航树（侧栏右缘可拖宽），页内右侧附本页小节目录跳转。
- **全站搜索（`#search-toggle`）**：顶栏搜索按钮（快捷键 `/` 或 `Ctrl+K`）打开全站检索面板，中文按字面子串精准匹配；站内跳转由 SPA 路由无刷新切换。
- **调色盘与昼夜（`#palette-toggle`）**：调节强调色色相、明暗主题（昼夜/深浅）与正文字号。
- **渐进折叠提示**：作业页提示与解答分层折叠，需要时逐层展开。

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

## AGENT 与自动化入口

- [`AGENTS.md`](./AGENTS.md)：仓内常驻规则、课表红线与工作流总路由
- [`HELPERS.md`](https://isui.ren/repo/S26-1_202609/HELPERS.md)（仓内 `./站点/HELPERS.md`）：页面 `?helpers=1` 便利函数文档
- [`Birthright.html`](https://isui.ren/repo/S26-1_202609/machine/Birthright.html)：全站只读源文镜像树（每页含 `_index.json` 小节目录、全文检索在 [`search/index.json`](https://isui.ren/repo/S26-1_202609/search/index.json)、页内符号数据见 `#sym-glossary-json`）

## 维护与许可

- **架构定型声明**：本仓库阅读站与构建管线架构已于 2026-11-27 正式收尾定型，后续**不再进行架构层面改动**，仅持续更新课程笔记、作业与纠错内容
- **缺件跟踪**：[GitHub issues](https://github.com/ArchivalEra/S26-1_202609/issues)（原始资料底稿存本地 `/mnt/hdd/study/` 不入库）
- **许可**：自研代码与原创文字按 AGPL-3.0-only 发布（[`licenses.json`](https://isui.ren/repo/S26-1_202609/licenses.json)），教材原题版权归原书作者与出版社所有
