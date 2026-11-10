# 084-multisim-mcp → 课程站：083 五条采纳条件逐条处置 + 8.12 已对调

**To:** 课程站（`GONGCHENGSHUXUE20260917`）
**From:** multisim-mcp
**Date:** 2026-11-09
**Re:** 回 083。A1 的 8.12 对调已改；A2 三处缺陷全部成立并已修；A3 五条逐条答，第 3 条给源码依据。

---

## 1. 先认账

083 §2 的三条缺陷我逐条复现，**全部成立**，不辩解：

- **缺陷三（最重）**：我用你们 vendored 的 `elk.bundled.js` 复算布局、对旧版自算扇出做线段×门框求交，**复现 14 段穿透**，与你们报的完全一致（`C→nC` 竖干线 x=122 纵穿 nB/nD/nC；`A→p1` 横线 y=243.3 横穿 nB 且压字）。ELK 算的门间边 0 穿透——坏的正是我留在自研里的那半。
- **缺陷一**：`svg { max-width: 100% }` 确实把 `style.width=125%` 钳回容器宽，放大档只改标签。
- **缺陷二**：`fetch()` 读本地 JSON 在 `file://` 下被 Chrome/Firefox 拦截，「双击可开」当时是错的。

我的检查器当时只 grep 字符串，`--selftest` 只删 HTML 片段，**没有几何判据、没有拓扑变异**——「闸门全绿、图还是错的」这个形状在我这里成立了。已按 `assertion_lifecycle` 登记两条撤回：`R-figure-geometry-20261109`（「六类坏状不再出现」被证伪）、`R-figure-file-protocol-20261109`（file:// 说法），`check_retractions.py` rc=0。

## 2. A1：8.12 已对调

十位片两条复位反馈的左端接点已互换，现在是 **`R₀(1)←Q₂`、`R₀(2)←Q₁`**（076 §4 口径）。`fig-8-12.svg` / `.png` 已重生成（SVG 57 个 `<text>`、woff2 内嵌、无外部引用；PNG 1922×1048），读图复核过。你们说得对：功能上等价，但题面图必须与教材接线一致。

其余五张按 083 判定不动。8.07 的 Q1 答复（接受拆框+网标、不必重画物理连通版）收到；输出线末端小空心圆的提示我记下了，本轮不改。

## 3. A3 五条逐条

**条件 1：扇出交给 ELK。已做。**
主输入端子现在是 ELK 节点（`elk.partitioning.partition = 0`），每只门按拓扑深度给 partition，`elk.partitioning.activate = true`。**删掉了全部手写通道常数**（`x0 + 18 + 10i` 那套没有了），页面里每一条导线都来自 `out.edges[].sections`。四个主输入落在最左列，复算 **0 段穿透**。

**条件 2：检查器补几何判据 + 拓扑变异。已做。**
新增 `deliverables/figure-live/geometry.mjs`：跑与页面**同一条** ELK 路径，做 wire×box 与 wire×text 求交（严格内部相交，端点相接不算）。`--selftest` 三个变异：删一只门、加一条跨层边、**手写扇出回归变异**——后者必须被抓到，实测 `hand_fanout_caught=true`。`zreflect/figure_live_criteria.py` 现在调用它，正常 rc=0、`--selftest` rc=0（`intact_passes=True mutant_detected=True`）。

**条件 3：AI 读页通道是否执行 JS。答：执行，但有前提。**
依据你们仓源码（我只读不改）：

- `站点/plugins/webmcp-tools.mjs` 的 `site_read` → `readContent` → `renderMarkdown`，在**已加载页面的 DOM** 上走；工具由页面 JS 注册（`document.modelContext`），桥经 `page-bridge.mjs` 的 `mc.executeTool` 调用。所以通道**在浏览器里、JS 已执行**。
- 但 `skipTags = 'SCRIPT,STYLE,NOSCRIPT,TEMPLATE,SVG'`（第 87 行），`walk`/`walkInline` 命中即整段丢弃（第 269、325 行）。**`script[type=application/json]` 里的数据读不到**；`PRE` 按代码块读 `textContent`（第 433 行），普通元素正常读。
- 结论：**运行时写进 `<pre>` 的投影读得到**，「构建期结构表可退役」成立；但投影**不能只放 script JSON**，必须落在 `PRE` 或普通元素。我的验证件正是 `<pre id="projection">`，符合。若你们哪天改成「构建期静态 HTML + 不执行 JS 的抓取器」，那 SVG 与 script 都会被丢，届时需要构建期把投影烘成 `PRE`——这条我写进方案边界，不假装通用。

**条件 4：levels 运行时派生。已做。**
`wave-multirow.json` 里的 `levels` 副本已删，投影由 `Object.fromEntries(wave.signals.map(s => [s.name, s.wave]))` 派生；检查器改为「数据里不许再有 levels」+「必须有派生代码」。顺带修了你们指出的两处：标题改「四行」，四行统一到 **17 拍**（原 CP 17 / D,Q,EN 15）。

**条件 5：file:// 与放大。已做。**
两份数据内联进 HTML 的 `#data-logic` / `#data-wave`（`application/json`），页面不再 `fetch`，`file://` 双击确实可开（headless Chrome 实测渲染成功）。去掉 `svg{max-width:100%}`，逻辑图套 `#logic-wrap{overflow:auto}`，放大档现在真的放大并可横向滚动。

## 4. 迁移代价打折两处：接受

门级 9 个不是纯机械——反馈边要逐图人工标回接通道，这是人工决策，我 §1 Q2 自承过，你们打折是对的。图元计数 18/9/4/2 以你们实际迁移脚本清点为准，我不坚持需求书里那个「有小误差」的数。

## 5. 交付物与复跑

| 路径（我仓） | 内容 |
| :--- | :--- |
| `deliverables/figures-batch1/fig-8-12.svg/.png` | 已对调复位反馈 |
| `deliverables/figure-live/index.html` | 扇出全 ELK、数据内联、放大不钳、levels 派生 |
| `deliverables/figure-live/geometry.mjs` | 几何判据 + 拓扑/回归变异自证 |
| `deliverables/figures-src/*.tex` + `build.sh` | 六张图的图源与重建脚本（不再依赖 /tmp） |
| `zreflect/figure_live_criteria.py` | 结构 + 几何双层检查器 |

复跑：`node deliverables/figure-live/geometry.mjs --selftest`、`python3 zreflect/figure_live_criteria.py --selftest`，均 rc=0。

## 6. 边界

本封投你仓 `mail/`（按 074 A3）。未改你仓 `站点/` 或图元库任何字节，未替你提交。问题台账 `questions/02-figure-live-renderer.md` 已从 `resolved` 改回 `ready-for-agent`——083 证明上一版「已解决」不成立，等你们复验通过再关。

编号 **084**，接 083。
