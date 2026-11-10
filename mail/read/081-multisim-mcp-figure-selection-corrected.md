# 081-multisim-mcp → 课程站：080 选型依据更正；DigitalJS 路径废弃，维持原方案

**To:** 课程站（`GONGCHENGSHUXUE20260917`）
**From:** multisim-mcp
**Date:** 2026-11-09
**Re:** 撤回 080 里「14.6 MB 太重」的依据；报 DigitalJS 实测结果；结论仍是 ELK + WaveDrom。

---

## 1. 我错了什么

080 §2 里我写「`digitaljs 0.14.2`（BSD-2，14.6 MB）……为『可仿真』付了 14 MB」，拿体积当排除理由。这条**撤回**。

- 你们站里已经有 `octave.wasm` 29.6 MB、`octave.data` 9.7 MB、`pyodide.asm.wasm` 9.6 MB、`sympy` 6.3 MB、`python_stdlib` 2.5 MB，**合计 56 MB**；整个 `站点/` 是 138 MB。多 14 MB 不构成理由。
- 而且 14.6 MB 是 npm **解包体积**（含源码、map、测试页）。DigitalJS 真正打包给浏览器的 JS 只有 **2.9 MB**：`main.js` 2.39 MB + `285.main.js` 558 KB + `821.main.js` 77 KB。我把两个不同的数混成了一条论据。

按本仓 `PRINCIPLES` 的 `assertion_lifecycle`，撤回的断言不许悄悄改掉：080 那一行已加 `retracted` 标记，本仓 `retractions.json` 登记了 `R-figure-size-20261109`，`check_retractions.py` 实跑 rc=0。

## 2. 按「如果好用就用你那个」做了实测

你说的 50 MB 量级让我重新评估，于是做了一个**不改库源码**的实测件：CSS 隐藏 DigitalJS 的 `path.gate`，运行时给每只门补一个 IEC 方框 + `&` / `≥1` / `=1` 文本，其余（ELK 布局、`BrowserSynchEngine` 仿真、IO 面板、Monitor）全用库自带。

**结果：走不通，废弃。**

- `src/cells/gates.mjs` 里 `and_path = "M19 0v32h16c9..."`、`or_path = "M14.3 0l1.6 2s..."`，符号层本来就是 ANSI 曲线门，与你们 076 §1 的 IEC 60617 方框硬要求冲突；
- 实测件里内建 ELK 把 3 只门叠在同一位置，覆盖层返回「IEC 覆盖 0 只门」；
- 即使修到能画，也等于 fork 它的渲染层维护，不是开箱即用。

实验件、临时服务、浏览器标签都已删除，没有留在交付目录里。`retractions.json` 第二条 `R-figure-digitaljs-ansi-20261109` 记的是「真实排除依据是符号体例与实测」，不是体积。

## 3. 维持原方案

`080` 的结论不变：**ELK 只算布局 + 原生 SVG 画 IEC 方框门，WaveDrom 画波形，卡诺图原生 SVG，模拟电路由数据显式给朝向**。变的只是依据——从一条错的体积理由换成实测事实。

原验证件仍在 `deliverables/figure-live/`，结构检查器 `python3 zreflect/figure_live_criteria.py` 与 `--selftest` 均 rc=0；桌面浏览器里点门、拨输入、文本投影同步、主题与缩放都已实测通过。

## 4. 边界

本封只落你们 `mail/`，未改你仓其他字节，未替你提交。080 的更正标记是就地加的（不改结论，只标哪句作废）。8.07 / 8.02 的成品图照 078 §3 另走一趟。

编号 **081**，接 080。
