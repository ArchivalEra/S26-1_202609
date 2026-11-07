#!/usr/bin/env python3
"""事实台账的 CLI：量一遍、写台账、渲染机器块，以及**两道守卫**。

用法
    python3 zreflect/facts.py                      # 量一遍并写 FACTS.json（掉条/改口会拒绝）
    python3 zreflect/facts.py --allow-drop         # 允许本次掉条（掉掉的键会打出来）
    python3 zreflect/facts.py                      # 量一遍（数值事实 + 原则的判定命令）
    python3 zreflect/facts.py --accept-changes     # 允许本次改口（旧值→新值会打出来）
    python3 zreflect/facts.py --accept-changes=k1,k2  # 只接受列出的键，其余改口仍拒绝（issue #3 ①）
    python3 zreflect/facts.py --render-doc [文件]  # 把机器块写进文档（默认 STATE.md）
    python3 zreflect/facts.py --check [文件]       # 文档里的块是否与台账一致
    python3 zreflect/facts.py --get 键名           # 只打印该键的值（消费方出口，issue #4 ④）
    python3 zreflect/facts.py show [键]            # 打印某条事实
    python3 zreflect/facts.py --selftest           # 自证：两道守卫必须都能红

⚠️ **量不到的项不写**（宁缺勿假）。比如「最近一次全绿回归」只在有日志的机器上量得出来；
没日志就把那条事实**留空**，而不是写 0 —— 0 是一个数字，会被人当结果引用。
"""
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import gate  # noqa: E402
import guard  # noqa: E402
import knobs  # noqa: E402
import registry  # noqa: E402
from gate import (  # noqa: E402
    machine,  # noqa: E402
    main_selftest_or,
    module_meta,
    repo,
)
from i18n import M  # noqa: E402
from ledger import age_days, fact, facts_of, load, value_of  # noqa: E402
from render import BLOCK_BEGIN, BLOCK_END, render_block  # noqa: E402

REPO_REAL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEDGER_NAME = os.environ.get("REFLECT_FACTS", "FACTS.json")

def _out():
    """台账写盘路径。**函数而不是模块常量**：`repo()` 读的是 `gate.GATE_REPO`，
    而夹具会改它 —— 存成模块级字符串会让路径停在被 import 的那一刻。
    实测：改 `gate.GATE_REPO` 后，旧的 `OUT` 常量仍是原仓路径（陈旧快照）。"""
    return repo(LEDGER_NAME)
# ⚠️ **不是模块级常量**：`REFLECT_DOC` 是名字型旋钮，钩子在运行期间可以改它
# （夹具就换它）。`doc.state_name()` 每次现读 —— 唯一的产地。
# 此前这里有个 `DOC = os.environ.get(...)` 的 import 时快照，与
# `doc.state_name()` 构成**两个产地**（snapshot 闸门抓的那种形状）。
def _doc():
    import doc  # noqa: PLC0415
    return doc.state_name()


# ══ 你的部分 ══════════════════════════════════════════════════════════════════
_COUNT_CMD = "python3 zreflect/facts.py --count"


def count_files(root, suffix):
    """`root` 下以 `suffix` 结尾的文件数（跳过 `.git`）。"""
    n = 0
    for _dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d != ".git")
        n += sum(1 for f in filenames if f.endswith(suffix))
    return n


def count_lines(root, suffix):
    """`root` 下以 `suffix` 结尾的文件的**总行数**（跳过 `.git`）。

    与 `count_files` 分开而不是一个带模式的函数：两者的「数什么」不同
    （一个是文件，一个是行），混在一起会让 `cmd` 多一个参数、也就多一处
    可能写错的地方。
    """
    total = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d != ".git")
        for name in sorted(filenames):
            if not name.endswith(suffix):
                continue
            try:
                with open(os.path.join(dirpath, name), encoding="utf-8",
                          errors="replace") as fh:
                    total += sum(1 for _ in fh)
            except OSError:
                continue                # 数不出来的文件不计数 —— 宁缺勿假
    return total


_AUTO_BLOCK = re.compile(r"^\s*<!--\s*(/?AUTO:[A-Z]+)\s*-->\s*$")


def _count_file_lines(path):
    """一个 `.md` 文件里**机器块之外**的行数。读不到 ⇒ 0（宁缺勿假）。"""
    total = 0
    in_block = False
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                m = _AUTO_BLOCK.match(line)
                if m:
                    in_block = not m.group(1).startswith("/")
                    continue
                if not in_block:
                    total += 1
    except OSError:
        return 0                    # 读不到的文件不计数 —— 宁缺勿假
    return total


def count_md_lines(root):
    """`.md` 文件里**机器块之外**的行数（跨平台，纯 Python）。

    这是 `md_lines` 的**唯一实现** —— 此前它是一条 `find | awk | wc` 的
    shell 管道：
      · Windows 上没有 `find` / `awk` / `wc`（CI 的 Windows 腿会红）；
      · 而且 shell 的引号 / 转义在不同平台上有各自方言。
    现在计数逻辑住在这里，`cmd` 只剩「调这一行」，仍然可逐字复跑。

    排除**全部**机器块（不只 FACTS）：`AUTO:GATES` 与 `AUTO:RULES` 也是渲染
    产出的，漏掉它们 ⇒ 渲染一次行数就 +47，`check_facts_replay` 永久红，
    而修法看起来是「再量一遍」—— 再量只会把新值写进台账，下次渲染又变。

    ⚠️ **标记必须独占一行才算块边界**（`^...$`）。此前的 awk 版
    （`/<!-- AUTO:[A-Z]+ -->/{b=1; next}`）把**正文里提到标记**也当成块开始 ——
    实测代价：`AGENTS.md` 有一行写着「`STATE.md` 里预先放好
    `<!-- AUTO:FACTS -->` / `<!-- AUTO:GATES -->` 标记」（讲 `--init` 做什么），
    从那行起文件**剩余 22 行全被排除**，而台账里 `md_lines` 一直是少算的
    2663 —— 没有任何一行输出说它错了。这是本仓最恨的形状。

    逐文件的块状态机抽成 `_count_file_lines`：它有自己的「读不到 ⇒ 0」出口。
    """
    total = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d != ".git")
        total += sum(_count_file_lines(os.path.join(dirpath, name))
                     for name in sorted(filenames) if name.endswith(".md"))
    return total


def measure_example():
    """**占位实现 —— 换掉它。** 系统只提供机制，你的输入只有你知道怎么量。

    这里量的东西和「事实」无关，只是为了让仓库开箱能跑。真要落地时，把每条
    `fact(值, 复跑命令, 出处)` 换成你自己量出来的数；特别是那条复跑命令 ——
    它必须**真的能跑**，否则这条事实就又变成了一句散文。
    """
    facts = {}
    n_py = 0
    n_md = 0
    lines_py = 0
    for root, _dirs, files in os.walk(gate.GATE_REPO):
        if "/.git" in root:
            continue
        for f in files:
            if f.endswith(".py"):
                n_py += 1
                try:
                    lines_py += sum(1 for _ in open(os.path.join(root, f), encoding="utf-8",
                                                    errors="replace"))
                except OSError:
                    pass                      # 数不出来的文件不计数 —— 宁缺勿假
            elif f.endswith(".md"):
                n_md += 1
    # `cmd` 一律走 `facts.py --count ...`（纯 Python）而不是 `find | wc`：
    # Windows 上没有 `find` / `wc`，而且 shell 引号方言各平台不同。
    # 示例的复跑命令也必须是跨平台的 —— 它是**给使用方抄的样板**。
    py_files_cmd = "%s -files .py" % _COUNT_CMD
    md_files_cmd = "%s -files .md" % _COUNT_CMD
    facts["py_files"] = fact(n_py, py_files_cmd, "repo",
                             M("facts.note.example_fact"))
    facts["md_files"] = fact(n_md, md_files_cmd, "repo")
    # 这条刻意大于 BARE_MIN（check_facts 的裸数字阈值 = 100），好在 STATE.md 里
    # 演示「手抄这个数字会被闸门拦下」。太小的数字遍地都是，查了全是噪音 ⇒ 不查。
    facts["py_lines"] = fact(lines_py, "%s -lines .py" % _COUNT_CMD, "repo",
                             M("facts.note.bare_number_demo"))
    # ⑥ 块排除模式（issue #4 ⑥）：md_lines 数**块以外**的行 —— 机器块
    # 就渲染在这些文档里，数进去 ⇒ 渲染一遍值就过期 ⇒ 复跑恒定失败
    # （而 check_facts 比的是「块↔台账」，两边一起陈旧 ⇒ 全绿）。
    # awk 的 FNR==1{b=0} 是必需的：find -exec {} + 会把多个文件喂给
    # 同一个 awk 进程，漏了按文件重置，第一个带块的文件之后全被跳过，
    # 而输出仍然「像个行数」。起始标记与 render.py 的输出逐字一致。
    # ⚠️ 排除**全部**机器块，不只 FACTS：`AUTO:GATES` 与 `AUTO:RULES` 也是
    # 渲染产出的，漏掉它们 ⇒ 渲染一次行数就 +47（实测：bootstrap 后
    # 38 → 59），`check_facts_replay` 永久红，而修法看起来是「再量一遍」——
    # 再量只会把 59 写进台账，下次渲染又变。
    # 状态机版：见到任一 `<!-- AUTO:* -->` 进块、见到对应收尾出块。
    # `cmd` 只剩「调这一行」：计数逻辑在 `count_md_lines()`（纯 Python）。
    # 此前是 `find | awk | wc` 管道 —— Windows 上没有那三个命令。
    md_lines_cmd = '%s -md' % _COUNT_CMD
    md_lines = count_md_lines(gate.GATE_REPO)
    # cwd=GATE_REPO：计数（os.walk(GATE_REPO)）与复跑（闸门在仓库根
    # 逐字执行 cmd）都锚定 GATE_REPO —— 不传 cwd 时，在夹具里量到的是
    # 调用方仓库的行数，换名自证会红（跨仓库可配置性自证抓到的回归）。
    facts["md_lines"] = fact(md_lines, md_lines_cmd, "repo",
                              M("facts.note.excludes_machine_block"))

    # 例：**量不到就不写**。把 UPSTREAM_VERSION 设上才有这条事实。
    v = os.environ.get("UPSTREAM_VERSION", "").strip()
    if v:
        facts["upstream_version"] = fact(v, "echo \"$UPSTREAM_VERSION\"", "env",
                                         M("facts.note.measure_or_omit"))
    return facts


# ══ 以下不用改 ════════════════════════════════════════════════════════════════
def _has_principles_doc():
    """这个仓接受本套件的原则吗？—— **声明**在 `doc.accepts_principles()`，
    这里只转发（判断只在那一处）。"""
    import doc  # noqa: PLC0415
    return doc.accepts_principles()


def _doc_names():
    """有机器块的文档名（按 `_block_homes` 的归属派生，不手写名单）。

    ⚠️ **必须尊重 `REFLECT_NO_PRINCIPLES`**（#27②）：`doc.accepts_principles()`
    认 opt-out，而这里曾无条件返回两份 ⇒ 不采用原则文档的仓跑 `--check`
    FATAL `doc_missing_check`，且 `gate._prepare(push)` 硬编码不带文档名的
    `facts.py --check` ⇒ **pre-push 必红** —— 同一个 opt-out 在两处行为
    不同，正是「一份规则两个产地」的形状（下游实测）。
    """
    import doc  # noqa: PLC0415
    names = [_doc()]
    if _has_principles_doc():
        names.append(doc.PRINCIPLES)
    return tuple(names)


def _block_homes(ledger):
    """**块 ← 文档**的归属（数据，不是散在代码里的 if）。

        AUTO:FACTS → STATE.md        台账渲染，**数字的唯一产地**
        AUTO:GATES → STATE.md        发现式名录渲染，**闸门叙述的唯一产地**
        AUTO:RULES → PRINCIPLES.md   纪律表渲染，**规矩叙述的唯一产地**

    为什么纪律块单独一份文档：纪律是「不变的设计原则」，状态是「此刻什么样」，
    历史是「当年的经过」。混在一份里 ⇒ `check_stale` 只能整份当活状态扫，
    历史里的旧数字一露面就红。

    返回 ([(文档名, [(begin, end, 渲染结果), …]), …], 错误句)。
    名录对账不过（缺声明 / 孤儿 / 旗标错）⇒ 拒绝渲染 —— 判据只有一份产地。
    """
    gs, missing = registry.gates()
    probs = registry.problems(gs, missing)
    if probs:
        return None, M("facts.registry_mismatch", entries="\n  · ".join(probs))
    import doc  # noqa: PLC0415
    homes = [(_doc(), [(BLOCK_BEGIN, BLOCK_END, render_block(ledger)),
                       (registry.GATES_BEGIN, registry.GATES_END,
                        registry.render_gates(gs))])]
    # 原则块跟 `_doc_names()` 同一条 opt-out（#27②）：不采用原则的仓
    # 连渲染带 check 都不碰 PRINCIPLES.md —— 两处若一处认一处不认，
    # opt-out 就只对一半命令生效。
    if _has_principles_doc():
        homes.append((doc.PRINCIPLES,
                      [(doc.RULES_BEGIN, doc.RULES_END, doc.render_rules())]))
    return homes, None



def _read_doc(p, path_rel):
    """读文档。返回 `(正文, rc)`；rc 非 0 = 已经报过 FATAL。

    ⚠️ **读不了 ≠ 块过期**：非法 UTF-8 / 权限 / 是目录 —— 全是配置事故
    （FATAL rc=2）。此前这里直接 `open().read()`，一个二进制文件让 Python
    抛裸 `UnicodeDecodeError` 并以 **1** 退出，而 rc=1 在 `registry --run`
    里是「判据红」—— 修法完全不同（换文件 vs 修内容）。
    """
    try:
        return open(p, encoding="utf-8").read(), 0
    except (OSError, UnicodeError) as e:
        print(machine().emit("fatal", M("facts.doc_unreadable",
                                        path=path_rel, error=e)),
              file=sys.stderr)
        return None, 2


def _own_blocks(path_rel, ledger):
    """这个文档**归属**的机器块。返回 `(blocks, rc)`；rc 非 0 = 必须回报。

    ⚠️ **找不到归属 ⇒ 必须报**（零值守卫），不许 `blocks=[]` 静默绿。一个不在
    归属表里的文档（比如老用户传了个自定义名字）没有块可校验，那「返回 0」
    就是在说「没有块过期」—— 一句什么都没查过的话。

    `write_doc` 与 `check_doc` 此前各抄一份这段（含注释），任何改动要同时
    动两处 —— 正是本仓「两份必须一致的东西一定会不一致」的假定。
    """
    homes, err = _block_homes(ledger)
    if err:
        print(machine().emit("fatal", err), file=sys.stderr)
        return None, 2
    # 只校验**属于这个文档**的块。别的块的标记在别的文档里 —— 在这儿找不到是
    # 正常的（此前把所有块都往一份文档塞：纪律块的标记不在 STATE.md 里 ⇒ 报）。
    mine = [b for name, blocks in homes
            if name in (os.path.basename(path_rel), path_rel)
            for b in blocks]
    if mine:
        return mine, 0
    print(machine().emit("fatal",
                          M("facts.doc_has_no_home", path=path_rel,
                            known=", ".join(name for name, _ in homes))),
          file=sys.stderr)
    return None, 2


def _replace_blocks(text, blocks, path_rel):
    """就地把每个块替换成新正文。返回 `(新正文, rc)`。

    块首尾标记必须都在 —— 缺了就是文档被改坏了，**不悄悄追加**：悄悄追加
    会让「块过期」变成「有两份块」，那是更难查的坏法。
    """
    new = text
    for begin, end, body in blocks:
        if begin not in new or end not in new:
            print(machine().emit("fatal",
                                  M("facts.markers_missing_render",
                                    path=path_rel, begin=begin, end=end)),
                  file=sys.stderr)
            return None, 2
        pre, _, rest = new.partition(begin)
        _, _, post = rest.partition(end)
        new = pre + body + post
    return new, 0


def _swallowed_marker_problems(new, blocks, path_rel):
    """写盘前的完整性守卫：替换必须保得住**全部**块的标记。

    标记字面量若被写进正文（哪怕在行内代码里），首现替换会把两块之间的内容
    整个吞掉、让别的块消失 —— 实测踩过：bullet 里写了标记字面量，渲染一次
    丢掉整个事实块。歧义 ⇒ 拒绝写盘，人先修文档（块内 cmd 引用 begin 字面量
    是合法嵌套 —— `md_lines` 的 awk 判据 —— 故不做替换前的计数断言）。
    """
    out = []
    for begin, end, _ in blocks:
        if begin not in new or end not in new:
            out.append(M("facts.marker_swallowed_body",
                         path=path_rel, begin=begin))
    return out


def write_doc(path_rel, ledger):
    """把机器块写进文档（就地替换）。没有标记就报错，**不悄悄追加**。

    三步各是一个具名 helper（读 / 替换 / 完整性守卫）：它们各自有一组
    「拒绝写盘」的出口，拼在一起时读者要数 return 才知道哪些已经查过。
    """
    p, blocks, text, rc = _prepare_render(path_rel, ledger)
    if rc:
        return rc
    new, rc = _replace_blocks(text, blocks, path_rel)
    if rc:
        return rc
    swallowed = _swallowed_marker_problems(new, blocks, path_rel)
    if swallowed:
        for x in swallowed:
            print(machine().emit("fatal", x), file=sys.stderr)
        return 2
    if new == text:
        print(M("facts.render_unchanged", path=path_rel))
        return 0
    rc = _write_or_fatal(p, new, path_rel)
    if rc:
        return rc
    print(M("facts.render_written", path=path_rel))
    return 0


def _prepare_render(path_rel, ledger):
    """三道前置：文档在 / 块归属对 / 文档读得出。返回 `(path, blocks, text, rc)`。

    任一失败都返回非 0 的 rc（已报过 FATAL）—— 「文件在不在 / 归属对不对 /
    读不读得出」是三种不同的配置事故，各自的错误码不同。
    """
    p = gate.repo_path(path_rel)
    if not os.path.exists(p):
        print(machine().emit("fatal", M("facts.doc_missing_render", path=p)),
              file=sys.stderr)
        return p, None, None, 2
    blocks, rc = _own_blocks(path_rel, ledger)
    if rc:
        return p, None, None, rc
    text, rc = _read_doc(p, path_rel)
    return p, blocks, text, rc


def _write_or_fatal(p, new, path_rel):
    """写盘。失败是**环境事故**（FATAL rc=2），不是「块过期」（rc=1）。

    此前 `open(...).write(...)` 让它变成裸 traceback + rc=1 —— 调用方会去查
    块内容，而问题是文件不可写。只读 / 磁盘满 / 权限都属于这一类。
    """
    try:
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(new)
    except OSError as e:
        print(machine().emit("fatal", M("facts.doc_unwritable",
                                        path=path_rel, error=e)),
              file=sys.stderr)
        return 2
    return 0


def check_doc(path_rel, ledger):
    p = gate.repo_path(path_rel)
    if not os.path.exists(p):
        print(machine().emit("fatal", M("facts.doc_missing_check", path=p)), file=sys.stderr)
        return 2
    blocks, rc = _own_blocks(path_rel, ledger)
    if rc:
        return rc
    text, rc = _read_doc(p, path_rel)
    if rc:
        return rc
    for begin, end, body in blocks:
        if begin not in text or end not in text:
            print(machine().emit("fatal",
                                  M("facts.markers_missing_check",
                                    path=path_rel, begin=begin, end=end)),
                  file=sys.stderr)
            return 2
        cur = text.split(begin, 1)[1].split(end, 1)[0]
        fresh = body.split(begin, 1)[1].split(end, 1)[0]
        if cur != fresh:
            print(machine().emit("fatal",
                                  M("facts.block_stale",
                                    path=path_rel, begin=begin)),
                  file=sys.stderr)
            return 1
    print(M("facts.block_consistent", path=path_rel))
    return 0


def _age_human(entry):
    """`measured_at` 的人话（issue #3 ②）：今天 / N 天前 / 未记录。"""
    d = age_days(entry)
    if d is None:
        return M("facts.age.unrecorded")
    if d < 1:
        return M("facts.age.today")
    return M("facts.age.days_ago", days=int(d))


def _measure():
    """采集入口（issue #15 A1/C3）：`REFLECT_MEASURE_MODULE` 旋钮分派。

    · 旋钮未配 / 模块导入失败 / 夹具场景（gate.GATE_REPO 不是本仓）⇒ 回落
      `measure_example()`（占位），并**打印警告** —— 下游实测过：手动跑
      facts.py 忘带旋钮 ⇒ 空表 + `--allow-drop` 诱惑（OM 仓「会掉 24 条」
      的吓人 FATAL，真因只是旋钮没传）。回落必须可闻，不许静默。
    · 旋钮已配且导入成功且 gate.GATE_REPO 是真仓 ⇒ 用旋钮指定的 measure()。
    """
    mod_name = os.environ.get("REFLECT_MEASURE_MODULE", "").strip()
    if mod_name:
        try:
            _m = __import__(mod_name)
            fn = getattr(_m, "measure")   # noqa: B009 — 模块是变量，属性名固定是契约
        except Exception as e:                            # noqa: BLE001
            # ⚠️ **配了却用不了 ⇒ FATAL**，不许回落到占位实现。
            #
            # 此前只打一句 `⚠ …unusable` 然后照跑 `measure_example()` ——
            # 于是用户**会以为量的是自己的仓**，而台账里写的是套件自身的规模
            # （实测：模块放在仓根而不是 `zreflect/` 里 ⇒ ModuleNotFoundError
            # ⇒ 静默回落；`STATE.md` 的 `py_lines` 是 15765，用户项目只有 67 行）。
            # 「配了却没生效」与「没配」是两件事：前者是配置事故，必须响。
            print(machine().emit("fatal", M(
                "facts.measure_module_unusable", module=mod_name,
                error=repr(e), hint=M("facts.measure_module_where"))),
                file=sys.stderr)
            raise SystemExit(2) from e
        if os.path.abspath(gate.GATE_REPO) == os.path.abspath(REPO_REAL):
            return fn()
    else:
        # ⚠️ 警告**不分仓**：此前只在「GATE_REPO 就是套件自己的仓」时打，
        # 于是**所有下游仓**（正是最需要这条提示的地方）静默拿到一份
        # 「关于 Einfacht 的数字」（子代理验收实测：新仓 `py_lines 13269`
        # 而它的代码只有 67 行，`STATE.md` 里写的全是套件自己的规模）。
        print("⚠ %s" % M("facts.measure_placeholder_used"), file=sys.stderr)
        # 再给一条**具体**的：这个仓有它自己的代码吗？有就说怎么量它。
        own = _own_code_hint()
        if own:
            print("  %s" % own, file=sys.stderr)
    return measure_example()


# 一个仓「有自己的代码」的常见形状（只看目录名，不猜内容）。
_OWN_CODE_DIRS = ("src", "lib", "app", "pkg", "packages")


def _own_code_hint():
    """这个仓看起来有自己的代码吗？有 ⇒ 返回一句**具体**的提示。

    只在 `REFLECT_MEASURE_MODULE` 没配时调用 —— 那是「你还没告诉我要量什么」
    的时刻，也是唯一该提示的时刻。
    """
    root = gate.GATE_REPO
    found = [d for d in _OWN_CODE_DIRS if os.path.isdir(os.path.join(root, d))]
    if not found:
        return None
    return str(M("facts.measure_own_code_hint", dirs=", ".join(found)))


def _carry_first_seen(facts, old):
    """仪器生命周期（issue #6 ①）：值没变的键沿用旧 `first_seen`
    （换值 / 新键的 first_seen 已由 `ledger.fact()` 盖今天）——
    恒常检测（可插拔闸门 `check_instruments.py`）靠它。
    """
    for key, entry in facts.items():
        prior = old.get(key)
        fs = prior.get("first_seen") if isinstance(prior, dict) else None
        if fs and value_of(prior) == value_of(entry):
            entry["first_seen"] = fs


def _write_ledger_doc(out, facts):
    """把台账写盘。返回 `(rc, 错误消息或 None)`。"""
    import json  # noqa: PLC0415
    import time  # noqa: PLC0415
    doc = {"schema": 1, "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
           "_why": M("facts.ledger_why"),
           "facts": facts}
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    return 0, None


def measure(argv):
    """量一遍并写台账。**必须接 `argv`** —— 两道守卫都要读它。

    ⚠️ 这里踩过：`measure()` 曾经没有 `argv` 参数，而守卫里写着 `not in argv`。
    因为 `and` 短路，**只在真的掉条时**才走到那句 ⇒ 报的不是「掉了哪几条」而是一段
    NameError traceback；`--allow-drop` 从未生效过。写盘被拦住只是**顺带**（异常早于写盘），
    那不叫守卫，那叫故障。所以本文件把 argv 显式传进来；守卫的**决策**在
    `zreflect/guard.py`（decide()，接线有自证），本函数只执行它。

    三段各是一个具名 helper（量 / 守卫 / 写盘）：拼在一起时「拒绝」与「成功」
    两条结局交错，复杂度 11。
    """
    facts = _measure()
    # 原则是与数值事实同处一张表的事实 —— 一起量、一起守、一起复跑。
    # 「唯二必须丈量的东西」= STATE（这些数值）与 PRINCIPLE（这些判定）。
    #
    # ⚠️ 只在**有 PRINCIPLES.md 的仓**里登记原则：跨仓夹具的临时目录没有那份
    # 文档，把本仓的原则复制进它的台账 ⇒ 每条命令都在外仓语境下跑，全红
    # （实测）。「这个仓要不要遵守这些原则」由**那份文档存在与否**决定 ——
    # 与 `_block_homes` 用的是同一个声明（块 ← 文档），不是第二套判断。
    import doc  # noqa: PLC0415
    if _has_principles_doc():
        facts.update(doc.facts_of_rules())

    out = _out()
    # ⚠️ **形状守卫必须在写盘之前**：`measure()` 是用户写的代码，返回裸值
    # （`{"deploys": 12}`）是最自然的写法。此前那种输入会**先把坏台账写进去、
    # 再在打印时崩 traceback**：
    #
    #     wrote FACTS.json (15 facts)          ← 已经写盘
    #     TypeError: 'int' object is not subscriptable
    #
    # 于是台账里留下一个没有 `value` 字段的条目，而用户只看到一行 traceback。
    rc = _shape_guard(facts)
    if rc:
        return rc
    old = facts_of(_read_or_exit(out)) if os.path.exists(out) else {}

    rc = _guarded_write(argv, old, facts)
    if rc:
        return rc
    _carry_first_seen(facts, old)
    rc, err = _write_ledger_doc(out, facts)
    if err:
        print(machine().emit("fatal", err), file=sys.stderr)
        return 2
    print(M("facts.measure_written",
            path=os.path.relpath(out, gate.GATE_REPO), count=len(facts)))
    for k, v in sorted(facts.items()):
        print("  %-20s %s（%s）" % (k, v["value"], _age_human(v)))
    return 0


def _shape_guard(facts):
    """`measure()` 的返回值形状：每条都必须是 `ledger.fact()` 的形状。

    合规：`{"key": {"value": ..., "cmd": ..., "source": ...}}`。
    不合规（最常见）：`{"key": 12}` 裸值。

    ⚠️ **在写盘之前查**。此前坏形状会先写进去再在打印时崩 traceback，
    台账里留下无 `value` 的条目，而报错只有一行 `TypeError`。
    这是「写了一半 + 无字段名 + 无指引」—— 最不该出现的形状。

    合法来源有三个：`ledger.fact()`（正常）、旧台账里已有的 dict（`--accept*`
    的重写路径）、`facts_of(ledger)` 合并出来的 dict。它们都带 `value` 键
    （或本身就是 `{"value": …}` 的同类形状），所以判据是「有 `value` 键」。
    """
    bad = sorted(k for k, v in (facts or {}).items()
                 if not (isinstance(v, dict) and "value" in v))
    if not bad:
        return 0
    print(machine().emit("fatal", M(
        "facts.measure_bad_shape", count=len(bad),
        keys=", ".join(bad[:6]), hint=M("facts.measure_shape_hint"))),
        file=sys.stderr)
    return 2


def _guarded_write(argv, old, facts):
    """两道守卫（掉条 / 改口）+ 盲写守卫。返回 rc（0 = 放行，2 = 拒绝）。"""
    verdict, problems, notes = guard.decide(old, facts,
                                            accepted=guard.accepted_keys(argv),
                                            allow_drop="--allow-drop" in argv)
    for x in notes["err"]:
        print(x, file=sys.stderr)
    for x in notes["out"]:
        print(x)
    if verdict == "refuse":
        for x in problems:
            print(machine().emit("fatal", x), file=sys.stderr)
        return 2
    # 盲写守卫（issue #20 ②）：写盘前查目标 —— 被 gitignore 覆盖 ⇒ FATAL；
    # 仓里有 Einfacht.env 而本次没设旋钮 ⇒ warn（两个产地此刻分叉）。
    fatal_w, warn_w = guard.write_target_problems(
        _out(), knob_set=bool(os.environ.get("REFLECT_FACTS", "").strip()))
    if warn_w:
        print("⚠ %s" % warn_w, file=sys.stderr)
    if fatal_w:
        print(machine().emit("fatal", fatal_w), file=sys.stderr)
        return 2
    return 0


def get_value(ledger, key):
    """按键取台账值 —— 跨语言消费方的**官方只读出口**（issue #4 ④）。

    消费方（CI、其它语言的测试进程）一律走 `facts.py --get KEY`，
    **不要自己解析 FACTS.json**：手写 parser 的经典坑是 substring 找
    `"value"` 再取引号内 —— 同一文件里到处都是 `"value": …`，会取到
    **别的键**上的值。这里把值取完整。
    键不存在 ⇒ (False, 错误句)；存在 ⇒ (True, 值)。
    """
    f = facts_of(ledger)
    if key not in f:
        return False, M("facts.unknown_key", key=key,
                        existing=", ".join(sorted(f)) or M("facts.none"))
    return True, value_of(f[key])


def _read_or_exit(out):
    """读台账；**坏文件转成 FATAL rc=2**，不冒裸 traceback。

    ⚠️ 这是「配置坏 ≠ 判据红」契约的落点：`ledger.Unreadable` 若冒到顶层，
    Python 会打印 traceback 并以 **1** 退出 —— 而 `registry --run` 把 rc=1
    记成「判据红」。实测：一个坏 JSON 会让 `facts.py --check` 打 traceback
    且 rc=0，调用方以为查过了。
    """
    from ledger import Unreadable  # noqa: PLC0415
    try:
        return load(out)
    except Unreadable as e:
        cause = e.args[1] if len(e.args) > 1 else e
        print(machine().emit("fatal", M(
            "facts.ledger_unreadable",
            path=os.path.relpath(out, gate.GATE_REPO), error=cause)),
              file=sys.stderr)
        raise SystemExit(2) from e


def _load_or_empty():
    """读台账；**不存在就给空台账**（`--accept*` 用）。

    为什么和 `_load_or_die` 分开：「手动注册第一条事实」与「渲染/校验」是两件事 ——
    前者**本来就该能在新仓里创建台账**，后者没有台账就没什么可校验。
    合用一个读法会让 `--accept` 在新仓里 FATAL（实测）。
    """
    out = _out()
    if not os.path.exists(out):
        return {"schema": 1, "facts": {}}
    return _read_or_exit(out)


def _load_or_die():
    """读台账；**没有就给出可操作的提示**而不是原始 traceback。
    为什么单列：新仓库第一次用时台账还不存在，而这个脚本今天会直接抛
    FileNotFoundError —— 那是"为本仓写死"的味道（我们那边永远有 FACTS.json）。
    语义仍是 fail-loud（空台账照样拒绝渲染），只是**把下一步写在错误里**。"""
    out = _out()
    if not os.path.exists(out):
        # issue #20 ② 补充 2：旧提示「先在仓库根跑一遍量测」正是写出野文件
        # 的那个动作 —— 提示文本本身也是「默认值产地」的一部分，不许教人
        # 踩坑。改说「先确认 REFLECT_FACTS 指向哪里」。
        print(machine().emit("fatal",
                              M("facts.no_ledger_yet",
                                name=os.path.basename(out),
                                path=os.path.relpath(out, gate.GATE_REPO))),
              file=sys.stderr)
        raise SystemExit(2)
    return _read_or_exit(out)


def main(argv):
    """命令分派。**只做分派** —— 每个命令一个 `cmd_*` handler。

    ⚠️ 这层拆分不只是复杂度问题：此前 8 个命令挤在同一个函数体里，
    `--accept-principles` 里的 `import doc as _doc` 让 `_doc` 在**整个 `main`**
    内变成局部变量 ⇒ `--render-doc`（不带文件名，AGENTS.md 的首要命令之一）
    在走到那一行之前就抛 `UnboundLocalError`（见 `retractions.json` R-004）。
    命令之间不再共享作用域 ⇒ 这类跨命令的名字污染在结构上消失。
    """
    kind = _classify(argv)
    if kind == "measure":
        return measure(argv)
    if kind == "help":
        print(_usage(), file=sys.stderr)
        return 0
    if kind == "unknown":
        print(_usage(), file=sys.stderr)
        print(machine().emit("fatal", M("facts.unknown_command",
                                       command=argv[0])), file=sys.stderr)
        return 2
    return _command_table()[argv[0]](argv)


def _classify(argv):
    """首参 → `"measure"` / `"help"` / `"command"` / `"unknown"`。**纯函数**。

    自证要验「未知命令不会回落 measure」时，此前直接调 `main(["--bogus"])` ——
    而 `main(["--accept-changes=k1"])` 会**真的跑 measure 并写盘**，于是
    `facts.py --selftest` 会污染调用方的 `FACTS.json`（实测：md5 变了，
    README 却写着 "selftests … never touch the real repo"）。

    把分派决策抽成纯函数之后，自证测的是**决策**，不是**执行** ——
    「表里有 / 是修饰符」的判断仍然只有一处产地（`_classify`），
    但不再需要真的跑命令才能验证它。
    """
    if not argv:
        return "measure"
    first = argv[0]
    if first in ("--help", "-h", "help"):
        return "help"
    if first in _command_table():
        return "command"
    # ⚠️ `--allow-drop` / `--accept-changes[=keys]` 是 **measure() 的修饰符**，
    # 不是命令 —— 它们是「以无子命令起的 measure，但放行某类写盘」。
    # 曾把它们误判成未知命令，于是**唯一能推进台账的出口失效**
    # （实测：`--accept-changes` 打 usage 并退 2，而打出来的 usage 里还写着它）。
    if first.startswith(("--allow-drop", "--accept-changes")):
        return "measure"
    # ⚠️ **未知命令不许回落 `measure()`**：那会「量一遍并写台账」——
    # `--help` / `--bogus` 变成一次真实写盘（实测：`facts.py --help`
    # 在未完仓里 rc=0 且改写了 FACTS.json）。没人会去想「查帮助会写文件」。
    return "unknown"



# 命令名 → handler。**表在函数外**：分派逻辑本身只有一行，加命令 = 加一个函数
# + 一行登记。特意用 dict 而不是 if 链 —— 后者每加一个命令就多一个分支，
# 复杂度随命令数线性上升（实测 27）。
# 命令名 → handler。**表在文件末尾填**（handler 定义在其中），所以这里是空的；
# `_command_table()` 只是让「读表」这件事有个名字，且把「为什么是表不是 if 链」
# 的说明放在读它的地方。
_COMMANDS: dict = {}


def _usage():
    """用法行（`--help` / 未知命令）。**走语言包** —— 与本体其它文本同一条制度。

    ⚠️ 这里曾被我写成固定英文，理由是「这是唯一发现 CLI 的出口，不该依赖包」。
    那是错的：它绕过了「本体零语言」这条硬不变式，而 `check_i18n` 只抓 CJK、
    抓不到英文 —— 等于钻了本仓自己声明的盲区。发现命令的正面是**README**
    （三语），不是 `--help`。没装包的仓看到 `facts.usage` 是诚实的。
    """
    return M("facts.usage")


def _command_table():
    """命令名 → handler。

    为什么要一张表而不是 if 链：if 链的复杂度随命令数线性上升（实测到 27），
    而每个命令的实现体又各自内嵌几十行，于是「有哪些命令」沉在 130 行里。
    表把它变成一处可读的数据，handler 各自独立、可单独测。
    """
    return _COMMANDS


def cmd_render(argv):
    """`--render` 命令。"""
    sys.stdout.write(render_block(_load_or_die()) + "\n")
    return 0


def cmd_render_doc(argv):
    """`--render-doc` 命令。"""
    return write_doc(argv[1] if len(argv) > 1 else _doc(), _load_or_die())


def cmd_check(argv):
    """`--check` 命令。"""
    # 不给文档名 ⇒ 查**全部**有机器块的文档（`_block_homes` 是唯一产地）。
    # 「唯二必须丈量的东西」= STATE（数值）+ PRINCIPLE（判定）—— 两份文档
    # 都在这个面上，少查一份就是让那份的「不要手改」变成空话。
    if len(argv) > 1:
        return check_doc(argv[1], _load_or_die())
    ledger = _load_or_die()
    rc = 0
    for name in _doc_names():
        r = check_doc(name, ledger)
        rc = rc or r
    return rc


def cmd_get(argv):
    """`--get` 命令。"""
    if len(argv) < 2:
        print(machine().emit("fatal", M("facts.get_needs_key")), file=sys.stderr)
        return 2
    ok, v = get_value(_load_or_die(), argv[1])
    if not ok:
        print(machine().emit("fatal", v), file=sys.stderr)
        return 2
    print(v)                       # 只打印值本身：不解释、不带前缀
    return 0


def _init_skeleton(root, state):
    """要生成的骨架文档：`{文件名: 正文}`。**纯数据**，不碰盘。"""
    import doc  # noqa: PLC0415
    import registry as _reg  # noqa: PLC0415
    return {
        state: (
            "# " + state + "\n\n"
            "> live state: only what is true **now**. Cite numbers by\n"
            "> key (double-bracket form), never hand-copy them.\n\n"
            "## Now\n\n"
            "<!-- write what is true NOW; cite numbers by key -->\n\n"
            + BLOCK_BEGIN + "\n" + BLOCK_END + "\n\n"
            + _reg.GATES_BEGIN + "\n" + _reg.GATES_END + "\n"),
        doc.PRINCIPLES: (
            "# PRINCIPLES\n\n"
            "> design rules that do not change. Each one is a **runnable\n"
            "> command**, replayed by `check_facts_replay` on every commit.\n\n"
            + doc.RULES_BEGIN + "\n" + doc.RULES_END + "\n"),
        "retractions.json": '{"schema": 1, "retractions": []}\n',
        "README.md": (
            "# " + os.path.basename(root) + "\n\n"
            "> the project's human-facing docs. `check_readme_sync` treats the\n"
            "> README trio as three copies of one assertion — if you add\n"
            "> `README.zh.md` / `README.de.md`, keep all three in step.\n"),
        "AGENTS.md": (
            "# AGENTS.md\n\n"
            "Routing only. Rules live in `zreflect/doc.py` (`RULES`);\n"
            "state lives in `" + state + "`; history is not tracked.\n\n"
            "```bash\n"
            "python3 zreflect/registry.py --run commit\n"
            "python3 zreflect/harness.py\n"
            "```\n"),
    }


def _create_missing(root, files):
    """建缺的文件，**不覆盖已有**。返回 `(created, kept)`。"""
    created, kept = [], []
    for name, body in files.items():
        p = os.path.join(root, name)
        if os.path.exists(p):
            kept.append(name)
            continue
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(body)
        created.append(name)
    return created, kept


def _init_principles_into_ledger():
    """原则也要进台账 —— 否则 `PRINCIPLES.md` 的 `[[RULES:…]]` 引用在
    新仓里全是坏引用（实测：`facts.missing_key_cite(line=3)`）。"""
    import doc  # noqa: PLC0415
    if not doc.accepts_principles():
        return
    import json as _json  # noqa: PLC0415
    out = _out()
    facts = dict(facts_of(_load_or_empty()))
    facts.update(doc.facts_of_rules())
    with open(out, "w", encoding="utf-8") as fh:
        _json.dump({"schema": 1, "_why": M("facts.ledger_why"),
                    "facts": facts}, fh, indent=1, ensure_ascii=False)
        fh.write("\n")


def _init_questions_dir(root):
    """`questions/` 目录 + 一条示例悬案。

    空目录会被 `check_questions` 的零值守卫拒（`questions.guard_empty`）——
    所以放一个**示例悬案**：它同时是「怎么写悬案」的样板。
    """
    # 转调唯一产地（会 strip；同判据此前三份，一份不 strip —— 实测空串
    # 会让 check_questions 把仓根当悬案目录）。
    qdir = knobs.questions_path(root)
    if not os.path.isdir(qdir):
        os.makedirs(qdir, exist_ok=True)
        print(str(M("facts.init_created", name="questions/")))
    if [n for n in os.listdir(qdir) if n.endswith(".md")]:
        return
    with open(os.path.join(qdir, "01-example.md"), "w", encoding="utf-8") as fh:
        fh.write(
            "# Example open question\n\n"
            "**Status:** ready-for-agent\n\n"
            "**Settling:** `python3 -c \"raise SystemExit(1)\"` "
            "— rc=0 settles A; rc=1 settles B\n\n"
            "Replace this with a real open question, or delete it\n"
            "once you have some.\n")


def _init_env_file(root, state):
    """**按实际生成的文档**写一份 `Einfacht.env`：默认旋钮假设你已经
    有六份文档（STATE/AGENTS/PRINCIPLES/README×3），而新仓只有刚生成的那几份。
    不写这一份 ⇒ 每个闸门都报「找不到 README.zh.md」。

    ⚠️ **已有 `reflect-hooks/Einfacht.env` 时不再造第二份。**
    插件（`einfacht-env.sh`）先找钩子目录、再找仓根 —— 两份同时存在时
    **钩子读 A、README 让你 source B**，`check_facts` 扫的文档集合就分叉了。
    实测：一个仓里 `reflect-hooks/` 有 `REFLECT_MEASURE_MODULE=…` 与
    `REFLECT_DOCS=STATE.md,README.md,maintaince.md`，而 `--init` 在仓根又写了
    `REFLECT_DOCS=STATE.md,PRINCIPLES.md,AGENTS.md` —— 两套判据同时在跑，
    而 `--init` 一个字都没提。
    """
    import doc  # noqa: PLC0415
    env_path = os.path.join(root, "Einfacht.env")
    if os.path.exists(env_path):
        return
    hooks_env = os.path.join(root, "reflect-hooks", "Einfacht.env")
    if os.path.exists(hooks_env):
        # 已经有载体了（钩子优先读那一份）——再造一份只会分叉。
        print(str(M("facts.init_env_exists_in_hooks")))
        return
    docs = ",".join(n for n in (state, doc.PRINCIPLES, "AGENTS.md")
                    if os.path.exists(os.path.join(root, n)))
    with open(env_path, "w", encoding="utf-8") as fh:
        fh.write("export REFLECT_DOC=%s\n" % state)
        fh.write("export REFLECT_DOCS=%s\n" % docs)
        fh.write("export REFLECT_READMES=README.md\n")
    print(str(M("facts.init_created", name="Einfacht.env")))


def cmd_count(argv):
    """`--count-files SUF` / `--count-lines SUF` / `--count-md`：台账的复跑命令。

    独立成子命令而不是内联在 `measure()` 里：台账的 `cmd` 必须能**逐字复跑**
    （`check_facts_replay`），而 `measure()` 会写盘 —— 复跑者不该触发一次写。

    全部是**纯 Python**：`find | wc` 在 Windows 上不存在，而 `cmd` 是给
    使用方抄的样板 —— 样板本身必须跨平台。
    """
    rest = argv[1:]
    if rest == ["-md"]:
        print(count_md_lines(gate.GATE_REPO))
        return 0
    if len(rest) == 2 and rest[0] in ("-files", "-lines"):
        fn = count_files if rest[0] == "-files" else count_lines
        print(fn(gate.GATE_REPO, rest[1]))
        return 0
    print(M("facts.count_usage"), file=sys.stderr)
    return 2


def cmd_init(argv):
    """`--init` 命令。

    **新仓 bootstrap**：一次生成合格骨架，而不是让人照文档猜标记名。

    ⚠️ 这条是验收驱动的（子代理在全新仓里照 `AGENTS.md` 逐字做，卡在
    `FATAL: facts.doc_missing_render` —— 文档说「建 STATE.md」，
    但没说它必须含 `<!-- AUTO:FACTS -->` / `<!-- AUTO:GATES -->`，
    而那两个字符串只住在 `render.py` 源码里）。

    它**不覆盖**已存在的文件（只补缺的），并且明确打印每一步做了什么。

    四件产物各是一个具名 helper（骨架 / 原则进台账 / 悬案目录 / env 文件）：
    拼在一个函数里时是 103 行、四段互不相关的副作用。
    """
    import doc  # noqa: PLC0415
    root = gate.GATE_REPO
    state = doc.state_name()
    created, kept = _create_missing(root, _init_skeleton(root, state))
    for name in created:
        print(str(M("facts.init_created", name=name)))
    for name in kept:
        print(str(M("facts.init_kept", name=name)))
    if not created:
        return 0
    _init_principles_into_ledger()
    _init_questions_dir(root)
    _init_env_file(root, state)
    print(str(M("facts.init_next")))
    return 0


def cmd_accept_principles(argv):
    """`--accept-principles` 命令。"""
    # 「原则进台账」的显式出口。**此前只写在 docstring 里，没有实现**
    # （review 抓到的幻影）—— 而它是用户需求的一部分：「其他的当然也可以
    # 被手动注册成为被检测的东西」。
    #
    # 它写的是**原则的判定命令**（`principle.*`），不碰数值事实；写盘仍过
    # 同一道守卫（掉条 / 改口都要显式接受）。
    #
    # ⚠️ 别名必须叫 `doc_mod`，**不能叫 `_doc`**：`main` 开头那句
    # `else _doc()` 调的是**模块级函数** `_doc()`，而任何一处
    # `import X as _doc` 都会让 `_doc` 在整个函数体内变成**局部变量** ⇒
    # `python3 zreflect/facts.py --render-doc`（不带文件名，AGENTS.md 的
    # 首要命令之一）在走到这里之前就抛 `UnboundLocalError`。实测：
    # `ruff --select=F823` 早就报过，只是没有闸门跑它。
    import doc as doc_mod  # noqa: PLC0415
    led = _load_or_empty()
    new = facts_of(led)
    new.update(doc_mod.facts_of_rules())
    return _write_ledger(led, new, argv, accept_all=True)


def cmd_accept(argv):
    """`--accept` 命令。"""
    # 手动注册一条事实：`--accept <key> <value> <cmd> <source>`
    # （用户自己的量测，不必改 measure()）。值必须是**裸值**。
    if len(argv) < 5:
        print(machine().emit("fatal", M("facts.accept_usage")), file=sys.stderr)
        return 2
    key, value = _arg(argv, 1), _arg(argv, 2)
    cmd, source = _arg(argv, 3), _arg(argv, 4)
    if not key or not cmd.strip():
        print(machine().emit("fatal", M("facts.accept_usage")), file=sys.stderr)
        return 2
    led = _load_or_empty()
    new = dict(facts_of(led))
    new[key] = fact(value, cmd, source)
    return _write_ledger(led, new, argv, accept_all=True)


def cmd_show(argv):
    """`show` 命令。"""
    led = _load_or_die()
    f = facts_of(led)
    keys = [argv[1]] if len(argv) > 1 else sorted(f)
    rc = 0
    for k in keys:
        if k not in f:
            print(M("facts.show_unknown_key", key=k,
                    existing=", ".join(sorted(f))), file=sys.stderr)
            rc = 1
            continue
        e = f[k] if isinstance(f[k], dict) else {"value": f[k]}
        print("%-20s %s" % (k, e.get("value")))
        print(M("facts.show.source", value=e.get("source", "?")))
        print(M("facts.show.cmd", value=e.get("cmd", "?")))
        if e.get("note"):
            print(M("facts.show.note", value=e["note"]))
    return rc


def _arg(argv, i):
    return argv[i] if len(argv) > i else ""


def _write_ledger(led, facts, argv, accept_all=False):
    """把 `facts` 写回台账（过同一道守卫）。`accept_all` ⇒ 本次改口全部接受。"""
    out = _out()
    old = facts_of(led)
    accepted = None if accept_all else guard.accepted_keys(argv)
    verdict, problems, notes = guard.decide(old, facts, accepted=accepted,
                                            allow_drop="--allow-drop" in argv)
    for x in notes["err"]:
        print(x, file=sys.stderr)
    if verdict == "refuse":
        for x in problems:
            print(machine().emit("fatal", x), file=sys.stderr)
        return 2
    # ⚠️ **同一个盲写守卫**：`measure()` 写盘前查目标（被 gitignore 覆盖 ⇒
    # FATAL；有载体却没设旋钮 ⇒ warn）。`--accept*` 是**第二条写盘路径** ——
    # 漏了它就能写进 gitignored 路径而 rc=0（实测：`.gitignore` 里有 L.json
    # 时 `--accept` 照写，`measure` 照 FATAL）。两条路径必须同一道守卫（C4）。
    fatal_w, warn_w = guard.write_target_problems(
        out, knob_set=bool(os.environ.get("REFLECT_FACTS", "").strip()))
    if warn_w:
        print("⚠ %s" % warn_w, file=sys.stderr)
    if fatal_w:
        print(machine().emit("fatal", fatal_w), file=sys.stderr)
        return 2
    import json  # noqa: PLC0415
    import time  # noqa: PLC0415
    doc = {"schema": 1,
           "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
           "_why": M("facts.ledger_why"),
           "facts": facts}
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    print(M("facts.measure_written",
            path=os.path.relpath(out, gate.GATE_REPO), count=len(facts)))
    return 0


def _tmp_doc(content, name="doc.md"):
    """自证用的临时文档（tempfile + atexit 清理 —— 此前写固定的 /tmp
    路径，非 pid 唯一，并行跑两份自证会互相踩）。"""
    import atexit  # noqa: PLC0415
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    atexit.register(shutil.rmtree, d, True)
    p = os.path.join(d, name)
    open(p, "w", encoding="utf-8").write(content)
    return p


CASES = [
    # ③ 空输入必须报（守卫的决策接线在 zreflect/guard.py 的自证里；
    #    掉条 / 改口的纯函数在 ledger.py 的自证里 —— 各归各）
    ("★ facts.check_doc_no_markers",
     lambda: check_doc(_tmp_doc("empty document\n"), {"facts": {"a": 1}}) == 2),
    ("★ facts.check_doc_file_missing",
     lambda: check_doc(os.path.join(_tmp_doc("", "x.md"), "..",
                                    "no_such_%d.md" % os.getpid()),
                       {"facts": {"a": 1}}) == 2),
    # ② 测龄人话（issue #3 ②）
    ("facts.age_unrecorded",
     lambda: _age_human({"value": 1}).code == "facts.age.unrecorded"),
    ("facts.age_today",
     lambda: _age_human({"measured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}).code
     == "facts.age.today"),
    # ④ 官方只读出口（issue #4 ④）
    ("facts.get_dict_shape",
     lambda: get_value({"facts": {"n": {"value": 12, "cmd": "c"}}}, "n") == (True, 12)),
    ("facts.get_bare_shape",
     lambda: get_value({"facts": {"n": 7}}, "n") == (True, 7)),
    ("★ facts.get_unknown_key",
     lambda: get_value({"facts": {"n": 1}}, "zzz")[0] is False),
    # **未知命令不许回落 measure**（实测：`facts.py --help` 曾「量一遍并写台账」）。
    # `measure` 是一条**真实写盘**的路径 —— 把它当兜底，等于任何拼错的命令都改台账。
    ("★ facts.unknown_command_is_2", lambda: _unknown_cmd_rc() == 2),
    # 空输入档：`--help` 是引导面，必须 rc=0 且**不落 measure**（不写台账）。
    ("★ facts.help_is_not_a_measure",
     lambda: _help_rc() == 0 and not _is_unknown_cmd("--help")),
    # 反向：`--allow-drop` / `--accept-changes` 是 **measure 的修饰符**，不是命令。
    # 上面那条守卫曾把它们判成未知命令 ⇒ 唯一能推进台账的出口失效（实测）。
    ("★ facts.measure_modifiers_route_to_measure",
     lambda: not _is_unknown_cmd("--accept-changes=k1")),
    # **bootstrap 端到端收敛**：`--init` → measure → 两次 render → registry 全绿。
    ("★ facts.fresh_repo_bootstraps_green", lambda: _fresh_bootstraps()),
    # **真项目形状**：带 build.sh / src / 既有 README 的仓也要能走完。
    # 曾经「仓里任何 .sh ⇒ 整条链路 FATAL」，这是它的回归守卫。
    ("★ facts.real_repo_shaped_bootstraps", lambda: _real_repo_shaped()),
    # **opt-out 对 --check / --render-doc 也生效**（#27②）：`REFLECT_NO_PRINCIPLES=1`
    # 的仓不许被 FATAL `doc_missing_check` 拦住 —— 同一个 opt-out 在
    # doc.accepts_principles（认）与 _doc_names/_block_homes（曾不认）两处
    # 行为不同，正是「一份规则两个产地」的形状（下游实测 pre-push 必红）。
    ("★ facts.no_principles_opt_out_respected", lambda: _opt_out_check_case()),
    # **坏台账是配置事故，不是判据红**：必须 FATAL rc=2。实测：`{ broken` 的
    # FACTS.json 让 `--check` 打 traceback 且 rc=0（调用方以为查过了），
    # 让各闸门 rc=1（在 `registry --run` 里被记成「判据红」——
    # 用户会去修闸门而不是修数据）。
    ("★ facts.corrupt_ledger_is_fatal_not_traceback",
     lambda: _corrupt_ledger_rc() == 2),
    ("★ ledger.corrupt_load_raises_typed",
     lambda: _corrupt_load_raises()),
    # **环境事故一律 FATAL rc=2**：文档非法编码 / 不可写 / 台账坏 ——
    # 三者的共同点是「不是内容问题」。此前它们都是裸 traceback + rc=1，
    # 而 rc=1 在 `registry --run` 里被记成「判据红」（修法完全不同）。
    ("★ facts.unwritable_doc_is_fatal",
     lambda: _unwritable_doc_rc() == 2),
]


# 命令表在**文件末尾**构建：handler 定义在上面，字面量必须等它们存在之后
# 才求值（在顶部求值即 NameError —— 实测）。
_COMMANDS.update({
    "--render": cmd_render,
    "--render-doc": cmd_render_doc,
    "--check": cmd_check,
    "--get": cmd_get,
    "--init": cmd_init,
    "--accept-principles": cmd_accept_principles,
    "--accept": cmd_accept,
    "show": cmd_show,
    "--count": cmd_count,
})


def _unknown_cmd_rc():
    """未知命令的 rc（`--definitely-not-a-command`）。"""
    import contextlib  # noqa: PLC0415
    import io  # noqa: PLC0415
    with contextlib.redirect_stdout(io.StringIO()), \
            contextlib.redirect_stderr(io.StringIO()):
        return main(["--definitely-not-a-command"])


def _help_rc():
    import contextlib  # noqa: PLC0415
    import io  # noqa: PLC0415
    with contextlib.redirect_stdout(io.StringIO()), \
            contextlib.redirect_stderr(io.StringIO()):
        return main(["--help"])


def _is_unknown_cmd(first):
    """这个首参会不会落到「未知命令」那一支。**走纯函数 `_classify`**。

    ⚠️ 此前这里调 `main([first])` —— 对 `--accept-changes=k1` 那会**真的跑
    measure 并写盘**，于是 `facts.py --selftest` 污染调用方的 `FACTS.json`
    （实测：md5 变了，随后 `--check` 变红，而 README 写着
    "selftests … never touch the real repo"）。自证必须**零副作用**。

    仍然不是「复制一遍判断」：`_classify` 就是 `main` 分派用的那个函数 ——
    断言测的是**同一份逻辑**，只是不执行它的后果。
    """
    return _classify([first]) == "unknown"


def _copy_suite_into(d):
    """把**平台名册内**的套件文件拷进夹具仓 `d`（#30 方向 B 的实现）。

    ⚠️ 此前五处夹具各自 `copytree(zreflect/)` **整目录** —— 在 vendored
    形态（`gate.tool_repo()` 解析到宿主根，#30）下，宿主自己的接线文件
    （自有闸门 / measure 模块 / 额外语言包）被一起拷进新仓，而它们的输入
    （specs/ 等）不在 ⇒ measure 掉条 ⇒ `guard.refuse_dropped` FATAL，
    bootstrap 结构性必红。

    名录是**发现式**的：平台模块 = `registry.modules()`，闸门 = `registry.gates()`
    （声明行派生），但**锚点是套件自己的物理位置**（`__file__`），不是当前进程的
    `zdir()` —— vendored 形态下 `zdir()` 解析到宿主接线目录，那里的名录混着
    宿主自有闸门（它们也有 `GATE` 声明，发现式会收），拷进新仓就把宿主的
    判据面带了进去（实测 4 道闸门红）。`facts.py` 是套件平台文件，它所在的
    目录永远是套件 —— 与宿主怎么接线无关。
    语言包按 `installed_langs()` 逐包拷（判据 = 有 .json 包文件）。
    使用方接线的文件本来就不该进新仓的 bootstrap。
    """
    import shutil  # noqa: PLC0415
    src_z = os.path.dirname(os.path.abspath(__file__))     # 套件自己，不锚 zdir()
    dst_z = os.path.join(d, "zreflect")
    os.makedirs(dst_z)
    # 名录也锚套件目录（传入显式 zdir —— 发现式机制不变，锚点换成套件物理位置）
    _gs, _missing = registry.gates(src_z)
    mods, _missing2 = registry.modules(src_z)
    roster = sorted({os.path.basename(g["file"]) for g in _gs}
                    | {os.path.basename(m["file"]) for m in mods})
    for rel in roster:
        src = os.path.join(src_z, rel)
        if os.path.isfile(src):
            shutil.copy(src, os.path.join(dst_z, rel))
    # 语言包：逐包拷（installed_langs 的判据是「有 .json 包文件」）
    lang_src = os.path.join(src_z, "lang")
    if os.path.isdir(lang_src):
        for n in sorted(os.listdir(lang_src)):
            pkg = os.path.join(lang_src, n)
            if os.path.isdir(pkg) and any(x.endswith(".json")
                                          for x in os.listdir(pkg)):
                shutil.copytree(pkg, os.path.join(dst_z, "lang", n))
    hooks_src = os.path.join(os.path.dirname(src_z), "reflect-hooks")
    if os.path.isdir(hooks_src):
        shutil.copytree(hooks_src, os.path.join(d, "reflect-hooks"),
                        ignore=shutil.ignore_patterns(
                            "__pycache__", ".mypy_cache", "*.pyc"))
    ruff_conf = os.path.join(gate.tool_repo(), "ruff.toml")
    if os.path.isfile(ruff_conf):
        shutil.copy(ruff_conf, d)


def _corrupt_ledger_rc():
    """坏台账下 `--check` 的 rc（夹具仓，不碰本仓台账）。"""
    import shutil  # noqa: PLC0415
    import subprocess  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    try:
        subprocess.run(["git", "init", "-q", d], check=True, capture_output=True)
        _copy_suite_into(d)
        open(os.path.join(d, "FACTS.json"), "w", encoding="utf-8").write("{ broken")
        env = {k: v for k, v in os.environ.items()
               if not k.startswith("REFLECT_")}
        p = subprocess.run(
            [sys.executable, os.path.join(d, "zreflect", "facts.py"), "--check"],
            cwd=d, env=env, capture_output=True, text=True, timeout=120,
                           encoding="utf-8", errors="replace")
        return p.returncode
    except Exception:                                    # noqa: BLE001
        return None
    finally:
        shutil.rmtree(d, True)


def _unwritable_doc_rc():
    """只读文档上 `--render-doc` 的 rc（需要真写盘 ⇒ 必须 FATAL 2）。"""
    import shutil  # noqa: PLC0415
    import stat  # noqa: PLC0415
    import subprocess  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    try:
        subprocess.run(["git", "init", "-q", d], check=True, capture_output=True)
        subprocess.run(["git", "-C", d, "config", "user.email", "a@b"], check=True)
        subprocess.run(["git", "-C", d, "config", "user.name", "a"], check=True)
        _copy_suite_into(d)
        env = {k: v for k, v in os.environ.items()
               if not k.startswith("REFLECT_")}
        env["GATE_REPO"] = d

        def run(*args):
            return subprocess.run([sys.executable, *args], cwd=d, env=env,
                                  capture_output=True, text=True, timeout=180,
                           encoding="utf-8", errors="replace")

        run("zreflect/facts.py", "--init")
        run("zreflect/facts.py", "--accept-changes")
        run("zreflect/facts.py", "--render-doc")
        # 让文档再次需要写盘：改动台账的一个值
        run("zreflect/facts.py", "--accept", "probe", "9", "echo 9", "s")
        doc = os.path.join(d, "STATE.md")
        os.chmod(doc, stat.S_IRUSR)
        try:
            return run("zreflect/facts.py", "--render-doc").returncode
        finally:
            os.chmod(doc, stat.S_IRUSR | stat.S_IWUSR)
    except Exception:                                    # noqa: BLE001
        return None
    finally:
        shutil.rmtree(d, True)


def _corrupt_load_raises():
    """`ledger.load` 对坏 JSON 抛 `Unreadable`（不是裸 `JSONDecodeError`）。"""
    import tempfile  # noqa: PLC0415

    from ledger import Unreadable  # noqa: PLC0415
    fd, path = tempfile.mkstemp()
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write("{ broken")
        try:
            load(path)
        except Unreadable:
            return True
        except Exception:                                # noqa: BLE001
            return False
        return False
    finally:
        os.unlink(path)


def _env_from_envfile(d, base_env):
    """把 `Einfacht.env` 解析成环境变量（**跨平台，不经 shell**）。

    ⚠️ 此前用 `shell=True` + `set -a; . ./Einfacht.env; set +a;` ——
    那是 **POSIX sh 语法**。Windows 的 shell 是 cmd.exe，它不认；于是 env
    没被加载 ⇒ 闸门回落默认文档名单 ⇒ `doc_has_no_home`
    （实测：CI 的 Windows 腿 `facts` 自证 13 PASS / 1 FAIL）。
    """
    out = dict(base_env)
    path = os.path.join(d, "Einfacht.env")
    if not os.path.isfile(path):
        return out
    with open(path, encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    # **解析只此一份**：`check_envfile.parse_exports`（带引号剥离 + 可选
    # export 前缀）。此前这里自己写了一遍 `startswith("export ")` +
    # `partition("=")`，**不剥引号** —— 同一份 env，这边解析出
    # `'"STATE.md"'`（带引号），那边解析出 `'STATE.md'`。实测：夹具里的
    # 旋钮值静默带上引号 ⇒ 判据测的是另一套环境，还不报错。
    import check_envfile  # noqa: PLC0415
    out.update(check_envfile.parse_exports(text))
    return out


def _bootstrap_steps():
    """`--init` 之后要跑的步骤（`(argv, 是否带 env)`）。"""
    return [
        ([sys.executable, "zreflect/facts.py", "--accept-changes"], True),
        ([sys.executable, "zreflect/facts.py", "--render-doc"], True),
        ([sys.executable, "zreflect/facts.py", "--render-doc",
          "PRINCIPLES.md"], True),
        ([sys.executable, "zreflect/registry.py", "--run", "commit"], True),
    ]


def _real_repo_shaped():
    """**真项目形状**的仓能走完 bootstrap：带 `.sh` + `src/` + 既有 README。

    这一条是「接进真实项目」验收换来的：此前 `shell_surface_problems()` 扫整个
    `GATE_REPO`，于是**任何有 `build.sh` 的仓**都 `--render-doc` FATAL，
    `--check` FATAL，pre-commit 红，且没有旋钮能放行 —— 「全 Python 化」是
    本仓对自己的纪律，不是对所有使用方的要求。

    夹具刻意放这三样（都是真项目最常见的形状）：

      · `build.sh` / `deploy.sh` —— 构建脚本（曾经让整条链路死掉）
      · `src/app.py` —— 它自己的代码
      · `examples/bad.py` —— **它自己的、按套件标准会红的代码**（裸中文 +
        未用 import）。这是第二条纪律：「套件只审套件」不是写在注释里的
        承诺，而是这个夹具每一轮都会验的事 —— 三个闸门任何一次把范围扩回
        整个仓，这条就当场红（实测接口收窄前它报 149 + 59 条）。
      · 一份**没有机器块**的既有 `README.md` —— `--init` 会 `already exists,
        left alone`，于是 `check_readme_sync` 的单条目路径要能跑
    """
    import shutil  # noqa: PLC0415
    import subprocess  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    try:
        subprocess.run(["git", "init", "-q", d], check=True,
                       capture_output=True)
        _copy_suite_into(d)
        for name in ("build.sh", "deploy.sh"):
            with open(os.path.join(d, name), "w", encoding="utf-8") as fh:
                fh.write("#!/bin/sh\necho %s\n" % name)
        os.makedirs(os.path.join(d, "src"))
        with open(os.path.join(d, "src", "app.py"), "w",
                  encoding="utf-8") as fh:
            fh.write("def f():\n    return 1\n")
        # **使用方自己的代码，按套件标准是会红的**：裸中文（check_i18n 的
        # 第一条判据）+ 未用 import（ruff 的 F401）+ 模块级派生（snapshot）。
        # 三个闸门只要有一个把范围扩回整个仓，`registry --run commit` 就红。
        # 「套件只审套件」由此变成每一轮都真跑一次的判据，不是注释。
        os.makedirs(os.path.join(d, "examples"))
        # ⚠️ 夹具源码里的中文必须**码点构造** —— 本文件自己就在 check_i18n
        # 的扫描面里，直接写中文字面量会被它判成「本体说人话」（实测：写完
        # 第一版后 `i18n_cover.bare_text` 当场红在 facts.py:1363）。
        bad_body = ("import os\n\n\ndef f():\n    print(%r)\n"
                    % "".join(chr(c) for c in (0x8FD9, 0x6761, 0x4E2D, 0x6587)))
        with open(os.path.join(d, "examples", "bad.py"), "w",
                  encoding="utf-8") as fh:
            fh.write(bad_body)
        with open(os.path.join(d, "README.md"), "w", encoding="utf-8") as fh:
            fh.write("# my project\n\nNo machine block here.\n")
        base = {k: v for k, v in os.environ.items()
                if not k.startswith("REFLECT_") and k != "GATE_REPO"}
        subprocess.run([sys.executable, "zreflect/facts.py", "--init"],
                       cwd=d, env=base, capture_output=True, text=True,
                       timeout=180,
                           encoding="utf-8", errors="replace")
        for argv in ([sys.executable, "zreflect/facts.py", "--accept-changes"],
                     [sys.executable, "zreflect/facts.py", "--render-doc"],
                     [sys.executable, "zreflect/facts.py", "--render-doc",
                      "PRINCIPLES.md"]):
            p = subprocess.run(argv, cwd=d, env=_env_from_envfile(d, base),
                               capture_output=True, text=True, timeout=180,
                           encoding="utf-8", errors="replace")
            if p.returncode != 0:
                return False
        p = subprocess.run([sys.executable, "zreflect/registry.py",
                            "--run", "commit"],
                           cwd=d, env=_env_from_envfile(d, base),
                           capture_output=True, text=True, timeout=180,
                           encoding="utf-8", errors="replace")
        return p.returncode == 0
    except Exception:                                    # noqa: BLE001
        return False
    finally:
        shutil.rmtree(d, True)


def _opt_out_check_case():
    """`REFLECT_NO_PRINCIPLES=1` 时 `--check` 不许向 `PRINCIPLES.md` 要块。

    ⚠️ 必须用**没有 `PRINCIPLES.md` 的夹具仓**：本仓永远有那份文件，
    「无条件查两份」的旧实现在这里也绿 —— 判据就瞎了（实测：子进程跑的是
    新代码，patch 不跨进程）。夹具 = `_fresh_bootstraps` 同款 copytree +
    `--init`，删掉 init 建的 `PRINCIPLES.md`（真实 opt-out 仓的形状），
    然后断言两件事：

      · 设旗标 ⇒ `--check` rc=0 且不碰 PRINCIPLES（旧行为在此 FATAL）；
      · 不设旗标 ⇒ 查 PRINCIPLES ⇒ 报「文件缺失」（默认面没变，只是文件不在）。
    """
    import shutil  # noqa: PLC0415
    import subprocess  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    try:
        subprocess.run(["git", "init", "-q", d], check=True, capture_output=True)
        _copy_suite_into(d)
        base = {k: v for k, v in os.environ.items()
                if not k.startswith("REFLECT_") and k != "GATE_REPO"}
        subprocess.run([sys.executable, "zreflect/facts.py", "--init"],
                       cwd=d, env=base, capture_output=True, timeout=180)
        # 走完 bootstrap 的量测与渲染（同 `_fresh_bootstraps`）：init 生成的
        # STATE.md 块是空的，不跑这两步 --check 会报 block_stale —— 那是
        # 夹具没走完流程，不是被测行为。
        env_run = _env_from_envfile(d, base)
        for argv in ([sys.executable, "zreflect/facts.py", "--accept-changes"],
                     [sys.executable, "zreflect/facts.py", "--render-doc"]):
            subprocess.run(argv, cwd=d, env=env_run, capture_output=True,
                           timeout=180)
        os.remove(os.path.join(d, "PRINCIPLES.md"))
        env_opt = dict(base)
        env_opt["REFLECT_NO_PRINCIPLES"] = "1"
        p = subprocess.run([sys.executable, "zreflect/facts.py", "--check"],
                           cwd=d, env=env_opt, capture_output=True, text=True,
                           timeout=180, encoding="utf-8", errors="replace")
        return p.returncode == 0 and "PRINCIPLES" not in (p.stdout + p.stderr)
    except Exception:                                    # noqa: BLE001
        return False
    finally:
        shutil.rmtree(d, True)


def _fresh_bootstraps():
    """全新仓：`--init` → measure → 两次 render → `registry --run commit` 全绿。

    **端到端**：spawn 子进程。正因为这样它抓得到那三处「单独看都合理、
    合起来让 bootstrap 走不通」的缺陷 —— env 让 harness 自打红、
    md_lines 把 GATES+RULES 块也数进去、`--accept-changes` 被当成未知命令。

    三段（准备夹具 / 解析 env / 逐步跑）各是一个 helper：拼在一起时
    12 复杂度，而它自己的 `check_lint` 会当场判红（实测）。
    """
    import shutil  # noqa: PLC0415
    import subprocess  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    try:
        subprocess.run(["git", "init", "-q", d], check=True,
                       capture_output=True)
        _copy_suite_into(d)
        # ⚠️ 必须连 `GATE_REPO` 一起清：`harness` 跑自证时把它设成**本仓**，
        # 而这里的夹具是另一个仓 —— 留着它，子进程会回头检查本仓。
        base = {k: v for k, v in os.environ.items()
                if not k.startswith("REFLECT_") and k != "GATE_REPO"}
        subprocess.run([sys.executable, "zreflect/facts.py", "--init"],
                       cwd=d, env=base, capture_output=True, text=True,
                       timeout=180,
                           encoding="utf-8", errors="replace")
        for argv, with_env in _bootstrap_steps():
            env = _env_from_envfile(d, base) if with_env else base
            p = subprocess.run(argv, cwd=d, env=env, capture_output=True,
                               text=True, timeout=180,
                           encoding="utf-8", errors="replace")
            if p.returncode != 0:
                return False
        return True
    except Exception:                                    # noqa: BLE001
        return False
    finally:
        shutil.rmtree(d, True)


MODULE = module_meta("台账 CLI", "量一遍 / 渲染 / --get / 两道守卫", selftest=True)


if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], M("gate.title.facts_cli"),
                              CASES, main))



