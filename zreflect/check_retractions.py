#!/usr/bin/env python3
"""翻案闸门：**已被推翻的断言不许悄悄回来当现状。**

`retractions.json` 每条 = 一条已翻案的断言：
  `text` 特征片段 · `why` 为什么错 · `evidence` 怎么复跑 · `fixed_in` 现在哪里说对了

判据：活状态文档里出现 `text` 的那一行**必须带更正标记**。这是唯一能在「翻过的句子
重新出现」时报警的机制 —— 实测过的代价：一条更正过的断言在**同一个文件**里留了下来，
而且在另一份文档里还有副本。散文靠自觉，这个靠闸门。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import knobs  # noqa: E402
from gate import fatal, finish, guard_nonempty, main_selftest_or, meta, repo  # noqa: E402
from i18n import M  # noqa: E402
from ledger import load_or_fatal  # noqa: E402
from living import HIST_MARK, living_lines  # noqa: E402

REQUIRED = ("id", "text", "why", "evidence", "fixed_in")
# **不在模块级取值**：`knobs.docs_names()` 是唯一产地（登记表里的默认值）。
# ⚠️ 曾在这里手写一份五份的字面量，与登记表的六份（多 PRINCIPLES.md）漂开了。
HIST_SECS = tuple(s for s in os.environ.get("REFLECT_HISTORY_SECS", "").split(",") if s)


def _entry_field_problems(retractions):
    """每条翻案条目的必填字段（缺一个 ⇒ 这条台账不可信）。"""
    return [M("retractions.entry_missing_field", field=fld, entry=r.get("id"))
            for r in retractions
            for fld in REQUIRED if not r.get(fld)]


def _resurfaced_problems(retractions, docs, hist):
    """重现行：活状态里出现 `text` 的那一行**必须带更正标记**。"""
    out = []
    for r in retractions:
        text = r.get("text") or ""
        if not text:
            continue
        for name, body in sorted(docs.items()):
            for i, line, is_living in living_lines(body or "", hist):
                if is_living and text in line and not HIST_MARK.search(line):
                    out.append(M("retractions.resurfaced", name=name, line=i,
                                 text=text, entry=r.get("id", "?")))
    return out


def problems(retractions, docs, hist_secs=None):
    """返回问题清单（纯函数：自证要用）。`docs` = {文件名: 正文}。

    只扫**活状态**（`zreflect/living.py` 的判定）：append-only 的历史章节用
    `REFLECT_HISTORY_SECS` 声明后豁免 —— 那里的"当时如此"不是"现在如此"，
    拿它跟现状比只会逼人毁掉记录。历史章节里的重现行**仍然要带标记**吗？
    不用 —— 历史章节天然就是"当时"的记录；这个豁免正是从 Octave 迁来的纪律。

    两条规则各是一个具名 helper（字段完整性 / 重现行）：它们扫的是不同的
    东西（台账自身 vs 文档），拼在一起只是让调用点看起来短。
    """
    hist = HIST_SECS if hist_secs is None else hist_secs
    if retractions is None or "retractions" not in (retractions or {}):
        # 零值守卫：结构都不对，就别谈「没有违规」。
        return [M("retractions.missing_key")]
    if not docs:
        # 零值守卫：一份文档都没扫到 ⇒ 「没发现重现行」是空话。
        return [M("retractions.no_docs")]
    entries = [r for r in (retractions.get("retractions") or [])
               if isinstance(r, dict)]
    return _entry_field_problems(entries) + _resurfaced_problems(
        [r for r in entries if isinstance(r, dict)], docs, hist)


def scanned_docs():
    """本闸门要扫的文档名单（`knobs.docs_names()`，唯一产地）。"""
    return knobs.docs_names()


def run(argv):
    # 名字可配（issue #1 ②）：不写死，换仓库只改环境变量
    rp = repo(os.environ.get("REFLECT_RETRACTIONS", "retractions.json"))
    if not os.path.exists(rp):
        return fatal(M("retractions.file_missing", name=rp))
    docs = {}
    for name in (argv or scanned_docs()):
        p = repo(name)
        if os.path.exists(p):
            docs[name] = open(p, encoding="utf-8", errors="replace").read()
    rc = guard_nonempty("check_retractions", docs, M("retractions.scanned_docs"))
    if rc:
        return rc
    led = load_or_fatal(rp)
    probs = problems(led, docs)
    n = len(led.get("retractions") or [])
    return finish(M("retractions.title"), probs,
                  M("retractions.ok", count=n, documents=len(docs)))


def _cases():
    ok_r = {"retractions": [{"id": "R-1", "text": "this thing is green",
                             "why": "actually red", "evidence": "run x",
                             "fixed_in": "doc y"}]}
    doc_ok = "(record) this thing is green — retracted, see R-1\n"
    return [
        # ① 正常不报
        ("retractions.marked",
         lambda: problems(ok_r, {"A.md": doc_ok}) == []),
        ("retractions.assertion_absent",
         lambda: problems(ok_r, {"A.md": "clean document\n"}) == []),
        ("retractions.no_retractions",
         lambda: problems({"retractions": []}, {"A.md": "x\n"}) == []),
        ("retractions.declared_history_section",
         lambda: problems(ok_r, {"A.md": "## 5 history\nthis thing is green.\n"},
                          hist_secs=("5",)) == []),
        # ② 该报的必须报
        ("★ retractions.resurfaced",
         lambda: [p.code for p in problems(
             ok_r, {"A.md": "this thing is green.\n"})] == ["retractions.resurfaced"]),
        ("★ retractions.resurfaced_undeclared_history",
         lambda: [p.code for p in problems(
             ok_r, {"A.md": "## 5 history\nthis thing is green.\n"}, hist_secs=())]
         == ["retractions.resurfaced"]),
        ("★ retractions.entry_missing_field",
         lambda: [p.code for p in problems(
             {"retractions": [{"id": "R-2", "text": "t", "why": "w", "fixed_in": "f"}]},
             {"A.md": "x\n"})] == ["retractions.entry_missing_field"]),
        # ③ 空输入必须报
        ("★ retractions.no_docs",
         lambda: [p.code for p in problems(ok_r, {})] == ["retractions.no_docs"]),
        ("★ retractions.missing_key",
         lambda: [p.code for p in problems({}, {"A.md": "x\n"})]
         == ["retractions.missing_key"]),
        ("★ retractions.missing_key_none",
         lambda: [p.code for p in problems(None, {"A.md": "x\n"})]
         == ["retractions.missing_key"]),
    ]


GATE = meta("翻案重现检测", "被推翻的断言不许悄悄回来当现状",
            knobs=("REFLECT_RETRACTIONS", "REFLECT_DOCS", "REFLECT_HISTORY_SECS"), name_dependent=True)

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], "check_retractions", _cases, run))
