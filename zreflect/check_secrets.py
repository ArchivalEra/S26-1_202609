#!/usr/bin/env python3
"""Secret-material gate with explicit paths and narrow, justified exemptions.

``secrets.json`` example::

    {
      "paths": ["src", "scripts"],
      "allow": [
        {"path": "src/fixtures/aws.txt", "rule": "aws-access-key"}
      ]
    }

Rules match single lines and findings never print the matched value. Files are
read incrementally; binary files and symlinks are counted, not followed. An
allow entry suppresses exactly one path/rule pair and becomes a finding when it
no longer suppresses anything. The gate is off only when its default spec is
absent; an explicitly named missing spec is a configuration error.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gate  # noqa: E402
import knobs  # noqa: E402
from gate import finish, main_selftest_or, meta, repo  # noqa: E402
from i18n import M, Message  # noqa: E402

DEFAULT_SPEC = knobs.REGISTRY["REFLECT_SECRETS"][1]
SKIP_DIRS = {".git", ".mypy_cache", ".ruff_cache", "__pycache__"}
RULES = (
    ("private-key", re.compile(
        r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----")),
    ("aws-access-key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("github-token", re.compile(
        r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b")),
    ("slack-token", re.compile(r"\bxox[baprs]-[0-9A-Za-z-]{10,}\b")),
    ("stripe-key", re.compile(r"\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b")),
    ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("jwt", re.compile(
        r"\beyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\b")),
    ("url-credentials", re.compile(
        r"\b[a-z][a-z0-9+.-]*://[^/\s:@]+:[^/\s:@]{6,}@")),
    ("generic-secret", re.compile(
        r"(?i)\b(?:api[_-]?key|client[_-]?secret|password|passwd|"
        r"access[_-]?token|secret[_-]?key|auth[_-]?token)\b"
        r"\s*[:=]\s*(?:[\"'](?P<quoted>[^\"']{8,})[\"']"
        r"|(?P<bare>[A-Za-z0-9/+_-]{16,}))")),
)
RULE_NAMES = frozenset(name for name, _pattern in RULES)
# A value is exempt only when it is **entirely** a template or a stand-in word.
# Substring matching was the earlier shape and it waved through real secrets
# that merely contained "example" somewhere in the middle.
PLACEHOLDER = re.compile(
    r"(?i)^(?:\$\{[^}]*\}|\{\{[^}]*\}\}|<[^>]*>|x{6,}|\*{6,}|\.{6,}"
    r"|changeme|placeholder|dummy|redacted"
    r"|your[-_](?:password[-_]here|token[-_]here|api[-_]key[-_]here|secret[-_]here)"
    r"|example[-_](?:token|key|password|secret))$")


def _is_covered(rel, prefixes):
    norm = rel.replace(os.sep, "/")
    if norm.startswith("./"):
        norm = norm[2:]
    for p in prefixes:
        base = str(p or "").replace(os.sep, "/").strip().strip("/")
        if not base or base == ".":
            return True
        if norm == base or norm.startswith(base + "/"):
            return True
    return False


def _ignore_path_str(entry):
    if isinstance(entry, dict):
        return str(entry.get("path") or "")
    return str(entry or "")


def _git_tracked(root):
    if not os.path.exists(os.path.join(root, ".git")):
        return []
    try:
        r = subprocess.run(["git", "-C", root, "ls-files", "--cached", "--others", "--exclude-standard"],
                           capture_output=True, text=True, timeout=15,
                           encoding="utf-8", errors="replace")
        if r.returncode != 0:
            return None
        return [ln.strip() for ln in r.stdout.splitlines() if ln.strip()]
    except (OSError, subprocess.TimeoutExpired):
        return None


def _uncovered_tracked_problems(root, spec, tracked=None):
    tracked_files = _git_tracked(root) if tracked is None else list(tracked)
    if tracked_files is None:
        return [M("secrets.uncovered_tracked", path="git:ls-files")]
    if not tracked_files:
        return []
    ignores = [_ignore_path_str(x) for x in (spec.get("ignore_paths") or [])]
    covered = list(spec.get("paths") or []) + ignores
    return [M("secrets.uncovered_tracked", path=rel)
            for rel in sorted(tracked_files) if not _is_covered(rel, covered)]


def _ignore_entry_bad(entry):
    if not isinstance(entry, dict):
        return True
    path = str(entry.get("path") or "").strip()
    why = str(entry.get("reason") or entry.get("why") or "").strip()
    return not path or not why


def spec_problems(spec):
    """Validate paths, ignore_paths, and allow entries without reading the target tree."""
    if not isinstance(spec, dict):
        return [M("secrets.spec_not_object")]
    out = []
    paths = spec.get("paths")
    if (not isinstance(paths, list) or not paths
            or any(not isinstance(path, str) or not path.strip() for path in paths)):
        out.append(M("secrets.paths_empty"))
    ignore = spec.get("ignore_paths", [])
    if not isinstance(ignore, list) or any(_ignore_entry_bad(item) for item in ignore):
        out.append(M("secrets.ignore_not_list"))
    allow = spec.get("allow", [])
    if not isinstance(allow, list):
        return out + [M("secrets.allow_not_list")]
    seen: set[tuple[str, str]] = set()
    for entry in allow:
        out += _allow_problems(entry, seen)
    return out


def _allow_problems(entry, seen):
    if not isinstance(entry, dict):
        return [M("secrets.allow_not_object", entry=entry)]
    path = str(entry.get("path") or "").replace(os.sep, "/").strip()
    rule = str(entry.get("rule") or "").strip()
    why = str(entry.get("reason") or entry.get("why") or "").strip()
    out = []
    if not path or not rule or not why:
        return [M("secrets.allow_fields", entry=entry)]
    if rule not in RULE_NAMES:
        out.append(M("secrets.allow_unknown_rule", rule=rule))
    key = (path, rule)
    if key in seen:
        out.append(M("secrets.allow_duplicate", path=path, rule=rule))
    seen.add(key)
    return out


def _safe_path(root, relative):
    if os.path.isabs(relative):
        return None
    path = os.path.abspath(os.path.join(root, relative))
    try:
        inside = os.path.commonpath((os.path.abspath(root), path)) == os.path.abspath(root)
    except ValueError:
        return None
    return path if inside else None


def _walk_path(root, relative, files, problems, stats):
    path = _safe_path(root, relative)
    if path is None:
        problems.append(M("secrets.path_outside", path=relative))
        return
    if not os.path.exists(path):
        problems.append(M("secrets.path_missing", path=relative))
        return
    if os.path.islink(path):
        stats["symlinks"] += 1
        return
    if os.path.isfile(path):
        files.add(path)
        return
    for dirpath, dirnames, filenames in os.walk(path):
        dirnames[:] = sorted(name for name in dirnames if name not in SKIP_DIRS)
        for name in sorted(filenames):
            filename = os.path.join(dirpath, name)
            if os.path.islink(filename):
                stats["symlinks"] += 1
            else:
                files.add(filename)


def collect_files(root, paths):
    """Return ``(files, problems, stats)`` with deterministic, non-escaping traversal."""
    files: set[str] = set()
    problems: list[Message] = []
    stats = {"symlinks": 0, "binary": 0, "scanned": 0}
    for relative in paths:
        _walk_path(root, relative.strip(), files, problems, stats)
    return sorted(files), problems, stats


def line_findings(path, lineno, line):
    """Return rule identifiers for one line; matched material is never retained."""
    out = []
    for rule, pattern in RULES:
        for match in pattern.finditer(line):
            if rule == "generic-secret":
                value = match.group("quoted") or match.group("bare") or ""
                if PLACEHOLDER.fullmatch(value.strip()):
                    continue
            out.append({"path": path, "line": lineno, "rule": rule})
    return out


def _relative(root, path):
    return os.path.relpath(path, root).replace(os.sep, "/")


_TEXT_EXTS = frozenset({".py", ".md", ".txt", ".json", ".yml", ".yaml", ".sh", ".toml", ".env"})


def _scan_file(root, path, stats):
    relative = _relative(root, path)
    findings: list[dict[str, object]] = []
    try:
        with open(path, "rb") as fh:
            head = fh.read(8192)
            ext = os.path.splitext(path)[1].lower()
            if b"\0" in head and ext not in _TEXT_EXTS:
                stats["binary"] += 1
                return findings, None
        stats["scanned"] += 1
        with open(path, encoding="utf-8", errors="replace") as fh:
            for lineno, line in enumerate(fh, 1):
                findings += line_findings(relative, lineno, line)
    except OSError as exc:
        return findings, M("secrets.unreadable", path=relative, error=exc)
    return findings, None


def _allowed(finding, allow):
    return any(entry.get("path") == finding["path"]
               and entry.get("rule") == finding["rule"] for entry in allow)


def _unused_allow_problems(findings, allow):
    pairs = {(item["path"], item["rule"]) for item in findings}
    return [M("secrets.allow_stale", path=entry["path"], rule=entry["rule"])
            for entry in allow
            if (entry.get("path"), entry.get("rule")) not in pairs]


def scan(root, spec, tracked=None):
    """Scan a spec and return ``(problems, stats)`` suitable for ``gate.finish``."""
    paths = spec.get("paths") or []
    allow = spec.get("allow") or []
    files, problems, stats = collect_files(root, paths)
    problems += _uncovered_tracked_problems(root, spec, tracked=tracked)
    findings = []
    for path in files:
        current, error = _scan_file(root, path, stats)
        findings += current
        if error:
            problems.append(error)
    problems += _unused_allow_problems(findings, allow)
    problems += [M("secrets.finding", path=item["path"], line=item["line"],
                   rule=item["rule"]) for item in findings if not _allowed(item, allow)]
    if not stats["scanned"]:
        problems.append(M("secrets.empty"))
    return problems, stats


def run(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    spec, _name, rc = gate.load_gate_spec(
        argv, "REFLECT_SECRETS",
        off_msg=lambda n: M("secrets.off", name=n),
        missing_msg=lambda n: M("secrets.spec_missing", name=n),
    )
    if rc is not None:
        return rc
    shape = spec_problems(spec)
    if shape:
        for problem in shape:
            print("  · " + str(problem), file=sys.stderr)
        return 2
    problems, stats = scan(repo(), spec)
    return finish(M("secrets.title"), problems, M(
        "secrets.ok", scanned=stats["scanned"], binary=stats["binary"],
        symlinks=stats["symlinks"], allowed=len(spec.get("allow") or [])))


def _cases():
    import tempfile  # noqa: PLC0415
    clean = 'token = "${SERVICE_TOKEN}"\npassword = "your-password-here"\n'
    leaked = 'aws = "AKIAIOSFODNN7EXAMPLE"\n'
    return [
        ("secrets.clean", lambda: line_findings("a.txt", 1, clean) == []),
        ("secrets.allow_shape",
         lambda: spec_problems({"paths": ["app"], "allow": [
             {"path": "app/a.txt", "rule": "aws-access-key", "reason": "fixture"}]}) == []),
        ("★ secrets.exemption_requires_reason",
         lambda: [p.code for p in spec_problems({"paths": ["app"], "allow": [
             {"path": "app/a.txt", "rule": "aws-access-key"}]})] == ["secrets.allow_fields"]
         and [p.code for p in spec_problems({"paths": ["app"], "ignore_paths": ["scripts"]})]
         == ["secrets.ignore_not_list"]),
        ("★ secrets.aws", lambda: [x["rule"] for x in line_findings("a.txt", 1, leaked)]
         == ["aws-access-key"]),
        ("★ secrets.private_key",
         lambda: [x["rule"] for x in line_findings(
             "a.txt", 1, "-----BEGIN OPENSSH PRIVATE KEY-----")] == ["private-key"]),
        ("★ secrets.github",
         lambda: [x["rule"] for x in line_findings(
             "a.txt", 1, "ghp_" + "a" * 36)] == ["github-token"]),
        ("★ secrets.generic",
         lambda: [x["rule"] for x in line_findings(
             "a.txt", 1, 'api_key = "not-a-real-demo-value"')] == ["generic-secret"]),
        # the family set must actually grow: a 1M-line repo leaks through Slack,
        # Stripe, Google, JWT and inline-URL credentials, not only AWS/GitHub
        ("★ secrets.slack",
         lambda: [x["rule"] for x in line_findings(
             "a.txt", 1, "hook = xoxb-" + "1" * 12)] == ["slack-token"]),
        ("★ secrets.stripe",
         lambda: [x["rule"] for x in line_findings(
             "a.txt", 1, "k = sk_live_" + "a" * 20)] == ["stripe-key"]),
        ("★ secrets.google",
         lambda: [x["rule"] for x in line_findings(
             "a.txt", 1, "k = AIza" + "a" * 35)] == ["google-api-key"]),
        ("★ secrets.jwt",
         lambda: [x["rule"] for x in line_findings(
             "a.txt", 1, "t = eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSM")]
         == ["jwt"]),
        ("★ secrets.url_credentials",
         lambda: [x["rule"] for x in line_findings(
             "a.txt", 1, "u = https://user:hunter2pass@host/x")] == ["url-credentials"]),
        ("★ secrets.bare_assignment",
         lambda: [x["rule"] for x in line_findings(
             "a.txt", 1, "password: hunter2hunter2hunter2")] == ["generic-secret"]),
        # placeholder exemption must be exact, not substring: a real secret that
        # merely contains "example" used to be waved through
        ("★ secrets.placeholder_is_exact",
         lambda: line_findings("a.txt", 1, 'api_key = "my-example-real-key-9f2"')
         != [] and line_findings("a.txt", 1, 'api_key = "${API_KEY}"') == []),
        ("★ secrets.empty_paths",
         lambda: [p.code for p in spec_problems({"paths": []})]
         == ["secrets.paths_empty"]),
        ("★ secrets.empty_tree", lambda: _empty_tree_case(tempfile)),
        ("★ secrets.path_escape",
         lambda: [p.code for p in scan(tempfile.gettempdir(), {"paths": ["../"]}, tracked=[])[0]]
         == ["secrets.path_outside", "secrets.empty"]),
        # an exemption that suppresses nothing must be reported: otherwise a
        # stale allow entry silently pre-authorises a future leak
        ("★ secrets.allow_stale",
         lambda: _stale_allow_case(tempfile)),
        ("★ secrets.uncovered_tracked",
         lambda: _uncovered_tracked_case(tempfile)),
        ("secrets.ignore_paths_covers",
         lambda: _ignore_paths_case(tempfile)),
    ]


def _uncovered_tracked_case(tempfile):
    with tempfile.TemporaryDirectory() as root:
        os.makedirs(os.path.join(root, "src"))
        open(os.path.join(root, "src", "a.py"), "w").write("x = 1\n")
        problems, _stats = scan(
            root, {"paths": ["src"]}, tracked=["src/a.py", "scripts/run.sh"])
        return [p.code for p in problems] == ["secrets.uncovered_tracked"]


def _ignore_paths_case(tempfile):
    with tempfile.TemporaryDirectory() as root:
        os.makedirs(os.path.join(root, "src"))
        open(os.path.join(root, "src", "a.py"), "w").write("x = 1\n")
        problems, _stats = scan(
            root, {"paths": ["src"], "ignore_paths": [{"path": "scripts", "reason": "fixture"}]},
            tracked=["src/a.py", "scripts/run.sh"])
        return problems == []


def _stale_allow_case(tempfile):
    with tempfile.TemporaryDirectory() as root:
        problems, _stats = scan(root, {"paths": ["."], "allow": [
            {"path": "gone.txt", "rule": "jwt", "reason": "fixture"}]}, tracked=[])
        return [p.code for p in problems] == ["secrets.allow_stale", "secrets.empty"]


def _empty_tree_case(tempfile):
    with tempfile.TemporaryDirectory() as root:
        problems, _stats = scan(root, {"paths": ["."]}, tracked=[])
        return [p.code for p in problems] == ["secrets.empty"]


GATE = meta("Secrets gate", "plain-text credential detection with explicit paths and justified exact exemptions",
            knobs=("REFLECT_SECRETS",),
            off_reason="a repo that declares no credential-scanning spec keeps this "
                       "gate off; a spec named explicitly but absent is a "
                       "configuration error, never a disable")


if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], "check_secrets", _cases, run))
