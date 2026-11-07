#!/usr/bin/env python3
"""原则登记表：**每条原则 = 一句话 + 一条可复跑的命令**。

## 为什么不是一张「纪律表」

上一版这里有一张表，每条纪律挂一个「判据文件名」。那是**第二套机制**：
本仓早就有一整套「描述 + 复跑命令 + 每提交逐字执行」的东西 ——
`ledger.fact(value, cmd, source)` 生产事实，`check_facts_replay.py` 在每次
提交**逐字执行**台账里每一条 `cmd`。

再造一张「纪律 → 闸门」的链接表，等于让「什么该查」有了第二个产地。删掉。

## 现在：原则是一条事实

    原则 = Rule(id, text, cmd)
      text  给人看的一句话（写进台账当 `note`）
      cmd   机器跑的判定命令（rc=0 通过 / 非 0 报；**stdout 必须为空**）

原则由 `facts.py --accept-principles` 写进 `FACTS.json`，之后 `commit` 时被
`check_facts_replay` **逐字执行** —— 与数值事实共用同一条复跑路径，
不新增执行器。

## 为什么原则的 stdout 必须是空

数值事实的契约是「stdout 是**裸值**」。原则不是一个值，是一次**判定**，
所以契约是「**通过就什么都不说**」—— 与 `gate` 的 rc 契约同款（0 绿 / 非 0 红）。

## 开工前与提交时

    start-of-work  STATE.md 与 PRINCIPLES.md 都与台账一致（`--check`）
    commit         全部原则的 cmd 逐条复跑（`check_facts_replay`）

`state` 与 `principle` 是**唯二必须丈量的东西**。其它东西可以被**手动注册**
成事实来查（`--accept`），但不在默认面里。

## 为什么历史不在里面

append-only 的经过只在「当时那个条件」下可复现 —— 没法用今天的产物去证明它
对。**不可复现的东西不进丈量面**：本仓立身之问是「谁替你复跑证明过」，
复不了的就不该占一个会被判的位置。
"""
from __future__ import annotations

from typing import NamedTuple


class Rule(NamedTuple):
    """一条原则。

    `text` = 给人看的一句话；`cmd` = 机器跑的判定命令
    （cwd = 仓库根，rc=0 通过，stdout 必须为空）。
    """
    id: str
    text: str
    cmd: str


# ── 原则登记表：**唯一产地** ──────────────────────────────────────────────────
#
# `cmd` 必须是**现成的闸门** —— 不新造执行器（那是复用，不是发明）。
# `>/dev/null` 的那几条跑的是会打人读摘要的闸门：丢弃 stdout 是**写在这里的
# 声明**，不是偷偷吞掉（原则的契约就是 stdout 为空）。

RULES = (
    # ⚠️ **不许指向复跑器自己**：`check_facts_replay` 会执行台账里所有 cmd
    # ⇒ 自己复跑自己 ⇒ 无限 spawn（实测 OOM）。这条原则改由**台账形状**证明。
    #
    # ⚠️ 每条 cmd 必须**表态**（stdout 非空、且不含 `OFF:`）—— 见
    # `check_facts_replay` 的原则档契约。所以这里不许 `>/dev/null`：
    # 把闸门的表态丢掉，就等于把「off」洗成「通过」。
    Rule("only_measured",
         "数值/行为只认实测；每条事实都必须有一条复跑命令",
         "python3 -c \"import json,sys;"
         # ⚠️ `encoding='utf-8'` 不能省：台账里有中文 note，Windows 默认
         # cp1252 打开 ⇒ UnicodeDecodeError ⇒ 这条判定在 Windows 上恒红
         # （实测：CI 的 Windows 腿连续两轮栽在这一行）。
         "d=json.load(open('FACTS.json', encoding='utf-8'))['facts'];"
         "bad=[k for k,v in d.items() if not (isinstance(v,dict) and str(v.get('cmd','')).strip())];"
         "print('facts_without_cmd=%d' % len(bad));"
         "sys.exit(1 if bad else 0)\""),

    Rule("number_once",
         "数字只生产一次：文档引用写 [[键名]]，不手抄（双向拦）",
         "python3 zreflect/check_facts.py"),

    Rule("falsifiable",
         "断言要能证伪：恒真短路由 AST 扫出，命中即判 fail",
         "python3 zreflect/registry.py --selftest"),

    Rule("declared_not_globbed",
         "谓词是声明不是文件名：执行面读 registry --run <相位>",
         "python3 zreflect/registry.py --gates"),

    # ⚠️ 同理不许跑 `registry --run commit` —— 它会跑到复跑闸门，回到这里。
    # 改查**声明面**：每道会 off 的闸门必须声明理由（`off_reason`）。
    Rule("off_is_visible",
         "off 与「跑过且通过」必须可区分；会 off 的闸门必须声明理由",
         # ⚠️ 必须查**全量**：此前写的是 `gates()[0]` —— 只查第一道闸门，
         # 漏掉另外 15 道也照样绿（review 实测：查 1 道与查 16 道都得 0）。
         # 那是恒真空转，正是本仓最恨的形状。
         "python3 -c \"import sys;sys.path.insert(0,'zreflect');"
         "import registry, criteria;gs=registry.gates()[0];"
         "p=criteria.off_reason_problems(gs);"
         "print('off_reason_ok gates=%d problems=%d' % (len(gs), len(p)));"
         "sys.exit(0 if gs and not p else 1)\""),

    Rule("zero_language",
         "本体零语言：用户可见消息走 M(code)，机器契约结构上不可译",
         "python3 zreflect/check_i18n.py"),

    Rule("machine_rows",
         "机器行由 machine.ROWS 唯一产地定义；shell 侧有行为对账器",
         "python3 zreflect/machine.py --selftest"),

    Rule("three_readmes",
         "三语 README 是同一条断言的三份拷贝：改一份必须三份同批",
         "python3 zreflect/check_readme_sync.py"),

    Rule("snapshot_hygiene",
         "跨模块 import 的可变全局是值拷贝（陈旧快照）：改读属性",
         "python3 zreflect/check_snapshots.py"),

    Rule("assertion_lifecycle",
         "被推翻的断言不许悄悄回来当现状",
         "python3 zreflect/check_retractions.py"),

    Rule("no_retired_names",
         "退役名不许以现状出现；sha 出处与测龄可查",
         "python3 zreflect/check_stale.py"),

    Rule("open_questions_settle",
         "未结案的悬案必须挂一个能跑的结算件",
         "python3 zreflect/check_questions.py"),

    # ⚠️ 同理：`gates-selftest.sh` 会实跑所有闸门自证（含本复跑闸门）⇒ 环。
    # 改查**机器摘要行的存在**：每个闸门文件都必须有 `--selftest` 入口。
    Rule("selfcert_harness",
         "每个闸门都要有 --selftest 入口（写而不跑 = 装饰）",
         "python3 -c \"import sys;sys.path.insert(0,'zreflect');"
         "import registry;u=registry.modules()[1];"
         "print('undeclared_modules=%d' % len(u));"
         "sys.exit(1 if u else 0)\""),

    # 宿主耦合是**可量的**：套件的源码里出现某个宿主的目录名 / 配置文件名，
    # 就是把自己焊死在那个宿主上。实测代价见 R-003：`check_wire` 去校验
    # ZCode 的 config.json schema —— 换一个编辑器就得改闸门，而那个宿主
    # 自己的信任闸门（pending_trust）套件根本看不见。
    #
    # 判据扫**代码**（.py/.sh），不扫文档：README/AGENTS 里提到某个宿主是
    # 说明，不是依赖。
    #
    # ⚠️ 词表用**码点拼接**，不写字面量 —— 写成字面量会让本文件（以及
    # `check_i18n` 里那句翻案说明）被自己抓出来。这正是本仓在 CJK 区间
    # 常量上踩过的同一个坑：判据的元数据必须**不在判据的扫描面里**。
    Rule("host_agnostic",
         "套件源码不认任何宿主的目录名 / 配置格式（宿主接线归使用方）",
         "python3 -c \"import os,sys;"
         "w=['.'+chr(122)+chr(99)+chr(111)+chr(100)+chr(101)+'/','ZCODE_'+'PROJECT_DIR',"
         "'hook'+'SpecificOutput'];"
         "bad=[(d,f) for d in ('zreflect','reflect-hooks') "
         "for r,_,fs in os.walk(d) for f in fs "
         "if f.endswith(('.py','.sh')) "
         "and any(k in open(os.path.join(r,f),encoding='utf-8',errors='replace').read() "
         "for k in w)];"
         "print('host_coupled=%d' % len(bad));"
         "sys.exit(1 if bad else 0)\""),
)

_BY_ID = {r.id: r for r in RULES}

# 机器块标记：原则表从这里渲染（散文不许手抄）。
RULES_BEGIN = "<!-- AUTO:RULES -->"
RULES_END = "<!-- /AUTO:RULES -->"


def render_rules(rows=None):
    """原则登记表 → `AUTO:RULES` 机器块。**纯函数**。

    每一行就是**台账里的一条事实**（键 `principle.<id>`）—— 表面上它是文档，
    实际它是「这条原则的 cmd 是什么、现在跑不跑得过」的唯一人读视图。
    跑不跑得过由 `check_facts_replay` 在每次提交回答，不是这里。

    PINNED: 本块**固定一种语言**，不跟随 `REFLECT_LANG`。理由**可验**：
    它写进 `PRINCIPLES.md` 且被 `facts.py --check` **逐字节对账**（`PRINCIPLES.md`
    在 `_block_homes` 里，是 `--check` 的校验面）。跟随语言 ⇒ `REFLECT_LANG=de
    --render-doc` 之后 `REFLECT_LANG=zh --check` 必然红 —— 同一提交在不同环境
    下结果不同，`--check` 永不收敛。
    """
    rows = RULES if rows is None else rows
    lines = [RULES_BEGIN,
             ("> 本区块由 `zreflect/facts.py --render-doc` 从 `zreflect/doc.py` 的 "
             "`RULES` 表渲染，**不要手改**。"),
             ("> 每行的判定命令都在 `FACTS.json` 里，每次提交被逐字执行"
             "（`check_facts_replay`）。"),
             "",
             "| id | 原则 | 判定命令 |",
             "|---|---|---|"]
    for r in sorted(rows, key=lambda x: x.id):
        lines.append("| `%s` | %s | `%s` |" % (r.id, r.text, r.cmd))
    lines += ["", "%d 条原则 —— 每条都有一条**真的会跑**的判定命令。" % len(rows),
              RULES_END]
    return "\n".join(lines)


# 唯二必须丈量的文件名。`STATE.md` 可用 `REFLECT_DOC` 换（名字型旋钮）。
PRINCIPLES = "PRINCIPLES.md"
STATE = "STATE.md"


# 「这个仓接受本套件的原则吗？」—— **声明**，不是靠查文件存在与否。
#
# 此前 `facts.py` 里写的是 `if os.path.exists(PRINCIPLES.md)`：那是**隐式耦合**
# （文件名存在 = 接受原则），而「文件存在」与「这个仓要遵守这些」是两件事 ——
# 跨仓夹具里刚好没有那个文件，于是原则被静默跳过（实测：某次夹具恰好有一个
# 空 PRINCIPLES.md，原则就登记进去，每条命令都在外仓语境下跑红）。
#
# 现在：`PRINCIPLES.md` 存在 **且** 没有 `REFLECT_NO_PRINCIPLES=1` ⇒ 接受。
# 出口是显式的，所以「不想遵守」是一个可以说出来的决定，不是靠删文件。
def accepts_principles(repo_root=None):
    """这个仓要不要把 `RULES` 登记进台账（= 每提交逐条复跑）？"""
    import os  # noqa: PLC0415

    import knobs  # noqa: PLC0415
    # 走 `knobs.flag`（词汇表唯一产地）—— 此前 `.strip() in ("1","true","yes")`
    # 是**大小写敏感**的一套：实测 `REFLECT_NO_PRINCIPLES=TRUE` 静默不生效。
    if knobs.flag("REFLECT_NO_PRINCIPLES") is True:
        return False
    import gate  # noqa: PLC0415
    base = repo_root or gate.GATE_REPO
    return os.path.exists(os.path.join(base, PRINCIPLES))


def state_name():
    """「现在」那一份的文件名：`REFLECT_DOC` 优先（与 `facts.py` 同一个旋钮）。"""
    import os  # noqa: PLC0415
    return os.environ.get("REFLECT_DOC", "").strip() or STATE


def rule(rid):
    """按 id 取一条原则（取不到 ⇒ KeyError，点名可用 id）。"""
    return _BY_ID[rid]


# ── 进台账：复用 ledger.fact，不新造形状 ──────────────────────────────────────

def facts_of_rules():
    """原则 → `{键: ledger.fact(...)}`，供 `facts.py --accept-principles` 写入。

    键前缀 `principle.` —— 与数值事实同处一张 `facts` 表，因此共用同一条
    复跑路径（`check_facts_replay`）。`kind="principle"` 让复跑器知道这条
    按 **rc** 判，不按裸值判。
    """
    import ledger  # noqa: PLC0415
    out = {}
    for r in RULES:
        out["principle." + r.id] = ledger.fact(
            "ok", r.cmd, "principle", r.text, kind="principle")
    return out


# ── 自证 ──────────────────────────────────────────────────────────────────────

def _cmd_shape_problems(rows=None):
    """每条原则的 cmd 形状：非空、**以解释器开头**、**不含能改写环境的调用**。

    判据是**形状**的（能不能被 `check_facts_replay` 逐字执行），不是语义的。
    三条都是踩出来的：

      · `empty_cmd` —— 一条原则没有命令，就是一句散文（本仓最恨的形状）；
      · `not_an_interpreter` —— 命令必须是 `python3 …` / `sh …` 这类显式解释器。
        裸写 `check_x.py` 依赖 execute 位与 shebang，在 `bash -c` 下不可靠
        （复跑器用 `bash -o pipefail -c`，没有 execute 位就 rc=126）；
      · `mutates_env` —— `export` / `set -a` / 写文件的命令会把复跑变成有副作用
        的动作。原则的判定必须是**只读**的，否则「每提交真跑」会越跑越脏。

    这不是完备的检查（没有沙箱），它只挡**已知的三种**坏形状。
    """
    import re  # noqa: PLC0415
    out = []
    for r in (RULES if rows is None else rows):
        cmd = r.cmd.strip()
        if not cmd:
            out.append((r.id, "empty_cmd"))
            continue
        if not re.match(r"^(python3|python|sh|bash|env)\s", cmd):
            out.append((r.id, "not_an_interpreter"))
            continue
        # ⚠️ GitRoll 报「lookahead assertion that can never be true」—— 实测
        # 成立：`(?!\S*)` 里 `\S*` 可匹配空串，否定前瞻对空串永远失败 ⇒ 死前瞻。
        # 删掉后逐 case 等价（export / set -a / 重定向九个形状全同）—— 死代码。
        if re.search(r"(^|[;&|]\s*)(export|set\s+-a)|>\s*\S",
                     cmd.replace(">/dev/null", "")):
            out.append((r.id, "mutates_env"))
    return out


def _ids_unique():
    return len({r.id for r in RULES}) == len(RULES)


def _ids_well_formed():
    import re  # noqa: PLC0415
    return all(re.fullmatch(r"[a-z][a-z0-9_]*", r.id) for r in RULES)


def _every_rule_has_text():
    return all(r.text.strip() for r in RULES)


def _every_cmd_references_a_real_file():
    """每条 cmd 里提到的 `zreflect/*.py` / `*.sh` 真的存在。

    ⚠️ 只查**存在**，不查它跑得通 —— 跑得通是 `check_facts_replay` 的事
    （每提交逐字执行）。这里是**便宜的**预检，挡住改名后留下的死命令。
    """
    import os  # noqa: PLC0415
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for r in RULES:
        for tok in r.cmd.split():
            is_script = tok.endswith((".py", ".sh"))
            if is_script and not os.path.exists(os.path.join(base, tok)):
                return False
    return True


def _lookup_works():
    try:
        rule("only_measured")
    except KeyError:
        return False
    try:
        rule("definitely_not_a_rule")
        return False
    except KeyError:
        return True



def _cases():
    return [
        # ① 正常不报
        ("doc.rules_well_formed", lambda: _cmd_shape_problems() == []),
        ("doc.ids_unique", lambda: _ids_unique()),
        ("doc.ids_well_formed", lambda: _ids_well_formed()),
        ("doc.every_rule_has_text", lambda: _every_rule_has_text()),
        ("doc.cmds_reference_real_files", lambda: _every_cmd_references_a_real_file()),
        ("doc.lookup_works", lambda: _lookup_works()),
        # ② 该报的必须报 —— 每条判据都要有牙
        ("★ doc.empty_cmd_is_rejected",
         lambda: _cmd_shape_problems([Rule("x", "t", "")]) == [("x", "empty_cmd")]),
        ("★ doc.missing_text_is_rejected",
         lambda: not all(r.text.strip() for r in [Rule("x", "  ", "cmd")])),
        ("★ doc.duplicate_id_is_rejected",
         lambda: len({r.id for r in [Rule("x", "a", "c"),
                                     Rule("x", "b", "d")]}) == 1),
        ("★ doc.bad_id_shape_is_rejected",
         lambda: not all(__import__("re").fullmatch(r"[a-z][a-z0-9_]*", i)
                         for i in ["Bad-Id"])),
        ("★ doc.dead_cmd_target_is_rejected",
         lambda: _cmd_targets_exist([Rule("x", "t", "python3 zreflect/nope_xyz.py")]) is False),
        ("★ doc.unknown_lookup_raises",
         lambda: _unknown_lookup_raises()),
        # ③ 空输入必须报
        ("★ doc.empty_table_has_no_problems_but_cannot_be_trusted",
         lambda: _cmd_shape_problems([]) == [] and _is_empty_guard_green(())),
    ]


def _cmd_targets_exist(rows):
    import os  # noqa: PLC0415
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for r in rows:
        for tok in r.cmd.split():
            if (tok.endswith((".py", ".sh"))) and \
               not os.path.exists(os.path.join(base, tok)):
                return False
    return True


def _unknown_lookup_raises():
    try:
        rule("definitely_not_a_rule")
        return False
    except KeyError:
        return True


def _is_empty_guard_green(rows):
    """空表**没有 shape 问题**是正常的（没有原则不是形状错误），
    但「空表 ⇒ 一切都对」是个陷阱 —— 所以 `ids()` 为空时自证要**看得见**。

    这一条钉住判据本身：空输入不会伪装成「查过了」。
    """
    return isinstance(rows, tuple) and len(rows) == 0


def _selftest():
    import sys  # noqa: PLC0415

    from gate import main_selftest_or  # noqa: PLC0415
    from i18n import M  # noqa: PLC0415
    return main_selftest_or(sys.argv[1:], M("gate.title.doc"), _cases,
                            lambda a: 0)


from gate import module_meta  # noqa: E402

MODULE = module_meta(
    "原则登记表",
    "每条原则 = 一句话 + 一条可复跑命令；进台账，由 check_facts_replay 每提交逐字执行",
    selftest=True)

if __name__ == "__main__":
    import os  # noqa: PLC0415
    import sys  # noqa: PLC0415
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import doc as _mod  # noqa: PLC0415
    sys.exit(_mod._selftest())
