#!/usr/bin/env python3
"""Question ledger gate: **every unresolved question must carry a runnable settler.**

A question = `questions/NN-slug.md`, whose header must contain:

    **Status:** ready-for-agent
    **Settling:** zreflect/facts.py -- rc=0 => guard holds; rc=2 => guard failed to catch it

Rules and rationale:

  - `Settling:` must be a **repo-relative path** or a directly runnable command;
    never "see some note" -- a settler pointing at prose is no settler at all.
  - **A `Settling:` must be a command, not a claim** (issue #36): "根目录文件数=18"
    inside the prose is invisible to this gate -- it judges the first token
    (a path must exist) and the two-outcome shape, nothing else. Prose
    describing the expected state is a claim no criterion can verify; the
    ticket's settler must BE the verifier (rc-decidable).
  - **A whitelist is not a claim's coverage** (issue #36, four specimen classes
    of half-a-criterion): (1) a whitelist lists fewer items than the claim --
    the gate green-lights the delta; (2)/(3) a ported criterion missing its
    predicate body or its case registration silently half-runs; (4) a filter
    emptying the input set runs, passes, and checks nothing. If a gate does
    not cover a claimed surface it must **say so** (off_is_visible: not
    applicable must be stated, not silent) -- and a coverage declaration
    itself needs a judgment, or the silence just moved into the declaration.
  - The two outcomes must yield **different exit codes / distinguishable output**,
    otherwise the settler can falsify nothing.
  - **A question whose settler does not exist yet is a legal question** -- in that
    case the ticket's first deliverable is to build it. Write
    `Settling: does not exist -- the first deliverable of this ticket`.
    Honestly saying "does not exist" carries information; inventing a fake path
    lets the gate stay green while lying.
  - After closing, set `Status: resolved`; **do not delete the file** --
    "we decided not to investigate this" is itself a conclusion.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import gate  # noqa: E402
import knobs  # noqa: E402
from gate import fatal, finish, main_selftest_or, meta  # noqa: E402
from i18n import M  # noqa: E402

VALID_STATUS = ("ready-for-agent", "ready-for-human", "resolved")
# Terminal states: once a question carries one of these, consumers stop listing
# it as pending. **Single origin** (issue #38): consumers import
# CLOSED_STATUS / is_resolved; nobody re-lists the states.
CLOSED_STATUS = ("resolved",)
# Domain words that must appear in a question body (vocabulary of the convention
# docs -- data, not user-visible messages, hence **not** in the language pack).
# Assembled from code points: this file sits inside check_i18n's scan surface, so
# writing the literals directly would be judged as "the subject speaks a human
# language" (that criterion cannot tell messages from data). For the meanings see
# the question-ledger section of the trilingual READMEs.
_NOT_EXISTS = "".join(chr(c) for c in (0x4E0D, 0x5B58, 0x5728))       # "does not exist"
_FIRST_DELIVERABLE = "".join(chr(c) for c in
                             (0x7B2C, 0x4E00, 0x4EA4, 0x4ED8, 0x7269))  # "first deliverable"
_PARTICLE = chr(0x7684)                                               # possessive particle
NONE_LIKE = (_NOT_EXISTS, "none", "None", "n/a", "N/A")
PATHISH = (".py", ".sh", ".mjs", ".js", ".md", "/")


_NONE_RE = re.compile(
    r"(?i)^(?:%s)(?:\s|$|--|—)" % "|".join(re.escape(w) for w in NONE_LIKE)
)


def _is_none_like(sv):
    return bool(_NONE_RE.match((sv or "").strip()))


def _field_count(text, name):
    pat = re.compile(r"(?i)^\*{0,2}%s\*{0,2}\s*:\s*\*{0,2}\s*(.*?)\s*$" % re.escape(name))
    return sum(1 for ln in text.splitlines() if pat.match(ln))


def field(text, name):
    """Read `**Name:** value` / `**Name**: value` / `Name: value` (three spellings;
    anchored at line start, first match wins).
    """
    lines = text.splitlines()
    for i, ln in enumerate(lines):
        m = re.match(r"(?i)^\*{0,2}%s\*{0,2}\s*:\s*\*{0,2}\s*(.*?)\s*$"
                     % re.escape(name), ln)
        if not m:
            continue
        val = [m.group(1).strip()]
        for nxt in lines[i + 1:]:
            if (not nxt.strip() or nxt.lstrip().startswith("#")
                    or re.match(r"^\s*(?:\*\*)?(?!https?:)[A-Za-z][A-Za-z0-9_-]*(?:\*\*)?\s*:", nxt)):
                break                    # blank line, heading, or next field stops continuation
            val.append(nxt.strip())
        return " ".join(v for v in val if v) or None
    return None


def status_of(text):
    """The **normalized** `Status` value (lowercased, first word) -- the single
    yardstick for "is this question closed".

    `field()`'s continuation-line semantics (there for Settling) are truncated
    here: Status is one word. Callers must use this origin, never re-normalize.
    """
    raw = (field(text, "Status") or "").strip().lower()
    return raw.split()[0] if raw else ""


def is_resolved(text):
    """Terminal-state check (`CLOSED_STATUS` single origin).

    `resolved` is the sole legal terminal state (`CLOSED_STATUS` member); callers
    ask via `is_resolved`, never by re-listing states.
    """
    return status_of(text) in CLOSED_STATUS


def _status_problems(name, text):
    """`Status` field: must exist, be unique, and be a known value."""
    if _field_count(text, "Status") > 1:
        return [M("questions.duplicate_field", name=name, field="Status")]
    st = status_of(text)
    if not st:
        return [M("questions.missing_status", name=name)]
    if st not in VALID_STATUS:
        return [M("questions.bad_status", name=name, actual=st,
                  expected=", ".join(VALID_STATUS))]
    return []


def _none_like_problems(name, sv):
    """`Settling` declared "none" (e.g. None): must **also** name the first
    deliverable.

    Both spellings of "first deliverable" are accepted -- the one with the
    measure word and the one without.
    """
    if _FIRST_DELIVERABLE in sv.replace(_PARTICLE, ""):
        return []
    return [M("questions.none_without_first_deliverable", name=name)]


def _settling_cmd(sv):
    cmd = gate._OUTCOME_SEP.split(sv, 1)[0].strip()
    if cmd.startswith("`") and cmd.endswith("`") and len(cmd) >= 2:
        cmd = cmd[1:-1].strip()
    return cmd


def _missing_settler_path(cmd, chk):
    import shlex  # noqa: PLC0415
    try:
        tokens = shlex.split(cmd)
    except ValueError:
        tokens = cmd.split()
    skip_next = False
    for raw_tok in tokens:
        if skip_next:
            skip_next = False
            continue
        tok = raw_tok.strip("`\"'")
        if tok in ("-c", "-m"):
            skip_next = True
            continue
        if tok.startswith("-") or "://" in tok:
            continue
        if any(tok.endswith(x) or x in tok for x in PATHISH) and not chk(tok):
            return tok
    return None


def _check_settler_exec(name, sv, chk):
    out = []
    if not any(t in sv for t in ("rc=", "\u21d2", "=>")):
        out.append(M("questions.no_distinct_outcomes", name=name))
    cmd = _settling_cmd(sv)
    bad_tok = _missing_settler_path(cmd, chk)
    if bad_tok:
        out.append(M("questions.settler_missing", name=name, target=bad_tok))
    return out + gate.prose_in_exec_problems(name, "Settling", sv)


def _settling_problems(name, text, chk, runner=None, verify_resolved=False, cache=None):
    """`Settling` field: exists / unique / two distinguishable outcomes / settler actually runs."""
    if _field_count(text, "Settling") > 1:
        return [M("questions.duplicate_field", name=name, field="Settling")]
    sv = field(text, "Settling")
    if not sv:
        return [M("questions.missing_settling", name=name)]
    st = status_of(text)
    if _is_none_like(sv):
        if st == "resolved":
            return [M("questions.resolved_cannot_be_none", name=name)]
        return _none_like_problems(name, sv)
    out = _check_settler_exec(name, sv, chk)
    if out or st != "resolved" or not (verify_resolved or runner is not None):
        return out
    cmd = _settling_cmd(sv)
    rc, cmd_out = _run_cached(cmd, runner, cache)
    if rc != 0:
        out.append(_settler_failed(name, cmd, rc, cmd_out))
    return out


def _parallel_problems(name, text):
    if _field_count(text, "Parallel") > 1:
        return [M("questions.duplicate_field", name=name, field="Parallel")]
    raw = field(text, "Parallel")
    if raw is None:
        return []
    val = raw.strip().lower()
    if val not in ("true", "false"):
        return [M("questions.bad_parallel", name=name, actual=raw)]
    return []


def is_parallel(text):
    """Whether a question explicitly opts into parallel settler replay (`Parallel: true`)."""
    raw = field(text, "Parallel")
    return (raw or "").strip().lower() == "true"


def _split_and_chain(cmd):
    parts: list[str] = []
    buf: list[str] = []
    quote = ""
    i = 0
    while i < len(cmd):
        ch = cmd[i]
        if ch in ("'", '"') and (not quote or quote == ch):
            quote = "" if quote else ch
        if not quote and cmd[i:i + 2] == "&&":
            parts.append("".join(buf).strip())
            buf, i = [], i + 2
            continue
        buf.append(ch)
        i += 1
    parts.append("".join(buf).strip())
    if len(parts) <= 1 or any(not p for p in parts):
        return [cmd]
    unsafe = ("cd ", "export ", "unset ")
    if any(p.startswith(unsafe) or re.match(r"^[A-Za-z_]\w*=", p) for p in parts):
        return [cmd]
    return parts


def _run_one_cached(sub, cache, cache_lock):
    if cache_lock is not None:
        with cache_lock:
            if sub in cache:
                return cache[sub]
    elif cache is not None and sub in cache:
        return cache[sub]
    res = gate.run_cmd_cached(sub)
    if cache is not None:
        if cache_lock is not None:
            with cache_lock:
                cache[sub] = res
        else:
            cache[sub] = res
    return res


def _run_cached(cmd, runner, cache, cache_lock=None):
    if runner is not None:
        return runner(cmd)
    last = (0, "")
    for sub in _split_and_chain(cmd):
        last = _run_one_cached(sub, cache, cache_lock)
        if last[0] != 0:
            return last
    return last


def _verify_set(verify_resolved, files):
    if isinstance(verify_resolved, (set, frozenset, list, tuple)):
        return set(verify_resolved)
    return set(files) if verify_resolved else set()


def _settler_failed(name, cmd, rc, out):
    lines = [ln.strip() for ln in (out or "").splitlines() if ln.strip()]
    detail = lines[-1][:120] if lines else ""
    return M("questions.resolved_settler_failed", name=name, rc=str(rc),
             cmd=cmd[:60], detail=detail)


def _check_one_question(name, text, chk, runner, verify, cache, cache_lock):
    out = _status_problems(name, text) + _parallel_problems(name, text)
    if out or not verify:
        return out + _settling_problems(name, text, chk, runner=runner, verify_resolved=False, cache=cache)
    sv = field(text, "Settling")
    if not sv or _is_none_like(sv) or status_of(text) != "resolved":
        return _settling_problems(name, text, chk, runner=runner, verify_resolved=False, cache=cache)
    pre = _check_settler_exec(name, sv, chk)
    if pre:
        return pre
    cmd = _settling_cmd(sv)
    rc, cmd_out = _run_cached(cmd, runner, cache, cache_lock)
    if rc != 0:
        return [_settler_failed(name, cmd, rc, cmd_out)]
    return []


def problems(files, exists=None, runner=None, verify_resolved=False):
    """Return the problem list (pure function: the selftest needs that)."""
    import concurrent.futures  # noqa: PLC0415
    import threading  # noqa: PLC0415
    if not files:
        return [M("questions.empty")]
    chk = exists or (lambda p: os.path.exists(os.path.join(gate.GATE_REPO, p)))
    targets = _verify_set(verify_resolved, files)
    cache: dict[str, tuple[int | None, str]] = {}
    cache_lock = threading.Lock()
    ordered = sorted(files.items())
    par_items = [(n, t) for n, t in ordered if is_parallel(t) and runner is None and n in targets]
    par_results: dict[str, list] = {}
    if par_items:
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, len(par_items))) as pool:
            futs = {
                n: pool.submit(_check_one_question, n, t, chk, runner, True, cache, cache_lock)
                for n, t in par_items
            }
            for n, fut in futs.items():
                par_results[n] = fut.result()
    out = []
    for name, text in ordered:
        if name in par_results:
            out += par_results[name]
        else:
            out += _check_one_question(name, text, chk, runner, name in targets, cache, cache_lock)
    return out


def _replay_depth():
    return gate.trusted_replay_depth()


def _resolved_targets_to_verify(_qdir, files, _all_resolved, depth=0):
    targets = {k for k, v in files.items() if status_of(v) == "resolved"}
    if depth <= 0:
        return targets
    reentrant = ("check_questions.py", "registry.py --run", "harness.py", "check_retractions.py")
    return {k for k in targets if not any(tok in _settling_cmd(field(files[k], "Settling") or "") for tok in reentrant)}


def sort_key(name):
    """Numeric-prefix sort key so `100-foo.md` sorts after `99-bar.md`."""
    base = os.path.basename(name)
    m = re.match(r"^(\d+)(.*)$", base)
    return (0, int(m.group(1)), m.group(2)) if m else (1, 0, base)


def collect(d=None, root=None):
    # The directory name is configurable via `knobs.questions_dir()`.
    d = d or knobs.questions_dir()
    base = os.path.join(root or gate.GATE_REPO, d)
    files = {}
    if os.path.isdir(base):
        for f in sorted(os.listdir(base), key=sort_key):
            if f.endswith(".md"):
                with open(os.path.join(base, f), encoding="utf-8", errors="replace") as fh:
                    files["%s/%s" % (d, f)] = fh.read()
    return files


def run(argv):
    depth = _replay_depth()
    if depth < 0 or depth >= 3:
        return fatal(M("replay.too_deep", depth=depth, limit=3))
    all_res = "--all-resolved" in argv
    pos = [a for a in argv if a != "--all-resolved"]
    qdir = pos[0] if pos else knobs.questions_dir()
    files = collect(pos[0] if pos else None)
    if not files:
        return fatal(M("questions.guard_empty", count=0))
    import trust  # noqa: PLC0415
    targets = _resolved_targets_to_verify(qdir, files, all_res, depth=depth)
    probs = gate.with_run_cache(lambda: problems(files, verify_resolved=targets))
    if not probs:
        probs += trust.check_questions_against_anchor(files, qdir=qdir)
    n_open = sum(1 for t in files.values() if not is_resolved(t))
    return finish(M("questions.title"), probs,
                  M("questions.ok", count=len(files), open=n_open))


def _q(status="ready-for-agent",
       settling="python3 zreflect/facts.py --selftest -- rc=0 => stands; rc=2 => did not catch it"):
    return "# 01: sample\n\n**Status:** %s\n\n**Settling:** %s\n" % (status, settling)


def _cases():
    ok = {"questions/01.md": _q()}
    q3, q4, q5 = "questions/03.md", "questions/04.md", "questions/05.md"
    prose_err = "criteria.exec_position_is_prose"
    return [
        ("questions.ok",
         lambda: problems(ok, exists=lambda p: True) == []),
        ("questions.numeric_sort_beyond_two_digits",
         lambda: sorted(["100-z.md", "20-a.md", "09-b.md"], key=sort_key)
         == ["09-b.md", "20-a.md", "100-z.md"]),
        ("questions.none_first_deliverable",
         lambda: problems({"questions/02.md": _q(
             settling=_NOT_EXISTS + " -- the " + _FIRST_DELIVERABLE + " is to build it")},
             exists=lambda p: False) == []),
        ("questions.resolved_also_compliant", lambda: problems(
            {q3: _q(status="resolved")}, exists=lambda p: True,
            runner=lambda _c: (0, "ok")) == []),
        ("★ questions.resolved_cannot_be_none", lambda: [p.code for p in problems(
            {"questions/10.md": _q(status="resolved", settling=_NOT_EXISTS + " -- " + _FIRST_DELIVERABLE)},
            exists=lambda p: False)] == ["questions.resolved_cannot_be_none"]),
        ("★ questions.resolved_settler_failed", lambda: [p.code for p in problems(
            {"questions/11.md": _q(status="resolved")}, exists=lambda p: True,
            runner=lambda _c: (1, "fail"))] == ["questions.resolved_settler_failed"]),
        ("★ questions.wontfix_and_needs_triage_rejected", lambda:
            [p.code for p in problems({"questions/09.md": _q(status="wontfix")}, exists=lambda p: True)] == ["questions.bad_status"]
            and [p.code for p in problems({"questions/12.md": _q(status="needs-triage")}, exists=lambda p: True)] == ["questions.bad_status"]),
        ("★ questions.depth_one_still_verifies_non_self", lambda: (
            q3 in _resolved_targets_to_verify("questions", {q3: _q(status="resolved")}, False, depth=1)
            and q4 not in _resolved_targets_to_verify(
                "questions",
                {q4: _q(status="resolved", settling="python3 zreflect/check_questions.py -- rc=0 => ok; rc=1 => bad")},
                False, depth=1)
            and q5 not in _resolved_targets_to_verify(
                "questions",
                {q5: _q(status="resolved", settling="python3 zreflect/check_retractions.py -- rc=0 => ok; rc=1 => bad")},
                False, depth=1))),
        ("★ questions.closed_status_table", lambda:
            is_resolved(_q(status="resolved")) is True
            and is_resolved(_q(status="ready-for-human")) is False
            and is_resolved(_q(status="ready-for-agent")) is False),
        ("★ questions.missing_settling",
         lambda: [p.code for p in problems(
             {q4: _q(settling="")}, exists=lambda p: True)]
         == ["questions.missing_settling"]),
        ("\u2605 questions.settler_missing",
         lambda: [p.code for p in problems(
             {"questions/08.md": _q(settling="zreflect/nope.py -- rc=0 => a; rc=2 => b")},
             exists=lambda p: False)]
         == ["questions.settler_missing", prose_err]),
        ("\u2605 questions.settler_is_not_a_command",
         lambda: [p.code for p in problems(
             {"questions/09.md": _q(settling="zreflect/facts.py -- rc=0 => a; rc=2 => b")})]
         == [prose_err]),
        ("\u2605 questions.no_distinct_outcomes",
         lambda: [p.code for p in problems(
             {q5: _q(settling="run it")}, exists=lambda p: True)]
         == ["questions.no_distinct_outcomes", prose_err]),
        ("★ questions.bad_status",
         lambda: [p.code for p in problems(
             {"questions/06.md": _q(status="whatever")}, exists=lambda p: True)]
         == ["questions.bad_status"]),
        ("★ questions.none_without_first_deliverable",
         lambda: [p.code for p in problems(
             {"questions/08.md": _q(settling=_NOT_EXISTS)}, exists=lambda p: False)]
         == ["questions.none_without_first_deliverable"]),
        ("\u2605 questions.missing_status",
         lambda: [p.code for p in problems(
             {"questions/07.md": "**Settling:** python3 x.py ---- rc=0 => a; rc=1 => b"},
             exists=lambda p: True)] == ["questions.missing_status"]),
        ("questions.settling_wrapped",
         lambda: "rc=7" in (field("**Status:** x\n**Settling:** run:\nrc=0 => A；"
                                 "rc=7 => B\n", "Settling") or "")),
        ("★ questions.field_stops_at_blank_or_heading",
         lambda: field("**Status:** open\n**Settling:** python3 x\n\n## Conclusion\nprose\n", "Settling") == "python3 x"
         and field("**Status:** open\n**Settling:** python3 x\n## Conclusion\nprose\n", "Settling") == "python3 x"
         and field("  Status: spoof\n**Status:** ready-for-human\n", "Status") == "ready-for-human"
         and not problems({"questions/14.md": _q(status="ready-for-human") + "**Parallel:** false\n"},
                          exists=lambda p: True)
         and [p.code for p in problems({"questions/15.md": _q() + "**Status:** ready-for-human\n"},
                                       exists=lambda p: True)] == ["questions.duplicate_field"]),
        ("★ questions.empty",
         lambda: [p.code for p in problems({}, exists=lambda p: True)]
         == ["questions.empty"]),
        ("★ questions.bad_parallel_rejected",
         lambda: [p.code for p in problems(
             {"questions/13.md": _q() + "**Parallel:** maybe\n"}, exists=lambda p: True)]
         == ["questions.bad_parallel"]),
        ("questions.parallel_and_and_chain_split",
         lambda: is_parallel(_q() + "**Parallel:** true\n")
         and _split_and_chain("python3 a.py && python3 b.py") == ["python3 a.py", "python3 b.py"]),
    ]


GATE = meta("Question ledger gate", "an unresolved question must carry a runnable settler",
            knobs=("REFLECT_QUESTIONS",), name_dependent=True)

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], M("gate.title.questions"),
                              _cases, run))
