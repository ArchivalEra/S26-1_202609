#!/usr/bin/env python3
"""Upstream/derived-tree pin consistency gate (**pluggable module**; generalized
from the repo-architecture batch of Octave-Full-Wasm).

A new gap when a repo carries N upstream forks/submodules: **the submodule
pointer was bumped while the derived copy (the provisioned tree / deploy
directory inside a container) still runs the old content** -- that drift appears
in no git view. Mechanism: the provisioner (the build script) writes a stamp
file **at the same moment** it copies the derived tree (convention:
`<name> <branch> <commit> <dirty-count>`); every commit, this gate reads the
stamp against the worktree's HEAD -- three assertions: commit matches / the
derived tree is clean / the version string matches.

Spec (`REFLECT_PINS`, default `pins.json`; data, not code):

    { "pins": [
        { "name": "octave", "kind": "tree",
          "worktree": "upstream/octave",                  # host git worktree
          "stamp_read": "sudo -E docker exec ctr cat /x/.upstream-pin" },
        { "name": "emsdk", "kind": "version",
          "worktree": "upstream/emsdk",
          "version_read": "sudo -E docker exec ctr emcc --version",
          "expect_version": "5.0.7" } ] }

- `tree`: derived copy <-> worktree HEAD. Both a commit mismatch (pointer
  bumped after provisioning) and dirty != 0 (someone hand-edited the derived
  tree) are reported -- same family as "declared but never checked": "copied
  but never pinned".
- `version`: the first line of the command output must contain
  `expect_version` (for upstreams like portable toolchains that cannot commit
  the whole tree to git, pin the version string).
- Command output unreadable => `SKIP:` (explicitly unchecked, not a pass --
  running on a different machine is not an error); empty pins => reported
  (zero-value guard); `REFLECT_PINS` unset => explicitly not enabled, exit 0;
  explicitly specified (--spec / knob) but the file is missing => FATAL exit 2.

Orthogonal to `check_invariants` (#7): that one guards **repo file text**, this
one guards **the living identity of the derived copy**.
Orthogonal to `doctor` (#10): doctor asks "is it alive?", this gate asks "is it
the pinned one?".

Usage (cwd = repo root): python3 zreflect/check_pins.py [--spec pins.json]
(Spec-name resolution: explicit --spec > `REFLECT_PINS` knob > default
`pins.json`.)
Exit codes: 0 = green or not enabled / 1 = problems found / 2 = broken config.
Selftest: --selftest (runner-injected; never touches real docker).
"""
from __future__ import annotations

import os
import shlex
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import gate  # noqa: E402
from gate import main_selftest_or, meta, repo  # noqa: E402
from i18n import M, Message  # noqa: E402


def _run(cmd):
    rc, out = gate.run_cmd(cmd)
    return (-1 if rc is None else rc), out.strip()


def _required_field_problems(p):
    """A pin entry missing a required field (name / worktree) => report."""
    return [M("pins.pin_missing_field", field=f, entry=p)
            for f in ("name", "worktree") if not p.get(f)]


def _head_problems(p, root, run):
    """Read the worktree HEAD. Returns (problem list, head or None); None means
    this pin ends here."""
    wt = gate.repo_path(p["worktree"], root)
    if not os.path.isdir(wt):
        return [M("pins.worktree_missing", name=p["name"],
                  path=p["worktree"])], None
    wt_arg = shlex.quote(wt.replace("\\", "/") if os.name == "nt" else wt)
    rc, head = run("git -C %s rev-parse HEAD" % wt_arg)
    if rc != 0:
        return [M("pins.head_unreadable", name=p["name"])], None
    return [], head


def _tree_pin_problems(p, head, run):
    """kind=tree: derived copy <-> worktree HEAD (commit matches / tree clean).

    Returns (problems, skips).
    """
    problems: list[Message] = []
    skips: list[Message] = []
    if p.get("optional"):
        problems.append(M("gate.optional_forbidden", name=p["name"]))
    rc, out = run(p["stamp_read"])
    if rc != 0 or not out:
        problems.append(M("pins.stamp_unreadable", name=p["name"]))
        return problems, skips
    parts = out.split()
    if len(parts) < 4:
        problems.append(M("pins.stamp_malformed", name=p["name"], actual=out[:40]))
        return problems, skips
    if parts[2] != head:
        problems.append(M("pins.commit_mismatch", name=p["name"],
                          declared=parts[2][:12], actual=head[:12]))
    if parts[3] != "0":
        problems.append(M("pins.dirty", name=p["name"], count=parts[3]))
    return problems, skips


def _version_pin_problems(p, run):
    """kind=version: the first line of the command output must contain
    expect_version (token-bounded). Returns (problems, skips)."""
    import re  # noqa: PLC0415
    problems: list[Message] = []
    skips: list[Message] = []
    if p.get("optional"):
        problems.append(M("gate.optional_forbidden", name=p["name"]))
    rc, out = run(p.get("version_read", ""))
    first = out.splitlines()[0] if out else ""
    if rc != 0 or not first:
        problems.append(M("pins.version_unreadable", name=p["name"]))
        return problems, skips
    expect = p.get("expect_version")
    if not expect:
        problems.append(M("pins.pin_missing_field", field="expect_version", entry=p))
    elif not re.search(r"(?<![0-9A-Za-z.])%s(?![0-9A-Za-z.])" % re.escape(expect), first):
        problems.append(M("pins.version_drift", name=p["name"],
                          declared=expect, actual=first[:48]))
    return problems, skips


def _pin_problems(p, root, run):
    """The three assertions for one pin (fields / HEAD / kind dispatch).
    Returns (problems, skips)."""
    problems = _required_field_problems(p)
    skips: list[Message] = []
    if problems:
        # A missing required field ends it here (the HEAD / kind reads below all
        # need name/worktree; the missing field is itself the reportable fact --
        # do not let it degrade into a KeyError).
        return problems, skips
    head_probs, head = _head_problems(p, root, run)
    problems += head_probs
    if head is None:
        return problems, skips
    kind = p.get("kind")
    if kind == "tree":
        tree_probs, tree_skips = _tree_pin_problems(p, head, run)
    elif kind == "version":
        tree_probs, tree_skips = _version_pin_problems(p, run)
    else:
        tree_probs = [M("pins.unknown_kind", name=p["name"], field=kind)]
        tree_skips = []
    return problems + tree_probs, skips + tree_skips


_PINS_JSON = "pins.json"


def check(spec, run=_run, root=None):
    """Pure logic (the selftest injects `run`). Returns (problems, skips).

    `root` = the anchor for resolving relative worktrees (default: the repo
    under check; the selftest passes a fixture directory).
    """
    root = repo() if root is None else root
    if not isinstance(spec, dict):
        return [M("pins.spec_broken", name=_PINS_JSON, error="spec must be an object")], []
    pins = spec.get("pins")
    if not isinstance(pins, list) or not pins:
        return [M("pins.empty")], []
    problems, skips = gate.exec_position_problems(spec, _PINS_JSON), []
    for p in pins:
        probs, sks = _pin_problems(p, root, run)
        problems += probs
        skips += sks
    return problems, skips


def main(argv):
    return gate.run_spec_gate(
        argv, "REFLECT_PINS",
        off_msg=lambda n: M("pins.off", name=n),
        missing_msg=lambda n: M("pins.explicit_spec_missing", name=n),
        broken_msg=lambda n, err: M("pins.spec_broken", name=n, error=err),
        title=M("pins.title"),
        judge=check,
        ok_msg=lambda spec: M("pins.ok", count=len(spec.get("pins") or [])),
    )


def _fixture():
    """Git worktree fixture and specs for `_cases()`."""
    import atexit  # noqa: PLC0415
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    atexit.register(shutil.rmtree, d, True)
    os.makedirs(os.path.join(d, "wt"))
    subprocess.run(["git", "init", "-q", os.path.join(d, "wt")], check=True)
    open(os.path.join(d, "wt", "f"), "w", encoding="utf-8").write("x")
    subprocess.run(["git", "-C", os.path.join(d, "wt"), "add", "f"], check=True)
    subprocess.run(["git", "-C", os.path.join(d, "wt"), "-c", "user.name=t", "-c",
                    "user.email=t@t", "commit", "-qm", "base"], check=True)
    head = subprocess.run(
        ["git", "-C", os.path.join(d, "wt"), "rev-parse", "HEAD"],
        capture_output=True, text=True,
                           encoding="utf-8", errors="replace").stdout.strip()
    wt = os.path.join(d, "wt")
    stamp = "echo octave wasm/11.3.0 %s 0"
    return {
        "d": d,
        "wt": wt,
        "ok": {"pins": [
            {"name": "octave", "kind": "tree", "worktree": wt,
             "stamp_read": stamp % head},
            {"name": "emsdk", "kind": "version", "worktree": wt,
             "version_read": "echo emcc 5.0.7", "expect_version": "5.0.7"}]},
        "commit_mismatch": {"pins": [{
            "name": "octave", "kind": "tree", "worktree": wt,
            "stamp_read": stamp % ("d" * 40)}]},
        "dirty": {"pins": [{
            "name": "octave", "kind": "tree", "worktree": wt,
            "stamp_read": "echo octave wasm/11.3.0 %s 3" % head}]},
        "version_drift": {"pins": [{
            "name": "emsdk", "kind": "version", "worktree": wt,
            "version_read": "echo emcc 6.0.10", "expect_version": "5.0.7"}]},
        "skip": {"pins": [{"name": "octave", "kind": "tree", "worktree": wt,
                           "stamp_read": "false"}]},
        "no_pins": {"pins": []},
    }


def _cases():
    fx = _fixture()
    d = fx["d"]
    k_json = "K.json"
    return [
        ("pins.resolve_spec",
         lambda: gate.resolve_spec(["--spec", "x.json"], k_json, _PINS_JSON) == ("x.json", True)
         and gate.resolve_spec([], k_json, _PINS_JSON) == (k_json, True)
         and gate.resolve_spec([], "", _PINS_JSON) == (_PINS_JSON, False)),
        # (1) compliant input: nothing reported
        ("pins.ok", lambda: check(fx["ok"], run=_run, root=d) == ([], [])),
        # (2) what must be reported is reported
        ("\u2605 pins.commit_mismatch",
         lambda: [p.code for p in check(fx["commit_mismatch"], run=_run,
                                        root=d)[0]] == ["pins.commit_mismatch"]),
        ("\u2605 pins.dirty",
         lambda: [p.code for p in check(fx["dirty"], run=_run, root=d)[0]]
         == ["pins.dirty"]),
        ("\u2605 pins.version_drift",
         lambda: [p.code for p in check(fx["version_drift"], run=_run,
                                        root=d)[0]] == ["pins.version_drift"]),
        ("\u2605 pins.stamp_unreadable",
         lambda: [p.code for p in check(fx["skip"], run=_run, root=d)[0]]
         == ["pins.stamp_unreadable"]),
        ("\u2605 pins.optional_forbidden",
         lambda: "gate.optional_forbidden" in [p.code for p in check(
             {"pins": [{**fx["skip"]["pins"][0], "optional": True}]}, run=_run, root=d)[0]]),
        ("\u2605 pins.worktree_missing",
         lambda: [p.code for p in check(
             {"pins": [{"name": "x", "kind": "tree", "worktree": "nope",
                        "stamp_read": "true"}]}, run=_run, root=d)[0]]
         == ["pins.worktree_missing"]),
        ("\u2605 pins.pin_missing_field",
         lambda: [p.code for p in check(
             {"pins": [{"name": "x", "kind": "tree", "stamp_read": "true"}]},
             run=_run, root=d)[0]] == ["pins.pin_missing_field"]),
        ("\u2605 pins.unknown_kind",
         lambda: [p.code for p in check(
             {"pins": [{"name": "x", "kind": "weird", "worktree": fx["wt"]}]},
             run=_run, root=d)[0]] == ["pins.unknown_kind"]),
        # (3) empty input must be reported
        ("\u2605 pins.empty",
         lambda: [p.code for p in check(fx["no_pins"], root=d)[0]]
         == ["pins.empty"]),
    ]


GATE = meta("pin gate", "derived-tree pin consistency (stamp commit / dirty / version string cross-read)",
            knobs=("REFLECT_PINS",),
            off_reason="repos without a derived tree do not need it: spec unset => explicitly not enabled")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], "check_pins", _cases, main))
