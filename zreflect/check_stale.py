#!/usr/bin/env python3
"""Stale-assertion gate: sha assertions in living state must have provenance,
and retired names must not come back as current state.

Migrated and generalized from Octave-Full-Wasm's `.githooks/check-handoff.py`
(there it was four project rules, L1-L4; what survives here is the **mechanism**,
fed by each repo's own ledger and retired list):

  **R1 provenance of sha assertions** (generalization of the original L1)
  In living-state text, a hex string near the words sha / hash / checksum /
  fingerprint has three possible homes:
      (1) it is a fact in the ledger (the full string or the rendered 16-char
          prefix matches);
      (2) that line carries a historical marker (history / retracted /
          overturned ...);
      (3) that line carries **explicit provenance** (delivery-package name, a
          backticked commit sha).
  None of the three => it is an unsourced "this is how it is now" -- the kind
  that still hangs an old sha after the build changed.
  The shape bitten over there: after switching to a GL build, the header kept
  the old sha and nobody noticed.
  Warning: both escapes (historical marker / explicit provenance) were paid
  for in blood. Without a history escape, people can only delete history; if
  the escape is written as "any bare sha", a fake assertion gets a whole-line
  exemption (that repo measured one such miss).

  **R2 retired names** (generalization of the original L3)
  A retired component name appearing in living state as a **standalone word**
  is an assertion of "still using it".
  Warning: standalone-word is required -- a retired word inside a branch name
  / file name is **giving directions** (a historical record), not an assertion
  about current state. Configure the list with `REFLECT_RETIRED`
  (comma-separated); unset = this rule is **declared off**, not silently
  pretended to be checked.

  History sections are declared with `REFLECT_HISTORY_SECS` (e.g. `5,9,10`)
  -- sections whose numbers do not match still count as living state.

Usage:
  python3 zreflect/check_stale.py            # nonzero on violations (pre-commit / pre-push)
  python3 zreflect/check_stale.py --list     # list only, never changes, always 0 (manual patrol)
  python3 zreflect/check_stale.py --selftest
"""
import os
import re
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import knobs  # noqa: E402
from facts import (  # noqa: E402
    CITE_RE,
    DATED_RECORD,
    age_days,
    facts_of,
    living_lines,
    load_or_fatal,
    value_of,
)
from gate import fatal, finish, guard_nonempty, main_selftest_or, meta, repo  # noqa: E402
from i18n import M, Message  # noqa: E402

# **Resolved via the knob helper**: the parse lives in `knobs.history_secs()`
# (single origin shared with `check_retractions`).
HIST_SECS = knobs.history_secs()


def _retired():
    """The retired-name list (`REFLECT_RETIRED`; unset or empty => empty)."""
    raw = knobs.raw("REFLECT_RETIRED")
    if not raw:
        return ()
    return tuple(s.strip() for s in raw.split(",") if s.strip())


def _stale_days_status():
    """Return `(float_days_or_None, bad_raw_or_None)` for `REFLECT_STALE_DAYS`."""
    import math  # noqa: PLC0415
    raw = (knobs.raw("REFLECT_STALE_DAYS") or "").strip()
    if not raw:
        return None, None
    try:
        v = float(raw)
    except ValueError:
        return None, raw
    if not math.isfinite(v) or v < 0:
        return None, raw
    return v, None


def _stale_days():
    """Age-check alert threshold (`REFLECT_STALE_DAYS`); unset/bad => None."""
    return _stale_days_status()[0]

SHA_NEAR = re.compile(r"sha|hash|commit|digest|checksum|校验|指纹", re.I)
SHA_TOKEN = re.compile(r"(?<![0-9A-Fa-f`])([0-9A-Fa-f]{8,64})(?![0-9A-Fa-f`])")


def _sha_facts(f):
    """sha-class fact values in the ledger (a 64-char string IS a sha; strings
    of other lengths are not guessed at)."""
    out = set()
    for entry in (f or {}).values():
        v = value_of(entry)
        if isinstance(v, str) and re.fullmatch(r"[0-9a-f]{64}", v or ""):
            out.add(v)
    return out


# Cited provenance (issue #25): `[[key]]` points into the ledger -- unlike a
# "history" marker, it is a **re-playable** anchor.


def _has_dated_record(line):
    """A delivery-package name with an 8-digit date, or a commit sha inside
    backticks, is verifiable provenance (`DATED_RECORD`).
    """
    return bool(DATED_RECORD.search(line))


def _has_ledger_citation(line, f=None):
    """`[[key]]` is a re-playable citation of an existing ledger fact (`CITE_RE`)."""
    keys = CITE_RE.findall(line)
    if not keys:
        return False
    return True if f is None else any(k in f for k in keys)


def _is_sourced(line, f=None):
    """Does this line carry **explicit, verifiable** provenance?"""
    return _has_dated_record(line) or _has_ledger_citation(line, f)


def _sha_assertion_problems(f, docs, hist):
    """R1: hex strings near sha / hash words in living state need verifiable provenance."""
    out = []
    shas = _sha_facts(f)
    for name, body in sorted(docs.items()):
        for lineno, line, is_living in living_lines(body, hist):
            out += _sha_line_problems(name, lineno, line, is_living, shas, f)
    return out


def _sha_line_problems(name, lineno, line, is_living, shas, f=None):
    """Per-line sha provenance verdict (per-token, no whole-line exemption)."""
    if not is_living or not SHA_NEAR.search(line):
        return []
    cleaned = DATED_RECORD.sub(" ", line)
    toks = SHA_TOKEN.findall(cleaned)
    if not toks:
        return []
    if not shas:
        return [M("stale.sha_no_facts", name=name, lineno=lineno)]
    cited = {str(value_of(f[k])).lower() for k in CITE_RE.findall(line)
             if f and k in f and isinstance(value_of(f[k]), str)}
    return [M("stale.sha_unsourced", name=name, lineno=lineno, actual=tok[:16])
            for tok in toks
            if tok.lower() not in cited
            and not any(tok.lower() == s or s.startswith(tok.lower()) or tok.lower().startswith(s[:len(tok)])
                        for s in shas)]


def _stale_age_problems(f, sd):
    """Age check (issue #3 item 2): report when a ledger fact's measured_at is
    more than the threshold days from today.

    Unconfigured (sd is None) => no check (declared off); unreadable timestamp
    => also reported (say so when unreadable, never guess 0).
    """
    out: list[Message] = []
    if sd is None:
        return out
    for k in sorted(f):
        d = age_days(f[k])
        if d is None:
            out.append(M("stale.measured_at_missing", key=k))
        elif d > sd:
            # Round at the emission point: the original copy was %.0f, and the
            # null pack (no language pack) must display with the same
            # convention -- otherwise the bare repr spews noise like
            # 2495.6510176482525.
            out.append(M("stale.too_old", key=k, days=round(d),
                         threshold=round(sd)))
    return out


def _retired_name_problems(docs, hist, retired):
    """R2 retired names: a standalone-word occurrence in living state =>
    report.

    List unconfigured = rule off (run() says so explicitly; nothing printed
    here -- pure functions stay quiet).
    """
    out = []
    for name, body in sorted(docs.items()):
        for lineno, line, is_living in living_lines(body, hist):
            if not is_living:
                continue
            cleaned = DATED_RECORD.sub(" ", line)
            for w in retired:
                if re.search(r"(?<![0-9A-Za-z_-])%s(?![0-9A-Za-z_.-])" % re.escape(w),
                             cleaned, re.I):
                    out.append(M("stale.retired_name", name=name, lineno=lineno,
                                 entry=w))
    return out


_UNSET = object()


def problems(ledger, docs, retired=_UNSET, hist_secs=None, stale_days=_UNSET):
    """Return the problem list (pure function: the selftest depends on that).
    `ledger` = the loaded ledger; `docs` = {file name: body}.

    Empty ledger => `stale.ledger_empty`; empty `docs` => `stale.no_docs`
    (empty is not a pass). Otherwise `_problem_layers` resolves the three knobs
    and returns reports in R1 -> age -> R2 order.
    """
    f = facts_of(ledger)
    if not f:
        return [M("stale.ledger_empty")]
    if not docs:
        return [M("stale.no_docs")]
    return _problem_layers(f, docs, hist_secs, stale_days, retired)


def _problem_layers(f, docs, hist_secs, stale_days, retired):
    """The three criterion layers in report order: R1 sha provenance, age check,
    R2 retired names. One layer = one function, concatenated.

    `hist_secs=None` => `HIST_SECS`; `stale_days=None` => off (`_UNSET` => `_stale_days()`);
    `retired=()` => off (`_UNSET` => `_retired()`).
    """
    hist = HIST_SECS if hist_secs is None else hist_secs
    sd = _stale_days() if stale_days is _UNSET else stale_days
    retired_names = _retired() if retired is _UNSET else retired
    return (_sha_assertion_problems(f, docs, hist)
            + _stale_age_problems(f, sd)
            + _retired_name_problems(docs, hist, retired_names))


def _load_docs(names):
    """Read living-state docs. Ones that **cannot be read** do not enter
    `docs` (`guard_nonempty` rules on emptiness)."""
    docs = {}
    for name in names:
        p = repo(name)
        if os.path.exists(p):
            docs[name] = open(p, encoding="utf-8", errors="replace").read()
    return docs


def scanned_docs():
    """The **list of files** this gate scans (`knobs.docs_names()`, the single
    source of truth). Returns a list of names, not a {name: body} dict.
    """
    return knobs.docs_names()


def run(argv):
    days, bad_days = _stale_days_status()
    if bad_days is not None:
        return fatal(M("stale.bad_days", value=bad_days))
    docs = _load_docs(scanned_docs())
    rc = guard_nonempty("check_stale", docs, M("stale.scanned_docs"))
    if rc:
        return rc
    facts_name = knobs.get("REFLECT_FACTS")
    if not os.path.exists(repo(facts_name)):
        return fatal(M("stale.ledger_missing", name=facts_name))
    probs = problems(load_or_fatal(repo(facts_name)), docs)
    retired = _retired()
    if not probs:
        if not retired:
            print(M("stale.retired_rule_off"), file=sys.stderr)
        if days is None:
            print(M("stale.age_rule_off"), file=sys.stderr)
    return finish(M("stale.title"), probs,
                  M("stale.ok", count=len(docs),
                    declared=M("stale.retired_none") if not retired
                    else M("stale.retired_count", count=len(retired))))


def _cases_fixture():
    """Fixture (the setup section of the original `_cases`, moved verbatim)."""
    led_sha = {"facts": {"site_sha": {"value": "a" * 64, "cmd": "sha256sum x", "source": "s"}}}
    led_plain = {"facts": {"n": {"value": 7, "cmd": "echo 7", "source": "s"}}}
    bare = "deployed sha256 deadbeefdeadbeef00cafe00\n"
    fresh = (datetime.now(timezone.utc) - timedelta(days=1)).strftime(
        "%Y-%m-%dT%H:%M:%S%z")
    led_fresh = {"facts": {"n": {"value": 7, "cmd": "echo 7", "source": "s",
                                 "measured_at": fresh}}}
    led_old = {"facts": {"n": {"value": 7, "cmd": "echo 7", "source": "s",
                               "measured_at": "2020-01-01T00:00:00+0000"}}}
    return {'led_sha': led_sha, 'led_plain': led_plain, 'bare': bare, 'fresh': fresh, 'led_fresh': led_fresh, 'led_old': led_old}


def _cases_sha(fx):
    """See `_cases()`: 8 cases in this group."""
    led_sha, led_plain, bare = fx["led_sha"], fx["led_plain"], fx["bare"]
    return [
    ("stale.sourced_history_sha",
     lambda: problems(led_plain, {"A.md": "old sha `abc1234` (retracted)\n"},
                      stale_days=None, retired=())
     == []),
    ("★ stale.dated_record_does_not_exempt_other_sha",
     lambda: [p.code for p in problems(
         led_sha, {"A.md": "deployed sha DEADBEEF00 -20260101\n"},
         stale_days=None, retired=())] == ["stale.sha_unsourced"]),
    # (2) Reverse criterion (issue #25): a historical marker is **no longer**
    # a get-out-of-jail card
    ("★ stale.sha_no_facts·history_mark",
     lambda: [p.code for p in problems(
         led_plain, {"A.md": "deployed sha256 history is 8287589ebdb53b4c\n"},
         stale_days=None, retired=())]
     == ["stale.sha_no_facts"]),
    ("stale.cite_anchor",
     lambda: problems(led_sha, {"A.md": "old sha256 [[site_sha]] retracted\n"},
                      stale_days=None, retired=()) == []),
    ("stale.no_sha_assertion",
     lambda: problems(led_plain, {"A.md": "a fine day\n"},
                      stale_days=None, retired=()) == []),
    ("stale.declared_history_section",
     lambda: problems(led_plain, {"A.md": "## 5 history\n" + bare}, hist_secs=("5",),
                      stale_days=None, retired=())
     == []),
    # (2) What must be reported gets reported
    ("★ stale.sha_unsourced",
     lambda: [p.code for p in problems(led_sha, {"A.md": bare},
                                       stale_days=None, retired=())]
     == ["stale.sha_unsourced"]),
    ("★ stale.sha_no_facts",
     lambda: [p.code for p in problems(led_plain, {"A.md": bare},
                                       stale_days=None, retired=())]
     == ["stale.sha_no_facts"]),
    ("★ stale.sha_no_facts·undeclared_section",
     lambda: [p.code for p in problems(
         led_plain, {"A.md": "## 5 history\n" + bare}, hist_secs=(""),
         stale_days=None, retired=())
     ] == ["stale.sha_no_facts"]),
    ]


def _cases_retired(fx):
    """See `_cases()`: 4 cases in this group."""
    led_plain = fx["led_plain"]
    return [
    ("stale.retired_unconfigured",
     lambda: problems(led_plain, {"A.md": "still using the old component\n"},
                      stale_days=None, retired=()) == []),
    ("stale.retired_reference",
     lambda: problems(led_plain, {"A.md": "see NOTES-osmesa.md and the osmesa-branch\n"},
                      stale_days=None, retired=("osmesa",)) == []),
    ("★ stale.retired_name",
     lambda: [p.code for p in problems(
         led_plain, {"A.md": "backend still uses osmesa\n"},
         stale_days=None, retired=("osmesa",))]
     == ["stale.retired_name"]),
    ("★ stale.retired_name·unnumbered_section",
     lambda: [p.code for p in problems(
         led_plain, {"A.md": "## FAQ\nstill using osmesa\n"},
         stale_days=None, retired=("osmesa",))]
     == ["stale.retired_name"]),
    ]


def _cases_age(fx):
    """See `_cases()`: 4 cases in this group."""
    led_plain, led_fresh, led_old = fx["led_plain"], fx["led_fresh"], fx["led_old"]
    return [
    # (2) Age check (issue #3 item 2)
    ("stale.age_fresh",
     lambda: problems(led_fresh, {"A.md": "x\n"}, stale_days=30, retired=()) == []),
    ("stale.age_rule_off",
     lambda: problems(led_old, {"A.md": "x\n"}, stale_days=None, retired=()) == []),
    ("★ stale.too_old",
     lambda: [p.code for p in problems(
         led_old, {"A.md": "x\n"}, stale_days=30, retired=())] == ["stale.too_old"]),
    ("★ stale.measured_at_missing",
     lambda: [p.code for p in problems(
         led_plain, {"A.md": "x\n"}, stale_days=30, retired=())]
     == ["stale.measured_at_missing"]),
    ]


def _cases_empty(fx):
    """See `_cases()`: 3 cases in this group."""
    led_sha, led_plain = fx["led_sha"], fx["led_plain"]
    return [
    # (1) Normal case: no report
    ("stale.ok",
     lambda: problems(led_sha,
                      {"A.md": "deployed sha256 %s... (truncated)\n" % ("a" * 16)},
                      hist_secs=HIST_SECS, stale_days=None, retired=()) == []),
    # (3) Empty input must be reported
    ("★ stale.ledger_empty",
     lambda: [p.code for p in problems({"facts": {}}, {"A.md": "x\n"},
                                       hist_secs=HIST_SECS, stale_days=None, retired=())]
     == ["stale.ledger_empty"]),
    ("★ stale.no_docs",
     lambda: [p.code for p in problems(led_plain, {},
                                       hist_secs=HIST_SECS, stale_days=None, retired=())] == ["stale.no_docs"]),
    ]


def _cases():
    """Assemble the 4 fixture groups. **Assembly only** -- the criteria live in
    the per-group functions."""
    fx = _cases_fixture()
    return (
    _cases_sha(fx)
    + _cases_retired(fx)
    + _cases_age(fx)
    + _cases_empty(fx)
    )


GATE = meta("Stale-assertion gate", "sha provenance / retired names / age check",
            knobs=("REFLECT_DOCS", "REFLECT_FACTS", "REFLECT_HISTORY_SECS",
                   "REFLECT_RETIRED", "REFLECT_STALE_DAYS"),
            name_dependent=True)

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], "check_stale", _cases, run))
