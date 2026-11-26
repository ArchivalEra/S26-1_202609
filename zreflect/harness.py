#!/usr/bin/env python3
"""Gate selftest harness: **discovers** every gate and first proves it can go red.

All of its text goes through `M()`, under the same zero-language regime as
every other gate; only `einfacht-env.sh` remains shell, and its summary-line
shape is checked by actually running it in `run_plugins()`.

## Why "discovery" and not a "roster"

A handwritten roster always drifts. Add a new checker and forget to
register it, and that checker becomes "a checker nobody watches" -- while
the roster itself stays green and tells you everything is fine. So here it
is the other way around: **registration is discovered**, not remembered
(rosters are always derived from `registry`'s declaration lines).

## Four sections of duty

    gates        discover and run every gate → must be able to red + must emit a machine summary line
    plugins      pluggable plugins (those in reflect-local/*.sh carrying the selftest marker + named specials)
    modules      platform modules' selftests (set difference: gates' selftests already ran in the gates section)
    configurable cross-repo configurability (renamed fixture all green + gates named under default names must red)

## Honest boundary

  · The plugins section runs **the user's** `.sh` -- their output is not
    subject to the zero-language regime (user-made scripts are their own
    business); only their rc and machine summary line are judged here.
  · The `configurable` section builds a temporary fixture repo and runs real
    gates; it verifies "names aren't hardcoded", not "gate logic is right"
    (that's each gate's own selftest business).
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from i18n import M  # noqa: E402

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Machine summary line: the criterion lives in `machine.is_summary()` (single
# source of truth).

# Selftest advertisement marker: present = this file claims it can be proven
# via `--selftest`.
ADVERT = re.compile(r"(main_selftest_or|--selftest)")


def _run(argv, cwd=None, env=None):
    """Run one command, return `(rc, merged output)`. rc is the **real return
    code**, not piped."""
    try:
        p = subprocess.run(argv, cwd=cwd, capture_output=True, text=True,
                           env=env, timeout=600,
                           encoding="utf-8", errors="replace")
    except (OSError, subprocess.SubprocessError) as e:
        return 127, "harness: %r" % (e,)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def _tail(text, n=5):
    """Lines to relay on failure: prefer `fail |` / `FATAL:` lines; keep head+tail on crashes."""
    all_lines = [ln for ln in (text or "").splitlines() if ln.strip()]
    notable = [ln for ln in all_lines
               if ln.lstrip().startswith(("fail |", "FATAL:"))]
    if notable:
        return notable[:n]
    if len(all_lines) <= n or n <= 2:
        return all_lines[-n:]
    return [all_lines[0], all_lines[1], "...", *all_lines[-(n - 2):]]


def _has_summary(text):
    for ln in (text or "").splitlines():
        m = re.fullmatch(r"=== (\d+) PASS / (\d+) FAIL ===", ln.strip())
        if m and int(m.group(1)) >= 1 and int(m.group(2)) == 0:
            return True
    return False


def _derive_listing(repo):
    """Derive the gate listing from `registry.gates` (in-process, discovered)."""
    import registry  # noqa: PLC0415
    gs, missing = registry.gates(os.path.join(repo, "zreflect"))
    return [g["file"] for g in gs], missing


def _ok_msg(path, out):
    last = _tail(out, 1)
    summary = last[0].strip("= ") if last else ""
    return str(M("harness.gate_ok", file=path, summary=summary))


def _check_one_gate(repo, rel):
    """Run one gate's selftest. Returns `(passed?, list of output lines)`."""
    g = os.path.join(repo, rel)
    if not os.path.isfile(g):
        return False, [str(M("harness.missing_file", file=rel))]
    try:
        text = open(g, encoding="utf-8", errors="replace").read()
    except OSError:
        text = ""
    if not ADVERT.search(text):
        return False, [str(M("harness.no_selftest_entry", file=rel))]
    env = dict(os.environ)
    env["GATE_REPO"] = repo
    rc, out = _run([sys.executable, g, "--selftest"], cwd=repo, env=env)
    if rc != 0:
        return False, ([str(M("harness.selftest_failed", file=rel))]
                       + ["      " + ln for ln in _tail(out)])
    if not _has_summary(out):
        return False, [str(M("harness.no_machine_summary", file=rel))]
    return True, [_ok_msg(rel, out)]


def run_gates(repo, listing=None):
    """Run a group of gates' selftests. Returns `(ok, n, bad, lines)`.

    `listing` is injectable (selftest uses a fake listing, no dependence on
    the real repo); None => derived from `registry`.
    """
    missing_decl: list[str] = []
    if listing is None:
        listing, missing_decl = _derive_listing(repo)
    n = bad = 0
    lines = []
    for rel in missing_decl:
        lines.append(str(M("registry.missing_declaration", files=rel)))
        bad += 1
    import concurrent.futures  # noqa: PLC0415
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(12, os.cpu_count() or 4, max(1, len(listing)))) as pool:
        results = list(pool.map(lambda r: _check_one_gate(repo, r), listing))
    for passed, out in results:
        lines += out
        n += 1
        if not passed:
            bad += 1
    if n == 0:
        # Zero-value guard: not a single gate discovered => fail (empty input is not a pass).
        lines.append(str(M("harness.no_gates_found")))
        return False, n, bad + 1, lines
    if bad:
        lines.append(str(M("harness.some_failed", count=n, bad=bad)))
        return False, n, bad, lines
    lines.append(str(M("harness.all_can_red", count=n)))
    return True, n, bad, lines


def run_plugins(repo):
    """Pluggable plugins + named specials (roster derived from registry). Returns `(ok, lines)`."""
    import knobs  # noqa: PLC0415
    import registry  # noqa: PLC0415
    names = registry.plugins(os.path.join(repo, knobs.get("REFLECT_LOCAL_DIR") or "reflect-local"))
    lines = []
    bad = 0
    for p in names:
        ok, out_lines = _one_plugin(repo, p)
        lines += out_lines
        bad += 0 if ok else 1
    if not names:
        lines.append(str(M("harness.no_plugins")))
        return False, lines
    return bad == 0, lines


def _one_plugin(repo, p):
    """Run one plugin's selftest, return `(passed?, output lines)`. Each of the four failure modes is its own tier."""
    f = os.path.join(repo, p)
    if not os.path.isfile(f):
        return False, [str(M("harness.missing_file", file=p))]
    cmd = ["sh", f, "--selftest"] if p.endswith(".sh") else \
          [sys.executable, f, "--selftest"]
    rc, out = _run(cmd, cwd=repo)
    if rc != 0:
        return False, ([str(M("harness.selftest_failed", file=p))]
                       + ["      " + ln for ln in _tail(out)])
    if not _has_summary(out):
        return False, [str(M("harness.no_machine_summary", file=p))]
    return True, [_ok_msg(p, out)]


def _run_one_module(repo, m):
    f = os.path.join(repo, m)
    rc, out = _run([sys.executable, f, "--selftest"], cwd=repo)
    if rc != 0:
        return False, [str(M("harness.selftest_failed", file=m))] + ["      " + ln for ln in _tail(out)]
    if not _has_summary(out):
        return False, [str(M("harness.no_machine_summary", file=m))]
    return True, [_ok_msg(m, out)]


def run_modules(repo):
    """Platform modules' selftests (set difference: gates' selftests already ran in `run_gates`)."""
    import registry  # noqa: PLC0415
    z = os.path.join(repo, "zreflect")
    _, undeclared = registry.modules(z)
    if undeclared:
        return False, [str(M("registry.undeclared_module", file=u)) for u in undeclared]
    mods, missing = registry.selftest_modules(z)
    if missing:
        return False, [str(M("harness.no_selftest_entry", file=m)) for m in missing]
    gs, _ = registry.gates(z)
    gates = {g["file"] for g in gs}
    lines = []
    n = bad = 0
    import concurrent.futures  # noqa: PLC0415
    targets = [m for m in mods if m not in gates]
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(12, os.cpu_count() or 4, max(1, len(targets)))) as pool:
        results = list(pool.map(lambda m: _run_one_module(repo, m), targets))
    for ok, mod_lines in results:
        n += 1
        lines += mod_lines
        if not ok:
            bad += 1
    if n == 0:
        lines.append(str(M("harness.no_modules_found")))
        return False, lines
    return bad == 0, lines


def run_configurable(repo):
    """Cross-repo configurability: the fixture repo with every name swapped still all green; gates named under default names must red."""
    import registry  # noqa: PLC0415
    tmp = tempfile.mkdtemp()
    try:
        return _configurable_impl(repo, tmp, registry)
    finally:
        shutil.rmtree(tmp, True)


def _configurable_fixture(repo, tmp, registry):
    """Build a **qualified external repo**: all three doc sections present, carriers present under renamed names.

    Returns `(env, gates)` -- `env` is the environment with renamed knobs,
    `gates` is the list to run.
    """
    fr = getattr(registry, "FIXTURE_RENAMES", {})
    fx_facts = fr.get("FACTS.json", "LEDGER.json")
    fx_doc = fr.get("STATE.md", "NOTES.md")

    open(os.path.join(tmp, "a.py"), "w", encoding="utf-8").write("x = 1\n")
    # Machine block markers must be **placed by hand once first** (block not
    # found != block is correct).
    open(os.path.join(tmp, fx_doc), "w", encoding="utf-8").write(
        "# T\n\n> refs [[py_files]] [[md_files]].\n\n"
        "<!-- AUTO:FACTS -->\n<!-- /AUTO:FACTS -->\n"
        "<!-- AUTO:GATES -->\n<!-- /AUTO:GATES -->\n")
    open(os.path.join(tmp, "AGENTS.md"), "w", encoding="utf-8").write(
        "# AGENTS\n\nsee `zreflect/doc.py` (`doc.RULES`); state: `%s`.\n\n"
        "```bash\npython3 zreflect/registry.py --run commit\n```\n" % fx_doc)
    open(os.path.join(tmp, "RETRACT.json"), "w", encoding="utf-8").write('{"schema":1,"retractions":[]}\n')
    fx_hist = fr.get("HISTORY.md", "PAST.md")
    open(os.path.join(tmp, fx_hist), "w", encoding="utf-8").write(
        "# PAST\n\n> how we got here; deliberately off every scan surface.\n")
    os.makedirs(os.path.join(tmp, "cases"), exist_ok=True)
    open(os.path.join(tmp, "cases", "02-y.md"), "w", encoding="utf-8").write(
        "# e2\n\n**Status:** ready-for-agent\n\n**Settling:** `python3 a.py` ---- rc=0 A; rc=7 B\n")
    for f in ("R1", "R2", "R3"):
        open(os.path.join(tmp, f + ".md"), "w", encoding="utf-8").write(
            "# %s\n\n[R1](R1.md) [R2](R2.md) [R3](R3.md)\n" % f)

    env = dict(os.environ)
    env["GATE_REPO"] = tmp
    env.update({"REFLECT_FACTS": fx_facts, "REFLECT_DOC": fx_doc,
                "REFLECT_MEASURE_MODULE": "measure_example"})
    _run([sys.executable, os.path.join(repo, "zreflect", "facts.py")], cwd=repo, env=env)
    _run([sys.executable, os.path.join(repo, "zreflect", "facts.py"),
          "--render-doc", fx_doc], cwd=repo, env=env)

    gs, _ = registry.gates(os.path.join(repo, "zreflect"))
    gates = [g["file"] for g in gs]
    env.update({"REFLECT_DOCS": "%s,AGENTS.md" % fx_doc,
                "REFLECT_RETRACTIONS": "RETRACT.json",
                "REFLECT_QUESTIONS": "cases",
                "REFLECT_HISTORY": fx_hist,
                "REFLECT_READMES": "R1.md,R2.md,R3.md"})
    return env, gates


def _core_must_run(repo):
    import registry  # noqa: PLC0415
    gs, _ = registry.gates(os.path.join(repo, "zreflect"))
    return frozenset(os.path.basename(g["file"]) for g in gs if not g.get("off_reason"))


def _renamed_all_green(repo, gates, env):
    """After renaming, every single gate must be green (and core gates not OFF). Returns `(ok_count, [(rel, detail)])`."""
    import concurrent.futures  # noqa: PLC0415
    bad = []
    core = _core_must_run(repo)

    def _one(rel):
        return rel, *_run([sys.executable, os.path.join(repo, rel)], cwd=repo, env=env)

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(12, os.cpu_count() or 4, max(1, len(gates)))) as pool:
        for rel, rc, out in pool.map(_one, gates):
            if rc != 0:
                bad.append((rel, " | ".join(_tail(out, 2)) or ("rc=%d" % rc)))
            elif os.path.basename(rel) in core and (out or "").lstrip().startswith("OFF:"):
                bad.append((rel, "unexpected OFF in configurable fixture"))
    return len(gates) - len(bad), bad


def _default_names_go_red(repo, gates, tmp):
    """Under default names, the gates named by `--red-need` **must go red**. Returns `(ok, the ones that didn't)`.

    ⚠️ The environment must be **clean**: give it only `GATE_REPO`, no renamed
    knobs -- the fixture's `env` still runs renamed, and this criterion cannot
    hold.
    """
    import concurrent.futures  # noqa: PLC0415
    clean = {k: v for k, v in os.environ.items() if not k.startswith("REFLECT_")}
    clean["GATE_REPO"] = tmp
    red = set()
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(12, os.cpu_count() or 4, max(1, len(gates)))) as pool:
        for rel, (rc, _o) in zip(gates, pool.map(
            lambda r: _run([sys.executable, os.path.join(repo, r)], cwd=repo, env=clean), gates
        ), strict=True):
            if rc != 0:
                red.add(os.path.basename(rel))
    import registry  # noqa: PLC0415
    gs, _ = registry.gates(os.path.join(repo, "zreflect"))
    red_need = registry.red_need(gs)
    return red_need, [b for b in red_need if b not in red]


def _configurable_impl(repo, tmp, registry):
    """Cross-repo configurability: the fixture repo with every name swapped still all green; gates named under default names must red.

    Three sections (each a helper): `_configurable_fixture` /
    `_renamed_all_green` / `_default_names_go_red`. This function only
    orchestrates -- 85 lines → 20.
    """
    env, gates = _configurable_fixture(repo, tmp, registry)
    lines = []
    if not gates:
        lines.append(str(M("harness.no_gates_in_fixture")))
        return False, lines

    ok, bad = _renamed_all_green(repo, gates, env)
    for rel, detail in bad:
        lines.append(str(M("harness.rename_failed", file=rel, detail=detail)))

    red_need, not_red = _default_names_go_red(repo, gates, tmp)
    if not red_need:
        lines.append(str(M("harness.empty_red_list")))
        return False, lines
    for b in not_red:
        lines.append(str(M("harness.not_red_under_defaults", gate=b)))
        return False, lines

    if ok != len(gates):
        lines.append(str(M("harness.configurable_failed",
                           ok=ok, total=len(gates))))
        return False, lines
    lines.append(str(M("harness.configurable_ok",
                       ok=ok, total=len(gates),
                       red=", ".join(red_need))))
    return True, lines


# End-to-end zero-language probes: these entry points **all produce
# user-visible text**.
# With no language pack installed they must emit only codes -- not one CJK
# character allowed.
# ⚠️ Probes only pick entry points that **don't put user data into the
# output**.
#
# `zreflect/next.py` can't be a probe: it lists the **subjects** of unpushed
# commits -- commit subjects are natural language written by the author
# (Chinese), which is **user data**, emitted verbatim as parameter values
# beyond `%(count)s`. The zero-language regime governs **templates** (`M()`'s
# phrasing), not data.
# Making it a probe would turn "just wrote a commit message in Chinese" into
# a false red (observed: this very case was reddened by its own commit
# subject).
#
# Its templates are covered by `check_i18n`'s `null_pack_output_has_no_cjk`
# (that case **feeds fixed parameters only**, never touching git state) -- so
# it hasn't left the criteria surface, it just got the right test method.
ZERO_LANG_PROBES: tuple = (
    ("zreflect/gate.py", []),
    # ⚠️ Probes clear all `REFLECT_*` (what's judged is exactly the "no
    # language pack requested" path), so the only eligible entry points are
    # ones that **neither consume configuration nor emit PINNED text**. Two
    # lessons from practice:
    #
    #   · `facts.py --check` -- depends on `REFLECT_DOCS`/`REFLECT_DOC` to
    #     decide which docs to audit. With them cleared it uses the default
    #     roster, which doesn't match this repo's actual configuration =>
    #     permanently red, and that red has nothing to do with language.
    #   · `facts.py --render` -- the output `PREAMBLE` is **fixed Chinese**
    #     (`PINNED:`: the machine block is audited byte-for-byte; following
    #     the language would make `--check` never converge) => permanent CJK
    #     leak report.
    #
    # `registry --red-need` is a pure filename list: zero configuration
    # dependency, zero natural language.
    ("zreflect/registry.py", ["--red-need"]),
    ("zreflect/knobs.py", ["--list"]),
)


def run_zero_language(repo):
    """**End-to-end** zero language: run real entry points with no language pack installed, assert zero Chinese in output.

    Why this case lives in the harness and not in `check_i18n`: `check_i18n`
    is a **static** AST scan (bare Chinese literals in source). It can't see
    "Chinese assembled at runtime", nor shell scripts. This one is a
    **behavioral** criterion: really run it, really look at the output.

    ⚠️ The environment **must** have no `REFLECT_LANG` -- what's judged is
    exactly the "no language pack requested" path.
    """
    import i18n  # noqa: PLC0415
    lines = []
    bad = 0
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("REFLECT_")}
    env["REFLECT_LANG"] = ""
    env["GATE_REPO"] = repo
    for rel, extra in ZERO_LANG_PROBES:
        path = os.path.join(repo, rel)
        if not os.path.isfile(path):
            lines.append(str(M("harness.missing_file", file=rel)))
            bad += 1
            continue
        rc, out = _run([sys.executable, path] + extra, cwd=repo, env=env)
        if rc != 0:
            lines.append(str(M("harness.zero_lang_rc", file=rel, rc=rc)))
            bad += 1
            continue
        cjk_lines = [ln for ln in (out or "").splitlines() if i18n.han(ln)]
        if cjk_lines:
            lines.append(str(M("harness.zero_lang_leak",
                               file=rel, count=len(cjk_lines),
                               sample=cjk_lines[0][:60])))
            bad += 1
            continue
        lines.append(str(M("harness.zero_lang_ok", file=rel)))
    if not ZERO_LANG_PROBES:
        lines.append(str(M("harness.no_probes")))
        return False, lines
    return bad == 0, lines


def _section(heading, runner):
    """PINNED: section dispatcher receives static harness.section_* literal."""
    print(str(M(heading)))
    ok, *_, lines = runner()
    for ln in lines:
        print(ln)
    return 0 if ok else 1


def _affected_modules(repo, changed, gs):
    import impact  # noqa: PLC0415
    import registry  # noqa: PLC0415
    z = os.path.join(repo, "zreflect")
    mods, _ = registry.selftest_modules(z)
    gate_files = {g["file"] for g in gs}
    rev = impact.reverse_import_graph(z)
    hit = set()
    for p in changed or ():
        norm = str(p).replace("\\", "/").lstrip("./")
        if norm in rev:
            hit |= rev[norm]
    return [m for m in mods if m not in gate_files and m in hit]


def _main_affected(repo):
    import impact  # noqa: PLC0415
    import registry  # noqa: PLC0415
    gs, _ = registry.gates(os.path.join(repo, "zreflect"))
    changed = impact.git_changed_files(repo)
    plan = impact.affected_plan(changed, gs)
    print(str(M("registry.affected_plan", selected=len(plan["selected"]),
                total=plan["total"], reason=plan["reason"])))
    if not plan["selected"]:
        print(str(M("registry.affected_none")))
        return 0
    listing = [g["file"] for g in plan["selected"]]
    rc = _section("harness.heading", lambda: run_gates(repo, listing=listing))
    if not plan["full_fallback"]:
        for m in _affected_modules(repo, changed, gs):
            ok, mod_lines = _run_one_module(repo, m)
            for ln in mod_lines:
                print(ln)
            rc = rc or (0 if ok else 1)
        return rc
    rc = rc or _section("harness.plugins_heading", lambda: run_plugins(repo))
    rc = rc or _section("harness.modules_heading", lambda: run_modules(repo))
    rc = rc or _section("harness.configurable_heading", lambda: run_configurable(repo))
    return rc or _section("harness.zero_lang_heading", lambda: run_zero_language(repo))


def main(argv):
    repo = HERE
    if "--selftest" in argv:
        return _selftest()
    if "--affected" in argv:
        return _main_affected(repo)
    rc = _section("harness.heading", lambda: run_gates(repo))
    rc = rc or _section("harness.plugins_heading",
                        lambda: run_plugins(repo))
    rc = rc or _section("harness.modules_heading",
                        lambda: run_modules(repo))
    rc = rc or _section("harness.configurable_heading",
                        lambda: run_configurable(repo))
    # Last section: **end-to-end zero language** (must be zero Chinese with no pack installed).
    return rc or _section("harness.zero_lang_heading",
                          lambda: run_zero_language(repo))


# -- selftest -----------------------------------------------------------------

def _fixture(files, listing=None):
    """Build a fixture repo and run `run_gates`. Returns (ok, n, bad, lines)."""
    d = tempfile.mkdtemp()
    try:
        for rel, body in files.items():
            p = os.path.join(d, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, "w", encoding="utf-8").write(body)
        return run_gates(d, listing=listing)
    finally:
        shutil.rmtree(d, True)


GOOD_GATE = '''import sys
print("=== %d PASS / 0 FAIL ===")
sys.exit(0 if "--selftest" in sys.argv else 0)
'''


def _cases():
    return [
        # (1) healthy input reports nothing: advertises --selftest, emits a summary line, rc=0
        ("harness.good_gate_is_green",
         lambda: _fixture({"zreflect/check_ok.py": GOOD_GATE % 3,
                           }, listing=["zreflect/check_ok.py"])[0]),
        # (2) what should be reported must be reported
        ("★ harness.gate_without_selftest_entry_is_red",
         lambda: not _fixture({"zreflect/check_silent.py": "import sys\nsys.exit(0)\n"},
                              listing=["zreflect/check_silent.py"])[0]),
        ("★ harness.gate_that_cannot_go_red_is_red",
         lambda: not _fixture(
             {"zreflect/check_bad.py":
              'import sys\nprint("=== 1 PASS / 1 FAIL ===")\n'
              'sys.exit(1 if "--selftest" in sys.argv else 0)\n'},
             listing=["zreflect/check_bad.py"])[0]),
        ("★ harness.gate_without_summary_is_red",
         lambda: not _fixture(
             {"zreflect/check_nosummary.py": 'import sys\nsys.exit(0)\n'},
             listing=["zreflect/check_nosummary.py"])[0]),
        ("★ harness.missing_file_is_red",
         lambda: not _fixture({}, listing=["zreflect/check_gone.py"])[0]),
        # (3) empty input must be reported -- zero-value guard
        ("★ harness.no_gates_at_all_is_red",
         lambda: not _fixture({}, listing=[])[0]),
        # The summary-line criterion itself has teeth (criterion lives in machine.is_summary)
        ("★ harness.summary_shape_can_red", lambda: _summary_shape_ok()),
    ]


def _summary_shape_ok():
    import i18n  # noqa: PLC0415
    return i18n.is_summary("=== 3 PASS / 0 FAIL ===") and \
        not i18n.is_summary("=== 3 PASS / 0 fail ===")


def _selftest():
    from gate import selftest  # noqa: PLC0415
    return selftest(M("gate.title.harness"), _cases())


from gate import module_meta  # noqa: E402

MODULE = module_meta(
    "gate selftest harness",
    "discover and run every gate's --selftest (must be able to red + must emit a machine summary line) + plugins + platform modules + cross-repo configurability",
    selftest=True)

if __name__ == "__main__":
    from gate import activate_or_fatal  # noqa: PLC0415
    rc = activate_or_fatal()
    sys.exit(rc or main(sys.argv[1:]))
