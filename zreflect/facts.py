#!/usr/bin/env python3
"""Facts ledger, write guards, machine-block renderer, living-state extractor, and CLI."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gate  # noqa: E402
import knobs  # noqa: E402
import registry  # noqa: E402
from gate import fatal, fatal_exit, main_selftest_or, module_meta, repo  # noqa: E402
from i18n import M, Message  # noqa: E402

BLOCK_BEGIN = "<!-- AUTO:FACTS -->"
BLOCK_END = "<!-- /AUTO:FACTS -->"
PREAMBLE = [
    ("> This block is rendered by `zreflect/facts.py --render-doc` from"
     " `FACTS.json`; **do not edit by hand**"
     " (pre-commit recomputes and `git add`s it)."),
    ("> 'Measured numbers' in the prose are produced only here: to cite one, write"
     " `[[key]]`; never copy the number by hand."),
]

HIST_MARK = re.compile(
    r"历史|退役|留档|曾经的|当年的|当时的|之前那份|此前|当时|收口前"
    r"|已翻案|更正|是错的|误读|推翻|曾写|已作废|不再成立"
    r"|superseded|retracted|deprecated")
DATED_RECORD = re.compile(r"[A-Za-z0-9._-]*-\d{8}|`[0-9a-f]{7,64}`")
CITE_RE = re.compile(r"\[\[([A-Za-z_][A-Za-z0-9_]*)\]\]")

_COUNT_CMD = "python3 zreflect/facts.py --count"
_AUTO_BLOCK = re.compile(r"^\s*<!--\s*(/?AUTO:[A-Z]+)\s*-->\s*$")
_PROTECTED = ("value", "cmd", "calibrate", "calibrate_expect", "kind", "source", "first_seen")
_OWN_CODE_DIRS = ("src", "lib", "app", "pkg", "packages")


class Unreadable(RuntimeError):
    """Ledger exists on disk but could not be read or parsed."""


def load(path):
    """Load JSON ledger at `path`; raise `Unreadable` on I/O or decode failure."""
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, UnicodeError, ValueError) as e:
        raise Unreadable(path, e) from e


def load_or_fatal(path):
    """Load ledger at `path` or abort with `FATAL:` rc=2."""
    try:
        return load(path)
    except Unreadable as e:
        cause = e.args[1] if len(e.args) > 1 else e
        fatal_exit(M("ledger.unreadable_gate", name=path, error=cause))


def facts_of(ledger):
    """Extract facts dict from either `{facts: ...}` wrapper or bare table."""
    led = ledger or {}
    return led.get("facts") if isinstance(led, dict) and "facts" in led else (led or {})


def value_of(entry):
    """Extract scalar value from either a dict entry or bare scalar."""
    return entry.get("value") if isinstance(entry, dict) else entry


def short_value(v, n=24):
    """Format a scalar compactly (16 chars for 64-char hashes, `n` chars otherwise)."""
    s = v if isinstance(v, str) else str(v)
    if len(s) == 64:
        return s[:16] + "..."
    return s if len(s) <= n else s[:n] + "..."


def dropped_keys(old_facts, new_facts):
    """Sorted list of keys present in `old_facts` but missing from `new_facts`."""
    return sorted(set(old_facts or {}) - set(new_facts or {}))


def _first_diff(old_e, new_e):
    for fld in _PROTECTED:
        o = old_e.get(fld) if isinstance(old_e, dict) else (old_e if fld == "value" else None)
        n = new_e.get(fld) if isinstance(new_e, dict) else (new_e if fld == "value" else None)
        if o != n:
            return (o, n) if fld == "value" else (f"{fld}:{o}", f"{fld}:{n}")
    return None


def changed_keys(old_facts, new_facts):
    """List `(key, old, new)` for keys whose protected fields changed."""
    olds = old_facts or {}
    out = []
    for k, nv in sorted((new_facts or {}).items()):
        if k in olds:
            diff = _first_diff(olds[k], nv)
            if diff is not None:
                out.append((k, diff[0], diff[1]))
    return out


def fact(value, cmd, source, note="", calibrate=None, calibrate_expect=None, kind="value"):
    """Build a ledger fact dict enforcing paired `calibrate` / `calibrate_expect`."""
    if (calibrate is None) != (calibrate_expect is None):
        fatal_exit(M("ledger.shape_incomplete", name="calibrate"))
    d = {"value": value, "cmd": cmd, "source": source,
         "measured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
         "first_seen": time.strftime("%Y-%m-%d")}
    if note:
        d["note"] = note
    if calibrate is not None:
        d["calibrate"] = calibrate
        d["calibrate_expect"] = calibrate_expect
    if kind != "value":
        d["kind"] = kind
    return d


def age_days(entry):
    """Return fractional age in days from `measured_at`, or `None` if absent/invalid."""
    ts = entry.get("measured_at") if isinstance(entry, dict) else None
    if not ts:
        return None
    try:
        when = datetime.strptime(str(ts), "%Y-%m-%dT%H:%M:%S%z")
    except ValueError:
        return None
    return (datetime.now(timezone.utc) - when).total_seconds() / 86400.0


def section_is_living(heading, historical_secs=()):
    """Return True if a `## ` section is living state (only `historical_secs` exempt)."""
    m = re.match(r"^##\s+([0-9]+)", heading)
    if m:
        return m.group(1) not in {str(s) for s in historical_secs}
    return True


def living_lines(text, historical_secs=()):
    """Yield `(lineno, line, is_living)` tags across `text`."""
    out, keep = [], True
    for i, ln in enumerate(text.split("\n"), 1):
        if re.match(r"^##\s+", ln):
            keep = section_is_living(ln, historical_secs)
        elif re.match(r"^#\s+", ln):
            keep = True
        out.append((i, ln, keep))
    return out


def write_target_problems(path, ignored=None):
    """Check whether ledger write target `path` is gitignored (`(fatal_msg, warn_msg)`)."""
    if ignored is None:
        try:
            r = subprocess.run(["git", "-C", gate.GATE_REPO, "check-ignore", "-q", path],
                               capture_output=True)
            ig = True if r.returncode == 0 else (False if r.returncode == 1 else None)
        except OSError:
            ig = None
    else:
        ig = ignored
    if ig is True:
        return M("guard.write_target_gitignored", path=path), None
    if ig is None:
        return None, M("guard.write_target_no_git")
    return None, None


def accepted_keys(argv):
    """Parse `--accept-changes[=k1,k2]` into `None` (all), `set`, or `False` (none)."""
    for a in argv or []:
        if a == "--accept-changes":
            return None
        if a.startswith("--accept-changes="):
            return {k.strip() for k in a.split("=", 1)[1].split(",") if k.strip()}
    return False


def decide(old_facts, new_facts, accepted=False, allow_drop=False):
    """Evaluate drop and change guards; return `('write'|'refuse', problems, notes)`."""
    notes: dict[str, list[Message]] = {"err": [], "out": []}
    dropped = dropped_keys(old_facts, new_facts)
    if dropped and not allow_drop:
        return "refuse", [M("guard.refuse_dropped", count=len(dropped), keys=", ".join(dropped)),
                          M("guard.refuse_dropped_advice")], notes
    if dropped:
        notes["err"].append(M("guard.note_allow_drop", count=len(dropped),
                              keys=", ".join(dropped)))
    changed = changed_keys(old_facts, new_facts)
    remaining = ([] if accepted is None else list(changed) if accepted is False
                 else [c for c in changed if c[0] not in accepted])
    if remaining:
        probs = [M("guard.refuse_changed", count=len(remaining))] + [
            M("guard.changed_row", key=k, before=short_value(o), after=short_value(n))
            for k, o, n in remaining]
        if accepted:
            probs.append(M("guard.accepted_boundary", accepted=len(changed) - len(remaining),
                           keys=", ".join(sorted(accepted))))
        return "refuse", probs + [M("guard.refuse_changed_advice")], notes
    if changed:
        notes["out"].append(M("guard.note_accept_changes", count=len(changed)))
        notes["out"] += [M("guard.changed_row", key=k, before=short_value(o),
                           after=short_value(n)) for k, o, n in changed]
    if not new_facts:
        return "refuse", [M("guard.empty_ledger")], notes
    return "write", [], notes


def _fmt(v):
    if isinstance(v, str) and len(v) == 64:
        return "`%s...`" % v[:16]
    return "**%s**" % (v if isinstance(v, str) else str(v))


def render_block(ledger):
    """PINNED: render fixed-language `AUTO:FACTS` Markdown block from `ledger`."""
    f = facts_of(ledger)
    lines = [BLOCK_BEGIN] + list(PREAMBLE) + [""]
    if not f:
        lines += ["**The ledger is empty** -- first check whether measure() is broken.", ""]
    else:
        lines += ["| key | value | measured at | replay cmd |", "|---|---|---|---|"]
        for k in sorted(f):
            e = f[k] if isinstance(f[k], dict) else {"value": f[k]}
            lines.append("| `%s` | %s | %s | `%s` |"
                         % (k, _fmt(e.get("value")), e.get("measured_at", "--"), e.get("cmd", "?")))
        lines += ["", "%d facts." % len(f)]
    lines.append(BLOCK_END)
    return "\n".join(lines)


def body_of(block):
    """Return slice between `BLOCK_BEGIN` and `BLOCK_END`."""
    return block.split(BLOCK_BEGIN, 1)[1].split(BLOCK_END, 1)[0] if BLOCK_BEGIN in block else ""


_KNOWN_AUTO = ("<!-- AUTO:FACTS -->", "<!-- AUTO:GATES -->", "<!-- AUTO:RULES -->")


def prose_of(doc_text):
    """Strip known `AUTO:FACTS` / `AUTO:GATES` / `AUTO:RULES` machine blocks from `doc_text`."""
    out, i = [], 0
    while i < len(doc_text):
        hits = [(doc_text.find(b, i), b) for b in _KNOWN_AUTO if doc_text.find(b, i) >= 0]
        if not hits:
            out.append(doc_text[i:])
            break
        b, tag = min(hits)
        out.append(doc_text[i:b])
        end_tag = tag.replace("<!-- AUTO:", "<!-- /AUTO:")
        end = doc_text.find(end_tag, b + len(tag))
        if end < 0:
            out.append(doc_text[b:])
            break
        i = end + len(end_tag)
    return "".join(out)


def _out():
    return repo(knobs.get("REFLECT_FACTS"))


def _doc():
    import doc  # noqa: PLC0415
    return doc.state_name()


def count_files(root, suffix):
    """Count files ending in `suffix` under `root` (skipping `.git`)."""
    n = 0
    for _dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d != ".git")
        n += sum(1 for f in filenames if f.endswith(suffix))
    return n


def count_lines(root, suffix):
    """Total line count across files ending in `suffix` under `root`."""
    total = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d != ".git")
        for name in sorted(filenames):
            if not name.endswith(suffix):
                continue
            try:
                total += sum(1 for _ in open(os.path.join(dirpath, name),
                                             encoding="utf-8", errors="replace"))
            except OSError:
                continue
    return total


def _count_file_lines(path):
    total, in_block = 0, False
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                m = _AUTO_BLOCK.match(line)
                if m:
                    in_block = not m.group(1).startswith("/")
                    continue
                if not in_block:
                    total += 1
    except OSError:
        return 0
    return total


def count_md_lines(root):
    """Total Markdown lines excluding `AUTO:*` machine blocks."""
    total = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d != ".git")
        total += sum(_count_file_lines(os.path.join(dirpath, name))
                     for name in sorted(filenames) if name.endswith(".md"))
    return total


def measure_example():
    """Default placeholder collector (`py_files`, `md_files`, `py_lines`, `md_lines`)."""
    facts = {}
    n_py = count_files(gate.GATE_REPO, ".py")
    n_md = count_files(gate.GATE_REPO, ".md")
    facts["py_files"] = fact(n_py, "%s -files .py" % _COUNT_CMD, "repo",
                             M("facts.note.example_fact"))
    facts["md_files"] = fact(n_md, "%s -files .md" % _COUNT_CMD, "repo")
    facts["py_lines"] = fact(count_lines(gate.GATE_REPO, ".py"), "%s -lines .py" % _COUNT_CMD,
                             "repo", M("facts.note.bare_number_demo"))
    facts["md_lines"] = fact(count_md_lines(gate.GATE_REPO), "%s -md" % _COUNT_CMD, "repo",
                             M("facts.note.excludes_machine_block"))
    v = os.environ.get("UPSTREAM_VERSION", "").strip()
    if v:
        facts["upstream_version"] = fact(v, "echo \"$UPSTREAM_VERSION\"", "env",
                                         M("facts.note.measure_or_omit"))
    return facts


def block_homes(ledger):
    """Map documents to their owned `(begin, end, expected_text)` machine blocks."""
    import doc  # noqa: PLC0415
    gs, missing = registry.gates()
    probs = registry.problems(gs, missing) + doc.local_rules_problems()
    if probs:
        return None, M("facts.registry_mismatch", entries="\n  · ".join(probs))
    homes = [(doc.state_name(), [(BLOCK_BEGIN, BLOCK_END, render_block(ledger)),
                                 (registry.GATES_BEGIN, registry.GATES_END,
                                  registry.render_gates(gs))])]
    if doc.accepts_principles():
        homes.append((doc.PRINCIPLES, [(doc.RULES_BEGIN, doc.RULES_END, doc.render_rules())]))
    return homes, None


def doc_block_problems(path_rel, text, blocks):
    """Compare `(begin, end, expected)` blocks against document `text`."""
    out = []
    for begin, end, expected in blocks:
        if begin not in text or end not in text:
            out.append(M("facts.markers_missing_check", path=path_rel, begin=begin, end=end))
        else:
            actual = text.partition(begin)[2].partition(end)[0].strip()
            want = expected.partition(begin)[2].partition(end)[0].strip()
            if actual != want:
                out.append(M("facts.block_stale", path=path_rel, begin=begin))
    return out


def _doc_names():
    import doc  # noqa: PLC0415
    return tuple([_doc()] + ([doc.PRINCIPLES] if doc.accepts_principles() else []))


def _read_doc(p, path_rel):
    try:
        return open(p, encoding="utf-8").read(), 0
    except (OSError, UnicodeError) as e:
        return None, fatal(M("facts.doc_unreadable", path=path_rel, error=e))


def _own_blocks(path_rel, ledger, homes=None):
    if homes is None:
        homes, err = block_homes(ledger)
        if err:
            return None, fatal(err)
    mine = [b for name, blks in homes if name in (os.path.basename(path_rel), path_rel)
            for b in blks]
    if mine:
        return mine, 0
    return None, fatal(M("facts.doc_has_no_home", path=path_rel,
                         known=", ".join(name for name, _ in homes)))


def _splice_blocks(path_rel, new, blocks):
    """Replace each block inside `new`, or return `(None, 2)` on marker corruption."""
    for begin, end, body in blocks:
        if begin not in new or end not in new:
            return None, fatal(M("facts.markers_missing_render",
                                 path=path_rel, begin=begin, end=end))
        pre, _, rest = new.partition(begin)
        new = pre + body + rest.partition(end)[2]
    if any(b not in new or e not in new for b, e, _ in blocks):
        return None, fatal(M("facts.marker_swallowed_body",
                             path=path_rel, begin=blocks[0][0]))
    return new, 0


def write_doc(path_rel, ledger, homes=None):
    """Replace owned machine blocks inside `path_rel`; never silently append missing markers."""
    p = gate.repo_path(path_rel)
    if not os.path.exists(p):
        return fatal(M("facts.doc_missing_render", path=p))
    blocks, rc = _own_blocks(path_rel, ledger, homes)
    if rc:
        return rc
    old, rc = _read_doc(p, path_rel)
    if rc:
        return rc
    new, rc = _splice_blocks(path_rel, old, blocks)
    if rc:
        return rc
    if new == old:
        print(M("facts.render_unchanged", path=path_rel))
        return 0
    try:
        open(p, "w", encoding="utf-8").write(new)
    except OSError as e:
        return fatal(M("facts.doc_unwritable", path=path_rel, error=e))
    print(M("facts.render_written", path=path_rel))
    return 0


def check_doc(path_rel, ledger, homes=None):
    """Verify machine blocks in `path_rel` match `ledger`."""
    p = gate.repo_path(path_rel)
    if not os.path.exists(p):
        return fatal(M("facts.doc_missing_check", path=p))
    blocks, rc = _own_blocks(path_rel, ledger, homes)
    if rc:
        return rc
    text, rc = _read_doc(p, path_rel)
    if rc:
        return rc
    probs = doc_block_problems(path_rel, text, blocks)
    if probs:
        if probs[0].code == "facts.markers_missing_check":
            return fatal(probs[0])
        for prob in probs:
            print(prob, file=sys.stderr)
        return 1
    print(M("facts.block_consistent", path=path_rel))
    return 0


def _age_human(entry):
    d = age_days(entry)
    if d is None:
        return M("facts.age.unrecorded")
    return M("facts.age.today") if d < 1 else M("facts.age.days_ago", days=int(d))


def _run_external_measure(mod_name, rz):
    import subprocess  # noqa: PLC0415
    code = (
        f"import json, sys; sys.path.insert(0, {rz!r}); "
        f"import {mod_name} as m; print(json.dumps(m.measure()))"
    )
    proc = subprocess.run([sys.executable, "-c", code], cwd=gate.GATE_REPO,
                          capture_output=True, text=True, timeout=60, check=False,
                          encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or f"rc={proc.returncode}").strip())
    return json.loads(proc.stdout)


def _measure():
    mod_name = (knobs.raw("REFLECT_MEASURE_MODULE") or "").strip()
    if not mod_name:
        fatal_exit(M("facts.measure_module_missing"))
    if mod_name == "measure_example":
        return measure_example()
    local_dir = os.path.join(gate.GATE_REPO, knobs.get("REFLECT_LOCAL_DIR") or "reflect-local")
    rz = os.path.join(gate.GATE_REPO, "zreflect")
    try:
        local_path = os.path.join(local_dir, mod_name + ".py")
        if os.path.isfile(local_path):
            return _run_external_measure(mod_name, local_dir)
        import trust  # noqa: PLC0415
        mod_path = os.path.join(rz, mod_name + ".py")
        if os.path.isfile(mod_path) and not trust.is_sealed_target(mod_path, root=gate.GATE_REPO, zdir=rz):
            return _run_external_measure(mod_name, rz)
        if os.path.isdir(rz) and rz not in sys.path:
            sys.path.insert(0, rz)
        _m = __import__(mod_name)
        fn = getattr(_m, "measure")   # noqa: B009
    except Exception as e:                            # noqa: BLE001
        fatal_exit(M("facts.measure_module_unusable", module=mod_name,
                     error=repr(e), hint=M("facts.measure_module_where")))
    return fn()


def _attach_core_seal(facts):
    import trust  # noqa: PLC0415
    if not trust.seal_exists() and not os.path.isfile(os.path.join(gate.zdir(), "trust.py")):
        return 0
    probs = trust.verify_problems()
    if probs:
        return fatal(probs[0])
    sha = trust.current_tree_sha(verified=True)
    if sha:
        facts["core_seal"] = fact(sha, "python3 zreflect/registry.py --verify-seal",
                                  "seal", M("facts.note.core_seal"))
    return 0


def _write_ledger_doc(out, facts):
    doc = {"schema": 1, "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
           "_why": M("facts.ledger_why"), "facts": facts}
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=1, ensure_ascii=False)
        fh.write("\n")


def _write_guarded(out, old, facts, argv, accept_all=False):
    accepted = None if accept_all else accepted_keys(argv)
    verdict, probs, notes = decide(old, facts, accepted=accepted, allow_drop="--allow-drop" in argv)
    for x in notes["err"]:
        print("WARN: %s" % x, file=sys.stderr)
    for x in notes["out"]:
        print(x)
    if verdict == "refuse":
        for x in probs:
            fatal(x)
        return 2
    fatal_w, warn_w = write_target_problems(out)
    if warn_w:
        print("WARN: %s" % warn_w, file=sys.stderr)
    if fatal_w:
        return fatal(fatal_w)
    _write_ledger_doc(out, facts)
    return 0


def measure(argv):
    """Run measurement collector, check guards, preserve `first_seen`, and write ledger."""
    facts = _measure()
    if not isinstance(facts, dict) or not facts:
        return fatal(M("guard.empty_ledger"))
    if _attach_core_seal(facts):
        return 2
    bad = sorted(k for k, v in (facts or {}).items() if not (isinstance(v, dict) and "value" in v))
    if bad:
        return fatal(M("facts.measure_bad_shape", count=len(bad),
                       keys=", ".join(bad[:6]), hint=M("facts.measure_shape_hint")))
    out = _out()
    old = facts_of(load_or_fatal(out)) if os.path.exists(out) else {}
    for k, entry in facts.items():
        prior = old.get(k)
        fs = prior.get("first_seen") if isinstance(prior, dict) else None
        if fs and value_of(prior) == value_of(entry):
            entry["first_seen"] = fs
    if _write_guarded(out, old, facts, argv):
        return 2
    print(M("facts.measure_written", path=os.path.relpath(out, gate.GATE_REPO), count=len(facts)))
    for k, v in sorted(facts.items()):
        print("  %-20s %s (%s)" % (k, v["value"], _age_human(v)))
    return 0


def _facts_with_principles(led):
    import doc  # noqa: PLC0415
    f = dict(facts_of(led))
    if doc.accepts_principles():
        f.update(doc.facts_of_rules())
    return f


def get_value(led, key):
    """Return `(found?, value_or_error_message)` across ledger and active principles."""
    f = _facts_with_principles(led)
    if key not in f:
        return False, M("facts.unknown_key", key=key,
                        existing=", ".join(sorted(f)) or M("facts.none"))
    return True, value_of(f[key])


def _load_or_die():
    out = _out()
    if not os.path.exists(out):
        fatal_exit(M("facts.no_ledger_yet", name=os.path.basename(out),
                     path=os.path.relpath(out, gate.GATE_REPO)))
    return load_or_fatal(out)


def cmd_render(argv):
    _ = argv
    sys.stdout.write(render_block(_load_or_die()) + "\n")
    return 0


def cmd_render_doc(argv):
    led = _load_or_die()
    homes, err = block_homes(led)
    if err:
        return fatal(err)
    targets = [argv[1]] if len(argv) > 1 else list(_doc_names())
    rc = 0
    for name in targets:
        rc = write_doc(name, led, homes=homes) or rc
    return rc


def cmd_check(argv):
    led = _load_or_die()
    homes, err = block_homes(led)
    if err:
        return fatal(err)
    targets = [argv[1]] if len(argv) > 1 else list(_doc_names())
    rc = 0
    for name in targets:
        rc = check_doc(name, led, homes=homes) or rc
    return rc


def cmd_get(argv):
    if len(argv) < 2:
        return fatal(M("facts.get_needs_key"))
    ok, v = get_value(_load_or_die(), argv[1])
    if not ok:
        return fatal(v)
    print(v)
    return 0


def _init_skeleton(root, state):
    import doc  # noqa: PLC0415
    retract_name = knobs.get("REFLECT_RETRACTIONS")
    readme_name = (knobs.readme_names() or ["README.md"])[0]
    sk = {
        state: ("# " + state + "\n\n"
                "> live state: cite ledger values with double brackets (keys from FACTS.json) "
                "here in the intro blockquote.\n"
                "> Everything below is rendered from `FACTS.json` by `facts.py --render-doc`.\n\n"
                + BLOCK_BEGIN + "\n" + BLOCK_END + "\n\n"
                + registry.GATES_BEGIN + "\n" + registry.GATES_END + "\n"),
        doc.PRINCIPLES: ("# PRINCIPLES\n\n"
                         "> design rules rendered by `facts.py --render-doc`.\n\n"
                         + doc.RULES_BEGIN + "\n" + doc.RULES_END + "\n"),
        retract_name: '{"schema": 1, "retractions": []}\n',
        knobs.get("REFLECT_SECRETS"): json.dumps({
            "paths": ["."],
            "ignore_paths": [],
            "allow": [
                {"path": "zreflect/check_secrets.py", "rule": r,
                 "reason": "selftest fixture in suite"}
                for r in ("aws-access-key", "generic-secret", "private-key", "jwt", "url-credentials")
            ],
        }, indent=2) + "\n",
        readme_name: ("# " + os.path.basename(root) + "\n\n"
                      "> Project documentation.\n"),
        "AGENTS.md": ("# AGENTS.md\n\nRouting only. Rules live in `PRINCIPLES.md`; "
                      "measured state lives in `" + state + "`.\n\n```bash\n"
                      "python3 zreflect/registry.py --run commit\npython3 zreflect/harness.py\n```\n"),
        knobs.CONFIG_NAME: json.dumps({
            "REFLECT_MEASURE_MODULE": "measure_example",
            "REFLECT_OFF_GATES": ("check_ab.py,check_instruments.py,check_invariants.py,"
                                  "check_locks.py,check_pins.py,check_right.py,check_world.py,doctor.py"),
            **({"REFLECT_HISTORY_MODE": "fold"} if knobs.history_mode(root) == "folder" else {}),
        }, indent=2) + "\n",
    }
    if knobs.history_mode(root) != "folder":
        history_name = knobs.history_target_name(root) or knobs.REGISTRY["REFLECT_HISTORY"][1]
        sk[history_name] = ("# " + history_name + "\n\n"
                            "> Append-only provenance narrative (kept off every scan surface).\n\n"
                            "## Entries\n")
    return sk


def _create_missing(root, files):
    created: list[str] = []
    kept: list[str] = []
    for name, body in files.items():
        p = os.path.join(root, name)
        (kept if os.path.exists(p) else created).append(name)
        if not os.path.exists(p):
            open(p, "w", encoding="utf-8").write(body)
    return created, kept


def _init_questions_dir(root):
    qdir = knobs.questions_path(root)
    if not os.path.isdir(qdir):
        os.makedirs(qdir, exist_ok=True)
        print(str(M("facts.init_created", name="questions/")))
    if [n for n in os.listdir(qdir) if n.endswith(".md")]:
        return
    with open(os.path.join(qdir, "01-example.md"), "w", encoding="utf-8") as fh:
        fh.write("# Example open question\n\n**Status:** resolved\n\n"
                 "**Settling:** `python3 -c \"raise SystemExit(0)\"` "
                 "-- rc=0 settles A; rc=1 settles B\n\n"
                 "Template open question (replace or add new `NN-slug.md` files as needed).\n")


def _init_history_dir(root):
    if knobs.history_mode(root) != "folder":
        return
    rel = knobs.history_target_name(root)
    hdir = os.path.join(root, rel)
    if not os.path.isdir(hdir):
        os.makedirs(hdir, exist_ok=True)
        print(str(M("facts.init_created", name=rel.rstrip("/") + "/")))
    if [n for n in os.listdir(hdir) if n.lower().endswith(".md")]:
        return
    with open(os.path.join(hdir, "01-history.md"), "w", encoding="utf-8") as fh:
        fh.write("# HISTORY\n\n> Append-only provenance narrative (kept off every scan surface).\n")


def cmd_init(argv):
    _ = argv
    import doc  # noqa: PLC0415
    root = gate.GATE_REPO
    created, kept = _create_missing(root, _init_skeleton(root, doc.state_name()))
    for name in created:
        print(str(M("facts.init_created", name=name)))
    for name in kept:
        print(str(M("facts.init_kept", name=name)))
    if (doc.accepts_principles() and doc.PRINCIPLES in created
            and write_doc(doc.PRINCIPLES, {"schema": 1, "facts": {}}) != 0):
        return 2
    _init_questions_dir(root)
    _init_history_dir(root)
    import shutil  # noqa: PLC0415

    import trust  # noqa: PLC0415
    ldir_name = trust.local_dir_name(root)
    dst_hook = os.path.join(root, ldir_name, "hook.py")
    src_hook = os.path.join(gate.tool_repo(), "reflect-local", "hook.py")
    if not os.path.isfile(dst_hook) and os.path.isfile(src_hook):
        os.makedirs(os.path.dirname(dst_hook), exist_ok=True)
        shutil.copy2(src_hook, dst_hook)
        print(str(M("facts.init_created", name=ldir_name + "/hook.py")))
    if trust.init_anchors(root) == 0:
        print(str(M("facts.init_created", name=trust.ANCHORS_FILE)))
    if created:
        print(str(M("facts.init_next")))
    return 0


def cmd_accept(argv):
    if len(argv) < 5 or not argv[1] or not argv[3].strip():
        return fatal(M("facts.accept_usage"))
    if "|" in argv[1] or "\n" in argv[1] or "|" in argv[2] or "\n" in argv[2]:
        return fatal(M("facts.accept_bad_value", key=argv[1]))
    probs = gate.prose_in_exec_problems("accept/%s" % argv[1], "cmd", argv[3])
    if probs:
        return fatal(probs[0])
    rc_cmd, actual = gate.run_cmd(argv[3])
    if rc_cmd is None or rc_cmd != 0:
        return fatal(M("facts.accept_cmd_failed", key=argv[1], rc=str(rc_cmd), cmd=argv[3][:60]))
    raw_val = argv[2]
    val = int(raw_val) if re.fullmatch(r"-?\d+", raw_val) else raw_val
    if actual.strip() != str(val):
        return fatal(M("facts.accept_value_mismatch", key=argv[1], expected=str(val), actual=actual.strip()[:60]))
    out = _out()
    led = load_or_fatal(out) if os.path.exists(out) else {"schema": 1, "facts": {}}
    old = facts_of(led)
    new = dict(old)
    new[argv[1]] = fact(val, argv[3], argv[4])
    rc = _write_guarded(out, old, new, argv, accept_all=True)
    if rc == 0:
        print(M("facts.measure_written", path=os.path.relpath(out, gate.GATE_REPO), count=len(new)))
    return rc


def cmd_show(argv):
    f = _facts_with_principles(_load_or_die())
    keys = [argv[1]] if len(argv) > 1 else sorted(f)
    rc = 0
    for k in keys:
        if k not in f:
            print(M("facts.show_unknown_key", key=k, existing=", ".join(sorted(f))), file=sys.stderr)
            rc = 1
            continue
        e = f[k] if isinstance(f[k], dict) else {"value": f[k]}
        print("%-20s %s" % (k, e.get("value")))
        print(M("facts.show.source", value=e.get("source", "?")))
        print(M("facts.show.cmd", value=e.get("cmd", "?")))
        if e.get("note"):
            print(M("facts.show.note", value=e["note"]))
    return rc


def cmd_count(argv):
    rest = argv[1:]
    if rest == ["-md"]:
        print(count_md_lines(gate.GATE_REPO))
        return 0
    if len(rest) == 2 and rest[0] in ("-files", "-lines"):
        print((count_files if rest[0] == "-files" else count_lines)(gate.GATE_REPO, rest[1]))
        return 0
    print(M("facts.count_usage"), file=sys.stderr)
    return 2


_COMMANDS = {
    "--render": cmd_render, "--render-doc": cmd_render_doc, "--check": cmd_check,
    "--get": cmd_get, "--init": cmd_init, "--accept": cmd_accept,
    "show": cmd_show, "--count": cmd_count,
}


def _is_measure_flags(argv):
    return all(a == "--allow-drop" or a == "--accept-changes" or a.startswith("--accept-changes=")
               for a in argv)


def main(argv):
    """Dispatch `facts.py` CLI arguments (`measure` when empty or modifier-only)."""
    if not argv or _is_measure_flags(argv):
        return measure(argv)
    if argv[0] in ("--help", "-h", "help"):
        print(M("facts.usage"), file=sys.stderr)
        return 0
    if argv[0] in _COMMANDS:
        return _COMMANDS[argv[0]](argv)
    return fatal(M("facts.unknown_command", command=argv[0]))


def fixture_env(extra=None):
    """Clean subprocess env stripping inherited `REFLECT_*` and `GATE_REPO`."""
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("REFLECT_") and k != "GATE_REPO"}
    if extra:
        env.update(extra)
    return env


def _with_temp_repo(fn):
    import tempfile  # noqa: PLC0415
    saved = gate.GATE_REPO
    with tempfile.TemporaryDirectory() as d:
        gate.GATE_REPO = d
        try:
            return fn(d)
        finally:
            gate.GATE_REPO = saved


def _unwritable_doc_ok(state_path):
    """Verify `write_doc` returns 2 on write OSError (via chmod, or guarded open as root)."""
    if getattr(os, "geteuid", lambda: 1)() != 0:
        os.chmod(state_path, 0o444)
        try:
            return write_doc("STATE.md", {"facts": {"a": 1}}) == 2
        finally:
            os.chmod(state_path, 0o644)
    import builtins  # noqa: PLC0415
    from unittest.mock import patch  # noqa: PLC0415
    real_open = builtins.open
    target = os.path.abspath(state_path)

    def _ro_open(file, mode="r", *args, **kwargs):
        if "w" in mode and os.path.abspath(str(file)) == target:
            raise PermissionError(13, target)
        return real_open(file, mode, *args, **kwargs)

    with patch("builtins.open", _ro_open):
        return write_doc("STATE.md", {"facts": {"a": 1}}) == 2


def _inproc_bootstrap_ok(d):
    import contextlib  # noqa: PLC0415
    import io  # noqa: PLC0415
    subprocess.run(["git", "init", "-q", d], check=True, capture_output=True)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        if cmd_init([]) != 0 or measure(["--accept-changes"]) != 0:
            return False
        if cmd_render_doc([]) != 0 or cmd_check([]) != 0:
            return False
        led = load_or_fatal(_out())
        if cmd_accept(["--accept", "manual_n", "250", "echo 250", "cli"]) != 0:
            return False
        if cmd_accept(["--accept", "bad_n", "42", "echo 99", "cli"]) != 2:
            return False
        if cmd_accept(["--accept", "bad_cmd", "42", "prose command", "cli"]) != 2:
            return False
        if load_or_fatal(_out())["facts"]["manual_n"]["value"] != 250:
            return False
        if cmd_render_doc([]) != 0:
            return False
        unwritable = _unwritable_doc_ok(os.path.join(d, "STATE.md"))
        os.remove(os.path.join(d, "PRINCIPLES.md"))
        os.environ["REFLECT_NO_PRINCIPLES"] = "1"
        try:
            opt_out = (cmd_check([]) == 0)
        finally:
            os.environ.pop("REFLECT_NO_PRINCIPLES", None)
        open(os.path.join(d, "STATE.md"), "w", encoding="utf-8").write("plain text\n")
        err_buf = io.StringIO()
        with contextlib.redirect_stderr(err_buf):
            mk_rc = check_doc("STATE.md", led)
        no_markers = (mk_rc == 2 and ("facts.markers_missing_check" in err_buf.getvalue()
                                      or "AUTO:FACTS" in err_buf.getvalue()))
        open(os.path.join(d, "STATE.md"), "w", encoding="utf-8").write(
            "<!-- AUTO:FACTS -->\nstale\n<!-- /AUTO:FACTS -->\n"
            "<!-- AUTO:GATES -->\nstale\n<!-- /AUTO:GATES -->\n")
        stale_buf = io.StringIO()
        with contextlib.redirect_stderr(stale_buf):
            stale_rc = check_doc("STATE.md", led)
        stale_ok = (stale_rc == 1 and "FATAL:" not in stale_buf.getvalue())
    return unwritable and no_markers and opt_out and stale_ok


def _quiet(fn):
    import contextlib  # noqa: PLC0415
    import io  # noqa: PLC0415
    with contextlib.redirect_stderr(io.StringIO()):
        return fn()


def _cases():
    return [
        ("★ ledger.dropped_refused_unless_allowed",
         lambda: decide({"a": 1, "b": 2}, {"a": 1})[0] == "refuse"
         and decide({"a": 1, "b": 2}, {"a": 1}, allow_drop=True)[0] == "write"),
        ("★ ledger.changed_refused_unless_accepted",
         lambda: decide({"a": {"value": 1, "cmd": "c"}}, {"a": {"value": 2, "cmd": "c"}})[0] == "refuse"
         and decide({"a": {"value": 1, "cmd": "c"}}, {"a": {"value": 2, "cmd": "c"}},
                    accepted={"a"})[0] == "write"),
        ("★ ledger.empty_refused", lambda: decide({"a": 1}, {}, allow_drop=True)[0] == "refuse"),
        ("★ ledger.calibrate_requires_pair",
         lambda: gate.raises(lambda: fact(1, "c", "s", calibrate="echo 1"))),
        ("★ ledger.gitignored_refused",
         lambda: write_target_problems("x.json", ignored=True)[0] is not None),
        ("★ facts.corrupt_load_is_fatal",
         lambda: _quiet(lambda: _with_temp_repo(lambda d: (
             open(os.path.join(d, "bad.json"), "w", encoding="utf-8").write("{bad"),
             gate.raises(lambda: load_or_fatal(os.path.join(d, "bad.json"))))[1]))),
        ("★ living.sections_and_appendix",
         lambda: section_is_living("## 5 old", ("5",)) is False
         and section_is_living("## 6 new", ("5",)) is True
         and section_is_living("## " + chr(0x9644)) is True),
        ("facts.render_and_prose_roundtrip",
         lambda: BLOCK_BEGIN in render_block({"facts": {"n": {"value": 1, "cmd": "c"}}})
         and prose_of("x<!-- AUTO:FACTS -->y<!-- /AUTO:FACTS -->").strip() == "x"),
        ("facts.block_homes_present",
         lambda: len(block_homes({"facts": {"a": {"value": 1, "cmd": "c"}}})[0] or ()) >= 1),
        ("facts.get_and_age",
         lambda: get_value({"facts": {"n": {"value": 12, "cmd": "c"}}}, "n") == (True, 12)
         and not get_value({"facts": {"n": 1}}, "zzz")[0]
         and _age_human({"value": 1}).code == "facts.age.unrecorded"
         and _age_human({"measured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}).code == "facts.age.today"),
        ("★ facts.unknown_cmd_is_2_and_help_is_0",
         lambda: _quiet(lambda: main(["--help"]) == 0 and main(["--bogus-cmd-xyz"]) == 2)),
        ("★ facts.inproc_bootstrap_unwritable_markers_optout",
         lambda: _with_temp_repo(_inproc_bootstrap_ok)),
    ]


MODULE = module_meta("Facts ledger CLI", "ledger, guards, renderer, living-state, CLI", selftest=True)

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], M("gate.title.facts_cli"), _cases, main))
