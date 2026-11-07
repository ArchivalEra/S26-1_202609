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

import gate
from i18n import M
from ledger import changed_keys, dropped_keys, short_value


def _gitignored(path):
    """路径是否被 .gitignore 覆盖；非 git 仓库 / git 不在 ⇒ None（无法判断，不猜）。"""
    import subprocess  # noqa: PLC0415
    try:
        r = subprocess.run(["git", "-C", gate.GATE_REPO, "check-ignore", "-q", path],
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
        fatal = M("guard.write_target_gitignored", path=path)
    elif ig is None:
        warn = M("guard.write_target_no_git")
    if carrier_exists is None:
        carrier_exists = any(os.path.exists(os.path.join(d, "Einfacht.env"))
                             for d in (os.path.join(gate.GATE_REPO, "reflect-hooks"),
                                       gate.GATE_REPO))
    if carrier_exists and not knob_set and ig is not True:
        # 两条 warn 可能并列（前一条是「非 git 目录」）—— 拼装归语言包：
        # 有前缀走 `_after`（模板里带分隔符），没有走裸句。
        warn = (M("guard.write_target_env_carrier")
                if warn is None else
                M("guard.write_target_env_carrier_after", prefix=warn))
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


def _drop_verdict(old_facts, new_facts, allow_drop, notes):
    """守卫一：掉条（键没了）。返回 `(拒绝问题清单, 是否已拒绝)`。"""
    dropped = dropped_keys(old_facts, new_facts)
    if not dropped:
        return [], False
    if not allow_drop:
        return [M("guard.refuse_dropped", count=len(dropped),
                  keys=", ".join(dropped)),
                M("guard.refuse_dropped_advice")], True
    notes["err"].append(M("guard.note_allow_drop", count=len(dropped),
                          keys=", ".join(dropped)))
    return [], False


def _change_verdict(old_facts, new_facts, accepted, notes):
    """守卫二：改口（值换了）。返回 `(拒绝问题清单, 是否已拒绝)`。"""
    changed = changed_keys(old_facts, new_facts)
    remaining = filter_accepted(changed, accepted)
    if remaining:
        problems = [M("guard.refuse_changed", count=len(remaining))]
        problems += [M("guard.changed_row", key=k, before=short_value(o),
                       after=short_value(n)) for k, o, n in remaining]
        if accepted:
            problems.append(M("guard.accepted_boundary",
                              accepted=len(changed) - len(remaining),
                              keys=", ".join(sorted(accepted))))
        problems.append(M("guard.refuse_changed_advice"))
        return problems, True
    if changed:
        notes["out"].append(M("guard.note_accept_changes", count=len(changed)))
        notes["out"] += [M("guard.changed_row", key=k, before=short_value(o),
                           after=short_value(n)) for k, o, n in changed]
    return [], False


def decide(old_facts, new_facts, accepted=False, allow_drop=False):
    """重测写盘的**决策**（纯函数：自证要用，不许 print）。

    两道守卫各是一个具名 helper：它们判的是**不同**的破坏（键消失 vs 值换了），
    拒绝消息也完全不同（一个给 `--allow-drop` 的建议、一个给
    `--accept-changes` 的）。挤在一个函数里时，两条 `return "refuse"` 与
    它们的 notes 副作用交错，读者要记「哪些 notes 已经写过」。
    """
    notes = {"err": [], "out": []}
    problems, refused = _drop_verdict(old_facts, new_facts, allow_drop, notes)
    if refused:
        return "refuse", problems, notes
    problems, refused = _change_verdict(old_facts, new_facts, accepted, notes)
    if refused:
        return "refuse", problems, notes
    # 零值守卫：一条都没量到 ⇒ 不是「没有改口」，是什么都没量。
    if not new_facts:
        return "refuse", [M("guard.empty_ledger")], notes
    return "write", problems, notes


def _cases_fixture():
    """夹具（原 `_cases` 的前置段原样搬入）。"""
    old = {"a": {"value": 1}, "b": {"value": 2}}
    same = {"a": {"value": 1}, "b": {"value": 2}}
    new_val = {"a": {"value": 1}, "b": {"value": 9}}
    dropped = {"a": {"value": 1}}          # b 掉了
    return {'old': old, 'same': same, 'new_val': new_val, 'dropped': dropped}


def _cases_decide(fx):
    """见 `_cases()`：本组 10 条。"""
    old, same, new_val, dropped = (fx["old"], fx["same"], fx["new_val"], fx["dropped"])
    return [
    # ① 正常不报
    ("guard.decide_clean",
     lambda: decide(old, same) == ("write", [], {"err": [], "out": []})),
    ("guard.decide_added_key_not_a_change",
     lambda: decide(old, dict(same, c={"value": 3}))[0] == "write"),
    ("guard.decide_cmd_only_not_a_change",
     lambda: decide({"a": {"value": 1, "cmd": "old"}},
                    {"a": {"value": 1, "cmd": "new"}})[0] == "write"),
    # ② 该报的必须报
    ("★ guard.refuse_dropped",
     lambda: (lambda v, p, n: v == "refuse"
              and p[0].code == "guard.refuse_dropped"
              and "b" in p[0].params["keys"])(*decide(old, dropped))),
    ("★ guard.note_allow_drop",
     lambda: (lambda v, p, n: v == "write"
              and n["err"][0].code == "guard.note_allow_drop"
              and n["err"][0].params["keys"] == "b"
              )(*decide(old, dropped, allow_drop=True))),
    ("★ guard.changed_row",
     lambda: (lambda v, p, n: v == "refuse"
              and any(x.code == "guard.changed_row"
                      and x.params["before"] == "2"
                      and x.params["after"] == "9" for x in p)
              )(*decide(old, new_val))),
    ("★ guard.note_accept_changes",
     lambda: (lambda v, p, n: v == "write"
              and any(x.code == "guard.note_accept_changes" for x in n["out"])
              )(*decide(old, new_val, accepted={"b"}))),
    ("★ guard.accept_changes_per_key",
     lambda: decide(old, new_val, accepted={"zzz"})[0] == "refuse"),
    ("★ guard.accepted_boundary",
     lambda: any(x.code == "guard.accepted_boundary" for x in decide(
         old, {"a": {"value": 8}, "b": {"value": 9}},
         accepted={"a"})[1])),
    ("★ guard.accept_changes_bare_flag",
     lambda: decide(old, new_val, accepted=None)[0] == "write"),
    ]


def _cases_keys(fx):
    """见 `_cases()`：本组 6 条。"""
    old, new_val = fx["old"], fx["new_val"]
    return [
    # 接线解析（issue #3 ① 的解析语义搬进守卫的自证面）
    ("guard.accepted_keys_bare",
     lambda: accepted_keys(["--accept-changes"]) is None),
    ("guard.accepted_keys_list",
     lambda: accepted_keys(["--accept-changes=a,b"]) == {"a", "b"}),
    ("guard.accepted_keys_absent",
     lambda: accepted_keys([]) is False),
    ("guard.accepted_keys_empty_set",
     lambda: accepted_keys(["--accept-changes="]) == set()),
    # ③ 空输入必须报
    ("★ guard.empty_ledger",
     lambda: decide(old, {})[0] == "refuse"),
    ("★ guard.accepted_keys_empty_set_refuses",
     lambda: decide(old, new_val, accepted=set())[0] == "refuse"),
    ]


def _cases_write(fx):
    """见 `_cases()`：本组 5 条。"""
    return [
    # ② 盲写守卫（issue #20 ②）
    ("guard.write_target_clean",
     lambda: write_target_problems("/x/FACTS.json", knob_set=True,
                                   ignored=False, carrier_exists=False)
     == (None, None)),
    ("★ guard.write_target_gitignored",
     lambda: write_target_problems("/x/FACTS.json", knob_set=True,
                                   ignored=True)[0] is not None),
    ("★ guard.write_target_env_carrier",
     lambda: getattr(write_target_problems(
         "/x/FACTS.json", knob_set=False, ignored=False,
         carrier_exists=True)[1], "code", None)
     == "guard.write_target_env_carrier"),
    ("guard.write_target_no_git",
     lambda: getattr(write_target_problems(
         "/x/F.json", knob_set=True, ignored=None)[1],
         "code", None) == "guard.write_target_no_git"),
    ("guard.write_target_env_carrier_after",
     # 两条 warn 并列时前一条不许丢（拼接归语言包）
     lambda: getattr(write_target_problems(
         "/x/F.json", knob_set=False, ignored=None,
         carrier_exists=True)[1], "code", None)
     == "guard.write_target_env_carrier_after"),
    ]


def _cases():
    """拼装 3 组夹具断言。**只拼装** —— 判据在各分组函数里。"""
    fx = _cases_fixture()
    return (
    _cases_decide(fx)
    + _cases_keys(fx)
    + _cases_write(fx)
    )


MODULE = module_meta("台账写盘守卫", "掉条 / 改口 / 逐条接受（决策与执行分离）", selftest=True)


if __name__ == "__main__":
    import os  # noqa: PLC0415
    import sys  # noqa: PLC0415
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from gate import main_selftest_or, module_meta  # noqa: PLC0415

    def _run(argv):
        print(M("guard.module_banner"), file=sys.stderr)
        return 2
    sys.exit(main_selftest_or(sys.argv[1:],
                              M("gate.title.guard"),
                              _cases, _run))
