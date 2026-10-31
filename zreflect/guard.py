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

import os

from gate import GATE_REPO
from ledger import changed_keys, dropped_keys, short_value


def _gitignored(path):
    """路径是否被 .gitignore 覆盖；非 git 仓库 / git 不在 ⇒ None（无法判断，不猜）。"""
    import subprocess                                    # noqa: PLC0415
    try:
        r = subprocess.run(["git", "-C", GATE_REPO, "check-ignore", "-q", path],
                           capture_output=True)
    except OSError:
        return None
    if r.returncode == 0:
        return True
    if r.returncode == 1:
        return False
    return None                     # rc=128 等：不是仓库 / git 坏了


def write_target_problems(path, knob_set, ignored=None, carrier_exists=None):
    """**盲写守卫**（issue #20 ②）：写盘前查目标。返回 (fatal 句, warn 句)。

    两个产地的病：`Einfacht.env` 只在钩子语境被 source（issue #8），手工
    裸跑时**代码默认值**接管 —— 若默认路径恰好被 .gitignore 覆盖，写盘
    「成功」且没有任何东西会响（下游实测：重测一直「成功」，pre-commit
    读的是另一份台账，排查 40 分钟 —— 写进被 ignore 的位置等于没写）。

    · 目标被 gitignore 覆盖 ⇒ **FATAL**（版本控制看不见它、钩子永远读
      旧台账）—— 与语境无关，永远该查（C3 纪律：判据的家不随语境移动）；
    · `ignored=None`（非 git 仓库 / git 不在，无法判断）⇒ 放行并明说一行
      （夹具场景大量是非 git 目录，不拦，但不静默）；
    · 仓里有 Einfacht.env 载体而本次进程没设旋钮 ⇒ **warn**：载体在、
      这次跑没用它 —— 两个产地此刻分叉，写盘目标可能与钩子语境不同。
      （判据精确到「载体存在」：无载体的仓裸跑是正常用法，不警告。）
    """
    fatal = warn = None
    ig = _gitignored(path) if ignored is None else ignored
    if ig is True:
        fatal = ("台账目标 %s 被 .gitignore 覆盖 —— 写进去等于没写"
                 "（版本控制看不见，钩子读的是另一份）；撤销该 ignore 规则，"
                 "或显式设 REFLECT_FACTS 指向被跟踪的位置" % path)
    elif ig is None:
        warn = "（非 git 仓库或 git 不可用：跳过 gitignore 检查）"
    if carrier_exists is None:
        carrier_exists = any(os.path.exists(os.path.join(d, "Einfacht.env"))
                             for d in (os.path.join(GATE_REPO, "reflect-hooks"),
                                       GATE_REPO))
    if carrier_exists and not knob_set and ig is not True:
        warn = ((warn + "；" if warn else "")
                + "仓里有 Einfacht.env 但本次进程未加载它（REFLECT_FACTS 用了"
                  "代码默认值）—— 手工跑请先 source，否则写盘目标可能与钩子"
                  "语境不同（issue #20 ②）")
    return fatal, warn
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
        # ② 盲写守卫（issue #20 ②）
        ("目标不被 gitignore 覆盖、无载体 ⇒ 无 warn 无 fatal",
         lambda: write_target_problems("/x/FACTS.json", knob_set=True,
                                       ignored=False, carrier_exists=False)
         == (None, None)),
        ("★ 目标被 gitignore 覆盖 ⇒ FATAL（写进去等于没写）",
         lambda: write_target_problems("/x/FACTS.json", knob_set=True,
                                       ignored=True)[0] is not None),
        ("★ 仓里有 Einfacht.env 而本次未设旋钮 ⇒ warn（两个产地分叉）",
         lambda: "Einfacht.env" in (write_target_problems(
             "/x/FACTS.json", knob_set=False, ignored=False,
             carrier_exists=True)[1] or "")),
        ("非 git 目录（无法判断）⇒ 放行但明说",
         lambda: write_target_problems("/x/F.json", knob_set=True,
                                       ignored=None)[1] is not None),
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
