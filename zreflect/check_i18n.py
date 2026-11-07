#!/usr/bin/env python3
"""语言覆盖闸门（**可插拔模块**，issue #26）：本体真·零语言化的机械保证。

它守的是一条**封闭判据**——「本体里不许有用户可见的自然语言」：

  · **消息**必须是 `M(<字面量 code>, **params)`——不许 `out.append("中文…")`
    这种裸字面量（那是「本体在说人话」，正是本条要消灭的）；
  · **自证用例标签**按用户决策（1C）**id 化**——不许自然语言句子；
  · **docstring** 豁免（维护者文档，不是输出）；
  · **语言包**里可以有任何自然语言（那是可选数据，不在本体里）。

为什么这条判据必须存在（不给就是「看起来零语言、实际漏一半」）：

  语言包是可选的 ⇒ 用户可能只装 `en`。若本体里还藏着一条中文硬编码消息，
  它会在 en 用户屏幕上显示中文，且**没有任何东西会报**——正是本仓立身
  要消灭的静默退化。这条闸门把「本体零语言」从口号变成可判定。

## 它现在有四条判据族（第 16 轮的审视结论：**不拆**）

  1. **裸中文**（`bare_text`）—— 输出位置的 CJK 字符串常量
  2. **PINNED 声明面** —— `PINNED:` 标记的函数/常量整段豁免（AUTO 机器块必须
     固定语言，跟随语言就不收敛）
  3. **夹具字面量**（`fixture_literal`）—— `_cases()` 里的中文只许在**标签**
     与 **docstring**；夹具源码必须码点构造（同一错误犯三次后补的判据）
  4. **消息必须走 M()** —— `_is_msg_call` / `_is_output_call` 的形状判据

**为什么不拆成四个闸门**：它们共享同一次 `ast.parse(src)` 与同一轮文件遍历。
拆开 = 四份重复的解析与遍历，而每一份都可能独立漂（本仓最痛的那种）。
四条判据族的**差异只在「什么算合法」**，那已经由各自的 helper 隔离
（`_declares_pinned` / `_fixture_literal_problems` / `cjk`）。共享解析是拆不动
的真实理由 —— 不是因为「它们看起来像一类」。

诚实边界（写明的缺口）：判据是 **AST 级**的——抓「裸中文字面量出现在输出位置」，
抓不到「用英文写的消息」（那仍是本体语言，但主体已零中文；要抓它需要
更复杂的语言识别，代价过大）。所以本闸门的强度 = 「零中文 + 消息必须走 M()」。
"""
from __future__ import annotations

import ast
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gate  # noqa: E402
import machine  # noqa: E402
from gate import fatal, finish, main_selftest_or, meta, repo  # noqa: E402
from i18n import M  # noqa: E402

# 未配旋钮时扫**这些**目录 —— 套件自己的全部 Python。
#
# ⚠️ 这个清单必须**覆盖套件的两半**（判据库 + 钩子入口）：只扫一半，就等于
# 「半个本体零语言」，而另一半的裸中文照样发得出去。
#
# ⚠️ 它**不该**包含任何宿主的目录 —— 那会把套件焊死在某个宿主的目录约定上。
# 曾经这里确实有过那样一项（同时扫描一个编辑器专用的钩子目录），而那种耦合
# 的完整经过与判据见 `retractions.json` 的 R-003 与 `doc.RULES` 的
# `host_agnostic`。历史不留在代码注释里：那既不该被维护，也会让
# `host_agnostic` 扫到自己（本文件正是它的扫描面）。
DEFAULT_ROOTS = ("zreflect", "reflect-hooks")
KNOB = "REFLECT_I18N_ROOT"


# CJK 统一表意文字的码点区间（U+4E00–U+9FFF）。**用码点常量而不是字面字符**：
# 写成 `"一"`/`"鿿"` 会让本闸门扫到自己的源码（那两个就是区间端点）——
# 实测踩到（报了两条「一」「鿿」的假违规）。
from i18n import CJK_LO, han  # noqa: E402

PINNED_MARK = "PINNED:"


def _declares_pinned(doc):
    """docstring 里有没有**带理由的** `PINNED:` 声明。

    ⚠️ 只认「`PINNED:` 后面还有字数 ≥ 8 的理由」：否则任何函数只要在
    docstring 里写个 `PINNED:` 就能把它的全部中文豁免（实测：一个普通
    `report_problem()` 加一行 `PINNED: x` 就全豁免）。豁免必须说明「为什么
    这段文本不能翻译」—— 与 `REFLECT_INVARIANTS` 的 `why` 必填同一条纪律。
    """
    if not doc or PINNED_MARK not in doc:
        return False
    idx = doc.index(PINNED_MARK)
    reason = doc[idx + len(PINNED_MARK):].strip()
    # 理由取到第一个句号 / 换行为止（一句话够用）
    for sep in ("\n", "。", ". "):
        cut = reason.find(sep)
        if cut != -1:
            reason = reason[:cut]
    return len(reason.strip()) >= 8


def _pinned_by_comment(src, node):
    """该赋值语句**紧邻的上方**（前面连续注释块里）有没有 `PINNED:`。

    模块级常量没有 docstring，声明只能写在注释里。只向上看紧邻的注释块
    （遇到空行或非注释行就停）—— 不扫全文，避免「文件里任何一处写了
    PINNED: 就全豁免」。
    """
    lines = src.splitlines()
    i = node.lineno - 2                      # 上一行（0-based）
    while i >= 0:
        line = lines[i].strip()
        if line.startswith("#"):
            if PINNED_MARK in line:
                return True
            i -= 1
            continue
        break                                # 注释块结束
    return False


# 「含中文吗」的判据住在 `i18n.han()`（零语言制度的持有者），这里只转发 ——
# 两份区间常量会漂（C4）。
cjk = han



def _is_msg_call(node):
    """`M(code, **params)` 或 `i18n.M(...)`。"""
    if not isinstance(node, ast.Call):
        return False
    f = node.func
    return (isinstance(f, ast.Name) and f.id == "M") or \
           (isinstance(f, ast.Attribute) and f.attr == "M")


def _is_output_call(node):
    """产出用户可见文本的调用：append / print / off / fatal / finish。"""
    if not isinstance(node, ast.Call):
        return False
    f = node.func
    if isinstance(f, ast.Attribute) and f.attr == "append":
        return True
    return isinstance(f, ast.Name) and f.id in ("print", "off", "fatal", "finish")


def _docstring_node_id(node):
    """一个作用域节点里 docstring 常量的 id（没有 ⇒ None）。"""
    d = ast.get_docstring(node, clean=False)
    if not d:
        return None
    for n in ast.walk(node):
        if isinstance(n, ast.Constant) and n.value == d:
            return id(n)
    return None


def _doc_nodes(tree):
    """docstring 节点（豁免面①：docstring 不是写给用户的话）。"""
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef)):
            nid = _docstring_node_id(node)
            if nid is not None:
                out.add(nid)
    return out


def _msg_consts(tree):
    """`M(...)` 里的常量 id —— 那些是**合法位置**（消息走 M 就是对的）。"""
    out = set()
    for node in ast.walk(tree):
        if _is_msg_call(node):
            for n in ast.walk(node):
                if isinstance(n, ast.Constant):
                    out.add(id(n))
    return out


# 豁免形状①的调用名单：这些函数的实参是**声明数据 / 匹配器数据**，不是
# 给用户看的句子。⚠️ 自证标题**不在**其中（用户裁决：选英文出中文不允许）。
_EXEMPT_CALLS = ("meta", "module_meta", "Rule", "compile",
                 "startswith", "endswith", "match", "search", "fullmatch", "find")


def _branch_constants(node):
    """`node` 子树里全部字符串常量节点的 id（豁免面用）。"""
    return {id(n) for n in ast.walk(node) if isinstance(n, ast.Constant)}


def _exempt_call_args(tree):
    """① 调用实参：`meta(…)` / `module_meta(…)` / `Rule(…)` / `re.compile(…)` 等。"""
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            f = node.func
            fn = getattr(f, "id", "") or getattr(f, "attr", "")
            if fn in _EXEMPT_CALLS:
                out |= _branch_constants(node)
    return out


def _pinned_constants(tree, src):
    """② `PINNED:` 声明面（AUTO 机器块：固定语言、逐字节对账）。

    按**声明**收编，不按名字 —— 手写名单一定会漂（deepening 第 8 轮）。
    """
    out = set()
    for node in ast.walk(tree):
        fn_pinned = (isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                     and _declares_pinned(ast.get_docstring(node, clean=False)))
        assign_pinned = (isinstance(node, ast.Assign)
                         and _pinned_by_comment(src, node))
        if fn_pinned or assign_pinned:
            out |= _branch_constants(node)
    return out


def _exempt_ids(tree, name, src):
    """**声明的**豁免面（不是猜的）。每一条都要说清为什么，否则豁免会变成
    下一张会漂的手写名单。三段各是一个具名函数（见各自文档）。

    ③ 语言包装载器自身的错误（`i18n.py`）：`MissingPack` 的文案**不能用
    M()**（循环依赖：M 依赖语言包，包坏了才抛它）。文件级豁免。
    """
    out = _exempt_call_args(tree) | _pinned_constants(tree, src)
    if name == "i18n.py":
        out |= {id(n) for n in ast.walk(tree) if isinstance(n, ast.Constant)}
    return out


def _bare_text_problems(name, tree, src):
    """一条源码里的**裸自然语言**（四类豁免之外、且不是 id 化标签）。"""
    out = []
    doc_nodes = _doc_nodes(tree)
    msg_consts = _msg_consts(tree)
    exempt = _exempt_ids(tree, name, src)
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Constant) and isinstance(node.value, str)):
            continue
        v = node.value
        if not cjk(v):
            continue
        if id(node) in doc_nodes or id(node) in msg_consts or id(node) in exempt:
            continue
        # 用户决策 1C：标签**以点分 id 开头**即可，后面可跟简短中文括注。
        if re.match(r"^\s*(★\s*)?[a-z_][a-z0-9_]*(\.[a-z0-9_.]+)+", v):
            continue
        out.append(M("i18n_cover.bare_text",
                     file=name, lineno=node.lineno, text=v[:40]))
    return out

def _non_literal_code_problems(name, tree):
    """`M(...)` 的首参**不许是算出来的** code（条件表达式 / 拼接 / f-string / 调用）。

    为什么值得一条判据：`i18n.M` 的 docstring 从第一天就写着「`code` 必须是
    字面量（覆盖闸门会拒变量 code）」—— 而**没有任何闸门执行这条**。
    实测的代价：`check_envfile` 里写着 `M("a" if is_dir else "b", …)`，
    两个 code 都真实存在于语言包里、也真的会渲染给用户，但
    `knobs.used_codes()`（正则扫字面 `M("..."`）只抓得到第一个 ⇒
    另一个对 `pack_coverage` **完全不可见**。它在包完整性对账里是一个洞，
    而不是一条违规 —— 洞比违规更坏，因为没有任何一行输出说它存在。

    **转发不算违规**：`_say(code)` 这种薄壳、`_Semantic` 的延迟渲染、以及
    遍历语言包做完整性自证的探针，它们的 code 在**调用点**是字面量或者
    **就是包里的键**。让它们变形去满足一条形状判据是本末倒置。
    所以这里只抓**表达式**：`IfExp` / `BinOp` / `JoinedStr` / `Call` /
    `Subscript` —— 那才是「运行时才拼出来、静态无法枚举」的那一类。

    **诚实边界**：首参是 `Name` / `Attribute` 时**不查**。它可能是合法转发，
    也可能是从别处传来的非字面量，静态上无法区分；逐调用点做类型分析代价
    过大。这条边界写在这里，而不是假装判据覆盖了它。
    """
    computed = (ast.IfExp, ast.BinOp, ast.JoinedStr, ast.Call, ast.Subscript)
    out = []
    for node in ast.walk(tree):
        if not _is_msg_call(node) or not node.args:
            continue
        first = node.args[0]
        if isinstance(first, ast.Constant) and isinstance(first.value, str):
            continue
        if not isinstance(first, computed):
            continue                       # 转发（见诚实边界）
        out.append(M("i18n_cover.code_not_literal",
                     file=name, lineno=node.lineno,
                     kind=type(first).__name__))
    return out


def problems(paths):
    """纯函数：返回问题清单（空 = 零语言）。`paths` = [(名字, 源码文本)]。

    `paths` 可注入 ⇒ 自证用假源码，零文件 I/O。

    四段（各是 helper）：`_doc_nodes` / `_msg_consts` / `_exempt_ids` /
    `_bare_text_problems`。本函数只编排 —— 111 行 → 15 行。
    """
    if not paths:
        return [M("i18n_cover.empty_scan")]
    out = []
    # ⚠️ **文件名本身**也是攻击面：一个叫 `evil\nOFF: x.py` 的文件，一旦名字
    # 被渲染进消息（`i18n_cover.bare_text(file=…)` 这类），就会伪造出机器行。
    # 判据用 `machine.LINE_BREAKS` 的**同一张表**（C4：不能自己再写一份近似
    # 的分行符集）。此前这条完全没有 —— 实测把带换行的 .py 放进扫描面，
    # `i18n_cover.ok(files=34)` 照样绿。
    for name, _src in paths:
        if any(b in name for b in machine.LINE_BREAKS):
            out.append(M("i18n_cover.filename_has_line_break",
                         file=name.replace("\n", "\\n")[:60]))
    for name, src in paths:
        try:
            tree = ast.parse(src)
        except SyntaxError as e:
            out.append(M("i18n_cover.parse_error", file=name, error=e))
            continue
        out += _bare_text_problems(name, tree, src)
        out += _fixture_literal_problems(name, tree)
        out += _non_literal_code_problems(name, tree)
    return out


def _cases_scope(tree):
    """自证扫描范围：`_cases()` 本身 + 它**引用的同文件顶层 helper**。

    ⚠️ 范围要覆盖辅助函数：`_cases()` 调用的同文件 helper 也在自证路径上
    （实测踩到：判据锚点写进 `_streams_documented()`，本判据扫不到 ⇒ bare_text
    由主判据报出、这条漏）。

    ⚠️ **PINNED 的函数不算夹具 helper**：`_cases()` 会调用 `render_gates()`
    来测「渲染确定性」，但那个函数的文本是 AUTO 机器块、**本来就固定语言**
    （第 3 族已豁免）。把它拉进夹具扫描会误报（实测：7 条 PINNED 行被
    `fixture_literal` 抓）。豁免面之间必须互相尊重。
    """
    fns = [n for n in ast.walk(tree)
           if isinstance(n, ast.FunctionDef) and n.name == "_cases"]
    if not fns:
        return []
    fn = fns[0]
    called = {n.func.id for n in ast.walk(fn)
              if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)}
    helpers = [n for n in tree.body
               if isinstance(n, ast.FunctionDef) and n.name in called
               and not _declares_pinned(ast.get_docstring(n, clean=False))]
    return [fn] + helpers


def _docstring_nodes(bodies):
    """豁免面①：docstring 常量节点（维护者文档，不是输出）。"""
    out = set()
    for node in [n for b in bodies for n in ast.walk(b)]:
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef)):
            d = ast.get_docstring(node, clean=False)
            if not d:
                continue
            for n in ast.walk(node):
                if isinstance(n, ast.Constant) and n.value == d:
                    out.add(id(n))
                    break
    return out


def _label_nodes(bodies):
    """豁免面②：自证标签（`(标签, callable)` 元组的首元素）。"""
    return {id(node.elts[0])
            for b in bodies for node in ast.walk(b)
            if isinstance(node, ast.Tuple) and len(node.elts) == 2
            and isinstance(node.elts[0], ast.Constant)}


def _fixture_literal_problems(name, tree):
    """**自证夹具里不许有中文源码字面量**（必须是码点构造）。

    为什么这条值得判据：我踩了**三次**（第 8 轮 PINNED 理由、第 9 轮、
    第 13 轮）—— 每次都是「写个中文夹具/断言 → `check_i18n` 报 bare_text →
    才发现本文件自己在扫描面内」。第三次之后该把它变成机器判据。

    `_cases()` 里的 CJK 字符串常量只许出现在两种合法位置：
      · 自证**标签**（`(标签, callable)` 元组的首元素）—— 按 1C 决策，标签
        是 id 形式的，后面可以跟中文括注帮扫读
      · **docstring** —— 维护者文档，不是输出
    其余（夹具源码样例 / 断言里的中文串）⇒ 报。
    码点构造（`chr(CJK_LO)` / `_cj(n)`）产出的值**不在 AST 里**，天然不报 ——
    这就是正确的写法。

    三步各是一个 helper（范围 / 两种豁免面）：拼在一起时节点收集的两个
    独立循环 + 判定循环把复杂度推到 13。
    """
    bodies = _cases_scope(tree)
    if not bodies:
        return []
    exempt = _docstring_nodes(bodies) | _label_nodes(bodies)
    return [M("i18n_cover.fixture_literal",
              file=name, lineno=node.lineno, text=node.value[:40])
            for b in bodies for node in ast.walk(b)
            if isinstance(node, ast.Constant) and isinstance(node.value, str)
            and cjk(node.value) and id(node) not in exempt]


def sources_for(d, configured=False):
    """收哪些 `.py` —— 见 `gate.scanned_sources`（两条口径的唯一产地）。

    ⚠️ 这里曾经自己写了一遍那个三元判断，`check_snapshots.collect` 又写了
    一遍 —— 同一判据两份。现在只转调。
    """
    return gate.scanned_sources(d, configured)


def run(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    # ⚠️ 默认扫描根**不是空**：本闸门守的正是**套件自己**的代码，所以未配旋钮
    # 时扫**工具仓**的 `zreflect/`。此前 `DEFAULT_ROOT` 定义了却**从不使用**，
    # 旋钮没人配 ⇒ 活体 `registry --run commit` 里它永远 `off` ——
    # 「闸门存在、自证绿、但从没跑过」。与 `check_snapshots` 同一个病。
    #
    # 两条口径（与 `i18n.pack_dir()` 同款，别混）：
    #   · 未配 ⇒ **工具仓**的 `zreflect/`（跟着套件走，跨仓夹具也对）
    #   · 配了 ⇒ **被检查仓**相对的路径（env 里写的「相对仓库根的名字」）
    # 混成一条会导致跨仓夹具里 FATAL（实测：GATE_REPO=$tmp 时扫不到 zreflect/）。
    configured = os.environ.get(KNOB, "").strip()
    roots = [configured] if configured else list(DEFAULT_ROOTS)
    paths = []
    for root in roots:
        if configured:
            d = repo(root)
        else:
            d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", root)
            d = os.path.abspath(d)
        found = sources_for(d, configured=bool(configured))
        if not found and configured:
            return fatal(M("i18n_cover.scan_empty_dir", root=root))
        paths.extend(found)
    if not paths:
        return fatal(M("i18n_cover.scan_empty_dir", root=", ".join(roots)))
    return finish(M("i18n_cover.title"), problems(paths),
                  M("i18n_cover.ok", files=len(paths)))


_PH = re.compile(r"%\(([A-Za-z_][A-Za-z0-9_]*)\)"
                 r"(?:[#0\-+ ]*)(?:\d+)?(?:\.\d+)?[hlL]?([diouxXeEfFgGcrsa])")


def _params_for(template):
    """按模板的**转换符**造参数：`%d`/`%f` 给数字，其余给串。

    ⚠️ 一律给 `"v"` 会在 `%(count)d` 上炸 `TypeError`（实测）。
    """
    return {m.group(1): (3 if m.group(2) in "dixXfFeEgG" else "v")
            for m in _PH.finditer(template)}


def _null_output_has_no_cjk():
    """**未装语言包**时渲染全部 code，断言输出零 CJK。

    null 包只输出 `code(param=…)` —— 这是「没要语言包 ⇒ 零自然语言」的
    **行为**判据。穷举**全部** key，不手挑：手挑的清单漏过一次后加的命名空间
    （那时漏的是注入模板），而漏掉的部分照样绿。

    ⚠️ 注意它**不能**证明「模板里没有中文」：null 包根本不查表。后者由
    `_packs_match_their_language()` 管（装包渲染 + 按语言判 CJK）。
    """
    import i18n  # noqa: PLC0415
    try:
        table = i18n.load_pack("en")
    except Exception:                                    # noqa: BLE001
        return False              # 读不到真包 ⇒ 没法证明，不算通过
    if not table:
        return False              # 零值守卫
    probes = 0
    with i18n.bind(i18n.NULL):
        for code in sorted(table):
            if cjk(str(i18n.M(code, **_params_for(table[code])))):
                return False
            probes += 1
    return probes == len(table)


def _packs_match_their_language():
    """**装包**渲染：en / de 的每一条都不许含 CJK；zh 的 *文案* 可以含。

    这是「模板本身有没有中文」的真判据 —— null 包测不到它（null 不查表）。

    判据按语言：`en` / `de` 输出里出现 CJK ⇒ 那条模板没被翻译（或漏了）。
    `zh` 允许中文（那是它的语言）。只在**已装**的包里验，装了 `de` 就验 `de`。

    零值守卫：至少验到一个非 zh 的包。
    """
    import i18n  # noqa: PLC0415
    import knobs  # noqa: PLC0415
    checked = 0
    # **发现式**：非 zh 的已装包全查（不是手写 ("en","de") —— 新语言包
    # 不该被静默跳过）。zh 本体豁免（零语言制度允许 zh 只出现在语言包里）。
    for lang in sorted(knobs.installed_langs()):
        if lang == "zh":
            continue
        try:
            table = i18n.load_pack(lang)
        except Exception:                                # noqa: BLE001
            continue
        if not table:
            continue
        cat = i18n.Catalog.load(lang, {lang: table})
        with i18n.bind(cat):
            for code in sorted(table):
                if cjk(str(i18n.M(code, **_params_for(table[code])))):
                    return False
        checked += 1
    return checked >= 1




def _cj(n):
    """按码点造 n 个 CJK 字符（源码里不出现中文字面量，AST 求值后是真 CJK）。

    ⚠️ 夹具**必须含真中文**（否则「该报的必须报」用例没有对象），但字面量
    又会被本闸门扫到（闸门看的是 AST 求值后的值）。用码点构造是唯一干净的
    写法 —— 与 `cjk()` 里用码点区间同源。
    """
    return "".join(chr(CJK_LO + i) for i in range(n))


def _cjk_src(doc):
    """造一段含 CJK 字面量的源码（字面量用码点构造，本文件源码里不出现中文）。"""
    return ('def render_world_block(w):\n'
            '    """%s"""\n'
            '    return "%s"\n') % (doc, chr(CJK_LO) * 2)


# 理由用码点构造（本文件源码里不出现中文 —— 否则会被自己的覆盖闸门收编）
PINNED_FN = _cjk_src("PINNED: " + chr(CJK_LO) * 10 + " pinned, byte-exact.")
PINNED_BARE = _cjk_src("PINNED: x")
# 夹具字面量三例（值用码点拼，本文件源码不出现中文）
_CJ4 = chr(CJK_LO) * 4
FIXTURE_BAD = ("def _cases():\n"
               "    SAMPLE = \"" + _CJ4 + "\"\n"
               "    return [(\"ok.label\", lambda: SAMPLE == SAMPLE)]\n")
FIXTURE_LABEL = ("def _cases():\n"
                 "    return [(\"ok.label" + _CJ4 + "\", lambda: True)]\n")
FIXTURE_HELPER = ("def _helper():\n"
                  "    return \"" + _CJ4 + "\"\n"
                  "\n"
                  "def _cases():\n"
                  "    return [(\"ok\", lambda: _helper() == \"x\")]\n")
FIXTURE_DOC = ("def _cases():\n"
               "    \"\"\"doc " + _CJ4 + "\"\"\"\n"
               "    return [(\"ok\", lambda: True)]\n")
BARE_FN = _cjk_src("ordinary renderer.")


def _fixtures():
    """`_cases()` 用的源码样例（码点构造中文，不写字面量）。"""
    sample = _cj(4)
    return {
        "good": (
            '"""docstring may contain CJK (maintainer docs) - ' + sample + '"""\n'
            "from i18n import M\n"
            "\n"
            "def f(x):\n"
            "    out = []\n"
            "    out.append(M(\"replay.no_cmd\", key=x))\n"
            "    return out\n"),
        "bare": (
            "def f(x):\n"
            "    out = []\n"
            "    out.append(\"`%s` " + sample + "\" % x)  # CJK sample\n"
            "    return out\n"),
        "label": (
            "def _cases():\n"
            "    return [(\"" + sample + "\", lambda: True)]  # flagged\n"),
    }


def _cases_bare_text(fx):
    """① 裸自然语言：该报的必须报。"""
    return [
        ("i18n_cover.good_fixture",
         lambda: problems([("good.py", fx["good"])]) == []),
        ("★ i18n_cover.bare_text",
         lambda: [x.code for x in problems([("bare.py", fx["bare"])])
                  ] == ["i18n_cover.bare_text"]),
        ("★ i18n_cover.bare_text_in_label",
         lambda: [x.code for x in problems([("label.py", fx["label"])])
                  ] == ["i18n_cover.bare_text"]),
        ("★ i18n_cover.parse_error",
         lambda: [x.code for x in problems([("bad.py", "def (")])]
         == ["i18n_cover.parse_error"]),
    ]


def _cases_pinned():
    """② PINNED 按**声明**收编，不按名字（三向：豁免 / 未声明 / 冒充）。"""
    return [
        ("i18n_cover.pinned_by_declaration",
         lambda: problems([("r.py", PINNED_FN)]) == []),
        ("★ i18n_cover.undeclared_pinned_still_fires",
         lambda: [p.code for p in problems([("r.py", BARE_FN)])
                  ] == ["i18n_cover.bare_text"]),
        ("★ i18n_cover.pinned_needs_reason",
         lambda: [p.code for p in problems([("r.py", PINNED_BARE)])]
         == ["i18n_cover.bare_text"]),
    ]


def _cases_fixture_literal():
    """③ 自证夹具里不许有中文源码字面量（我踩了三次：第 8/9/13 轮）。"""
    return [
        ("★ i18n_cover.fixture_literal",
         lambda: [p.code for p in problems([("t.py", FIXTURE_BAD)])
                  ] == ["i18n_cover.bare_text", "i18n_cover.fixture_literal"]),
        ("★ i18n_cover.fixture_literal_in_helper",
         lambda: "i18n_cover.fixture_literal" in
         [p.code for p in problems([("t.py", FIXTURE_HELPER)])]),
        ("i18n_cover.fixture_label_cjk_is_allowed",
         lambda: problems([("t.py", FIXTURE_LABEL)]) == []),
        ("i18n_cover.fixture_docstring_cjk_is_allowed",
         lambda: problems([("t.py", FIXTURE_DOC)]) == []),
    ]


def _cases_code_literal():
    """④ `M(...)` 的 code 不许是算出来的（否则包完整性对它失去约束力）。"""
    return [
        ("★ i18n_cover.computed_code_is_rejected",
         lambda: [p.code for p in problems(
             [("c.py", ("from i18n import M\n"
                       "def f(x):\n"
                       "    return M(\"probe.a\" if x else \"probe.b\")\n"))])
         ] == ["i18n_cover.code_not_literal"]),
        ("i18n_cover.literal_code_is_fine",
         lambda: problems([("c.py", ("from i18n import M\n"
                                     "def f():\n"
                                     "    return M(\"probe.a\")\n"))]) == []),
        ("i18n_cover.forwarded_code_is_fine",
         lambda: problems([("c.py", ("from i18n import M\n"
                                     "def _say(code, **kw):\n"
                                     "    return M(code, **kw)\n"))]) == []),
    ]


def _cases_end_to_end():
    """⑤ 端到端 + 扫描面：静态判据抓不到的运行时泄漏。"""
    return [
        ("★ i18n_cover.null_pack_output_has_no_cjk",
         lambda: _null_output_has_no_cjk()),
        ("★ i18n_cover.packs_match_their_language",
         lambda: _packs_match_their_language()),
        ("★ i18n_cover.cjk_detector_can_red",
         lambda: cjk(chr(0x4E2D)) and not cjk("ascii only")),
        ("★ i18n_cover.hooks_dir_is_scanned",
         lambda: "reflect-hooks" in DEFAULT_ROOTS
         and "zreflect" in DEFAULT_ROOTS),
    ]


def _cases_input_guards():
    """⑥ 输入守卫：文件名本身也是攻击面；空输入必须报。"""
    return [
        ("★ i18n_cover.filename_line_break",
         lambda: [p.code for p in problems(
             [("evil" + chr(0x0A) + "OFF: x.py", "x = 1\n")])]
         == ["i18n_cover.filename_has_line_break"]),
        ("i18n_cover.filename_clean_ok",
         lambda: problems([("normal.py", "x = 1\n")]) == []),
        ("★ i18n_cover.empty_scan", lambda: problems([]) != []),
    ]


def _cases():
    """拼装六组夹具断言。**只拼装** —— 判据在各分组函数里。"""
    fx = _fixtures()
    return (_cases_bare_text(fx)
            + _cases_pinned()
            + _cases_fixture_literal()
            + _cases_code_literal()
            + _cases_end_to_end()
            + _cases_input_guards())


GATE = meta("语言覆盖闸门", "本体零语言：用户可见文本必须走 M(code)；语言包可选",
            knobs=("REFLECT_I18N_ROOT",))

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:],
                              M("gate.title.i18n_cover"), _cases(), run))
