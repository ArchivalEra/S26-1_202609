#!/usr/bin/env python3
"""Discovered gate/module/plugin rosters, phase runner CLI, and SEAL.json CLI."""
from __future__ import annotations

import ast
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gate  # noqa: E402
import impact  # noqa: E402
import knobs  # noqa: E402
import trust  # noqa: E402
from gate import fatal, main_selftest_or, module_meta, repo  # noqa: E402
from i18n import M  # noqa: E402

GATES_BEGIN = "<!-- AUTO:GATES -->"
GATES_END = "<!-- /AUTO:GATES -->"

FIXTURE_RENAMES = {
    "FACTS.json": "LEDGER.json",
    "STATE.md": "NOTES.md",
    "retractions.json": "RETRACT.json",
    "questions": "cases",
    "README.md": "R1.md",
    "README.zh.md": "R2.md",
    "README.de.md": "R3.md",
    "HISTORY.md": "PAST.md",
}
RENAMED_DEFAULTS = tuple(FIXTURE_RENAMES)
BUILTIN_PHASES = ("commit", "start-of-work")


def phases():
    """Return built-in phases plus custom `REFLECT_PHASES` entries."""
    val = (knobs.raw("REFLECT_PHASES") or "").strip()
    out = list(BUILTIN_PHASES)
    for p in (x.strip() for x in val.split(",")):
        if p and p not in out:
            out.append(p)
    return tuple(out)


def phases_problems():
    """Verify custom `REFLECT_PHASES` does not redeclare a built-in phase."""
    val = (knobs.raw("REFLECT_PHASES") or "").strip()
    if not val:
        return []
    dup = [p for p in (x.strip() for x in val.split(",")) if p in BUILTIN_PHASES]
    if dup:
        return [M("registry.builtin_phase_repeated", phases=", ".join(sorted(set(dup))))]
    return []


def _parse_decl_node(node, attr, func, rel):
    if not (isinstance(node, ast.Assign) and len(node.targets) == 1
            and getattr(node.targets[0], "id", "") == attr):
        return None
    if attr == "MODULE" and isinstance(node.value, ast.Dict):
        try:
            d = ast.literal_eval(node.value)
            if isinstance(d, dict) and "name" in d and "desc" in d:
                return {"file": rel, "name": d["name"], "desc": d["desc"],
                        "selftest": bool(d.get("selftest", True))}
        except ValueError:
            return None
    if not (isinstance(node.value, ast.Call) and len(node.value.args) >= 2):
        return None
    fn = node.value.func
    if (getattr(fn, "id", "") or getattr(fn, "attr", "")) != func:
        return None
    return _eval_call_decl(node.value, func, rel)


def _eval_call_decl(call, func, rel):
    try:
        kw = {k.arg: ast.literal_eval(k.value) for k in call.keywords if k.arg}
        name, desc = ast.literal_eval(call.args[0]), ast.literal_eval(call.args[1])
    except (ValueError, IndexError):
        return None
    if func == "module_meta":
        return {"file": rel, "name": name, "desc": desc, "selftest": bool(kw.get("selftest", True))}
    return {"file": rel, "name": name, "desc": desc,
            "knobs": tuple(kw.get("knobs", ())),
            "name_dependent": bool(kw.get("name_dependent", False)),
            "runs_at": str(kw.get("runs_at", "commit")),
            "off_reason": kw.get("off_reason")}


def _declaration(path, rel, attr="GATE", func="meta"):
    try:
        with open(path, encoding="utf-8") as fh:
            tree = ast.parse(fh.read())
    except (OSError, SyntaxError):
        return None
    for node in tree.body:
        res = _parse_decl_node(node, attr, func, rel)
        if res is not None:
            return res
    return None


def modules(zdir=None):
    """Discover `MODULE` declarations under `zdir`; return `(declared, undeclared)`."""
    d = zdir if zdir is not None else gate.zdir()
    declared, undeclared = [], []
    try:
        names = sorted(os.listdir(d))
    except OSError:
        return [], []
    for n in names:
        if not n.endswith(".py") or n == "__init__.py" or n.startswith("measure_"):
            continue
        rel = "zreflect/" + n
        mod = _declaration(os.path.join(d, n), rel, attr="MODULE", func="module_meta")
        if mod:
            declared.append(mod)
        elif _declaration(os.path.join(d, n), rel) is None:
            undeclared.append(rel)
    return declared, undeclared


def _has_selftest_code(text):
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return False
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and node.value == "--selftest":
            return True
        if isinstance(node, ast.Name) and node.id in ("main_selftest_or", "_selftest"):
            return True
    return False


def selftest_modules(zdir=None):
    """Return `(runnable_module_files, missing_selftest_entry_files)`."""
    declared, _und = modules(zdir)
    d = zdir if zdir is not None else gate.zdir()
    mods, missing = [], []
    for m in declared:
        if not m.get("selftest"):
            continue
        with open(os.path.join(d, os.path.basename(m["file"])), encoding="utf-8") as fh:
            text = fh.read()
        if _has_selftest_code(text):
            mods.append(m["file"])
        else:
            missing.append(m["file"])
    return mods, missing


def _scan_gates_dir(dir_path, prefix):
    out: list[dict] = []
    missing: list[str] = []
    try:
        names = sorted(os.listdir(dir_path))
    except OSError:
        return out, missing
    for n in names:
        if not n.endswith(".py") or n == "__init__.py":
            continue
        rel = prefix + "/" + n
        meta = _declaration(os.path.join(dir_path, n), rel)
        if meta:
            out.append(meta)
        elif n.startswith("check_"):
            missing.append(rel)
    return out, missing


def gates(zdir=None):
    """Discover `GATE = meta(...)` declarations in `zreflect/` and `reflect-local/`; return `(gates, missing)`."""
    d = zdir if zdir is not None else gate.zdir()
    out, missing = _scan_gates_dir(d, "zreflect")
    if zdir is None:
        ldir_name = knobs.get("REFLECT_LOCAL_DIR") or "reflect-local"
        ldir = repo(ldir_name)
        if os.path.isdir(ldir):
            l_out, l_miss = _scan_gates_dir(ldir, ldir_name)
            out.extend(l_out)
            missing.extend(l_miss)
    return out, missing


def runnable(phase="commit", zdir=None):
    """Return discovered gates whose `runs_at` matches `phase`."""
    gs, _missing = gates(zdir)
    return [g for g in gs if g.get("runs_at", "commit") == phase]


def _knob_default_set(kind, dflt):
    if kind == "list":
        return {x.strip() for x in dflt.split(",")}
    return {dflt} if dflt else set()


def _touches_renamed(g):
    renamed = set(RENAMED_DEFAULTS)
    for k in g["knobs"]:
        kind, dflt, _ = knobs.REGISTRY.get(k, ("", "", ""))
        if _knob_default_set(kind, dflt) & renamed:
            return True
    return False


def _gate_problems(gs, missing):
    out = []
    if missing:
        out.append(M("registry.missing_declaration", files=", ".join(missing)))
    known = phases()
    for g in gs:
        if g.get("runs_at", "commit") not in known:
            out.append(M("registry.unknown_phase", file=g["file"],
                         runs_at=g.get("runs_at"), phases=" | ".join(known)))
        if g["name_dependent"] and not _touches_renamed(g):
            out.append(M("registry.name_dependent_wrong", file=g["file"]))
    if not gs and not missing:
        out.append(M("registry.empty_roster"))
    return out


def problems(gs, missing, mods=None, mods_missing=None, knob_problems=None, undeclared=None):
    """Reconcile declarations, phases, `knobs.json`, and `SEAL.json`."""
    out = phases_problems() + _gate_problems(gs, missing)
    auto = mods is None
    if mods is None or mods_missing is None:
        mods, mods_missing = selftest_modules()
    if mods_missing:
        out.append(M("registry.selftest_no_entry", files=", ".join(mods_missing)))
    if not mods:
        out.append(M("registry.no_module_selftest"))
    undecl = modules()[1] if undeclared is None else undeclared
    if undecl:
        out.append(M("registry.undeclared_module", files=", ".join(undecl)))
    out += list(knobs.config_problems() if knob_problems is None else knob_problems)
    if auto:
        out += knobs.direct_environ_problems()
    if auto and (trust.seal_exists() or os.path.isfile(os.path.join(gate.zdir(), "trust.py"))):
        out += trust.verify_problems()
    return out


def red_need(gs=None):
    """Return basenames of gates that must fail under default filenames when renamed."""
    if gs is None:
        gs, _ = gates()
    return sorted(os.path.basename(g["file"]) for g in gs
                  if g["name_dependent"] and _touches_renamed(g))


def plugins(hooks_dir=None):
    """Discover hook scripts under `reflect-local/` exposing `--selftest`."""
    ldir_name = knobs.get("REFLECT_LOCAL_DIR") or "reflect-local"
    d = hooks_dir if hooks_dir is not None else repo(ldir_name)
    out: list[str] = []
    if not os.path.isdir(d):
        return out
    for n in sorted(os.listdir(d)):
        if not n.endswith(".py"):
            continue
        try:
            with open(os.path.join(d, n), encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError:
            continue
        if _has_selftest_code(text):
            out.append(ldir_name + "/" + n)
    return out


def render_gates(gs):
    """PINNED: render the fixed-language `AUTO:GATES` Markdown table."""
    lines = [GATES_BEGIN,
             ("> This block is rendered by `zreflect/facts.py --render-doc` from the "
              "discovered roster; **do not hand-edit**."),
             ("> The execution plane (hooks / CI) reads `registry --run <phase>` -- "
              "the phase is a declared field (`runs_at`), not a file name."),
             "", "| Gate | Phase | What it guards | Knobs consumed | Why it may be off |",
             "|---|---|---|---|---|"]
    for g in sorted(gs, key=lambda x: (x.get("runs_at", "commit"), x["file"])):
        lines.append("| `%s`（%s） | %s | %s | %s | %s |"
                     % (os.path.basename(g["file"]), g["name"],
                        g.get("runs_at", "commit"), g["desc"],
                        ", ".join("`%s`" % k for k in g["knobs"]) or "--",
                        g.get("off_reason") or "--"))
    off_capable = sum(1 for g in gs if g.get("off_reason"))
    lines += ["", "%d gates; %d may be disabled." % (len(gs), off_capable), GATES_END]
    return "\n".join(lines)


def _arg_after(argv, flag):
    i = argv.index(flag)
    if len(argv) <= i + 1 or argv[i + 1].startswith("-"):
        return None
    return argv[i + 1]


_MAX_GATE_BULLETS = 5
_MAX_GATE_LINES = 6


def _format_gate_output(text):
    lines = [ln.rstrip() for ln in (text or "").splitlines() if ln.strip()]
    if not lines:
        return []
    bullets = [ln for ln in lines if ln.startswith("  \u00b7 ")]
    if bullets:
        out, shown = [], 0
        for ln in lines:
            if ln.startswith("  \u00b7 "):
                if shown >= _MAX_GATE_BULLETS:
                    continue
                shown += 1
            out.append("      " + ln)
        extra = len(bullets) - shown
        if extra > 0:
            out.append("      " + str(M("registry.more_items", count=extra)))
        return out
    selected = lines if len(lines) <= _MAX_GATE_LINES else [lines[0], lines[1], "...", *lines[-4:]]
    return ["      " + ln for ln in selected]


def _emit_phase_group(files, maker, fail_out):
    for f in files:
        print(maker(f))
        for ln in _format_gate_output(fail_out.get(f) or ""):
            print(ln)


def _pluggable_gates():
    gs, _ = gates()
    return frozenset(os.path.basename(g["file"]) for g in gs if g.get("off_reason"))


def _off_policy_error(off_list, pluggable=None):
    plugs = _pluggable_gates() if pluggable is None else pluggable
    core_off = [f for f in off_list if os.path.basename(f) not in plugs]
    if core_off:
        return M("registry.core_gate_off", files=", ".join(core_off))
    req = set(knobs.required_gates())
    bad_off = [f for f in off_list if f in req or os.path.basename(f) in req]
    if bad_off:
        return M("registry.required_gate_off", files=", ".join(bad_off))
    declared_off = {os.path.basename(s) for s in knobs.off_gates()}
    undeclared_off = [f for f in off_list if os.path.basename(f) not in declared_off]
    if undeclared_off:
        return M("registry.pluggable_off_undeclared", files=", ".join(undeclared_off))
    anc_probs = trust.check_off_gates_anchor(off_list)
    return anc_probs[0] if anc_probs else None


def _select_affected(gs, argv):
    if "--all" in argv:
        return gs
    plan = impact.affected_plan(impact.git_changed_files(), gs)
    print(M("registry.affected_plan", selected=len(plan["selected"]),
            total=plan["total"], reason=plan["reason"]), flush=True)
    if not plan["selected"]:
        print(M("registry.affected_none"), flush=True)
    return plan["selected"]


def _run_with_cache(phase, gs):
    import time  # noqa: PLC0415
    total, idx = len(gs), 0

    def _step(f):
        nonlocal idx
        idx += 1
        t0 = time.monotonic()
        rc, out = gate.default_runner(f)
        print("  [%d/%d] %s (%.1fs)" % (idx, total, f, time.monotonic() - t0),
              file=sys.stderr, flush=True)
        return rc, out

    runner = _step if gate._INPROC_CACHE is None else None
    return gate.with_run_cache(lambda: gate.run_phase(phase, gs, runner=runner))


def _emit_run_result(phase, res):
    print(M("registry.phase_summary", phase=phase, ran=res["ran"], off=res["off"],
            failed=res["failed"], fatal=res.get("fatal", 0), error=res.get("error", 0)))
    fail_out = res.get("fail_out", {})
    _emit_phase_group(res["fail_list"], lambda f: M("registry.phase_failed", file=f), fail_out)
    _emit_phase_group(res.get("fatal_list", ()), lambda f: M("registry.phase_fatal", file=f), fail_out)
    _emit_phase_group(res.get("error_list", ()), lambda f: M("registry.phase_error", file=f), fail_out)
    if res.get("skip_list"):
        print(M("registry.phase_skip_list", count=len(res["skip_list"]),
                files=", ".join(res["skip_list"])))
        return fatal(M("registry.phase_skipped_fail", count=len(res["skip_list"]),
                       files=", ".join(res["skip_list"])))
    if res["off_list"]:
        print(M("registry.phase_off_list", count=len(res["off_list"]),
                files=", ".join(res["off_list"])))
        off_err = _off_policy_error(res["off_list"])
        if off_err is not None:
            return fatal(off_err)
    return 1 if (res["failed"] or res.get("fatal") or res.get("error")) else 0


_RESEAL_PREFIX = "--reseal="


def _main_run(argv):
    phase = _arg_after(argv, "--run")
    if phase not in phases():
        return fatal(M("registry.empty_phase", phase=phase))
    gs, missing = gates()
    reg_probs = problems(gs, missing) + trust.check_knobs_anchor()
    if reg_probs:
        for p in reg_probs:
            print("  · %s" % p, file=sys.stderr)
        return 1
    gs = runnable(phase)
    if not gs:
        return fatal(M("registry.empty_phase", phase=phase))
    gs = _select_affected(gs, argv)
    if not gs:
        return 0
    return _emit_run_result(phase, _run_with_cache(phase, gs))


def _main_seal(argv):
    if "--verify-seal" in argv:
        if not trust.seal_exists():
            return fatal(M("seal.missing", path=trust.seal_path()))
        probs = trust.verify_problems()
        if probs:
            for p in probs:
                print("  · %s" % p, file=sys.stderr)
            return 1
        print(trust.current_tree_sha(verified=True) or "")
        return 0
    hit = [a for a in argv if a.startswith(_RESEAL_PREFIX)]
    if hit:
        targets = [t.strip() for t in hit[0][len(_RESEAL_PREFIX):].split(",") if t.strip()]
        tree, err = trust.reseal(targets, force_all="--force" in argv, bump_seq="--bump-seq" in argv)
        if err:
            return fatal(err)
        print(M("seal.resealed", tree=tree, count=len(targets)))
        return 0
    return None


def cli_selftest_missing_lines(missing):
    """Format CLI lines for modules missing `--selftest`."""
    return [M("registry.selftest_no_entry_cli", file=m) for m in missing]


def _main_lists(argv):
    simple = {
        "--red-need": lambda: print(" ".join(red_need())),
        "--runnable": lambda: [print(g["file"]) for g in runnable(_arg_after(argv, "--runnable"))],
        "--all-runnable": lambda: [print(g["file"]) for g in gates()[0]],
        "--plugins": lambda: print("\n".join(plugins())),
        "--fixture-renames": lambda: [print("%s=%s" % item)
                                      for item in sorted(FIXTURE_RENAMES.items())],
    }
    for flag, fn in simple.items():
        if flag in argv:
            fn()
            return 0
    return None


def _main_gates():
    gs, missing = gates()
    probs = problems(gs, missing)
    for x in probs:
        print("  · %s" % x, file=sys.stderr)
    if probs:
        return fatal(M("registry.roster_problems", count=len(probs)))
    for g in gs:
        print("%s\t%s\t%s" % (g["file"], g["name"], g["desc"]))
    return 0


def _main_selftest_mods():
    mods, missing = selftest_modules()
    for line in cli_selftest_missing_lines(missing):
        print(line, file=sys.stderr)
    if missing:
        return 1
    print("\n".join(mods))
    return 0


_KNOWN_FLAGS = frozenset({
    "--red-need", "--runnable", "--all-runnable", "--plugins", "--fixture-renames",
    "--verify-seal", "--force", "--bump-seq", "--run", "--affected", "--all",
    "--selftest-modules", "--gates", "--selftest",
})


def _unknown_flag(argv):
    for a in argv:
        if a.startswith("-") and not a.startswith(_RESEAL_PREFIX) and a not in _KNOWN_FLAGS:
            return a
    return None


def main(argv):
    bad = _unknown_flag(argv)
    if bad is not None:
        return fatal(M("registry.unknown_flag", flag=bad))
    for rc in (_main_lists(argv), _main_seal(argv)):
        if rc is not None:
            return rc
    if "--run" in argv:
        return _main_run(argv)
    if "--selftest-modules" in argv:
        return _main_selftest_mods()
    if "--gates" in argv:
        return _main_gates()
    print(M("registry.usage"), file=sys.stderr)
    return 2


def _cases():
    gs, missing = gates()
    fake_g = [{"file": "zreflect/check_x.py", "name": "x", "desc": "d",
               "knobs": ("REFLECT_AB",), "name_dependent": True,
               "runs_at": "commit", "off_reason": None}]
    return [
        ("registry.real_gates_clean", lambda: len(gs) > 0 and problems(gs, missing) == []),
        ("★ registry.missing_declaration_reported",
         lambda: any(p.code == "registry.missing_declaration"
                     for p in problems(gs, ["zreflect/check_orphan.py"],
                                       mods=["m.py"], mods_missing=[], knob_problems=[], undeclared=[]))),
        ("★ registry.unknown_phase_reported",
         lambda: any(p.code == "registry.unknown_phase"
                     for p in problems([dict(fake_g[0], runs_at="bogus", name_dependent=False)], [],
                                       mods=["m.py"], mods_missing=[], knob_problems=[], undeclared=[]))),
        ("★ registry.name_dependent_wrong",
         lambda: any(p.code == "registry.name_dependent_wrong"
                     for p in problems(fake_g, [], mods=["m.py"], mods_missing=[],
                                       knob_problems=[], undeclared=[]))),
        ("★ registry.empty_roster",
         lambda: any(p.code == "registry.empty_roster"
                     for p in problems([], [], mods=["m.py"], mods_missing=[],
                                       knob_problems=[], undeclared=[]))),
        ("★ registry.selftest_no_entry",
         lambda: any(p.code == "registry.selftest_no_entry"
                     for p in problems(gs, missing, mods=["m.py"], mods_missing=["m.py"],
                                       knob_problems=[], undeclared=[]))),
        ("★ registry.undeclared_module",
         lambda: any(p.code == "registry.undeclared_module"
                     for p in problems(gs, missing, mods=["m.py"], mods_missing=[],
                                       knob_problems=[], undeclared=["zreflect/stray.py"]))),
        ("registry.render_gates_markers",
         lambda: GATES_BEGIN in render_gates(gs) and GATES_END in render_gates(gs)),
        ("registry.plugins_discovered",
         lambda: "reflect-local/hook.py" in plugins()
         and any(g["file"] == "zreflect/doctor.py" for g in gs)),
        ("registry.emit_multi_bullets_bounded", lambda: _emit_bullets_ok()),
        ("★ registry.off_policy_rejects_core_and_undeclared", lambda: _off_policy_ok()),
        ("★ registry.bad_flags_and_missing_run_phase_fail",
         lambda: main(["--run"]) == 2 and main(["--runnable", "--badflag"]) == 2),
    ]


def _off_policy_ok():
    core = _off_policy_error(["zreflect/check_facts.py"])
    undecl = _off_policy_error(["zreflect/check_ab.py"]) if not knobs.off_gates() else None
    return (core is not None and core.code == "registry.core_gate_off"
            and (undecl is None or undecl.code == "registry.pluggable_off_undeclared"))


def _emit_bullets_ok():
    joined = "\n".join(_format_gate_output(
        "hdr\n" + "\n".join("  \u00b7 p%d" % i for i in range(1, 8))))
    return "  \u00b7 p1" in joined and "  \u00b7 p5" in joined and "  \u00b7 p6" not in joined and "2" in joined


MODULE = module_meta("Roster registry", "discovered rosters, phase runner, and seal CLI",
                     selftest=True)

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], M("gate.title.registry"), _cases, main))
