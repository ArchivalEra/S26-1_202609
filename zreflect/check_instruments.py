#!/usr/bin/env python3
"""Instrument lifecycle gate (**pluggable module**, issue #6 item 1).

The facts system guards values, assertions, and sources, but never guarded
**whether the command/instrument doing the measuring itself rots**. The `cmd`
replay contract (issue #2, item 1) catches "the command died" (rc != 0) but
cannot catch **silent instrument distortion**: the command succeeds, the value
is stable, the replay "passes" forever -- yet it is not measuring what it was
meant to measure. `grep -c X` **exits successfully returning 0** when the
instrument does not recognize X -- the stealthiest kind.

This gate is **pluggable**: with both knobs unset => explicitly not enabled,
exit 0 (repos that do not configure it are entirely unaffected; the
discovery-based roster still enrolls it, and the selftest still proves it can
go red). Enabling (each part independent):

  - `REFLECT_INSTRUMENT_DAYS=<days>` -- **constancy detection**: when a ledger
    entry's `first_seen` (maintained automatically by `measure()`: value
    unchanged keeps the old date, a changed value stamps today,
    `ledger.fact()` does the stamping) is older than the threshold => report
    "human confirmation needed: is this cmd measuring, or does it always
    return the same number?". Unset = that rule explicitly not enabled
    (unreadable / unparseable first_seen is also reported -- if it cannot be
    read, say so; guessing is not allowed).

  - `REFLECT_INSTRUMENTS=instruments.json` -- **the method registry**
    (schema: `{"methods": [{text, fixed_in}]}`): falsified **measuring
    methods** get a registration slot, the way `retractions.json` handles
    "retracted assertions"; any ledger `cmd` containing a falsified snippet =>
    report (a broken measuring method must not stay in the ledger). Knob set
    but the registry file missing => report (configured but never registered =
    a broken promise).

Zero-value guard: an empty ledger => report (empty is not a pass).

Usage (run directly, cwd = repo root):
    python3 zreflect/check_instruments.py [--selftest]
Exit codes: 0 = green / 1 = problems found / 2 = config or environment broken
(a config failure is not a check failure).
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gate  # noqa: E402
import knobs  # noqa: E402
from facts import facts_of, load_or_fatal  # noqa: E402
from gate import fatal, finish, main_selftest_or, meta, off, repo  # noqa: E402
from i18n import M  # noqa: E402


def _instruments_raw():
    return (knobs.raw("REFLECT_INSTRUMENTS") or "").strip()


def _days_raw():
    return (knobs.raw("REFLECT_INSTRUMENT_DAYS") or "").strip()


def _days():
    import math  # noqa: PLC0415
    raw = _days_raw()
    if not raw:
        return None
    try:
        v = float(raw)
    except ValueError:
        return None
    return v if (math.isfinite(v) and v >= 0) else None


def _age_days(first_seen):
    """Age in days of first_seen (%Y-%m-%d); unparseable => None (if it cannot
    be read, say so)."""
    try:
        d = datetime.strptime(str(first_seen), "%Y-%m-%d").replace(
            tzinfo=timezone.utc)
    except ValueError:
        return None
    return (datetime.now(timezone.utc) - d).total_seconds() / 86400.0


def _constant_return_problems(f, days):
    """Constancy detection: a `first_seen` older than the threshold => "is this
    cmd measuring, or does it always return the same number?\""""
    out = []
    for k in sorted(f):
        entry = f[k] if isinstance(f[k], dict) else {"value": f[k]}
        fs = entry.get("first_seen")
        if not fs:
            out.append(M("instruments.first_seen_unparseable",
                         key=k, first_seen=fs))
            continue
        age = _age_days(fs)
        if age is None:
            out.append(M("instruments.first_seen_unparseable",
                         key=k, first_seen=fs))
        elif age > days:
            out.append(M("instruments.constant_return", key=k,
                         first_seen=fs, days=age, threshold=days))
    return out


def _falsified_hits(text, fixed, f):
    """The ledger keys hit by one falsified snippet (whitespace-normalized)."""
    import re  # noqa: PLC0415
    hits = []
    ntext = re.sub(r"\s+", " ", text).strip()
    for k in sorted(f):
        entry = f[k] if isinstance(f[k], dict) else {"value": f[k]}
        ncmd = re.sub(r"\s+", " ", str(entry.get("cmd") or "")).strip()
        if ntext in ncmd:
            hits.append(M("instruments.falsified_method", key=k, text=text,
                          fixed_in=fixed))
    return hits


def _falsified_method_problems(f, methods):
    """Method registry: any ledger `cmd` containing a falsified snippet =>
    report (a broken measuring method must not stay in the ledger)."""
    out = []
    for m in (methods or []):
        text = str(m.get("text") or "").strip()
        if not text:
            out.append(M("instruments.entry_malformed", entry=m))
            continue
        fixed = m.get("fixed_in") or M("instruments.fixed_in_unregistered")
        out += _falsified_hits(text, fixed, f)
    return out


def problems(ledger, methods=None, days=None):
    """Pure function: return the problem list (empty = green). No printing
    during the selftest.

    `methods` = the method registry (list of falsified measuring methods);
    `days` = the constancy-detection threshold (None = that rule not enabled).
    **The two are independent**: constancy detection handles "the value has
    never changed", the registry handles "the measuring method itself was
    falsified" -- each is its own named helper, each understandable alone.
    """
    f = facts_of(ledger)
    if not f:
        return [M("instruments.ledger_empty")]
    out = []
    if days is not None:
        out += _constant_return_problems(f, days)
    out += _falsified_method_problems(f, methods)
    return out


def run(argv=None):
    _ = argv
    name = _instruments_raw()
    days_raw, days = _days_raw(), _days()
    if days_raw and days is None:
        return fatal(M("instruments.days_unparseable",
                       days_knob="REFLECT_INSTRUMENT_DAYS", value=days_raw))
    if not name and days is None:
        return off(M("instruments.off",
                     days_knob="REFLECT_INSTRUMENT_DAYS",
                     instruments_knob="REFLECT_INSTRUMENTS"))
    led_path = repo(knobs.get("REFLECT_FACTS"))
    if not os.path.exists(led_path):
        return fatal(M("instruments.ledger_missing", path=led_path))
    methods: list[dict[str, object]] = []
    if name:
        reg, _n, rc = gate.load_gate_spec(
            [], "REFLECT_INSTRUMENTS",
            off_msg=lambda _k: M("instruments.off", days_knob="REFLECT_INSTRUMENT_DAYS",
                                 instruments_knob="REFLECT_INSTRUMENTS"),
            missing_msg=lambda k: M("instruments.registry_missing", name=k),
            broken_msg=lambda k, err: M("instruments.spec_broken", name=k, error=err),
        )
        if rc is not None:
            return rc
        if not isinstance(reg, dict):
            return fatal(M("instruments.spec_broken", name=name, error="spec must be an object"))
        raw_methods = reg.get("methods")
        if not isinstance(raw_methods, list) or not raw_methods:
            return fatal(M("instruments.empty_registry", name=name))
        methods = raw_methods
    probs = problems(load_or_fatal(led_path), methods=methods, days=days)
    return finish(M("instruments.title"), probs, _ok_line(name, methods, days))


def _ok_line(name, methods, days):
    """The pass line must state **which modes are on** (otherwise "green" cannot
    distinguish "everything on" from "nothing on")."""
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
        # (1) compliant input: nothing reported
        ("instruments.fresh",
         lambda: problems(led, days=30) == []),
        ("instruments.registered_method_absent",
         lambda: problems(led, methods=methods, days=30) == []),
        ("★ instruments.first_seen_missing",
         lambda: [p.code for p in problems({"facts": {"n": {"value": 1, "cmd": "c"}}}, days=30)]
         == ["instruments.first_seen_unparseable"]),
        # (2) what must be reported is reported
        ("★ instruments.constant_return",
         lambda: [p.code for p in problems(led_old, days=30)]
         == ["instruments.constant_return"]),
        ("★ instruments.first_seen_unparseable",
         lambda: [p.code for p in problems(led_bad, days=30)]
         == ["instruments.first_seen_unparseable"]),
        ("★ instruments.falsified_method",
         lambda: [p.code for p in problems(led_method, methods=methods)]
         == ["instruments.falsified_method"]),
        # the only required field now: a registry entry with no snippet cannot
        # match anything, so it would silently enrol nothing
        ("★ instruments.entry_malformed",
         lambda: [p.code for p in problems(led, methods=[{"fixed_in": "y"}])]
         == ["instruments.entry_malformed"]),
        # (3) empty input must be reported
        ("★ instruments.ledger_empty",
         lambda: [p.code for p in problems({"facts": {}}, days=30)]
         == ["instruments.ledger_empty"]),
    ]


GATE = meta("Instrument lifecycle gate", "constancy detection (first_seen) + falsified-method registry",
            knobs=("REFLECT_INSTRUMENTS", "REFLECT_INSTRUMENT_DAYS", "REFLECT_FACTS"),
            off_reason="both knobs unset => the specialized mechanism is not enabled"
                       " (pluggable; this repo turns it on when needed)")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], "check_instruments", _cases, run))
