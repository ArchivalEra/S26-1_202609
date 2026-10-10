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
from gate import fatal, finish, load_spec, main_selftest_or, meta, off  # noqa: E402
from gate import repo, selftest                            # noqa: E402
from ledger import facts_of, load                         # noqa: E402

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


def problems(ledger, methods=None, days=None):
    """纯函数：返回问题清单（空 = 绿）。自证期间不许 print。

    `methods` = 量法登记位（被证伪量法清单）；`days` = 恒常检测阈值
    （None = 该规则未启用）。两者独立：恒常检测管「值从来没变过」，
    登记位管「量法本身被证伪过」。
    """
    out = []
    f = facts_of(ledger)
    if not f:
        return ["台账为空 —— 空不是通过（零值守卫）：先查 measure() 是不是坏了"]
    if days is not None:
        for k in sorted(f):
            entry = f[k] if isinstance(f[k], dict) else {"value": f[k]}
            fs = entry.get("first_seen")
            if not fs:
                continue          # 旧台账条目没有 first_seen：不猜、不报
            age = _age_days(fs)
            if age is None:
                out.append("`%s` 的 first_seen 不可解析（%r）—— 恒常判据"
                           "无法评估（读不到就明说，不许猜）" % (k, fs))
            elif age > days:
                out.append("`%s` 的值自 %s 起没变过（%.0f 天，恒常阈值 %.0f 天）"
                           " —— 人工确认：这条 cmd 是在量，还是恒返回同一个数？"
                           "（仪器静默失真检查，issue #6 ①）" % (k, fs, age, days))
    for m in (methods or []):
        text = str(m.get("text") or "").strip()
        why = str(m.get("why") or "").strip()
        if not text or not why:
            out.append("量法登记条目形状残缺（text 与 why 必须都给）：%r" % (m,))
            continue
        for k in sorted(f):
            entry = f[k] if isinstance(f[k], dict) else {"value": f[k]}
            if text in str(entry.get("cmd") or ""):
                out.append("`%s` 的 cmd 含**被证伪的量法**片段 %r（%s；"
                           "正确量法见 %s）—— 坏量法不许留在台账里"
                           % (k, text, why, m.get("fixed_in") or "未登记"))
    return out


def run(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    name = INSTRUMENTS_RAW
    days = _days()
    if DAYS_RAW and days is None:
        return fatal("REFLECT_INSTRUMENT_DAYS=%r 不可解析成天数 —— 修配置"
                     "（或撤掉该旋钮）" % DAYS_RAW)
    if not name and days is None:
        return off("仪器生命周期闸门：REFLECT_INSTRUMENT_DAYS 与 REFLECT_INSTRUMENTS"
                   " 均未配置 ⇒ 本闸门未启用（可插拔模块；要启用："
                   "REFLECT_INSTRUMENT_DAYS=天 开恒常检测；REFLECT_INSTRUMENTS="
                   "instruments.json 登记被证伪量法）")
    led_path = repo(os.environ.get("REFLECT_FACTS", "FACTS.json"))
    if not os.path.exists(led_path):
        return fatal("台账不在：%s —— 先跑 facts.py" % led_path)
    methods = []
    if name:
        reg_path = repo(name)
        if not os.path.exists(reg_path):
            return fatal("REFLECT_INSTRUMENTS=%s 已配置但登记位不在 —— 先登记"
                         "（或撤掉该旋钮）" % name)
        reg, err = load_spec(reg_path)
        if err:
            return fatal(err)
        methods = reg.get("methods") or []
    probs = problems(load(led_path), methods=methods, days=days)
    parts = []
    if days is not None:
        parts.append("恒常检测 %.0f 天阈值" % days)
    if name:
        parts.append("量法登记 %s（%d 条）" % (name, len(methods)))
    return finish("仪器生命周期闸门", probs,
                  "仪器生命周期闸门：OK（%s）" % (" + ".join(parts) or "空登记"))


def _cases():
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    old = (datetime.now(timezone.utc) - timedelta(days=40)).strftime("%Y-%m-%d")
    led = {"facts": {"n": {"value": 7, "cmd": "echo 7", "source": "s",
                              "first_seen": today}}}
    led_old = {"facts": {"n": {"value": 7, "cmd": "echo 7", "source": "s",
                                  "first_seen": old}}}
    led_bad = {"facts": {"n": {"value": 7, "cmd": "echo 7", "source": "s",
                                  "first_seen": "坏日期"}}}
    led_method = {"facts": {"n": {"value": 7,
                                     "cmd": "llvm-objdump -d x.o | grep -c relaxed_madd",
                                     "source": "s", "first_seen": today}}}
    methods = [{"text": "grep -c relaxed_madd",
                "why": "llvm-objdump 对 relaxed-simd 只打印 <unknown>，"
                       "grep 恒 0（命令成功、值稳定、复跑永远通过）",
                "fixed_in": "calibrate= 已知含 relaxed_madd 的校准样本"}]
    return [
        # ① 正常不报
        ("first_seen 今天 + 阈值 30 天 ⇒ 不报",
         lambda: problems(led, days=30) == []),
        ("first_seen 今天 + 量法登记（不含片段）⇒ 不报",
         lambda: problems(led, methods=methods, days=30) == []),
        ("first_seen 缺失 ⇒ 不报（旧条目不猜）",
         lambda: problems({"facts": {"n": {"value": 1, "cmd": "c"}}},
                          days=30) == []),
        # ② 该报的必须报
        ("★ 恒常：40 天没变 + 阈值 30 ⇒ 必须报",
         lambda: any("没变过" in x for x in problems(led_old, days=30))),
        ("★ 恒常：first_seen 不可解析 ⇒ 必须报（读不到就明说）",
         lambda: any("不可解析" in x for x in problems(led_bad, days=30))),
        ("★ 量法：cmd 含被证伪片段 ⇒ 必须报（坏量法不许留在台账）",
         lambda: any("被证伪的量法" in x
                     for x in problems(led_method, methods=methods))),
        ("★ 登记条目形状残缺（缺 why）⇒ 必须报",
         lambda: any("形状残缺" in x
                     for x in problems(led, methods=[{"text": "x"}]))),
        # ③ 空输入必须报
        ("★ 空台账 ⇒ 必须报（零值守卫）",
         lambda: problems({"facts": {}}, days=30) != []),
    ]


GATE = meta("仪器生命周期闸门", "恒常检测（first_seen）+ 被证伪量法登记",
            knobs=("REFLECT_INSTRUMENTS", "REFLECT_INSTRUMENT_DAYS", "REFLECT_FACTS"))

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:],
                              "仪器生命周期闸门（可插拔：恒常检测 + 量法登记）",
                              _cases(), run))
