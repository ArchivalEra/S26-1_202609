#!/usr/bin/env python3
"""Gate platform: rc contract, zero-trust guards, spec helpers, verbatim command runner, phase executor."""
from __future__ import annotations

import ast
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import threading
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hashlib  # noqa: E402

import i18n  # noqa: E402
import knobs  # noqa: E402

GATE_REPO = os.environ.get("GATE_REPO") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

EXEC_PREFIXES = (
    "python3", "python", "sh", "bash", "node", "deno", "ruby", "perl",
    "echo", "printf", "cat", "test", "true", "false", "env", "make", "git",
    "npm", "pnpm", "yarn", "cargo", "go", "gcc", "cc", "cmake", "docker",
)
_OUTCOME_SEP = re.compile(r"\s+(?:——|—|----|--)\s+")
_PROSE_CHARS = re.compile(r"[\u4e00-\u9fff（）【】；：，。]")
_QUOTED = re.compile(r'"([^"]*)"|(\S+)')
_PY_CMD = re.compile(r"(?:^|(?<=[\s;&]))python3?(?=\s)")
_TOOL_REL = re.compile(r"(?<!\w)(zreflect/[A-Za-z_][A-Za-z0-9_]*\.py)")
_NEEDS_QUOTING = re.compile(r"""[\s\\$`"'|&;<>()*?{}\[\]#~]""")


def repo(*parts):
    """Join path segments onto `GATE_REPO`."""
    return os.path.join(GATE_REPO, *parts)


def repo_path(path, root=None):
    """Anchor relative `path` onto `root` (defaults to `GATE_REPO`); pass absolute paths through."""
    base = GATE_REPO if root is None else root
    return path if os.path.isabs(path) else os.path.join(base, path)


def zdir():
    """Return the tool's `zreflect/` directory."""
    return os.path.dirname(os.path.abspath(__file__))


def tool_repo():
    """Return the parent directory of `zreflect/` (where bundled suite assets live)."""
    return os.path.dirname(zdir())


def sha256_file(path):
    """Compute hex SHA-256 of `path` using 1 MiB streaming chunks."""
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def require_nonempty(name, seq, what=None):
    """Raise `SystemExit(2)` with `FATAL:` message if `seq` is empty; return `list(seq)`."""
    label = i18n.M("gate.input_label") if what is None else what
    items = list(seq)
    if not items:
        fatal_exit(i18n.M("gate.require_nonempty", name=name, what=str(label)))
    return items


def guard_nonempty(name, seq, what=None):
    """RC-returning form of `require_nonempty`: empty prints FATAL to stderr and returns 2."""
    items = list(seq)
    if items:
        return None
    label = what if what is not None else i18n.M("gate.default_input_label")
    return fatal(i18n.M("gate.require_nonempty", name=name, what=str(label)))


def off(notice):
    """Emit `OFF:` marker on stdout and return rc=0."""
    print(i18n.emit("off", notice))
    return 0


def fatal(msg):
    """Emit `FATAL:` marker on stderr and return rc=2."""
    print(i18n.emit("fatal", msg), file=sys.stderr)
    return 2


def fatal_exit(msg):
    """Abort with `FATAL:` SystemExit(2)."""
    print(i18n.emit("fatal", msg), file=sys.stderr)
    raise SystemExit(2)


def declares_itself(path):
    """Check whether `path` declares top-level `GATE =` or `MODULE =`."""
    try:
        tree = ast.parse(open(path, encoding="utf-8", errors="replace").read())
    except (OSError, SyntaxError, UnicodeError):
        return False
    for stmt in tree.body:
        if isinstance(stmt, ast.Assign):
            names = {t.id for t in stmt.targets if isinstance(t, ast.Name)}
            if names & {"GATE", "MODULE"}:
                return True
    return False


def suite_sources(sub="zreflect"):
    """Collect `[(relpath, src)]` for undeclared/unskipped `.py` files in `zreflect/`."""
    d = zdir()
    out: list[tuple[str, str]] = []
    if not os.path.isdir(d):
        return out
    for n in sorted(os.listdir(d)):
        if n.endswith(".py") and n != "__init__.py" and not n.startswith("measure_"):
            p = os.path.join(d, n)
            if os.path.isfile(p) and declares_itself(p):
                out.append((sub + "/" + n, open(p, encoding="utf-8", errors="replace").read()))
    return out


def scanned_sources(d, configured=False):
    """Collect `[(relpath, src)]` from `d` (filtered by declaration only when unconfigured)."""
    out: list[tuple[str, str]] = []
    if not os.path.isdir(d):
        return out
    for dirpath, dirnames, filenames in os.walk(d):
        dirnames[:] = sorted(x for x in dirnames if x not in ("__pycache__", ".git"))
        for n in sorted(filenames):
            if not n.endswith(".py") or n == "__init__.py":
                continue
            p = os.path.join(dirpath, n)
            if configured or declares_itself(p):
                rel = os.path.relpath(p, d).replace(os.sep, "/")
                out.append((rel, open(p, encoding="utf-8", errors="replace").read()))
    return out


def py_sources(base):
    """Collect `[(relpath, source)]` for all `.py` files under `base` with forward slashes."""
    out: list[tuple[str, str]] = []
    if not os.path.isdir(base):
        return out
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(d for d in dirnames if d not in ("__pycache__", ".git"))
        for n in sorted(filenames):
            if not n.endswith(".py"):
                continue
            p = os.path.join(dirpath, n)
            rel = os.path.relpath(p, base).replace(os.sep, "/")
            try:
                out.append((rel, open(p, encoding="utf-8", errors="replace").read()))
            except OSError:
                continue
    return out


def resolve_spec(argv, knob, default):
    """Resolve spec path (`--spec` > `knob` > `default`) and return `(path, was_explicit)`."""
    for i, a in enumerate(argv):
        if a == "--spec":
            return (argv[i + 1] if i + 1 < len(argv) else ""), True
        if a.startswith("--spec="):
            return a[len("--spec="):], True
    k = (knob or "").strip()
    if k:
        return k, True
    return default, False


def load_spec(path):
    """Load JSON spec at `path`; return `(data, error_msg_or_None)`."""
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh), None
    except (OSError, ValueError) as e:
        return None, i18n.M("gate.spec_unreadable", path=path, error=e)


def _resolve_gate_spec_name(argv, knob_name):
    """Resolve `(spec_name, explicit)` with `--spec` > `knobs.raw` > `REGISTRY` default."""
    spec_arg, arg_explicit = resolve_spec(argv, "", knobs.REGISTRY[knob_name][1])
    if arg_explicit:
        return spec_arg, True
    raw_val = knobs.raw(knob_name)
    if raw_val is not None:
        s = raw_val.strip()
        return (s, True) if s else ("", False)
    return knobs.REGISTRY[knob_name][1], False


def load_gate_spec(argv, knob_name, *, off_msg, missing_msg, broken_msg=None):
    """Shared spec-gate bootstrap: resolve `--spec` > knob > registry default.

    Returns `(spec, spec_name, None)` when ready, or `(None, spec_name, rc)` if handled.
    """
    spec_name, explicit = _resolve_gate_spec_name(argv, knob_name)
    if not spec_name:
        if explicit:
            return None, "", fatal(missing_msg(""))
        return None, "", off(off_msg(""))
    path = repo_path(spec_name)
    if os.path.isdir(path):
        return None, spec_name, fatal(missing_msg(spec_name))
    if not os.path.isfile(path):
        rc = fatal(missing_msg(spec_name)) if explicit else off(off_msg(spec_name))
        return None, spec_name, rc
    spec, err = load_spec(path)
    if err:
        msg = broken_msg(spec_name, err) if broken_msg else err
        return None, spec_name, fatal(msg)
    return spec, spec_name, None


def run_spec_gate(argv, knob_name, *, off_msg, missing_msg, broken_msg=None,
                  title, judge, ok_msg):
    """Run a standard spec gate end-to-end (load -> judge -> emit skips -> finish)."""
    spec, _name, rc = load_gate_spec(
        argv, knob_name, off_msg=off_msg, missing_msg=missing_msg, broken_msg=broken_msg,
    )
    if rc is not None:
        return rc
    problems, skips = judge(spec)
    all_problems = list(problems) + list(skips)
    return finish(title, all_problems, ok_msg(spec))


def finish(name, problems, ok):
    """Report problems to stderr (`rc=1`) or `ok` to stdout (`rc=0`)."""
    if problems:
        print(i18n.M("gate.problems_header", name=name, count=len(problems)), file=sys.stderr)
        for p in problems:
            print("  · " + p, file=sys.stderr)
            forged = getattr(p, "forged", ())
            if forged:
                print("  " + i18n.M("gate.forged_row_neutralised", count=len(forged)),
                      file=sys.stderr)
        return 1
    print(ok)
    return 0


def _bad_exec_shell_or_prose(s, first, parts):
    if "\n" in s or "\r" in s or "$(" in s or "`" in s or "||" in s:
        return True
    if first.startswith("/") and not (os.path.exists(first) or shutil.which(first)):
        return True
    if first in ("echo", "make") and len(parts) > 1:
        rest = parts[1].strip()
        if re.fullmatch(r"[A-Za-z]+(?:\s+[A-Za-z]+)+", rest):
            return True
    stripped = re.sub(r"'[^']*'", "", re.sub(r'"[^"]*"', "", s))
    if _PROSE_CHARS.search(stripped) or ";" in stripped:
        return True
    return bool(re.search(r"(?<![&>])&(?![&>])", stripped))


def starts_with_interpreter(value, field_name="cmd"):
    """Verify `value` starts with a command token and has no trailing prose or shell escapes."""
    s = str(value or "").strip()
    if field_name == "Settling":
        s = _OUTCOME_SEP.split(s, 1)[0].strip()
    if s.startswith("`") and s.endswith("`") and len(s) >= 2:
        s = s[1:-1].strip()
    if not s:
        return False
    parts = s.split(None, 1)
    first = parts[0].strip("`\"'")
    if not (first in EXEC_PREFIXES or first.startswith("/")):
        return False
    if first == "test" and (len(parts) < 2 or not parts[1].lstrip().startswith(("-", "!", "("))):
        return False
    if _bad_exec_shell_or_prose(s, first, parts):
        return False
    try:
        return bool(shlex.split(s))
    except ValueError:
        return False


def prose_in_exec_problems(where, field_name, value):
    """Report when a non-empty execution field contains prose instead of a runnable command."""
    if not str(value or "").strip() or starts_with_interpreter(value, field_name):
        return []
    return [i18n.M("criteria.exec_position_is_prose",
                   where=where, field=field_name, value=str(value)[:60])]


EXEC_POSITIONS = {
    "world.json": ("stamps", "cmd"),
    "pins.json": ("pins", ("version_read", "stamp_read")),
}


def exec_position_problems(spec, name):
    """Validate declared command fields in `world.json` or `pins.json`."""
    entry_key, fields = EXEC_POSITIONS.get(name, (None, ()))
    if entry_key is None or not isinstance(spec, dict):
        return []
    fields = (fields,) if isinstance(fields, str) else fields
    raw = spec.get(entry_key) or {}
    pairs = ([(str(i), e) for i, e in enumerate(raw)] if isinstance(raw, list)
             else list(raw.items()) if isinstance(raw, dict) else [])
    out = []
    for key, entry in pairs:
        if not isinstance(entry, dict):
            continue
        for field_name in fields:
            out += prose_in_exec_problems(
                "%s/%s" % (name, entry.get("name") or key), field_name, entry.get(field_name))
    return out


def timeout_with_status():
    """Return `(seconds, raw_bad_value_or_None)` from `REFLECT_REPLAY_TIMEOUT`."""
    val = knobs.raw("REFLECT_REPLAY_TIMEOUT")
    if val is None or not val.strip():
        return 10.0, None
    try:
        return float(val), None
    except ValueError:
        return 10.0, val


def default_timeout():
    """Return float replay timeout in seconds (defaults to 10.0)."""
    return timeout_with_status()[0]


def quote(s, n=60):
    """Truncate and repr-quote command output for diagnostics."""
    return repr(s if len(s) <= n else s[:n] + "...")


def _quote_for_shell(path):
    if not _NEEDS_QUOTING.search(path):
        return path
    if "'" not in path:
        return "'%s'" % path
    return '"%s"' % path.replace('"', '\\"')


def _python_of(cmd):
    interp = _quote_for_shell(sys.executable)
    out = _PY_CMD.sub(lambda _m: interp, cmd)
    return _TOOL_REL.sub(lambda m: _quote_for_shell(os.path.join(tool_repo(), m.group(1))), out)


def _shell_argv(cmd):
    bash = shutil.which("bash")
    if bash:
        return [bash, "-o", "pipefail", "-c", _python_of(cmd)], "bash"
    if os.name != "nt" and os.path.exists("/bin/sh"):
        return ["/bin/sh", "-c", _python_of(cmd)], "sh"
    return None, "no-shell"


def _windows_argv(cmd):
    return [m.group(1) if m.group(1) is not None else m.group(2)
            for m in _QUOTED.finditer(cmd)]


def run_cmd(cmd, timeout=None):
    """Execute `cmd` verbatim in `GATE_REPO`, returning `(returncode_or_None, output)`."""
    t = default_timeout() if timeout is None else timeout
    argv, shell_kind = _shell_argv(cmd)
    if argv is None:
        argv = _windows_argv(_python_of(cmd))
    env = dict(os.environ)
    try:
        env["EINFACHT_REPLAY_DEPTH"] = str(int(env.get("EINFACHT_REPLAY_DEPTH", "0") or 0) + 1)
    except ValueError:
        env["EINFACHT_REPLAY_DEPTH"] = "1"
    try:
        p = subprocess.run(argv, cwd=GATE_REPO, capture_output=True, text=True,
                           errors="replace", timeout=t, env=env, encoding="utf-8")
    except subprocess.TimeoutExpired:
        return None, ""
    except OSError as e:
        return 127, i18n.emit("fatal", "%s [shell=%s argv=%r]" % (e, shell_kind, argv[:2]))
    if p.returncode != 0 and p.stderr:
        return p.returncode, (p.stdout or "") + p.stderr
    if p.stdout is None:
        return p.returncode, i18n.emit("fatal", "stdout=None rc=%s" % p.returncode)
    return p.returncode, p.stdout


def _proc_argv(pid):
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as fh:
            raw = fh.read()
        return [a.decode("utf-8", "replace") for a in raw.split(b"\x00") if a]
    except OSError:
        return []


def _proc_ppid(pid):
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8", errors="replace") as fh:
            raw = fh.read()
        tail = raw[raw.rfind(")") + 2:].split()
        return int(tail[1]) if len(tail) > 1 else 0
    except (OSError, ValueError):
        return 0


def _is_suite_argv(argv):
    if len(argv) < 2:
        return False
    script = argv[1]
    if not script or script.startswith("-") or not os.path.isfile(script):
        return False
    real_s = os.path.realpath(script)
    roots = (os.path.realpath(zdir()) + os.sep, os.path.realpath(os.path.join(tool_repo(), "reflect-local")) + os.sep)
    return real_s.startswith(roots)


def has_suite_ancestor(only_pid=None):
    """Return True iff an ancestor process (>0 hops above current PID) runs a real suite script."""
    pid = os.getppid()
    for _ in range(32):
        if pid <= 1:
            return False
        if _is_suite_argv(_proc_argv(pid)) and (only_pid is None or pid == only_pid):
            return True
        nxt = _proc_ppid(pid)
        if nxt <= 0 or nxt == pid:
            return False
        pid = nxt
    return False


def _get_inproc_depth():
    return getattr(_DEPTH_TLS, "depth", 0)


def trusted_replay_depth():
    """Return replay depth from thread-local in-process execution or a verified live suite ancestor."""
    try:
        depth = int(os.environ.get("EINFACHT_REPLAY_DEPTH", "0") or 0)
    except ValueError:
        depth = 0
    env_depth = depth if (depth > 0 and has_suite_ancestor()) else 0
    return max(_get_inproc_depth(), env_depth)


_INPROC_CACHE: dict[str, tuple[int | None, str]] | None = None
_DEPTH_TLS = threading.local()
_INPROC_LOCK = threading.RLock()
_CACHE_MUTEX = threading.Lock()
_INFLIGHT: dict[str, threading.Event] = {}


def with_run_cache(fn):
    """Run `fn()` with a pure in-process single-invocation command cache (never trusts external env)."""
    global _INPROC_CACHE
    if _INPROC_CACHE is not None:
        return fn()
    _INPROC_CACHE = {}
    try:
        return fn()
    finally:
        _INPROC_CACHE = None


def _is_ro_suite_call(rel, extra):
    import trust  # noqa: PLC0415
    full = os.path.join(GATE_REPO, rel)
    if not trust.is_sealed_target(full, root=GATE_REPO, zdir=zdir()):
        return False
    base = os.path.basename(rel)
    if extra == ["--selftest"]:
        return base not in ("harness.py", "examples.py", "facts.py")
    if not extra and base in ("check_questions.py", "check_retractions.py", "check_facts_replay.py", "check_facts.py"):
        return True
    if base == "facts.py" and extra == ["--check"]:
        return True
    return base == "registry.py" and extra in (["--run", "commit"], ["--run", "commit", "--all"], ["--verify-seal"], ["--gates"])


def _inproc_suite_argv(cmd):
    if os.path.abspath(GATE_REPO) != os.path.abspath(tool_repo()):
        return None
    if any(ch in cmd for ch in ("&", "|", ";", ">", "<", "$", "`", "\n")):
        return None
    parts = cmd.strip().split()
    if len(parts) < 2:
        return None
    exe = os.path.basename(parts[0]).lower()
    if not (exe.startswith("python") or parts[0] == sys.executable):
        return None
    rel = parts[1].replace("\\", "/")
    if not (rel.startswith("zreflect/") and rel.endswith(".py")):
        return None
    if not _is_ro_suite_call(rel, parts[2:]):
        return None
    full = os.path.join(GATE_REPO, rel)
    return (full, parts[2:]) if os.path.isfile(full) else None


def _run_inproc_script(script_path, extra_args, bump_depth=True):
    import contextlib  # noqa: PLC0415
    import io  # noqa: PLC0415
    import runpy  # noqa: PLC0415
    prev_depth = _get_inproc_depth()
    if bump_depth:
        _DEPTH_TLS.depth = prev_depth + 1
    try:
        with _INPROC_LOCK:
            buf = io.StringIO()
            old_argv = sys.argv
            sys.argv = [script_path, *extra_args]
            rc = 0
            with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
                try:
                    runpy.run_path(script_path, run_name="__main__")
                except SystemExit as exc:
                    rc = exc.code if isinstance(exc.code, int) else (1 if exc.code else 0)
                finally:
                    sys.argv = old_argv
            return rc, buf.getvalue()
    finally:
        _DEPTH_TLS.depth = prev_depth


def _cache_key(cmd):
    depth_sensitive = any(s in cmd for s in ("check_questions", "check_retractions", "registry.py"))
    d = trusted_replay_depth() if depth_sensitive else 0
    return "%s|%s|%s" % (os.path.abspath(GATE_REPO), d, cmd)


def _acquire_cache_slot(key):
    with _CACHE_MUTEX:
        if _INPROC_CACHE is not None and key in _INPROC_CACHE:
            return _INPROC_CACHE[key], None
        ev = _INFLIGHT.get(key)
        if ev is None:
            ev = threading.Event()
            _INFLIGHT[key] = ev
            return None, ev
    ev.wait()
    with _CACHE_MUTEX:
        if _INPROC_CACHE is not None and key in _INPROC_CACHE:
            return _INPROC_CACHE[key], None
    return _acquire_cache_slot(key)


def run_cmd_cached(cmd, timeout=None):
    """Run `cmd`, sharing results only within the current process's `with_run_cache` scope."""
    if _INPROC_CACHE is None:
        return run_cmd(cmd, timeout=timeout)
    key = _cache_key(cmd)
    hit, ev = _acquire_cache_slot(key)
    if hit is not None:
        return hit
    try:
        target = _inproc_suite_argv(cmd) if timeout is None else None
        res = _run_inproc_script(target[0], target[1]) if target else run_cmd(cmd, timeout=timeout)
        with _CACHE_MUTEX:
            if _INPROC_CACHE is not None:
                _INPROC_CACHE[key] = res
        return res
    finally:
        with _CACHE_MUTEX:
            _INFLIGHT.pop(key, None)
        ev.set()


def meta(name, desc, knobs=(), name_dependent=False, runs_at="commit", off_reason=None):
    """Gate declaration dict parsed by `registry.gates()`."""
    return {
        "name": name, "desc": desc, "knobs": tuple(knobs),
        "name_dependent": bool(name_dependent),
        "runs_at": str(runs_at),
        "off_reason": (None if off_reason is None else str(off_reason)),
    }


def module_meta(name, desc, selftest=True):
    """Module declaration dict parsed by `registry.modules()`."""
    return {"name": name, "desc": desc, "selftest": bool(selftest)}


def raises(fn):
    """Return True if `fn()` raises `SystemExit`."""
    try:
        fn()
    except SystemExit:
        return True
    return False


def selftest(name, cases):
    """Execute `(label, callable)` cases (with `SEAL.json` check) and print summary."""
    if not cases:
        fatal_exit(i18n.M("gate.selftest_empty_cases", name=name))
    import trust  # noqa: PLC0415
    if trust.seal_exists() or os.path.isfile(os.path.join(zdir(), "trust.py")):
        probs = trust.verify_problems()
        if probs:
            fatal_exit(probs[0])
    bad = 0
    for label, fn in cases:
        try:
            passed, failure = bool(fn()), None
        except SystemExit as e:
            passed, failure = False, i18n.M("gate.case_unexpected_systemexit", label=label, error=e)
        except Exception as e:                           # noqa: BLE001
            passed, failure = False, i18n.M("gate.case_raised", label=label, error=e)
        if failure is not None:
            print(i18n.emit("fail", failure))
            bad += 1
        else:
            print(i18n.emit("pass" if passed else "fail", label))
            bad += 0 if passed else 1
    print(i18n.emit_summary(len(cases) - bad, bad))
    return 1 if bad else 0


def _force_utf8_streams():
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                continue


def activate_or_fatal(lang=None):
    """Configure UTF-8 stdio and activate language pack (rc=0 ok, rc=2 FATAL)."""
    _force_utf8_streams()
    try:
        i18n.activate(lang)
    except Exception as e:                               # noqa: BLE001
        print(i18n.emit("fatal", i18n.M("gate.pack_assembly_failed", error=e)), file=sys.stderr)
        return 2
    import knobs  # noqa: PLC0415
    cfg_probs = knobs.config_problems()
    if cfg_probs:
        for p in cfg_probs:
            print(i18n.emit("fatal", p), file=sys.stderr)
        return 2
    return 0


def main_selftest_or(args, name, cases, run):
    """Standard gate entrypoint: activate language pack, dispatch `--selftest` or `run(args)`."""
    rc = activate_or_fatal()
    if rc:
        return rc
    if "--selftest" in args:
        return selftest(name, cases() if callable(cases) else cases)
    return run([a for a in args if a != "--selftest"])


def default_runner(f, repo_root=None):
    """Execute gate file `f` in `repo_root or GATE_REPO`; return `(rc, merged_output)`."""
    import trust  # noqa: PLC0415
    root = repo_root or GATE_REPO
    if (_INPROC_CACHE is not None
            and os.path.abspath(root) == os.path.abspath(tool_repo())
            and os.path.realpath(f).startswith(os.path.realpath(zdir()) + os.sep)
            and trust.is_sealed_target(f, root=root, zdir=zdir())):
        return _run_inproc_script(f, [], bump_depth=False)
    p = subprocess.run([sys.executable, f], capture_output=True, text=True,
                       cwd=root, encoding="utf-8", errors="replace")
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def run_phase(phase, gates, runner=None, repo_root=None):
    """Run phase gates and aggregate `{ran, off, skipped, failed, fatal, error, *_list, fail_out}`."""
    run = runner or (lambda f: default_runner(f, repo_root))
    res: dict[str, Any] = {
        "ran": 0, "off": 0, "skipped": 0, "failed": 0, "fatal": 0, "error": 0,
        "off_list": [], "skip_list": [], "fail_list": [], "fatal_list": [],
        "error_list": [], "fail_out": {},
    }
    for item in gates:
        f = item["file"] if isinstance(item, dict) else item
        if isinstance(item, dict) and item.get("runs_at") not in (None, phase):
            continue
        rc, out = run(f)
        if rc == 2:
            res["fatal"] += 1
            res["fatal_list"].append(f)
            res["fail_out"][f] = out or ""
        elif rc < 0 or rc > 2:
            res["error"] += 1
            res["error_list"].append(f)
            res["fail_out"][f] = out or ""
        elif rc != 0:
            res["failed"] += 1
            res["fail_list"].append(f)
            res["fail_out"][f] = out or ""
        else:
            scanned_all = i18n.scan(out or "")
            if any(k == "skip" for _i, k, _ln in scanned_all):
                res["skipped"] += 1
                res["skip_list"].append(f)
                res["fail_out"][f] = out or ""
                continue
            first_ln = next((ln for ln in (out or "").splitlines() if ln.strip()), "")
            scanned = i18n.scan(first_ln)
            kind = scanned[0][1] if scanned else None
            if kind == "off":
                res["off"] += 1
                res["off_list"].append(f)
            else:
                res["ran"] += 1
    return res


def _restore_cache_env(old_c, old_t):
    if old_c is None:
        os.environ.pop("EINFACHT_RUN_CACHE", None)
    else:
        os.environ["EINFACHT_RUN_CACHE"] = old_c
    if old_t is None:
        os.environ.pop("EINFACHT_RUN_CACHE_KEY", None)
    else:
        os.environ["EINFACHT_RUN_CACHE_KEY"] = old_t
    os.environ.pop("EINFACHT_RC_FD", None)


def _case_forged_cache_and_depth():
    import hashlib  # noqa: PLC0415
    import json  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    import time as _time  # noqa: PLC0415
    with tempfile.TemporaryDirectory() as tmp:
        raw_key = "%s|0|echo real_ok" % os.path.abspath(GATE_REPO)
        k = hashlib.sha256(raw_key.encode("utf-8")).hexdigest()
        with open(os.path.join(tmp, k + ".json"), "w", encoding="utf-8") as fh:
            json.dump({"rc": 0, "out": "FORGED"}, fh)
        old_c, old_t = os.environ.get("EINFACHT_RUN_CACHE"), os.environ.get("EINFACHT_RUN_CACHE_KEY")
        os.environ["EINFACHT_RUN_CACHE"], os.environ["EINFACHT_RUN_CACHE_KEY"] = tmp, "0" * 64
        try:
            if with_run_cache(lambda: run_cmd_cached("echo real_ok")) != (0, "real_ok\n"):
                return False
            if run_cmd_cached("echo real_ok") != (0, "real_ok\n"):
                return False
        finally:
            _restore_cache_env(old_c, old_t)
        if _is_suite_argv(["zreflect/fake", "-c", "pass"]) or _is_suite_argv(["python3", "-c", "# zreflect/"]):
            return False
        out_f = os.path.join(tmp, "depth.txt")
        code = (
            f"import os, sys, time; sys.path.insert(0, {zdir()!r}); pid = os.fork()\n"
            f"if pid == 0:\n    time.sleep(0.05); import gate\n"
            f"    open({out_f!r}, 'w').write(str(gate.trusted_replay_depth())); os._exit(0)\nos._exit(0)\n"
        )
        subprocess.run([sys.executable, "-c", code], env={**os.environ, "EINFACHT_REPLAY_DEPTH": "2"}, check=True)
        for _ in range(30):
            if os.path.isfile(out_f):
                return open(out_f, encoding="ascii").read().strip() == "0"
            _time.sleep(0.02)
        return False


def _case_inproc_selftest_and_hmac():
    import tempfile  # noqa: PLC0415
    rc_ok, out_ok = _run_inproc_script(os.path.join(zdir(), "check_locks.py"), ["--selftest"], bump_depth=False)
    if rc_ok != 0 or "PASS |" not in out_ok:
        return False
    with tempfile.TemporaryDirectory() as tmp:
        bad_py = os.path.join(tmp, "bad_selftest.py")
        with open(bad_py, "w", encoding="utf-8") as fh:
            fh.write("import sys\nprint('FAIL | red')\nsys.exit(1)\n")
        rc_bad, out_bad = _run_inproc_script(bad_py, ["--selftest"], bump_depth=False)
        if rc_bad != 1 or "FAIL | red" not in out_bad:
            return False

    def _inner():
        a = run_cmd_cached("echo inproc_once")
        b = run_cmd_cached("echo inproc_once")
        return a == (0, "inproc_once\n") and a == b

    return with_run_cache(_inner)


def _cases():
    return [
        ("★ gate.empty_input_fatals", lambda: raises(lambda: require_nonempty("x", []))),
        ("★ gate.phase_tracks_four_tiers",
         lambda: (lambda ph: ph["fatal_list"] == ["d.py"] and ph["skip_list"] == ["e.py"]
                  and ph["ran"] == 1
                  and "FATAL: cfg" in ph["fail_out"].get("d.py", ""))(
             run_phase("commit", ["a.py", "b.py", "c.py", "d.py", "e.py"],
                       runner=lambda f: {"a.py": (0, ""), "b.py": (0, "OFF: x"),
                                         "c.py": (1, "bad"), "d.py": (2, "FATAL: cfg"),
                                         "e.py": (0, "SKIP: opt")}[f]))),
        ("★ gate.phase_catches_stderr_skip_after_ok",
         lambda: (lambda ph: ph["skipped"] == 1 and ph["ran"] == 0 and ph["skip_list"] == ["s.py"])(
             run_phase("commit", ["s.py"],
                       runner=lambda _f: (0, "ok line\nSKIP: hidden on stderr\n")))),
        ("★ gate.prose_in_exec_rejected",
         lambda: [p.code for p in prose_in_exec_problems("w", "cmd", "not a command")]
         == ["criteria.exec_position_is_prose"]),
        ("gate.valid_exec_accepted",
         lambda: exec_position_problems({"pins": [{"name": "a", "version_read": "python3 -V"}]},
                                        "pins.json") == []),
        ("gate.runner_echo_and_pipefail",
         lambda: run_cmd("echo hello") == (0, "hello\n") and run_cmd("false | cat")[0] != 0),
        ("★ gate.runner_timeout_is_none", lambda: run_cmd("sleep 2", timeout=0.2)[0] is None),
        ("gate.quote_formats", lambda: quote("ok") == "'ok'" and quote("a" * 80).endswith("...'")),
        ("gate.windows_argv_splits",
         lambda: _windows_argv('"C:\\Py\\python.exe" a\\b') == ["C:\\Py\\python.exe", "a\\b"]),
        ("★ gate.prose_test_if_rejected",
         lambda: not starts_with_interpreter("test if this works")
         and not starts_with_interpreter("python3 a.py || true")
         and not starts_with_interpreter("echo this is prose")
         and not starts_with_interpreter("/fake/path prose")
         and not starts_with_interpreter("false\ntrue")),
        ("gate.spec_equals_syntax",
         lambda: resolve_spec(["--spec=foo.json"], "", "d.json") == ("foo.json", True)),
        ("★ gate.forged_run_cache_and_depth_ignored", _case_forged_cache_and_depth),
        ("★ gate.inproc_selftest_and_hmac_cache", _case_inproc_selftest_and_hmac),
    ]


MODULE = module_meta("gate platform", "rc contract, spec helpers, command runner, phase executor",
                     selftest=True)

if __name__ == "__main__":
    if "--selftest" in sys.argv[1:]:
        rc = activate_or_fatal()
        sys.exit(rc or selftest(i18n.M("gate.platform_root", root=repo()), _cases()))
    rc = activate_or_fatal()
    if rc:
        sys.exit(rc)
    print(i18n.M("gate.platform_root", root=GATE_REPO))
    print(i18n.M("gate.platform_usage"))
    sys.exit(0)
