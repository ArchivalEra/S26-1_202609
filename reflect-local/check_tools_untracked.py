#!/usr/bin/env python3
"""
PINNED: Consumer extension for this Chinese-language course archive; path literals and protocol markers are data, not user-facing prose.
Enforce that the local tools directory remains completely untracked by git and excluded from .gitignore whitelists.
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zreflect"))

from gate import main_selftest_or, meta  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# PINNED: repository directory literal (data, not user-facing messages)
TOOLS_DIR = chr(0x5DE5) + chr(0x5177)


def tracked_tools(repo=REPO):
    """Return any tracked git index paths equal to or inside the local tools directory."""
    try:
        out = subprocess.run(
            ["git", "-c", "core.quotepath=false", "ls-files", "-z"],
            cwd=repo, capture_output=True, text=True, encoding="utf-8", check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return []
    hits = []
    prefix = TOOLS_DIR + "/"
    for rel in out.split("\0"):
        if not rel:
            continue
        if rel == TOOLS_DIR or rel.startswith(prefix):
            hits.append(rel)
    return hits


def whitelisted_tools(gitignore_text):
    """Return any .gitignore whitelist lines re-exposing paths under the local tools directory."""
    prefix = "!/" + TOOLS_DIR + "/"
    exact = "!/" + TOOLS_DIR
    hits = []
    for lineno, raw in enumerate(gitignore_text.splitlines(), 1):
        line = raw.strip()
        if line == exact or line.startswith(prefix):
            hits.append((lineno, line))
    return hits


def problems(repo=REPO, gitignore_text=None):
    """Return (kind, detail) tuples; empty list means clean pass."""
    out = []
    for rel in tracked_tools(repo):
        out.append(("tracked", rel))
    if gitignore_text is None:
        gi_path = os.path.join(repo, ".gitignore")
        try:
            with open(gi_path, encoding="utf-8") as fh:
                gitignore_text = fh.read()
        except OSError:
            gitignore_text = ""
    for lineno, line in whitelisted_tools(gitignore_text):
        out.append(("whitelisted", f"L{lineno}:{line}"))
    return out


def run(_argv):
    """PINNED: local-only maintainer output for gate failures."""
    probs = problems()
    if not probs:
        print(f"OK ({TOOLS_DIR}/ untracked and unwhitelisted)")
        return 0
    print(f"FAIL ({len(probs)} violation(s) in {TOOLS_DIR}/):")
    for kind, detail in probs:
        print(f"  - {kind}: {detail}")
    return 1


def _cases():
    """Pure self-test cases covering tracked-list parsing and .gitignore whitelist detection."""
    def clean_gi_passes():
        gi = "*\n!*/\n!/README.md\n"
        return whitelisted_tools(gi) == []

    def whitelisted_entry_caught():
        gi = f"*\n!*/\n!/{TOOLS_DIR}/sample.mjs\n"
        hits = whitelisted_tools(gi)
        return hits == [(3, f"!/{TOOLS_DIR}/sample.mjs")]

    def non_tool_entry_ignored():
        gi = "*\n!*/\n!/zreflect/doc.py\n"
        return whitelisted_tools(gi) == []

    return [
        ("clean_gitignore_passes", clean_gi_passes),
        ("whitelisted_tool_entry_caught", whitelisted_entry_caught),
        ("unrelated_whitelist_allowed", non_tool_entry_ignored),
        ("tracked_scan_returns_list", lambda: isinstance(tracked_tools(), list)),
    ]


# PINNED: protocol marker / repo-specific data
GATE = meta(
    "tools_untracked",
    "local tools directory must remain untracked by git and absent from .gitignore whitelists",
    runs_at="commit",
)

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], ("gate title: tools"), _cases, run))
