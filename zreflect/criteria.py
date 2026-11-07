#!/usr/bin/env python3
"""名录判据：**「哪些东西必须一致」的机器对账**（registry 判据的一半）。

## 为什么从 registry.py 拆出来

`registry.py` 曾在同时干四件事：发现（AST 读声明行）、**对账判据**、渲染机器块、
CLI。判据占 1145 行 / 46 个函数 —— 是主体，且与「发现」的演进节奏完全不同：

  · 发现面随闸门增加而变（`GATE = meta(…)` 的字段）；
  · 判据面随「必须一致的两份」增加而变（C4 对账器）。

两者混在一个文件里，改任一侧都要在一个 1800 行的文件里找位置。拆开之后
`registry.py` 只剩发现 + 渲染 + CLI，`criteria.py` 只有判据。

## 这里装的七条对账

    dead_interface_problems      零消费者的公开函数（僵尸接口）
    shell_surface_problems       .sh 白名单（全 Python 化的守卫）
    trailing_newline_problems    文件必须以换行结尾（`py_lines` 两条量法的差）
    off_reason_problems          会 off 的闸门必须声明理由（三向 + 真实性 + 落点）
    reason_bases_agree           理由里的文件名落点与 env 插件口径一致（C4）
    path_rule_problems           「工具的 zreflect/」只能一个产地（C4 ⑧）
    dependency_coverage_problems 被消费的平台函数必须有断言（C4 ⑨）

## 接口

    problems(*args) → 各判据的聚合（由 `registry.problems()` 调用）

每条都是**纯函数**（可注入 `sources=` / `zdir=`），自证在 `registry._cases_*`。
"""
from __future__ import annotations

import ast
import os
import re

import gate  # noqa: E402

# 一个「看起来像文件名」的记号（`off_reason` 里提到 `foo.json` 这类）。
# 从 `registry.py` 搬来时一起带过来 —— 它是 `off_reason_problems` 的判据数据。
_FILE_TOKEN = re.compile(r"[A-Za-z0-9_.-]+\.[A-Za-z0-9]+")
from i18n import M  # noqa: E402

MUST_REASON_MIN = 8      # off 理由的最短字数（同 `PINNED:` 的纪律）


# 允许存在的 shell 文件（**有界白名单**）。全 Python 化的目标下，shell 是例外，
# 每一个例外都要有理由；新长出来的（或没登记的）⇒ 报。
ALLOWED_SHELL = (
    # 兼容薄壳：老仓的 `sh gates-selftest.sh` 仍有效（一行 exec、零文案）
    "gates-selftest.sh",
    # 钩子 env 插件：**必须**是 shell（被 `source` 以 export 变量），文案已走 M()
    "reflect-hooks/einfacht-env.sh",
    # 旧装法的两个钩子名（git 要求这两个名字，内容是一行 exec）
    "reflect-hooks/pre-commit",
    "reflect-hooks/pre-push",
)


# 名字型旋钮的合法落点：仓根 + `reflect-hooks/`（后者优先）。
# 与 `reflect-hooks/einfacht-env.sh` 同一口径（它先找钩子目录、再找仓根）。
_REASON_BASES = ("", "reflect-hooks")


def _reason_files(reason, repo_root=None):
    """`off_reason` 里提到的文件名 → [(名字, 该文件是否存在于**任一合法落点**)]。

    只认「带扩展名的 token」（`ab.json` / `Einfacht.env` / `world.json`），
    不认句子里的普通词 —— 否则「本仓不做 A/B 对照」会被切成假文件名。

    ⚠️ **两处都要查**：`Einfacht.env` 可以住在仓根**或** `reflect-hooks/`
    （`einfacht-env.sh` 就是先看钩子目录、再看仓根的）。此前只查仓根 ⇒
    载体真放进 `reflect-hooks/` 时判据漏判（实测：`off_reason_problems` 返回
    `[]`，而那正是「理由已失效」的情形）。
    """
    if not reason:
        return []
    root = repo_root if repo_root is not None else gate.GATE_REPO
    out = []
    for tok in _FILE_TOKEN.findall(str(reason)):
        found = any(os.path.exists(os.path.join(root, base, tok))
                    for base in _REASON_BASES)
        out.append((tok, found))
    return out


def dead_interface_problems(zdir=None):
    """**零消费者的公开函数** —— 「严查多余接口」的机器判据。

    为什么值得一条判据：手工枚举全仓公开函数、逐个 grep 调用点，能找出死接口
    但很慢，且下次新增的没人查。本仓已有 `dependency_coverage_problems`
    管「被消费但零断言」（哑火环节）；这条管**反方向**：定义了却没人用
    （僵尸接口）。

    判据（全发现式）：
      · 平台模块（`zreflect/*.py`，非 `check_*`）里**不以 `_` 开头**的顶层函数；
      · 该名字在**其它任何 .py** 里出现（`mod.fn` / `from mod import fn` / 直接调用）；
      · 也允许它被**自己的 `_cases()`** 用到（那是内部缝 / 自证专用助手）；
      · 三者都没有 ⇒ 报。

    诚实边界：
      · 只看 `.py`。shell 脚本调 Python 函数不算（全 Python 化之后没有了）。
      · 不区分「本该公开」与「本该私有」—— 零消费就是零消费，改名或删掉都对。
      · 豁免：`run` / `main` / `problems` 这类**契约名**（每个闸门都必须有，
        由 `main_selftest_or` 或 `__main__` 调用 —— 它们在**同文件**里被用，
        所以本来就不会被报）。
    """
    cand, own_text = _public_functions(zdir)
    corpus = _repo_corpus(zdir)
    out = []
    for fn, mod in sorted(cand.items()):
        if not _consumed(fn, mod, own_text, corpus):
            out.append(M("registry.dead_interface", function=fn, module=mod))
    return out


def _public_functions(zdir):
    """① 平台模块（`zreflect/*.py`，非 `check_*`）里**不以 `_` 开头**的顶层函数。

    返回 `(cand, own_text)`：`cand` = {函数名: 定义它的模块文件名}，
    `own_text` = {模块文件名: 全文}（同文件引用计数要用）。
    """
    import ast  # noqa: PLC0415
    import os  # noqa: PLC0415
    d = zdir if zdir is not None else gate.zdir()
    cand, own_text = {}, {}
    for n in sorted(os.listdir(d)):
        if not n.endswith(".py") or n.startswith("check_"):
            continue
        try:
            text = open(os.path.join(d, n), encoding="utf-8").read()
            tree = ast.parse(text)
        except (OSError, SyntaxError):
            continue
        own_text[n] = text
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) \
                    and not node.name.startswith("_"):
                cand.setdefault(node.name, n)
    return cand, own_text


def _repo_corpus(zdir):
    """② 全仓（zreflect / reflect-hooks）的引用文本，`[(文件名, 文本)]`。

    ⚠️ 记**文件名**而不是文本：按字符串身份（`is`）跳过自身永远失效
    （Python 不保证两个相等字符串是同一对象）—— 实测：植入一个零消费函数
    判据仍然报 clean。按名字排除才可靠。
    """
    import os  # noqa: PLC0415
    d = zdir if zdir is not None else gate.zdir()
    root = os.path.dirname(d)
    corpus = []
    for sub in ("zreflect", "reflect-hooks"):
        base = os.path.join(root, sub)
        if not os.path.isdir(base):
            continue
        for n in sorted(os.listdir(base)):
            if n.endswith(".py"):
                try:
                    corpus.append((n, open(os.path.join(base, n),
                                           encoding="utf-8").read()))
                except OSError:
                    continue
    return corpus


def _consumed(fn, mod, own_text, corpus):
    """这个公开函数有没有消费者：别的文件引用过，**或**同文件里不止一次出现
    （定义算一次 ⇒ 被自己 `_cases()` 用也算）。"""
    own = len(re.findall(r"\b%s\b" % re.escape(fn), own_text.get(mod, "")))
    if own > 1:
        return True
    return any(name != mod and re.search(r"\b%s\b" % re.escape(fn), text)
               for name, text in corpus)


def encoding_surface_problems(repo_root=None):
    """**文本 `open()` 必须显式 `encoding=`** —— 跨平台可读性的守卫。

    为什么值得判据：Windows 的默认编码是 cp1252（代码页），而本仓的文件
    全是 UTF-8。本轮 CI 的 Windows 腿被这一条绊住**四次**，每次形式不同：

      · `registry --gates` 打印中文闸门名 → `UnicodeEncodeError`
      · `subprocess.run(text=True)` 解码子进程输出 → 读线程崩，`stdout=None`
      · 台账 `cmd` 里的 `open('FACTS.json')` → `UnicodeDecodeError`
      · 各处 `open(..., "w")` 写中文夹具

    判据（AST）：文本模式（无 `b`）的 `open()` 必须带 `encoding=` 关键字。
    二进制模式豁免（`rb` / `wb` 不做编码转换）。

    诚实边界：它只看**字面量调用**。`pathlib.Path.read_text()` 之类不在面内
    （本仓不用）；动态构造的调用也看不见。
    """
    import os  # noqa: PLC0415
    root = repo_root or gate.GATE_REPO
    out = []
    for name, src in gate.py_sources(os.path.join(root, "zreflect")):
        out += _encoding_problems("zreflect/" + name, src)
    for name, src in gate.py_sources(os.path.join(root, "reflect-hooks")):
        out += _encoding_problems("reflect-hooks/" + name, src)
    out += _rule_cmd_encoding_problems()
    return out


def _matching_paren(text, open_idx):
    """`text[open_idx] == "("` 时返回配对的 `)` 下标；配不平 ⇒ None。"""
    depth = 0
    for i in range(open_idx, len(text)):
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                return i
    return None


def subprocess_encoding_problems(repo_root=None):
    """**`subprocess.run(text=True)` 必须显式 `encoding=`** —— 跨平台守卫。

    为什么值得判据：这是本仓**踩了五次**的同一个坑，每次形式不同：

      1. `registry --gates` 打印中文 → `UnicodeEncodeError`
      2. `runner.run_cmd` 解码子进程输出 → **读线程崩**，`stdout=None`
      3. 台账 `cmd` 里的 `open()` → `UnicodeDecodeError`
      4. 各处 `open(..., "w")` 写中文夹具
      5. `harness._run` 解码闸门自证输出 → 摘要行「消失」
         （CI 的 Windows 腿报「缺机器摘要行」，而摘要在本地明明存在）

    `text=True` 用 `locale.getpreferredencoding()` 解码，Windows 默认 cp1252；
    子进程一旦输出非 cp1252 字节，`subprocess` 的**读线程**（主线程之外）
    抛 `UnicodeDecodeError`，主线程拿到 `stdout=None` —— 症状离真因很远。

    判据（AST）：`subprocess.run(...)` 带 `text=True` 时必须也带 `encoding=`。
    """
    import os  # noqa: PLC0415
    root = repo_root or gate.GATE_REPO
    out = []
    for sub in ("zreflect", "reflect-hooks"):
        base = os.path.join(root, sub)
        if not os.path.isdir(base):
            continue
        for name, src in gate.py_sources(base):
            out += _subprocess_encoding_problems(sub + "/" + name, src)
    return out


def _subprocess_encoding_problems(name, src):
    """一个文件里 `subprocess.run(text=True)` 缺 `encoding` 的地方。"""
    import ast  # noqa: PLC0415
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return []
    out = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "run"
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "subprocess"):
            continue
        kw = {k.arg for k in node.keywords}
        if "text" in kw and "encoding" not in kw:
            out.append(M("registry.subprocess_without_encoding",
                         file=name, lineno=node.lineno))
    return out


def fatal_exit_problems(repo_root=None):
    """**`SystemExit` 只许带整数** —— rc 契约的唯一机械守卫。

    `SystemExit(code)` 的语义按 `code` 的类型分叉：
      · `int`  ⇒ 退出码就是它（契约：0 绿 / 1 判据红 / 2 配置坏）；
      · `str`  ⇒ **打印并退 1**（Python 的约定），于是 `FATAL:` 的 rc 变成 1；
      · `None` ⇒ 退 0 —— 一条「配置坏」的退出，却报成绿。

    本仓四条 FATAL 路径都是 `raise SystemExit(machine().emit("fatal", …))`
    （emit 返回 str）⇒ **全报成 rc=1**。调用方 `registry._record` 按 rc 分类，
    于是「配置事故」被归进「判据红」，修法指向错误的文件。

    「只写对一处」不够 —— 这是**形状**判据，所以扫全仓：套件里任何
    `SystemExit(<表达式>)` 的实参都必须是整数常量，或者一个**看起来返回
    整数**的调用（`fatal_exit` 是唯一允许的那个）。AST 级，不看运行。
    """
    import ast  # noqa: PLC0415
    import os  # noqa: PLC0415
    root = repo_root or gate.GATE_REPO

    out = []
    for sub in ("zreflect", "reflect-hooks"):
        base = os.path.join(root, sub)
        if not os.path.isdir(base):
            continue
        for rel, src in gate.py_sources(base):
            try:
                tree = ast.parse(src)
            except SyntaxError:
                continue
            name = sub + "/" + rel.replace(os.sep, "/")
            out.extend(M("registry.system_exit_not_int", file=name,
                         line=node.lineno)
                       for node in _non_int_exits(tree))
    return out


def _non_int_exits(tree):
    """树里所有 `raise SystemExit(<非整数常量>)` 的节点（含无参形式）。"""
    import ast  # noqa: PLC0415
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Raise) or node.exc is None:
            continue
        call = node.exc
        if not (isinstance(call, ast.Call)
                and isinstance(call.func, ast.Name)
                and call.func.id == "SystemExit"):
            continue
        if not call.args:
            found.append(node)              # `SystemExit()` ⇒ 退 0，也是坏的
            continue
        arg = call.args[0]
        if isinstance(arg, ast.Constant) and isinstance(
                arg.value, int) and not isinstance(arg.value, bool):
            continue                        # 整数常量：真正的退出码
        found.append(node)
    return found


def suite_scope_problems(repo_root=None):
    """**套件闸门只审套件自己的代码** —— 接进真实项目的可行性守卫。

    为什么值得判据：`check_lint` / `check_i18n` / `check_snapshots` 此前
    扫**整个仓**。一个真项目接入后 `registry --run commit` 报 149 条 ruff、
    59 条 i18n、3 条 snapshot —— **全部指向那个项目自己的文件**。用户既修不完，
    也不理解为什么别人的套件在挑他的代码。

    「套件代码」的判据是**声明**（模块级 `MODULE = …` / `GATE = …`），
    与 `registry.modules()` / `gates()` 同一口径（发现式，不手写清单）。

    这条判据扫的是：套件目录里**没有声明**的 `.py`（用户放的数据模块）
    不应被算进套件面；同时套件自己的每个 `.py` **必须**有声明（否则它
    会静默落到使用方那一侧，闸门就不再审它 —— 那是把闸门关掉的新方法）。
    """
    import os  # noqa: PLC0415
    root = repo_root or gate.GATE_REPO
    out = []
    for sub in ("zreflect", "reflect-hooks"):
        base = os.path.join(root, sub)
        if not os.path.isdir(base):
            continue
        for rel, _src in gate.py_sources(base):
            name = rel.replace(os.sep, "/")
            if name.startswith("measure_"):
                continue                # 使用方的数据模块（README 要求的命名）
            if not gate.declares_itself(os.path.join(base, rel)):
                out.append(M("registry.suite_file_without_declaration",
                             file=sub + "/" + name))
    return out


def _rule_cmd_encoding_problems():
    """**规则 cmd 里的 `open(` 也要查**。

    ⚠️ 这一段是漏检补丁：`doc.RULES` 的 `cmd` 是**字符串字面量**，不是真的
    `open()` 调用 —— AST 扫描（`_encoding_problems`）看不见它。而它会被
    `check_facts_replay` **逐字执行**，于是同一个 Windows 编码问题从
    「代码里的 open」漏到了「台账里的 cmd」（实测：CI 的 Windows 腿连续
    两轮都栽在 `principle.only_measured` 那条 cmd 上，而 encoding 判据当时
    报 0 违规 —— **判据自己的盲区**）。
    """
    import re  # noqa: PLC0415
    out = []
    try:
        import doc  # noqa: PLC0415
    except Exception:                                    # noqa: BLE001
        return out
    for rule in getattr(doc, "RULES", ()):
        cmd = getattr(rule, "cmd", "") or ""
        # ⚠️ 不能用 `open\([^)]*\)`：参数里常有 `os.path.join(a, b)`，内层
        # `)` 会让正则提前截断，于是**看不到后面的 `encoding=`** ——
        # 实测：`host_agnostic` 那条明明带了 encoding，却被误报。
        # 改成「从 `open(` 起，配平括号取到对应的 `)`」。
        for idx in (m.start() for m in re.finditer(r"\bopen\(", cmd)):
            end = _matching_paren(cmd, idx + 4)
            if end is None:
                continue
            call = cmd[idx:end + 1]
            if "encoding" in call or "'rb'" in call or '"rb"' in call:
                continue
            out.append(M("registry.open_without_encoding",
                         file="zreflect/doc.py (rule %s)" % rule.id,
                         lineno=0, mode="cmd"))
    return out


def _encoding_problems(name, src):
    """一个文件的文本 `open()` 缺 `encoding` 的地方。"""
    import ast  # noqa: PLC0415
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return []
    out = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name) and node.func.id == "open"):
            continue
        if any(k.arg == "encoding" for k in node.keywords):
            continue
        mode = "r"
        if len(node.args) > 1 and isinstance(node.args[1], ast.Constant):
            mode = str(node.args[1].value)
        if "b" in mode:
            continue                        # 二进制：不做编码转换
        out.append(M("registry.open_without_encoding",
                     file=name, lineno=node.lineno, mode=mode))
    return out


def shell_surface_problems(repo_root=None):
    """**套件自己**的 `.sh` 只许出现在 `ALLOWED_SHELL` 里 —— 全 Python 化的守卫。

    为什么值得判据：本轮之前有 4 个 shell（662 行、67 处 `echo` 中文），它们
    整份绕过了零语言制度（`check_i18n` 是 AST 扫描器，只认 `.py`）。把它们搬进
    Python 之后，若不设守卫，下次又会有人「顺手写个 .sh」—— 然后同样的事故
    重演。白名单是**有界的**：每个例外都必须写在这里，且必须有理由。

    ⚠️ **只扫套件目录（`zreflect/` + `reflect-hooks/`），不扫使用方的仓。**
    这条曾是把这个套件接进真实项目时**最致命**的阻塞（实测：一个只有
    `build.sh` 的空仓，`--render-doc` 就 FATAL，`--check` 就 FATAL，
    pre-commit 就红，而**没有任何旋钮能放行**）：

        FATAL: registry reconciliation failed, refusing to render:
          · unregistered shell file `build.sh` — full-Python goal …

    「全 Python 化」是**本仓对自己的纪律**，不是对所有使用方的要求 ——
    要求别人的仓不许有 `deploy.sh` 是把内部偏好强加给用户。判据的扫描面
    必须与它守的东西同域。
    """
    import os  # noqa: PLC0415
    root = repo_root or gate.GATE_REPO
    out = []
    for sub in ("zreflect", "reflect-hooks"):
        base = os.path.join(root, sub)
        if not os.path.isdir(base):
            continue
        out += _shell_files_of(base, sub)
    return out


def _shell_files_of(base, prefix):
    """`base` 下的 `.sh` 里**不在白名单**的那些。"""
    import os  # noqa: PLC0415
    out = []
    for dirpath, _dirnames, filenames in os.walk(base):
        # ⚠️ **不能写 `"/.git" in dirpath`**：Windows 的分隔符是 `\`，
        # 那个判断永不成立 ⇒ `.git/hooks/` 里的十几个 sample `.sh` 全被当成
        # 「未登记的 shell」（实测：CI 的 Windows 腿就是这么红的）。
        parts = dirpath.replace(os.sep, "/").split("/")
        if ".git" in parts or "node_modules" in parts:
            continue
        for n in filenames:
            if not n.endswith(".sh"):
                continue
            rel = os.path.relpath(os.path.join(dirpath, n), base)
            # ⚠️ **`relpath` 在 Windows 上给反斜杠**，而 `ALLOWED_SHELL` 里写的
            # 是 `/` —— 不归一化的话，白名单里的每一项都「不在名单里」
            # （实测：CI 的 Windows 腿报 `unexpected_shell(file='reflect-hooks\\einfacht-env.sh')`）。
            norm = (prefix + "/" + rel).replace(os.sep, "/")
            if norm not in ALLOWED_SHELL:
                out.append(M("registry.unexpected_shell", file=norm))
    return out


def trailing_newline_problems(zdir=None):
    """`.py` 文件必须以换行结尾。

    为什么值得一条判据：`py_lines` 这个事实有**两条**量法 —— `facts.measure()`
    用 `open()` 逐行数（保留最后那个无换行的行），台账里的 `cmd` 用
    `cat | wc -l`（只数换行符）。一个没有末尾换行的文件让两者差 1，
    于是 `check_facts_replay` **永远红**，而红的原因与代码毫无关系。
    实测踩了**四次**（每次都是新建文件时写入器没补末尾换行）。

    修的是根：文件该有末尾换行（POSIX 文本定义，也是 diff 工具的前提）。
    判据报出来，人补一行即可。
    """
    import os  # noqa: PLC0415
    base = zdir or gate.zdir()
    out = []
    try:
        names = sorted(os.listdir(base))
    except OSError:
        return out
    for n in names:
        if not n.endswith(".py"):
            continue
        p = os.path.join(base, n)
        try:
            with open(p, "rb") as fh:
                fh.seek(0, os.SEEK_END)
                if fh.tell() == 0:
                    continue                 # 空文件不在这条判据的射程内
                fh.seek(-1, os.SEEK_END)
                last = fh.read(1)
        except OSError:
            continue
        if last != b"\n":
            out.append(M("registry.no_trailing_newline", file=n))
    return out


def _source_of(rel, sources):
    """读闸门源码；读不到 ⇒ `None`（**不是空串** —— 两种含义必须可区分）。"""
    if sources is not None:
        return sources.get(rel)
    try:
        return open(os.path.join(gate.GATE_REPO, rel),
                    encoding="utf-8", errors="replace").read()
    except OSError:
        return None


def _calls_off(text):
    """AST 找 `off(...)` 调用（排除定义处与注释）。读不到源码 ⇒ `None`。"""
    if text is None:
        return None
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return False
    return any(isinstance(n, ast.Call) and getattr(n.func, "id", "") == "off"
               for n in ast.walk(tree))


def _reason_shape_problems(rel, reason, calls_off):
    """三向：会 off 却没理由 / 理由太短 / 声明了理由却从不 off。

    ⚠️ **读不到源码（`calls_off is None`）⇒ 这一向整个跳过**：夹具仓里没有
    该文件时把 `False` 当真会报一堆假的「理由白写」（实测：`GATE_REPO=$tmp
    registry --gates` 报 8 条）。理由真实性不依赖源码，仍照常检查。
    """
    if calls_off is None:
        return []
    if not calls_off:
        return ([M("registry.off_reason_without_off", file=rel)]
                if reason else [])
    if not reason:
        return [M("registry.off_without_reason", file=rel)]
    if len(str(reason).strip()) < MUST_REASON_MIN:
        return [M("registry.off_reason_too_short", file=rel, reason=str(reason))]
    return []


def _reason_truth_problems(rel, reason):
    """**理由真实性**：理由里点名「本仓没有 X.json」——那 X.json 若实际存在，
    理由就已经失效（闸门早该启用而没启用）。第 17 轮补的对称判据：
    第 12 轮只要求「必须有理由」，没要求「理由得是真的」。
    """
    return [M("registry.off_reason_stale", file=rel, name=tok)
            for tok, exists in _reason_files(reason) if exists]


def off_reason_problems(gs, sources=None):
    """C4 对账⑥：**会 `off()` 的闸门必须声明它为何可以未启用**。

    为什么这条需要判据：本仓真的有过「8/13 道 off 而『全绿』不可见」的历史
    （C2 的教训）。`off` 是合法状态，但**没有理由的 off** 与「本仓根本不用这套
    机制」不可区分 —— 于是「闸门永远不跑」可以伪装成「设计如此」。

    判据（三向，AST）：
      · 源码里**会调 `off(`** 但声明行没有 `off_reason`（或太短）⇒ 报
      · 声明行有 `off_reason` 但源码**从不调 `off(`** ⇒ 报（谎言：理由白写）
    发现式：扫 `gs`（registry 已抽好的声明）+ 各文件源码，不写任何名录。

    两组判据各是一个具名 helper（形状 / 真实性）：拼在一起时 6 个分支
    把复杂度推到 12，而两组之间没有任何共享状态。
    """
    out = []
    for g in gs:
        rel = g["file"]
        reason = g.get("off_reason")
        out += _reason_shape_problems(rel, reason,
                                      _calls_off(_source_of(rel, sources)))
        out += _reason_truth_problems(rel, reason)
    return out


def reason_bases_agree(hook=False):
    """C4 对账⑦：`_REASON_BASES` 必须与 `einfacht-env.sh` 的载体查找口径一致。

    `einfacht-env.sh` 先找**钩子目录**、再找**仓根**（两个位置）。本文件的
    `_REASON_BASES`（理由真实性判据的合法落点）必须与它同口径 —— 否则
    「载体真住在 reflect-hooks/ 却判据只看仓根」会让失效的理由漏判（第 18 轮
    实测过）。

    判据是**行为级**的，不是文本匹配：在临时仓里两个位置各放一份载体，
    要求 `_reason_files` 都能看见。这样不依赖 `einfacht-env.sh` 的具体写法
    （它改成 `.env` 后缀或换变量名都不会误伤）。

    `hook` 可注入（自证用假实现）。默认跑真代码。
    """
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    probe = hook or _reason_files
    d = tempfile.mkdtemp()
    try:
        name = "ProbeCarrier" + ".env"                   # 拼接构造
        reason = "no " + name + " here"
        ok_both = True
        for base in ("", "reflect-hooks"):
            target = os.path.join(d, base) if base else d
            if base:
                os.makedirs(target, exist_ok=True)
            path = os.path.join(target, name)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("export X=1\n")
            try:
                got = probe(reason, repo_root=d)
            finally:
                os.remove(path)
            if not got or not got[0][1]:
                ok_both = False
        return ok_both
    finally:
        shutil.rmtree(d, True)


def _scan_sources(sources, base):
    """扫描面：给了 `sources` 就用它（自证注入假文件系统），否则扫真目录。"""
    if sources is not None:
        return sorted(sources.items())
    items = []
    for n in sorted(os.listdir(base)):
        if not n.endswith(".py"):
            continue
        try:
            items.append((n, open(os.path.join(base, n), encoding="utf-8").read()))
        except OSError:
            continue
    return items


def _returns_self_computed_dir(text):
    """函数体里有没有 `return dirname(abspath(__file__))`。

    ⚠️ **只抓「作为返回值的自算」**，不抓 `sys.path.insert(0, …)` ——
    后者是**导入引导**（每个闸门顶部都有，22 处），它不表达「工具目录
    是什么」，只是让脚本能找到兄弟模块。抓它会把判据变成 22 条噪音。
    """
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return []
    out = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef):
            continue
        for sub in ast.walk(node):
            if isinstance(sub, ast.Return) and sub.value is not None \
                    and "dirname(os.path.abspath(__file__)" in ast.unparse(sub.value):
                out.append(node.name)
                break
    return out


def path_rule_problems(sources=None):
    """C4 对账⑧：**「工具的 zreflect/」只能有一个产地**。

    此前 `knobs._zdir()` / `registry._zdir()` / `i18n` 的 `_TOOL_DIR` 各自
    `dirname(abspath(__file__))` 算一遍 —— 今天同值（靠巧合），改任一处就会
    分裂。location 规则与所有「必须一致」同款：**得有一个产地 + 一个对账器**。

    判据（AST，发现式）：扫描面里出现 `dirname(os.path.abspath(__file__))`
    这种**自算工具目录**的地方，除 `gate.py`（唯一产地在它）外都报。
    `i18n` 的懒代理 `return gate.zdir()` 不算自算（它没有那个表达式）。
    """
    out = []
    for name, text in _scan_sources(sources, gate.zdir()):
        if name == "gate.py":
            continue                    # gate.py 是唯一产地，它自己有
        for fn in _returns_self_computed_dir(text):
            out.append(M("registry.path_rule_split", file=name, function=fn))
    return out


def _platform_functions(names, read):
    """平台模块（非 `check_*`）的顶层公开函数：`{模块: {函数名}}`。"""
    platform = {}
    for n in names:
        if n.startswith("check_") or not n.endswith(".py"):
            continue
        text = read(n)
        if text is None:
            continue
        try:
            tree = ast.parse(text)
        except SyntaxError:
            continue
        fns = {node.name for node in tree.body
               if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
               and not node.name.startswith("_")}
        if fns:
            platform[n[:-3]] = fns
    return platform


def _asserted_names(case_bodies):
    """各个 `_cases()` 体里被**读取**（Load）的名字集合。

    ⚠️ AST 节点而不是文本匹配：`helper` 出现在夹具字符串里不算断言
    （第 19–24 轮反复出现的同一个病：文本匹配代替结构匹配）。
    """
    asserted = set()
    for text in case_bodies:
        try:
            tree = ast.parse(text)
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
                asserted.add(node.id)
            elif isinstance(node, ast.Attribute) and isinstance(node.ctx, ast.Load):
                asserted.add(node.attr)
    return asserted


def _record(consumed, consumers, pair, file):
    """记一次「某文件消费了某平台函数」。"""
    consumed.add(pair)
    consumers.setdefault(pair, set()).add(file)


def _import_aliases(tree, platform):
    """`import <mod>` 的别名表：`{alias: mod}`（只收平台模块）。"""
    aliases = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if a.name in platform:
                    aliases[a.asname or a.name] = a.name
    return aliases


def _from_import_uses(tree, platform):
    """`from <平台模块> import <平台函数>` ⇒ `[(模块, 函数)]`。"""
    out = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.ImportFrom) and node.module in platform):
            continue
        for a in node.names:
            if a.name in platform[node.module]:
                out.append((node.module, a.name))
    return out


def _attribute_uses(tree, platform, aliases):
    """`<mod>.<fn>` / `<alias>.<fn>`（Load 上下文）⇒ `[(模块, 函数)]`。"""
    out = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Attribute)
                and isinstance(node.ctx, ast.Load)
                and isinstance(node.value, ast.Name)):
            continue
        mod = aliases.get(node.value.id, node.value.id)
        if mod in platform and node.attr in platform[mod]:
            out.append((mod, node.attr))
    return out


def _consumer_files(files):
    """真的**调用方**：`check_*` / `doctor.py`（平台模块互相调用不算）。"""
    return {n: t for n, t in files.items()
            if n.startswith("check_") or n == "doctor.py"}


def _consumers(files, platform):
    """谁消费了哪个平台函数：`({(模块, 函数)}, {(模块, 函数): {文件名}})`。

    只扫 `check_*` / `doctor.py` —— 它们是真的调用方；平台模块互相调用不算
    「闸门消费」。

    三种发现方式（`from import` / 别名属性 / 裸属性）各是一个 helper：
    拼在一个函数里时，两轮 `ast.walk` + 三处 isinstance 分支把复杂度推到 14。
    """
    consumed, consumers = set(), {}
    for file, text in _consumer_files(files).items():
        try:
            tree = ast.parse(text)
        except SyntaxError:
            continue
        aliases = _import_aliases(tree, platform)
        uses = (_from_import_uses(tree, platform)
                + _attribute_uses(tree, platform, aliases))
        for pair in uses:
            _record(consumed, consumers, pair, file)
    return consumed, consumers


# ⚠️ **框架 API 不要求断言**：`gate.meta` / `main_selftest_or` / `i18n.M` 被
# 16 个闸门**全部**消费 —— 它们是入口脚手架，不是某个闸门消费的「领域函数」。
# 要求它们的断言等于要求「框架给框架写测试」，那是自举。
# 阈值用**绝对值**（≥3 个闸门共用 ⇒ 框架 API），不用「半数闸门」：后者在
# 单闸门夹具里退化成 1，会把夹具里唯一那个消费关系也当框架跳过（实测）。
FRAMEWORK_MIN_GATES = 3


def _load_platform_sources(zdir, sources):
    """装载扫描面：`(names, files, read)`。读不到 ⇒ 空表（不是异常）。

    `read(n)` 对**未装载**的文件返回 None —— 「没有这个文件」与「文件是空的」
    必须可区分（空模块与缺失模块在判据里含义不同）。
    """
    d = zdir if zdir is not None else gate.zdir()

    def read(n):
        if sources is not None:
            return sources.get(n)
        try:
            return open(os.path.join(d, n), encoding="utf-8",
                        errors="replace").read()
        except OSError:
            return None

    if sources is not None:
        names = sorted(sources)
        return names, {n: sources[n] for n in names}, read
    try:
        names = sorted(n for n in os.listdir(d) if n.endswith(".py"))
    except OSError:
        return [], {}, read
    files = {n: t for n in names if (t := read(n)) is not None}
    return names, files, read


def _untested_consumed(consumed, consumers, asserted):
    """被闸门消费、却没有任何断言、且不是框架 API 的函数。

    ⚠️ 框架 API 的判据是**绝对数**（≥3 个闸门共用），不是「半数闸门」：
    后者在单闸门夹具里退化成 1，会把夹具里唯一那个消费关系也当框架跳过。
    """
    return [(mod, fn) for mod, fn in sorted(consumed)
            if fn not in asserted
            and len(consumers[(mod, fn)]) < FRAMEWORK_MIN_GATES]


def dependency_coverage_problems(zdir=None, sources=None):
    """C4 对账⑨：**被闸门消费的平台函数，必须在某处有断言**。

    一个被消费但没被测的模块，是依赖链上的哑火环节：它判错了，消费它的闸门
    丢掉判据，而那个闸门自己的自证照样绿（第 24 轮 `living.living_lines()`）。

    四段各是一个 helper（`_load_platform_sources` / `_platform_functions` /
    `_asserted_names` / `_consumers` / `_untested_consumed`），本函数只做编排。
    """
    names, files, read = _load_platform_sources(zdir, sources)
    if not files:
        return []
    platform = _platform_functions(names, read)
    asserted = _asserted_names([t for t in files.values() if "def _cases(" in t])
    consumed, consumers = _consumers(files, platform)
    return [M("registry.dependency_untested", module=m, function=f)
            for m, f in _untested_consumed(consumed, consumers, asserted)]


# ── 自证：判据属于自己的被测对象 ──────────────────────────────────────────────

def _dead_interface_case():
    """造一个零消费的公开函数 ⇒ 必须报；给它加个外部引用 ⇒ 不报。"""
    import os
    import shutil
    import tempfile  # noqa: PLC0415
    root = tempfile.mkdtemp()
    try:
        d = os.path.join(root, "zreflect")
        os.makedirs(d, exist_ok=True)
        open(os.path.join(d, "probe.py"), "w", encoding="utf-8").write(
            "def zzz_orphan():\n    return 1\n")
        if not dead_interface_problems(zdir=d):
            return False
        # 加一个外部消费者 ⇒ 不该再报
        open(os.path.join(d, "check_probe.py"), "w", encoding="utf-8").write(
            "import probe\ndef run():\n    return probe.zzz_orphan()\n")
        return dead_interface_problems(zdir=d) == []
    finally:
        shutil.rmtree(root, True)



def _unexpected_shell_case():
    """**套件目录**里的未登记 `.sh` ⇒ 必须报。

    ⚠️ 判据的扫描面是 `zreflect/` + `reflect-hooks/`（套件自己），**不是
    使用方的仓** —— 「全 Python 化」是本仓对自己的纪律。所以夹具也必须
    造在套件子目录里；在使用方根上造 `.sh` 是**不该报**的（见
    `_owner_shell_is_allowed`）。
    """
    import os  # noqa: PLC0415
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    try:
        suite = os.path.join(d, "zreflect")
        os.makedirs(suite)
        with open(os.path.join(suite, "probe.sh"), "w", encoding="utf-8") as fh:
            fh.write("# probe\n")
        if not shell_surface_problems(repo_root=d):
            return False
        # 登记过的名字（`reflect-hooks/einfacht-env.sh`）不该报
        hooks = os.path.join(d, "reflect-hooks")
        os.makedirs(hooks)
        with open(os.path.join(hooks, "einfacht-env.sh"), "w",
                  encoding="utf-8") as fh:
            fh.write("# ok\n")
        got = [str(p) for p in shell_surface_problems(repo_root=d)]
        return len(got) == 1 and "probe.sh" in got[0]
    finally:
        shutil.rmtree(d, True)


def _system_exit_int_case():
    """三种 `SystemExit` 形状各判一次：只有整数常量该放过。

    ⚠️ **三种都要测**，因为它们的失败方式不同、后果也不同：
      · `SystemExit("msg")` ⇒ 退 **1**（FATAL 被当判据红）
      · `SystemExit()`      ⇒ 退 **0**（FATAL 被当成绿 —— 最坏的一种）
      · `SystemExit(2)`     ⇒ 退 2（唯一正确的「配置坏」）
    """
    import os  # noqa: PLC0415
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    try:
        suite = os.path.join(d, "zreflect")
        os.makedirs(suite)
        probe = os.path.join(suite, "probe.py")

        def count(body):
            with open(probe, "w", encoding="utf-8") as fh:
                fh.write("def f():\n" + body)
            return len(fatal_exit_problems(repo_root=d))

        return (count('    raise SystemExit("msg")\n') == 1
                and count("    raise SystemExit()\n") == 1
                and count("    raise SystemExit(2)\n") == 0)
    finally:
        shutil.rmtree(d, True)


def _undeclared_suite_file_case():
    """套件目录里一个**没有声明行**的 `.py` ⇒ 必须报。

    为什么：没声明 = 被当成使用方代码 = 三道闸门不再审它。那是**把闸门
    关掉的新方法**，必须能红。`measure_*.py` 例外（那是使用方的数据模块）。
    """
    import os  # noqa: PLC0415
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    try:
        suite = os.path.join(d, "zreflect")
        os.makedirs(suite)
        with open(os.path.join(suite, "orphan.py"), "w",
                  encoding="utf-8") as fh:
            fh.write("x = 1\n")
        found = [str(p) for p in suite_scope_problems(repo_root=d)]
        if not any("orphan.py" in s for s in found):
            return False
        # `measure_*.py` 是使用方的数据模块 ⇒ 不报
        os.rename(os.path.join(suite, "orphan.py"),
                  os.path.join(suite, "measure_probe.py"))
        return suite_scope_problems(repo_root=d) == []
    finally:
        shutil.rmtree(d, True)


def _scanned_sources_two_ways_case():
    """`gate.scanned_sources` 的两条口径**各测一次**（`configured` 与否）。

    为什么必须两条都测：这是「闸门审使用方代码」那次修的**唯一**判据。
    只测一条的话，另一半会静默漂回去 —— 而两种漂法代价相反、都致命：

      · 未配却收了全部 ⇒ 使用方仓里 149 条 ruff / 59 条中文全报给他
        （套件把自己的纪律强加给别人）；
      · 配了却只收有声明的 ⇒ `REFLECT_I18N_ROOT=<dir>` 报
        `scan_empty_dir` FATAL（把手动 opt-in 弄坏）。

    夹具用一个有声明和一个没声明的文件，两种口径各看一次。
    """
    import os  # noqa: PLC0415
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    try:
        with open(os.path.join(d, "suite.py"), "w",
                  encoding="utf-8") as fh:
            fh.write("MODULE = 1\n")
        with open(os.path.join(d, "user.py"), "w", encoding="utf-8") as fh:
            fh.write("x = 1\n")
        default = [rel for rel, _src in gate.scanned_sources(d)]
        opted_in = [rel for rel, _src in gate.scanned_sources(d, configured=True)]
        return default == ["suite.py"] and sorted(opted_in) == [
            "suite.py", "user.py"]
    finally:
        shutil.rmtree(d, True)


def _owner_shell_is_allowed():
    """**使用方仓根**上的 `.sh` 不许被报 —— 那是他们的构建脚本，不是套件的事。

    这条是「接进真实项目」时最致命那个阻塞的回归守卫：此前判据扫整个
    `GATE_REPO`，于是任何有 `build.sh` / `deploy.sh` 的仓都 `--render-doc`
    FATAL，且没有旋钮能放行。
    """
    import os  # noqa: PLC0415
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    try:
        for name in ("build.sh", "deploy.sh"):
            with open(os.path.join(d, name), "w", encoding="utf-8") as fh:
                fh.write("#!/bin/sh\n")
        return shell_surface_problems(repo_root=d) == []
    finally:
        shutil.rmtree(d, True)


def _han_predicate_case():
    """`i18n.han()` 认中文、不认 ASCII、不认码点构造之外的近亲。"""
    from i18n import han  # noqa: PLC0415
    # 夹具里的中文用码点构造（本仓纪律：字面量会进扫描面）
    return (han(chr(0x4E2D)) and han("a" + chr(0x6587) + "b")
            and not han("plain ascii")
            and not han("")
            and not han(chr(0x3042)))     # 平假名不在 CJK 统一表意区间内



def _trailing_newline_case():
    """造一个缺末尾换行的文件 ⇒ 必须报；补上 ⇒ 不报。"""
    import os
    import shutil
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    try:
        open(os.path.join(d, "bad.py"), "w", encoding="utf-8").write("x = 1")
        if not trailing_newline_problems(zdir=d):
            return False
        open(os.path.join(d, "bad.py"), "w", encoding="utf-8").write("x = 1\n")
        return trailing_newline_problems(zdir=d) == []
    finally:
        shutil.rmtree(d, True)



def _selftest_false_states_it():
    """每个 `selftest=False` 的模块，描述里都必须点明「自证住在 registry._cases」。

    三个都查（`collect.py` / `living.py` / `gate.py`）—— 发现式：从 `modules()`
    取所有 `selftest=False` 的，不写名单。
    """
    from registry import modules  # noqa: PLC0415
    mods, _und = modules()
    checked = 0
    for m in mods:
        if m.get("selftest"):
            continue
        checked += 1
        if "registry._cases" not in m["desc"]:
            return False
    return checked >= 1          # 零值守卫：一个都没查到 ⇒ 不看



def _dependency_coverage_ok():
    """真仓：被消费的平台函数都有断言；再造一个「被消费但无断言」的 ⇒ 必须报。"""
    ok_real = dependency_coverage_problems() == []
    # 名字必须**全仓唯一**：`helper` 那种常见词会被真 registry._cases 里的
    # 同名变量命中 ⇒ 断言面「假装」覆盖了它（实测：fake 返回 []）。
    fake = {
        "check_probe.py":
            "import probe\ndef run():\n    return probe.zzz_uniquely_named()\n",
        "probe.py": "def zzz_uniquely_named():\n    return 1\n",
    }
    got = [p.code for p in dependency_coverage_problems(sources=fake)]
    return ok_real and got == ["registry.dependency_untested"]



def _selftest_refuses_empty():
    """`gate.selftest(name, [])` 必须 SystemExit（0/0 洞不许绿着退场），**且退 2**。

    ⚠️ 只断言「抛了 SystemExit」不够：`raise SystemExit("一段字符串")` 也是
    SystemExit，但 Python 的约定是**打印并退 1** —— 于是打出 `FATAL:` 却报
    rc=1，调用方按 rc 分类就把它归成「判据红 / 代码有问题」，而真相是
    「配置 / 输入形状坏」。实测：四份 `SystemExit(machine().emit("fatal", …))`
    全是这个形状（`require_nonempty` / `selftest` / `ledger._require_pairs` /
    `collect.parse_prev_values`），全部把 FATAL 报成了 rc=1。

    所以这条同时钉 rc == 2 —— 报了什么不算数，退出码才算。
    """
    try:
        gate.selftest("probe", [])
        return False                    # 没拒 ⇒ 这条红
    except SystemExit as e:
        return e.code == 2




def _off_reason_ok(_label, sources, ok, reason=None):
    """构造一条假声明行 + 假源码，验 `off_reason_problems` 的判定方向。

    `sources` 的值是**源码片段**；用 `_off(` 占位再替换成真调用，避免本文件
    自己被这个判据收编（它本身是可 off 的闸门）。"""
    body = sources["check_x.py"].replace("_off(", "off(")
    gs = [{"file": "check_x.py", "off_reason": reason}]
    got = off_reason_problems(gs, sources={"check_x.py": body})
    return (got == []) if ok else (got != [])



def _off_reason_stale_ok():
    """声称没有 `ab.json`，而 `ab.json` 真实存在 ⇒ 必须报 stale。

    用临时目录做仓根（不碰真仓），并给源码让 `off()` 调用成立，
    以隔离出**只由「理由失效」**触发的那一条。
    """
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    try:
        with open(os.path.join(d, "ab.json"), "w", encoding="utf-8") as fh:
            fh.write("{}")
        reason = ("no " + "ab.json" + " spec in this repo")   # ASCII，避免触发零语言闸门
        gs = [{"file": "check_ab.py", "off_reason": reason}]
        src = {"check_ab.py": "def run():\n    return off(null)\n"}
        old = gate.GATE_REPO
        gate.GATE_REPO = d
        try:
            got = [p.code for p in off_reason_problems(gs, sources=src)]
            # 文件不在的对照组：把 ab.json 删掉 ⇒ 不该有 stale
            os.remove(os.path.join(d, "ab.json"))
            got2 = [p.code for p in off_reason_problems(gs, sources=src)]
        finally:
            gate.GATE_REPO = old
        return got == ["registry.off_reason_stale"] and got2 == []
    finally:
        shutil.rmtree(d, True)



def _stale_in_hooks_dir():
    """载体在 `reflect-hooks/`（不是仓根）时，stale 判据必须照样报。"""
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    try:
        hooks = os.path.join(d, "reflect-hooks")
        os.makedirs(hooks)
        name = "Probe" + ".env"                          # 拼接构造：不写死在仓里
        with open(os.path.join(hooks, name), "w", encoding="utf-8") as fh:
            fh.write("export X=1\n")
        reason = "no " + name + " carrier in this repo"   # ASCII
        gs = [{"file": "check_probe.py", "off_reason": reason}]
        src = {"check_probe.py": "def run():\n    return off(null)\n"}
        old = gate.GATE_REPO
        gate.GATE_REPO = d
        try:
            return [p.code for p in off_reason_problems(gs, sources=src)] \
                == ["registry.off_reason_stale"]
        finally:
            gate.GATE_REPO = old
    finally:
        shutil.rmtree(d, True)



def _path_rule_single_source():
    """真仓只有 gate.py 自算工具目录；再造一份假的 ⇒ 必须报。"""
    ok_real = path_rule_problems() == []
    # 判据只抓**函数体里的 return**（不是模块级赋值 —— 那是导入引导 / 常量）
    fake = {"splitter.py":
            "def f():\n"
            "    return os.path.dirname(os.path.abspath(__file__))\n"}
    got = [p.code for p in path_rule_problems(sources=fake)]
    return ok_real and got == ["registry.path_rule_split"]



def _cases_off_reason():
    """见 `_cases()`：本组 7 条。**不碰夹具** —— 理由判据只读声明面。"""
    return [
    # **off 必须有理由**（第 12 轮）：会调 `off()` 却没声明 `off_reason`、
    # 理由太短、或声明了理由却不调 off —— 三个方向都要报。
    ("★ registry.off_without_reason", lambda: _off_reason_ok(
        "no-reason", {"check_x.py": "_off()"}, ok=False)),
    ("★ registry.off_reason_too_short", lambda: _off_reason_ok(
        "too-short", {"check_x.py": "_off()"}, ok=False, reason="x")),
    ("★ registry.off_reason_without_off", lambda: _off_reason_ok(
        "declared-but-never-off", {"check_x.py": "pass\n"}, ok=False,
        reason="a real justification long enough")),
    ("registry.off_reason_ok", lambda: _off_reason_ok(
        "complete", {"check_x.py": "_off()"}, ok=True,
        reason="a real justification long enough")),
    # **理由真实性**（第 17 轮）：`off_reason` 声称「本仓没有 X.json」，
    # 而 X.json 实际存在 ⇒ 理由已失效（闸门早该启用而没启用）。
    # 第 12 轮只要求「必须有理由」，这是它的对称缺口：
    # 不要求「理由得是真的」，理由就会变成永久免死金牌。
    ("★ registry.off_reason_stale", lambda: _off_reason_stale_ok()),
    # **理由里的文件名要在两个合法落点都查**：`Einfacht.env` 可以住在仓根
    # **或** `reflect-hooks/`（`einfacht-env.sh` 先看钩子目录、再看仓根）。
    # 只查仓根会让「载体真放进 reflect-hooks/」的情形漏判（实测 []）。
    ("★ registry.off_reason_stale_in_hooks_dir",
     lambda: _stale_in_hooks_dir()),
    # **口径对账**（C4）：`_REASON_BASES` 必须与 `einfacht-env.sh` 的
    # 载体查找一致（钩子目录 + 仓根）。判据是行为级的：两个位置各放一份
    # 载体，两边都必须看得见。只查仓根 ⇒ RED。
    ("★ registry.reason_bases_match_env_plugin",
     lambda: reason_bases_agree()),
    ]



def _cases_path_rule():
    """见 `_cases()`：本组 4 条。**不碰夹具** —— 路径判据只读 gate 的产地。"""
    return [
    # **口径分裂**（C4 对账⑧）：工具的 zreflect/ 只能有一个产地。
    # 别处再写一份 `dirname(abspath(__file__))` ⇒ 报（改一处就会分裂）。
    ("★ registry.path_rule_single_source",
     lambda: _path_rule_single_source()),
    # **`gate.zdir()` / `tool_repo()` 的自证**（第 21 轮）：它们是全仓地基，
    # 此前只有「别的模块委托它」的判据，没有「它自己算得对」的判据。
    ("★ registry.zdir_matches_file",
     # 值必须是**本文件所在目录**（`registry.py` 也在 zreflect/ 里）。
     # ⚠️ 这里**不许**自己写 `dirname(abspath(__file__))` —— 那正好是
     # 本闸门要禁的形状，写了就会被 `path_rule_single_source` 抓
     # （实测：这条断言自己触发了那个判据）。改用 `os.path.dirname` 的
     # 显式字面量对比：`gate.zdir()` 必须以 `zreflect` 结尾且可导入本文件。
     lambda: os.path.basename(gate.zdir()) == "zreflect"
     and os.path.exists(os.path.join(gate.zdir(), "registry.py"))),
    ("★ registry.tool_repo_is_zdir_parent",
     # `tool_repo()` 必须是 `zdir()` 的**上一级**（不是别的什么）
     lambda: os.path.abspath(gate.tool_repo())
     == os.path.dirname(os.path.abspath(gate.zdir()))),
    ("★ registry.zdir_is_a_dir",
     # 是个真实存在的目录（不是算出来的空字符串 / 错路径）
     lambda: os.path.isdir(gate.zdir())
     and os.path.basename(gate.zdir()) == "zreflect"),
    ]


def _cases(fx=None):
    """`criteria.py` 自己的判据：死接口 / shell 面积 / 中文谓词 / 末尾换行 /
    依赖覆盖 / off 理由 / 路径规则 / 自证加固。**住在本模块** —— 判据属于被测对象。

    `fx` 是 `registry._cases_fixture()` 的产品（`off_reason` / `path_rule`
    那两组要用名录夹具）；独立跑 `--selftest` 时从 `registry` 现造一份。
    """
    if fx is None:
        import atexit
        import tempfile  # noqa: PLC0415

        from registry import _cases_fixture  # noqa: PLC0415
        d = tempfile.mkdtemp()
        atexit.register(__import__("shutil").rmtree, d, True)
        fx = _cases_fixture(d)
        fx["d"] = d
    return (
        _cases_off_reason()
        + _cases_path_rule()
        + _cases_self_checks()
    )


def _utf8_forced_case():
    """Windows 的 cp1252 stdout 必须能被救回来（否则一行中文就能打红 CI）。

    **确定性检查**，不靠「不 flush 就一定抛」这种未定义行为：
      1. 静态断言：`_force_utf8_streams` 的源码里必须出现 `reconfigure` 与
         `utf-8` —— 它做的是这件事，不是别的。
      2. 行为断言：造两个 cp1252 流，一个直接写（必须抛），一个过
         `_force_utf8_streams()` 后写（必须不抛）。两半都要 ——
         只测「能写」的话，一个什么都不做的函数也会通过。
    """
    import inspect  # noqa: PLC0415
    import io  # noqa: PLC0415
    import sys  # noqa: PLC0415

    import gate  # noqa: PLC0415
    src = inspect.getsource(gate._force_utf8_streams)
    if "reconfigure" not in src or "utf-8" not in src:
        return False                    # 静态断言：它得真做那件事
    sample = "A/B " + chr(0x95F8) + chr(0x95E8)          # 「闸门」

    def _can_encode(stream):
        try:
            stream.write(sample + "\n")
            stream.flush()              # 显式 flush —— 不让错误躲到缓冲里
            return True
        except UnicodeEncodeError:
            return False

    raw = io.TextIOWrapper(io.BytesIO(), encoding="cp1252", errors="strict")
    if _can_encode(raw):
        return False                    # cp1252 竟然编得出来 ⇒ 夹具没造对

    fixed = io.TextIOWrapper(io.BytesIO(), encoding="cp1252", errors="strict")
    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout = sys.stderr = fixed
    try:
        gate._force_utf8_streams()
        return _can_encode(fixed)
    finally:
        sys.stdout, sys.stderr = old_out, old_err


def _cases_self_checks():
    """不依赖名录夹具的那 7 条（死接口 / shell 面积 / 中文谓词 / 末尾换行 /
    依赖覆盖 / 自证加固）。"""
    return [
        # **`living.py` / `collect.py` 的自证**（第 24 轮）：两个 `selftest=False`
        # 模块此前**零断言**，而 `living_lines` 被 `check_stale` / `check_retractions`
        # 消费 —— 它判错了，那两道闸门的判据全部失效。
        # **`selftest=False` 的模块描述必须说清自证住在哪**（第 25 轮，
        # 与第 23 轮 `gate.py` 同类）：`collect.py` / `living.py` / `gate.py`
        # 都声明了 `selftest=False`，但它们的逻辑**有实质断言**在
        # `registry._cases()`。描述若只写「无自证」= 免责声明。
        # 「严查多余接口」的机器判据：零消费者的公开函数 ⇒ 必须报。
        ("★ registry.dead_interface_detected",
         lambda: _dead_interface_case()),
        # 全 Python 化的守卫：未登记的 .sh ⇒ 必须报（造一个假的证明它有牙）
        ("★ registry.unexpected_shell_detected",
         lambda: _unexpected_shell_case()),
        # **使用方仓根的 .sh 不报**（接进真实项目的死路，已修）
        ("★ registry.owner_shell_is_allowed",
         lambda: _owner_shell_is_allowed()),
        # `i18n.han()`：零语言制度的判据（`check_i18n` 与 `harness` 都消费它）。
        # 它是「有没有中文」的**唯一产地** —— 判错了两道判据一起失效。
        ("★ registry.han_predicate",
         lambda: _han_predicate_case()),
        # 末尾换行（踩了四次）：一个没有末尾换行的 .py 让 `py_lines` 的两条
        # 量法差 1，复跑闸门永远红 —— 报出来让人补，而不是每次手工发现。
        ("★ registry.trailing_newline_detected",
         lambda: _trailing_newline_case()),
        ("★ registry.selftest_false_modules_state_where_selftest_lives",
         lambda: _selftest_false_states_it()),
        # **依赖链覆盖**（C4 对账⑨）：被闸门消费的平台函数必须在某处有断言。
        # 第 24 轮的 `living.living_lines` 就是这么漏的（消费两道闸门，自身零断言）。
        ("★ registry.dependency_coverage",
         lambda: _dependency_coverage_ok()),
        # `gate.selftest` 被两道闸门直接调用 —— 它**执行**所有断言，但自身的
        # 零值守卫（空 cases 必须拒收）此前零断言。测它不算自举：测的是
        # 「0/0 洞会不会被拦住」，不是「断言跑得对不对」。
        # Windows 的 cp1252 stdout —— 这个仓会打印**中文**的闸门名与描述
        # **文本 `open()` 必须显式 encoding**（Windows 默认 cp1252）。
        # 这条判据在 CI 的 Windows 腿上被验证过四次 —— 每次都是不同形式。
        # **`subprocess.run(text=True)` 必须显式 encoding** —— 踩了五次的坑。
        # **套件文件必须有声明**（没声明的会被当成使用方代码，闸门就不再审它）
        ("★ registry.suite_file_without_declaration",
         lambda: _undeclared_suite_file_case()),
        # **FATAL 必须退 2**（`SystemExit(str)` 退 1、`SystemExit()` 退 0 ——
        # 四条 FATAL 路径曾全部报成 rc=1，配置事故被归成代码问题）。
        ("★ registry.system_exit_is_int", lambda: _system_exit_int_case()),
        ("★ registry.subprocess_without_encoding_detected",
         lambda: [p.code for p in _subprocess_encoding_problems(
             "x.py", 'import subprocess\n'
                     'subprocess.run(["x"], text=True)\n')]
         == ["registry.subprocess_without_encoding"]),
        ("registry.subprocess_with_encoding_is_clean",
         lambda: _subprocess_encoding_problems(
             "x.py", 'import subprocess\n'
                     'subprocess.run(["x"], text=True,\n'
                     '               encoding="utf-8")\n') == []),
        ("★ registry.open_without_encoding_detected",
         lambda: [p.code for p in _encoding_problems(
             "x.py", 'open("a", "w").write("x")\n')]
         == ["registry.open_without_encoding"]),
        ("registry.open_with_encoding_is_clean",
         lambda: _encoding_problems(
             "x.py", 'open("a", encoding="utf-8").write("x")\n') == []),
        ("registry.binary_open_is_exempt",
         lambda: _encoding_problems("x.py", 'open("a", "rb").read()\n') == []),
        ("★ registry.utf8_streams_are_forced",
         lambda: _utf8_forced_case()),
        ("★ registry.scope_two_ways",
         lambda: _scanned_sources_two_ways_case()),
        ("★ registry.selftest_refuses_empty_cases",
         lambda: _selftest_refuses_empty()),
    ]


def _selftest():
    import sys  # noqa: PLC0415

    from gate import main_selftest_or  # noqa: PLC0415
    return main_selftest_or(sys.argv[1:], M("gate.title.criteria"),
                            _cases, lambda a: 0)


from gate import module_meta  # noqa: E402

MODULE = module_meta(
    "名录判据",
    "「哪些东西必须一致」的机器对账：死接口 / shell 面积 / 末尾换行 / "
    "off 理由 / 路径规则 / 依赖覆盖（自证在本模块 `_cases`）",
    selftest=True)


if __name__ == "__main__":
    import os  # noqa: PLC0415
    import sys  # noqa: PLC0415
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import criteria as _mod  # noqa: PLC0415
    sys.exit(_mod._selftest())
