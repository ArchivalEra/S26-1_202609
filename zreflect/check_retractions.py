#!/usr/bin/env python3
"""Retraction gate: **a retracted assertion may not quietly return as the
current state.**

Each entry in `retractions.json` = one retracted assertion:
  `text` the search snippet -- the assertion's signature fragment, matched
  verbatim against document lines · `evidence` how to replay the refutation ·
  `fixed_in` where the corrected claim lives now

  There is no `why` field: it would be free prose that nothing reads. The
  evidence command is what explains the correction, and it can be re-run.

Criterion: a retracted assertion (`text`) may **not** appear on any living-state
line in a declared document, even with a history marker; historical accounts
belong in `HISTORY.md` (off every scan surface) or a declared
`REFLECT_HISTORY_SECS` section. This is the only mechanism that raises the alarm
when "a retracted sentence reappears" -- a measured cost: one corrected
assertion survived **in the same file**, and also had a copy in another
document. Prose relies on good intentions; this relies on a gate.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import gate  # noqa: E402
import knobs  # noqa: E402
from facts import living_lines, load_or_fatal  # noqa: E402
from gate import fatal, finish, guard_nonempty, main_selftest_or, meta, repo  # noqa: E402
from i18n import M  # noqa: E402

REQUIRED = ("id", "text", "evidence", "fixed_in")
# **Resolved via the knob helper**: the parse lives in `knobs.history_secs()`
# (the single producer -- `check_stale` reads the same helper), so the two
# gates cannot drift apart on "what counts as a history section".
HIST_SECS = knobs.history_secs()


_PLACEHOLDER_FIXED = frozenset({"tbd", "todo", "none", "n/a", "-", "?"})


_FIXED_ANCHOR = re.compile(
    r"(?:[0-9a-f]{7,}|#\d+|R-\d+|\.[a-z]{2,4}\b|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\(\)))",
    re.I,
)


def _entry_field_problems(retractions):
    """Required fields of every retraction entry (one missing => the ledger
    entry cannot be trusted)."""
    out = []
    for r in retractions:
        for fld in REQUIRED:
            val = str(r.get(fld) or "").strip()
            if not val or (fld == "fixed_in" and val.lower() in _PLACEHOLDER_FIXED):
                out.append(M("retractions.entry_missing_field", field=fld, entry=r.get("id")))
            elif fld == "fixed_in" and not _FIXED_ANCHOR.search(val):
                out.append(M("retractions.fixed_in_needs_anchor", entry=r.get("id"), value=val[:40]))
    return out


def _run_evidence(ev, runner, cache):
    if runner is not None:
        return runner(ev)
    if cache is not None and ev in cache:
        return cache[ev]
    res = gate.run_cmd_cached(ev)
    if cache is not None:
        cache[ev] = res
    return res


_REENTRANT_TOKS = ("check_retractions.py", "check_questions.py", "registry.py --run", "harness.py")


def _evidence_problems(retractions, runner=None, verify_evidence=False, skip_reentrant=False):
    """`evidence` must be **replayable** and pass when `verify_evidence` is enabled."""
    out = []
    cache: dict[str, tuple[int | None, str]] = {}
    for r in retractions:
        ev = r.get("evidence")
        if (not str(ev or "").strip()
                or gate.prose_in_exec_problems(
                    "retractions/%s" % r.get("id", "?"), "evidence", ev)):
            out.append(M("retractions.evidence_not_runnable",
                         entry=r.get("id"), evidence=str(ev)[:60]))
            continue
        if skip_reentrant and any(tok in str(ev) for tok in _REENTRANT_TOKS):
            continue
        if verify_evidence or runner is not None:
            rc, _ = _run_evidence(str(ev), runner, cache)
            if rc != 0:
                out.append(M("retractions.evidence_failed",
                             entry=r.get("id"), rc=str(rc), evidence=str(ev)[:60]))
    return out


def _norm_ws(s):
    return re.sub(r"\s+", " ", s or "").strip().lower()


def _living_chunks(body, hist):
    chunks, buf, start = [], [], None
    for i, line, is_living in living_lines(body or "", hist):
        if is_living and line.strip():
            if start is None:
                start = i
            buf.append(line)
        elif buf:
            chunks.append((start, _norm_ws(" ".join(buf))))
            buf, start = [], None
    if buf:
        chunks.append((start, _norm_ws(" ".join(buf))))
    return chunks


def _resurfaced_problems(retractions, docs, hist):
    """Resurfacing: living-state lines (even split across lines) may **not** contain retracted `text`."""
    out = []
    doc_chunks = {name: _living_chunks(body, hist) for name, body in sorted(docs.items())}
    for r in retractions:
        text = r.get("text") or ""
        ntext = _norm_ws(text)
        if not ntext:
            continue
        for name, chunks in doc_chunks.items():
            for start, norm_chunk in chunks:
                if ntext in norm_chunk:
                    out.append(M("retractions.resurfaced", name=name, line=start,
                                 text=text, entry=r.get("id", "?")))
    return out


def problems(retractions, docs, hist_secs=None, runner=None, verify_evidence=False, skip_reentrant=False):
    """Return the problem list (pure function: the selftest needs that)."""
    hist = HIST_SECS if hist_secs is None else hist_secs
    if retractions is None or "retractions" not in (retractions or {}):
        return [M("retractions.missing_key")]
    if not docs:
        return [M("retractions.no_docs")]
    entries = [r for r in (retractions.get("retractions") or [])
               if isinstance(r, dict)]
    return _entry_problems(entries, docs, hist, runner=runner,
                           verify_evidence=verify_evidence, skip_reentrant=skip_reentrant)


def _entry_problems(entries, docs, hist, runner=None, verify_evidence=False, skip_reentrant=False):
    """Concatenate field completeness, evidence checks, and document resurfacing."""
    return (_entry_field_problems(entries)
            + _evidence_problems(entries, runner=runner, verify_evidence=verify_evidence, skip_reentrant=skip_reentrant)
            + _resurfaced_problems(entries, docs, hist))


def scanned_docs():
    """The list of documents this gate scans (`knobs.docs_names()`, single
    origin)."""
    return knobs.docs_names()


def run(argv):
    # The name is configurable (issue #1, item 2): never hardcoded -- switching
    # repos means changing only the environment variable.
    rp = repo(knobs.get("REFLECT_RETRACTIONS"))
    if not os.path.exists(rp):
        return fatal(M("retractions.file_missing", name=rp))
    docs, missing_docs = {}, []
    for name in (argv or scanned_docs()):
        p = repo(name)
        if os.path.exists(p):
            docs[name] = open(p, encoding="utf-8", errors="replace").read()
        else:
            missing_docs.append(M("retractions.doc_missing", name=name))
    rc = guard_nonempty("check_retractions", docs, M("retractions.scanned_docs"))
    if rc:
        return rc
    depth = gate.trusted_replay_depth()
    if depth < 0 or depth >= 3:
        return fatal(M("replay.too_deep", depth=depth, limit=3))
    led = load_or_fatal(rp)
    probs = missing_docs + gate.with_run_cache(
        lambda: problems(led, docs, verify_evidence=True, skip_reentrant=(depth >= 1)))
    n = len(led.get("retractions") or [])
    return finish(M("retractions.title"), probs,
                  M("retractions.ok", count=n, documents=len(docs)))


def _cases():
    ok_r = {"retractions": [{"id": "R-1", "text": "this thing is green",
                             "evidence": "python3 zreflect/facts.py --check",
                             "fixed_in": "a.py"}]}
    doc_marked = "(record) this thing is green -- retracted, see R-1\n"
    resurf = "retractions.resurfaced"
    ev_bad = "retractions.evidence_not_runnable"
    miss_key = "retractions.missing_key"
    return [
        ("\u2605 retractions.hist_mark_does_not_exempt",
         lambda: [p.code for p in problems(ok_r, {"A.md": doc_marked})]
         == [resurf]),
        ("retractions.assertion_absent",
         lambda: problems(ok_r, {"A.md": "clean document\n"}) == []),
        ("retractions.no_retractions",
         lambda: problems({"retractions": []}, {"A.md": "x\n"}) == []),
        ("retractions.declared_history_section",
         lambda: problems(ok_r, {"A.md": "## 5 history\nthis thing is green.\n"},
                          hist_secs=("5",)) == []),
        ("★ retractions.resurfaced",
         lambda: [p.code for p in problems(
             ok_r, {"A.md": "this thing is green.\n"})] == [resurf]),
        ("★ retractions.resurfaced_undeclared_history",
         lambda: [p.code for p in problems(
             ok_r, {"A.md": "## 5 history\nthis thing is green.\n"}, hist_secs=())]
         == [resurf]),
        ("\u2605 retractions.entry_missing_field",
         lambda: [p.code for p in problems(
             {"retractions": [{"id": "R-2", "text": "t", "fixed_in": "a.py"}]},
             {"A.md": "x\n"})]
         == ["retractions.entry_missing_field", ev_bad]),
        ("\u2605 retractions.evidence_not_runnable",
         lambda: [p.code for p in problems(
             {"retractions": [{"id": "R-3", "text": "t",
                               "evidence": "a subagent report",
                               "fixed_in": "a.py"}]}, {"A.md": "x\n"})]
         == [ev_bad]),
        ("★ retractions.fixed_in_prose_rejected",
         lambda: [p.code for p in problems(
             {"retractions": [{"id": "R-4", "text": "t", "evidence": "python3 a.py",
                               "fixed_in": "somewhere later"}]},
             {"A.md": "x\n"}, runner=lambda _c: (0, "ok"))]
         == ["retractions.fixed_in_needs_anchor"]),
        ("★ retractions.multiline_resurfaced",
         lambda: [p.code for p in problems(
             ok_r, {"A.md": "this thing\nis green.\n"}, runner=lambda _c: (0, "ok"))]
         == [resurf]),
        ("★ retractions.no_docs",
         lambda: [p.code for p in problems(ok_r, {})] == ["retractions.no_docs"]),
        ("★ retractions.missing_key",
         lambda: [p.code for p in problems({}, {"A.md": "x\n"})]
         == [miss_key]),
        ("★ retractions.missing_key_none",
         lambda: [p.code for p in problems(None, {"A.md": "x\n"})]
         == [miss_key]),
        ("★ retractions.evidence_failed",
         lambda: [p.code for p in problems(
             ok_r, {"A.md": "clean\n"}, runner=lambda _c: (1, "fail"))]
         == ["retractions.evidence_failed"]),
        ("★ retractions.depth_one_still_scans_resurfaced",
         lambda: [p.code for p in problems(
             {"retractions": [{"id": "R-2", "text": "this thing is green",
                               "evidence": "python3 zreflect/check_questions.py",
                               "fixed_in": "a.py"}]},
             {"A.md": "this thing is green\n"}, verify_evidence=True, skip_reentrant=True)]
         == [resurf]),
    ]


GATE = meta("Retraction-resurfacing check", "a retracted assertion may not quietly return as the current state",
            knobs=("REFLECT_RETRACTIONS", "REFLECT_DOCS", "REFLECT_HISTORY_SECS"), name_dependent=True)

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], "check_retractions", _cases, run))
