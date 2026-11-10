#!/usr/bin/env python3
"""handoff 口径闸门（Einfacht 套件 · 活文档层）。

## 它管什么

**进度手记里的计数不许手抄**——基线唯一且块内零数字、台账键值快照禁入、
危险计数形态（N/N、N 项、N 条 open）禁入、未竟条目必须挂锚。
手抄计数出现即红，**不管它当前对不对**：对的手抄也会在下次值变化时腐烂
（「五包 227 条」写下来那天就是对的，腐烂只是时间问题）。

## 为什么需要（2026-10-26 站长定案）

handoff 是全仓唯一不在 `REFLECT_DOCS` 里的活文档——check_facts 的裸数字
判据管 STATE/AGENTS，管不到它。于是同一天核出五类腐烂（详见口径表 _why）：
基线两处并存（488/477）、台账快照过期（227 条 / 24 项 / 11 条清单）、
索引节复述基线（lab 15/15）、未竟干完不删（64 处同义名）、
算术自相矛盾（6+6+1=13 写成 14 条 open）。

## 与 check_facts 的分工

· `check_facts`：**产地的纪律**——STATE 机器块与台账一致、REFLECT_DOCS 里
  裸数字 ≥100 要写 [[键名]]。它管「数字只生产一次」。
· 本闸门：**非产地活文档的纪律**——handoff 里连「引用式手抄」（键名紧跟数字）
  都不许，要引就写键名（反引号包裹），数字让读者去 STATE 机器块看。
  它管「抄都别抄」。

## 判据强度（如实声明）

查的是**文本形态**（口径表声明的正则），不是语义正确性。
· 能证明「手抄计数的形态不再出现在 handoff 里」；
· 不能证明「叙述性历史数字是对的」（44 轮 43 调用这类冻结史实不在此辖，
  它们在归档文件里，本闸门不扫归档）。

## 数据在哪

口径是**数据**，引擎通用：

    { "docs": [...], "baseline_marker": "**当前基线",
      "fact_snapshot_keys": [...], "bare_value_keys": [...],
      "forbidden_shapes": [{"pattern": ..., "why": ...}],
      "todo_marker": "**未竟**", "todo_anchor": "#\\d+|定案" }

位置：环境变量 `HANDOFF_SPEC`（本仓私有名，非 Einfacht 旋钮——新版名册无此旋钮，
用私有名避免幻影告警）指定；未配时退回本机默认
`.kimi-code/handoff-口径.json`。两处都没有 ⇒ 明说未启用、退 0。

## 零值守卫

表缺规则 / docs 空 / bare_value_keys 空或引用台账里不存在的键 /
docs 声明的文件读不到 ⇒ 都报。空表不是通过。
"""
from __future__ import annotations

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from i18n import M  # noqa: E402
from gate import fatal, finish, load_spec, main_selftest_or, meta, off  # noqa: E402
from gate import repo                                   # noqa: E402

HANDOFF_RAW = os.environ.get("HANDOFF_SPEC", "").strip()
# PINNED: 判据输出与夹具的中文是 handoff.md 协议标记与 zh 报告（翻译等于改协议）。
DEFAULT_SPEC = ".kimi-code/handoff-口径.json"


def _blocks(text, marker):
    """以 marker 开头的块：标记行 + 到下一个空行为止的连续行。返回 [ [行...] ]。
    PINNED: 判据输出的中文标记（**当前基线/**未竟 等）本身就是 .kimi-code/handoff.md 的协议字符串，翻译它们等于改协议；本闸门只服务 zh 读者（站长），不存在第二语言受众。
    """
    lines = text.split("\n")
    out, i = [], 0
    while i < len(lines):
        if lines[i].startswith(marker):
            blk = [lines[i]]
            j = i + 1
            while j < len(lines) and lines[j].strip():
                blk.append(lines[j])
                j += 1
            out.append(blk)
            i = j
        else:
            i += 1
    return out


def _spec_problems(spec, facts):
    """① 零值守卫：表本身必须有效。返回问题清单（非空 ⇒ 后续判定不做）。
    PINNED: 判据输出的中文标记（**当前基线/**未竟 等）本身就是 .kimi-code/handoff.md 的协议字符串，翻译它们等于改协议；本闸门只服务 zh 读者（站长），不存在第二语言受众。
    """
    out = []
    if not spec.get("docs"):
        out.append("口径表缺 docs —— 不知道管哪个文档，等于没守")
    if not spec.get("forbidden_shapes"):
        out.append("forbidden_shapes 为空 —— 一条危险形态都不禁，等于没守")
    if not spec.get("baseline_marker"):
        out.append("缺 baseline_marker —— 「当前基线」没有锚，唯一性无从判")
    bare = spec.get("bare_value_keys") or []
    if not bare:
        out.append("bare_value_keys 为空 —— 一个台账值都不护，手抄快照随便进")
    for s in spec.get("forbidden_shapes") or []:
        if not s.get("why"):
            out.append("禁用形态 %s 缺 why（必填）—— 没理由的检查没人敢删，会变僵尸"
                       % s.get("pattern"))
    for k in bare:
        if facts and k not in facts:
            out.append("bare_value_keys 引用了台账里不存在的键 `%s` —— 表自相矛盾" % k)
    for key in ("baseline_body_digit_ban", "todo_anchor"):
        p = spec.get(key) or ""
        try:
            re.compile(p)
        except re.error as e:
            out.append("%s=%r 不是合法正则：%s" % (key, p, e))
    for s in spec.get("forbidden_shapes") or []:
        if not s.get("pattern"):
            out.append("forbidden_shapes 有一条缺 pattern")
            continue
        try:
            re.compile(s["pattern"])
        except re.error as e:
            out.append("禁用形态 %s 不是合法正则：%s" % (s["pattern"], e))
    return out


def _block_body(blk, marker):
    """块的可判区域：标记行**冒号之后**的正文 + 后续行。
    PINNED: 判据输出的中文标记（**当前基线/**未竟 等）本身就是 .kimi-code/handoff.md 的协议字符串，翻译它们等于改协议；本闸门只服务 zh 读者（站长），不存在第二语言受众。

    冒号前的标题区允许放日期（「当前基线（2026-10-26 复核）**：」），
    冒号后才是条目——条目常直接写在标记行上（**未竟**：① …），不能漏判。
    """
    head = blk[0][len(marker):]
    i = head.find("：")
    if i < 0:
        i = head.find(":")
    seg0 = head[i + 1:] if i >= 0 else ""
    return ((seg0 + "\n") if seg0.strip() else "") + "\n".join(blk[1:])


def problems(spec, docs_text, fact_values=None, facts=None):
    """纯函数：返回问题清单（空 = 绿）。自证期间不许 print。
    PINNED: 判据输出的中文标记（**当前基线/**未竟 等）本身就是 .kimi-code/handoff.md 的协议字符串，翻译它们等于改协议；本闸门只服务 zh 读者（站长），不存在第二语言受众。

    `spec` = 口径表；`docs_text` = {相对路径: 正文（None = 缺失）}；
    `fact_values` = {键: 值}（裸值判定；None = 跳过裸值层）；
    `facts` = 台账键集合（表自洽校验；None = 跳过）。
    """
    out = _spec_problems(spec, facts)
    if out:
        return out

    marker = spec["baseline_marker"]
    max_blocks = int(spec.get("baseline_max_blocks") or 1)
    digit_ban = re.compile(spec.get("baseline_body_digit_ban") or r"\d{2,}")
    snap_keys = spec.get("fact_snapshot_keys") or []
    snap_rx = re.compile(r"(?<![\w`])(%s)\s*[：:／/、,，]?\s*\d"
                         % "|".join(re.escape(k) for k in snap_keys)) if snap_keys else None
    shape_rxs = []
    for s in spec["forbidden_shapes"]:
        if s.get("pattern") and s.get("why"):
            shape_rxs.append((re.compile(s["pattern"]), s["why"]))
    todo_marker = spec.get("todo_marker") or "**未竟**"
    todo_rx = re.compile(spec.get("todo_anchor") or r"#\d+")
    bare_keys = [k for k in (spec.get("bare_value_keys") or [])
                 if fact_values and k in fact_values]

    for rel, text in docs_text.items():
        if text is None:
            out.append("读不到文档：%s（docs 声明了它就必须在）" % rel)
            continue
        # R1/R3：基线块唯一，且块体零数字（有数字的基线块迟早腐烂）
        blocks = _blocks(text, marker)
        if len(blocks) > max_blocks:
            out.append("%s 里「%s」块出现 %d 处（上限 %d）—— 基线两处并存是 "
                       "488/477 事件的直接成因，现状只许一个锚"
                       % (rel, marker, len(blocks), max_blocks))
        # 「必须有基线块」只对**现状型**活文档成立。口径表用 `requires_baseline: false`
        # 显式声明「这份文档按定义没有现状」（HISTORY.md 就是这种：它只写当时）。
        # 声明为 false 时，块的出现与唯一性仍查（出现两处照样报），只是不要求必须存在。
        if not blocks and spec.get("requires_baseline", True):
            out.append("%s 里一个「%s」块都没有 —— 现状必须有唯一锚（零值守卫）"
                       % (rel, marker))
        for blk in blocks:
            m = digit_ban.search(_block_body(blk, marker))
            if m:
                out.append("%s 基线块体内出现数字 %r —— 基线块不写数字（键名引用，"
                           "数值看 STATE 机器块），写了就会在下次值变化时腐烂"
                           % (rel, m.group(0)))
        # R4：未竟条目必须挂锚（issue 号或定案标记），否则干完了也没法对账删条。
        # 只判**条目行**（①②③… / - / * / 数字. 开头）——条目常占多行，
        # 锚在首行即可，续行（如「蓝图 = …」）不查。
        item_rx = re.compile(spec.get("todo_item") or r"^(?:[①②③④⑤⑥⑦⑧⑨⑩]|\d+[.、]|[-*])\s*")
        for blk in _blocks(text, todo_marker):
            body_lines = _block_body(blk, todo_marker).split("\n")
            n_items = 0
            for line in body_lines:
                if not item_rx.match(line):
                    continue
                n_items += 1
                if not todo_rx.search(line):
                    out.append("%s 未竟条目缺锚：%r —— 每条要么挂 issue 号（#N），"
                               "要么标「定案」，否则干完了没人知道该删"
                               % (rel, line.strip()[:40]))
            if n_items == 0:
                out.append("%s 未竟块里没有一个条目行（①②③…）—— 条目写哪儿了？"
                           "（零值守卫）" % rel)
        # R2：危险计数形态，全文档禁
        for rx, why in shape_rxs:
            m = rx.search(text)
            if m:
                out.append("%s 里出现计数手抄形态 %r —— %s" % (rel, m.group(0), why))
        # R2：键值快照（键名紧跟裸值）禁
        if snap_rx:
            m = snap_rx.search(text)
            if m:
                out.append("%s 里出现台账键值快照 %r —— 引用写键名（反引号包裹），"
                           "数字让读者去 STATE 机器块看" % (rel, m.group(0)))
        # R2：台账值裸抄禁（bare_value_keys 里区分度高的键；词边界，不伤小数点）
        for k in bare_keys:
            v = str(fact_values[k])
            m = re.search(r"(?<![\d.])%s(?![\d.])" % re.escape(v), text)
            if m:
                out.append("%s 里裸抄台账值 %s=%s —— 数字只生产一次，引用写键名 `%s`"
                           "（数值在 STATE 机器块）" % (rel, k, v, k))
    return out


def run(argv=None):
    """PINNED: 判据输出的中文标记（**当前基线/**未竟 等）本身就是 .kimi-code/handoff.md 的协议字符串，翻译它们等于改协议；本闸门只服务 zh 读者（站长），不存在第二语言受众。"""
    argv = list(sys.argv[1:] if argv is None else argv)
    name = HANDOFF_RAW or DEFAULT_SPEC
    spec_path = repo(name)
    if not os.path.exists(spec_path):
        if HANDOFF_RAW:
            return fatal("HANDOFF_SPEC=%s 已配置但口径表不在 —— "
                         "先写表（或撤掉该旋钮）" % name)
        return off("handoff 口径闸门：未配置且默认位置无表（%s）⇒ 本闸门未启用"
                   "（可插拔模块；要启用：HANDOFF_SPEC=<表路径>）" % DEFAULT_SPEC)
    spec, err = load_spec(spec_path)
    if err:
        return fatal("handoff 口径表解析失败：%s" % err)
    if not isinstance(spec, dict):
        return fatal("口径表顶层必须是对象（含 docs 数组）")

    facts_path = repo(os.environ.get("REFLECT_FACTS", "FACTS.json"))
    try:
        ledger = json.load(open(facts_path, encoding="utf-8"))
        fact_values = {k: v["value"] for k, v in (ledger.get("facts") or {}).items()}
    except (OSError, ValueError) as e:
        return fatal("读不到台账（%s）：%s —— 裸值判定需要现值" % (facts_path, e))

    docs_text = {}
    for rel in spec.get("docs") or []:
        p = repo(rel)
        docs_text[rel] = open(p, encoding="utf-8", errors="replace").read() \
            if os.path.exists(p) else None

    probs = problems(spec, docs_text, fact_values=fact_values, facts=set(fact_values))
    ok_keys = [k for k in (spec.get("bare_value_keys") or []) if k in fact_values]
    return finish("handoff 口径闸门", probs,
                  "  handoff 口径闸门：%d 份文档、%d 条形态规则、%d 个护值键，无手抄计数"
                  % (len(docs_text), len(spec.get("forbidden_shapes") or []),
                     len(ok_keys)))


# PINNED: 夹具里的中文是 .kimi-code/handoff.md 的**协议标记本身**（**当前基线/**未竟/N-N
# 形态），判据就是对这些字面量做匹配 —— 翻译夹具等于测另一个协议。模块级常量
# （不在 _cases 扫描范围）+ PINNED 声明，是上游 check_i18n 认的两条豁免之一。
# PINNED: 夹具中文是 handoff.md 协议标记（判据的匹配目标，翻译等于换协议）。
FIXTURE_SPEC = {
    "docs": ["h.md"],
    "baseline_marker": "**当前基线",
    "baseline_body_digit_ban": r"\d{2,}",
    "baseline_max_blocks": 1,
    "fact_snapshot_keys": ["plugin_tests", "hooktests"],
    "bare_value_keys": ["plugin_tests"],
    "forbidden_shapes": [
        {"pattern": r"\d{2,}/\d{2,}", "why": "N/N 计数形态"},
        {"pattern": r"\d+\s*条\s*(?:open|词条)", "why": "issue/词条计数手抄"},
    ],
    "todo_marker": "**未竟**",
    "todo_anchor": r"#\d+|定案",
}
# PINNED: 判据输出与夹具的中文是 handoff.md 协议标记与 zh 报告（翻译等于改协议）。
FIXTURE_GOOD = ("# H\n\n**当前基线（键名引用）**：站点全绿（`plugin_tests`）、\nlab 全绿（`lab_tests`）。\n\n"
            "**未竟**：① 事项甲（issue #22）；\n② 事项乙（定案 C 接受）。\n")
# PINNED: 夹具中文是 handoff.md 协议标记（判据的匹配目标，翻译等于换协议）。
FIXTURE_DUP_BASELINE_SUFFIX = "\n**当前基线**（旧）：站点全绿。\n"
# PINNED: 夹具中文是 handoff.md 协议标记（判据的匹配目标，翻译等于换协议）。
FIXTURE_NO_BASELINE = "# H\n\n正文。\n"
# PINNED: 夹具中文是 handoff.md 协议标记（判据的匹配目标，翻译等于换协议）。
FIXTURE_HISTORICAL = "\n历史：站点 477/477。\n"
# PINNED: 夹具中文是 handoff.md 协议标记（判据的匹配目标，翻译等于换协议）。
FIXTURE_EXERCISE_NOS = "\n作业范围：习题 2.1/2.2、1.1/1.3/1.5。\n"
# 以下全为断言期望子串 / 内联夹具（判据的匹配目标，翻译等于换协议）：
# PINNED: 夹具中文是 handoff.md 协议标记（判据的匹配目标，翻译等于换协议）。
FIXTURE_WANT_DUP_BASELINE = "并存"
# PINNED: 夹具中文是 handoff.md 协议标记（判据的匹配目标，翻译等于换协议）。
FIXTURE_NO_BASELINE_DOC = "# H\n\n正文。\n"
# PINNED: 夹具中文是 handoff.md 协议标记（判据的匹配目标，翻译等于换协议）。
FIXTURE_WANT_MISS_ONE_BLOCK = ("一个「", "块都没有")
# PINNED: 夹具中文是 handoff.md 协议标记（判据的匹配目标，翻译等于换协议）。
FIXTURE_WANT_BODY_DIGIT = "基线块体内"
FIXTURE_SNAPSHOT_DIGIT = "`plugin_tests` = 475）"
# PINNED: 夹具中文是 handoff.md 协议标记（判据的匹配目标，翻译等于换协议）。
FIXTURE_SITE_TESTS_OK = "\n站点测试 475 项全过。\n"
# PINNED: 夹具中文是 handoff.md 协议标记（判据的匹配目标，翻译等于换协议）。
FIXTURE_WANT_SNAPSHOT = "键值快照"
# PINNED: 夹具中文是 handoff.md 协议标记（判据的匹配目标，翻译等于换协议）。
FIXTURE_SNAPSHOT_NOW = "\n台账现状：hooktests 28、plugin_tests 475。\n"
# PINNED: 夹具中文是 handoff.md 协议标记（判据的匹配目标，翻译等于换协议）。
FIXTURE_WANT_OPEN = "条 open"
# PINNED: 夹具中文是 handoff.md 协议标记（判据的匹配目标，翻译等于换协议）。
FIXTURE_OPEN_NOW = "\nissue 有 14 条 open。\n"
# PINNED: 夹具中文是 handoff.md 协议标记（判据的匹配目标，翻译等于换协议）。
FIXTURE_SEE_ABOVE = "（见上）"
# PINNED: 夹具中文是 handoff.md 协议标记（判据的匹配目标，翻译等于换协议）。
FIXTURE_WANT_MISS_ANCHOR = "缺锚"
# PINNED: 夹具中文是 handoff.md 协议标记（判据的匹配目标，翻译等于换协议）。
FIXTURE_WANT_MISS_DOCS = "缺 docs"
# PINNED: 夹具中文是 handoff.md 协议标记（判据的匹配目标，翻译等于换协议）。
FIXTURE_WANT_EMPTY_SHAPES = "forbidden_shapes 为空"
# PINNED: 夹具中文是 handoff.md 协议标记（判据的匹配目标，翻译等于换协议）。
FIXTURE_WANT_MISS_WHY = "缺 why"
# PINNED: 夹具中文是 handoff.md 协议标记（判据的匹配目标，翻译等于换协议）。
FIXTURE_WANT_UNKNOWN_KEY = "不存在的键"
# PINNED: 夹具中文是 handoff.md 协议标记（判据的匹配目标，翻译等于换协议）。
FIXTURE_WANT_UNREADABLE = "读不到文档"
# PINNED: 判据匹配目标（handoff.md 协议标记）。
FIXTURE_WANT_BARE_COPY = "裸抄台账值"

def _cases():
    """自证：三档硬规矩（能绿 / 能红 / 空输入必报）。
    PINNED: .kimi-code/handoff.md 的协议标记（**当前基线/**未竟/N-N 形态）就是要匹配的目标字面量，夹具必须固定中文——翻译夹具等于把判据改成测另一个协议。
    PINNED: 判据输出的中文标记（**当前基线/**未竟 等）本身就是 .kimi-code/handoff.md 的协议字符串，翻译它们等于改协议；本闸门只服务 zh 读者（站长），不存在第二语言受众。
    """
    spec = FIXTURE_SPEC
    good = FIXTURE_GOOD
    fv = {"plugin_tests": 475}

    def run_on(text):
        return problems(spec, {"h.md": text}, fact_values=fv, facts=set(fv))

    return [
        ("★ 合规（键名引用、基线块零数字、未竟挂锚）⇒ 绿",
         lambda: run_on(good) == []),
        ("★ 基线块两处并存 ⇒ 报（R1：488/477 事件的形态）",
         lambda: any(FIXTURE_WANT_DUP_BASELINE in x for x in run_on(
             good + FIXTURE_DUP_BASELINE_SUFFIX))),
        ("★ 一个基线块都没有 ⇒ 报（现状必须有唯一锚）",
         lambda: any(FIXTURE_WANT_MISS_ONE_BLOCK[0] in x
                     and FIXTURE_WANT_MISS_ONE_BLOCK[1] in x
                     for x in problems(spec, {"h.md": FIXTURE_NO_BASELINE_DOC},
                                       fact_values=fv, facts=set(fv)))),
        ("★ 基线块体内写数字 ⇒ 报（有数字的基线迟早腐烂）",
         lambda: any(FIXTURE_WANT_BODY_DIGIT in x for x in run_on(
             good.replace("`plugin_tests`）", FIXTURE_SNAPSHOT_DIGIT)))),
        ("★ N/N 计数形态 ⇒ 报（R3：索引节复述基线）",
         lambda: any("477/477" in x for x in run_on(FIXTURE_HISTORICAL))),
        ("★ 题号 2.1/2.2 不误伤（一至两位枚举不是计数）",
         lambda: run_on(good + FIXTURE_EXERCISE_NOS) == []),
        ("★ 台账值裸抄 ⇒ 报（R2：对的手抄也会腐烂，抄都别抄）",
         lambda: any(FIXTURE_WANT_BARE_COPY in x and "plugin_tests=475" in x
                     for x in run_on(good + FIXTURE_SITE_TESTS_OK))),
        ("★ 键值快照 ⇒ 报（R2：notes 25／sitepages 114 清单的形态）",
         lambda: any(FIXTURE_WANT_SNAPSHOT in x for x in run_on(
             good + FIXTURE_SNAPSHOT_NOW))),
        ("★ 「N 条 open」⇒ 报（R5：14 条 open 的形态）",
         lambda: any(FIXTURE_WANT_OPEN in x for x in run_on(good + FIXTURE_OPEN_NOW))),
        ("★ 未竟条目无锚 ⇒ 报（R4：干完没删的残留无法对账）",
         lambda: any(FIXTURE_WANT_MISS_ANCHOR in x
                     for x in run_on(good.replace("（issue #22）", FIXTURE_SEE_ABOVE)))),
        ("★ 空 docs ⇒ 报（零值守卫）",
         lambda: any(FIXTURE_WANT_MISS_DOCS in x
                     for x in problems({**spec, "docs": []}, {}))),
        ("★ 空形态清单 ⇒ 报（一条都不禁等于没守）",
         lambda: any(FIXTURE_WANT_EMPTY_SHAPES in x
                     for x in problems({**spec, "forbidden_shapes": []}, {}))),
        ("★ 禁用形态缺 why ⇒ 报（会变僵尸）",
         lambda: any(FIXTURE_WANT_MISS_WHY in x for x in problems(
             {**spec, "forbidden_shapes": [{"pattern": r"\d+"}]}, {}))),
        ("★ bare_value_keys 引用不存在的键 ⇒ 报（表自相矛盾）",
         lambda: any(FIXTURE_WANT_UNKNOWN_KEY in x
                     for x in problems(spec, {}, facts={"hooktests"}))),
        ("★ 文档缺失 ⇒ 报（声明了就必须在）",
         lambda: any(FIXTURE_WANT_UNREADABLE in x
                     for x in problems(spec, {"h.md": None}, fact_values=fv, facts=set(fv)))),
    ]


# PINNED: 判据输出与夹具的中文是 handoff.md 协议标记与 zh 报告（翻译等于改协议）。
GATE = meta("handoff 口径闸门",
            "进度手记的计数口径：基线唯一且零数字、台账键值不手抄、未竟挂锚——手抄计数出现即红",
            knobs=("REFLECT_FACTS",),
            runs_at="commit",
            off_reason="可插拔模块：口径表未配置且默认位置无表时明说未启用（HANDOFF_SPEC=<表路径> 即启用）")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:],
                              M("gate.title.handoff_cover"),
                              _cases(), run))
