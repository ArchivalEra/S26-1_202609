#!/usr/bin/env python3
"""A/B same-flags invariant gate (**pluggable module**; generalized from
Octave-Full-Wasm tickets 57/61).

When comparing the **declared surfaces** of two artifacts (build-product
identity cards, benchmark reports, any JSON), the only legal difference is the
**axis under test** itself. Any other key differing = a confounding variable
slipped into the A/B -- the conclusion is void. Real incident: an allocator A/B
first reported -39%; it later turned out the baseline carried runtime assertions
(the full `--diag` set) while the candidate only carried `NAMES=1` => retested
with same flags, the real difference was -27%. Had this gate existed before the
A/B, the -39% would never have entered the record.

Spec (`REFLECT_AB`, default `ab.json`; data, not code):

    { "pairs": [
        { "name": "allocator A/B",
          "a": "artifacts/base/octave.build.json",
          "b": "artifacts/cand/octave.build.json",
          "key": "declared",            # optional: dotted path into the JSON (default: whole file)
          "allow": ["malloc"],          # axis under test (the only key allowed to differ)
        } ] }

- A value difference on any key outside `allow` => report (confounding
  variable);
- keys inside `allow` **must simply exist in both** -- differing or equal both
  count; mere existence is the criterion, absence itself is not judged
  (absence semantics belong to the producer);
- an artifact that cannot be read => `SKIP:`, stated openly (a cross-machine
  reality, not a pass);
- empty `pairs` / an entry missing a required field => report (zero-value guard);
- `REFLECT_AB` unset => explicitly not enabled, exit 0; explicitly specified
  (--spec / knob) but the file missing => FATAL exit 2.

Usage (cwd = repo root): python3 zreflect/check_ab.py [--spec ab.json]
(Spec-name resolution: explicit --spec > `REFLECT_AB` knob > default `ab.json`.)
Exit codes: 0 = green or not enabled / 1 = problems found / 2 = broken config.
Selftest: --selftest (fixture-injected).
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import gate  # noqa: E402
from gate import main_selftest_or, meta, repo  # noqa: E402
from i18n import M, Message  # noqa: E402


def _load(path):
    try:
        return json.load(open(path, encoding="utf-8")), None
    except (OSError, ValueError) as e:
        return None, str(e)


def _dig(obj, dotted):
    cur = obj
    for k in dotted.split("."):
        if isinstance(cur, dict) and k in cur:
            cur = cur[k]
        else:
            return None
    return cur


def _pair_field_problems(pr):
    """A pair entry missing a required field (name / a / b) => report."""
    return [M("ab.pair_missing_field", field=f, entry=pr)
            for f in ("name", "a", "b") if not pr.get(f)]


def _declared(obj, key):
    """Take the declared surface: empty key => the whole file; otherwise dig
    down the dotted path."""
    return _dig(obj, key) if key else obj


_MISSING = object()


def _confound_problems(pr, key, da, db):
    """A value mismatch on any key outside the allow axis => confounding
    variable (A/B void)."""
    raw_allow = pr.get("allow")
    if raw_allow is not None and not isinstance(raw_allow, list):
        return [M("ab.allow_not_list", name=pr["name"])]
    allow_list = [str(k) for k in (raw_allow or [])]
    out = [M("ab.allow_key_missing", name=pr["name"], field=k)
           for k in allow_list if k not in da or k not in db]
    allow = set(allow_list)
    out += [M("ab.confound", name=pr["name"],
              key=key or M("ab.root_label"), field=k,
              value_a=da.get(k), value_b=db.get(k))
            for k in sorted(set(da) | set(db))
            if k not in allow and da.get(k, _MISSING) != db.get(k, _MISSING)]
    return out


def _pair_problems(pr, root, loader):
    """One A/B pair comparison: fields / readability / declared-surface type /
    confounding variables. Returns (problems, skips)."""
    problems = _pair_field_problems(pr)
    skips: list[Message] = []
    if problems:
        # A missing required field ends it here (the a/b/key reads below would
        # raise KeyError -- the missing field is itself what this round
        # reports; do not let it become a crash).
        return problems, skips
    if pr.get("optional"):
        problems.append(M("gate.optional_forbidden", name=pr["name"]))
    key = pr.get("key") or ""
    ra, ea = loader(gate.repo_path(pr["a"], root))
    rb, eb = loader(gate.repo_path(pr["b"], root))
    if ra is None or rb is None:
        problems.append(M("ab.artifact_unreadable", name=pr["name"],
                        error_a=ea or "", error_b=eb or ""))
        return problems, skips
    da, db = _declared(ra, key), _declared(rb, key)
    if not isinstance(da, dict) or not isinstance(db, dict):
        problems.append(M("ab.not_a_dict", name=pr["name"],
                          key=key or M("ab.root_label")))
        return problems, skips
    return problems + _confound_problems(pr, key, da, db), skips


def check(spec, root, loader=_load):
    """Pure logic (the selftest injects `loader`). Returns (problems, skips)."""
    if not isinstance(spec, dict):
        return [M("ab.spec_broken", name="ab.json", error="spec must be an object")], []
    pairs = spec.get("pairs")
    if pairs is None:
        pairs = []
    if not isinstance(pairs, list) or not pairs:
        return [M("ab.empty")], []
    problems, skips = [], []
    for pr in pairs:
        probs, sks = _pair_problems(pr, root, loader)
        problems += probs
        skips += sks
    return problems, skips


def main(argv):
    return gate.run_spec_gate(
        argv, "REFLECT_AB",
        off_msg=lambda n: M("ab.off", name=n),
        missing_msg=lambda n: M("ab.explicit_spec_missing", name=n),
        broken_msg=lambda n, err: M("ab.spec_broken", name=n, error=err),
        title=M("ab.title"),
        judge=lambda spec: check(spec, repo()),
        ok_msg=lambda spec: M("ab.ok", count=len(spec.get("pairs") or [])),
    )


def _cases():
    import atexit  # noqa: PLC0415
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    atexit.register(shutil.rmtree, d, True)

    def wf(rel, obj):
        p = os.path.join(d, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        json.dump(obj, open(p, "w", encoding="utf-8"))
        return rel
    spec = {"pairs": [
        {"name": "allocator A/B", "a": "a.json", "b": "b.json", "key": "declared",
         "allow": ["malloc"]}]}
    # a/b: identical except malloc
    wf("a.json", {"declared": {"simd": True, "malloc": "mimalloc", "v128": 4752}})
    wf("b.json", {"declared": {"simd": True, "malloc": "dlmalloc", "v128": 4752}})
    wf("mut-a.json", {"declared": {"simd": True, "malloc": "mimalloc", "v128": 4752}})
    wf("mut-b.json", {"declared": {"simd": False, "malloc": "mimalloc", "v128": 4752}})
    wf("nokey.json", {"declared": "not-a-dict"})
    empty: dict[str, list[Any]] = {"pairs": []}
    confound_spec = {"pairs": [{"name": "m", "a": "mut-a.json", "b": "mut-b.json",
                                "key": "declared", "allow": ["malloc"]}]}
    return [
        ("ab.resolve_spec",
         lambda: gate.resolve_spec(["--spec", "x.json"], "K.json", "ab.json") == ("x.json", True)
         and gate.resolve_spec([], "K.json", "ab.json") == ("K.json", True)
         and gate.resolve_spec([], "", "ab.json") == ("ab.json", False)
         and gate.resolve_spec([], "  ", "ab.json") == ("ab.json", False)),
        # (1) compliant input: nothing reported
        ("ab.ok", lambda: check(spec, d)[0] == []),
        # (2) what must be reported is reported
        ("★ ab.confound",
         lambda: [p.code for p in check(confound_spec, d)[0]] == ["ab.confound"]),
        ("★ ab.artifact_unreadable",
         lambda: [p.code for p in check(
             {"pairs": [{"name": "x", "a": "nope-a.json", "b": "nope-b.json",
                         }]}, d)[0]] == ["ab.artifact_unreadable"]),
        ("★ ab.optional_forbidden",
         lambda: "gate.optional_forbidden" in [p.code for p in check(
             {"pairs": [{"name": "x", "a": "nope-a.json", "b": "nope-b.json",
                         "optional": True}]}, d)[0]]),
        ("★ ab.not_a_dict",
         lambda: [p.code for p in check(
             {"pairs": [{"name": "x", "a": "nokey.json", "b": "nokey.json",
                         "key": "declared"}]}, d)[0]] == ["ab.not_a_dict"]),
        ("★ ab.pair_missing_field",
         lambda: [p.code for p in check(
             {"pairs": [{"a": "a.json", "b": "b.json"}]}, d)[0]]
         == ["ab.pair_missing_field"]),
        # (3) empty input must be reported
        ("★ ab.empty",
         lambda: [p.code for p in check(empty, d)[0]] == ["ab.empty"]),
    ]


GATE = meta("A/B gate", "A/B same-flags invariant (a difference outside the allow axis = confounding variable, A/B void)",
            knobs=("REFLECT_AB",),
            off_reason="repos that run no A/B experiments do not need it: spec unset => explicitly not enabled")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], "check_ab", _cases, main))
