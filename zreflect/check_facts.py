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

from gate import fatal, finish, main_selftest_or, meta, repo, selftest  # noqa: E402
from ledger import facts_of, load, value_of              # noqa: E402
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


def problems(ledger, doc_text, bare_min=None):
    """返回问题清单（纯函数：自证要用）。空列表 = 通过。

    `bare_min` 覆盖裸数字阈值（自证显式传）；默认读 `REFLECT_NAKED_MIN`。
    """
    out = []
    bm = _bare_min() if bare_min is None else bare_min
    f = facts_of(ledger)
    if not f:
        # 零值守卫：台账空着不是「没有违规」，是「什么都没量」。
        return ["台账为空 —— 空不是通过（零值守卫）：先查 measure_example() 是不是坏了"]
    if BLOCK_BEGIN not in doc_text or BLOCK_END not in doc_text:
        return ["文档里没有 %s / %s 标记 —— 找不到块 ≠ 块是对的（零值守卫）"
                % (BLOCK_BEGIN, BLOCK_END)]

    if body_of(doc_text).strip() != body_of(render_block(ledger)).strip():
        out.append("文档里的块与台账不一致 ⇒ 跑 `python3 zreflect/facts.py --render-doc`")

    prose = prose_of(doc_text)
    for i, line in enumerate(prose.splitlines(), 1):
        for k in CITE_RE.findall(line):
            if k not in f:
                out.append("正文第 %d 行引用了**不存在**的键：`%s`" % (i, k))

    nlines = _number_lines(doc_text)
    for k, entry in sorted(f.items()):
        v = value_of(entry)
        if isinstance(v, bool) or not isinstance(v, int) or v < bm:
            continue
        for i, line in nlines:
            if str(v) in line and ("[[%s]]" % k) not in line:
                out.append("正文第 %d 行出现裸数字 %s（属于 `%s`）⇒ 改写成 [[%s]]" % (i, v, k, k))
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
