#!/usr/bin/env python3
"""仪器生命周期闸门（**可插拔模块**，issue #6 ①）。

事实系统管了值、断言、来源，但没管**量它的那条命令/仪器本身会不会
腐烂**。`cmd` 的复跑契约（issue #2 ①）抓「命令死了」（rc≠0），
却抓不到**仪器静默失真**：命令成功、值稳定、复跑永远「通过」，
而它量的根本不是想量的 —— `grep -c X` 在仪器不认 X 时**成功退出
并返回 0**，这是最阴的一种。

本闸门是**可插拔**的：两个旋钮都未配 ⇒ 明说未启用、退 0
（不配的仓库完全不受影响；发现式名录照样收编它，自证照样证明
它能红）。启用（各取所需）：

  · `REFLECT_INSTRUMENT_DAYS=天` —— **恒常检测**：台账条目的
    `first_seen`（`measure()` 自动维护：值不变沿用旧日期、换值
    取今天，`ledger.fact()` 盖章）距今超过阈值 ⇒ 报「人工确认：
    这条 cmd 是在量，还是恒返回同一个数？」。不配 = 该规则
    明说未启用（读不到 / 不可解析的 first_seen 也报 —— 读不到
    就明说，不许猜）。

  · `REFLECT_INSTRUMENTS=instruments.json` —— **量法登记位**
    （schema: `{"methods": [{text, why, fixed_in}]}`）：被证伪的
    **量法**像 `retractions.json` 管「被推翻的断言」那样有登记位；
    台账任何 `cmd` 含被证伪片段 ⇒ 报（坏量法不许留在台账里）。
    设了旋钮而登记位不在 ⇒ 报（配置了却没登记 = 承诺坏了）。

零值守卫：台账为空 ⇒ 报（空不是通过）。

用法（直接跑，cwd=仓库根）：
    python3 zreflect/check_instruments.py [--selftest]
退出码：0=绿 / 1=发现问题 / 2=配置或环境坏了（配置性失败 ≠ 检查失败）。
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gate import (  # noqa: E402
    fatal,
    finish,
    load_spec,
    main_selftest_or,
    meta,
    off,
    repo,  # noqa: E402
)
from i18n import M  # noqa: E402
from ledger import facts_of, load_or_fatal  # noqa: E402

INSTRUMENTS_RAW = os.environ.get("REFLECT_INSTRUMENTS", "").strip()
DAYS_RAW = os.environ.get("REFLECT_INSTRUMENT_DAYS", "").strip()


def _days():
    if not DAYS_RAW:
        return None
    try:
        return float(DAYS_RAW)
    except ValueError:
        return None


def _age_days(first_seen):
    """first_seen（%Y-%m-%d）距今天数；不可解析 ⇒ None（读不到就明说）。"""
    try:
        d = datetime.strptime(str(first_seen), "%Y-%m-%d").replace(
            tzinfo=timezone.utc)
    except ValueError:
        return None
    return (datetime.now(timezone.utc) - d).total_seconds() / 86400.0


def _constant_return_problems(f, days):
    """恒常检测：`first_seen` 距今超过阈值 ⇒ 「这条 cmd 是在量，还是恒返回同一个数？」"""
    out = []
    for k in sorted(f):
        entry = f[k] if isinstance(f[k], dict) else {"value": f[k]}
        fs = entry.get("first_seen")
        if not fs:
            continue                  # 旧台账条目没有 first_seen：不猜、不报
        age = _age_days(fs)
        if age is None:
            out.append(M("instruments.first_seen_unparseable",
                         key=k, first_seen=fs))
        elif age > days:
            out.append(M("instruments.constant_return", key=k,
                         first_seen=fs, days=age, threshold=days))
    return out


def _falsified_hits(text, why, fixed, f):
    """一个被证伪片段在台账里命中的键（命中 = 那条事实还在用坏量法）。"""
    hits = []
    for k in sorted(f):
        entry = f[k] if isinstance(f[k], dict) else {"value": f[k]}
        if text in str(entry.get("cmd") or ""):
            hits.append(M("instruments.falsified_method", key=k, text=text,
                          why=why, fixed_in=fixed))
    return hits


def _falsified_method_problems(f, methods):
    """量法登记位：台账里任何 `cmd` 含被证伪片段 ⇒ 报（坏量法不许留在台账里）。"""
    out = []
    for m in (methods or []):
        text = str(m.get("text") or "").strip()
        why = str(m.get("why") or "").strip()
        if not text or not why:
            out.append(M("instruments.entry_malformed", entry=m))
            continue
        fixed = m.get("fixed_in") or M("instruments.fixed_in_unregistered")
        out += _falsified_hits(text, why, fixed, f)
    return out


def problems(ledger, methods=None, days=None):
    """纯函数：返回问题清单（空 = 绿）。自证期间不许 print。

    `methods` = 量法登记位（被证伪量法清单）；`days` = 恒常检测阈值
    （None = 该规则未启用）。**两者独立**：恒常检测管「值从来没变过」，
    登记位管「量法本身被证伪过」—— 各是一个具名 helper，各自可单独懂。
    """
    f = facts_of(ledger)
    if not f:
        return [M("instruments.ledger_empty")]
    out = []
    if days is not None:
        out += _constant_return_problems(f, days)
    out += _falsified_method_problems(f, methods)
    return out


def _load_methods(name):
    """读量法登记位（`REFLECT_INSTRUMENTS` 指向的 JSON）。返回 `(methods, rc)`。"""
    if not name:
        return [], 0
    reg_path = repo(name)
    if not os.path.exists(reg_path):
        return [], fatal(M("instruments.registry_missing", name=name))
    reg, err = load_spec(reg_path)
    if err:
        return [], fatal(M("instruments.spec_broken", name=name, error=err))
    return reg.get("methods") or [], 0


def run(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    name = INSTRUMENTS_RAW
    days = _days()
    if DAYS_RAW and days is None:
        return fatal(M("instruments.days_unparseable",
                       days_knob="REFLECT_INSTRUMENT_DAYS", value=DAYS_RAW))
    if not name and days is None:
        return off(M("instruments.off",
                     days_knob="REFLECT_INSTRUMENT_DAYS",
                     instruments_knob="REFLECT_INSTRUMENTS"))
    led_path = repo(os.environ.get("REFLECT_FACTS", "FACTS.json"))
    if not os.path.exists(led_path):
        return fatal(M("instruments.ledger_missing", path=led_path))
    methods, rc = _load_methods(name)
    if rc:
        return rc
    probs = problems(load_or_fatal(led_path), methods=methods, days=days)
    return finish(M("instruments.title"), probs, _ok_line(name, methods, days))


def _ok_line(name, methods, days):
    """通过行里要说清**开了哪几档**（否则「绿」不区分「全开」与「一档都没开」）。"""
    parts = []
    if days is not None:
        parts.append(M("instruments.part_days", threshold=days))
    if name:
        parts.append(M("instruments.part_methods", name=name,
                       count=len(methods)))
    return M("instruments.ok",
             modes=" + ".join(parts) or M("instruments.part_none"))


def _cases():
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    old = (datetime.now(timezone.utc) - timedelta(days=40)).strftime("%Y-%m-%d")
    led = {"facts": {"n": {"value": 7, "cmd": "echo 7", "source": "s",
                              "first_seen": today}}}
    led_old = {"facts": {"n": {"value": 7, "cmd": "echo 7", "source": "s",
                                  "first_seen": old}}}
    led_bad = {"facts": {"n": {"value": 7, "cmd": "echo 7", "source": "s",
                                  "first_seen": "bad-date"}}}
    led_method = {"facts": {"n": {"value": 7,
                                     "cmd": "llvm-objdump -d x.o | grep -c relaxed_madd",
                                     "source": "s", "first_seen": today}}}
    methods = [{"text": "grep -c relaxed_madd",
                "why": "llvm-objdump only prints <unknown> for relaxed-simd, "
                       "grep is always 0 (command succeeds, value stable, replay "
                       "passes forever)",
                "fixed_in": "calibrate= a calibration sample known to contain relaxed_madd"}]
    return [
        # ① 正常不报
        ("instruments.fresh",
         lambda: problems(led, days=30) == []),
        ("instruments.registered_method_absent",
         lambda: problems(led, methods=methods, days=30) == []),
        ("instruments.first_seen_absent",
         lambda: problems({"facts": {"n": {"value": 1, "cmd": "c"}}},
                          days=30) == []),
        # ② 该报的必须报
        ("★ instruments.constant_return",
         lambda: [p.code for p in problems(led_old, days=30)]
         == ["instruments.constant_return"]),
        ("★ instruments.first_seen_unparseable",
         lambda: [p.code for p in problems(led_bad, days=30)]
         == ["instruments.first_seen_unparseable"]),
        ("★ instruments.falsified_method",
         lambda: [p.code for p in problems(led_method, methods=methods)]
         == ["instruments.falsified_method"]),
        ("★ instruments.entry_malformed",
         lambda: [p.code for p in problems(led, methods=[{"text": "x"}])]
         == ["instruments.entry_malformed"]),
        # ③ 空输入必须报
        ("★ instruments.ledger_empty",
         lambda: [p.code for p in problems({"facts": {}}, days=30)]
         == ["instruments.ledger_empty"]),
    ]


GATE = meta("仪器生命周期闸门", "恒常检测（first_seen）+ 被证伪量法登记",
            knobs=("REFLECT_INSTRUMENTS", "REFLECT_INSTRUMENT_DAYS", "REFLECT_FACTS"),
            off_reason="两个旋钮都未配 ⇒ 特化机制没启用（可插拔，本仓按需再开）")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], "check_instruments", _cases, run))
