#!/usr/bin/env python3
"""env 文件闸门（**可插拔模块**，issue #8）：守钩子的 REFLECT_* 载体。

钩子经可拔插件 einfacht-env.sh 加载 Einfacht.env
（默认名；REFLECT_ENV_FILE 可换）—— 那是 issue #8
的持久载体：钩子语境里「谁记得 export」不算数。
本闸门守这份载体的**静默坏法**，全是「部署了 ≠ 在跑」
家族：

  · 旋钮名打错一位 ⇒ 被所有程序静默忽略，值永远
    到不了钩子 —— 最危险的一种：一切照常跑；
  · 文件旋钮指向不存在的文件 ⇒ 钩子的 [ -f ] 守卫
    静默跳过，机器块从这一刻起悄悄过期；
  · 值为空 / 文件里只剩注释 ⇒ 看起来配了、其实
    什么都没加载；
  · sh 语法坏 ⇒ 钩子要到提交时刻才响亮地死
    （set -e），报错还指向不明。

**名册是登记式的**（2026-10-07 起，Phase 2）：判据数据
= `zreflect/knobs.py` 的 REGISTRY（名字 → kind / 默认值 /
语义），本文件的手写 FILE_KNOBS 名单退役。对账双向：

  · export 的名字不在登记表 ⇒ typo / 幻影（配了
    静默无效）；
  · zreflect/*.py 扫描面里出现、登记表里**没有**的
    REFLECT_* 记号 ⇒ 幻影旋钮 / typo（docstring 提名
    不算数，登记才算数 —— REFLECT_AB/REFLECT_PINS
    幻影事故的 structural 修复）；
  · 三语 README（REFLECT_READMES 名单）里出现的
    REFLECT_* 名字 ⊆ 登记（文档侧幻影防御，自证跑）。

可插拔：Einfacht.env 不存在（钩子目录与仓库根都
没有）⇒ 明说未启用、退 0（钩子回落纯环境变量
+ 默认名）。

诚实边界：存在性只查**相对仓库根**的路径；
core.hooksPath 改过布局的仓库，钩子目录按
reflect-hooks/ 找（声明式检查的文本形态上限，
issue #7 同款边界）。

用法（直接跑，cwd=仓库根）：
    python3 zreflect/check_envfile.py [--selftest]
退出码：0=绿 / 1=发现问题 / 2=配置或环境坏了。
"""
from __future__ import annotations

import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import knobs  # noqa: E402
from gate import fatal, finish, main_selftest_or, meta, off, repo  # noqa: E402
from i18n import M  # noqa: E402
from knobs import REGISTRY  # noqa: E402

ENV_FILE = (os.environ.get("REFLECT_ENV_FILE", "Einfacht.env")
            .strip() or "Einfacht.env")

_EXPORT_RE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
# 显式括号只为把优先级写明白（`^a|b$` 交替本身优先级最低）；行为与
# `^["\']|["\']$` 逐字相同 —— 只剥首/尾引号，不收中间引号。
_QUOTES_RE = re.compile(r'^(?:["\'])|(?:["\'])$')
# 旋钮记号：REFLECT_ + 大写。**左边界必需** —— 不加时，翻案示例文本
# （`ZCODE_` 前缀 + 一个记号）会被从中间切成假记号，三语 README 对账
# 各报一次假阳性（实测踩到）。⚠️ 本注释与自证里都**不写出**那个假记号

# 记号正则的唯一产地在 knobs._TOKEN_RE（此前两份逐字相同，会漂）。
from knobs import _TOKEN_RE  # noqa: E402  (唯一产地；本文件曾自抄一份)


def known_knobs(py_dir=None):
    """发现式扫描：zreflect/*.py 里出现的 REFLECT_* 记号全集。

    对账用（不是名册本身 —— 名册是 knobs.REGISTRY）：扫描面里出现而
    登记表里没有的记号 = 幻影 / typo，本闸门报。`py_dir` 可注入
    （自证用假源码树 —— 真文件进了自证，自证就依赖机器了）。

    ⚠️ **默认目录是「被检查仓」的 zreflect**（`repo("zreflect")`），不是工具的
    —— 本闸门守的是**被检查仓库**的载体，不是工具自己。`knobs._py_sources()`
    是共享的读取循环，但 base 由这里显式给：两边的默认目录在生产里同值、
    在夹具里不同（那条差别必须留住，不能靠巧合）。
    """
    d = py_dir if py_dir is not None else repo("zreflect")
    found = set()
    for _name, text in knobs._py_sources(d):
        found.update(_TOKEN_RE.findall(text))
    return found


def _known_knobs_scans_repo():
    """`known_knobs()` 的默认扫描面必须是**被检查仓**的 zreflect，不是工具的。

    判据考的是**行为**：在一个夹具仓里放一个幻影旋钮，`known_knobs()` 必须
    看得见它。工具的 zreflect 里没有那个记号 ⇒ 若默认目录漂到工具那边，这条红。
    """
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    try:
        os.makedirs(os.path.join(d, "zreflect"))
        marker = "REFLECT_" + "PROBEONLY"        # 拼接构造：不污染扫描面
        with open(os.path.join(d, "zreflect", "probe.py"), "w",
                  encoding="utf-8") as fh:
            fh.write("X = os.environ.get('%s')\n" % marker)
        # ⚠️ `gate.repo()` 读的是**模块级 `GATE_REPO`**（import 时快照），
        # 改 `os.environ` 对它无效（实测：改环境变量后 known_knobs 仍扫真仓）。
        # 必须直接改模块属性。
        import gate  # noqa: PLC0415
        prev = gate.GATE_REPO
        gate.GATE_REPO = d
        try:
            return marker in known_knobs()
        finally:
            gate.GATE_REPO = prev
    finally:
        shutil.rmtree(d, True)


def parse_exports(text):
    """解析 env 文件的生效 export（纯函数：自证要用）。

    返回 {名字: 值}。注释行 / 空行跳过 —— 只剩注释
    的文件 ⇒ 空 dict（「看起来配了」的静默坏法由
    调用方报告）。值只做引号剥离，不做变量展开
    （存在性判据不需要展开后的值）。
    """
    out = {}
    for line in text.splitlines():
        m = _EXPORT_RE.match(line)
        if not m:
            continue
        out[m.group(1)] = _QUOTES_RE.sub("", m.group(2).strip())
    return out


def _phantom_token_problems(scanned, registry):
    """扫描面里出现、登记表里没有的 REFLECT_* 记号（幻影 / typo）。

    typo 样例必须由调用方拼接构造 —— 本文件在扫描面内，字面量写死
    会把 typo 收进扫描面，守卫就废了。
    """
    out = []
    for tok in sorted(scanned):
        if tok not in registry:
            out.append(M("envfile.unknown_knob", knob=tok))
    return out


def _existence_targets(kind, value):
    """旋钮值 → (要查存在性的路径清单, 是否目录)；None = 该 kind 不查。"""
    if kind == "file":
        return [value], False
    if kind == "list":
        return [t.strip() for t in value.split(",") if t.strip()], False
    if kind == "dir":
        return [value], True
    return None                         # number / flag / value 不查存在性


def _export_problems(name, value, registry, file_exists, dir_exists):
    """单个 export 的判据：空值 / 未登记 / 指向缺失（顺序即报告顺序）。"""
    if not value:
        return [M("envfile.empty_value", key=name)]
    kind = registry.get(name, (None,))[0]
    if kind is None:
        return [M("envfile.unregistered_knob", key=name)]
    targets = _existence_targets(kind, value)
    if targets is None:
        return []
    paths, is_dir = targets
    # 「文件 / 目录」是语法名词而非旋钮值：拆成两个 code，模板里不出现中文常量
    # （本体零语言），旋钮名与路径仍走参数。
    #
    # ⚠️ **两个 code 各写一条 `M(...)`**：写成 `M("a" if is_dir else "b")` 时，
    # `knobs.used_codes()` 的正则只抓得到第一个 ⇒ 另一个在 `pack_coverage`
    # 面前不存在。语言包缺了它、用户看到裸 code，而对账照样绿（实测：
    # 这条正是新加的 `i18n_cover.code_not_literal` 抓出来的）。
    out = []
    for t in paths:
        hit = dir_exists(t) if is_dir else file_exists(t)
        if not hit:
            entry = registry.get(name, ("", "", "?"))[2]
            out.append(M("envfile.dir_missing", key=name, entry=entry, target=t)
                       if is_dir else
                       M("envfile.file_missing", key=name, entry=entry, target=t))
    return out


def _syntax_problems(syntax_ok):
    """sh -n 结论 → 问题：False = 文件语法坏；None = 仪器本身坏了。"""
    if syntax_ok is False:
        return [M("envfile.syntax_broken", name=ENV_FILE)]
    if syntax_ok is None:
        return [M("envfile.syntax_tool_broken")]
    return []


def problems(exports, registry, file_exists, dir_exists, syntax_ok=None,
             scanned=()):
    """纯函数：返回问题清单（空 = 绿）。自证期间不许 print。

    `registry` = knobs.REGISTRY（名字 → (kind, 默认, 语义)）；
    `scanned` = known_knobs() 的扫描面（对账幻影 / typo）；
    `file_exists` / `dir_exists` = 存在性探针（自证注入假文件系统）；
    `syntax_ok` = sh -n 的结论（True / False；None = 仪器本身跑不了）。
    """
    if not exports:
        return [M("envfile.no_effective_export", name=ENV_FILE)]
    # 幻影 / typo 对账（扫描面）+ 每个 export 的载体判据 + sh 语法。
    out = _phantom_token_problems(scanned, registry)
    for name in sorted(exports):
        if not name.startswith("REFLECT_"):
            continue                    # 非旋钮 export 不是本闸门的活
        out += _export_problems(name, exports[name], registry,
                                file_exists, dir_exists)
    return out + _syntax_problems(syntax_ok)


def _find_env_file():
    """插件同款的解析顺序：钩子目录优先、仓库根次之。"""
    for d in (repo("reflect-hooks"), repo()):
        p = os.path.join(d, ENV_FILE)
        if os.path.exists(p):
            return p
    return None


def run(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    p = _find_env_file()
    if p is None:
        # ⚠️ C3：off 早返回**只跳过载体检查** —— 名册自洽性（幻影旋钮 /
        # README 幻影）与载体是否存在无关，已搬到 knobs.py 并由
        # registry.problems() 收口（此前它焊在这里之后，本仓没有
        # Einfacht.env ⇒ 从未执行，实测踩到）。
        return off(M("envfile.off", name=ENV_FILE))
    try:
        with open(p, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError as e:
        return fatal(M("envfile.unreadable", path=p, error=e))
    scanned = known_knobs()
    if not scanned:
        return fatal(M("envfile.scan_empty", path=repo("zreflect")))
    # 语法检查（仪器）：sh -n 只解析不执行。语法错 ⇒ 是要报
    # 的问题；跑不了 ⇒ 仪器坏了（syntax_ok=None，如实报）。
    syntax = None
    try:
        r = subprocess.run(["sh", "-n", p], capture_output=True)
        syntax = r.returncode == 0
    except OSError:
        syntax = None
    exports = parse_exports(text)
    # 载体内的判据：export 名 typo / 文件旋钮指向缺失 / 空值 / sh 语法。
    # （README 幻影与「工具仓扫描面」的幻影归 knobs.py；本闸门这份扫的是
    # **被检查仓**的 zreflect/ —— 下游仓自己代码里的 typo 只有它看得见，
    # 与 knobs 那份扫描面不同，两份都留。）
    probs = problems(exports, REGISTRY,
                     lambda t: os.path.exists(repo(t)),
                     lambda t: os.path.isdir(repo(t)),
                     syntax_ok=syntax, scanned=scanned)
    return finish(M("envfile.title"), probs,
                  M("envfile.ok", path=os.path.relpath(p, repo()),
                    count=len(exports)))


def _cases_fixture():
    """夹具（原 `_cases` 的前置段原样搬入）。"""
    good_files = ("STATE.md", "README.md", "README.zh.md",
                  "README.de.md", "FACTS.json", "AGENTS.md",
                  "RETRACT.json", "invariants.json")
    fe = lambda t: t in good_files                     # noqa: E731
    de = lambda t: t in ("questions", "cases")         # noqa: E731
    registry = {k: REGISTRY[k] for k in
                ("REFLECT_DOC", "REFLECT_READMES", "REFLECT_QUESTIONS",
                 "REFLECT_FACTS", "REFLECT_NAKED_MIN", "REFLECT_ENV_FILE")}
    good_env = {"REFLECT_DOC": "STATE.md",
                "REFLECT_READMES": "README.md,README.zh.md,README.de.md",
                "REFLECT_QUESTIONS": "questions",
                "REFLECT_NAKED_MIN": "100"}
    # typo 样例用拼接构造：本文件在扫描面里，会被 known_knobs() 扫到 ——
    # 字面量写死会把 typo 收进扫描面，守卫就废了。
    typo = "REFLECT_" + "DOCSS"
    return {'good_files': good_files, 'fe': fe, 'de': de, 'registry': registry, 'good_env': good_env, 'typo': typo}


def _cases_knobs(fx):
    """见 `_cases()`：本组 7 条。"""
    fe, de, registry, good_env, typo = fx["fe"], fx["de"], fx["registry"], fx["good_env"], fx["typo"]
    return [
    # ① 正常不报
    ("envfile.ok",
     lambda: problems(good_env, registry, fe, de, syntax_ok=True,
                      scanned=registry.keys()) == []),
    ("envfile.scan_clean",
     lambda: problems(good_env, registry, fe, de, syntax_ok=True,
                      scanned=set(registry) | {"REFLECT_FACTS"}) == []),
    ("envfile.readme_nominations_registered",
     lambda: knobs.readme_problems(files={
         "README.md": "REFLECT_DOC REFLECT_READMES",
         "README.zh.md": "x", "README.de.md": "x"}) == []),
    # ② 该报的必须报
    ("★ envfile.unknown_knob",
     lambda: any(getattr(p,"code","") == "envfile.unknown_knob" for p in problems(
         good_env, registry, fe, de, syntax_ok=True,
         scanned=set(registry) | {typo}))),
    ("★ envfile.unregistered_knob",
     lambda: any(getattr(p,"code","") == "envfile.unregistered_knob" for p in problems(
         {typo: "STATE.md"}, registry, fe, de, syntax_ok=True,
         scanned=registry.keys()))),
    ("★ envfile.file_missing.list_target",
     lambda: any(getattr(p,"code","") == "envfile.file_missing" and p.params.get("target") == "README.missing.md" for p in problems(
         {"REFLECT_READMES": "README.md,README.missing.md"},
         registry, fe, de, syntax_ok=True, scanned=registry.keys()))),
    # ⚠️ 曾写过一条 `repo("zreflect") == knobs._zdir()` 的「对账」——**那是错的**：
    # 它断言的只是一个配置事实（GATE_REPO 没被覆盖），与 `known_knobs` 实际
    # 扫哪里**无关**。实测：把 known_knobs 的默认目录改成 `knobs._zdir()`
    # （真正的漂移），那条断言照样绿。判据必须考**代码路径**，不是考巧合。
    # 换成下面这条：默认目录必须指向被检查仓（夹具下真的会红）。
    ("★ envfile.known_knobs_scans_checked_repo",
     lambda: _known_knobs_scans_repo()),
    ]


def _cases_carrier(fx):
    """见 `_cases()`：本组 8 条。"""
    fe, de, registry, typo = fx["fe"], fx["de"], fx["registry"], fx["typo"]
    return [
    ("envfile.non_reflect_export",
     lambda: problems({"PATH": "/usr/bin"}, registry, fe, de,
                      syntax_ok=True, scanned=registry.keys()) == []),
    ("★ envfile.file_missing",
     lambda: any(getattr(p,"code","") == "envfile.file_missing" for p in problems(
         {"REFLECT_DOC": "MYSTATE.md"}, registry, fe, de,
         syntax_ok=True, scanned=registry.keys()))),
    ("★ envfile.dir_missing",
     lambda: any(getattr(p,"code","") == "envfile.dir_missing" for p in problems(
         {"REFLECT_QUESTIONS": "STATE.md"}, registry, fe, de,
         syntax_ok=True, scanned=registry.keys()))),
    ("★ envfile.empty_value",
     lambda: any(getattr(p,"code","") == "envfile.empty_value" for p in problems(
         {"REFLECT_DOC": ""}, registry, fe, de, syntax_ok=True,
         scanned=registry.keys()))),
    # ③ 空输入必须报
    ("★ envfile.no_effective_export",
     lambda: problems({}, registry, fe, de, syntax_ok=True,
                      scanned=registry.keys()) != []),
    # 边界（判据归 knobs.py；此处保留一条串联证明搬运没丢语义）：
    # 假记号不许从别的前缀里切出来（翻案示例文本曾被切成假旋钮名）。
    # ⚠️ 样例用拼接构造：本文件在扫描面内，字面量写出来会被对账收编。
    ("★ envfile.prefix_word_not_sliced",
     lambda: knobs.readme_problems(files={
         "README.md": "> ZCODE_" + typo,
         "README.zh.md": "x", "README.de.md": "x"}) == []),
    # 引号剥离（_QUOTES_RE 的显式优先级只为写明白，行为逐字不变）：
    # 复跑：python3 zreflect/check_envfile.py --selftest
    ("envfile.strip_quotes",
     lambda: parse_exports("D=\"hello\"")["D"] == "hello"
     and parse_exports("D='hello'")["D"] == "hello"),
    ("★ envfile.inner_quotes_kept",
     lambda: parse_exports("D=a\"b")["D"] == "a\"b"
     and parse_exports("D='a\"b'")["D"] == "a\"b"),
    ]


def _cases_syntax(fx):
    """见 `_cases()`：本组 2 条。"""
    fe, de, registry, good_env = fx["fe"], fx["de"], fx["registry"], fx["good_env"]
    return [
    ("★ envfile.syntax_broken",
     lambda: any(getattr(p,"code","") == "envfile.syntax_broken" for p in problems(
         good_env, registry, fe, de, syntax_ok=False,
         scanned=registry.keys()))),
    ("★ envfile.syntax_tool_broken",
     lambda: any(getattr(p,"code","") == "envfile.syntax_tool_broken" for p in problems(
         good_env, registry, fe, de, syntax_ok=None,
         scanned=registry.keys()))),
    ]


def _cases():
    """拼装 3 组夹具断言。**只拼装** —— 判据在各分组函数里。"""
    fx = _cases_fixture()
    return (
    _cases_knobs(fx)
    + _cases_carrier(fx)
    + _cases_syntax(fx)
    )


GATE = meta("env 文件闸门", "守钩子的 REFLECT_* 载体（旋钮 typo / 指向缺失 / 空值）",
            knobs=("REFLECT_ENV_FILE",),
            off_reason="没有 env 载体的仓（旋钮全用默认值）不需要它：规格未配 ⇒ 明说未启用")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:],
                              M("gate.title.envfile"),
                              _cases(), run))
