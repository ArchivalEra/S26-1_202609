# 数学研习与规范化解题知识库 (Mathematics Research & Practice Knowledge Base)

本仓库基于 **Open Knowledge Format (OKF v0.2)** 规范，专用于记录数学课堂授课内容、个人推导方法论、易错点诊断及规范化解题书写。

## 目录结构

- `knowledge/`：核心数学概念与课时归档 (OKF v0.2 规范)
  - `linear-algebra/`：线性代数（行列式、矩阵、初等变换、向量空间）
  - `algebra/`：抽象代数与范畴论
  - `analysis/`：实分析与泛函分析
  - `topology/`：拓扑学与微分流形
- `.githooks/`：Git 自动化规范与门禁钩子

## 知识库规范要求

1. **日期标注机制**：每个知识概念文件必须在文件名中包含日期（例如 `YYYY-MM-DD-<slug>.md`），记录课时学习与推导轨迹。
2. **注重方法与写法规范**：不强制外部引用，重在沉淀个人计算方法、手算避坑诊断与规范化书写标准。
3. **双语对齐与严格白名单**：通过 `pre-commit` 门禁保证 `*.md` 与 `*.en.md` 严格成对，`.gitignore` 遵循严格根目录绝对路径白名单。

## 课时与概念归档

- **2026-09-17**：[`knowledge/linear-algebra/2026-09-17-determinants-order-2-3.md`](./knowledge/linear-algebra/2026-09-17-determinants-order-2-3.md) —— 二阶与三阶行列式计算、沙路法则与手算书写规范
