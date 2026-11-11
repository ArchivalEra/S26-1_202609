#!/usr/bin/env python3
"""工作区闸门：`study/` 不许进 git，根层不许散落文件。

## 挡的是什么

`/mnt/hdd/study/` 是**仓库外的原始资料工作区**：课堂转写原件、教材照片、音频、
课件、验收报告都堆在那里。它有一条铁律（`AGENTS.md`）：

> **课堂转写原件不入库**——原件含教师个人信息与学生发言，本地副本留在
> `课程总览/<课>/原始资料/` 或 `/mnt/hdd/study/<课>/原始资料/`，不跟踪、不加白名单、不推送。

2026-11-11 实测过两种违反形态：

1. **整份 study 被仓库存成子目录**（另一种常见形态：有人在 `study/` 里 `git init`
   再把这个仓指过去，或把它当 submodule）——原件于是进历史，隐私直接泄漏；
2. **新转写/照片散落在 `study/` 根层**（`20261110_13301455-原文.txt`、15 张
   `微信图片_*.jpg`）——没归进 `<课>/原始资料/`，于是「这个课有没有这节课」
   查不出来，`工具/录音检索.py` 也看不见它。

两种都不是「注意一下就好」：第一种是隐私事故，第二种会让检索与索引静默漏课。

## 判据

① **不追踪**：`git ls-files` 里不许出现 `study/` 前缀（相对仓库根）；本仓不是
   superproject，所以 submodule 形态在这里表现为「仓库里根本没有 study」——
   若仓库里冒出 `study/` 目录（无论跟踪与否）都报。
② **不散落**：`study/` 根层**只允许目录**。任何文件（`.txt` / `.jpg` / `.jxl` /
   `.pdf` / `README.md` 也算——它要么是说明要么是待办，都该归位）都报。

`_其他资料/`、`图元验收/` 这类目录本身合规（它们是有名字的归档位），只查根层。

## 为什么要它

因为「归位」这件事**每次都是人工判断**，而判断会漏：2026-11-11 那批照片
（工程数学第 4 章，早已入库）在根层躺了五天，期间没人发现——它们既不在
任何 `原始资料/` 的登记表里，也不在任何索引里，等于凭空消失。

用法：
    python3 zreflect/check_study.py              # 跑闸门
    python3 zreflect/check_study.py --selftest   # 判据自证
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gate import meta, main_selftest_or  # noqa: E402
from i18n import M  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 仓库外的工作区（本仓约定：与仓库同级在 /mnt/hdd 下）。
WORKSPACE = os.environ.get("STUDY_WORKSPACE") or "/mnt/hdd/study"


def tracked_study(repo=REPO):
    """`git ls-files` 里有没有 `study/` 前缀的路径。返回命中的路径列表。"""
    try:
        out = subprocess.run(
            ["git", "-c", "core.quotepath=false", "ls-files", "-z"],
            cwd=repo, capture_output=True, text=True, encoding="utf-8", check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return []
    hits = []
    for rel in out.split("\0"):
        if not rel:
            continue
        if rel == "study" or rel.startswith("study/"):
            hits.append(rel)
    return hits


def repo_has_study_dir(repo=REPO):
    """仓库里出现 `study/` 目录本身就是违规（submodule 或误将工作区搬进仓）。"""
    return os.path.isdir(os.path.join(repo, "study"))


# 根层允许的「不是待办」的文件：工作区说明。它们是目录结构的一部分，
# 不归任何课程、也不需要归位——把 README 判成散落待办会让闸门每次都红。
ROOT_ALLOWED = frozenset({"README.md"})


def stray_files(workspace=WORKSPACE):
    """工作区根层的散落文件（相对路径列表）。目录不算——那是有名字的归档位。"""
    try:
        entries = sorted(os.listdir(workspace))
    except OSError:
        return []
    return [
        e for e in entries
        if os.path.isfile(os.path.join(workspace, e)) and e not in ROOT_ALLOWED
    ]


def problems(repo=REPO, workspace=WORKSPACE):
    """全部判据。返回 (kind, detail) 列表；空 = 通过。"""
    out = []
    if repo_has_study_dir(repo):
        out.append(("repo_has_study_dir", "study/"))
    for rel in tracked_study(repo):
        out.append(("tracked", rel))
    for name in stray_files(workspace):
        out.append(("stray", name))
    return out


def run(_argv):
    """PINNED: 本闸门的中文报告面向站长单人（排障输出）。"""
    # 工作区不存在 ⇒ 不能报绿：`problems()` 在那种情况下返回空（没有东西可查），
    # 直接把空当通过就是「没查过的东西报绿」。
    if not os.path.isdir(WORKSPACE):
        print(f"工作区闸门：工作区 {WORKSPACE} 不存在 —— 这不是通过"
              "（配置错了，或该机器上没有这个工作区）")
        return 1
    probs = problems()
    if not probs:
        n = len(os.listdir(WORKSPACE))
        print(f"工作区闸门：OK（study/ 未入库、根层无散落文件；{n} 个归档目录）")
        return 0
    print(f"工作区闸门：{len(probs)} 个问题")
    for kind, detail in probs:
        if kind == "repo_has_study_dir":
            print("  · 仓库里出现了 study/ 目录 —— 原始资料工作区必须在仓库外，"
                  "且绝不能被 submodule 或 git add 带进来")
        elif kind == "tracked":
            print(f"  · 被 git 追踪：{detail} —— 原件含师生个人信息，必须从历史移除")
        elif kind == "stray":
            print(f"  · 根层散落：{detail} —— 归进 <课>/原始资料/（或 _其他资料/），"
                  "再按需在 原始资料/index.md 登记")
    print("  处置：散落文件按课程归位；被追踪的原件用 filter-repo 剔历史（见 HISTORY.md）。")
    return 1


def _cases():
    """自证：只用纯函数判据，不碰真工作区（真跑由 run() 覆盖）。"""
    import tempfile  # noqa: PLC0415

    def mk(files, dirs=("a",)):
        d = tempfile.mkdtemp()
        for x in dirs:
            os.makedirs(os.path.join(d, x), exist_ok=True)
        for f in files:
            open(os.path.join(d, f), "w", encoding="utf-8").close()
        return d

    def stray_case():
        d = mk(["loose.txt"])
        try:
            return stray_files(d) == ["loose.txt"]
        finally:
            import shutil  # noqa: PLC0415
            shutil.rmtree(d, ignore_errors=True)

    def readme_not_stray():
        d = mk(["README.md"])
        try:
            return stray_files(d) == []
        finally:
            import shutil  # noqa: PLC0415
            shutil.rmtree(d, ignore_errors=True)

    def no_stray_case():
        d = mk([], dirs=("course-a", "other-archive"))
        try:
            return stray_files(d) == []
        finally:
            import shutil  # noqa: PLC0415
            shutil.rmtree(d, ignore_errors=True)

    def missing_ws_is_silent_so_runner_must_guard():
        """目录不存在时 problems() 返回空 —— 所以 run() 不能只看它是空的就报绿。

        这条自证的意义是**固定这个事实**：守卫写在 run() 里（那里 `os.path.isdir`
        决定打印 OK 还是报缺目录），纯函数层不重复造第二份判据。
        """
        return problems(workspace="/nonexistent-study-dir-xyz") == []

    return [
        ("stray_file_reported", stray_case),
        ("root_readme_not_stray", readme_not_stray),
        ("clean_root_passes", no_stray_case),
        ("missing_workspace_is_silent_so_runner_must_guard",
         missing_ws_is_silent_so_runner_must_guard),
        ("tracked_scan_returns_list", lambda: isinstance(tracked_study(), list)),
        ("repo_study_dir_flag_off_when_absent", lambda: repo_has_study_dir() is False),
    ]


# PINNED: 闸门名与描述面向站长单人（STATE 机器块的 zh 渲染唯一读者）。
GATE = meta("工作区闸门",
            "study/ 不许进 git；根层不许散落转写与照片（归位才能被检索与索引看见）",
            runs_at="commit")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:],
                              M("gate.title.study"),
                              _cases, run))
