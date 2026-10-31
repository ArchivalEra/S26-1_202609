#!/usr/bin/env python3
"""事实闸门：文档里的块必须与台账一致，正文不许出现裸数字，引用不许指向不存在的键。

三条规则对应三种真实事故：

  · 块与台账不一致 —— 有人手改了块（或者改了台账忘了重渲染）；
  · 正文裸数字 —— 数字被手抄进散文，从这一刻起它就开始腐烂
    （阈值 `REFLECT_NAKED_MIN` 可配；围栏代码块 / 行内代码内豁免 ——
    文档里的复跑命令天然带数字，把它当裸数字是误报，issue #3 ④）；
  · 引用不存在的键 —— 键被改名/删掉，引用原地变成一句没有出处的断言。
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gate import fatal, finish, main_selftest_or, meta, repo  # noqa: E402
from ledger import facts_of, load, value_of              # noqa: E402
from living import DATED_RECORD   # noqa: E402
from render import BLOCK_BEGIN, BLOCK_END, body_of, prose_of, render_block  # noqa: E402

# 正文引用数字的写法：`[[键名]]`。刻意选一个不可能是自然语言的形状 ——
# 这样「有没有引用」是**可判定的**，不靠正则猜散文。
CITE_RE = re.compile(r"\[\[([A-Za-z_][A-Za-z0-9_]*)\]\]")

BARE_MIN = 100   # 默认裸数字阈值：小于它的整数不查（1/2/3 遍地都是，查了全是噪音）
FENCE_RE = re.compile(r"^\s*```")
INLINE_CODE_RE = re.compile(r"`[^`\n]+`")


def _bare_min():
    """裸数字阈值（issue #3 ④）：`REFLECT_NAKED_MIN` 可配；坏值 ⇒ 默认 + 告警。"""
    raw = os.environ.get("REFLECT_NAKED_MIN", "").strip()
    if not raw:
        return BARE_MIN
    try:
        return int(raw)
    except ValueError:
        print("⚠ REFLECT_NAKED_MIN=%r 不是整数 ⇒ 用默认 %d" % (raw, BARE_MIN),
              file=sys.stderr)
        return BARE_MIN


def _number_lines(doc_text):
    """裸数字判据要扫的行（issue #3 ④）：**围栏代码块与行内代码豁免**。

    返回 [(行号, 去掉行内代码后的行)]；行号保持**原文编号** ——
    诊断要对得上人读的文档。围栏的开/关行本身不扫。
    """
    prose = prose_of(doc_text)
    in_fence = False
    out = []
    for i, line in enumerate(prose.splitlines(), 1):
        if FENCE_RE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        out.append((i, INLINE_CODE_RE.sub("", line)))
    return out



# 形状白名单（issue #24）：这些形状的数字**不是**「手抄的测量值」，不该报。
# 反向判据（白名单式）若不排除它们，正文立刻被版本号/端口/日期刷屏，
# 最后被一律 --accept 掉 —— 比不做更糟（本仓反复踩过的「会误报的闸门
# 最终被整闸关掉」）。
_SHAPE_PATTERNS = (
    r"\d+\.\d+(\.\d+)*",          # 版本串 11.3.0 / 1.2
    r"[A-Za-z_]\w*\d+\w*",           # 标识符里的数字 sha256 / utf8 / v128
    r"\d{4}-\d{2}-\d{2}",            # ISO 日期
    r"\d{2}:\d{2}(:\d{2})?",         # 时刻
    r"0x[0-9a-fA-F]+",                 # 十六进制
    r"\d+%",                           # 百分比
    r"\d+[KMG]i?B",                    # 容量 74MB / 32MiB
    r"[\w./-]+/\d+",                  # 路径段 /113/
)


def _shape_exempt(token):
    """这个数字**出现的位置**是否属于形状白名单（版本/标识符/日期/路径…）。"""
    for pat in _SHAPE_PATTERNS:
        if re.fullmatch(pat, token):
            return True
    return False


_SHA_NEAR = re.compile(r"sha|hash|校验|指纹|commit", re.I)


def _known_values(facts):
    """台账里出现过的整数值集（抄了但没引用的黑名单判据已单独查）。"""
    known = set()
    for entry in facts.values():
        v = value_of(entry)
        if isinstance(v, int) and not isinstance(v, bool):
            known.add(v)
    return known


def _has_provenance(token, line):
    """token 在（已剥形状串的）`line` 里是否有出处。

    形状白名单 / 带 sha 上下文的裸 sha / 同行 `[[键名]]`，任一命中即有出处。
    """
    if _shape_exempt(token):
        return True
    # 裸 sha：只在该行有 sha/hash/commit 上下文时放行（那是 check_stale
    # 的活；无上下文的 8 位数字是测量值，不是 sha —— 实测踩到：
    # 99887766 被纯十六进制白名单误放）。
    if (re.fullmatch(r"[0-9a-f]{7,64}", token)
            and _SHA_NEAR.search(line)):
        return True
    return bool(CITE_RE.search(line))    # 同行有 [[键名]] ⇒ 视为引用式出处


def _unaccounted_numbers(doc_text, facts, bare_min, nlines):
    """反向判据（issue #24）：正文里**没有出处**的 ≥阈值数字。

    此前只查「台账里的值被手抄了」——一个**从未进过台账**的数字，闸门不知道
    要拦（`AGENTS.md` 说「check_facts 会拦正文里的裸数字」，无保留表述）。
    下游实测：v4 协议文档手抄 21 个数字全绿，人工复查发现至少 3 个是错的。

    判据（白名单式）：扫正文（围栏/行内代码外，`_number_lines` 已剥），
    每个 ≥ bare_min 的整数 token 必须有**出处**之一，否则报：

      · 紧跟 `[[键名]]`（同行）—— 引用式出处；
      · 命中形状白名单（版本串 / 标识符 / 日期 / 路径 / 裸 sha / 百分比 / 容量）；
      · 同行带明确出处标记（`DATED_RECORD` 型交付名或反引号 sha）；
      · 该值**恰好等于**某条台账事实的值（黑名单判据已单独查「抄了但没引用」，
        这里不重复报）。
    """
    known = _known_values(facts)
    out = []
    # 先整行剥掉「形状串」（日期/时刻/版本/容量/百分比/路径/标识符）——
    # 否则 `2026-10-31` 会被切出 `2026` 这个假 token（`-` 不在 \w 里，
    # 逐 token 匹配挡不住；实测踩到）。
    strip_re = re.compile("|".join(_SHAPE_PATTERNS))
    for lineno, line in nlines:
        if DATED_RECORD.search(line):
            continue                     # 带明确出处的记录行整行豁免（同 stale 的口径）
        line = strip_re.sub(" ", line)
        for token in re.findall(r"(?<![\w.])\d+(?![\w.])", line):
            try:
                val = int(token)
            except ValueError:
                continue
            if val < bare_min or val in known:
                continue
            if _has_provenance(token, line):
                continue
            out.append("正文第 %d 行出现**无出处**的数字 %s —— 它不在台账里，也没有 "
                       "[[键名]] 引用 / 出处标记。要么量进台账（带复跑命令）再引用，"
                       "要么确认它是无害形状（版本号/端口/日期）"
                       % (lineno, token))
    return out


def _cite_problems(prose, facts):
    """正文里引用了不存在键的 `[[键名]]`。"""
    out = []
    for i, line in enumerate(prose.splitlines(), 1):
        for k in CITE_RE.findall(line):
            if k not in facts:
                out.append("正文第 %d 行引用了**不存在**的键：`%s`" % (i, k))
    return out


def _copied_fact_problems(facts, nlines, bare_min):
    """黑名单判据：台账里的值被手抄进正文，却没在同一行写 `[[键名]]`。"""
    out = []
    for k, entry in sorted(facts.items()):
        v = value_of(entry)
        if isinstance(v, bool) or not isinstance(v, int) or v < bare_min:
            continue
        for i, line in nlines:
            if str(v) in line and ("[[%s]]" % k) not in line:
                out.append("正文第 %d 行出现裸数字 %s（属于 `%s`）⇒ 改写成 [[%s]]" % (i, v, k, k))
    return out


def problems(ledger, doc_text, bare_min=None):
    """返回问题清单（纯函数：自证要用）。空列表 = 通过。

    `bare_min` 覆盖裸数字阈值（自证显式传）；默认读 `REFLECT_NAKED_MIN`。
    """
    bm = _bare_min() if bare_min is None else bare_min
    f = facts_of(ledger)
    if not f:
        # 零值守卫：台账空着不是「没有违规」，是「什么都没量」。
        return ["台账为空 —— 空不是通过（零值守卫）：先查 measure_example() 是不是坏了"]
    if BLOCK_BEGIN not in doc_text or BLOCK_END not in doc_text:
        return ["文档里没有 %s / %s 标记 —— 找不到块 ≠ 块是对的（零值守卫）"
                % (BLOCK_BEGIN, BLOCK_END)]

    out = []
    if body_of(doc_text).strip() != body_of(render_block(ledger)).strip():
        out.append("文档里的块与台账不一致 ⇒ 跑 `python3 zreflect/facts.py --render-doc`")

    out += _cite_problems(prose_of(doc_text), f)

    nlines = _number_lines(doc_text)
    out += _copied_fact_problems(f, nlines, bm)
    # 反向判据（issue #24）：从没进过台账的数字也要有出处。
    out += _unaccounted_numbers(doc_text, f, bm, nlines)
    return out


def run(argv):
    doc = argv[0] if argv else os.environ.get("REFLECT_DOC", "STATE.md")
    p = doc if os.path.isabs(doc) else repo(doc)
    if not os.path.exists(p):
        return fatal("文档不存在：%s —— 找不到文件不许算通过（零值守卫）" % p)
    facts_name = os.environ.get("REFLECT_FACTS", "FACTS.json")
    led_path = repo(facts_name)
    if not os.path.exists(led_path):
        return fatal("缺事实台账（%s）。先跑 python3 zreflect/facts.py 量一遍。" % facts_name)
    led = load(led_path)
    probs = problems(led, open(p, encoding="utf-8").read())
    return finish("事实闸门", probs,
                  "事实闸门：OK（%d 条事实，块一致、无裸数字、无坏引用）" % len(facts_of(led)))


LED = {"facts": {"count": {"value": 4752, "cmd": "c"}}}


def _cases():
    good = "这里没有裸数字。\n" + render_block(LED)
    return [
        # ① 正常不报
        ("块一致 + 无裸数字 ⇒ 不报", lambda: problems(LED, good) == []),
        ("正文引用存在的键 ⇒ 不报",
         lambda: problems(LED, "见 [[count]]\n" + render_block(LED)) == []),
        ("小整数（< 100）不算裸数字", lambda: problems(
            {"facts": {"n": {"value": 3, "cmd": "c"}}}, "有 3 个\n" + render_block({"facts": {"n": {"value": 3, "cmd": "c"}}})) == []),
        # ② 该报的必须报
        ("★ 块与台账不一致 ⇒ 必须报",
         lambda: any("不一致" in x for x in problems(LED, "x\n" + render_block({"facts": {}})))),
        ("★ 正文裸数字 ⇒ 必须报",
         lambda: any("裸数字" in x for x in problems(LED, "速度是 4752 次\n" + render_block(LED)))),
        ("★ 引用不存在的键 ⇒ 必须报",
         lambda: any("不存在" in x for x in problems(LED, "见 [[nope]]\n" + render_block(LED)))),
        # ② 反向判据（issue #24）：从没进过台账的数字也要有出处
        ("★ 正文出现从未进过台账的数字 ⇒ 必须报（issue #24）",
         lambda: any("无出处" in x and "99887766" in x for x in problems(
             LED, "新量了 99887766 但没进台账。\n" + render_block(LED)))),
        ("数字紧跟 [[键名]] ⇒ 视为引用式出处，不报",
         lambda: problems(LED, "见 [[count]] = 99887766\n" + render_block(LED)) == []),
        ("版本串/标识符/日期等形状 ⇒ 白名单放行（否则闸门被误报淹没）",
         lambda: problems(LED, "v11.3.0 与 sha256 与 2026-10-31\n"
                          + render_block(LED)) == []),
        ("★ 裸 sha 只在有 sha 上下文时放行（无上下文的 8 位数是测量值）",
         lambda: any("无出处" in x for x in problems(
             LED, "随便写的 99887766\n" + render_block(LED)))),
        # ③ 空输入必须报
        ("★ 空台账 ⇒ 必须报（空不是通过）", lambda: problems({"facts": {}}, good) != []),
        ("★ 文档没有块标记 ⇒ 必须报", lambda: problems(LED, "完全没有块的文档") != []),
        # ④ 裸数字判据扩展（issue #3 ④）
        ("围栏代码块内的裸数字 ⇒ 豁免（复跑命令天然带数字）",
         lambda: problems(LED, "```\n速度是 4752 次\n```\n" + render_block(LED)) == []),
        ("行内代码里的裸数字 ⇒ 豁免",
         lambda: problems(LED, "见 `4752` 次\n" + render_block(LED)) == []),
        ("阈值默认 100：小于它的值不算裸数字 ⇒ 不报",
         lambda: problems({"facts": {"n": {"value": 50, "cmd": "c"}}},
                          "有 50 只\n" + render_block(
                              {"facts": {"n": {"value": 50, "cmd": "c"}}})) == []),
        ("★ 阈值可配：bare_min=10 时 50 必须报（该报的必须报）",
         lambda: any("裸数字" in x for x in problems(
             {"facts": {"n": {"value": 50, "cmd": "c"}}},
             "有 50 只\n" + render_block({"facts": {"n": {"value": 50, "cmd": "c"}}}),
             bare_min=10))),
        ("★ 围栏外同行仍必须报（豁免只罩代码，不罩断言）",
         lambda: any("裸数字" in x for x in problems(
             LED, "```\n4752\n```\n速度是 4752 次\n" + render_block(LED)))),
    ]


GATE = meta("事实闸门", "块一致性 / 裸数字 / 坏引用",
            knobs=("REFLECT_FACTS", "REFLECT_DOC", "REFLECT_NAKED_MIN"), name_dependent=True)

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], "check_facts（块一致性 / 裸数字 / 坏引用）",
                              _cases, run))
