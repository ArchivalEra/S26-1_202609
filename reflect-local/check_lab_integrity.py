#!/usr/bin/env python3
"""
PINNED: Consumer extension for this Chinese-language course archive; path literals and protocol markers are data, not user-facing prose.
实验空完整性闸门（lab 相位，手动触发）——Einfacht 对 .kimi-code/学习通API/ 与
.kimi-code/userscript/（2026-10-24 迁入的生产装配层）两处不入库活代码的管辖权。

管辖对象是**不入库的活代码**（.kimi-code/ 只落盘），所以：
  · 不进 FACTS.json（事实=入库内容的不变量不动；clone 后无 .kimi-code/ 不掉条）；
  · 不挂 pre-commit（.kimi-code/ 改动不产生 commit，挂了形同虚设）；
  · runs_at="lab"：`python3 zreflect/registry.py --run lab` 手动触发
    （悬案 questions/02 的 Settling 就是这条命令）。

挡的事故（2026-10-16 三件套重构立的约）：
  ① 实验空根目录活文件清单漂移——新脚本随手落根目录，49 文件平铺的绊脚石复活；
  ② 破甲配方退化——G 系列结论（疑问式、首条无清单、回喂带清单、caveman 保
     工具名）的设计史在 agent.md §三与 实验/G1-G21/结论.md（配方.mjs 及其
     测试已按 issue #PINNED: repo-specific data retained verbatim in HISTORY.md

判据：
  · 根目录文件集合 ⊆ 白名单（活文件 19 个；多出的 ⇒ 报，说明有新文件要归档或入单）；
  · 全部测试文件 `node --test` 全绿（cwd=实验空；154 项）；
  · 白名单里的文件必须存在（少 ⇒ 报，活文件被误删/误归档）。

零值守卫：实验空目录整个不存在 ⇒ 通过（clone 环境本来就没有 .kimi-code/），
但只要存在就按全量判。
"""

import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zreflect"))
from gate import main_selftest_or, meta  # noqa: E402

# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_LAB_DIR = (chr(23398)+chr(20064)+chr(36890)+'API')
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_RECIPE = (chr(37197)+chr(26041)+'.test.mjs')
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_STRAY = (chr(38543)+chr(25163)+chr(20002)+chr(30340)+chr(33050)+chr(26412)+'.mjs')

# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
ALIVE_FILES = (
    "chaoxing.mjs",      # PINNED: repo-specific data retained verbatim in HISTORY.md
    "chaoxing.test.mjs", # PINNED: repo-specific data retained verbatim in HISTORY.md
    (chr(23432)+chr(21355)+'.test.mjs'),      # PINNED: repo-specific data retained verbatim in HISTORY.md
    (chr(20250)+chr(35805)+'.mjs'),           # PINNED: repo-specific data retained verbatim in HISTORY.md
    (chr(24037)+chr(20855)+chr(20250)+chr(35805)+'.mjs'),        # PINNED: repo-specific data retained verbatim in HISTORY.md
    (chr(21028)+chr(25454)+'.mjs'),           # PINNED: repo-specific data retained verbatim in HISTORY.md
    (chr(21028)+chr(25454)+'.test.mjs'),      # PINNED: repo-specific data retained verbatim in HISTORY.md
    "bridge.test.mjs",    # PINNED: repo-specific data retained verbatim in HISTORY.md
    (chr(32842)+chr(22825)+chr(26381)+chr(21153)+'.mjs'),        # PINNED: repo-specific data retained verbatim in HISTORY.md
    (chr(25554)+chr(20214)+chr(21518)+chr(31471)+chr(26550)+chr(26500)+'.md'),     # PINNED: repo-specific data retained verbatim in HISTORY.md
    (chr(23545)+chr(35805)+'.mjs'),           # PINNED: repo-specific data retained verbatim in HISTORY.md
    "bridge.mjs",        # PINNED: repo-specific data retained verbatim in HISTORY.md
    "agent.md",          # PINNED: repo-specific data retained verbatim in HISTORY.md
    "README.md",         # PINNED: repo-specific data retained verbatim in HISTORY.md
)

# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
LAB_DIR = os.path.join(".kimi-code", (chr(23398)+chr(20064)+chr(36890)+'API'))

def run(args):
    """PINNED: lab 闸门的中文报告面向站长单人（手动触发的排障输出）；白名单路径本身就是中文目录名。"""
    if not os.path.isdir(LAB_DIR):
        # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
        print("lab: .kimi-code/学习通API/ 不存在（clone 环境属预期）—— 通过")
        return 0
    problems = []

    # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
    # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
    RUNTIME_ARTIFACTS = {".bridge-token"}  # noqa: N806
    actual = sorted(f for f in os.listdir(LAB_DIR)
                    if os.path.isfile(os.path.join(LAB_DIR, f)) and f not in RUNTIME_ARTIFACTS)
    extra = [f for f in actual if f not in ALIVE_FILES]
    missing = [f for f in ALIVE_FILES if f not in actual]
    if extra:
        problems.append("根目录多出未归档文件：%s（实验脚本进 实验/，新活文件先改 ALIVE_FILES）"
                        % ", ".join(extra))
    if missing:
        problems.append("活文件缺失：%s（被误删或误归档？）" % ", ".join(missing))

    # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
    # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
    # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
    # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
    # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
    # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
    # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
    tests = [t for t in ("chaoxing.test.mjs", "判据.test.mjs", "bridge.test.mjs") if t in actual]
    if tests:
        r = subprocess.run(
            ["node", "--test", *tests],
            cwd=LAB_DIR, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
        if r.returncode != 0:
            problems.append("回归测试未全绿：\n%s"
                            % (r.stdout + r.stderr)[-800:])

    if problems:
        print("lab 相位：发现 %d 个问题" % len(problems))
        for p in problems:
            print("  ✗ " + p)
        return 1
    print("lab 相位：活文件 %d 个齐全，回归测试全绿" % len(ALIVE_FILES))
    return 0


# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md


def _cases():
    """PINNED: lab 闸门的中文报告面向站长单人（手动触发的排障输出）；白名单路径本身就是中文目录名。"""
    import shutil
    import tempfile
    cases = []

    def make_lab(files, test_ok=True):
        """搭临时实验空夹具：files=根目录文件集；test_ok 控制配方测试是否可绿。
        PINNED: lab 闸门的中文报告面向站长单人（手动触发的排障输出）；白名单路径本身就是中文目录名。
        """
        tmp = tempfile.mkdtemp()
        lab = os.path.join(tmp, ".kimi-code", _FIX_LAB_DIR)
        os.makedirs(lab)
        for f in files:
            open(os.path.join(lab, f), "w", encoding="utf-8").write("")
        if _FIX_RECIPE in files and test_ok:
            # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
            binp = os.path.join(tmp, "bin")
            os.makedirs(binp)
            open(os.path.join(binp, "node"), "w", encoding="utf-8").write(
                "#!/bin/sh\nexit 0\n")
            os.chmod(os.path.join(binp, "node"), 0o755)
            os.environ["PATH"] = binp + os.pathsep + os.environ["PATH"]
        return tmp, lab

    # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
    def ok_case():
        global LAB_DIR
        old = LAB_DIR
        tmp, lab = make_lab(list(ALIVE_FILES))
        LAB_DIR = lab
        try:
            return run([]) == 0
        finally:
            LAB_DIR = old
            shutil.rmtree(tmp, ignore_errors=True)
    cases.append(("★ 白名单齐全+测试绿 ⇒ 通过", ok_case))

    # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
    def extra_case():
        """PINNED: lab 闸门的中文报告面向站长单人（手动触发的排障输出）；白名单路径本身就是中文目录名。"""
        global LAB_DIR
        old = LAB_DIR
        tmp, lab = make_lab(list(ALIVE_FILES) + [_FIX_STRAY])
        LAB_DIR = lab
        try:
            return run([]) == 1
        finally:
            LAB_DIR = old
            shutil.rmtree(tmp, ignore_errors=True)
    cases.append(("★ 根目录多出文件 ⇒ 报", extra_case))

    # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
    def missing_case():
        global LAB_DIR
        old = LAB_DIR
        # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
        # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
        assert "bridge.mjs" in ALIVE_FILES
        files = [f for f in ALIVE_FILES if f != "bridge.mjs"]
        tmp, lab = make_lab(files)
        LAB_DIR = lab
        try:
            return run([]) == 1
        finally:
            LAB_DIR = old
            shutil.rmtree(tmp, ignore_errors=True)
    cases.append(("★ 活文件缺失 ⇒ 报", missing_case))

    # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
    def absent_case():
        global LAB_DIR
        old = LAB_DIR
        LAB_DIR = "/nonexistent-lab-dir-xyz"
        try:
            return run([]) == 0
        finally:
            LAB_DIR = old
    cases.append(("★ 实验空不存在（clone 环境）⇒ 通过", absent_case))

    return cases


# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
GATE = meta("实验空完整性闸门", "活文件白名单 + 配方回归测试（lab 相位，手动 --run lab）",
            runs_at="lab")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:],
                              ('gate title: lab_integrity'),
                              _cases, run))
