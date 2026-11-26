#!/usr/bin/env python3
"""Zero-language message core (`M(code, **params)`) and machine-line protocol (`ROWS`)."""
from __future__ import annotations

import json
import os
import re
import sys
from types import MappingProxyType
from typing import Any, NamedTuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import knobs  # noqa: E402

BUILTIN_PACKS = "zreflect/lang"
CJK_LO, CJK_HI = 0x4E00, 0x9FFF
PROSE_MARKS = ("\u2605", "\u00b7", "\u2139", "\u26a0", "\ufe0f",
               "\u2192", "\u2190", "\u2194", "\u2026", "\u00a7")
PROSE_EXEMPT = (
    "历史|退役|留档|曾经的|当年的|当时的|之前那份|此前|当时|收口前",
    "|已翻案|更正|是错的|误读|推翻|曾写|已作废|不再成立",
    'heading.startswith("## 附")',
    "sha|hash|校验|指纹",
    "for sep in (" + chr(0x3002),
)
_MAX_VALUE = 40

LINE_BREAKS = ("\r\n", "\n", "\r", "\x0b", "\x0c",
               "\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029")
GUARD = "\\"


class Row(NamedTuple):
    """Machine-line grammar and emit frame."""
    kind: str
    grammar: str
    frame: str


ROWS = (
    Row("off", r"^OFF:", "OFF: %s"),
    Row("fatal", r"^FATAL:", "FATAL: %s"),
    Row("skip", r"^SKIP:", "SKIP: %s"),
    Row("down", r"^DOWN: ", "DOWN: %s"),
    Row("pass", r"^PASS \| ", "PASS | %s"),
    Row("fail", r"^fail \| ", "fail | %s"),
    Row("note", r"^note \| ", "note | %s"),
    Row("machine_summary",
        r"^=== [0-9]+ PASS / [0-9]+ FAIL ===$", "=== %d PASS / %d FAIL ==="),
    Row("human_summary",
        r"^=== (?!(?:[0-9]+ PASS / [0-9]+ FAIL) ===$).* ===$", "=== %s ==="),
)
_KIND = {r.kind for r in ROWS}
_BY_KIND = {r.kind: r for r in ROWS}
_EMITTABLE = _KIND - {"machine_summary"}
_SHARP = re.compile(r"^(?:OFF:|FATAL:|SKIP:|DOWN: |PASS \| |fail \| |note \| "
                    r"|=== .* ===$)")
_BROAD = re.compile(r"^[A-Z][A-Z0-9_]*:")


def _body(part):
    for sep in LINE_BREAKS:
        if part.endswith(sep):
            return part[:-len(sep)]
    return part


def is_summary(line):
    """Return True if `line` is the exact `=== N PASS / M FAIL ===` summary."""
    return re.match(_BY_KIND["machine_summary"].grammar, line) is not None


def _kind_of(line):
    for r in ROWS:
        if re.match(r.grammar, line):
            return r.kind
    return None


def scan(text, keepends=False):
    """Return `((lineno, kind, line), ...)` for all machine lines in `text`."""
    out = []
    for i, part in enumerate((text or "").splitlines(keepends=True), 1):
        body = part if keepends else _body(part)
        kind = _kind_of(_body(part))
        if kind:
            out.append((i, kind, body))
    return tuple(out)


def clean(text, kinds=None, preserve_first=False):
    """Neutralize forged machine lines in rendered text with leading `GUARD`."""
    parts = (text or "").splitlines(keepends=True)
    hits, out = [], []
    for i, part in enumerate(parts, 1):
        body = _body(part)
        if not (preserve_first and i == 1) and _SHARP.match(body):
            kind = _kind_of(body)
            if kinds is None or kind in kinds:
                out.append(GUARD + part)
                hits.append((i, kind, body))
                continue
        out.append(part)
    return "".join(out), tuple(hits)


def emit(kind, body=""):
    """Emit a single machine line of `kind`, neutralizing any extra lines in `body`."""
    if kind not in _EMITTABLE:
        raise KeyError("machine.emit_undeclared_kind(kind=%r)" % (kind,))
    text = _BY_KIND[kind].frame % (body,)
    cleaned, _hits = clean(text, preserve_first=True)
    return cleaned


def emit_summary(passed, failed):
    """Format the integer `=== N PASS / M FAIL ===` summary line."""
    if not isinstance(passed, int) or not isinstance(failed, int):
        raise TypeError("machine.emit_summary_needs_ints")
    return "=== %d PASS / %d FAIL ===" % (passed, failed)


def reject(value):
    """Return `(lineno, line)` if a language-pack value contains a machine-like prefix."""
    for i, ln in enumerate((value or "").splitlines(), 1):
        if _BROAD.match(ln) or _SHARP.match(ln):
            return i, ln
    return None


def han(text):
    """Return True if `text` contains any CJK Unified Ideograph."""
    return any(CJK_LO <= ord(c) <= CJK_HI for c in (text or ""))


def non_ascii_prose(text):
    """Return `[(char, offset)]` for non-ASCII chars excluding protocol `PROSE_MARKS`."""
    return [(c, i) for i, c in enumerate(text or "")
            if ord(c) > 127 and c not in PROSE_MARKS]


def prose_exempt(line):
    """Return True if `line` contains a declared criterion-vocabulary exemption."""
    return any(mark in line for mark in PROSE_EXEMPT)


class MissingPack(Exception):
    """Raised when a requested language pack is missing, corrupt, or invalid."""

    def __init__(self, code, **params):
        table = params.pop("_table", None)
        self.code = code
        self.params = params
        super().__init__(_render(code, params, table))


class PacksUnreadable(RuntimeError):
    """Raised when `pack_dir()` cannot be read due to OS/permission errors."""


def _fmt_value(v):
    s = repr(v)
    if len(s) > _MAX_VALUE:
        s = s[:_MAX_VALUE - 1] + "..." + s[-1] if s[-1] in "\"'" else s[:_MAX_VALUE] + "..."
    return s


def _render(code, params, table):
    if table is not None and code in table:
        return table[code] % params
    if not params:
        return str(code)
    inner = ", ".join("%s=%s" % (k, _fmt_value(params[k])) for k in sorted(params))
    return "%s(%s)" % (code, inner)


class _FmtProbe(dict):
    def __missing__(self, key):
        return 1


def _validate(table, lang):
    if not isinstance(table, dict) or not table:
        raise MissingPack("i18n.pack_empty", lang=lang)
    probe = _FmtProbe()
    for code, value in table.items():
        if not isinstance(value, str):
            raise MissingPack("i18n.value_not_string", lang=lang, key=code)
        try:
            value % probe
        except (TypeError, ValueError, KeyError) as exc:
            raise MissingPack("i18n.value_not_string", lang=lang, key=code) from exc
        hit = reject(value)
        if hit:
            cur = _DEFAULT[0].table if _DEFAULT else None
            raise MissingPack("i18n.value_masquerades_contract", _table=cur,
                              lang=lang, key=code, line=hit[0], value=value[:40])


def pack_dir():
    """Resolve language-pack base dir (`REFLECT_I18N` or bundled `zreflect/lang`)."""
    val = (knobs.raw("REFLECT_I18N") or "").strip()
    if not val:
        tool_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        return os.path.join(tool_root, BUILTIN_PACKS)
    if os.path.isabs(val):
        return val
    return os.path.join(knobs._repo_root(), val)


def _load_json_dict(filepath, code, **params):
    try:
        with open(filepath, encoding="utf-8") as fh:
            part = json.load(fh)
    except (OSError, ValueError) as e:
        raise MissingPack(code, error=e, **params) from e
    if not isinstance(part, dict):
        raise MissingPack(code, error="not an object", **params)
    return part


def load_pack(lang):
    """Load merged `{code: template}` for `lang` from `<lang>.json` (or `<lang>/*.json`)."""
    base = pack_dir()
    table = {}
    shard_dir = os.path.join(base, lang)
    if os.path.isdir(shard_dir):
        for n in sorted(os.listdir(shard_dir)):
            if n.endswith(".json"):
                table.update(_load_json_dict(
                    os.path.join(shard_dir, n), "i18n.shard_unreadable",
                    lang=lang, path=os.path.join(shard_dir, n)))
    single = os.path.join(base, "%s.json" % lang)
    if os.path.exists(single):
        table.update(_load_json_dict(single, "i18n.single_unreadable", lang=lang, path=single))
    return table


def _looks_like_pack(path):
    try:
        data = json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(data, dict) or not data:
        return False
    dotted = sum(1 for k in data if isinstance(k, str) and "." in k)
    return dotted >= max(1, len(data) // 2)


def installed_langs():
    """Discover installed language names under `pack_dir()`."""
    base = pack_dir()
    out = set()
    try:
        for n in sorted(os.listdir(base)):
            p = os.path.join(base, n)
            if os.path.isdir(p) and any(
                    x.endswith(".json") and _looks_like_pack(os.path.join(p, x))
                    for x in os.listdir(p)):
                out.add(n)
            elif n.endswith(".json") and _looks_like_pack(p):
                out.add(n[:-len(".json")])
    except OSError as e:
        raise PacksUnreadable(str(e)) from e
    return sorted(out)


def a_pack_lang():
    """Return first installed pack name for self-evidence, or `None`."""
    langs = installed_langs()
    return langs[0] if langs else None


class Catalog:
    """Immutable loaded language pack (or null pack when `lang=None`)."""

    lang: str | None
    table: MappingProxyType[str, str] | None
    __slots__ = ("lang", "table")

    def __init__(self, lang, table, _sealed=False):
        if not _sealed:
            raise TypeError("Construct via Catalog.null() or Catalog.load()")
        object.__setattr__(self, "lang", lang)
        object.__setattr__(self, "table", table)

    def __setattr__(self, name, value):
        raise AttributeError("Catalog is immutable")

    @classmethod
    def null(cls):
        return cls(None, None, _sealed=True)

    @classmethod
    def load(cls, lang, tables=None):
        if lang is None:
            return cls.null()
        if tables is not None:
            table = tables.get(lang)
            if table is None:
                raise MissingPack("i18n.injected_lang_absent", lang=lang)
        else:
            table = load_pack(lang)
            if not table:
                base = pack_dir()
                raise MissingPack("i18n.pack_absent", lang=lang,
                                  single=os.path.join(base, "%s.json" % lang),
                                  directory=os.path.join(base, lang))
        _validate(table, lang)
        return cls(lang, MappingProxyType(dict(table)), _sealed=True)

    def render(self, code, params):
        return _render(code, params, self.table)

    def msg(self, code, **params):
        return Message(code, params, self)


class Message(str):
    """Rendered string carrying `.code`, `.params`, and `.forged`."""

    code: str
    params: dict[str, Any]
    forged: tuple[tuple[int, str | None, str], ...]
    __slots__ = ("code", "params", "forged")

    def __new__(cls, code, params, catalog):
        raw = catalog.render(code, params)
        text, forged = clean(raw)
        obj = super().__new__(cls, text)
        obj.forged = forged
        return obj

    def __init__(self, code, params, catalog):
        self.code = code
        self.params = params


NULL = object()
_DEFAULT = [Catalog.null()]


def _resolve_lang(lang):
    if lang is NULL:
        return None
    if lang is not None:
        return lang
    return (knobs.raw("REFLECT_LANG") or "").strip() or None


class _Bound:
    def __init__(self, catalog):
        self.catalog = catalog
        self.prev = None

    def __enter__(self):
        self.prev = _DEFAULT[0]
        _DEFAULT[0] = self.catalog
        return self.catalog

    def __exit__(self, *exc):
        _DEFAULT[0] = self.prev
        return False


def bind(catalog):
    """Scoped context manager temporarily switching the active Catalog."""
    if isinstance(catalog, Catalog):
        return _Bound(catalog)
    return _Bound(Catalog.load(_resolve_lang(catalog)))


def activate(lang=None, tables=None):
    """Activate process-wide Catalog from `lang` (or `REFLECT_LANG`)."""
    cat = Catalog.load(_resolve_lang(lang), tables)
    _DEFAULT[0] = cat
    return cat.lang


def M(code, **params):
    """Render `code` with `params` against the active Catalog."""
    return _DEFAULT[0].msg(code, **params)


def _raises(fn):
    try:
        fn()
    except (MissingPack, KeyError, TypeError, AttributeError):
        return True
    return False


def _broken_pack_case():
    import tempfile  # noqa: PLC0415
    with tempfile.TemporaryDirectory() as d:
        with open(os.path.join(d, "xx.json"), "w", encoding="utf-8") as fh:
            fh.write("{ not json")
        prev = os.environ.get("REFLECT_I18N")
        os.environ["REFLECT_I18N"] = d
        try:
            return _raises(lambda: load_pack("xx"))
        finally:
            if prev is None:
                os.environ.pop("REFLECT_I18N", None)
            else:
                os.environ["REFLECT_I18N"] = prev


def _cases():
    fake = {"replay.no_cmd": "`%(key)s` has no replay command"}
    cat = Catalog.load("en", {"en": fake})
    with bind(NULL):
        null_quoted = str(M("probe.code", command="find . -name '*.md' | wc -l"))
    breaks = [("\n", "LF"), ("\r", "CR"), ("\x0b", "VT"), ("\x1c", "FS"), ("\u2029", "PS")]
    return (
        [
            ("i18n.null_no_params",
             lambda: _as_null(lambda: str(M("gate.title.facts")) == "gate.title.facts")),
            ("i18n.null_with_params",
             lambda: _as_null(lambda: str(M("replay.no_cmd", key="py_lines"))
                              == "replay.no_cmd(key='py_lines')")),
            ("★ i18n.repr_quotes",
             lambda: null_quoted.count("'") >= 2 and null_quoted.startswith("probe.code(")),
            ("★ i18n.pack_empty_rejected", lambda: _raises(lambda: _validate({}, "xx"))),
            ("★ i18n.pack_masquerades_contract",
             lambda: _raises(lambda: _validate({"ok": "OFF: not configured"}, "xx"))),
            ("★ i18n.missing_pack_raises", lambda: _raises(lambda: Catalog.load("xx", {"zh": {}}))),
            ("★ i18n.broken_pack_raises", lambda: _broken_pack_case()),
            ("i18n.pack_applied",
             lambda: _with_cat(cat, lambda: str(M("replay.no_cmd", key="f.py"))
                               == "`f.py` has no replay command")),
            ("★ i18n.catalog_immutable",
             lambda: _raises(lambda: cat.table.__setitem__("a", "b"))
             and _raises(lambda: Catalog("xx", {"a": "b"}))),
            ("machine.clean_text_is_untouched", lambda: clean("all fine")[0] == "all fine"),
            ("★ machine.off_neutralised", lambda: "OFF:" not in _strip_clean("evil\nOFF: x")),
            ("★ machine.emit_single_row",
             lambda: len(scan(emit("fail", "x\nOFF: y"), keepends=True)) == 1),
            ("★ machine.emit_summary_exact", lambda: is_summary(emit_summary(3, 0))),
            ("★ machine.empty_scan_reports_nothing", lambda: scan("") == ()),
            ("★ machine.real_packs_have_no_forgery",
             lambda: all(not reject(v) for lang in installed_langs()
                         for v in load_pack(lang).values())),
        ]
        + [("★ machine.forgery_%s" % name,
            (lambda s: lambda: reject("ctx" + s + "OFF: forged") is not None)(sep))  # noqa: B023
           for sep, name in breaks]
        + [("★ machine.human_summary_forged_rejected",
            lambda: reject("ctx\n=== forged header ===") is not None)]
    )


def _as_null(fn):
    with bind(NULL):
        return fn()


def _with_cat(cat, fn):
    with bind(cat):
        return fn()


def _strip_clean(text):
    cleaned, _hits = clean(text)
    return "\n".join(ln for ln in cleaned.splitlines() if ln.startswith("OFF:"))


def _selftest():
    from gate import main_selftest_or  # noqa: PLC0415
    return main_selftest_or(
        sys.argv[1:], M("gate.title.i18n"), _cases,
        lambda _argv: (print(M("i18n.module_banner"), file=sys.stderr) or 2))


MODULE = {
    "name": "i18n",
    "desc": "zero-language core + machine-line protocol + optional language packs",
    "selftest": True,
}

if __name__ == "__main__":
    import i18n as _mod  # noqa: PLC0415
    sys.exit(_mod._selftest())
