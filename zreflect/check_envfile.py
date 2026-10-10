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
from gate import fatal, finish, main_selftest_or, meta, off, repo, selftest  # noqa: E402
import knobs                                              # noqa: E402
from knobs import KINDS, REGISTRY                         # noqa: E402

ENV_FILE = (os.environ.get("REFLECT_ENV_FILE", "Einfacht.env")
            .strip() or "Einfacht.env")

_EXPORT_RE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
_QUOTES_RE = re.compile(r'^["\']|["\']$')
# 旋钮记号：REFLECT_ + 大写。**左边界必需** —— 不加时，翻案示例文本
# （`ZCODE_` 前缀 + 一个记号）会被从中间切成假记号，三语 README 对账
# 各报一次假阳性（实测踩到）。⚠️ 本注释与自证里都**不写出**那个假记号
# 字面量 —— 本文件在扫描面内，写出来就会被对账收编（自证用例用拼接构造）。
_TOKEN_RE = re.compile(r"(?<![A-Za-z0-9_])REFLECT_[A-Z0-9_]+")


def known_knobs(py_dir=None):
    """发现式扫描：zreflect/*.py 里出现的 REFLECT_* 记号全集。

    对账用（不是名册本身 —— 名册是 knobs.REGISTRY）：扫描面里出现而
    登记表里没有的记号 = 幻影 / typo，本闸门报。`py_dir` 可注入
    （自证用假源码树 —— 真文件进了自证，自证就依赖机器了）。
    """
    d = py_dir if py_dir is not None else repo("zreflect")
    knobs = set()
    try:
        names = sorted(os.listdir(d))
    except OSError:
        return knobs
    for n in names:
        if not n.endswith(".py"):
            continue
        try:
            with open(os.path.join(d, n), encoding="utf-8",
                      errors="replace") as fh:
                text = fh.read()
        except OSError:
            continue
        knobs.update(_TOKEN_RE.findall(text))
    return knobs


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


def problems(exports, registry, file_exists, dir_exists, syntax_ok=None,
             scanned=()):
    """纯函数：返回问题清单（空 = 绿）。自证期间不许 print。

    `registry` = knobs.REGISTRY（名字 → (kind, 默认, 语义)）；
    `scanned` = known_knobs() 的扫描面（对账幻影 / typo）；
    `file_exists` / `dir_exists` = 存在性探针（自证注入假文件系统）；
    `syntax_ok` = sh -n 的结论（True / False；None = 仪器本身跑不了）。
    """
    out = []
    if not exports:
        return ["%s 里没有任何生效的 export（空文件或只剩注释）"
                " —— 看起来配了、其实什么都没加载"
                "（「部署了 ≠ 在跑」家族）" % ENV_FILE]
    # 幻影 / typo 对账：扫描面里出现、登记表里没有的 REFLECT_* 记号。
    # （typo 样例必须由调用方拼接构造 —— 本文件在扫描面内，字面量写死
    # 会把 typo 收进扫描面，守卫就废了。）
    for tok in sorted(scanned):
        if tok not in registry:
            out.append("记号 `%s` 出现在 zreflect/*.py 里但不在旋钮登记表"
                       "（zreflect/knobs.py）—— 要么是 typo（会被所有程序"
                       "静默忽略），要么是幻影旋钮（文档承诺了、代码不读，"
                       "配了静默无效）。登记才算数" % tok)
    for name in sorted(exports):
        if not name.startswith("REFLECT_"):
            continue                    # 非旋钮 export 不是本闸门的活
        value = exports[name]
        if not value:
            out.append("`%s` 的值是空的 —— 空值会让钩子的"
                       " [ -f ] 守卫静默跳过（空不是通过）" % name)
            continue
        kind = registry.get(name, (None,))[0]
        if kind is None:
            out.append("旋钮名 `%s` 不在登记表（zreflect/knobs.py）—— 打错"
                       "一位会被所有程序静默忽略，值永远到不了钩子"
                       % name)
            continue
        if kind == "file":
            targets, is_dir = [value], False
        elif kind == "list":
            targets = [t.strip() for t in value.split(",") if t.strip()]
            is_dir = False
        elif kind == "dir":
            targets, is_dir = [value], True
        else:
            continue                    # number / flag / value 不查存在性
        for t in targets:
            hit = dir_exists(t) if is_dir else file_exists(t)
            if not hit:
                out.append("旋钮 `%s`（%s）指向的%s不存在：%s"
                           " —— 钩子的 [ -f ] 守卫会静默跳过"
                           "（路径相对仓库根）"
                           % (name, registry.get(name, ("", "", "?"))[2],
                              "目录" if is_dir else "文件", t))
    if syntax_ok is False:
        out.append("%s 过不了 sh -n（语法坏）⇒ 钩子要到提交"
                   "时刻才响亮地死，且报错指向不明" % ENV_FILE)
    if syntax_ok is None:
        out.append("sh -n 跑不了（sh 不在？）—— 语法检查这个"
                   "仪器本身坏了，先修检查器，不许静默跳过")
    return out


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
        return off("env 文件闸门：%s 不存在（钩子目录与仓库根都没有）"
                   " ⇒ 本闸门未启用（可插拔模块；钩子回落纯环境变量"
                   " + 默认名。要启用：cp reflect-hooks/"
                   "Einfacht.env.example reflect-hooks/%s）"
                   "。注：名册自洽性（幻影旋钮）不随本闸门关闭 —— 见 "
                   "registry.problems() / knobs.py" % (ENV_FILE, ENV_FILE))
    try:
        with open(p, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError as e:
        return fatal("%s 读不了：%s" % (p, e))
    scanned = known_knobs()
    if not scanned:
        return fatal("在 %s 里没发现任何 REFLECT_* 记号 —— 对账扫描"
                     "失败（zreflect/ 不在？），本闸门的仪器坏了"
                     % repo("zreflect"))
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
    # 幻影旋钮与 README 幻影已归 knobs.py（与载体无关）。
    probs = problems(exports, REGISTRY,
                     lambda t: os.path.exists(repo(t)),
                     lambda t: os.path.isdir(repo(t)),
                     syntax_ok=syntax, scanned=scanned)
    return finish("env 文件闸门", probs,
                  "env 文件闸门：OK（%s：%d 条生效 export，名字全在登记表、"
                  "文件旋钮指向都在）"
                  % (os.path.relpath(p, repo()), len(exports)))


def _cases():
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
    return [
        # ① 正常不报
        ("生效 export 全合法（含数字旋钮）⇒ 不报",
         lambda: problems(good_env, registry, fe, de, syntax_ok=True,
                          scanned=registry.keys()) == []),
        ("非 REFLECT_ 前缀的 export ⇒ 不报（不是本闸门的活）",
         lambda: problems({"PATH": "/usr/bin"}, registry, fe, de,
                          syntax_ok=True, scanned=registry.keys()) == []),
        ("扫描面对账干净（全在登记表）⇒ 不报",
         lambda: problems(good_env, registry, fe, de, syntax_ok=True,
                          scanned=set(registry) | {"REFLECT_FACTS"}) == []),
        ("三语 README 的旋钮提名 ⊆ 登记 ⇒ 不报（判据归 knobs）",
         lambda: knobs.readme_problems(files={
             "README.md": "用 REFLECT_DOC 与 REFLECT_READMES。",
             "README.zh.md": "x", "README.de.md": "x"}) == []),
        # ② 该报的必须报
        ("★ 扫描面出现未登记记号 ⇒ 必须报（幻影 / typo，登记才算数）",
         lambda: any("不在旋钮登记表" in x for x in problems(
             good_env, registry, fe, de, syntax_ok=True,
             scanned=set(registry) | {typo}))),
        ("★ 旋钮名打错一位 ⇒ 必须报（静默忽略家族）",
         lambda: any("不在登记表" in x for x in problems(
             {typo: "STATE.md"}, registry, fe, de, syntax_ok=True,
             scanned=registry.keys()))),
        ("★ 文件旋钮指向缺失文件 ⇒ 必须报（[ -f ] 静默跳过家族）",
         lambda: any("不存在" in x and "REFLECT_DOC" in x for x in problems(
             {"REFLECT_DOC": "MYSTATE.md"}, registry, fe, de,
             syntax_ok=True, scanned=registry.keys()))),
        ("★ 清单旋钮有一份缺失 ⇒ 必须报（点名缺失的那份）",
         lambda: any("README.missing.md" in x for x in problems(
             {"REFLECT_READMES": "README.md,README.missing.md"},
             registry, fe, de, syntax_ok=True, scanned=registry.keys()))),
        ("★ 目录旋钮指向文件 ⇒ 必须报（目录探针不命中）",
         lambda: any("目录" in x for x in problems(
             {"REFLECT_QUESTIONS": "STATE.md"}, registry, fe, de,
             syntax_ok=True, scanned=registry.keys()))),
        ("★ 值为空 ⇒ 必须报（空值让守卫静默跳过）",
         lambda: any("值是空的" in x for x in problems(
             {"REFLECT_DOC": ""}, registry, fe, de, syntax_ok=True,
             scanned=registry.keys()))),
        ("★ sh -n 不过 ⇒ 必须报",
         lambda: any("sh -n" in x for x in problems(
             good_env, registry, fe, de, syntax_ok=False,
             scanned=registry.keys()))),
        ("★ sh -n 跑不了 ⇒ 必须报（仪器坏了不许静默跳过）",
         lambda: any("跑不了" in x for x in problems(
             good_env, registry, fe, de, syntax_ok=None,
             scanned=registry.keys()))),
        # ③ 空输入必须报
        ("★ 空 export 集（空文件 / 只剩注释）⇒ 必须报",
         lambda: problems({}, registry, fe, de, syntax_ok=True,
                          scanned=registry.keys()) != []),
        # 边界（判据归 knobs.py；此处保留一条串联证明搬运没丢语义）：
        # 假记号不许从别的前缀里切出来（翻案示例文本曾被切成假旋钮名）。
        # ⚠️ 样例用拼接构造：本文件在扫描面内，字面量写出来会被对账收编。
        ("★ 前缀词里的记号不许被切出假旋钮名",
         lambda: knobs.readme_problems(files={
             "README.md": "> ZCODE_" + typo + " 这条是已翻案的示例。",
             "README.zh.md": "x", "README.de.md": "x"}) == []),
    ]


GATE = meta("env 文件闸门", "守钩子的 REFLECT_* 载体（旋钮 typo / 指向缺失 / 空值）",
            knobs=("REFLECT_ENV_FILE",))

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:],
                              "env 文件闸门（可插拔：守钩子的 REFLECT_* 载体）",
                              _cases(), run))
