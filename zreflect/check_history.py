#!/usr/bin/env python3
"""HISTORY: **the one place prose is allowed to live.**

Everything else in this suite is a criterion or a rendered block. HISTORY is
where "how we got here" goes: why a rule exists, what it replaced, which
mistake taught it. That account is reproducible only "under the conditions of
that moment" -- you cannot use today's artifacts to prove it was right -- so it
is deliberately **outside the measured surface**.

## The one invariant that makes the exception honest

"Not scanned" is a claim, and a claim with no criterion is exactly what this
repo exists to eliminate. So the exception is guarded from the other side: this
module proves the history document is **not on any scan surface** --

  * not in `REFLECT_DOCS` (the documents `check_stale` / `check_retractions`
    read as living state),
  * not in `REFLECT_READMES` (the trilingual trio),
  * not inside `REFLECT_QUESTIONS` (the question ledger),
  * not the ledger itself.

If someone adds `HISTORY.md` to `REFLECT_DOCS`, its "as it was then" lines
become live-state claims and every stale assertion in it goes red -- so the
guard reports that instead of letting it happen.

## Interface

    location() -> absolute path of the history document
    is_exempt(path, knobs_surfaces) -> bool
    problems(surfaces) -> problem list

Small on purpose: the caller passes the surfaces it knows about, and gets back
what is wrong. Nothing here knows how the documents are scanned.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gate  # noqa: E402
import knobs  # noqa: E402
from gate import main_selftest_or, meta, module_meta, off  # noqa: E402
from i18n import M  # noqa: E402


def location():
    """Absolute path of the history document (`REFLECT_HISTORY`)."""
    return gate.repo_path(knobs.get("REFLECT_HISTORY"))


def surfaces():
    """The scan surfaces the exemption must stay out of: `{knob: [paths]}`."""
    return {
        "REFLECT_DOCS": list(knobs.docs_names()),
        "REFLECT_READMES": list(knobs.readme_names()),
        "REFLECT_QUESTIONS": [knobs.questions_path()],
        "REFLECT_FACTS": [knobs.get("REFLECT_FACTS")],
    }


def _norm(path):
    return os.path.normcase(os.path.realpath(str(path)))


def is_exempt(path, known=None, root=None):
    """Whether `path` lies outside every scan surface.

    A path is on a surface when it equals a declared document, or lies inside a
    declared directory. Both forms appear in practice (`REFLECT_DOCS` lists
    files, `REFLECT_QUESTIONS` names a directory).

    Declared entries are resolved against `root` (default: the audited repo);
    the selftest passes a fake root so the criterion is exercised without
    touching this checkout.
    """
    base_root = root or gate.GATE_REPO
    target = _norm(path)
    for _knob, entries in (known if known is not None else surfaces()).items():
        for entry in entries:
            if not str(entry or "").strip():
                continue
            base = _norm(entry if os.path.isabs(entry)
                         else os.path.join(base_root, entry))
            if target == base:
                return False
            # A **declared directory** contains everything beneath it. Deciding
            # by `os.path.isdir` alone would make the answer depend on the
            # filesystem; an entry with no suffix that is not a known file is a
            # directory for this purpose.
            if target.startswith(base + os.sep):
                return False
    return True


def _content_problems(target):
    """Lightweight format check: non-empty, has a `#` title and a prose/quote line."""
    try:
        body = open(target, encoding="utf-8", errors="replace").read()
    except OSError:
        return [M("history.empty_or_malformed", path=target)]
    lines = [ln.strip() for ln in body.splitlines() if ln.strip()]
    has_title = any(ln.startswith("# ") and len(ln) > 2 for ln in lines)
    has_prose = any(not ln.startswith("#") for ln in lines)
    if not (has_title and has_prose):
        return [M("history.empty_or_malformed", path=target)]
    return []


def problems(known=None, path=None):
    """The exemption's own criterion: history must exist and stay unscanned.

    `path` is injectable so the selftest can exercise both branches without
    depending on this checkout's own HISTORY.md.
    """
    known = surfaces() if known is None else known
    target = location() if path is None else path
    out = []
    if not os.path.exists(target):
        out.append(M("history.missing", path=target))
    else:
        out += _content_problems(target)
    if not is_exempt(target, known):
        out.append(M("history.on_scan_surface", path=target))
    return out


def is_configured():
    """Explicitly blanked (`REFLECT_HISTORY=`) => this repo keeps no history.

    Unset is different: it means "use the registry default", and then the
    document is expected to exist.
    """
    raw = knobs.raw("REFLECT_HISTORY")
    return raw is not None and not raw.strip()


def run(argv=None):
    """Gate entry: report a missing history document or one that got scanned."""
    argv = list(sys.argv[1:] if argv is None else argv)
    if is_configured():
        return off(M("history.off"))
    probs = problems()
    return gate.finish(M("history.title"), probs,
                       M("history.ok", path=os.path.basename(location())))


def _empty_case():
    import tempfile  # noqa: PLC0415
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as fh:
        fh.write("# HISTORY\n")
        p = fh.name
    try:
        return [c.code for c in problems({}, path=p)] == ["history.empty_or_malformed"]
    finally:
        os.unlink(p)


def _cases():
    surfaces_a = {"REFLECT_DOCS": ["STATE.md", "PRINCIPLES.md"],
                  "REFLECT_QUESTIONS": ["questions"]}
    return [
        ("history.exempt_by_default",
         lambda: is_exempt("/repo/HISTORY.md", surfaces_a, root="/repo")),
        ("\u2605 history.declared_as_doc_is_not_exempt",
         lambda: not is_exempt("/repo/STATE.md", surfaces_a, root="/repo")),
        ("\u2605 history.inside_a_scanned_dir_is_not_exempt",
         lambda: not is_exempt("/repo/questions/HISTORY.md", surfaces_a,
                               root="/repo")),
        ("history.prefix_is_not_containment",
         lambda: is_exempt("/repo/questions-archive/HISTORY.md", surfaces_a,
                           root="/repo")),
        ("\u2605 history.missing_is_reported",
         lambda: [p.code for p in problems({}, path="/nonexistent/HISTORY.md")]
         == ["history.missing"]),
        ("\u2605 history.empty_or_malformed", _empty_case),
        ("history.this_repo_is_exempt",
         lambda: problems() == []),
    ]


GATE = meta("History document",
            "the one carrier where prose is allowed: it must exist and must stay off every scan surface",
            knobs=("REFLECT_HISTORY", "REFLECT_DOCS", "REFLECT_READMES",
                   "REFLECT_QUESTIONS", "REFLECT_FACTS"),
            runs_at="start-of-work",
            off_reason="a repo that keeps no history document states so by "
                       "pointing REFLECT_HISTORY at nothing; the exemption then "
                       "has no subject")

MODULE = module_meta("History document", "the prose carrier and its exemption guard")


if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], "check_history", _cases, run))
