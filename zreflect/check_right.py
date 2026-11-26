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
_V2_FORMATS = ("json", "toml", "text")
_REF_FORMATS = ("json", "toml")
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


def _parse_field_spec(field_val, schema):
    if isinstance(field_val, str) and field_val.strip():
        s = field_val.strip()
        return s, s
    if schema == 2 and isinstance(field_val, list) and field_val and all(isinstance(x, str) and x for x in field_val):
        return list(field_val), json.dumps(field_val, ensure_ascii=False)
    return None, None


def _lookup_field(doc, field_spec):
    if isinstance(field_spec, list):
        parts = field_spec
    elif isinstance(field_spec, str) and field_spec.startswith("/"):
        parts = [p.replace("~1", "/").replace("~0", "~") for p in field_spec[1:].split("/")]
    else:
        parts = field_spec.split(".")
    if not parts or any(not p for p in parts):
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


def _resolve_ref_value(owner_path, ref, root, toml_loader, schema):
    if not isinstance(ref, dict):
        return [M("right.bad_ref", path=owner_path, ref=ref)], None
    if ref.get("optional"):
        return [M("gate.optional_forbidden", name=str(ref.get("path") or owner_path))], None
    r_path = ref.get("path")
    r_fmt = ref.get("format")
    r_field, r_label = _parse_field_spec(ref.get("field"), schema)
    if (not isinstance(r_path, str) or not r_path.strip()
            or not isinstance(r_fmt, str) or r_fmt.strip() not in _REF_FORMATS or r_field is None):
        return [M("right.bad_ref", path=owner_path, ref=ref)], None
    rp_s, rf_s = r_path.strip(), r_fmt.strip()
    real_p, ok = _safe_repo_file(rp_s, root)
    if not ok or real_p is None:
        return [M("right.file_missing", path=rp_s)], None
    doc, err = _parse_doc(rp_s, rf_s, real_p, toml_loader=toml_loader)
    if err is not None:
        return [err], None
    val, found = _lookup_field(doc, r_field)
    if not found:
        return [M("right.field_missing", path=rp_s, field=r_label)], None
    return [], val


def _resolve_expected_value(path, field_label, entry, default_equals, root, toml_loader, schema):
    if "equals_from" in entry:
        if schema != 2:
            return [M("right.spec_broken", name=_RIGHT_JSON, error="equals_from requires schema 2")], None
        if "equals" in entry:
            return [M("right.spec_broken", name=_RIGHT_JSON, error="equals and equals_from are mutually exclusive")], None
        probs, val = _resolve_ref_value(path, entry["equals_from"], root, toml_loader, schema)
        if probs:
            return probs, None
        if not isinstance(val, str) or not val.strip():
            ref = entry["equals_from"]
            _, r_lbl = _parse_field_spec(ref.get("field"), schema)
            return [M("right.field_not_string", path=ref["path"].strip(), field=r_lbl or "field", actual=repr(val))], None
        return [], val.strip()
    want = entry.get("equals", default_equals)
    if not isinstance(want, str) or not want.strip():
        return [M("right.missing_equals", path=path, field=field_label)], None
    return [], want.strip()


def _decl_shape_error(entry, schema):
    if not isinstance(entry, dict):
        return [M("right.entry_not_object", entry=entry)], None
    if entry.get("optional"):
        return [M("gate.optional_forbidden", name=str(entry.get("path") or entry))], None
    miss = _missing_str_fields(entry, ("path", "format"))
    if miss is not None:
        return [miss], None
    path, fmt = entry["path"].strip(), entry["format"].strip()
    allowed = _V2_FORMATS if schema == 2 else SUPPORTED_FORMATS
    if fmt not in allowed:
        return [M("right.bad_format", path=path, format=fmt)], None
    if fmt == "text":
        return [], (path, fmt, None, "")
    field_spec, field_label = _parse_field_spec(entry.get("field"), schema)
    if field_spec is None:
        return [M("right.entry_missing_field", field="field", entry=entry)], None
    return [], (path, fmt, field_spec, field_label)


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


def _extract_ref_needles(path, val):
    if isinstance(val, str) and val.strip():
        return [], [val.strip()]
    if isinstance(val, list) and val and all(isinstance(x, str) and x.strip() for x in val):
        return [], [x.strip() for x in val]
    return [M("right.bad_contains", path=path)], []


def _collect_contains_from(path, cf, root, toml_loader, schema):
    refs = cf if isinstance(cf, list) else [cf]
    if not refs:
        return [M("right.bad_contains", path=path)], []
    out = []
    for ref in refs:
        probs, val = _resolve_ref_value(path, ref, root, toml_loader, schema)
        if probs:
            return probs, []
        err, got = _extract_ref_needles(path, val)
        if err:
            return err, []
        out.extend(got)
    return [], out


def _collect_contains_needles(path, entry, root, toml_loader, schema):
    needles: list[str] = []
    if "contains" in entry:
        raw = entry["contains"]
        if not isinstance(raw, list) or not raw or any(not isinstance(x, str) or not x.strip() for x in raw):
            return [M("right.bad_contains", path=path)], None
        needles.extend(x.strip() for x in raw)
    if "contains_from" in entry:
        err, got = _collect_contains_from(path, entry["contains_from"], root, toml_loader, schema)
        if err:
            return err, None
        needles.extend(got)
    if not needles:
        return [M("right.bad_contains", path=path)], None
    return [], needles


def _check_text_notice(entry, root, toml_loader, schema):
    if not isinstance(entry, dict):
        return [M("right.entry_not_object", entry=entry)]
    if entry.get("optional"):
        return [M("gate.optional_forbidden", name=str(entry.get("path") or entry))]
    miss = _missing_str_fields(entry, ("path",))
    if miss is not None:
        return [miss]
    path = entry["path"].strip()
    probs, needles = _collect_contains_needles(path, entry, root, toml_loader, schema)
    if probs or needles is None:
        return probs
    real_path, ok = _safe_repo_file(path, root)
    if not ok or real_path is None:
        return [M("right.file_missing", path=path)]
    try:
        with open(real_path, "rb") as fh:
            text = fh.read().decode("utf-8")
    except (OSError, ValueError) as exc:
        return [M("right.parse_error", path=path, format="text", error=str(exc))]
    if not text.strip():
        return [M("right.text_empty", path=path)]
    return [M("right.text_missing_notice", path=path, expected=n) for n in needles if n not in text]


def _check_declaration(entry, default_equals, root, toml_loader, schema=1):
    probs, parsed = _decl_shape_error(entry, schema)
    if parsed is None:
        return probs
    path, fmt, field_spec, field_label = parsed
    if fmt == "text":
        return _check_text_notice(entry, root, toml_loader, schema)
    want_probs, want = _resolve_expected_value(path, field_label, entry, default_equals, root, toml_loader, schema)
    if want_probs or want is None:
        return want_probs
    real_path, ok = _safe_repo_file(path, root)
    if not ok or real_path is None:
        return [M("right.file_missing", path=path)]
    doc, err = _parse_doc(path, fmt, real_path, toml_loader=toml_loader)
    if err is not None:
        return [err]
    val, found = _lookup_field(doc, field_spec)
    if not found:
        return [M("right.field_missing", path=path, field=field_label)]
    return _compare_field_value(path, field_label, val, want, bool(entry.get("spdx", False)))


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
    if isinstance(schema, bool) or schema not in (1, 2):
        return [M("right.spec_broken", name="right.json", error="schema must be 1 or 2")]
    if schema == 1 and "notices" in spec:
        return [M("right.spec_broken", name="right.json", error="notices requires schema 2")]
    if "default_equals" in spec:
        d = spec["default_equals"]
        if not isinstance(d, str) or not d.strip():
            return [M("right.bad_default_equals")]
    for key in ("declarations", "copies", "notices"):
        if key in spec and not isinstance(spec[key], list):
            return [M("right.spec_broken", name="right.json", error="%s must be a list" % key)]
    return []


def check(spec, hasher=gate.sha256_file, root=None, toml_loader=None):
    """Evaluate declarations, file-copy, and notice consistency; return `(problems, [])`."""
    root = repo() if root is None else root
    header = _spec_header_problems(spec)
    if header:
        return header, []
    schema = spec.get("schema", 1)
    decls = spec.get("declarations") or []
    copies = spec.get("copies") or []
    notices = spec.get("notices") or []
    if not decls and not copies and not notices:
        return [M("right.empty")], []
    default_equals = spec.get("default_equals")
    problems = []
    for entry in decls:
        problems += _check_declaration(entry, default_equals, root, toml_loader, schema=schema)
    for entry in copies:
        problems += _check_copy(entry, hasher, root)
    for entry in notices:
        problems += _check_text_notice(entry, root, toml_loader, schema)
    return problems, []


def _spec_count(spec):
    return len(spec.get("declarations") or []) + len(spec.get("copies") or []) + len(spec.get("notices") or [])


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
    open(os.path.join(d, "package-lock.json"), "w", encoding="utf-8").write(
        json.dumps({"packages": {"node_modules/foo.bar": {"version": "1.2.3", "license": "MIT"}}}) + "\n")
    open(os.path.join(d, "package-lock-bumped.json"), "w", encoding="utf-8").write(
        json.dumps({"packages": {"node_modules/foo.bar": {"version": "2.0.0", "license": "MIT"}}}) + "\n")
    open(os.path.join(d, "licenses.json"), "w", encoding="utf-8").write(
        json.dumps({"foo.bar": {"version": "1.2.3", "license": "MIT", "copyright": "Copyright (c) 2026 Foo"}}) + "\n")
    open(os.path.join(d, "NOTICE"), "w", encoding="utf-8").write(
        "MIT License\n\nCopyright (c) 2026 Foo\nPermission is hereby granted...\n")
    open(os.path.join(d, "NOTICE-no-copy"), "w", encoding="utf-8").write("MIT License\nPermission is hereby granted...\n")
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


def _v2_cases(d):
    lock_p, lic_p = "package-lock.json", "licenses.json"
    v2_good = {
        "schema": 2,
        "declarations": [
            {
                "path": lic_p, "format": "json", "field": ["foo.bar", "version"],
                "equals_from": {"path": lock_p, "format": "json", "field": ["packages", "node_modules/foo.bar", "version"]},
            },
            {
                "path": lic_p, "format": "json", "field": ["foo.bar", "license"], "spdx": True,
                "equals_from": {"path": lock_p, "format": "json", "field": "/packages/node_modules~1foo.bar/license"},
            },
            {"path": "NOTICE", "format": "text", "contains": ["MIT License"]},
        ],
        "notices": [
            {"path": "NOTICE", "contains_from": {"path": lic_p, "format": "json", "field": ["foo.bar", "copyright"]}},
        ],
    }
    stale_lock = {
        "schema": 2,
        "declarations": [{
            "path": lic_p, "format": "json", "field": ["foo.bar", "version"],
            "equals_from": {"path": "package-lock-bumped.json", "format": "json",
                            "field": ["packages", "node_modules/foo.bar", "version"]},
        }],
    }
    return [
        ("★ right.v2_equals_from_and_paths",
         lambda: check(v2_good, root=d)[0] == []
         and [p.code for p in check(stale_lock, root=d)[0]] == ["right.field_mismatch"]),
        ("★ right.v2_text_notice_guards",
         lambda: [p.code for p in check({"schema": 2, "notices": [
             {"path": "NOTICE-no-copy", "contains_from": {"path": lic_p, "format": "json", "field": ["foo.bar", "copyright"]}},
         ]}, root=d)[0]] == ["right.text_missing_notice"]
         and [p.code for p in check({"schema": 2, "declarations": [
             {"path": "dist/empty-LICENSE", "format": "text", "contains": ["MIT"]}]}, root=d)[0]] == ["right.text_empty"]
         and [p.code for p in check({"schema": 2, "notices": [
             {"path": "NOTICE", "contains": ["   "]}]}, root=d)[0]] == ["right.bad_contains"]),
        ("★ right.v2_no_silent_downgrade",
         lambda: [p.code for p in check({"schema": 1, "default_equals": "1.2.3", "declarations": [
             {"path": lic_p, "format": "json", "field": "foo.bar.version",
              "equals_from": {"path": lock_p, "format": "json", "field": "packages"}}]}, root=d)[0]] == ["right.spec_broken"]
         and [p.code for p in check({"schema": 1, "declarations": [
             {"path": "NOTICE", "format": "text", "contains": ["MIT"]}]}, root=d)[0]] == ["right.bad_format"]
         and [p.code for p in check({"schema": 1, "declarations": [
             {"path": lic_p, "format": "json", "field": ["foo.bar", "version"], "equals": "1.2.3"}]}, root=d)[0]]
         == ["right.entry_missing_field"]
         and [p.code for p in check({"schema": 1, "notices": []}, root=d)[0]] == ["right.spec_broken"]),
    ]


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
    cases += _v2_cases(d)
    return cases


GATE = meta(
    "Rights consistency gate",
    "structured declarations (JSON/TOML) and distributed copy consistency",
    knobs=("REFLECT_RIGHTS",),
    off_reason="repos without a rights spec do not need it: spec unset => explicitly not enabled",
)

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], M("gate.title.right"), _cases, main))
