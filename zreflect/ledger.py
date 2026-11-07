#!/usr/bin/env python3
"""事实台账的数据层：读写 + 两道守卫。**纯函数，所以能自证。**

重测有两个静默的坏法，各配一道守卫：

  · **掉条** —— 输入不在 ⇒ 事实静默**消失**。守卫 `dropped_keys()`。
  · **改口** —— 输入变了、或量错了 ⇒ 事实静默**变成另一个数**。守卫 `changed_keys()`。

改口那条更阴：如果闸门只对少数几个 sha 回盘核对，其余条目的旧值一旦被覆盖，
**再也查不到它变过**。所以守卫的范围要窄而准。
"""
import json
import time
from datetime import datetime, timedelta, timezone

from gate import (
    fatal_exit,  # noqa: E402
    machine,
    module_meta,
)
from i18n import M


class Unreadable(RuntimeError):
    """台账文件在、但读不了（坏 JSON / 权限 / 编码）。

    **与「没有台账」是两件事**：后者是新仓的正常形态（`missing_ok=True`
    时返回空表），前者是配置事故 —— 必须走到 FATAL rc=2，绝不能冒成
    裸 traceback（那会逃出本仓的 rc 契约，而 rc=0 的 traceback 更坏：
    调用方以为成功）。
    """


def load(path, missing_ok=False):
    """读 JSON。`missing_ok=True` 时**缺文件返回空表** ——
    给「新仓库第一次跑」用：那时台账还不存在，而 `facts.py` 的两道守卫
    （掉条 / 改口）必须能处理「没有上一版」这件事。**默认仍是硬错误**：
    调用方要显式说自己接受缺失，免得把「路径写错了」静默当成「还没有台账」。

    ⚠️ 坏 JSON / 权限 / 编码一律抛 `Unreadable`（不是裸 `JSONDecodeError`）：
    调用方据此转成 FATAL rc=2。此前一律冒到顶 —— 实测 `facts.py --check`
    对一个坏台账打印 traceback 且 **rc=0**，调用方以为查过了。
    """
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        if missing_ok:
            return {}
        raise
    except (OSError, UnicodeError, ValueError) as e:
        raise Unreadable(path, e) from e


def load_or_fatal(path, name=None):
    """读台账；**坏文件 → FATAL rc=2**（`SystemExit(2)`）。

    闸门用它取代裸 `load()`：坏台账是**配置事故**，必须走 FATAL 档，
    不能冒成 traceback（Python 会以 1 退出，而 rc=1 在 `registry --run` 里
    是「判据红」—— 修法完全不同：改配置 vs 修问题）。

    实测：一个 `{ broken` 的 FACTS.json 让 `check_facts.py` 打 traceback 并
    以 1 退出，用户会去修闸门。
    """
    import sys  # noqa: PLC0415

    from i18n import M  # noqa: PLC0415
    try:
        return load(path)
    except Unreadable as e:
        cause = e.args[1] if len(e.args) > 1 else e
        print(machine().emit("fatal", M("ledger.unreadable_gate",
                                        name=name or path, error=cause)),
              file=sys.stderr)
        raise SystemExit(2) from e


def facts_of(ledger):
    """台账里的 facts 表（容忍两种形状：带外壳的文档 / 直接就是表）。"""
    led = ledger or {}
    return led.get("facts") if isinstance(led, dict) and "facts" in led else (led or {})


def dropped_keys(old_facts, new_facts):
    """本次重测会掉掉哪些**键**（纯函数：自证要用）。"""
    return sorted(set(old_facts or {}) - set(new_facts or {}))


def value_of(entry):
    """一条事实的**值**。容忍 dict 形状与裸值形状。

    （原名 `_value`：被 check_facts / check_facts_replay / check_stale 三处
    当 interface 用 —— 下划线私有名存实亡，2026-10-07 起转正。）
    """
    return entry.get("value") if isinstance(entry, dict) else entry


def short_value(v, n=24):
    """把值缩到一行（64 位 sha 只留前 16 位），给「改口」提示用。"""
    s = v if isinstance(v, str) else str(v)
    if len(s) == 64:
        return s[:16] + "…"
    return s if len(s) <= n else s[:n] + "…"


def changed_keys(old_facts, new_facts):
    """本次重测会把哪些键的**值**换掉。返回 `[(键, 旧值, 新值)]`。

    ⚠️ **只比 `value`**，不比 `cmd`/`source`/`note` —— 那些是「复跑方式」的描述，
    改它们是文档维护的正常动作。若连它们也要显式接受，守卫会变成噪音，
    最后被 `--accept-changes` 一律糊过去，守卫就废了。
    这也意味着：**新增的键不算改口**（那是新增，不该被这条拦住）。
    """
    olds = old_facts or {}
    out = []
    for k, nv in sorted((new_facts or {}).items()):
        if k not in olds:
            continue
        ov = value_of(olds[k])
        if ov != value_of(nv):
            out.append((k, ov, value_of(nv)))
    return out


def fact(value, cmd, source, note="", replay=True,
         witness=None, witness_expect=None,
         calibrate=None, calibrate_expect=None, kind="value"):
    """造一条事实：值 + 复跑命令 + 出处（+ 可选备注）。

    ⚠️ **`cmd` 的裸值契约（issue #2 ①）**：`check_facts_replay.py` 会**逐字执行**它
    （cwd=仓库根，bash + `pipefail`），并把 **stdout 去掉首尾空白**与 `value` 比对。
    所以 `cmd` 必须**只打印值本身** —— 打印「含该值的整行」人眼可读、机器不可判，
    复跑闸门只会把它读成「不符」。这条契约是「能复跑」可判定的前提。

    要起服务 / 要构建产物、在这个环境里根本跑不了的条目：显式写 `replay=False`
    （复跑闸门跳过它，并在「全部条目都豁免」时报警 —— 豁免是有名单的，不静默）。

    **第三档：见证（issue #5）** —— `replay=False` 的贵事实可以挂**便宜见证**：
    `witness`（便宜、无害、只读的命令）+ `witness_expect`（期望 stdout）。
    见证与 `replay` **正交**：贵事实的值不逐字复跑，但它的**来源/上下文**
    （"产出它的工具/输入就是我以为的那个"）**每次提交真跑**，判据同裸值契约
    （`stdout.strip() == witness_expect`）。

    **第四档：仪器校准（issue #6 ①）** —— 复跑契约抓"命令死了"（rc≠0），
    却抓不到**仪器静默失真**：命令成功、值稳定、复跑永远"通过"，而它量的
    根本不是想量的（`grep -c X` 在仪器不认 X 时成功退出并返回 0）。
    声称"产物里有没有 X"的 `cmd` 应配一个**已知含 X 的样本**：
    `calibrate`（对样本跑的便宜命令）+ `calibrate_expect`（样本的已知输出）。
    与 `replay` / `witness` 正交，**每次提交真跑**，判据同裸值契约。
    `witness` / `calibrate` 两对参数各自**必须同时给** —— 只给一个
    是残缺形状，采集器当场报错（断言残缺比静默缺失好抓）。

    `measured_at` 在**采集时刻**自动盖上（issue #3 ②）：它是「何时测的」的记录，
    供渲染「测于」列与测龄用，**不许当成测量输入**（collect.py 原则 2：
    否则 `--check` 永不收敛 —— 它是输出，不是输入）。
    `first_seen`（issue #6 ①）同样在采集时刻盖上：值不变时由
    `measure()` 沿用旧日期、换值时取今天 —— 恒常检测
    （"这条 cmd 是在量，还是恒返回同一个数？"）靠它。
    """
    _require_pairs((witness, witness_expect, "witness"),
                   (calibrate, calibrate_expect, "calibrate"))
    d = {"value": value, "cmd": cmd, "source": source,
         "measured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
         "first_seen": time.strftime("%Y-%m-%d")}
    _fill_optional(d, note, replay, witness, witness_expect,
                   calibrate, calibrate_expect, kind)
    return d


def _require_pairs(*pairs):
    """成对参数必须**同时给** —— 只给一个是残缺形状，当场报错。

    断言残缺比静默缺失好抓：一个只有 `witness` 没有 `witness_expect` 的条目
    会让复跑闸门拿 `None` 去比对，报出的是「值不符」而不是「形状缺了」。
    """
    for a, b, name in pairs:
        if (a is None) != (b is None):
            fatal_exit(M("ledger.shape_incomplete", name=name))


def _fill_optional(d, note, replay, witness, witness_expect,
                   calibrate, calibrate_expect, kind):
    """把可选字段按「给了才写」填进条目。

    ⚠️ **不给的字段不写空值**：`"replay": True` 与「没有 replay 键」在下游
    是同一件事，但写进去会让台账多一堆噪声字段（而且 `changed_keys` 要比
    `value` 之外的键时会误判）。
    """
    if note:
        d["note"] = note
    if not replay:
        d["replay"] = False
    if witness is not None:
        d["witness"] = witness
        d["witness_expect"] = witness_expect
    if calibrate is not None:
        d["calibrate"] = calibrate
        d["calibrate_expect"] = calibrate_expect
    # `kind` 决定**复跑契约**：
    #   "value"     stdout 必须等于 value（数值事实）
    #   "principle" rc==0 即可，且 stdout **必须为空**（判定，不是一个值）
    # 两条契约都活在同一个执行器（`check_facts_replay`），不新增复跑路径。
    if kind != "value":
        d["kind"] = kind


def age_days(entry):
    """该事实距采集时刻的天数（非负小数，issue #3 ②）。

    `measured_at` 缺失 / 不可解析 ⇒ None —— 读不到就明说，不许猜 0
    （0 会被当成「刚刚测的」，那是一条假断言）。
    """
    ts = entry.get("measured_at") if isinstance(entry, dict) else None
    if not ts:
        return None
    try:
        when = datetime.strptime(str(ts), "%Y-%m-%dT%H:%M:%S%z")
    except ValueError:
        return None
    return (datetime.now(timezone.utc) - when).total_seconds() / 86400.0


# ── 自证（三档：正常不报 / 该报的必须报 / 空输入必须报）──────────────────────────
def _cases_guards():
    """① 掉条 / 改口守卫：正常不报 + 该报的必须报 + 空起步合法。"""
    from gate import raises  # noqa: PLC0415
    return [
        ("ledger.dropped_clean",
         lambda: dropped_keys({"a": 1}, {"a": 1, "c": 3}) == []),
        ("ledger.changed_clean",
         lambda: changed_keys({"a": {"value": 1}}, {"a": {"value": 1}}) == []),
        ("ledger.changed_cmd_only",
         lambda: changed_keys({"a": {"value": 1, "cmd": "old"}},
                              {"a": {"value": 1, "cmd": "new"}}) == []),
        ("\u2605 ledger.dropped_keys",
         lambda: dropped_keys({"a": 1, "b": 2}, {"a": 1}) == ["b"]),
        ("\u2605 ledger.changed_keys",
         lambda: changed_keys({"a": {"value": 1}}, {"a": {"value": 2}})
         == [("a", 1, 2)]),
        # ③ 空输入必须报（这里是「不许报」的对面：空起步是合法的第一次生成）
        ("ledger.first_run_dropped_silent",
         lambda: dropped_keys({}, {"a": 1}) == []),
        ("ledger.first_run_changed_silent",
         lambda: changed_keys({}, {"a": {"value": 1}}) == []),
        ("ledger.raises_detects",
         lambda: raises(lambda: (_ for _ in ()).throw(SystemExit(2)))),
    ]


def _cases_shapes():
    """附：台账形状 —— `facts_of` / `short_value` / `value_of` 三处 interface。"""
    return [
        ("ledger.facts_of_both_shapes",
         lambda: facts_of({"facts": {"a": 1}}) == {"a": 1}
         and facts_of({"a": 1}) == {"a": 1}),
        ("ledger.short_value_sha",
         lambda: short_value("a" * 64) == "a" * 16 + "\u2026"),
        # 稳态：`value_of` 容忍 dict 与裸值两种形状
        ("ledger.value_of_both_shapes",
         lambda: value_of({"value": 3}) == 3 and value_of(7) == 7),
    ]


def _cases_measurement():
    """② 测龄 + `first_seen`（issue #3 ② / #6 ①）。"""
    return [
        ("ledger.fact_stamps_measured_at",
         lambda: isinstance(fact(1, "c", "s").get("measured_at"), str)),
        ("ledger.age_days_missing_none", lambda: age_days({"value": 1}) is None),
        ("ledger.age_days_bad_stamp_none",
         lambda: age_days({"measured_at": "not-a-time"}) is None),
        ("ledger.age_days_fresh",
         lambda: 0 <= age_days({"measured_at": time.strftime(
             "%Y-%m-%dT%H:%M:%S%z")}) < 1),
        ("ledger.age_days_about_40",
         lambda: 39 < age_days({"measured_at": (
             datetime.now(timezone.utc) - timedelta(days=40)
         ).strftime("%Y-%m-%dT%H:%M:%S%z")}) < 41),
        ("ledger.fact_stamps_first_seen",
         lambda: fact(1, "c", "s").get("first_seen")
         == time.strftime("%Y-%m-%d")),
    ]


def _cases_probes():
    """③ 见证 / ④ 仪器校准（issue #5 / #6 ①）：成对字段，单给一个必须抛。"""
    from gate import raises  # noqa: PLC0415
    return [
        ("ledger.witness_fields",
         lambda: fact(1, "c", "s", witness="w", witness_expect="e")
         .get("witness") == "w"
         and fact(1, "c", "s", witness="w", witness_expect="e")
         .get("witness_expect") == "e"),
        ("ledger.no_witness_no_field",
         lambda: "witness" not in fact(1, "c", "s")),
        ("\u2605 ledger.witness_only",
         lambda: raises(lambda: fact(1, "c", "s", witness="w"))),
        ("\u2605 ledger.witness_expect_only",
         lambda: raises(lambda: fact(1, "c", "s", witness_expect="e"))),
        ("ledger.calibrate_fields",
         lambda: fact(1, "c", "s", calibrate="cal", calibrate_expect="e")
         .get("calibrate") == "cal"),
        ("\u2605 ledger.calibrate_only",
         lambda: raises(lambda: fact(1, "c", "s", calibrate="cal"))),
        ("\u2605 ledger.calibrate_expect_only",
         lambda: raises(lambda: fact(1, "c", "s", calibrate_expect="e"))),
    ]


def _cases():
    """四组：守卫 / 形状 / 测龄 / 探针。它们考的是台账的四个不同面。"""
    return (_cases_guards() + _cases_shapes()
            + _cases_measurement() + _cases_probes())


def _selftest():
    from gate import activate_or_fatal, selftest  # noqa: PLC0415
    # 激活**先于**自证：包设了却不在 ⇒ FATAL rc 2（此前这条入口从不激活，
    # 于是 REFLECT_LANG=de 下一个不存在的包被静默接受）。
    rc = activate_or_fatal()
    if rc:
        return rc
    return selftest(M("gate.title.ledger"), _cases())


MODULE = module_meta("事实台账数据层", "读写 + 两道守卫的纯函数", selftest=True)


if __name__ == "__main__":
    import sys  # noqa: PLC0415
    sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
    sys.exit(_selftest())
