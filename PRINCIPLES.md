# PRINCIPLES · 本仓设计纪律

> **这不是状态文档。** 这里只写「为什么这样设计」——它不随提交变化。
> 想知道**此刻**是什么样：看 [STATE.md](STATE.md)。
>
<!-- AUTO:RULES -->
> This block is rendered by `zreflect/facts.py --render-doc` from the `RULES` table in `zreflect/doc.py` (plus optional `reflect-local/principles.json`); **do not hand-edit**.
> Every row's judging command is executed verbatim at every commit (`check_facts_replay`).

| id | principle | judging command |
|---|---|---|
| `assertion_lifecycle` | a retracted claim must not quietly return as current state | `python3 -c "import sys;sys.path.insert(0,'zreflect');import doc;sys.exit(doc.enforced_by('check_retractions.py'))"` |
| `comments_earn_their_place` | explanation volume must fit AST complexity under `mismatch`, or carry no docstrings under `strict` | `python3 -c "import sys;sys.path.insert(0,'zreflect');import doc;sys.exit(doc.enforced_by('check_explain.py'))"` |
| `core_sealed` | shared suite core modules, gates, hooks, and language packs match `zreflect/SEAL.json` | `python3 zreflect/registry.py --verify-seal` |
| `declared_not_globbed` | predicates are declarations, not filenames: the execution surface reads registry --run <phase> | `python3 zreflect/registry.py --gates` |
| `doc_paths_verified` | 活文档引用的磁盘路径真实存在（被 .gitignore 排除的工作区文件须明说不适用） | `python3 -c "import sys;sys.path.insert(0,'zreflect');import doc;sys.exit(doc.enforced_by('check_doc_paths.py'))"` |
| `exec_position_is_a_command` | every execution position (stamp cmd / pin cmd / Settling / evidence) must hold a runnable command | `python3 -c "import sys;sys.path.insert(0,'zreflect');import doc;bad=doc.all_exec_position_problems();[print(p) for p in bad] or print('prose_positions=0');sys.exit(1 if bad else 0)"` |
| `falsifiable` | claims must be falsifiable: every declared gate carries a runnable --selftest | `python3 zreflect/registry.py --all-runnable` |
| `figures_wellformed` | 题面图元（.figures.txt 与内联 SVG）合法，端口语义挂载与词条一致，布局无穿框截字 | `python3 -c "import subprocess,sys;sys.exit(subprocess.run(['node','--test','plugins/figures.test.mjs'],cwd='站点').returncode)"` |
| `hard_needs_criterion` | a rule is hard only if it has a machine criterion; without one it does not enter the table at all | `python3 -c "import sys;sys.path.insert(0,'zreflect');import doc;p=doc._cmd_shape_problems();print('shape_problems=%d' % len(p));sys.exit(1 if p else 0)"` |
| `host_agnostic` | the suite's source recognizes no host's directory names or config formats | `python3 -c "import os,sys;w=['.'+chr(122)+chr(99)+chr(111)+chr(100)+chr(101)+'/','ZCODE_'+'PROJECT_DIR','hook'+'SpecificOutput'];bad=[(d,f) for d in ('zreflect','reflect-local') for r,_,fs in os.walk(d) for f in fs if f.endswith('.py') and any(k in open(os.path.join(r,f),encoding='utf-8',errors='replace').read() for k in w)];print('host_coupled=%d' % len(bad));sys.exit(1 if bad else 0)"` |
| `identity_consistent` | 仓库对外标识、作者与仓名只认唯一真相源，不混用旧仓旧名 | `python3 -c "import sys;sys.path.insert(0,'zreflect');import doc;sys.exit(doc.enforced_by('check_identity.py'))"` |
| `lab_integrity` | 不入库的实验空活代码（.kimi-code/学习通API/）文件清单与回归测试完整（克隆无此目录时通过） | `python3 -c "import sys;sys.path.insert(0,'zreflect');import doc;sys.exit(doc.enforced_by('check_lab_integrity.py'))"` |
| `machine_rows` | machine rows are defined in one place (`i18n.ROWS`) for both producers and consumers | `python3 -c "import sys;sys.path.insert(0,'zreflect');import i18n;print('rows=%d' % len(i18n.ROWS));sys.exit(0 if i18n.ROWS else 1)"` |
| `markdown_wellformed` | Markdown 结构与数学规范：标题不跳级、围栏与数学定界符闭合、数学模式中文用 \\text{} 包裹、折叠面板标题裸词 | `python3 .githooks/check-markdown.py` |
| `no_retired_names` | retired names must not appear as current state; sha provenance and age are checkable | `python3 -c "import sys;sys.path.insert(0,'zreflect');import doc;sys.exit(doc.enforced_by('check_stale.py'))"` |
| `no_untracked_study` | 课堂转写原件与教材照片原件不入 git（原件存 /mnt/hdd/study/<课>/原始资料/），待办区根层不散落文件 | `python3 -c "import sys;sys.path.insert(0,'zreflect');import doc;sys.exit(doc.enforced_by('check_study.py'))"` |
| `number_once` | each number is produced once and re-reconciled every commit: documents cite it as `[[key]]`, never hand-copy it | `python3 -c "import sys;sys.path.insert(0,'zreflect');import doc;sys.exit(doc.enforced_by('check_facts.py'))"` |
| `only_measured` | numbers/behavior trust measurement only; every fact must carry a re-run command | `python3 -c "import json,sys;sys.path.insert(0,'zreflect');import knobs;d=json.load(open(knobs.repo_path('REFLECT_FACTS'),encoding='utf-8'))['facts'];bad=[k for k,v in d.items() if not (isinstance(v,dict) and str(v.get('cmd','')).strip())];print('facts_without_cmd=%d' % len(bad));sys.exit(1 if bad else 0)"` |
| `open_questions_settle` | every unresolved open question must carry a runnable settler | `python3 -c "import sys;sys.path.insert(0,'zreflect');import doc;sys.exit(doc.enforced_by('check_questions.py'))"` |
| `selfcert_harness` | every declared module must have a --selftest entry | `python3 -c "import sys;sys.path.insert(0,'zreflect');import registry;u=registry.selftest_modules()[1];print('missing_selftest=%d' % len(u));sys.exit(1 if u else 0)"` |
| `semantics_unique` | 助手协议术语唯一，按口径表查禁用别名（未配置或默认文件不在时明说 off） | `python3 -c "import sys;sys.path.insert(0,'zreflect');import doc;sys.exit(doc.enforced_by('check_semantics.py'))"` |
| `snapshot_hygiene` | a mutable global imported across modules is a value copy: read via the module attribute instead | `python3 -c "import sys;sys.path.insert(0,'zreflect');import doc;sys.exit(doc.enforced_by('check_snapshots.py'))"` |
| `solution_discipline` | 解析纪律三原则：完整解答层零反人类词（试探/凑/巧妙看出）、题面引用教材图号必见图（或明说「图缺」）、完成边界 ≤150 字且含「已解析」与「已验证」 | `python3 -c "import subprocess,sys;sys.exit(subprocess.run(['node','--test','plugins/solution-discipline.test.mjs','plugins/completion-boundary.test.mjs'],cwd='站点').returncode)"` |
| `solution_selfcontained` | 解答自足：完整做法直接写在本页完整解答层，不把步骤推给技法库或教材解析页 | `python3 -c "import subprocess,sys;sys.exit(subprocess.run(['node','--test','plugins/solution-selfcontained.test.mjs'],cwd='站点').returncode)"` |
| `style_is_not_a_rule` | style preferences do not enter the rule table | `python3 -c "import sys;sys.path.insert(0,'zreflect');import doc;style=('style','naming','comment','layout','format');bad=[r.id for r in doc.all_rules() if r.id in style];print('style_ids=%d' % len(bad));sys.exit(1 if bad else 0)"` |
| `three_readmes` | the README group is checked structurally and kept in the same push batch | `python3 -c "import sys;sys.path.insert(0,'zreflect');import doc;sys.exit(doc.enforced_by('check_readme_sync.py'))"` |
| `transcript_privacy` | 课堂转写隐私防线：受管文件不含 11 位手机号与未脱敏原文，仅在原始资料/index.md 登记文件名、性质说明与 SHA256 | `python3 -c "import sys;sys.path.insert(0,'zreflect');import doc;sys.exit(doc.enforced_by('check_transcript_privacy.py'))"` |
| `whitelist_and_site_sync` | 精确白名单禁通配符、课程 status 仅「开课/结课」两档、资料与各级索引同进同出、侧栏标签等于 H1 且在宽度预算内、站点与构建清单一致 | `python3 -c "import sys;sys.path.insert(0,'.githooks');import hook_lib;f=hook_lib.snapshot(worktree=True);hook_lib.validate(f);print('validated_files=%d' % len(f))"` |
| `zero_language` | zero language in the core: user-visible messages go through M(code); machine contracts are untranslatable by construction | `python3 -c "import sys;sys.path.insert(0,'zreflect');import doc;sys.exit(doc.enforced_by('check_i18n.py'))"` |

29 principles -- each with a judging command that **really runs**.
<!-- /AUTO:RULES -->
