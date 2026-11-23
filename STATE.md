# 学期课程学习仓库 · 活状态

> 本文件是**活状态文档**：只写「现在是什么」。**数字一律引用台账键**（写法 `[[键名]]`），
> 不手抄——手抄的数字从写下的那一刻起就开始腐烂。文件末尾的机器块由
> `zreflect/facts.py --render-doc` 渲染，不要手改。

<!-- AUTO:FACTS -->
> This block is rendered by `zreflect/facts.py --render-doc` from `FACTS.json`; **do not edit by hand** (pre-commit recomputes and `git add`s it).
> 'Measured numbers' in the prose are produced only here: to cite one, write `[[key]]`; never copy the number by hand.

| key | value | measured at | replay cmd |
|---|---|---|---|
| `core_seal` | `141b6dabaa12f53b...` | 2026-11-23T22:22:14+0800 | `python3 zreflect/registry.py --verify-seal` |
| `courses` | **9** | 2026-11-23T22:21:55+0800 | `ls -d 课程总览/*/ | wc -l` |
| `figures` | **174** | 2026-11-23T22:21:55+0800 | `ls 课程总览/电路原理/作业/figures/ | wc -l` |
| `glossary_entries` | **227** | 2026-11-23T22:21:55+0800 | `awk '/^:::glossary-dict/{f=1;next} /^:::/{f=0} f&&/^sym-/{n++} END{print n}' 站点/符号包/通用.md 课程总览/*/教材解析/符号入门.md` |
| `history_state_claims` | **0** | 2026-11-23T22:22:14+0800 | `grep -cE '\*\*(当前|目前|如今)\*\*|^当前|^目前' HISTORY.md || true` |
| `homework` | **32** | 2026-11-23T22:21:55+0800 | `find 课程总览 -path '*/作业/*.md' ! -name 'index.md' | wc -l` |
| `hooktests` | **26** | 2026-11-23T22:22:06+0800 | `python3 .githooks/test-update-readme.py 2>&1 | grep -oE 'Ran [0-9]+ tests' | awk '{print $2}'` |
| `lab_tests` | **74** | 2026-11-23T22:21:56+0800 | `cd .kimi-code/学习通API && node --test chaoxing.test.mjs 判据.test.mjs bridge.test.mjs 2>&1 | awk 'NF==3 && $3 ~ /^[0-9]+$/ && ($2=="tests"||$2=="fail"||$2=="cancelled") {v[$2]=$3} END {t=v["tests"]; f=v["fail"]+0; c=v["cancelled"]+0; if (t=="") {print "lab_tests：没读到 tests 汇总行" > "/dev/stderr"; exit 1} print t; if (f+c>0) {print "lab_tests：fail=" f " cancelled=" c " ⇒ 红测试，非零退出" > "/dev/stderr"; exit 1}}'` |
| `md_files` | **227** | 2026-11-23T22:21:56+0800 | `git ls-files '*.md' | wc -l` |
| `notes` | **70** | 2026-11-23T22:21:55+0800 | `find 课程总览 -path '*/课堂笔记/*.md' ! -name 'index.md' | wc -l` |
| `plugin_tests` | **1116** | 2026-11-23T22:22:14+0800 | `cd 站点 && node --test plugins/ 2>&1 | awk 'NF==3 && $3 ~ /^[0-9]+$/ && ($2=="tests"||$2=="fail"||$2=="cancelled") {v[$2]=$3} END {t=v["tests"]; f=v["fail"]+0; c=v["cancelled"]+0; if (t=="") {print "plugin_tests：没读到 tests 汇总行（node --test 没跑完？）" > "/dev/stderr"; exit 1} print t; if (f+c>0) {print "plugin_tests：fail=" f " cancelled=" c " (chr(8658)+chr(32)+chr(32418)+chr(27979)+chr(35797)+chr(65292)+chr(38750)+chr(38646)+chr(36864)+chr(20986)) (chr(65288)+chr(105)+chr(115)+chr(115)+chr(117)+chr(101)+chr(32)+chr(35)+chr(49)+chr(56)+chr(32)+chr(20915)+chr(31574)+chr(32)+chr(35)+chr(55)+chr(65289)) " > "/dev/stderr"; exit 1}}'` |
| `problems` | **278** | 2026-11-23T22:21:55+0800 | `python3 -c "import re,glob;print(sum(len(re.findall(r'[0-9]+',s)) for f in glob.glob('课程总览/电路原理/作业/习题册第*.md') for ln in open(f,encoding='utf-8') if ln.startswith('### ') for s in re.findall(r'(?:选|填|计|判|画图)\s*([0-9][0-9、,\s]*)', re.sub(r'（[^）]*）','',ln[4:]))))"` |
| `sitepages` | **194** | 2026-11-23T22:21:56+0800 | `sed -n '/^export const TARGET_FILES = \[/,/^\];/p' 站点/页面清单.mjs | grep -c "^  '"` |
| `symbol_packs` | **5** | 2026-11-23T22:21:55+0800 | `grep -cE "^  '[^']+': '[^']+.md',$" 站点/符号环境.mjs` |
| `symbols_bubbled` | **20135** | 2026-11-23T22:22:14+0800 | `python3 -c "import json;print(json.load(open('站点/dist/symbol-coverage.json'))['symbols_bubbled'])"` |
| `symbols_uncovered` | **0** | 2026-11-23T22:22:14+0800 | `python3 -c "import json;print(json.load(open('站点/dist/symbol-coverage.json'))['symbols_uncovered'])"` |
| `textbook` | **31** | 2026-11-23T22:21:55+0800 | `find 课程总览 -path '*/教材解析/*.md' ! -name 'index.md' | wc -l` |

17 facts.
<!-- /AUTO:FACTS -->

<!-- AUTO:GATES -->
> This block is rendered by `zreflect/facts.py --render-doc` from the discovered roster; **do not hand-edit**.
> The execution plane (hooks / CI) reads `registry --run <phase>` -- the phase is a declared field (`runs_at`), not a file name.

| Gate | Phase | What it guards | Knobs consumed | Why it may be off |
|---|---|---|---|---|
| `check_doc_paths.py`（活文档路径闸门） | commit | 活状态文档里写的仓库内路径必须真实存在（消灭跑不通的判据） | -- | -- |
| `check_headings.py`（页面标题白名单闸门） | commit | 受管课堂笔记/作业只允许白名单标题，「完成边界」居末且禁止条件备注/来源与边界等已废标题 | -- | -- |
| `check_identity.py`（身份白名单闸门） | commit | 只有上游发放的 id 才许出现在活代码里，自造 id 出现即红 | -- | 可插拔模块：规格表未配置且默认位置无表时明说未启用（配 IDENTITY_SPEC 表即启用） |
| `check_study.py`（工作区闸门） | commit | study/ 不许进 git；根层不许散落转写与照片（归位才能被检索与索引看见） | -- | -- |
| `check_transcript_privacy.py`（课堂转写隐私闸门） | commit | 转写原件不许新增入库（棘轮：既有欠债记基线，只许缩小） | -- | -- |
| `check_walkthrough.py`（Walkthrough 覆盖闸门） | commit | 已建 Walkthrough.md 的课程，受管课堂笔记与作业必须在 Walkthrough.md 中有对应入口 | -- | -- |
| `check_ab.py`（A/B gate） | commit | A/B same-flags invariant (a difference outside the allow axis = confounding variable, A/B void) | `REFLECT_AB` | repos that run no A/B experiments do not need it: spec unset => explicitly not enabled |
| `check_facts.py`（Facts gate） | commit | block agreement / bare numbers / bad citations | `REFLECT_DOC`, `REFLECT_DOCS`, `REFLECT_FACTS`, `REFLECT_NAKED_MIN`, `REFLECT_QUESTIONS` | -- |
| `check_facts_replay.py`（Replay gate） | commit | ledger cmds re-run verbatim (bare-value contract: stdout must equal the value) | `REFLECT_FACTS`, `REFLECT_REPLAY`, `REFLECT_REPLAY_TIMEOUT` | closes only when REFLECT_REPLAY=off is explicitly set |
| `check_i18n.py`（language coverage gate） | commit | zero-language core output via M(code) and optional language pack sync/coverage | `REFLECT_I18N_ROOT` | -- |
| `check_instruments.py`（Instrument lifecycle gate） | commit | constancy detection (first_seen) + falsified-method registry | `REFLECT_INSTRUMENTS`, `REFLECT_INSTRUMENT_DAYS`, `REFLECT_FACTS` | both knobs unset => the specialized mechanism is not enabled (pluggable; this repo turns it on when needed) |
| `check_invariants.py`（Invariants gate） | commit | declarative invariants: repo files must / must not contain a snippet (grep level) | `REFLECT_INVARIANTS` | repos that write no declarative invariants do not need it: spec unset => explicitly not enabled (pluggable) |
| `check_lint.py`（Static machine check） | commit | ruff's C901/F/E9/B, criteria in ruff.toml -- the 'all clear' must be re-established by every commit, not handwritten into the ledger from a single manual run (R-004) | -- | ruff not installed on this machine (external tool, not a repo dependency) => explicitly not enabled; CI pip-installs it, and there the gate really runs |
| `check_locks.py`（Locked-sources gate） | commit | locked-sources list (content fingerprints of URL + file + sha256) | `REFLECT_LOCKS` | repos that do not pin upstream bytes do not need it: spec unset => explicitly not enabled |
| `check_pins.py`（pin gate） | commit | derived-tree pin consistency (stamp commit / dirty / version string cross-read) | `REFLECT_PINS` | repos without a derived tree do not need it: spec unset => explicitly not enabled |
| `check_questions.py`（Question ledger gate） | commit | an unresolved question must carry a runnable settler | `REFLECT_QUESTIONS` | -- |
| `check_readme_sync.py`（Trilingual README gate） | commit | language versions are three copies of one assertion: structural cross-links + same-batch on every push | `REFLECT_READMES` | a repo that sets REFLECT_READMES to an empty list states it has no README group; unset is different and uses the registry default |
| `check_retractions.py`（Retraction-resurfacing check） | commit | a retracted assertion may not quietly return as the current state | `REFLECT_RETRACTIONS`, `REFLECT_DOCS`, `REFLECT_HISTORY_SECS` | -- |
| `check_secrets.py`（Secrets gate） | commit | plain-text credential detection with explicit paths and justified exact exemptions | `REFLECT_SECRETS` | a repo that declares no credential-scanning spec keeps this gate off; a spec named explicitly but absent is a configuration error, never a disable |
| `check_snapshots.py`（module-level snapshot gate） | commit | a mutable global imported across modules is a value copy (stale snapshot): switch to importing the module and reading the attribute | `REFLECT_SNAPSHOT_ROOT` | -- |
| `check_stale.py`（Stale-assertion gate） | commit | sha provenance / retired names / age check | `REFLECT_DOCS`, `REFLECT_FACTS`, `REFLECT_HISTORY_SECS`, `REFLECT_RETIRED`, `REFLECT_STALE_DAYS` | -- |
| `check_world.py`（world gate） | commit | declarative validation target: world reconciliation of a multi-line repo's shared validation environment | `REFLECT_WORLD`, `REFLECT_WORLD_LINE` | a single-line repo does not need it: spec not configured => state it is off |
| `check_lab_integrity.py`（实验空完整性闸门） | lab | 活文件白名单 + 配方回归测试（lab 相位，手动 --run lab） | -- | -- |
| `check_semantics.py`（语义闸门） | start-of-work | 语义唯一性：一个概念只许一个规范键名，禁用别名出现即红 | -- | 可插拔模块：语义表未配置且默认位置无表时明说未启用（配 SEMANTICS_SPEC 表即启用） |
| `hook.py`（Hook entry） | start-of-work | the single mouth called by other hook systems: commit re-renders + runs gates; push verifies only + trilingual READMEs; --chain/--uninstall | `REFLECT_DOC` | the hook entry is invoked by git, not attached to the pre-commit phase |
| `check_explain.py`（Comment discipline） | start-of-work | strict: no docstrings; mismatch: explanation chars within AST complexity budget | `REFLECT_COMMENTS` | only disabled when REFLECT_COMMENTS=off is explicitly set |
| `check_history.py`（History document） | start-of-work | the one carrier where prose is allowed: it must exist and must stay off every scan surface | `REFLECT_HISTORY`, `REFLECT_DOCS`, `REFLECT_READMES`, `REFLECT_QUESTIONS`, `REFLECT_FACTS` | a repo that keeps no history document states so by pointing REFLECT_HISTORY at nothing; the exemption then has no subject |
| `doctor.py`（start-of-work doctor） | start-of-work | process / port liveness (probes things that can die => runs_at=start-of-work, not in pre-commit) | `REFLECT_DOCTOR`, `REFLECT_DOCTOR_TIMEOUT` | this repo has no doctor.json spec: no process/port liveness is checked => state it is off |

28 gates; 16 may be disabled.
<!-- /AUTO:GATES -->
