#!/usr/bin/env python3
"""把台账渲染成文档里的机器块 —— **数字的唯一产地**。

生成器（`facts.py`）与闸门（`check_facts.py`）必须共用这一个函数，
否则「块对不对」两边口径会分叉：生成器改了排版，闸门还按旧排版比，于是永远不一致
（或者更糟：两边都改成了宽松匹配，于是永远「一致」）。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gate import module_meta  # noqa: E402
from i18n import M  # noqa: E402

BLOCK_BEGIN = "<!-- AUTO:FACTS -->"
BLOCK_END = "<!-- /AUTO:FACTS -->"

# PINNED: AUTO 机器块固定语言（不随 REFLECT_LANG 变）——
# 它写进 STATE.md 并被 `facts.py --check` 逐字节对账；跟随语言会让
# 「同一提交在不同环境结果不同」（不收敛）。check_i18n 扫 `PINNED:` 标记，
# **不认名字**（名字承重 = 名录会漂）。
PREAMBLE = [
    ("> 本区块由 `zreflect/facts.py --render-doc` 从 `FACTS.json` 渲染，**不要手改**"
    "（pre-commit 会重算并 `git add`）。"),
    "> 正文里的「测出来的数字」只在这里生产：要引用就写 `[[键名]]`，不要手抄数字。",
]


def _fmt(v):
    if isinstance(v, str) and len(v) == 64:
        return "`%s…`" % v[:16]
    return "**%s**" % (v if isinstance(v, str) else str(v))


def render_block(ledger):
    """台账 → 机器块（含首尾标记）。**纯函数**：同一份台账渲染两次逐字节相同。

    PINNED: AUTO 机器块固定语言（见 PREAMBLE 上的说明）。
    """
    from ledger import facts_of  # noqa: PLC0415

    f = facts_of(ledger)
    lines = [BLOCK_BEGIN] + list(PREAMBLE) + [""]
    if not f:
        # 零值守卫：**空台账必须明写「为空」**，不许渲染成一张安静的空表 ——
        # 空表看起来像「一切正常」，而事实是「一条都没量到」。
        lines += ["**台账为空** —— 一条事实都没有。空不是「通过」：先查 measure() 是不是坏了。", ""]
    else:
        # 「测于」列 = 台账里的 measured_at（采集时刻的记录，纯函数输入 ——
        # 不渲染「几天前」：那会随墙上时钟变，--check 永不收敛。issue #3 ②）
        lines += ["| 键 | 值 | 测于 | 复跑命令 |", "|---|---|---|---|"]
        for k in sorted(f):
            e = f[k] if isinstance(f[k], dict) else {"value": f[k]}
            lines.append("| `%s` | %s | %s | `%s` |"
                         % (k, _fmt(e.get("value")), e.get("measured_at", "—"),
                            e.get("cmd", "?")))
        lines += ["", "%d 条事实。" % len(f)]
    lines.append(BLOCK_END)
    return "\n".join(lines)


def body_of(block):
    """取块内的正文（两端标记之间），供「块与台账一致」的比较用。"""
    if BLOCK_BEGIN not in block:
        return ""
    return block.split(BLOCK_BEGIN, 1)[1].split(BLOCK_END, 1)[0]


def prose_of(doc_text):
    """文档里**块以外**的正文（裸数字要在这里面查）。

    #14：剥**全部** `<!-- AUTO:… -->…<!-- /AUTO:… -->` 区域，不是只剥事实块
    那一对 —— Phase 3 起文档有两个机器块（FACTS + GATES），只剥 FACTS 会让
    闸门名录整块进入裸数字扫描（名录里的 `sha256` 被切成 256，与台账里值恰
    为 256 的事实撞车 ⇒ 假红；两个下游独立撞到，上游只因示例台账没有 256
    而幸免 —— 机制上必炸的偶发）。
    """
    out, i = [], 0
    while True:
        b = doc_text.find("<!-- AUTO:", i)
        if b < 0:
            out.append(doc_text[i:])
            break
        out.append(doc_text[i:b])
        e = doc_text.find("-->", b + len("<!-- AUTO:"))
        end = doc_text.find("<!-- /AUTO:", e) if e >= 0 else -1
        if end < 0:                  # 有头无尾：当没有块（标记检查另有零值守卫）
            out.append(doc_text[b:])
            break
        close = doc_text.find("-->", end)
        i = close + 3 if close >= 0 else len(doc_text)
    return "".join(out)


# ── 自证 ──────────────────────────────────────────────────────────────────────
def _extra_lines(block):
    """块正文里除 `PREAMBLE` 与空行以外的行（PINNED 样板之外的「说了什么」）。"""
    return [ln for ln in body_of(block).splitlines()
            if ln.strip() and ln not in PREAMBLE]


def _cases():
    full = {"facts": {"a": 4752, "s": {"value": "b" * 64, "cmd": "c"}}}
    # 表头取自**渲染输出本身**（不手抄 PINNED 文本 —— 抄一份就多一处会漂的产地）
    header = next(ln for ln in body_of(render_block(full)).splitlines()
                  if ln.startswith("|"))
    return [
        # ① 正常不报
        ("render.keys_in_block",
         lambda: all(k in render_block(full) for k in ("a", "s"))),
        ("render.raw_value", lambda: "**4752**" in render_block(full)),
        ("render.sha_truncated", lambda: "`" + "b" * 16 + "…`" in render_block(full)),
        ("render.block_pure",
         lambda: render_block(full) == render_block(full)),
        ("render.prose_only_outside_block",
         lambda: (lambda d: ("body" in prose_of(d) and "tail" in prose_of(d)
                             and header not in prose_of(d) and header in d))(
             "body\n" + render_block(full) + "\ntail")),
        ("render.prose_fallback_whole_doc",
         lambda: prose_of("a document without markers") == "a document without markers"),
        # #14：双机器块文档，GATES 块也必须剥掉（否则名录里的 sha256 被当裸数字）
        ("render.prose_strips_all_blocks",
         lambda: (lambda d: ("sha256" not in prose_of(d)
                             and "GATES_TABLE" not in prose_of(d)
                             and "body" in prose_of(d) and "tail" in prose_of(d)))(
             "body\n<!-- AUTO:FACTS -->\nFACTS_TABLE\n<!-- /AUTO:FACTS -->\n"
             "<!-- AUTO:GATES -->\n| x | sha256 |\n<!-- /AUTO:GATES -->\ntail")),
        ("render.prose_nested_begin_literal",
         lambda: (lambda d: "awk" not in prose_of(d) and "tail" in prose_of(d))(
             "head\n<!-- AUTO:FACTS -->\ncmd: awk '<!-- AUTO:FACTS -->'\n"
             "<!-- /AUTO:FACTS -->\ntail")),
        # ② 该报的必须报（渲染层的「该报」= 必须发生变化，不许是常量）
        ("★ render.block_not_constant",
         lambda: render_block(full) != render_block({"facts": {"a": 4752}})),
        # ③ 空输入必须报
        ("★ render.empty_ledger_says_so",
         # 空台账必须**额外写了一句话**（PREAMBLE 之外的行非空），且**不许**渲染出表。
         lambda: (lambda b: _extra_lines(b) != []
                  and not any(ln.lstrip().startswith("|")
                              for ln in body_of(b).splitlines()))(
             render_block({"facts": {}}))),
        ("★ render.empty_differs_from_full",
         lambda: render_block({"facts": {}}) != render_block(full)),
    ]


def _selftest():
    import os  # noqa: PLC0415
    import sys  # noqa: PLC0415
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from gate import activate_or_fatal, selftest  # noqa: PLC0415
    # 激活**先于**自证：包设了却不在 ⇒ FATAL rc 2（此前这条入口从不激活，
    # `REFLECT_LANG=de render.py --selftest` 对不存在的包静默 rc=0）。
    rc = activate_or_fatal()
    if rc:
        return rc
    return selftest(M("gate.title.render"), _cases())


MODULE = module_meta("机器块渲染", "数字的唯一产地（纯函数）", selftest=True)


if __name__ == "__main__":
    import os  # noqa: PLC0415
    import sys  # noqa: PLC0415
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    sys.exit(_selftest())
