#!/usr/bin/env python3
"""Declarative verification-target gate (reflection world, **pluggable module**, issue #13).

In multi-line repos (several independently maintained product lines sharing
one set of gates and one verification environment), verification gates read
"**whichever world happens to be deployed**" -- three real incidents
(Octave-Full-Wasm, 2026-10-07):

  1. After cherry-picking a commit onto wasm64-NEXT, a gate went red: NEXT's
     plugin roster was being checked against the site deployed by
     IllegalPerformance -- the gate wasn't broken; it faithfully compared the
     world that happened to be deployed in the environment, and that world
     belonged to another line;
  2. The same shape went red again on master: master's verification target
     should be the repo's own site/, not the shared deployed site;
  3. Artifacts rebuilt on NEXT leaked into rust_sort: the shared container
     was running another line's build script (the version with the IP
     table flipped).

Root cause (in seam language): a seam exists, but it is **four parallel
half-seams** -- different names, different defaults, different coverage
(some gates read env, some hardcode a container, some read "latest");
nothing forces the gates to align with "this line's world" when switching
lines.

World declaration (**data, not code**, same pattern as #7):

    { "lines": {
        "wasm64-NEXT": { "site": "/.../next-base/site",
                          "artifacts": "/.../next-base/w64-artifacts",
                          "container": "o113",
                          "fork_pin_ref": "upstream/octave" } },
      "active": "wasm64-NEXT",
      "stamps": {
        "container": { "value": "sha256:...",
                        "cmd": "docker inspect --format '{{.Image}}' o113" },
        "site":     { "value": "sha256:...",
                        "cmd": "find /.../site -type f | sort | xargs sha256sum | sha256sum" },
        "scripts":  { "value": "sha256:...",
                        "cmd": "sha256sum relink.sh link-web.sh | sha256sum" } } }

The gate does three things:

  · **Resolve the current line** (unified interface): `REFLECT_WORLD_LINE`
    (override for CI / special run modes) > current branch name (if the
    branch is a line in the roster) > `active` (a human's decision). Other
    gates obtain their verification target via `resolve_line()` -- replacing
    four ambient knobs; the gate's deep-module nature is unchanged, what
    gets hidden is "how the world resolves";
  · **Branch audit**: the branch is a line in the roster yet != `active` => red
    (the shape of incidents 1/2: a human switched branches without running
    the line-switch script, active still points at the other line);
  · **Stamp audit**: each stamp's `cmd` is replayed verbatim (bare-value
    contract -- `run_cmd` grafts the replay gate directly), stdout != `value`
    => red (the shape of incident 3: the container runs another line's
    script, artifacts got contaminated).

**Switching lines = running a script that this gate audits**: after the
script finishes its three steps (submodule update + re-provision + cp
scripts) it **writes out** the world declaration (active + stamps), and
this gate audits declaration vs environment at commit time -- turning the
"three-step line switch" from verbal discipline into a witnessed act
(same grafting approach as doctor/witness).

Pluggable: `REFLECT_WORLD` unset and the default `world.json` absent =>
state plainly that it is off, return 0. **Single-line repos neither benefit
nor suffer** (one world = the status-quo behavior -- a boundary the issue
states explicitly; what this bites is the shape "several independently
maintained lines sharing one verification environment").

Honest boundary (stated in the issue, not hidden):

  · **No automatic line selection is proposed** -- which line counts as
    current is a human's decision (the `active` field); the machine only
    ensures declaration and environment agree;
  · Cross-engine reproducibility (relaxed_madd makes BLAS results vary in
    the last digit -- IEEE-compliant yet irreproducible) is a separate topic,
    orthogonal to this item's "verifying the wrong world"; don't conflate;
  · A stamp's `cmd` is written by the repo itself -- same trust boundary as
    the replay gate (the repo produces it and reviews it itself).

Usage (run directly, cwd=repo root):
    python3 zreflect/check_world.py [--selftest]
Exit codes: 0=green / 1=problems found / 2=configuration or environment broken.
"""
from __future__ import annotations

import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gate  # noqa: E402
import knobs  # noqa: E402
from gate import finish, main_selftest_or, meta, quote, run_cmd  # noqa: E402
from i18n import M  # noqa: E402


def _line_override():
    return (knobs.raw("REFLECT_WORLD_LINE") or "").strip()

# Required fields of a line (the four-piece set of the shape suggested by
# issue #13; extra fields are allowed to pass through verbatim -- each line's
# custom verification-target fields are read by consumer gates via
# resolve_line()).
LINE_FIELDS = ("site", "artifacts", "container", "fork_pin_ref")


def current_branch():
    """Current git branch name (detached HEAD / not a repo => empty string =
    takes no part in line selection; CI override goes through
    REFLECT_WORLD_LINE)."""
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=5,
            cwd=gate.repo(),
                           encoding="utf-8", errors="replace")
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def resolve_line(spec, branch, override=None):
    """Unified interface: returns (line name, the line's world dict).

    Resolution order: override (CI / special run modes) > branch name (if the
    branch is a line in the roster) > active (a human's decision). Other gates
    consume their verification target through this -- replacing four ambient
    knobs with different names, different defaults, different coverage.
    Unresolvable => (None, None) (the shapes the caller should report are
    reported by spec_problems; not re-judged here).
    """
    lines = spec.get("lines") if isinstance(spec, dict) else None
    lines = lines if isinstance(lines, dict) else {}
    active = str(spec.get("active") or "").strip() \
        if isinstance(spec, dict) else ""
    ov = (_line_override() if override is None else override).strip()
    if ov and ov in lines:
        return ov, lines[ov]
    if branch and branch in lines:
        return branch, lines[branch]
    if active and active in lines:
        return active, lines[active]
    return None, None


def _line_problems(lines):
    """Shape of each line: must be an object with all fields present."""
    out = []
    for name in sorted(lines):
        ln = lines[name]
        if not isinstance(ln, dict):
            out.append(M("world.line_not_object", line_name=name, line=ln))
            continue
        for f in LINE_FIELDS:
            if not str(ln.get(f) or "").strip():
                out.append(M("world.line_missing_field", line_name=name,
                             field=f, fields=", ".join(LINE_FIELDS)))
    return out


def _active_problems(active, lines):
    """`active` must be present and a known line."""
    if not active:
        return [M("world.active_missing")]
    if active not in lines:
        return [M("world.active_unknown", active=active,
                  lines=", ".join(sorted(lines)))]
    return []


def _branch_problems(branch, active, lines, override):
    """Branch audit: detached HEAD, unlisted branch, or a different line without override => red."""
    if override or not active:
        return []
    if not branch:
        return [M("world.branch_mismatch", branch="DETACHED", active=active)]
    if branch != active:
        return [M("world.branch_mismatch", branch=branch, active=active)]
    return []


def spec_problems(spec, branch, override):
    """Pure function: spec-shape + branch-audit problems (empty = valid).
    No printing allowed during selftest.

    The four groups of criteria are each a named helper (container shape /
    line shape / active / branch audit): they don't depend on each other;
    concatenating them just makes the call site look short.
    """
    if not isinstance(spec, dict):
        return [M("world.spec_not_object")]
    lines = spec.get("lines")
    if not isinstance(lines, dict) or not lines:
        return [M("world.lines_empty")]
    active = str(spec.get("active") or "").strip()
    out = _active_problems(active, lines) + _line_problems(lines)
    if override and override not in lines:
        out.append(M("world.override_unknown", line_name=override))
    return out + _branch_problems(branch, active, lines, override)


def _one_stamp_problem(name, st, run):
    """Verdict for one stamp. Returns the problem list (empty = pass)."""
    if not isinstance(st, dict):
        return [M("world.stamp_not_object", name=name, entry=st)]
    value = str(st.get("value") or "").strip()
    cmd = str(st.get("cmd") or "").strip()
    if not value:
        return [M("world.stamp_missing_value", name=name)]
    if not cmd:
        return [M("world.stamp_missing_cmd", name=name)]
    rc, stdout = run(cmd)
    if rc is None:
        return [M("world.stamp_timeout", name=name, command=cmd)]
    if rc != 0:
        return [M("world.stamp_command_failed", name=name,
                  return_code=rc, command=cmd)]
    got = stdout.strip()
    if got != value:
        return [M("world.stamp_mismatch", name=name,
                  actual=quote(got), expected=quote(value))]
    return []


def stamp_problems(spec, runner=None):
    """Stamp audit (side effects only through runner): each stamp's cmd is
    replayed verbatim, stdout must equal the declared value -- the bare-value
    contract grafts the replay gate directly onto the criteria (`run_cmd` /
    `_q`).

    The single-stamp verdict is a named helper: each of the failure modes
    (shape / missing value / missing command / timeout / exit code / value
    mismatch) was once a `continue`; squeezed into the loop, a reader had to
    count continues to know every one was covered.
    """
    stamps = spec.get("stamps") if isinstance(spec, dict) else None
    if not isinstance(stamps, dict) or not stamps:
        return [M("world.stamps_empty")]
    run = runner or run_cmd
    return [p for name in sorted(stamps)
            for p in _one_stamp_problem(name, stamps[name], run)]


def run(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    spec, spec_name, rc = gate.load_gate_spec(
        argv, "REFLECT_WORLD",
        off_msg=lambda _n: M("world.off"),
        missing_msg=lambda _n: M("world.knob_file_missing"),
        broken_msg=lambda n, err: M("world.spec_broken", name=n, error=err),
    )
    if rc is not None:
        return rc
    if not isinstance(spec, dict):
        return gate.fatal(M("world.spec_shape_bad", name=spec_name))
    override = _line_override()
    branch = current_branch()
    probs = spec_problems(spec, branch, override)
    probs += gate.exec_position_problems(spec, "world.json")
    probs += stamp_problems(spec)
    line, world = resolve_line(spec, branch, override)
    w = world if isinstance(world, dict) else {}
    return finish(M("world.title"), probs,
                  M("world.ok", line_name=line or "-",
                    container=w.get("container"), site=w.get("site"),
                    count=len(spec.get("stamps") or {})))


def _cases_fixture():
    """Fixture (the setup section of the original `_cases`, moved over verbatim)."""
    def line(site, art):
        return {"site": site, "artifacts": art,
                "container": "o113",
                "fork_pin_ref": "upstream/octave"}
    good = {
        "lines": {"wasm64-NEXT": line("/srv/next/site",
                                       "/srv/next/art"),
                  "IllegalPerformance": line("/srv/ip/site",
                                             "/srv/ip/art")},
        "active": "wasm64-NEXT",
        "stamps": {"container": {"value": "img-1",
                                  "cmd": "docker stamp"},
                   "site": {"value": "site-sha",
                             "cmd": "site sha"}},
    }

    def fake(outputs, rc=0):
        def r(cmd):
            return (rc, outputs.get(cmd, ""))
        return r

    match = fake({"docker stamp": "img-1", "site sha": "site-sha"})

    def all_green(spec, branch, runner):
        return (spec_problems(spec, branch, "") == []
                and stamp_problems(spec, runner) == [])

    return {'line': line, 'good': good, 'fake': fake, 'match': match, 'all_green': all_green}


def _cases_resolve(fx):
    """See `_cases()`: this group has 7 cases."""
    good, match, all_green = fx["good"], fx["match"], fx["all_green"]
    return [
    # (1) healthy input reports nothing
    ("world.ok",
     lambda: all_green(good, "wasm64-NEXT", match)),
    ("world.resolve_line_by_branch",
     lambda: resolve_line(good, "wasm64-NEXT", "")
     == ("wasm64-NEXT", good["lines"]["wasm64-NEXT"])),
    ("world.resolve_line_override_wins",
     lambda: resolve_line(good, "wasm64-NEXT",
                           "IllegalPerformance")[0]
     == "IllegalPerformance"),
    ("world.resolve_line_falls_back_to_active",
     lambda: resolve_line(good, "feature/x", "")[0]
     == "wasm64-NEXT"),
    ("★ world.override_unknown",
     lambda: [p.code for p in spec_problems(good, "", "ghost")]
     == ["world.override_unknown"]),
    ("★ world.branch_mismatch",
     lambda: [p.code for p in spec_problems(
         good, "IllegalPerformance", "")] == ["world.branch_mismatch"]),
    ("★ world.detached_head_flagged",
     lambda: [p.code for p in spec_problems(good, "", "")] == ["world.branch_mismatch"]),
    ("★ world.unlisted_branch_flagged",
     lambda: [p.code for p in spec_problems(good, "feature/x", "")] == ["world.branch_mismatch"]),
    ("world.branch_mismatch_override_present",
     lambda: spec_problems(good, "IllegalPerformance",
                            "IllegalPerformance") == []),
    ]


def _cases_stamps(fx):
    """See `_cases()`: this group has 5 cases."""
    good, fake = fx["good"], fx["fake"]
    return [
    ("★ world.stamp_mismatch",
     lambda: [p.code for p in stamp_problems(
         good, fake({"docker stamp": "img-2",
                     "site sha": "site-sha"}))] == ["world.stamp_mismatch"]),
    ("★ world.stamp_command_failed",
     lambda: [p.code for p in stamp_problems(
         good, fake({}, rc=1))] == ["world.stamp_command_failed"] * 2),
    ("★ world.stamp_timeout",
     lambda: [p.code for p in stamp_problems(
         good, fake({}, rc=None))] == ["world.stamp_timeout"] * 2),
    ("★ world.stamp_missing_cmd",
     lambda: [p.code for p in stamp_problems(
         {"stamps": {"s": {"value": "v"}}})] == ["world.stamp_missing_cmd"]),
    ("★ world.stamps_empty",
     lambda: [p.code for p in stamp_problems({"stamps": {}})]
     == ["world.stamps_empty"]),
    ]


def _cases_shape(fx):
    """See `_cases()`: this group has 6 cases."""
    good = fx["good"]
    return [
    # (2) what should be reported must be reported
    ("★ world.lines_empty",
     lambda: [p.code for p in spec_problems(
         {"lines": {}, "active": "x", "stamps": {}}, "", "")]
     == ["world.lines_empty"]),
    ("★ world.active_missing",
     lambda: [p.code for p in spec_problems(
         {"lines": good["lines"], "stamps": {}}, "", "")]
     == ["world.active_missing"]),
    ("★ world.active_unknown",
     lambda: [p.code for p in spec_problems(
         {"lines": good["lines"], "active": "ghost",
          "stamps": {}}, "ghost", "")] == ["world.active_unknown"]),
    ("★ world.line_missing_field",
     lambda: [p.code for p in spec_problems(
         {"lines": {"L": {"site": "s",
                          "artifacts": "a",
                          "fork_pin_ref": "r"}},
          "active": "L", "stamps": {}}, "L", "")]
     == ["world.line_missing_field"]),
    # (3) empty input must be reported
    ("★ world.spec_not_object",
     lambda: [p.code for p in spec_problems(None, "", "")]
     == ["world.spec_not_object"]),
    ("★ world.lines_empty_declared",
     lambda: [p.code for p in spec_problems({}, "", "")]
     == ["world.lines_empty"]),
    ]


def _cases():
    """Assemble the 3 groups of fixture assertions. **Assemble only** -- the criteria live in the group functions."""
    fx = _cases_fixture()
    return (
    _cases_resolve(fx)
    + _cases_stamps(fx)
    + _cases_shape(fx)
    )


GATE = meta("world gate",
            "declarative validation target: world reconciliation of a "
            "multi-line repo's shared validation environment",
            knobs=("REFLECT_WORLD", "REFLECT_WORLD_LINE"),
            off_reason="a single-line repo does not need it: spec not "
                       "configured => state it is off")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], "check_world", _cases(), run))
