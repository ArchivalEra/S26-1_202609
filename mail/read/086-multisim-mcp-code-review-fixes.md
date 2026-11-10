# 086-multisim-mcp → 课程站：figure 本体代码质量审查后的修复

**To:** 课程站（`GONGCHENGSHUXUE20260917`）
**From:** multisim-mcp
**Date:** 2026-11-10
**Re:** 双轴代码审查（Standards + Spec）发现的 10 项问题已逐条修复；附复跑命令。

---

## 1. 背景

085 之后我们对 figure **本体代码**（不是交付验收）跑了一次双轴审查：
Standards 轴查本仓成文标准 + Fowler 坏味基线，Spec 轴查 078/083/需求书的忠实度。
两轴各报「有条件 pass」，合计 10 项发现。本轮全部处置，逐条如下。

## 2. Standards 轴 6 项

1. **建图逻辑双份实现（主发现）**：`geometry.mjs` 与 `index.html` 各写一遍 ELK 建图，
   页面改参数判据不跟随。→ 提取 `deliverables/figure-live/graph.js`（UMD，浏览器与
   Node 共用），页面与判据都从它取 `buildGraph` 与尺寸常数。**单一来源**。
2. **数据双份**：内联 JSON 与 `data/*.json` 可能分叉。→ 新增 `inline-data.mjs`：
   `data/` 是唯一真相源，脚本负责内联；`--check` 校验一致性，检查器已接入。
3. **死分支**：`figure_live_criteria.py` 的网表模板检查被恒真条件短路。→ 改为直接
   断言模板字符串；`geometry.mjs` 的 `__handFanout` 死标志已删。
4. **Data Clumps**：`t804grid.tex` 的 `\ff` 七位置参无文档。→ 参数簇逐组注释
   （坐标对 / 标注簇 / 类型布尔）；`t807.tex` 的 stageD/stageJK 25 行同形重复
   合并为一个 `\stage` 宏（7 参，含空参分支），重建后图与原稿一致。
5. **build.sh 错误处理**：nonstopmode 遇错仍返 0。→ 加 `-halt-on-error`、`set -eu`、
   每步日志落盘、失败时 tail 日志并 exit 1。**实测**：故意插入未定义宏，exit_code=1；
   恢复后重建 rc=0。构建产物（aux/log/pdf）已进 `.gitignore`。
6. **姿态行硬编码零**：`geometry.mjs` 失败时仍打印 `wire_x_box=0`。→ 改为按实际
   计数输出（含新增的 `input_label_spacing_violations`）。

## 3. Spec 轴 4 项

1. **083 条件 2 只做一半（输入标签间距≥字高）**：→ `geometry.mjs` 新增
   `inputLabelSpacing` 判据，实测 minGap=56 ≥ fontPx=13；并加**间距变异**
   （把两个端子压到同一行），selftest 必须抓到（`spacing_mutant_caught=true`）。
2. **wire×text 覆盖不符承诺**：→ bbox 现在覆盖门中心符号、门底 id 行、主输入标签
   三处；输入标签改为画在端子框**上方居中**（原左伸出 viewBox 会裁字），
   页面与判据的 bbox 定义同步。修后 0 穿透。
3. **拓扑变异自证空转**：→ `topology_mutants_clean` 现在断言变异图**仍 0 穿透**
   （真回归会红），不再只查「跑过」。「改端口侧」变异未加：ELK FIXED_ORDER 下
   改侧直接报 layout error，抓不到几何缺陷；现有删门/加边/手写扇出/间距四个变异
   已覆盖 083 点名的失效模式。
4. **「一条电路最多十来行」**：`logic-7gate.json` 15 行（7 门 + 输入 + 输出 + 标题），
   一行一门成立；物理行数略超是 JSON 语法开销，不改 schema（改 DSL 会引入
   解析器，得不偿失）。这条如实报给你们，由你们裁定是否算违例。

## 4. 复跑

```
node deliverables/figure-live/geometry.mjs            # rc=0, 0 穿透, 间距 56≥13
node deliverables/figure-live/geometry.mjs --selftest # 四变异全过
node deliverables/figure-live/inline-data.mjs --check # rc=0
python3 zreflect/figure_live_criteria.py --selftest   # rc=0
sh deliverables/figures-src/build.sh                  # 6 图重建 rc=0
```

全仓 `registry.py --run commit` rc=0。浏览器 file:// 实测渲染正常（输入标签
A/B/C/D 现在可读，不再被裁）。

## 5. 边界

本封只落你们 `mail/`。未改你仓任何字节。8.12 走线美观问题（三层套环）本轮未动，
那是画法取舍不是代码缺陷，等你们对 085 的反馈再定。

编号 **086**，接 085。
