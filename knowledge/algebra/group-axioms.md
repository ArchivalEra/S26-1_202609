---
id: okf.math.algebra.group_axioms
name: 群公理与基础代数结构
type: Concept
status: active
spec_version: "0.2"
last_updated: "2026-09-17"
stewards:
  - team: Mathematics Research & Knowledge Architecture Team
tags:
  - abstract-algebra
  - group-theory
  - algebraic-structures
sources:
  - title: "Abstract Algebra"
    authors: "Dummit, David S.; Foote, Richard M."
    year: 2004
    type: academic_book
    citation: "John Wiley & Sons, 3rd Edition, ISBN 978-0471433347"
  - title: "Algebra"
    authors: "Lang, Serge"
    year: 2002
    type: academic_book
    citation: "Springer Graduate Texts in Mathematics, Vol. 211, ISBN 978-0387953854"
verified: true
links:
  related: []
---

# 群公理与基础代数结构 (Group Axioms & Fundamental Structures)

## 1. 形式化定义 (Formal Definition)

设 $G$ 为非空集合，$\cdot : G \times G \to G$ 为定义在 $G$ 上的二元运算。若代数结构 $(G, \cdot)$ 满足以下公理，则称 $(G, \cdot)$ 为一个**群 (Group)**：

1. **结合律 (Associativity)**：
   对任意 $a, b, c \in G$，恒有：
   $$(a \cdot b) \cdot c = a \cdot (b \cdot c)$$

2. **单位元存在性 (Identity Element)**：
   存在元素 $e \in G$，使得对任意 $a \in G$，均有：
   $$e \cdot a = a \cdot e = a$$

3. **逆元存在性 (Inverse Element)**：
   对任意 $a \in G$，存在元素 $b \in G$（记作 $a^{-1}$），使得：
   $$a \cdot b = b \cdot a = e$$

若群 $(G, \cdot)$ 额外满足交换律（对任意 $a, b \in G$ 有 $a \cdot b = b \cdot a$），则称 $G$ 为**阿贝尔群 (Abelian Group)** 或交换群。

## 2. 基本性质 (Elementary Properties)

由群公理可形式化推导以下基本性质：
- **单位元的唯一性**：若 $e, e' \in G$ 均为单位元，则 $e = e \cdot e' = e'$。
- **逆元的唯一性**：对任意 $a \in G$，其逆元 $a^{-1}$ 是唯一的。
- **消去律 (Cancellation Law)**：
  - 左消去：$a \cdot b = a \cdot c \implies b = c$
  - 右消去：$b \cdot a = c \cdot a \implies b = c$
- **对合性质**：$(a^{-1})^{-1} = a$，且 $(a \cdot b)^{-1} = b^{-1} \cdot a^{-1}$。

## 3. 典型范例 (Canonical Examples)

| 群符号 | 载体集合 | 运算 | 结构分类 |
| :--- | :--- | :--- | :--- |
| $(\mathbb{Z}, +)$ | 整数集 | 加法 | 无限循环阿贝尔群 |
| $(\mathbb{R}^*, \times)$ | 非零实数集 | 乘法 | 阿贝尔群 |
| $\mathrm{GL}_n(\mathbb{R})$ | $n \times n$ 可逆实矩阵 | 矩阵乘法 | 非阿贝尔李群 ($n \ge 2$) |
| $S_n$ | $n$ 元置换群 | 置换复合 | 有限非阿贝尔群 ($n \ge 3$) |
