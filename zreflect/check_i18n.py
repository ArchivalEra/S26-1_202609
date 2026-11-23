#!/usr/bin/env python3
"""Zero-language coverage gate (`M(code)` + optional language pack sync/coverage)."""
from __future__ import annotations

import ast
import os
import re
import sys
from typing import TypeGuard

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gate  # noqa: E402
import i18n  # noqa: E402
import knobs  # noqa: E402
from gate import fatal, finish, main_selftest_or, meta, repo  # noqa: E402
from i18n import CJK_LO, LINE_BREAKS, M, han  # noqa: E402

DEFAULT_ROOTS = ("zreflect", "reflect-local")
KNOB = "REFLECT_I18N_ROOT"
PINNED_MARK = "PINNED:"
cjk = han

_EXEMPT_CALLS = ("meta", "module_meta", "Rule", "compile",
                 "startswith", "endswith", "match", "search", "fullmatch", "find")
_CODE_RE = re.compile(r'M\("([a-z][a-z0-9_.]+)"')
_SEM_RE = re.compile(r'_Semantic\("([a-z][a-z0-9_.]+)"')
_SELFTEST_CODE_PREFIXES = ("probe.", "gate.off.body")
_PH = re.compile(r"%\(([A-Za-z_][A-Za-z0-9_]*)\)"
                 r"(?:[#0\-+ ]*)(?:\d+)?(?:\.\d+)?[hlL]?([diouxXeEfFgGcrsa])")
_PLACEHOLDER_RE = re.compile(r"%\((\w+)\)")
_BRACE_RE = re.compile(r"\{[a-z_][a-z0-9_]*\}")


def _declares_pinned(doc):
    if not doc or PINNED_MARK not in doc:
        return False
    reason = doc[doc.index(PINNED_MARK) + len(PINNED_MARK):].strip()
    for sep in ("\n", chr(0x3002), ". "):
        cut = reason.find(sep)
        if cut != -1:
            reason = reason[:cut]
    return len(reason.strip()) >= 20


def _pinned_by_comment(src, node):
    lines = src.splitlines()
    i = node.lineno - 2
    while i >= 0:
        line = lines[i].strip()
        if not line.startswith("#"):
            break
        if _declares_pinned(line):
            return True
        i -= 1
    return False


def _is_msg_call(node: ast.AST) -> TypeGuard[ast.Call]:
    if not isinstance(node, ast.Call):
        return False
    f = node.func
    return ((isinstance(f, ast.Name) and f.id == "M")
            or (isinstance(f, ast.Attribute) and f.attr == "M"))


def _docstring_both(tree):
    nodes: set[int] = set()
    lines: set[int] = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        d = ast.get_docstring(node, clean=False)
        if not d:
            continue
        for n in ast.walk(node):
            if isinstance(n, ast.Constant) and n.value == d:
                nodes.add(id(n))
                break
        stmt = node.body[0]
        if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant):
            first = stmt.value
            lines.update(range(first.lineno, (first.end_lineno or first.lineno) + 1))
    return nodes, lines


def _msg_consts(tree):
    return {id(n) for node in ast.walk(tree) if _is_msg_call(node)
            for n in ast.walk(node) if isinstance(n, ast.Constant)}


def _branch_constants(node):
    return {id(n) for n in ast.walk(node) if isinstance(n, ast.Constant)}


def _exempt_call_args(tree):
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            fn = getattr(node.func, "id", "") or getattr(node.func, "attr", "")
            if fn in _EXEMPT_CALLS:
                for arg in list(node.args) + [kw.value for kw in node.keywords]:
                    out |= _branch_constants(arg)
    return out


def _pinned_constants(tree, src):
    out = set()
    for node in ast.walk(tree):
        fn_pinned = (isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                     and _declares_pinned(ast.get_docstring(node, clean=False)))
        assign_pinned = isinstance(node, ast.Assign) and _pinned_by_comment(src, node)
        if fn_pinned or assign_pinned:
            out |= _branch_constants(node)
    return out


def _exempt_ids(tree, name, src):
    out = _exempt_call_args(tree) | _pinned_constants(tree, src)
    if name == "i18n.py":
        out |= _branch_constants(tree)
    return out


def _bare_text_problems(name, tree, src):
    out = []
    doc_nodes, _ = _docstring_both(tree)
    msg_consts = _msg_consts(tree)
    exempt = _exempt_ids(tree, name, src)
    fixture_lines = _fixture_scope_lines(tree)
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Constant) and isinstance(node.value, str)):
            continue
        v = node.value
        if not cjk(v) or id(node) in doc_nodes or id(node) in msg_consts or id(node) in exempt:
            continue
        if (node.lineno in fixture_lines
                and re.match(r"^\s*(?:★\s*)?[a-z_][a-z0-9_]*(?:\.[a-z0-9_.]+)+", v)):
            continue
        out.append(M("i18n_cover.bare_text", file=name, lineno=node.lineno, text=v[:40]))
    return out


def _non_literal_code_problems(name, tree):
    exempt = _fixture_scope_lines(tree) | _pinned_lines(tree)
    out = []
    for node in ast.walk(tree):
        if not _is_msg_call(node) or not node.args or node.lineno in exempt:
            continue
        first = node.args[0]
        if isinstance(first, ast.Constant) and isinstance(first.value, str):
            continue
        out.append(M("i18n_cover.code_not_literal", file=name,
                     lineno=node.lineno, kind=type(first).__name__))
    return out


def _cases_scope(tree):
    fns = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "_cases"]
    if not fns:
        return []
    fn = fns[0]
    called = {n.func.id for n in ast.walk(fn)
              if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)}
    helpers = [n for n in tree.body
               if isinstance(n, ast.FunctionDef) and n.name in called
               and not _declares_pinned(ast.get_docstring(n, clean=False))]
    return [fn] + helpers


def _fixture_scope_lines(tree):
    spans: set[int] = set()
    for body in _cases_scope(tree):
        for node in ast.walk(body):
            lo = getattr(node, "lineno", None)
            if lo:
                spans.update(range(lo, (getattr(node, "end_lineno", lo) or lo) + 1))
    for node in ast.walk(tree):
        if (isinstance(node, ast.Assign)
                and isinstance(node.value, (ast.BinOp, ast.Call))
                and any(isinstance(t, ast.Name) and t.id.isupper() for t in node.targets)):
            spans.update(range(node.lineno, (node.end_lineno or node.lineno) + 1))
    return spans


def _pinned_lines(tree):
    spans: set[int] = set()
    for node in ast.walk(tree):
        if (isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                and _declares_pinned(ast.get_docstring(node, clean=False))):
            spans.update(range(node.lineno, (node.end_lineno or node.lineno) + 1))
    return spans


def _plain_english_problems(name, src, tree):
    _, doc_lines = _docstring_both(tree)
    exempt_lines = _fixture_scope_lines(tree) | _pinned_lines(tree) | doc_lines
    out = []
    for lineno, line in enumerate(src.splitlines(), 1):
        if lineno in exempt_lines or i18n.prose_exempt(line):
            continue
        hits = i18n.non_ascii_prose(line)
        if hits:
            out.append(M("i18n_cover.non_ascii_prose", file=name, lineno=lineno,
                         chars="".join(sorted({c for c, _ in hits})),
                         text=line.strip()[:60]))
    return out


def _fixture_literal_problems(name, tree):
    bodies = _cases_scope(tree)
    if not bodies:
        return []
    exempt = set()
    for b in bodies:
        exempt |= _docstring_both(b)[0]
        exempt |= {id(n.elts[0]) for n in ast.walk(b)
                   if isinstance(n, ast.Tuple) and len(n.elts) == 2
                   and isinstance(n.elts[0], ast.Constant)}
    return [M("i18n_cover.fixture_literal", file=name, lineno=n.lineno, text=n.value[:40])
            for b in bodies for n in ast.walk(b)
            if isinstance(n, ast.Constant) and isinstance(n.value, str)
            and cjk(n.value) and id(n) not in exempt]


def problems(paths):
    """Audit `[(name, src)]` for bare natural language, non-literal `M()`, and non-ASCII prose."""
    if not paths:
        return [M("i18n_cover.empty_scan")]
    out = []
    for name, _src in paths:
        if any(b in name for b in LINE_BREAKS):
            out.append(M("i18n_cover.filename_has_line_break",
                         file=name.replace("\n", "\\n")[:60]))
    for name, src in paths:
        try:
            tree = ast.parse(src)
        except SyntaxError as e:
            out.append(M("i18n_cover.parse_error", file=name, error=e))
            continue
        out += _bare_text_problems(name, tree, src)
        out += _fixture_literal_problems(name, tree)
        out += _non_literal_code_problems(name, tree)
        out += _plain_english_problems(name, src, tree)
    return out


def used_codes(paths=None):
    """Collect literal `M(...)` and `_Semantic(...)` codes emitted by suite sources."""
    if paths is None:
        paths = list(gate.py_sources(gate.zdir()))
        hooks_dir = os.path.join(gate.tool_repo(), "reflect-local")
        if os.path.isdir(hooks_dir):
            paths += list(gate.py_sources(hooks_dir))
    out = set()
    for _name, src in paths:
        try:
            tree = ast.parse(src)
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if (_is_msg_call(node) and node.args
                    and isinstance(node.args[0], ast.Constant)
                    and isinstance(node.args[0].value, str)):
                out.add(node.args[0].value)
        out |= set(_SEM_RE.findall(src))
    return {c for c in out if not any(c.startswith(p) for p in _SELFTEST_CODE_PREFIXES)}


def _load_tables(langs, load):
    tables = {}
    for lang in langs:
        try:
            tables[lang] = load(lang)
        except Exception as e:                           # noqa: BLE001
            return {}, [M("knobs.pack_unreadable", lang=lang, error=e)]
    return tables, None


def pack_coverage_problems(codes=None, loader=None, discovery=None):
    """Ensure every code used by core source exists in every served/installed pack."""
    load = loader if loader is not None else i18n.load_pack
    codes = used_codes() if codes is None else set(codes)
    try:
        langs = list((discovery or i18n.installed_langs)())
    except i18n.PacksUnreadable as e:
        return [M("knobs.pack_unreadable", lang="*", error=e)]
    served = () if discovery is not None else knobs.served_langs()
    if served:
        missing_srv = [l for l in served if l not in langs]
        if missing_srv:
            return [M("knobs.pack_missing_code", lang=l, count=len(codes) or 1, codes="*")
                    for l in sorted(missing_srv)]
        langs = [l for l in langs if l in served]
    if not codes or not langs:
        return []
    out = []
    for lang in sorted(langs):
        try:
            table = load(lang)
        except Exception as e:                           # noqa: BLE001
            return [M("knobs.pack_unreadable", lang=lang, error=e)]
        missing = sorted(codes - set(table))
        if missing:
            out.append(M("knobs.pack_missing_code", lang=lang,
                         count=len(missing), codes=", ".join(missing[:8])))
    return out


def _resolve_pack_langs(discovery):
    langs = list((discovery or i18n.installed_langs)())
    served = () if discovery is not None else knobs.served_langs()
    if not served:
        return langs, None
    missing = [l for l in served if l not in langs]
    if missing:
        return [], [M("knobs.pack_unreadable", lang=missing[0], error="missing")]
    return list(served), None


def pack_sync_problems(loader=None, discovery=None):
    """Verify installed language packs agree on key sets, percent formatting, and placeholders."""
    load = loader if loader is not None else i18n.load_pack
    try:
        langs, served_err = _resolve_pack_langs(discovery)
    except i18n.PacksUnreadable as e:
        return [M("knobs.pack_unreadable", lang="*", error=e)]
    if served_err:
        return served_err
    tables, err = _load_tables(langs, load)
    if err or not tables:
        return err or []
    if not any(tables.values()):
        return [M("knobs.pack_sync_empty", pack_dir=i18n.pack_dir())]
    ref_lang = sorted(tables)[0]
    ref = tables[ref_lang]
    out = []
    for lang in sorted(tables):
        out += [M("knobs.pack_empty_value", lang=lang, key=c)
                for c, v in sorted(tables[lang].items())
                if isinstance(v, str) and not v.strip()]
        out += [M("knobs.pack_brace_template", lang=lang, key=c, text=v[:60])
                for c, v in sorted(tables[lang].items())
                if isinstance(v, str) and _BRACE_RE.search(v)]
        if lang != ref_lang:
            out += _diff_packs(lang, ref_lang, ref, tables[lang])
        if lang != "en" and "en" in tables and tables[lang] == tables["en"]:
            out.append(M("knobs.pack_untranslated", lang=lang))
    return out


def _diff_packs(lang, ref_lang, ref, other):
    out = []
    only_ref, only_other = sorted(set(ref) - set(other)), sorted(set(other) - set(ref))
    if only_ref:
        out.append(M("knobs.pack_missing_keys", lang=lang, reference=ref_lang,
                     keys=", ".join(only_ref[:8]), count=len(only_ref)))
    if only_other:
        out.append(M("knobs.pack_extra_keys", lang=lang, reference=ref_lang,
                     keys=", ".join(only_other[:8])))
    for code in sorted(set(ref) & set(other)):
        a = sorted(_PLACEHOLDER_RE.findall(ref[code]))
        b = sorted(_PLACEHOLDER_RE.findall(other[code]))
        if a != b:
            out.append(M("knobs.pack_placeholder_mismatch", lang=lang, key=code,
                         reference_lang=ref_lang, expected_params=", ".join(a) or "-",
                         actual_params=", ".join(b) or "-"))
    return out


def run(argv=None):
    _ = argv
    configured = (knobs.raw(KNOB) or "").strip()
    roots = [configured] if configured else list(DEFAULT_ROOTS)
    paths = []
    for root in roots:
        d = repo(root) if configured else os.path.abspath(os.path.join(gate.tool_repo(), root))
        found = gate.py_sources(d)
        if not found and configured:
            return fatal(M("i18n_cover.scan_empty_dir", root=root))
        paths.extend(found)
    if not paths:
        return fatal(M("i18n_cover.scan_empty_dir", root=", ".join(roots)))
    probs = problems(paths)
    if not configured:
        probs += pack_sync_problems()
        probs += pack_coverage_problems(used_codes())
    return finish(M("i18n_cover.title"), probs, M("i18n_cover.ok", files=len(paths)))


def _params_for(template):
    return {m.group(1): (3 if m.group(2) in "dixXfFeEgG" else "v")
            for m in _PH.finditer(template)}


def _null_output_has_no_cjk():
    try:
        table = i18n.load_pack("en")
    except Exception:                                    # noqa: BLE001
        return False
    if not table:
        return False
    with i18n.bind(i18n.NULL):
        return all(not cjk(str(M(c, **_params_for(table[c])))) for c in sorted(table))


def _packs_match_their_language():
    checked = 0
    for lang in sorted(i18n.installed_langs()):
        if lang == "zh":
            continue
        try:
            table = i18n.load_pack(lang)
        except Exception:                                # noqa: BLE001
            continue
        if not table:
            continue
        with i18n.bind(i18n.Catalog.load(lang, {lang: table})):
            if any(cjk(str(M(c, **_params_for(table[c])))) for c in sorted(table)):
                return False
        checked += 1
    return checked >= 1


def _real_packs_in_sync_ok():
    if not i18n.installed_langs():
        return True
    saved = os.environ.get("REFLECT_LANGS")
    os.environ["REFLECT_LANGS"] = ""
    try:
        return pack_sync_problems() == [] and pack_coverage_problems() == []
    finally:
        if saved is None:
            os.environ.pop("REFLECT_LANGS", None)
        else:
            os.environ["REFLECT_LANGS"] = saved


def _cases():
    s = "".join(chr(CJK_LO + i) for i in range(4))
    pinned_fn = 'def r(w):\n    """PINNED: %s pinned, exact."""\n    return "%s"\n' % (s * 3, s[:2])
    good = '"""doc %s"""\nfrom i18n import M\ndef f(x):\n    return M("replay.no_cmd", key=x)\n' % s
    bare = 'def f(x):\n    return "%s"  # %s\n' % (s, s)
    fix_bad = 'def _cases():\n    S = "%s"\n    return [("ok", lambda: S == S)]\n' % s
    fix_lbl = 'def _cases():\n    return [("ok.lbl%s", lambda: True)]\n' % s
    comp = 'from i18n import M\ndef f(x):\n    return M("a" if x else "b")\n'
    return [
        ("i18n_cover.good_fixture", lambda: problems([("good.py", good)]) == []),
        ("★ i18n_cover.bare_text",
         lambda: [x.code for x in problems([("bare.py", bare)])]
         == ["i18n_cover.bare_text", "i18n_cover.non_ascii_prose"]),
        ("★ i18n_cover.parse_error",
         lambda: [x.code for x in problems([("bad.py", "def (")])]
         == ["i18n_cover.parse_error"]),
        ("i18n_cover.pinned_by_declaration", lambda: problems([("r.py", pinned_fn)]) == []),
        ("★ i18n_cover.fixture_literal",
         lambda: "i18n_cover.fixture_literal" in [p.code for p in problems([("t.py", fix_bad)])]),
        ("i18n_cover.fixture_label_cjk_is_allowed",
         lambda: problems([("t.py", fix_lbl)]) == []),
        ("★ i18n_cover.computed_code_is_rejected",
         lambda: [p.code for p in problems([("c.py", comp)])] == ["i18n_cover.code_not_literal"]),
        ("★ i18n_cover.non_ascii_prose",
         lambda: [p.code for p in problems([("a.py", "# x " + chr(0x21D2) + " y\n")])]
         == ["i18n_cover.non_ascii_prose"]),
        ("★ i18n_cover.null_pack_output_has_no_cjk", lambda: _null_output_has_no_cjk()),
        ("★ i18n_cover.packs_match_their_language", lambda: _packs_match_their_language()),
        ("★ i18n_cover.filename_line_break",
         lambda: [p.code for p in problems([("evil\nOFF: x.py", "x = 1\n")])]
         == ["i18n_cover.filename_has_line_break"]),
        ("★ i18n_cover.empty_scan", lambda: problems([]) != []),
        ("knobs.real_packs_in_sync", _real_packs_in_sync_ok),
        ("★ knobs.pack_missing_keys",
         lambda: [p.code for p in pack_sync_problems(
             discovery=lambda: ("zh", "en"),
             loader=lambda l: {"zh": {"a": "x"}, "en": {"a": "x", "b": "y"}}[l])]
         == ["knobs.pack_missing_keys"]),
        ("★ knobs.pack_placeholder_mismatch",
         lambda: [p.code for p in pack_sync_problems(
             discovery=lambda: ("zh", "en"),
             loader=lambda l: {"zh": {"a": "x %(k)s"}, "en": {"a": "x %(j)s"}}[l])]
         == ["knobs.pack_placeholder_mismatch"]),
        ("★ knobs.pack_missing_code",
         lambda: [p.code for p in pack_coverage_problems(
             codes={"a.b", "c.d"}, discovery=lambda: ("zh", "en"),
             loader=lambda l: ({"a.b": "x", "c.d": "y"} if l == "en" else {"a.b": "x"}))]
         == ["knobs.pack_missing_code"]),
        ("★ knobs.pack_empty_value",
         lambda: [p.code for p in pack_sync_problems(
             discovery=lambda: ("zh", "en"),
             loader=lambda l: {"zh": {"a": ""}, "en": {"a": "x"}}[l])]
         == ["knobs.pack_empty_value"]),
        ("★ i18n_cover.pinned_too_short",
         lambda: not _declares_pinned("PINNED: short")
         and not _pinned_by_comment("# PINNED: short\nX = 1\n", ast.parse("# PINNED: short\nX = 1\n").body[0])),
        ("★ i18n_cover.var_code_and_dotted_cjk_rejected",
         lambda: [p.code for p in _non_literal_code_problems("a.py", ast.parse("M(var)"))] == ["i18n_cover.code_not_literal"]
         and [p.code for p in _bare_text_problems(
             "a.py", ast.parse('X = "a.b %s"\n' % s), 'X = "a.b %s"\n' % s)] == ["i18n_cover.bare_text"]),
        ("★ knobs.pack_untranslated_rejected",
         lambda: [p.code for p in pack_sync_problems(
             discovery=lambda: ("de", "en"),
             loader=lambda _l: {"a": "english only"})] == ["knobs.pack_untranslated"]),
    ]


GATE = meta("language coverage gate",
            "zero-language core output via M(code) and optional language pack sync/coverage",
            knobs=("REFLECT_I18N_ROOT",))

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], M("gate.title.i18n_cover"), _cases, run))
