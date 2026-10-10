#!/usr/bin/env python3
"""台账写盘守卫：掉条 / 改口 / 逐条接受 —— 重测的两个静默坏法在这里被拦。

  · **掉条** —— 输入不在 ⇒ 事实静默**消失**；
  · **改口** —— 输入变了、或量错了 ⇒ 事实静默**变成另一个数**。若闸门只对
    少数几个 sha 回盘核对，其余条目的旧值一旦被覆盖，**再也查不到它变过**。

它从 facts.py 的 measure() 里独立出来（Phase 4）：守卫的**纯函数**
（`dropped_keys` / `changed_keys`，在 ledger.py）一直有自证，但它们的
**接线路径**（FATAL 措辞、退出码、放行后的明说）此前没有自测 —— 本仓踩过
的教训：一条守卫因一个未定义变量从落地起从未生效过，失效方式是「只在真的
该报警时才崩」（AGENTS.md 硬坑表）。**接线是守卫的一半，必须有自证。**

interface（决策与执行分离 —— 决策可自证，执行归 measure()）：

    decide(old_facts, new_facts, accepted=False, allow_drop=False)
        -> (verdict, problems, notes)

  · verdict = "write" | "refuse"；
  · problems = refuse 时的人话（measure 加 FATAL 前缀打 stderr）；
  · notes = {"err": [...], "out": [...]} —— 放行时必须**明说**放行了什么
    （--allow-drop 的掉条走 stderr，--accept-changes 的改口走 stdout，
    保持既有输出流）。

改口守卫只比 `value`，不比 cmd / source / note（那是「复跑方式」的描述，
改它们是文档维护的正常动作 —— 否则守卫变噪音，最后被一律糊过去，守卫就废了）。
逐条接受（issue #3 ①）：`--accept-changes` 裸旗全收、`=k1,k2` 只收列出的、
空集一条不收 —— 全收会把真坏了的测量一起洗白。
"""
from __future__ import annotations

from ledger import changed_keys, dropped_keys, short_value
from gate import module_meta


def accepted_keys(argv):
    """解析 `--accept-changes[=k1,k2]`（issue #3 ①）：裸旗 ⇒ None（全收）；
    列键 ⇒ 集合（空串 ⇒ 空集 = 一个都不收）；没传 ⇒ False（全拒，同旧行为）。"""
    for a in argv or []:
        if a == "--accept-changes":
            return None
        if a.startswith("--accept-changes="):
            raw = a.split("=", 1)[1].strip()
            return {k.strip() for k in raw.split(",") if k.strip()}
    return False


def filter_accepted(changed, accepted):
    """改口清单里**还没被接受**的部分（纯函数：自证要用）。

    `accepted=None` ⇒ 全收；`False` ⇒ 全拒；集合 ⇒ 只留未列出的键。
    """
    if accepted is None:
        return []
    if accepted is False:
        return list(changed or [])
    return [c for c in (changed or []) if c[0] not in accepted]


def decide(old_facts, new_facts, accepted=False, allow_drop=False):
    """重测写盘的**决策**（纯函数：自证要用，不许 print）。"""
    problems, notes = [], {"err": [], "out": []}

    # 守卫一：掉条（键没了）
    dropped = dropped_keys(old_facts, new_facts)
    if dropped and not allow_drop:
        problems.append("本次会从台账里**掉掉 %d 条事实**（输入不在？）：%s"
                        % (len(dropped), ", ".join(dropped)))
        problems.append("台账不写。要么把输入准备好，要么显式 --allow-drop"
                        "（并把掉掉的键记进 HISTORY）。")
        return "refuse", problems, notes
    if dropped:
        notes["err"].append("⚠ --allow-drop：本次掉掉 %d 条：%s"
                            % (len(dropped), ", ".join(dropped)))

    # 守卫二：改口（值换了）
    changed = changed_keys(old_facts, new_facts)
    remaining = filter_accepted(changed, accepted)
    if remaining:
        problems.append("本次重测会**改掉 %d 条事实的值**（未经接受的改口）："
                        % len(remaining))
        for k, o, n in remaining:
            problems.append("%-24s %s → %s" % (k, short_value(o), short_value(n)))
        if accepted:
            problems.append("已按 --accept-changes 接受 %d 条：%s —— 其余仍拒绝。"
                            % (len(changed) - len(remaining),
                               ", ".join(sorted(accepted))))
        problems.append("台账不写。逐条确认这些变化**是实测出来的**（不是输入不在"
                        "/量错了）之后，再显式 --accept-changes"
                        "（或 --accept-changes=k1,k2 逐条放行）。")
        return "refuse", problems, notes
    if changed:
        notes["out"].append("⚠ --accept-changes：本次接受 %d 条改口：" % len(changed))
        for k, o, n in changed:
            notes["out"].append("%-24s %s → %s" % (k, short_value(o), short_value(n)))

    # 零值守卫：一条都没量到 ⇒ 不是「没有改口」，是什么都没量。
    if not new_facts:
        problems.append("一条事实都没量到。空台账不是通过（零值守卫）。")
        return "refuse", problems, notes
    return "write", problems, notes


def _cases():
    old = {"a": {"value": 1}, "b": {"value": 2}}
    same = {"a": {"value": 1}, "b": {"value": 2}}
    new_val = {"a": {"value": 1}, "b": {"value": 9}}
    dropped = {"a": {"value": 1}}          # b 掉了
    return [
        # ① 正常不报
        ("无掉条无改口 ⇒ write、无 problems、无 notes",
         lambda: decide(old, same) == ("write", [], {"err": [], "out": []})),
        ("新增键不算改口 ⇒ write（那是新增，不该被拦）",
         lambda: decide(old, dict(same, c={"value": 3}))[0] == "write"),
        ("只改 cmd 不算改口（复跑方式的描述，改它是正常维护）",
         lambda: decide({"a": {"value": 1, "cmd": "旧"}},
                        {"a": {"value": 1, "cmd": "新"}})[0] == "write"),
        # ② 该报的必须报
        ("★ 掉条且未放行 ⇒ refuse，点名掉掉的键",
         lambda: (lambda v, p, n: v == "refuse" and any("b" in x for x in p)
                  )(*decide(old, dropped))),
        ("★ 掉条 + --allow-drop ⇒ write，且明说掉了什么（放行不许静默）",
         lambda: (lambda v, p, n: v == "write" and any("allow-drop" in x and "b" in x
                                                       for x in n["err"])
                  )(*decide(old, dropped, allow_drop=True))),
        ("★ 改口未接受 ⇒ refuse，带旧值→新值",
         lambda: (lambda v, p, n: v == "refuse" and any("2" in x and "9" in x
                                                        for x in p)
                  )(*decide(old, new_val))),
        ("★ 改口逐条接受：列出的放行 ⇒ write 且明说接受了什么",
         lambda: (lambda v, p, n: v == "write" and any("accept-changes" in x
                                                        for x in n["out"])
                  )(*decide(old, new_val, accepted={"b"}))),
        ("★ 改口逐条接受：未列出的必须仍拒（该报的必须报）",
         lambda: decide(old, new_val, accepted={"zzz"})[0] == "refuse"),
        ("★ 逐条接受时拒绝信息要点名已接受与仍拒绝的边界",
         lambda: any("其余仍拒绝" in x for x in decide(
             old, {"a": {"value": 8}, "b": {"value": 9}},
             accepted={"a"})[1])),
        ("★ 裸旗全收 ⇒ write", lambda: decide(old, new_val, accepted=None)[0] == "write"),
        # 接线解析（issue #3 ① 的解析语义搬进守卫的自证面）
        ("解析：--accept-changes 裸旗 ⇒ None（全收）",
         lambda: accepted_keys(["--accept-changes"]) is None),
        ("解析：=k1,k2 ⇒ 键集",
         lambda: accepted_keys(["--accept-changes=a,b"]) == {"a", "b"}),
        ("解析：没传旗 ⇒ False（全拒，同旧行为）",
         lambda: accepted_keys([]) is False),
        ("解析：=空串 ⇒ 空集（一个都不收）",
         lambda: accepted_keys(["--accept-changes="]) == set()),
        # ③ 空输入必须报
        ("★ 新事实为空 ⇒ refuse（零值守卫：空不是通过）",
         lambda: decide(old, {})[0] == "refuse"),
        ("★ 空接受集 ⇒ 一条都不收（空输入不是通过）",
         lambda: decide(old, new_val, accepted=set())[0] == "refuse"),
    ]


MODULE = module_meta("台账写盘守卫", "掉条 / 改口 / 逐条接受（决策与执行分离）", selftest=True)


if __name__ == "__main__":
    import os                                            # noqa: PLC0415
    import sys                                           # noqa: PLC0415
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from gate import module_meta, main_selftest_or                    # noqa: PLC0415

    def _run(argv):
        print("guard 是模块（被 facts.measure 调用）；不单独跑。--selftest 看自证。",
              file=sys.stderr)
        return 2
    sys.exit(main_selftest_or(sys.argv[1:],
                              "guard（台账写盘守卫：掉条 / 改口 / 逐条接受的接线）",
                              _cases, _run))
