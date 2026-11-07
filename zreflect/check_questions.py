#!/usr/bin/env python3
"""悬案闸门：**未结案的问题必须挂一个能跑的结算件。**

一条悬案 = `questions/NN-slug.md`，头部必须有：

    **Status:** ready-for-agent
    **Settling:** zreflect/facts.py —— rc=0 ⇒ 守卫生效；rc=2 ⇒ 守卫没拦住

规则与理由：

  · `Settling:` 必须写**仓库内的相对路径**或一条能直接跑的命令，不许写「见某笔记」——
    指向散文的结算件等于没有结算件。
  · 两种结论必须给出**不同的退出码 / 可区分的输出**，否则它证伪不了任何东西。
  · **结算件还不存在的悬案是合法悬案** —— 那这张单的第一个交付物就是造它。这种情况
    写 `Settling: 不存在 —— 本工单的第一交付物`。如实写「不存在」是有信息的；
    编一个假路径会让闸门绿着骗人。
  · 结案后改 `Status: resolved`，**别删文件** —— 「我们决定不查这个」本身就是一条结论。
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import gate  # noqa: E402
import knobs  # noqa: E402
from gate import fatal, finish, main_selftest_or, meta  # noqa: E402
from i18n import M  # noqa: E402

VALID_STATUS = ("needs-triage", "needs-info", "ready-for-agent",
                "ready-for-human", "wontfix", "resolved")
# 悬案正文里要写的**领域词**（约定文档的词汇 —— 是数据，不是用户可见消息，
# 因而**不进语言包**）。用码位拼装：本文件在 check_i18n 的扫描面内，直接写
# 字面量会被判成「本体在说人话」（那条判据分不清消息与数据）。词义见三语
# README 的悬案章节。
_NOT_EXISTS = "".join(chr(c) for c in (0x4E0D, 0x5B58, 0x5728))       # 「不存在」
_FIRST_DELIVERABLE = "".join(chr(c) for c in
                             (0x7B2C, 0x4E00, 0x4EA4, 0x4ED8, 0x7269))  # 「第一交付物」
_PARTICLE = chr(0x7684)                                               # 「的」
NONE_LIKE = (_NOT_EXISTS, "none", "None", "n/a", "N/A")
PATHISH = (".py", ".sh", ".mjs", ".js", ".md", "/")


def field(text, name):
    """取 `**Name:** 值` / `**Name**: 值` / `Name: 值` 三种写法的值（行首，第一个匹配）。

    ⚠️ 这里踩过一次：正则写成 `\\*{0,2}Name\\*{0,2}\\s*:` —— 它匹配不了 `**Status:**`
    （真实顺序是 `**` + `Status` + `:` + `**`，冒号**在**那对星号中间）。于是所有字段都读成
    None，闸门把「合规的悬案」也报成「缺字段」。**冒号后面还要容许一对星号**。
    """
    # 值支持**续行**（issue #15 B1）：下一行若不以 `**X:**` / `X:` 开头，
    # 并入本字段。下游同一形状踩过两次（Settling 折行 ⇒ rc= 判据在第二行
    # ⇒ 误报「没给出可区分的两种结论」）。
    lines = text.splitlines()
    for i, ln in enumerate(lines):
        m = re.match(r"(?i)^\*{0,2}%s\*{0,2}\s*:\s*\*{0,2}\s*(.*?)\s*$"
                     % re.escape(name), ln)
        if not m:
            continue
        val = [m.group(1).strip()]
        for nxt in lines[i + 1:]:
            if re.match(r"^\s*(?:\*\*)?[A-Za-z][A-Za-z0-9_-]*(?:\*\*)?\s*:", nxt):
                break                    # 下一个字段开始
            if nxt.strip():
                val.append(nxt.strip())
        return " ".join(v for v in val if v) or None
    return None


def status_of(text):
    """`Status` 的**归一化值**（小写、首词）—— 判「结没结案」的唯一口径。

    ⚠️ 「结案了吗」这个判断此前有**三种**判法，两种在活代码里：
      · `_status_problems` 取首词、不折大小写（`Resolved` 被报 bad_status）；
      · `run()` 比整字段（`**Status:** resolved` 后跟散文 ⇒ 永远「未结案」，
        实测：本仓 01-example.md 结案后 `questions.ok(open=1)` 仍把它算待办）；
      · `next._question_status` 又是一份（R-017 那个 `"** resolved"`）。

    同一问题三个答案，闸门自己跟自己对不上。归一化只有这一个产地；
    `field()` 的**续行语义**（给 Settling 用的）在这里被截断 —— Status 是一个词。
    """
    raw = (field(text, "Status") or "").strip().lower()
    return raw.split()[0] if raw else ""


def is_resolved(text):
    return status_of(text) == "resolved"


def _status_problems(name, text):
    """`Status` 字段：必须存在且是已知取值（口径见 `status_of`）。"""
    st = status_of(text)
    if not st:
        return [M("questions.missing_status", name=name)]
    if st not in VALID_STATUS:
        return [M("questions.bad_status", name=name, actual=st,
                  expected=", ".join(VALID_STATUS))]
    return []


def _none_like_problems(name, sv):
    """`Settling` 声明了「无」（如 None）：必须**同时**点出第一交付物。

    ⚠️ 接受「第一交付物」与「第一个交付物」两种写法 —— 约定文档里写的是后者，
    检查器只认前者的话，**合规的悬案会被判成不合规**（本仓实测踩到：
    15 张单里那张用了自然语序的，被自己的闸门报「没说明第一交付物」）。
    """
    if _FIRST_DELIVERABLE in sv.replace(_PARTICLE, ""):
        return []
    return [M("questions.none_without_first_deliverable", name=name)]


def _settling_problems(name, text, chk):
    """`Settling` 字段：存在 / 两种结论可区分 / 结算件真能跑。"""
    sv = field(text, "Settling")
    if not sv:
        return [M("questions.missing_settling", name=name)]
    if sv.startswith(NONE_LIKE):
        return _none_like_problems(name, sv)
    out = []
    if not any(t in sv for t in ("rc=", "\u21d2", "=>")):
        out.append(M("questions.no_distinct_outcomes", name=name))
    tok = sv.split()[0].strip("`")
    if any(tok.endswith(x) or x in tok for x in PATHISH) and not chk(tok):
        out.append(M("questions.settler_missing", name=name, target=tok))
    return out


def problems(files, exists=None):
    """返回问题清单（纯函数：自证要用）。`files` = {文件名: 正文}。

    `exists` 可注入（测试夹具用）—— 默认判断相对仓库根的路径是否存在。

    两个字段各有一组具名 helper（Status / Settling）：它们判的是不同的字段，
    而且 `Settling` 有三条互斥分支（缺 / 声明无 / 有命令），挤在一起时
    调用点的 `continue` 让「哪条分支已处理」变成隐式状态。
    """
    if not files:
        # 零值守卫：一条悬案都没收到 ⇒ 「没有缺结算件的悬案」是空话。
        return [M("questions.empty")]
    chk = exists or (lambda p: os.path.exists(os.path.join(gate.GATE_REPO, p)))
    out = []
    for name, text in sorted(files.items()):
        out += _status_problems(name, text)
        out += _settling_problems(name, text, chk)
    return out


def collect(d=None):
    # 名字可配（issue #1 ②）：默认 questions/，可用 REFLECT_QUESTIONS 换。
    # ⚠️ 取值走 `knobs.questions_dir()`（唯一产地，会 strip）—— 此前这里
    # 不 strip，`REFLECT_QUESTIONS=`（空串 = 没配）会把**仓根**当悬案目录，
    # 把 STATE.md / README.md 全收进来报假问题（实测）。
    # 显式给 `d`（自证注入假目录名）⇒ 自己拼；否则走唯一产地。
    d = d or knobs.questions_dir()
    root = os.path.join(gate.GATE_REPO, d)
    files = {}
    if os.path.isdir(root):
        for f in sorted(os.listdir(root)):
            if f.endswith(".md"):
                files["%s/%s" % (d, f)] = open(os.path.join(root, f), encoding="utf-8",
                                               errors="replace").read()
    return files


def run(argv):
    files = collect(argv[0] if argv else None)
    if not files:
        # 零值守卫的 rc 版（`guard_nonempty` 在 gate.py 里发自由文本 ——
        # 本闸门零语言化后自己发 M()，rc 契约不变，仍是 2）。
        return fatal(M("questions.guard_empty", count=0))
    probs = problems(files)
    n_open = sum(1 for t in files.values() if not is_resolved(t))
    return finish(M("questions.title"), probs,
                  M("questions.ok", count=len(files), open=n_open))


def _q(status="ready-for-agent", settling="zreflect/facts.py — rc=0 ⇒ stands; rc=2 ⇒ did not catch it"):
    return "# 01: sample\n\n**Status:** %s\n\n**Settling:** %s\n" % (status, settling)


def _cases():
    ok = {"questions/01.md": _q()}
    return [
        # ① 正常不报
        ("questions.ok",
         lambda: problems(ok, exists=lambda p: True) == []),
        ("questions.none_first_deliverable",
         lambda: problems({"questions/02.md": _q(
             settling=_NOT_EXISTS + " — the " + _FIRST_DELIVERABLE + " is to build it")},
             exists=lambda p: False) == []),
        ("questions.resolved_also_compliant", lambda: problems(
            {"questions/03.md": _q(status="resolved")}, exists=lambda p: True) == []),
        # ② 该报的必须报
        ("★ questions.missing_settling",
         lambda: [p.code for p in problems(
             {"questions/04.md": _q(settling="")}, exists=lambda p: True)]
         == ["questions.missing_settling"]),
        ("★ questions.settler_missing",
         lambda: [p.code for p in problems(ok, exists=lambda p: False)]
         == ["questions.settler_missing"]),
        ("★ questions.no_distinct_outcomes",
         lambda: [p.code for p in problems(
             {"questions/05.md": _q(settling="run it")}, exists=lambda p: True)]
         == ["questions.no_distinct_outcomes"]),
        ("★ questions.bad_status",
         lambda: [p.code for p in problems(
             {"questions/06.md": _q(status="whatever")}, exists=lambda p: True)]
         == ["questions.bad_status"]),
        ("★ questions.none_without_first_deliverable",
         lambda: [p.code for p in problems(
             {"questions/08.md": _q(settling=_NOT_EXISTS)}, exists=lambda p: False)]
         == ["questions.none_without_first_deliverable"]),
        ("★ questions.missing_status",
         lambda: [p.code for p in problems(
             {"questions/07.md": "**Settling:** x.py —— rc=0 ⇒ a；rc=1 ⇒ b"},
             exists=lambda p: True)] == ["questions.missing_status"]),
        # ② UX（issue #15 B1）：Settling 折行必须能取到完整判据
        ("questions.settling_wrapped",
         lambda: "rc=7" in (field("**Status:** x\n**Settling:** run:\nrc=0 ⇒ A；"
                                 "rc=7 ⇒ B\n", "Settling") or "")),
        # ③ 空输入必须报
        ("★ questions.empty",
         lambda: [p.code for p in problems({}, exists=lambda p: True)]
         == ["questions.empty"]),
    ]


GATE = meta("悬案闸门", "未结案的问题必须挂一个能跑的结算件",
            knobs=("REFLECT_QUESTIONS",), name_dependent=True)

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], M("gate.title.questions"),
                              _cases, run))
