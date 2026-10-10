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
from gate import module_meta, fatal, repo, selftest                    # noqa: E402
from knobs import REGISTRY                                # noqa: E402

GATES_BEGIN = "<!-- AUTO:GATES -->"
GATES_END = "<!-- /AUTO:GATES -->"


def _zdir():
    """闸门名录所在的目录 = **本文件所在处**，与 GATE_REPO 无关。

    名录是**工具**的属性（`zreflect/` 里的 check_*.py 就是工具自带的那批），
    不是**被检查仓库**的属性：GATE_REPO 指向「被检查的仓库」（可能是换名
    夹具、别的仓库），那里根本没有 zreflect/ 目录 —— 用 repo("zreflect")
    会让夹具里名录为空、render 拒绝（实测踩到：换名自证的夹具里
    check_facts 因「名录空」而红）。"""
    return os.path.dirname(os.path.abspath(__file__))

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
PHASES = ("commit", "start-of-work")

def modules(zdir=None):
    """平台模块名录（C5）：ast 解析 `MODULE = module_meta(…)` 声明行。

    返回 (declared, undeclared)：`declared` = [{file, name, desc, selftest}]；
    `undeclared` = **非闸门、非 __init__ 却没有 MODULE 声明**的 .py ——
    平台模块必须声明自己（哪怕是 selftest=False，也要正面说「我不用自证」），
    否则「该有自证却没写」无人问（文本猜 `_cases` 猜不出来「本该有」）。
    """
    d = zdir if zdir is not None else _zdir()
    declared, undeclared = [], []
    try:
        names = sorted(os.listdir(d))
    except OSError:
        return [], []
    for n in names:
        if not n.endswith(".py") or n == "__init__.py":
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
    d = zdir if zdir is not None else _zdir()
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


def _has_cases(tree):
    """模块里**写**了自证用例（`_cases` 或 `CASES` 赋值/定义）。

    只认这两个名字：`selftest` 不算 —— gate.py 自己**定义** selftest（平台
    函数），拿它当判据会把平台本身误收进名录（实测踩到：gate.py 被当模块
    自证跑，却没有用例清单、也不该有）。
    """
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name) and t.id in ("_cases", "CASES"):
                    return True
        if isinstance(node, ast.FunctionDef) and node.name == "_cases":
            return True
    return False


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
    d = zdir if zdir is not None else _zdir()
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
        if (isinstance(node, ast.Assign) and len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name)
                and node.targets[0].id == attr
                and isinstance(node.value, ast.Call)
                and len(node.value.args) >= 2):
            fn = node.value.func
            # 两种等价写法都认：meta(…)（裸导入名）与 gate.meta(…)（属性）
            if not (getattr(fn, "id", "") == func
                    or getattr(fn, "attr", "") == func):
                continue
            try:
                if func == "module_meta":
                    st = True
                    for kw in node.value.keywords:
                        if kw.arg == "selftest":
                            st = ast.literal_eval(kw.value)
                    return {"file": rel,
                            "name": ast.literal_eval(node.value.args[0]),
                            "desc": ast.literal_eval(node.value.args[1]),
                            "selftest": bool(st)}
                knobs, name_dep, runs_at = (), False, "commit"
                for kw in node.value.keywords:
                    if kw.arg == "knobs":
                        knobs = ast.literal_eval(kw.value)
                    elif kw.arg == "name_dependent":
                        name_dep = ast.literal_eval(kw.value)
                    elif kw.arg == "runs_at":
                        runs_at = ast.literal_eval(kw.value)
                return {"file": rel,
                        "name": ast.literal_eval(node.value.args[0]),
                        "desc": ast.literal_eval(node.value.args[1]),
                        "knobs": tuple(knobs),
                        "name_dependent": bool(name_dep),
                        "runs_at": str(runs_at)}
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
        vals = ({x.strip() for x in dflt.split(",")} if kind == "list"
                else {dflt} if dflt else set())
        if vals & set(RENAMED_DEFAULTS):
            return True
    return False


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
    if missing:
        out.append("以下闸门没有 GATE = gate.meta(…) 声明行 —— 名录不收"
                   "无名之辈（手写名录会漂，声明即登记）：%s"
                   % ", ".join(missing))
    for g in gs:
        if g.get("runs_at", "commit") not in PHASES:
            out.append("`%s` 的 runs_at=%r 不是已知相位（%s）—— 频率是声明"
                       "字段，写错值会让执行面漏掉它"
                       % (g["file"], g.get("runs_at"), " | ".join(PHASES)))
    for g in gs:
        if g["name_dependent"] and not _touches_renamed(g):
            out.append("`%s` 标了 name_dependent，但消费的旋钮没有一个默认名"
                       "在换名自证的改名清单里 —— 旗标错了（要么去掉旗标，"
                       "要么把新默认名加进 registry.RENAMED_DEFAULTS）"
                       % g["file"])
    if not gs and not missing:
        out.append("一个闸门都没发现 —— 零值守卫：空输入不是通过")
    if mods is None or mods_missing is None:
        mods, mods_missing = selftest_modules()
    if mods_missing:
        out.append("以下模块声明了 selftest=True 却没有 --selftest 入口 —— "
                   "写而不跑的自证 = 装饰：%s" % ", ".join(mods_missing))
    if not mods:
        out.append("没有任何平台模块自证可发现 —— 零值守卫：空输入不是通过")
    # C5：平台模块必须声明自己（MODULE = module_meta(…)），否则
    # 「该有自证却没写」无人问（文本猜 _cases 猜不出「本该有」）。
    if undeclared is None:
        _decl, undeclared = modules()
    if undeclared:
        out.append("以下 .py 既非闸门（无 GATE 声明）也非已声明的平台模块"
                   "（无 MODULE = module_meta(…)）—— 平台模块必须声明自己，"
                   "哪怕 selftest=False（正面说「我不用自证」）：%s"
                   % ", ".join(undeclared))
    # 名册自洽性（C3）：幻影旋钮 / README 幻影 —— 与任何载体是否存在无关。
    # 此前焊在 check_envfile.run() 的「载体存在」前置之后，本仓没有
    # Einfacht.env ⇒ 从未执行（实测踩到）。名册的家在这里收口。
    if knob_problems is None:
        import knobs                                     # noqa: PLC0415
        knob_problems = (knobs.scan_surface_problems()
                         + knobs.readme_problems()
                         # C4 对账：声明↔实读、REGISTRY↔README 表
                         + knobs.declared_vs_read_problems(gs)
                         + knobs.registry_vs_readme_problems())
    out += list(knob_problems)
    return out


def red_need(gs=None):
    """换名自证里**必须红**的闸门文件名（默认名承担载荷的那批）。"""
    if gs is None:
        gs, _ = gates()
    return sorted(os.path.basename(g["file"]) for g in gs
                  if g["name_dependent"] and _touches_renamed(g))


def plugins(hooks_dir=None):
    """自证点名的**插件**清单：reflect-hooks/*.sh 带自证标记的（发现式收编）。

    doctor 不再是「点名特殊件」—— C1 起它是正常声明的闸门
    （`runs_at="start-of-work"`），由 gates()/runnable() 收编，不再需要
    旁路点名（此前它靠 SPECIAL_PLUGINS 手写一行，是「名字承重」时代的产物）。
    """
    d = hooks_dir if hooks_dir is not None else repo("reflect-hooks")
    out = []
    try:
        names = sorted(os.listdir(d))
    except OSError:
        names = []
    for n in names:
        if not n.endswith(".sh"):
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
    同一名录渲染两次逐字节相同。"""
    lines = [GATES_BEGIN,
             "> 本区块由 `zreflect/facts.py --render-doc` 从发现式名录"
             "（zreflect/registry.py 的声明行）渲染，**不要手改**。",
             "> 执行面（hooks / CI）读 `registry --run <相位>` —— 相位是声明字段"
             "（`runs_at`），不是文件名。",
             "",
             "| 闸门 | 相位 | 它挡住什么 | 消费的旋钮 |", "|---|---|---|---|"]
    for g in sorted(gs, key=lambda x: (x.get("runs_at", "commit"), x["file"])):
        lines.append("| `%s`（%s） | %s | %s | %s |"
                     % (os.path.basename(g["file"]), g["name"],
                        g.get("runs_at", "commit"), g["desc"],
                        ", ".join("`%s`" % k for k in g["knobs"]) or "—"))
    lines += ["", "%d 道闸门（发现式名录派生 —— 手写清单会漂，加闸门 = "
              "落一个声明行，这里自动长出来）。" % len(gs), GATES_END]
    return "\n".join(lines)


def main(argv):
    if "--red-need" in argv:
        print(" ".join(red_need()))
        return 0
    if "--runnable" in argv:
        # 执行面唯一产地（C1）：--runnable [phase]，默认 commit。
        i = argv.index("--runnable")
        phase = (argv[i + 1] if len(argv) > i + 1
                 and not argv[i + 1].startswith("-") else "commit")
        for g in runnable(phase):
            print(g["file"])
        return 0
    if "--all-runnable" in argv:
        # 全部相位的闸门（自证用：每道闸门都必须证明自己能红，与相位无关）。
        gs, _m = gates()
        for g in gs:
            print(g["file"])
        return 0
    if "--run" in argv:
        # 执行面：跑一个相位的全部闸门并聚合 ran / off / failed（C1+C2）。
        # hooks / CI 只调这一行 —— glob 退役，谓词只有 gates() 一处。
        i = argv.index("--run")
        phase = (argv[i + 1] if len(argv) > i + 1
                 and not argv[i + 1].startswith("-") else "commit")
        from gate import run_phase                          # noqa: PLC0415
        gs = runnable(phase)
        if not gs:
            return fatal("相位 %s 没有可跑的闸门 —— 零值守卫：空清单不是通过"
                         "（谓词或声明坏了？）" % phase)
        res = run_phase(phase, gs)
        print("相位 %s：ran %d / off %d / failed %d"
              % (phase, res["ran"], res["off"], res["failed"]))
        for f in res["off_list"]:
            print("  off    %s（未启用 —— 没查，不是通过）" % f)
        for f in res["fail_list"]:
            print("  FAILED %s" % f, file=sys.stderr)
        return 1 if res["failed"] else 0
    if "--plugins" in argv:
        print("\n".join(plugins()))
        return 0
    if "--fixture-renames" in argv:
        # C4 对账③：夹具改名集的唯一产地（原名=夹具名，每行一条）。
        for orig, fix in sorted(FIXTURE_RENAMES.items()):
            print("%s=%s" % (orig, fix))
        return 0
    if "--selftest-modules" in argv:
        mods, missing = selftest_modules()
        for m in missing:
            print("  ❌ %s 写了自证却没有 --selftest 入口（写而不跑 = 装饰）" % m,
                  file=sys.stderr)
        if missing:
            return 1
        print("\n".join(mods))
        return 0
    if "--gates" in argv:
        gs, missing = gates()
        probs = problems(gs, missing)
        for x in probs:
            print("  · %s" % x, file=sys.stderr)
        if probs:
            return fatal("名录有问题（%d）" % len(probs))
        for g in gs:
            print("%s\t%s\t%s" % (g["file"], g["name"], g["desc"]))
        return 0
    print("用法：registry.py [--gates|--runnable [phase]|--all-runnable|--run [phase]|"
          "--red-need|--plugins|--selftest-modules|--selftest]", file=sys.stderr)
    return 2


def _cases():
    import atexit                                        # noqa: PLC0415
    import shutil                                        # noqa: PLC0415
    import tempfile                                      # noqa: PLC0415
    d = tempfile.mkdtemp()
    atexit.register(shutil.rmtree, d, True)
    open(os.path.join(d, "check_ok.py"), "w").write(
        'GATE = gate.meta("甲闸门", "挡甲", knobs=("REFLECT_FACTS",),'
        ' name_dependent=True)\n')
    open(os.path.join(d, "check_plain.py"), "w").write(
        'GATE = gate.meta("乙闸门", "挡乙", knobs=("REFLECT_WORLD",))\n')
    open(os.path.join(d, "check_bare.py"), "w").write("X = 1\n")
    open(os.path.join(d, "named_other.py"), "w").write(
        'GATE = gate.meta("丙", "声明即闸门，名字无关", knobs=())\n')
    open(os.path.join(d, "doc_gate.py"), "w").write(
        'GATE = gate.meta("丁", "开工相位", knobs=(), runs_at="start-of-work")\n')
    open(os.path.join(d, "platform.py"), "w").write("Y = 2\n")   # 无声明 = 平台模块
    gs, missing = gates(d)
    ok = [g for g in gs if g["file"].endswith("check_ok.py")][0]
    plain = [g for g in gs if g["file"].endswith("check_plain.py")][0]
    real, real_missing = gates()

    def real_files():
        return {"zreflect/" + n for n in os.listdir(_zdir())
                if n.startswith("check_") and n.endswith(".py")}
    return [
        # ① 正常不报
        ("ast 提取声明行：名字 / 一句话 / 旋钮 / 旗标 / 相位",
         lambda: ok["name"] == "甲闸门" and ok["desc"] == "挡甲"
         and ok["knobs"] == ("REFLECT_FACTS",)
         and ok["name_dependent"] is True and ok["runs_at"] == "commit"),
        ("无声明且非 check_ ⇒ 平台模块，既不入名录也不入 missing",
         lambda: all(not m.endswith("platform.py") for m in missing)
         and all(not g["file"].endswith("platform.py") for g in gs)),
        ("声明即闸门：非 check_ 命名但有声明 ⇒ 被发现（孤儿概念消失）",
         lambda: any(g["file"].endswith("named_other.py") for g in gs)
         and not any(m.endswith("named_other.py") for m in missing)),
        ("真仓名录与磁盘一致：每个 check_*.py 都在名录里",
         lambda: not real_missing and real_files() <= {g["file"] for g in real}),
        ("runnable 按相位过滤：commit 不含 start-of-work 的闸门",
         lambda: (lambda cm, sw: all(g["runs_at"] == "commit" for g in cm)
                  and [g["file"] for g in sw]
                  == ["zreflect/doc_gate.py"])(runnable("commit", d),
                                               runnable("start-of-work", d))),
        ("真仓：doctor 是 start-of-work 相位（不靠名字排除）",
         lambda: any(g["file"].endswith("doctor.py") for g in real)
         and not any(g["file"].endswith("doctor.py")
                     for g in runnable("commit"))),
        ("红名单非空且每道都标了旗标（真仓一致性）",
         lambda: (lambda rn: len(rn) >= 1 and all(
             any(g["file"].endswith(b) and g["name_dependent"] for g in real)
             for b in rn))(red_need(real))),
        ("真仓：每个平台模块都声明了 MODULE（无 undeclared）",
         lambda: modules()[1] == [] and len(modules()[0]) >= 8),
        ("★ 未声明的平台模块 ⇒ 必须报（C5：平台模块必须声明自己）",
         lambda: any("必须声明自己" in x for x in problems(
             [], [], mods=["zreflect/x.py"], mods_missing=[],
             knob_problems=[], undeclared=["zreflect/orphan_mod.py"]))),
        ("真仓：夹具改名集唯一产地（FIXTURE_RENAMES 覆盖全部 RENAMED_DEFAULTS）",
         lambda: set(FIXTURE_RENAMES) == set(RENAMED_DEFAULTS)
         and len(FIXTURE_RENAMES) >= 7),
        ("插件：einfacht-env.sh 发现式收编（doctor 不再靠点名）",
         lambda: "reflect-hooks/einfacht-env.sh" in plugins()
         and "zreflect/doctor.py" not in plugins()),
        ("render_gates 是纯函数且含每道闸门（含首尾标记）",
         lambda: render_gates(gs) == render_gates(gs)
         and "甲闸门" in render_gates(gs)
         and GATES_BEGIN in render_gates(gs) and GATES_END in render_gates(gs)),
        # ② 该报的必须报
        ("★ 叫 check_ 却没声明 ⇒ 必须报（忘写声明行的形状）",
         lambda: missing == ["zreflect/check_bare.py"]),
        ("★ runs_at 是未知相位 ⇒ 必须报（频率写错会让执行面漏掉它）",
         lambda: any("不是已知相位" in x for x in problems(
             [dict(plain, runs_at="whenever")], [],
             mods=["zreflect/x.py"], mods_missing=[], knob_problems=[], undeclared=[]))),
        ("★ 标了 name_dependent 却不消费改名默认名 ⇒ 必须报（旗标错了）",
         lambda: any("旗标" in x for x in problems(
             [dict(plain, name_dependent=True)], [],
             mods=["zreflect/x.py"], mods_missing=[], knob_problems=[], undeclared=[]))),
        ("★ 写了自证却没有 --selftest 入口 ⇒ 必须报（写而不跑 = 装饰）",
         lambda: any("写而不跑" in x for x in problems(
             [], [], mods=["zreflect/x.py"],
             mods_missing=["zreflect/y.py"], knob_problems=[]))),
        # ③ 空输入必须报
        ("★ 空名录 + 空模块 ⇒ 必须报（零值守卫）",
         lambda: problems([], [], mods=[], mods_missing=[],
                          knob_problems=[], undeclared=[]) != []),
    ]


MODULE = module_meta("发现式名录", "闸门/模块/插件的声明派生：执行面 + 叙述 + 红名单", selftest=True)


if __name__ == "__main__":
    sys.exit(selftest("registry（发现式名录的数据面）", _cases())
             if "--selftest" in sys.argv else main(sys.argv[1:]))
