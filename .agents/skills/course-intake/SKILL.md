---
name: course-intake
description: >-
  Invoke when processing class transcripts into notes, writing homework
  solutions, organizing `/mnt/hdd/study/` raw files/photos, creating new
  courses, or wiring files into indexes, whitelist, site manifest, and
  Einfacht gates.
---

# 课程资料整理与入库（Failure Delta 版）

只记模型没有本 skill 就会踩的坑与停手闸；白名单、命名=H1=NAV、`Walkthrough` 覆盖、`FACTS` 均由钩子与 `zreflect/registry.py --run commit` 强拦，此处不复述。

## 1. 课表与派单隔离（动手前必过）

- **未知时段硬停手**：拿到新转写先用文件名 `yyyymmdd_hhmmhhmm` 对照 `AGENTS.md` 固定课表。对不上直接报文件名等用户定课，**禁止打开正文烧 token 分析归属**。
- **子代理写入最小化**：派后台代理只整理单篇笔记/作业时，明确锁死只创建/改那 **1 个目标 `.md`**，禁止顺手改 `Walkthrough.md`、`index.md` 或触碰 `zreflect/` / `FACTS.json`。

## 2. 作业缺图外包（禁止偷懒略过）

- 整理作业遇到需要画电路图、线性图、波形图而缺少原图或无法精确手绘时：**禁止静默省略或乱画占位**。
- 外包给 `multisim`（通过 `mail/` 收发流程，见 `mail/README.md`），并在 **`questions/*.md`（Einfacht 悬案系统，带 `**Status:**` 与可执行 `**Settling:**`）** 明确建单登记该题缺图需求。
- 需要独立核数时按 `double-sign` 组装隔离 prompt；需要核依赖锚点时按 `triple-sign` 查理论闭环。

## 3. 教材读图防烧钱（禁反复裁剪）

1. **预处理必走脚本**：先跑 `python3 .githooks/prepare-photos.py <源目录> --out /tmp/reading`（竖屏 + 无损 PNG + ASCII 文件名）；**绝不直接拿原件或裸 `vips` 产物派单**。
2. **分批与读完即停**：单子代理每次 `≤6` 张、只问具体几行字、每张**只用 Read 打开 1 次**；**严禁裁剪、放大、OCR 或修图**。
3. **仅倒立允许旋转**：版面清楚但明显 180° 倒立时，由子代理执行 `python3 .githooks/flip-photo.py <副本.png> --degrees 180` 后重读 1 次；模糊/反光直接报「看不清 + 文件名 + 页码」。
4. **小符号问相对朝向**：二极管/箭头等不问绝对方向，改问「与图中已定参照符号相同还是镜像」。
5. **多页教材拆两段**：先派读图代理把抄录**每读完一张立刻追加**落盘到 `/tmp/<课>-<主题>.md`（防攒到最后超时丢光），再另派不碰图的代理写解析。

## 4. 正式入库收尾顺序

1. 同步改：分类 `index.md` + `原始资料/index.md` + 课程 `index.md`（照片原件不入库，仅写纯文本文件名与 SHA-256；文本转写不入库，原件归 `/mnt/hdd/study/<课>/原始资料/`）+ 同课 `Walkthrough.md`（若该课已建 `Walkthrough.md`，新笔记/作业必须显式接入）。
2. 白名单与站点：`.gitignore` 加精确路径 `!/...` → `站点/页面清单.mjs` 与 `站点/build.mjs` `NAV` 加入口 → `(cd 站点 && node build.mjs)`。
3. 门禁与审批：`REFLECT_LANG=zh python3 zreflect/registry.py --run commit`（改了 `zreflect/`、`reflect-local/`、`knobs.json`、`PRINCIPLES.md` 或 `questions/*.md` 后用 `trust.py --sync` 送审批，全部获批后再 `git commit`）。
