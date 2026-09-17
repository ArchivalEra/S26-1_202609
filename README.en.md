# Mathematics Research & Practice Knowledge Base

This repository is built upon the **Open Knowledge Format (OKF v0.2)** specification, dedicated to tracking lecture contents, proprietary derivation methods, error diagnostics, and standardized mathematical notation.

## Directory Structure

- `knowledge/`: Core mathematical concepts & lecture archives (OKF v0.2 specification)
  - `linear-algebra/`: Linear algebra (determinants, matrices, elementary transformations, vector spaces)
  - `algebra/`: Abstract algebra & category theory
  - `analysis/`: Real & functional analysis
  - `topology/`: General topology & differential manifolds
- `.githooks/`: Automated Git quality guard hooks

## Repository Guidelines

1. **Mandatory Date Stamping**: Every concept file must embed its date in the filename (`YYYY-MM-DD-<slug>.md`).
2. **Focus on Methodology & Notation**: External citations are not strictly required; emphasis is placed on proprietary methods, scratchwork error diagnostics, and rigorous writing standards.
3. **Bilingual Pairing & Strict Whitelist**: Enforced by `pre-commit`, requiring `*.md` and `*.en.md` pairing and absolute-path `.gitignore` entries.

## Lecture & Concept Archives

- **2026-09-17**: [`knowledge/linear-algebra/2026-09-17-determinants-order-2-3.en.md`](./knowledge/linear-algebra/2026-09-17-determinants-order-2-3.en.md) —— Evaluation of 2nd & 3rd Order Determinants, Sarrus' Rule, and Scratchwork Notation Standards
