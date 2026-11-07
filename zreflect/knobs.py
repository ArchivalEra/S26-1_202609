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

import gate  # noqa: E402
from gate import module_meta  # noqa: E402
from i18n import NULL, Catalog, M, bind, load_pack, pack_dir  # noqa: E402


class _Semantic(str):
    """旋钮的一行语义（`REGISTRY` 第三项）：**延迟渲染**的用户可见文本。

    `REGISTRY` 在 import 时构造，而语言包在入口 `main_selftest_or` 里才
    `activate()` —— 若这里直接 `M(...)`，值会在构造时就渲染并**永远停在
    null 包**上（实测形状：zh 用户看到的是 code 而不是语义）。所以保存 code，
    `__str__` 时按**当前**语言重渲（消费方只用 `%(entry)s` 格式化它，
    见 check_envfile 的 file_missing / dir_missing 消息）。
    """

    __slots__ = ("code",)

    def __new__(cls, code):
        obj = str.__new__(cls, code)
        obj.code = code
        return obj

    def __str__(self):
        return str(M(self.code))


# 名字 → (kind, 默认值, 一句话语义)。默认值 = 旋钮未配时各消费方的回落名。
# 语义按本体零语言（issue #26）：code 进语言包，本体不写自然语言。
REGISTRY = {
    "REFLECT_FACTS": ("file", "FACTS.json",
                      _Semantic("knobs.sem.reflect_facts")),
    "REFLECT_DOC": ("file", "STATE.md",
                    _Semantic("knobs.sem.reflect_doc")),
    "REFLECT_DOCS": ("list", "STATE.md,AGENTS.md,PRINCIPLES.md,README.md,README.zh.md,README.de.md",
                     _Semantic("knobs.sem.reflect_docs")),
    "REFLECT_HISTORY_SECS": ("value", "",
                             _Semantic("knobs.sem.reflect_history_secs")),
    "REFLECT_RETIRED": ("value", "",
                        _Semantic("knobs.sem.reflect_retired")),
    "REFLECT_NAKED_MIN": ("number", "100",
                          _Semantic("knobs.sem.reflect_naked_min")),
    "REFLECT_STALE_DAYS": ("number", "",
                           _Semantic("knobs.sem.reflect_stale_days")),
    "REFLECT_REPLAY": ("flag", "",
                       _Semantic("knobs.sem.reflect_replay")),
    "REFLECT_REPLAY_TIMEOUT": ("number", "10",
                               _Semantic("knobs.sem.reflect_replay_timeout")),
    "REFLECT_READMES": ("list", "README.md,README.zh.md,README.de.md",
                        _Semantic("knobs.sem.reflect_readmes")),
    "REFLECT_RETRACTIONS": ("file", "retractions.json",
                            _Semantic("knobs.sem.reflect_retractions")),
    "REFLECT_QUESTIONS": ("dir", "questions",
                          _Semantic("knobs.sem.reflect_questions")),
    "REFLECT_ENV_FILE": ("value", "Einfacht.env",
                         _Semantic("knobs.sem.reflect_env_file")),
    "REFLECT_ENV_HINT": ("flag", "",
                         _Semantic("knobs.sem.reflect_env_hint")),
    "REFLECT_INVARIANTS": ("file", "",
                           _Semantic("knobs.sem.reflect_invariants")),
    "REFLECT_INSTRUMENTS": ("file", "",
                            _Semantic("knobs.sem.reflect_instruments")),
    "REFLECT_INSTRUMENT_DAYS": ("number", "",
                                _Semantic("knobs.sem.reflect_instrument_days")),
    "REFLECT_DOCTOR": ("file", "doctor.json",
                       _Semantic("knobs.sem.reflect_doctor")),
    "REFLECT_DOCTOR_TIMEOUT": ("number", "2",
                               _Semantic("knobs.sem.reflect_doctor_timeout")),
    "REFLECT_WORLD": ("file", "world.json",
                      _Semantic("knobs.sem.reflect_world")),
    "REFLECT_WORLD_LINE": ("value", "",
                           _Semantic("knobs.sem.reflect_world_line")),
    "REFLECT_AB": ("file", "ab.json",
                   _Semantic("knobs.sem.reflect_ab")),
    "REFLECT_PINS": ("file", "pins.json",
                     _Semantic("knobs.sem.reflect_pins")),
    "REFLECT_LOCKS": ("file", "upstream-lock.json",
                      _Semantic("knobs.sem.reflect_locks")),
    "REFLECT_MEASURE_MODULE": ("value", "",
                               _Semantic("knobs.sem.reflect_measure_module")),
    "REFLECT_PHASES": ("value", "",
                       _Semantic("knobs.sem.reflect_phases")),
    # 明确拒绝本套件的原则（不想每提交跑那些判定命令的仓用这个出口）。
    "REFLECT_NO_PRINCIPLES": ("flag", "",
                              _Semantic("knobs.sem.reflect_no_principles")),
    "REFLECT_LANG": ("value", "",
                     _Semantic("knobs.sem.reflect_lang")),
    "REFLECT_I18N": ("dir", "",
                     _Semantic("knobs.sem.reflect_i18n")),
    "REFLECT_I18N_ROOT": ("dir", "",
                          _Semantic("knobs.sem.reflect_i18n_root")),
    "REFLECT_SNAPSHOT_ROOT": ("dir", "",
                              _Semantic("knobs.sem.reflect_snapshot_root")),
}

KINDS = ("file", "list", "dir", "number", "flag", "value")


def knobs_table(rows=None):
    """旋钮名录的**人读表**（`--list` 的输出）。**纯函数**。

    语义走 `_Semantic`（`str()` 会按当前语言包渲染）；未装语言包时输出
    `knobs.sem.<name>` 这种 code —— 那是诚实的「没装语言包」。
    """
    rows = REGISTRY if rows is None else rows
    lines = ["| knob | kind | default | meaning |", "|---|---|---|---|"]
    for name in sorted(rows):
        kind, default, sem = rows[name]
        lines.append("| `%s` | %s | %s | %s |"
                     % (name, kind, default or "—", sem))
    return "\n".join(lines)

# 占位符记号（`%(name)s`）—— 自证对账 zh / en 的占位符名是否一致。
_PLACEHOLDER_RE = re.compile(r"%\((\w+)\)")

# 旋钮记号：REFLECT_ + 大写。**左边界必需** —— 不加时，翻案示例文本
# （`ZCODE_` 前缀 + 一个记号）会被从中间切成假记号，三语 README 对账
# 各报一次假阳性（实测踩到）。⚠️ 本文件里**不写出**那个假记号字面量。
_TOKEN_RE = re.compile(r"(?<![A-Za-z0-9_])REFLECT_[A-Z0-9_]+")


def _py_sources(base):
    """见 `gate.py_sources`：实现只有一处（此处只保留本模块的名字）。"""
    import gate  # noqa: PLC0415
    return gate.py_sources(base)


def scan_surface_problems(py_dir=None):
    """扫描面（zreflect/*.py）里出现、登记表里没有的 REFLECT_* 记号。

    **名册自洽性**，与任何载体（Einfacht.env）是否存在无关 —— 它属于
    「名册」本身（C3）：此前这条判据焊在 check_envfile.run() 的
    「载体存在」前置之后，本仓没有 Einfacht.env ⇒ 幻影守卫从未执行
    （实测踩到）。`py_dir` 可注入（自证用假源码树）。
    """
    d = py_dir if py_dir is not None else gate.zdir()
    toks = set()
    for _name, text in _py_sources(d):
        toks.update(_TOKEN_RE.findall(text))
    out = []
    for tok in sorted(toks):
        if tok not in REGISTRY:
            out.append(M("knobs.phantom_token", token=tok))
    return out


def readme_names():
    """三语 README 的名单（`REFLECT_READMES`，默认取 `REGISTRY` 里登记的那条）。

    ⚠️ 此前两个对账器各写一遍同一段「解析环境变量 + 默认字面量」，默认名单
    因此有**三个**产地（两处字面量 + REGISTRY 一项）—— 正是本仓「数字只生产
    一次」要消灭的形状。现在只剩 `REGISTRY` 一处。
    """
    raw = os.environ.get("REFLECT_READMES", "").strip()
    if not raw:
        raw = REGISTRY["REFLECT_READMES"][1]      # 登记表里的默认值
    return [s.strip() for s in raw.split(",") if s.strip()]


def docs_names():
    """活状态文档名单（`REFLECT_DOCS`，默认取 `REGISTRY` 里登记的那条）。

    ⚠️ 与 `readme_names()` 同一个病、且**已经漂了**：`check_stale` 与
    `check_retractions` 各写了一份**五份**的字面量默认值，而登记表里是
    **六份**（多 `PRINCIPLES.md`）。实测：未设旋钮时两道闸门的 `DOCS`
    都不含 `PRINCIPLES.md` —— 于是「规矩的唯一产地」从来不在它们的扫描面
    里，写在原则文档里的翻案文本与陈旧断言永远不会被这两道闸门看到。

    「必须一致的两份」的处置是一处产地，不是两份都改对。
    """
    raw = os.environ.get("REFLECT_DOCS", "").strip()
    if not raw:
        raw = REGISTRY["REFLECT_DOCS"][1]         # 登记表里的默认值
    return [s.strip() for s in raw.split(",") if s.strip()]


FLAG_TRUTHY = ("1", "true", "yes", "on")
FLAG_FALSY = ("0", "false", "no", "off")


def flag(name):
    """读一个 flag 型旋钮，返回三态：`True`（开）/ `False`（关）/ `None`（没配）。

    ⚠️ flag 的**词汇表**此前有两套、大小写处理不同：
      · `gate._maybe_hint` / `check_facts_replay` 用 `.lower() == "off"`
        （大小写不敏感，只认 `off`）；
      · `doc.accepts_principles` 用 `.strip() in ("1", "true", "yes")`
        （**大小写敏感** —— 实测 `REFLECT_NO_PRINCIPLES=TRUE` 静默不生效，
        用户以为关掉了原则复跑，其实还在跑）。
    两套都在 `REGISTRY` 里登记为 `kind="flag"`，却没人定义「flag 是什么」。

    三态而不是两态：`None` = 没配（调用方用自己的默认），与「显式关」是
    两个决定，调用方常常要区分（off 态必须**明说**，静默 = 假绿）。
    """
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return None                   # 没配（含设成空串）⇒ 调用方默认
    if raw in FLAG_TRUTHY:
        return True
    if raw in FLAG_FALSY:
        return False
    return None                       # 认不出的词 ⇒ 让调用方决定


def questions_dir(repo_root=None):
    """悬案目录名（`REFLECT_QUESTIONS`，默认取登记表里的 `questions`）。

    ⚠️ **必须 `.strip()`**：`REFLECT_QUESTIONS=` （设成空串）是「没配」的
    常见形态 —— git hooks 里 `export X=$MAYBE_UNSET` 就会这样。此前
    `check_questions.collect` 用 `os.environ.get(...)` 不 strip，空串会被
    `os.path.join(仓根, "")` 解析成**仓根本身**，于是把 `STATE.md` /
    `README.md` / `AGENTS.md` 全当悬案收进来，报一堆
    `questions.missing_status` 假问题（实测）。

    同一个值另外两处（`facts._init_questions_dir` / `next._open_question_names`）
    早就会 strip —— 三份判据、一份错。
    """
    raw = os.environ.get("REFLECT_QUESTIONS", "").strip()
    return raw or REGISTRY["REFLECT_QUESTIONS"][1]


def questions_path(repo_root=None):
    """悬案目录的**绝对路径**（被检查仓相对）。"""
    root = repo_root or gate.GATE_REPO
    return os.path.join(root, questions_dir())


def _text_of(name, files=None):
    """取某个文件的文本。返回 `None` = 没有 / 读不到（**不是空串**）。

    `files` 给了就用它（自证注入假文件系统）；否则从 `gate.GATE_REPO` 读。
    「没有」与「空文件」在这里合并成 None —— 调用方一律 skip，因为
    「文件不在名单里」与「文件是空的」在这三个对账器里含义相同（无可比对）。
    """
    if files is not None:
        return files.get(name)
    p = os.path.join(gate.GATE_REPO, name)
    if not os.path.exists(p):
        return None
    try:
        with open(p, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return None


def readme_problems(files=None):
    """三语 README（REFLECT_READMES 名单）里出现、登记表里没有的 REFLECT_*
    名字（文档侧幻影防御）。`files` 可注入假文件系统（自证用）。"""
    out = []
    for name in readme_names():
        text = _text_of(name, files)
        if text is None:
            continue
        for tok in sorted(set(_TOKEN_RE.findall(text))):
            if tok not in REGISTRY:
                out.append(M("knobs.readme_phantom", file=name, token=tok))
    return out




def declared_vs_read_problems(gates, sources=None):
    """C4 对账①：闸门**声明**消费的旋钮 ⊆ 它**实际读**的旋钮。

    声明在 `GATE = meta(…, knobs=(…))`，实读在源码里的
    `os.environ.get("REFLECT_…")`（旋钮名一定以字面量出现在源码某处 ——
    否则它读不到那个环境变量）。两者此前无任何比较 —— AUTO:GATES 表
    可能列着闸门根本不读的旋钮（声明与实现不符，静默）。

    `gates` = registry.gates() 的结果（含 file / knobs）。
    `sources` 可注入（`{file: 源码文本}`）—— 此前**没有这个缝**，它直接读
    `gate.GATE_REPO`，于是这条判据**零自证用例**：一个从落地起从未被证明
    会红的守卫（AGENTS 规则 4 的硬违规）。有了缝它才能被反向断言考到。
    """
    out = []
    for g in gates:
        declared = set(g.get("knobs") or ())
        if not declared:
            continue
        text = _text_of(g["file"], sources)
        if text is None:
            continue
        read = set(_TOKEN_RE.findall(text))
        ghost = sorted(k for k in declared if k not in read)
        if ghost:
            out.append(M("knobs.declared_not_read",
                         file=g["file"], knobs=", ".join(ghost)))
    return out


def registry_vs_readme_problems(tables=None, names=None):
    """C4 对账②：登记表里的旋钮 ⊆ 三语 README 配置表。

    `knobs.REGISTRY` 与三语 README 的配置表是两份「旋钮清单」，此前只查
    单向（README ⊆ REGISTRY，见 readme_problems）。这条查反向：登记了的
    旋钮必须在三语 README 里都有配置行 —— 否则新旋钮登记了却没人知道
    怎么配（文档缺口，静默）。

    `tables` 可注入（自证用假 README）；`names` 可注入（自证用**固定名单**）。

    ⚠️ `names` 这个缝是必需的，不是方便：不传时名单来自 `readme_names()` ——
    它读 `REFLECT_READMES`。于是**自证的结果取决于跑它的那台机器设了什么
    环境**：`--init` 为单 README 的仓写 `REFLECT_READMES=README.md`，source
    之后这条自证就从 3 红变 1 红、`harness` 当场红。实测：一个刚 bootstrap
    完的仓，`registry --run commit` 与 `harness` **无法同时绿** —— 那是死结。
    判据不该读环境来决定自己考几轮。
    """
    out = []
    for name in (readme_names() if names is None else names):
        text = _text_of(name, tables)
        if text is None:
            continue
        missing = _missing_rows(text)
        if missing:
            out.append(M("knobs.readme_missing_rows",
                         file=name, knobs=", ".join(missing)))
    return out


_README_ROW = re.compile(r"\|\s*`(REFLECT_[A-Z0-9_]+)`\s*\|")


def _missing_rows(text):
    """配置表里缺了登记表中的哪些旋钮。**空表 ⇒ 空**（非配置表形态，不误报）。"""
    have = set(_README_ROW.findall(text))
    if not have:
        return []
    return sorted(k for k in REGISTRY if k not in have)


# ── 自证：名册自身的形状守卫（登记表坏 = 所有消费方的判据数据坏）──────────────

def _load_semantic_tables(langs):
    """装载每个已装包。坏包 / 空 ⇒ `{}`（语义完整性无从证明，不许绿）。"""
    tables = {}
    for lang in langs:
        try:
            tables[lang] = load_pack(lang)
        except Exception:                                # noqa: BLE001
            return {}
    # 零值守卫：一个包都没装 ⇒ 不是「完整」，是没装
    if not tables or not any(tables.values()):
        return {}
    return tables


def _all_packs_have_codes(tables, codes):
    """① 每个包都必须含**全部**语义 code（条目掉了 ⇒ 那边用户看到裸 code）。"""
    return all(all(c in table for c in codes)
               for table in tables.values())


def _all_packs_render_text(tables):
    """每个包里都真渲染出句子（不是回落成 code）。"""
    for lang in sorted(tables):
        with bind(Catalog.load(lang, {lang: tables[lang]})):
            if any(str(w) == w.code for _k, _d, w in REGISTRY.values()
                   if isinstance(w, _Semantic)):
                return False
    return True


def _semantic_packs_intact(langs=None):
    """**每个已装的语言包**都必须含全部旋钮语义，占位符名与基准侧一致，
    且在它自己的包下真渲染出句子（不是回落的裸 code）。

    这是 `_Semantic` 延迟渲染的**可证伪**证据：语义从本体搬到包里若掉了条目，
    这里当场红（而不是等人看见 `knobs.sem.reflect_facts` 这种裸 code）。

    `langs=None` ⇒ 用 `installed_langs()`（与对账器同一发现口径）。
    ⚠️ 此前硬写 `zh` / `en` 两个：下游仓只装一个包（**正是产品的主场景**：
    「从一堆包里挑一个」）时这条自证直接红（实测：只有 zh 的包目录
    ⇒ 16 PASS / 1 FAIL），产品没问题，是判据过窄。

    四段各是一个具名 helper（装载 / 码集 / 占位符 / 渲染）：四个「不许绿」
    的出口挤在中间时，读者要数 return 才敢说「哪几条已经查过」。
    """
    langs = installed_langs() if langs is None else list(langs)
    codes = [w.code for _k, _d, w in REGISTRY.values()
             if isinstance(w, _Semantic)]
    if not codes:
        return False                        # 语义全没了 = 名册坏，不许绿
    tables = _load_semantic_tables(langs)
    if not tables:
        return False
    if not _all_packs_have_codes(tables, codes):
        return False
    # ② 占位符名一致性**走同一个对账器**（与 `pack_sync_problems` 同一份判据：
    # 两处各写一遍循环，规则就会漂 —— C4）。
    if pack_sync_problems(discovery=lambda: sorted(tables),
                          loader=lambda l: tables[l]):
        return False
    return _all_packs_render_text(tables)


def _discovery_sees_planted_lang():
    """往真包目录里种一个半残的语言，默认 discovery 必须看得见它。

    用临时 `REFLECT_I18N`（基准包 + 种下的半残包）—— 不碰真仓的 lang/。

    ⚠️ 种下的语言名**必须与基准包不同名**：此前写死种 `de`，而基准是
    `a_pack_lang()`；一旦真仓装了 `de`（sorted() 使 `de` 成为基准），
    种下的半残包会**覆盖**基准包 ⇒ 这条自证在装了德语后假红（实测）。
    """
    import json  # noqa: PLC0415
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    # 基准包用**第一个已装的**，不写死 zh：只装一个包（产品主场景）时，
    # 写死 zh 会让这条自证假红（实测 en-only ⇒ 16 PASS / 1 FAIL）。
    base = a_pack_lang()
    if not base:
        # 零包是**合法态**（用户要的零语言默认）⇒ 没有基准包可种，这条的
        # 条件真空成立。真仓永远有包，所以这条在真环境里必然真考。
        return True
    zh = load_pack(base)
    if not zh:
        return False
    d = tempfile.mkdtemp()
    try:
        os.makedirs(os.path.join(d, base), exist_ok=True)
        with open(os.path.join(d, base, "all.json"), "w",
                  encoding="utf-8") as fh:
            json.dump(zh, fh, ensure_ascii=False)
        # 种一个**半残**的假语言：只有一半的键 —— 不发现它就会漏判。
        # 名字取 `probe-lang`，**绝不可能**和真语言同名（`de`/`en`/`zh`…）。
        planted = "probe-lang"
        os.makedirs(os.path.join(d, planted), exist_ok=True)
        half = dict(list(zh.items())[: len(zh) // 2])
        with open(os.path.join(d, planted, "all.json"), "w",
                  encoding="utf-8") as fh:
            json.dump(half, fh, ensure_ascii=False)
        prev = os.environ.get("REFLECT_I18N")
        os.environ["REFLECT_I18N"] = d
        try:
            got = installed_langs()
            probs = pack_sync_problems()       # 默认 discovery
            return planted in got and probs != []
        finally:
            if prev is None:
                os.environ.pop("REFLECT_I18N", None)
            else:
                os.environ["REFLECT_I18N"] = prev
    finally:
        shutil.rmtree(d, True)


def _looks_like_pack(path):
    """这个 json **内容上**像不像语言包？（单文件形状的判据）

    语言包的特征：键是 `x.y` 形的 code，值是字符串（通常含 `%(…)` 占位符）。
    不是语言包的 json（配置 / 笔记 / 元数据）不该被当成一种语言。
    """
    import json  # noqa: PLC0415
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return False        # 坏文件不算语言包（坏包由 load_pack 对已装语言报）
    if not isinstance(data, dict) or not data:
        return False
    dotted = sum(1 for k in data if isinstance(k, str) and "." in k)
    return dotted >= max(1, len(data) // 2)


def installed_langs():
    """语言包目录里实际装了哪些语言（**发现式**，不写名单）。

    C4「手写名录一定会漂」在这里同样成立：此前 `langs=("zh", "en")` 是写死的，
    于是往 `zreflect/lang/` 里加一个 `de/`（半装、缺键）时对账器**完全不看它**
    ——「装了但没对账」正是本仓要消灭的那类静默。现在是扫目录。

    **判据不是「有那个目录」，而是「那里真有 .json 包文件」**：早先按目录名
    收，目录里随便放个 `straynotes/` 或一个 `extra.json` 也会被当成语言，
    凭空报出「缺键」并让 roster 红（实测）。语言包的判据是「有包文件」。
    """
    base = pack_dir()
    out = set()
    try:
        for n in sorted(os.listdir(base)):
            p = os.path.join(base, n)
            if os.path.isdir(p) and any(x.endswith(".json")
                                        for x in os.listdir(p)):
                out.add(n)
            # ⚠️ 单文件形状（`<lang>.json`）与「pack 根随便一个 json」同形 ——
            # 只按文件名收会把 `config.json` 当成 `config` 语言，凭空报缺键
            # （实测）。语言包的判据是**内容**：code 形键（`x.y`）或占位符值。
            elif n.endswith(".json") and _looks_like_pack(p):
                out.add(n[:-len(".json")])
    except OSError as e:
        # ⚠️ **不许编 0**（AGENTS 纪律 7：读不到就明说，绝不编造）。此前这里
        # `return []`，于是「权限坏掉 / 目录读不了」与「一个包都没装」塌缩成
        # 同一个假值 ⇒ 对账器全绿、roster 全绿 —— 那是「部署了 ≠ 在跑」家族
        # 里最坏的一种（实测：chmod 000 的包目录，pack_sync_problems() == []）。
        raise PacksUnreadable(str(e)) from e
    return sorted(out)


class PacksUnreadable(RuntimeError):
    """包目录本身读不了（权限 / I-O）。**区分于「没装包」**：后者合法，前者是事故。"""



def dead_default_problems(py_dir=None):
    """C4 对账⑤：闸门/模块里**定义了却从不使用**的 `DEFAULT_*` 常量。

    为什么这条值得一个判据：`check_i18n` 曾经有 `DEFAULT_ROOT = "zreflect"`，
    而 `run()` 只读环境变量、**从不用它** —— 于是本仓最核心的覆盖闸门在活体
    路径上**永远 off**（「存在、自证绿、从没跑过」）。`check_snapshots` 犯过
    同一个错。一个「声明了默认值但不生效」的常量，比没有默认值更坏：它让人
    **以为**配好了。

    判据（AST）：模块级 `DEFAULT_X = …` 若在该文件里**没有任何 Load 引用**
    ⇒ 报。只扫 `check_*.py` + 平台模块（即 `zreflect/*.py`）。
    """
    import ast  # noqa: PLC0415
    d = py_dir if py_dir is not None else gate.zdir()
    out = []
    try:
        names = sorted(os.listdir(d))
    except OSError:
        return out
    for n in names:
        if not n.endswith(".py"):
            continue
        try:
            tree = ast.parse(open(os.path.join(d, n), encoding="utf-8").read())
        except (OSError, SyntaxError):
            continue
        defined = {t.id for node in tree.body if isinstance(node, ast.Assign)
                   for t in node.targets
                   if isinstance(t, ast.Name) and t.id.startswith("DEFAULT_")}
        loaded = {node.id for node in ast.walk(tree)
                  if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)}
        for dead in sorted(defined - loaded):
            out.append(M("knobs.dead_default", file=n, name=dead))
    return out


def _dead_default_ok():
    """定义了 `DEFAULT_X` 却从不 Load ⇒ 必须报；用了就不报。"""
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    try:
        dead = ("DEFAULT_X = 'v'\n"
                "def run():\n"
                "    return os.environ.get('K') or 'hardcoded'\n")
        live = ("DEFAULT_X = 'v'\n"
                "def run():\n"
                "    return os.environ.get('K') or DEFAULT_X\n")
        # 先只放「死的」那个
        with open(os.path.join(d, "check_dead.py"), "w", encoding="utf-8") as fh:
            fh.write(dead)
        got_dead = [p.code for p in dead_default_problems(py_dir=d)]
        # 换成「活的」⇒ 应不报
        with open(os.path.join(d, "check_dead.py"), "w", encoding="utf-8") as fh:
            fh.write(live)
        got_live = dead_default_problems(py_dir=d)
        return got_dead == ["knobs.dead_default"] and got_live == []
    finally:
        shutil.rmtree(d, True)


def a_pack_lang():
    """取一个**已装**的语言包名（自证「读真包」类判据用）；一个都没装 ⇒ None。

    这些判据验的是「渲染保真」（消息模板里占位符对不对、句子还在不在），
    **语言是谁不重要** —— 所以不能写死 `zh`。下游仓只装一个包是产品主场景
    （「从一堆包里挑一个」），写死 zh 会让 `REFLECT_I18N=<只有en>` 的自证假红。
    """
    langs = installed_langs()
    return langs[0] if langs else None


_CODE_RE = re.compile(r'M\("([a-z][a-z0-9_.]+)"')
# `_Semantic(...)` 产的也是用户可见消息（延迟渲染），一并计入。
_SEM_RE = re.compile(r'_Semantic\("([a-z][a-z0-9_.]+)"')

# 自证 / 文档专用的 code：它们**从不**渲染给用户（只出现在 `--selftest`
# 的断言里，或作为 docstring 的示例）。用**显式前缀**声明，而不是手写名录 ——
# 新增这类 code 只要用这个前缀即可（发现式，不漂）。
_SELFTEST_CODE_PREFIXES = ("probe.", "gate.off.body")


def used_codes(py_dir=None):
    """本体源码里**实际会发给用户**的消息 code（`M("…")` / `_Semantic("…")`）。

    **发现式**：扫源码，不写名录。这是「包完整性」判据的参照面 —— 没有它，
    「两个包同时缺同一条」会全绿（zh↔en 的差集比较看不见共缺）。

    **剥 docstring**：文档里的示例（`M(…)` 形态）不是输出，不剥会把文档
    示例当真消息（实测踩到假阳性）。
    `_SELFTEST_CODE_PREFIXES` 里的前缀是自证专用 code（同样不发给用户）。
    """
    import ast  # noqa: PLC0415
    d = py_dir if py_dir is not None else gate.zdir()
    out = set()
    for _n, src in _py_sources(d):
        try:
            tree = ast.parse(src)
        except SyntaxError:
            continue
        # docstring 常量（豁免：示例不是输出）
        docs = set()
        for node in ast.walk(tree):
            if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef)):
                doc = ast.get_docstring(node, clean=False)
                if doc:
                    docs.add(doc)
        text_wanted = argparse_strip(src, docs)
        out |= set(_CODE_RE.findall(text_wanted))
        out |= set(_SEM_RE.findall(text_wanted))
    return {c for c in out
            if not any(c.startswith(p) for p in _SELFTEST_CODE_PREFIXES)}


def argparse_strip(src, docs):
    """把 docstring 正文从源码里抹掉（只做粗粒度替换，够用于扫面）。"""
    for doc in docs:
        if doc:
            src = src.replace(doc, "")
    return src


def _unreadable_dir_is_loud():
    """包目录读不了 ⇒ 必须报 `pack_unreadable`，不许当「零包」（合法态）。"""
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    if os.name == "nt":
        # ⚠️ **Windows 上 `chmod 0` 不阻止读**：`os.chmod` 在那里只切只读位，
        # 而 `listdir` 照样能进。于是「造一个读不了的目录」这个夹具在
        # Windows 上根本造不出来 —— 这条测不出东西（明说不适用，不是静默通过）。
        # 实测：CI 的 Windows 腿 `knobs` 自证 28 PASS / 1 FAIL，红的就是这条。
        return True
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        return True        # root 无视权限位，这条测不出来（明说不适用）
    d = tempfile.mkdtemp()
    try:
        os.chmod(d, 0)
        prev = os.environ.get("REFLECT_I18N")
        os.environ["REFLECT_I18N"] = d
        try:
            try:
                installed_langs()
            except PacksUnreadable:
                return True
            return False
        finally:
            if prev is None:
                os.environ.pop("REFLECT_I18N", None)
            else:
                os.environ["REFLECT_I18N"] = prev
    finally:
        os.chmod(d, 0o755)
        shutil.rmtree(d, True)


def pack_coverage_problems(codes=None, loader=None, discovery=None):
    """C4 对账④：**源码用到的每个 code 都必须在每个已装包里**。

    zh↔en 的差集比较（`pack_sync_problems`）看不见「两边一起缺」——
    实测：从 zh 和 en 同时删掉 `locks.ok`，`pack_sync_problems()` 返回 `[]`，
    而 `REFLECT_LANG=zh` 的用户在屏幕上看到 `locks.ok(count=3)`（裸 code），
    退出码正常。那是**本仓立身的静默退化**，是 C4 的经典失效模式
    （「两份必须一致」只保证一致，不保证完整）。

    参照面是**源码**（`used_codes()`），不是另一个包 —— 这样两个包一起漂
    也照样被抓。零包是合法态 ⇒ 无包可查，返回空。

    `langs=None` ⇒ 用 `discovery()` 发现（默认 `installed_langs()`）。
    ⚠️ 此前这个参数**接受了却从不调用**（签名里有、实现里没有）—— 传一个假的
    discovery 进去，结果毫无变化（实测）。那是本仓最痛恨的形态：接口声称可注入，
    实际不可。现在与 `pack_sync_problems` 走同一条通道。
    """
    load = loader if loader is not None else load_pack
    codes = used_codes() if codes is None else set(codes)
    try:
        langs = list((discovery or installed_langs)())
    except PacksUnreadable as e:
        return [M("knobs.pack_unreadable", lang="*", error=e)]
    if not codes or not langs:
        return []                       # 零包 / 零 code：没有可比的两侧
    out = []
    for lang in sorted(langs):
        try:
            table = load(lang)
        except Exception as e:                           # noqa: BLE001
            return [M("knobs.pack_unreadable", lang=lang, error=e)]
        missing = sorted(codes - set(table))
        if missing:
            out.append(M("knobs.pack_missing_code",
                         lang=lang, count=len(missing),
                         codes=", ".join(missing[:8])))
    return out


def pack_sync_problems(loader=None, discovery=None):
    """C4 对账③：各语言包的**键集**与**占位符名**必须一致。

    此前无任何东西强制这件事 —— 手工把一条 code 加进 zh 却忘了 en，
    `REFLECT_LANG=en` 的用户就静默看到裸 code（本仓立身要消灭的静默退化）。
    实测现状两份是相等的，但「相等」是运气不是判据。

    `discovery` 决定「哪些语言算数」（默认 `installed_langs()`）。
    ⚠️ 此前还有一个 `langs=` 参数，能**直接塞一组语言名** —— 那让六条自证
    全都绕开发现通道：把 `installed_langs()` 换回手写名单，5/6 条用例照样绿
    （实测 BLIND）。同一件事两个参数，弱的那条就成了后门。已删除：
    要指定语言就注入 `discovery`，与生产路径走同一个缝。
    `loader` 可注入（自证用假包）；默认走 `i18n.load_pack`（**合并视图**，
    与真装载器看同一张表 —— 只读单个分片会与装载器分叉）。
    """
    load = loader if loader is not None else load_pack
    try:
        langs = list((discovery or installed_langs)())
    except PacksUnreadable as e:
        return [M("knobs.pack_unreadable", lang="*", error=e)]
    tables, err = _load_tables(langs, load)
    if err:
        return err
    early = _empty_pack_verdict(tables)
    if early is not None:
        return early
    ref_lang = sorted(tables)[0]
    ref = tables[ref_lang]
    out = []
    for lang in sorted(tables):
        if lang == ref_lang:
            continue
        out += _key_set_problems(lang, ref_lang, ref, tables[lang])
        out += _placeholder_problems(lang, ref_lang, ref, tables[lang])
    return out


def _empty_pack_verdict(tables):
    """「零包 / 坏包」的两种结局。返回 `None` = 继续比对。

    **零包是合法态**（用户要的「本体没有任何语言表达也能用」）：一个包都没装
    ⇒ 没有「彼此一致」可言，但也不是配置坏 —— 返回空（不报）。
    「设了包却读不到」由 `pack_unreadable` / 激活路径的 `i18n.pack_absent`
    负责，那是另一件事：**没要** vs **要了却没有**。

    装了但全是空表 ⇒ 那是**坏包**（声称有目录却没有内容），报。
    """
    if not tables:
        return []
    if not any(tables.values()):
        return [M("knobs.pack_sync_empty", pack_dir=pack_dir())]
    return None


def _load_tables(langs, load):
    """装载全部已装包。返回 `(tables, 错误清单或 None)`。

    ⚠️ **必须捕获 `load_pack` 的异常**：它对坏分片抛 `MissingPack`，而
    `pack_sync_problems` 可能在 `activate_or_fatal()` **之外**被调用
    （`registry --gates` 的 roster 对账就是），于是异常一路冒到顶层变成
    裸 traceback rc=1 —— 逃出本仓的 rc 契约（配置坏 = FATAL rc 2）。
    实测踩到：`REFLECT_LANG` 未设 + 坏分片 ⇒ rc=1 traceback，
    同一个输入加 `REFLECT_LANG=zh` 才是 rc=2。
    """
    tables = {}
    for lang in langs:
        try:
            tables[lang] = load(lang)
        except Exception as e:                           # noqa: BLE001
            return {}, [M("knobs.pack_unreadable", lang=lang, error=e)]
    return tables, None


def _key_set_problems(lang, ref_lang, ref, other):
    """键集差集：只有基准有 / 只有这个包有。"""
    out = []
    only_ref = sorted(set(ref) - set(other))
    only_other = sorted(set(other) - set(ref))
    if only_ref:
        out.append(M("knobs.pack_missing_keys", lang=lang, reference=ref_lang,
                     keys=", ".join(only_ref[:8])))
    if only_other:
        out.append(M("knobs.pack_extra_keys", lang=lang, reference=ref_lang,
                     keys=", ".join(only_other[:8])))
    return out


def _placeholder_problems(lang, ref_lang, ref, other):
    """占位符名一致：差一个 ⇒ 渲染时 KeyError（或更糟，静默少显示一段）。"""
    out = []
    for code in sorted(set(ref) & set(other)):
        a = sorted(_PLACEHOLDER_RE.findall(ref[code]))
        b = sorted(_PLACEHOLDER_RE.findall(other[code]))
        if a == b:
            continue
        # 参数名不能叫 `code`：`M(code, **params)` 的首参就叫 code，
        # 同名 kwarg 会 `TypeError: M() got multiple values`（实测踩到）。
        out.append(M("knobs.pack_placeholder_mismatch",
                     lang=lang, key=code, reference_lang=ref_lang,
                     expected_params=", ".join(a) or "-",
                     actual_params=", ".join(b) or "-"))
    return out


def null_pack():
    """一个**显式 null 包**的 context manager（自证专用）。

    自证里的形状判据（「没装包时应该是 code」）必须自带 null 作用域：入口
    `activate()` 会把 `REFLECT_LANG` 设成 zh/en，断言若不自带作用域，就变成
    「跑在什么环境就考什么」—— 实测 `REFLECT_LANG=zh gates-selftest.sh` 下
    这类用例全红。
    """
    return bind(NULL)


def _semantics_can_red():
    """`_semantics_are_codes_under()` 有牙吗？给一张**不会渲染成 code** 的表 ⇒ 必须 False。"""
    sem = [(k, w) for k, _d, w in REGISTRY.values() if isinstance(w, _Semantic)]
    if not sem:
        return False
    # 用一个「每条 code 都被翻成句子」的假包：str(w) != w.code ⇒ 应返回 False
    fake = {w.code: "SENTENCE %s" % w.code for _k, w in sem}
    return _semantics_are_codes_under(
        bind(Catalog.load("xx", {"xx": fake}))) is False


def _planted_red_when_blind():
    """把 discovery 通道关掉（回手写名单），种植式检查必须红。"""
    prev = installed_langs
    globals()["installed_langs"] = lambda: ["zh", "en"]     # 假装发现坏了
    try:
        return _discovery_sees_planted_lang() is False
    finally:
        globals()["installed_langs"] = prev


def _semantics_are_codes_under(cm):
    """在 `cm` 语言包作用域下，每条旋钮语义都渲染成 code（且非空）。"""
    sem = [(k, w) for k, _d, w in REGISTRY.values()
           if isinstance(w, _Semantic)]
    if not sem:
        return False                        # 零值守卫：语义全没了 ⇒ 名册坏
    cm.__enter__()
    try:
        return all(str(w) == w.code for _k, w in sem)
    finally:
        cm.__exit__(None, None, None)


def _cases_fixture(d):
    """造夹具（假源码目录 + 幻影记号）。`d` 来自 `_cases()`。"""
    open(os.path.join(d, "good.py"), "w", encoding="utf-8").write(
        'X = os.environ.get("REFLECT_FACTS")\n')
    # 幻影记号用拼接构造：本文件在扫描面内（zreflect/*.py），字面量写出来
    # 会被自己的 scan_surface_problems() 收编（本仓老坑）。
    # 夹具（假源码 / 假 README）的正文用**英文** —— 它们是被扫描的输入，
    # 不是本体输出（同 facts.py 体例：中文夹具会被零语言闸门当消息）。
    phantom = "REFLECT_" + "GHOSTX"
    open(os.path.join(d, "phantom.py"), "w", encoding="utf-8").write(
        '# a comment mentions the nonexistent knob ' + phantom + '\n')
    return {"d": d, "phantom": phantom}


def _cases_scan(fx):
    """见 `_cases()`：本组 6 条。"""
    d, phantom = fx["d"], fx["phantom"]
    return [
    # ① 正常不报
    ("knobs.registry_entry_shape",
     lambda: all(k in KINDS and isinstance(dflt, str) and w.strip()
                 for k, dflt, w in REGISTRY.values()) and len(REGISTRY) >= 20),
    ("knobs.scan_clean",
     lambda: scan_surface_problems() == []),
    ("knobs.real_tree_scan_clean", lambda: scan_surface_problems() == []),
    # ② 该报的必须报
    ("★ knobs.phantom_token",
     lambda: any(p.code == "knobs.phantom_token"
                 and p.params.get("token") == phantom
                 for p in scan_surface_problems(py_dir=d))),
    ("★ knobs.registry_empty", lambda: bool(REGISTRY)),
    ("knobs.phases_registered", lambda: "REFLECT_PHASES" in REGISTRY),
    ]


_README_TRIO = {"README.md": "x", "README.zh.md": "x", "README.de.md": "x"}


def _cases_readme_nominations():
    """README 里出现未登记的旋钮名（幻影防御）—— 该报 + 正常不报。"""
    return [
        ("knobs.readme_nominations_registered",
         lambda: readme_problems(files={
             "README.md": "uses REFLECT_FACTS and REFLECT_DOC.",
             "README.zh.md": "x", "README.de.md": "x"}) == []),
        ("knobs.real_readmes_clean", lambda: readme_problems() == []),
        ("\u2605 knobs.readme_phantom",
         lambda: any(x.code == "knobs.readme_phantom"
                     for x in readme_problems(files=dict(
                         _README_TRIO,
                         **{"README.md": "see " + "REFLECT_" + "GHOSTY" + "."})))),
    ]


def _cases_readme_declared_read():
    """声明↔实读对账 —— 从落地起从未被证明会红（AGENTS 规则 4）。

    ⚠️ 断言**不许**提取成 helper：`never_falsifiable` 只扫 lambda 的 AST，
    委托给一个函数就让它瞎掉 —— 此前那样做过，helper 改成 `return True`
    后 26 PASS / 0 FAIL 全绿（实测）。宁可写长一行，也不关掉检测器。
    """
    return [
        ("\u2605 knobs.declared_not_read",
         # 声明了某个旋钮，但源码里根本不出现它 ⇒ 必须报，且**点名那个旋钮**
         lambda: [p.code for p in declared_vs_read_problems(
             [{"file": "check_x.py", "knobs": ("REFLECT_FACTS",)}],
             sources={"check_x.py": "X = 1\n"})
         ] == ["knobs.declared_not_read"]
         and [p.params for p in declared_vs_read_problems(
             [{"file": "check_x.py", "knobs": ("REFLECT_FACTS",)}],
             sources={"check_x.py": "X = 1\n"})
         ] == [{"file": "check_x.py", "knobs": "REFLECT_FACTS"}]),
        # 声明了、也确实读了 ⇒ 不许报（阳性对照，否则「总是报」也能骗过自证）
        ("knobs.declared_and_read_is_clean",
         lambda: declared_vs_read_problems(
             [{"file": "check_x.py", "knobs": ("REFLECT_FACTS",)}],
             sources={"check_x.py":
                      'X = os.environ.get("REFLECT_FACTS")\n'}) == []),
    ]


def _cases_readme_rows():
    """README 配置表缺行 —— 方向与幻影相反。"""
    return [
        ("\u2605 knobs.readme_missing_rows",
         # ⚠️ 断言**钉死 code**，不是只判 `!= []`：此前那样任何错误 code 都能
         # 让这条通过（实测：换成一个 `readme_phantom` 冒充，用例照样绿）。
         lambda: [p.code for p in registry_vs_readme_problems(
             tables=dict.fromkeys(_README_TRIO, "| `REFLECT_FACTS` | x |\n"),
             # 名单**钉死**：判据不该读 `REFLECT_READMES` 来决定自己考几轮。
             names=tuple(_README_TRIO))
         ] == ["knobs.readme_missing_rows"] * 3),
    ]


def _cases_readme_empty():
    """③ 空输入档（AGENTS 规则 4 的第三类）。

    两个对账器此前只有「不报」与「该报」两档，空输入返回 `[]` —— 与「干净」
    不可区分。这里把空输入**明说为不适用**（不是假装通过）：没有可比的两侧时
    返回空是对的，但必须有一条用例把它钉住，否则「实现坏了」也会返回空。
    """
    return [
        ("knobs.declared_vs_read_empty_in_scope",
         lambda: declared_vs_read_problems([{"file": "x.py", "knobs": ()}],
                                           sources={}) == []),
        ("knobs.registry_vs_readme_empty_tables",
         lambda: registry_vs_readme_problems(tables={}) == []),
    ]


def _cases_readme(fx):
    """见 `_cases()`：本组 8 条。

    四组（幻影 / 声明↔实读 / 缺行 / 空输入）：四个对账器方向各不相同，
    混在一张清单里时「这条考的是哪个方向」只能靠注释认。
    """
    return (_cases_readme_nominations() + _cases_readme_declared_read()
            + _cases_readme_rows() + _cases_readme_empty())


def _cases_semantics(fx):
    """见 `_cases()`：本组 3 条。"""
    return [
("knobs.semantic_renders_as_code_by_default",
 # 自带 **null 作用域**：这条测的是「没装包时是 code」，与入口激活了
 # 什么包无关。此前直接读 `str(w)`，`REFLECT_LANG=zh` 下渲染成句子
 # 于是全红（实测）—— 断言没声明作用域 = 跑在什么环境就考什么。
 # 委托给 helper（搭 null 作用域必须进出配对，内联会变成不可读的一行）。
 # 恒真检测看不见委托体 ⇒ 由 gate 判「未审计」；下面补一条同源反证，
 # 证明 helper 本体确实有牙。
 lambda: _semantics_are_codes_under(null_pack())),
("★ knobs.semantics_are_codes_can_red", lambda: _semantics_can_red()),
# 语义延迟渲染的**正向证据**：真 zh 包里每条语义都有条目，且在 zh 包
# 下渲染出的是那句话（不是 code）。读磁盘真包 = 证明迁移没丢语义
# （注入假表只能证明「我写的模板渲染出我写的字」—— 循环论证）。
# 复跑：REFLECT_LANG=zh python3 zreflect/knobs.py --selftest
("knobs.semantics_present_in_real_packs",
 # 条件判据：**装了包就必须完整**。零包（合法态）⇒ 无对象可验，
 # 条件真空成立；装了坏包 ⇒ 这条照样红（已用 planted 包验证过）。
 lambda: not installed_langs() or _semantic_packs_intact()),
    ]


def _cases_sync_rules():
    """差集 / 占位符 / 多键 / 空包 —— 考的是**规则本身**。

    这四组注入 `discovery` 是**有意**的：不该依赖发现通道（那由
    `pack_sync_sees_every_installed_lang` 单独考）。显式传 `discovery=`
    是把「我在测规则」写明白 —— 此前用 `langs=` 传同一个东西，看起来像在
    测发现、其实绕开了它。
    """
    return [
        ("\u2605 knobs.pack_missing_keys",
         lambda: [p.code for p in pack_sync_problems(
             discovery=lambda: ("zh", "en"), loader=lambda l: {
                 "zh": {"a": "x"}, "en": {"a": "x", "b": "y"}}[l])
         ] == ["knobs.pack_missing_keys"]),
        ("\u2605 knobs.pack_placeholder_mismatch",
         lambda: [p.code for p in pack_sync_problems(
             discovery=lambda: ("zh", "en"), loader=lambda l: {
                 "zh": {"a": "x %(k)s"}, "en": {"a": "x %(j)s"}}[l])
         ] == ["knobs.pack_placeholder_mismatch"]),
        # 多键方向也必须能报（此前只测了缺键 —— 「多出来一个键」同样会让
        # 另一侧的用户看到裸 code，是同一个洞的另一面）。
        # 参考侧是 `sorted(...)[0]`（这里 = "en"），所以「zh 多一个键」才走
        # extra_keys；反过来会被报成 en 缺键（同一个洞，两种措辞）。
        ("\u2605 knobs.pack_extra_keys",
         lambda: [p.code for p in pack_sync_problems(
             discovery=lambda: ("zh", "en"), loader=lambda l: {
                 "zh": {"a": "x", "b": "y"}, "en": {"a": "x"}}[l])
         ] == ["knobs.pack_extra_keys"]),
        # ③ 空输入必须报
        ("\u2605 knobs.pack_sync_empty",
         lambda: [p.code for p in pack_sync_problems(
             discovery=lambda: ("zh", "en"), loader=lambda l: {})]
         == ["knobs.pack_sync_empty"]),
    ]


def _cases_sync_coverage():
    """发现式 + 包完整性：这两条**不许**替被测对象把答案递过去。"""
    return [
        # 发现式（不写名单）：磁盘上多装一个半残的包也必须被对账器看见。
        # ⚠️ 走 **默认 discovery**（不传 `discovery=`）—— 传了就等于替被测
        # 对象把答案递过去（实测：那样即使把 `installed_langs` 换回手写
        # 名单，这条仍 PASS）。
        ("\u2605 knobs.pack_sync_sees_every_installed_lang",
         lambda: _discovery_sees_planted_lang()),
        # ④ **包完整性**（C4 对账④）：源码用到的 code 必须在每个已装包里。
        # 这条抓的是「两边一起缺」—— 只比差集时双向共缺会全绿，用户看到裸 code
        # （实测：两包同删 `locks.ok` ⇒ 全绿）。
        ("knobs.coverage_real_repo_clean",
         lambda: pack_coverage_problems() == []),
        # **`discovery=` 必须真的被调用**（此前签名里接受、实现里从不调用：
        # 传假 discovery 进去结果毫无变化）。这条钉的是「可注入」这个承诺。
        ("\u2605 knobs.coverage_honours_discovery",
         lambda: (lambda seen: ([p.code for p in pack_coverage_problems(
             codes={"a.b"}, discovery=lambda: seen.append(1) or ["zz"],
             loader=lambda l: {})] == ["knobs.pack_missing_code"] and
             len(seen) == 1))([])),
        ("\u2605 knobs.pack_missing_code",
         lambda: [p.code for p in pack_coverage_problems(
             codes={"a.b", "c.d"}, discovery=lambda: ("zh", "en"),
             loader=lambda l: ({"a.b": "x", "c.d": "y"} if l == "en"
                               else {"a.b": "x"}))
         ] == ["knobs.pack_missing_code"]),
        # **不可读目录 ≠ 没装包**（AGENTS 纪律 7：读不到就明说，绝不编 0）。
        # 此前 `installed_langs()` 在 OSError 时 return []，于是权限坏掉
        # 与「零包」塌缩成同一个假值 ⇒ 对账全绿（实测 chmod 000 ⇒ []）。
        ("\u2605 knobs.pack_unreadable_on_oserror",
         lambda: _unreadable_dir_is_loud()),
    ]


def _cases_sync(fx):
    """见 `_cases()`：本组 9 条。

    两组（规则 / 发现与覆盖）：前者注入 discovery 考规则本身，后者**不传**
    discovery 考「它真的被调用」—— 混在一起时读者分不清某条断言属于哪一类。
    """
    return _cases_sync_rules() + _cases_sync_coverage()


def _cases_pack(fx):
    """语言包判据的 12 条：语义 3 + 同步/覆盖 9。"""
    return (
        _cases_semantics(fx)
        + _cases_sync(fx)
    )


def _cases_registry(fx):
    """见 `_cases()`：本组 3 条。"""
    return [
    # zh / en 键集与占位符名一致（C4 对账③）。真包绿 = 迁移没落一边；
    # 反向断言见 ② 档（假包必须报）。
    ("knobs.real_packs_in_sync",
     # 同上：零包合法 ⇒ 无「彼此」可对；有包就必须一致。
     lambda: not installed_langs() or pack_sync_problems() == []),
    # ⚠️ 上面那条是**委托**（搭临时夹具，没法内联）⇒ 恒真检测看不见它内部。
    # 按 gate 的新判据它会被判「未审计」；所以这里补一条**同源反证**：
    # 把 discovery 通道关掉，种植式检查必须红。两条一起才叫证明。
    ("★ knobs.discovery_planted_can_red", lambda: _planted_red_when_blind()),
    # **死默认值**：定义了 `DEFAULT_*` 却从不使用 —— 「声明了但不生效」
    ("★ knobs.dead_default", lambda: _dead_default_ok()),
    # **名单旋钮的默认值只有一个产地**：`docs_names()` 必须与 `REGISTRY` 一致。
    # ⚠️ 此前 `check_stale` 与 `check_retractions` 各手抄一份五份的默认值，
    # 而登记表是六份 —— `PRINCIPLES.md` 从来不在它们的扫描面里（实测）。
    ("★ knobs.docs_names_follow_registry", lambda: _docs_names_follows()),
    # **flag 词汇表**：三态 + 大小写折叠。此前两套词汇表并存（`== "off"` 与
    # `in ("1","true","yes")`），后者大小写敏感 —— `TRUE` 静默不生效。
    ("★ knobs.flag_three_states", lambda: _flag_case()),
    ]


def _flag_case():
    """`flag()` 的三态：真 / 假 / 没配，每种至少一个写法（含大小写折叠）。

    ⚠️ `TRUE`（大写）必须算真 —— 那正是 doc 侧那套词汇表的洞。空串与未设
    都必须是 `None`（= 没配，调用方用自己的默认），不是 False。
    """
    import os  # noqa: PLC0415
    name = "REFLECT_" + "FLAG_PROBE"
    prev = os.environ.get(name)
    try:
        seen = {}
        for v in ("1", "TRUE", "Yes", "ON"):
            os.environ[name] = v
            seen[v] = flag(name)
        for v in ("0", "FALSE", "No", "OFF"):
            os.environ[name] = v
            seen[v] = flag(name)
        os.environ[name] = ""
        empty = flag(name)
        os.environ.pop(name)
        unset = flag(name)
        return (all(seen[v] is True for v in ("1", "TRUE", "Yes", "ON"))
                and all(seen[v] is False for v in ("0", "FALSE", "No", "OFF"))
                and empty is None and unset is None)
    finally:
        if prev is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = prev


def _docs_names_follows():
    """**两道扫描闸门的默认面必须等于登记表** —— 不是「函数返回登记表」。

    ⚠️ 第一版写成 `docs_names() == REGISTRY["REFLECT_DOCS"]`，是**循环论证**
    （函数自己就读 REGISTRY，两边一起变，改坏了也恒真 —— 实测：把旧的五份
    默认值塞回 REGISTRY，这条照样绿）。恒真的判据比没有更坏。

    真判据是**消费端**：`check_stale` / `check_retractions` 在**未设旋钮**
    时实际扫哪些文件。它们曾经各手抄一份五份的字面量，登记表是六份 ——
    只有从消费端读，才看得见那个差。
    """
    import os  # noqa: PLC0415
    registered = [s.strip() for s in REGISTRY["REFLECT_DOCS"][1].split(",")
                  if s.strip()]
    prev = os.environ.get("REFLECT_DOCS")
    try:
        os.environ.pop("REFLECT_DOCS", None)
        scanned = _docs_scanned_by_gates()
        if scanned != registered:
            return False
        # 旋钮设了就**不许**回落登记表（否则用户改不动，旋钮是死的）
        os.environ["REFLECT_DOCS"] = "only.md"
        return _docs_scanned_by_gates() == ["only.md"]
    finally:
        if prev is None:
            os.environ.pop("REFLECT_DOCS", None)
        else:
            os.environ["REFLECT_DOCS"] = prev


def _docs_scanned_by_gates():
    """两道闸门在**当前环境**下要扫的文档名单（消费端，唯一真相）。

    调的是**闸门自己的入口**，不是重新读一遍登记表 —— 这才看得见
    「闸门抄了一份不一样的字面量」那个差。
    """
    import check_retractions  # noqa: PLC0415
    import check_stale  # noqa: PLC0415
    # `check_stale.scanned_docs()` 返回的是**已读到的文档**（名字→正文的
    # dict，读不到的会跳过），所以取键；`check_retractions` 那份返回名单。
    stale = list(check_stale.scanned_docs())
    retr = list(check_retractions.scanned_docs())
    return stale if stale == retr else []          # 两侧不一致 ⇒ 空（必红）


def _cases():
    """拼装四组夹具断言。**只拼装** —— 判据在各分组函数里。"""
    import atexit  # noqa: PLC0415
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    atexit.register(shutil.rmtree, d, True)
    fx = _cases_fixture(d)
    return (
        _cases_scan(fx)
        + _cases_readme(fx)
        + _cases_pack(fx)
        + _cases_registry(fx)
    )


MODULE = module_meta("旋钮登记", "REFLECT_* 的唯一名册 + 名册自洽性判据", selftest=True)


if __name__ == "__main__":
    sys.path.insert(0, __file__.rsplit("/", 1)[0])
    from gate import main_selftest_or  # noqa: PLC0415

    def _run(argv):
        # `--list`：用户查旋钮语义的**官方出口**（AGENTS.md 路由到这里）。
        # 此前它不存在 —— 文档指了一个 rc=2 的命令（review 抓到）。
        if "--list" in argv:
            print(knobs_table())
            return 0
        if argv and argv[0] in ("--help", "-h"):
            print(M("knobs.usage"), file=sys.stderr)
            return 0
        print(M("knobs.module_only"), file=sys.stderr)
        print(M("knobs.usage"), file=sys.stderr)
        return 2
    # 自证标题是**开发者界面**（check_i18n 的豁免面 ②），按设计保留一种语言。
    sys.exit(main_selftest_or(sys.argv[1:],
                              M("gate.title.knobs"),
                              _cases, _run))

