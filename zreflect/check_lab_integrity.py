#!/usr/bin/env python3
"""实验空完整性闸门（lab 相位，手动触发）——Einfacht 对 .zcode/学习通API/ 与
.zcode/userscript/（2026-10-24 迁入的生产装配层）两处不入库活代码的管辖权。

管辖对象是**不入库的活代码**（.zcode/ 只落盘），所以：
  · 不进 FACTS.json（事实=入库内容的不变量不动；clone 后无 .zcode/ 不掉条）；
  · 不挂 pre-commit（.zcode/ 改动不产生 commit，挂了形同虚设）；
  · runs_at="lab"：`python3 zreflect/registry.py --run lab` 手动触发
    （悬案 questions/02 的 Settling 就是这条命令）。

挡的事故（2026-10-16 三件套重构立的约）：
  ① 实验空根目录活文件清单漂移——新脚本随手落根目录，49 文件平铺的绊脚石复活；
  ② 破甲配方退化——G 系列结论（疑问式、首条无清单、回喂带清单、caveman 保
     工具名）的设计史在 agent.md §三与 实验/G1-G21/结论.md（配方.mjs 及其
     测试已按 issue #18 决策 #11 删除，2026-10-24）。

判据：
  · 根目录文件集合 ⊆ 白名单（活文件 19 个；多出的 ⇒ 报，说明有新文件要归档或入单）；
  · 全部测试文件 `node --test` 全绿（cwd=实验空；154 项）；
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
    "chaoxing.mjs",      # 传输 + parseToolCalls + terminalKind/extractChunks + 类型化 status
    "chaoxing.test.mjs", # 传输层帧回放测试（终止表/正文抽取，20 项）
    "守卫.test.mjs",      # 结构守卫：薄适配器形态 + 明文禁词 + tools 传递（6 项，2026-10-22 入单）
    "会话.mjs",           # 多会话管理器（open/ask/close/rotate/snapshot）
    "会话.test.mjs",      # 管理器接口测试（20 项）
    "工具会话.mjs",        # 「模型 ⇄ 工具」闭环唯一实现（ask/invoke 双接缝，2026-10-19）
    "工具会话.test.mjs",   # 工具闭环接口测试（11 项）
    "判据.mjs",           # 全实验唯一判据表（judge/isPass/judgeChannel，2026-10-19）
    "判据.test.mjs",      # 判据回归（15 项）
    "bridge.test.mjs",    # 桥服务接口测试（鉴权/来源/体积/pending/chat，26 项）
    "聊天服务.mjs",        # 模型驱动层（emit 接缝，createChatService，2026-10-19）
    "聊天服务.test.mjs",   # emit 契约测试（14 项）
    "插件后端架构.md",     # 插件设计方案（MV3 三层 + Firefox 兼容矩阵）
    "上下文.mjs",         # 单会话转录 + 压缩 + 重放（2026-10-18 用户定案）
    "上下文.test.mjs",    # 压缩保真回归（18 项）
    "对话.mjs",           # 无感入口（业务轮次，接工具会话）
    "bridge.mjs",        # 桥服务（SSE + HTTP 端点 + 鉴权 + 效果回执透传）
    "agent.md",          # 设计说明（指向 配方.mjs，不承载措辞）
    "README.md",         # 协议文档
)

LAB_DIR = os.path.join(".zcode", "学习通API")

# userscript 装配层（2026-10-24 迁入仓库目录、不入 git）：生产唯一路径
# （油猴 iframe 通道）的全部源码。此前零测试闸门——生产验收「发得太快了」
# （sid 假 seam，handoff §0.123）就是这条链没守卫的直接代价。活文件清点 +
# 回归测试两件事与 学习通API 同款。proto/ 与旧世代归档同待遇（不管内容）。
US_DIR = os.path.join(".zcode", "userscript")
US_ALIVE = (
    "build-user-script.mjs",   # 装配构建（产物自检：零禁词/语法/必需词）
    "secrets.json",            # 两环密钥材料（.zcode 不入 git，密钥规约不变）
    "dist.user.js",            # 安装产物（构建输出）
    "cipher/README.md",         # 密文链设计说明（单向锁模型）
    "cipher/cipher.mjs",       # 两环密文（AES-GCM，fail-closed）
    "cipher/cipher.test.mjs",
    "channel/channel.mjs",     # 六消息 iframe 通道
    "channel/channel.test.mjs",
    "assembly/chat-panel-hook.md",  # 面板 setTransport 契约（2026-10-20）
    "assembly/roleA.mjs",      # 课程页侧薄桥（含 sessionId 透传，§0.123 修复）
    "assembly/roleA.test.mjs",
    "assembly/roleB.mjs",      # 上游 iframe 侧（工具循环 + 速率闸）
    "assembly/roleB.test.mjs",
)
# 回归测试跑这四个（node --test，cwd=US_DIR）
US_TESTS = ("cipher/cipher.test.mjs", "channel/channel.test.mjs",
            "assembly/roleA.test.mjs", "assembly/roleB.test.mjs")


def check_us(problems):
    """userscript 装配层的清点 + 回归测试。目录整体不存在 = clone 环境，绿着退场。"""
    if not os.path.isdir(US_DIR):
        return
    runtim = {".bridge-token"}
    root = set()
    sub = {"cipher": set(), "channel": set(), "assembly": set()}
    for dirpath, dirnames, filenames in os.walk(US_DIR):
        rel = os.path.relpath(dirpath, US_DIR)
        for f in filenames:
            fp = os.path.join(rel, f) if rel != "." else f
            if fp in runtim or fp.startswith("proto/") or fp.startswith("归档"):
                continue
            if "/" in fp:
                d, name = fp.split("/", 1)
                if d in sub:
                    sub[d].add(name)
            else:
                root.add(f)
    for fp in US_ALIVE:
        if "/" in fp:
            d, name = fp.split("/", 1)
            actual = sub.get(d, set())
        else:
            d, name = None, fp
            actual = root
        if name not in actual:
            problems.append("userscript 活文件缺失：%s（迁址/误删？先改 US_ALIVE）" % fp)
    for d, names in sub.items():
        extra = [n for n in names if "%s/%s" % (d, n) not in US_ALIVE]
        if extra:
            problems.append("userscript/%s 多出未登记文件：%s（新源文件先改 US_ALIVE）" % (d, ", ".join(sorted(extra))))
    import subprocess
    r = subprocess.run(["node", "--test", *US_TESTS], cwd=US_DIR,
                       capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        problems.append("userscript 回归测试未全绿：\n%s" % (r.stdout + r.stderr)[-600:])


def run(args):
    if not os.path.isdir(LAB_DIR):
        # clone 环境守卫：目录不存在不是事故（.zcode/ 不入库），绿着退场
        print("lab: .zcode/学习通API/ 不存在（clone 环境属预期）—— 通过")
        return 0
    problems = []

    # 运行时产物不算活文件（2026-10-19）：.bridge-token 是桥启动时生成的凭据，
    # 每次重启/删除都会变，不是代码。
    RUNTIME_ARTIFACTS = {".bridge-token"}
    actual = sorted(f for f in os.listdir(LAB_DIR)
                    if os.path.isfile(os.path.join(LAB_DIR, f)) and f not in RUNTIME_ARTIFACTS)
    extra = [f for f in actual if f not in ALIVE_FILES]
    missing = [f for f in ALIVE_FILES if f not in actual]
    if extra:
        problems.append("根目录多出未归档文件：%s（实验脚本进 实验/，新活文件先改 ALIVE_FILES）"
                        % ", ".join(extra))
    if missing:
        problems.append("活文件缺失：%s（被误删或误归档？）" % ", ".join(missing))

    # 回归测试（2026-10-24 修：入口条件原是「配方.test.mjs 存在」——配方删除后
    # 恒假，整块静默短路，闸门只查文件清单不查测试。改为「有任何活测试文件」；
    # 全部缺失已由上面的 活文件缺失 报过。）
    # 2026-10-19：扩到全部测试文件——判据/工具会话是实验的判据与执行核心。
    tests = [t for t in ("上下文.test.mjs", "会话.test.mjs",
                         "chaoxing.test.mjs", "工具会话.test.mjs", "判据.test.mjs",
                         "bridge.test.mjs", "聊天服务.test.mjs")
             if t in actual]
    if tests:
        r = subprocess.run(
            ["node", "--test", *tests],
            cwd=LAB_DIR, capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            problems.append("回归测试未全绿：\n%s"
                            % (r.stdout + r.stderr)[-800:])

    # 第二辖区：userscript 装配层（目录缺失 = clone 环境，内部自行绿退场）
    check_us(problems)

    if problems:
        print("lab 相位：发现 %d 个问题" % len(problems))
        for p in problems:
            print("  ✗ " + p)
        return 1
    print("lab 相位：活文件 %d 个齐全，回归测试全绿" % len(ALIVE_FILES))
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
        # 2026-10-24：缺失样本从 配方.mjs（已删）换成 bridge.mjs——
        # 样本必须是清单里真实存在的文件，否则用例恒不触发。
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
