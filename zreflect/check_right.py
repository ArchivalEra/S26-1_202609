#!/usr/bin/env python3
"""Rights and license consistency gate (**pluggable module**).

Cross-checks structured declaration files (JSON / TOML via stdlib `tomllib`)
and distributed byte copies (`sha256` + non-empty) against declared expected
values. Source manifests run at `commit` phase; build artifacts belong in a
separate `--spec` or custom phase (`REFLECT_PHASES`) after build, never marked
`optional: true`.
"""
from __future__ import annotations

import json
import os
import re
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import gate  # noqa: E402
from gate import fatal, finish, load_gate_spec, main_selftest_or, meta, repo  # noqa: E402
from i18n import M  # noqa: E402

SUPPORTED_FORMATS = ("json", "toml")
_SPDX_OPS = frozenset({"(", ")", "AND", "OR", "WITH"})
_SPDX_ID_RE = re.compile(r"^[A-Za-z0-9.:-]+\+?$")


class _FatalError(Exception):
    """Config/environment failure that must exit with rc=2 (FATAL)."""

    def __init__(self, msg):
        super().__init__(str(msg))
        self.msg = msg


def _tokenize_spdx(expr):
    if not isinstance(expr, str) or not expr.strip():
        return None
    spaced = re.sub(r"([()])", r" \1 ", expr)
    tokens = spaced.split()
    return tokens or None


def _parse_spdx_atom(tokens, pos):
    if pos >= len(tokens):
        return -1
    if tokens[pos] == "(":
        end = _parse_spdx_expr(tokens, pos + 1)
        if end < 0 or end >= len(tokens) or tokens[end] != ")":
            return -1
        return end + 1
    tok = tokens[pos]
    if tok in _SPDX_OPS or not _SPDX_ID_RE.fullmatch(tok):
        return -1
    if pos + 1 < len(tokens) and tokens[pos + 1] == "WITH":
        if pos + 2 >= len(tokens):
            return -1
        exc = tokens[pos + 2]
        if exc in _SPDX_OPS or not _SPDX_ID_RE.fullmatch(exc):
            return -1
        return pos + 3
    return pos + 1


def _parse_spdx_expr(tokens, pos):
    pos = _parse_spdx_atom(tokens, pos)
    if pos < 0:
        return -1
    while pos < len(tokens) and tokens[pos] in ("AND", "OR"):
        pos = _parse_spdx_atom(tokens, pos + 1)
        if pos < 0:
            return -1
    return pos


def parse_spdx(expr):
    """Validate SPDX expression syntax (parens, AND/OR/WITH, IDs) offline."""
    tokens = _tokenize_spdx(expr)
    if not tokens:
        return False
    return _parse_spdx_expr(tokens, 0) == len(tokens)


def _norm_rel(path):
    return str(path).replace("\\", "/").lstrip("./")


def _safe_repo_file(raw_path, root):
    target = gate.repo_path(raw_path, root)
    root_real = os.path.realpath(root)
    target_real = os.path.realpath(target)
    try:
        inside = os.path.commonpath((root_real, target_real)) == root_real
    except ValueError:
        inside = False
    if not inside or os.path.islink(target) or not os.path.isfile(target_real):
        return None, False
    return target_real, True


def _load_toml_bytes(raw):
    try:
        import tomllib  # type: ignore[import-not-found]  # noqa: PLC0415
    except ImportError as exc:
        raise _FatalError(M("right.toml_unavailable")) from exc
    return tomllib.loads(raw.decode("utf-8"))


def _parse_doc(path, fmt, real_path, toml_loader=None):
    try:
        with open(real_path, "rb") as fh:
            raw = fh.read()
        data = json.loads(raw.decode("utf-8")) if fmt == "json" else (toml_loader or _load_toml_bytes)(raw)
    except _FatalError:
        raise
    except (OSError, ValueError) as exc:
        return None, M("right.parse_error", path=path, format=fmt, error=str(exc))
    if not isinstance(data, dict):
        return None, M("right.parse_error", path=path, format=fmt, error="top-level value must be a table/object")
    return data, None


def _lookup_field(doc, dotted):
    parts = dotted.split(".")
    if not dotted or any(not p for p in parts):
        return None, False
    cur: Any = doc
    for seg in parts:
        if not isinstance(cur, dict) or seg not in cur:
            return None, False
        cur = cur[seg]
    return cur, True


def _missing_str_fields(entry, fields):
    for field_name in fields:
        val = entry.get(field_name)
        if not isinstance(val, str) or not val.strip():
            return M("right.entry_missing_field", field=field_name, entry=entry)
    return None


def _decl_shape_error(entry, default_equals):
    if not isinstance(entry, dict):
        return [M("right.entry_not_object", entry=entry)], None
    if entry.get("optional"):
        return [M("gate.optional_forbidden", name=str(entry.get("path") or entry))], None
    miss = _missing_str_fields(entry, ("path", "format", "field"))
    if miss is not None:
        return [miss], None
    path, fmt, field_path = entry["path"].strip(), entry["format"].strip(), entry["field"].strip()
    if fmt not in SUPPORTED_FORMATS:
        return [M("right.bad_format", path=path, format=fmt)], None
    want = entry.get("equals", default_equals)
    if not isinstance(want, str) or not want.strip():
        return [M("right.missing_equals", path=path, field=field_path)], None
    return [], (path, fmt, field_path, want.strip(), bool(entry.get("spdx", False)))


def _compare_field_value(path, field_path, val, want, is_spdx):
    if not isinstance(val, str) or not val.strip():
        return [M("right.field_not_string", path=path, field=field_path, actual=repr(val))]
    actual = val.strip()
    if is_spdx and not parse_spdx(want):
        return [M("right.spdx_invalid", path=path, field=field_path, value=want)]
    if is_spdx and not parse_spdx(actual):
        return [M("right.spdx_invalid", path=path, field=field_path, value=actual)]
    if actual != want:
        return [M("right.field_mismatch", path=path, field=field_path, expected=want, actual=actual)]
    return []


def _check_declaration(entry, default_equals, root, toml_loader):
    probs, parsed = _decl_shape_error(entry, default_equals)
    if parsed is None:
        return probs
    path, fmt, field_path, want, is_spdx = parsed
    real_path, ok = _safe_repo_file(path, root)
    if not ok or real_path is None:
        return [M("right.file_missing", path=path)]
    doc, err = _parse_doc(path, fmt, real_path, toml_loader=toml_loader)
    if err is not None:
        return [err]
    val, found = _lookup_field(doc, field_path)
    if not found:
        return [M("right.field_missing", path=path, field=field_path)]
    return _compare_field_value(path, field_path, val, want, is_spdx)


def _copy_shape_error(entry):
    if not isinstance(entry, dict):
        return [M("right.entry_not_object", entry=entry)], None
    if entry.get("optional"):
        return [M("gate.optional_forbidden", name=str(entry.get("dst") or entry.get("src") or entry))], None
    miss = _missing_str_fields(entry, ("src", "dst"))
    if miss is not None:
        return [miss], None
    if entry.get("nonempty", True) is not True:
        return [M("right.entry_missing_field", field="nonempty=true", entry=entry)], None
    src, dst = entry["src"].strip(), entry["dst"].strip()
    if _norm_rel(src) == _norm_rel(dst):
        return [M("right.copy_self", path=src)], None
    return [], (src, dst)


def _check_copy(entry, hasher, root):
    probs, parsed = _copy_shape_error(entry)
    if parsed is None:
        return probs
    src, dst = parsed
    src_real, src_ok = _safe_repo_file(src, root)
    if not src_ok or src_real is None:
        return [M("right.file_missing", path=src)]
    dst_real, dst_ok = _safe_repo_file(dst, root)
    if not dst_ok or dst_real is None:
        return [M("right.file_missing", path=dst)]
    if src_real == dst_real:
        return [M("right.copy_self", path=src)]
    for rel, real_p in ((src, src_real), (dst, dst_real)):
        if os.path.getsize(real_p) == 0:
            return [M("right.copy_empty", path=rel)]
    h_src, h_dst = hasher(src_real), hasher(dst_real)
    if h_src != h_dst:
        return [M("right.copy_mismatch", src=src, dst=dst, expected=h_src[:12], actual=h_dst[:12])]
    return []


def _spec_header_problems(spec):
    if not isinstance(spec, dict):
        return [M("right.spec_broken", name="right.json", error="spec must be an object")]
    schema = spec.get("schema", 1)
    if isinstance(schema, bool) or schema != 1:
        return [M("right.spec_broken", name="right.json", error="schema must be 1")]
    if "default_equals" in spec:
        d = spec["default_equals"]
        if not isinstance(d, str) or not d.strip():
            return [M("right.bad_default_equals")]
    for key in ("declarations", "copies"):
        if key in spec and not isinstance(spec[key], list):
            return [M("right.spec_broken", name="right.json", error="%s must be a list" % key)]
    return []


def check(spec, hasher=gate.sha256_file, root=None, toml_loader=None):
    """Evaluate declarations and file-copy consistency; return `(problems, [])`."""
    root = repo() if root is None else root
    header = _spec_header_problems(spec)
    if header:
        return header, []
    decls = spec.get("declarations") or []
    copies = spec.get("copies") or []
    if not decls and not copies:
        return [M("right.empty")], []
    default_equals = spec.get("default_equals")
    problems = []
    for entry in decls:
        problems += _check_declaration(entry, default_equals, root, toml_loader)
    for entry in copies:
        problems += _check_copy(entry, hasher, root)
    return problems, []


def _spec_count(spec):
    return len(spec.get("declarations") or []) + len(spec.get("copies") or [])


def main(argv):
    spec, _name, rc = load_gate_spec(
        argv, "REFLECT_RIGHTS",
        off_msg=lambda n: M("right.off", name=n),
        missing_msg=lambda n: M("right.explicit_spec_missing", name=n),
        broken_msg=lambda n, err: M("right.spec_broken", name=n, error=err),
    )
    if rc is not None:
        return rc
    try:
        probs, skips = check(spec)
    except _FatalError as exc:
        return fatal(exc.msg)
    return finish(M("right.title"), list(probs) + list(skips), M("right.ok", count=_spec_count(spec)))


_CARGO_TOML = "Cargo.toml"
_PKG_JSON = "package.json"
_AGPL = "AGPL-3.0-only"
_PKG_LIC = "package.license"
_RIGHT_JSON = "right.json"


def _seed_right_fixture():
    import atexit  # noqa: PLC0415
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415

    d = tempfile.mkdtemp()
    atexit.register(shutil.rmtree, d, True)
    os.makedirs(os.path.join(d, "dist"))
    lic = b"GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3\n"
    open(os.path.join(d, "LICENSE"), "wb").write(lic)
    open(os.path.join(d, "dist", "LICENSE"), "wb").write(lic)
    open(os.path.join(d, "dist", "bad-LICENSE"), "wb").write(b"MIT\n")
    open(os.path.join(d, "dist", "empty-LICENSE"), "wb").write(b"")
    open(os.path.join(d, _CARGO_TOML), "w", encoding="utf-8").write(
        f'[package]\nname = "demo"\nlicense = "{_AGPL}"\n')
    open(os.path.join(d, _PKG_JSON), "w", encoding="utf-8").write(
        f'{{"name": "demo", "license": "{_AGPL}"}}\n')
    open(os.path.join(d, "bad.json"), "w", encoding="utf-8").write(
        '{"name": "demo", "license": "MIT"}\n')
    open(os.path.join(d, "bad-spdx.json"), "w", encoding="utf-8").write(
        '{"name": "demo", "license": "MIT OR"}\n')
    return d


def _spdx_cases():
    r_cfg = "R.json"
    return [
        ("right.resolve_spec",
         lambda: gate.resolve_spec(["--spec", "x.json"], r_cfg, _RIGHT_JSON) == ("x.json", True)
         and gate.resolve_spec([], r_cfg, _RIGHT_JSON) == (r_cfg, True)
         and gate.resolve_spec([], "", _RIGHT_JSON) == (_RIGHT_JSON, False)),
        ("★ right.spdx_syntax",
         lambda: parse_spdx(_AGPL)
         and parse_spdx("(MIT OR Apache-2.0 WITH LLVM-exception) AND BSD-3-Clause")
         and not parse_spdx("")
         and not parse_spdx("MIT OR")
         and not parse_spdx("MIT Apache-2.0")
         and not parse_spdx("(MIT OR GPL-3.0) WITH Ex")),
    ]


def _toml_unavail_rejected(d):
    spec = {"schema": 1, "declarations": [
        {"path": _CARGO_TOML, "format": "toml", "field": _PKG_LIC, "equals": _AGPL},
    ]}

    def _raise(_raw):
        raise _FatalError(M("right.toml_unavailable"))

    try:
        check(spec, root=d, toml_loader=_raise)
    except _FatalError as exc:
        return exc.msg.code == "right.toml_unavailable"
    return False


def _cases():
    d = _seed_right_fixture()
    good = {
        "schema": 1,
        "default_equals": _AGPL,
        "declarations": [
            {"path": _CARGO_TOML, "format": "toml", "field": _PKG_LIC, "spdx": True},
            {"path": _PKG_JSON, "format": "json", "field": "license", "spdx": True},
        ],
        "copies": [{"src": "LICENSE", "dst": "dist/LICENSE"}],
    }
    cases = _spdx_cases()
    cases += [
        ("right.ok", lambda: check(good, root=d)[0] == [] and check(good, root=d)[1] == []),
        ("★ right.optional_forbidden",
         lambda: [p.code for p in check({"declarations": [{"path": _PKG_JSON, "optional": True}]}, root=d)[0]]
         == ["gate.optional_forbidden"]),
        ("★ right.field_mismatch",
         lambda: [p.code for p in check({"default_equals": _AGPL, "declarations": [
             {"path": "bad.json", "format": "json", "field": "license"}]}, root=d)[0]]
         == ["right.field_mismatch"]),
        ("★ right.field_missing",
         lambda: [p.code for p in check({"declarations": [
             {"path": _PKG_JSON, "format": "json", "field": _PKG_LIC, "equals": "MIT"}]}, root=d)[0]]
         == ["right.field_missing"]),
        ("★ right.spdx_invalid",
         lambda: [p.code for p in check({"declarations": [
             {"path": "bad-spdx.json", "format": "json", "field": "license", "equals": "MIT OR", "spdx": True}]},
             root=d)[0]] == ["right.spdx_invalid"]),
        ("★ right.copy_mismatch",
         lambda: [p.code for p in check({"copies": [{"src": "LICENSE", "dst": "dist/bad-LICENSE"}]}, root=d)[0]]
         == ["right.copy_mismatch"]),
        ("★ right.copy_self_and_empty",
         lambda: [p.code for p in check({"copies": [{"src": "LICENSE", "dst": "LICENSE"}]}, root=d)[0]]
         == ["right.copy_self"]
         and [p.code for p in check({"copies": [{"src": "LICENSE", "dst": "dist/empty-LICENSE"}]}, root=d)[0]]
         == ["right.copy_empty"]),
        ("★ right.empty",
         lambda: [p.code for p in check({"schema": 1, "declarations": [], "copies": []}, root=d)[0]]
         == ["right.empty"]),
        ("★ right.toml_unavailable_fatal", lambda: _toml_unavail_rejected(d)),
    ]
    return cases


GATE = meta(
    "Rights consistency gate",
    "structured declarations (JSON/TOML) and distributed copy consistency",
    knobs=("REFLECT_RIGHTS",),
    off_reason="repos without a rights spec do not need it: spec unset => explicitly not enabled",
)

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], M("gate.title.right"), _cases, main))
