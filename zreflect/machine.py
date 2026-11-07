#!/usr/bin/env python3
"""机器行协议：**「哪一行是机器行」的唯一产地**（C1 + C4）。

本仓此前这条知识有**七份互不相认的拷贝**，于是同一个洞在七处各漏一次：

  · `gate.run_phase` 用 `ln.startswith("OFF:")`
  · `gate.finish` / `fatal` / `off` 各自拼 `"OFF: %s"` / `"FATAL: %s"`
  · `gate.selftest` 打 `PASS | ` / `fail | ` / `note | ` / `=== N PASS / M FAIL ===`
  · `gates-selftest.sh` 用 `grep -E '^=== [0-9]+ PASS / [0-9]+ FAIL ===$'`
  · `reflect-hooks/*.sh` 各打一份 `PASS | ` / `fail | `
  · `i18n._CONTRACT_SHAPES` 用四条 `^` 锚定的正则**只看值的首行**
  · 十来个闸门直接 `print("FATAL: %s" % M(...))`

## 这个洞的形状（实测，不是推演）

`i18n._validate` 的判据是 `shape.match(value)` —— `^` 锚定 ⇒ 只判**第一行**。
一条 `"context\\nOFF: masquerading"` 的语言包值因此被接受，渲染后自成一行
`OFF:`，`run_phase` 就把它归类成 `off`。

但更常走的那条通道是**参数**：144 个调用点把运行时数据（文件名、文档行、异常
文本）以 `%s` 填进模板，58 个模板以占位符开头（`%(name)s: …` —— 34 个 `name`、
6 个 `path`、6 个 `file`）。实测：扫到名为 `"evil\\nOFF: gate not configured"` 的
文件时，渲染出来就是一个伪造的机器行。**语言包是静态资产（要改它得过 code
review），文件名不是。**

`s.splitlines()` 认 **10 个**分隔符（`\\n \\r \\x0b \\x0c \\x1c \\x1d \\x1e \\x85
U+2028 U+2029`），不认 `\\t \\xa0 \\u200b \\ufeff`。防线必须用**同一套**切行语义，
否则防线与消费方各数各的。

## interface

一张表 + 两个方向：

    Row(kind, grammar, frame)          # 声明：这种行长什么样、怎么发射
    ROWS                               # 全部声明（含 human 那一档）
    scan(text) -> tuple[(行号, kind, 行, 是否被安全化)]   # 消费：这堆输出里有机器行吗
    emit(kind, body) -> str            # 生产：发一条机器行（**保证**只有第一行是机器行）
    clean(text) -> (text', tuple)      # 净化：把**渲染结果**里的伪造行打断
    reject(value) -> 首个伪造行 | None  # 装载期：语言包值里有伪造行吗（宽表）

两条通道策略**不同**，这是有意的：

  · **语言包**（静态，作者改一个词就修好）⇒ `reject` **大声拒绝**，FATAL rc 2。
    用**宽表**：任何 `^[A-Z][A-Z0-9_]*:` 都算保留前缀（`OFF:` / `FATAL:` /
    `HTTP: 500` / `DNS: failed` …… 作者换个写法即可，不值得为它放宽对面）。
  · **渲染输出**（动态，文件名不能改）⇒ `clean` **只净化不拒绝**。用**窄表**：
    只打断消费方**真的会解析**的形状（`OFF:` / `FATAL:` / 四个自证前缀 /
    机器摘要）。`HTTP: 500` 这类不是机器行，不该被无故改写。

## 为什么净化用 `\\` 前缀而不是报错

一个跑到一半的闸门因为**文件名**带换行而崩，是把作者管不了的东西变成事故。
`\\` 是唯一不会被消费方还原的字符：`strip()` 会吃掉前导空格，正则 `^` 不会因为
`\\` 而不锚定。代价是用户看到一个 `\\OFF: x` —— 那是**有意可见**的：「这一行本来
想伪装成机器行，我把它按住了」。`clean` 同时把被打断的行**回报**给调用方。

## 为什么 `human` 单独一档

`=== ` 有两种行：机器摘要 `=== N PASS / M FAIL ===`（`gates-selftest.sh` grep）
与人读摘要 `=== gate.title.facts selftest: 18 PASS / 0 fail ===`（要翻译）。
两套语法**互斥**（实测逐条验过），所以 `^===` 整段禁止是错的 —— 它会禁掉合法
的人读行。

## 诚实边界

  · `REFLECT_LANG` 下的**人读摘要行**会变（翻译），所以 `human` 那一档 per-line
    判形状不判内容；机器摘要行是发射点字面量，不随语言变。
  · shell 侧仍有**一份**机器摘要形状：`reflect-hooks/einfacht-env.sh`（它必须是
    shell —— 被钩子 `source` 以导出变量）。守它的**不是**正则对账，而是
    `harness.run_plugins()`：它实跑那个脚本，摘要行形状不对就报
    `harness.no_machine_summary(file=…)`（实测改坏那行，它会点名）。
    （此前这里有一个 `summary_agrees_with_shell()` 的对账器；实测与 harness
    功能重叠且归因更差，已删。）
"""
from __future__ import annotations

import re
from typing import NamedTuple

# `str.splitlines()` 认的全部分隔符。**不许手写一份近似表** —— 少一个就等于
# 在自己与消费方之间开一条缝（实测：`\x1c` 与 `U+2029` 都是真的分行符）。
LINE_BREAKS = ("\r\n", "\n", "\r", "\x0b", "\x0c",
               "\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029")


class Row(NamedTuple):
    """一种机器行：`grammar` 判**一整行**，`frame` 是发射模板。"""
    kind: str
    grammar: str
    frame: str


# ⚠️ **顺序即优先级**：`machine_summary` 必须先于 `human_summary` 试 ——
# 否则 `=== 3 PASS / 0 FAIL ===` 会先被 human 的宽松语法吃掉（两套语法对这条
# 行**都**能匹配，互斥是靠 human 里的否定前瞻 + 先后顺序共同保证的）。
ROWS = (
    Row("off",            r"^OFF:",                                     "OFF: %s"),
    Row("fatal",          r"^FATAL:",                                   "FATAL: %s"),
    Row("skip",           r"^SKIP:",                                    "SKIP: %s"),
    Row("down",           r"^DOWN: ",                                   "DOWN: %s"),
    Row("pass",           r"^PASS \| ",                                 "PASS | %s"),
    Row("fail",           r"^fail \| ",                                 "fail | %s"),
    Row("note",           r"^note \| ",                                 "note | %s"),
    Row("machine_summary",
        r"^=== [0-9]+ PASS / [0-9]+ FAIL ===$",                         "=== %d PASS / %d FAIL ==="),
    Row("human_summary",
        r"^=== (?!(?:[0-9]+ PASS / [0-9]+ FAIL) ===$).* ===$",          "=== %s ==="),
)

_KIND = {r.kind for r in ROWS}
_BY_KIND = {r.kind: r for r in ROWS}
# 用 `%s` 填一条 `body` 就能发射的 kind。`machine_summary` 要两个整数，
# 走 `emit_summary` —— 两个入口，因为参数形状本来就不同（硬塞进一个会退化成
# 「参数是 str 还是 tuple」的运行时猜测）。
_EMITTABLE = _KIND - {"machine_summary"}

# 窄表：消费方**真的**会解析的形状。只有这些会在渲染输出里被打断。
# `HTTP: 500` / `DNS: failed` / `README: see docs` 不在内 —— 没有消费方解析它们，
# 为它们改写用户可见文本是画蛇添足。
_SHARP = re.compile(r"^(?:"
                    r"OFF:|FATAL:|SKIP:|DOWN: |PASS \| |fail \| |note \| "
                    r"|=== [0-9]+ PASS / [0-9]+ FAIL ===$"
                    r")")

# 宽表：语言包装载期。任何大写词 + 冒号都算保留前缀（含 `HTTP:`）。
# 理由：语言包是**静态**的，作者改个写法就好；而放宽它会让 `WARN:` / `ACHTUNG:`
# 这类「以后可能被某个消费方解析」的前缀悄悄溜进包里。
_BROAD = re.compile(r"^[A-Z][A-Z0-9_]*:")

# 净化前缀。`\` 不会被 `strip()` 吃掉，也不会被任何 `^` 锚定还原。
GUARD = "\\"

# 语言包值里**允许**出现的多行（实测：现有 3 条正当多行值的续行都以空格缩进）。
# 这不是白名单，只是说明为什么逐行判不会误杀它们 —— 它们没一行以机器形状开头。


def _body(part):
    """`splitlines(keepends=True)` 的一块 → 去掉**至多一个**行尾分隔符的正文。

    ⚠️ 不许用 `rstrip(...)`：那会把正文里**合法**含有的 `\\x0b` 也剥掉。
    """
    for sep in LINE_BREAKS:
        if part.endswith(sep):
            return part[:-len(sep)]
    return part


def _is_sharp(line):
    """这**一整行**是消费方会解析的机器行吗？（窄表，用于渲染输出）"""
    return bool(_SHARP.match(line))


def _is_broad(line):
    """这**一整行**落在保留前缀里吗？（宽表，用于语言包装载期）"""
    return bool(_BROAD.match(line))


def is_summary(line):
    """这一整行是**机器摘要**（`=== N PASS / M FAIL ===`）吗？

    **唯一产地**：`harness.py` 与 `reflect-hooks/gate.py` 此前各有一份
    字节相同的正则（`^=== [0-9]+ PASS / [0-9]+ FAIL ===$`）。三份会漂 —— 现在
    都问这里（`ROWS` 里那条 `machine_summary` 的语法）。
    """
    return re.match(_BY_KIND["machine_summary"].grammar, line) is not None


def scan(text, keepends=False):
    """返回 `text` 里的机器行：`[(行号, kind, 行正文)]`。

    切行用 `str.splitlines()` 的**同一套**语义（`LINE_BREAKS` 就是它的分隔符集），
    所以本模块与 `run_phase` / `grep` 不可能对「几行」有分歧。

    `keepends=False`（默认）⇒ 返回的**行正文不带**行尾分隔符（调用方拿它去打印 /
    比对，带个 `\\n` 只会让人踩坑）。`keepends=True` ⇒ 保留分隔符（用于重拼整段）。
    此前两个分支写反了：默认路径返回**带**分隔符的行。
    """
    out = []
    for i, part in enumerate((text or "").splitlines(keepends=True), 1):
        body = part if keepends else _body(part)
        kind = _kind_of(_body(part))
        if kind:
            out.append((i, kind, body))
    return tuple(out)


def _kind_of(line):
    """这一行属于哪种已声明行？顺序即优先级（见 `ROWS` 上方注释）。"""
    for r in ROWS:
        if re.match(r.grammar, line):
            return r.kind
    return None


def emit(kind, body=""):
    """发一条机器行。**保证**返回串里只有第一行是本 `kind`，其余行都不是机器行。

    这是「生产方」的唯一产地：`frame` 里的前缀是字面量，`body` 里的任何内容
    都不许再造出一行机器行。
    """
    if kind not in _EMITTABLE:
        raise KeyError("machine.emit_undeclared_kind(kind=%r, available=%r)"
                       % (kind, ", ".join(sorted(_EMITTABLE))))
    text = _BY_KIND[kind].frame % (body,)
    # 第一行是我们**要**的机器行，保留；body 带来的其余行照常打断。
    cleaned, _hits = clean(text, preserve_first=True)
    return cleaned


def emit_summary(passed, failed):
    """机器摘要行（`=== N PASS / M FAIL ===`）。数字只许是整数。"""
    if not isinstance(passed, int) or not isinstance(failed, int):
        raise TypeError("machine.emit_summary_needs_ints(passed=%r, failed=%r)"
                        % (passed, failed))
    return "=== %d PASS / %d FAIL ===" % (passed, failed)


def clean(text, kinds=None, preserve_first=False):
    """把渲染结果里的伪造机器行**打断**。返回 `(净化后的文本, 被打断的行)`。

    `kinds` 可限定只打断某几档。默认打断窄表里的全部形状 —— 那是消费方真的会
    解析的集合。

    `preserve_first=True`：**第一行原样保留**（`emit` 用 —— 它造的第一行本来就
    是「我们要的那条机器行」，打断它等于把自己发出去的命令行废掉）。
    其余行照常打断：body 里塞进来的伪造行不许借机成行。
    """
    parts = (text or "").splitlines(keepends=True)
    hits = []
    out = []
    for i, part in enumerate(parts, 1):
        body = _body(part)
        if not (preserve_first and i == 1) and _is_sharp(body):
            kind = _kind_of(body)
            if kinds is None or kind in kinds:
                out.append(GUARD + part)
                hits.append((i, kind, body))
                continue
        out.append(part)
    return "".join(out), tuple(hits)


def reject(value):
    """语言包值的装载期判据：返回**首个**伪造行 `(行号, 行正文)`，或 None。

    宽表：任何大写词 + 冒号开头的整行都算。**逐行**，不只是第一行 ——
    那正是此前漏掉的地方。

    ⚠️ 这里只用**两张明确的表**（`_BROAD` 管大写词+冒号，`_SHARP` 管消费方真的
    会解析的窄集），不是「所有 kind」。否则 `human_summary`（`=== … ===`，人读、
    要翻译）会被误判成伪造 —— 伪装成人读摘要行不是洞，消费方不解析它；伪装成
    **机器**摘要行才是（那条在 `_SHARP` 里）。
    """
    for i, ln in enumerate((value or "").splitlines(), 1):
        if _is_broad(ln) or _is_sharp(ln):
            return i, ln
    return None


# ── 自证 ──────────────────────────────────────────────────────────────────────

def _try_reject(value):
    """`reject` 对这条值必须报（反向断言用）。"""
    return reject(value) is not None


def _clean_has_no_row(value):
    """净化之后，任何一行都不再是消费方能解析的机器行。"""
    cleaned, _hits = clean(value)
    return not any(_is_sharp(ln) for ln in cleaned.splitlines())


def _emit_is_single_row(kind, body):
    """`emit` 出来的串：第一行是本 kind，其余行不是任何机器行。"""
    text = emit_summary(1, 0) if kind == "machine_summary" else emit(kind, body)
    rows = scan(text, keepends=True)
    return (len(rows) == 1 and rows[0][0] == 1 and rows[0][1] == kind)


def _packs_have_no_forgery():
    """**真包**逐值逐行过一遍宽表（不是夹具）—— 修复前这里对 `"x\\nOFF: y"` 是绿的。"""
    import i18n  # noqa: PLC0415
    import knobs  # noqa: PLC0415
    bad = []
    # **发现式**（`knobs.installed_langs()`），不是手写 ("zh","en","de") ——
    # 手写名录会让新装的语言包被静默跳过（C4：手写名录一定会漂）。
    for lang in sorted(knobs.installed_langs()):
        try:
            table = i18n.load_pack(lang)
        except Exception as e:                           # noqa: BLE001
            return [("load_failed", lang, e)]
        for code, value in sorted(table.items()):
            hit = reject(value)
            if hit:
                bad.append((lang, code, hit[0], hit[1][:40]))
    return bad


# 十个真实分行符逐个来 —— 少验一个就等于留一条缝
_BREAKS = [("\n", "LF"), ("\r", "CR"), ("\x0b", "VT"), ("\x0c", "FF"),
           ("\x1c", "FS"), ("\x1d", "GS"), ("\x1e", "RS"), ("\x85", "NEL"),
           ("\u2028", "LS"), ("\u2029", "PS")]


def _cases_clean():
    """① 正常不报：正当内容不许被净化的误伤。"""
    return [
        ("machine.clean_text_is_untouched",
         lambda: clean("all fine here")[0] == "all fine here"),
        # 正当多行：续行缩进，没有一行以机器形状开头（真包的形状）
        ("machine.legit_multiline_passes",
         lambda: reject("hint\n  set -a; . x; set +a") is None),
        # 正文**提到**契约串是正当内容（文案要能写「OFF: 不是失败」）
        ("machine.body_mention_is_fine",
         lambda: reject("`OFF:` is not a failure") is None),
        # 人读摘要行必须放行（它要翻译）
        ("machine.human_summary_is_not_machine",
         lambda: reject("=== gate.title.facts selftest: 18 PASS / 0 fail ===")
         is None),
    ]


def _cases_forgery():
    """② 该报的必须报：分行符 / 宽前缀 / note / 机器摘要，四类伪造。"""
    # ⚠️ 内层 lambda 由外层 `(lambda sep: …)(sep)` **立即求值**绑定，
    # 不是延迟捕获循环变量 —— ruff 的 B023 在这里是误报（它只看闭包形状，
    # 不看「是否立即调用」）。写成具名工厂同样正确，但会让这 10 条断言
    # 与其它断言形状不一致。
    per_sep = [("\u2605 machine.forgery_%s" % name,
                (lambda sep: lambda: _try_reject(
                    "ctx" + sep + "OFF: masquerading"))(sep))  # noqa: B023
               for sep, name in _BREAKS]
    return per_sep + [
        # 宽表：大写词+冒号都算保留前缀（语言包作者改个写法即可）
        ("\u2605 machine.broad_prefix_reserved",
         lambda: _try_reject("HTTP: 500")),
        # `note | ` —— 此前**完全**漏网（形状表里没有它）
        ("\u2605 machine.note_prefix",
         lambda: _try_reject("note | delegated")),
        # 机器摘要的**伪造**必须被认出（而人读摘要不许）
        ("\u2605 machine.machine_summary_is_machine",
         lambda: _try_reject("=== 9 PASS / 0 FAIL ===")),
    ]


def _cases_empty():
    """③ 空输入必须报 —— 「空」在这里有三种含义，逐条钉住。"""
    return [
        #  · 空**正文**发射：行还在（`OFF: `），不许塌成空串或丢掉行
        ("\u2605 machine.empty_body_keeps_the_row",
         lambda: emit("off", "") == "OFF: "),
        #  · 空值的语言包：`""` 本身不是伪造（那是「这条消息没写」，由
        #    `i18n._validate` 的 `pack_empty` 管）。判据不许把它当成机器行。
        ("machine.empty_value_is_not_a_forgery",
         lambda: reject("") is None),
        #  · 空输出扫描：零行 ⇒ 零个机器行（`run_phase` 据此判 ran 而非 off）
        ("\u2605 machine.empty_scan_reports_nothing",
         lambda: scan("") == ()),
    ]


def _cases_scrub():
    """净化通道：参数注入、幂等、不误伤、内部分隔符。"""
    return [
        # 参数通道：文件名带换行 ⇒ 净化后消费方解析不出机器行
        ("\u2605 machine.param_filename_neutralised",
         lambda: _clean_has_no_row("evil\nOFF: gate not configured.py")),
        ("\u2605 machine.off_concat_neutralised",
         lambda: _clean_has_no_row("OFF: a\nOFF: b: cfg")),
        # 净化**不误伤**窄表之外的内容（`HTTP: 500` 不是机器行，不许改写）
        ("machine.narrow_does_not_touch_http",
         lambda: clean("HTTP: 500 upstream")[0] == "HTTP: 500 upstream"),
        # `\` 前缀不会被 strip / 正则 ^ 还原（换成空格就会被 strip 吃掉）
        ("\u2605 machine.guard_survives_strip",
         lambda: clean("OFF: x")[0].strip().startswith(GUARD)),
        # 正文里合法的 \x0b 不许被 rstrip 连带剥掉
        ("machine.keeps_inner_separator_bytes",
         lambda: clean("a\x0bOFF: x")[0] == "a\x0b" + GUARD + "OFF: x"),
        # 幂等：已经净化的文本再净化一次不变
        ("machine.clean_is_idempotent",
         lambda: (lambda once: clean(once)[0] == once)(clean("OFF: x")[0])),
    ]


def _cases_emit():
    """输出保证：emit 造不出第二行机器行；摘要行精确；未知 kind 抛。"""
    return [
        ("\u2605 machine.emit_single_row",
         lambda: _emit_is_single_row("fail", "x\nOFF: y")),
        ("\u2605 machine.emit_summary_exact",
         lambda: emit_summary(3, 0) == "=== 3 PASS / 0 FAIL ==="),
        ("\u2605 machine.emit_unknown_kind_raises",
         lambda: _emit_unknown_kind_raises()),
        # scan 的行号与 kind 要准（消费方用它分类）
        ("machine.scan_reports_kind_and_line",
         lambda: scan("ok\nOFF: x\nok")[0][0] == 2
         and scan("ok\nOFF: x\nok")[0][1] == "off"),
    ]


def _cases():
    """自证：每条都是**实测过的洞**或**实测过的正当内容**。

    五组各是一个具名函数（净化 / 伪造 / 空输入 / 净化通道 / 输出保证）：
    80 行扁平清单里，「这是哪一类」只能靠注释分节读出来。
    """
    return (_cases_clean() + _cases_forgery() + _cases_empty()
            + _cases_scrub() + _cases_emit()
            + [("\u2605 machine.real_packs_have_no_forgery",
                lambda: _packs_have_no_forgery() == [])])


def _emit_unknown_kind_raises():
    try:
        emit("bogus", "x")
        return False
    except KeyError:
        return True


def _selftest():
    import sys  # noqa: PLC0415

    # ⚠️ 悬在**函数内**：`gate` 顶层导入本模块（机器行协议的消费方要用它），
    # 模块级 `from gate import ...` 会成环。与 `i18n.py` 同一个理由。
    from gate import main_selftest_or  # noqa: PLC0415
    from i18n import M  # noqa: PLC0415

    def _run(argv):
        # 本模块没有 CLI：它是纯函数库。跑成普通程序 ⇒ 明说怎么自证。
        print(M("machine.no_cli"), file=sys.stderr)
        return 0
    return main_selftest_or(sys.argv[1:], M("gate.title.machine"),
                            _cases, _run)


# ⚠️ 声明行**必须是这个字面形状**（`MODULE = module_meta(...)`）——
# `registry.modules()` 是 ast 解析，不执行代码；写成 `MODULE = _declare()` 或
# 放进 `if` 分支都收不到（实测：registry.real_modules_declared 当场红）。
# 成环问题用**懒导入**解决（见上方 `_selftest` 的注释），不是靠改写声明形状。
from gate import module_meta  # noqa: E402

MODULE = module_meta(
    "机器行协议",
    "「哪一行是机器行」的唯一产地：一张表 + scan/emit/clean/reject"
    "（生产、消费、语言包装载、渲染净化四条路径共用同一张表）",
    selftest=True)

if __name__ == "__main__":
    import os  # noqa: PLC0415
    import sys  # noqa: PLC0415
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import machine as _mod  # noqa: PLC0415
    sys.exit(_mod._selftest())

