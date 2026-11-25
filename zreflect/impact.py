#!/usr/bin/env python3
"""Pure mechanical affected-gate selector (AST reverse deps + knob/path map, fail-closed)."""

import ast
import os
import subprocess
import sys

import gate
import knobs
from gate import module_meta, selftest
from i18n import M

_GLOBAL_FALLBACK_FILES = frozenset({
    "ANCHORS.json",
    "knobs.json",
})
_GLOBAL_FALLBACK_PREFIXES = (
    "reflect-local/",
    ".github/",
)


def _norm(path):
    return str(path or "").replace("\\", "/").lstrip("./")


def _local_module_names(zdir):
    try:
        names = os.listdir(zdir)
    except OSError:
        return set()
    return {n[:-3] for n in names if n.endswith(".py") and n != "__init__.py"}


def _import_dep(mod_name, local_mods):
    parts = mod_name.split(".")
    cand = parts[1] if parts[0] == "zreflect" and len(parts) > 1 else parts[0]
    return cand if cand in local_mods else None


def _imported_locals(path, local_mods):
    try:
        src = open(path, encoding="utf-8", errors="replace").read()
        tree = ast.parse(src, filename=path)
    except (OSError, SyntaxError):
        return set()
    deps = set()
    for node in ast.walk(tree):
        names = [a.name for a in node.names] if isinstance(node, ast.Import) else (
            [node.module] if isinstance(node, ast.ImportFrom) and node.module else [])
        for name in names:
            dep = _import_dep(name, local_mods)
            if dep:
                deps.add(dep)
    return deps


def _direct_reverse_graph(d, local_mods):
    direct_rev: dict[str, set[str]] = {"zreflect/%s.py" % m: set() for m in local_mods}
    for m in local_mods:
        rel = "zreflect/%s.py" % m
        if m.startswith("measure_") and "facts" in local_mods:
            direct_rev.setdefault(rel, set()).add("zreflect/facts.py")
        for dep in _imported_locals(os.path.join(d, m + ".py"), local_mods):
            dep_rel = "zreflect/%s.py" % dep
            if dep_rel != rel:
                direct_rev.setdefault(dep_rel, set()).add(rel)
    return direct_rev


def reverse_import_graph(zdir=None):
    """Return `{module_rel: set_of_transitively_dependent_rels}` for `zreflect/*.py`."""
    d = zdir if zdir is not None else gate.zdir()
    local_mods = _local_module_names(d)
    direct_rev = _direct_reverse_graph(d, local_mods)
    closure: dict[str, set[str]] = {}
    for src in direct_rev:
        seen = {src}
        stack = [src]
        while stack:
            cur = stack.pop()
            for nxt in direct_rev.get(cur, ()):
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append(nxt)
        closure[src] = seen
    return closure


def _split_list(val):
    return [_norm(x.strip()) for x in str(val or "").split(",") if x.strip()]


def _knob_paths(knob_values=None):
    def get(name):
        if knob_values is not None:
            return str(knob_values.get(name) or knobs.REGISTRY.get(name, ("", "", ""))[1] or "")
        return str(knobs.get(name) or "") if name in knobs.REGISTRY else ""
    qdir = _norm(get("REFLECT_QUESTIONS") or "questions").rstrip("/")
    hmode = "folder" if get("REFLECT_HISTORY_MODE").strip().lower() in knobs.HISTORY_FOLDER_MODES else "file"
    raw_h = knob_values.get("REFLECT_HISTORY") if knob_values is not None else knobs.raw("REFLECT_HISTORY")
    hpath = _norm(raw_h if (raw_h or "").strip() else ("HISTORY" if hmode == "folder" else knobs.REGISTRY["REFLECT_HISTORY"][1])).rstrip("/")
    return {
        "docs": set(_split_list(get("REFLECT_DOCS"))),
        "facts": _norm(get("REFLECT_FACTS") or "FACTS.json"),
        "retractions": _norm(get("REFLECT_RETRACTIONS") or "retractions.json"),
        "readmes": set(_split_list(get("REFLECT_READMES"))),
        "history": hpath,
        "history_mode": hmode,
        "history_prefix": (hpath + "/") if hpath else "",
        "questions_prefix": (qdir + "/") if qdir else "questions/",
        "secrets": _norm(get("REFLECT_SECRETS") or "secrets.json"),
        "lint_cfg": _norm(get("REFLECT_LINT_CONFIG") or "ruff.toml"),
    }


def _is_history_rel(rel, kp):
    return rel == kp["history"] or (kp["history_mode"] == "folder" and kp["history_prefix"] and rel.startswith(kp["history_prefix"]))


def _matches_knob(rel, gate_knobs, kp):
    set_knobs = (
        ("REFLECT_DOCS", kp["docs"]),
        ("REFLECT_READMES", kp["readmes"]),
    )
    eq_knobs = (
        ("REFLECT_FACTS", kp["facts"]),
        ("REFLECT_RETRACTIONS", kp["retractions"]),
        ("REFLECT_SECRETS", kp["secrets"]),
        ("REFLECT_LINT_CONFIG", kp["lint_cfg"]),
    )
    if any(k in gate_knobs and rel in paths for k, paths in set_knobs):
        return True
    if any(k in gate_knobs and rel == path for k, path in eq_knobs):
        return True
    if ("REFLECT_HISTORY" in gate_knobs or "REFLECT_HISTORY_MODE" in gate_knobs) and _is_history_rel(rel, kp):
        return True
    return "REFLECT_QUESTIONS" in gate_knobs and rel.startswith(kp["questions_prefix"])


def _is_global_fallback(rel):
    return rel in _GLOBAL_FALLBACK_FILES or any(rel.startswith(p) for p in _GLOBAL_FALLBACK_PREFIXES)


def _match_by_knobs(rel, phase_gates, kp):
    matched: set[str] = set()
    known = False
    is_secret_doc = (rel in kp["docs"] or rel.startswith(kp["questions_prefix"]) or _is_history_rel(rel, kp)
                     or rel in kp["readmes"] or rel in (kp["retractions"], kp["facts"]))
    for g in phase_gates:
        gfile = g["file"]
        base = os.path.basename(gfile)
        if _matches_knob(rel, set(g.get("knobs") or ()), kp):
            matched.add(gfile)
            known = True
        if base == "check_secrets.py" and is_secret_doc:
            matched.add(gfile)
        if base == "check_facts_replay.py" and (
                rel in (kp["facts"], "PRINCIPLES.md") or rel.startswith(kp["questions_prefix"])):
            matched.add(gfile)
            known = True
    return matched, known


def _match_non_py(rel, phase_gates, kp):
    if rel.endswith(".py"):
        py_gates = ("check_lint.py", "check_explain.py", "check_snapshots.py", "check_secrets.py")
        return {g["file"] for g in phase_gates if os.path.basename(g["file"]) in py_gates}, True
    if rel.startswith("zreflect/lang/") and rel.endswith(".json"):
        return {g["file"] for g in phase_gates}, True
    if rel.startswith("examples/"):
        return {g["file"] for g in phase_gates if os.path.basename(g["file"]) == "check_secrets.py"}, True
    return _match_by_knobs(rel, phase_gates, kp)


def _select_py_deps(rel, rev, gates_list, kp):
    key = "zreflect/facts.py" if (rel.startswith(("zreflect/measure_", "reflect-local/measure_"))) else rel
    out = set(rev.get(key, ())) | _match_non_py(rel, gates_list, kp)[0]
    if any(os.path.basename(f) == "check_facts_replay.py" for f in out):
        out.add("zreflect/check_facts_replay.py")
    return out


def _select_for_path(rel, rev, gates_list, kp):
    if _is_global_fallback(rel):
        return None, "global:%s" % rel
    if rel in ("SEAL.json", "zreflect/SEAL.json"):
        return set(rev.get("zreflect/trust.py", ())), None
    if rel in rev or (rel.startswith(("zreflect/measure_", "reflect-local/measure_")) and rel.endswith(".py")):
        return _select_py_deps(rel, rev, gates_list, kp), None
    matched, known = _match_non_py(rel, gates_list, kp)
    if not known:
        return None, "unmapped:%s" % rel
    return matched, None


def affected_plan(changed_paths, phase_gates, zdir=None, knob_values=None):
    """Pure mechanical selector: return `{full_fallback, reason, selected, total, changed_count}`."""
    gates_list = list(phase_gates or [])
    total = len(gates_list)
    if changed_paths is None:
        return {"full_fallback": True, "reason": "git_unavailable",
                "selected": gates_list, "total": total, "changed_count": 0}
    normed = [_norm(p) for p in changed_paths if _norm(p)]
    if not normed:
        return {"full_fallback": False, "reason": "no_changes",
                "selected": [], "total": total, "changed_count": 0}
    rev = reverse_import_graph(zdir)
    kp = _knob_paths(knob_values)
    selected_files: set[str] = set()
    for rel in normed:
        hit, fallback_reason = _select_for_path(rel, rev, gates_list, kp)
        if fallback_reason is not None:
            return {"full_fallback": True, "reason": fallback_reason,
                    "selected": gates_list, "total": total, "changed_count": len(normed)}
        selected_files |= hit
    selected = [g for g in gates_list if g["file"] in selected_files]
    return {"full_fallback": False, "reason": "impacted",
            "selected": selected, "total": total, "changed_count": len(normed)}


def _parse_porcelain(stdout):
    paths = []
    for ln in stdout.splitlines():
        if len(ln) < 4:
            continue
        entry = ln[3:].strip()
        if " -> " in entry:
            entry = entry.split(" -> ", 1)[1].strip()
        if entry:
            paths.append(_norm(entry))
    return paths


def git_changed_files(repo_root=None):
    """Collect changed paths from working tree (`git status --porcelain`), or `HEAD~1..HEAD` if clean.

    Returns `None` when `git` is unavailable or errors, triggering fail-closed full fallback.
    """
    root = repo_root if repo_root is not None else gate.GATE_REPO
    try:
        r = subprocess.run(["git", "-C", root, "status", "--porcelain", "-uall"],
                           capture_output=True, text=True, timeout=15,
                           encoding="utf-8", errors="replace")
        if r.returncode != 0:
            return None
        paths = _parse_porcelain(r.stdout)
        if paths:
            return paths
        for ref in ("@{upstream}", "origin/main", "origin/master"):
            up = subprocess.run(["git", "-C", root, "diff", "--name-only", f"{ref}..HEAD"],
                                capture_output=True, text=True, timeout=15,
                                encoding="utf-8", errors="replace")
            if up.returncode == 0:
                return [_norm(ln) for ln in up.stdout.splitlines() if ln.strip()]
        return None
    except (OSError, subprocess.TimeoutExpired):
        return None


def _cases():
    fake_gates = [
        {"file": "zreflect/check_questions.py", "knobs": ("REFLECT_QUESTIONS",)},
        {"file": "zreflect/check_facts.py", "knobs": ("REFLECT_FACTS", "REFLECT_DOCS")},
        {"file": "zreflect/check_stale.py", "knobs": ("REFLECT_DOCS", "REFLECT_FACTS")},
        {"file": "zreflect/check_lint.py", "knobs": ("REFLECT_LINT_CONFIG",)},
        {"file": "zreflect/check_readme_sync.py", "knobs": ("REFLECT_READMES",)},
        {"file": "zreflect/check_secrets.py", "knobs": ("REFLECT_SECRETS",)},
    ]
    z = gate.zdir()
    def names(plan):
        return [os.path.basename(g["file"]) for g in plan["selected"]]
    return [
        ("impact.question_only_scopes",
         lambda: not affected_plan(["questions/28-foo.md"], fake_gates, zdir=z)["full_fallback"]
                 and set(names(affected_plan(["questions/28-foo.md"], fake_gates, zdir=z)))
                 == {"check_questions.py", "check_secrets.py"}),
        ("impact.core_gate_py_fans_out",
         lambda: {"check_questions.py", "check_facts.py", "check_lint.py"}.issubset(
             set(names(affected_plan(["zreflect/gate.py"], fake_gates, zdir=z))))),
        ("impact.git_unavailable_full_fallback",
         lambda: affected_plan(None, fake_gates, zdir=z)["full_fallback"]
                 and len(affected_plan(None, fake_gates, zdir=z)["selected"]) == len(fake_gates)),
        ("impact.global_knobs_full_fallback",
         lambda: affected_plan(["knobs.json"], fake_gates, zdir=z)["full_fallback"]
                 and len(affected_plan(["knobs.json"], fake_gates, zdir=z)["selected"]) == len(fake_gates)),
        ("impact.unmapped_root_full_fallback",
         lambda: affected_plan(["Makefile"], fake_gates, zdir=z)["full_fallback"]),
        ("impact.clean_empty_list",
         lambda: not affected_plan([], fake_gates, zdir=z)["full_fallback"]
                 and affected_plan([], fake_gates, zdir=z)["selected"] == []),
        ("★ impact.measure_module_selects_facts_and_lint",
         lambda: {"check_facts.py", "check_lint.py", "check_secrets.py"}.issubset(
             set(names(affected_plan(["zreflect/measure_example.py"], fake_gates, zdir=z))))),
    ]


def main(argv):
    rc = gate.activate_or_fatal()
    if rc:
        return rc
    if "--selftest" in argv:
        return selftest(M("gate.title.registry"), _cases())
    changed = git_changed_files()
    import registry  # noqa: PLC0415
    gs = registry.runnable("commit")
    plan = affected_plan(changed, gs)
    print(M("registry.affected_plan", selected=len(plan["selected"]),
            total=plan["total"], reason=plan["reason"]))
    for g in plan["selected"]:
        print("  · %s" % g["file"])
    return 0


MODULE = module_meta("Affected gate selector",
                     "pure mechanical AST + knob impact planner (fail-closed)",
                     selftest=True)

if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
