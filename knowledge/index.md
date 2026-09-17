---
id: okf.math.catalog_index
name: Mathematics Knowledge Base Catalog Index
type: CatalogIndex
spec_version: "0.2"
last_updated: "2026-09-17"
stewards:
  - team: Mathematics Research & Knowledge Architecture Team
domains:
  - id: algebra
    name: Abstract Algebra & Category Theory
    path: knowledge/algebra/
    description: 抽象代数、群论、环模论、范畴论与代数几何结构。
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

本知识库基于 **Open Knowledge Format (OKF v0.2)** 规范构建，专用于数学前沿理论、基础抽象结构、形式化证明与定理体系的系统化沉淀与研究。

## 架构原则 (Knowledge Architecture Principles)

1. **形式化与严格性 (Formal Rigor)**：
   - 遵从 OKF v0.2 规范。
   - 所有概念文件具备严格的前置定义、公理假设、定理叙述、证明脉络或参考出处。
2. **双语对齐与版本可追踪 (Bilingual Alignment & Traceability)**：
   - 严守 Git Hook 约束，所有 Markdown 均维持中文与英文（`*.en.md`）双语对齐。
3. **领域结构解耦 (Domain Modularity)**：
   - 各子学科领域独立自洽，通过 OKF 引用体系 (`links.related`) 形成严密的数学概念网状依赖。

## 知识领域目录 (Domains)

| 领域标识 (Domain ID) | 中文名称 | 核心研究范畴 | 状态 | 规范目录 |
| :--- | :--- | :--- | :--- | :--- |
| `algebra` | 抽象代数与范畴论 | 群、环、域、模、范畴、函子、代数拓扑基底 | `active` | [`knowledge/algebra/`](./algebra/index.md) |
| `analysis` | 实分析与泛函分析 | 测度论、勒贝格积分、希尔伯特空间、索伯列夫空间 | `active` | [`knowledge/analysis/`](./analysis/index.md) |
| `topology` | 拓扑学与微分流形 | 点集拓扑、基本群、同调论、微分流形 | `active` | [`knowledge/topology/`](./topology/index.md) |

### algebra 概念注册表

| 概念 ID | 概念名称 | 文件 |
| :--- | :--- | :--- |
| `group-axioms` | 群公理与基础代数结构 | [`algebra/group-axioms.md`](./algebra/group-axioms.md) |

### analysis 概念注册表

| 概念 ID | 概念名称 | 文件 |
| :--- | :--- | :--- |
| *(待扩充)* | - | - |

### topology 概念注册表

| 概念 ID | 概念名称 | 文件 |
| :--- | :--- | :--- |
| *(待扩充)* | - | - |
