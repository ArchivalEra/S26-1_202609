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
    description: Abstract algebra, group theory, rings and modules, category theory, and algebraic structures.
  - id: analysis
    name: Real & Complex Analysis
    path: knowledge/analysis/
    description: Real analysis, complex analysis, functional analysis, and measure theory.
  - id: topology
    name: General & Algebraic Topology
    path: knowledge/topology/
    description: Point-set topology, homotopy and homology theories, and differential manifolds.
---

# Mathematics Knowledge Base Catalog Index (OKF v0.2)

This knowledge base is built upon the **Open Knowledge Format (OKF v0.2)** specification, dedicated to systematic mathematical research, formal definitions, theoretical structures, and rigorous proofs.

## Architectural Principles

1. **Formal Rigor**:
   - Complies with the OKF v0.2 schema.
   - Every concept file maintains strict axioms, definitions, formal theorem formulations, proof sketches, and primary citations.
2. **Bilingual Pairing & Traceability**:
   - Enforced by Git Hooks, all markdown files require exact Chinese and English (`*.en.md`) correspondence in the Git tree.
3. **Domain Modularity**:
   - Independent sub-disciplines connected cleanly via cross-concept references (`links.related`).

## Knowledge Domains

| Domain ID | English Name | Core Scope | Status | Canonical Directory |
| :--- | :--- | :--- | :--- | :--- |
| `algebra` | Abstract Algebra & Category Theory | Groups, rings, fields, modules, categories, functors | `active` | [`knowledge/algebra/`](./algebra/index.en.md) |
| `analysis` | Real & Functional Analysis | Measure theory, Lebesgue integration, Hilbert spaces | `active` | [`knowledge/analysis/`](./analysis/index.en.md) |
| `topology` | General & Algebraic Topology | Point-set topology, fundamental groups, manifolds | `active` | [`knowledge/topology/`](./topology/index.en.md) |

### algebra Concept Registry

| Concept ID | Concept Name | File |
| :--- | :--- | :--- |
| `group-axioms` | Group Axioms and Fundamental Algebraic Structures | [`algebra/group-axioms.en.md`](./algebra/group-axioms.en.md) |

### analysis Concept Registry

| Concept ID | Concept Name | File |
| :--- | :--- | :--- |
| *(Pending)* | - | - |

### topology Concept Registry

| Concept ID | Concept Name | File |
| :--- | :--- | :--- |
| *(Pending)* | - | - |
