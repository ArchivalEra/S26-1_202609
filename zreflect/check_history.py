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


def location(root=None):
    """Absolute path of the history file or directory (`REFLECT_HISTORY` / `REFLECT_HISTORY_MODE`)."""
    rel = knobs.history_target_name(root) or knobs.REGISTRY["REFLECT_HISTORY"][1]
    return gate.repo_path(rel) if root is None else os.path.join(root, rel)


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


def _entry_overlaps(target, base_root, entry):
    if not str(entry or "").strip():
        return False
    base = _norm(entry if os.path.isabs(entry) else os.path.join(base_root, entry))
    return target == base or target.startswith(base + os.sep) or base.startswith(target + os.sep)


def is_exempt(path, known=None, root=None):
    """Whether `path` lies outside every scan surface.

    A path is on a surface when it equals a declared document, lies inside a
    declared directory, or (for a history folder) contains a declared surface.
    """
    base_root = root or gate.GATE_REPO
    target = _norm(path)
    src = known if known is not None else surfaces()
    return not any(_entry_overlaps(target, base_root, entry)
                   for entries in src.values() for entry in entries)


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


def _file_problems(target):
    if not os.path.exists(target):
        return [M("history.missing", path=target)]
    if os.path.isdir(target):
        return [M("history.wrong_kind", path=target, expected="file")]
    return _content_problems(target)


def _folder_entry_problems(dirpath, names, dirs):
    out = []
    count = 0
    for d in sorted(dirs):
        if os.path.islink(os.path.join(dirpath, d)):
            out.append(M("history.empty_or_malformed", path=os.path.join(dirpath, d)))
    for fname in sorted(names):
        full = os.path.join(dirpath, fname)
        count += 1
        if os.path.islink(full) or not fname.lower().endswith(".md"):
            out.append(M("history.empty_or_malformed", path=full))
        else:
            out += _content_problems(full)
    return out, count


def _folder_problems(target):
    if not os.path.exists(target):
        return [M("history.missing", path=target)]
    if not os.path.isdir(target):
        return [M("history.wrong_kind", path=target, expected="folder")]
    out, total = [], 0
    for dirpath, dirs, names in os.walk(target, followlinks=False):
        dirs[:] = sorted(dirs)
        probs, count = _folder_entry_problems(dirpath, names, dirs)
        out += probs
        total += count
    if total == 0 and not out:
        out.append(M("history.empty_or_malformed", path=target))
    return out


def problems(known=None, path=None, mode=None):
    """The exemption's own criterion: history must exist, match format, and stay unscanned."""
    known = surfaces() if known is None else known
    target = location() if path is None else path
    resolved_mode = knobs.history_mode() if mode is None else mode
    out = _folder_problems(target) if resolved_mode == "folder" else _file_problems(target)
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
    """Gate entry: report missing, malformed, wrong-kind, or scanned history."""
    _ = list(sys.argv[1:] if argv is None else argv)
    if is_configured():
        return off(M("history.off"))
    mode, bad_mode = knobs.history_mode_with_status()
    if bad_mode is not None:
        return gate.fatal(M("history.bad_mode", mode=bad_mode))
    probs = problems(mode=mode)
    label = os.path.basename(location().rstrip("/\\")) or location()
    return gate.finish(M("history.title"), probs, M("history.ok", path=label))


def _empty_case(empty_code):
    import tempfile  # noqa: PLC0415
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as fh:
        fh.write("# HISTORY\n")
        p = fh.name
    try:
        return [c.code for c in problems({}, path=p)] == [empty_code]
    finally:
        os.unlink(p)


def _fold_mode_case(empty_code, wrong_kind_code):
    import tempfile  # noqa: PLC0415
    with tempfile.TemporaryDirectory() as td:
        hdir = os.path.join(td, "HISTORY")
        os.makedirs(os.path.join(hdir, "2026"))
        if [p.code for p in problems({}, path=hdir, mode="folder")] != [empty_code]:
            return False
        open(os.path.join(hdir, "01-init.md"), "w", encoding="utf-8").write("# Init\n\n> why\n")
        open(os.path.join(hdir, "2026", "release-notes.md"), "w", encoding="utf-8").write("# Rel\n\nnote\n")
        if problems({}, path=hdir, mode="folder") != []:
            return False
        if is_exempt(hdir, {"REFLECT_DOCS": [os.path.join(hdir, "01-init.md")]}, root=td):
            return False
        if not is_exempt(hdir, {"REFLECT_DOCS": [os.path.join(td, "HISTORY-x", "01.md")]}, root=td):
            return False
        bad = os.path.join(hdir, "broken.md")
        open(bad, "w", encoding="utf-8").write("# Missing prose\n")
        if [p.code for p in problems({}, path=hdir, mode="folder")] != [empty_code]:
            return False
        if [p.code for p in problems({}, path=hdir, mode="file")] != [wrong_kind_code]:
            return False
        if [p.code for p in problems({}, path=bad, mode="folder")] != [wrong_kind_code]:
            return False
        os.unlink(bad)
        open(os.path.join(hdir, "raw.txt"), "w", encoding="utf-8").write("# Non-md\n\ntext\n")
        return [p.code for p in problems({}, path=hdir, mode="folder")] == [empty_code]


def _cases():
    surfaces_a = {"REFLECT_DOCS": ["STATE.md", "PRINCIPLES.md"],
                  "REFLECT_QUESTIONS": ["questions"]}
    repo_dir = "/repo"
    empty_code, wrong_kind = "history.empty_or_malformed", "history.wrong_kind"
    return [
        ("history.exempt_by_default",
         lambda: is_exempt(repo_dir + "/HISTORY.md", surfaces_a, root=repo_dir)),
        ("\u2605 history.declared_as_doc_is_not_exempt",
         lambda: not is_exempt(repo_dir + "/STATE.md", surfaces_a, root=repo_dir)),
        ("\u2605 history.inside_a_scanned_dir_is_not_exempt",
         lambda: not is_exempt(repo_dir + "/questions/HISTORY.md", surfaces_a,
                               root=repo_dir)),
        ("history.prefix_is_not_containment",
         lambda: is_exempt(repo_dir + "/questions-archive/HISTORY.md", surfaces_a,
                           root=repo_dir)),
        ("\u2605 history.missing_is_reported",
         lambda: [p.code for p in problems({}, path="/nonexistent/HISTORY.md")]
         == ["history.missing"]),
        ("\u2605 history.empty_or_malformed", lambda: _empty_case(empty_code)),
        ("\u2605 history.fold_mode_folder_exemption_and_format",
         lambda: _fold_mode_case(empty_code, wrong_kind)),
        ("history.this_repo_is_exempt",
         lambda: problems() == []),
    ]


GATE = meta("History document",
            "the one carrier where prose is allowed: single file or fold directory must exist and stay off every scan surface",
            knobs=("REFLECT_HISTORY", "REFLECT_HISTORY_MODE", "REFLECT_DOCS",
                   "REFLECT_READMES", "REFLECT_QUESTIONS", "REFLECT_FACTS"),
            runs_at="start-of-work",
            off_reason="a repo that keeps no history document states so by "
                       "pointing REFLECT_HISTORY at nothing; the exemption then "
                       "has no subject")

MODULE = module_meta("History document", "the prose carrier and its exemption guard")


if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], "check_history", _cases, run))
