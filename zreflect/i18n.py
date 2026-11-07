#!/usr/bin/env python3
"""消息模块：**本体零语言，语言包可选**（issue #26）。

设计前提（用户定的场景）：用户拉下 Einfacht 套件后，**从一堆包里挑一个语言包**——
英语、中文、或任何别的。本体本身**不做语言表达**，输出的是消息 code 与参数。
没装语言包时，输出 `code(key=v)` 这种**结构化、可读、无自然语言**的形式。

换句话说：**中文不是源语言**，中文只是可选包之一。这砍掉了传统 i18n 的两个组件：

  · 不需要「改中文文案强制重译」（没有中文可改，所有语言平等）；
  · 不需要 fallback chain / draft 状态（包要么装了要么没装）。

## interface

一个值对象 + 一个入口：

    Catalog.load(lang, tables=None) -> Catalog   # 装一个包；不在/坏了 ⇒ MissingPack
    Catalog.null()                               # null 包（只要 code + 参数）
    M(code, **params) -> Message                 # 唯一构造点；用**当前** Catalog

`Catalog` 是**不可变值**：语言名 + 那张表。所有规则（三条路径口径、两种包形状、
坏包必抛、空包拒绝、契约串不可伪装）都关在 `Catalog.load` / `load_pack` 里 ——
调用方与自证**跨同一个缝**（`Catalog`）。

`M` 的签名与返回形状没变（`Message` 是 `str` 子类，值即渲染结果，另有
`.code` / `.params`），所以全部调用点**零改动**。

## 为什么不是模块级可变状态

此前用 `_ACTIVE = [(lang, table)]` 这种模块级可变槽：`activate()` 写它、`M()` 读它。
两个具体病害：

  · **「谁渲染」没有作用域** —— 自证必须手动 `bind()` 进出还原，忘了就污染后续用例；
  · **模块对象会分裂** —— `i18n.py` 作为脚本运行时，`__main__` 与 `import i18n`
    是**两个模块对象**，状态各自一份（实测：en 模式打出裸 code）。

现在作用域是显式的值（`bind(cat)` 纯作用域），进程默认只留一个 `_DEFAULT` 槽。

契约字面量（`OFF:` / `FATAL:` / `=== N PASS / M FAIL ===` / `PASS | ` / `DOWN: `）
**在发射点用字面量**，不在数据里 —— 语言包**结构上不可能**产出它们（`_validate`）。

诚实边界：自证用例标签按用户决策（1C）**id 化**——自证输出是可机器读的 code。
"""
from __future__ import annotations

import os
from types import MappingProxyType

# `machine` 只依赖标准库 ⇒ 无环。装载期判据与渲染期净化都从它来。
import machine  # noqa: E402


# ⚠️ **懒取**：本模块被 `gate` 懒导入，模块级反向 `import gate` 会成环。
# 值本身由 `gate.zdir()` / `gate.tool_repo()` 唯一生产 —— 不在这里再算一遍。
def _tool_dir():
    import gate  # noqa: PLC0415
    return gate.zdir()


def _tool_repo_dir():
    import gate  # noqa: PLC0415
    return gate.tool_repo()
# 未设 `REFLECT_I18N` 时用的**内建包目录**（相对工具仓根）。
BUILTIN_PACKS = "zreflect/lang"

# 契约前缀的判据现在**只在一个地方**：`machine.REJECT` 那张表（逐行判）。
# 此前这里有一份 `_CONTRACT_SHAPES`，用 `^` 锚定的 `.match()` **只判第一行** ——
# 一条 `"ctx\nOFF: x"` 的语言包值因此被接受，渲染后自成一行 `OFF:`，
# `run_phase` 就把它归类成 `off`（实测，十个分行符全中）。同一张表还要被
# 生产方（`gate.off`）、消费方（`gate.run_phase`）与 shell 消费者共用 ——
# 七份拷贝必漂（C4）。见 `zreflect/machine.py`。

# 中日韩统一表意文字区间。「这一行里有没有中文」是**零语言制度的判据**，
# 所以它住在制度持有者这里（`check_i18n` 与 `harness` 都从这里取，
# 不再各写一份区间常量 —— C4）。
CJK_LO, CJK_HI = 0x4E00, 0x9FFF


def han(text):
    """含中日韩统一表意文字？"""
    return any(CJK_LO <= ord(c) <= CJK_HI for c in (text or ""))


_MAX_VALUE = 40            # null 包里单个值最多显示多少字符（长命令不撑屏）


# ── 值对象 ────────────────────────────────────────────────────────────────────

class MissingPack(Exception):
    """语言包装配问题（缺失 / 损坏 / 形状非法）。调用方转 FATAL rc 2。

    **携带 `(code, params)` 而不是拼好的句子**（issue #26 的硬要求：`REFLECT_LANG=en`
    时给用户看的任何东西都不许是中文）。

    `str(e)` 是**机器可读**的 code 形状；`e.code` / `e.params` 可用于判据。

    ## 一条豁免：**装载期**的形状错误可以用本包自己渲染

    `Catalog.load` 在 `_validate` 之前就已经把合并表读出来了，所以「这条值伪装成
    机器行」这类错误**有包可查** —— 说 null 形状（裸 code）是没必要的可读性损失
    （review 抓出来的：`REFLECT_LANG=zh` 下这条 FATAL 渲染成裸 code）。
    其它错误（包缺失 / 分片坏）**确实**没有表可查 ⇒ 继续用 null 形状。
    """

    def __init__(self, code, **params):
        table = params.pop("_table", None)      # `_table` 不是消息参数
        self.code = code
        self.params = params
        super().__init__(_render(code, params, table))


class Catalog:
    """一个**已装配好的语言包**（不可变值）：`lang` 是身份，`table` 是数据。

    `table=None` ⇒ null 包（本体零语言：只输出 code 与参数）。
    """

    __slots__ = ("lang", "table")

    def __init__(self, lang, table, _sealed=False):
        # ⚠️ `_sealed` 是**构造闸**：`Catalog` 只能由 `null()` / `load()` 造，
        # 因为 `_validate`（契约串防线）只在 `load()` 里执行。此前直接
        # `Catalog("xx", {"a.b": "OFF: masquerading"})` 能绕过校验并让一条
        # 伪装成机器行的值真的渲出去（实测）。外部构造一律拒绝。
        if not _sealed:
            raise TypeError(
                "Catalog 只能由 Catalog.null() / Catalog.load() 构造"
                "（校验在 load 里，绕过去就等于关掉契约串防线）")
        object.__setattr__(self, "lang", lang)
        object.__setattr__(self, "table", table)

    # 不可变：`Catalog` 是值，谁都不能改它的表 —— 改了会让「同一个包」在不同
    # 时刻渲染出不同东西，那正是本仓要消灭的不确定性。
    def __setattr__(self, name, value):
        raise AttributeError("Catalog is immutable")

    @classmethod
    def null(cls):
        """null 包：没有语言，只输出 `code(key=value)`。"""
        return cls(None, None, _sealed=True)

    @classmethod
    def load(cls, lang, tables=None):
        """装一个包。`lang=None` ⇒ null 包；给了名字但装不上 ⇒ `MissingPack`。

        这是**唯一的装配点**（夹具注入走 `tables=`，零文件 I/O）。
        """
        if lang is None:
            return cls.null()
        if tables is not None:
            table = tables.get(lang)
            if table is None:
                raise MissingPack("i18n.injected_lang_absent", lang=lang)
        else:
            table = load_pack(lang)
            if not table:
                base = pack_dir()
                raise MissingPack("i18n.pack_absent", lang=lang,
                                  single=os.path.join(base, "%s.json" % lang),
                                  directory=os.path.join(base, lang))
        _validate(table, lang)
        # ⚠️ 存**不可变副本**：`__slots__` + `__setattr__` 只挡住「换掉引用」，
        # 挡不住原地改字典 —— 实测 `cat.table['locks.ok']='HAHA'` 成功，且后续
        # 渲染全错。`Catalog` 是**值**，它的数据必须真不可变
        # （`MappingProxyType` 是只读视图，且不复制、不增开销）。
        return cls(lang, MappingProxyType(dict(table)), _sealed=True)

    def render(self, code, params):
        """把 (code, params) 渲成文本；这张表里没有该 code ⇒ null 形状。

        降级成 code 是**唯一诚实**的选择（不许编句子），但它**必须**被闸门
        抓住：`knobs.pack_coverage_problems()` 保证「源码用到的 code 在每个
        已装包里都有」。降级只在这一处，判据在外面 —— 与 `_validate` 分工。
        """
        return _render(code, params, self.table)

    def msg(self, code, **params):
        """按本 Catalog 构造一条 `Message`（值已渲好）。"""
        return Message(code, params, self)


class Message(str):
    """一条消息。**值是渲染结果**，`.code` / `.params` 是身份与数据。

    str 子类是有意为之：`finish()`/`if problems`/`"  · " + p`/`len(...)` 这些
    现有消费者全部继续工作。
    """

    __slots__ = ("code", "params", "forged")

    def __new__(cls, code, params, catalog):
        # ⚠️ **渲染后净化**：模板干净不代表渲染结果干净 —— 参数（文件名、文档行、
        # 异常文本）是运行时数据，144 个调用点把它们以 `%s` 填进模板，而 58 个
        # 模板以占位符开头（`%(name)s: …`）。实测：扫到名为
        # `"evil\nOFF: gate not configured"` 的文件时，渲染出来就是一个伪造的
        # `OFF:` 行，`run_phase` 会把整道闸门归类成 off。
        #
        # 语言包装载期**拒绝**，渲染期**只净化** —— 一个跑到一半的闸门因为
        # 文件名带换行而崩，是把作者管不了的东西变成事故。
        #
        # ⚠️ **渲染只做一次**：`.forged` 的值在 `__new__` 里算好挂到实例上，
        # `__init__` 只读它。此前两个方法各调一次 `catalog.render()` +
        # `machine.clean()` —— 一条消息渲染两遍（review 抓出来的）。
        raw = catalog.render(code, params)
        text, forged = machine.clean(raw)
        obj = super().__new__(cls, text)
        obj.forged = forged
        return obj

    def __init__(self, code, params, catalog):
        self.code = code
        self.params = params


def _fmt_value(v):
    """null 包里一个参数值怎么显示。

    用 `repr`：它**自动处理引号嵌套**（`find . -name '*.md'` 会被渲成
    `"find . -name '*.md'"`），手拼 `'%s'` 会在值内含引号时产出畸形串
    （实测踩到：`command='find . -name '*.md' | wc -l'`）。长值截断。
    """
    s = repr(v)
    if len(s) > _MAX_VALUE:
        s = s[:_MAX_VALUE - 1] + "…" + s[-1] if s[-1] in "\"'" else s[:_MAX_VALUE] + "…"
    return s


def _render(code, params, table):
    """把 (code, params) 渲染成文本。`table=None` ⇒ null 包形状。

    null 包的格式：`code(key='py_lines', actual=6180, expected=6014)`。
    **参数名必须是完整的英文单词**（`key` 不是 `k`，`actual` 不是 `got`）——
    这是 null 包唯一「可读」的来源：没有句子，但名字能自解释。

    无参数时只打 code。**不加安装提示**（那本身是自然语言，违背零语言）。
    """
    if table is not None and code in table:
        return table[code] % params
    if not params:
        return str(code)
    inner = ", ".join("%s=%s" % (k, _fmt_value(params[k]))
                      for k in sorted(params))
    return "%s(%s)" % (code, inner)


def _validate(table, lang):
    """校验语言包形状：值不许伪装成机器行（契约结构上不可被翻译）。

    ⚠️ **逐行**判（`machine.reject`），不是只看首行 —— 此前 `^` 锚定的 `.match()`
    只看第一行，于是 `"ctx\\nOFF: x"` 被接受、渲染后自成一行 `OFF:`（实测，
    十个分行符全中）。语言包是**静态**资产，作者改个写法就能修好 ⇒ 这里
    **大声拒绝**（FATAL rc 2），不像渲染输出那样只净化。
    """
    if not isinstance(table, dict) or not table:
        raise MissingPack("i18n.pack_empty", lang=lang)
    for code, value in table.items():
        if not isinstance(value, str):
            raise MissingPack("i18n.value_not_string", lang=lang, key=code)
        hit = machine.reject(value)
        if hit:
            # 这句错误文案住在**当前进程已装好的包**里（`_DEFAULT`），不在
            # 正在校验的这张表里 —— 后者只可能含那条坏值。取当前 Catalog 的表
            # 渲染，读不到就退回 null 形状（诚实，不编）。
            cur = _DEFAULT[0].table if _DEFAULT else None
            raise MissingPack("i18n.value_masquerades_contract", _table=cur,
                              lang=lang, key=code, line=hit[0],
                              value=value[:40])


# ── 包位置与读取（全仓唯一解析点）────────────────────────────────────────────

def pack_dir():
    """语言包目录的绝对路径 —— **全仓唯一的解析点**。三条口径：

      · **未设 `REFLECT_I18N`** ⇒ 套件自带的内建包 `BUILTIN_PACKS`，锚在
        **工具仓根**（「拉了套件就能用」；跨仓夹具靠它 —— 锚成 GATE_REPO 相对
        时夹具里每个闸门都 MissingPack，实测 0/15 全红）。
      · **设了相对路径** ⇒ 相对**被检查仓根**（`GATE_REPO`）。与 `REFLECT_DOCS`
        等名字型旋钮同口径 —— env 里写的「相对仓库根的名字」才对得上。
      · **设了绝对路径** ⇒ 原样。
    """
    raw = os.environ.get("REFLECT_I18N", "").strip()
    if not raw:
        return os.path.join(_tool_repo_dir(), BUILTIN_PACKS)
    if os.path.isabs(raw):
        return raw
    # 懒导入：本模块被 `gate` 懒导入，模块级反向 import 会成环。
    import gate  # noqa: PLC0415
    return os.path.join(gate.GATE_REPO, raw)


def _load_shards(base, lang):
    """`<lang>/*.json` 分片（按命名空间分文件，并行开发用，后者覆盖同 code）。

    ⚠️ **坏 JSON 不许静默跳过**：此前 `except: continue`，一个坏分片只让那部分
    code 退回裸 code 而 **rc 仍 0** —— 「半装看起来像装好了」（实测）。
    现在坏分片 / 非对象一律抛 `MissingPack`。
    """
    import json  # noqa: PLC0415
    d = os.path.join(base, lang)
    if not os.path.isdir(d):
        return {}
    table = {}
    for n in sorted(os.listdir(d)):
        if not n.endswith(".json"):
            continue
        p = os.path.join(d, n)
        try:
            with open(p, encoding="utf-8") as fh:
                part = json.load(fh)
        except (OSError, ValueError) as e:
            raise MissingPack("i18n.shard_unreadable", lang=lang,
                              path=p, error=e) from e
        if not isinstance(part, dict):
            raise MissingPack("i18n.shard_not_object", lang=lang, name=n)
        table.update(part)
    return table


def _load_single(base, lang):
    """`<lang>.json` 单文件（小仓 / 样板）。坏文件同样抛 `MissingPack`。"""
    import json  # noqa: PLC0415
    single = os.path.join(base, "%s.json" % lang)
    if not os.path.exists(single):
        return {}
    try:
        with open(single, encoding="utf-8") as fh:
            part = json.load(fh)
    except (OSError, ValueError) as e:
        raise MissingPack("i18n.single_unreadable", lang=lang,
                          path=single, error=e) from e
    if not isinstance(part, dict):
        raise MissingPack("i18n.single_not_object", lang=lang, path=single)
    return part


def load_pack(lang):
    """读语言包的**合并表**（与 `Catalog.load` 看到的那张表一致）。

    两种形状都认，且**总是合并**：`<lang>/*.json` 分片 + `<lang>.json` 单文件
    （后者覆盖同 code）。

    合并必须与真装载器同形 —— 任何只读一个分片的读者都会与装载器分叉
    （实测踩到：自证按分片读，文档认可的单文件包被判红）。

    缺失 / 空 ⇒ `{}`（不抛）：自证「读真包」的断言靠空表当场红。区分的是
    「没有」与「有但坏了」：后者是配置事故，必须响。

    两种形状各是一个 helper（`_load_shards` / `_load_single`）：它们各有
    自己的错误码（`shard_*` / `single_*`），拼在一起时那两组 try/except
    让「哪个码对应哪种形状」变成读代码才能知道的事。
    """
    base = pack_dir()
    table = _load_shards(base, lang)
    table.update(_load_single(base, lang))
    return table


# ── 入口：当前 Catalog（进程默认）与作用域 ────────────────────────────────────

NULL = object()                 # 「显式要 null 包」的哨兵（区别于「没传」）
_DEFAULT = [Catalog.null()]     # 进程默认（`activate` 写；`bind` 不动它）


def _resolve_lang(lang):
    """`lang` → 生效的语言名（None = null 包）。**唯一的体检点**。

    `NULL` ⇒ 显式 null（不吃环境变量）；`None` ⇒ 回落 `REFLECT_LANG`；
    字符串 ⇒ 原样。`bind()` / `activate()` 都走这里。
    """
    if lang is NULL:
        return None
    if lang is not None:
        return lang
    return os.environ.get("REFLECT_LANG", "").strip() or None


def _acquire(lang=None, tables=None):
    """`lang` → 一个装配好的 `Catalog`（`NULL` / `None` 都可能是 null 包）。"""
    return Catalog.load(_resolve_lang(lang), tables)


def _current():
    """当前生效的 Catalog（进程默认）。"""
    return _DEFAULT[0]


def M(code, **params):
    """构造一条消息，用**当前** Catalog。`code` 必须是字面量（覆盖闸门会拒
    变量 code —— 否则目录无法被证明完备）。"""
    return _current().msg(code, **params)


class _Bound:
    """`bind()` 的上下文：换当前 Catalog，出作用域即还原（可重入）。"""

    def __init__(self, catalog):
        self.catalog = catalog
        self.prev = None

    def __enter__(self):
        self.prev = _DEFAULT[0]
        _DEFAULT[0] = self.catalog
        return self.catalog

    def __exit__(self, *exc):
        _DEFAULT[0] = self.prev
        return False


def bind(catalog):
    """装一个 Catalog（上下文管理器，**纯作用域**：不写环境、不动默认）。

    `catalog` 可以是 `Catalog`、语言名，或 `NULL` 哨兵：

        with bind("zh"): ...
        with bind(NULL): ...                                # 显式 null（不吃环境变量）
        with bind(Catalog.load("en", tables={...})): ...     # 注入（零文件 I/O）
    """
    if isinstance(catalog, Catalog):
        return _Bound(catalog)
    return _Bound(_acquire(catalog))


def activate(lang=None, tables=None):
    """进程级默认（CLI 入口调一次）。返回生效的语言名（None = null 包）。

    与 `bind()` 的区别：`bind` 是**作用域**（进出即还原）；`activate` 是
    **进程默认**（一次到位，不用每处写 `with`）。

    `lang=NULL` 与 `bind` 同义：显式 null 包（不吃 `REFLECT_LANG`）。
    包不在 / 坏了 ⇒ `MissingPack`（由 `gate.activate_or_fatal` 转 FATAL rc 2）。
    """
    cat = _acquire(lang, tables)
    _DEFAULT[0] = cat
    return cat.lang


# ── 自证 ──────────────────────────────────────────────────────────────────────

def _raises(fn):
    """这条调用必抛 MissingPack（反向断言用）。"""
    try:
        fn()
    except (MissingPack, SystemExit):
        return True
    return False


def _scoped(catalog, fn):
    """在 catalog 作用域里跑 fn（进出即还原）。"""
    b = bind(catalog)
    b.__enter__()
    try:
        return fn()
    finally:
        b.__exit__(None, None, None)


def _as_null(fn):
    """在**显式 null** 作用域里跑 fn。

    ⚠️ 形状判据必须自带 null 作用域：入口 `activate()` 一旦把 zh / en 设上，
    直接读 `M(...)` 的用例就全红（实测 `REFLECT_LANG=zh gates-selftest.sh`
    下 KeyError）—— 断言没声明作用域，就成了「跑在什么环境就考什么」。
    """
    return _scoped(NULL, fn)


def _construct_sealed():
    """外部直接构造 `Catalog` 必须被拒（只能走 null() / load()）。"""
    try:
        Catalog("xx", {"a.b": "OFF: masquerading"})
        return False          # 居然构造成功 = 这条红
    except TypeError:
        return True


def _cases_fixture():
    """夹具（原 `_cases` 的前置段原样搬入）。"""
    fake = {
        # 占位名必须与**真包**一致（`key` / `actual` / `expected`）：
        # 写成缩写会让这条自证为一个真包不用的命名方案背书（实测 KeyError）。
        "replay.no_cmd": "`%(key)s` has no replay command",
        "replay.mismatch": "`%(key)s` replay != ledger: %(actual)s vs %(expected)s",
    }
    bad_shape = {"ok": "OFF: not configured"}          # 伪装成机器行
    empty = {}

    en_cat = Catalog.load("en", {"en": fake})

    def with_en(fn):
        return _scoped(en_cat, fn)

    def said(**params):
        return _as_null(lambda: str(M("probe.code", **params)))

    return {'fake': fake, 'bad_shape': bad_shape, 'empty': empty, 'en_cat': en_cat, 'with_en': with_en, 'said': said}


def _cases_null(fx):
    """见 `_cases()`：本组 7 条。"""
    said = fx["said"]
    return [
    # ① 正常不报 —— null 包形状
    ("i18n.null_no_params",
     lambda: _as_null(lambda: str(M("gate.title.facts"))
                     == "gate.title.facts")),
    ("i18n.null_with_params",
     lambda: _as_null(lambda: str(M("replay.no_cmd", key="py_lines"))
                     == "replay.no_cmd(key='py_lines')")),
    ("i18n.null_params_sorted",
     lambda: _as_null(lambda: str(M("x", bb=2, aa=1)) == "x(aa=1, bb=2)")),
    # `repr` 必须处理引号嵌套：手拼 `'%s'` 在值内带引号时产出畸形串。
    ("★ i18n.repr_quotes",
     lambda: (lambda s: s.count("'") >= 2 and s.startswith("probe.code("))(
         said(command="find . -name '*.md' | wc -l"))),
    ("i18n.null_long_value_truncated",
     lambda: len(said(cmd="f" * 200)) < 80),
    # `NULL` 哨兵在 `bind` / `resolve` / `activate` 三个入口语义一致。
    ("★ i18n.null_sentinel_consistent", lambda: _null_consistent()),
    # ③ 空输入必须报
    ("★ i18n.empty_code",
     lambda: _as_null(lambda: str(M("")) == "")),
    ]


def _cases_pack(fx):
    """见 `_cases()`：本组 7 条。"""
    bad_shape, empty, with_en = fx["bad_shape"], fx["empty"], fx["with_en"]
    return [
    ("i18n.pack_applied",
     lambda: with_en(lambda: str(M("replay.no_cmd", key="f.py"))
                     == "`f.py` has no replay command")),
    # ② 该报的必须报
    ("★ i18n.pack_empty",
     lambda: _raises(lambda: _validate(empty, "xx"))),
    ("★ i18n.pack_masquerades_contract",
     lambda: _raises(lambda: _validate(bad_shape, "xx"))),
    # 缺失的语言包必须**报**，不是静默回落中文。
    ("★ i18n.missing_pack_raises",
     lambda: _raises(lambda: Catalog.load("xx", {"zh": {}}))),
    # 空包不是「已翻译」（零值守卫第一档）。
    ("★ i18n.empty_pack_rejected",
     lambda: _raises(lambda: Catalog.load("xx", {"xx": {}}))),
    # **坏分片必须当场抛**：静默跳过的后果是那部分消息退回裸 code 而 rc 仍 0。
    ("★ i18n.broken_shard_raises",
     lambda: _broken_pack_raises()),
    # `pack_dir` 三条口径的机器判据（最显眼的契约，此前零自证）。
    ("★ i18n.pack_dir_three_rules", lambda: _pack_dir_rules_ok()),
    ]


def _cases_catalog(fx):
    """见 `_cases()`：本组 6 条。"""
    fake = fx["fake"]
    return [
    ("i18n.message_is_str",
     lambda: (lambda m: (bool([m]), "  · " + m, len([m]))[0] is True)(M("a"))),
    # `.code` / `.params` 是身份，与语言无关。得在 null 下构造
    # （`Message` 构造时就渲染：捏造的 code 撞真包会 KeyError）。
    ("i18n.code_readable",
     lambda: _as_null(lambda: M("replay.no_cmd", key=1).code
                     == "replay.no_cmd")),
    ("i18n.params_readable",
     lambda: _as_null(lambda: M("replay.no_cmd", key="py_lines").params
                     == {"key": "py_lines"})),
    ("i18n.activate_sets_default",
     lambda: _activate_ok("en", {"en": fake})),
    # **`Catalog` 的数据必须真不可变**：`__slots__` + `__setattr__` 只挡
    # 属性赋值，挡不住原地改字典（实测 `cat.table[...]=...` 成功且渲染全错）。
    ("★ i18n.catalog_data_immutable", lambda: _catalog_immutable()),
    # **构造闸**：`Catalog(…)` 不能被外部直接造 —— 那会绕过 `load()` 里的
    # `_validate`（契约串防线），让一条伪装成 `OFF:` 的译文真的渲出去（实测）。
    ("★ i18n.catalog_construct_sealed", lambda: _construct_sealed()),
    ]


def _cases():
    """拼装 3 组夹具断言。**只拼装** —— 判据在各分组函数里。"""
    fx = _cases_fixture()
    return (
    _cases_null(fx)
    + _cases_pack(fx)
    + _cases_catalog(fx)
    )


def _catalog_immutable():
    """`Catalog` 的表不许被原地修改（属性赋值与字典写入都必须失败）。"""
    cat = Catalog.load("en", {"en": {"a.b": "ok"}})
    try:
        cat.lang = "zh"
        return False                  # 属性赋值居然成功 = 这条红
    except AttributeError:
        pass
    try:
        cat.table["a.b"] = "changed"
        return False                  # 原地改字典成功 = 这条红
    except TypeError:
        pass
    return str(cat.msg("a.b")) == "ok"


def _activate_ok(lang, tables):
    """`activate()` 后 `M()` 是否按该包渲染（用完还原）。"""
    prev = _DEFAULT[0]
    try:
        activate(lang, tables)
        return str(M("replay.no_cmd", key="f.py")) == "`f.py` has no replay command"
    finally:
        _DEFAULT[0] = prev


def _null_consistent():
    """`NULL` 哨兵在 `bind` / `resolve` / `activate` 三个入口语义一致。

    ⚠️ **必须先把 `REFLECT_LANG` 设上再验**：此前这条在默认（未设）环境下
    即使 `resolve(NULL)` 错误地回落环境变量也照样绿 —— 那是「跑在什么环境就
    考什么」的洗白形态（实测：env 未设 → True，env=zh → False）。断言自己
    造出**能让它红**的环境，而不是等外部环境赏脸。
    """
    prev = _DEFAULT[0]
    saved_env = os.environ.get("REFLECT_LANG")
    try:
        # 造出「有环境变量」这个能让 NULL 逻辑出错的条件
        os.environ["REFLECT_LANG"] = "zh"
        if _resolve_lang(NULL) is not None:
            return False
        with bind(NULL) as cat:
            if cat.lang is not None or cat.table is not None:
                return False
            if str(M("probe.code", key="x")) != "probe.code(key='x')":
                return False
        return activate(NULL) is None and _current().lang is None
    finally:
        _DEFAULT[0] = prev
        if saved_env is None:
            os.environ.pop("REFLECT_LANG", None)
        else:
            os.environ["REFLECT_LANG"] = saved_env


def _broken_pack_raises():
    """坏分片必须抛 `MissingPack`，不许静默跳过（临时目录，用完即删）。"""
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    try:
        os.makedirs(os.path.join(d, "xx"))
        with open(os.path.join(d, "xx", "bad.json"), "w",
                  encoding="utf-8") as fh:
            fh.write("{ not json")
        prev = os.environ.get("REFLECT_I18N")
        os.environ["REFLECT_I18N"] = d
        try:
            try:
                load_pack("xx")
            except MissingPack:
                return True
            return False           # 静默跳过 = 这条断言红
        finally:
            if prev is None:
                os.environ.pop("REFLECT_I18N", None)
            else:
                os.environ["REFLECT_I18N"] = prev
    finally:
        shutil.rmtree(d, True)


def _pack_dir_rules_ok():
    """`pack_dir()` 的三条口径逐条验（每条都是踩过的坑，别只验一条）。"""
    import gate  # noqa: PLC0415
    prev = os.environ.get("REFLECT_I18N")
    try:
        env = os.environ
        # ① 未设 ⇒ 工具自带的包目录（跨仓夹具靠它）
        env.pop("REFLECT_I18N", None)
        if not os.path.isdir(pack_dir()):
            return False
        # ② 绝对路径 ⇒ 原样（不拼任何前缀）
        probe = os.path.abspath(os.sep)
        env["REFLECT_I18N"] = probe
        if pack_dir() != probe:
            return False
        # ③ 相对路径 ⇒ **被检查仓根**。必须把两个仓根**真的分开**才能验：
        #    不设 GATE_REPO 时两者同值，错口径也能过（实测踩到）。
        env["REFLECT_I18N"] = "rel/probe"
        saved = gate.GATE_REPO
        gate.GATE_REPO = os.sep + "tmp-probe-repo"
        try:
            return pack_dir() == os.path.join(gate.GATE_REPO, "rel/probe")
        finally:
            gate.GATE_REPO = saved
    finally:
        if prev is None:
            os.environ.pop("REFLECT_I18N", None)
        else:
            os.environ["REFLECT_I18N"] = prev


def _selftest():
    import sys  # noqa: PLC0415

    from gate import main_selftest_or  # noqa: PLC0415

    def _run(argv):
        # 走 M()：`REFLECT_LANG=en` 下这条也必须说英语。
        print(M("i18n.module_banner"), file=sys.stderr)
        return 2
    return main_selftest_or(sys.argv[1:],
                            M("gate.title.i18n"), _cases, _run)


from gate import module_meta  # noqa: E402

MODULE = module_meta("i18n", "本体零语言 + 语言包可选（Catalog/M/bind/acquire）",
                     selftest=True)

if __name__ == "__main__":
    import sys  # noqa: PLC0415
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    # ⚠️ 不能直接 `sys.exit(_selftest())`：本文件作为**脚本**运行时，这份代码是
    # `__main__`，而 `gate.activate_or_fatal` 里 `import i18n` 加载的是**另一个
    # 模块对象**（同名模块副本）。`_DEFAULT` 是模块级状态 ⇒ 激活设在副本上、
    # 渲染读 `__main__` 的 ⇒ 永远 null 包。委派给模块副本，两边就是同一个对象。
    import i18n as _mod  # noqa: PLC0415
    sys.exit(_mod._selftest())
