#!/usr/bin/env python3
"""陈旧断言闸门：活状态里的 sha 断言必须有出处，退役名不许回来当现状。

从 Octave-Full-Wasm 的 `.githooks/check-handoff.py` 迁移并泛化（那边是 L1–L4 四条
项目规则；这里留下的是**机制**，各仓库用自己的台账与退役名单喂它）：

  **R1 sha 断言的出处**（原 L1 的泛化）
  活状态正文里，靠近 sha / hash / 校验 / 指纹 字样的十六进制串，三种归宿：
      ① 它是台账里的一条事实（整串或渲染出的 16 位前缀都能对上）；
      ② 那一行自带历史标记（历史 / 退役 / 已翻案……）；
      ③ 那一行带**明确出处**（交付包名、反引号 commit sha）。
  三者都不是 ⇒ 它就是一句没有出处的「现在如此」—— 换了构建还挂着旧 sha 的那种。
  那边踩过的形状：换带 GL 的构建之后，头部还挂着旧 sha 没人发现。
  ⚠️ 两个出口（历史标记 / 明确出处）都是从血里来的：没有历史出口，人只能删掉历史；
     出口写成"任何裸 sha"，假断言就整行豁免（那边实测漏检过一次）。

  **R2 退役名**（原 L3 的泛化）
  退役组件名**独立成词**地出现在活状态里 = 「还在用它」的断言。
  ⚠️ 独立成词是必须的：分支名 / 文件名里的退役词是在**指路**（历史留档），
  不是当前状态的断言。名单用 `REFLECT_RETIRED` 配（逗号分隔）；不配 = 本条规则
  **明说未启用**，不假装查过。

  历史章节用 `REFLECT_HISTORY_SECS` 声明（如 `5,9,10`）——编号对不上的照样算活状态。

用法：
  python3 zreflect/check_stale.py            # 违规即非零（pre-commit / pre-push 用）
  python3 zreflect/check_stale.py --list     # 只列不改、永远 0（人工巡检）
  python3 zreflect/check_stale.py --selftest
"""
import os
import re
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import knobs  # noqa: E402
from gate import fatal, finish, guard_nonempty, main_selftest_or, meta, repo  # noqa: E402
from i18n import M  # noqa: E402
from ledger import age_days, facts_of, load_or_fatal, value_of  # noqa: E402
from living import CITE_RE, DATED_RECORD, living_lines  # noqa: E402

# **不在模块级取值**：`knobs.docs_names()` 是唯一产地（登记表里的默认值），
# 而模块级常量会在 import 时把它冻住 —— 自证与换名的夹具都改不动它。
# ⚠️ 曾在这里手写一份五份的字面量，与登记表的六份（多 PRINCIPLES.md）漂开了。
HIST_SECS = tuple(s for s in os.environ.get("REFLECT_HISTORY_SECS", "").split(",") if s)
RETIRED = tuple(s for s in os.environ.get("REFLECT_RETIRED", "").split(",") if s)
STALE_DAYS_RAW = os.environ.get("REFLECT_STALE_DAYS", "").strip()


def _stale_days():
    """测龄报警阈值（天，issue #3 ②）：`REFLECT_STALE_DAYS` 可配。

    不配 / 坏值 ⇒ None —— 该规则**明说未启用**（同 REFLECT_RETIRED 的先例），
    不假装查过。
    """
    if not STALE_DAYS_RAW:
        return None
    try:
        return float(STALE_DAYS_RAW)
    except ValueError:
        return None

SHA_NEAR = re.compile(r"sha|hash|校验|指纹", re.I)
SHA_TOKEN = re.compile(r"(?<![0-9a-f`])([0-9a-f]{8,64})(?![0-9a-f`])")


def _sha_facts(f):
    """台账里的 sha 类事实值（64 位串就是 sha；别的长度的串不猜）。"""
    out = set()
    for entry in (f or {}).values():
        v = value_of(entry)
        if isinstance(v, str) and re.fullmatch(r"[0-9a-f]{64}", v or ""):
            out.add(v)
    return out


# 引用式出处（issue #25）：`[[键名]]` 指向台账 —— 与「历史」标记不同，
# 它是**可复跑**的锚。


def _is_sourced(line):
    """这一行带了**明确的、可核的**出处吗？

    issue #25 之前：`HIST_MARK`（「历史」二字）**单独**就算出处 ⇒ 任意断言
    加「历史」即获整行豁免 —— 下游实测：同一句编造 sha，只多「历史」两个字，
    就从红变绿。闸门的报错文案自己就写着「或带上历史标记/出处」，**在教用户
    绕过自己**（`living.py:11-19` 早就自认这个漏检，但只写成注释）。

    现在：「历史」**不豁免内容**，只表示「不与今天对账」；这一行仍必须给出
    可核的出处之一：

      · `DATED_RECORD` —— 交付包名（含 8 位日期）或**反引号里的** commit sha；
      · `[[键名]]` —— 引用台账事实（可复跑）。

    纯「历史」二字不再够 —— 它只是**提示**，不是证据。要真正豁免一条历史
    断言，把它登记进 `retractions.json` / `REFLECT_RETIRED`（单一产地），
    或给出交付名/sha 引用。
    """
    return bool(DATED_RECORD.search(line) or CITE_RE.search(line))


def _sha_assertion_problems(f, docs, hist):
    """R1：活状态里靠近 sha / hash 字样的十六进制串必须有可核出处。

    三种归宿（台账事实 / 可核出处）；都不是 ⇒ 报。台账里一个 sha 类事实都没有
    ⇒ 单独报「先量进台账」（空不是通过）。
    """
    out = []
    shas = _sha_facts(f)
    for name, body in sorted(docs.items()):
        for lineno, line, is_living in living_lines(body, hist):
            out += _sha_line_problems(name, lineno, line, is_living, shas)
    return out


def _sha_line_problems(name, lineno, line, is_living, shas):
    """一行的 sha 出处判定：不活 / 不挨着 sha / 已有出处 ⇒ 不报。

    台账里一个 sha 都没有时先报「先量进台账」（空不是通过）；有台账
    但串对不上任何已知 sha（含前缀关系）⇒ 报 unsourced。
    """
    if not is_living or not SHA_NEAR.search(line) or _is_sourced(line):
        return []
    toks = SHA_TOKEN.findall(line)
    if not toks:
        return []
    if not shas:
        return [M("stale.sha_no_facts", name=name, lineno=lineno)]
    return [M("stale.sha_unsourced", name=name, lineno=lineno, actual=tok[:16])
            for tok in toks
            if not any(tok == s or s.startswith(tok) or tok.startswith(s[:len(tok)])
                       for s in shas)]


def _stale_age_problems(f, sd):
    """测龄（issue #3 ②）：台账里的 measured_at 距今天的天数超阈值 ⇒ 报。

    未配置（sd is None）⇒ 不查（明说未启用）；读不到时间戳 ⇒ 也报
    （读不到就明说，不许猜 0）。
    """
    out = []
    if sd is None:
        return out
    for k in sorted(f):
        d = age_days(f[k])
        if d is None:
            out.append(M("stale.measured_at_missing", key=k))
        elif d > sd:
            # 取整在发射点：原文案是 %.0f，null 包（无语言包）里也照同一口径显示，
            # 否则裸 repr 会吐出 2495.6510176482525 这种噪声。
            out.append(M("stale.too_old", key=k, days=round(d),
                         threshold=round(sd)))
    return out


def _retired_name_problems(docs, hist, retired):
    """R2 退役名：独立成词出现在活状态 ⇒ 报。

    名单不配 = 未启用（run() 会明说，这里不打印 —— 纯函数保持安静）。
    """
    out = []
    for name, body in sorted(docs.items()):
        for lineno, line, is_living in living_lines(body, hist):
            if not is_living or _is_sourced(line):
                continue
            for w in retired:
                if re.search(r"(?<![0-9A-Za-z_-])%s(?![0-9A-Za-z_.-])" % re.escape(w),
                             line, re.I):
                    out.append(M("stale.retired_name", name=name, lineno=lineno,
                                 entry=w))
    return out


def problems(ledger, docs, retired=RETIRED, hist_secs=None, stale_days=None):
    """返回问题清单（纯函数：自证要用）。`docs` = {文件名: 正文}。

    一层判据 = 一个函数，按 R1 → 测龄 → R2 的顺序拼接（顺序即报错顺序）。

    `hist_secs=None` ⇒ 用模块级的 `REFLECT_HISTORY_SECS`；自证显式传，才能测到它。
    `stale_days=None` ⇒ 用 `REFLECT_STALE_DAYS`（未配 ⇒ 测龄规则未启用）。
    """
    hist = HIST_SECS if hist_secs is None else hist_secs
    f = facts_of(ledger)
    if not f:
        return [M("stale.ledger_empty")]
    if not docs:
        return [M("stale.no_docs")]
    sd = _stale_days() if stale_days is None else stale_days
    return (_sha_assertion_problems(f, docs, hist)
            + _stale_age_problems(f, sd)
            + _retired_name_problems(docs, hist, retired))


def _load_docs(names):
    """读活状态文档。**读不到的**不进 `docs`（由 `guard_nonempty` 判空）。"""
    docs = {}
    for name in names:
        p = repo(name)
        if os.path.exists(p):
            docs[name] = open(p, encoding="utf-8", errors="replace").read()
    return docs


def scanned_docs():
    """本闸门要扫的**文件名单**（`knobs.docs_names()`，唯一产地）。

    ⚠️ 之前这个函数名给的是「名字→正文」的 dict，而 `check_retractions`
    的同名函数给的是名单 —— 同一个名字两种返回形状，`knobs` 侧的对账判据
    因此读到了 dict 的键（碰巧能跑）。名字说的是名单，就返回名单。
    """
    return knobs.docs_names()


def run(argv):
    docs = _load_docs(scanned_docs())
    rc = guard_nonempty("check_stale", docs, M("stale.scanned_docs"))
    if rc:
        return rc
    facts_name = os.environ.get("REFLECT_FACTS", "FACTS.json")
    if not os.path.exists(repo(facts_name)):
        return fatal(M("stale.ledger_missing", name=facts_name))
    probs = problems(load_or_fatal(repo(facts_name)), docs)
    if not probs:
        if not RETIRED:
            print(M("stale.retired_rule_off"), file=sys.stderr)
        if _stale_days() is None:
            print(M("stale.age_rule_off"), file=sys.stderr)
    rc = finish(M("stale.title"), probs,
                M("stale.ok", count=len(docs),
                  declared=M("stale.retired_none") if not RETIRED
                  else M("stale.retired_count", count=len(RETIRED))))
    if rc == 1 and "--list" in argv:
        return 0                      # --list 只列不改、永远 0（人工巡检模式）
    return rc


def _cases_fixture():
    """夹具（原 `_cases` 的前置段原样搬入）。"""
    led_sha = {"facts": {"site_sha": {"value": "a" * 64, "cmd": "sha256sum x", "source": "s"}}}
    led_plain = {"facts": {"n": {"value": 7, "cmd": "echo 7", "source": "s"}}}
    bare = "deployed sha256 deadbeefdeadbeef00cafe00\n"
    fresh = (datetime.now(timezone.utc) - timedelta(days=1)).strftime(
        "%Y-%m-%dT%H:%M:%S%z")
    led_fresh = {"facts": {"n": {"value": 7, "cmd": "echo 7", "source": "s",
                                 "measured_at": fresh}}}
    led_old = {"facts": {"n": {"value": 7, "cmd": "echo 7", "source": "s",
                               "measured_at": "2020-01-01T00:00:00+0000"}}}
    return {'led_sha': led_sha, 'led_plain': led_plain, 'bare': bare, 'fresh': fresh, 'led_fresh': led_fresh, 'led_old': led_old}


def _cases_sha(fx):
    """见 `_cases()`：本组 8 条。"""
    led_sha, led_plain, bare = fx["led_sha"], fx["led_plain"], fx["bare"]
    return [
    ("stale.sourced_history_sha",
     lambda: problems(led_plain, {"A.md": "old sha abcdef01 (retracted, see `abc1234`)\n"})
     == []),
    # ② 反向判据（issue #25）：历史标记**不再是**免死金牌
    ("★ stale.sha_no_facts·history_mark",
     lambda: [p.code for p in problems(
         led_plain, {"A.md": "deployed sha256 history is 8287589ebdb53b4c\n"})]
     == ["stale.sha_no_facts"]),
    ("stale.cite_anchor",
     lambda: problems(led_sha, {"A.md": "old sha256 [[site_sha]] retracted\n"}) == []),
    ("stale.no_sha_assertion",
     lambda: problems(led_plain, {"A.md": "a fine day\n"}) == []),
    ("stale.declared_history_section",
     lambda: problems(led_plain, {"A.md": "## 5 history\n" + bare}, hist_secs=("5",))
     == []),
    # ② 该报的必须报
    ("★ stale.sha_unsourced",
     lambda: [p.code for p in problems(led_sha, {"A.md": bare})]
     == ["stale.sha_unsourced"]),
    ("★ stale.sha_no_facts",
     lambda: [p.code for p in problems(led_plain, {"A.md": bare})]
     == ["stale.sha_no_facts"]),
    ("★ stale.sha_no_facts·undeclared_section",
     lambda: [p.code for p in problems(
         led_plain, {"A.md": "## 5 history\n" + bare}, hist_secs=(""))
     ] == ["stale.sha_no_facts"]),
    ]


def _cases_retired(fx):
    """见 `_cases()`：本组 4 条。"""
    led_plain = fx["led_plain"]
    return [
    ("stale.retired_unconfigured",
     lambda: problems(led_plain, {"A.md": "still using the old component\n"},
                      retired=()) == []),
    ("stale.retired_reference",
     lambda: problems(led_plain, {"A.md": "see NOTES-osmesa.md and the osmesa-branch\n"},
                      retired=("osmesa",)) == []),
    ("★ stale.retired_name",
     lambda: [p.code for p in problems(
         led_plain, {"A.md": "backend still uses osmesa\n"}, retired=("osmesa",))]
     == ["stale.retired_name"]),
    ("★ stale.retired_name·unnumbered_section",
     lambda: [p.code for p in problems(
         led_plain, {"A.md": "## FAQ\nstill using osmesa\n"}, retired=("osmesa",))]
     == ["stale.retired_name"]),
    ]


def _cases_age(fx):
    """见 `_cases()`：本组 4 条。"""
    led_plain, led_fresh, led_old = fx["led_plain"], fx["led_fresh"], fx["led_old"]
    return [
    # ② 测龄（issue #3 ②）
    ("stale.age_fresh",
     lambda: problems(led_fresh, {"A.md": "x\n"}, stale_days=30) == []),
    ("stale.age_rule_off",
     lambda: problems(led_old, {"A.md": "x\n"}, stale_days=None) == []),
    ("★ stale.too_old",
     lambda: [p.code for p in problems(
         led_old, {"A.md": "x\n"}, stale_days=30)] == ["stale.too_old"]),
    ("★ stale.measured_at_missing",
     lambda: [p.code for p in problems(
         led_plain, {"A.md": "x\n"}, stale_days=30)]
     == ["stale.measured_at_missing"]),
    ]


def _cases_empty(fx):
    """见 `_cases()`：本组 3 条。"""
    led_sha, led_plain = fx["led_sha"], fx["led_plain"]
    return [
    # ① 正常不报
    ("stale.ok",
     lambda: problems(led_sha,
                      {"A.md": "deployed sha256 %s... (truncated)\n" % ("a" * 16)}) == []),
    # ③ 空输入必须报
    ("★ stale.ledger_empty",
     lambda: [p.code for p in problems({"facts": {}}, {"A.md": "x\n"})]
     == ["stale.ledger_empty"]),
    ("★ stale.no_docs",
     lambda: [p.code for p in problems(led_plain, {})] == ["stale.no_docs"]),
    ]


def _cases():
    """拼装 4 组夹具断言。**只拼装** —— 判据在各分组函数里。"""
    fx = _cases_fixture()
    return (
    _cases_sha(fx)
    + _cases_retired(fx)
    + _cases_age(fx)
    + _cases_empty(fx)
    )


GATE = meta("陈旧断言检测", "sha 出处 / 退役名 / 测龄",
            knobs=("REFLECT_DOCS", "REFLECT_FACTS", "REFLECT_HISTORY_SECS",
                   "REFLECT_RETIRED", "REFLECT_STALE_DAYS"),
            name_dependent=True)

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], "check_stale", _cases, run))
