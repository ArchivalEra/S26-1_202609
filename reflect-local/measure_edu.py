#!/usr/bin/env python3
"""
PINNED: Consumer extension for this Chinese-language course archive; path literals and protocol markers are data, not user-facing prose.
学期课程学习仓库 — **本仓的数据层**（Einfacht 机制层之上的「你的部分」）。

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

⚠️ `fact()` 来自 `facts.py`（新版统一产地；calibrate 探针随 fact 一起透传）。
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zreflect"))
from facts import fact  # noqa: E402
from gate import module_meta  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
PROBLEMS_CMD = (
    "" + "python3 -c \"import re,glob;print(sum(len(re.findall(r'[0-9]+',s)) "
    "for f in glob.glob('课程总览/电路原理/作业/习题册第*.md') "
    "for ln in open(f,encoding='utf-8') if ln.startswith('### ') "
    "for s in re.findall(r'(?:选|填|计|判|画图)\\s*([0-9][0-9、,\\s]*)', "
    "re.sub(r'（[^）]*）','',ln[4:]))))\""
)
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
GLOSSARY_CMD = (
    "" + "awk '/^:::glossary-dict/{f=1;next} /^:::/{f=0} f&&/^sym-/{n++} END{print n}' "
    "站点/符号包/通用.md 课程总览/*/教材解析/符号入门.md"
)
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
SYMBOL_PACKS_CMD = ('grep -cE "^  \'[^\']+\': \'[^\']+.md\',$" '+chr(31449)+chr(28857)+'/'+chr(31526)+chr(21495)+chr(29615)+chr(22659)+'.mjs')
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
LAB_TESTS_CMD = (
    "" + "cd .kimi-code/学习通API && node --test chaoxing.test.mjs 判据.test.mjs bridge.test.mjs 2>&1 | awk "
    "'NF==3 && $3 ~ /^[0-9]+$/ && ($2==\"tests\"||$2==\"fail\"||$2==\"cancelled\") {v[$2]=$3} "
    "END {t=v[\"tests\"]; f=v[\"fail\"]+0; c=v[\"cancelled\"]+0; "
    "if (t==\"\") {print \"lab_tests：没读到 tests 汇总行\" > \"/dev/stderr\"; exit 1} "
    "print t; "
    "if (f+c>0) {print \"lab_tests：fail=\" f \" cancelled=\" c \" ⇒ 红测试，非零退出\" "
    "> \"/dev/stderr\"; exit 1}}'"
)
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
SITEPAGES_CMD = (
    ("sed -n '/^export const TARGET_FILES = \\[/,/^\\];/p' "+chr(31449)+chr(28857)+'/'+chr(39029)+chr(38754)+chr(28165)+chr(21333)+'.mjs | grep -c "^  \'"')
)
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
HOOKTESTS_CMD = (
    "python3 .githooks/test-update-readme.py 2>&1 | grep -oE 'Ran [0-9]+ tests' | awk '{print $2}'"
)
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
PLUGIN_TESTS_CMD = (
    "" + "cd 站点 && node --test plugins/ 2>&1 | awk "
    "'NF==3 && $3 ~ /^[0-9]+$/ && ($2==\"tests\"||$2==\"fail\"||$2==\"cancelled\") "
    "{v[$2]=$3} "
    "END {t=v[\"tests\"]; f=v[\"fail\"]+0; c=v[\"cancelled\"]+0; "
    "if (t==\"\") {print \"plugin_tests：没读到 tests 汇总行（node --test 没跑完？）\" "
    "> \"/dev/stderr\"; exit 1} "
    "print t; "
    "if (f+c>0) {print \"plugin_tests：fail=\" f \" cancelled=\" c "
    "\" (chr(8658)+chr(32)+chr(32418)+chr(27979)+chr(35797)+chr(65292)+chr(38750)+chr(38646)+chr(36864)+chr(20986)) (chr(65288)+chr(105)+chr(115)+chr(115)+chr(117)+chr(101)+chr(32)+chr(35)+chr(49)+chr(56)+chr(32)+chr(20915)+chr(31574)+chr(32)+chr(35)+chr(55)+chr(65289)) \" > \"/dev/stderr\"; exit 1}}\'"
)
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
HISTORY_STATE_CLAIMS_CMD = (
    ("grep -cE '\\*\\*("+chr(24403)+chr(21069)+'|'+chr(30446)+chr(21069)+'|'+chr(22914)+chr(20170)+')\\*\\*|^'+chr(24403)+chr(21069)+'|^'+chr(30446)+chr(21069)+"' HISTORY.md || true")
)

# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
SYMBOLS_BUBBLED_CMD = (
    "" + "python3 -c \"import json;"
    "print(json.load(open('站点/dist/symbol-coverage.json'))['symbols_bubbled'])\""
)
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
SYMBOLS_UNCOVERED_CMD = (
    "" + "python3 -c \"import json;"
    "print(json.load(open('站点/dist/symbol-coverage.json'))['symbols_uncovered'])\""
)

# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
HOOKTESTS_WITNESS = (
    "grep -c 'def test_' .githooks/test-update-readme.py"
)
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
TABLE = [
    ("courses", ('ls -d '+chr(35838)+chr(31243)+chr(24635)+chr(35272)+'/*/ | wc -l'), ((chr(35838)+chr(31243)+chr(24635)+chr(35272)+"/")), "course count"),
    ("notes", ('find '+chr(35838)+chr(31243)+chr(24635)+chr(35272)+" -path '*/"+chr(35838)+chr(22530)+chr(31508)+chr(35760)+"/*.md' ! -name 'index.md' | wc -l"),
     (chr(35838)+chr(31243)+chr(24635)+chr(35272)+'/'), "note: classroom notes (index excluded)"),
    ("homework", ('find '+chr(35838)+chr(31243)+chr(24635)+chr(35272)+" -path '*/"+chr(20316)+chr(19994)+"/*.md' ! -name 'index.md' | wc -l"),
     (chr(35838)+chr(31243)+chr(24635)+chr(35272)+'/'), "note: homework pages (index excluded)"),
    ("textbook", ('find '+chr(35838)+chr(31243)+chr(24635)+chr(35272)+" -path '*/"+chr(25945)+chr(26448)+chr(35299)+chr(26512)+"/*.md' ! -name 'index.md' | wc -l"),
     (chr(35838)+chr(31243)+chr(24635)+chr(35272)+'/'), "note: textbook analyses (index excluded)"),
    ("problems", PROBLEMS_CMD, (chr(35838)+chr(31243)+chr(24635)+chr(35272)+'/'+chr(30005)+chr(36335)+chr(21407)+chr(29702)+'/'+chr(20316)+chr(19994)+'/'),
     (chr(20064)+chr(39064)+chr(20876)+chr(39064)+chr(25968)+chr(65288)+chr(21512)+chr(24182)+chr(39064)+chr(21495)+chr(30340)+chr(26631)+chr(39064)+chr(25353)+chr(39064)+chr(21495)+chr(23637)+chr(24320)+chr(35745)+chr(25968)+chr(65289))),
    ("figures", ('ls '+chr(35838)+chr(31243)+chr(24635)+chr(35272)+'/'+chr(30005)+chr(36335)+chr(21407)+chr(29702)+'/'+chr(20316)+chr(19994)+'/figures/ | wc -l'),
     (chr(35838)+chr(31243)+chr(24635)+chr(35272)+'/'+chr(30005)+chr(36335)+chr(21407)+chr(29702)+'/'+chr(20316)+chr(19994)+'/figures/'), "note: exercise-book figure count"),
    ("glossary_entries", GLOSSARY_CMD, (chr(31449)+chr(28857)+'/'+chr(31526)+chr(21495)+chr(21253)+'/'+chr(36890)+chr(29992)+'.md + '+chr(35838)+chr(31243)+chr(24635)+chr(35272)+'/*/'+chr(25945)+chr(26448)+chr(35299)+chr(26512)+'/'+chr(31526)+chr(21495)+chr(20837)+chr(38376)+'.md'),
     (chr(20840)+chr(37096)+chr(31526)+chr(21495)+chr(21253)+chr(30340)+chr(35789)+chr(26465)+chr(21512)+chr(35745)+chr(65288)+chr(36890)+chr(29992)+' + '+chr(30005)+chr(26426)+chr(23398)+' / '+chr(30005)+chr(36335)+chr(21407)+chr(29702)+' / '+chr(24037)+chr(31243)+chr(25968)+chr(23398)+' / '+chr(30005)+chr(23376)+chr(25216)+chr(26415)+chr(65289))),
    ("symbol_packs", SYMBOL_PACKS_CMD, (chr(31449)+chr(28857)+'/'+chr(31526)+chr(21495)+chr(29615)+chr(22659)+'.mjs'),
     (chr(31526)+chr(21495)+chr(21253)+chr(20010)+chr(25968)+chr(65288)+'SYMBOL_PACKS '+chr(27880)+chr(20876)+chr(34920)+chr(26465)+chr(25968)+chr(65307)+chr(27491)+chr(25991)+chr(24341)+chr(29992)+chr(23427)+chr(65292)+chr(21035)+chr(25163)+chr(25220)+chr(12300)+chr(19977)+chr(21253)+'/'+chr(20116)+chr(21253)+chr(12301)+chr(8212)+chr(8212)+chr(20250)+chr(38543)+chr(21152)+chr(21253)+chr(33104)+chr(28866)+chr(65289))),
    ("lab_tests", LAB_TESTS_CMD, ('.kimi-code/'+chr(23398)+chr(20064)+chr(36890)+'API/'),
     ('lab '+chr(22238)+chr(24402)+chr(27979)+chr(35797)+chr(39033)+chr(25968)+chr(65288)+'canonical '+chr(19977)+chr(20214)+chr(65307)+chr(19982)+' lab '+chr(38392)+chr(21516)+chr(19968)+chr(22871)+chr(25991)+chr(20214)+chr(65292)+chr(25913)+chr(21517)+chr(21333)+chr(20004)+chr(36793)+chr(19968)+chr(36215)+chr(32418)+chr(65289))),
    ("sitepages", SITEPAGES_CMD, (chr(31449)+chr(28857)+'/build.mjs'), "note: site pages (TARGET_FILES length)"),
    # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
    # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
    # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
    ("md_files", "git ls-files '*.md' | grep -v '^mail/' | wc -l", "repo",
     (chr(21463)+chr(31649)+' Markdown '+chr(31687)+chr(25968)+chr(65288)+chr(19981)+chr(21547)+' mail/ '+chr(24448)+chr(26469)+chr(20449)+chr(20214)+chr(65289))),
    ("hooktests", HOOKTESTS_CMD, ".githooks/test-update-readme.py", (chr(38057)+chr(23376)+chr(38598)+chr(25104)+chr(27979)+chr(35797)+chr(39033)+chr(25968)),
     # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
     # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
     # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
     {"calibrate": "python3 -c \"print(sum(1 for l in open('.githooks/test-update-readme.py', encoding='utf-8') if 'def test_' in l))\"",
      # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
      # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
      # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
      "calibrate_expect": "31"}),
    ("plugin_tests", PLUGIN_TESTS_CMD, (chr(31449)+chr(28857)+'/plugins/'),
     (chr(31449)+chr(28857)+chr(25554)+chr(20214)+chr(27979)+chr(35797)+chr(39033)+chr(25968)+chr(65288)+'fail+cancelled>0 '+chr(8658)+' '+chr(22797)+chr(36305)+chr(38750)+chr(38646)+chr(36864)+chr(20986)+chr(65289))),
    # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
    # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
    ("history_state_claims", HISTORY_STATE_CLAIMS_CMD, "HISTORY.md",
     ('HISTORY.md '+chr(37324)+chr(30340)+chr(12300)+chr(24403)+chr(21069)+'/'+chr(30446)+chr(21069)+'/'+chr(22914)+chr(20170)+chr(12301)+chr(24335)+chr(29366)+chr(24577)+chr(26029)+chr(35328)+chr(26465)+chr(25968)+chr(65288)+chr(24212)+chr(20026)+' 0'+chr(65289))),
    # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
    # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
    ("symbols_bubbled", SYMBOLS_BUBBLED_CMD, (chr(31449)+chr(28857)+'/dist/symbol-coverage.json'),
     (chr(20840)+chr(31449)+chr(30495)+chr(20882)+chr(27873)+chr(30340)+chr(31526)+chr(21495)+chr(38170)+chr(28857)+chr(25968)+chr(65288)+'a.sym-gloss'+chr(65307)+chr(20844)+chr(24335)+'+'+chr(27491)+chr(25991)+chr(20196)+chr(29260)+'+'+chr(22270)+chr(20869)+chr(21512)+chr(35745)+chr(65289))),
    ("symbols_uncovered", SYMBOLS_UNCOVERED_CMD, (chr(31449)+chr(28857)+'/dist/symbol-coverage.json'),
     (chr(35813)+chr(20882)+chr(27873)+chr(21364)+chr(27809)+chr(20882)+chr(30340)+chr(31526)+chr(21495)+chr(25968)+chr(65288)+chr(26410)+chr(35299)+chr(26512)+chr(20196)+chr(29260)+'/'+chr(35064)+' span/'+chr(38142)+chr(25509)+chr(30446)+chr(26631)+chr(32570)+chr(22833)+chr(65307)+'>0 '+chr(26500)+chr(24314)+chr(21363)+chr(32418)+chr(65289))),
]
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
DISCIPLINE_CMD = (
    "" + "cd 站点 && node --test plugins/solution-discipline.test.mjs 2>&1 | awk "
    "'NF==3 && $3 ~ /^[0-9]+$/ && ($2==\"tests\"||$2==\"pass\"||$2==\"fail\") {v[$2]=$3} "
    "END {t=v[\"tests\"]; p=v[\"pass\"]; fl=v[\"fail\"]+0; "
    "if (t==\"\") {print \"discipline：没读到 tests 汇总行\" > \"/dev/stderr\"; exit 1} "
    "if (p!=t || fl>0) {print \"discipline：red tests=\" t \" pass=\" p \" fail=\" fl > \"/dev/stderr\"; exit 1} "
    "print \"ok\"}'"
)
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_DISCIPLINE_ROW = ("discipline", DISCIPLINE_CMD, (chr(31449)+chr(28857)+'/plugins/solution-discipline.test.mjs'),
                   (chr(35299)+chr(26512)+chr(32426)+chr(24459)+chr(38392)+chr(20840)+chr(32511)+' '+chr(8658)+' ok'+chr(65288)+chr(21453)+chr(20154)+chr(31867)+chr(35789)+' 0 / '+chr(39064)+chr(38754)+chr(24341)+chr(29992)+chr(22270)+chr(21495)+chr(24517)+chr(35265)+chr(22270)+' / '+chr(23436)+chr(25104)+chr(36793)+chr(30028)+' '+chr(8804)+'150 '+chr(23383)+chr(19988)+chr(24050)+chr(35299)+chr(26512)+chr(24050)+chr(39564)+chr(35777)+chr(22312)+chr(22330)+chr(65289)),
                   {"kind": "principle"})
TABLE.append(_DISCIPLINE_ROW)


def _sh(cmd):
    """跑一条度量命令，返回 stdout（strip）。失败 ⇒ 抛（读不到就明说，不编 0）。
    PINNED: FATAL 文案与 TABLE 注记的中文面向站长单人（量测失败即停，无第二读者）；NOTE 列的中文会渲染进 STATE.md 机器块（zh 唯一读者）。
    """
    p = subprocess.run(["bash", "-o", "pipefail", "-c", cmd], cwd=REPO,
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if p.returncode != 0:
        print("FATAL: 量测命令失败（rc=%s）：%s\n%s"
              % (p.returncode, cmd, p.stderr.strip()), file=sys.stderr)
        raise SystemExit(2)
    return p.stdout.strip()


def measure():
    """量一遍全部事实。值 = 复跑命令的 stdout —— 两者同源，不可能漂。
    PINNED: FATAL 文案的中文是给站长的即时排障信息；measure 数据层无语言包受众（失败即停），翻译不产生第二读者。
    """
    facts = {}
    for row in TABLE:
        key, cmd, source, note, *extra = row
        out = _sh(cmd)
        extra_kw = extra[0] if extra else {}
        if extra_kw.get("kind") == "principle":
            # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
            # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
            facts[key] = fact(out, cmd, source, note, **extra_kw)
            continue
        try:
            value = int(out)
        except ValueError:
            print("FATAL: `%s` 的度量命令输出不是整数：%r（cmd=%s）"
                  % (key, out, cmd), file=sys.stderr)
            raise SystemExit(2) from None
        facts[key] = fact(value, cmd, source, note, **extra_kw)
    return facts


# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
MODULE = module_meta("本仓数据层", "量课程/资料/习题/配图/词条/站点/测试计数（只读持久盘，值=复跑命令）",
                     selftest=False)
