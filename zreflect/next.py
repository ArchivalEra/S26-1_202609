#!/usr/bin/env python3
"""「接着上一轮」的**采集器** —— 记忆系统的那一半。

## 它替换掉的是一件人工活

会话压缩之前，人得手工整理「这次干了什么、下一步干什么」。不整理，压缩后
agent 就两手空空：重新提出已经结案的问题，或者从零重新分析一遍。

**「每次都要有人准备压缩」本身就是缺陷** —— 它要求人记得做一件机制该做的事，
而人一旦忘了，代价是整段上下文。

## 接口：一段行，**不落盘**

    section(repo) -> list[str]      # 含自己的标题行；≤ SECTION_MAX 行

**它是宿主无关的**：`section(repo)` 只返回行，不认识任何编辑器的钩子协议、
不认识任何宿主的 JSON 信封、也不需要知道那个宿主把会话开始叫什么。要接进某个宿主的钩子，
使用方自己加一层薄壳（读它的 stdout 拼进宿主需要的样子）—— 套件不替宿主做决定，
也不校验宿主的配置 schema。

## 为什么不在文档里留一块

此前这里渲染一个 `STATE.md` 的 `AUTO:NEXT` 机器块，由 `Stop` 钩子每轮重写。
**那条路一次都没有跑通过**（实测：`facts.py --render-doc` 只认
`AUTO:FACTS` / `AUTO:GATES` / `AUTO:RULES`，这个块从未进过任何文档；`next.render()`
除自证外没有调用方）。更要命的是，它与 `facts.py --check` 的逐字节对账**天然
互斥**：块每轮都变，对账就永远红；豁免它，文档里那块就没人再验。

**每轮都变的东西不该占一个会被判的位置。** 所以它不落盘：每次会话开始时现算。
代价是贵一点点（两次 git 调用 + 一次目录读），换来的是它**永远是新鲜的**，
而且没有任何「文档说它是自动的、其实从没写过」的中间态。

## 采集什么，从哪采

全部从**已经存在的东西**长出来，不新增需要人维护的输入：

    git log HEAD --not --remotes    → 未推送的提交（「这一轮做了什么」）
    git status --porcelain          → 未提交的改动 / 未跟踪文件
    questions/                      → 未结案的悬案（「下一步是什么」）

这也是 `collect.py` 的采集器契约（只读持久盘、不引入会自己变的输入）。

## 预算是接口的一部分

注入进上下文的文本超过一屏就会挤掉真正的工作内容，而 `AUTO:NEXT` 曾经被调用方
用 `[:8]` 截断 —— 于是**排在最后的待办被静默截掉**（实测：那正是压缩后最需要的
那一段）。现在截断在**模块内部**完成（`MAX_LISTED` / `SECTION_MAX`），调用方
不再需要知道长度；`next.section_budget_holds` 钉住「待办一条都不许被挤掉」。

## 诚实边界

  · 它知道「机器看得见的」进度（提交、未提交、悬案），**不知道**「agent 想
    干什么」。后者要人写 —— 但只写一句 `questions/` 里的悬案就够，不需要
    整篇 handoff。
  · 「上一轮」是按**未推送提交**切分的。已经推送的轮次不在里面 ——
    那是历史，而历史不进丈量面（不可复现的东西不占会被判的位置）。
  · 待办列表最多列 `MAX_LISTED` 条；**更多的数量由紧随其后的悬案段报**
    （那段给「未结案 N / 共 M」，这里给「先做这几件」）。
"""
from __future__ import annotations

import os
import subprocess

import knobs  # noqa: E402
from i18n import M  # noqa: E402

# 每一类最多列几条。**预算是接口**：改大它，`SECTION_MAX` 与
# `next.section_budget_holds` 会同时要求重新算账（那正是想要的）。
MAX_LISTED = 3

# 整段最多多少行。逐项账（全是最坏情况）：
#   1 标题 + 1 提交计数 + 3 提交 + 1 省略 + 1 工作区 + 1 空行 + 1 待办标题 + 3 待办
SECTION_MAX = 12


def _git(repo, *args):
    """跑一条 git 命令；失败返回 None（**不编空值** —— 见 collect.py 原则 3）。

    ⚠️ 刻意**不走** `runner.run_cmd`：那是「台账 cmd 逐字复跑」的 seam ——
    字符串命令经三档 shell（bash pipefail 语义 / sh / Windows argv 拆分），
    cwd 恒为 `GATE_REPO`。git 调用是**argv 形状**（`-C <repo>`、列表参数，
    不经 shell，无注入面），cwd 是**参数给的仓**（不是被检查仓），失败
    形状是 None 不是 (rc, out)。三个契约都不同 —— 收口会把安全的 argv
    改成 shell 拼接，或把 cwd 语义改错。两份（这里与
    `check_world.current_branch`）是有意保留的。"""
    try:
        p = subprocess.run(["git", "-C", repo, *args],
                           capture_output=True, text=True, timeout=10,
                           encoding="utf-8", errors="replace")
    except (OSError, subprocess.SubprocessError):
        return None
    if p.returncode != 0:
        return None
    return p.stdout


def unpublished_commits(repo):
    """未推送的提交标题。取不到 ⇒ None（**不是空表**）。

    ⚠️ 命令必须带 `HEAD`：`git log --oneline --not --remotes`（**没有起点**）
    会**静默返回 0 行** —— 看着像「全都推送了」，实际是「没给起点，git 走了
    另一条默认路径」。实测：同一个仓，带 `HEAD` 得 26 行，不带得 0 行。
    这是本仓最恨的那种失败：**不报错、答案是错的**。
    """
    branch = (_git(repo, "rev-parse", "--abbrev-ref", "HEAD") or "").strip()
    if not branch or branch == "HEAD":
        return None
    # 顺序也重要：`HEAD` 在前，`--not --remotes` 在后（`git log` 的起点
    # 必须在 rev 列表里，不能只靠 `--not`）。
    out = _git(repo, "log", "--oneline", "HEAD", "--not", "--remotes")
    if out is None:
        return None
    return [ln.strip() for ln in out.splitlines() if ln.strip()]


def working_tree(repo):
    """未提交的改动：返回 (改动文件数, 未跟踪文件数)。"""
    out = _git(repo, "status", "--porcelain")
    if out is None:
        return None
    changed = untracked = 0
    for ln in out.splitlines():
        if not ln.strip():
            continue
        if ln.startswith("??"):
            untracked += 1
        else:
            changed += 1
    return changed, untracked


def _commit_lines(repo, last):
    """未推送提交那一段：计数 + 前 N 条 + 「还有 N 条」。"""
    commits = unpublished_commits(repo)
    if commits is None:
        last.append(M("next.commits_unreadable"))
        return
    if not commits:
        last.append(M("next.commits_none"))
        return
    last.append(M("next.commits_count", count=len(commits)))
    last.extend("  `%s`" % c for c in commits[:MAX_LISTED])
    if len(commits) > MAX_LISTED:
        last.append("  " + M("next.commits_more",
                             count=len(commits) - MAX_LISTED))


def _tree_lines(repo, last, pending):
    """工作区那一段：多少改动 / 有没有脏。"""
    wt = working_tree(repo)
    if wt is None:
        last.append(M("next.tree_unreadable"))
        return
    changed, untracked = wt
    last.append(M("next.tree_state", changed=changed, untracked=untracked))
    if changed or untracked:
        pending.append(M("next.tree_dirty"))


def _question_lines(repo, pending):
    """**未结案的悬案 = 下一步**。

    此前这里刻意留空（理由是「`inject-state.py` 已有悬案段，两处都列会重复」）
    —— 但那个段只报「有几条未结案」，不报「它们是什么」，而压缩后 agent
    最需要的正是**名字**。现在这里给名字，那段给状态，各司其职。

    预算：提交段与工作区段可能已占掉一部分 `MAX_LISTED`，剩下的给悬案。
    """
    room = MAX_LISTED - len(pending)
    if room <= 0:
        return
    pending.extend(M("next.open_question", name=q)
                   for q in _open_question_names(repo)[:room])


def collect(repo):
    """采集「接着上一轮」的输入。返回 `(last_turn, pending)` 两个**Message 列表**。

    两者都可能是空表 —— 空**不是**通过，`section()` 会明说「没有记录」。
    保留 `Message`（而不是提前 `str()`）是为了让自证能按 **code** 断言，
    不被语言包是否装着影响。

    ⚠️ 这些行是**用户可见文本**（注入进 agent 上下文）⇒ 一律走 `M()`。
    此前这里写的是裸中文 + 一句 PINNED，理由是「它进 STATE.md 被 --check
    逐字节对账」——**那句是假的**（那个块从未进过文档，也从不参与对账）。
    拿一个不成立的理由去豁免，正是本仓在 `machine_vocab_ok` 上抓过的同一个错。

    三段各是一个具名 helper（提交 / 工作区 / 悬案）：它们读三个不同的来源，
    拼在一起时「预算怎么分」变成隐式知识。
    """
    last, pending = [], []
    _commit_lines(repo, last)
    _tree_lines(repo, last, pending)
    _question_lines(repo, pending)
    return last, pending


def _question_status(text):
    """悬案正文里的 `**Status:**` 值（小写）；没有 ⇒ 空串。

    ⚠️ **必须转调 `check_questions.field`**：此前这里自己写了一遍
    `ln.split(":", 1)[1]`，而真实写法是 `**Status:** resolved`（冒号在
    **那对星号中间**）—— 于是切出来的是 `"** resolved"`，永远不等于
    `"resolved"`。后果：**结案的悬案一直被当成待办**报进「接着上一轮」，
    每轮都提示去查一件已经查完的事。实测（本仓 `questions/01-example.md`
    结案后 `next.py` 仍列它）。

    两份判据必有一份错 —— 而 `check_questions` 那份有 196 行自证守着。
    """
    import check_questions  # noqa: PLC0415
    # 归一化（小写 + 首词）的唯一产地在 check_questions.status_of ——
    # 这份曾是第三种判法（R-017），现在只转调。
    return check_questions.status_of(text)


def _open_question_names(repo):
    """`questions/` 里未结案的悬案文件名（按名字排序，最多 `MAX_LISTED` 个）。

    读不到目录 ⇒ 返回空表（不是报错）：那是「这个仓不用悬案」的正常形态，
    `inject-state.py` 会明说「读不到」。
    """
    # 转调唯一产地（`knobs.questions_path` 会 strip）—— 此前这里自己
    # `os.environ.get(...).strip() or "questions"`，是同一判据的第二份。
    d = knobs.questions_path(repo)
    if not os.path.isdir(d):
        return []
    names = [n for n in sorted(os.listdir(d)) if n.endswith(".md")]
    return [n for n in names if _question_status(_read_question(d, n))
            != "resolved"][:MAX_LISTED]


def _read_question(d, name):
    """读一条悬案；读不到 ⇒ 空串（当成「未结案」—— 读不到不该被算成已结案）。"""
    try:
        with open(os.path.join(d, name), encoding="utf-8",
                  errors="replace") as fh:
            return fh.read()
    except OSError:
        return ""


def section(repo):
    """「接着上一轮」整段（含自己的标题行）。行数 ≤ `SECTION_MAX`。

    **读不到 ≠ 抛异常**：git 不在 / 不是仓 / 悬案目录没有，全部变成明说的行
    （`next.commits_unreadable` 这类），绝不编 0、也绝不静默空着。

    **但真正的 bug 照抛**（空 input 列表、模板缺失、编码错）。两者必须可区分：
    把 `except Exception` 套在这里，就等于让「采集器坏了」与「真的没事」同形。
    宿主那一侧因此能靠退出码把两种结局分开：读不到 ⇒ 一段明说的行 + rc 0；
    真坏了 ⇒ 非零退出，宿主自己的日志看得见（套件不替宿主判断）。

    注入进 agent 上下文的用户可见文本 ⇒ 全部走 `M()`（null 包下是裸 code，
    那是诚实的：没装语言包就说 code）。

    `section` 只产**行**：信封、JSON、钩子语义全在调用方 —— 这样它能在
    零 I/O 之外被断言（`_format`），也能被手跑（`python3 zreflect/next.py`）。
    手跑的输出就是契约本身：使用方按自己宿主的形状包一层即可。
    """
    last, pending = collect(repo)
    return _format(last, pending)


def _format(last, pending):
    """`section` 的零 I/O 版本（自证用：不碰 git）。

    排版也在这里 —— 调用方不该知道「哪些行加缩进」。空表必须**明说**
    （`next.pending_none`），不许只是一行空：空不是通过。
    """
    lines = [str(M("next.section_header"))]
    lines.extend("  \u00b7 %s" % str(ln).strip() for ln in (last or []))
    lines.append("")
    lines.append(str(M("next.pending_header")))
    if pending:
        lines.extend("  \u00b7 %s" % str(ln).strip() for ln in pending)
    else:
        lines.append("  \u00b7 " + str(M("next.pending_none")))
    return lines


def main(argv=None):
    """`python3 zreflect/next.py [repo]` → 打印整段（人工核对用，不供钩子拼装）。"""
    import sys  # noqa: PLC0415
    # 语言激活：REFLECT_LANG 指了包就装（M() 渲中文）；没指/装不上 ⇒ null 包
    # （裸 code），与 gate.py 的装配路径同一容错形状。
    try:
        import i18n  # noqa: PLC0415
        i18n.activate(None)
    except Exception:                                # noqa: BLE001
        pass
    repo = (argv or sys.argv[1:] or ["."])[0]
    sys.stdout.write("\n".join(section(os.path.abspath(repo))) + "\n")
    return 0


# ── 自证 ──────────────────────────────────────────────────────────────────────
#
# 本模块**有**自证入口（`selftest=True`）：它的判据是「采集器读不到东西时
# 会不会假装读到了」—— 那是本仓最痛的那类事故，必须能当场证伪。

def _cases():
    """每条都造出**能让它红**的输入（夹具仓，零依赖真仓）。"""
    return [
        # ① 正常不报：一个真 git 仓，干净工作区 ⇒ 采集器说得出来
        ("next.collects_from_real_git", lambda: _real_git_case()),
        # ② 该报的必须报 —— **读不到不许编 0**
        ("★ next.missing_repo_is_loud_not_zero",
         lambda: _missing_repo_loud()),
        # 排版是纯函数：同输入两次逐字节相同
        ("★ next.section_is_deterministic", lambda: _section_deterministic()),
        # 空待办必须**明说**「若你认为应该有 —— 那是记录的缺口」
        ("★ next.empty_pending_is_explicit", lambda: _empty_pending_explicit()),
        # `git log` 的起点不能省：没有 `HEAD` 时它静默返回 0 行
        # （实测：同一个仓 26 vs 0）。这条钉住「命令形状」而不是结果 ——
        # 结果依赖真仓状态，形状不依赖。
        ("★ next.log_command_has_start_point",
         lambda: _log_command_shape_ok()),
        # **预算是接口的一部分**：提交多 + 悬案多 + 工作区脏 ⇒ 待办一条都不许
        # 被挤掉，整段 ≤ SECTION_MAX。此前调用方的 `[:8]` 把待办截掉了
        # （实测：27 个未推送提交时，压缩后最需要的那段整段消失）。
        ("★ next.section_budget_holds", lambda: _section_budget_holds()),
        # `**Status:**` 的星号写法 —— 结案的悬案不许再出现在「下一步」里。
        # 此前 `_question_status` 用 `split(":", 1)` 切出 `"** resolved"`，
        # 于是**每一条结案的悬案都被永远报成待办**（实测本仓 01-example.md）。
        ("★ next.resolved_question_is_dropped",
         lambda: _resolved_question_dropped()),
        # ③ 空输入必须报：一个不存在的仓根
        ("★ next.nonexistent_root_is_loud",
         lambda: _nonexistent_root_loud()),
    ]


def _resolved_question_dropped():
    """**结案的悬案不得出现在「下一步」里**（`**Status:**` 的星号写法）。

    夹具刻意一个结案、一个没结案：`**Status:** resolved` 必须不列，
    `**Status:** ready-for-agent` 必须列。任何一侧错都会红 —— 这就是那个
    「切出 `"** resolved"`」的 bug 的判据。

    ⚠️ **不许用真仓**：真仓的悬案会被结掉，那时这条用例就验不到任何东西
    （绿得毫无意义）。所以造临时目录。
    """
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    try:
        q = os.path.join(d, "questions")
        os.makedirs(q)
        with open(os.path.join(q, "01-done.md"), "w", encoding="utf-8") as fh:
            fh.write("# done\n\n**Status:** resolved\n")
        with open(os.path.join(q, "02-open.md"), "w", encoding="utf-8") as fh:
            fh.write("# open\n\n**Status:** ready-for-agent\n")
        names = _open_question_names(d)
        return names == ["02-open.md"]
    finally:
        import shutil  # noqa: PLC0415
        shutil.rmtree(d, True)


def _real_git_case():
    import shutil
    import subprocess
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    try:
        subprocess.run(["git", "init", "-q", d], check=True)
        subprocess.run(["git", "-C", d, "config", "user.email", "a@b"],
                       check=True, capture_output=True)
        subprocess.run(["git", "-C", d, "config", "user.name", "a"],
                       check=True, capture_output=True)
        open(os.path.join(d, "x"), "w", encoding="utf-8").write("x")
        subprocess.run(["git", "-C", d, "add", "x"], check=True)
        subprocess.run(["git", "-C", d, "commit", "-qm", "c"], check=True,
                       capture_output=True)
        last, pending = collect(d)
        # 夹具里的中文用码点（本仓纪律；字面量会让 check_i18n 红）
        # ⚠️ 按 **code** 判，不按渲染文本 —— null 包下渲染成 `next.tree_state(...)`，
        # 断言「文本里有某个词」等于断言「语言包装了」，那是另一件事。
        return any("next.tree_" in getattr(ln, "code", str(ln)) for ln in last)
    except Exception:                                    # noqa: BLE001
        return False
    finally:
        shutil.rmtree(d, True)


def _missing_repo_loud():
    """不存在的仓 ⇒ `unpublished_commits` 返回 None，而不是 `[]`。"""
    return unpublished_commits("/nonexistent-xyz") is None


def _section_deterministic():
    import shutil
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    try:
        return section(d) == section(d)
    finally:
        shutil.rmtree(d, True)


def _empty_pending_explicit():
    """没有待办 ⇒ 必须**明说**（`next.pending_none`），不许只是一行空。

    按 code 判（null 包下渲染成 `next.pending_none`，不是句子）。
    """
    import i18n  # noqa: PLC0415
    with i18n.bind(i18n.NULL):
        block = "\n".join(_format(["only last"], []))
    return "next.pending_none" in block


def _nonexistent_root_loud():
    """没有上一轮记录 ⇒ 必须**明说**（`next.commits_unreadable`），不许静默空着。

    ⚠️ 断言走**真采集器**（`collect`），不是自己先构造好消息再断言它在场 ——
    后者是恒真断言（它只证明 `_format` 会抄一遍输入）。这里要证的是：
    读不到的时候 `collect` 产出的**是** unreadable 那一条，不是空表。
    """
    last, pending = collect("/nonexistent-xyz")
    codes = {getattr(ln, "code", "") for ln in last}
    return "next.commits_unreadable" in codes and "next.tree_unreadable" in codes


def _log_command_shape_ok():
    """`unpublished_commits` 用的 git 命令**必须带起点**。

    从源码里读那条命令的参数（不执行 git）—— 判据是形状的，所以夹具无关、
    真仓状态无关。
    """
    import inspect  # noqa: PLC0415
    src = inspect.getsource(unpublished_commits)
    # 找 `_git(repo, "log", ...)` 那一行
    for line in src.splitlines():
        if '"log"' in line:
            # 起点必须在 --not 之前出现
            if '"HEAD"' not in line:
                return False
            return line.index('"HEAD"') < line.index("--not")
    return False


def _section_budget_holds():
    """提交多 + 悬案多 + 工作区脏 ⇒ 待办在场且整段 ≤ `SECTION_MAX`。"""
    import shutil
    import subprocess
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    try:
        subprocess.run(["git", "init", "-q", d], check=True,
                       capture_output=True)
        subprocess.run(["git", "-C", d, "config", "user.email", "a@b"],
                       check=True, capture_output=True)
        subprocess.run(["git", "-C", d, "config", "user.name", "a"],
                       check=True, capture_output=True)
        for i in range(MAX_LISTED + 3):
            open(os.path.join(d, "x"), "w", encoding="utf-8").write(str(i))
            subprocess.run(["git", "-C", d, "add", "x"], check=True,
                           capture_output=True)
            subprocess.run(["git", "-C", d, "commit", "-qm", "c%d" % i],
                           check=True, capture_output=True)
        q = os.path.join(d, "questions")
        os.makedirs(q, exist_ok=True)
        for i in range(MAX_LISTED + 2):
            open(os.path.join(q, "%02d-q.md" % i), "w", encoding="utf-8").write(
                "# q\n\n**Status:** open\n")
        open(os.path.join(d, "dirty"), "w", encoding="utf-8").write("d")     # 未跟踪 → 待办
        import i18n  # noqa: PLC0415
        # ⚠️ **在 null 包里重新渲染**，不是拿当前语言包的输出做字符串匹配。
        # 此前 `text` 是 `section(d)` 用**当前包**渲染的，然后在
        # `bind(NULL)` 里查 `"next.pending_header" in text` —— 装了任何语言包
        # （en/zh/de）时那句永远不成立，用例恒红；零包时恰好绿。
        # 实测：CI 之后 `next --selftest` 在 REFLECT_LANG=en 下 6 PASS / 1 FAIL。
        with i18n.bind(i18n.NULL):
            lines = section(d)
            text = "\n".join(lines)
            has_pending = "next.pending_header" in text
            has_dirty = "next.tree_dirty" in text
            return has_pending and has_dirty and len(lines) <= SECTION_MAX
    except Exception:                                    # noqa: BLE001
        return False
    finally:
        shutil.rmtree(d, True)


def _selftest():
    import sys  # noqa: PLC0415

    from gate import main_selftest_or  # noqa: PLC0415
    from i18n import M  # noqa: PLC0415
    return main_selftest_or(sys.argv[1:], M("gate.title.next"), _cases,
                            lambda a: 0)


if __name__ == "__main__":
    import sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    if "--selftest" in sys.argv:
        import next as _mod  # noqa: PLC0415
        sys.exit(_mod._selftest())
    sys.exit(main())

from gate import module_meta  # noqa: E402

MODULE = module_meta(
    "接着上一轮",
    "记忆系统的数据采集：未推送提交 / 工作区 / 未结案悬案 ⇒ 一段宿主无关的注入行"
    "（现算，不落盘；预算在模块内）",
    selftest=True)
