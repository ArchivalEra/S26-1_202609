#!/usr/bin/env python3
"""Runnable usage examples, discovered from ``examples/*/example.json``.

The public interface is deliberately small::

    python3 zreflect/examples.py --list
    python3 zreflect/examples.py --check
    python3 zreflect/examples.py --all
    python3 zreflect/examples.py quickstart

Every example runs in a temporary repo containing a fresh copy of the suite.
A manifest declares environment and argv steps; each step declares its expected
exit code and optional output fragments. Red-path examples therefore prove real
behavior without leaving fixtures or credentials in the audited repo.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gate  # noqa: E402
import registry  # noqa: E402
from gate import main_selftest_or, module_meta  # noqa: E402
from i18n import M, Message  # noqa: E402

DEFAULT_ROOT = os.path.join(gate.tool_repo(), "examples")
DEFAULT_TIMEOUT = 120
OUTPUT_TAIL = 4000   # kept on failure: enough for a traceback, bounded for a report
IGNORE = shutil.ignore_patterns(
    ".git", "__pycache__", ".mypy_cache", ".ruff_cache")
# ``posix`` means the payload shells out to ``sh`` or a Unix-only binary.
# Windows cannot run those, and a silent pass there would claim coverage the
# platform never exercised -- so a skip is reported and counted, never green.
POSIX = "posix"
PLATFORMS = ("posix", "windows")


def platform_name(platform=None):
    return POSIX if (platform or os.name) != "nt" else "windows"


def manifest_problems(spec):
    """Validate one manifest without touching the filesystem."""
    if not isinstance(spec, dict):
        return [M("examples.manifest_not_object")]
    out = []
    if not str(spec.get("description") or "").strip():
        out.append(M("examples.description_missing"))
    steps = spec.get("steps")
    if not isinstance(steps, list) or not steps:
        return out + [M("examples.steps_empty")]
    platforms = spec.get("platforms", [POSIX])
    if (not isinstance(platforms, list) or not platforms
            or any(item not in PLATFORMS for item in platforms)):
        out.append(M("examples.platforms_bad"))
    env = spec.get("env", {})
    if not isinstance(env, dict) or any(
            not isinstance(k, str) or not isinstance(v, str) for k, v in env.items()):
        out.append(M("examples.env_bad"))
    for index, step in enumerate(steps, 1):
        out += _step_shape_problems(step, index)
    return out


def _step_shape_problems(step, index):
    if not isinstance(step, dict):
        return [M("examples.step_not_object", step=index)]
    out = []
    argv = step.get("argv")
    if (not isinstance(argv, list) or not argv
            or any(not isinstance(arg, str) or not arg for arg in argv)):
        out.append(M("examples.argv_bad", step=index))
    rc = step.get("rc", 0)
    if isinstance(rc, bool) or not isinstance(rc, int) or not 0 <= rc <= 255:
        out.append(M("examples.rc_bad", step=index))
    for field in ("contains", "not_contains"):
        value = step.get(field, [])
        if isinstance(value, str):
            value = [value]
        if not isinstance(value, list) or any(not isinstance(x, str) for x in value):
            out.append(M("examples.output_match_bad", step=index, field=field))
    env = step.get("env", {})
    if not isinstance(env, dict) or any(
            not isinstance(k, str) or not isinstance(v, str) for k, v in env.items()):
        out.append(M("examples.step_env_bad", step=index))
    return out


def discover(root):
    """Return ``({name: manifest}, problems)``; no directory means no examples."""
    manifests: dict[str, dict[str, Any]] = {}
    problems: list[Message] = []
    if not os.path.isdir(root):
        return manifests, [M("examples.root_missing", path=root)]
    for name in sorted(os.listdir(root)):
        path = os.path.join(root, name, "example.json")
        if not os.path.isfile(path):
            continue
        try:
            with open(path, encoding="utf-8") as fh:
                spec = json.load(fh)
        except (OSError, ValueError) as exc:
            problems.append(M("examples.manifest_unreadable", example=name, error=exc))
            continue
        manifests[name] = spec
        problems += [M("examples.manifest_entry", example=name, detail=problem)
                     for problem in manifest_problems(spec)]
    if not manifests:
        problems.append(M("examples.empty"))
    return manifests, problems


def coverage_problems(manifests, gates, modules=()):
    """Every declared gate and core module has a same-named example."""
    if not gates:
        return [M("examples.gates_empty")]
    expected = {os.path.splitext(os.path.basename(item["file"]))[0] for item in gates}
    expected |= {os.path.splitext(os.path.basename(item["file"]))[0] for item in modules}
    return [M("examples.coverage_missing", example=name)
            for name in sorted(expected - set(manifests))]


def _copy_suite(suite_root, target):
    """Seed the temp repo with the suite **and the repo-level files gates read**.

    `ruff.toml` is the static criterion. `HISTORY.md` is the prose carrier: a
    gate now checks that it exists and stays off every scan surface, so a temp
    repo without one makes that gate red for a reason the example never asked
    about. Copying it keeps each example about its own subject.
    """
    for name in ("zreflect", "reflect-local"):
        shutil.copytree(os.path.join(suite_root, name), os.path.join(target, name),
                        ignore=IGNORE)
    for name in ("ruff.toml", "HISTORY.md"):
        path = os.path.join(suite_root, name)
        if os.path.isfile(path):
            shutil.copy2(path, os.path.join(target, name))


def _copy_payload(example_dir, target):
    for name in sorted(os.listdir(example_dir)):
        if name in ("example.json", "README.md"):
            continue
        src = os.path.join(example_dir, name)
        dst = os.path.join(target, name)
        if os.path.isdir(src):
            shutil.copytree(src, dst, ignore=IGNORE, dirs_exist_ok=True)
        else:
            shutil.copy2(src, dst)


def _environment(target, manifest, step):
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("REFLECT_", "EINFACHT_"))}
    env["GATE_REPO"] = target
    env["PYTHONPATH"] = os.path.join(target, "zreflect")
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env.update(manifest.get("env", {}))
    env.update(step.get("env", {}))
    return env


def _argv(argv, target):
    replacements = {"{python}": sys.executable, "{repo}": target}
    return [replacements.get(arg, arg.replace("{repo}", target)) for arg in argv]


def _unexpected_off_problems(step, expected, output):
    if expected != 0 or step.get("allow_off"):
        return []
    raw_c = step.get("contains", [])
    allowed = " ".join(raw_c) if isinstance(raw_c, list) else str(raw_c)
    return [M("examples.output_forbidden", fragment=marker)
            for marker in ("OFF:", "SKIP:")
            if marker not in allowed
            and any(ln.lstrip().startswith(marker) for ln in output.splitlines())]


def judge_step(step, rc, output):
    """Compare one completed step with its declared result."""
    out = []
    expected = step.get("rc", 0)
    if rc != expected:
        out.append(M("examples.step_rc", expected=expected, actual=rc))
    for field in ("contains", "not_contains"):
        wanted = step.get(field, [])
        if isinstance(wanted, str):
            wanted = [wanted]
        for fragment in wanted:
            present = fragment in output
            if field == "contains" and not present:
                out.append(M("examples.output_missing", fragment=fragment))
            elif field == "not_contains" and present:
                out.append(M("examples.output_forbidden", fragment=fragment))
    return out + _unexpected_off_problems(step, expected, output)


def _decode_output(val):
    """Normalize `bytes | str | None` subprocess streams before concatenation."""
    if not val:
        return ""
    return val.decode("utf-8", "replace") if isinstance(val, bytes) else val


def _run_step(step, target, manifest):
    argv = _argv(step["argv"], target)
    env = _environment(target, manifest, step)
    try:
        proc = subprocess.run(
            argv, cwd=target, env=env,
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=step.get("timeout", DEFAULT_TIMEOUT), check=False)
    except subprocess.TimeoutExpired as exc:
        # A timeout must keep whatever the step managed to print, otherwise the
        # one case where output matters most is the one case with no output.
        partial = _decode_output(exc.stdout) + _decode_output(exc.stderr)
        return partial, [M("examples.step_timeout",
                           command=argv, seconds=step.get("timeout", DEFAULT_TIMEOUT))]
    except (OSError, subprocess.SubprocessError) as exc:
        return "", [M("examples.step_broken", command=argv, error=exc)]
    output = (proc.stdout or "") + (proc.stderr or "")
    return output, judge_step(step, proc.returncode, output)


def _step_problems(manifest, target):
    problems = []
    for index, step in enumerate(manifest["steps"], 1):
        output, current = _run_step(step, target, manifest)
        cmd = " ".join(_argv(step["argv"], target))
        problems += [M("examples.step_entry", example=manifest["description"],
                       step=index, command=cmd, detail=problem) for problem in current]
        if current:
            problems.append(M("examples.step_output", output=output[-OUTPUT_TAIL:]))
            break
    return problems


def applies_to(spec, platform=None):
    """Whether this manifest runs on the current platform (default: posix-only)."""
    declared = spec.get("platforms", [POSIX])
    return platform_name(platform) in declared


def run_example(name, root=DEFAULT_ROOT):
    """Run one isolated example and return ``(problems, skipped)``."""
    suite_root = gate.tool_repo()
    example_dir = os.path.join(root, name)
    try:
        with open(os.path.join(example_dir, "example.json"), encoding="utf-8") as fh:
            manifest = json.load(fh)
    except (OSError, ValueError) as exc:
        return [M("examples.manifest_unreadable", example=name, error=exc)], False
    shape = manifest_problems(manifest)
    if shape:
        return shape, False
    if not applies_to(manifest):
        return [], True
    with tempfile.TemporaryDirectory(prefix="einfacht-example-") as target:
        try:
            _copy_suite(suite_root, target)
            if manifest.get("init", True):
                bootstrap = {"argv": ["{python}", "zreflect/facts.py", "--init"]}
                output, problems = _run_step(bootstrap, target, manifest)
                if problems:
                    return problems + [M("examples.step_output",
                                         output=output[-OUTPUT_TAIL:])], False
            _copy_payload(example_dir, target)
            return _step_problems(manifest, target), False
        except OSError as exc:
            return [M("examples.materialize_failed", example=name, error=exc)], False


def _print_problems(problems):
    for problem in problems:
        if getattr(problem, "code", "") == "examples.step_output":
            print("  · " + str(M("examples.output_replay")), file=sys.stderr)
            print(problem.params.get("output", ""), file=sys.stderr)
        else:
            print("  · " + str(problem), file=sys.stderr)
def _run_all(root):
    import concurrent.futures  # noqa: PLC0415
    manifests, problems = discover(root)
    gates, missing = registry.gates()
    mods, _ = registry.modules()
    problems += [M("examples.gate_undeclared", file=name) for name in missing]
    problems += coverage_problems(manifests, gates, modules=mods)
    if problems:
        _print_problems(problems)
        return 2
    names = sorted(manifests)
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(12, os.cpu_count() or 4, max(1, len(names)))) as pool:
        results = dict(zip(names, pool.map(lambda n: run_example(n, root), names), strict=True))
    failed = skipped = 0
    for name in names:
        current, was_skipped = results[name]
        if was_skipped:
            skipped += 1
            print(M("examples.skip", example=name, platform=platform_name()))
        elif current:
            failed += 1
            print(M("examples.fail", example=name), file=sys.stderr)
            _print_problems(current)
        else:
            print(M("examples.pass", example=name))
    print(M("examples.summary", count=len(manifests), failed=failed, skipped=skipped))
    return 1 if (failed or skipped) else 0


def _take_root(argv):
    """Split ``--root DIR`` off the argv; a missing operand is a usage error."""
    if "--root" not in argv:
        return DEFAULT_ROOT, argv, None
    index = argv.index("--root")
    if index + 1 >= len(argv):
        print(M("examples.usage"), file=sys.stderr)
        return None, argv, 2
    return (os.path.abspath(argv[index + 1]),
            argv[:index] + argv[index + 2:], None)


def _list(root):
    manifests, problems = discover(root)
    _print_problems(problems)
    for name, spec in manifests.items():
        print("%s -- %s" % (name, spec.get("description", "")))
    return 2 if problems else 0


def _check(root):
    manifests, problems = discover(root)
    gates, missing = registry.gates()
    mods, _ = registry.modules()
    problems += coverage_problems(manifests, gates, modules=mods)
    problems += [M("examples.gate_undeclared", file=name) for name in missing]
    _print_problems(problems)
    print(M("examples.coverage_ok", count=len(manifests)) if not problems
          else M("examples.coverage_failed"))
    return 2 if problems else 0


def _one(name, root):
    current, was_skipped = run_example(name, root)
    if was_skipped:
        print(M("examples.skip", example=name, platform=platform_name()))
        return 0
    if current:
        print(M("examples.fail", example=name), file=sys.stderr)
        _print_problems(current)
        return 1
    print(M("examples.pass", example=name))
    return 0


def run(argv):
    root, argv, error = _take_root(list(argv))
    if error is not None:
        return error
    if argv == ["--all"]:
        return _run_all(root)
    if argv == ["--list"]:
        return _list(root)
    if argv == ["--check"]:
        return _check(root)
    if len(argv) == 1 and not argv[0].startswith("-"):
        return _one(argv[0], root)
    print(M("examples.usage"), file=sys.stderr)
    return 2


def _cases():
    good = {"description": "demo", "steps": [{"argv": ["{python}", "x.py"]}]}
    empty = {"description": "demo", "steps": []}
    gates = [{"file": "zreflect/check_demo.py"}]
    bad_platforms = {"description": "demo", "platforms": ["beos"],
                     "steps": [{"argv": ["{python}", "x.py"]}]}
    return [
        ("examples.valid_manifest", lambda: manifest_problems(good) == []),
        ("examples.expected_red_is_a_pass",
         lambda: judge_step({"rc": 1, "contains": ["DRIFT"]}, 1, "DRIFT x") == []),
        ("★ examples.wrong_rc", lambda: [p.code for p in judge_step({}, 1, "")]
         == ["examples.step_rc"]),
        ("★ examples.missing_output",
         lambda: [p.code for p in judge_step({"contains": ["ok"]}, 0, "")]
         == ["examples.output_missing"]),
        ("★ examples.forbidden_output",
         lambda: [p.code for p in judge_step({"not_contains": ["ok"]}, 0, "ok")]
         == ["examples.output_forbidden"]),
        ("★ examples.empty_steps",
         lambda: [p.code for p in manifest_problems(empty)] == ["examples.steps_empty"]),
        ("★ examples.coverage_missing",
         lambda: [p.code for p in coverage_problems({}, gates)]
         == ["examples.coverage_missing"]
         and [p.code for p in coverage_problems({"check_demo": good}, gates, modules=[{"file": "zreflect/core_mod.py"}])]
         == ["examples.coverage_missing"]),
        ("★ examples.empty_gate_roster",
         lambda: [p.code for p in coverage_problems({"x": good}, [])]
         == ["examples.gates_empty"]),
        # a platform the suite never runs on must be rejected, not silently
        # treated as "posix, so fine"
        ("★ examples.platforms_bad",
         lambda: [p.code for p in manifest_problems(bad_platforms)]
         == ["examples.platforms_bad"]),
        # a posix-only manifest must be *skipped* on Windows and must not be
        # reported as a pass: silence would claim coverage that never ran
        ("★ examples.posix_skipped_on_windows",
         lambda: applies_to({"platforms": ["posix"]}, "nt") is False
         and applies_to({"platforms": ["posix"]}, "posix") is True
         and applies_to({"platforms": ["posix", "windows"]}, "nt") is True),
        ("★ examples.timeout_stream_mix",
         lambda: _decode_output(b"out") + _decode_output(None) == "out"
         and _decode_output(b"a") + _decode_output("b") == "ab"
         and _decode_output("a") + _decode_output(b"b") == "ab"),
    ]


MODULE = module_meta("Example runner", "isolated runnable examples with discovered coverage")


if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], "examples", _cases, run))
