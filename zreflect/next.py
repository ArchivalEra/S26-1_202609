#!/usr/bin/env python3
"""The "pick up from the last turn" **collector** -- the memory system's half.

## Interface: a block of lines, **never persisted**

    section(repo) -> list[str]      # includes its own header line; <= SECTION_MAX lines

**It is host-agnostic**: `section(repo)` only returns lines; it knows no
editor's hook protocol, no host's JSON envelope, and does not need to know
what a given host calls session start. To plug into some host's hook, the
consumer adds a thin shell of its own (read its stdout and shape it however
the host wants) -- the suite does not make host decisions and does not
validate any host's config schema.

## Why there is no block in a document

**What changes every turn must not occupy a position that gets judged.** A
block that changes every turn is naturally incompatible with
`facts.py --check`'s byte-exact reconciliation: it would make the check
permanently red, and exempting it would leave that part of the document
verified by no one. So it is not persisted: it is computed fresh at each
session start. The cost is slightly higher (two git calls + one directory
read); what it buys is that it is **always fresh**.

## What gets collected, and from where

Everything grows out of **what already exists**; no new human-maintained
inputs:

    git log HEAD --not --remotes    -> unpushed commits ("what this round did")
    git status --porcelain          -> uncommitted changes / untracked files
    questions/                      -> unresolved open questions ("what is next")

Read only durable disk; never introduce an input that changes by itself.

## The budget is part of the interface

Text injected into context beyond one screen crowds out the actual work.
Truncation happens **inside the module** (`MAX_LISTED` / `SECTION_MAX`);
callers never need to know the length. `next.section_budget_holds` pins "not a
single pending item may be squeezed out".

## Honest boundaries

  - It knows the progress **the machine can see** (commits, uncommitted
    changes, open questions); it does **not** know "what the agent intends to
    do". The latter requires a human to write -- but one open question in
    `questions/` suffices; no full handoff needed.
  - "The last turn" is delimited by **unpushed commits**. Already-pushed turns
    are not in it -- that is history, and history stays out of the measured
    surface (what cannot be reproduced does not occupy a judged position).
  - The pending list shows at most `MAX_LISTED` entries; **the count beyond
    that is reported by the open-questions section right after** (that
    section gives "N open of M"; this one gives "do these few first").
"""
from __future__ import annotations

import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import knobs  # noqa: E402
from i18n import M, Message  # noqa: E402

# How many entries each category may list at most. **The budget is the
# interface**: enlarging it makes `SECTION_MAX` and `next.section_budget_holds`
# demand a recount together (which is exactly what you want).
MAX_LISTED = 3

# Maximum lines for the whole section. Item-by-item accounting (worst case each):
#   1 header + 1 commit count + 3 commits + 1 elision + 1 worktree + 1 blank + 1 pending header + 3 pending
SECTION_MAX = 12


def _git(repo, *args):
    """One git command against `repo`; **None on failure**, never a fabricated 0.

    Interface: cwd is the argument (not the audited repo), arguments are argv
    (no shell, no injection surface), and failure is `None` rather than
    `(rc, out)` -- so a caller cannot mistake "the command died" for "the answer
    is zero".
    """
    try:
        p = subprocess.run(["git", "-C", repo, *args],
                           capture_output=True, text=True, timeout=10,
                           encoding="utf-8", errors="replace")
    except (OSError, subprocess.SubprocessError):
        return None
    if p.returncode != 0:
        return None
    return p.stdout


def unpublished_commits(repo):
    """Unpushed commit subjects. Unreadable => None; unborn branch => `[]`."""
    if _git(repo, "rev-parse", "--git-dir") is None:
        return None
    if _git(repo, "rev-parse", "--verify", "HEAD") is None:
        return [] if _git(repo, "symbolic-ref", "--short", "HEAD") else None
    out = _git(repo, "log", "--oneline", "HEAD", "--not", "--remotes")
    return [ln.strip() for ln in out.splitlines() if ln.strip()] if out is not None else None


def working_tree(repo):
    """Uncommitted changes: returns (changed-file count, untracked-file count)."""
    out = _git(repo, "status", "--porcelain")
    if out is None:
        return None
    changed = untracked = 0
    for ln in out.splitlines():
        if not ln.strip():
            continue
        if ln.startswith("??"):
            untracked += 1
        else:
            changed += 1
    return changed, untracked


def _commit_lines(repo, last):
    """The unpushed-commits section: count + first N subjects + "N more"."""
    commits = unpublished_commits(repo)
    if commits is None:
        last.append(M("next.commits_unreadable"))
        return
    if not commits:
        last.append(M("next.commits_none"))
        return
    last.append(M("next.commits_count", count=len(commits)))
    last.extend("  `%s`" % c for c in commits[:MAX_LISTED])
    if len(commits) > MAX_LISTED:
        last.append("  " + M("next.commits_more",
                             count=len(commits) - MAX_LISTED))


def _tree_lines(repo, last, pending):
    """The working-tree section: how much changed / whether it is dirty."""
    wt = working_tree(repo)
    if wt is None:
        last.append(M("next.tree_unreadable"))
        return
    changed, untracked = wt
    last.append(M("next.tree_state", changed=changed, untracked=untracked))
    if changed or untracked:
        pending.append(M("next.tree_dirty"))


def _question_lines(repo, pending):
    """Append unresolved open-question names to `pending`, up to the remaining
    `MAX_LISTED` budget (emitting `+N more` if truncated).
    """
    room = MAX_LISTED - len(pending)
    if room <= 0:
        return
    qs = _open_question_names(repo)
    if len(qs) <= room:
        pending.extend(M("next.open_question", name=q) for q in qs)
    elif room == 1:
        pending.append(M("next.open_questions_more", count=len(qs)))
    else:
        shown = room - 1
        pending.extend(M("next.open_question", name=q) for q in qs[:shown])
        pending.append(M("next.open_questions_more", count=len(qs) - shown))


def collect(repo):
    """Return `(last_turn, pending)` line lists (`str` / `Message`) from commits, worktree, and questions."""
    last: list[str] = []
    pending: list[Message] = []
    _commit_lines(repo, last)
    _tree_lines(repo, last, pending)
    _question_lines(repo, pending)
    return last, pending


def _open_question_names(repo):
    """Unresolved open-question filenames from `questions/` (sorted by name, at most `MAX_LISTED`).

    Directory unreadable => return an empty list (not an error): that is the
    normal shape of "this repo does not use open questions"; `inject-state.py`
    will say "unreadable" explicitly.
    """
    # Forward to the single source (`knobs.questions_path` strips) -- this used
    # to hand-roll `os.environ.get(...).strip() or "questions"`, a second copy
    # of the same criterion.
    d = knobs.questions_path(repo)
    if not os.path.isdir(d):
        return []
    import check_questions  # noqa: PLC0415
    names = [n for n in sorted(os.listdir(d), key=check_questions.sort_key) if n.endswith(".md")]
    return [n for n in names if check_questions.status_of(_read_question(d, n))
            not in check_questions.CLOSED_STATUS]


def _read_question(d, name):
    """Read one open question; unreadable => empty string (treated as "unresolved" -- unreadable must not count as resolved)."""
    try:
        with open(os.path.join(d, name), encoding="utf-8",
                  errors="replace") as fh:
            return fh.read()
    except OSError:
        return ""


def section(repo):
    """Render header + sections bounded to `SECTION_MAX` lines (`M()` codes throughout)."""
    last, pending = collect(repo)
    return _format(last, pending)


def _format(last, pending):
    """The zero-I/O version of `section` (for self-proofs: never touches git).

    Layout lives here too -- callers should not know "which lines get
    indented". An empty list must be **stated explicitly**
    (`next.pending_none`); a bare empty line is not allowed: empty is not a
    pass.
    """
    lines = [str(M("next.section_header"))]
    lines.extend("  \u00b7 %s" % str(ln).strip() for ln in (last or []))
    lines.append("")
    lines.append(str(M("next.pending_header")))
    if pending:
        lines.extend("  \u00b7 %s" % str(ln).strip() for ln in pending)
    else:
        lines.append("  \u00b7 " + str(M("next.pending_none")))
    return lines


def main(argv=None):
    """`python3 zreflect/next.py [repo]` -> prints the whole section (for human inspection, not for hook assembly).

    The `__main__` block activates the language pack first
    (`gate.activate_or_fatal`): `REFLECT_LANG=zh` must render zh, and a set
    but missing pack must FATAL rc 2 -- rc 0 with bare codes was the measured
    failure (issue #31)."""
    import sys  # noqa: PLC0415
    repo = (argv or sys.argv[1:] or ["."])[0]
    sys.stdout.write("\n".join(section(os.path.abspath(repo))) + "\n")
    return 0


# -- Self-proof ----------------------------------------------------------------
#
# This module **has** a self-proof entry (`selftest=True`): its criterion is
# "when the collector cannot read something, does it pretend it did?" -- the
# class of incident this repo hurts most over, so it must be falsifiable on
# the spot.

def _cases():
    """Fixture-repo cases pinning error explicitness and budget."""
    return [
        ("next.collects_from_real_git", lambda: _real_git_case()),
        ("★ next.missing_repo_is_loud_not_zero",
         lambda: _missing_repo_loud()),
        ("★ next.section_is_deterministic", lambda: _section_deterministic()),
        ("★ next.empty_pending_is_explicit", lambda: _empty_pending_explicit()),
        ("★ next.log_command_has_start_point",
         lambda: _log_command_shape_ok()),
        ("★ next.section_budget_holds", lambda: _section_budget_holds()),
        ("★ next.resolved_question_is_dropped",
         lambda: _resolved_question_dropped()),
        ("★ next.manual_entry_activates_pack",
         lambda: _manual_entry_activates_pack()),
        ("★ next.nonexistent_root_is_loud",
         lambda: _nonexistent_root_loud()),
        ("next.unborn_branch_is_empty",
         lambda: _unborn_branch_case()),
    ]


def _unborn_branch_case():
    import shutil
    import subprocess
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    try:
        subprocess.run(["git", "init", "-q", d], check=True)
        return unpublished_commits(d) == []
    finally:
        shutil.rmtree(d, True)


def _resolved_question_dropped():
    """Resolved questions must not appear under "what is next".

    The fixture has one resolved and one unresolved question; only the latter
    may be listed. A temp directory is mandatory: real questions eventually get
    resolved, which would make this case verify nothing.
    """
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    try:
        q = os.path.join(d, "questions")
        os.makedirs(q)
        with open(os.path.join(q, "01-done.md"), "w", encoding="utf-8") as fh:
            fh.write("# done\n\n**Status:** resolved\n")
        with open(os.path.join(q, "02-open.md"), "w", encoding="utf-8") as fh:
            fh.write("# open\n\n**Status:** ready-for-agent\n")
        names = _open_question_names(d)
        return names == ["02-open.md"]
    finally:
        import shutil  # noqa: PLC0415
        shutil.rmtree(d, True)


def _real_git_case():
    import shutil
    import subprocess
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    try:
        subprocess.run(["git", "init", "-q", d], check=True)
        subprocess.run(["git", "-C", d, "config", "user.email", "a@b"],
                       check=True, capture_output=True)
        subprocess.run(["git", "-C", d, "config", "user.name", "a"],
                       check=True, capture_output=True)
        open(os.path.join(d, "x"), "w", encoding="utf-8").write("x")
        subprocess.run(["git", "-C", d, "add", "x"], check=True)
        subprocess.run(["git", "-C", d, "commit", "-qm", "c"], check=True,
                       capture_output=True)
        last, _pending = collect(d)
        # Chinese in fixtures is codepoint-built (this repo's discipline; a
        # literal would turn check_i18n red)
        # ⚠️ Assert on the **code**, not the rendered text -- under the null
        # pack it renders as `next.tree_state(...)`; asserting "some word is
        # in the text" is asserting "a language pack is installed", which is a
        # different thing.
        return any("next.tree_" in getattr(ln, "code", str(ln)) for ln in last)
    except Exception:                                    # noqa: BLE001
        return False
    finally:
        shutil.rmtree(d, True)


def _missing_repo_loud():
    """Nonexistent repo => `unpublished_commits` returns None, not `[]`."""
    return unpublished_commits("/nonexistent-xyz") is None


def _section_deterministic():
    import shutil
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    try:
        return section(d) == section(d)
    finally:
        shutil.rmtree(d, True)


def _empty_pending_explicit():
    """No pending items => it must be **stated explicitly** (`next.pending_none`); a bare empty line is not allowed.

    Assert on the code (under the null pack it renders as `next.pending_none`,
    not a sentence).
    """
    import i18n  # noqa: PLC0415
    with i18n.bind(i18n.NULL):
        block = "\n".join(_format(["only last"], []))
    return "next.pending_none" in block


def _nonexistent_root_loud():
    """Missing repo root reports explicit unreadable errors."""
    last, _pending = collect("/nonexistent-xyz")
    codes = {getattr(ln, "code", "") for ln in last}
    return "next.commits_unreadable" in codes and "next.tree_unreadable" in codes


def _log_command_shape_ok():
    """The git command used by `unpublished_commits` **must carry a start point**.

    Read that command's arguments from the source (without executing git) --
    the criterion is about shape, so it is fixture-independent and independent
    of real repo state.
    """
    import inspect  # noqa: PLC0415
    src = inspect.getsource(unpublished_commits)
    # Find the `_git(repo, "log", ...)` line
    for line in src.splitlines():
        if '"log"' in line:
            # The start point must appear before --not
            if '"HEAD"' not in line:
                return False
            return line.index('"HEAD"') < line.index("--not")
    return False


def _manual_entry_activates_pack():
    """The manual (non-`--selftest`) `__main__` branch **must pass through
    `activate_or_fatal` before `main()`** (issue #31).

    Read the shape from the source (no subprocess): without that pass-through
    `REFLECT_LANG=zh python3 zreflect/next.py` exited 0 with bare codes --
    installed but not activated. Both halves are pinned: the call exists in
    the `__main__` block, and the manual exit actually waits on its rc.
    """
    import inspect  # noqa: PLC0415
    import sys as _sys  # noqa: PLC0415
    src = inspect.getsource(_sys.modules[__name__])
    lines = src.splitlines()
    try:
        start = lines.index('if __name__ == "__main__":')
    except ValueError:
        return False
    block = "\n".join(lines[start:])
    return ("activate_or_fatal" in block
            and "sys.exit(rc or main())" in block)


def _section_budget_holds():
    """Many commits + many open questions + dirty worktree => pending items present and the section <= `SECTION_MAX`."""
    import shutil
    import subprocess
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    try:
        subprocess.run(["git", "init", "-q", d], check=True,
                       capture_output=True)
        subprocess.run(["git", "-C", d, "config", "user.email", "a@b"],
                       check=True, capture_output=True)
        subprocess.run(["git", "-C", d, "config", "user.name", "a"],
                       check=True, capture_output=True)
        for i in range(MAX_LISTED + 3):
            open(os.path.join(d, "x"), "w", encoding="utf-8").write(str(i))
            subprocess.run(["git", "-C", d, "add", "x"], check=True,
                           capture_output=True)
            subprocess.run(["git", "-C", d, "commit", "-qm", "c%d" % i],
                           check=True, capture_output=True)
        q = os.path.join(d, "questions")
        os.makedirs(q, exist_ok=True)
        for i in range(MAX_LISTED + 2):
            open(os.path.join(q, "%02d-q.md" % i), "w", encoding="utf-8").write(
                "# q\n\n**Status:** open\n")
        open(os.path.join(d, "dirty"), "w", encoding="utf-8").write("d")     # untracked -> pending
        import i18n  # noqa: PLC0415
        # ⚠️ **Re-render inside the null pack**, do not string-match the
        # current language pack's output. Previously `text` was rendered by
        # `section(d)` with the **current pack**, and then
        # `"next.pending_header" in text` was checked inside `bind(NULL)` --
        # with any language pack installed (en/zh/de) that substring never
        # holds, so the case was permanently red; with zero packs it happened
        # to be green. Measured: after CI, `next --selftest` gave 6 PASS /
        # 1 FAIL under REFLECT_LANG=en.
        with i18n.bind(i18n.NULL):
            lines = section(d)
            text = "\n".join(lines)
            has_pending = "next.pending_header" in text
            has_dirty = "next.tree_dirty" in text
            return has_pending and has_dirty and len(lines) <= SECTION_MAX
    except Exception:                                    # noqa: BLE001
        return False
    finally:
        shutil.rmtree(d, True)


def _selftest():
    import sys  # noqa: PLC0415

    from gate import main_selftest_or  # noqa: PLC0415
    from i18n import M  # noqa: PLC0415
    return main_selftest_or(sys.argv[1:], M("gate.title.next"), _cases,
                            lambda a: 0)


if __name__ == "__main__":
    import sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    if "--selftest" in sys.argv:
        import next as _mod  # noqa: PLC0415
        sys.exit(_mod._selftest())
    # The manual branch must activate the pack itself: AGENTS.md documents
    # `REFLECT_LANG=zh python3 zreflect/next.py` as an interface, and without
    # this point it exited 0 with bare codes (issue #31) -- "no error, wrong
    # answer". `main_selftest_or` already covers the --selftest branch; the
    # other branch takes the harness.py entry shape.
    from gate import activate_or_fatal  # noqa: PLC0415
    rc = activate_or_fatal()
    sys.exit(rc or main())

from gate import module_meta  # noqa: E402

MODULE = module_meta(
    "pick up from the last turn",
    "memory-system data collection: unpushed commits / worktree / unresolved open questions => one block of host-agnostic injection lines "
    "(computed fresh, never persisted; budget lives in the module)",
    selftest=True)
