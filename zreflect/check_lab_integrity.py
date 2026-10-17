#!/usr/bin/env python3
"""实验空完整性闸门（lab 相位，手动触发）——Einfacht 对 .zcode/学习通API/ 的管辖权。

管辖对象是**不入库的活代码**（.zcode/ 只落盘），所以：
  · 不进 FACTS.json（事实=入库内容的不变量不动；clone 后无 .zcode/ 不掉条）；
  · 不挂 pre-commit（.zcode/ 改动不产生 commit，挂了形同虚设）；
  · runs_at="lab"：`python3 zreflect/registry.py --run lab` 手动触发
    （悬案 questions/02 的 Settling 就是这条命令）。

挡的事故（2026-10-16 三件套重构立的约）：
  ① 实验空根目录活文件清单漂移——新脚本随手落根目录，49 文件平铺的绊脚石复活；
  ② 破甲配方退化——重构/改措辞把 G 系列结论（疑问式、3 工具上限、首条无清单、
     回喂带清单、caveman 保工具名）弄丢，配方.test.mjs 先红。

判据：
  · 根目录文件集合 ⊆ 白名单（活文件 9 个；多出的 ⇒ 报，说明有新文件要归档或入单）；
  · `node --test 配方.test.mjs` 全绿（cwd=实验空）；
  · 白名单里的文件必须存在（少 ⇒ 报，活文件被误删/误归档）。

零值守卫：实验空目录整个不存在 ⇒ 通过（clone 环境本来就没有 .zcode/），
但只要存在就按全量判。
"""

import os
import subprocess
import sys

from gate import meta, main_selftest_or

# 活文件白名单（2026-10-16 grilling Q4-A 定案；增删活文件 = 改这里 + 改悬案）
ALIVE_FILES = (
    "chaoxing.mjs",      # 传输 + parseToolCalls + askWithRetry
    "配方.mjs",           # 破甲配方唯一真相源
    "配方.test.mjs",      # G 系列配方回归测试
    "对话.mjs",           # 无感入口（业务轮次）
    "bridge.mjs",        # 桥服务（SSE + HTTP 端点）
    "页面桥.js",          # 注入页面的桥接端
    "agent.md",          # 设计说明（指向 配方.mjs，不承载措辞）
    "README.md",         # 协议文档
)

LAB_DIR = os.path.join(".zcode", "学习通API")


def run(args):
    if not os.path.isdir(LAB_DIR):
        # clone 环境守卫：目录不存在不是事故（.zcode/ 不入库），绿着退场
        print("lab: .zcode/学习通API/ 不存在（clone 环境属预期）—— 通过")
        return 0
    problems = []

    actual = sorted(f for f in os.listdir(LAB_DIR)
                    if os.path.isfile(os.path.join(LAB_DIR, f)))
    extra = [f for f in actual if f not in ALIVE_FILES]
    missing = [f for f in ALIVE_FILES if f not in actual]
    if extra:
        problems.append("根目录多出未归档文件：%s（实验脚本进 实验/，新活文件先改 ALIVE_FILES）"
                        % ", ".join(extra))
    if missing:
        problems.append("活文件缺失：%s（被误删或误归档？）" % ", ".join(missing))

    # 配方回归测试（只在 配方.test.mjs 存在时跑；缺失已由上面报过）
    if "配方.test.mjs" in actual:
        r = subprocess.run(
            ["node", "--test", "配方.test.mjs"],
            cwd=LAB_DIR, capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            problems.append("配方回归测试未全绿：\n%s"
                            % (r.stdout + r.stderr)[-800:])

    if problems:
        print("lab 相位：发现 %d 个问题" % len(problems))
        for p in problems:
            print("  ✗ " + p)
        return 1
    print("lab 相位：活文件 %d 个齐全，配方测试全绿" % len(ALIVE_FILES))
    return 0


# ── 自证（三档硬规矩）─────────────────────────────────────────
def _cases():
    import tempfile, shutil
    cases = []

    def make_lab(files, test_ok=True):
        """搭临时实验空夹具：files=根目录文件集；test_ok 控制配方测试是否可绿。"""
        tmp = tempfile.mkdtemp()
        lab = os.path.join(tmp, ".zcode", "学习通API")
        os.makedirs(lab)
        for f in files:
            open(os.path.join(lab, f), "w").write("")
        if "配方.test.mjs" in files and test_ok:
            # 假 node：配方测试直接绿
            binp = os.path.join(tmp, "bin")
            os.makedirs(binp)
            open(os.path.join(binp, "node"), "w").write(
                "#!/bin/sh\nexit 0\n")
            os.chmod(os.path.join(binp, "node"), 0o755)
            os.environ["PATH"] = binp + os.pathsep + os.environ["PATH"]
        return tmp, lab

    # ① 阳性对照：白名单齐全 + 测试绿 ⇒ 不报
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

    # ② 反向：多出未归档文件 ⇒ 必须报
    def extra_case():
        global LAB_DIR
        old = LAB_DIR
        tmp, lab = make_lab(list(ALIVE_FILES) + ["随手丢的脚本.mjs"])
        LAB_DIR = lab
        try:
            return run([]) == 1
        finally:
            LAB_DIR = old
            shutil.rmtree(tmp, ignore_errors=True)
    cases.append(("★ 根目录多出文件 ⇒ 报", extra_case))

    # ② 反向：活文件缺失 ⇒ 必须报
    def missing_case():
        global LAB_DIR
        old = LAB_DIR
        files = [f for f in ALIVE_FILES if f != "配方.mjs"]
        tmp, lab = make_lab(files)
        LAB_DIR = lab
        try:
            return run([]) == 1
        finally:
            LAB_DIR = old
            shutil.rmtree(tmp, ignore_errors=True)
    cases.append(("★ 活文件缺失 ⇒ 报", missing_case))

    # ③ 零值守卫：目录不存在 ⇒ 绿（clone 环境预期）
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


GATE = meta("实验空完整性闸门", "活文件白名单 + 配方回归测试（lab 相位，手动 --run lab）",
            runs_at="lab")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:],
                              "check_lab_integrity（实验空活文件+配方测试）",
                              _cases, run))
