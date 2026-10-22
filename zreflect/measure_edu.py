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
# 符号词条：三个符号包的 glossary-dict 围栏里 `sym-` 开头的行数合计。
GLOSSARY_CMD = (
    "awk '/^:::glossary-dict/{f=1;next} /^:::/{f=0} f&&/^sym-/{n++} END{print n}' "
    "站点/符号包/通用.md 课程/电机学/教材解析/0.0-符号入门.md "
    "课程/工程数学/教材解析/0.0-符号入门.md 课程/电路原理/教材解析/0.0-符号入门.md"
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
PLUGIN_TESTS_CMD = (
    "cd 站点 && node --test plugins/*.test.mjs 2>&1 | grep -oE 'tests [0-9]+' | head -1 | grep -oE '[0-9]+'"
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
    ("glossary_entries", GLOSSARY_CMD, "课程/*/教材解析/0.0-符号入门.md",
     "三个符号包的词条合计（电机学 / 电路原理 / 工程数学）"),
    ("sitepages", SITEPAGES_CMD, "站点/build.mjs", "站点页数（TARGET_FILES 条数）"),
    ("md_files", "git ls-files '*.md' | wc -l", "repo", "受管 Markdown 篇数"),
    ("hooktests", HOOKTESTS_CMD, ".githooks/test-update-readme.py", "钩子集成测试项数",
     # 贵事实：值 = 完整跑一遍测试套件（>10s，超复跑闸门超时）。按三档设计挂便宜
     # 见证——来源是「测试文件里声明了多少项」，命令活着、数量对了才算数。
     {"replay": False, "witness": HOOKTESTS_WITNESS,
      # 2026-10-21：25 → 28（阶段一加了 3 项导航覆盖率测试）
      "witness_expect": "28"}),
    ("plugin_tests", PLUGIN_TESTS_CMD, "站点/plugins/", "站点插件测试项数"),
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
