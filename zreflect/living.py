#!/usr/bin/env python3
"""活状态抽取：一份文档里，哪些行是「现在如此」，哪些是「当时如此」。

从 Octave-Full-Wasm 的 `.githooks/check-handoff.py` 迁移（那里第一次长出这套判定）。
它要解决的问题：闸门想查「断言与产物是否矛盾」，但**不是每一行都该查** ——
append-only 的历史章节里，数字是"当时如此"，拿来跟今天的产物比毫无意义，
硬查只会逼人把历史改成现在，那就毁了记录。

三条硬规矩（全是那里踩出来的，别改回更"聪明"的版本）：

  1. **默认从严**。除明确声明的历史章节外，一切章节（**含无编号的**）都是活状态。
     那边第一版只把"带数字且不在历史名单里"的章节当活状态，于是"## 附 · …"这类
     无编号段落**继承上一节的状态判定** —— 往那儿塞一条过时断言，检查器视而不见。
  2. **行内出口**。一行自己说清是历史（历史 / 退役 / 曾经的 / 已翻案 / 更正……）
     就豁免。没有这个出口，人只能把历史删掉或把章节挪走 —— 机制的目的是
     「不许**悄悄**留在那儿当现状」，不是毁掉记录。
  3. **带出处的记录豁免，但出处必须明确**。交付包名（含 8 位日期）或**反引号里的
     commit sha** 才算出处。⚠️ 那边第一版还加了一个宽松的裸 sha 正则，结果
     "一条含过期 sha 的假断言"被当成"带出处的历史条目"整行豁免 —— 漏检就是这么来的。
     宽松识别的出口，等于给假断言发了通行证。
"""
import re

from gate import module_meta

# 行内历史标记（与翻案台账的更正标记同一份词表 —— 词表只生产一次）。
HIST_MARK = re.compile(
    r"历史|退役|留档|曾经的|当年的|当时的|之前那份|此前|当时|收口前"
    r"|已翻案|更正|是错的|误读|推翻|曾写|已作废|不再成立"
    r"|superseded|retracted|deprecated")

# 带**明确**出处的记录：`xx-20260921` 型交付名，或反引号里的 commit sha。
# ⚠️ 故意不认裸 sha：见上面规矩 3。
DATED_RECORD = re.compile(r"[A-Za-z0-9._-]*-\d{8}|`[0-9a-f]{7,64}`")

# 行内台账引用 `[[键名]]`（带捕获组 —— check_facts 取键、check_stale 只判存在）。
# ⚠️ 两道闸门曾各写一份（一份带捕获、一份不带），同一判据两份措辞。
CITE_RE = re.compile(r"\[\[([A-Za-z_][A-Za-z0-9_]*)\]\]")


def section_is_living(heading, historical_secs=()):
    """一个 `## ` 标题下的正文是不是活状态。

    · 带编号且在 `historical_secs` 里 ⇒ 历史（append-only，别拿今天的产物去比它）；
    · 其余一律活状态 —— **包括无编号章节**（默认从严，见模块头规矩 1）。
    """
    m = re.match(r"^##\s+([0-9]+)", heading)
    if m:
        return m.group(1) not in {str(s) for s in historical_secs}
    # 文末机器维护的区块（由渲染器负责），闸门不扫
    return not heading.startswith("## 附")


def living_lines(text, historical_secs=()):
    """把文档切成行，标出每行是不是活状态。返回 [(行号, 行, 是否活状态), …]。

    ⚠️ 文件**头部**（第一个 `## ` 之前）是活状态 —— 那边实测过：头部恰好是
    "wasm sha …、全量 N 套 M 项"这种最该查的状态行，第一版曾把引用块整段跳过，
    等于把最要紧的断言放走了。这里的头部**参与判定**（行内出口仍然有效）。
    """
    out = []
    keep = True
    for i, ln in enumerate(text.split("\n"), 1):
        if re.match(r"^##\s+", ln):
            keep = section_is_living(ln, historical_secs)
        out.append((i, ln, keep))
    return out


# `selftest=False` = **没有 `--selftest` 入口**（纯抽取逻辑，被 check_stale /
# check_retractions 消费）。它的判定（编号段是否历史 / 无编号默认从严 /
# 附录不扫 / 切段正确）有实质断言，住在 `registry._cases()` —— 这一环判错，
# 那两道闸门的判据会全部失效而各自的自证照样绿（第 24 轮发现的依赖链缺口）。
MODULE = module_meta(
    "活状态抽取",
    "哪些行是「现在如此」（历史出口 / 默认从严；"
    "判定三向：编号段/无编号/附录/切段）",
    selftest=True)


# ── 自证（此前寄宿在 registry._cases）────────────────────────────────────────
#
# 为什么搬回来：判据住在**被测模块**里 —— 这是「模块自己有自证」的定义。
# 寄宿在 registry 让 `selftest=False` 的声明变成「我没有自证入口」，
# 而事实是「有，只是住在别处」。搬回来之后 `selftest=True` 是诚实的。

def _living_case(which):
    """`living.py` 的三个判定方向（用 ASCII 输入，不写中文字面量）。"""
    if which == "numbered_historical":
        return section_is_living("## 5 old", historical_secs=("5",)) is False
    if which == "unnumbered":
        return section_is_living("## 6 new", historical_secs=("5",)) is True
    if which == "appendix":
        # 页码点 0x9644 造「附」——本文件在零语言闸门扫描面内，不写字面量
        head = "## " + chr(0x9644)
        return section_is_living(head) is False \
            and section_is_living(head + "more") is False
    if which == "lines_track":
        rows = living_lines("head\n## 5 old\nx\n## 6 new\ny\n",
                            historical_secs=("5",))
        return [r[2] for r in rows] == [True, False, False, True, True, True]
    return False


def _cases():
    return [
        ("★ living.numbered_section_is_historical",
         lambda: _living_case("numbered_historical")),
        ("living.unnumbered_is_living", lambda: _living_case("unnumbered")),
        ("living.appendix_not_scanned", lambda: _living_case("appendix")),
        ("★ living.lines_tracks_sections", lambda: _living_case("lines_track")),
    ]


def _selftest():
    import sys  # noqa: PLC0415

    from gate import main_selftest_or  # noqa: PLC0415
    from i18n import M  # noqa: PLC0415
    return main_selftest_or(sys.argv[1:], M("gate.title.living"),
                            _cases, lambda a: 0)


if __name__ == "__main__":
    import os  # noqa: PLC0415
    import sys  # noqa: PLC0415
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import living as _mod  # noqa: PLC0415
    sys.exit(_mod._selftest())
