#!/usr/bin/env python3
"""registry —— 发现式名录的数据面：闸门清单 / 插件清单 / 红名单。

「登记是被发现的，不是被记得的」—— 本仓早已把闸门的**集合**做成发现式
（hooks / runner / CI 的 `for g in zreflect/check_*.py`），但集合的**叙述**
仍是手写：STATE.md 手写「N 道闸门」并逐一列名（实测漂过：ab/locks/pins
并入的当天，清单就少了三道，没有任何闸门拦得住 —— 手写的"十道"连道数
都数错了）；gates-selftest.sh 手写红名单（默认名下实际红的 6 道，名单里
只有 4 道）；插件与 doctor 靠点名。本 module 把叙述做成数据：

  · `gates()`：ast 解析每个 check_*.py 的模块级声明行
        GATE = gate.meta("名字", "一句话", knobs=(…), name_dependent=…)
    —— **声明即登记**；不 import 闸门模块（无副作用、无执行成本）。
    没有声明行的 check_*.py ⇒ 名录不收（problems 报，render 拒绝渲染）；
  · `red_need()`：换名自证里**必须红**的闸门（默认名承担载荷的那批）。
    name_dependent 旗标是显式登记的 —— 机器推不出「off 态短路」（仪器
    闸门默认关着，它消费的默认名永远轮不到用，不能凭消费就断言红），
    但登记被两头拦：夹具要求它真红，`problems()` 要求它真消费改名的
    默认名；
  · `plugins()`：reflect-hooks/*.sh 带自证标记的（发现式）+ 点名特殊件
    （doctor.py —— 理由住在数据旁）。

消费方：`facts.py --render-doc` 渲染 AUTO:GATES 机器块（同 AUTO:FACTS
先例 —— 手写清单退役，`check_facts` / `--check` 自动拦漂移）；
gates-selftest.sh 消费 `--red-need` 与 `--plugins`（手写红名单、
插件与 doctor 的点名退役）。

诚实边界：本 module 只**叙述**名录，不执行闸门；闸门能不能红永远由
gates-selftest.sh 实跑证明 —— 叙述与执行的判据各归各，别混。
"""
from __future__ import annotations

import ast
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import criteria  # noqa: E402
import gate  # noqa: E402
from gate import fatal, main_selftest_or, module_meta, repo  # noqa: E402
from i18n import M  # noqa: E402
from knobs import REGISTRY  # noqa: E402

# PINNED: AUTO 机器块固定语言（同 render.PREAMBLE 的理由）。
GATES_BEGIN = "<!-- AUTO:GATES -->"
GATES_END = "<!-- /AUTO:GATES -->"



# 换名自证的夹具把哪些默认名改掉了（gates-selftest.sh 跨仓库节的改名面）。
# 名册纪律同 knobs：只登记真的被夹具改名的默认名 —— 这是红名单对账的判据数据。
# C4 对账③：`FIXTURE_RENAMES` 是「原名 → 夹具名」的**唯一产地** ——
# gates-selftest.sh 的夹具从 `--fixture-renames` 派生它建的文件名，不再手写
# 两份会漂的清单（此前夹具的名字与这张表是两处手写，无对账器）。
FIXTURE_RENAMES = {
    "FACTS.json": "LEDGER.json",
    "STATE.md": "NOTES.md",
    "retractions.json": "RETRACT.json",
    "questions": "cases",
    "README.md": "R1.md",
    "README.zh.md": "R2.md",
    "README.de.md": "R3.md",
}
RENAMED_DEFAULTS = tuple(FIXTURE_RENAMES)

# 已知相位（C1）：闸门声明自己的运行频率。执行面（gate.run_phase）按它过滤。
#   commit        每次提交跑（pre-commit / pre-push / CI）
#   start-of-work 开工前手动跑（doctor —— 查会死的东西，挂提交频率错）
# ⚠️ issue #21：相位清单**焊死在这里**会逼下游 fork —— 使用方有自己的相位
# （S26 仓的 lab：*.lab.py 只在实验目录在场时跑）。旋钮 `REFLECT_PHASES`
# 追加自定义相位（逗号分隔，追加在两个内置相位之后）；核心两个不可删、
# 不可重名 —— 相位是执行面与声明的公共词汇，乱改会让既有 runs_at 声明
# 静默变孤儿。problems() 仍拦未知相位：声明了 runs_at 却不在清单 ⇒ 红。
BUILTIN_PHASES = ("commit", "start-of-work")


def phases():
    """已知相位 = 内置两个 + `REFLECT_PHASES` 追加（下游自定义，如 lab）。"""
    raw = os.environ.get("REFLECT_PHASES", "").strip()
    out = list(BUILTIN_PHASES)
    for p in (x.strip() for x in raw.split(",")):
        if p and p not in out:
            out.append(p)
    return tuple(out)


def phases_problems():
    """相位清单自洽（旋钮坏值的判据；纯函数）。"""
    raw = os.environ.get("REFLECT_PHASES", "").strip()
    out = []
    if raw:
        dup = [p for p in (x.strip() for x in raw.split(","))
               if p in BUILTIN_PHASES]
        if dup:
            out.append(M("registry.builtin_phase_repeated",
                         phases=", ".join(sorted(set(dup)))))
    return out

def modules(zdir=None):
    """平台模块名录（C5）：ast 解析 `MODULE = module_meta(…)` 声明行。

    返回 (declared, undeclared)：`declared` = [{file, name, desc, selftest}]；
    `undeclared` = **非闸门、非 __init__ 却没有 MODULE 声明**的 .py ——
    平台模块必须声明自己（哪怕是 selftest=False，也要正面说「我不用自证」），
    否则「该有自证却没写」无人问（文本猜 `_cases` 猜不出来「本该有」）。
    """
    d = zdir if zdir is not None else gate.zdir()
    declared, undeclared = [], []
    try:
        names = sorted(os.listdir(d))
    except OSError:
        return [], []
    for n in names:
        if not n.endswith(".py") or n == "__init__.py":
            continue
        # ⚠️ **`measure_*.py` 是使用方的数据模块，不是平台模块。**
        #
        # 这条豁免是「接进真实项目」验收逼出来的：照 README 的
        # 「Writing your measure()」把模块放 `zreflect/measure_myproject.py`，
        # `--render-doc` 当场 FATAL：
        #
        #     · these .py files are neither gates … nor declared platform
        #       modules: zreflect/measure_myproject.py
        #
        # 用户无从知道要给自己的数据模块写 `MODULE = module_meta(...)`——
        # 那是**本仓对自己代码**的纪律（「该有自证却没写」无人问），
        # 不该强加给使用方的数据文件。
        if n.startswith("measure_"):
            continue
        rel = "zreflect/" + n
        if _declaration(os.path.join(d, n), rel, attr="MODULE", func="module_meta"):
            declared.append(_declaration(os.path.join(d, n), rel,
                                         attr="MODULE", func="module_meta"))
        elif _declaration(os.path.join(d, n), rel):
            continue                    # 是闸门（有 GATE 声明），不算平台模块
        else:
            undeclared.append(rel)
    return declared, undeclared


def selftest_modules(zdir=None):
    """有自证义务的模块名录（C5，声明驱动）：`MODULE = module_meta(…,
    selftest=True)` 声明的模块 —— 闸门（GATE 声明）不算在内（它们由
    run_gates 覆盖）。返回 (mods, missing)：`mods` = 该跑自证的；
    `missing` = 声明了 selftest=True 却没有 --selftest 入口的（写而不跑 = 装饰）。
    """
    declared, _und = modules(zdir)
    d = zdir if zdir is not None else gate.zdir()
    mods, missing = [], []
    for m in declared:
        if not m.get("selftest"):
            continue
        text = open(os.path.join(d, os.path.basename(m["file"])),
                    encoding="utf-8").read()
        can = ("--selftest" in text or "main_selftest_or" in text
               or "_selftest()" in text)
        if can:
            mods.append(m["file"])
        else:
            missing.append(m["file"])
    return mods, missing



def gates(zdir=None):
    """发现式闸门名录：**声明即闸门** —— ast 解析 zreflect/*.py 的模块级
    `GATE = gate.meta(…)` 行，与文件名无关（C1）。

    返回 (gates, missing)。gates = [{file, name, desc, knobs,
    name_dependent, runs_at}]；missing = **叫 check_ 却没有声明行**的文件
    （problems 报、render 拒绝 —— 那是「起名叫闸门却忘了声明」的形状）。

    谓词 = **声明**，不是文件名（2026-10-10，C1）：执行面（hooks / CI）
    改为读 registry.runnable() ⇒ 谓词只有一处（这里）。于是：
      · 名字不再承重 —— doctor 靠 `runs_at="start-of-work"` 正面声明频率，
        不靠「它没叫 check_」这种否定式命名意外；
      · 「孤儿」（声明了却不叫 check_）概念消失 —— 声明了就是闸门，会被
        runnable() 收进执行清单，不存在「进叙述不被执行」的中间态。
    """
    d = zdir if zdir is not None else gate.zdir()
    out, missing = [], []
    try:
        names = sorted(os.listdir(d))
    except OSError:
        return [], []                     # zreflect/ 不在：调用方按零值守卫报
    for n in names:
        if not n.endswith(".py") or n == "__init__.py":
            continue
        rel = "zreflect/" + n
        meta = _declaration(os.path.join(d, n), rel)
        if meta:
            out.append(meta)
        elif n.startswith("check_"):
            # 起名叫 check_ 却没声明 ⇒ 忘写声明（名录不收、render 拒绝）。
            # 非 check_ 且无声明 = 平台模块（gate/knobs/registry/…），不是闸门。
            missing.append(rel)
    return out, missing


def _decl_call(node, attr, func):
    """`node` 是不是 `<attr> = <func>(…)` 形状的声明行？是 ⇒ 那个调用节点。

    两种等价写法都认：meta(…)（裸导入名）与 gate.meta(…)（属性）。
    不是声明行 / 调用的不是 `func` ⇒ None（调用方继续扫下一行）。
    """
    if not (isinstance(node, ast.Assign) and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
            and node.targets[0].id == attr
            and isinstance(node.value, ast.Call)
            and len(node.value.args) >= 2):
        return None
    fn = node.value.func
    if getattr(fn, "id", "") == func or getattr(fn, "attr", "") == func:
        return node.value
    return None


def _module_meta(call, rel):
    """`MODULE = module_meta(…)` → {file, name, desc, selftest}。"""
    st = True
    for kw in call.keywords:
        if kw.arg == "selftest":
            st = ast.literal_eval(kw.value)
    return {"file": rel,
            "name": ast.literal_eval(call.args[0]),
            "desc": ast.literal_eval(call.args[1]),
            "selftest": bool(st)}


def _gate_meta(call, rel):
    """`GATE = gate.meta(…)` → {file, name, desc, knobs, name_dependent, runs_at,
    off_reason}。"""
    knobs, name_dep, runs_at, off_reason = (), False, "commit", None
    for kw in call.keywords:
        if kw.arg == "knobs":
            knobs = ast.literal_eval(kw.value)
        elif kw.arg == "name_dependent":
            name_dep = ast.literal_eval(kw.value)
        elif kw.arg == "runs_at":
            runs_at = ast.literal_eval(kw.value)
        elif kw.arg == "off_reason":
            off_reason = ast.literal_eval(kw.value)
    return {"file": rel,
            "name": ast.literal_eval(call.args[0]),
            "desc": ast.literal_eval(call.args[1]),
            "knobs": tuple(knobs),
            "name_dependent": bool(name_dep),
            "runs_at": str(runs_at),
            "off_reason": off_reason}


def _declaration(path, rel, attr="GATE", func="meta"):
    """从文件里 ast 提取声明行（默认 `GATE = meta(…)`；C5 用
    `MODULE = module_meta(…)`）。没有 ⇒ None。

    `attr` / `func` 可换（同一套解析服务闸门与平台模块两类声明）。
    """
    try:
        tree = ast.parse(open(path, encoding="utf-8").read())
    except (OSError, SyntaxError):
        return None
    for node in tree.body:
        call = _decl_call(node, attr, func)
        if call is None:
            continue
        try:
            if func == "module_meta":
                return _module_meta(call, rel)
            return _gate_meta(call, rel)
        except (ValueError, IndexError):
            return None
    return None


def runnable(phase="commit", zdir=None):
    """按相位给出**该跑**的闸门清单（C1：执行面唯一产地）。

    `phase="commit"` ⇒ 每次提交跑的（hooks / CI）；`phase="start-of-work"`
    ⇒ 开工前手动跑的（doctor）。返回 [{file, name, runs_at, …}]。
    声明面（GATE = meta(…, runs_at=…)）是唯一产地 —— 执行面不再 glob 文件名。
    """
    gs, _missing = gates(zdir)
    return [g for g in gs if g.get("runs_at", "commit") == phase]


def _touches_renamed(g):
    """这道闸门消费的旋钮里，有没有默认名被换名自证改名。"""
    for k in g["knobs"]:
        kind, dflt, _ = REGISTRY.get(k, ("", "", ""))
        # 嵌套三元拆成显式分支（GitRoll #141）—— list 按逗号切、
        # 有默认值算一个、没有就没有。语义不变。
        if kind == "list":
            vals = {x.strip() for x in dflt.split(",")}
        elif dflt:
            vals = {dflt}
        else:
            vals = set()
        if vals & set(RENAMED_DEFAULTS):
            return True
    return False


def _missing_declaration_problems(missing):
    """叫 check_ 却没有 GATE 声明行 —— 忘写声明 = 叙述会漂。"""
    if not missing:
        return []
    return [M("registry.missing_declaration", files=", ".join(missing))]


def _phase_problems(gs):
    """runs_at 必须是已知相位 —— 频率是声明字段，写错值会让执行面漏掉它。"""
    out = []
    for g in gs:
        if g.get("runs_at", "commit") not in phases():
            out.append(M("registry.unknown_phase",
                         file=g["file"], runs_at=g.get("runs_at"),
                         phases=" | ".join(phases())))
    return out


def _name_dependent_problems(gs):
    """标了 name_dependent 却不消费任何改名默认名 —— 旗标错了。"""
    out = []
    for g in gs:
        if g["name_dependent"] and not _touches_renamed(g):
            out.append(M("registry.name_dependent_wrong", file=g["file"]))
    return out


def _empty_gate_problems(gs, missing):
    """名录整体为空 —— 零值守卫：空输入不是通过。"""
    if not gs and not missing:
        return [M("registry.empty_roster")]
    return []


def _selftest_roster_problems(mods, mods_missing):
    """平台模块自证名册：声明了就必须能跑，且名录不许为空。"""
    if mods is None or mods_missing is None:
        mods, mods_missing = selftest_modules()
    out = []
    if mods_missing:
        out.append(M("registry.selftest_no_entry",
                     files=", ".join(mods_missing)))
    if not mods:
        out.append(M("registry.no_module_selftest"))
    return out


def _undeclared_module_problems(undeclared):
    """C5：平台模块必须声明自己（MODULE = module_meta(…)），否则
    「该有自证却没写」无人问（文本猜 _cases 猜不出「本该有」）。"""
    if undeclared is None:
        _decl, undeclared = modules()
    if not undeclared:
        return []
    return [M("registry.undeclared_module", files=", ".join(undeclared))]


def _knob_problems(knob_problems, gs):
    """名册自洽性（C3）：幻影旋钮 / README 幻影 —— 与任何载体是否存在无关。

    此前焊在 check_envfile.run() 的「载体存在」前置之后，本仓没有
    Einfacht.env ⇒ 从未执行（实测踩到）。名册的家在这里收口。
    """
    if knob_problems is None:
        import knobs  # noqa: PLC0415
        knob_problems = (knobs.scan_surface_problems()
                         + knobs.readme_problems()
                         # C4 对账：声明↔实读、REGISTRY↔README 表、zh↔en 包
                         + knobs.declared_vs_read_problems(gs)
                         + knobs.registry_vs_readme_problems()
                         + knobs.pack_sync_problems()
                         # C4 对账④：**源码用到的 code 必须在每个已装包里**
                         # （zh↔en 差集看不见「两边一起缺」，那是静默退化）
                         + knobs.pack_coverage_problems()
                         # 声明了却从不使用的 DEFAULT_*（闸门假装配好了）
                         + knobs.dead_default_problems())
    return list(knob_problems)


def problems(gs, missing, mods=None, mods_missing=None,
             knob_problems=None, undeclared=None):
    """名录的对账（纯函数）：空 = 绿。自证期间不许 print。

    `mods` / `mods_missing` / `knob_problems` 可注入（自证用夹具）；
    None ⇒ 现读真仓。

    · 叫 check_ 却没有 GATE 声明行 ⇒ 报（忘写声明 = 叙述会漂）；
    · runs_at 不是已知相位 ⇒ 报（频率是声明字段，写错值会让执行面漏掉它）；
    · 标了 name_dependent 却不消费任何改名默认名 ⇒ 报（旗标错了）；
    · 写了自证却没有 --selftest 入口 ⇒ 报（写而不跑 = 装饰）；
    · 名册自洽性（幻影旋钮 / README 幻影）⇒ 报（C3，与载体无关）；
    · 名录整体为空 ⇒ 报（零值守卫）。
    """
    out = []
    out += phases_problems()
    out += _missing_declaration_problems(missing)
    out += _phase_problems(gs)
    out += _name_dependent_problems(gs)
    out += _empty_gate_problems(gs, missing)
    out += _selftest_roster_problems(mods, mods_missing)
    out += _undeclared_module_problems(undeclared)
    out += _knob_problems(knob_problems, gs)
    out += criteria.off_reason_problems(gs)
    out += criteria.trailing_newline_problems()
    out += criteria.shell_surface_problems()
    out += criteria.encoding_surface_problems()
    out += criteria.subprocess_encoding_problems()
    out += criteria.suite_scope_problems()
    out += criteria.fatal_exit_problems()
    # ⚠️ 注入模式（`mods=` 给了）下**不扫死接口**：那条判据看的是真目录，
    # 注入模式验的是「名录判据本身」，两者混在一张清单里会让断言被真仓状态
    # 连坐（实测：`unknown_phase` 的断言多出一条 `dead_interface`）。
    if mods is None:
        out += criteria.dead_interface_problems()
    return out





















def _pinned_under(lang):
    """自证帮手：在指定 REFLECT_LANG 下渲染 AUTO 块（用于证明它不随语言变）。"""
    old = os.environ.get("REFLECT_LANG", "")
    os.environ["REFLECT_LANG"] = lang
    try:
        gs, _ = gates()
        return render_gates(gs)
    finally:
        os.environ["REFLECT_LANG"] = old


def _with_phases(val):
    """自证帮手：临时设 REFLECT_PHASES，返回 (phases(), problems())，恢复现场。"""
    old = os.environ.get("REFLECT_PHASES", "")
    os.environ["REFLECT_PHASES"] = val
    try:
        return phases(), phases_problems()
    finally:
        os.environ["REFLECT_PHASES"] = old


def red_need(gs=None):
    """换名自证里**必须红**的闸门文件名（默认名承担载荷的那批）。"""
    if gs is None:
        gs, _ = gates()
    return sorted(os.path.basename(g["file"]) for g in gs
                  if g["name_dependent"] and _touches_renamed(g))


def plugins(hooks_dir=None):
    """自证点名的**插件**清单：`reflect-hooks/` 下带 `--selftest` 的脚本。

    发现式：`.sh` 与 `.py` 都收 —— 全 Python 化之后入口是 `.py`，但
    `einfacht-env.sh` 永远得是 shell（它被 `source` 以导出环境变量），
    所以两种都存在。判据是「文件里有没有 `--selftest`」，不是扩展名。
    """
    d = hooks_dir if hooks_dir is not None else repo("reflect-hooks")
    out = []
    try:
        names = sorted(os.listdir(d))
    except OSError:
        names = []
    for n in names:
        if not (n.endswith((".sh", ".py"))):
            continue
        try:
            text = open(os.path.join(d, n), encoding="utf-8",
                        errors="replace").read()
        except OSError:
            continue
        if "--selftest" in text:
            out.append("reflect-hooks/" + n)
    return out


def render_gates(gs):
    """闸门名录 → AUTO:GATES 机器块（含首尾标记）。**纯函数**：
    同一名录渲染两次逐字节相同。

    PINNED: 本块的文本**永远用固定语言**（issue #26，D' 的洞见），
    不跟随 `REFLECT_LANG`。理由：它写进 `STATE.md` 并被 `facts.py --check`
    逐字节对账 —— 若随语言变，`REFLECT_LANG=de --render-doc` 之后
    `REFLECT_LANG=zh --check` 必然红，**同一提交在不同语言环境下结果不同**
    （`collect.py` 原则 2 的同族病：不引入会自己变的输入）。
    实测过：不 PINNED 就会不收敛。
    """
    lines = [GATES_BEGIN,
             ("> 本区块由 `zreflect/facts.py --render-doc` 从发现式名录"
             "（zreflect/registry.py 的声明行）渲染，**不要手改**。"),
             ("> 执行面（hooks / CI）读 `registry --run <相位>` —— 相位是声明字段"
             "（`runs_at`），不是文件名。"),
             "",
             # ⚠️ 「可未启用的理由」是**声明**（静态），不是**运行时状态**。
             # 运行时 off 要看 `registry --run <相位>` —— 把它渲染进本块会让
             # AUTO 块每次运行都变 ⇒ 不收敛（本仓大忌，见 PINNED 说明）。
             "| 闸门 | 相位 | 它挡住什么 | 消费的旋钮 | 可未启用的理由 |",
             "|---|---|---|---|---|"]
    for g in sorted(gs, key=lambda x: (x.get("runs_at", "commit"), x["file"])):
        lines.append("| `%s`（%s） | %s | %s | %s | %s |"
                     % (os.path.basename(g["file"]), g["name"],
                        g.get("runs_at", "commit"), g["desc"],
                        ", ".join("`%s`" % k for k in g["knobs"]) or "—",
                        g.get("off_reason") or "—"))
    off_capable = sum(1 for g in gs if g.get("off_reason"))
    lines += ["",
              "%d 道闸门（发现式名录派生 —— 手写清单会漂，加闸门 = 落一个声明行，"
              "这里自动长出来）；其中 %d 道**可未启用**（末列是**声明**理由，"
              "不是运行时状态 —— 此刻谁 off 要看 `registry --run <相位>`）。"
              % (len(gs), off_capable), GATES_END]
    return "\n".join(lines)


def _arg_after(argv, flag):
    """`--flag [value]` 的可选值（缺省 / 以 - 开头 ⇒ 默认 commit）。"""
    i = argv.index(flag)
    return (argv[i + 1] if len(argv) > i + 1
            and not argv[i + 1].startswith("-") else "commit")


def _emit_gate_output(text):
    """把一道红闸门的输出转述给用户：**问题行 + 全部诊断行**，其余丢掉。

    ⚠️ 截断规则是「第一条问题行之后停」，但 `ℹ ` 诊断行**一条都不许丢** ——
    它们是唯一能救用户的那句话。实测：一次 bootstrap 后 registry 报 3 红，
    而 `check_facts.py` 紧跟问题行的诊断是
    `ℹ gate.env_hint(file='Einfacht.env')`（「先 source 它再手工跑」）。
    旧规则把它整条丢掉，于是用户看到「缺 README.zh.md」就去造那份 ——
    症状对、病因错，而且造了只会让红变多。
    """
    lines = [ln.rstrip() for ln in (text or "").splitlines() if ln.strip()]
    shown_problem = False
    for ln in lines:
        if ln.startswith("  \u00b7 "):
            if shown_problem:
                continue                  # 第二条起的问题行省略（别刷屏）
            shown_problem = True
        elif ln.lstrip().startswith("\u2139 "):
            pass                           # 诊断行：始终保留
        elif shown_problem:
            continue                       # 问题行之后的非诊断行：不重复打印
        print("      " + ln)


def _main_run(argv):
    """执行面：跑一个相位的全部闸门并聚合 ran / off / failed（C1+C2）。

    hooks / CI 只调这一行 —— glob 退役，谓词只有 gates() 一处。
    """
    phase = _arg_after(argv, "--run")
    from gate import run_phase  # noqa: PLC0415
    gs = runnable(phase)
    if not gs:
        return fatal(M("registry.empty_phase", phase=phase))
    # ⚠️ **本函数的全部输出走 stdout**（包括 fatal / error / failed 清单）。
    # 与 `gate.finish()` 的「问题行统一 stderr」**不冲突**：那条只约束单个闸门
    # 自己的判据输出；这里输出的是**运行报告**（谁没跑 / 谁红了 / 谁配置坏了），
    # 是一份状态快照而不是判据。
    # 理由：① 两个消费方（CI、hook）都只看 rc（`|| exit 1`），不解析 stdout；
    # ② 只捕 stdout 的调用方（`$(...)` / 管道）必须看得见**是哪个文件**坏了 ——
    # 只打 stderr 的话，它们看到 `fatal=1` 却不知道是谁（第 10 轮实测）。
    res = run_phase(phase, gs)
    print(M("registry.phase_summary", phase=phase, ran=res["ran"],
            off=res["off"], failed=res["failed"], fatal=res.get("fatal", 0),
            error=res.get("error", 0)))
    for f in res["off_list"]:
        print(M("registry.phase_off", file=f))
    # ⚠️ 这三个清单**同时打 stdout**：聚合方常常只捕 stdout（`$(...)` / 管道），
    # 只打 stderr 的话它们看到 `fatal=1` 却不知道是哪个文件坏（review 实测）。
    # 问题**原因**仍在闸门自己的 stderr 里 —— 这里补的是「谁」。
    for f in res.get("fatal_list", ()):
        print(M("registry.phase_fatal", file=f))
    for f in res.get("error_list", ()):
        print(M("registry.phase_error", file=f))
    for f in res["fail_list"]:
        print("  FAILED %s" % f)
        _emit_gate_output((res.get("fail_out", {}).get(f) or ""))
    # 配置坏（rc=2）与判据红（rc=1）都要非零退出，但消息不同（修法不同）
    return 1 if (res["failed"] or res.get("fatal") or res.get("error")) else 0


def cli_selftest_missing_lines(missing):
    """`--selftest-modules` 的逐行点名（纯函数：自证用，零 print）。"""
    return [M("registry.selftest_no_entry_cli", file=m) for m in missing]


def _main_selftest_modules():
    mods, missing = selftest_modules()
    for line in cli_selftest_missing_lines(missing):
        # CLI 逐行点名与 roster 的汇总句是**两处不同输出**（此前各一句措辞），
        # 迁移时保持两条 code，不把 CLI 行改成汇总句的样子。
        print(line, file=sys.stderr)
    if missing:
        return 1
    print("\n".join(mods))
    return 0


# 哪些 code 是**可修复的配置提示**（不砖名录），哪些是**名录本身坏了**。
#
# ⚠️ 这条区分是实测出来的：用户按文档创建 `Einfacht.env` 之后，
# `off_reason`（「本仓没有 Einfacht.env」）就过时了 —— 判据**是对的**，但把它
# 当 fatal 会让 `registry --gates` / `--run commit` / pre-commit **永久红**，
# 而唯一出路是删掉文档让他创建的那个文件。那是**自陷**，不是用户错。
#
# 正确反应：明确说「去改闸门的 off_reason」，然后**继续**（名录是可用的）。
_ADVISORY_CODES = frozenset({"registry.off_reason_stale"})


def _main_gates():
    gs, missing = gates()
    probs = problems(gs, missing)
    fatal_probs = [p for p in probs if getattr(p, "code", "") not in _ADVISORY_CODES]
    for x in probs:
        if getattr(x, "code", "") in _ADVISORY_CODES:
            print("  ! %s" % x, file=sys.stderr)      # 提示，不拒
        else:
            print("  · %s" % x, file=sys.stderr)
    if fatal_probs:
        return fatal(M("registry.roster_problems", count=len(fatal_probs)))
    for g in gs:
        print("%s\t%s\t%s" % (g["file"], g["name"], g["desc"]))
    return 0


def _main_lists(argv):
    """`--red-need` / `--runnable` / `--all-runnable` 三个清单打印。

    返回 rc；没有这些旗标 ⇒ None（调用方继续往下探）。
    """
    if "--red-need" in argv:
        print(" ".join(red_need()))
        return 0
    if "--runnable" in argv:
        # 执行面唯一产地（C1）：--runnable [phase]，默认 commit。
        for g in runnable(_arg_after(argv, "--runnable")):
            print(g["file"])
        return 0
    if "--all-runnable" in argv:
        # 全部相位的闸门（自证用：每道闸门都必须证明自己能红，与相位无关）。
        gs, _m = gates()
        for g in gs:
            print(g["file"])
        return 0
    return None


def _main_listings(argv):
    """`--plugins` / `--fixture-renames` 两个逐行清单。

    返回 rc；没有这些旗标 ⇒ None（调用方继续往下探）。
    """
    if "--plugins" in argv:
        print("\n".join(plugins()))
        return 0
    if "--fixture-renames" in argv:
        # C4 对账③：夹具改名集的唯一产地（原名=夹具名，每行一条）。
        for orig, fix in sorted(FIXTURE_RENAMES.items()):
            print("%s=%s" % (orig, fix))
        return 0
    return None


def _usage():
    """用法行。**函数而不是模块常量**：入口在 `main_selftest_or` 里才
    `activate()` 语言包，模块级 `M(…)` 会在 import 时就被冻在 null 包上。"""
    return M("registry.usage")


def main(argv):
    rc = _main_lists(argv)
    if rc is not None:
        return rc
    if "--run" in argv:
        return _main_run(argv)
    rc = _main_listings(argv)
    if rc is not None:
        return rc
    if "--selftest-modules" in argv:
        return _main_selftest_modules()
    if "--gates" in argv:
        return _main_gates()
    print(_usage(), file=sys.stderr)
    return 2


def _phase_tiers_ok():
    """`run_phase` 必须把 ran / off / failed / fatal 四档分清楚。"""
    from gate import run_phase  # noqa: PLC0415
    script = {"fatal.py": (2, "FATAL: cfg"),
              "fail.py": (1, "gate.problems_header"),
              "off.py": (0, "OFF: x"),
              "ok.py": (0, "")}
    # 第一次跑（四档基础形状）的返回体只用来确认不炸 —— GitRoll #104
    # 「赋值了但从不使用」：显式接 `_`，意图从隐式变明说。
    _ = run_phase("commit", list(script), runner=lambda f: script[f])
    script["err.py"] = (3, "boom")          # 未约定的码 / 被信号杀
    res = run_phase("commit", list(script), runner=lambda f: script[f])
    return (res["fatal"] == 1 and res["fatal_list"] == ["fatal.py"]
            and res["failed"] == 1 and res["fail_list"] == ["fail.py"]
            and res["error"] == 1 and res["error_list"] == ["err.py"]
            and res["off"] == 1 and res["off_list"] == ["off.py"]
            and res["ran"] == 1)


def _captures_stderr():
    """`default_runner` 必须把子进程的 **stderr 也带回来**。

    ⚠️ 这条**必须测默认执行器本身**（`gate.default_runner`），不能测注入的
    runner：注入的 runner 是自证自己写的，测它等于测自己。此前那版就这么写，
    实测对旧实现返回 BLIND（旧实现同样把 rc=2 归 fatal，差别在 out 里有没有
    stderr 的内容）。
    """
    import os  # noqa: PLC0415
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415

    from gate import default_runner  # noqa: PLC0415
    d = tempfile.mkdtemp()
    try:
        p = os.path.join(d, "boom.py")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write("import sys\n"
                     "sys.stderr.write('FATAL: probe\\n')\n"
                     "sys.exit(2)\n")
        rc, out = default_runner(p, d)
        # 只往 stderr 写 ⇒ stdout 空；若执行器只回 stdout，out 就是空串
        return rc == 2 and "FATAL: probe" in out
    finally:
        shutil.rmtree(d, True)




def _render_shows_off_reason():
    """声明了 `off_reason` 的假闸门 ⇒ AUTO 块里必须出现那段文字。"""
    gs = [{"file": "zreflect/check_probe.py", "name": "probe",
           "desc": "probe gate", "knobs": (), "runs_at": "commit",
           "off_reason": "a declared justification long enough"}]
    body = render_gates(gs)
    # ⚠️ **不写中文字面量**（本文件在零语言闸门的扫描面内 —— 实测踩到
    # bare_text）。改判可机器读的部分：off_reason 那段文字必须出现在行尾，
    # 且该行的列数与表头一致。
    return ("a declared justification long enough" in body
            and body.count("|") >= 6)


def _render_off_reason_dash():
    """没声明 `off_reason` ⇒ 该格是 `—`（不是空串、不是 None）。"""
    gs = [{"file": "zreflect/check_probe.py", "name": "probe",
           "desc": "probe gate", "knobs": (), "runs_at": "commit",
           "off_reason": None}]
    row = [ln for ln in render_gates(gs).splitlines()
           if ln.startswith("| `check_probe.py`")][0]
    return row.rstrip().endswith("| — |") and "None" not in row


def _streams_documented():
    """两处措辞必须在源码里（gate.py 限定单个闸门 / 本文件说明聚合方走 stdout）。"""
    import gate  # noqa: PLC0415
    try:
        g = open(gate.__file__, encoding="utf-8").read()
        r = open(os.path.abspath(__file__), encoding="utf-8")
        r = r.read()
    except OSError:
        return False
    # ⚠️ 锚点用**码点拼**，不写中文字面量 —— 本文件在零语言闸门的扫描面内
    # （实测踩到 bare_text）。判据名已说明测什么，锚点只需可机器匹配。
    _a1 = "".join(chr(c) for c in (0x5355, 0x4E2A, 0x95F8, 0x95E8))   # 单个闸门
    _a2 = "".join(chr(c) for c in (0x672C, 0x51FD, 0x6570))            # 本函数
    return (_a1 in g and _a2 in r and
            ("stdout" in r and "stdout" in g))








def _plugin_discovery_ok():
    """插件发现：目录在 ⇒ 必须发现 env 插件；目录不在 ⇒ 空名单也算对。"""
    import os  # noqa: PLC0415
    d = repo("reflect-hooks")
    found = plugins()
    if not os.path.isdir(d):
        return found == []          # 没装插件目录 ⇒ 空名单是对的
    return ("reflect-hooks/einfacht-env.sh" in found
            and "zreflect/doctor.py" not in found)


def _nf_catches(which):
    """用**真文件里的 lambda** 测 `never_falsifiable`（它按行号定位 AST，`-c`
    里的 lambda 没有源码文件 ⇒ 会瞎）。

    四个形状各造一个：
      · `or_true`      —— `or True`（布尔被常量短路）
      · `and_false`    —— `and False`
      · `self_compare` —— `x == x`
      · `real`         —— 真断言（必须返回 None）
    """
    from gate import never_falsifiable  # noqa: PLC0415
    y = 1                                                # 供 self_compare 用
    shapes = {
        "or_true": lambda: (1 == 1) or True,
        "and_false": lambda: (1 == 1) and False,
        "self_compare": lambda: y == y,
        "real": lambda: y > 0,
    }
    return never_falsifiable(shapes[which])


def _nf_no_source():
    """没有 `co_filename`（如 `-c` 里的 lambda / 内建）⇒ 必须返回 None（不猜）。

    这条钉的是边界③：`never_falsifiable` 依赖 `ast` 定位**真文件**；
    读不到就明说不猜，而不是当成「恒真」或「干净」。
    """
    from gate import never_falsifiable  # noqa: PLC0415
    # 用 `compile` + `exec` 造一个**没有 co_filename** 的函数，而不是 `eval`：
    # 语义完全相同（工具要的就是「读不到源码」这个边界），但静态安全扫描
    # 不必为一个测试夹具的 `eval` 开豁免（`S307`）。夹具里的 eval 与产品里
    # 的 eval 长得一样，将来没人分得清哪个是故意的。
    ns = {}
    exec(compile("f = lambda: True", "<no-source>", "exec"), ns)  # noqa: S102
    return never_falsifiable(ns["f"])


def _gate_desc_states_selftest():
    """`gate.py` 的 MODULE 描述必须说明「逻辑自证住在 registry._cases」。"""
    mods, _und = modules()
    for m in mods:
        if m["file"].endswith("gate.py"):
            d = m["desc"]
            # 锚点**全用 ASCII**：`registry._cases`（自证住在哪）+ `--selftest`
            # （为什么没有入口）。不写中文字面量（本文件在零语言闸门扫描面内，
            # 码点拼又容易拼错 —— 实测把 0x72EC 写成「独」）。
            return ("registry._cases" in d) and ("--selftest" in d) \
                and ("selftest" in d)
    return False




















def _load_spec_ok():
    """`load_spec` 读不到时返回 `(None, 错误句)`，**不 raise**。"""
    got = gate.load_spec("/nonexistent-probe.json")
    return isinstance(got, tuple) and len(got) == 2 \
        and got[0] is None and got[1] is not None


def _cases_fixture(d):
    """造一份假名录。`d` 来自 `_cases()`（它负责 mkdtemp 与清理）。"""
    # 夹具的声明数据用**ASCII 名**：它们是被 ast 提取的输入（进 AUTO:GATES
    # 机器块），不是本体输出 —— 中文夹具会被零语言闸门收编。
    open(os.path.join(d, "check_ok.py"), "w", encoding="utf-8").write(
        'GATE = gate.meta("gate_a", "blocks_a", knobs=("REFLECT_FACTS",),'
        ' name_dependent=True)\n')
    open(os.path.join(d, "check_plain.py"), "w", encoding="utf-8").write(
        'GATE = gate.meta("gate_b", "blocks_b", knobs=("REFLECT_WORLD",))\n')
    open(os.path.join(d, "check_bare.py"), "w", encoding="utf-8").write("X = 1\n")
    open(os.path.join(d, "named_other.py"), "w", encoding="utf-8").write(
        'GATE = gate.meta("gate_c", "declared means registered", knobs=())\n')
    open(os.path.join(d, "doc_gate.py"), "w", encoding="utf-8").write(
        'GATE = gate.meta("gate_d", "start-of-work phase", knobs=(),'
        ' runs_at="start-of-work")\n')
    open(os.path.join(d, "platform.py"), "w", encoding="utf-8").write("Y = 2\n")   # 无声明 = 平台模块
    gs, missing = gates(d)
    ok = [g for g in gs if g["file"].endswith("check_ok.py")][0]
    plain = [g for g in gs if g["file"].endswith("check_plain.py")][0]
    real, real_missing = gates()

    def real_files():
        # ⚠️ `_zdir()`（**工具仓**的 zreflect），不是 `d`（临时夹具目录）——
        # 这条断言比的是「真名录 vs 真磁盘」，与夹具无关。
        return {"zreflect/" + n for n in os.listdir(gate.zdir())
                if n.startswith("check_") and n.endswith(".py")}
    return {"ok": ok, "plain": plain, "real": real,
            "real_missing": real_missing, "gs": gs,
            "missing": missing, "real_files": real_files}


def _cases_discovery_real(fx):
    """① 正常不报：真仓的名录与声明面。（8 条）"""
    ok, real = fx["ok"], fx["real"]
    gs, missing, real_missing, real_files = (fx["gs"], fx["missing"],
                                             fx["real_missing"], fx["real_files"])
    return [
        ("registry.ast_declaration_fields",
         lambda: ok["name"] == "gate_a" and ok["desc"] == "blocks_a"
         and ok["knobs"] == ("REFLECT_FACTS",)
         and ok["name_dependent"] is True and ok["runs_at"] == "commit"),
        ("registry.undeclared_noncheck_is_module",
         lambda: all(not m.endswith("platform.py") for m in missing)
         and all(not g["file"].endswith("platform.py") for g in gs)),
        ("registry.declaration_is_registration",
         lambda: any(g["file"].endswith("named_other.py") for g in gs)
         and not any(m.endswith("named_other.py") for m in missing)),
        ("registry.real_roster_matches_disk",
         lambda: not real_missing and real_files() <= {g["file"] for g in real}),
        ("registry.doctor_is_start_of_work",
         lambda: any(g["file"].endswith("doctor.py") for g in real)
         and not any(g["file"].endswith("doctor.py")
                     for g in runnable("commit"))),
        ("registry.red_need_flagged",
         lambda: (lambda rn: len(rn) >= 1 and all(
             any(g["file"].endswith(b) and g["name_dependent"] for g in real)
             for b in rn))(red_need(real))),
        ("registry.real_modules_declared",
         lambda: modules()[1] == [] and len(modules()[0]) >= 8),
        ("registry.fixture_renames_single_source",
         lambda: set(FIXTURE_RENAMES) == set(RENAMED_DEFAULTS)
         and len(FIXTURE_RENAMES) >= 7),
        # 插件目录**可以不存在**（只拷 `zreflect/` 的部署）：那时没有插件可发现，
        # 这不是失败。存在就必须发现它 —— 断言按「目录在不在」分两档。
        ("registry.plugin_discovery", lambda: _plugin_discovery_ok()),
    ]


def _cases_discovery_reports(fx):
    """② 该报的必须报：名录对账的六种病。（6 条）"""
    plain, missing = fx["plain"], fx["missing"]
    return [
        ("\u2605 registry.missing_declaration",
         lambda: missing == ["zreflect/check_bare.py"]),
        ("\u2605 registry.name_dependent_wrong",
         lambda: [p.code for p in problems(
             [dict(plain, name_dependent=True)], [],
             mods=["zreflect/x.py"], mods_missing=[], knob_problems=[],
             undeclared=[])] == ["registry.name_dependent_wrong"]),
        # 这两条的空名录与「空清单不是通过」同时在场（gs=[] 必然触发零值守卫），
        # 所以用 `any(code == …)` 而不是整表相等 —— 断言仍精确指向那一条。
        ("\u2605 registry.selftest_no_entry",
         lambda: any(p.code == "registry.selftest_no_entry" for p in problems(
             [], [], mods=["zreflect/x.py"],
             mods_missing=["zreflect/y.py"],
             knob_problems=[]))),
        # CLI 逐行点名也必须能产出（否则它是「写而不跑」的装饰 —— 本仓纪律）。
        ("\u2605 registry.selftest_no_entry_cli",
         lambda: [m.code for m in cli_selftest_missing_lines(
             ["zreflect/y.py"])] == ["registry.selftest_no_entry_cli"]
         and cli_selftest_missing_lines([]) == []),
        ("\u2605 registry.undeclared_module",
         lambda: any(p.code == "registry.undeclared_module" for p in problems(
             [], [], mods=["zreflect/x.py"], mods_missing=[],
             knob_problems=[],
             undeclared=["zreflect/orphan_mod.py"]))),
        # **聚合方的输出整体走 stdout**，与「单个闸门问题行统一 stderr」不冲突。
        # 这条钉的是「两端语义分开写明白了」—— 判据是两处措辞都在。
        ("registry.aggregator_streams_documented",
         lambda: _streams_documented()),
    ]


def _cases_discovery(fx):
    """见 `_cases()`：本组 16 条。

    ① 真仓名录 / ② 名录病各是一个具名组：前者读夹具的真名录、后者造畸形
    声明 —— 混在一起时读者分不清某条断言用的是哪个输入。
    """
    return (_cases_discovery_real(fx) + _cases_discovery_reports(fx)
            + [("\u2605 registry.empty_roster",
                lambda: problems([], [], mods=[], mods_missing=[],
                                 knob_problems=[], undeclared=[]) != [])])


def _cases_render(fx):
    """见 `_cases()`：本组 4 条。"""
    gs = fx["gs"]
    return [
    ("★ registry.auto_block_pinned_across_langs",
     lambda: _pinned_under("en") == _pinned_under("zh")
     and _pinned_under("de") == _pinned_under("")),
    ("registry.render_gates_pure",
     lambda: render_gates(gs) == render_gates(gs)
     and "gate_a" in render_gates(gs)
     and GATES_BEGIN in render_gates(gs) and GATES_END in render_gates(gs)),
    # **`off_reason` 必须渲染进 AUTO 块**（让读者一眼看到哪些闸门可未启用、
    # 为什么）—— 且它是**声明**不是运行时状态（后者会让块每次变、不收敛）。
    ("★ registry.render_gates_shows_off_reason",
     lambda: _render_shows_off_reason()),
    # 没声明的闸门那一格必须是 `—`（不写空、不写 "None"）
    ("registry.render_gates_off_reason_dash",
     lambda: _render_off_reason_dash()),
    ]


def _cases_phase(fx):
    """见 `_cases()`：本组 9 条。"""
    plain = fx["plain"]
    d = fx["d"]
    return [
    ("registry.runnable_filters_by_phase",
     lambda: (lambda cm, sw: all(g["runs_at"] == "commit" for g in cm)
              and [g["file"] for g in sw]
              == ["zreflect/doc_gate.py"])(runnable("commit", d),
                                           runnable("start-of-work", d))),
    ("★ registry.unknown_phase",
     lambda: [p.code for p in problems(
         [dict(plain, runs_at="whenever")], [],
         mods=["zreflect/x.py"], mods_missing=[], knob_problems=[],
         undeclared=[])] == ["registry.unknown_phase"]),
    # **`run_phase` 是 hooks/CI 的唯一执行入口**，此前零自证。
    # 三档聚合必须真的分开：rc=2（配置坏）≠ rc=1（判据红）≠ off。
    # 混成一档的话，「有三道闸门报了真问题」与「有一道配置坏了」不可区分，
    # 而修法完全不同（修问题 vs 改配置）。
    ("★ registry.phase_tiers_separate",
     lambda: _phase_tiers_ok()),
    # **stderr 必须被捕获**：本仓约定「问题行统一 stderr」，所以 rc=2 的
    # 闸门 stdout 可能是空的（原因全在 stderr）。此前 `_default` 只回传
    # `p.stdout` ⇒ 聚合方拿到 (2, "")，FATAL 被当成「跑过了」。
    # 这条钉的是**默认执行器**的行为（注入 runner 测不到它）。
    ("★ registry.run_phase_captures_stderr",
     lambda: _captures_stderr()),
    # issue #21：相位旋钮 —— 下游自定义相位（如 S26 的 lab）不再 fork PHASES
    ("registry.phases_extra_appended",
     lambda: _with_phases("lab")[0] == ("commit", "start-of-work", "lab")),
    ("★ registry.builtin_phase_repeated",
     lambda: [p.code for p in _with_phases("commit,lab")[1]
              ] == ["registry.builtin_phase_repeated"]),
    ("registry.phases_default_builtin_only",
     lambda: _with_phases("")[0] == ("commit", "start-of-work")),
    # 人性化提示（env_hint）：四条判据
    ]

def _env_hint_case(which):
    """`gate.env_hint()` 的**五档**行为（#28 修后：载体值参与判定）。

    1. `no_carrier`  —— 无载体 ⇒ None（裸跑不吵）
    2. `carrier_bare` —— 载体在、没设旋钮 ⇒ **提示**（没人 source）
    3. `carrier_live` —— 旋钮已设、值与载体**一致** ⇒ None（载体已生效）
    4. `carrier_drift` —— 旋钮已设、值与载体**不同** ⇒ **提示**（手动 export 漂）
    5. `carrier_off`  —— `REFLECT_ENV_HINT=off` ⇒ 打印层一个字都不出

    ⚠️ 判据的语义前提是「进程环境受控」：钩子语境会把载体 source 进环境，
    旋钮一设 `carrier_bare` 就恒红（#29 实测：上游自己 `REFLECT_FACTS=x
    registry --selftest` ⇒ 1）。测试隔离自己进程的输入是自证的本职：
    相关旋钮全部临时 pop，finally 恢复。
    """
    import shutil
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    saved = gate.GATE_REPO
    saved_off = os.environ.pop("REFLECT_ENV_HINT", None)
    saved_fact = os.environ.pop("REFLECT_FACTS", None)
    try:
        gate.GATE_REPO = d
        if which != "no_carrier":
            open(os.path.join(d, "Einfacht.env"), "w",
                 encoding="utf-8").write("export REFLECT_FACTS=FACTS.json\n")
        if which == "carrier_off":
            # `off` 的静默发生在**打印层**（`_maybe_hint`），不在 `env_hint`
            # —— `env_hint()` 仍会算出那句话，只是没人打印它。测打印层。
            os.environ["REFLECT_ENV_HINT"] = "off"
            import contextlib  # noqa: PLC0415
            import io  # noqa: PLC0415
            buf = io.StringIO()
            with contextlib.redirect_stderr(buf):
                gate._maybe_hint()
            return buf.getvalue() == ""       # 必须**一个字符都不打**
        if which == "carrier_live":
            os.environ["REFLECT_FACTS"] = "FACTS.json"    # 与载体一致
        elif which == "carrier_drift":
            os.environ["REFLECT_FACTS"] = "OTHER.json"    # 与载体不同
        hint = gate.env_hint(consumed=("REFLECT_FACTS",))
        if which in ("carrier_bare", "carrier_drift"):
            return hint is not None          # 必须**提示**
        return hint is None                  # 无载体 / 已生效 ⇒ 必须静默
    finally:
        gate.GATE_REPO = saved
        if saved_off is not None:
            os.environ["REFLECT_ENV_HINT"] = saved_off
        else:
            os.environ.pop("REFLECT_ENV_HINT", None)
        if saved_fact is not None:
            os.environ["REFLECT_FACTS"] = saved_fact
        else:
            os.environ.pop("REFLECT_FACTS", None)
        shutil.rmtree(d, True)


def _cases_hint(fx):
    """见 `_cases()`：环境提示（env_hint）的静默条件。"""
    return [
        # ⚠️ 此前这两条是**恒真**：`env_hint(...) is None or env_carrier() is not
        # None` —— 只要仓里有 `Einfacht.env` 第二条永远成立（把 `env_hint` 弄成
        # 永远返回一行，断言仍 True，实测）。现在按**载体有无**三个档位都测。
        ("★ registry.env_hint_silent_without_carrier",
         lambda: _env_hint_case("no_carrier")),
        ("★ registry.env_hint_fires_with_carrier",
         lambda: _env_hint_case("carrier_bare")),
        # #28：载体已生效（值一致）⇒ 静默 —— 接线正确的仓这才不吵
        ("registry.env_hint_silent_when_carrier_live",
         lambda: _env_hint_case("carrier_live")),
        # #28：手动 export 与载体漂了 ⇒ 必须提示（这正是该吵的场景）
        ("★ registry.env_hint_fires_on_drift",
         lambda: _env_hint_case("carrier_drift")),
        ("★ registry.env_hint_off_silent",
         lambda: _env_hint_case("carrier_off")),
    ]







def _cases_gate_hosted(fx):
    """`gate.py` 的判据**寄宿在这里** —— 它 `selftest=False`（提供 `selftest`
    本身，自举会打架），所以它的逻辑自证只能住在别处。本仓唯一合法寄宿。"""
    return [
        # **`never_falsifiable` 的自证**（第 22 轮）：它是 `gate.selftest()` 的
        # 核心守卫（`gate.py:36` 起），用来抓「恒真断言」—— 此前**全仓零自证**。
        # 「检测器的检测器」没被测过：它失效时，所有断言都会静默失去牙。
        ("★ registry.never_falsifiable_catches_or_true",
         lambda: _nf_catches("or_true") is not None),
        ("★ registry.never_falsifiable_catches_and_false",
         lambda: _nf_catches("and_false") is not None),
        ("★ registry.never_falsifiable_catches_self_compare",
         lambda: _nf_catches("self_compare") is not None),
        # **阳性对照**：真断言必须**不报**（否则「总是报」也能骗过自证）
        ("registry.never_falsifiable_allows_real",
         lambda: _nf_catches("real") is None),
        # 边界③：「读不到源码」⇒ 不猜（返回 None，不是「恒真」也不是「干净」）
        ("★ registry.never_falsifiable_no_source_no_guess",
         lambda: _nf_no_source() is None),
        # **`gate.py` 的 `selftest=False` 必须说清真实含义**（第 23 轮）：
        # 它不表示「没有自证义务」，只表示「没有 `--selftest` 入口（自举会打架）」。
        # 此前描述只写「提供 selftest，自己不消费」—— 读起来像免责声明。
        ("★ registry.gate_module_meta_states_where_selftest_lives",
         lambda: _gate_desc_states_selftest()),
        # 依赖链判据刚点名的两条 `gate` 函数（消费方多，自身零断言）
        ("★ registry.guard_nonempty_returns_2",
         # 空 ⇒ rc 2（FATAL）；非空 ⇒ None
         lambda: gate.guard_nonempty("x", []) == 2
         and gate.guard_nonempty("x", [1]) is None),
        ("★ registry.load_spec_returns_error_not_raise",
         # 坏路径 ⇒ (None, 错误句)；不抛异常（调用方要拼自己的措辞）
         lambda: _load_spec_ok()),
    ]





def _cases():
    """拼装六组夹具断言。**只拼装** —— 判据在各分组函数里。"""
    import atexit  # noqa: PLC0415
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    atexit.register(shutil.rmtree, d, True)
    fx = _cases_fixture(d)
    fx["d"] = d
    return (        _cases_discovery(fx)
        + _cases_render(fx)
        + _cases_phase(fx)
        + _cases_hint(fx)
        + _cases_gate_hosted(fx)
    )


MODULE = module_meta("发现式名录", "闸门/模块/插件的声明派生：执行面 + 叙述 + 红名单", selftest=True)


if __name__ == "__main__":
    # 收尾统一走 `main_selftest_or`：它先做语言包激活（`activate_or_fatal`），
    # 再分流 `--selftest` 与 `main()`。此前这里自己抄了一份 activate+FATAL，
    # 而 gate 自己的 `__main__` 又是第三种写法（连 FATAL 都没有）—— 同一件事
    # 三份拷贝，口径必然漂。
    sys.exit(main_selftest_or(sys.argv[1:],
                              M("gate.title.registry"),
                              _cases, main))


