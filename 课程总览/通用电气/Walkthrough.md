---
id: okf.course.general_electric.walkthrough
name: Walkthrough
type: Guide
spec_version: "0.2"
last_updated: "2026-11-25"
stewards:
  - team: 通用电气交叉内容整理
course: 通用电气
category: Walkthrough
sources:
  - 工程数学教材解析第 2、4 章
  - 电路原理课堂笔记 10-21 / 10-26
---

# Walkthrough

> **这一页是什么**：把跨课接口按前置依赖串成可自学的顺序；每一步只打通一个具体卡点，需要某条定理或作业原题时直接链接回原课程锚点。

---

## 第一站 · 从网孔/节点方程到矩阵消元判解

**前置底座**：你已经在电路原理第 1–4 章会列网孔方程 $\mathbf{R}\boldsymbol{I}_M=\boldsymbol{U}_S$（[10-21 网孔电流法](../电路原理/课堂笔记/10-21-网孔电流法.md)）和节点方程 $\mathbf{G}\boldsymbol{V}=\boldsymbol{I}_S$（[10-26 节点电压法](../电路原理/课堂笔记/10-26-节点电压法.md)），现在需要接通《工程数学》[作业 5](../工程数学/作业/作业5.md) 的一般线性方程组判解。

- 先用增广矩阵 $A^*=(A\mid\boldsymbol{b})$ 做初等行变换化行阶梯形，由 $R(A)$ 与 $R(A^*)$ 判清无解、唯一解或无穷多解；
- 对电路法常见的 $n\times n$ 方阵情形，统一 $\det A\neq 0 \iff R(A)=n \iff A$ 可逆 $\iff$ 非齐次唯一解 $\boldsymbol{x}=A^{-1}\boldsymbol{b}$（且齐次仅有零解）；
- 拆清矩阵乘法写方程组为什么要求叠加时受控源置零、非独立电源不能拆开各算各的。

→ 展开：[01-电路矩阵与消元判解](./交叉内容/01-电路矩阵与消元判解.md)
