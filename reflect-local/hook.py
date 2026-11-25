#!/usr/bin/env python3
"""Hook entry point and chained git-hook installer.

Never touches `git config core.hooksPath` (which overrides `.git/hooks/` and
silently disables husky/lefthook/pre-commit). Exposes a single command entry
that external hook managers can call or install as a reversible chain wrapper:

    python3 <repo>/reflect-local/hook.py commit "$(git rev-parse --show-toplevel)"
    python3 <repo>/reflect-local/hook.py --chain [target repo]
    python3 <repo>/reflect-local/hook.py --uninstall [target repo]
    python3 <repo>/reflect-local/hook.py --instructions
"""
from __future__ import annotations

import os
import stat
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def _find_tool_repo(start):
    cur = start
    while cur and os.path.dirname(cur) != cur:
        if os.path.isdir(os.path.join(cur, "zreflect")):
            return cur
        if os.path.exists(os.path.join(cur, ".git")):
            break
        cur = os.path.dirname(cur)
    return os.path.dirname(start)


TOOL_REPO = _find_tool_repo(HERE)
sys.path.insert(0, os.path.join(TOOL_REPO, "zreflect"))

import knobs  # noqa: E402
from gate import activate_or_fatal, meta  # noqa: E402
from i18n import M  # noqa: E402

PHASES = ("commit",)
PHASE_OF = {"pre-commit": "commit"}
LEGACY_HOOKS = ("pre-push",)
GATE_SCRIPT = os.path.abspath(__file__)


def _sh(cmd, stdin=None, cwd=None, env=None):
    """Run one command, return `(rc, merged output)`."""
    try:
        p = subprocess.run(
            cmd, capture_output=True, text=True, input=stdin, cwd=cwd, env=env,
            encoding="utf-8", errors="replace",
        )
    except (OSError, subprocess.SubprocessError) as e:
        return 127, "hook: %r" % (e,)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def _git(repo, *args):
    return _sh(["git", "-C", repo, *args])


def _usage():
    print(str(M("hookgate.usage")), file=sys.stderr)
    return 0


def _check_staged_readmes(repo, staged):
    import tempfile  # noqa: PLC0415
    fd, path = tempfile.mkstemp()
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write("\n".join(staged) + "\n")
        rc, out = _sh([
            sys.executable, os.path.join(repo, "zreflect", "check_readme_sync.py"),
            "--changed", path,
        ], cwd=repo, env=dict(os.environ, GATE_REPO=repo))
        if rc == 0:
            return False
        print(str(M("hookgate.commit_readmes_not_together")), file=sys.stderr)
        for ln in (out or "").splitlines()[:5]:
            print(ln, file=sys.stderr)
        return True
    finally:
        os.unlink(path)


def _commit_readmes_together(repo):
    """Verify staged commits updating any README update all declared READMEs together."""
    off = {os.path.basename(x.strip()) for x in (knobs.get("REFLECT_OFF_GATES", root=repo) or "").split(",") if x.strip()}
    if "check_readme_sync.py" in off:
        return False
    readmes = set(knobs.readme_names(repo))
    if not readmes:
        return False
    rc, diff_out = _git(repo, "diff", "--cached", "--name-only")
    staged = [ln.strip() for ln in (diff_out or "").splitlines() if ln.strip()]
    if rc != 0 or not (readmes & set(staged)):
        return False
    return _check_staged_readmes(repo, staged)


def _has_unstaged_facts(repo):
    """Does `FACTS.json` have unstaged, untracked, or deleted changes in `repo`?"""
    facts_rel = knobs.get("REFLECT_FACTS", root=repo)
    rc, status_out = _git(repo, "status", "--porcelain", "--", facts_rel)
    if rc != 0:
        return os.path.isfile(os.path.join(repo, facts_rel)), facts_rel
    for ln in (status_out or "").splitlines():
        if len(ln) >= 2 and (ln[1] != " " or ln[:2] == "??"):
            return True, facts_rel
    return False, facts_rel


def _stage_rendered_docs(repo, doc):
    """`git add` rendered machine-block documents; returns True on error."""
    for name in (doc, "PRINCIPLES.md"):
        if os.path.isfile(os.path.join(repo, name)):
            rc, out = _git(repo, "add", "--", name)
            if rc != 0:
                if out:
                    print(out, file=sys.stderr)
                return True
    return False


def _prepare(repo, doc):
    """Render and stage machine-block docs before running commit gates."""
    facts = os.path.join(repo, "zreflect", "facts.py")
    unstaged, facts_rel = _has_unstaged_facts(repo)
    if unstaged:
        print(str(M("hookgate.unstaged_facts", path=facts_rel)), file=sys.stderr)
        return True
    if os.path.isfile(os.path.join(repo, doc)):
        rc, out = _sh([sys.executable, facts, "--render-doc"], cwd=repo)
        if rc != 0:
            if out:
                print(out, file=sys.stderr)
            return True
        if _stage_rendered_docs(repo, doc):
            return True
    return False


def _run_repo_gates(target_repo):
    for ph_name in ("commit", "start-of-work"):
        p = subprocess.run(
            [sys.executable, "-u", os.path.join(target_repo, "zreflect", "registry.py"),
             "--run", ph_name], cwd=target_repo, stdout=sys.stderr, stderr=sys.stderr)
        if p.returncode != 0:
            return 1
    return 0


def run(phase, repo):
    """Run the commit hook phase (all commit + start-of-work checks). Returns 0, 1, or 2."""
    if phase not in PHASES:
        print(str(M("hookgate.unknown_phase", phase=phase)), file=sys.stderr)
        return 2
    if not os.path.isdir(repo):
        print(str(M("hookgate.repo_missing", repo=repo)), file=sys.stderr)
        return 2
    os.environ["GATE_REPO"] = repo
    if _prepare(repo, knobs.get("REFLECT_DOC", root=repo)):
        return 1
    if _commit_readmes_together(repo):
        return 1
    return _run_repo_gates(repo)


def _chmod_x(path):
    mode = os.stat(path).st_mode
    os.chmod(path, mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _hooks_dir(repo):
    """Resolve git hooks directory (supports normal repos and worktrees)."""
    rc, out = _git(repo, "rev-parse", "--git-path", "hooks")
    if rc == 0 and out.strip():
        p = out.strip()
        return p if os.path.isabs(p) else os.path.join(repo, p)
    return os.path.join(repo, ".git", "hooks")


def _wrapper_body(name, phase):
    """Fixed chained wrapper preserving stdin across `$PREV`."""
    py = sys.executable or "python3"
    return (
        "#!/bin/sh\n"
        "# Einfacht chain wrapper (generated by reflect-local/hook.py --chain)\n"
        'HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\n'
        'PREV="$HERE/%s.einfacht-prev"\n'
        'if [ -x "$PREV" ]; then\n'
        "  STDIN=$(cat)\n"
        '  { [ -n "$STDIN" ] && printf \'%%s\\n\' "$STDIN"; } | "$PREV" "$@" || exit $?\n'
        '  { [ -n "$STDIN" ] && printf \'%%s\\n\' "$STDIN"; } | "%s" "%s" %s "$(git rev-parse --show-toplevel)"\n'
        "  exit $?\n"
        "fi\n"
        'exec "%s" "%s" %s "$(git rev-parse --show-toplevel)"\n'
        % (name, py, GATE_SCRIPT, phase, py, GATE_SCRIPT, phase)
    )


def _is_einfacht_hook(body):
    return "hook.py" in body or "gate.py" in body or "einfacht-gate.sh" in body


def _read_hook(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return ""


def _remove_einfacht_hook(hooks, name):
    lines = []
    target = os.path.join(hooks, name)
    prev = target + ".einfacht-prev"
    removed = os.path.isfile(target) and _is_einfacht_hook(_read_hook(target))
    if removed:
        os.unlink(target)
        lines.append(str(M("install.chain_removed", name=name)))
    if os.path.isfile(prev) and (removed or not os.path.exists(target)):
        os.replace(prev, target)
        lines.append(str(M("install.restored_original", name=name)))
    return lines


def install_chain(repo):
    """Install chained `pre-commit` wrapper into `.git/hooks/` and clean stale Einfacht `pre-push` wrappers."""
    hooks = _hooks_dir(repo)
    if not os.path.isdir(hooks):
        return 2, [str(M("install.no_hooks_dir", path=hooks))]
    rc, current = _git(repo, "config", "core.hooksPath")
    if rc == 0 and (current or "").strip():
        return 2, [str(M("install.chain_blocked_by_hookspath", value=current.strip())),
                   str(M("install.chain_blocked_fix"))]
    lines = []
    for name, phase in PHASE_OF.items():
        target = os.path.join(hooks, name)
        if os.path.isfile(target) and not _is_einfacht_hook(_read_hook(target)):
            os.replace(target, target + ".einfacht-prev")
            lines.append(str(M("install.kept_existing", name=name)))
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(_wrapper_body(name, phase))
        _chmod_x(target)
        lines.append(str(M("install.installed_chain", name=name)))
    for legacy_name in LEGACY_HOOKS:
        lines.extend(_remove_einfacht_hook(hooks, legacy_name))
    lines.append(str(M("install.chain_done")))
    return 0, lines


def uninstall(repo):
    """Remove Einfacht chain wrappers and restore `.einfacht-prev` hooks."""
    lines = []
    rc, _o = _git(repo, "config", "--unset", "core.hooksPath")
    lines.append(str(M("install.legacy_removed")) if rc == 0
                 else str(M("install.legacy_was_not_set")))
    hooks = _hooks_dir(repo)
    for name in (*PHASE_OF, *LEGACY_HOOKS):
        lines.extend(_remove_einfacht_hook(hooks, name))
    return 0, lines


def usage_lines():
    return [str(M("install.usage")), str(M("install.usage_no_target")),
            str(M("install.usage_chain")), str(M("install.usage_uninstall"))]


def instructions():
    """Return human-readable wiring instructions (writes no files)."""
    return [str(M("install.intro")), str(M("install.example_commit", gate=GATE_SCRIPT)),
            str(M("install.chain_hint")), str(M("install.uninstall_hint")),
            str(M("install.why_not_hookspath"))]


def _validate(argv, say):
    phase = argv[0]
    if phase not in PHASES:
        say("hookgate.unknown_phase", phase=phase)
        return 2
    if len(argv) < 2:
        say("hookgate.missing_root")
        return 2
    repo = argv[1]
    if not os.path.isdir(repo):
        say("hookgate.repo_missing", repo=repo)
        return 2
    if not os.path.isdir(os.path.join(repo, "zreflect")):
        say("hookgate.not_a_suite_repo", repo=repo)
        return 2
    return None


def _run_installer(argv, say):
    mode = argv[0]
    target = argv[1] if len(argv) > 1 else ""
    repo = os.path.abspath(target) if target else TOOL_REPO
    if target and not os.path.exists(os.path.join(repo, ".git")):
        say("install.not_a_repo", path=repo)
        return 2
    if mode in ("--help", "-h"):
        for ln in [str(M("hookgate.usage")), *usage_lines()]:
            print(ln)
        return 0
    if mode == "--instructions":
        for ln in instructions():
            print(ln)
        return 0
    rc, lines = install_chain(repo) if mode == "--chain" else uninstall(repo)
    for ln in lines:
        print(ln, file=(sys.stderr if rc else sys.stdout))
    return rc


def _run_cli(argv, quiet=False):
    def _say(code, **kw):
        """PINNED: CLI dispatcher forwards static hookgate.* or install.* code."""
        if not quiet:
            print(str(M(code, **kw)), file=sys.stderr)

    if not argv:
        if not quiet:
            _usage()
        return 0
    if argv[0] in ("--chain", "--uninstall", "--instructions", "--help", "-h"):
        if quiet:
            import contextlib  # noqa: PLC0415
            import io  # noqa: PLC0415
            with contextlib.redirect_stdout(io.StringIO()), \
                    contextlib.redirect_stderr(io.StringIO()):
                return _run_installer(argv, _say)
        return _run_installer(argv, _say)
    rc = _validate(argv, _say)
    if rc is not None:
        return rc
    return run(argv[0], argv[1])


def _t_unstaged(d):
    _git(d, "config", "user.email", "a@b")
    _git(d, "config", "user.name", "a")
    fp = os.path.join(d, "FACTS.json")
    open(fp, "w", encoding="utf-8").write("{}\n")
    _git(d, "add", "FACTS.json")
    _git(d, "commit", "-q", "-m", "init")
    clean, _r1 = _has_unstaged_facts(d)
    open(fp, "w", encoding="utf-8").write('{"facts": {}}\n')
    dirty, _r2 = _has_unstaged_facts(d)
    return (not clean) and dirty


def _t_instructions(d):
    before = set(os.listdir(_hooks_dir(d)))
    rc = _run_cli(["--instructions"], quiet=True)
    return rc == 0 and before == set(os.listdir(_hooks_dir(d)))


def _t_chain(d):
    pre = os.path.join(_hooks_dir(d), "pre-commit")
    push_h = os.path.join(_hooks_dir(d), "pre-push")
    open(pre, "w", encoding="utf-8").write("#!/bin/sh\necho mine\n")
    open(push_h, "w", encoding="utf-8").write("#!/bin/sh\nexec python3 reflect-local/hook.py push .\n")
    _chmod_x(pre)
    _chmod_x(push_h)
    rc, _l = install_chain(d)
    return (rc == 0 and os.path.isfile(pre + ".einfacht-prev")
            and "hook.py" in _read_hook(pre) and not os.path.exists(push_h))


def _t_uninstall(d):
    pre = os.path.join(_hooks_dir(d), "pre-commit")
    open(pre, "w", encoding="utf-8").write("#!/bin/sh\necho mine\n")
    _chmod_x(pre)
    install_chain(d)
    uninstall(d)
    body = _read_hook(pre)
    return "hook.py" not in body and "echo mine" in body


def _t_blocked(d):
    _git(d, "config", "core.hooksPath", "reflect-local")
    rc, _l = install_chain(d)
    wrapper = os.path.join(_hooks_dir(d), "pre-commit")
    return rc == 2 and "hook.py" not in _read_hook(wrapper)


def _t_staged_readmes(d):
    import shutil  # noqa: PLC0415
    _git(d, "config", "user.email", "a@b")
    _git(d, "config", "user.name", "a")
    shutil.copytree(os.path.join(TOOL_REPO, "zreflect"), os.path.join(d, "zreflect"),
                    dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    if os.path.isfile(os.path.join(TOOL_REPO, "ruff.toml")):
        shutil.copy2(os.path.join(TOOL_REPO, "ruff.toml"), os.path.join(d, "ruff.toml"))
    open(os.path.join(d, "knobs.json"), "w", encoding="utf-8").write(
        '{"REFLECT_READMES": "README.md,README.zh.md,README.de.md"}\n')
    for fn in ("README.md", "README.zh.md", "README.de.md"):
        open(os.path.join(d, fn), "w", encoding="utf-8").write(f"# {fn}\nREADME.md README.zh.md README.de.md\n")
    _git(d, "add", "README.md")
    if not _commit_readmes_together(d):
        return False
    _git(d, "add", "README.zh.md", "README.de.md")
    return not _commit_readmes_together(d)


def _cases():
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415

    import i18n  # noqa: PLC0415

    def with_repo(fn, with_zreflect=True):
        d = tempfile.mkdtemp()
        try:
            _sh(["git", "init", "-q", d])
            if with_zreflect:
                os.makedirs(os.path.join(d, "zreflect"), exist_ok=True)
            return fn(d)
        finally:
            shutil.rmtree(d, True)

    def t_no_hooks(d):
        shutil.rmtree(_hooks_dir(d), True)
        return install_chain(d)[0] == 2

    return [
        ("hookgate.no_args_prints_usage", lambda: _run_cli([], quiet=True) == 0),
        ("★ hookgate.unstaged_facts_rejected", lambda: with_repo(_t_unstaged)),
        ("★ hookgate.unknown_phase_is_2", lambda: _run_cli(["bogus", "/tmp"], quiet=True) == 2),
        ("★ hookgate.push_phase_removed_is_2", lambda: _run_cli(["push", "/tmp"], quiet=True) == 2),
        ("★ hookgate.missing_repo_is_2",
         lambda: _run_cli(["commit", "/nonexistent-xyz"], quiet=True) == 2),
        ("★ hookgate.missing_root_is_2", lambda: _run_cli(["commit"], quiet=True) == 2),
        ("★ hookgate.no_zreflect_is_2",
         lambda: with_repo(lambda d: _run_cli(["commit", d], quiet=True) == 2, False)),
        ("★ hookgate.summary_shape_can_red",
         lambda: i18n.is_summary("=== 3 PASS / 0 FAIL ===")
         and not i18n.is_summary("=== 3 PASS / 0 fail ===")),
        ("★ hookgate.staged_readmes_checked_at_commit", lambda: with_repo(_t_staged_readmes, False)),
        ("install.no_args_prints_only", lambda: with_repo(_t_instructions)),
        ("★ install.unknown_mode_is_2", lambda: _run_cli(["--bogus"], quiet=True) == 2),
        ("★ install.not_a_repo_is_2",
         lambda: _run_cli(["--chain", "/nonexistent-xyz"], quiet=True) == 2),
        ("★ install.chain_keeps_existing", lambda: with_repo(_t_chain)),
        ("★ install.uninstall_restores", lambda: with_repo(_t_uninstall)),
        ("★ install.chain_refused_when_hookspath_set", lambda: with_repo(_t_blocked)),
        ("★ install.missing_hooks_dir_is_2", lambda: with_repo(t_no_hooks)),
    ]


def _main(argv):
    rc = activate_or_fatal()
    if rc:
        return rc
    if "--selftest" in argv:
        from gate import selftest  # noqa: PLC0415
        return selftest(M("gate.title.hookgate"), _cases())
    return _run_cli(argv)


GATE = meta(
    "Hook entry",
    "the single mouth called by other hook systems: commit re-renders, verifies staged READMEs "
    "and runs commit+start-of-work gates; --chain/--uninstall",
    knobs=("REFLECT_DOC",),
    runs_at="start-of-work",
    off_reason="the hook entry is invoked by git, not attached to the pre-commit phase",
)


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
