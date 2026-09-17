# Mathematics Research Knowledge Base

This repository is a pure mathematical theory and formal knowledge base built upon the **Open Knowledge Format (OKF v0.2)** specification. It is dedicated to foundational concept definitions, theorem formulations, formal proofs, and academic citations in abstract algebra, analysis, and topology.

## Structure and Domains

- `knowledge/`: Core mathematical concepts (OKF v0.2 specification)
  - `algebra/`: Abstract algebra & category theory (groups, rings, fields, modules, categories)
  - `analysis/`: Real, complex, and functional analysis (measure theory, Lebesgue integration, Hilbert spaces)
  - `topology/`: General topology and differential manifolds
- `.githooks/`: Automated Git quality guard hooks

## Automated Enforcement & Guardrails (Git Hooks)

This repository enforces strict pre-commit and pre-push validations:

1. **`pre-commit`**:
   - **Strict Whitelist**: `.gitignore` requires explicit absolute-root paths (must start with `!/`, wildcards prohibited).
   - **Bilingual Pairing**: All markdown files in the Git index must have an exact `*.md` <-> `*.en.md` counterpart.
2. **`pre-push`**:
   - **Catalog Index Sync Guard**: Any push updating concepts in `knowledge/` strictly requires updating `knowledge/index.md`, `knowledge/index.en.md`, `README.md`, and `README.en.md`.

## Enabling Git Hooks

```bash
git config core.hooksPath .githooks
```
