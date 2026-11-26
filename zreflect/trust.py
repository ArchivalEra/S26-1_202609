#!/usr/bin/env python3
"""Layer-3 trust adapters: 4 Ports (FS, Git, Crypto, HTTP Approver), SEAL.json, ANCHORS.json, --migrate, --upgrade."""
from __future__ import annotations

import base64
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
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
_RUFF_TOML = "ruff.toml"
_RECEIPT_FILE = "einfacht-receipt.json"
_HEAD_PREFIX = "HEAD:"
_PRINCIPLES_MD = "PRINCIPLES.md"
_DOC_REL = "zreflect/doc.py"
_KNOBS_JSON = "knobs.json"
_SEAL_REL = "zreflect/SEAL.json"
_FACTS_REL = "zreflect/facts.py"
_DOC_NAME = "doc.py"
_PEM_HDR = "BEGIN PUBLIC KEY"
_EXP_FUTURE = "2099-01-01T00:00:00+00:00"
_TEST_CONSUMER = "consumer/app"
_TEST_ORG = "org/r"
_GATE_OFF = "gate.off"
_SEAL_CORE = "seal.core"
_SUITE_RELEASE = "suite.release"
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
        if _PEM_HDR in txt:
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
        return env_pub + ("\n" if _PEM_HDR in env_pub else "")
    if os.path.isfile(SYSTEM_PUB_PATH):
        loaded = _read_pub_text(SYSTEM_PUB_PATH)
        if loaded and _PEM_HDR in loaded:
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
        if _PEM_HDR in str(pub_key):
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


def _sha256_norm_file(path):
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            return trust_core.sha256_text(fh.read().replace("\r\n", "\n").replace("\r", "\n"))
    except (OSError, UnicodeError):
        return sha256_file(path)


def _sha256_bytes_norm(raw):
    try:
        txt = raw.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
        return trust_core.sha256_text(txt)
    except UnicodeDecodeError:
        return trust_core.sha256_bytes(raw)


def _load_json_dict(path):
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _write_json_atomic(path, data, *, indent=2, ensure_ascii=False, sort_keys=True):
    out_dir = os.path.dirname(os.path.abspath(path))
    os.makedirs(out_dir, exist_ok=True)
    fd, tmp_p = tempfile.mkstemp(prefix=".einfacht-json-", suffix=".tmp", dir=out_dir)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=indent, ensure_ascii=ensure_ascii, sort_keys=sort_keys)
            fh.write("\n")
        os.replace(tmp_p, path)
    except Exception:
        if os.path.exists(tmp_p):
            os.remove(tmp_p)
        raise


def seal_path(zdir=None):
    """Path to `zreflect/SEAL.json`."""
    return os.path.join(zdir or gate.zdir(), SEAL_NAME)


def seal_exists(zdir=None):
    """True iff `zreflect/SEAL.json` exists."""
    return os.path.isfile(seal_path(zdir))


def load_seal(path=None):
    """Load `(data, error_Message)` for `SEAL.json`."""
    p = path or seal_path()
    if not os.path.isfile(p):
        return None, M("seal.missing", path=p)
    data = _load_json_dict(p)
    if data is None or not isinstance(data.get("files"), dict):
        return None, M("seal.broken", path=p)
    return data, None


def load_suite_sig(zdir=None):
    """Load `zreflect/SUITE.sig` dict if present, else `None`."""
    return _load_json_dict(os.path.join(zdir or gate.zdir(), SUITE_SIG_NAME))


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
    ruff = os.path.join(root, _RUFF_TOML)
    if os.path.isfile(ruff):
        out.append(_RUFF_TOML)
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
    return _load_json_dict(p) or {}


def write_anchors(root, data):
    """Write `<repo>/ANCHORS.json` canonically."""
    _write_json_atomic(os.path.join(root, ANCHORS_FILE), data)


# ---------------------------------------------------------------------------
# Port 3: Git (repo_id, HEAD:ANCHORS.json, receipt bundle in .git)
# ---------------------------------------------------------------------------

_GIT_ENV_STRIP = ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
                  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_PREFIX")


def _clean_git_env():
    return {k: v for k, v in os.environ.items() if k not in _GIT_ENV_STRIP}


def _git_run(base, *args, text=True):
    try:
        cmd = ["git", "-C", base, *args]
        if text:
            return subprocess.run(cmd, capture_output=True, text=True, timeout=5, env=_clean_git_env(),
                                  encoding="utf-8", errors="replace")
        return subprocess.run(cmd, capture_output=True, timeout=5, env=_clean_git_env())
    except (OSError, subprocess.TimeoutExpired):
        return None


def repo_id(root=None):
    """Canonical repo identifier: `owner/repo` from git remote `origin` when available, else dir basename."""
    base = os.path.abspath(root or gate.GATE_REPO)
    r = _git_run(base, "remote", "get-url", "origin")
    if r is not None and r.returncode == 0 and r.stdout.strip():
        url = r.stdout.strip().rstrip("/")
        if url.endswith(".git"):
            url = url[:-4]
        part = url.split(":", 1)[-1] if ("@" in url and "://" not in url) else url.rsplit("/", 2)
        if isinstance(part, list) and len(part) >= 2:
            return "/".join(part[-2:])
        if isinstance(part, str) and "/" in part:
            return "/".join(part.split("/")[-2:])
    return os.path.basename(base)


def _has_git(base):
    if os.path.exists(os.path.join(base, ".git")):
        return True
    r = _git_run(base, "rev-parse", "--git-dir")
    return bool(r is not None and r.returncode == 0)


def _default_receipt_path(root=None):
    base = os.path.abspath(root or gate.GATE_REPO)
    for flag in ("--git-common-dir", "--git-dir"):
        r = _git_run(base, "rev-parse", flag)
        if r is not None and r.returncode == 0 and r.stdout.strip():
            gdir = r.stdout.strip()
            if not os.path.isabs(gdir):
                gdir = os.path.join(base, gdir)
            return os.path.abspath(os.path.join(gdir, _RECEIPT_FILE))
    return os.path.join(base, ".git", _RECEIPT_FILE)


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


def _bundle_key_part(val):
    return json.dumps(val, sort_keys=True) if isinstance(val, (dict, list)) else val


def _bundle_rec_key(rec):
    b = trust_core.receipt_body(rec)
    return tuple(_bundle_key_part(v) for v in (
        b.get("repo"), b.get("action"), b.get("target") or b.get("target_path"),
        b.get("prev_sha256"), b.get("target_sha256"), b.get("suite_seq"),
    ))


def _read_bundle_items(out_path):
    if not os.path.isfile(out_path):
        return []
    with open(out_path, encoding="utf-8") as fh:
        old = json.load(fh)
    if isinstance(old, list):
        return [x for x in old if isinstance(x, dict)]
    if isinstance(old, dict) and isinstance(old.get("receipts"), list):
        return [x for x in old["receipts"] if isinstance(x, dict)]
    if isinstance(old, dict) and ({"sig", "payload"} & old.keys()):
        return [old]
    raise ValueError(f"invalid receipt bundle format: {out_path}")


def _save_receipts_to_bundle(receipts, out_path):
    by_key = {_bundle_rec_key(r): r for r in receipts if isinstance(r, dict)}
    for rec in _read_bundle_items(out_path):
        by_key.setdefault(_bundle_rec_key(rec), rec)
    _write_json_atomic(out_path, {"receipts": list(by_key.values())})


def _baseline_anchors(base):
    if not _has_git(base):
        return None, None
    cat = _git_run(base, "cat-file", "-e", _HEAD_PREFIX + ANCHORS_FILE)
    if cat is None:
        return {}, "broken"
    if cat.returncode != 0:
        return None, None
    show = _git_run(base, "show", _HEAD_PREFIX + ANCHORS_FILE)
    if show is None or show.returncode != 0:
        return {}, "broken"
    try:
        data = json.loads(show.stdout)
        return (data, None) if isinstance(data, dict) else ({}, "broken")
    except ValueError:
        return {}, "broken"


# ---------------------------------------------------------------------------
# Port 4: HTTP Approver Client (Approver Protocol v2)
# ---------------------------------------------------------------------------

def _classify_action(rel, text, prev_sha="NONE"):
    if rel == _PRINCIPLES_MD:
        return "principles.edit"
    if rel in (_KNOBS_JSON, "ANCHORS.json"):
        return _GATE_OFF
    if rel.startswith("questions/"):
        if prev_sha == "NONE":
            return "question.create"
        if text is None:
            return "question.delete"
        return "question.modify"
    return _SEAL_CORE


def _git_prev_sha_and_diff(base, rel):
    r = _git_run(base, "show", _HEAD_PREFIX + rel, text=False)
    prev_sha = _sha256_bytes_norm(r.stdout) if (r is not None and r.returncode == 0) else "NONE"
    d = _git_run(base, "diff", "HEAD", "--", rel)
    return prev_sha, ((d.stdout if d is not None else "") or "")[:8000]


def _symbolic_request(rel, rname, agent):
    if rel == "REFLECT_NO_PRINCIPLES":
        return {
            "repo": rname, "agent_id": agent, "action": "principles.disable",
            "target_path": rel, "prev_sha256": "false", "target_sha256": "true",
            "target_content": "REFLECT_NO_PRINCIPLES=1\n",
            "diff_summary": "REFLECT_NO_PRINCIPLES: false -> true",
        }
    if "/" not in rel and (rel == "doctor.py" or (rel.startswith("check_") and rel.endswith(".py"))):
        return {
            "repo": rname, "agent_id": agent, "action": _GATE_OFF,
            "target_path": rel, "prev_sha256": "on", "target_sha256": "off",
            "target_content": "REFLECT_OFF_GATES += %s\n" % rel,
            "diff_summary": "gate.off %s: on -> off" % rel,
        }
    return None


def _seal_pair(base, anchors):
    zd = os.path.join(base, "zreflect")
    sp = seal_path(zd)
    cur_file_sha = _sha256_norm_file(sp) or "DELETED"
    head_file_sha = _head_seal_file_sha(base)
    if head_file_sha and cur_file_sha != head_file_sha:
        return head_file_sha, cur_file_sha
    data, _ = load_seal(sp)
    if data:
        tree_sha = data.get("tree_sha256") or trust_core.compute_tree_sha(data.get("files") or {})
        anc_tree = (anchors or {}).get("suite_tree_sha256")
        if anc_tree and tree_sha != anc_tree:
            return anc_tree, tree_sha
    return None, None


def _add_pr_and_q_overrides(base, anc, out):
    pr = anc.get("principles") or {}
    if "principles_md_sha256" in pr:
        out[_PRINCIPLES_MD] = (pr.get("principles_md_sha256") or "", None)
    for qrel, qmeta in (anc.get("questions") or {}).items():
        if isinstance(qmeta, dict):
            out[qrel] = (qmeta.get("sha256") or "NONE", None)
    sp, st = _seal_pair(base, anc)
    if sp is not None:
        out[_SEAL_REL] = (sp, st)


def _anchored_overrides(base, anchors):
    anc = anchors if anchors is not None else (load_anchors(base) or {})
    out = {_KNOBS_JSON: (anc.get("knobs_sha256", "NONE"), None)}
    anc_local = anc.get("local_scripts") if "local_scripts" in anc else (anc.get("custom_scripts") or {})
    for rel in set(anc_local or ()) | set(local_scripts_map(base)):
        out[rel] = ((anc_local or {}).get(rel, "NONE"), None)
    _add_pr_and_q_overrides(base, anc, out)
    return out


def _file_request(base, rel, rname, agent, prev_override=None, target_override=None):
    full = os.path.join(base, rel)
    text = None
    if os.path.isfile(full):
        try:
            with open(full, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError:
            text = None
    target_sha = target_override or _sha256_norm_file(full) or "DELETED"
    git_prev, diff_sum = _git_prev_sha_and_diff(base, rel)
    prev_sha = prev_override if prev_override is not None else git_prev
    return {
        "repo": rname,
        "agent_id": agent,
        "action": _classify_action(rel, text, prev_sha=prev_sha),
        "target_path": rel,
        "prev_sha256": prev_sha,
        "target_sha256": target_sha,
        "target_content": (text or "")[:32000],
        "diff_summary": diff_sum or ("(new or binary file %s)" % rel),
    }


def build_requests(changed_paths, root=None, repo_name=None, anchors=None):
    """Build Approver Protocol v2 `POST /requests` payloads for controlled paths."""
    base = root or gate.GATE_REPO
    rname = repo_name or repo_id(base)
    ldir_prefix = local_dir_name(base) + "/"
    agent = os.environ.get("USER", "agent")
    overrides = _anchored_overrides(base, anchors)
    out = []
    for raw in sorted(set(changed_paths or ())):
        rel = str(raw).replace("\\", "/").lstrip("./")
        sym = _symbolic_request(rel, rname, agent)
        if sym is not None:
            out.append(sym)
            continue
        if not (rel.startswith(("zreflect/", ldir_prefix, "questions/")) or rel in trust_core.CONTROLLED_FILES):
            continue
        prev_ov, target_ov = overrides.get(rel, (None, None))
        out.append(_file_request(base, rel, rname, agent, prev_override=prev_ov, target_override=target_ov))
    return out


def _approver_json(url, path, payload=None, *, timeout=3.0):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"} if payload is not None else {}
    req = urllib.request.Request(url + path, data=data, headers=headers, method="POST" if payload is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = json.loads(r.read().decode("utf-8"))
        return (body if isinstance(body, dict) else {}), None
    except urllib.error.HTTPError as exc:
        return None, f"HTTP {exc.code}: {_http_err_detail(exc)}"
    except (OSError, ValueError) as exc:
        return None, str(exc)


def _post_auto_sync(url, payload, out_path):
    resp, err = _approver_json(url, "/requests", payload, timeout=1.5)
    if err or resp is None:
        print("  · %s (%s)" % (err, payload["target_path"]), file=sys.stderr)
        return False
    if resp.get("receipt"):
        _save_receipts_to_bundle([resp["receipt"]], out_path)
        return True
    if resp.get("status") == "pending":
        print(M("approval.request_submitted",
                id=resp.get("display_id") or resp.get("id", ""),
                status="pending", action=payload["action"],
                target=payload["target_path"], url=url))
    elif resp.get("status") in ("denied", "rejected_duplicate"):
        label = resp.get("display_id") or resp.get("id", "")
        reason = resp.get("deny_reason") or resp.get("status")
        print("  · %s" % M("approval.request_denied", id=label, target=payload["target_path"], reason=reason),
              file=sys.stderr)
    return False


def _http_err_detail(exc):
    try:
        raw = exc.read().decode("utf-8", errors="replace")
        obj = json.loads(raw) if raw else {}
        return obj.get("detail") or obj.get("error") or raw or exc.reason
    except (OSError, ValueError):
        return str(exc.reason or exc)


def _auto_sync_for_probs(base, anchors, probs):
    if not _has_git(base):
        return False
    if not (anchors.get("approver_pub") or "").strip():
        return False
    sync_codes = ("approval.receipt_required", "approval.scope_mismatch",
                  "approval.expired", "approval.hash_mismatch")
    targets = [p.params["target"] for p in probs
               if getattr(p, "code", "") in sync_codes and p.params.get("target")]
    if not targets:
        return False
    head_anc, _ = _baseline_anchors(base)
    reqs = build_requests(targets, root=base, repo_name=anchors.get("repo") or repo_id(base),
                          anchors=head_anc or anchors)
    url = (os.environ.get(APPROVER_URL_ENV) or DEFAULT_APPROVER_URL).rstrip("/")
    out_path = os.environ.get(RECEIPT_ENV) or _default_receipt_path(base)
    synced = False
    for payload in reqs:
        synced = _post_auto_sync(url, payload, out_path) or synced
    return synced


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


def _load_verified_seal(base, zd=None):
    zdir = zd or os.path.join(base, "zreflect")
    sp = seal_path(zdir)
    data, err = load_seal(sp)
    if err or not data:
        return zdir, None, [err or M("seal.broken", path=sp)]
    actual = {rel: _sha256_norm_file(os.path.join(base, rel)) for rel in _collect_suite_relpaths(base, zdir)}
    disk_probs = trust_core.eval_seal_files(data.get("files"), actual, data.get("tree_sha256"))
    return zdir, data, disk_probs


def _verify_suite_receipt(rt, anchors, anc_tree, tree_sha, receipt, *, auto_sync=False):
    rec = receipt if receipt is not None else load_receipt(root=rt)
    kw = {"repo_name": anchors.get("repo") or repo_id(rt), "action": _SEAL_CORE,
          "target": _SEAL_REL, "prev_sha256": anc_tree, "target_sha256": tree_sha,
          "pub_b64": anchors.get("approver_pub"), "revoked_ids": anchors.get("revoked_ids") or [],
          "verify_sig_fn": ed25519_verify}
    probs = trust_core.verify_receipt(rec, **kw)
    if auto_sync and receipt is None and probs and _auto_sync_for_probs(rt, anchors, probs):
        probs = trust_core.verify_receipt(load_receipt(root=rt), **kw)
    return probs


def _head_seal_file_sha(rt):
    if not _has_git(rt):
        return None
    r = _git_run(rt, "show", "HEAD:zreflect/SEAL.json", text=False)
    return _sha256_bytes_norm(r.stdout) if (r is not None and r.returncode == 0) else None


def _require_anchors_or_head(base):
    anchors = load_anchors(base)
    if anchors is None:
        head, err = _baseline_anchors(base)
        if err or head is not None:
            return None, [M("approval.anchors_broken")]
        return None, []
    if not anchors:
        return None, [M("approval.anchors_broken")]
    return anchors, []


def _try_suite_sig_lock(zd, data, anchors, seal_seq, anc_seq):
    sig = load_suite_sig(zd)
    if sig is None:
        return False, []
    sig_probs = trust_core.verify_suite_sig(
        data, sig, pub_b64=anchors.get("approver_pub"),
        revoked_ids=anchors.get("revoked_ids") or (), verify_sig_fn=ed25519_verify)
    if not sig_probs:
        return True, []
    if seal_seq > anc_seq:
        return True, sig_probs
    return False, []


def _verify_anchor_lock(rt, zd, data, anchors, receipt, *, auto_sync=False):
    anc_seq = trust_core.safe_int(anchors.get("suite_seq"), 0)
    seal_seq = trust_core.safe_int(data.get("suite_seq"), 0)
    if anc_seq is None or seal_seq is None:
        return [M("approval.anchors_broken")]
    if seal_seq < anc_seq:
        return [M("trust.suite_downgrade", old_seq=anc_seq, new_seq=seal_seq)]
    handled, sig_probs = _try_suite_sig_lock(zd, data, anchors, seal_seq, anc_seq)
    if handled:
        return sig_probs
    cur_file_sha = _sha256_norm_file(seal_path(zd)) or "DELETED"
    head_file_sha = _head_seal_file_sha(rt)
    if head_file_sha and cur_file_sha != head_file_sha:
        return _verify_suite_receipt(rt, anchors, head_file_sha, cur_file_sha, receipt, auto_sync=auto_sync)
    tree_sha = data.get("tree_sha256") or trust_core.compute_tree_sha(data.get("files") or {})
    anc_tree = anchors.get("suite_tree_sha256")
    if anc_tree and tree_sha != anc_tree:
        return _verify_suite_receipt(rt, anchors, anc_tree, tree_sha, receipt, auto_sync=auto_sync)
    return []


def verify_problems(root=None, zdir=None, receipt=None, *, auto_sync=False):
    """Verify `zreflect/SEAL.json`, suite signature / anti-downgrade, and `lock_core` receipt if changed."""
    zd, rt = zdir or gate.zdir(), root or gate.tool_repo()
    zd, data, probs = _load_verified_seal(rt, zd)
    if probs or not data:
        return probs
    anchors, anc_err = _require_anchors_or_head(rt)
    if anc_err:
        return anc_err
    if not anchors or not anchors.get("lock_core"):
        return []
    return _verify_anchor_lock(rt, zd, data, anchors, receipt, auto_sync=auto_sync)


def _updated_seal_files(rt, rels, old_files, norm_targets, force_all):
    new_files = {}
    for rel in rels:
        if force_all or rel in norm_targets or rel not in old_files:
            new_files[rel] = {"file_sha256": _sha256_norm_file(os.path.join(rt, rel))}
        else:
            new_files[rel] = old_files[rel]
    return new_files


def reseal(targets, force_all=False, root=None, zdir=None, bump_seq=False):
    """Update `zreflect/SEAL.json` for `targets` (or all suite files when `force_all=True`)."""
    zd = zdir or gate.zdir()
    rt = root or gate.tool_repo()
    old_data, _ = load_seal(seal_path(zd))
    old_files = dict((old_data or {}).get("files") or {})
    rels = _collect_suite_relpaths(rt, zd)
    norm_targets = set() if force_all else {t.replace("\\", "/").lstrip("./") for t in (targets or ())}
    for t in norm_targets:
        if t not in rels:
            return None, M("seal.unlisted_file", file=t)
    new_files = _updated_seal_files(rt, rels, old_files, norm_targets, force_all)
    tree = trust_core.compute_tree_sha(new_files)
    old_seq = int((old_data or {}).get("suite_seq") or 1)
    out = {
        "schema": trust_core.SEAL_SCHEMA,
        "upstream_repo": (old_data or {}).get("upstream_repo") or trust_core.TRUSTED_UPSTREAM_REPO,
        "suite_seq": old_seq + (1 if bump_seq else 0),
        "tree_sha256": tree,
        "files": new_files,
    }
    _write_json_atomic(seal_path(zd), out, indent=1)
    return tree, None


def _doc_path_for(base):
    p = os.path.join(base, "zreflect", _DOC_NAME)
    return p if os.path.isfile(p) else os.path.join(gate.zdir(), _DOC_NAME)


def _load_target_doc(base):
    doc_p = _doc_path_for(base)
    spec = importlib.util.spec_from_file_location("_einfacht_target_doc", doc_p)
    if spec is None or spec.loader is None:
        import doc  # noqa: PLC0415
        return doc
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _verified_suite_principles_md(base, anchors):
    """Return rendered `PRINCIPLES.md` sha256 iff valid `SUITE.sig` backs `SEAL.json` + `doc.py`."""
    zd = os.path.join(base, "zreflect")
    if not os.path.isdir(zd):
        zd = gate.zdir()
    data, err = load_seal(seal_path(zd))
    sig = load_suite_sig(zd)
    if err or not data or not sig:
        return None
    pub = (anchors or {}).get("approver_pub")
    revoked = (anchors or {}).get("revoked_ids") or ()
    if trust_core.verify_suite_sig(data, sig, pub_b64=pub, revoked_ids=revoked, verify_sig_fn=ed25519_verify):
        return None
    doc_sha = _sha256_norm_file(os.path.join(zd, _DOC_NAME))
    files_map = data.get("files") or {}
    sealed_doc = (files_map.get(_DOC_REL) or {}).get("file_sha256")
    if (not doc_sha or doc_sha != sealed_doc
            or trust_core.compute_tree_sha(files_map) != data.get("tree_sha256")):
        return None
    md_p = os.path.join(base, _PRINCIPLES_MD)
    if not os.path.isfile(md_p):
        return None
    return _sha256_norm_file(md_p) if _principles_md_clean(base, md_p) else None


def _strip_block(txt, begin, end):
    head, sep, rest = txt.partition(begin)
    if not sep:
        return txt
    _mid, sep2, tail = rest.partition(end)
    return head + tail if sep2 else txt


def _principles_md_clean(base, md_p):
    doc_mod = _load_target_doc(base)
    try:
        with open(md_p, encoding="utf-8") as fh:
            cur_txt = fh.read()
    except OSError:
        return False
    if doc_mod.RULES_BEGIN not in cur_txt or doc_mod.RULES_END not in cur_txt:
        return False
    actual = cur_txt.partition(doc_mod.RULES_BEGIN)[2].partition(doc_mod.RULES_END)[0].strip()
    want = doc_mod.render_rules(doc_mod.all_rules(base)).partition(doc_mod.RULES_BEGIN)[2].partition(doc_mod.RULES_END)[0].strip()
    if actual != want:
        return False
    if not _has_git(base):
        return True
    r = _git_run(base, "show", "HEAD:PRINCIPLES.md")
    if r is None:
        return False
    if r.returncode != 0:
        return True
    return _strip_block(cur_txt, doc_mod.RULES_BEGIN, doc_mod.RULES_END) == _strip_block(
        r.stdout, doc_mod.RULES_BEGIN, doc_mod.RULES_END)


def _check_integrity(anchors, root, rec):
    head, err = _baseline_anchors(root)
    if err:
        return [M("approval.anchors_broken")]
    s_md = _verified_suite_principles_md(root, anchors)
    return trust_core.eval_anchors_integrity(
        head, anchors, receipt=rec,
        repo_name=anchors.get("repo") or repo_id(root), verify_sig_fn=ed25519_verify,
        suite_principles_md_sha=s_md)


def _run_anchor_gate(root, receipt, auto_sync, eval_fn):
    base = root or gate.GATE_REPO
    anchors, anc_err = _require_anchors_or_head(base)
    if anc_err or anchors is None:
        return anc_err
    ctx = (
        anchors.get("repo") or repo_id(base),
        anchors.get("approver_pub"),
        anchors.get("revoked_ids") or [],
    )
    rec = receipt if receipt is not None else load_receipt(root=base)
    int_probs = _check_integrity(anchors, base, rec)
    if any(getattr(p, "code", "") in ("approval.anchors_broken", "trust.suite_downgrade") for p in int_probs):
        return int_probs
    out = int_probs + eval_fn(base, anchors, rec, ctx)
    if auto_sync and receipt is None and out and _auto_sync_for_probs(base, anchors, out):
        rec2 = load_receipt(root=base)
        out = _check_integrity(anchors, base, rec2) + eval_fn(base, anchors, rec2, ctx)
    return out


def check_knobs_anchor(root=None, receipt=None, now=None, *, auto_sync=False):
    """Verify `knobs.json` and `reflect-local/*.py` (including `hook.py`) against `ANCHORS.json`."""
    def _eval(base, anchors, rec, ctx):
        rname, pub, revoked = ctx
        out = []
        expected_local = anchors.get("local_scripts") if "local_scripts" in anchors else anchors.get("custom_scripts")
        if expected_local is not None:
            out += trust_core.eval_local_scripts(
                expected_local, local_scripts_map(base), lock_core=bool(anchors.get("lock_core", False)),
                receipt=rec, repo_name=rname, pub_b64=pub, revoked_ids=revoked, now=now,
                verify_sig_fn=ed25519_verify)
        if "knobs_sha256" in anchors or os.path.isfile(os.path.join(base, _KNOBS_JSON)):
            cur_sha = _sha256_norm_file(os.path.join(base, _KNOBS_JSON)) or "NONE"
            prev_sha = anchors.get("knobs_sha256", "NONE")
            if cur_sha != prev_sha:
                out += trust_core.verify_receipt(
                    rec, repo_name=rname, action=_GATE_OFF, target=_KNOBS_JSON,
                    prev_sha256=prev_sha, target_sha256=cur_sha, pub_b64=pub,
                    revoked_ids=revoked, now=now, verify_sig_fn=ed25519_verify)
        return out

    return _run_anchor_gate(root, receipt, auto_sync, _eval)


def _principles_diff_probs(rname, md_sha, pr, rec, pub, revoked, suite_sync):
    if suite_sync or md_sha == pr.get("principles_md_sha256"):
        return []
    return trust_core.verify_receipt(
        rec, repo_name=rname, action="principles.edit", target=_PRINCIPLES_MD,
        prev_sha256=pr.get("principles_md_sha256", ""), target_sha256=md_sha or "DELETED",
        pub_b64=pub, revoked_ids=revoked, verify_sig_fn=ed25519_verify)


def check_principles_repo(root=None, receipt=None, *, auto_sync=False):
    """Verify `PRINCIPLES.md` and `REFLECT_NO_PRINCIPLES` against `ANCHORS.json` (`doc.py` covered by `SEAL.json`)."""
    def _eval(base, anchors, rec, ctx):
        rname, pub, revoked = ctx
        md_sha = _sha256_norm_file(os.path.join(base, _PRINCIPLES_MD))
        no_pr = knobs.flag("REFLECT_NO_PRINCIPLES") is True
        s_md = _verified_suite_principles_md(base, anchors)
        pr = anchors.get("principles") or {}
        suite_sync = bool((s_md is not None and md_sha == s_md) or (no_pr and not md_sha and pr.get("no_principles")))
        probs = []
        if no_pr and not pr.get("no_principles", False):
            probs += trust_core.verify_receipt(
                rec, repo_name=rname, action="principles.disable", target="REFLECT_NO_PRINCIPLES",
                prev_sha256="false", target_sha256="true", pub_b64=pub, revoked_ids=revoked,
                verify_sig_fn=ed25519_verify)
        return probs + _principles_diff_probs(rname, md_sha, pr, rec, pub, revoked, suite_sync)

    return _run_anchor_gate(root, receipt, auto_sync, _eval)


def check_off_gates_anchor(off_list, root=None, receipt=None, now=None, *, auto_sync=False):
    """Verify newly disabled gates against `ANCHORS.json`."""
    def _eval(_base, anchors, rec, ctx):
        rname, pub, revoked = ctx
        allowed = set(anchors.get("off_gates") or ())
        res = []
        for name in sorted(os.path.basename(f) for f in off_list if os.path.basename(f) not in allowed):
            res += trust_core.verify_receipt(
                rec, repo_name=rname, action=_GATE_OFF, target=name,
                prev_sha256="on", target_sha256="off", pub_b64=pub, revoked_ids=revoked,
                now=now, verify_sig_fn=ed25519_verify)
        return res

    return _run_anchor_gate(root, receipt, auto_sync, _eval)


def _question_snapshot(text):
    import check_questions  # noqa: PLC0415
    return trust_core.question_snapshot(
        text, check_questions.field(text, "Status"), check_questions.field(text, "Settling"))


def _eval_one_question(rel, cur, prev, r, *, rname, pub, revoked):
    snapshot = _question_snapshot(cur) if cur is not None else None
    return trust_core.eval_question_entry(
        rel, prev, snapshot, receipt=r, repo_name=rname, pub=pub, revoked=revoked,
        verify_sig_fn=ed25519_verify)


def check_questions_against_anchor(files, root=None, receipt=None, qdir=None, *, auto_sync=False):
    """Verify `questions/*.md` changes against `ANCHORS.json`."""
    def _eval(base, anchors, rec, ctx):
        rname, pub, revoked = ctx
        cfg = knobs.repo_config(base) if base else {}
        cfg_qdir = str(cfg.get("REFLECT_QUESTIONS") or knobs.REGISTRY["REFLECT_QUESTIONS"][1]).strip().rstrip("/") or "questions"
        anc_qdir = (anchors.get("questions_dir") or cfg_qdir).rstrip("/")
        q_map = anchors.get("questions") or {}
        if qdir and qdir.rstrip("/") not in (cfg_qdir, anc_qdir) and any(
            k.startswith((anc_qdir + "/", cfg_qdir + "/")) for k in q_map
        ):
            return [M("approval.anchors_broken")]
        if qdir:
            q_map = {k: v for k, v in q_map.items() if k.startswith(qdir.rstrip("/") + "/")}
        probs = []
        for rel in sorted(set(q_map) | set(files)):
            probs += _eval_one_question(rel, files.get(rel), q_map.get(rel), rec,
                                        rname=rname, pub=pub, revoked=revoked)
        return probs

    return _run_anchor_gate(root, receipt, auto_sync, _eval)


# ---------------------------------------------------------------------------
# Init, Sync, Migrate, Upgrade
# ---------------------------------------------------------------------------

def _build_anchors(root, pub_b64=None):
    import check_questions  # noqa: PLC0415
    files = check_questions.collect(root=root)
    q_map = {k: _question_snapshot(v) for k, v in sorted(files.items())}
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
        "knobs_sha256": _sha256_norm_file(os.path.join(root, _KNOBS_JSON)) or "NONE",
        "questions_dir": str((knobs.repo_config(root) or {}).get("REFLECT_QUESTIONS") or "questions").strip().rstrip("/") or "questions",
        "local_scripts": local_scripts_map(root),
        "off_gates": off_list,
        "principles": {
            "principles_md_sha256": _sha256_norm_file(os.path.join(root, _PRINCIPLES_MD)),
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


def _check_upgrade_lock(dst_anc, seal_d, src_z):
    old_seq = trust_core.safe_int(dst_anc.get("suite_seq"), 0)
    new_seq = trust_core.safe_int(seal_d.get("suite_seq"), 0)
    if old_seq is None or new_seq is None:
        return M("approval.anchors_broken")
    if new_seq < old_seq:
        return M("trust.suite_downgrade", old_seq=old_seq, new_seq=new_seq)
    has_tree = bool(dst_anc.get("suite_tree_sha256") or (trust_core.safe_int(dst_anc.get("schema"), 1) or 1) >= 2)
    tree_changed = has_tree and seal_d.get("tree_sha256") != dst_anc.get("suite_tree_sha256")
    if dst_anc.get("lock_core") and (new_seq > old_seq or tree_changed):
        sig = load_suite_sig(src_z)
        if sig is None:
            return M("approval.receipt_required", action="suite.release", target="zreflect/SEAL.json")
        sig_probs = trust_core.verify_suite_sig(
            seal_d, sig, pub_b64=dst_anc.get("approver_pub"),
            revoked_ids=dst_anc.get("revoked_ids") or (), verify_sig_fn=ed25519_verify)
        if sig_probs:
            return sig_probs[0]
    return None


def _validate_upgrade_source(src, dst_anc):
    src_z = os.path.join(src, "zreflect")
    seal_d, err = load_seal(seal_path(src_z))
    if err or not seal_d:
        return None, err or M("seal.broken", path=seal_path(src_z))
    probs = verify_problems(root=src, zdir=src_z)
    if probs:
        return None, probs[0]
    if dst_anc:
        lock_err = _check_upgrade_lock(dst_anc, seal_d, src_z)
        if lock_err:
            return None, lock_err
    return seal_d, None


def _clean_legacy_pre_push(dst):
    """Remove stale Einfacht `pre-push` hook wrappers (restoring `.einfacht-prev`) if old hook.py left them."""
    if not _has_git(dst):
        return
    r = _git_run(dst, "rev-parse", "--git-path", "hooks")
    raw = r.stdout.strip() if (r and r.returncode == 0 and r.stdout.strip()) else ""
    hooks = (raw if os.path.isabs(raw) else os.path.join(dst, raw)) if raw else os.path.join(dst, ".git", "hooks")
    target = os.path.join(hooks, "pre-push")
    if not os.path.isfile(target):
        return
    try:
        with open(target, encoding="utf-8", errors="replace") as fh:
            body = fh.read()
    except OSError:
        return
    if any(tok in body for tok in ("hook.py", "gate.py", "einfacht-gate.sh")):
        os.unlink(target)
        prev = target + ".einfacht-prev"
        if os.path.isfile(prev):
            os.replace(prev, target)


def _ensure_upgrade_principles_md(dst, migrated):
    md_p = os.path.join(dst, _PRINCIPLES_MD)
    pr = (migrated or {}).get("principles") or {}
    if os.path.isfile(md_p) or pr.get("no_principles") or knobs.flag("REFLECT_NO_PRINCIPLES", root=dst) is True:
        return
    doc_name = knobs.get("REFLECT_DOC", root=dst) or "STATE.md"
    if not os.path.isfile(os.path.join(dst, doc_name)):
        return
    doc_mod = _load_target_doc(dst)
    with open(md_p, "w", encoding="utf-8") as fh:
        fh.write("# PRINCIPLES.md\n\n" + doc_mod.render_rules(doc_mod.all_rules(dst)) + "\n")


def _post_upgrade_refresh(dst, migrated=None):
    _ensure_upgrade_principles_md(dst, migrated)
    sub_env = dict(os.environ, GATE_REPO=dst)
    cmds = [[sys.executable, _FACTS_REL, "--accept-changes", "--allow-drop"]]
    doc_name = knobs.get("REFLECT_DOC", root=dst) or "STATE.md"
    if os.path.isfile(os.path.join(dst, doc_name)):
        cmds.append([sys.executable, _FACTS_REL, "--render-doc"])
    for sub_cmd in cmds:
        r = subprocess.run(sub_cmd, cwd=dst, env=sub_env, capture_output=True, text=True, check=False,
                           encoding="utf-8", errors="replace")
        if r.returncode != 0:
            sys.stderr.write(r.stderr or r.stdout)
            return r.returncode
    hook_py = os.path.join(dst, local_dir_name(dst), "hook.py")
    if os.path.isfile(hook_py):
        subprocess.run([sys.executable, hook_py, "--chain"], cwd=dst, env=sub_env, capture_output=True, text=True,
                       check=False, encoding="utf-8", errors="replace")
    _clean_legacy_pre_push(dst)
    return 0


def _prepare_upgrade(src, dst):
    dst_anc, anc_err = _require_anchors_or_head(dst)
    if anc_err:
        return None, None, anc_err[0]
    seal_d, err = _validate_upgrade_source(src, dst_anc)
    if err or not seal_d:
        return None, None, err
    if not dst_anc:
        return seal_d, None, None
    migrated, mprobs = trust_core.migrate_anchors(
        dst_anc, local_scripts=local_scripts_map(dst),
        suite_seq=seal_d.get("suite_seq"), suite_tree_sha=seal_d.get("tree_sha256"))
    if mprobs or not migrated:
        return None, None, mprobs[0] if mprobs else M("approval.anchors_broken")
    return seal_d, migrated, None


def _refresh_upgraded_principles(dst, migrated):
    if migrated is None:
        return
    pr = trust_core.clean_principles(migrated.get("principles"))
    md_p = os.path.join(dst, _PRINCIPLES_MD)
    no_pr = bool(pr.get("no_principles") or knobs.flag("REFLECT_NO_PRINCIPLES", root=dst) is True) and not os.path.isfile(md_p)
    s_md = _verified_suite_principles_md(dst, migrated)
    if not s_md and not migrated.get("lock_core") and os.path.isfile(md_p) and _principles_md_clean(dst, md_p):
        s_md = _sha256_norm_file(md_p)
    if no_pr:
        pr["no_principles"] = True
        pr["principles_md_sha256"] = ""
    elif s_md:
        pr["principles_md_sha256"] = s_md
    if pr != migrated.get("principles"):
        migrated["principles"] = pr
        write_anchors(dst, migrated)


def cmd_upgrade(argv):
    """Out-of-repo painless suite upgrade: verify source SEAL/SUITE.sig, replace zreflect/ + ruff.toml, preserve reflect-local/."""
    if len(argv) < 2 or not os.path.isdir(os.path.join(argv[1], "zreflect")):
        return fatal(M("trust.unknown_command"))
    src, dst = os.path.abspath(argv[1]), os.path.abspath(gate.GATE_REPO)
    if os.path.realpath(src) == os.path.realpath(dst):
        return fatal(M("trust.unknown_command"))
    seal_d, migrated, err = _prepare_upgrade(src, dst)
    if err or not seal_d:
        return fatal(err)
    dst_z = os.path.join(dst, "zreflect")
    if os.path.isdir(dst_z):
        shutil.rmtree(dst_z)
    shutil.copytree(os.path.join(src, "zreflect"), dst_z, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    if os.path.isfile(os.path.join(src, _RUFF_TOML)):
        shutil.copy2(os.path.join(src, _RUFF_TOML), os.path.join(dst, _RUFF_TOML))
    if migrated is not None:
        write_anchors(dst, migrated)
    rc = _post_upgrade_refresh(dst, migrated)
    if rc != 0:
        return rc
    _refresh_upgraded_principles(dst, migrated)
    print(f"upgrade.ok(from={src!r}, suite_seq={seal_d.get('suite_seq', 1)})")
    return 0


def _sync_settled(root):
    anchors = load_anchors(root)
    if not anchors:
        return 2
    probs = _all_anchor_probs(root, auto_sync=False)
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
        with open(os.path.join(src, "zreflect", _DOC_NAME), "w", encoding="utf-8") as fh:
            fh.write("RULES = ()\n")
        with open(os.path.join(src, _RUFF_TOML), "w", encoding="utf-8") as fh:
            fh.write("line-length = 120\n")
        shutil.copy2(os.path.join(src, "zreflect", _DOC_NAME), os.path.join(dst, "zreflect", _DOC_NAME))
        shutil.copy2(os.path.join(src, _RUFF_TOML), os.path.join(dst, _RUFF_TOML))
        # Build v1 SEAL in src with suite_seq=2 and SUITE.sig
        files_map = {
            _RUFF_TOML: {"file_sha256": _sha256_norm_file(os.path.join(src, _RUFF_TOML))},
            _DOC_REL: {"file_sha256": _sha256_norm_file(os.path.join(src, _DOC_REL))},
        }
        tree = trust_core.compute_tree_sha(files_map)
        with open(os.path.join(src, "zreflect", SEAL_NAME), "w", encoding="utf-8") as fh:
            json.dump({"schema": 2, "upstream_repo": trust_core.TRUSTED_UPSTREAM_REPO, "suite_seq": 2,
                       "tree_sha256": tree, "files": files_map}, fh)
        sig = {
            "payload": {
                "repo": trust_core.TRUSTED_UPSTREAM_REPO, "action": _SUITE_RELEASE,
                "target_path": _SEAL_REL, "suite_seq": 2, "target_sha256": tree,
                "expires_at": _EXP_FUTURE,
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
            "schema": 2, "repo": _TEST_CONSUMER, "approver_pub": pub_b64, "lock_core": True,
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
            "schema": 2, "repo": _TEST_ORG, "approver_pub": pinned_approver_pub(), "lock_core": True,
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
            probs = [M("approval.receipt_required", action=_GATE_OFF, target=_KNOBS_JSON),
                     M("approval.receipt_required", action=_GATE_OFF, target="check_readme_sync.py")]
            if (not _auto_sync_for_probs(rt, {"approver_pub": "x"}, probs)
                    or seen.get("check_readme_sync.py") is not True or len(seen) != 2):
                return False
        finally:
            globals()["_post_auto_sync"] = orig
    ok, err = ed25519_verify(b"msg", "AA==", base64.b64encode(b"0" * 32).decode("ascii"))
    return (not ok) and err in ("signature_invalid", "crypto_unavailable")


def _selftest_no_http_on_verify():
    with tempfile.TemporaryDirectory() as rt:
        os.makedirs(os.path.join(rt, "zreflect"))
        with open(os.path.join(rt, "zreflect", "a.py"), "w", encoding="utf-8") as fh:
            fh.write("x = 1\n")
        reseal(["zreflect/a.py"], force_all=True, root=rt, zdir=os.path.join(rt, "zreflect"))
        write_anchors(rt, {
            "schema": 2, "repo": _TEST_ORG, "approver_pub": pinned_approver_pub(), "lock_core": True,
            "revoked_ids": [], "suite_seq": 1, "suite_tree_sha256": "0" * 64,
            "knobs_sha256": "NONE", "questions_dir": "questions", "local_scripts": {},
            "off_gates": [], "principles": {}, "questions": {},
        })
        posted: list[dict] = []
        orig = globals()["_post_auto_sync"]

        def _record(_u, p, _o):
            posted.append(p)
            return False

        globals()["_post_auto_sync"] = _record
        try:
            probs = verify_problems(root=rt, zdir=os.path.join(rt, "zreflect"), receipt={"receipts": []})
            kprobs = check_knobs_anchor(root=rt, receipt={"receipts": []})
            qprobs = check_questions_against_anchor({"questions/01.md": "x"}, root=rt, receipt={"receipts": []})
            if posted or not probs or kprobs or not qprobs:
                return False
        finally:
            globals()["_post_auto_sync"] = orig
    with tempfile.TemporaryDirectory() as rt2:
        os.makedirs(os.path.join(rt2, ".git"))
        cnt, rname, out_p = pull_receipts(
            root=rt2,
            fetcher=lambda _u, _r: [{"payload": {"repo": "r", "action": _GATE_OFF, "target_path": "x"}, "sig": "s"}],
        )
        if cnt != 1 or not rname or not os.path.isfile(out_p):
            return False
    return True


def _selftest_worktree_and_baseline():
    genv = _clean_git_env()
    with tempfile.TemporaryDirectory() as rt:
        subprocess.run(["git", "init", "-q", rt], check=True, env=genv)
        subprocess.run(["git", "-C", rt, "config", "user.email", "t@e.com"], check=True, env=genv)
        subprocess.run(["git", "-C", rt, "config", "user.name", "t"], check=True, env=genv)
        with open(os.path.join(rt, _KNOBS_JSON), "w", encoding="utf-8") as fh:
            fh.write('{"REFLECT_OFF_GATES": "check_ab.py"}\n')
        subprocess.run(["git", "-C", rt, "add", _KNOBS_JSON], check=True, env=genv)
        subprocess.run(["git", "-C", rt, "commit", "-qm", "init"], check=True, env=genv)
        wt = os.path.join(rt, ".wt-tmp")
        subprocess.run(["git", "-C", rt, "worktree", "add", "--detach", "-q", wt, "HEAD"], check=True, env=genv)
        try:
            if os.path.realpath(_default_receipt_path(wt)) != os.path.realpath(_default_receipt_path(rt)):
                return False
        finally:
            subprocess.run(["git", "-C", rt, "worktree", "remove", "--force", wt], check=False, env=genv)
        anc = {
            "schema": 2, "repo": _TEST_ORG, "approver_pub": pinned_approver_pub(), "lock_core": True,
            "revoked_ids": [], "suite_seq": 1, "suite_tree_sha256": "0" * 64,
            "knobs_sha256": "anchored_prev_sha", "questions_dir": "questions", "local_scripts": {},
            "off_gates": [], "principles": {}, "questions": {},
        }
        reqs = build_requests([_KNOBS_JSON], root=rt, repo_name=_TEST_ORG, anchors=anc)
        return len(reqs) == 1 and reqs[0]["prev_sha256"] == "anchored_prev_sha"


def _selftest_suite_sig_doc_upgrade():
    try:
        from cryptography.hazmat.primitives import serialization  # noqa: PLC0415
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: PLC0415
    except ImportError:
        return True
    priv = Ed25519PrivateKey.generate()
    pub_pem = priv.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("ascii")
    with tempfile.TemporaryDirectory() as rt:
        zd = os.path.join(rt, "zreflect")
        os.makedirs(zd)
        shutil.copy2(os.path.join(gate.zdir(), _DOC_NAME), os.path.join(zd, _DOC_NAME))
        tree, err = reseal([_DOC_REL], force_all=True, root=rt, zdir=zd, bump_seq=True)
        if err or not tree:
            return False
        # SUITE.sig with no expires_at and even past expires_at stays valid forever (non-expiring)
        for extra in ({}, {"expires_at": "2000-01-01T00:00:00+00:00"}):
            payload = {
                "id": "rec-suite-perm", "repo": trust_core.TRUSTED_UPSTREAM_REPO, "action": _SUITE_RELEASE,
                "target_path": _SEAL_REL, "suite_seq": 2, "target_sha256": tree, **extra,
            }
            sig_b64 = base64.b64encode(priv.sign(trust_core.canonical_json(payload))).decode("ascii")
            _write_json_atomic(os.path.join(zd, SUITE_SIG_NAME), {"payload": payload, "sig": sig_b64})
            import doc  # noqa: PLC0415
            md_p = os.path.join(rt, _PRINCIPLES_MD)
            with open(md_p, "w", encoding="utf-8") as fh:
                fh.write("# Principles\n\n" + doc.render_rules(doc.all_rules(rt)) + "\n")
            write_anchors(rt, {
                "schema": 2, "repo": _TEST_CONSUMER, "approver_pub": pub_pem, "lock_core": True,
                "revoked_ids": [], "suite_seq": 2, "suite_tree_sha256": tree,
                "knobs_sha256": "NONE", "questions_dir": "questions", "local_scripts": {},
                "off_gates": [],
                "principles": {"doc_py_sha256": "old_doc", "principles_md_sha256": "old_md", "no_principles": False},
                "questions": {},
            })
            if check_principles_repo(root=rt, receipt={"receipts": []}) != []:
                return False
        return True


def _selftest_happy_upgrade():
    try:
        from cryptography.hazmat.primitives import serialization  # noqa: PLC0415
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: PLC0415
    except ImportError:
        return True
    priv = Ed25519PrivateKey.generate()
    pub_pem = priv.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("ascii")
    genv = _clean_git_env()
    with tempfile.TemporaryDirectory() as rt:
        src, dst = os.path.join(rt, "src"), os.path.join(rt, "dst")
        shutil.copytree(os.path.join(gate.tool_repo(), "zreflect"), os.path.join(src, "zreflect"),
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", SUITE_SIG_NAME))
        shutil.copy2(os.path.join(gate.tool_repo(), _RUFF_TOML), os.path.join(src, _RUFF_TOML))
        tree, err = reseal([_DOC_REL], force_all=True, root=src, zdir=os.path.join(src, "zreflect"), bump_seq=True)
        if err or not tree:
            return False
        sdata, _ = load_seal(seal_path(os.path.join(src, "zreflect")))
        payload = {"id": "rec-upg-1", "repo": trust_core.TRUSTED_UPSTREAM_REPO, "action": _SUITE_RELEASE,
                   "target_path": _SEAL_REL, "suite_seq": int(sdata["suite_seq"]), "target_sha256": tree,
                   "expires_at": 4102444800}
        sig_b64 = base64.b64encode(priv.sign(trust_core.canonical_json(payload))).decode("ascii")
        _write_json_atomic(os.path.join(src, "zreflect", SUITE_SIG_NAME), {"payload": payload, "sig": sig_b64})
        os.makedirs(os.path.join(dst, "zreflect"))
        subprocess.run(["git", "init", "-q", dst], check=True, env=genv)
        stale_pp = os.path.join(dst, ".git", "hooks", "pre-push")
        with open(stale_pp, "w", encoding="utf-8") as fh:
            fh.write("#!/bin/sh\nexec python3 reflect-local/hook.py pre-push\n")
        subprocess.run([sys.executable, _FACTS_REL, "--init"], cwd=src,
                       env=dict(os.environ, GATE_REPO=src), capture_output=True, check=False)
        for fn in ("STATE.md", _PRINCIPLES_MD, "AGENTS.md", "README.md", "retractions.json", _KNOBS_JSON):
            if os.path.isfile(os.path.join(src, fn)):
                shutil.copy2(os.path.join(src, fn), os.path.join(dst, fn))
        # Seed legacy FACTS.json with a dropped obsolete key to verify --allow-drop upgrade migration
        _write_json_atomic(os.path.join(dst, "FACTS.json"), {"schema": 1, "facts": {"obsolete_key": {"value": 1}}})
        write_anchors(dst, {
            "schema": 1, "repo": _TEST_CONSUMER, "approver_pub": pub_pem, "lock_core": True,
            "revoked_ids": [], "suite_seq": 1, "suite_tree_sha256": "0" * 64,
            "knobs_sha256": "NONE", "questions_dir": "questions", "custom_scripts": {},
            "off_gates": [], "principles": {"doc_py_sha256": "old", "principles_md_sha256": "old", "no_principles": False},
            "questions": {},
        })
        old_repo = gate.GATE_REPO
        try:
            gate.GATE_REPO = dst
            if cmd_upgrade(["--upgrade", src]) != 0 or cmd_upgrade(["--upgrade", dst]) == 0:
                return False
        finally:
            gate.GATE_REPO = old_repo
        upg_anc = load_anchors(dst)
        facts_d = _load_json_dict(os.path.join(dst, "FACTS.json")) or {}
        return bool(upg_anc and upg_anc["schema"] == 2 and "doc_py_sha256" not in upg_anc["principles"]
                    and upg_anc["principles"]["principles_md_sha256"] != "old"
                    and "obsolete_key" not in (facts_d.get("facts") or {})
                    and not os.path.exists(stale_pp)
                    and not check_principles_repo(root=dst, receipt={"receipts": []}))


def _selftest_cli_flows():
    genv = _clean_git_env()
    with tempfile.TemporaryDirectory() as rt:
        sub = os.path.join(rt, "subrepo")
        nested = os.path.join(sub, "pkg", "inner")
        os.makedirs(nested)
        subprocess.run(["git", "init", "-q", sub], check=True, env=genv)
        if os.path.realpath(_default_receipt_path(nested)) != os.path.realpath(os.path.join(sub, ".git", _RECEIPT_FILE)):
            return False
        if [r["action"] for r in build_requests(["doctor.py"], root=sub, repo_name="r/x")] != [_GATE_OFF]:
            return False
        out_b = os.path.join(sub, ".git", _RECEIPT_FILE)
        r_new = {"payload": {"repo": "r/x", "action": _SEAL_CORE, "target_path": "x", "prev_sha256": "p1", "target_sha256": "t2", "id": "rec-new"}, "sig": "s2"}
        r_old = {"payload": {"repo": "r/x", "action": _SEAL_CORE, "target_path": "x", "prev_sha256": "p0", "target_sha256": "t1", "id": "rec-old"}, "sig": "s1"}
        pull_receipts(root=sub, fetcher=lambda _u, _r: [r_new, r_old])
        loaded = load_receipt(path=out_b)
        if not (isinstance(loaded, dict) and len(loaded.get("receipts") or []) == 2):
            return False
        # git rm ANCHORS.json must still trip anchors_broken; corrupt {} ANCHORS.json must block upgrade
        subprocess.run(["git", "-C", sub, "config", "user.email", "t@e.com"], check=True, env=genv)
        subprocess.run(["git", "-C", sub, "config", "user.name", "t"], check=True, env=genv)
        write_anchors(sub, {"schema": 2, "repo": "r/x", "lock_core": True, "suite_seq": 1})
        subprocess.run(["git", "-C", sub, "add", ANCHORS_FILE], check=True, env=genv)
        subprocess.run(["git", "-C", sub, "commit", "-qm", "anc"], check=True, env=genv)
        subprocess.run(["git", "-C", sub, "rm", "-q", ANCHORS_FILE], check=True, env=genv)
        if ([p.code for p in check_knobs_anchor(root=sub, receipt={"receipts": []})] != ["approval.anchors_broken"]
                or not _require_anchors_or_head(sub)[1]):
            return False
        with open(os.path.join(sub, ANCHORS_FILE), "w", encoding="utf-8") as fh:
            fh.write("{")
        return bool(_require_anchors_or_head(sub)[1])


def _selftest_security_edges():
    with tempfile.TemporaryDirectory() as rt:
        list_b = os.path.join(rt, "list.json")
        payload = {"id": "rec-sec", "repo": "r/x", "action": _SEAL_CORE, "target_path": "a", "prev_sha256": "p0", "target_sha256": "t1"}
        r1 = {"payload": payload, "sig": "s1"}
        r2 = {"payload": {**payload, "target_path": "b", "prev_sha256": "p1", "target_sha256": "t2"}, "sig": "s2"}
        _write_json_atomic(list_b, [r1])
        _save_receipts_to_bundle([r2], list_b)
        if len((load_receipt(path=list_b) or {}).get("receipts") or ()) != 2:
            return False
        bad_b = os.path.join(rt, "bad.json")
        with open(bad_b, "w", encoding="utf-8") as fh:
            fh.write("{")
        try:
            _save_receipts_to_bundle([r2], bad_b)
            return False
        except ValueError:
            pass
    q_txt = "# Q\n**Status:** resolved\n**Settling:** python3 -c pass\n"
    spoof_snap = {"sha256": trust_core.sha256_text(q_txt), "status": "resolved", "settling": "python3 strict", "body_sha256": "other"}
    probs = _eval_one_question("questions/01.md", q_txt, spoof_snap, {"receipts": []}, rname="r/x", pub="PUB", revoked=())
    return [p.code for p in probs] == ["approval.anchors_broken"]


def _selftest_question_evaluation_shared():
    from unittest.mock import patch  # noqa: PLC0415
    rel = "questions/01.md"
    original = "# Q\n**Status:** ready-for-agent\n**Settling:** python3 -c pass\n"
    prior = trust_core.question_snapshot(original, "ready-for-agent", "python3 -c pass")
    with patch.object(trust_core, "eval_question_entry", wraps=trust_core.eval_question_entry) as evaluate:
        for previous, current, action in (
            (None, original, "question.create"),
            (prior, None, "question.delete"),
            (prior, original, None),
            (prior, original.replace("ready-for-agent", "ready-for-human"), None),
            (prior, original.replace("ready-for-agent", "resolved"), None),
            (prior, original.replace("# Q", "# New"), "question.modify"),
        ):
            worktree = _eval_one_question(
                rel, current, previous, None, rname=_TEST_ORG, pub="PUB", revoked=())
            anchors = trust_core._eval_questions_anchor(
                {"questions": {rel: previous} if previous is not None else {}},
                {"questions": {rel: _question_snapshot(current)} if current is not None else {}},
                receipt=None, repo_name=_TEST_ORG, pub="PUB", revoked=(), verify_sig_fn=ed25519_verify)
            expected = [("approval.receipt_required", action)] if action else []
            if any([(p.code, p.params.get("action")) for p in probs] != expected
                   for probs in (worktree, anchors)):
                return False
        return evaluate.call_count == 12


def _cases():
    return [
        ("★ trust.local_scripts_tamper_and_downgrade_rejected", _selftest_local_scripts_and_upgrade),
        ("★ trust.reseal_requires_approval", _selftest_reseal_approval),
        ("★ trust.crlf_and_verify_contract", _selftest_crlf_and_verify),
        ("★ trust.check_paths_have_no_http_side_effect", _selftest_no_http_on_verify),
        ("★ trust.worktree_and_anchor_baseline", _selftest_worktree_and_baseline),
        ("★ trust.suite_sig_authorizes_doc_upgrade", _selftest_suite_sig_doc_upgrade),
        ("★ trust.happy_upgrade_refreshes_principles", _selftest_happy_upgrade),
        ("★ trust.cli_subdir_doctor_and_pull_bundle", _selftest_cli_flows),
        ("★ trust.security_edges_and_bundle_safety", _selftest_security_edges),
        ("trust.question_shared_evaluation", _selftest_question_evaluation_shared),
    ]


def _fail_probs(probs):
    for p in probs:
        print("  · %s" % p, file=sys.stderr)
    return 1


def _cmd_verify_seal(_argv):
    probs = verify_problems()
    if probs:
        return _fail_probs(probs)
    print(current_tree_sha(verified=True) or "")
    return 0


def _all_anchor_probs(root, *, auto_sync):
    import check_questions  # noqa: PLC0415
    off_list = sorted(x.strip() for x in (knobs.get("REFLECT_OFF_GATES") or "").split(",") if x.strip())
    files = check_questions.collect(root=root)
    return (
        verify_problems(root=root, zdir=os.path.join(root, "zreflect"), auto_sync=auto_sync)
        + check_knobs_anchor(root=root, auto_sync=auto_sync)
        + check_off_gates_anchor(off_list, root=root, auto_sync=auto_sync)
        + check_principles_repo(root=root, auto_sync=auto_sync)
        + check_questions_against_anchor(files, root=root, auto_sync=auto_sync)
    )


def _fetch_repo_receipts(url, rname):
    data, err = _approver_json(url, f"/receipts?{urllib.parse.urlencode({'repo': rname})}")
    if err or data is None:
        raise OSError(err or "approver error")
    recs = data.get("receipts")
    return [x for x in (recs or ()) if isinstance(x, dict)]


def pull_receipts(root=None, *, fetcher=None):
    """Read-only GET `/receipts?repo=...` from approver into local bundle (never POSTs)."""
    base = root or gate.GATE_REPO
    anc = load_anchors(base) or {}
    rname = anc.get("repo") or repo_id(base)
    url = (os.environ.get(APPROVER_URL_ENV) or DEFAULT_APPROVER_URL).rstrip("/")
    out_path = os.environ.get(RECEIPT_ENV) or _default_receipt_path(base)
    recs = (fetcher or _fetch_repo_receipts)(url, rname)
    _save_receipts_to_bundle(recs, out_path)
    return len(recs), rname, out_path


def _cmd_pull(_argv):
    try:
        count, rname, out_path = pull_receipts(gate.GATE_REPO)
    except (OSError, ValueError) as exc:
        return fatal(str(exc))
    print(M("approval.pulled", count=count, repo=rname, path=out_path))
    return 0


def _cmd_submit(_argv):
    base = gate.GATE_REPO
    _zd, data, disk_probs = _load_verified_seal(base)
    if disk_probs or not data:
        return _fail_probs(disk_probs)
    probs = _all_anchor_probs(base, auto_sync=False)
    if not probs:
        print(M("approval.no_controlled_changes"))
        return 0
    _auto_sync_for_probs(base, load_anchors(base) or {}, probs)
    rem = _all_anchor_probs(base, auto_sync=False)
    if rem:
        return _fail_probs(rem)
    print(M("approval.submit_clean"))
    return 0


def _matching_suite_sig(recs, tree_sha, seq):
    for rec in recs:
        b = trust_core.receipt_body(rec)
        rec_seq = trust_core.safe_int(b.get("suite_seq"), None)
        if (b.get("repo") == trust_core.TRUSTED_UPSTREAM_REPO and b.get("action") == "suite.release"
                and (b.get("target") or b.get("target_path")) == "zreflect/SEAL.json"
                and b.get("target_sha256") == tree_sha and rec_seq is not None and rec_seq == seq):
            return rec
    return None


def _write_suite_sig(zd, rec, data):
    sig_p = os.path.join(zd, SUITE_SIG_NAME)
    _write_json_atomic(sig_p, rec)
    seq = trust_core.safe_int(data.get("suite_seq"), 1) or 1
    print(M("trust.suite_released", path=sig_p, seq=seq, tree=data.get("tree_sha256", "")))
    return 0


def _cmd_release(_argv):
    base = gate.GATE_REPO
    zd, data, disk_probs = _load_verified_seal(base)
    if disk_probs or not data:
        return fatal(disk_probs[0])
    anc = load_anchors(base) or {}
    rname = trust_core.TRUSTED_UPSTREAM_REPO
    tree_sha, seq = data.get("tree_sha256") or "", trust_core.safe_int(data.get("suite_seq"), 1) or 1
    url = (os.environ.get(APPROVER_URL_ENV) or DEFAULT_APPROVER_URL).rstrip("/")
    try:
        hit = _matching_suite_sig(_fetch_repo_receipts(url, rname), tree_sha, seq)
        if hit is not None:
            return _write_suite_sig(zd, hit, data)
    except (OSError, ValueError):
        pass
    payload = {
        "repo": rname, "agent_id": os.environ.get("USER", "agent"), "action": _SUITE_RELEASE,
        "target_path": _SEAL_REL, "prev_sha256": anc.get("suite_tree_sha256") or "NONE",
        "target_sha256": tree_sha, "suite_seq": seq,
        "target_content": json.dumps(data, indent=1, sort_keys=True),
        "diff_summary": f"suite.release seq={seq} tree={tree_sha[:16]}",
    }
    resp, err = _approver_json(url, "/requests", payload)
    if err or resp is None:
        return fatal(err)
    if resp.get("receipt"):
        return _write_suite_sig(zd, resp["receipt"], data)
    print(M("approval.request_submitted", id=resp.get("display_id") or resp.get("id", ""),
            status=resp.get("status", "pending"), action="suite.release", target="zreflect/SEAL.json", url=url))
    return 1


def _cmd_init(_argv):
    if init_anchors() == 0:
        print(M("approval.anchors_created", path=ANCHORS_FILE))
        return 0
    print(M("approval.anchors_exist", path=ANCHORS_FILE), file=sys.stderr)
    return 1


def _main_cli(argv):
    from typing import Any  # noqa: PLC0415
    table: dict[str, Any] = {
        "--verify-seal": _cmd_verify_seal,
        "--init": _cmd_init,
        "--sync": lambda _a: _sync_settled(gate.GATE_REPO),
        "--pull": _cmd_pull,
        "--submit": _cmd_submit,
        "--release": _cmd_release,
        "--migrate": cmd_migrate,
        "--upgrade": cmd_upgrade,
    }
    for flag, fn in table.items():
        if flag in argv:
            return fn(argv)
    return fatal(M("trust.unknown_command"))


if __name__ == "__main__":
    raise SystemExit(main_selftest_or(sys.argv[1:], M("seal.title"), _cases, _main_cli))
