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

from gate import fatal, finish, guard_nonempty, main_selftest_or, meta, repo  # noqa: E402
from ledger import age_days, facts_of, load, value_of     # noqa: E402
from living import DATED_RECORD, living_lines  # noqa: E402

DOCS = tuple(d for d in os.environ.get(
    "REFLECT_DOCS",
    "STATE.md,AGENTS.md,README.md,README.zh.md,README.de.md").split(",") if d)
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
CITE_RE = re.compile(r"\[\[[A-Za-z_][A-Za-z0-9_]*\]\]")


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
            if not is_living or not SHA_NEAR.search(line) or _is_sourced(line):
                continue
            toks = SHA_TOKEN.findall(line)
            if not toks:
                continue
            if not shas:
                out.append("%s:%d sha 断言无出处：台账里**没有任何 sha 类事实**，"
                           "先把它量进台账（带复跑命令），再引用" % (name, lineno))
                continue
            for tok in toks:
                if not any(tok == s or s.startswith(tok) or tok.startswith(s[:len(tok)])
                           for s in shas):
                    out.append("%s:%d sha 断言无出处：`%s` 不在台账里 —— "
                               "改写成 [[键名]] 引用，或给出可核出处"
                               "（交付包名 / 反引号 commit sha）。注意："
                               "「历史」二字**不构成出处**（issue #25）"
                               % (name, lineno, tok[:16]))
    return out


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
            out.append("`%s` 的 measured_at 缺失或不可解析 —— 测龄判据无法评估"
                       "（读不到就明说，不许猜）" % k)
        elif d > sd:
            out.append("`%s` 已 %.0f 天没测（阈值 %.0f 天）—— 重测并显式 "
                       "`--accept-changes`" % (k, d, sd))
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
                    out.append("%s:%d 退役名 `%s` 出现在活状态里 —— 要么它没退役，"
                               "要么这行带上历史标记" % (name, lineno, w))
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
        return ["台账为空 —— 空不是通过（零值守卫）：先查 measure() 是不是坏了"]
    if not docs:
        return ["一份活状态文档都没扫到 —— 空输入不是通过（零值守卫）"]
    sd = _stale_days() if stale_days is None else stale_days
    return (_sha_assertion_problems(f, docs, hist)
            + _stale_age_problems(f, sd)
            + _retired_name_problems(docs, hist, retired))


def run(argv):
    docs = {}
    for name in DOCS:
        p = repo(name)
        if os.path.exists(p):
            docs[name] = open(p, encoding="utf-8", errors="replace").read()
    rc = guard_nonempty("check_stale", docs, "被扫描的活状态文档")
    if rc:
        return rc
    facts_name = os.environ.get("REFLECT_FACTS", "FACTS.json")
    if not os.path.exists(repo(facts_name)):
        return fatal("缺事实台账（%s）。先跑 python3 zreflect/facts.py 量一遍。"
                     % facts_name)
    probs = problems(load(repo(facts_name)), docs)
    if not probs:
        if not RETIRED:
            print("R2（退役名）：REFLECT_RETIRED 未配置 ⇒ 本条规则未启用（要启用："
                  "REFLECT_RETIRED=名1,名2）", file=sys.stderr)
        if _stale_days() is None:
            print("测龄：REFLECT_STALE_DAYS 未配置 ⇒ 本条规则未启用（要启用："
                  "REFLECT_STALE_DAYS=天）", file=sys.stderr)
    rc = finish("陈旧断言检测", probs,
                "陈旧断言检测：OK（扫了 %d 份文档；退役名 %s）"
                % (len(docs), "未配置" if not RETIRED else "%d 个" % len(RETIRED)))
    if rc == 1 and "--list" in argv:
        return 0                      # --list 只列不改、永远 0（人工巡检模式）
    return rc


def _cases():
    led_sha = {"facts": {"site_sha": {"value": "a" * 64, "cmd": "sha256sum x", "source": "s"}}}
    led_plain = {"facts": {"n": {"value": 7, "cmd": "echo 7", "source": "s"}}}
    bare = "部署 sha256 deadbeefdeadbeef00cafe00\n"
    fresh = (datetime.now(timezone.utc) - timedelta(days=1)).strftime(
        "%Y-%m-%dT%H:%M:%S%z")
    led_fresh = {"facts": {"n": {"value": 7, "cmd": "echo 7", "source": "s",
                                 "measured_at": fresh}}}
    led_old = {"facts": {"n": {"value": 7, "cmd": "echo 7", "source": "s",
                               "measured_at": "2020-01-01T00:00:00+0000"}}}
    return [
        # ① 正常不报
        ("sha 与台账一致（16 位前缀也能对上）⇒ 不报",
         lambda: problems(led_sha, {"A.md": "部署 sha256 %s…（截断显示）\n" % ("a" * 16)}) == []),
        ("历史标记 + 反引号 sha（可核出处）⇒ 不报",
         lambda: problems(led_plain, {"A.md": "旧 sha abcdef01（已翻案，见 `abc1234`）\n"}) == []),
        # ② 反向判据（issue #25）：历史标记**不再是**免死金牌
        ("★ 只有「历史」二字、无可核出处的假 sha ⇒ 必须报（issue #25）",
         lambda: any("sha 断言无出处" in x for x in problems(
             led_plain, {"A.md": "部署的 sha256 历史是 8287589ebdb53b4c 这串\n"}))),
        ("★ [[键名]] 引用构成出处（可复跑锚）⇒ 不报",
         lambda: problems(led_sha, {"A.md": "旧 sha256 [[site_sha]] 已翻案\n"}) == []),
        ("台账无 sha + 正文无 sha 断言 ⇒ 不报",
         lambda: problems(led_plain, {"A.md": "今天是好日子\n"}) == []),
        ("声明过的历史章节里的 sha ⇒ 不报",
         lambda: problems(led_plain, {"A.md": "## 5 历史\n" + bare}, hist_secs=("5",)) == []),
        ("退役名未配置 ⇒ 不报（但 run() 会明说未启用）",
         lambda: problems(led_plain, {"A.md": "还在用老组件\n"}, retired=()) == []),
        ("退役名只在指路（分支/文件名）⇒ 不报",
         lambda: problems(led_plain, {"A.md": "见 NOTES-osmesa.md 与 osmesa-分支\n"},
                          retired=("osmesa",)) == []),
        # ② 该报的必须报
        ("★ sha 不在台账且无出处 ⇒ 必须报",
         lambda: any("不在台账里" in x for x in problems(
             led_sha, {"A.md": bare}))),
        ("★ 台账里没有任何 sha 事实但正文断言了 sha ⇒ 必须报",
         lambda: any("没有任何 sha 类事实" in x for x in problems(
             led_plain, {"A.md": bare}))),
        ("★ 未声明历史章节 ⇒ 里面的 sha 照查（默认从严）",
         lambda: any("sha 断言无出处" in x for x in problems(
             led_plain, {"A.md": "## 5 历史\n" + bare}, hist_secs=()))),
        ("★ 退役名独立成词出现在活状态 ⇒ 必须报",
         lambda: any("退役名" in x for x in problems(
             led_plain, {"A.md": "后端还在用 osmesa\n"}, retired=("osmesa",)))),
        ("★ 无编号章节也是活状态（默认从严）⇒ 藏进去的退役名必须报",
         lambda: any("退役名" in x for x in problems(
             led_plain, {"A.md": "## 常见问题\n还在用 osmesa\n"}, retired=("osmesa",)))),
        # ③ 空输入必须报
        ("★ 台账空 ⇒ 必须报", lambda: problems({"facts": {}}, {"A.md": "x\n"}) != []),
        ("★ 一份文档都没扫到 ⇒ 必须报", lambda: problems(led_plain, {}) != []),
        # ② 测龄（issue #3 ②）
        ("测龄低于阈值 ⇒ 不报",
         lambda: problems(led_fresh, {"A.md": "x\n"}, stale_days=30) == []),
        ("阈值未配置 ⇒ 不报（规则明说未启用）",
         lambda: problems(led_old, {"A.md": "x\n"}, stale_days=None) == []),
        ("★ 测龄超阈值 ⇒ 必须报",
         lambda: any("没测" in x for x in problems(
             led_old, {"A.md": "x\n"}, stale_days=30))),
        ("★ measured_at 缺失 + 阈值开启 ⇒ 必须报（读不到就明说）",
         lambda: any("measured_at" in x for x in problems(
             led_plain, {"A.md": "x\n"}, stale_days=30))),
    ]


GATE = meta("陈旧断言检测", "sha 出处 / 退役名 / 测龄",
            knobs=("REFLECT_DOCS", "REFLECT_FACTS", "REFLECT_HISTORY_SECS",
                   "REFLECT_RETIRED", "REFLECT_STALE_DAYS"),
            name_dependent=True)

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], "check_stale（陈旧断言：sha 出处 + 退役名）",
                              _cases, run))
