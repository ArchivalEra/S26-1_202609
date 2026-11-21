#!/usr/bin/env python3
"""Facts gate: block agreement, bare numbers, `[[key]]` citations, and rendered-doc prose bans."""
from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import facts as ledger  # noqa: E402
import gate  # noqa: E402
import i18n  # noqa: E402
import knobs  # noqa: E402
from gate import fatal, finish, main_selftest_or, meta, repo  # noqa: E402
from i18n import M  # noqa: E402

_DEFAULT_NAKED_MIN = int(knobs.REGISTRY["REFLECT_NAKED_MIN"][1])
_FENCE = re.compile(r"^(`{3,}|~{3,})")
_SHAPE_PATTERNS = (
    r"\bv?\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9._-]+)?\b",
    r"\b\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?\b",
    r"\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}\b",
    r"\bHTTP\s+[1-5]\d{2}\b",
    r"https?://[^\s)]+",
)


def rendered_docs():
    """Docs that are 100% machine-rendered (`STATE.md` and `PRINCIPLES.md` if active)."""
    import doc  # noqa: PLC0415
    return [doc.state_name()] + ([doc.PRINCIPLES] if doc.accepts_principles() else [])


def _bare_min():
    val = (knobs.raw("REFLECT_NAKED_MIN") or "").strip()
    if not val:
        return _DEFAULT_NAKED_MIN
    try:
        return int(val)
    except ValueError:
        raise SystemExit(fatal(M("facts.bad_bare_min", value=val, default=_DEFAULT_NAKED_MIN))) from None


def _number_lines(doc_text):
    out = []
    for i, line in enumerate(ledger.prose_of(doc_text).splitlines(), 1):
        out.append((i, re.sub(r"<!--.*?-->", "", line)))
    return out


def _line_unaccounted(line, lineno, f, bm, known, strip_re, doc_name="STATE.md"):
    cleaned = strip_re.sub(" ", line)
    cites = ledger.CITE_RE.findall(cleaned)
    cited_vals = {
        v for k in cites
        if k in f and isinstance((v := ledger.value_of(f[k])), int) and not isinstance(v, bool)
    }
    out = []
    for tok in re.findall(r"(?<![\w.])\d+\b", cleaned):
        val = int(tok)
        if val < bm or val in known or val in cited_vals:
            continue
        out.append(M("facts.bare_number_unaccounted", file=doc_name, line=lineno, number=tok))
    return out


def _unaccounted_numbers(f, bm, nlines, doc_name="STATE.md"):
    known = {v for e in f.values() if isinstance((v := ledger.value_of(e)), int) and not isinstance(v, bool)}
    strip_re = re.compile("|".join(_SHAPE_PATTERNS))
    out = []
    for lineno, line in nlines:
        stripped = ledger.DATED_RECORD.sub(" ", line)
        out.extend(_line_unaccounted(stripped, lineno, f, bm, known, strip_re, doc_name))
    return out


def _cite_problems(doc_or_nlines, f, doc_name="STATE.md"):
    nlines = _number_lines(doc_or_nlines) if isinstance(doc_or_nlines, str) else doc_or_nlines
    return [M("facts.missing_key_cite", file=doc_name, line=i, key=k)
            for i, line in nlines
            for k in ledger.CITE_RE.findall(re.sub(r"`[^`]*`", "", line)) if k not in f]


def _copied_fact_problems(f, nlines, bm, doc_name="STATE.md"):
    out = []
    for k, entry in sorted(f.items()):
        v = ledger.value_of(entry)
        if isinstance(v, bool) or not isinstance(v, int) or v < bm:
            continue
        for i, line in nlines:
            if str(v) in line and ("[[%s]]" % k) not in line:
                out.append(M("facts.copied_value", file=doc_name, line=i, value=v, key=k))
    return out


def hand_written_problems(doc_text, name="STATE.md"):
    """Report non-title/non-intro prose lines in fully rendered docs (`STATE.md`/`PRINCIPLES.md`)."""
    out, in_intro, title_seen, quote_count = [], True, False, 0
    for lineno, line in enumerate(doc_text.splitlines(), 1):
        stripped = line.strip()
        if not stripped:
            continue
        if in_intro and not title_seen and stripped.startswith("# "):
            title_seen = True
            continue
        if in_intro and stripped.startswith(">") and quote_count < 3:
            quote_count += 1
            continue
        in_intro = False
        out.append(M("facts.hand_written_in_state", name=name, lineno=lineno, text=stripped[:60]))
    return out


def problems(led, doc_text, bare_min=None, doc_name="STATE.md"):
    """Check block consistency, `[[key]]` citations, copied numbers, and unaccounted numbers."""
    bm = _bare_min() if bare_min is None else bare_min
    f = ledger.facts_of(led)
    if not f:
        return [M("facts.empty_ledger")]
    if ledger.BLOCK_BEGIN not in doc_text or ledger.BLOCK_END not in doc_text:
        return [M("facts.no_block_markers", begin=ledger.BLOCK_BEGIN, end=ledger.BLOCK_END)]
    out = []
    if ledger.body_of(doc_text).strip() != ledger.body_of(ledger.render_block(led)).strip():
        out.append(M("facts.block_mismatch"))
    nlines = _number_lines(doc_text)
    out += _cite_problems(nlines, f, doc_name)
    return (out + _copied_fact_problems(f, nlines, bm, doc_name)
            + _unaccounted_numbers(f, bm, nlines, doc_name))


def extra_block_problems(docs_by_name, homes):
    """Compare non-`AUTO:FACTS` owned blocks (`AUTO:GATES`, `AUTO:RULES`) against `homes`."""
    out = []
    for name, blocks in homes:
        doc_key = name if name in docs_by_name else next(
            (k for k in docs_by_name if os.path.basename(k) == name), None)
        if doc_key is None:
            out.append(M("facts.doc_missing", path=name))
            continue
        rest = [(b, e, exp) for b, e, exp in blocks if b != ledger.BLOCK_BEGIN]
        out += ledger.doc_block_problems(doc_key, docs_by_name[doc_key], rest)
    return out


def _docs_to_scan(argv):
    if argv:
        return [argv[0]]
    import doc  # noqa: PLC0415
    names = knobs.docs_names()
    if doc.accepts_principles() and doc.PRINCIPLES not in names:
        names.append(doc.PRINCIPLES)
    return names


def _scan_doc_item(doc_name, argv, f, single_doc):
    p = gate.repo_path(doc_name)
    if not os.path.exists(p):
        if single_doc and argv:
            return None, None, fatal(M("facts.doc_missing", path=p))
        return [], None, 0
    text = open(p, encoding="utf-8").read()
    probs = []
    if ledger.BLOCK_BEGIN in text and ledger.BLOCK_END in text:
        probs += problems(ledger_wrap(f), text, doc_name=doc_name)
    else:
        nlines = _number_lines(text)
        probs += _cite_problems(nlines, f, doc_name)
        probs += _copied_fact_problems(f, nlines, _bare_min(), doc_name)
        probs += _unaccounted_numbers(f, _bare_min(), nlines, doc_name)
    if os.path.basename(doc_name) in rendered_docs():
        probs += hand_written_problems(ledger.prose_of(text), doc_name)
    return probs, text, None


def ledger_wrap(f):
    return {"facts": f}


def run(argv):
    docs = _docs_to_scan(list(argv))
    rc = gate.guard_nonempty("check_facts", docs, M("facts.scanned_docs"))
    if rc:
        return rc
    facts_name = knobs.get("REFLECT_FACTS")
    led_path = repo(facts_name)
    if not os.path.exists(led_path):
        return fatal(M("facts.ledger_missing", name=facts_name))
    led = ledger.load_or_fatal(led_path)
    f = ledger.facts_of(led)
    probs, loaded, scanned = [], {}, 0
    for doc_name in docs:
        dprobs, text, err_rc = _scan_doc_item(doc_name, argv, f, len(docs) == 1)
        if err_rc is not None:
            return err_rc
        if text is None:
            probs.append(M("facts.doc_missing", path=gate.repo_path(doc_name)))
            continue
        scanned += 1
        loaded[doc_name] = text
        probs += dprobs
    homes, err = ledger.block_homes(led)
    if err:
        return fatal(err)
    import trust  # noqa: PLC0415
    probs += extra_block_problems(loaded, homes)
    probs += trust.check_principles_repo(repo())
    probs += trust.check_knobs_anchor(repo())
    return finish(M("facts.title"), probs, M("facts.ok", count=len(f), docs=scanned))


def _cases():
    led = {"facts": {"count": {"value": 4752, "cmd": "c"}}}
    good = "no bare numbers.\n" + ledger.render_block(led)
    fifty = {"facts": {"n": {"value": 50, "cmd": "c"}}}
    return [
        ("facts.block_and_cite_ok",
         lambda: problems(led, good) == []
         and problems(led, "see [[count]]\n" + ledger.render_block(led)) == []),
        ("★ facts.block_mismatch",
         lambda: [p.code for p in problems(led, "x\n" + ledger.render_block({"facts": {}}))]
         == ["facts.block_mismatch"]),
        ("★ facts.copied_value",
         lambda: [p.code for p in problems(led, "speed is 4752\n" + ledger.render_block(led))]
         == ["facts.copied_value"]),
        ("★ facts.missing_key_cite",
         lambda: [p.code for p in problems(led, "see [[nope]]\n" + ledger.render_block(led))]
         == ["facts.missing_key_cite"]
         and [p.code for p in _cite_problems("bad [[nope]]", led["facts"])] == ["facts.missing_key_cite"]),
        ("★ facts.bare_number_unaccounted",
         lambda: [p.code for p in problems(led, "measured 99887766.\n" + ledger.render_block(led))]
         == ["facts.bare_number_unaccounted"]),
        ("facts.cite_counts_as_provenance",
         lambda: problems(led, "see [[count]] = 4752\n" + ledger.render_block(led)) == []),
        ("★ facts.cite_value_mismatch_flagged",
         lambda: [p.code for p in problems(led, "see [[count]] = 99887766\n" + ledger.render_block(led))]
         == ["facts.bare_number_unaccounted"]),
        ("★ facts.empty_ledger",
         lambda: [p.code for p in problems({"facts": {}}, good)] == ["facts.empty_ledger"]),
        ("★ facts.hand_written_in_state",
         lambda: [p.code for p in hand_written_problems("# T\n\n> ok\n- junk\n")]
         == ["facts.hand_written_in_state"]
         and [p.code for p in hand_written_problems("# T\n\n> 1\n> 2\n> 3\n> 4\n")]
         == ["facts.hand_written_in_state"]),
        ("★ facts.no_block_markers",
         lambda: [p.code for p in problems(led, "plain")] == ["facts.no_block_markers"]),
        ("★ facts.inline_backtick_and_fenced_numbers_caught",
         lambda: problems(led, "v1.2.3\n" + ledger.render_block(led)) == []
         and [p.code for p in problems(led, "`99999`\n" + ledger.render_block(led))]
         == ["facts.bare_number_unaccounted"]),
        ("★ facts.threshold_knob",
         lambda: [p.code for p in problems(fifty, "is 50\n" + ledger.render_block(fifty), bare_min=10)]
         == ["facts.copied_value"]),
        ("★ facts.stale_gates_and_rules_block",
         lambda: [p.code for p in extra_block_problems(
             {"STATE.md": "<!-- AUTO:GATES -->\nstale\n<!-- /AUTO:GATES -->"},
             [("STATE.md", [("<!-- AUTO:GATES -->", "<!-- /AUTO:GATES -->",
                            "<!-- AUTO:GATES -->\nfresh\n<!-- /AUTO:GATES -->")])])]
         == ["facts.block_stale"]),
        ("facts.pack_entry_wired",
         lambda: not i18n.a_pack_lang()
         or "line" in i18n.load_pack(i18n.a_pack_lang()).get("facts.bare_number_unaccounted", "")),
        ("★ facts.bad_naked_min_fatals", lambda: _bad_naked_min_fatals_ok()),
    ]


def _bad_naked_min_fatals_ok():
    import contextlib  # noqa: PLC0415
    import io  # noqa: PLC0415
    saved = os.environ.get("REFLECT_NAKED_MIN")
    os.environ["REFLECT_NAKED_MIN"] = "abc"
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            try:
                _bare_min()
            except SystemExit as exc:
                return exc.code == 2
            return False
    finally:
        if saved is None:
            os.environ.pop("REFLECT_NAKED_MIN", None)
        else:
            os.environ["REFLECT_NAKED_MIN"] = saved


GATE = meta("Facts gate", "block agreement / bare numbers / bad citations",
            knobs=("REFLECT_DOC", "REFLECT_DOCS", "REFLECT_FACTS",
                   "REFLECT_NAKED_MIN", "REFLECT_QUESTIONS"),
            name_dependent=True)

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], M("gate.title.facts"), _cases, run))
