# AGENTS.md：常驻规则与路由

本仓为中文「学期课程学习仓库」：`课程总览/` 按课程分类保存学习资料，`站点/` 为自建静态阅读站。

## 真相源与路由

- **原则与机器判据**：住 [PRINCIPLES.md](./PRINCIPLES.md)（由 `zreflect/doc.py` 与 `reflect-local/principles.json` 渲染，每次提交真跑复验）。
- **活状态与计数**：住 [STATE.md](./STATE.md) 与 `FACTS.json`（只采集一次，引用写 `[[键名]]`）。
- **配置与门禁入口**：`knobs.json`；总入口 `python3 zreflect/registry.py --run commit`（已关闭 `check_readme_sync.py` 与 `README.md` 自动改写）。
- **悬案与翻案**：未决事项与外包建单住 `questions/*.md`（带 `**Status:**` 与可执行 `**Settling:**`），已翻案旧断言进 `retractions.json` / `invariants.json`。
- **历史与踩坑**：已定案决策背景与复盘住 [HISTORY.md](./HISTORY.md)（非扫描面）。
- **技能与续接**：日常入库/读图用 `course-intake`，独立验算派单用 `double-sign`，理论闭环与依赖锚点复核用 `triple-sign`；无 `handoff` 文件，新会话状态现算 `python3 zreflect/next.py`。

## 固定课表与常驻红线

1. **固定课表先行（不知时段不读正文）**：周一 `08:00` 电路原理 / `09:50` 电气前沿 / `18:00` 电子技术；周二 `13:30` 电力大数据；周三 `09:50` 电路原理 / `18:00` 电子技术；周四上午 电机学 / `13:30` 工程数学。星期或时段对不上时，**不打开转写正文、不做解析**，直接列文件名给用户确认。
2. **不猜补、缺件唯一产地与自动隐身边界**：缺条件/原图/板书及需配图缺图一律不猜补，全部收敛到 GitHub Issue（内写简短三项：`是否缺件 / 是否双签 / 是否三签`）与 `questions/*.md` 悬案单（缺图外包 `multisim`）；页面正文严禁出现缺件/未双签/已解析描述及 `### 条件备注`，`## 完成边界` 只允许写唯一指针 `[issue #N](...)`（构建期自动检查 issue 开闭态，关了整节隐藏）。
3. **区分来源身份与单题监督**：教材原文、整理补充、学生草稿严格区分；正式作业题号与截止时间只认学习通通知。首次笔记/解析子代理与 `double-sign` 子代理**一次只允许算一道题**，主线程**每 5 分钟**巡检一次，发现几题一起做或越界读写直接 kill。
4. **原件、命名与格式边界**：`/mnt/hdd/study/` 根层散落文件当天归进 `<课>/原始资料/`，每个转写必须按 `yyyymmdd_hhmmhhmm-原文.<ext>` 规范重命名（不登记文件哈希）；`.kimi-code/`（`.kimi-code/` is never committed，插件协议唯一真相源在 `.kimi-code/学习通API/protocol/`）永不入库推送。读图副本统一 JPG、归档原件无损 JXL、站点呈现 WebP。
5. **本地 `act` 跑 CI，用户自己点推送**：提交前跑完 `zreflect` 门禁与本地 `act` 验证构建/测试，不擅自 `git push`，由用户亲自推送。
   `act` 必须带 **`--action-offline-mode`**（2026-11-24 实测：不加它会去 clone `actions/checkout`／`actions/setup-node`，容器内常报 `no route to host` 或 `connection timed out`，job 直接失败；加了开关只要缓存里有 action 就不再联网）：
   `act push -W .github/workflows/deploy.yml -P ubuntu-latest=catthehacker/ubuntu:act-latest --container-architecture linux/amd64 --action-offline-mode`
