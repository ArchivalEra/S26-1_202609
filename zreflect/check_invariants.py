#!/usr/bin/env python3
"""Declarative invariants gate (**pluggable module**, issue #7).

"Repo file must / must not contain a snippet" is encoded as **data** (a JSON
spec); the engine is generic and repo-agnostic. Spec file:

    { "checks": [
        { "path": "build/113/link-web.sh",
          "must_contain": ["ALLOW_TABLE_GROWTH=1"],
          "must_not_contain": ["-flto"],
        } ] }

The engine only reads files -- **no builds, no containers, no network** -- so it
can run in pre-commit. Zero-value guards: empty checklist / a check without a
path / an unreadable file => all reported (never a silent pass). Requiring a reason
is deliberate: a check with no stated reason is one nobody dares to delete, and
it turns into a zombie.

**Boundary (stated openly in issue #7)**: this is a **grep-level** invariant --
it cannot tell comments from code (a snippet inside a comment still counts as
"present"). What it proves is "this text is still there", not "the code really
uses it". The strength ceiling of a declarative check is the shape of the text
it matches. For stronger guarantees, do not use grep: that is the job of
`calibrate` (issue #6, item 1). Orthogonal to this gate -- keep them apart: one
guards the **measurement instruments** (does the command measure what it
claims), the other guards **the repo files themselves** (what the source should
look like).

**Pluggable**: `REFLECT_INVARIANTS` unset => explicitly not enabled, exit 0
(repos that do not configure it are entirely unaffected; the discovery-based
roster still enrolls it, and the selftest still proves it can go red).
The invariants file is the **input landing spot**; the invariants gate is the
cheap origin invariant for that spot -- provenance must not require re-running
the expensive thing.

Usage (run directly, cwd = repo root):
    python3 zreflect/check_invariants.py [--selftest]
Exit codes: 0 = green / 1 = problems found / 2 = config or environment broken
(a config failure is not a check failure).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gate  # noqa: E402
from gate import finish, main_selftest_or, meta, repo  # noqa: E402
from i18n import M  # noqa: E402


def _shape_problems(c):
    """Shape validation for one check entry: returns `(problem list, normalized
    fields or None)`.

    "Bad shape" and "content mismatch" are two different things: with a bad
    shape there is **no comparable snippet**, so we must exit early (otherwise
    `frag not in text` raises TypeError). Five guards crammed into the call site
    would be 5 consecutive `continue`s (complexity 14).
    """
    if not isinstance(c, dict):
        return [M("invariants.not_object", entry=c)], None
    raw_path = c.get("path")
    path = raw_path.strip() if isinstance(raw_path, str) else ""
    mc, mnc = c.get("must_contain"), c.get("must_not_contain")
    if not path:
        return [M("invariants.missing_path", entry=c)], None
    crit = _criteria_problems(path, mc, mnc)
    if crit is not None:
        return crit, None
    return [], (path, mc or [], mnc or [])


def _criteria_problems(path, mc, mnc):
    """Shape validation for the criteria fields (must_contain / must_not_contain)."""
    if not isinstance(mc, list) and not isinstance(mnc, list):
        return [M("invariants.no_criteria", path=path)]
    if (mc is not None and not isinstance(mc, list)) or \
            (mnc is not None and not isinstance(mnc, list)):
        return [M("invariants.not_string_list", path=path)]
    if not (mc or []) and not (mnc or []):
        return [M("invariants.no_criteria", path=path)]
    if any(not isinstance(x, str) or not x for x in (mc or [])) or \
            any(not isinstance(x, str) or not x for x in (mnc or [])):
        return [M("invariants.fragment_not_string", path=path)]
    return None


def _safe_repo_read(p):
    target = repo(p)
    root_real = os.path.realpath(repo())
    target_real = os.path.realpath(target)
    try:
        inside = os.path.commonpath((root_real, target_real)) == root_real
    except ValueError:
        inside = False
    if not inside or os.path.islink(target):
        raise OSError("path escapes repo or is symlink")
    return open(target_real, encoding="utf-8").read()


def _content_problems(path, mc, mnc, read):
    """Snippet comparison: every `must_contain` must be present, every
    `must_not_contain` must be absent."""
    try:
        text = read(path)
    except (OSError, UnicodeError):
        return [M("invariants.unreadable", path=path)]
    out = []
    for frag in mc:
        if frag not in text:
            # `DRIFT` is a machine-readable marker: the **literal stays at the
            # emission point** (as a parameter value); the language pack only
            # places it into the sentence -- a pack value must not start with
            # `^[A-Z][A-Z0-9_]*:` (otherwise a single translation could masquerade
            # as a machine contract line; see i18n._validate).
            out.append(M("invariants.drift_missing", marker="DRIFT",
                         path=path, fragment=frag))
    for frag in mnc:
        if frag in text:
            out.append(M("invariants.drift_forbidden", marker="DRIFT",
                         path=path, fragment=frag))
    return out


def problems(checks, read=None):
    """Pure function: return the problem list (empty = green). No printing during
    the selftest.

    `read(path) -> str` is injectable (a fake filesystem for the selftest; real
    files would make it depend on the machine). The criterion is the
    **presence/absence** of a snippet (grep level; see the module docstring).
    Empty `checks` => `invariants.empty`; otherwise `_check_one_problems` judges
    each check in order.
    """
    if not checks:
        return [M("invariants.empty")]
    read = read or _safe_repo_read
    out = []
    for c in checks:
        out += _check_one_problems(c, read)
    return out


def _check_one_problems(c, read):
    """Shape first, then content: with a bad shape there is no comparable
    snippet, so an early exit is mandatory. Returns shape problems plus content
    problems from `_content_problems(path, mc, mnc, read=read)` when a spec exists.
    """
    shape_probs, spec = _shape_problems(c)
    if spec is None:
        return shape_probs
    path, mc, mnc = spec
    return shape_probs + _content_problems(path, mc, mnc, read=read)


def run(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    spec, spec_name, rc = gate.load_gate_spec(
        argv, "REFLECT_INVARIANTS",
        off_msg=lambda _n: M("invariants.off"),
        missing_msg=lambda n: M("invariants.spec_missing", name=n),
        broken_msg=lambda n, err: M("invariants.spec_broken", name=repo(n), error=err),
    )
    if rc is not None:
        return rc
    checks = spec.get("checks") if isinstance(spec, dict) else None
    if not isinstance(checks, list):
        return gate.fatal(M("invariants.bad_shape", path=repo(spec_name)))
    return finish(M("invariants.title"), problems(checks),
                  M("invariants.ok", count=len(checks)))


def _fake_read(files):
    """Fake filesystem: a filename not provided raises `FileNotFoundError` (the
    OSError of the real read path)."""
    def r(path):
        if path not in files:
            raise FileNotFoundError(path)
        return files[path]
    return r


def _cases_ok(read):
    """(1) Compliant input: nothing reported; presence/absence both as declared."""
    return [
        ("invariants.must_contain_present",
         lambda: problems([{"path": "a.sh",
                            "must_contain": ["ALLOW_TABLE_GROWTH=1"]}],
                         read=read) == []),
        ("invariants.must_not_contain_absent",
         lambda: problems([{"path": "a.sh",
                            "must_not_contain": ["-flto"]}],
                         read=read) == []),
        ("invariants.both_criteria_met",
         lambda: problems([{"path": "a.sh",
                            "must_contain": ["ALLOW_TABLE_GROWTH=1"],
                            "must_not_contain": ["-flto"]}],
                         read=read) == []),
    ]


def _cases_content(read):
    """(2) What must be reported is reported: content mismatch / unreadable."""
    return [
        ("\u2605 invariants.drift_missing",
         lambda: [x.code for x in problems(
             [{"path": "a.sh", "must_contain": ["-flto"]}],
             read=read)] == ["invariants.drift_missing"]),
        ("\u2605 invariants.drift_forbidden",
         lambda: [x.code for x in problems(
             [{"path": "a.sh",
               "must_not_contain": ["ALLOW_TABLE_GROWTH=1"]}],
             read=read)] == ["invariants.drift_forbidden"]),
        ("\u2605 invariants.unreadable",
         lambda: [x.code for x in problems(
             [{"path": "b.sh", "must_contain": ["x"]}],
             read=read)] == ["invariants.unreadable"]),
    ]


def _cases_shape(read):
    """(2) What must be reported is reported: broken spec shapes (five guards)."""
    return [
        ("\u2605 invariants.missing_path",
         lambda: [x.code for x in problems(
             [{"must_contain": ["x"]}],
             read=read)] == ["invariants.missing_path"]),
        ("\u2605 invariants.no_criteria",
         lambda: [x.code for x in problems(
             [{"path": "a.sh"}],
             read=read)] == ["invariants.no_criteria"]),
        ("\u2605 invariants.not_object",
         lambda: [x.code for x in problems(["not-a-dict"], read=read)
                  ] == ["invariants.not_object"]),
        ("\u2605 invariants.not_string_list",
         # one side a list, the other not (both sides non-list is no_criteria's case)
         lambda: [x.code for x in problems(
             [{"path": "a.sh", "must_contain": ["x"],
               "must_not_contain": "y"}],
             read=read)] == ["invariants.not_string_list"]),
        ("\u2605 invariants.fragment_not_string",
         lambda: [x.code for x in problems(
             [{"path": "a.sh", "must_contain": [1]}],
             read=read)] == ["invariants.fragment_not_string"]),
    ]


def _cases():
    read = _fake_read({"a.sh": "ALLOW_TABLE_GROWTH=1\n"
                              "SFLAGS=(-sMEMORY64=1)"})
    return (_cases_ok(read) + _cases_content(read) + _cases_shape(read)
            # (3) empty input must be reported
            + [("\u2605 invariants.empty",
                lambda: [x.code for x in problems([], read=read)]
                == ["invariants.empty"])])


GATE = meta("Invariants gate",
            "declarative invariants: repo files must / must not contain a snippet (grep level)",
            knobs=("REFLECT_INVARIANTS",),
            off_reason="repos that write no declarative invariants do not need it:"
                       " spec unset => explicitly not enabled (pluggable)")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:],
                              M("gate.title.invariants"),
                              _cases(), run))
