#!/usr/bin/env python3
"""
PINNED: Consumer extension for this Chinese-language course archive; path literals are data, not user-facing prose.
Walkthrough 覆盖闸门：已建 Walkthrough.md 的课程，其受管课堂笔记与作业必须在 Walkthrough.md 中有对应入口或引用。
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zreflect"))

from gate import main_selftest_or, meta  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# PINNED: protocol marker / repo-specific directory name in Chinese course archive
COURSES_DIR = "\u8bfe\u7a0b\u603b\u89c8"
# PINNED: protocol marker / repo-specific category names in Chinese course archive
COVERED_KINDS = ("\u8bfe\u5802\u7b14\u8bb0", "\u4f5c\u4e1a")
WALKTHROUGH = "Walkthrough.md"


def _managed_files(repo):
    try:
        out = subprocess.run(
            ["git", "-c", "core.quotepath=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            cwd=repo, capture_output=True, text=True, encoding="utf-8", check=True,
        ).stdout
        return [p for p in out.split("\0") if p]
    except (OSError, subprocess.CalledProcessError):
        return _walk_md(repo)


def _walk_md(repo):
    root = os.path.join(repo, COURSES_DIR)
    if not os.path.isdir(root):
        return []
    found = []
    for base, _, names in os.walk(root):
        for name in sorted(names):
            if name.endswith(".md"):
                found.append(os.path.relpath(os.path.join(base, name), repo).replace(os.sep, "/"))
    return found


def _read_text(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def _collect_walkthroughs(repo, rels):
    out = {}
    for rel in rels:
        parts = rel.split("/")
        if len(parts) == 3 and parts[0] == COURSES_DIR and parts[2] == WALKTHROUGH:
            full = os.path.join(repo, rel)
            if os.path.isfile(full):
                out[parts[1]] = _read_text(full)
    return out


def _is_covered_target(repo, rel):
    parts = rel.split("/")
    if len(parts) != 4 or parts[0] != COURSES_DIR or parts[2] not in COVERED_KINDS:
        return None
    course, name = parts[1], parts[3]
    if not name.endswith(".md") or name == "index.md":
        return None
    if not os.path.isfile(os.path.join(repo, rel)):
        return None
    return course, name


def problems(repo=REPO, files=None):
    """返回 `(course, rel_path)` 列表；空列表表示已建 Walkthrough 课程全覆盖。"""
    rels = sorted(files) if files is not None else _managed_files(repo)
    wt_by_course = _collect_walkthroughs(repo, rels)
    out = []
    for rel in rels:
        hit = _is_covered_target(repo, rel)
        if not hit:
            continue
        course, name = hit
        wt_text = wt_by_course.get(course)
        if wt_text is not None and name not in wt_text and name[:-3] not in wt_text:
            out.append((course, rel))
    return out


def run(_argv):
    """PINNED: 本闸门的中文报告面向仓库维护者单人排查使用，不属于面向终端的通用英文核心消息。"""
    root = os.path.join(REPO, COURSES_DIR)
    if not os.path.isdir(root):
        print(f"Walkthrough 闸门：目录 {COURSES_DIR}/ 不存在（非跳过，请核对仓库根目录）")
        return 1
    rels = _managed_files(REPO)
    wt_courses = sorted(_collect_walkthroughs(REPO, rels))
    if not wt_courses:
        print("Walkthrough 闸门：未发现任何课程 Walkthrough.md（配置或收集异常）")
        return 1
    probs = problems(REPO, files=rels)
    if not probs:
        print(f"Walkthrough 闸门：OK（{len(wt_courses)} 门已建课程的受管笔记与作业全数覆盖）")
        return 0
    print(f"Walkthrough 闸门：{len(probs)} 篇未在所属课程 Walkthrough.md 登记")
    for course, rel in probs:
        print(f"  · [{course}] {rel} -> 需在 {COURSES_DIR}/{course}/{WALKTHROUGH} 加入入口或对应条款")
    return 1


def _cases():
    """纯函数自证：构造临时课程树验证覆盖、漏篇与无 Walkthrough 豁免。"""
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415

    def with_tree(files_map, fn):
        d = tempfile.mkdtemp()
        try:
            for rel, content in files_map.items():
                full = os.path.join(d, rel)
                os.makedirs(os.path.dirname(full), exist_ok=True)
                with open(full, "w", encoding="utf-8") as fh:
                    fh.write(content)
            return fn(d, sorted(files_map.keys()))
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def covered_passes():
        wt_rel = f"{COURSES_DIR}/A/{WALKTHROUGH}"
        n_rel = f"{COURSES_DIR}/A/{COVERED_KINDS[0]}/09-20-note1.md"
        idx_rel = f"{COURSES_DIR}/A/{COVERED_KINDS[0]}/index.md"
        hw_rel = f"{COURSES_DIR}/A/{COVERED_KINDS[1]}/hw1.md"
        tree = {
            wt_rel: f"# WT\n- [note1]({COVERED_KINDS[0]}/09-20-note1.md)\n- hw1 ([hw1]({COVERED_KINDS[1]}/hw1.md))\n",
            n_rel: "# note1\n",
            idx_rel: "# idx\n",
            hw_rel: "# hw1\n",
        }
        return with_tree(tree, lambda d, fs: problems(d, files=fs) == [])

    def missing_note_caught():
        wt_rel = f"{COURSES_DIR}/A/{WALKTHROUGH}"
        n_rel = f"{COURSES_DIR}/A/{COVERED_KINDS[0]}/10-01-new.md"
        tree = {wt_rel: "# WT\n", n_rel: "# new\n"}
        return with_tree(tree, lambda d, fs: problems(d, files=fs) == [("A", n_rel)])

    def missing_homework_caught():
        wt_rel = f"{COURSES_DIR}/A/{WALKTHROUGH}"
        hw_rel = f"{COURSES_DIR}/A/{COVERED_KINDS[1]}/hw2.md"
        tree = {wt_rel: "# WT\n", hw_rel: "# hw2\n"}
        return with_tree(tree, lambda d, fs: problems(d, files=fs) == [("A", hw_rel)])

    def course_without_walkthrough_exempt():
        tree = {f"{COURSES_DIR}/B/{COVERED_KINDS[0]}/10-26-intro.md": "# intro\n"}
        return with_tree(tree, lambda d, fs: problems(d, files=fs) == [])

    return [
        ("covered_notes_and_homework_pass", covered_passes),
        ("missing_note_caught", missing_note_caught),
        ("missing_homework_caught", missing_homework_caught),
        ("course_without_walkthrough_exempt", course_without_walkthrough_exempt),
    ]


GATE = meta("Walkthrough 覆盖闸门",
            "已建 Walkthrough.md 的课程，受管课堂笔记与作业必须在 Walkthrough.md 中有对应入口",
            runs_at="commit")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], "gate title: walkthrough", _cases, run))
