#!/usr/bin/env python3
"""静态机器检查闸门（**可插拔**）：ruff 的 C901/F/E9/B，判据在 `ruff.toml`。

## 它替换掉的是什么

`gitroll-dispositions.json` 的 `_summary` 曾写着：

    ruff --select=C901,F,E9,B --config lint.mccabe.max-complexity=15
    ⇒ All checks passed

**实测 159 errors**（134 F841 / 13 F401 / 4 C901）。原因不是扫描器变了，而是
那条命令**从来没有被任何闸门执行过** —— 它只是被人手工跑过一次，结论就写进了
台账。这正是本仓立身要消灭的形状：一句「已清」配一个没人复跑的命令。

更具体的代价（见 `retractions.json` R-004 / R-005）：

  · `facts.py --render-doc`（AGENTS.md 的首要命令之一）**直接崩**
    `UnboundLocalError` —— `ruff F823` 早就报过，没人跑 ruff。
  · 134 个 `F841` 是「解包 7 个变量只用 2 个」的机械残渣，全部来自上一轮
    「复杂度拆分」的重构。

## 为什么是 off 可以接受的

`ruff` 是**外部工具**，不是本仓依赖。没装它的仓不该因为这个闸门而红 ——
所以「ruff 不存在」时明说未启用（`OFF:`），执行面单列一档，不冒充通过。
但**装了就必须过**：CI 里 `pip install 'ruff==0.17.3'` 之后这个闸门会真跑。

## 诚实边界

  · 它跑的是 `ruff.toml` 里那一组**本仓选定的**规则（C901/F/E9/B）。全量
    ruff 默认规则集有 716 条 —— 绝大多数是风格项，本仓明确不接受那种打分游戏
    （见 `gitroll-dispositions.json` 的 `accepted_rules`）。
  · 它不解析 ruff 的输出做二次判断：rc 非 0 = 红，原样转述它的清单。
    任何「按规则名过滤」都会变成第二个会漂的产地。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gate  # noqa: E402
from gate import fatal, finish, main_selftest_or, meta, off  # noqa: E402
from i18n import M  # noqa: E402

CONFIG = "ruff.toml"


def suite_files(repo_root=None):
    """**套件自己的** `.py` 路径（`declares_itself()` 为真的那些）。

    ⚠️ 此前跑 `ruff check .` —— **整个仓**。接进真实项目时，使用方的
    `examples/` / `scripts/` 会被当本体来审：实测一个真项目接入后
    `registry --run commit` 报 **149 条** ruff，全部指向它自己的文件。
    用户既修不完，也不理解为什么别人的套件在挑他的代码。

    「套件代码」的判据是**声明**（`MODULE = …` / `GATE = …`），不是目录名 ——
    发现式，与 `registry.modules()` / `gates()` 同一口径。
    """
    root = repo_root or gate.GATE_REPO
    out = []
    for sub in ("zreflect", "reflect-hooks"):
        base = os.path.join(root, sub)
        if not os.path.isdir(base):
            continue
        for rel, _src in gate.py_sources(base):
            p = os.path.join(base, rel)
            if gate.declares_itself(p):
                out.append(os.path.join(sub, rel).replace(os.sep, "/"))
    return sorted(out)


def ruff_argv(files=None):
    """跑 ruff 的 argv（`sys.executable -m ruff`，跨平台且与 pip 装的那个一致）。

    `files` 给了就只查那些；不给 ⇒ **套件自己的文件**（不是整个仓）。
    """
    targets = list(files) if files is not None else suite_files()
    if not targets:
        return [sys.executable, "-m", "ruff", "check",
                "--output-format=concise", "."]
    return [sys.executable, "-m", "ruff", "check", "--output-format=concise",
            *targets]


def _has_located_finding(out):
    """ruff 的输出里有没有**定位行**（`path:line:col: CODE message`）。

    判据：至少一行同时含 `.py:` 与行号风格的冒号 —— 那才是「发现了问题」。
    没有定位行的非零退出是工具/配置事故。
    """
    return any(".py:" in ln or '.py"' in ln
               for ln in (out or "").splitlines())


def problems(out, rc):
    """纯函数：ruff 的输出 + rc → 问题清单（空 = 干净）。自证用。

    `rc` 非 0 但输出为空 ⇒ **必须报**（零值守卫）：那是「工具坏了」而
    「没有问题」无法区分的形状。
    """
    lines = [ln.strip() for ln in (out or "").splitlines() if ln.strip()]
    if rc == 0:
        return []
    real = [ln for ln in lines if ln.startswith(("zreflect/", "reflect-hooks/"))
            or ":" in ln and ".py:" in ln]
    if not real:
        return [M("lint.no_output", return_code=rc,
                  detail=(lines[-1][:120] if lines else ""))]
    return [M("lint.finding", text=ln[:160]) for ln in real]


def run(argv=None):
    """两条「明说未启用」，一条「真跑」。

    没有 `ruff.toml` ⇒ `off`（**不是** fatal）：那是「这个仓没选这套判据」的
    正常形态 —— 一个只有 `zreflect/` 被拷过去的外仓不该因为这个闸门而红。
    但配置存在而工具没装 ⇒ 也 `off`（外部工具，不是本仓依赖）；配置在、
    工具在、ruff 报错 ⇒ **fatal**（那是配置事故，不许静默）。
    """
    conf = os.path.join(gate.GATE_REPO, CONFIG)
    if not os.path.isfile(conf):
        return off(M("lint.off_config", path=CONFIG))
    if shutil.which("ruff") is None:
        rc, _out = subprocess_ruff_probe()
        if rc != 0:
            return off(M("lint.off", module="ruff"))
    try:
        p = subprocess.run(ruff_argv(), cwd=gate.GATE_REPO,
                           capture_output=True, text=True, timeout=300,
                           encoding="utf-8", errors="replace")
    except (OSError, subprocess.SubprocessError) as e:
        return fatal(M("lint.tool_broken", error=e))
    out = (p.stdout or "") + (p.stderr or "")
    if p.returncode != 0 and not _has_located_finding(out):
        # ⚠️ **没有定位行的非零退出 ≠ 判据红**：那是 ruff 自己起不来
        # （`ruff.toml` 语法坏 / 参数不认 / 版本不对）—— 配置事故，FATAL rc=2。
        # 此前一律走 `problems()` 变成 `lint.no_output` + rc=1，调用方会去
        # 修代码，而问题是判据文件本身。
        detail = [ln for ln in out.splitlines() if ln.strip()]
        return fatal(M("lint.config_broken", path=CONFIG,
                       detail=(detail[-1][:200] if detail else "")))
    probs = problems(out, p.returncode)
    return finish(M("lint.title"), probs, M("lint.ok", config=CONFIG))


def subprocess_ruff_probe():
    """`ruff` 不在 PATH 时，试试 `python -m ruff`（pip 装在解释器里的那种）。"""
    try:
        p = subprocess.run([sys.executable, "-m", "ruff", "--version"],
                           capture_output=True, text=True, timeout=60,
                           encoding="utf-8", errors="replace")
    except (OSError, subprocess.SubprocessError):
        return 1, ""
    return p.returncode, (p.stdout or "") + (p.stderr or "")


# ── 自证 ──────────────────────────────────────────────────────────────────────

def _cases():
    return [
        # ① 正常不报
        ("lint.clean_is_clean", lambda: problems("", 0) == []),
        # ② 该报的必须报
        ("★ lint.finding_is_reported",
         lambda: [p.code for p in problems(
             "zreflect/x.py:3:1: F841 Local variable `y` is unused", 1)]
         == ["lint.finding"]),
        # ③ 空输入必须报 —— rc≠0 却**没有任何定位行**（工具坏了 / 参数错）
        ("★ lint.silent_failure_is_loud",
         lambda: [p.code for p in problems("error: unrecognized argument", 2)]
         == ["lint.no_output"]),
        # 良性输出不被误报：rc=0 就是干净，哪怕有警告行（如 deprecated 提示）
        ("lint.warning_with_rc0_is_clean",
         lambda: problems("warning: config deprecated", 0) == []),
        # **配置事故与判据红必须可区分**（rc=2 vs rc=1）：
        # 有定位行 ⇒ 发现了问题；没有 ⇒ ruff 自己起不来（`ruff.toml` 语法坏）。
        ("\u2605 lint.located_finding_detected",
         lambda: _has_located_finding(
             "zreflect/x.py:3:1: F841 Local variable `y` is unused")),
        ("\u2605 lint.config_error_is_not_a_finding",
         lambda: not _has_located_finding(
             "key with no value, expected `=`")),
    ]


def _selftest():
    return main_selftest_or(sys.argv[1:], M("gate.title.lint"), _cases,
                            lambda a: 0)


def _activate_and_run():
    rc = gate.activate_or_fatal()
    return rc or run(sys.argv[1:])


GATE = meta("静态机器检查",
            "ruff 的 C901/F/E9/B，判据在 ruff.toml —— 「已清」必须由每次提交复跑，"
            "不是一次手工跑完写进台账（R-004）",
            off_reason="本机没装 ruff（外部工具，不是本仓依赖）⇒ 明说未启用；"
                       "CI 里 pip 装了它，那道会真跑")


if __name__ == "__main__":
    sys.exit(_selftest() if "--selftest" in sys.argv else _activate_and_run())
