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
from gate import module_meta


def load(path, missing_ok=False):
    """读 JSON。`missing_ok=True` 时**缺文件返回空表** ——
    给"新仓库第一次跑"用：那时台账还不存在，而 `facts.py` 的两道守卫
    （掉条 / 改口）必须能处理"没有上一版"这件事。**默认仍是硬错误**：
    调用方要显式说自己接受缺失，免得把"路径写错了"静默当成"还没有台账"。"""
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        if missing_ok:
            return {}
        raise


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
         calibrate=None, calibrate_expect=None):
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
    for a, b, name in ((witness, witness_expect, "witness"),
                       (calibrate, calibrate_expect, "calibrate")):
        if (a is None) != (b is None):
            raise SystemExit(
                "FATAL: fact() 形状契约（issue #5/#6）：`%s` 与 `%s_expect`"
                " 必须同时给（只给一个 = 残缺断言，断言残缺比静默缺失好抓）"
                % (name, name))
    d = {"value": value, "cmd": cmd, "source": source,
         "measured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
         "first_seen": time.strftime("%Y-%m-%d")}
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
    return d


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
def _cases():
    from gate import module_meta, raises                            # noqa: PLC0415
    return [
        # ① 正常不报
        ("掉条：不掉条时不报", lambda: dropped_keys({"a": 1}, {"a": 1, "c": 3}) == []),
        ("改口：值没变时不报", lambda: changed_keys({"a": {"value": 1}}, {"a": {"value": 1}}) == []),
        ("改口：只改 cmd/source 不算改口（否则守卫变噪音）",
         lambda: changed_keys({"a": {"value": 1, "cmd": "旧"}},
                              {"a": {"value": 1, "cmd": "新"}}) == []),
        # ② 该报的必须报
        ("★ 掉条：键没了必须报出来", lambda: dropped_keys({"a": 1, "b": 2}, {"a": 1}) == ["b"]),
        ("★ 改口：值换了必须报出来，且带旧值→新值",
         lambda: changed_keys({"a": {"value": 1}}, {"a": {"value": 2}}) == [("a", 1, 2)]),
        # ③ 空输入必须报（这里是「不许报」的对面：空起步是合法的第一次生成）
        ("空台账起步 ⇒ 掉条不报（第一次生成不许被自己拦住）",
         lambda: dropped_keys({}, {"a": 1}) == []),
        ("空台账起步 ⇒ 改口不报", lambda: changed_keys({}, {"a": {"value": 1}}) == []),
        # 附：形状
        ("facts_of 容忍两种形状", lambda: facts_of({"facts": {"a": 1}}) == {"a": 1}
         and facts_of({"a": 1}) == {"a": 1}),
        ("sha 型长值在提示里被截断", lambda: short_value("a" * 64) == "a" * 16 + "…"),
        ("raises 能识别「确实报了」", lambda: raises(lambda: (_ for _ in ()).throw(SystemExit(2)))),
        # ② 测龄（issue #3 ②）
        ("fact() 盖采集时刻戳", lambda: isinstance(fact(1, "c", "s").get("measured_at"), str)),
        ("age_days：缺失 measured_at ⇒ None（读不到就明说）",
         lambda: age_days({"value": 1}) is None),
        ("age_days：坏时间戳 ⇒ None（不许猜 0）",
         lambda: age_days({"measured_at": "不是时间"}) is None),
        ("age_days：刚刚测的 ⇒ 不足一天",
         lambda: 0 <= age_days({"measured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}) < 1),
        ("age_days：40 天前 ⇒ 约 40 天",
         lambda: 39 < age_days({"measured_at": (datetime.now(timezone.utc)
                                                 - timedelta(days=40)
                                                 ).strftime("%Y-%m-%dT%H:%M:%S%z")}) < 41),
        # ③ 见证（issue #5）
        ("fact() 盖 witness 字段（两者同给）",
         lambda: fact(1, "c", "s", witness="w", witness_expect="e").get("witness") == "w"
         and fact(1, "c", "s", witness="w", witness_expect="e").get("witness_expect") == "e"),
        ("fact() 不给 witness ⇒ 无字段",
         lambda: "witness" not in fact(1, "c", "s")),
        ("★ witness 形状残缺：只给 witness ⇒ 当场报错",
         lambda: raises(lambda: fact(1, "c", "s", witness="w"))),
        ("★ witness 形状残缺：只给 witness_expect ⇒ 当场报错",
         lambda: raises(lambda: fact(1, "c", "s", witness_expect="e"))),
        # ④ 仪器校准（issue #6 ①）
        ("fact() 盖 calibrate 字段（两者同给）",
         lambda: fact(1, "c", "s", calibrate="cal", calibrate_expect="e")
         .get("calibrate") == "cal"),
        ("★ calibrate 形状残缺：只给 calibrate ⇒ 当场报错",
         lambda: raises(lambda: fact(1, "c", "s", calibrate="cal"))),
        ("★ calibrate 形状残缺：只给 calibrate_expect ⇒ 当场报错",
         lambda: raises(lambda: fact(1, "c", "s", calibrate_expect="e"))),
        # ⑤ first_seen（issue #6 ① 恒常检测的状态）
        ("fact() 盖 first_seen（采集日）",
         lambda: fact(1, "c", "s").get("first_seen")
         == time.strftime("%Y-%m-%d")),
    ]


def _selftest():
    from gate import selftest                          # noqa: PLC0415
    return selftest("ledger（两道守卫）", _cases())


MODULE = module_meta("事实台账数据层", "读写 + 两道守卫的纯函数", selftest=True)


if __name__ == "__main__":
    import sys                                        # noqa: PLC0415
    sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
    sys.exit(_selftest())
