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
    description: Linear algebra, determinants, matrix operations, eigenvalues, and vector spaces.
  - id: algebra
    name: Abstract Algebra & Category Theory
    path: knowledge/algebra/
    description: Abstract algebra, groups, rings, modules, and category theory.
  - id: analysis
    name: Real & Complex Analysis
    path: knowledge/analysis/
    description: Real analysis, complex analysis, functional analysis, and measure theory.
  - id: topology
    name: General & Algebraic Topology
    path: knowledge/topology/
    description: Point-set topology, homotopy, homology, and differential manifolds.
---

# Mathematics Knowledge Base Catalog Index (OKF v0.2)

This knowledge base is built upon the **Open Knowledge Format (OKF v0.2)** specification, dedicated to tracking math lectures, proprietary derivation methodologies, and rigorous notation standards.

## Architectural Principles

1. **Formalization & Writing Standards**:
   - Complies with the OKF v0.2 schema.
   - Focuses on personal derivation techniques, diagnostic error correction, and standardized writing. External citations are optional.
2. **Date Stamping**:
   - Every concept file explicitly embeds the date in its filename (`YYYY-MM-DD-<slug>.md`) for clear chronological tracking.
3. **Bilingual Pairing**:
   - Enforced by Git Hooks, all markdown files require exact Chinese and English (`*.en.md`) correspondence in the Git tree.

## Knowledge Domains

| Domain ID | English Name | Core Scope | Status | Canonical Directory |
| :--- | :--- | :--- | :--- | :--- |
| `linear-algebra` | Linear Algebra & Matrix Theory | Determinants, matrix operations, eigenvalues, linear systems | `active` | [`knowledge/linear-algebra/`](./linear-algebra/index.en.md) |
| `algebra` | Abstract Algebra & Category Theory | Groups, rings, fields, modules, categories | `active` | [`knowledge/algebra/`](./algebra/index.en.md) |
| `analysis` | Real & Functional Analysis | Measure theory, Lebesgue integration, Hilbert spaces | `active` | [`knowledge/analysis/`](./analysis/index.en.md) |
| `topology` | General & Algebraic Topology | Point-set topology, fundamental groups, manifolds | `active` | [`knowledge/topology/`](./topology/index.en.md) |

### linear-algebra Concept Registry

| Concept ID | Concept Name | File |
| :--- | :--- | :--- |
| `2026-09-17-determinants-order-2-3` | Evaluation of 2nd & 3rd Order Determinants, Sarrus' Rule, and Scratchwork Notation Standards | [`linear-algebra/2026-09-17-determinants-order-2-3.en.md`](./linear-algebra/2026-09-17-determinants-order-2-3.en.md) |

### algebra Concept Registry

| Concept ID | Concept Name | File |
| :--- | :--- | :--- |
| *(Pending)* | - | - |

### analysis Concept Registry

| Concept ID | Concept Name | File |
| :--- | :--- | :--- |
| *(Pending)* | - | - |

### topology Concept Registry

| Concept ID | Concept Name | File |
| :--- | :--- | :--- |
| *(Pending)* | - | - |
