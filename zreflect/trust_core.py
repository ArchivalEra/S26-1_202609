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
CONTROLLED_PREFIXES = ("zreflect/", "reflect-local/", "questions/")
CONTROLLED_FILES = frozenset({"PRINCIPLES.md", "knobs.json", "ruff.toml"})


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


def parse_iso(ts):
    """Parse ISO-8601 string or numeric timestamp into UTC `datetime` (or `None`)."""
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts, tz=timezone.utc)
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def strip_status_settling(text):
    """Strip `Status:` and `Settling:` fields from a question markdown body."""
    lines = (text or "").splitlines()
    out = []
    skip_cont = False
    for ln in lines:
        if re.match(r"(?i)^\*{0,2}(Status|Settling)\*{0,2}\s*:\s*\*{0,2}", ln.strip()):
            skip_cont = ln.strip().lstrip("*").lower().startswith("settling")
            continue
        if skip_cont and (ln.startswith(("  ", "\t")) or not ln.strip()):
            if not ln.strip():
                skip_cont = False
            continue
        skip_cont = False
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


def is_legal_settlement(new_status, new_settling, new_text, prev_entry):
    """True iff question transitioned to `resolved` without altering body or settling."""
    if not isinstance(prev_entry, dict):
        return False
    if (new_status or "").lower() != "resolved":
        return False
    if is_none_like(prev_entry.get("settling")) or is_none_like(new_settling):
        return False
    if sha256_text(strip_status_settling(new_text)) != prev_entry.get("body_sha256"):
        return False
    return (new_settling or "").strip() == (prev_entry.get("settling") or "").strip()


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


def _check_sig_result(ok, err, target):
    if ok:
        return []
    if err == "crypto_unavailable":
        return [M("approval.crypto_unavailable", target=target)]
    return [M("approval.signature_invalid", target=target)]


def verify_receipt(receipt, *, repo_name, action, target, prev_sha256, target_sha256,
                   pub_b64, revoked_ids=(), now=None, verify_sig_fn=None):
    """Verify an Ed25519 approval receipt purely via `verify_sig_fn(payload, sig_b64, pub_b64)`."""
    picked = select_receipt(receipt, action=action, target=target, target_sha256=target_sha256)
    if not isinstance(picked, dict) or not pub_b64:
        return [M("approval.receipt_required", action=action, target=target)]
    body = receipt_body(picked)
    rec_id = str(body.get("id") or body.get("receipt_id") or "")
    deleg_id = str(body.get("delegation_id") or "")
    if rec_id in set(revoked_ids) or (deleg_id and deleg_id in set(revoked_ids)):
        return [M("approval.revoked", id=deleg_id or rec_id)]
    exp = parse_iso(body.get("expires_at"))
    if exp is None or exp <= (now or datetime.now(timezone.utc)):
        return [M("approval.expired", id=rec_id)]
    if body.get("repo") != repo_name or body.get("action") != action or (body.get("target") or body.get("target_path")) != target:
        return [M("approval.scope_mismatch", action=action, target=target)]
    if body.get("prev_sha256") != prev_sha256 or body.get("target_sha256") != target_sha256:
        return [M("approval.hash_mismatch", target=target)]
    if verify_sig_fn is None:
        return [M("approval.crypto_unavailable", target=target)]
    ok, err = verify_sig_fn(canonical_payload(picked), str(picked.get("sig") or ""), pub_b64)
    return _check_sig_result(ok, err, target)


def verify_suite_sig(seal_data, suite_sig, *, pub_b64, now=None, verify_sig_fn=None):
    """Verify `suite.release` signature binding `(upstream_repo, suite_seq, tree_sha256)`."""
    target = "zreflect/SEAL.json"
    if not isinstance(seal_data, dict) or not isinstance(suite_sig, dict) or not pub_b64:
        return [M("approval.receipt_required", action="suite.release", target=target)]
    body = receipt_body(suite_sig)
    exp = parse_iso(body.get("expires_at"))
    if exp is not None and exp <= (now or datetime.now(timezone.utc)):
        return [M("approval.expired", id=str(body.get("id") or body.get("receipt_id") or ""))]
    up_repo = seal_data.get("upstream_repo") or "ArchivalEra/Einfacht"
    if body.get("repo") != up_repo or body.get("action") != "suite.release" or (body.get("target") or body.get("target_path")) != target:
        return [M("approval.scope_mismatch", action="suite.release", target=target)]
    if body.get("target_sha256") != seal_data.get("tree_sha256"):
        return [M("approval.hash_mismatch", target=target)]
    if body.get("suite_seq") is not None and int(body["suite_seq"]) != int(seal_data.get("suite_seq") or 0):
        return [M("approval.hash_mismatch", target=target)]
    if verify_sig_fn is None:
        return [M("approval.crypto_unavailable", target=target)]
    ok, err = verify_sig_fn(canonical_payload(suite_sig), str(suite_sig.get("sig") or ""), pub_b64)
    return _check_sig_result(ok, err, target)


def migrate_anchors(raw, *, local_scripts=None, suite_seq=None, suite_tree_sha=None):
    """4-law migration algebra (schema 1 -> 2): idempotent, monotonic, total, scope-preserving."""
    if not isinstance(raw, dict) or not isinstance(raw.get("repo"), str) or not raw.get("repo"):
        return None, [M("approval.anchors_broken")]
    old_schema = raw.get("schema", 1)
    if not isinstance(old_schema, int) or old_schema < 1 or old_schema > ANCHOR_SCHEMA:
        return None, [M("approval.anchors_broken")]
    old_seq = int(raw.get("suite_seq") or 0)
    new_seq = int(suite_seq) if suite_seq is not None else old_seq
    if new_seq < old_seq:
        return None, [M("trust.suite_downgrade", old_seq=old_seq, new_seq=new_seq)]
    merged_local = {}
    if isinstance(raw.get("custom_scripts"), dict):
        merged_local.update(raw["custom_scripts"])
    if isinstance(raw.get("local_scripts"), dict):
        merged_local.update(raw["local_scripts"])
    if isinstance(local_scripts, dict):
        merged_local.update(local_scripts)
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
        "local_scripts": {k: merged_local[k] for k in sorted(merged_local)},
        "off_gates": sorted(set(raw.get("off_gates") or ())),
        "principles": dict(raw.get("principles") or {}),
        "questions": {k: dict(v) for k, v in sorted((raw.get("questions") or {}).items())},
    }
    return out, []


def eval_seal_files(expected_files, actual_hashes, expected_tree_sha=None):
    """Purely compare `SEAL.json` `files` map against disk hashes; return list of `Message`."""
    if not isinstance(expected_files, dict) or not expected_files:
        return [M("seal.broken", path="zreflect/SEAL.json")]
    probs = []
    for rel in sorted(expected_files):
        entry = expected_files[rel]
        exp_sha = entry.get("file_sha256") if isinstance(entry, dict) else None
        if not exp_sha:
            return [M("seal.broken", path="zreflect/SEAL.json")]
        got = actual_hashes.get(rel)
        if got is None:
            probs.append(M("seal.file_missing", file=rel))
        elif got != exp_sha:
            probs.append(M("seal.file_tampered", file=rel))
    probs.extend(M("seal.unlisted_file", file=rel) for rel in sorted(actual_hashes) if rel not in expected_files)
    if expected_tree_sha and compute_tree_sha(expected_files) != expected_tree_sha:
        probs.append(M("seal.broken", path="zreflect/SEAL.json"))
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


def _eval_principles_anchor(head_anc, cur_anc, *, receipt, repo_name, pub, revoked, verify_sig_fn):
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
    if c_pr.get("principles_md_sha256") != h_pr.get("principles_md_sha256"):
        probs += verify_receipt(
            receipt, repo_name=repo_name, action="principles.edit", target="PRINCIPLES.md",
            prev_sha256=h_pr.get("principles_md_sha256") or "",
            target_sha256=c_pr.get("principles_md_sha256") or "DELETED",
            pub_b64=pub, revoked_ids=revoked, verify_sig_fn=verify_sig_fn)
    if c_pr.get("doc_py_sha256") != h_pr.get("doc_py_sha256"):
        probs += verify_receipt(
            receipt, repo_name=repo_name, action="seal.doc", target="zreflect/doc.py",
            prev_sha256=h_pr.get("doc_py_sha256") or "",
            target_sha256=c_pr.get("doc_py_sha256") or "DELETED",
            pub_b64=pub, revoked_ids=revoked, verify_sig_fn=verify_sig_fn)
    return probs


def _is_legal_snapshot_settlement(head_entry, cur_entry):
    if not isinstance(head_entry, dict) or not isinstance(cur_entry, dict):
        return False
    if (cur_entry.get("status") or "").lower() != "resolved":
        return False
    if is_none_like(head_entry.get("settling")) or is_none_like(cur_entry.get("settling")):
        return False
    if not head_entry.get("body_sha256") or cur_entry.get("body_sha256") != head_entry.get("body_sha256"):
        return False
    return (cur_entry.get("settling") or "").strip() == (head_entry.get("settling") or "").strip()


def _eval_questions_anchor(head_anc, cur_anc, *, receipt, repo_name, pub, revoked, verify_sig_fn):
    h_q = head_anc.get("questions") or {}
    c_q = cur_anc.get("questions") or {}
    probs = []
    for rel in sorted(set(h_q) | set(c_q)):
        prev, cur = h_q.get(rel), c_q.get(rel)
        if prev is not None and cur is None:
            probs += verify_receipt(
                receipt, repo_name=repo_name, action="question.delete", target=rel,
                prev_sha256=prev.get("sha256", ""), target_sha256="DELETED",
                pub_b64=pub, revoked_ids=revoked, verify_sig_fn=verify_sig_fn)
        elif prev is None and cur is not None:
            probs += verify_receipt(
                receipt, repo_name=repo_name, action="question.create", target=rel,
                prev_sha256="NONE", target_sha256=cur.get("sha256", ""),
                pub_b64=pub, revoked_ids=revoked, verify_sig_fn=verify_sig_fn)
        elif (isinstance(prev, dict) and isinstance(cur, dict)
              and cur.get("sha256") != prev.get("sha256")
              and not _is_legal_snapshot_settlement(prev, cur)):
            probs += verify_receipt(
                receipt, repo_name=repo_name, action="question.modify", target=rel,
                prev_sha256=prev.get("sha256", ""), target_sha256=cur.get("sha256", ""),
                pub_b64=pub, revoked_ids=revoked, verify_sig_fn=verify_sig_fn)
    return probs


def _anchors_header_probs(head_anchors, cur_anchors):
    if not isinstance(head_anchors, dict) or not isinstance(cur_anchors, dict):
        return [M("approval.anchors_broken")]
    pub = head_anchors.get("approver_pub")
    if cur_anchors.get("approver_pub") != pub or (head_anchors.get("lock_core") and not cur_anchors.get("lock_core")):
        return [M("approval.anchors_broken")]
    if set(head_anchors.get("revoked_ids") or ()) - set(cur_anchors.get("revoked_ids") or ()):
        return [M("approval.anchors_broken")]
    if (cur_anchors.get("questions_dir") or "questions") != (head_anchors.get("questions_dir") or "questions"):
        return [M("approval.anchors_broken")]
    old_seq, new_seq = int(head_anchors.get("suite_seq") or 0), int(cur_anchors.get("suite_seq") or 0)
    if new_seq < old_seq:
        return [M("trust.suite_downgrade", old_seq=old_seq, new_seq=new_seq)]
    return []


def eval_anchors_integrity(head_anchors, cur_anchors, *, receipt, repo_name, verify_sig_fn=None):
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
        out += verify_receipt(receipt, repo_name=repo_name, action="gate.off", target=g,
                              prev_sha256="on", target_sha256="off",
                              pub_b64=pub, revoked_ids=revoked, verify_sig_fn=verify_sig_fn)
    if cur_anchors.get("knobs_sha256", "NONE") != head_anchors.get("knobs_sha256", "NONE"):
        out += verify_receipt(receipt, repo_name=repo_name, action="gate.off", target="knobs.json",
                              prev_sha256=head_anchors.get("knobs_sha256", "NONE"),
                              target_sha256=cur_anchors.get("knobs_sha256", "NONE"),
                              pub_b64=pub, revoked_ids=revoked, verify_sig_fn=verify_sig_fn)
    hl, cl = _local_map(head_anchors), _local_map(cur_anchors)
    if hl is not None:
        out += eval_local_scripts(hl, cl or {}, lock_core=True, receipt=receipt, repo_name=repo_name,
                                  pub_b64=pub, revoked_ids=revoked, verify_sig_fn=verify_sig_fn)
    out += _eval_principles_anchor(head_anchors, cur_anchors, receipt=receipt, repo_name=repo_name,
                                   pub=pub, revoked=revoked, verify_sig_fn=verify_sig_fn)
    out += _eval_questions_anchor(head_anchors, cur_anchors, receipt=receipt, repo_name=repo_name,
                                  pub=pub, revoked=revoked, verify_sig_fn=verify_sig_fn)
    return out


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
        "questions": {"questions/01.md": {"sha256": "eee", "status": "resolved", "settling": "python3 x", "body_sha256": "fff"}},
    }
    m1, p1 = migrate_anchors(v1, local_scripts={"reflect-local/hook.py": "hhh"}, suite_seq=2, suite_tree_sha="ttt")
    if p1 or not m1 or m1["schema"] != 2 or m1["suite_seq"] != 2:
        return False
    m2, p2 = migrate_anchors(m1)
    if p2 or m2 != m1:
        return False
    _, p_down = migrate_anchors(m1, suite_seq=1)
    if not p_down or p_down[0].code != "trust.suite_downgrade":
        return False
    bad, p_bad = migrate_anchors({"schema": 1})
    return bad is None and bool(p_bad) and p_bad[0].code == "approval.anchors_broken"


def _selftest_seal_and_receipt():
    files = {"zreflect/a.py": {"file_sha256": sha256_text("a")}}
    tree = compute_tree_sha(files)
    if eval_seal_files(files, {"zreflect/a.py": sha256_text("a")}, tree) != []:
        return False
    if [p.code for p in eval_seal_files(files, {"zreflect/a.py": "bad"}, tree)] != ["seal.file_tampered"]:
        return False
    if [p.code for p in eval_seal_files(files, {"zreflect/a.py": sha256_text("a"), "zreflect/x.py": "1"}, tree)] != ["seal.unlisted_file"]:
        return False
    ok_sig = lambda _p, _s, _pub: (True, None)  # noqa: E731
    seal_d = {"upstream_repo": "ArchivalEra/Einfacht", "suite_seq": 3, "tree_sha256": tree}
    payload_dict = {"repo": "ArchivalEra/Einfacht", "action": "suite.release",
                    "target_path": "zreflect/SEAL.json", "suite_seq": 3, "target_sha256": tree}
    sig = {"payload": payload_dict, "sig": "ok"}
    if verify_suite_sig(seal_d, sig, pub_b64="PUB", verify_sig_fn=ok_sig) != []:
        return False
    bad_sig = {"payload": {**payload_dict, "suite_seq": 2}, "sig": "ok"}
    return [p.code for p in verify_suite_sig(seal_d, bad_sig, pub_b64="PUB", verify_sig_fn=ok_sig)] == ["approval.hash_mismatch"]


def _selftest_anchors_integrity():
    base = {
        "schema": 2, "repo": "org/r", "approver_pub": "PUB", "lock_core": True,
        "revoked_ids": ["r1"], "suite_seq": 1, "knobs_sha256": "k1", "questions_dir": "questions",
        "local_scripts": {}, "off_gates": [],
        "principles": {"doc_py_sha256": "d1", "principles_md_sha256": "p1", "no_principles": False},
        "questions": {"questions/01.md": {"sha256": "q1", "status": "ready-for-agent", "settling": "python3 x", "body_sha256": "b1"}},
    }
    if eval_anchors_integrity(base, dict(base), receipt={"receipts": []}, repo_name="org/r") != []:
        return False
    co_pr = dict(base, principles={"doc_py_sha256": "d1", "principles_md_sha256": "tampered", "no_principles": False})
    if [p.code for p in eval_anchors_integrity(base, co_pr, receipt={"receipts": []}, repo_name="org/r")] != ["approval.receipt_required"]:
        return False
    co_q = dict(base, questions={"questions/01.md": {"sha256": "tampered", "status": "resolved", "settling": "python3 x", "body_sha256": "b2"}})
    if [p.code for p in eval_anchors_integrity(base, co_q, receipt={"receipts": []}, repo_name="org/r")] != ["approval.receipt_required"]:
        return False
    legal_q = dict(base, questions={"questions/01.md": {"sha256": "q2", "status": "resolved", "settling": "python3 x", "body_sha256": "b1"}})
    if eval_anchors_integrity(base, legal_q, receipt={"receipts": []}, repo_name="org/r") != []:
        return False
    shrunk_rev = dict(base, revoked_ids=[])
    return [p.code for p in eval_anchors_integrity(base, shrunk_rev, receipt={"receipts": []}, repo_name="org/r")] == ["approval.anchors_broken"]


def _cases():
    return [
        ("★ trust_core.migrate_4_laws", _selftest_migration),
        ("★ trust_core.seal_and_suite_sig", _selftest_seal_and_receipt),
        ("★ trust_core.anchors_head_integrity", _selftest_anchors_integrity),
        ("★ trust_core.legal_settlement",
         lambda: is_legal_settlement("resolved", "python3 x", "Body\n**Status:** resolved\n**Settling:** python3 x\n",
                                     {"body_sha256": sha256_text("Body"), "settling": "python3 x"})
         and not is_legal_settlement("resolved", "python3 y", "Body\n**Status:** resolved\n**Settling:** python3 y\n",
                                     {"body_sha256": sha256_text("Body"), "settling": "python3 x"})),
    ]


if __name__ == "__main__":
    raise SystemExit(main_selftest_or(
        sys.argv[1:], M("seal.title"), _cases, lambda _a: fatal(M("trust.unknown_command"))))
