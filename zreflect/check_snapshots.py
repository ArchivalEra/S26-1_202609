#!/usr/bin/env python3
"""模块级快照闸门（**可插拔模块**，deepening 第 5 轮）。

守的是一条**踩了三次的坑**：

    from gate import GATE_REPO        # ← 值拷贝，此刻冻结
    ...
    gate.GATE_REPO = other_repo       # ← 后来改了，上面那个副本不知道
    subprocess.run(..., cwd=GATE_REPO)  # ← 还在用旧仓

`from X import CONST` 在 Python 里是**值拷贝**，不是引用。若 `CONST` 之后会被
重新赋值（`gate.GATE_REPO` 就是，任何夹具都会改它），所有拷贝都变成**陈旧快照** ——
而且失败得没有声音：不报错、不抛异常，只是悄悄地读错仓库。

本仓实际踩到三次：

  1. `i18n.pack_dir()` 用 GATE_REPO 相对 ⇒ 跨仓夹具里装载器找不到包（0/15 全红）
  2. `knobs.installed_langs()` 同类
  3. `check_envfile` 的自证想改 `os.environ["GATE_REPO"]` 却发现无效（`repo()`
     读的是模块级变量，不是环境变量）

第三次最典型：**作者以为改环境变量就够了**，因为看不见「这个值是 import 时
定下的」。本闸门把这个隐形耦合变成可判定的。

## 判据（AST，零执行）

对 `zreflect/*.py` 里每一条 `from <本地模块> import <大写名>`：

  · 若 `<大写名>` 在**源模块里是模块级可赋值名字**（且不是函数 / 常量数据），
    且导入方**在运行路径上用了它** ⇒ 报。

「模块级可赋值」的判据：源模块里有模块顶层的 `NAME = ...` 赋值，且该名字
**不是** frozen 数据（`REGISTRY` 这类只在 import 时构造一次、此后没人改的）。

诚实边界（**三条，都是写明的缺口**）：

 1. 静态判据只会看「谁 import 了可变全局」，**判不出**「这里改它是否真的发生过」。
    所以它报的是**风险形状**，不是已发生的事故。
 2. **类属性不报**：`class C: OUT = repo(...)` 在 import 时同样会冻结，但判据只
    收 `ast.Assign` / `ast.AnnAssign` 的**模块顶层**赋值。取舍理由：类属性是
    「类定义的一部分」，读它要写 `C.OUT`，语义上不像模块级常量那样容易被当成
    全局配置散播；而且真仓目前没有这种写法（实测扫描 0 处）。若将来出现，
    这里应该补判据而不是放宽 —— 现在**不假装覆盖**。
 3. 扫描集**之外**的模块做赋值（如 `tools/` 里的脚本改 `gate.GATE_REPO`）看不见。
    扫描面由 `REFLECT_SNAPSHOT_ROOT` 定，这是可插拔闸门的设计边界。

修法永远是同一个：改成 `import gate` + `gate.GATE_REPO`（每次读属性，不拷贝）。
"""
from __future__ import annotations

import ast
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gate  # noqa: E402
from gate import fatal, finish, main_selftest_or, meta  # noqa: E402
from i18n import M  # noqa: E402

# ⚠️ 默认值**不是空**：本闸门守的正是本仓自己的代码（`zreflect/*.py`），
# 所以它对任何 Einfacht 落地的仓库都该默认生效。此前默认空 ⇒ 旋钮没人配 ⇒
# 活体 `registry --run commit` 里它永远是 `off`（实测：CI/hook/自证三处都没配）。
# 「闸门存在、自证绿、但从没跑过」正是本仓立身要消灭的假绿。
KNOB = "REFLECT_SNAPSHOT_ROOT"
# 默认扫描面不再存这里：未配旋钮 ⇒ 锚 `gate.zdir()`（工具仓自己的
# zreflect/，cwd 无关）。曾有一个 `DEFAULT_ROOT = "zreflect"` 裸相对名，
# 判据改锚工具仓后它成了死默认（knobs.dead_default 抓到）—— 删。# ⚠️ **不再用手写名单**。此前这里是一串硬编码模块名（`("gate", "knobs", …)`），
# 违反 AGENTS「手写名录一定会漂」：全仓 28 个 `zreflect/*.py` 里只有 12 个在册，
# 另外 16 个（全部 `check_*.py`）作为**被导入源**时判据完全看不到。
# 现在是**发现式**：扫描面里每个 `.py` 都是候选源模块 —— 名单 = 扫描面本身。
# （第三方库不会被误收：只认 `from X import …` 且 X 在扫描面里。）


def _module_level_assigns(tree):
    """模块顶层被赋值的名字集合（`NAME = ...` / `NAME: T = ...`）。"""
    out = set()
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    out.add(t.id)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            out.add(node.target.id)
    return out


def _aliases_of(trees, src_mod):
    """扫描面里 `import <src_mod> as <alias>` 的别名集合（`_reassigned_elsewhere` 用）。"""
    return {a.asname for tree in trees.values()
            for node in ast.walk(tree) if isinstance(node, ast.Import)
            for a in node.names if a.name == src_mod and a.asname}


def _import_aliases(trees):
    """`import <mod> as <alias>` ⇒ `{alias: mod}`（别名也指向那个模块）。"""
    aliases = {}
    for _m, tree in trees.items():
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for a in node.names:
                    if a.asname:
                        aliases[a.asname] = a.name
    return aliases


def _assign_targets(node):
    """一个赋值类节点写到的全部 target（`Assign` / `AnnAssign` / `AugAssign`）。"""
    if isinstance(node, ast.Assign):
        return node.targets
    if isinstance(node, (ast.AnnAssign, ast.AugAssign)):
        return [node.target]
    return []


def _attribute_mutations(tree, aliases):
    """形状①：`<src_mod>.<name> = …` 或 `<alias>.<name> = …`。"""
    out = set()
    for node in ast.walk(tree):
        for t in _assign_targets(node):
            if isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name):
                owner = t.value.id
                out.add((aliases.get(owner, owner), t.attr))
    return out


def _module_global_mutations(tree, module):
    """形状②：模块自己用 `global NAME` + 再赋值（同模块内改写）。"""
    globs = _globals_of(tree)
    out = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Assign, ast.AugAssign)):
            continue
        for t in _assign_targets(node):
            if isinstance(t, ast.Name) and t.id in globs:
                out.add((module, t.id))
    return out


def _mutated_globals(trees):
    """**一次性索引**：哪些 `(模块, 名字)` 会在运行期被别人赋值。

    ⚠️ 此前 `_reassigned_elsewhere(trees, src_mod, name)` 对**每个候选名**都
    重新 `ast.walk` 全部模块 —— 115 个名字 × 28 个模块的 AST ⇒ 6.3 秒
    （实测：占整个闸门 6.5s 的 97%）。索引建一次即可，查询 O(1)。

    判据形状的关键：不是「源模块自己赋值几次」（`gate.GATE_REPO` 只赋一次），
    而是「**别人会不会改它**」—— `check_envfile` / `i18n` 的自证都在
    `gate.GATE_REPO = …` 改它。只赋值一次、无人改写的常量（`REGISTRY`）不报
    —— 它们的语义是「一个数据表」，拷贝与引用没区别。

    两个形状各是一个具名 helper（跨模块属性赋值 / 模块内 global 改写）：
    拼在一个函数里时两层嵌套 + 三种声明的 isinstance 分支把复杂度推到 15。
    """
    aliases = _import_aliases(trees)
    out = set()
    for module, tree in trees.items():
        out |= _attribute_mutations(tree, aliases)
        out |= _module_global_mutations(tree, module)
    return out


def _globals_of(tree):
    """这个模块里所有 `global <name>` 声明涉及的名字。"""
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Global):
            out.update(node.names)
    return out


def _uses_global(tree, name):
    """这个模块里有没有 `global <name>` 声明（name=None ⇒ 有没有任何 global）。"""
    g = _globals_of(tree)
    return bool(g) if name is None else name in g


def _functions_reading(src_tree, name):
    """`src_mod` 里**（传递地）**读 `name` 的顶层函数名。

    派生快照常经由封装出现：`OUT = repo(LEDGER_NAME)` —— 表达式文本里没有
    `gate.GATE_REPO`，但 `repo()` 的体里有。只看一跳会漏**两跳**：
    `def a(): return repo(x)` 然后 `OUT = a()`（实测 []）。
    所以这里做**闭包**：反复把「调用了已知 reader 的函数」也加入 reader 集合，
    直到不动点。对 `zreflect` 这种 28 个模块的规模，几轮就收敛。
    """
    defs = {}
    for node in src_tree.body:
        if isinstance(node, ast.FunctionDef):
            calls = {getattr(c.func, "id", None) or getattr(c.func, "attr", None)
                     for c in ast.walk(node) if isinstance(c, ast.Call)}
            reads = any(isinstance(n, ast.Name) and n.id == name
                        and isinstance(n.ctx, ast.Load)
                        for n in ast.walk(node))
            defs[node.name] = (reads, calls - {None})
    readers = {f for f, (reads, _c) in defs.items() if reads}
    changed = True
    while changed:
        changed = False
        for f, (_reads, calls) in defs.items():
            if f not in readers and (calls & readers):
                readers.add(f)
                changed = True
    return readers


def _calls_outside_lambda(node):
    """`node` 里**不在 lambda 体内**的 Call 节点（lambda 体是延迟求值）。

    ⚠️ 必须把 `node` **自己**也算进去：`OUT = repo("L")` 的 `node.value` 自身
    就是 Call —— 只遍历 children 会漏掉它（实测：派生检测全失效）。
    """
    out = []
    def walk(n):
        if isinstance(n, ast.Call):
            out.append(n)
        for child in ast.iter_child_nodes(n):
            if isinstance(child, ast.Lambda):
                continue            # 整条 lambda 体跳过
            walk(child)
    walk(node)
    return out


def _call_graph(tree):
    """本模块每个顶层函数**调用的裸函数名**集合（一次性建，避免重复 ast.walk）。"""
    out = {}
    for node in tree.body:
        if not isinstance(node, ast.FunctionDef):
            continue
        out[node.name] = {n.func.id for n in ast.walk(node)
                          if isinstance(n, ast.Call)
                          and isinstance(n.func, ast.Name)}
    return out


def _reaches(node, readers, graph):
    """这个表达式**直接或经本模块的顶层函数**能到达 `readers` 里的函数吗？

    ⚠️ 用预建的调用图（`graph`）+ 显式栈做可达性，**不递归、不重复 walk**：
    此前版本对每个派生节点都 `ast.walk` 整个函数体并递归下去，遇到互相递归的
    函数直接挂死（实测：真仓 28 模块 timeout 60s 不返回）。

    两条防误报约束（此前都会假红，实测）：
      · 本模块自己定义的同名函数不算「源模块的 reader」（遮蔽）——
        它仍会被沿调用图继续追（它自己可能转调 repo）
      · 属性调用（`tools.repo(…)`）不算 —— `getattr(...​,"attr")` 会匹配任何
        模块的同名函数，与本模块的 repo 不是同一个东西
    """
    # ⚠️ **不进 lambda 体**：`CASES = [("label", lambda: check_doc(..., repo(...)))]`
    # 里的调用是**延迟执行**的，import 时不求值，不会被冻结。此前用 `ast.walk`
    # 无差别扫，把 lambda 体内的 repo 也算进去 ⇒ 误报 `facts.CASES`（实测）。
    seen = set()
    stack = [n.func.id for n in _calls_outside_lambda(node)
             if isinstance(n.func, ast.Name)]
    while stack:
        fn = stack.pop()
        if fn in seen:
            continue
        seen.add(fn)
        if fn in graph:
            stack.extend(graph[fn])     # 本地函数：继续追它调用的
        elif fn in readers:
            return True                 # 源模块里的 reader
    return False


def _module_level_assigns_all(tree):
    """模块顶层的所有赋值节点（含类体里的属性赋值）。

    三种形状都认（此前只认 `ast.Assign`，漏报另外两种 —— review 实测）：
      · `OUT = repo(...)`              普通赋值
      · `OUT: str = repo(...)`         带类型注解（AnnAssign）
      · `class C: OUT = repo(...)`     类属性（同样在 import 时求值）
    """
    nodes = []
    for node in tree.body:
        if isinstance(node, ast.Assign) or (
                isinstance(node, ast.AnnAssign) and node.value is not None):
            nodes.append(node)
        elif isinstance(node, ast.ClassDef):
            nodes.extend(n for n in node.body
                         if isinstance(n, ast.Assign)
                         or (isinstance(n, ast.AnnAssign)
                             and n.value is not None))
    return nodes


def _target_names(node):
    """赋值节点的目标名（`Assign` 有 `.targets`，`AnnAssign` 只有 `.target`）。"""
    return [t.id for t in (getattr(node, "targets", None) or [node.target])
            if isinstance(t, ast.Name)]


def _module_level_derivations(tree, src_mod, name, readers=(), graph=None):
    """模块顶层有没有 `OTHER = <表达式里含 src_mod.name>`？那是**同一类快照**。

    两种写法都会在 import 那一刻冻结：
        from gate import GATE_REPO      # 值拷贝
        OUT = repo(LEDGER_NAME)        # repo() 内部读 gate.GATE_REPO ⇒ 冻结成字符串

    只抓第一种会漏掉第二种 —— 而那正是本仓实际存在的一处（`facts.py:35`，
    实测：改 `gate.GATE_REPO` 后 `facts.OUT` 仍是旧路径）。
    """
    marker = "%s.%s" % (src_mod, name)
    hits = []
    for node in _module_level_assigns_all(tree):
        text = ast.unparse(node.value)
        hit = marker in text or (bool(readers)
                                 and _reaches(node.value, readers, graph))
        if hit:
            hits += _target_names(node)
    return hits


def _loaded_names(tree):
    """这个模块里**被读取**（Load）的所有名字集合（一次性建，供 `_used_in_module`）。

    ⚠️ 此前 `_used_in_module(tree, name)` 对**每个候选名**都 `ast.walk` 整棵树 —— 
    在 28 个模块 × 数百个名字的规模下退化成 1000 万次 `ast.walk`
    （实测：cProfile 32s，`iter_child_nodes` 被调 2000 万次）。缓存成集合后
    一次遍历即可，查询 O(1)。
    """
    return {n.id for n in ast.walk(tree)
            if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}


def _index(sources):
    """建索引：AST / 模块级赋值 / 被别处改的名字 / 读取名 / 调用图 / 读者集。

    ⚠️ 全部**预计算**。此前在双重循环里对每个 `(模块 × 名字)` 都重算一次
    `ast.walk` 全部模块的 AST ⇒ O(M²·N)，实测 400+ 次调用后 timeout 60s。
    这些量都只依赖单个模块（或单个 `(src_mod, name)` 对），与调用方无关。
    """
    trees = {}
    for mod, src in sources.items():
        try:
            trees[mod] = ast.parse(src)
        except SyntaxError:
            continue
    assigned = {mod: _module_level_assigns(tree) for mod, tree in trees.items()}
    mutated = _mutated_globals(trees)
    mutable = {(m, n) for m, names in assigned.items() for n in names
               if (m, n) in mutated}
    return {
        "trees": trees,
        "assigned": assigned,
        "mutable": mutable,
        "loaded": {mod: _loaded_names(tree) for mod, tree in trees.items()},
        "graph": {mod: _call_graph(tree) for mod, tree in trees.items()},
        "readers": {(m, n): _functions_reading(trees[m], n)
                    for (m, n) in mutable},
    }


def _derived_hits(ix, mod, tree, src_mod, names):
    """一个消费模块里，来自 `src_mod` 的可变全局被派生存成常量的名字。"""
    loaded = ix["loaded"][mod]
    graph = ix["graph"][mod]
    hits = []
    for name in sorted(names):
        if (src_mod, name) not in ix["mutable"]:
            continue
        readers = ix["readers"].get((src_mod, name), set())
        for derived in _module_level_derivations(tree, src_mod, name,
                                                 readers, graph):
            if derived in loaded:
                hits.append(M("snapshot.derived_copy",
                              file=mod + ".py", derived=derived,
                              source=src_mod, imported=name))
    return hits


def _derived_copy_problems(ix):
    """② **派生快照**：模块顶层把「含可变全局的表达式」存成常量（同 import 一样
    会冻住）。"""
    out = []
    for mod, tree in sorted(ix["trees"].items()):
        for src_mod, names in sorted(ix["assigned"].items()):
            out += _derived_hits(ix, mod, tree, src_mod, names)
    return out


def _mutable_copy_problems(ix):
    """① **值快照**：`from <本地模块> import ALL_CAPS`，而那个全局被别处重赋值
    ⇒ 拷贝停在 import 那一刻。"""
    out = []
    for mod, tree in sorted(ix["trees"].items()):
        for node in ast.walk(tree):
            if not isinstance(node, ast.ImportFrom):
                continue
            for name in _frozen_imports(ix, mod, node):
                out.append(M("snapshot.mutable_copy",
                             file=mod + ".py", imported=name,
                             source=node.module))
    return out


def _frozen_imports(ix, mod, node):
    """这条 `from <src> import …` 里**哪些名字是值快照**（拷贝会冻住）。

    五道守全是「不值得报」的出口，各自是不同理由 —— 挤在调用点就是 5 个
    连续 `continue`（复杂度 11）。抽成具名函数后，调用点只剩一句。
    """
    src_mod = node.module
    if src_mod not in ix["trees"]:
        return []                       # 不在扫描面里 ⇒ 不是本地兄弟模块
    if src_mod not in ix["assigned"]:
        return []                       # 源模块不在扫描面里 ⇒ 不猜
    loaded = ix["loaded"][mod]
    out = []
    for alias in node.names:
        name = alias.name
        if name != name.upper():
            continue                    # 函数 / 类 / 小写名不是「值快照」
        if name not in ix["assigned"][src_mod]:
            continue                    # 源模块没有这个模块级名字
        if (src_mod, name) not in ix["mutable"]:
            continue                    # 没人改它 ⇒ 拷贝安全
        if (alias.asname or name) not in loaded:
            continue                    # 死导入，不报
        out.append(name)
    return out


def problems(paths=None, sources=None):
    """纯函数：返回问题清单（空 = 没有快照风险）。

    `sources` 可注入 `{模块名: 源码}`（自证用，零文件 I/O）。

    只编排：索引一次建好（`_index`），两段检测各读它（`_mutable_copy_problems` /
    `_derived_copy_problems`）。此前两段拼在同一个函数里，索引与检测交错 ——
    改一段要读懂另一段。
    """
    if sources is None:
        if paths is None:
            return [M("snapshot.empty_scan")]
        sources = {}
        for name, src in paths:
            sources[name[:-3] if name.endswith(".py") else name] = src
    if not sources:
        return [M("snapshot.empty_scan")]
    ix = _index(sources)
    return _derived_copy_problems(ix) + _mutable_copy_problems(ix)


def collect(root, configured=False):
    """收哪些 `.py` —— 见 `gate.scanned_sources`（两条口径的唯一产地）。"""
    return gate.scanned_sources(root, configured)


def run(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    # ⚠️ **`REFLECT_SNAPSHOT_ROOT` 为空 ⇒ 扫套件自己的 `zreflect/`**，
    # 不是「未启用」。（README 曾把这条说反了：「empty ⇒ that gate says out
    # loud it is off」—— 实测为空时它照跑并对套件报 `snapshot.ok`。）
    # 为什么这样设计：这道闸门守的是「跨模块 import 的可变全局」，套件自己
    # 就是最大的受害者（`gate.GATE_REPO` 被多道自证改写），所以默认面是它。
    # 要扫**你的代码**就显式设 `REFLECT_SNAPSHOT_ROOT=<目录>`。
    configured = os.environ.get(KNOB, "").strip()
    # ⚠️ **未配 ⇒ 锚工具仓**（`gate.zdir()`），不是裸相对名 —— 后者取决于
    # cwd：在仓根跑是对的，在别处跑（harness / 钩子的 cwd 不保证）就
    # `scan_empty_dir` FATAL（实测：cd /tmp 后 rc=2）。
    # 显式配了 ⇒ **被检查仓**相对（用户在 env 里写的是相对仓根的名字）。
    root = gate.zdir() if not configured \
        else os.path.join(gate.GATE_REPO, configured)
    if not os.path.isdir(root):
        # 旋钮指向不存在的目录 ⇒ 配置坏（不是「没启用」）
        return fatal(M("snapshot.scan_empty_dir", root=root))
    paths = collect(root, configured=bool(configured))
    if not paths:
        return fatal(M("snapshot.scan_empty_dir", root=root))
    return finish(M("snapshot.title"), problems(paths),
                  M("snapshot.ok", files=len(paths)))


ALIAS_GATE = 'GATE_REPO = "/repo"\n'
ALIAS_USER = 'import gate as g\ng.GATE_REPO = "/other"\n'
ALIAS_VICTIM = 'from gate import GATE_REPO\ndef f():\n    return GATE_REPO\n'
# 一个此前不在 LOCAL_MODULES 里的模块（`check_zzz`）作为**源模块**
CHECK_AS_SOURCE = 'SHARED = "/x"\n'
CHECK_AS_VICTIM = ('import check_zzz\ncheck_zzz.SHARED = "/y"\n'
                   'from check_zzz import SHARED\ndef f():\n    return SHARED\n')

GATE_WITH_REPO = """
GATE_REPO = "/repo"
def repo(*parts):
    return os.path.join(GATE_REPO, *parts)
def set_repo(p):
    global GATE_REPO
    GATE_REPO = p
"""


def _fixtures():
    """夹具源码（英文：它们是被校验的**输入**，不是本体输出）。

    ⚠️ 必须**在函数里**构造，不能放模块级常量：闸门扫的正是「模块顶层被赋值的
    表达式」，模块级夹具会被它自己当成派生快照 —— 实测：提到模块级之后
    `snapshot.derived_copy(derived='fx["ok_style"]', source='gate')` 自报。
    判据没错，是夹具放错了层。
    """
    return {
        "good": "GATE_REPO = \"/repo\"\nCONST = [1]\n",
        "good_user": "from gate import CONST\ndef f():\n    return CONST\n",
        "bad_gate": ("GATE_REPO = \"/repo\"\ndef set_repo(p):\n"
                     "    global GATE_REPO\n    GATE_REPO = p\n"),
        "bad_user": "from gate import GATE_REPO\ndef f():\n    return GATE_REPO\n",
        "ok_style": "import gate\ndef f():\n    return gate.GATE_REPO\n",
    }


def _cases_value_copy(fx):
    """① 值拷贝：常量安全 / 属性写法安全 / 可变全局被拷必须报。"""
    return [
        ("snapshot.constant_copy_is_fine",
         lambda: problems(sources={"gate": fx["good"],
                                   "check_x": fx["good_user"]}) == []),
        ("snapshot.attribute_style_is_fine",
         lambda: problems(sources={"gate": fx["bad_gate"],
                                   "check_x": fx["ok_style"]}) == []),
        ("\u2605 snapshot.mutable_copy",
         lambda: [p.code for p in problems(
             sources={"gate": fx["bad_gate"], "check_x": fx["bad_user"]})
         ] == ["snapshot.mutable_copy"]),
        # 死导入不报（import 了没用的不算风险）
        ("snapshot.dead_import_not_reported",
         lambda: problems(sources={
             "gate": fx["bad_gate"],
             "check_x": "from gate import GATE_REPO\n"}) == []),
        # 别名模块赋值（`import gate as g; g.GATE_REPO = …`）—— 与
        # `gate.GATE_REPO = …` 是同一件事的另一种写法，此前漏报（实测 []）
        ("\u2605 snapshot.mutable_copy_via_alias",
         lambda: [p.code for p in problems(sources={
             "gate": ALIAS_GATE, "usr": ALIAS_USER, "victim": ALIAS_VICTIM})
         ] == ["snapshot.mutable_copy"]),
        # 发现式源模块：**扫描面里的任何 .py** 都可作为源模块，不再只认
        # 手写名单里的 12 个名字（此前 16 个 check_*.py 全部看不见）
        ("\u2605 snapshot.source_from_any_module",
         lambda: [p.code for p in problems(sources={
             "check_zzz": CHECK_AS_SOURCE, "victim": CHECK_AS_VICTIM})
         ] == ["snapshot.mutable_copy"]),
    ]


def _cases_derived():
    """② 派生快照：顶层把「经薄封装读到可变全局」的表达式存成常量。"""
    return [
        # `OUT = repo(NAME)`，repo() 体内读 GATE_REPO ⇒ 冻在 import 那一刻
        ("\u2605 snapshot.derived_copy",
         lambda: [p.code for p in problems(sources={
             "gate": GATE_WITH_REPO,
             "facts": "OUT = repo('L.json')\nprint(OUT)\n"})
         ] == ["snapshot.derived_copy"]),
        # 带类型注解的派生（`OUT: str = repo(...)`）—— 此前只认 `ast.Assign`，
        # 漏报 AnnAssign（review 实测 `[]`）
        ("\u2605 snapshot.derived_copy_annotated",
         lambda: [p.code for p in problems(sources={
             "gate": GATE_WITH_REPO,
             "facts": "OUT: str = repo('L.json')\nprint(OUT)\n"})
         ] == ["snapshot.derived_copy"]),
    ]


def _default_root_case():
    """**默认扫描面锚工具仓，与 cwd 无关**。

    ⚠️ 此前未配旋钮时用裸相对名 `zreflect` —— 在仓根跑是对的，cwd 在别处
    （harness / 钩子的 cwd 不保证）就 `scan_empty_dir` FATAL（实测：cd /tmp
    后 rc=2）。这条用例**换到临时目录**再跑真闸门，钉住「cwd 不是前提」。
    """
    import subprocess  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    here = os.path.dirname(os.path.abspath(__file__))
    d = tempfile.mkdtemp()
    env = {k: v for k, v in os.environ.items() if k != KNOB}
    try:
        p = subprocess.run([sys.executable, os.path.join(here, __file__)],
                           cwd=d, env=env, capture_output=True, text=True,
                           timeout=120, encoding="utf-8", errors="replace")
        # ⚠️ 只判 **rc**，不匹配输出措辞：`snapshot.ok(...)` 是 code，装了
        # 语言包会渲染成自然语言（实测：REFLECT_LANG=en 下这条判据红 ——
        # 它在拿当前语言包的措辞当判据，第一版就是自己的反例）。
        return p.returncode == 0
    finally:
        import shutil  # noqa: PLC0415
        shutil.rmtree(d, True)


def _cases():
    """三条：值拷贝 / 派生快照 / 空输入。

    ①② 各是一个具名组（夹具源码也提到模块级常量了 —— 80 行函数里那些
    三引号字符串占了将近三分之一、和断言交错）。
    """
    return (_cases_value_copy(_fixtures()) + _cases_derived()
            + [("\u2605 snapshot.empty_scan",
                lambda: problems(sources={}) != []),
               ("★ snapshot.default_root_is_cwd_free",
                lambda: _default_root_case())])


GATE = meta("模块级快照闸门",
            "跨模块 import 的可变全局是值拷贝（陈旧快照）：改成 import 模块 + 读属性",
            knobs=("REFLECT_SNAPSHOT_ROOT",))

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:],
                              M("gate.title.snapshot"), _cases(), run))
