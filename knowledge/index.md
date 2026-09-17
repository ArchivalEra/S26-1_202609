---
id: okf.math.catalog_index
name: Mathematics Knowledge Base Catalog Index
type: CatalogIndex
spec_version: "0.2"
last_updated: "2026-09-17"
stewards:
  - team: Math Research & Personal Practice
domains:
  - id: linear-algebra
    name: Linear Algebra & Matrix Theory
    path: knowledge/linear-algebra/
    description: 线性代数、行列式、矩阵运算、特征值与向量空间。
  - id: algebra
    name: Abstract Algebra & Category Theory
    path: knowledge/algebra/
    description: 抽象代数、群论、环模论与范畴论结构。
  - id: analysis
    name: Real & Complex Analysis
    path: knowledge/analysis/
    description: 实分析、复分析、泛函分析与测度论体系。
  - id: topology
    name: General & Algebraic Topology
    path: knowledge/topology/
    description: 点集拓扑、同伦同调论与微分流形理论。
---

# 数学知识库索引 (Open Knowledge Format v0.2)

本知识库基于 **Open Knowledge Format (OKF v0.2)** 规范构建，专用于记录数学课堂研习、方法总结与严谨书写规范。

## 架构原则 (Knowledge Architecture Principles)

1. **形式化与规范化写法 (Notation & Writing Standards)**：
   - 遵从 OKF v0.2 规范。
   - 重点沉淀个人推导方法、易错点识别与解题书写规范。不强制要求外部引用，侧重思维方法与计算规范。
2. **日期标注机制**：
   - 每个知识概念文件统一在文件名中标注日期（如 `YYYY-MM-DD-<slug>.md`），便于学习历程沉淀。
3. **双语对齐 (Bilingual Alignment)**：
   - 严守 Git Hook 约束，所有 Markdown 均维持中文与英文（`*.en.md`）双语对齐。

## 知识领域目录 (Domains)

| 领域标识 (Domain ID) | 中文名称 | 核心研究范畴 | 状态 | 规范目录 |
| :--- | :--- | :--- | :--- | :--- |
| `linear-algebra` | 线性代数与矩阵论 | 行列式、矩阵运算、特征值、线性方程组 | `active` | [`knowledge/linear-algebra/`](./linear-algebra/index.md) |
| `algebra` | 抽象代数与范畴论 | 群、环、域、模、范畴 | `active` | [`knowledge/algebra/`](./algebra/index.md) |
| `analysis` | 实分析与泛函分析 | 测度论、勒贝格积分、希尔伯特空间 | `active` | [`knowledge/analysis/`](./analysis/index.md) |
| `topology` | 拓扑学与微分流形 | 点集拓扑、基本群、同调论 | `active` | [`knowledge/topology/`](./topology/index.md) |

### linear-algebra 概念注册表

| 概念 ID | 概念名称 | 文件 |
| :--- | :--- | :--- |
| `2026-09-17-determinants-order-2-3` | 二阶与三阶行列式计算、沙路法则与手算书写规范 | [`linear-algebra/2026-09-17-determinants-order-2-3.md`](./linear-algebra/2026-09-17-determinants-order-2-3.md) |

### algebra 概念注册表

| 概念 ID | 概念名称 | 文件 |
| :--- | :--- | :--- |
| *(待扩充)* | - | - |

### analysis 概念注册表

| 概念 ID | 概念名称 | 文件 |
| :--- | :--- | :--- |
| *(待扩充)* | - | - |

### topology 概念注册表

| 概念 ID | 概念名称 | 文件 |
| :--- | :--- | :--- |
| *(待扩充)* | - | - |
