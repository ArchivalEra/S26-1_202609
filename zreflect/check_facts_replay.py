#!/usr/bin/env python3
"""Replay gate: run ledger fact and principle commands verbatim with command deduplication."""
from __future__ import annotations

import os
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import doc  # noqa: E402
import i18n  # noqa: E402
import knobs  # noqa: E402
from facts import facts_of, load_or_fatal, value_of  # noqa: E402
from gate import (  # noqa: E402
    default_timeout,
    fatal,
    finish,
    main_selftest_or,
    meta,
    off,
    quote,
    repo,
    run_cmd_cached,
    timeout_with_status,
)
from i18n import Catalog, M, bind, load_pack  # noqa: E402

_DEPTH_ENV = "EINFACHT_REPLAY_DEPTH"
_MAX_DEPTH = 3


def _judge_ok(k, entry, cmd, stdout, out, stats, rule_keys=()):
    if entry.get("kind") == "principle" and k in rule_keys:
        got = stdout.strip()
        if not got:
            out.append(M("replay.principle_said_nothing", key=k, command=cmd))
            return
        if any(kind in ("off", "skip") for _i, kind, _ln in i18n.scan(got)):
            out.append(M("replay.principle_is_off", key=k, command=cmd, detail=quote(got[:120])))
            return
        stats["ok"] += 1
        return
    expected = str(value_of(entry))
    if not expected.strip():
        out.append(M("replay.empty_value", key=k))
        return
    if stdout.strip() != expected:
        out.append(M("replay.mismatch", key=k, command=cmd,
                     actual=quote(stdout.strip()), expected=quote(expected)))
        return
    stats["ok"] += 1


def _replay_one(k, raw_entry, run, seconds, out, stats, cache, rule_keys=()):
    entry = raw_entry if isinstance(raw_entry, dict) else {"value": raw_entry}
    cmd = str(entry.get("cmd") or "").strip()
    if entry.get("replay") is False:
        out.append(M("replay.skip_is_gone", key=k))
        return
    if not cmd:
        out.append(M("replay.no_cmd", key=k))
        return
    stats["attempts"] += 1
    if cmd not in cache:
        cache[cmd] = run(cmd)
    rc, stdout = cache[cmd]
    if rc is None:
        out.append(M("replay.timeout", key=k, seconds=seconds, command=cmd))
        return
    if rc != 0:
        out.append(M("replay.command_failed", key=k, return_code=rc,
                     command=cmd, detail=quote(stdout.strip()[:200])))
        return
    stats["ran"] += 1
    _judge_ok(k, entry, cmd, stdout, out, stats, rule_keys=rule_keys)


def _probe_one(key, raw_entry, run, seconds, out, stats, gate_mod):
    entry = raw_entry if isinstance(raw_entry, dict) else {"value": raw_entry}
    if "calibrate" not in entry:
        return
    probe = str(entry.get("calibrate") or "").strip()
    if not probe or gate_mod.prose_in_exec_problems("facts/%s" % key, "calibrate", probe):
        out.append(M("replay.calibrate_command_failed", key=key, return_code=2, command=probe))
        return
    if entry.get("calibrate_expect") is None:
        out.append(M("replay.calibrate_missing_expect", key=key))
        return
    stats["calibrate_attempts"] += 1
    rc, stdout = run(probe)
    want = str(entry.get("calibrate_expect"))
    if rc is None:
        out.append(M("replay.calibrate_timeout", key=key, seconds=seconds, command=probe))
    elif rc != 0:
        out.append(M("replay.calibrate_command_failed", key=key, return_code=rc, command=probe))
    elif stdout.strip() != want:
        out.append(M("replay.calibrate_mismatch", key=key,
                     actual=quote(stdout.strip()), expected=quote(want)))
    else:
        stats["calibrated"] += 1


def _run_probes(f, run, seconds, out, stats):
    import gate  # noqa: PLC0415
    for key in sorted(f):
        _probe_one(key, f[key], run, seconds, out, stats, gate)


def replay_all(ledger, runner=None, *, include_principles=False):
    """Replay ledger entries and optionally active rules, deduplicating commands."""
    f, rule_keys = _replay_entries(ledger, include_principles)
    if runner is None:
        try:
            depth = int(os.environ.get(_DEPTH_ENV, "0") or 0)
        except ValueError:
            depth = 0
        if depth < 0 or depth >= _MAX_DEPTH:
            return {"problems": [M("replay.too_deep", depth=depth, limit=_MAX_DEPTH)],
                    "ok": 0, "attempts": 0, "ran": 0, "calibrate_attempts": 0, "calibrated": 0}
    run = runner or run_cmd_cached
    stats: dict[str, Any] = {
        "ok": 0, "attempts": 0, "ran": 0, "calibrate_attempts": 0, "calibrated": 0,
        "problems": [],
    }
    if not f:
        stats["problems"] = [M("replay.empty_ledger")]
        return stats
    out: list[i18n.Message] = []
    cache: dict[str, tuple[int | None, str]] = {}
    seconds = default_timeout()
    for k in sorted(f):
        _replay_one(k, f[k], run, seconds, out, stats, cache, rule_keys=rule_keys)
    if stats["attempts"] and stats["ran"] == 0:
        out.append(M("replay.none_ran", attempts=stats["attempts"]))
    _run_probes(f, run, seconds, out, stats)
    stats["problems"] = out
    return stats


def _replay_entries(ledger, include_principles):
    entries = facts_of(ledger)
    rules = doc.facts_of_rules() if doc.accepts_principles() else {}
    return ({**entries, **rules} if include_principles else entries), set(rules)


def run(argv):
    _ = argv
    if knobs.flag("REFLECT_REPLAY") is False:
        return off(M("replay.off"))
    seconds, bad_timeout = timeout_with_status()
    if bad_timeout is not None:
        return fatal(M("replay.bad_timeout", value=bad_timeout, default=seconds))
    name = knobs.get("REFLECT_FACTS")
    p = repo(name)
    if not os.path.exists(p):
        return fatal(M("replay.ledger_missing", name=name))
    import trust  # noqa: PLC0415
    pre_probs = doc.local_rules_problems(repo()) + trust.check_principles_repo(repo()) + trust.check_knobs_anchor(repo())
    if pre_probs:
        return finish(M("replay.title"), pre_probs, M("replay.ok", count=0, calibrated=""))
    r = replay_all(load_or_fatal(p), include_principles=True)
    ctail = str(M("replay.ok_calibrated", count=r["calibrated"]) if r["calibrated"] else "")
    return finish(M("replay.title"), r["problems"], M("replay.ok", count=r["ok"], calibrated=ctail))


def _selftest_principles_loaded_once():
    from unittest.mock import patch  # noqa: PLC0415

    import trust  # noqa: PLC0415
    name = "principle.only_measured"
    rules = {name: {"value": "rule", "cmd": "rule", "kind": "principle"}}
    with (patch.object(doc, "accepts_principles", return_value=True),
          patch.object(doc, "facts_of_rules", return_value=rules) as load,
          patch.object(doc, "local_rules_problems", return_value=[]),
          patch.object(trust, "check_principles_repo", return_value=[]),
          patch.object(trust, "check_knobs_anchor", return_value=[]),
          patch.object(os.path, "exists", return_value=True),
          patch.object(sys.modules[__name__], "load_or_fatal", return_value={"facts": {}}),
          patch.object(sys.modules[__name__], "run_cmd_cached", return_value=(0, "measured"))):
        return run([]) == 0 and load.call_count == 1


def _selftest_ledger_extracted_once():
    from unittest.mock import patch  # noqa: PLC0415

    import facts  # noqa: PLC0415
    ledger = {"facts": {"n": {"value": 12, "cmd": "c"}}}
    calls: list[str] = []
    real_local, real_facts = facts_of, facts.facts_of

    def count_local(*a, **k):
        calls.append("local")
        return real_local(*a, **k)

    def count_facts(*a, **k):
        calls.append("facts")
        return real_facts(*a, **k)

    with (patch.object(sys.modules[__name__], "facts_of", count_local),
          patch.object(facts, "facts_of", count_facts),
          patch.object(doc, "accepts_principles", return_value=False)):
        stats = replay_all(ledger, runner=lambda _c: (0, "12"), include_principles=True)
    if stats["problems"] or calls != ["local"]:
        return False
    calls.clear()
    with (patch.object(sys.modules[__name__], "facts_of", count_local),
          patch.object(facts, "facts_of", count_facts)):
        stats = replay_all(ledger, runner=lambda _c: (0, "12"))
    return not stats["problems"] and calls == ["local"]


def _cases():
    led = {"facts": {"n": {"value": 12, "cmd": "c"}}}
    two = {"facts": {"a": {"value": 1, "cmd": "x"}, "b": {"value": 2, "cmd": "y"}}}
    cal = {"facts": {"obj": {"value": "ok", "cmd": "c1", "calibrate": "python3 -c 'print(2)'", "calibrate_expect": "k"}}}
    seen = []
    dup_led = {"facts": {"a": {"value": 1, "cmd": "same"}, "b": {"value": 1, "cmd": "same"}}}

    def trace_run(c):
        seen.append(c)
        return (0, "1")

    pack_lang = i18n.a_pack_lang()
    real_pack = load_pack(pack_lang) if pack_lang else {}

    def hint_has(runner, *anchors):
        if not pack_lang:
            return True
        with bind(Catalog.load(pack_lang, {pack_lang: real_pack})):
            return any(all(a in str(p) for a in anchors)
                       for p in replay_all(led, runner=runner)["problems"])

    none_ran = "replay.none_ran"
    return [
        ("replay.principle_snapshot_loaded_once", _selftest_principles_loaded_once),
        ("★ replay.ledger_extracted_once", _selftest_ledger_extracted_once),
        ("replay.ok_trailing_newline",
         lambda: replay_all(led, runner=lambda c: (0, "12\n"))["problems"] == []),
        ("replay.deduplicates_identical_cmds",
         lambda: replay_all(dup_led, runner=trace_run)["problems"] == [] and len(seen) == 1),
        ("★ replay.mismatch_repair_hint",
         lambda: [p.code for p in replay_all(led, runner=lambda c: (0, "13"))["problems"]]
         == ["replay.mismatch"] and hint_has(lambda c: (0, "13"), "accept-changes", "facts.py")),
        ("★ replay.command_failed",
         lambda: [p.code for p in replay_all(led, runner=lambda c: (1, ""))["problems"]]
         == ["replay.command_failed", none_ran]),
        ("★ replay.timeout_cold_start_hint",
         lambda: [p.code for p in replay_all(led, runner=lambda c: (None, ""))["problems"]]
         == ["replay.timeout", none_ran]
         and hint_has(lambda c: (None, ""), "REFLECT_REPLAY_TIMEOUT")),
        ("★ replay.no_cmd",
         lambda: [p.code for p in replay_all({"facts": {"n": {"value": 1}}}, lambda c: (0, "1"))["problems"]]
         == ["replay.no_cmd"]),
        ("★ replay.empty_ledger",
         lambda: [p.code for p in replay_all({"facts": {}}, lambda c: (0, ""))["problems"]]
         == ["replay.empty_ledger"]),
        ("★ replay.none_ran",
         lambda: [p.code for p in replay_all(two, runner=lambda c: (1, ""))["problems"]][-1]
         == none_ran),
        ("★ replay.skip_is_gone",
         lambda: [p.code for p in replay_all({"facts": {"a": {"value": 1, "cmd": "x", "replay": False}}},
                                             lambda c: (0, "1"))["problems"]] == ["replay.skip_is_gone"]),
        ("replay.calibrate_ok",
         lambda: replay_all(cal, runner=lambda c: (0, "ok") if c == "c1" else (0, "k"))["calibrated"] == 1),
        ("★ replay.calibrate_mismatch",
         lambda: [p.code for p in replay_all(cal, runner=lambda c: (0, "ok") if c == "c1" else (0, "bad"))["problems"]]
         == ["replay.calibrate_mismatch"]),
        ("★ replay.bad_timeout_fatals", lambda: _bad_timeout_fatals_ok()),
        ("★ replay.principle_skip_rejected", lambda: (
            [p.code for p in replay_all(
                {"facts": {"principle.only_measured": {"value": "ok", "cmd": "c", "kind": "principle"}}},
                runner=lambda _c: (0, "SKIP: nope\n"))["problems"]] == ["replay.principle_is_off"])),
    ]


def _bad_timeout_fatals_ok():
    import contextlib  # noqa: PLC0415
    import io  # noqa: PLC0415
    saved = os.environ.get("REFLECT_REPLAY_TIMEOUT")
    os.environ["REFLECT_REPLAY_TIMEOUT"] = "abc"
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            return run([]) == 2
    finally:
        if saved is None:
            os.environ.pop("REFLECT_REPLAY_TIMEOUT", None)
        else:
            os.environ["REFLECT_REPLAY_TIMEOUT"] = saved


GATE = meta("Replay gate", "ledger cmds re-run verbatim (bare-value contract: stdout must equal the value)",
            knobs=("REFLECT_FACTS", "REFLECT_REPLAY", "REFLECT_REPLAY_TIMEOUT"),
            name_dependent=True,
            off_reason="closes only when REFLECT_REPLAY=off is explicitly set")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], M("gate.title.facts_replay"), _cases, run))
