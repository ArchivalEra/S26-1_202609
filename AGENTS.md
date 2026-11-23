# AGENTS.md：常驻规则与路由

本仓为中文「学期课程学习仓库」：`课程总览/` 按课程分类保存学习资料，`站点/` 为自建静态阅读站。

## 真相源与路由

- **原则与机器判据**：住 [PRINCIPLES.md](./PRINCIPLES.md)（由 `zreflect/doc.py` 与 `reflect-local/principles.json` 渲染，每次提交真跑复验）。
- **活状态与计数**：住 [STATE.md](./STATE.md) 与 `FACTS.json`（只采集一次，引用写 `[[键名]]`）。
- **配置与门禁入口**：`knobs.json`；总入口 `python3 zreflect/registry.py --run commit`（不手跑单脚本充当门禁）。
- **悬案与翻案**：未决事项与外包建单住 `questions/*.md`（带 `**Status:**` 与可执行 `**Settling:**`），已翻案旧断言进 `retractions.json` / `invariants.json`。
- **历史与踩坑**：已定案决策背景与复盘住 [HISTORY.md](./HISTORY.md)（非扫描面）。
- **技能与续接**：日常入库/读图用 `course-intake`，独立验算派单用 `double-sign`，理论闭环与依赖锚点复核用 `triple-sign`；无 `handoff` 文件，新会话状态现算 `python3 zreflect/next.py`。

## 固定课表与常驻红线

1. **固定课表先行（不知时段不读正文）**：周一 `08:00` 电路原理 / `09:50` 电气前沿 / `18:00` 电子技术；周二 `13:30` 电力大数据；周三 `09:50` 电路原理 / `18:00` 电子技术；周四上午 电机学 / `13:30` 工程数学。星期或时段对不上时，**不打开转写正文、不做解析**，直接列文件名给用户确认。
2. **不猜补与缺图外包**：缺条件/原图/板书一律不猜补；作业需配图（电路/线性/波形图）却缺图时，不略过不硬凑，外包 `multisim`（见 `mail/`）并在 `questions/*.md`（Einfacht 悬案单）立单，缺失事项亦可建 GitHub issues（页面正文不留「待补／待核对／待办」）。
3. **区分来源身份**：教材原文、整理补充、学生草稿严格区分；正式作业题号与截止时间只认学习通通知。
4. **原件与 `.kimi-code/` 边界**：`/mnt/hdd/study/` 根层散落文件当天归进 `<课>/原始资料/`；`.kimi-code/`（`.kimi-code/` is never committed，插件协议唯一真相源在 `.kimi-code/学习通API/protocol/`）永不入库推送。
5. **`push 即终点`**：本地验证通过并推送后不轮询等 CI（CI 只跑构建与站点测试，不跑 Einfacht 闸门）。
