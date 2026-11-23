---
name: triple-sign
description: >-
  Invoke when auditing theoretical closure and dependency anchors of homework or
  solution pages—checking that every theorem/property used in a solution
  actually exists at the linked dependency page and anchor without modifying
  answer values or unrelated files.
---

# 三签：理论闭环与依赖锚点核查

双签确认数值正确**之后**再跑本关；**只查两件事**：**依赖指向页面及锚点对不对**、**解答用到的理论在依赖里是否闭合**。

## 1. 核查内容（不重算数值、不改无关文件）

1. **抽取对象**：抓取目标作业/解析页的 `## 依赖`（或前置链接表），以及解答正文中显式用到的定理、性质、公式名。
2. **锚点有效**：逐条核对依赖表指向的目标文件与 `#锚点` 在仓库中真实存在，且该段落确实讲到了对应前置知识（不指偏、不断链）。
3. **理论闭合**：解答步骤里出现的每一条定理/法则/定义，必须能在依赖表指向的页面内容里查到（不允许解答用到了某一性质但依赖表只指向 unrelated 基础节）。

## 2. 红线边界

- **严禁修改答案数值**：怀疑计算错退回 `double-sign`，不在此处擅改数。
- **严禁越权改动外围文件**：不改 `Walkthrough.md`、不改 `FACTS.json` / `zreflect/`、不重构正文文风；仅在主线程明确授权修改依赖表或锚点时才动指定页面，或直接把缺锚点/缺定理清单报回主线程。
