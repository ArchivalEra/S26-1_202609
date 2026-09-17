# 数学研究知识库 (Mathematics Research Knowledge Base)

本仓库是一个基于 **Open Knowledge Format (OKF v0.2)** 规范的纯数学理论与形式化知识库，专用于前沿数学体系、代数结构、分析几何与拓扑学的基础概念沉淀、定理推导与学术引用。

## 目录与领域规划

- `knowledge/`：数学核心概念知识库 (OKF v0.2 规范)
  - `algebra/`：抽象代数与范畴论（群、环、域、模、范畴）
  - `analysis/`：实分析、复分析与泛函分析（测度、勒贝格积分、希尔伯特空间）
  - `topology/`：点集拓扑与微分流形
- `.githooks/`：自动化 Git 规范门禁钩子

## 自动化规范与门禁机制 (Git Hooks)

本仓库启用了严格的本地与推送自动化门禁：

1. **`pre-commit`**：
   - **严格白名单制度**：`.gitignore` 遵循严格根目录绝对路径白名单（必须以 `!/` 开头，禁止通配符）。
   - **中英双语强制配对**：所有 Markdown 必须成对提交（`*.md` 必须存在同路径 `*.en.md`）。
2. **`pre-push`**：
   - **主索引与知识库同步约束**：推送涉及 `knowledge/` 概念更新时，强制核查 `knowledge/index.md`、`knowledge/index.en.md`、`README.md` 与 `README.en.md` 是否同步对齐并登记。

## 启用本地钩子

```bash
git config core.hooksPath .githooks
```
