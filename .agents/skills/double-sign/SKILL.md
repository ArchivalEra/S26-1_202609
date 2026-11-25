---
name: double-sign
description: >-
  Coordinator-facing blind verification skill. Invoke when verifying homework or
  note calculations/answers by assembling a strictly isolated prompt for a
  subagent with problem statements only and machine-checking via Octave or
  Python BigInt.
---

# 双签：主线程隔离派单与机器验算

本 skill **给主线程用**，负责构造绝对隔离的子代理盲测 prompt，确保子代理无法看到仓库解答。

## 1. 给盲测子代理的硬模板（缺一条都退化）

主线程先把纯题面（文字与必需题图）直接放进 prompt（可以把多题一并发过去，但必须强制逐题顺序作答），并在 prompt 开头锁死五条禁令：

1. **禁止读取任何文件**（严禁 Read/Grep/查看仓库内任意 `.md` 解答、笔记或攻略）。
2. **禁止修改或创建任何文件**（只做计算与回答，零写盘、零改 `Walkthrough.md`）。
3. **每次只允许算一道题**：严格按一题算完并输出后再算下一题，**严禁把几题捆在一起同时算或一次批算攒着输出**。
4. **禁止裁剪或二次加工图片**（看不清直接按原样报错，禁止反复裁图试错）。
5. **最短形式输出**：每题只回 `题号 | 最终答案 | 一行算法 | 验证命令与输出`。

**主线程巡检红线**：派单后**每 5 分钟**检查一次子代理状态；一旦发现几题一起做或越界读/写文件，**直接 kill，没有多余动作**。

## 2. 验算工具分工（Octave 实测坑）

| 题型 | 指定工具 | 非显而易见的坑 |
| :--- | :--- | :--- |
| 矩阵 / 方程组 / 复数 / 进制 | `octave-cli --no-gui -q` | 整数 $> 2^{53}$ 会丢精度；没有 `symbolic` 包；分数题用 `[N,D]=rat(...)` 或仓库 `ratfmt.m` 取精确有理数，**不比浮点近似** |
| 大整数 / 精确有理分数 / 组合 | Python `int` / `fractions.Fraction` | — |
| 含参恒等式 / 布尔化简 | Python / Octave 全组合数值穷举 | 4 变量逻辑式跑完 16 组真值 |
| 多步推导 / 证明题 | 逐相邻两步建表达式等价验证 | **禁止只验首尾相等**（中间步写错也能首尾一致） |

## 3. 主线程对照与落盘

- 独立结果 vs 仓库结果全一致 → 在页面关联的 GitHub Issue 更新 `是否双签` 状态（不回页面建 `## 双签` 或 `### 双签` 节；页面 `## 完成边界` 只留 `[issue #N](...)`）；
- **出现分歧** → 只报差异（题号、仓库值、独立算值），待确认后再改，不让子代理顺手改答案。
