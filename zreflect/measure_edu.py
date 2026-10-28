#!/usr/bin/env python3
"""学期课程学习仓库 — **本仓的数据层**（Einfacht 机制层之上的「你的部分」）。

Einfacht 的 `zreflect/facts.py` 只提供**机制**（两道守卫 / 渲染 / 复跑 / 收尾），
`measure_example()` 是占位。这里放本仓真正要量的东西：课程与资料计数、习题册
题数与配图张数、符号词条数、站点页数、测试项数。

设计（照 `zreflect/collect.py` 的四条原则）：

  · **只读持久盘**：全部是 `ls / find / grep / awk` 级计数，不构建、不联网；
  · **不引入会自己变的输入**：不读墙上时钟、不读 HEAD sha —— 量出来的值
    在两次重测之间稳定（否则 `--check` 永不收敛）；
  · **读不到就明说，绝不编 0**：命令 rc≠0 ⇒ 当场 `SystemExit`（宁缺勿假）；
  · **值与复跑同源**：value 直接取自 `cmd` 的 stdout —— 台账值与复跑闸门
    逐字执行的命令是同一条，物理上不可能漂。

⚠️ 本模块**自包含**：只从 `ledger` 借 `fact()`，不 import facts.py（避免循环）。
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gate import module_meta                               # noqa: E402
from ledger import fact                                    # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 习题册题数：标题行「### 选 4、8、9、11、16」这类合并题号按**题号个数**展开
# （第六章的注释解释了为什么：原书同一道折算题的重复排印，本页按题号保留）。
PROBLEMS_CMD = (
    "python3 -c \"import re,glob;print(sum(len(re.findall(r'[0-9]+',s)) "
    "for f in glob.glob('课程/电路原理/作业/2026-09-28-习题册第*.md') "
    "for ln in open(f,encoding='utf-8') if ln.startswith('### ') "
    "for s in re.findall(r'(?:选|填|计|判|画图)\\s*([0-9][0-9、,\\s]*)', "
    "re.sub(r'（[^）]*）','',ln[4:]))))\""
)
# 符号词条：全部符号包（通用包 + 每门课的 0.0-符号入门）的 glossary-dict 围栏里
# `sym-` 开头行数合计。
# 2026-10-25 修：旧命令**硬编码四个包**，漏了 `课程/电子技术/教材解析/0.0-符号入门.md`
# ——该包 2026-10-12 随「五包体系」入库，此后 13 天里台账一直少记它（179 实为 4 包，
# 补上电子技术是 213）。硬编码包名 = 加包就静默漏记，改用 glob 自动发现：
# 包注册表 `站点/符号环境.mjs` 增包时，这条命令自动跟上，不必手改清单。
GLOSSARY_CMD = (
    "awk '/^:::glossary-dict/{f=1;next} /^:::/{f=0} f&&/^sym-/{n++} END{print n}' "
    "站点/符号包/通用.md 课程/*/教材解析/0.0-符号入门.md"
)
# 符号包个数：SYMBOL_PACKS 注册表本身的条数（单一产地——加包即自动 +1）。
# 2026-10-26 入账动机：STATE/handoff 曾手抄「三个符号包」，实际五个——包数是
# 会变的口径，手抄必腐烂；入了台账就能用 [[symbol_packs]] 引用。
SYMBOL_PACKS_CMD = "grep -cE \"^  '[^']+': '[^']+.md',$\" 站点/符号环境.mjs"
# lab 回归测试项数：与 check_lab_integrity 的回归同一套三件（chaoxing/判据/bridge）。
# 2026-10-26 入账动机：handoff 基线多次手抄「lab 15/15」「75/75」「69/69」并存——
# 每次口径变就多一个过期数字。入账后正文写键名。
LAB_TESTS_CMD = (
    "cd .zcode/学习通API && node --test chaoxing.test.mjs 判据.test.mjs bridge.test.mjs 2>&1 | awk "
    "'NF==3 && $3 ~ /^[0-9]+$/ && ($2==\"tests\"||$2==\"fail\"||$2==\"cancelled\") {v[$2]=$3} "
    "END {t=v[\"tests\"]; f=v[\"fail\"]+0; c=v[\"cancelled\"]+0; "
    "if (t==\"\") {print \"lab_tests：没读到 tests 汇总行\" > \"/dev/stderr\"; exit 1} "
    "print t; "
    "if (f+c>0) {print \"lab_tests：fail=\" f \" cancelled=\" c \" ⇒ 红测试，非零退出\" "
    "> \"/dev/stderr\"; exit 1}}'"
)
# 站点页数：待渲染清单的条数（与钩子的 check_build_targets 同一份清单）。
# 2026-10-15：清单从 站点/build.mjs 搬到 站点/页面清单.mjs（build 与 MCP 读层共用同一份），
# 复跑命令随之改指新家——坏 cmd 印在活状态文档里就是每行都绿着的假断言。
SITEPAGES_CMD = (
    "sed -n '/^export const TARGET_FILES = \\[/,/^\\];/p' 站点/页面清单.mjs | grep -c \"^  '\""
)
HOOKTESTS_CMD = (
    "python3 .githooks/test-update-readme.py 2>&1 | grep -oE 'Ran [0-9]+ tests' | awk '{print $2}'"
)
# 站点插件测试项数：数字照旧取 node --test 汇总行的 tests 总数（裸值契约不变），
# 但 fail+cancelled>0 ⇒ 非零退出（issue #18 决策 #7）。旧命令把返回码吞在
# grep 管道里：「334 全绿」与「334 全红」产出同一个数字，闸门只拦数量漂移
# 不拦红测试——人从 STATE.md 抄这条 cmd 去跑时（shell 无 pipefail）红着也是
# rc=0。退出码由 awk 自己给，不依赖调用方 pipefail；红的原因打到 stderr。
# 汇总行按字段判（$2 是键、$3 是纯数字）：spec 报告器「ℹ tests N」（node 26
# 实测）与 TAP「# tests N」都认；测试名里出现「tests 3」字样也不会误取
# （旧 grep -o 取首个匹配，先命中测试名就数错）。没读到汇总行 ⇒ 同样非零退出
# （宁缺勿假：node 崩了不许把 0 交给台账）。
# 2026-10-25 修：旧命令只跑**单层** glob `plugins/*.test.mjs`，会漏掉子目录里的
# 测试文件。而项目自己的 `npm test` 声明的是 `node --test plugins/`（递归）——
# 台账量的是子集，等于每次引用都在低估覆盖面。改与 npm test 同口径（递归）。
# 2026-10-26：`plugins/assistant/` 整体移出仓库（助手协议栈归 node 侧，真相源在
# `.zcode/学习通API/protocol/`），计数随之回落；递归口径不变，将来加子目录仍自动覆盖。
PLUGIN_TESTS_CMD = (
    "cd 站点 && node --test plugins/ 2>&1 | awk "
    "'NF==3 && $3 ~ /^[0-9]+$/ && ($2==\"tests\"||$2==\"fail\"||$2==\"cancelled\") "
    "{v[$2]=$3} "
    "END {t=v[\"tests\"]; f=v[\"fail\"]+0; c=v[\"cancelled\"]+0; "
    "if (t==\"\") {print \"plugin_tests：没读到 tests 汇总行（node --test 没跑完？）\" "
    "> \"/dev/stderr\"; exit 1} "
    "print t; "
    "if (f+c>0) {print \"plugin_tests：fail=\" f \" cancelled=\" c "
    "\" ⇒ 红测试，非零退出（issue #18 决策 #7）\" > \"/dev/stderr\"; exit 1}}'"
)
# handoff 体量（2026-10-20 站长定案精简时入账）：handoff 是「下个会话只读这一份
# 就能接着干」的进度手记，越长越读不完。两条事实把它变成可测量的：
# 行数超阈值、节数超阈值，都该触发一次归档精简。
HANDOFF_LINES_CMD = "wc -l < .zcode/handoff.md"
HANDOFF_SECTIONS_CMD = "grep -c '^### 0\\.' .zcode/handoff.md"

# (键, 复跑命令, 出处, 备注) —— 可选第五列：dict，透传 ledger.fact() 的贵事实参数
# （replay=False / witness / calibrate，见 ledger.py 的三档设计）。
HOOKTESTS_WITNESS = (
    "grep -c 'def test_' .githooks/test-update-readme.py"
)
TABLE = [
    ("courses", "ls -d 课程/*/ | wc -l", "课程/", "课程门数"),
    ("notes", "find 课程 -path '*/课堂笔记/*.md' ! -name 'index.md' | wc -l",
     "课程/", "课堂笔记篇数（不含索引）"),
    ("homework", "find 课程 -path '*/作业/*.md' ! -name 'index.md' | wc -l",
     "课程/", "作业页数（不含索引）"),
    ("textbook", "find 课程 -path '*/教材解析/*.md' ! -name 'index.md' | wc -l",
     "课程/", "教材解析篇数（不含索引）"),
    ("problems", PROBLEMS_CMD, "课程/电路原理/作业/",
     "习题册题数（合并题号的标题按题号展开计数）"),
    ("figures", "ls 课程/电路原理/作业/figures/ | wc -l",
     "课程/电路原理/作业/figures/", "习题册配图张数"),
    ("glossary_entries", GLOSSARY_CMD, "站点/符号包/通用.md + 课程/*/教材解析/0.0-符号入门.md",
     "全部符号包的词条合计（通用 + 电机学 / 电路原理 / 工程数学 / 电子技术）"),
    ("symbol_packs", SYMBOL_PACKS_CMD, "站点/符号环境.mjs",
     "符号包个数（SYMBOL_PACKS 注册表条数；正文引用它，别手抄「三包/五包」——会随加包腐烂）"),
    ("lab_tests", LAB_TESTS_CMD, ".zcode/学习通API/",
     "lab 回归测试项数（canonical 三件；与 lab 闸同一套文件，改名单两边一起红）"),
    ("sitepages", SITEPAGES_CMD, "站点/build.mjs", "站点页数（TARGET_FILES 条数）"),
    ("md_files", "git ls-files '*.md' | wc -l", "repo", "受管 Markdown 篇数"),
    ("hooktests", HOOKTESTS_CMD, ".githooks/test-update-readme.py", "钩子集成测试项数",
     # 贵事实：值 = 完整跑一遍测试套件（>10s，超复跑闸门超时）。按三档设计挂便宜
     # 见证——来源是「测试文件里声明了多少项」，命令活着、数量对了才算数。
     {"replay": False, "witness": HOOKTESTS_WITNESS,
      # 2026-10-21：25 → 28（阶段一加了 3 项导航覆盖率测试）
      # 2026-10-28：28 → 29（父页面级联校验：补 test_parent_chain_must_be_updated_level_by_level）
      "witness_expect": "29"}),
    ("plugin_tests", PLUGIN_TESTS_CMD, "站点/plugins/",
     "站点插件测试项数（fail+cancelled>0 ⇒ 复跑非零退出）"),
    # handoff 体量：见 HANDOFF_LINES_CMD 处的注释。「读不完」本身就是要量的事实。
    ("handoff_lines", HANDOFF_LINES_CMD, ".zcode/handoff.md",
     "进度手记总行数（超 ~1500 行该归档精简）"),
    ("handoff_sections", HANDOFF_SECTIONS_CMD, ".zcode/handoff.md",
     "进度手记节数（### 0.x 条目数）"),
]


def _sh(cmd):
    """跑一条度量命令，返回 stdout（strip）。失败 ⇒ 抛（读不到就明说，不编 0）。"""
    p = subprocess.run(["bash", "-o", "pipefail", "-c", cmd], cwd=REPO,
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit("FATAL: 量测命令失败（rc=%s）：%s\n%s"
                         % (p.returncode, cmd, p.stderr.strip()))
    return p.stdout.strip()


def measure():
    """量一遍全部事实。值 = 复跑命令的 stdout —— 两者同源，不可能漂。"""
    facts = {}
    for row in TABLE:
        key, cmd, source, note, *extra = row
        out = _sh(cmd)
        try:
            value = int(out)
        except ValueError:
            raise SystemExit("FATAL: `%s` 的度量命令输出不是整数：%r（cmd=%s）"
                             % (key, out, cmd))
        facts[key] = fact(value, cmd, source, note, **(extra[0] if extra else {}))
    return facts


MODULE = module_meta("本仓数据层", "量课程/资料/习题/配图/词条/站点/测试计数（只读持久盘，值=复跑命令）",
                     selftest=False)
