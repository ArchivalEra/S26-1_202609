# PRINCIPLES · 本仓设计纪律

> **这不是状态文档。** 这里只写「为什么这样设计」——它不随提交变化。
> 想知道**此刻**是什么样：看 [STATE.md](STATE.md)。
>
> **没有历史文档。** append-only 的经过只在「当时那个条件」下可复现，
> 复不了的就不占一个会被判的位置。

本仓的立身之问：**「你说的『现在如此』，谁替你复跑证明过？」**
所有纪律都是这个问题的推论，每条都对应一次真实事故（断言腐烂时周围全绿）。

## 纪律表（机器渲染，不许手改）

下面是 `zreflect/doc.py` 的 `RULES` 表（上游 Einfacht 同款，逐字节照抄）的渲染结果。
**规矩的唯一产地是那张表**，不是这段散文。

<!-- AUTO:RULES -->
> 本区块由 `zreflect/facts.py --render-doc` 从 `zreflect/doc.py` 的 `RULES` 表渲染，**不要手改**。
> 每行的判定命令都在 `FACTS.json` 里，每次提交被逐字执行（`check_facts_replay`）。

| id | 原则 | 判定命令 |
|---|---|---|
| `assertion_lifecycle` | 被推翻的断言不许悄悄回来当现状 | `python3 zreflect/check_retractions.py` |
| `declared_not_globbed` | 谓词是声明不是文件名：执行面读 registry --run <相位> | `python3 zreflect/registry.py --gates` |
| `falsifiable` | 断言要能证伪：恒真短路由 AST 扫出，命中即判 fail | `python3 zreflect/registry.py --selftest` |
| `host_agnostic` | 套件源码不认任何宿主的目录名 / 配置格式（宿主接线归使用方） | `python3 -c "import os,sys;w=['.'+chr(122)+chr(99)+chr(111)+chr(100)+chr(101)+'/','ZCODE_'+'PROJECT_DIR','hook'+'SpecificOutput'];bad=[(d,f) for d in ('zreflect','reflect-hooks') for r,_,fs in os.walk(d) for f in fs if f.endswith(('.py','.sh')) and any(k in open(os.path.join(r,f),encoding='utf-8',errors='replace').read() for k in w)];print('host_coupled=%d' % len(bad));sys.exit(1 if bad else 0)"` |
| `machine_rows` | 机器行由 machine.ROWS 唯一产地定义；shell 侧有行为对账器 | `python3 zreflect/machine.py --selftest` |
| `no_retired_names` | 退役名不许以现状出现；sha 出处与测龄可查 | `python3 zreflect/check_stale.py` |
| `number_once` | 数字只生产一次：文档引用写 [[键名]]，不手抄（双向拦） | `python3 zreflect/check_facts.py` |
| `off_is_visible` | off 与「跑过且通过」必须可区分；会 off 的闸门必须声明理由 | `python3 -c "import sys;sys.path.insert(0,'zreflect');import registry, criteria;gs=registry.gates()[0];p=criteria.off_reason_problems(gs);print('off_reason_ok gates=%d problems=%d' % (len(gs), len(p)));sys.exit(0 if gs and not p else 1)"` |
| `only_measured` | 数值/行为只认实测；每条事实都必须有一条复跑命令 | `python3 -c "import json,sys;d=json.load(open('FACTS.json', encoding='utf-8'))['facts'];bad=[k for k,v in d.items() if not (isinstance(v,dict) and str(v.get('cmd','')).strip())];print('facts_without_cmd=%d' % len(bad));sys.exit(1 if bad else 0)"` |
| `open_questions_settle` | 未结案的悬案必须挂一个能跑的结算件 | `python3 zreflect/check_questions.py` |
| `selfcert_harness` | 每个闸门都要有 --selftest 入口（写而不跑 = 装饰） | `python3 -c "import sys;sys.path.insert(0,'zreflect');import registry;u=registry.modules()[1];print('undeclared_modules=%d' % len(u));sys.exit(1 if u else 0)"` |
| `snapshot_hygiene` | 跨模块 import 的可变全局是值拷贝（陈旧快照）：改读属性 | `python3 zreflect/check_snapshots.py` |
| `three_readmes` | 三语 README 是同一条断言的三份拷贝：改一份必须三份同批 | `python3 zreflect/check_readme_sync.py` |
| `zero_language` | 本体零语言：用户可见消息走 M(code)，机器契约结构上不可译 | `python3 zreflect/check_i18n.py` |

14 条原则 —— 每条都有一条**真的会跑**的判定命令。
<!-- /AUTO:RULES -->

## 本仓内容侧的纪律（与上游套件同一条复跑路径）

上游 `RULES` 管的是机制本身；本仓反复犯错的**内容侧**条目住在 `measure_edu.py`
的 TABLE 里，键 `discipline`，`kind="principle"`——与上面同表、同一条复跑路径
（`check_facts_replay` 每次提交真跑 `站点/plugins/solution-discipline.test.mjs`）：

| 条目 | 一句话 | 判定 |
|---|---|---|
| `discipline` | 完整解答层零反人类用语；题面引用教材图号必见图（图缺明说不算）；完成边界 ≤150 字且已解析/已验证在场 | `cd 站点 && node --test plugins/solution-discipline.test.mjs`（绿 ⇒ `ok`） |

三条的出处：反人类解析禁令 = `human-first-solution` skill（唯一真相源）；
题面完整 = 维护细则 §3.6（2026-10-13 定案）；完成边界口径 = 维护细则 §3.5.1
（2026-10-29/10-30 定案）。文字规则在那里，机器判定在这里——**两处不一致时，
闸门红是唯一仲裁**。

## 没写进表里的东西

**风格偏好不进这张表。** 命名、注释密度、文件组织——没有判据，也不该有：
判据只能守可机械判定的东西，把风格写成纪律会让这张表变成噪音。

**一次性的决策不进这张表。** 「这轮为什么这么改」不落文档——它属于提交信息
与 `.kimi-code/handoff.md` 的施工日志。
