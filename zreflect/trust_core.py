#!/usr/bin/env python3
"""Pure Layer-2 trust logic: canonical hashing, 4-law anchor migration, and offline receipt/seal evaluation."""
from __future__ import annotations

import hashlib
import json
import re
import sys
from datetime import datetime, timezone

from gate import fatal, main_selftest_or, module_meta
from i18n import M

MODULE = module_meta("trust_core", "Pure trust algebra: receipt verification, seal checks, and 4-law anchor migration")

ANCHOR_SCHEMA = 2
SEAL_SCHEMA = 2
ANCHORS_FILE = "ANCHORS.json"
_KNOBS_JSON = "knobs.json"
_SEAL_TARGET = "zreflect/SEAL.json"
_GATE_OFF = "gate.off"
_SUITE_RELEASE = "suite.release"
CONTROLLED_PREFIXES = ("zreflect/", "reflect-local/", "questions/")
CONTROLLED_FILES = frozenset({"PRINCIPLES.md", _KNOBS_JSON, "ruff.toml"})


def sha256_bytes(data):
    """Hex SHA-256 of raw bytes."""
    return hashlib.sha256(data).hexdigest()


def sha256_text(text):
    """Hex SHA-256 of UTF-8 text."""
    return sha256_bytes((text or "").encode("utf-8"))


def canonical_json(obj):
    """Deterministic UTF-8 JSON bytes for signing and hashing."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def receipt_body(receipt):
    """Extract the signed payload dict from an envelope or flat receipt."""
    if not isinstance(receipt, dict):
        return {}
    return receipt["payload"] if isinstance(receipt.get("payload"), dict) else receipt


def canonical_payload(receipt):
    """Return canonical bytes of the signed payload inside `receipt`."""
    if isinstance(receipt.get("payload"), dict):
        return canonical_json(receipt["payload"])
    return canonical_json({k: v for k, v in receipt.items() if k != "sig"})


def compute_tree_sha(files_map):
    """Compute canonical `tree_sha256` from `{relpath: {'file_sha256': ...}}`."""
    return sha256_bytes(canonical_json(files_map or {}))


def safe_int(val, default=0):
    """Parse strict integer or return `None` when malformed."""
    if isinstance(val, (bool, float)):
        return None
    try:
        return int(default if val is None else val)
    except (TypeError, ValueError):
        return None


def parse_iso(ts):
    """Parse ISO-8601 string or numeric timestamp into UTC `datetime` (or `None`)."""
    if isinstance(ts, (int, float)):
        try:
            return datetime.fromtimestamp(ts, tz=timezone.utc)
        except (ValueError, OverflowError, OSError):
            return None
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


_SETTLING_HDR_RE = re.compile(r"(?i)^\*{0,2}(Status|Settling)\*{0,2}\s*:\s*\*{0,2}")
_FIELD_STOP_RE = re.compile(r"^\s*(?:\*\*)?(?!https?:)[A-Za-z][A-Za-z0-9_-]*(?:\*\*)?\s*:")


def strip_status_settling(text):
    """Strip `Status:` and `Settling:` fields from a question markdown body (column-0 match)."""
    lines = (text or "").splitlines()
    out = []
    skip_cont = False
    for ln in lines:
        if _SETTLING_HDR_RE.match(ln):
            skip_cont = ln.lstrip("*").lower().startswith("settling")
            continue
        if skip_cont:
            if not ln.strip() or ln.lstrip().startswith("#") or _FIELD_STOP_RE.match(ln):
                skip_cont = False
            else:
                continue
        out.append(ln)
    return "\n".join(out).strip()


def is_none_like(val):
    """True when `Settling:` value is empty or `none`."""
    low = (val or "").strip().lower()
    return not low or low == "none" or low.startswith(("none ", "none--"))


def question_snapshot(text, status, settling):
    """Build deterministic snapshot dict for a question file."""
    return {
        "sha256": sha256_text(text),
        "status": (status or "").lower(),
        "settling": settling or "",
        "body_sha256": sha256_text(strip_status_settling(text)),
    }


_TRIAGE_STATUSES = ("ready-for-human", "ready-for-agent")


def _question_transition_exempt(old_status, old_settling, old_body_sha,
                                new_status, new_settling, new_body_sha):
    if not old_body_sha or new_body_sha != old_body_sha:
        return False
    if (new_settling or "").strip() != (old_settling or "").strip():
        return False
    old_st, new_st = (old_status or "").lower(), (new_status or "").lower()
    if new_st == "resolved":
        return not is_none_like(old_settling) and not is_none_like(new_settling)
    return old_st in _TRIAGE_STATUSES and new_st in _TRIAGE_STATUSES and old_st != new_st


def is_legal_settlement(new_status, new_settling, new_text, prev_entry):
    """True iff question transitioned to `resolved` without altering body or settling."""
    if not isinstance(prev_entry, dict) or (new_status or "").lower() != "resolved":
        return False
    return _question_transition_exempt(
        prev_entry.get("status"), prev_entry.get("settling"), prev_entry.get("body_sha256"),
        new_status, new_settling, sha256_text(strip_status_settling(new_text)))


def is_legal_status_triage(new_status, new_settling, new_text, prev_entry):
    """True iff an open question swaps `ready-for-human` <-> `ready-for-agent` with identical body and settling."""
    if not isinstance(prev_entry, dict) or (new_status or "").lower() not in _TRIAGE_STATUSES:
        return False
    return _question_transition_exempt(
        prev_entry.get("status"), prev_entry.get("settling"), prev_entry.get("body_sha256"),
        new_status, new_settling, sha256_text(strip_status_settling(new_text)))


def select_receipt(receipt, *, action, target, target_sha256):
    """Pick matching receipt from a bundle (`{'receipts': [...]}` or list) or single dict."""
    if isinstance(receipt, dict) and isinstance(receipt.get("receipts"), list):
        items = receipt["receipts"]
    elif isinstance(receipt, list):
        items = receipt
    else:
        return receipt
    for item in items:
        if not isinstance(item, dict):
            continue
        body = receipt_body(item)
        if (body.get("action") == action
                and (body.get("target") or body.get("target_path")) == target
                and body.get("target_sha256") == target_sha256):
            return item
    return items[0] if len(items) == 1 else None


TRUSTED_UPSTREAM_REPO = "ArchivalEra/Einfacht"


def _is_revoked(body, revoked_ids):
    rid = str(body.get("id") or body.get("receipt_id") or "")
    did = str(body.get("delegation_id") or "")
    rev_set = set(revoked_ids or ())
    if (rid and rid in rev_set) or (did and did in rev_set):
        return did or rid
    return None


def _verify_envelope_meta(rec, *, repo_name, action, target, pub_b64, revoked_ids, now, check_expiry=True):
    if not isinstance(rec, dict) or not pub_b64:
        return None, [M("approval.receipt_required", action=action, target=target)]
    body = receipt_body(rec)
    rev_hit = _is_revoked(body, revoked_ids)
    if rev_hit is not None:
        return None, [M("approval.revoked", id=rev_hit, target=target)]
    rid = str(body.get("id") or body.get("receipt_id") or "")
    if check_expiry:
        exp = parse_iso(body.get("expires_at"))
        if exp is None or exp <= (now or datetime.now(timezone.utc)):
            return None, [M("approval.expired", id=rid, target=target)]
    if body.get("repo") != repo_name or body.get("action") != action or (body.get("target") or body.get("target_path")) != target:
        return None, [M("approval.scope_mismatch", action=action, target=target)]
    return body, []


def _verify_sig(rec, *, pub_b64, target, verify_sig_fn):
    if verify_sig_fn is None:
        return [M("approval.crypto_unavailable", target=target)]
    ok, err = verify_sig_fn(canonical_payload(rec), str(rec.get("sig") or ""), pub_b64)
    if ok:
        return []
    if err == "crypto_unavailable":
        return [M("approval.crypto_unavailable", target=target)]
    return [M("approval.signature_invalid", target=target)]


def verify_receipt(receipt, *, repo_name, action, target, prev_sha256, target_sha256,
                   pub_b64, revoked_ids=(), now=None, verify_sig_fn=None):
    """Verify an Ed25519 approval receipt purely via `verify_sig_fn(payload, sig_b64, pub_b64)`."""
    picked = select_receipt(receipt, action=action, target=target, target_sha256=target_sha256)
    body, probs = _verify_envelope_meta(
        picked, repo_name=repo_name, action=action, target=target,
        pub_b64=pub_b64, revoked_ids=revoked_ids, now=now)
    if probs or body is None:
        return probs
    if body.get("prev_sha256") != prev_sha256 or body.get("target_sha256") != target_sha256:
        return [M("approval.hash_mismatch", target=target)]
    return _verify_sig(picked, pub_b64=pub_b64, target=target, verify_sig_fn=verify_sig_fn)


def verify_suite_sig(seal_data, suite_sig, *, pub_b64, upstream_repo=TRUSTED_UPSTREAM_REPO,
                     revoked_ids=(), now=None, verify_sig_fn=None):
    """Verify `suite.release` signature binding pinned `(upstream_repo, suite_seq, tree_sha256)` (non-expiring)."""
    target = _SEAL_TARGET
    if not isinstance(seal_data, dict):
        return [M("approval.receipt_required", action=_SUITE_RELEASE, target=target)]
    body, probs = _verify_envelope_meta(
        suite_sig, repo_name=upstream_repo, action=_SUITE_RELEASE, target=target,
        pub_b64=pub_b64, revoked_ids=revoked_ids, now=now, check_expiry=False)
    if probs or body is None:
        return probs
    seal_up = seal_data.get("upstream_repo")
    if seal_up and seal_up != upstream_repo:
        return [M("approval.scope_mismatch", action=_SUITE_RELEASE, target=target)]
    rec_seq, seal_seq = safe_int(body.get("suite_seq"), None), safe_int(seal_data.get("suite_seq"), 0)
    seq_ok = body.get("suite_seq") is not None and rec_seq is not None and seal_seq is not None and rec_seq == seal_seq
    if body.get("target_sha256") != seal_data.get("tree_sha256") or not seq_ok:
        return [M("approval.hash_mismatch", target=target)]
    return _verify_sig(suite_sig, pub_b64=pub_b64, target=target, verify_sig_fn=verify_sig_fn)


def _validate_migrate_header(raw, suite_seq):
    if not isinstance(raw, dict) or not isinstance(raw.get("repo"), str) or not raw.get("repo"):
        return None, [M("approval.anchors_broken")]
    old_schema = raw.get("schema", 1)
    if not isinstance(old_schema, int) or isinstance(old_schema, bool) or old_schema < 1 or old_schema > ANCHOR_SCHEMA:
        return None, [M("approval.anchors_broken")]
    old_seq = safe_int(raw.get("suite_seq"), 0)
    new_seq = safe_int(suite_seq, 0) if suite_seq is not None else old_seq
    if old_seq is None or new_seq is None:
        return None, [M("approval.anchors_broken")]
    if new_seq < old_seq:
        return None, [M("trust.suite_downgrade", old_seq=old_seq, new_seq=new_seq)]
    return new_seq, []


def _merged_local_scripts(raw, local_scripts):
    merged: dict[str, str] = {}
    for key in ("custom_scripts", "local_scripts"):
        if isinstance(raw.get(key), dict):
            merged.update(raw[key])
    if isinstance(local_scripts, dict):
        merged.update(local_scripts)
    return {k: merged[k] for k in sorted(merged)}


def clean_principles(raw_pr):
    """Return `principles` dict without legacy `doc_py_sha256`."""
    return {k: v for k, v in (raw_pr or {}).items() if k != "doc_py_sha256"}


def migrate_anchors(raw, *, local_scripts=None, suite_seq=None, suite_tree_sha=None):
    """4-law migration algebra (schema 1 -> 2): idempotent, monotonic, total, scope-preserving."""
    new_seq, probs = _validate_migrate_header(raw, suite_seq)
    if probs or new_seq is None:
        return None, probs
    out = {
        "schema": ANCHOR_SCHEMA,
        "repo": raw["repo"],
        "approver_pub": raw.get("approver_pub"),
        "lock_core": bool(raw.get("lock_core", True)),
        "revoked_ids": list(raw.get("revoked_ids") or []),
        "suite_seq": new_seq,
        "suite_tree_sha256": suite_tree_sha if suite_tree_sha is not None else raw.get("suite_tree_sha256", ""),
        "knobs_sha256": raw.get("knobs_sha256", "NONE"),
        "questions_dir": raw.get("questions_dir", "questions"),
        "local_scripts": _merged_local_scripts(raw, local_scripts),
        "off_gates": sorted(set(raw.get("off_gates") or ())),
        "principles": clean_principles(raw.get("principles")),
        "questions": {k: dict(v) for k, v in sorted((raw.get("questions") or {}).items())},
    }
    return out, []


def eval_seal_files(expected_files, actual_hashes, expected_tree_sha=None):
    """Purely compare `SEAL.json` `files` map against disk hashes; return list of `Message`."""
    if not isinstance(expected_files, dict) or not expected_files:
        return [M("seal.broken", path=_SEAL_TARGET)]
    probs = []
    for rel in sorted(expected_files):
        entry = expected_files[rel]
        exp_sha = entry.get("file_sha256") if isinstance(entry, dict) else None
        if not exp_sha:
            return [M("seal.broken", path=_SEAL_TARGET)]
        got = actual_hashes.get(rel)
        if got is None:
            probs.append(M("seal.file_missing", file=rel))
        elif got != exp_sha:
            probs.append(M("seal.file_tampered", file=rel))
    probs.extend(M("seal.unlisted_file", file=rel) for rel in sorted(actual_hashes) if rel not in expected_files)
    if expected_tree_sha and compute_tree_sha(expected_files) != expected_tree_sha:
        probs.append(M("seal.broken", path=_SEAL_TARGET))
    return probs


def eval_local_scripts(expected_map, actual_map, *, lock_core, receipt, repo_name,
                       pub_b64, revoked_ids=(), now=None, verify_sig_fn=None):
    """Verify `reflect-local/*.py` (including `hook.py`, `measure_*.py`, custom `check_*.py`)."""
    if not lock_core:
        return []
    exp = expected_map or {}
    act = actual_map or {}
    out = []
    for rel in sorted(set(exp) | set(act)):
        if exp.get(rel) != act.get(rel):
            out += verify_receipt(
                receipt, repo_name=repo_name, action="seal.core", target=rel,
                prev_sha256=exp.get(rel, "NONE"), target_sha256=act.get(rel, "DELETED"),
                pub_b64=pub_b64, revoked_ids=revoked_ids, now=now, verify_sig_fn=verify_sig_fn,
            )
    return out


def _local_map(anc):
    if "local_scripts" in anc:
        return anc.get("local_scripts") or {}
    if "custom_scripts" in anc:
        return anc.get("custom_scripts") or {}
    return None


def _suite_principles_synced(c_pr, suite_principles_md_sha):
    if suite_principles_md_sha and c_pr.get("principles_md_sha256") == suite_principles_md_sha:
        return True
    return bool(c_pr.get("no_principles") and not c_pr.get("principles_md_sha256"))


def _eval_principles_anchor(head_anc, cur_anc, *, receipt, repo_name, pub, revoked, verify_sig_fn,
                            suite_principles_md_sha=None):
    h_pr = head_anc.get("principles") or {}
    c_pr = cur_anc.get("principles") or {}
    if not h_pr:
        return []
    probs = []
    if c_pr.get("no_principles") and not h_pr.get("no_principles"):
        probs += verify_receipt(
            receipt, repo_name=repo_name, action="principles.disable", target="REFLECT_NO_PRINCIPLES",
            prev_sha256="false", target_sha256="true", pub_b64=pub, revoked_ids=revoked,
            verify_sig_fn=verify_sig_fn)
    if _suite_principles_synced(c_pr, suite_principles_md_sha):
        return probs
    if c_pr.get("principles_md_sha256") != h_pr.get("principles_md_sha256"):
        probs += verify_receipt(
            receipt, repo_name=repo_name, action="principles.edit", target="PRINCIPLES.md",
            prev_sha256=h_pr.get("principles_md_sha256") or "",
            target_sha256=c_pr.get("principles_md_sha256") or "DELETED",
            pub_b64=pub, revoked_ids=revoked, verify_sig_fn=verify_sig_fn)
    return probs


def is_suite_upgraded(head_anchors, cur_anchors):
    """True iff `cur_anchors` strictly advances `suite_seq` over `head_anchors`."""
    if not isinstance(head_anchors, dict) or not isinstance(cur_anchors, dict):
        return False
    old_seq = safe_int(head_anchors.get("suite_seq"), 0)
    new_seq = safe_int(cur_anchors.get("suite_seq"), 0)
    return old_seq is not None and new_seq is not None and new_seq > old_seq


def _is_parser_reanchor_exempt(prev, cur, disk_snap, head_q, suite_upgraded):
    if not suite_upgraded or cur.get("sha256") != prev.get("sha256"):
        return False
    if isinstance(disk_snap, dict) and cur == disk_snap:
        return True
    return isinstance(head_q, dict) and prev == head_q


def _eval_existing_question_entry(rel, prev, cur, *, receipt, repo_name, pub, revoked,
                                  verify_sig_fn, disk_snap=None, head_q=None, suite_upgraded=False):
    if cur.get("sha256") == prev.get("sha256"):
        if cur == prev or _is_parser_reanchor_exempt(prev, cur, disk_snap, head_q, suite_upgraded):
            return []
        return [M("approval.anchors_broken")]
    if _question_transition_exempt(prev.get("status"), prev.get("settling"), prev.get("body_sha256"),
                                   cur.get("status"), cur.get("settling"), cur.get("body_sha256")):
        return []
    return verify_receipt(
        receipt, repo_name=repo_name, action="question.modify", target=rel,
        prev_sha256=prev.get("sha256", ""), target_sha256=cur.get("sha256", ""),
        pub_b64=pub, revoked_ids=revoked, verify_sig_fn=verify_sig_fn)


def eval_question_entry(rel, prev, cur, *, receipt, repo_name, pub, revoked, verify_sig_fn,
                        disk_snap=None, head_q=None, suite_upgraded=False):
    """Authorize a change between two question snapshots."""
    if (prev is not None and not isinstance(prev, dict)) or (cur is not None and not isinstance(cur, dict)):
        return [M("approval.anchors_broken")]
    if prev is not None and cur is None:
        return verify_receipt(
            receipt, repo_name=repo_name, action="question.delete", target=rel,
            prev_sha256=prev.get("sha256", ""), target_sha256="DELETED",
            pub_b64=pub, revoked_ids=revoked, verify_sig_fn=verify_sig_fn)
    if prev is None and cur is not None:
        return verify_receipt(
            receipt, repo_name=repo_name, action="question.create", target=rel,
            prev_sha256="NONE", target_sha256=cur.get("sha256", ""),
            pub_b64=pub, revoked_ids=revoked, verify_sig_fn=verify_sig_fn)
    if prev is not None and cur is not None:
        return _eval_existing_question_entry(
            rel, prev, cur, receipt=receipt, repo_name=repo_name,
            pub=pub, revoked=revoked, verify_sig_fn=verify_sig_fn,
            disk_snap=disk_snap, head_q=head_q, suite_upgraded=suite_upgraded)
    return []


def _eval_questions_anchor(head_anc, cur_anc, *, receipt, repo_name, pub, revoked, verify_sig_fn,
                           disk_questions=None):
    h_q = head_anc.get("questions") or {}
    c_q = cur_anc.get("questions") or {}
    if not isinstance(h_q, dict) or not isinstance(c_q, dict):
        return [M("approval.anchors_broken")]
    suite_upgraded = is_suite_upgraded(head_anc, cur_anc)
    probs = []
    for rel in sorted(set(h_q) | set(c_q)):
        probs += eval_question_entry(
            rel, h_q.get(rel), c_q.get(rel), receipt=receipt, repo_name=repo_name,
            pub=pub, revoked=revoked, verify_sig_fn=verify_sig_fn,
            disk_snap=(disk_questions or {}).get(rel), suite_upgraded=suite_upgraded)
    return probs


def _anchors_seq_probs(head_anchors, cur_anchors):
    old_seq = safe_int(head_anchors.get("suite_seq"), 0)
    new_seq = safe_int(cur_anchors.get("suite_seq"), 0)
    if old_seq is None or new_seq is None:
        return [M("approval.anchors_broken")]
    if new_seq < old_seq:
        return [M("trust.suite_downgrade", old_seq=old_seq, new_seq=new_seq)]
    return []


def _anchors_header_probs(head_anchors, cur_anchors):
    if not isinstance(head_anchors, dict) or not isinstance(cur_anchors, dict):
        return [M("approval.anchors_broken")]
    same_repo = (cur_anchors.get("repo") or "") == (head_anchors.get("repo") or "")
    same_pub = cur_anchors.get("approver_pub") == head_anchors.get("approver_pub")
    lock_ok = not (head_anchors.get("lock_core") and not cur_anchors.get("lock_core"))
    rev_ok = not (set(head_anchors.get("revoked_ids") or ()) - set(cur_anchors.get("revoked_ids") or ()))
    qdir_ok = (cur_anchors.get("questions_dir") or "questions") == (head_anchors.get("questions_dir") or "questions")
    if not (same_repo and same_pub and lock_ok and rev_ok and qdir_ok):
        return [M("approval.anchors_broken")]
    return _anchors_seq_probs(head_anchors, cur_anchors)


def eval_anchors_integrity(head_anchors, cur_anchors, *, receipt, repo_name, verify_sig_fn=None,
                           suite_principles_md_sha=None, disk_questions=None):
    """Verify `ANCHORS.json` was not weakened relative to `HEAD:ANCHORS.json`."""
    if head_anchors is None:
        return []
    header_probs = _anchors_header_probs(head_anchors, cur_anchors)
    if header_probs:
        return header_probs
    pub = head_anchors.get("approver_pub")
    revoked = head_anchors.get("revoked_ids") or []
    out = []
    for g in sorted(set(cur_anchors.get("off_gates") or ()) - set(head_anchors.get("off_gates") or ())):
        out += verify_receipt(receipt, repo_name=repo_name, action=_GATE_OFF, target=g,
                              prev_sha256="on", target_sha256="off",
                              pub_b64=pub, revoked_ids=revoked, verify_sig_fn=verify_sig_fn)
    if cur_anchors.get("knobs_sha256", "NONE") != head_anchors.get("knobs_sha256", "NONE"):
        out += verify_receipt(receipt, repo_name=repo_name, action=_GATE_OFF, target=_KNOBS_JSON,
                              prev_sha256=head_anchors.get("knobs_sha256", "NONE"),
                              target_sha256=cur_anchors.get("knobs_sha256", "NONE"),
                              pub_b64=pub, revoked_ids=revoked, verify_sig_fn=verify_sig_fn)
    hl, cl = _local_map(head_anchors), _local_map(cur_anchors)
    if hl is not None:
        out += eval_local_scripts(hl, cl or {}, lock_core=True, receipt=receipt, repo_name=repo_name,
                                  pub_b64=pub, revoked_ids=revoked, verify_sig_fn=verify_sig_fn)
    out += _eval_principles_anchor(head_anchors, cur_anchors, receipt=receipt, repo_name=repo_name,
                                   pub=pub, revoked=revoked, verify_sig_fn=verify_sig_fn,
                                   suite_principles_md_sha=suite_principles_md_sha)
    out += _eval_questions_anchor(head_anchors, cur_anchors, receipt=receipt, repo_name=repo_name,
                                  pub=pub, revoked=revoked, verify_sig_fn=verify_sig_fn,
                                  disk_questions=disk_questions)
    return out


_T_Q = "questions/01.md"
_T_CMD = "python3 x"
_T_ORG = "org/r"
_T_FILE = "zreflect/a.py"
_T_BROKEN = "approval.anchors_broken"


def _selftest_migration():
    v1 = {
        "schema": 1,
        "repo": "org/repo",
        "approver_pub": "PUB",
        "lock_core": True,
        "revoked_ids": ["r1"],
        "knobs_sha256": "aaa",
        "questions_dir": "questions",
        "custom_scripts": {"reflect-local/measure_app.py": "bbb"},
        "off_gates": ["check_ab.py"],
        "principles": {"doc_py_sha256": "ccc", "principles_md_sha256": "ddd", "no_principles": False},
        "questions": {_T_Q: {"sha256": "eee", "status": "resolved", "settling": _T_CMD, "body_sha256": "fff"}},
    }
    m1, p1 = migrate_anchors(v1, local_scripts={"reflect-local/hook.py": "hhh"}, suite_seq=2, suite_tree_sha="ttt")
    if (p1 or not m1 or m1["schema"] != 2 or m1["suite_seq"] != 2
            or "doc_py_sha256" in m1["principles"]
            or set(m1["local_scripts"]) != {"reflect-local/measure_app.py", "reflect-local/hook.py"}):
        return False
    m2, p2 = migrate_anchors(m1)
    if p2 or m2 != m1:
        return False
    _, p_down = migrate_anchors(m1, suite_seq=1)
    if not p_down or p_down[0].code != "trust.suite_downgrade":
        return False
    bad, p_bad = migrate_anchors({"schema": 1})
    return bad is None and bool(p_bad) and p_bad[0].code == _T_BROKEN


def _selftest_receipt_checks(ok_sig):
    r_pay = {"id": "rec-1", "delegation_id": "del-1", "repo": _T_ORG, "action": _GATE_OFF,
             "target_path": _KNOBS_JSON, "prev_sha256": "a", "target_sha256": "b",
             "expires_at": "2099-01-01T00:00:00+00:00"}
    r_args = {"repo_name": _T_ORG, "action": _GATE_OFF, "target": _KNOBS_JSON,
              "prev_sha256": "a", "target_sha256": "b", "pub_b64": "PUB", "verify_sig_fn": ok_sig}
    if [p.code for p in verify_receipt({"payload": r_pay, "sig": "ok"}, revoked_ids=["del-1"], **r_args)] != ["approval.revoked"]:
        return False
    if [p.code for p in verify_receipt({"payload": {**r_pay, "expires_at": "2000-01-01T00:00:00+00:00"}, "sig": "ok"}, **r_args)] != ["approval.expired"]:
        return False
    return [p.code for p in verify_receipt({"payload": r_pay, "sig": "ok"}, verify_sig_fn=lambda *_: (False, "bad"),
                                           **{k: v for k, v in r_args.items() if k != "verify_sig_fn"})] == ["approval.signature_invalid"]


def _selftest_suite_sig_checks(tree, ok_sig):
    seal_d = {"upstream_repo": TRUSTED_UPSTREAM_REPO, "suite_seq": 3, "tree_sha256": tree}
    payload_dict = {"id": "rec-suite-1", "repo": TRUSTED_UPSTREAM_REPO, "action": _SUITE_RELEASE,
                    "target_path": _SEAL_TARGET, "suite_seq": 3, "target_sha256": tree,
                    "expires_at": "2099-01-01T00:00:00+00:00"}
    sig = {"payload": payload_dict, "sig": "ok"}
    if verify_suite_sig(seal_d, sig, pub_b64="PUB", verify_sig_fn=ok_sig) != []:
        return False
    if [p.code for p in verify_suite_sig(seal_d, sig, pub_b64="PUB", revoked_ids=["rec-suite-1"], verify_sig_fn=ok_sig)] != ["approval.revoked"]:
        return False
    spoof = {"upstream_repo": "attacker/repo", "suite_seq": 3, "tree_sha256": tree}
    if [p.code for p in verify_suite_sig(spoof, {"payload": {**payload_dict, "repo": "attacker/repo"}, "sig": "ok"}, pub_b64="PUB", verify_sig_fn=ok_sig)] != ["approval.scope_mismatch"]:
        return False
    no_exp = {"payload": {k: v for k, v in payload_dict.items() if k != "expires_at"}, "sig": "ok"}
    past_exp = {"payload": {**payload_dict, "expires_at": "2000-01-01T00:00:00+00:00"}, "sig": "ok"}
    if verify_suite_sig(seal_d, no_exp, pub_b64="PUB", verify_sig_fn=ok_sig) != [] or verify_suite_sig(seal_d, past_exp, pub_b64="PUB", verify_sig_fn=ok_sig) != []:
        return False
    bad_sig = {"payload": {**payload_dict, "suite_seq": 2}, "sig": "ok"}
    return [p.code for p in verify_suite_sig(seal_d, bad_sig, pub_b64="PUB", verify_sig_fn=ok_sig)] == ["approval.hash_mismatch"]


def _selftest_seal_and_receipt():
    files = {_T_FILE: {"file_sha256": sha256_text("a")}}
    tree = compute_tree_sha(files)
    if eval_seal_files(files, {_T_FILE: sha256_text("a")}, tree) != []:
        return False
    if [p.code for p in eval_seal_files(files, {_T_FILE: "bad"}, tree)] != ["seal.file_tampered"]:
        return False
    if [p.code for p in eval_seal_files(files, {_T_FILE: sha256_text("a"), "zreflect/x.py": "1"}, tree)] != ["seal.unlisted_file"]:
        return False
    ok_sig = lambda _p, _s, _pub: (True, None)  # noqa: E731
    return _selftest_suite_sig_checks(tree, ok_sig) and _selftest_receipt_checks(ok_sig)


def _selftest_anchors_integrity():
    base = {
        "schema": 2, "repo": _T_ORG, "approver_pub": "PUB", "lock_core": True,
        "revoked_ids": ["r1"], "suite_seq": 1, "knobs_sha256": "k1", "questions_dir": "questions",
        "local_scripts": {}, "off_gates": [],
        "principles": {"doc_py_sha256": "d1", "principles_md_sha256": "p1", "no_principles": False},
        "questions": {_T_Q: {"sha256": "q1", "status": "ready-for-agent", "settling": _T_CMD, "body_sha256": "b1"}},
    }
    rec: dict[str, list[dict[str, object]]] = {"receipts": []}
    req_code = "approval.receipt_required"
    cleaned_pr = dict(base, principles={"principles_md_sha256": "p1", "no_principles": False})
    if eval_anchors_integrity(base, dict(base), receipt=rec, repo_name=_T_ORG) != [] or eval_anchors_integrity(base, cleaned_pr, receipt=rec, repo_name=_T_ORG) != []:
        return False
    co_pr = dict(base, principles={"doc_py_sha256": "d1", "principles_md_sha256": "tampered", "no_principles": False})
    if [p.code for p in eval_anchors_integrity(base, co_pr, receipt=rec, repo_name=_T_ORG)] != [req_code]:
        return False
    co_q = dict(base, questions={_T_Q: {"sha256": "tampered", "status": "resolved", "settling": _T_CMD, "body_sha256": "b2"}})
    if [p.code for p in eval_anchors_integrity(base, co_q, receipt=rec, repo_name=_T_ORG)] != [req_code]:
        return False
    legal_q = dict(base, questions={_T_Q: {"sha256": "q2", "status": "resolved", "settling": _T_CMD, "body_sha256": "b1"}})
    if eval_anchors_integrity(base, legal_q, receipt=rec, repo_name=_T_ORG) != []:
        return False
    if parse_iso(1e30) is not None or safe_int("bad", 0) is not None or safe_int(True, 0) is not None or safe_int(1.5, 0) is not None:
        return False
    if [p.code for p in eval_anchors_integrity(base, dict(base, repo="other/repo"), receipt=rec, repo_name="other/repo")] != [_T_BROKEN]:
        return False
    same_sha_tamper = dict(base, questions={_T_Q: {"sha256": "q1", "status": "resolved", "settling": "true", "body_sha256": "other"}})
    reanchored = dict(base, suite_seq=2, questions={_T_Q: {"sha256": "q1", "status": "ready-for-agent", "settling": _T_CMD, "body_sha256": "new_b1"}})
    if ([p.code for p in eval_anchors_integrity(base, same_sha_tamper, receipt=rec, repo_name=_T_ORG)] != [_T_BROKEN]
            or eval_anchors_integrity(base, reanchored, receipt=rec, repo_name=_T_ORG, disk_questions=reanchored["questions"]) != []
            or [p.code for p in eval_anchors_integrity(base, dict(same_sha_tamper, suite_seq=2), receipt=rec, repo_name=_T_ORG, disk_questions=reanchored["questions"])] != [_T_BROKEN]):
        return False
    shrunk_rev = dict(base, revoked_ids=[])
    return [p.code for p in eval_anchors_integrity(base, shrunk_rev, receipt=rec, repo_name=_T_ORG)] == [_T_BROKEN]


def _cases():
    b_sha = sha256_text("Body")
    r_human, r_agent = "ready-for-human", "ready-for-agent"
    body_h = f"Body\n**Status:** {r_human}\n**Settling:** {_T_CMD}\n"
    body_a = f"Body\n**Status:** {r_agent}\n**Settling:** {_T_CMD}\n"
    return [
        ("★ trust_core.migrate_4_laws", _selftest_migration),
        ("★ trust_core.seal_and_suite_sig", _selftest_seal_and_receipt),
        ("★ trust_core.anchors_head_integrity", _selftest_anchors_integrity),
        ("★ trust_core.legal_settlement",
         lambda: is_legal_settlement("resolved", _T_CMD, f"Body\n**Status:** resolved\n**Settling:** {_T_CMD}\n",
                                     {"body_sha256": b_sha, "settling": _T_CMD})
         and not is_legal_settlement("resolved", "python3 y", "Body\n**Status:** resolved\n**Settling:** python3 y\n",
                                     {"body_sha256": b_sha, "settling": _T_CMD})),
        ("★ trust_core.status_triage_guard",
         lambda: is_legal_status_triage(r_human, _T_CMD, body_h, {"status": r_agent, "body_sha256": b_sha, "settling": _T_CMD})
         and is_legal_status_triage(r_agent, _T_CMD, body_a, {"status": r_human, "body_sha256": b_sha, "settling": _T_CMD})
         and not is_legal_status_triage(r_human, _T_CMD, f"Body\n  Status: spoof\n**Status:** {r_human}\n**Settling:** {_T_CMD}\n",
                                        {"status": r_agent, "body_sha256": b_sha, "settling": _T_CMD})
         and not is_legal_status_triage(r_human, _T_CMD, body_h, {"status": r_human, "body_sha256": b_sha, "settling": _T_CMD})
         and not is_legal_status_triage(r_agent, _T_CMD, body_a, {"status": "resolved", "body_sha256": b_sha, "settling": _T_CMD})
         and not is_legal_status_triage(r_human, _T_CMD, f"Changed\n**Status:** {r_human}\n**Settling:** {_T_CMD}\n",
                                        {"status": r_agent, "body_sha256": b_sha, "settling": _T_CMD})),
    ]


if __name__ == "__main__":
    raise SystemExit(main_selftest_or(
        sys.argv[1:], M("seal.title"), _cases, lambda _a: fatal(M("trust.unknown_command"))))
