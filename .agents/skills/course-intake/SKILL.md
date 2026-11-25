---
name: course-intake
description: >-
  Invoke when processing class transcripts into notes, writing homework
  solutions, organizing `/mnt/hdd/study/` raw files/photos, creating new
  courses, or wiring files into indexes, whitelist, site manifest, and
  Einfacht gates.
---

# 课程资料整理与入库（Failure Delta 版）

只记模型没有本 skill 就会踩的坑与停手闸；白名单、命名=H1=NAV、允许标题白名单、`Walkthrough` 覆盖、`FACTS` 均由钩子与 `zreflect/registry.py --run commit` 强拦，此处不复述。

## 1. 转写归档与派单隔离（动手前必过）

- **转写必按规范重命名**：每个转写必须先改名为 `yyyymmdd_hhmmhhmm-原文.<ext>` 归入 `/mnt/hdd/study/<课>/原始资料/`（方便日后检索；**不跑例行缺口扫描**，只有用户明确要求时才调 `工具/录音检索.py`；不再收 `.doc` 脱壳，历史工具在 `工具/提取-doc转写.py`）。
- **未知时段硬停手**：拿到新转写先用文件名 `yyyymmdd_hhmmhhmm` 对照 `AGENTS.md` 固定课表。对不上直接报文件名等用户定课，**禁止打开正文烧 token 分析归属**。
- **单题推进 + 5 分钟巡检 + 越界即杀**：派后台子代理整理单篇笔记/作业时，锁死只创建/改那 **1 个目标 `.md`**（禁止触碰 `Walkthrough.md`、`index.md`、`zreflect/`、`FACTS.json`），且**一次只允许算一道题**（严禁多题混做/攒批）。主线程**每 5 分钟**检查一次进度，发现多题一起做或越界即刻 kill。
- **完成边界单一指针、不另开条件备注**：缺条件/缺原图/双签/三签三态统一记在关联 GitHub Issue（`是否缺件 / 是否双签 / 是否三签`）；页面正文严禁出现缺件/未双签/已解析描述及 `### 条件备注`/`## 双签`/`## 三签`，`## 完成边界` 只允许保留唯一指针 `- [issue #N](...)`（构建期读 issue 开闭态，关后整节自动隐身）。

## 2. 作业缺图外包（禁止偷懒略过）

- 整理作业遇到需要画电路图、线性图、波形图而缺少原图或无法精确手绘时：**禁止静默省略或乱画占位**。
- 在 GitHub Issue 记录缺图项（`是否缺件`）并通过 T3 跨线程消息 `t3_thread_list` / `t3_thread_send` 外包给 `multisim`（跨模块专项任务另记 `questions/*.md`）。
- 需要独立核数时按 `double-sign` 组装隔离 prompt；需要核依赖锚点时按 `triple-sign` 查理论闭环，完成后直接回写关联 GitHub Issue。

## 3. 教材读图防烧钱（读 JPG / 存 JXL / 展 WebP）

1. **预处理必走脚本**：先跑 `python3 .githooks/prepare-photos.py <源目录> --out /tmp/reading`（竖屏 + **JPG** + ASCII 文件名，禁止用大体积无损 PNG 烧 token）；**绝不直接拿原件或裸 `vips` 产物派单**。原件无损归档用 `工具/归档-jxl.py` 存 `.jxl`，网页展示仍用 `.webp`。
2. **分批与读完即停**：单子代理每次 `≤6` 张、只问具体几行字、每张**只用 Read 打开 1 次**；**严禁裁剪、放大、OCR 或修图**。
3. **仅倒立允许旋转**：版面清楚但明显 180° 倒立时，由子代理执行 `python3 .githooks/flip-photo.py <副本.png> --degrees 180` 后重读 1 次；模糊/反光直接报「看不清 + 文件名 + 页码」。
4. **小符号问相对朝向**：二极管/箭头等不问绝对方向，改问「与图中已定参照符号相同还是镜像」。
5. **多页教材拆两段**：先派读图代理把抄录**每读完一张立刻追加**落盘到 `/tmp/<课>-<主题>.md`（防攒到最后超时丢光），再另派不碰图的代理写解析。

## 4. 正式入库收尾顺序

1. 同步改：分类 `index.md` + `原始资料/index.md`（原件不入库，仅登记规范文件名与性质说明，**不再算/登记 SHA-256**）+ 课程 `index.md` + 同课 `Walkthrough.md`（若该课已建 `Walkthrough.md`，新笔记/作业必须显式接入）。
2. 白名单与站点：`.gitignore` 加精确路径 `!/...` → `站点/页面清单.mjs` 与 `站点/build.mjs` `NAV` 加入口 → `(cd 站点 && node build.mjs)`（不自动改写 `README.md`）。
3. 门禁、本地 `act` 与手工推送：`REFLECT_LANG=zh python3 zreflect/registry.py --run commit` + 本地 `act`（必须带 `--action-offline-mode`）跑通 `.github/workflows/deploy.yml` 构建与测试（改了 `zreflect/`、`reflect-local/`、`knobs.json`、`PRINCIPLES.md` 或 `questions/*.md` 后用 `trust.py --sync` 送审批，全部获批后再 `git commit`；**不代点推送**）。
