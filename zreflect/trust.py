#!/usr/bin/env python3
"""Layer-3 trust adapters: 4 Ports (FS, Git, Crypto, HTTP Approver), SEAL.json, ANCHORS.json, --migrate, --upgrade."""
from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gate  # noqa: E402
import knobs  # noqa: E402
import trust_core  # noqa: E402
from gate import fatal, main_selftest_or, module_meta  # noqa: E402
from i18n import M  # noqa: E402

MODULE = module_meta("trust", "Trust v2 adapters: suite seal, local anchors, Ed25519 receipts, migrate & upgrade")

SEAL_NAME = "SEAL.json"
SUITE_SIG_NAME = "SUITE.sig"
ANCHORS_FILE = trust_core.ANCHORS_FILE
RECEIPT_ENV = "EINFACHT_APPROVAL_RECEIPT"
APPROVER_URL_ENV = "EINFACHT_APPROVER_URL"
APPROVER_PUB_ENV = "EINFACHT_APPROVER_PUB"
DEFAULT_APPROVER_URL = "http://127.0.0.1:18443"
SYSTEM_PUB_PATH = "/etc/einfacht-approver/signing_pub.pem"
PINNED_APPROVER_PUB = (
    "-----BEGIN PUBLIC KEY-----\n"
    "MCowBQYDK2VwAyEAvf9ckQEI6CkK30ookgtqjT6I3H0PXzo6ov25212pyDQ=\n"
    "-----END PUBLIC KEY-----\n"
)


# ---------------------------------------------------------------------------
# Port 1: Crypto (Ed25519)
# ---------------------------------------------------------------------------

def _read_pub_text(path):
    try:
        with open(path, encoding="ascii") as fh:
            txt = fh.read().strip()
        if "BEGIN PUBLIC KEY" in txt:
            return txt + "\n"
        return txt or None
    except OSError:
        return None


def pinned_approver_pub():
    """Return `EINFACHT_APPROVER_PUB`, system-installed approver public key PEM, or pinned key."""
    env_pub = (os.environ.get(APPROVER_PUB_ENV) or "").strip()
    if env_pub:
        if os.path.isfile(env_pub):
            loaded = _read_pub_text(env_pub)
            if loaded:
                return loaded
        return env_pub + ("\n" if "BEGIN PUBLIC KEY" in env_pub else "")
    if os.path.isfile(SYSTEM_PUB_PATH):
        loaded = _read_pub_text(SYSTEM_PUB_PATH)
        if loaded and "BEGIN PUBLIC KEY" in loaded:
            return loaded
    return PINNED_APPROVER_PUB


def ed25519_verify(payload_bytes, sig_b64, pub_key):
    """Verify Ed25519 signature over `payload_bytes`."""
    try:
        from cryptography.exceptions import InvalidSignature  # noqa: PLC0415
        from cryptography.hazmat.primitives import serialization  # noqa: PLC0415
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey  # noqa: PLC0415
    except ImportError:
        return False, "crypto_unavailable"
    try:
        if "BEGIN PUBLIC KEY" in str(pub_key):
            loaded = serialization.load_pem_public_key(str(pub_key).encode("ascii"))
            if not isinstance(loaded, Ed25519PublicKey):
                return False, "signature_invalid"
            pub = loaded
        else:
            pub = Ed25519PublicKey.from_public_bytes(base64.b64decode(pub_key))
        pub.verify(base64.b64decode(sig_b64), payload_bytes)
        return True, None
    except (InvalidSignature, ValueError, TypeError):
        return False, "signature_invalid"


# ---------------------------------------------------------------------------
# Port 2: Filesystem (hashes, SEAL.json, ANCHORS.json, reflect-local/)
# ---------------------------------------------------------------------------

def sha256_file(path):
    """Streaming/normalized SHA-256 hex digest of `path` (`None` if missing)."""
    try:
        with open(path, "rb") as fh:
            return trust_core.sha256_bytes(fh.read())
    except OSError:
        return None


def _sha256_norm(path):
    with open(path, encoding="utf-8") as fh:
        raw = fh.read().replace("\r\n", "\n").replace("\r", "\n")
    return trust_core.sha256_text(raw)


def _sha256_norm_file(path):
    if not os.path.isfile(path):
        return None
    try:
        return _sha256_norm(path)
    except (OSError, UnicodeError):
        return sha256_file(path)


def _sha256_bytes_norm(raw):
    try:
        txt = raw.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
        return trust_core.sha256_text(txt)
    except UnicodeDecodeError:
        return trust_core.sha256_bytes(raw)


def seal_path(zdir=None):
    """Path to `zreflect/SEAL.json`."""
    return os.path.join(zdir or gate.zdir(), SEAL_NAME)


def suite_sig_path(zdir=None):
    """Path to optional `zreflect/SUITE.sig`."""
    return os.path.join(zdir or gate.zdir(), SUITE_SIG_NAME)


def seal_exists(zdir=None):
    """True iff `zreflect/SEAL.json` exists."""
    return os.path.isfile(seal_path(zdir))


def load_seal(path=None):
    """Load `(data, error_Message)` for `SEAL.json`."""
    p = path or seal_path()
    if not os.path.isfile(p):
        return None, M("seal.missing", path=p)
    try:
        with open(p, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None, M("seal.broken", path=p)
    if not isinstance(data, dict) or not isinstance(data.get("files"), dict):
        return None, M("seal.broken", path=p)
    return data, None


def load_suite_sig(zdir=None):
    """Load `zreflect/SUITE.sig` dict if present, else `None`."""
    p = suite_sig_path(zdir)
    if not os.path.isfile(p):
        return None
    try:
        with open(p, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _collect_suite_relpaths(root, zdir):
    """Collect sorted repo-relative paths of all upstream suite files (`zreflect/` + `ruff.toml`)."""
    out = []
    for dirpath, dirnames, filenames in os.walk(zdir):
        dirnames[:] = sorted(d for d in dirnames if d not in ("__pycache__", ".mypy_cache", ".ruff_cache"))
        for fname in sorted(filenames):
            if fname.endswith((".pyc", ".pyo")) or fname in (SEAL_NAME, SUITE_SIG_NAME):
                continue
            full = os.path.join(dirpath, fname)
            out.append(os.path.relpath(full, root).replace(os.sep, "/"))
    ruff = os.path.join(root, "ruff.toml")
    if os.path.isfile(ruff):
        out.append("ruff.toml")
    return sorted(set(out))


def is_sealed_target(path, root=None, zdir=None):
    """True iff `path` is explicitly listed in a valid `SEAL.json`."""
    zd = zdir or gate.zdir()
    rt = root or gate.tool_repo()
    data, err = load_seal(seal_path(zd))
    if err or not data:
        return False
    rel = os.path.relpath(os.path.realpath(path), os.path.realpath(rt)).replace(os.sep, "/")
    return rel in (data.get("files") or {})


def local_dir_name(root=None):
    """Configured consumer local extension directory name (default `reflect-local`)."""
    cfg = knobs.repo_config(root) if root else {}
    raw = str(cfg.get("REFLECT_LOCAL_DIR") or knobs.get("REFLECT_LOCAL_DIR", root) or "reflect-local").strip()
    return raw.strip("/\\") or "reflect-local"


def local_scripts_map(root=None):
    """Collect `{relpath: sha256}` for all `.py` files and optional `principles.json` under `reflect-local/`."""
    base = root or gate.GATE_REPO
    ldir_name = local_dir_name(base)
    ldir = os.path.join(base, ldir_name)
    if not os.path.isdir(ldir):
        return {}
    out = {}
    for dirpath, dirnames, filenames in os.walk(ldir):
        dirnames[:] = sorted(d for d in dirnames if d not in ("__pycache__", ".mypy_cache", ".ruff_cache"))
        for fname in sorted(filenames):
            if not (fname.endswith(".py") or (dirpath == ldir and fname == "principles.json")):
                continue
            full = os.path.join(dirpath, fname)
            rel = os.path.relpath(full, base).replace(os.sep, "/")
            out[rel] = _sha256_norm_file(full)
    return out


def load_anchors(root=None):
    """Load `<repo>/ANCHORS.json`; `None` if absent, `{}` if corrupt."""
    p = os.path.join(root or gate.GATE_REPO, ANCHORS_FILE)
    if not os.path.isfile(p):
        return None
    try:
        with open(p, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_anchors(root, data):
    """Write `<repo>/ANCHORS.json` canonically."""
    with open(os.path.join(root, ANCHORS_FILE), "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False, sort_keys=True)
        fh.write("\n")


# ---------------------------------------------------------------------------
# Port 3: Git (repo_id, HEAD:ANCHORS.json, receipt bundle in .git)
# ---------------------------------------------------------------------------

def repo_id(root=None):
    """Canonical repo identifier: `owner/repo` from git remote `origin` when available, else dir basename."""
    base = os.path.abspath(root or gate.GATE_REPO)
    try:
        r = subprocess.run(["git", "-C", base, "remote", "get-url", "origin"],
                           capture_output=True, text=True, timeout=5,
                           encoding="utf-8", errors="replace")
        if r.returncode == 0 and r.stdout.strip():
            url = r.stdout.strip().rstrip("/")
            if url.endswith(".git"):
                url = url[:-4]
            part = url.split(":", 1)[-1] if ("@" in url and "://" not in url) else url.rsplit("/", 2)
            if isinstance(part, list) and len(part) >= 2:
                return "/".join(part[-2:])
            if isinstance(part, str) and "/" in part:
                return "/".join(part.split("/")[-2:])
    except (OSError, subprocess.TimeoutExpired):
        pass
    return os.path.basename(base)


def _default_receipt_path(root=None):
    base = os.path.abspath(root or gate.GATE_REPO)
    try:
        r = subprocess.run(["git", "-C", base, "rev-parse", "--git-dir"],
                           capture_output=True, text=True, timeout=5,
                           encoding="utf-8", errors="replace")
        if r.returncode == 0 and r.stdout.strip():
            gdir = r.stdout.strip()
            if not os.path.isabs(gdir):
                gdir = os.path.join(base, gdir)
            return os.path.join(gdir, "einfacht-receipt.json")
    except (OSError, subprocess.TimeoutExpired):
        pass
    return os.path.join(base, ".git", "einfacht-receipt.json")


def load_receipt(path=None, root=None):
    """Load receipt or bundle from explicit `path` / `EINFACHT_APPROVAL_RECEIPT`, else `.git/einfacht-receipt.json`."""
    base = root or gate.GATE_REPO
    explicit = path or os.environ.get(RECEIPT_ENV)
    p = explicit if explicit else _default_receipt_path(base)
    if not p or not os.path.isfile(p):
        return None
    try:
        with open(p, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, (dict, list)) else None
    except (OSError, ValueError):
        return None


def _save_receipt_to_bundle(receipt, out_path):
    items = []
    if os.path.isfile(out_path):
        try:
            with open(out_path, encoding="utf-8") as fh:
                old = json.load(fh)
            if isinstance(old, dict) and isinstance(old.get("receipts"), list):
                items = [x for x in old["receipts"] if isinstance(x, dict)]
            elif isinstance(old, dict) and ("sig" in old or "payload" in old):
                items = [old]
        except (OSError, ValueError):
            items = []
    nb = trust_core.receipt_body(receipt)
    nkey = (nb.get("repo"), nb.get("action"), nb.get("target") or nb.get("target_path"))
    kept = [x for x in items if (
        trust_core.receipt_body(x).get("repo"),
        trust_core.receipt_body(x).get("action"),
        trust_core.receipt_body(x).get("target") or trust_core.receipt_body(x).get("target_path"),
    ) != nkey]
    kept.append(receipt)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump({"receipts": kept}, fh, indent=2)


def _baseline_anchors(base):
    if not os.path.exists(os.path.join(base, ".git")):
        return None, None
    try:
        ls = subprocess.run(["git", "-C", base, "ls-files", "--error-unmatch", ANCHORS_FILE],
                            capture_output=True, text=True, timeout=5,
                            encoding="utf-8", errors="replace")
        cat = subprocess.run(["git", "-C", base, "cat-file", "-e", "HEAD:" + ANCHORS_FILE],
                             capture_output=True, text=True, timeout=5,
                             encoding="utf-8", errors="replace")
        if ls.returncode != 0 or cat.returncode != 0:
            return None, None
        show = subprocess.run(["git", "-C", base, "show", "HEAD:" + ANCHORS_FILE],
                              capture_output=True, text=True, timeout=5,
                              encoding="utf-8", errors="replace")
        if show.returncode != 0:
            return {}, "broken"
        data = json.loads(show.stdout)
        return (data, None) if isinstance(data, dict) else ({}, "broken")
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return {}, "broken"


# ---------------------------------------------------------------------------
# Port 4: HTTP Approver Client (Approver Protocol v2)
# ---------------------------------------------------------------------------

def _classify_action(rel, text, prev_sha="NONE"):
    if rel == "PRINCIPLES.md":
        return "principles.edit"
    if rel == "zreflect/doc.py":
        return "seal.doc"
    if rel in ("knobs.json", "ANCHORS.json"):
        return "gate.off"
    if rel.startswith("questions/"):
        if prev_sha == "NONE":
            return "question.create"
        if text is None:
            return "question.delete"
        return "question.modify"
    return "seal.core"


def _git_prev_sha_and_diff(base, rel):
    try:
        r = subprocess.run(["git", "-C", base, "show", "HEAD:" + rel], capture_output=True, timeout=5)
        prev_sha = _sha256_bytes_norm(r.stdout) if r.returncode == 0 else "NONE"
        d = subprocess.run(["git", "-C", base, "diff", "HEAD", "--", rel],
                           capture_output=True, text=True, timeout=5,
                           encoding="utf-8", errors="replace")
        return prev_sha, (d.stdout or "")[:8000]
    except (OSError, subprocess.TimeoutExpired):
        return "NONE", ""


def build_requests(changed_paths, root=None, repo_name=None):
    """Build Approver Protocol v2 `POST /requests` payloads for controlled paths."""
    base = root or gate.GATE_REPO
    rname = repo_name or repo_id(base)
    ldir_prefix = local_dir_name(base) + "/"
    out = []
    for raw in sorted(set(changed_paths or ())):
        rel = str(raw).replace("\\", "/").lstrip("./")
        if not (rel.startswith(("zreflect/", ldir_prefix, "questions/")) or rel in trust_core.CONTROLLED_FILES):
            continue
        full = os.path.join(base, rel)
        text = None
        if os.path.isfile(full):
            try:
                with open(full, encoding="utf-8", errors="replace") as fh:
                    text = fh.read()
            except OSError:
                text = None
        target_sha = _sha256_norm_file(full) or "DELETED"
        prev_sha, diff_sum = _git_prev_sha_and_diff(base, rel)
        out.append({
            "repo": rname,
            "agent_id": os.environ.get("USER", "agent"),
            "action": _classify_action(rel, text, prev_sha=prev_sha),
            "target_path": rel,
            "prev_sha256": prev_sha,
            "target_sha256": target_sha,
            "target_content": (text or "")[:32000],
            "diff_summary": diff_sum or ("(new or binary file %s)" % rel),
        })
    return out


def _post_auto_sync(url, payload, out_path):
    try:
        req = urllib.request.Request(
            url + "/requests", data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=1.5) as r:
            resp = json.loads(r.read().decode("utf-8"))
        if resp.get("receipt"):
            _save_receipt_to_bundle(resp["receipt"], out_path)
            return True
        if resp.get("status") in ("denied", "rejected_duplicate"):
            label = resp.get("display_id") or resp.get("id", "")
            reason = resp.get("deny_reason") or resp.get("status")
            print(f"  · approval.denied(id={label!r}, target={payload['target_path']!r}, reason={reason!r})",
                  file=sys.stderr)
    except (urllib.error.URLError, OSError, ValueError):
        pass
    return False


def _auto_sync_for_probs(base, anchors, probs):
    if not os.path.exists(os.path.join(base, ".git")):
        return False
    if not (anchors.get("approver_pub") or "").strip():
        return False
    targets = [p.params["target"] for p in probs
               if getattr(p, "code", "") in ("approval.receipt_required", "approval.scope_mismatch", "approval.expired")
               and p.params.get("target")]
    if not targets:
        return False
    reqs = build_requests(targets, root=base, repo_name=anchors.get("repo") or repo_id(base))
    url = (os.environ.get(APPROVER_URL_ENV) or DEFAULT_APPROVER_URL).rstrip("/")
    out_path = os.environ.get(RECEIPT_ENV) or _default_receipt_path(base)
    results = [_post_auto_sync(url, p, out_path) for p in reqs]
    return any(results)


# ---------------------------------------------------------------------------
# High-level Seal & Anchor Verification
# ---------------------------------------------------------------------------

def current_tree_sha(root=None, zdir=None, verified=False):
    """Return `tree_sha256` from `SEAL.json` (verifying disk files first unless `verified=True`)."""
    zd = zdir or gate.zdir()
    data, err = load_seal(seal_path(zd))
    if err or not data:
        return None
    if not verified and verify_problems(root=root, zdir=zd):
        return None
    return data.get("tree_sha256") or trust_core.compute_tree_sha(data.get("files") or {})


def _actual_suite_hashes(rt, zd):
    actual = {}
    for rel in _collect_suite_relpaths(rt, zd):
        actual[rel] = _sha256_norm_file(os.path.join(rt, rel))
    return actual


def _verify_suite_receipt(rt, anchors, anc_tree, tree_sha, receipt):
    rec = receipt if receipt is not None else load_receipt(root=rt)
    kw = {"repo_name": anchors.get("repo") or repo_id(rt), "action": "seal.core",
          "target": "zreflect/SEAL.json", "prev_sha256": anc_tree, "target_sha256": tree_sha,
          "pub_b64": anchors.get("approver_pub"), "revoked_ids": anchors.get("revoked_ids") or [],
          "verify_sig_fn": ed25519_verify}
    probs = trust_core.verify_receipt(rec, **kw)
    if receipt is None and probs and _auto_sync_for_probs(rt, anchors, probs):
        probs = trust_core.verify_receipt(load_receipt(root=rt), **kw)
    return probs


def _head_seal_file_sha(rt):
    if not os.path.exists(os.path.join(rt, ".git")):
        return None
    try:
        r = subprocess.run(["git", "-C", rt, "show", "HEAD:zreflect/SEAL.json"], capture_output=True, timeout=5)
        return _sha256_bytes_norm(r.stdout) if r.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def _verify_anchor_lock(rt, zd, data, anchors, receipt):
    anc_seq, seal_seq = int(anchors.get("suite_seq") or 0), int(data.get("suite_seq") or 0)
    if seal_seq < anc_seq:
        return [M("trust.suite_downgrade", old_seq=anc_seq, new_seq=seal_seq)]
    sig = load_suite_sig(zd)
    if sig is not None:
        sig_probs = trust_core.verify_suite_sig(
            data, sig, pub_b64=anchors.get("approver_pub"), verify_sig_fn=ed25519_verify)
        if not sig_probs:
            return []
        if seal_seq > anc_seq:
            return sig_probs
    cur_file_sha = _sha256_norm_file(seal_path(zd)) or "DELETED"
    head_file_sha = _head_seal_file_sha(rt)
    if head_file_sha and cur_file_sha != head_file_sha:
        return _verify_suite_receipt(rt, anchors, head_file_sha, cur_file_sha, receipt)
    tree_sha = data.get("tree_sha256") or trust_core.compute_tree_sha(data.get("files") or {})
    anc_tree = anchors.get("suite_tree_sha256")
    if anc_tree and tree_sha != anc_tree:
        return _verify_suite_receipt(rt, anchors, anc_tree, tree_sha, receipt)
    return []


def verify_problems(root=None, zdir=None, receipt=None):
    """Verify `zreflect/SEAL.json`, suite signature / anti-downgrade, and `lock_core` receipt if changed."""
    zd, rt = zdir or gate.zdir(), root or gate.tool_repo()
    data, err = load_seal(seal_path(zd))
    if err:
        return [err]
    probs = trust_core.eval_seal_files(data.get("files"), _actual_suite_hashes(rt, zd), data.get("tree_sha256"))
    if probs:
        return probs
    anchors = load_anchors(rt)
    if not anchors or not anchors.get("lock_core"):
        return []
    return _verify_anchor_lock(rt, zd, data, anchors, receipt)


def reseal(targets, force_all=False, root=None, zdir=None):
    """Update `zreflect/SEAL.json` for `targets` (or all suite files when `force_all=True`)."""
    zd = zdir or gate.zdir()
    rt = root or gate.tool_repo()
    old_data, _ = load_seal(seal_path(zd))
    old_files = dict((old_data or {}).get("files") or {})
    rels = _collect_suite_relpaths(rt, zd)
    if not force_all:
        norm_targets = {t.replace("\\", "/").lstrip("./") for t in targets}
        for t in norm_targets:
            if t not in rels:
                return None, M("seal.unlisted_file", file=t)
    new_files = {}
    for rel in rels:
        if force_all or rel in {t.replace("\\", "/").lstrip("./") for t in targets} or rel not in old_files:
            full = os.path.join(rt, rel)
            new_files[rel] = {"file_sha256": _sha256_norm(full)}
        else:
            new_files[rel] = old_files[rel]
    tree = trust_core.compute_tree_sha(new_files)
    out = {
        "schema": trust_core.SEAL_SCHEMA,
        "upstream_repo": (old_data or {}).get("upstream_repo") or "ArchivalEra/Einfacht",
        "suite_seq": int((old_data or {}).get("suite_seq") or 1),
        "tree_sha256": tree,
        "files": new_files,
    }
    with open(seal_path(zd), "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
        fh.write("\n")
    return tree, None


def _check_integrity(anchors, root, rec):
    head, err = _baseline_anchors(root)
    if err:
        return [M("approval.anchors_broken")]
    return trust_core.eval_anchors_integrity(
        head, anchors, receipt=rec,
        repo_name=anchors.get("repo") or repo_id(root), verify_sig_fn=ed25519_verify)


def check_knobs_anchor(root=None, receipt=None, now=None):
    """Verify `knobs.json` and `reflect-local/*.py` (including `hook.py`) against `ANCHORS.json`."""
    base = root or gate.GATE_REPO
    anchors = load_anchors(base)
    if anchors is None:
        return []
    if not anchors:
        return [M("approval.anchors_broken")]
    rec = receipt if receipt is not None else load_receipt(root=base)
    out = _check_integrity(anchors, base, rec)
    rname = anchors.get("repo") or repo_id(base)
    pub = anchors.get("approver_pub")
    revoked = anchors.get("revoked_ids") or []
    expected_local = anchors.get("local_scripts") if "local_scripts" in anchors else anchors.get("custom_scripts")
    if expected_local is not None:
        out += trust_core.eval_local_scripts(
            expected_local, local_scripts_map(base), lock_core=bool(anchors.get("lock_core", False)),
            receipt=rec, repo_name=rname, pub_b64=pub, revoked_ids=revoked, now=now,
            verify_sig_fn=ed25519_verify)
    if "knobs_sha256" in anchors or os.path.isfile(os.path.join(base, "knobs.json")):
        cur_sha = _sha256_norm_file(os.path.join(base, "knobs.json")) or "NONE"
        prev_sha = anchors.get("knobs_sha256", "NONE")
        if cur_sha != prev_sha:
            out += trust_core.verify_receipt(
                rec, repo_name=rname, action="gate.off", target="knobs.json",
                prev_sha256=prev_sha, target_sha256=cur_sha, pub_b64=pub,
                revoked_ids=revoked, now=now, verify_sig_fn=ed25519_verify)
    if receipt is None and out and _auto_sync_for_probs(base, anchors, out):
        return check_knobs_anchor(root=base, receipt=load_receipt(root=base), now=now)
    return out


def check_principles_repo(root=None, receipt=None):
    """Verify `PRINCIPLES.md`, `doc.py`, and `REFLECT_NO_PRINCIPLES` against `ANCHORS.json`."""
    base = root or gate.GATE_REPO
    anchors = load_anchors(base)
    if anchors is None:
        return []
    if not anchors:
        return [M("approval.anchors_broken")]
    doc_sha = _sha256_norm_file(os.path.join(gate.zdir(), "doc.py"))
    md_sha = _sha256_norm_file(os.path.join(base, "PRINCIPLES.md"))
    no_pr = knobs.flag("REFLECT_NO_PRINCIPLES") is True
    rec = receipt if receipt is not None else load_receipt(root=base)

    def _eval(r):
        pr = anchors.get("principles") or {}
        pub = anchors.get("approver_pub")
        rname = anchors.get("repo") or repo_id(base)
        revoked = anchors.get("revoked_ids") or []
        probs = _check_integrity(anchors, base, r)
        if no_pr and not pr.get("no_principles", False):
            probs += trust_core.verify_receipt(
                r, repo_name=rname, action="principles.disable", target="REFLECT_NO_PRINCIPLES",
                prev_sha256="false", target_sha256="true", pub_b64=pub, revoked_ids=revoked,
                verify_sig_fn=ed25519_verify)
        if md_sha != pr.get("principles_md_sha256"):
            probs += trust_core.verify_receipt(
                r, repo_name=rname, action="principles.edit", target="PRINCIPLES.md",
                prev_sha256=pr.get("principles_md_sha256", ""), target_sha256=md_sha or "DELETED",
                pub_b64=pub, revoked_ids=revoked, verify_sig_fn=ed25519_verify)
        if doc_sha != pr.get("doc_py_sha256"):
            probs += trust_core.verify_receipt(
                r, repo_name=rname, action="seal.doc", target="zreflect/doc.py",
                prev_sha256=pr.get("doc_py_sha256", ""), target_sha256=doc_sha or "DELETED",
                pub_b64=pub, revoked_ids=revoked, verify_sig_fn=ed25519_verify)
        return probs

    out = _eval(rec)
    if receipt is None and out and _auto_sync_for_probs(base, anchors, out):
        out = _eval(load_receipt(root=base))
    return out


def check_off_gates_anchor(off_list, root=None, receipt=None, now=None):
    """Verify newly disabled gates against `ANCHORS.json`."""
    base = root or gate.GATE_REPO
    anchors = load_anchors(base)
    if anchors is None:
        return []
    if not anchors:
        return [M("approval.anchors_broken")]
    rec = receipt if receipt is not None else load_receipt(root=base)
    out = _check_integrity(anchors, base, rec)
    allowed = set(anchors.get("off_gates") or ())
    extra = sorted(os.path.basename(f) for f in off_list if os.path.basename(f) not in allowed)
    if not extra:
        return out
    pub, rname = anchors.get("approver_pub"), anchors.get("repo") or repo_id(base)
    revoked = anchors.get("revoked_ids") or []

    def _eval_extra(r):
        res = []
        for name in extra:
            res += trust_core.verify_receipt(
                r, repo_name=rname, action="gate.off", target=name,
                prev_sha256="on", target_sha256="off", pub_b64=pub, revoked_ids=revoked,
                now=now, verify_sig_fn=ed25519_verify)
        return res

    out += _eval_extra(rec)
    if receipt is None and out and _auto_sync_for_probs(base, anchors, out):
        rec2 = load_receipt(root=base)
        out = _check_integrity(anchors, base, rec2) + _eval_extra(rec2)
    return out


def _q_field(text, name):
    if not text:
        return ""
    import check_questions  # noqa: PLC0415
    return check_questions.field(text, name) or ""


def _eval_one_question(rel, cur, prev, r, *, rname, pub, revoked):
    if cur is None and prev is not None:
        return trust_core.verify_receipt(
            r, repo_name=rname, action="question.delete", target=rel,
            prev_sha256=prev.get("sha256", ""), target_sha256="DELETED",
            pub_b64=pub, revoked_ids=revoked, verify_sig_fn=ed25519_verify)
    if prev is None and cur is not None:
        return trust_core.verify_receipt(
            r, repo_name=rname, action="question.create", target=rel,
            prev_sha256="NONE", target_sha256=trust_core.sha256_text(cur),
            pub_b64=pub, revoked_ids=revoked, verify_sig_fn=ed25519_verify)
    if (prev is not None and cur is not None and trust_core.sha256_text(cur) != prev.get("sha256")
            and not trust_core.is_legal_settlement(_q_field(cur, "Status"), _q_field(cur, "Settling"), cur, prev)):
        return trust_core.verify_receipt(
            r, repo_name=rname, action="question.modify", target=rel,
            prev_sha256=prev.get("sha256", ""), target_sha256=trust_core.sha256_text(cur),
            pub_b64=pub, revoked_ids=revoked, verify_sig_fn=ed25519_verify)
    return []


def check_questions_against_anchor(files, root=None, receipt=None, qdir=None):
    """Verify `questions/*.md` changes against `ANCHORS.json`."""
    base = root or gate.GATE_REPO
    anchors = load_anchors(base)
    if anchors is None:
        return []
    if not anchors:
        return [M("approval.anchors_broken")]
    rec = receipt if receipt is not None else load_receipt(root=base)
    cfg = knobs.repo_config(base) if base else {}
    cfg_qdir = str(cfg.get("REFLECT_QUESTIONS") or knobs.REGISTRY["REFLECT_QUESTIONS"][1]).strip().rstrip("/") or "questions"
    anc_qdir = (anchors.get("questions_dir") or cfg_qdir).rstrip("/")

    def _eval(r):
        q_map = anchors.get("questions") or {}
        if qdir and qdir.rstrip("/") not in (cfg_qdir, anc_qdir) and any(
            k.startswith((anc_qdir + "/", cfg_qdir + "/")) for k in q_map
        ):
            return [M("approval.anchors_broken")]
        if qdir:
            q_map = {k: v for k, v in q_map.items() if k.startswith(qdir.rstrip("/") + "/")}
        pub, rname = anchors.get("approver_pub"), anchors.get("repo") or repo_id(base)
        revoked = anchors.get("revoked_ids") or []
        probs = _check_integrity(anchors, base, r)
        for rel in sorted(set(q_map) | set(files)):
            probs += _eval_one_question(rel, files.get(rel), q_map.get(rel), r,
                                        rname=rname, pub=pub, revoked=revoked)
        return probs

    out = _eval(rec)
    if receipt is None and out and _auto_sync_for_probs(base, anchors, out):
        out = _eval(load_receipt(root=base))
    return out


# ---------------------------------------------------------------------------
# Init, Sync, Migrate, Upgrade
# ---------------------------------------------------------------------------

def _build_anchors(root, pub_b64=None):
    import check_questions  # noqa: PLC0415
    files = check_questions.collect(root=root)
    q_map = {k: trust_core.question_snapshot(v, _q_field(v, "Status"), _q_field(v, "Settling"))
             for k, v in sorted(files.items())}
    off_list = sorted(x.strip() for x in (knobs.get("REFLECT_OFF_GATES") or "").split(",") if x.strip())
    seal_d, _ = load_seal(seal_path(os.path.join(root, "zreflect")))
    return {
        "schema": trust_core.ANCHOR_SCHEMA,
        "repo": repo_id(root),
        "approver_pub": pub_b64 if pub_b64 is not None else pinned_approver_pub(),
        "lock_core": True,
        "revoked_ids": [],
        "suite_seq": int((seal_d or {}).get("suite_seq") or 1),
        "suite_tree_sha256": (seal_d or {}).get("tree_sha256") or "",
        "knobs_sha256": _sha256_norm_file(os.path.join(root, "knobs.json")) or "NONE",
        "questions_dir": str((knobs.repo_config(root) or {}).get("REFLECT_QUESTIONS") or "questions").strip().rstrip("/") or "questions",
        "local_scripts": local_scripts_map(root),
        "off_gates": off_list,
        "principles": {
            "doc_py_sha256": _sha256_norm_file(os.path.join(gate.zdir(), "doc.py")),
            "principles_md_sha256": _sha256_norm_file(os.path.join(root, "PRINCIPLES.md")),
            "no_principles": knobs.flag("REFLECT_NO_PRINCIPLES") is True,
        },
        "questions": q_map,
    }


def init_anchors(root=None, pub_b64=None):
    """Initialize `<repo>/ANCHORS.json` schema v2 if absent."""
    base = root or gate.GATE_REPO
    p = os.path.join(base, ANCHORS_FILE)
    if os.path.exists(p):
        return 1
    write_anchors(base, _build_anchors(base, pub_b64=pub_b64))
    return 0


def cmd_migrate(argv=()):
    """Migrate `<repo>/ANCHORS.json` from schema v1 to v2 (idempotent, monotonic)."""
    _ = argv
    base = gate.GATE_REPO
    raw = load_anchors(base)
    if not raw:
        return fatal(M("approval.anchors_broken"))
    seal_d, _ = load_seal(seal_path(os.path.join(base, "zreflect")))
    migrated, probs = trust_core.migrate_anchors(
        raw,
        local_scripts=local_scripts_map(base),
        suite_seq=(seal_d or {}).get("suite_seq"),
        suite_tree_sha=(seal_d or {}).get("tree_sha256"),
    )
    if probs or not migrated:
        return fatal(probs[0] if probs else M("approval.anchors_broken"))
    write_anchors(base, migrated)
    print(f"migrate.ok(schema={migrated['schema']}, suite_seq={migrated['suite_seq']})")
    return 0


def _validate_upgrade_source(src, dst_anc):
    src_z = os.path.join(src, "zreflect")
    seal_d, err = load_seal(seal_path(src_z))
    if err or not seal_d:
        return None, err or M("seal.broken", path=seal_path(src_z))
    probs = verify_problems(root=src, zdir=src_z)
    if probs:
        return None, probs[0]
    if dst_anc:
        old_seq, new_seq = int(dst_anc.get("suite_seq") or 0), int(seal_d.get("suite_seq") or 0)
        if new_seq < old_seq:
            return None, M("trust.suite_downgrade", old_seq=old_seq, new_seq=new_seq)
        sig = load_suite_sig(src_z)
        if dst_anc.get("lock_core") and new_seq > old_seq:
            if sig is None:
                return None, M("approval.receipt_required", action="suite.release", target="zreflect/SEAL.json")
            sig_probs = trust_core.verify_suite_sig(
                seal_d, sig, pub_b64=dst_anc.get("approver_pub"), verify_sig_fn=ed25519_verify)
            if sig_probs:
                return None, sig_probs[0]
    return seal_d, None


def _post_upgrade_refresh(dst):
    for sub_cmd in ([sys.executable, "zreflect/facts.py", "--accept-changes"],
                    [sys.executable, "zreflect/facts.py", "--render-doc"]):
        r = subprocess.run(sub_cmd, cwd=dst, capture_output=True, text=True, check=False,
                           encoding="utf-8", errors="replace")
        if r.returncode != 0:
            sys.stderr.write(r.stderr or r.stdout)
            return r.returncode
    hook_py = os.path.join(dst, local_dir_name(dst), "hook.py")
    if os.path.isfile(hook_py):
        subprocess.run([sys.executable, hook_py, "--chain"], cwd=dst, capture_output=True, text=True,
                       check=False, encoding="utf-8", errors="replace")
    return 0


def cmd_upgrade(argv):
    """Out-of-repo painless suite upgrade: verify source SEAL/SUITE.sig, replace zreflect/ + ruff.toml, preserve reflect-local/."""
    if len(argv) < 2 or not os.path.isdir(os.path.join(argv[1], "zreflect")):
        return fatal(M("trust.unknown_command"))
    src, dst = os.path.abspath(argv[1]), os.path.abspath(gate.GATE_REPO)
    dst_anc = load_anchors(dst)
    seal_d, err = _validate_upgrade_source(src, dst_anc)
    if err or not seal_d:
        return fatal(err)
    dst_z = os.path.join(dst, "zreflect")
    if os.path.isdir(dst_z):
        shutil.rmtree(dst_z)
    shutil.copytree(os.path.join(src, "zreflect"), dst_z, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    if os.path.isfile(os.path.join(src, "ruff.toml")):
        shutil.copy2(os.path.join(src, "ruff.toml"), os.path.join(dst, "ruff.toml"))
    if dst_anc:
        migrated, mprobs = trust_core.migrate_anchors(
            dst_anc, local_scripts=local_scripts_map(dst),
            suite_seq=seal_d.get("suite_seq"), suite_tree_sha=seal_d.get("tree_sha256"))
        if mprobs:
            return fatal(mprobs[0])
        write_anchors(dst, migrated)
    rc = _post_upgrade_refresh(dst)
    if rc != 0:
        return rc
    print(f"upgrade.ok(from={src!r}, suite_seq={seal_d.get('suite_seq', 1)})")
    return 0


def _sync_settled(root):
    import check_questions  # noqa: PLC0415
    anchors = load_anchors(root)
    if not anchors:
        return 2
    files = check_questions.collect(root=root)
    off_list = sorted(x.strip() for x in (knobs.get("REFLECT_OFF_GATES") or "").split(",") if x.strip())
    probs = (
        verify_problems(root=root, zdir=os.path.join(root, "zreflect"))
        + check_knobs_anchor(root=root)
        + check_off_gates_anchor(off_list, root=root)
        + check_principles_repo(root=root)
        + check_questions_against_anchor(files, root=root)
    )
    if probs:
        for p in probs:
            print(p, file=sys.stderr)
        return 2
    head, _err = _baseline_anchors(root)
    synced = _build_anchors(root, pub_b64=anchors.get("approver_pub"))
    synced["repo"] = anchors.get("repo") or synced["repo"]
    synced["lock_core"] = bool(anchors.get("lock_core", True))
    synced["revoked_ids"] = sorted(
        set(anchors.get("revoked_ids") or ()) | set((head or {}).get("revoked_ids") or ())
    )
    write_anchors(root, synced)
    print(M("approval.anchors_synced", count=len(synced.get("questions") or {})))
    return 0


# ---------------------------------------------------------------------------
# Selftests
# ---------------------------------------------------------------------------

def _selftest_local_scripts_and_upgrade():
    pub_b64 = base64.b64encode(b"0" * 32).decode("ascii")
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "src")
        dst = os.path.join(d, "dst")
        os.makedirs(os.path.join(src, "zreflect"))
        os.makedirs(os.path.join(dst, "zreflect"))
        os.makedirs(os.path.join(dst, "reflect-local"))
        with open(os.path.join(src, "zreflect", "doc.py"), "w", encoding="utf-8") as fh:
            fh.write("RULES = ()\n")
        with open(os.path.join(src, "ruff.toml"), "w", encoding="utf-8") as fh:
            fh.write("line-length = 120\n")
        shutil.copy2(os.path.join(src, "zreflect", "doc.py"), os.path.join(dst, "zreflect", "doc.py"))
        shutil.copy2(os.path.join(src, "ruff.toml"), os.path.join(dst, "ruff.toml"))
        # Build v1 SEAL in src with suite_seq=2 and SUITE.sig
        files_map = {
            "ruff.toml": {"file_sha256": _sha256_norm(os.path.join(src, "ruff.toml"))},
            "zreflect/doc.py": {"file_sha256": _sha256_norm(os.path.join(src, "zreflect", "doc.py"))},
        }
        tree = trust_core.compute_tree_sha(files_map)
        with open(os.path.join(src, "zreflect", SEAL_NAME), "w", encoding="utf-8") as fh:
            json.dump({"schema": 2, "upstream_repo": "ArchivalEra/Einfacht", "suite_seq": 2,
                       "tree_sha256": tree, "files": files_map}, fh)
        sig = {
            "payload": {
                "repo": "ArchivalEra/Einfacht", "action": "suite.release",
                "target_path": "zreflect/SEAL.json", "suite_seq": 2, "target_sha256": tree,
                "expires_at": "2099-01-01T00:00:00+00:00",
            },
            "sig": base64.b64encode(b"0" * 64).decode("ascii"),
        }
        with open(os.path.join(src, "zreflect", SUITE_SIG_NAME), "w", encoding="utf-8") as fh:
            json.dump(sig, fh)
        # Setup dst with custom reflect-local/hook.py & measure_app.py
        hook_p = os.path.join(dst, "reflect-local", "hook.py")
        meas_p = os.path.join(dst, "reflect-local", "measure_app.py")
        with open(hook_p, "w", encoding="utf-8") as fh:
            fh.write("# custom consumer hook\n")
        with open(meas_p, "w", encoding="utf-8") as fh:
            fh.write("def measure():\n    return {}\n")
        anc = {
            "schema": 2, "repo": "consumer/app", "approver_pub": pub_b64, "lock_core": True,
            "revoked_ids": [], "suite_seq": 1, "suite_tree_sha256": "0" * 64,
            "knobs_sha256": "NONE", "questions_dir": "questions",
            "local_scripts": local_scripts_map(dst),
            "off_gates": [], "principles": {}, "questions": {},
        }
        write_anchors(dst, anc)
        # Tampering reflect-local/hook.py without receipt must fail with approval.receipt_required
        with open(hook_p, "w", encoding="utf-8") as fh:
            fh.write("# disarmed\n")
        probs = check_knobs_anchor(root=dst, receipt={"receipts": []})
        if [p.code for p in probs] != ["approval.receipt_required"]:
            return False
        # Restore hook_p and test downgrade rejection (suite_seq 2 -> 1)
        with open(hook_p, "w", encoding="utf-8") as fh:
            fh.write("# custom consumer hook\n")
        write_anchors(dst, dict(anc, suite_seq=3))
        old_repo = gate.GATE_REPO
        try:
            gate.GATE_REPO = dst
            if cmd_upgrade(["--upgrade", src]) != 2:
                return False
        finally:
            gate.GATE_REPO = old_repo
        return os.path.isfile(hook_p) and os.path.isfile(meas_p)


def _selftest_reseal_approval():
    with tempfile.TemporaryDirectory() as rt:
        os.makedirs(os.path.join(rt, "zreflect"))
        with open(os.path.join(rt, "zreflect", "a.py"), "w", encoding="utf-8") as fh:
            fh.write("x = 1\n")
        tree, err = reseal(["zreflect/a.py"], force_all=True, root=rt, zdir=os.path.join(rt, "zreflect"))
        if err or not tree:
            return False
        with open(os.path.join(rt, "zreflect", "new_unsealed.py"), "w", encoding="utf-8") as fh:
            fh.write("y = 2\n")
        unlisted = verify_problems(root=rt, zdir=os.path.join(rt, "zreflect"), receipt={"receipts": []})
        if [p.code for p in unlisted] != ["seal.unlisted_file"]:
            return False
        os.remove(os.path.join(rt, "zreflect", "new_unsealed.py"))
        write_anchors(rt, {
            "schema": 2, "repo": "org/r", "approver_pub": pinned_approver_pub(), "lock_core": True,
            "revoked_ids": [], "suite_seq": 1, "suite_tree_sha256": "0" * 64,
            "knobs_sha256": "NONE", "questions_dir": "questions", "local_scripts": {},
            "off_gates": [], "principles": {}, "questions": {},
        })
        probs = verify_problems(root=rt, zdir=os.path.join(rt, "zreflect"), receipt={"receipts": []})
        return [p.code for p in probs] == ["approval.receipt_required"]


def _selftest_crlf_and_verify():
    with tempfile.TemporaryDirectory() as rt:
        os.makedirs(os.path.join(rt, ".git"))
        lf_p = os.path.join(rt, "lf.json")
        crlf_p = os.path.join(rt, "crlf.json")
        with open(lf_p, "wb") as fh:
            fh.write(b'{\n  "k": "v"\n}\n')
        with open(crlf_p, "wb") as fh:
            fh.write(b'{\r\n  "k": "v"\r\n}\r\n')
        h_lf, h_crlf = _sha256_norm_file(lf_p), _sha256_norm_file(crlf_p)
        if not h_lf or h_lf != h_crlf or _sha256_bytes_norm(b'{\n  "k": "v"\n}\n') != h_crlf:
            return False
        seen: dict[str, bool] = {}
        orig = globals()["_post_auto_sync"]
        globals()["_post_auto_sync"] = lambda _u, p, _o: seen.setdefault(p["target_path"], True)
        try:
            probs = [M("approval.receipt_required", action="gate.off", target="knobs.json"),
                     M("approval.receipt_required", action="gate.off", target="ruff.toml")]
            if not _auto_sync_for_probs(rt, {"approver_pub": "x"}, probs) or len(seen) != 2:
                return False
        finally:
            globals()["_post_auto_sync"] = orig
    ok, err = ed25519_verify(b"msg", "AA==", base64.b64encode(b"0" * 32).decode("ascii"))
    return (not ok) and err in ("signature_invalid", "crypto_unavailable")


def _cases():
    return [
        ("★ trust.local_scripts_tamper_and_downgrade_rejected", _selftest_local_scripts_and_upgrade),
        ("★ trust.reseal_requires_approval", _selftest_reseal_approval),
        ("★ trust.crlf_and_verify_contract", _selftest_crlf_and_verify),
    ]


def _cmd_verify_seal(_argv):
    probs = verify_problems()
    if probs:
        for p in probs:
            print("  · %s" % p, file=sys.stderr)
        return 1
    print(current_tree_sha(verified=True) or "")
    return 0


def _cmd_init(_argv):
    rc = init_anchors()
    if rc == 0:
        print(M("approval.anchors_created", path=ANCHORS_FILE))
    return rc


def _main_cli(argv):
    from typing import Any  # noqa: PLC0415
    table: dict[str, Any] = {
        "--verify-seal": _cmd_verify_seal,
        "--init": _cmd_init,
        "--sync": lambda _a: _sync_settled(gate.GATE_REPO),
        "--migrate": cmd_migrate,
        "--upgrade": cmd_upgrade,
    }
    for flag, fn in table.items():
        if flag in argv:
            return fn(argv)
    return fatal(M("trust.unknown_command"))


if __name__ == "__main__":
    raise SystemExit(main_selftest_or(sys.argv[1:], M("seal.title"), _cases, _main_cli))
