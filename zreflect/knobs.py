#!/usr/bin/env python3
"""旋钮登记（REFLECT_* 的**唯一名册**）：一处登记，处处派生。

「旋钮」这个概念此前没有 module：读取散在各闸门、声明活在 docstring 文字里、
判据数据在 check_envfile 的 FILE_KNOBS、名册靠扫全部文本 —— 扫描器明说
「文档字符串里的提及也算」，于是 REFLECT_AB / REFLECT_PINS 这类只写在
文档里的**幻影旋钮**进了名册、通过了 typo 检查，而用户真的 export 它们时
**静默无效**（Phase 0 已把它们实现化）。三个 module 各持一份互相不一致的
「旋钮是什么」—— 这正是浅 seam 的病。

本 module 收拢成一个 interface：**登记即存在**。名字、种类、默认值、
一句话语义，全部登记式；check_envfile 的判据从这里读；扫描面里出现而
登记表里没有的 REFLECT_* 记号 = 幻影 / typo ⇒ 报（docstring 提名不算数，
登记才算数）；三语 README 里出现的 REFLECT_* 名字 ⊆ 登记（反向断言，
envfile 的自证执行）。

种类（kind）—— envfile 按它决定要不要查存在性：

  file    值是相对仓库根的文件名（存在性要查；空默认 = 未配即未启用）
  list    逗号分隔的文件名清单（逐个查）
  dir     值是相对仓库根的目录名
  number  数字（秒 / 天 / 阈值；空默认 = 该规则明说未启用）
  flag    枚举开关（如 off）
  value   任意字符串（覆盖 / 名字 / 编号清单）

⚠️ 名册纪律：**只登记真的被 `os.environ.get` 读的旋钮**。给「将来可能用」
的名字留位子 = 自己制造幻影 —— 幻影旋钮的形状教训：文档承诺了、代码不读、
用户配了静默无效。这里连举例都不写具体未登记的名字（扫描对账会把例子
当幻影报出来 —— 对账不看上下文，这正是它的强度）。
"""
from __future__ import annotations

import os
import re
import sys

from gate import module_meta, GATE_REPO                                # noqa: E402

# 名字 → (kind, 默认值, 一句话语义)。默认值 = 旋钮未配时各消费方的回落名。
REGISTRY = {
    "REFLECT_FACTS": ("file", "FACTS.json", "事实台账"),
    "REFLECT_DOC": ("file", "STATE.md", "活状态文档（机器块渲染进它）"),
    "REFLECT_DOCS": ("list", "STATE.md,AGENTS.md,README.md,README.zh.md,README.de.md",
                     "翻案 / 陈旧闸门扫描的活状态文档清单"),
    "REFLECT_HISTORY_SECS": ("value", "", "append-only 历史章节编号（如 5,9,10）"),
    "REFLECT_RETIRED": ("value", "", "退役组件名清单；空 = 该规则明说未启用"),
    "REFLECT_NAKED_MIN": ("number", "100", "裸数字阈值（小于它的整数不查）"),
    "REFLECT_STALE_DAYS": ("number", "", "测龄报警天数；空 = 该规则明说未启用"),
    "REFLECT_REPLAY": ("flag", "", "off ⇒ 复跑闸门明说未启用"),
    "REFLECT_REPLAY_TIMEOUT": ("number", "10", "逐字执行器的默认超时秒数"),
    "REFLECT_READMES": ("list", "README.md,README.zh.md,README.de.md",
                        "三语 README 名单（结构互链 + 每次推送同批）"),
    "REFLECT_RETRACTIONS": ("file", "retractions.json", "翻案台账"),
    "REFLECT_QUESTIONS": ("dir", "questions", "悬案目录"),
    "REFLECT_ENV_FILE": ("value", "Einfacht.env", "钩子旋钮载体的文件名"),
    "REFLECT_INVARIANTS": ("file", "", "声明式不变量规格；空 = 明说未启用"),
    "REFLECT_INSTRUMENTS": ("file", "", "量法登记位；空 = 该规则明说未启用"),
    "REFLECT_INSTRUMENT_DAYS": ("number", "", "恒常检测阈值天；空 = 该规则明说未启用"),
    "REFLECT_DOCTOR": ("file", "doctor.json", "doctor 规格（开工预检，非闸门）"),
    "REFLECT_DOCTOR_TIMEOUT": ("number", "2", "每条 doctor 探测的秒数"),
    "REFLECT_WORLD": ("file", "world.json", "world 声明（验证对象清单）；缺文件 = 未启用"),
    "REFLECT_WORLD_LINE": ("value", "", "world 线覆盖（CI / 特殊跑法）"),
    "REFLECT_AB": ("file", "ab.json", "A/B 同旗标闸门的规格名"),
    "REFLECT_PINS": ("file", "pins.json", "派生树 pin 一致性闸门的规格名"),
}

KINDS = ("file", "list", "dir", "number", "flag", "value")

# 旋钮记号：REFLECT_ + 大写。**左边界必需** —— 不加时，翻案示例文本
# （`ZCODE_` 前缀 + 一个记号）会被从中间切成假记号，三语 README 对账
# 各报一次假阳性（实测踩到）。⚠️ 本文件里**不写出**那个假记号字面量。
_TOKEN_RE = re.compile(r"(?<![A-Za-z0-9_])REFLECT_[A-Z0-9_]+")


def kinds_of(name):
    """旋钮的种类（未登记 ⇒ None —— 调用方该报幻影 / typo）。"""
    entry = REGISTRY.get(name)
    return entry[0] if entry else None


def scan_surface_problems(py_dir=None):
    """扫描面（zreflect/*.py）里出现、登记表里没有的 REFLECT_* 记号。

    **名册自洽性**，与任何载体（Einfacht.env）是否存在无关 —— 它属于
    「名册」本身（C3）：此前这条判据焊在 check_envfile.run() 的
    「载体存在」前置之后，本仓没有 Einfacht.env ⇒ 幻影守卫从未执行
    （实测踩到）。`py_dir` 可注入（自证用假源码树）。
    """
    d = py_dir if py_dir is not None else _zdir()
    out = []
    try:
        names = sorted(os.listdir(d))
    except OSError:
        return out
    toks = set()
    for n in names:
        if not n.endswith(".py"):
            continue
        try:
            toks.update(_TOKEN_RE.findall(
                open(os.path.join(d, n), encoding="utf-8",
                     errors="replace").read()))
        except OSError:
            continue
    for tok in sorted(toks):
        if tok not in REGISTRY:
            out.append("记号 `%s` 出现在 zreflect/*.py 里但不在旋钮登记表"
                       "（zreflect/knobs.py）—— 要么是 typo（会被所有程序"
                       "静默忽略），要么是幻影旋钮（文档承诺了、代码不读，"
                       "配了静默无效）。登记才算数" % tok)
    return out


def readme_problems(files=None, readmes=None):
    """三语 README（REFLECT_READMES 名单）里出现、登记表里没有的 REFLECT_*
    名字（文档侧幻影防御）。`files` 可注入假文件系统（自证用）。"""
    out = []
    names = readmes if readmes is not None else [
        s.strip() for s in os.environ.get(
            "REFLECT_READMES",
            "README.md,README.zh.md,README.de.md").split(",") if s.strip()]
    for name in names:
        if files is not None:
            if name not in files:
                continue
            text = files[name]
        else:
            p = os.path.join(GATE_REPO, name)
            if not os.path.exists(p):
                continue
            text = open(p, encoding="utf-8", errors="replace").read()
        for tok in sorted(set(_TOKEN_RE.findall(text))):
            if tok not in REGISTRY:
                out.append("%s 提到未登记旋钮 `%s` —— 幻影 or typo；"
                           "登记进 zreflect/knobs.py 才算数" % (name, tok))
    return out


def _zdir():
    return os.path.dirname(os.path.abspath(__file__))


def declared_vs_read_problems(gates):
    """C4 对账①：闸门**声明**消费的旋钮 ⊆ 它**实际读**的旋钮。

    声明在 `GATE = meta(…, knobs=(…))`，实读在源码里的
    `os.environ.get("REFLECT_…")`（旋钮名一定以字面量出现在源码某处 ——
    否则它读不到那个环境变量）。两者此前无任何比较 —— AUTO:GATES 表
    可能列着闸门根本不读的旋钮（声明与实现不符，静默）。
    `gates` = registry.gates() 的结果（含 file / knobs）。
    """
    out = []
    for g in gates:
        declared = set(g.get("knobs") or ())
        if not declared:
            continue
        try:
            text = open(os.path.join(GATE_REPO, g["file"]), encoding="utf-8",
                        errors="replace").read()
        except OSError:
            continue
        read = set(_TOKEN_RE.findall(text))
        ghost = sorted(k for k in declared if k not in read)
        if ghost:
            out.append("`%s` 声明消费 %s，但源码里读不到这些旋钮 —— "
                       "声明与实现不符（AUTO:GATES 表会撒谎）"
                       % (g["file"], ", ".join(ghost)))
    return out


def registry_vs_readme_problems(readmes=None, tables=None):
    """C4 对账②：登记表里的旋钮 ⊆ 三语 README 配置表。

    `knobs.REGISTRY` 与三语 README 的配置表是两份「旋钮清单」，此前只查
    单向（README ⊆ REGISTRY，见 readme_problems）。这条查反向：登记了的
    旋钮必须在三语 README 里都有配置行 —— 否则新旋钮登记了却没人知道
    怎么配（文档缺口，静默）。`tables` 可注入（自证用假 README）。
    """
    row = re.compile(r"\|\s*`(REFLECT_[A-Z0-9_]+)`\s*\|")
    out = []
    names = readmes if readmes is not None else [
        s.strip() for s in os.environ.get(
            "REFLECT_READMES",
            "README.md,README.zh.md,README.de.md").split(",") if s.strip()]
    for name in names:
        if tables is not None:
            if name not in tables:
                continue
            text = tables[name]
        else:
            p = os.path.join(GATE_REPO, name)
            if not os.path.exists(p):
                continue
            text = open(p, encoding="utf-8", errors="replace").read()
        have = set(row.findall(text))
        if not have:
            continue                    # 非配置表形态：不误报
        missing = sorted(k for k in REGISTRY if k not in have)
        if missing:
            out.append("%s 的配置表缺这些已登记旋钮的说明行：%s —— "
                       "登记了却没人知道怎么配（文档缺口）"
                       % (name, ", ".join(missing)))
    return out


# ── 自证：名册自身的形状守卫（登记表坏 = 所有消费方的判据数据坏）──────────────
def _cases():
    import atexit                                        # noqa: PLC0415
    import shutil                                        # noqa: PLC0415
    import tempfile                                      # noqa: PLC0415
    d = tempfile.mkdtemp()
    atexit.register(shutil.rmtree, d, True)
    open(os.path.join(d, "good.py"), "w").write(
        'X = os.environ.get("REFLECT_FACTS")\n')
    # 幻影记号用拼接构造：本文件在扫描面内（zreflect/*.py），字面量写出来
    # 会被自己的 scan_surface_problems() 收编（本仓老坑）。
    phantom = "REFLECT_" + "GHOSTX"
    open(os.path.join(d, "phantom.py"), "w").write(
        '# 注释里提到 ' + phantom + ' 这个不存在的旋钮\n')
    return [
        # ① 正常不报
        ("登记表每条 = (合法 kind, 字符串默认值, 非空语义)",
         lambda: all(k in KINDS and isinstance(dflt, str) and w.strip()
                     for k, dflt, w in REGISTRY.values()) and len(REGISTRY) >= 20),
        ("扫描面只有已登记旋钮 ⇒ 不报（真源码树）",
         lambda: scan_surface_problems() == []),
        ("README 旋钮提名 ⊆ 登记 ⇒ 不报",
         lambda: readme_problems(files={
             "README.md": "用 REFLECT_FACTS 与 REFLECT_DOC。",
             "README.zh.md": "x", "README.de.md": "x"}) == []),
        ("真仓扫描面干净（无幻影旋钮）", lambda: scan_surface_problems() == []),
        ("真仓三语 README 无未登记旋钮", lambda: readme_problems() == []),
        # ② 该报的必须报
        ("★ 扫描面出现未登记记号 ⇒ 必须报（幻影 / typo，登记才算数）",
         lambda: any(phantom in x
                     for x in scan_surface_problems(py_dir=d))),
        ("★ README 提到未登记旋钮 ⇒ 必须报（文档侧幻影）",
         lambda: any("未登记旋钮" in x for x in readme_problems(files={
             "README.md": "见 " + "REFLECT_" + "GHOSTY" + "。",
             "README.zh.md": "x", "README.de.md": "x"}))),
        # ③ 空输入必须报
        ("★ 登记表为空 = 名册坏（零值守卫）", lambda: bool(REGISTRY)),
    ]


def selftest():
    sys.path.insert(0, __file__.rsplit("/", 1)[0])
    from gate import selftest as _st                     # noqa: PLC0415
    return _st("knobs（旋钮登记：REFLECT_* 的唯一名册）", _cases())


MODULE = module_meta("旋钮登记", "REFLECT_* 的唯一名册 + 名册自洽性判据", selftest=True)


if __name__ == "__main__":
    sys.path.insert(0, __file__.rsplit("/", 1)[0])
    from gate import main_selftest_or                    # noqa: PLC0415

    def _run(argv):
        print("knobs 是模块（被各闸门消费）；--selftest 看自证。",
              file=sys.stderr)
        return 2
    sys.exit(main_selftest_or(sys.argv[1:],
                              "knobs（旋钮登记：REFLECT_* 的唯一名册）",
                              _cases, _run))
