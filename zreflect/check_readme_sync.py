#!/usr/bin/env python3
"""Trilingual README sync gate: the language versions are three copies of the
same assertion -- touching them in separate batches is drift.

The front-page README has three language copies (by default `README.md`
English + `README.zh.md` + `README.de.md`, names in `REFLECT_READMES`).
Trilingualization introduces a new silent failure mode: **edit one copy,
leave the other two alone** => the three copies go from "one sentence" to
mutually contradictory assertions. The user's discipline (2026-10-01) is
deliberately strict: **every push must update all copies in the same batch**
-- this gate is that discipline's criterion and witness:

  - Default mode (what pre-commit / manual runs / gates-selftest run): the
    **structural criterion** -- every README declared by `REFLECT_READMES`
    must exist, be non-empty, and contain all the trio's file names (the
    language switcher must point at every language: a broken switcher is a
    broken entry point).
    A single-entry list (`REFLECT_READMES=maintaince.md`) => the cross-link
    criterion **degrades**: with only one language, "must point at every
    language" holds vacuously and self-reference is a degenerate requirement
    (issue #8) -- the cross-links are then not checked, with run() saying
    explicitly "not applicable" (same style as other gates declaring an off
    state); the exist / non-empty criteria still apply as usual;
  - `--changed <file|->`: the **push-set criterion** -- read the file paths
    changed in this push from a file (or `-` = stdin, one per line); **every
    README must be in the change set**, reporting one miss per missing copy.
    An empty change set => must report (empty is not a pass). pre-push and
    CI use this mode.
    Warning: the push-set criterion does **not** degrade: with a single
    entry, "every push must update it" remains a real criterion.

Zero-value guards: `REFLECT_READMES` empty => report (judging the "README
group" against an empty list is empty talk); push mode receiving an empty
change set => report.

Warning, the honest boundary: pre-push can be skipped with
`git push --no-verify` -- that is git's native escape and no hook can stop
it. So CI (`.github/workflows/readme-sync.yml`) runs **the same criterion**:
the local hook is the first pain, CI is the commitment's front line.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gate import (  # noqa: E402
    fatal,
    finish,
    main_selftest_or,
    meta,
    off,
    repo,
)
from i18n import M, Message  # noqa: E402


def lang_names():
    """The trilingual README list -- delegates to `knobs.readme_names()` (the
    single source of truth).

    Empty `REFLECT_READMES` is a deliberate "no README group" and yields `()`;
    unset yields the registry default. Both criteria here report an empty list.
    """
    import knobs  # noqa: PLC0415
    return tuple(knobs.readme_names())


def _structure_sig(body):
    """Count top-level `#`, `##` headings and ``` fences for cross-language parity."""
    return (
        len(re.findall(r"^#\s+", body, re.M)),
        len(re.findall(r"^##\s+", body, re.M)),
        len(re.findall(r"^```", body, re.M)),
    )


def _parity_problems(files, langs):
    if len(langs) <= 1 or langs[0] not in files:
        return []
    want = _structure_sig(files[langs[0]] or "")
    out = []
    for name in langs[1:]:
        if name not in files:
            continue
        got = _structure_sig(files[name] or "")
        if got != want:
            out.append(M("readme.structure_mismatch", name=name, expected=langs[0],
                         got="%d/%d/%d" % got, want="%d/%d/%d" % want))
    return out


def _one_readme_problems(name, files, langs):
    if name not in files:
        return [M("readme.file_missing", name=name)]
    body = re.sub(r"<!--.*?-->", "", files[name] or "", flags=re.S)
    out = []
    if not body.strip():
        out.append(M("readme.file_empty", name=name))
    if len(langs) > 1:
        for other in langs:
            if other not in body:
                out.append(M("readme.switcher_incomplete", name=name, expected=other))
    return out


def problems_structure(files, langs):
    """Structural criterion (pure function: the selftest depends on that)."""
    if not langs:
        return [M("readme.names_empty_structure")]
    if len(set(langs)) != len(langs):
        return [M("readme.duplicate_name")]
    out = []
    for name in langs:
        out += _one_readme_problems(name, files, langs)
    return out + _parity_problems(files, langs)


def problems_push(changed, langs):
    """Push-set criterion (pure function). `changed` = paths changed in this push;
    `langs` = the README list.

    An empty `langs` is `readme.names_empty_push`; an empty `changed` is
    `readme.changed_empty` (empty is not a pass). Otherwise the two list shapes
    are judged by `_push_missing_copies`, which returns one
    `readme.not_in_push` per missing copy in list order.
    """
    if not langs:
        return [M("readme.names_empty_push")]
    if not changed:
        return [M("readme.changed_empty")]
    return _push_missing_copies(changed, langs)


def _push_missing_copies(changed, langs):
    """Two list shapes, two criteria.

    **Multi-entry** (the default trilingual trio) => **conditional**: "touch any
    one copy => this push's change set must contain all copies". None touched =>
    not applicable, so pure code / pure docs commits are not blocked.

    **Single-entry** => **unconditional**: "every push must update it" -- a
    single-entry list has no "same batch", so its criterion is simply "must be
    present" in `changed`.
    """
    out: list[Message] = []
    # Multi-entry conditional form: none touched => not applicable
    if len(langs) > 1 and not any(name in changed for name in langs):
        return out
    for name in langs:
        if name not in changed:
            out.append(M("readme.not_in_push", name=name))
    return out


def _push_mode(argv, langs):
    """Read the change set and judge the push criterion."""
    src = argv[1] if len(argv) > 1 else "-"
    if src == "-":
        lines = sys.stdin.read().splitlines()
    elif not os.path.exists(src):
        return fatal(M("readme.changed_file_missing", name=src))
    else:
        lines = open(src, encoding="utf-8", errors="replace").read().splitlines()
    changed = {
        (s[2:] if s.startswith("./") else s)
        for l in lines if (s := l.strip().strip('"'))
    }
    probs = problems_push(changed, langs)
    return finish(M("readme.title"), probs,
                  M("readme.ok_push", count=len(langs)))


def run(argv):
    langs = lang_names()
    if not langs:
        # `REFLECT_READMES=` (explicitly empty) is a decision, not a mistake:
        # this repo has no README group. Say so and stand down -- reporting a
        # missing file here would diagnose a stated intent as an absent file.
        return off(M("readme.off_empty_group"))
    if argv and argv[0] == "--changed":
        return _push_mode(argv, langs)
    if argv:
        return fatal(M("readme.unknown_arg", arg=argv[0]))
    files = {}
    for name in langs:
        p = repo(name)
        if os.path.exists(p):
            files[name] = open(p, encoding="utf-8", errors="replace").read()
    if len(langs) == 1:
        # The degraded cross-link criterion must be said out loud (issue #8)
        # -- same style as other gates declaring themselves "off": with a
        # single entry the cross-links hold vacuously; never pretend to have
        # checked.
        print(M("readme.switcher_not_applicable", name=langs[0]),
              file=sys.stderr)
    probs = problems_structure(files, langs)
    if len(langs) == 1:
        return finish(M("readme.title"), probs,
                      M("readme.ok_single", name=langs[0]))
    return finish(M("readme.title"), probs,
                  M("readme.ok_structure", count=len(langs)))


LANGS = ("README.md", "README.zh.md", "README.de.md")


def _trio():
    return dict.fromkeys(LANGS, "x [%s](%s) [%s](%s) [%s](%s) x" % (LANGS * 2))


def _cases_structure():
    """(1) Structural criterion: cross-links (trio) / existence / non-emptiness
    (single entry)."""
    return [
        ("readme.trio_linked",
         lambda: problems_structure(_trio(), LANGS) == []),
        # (1) Normal case: no report (single entry: cross-link criterion
        # degrades, issue #8)
        ("readme.single_no_self_reference",
         lambda: problems_structure({"maintaince.md": "# rules\n\nno links here."},
                                    ("maintaince.md",)) == []),
        ("\u2605 readme.file_missing",
         lambda: [p.code for p in problems_structure(
             {k: v for k, v in _trio().items() if k != "README.de.md"}, LANGS)]
         == ["readme.file_missing"]),
        ("\u2605 readme.switcher_incomplete",
         lambda: [p.code for p in problems_structure(
             dict(_trio(), **{"README.md": "only [README.md](README.md) and "
                                            "[README.zh.md](README.zh.md)"}),
             LANGS)] == ["readme.switcher_incomplete"]),
        ("\u2605 readme.file_empty",
         lambda: "readme.file_empty" in [p.code for p in problems_structure(
             dict(_trio(), **{"README.zh.md": "   \n"}), LANGS)]),
        # Single entry: existence / non-emptiness do not degrade (issue #8)
        ("\u2605 readme.single_file_missing",
         lambda: [p.code for p in problems_structure({}, ("maintaince.md",))]
         == ["readme.file_missing"]),
        ("\u2605 readme.single_file_empty",
         lambda: "readme.file_empty" in [p.code for p in problems_structure(
             {"maintaince.md": "  \n"}, ("maintaince.md",))]),
        # (3) Empty input must be reported
        ("\u2605 readme.names_empty_structure",
         lambda: [p.code for p in problems_structure(_trio(), ())]
         == ["readme.names_empty_structure"]),
        ("\u2605 readme.structure_mismatch",
         lambda: [p.code for p in problems_structure(
             dict(_trio(), **{"README.zh.md": "## extra\n" + _trio()["README.zh.md"]}),
             LANGS)] == ["readme.structure_mismatch"]),
    ]


def _cases_push():
    """Push-set cases: multi-entry conditional, single-entry unconditional."""
    return [
        ("readme.push_all_present",
         lambda: problems_push(set(LANGS) | {"code.py"}, LANGS) == []),
        ("readme.single_push_contains_it",
         lambda: problems_push({"maintaince.md", "a.py"}, ("maintaince.md",))
         == []),
        ("\u2605 readme.not_in_push",
         lambda: [p.code for p in problems_push(
             {"README.md", "README.zh.md", "zreflect/facts.py"}, LANGS)]
         == ["readme.not_in_push"]),
        ("\u2605 readme.single_not_in_push",
         lambda: [p.code for p in problems_push({"other.md"}, ("maintaince.md",))]
         == ["readme.not_in_push"]),
        ("readme.multi_untouched_is_not_in_scope",
         lambda: problems_push({"zreflect/x.py"},
                               ("README.md", "README.zh.md")) == []),
        ("\u2605 readme.multi_partial_still_fires",
         lambda: [p.code for p in problems_push(
             {"README.md", "zreflect/x.py"}, ("README.md", "README.zh.md"))
         ] == ["readme.not_in_push"]),
        ("\u2605 readme.names_empty_push",
         lambda: [p.code for p in problems_push({"README.md"}, ())]
         == ["readme.names_empty_push"]),
        ("\u2605 readme.changed_empty",
         lambda: [p.code for p in problems_push(set(), LANGS)]
         == ["readme.changed_empty"]),
    ]


def _cases_knob():
    """(3) Unset vs explicitly empty: two different intents, never collapsed."""
    import gate as _gate  # noqa: PLC0415
    import knobs  # noqa: PLC0415

    def names(value):
        """`readme_names()` under one environment: `value=None` = unset."""
        saved = os.environ.get("REFLECT_READMES")
        saved_repo = _gate.GATE_REPO
        try:
            _gate.GATE_REPO = "/nonexistent-repo"
            if value is None:
                os.environ.pop("REFLECT_READMES", None)
            else:
                os.environ["REFLECT_READMES"] = value
            return knobs.readme_names()
        finally:
            _gate.GATE_REPO = saved_repo
            if saved is None:
                os.environ.pop("REFLECT_READMES", None)
            else:
                os.environ["REFLECT_READMES"] = saved

    return [
        # unset => the registry default, not an empty group
        ("readme.unset_uses_registry_default",
         lambda: names(None) == knobs.REGISTRY["REFLECT_READMES"][1].split(",")),
        # explicitly empty => a real answer, not "fall back to three"
        ("\u2605 readme.explicit_empty_is_empty_group",
         lambda: names("") == [] and names("  ") == []),
        ("readme.single_entry_honoured",
         lambda: names("README.md") == ["README.md"]),
    ]


def _cases():
    """One group per criterion (structure / push set / knob intent): they read
    different inputs and govern different things."""
    return _cases_structure() + _cases_push() + _cases_knob()


GATE = meta("Trilingual README gate",
            "language versions are three copies of one assertion: structural cross-links + same-batch on every push",
            knobs=("REFLECT_READMES",), name_dependent=True,
            off_reason="a repo that sets REFLECT_READMES to an empty list states "
                       "it has no README group; unset is different and uses the "
                       "registry default")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], "check_readme_sync", _cases, run))
