# 学期课程学习仓库 · 活状态

> 本文件是**活状态文档**：只写「现在是什么」。**数字一律引用台账键**（写法 `[[键名]]`），
> 不手抄——手抄的数字从写下的那一刻起就开始腐烂。文件末尾的机器块由
> `zreflect/facts.py --render-doc` 渲染，不要手改。

## 现在是什么

- **课程**：[[courses]] 门——工程数学、电力大数据与人工智能、形势与政策、电路原理、电子技术、电机学。
- **资料**：课堂笔记 [[notes]] 篇、作业页 [[homework]] 篇、教材解析 [[textbook]] 篇。
- **电路原理习题册**：全册八章 [[problems]] 题已入库（原书无第八章），配图 [[figures]] 张
  （PDF 嵌入原图按图号几何配对；线条与文字分层的图按页面区域合成渲染）。
- **符号气泡体系**：[[symbol_packs]] 个符号包合计 [[glossary_entries]] 条词条；构建期环境包络模型
  （课程级 / 段级 / 符号级三层锚定，零回退）。
- **站点**：自建静态站 [[sitepages]] 页——构建期渲染公式、折叠面板、符号气泡、全站自持搜索。
- **测试**：钩子集成测试 [[hooktests]] 项；站点插件测试与其余命令见各 skill。

## 怎么跑

```bash
python3 zreflect/facts.py                        # 重测全部事实并写台账（掉条/改口会拒绝）
python3 zreflect/facts.py --render-doc STATE.md  # 重渲染机器块（pre-commit 自动做）
python3 zreflect/registry.py --run commit        # 全部 commit 相位闸门（off 单列，不算通过）
sh gates-selftest.sh                             # 每道闸门先证明自己会红
```

## 已知边界

- 台账只覆盖「一条命令能量出来」的机器事实；数学内容的正确性由双签与盲测负责，不进台账。
- 裸数字判据只扫本文件：别的文档里手抄的计数由 `invariants.json` 按片段拦（见该文件的 why）。
- 图片二进制不入库；配图张数以 `课程/电路原理/作业/figures/` 目录计数为准（本台账 figures 键）。
- 数学动画与静态图两条线已放弃（2026-09-20 定案），不在待办里。

<!-- AUTO:FACTS -->
> 本区块由 `zreflect/facts.py --render-doc` 从 `FACTS.json` 渲染，**不要手改**（pre-commit 会重算并 `git add`）。
> 正文里的「测出来的数字」只在这里生产：要引用就写 `[[键名]]`，不要手抄数字。

| 键 | 值 | 测于 | 复跑命令 |
|---|---|---|---|
| `courses` | **9** | 2026-11-11T17:43:34+0800 | `ls -d 课程总览/*/ | wc -l` |
| `discipline` | **ok** | 2026-11-11T17:43:56+0800 | `cd 站点 && node --test plugins/solution-discipline.test.mjs 2>&1 | awk 'NF==3 && $3 ~ /^[0-9]+$/ && ($2=="tests"||$2=="pass"||$2=="fail") {v[$2]=$3} END {t=v["tests"]; p=v["pass"]; fl=v["fail"]+0; if (t=="") {print "discipline：没读到 tests 汇总行" > "/dev/stderr"; exit 1} if (p!=t || fl>0) {print "discipline：red tests=" t " pass=" p " fail=" fl > "/dev/stderr"; exit 1} print "ok"}'` |
| `figures` | **174** | 2026-11-11T17:43:34+0800 | `ls 课程总览/电路原理/作业/figures/ | wc -l` |
| `glossary_entries` | **227** | 2026-11-11T17:43:34+0800 | `awk '/^:::glossary-dict/{f=1;next} /^:::/{f=0} f&&/^sym-/{n++} END{print n}' 站点/符号包/通用.md 课程总览/*/教材解析/符号入门.md` |
| `handoff_lines` | **65** | 2026-11-11T17:43:56+0800 | `wc -l < .kimi-code/handoff.md` |
| `history_state_claims` | **0** | 2026-11-11T17:43:56+0800 | `grep -cE '\*\*(当前|目前|如今)\*\*|^当前|^目前' HISTORY.md || true` |
| `homework` | **29** | 2026-11-11T17:43:34+0800 | `find 课程总览 -path '*/作业/*.md' ! -name 'index.md' | wc -l` |
| `hooktests` | **31** | 2026-11-11T17:43:47+0800 | `python3 .githooks/test-update-readme.py 2>&1 | grep -oE 'Ran [0-9]+ tests' | awk '{print $2}'` |
| `lab_tests` | **74** | 2026-11-11T17:43:35+0800 | `cd .kimi-code/学习通API && node --test chaoxing.test.mjs 判据.test.mjs bridge.test.mjs 2>&1 | awk 'NF==3 && $3 ~ /^[0-9]+$/ && ($2=="tests"||$2=="fail"||$2=="cancelled") {v[$2]=$3} END {t=v["tests"]; f=v["fail"]+0; c=v["cancelled"]+0; if (t=="") {print "lab_tests：没读到 tests 汇总行" > "/dev/stderr"; exit 1} print t; if (f+c>0) {print "lab_tests：fail=" f " cancelled=" c " ⇒ 红测试，非零退出" > "/dev/stderr"; exit 1}}'` |
| `md_files` | **214** | 2026-11-11T17:43:35+0800 | `git ls-files '*.md' | grep -v '^mail/' | wc -l` |
| `notes` | **57** | 2026-11-11T17:43:34+0800 | `find 课程总览 -path '*/课堂笔记/*.md' ! -name 'index.md' | wc -l` |
| `plugin_tests` | **1063** | 2026-11-11T17:43:56+0800 | `cd 站点 && node --test plugins/ 2>&1 | awk 'NF==3 && $3 ~ /^[0-9]+$/ && ($2=="tests"||$2=="fail"||$2=="cancelled") {v[$2]=$3} END {t=v["tests"]; f=v["fail"]+0; c=v["cancelled"]+0; if (t=="") {print "plugin_tests：没读到 tests 汇总行（node --test 没跑完？）" > "/dev/stderr"; exit 1} print t; if (f+c>0) {print "plugin_tests：fail=" f " cancelled=" c " ⇒ 红测试，非零退出（issue #18 决策 #7）" > "/dev/stderr"; exit 1}}'` |
| `principle.assertion_lifecycle` | **ok** | 2026-11-11T17:43:56+0800 | `python3 zreflect/check_retractions.py` |
| `principle.declared_not_globbed` | **ok** | 2026-11-11T17:43:56+0800 | `python3 zreflect/registry.py --gates` |
| `principle.falsifiable` | **ok** | 2026-11-11T17:43:56+0800 | `python3 zreflect/registry.py --selftest` |
| `principle.host_agnostic` | **ok** | 2026-11-11T17:43:56+0800 | `python3 -c "import os,sys;w=['.'+chr(122)+chr(99)+chr(111)+chr(100)+chr(101)+'/','ZCODE_'+'PROJECT_DIR','hook'+'SpecificOutput'];bad=[(d,f) for d in ('zreflect','reflect-hooks') for r,_,fs in os.walk(d) for f in fs if f.endswith(('.py','.sh')) and any(k in open(os.path.join(r,f),encoding='utf-8',errors='replace').read() for k in w)];print('host_coupled=%d' % len(bad));sys.exit(1 if bad else 0)"` |
| `principle.machine_rows` | **ok** | 2026-11-11T17:43:56+0800 | `python3 zreflect/machine.py --selftest` |
| `principle.no_retired_names` | **ok** | 2026-11-11T17:43:56+0800 | `python3 zreflect/check_stale.py` |
| `principle.number_once` | **ok** | 2026-11-11T17:43:56+0800 | `python3 zreflect/check_facts.py` |
| `principle.off_is_visible` | **ok** | 2026-11-11T17:43:56+0800 | `python3 -c "import sys;sys.path.insert(0,'zreflect');import registry, criteria;gs=registry.gates()[0];p=criteria.off_reason_problems(gs);print('off_reason_ok gates=%d problems=%d' % (len(gs), len(p)));sys.exit(0 if gs and not p else 1)"` |
| `principle.only_measured` | **ok** | 2026-11-11T17:43:56+0800 | `python3 -c "import json,sys;d=json.load(open('FACTS.json', encoding='utf-8'))['facts'];bad=[k for k,v in d.items() if not (isinstance(v,dict) and str(v.get('cmd','')).strip())];print('facts_without_cmd=%d' % len(bad));sys.exit(1 if bad else 0)"` |
| `principle.open_questions_settle` | **ok** | 2026-11-11T17:43:56+0800 | `python3 zreflect/check_questions.py` |
| `principle.selfcert_harness` | **ok** | 2026-11-11T17:43:56+0800 | `python3 -c "import sys;sys.path.insert(0,'zreflect');import registry;u=registry.modules()[1];print('undeclared_modules=%d' % len(u));sys.exit(1 if u else 0)"` |
| `principle.snapshot_hygiene` | **ok** | 2026-11-11T17:43:56+0800 | `python3 zreflect/check_snapshots.py` |
| `principle.three_readmes` | **ok** | 2026-11-11T17:43:56+0800 | `python3 zreflect/check_readme_sync.py` |
| `principle.zero_language` | **ok** | 2026-11-11T17:43:56+0800 | `python3 zreflect/check_i18n.py` |
| `problems` | **278** | 2026-11-11T17:43:34+0800 | `python3 -c "import re,glob;print(sum(len(re.findall(r'[0-9]+',s)) for f in glob.glob('课程总览/电路原理/作业/习题册第*.md') for ln in open(f,encoding='utf-8') if ln.startswith('### ') for s in re.findall(r'(?:选|填|计|判|画图)\s*([0-9][0-9、,\s]*)', re.sub(r'（[^）]*）','',ln[4:]))))"` |
| `sitepages` | **180** | 2026-11-11T17:43:35+0800 | `sed -n '/^export const TARGET_FILES = \[/,/^\];/p' 站点/页面清单.mjs | grep -c "^  '"` |
| `symbol_packs` | **5** | 2026-11-11T17:43:34+0800 | `grep -cE "^  '[^']+': '[^']+.md',$" 站点/符号环境.mjs` |
| `symbols_bubbled` | **15323** | 2026-11-11T17:43:56+0800 | `python3 -c "import json;print(json.load(open('站点/dist/symbol-coverage.json'))['symbols_bubbled'])"` |
| `symbols_uncovered` | **0** | 2026-11-11T17:43:56+0800 | `python3 -c "import json;print(json.load(open('站点/dist/symbol-coverage.json'))['symbols_uncovered'])"` |
| `textbook` | **31** | 2026-11-11T17:43:34+0800 | `find 课程总览 -path '*/教材解析/*.md' ! -name 'index.md' | wc -l` |

32 条事实。
<!-- /AUTO:FACTS -->

<!-- AUTO:GATES -->
> 本区块由 `zreflect/facts.py --render-doc` 从发现式名录（zreflect/registry.py 的声明行）渲染，**不要手改**。
> 执行面（hooks / CI）读 `registry --run <相位>` —— 相位是声明字段（`runs_at`），不是文件名。

| 闸门 | 相位 | 它挡住什么 | 消费的旋钮 | 可未启用的理由 |
|---|---|---|---|---|
| `check_ab.py`（A/B 闸门） | commit | A/B 同旗标不变式（非 allow 轴差异 = 混淆变量，A/B 作废） | `REFLECT_AB` | 不做 A/B 对照实验的仓不需要它：规格未配 ⇒ 明说未启用 |
| `check_doc_paths.py`（活文档路径闸门） | commit | 活状态文档里写的仓库内路径必须真实存在（消灭跑不通的判据） | — | — |
| `check_envfile.py`（env 文件闸门） | commit | 守钩子的 REFLECT_* 载体（旋钮 typo / 指向缺失 / 空值） | `REFLECT_ENV_FILE` | 没有 env 载体的仓（旋钮全用默认值）不需要它：规格未配 ⇒ 明说未启用 |
| `check_facts.py`（事实闸门） | commit | 块一致性 / 裸数字 / 坏引用 | `REFLECT_FACTS`, `REFLECT_DOC`, `REFLECT_NAKED_MIN` | — |
| `check_facts_replay.py`（复跑闸门） | commit | 台账 cmd 逐字复跑（裸值契约：stdout 必须等于值） | `REFLECT_FACTS`, `REFLECT_REPLAY`, `REFLECT_REPLAY_TIMEOUT` | 显式设 REFLECT_REPLAY=off 时整道闸门关闭（这是整仓出口；未配时照跑） |
| `check_handoff.py`（handoff 口径闸门） | commit | 进度手记的计数口径：基线唯一且零数字、台账键值不手抄、未竟挂锚——手抄计数出现即红 | `REFLECT_FACTS` | 可插拔模块：口径表未配置且默认位置无表时明说未启用（HANDOFF_SPEC=<表路径> 即启用） |
| `check_i18n.py`（语言覆盖闸门） | commit | 本体零语言：用户可见文本必须走 M(code)；语言包可选 | `REFLECT_I18N_ROOT` | — |
| `check_identity.py`（身份白名单闸门） | commit | 只有上游发放的 id 才许出现在活代码里，自造 id 出现即红 | — | 可插拔模块：规格表未配置且默认位置无表时明说未启用（配 IDENTITY_SPEC 表即启用） |
| `check_instruments.py`（仪器生命周期闸门） | commit | 恒常检测（first_seen）+ 被证伪量法登记 | `REFLECT_INSTRUMENTS`, `REFLECT_INSTRUMENT_DAYS`, `REFLECT_FACTS` | 两个旋钮都未配 ⇒ 特化机制没启用（可插拔，本仓按需再开） |
| `check_invariants.py`（不变量闸门） | commit | 声明式不变量：仓库文件必须/不得含某片段（grep 级） | `REFLECT_INVARIANTS` | 不写声明式不变量的仓不需要它：规格未配 ⇒ 明说未启用（可插拔） |
| `check_lint.py`（静态机器检查） | commit | ruff 的 C901/F/E9/B，判据在 ruff.toml —— 「已清」必须由每次提交复跑，不是一次手工跑完写进台账（R-004） | — | 本机没装 ruff（外部工具，不是本仓依赖）⇒ 明说未启用；CI 里 pip 装了它，那道会真跑 |
| `check_locks.py`（锁定源闸门） | commit | 锁定源清单（URL + 文件 + sha256 的内容指纹） | `REFLECT_LOCKS` | 不钉上游字节的仓不需要它：规格未配 ⇒ 明说未启用 |
| `check_pins.py`（pin 闸门） | commit | 派生树 pin 一致性（stamp commit / dirty / 版本串对读） | `REFLECT_PINS` | 没有派生树的仓不需要它：规格未配 ⇒ 明说未启用 |
| `check_questions.py`（悬案闸门） | commit | 未结案的问题必须挂一个能跑的结算件 | `REFLECT_QUESTIONS` | — |
| `check_readme_sync.py`（三语 README 闸门） | commit | 语言版本是同一条断言的三份拷贝：结构互链 + 每次推送同批 | `REFLECT_READMES` | — |
| `check_retractions.py`（翻案重现检测） | commit | 被推翻的断言不许悄悄回来当现状 | `REFLECT_RETRACTIONS`, `REFLECT_DOCS`, `REFLECT_HISTORY_SECS` | — |
| `check_snapshots.py`（模块级快照闸门） | commit | 跨模块 import 的可变全局是值拷贝（陈旧快照）：改成 import 模块 + 读属性 | `REFLECT_SNAPSHOT_ROOT` | — |
| `check_stale.py`（陈旧断言检测） | commit | sha 出处 / 退役名 / 测龄 | `REFLECT_DOCS`, `REFLECT_FACTS`, `REFLECT_HISTORY_SECS`, `REFLECT_RETIRED`, `REFLECT_STALE_DAYS` | — |
| `check_study.py`（工作区闸门） | commit | study/ 不许进 git；根层不许散落转写与照片（归位才能被检索与索引看见） | — | — |
| `check_transcript_privacy.py`（课堂转写隐私闸门） | commit | 转写原件不许新增入库（棘轮：既有欠债记基线，只许缩小） | — | — |
| `check_world.py`（world 闸门） | commit | 声明式验证对象：多线仓库共享验证环境的世界对账 | `REFLECT_WORLD`, `REFLECT_WORLD_LINE` | 单线仓库不需要它：规格未配 ⇒ 明说未启用 |
| `check_lab_integrity.py`（实验空完整性闸门） | lab | 活文件白名单 + 配方回归测试（lab 相位，手动 --run lab） | — | — |
| `check_semantics.py`（语义闸门） | start-of-work | 语义唯一性：一个概念只许一个规范键名，禁用别名出现即红 | — | 可插拔模块：语义表未配置且默认位置无表时明说未启用（配 SEMANTICS_SPEC 表即启用） |
| `doctor.py`（开工预检 doctor） | start-of-work | 进程 / 端口活性（查会死的东西 ⇒ runs_at=start-of-work，不进 pre-commit） | `REFLECT_DOCTOR`, `REFLECT_DOCTOR_TIMEOUT` | 本仓没有 doctor.json 规格：不查进程/端口活性 ⇒ 明说未启用 |

24 道闸门（发现式名录派生 —— 手写清单会漂，加闸门 = 落一个声明行，这里自动长出来）；其中 13 道**可未启用**（末列是**声明**理由，不是运行时状态 —— 此刻谁 off 要看 `registry --run <相位>`）。
<!-- /AUTO:GATES -->
