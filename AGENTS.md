# AGENTS.md：常驻规则

本仓是中文「学期课程学习仓库」：`课程总览/` 下按课程分类的资料，加 `站点/` 一个自建静态阅读站。
原则见[维护条例](./维护条例.md)，操作规程见[维护细则](./维护细则.md)（冲突以条例为准）；
设计纪律见 [PRINCIPLES.md](./PRINCIPLES.md)，活状态见 [STATE.md](./STATE.md)，
进度手记 `.kimi-code/handoff.md`（不入库），开工先读。

## 一、内容硬约束

- **不猜补**：题面、数值、下标、口误、缺失板书一律不猜；页面不留「待补／待核对／待办」类未做表述，
  缺什么进 GitHub issue（open = 没补，closed = 补了）。`待提供`（外部材料未到）是事实，照写。
- **题面自足**：题目引用的图与要求产出的图都在题面里看得见；只读题面就能把题完整做出来。
- **解答自足**：完整做法写在「完整解答」层，不把步骤推给别页；机器闸 `站点/plugins/solution-selfcontained.test.mjs`。
- **三道内容闸，顺序不能反**：作业／解析入库依次过 ① 反人类解析（「试探／凑／巧妙看出」= 没写完）→
  ② 独立重算（只拿题面重算，管答案）→ ③ 依赖与过程复核（只拿题面 + 依赖表试做，管依赖与过程）。
- **status 两档**：只能是「开课」或「结课」，语义是这门课还在不在上。
- **白名单精确**：`.gitignore` 是 `*` → `!*/` → 逐文件 `!/完整相对路径`，禁通配符；新文件先加白名单再 `git add`。
- **索引同进同出**：`课程总览/<课程>/<类别>/` 下任何资料变动，同一次提交逐层更新 index 到 `课程总览/index.md`。
- **handoff 按需更新**（2026-11-12 站长裁定：强制闸已关）：handoff 只记「下个会话必须
  知道的事」，不写施工流水账；要临时恢复这道闸，导出 `HANDOFF_FRESHNESS=1`。
- **push 即终点**：不等 CI，不轮询。CI 的实际覆盖面是**构建 + 站点测试**（`deploy.yml`），**不跑 Einfacht 闸门**；闸门只在本地提交/推送钩子里跑。所以「等价」仅指这两项，别把「CI 绿」读成「闸门绿」。
- 转写现在都是 `.txt`，直接读；`.githooks/extract-transcript.py` 只用于早期 `.doc → .txt` 转换。
- **课堂转写原件不入库**：原件含教师个人信息与学生发言，本地副本留在
  `课程总览/<课>/原始资料/` 或 `/mnt/hdd/study/<课>/原始资料/`，不跟踪、不加白名单、不推送；
  仓库只入库 `原始资料/index.md` 的文件名、性质说明与 SHA-256 登记，以及整理后的笔记。
- **`/mnt/hdd/study/` 是仓库外的待办区**：新到的转写、照片先落在它的根层，
  **当天就要归进 `<课>/原始资料/`**（照片先过 `.githooks/prepare-photos.py` 再派单）。
  根层出现文件 = 有东西没归位，意味着检索查不到、索引会漏课；
  已归档成 JXL 的原件（JPEG）核对哈希后即可删。闸门 `zreflect/check_study.py`
  在提交时拦「根层散落」与「study/ 被 git 追踪」。
- `.kimi-code/` 一律不推送；助手协议栈真相源在 `.kimi-code/学习通API/protocol/`，`站点/dist` 不出现上游语义。

## 二、图元

新增或改动图元（`站点/图库/*.figures.txt`、`:::figure`）要过一次独立读图复核：只给图与图注，
报「每个门能不能确定、字母什么含义、中间量怎么来的、会不会做错题」。

布局缺陷（线穿方框、字被线切开、朝向不对、标签堆叠）**先停手**：不调几何常数、不遮罩；
同一位置修第二遍说明方向错了，走 `.kimi-code/需求-图元渲染方案选型.md`（要活组件，类比 MathLive）。

## 三、事实系统（Einfacht）

数字只生产一次：计数住 `FACTS.json`，文档引用写 `[[键名]]`；机器块由
`python3 zreflect/facts.py --render-doc STATE.md` 渲染，不手改；改口用 `--accept-changes=k1,k2`
（数真的变了才放行）。闸门 `python3 zreflect/registry.py --run commit`（off 单列，没查 ≠ 通过）。

**手动跑闸门必须先加载 env**，否则 `REFLECT_MEASURE_MODULE` 为空、采集回落占位实现，
`check_facts` / `check_facts_replay` / `check_readme_sync` 会一起误报（看起来像仓库坏了）：

```bash
set -a && . reflect-hooks/Einfacht.env && set +a && export PYTHONPATH=zreflect
python3 zreflect/registry.py --run commit
```

`git commit` 走的 `reflect-hooks/gate.py` 自己会加载 env，所以钩子路径没有这个问题——
只有手工敲命令时才要这条前缀。
翻案进 `retractions.json`，手抄旧值用 `invariants.json` 拦。
悬案 `questions/*.md` 每条带 `**Status:**` 与可区分的 `**Settling:**`。
开工看 `STATE.md`。

提交前：`python3 .githooks/update-readme.py --worktree`、`python3 .githooks/check-markdown.py`、
`python3 .githooks/test-update-readme.py`、`git fsck --no-progress`。

## 四、写作口径

中文、平实陈述，不写自辩；机械做法优先落笔，巧解只作对照；验算必须独立。
写作类页面（备考、Walkthrough、课程索引摘要、README 片段、issue 正文）结论先行，
不丢数字、条件、否定、范围与出处。站点视觉或交互出问题，开浏览器实测。
