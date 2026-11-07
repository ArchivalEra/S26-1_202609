#!/usr/bin/env python3
"""闸门平台：rc 契约 + 零值守卫 + 三档自证。

它解决的**不是**「没有检查」，而是**检查在输入消失时静默变绿**。真实踩过的三种：

  · 三个站点同时缺 `VERSION` ⇒ 一致性闸门报「完全一致」；
  · 声明的集合是空的 ⇒ 出厂核对报 `verdict: "ok"`；
  · 自检脚本 `0/0` ⇒ 算「全部通过」。

所以任何检查器都必须能回答两句话：**输入空了我报吗？**、**该报的我会报吗？**
`require_nonempty()` 答第一句，`selftest()` 的三类用例答第二句。

**rc 契约（本平台的 interface，2026-10-07 起全仓唯一产地）**：

  · `off()`    ⇒ 0，未启用（可插拔闸门的 off 态必须**明说**，不许静默）；
  · `fatal()`  ⇒ 2，配置 / 环境坏（旋钮指向缺失、坏 JSON、规格结构坏、
    仪器本身坏了）—— 配置性失败 ≠ 检查失败，混进 1 会让「发现问题」
    与「配置坏了」不可区分；
  · `finish()` ⇒ 1（有 problems）/ 0（绿）。标题在先、问题行在后，
    **单个闸门的问题行统一 stderr** —— 此前 13 道闸门各手抄一份、已漂出两派
    （stdout/stderr 混用、标题先后不一），这里收敛成一份。

  ⚠️ 上面这条只约束**单个闸门自己的判据输出**。**聚合方**（`registry --run
  <相位>`）的输出是**运行报告**（哪些没跑 / 哪些红了 / 哪些配置坏了），不是
  判据 —— 它整体走 **stdout**，理由见 `registry._main_run` 的注释。两者语义
  不同，别把同一条约定硬套两层（第 16 轮的结论）。

自证期间纯函数保持安静（print 归 run()/顶层，issue #1 ③）。
"""
import ast
import json
import os
import sys

_AST_CACHE: dict = {}   # key: 文件路径 → 解析好的 AST（或 None）

# 被检查的仓库根：默认是本包的上一级，可用 GATE_REPO 覆盖（测试夹具靠它）。
GATE_REPO = os.environ.get("GATE_REPO") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def repo(*parts):
    """拼一个指向被检查仓库的绝对路径。"""
    return os.path.join(GATE_REPO, *parts)


def repo_path(path, root=None):
    """相对路径锚到 `root`（默认被检查仓根），绝对路径原样 —— 唯一产地。

    `p if os.path.isabs(p) else os.path.join(root, p)` 这个表达式此前在
    check_ab / check_locks / check_pins / check_facts / facts 里逐字抄了
    五遍（`i18n.pack_dir` 还有一份变体）。绝对/相对的边界判据只许有一处：
    「以 / 开头就是用户的绝对路径」这条一旦在某一处漂掉，那道闸门就会把
    用户的绝对 spec 路径拼到仓根下面，然后报「文件不存在」。
    """
    root = GATE_REPO if root is None else root
    return path if os.path.isabs(path) else os.path.join(root, path)


def zdir():
    """**工具自己**的 `zreflect/` 目录 —— 全仓唯一产地。

    用途是「扫我自己的源码」（发现式名录 / 幻影旋钮 / 代码覆盖）。这与
    `GATE_REPO`（**被检查仓**根）是两件事：跨仓夹具里 `GATE_REPO` 指向临时
    目录，但工具源码仍在套件里。

    ⚠️ 此前 `knobs._zdir()` / `registry._zdir()` / 各处的
    `dirname(abspath(__file__))` 各自算一遍 —— 今天同值（靠巧合），
    改任一处就会分裂。location 规则只该有一个产地。
    """
    return os.path.dirname(os.path.abspath(__file__))


def tool_repo():
    """**工具仓**根（`zreflect/` 的上一级）—— 全仓唯一产地。

    `i18n.pack_dir()` 的「未设 ⇒ 用套件自带包」锚的就是它。
    """
    return os.path.dirname(zdir())


def machine():
    """懒取 `machine`（机器行协议）。

    ⚠️ **不能模块级 `import machine`**：`machine` 要 `from gate import module_meta`
    来声明自己（registry 的收编要求），模块级导入就成环（实测 ImportError）。
    这与 `i18n.py` 的懒导入同一个理由 —— 环只能靠「谁先谁后」打破，不能靠
    在循环里各取一部分。
    """
    import machine  # noqa: PLC0415
    return machine


def require_nonempty(name, seq, what=None):
    """零值守卫：收集阶段什么都没收到 ⇒ 报错，**不许当「干净」**。

    这是本包最重要的一行。绝大多数「闸门假装通过」的事故，根因都是这里没守：
    遍历一个不存在的目录得到空集，然后「没有发现违规」——两句都是真的，结论是错的。

    `what` = 被收集物的称呼（默认走语言包 `gate.input_label`）。
    """
    import i18n  # noqa: PLC0415
    if what is None:
        what = i18n.M("gate.input_label")
    items = list(seq)
    if not items:
        # `FATAL:` 是机器契约前缀 —— 在**发射点**字面量（不进语言包）。
        # `what` 可能是调用方给的 Message（如 `M("stale.scanned_docs")`）：
        # 先 str() 拍平，否则 null 包里会渲染成嵌套的 `repr(Message)`。
        fatal_exit(i18n.M("gate.require_nonempty", name=name, what=str(what)))
    return items


def guard_nonempty(name, seq, what=None):
    """`require_nonempty` 的 rc 版：空 ⇒ 打印 FATAL、返回 2；非空 ⇒ None。

    给「直接跑」的检查器用（它们要的是退出码，不是异常）。
    """
    try:
        require_nonempty(name, seq, what)
        return None
    except SystemExit as e:
        print("%s" % e, file=sys.stderr)
        return 2


def off(notice):
    """未启用：明说 + 退 0。

    ⚠️ **off 与「真跑通过」必须可区分**（C2）：两者 rc 都是 0（off 不是失败，
    hooks 的 `|| exit` 不该把它当红），但 off 在 stdout 打一行机器可读标记
    `OFF: …` —— 执行面（`gate.run_phase`）据此把闸门分成 ran / off / failed
    三档，而不是把「没跑」算进「绿」。此前 off 只打 stderr 的自由文本，
    「全部闸门绿」实为「N 道通过 + M 道从未运行」不可见（本仓实测 8/13 道
    off —— 与本仓立身要消灭的假绿同形）。
    """
    print(machine().emit("off", notice))
    _maybe_hint()
    return 0


def fatal(msg):
    """配置 / 环境坏：FATAL + 退 2。"""
    print(machine().emit("fatal", msg), file=sys.stderr)
    return 2


def fatal_exit(msg):
    """`fatal` 的**退出**形式（给那些没法 `return 2` 的调用点）。

    ⚠️ **必须 `SystemExit(2)`，不是 `SystemExit(msg)`**：后者是 Python 的
    「打印并退 1」约定 —— 于是打出 `FATAL:` 三个字母、退出码却是 **1**。
    调用方（`registry._record`）按 rc 分类：1 = 判据红 / failed，
    2 = 配置坏 / fatal。那四份 `raise SystemExit(machine().emit("fatal", …))`
    全都在这里错位了：**配置事故被报成代码问题**，修法指向错误的文件。

    实测：`gate.selftest('x', [])` 打 `FATAL: gate.selftest_empty_cases`，
    rc 却是 1。

    一处函数、四个调用点（`require_nonempty` / `selftest` /
    `ledger._require_pairs` / `collect.parse_prev_values`）——
    此前是四份手抄，四份都错。
    """
    print(machine().emit("fatal", msg), file=sys.stderr)
    raise SystemExit(2)


def declares_itself(path):
    """这个 `.py` 是不是**套件自己的**文件（模块级 `MODULE =` / `GATE =` 声明）。

    **唯一产地**：「这是套件的一部分还是使用方的代码」这个判断，此前散在
    各闸门里（`registry.modules()` 用 `MODULE` 认平台模块、`gates()` 用
    `GATE` 认闸门），而 `check_lint` / `check_i18n` / `check_snapshots`
    干脆**不判**，于是扫整个仓 —— 把使用方的 `examples/`、`scripts/` 一起
    当自己的代码审。

    实测代价：一个真项目接入后 `registry --run commit` 报 149 条 ruff、
    59 条 i18n、3 条 snapshot，**全部指向那个项目自己的文件**。用户修不完
    也理解不了 —— 那是套件的偏好强加给别人。

    判据：模块体里有 `MODULE = …` 或 `GATE = …` 赋值。本仓 36 个 .py
    **全部**满足（做判据前验过），所以「只扫这些」不会漏掉套件自己。
    """
    import ast  # noqa: PLC0415
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            tree = ast.parse(fh.read())
    except (OSError, SyntaxError):
        return False
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if any(isinstance(t, ast.Name) and t.id in ("MODULE", "GATE")
               for t in node.targets):
            return True
    return False


def suite_sources(base):
    """`base` 下**属于套件**的 `.py` 的 `(相对名, 文本)`。

    与 `py_sources` 的区别：只收 `declares_itself()` 为真的文件。用户自己
    在这个目录里放的 `measure_*.py`（数据模块，没有声明）不算套件代码。
    """
    return [(rel, src) for rel, src in py_sources(base)
            if declares_itself(os.path.join(base, rel))]


def scanned_sources(base, configured=False):
    """一道闸门该收哪些 `.py` —— **两条口径，按「旋钮是否显式配了」分**。

    **唯一产地**：此前 `check_i18n.sources_for` 与 `check_snapshots.collect`
    各写了一遍同一个三元判断（`py_sources if configured else suite_sources`），
    两份措辞不同、判据相同 —— 本仓最忌讳的「必须一致的两份」。

      · **未配**（默认面 = 套件自己）⇒ `suite_sources`：只审有声明的文件。
        接进真实项目时，使用方的 `examples/` / `scripts/` 不是本体 —— 实测
        一个真项目因此报 149 条 ruff / 59 条中文 / 3 条快照违规，全在它
        自己的文件里。
      · **配了**（用户指着说「审这里」）⇒ `py_sources`：全收。收窄会让
        `REFLECT_I18N_ROOT=<你的目录>` 报 `scan_empty_dir` FATAL（实测），
        等于把 opt-in 弄坏。
    """
    return py_sources(base) if configured else suite_sources(base)


def py_sources(base):
    """`base` 目录下所有 `.py` 的 `(文件名, 文本)`；读不了 ⇒ 跳过。

    **唯一产地**：这段 `listdir` + `open(errors="replace")` 曾在**三处**
    各写一遍 —— `knobs._py_sources`、`check_snapshots.collect`、
    `check_i18n` 的收集循环。现在都调这里。

    读不了 ⇒ 返回该文件跳过（不是整目录失败）：每个调用方自己判空 ——
    「空」在它们眼里含义不同（幻影扫描当「没有可疑」、`used_codes` 当
    「没有 code」、`envfile` 当「闸门坏了」）。

    ⚠️ `base` 必须显式传：上游默认目录不一样（工具仓的 `zreflect` vs
    被检查仓的 `zreflect`），给默认会把这差别藏起来（实测）。
    """
    import os  # noqa: PLC0415
    out = []
    if not os.path.isdir(base):
        return out
    # ⚠️ **递归**：此前只 `listdir` 一层，于是 `REFLECT_I18N_ROOT=src` 这种
    # 常见布局报「扫描面是空的」—— 而目录根本不空（实测：子代理的验收仓
    # `src/mycli/cli.py` 里明摆着一句中文，判据却什么都没看到）。
    # 名字用**相对 base 的路径**：否则 `a/util.py` 与 `b/util.py` 会互相覆盖，
    # 报错时也说不清是哪个。
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(d for d in dirnames
                             if d not in ("__pycache__", ".git"))
        for n in sorted(filenames):
            if not n.endswith(".py"):
                continue
            p = os.path.join(dirpath, n)
            # ⚠️ **统一成正斜杠**：这个 `rel` 会被三处当**文件名**比较
            # （`check_i18n` 的 `name == "i18n.py"`、`criteria` 的
            # `name == "gate.py"`、`knobs` 的幻影扫描）。Windows 上
            # `relpath` 给 `zreflect\i18n.py` ⇒ 那些相等判断永不成立，
            # 于是「文件级豁免」在 Windows 上整体失效（实测：CI 的
            # Windows 腿把它算成未登记 shell 的同一类问题）。
            rel = os.path.relpath(p, base).replace(os.sep, "/")
            try:
                with open(p, encoding="utf-8", errors="replace") as fh:
                    out.append((rel, fh.read()))
            except OSError:
                continue
    return out


def resolve_spec(argv, knob, default):
    """规格名解析：`--spec` 显式 > 旋钮 > 默认名。返回 `(名字, 是否显式指定)`。

    纯函数，三处闸门（ab / locks / pins）此前各抄一份**逐字相同**的实现，
    只差各自的 `DEFAULT_SPEC` 常量 —— 那是三份会漂的拷贝（C4）。现在那三处只
    传自己的默认名进来。

    显式指定（argv / 旋钮）而文件不在 ⇒ 调用方必须 FATAL（配置了却不存在的
    规格是「部署了 ≠ 在跑」家族，静默当「未启用」会掩盖坏配置）；
    默认名不在 ⇒ 未启用退 0。
    """
    for i, a in enumerate(argv):
        if a == "--spec":
            return argv[i + 1], True
    k = (knob or "").strip()
    if k:
        return k, True
    return default, False


def load_spec(path):
    """读 JSON 规格，返回 (spec, 错误句)。错误句非 None ⇒ 调用方 `fatal()`。

    返回错误而不是 raise：调用方要把旋钮名 / 路径放进自己的 FATAL 措辞。
    """
    import i18n  # noqa: PLC0415
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh), None
    except (OSError, ValueError) as e:
        return None, i18n.M("gate.spec_unreadable", path=path, error=e)


def finish(name, problems, ok):
    """问题循环 + OK 行 —— rc 契约（1 = 发现问题 / 0 = 绿）的唯一产地。"""
    import i18n  # noqa: PLC0415
    if problems:
        print(i18n.M("gate.problems_header",
                     name=name, count=len(problems)), file=sys.stderr)
        for p in problems:
            print("  · " + p, file=sys.stderr)
            # `.forged` 的**消费者**：渲染期把伪造行按住了（不是拒绝），
            # 但「按住了」必须**可见** —— 否则文件名里带换行这件事永远没人知道，
            # 用户只看到一个奇怪的 `\OFF:`。只说在一行里，不刷屏。
            forged = getattr(p, "forged", ())
            if forged:
                print("  " + i18n.M("gate.forged_row_neutralised",
                                    count=len(forged)), file=sys.stderr)
        _maybe_hint()
        return 1
    print(ok)
    _maybe_hint()
    return 0


def _env_hint_off():
    """`REFLECT_ENV_HINT` 显式关了吗 —— 走 `knobs.flag`（词汇表唯一产地）。

    ⚠️ 此前这里 `.lower() == "off"`：与 `doc.accepts_principles` 的
    `("1","true","yes")` 是**两套 flag 词汇表**（后者大小写敏感，实测
    `TRUE` 不生效）。现在统一从 `knobs.flag` 走。
    """
    import knobs  # noqa: PLC0415
    return knobs.flag("REFLECT_ENV_HINT") is False


def _maybe_hint():
    """把 env 提示打到 stderr（**绝不进 stdout** —— 那里有机器契约）。

    `REFLECT_ENV_HINT=off` 可整体关闭（本仓「不喜欢提示的仓」的出口；
    提示本身是**人性化**，不是判据）。
    """
    if _env_hint_off():
        return
    h = env_hint()
    if h:
        print("ℹ %s" % h, file=sys.stderr)


def env_carrier():
    """仓里的 Einfacht.env 载体路径（钩子目录优先、仓库根次之），没有 ⇒ None。"""
    name = (os.environ.get("REFLECT_ENV_FILE", "Einfacht.env").strip()
            or "Einfacht.env")
    for d in (repo("reflect-hooks"), repo()):
        p = os.path.join(d, name)
        if os.path.exists(p):
            return p
    return None


def gate_knobs(module=None):
    """调用方模块声明的 `GATE = meta(…, knobs=…)`（拿不到 ⇒ 空）。

    让 `env_hint()` 不必每个入口手写旋钮名 —— 声明已经有一份（单一产地）。
    """
    import sys as _sys  # noqa: PLC0415
    mod = module if module is not None else _sys.modules.get("__main__")
    decl = getattr(mod, "GATE", None)
    if isinstance(decl, dict):
        return tuple(decl.get("knobs") or ())
    return ()


def env_hint(consumed=(), module=None):
    """**人性化提示**：喂了 env 的入口，在「带了 env 却没生效」时该怎么跑。

    `consumed` = 这个入口实际读的旋钮名（如 `("REFLECT_FACTS",)`）。
    返回一行提示字符串，或 None（无需提示）。

    什么时候提示（三类，都只在对用户**有帮助**时出现）：

      1. 仓里**有** Einfacht.env，但本轮进程**一个旋钮都没设**（`consumed`
         全不在环境里）—— 典型的手工裸跑：`python3 zreflect/check_x.py`
         ⇒ 判据全部回落默认名，结果可能与钩子语境不同，而且**没有任何东西
         会告诉用户**（issue #20② / #15 都栽在这上面）。
      2. 仓里**有** Einfacht.env 且当前设置与它**不一致**？—— 不查（要看值
         才能判，而值依赖 shell 语义）；只查「有没有设」，保持判据廉价可靠。
      3. 仓里**没有** Einfacht.env ⇒ **不提示**（这类仓裸跑是正常用法，提示
         只会变成噪音 —— 本仓「会误报的闸门最终被整闸关掉」的教训）。

    提示语集中在这里（一处措辞），各入口调它 —— 不再各写一份。
    """
    carrier = env_carrier()
    if not carrier:
        return None                      # 无载体的仓：裸跑是正常用法，不吵
    if not consumed:
        consumed = gate_knobs(module)     # 声明里的旋钮清单（零手写）
    if not consumed:
        return None
    # ⚠️ **「旋钮已设」不能一律静默**（#28）：钩子体系靠 source 载体把旋钮
    # 放进环境 —— 接线正确的仓里「环境有旋钮」恒真，原来的第四档提示
    # （有载体却没设旋钮 ⇒ 提示）在任何正常接线的仓里都不可达。
    # 四档语义（比一次载体值，成本一次文件读）：
    #   1. 无载体 ⇒ 静默（裸跑是正常用法）
    #   2. 没设任何消费旋钮 ⇒ **提示**（载体在，但没人 source / 没 export）
    #   3. 旋钮已设且值与载体**一致** ⇒ 载体已生效，静默
    #   4. 旋钮已设但值与载体**不同**（或载体没写它）⇒ **提示**
    #      （手动 export 可能漂 —— 这正是该吵的场景）
    import check_envfile  # noqa: PLC0415
    try:
        with open(carrier, encoding="utf-8", errors="replace") as fh:
            exported = check_envfile.parse_exports(fh.read())
    except OSError:
        exported = {}                    # 读不了载体：按「没写」处理（档案见 guard）
    set_kv = {k: os.environ[k].strip() for k in consumed
              if os.environ.get(k, "").strip()}
    if not set_kv:
        # 第二档：载体在，但一个旋钮都没设 ⇒ 原本的提示场景
        rel = os.path.relpath(carrier, GATE_REPO)
        import i18n  # noqa: PLC0415
        return i18n.M("gate.env_hint", file=rel)
    if all(exported.get(k) == v for k, v in set_kv.items()):
        return None                      # 第三档：载体已生效，静默
    # 第四档：至少一个旋钮被手动 export 且与载体不一致（或载体没写它）
    rel = os.path.relpath(carrier, GATE_REPO)
    import i18n  # noqa: PLC0415
    return i18n.M("gate.env_hint", file=rel)


def meta(name, desc, knobs=(), name_dependent=False, runs_at="commit",
         off_reason=None):
    """闸门声明行（registry 的 ast 提取目标）：名字 + 一句话 + 消费的旋钮。

    声明即登记 —— 手写名录会漂，这里只许写事实。

    · `name_dependent=True` 标给「默认输入被换名自证改名」的闸门
      （gates-selftest 的跨仓库节里必须红的那批）：标了会被两头拦 ——
      夹具要求它真红，registry.problems 要求它真消费改名的默认名。
    · `runs_at`（C1）**正面声明频率**：`"commit"`（每次提交跑，进 hooks /
      CI）或 `"start-of-work"`（开工前手动跑 —— doctor 那种「查会死的东西」，
      挂 pre-commit 频率错）。此前频率只能靠「文件名不叫 check_」这种**否定式
      命名意外**表达，且执行面 glob 与它无关 ⇒ 改个名就把 doctor 变成每次
      提交探测活进程的闸门，无人拦。现在频率是声明里的一个字段，执行面
      （gate.run_phase）按它过滤 —— 名字不再是承重的。

    registry 从这些声明派生：执行清单（按 runs_at 过滤）、叙述
    （AUTO:GATES）、红名单、自证清单。名字只用于 `check_*.py` 的文件约定
    （描述性），不再承载语义。
    """
    return {"name": name, "desc": desc, "knobs": tuple(knobs),
            "name_dependent": bool(name_dependent),
            "runs_at": str(runs_at),
            # `off_reason`（第 12 轮）：本闸门**为什么会未启用**。会调 `off()`
            # 的闸门必须写 —— 否则「off」就没有理由，「永久 off 的闸门」与
            # 「本仓不用这套机制」不可区分（本仓真的有过 8/13 道 off 而「全绿」
            # 不可见的历史）。理由必须 ≥8 字（同 `PINNED:` 的纪律）。
            "off_reason": (None if off_reason is None else str(off_reason))}


def module_meta(name, desc, selftest=True):
    """平台模块声明行（C5）：registry 的 ast 提取目标。

    闸门用 `GATE = meta(…)` 声明；**平台模块**（gate / runner / knobs /
    registry / guard / ledger / render / facts …）用 `MODULE = module_meta(…)`
    声明自己的存在与「有没有自证义务」。此前「该有自证」只能靠**文本猜测**
    （扫 `_cases` 字面量）——「一个模块该有自证却没写」无人问；现在它是声明里
    的一个字段：`selftest=True` ⇒ registry 要求它真能 `--selftest` 且被实跑。
    """
    return {"name": name, "desc": desc, "selftest": bool(selftest)}


def raises(fn):
    """「该报错的必须报错」—— 反向断言用。返回 True 表示它确实报了 SystemExit。"""
    try:
        fn()
    except SystemExit:
        return True
    return False



def _ast_for(fname):
    """整文件 AST（按文件名缓存）。读不到 / 解析不了 ⇒ False（缓存负结果）。"""
    import ast as _ast  # noqa: PLC0415
    import linecache  # noqa: PLC0415
    tree = _AST_CACHE.get((fname,))
    if tree is not None:
        return tree
    try:
        tree = _ast.parse("".join(linecache.getlines(fname)))
    except (OSError, SyntaxError):
        tree = False
    _AST_CACHE[(fname,)] = tree
    return tree


def _lambda_nodes(tree, lineno):
    """起始行 == lineno 的**全部** Lambda 节点（按 col_offset 升序）。

    ⚠️ 为什么返回列表而不是单个：**同一行里可以有多条 lambda**（`return
    [("a", lambda: …), ("b", lambda: …)]` 全在一行）—— 这时 code object 的
    `co_firstlineno` 相同、`co_positions()` 也只给外层位置，**无法区分**是哪
    一条。取 col_offset 最小的那条会让同行的其它断言全部按第一条判定
    （实测踩到：`lambda: 1 == 2` 被同行的 `lambda: … or True` 带累判成恒真）。

    因此返回同行全部候选；调用方对**每一条**都扫一遍，任一条恒真即报 ——
    「同行内任一条断言恒真」本来就该被抓，多报不算误伤。
    """
    import ast as _ast  # noqa: PLC0415
    nodes = [n for n in _ast.walk(tree)
             if isinstance(n, _ast.Lambda) and n.lineno == lineno]
    return sorted(nodes, key=lambda n: n.col_offset)


def _const_truthy(node):
    """这个常量节点恒为真吗（`or True` / `or 1` 的右操作数形状）。"""
    import ast as _ast  # noqa: PLC0415
    if not isinstance(node, _ast.Constant) or node.value is None:
        return False
    return node.value is not False and bool(node.value) is True


def _const_falsy(node):
    """这个常量节点恒为假吗（`and False` / `and 0` 的右操作数形状）。"""
    import ast as _ast  # noqa: PLC0415
    if not isinstance(node, _ast.Constant) or node.value is None:
        return False
    return node.value is False or node.value == 0


def _short_circuit_reason(node):
    """这个 AST 节点构成恒真短路吗 ⇒ 原因消息；否则 None。"""
    import ast as _ast  # noqa: PLC0415

    import i18n  # noqa: PLC0415
    if isinstance(node, _ast.BoolOp):
        if isinstance(node.op, _ast.Or) and any(
                _const_truthy(o) for o in node.values):
            return i18n.M("gate.never_falsifiable_or")
        if isinstance(node.op, _ast.And) and any(
                _const_falsy(o) for o in node.values):
            return i18n.M("gate.never_falsifiable_and")
    if isinstance(node, _ast.Compare) and len(node.comparators) == 1:
        left, right = node.left, node.comparators[0]
        # 排除裸函数调用两次的**合法**纯函数性检验
        # （`render_gates(gs) == render_gates(gs)` 证明渲染确定性）。
        if isinstance(left, _ast.Call) and isinstance(right, _ast.Call):
            return None
        if _ast.dump(left) == _ast.dump(right) and isinstance(
                node.ops[0], (_ast.Eq, _ast.LtE, _ast.GtE)):
            return i18n.M("gate.never_falsifiable_self_compare")
    return None


# 内建函数白名单：它们**在 lambda 里内联逻辑**，不是委托 —— 生成器/实参就在
# 这个 AST 里，恒真检测照样能扫（把内建也判成委托会误伤一半的断言，实测 6 条
# 假阳性）。
_BUILTIN_OK = frozenset({
    "any", "all", "bool", "len", "sorted", "sum", "min", "max",
    "isinstance", "getattr", "hasattr", "str", "int", "set",
    "list", "tuple", "dict", "repr",
})


def _assertion_node(fn):
    """定位这条断言对应的 lambda AST 节点。定位不到 ⇒ `[]`（不猜）。"""
    code = getattr(fn, "__code__", None)
    if code is None:
        return []                                        # 非 Python 函数
    tree = _ast_for(code.co_filename)
    if not tree:
        return []                                        # 读不到 / 解析不了
    return _lambda_nodes(tree, code.co_firstlineno)


def _delegation_reason(nodes):
    """**纯委托**（lambda 体就是一次非内建 Call）⇒ 断言逻辑住在被调用函数里，
    本判据**看不见**它。

    ⚠️ 此前这种情况返回 None（与「扫过且干净」不可区分），于是「提取成 helper」
    就成了关掉恒真检测的合法手段（实测：helper 改成 `return True` 后自证
    26 PASS / 0 FAIL 全绿）。现在把它**明说成未审计** —— 与「读不到就明说」
    同一条纪律。
    """
    import i18n  # noqa: PLC0415
    for node in nodes:
        if isinstance(node.body, ast.Call):
            f = node.body.func
            fname = getattr(f, "id", None) or getattr(f, "attr", None)
            if fname not in _BUILTIN_OK:
                return i18n.M("gate.never_falsifiable_delegated")
    return None


def _short_circuit_reason_of(nodes):
    """扫恒真短路：`or <真值常量>` / `and <假值常量>` / `x == x`。"""
    for node in nodes:
        for n in ast.walk(node):
            reason = _short_circuit_reason(n)
            if reason:
                return reason
    return None


def never_falsifiable(fn):
    """**恒真断言探测**（issue #23）：这条自证用例有证伪能力吗？

    下游实测的事故：一条 `or True` 的断言在 `--selftest` 里永远是 PASS ——
    `gates-selftest` 判的是「返回 0 + 打摘要行」，真断言与恒真断言在这个面上
    完全同形。`AGENTS.md` 纪律 4 说「断言要能证伪」，但此前没有机器判据。

    判据（AST，零执行、零副作用）：**整文件解析 + 按 co_firstlineno 定位**
    lambda 节点（不用 inspect.getsourcelines —— 它对列表里的 lambda 只给首行，
    重建脆弱，实测三次失明）。找到节点后扫恒真短路：

      · `or <真值常量>` / `and <假值常量>` —— 布尔被常量短路，永远 PASS/fail；
      · `x == x` 型自我比较（**排除**裸函数调用两次的合法纯函数性检验）。

    返回原因字符串（不可证伪）或 None（看起来有牙）。

    ## 三条诚实边界（写明的缺口，别当成全覆盖）

    1. **抓不到更隐蔽的恒真**（同一变量换写法）。静态形状判据只认显式短路与
       自我比较；更强的保证是变异测试（每条断言注入破坏器），代价过大 —— 见
       issue #23 的讨论。本判据的价值：把已知的几种无意识写法从「人工复查才
       发现」变成「自证当场红」。
    2. **「委托」只在 body 是**单次 `Call`** 时才报**（见 `_delegation_reason`）。
       若 body 是 `Compare`/`BoolOp` 包着一次 helper 调用 —— 例如
       `lambda: _nf_catches("x") is not None` —— 就**不算委托**，本判据扫不到
       helper 内部。实测：第 22 轮我把 `never_falsifiable` 的自证写成那个形状，
       四条断言在语义上确实有牙（变异测试 RED-OK），但**形态上**躲过了审计。
       放宽判据会误伤大量「复合断言」，所以这里选择**明说缺口**而不是改宽。
    3. **读不到源码文件时不猜**（`-c` 里的 lambda 没有 `co_filename` ⇒ 返回
       None）。自证用例必须写在真文件里 —— 这是第 22 轮补 `never_falsifiable`
       自证时踩到的（`python -c` 里测它永远 None）。

    三段各是一个具名 helper（定位 / 委托 / 短路）：三段互不依赖，拼在一起时
    73 行且「不猜」的三种出口散在中间。
    """
    nodes = _assertion_node(fn)
    if not nodes:
        return None                                      # 定位不到 ⇒ 不猜
    if len(nodes) > 1:
        # 同一行有多条 lambda：code object 无法告诉我们是哪一条（co_firstlineno
        # 相同、co_positions 只给外层位置）。**不确定就不猜** —— 宁可漏报也不
        # 误伤（本仓 99% 的断言都独占一行）。
        return None
    return _delegation_reason(nodes) or _short_circuit_reason_of(nodes)


def _is_delegated(why):
    """这条 `why` 是不是「委托断言」判据（而不是恒真短路）。

    ⚠️ 必须看 `.code`，不能看 `str(why)`：`why` 是一个 `Message`，它的 str 值
    已被**当前语言**渲染 —— 在 `zh` 下变成中文，按英文 code 匹配就永远落空，
    于是委托断言被当成恒真短路报出去（实测：`KeyError: 'label'`）。
    """
    return getattr(why, "code", None) == "gate.never_falsifiable_delegated"


def _run_safely(label, fn):
    """执行断言体。返回 `(通过?, 失败行或 None)`。**异常不许冒出去**。

    `SystemExit` 单独catch：自证用例里 `raises(...)` 这类断言会主动抛，
    那是被测行为，不是自证失败；但它若真的漏到这一层，说明用例写错了。
    """
    import i18n  # noqa: PLC0415
    try:
        return bool(fn()), None
    except SystemExit as e:
        return False, i18n.M("gate.case_unexpected_systemexit",
                             label=label, error=e)
    except Exception as e:                      # noqa: BLE001
        return False, i18n.M("gate.case_raised", label=label, error=e)


def _case_verdict(label, fn):
    """跑一条用例。返回 `(通过?, 委托?, 失败行或 None)`。

    ⚠️ **恒真断言探测**（issue #23）：一条 `or True` 的断言与真断言在
    「返回 0 + 打摘要行」这个面上同形，必须单独判。

    ⚠️ **「委托」可接受但必须可见**：断言体在 helper 里（搭临时夹具的场景没法
    内联）。允许它，但要打成 `note |`（机器可读）并在摘要里单列计数 ——
    不许静默当干净（此前返回 None，与「扫过且干净」不可区分，于是提取
    helper 就成了关掉恒真检测的合法手段）。

    ⚠️ **委托仍然要跑**：此前委托分支直接 `return True`，于是委托给 helper
    的断言**从不执行**，`False` 与 `True` 同形（实测：`_utf8_forced_case`
    的修复被掏空后它返回 False，selftest 照样报「19 PASS / 0 FAIL」）。
    「可接受但可见」说的是**恒真检测看不见它的内部**，不是「不用跑」。

    三段（恒真判 / 委托分支 / 普通执行）各是一处：抽掉「执行 + 异常」之后
    这里只剩分派。
    """
    import i18n  # noqa: PLC0415
    why = never_falsifiable(fn)
    if why and _is_delegated(why):
        passed, failure = _run_safely(label, fn)
        return passed, True, failure
    if why:
        # `fail | ` 是自证机器行前缀 —— 发射点字面量，不进语言包
        return False, False, i18n.M("gate.case_unfalsifiable",
                                    label=label, why=why)
    passed, failure = _run_safely(label, fn)
    return passed, False, failure


def _print_banner(name, total, bad, delegated):
    """摘要三行：委托计数（单列）/ 人读摘要 / 机器摘要行。

    ⚠️ 委托**单列**在摘要里：它不算失败，但也不是「扫过且干净」——
    静默算进 PASS 就是本仓最痛恨的假绿。

    ⚠️ 机器摘要行（issue #3 ③）与检查器名无关、格式固定，runner/CI 直接 grep；
    `=== ` 前缀与收尾 ` ===` 是发射点字面量（语言包值不许以 `^===` 开头）。
    """
    import i18n  # noqa: PLC0415
    if delegated:
        print(machine().emit("human_summary",
                           i18n.M("gate.selftest_delegated",
                                  name=name, count=delegated)))
    print(machine().emit("human_summary",
                       i18n.M("gate.selftest_summary",
                              name=name, passed=total - bad, failed=bad)))
    print(machine().emit_summary(total - bad, bad))


def _report_one(label, fn):
    """跑一条并**当场报出**它的结局。返回 `(通过?, 是否委托, 失败行或 None)`。

    四种结局各有一条输出路径，但「怎么报」与「报不报」必须分开：

      · 委托 + 通过  → `note | … | delegated`
      · 委托 + 失败  → **`fail | …`**（此前这里是 `continue`，把结果整个丢掉）
      · 恒真 / 异常  → `fail | <原因>`
      · 普通         → `PASS | …` 或 `fail | …`
    """
    passed, was_delegated, failure = _case_verdict(label, fn)
    if was_delegated:
        print(machine().emit("note", "%s | delegated" % label))
        if not passed:
            print(machine().emit("fail", label))
        return passed, True, None
    if failure is not None:
        print(machine().emit("fail", failure))
        return False, False, failure
    # 通过行是 `PASS | `，失败行是 `fail | ` —— 两种 kind，一张表
    print(machine().emit("pass" if passed else "fail", label))
    return passed, False, None


def selftest(name, cases):
    """跑三档用例。每个 case = (标签, callable) -> bool。

    必须写齐三类：
      ① 正常不报（阳性对照 —— 否则「总是报错」也能骗过自证）
      ② 该报的必须报（反向断言 —— 否则这个检查器可能是装饰）
      ③ 空输入必须报（零值守卫）

    三层各是一个具名 helper（单条判定 `_case_verdict` / 单条输出
    `_report_one` / 摘要 `_print_banner`）：本函数只累计计数。
    """
    import i18n  # noqa: PLC0415
    if not cases:
        # 0/0 洞（本文件开头记载的第三种事故）：空用例清单的自证什么都没查，
        # 却打印「0 PASS / 0 FAIL」绿着退场 —— runner 的 grep 照样认它。
        # 空清单是写自证时的形状错误，当场响，不许绿。
        fatal_exit(i18n.M("gate.selftest_empty_cases", name=name))
    bad = delegated = 0
    for label, fn in cases:
        ok, was_delegated, _failure = _report_one(label, fn)
        delegated += 1 if was_delegated else 0
        bad += 0 if ok else 1
    _print_banner(name, len(cases), bad, delegated)
    return 1 if bad else 0


def _force_utf8_streams():
    """把 stdout/stderr 强制成 UTF-8（**Windows 上是必须的**）。

    为什么：Windows 上 `sys.stdout.encoding` 默认是 `cp1252`（代码页），
    而这个仓会打印**闸门名与描述**（`GATE = meta("A/B 闸门", …)`）。实测：

        UnicodeEncodeError: 'charmap' codec can't encode characters
                            in position 25-26: character maps to <undefined>

    —— 一条 `registry.py --gates` 就能把 CI 的 Windows 腿整片打红，而 Linux
    上永远复现不了（UTF-8 是默认）。

    ⚠️ 只在**真的支持 reconfigure** 的流上做（`io.StringIO` / 被重定向的
    自定义流没有这个方法），失败就静默跳过 —— 这不是判据，是环境适配。
    副作用是**全局**的（改的是 `sys.stdout`），所以只在 CLI 入口调：
    `activate_or_fatal` 恰好是所有入口的必经点。
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            continue                # 已经关了 / 不支持 —— 不猜


def activate_or_fatal(lang=None):
    """进程级语言包激活点。成功返回 0；装配失败打印 FATAL 并返回 2。

    `lang` 让**一个进程**装配指定的包（不传 = 读 `REFLECT_LANG`）。存在的理由：
    有些入口的消费者与闸门不同 —— 比如使用方包一层把某段输出喂给人读，那一层
    可以自己点名语言，而套件的闸门照旧只认 `REFLECT_LANG`。**「只影响那一个
    进程」因此是结构性的**，不靠谁记得别乱用；套件不因此多一个旋钮。

    **必须在 `--selftest` 之前调用**（issue #26 复盘）：此前 `main_selftest_or`
    先判 `--selftest` 再 `activate()`，于是 `REFLECT_LANG=zh <gate> --selftest`
    把消息按 null 包渲染成裸 code，而 `REFLECT_LANG=de <gate> --selftest` 对一个
    **不存在的包静默 rc=0** —— 与「设了但包不在 ⇒ FATAL rc 2，不静默回落」直接
    矛盾（实测：render / ledger / runner / registry 四条入口全中）。

    收起成函数是为了让**不走 `main_selftest_or` 的入口**（render/ledger 的
    `_selftest()`、registry 的 `__main__`、gate 自己的 `__main__`）不必各抄一份
    activate+FATAL（此前 registry 抄了一份，gate 自己那份干脆没有 FATAL，
    直接裸 traceback 退 1）。
    """
    import i18n  # noqa: PLC0415

    _force_utf8_streams()
    try:
        i18n.activate(lang)
    except Exception as e:                               # noqa: BLE001
        # 装配失败时进程默认仍是上一档 `Catalog`（通常是 null 包）⇒ M() 照样
        # 渲染得出来（`MissingPack` 的 `str()` 本身就是 null 形状的 code）。
        print(machine().emit("fatal",
                           i18n.M("gate.pack_assembly_failed", error=e)),
              file=sys.stderr)
        return 2
    return 0


def main_selftest_or(args, name, cases, run):
    """`--selftest` 走自证，否则走 `run(args)`。每个检查器都用它收尾。

    `cases` 可以是清单，也可以是**工厂 callable**（需要搭临时夹具的
    自证 —— ab/locks/pins 体例 —— 传函数，由这里调用）。

    **这里是语言包的进程级激活点**（issue #26）：`REFLECT_LANG` 未设 ⇒ null 包
    （本体零语言）；设了但包不在 ⇒ `MissingPack` ⇒ FATAL rc 2（不做「没装就
    回落」）。每个闸门都经这里 ⇒ 一处接线，全部受益。激活**先于** `--selftest`
    分流，理由见 `activate_or_fatal`。
    """
    rc = activate_or_fatal()
    if rc:
        return rc
    if "--selftest" in args:
        return selftest(name, cases() if callable(cases) else cases)
    return run([a for a in args if a != "--selftest"])


def default_runner(f, repo_root=None):
    """默认执行器：跑一个闸门文件，返回 `(rc, 合并后的输出)`。

    ⚠️ **stdout 与 stderr 必须合并**：本仓约定「问题行统一 stderr」，于是
    rc=2 的闸门 stdout 可能是**空的**（原因全在 stderr）。只回 `p.stdout`
    ⇒ 聚合方拿到 (2, "")，既不知道哪个文件坏了也不知道为什么
    （实测：`REFLECT_SNAPSHOT_ROOT=/nonexistent` ⇒ stdout=''）。
    """
    import subprocess  # noqa: PLC0415
    p = subprocess.run([sys.executable, f], capture_output=True, text=True,
                       cwd=repo_root or GATE_REPO,
                           encoding="utf-8", errors="replace")
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def _empty_result():
    """聚合结果的初始形状。`fail_out` 收**每个失败闸门的原始输出**。

    ⚠️ 聚合方只打文件名时，用户得自己重跑一遍才知道为什么红（实测：hook
    只报 `FAILED check_facts.py`，而直接跑它才有
    `facts.bare_number_unaccounted(line=9, …)`）。
    """
    return {"ran": 0, "off": 0, "failed": 0, "fatal": 0, "error": 0,
            "off_list": [], "fail_list": [], "fatal_list": [], "error_list": [],
            "fail_out": {}}


def _record(res, f, rc, out):
    """按 rc 与 `OFF:` 标记把一道闸门归入五档之一。

    五档是**互不重叠的修法分类**：

      rc=2   配置 / 环境坏        → 改配置
      rc<0   被信号杀掉
      rc>2   用了未约定的码        → 执行器层面坏了
      rc=1   判据红                → 修问题
      rc=0 + `OFF:` 标记           → 未启用（不是通过）
      rc=0 干净                    → 跑过且通过

    ⚠️ rc<0 / rc>2 单列成 `error`：此前一律塞进 `failed`，于是「闸门报了个
    问题」与「闸门被 SIGKILL」不可区分（review 实测 rc=3 / rc=-9 都落进 failed）。
    """
    if rc == 2:
        res["fatal"] += 1
        res["fatal_list"].append(f)
    elif rc < 0 or rc > 2:
        res["error"] += 1
        res["error_list"].append(f)
    elif rc != 0:
        res["failed"] += 1
        res["fail_list"].append(f)
        res["fail_out"][f] = out or ""
    elif any(kind == "off" for _i, kind, _ln in machine().scan(out)):
        res["off"] += 1
        res["off_list"].append(f)
    else:
        res["ran"] += 1


def run_phase(phase, gates, runner=None, repo_root=None):
    """按相位跑一组闸门并**聚合 ran / off / failed**（C1+C2 的执行面）。

    这是 hooks / CI / runner 的**唯一执行入口** —— 取代此前散在 6 处的
    `for g in zreflect/check_*.py` glob。`gates` = registry 派生的
    (file, runs_at) 清单（调用方按 `phase` 过滤，或传全集由这里过滤）。

    为什么聚合三档而不是只看 rc：off 与「跑过且通过」rc 都是 0，只看 rc
    会把「没跑」算进「绿」（本仓实测 8/13 道 off）。这里读子进程 stdout 的
    `OFF:` 机器标记把 off 单列，于是「全绿」永远附带「其中 N 道 off（没查）」。
    `runner` 可注入（自证用假执行器）。

    返回 `{ran, off, failed, fatal, off_list, fail_list, fatal_list}`。

    分类逻辑在 `_record`（五档互不重叠，见其文档）：本函数只做过滤与遍历。
    """
    run = runner or (lambda f: default_runner(f, repo_root))
    res = _empty_result()
    for item in gates:
        f = item["file"] if isinstance(item, dict) else item
        if isinstance(item, dict) and item.get("runs_at") not in (None, phase):
            continue
        rc, out = run(f)
        _record(res, f, rc, out)
    return res


# `selftest=False` 的**真实含义**：本模块**没有 `--selftest` 入口**（它提供
# `selftest()` 本身，自举会打架）。**这不等于它的逻辑没有自证**——它的逻辑
# 住在 `registry._cases()` 里：`finish` / `meta` / `run_phase` / `default_runner`
# / `zdir` / `tool_repo` / `never_falsifiable`（经 `_nf_catches`）都有实质断言。
# 此前描述只写「提供 selftest，自己不消费」—— 读起来像「没有自证义务」，
# 与事实不符（第 23 轮对齐）。
MODULE = module_meta(
    "闸门平台",
    "rc 契约 + 零值守卫 + 三档自证 + 相位执行器（无 --selftest 入口：自举会打架；"
    "逻辑自证住在 registry._cases）",
    selftest=False)


if __name__ == "__main__":
    import i18n  # noqa: PLC0415
    # 此前这里裸 `i18n.activate()`：包不在 ⇒ MissingPack **traceback rc=1**，
    # 而不是 rc 契约的 FATAL rc=2（实测踩到）。走同一个激活入口。
    rc = activate_or_fatal()
    if rc:
        sys.exit(rc)
    print(i18n.M("gate.platform_root", root=GATE_REPO))
    print(i18n.M("gate.platform_usage"))
    sys.exit(0)
