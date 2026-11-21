#!/usr/bin/env python3
"""Comment discipline: **explanation volume stays proportional to code complexity**.

Two modes via `REFLECT_COMMENTS` (defaults to `mismatch`; only `off` disables):
  mismatch  `len(docstring) + in_function_comment_chars <= 300 + 120*branches + 60*args`
  strict    any docstring on a function is rejected
"""
from __future__ import annotations

import ast
import io
import os
import sys
import tokenize

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gate  # noqa: E402
import knobs  # noqa: E402
from gate import fatal, main_selftest_or, meta, module_meta, off  # noqa: E402
from i18n import M  # noqa: E402

MODES = ("strict", "mismatch")
BASE_BUDGET = 300
PER_BRANCH = 120
PER_ARG = 60

_BRANCH_NODES = (
    ast.If, ast.For, ast.AsyncFor, ast.While, ast.ExceptHandler,
    ast.With, ast.AsyncWith, ast.BoolOp, ast.IfExp, ast.Raise,
)
_PRAGMAS = ("noqa", "type:", "pragma:", "pylint:", "pyright:", "fmt:", "isort:")


def mode():
    """Declared `REFLECT_COMMENTS` mode (`mismatch` when unset; `off` disables)."""
    return knobs.get("REFLECT_COMMENTS").strip().lower()


def _branch_count(fn):
    """Count branching/control-flow constructs in `fn` without entering nested defs."""
    queue = list(fn.body)
    count = 0
    while queue:
        cur = queue.pop()
        if isinstance(cur, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        if isinstance(cur, _BRANCH_NODES):
            count += 1
        elif isinstance(cur, ast.comprehension):
            count += len(cur.ifs)
        queue.extend(ast.iter_child_nodes(cur))
    return count


def _arg_count(fn):
    """Total declared parameters of `fn` (excluding self/cls distinction)."""
    a = fn.args
    return (len(a.posonlyargs) + len(a.args) + len(a.kwonlyargs)
            + (1 if a.vararg else 0) + (1 if a.kwarg else 0))


def _scope_comment_chars(src, scopes):
    """Attribute stripped non-pragma `#` comments to the innermost enclosing scope or module top."""
    counts: dict[object, int] = {"__top__": 0}
    try:
        tokens = list(tokenize.generate_tokens(io.StringIO(src).readline))
    except (tokenize.TokenError, IndentationError):
        return counts
    for tok in tokens:
        if tok.type != tokenize.COMMENT:
            continue
        text = tok.string.lstrip("#").strip()
        if not text or text.lower().startswith(_PRAGMAS):
            continue
        owners = [s for s in scopes if s.lineno <= tok.start[0] <= (s.end_lineno or s.lineno)]
        if owners:
            own = min(owners, key=lambda s: (s.end_lineno or s.lineno) - s.lineno)
            counts[own] = counts.get(own, 0) + len(text)
        else:
            counts["__top__"] += len(text)
    return counts


def _budget(branches, args):
    """Allowed explanation character budget for `(branches, args)`."""
    return BASE_BUDGET + PER_BRANCH * branches + PER_ARG * args


def _scope_reports(path, node, label, doc, cchars_val, bud, chosen, branches=0, args=0):
    out = []
    if chosen == "strict":
        if doc.strip():
            out.append(M("comments.docstring_in_strict_mode",
                         file=path, line=getattr(node, "lineno", 1), name=label))
        if cchars_val > 0:
            out.append(M("comments.comment_in_strict_mode",
                         file=path, line=getattr(node, "lineno", 1), name=label))
        return out
    total = len(doc) + cchars_val
    if total > bud:
        out.append(M("comments.explain_exceeds_complexity",
                     file=path, line=getattr(node, "lineno", 1), name=label,
                     chars=total, budget=bud, branches=branches, args=args))
    return out


def function_reports(path, src, chosen):
    """Per-module, per-class, and per-function violations under `chosen` (`strict` | `mismatch`)."""
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return []
    scopes = [n for n in ast.walk(tree)
              if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
    cchars = _scope_comment_chars(src, scopes)
    mod_doc = ast.get_docstring(tree, clean=False) or ""
    out = _scope_reports(path, tree, "<module>", mod_doc, cchars.get("__top__", 0), 5000, chosen)
    for node in scopes:
        if chosen == "mismatch" and (node.name == "_cases" or node.name.startswith("_cases_")):
            continue
        doc = ast.get_docstring(node, clean=False) or ""
        if isinstance(node, ast.ClassDef):
            methods = sum(1 for ch in node.body if isinstance(ch, (ast.FunctionDef, ast.AsyncFunctionDef)))
            out += _scope_reports(path, node, node.name, doc, cchars.get(node, 0), _budget(methods, 0), chosen)
            continue
        br, n_args = _branch_count(node), _arg_count(node)
        out += _scope_reports(path, node, node.name, doc, cchars.get(node, 0),
                              _budget(br, n_args), chosen, branches=br, args=n_args)
    return out


def problems(paths, chosen):
    """Evaluate `[(relpath, source)]` under `chosen`. Returns list of `Message`."""
    if chosen not in MODES:
        return [M("comments.bad_mode", mode=chosen, supported=", ".join(MODES))]
    return [p for name, src in paths for p in function_reports(name, src, chosen)]


def _suite_sources():
    """Collect `[(relpath, src)]` across `zreflect/` and `reflect-local/`."""
    out = []
    root = gate.tool_repo()
    for sub in ("zreflect", "reflect-local"):
        base = os.path.join(root, sub)
        if not os.path.isdir(base):
            continue
        for name in sorted(os.listdir(base)):
            if name.endswith(".py") and not name.startswith("measure_"):
                rel = sub + "/" + name
                out.append((rel, open(os.path.join(base, name), encoding="utf-8").read()))
    return out


def run(argv=None):
    _ = argv
    chosen = mode()
    if chosen == "off":
        return off(M("comments.off"))
    if chosen not in MODES:
        return fatal(M("comments.bad_mode", mode=chosen, supported=", ".join(MODES)))
    paths = _suite_sources()
    probs = problems(paths, chosen)
    return gate.finish(M("comments.title"), probs,
                       M("comments.ok", mode=chosen, files=len(paths), count=len(probs)))


def _mode_resolution_case():
    """Unset => `mismatch`, `off` => `off`, `strict` => `strict`."""
    saved = os.environ.pop("REFLECT_COMMENTS", None)
    try:
        if mode() != "mismatch":
            return False
        os.environ["REFLECT_COMMENTS"] = "off"
        if mode() != "off":
            return False
        os.environ["REFLECT_COMMENTS"] = "strict"
        return mode() == "strict"
    finally:
        if saved is not None:
            os.environ["REFLECT_COMMENTS"] = saved
        else:
            os.environ.pop("REFLECT_COMMENTS", None)


def _suite_scope_case():
    """`_suite_sources` covers `zreflect/` and `reflect-local/`, skipping `measure_*`."""
    import tempfile  # noqa: PLC0415
    with tempfile.TemporaryDirectory() as root:
        for half in ("zreflect", "reflect-local"):
            os.makedirs(os.path.join(root, half))
            with open(os.path.join(root, half, "x.py"), "w", encoding="utf-8") as fh:
                fh.write("def f():\n    return 1\n")
        with open(os.path.join(root, "zreflect", "measure_custom.py"), "w", encoding="utf-8") as fh:
            fh.write("def measure():\n    return {}\n")
        saved_tool = gate.tool_repo
        try:
            gate.tool_repo = lambda: root
            rels = [r for r, _s in _suite_sources()]
        finally:
            gate.tool_repo = saved_tool
        return sorted(rels) == ["reflect-local/x.py", "zreflect/x.py"]


def _cases():
    narrow = 'def f(a, b):\n    """Does thing.\n\n    a: input A.\n    b: input B.\n    """\n'
    plain = "def f(a, b):\n    return a + b\n"
    long_txt = "Sentence of rationale that runs long. " * 10
    over_doc = 'def f():\n    """%s"""\n    return 1\n' % long_txt
    over_cases = 'def _cases():\n    """%s"""\n    return []\n' % long_txt
    over_cmt = "def f():\n    # %s\n    return 1\n" % long_txt
    branched = ("def f(a, b):\n    # %s\n" % long_txt
                + "    if a:\n        return 1\n    if b:\n        return 2\n    return 0\n")
    pragma_fn = ("def f():\n"
                 + "    # noqa: E501 unused pragma text padding to exceed budget easily\n" * 10
                 + "    return 1\n")
    return [
        ("comments.mode_defaults", lambda: _mode_resolution_case()),
        ("★ comments.strict_reports_narrow",
         lambda: [p.code for p in problems([("x.py", narrow)], "strict")]
         == ["comments.docstring_in_strict_mode"]),
        ("comments.strict_ignores_bare_code",
         lambda: problems([("x.py", plain)], "strict") == []),
        ("comments.narrow_within_budget",
         lambda: problems([("x.py", narrow)], "mismatch") == []),
        ("★ comments.over_budget_docstring_fails",
         lambda: [p.code for p in problems([("x.py", over_doc)], "mismatch")]
         == ["comments.explain_exceeds_complexity"]),
        ("★ comments.over_budget_comments_fail",
         lambda: [p.code for p in problems([("x.py", over_cmt)], "mismatch")]
         == ["comments.explain_exceeds_complexity"]),
        ("★ comments.branches_and_args_raise_budget",
         lambda: problems([("x.py", branched)], "mismatch") == []),
        ("★ comments.pragmas_not_counted",
         lambda: problems([("x.py", pragma_fn)], "mismatch") == []),
        ("★ comments.bad_mode_is_reported",
         lambda: [p.code for p in problems([("x.py", narrow)], "loud")]
         == ["comments.bad_mode"]),
        ("comments.covers_both_halves",
         lambda: _suite_scope_case()),
        ("comments.cases_exempt_from_budget",
         lambda: problems([("x.py", over_cases)], "mismatch") == []),
        ("★ comments.strict_rejects_hash_and_module_doc",
         lambda: [p.code for p in problems([("x.py", '"""mod"""\ndef f():\n    # cmt\n    return 1\n')], "strict")]
         == ["comments.docstring_in_strict_mode", "comments.comment_in_strict_mode"]),
    ]


GATE = meta("Comment discipline",
            "strict: no docstrings; mismatch: explanation chars within AST complexity budget",
            knobs=("REFLECT_COMMENTS",),
            runs_at="start-of-work",
            off_reason="only disabled when REFLECT_COMMENTS=off is explicitly set")

MODULE = module_meta("Comment discipline", "explanation volume proportional to AST complexity")


if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], "check_explain", _cases, run))
