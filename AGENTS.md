# AGENTS.md：常驻规则与路由

本仓为中文「学期课程学习仓库」：`课程总览/` 按课程分类保存学习资料，`站点/` 为自建静态阅读站。

## 真相源与路由

- **原则与机器判据**：全部住 [PRINCIPLES.md](./PRINCIPLES.md)（由 `zreflect/doc.py` 与 `reflect-local/principles.json` 渲染，提交时逐条真跑复验）。
- **活状态与计数**：住 [STATE.md](./STATE.md) 与 `FACTS.json`（只采集一次，正文引用写 `[[键名]]`）。
- **配置旋钮**：根目录 `knobs.json`；执行入口为 `python3 zreflect/registry.py --run commit`（不手跑单个脚本充当门禁）。
- **悬案与翻案**：未决事项住 `questions/*.md`（带 `**Status:**` 与可执行 `**Settling:**`），已翻案旧断言进 `retractions.json` / `invariants.json`。
- **历史与踩坑**：所有已定案的决策背景与事故复盘住 [HISTORY.md](./HISTORY.md)（非扫描面）。
- **入库与校验流程**：按 `.agents/skills/` 调用 `repo-maintenance`、`human-first-solution`、`double-sign`、`triple-sign`；无 `handoff` 文件，新会话状态按需现算 `python3 zreflect/next.py`。

## 少数无法完全机审的人工红线

1. **不猜补**：题面、数值、下标、口误、缺失板书一律不猜；页面不留「待补／待核对／待办」类未做表述，缺项归 [GitHub issues](https://github.com/ArchivalEra/S26-1_202609/issues)（`待提供` 属客观事实，照写）。
2. **区分身份与来源**：教材原文、整理者补充、学生手写草稿须明确区分；正式作业题号与截止时间只认学习通等正式通知。
3. **三道内容闸顺序不能反**：作业/解析入库依次过 ① 反人类解析 → ② 独立重算双签（Octave 优先，不照抄书稿）→ ③ 依赖与过程三签（只读题面与依赖试做）。
4. **读图与原件归位**：批量读图先跑 `.githooks/prepare-photos.py`，再派子代理（每人每次读完一张落盘再读下一张，禁 OCR、字符画与裁剪增强；倒立仅用 `.githooks/flip-photo.py` 旋转）。`/mnt/hdd/study/` 根层散落转写与照片当天归进 `<课>/原始资料/`；`.kimi-code/`（`.kimi-code/` is never committed，插件协议唯一真相源在 `.kimi-code/学习通API/protocol/`）永不入库推送。
5. **图元与写作口径**：布局缺陷（穿框/切字/重叠）先停手不调几何常数；写作类页面结论先行，不丢数字、条件、否定、范围与出处；站点问题开浏览器实测。
6. **push 即终点**：本地验证通过后不轮询等待 CI（CI 只跑构建与站点测试，不跑 Einfacht 闸门，闸门只在本地钩子运行）。
