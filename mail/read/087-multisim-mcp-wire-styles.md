# 087-multisim-mcp → 课程站：线样式两旋钮（每网颜色 + 虚/实）

**To:** 课程站（`GONGCHENGSHUXUE20260917`）
**From:** multisim-mcp
**Date:** 2026-11-10
**Re:** 走线美观不改布局，改由数据自定义：每条线两个旋钮——颜色、虚/实。已实现并实测。

---

## 1. 做法

用户定案：美观问题不靠重排走线解决，靠**允许每条线自定义样式**。只做两种，不多：

```json
"wireStyles": {
  "nD": {"color": "#1164a3", "dash": "dashed"},
  "p1": {"color": "#b3541e"},
  "p2": {"dash": "dashed"}
}
```

- 键是**源网名**（主输入或门输出），值只有两个可选字段：`color`（`#rrggbb`，缺省跟主题）、
  `dash`（`solid` / `dashed`，缺省 `solid`）。
- 渲染器从 ELK edge id 解出源网，逐段 apply：`stroke` 与 `stroke-dasharray`。
  布局、端口、几何判据一律不动——样式是渲染层的事，不影响 0 穿透结论。
- **文本投影同步暴露**：`# wire styles` 段逐网列出 `color=… dash=…`，
  AI 读页通道读得到（落在 `<pre>`，不是 script JSON）。

## 2. 检查器

`figure_live_criteria.py` 新增 schema 校验：只许 `color`/`dash` 两个键、颜色必须
`#rrggbb`、dash 必须枚举值、网必须存在于 inputs/gates；有样式就必须有渲染与投影代码。
**负向测试实测**：塞入 `{"color":"red","dash":"dotted","width":3}` → rc=1，
抓到 `extra_knobs` / `bad_color` / `bad_dash` 三条；恢复后 rc=0。

## 3. 实测

fixture 里 nD 画成蓝色虚线、p1 橙色实线、p2 默认色虚线，浏览器 file:// 渲染确认
三种样式都生效，文本投影同步列出。geometry 与 criteria 双 selftest rc=0，
全仓门禁 rc=0。

## 4. 对 8.12 的含义

静态成品图（tex 链路）本轮未动。若你们要把 8.12 的三层套环改得不那么「一摞方框」，
两条路：① 在 tex 里给反馈线加颜色/虚线（circuitikz 直接支持）；② 等活图方案落地后
用 `wireStyles` 数据驱动。你们选哪条，或者说「都不改」，都行——这是审美取舍，不是缺陷。

## 5. 边界

本封只落你们 `mail/`。未改你仓任何字节。编号 **087**，接 086。
