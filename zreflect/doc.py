#!/usr/bin/env python3
"""Principles registry (`RULES`) and `AUTO:RULES` renderer for `PRINCIPLES.md`."""
from __future__ import annotations

import json
import os
import re
import sys
import time
from typing import NamedTuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gate  # noqa: E402
import i18n  # noqa: E402
import knobs  # noqa: E402
from gate import main_selftest_or, module_meta  # noqa: E402


class Rule(NamedTuple):
    """One architectural principle: sentence (`text`) + runnable command (`cmd`)."""
    id: str
    text: str
    cmd: str


def enforced_by(script):
    """Run enforcing gate `script` and verify it is active (not OFF) and passes."""
    import registry  # noqa: PLC0415
    gs, _m = registry.gates()
    hits = [g["file"] for g in gs if os.path.basename(g["file"]) == script]
    if not hits:
        print("missing_gate=%s" % script)
        return 1
    res = gate.run_phase("commit", [{"file": hits[0], "runs_at": None}], repo_root=gate.GATE_REPO)
    if res["off"]:
        print("off_gate=%s" % script)
        return 1
    if res["failed"] or res["fatal"] or res["error"]:
        print("failed_gate=%s" % script)
        return 1
    print("enforced_by=%s" % hits[0])
    return 0


def _read_json_checked(path):
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        return (data if isinstance(data, dict) else {}), None
    except (OSError, ValueError) as exc:
        return None, str(exc)


def _question_exec_problems(qdir):
    import glob  # noqa: PLC0415

    import check_questions  # noqa: PLC0415
    out: list[i18n.Message] = []
    if not qdir or not os.path.isdir(qdir):
        return out
    for qp in sorted(glob.glob(os.path.join(qdir, "*.md")), key=check_questions.sort_key):
        with open(qp, encoding="utf-8", errors="replace") as fh:
            body = fh.read()
        sv = check_questions.field(body, "Settling")
        if sv and not sv.strip().lower().startswith(check_questions.NONE_LIKE):
            out += gate.prose_in_exec_problems(os.path.basename(qp), "Settling", sv)
    return out


def all_exec_position_problems(root=None):
    """Collect prose-in-command errors across `world.json`, `pins.json`, `retractions.json`, `questions/*.md`."""
    base = root or gate.GATE_REPO
    out = []
    for knob_key, name in (("REFLECT_WORLD", "world.json"), ("REFLECT_PINS", "pins.json")):
        p = knobs.repo_path(knob_key, base)
        if p and os.path.isfile(p):
            data, err = _read_json_checked(p)
            if err:
                out.append(i18n.M("doc.corrupt_json", path=name, error=err))
            else:
                out += gate.exec_position_problems(data, name)
    ret = knobs.repo_path("REFLECT_RETRACTIONS", base)
    if ret and os.path.isfile(ret):
        rdata, rerr = _read_json_checked(ret)
        if rerr:
            out.append(i18n.M("doc.corrupt_json", path="retractions.json", error=rerr))
        else:
            for r in rdata.get("retractions") or []:
                if isinstance(r, dict):
                    out += gate.prose_in_exec_problems("retractions/%s" % r.get("id", "?"),
                                                       "evidence", r.get("evidence"))
    return out + _question_exec_problems(knobs.questions_path(base))


def _enforced(script):
    return ("python3 -c \"import sys;sys.path.insert(0,'zreflect');"
            "import doc;sys.exit(doc.enforced_by('%s'))\"" % script)


RULES = (
    Rule("only_measured",
         "numbers/behavior trust measurement only; every fact must carry a re-run command",
         "python3 -c \"import json,sys;sys.path.insert(0,'zreflect');import knobs;"
         "d=json.load(open(knobs.repo_path('REFLECT_FACTS'),encoding='utf-8'))['facts'];"
         "bad=[k for k,v in d.items() if not (isinstance(v,dict) and str(v.get('cmd','')).strip())];"
         "print('facts_without_cmd=%d' % len(bad));"
         "sys.exit(1 if bad else 0)\""),
    Rule("number_once",
         "each number is produced once and re-reconciled every commit: documents cite it as `[[key]]`, never hand-copy it",
         _enforced("check_facts.py")),
    Rule("hard_needs_criterion",
         "a rule is hard only if it has a machine criterion; without one it does not enter the table at all",
         "python3 -c \"import sys;sys.path.insert(0,'zreflect');import doc;"
         "p=doc._cmd_shape_problems();"
         "print('shape_problems=%d' % len(p));"
         "sys.exit(1 if p else 0)\""),
    Rule("falsifiable",
         "claims must be falsifiable: every declared gate carries a runnable --selftest",
         "python3 zreflect/registry.py --all-runnable"),
    Rule("declared_not_globbed",
         "predicates are declarations, not filenames: the execution surface reads registry --run <phase>",
         "python3 zreflect/registry.py --gates"),
    Rule("zero_language",
         "zero language in the core: user-visible messages go through M(code); machine contracts are untranslatable by construction",
         _enforced("check_i18n.py")),
    Rule("machine_rows",
         "machine rows are defined in one place (`i18n.ROWS`) for both producers and consumers",
         "python3 -c \"import sys;sys.path.insert(0,'zreflect');import i18n;"
         "print('rows=%d' % len(i18n.ROWS));sys.exit(0 if i18n.ROWS else 1)\""),
    Rule("three_readmes",
         "the README group is checked structurally and kept in the same push batch",
         _enforced("check_readme_sync.py")),
    Rule("snapshot_hygiene",
         "a mutable global imported across modules is a value copy: read via the module attribute instead",
         _enforced("check_snapshots.py")),
    Rule("assertion_lifecycle",
         "a retracted claim must not quietly return as current state",
         _enforced("check_retractions.py")),
    Rule("no_retired_names",
         "retired names must not appear as current state; sha provenance and age are checkable",
         _enforced("check_stale.py")),
    Rule("open_questions_settle",
         "every unresolved open question must carry a runnable settler",
         _enforced("check_questions.py")),
    Rule("selfcert_harness",
         "every declared module must have a --selftest entry",
         "python3 -c \"import sys;sys.path.insert(0,'zreflect');import registry;"
         "u=registry.selftest_modules()[1];"
         "print('missing_selftest=%d' % len(u));sys.exit(1 if u else 0)\""),
    Rule("host_agnostic",
         "the suite's source recognizes no host's directory names or config formats",
         "python3 -c \"import os,sys;"
         "w=['.'+chr(122)+chr(99)+chr(111)+chr(100)+chr(101)+'/','ZCODE_'+'PROJECT_DIR',"
         "'hook'+'SpecificOutput'];"
         "bad=[(d,f) for d in ('zreflect','reflect-local') "
         "for r,_,fs in os.walk(d) for f in fs if f.endswith('.py') "
         "and any(k in open(os.path.join(r,f),encoding='utf-8',errors='replace').read() for k in w)];"
         "print('host_coupled=%d' % len(bad));sys.exit(1 if bad else 0)\""),
    Rule("exec_position_is_a_command",
         "every execution position (stamp cmd / pin cmd / Settling / evidence) must hold a runnable command",
         "python3 -c \"import sys;sys.path.insert(0,'zreflect');import doc;"
         "bad=doc.all_exec_position_problems();"
         "[print(p) for p in bad] or print('prose_positions=0');sys.exit(1 if bad else 0)\""),
    Rule("comments_earn_their_place",
         "explanation volume must fit AST complexity under `mismatch`, or carry no docstrings under `strict`",
         _enforced("check_explain.py")),
    Rule("style_is_not_a_rule",
         "style preferences do not enter the rule table",
         "python3 -c \"import sys;sys.path.insert(0,'zreflect');import doc;"
         "style=('style','naming','comment','layout','format');"
         "bad=[r.id for r in doc.all_rules() if r.id in style];"
         "print('style_ids=%d' % len(bad));sys.exit(1 if bad else 0)\""),
    Rule("core_sealed",
         "shared suite core modules, gates, hooks, and language packs match `zreflect/SEAL.json`",
         "python3 zreflect/registry.py --verify-seal"),
)

_BY_ID = {r.id: r for r in RULES}
_STYLE_IDS = frozenset({"style", "naming", "comment", "layout", "format"})
_RESERVED_RULE_IDS = frozenset(_BY_ID) | _STYLE_IDS
LOCAL_PRINCIPLES_NAME = "principles.json"
RULES_BEGIN = "<!-- AUTO:RULES -->"
RULES_END = "<!-- /AUTO:RULES -->"
PRINCIPLES = "PRINCIPLES.md"
STATE = "STATE.md"


def _local_rules_rel(root=None):
    base = root or gate.GATE_REPO
    ldir = knobs.get("REFLECT_LOCAL_DIR", base).strip("/\\")
    return os.path.join(ldir, LOCAL_PRINCIPLES_NAME).replace(os.sep, "/")


def _validate_local_entry(item, seen, rel):
    if not isinstance(item, dict):
        return None, "entry must be an object"
    rid = str(item.get("id") or "").strip()
    text = str(item.get("text") or "").strip()
    cmd = str(item.get("cmd") or "").strip()
    if not rid or not text or not cmd:
        return None, f"rule {rid or '?'!r} needs non-empty id, text, cmd"
    if not re.fullmatch(r"[a-z][a-z0-9_]*", rid) or rid in _RESERVED_RULE_IDS or rid in seen:
        return None, f"invalid or duplicate rule id {rid!r}"
    rule_obj = Rule(rid, text, cmd)
    if _cmd_shape_problems([rule_obj]):
        return None, f"rule {rid!r} cmd shape invalid"
    if gate.prose_in_exec_problems(rel, rid, cmd):
        return None, f"rule {rid!r} cmd contains prose"
    return rule_obj, None


def parse_local_rules(data, rel="reflect-local/principles.json"):
    """Validate optional consumer `principles.json`; return `(tuple[Rule, ...], list[Message])`."""
    raw_list = data.get("rules") if isinstance(data, dict) else data
    if not isinstance(raw_list, list):
        return (), [i18n.M("doc.corrupt_json", path=rel, error="expected array or {rules: [...]}")]
    out: list[Rule] = []
    seen: set[str] = set()
    for item in raw_list:
        r, err = _validate_local_entry(item, seen, rel)
        if err or r is None:
            return (), [i18n.M("doc.corrupt_json", path=rel, error=err or "invalid")]
        seen.add(r.id)
        out.append(r)
    return tuple(out), []


def _load_local_rules(root=None):
    base = root or gate.GATE_REPO
    rel = _local_rules_rel(base)
    p = os.path.join(base, rel)
    if not os.path.exists(p):
        return (), []
    if not os.path.isfile(p):
        return (), [i18n.M("doc.corrupt_json", path=rel, error="not a file")]
    try:
        with open(p, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError) as exc:
        return (), [i18n.M("doc.corrupt_json", path=rel, error=str(exc))]
    return parse_local_rules(data, rel=rel)


def local_rules_problems(root=None):
    """Return validation problems for optional `<REFLECT_LOCAL_DIR>/principles.json`."""
    return _load_local_rules(root)[1]


def local_rules(root=None):
    """Return validated consumer local rules from `<REFLECT_LOCAL_DIR>/principles.json`."""
    return _load_local_rules(root)[0]


def all_rules(root=None):
    """Return upstream `RULES` plus validated consumer local rules."""
    return RULES + local_rules(root)


def render_rules(rows=None):
    """PINNED: render fixed-language `AUTO:RULES` block from `RULES` (plus local rules)."""
    rows = all_rules() if rows is None else rows
    lines = [RULES_BEGIN,
             ("> This block is rendered by `zreflect/facts.py --render-doc` from the "
              "`RULES` table in `zreflect/doc.py` (plus optional `reflect-local/principles.json`); "
              "**do not hand-edit**."),
             ("> Every row's judging command is executed verbatim at every commit (`check_facts_replay`)."),
             "", "| id | principle | judging command |", "|---|---|---|"]
    for r in sorted(rows, key=lambda x: x.id):
        lines.append("| `%s` | %s | `%s` |" % (r.id, r.text, r.cmd))
    lines += ["", "%d principles -- each with a judging command that **really runs**." % len(rows),
              RULES_END]
    return "\n".join(lines)


def accepts_principles(repo_root=None):
    """Return True if `PRINCIPLES.md` exists and `REFLECT_NO_PRINCIPLES` is not true."""
    if knobs.flag("REFLECT_NO_PRINCIPLES") is True:
        return False
    base = repo_root or gate.GATE_REPO
    return os.path.exists(os.path.join(base, PRINCIPLES))


def state_name():
    """Return configured state document filename (`REFLECT_DOC`)."""
    return knobs.get("REFLECT_DOC")


def rule(rid):
    """Fetch a `Rule` by id (raises `KeyError` if absent)."""
    return _BY_ID[rid]


def facts_of_rules(root=None):
    """Convert `all_rules()` (`RULES` + local rules) to `{principle.<id>: fact_dict}` for replay."""
    now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    today = time.strftime("%Y-%m-%d")
    return {
        "principle." + r.id: {
            "value": "ok", "cmd": r.cmd, "source": "principle",
            "measured_at": now, "first_seen": today,
            "note": r.text, "kind": "principle",
        }
        for r in all_rules(root)
    }


def _cmd_shape_problems(rows=None):
    out = [(LOCAL_PRINCIPLES_NAME, str(m)) for m in local_rules_problems()] if rows is None else []
    for r in (all_rules() if rows is None else rows):
        cmd = r.cmd.strip()
        if not cmd:
            out.append((r.id, "empty_cmd"))
        elif "\n" in cmd or "\r" in cmd or "$(" in cmd or "`" in cmd or "||" in cmd:
            out.append((r.id, "chains_or_suppresses"))
        elif not re.match(r"^(python3|python|sh|bash|env)\s", cmd):
            out.append((r.id, "not_an_interpreter"))
        elif re.search(r"(^|[;&|]\s*)(export|set\s+-a)|>\s*\S", cmd.replace(">/dev/null", "")):
            out.append((r.id, "mutates_env"))
        else:
            unquoted = re.sub(r"'[^']*'|\"[^\"]*\"", "", cmd)
            if ";" in unquoted or re.search(r"(?<![&>])&(?![&>])", unquoted):
                out.append((r.id, "chains_or_suppresses"))
    return out


def _accepts_principles_ok():
    import tempfile  # noqa: PLC0415
    with tempfile.TemporaryDirectory() as root:
        if accepts_principles(root):
            return False
        with open(os.path.join(root, PRINCIPLES), "w", encoding="utf-8") as fh:
            fh.write("# PRINCIPLES\n")
        saved = os.environ.pop("REFLECT_NO_PRINCIPLES", None)
        try:
            if not accepts_principles(root):
                return False
            os.environ["REFLECT_NO_PRINCIPLES"] = "1"
            return not accepts_principles(root)
        finally:
            if saved is not None:
                os.environ["REFLECT_NO_PRINCIPLES"] = saved
            else:
                os.environ.pop("REFLECT_NO_PRINCIPLES", None)


def _enforced_by_off_ok():
    saved = os.environ.get("REFLECT_COMMENTS")
    os.environ["REFLECT_COMMENTS"] = "off"
    try:
        return enforced_by("check_explain.py") == 1
    finally:
        if saved is None:
            os.environ.pop("REFLECT_COMMENTS", None)
        else:
            os.environ["REFLECT_COMMENTS"] = saved


def _local_rules_ok():
    import tempfile  # noqa: PLC0415
    ok_rows, ok_err = parse_local_rules([{"id": "local_ok", "text": "t", "cmd": "python3 -c 'pass'"}])
    if ok_err or len(ok_rows) != 1 or ok_rows[0].id != "local_ok":
        return False
    _, dup_err = parse_local_rules([{"id": "only_measured", "text": "t", "cmd": "python3 -c 'pass'"}])
    _, style_err = parse_local_rules([{"id": "style", "text": "t", "cmd": "python3 -c 'pass'"}])
    _, bad_cmd = parse_local_rules([{"id": "local_bad", "text": "t", "cmd": "echo nope"}])
    if not (dup_err and style_err and bad_cmd):
        return False
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, "reflect-local"))
        with open(os.path.join(d, "reflect-local", LOCAL_PRINCIPLES_NAME), "w", encoding="utf-8") as fh:
            fh.write(json.dumps([{"id": "disk_arr", "text": "t", "cmd": "python3 -c 'pass'"}]))
        disk_rows, disk_err = _load_local_rules(d)
        return not disk_err and len(disk_rows) == 1 and disk_rows[0].id == "disk_arr"


def _cases():
    return [
        ("doc.rules_well_formed", lambda: _cmd_shape_problems(RULES) == []),
        ("doc.local_rules_validation", _local_rules_ok),
        ("doc.ids_unique_and_valid",
         lambda: len({r.id for r in RULES}) == len(RULES)
         and all(re.fullmatch(r"[a-z][a-z0-9_]*", r.id) and r.text.strip() for r in RULES)),
        ("doc.lookup_works", lambda: rule("only_measured").id == "only_measured"),
        ("doc.render_rules_has_markers",
         lambda: RULES_BEGIN in render_rules() and RULES_END in render_rules()
         and "nope" in render_rules([Rule("nope", "t", "python3 -c 'pass'")])),
        ("★ doc.empty_cmd_is_rejected",
         lambda: _cmd_shape_problems([Rule("x", "t", "")]) == [("x", "empty_cmd")]),
        ("★ doc.enforced_by_missing_fails", lambda: enforced_by("check_nope_xyz.py") == 1),
        ("★ doc.enforced_by_off_fails", lambda: _enforced_by_off_ok()),
        ("doc.state_name_uses_knob", lambda: state_name() == knobs.get("REFLECT_DOC")),
        ("★ doc.accepts_principles_opt_out", lambda: _accepts_principles_ok()),
        ("★ doc.exec_position_rejects_prose",
         lambda: [p.code for p in gate.prose_in_exec_problems("w", "cmd", "say hi")]
         == ["criteria.exec_position_is_prose"]),
    ]


MODULE = module_meta("Principles registry", "RULES table, AUTO:RULES renderer, facts_of_rules",
                     selftest=True)

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], "doc", _cases, lambda _argv: 0))
