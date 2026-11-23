#!/usr/bin/env python3
"""
PINNED: Consumer extension for this Chinese-language course archive; heading allowlists are repo-specific data.
Heading allowlist gate: enforces allowed H2 sections on notes/homeworks and forbids retired heading forms.
"""
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zreflect"))

from gate import main_selftest_or, meta  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# PINNED: protocol marker / repo-specific Chinese directory & category names
def _u(*cps):
    return "".join(chr(c) for c in cps)

COURSES_DIR = _u(0x8BFE, 0x7A0B, 0x603B, 0x89C8)
NOTES_DIR = _u(0x8BFE, 0x5802, 0x7B14, 0x8BB0)
HW_DIR = _u(0x4F5C, 0x4E1A)
WB_TITLE = _u(0x5B8C, 0x6210, 0x8FB9, 0x754C)
FORBIDDEN_COND = _u(0x6761, 0x4EF6, 0x5907, 0x6CE8)
FORBIDDEN_SRC_BOUNDARY = _u(0x6765, 0x6E90, 0x4E0E, 0x8FB9, 0x754C)
S_WHAT = _u(0x8FD9, 0x8282, 0x8BFE, 0x5728, 0x5E72, 0x4EC0, 0x4E48)
S_ITEMS = _u(0x9898, 0x53F7, 0x6761, 0x76EE)
S_SIGN2 = _u(0x53CC, 0x7B7E)
S_SIGN3 = _u(0x4E09, 0x7B7E)
S_DEP = _u(0x4F9D, 0x8D56)
S_CALC = _u(0x8BA1, 0x7B97, 0x9898)

# PINNED: allowed H2 titles in note pages (2026-11-23 unified skeleton)
ALLOWED_NOTE_H2 = frozenset({
    S_WHAT,
    _u(0x884C, 0x653F, 0x4E0E, 0x8003, 0x6838),
    _u(0x884C, 0x653F, 0x4E0E, 0x8003, 0x6838, 0xFF08, 0x6709, 0x624D, 0x5199, 0xFF09),
    S_ITEMS,
    _u(0x6CA1, 0x7F16, 0x53F7, 0x4F46, 0x8BB2, 0x4E86, 0x7684, 0x77E5, 0x8BC6, 0x70B9),
    _u(0x8BFE, 0x4EF6, 0x8865, 0x5145),
    _u(0x672C, 0x7BC7, 0x6CA1, 0x8BB2, 0x7684),
    _u(0x8F6C, 0x5199, 0x4E0E, 0x672F, 0x8BED),
    _u(0x8F6C, 0x5199, 0x4E0E, 0x672F, 0x8BED, 0xFF08, 0x6709, 0x624D, 0x5199, 0xFF09),
    WB_TITLE,
})

HW_H2_RE = re.compile(
    r"^(?:\d+\.|[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341]+\u3001"
    r"|" + S_DEP + r"|" + _u(0x5C0F, 0x7ED3) + r"|" + WB_TITLE + ")"
)
WB_H3_RE = re.compile(
    r"^(?:" + S_SIGN2 + r"|" + S_SIGN3 + r"|" + S_SIGN2 + _u(0x8BB0, 0x5F55)
    + r"|" + S_SIGN3 + _u(0x8BB0, 0x5F55)
    + r"|" + S_SIGN2 + r" / " + S_SIGN3 + _u(0x8BB0, 0x5F55) + r")(?:[\uff08(].*[)\uff09])?$"
)
FORBIDDEN_HEADING_RE = re.compile(
    r"^(?:#{1,6}\s*" + FORBIDDEN_COND + r"|##\s*(?:1\.\s*)?" + FORBIDDEN_SRC_BOUNDARY + r"\b)"
)


def _managed_md(repo):
    try:
        out = subprocess.run(
            ["git", "-c", "core.quotepath=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            cwd=repo, capture_output=True, text=True, encoding="utf-8", check=True,
        ).stdout
        return [p for p in out.split("\0") if p.startswith(COURSES_DIR + "/") and p.endswith(".md")]
    except (OSError, subprocess.CalledProcessError):
        root = os.path.join(repo, COURSES_DIR)
        if not os.path.isdir(root):
            return []
        found = []
        for base, _, names in os.walk(root):
            for name in sorted(names):
                if name.endswith(".md"):
                    found.append(os.path.relpath(os.path.join(base, name), repo).replace(os.sep, "/"))
        return found


def _check_h2(h2, lineno, is_note, is_hw, in_wb):
    probs = []
    if in_wb:
        probs.append((lineno, f"H2 after {WB_TITLE}: ## {h2}"))
    if is_note and h2 not in ALLOWED_NOTE_H2:
        probs.append((lineno, f"disallowed {NOTES_DIR} H2: ## {h2}"))
    elif is_hw and not HW_H2_RE.match(h2):
        probs.append((lineno, f"disallowed {HW_DIR} H2: ## {h2}"))
    return probs


def check_file(rel, text):
    """Return list of `(line_no, message)` problems for one markdown file."""
    parts = rel.split("/")
    is_note = len(parts) == 4 and parts[2] == NOTES_DIR and parts[3] != "index.md"
    is_hw = len(parts) == 4 and parts[2] == HW_DIR and parts[3] != "index.md"
    probs = []
    in_fence = False
    in_wb = False
    for lineno, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if FORBIDDEN_HEADING_RE.match(line):
            probs.append((lineno, f"retired/forbidden heading: {line.strip()}"))
        elif line.startswith("## "):
            h2 = line[3:].strip()
            probs.extend(_check_h2(h2, lineno, is_note, is_hw, in_wb))
            in_wb = (h2 == WB_TITLE)
        elif in_wb and line.startswith("### ") and not WB_H3_RE.match(line[4:].strip()):
            probs.append((lineno, f"disallowed H3 under {WB_TITLE}: {line.strip()}"))
    return probs


def problems(repo=REPO, files_map=None):
    """Return `(rel_path, line_no, msg)` tuples across managed course markdown."""
    out = []
    if files_map is None:
        rels = sorted(_managed_md(repo))
        for rel in rels:
            full = os.path.join(repo, rel)
            if not os.path.isfile(full):
                continue
            with open(full, encoding="utf-8") as fh:
                text = fh.read()
            for ln, msg in check_file(rel, text):
                out.append((rel, ln, msg))
    else:
        for rel in sorted(files_map):
            if rel.startswith(COURSES_DIR + "/") and rel.endswith(".md"):
                for ln, msg in check_file(rel, files_map[rel]):
                    out.append((rel, ln, msg))
    return out


def run(_argv):
    """PINNED: 本闸门的中文报告面向仓库维护者单人排查使用。"""
    root = os.path.join(REPO, COURSES_DIR)
    if not os.path.isdir(root):
        print(f"标题白名单闸门：目录 {COURSES_DIR}/ 不存在（非跳过）")
        return 1
    probs = problems(REPO)
    if not probs:
        print("标题白名单闸门：OK（全部受管课程页面标题合规，无已废子节）")
        return 0
    print(f"标题白名单闸门：发现 {len(probs)} 处违规标题")
    for rel, ln, msg in probs:
        print(f"  · {rel}:{ln} -> {msg}")
    return 1


def _cases():
    note = f"{COURSES_DIR}/A/{NOTES_DIR}/11-11-demo.md"
    hw = f"{COURSES_DIR}/A/{HW_DIR}/hw1.md"

    def valid_note_and_hw_pass():
        files = {
            note: (
                "# demo\n\n"
                f"## {S_WHAT}\n\nok\n\n"
                f"## {S_ITEMS}\n\nok\n\n"
                f"## {WB_TITLE}\n\nok\n\n"
                f"### {S_SIGN2}\n\nok\n"
            ),
            hw: (
                "# hw1\n\n"
                f"## 1. {S_DEP}\n\nok\n\n"
                f"## 2. {S_CALC}\n\nok\n\n"
                f"## {WB_TITLE}\n\nok\n\n"
                f"### {S_SIGN3}\n\nok\n"
            ),
        }
        return problems(files_map=files) == []

    def retired_cond_heading_caught():
        files = {note: f"# demo\n\n## {WB_TITLE}\n\n### {FORBIDDEN_COND}\n"}
        return len(problems(files_map=files)) == 1

    def invented_note_h2_caught():
        files = {note: "# demo\n\n## UnexpectedSection\n"}
        return len(problems(files_map=files)) == 1

    def h2_after_wb_caught():
        files = {note: f"# demo\n\n## {WB_TITLE}\n\n## {S_ITEMS}\n"}
        return len(problems(files_map=files)) == 1

    def bad_wb_h3_caught():
        files = {hw: f"# hw1\n\n## {WB_TITLE}\n\n### MiscSubsection\n"}
        return len(problems(files_map=files)) == 1

    def fenced_heading_ignored():
        files = {note: f"# demo\n\n```md\n## IgnoredHeading\n### {FORBIDDEN_COND}\n```\n"}
        return problems(files_map=files) == []

    return [
        ("valid_note_and_hw_pass", valid_note_and_hw_pass),
        ("retired_cond_heading_caught", retired_cond_heading_caught),
        ("invented_note_h2_caught", invented_note_h2_caught),
        ("h2_after_wb_caught", h2_after_wb_caught),
        ("bad_wb_h3_caught", bad_wb_h3_caught),
        ("fenced_heading_ignored", fenced_heading_ignored),
    ]


# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
GATE = meta(
    "页面标题白名单闸门",
    "受管课堂笔记/作业只允许白名单标题，「完成边界」居末且禁止条件备注/来源与边界等已废标题",
    runs_at="commit",
)

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], ("gate title: headings_allowed"), _cases, run))
