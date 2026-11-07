#!/usr/bin/env python3
"""闸门自证 harness：**发现式**跑每个闸门，先证明它会红。

## 为什么是 Python 而不是 shell

此前这是 `gates-selftest.sh`（287 行 shell）。它做的是**纯编排**：遍历清单、
跑子进程、判 rc、判机器摘要行。三件事 Python 都更自然，而且——

**shell 版整份绕过了本仓的零语言制度**：它 `echo` 的 38 处中文是硬编码字面量，
`check_i18n` 是 AST 扫描器、只认 `.py`，看不见它。于是「未装语言包却输出中文」
在那个文件里长期存在且无人拦（review 抓到：`REFLECT_LANG` 未设时它照样打中文）。

搬到 Python 之后，它的全部文案走 `M()`，与其它闸门同一条制度。**同时消灭了几乎
全部 shell 词汇表拷贝** —— 只剩 `einfacht-env.sh` 一个（它必须是 shell），
而它的摘要行形状由 `run_plugins()` 实跑检查。

## 为什么是「发现」而不是「清单」

手写名录一定会漂。加新检查器时忘了登记，那个检查器就变成「没人盯着的检查器」
—— 而名录本身还绿着告诉你一切正常。所以这里反过来：**登记是被发现的**，
不是被记得的（清单一律从 `registry` 的声明行派生）。

## 四段职责（原 shell 版一一对应）

    gates        发现式跑每个闸门 → 必须能红 + 必须打机器摘要行
    plugins      可拔插件（reflect-hooks/*.sh 里带自证标记的 + 点名特殊件）
    modules      平台模块的自证（差集：闸门的自证已在 gates 段跑过）
    configurable 跨仓可配置性（换名夹具全绿 + 默认名下指定的闸门必须红）

## 诚实边界

  · 插件段跑的是**用户的** `.sh` —— 它们的输出不受零语言制度约束（用户自制
    脚本随他去）；这里只管它们的 rc 与机器摘要行。
  · `configurable` 段造临时夹具仓，跑真闸门；它验的是「名字没被写死」，
    不是「闸门逻辑对」（那是各闸门自证的事）。
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from i18n import M  # noqa: E402

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 机器摘要行：判据在 `machine.is_summary()`（唯一产地）。
# 此前这里有一份字节相同的正则 —— 三份会漂（另有 reflect-hooks/gate.py 一份）。

# 自证广告标记：有它 = 这个文件声称自己能被 `--selftest` 证明。
ADVERT = re.compile(r"(main_selftest_or|--selftest)")


def _run(argv, cwd=None, env=None):
    """跑一条命令，返回 `(rc, 合并输出)`。rc 用**真实返回码**，不走管道。"""
    try:
        p = subprocess.run(argv, cwd=cwd, capture_output=True, text=True,
                           env=env, timeout=600,
                           encoding="utf-8", errors="replace")
    except (OSError, subprocess.SubprocessError) as e:
        return 127, "harness: %r" % (e,)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def _tail(text, n=3):
    """失败时要转述的行：**优先** `fail |` / `FATAL:` 行，抓不到才用最后 n 行。

    ⚠️ 此前一律取最后 3 行 —— 而自证的布局是「fail 行在前、摘要行在后」，
    于是转述出来的永远是「=== 28 PASS / 1 FAIL ===」这种**摘要**，看不到是哪
    一条用例红的。实测：CI 的 Windows 腿只报 `28 PASS / 1 FAIL`，
    没有任何办法知道是哪一条 —— 只能整段重跑。
    """
    all_lines = [ln for ln in (text or "").splitlines() if ln.strip()]
    notable = [ln for ln in all_lines
               if ln.lstrip().startswith(("fail |", "FATAL:"))]
    if notable:
        return notable[:n]
    return all_lines[-n:]


def _has_summary(text):
    import machine  # noqa: PLC0415
    return any(machine.is_summary(ln) for ln in (text or "").splitlines())


def _derive_listing(repo):
    """从 `registry --all-runnable` 派生闸门清单（发现式，不写名录）。"""
    _rc, out = _run([sys.executable,
                     os.path.join(repo, "zreflect", "registry.py"),
                     "--all-runnable"], cwd=repo)
    return [ln.strip() for ln in (out or "").splitlines() if ln.strip()]


def _check_one_gate(repo, rel):
    """跑一道闸门的自证。返回 `(通过?, 输出行列表)`。"""
    g = os.path.join(repo, rel)
    if not os.path.isfile(g):
        return False, [str(M("harness.missing_file", file=rel))]
    try:
        text = open(g, encoding="utf-8", errors="replace").read()
    except OSError:
        text = ""
    if not ADVERT.search(text):
        return False, [str(M("harness.no_selftest_entry", file=rel))]
    env = dict(os.environ)
    env["GATE_REPO"] = repo
    rc, out = _run([sys.executable, g, "--selftest"], cwd=repo, env=env)
    if rc != 0:
        return False, ([str(M("harness.selftest_failed", file=rel))]
                       + ["      " + ln for ln in _tail(out)])
    if not _has_summary(out):
        return False, [str(M("harness.no_machine_summary", file=rel))]
    last = _tail(out, 1)
    return True, [str(M("harness.gate_ok", file=rel,
                        summary=last[0] if last else ""))]


def run_gates(repo, listing=None):
    """跑一组闸门的自证。返回 `(ok, n, bad, lines)`。

    `listing` 可注入（自证用假清单，不依赖真仓）；None ⇒ 从 `registry` 派生。
    """
    listing = _derive_listing(repo) if listing is None else listing
    n = bad = 0
    lines = []
    for rel in listing:
        passed, out = _check_one_gate(repo, rel)
        lines += out
        n += 1
        if not passed:
            bad += 1
    if n == 0:
        # 零值守卫：一个闸门都没发现 ⇒ 不通过（空输入不是通过）。
        lines.append(str(M("harness.no_gates_found")))
        return False, n, bad + 1, lines
    if bad:
        lines.append(str(M("harness.some_failed", count=n, bad=bad)))
        return False, n, bad, lines
    lines.append(str(M("harness.all_can_red", count=n)))
    return True, n, bad, lines


def run_plugins(repo):
    """可拔插件 + 点名特殊件（名单从 registry 派生）。返回 `(ok, lines)`。"""
    _rc, out = _run([sys.executable, os.path.join(repo, "zreflect", "registry.py"),
                     "--plugins"], cwd=repo)
    names = [ln.strip() for ln in (out or "").splitlines() if ln.strip()]
    lines = []
    bad = 0
    for p in names:
        ok, out_lines = _one_plugin(repo, p)
        lines += out_lines
        bad += 0 if ok else 1
    if not names:
        lines.append(str(M("harness.no_plugins")))
        return False, lines
    return bad == 0, lines


def _one_plugin(repo, p):
    """跑一个插件的自证，返回 `(通过?, 输出行)`。四种失败各是一档。"""
    f = os.path.join(repo, p)
    if not os.path.isfile(f):
        return False, [str(M("harness.missing_file", file=p))]
    cmd = ["sh", f, "--selftest"] if p.endswith(".sh") else \
          [sys.executable, f, "--selftest"]
    rc, out = _run(cmd, cwd=repo)
    if rc != 0:
        return False, ([str(M("harness.selftest_failed", file=p))]
                       + ["      " + ln for ln in _tail(out)])
    if not _has_summary(out):
        return False, [str(M("harness.no_machine_summary", file=p))]
    last = _tail(out, 1)
    return True, [str(M("harness.gate_ok", file=p,
                        summary=last[0] if last else ""))]


def run_modules(repo):
    """平台模块的自证（差集：闸门的自证已在 `run_gates` 跑过）。"""
    _rc, out = _run([sys.executable, os.path.join(repo, "zreflect", "registry.py"),
                     "--selftest-modules"], cwd=repo)
    mods = [ln.strip() for ln in (out or "").splitlines() if ln.strip()]
    _rc, gout = _run([sys.executable, os.path.join(repo, "zreflect", "registry.py"),
                      "--all-runnable"], cwd=repo)
    gates = {ln.strip() for ln in (gout or "").splitlines() if ln.strip()}
    lines = []
    n = bad = 0
    for m in mods:
        if m in gates:
            continue                      # 闸门的自证归 gates 段
        n += 1
        f = os.path.join(repo, m)
        rc, out = _run([sys.executable, f, "--selftest"], cwd=repo)
        if rc != 0:
            lines.append(str(M("harness.selftest_failed", file=m)))
            for ln in _tail(out):
                lines.append("      " + ln)
            bad += 1
            continue
        if not _has_summary(out):
            lines.append(str(M("harness.no_machine_summary", file=m)))
            bad += 1
            continue
        last = _tail(out, 1)
        lines.append(str(M("harness.gate_ok", file=m,
                           summary=last[0] if last else "")))
    if n == 0:
        lines.append(str(M("harness.no_modules_found")))
        return False, lines
    return bad == 0, lines


def run_configurable(repo):
    """跨仓可配置性：夹具仓换掉全部名字仍全绿；默认名下指定的闸门必须红。"""
    import registry  # noqa: PLC0415
    tmp = tempfile.mkdtemp()
    try:
        return _configurable_impl(repo, tmp, registry)
    finally:
        shutil.rmtree(tmp, True)


def _configurable_fixture(repo, tmp, registry):
    """造一个**合格的外仓**：三段文档齐、改名后的载体都在。

    返回 `(env, gates)` —— `env` 是带改名旋钮的环境，`gates` 是待跑清单。
    """
    fr = getattr(registry, "FIXTURE_RENAMES", {})
    fx_facts = fr.get("FACTS.json", "LEDGER.json")
    fx_doc = fr.get("STATE.md", "NOTES.md")

    open(os.path.join(tmp, "a.py"), "w", encoding="utf-8").write("x = 1\n")
    # 机器块标记要**先手工放一次**（找不到块 ≠ 块是对的）。
    open(os.path.join(tmp, fx_doc), "w", encoding="utf-8").write(
        "# T\n\nrefs [[py_files]] [[md_files]].\n\n"
        "<!-- AUTO:FACTS -->\n<!-- /AUTO:FACTS -->\n"
        "<!-- AUTO:GATES -->\n<!-- /AUTO:GATES -->\n")
    open(os.path.join(tmp, "AGENTS.md"), "w", encoding="utf-8").write(
        "# AGENTS\n\nsee `zreflect/doc.py` (`doc.RULES`); state: `%s`.\n\n"
        "```bash\npython3 zreflect/registry.py --run commit\n```\n" % fx_doc)
    open(os.path.join(tmp, "RETRACT.json"), "w", encoding="utf-8").write('{"schema":1,"retractions":[]}\n')
    os.makedirs(os.path.join(tmp, "cases"), exist_ok=True)
    open(os.path.join(tmp, "cases", "02-y.md"), "w", encoding="utf-8").write(
        "# e2\n\n**Status:** ready-for-agent\n\n**Settling:** `python3 a.py` —— rc=0 A; rc=7 B\n")
    for f in ("R1", "R2", "R3"):
        open(os.path.join(tmp, f + ".md"), "w", encoding="utf-8").write(
            "# %s\n\n[R1](R1.md) [R2](R2.md) [R3](R3.md)\n" % f)

    env = dict(os.environ)
    env["GATE_REPO"] = tmp
    env.update({"REFLECT_FACTS": fx_facts, "REFLECT_DOC": fx_doc})
    _run([sys.executable, os.path.join(repo, "zreflect", "facts.py")], cwd=repo, env=env)
    _run([sys.executable, os.path.join(repo, "zreflect", "facts.py"),
          "--render-doc", fx_doc], cwd=repo, env=env)

    _rc, out = _run([sys.executable, os.path.join(repo, "zreflect", "registry.py"),
                     "--all-runnable"], cwd=repo)
    gates = [ln.strip() for ln in (out or "").splitlines() if ln.strip()]
    env.update({"REFLECT_DOCS": "%s,AGENTS.md" % fx_doc,
                "REFLECT_RETRACTIONS": "RETRACT.json",
                "REFLECT_QUESTIONS": "cases",
                "REFLECT_READMES": "R1.md,R2.md,R3.md"})
    return env, gates


def _renamed_all_green(repo, gates, env):
    """换名之后，**每一道**闸门都必须绿。返回 `(ok, 失败清单)`。"""
    bad = []
    for rel in gates:
        rc, _o = _run([sys.executable, os.path.join(repo, rel)], cwd=repo, env=env)
        if rc != 0:
            bad.append(rel)
    return len(gates) - len(bad), bad


def _default_names_go_red(repo, gates, tmp):
    """默认名字下，`--red-need` 点名的闸门**必须红**。返回 `(ok, 未红的)`。

    ⚠️ 环境必须**干净**：只给 `GATE_REPO`，不给任何改名旋钮 —— 用夹具那套
    `env` 等于还在用改名，这条判据永远不成立（实测）。
    """
    clean = {k: v for k, v in os.environ.items() if not k.startswith("REFLECT_")}
    clean["GATE_REPO"] = tmp
    red = set()
    for rel in gates:
        rc, _o = _run([sys.executable, os.path.join(repo, rel)], cwd=repo,
                      env=clean)
        if rc != 0:
            red.add(os.path.basename(rel))
    _rc, rout = _run([sys.executable, os.path.join(repo, "zreflect", "registry.py"),
                      "--red-need"], cwd=repo)
    # ⚠️ `--red-need` 的输出是**一行、空格分隔**的多个名字（不是一个一行）。
    # 按行切会把整串当成一个名字，于是「它没红」永远命中（实测）。
    red_need = (rout or "").split()
    return red_need, [b for b in red_need if b not in red]


def _configurable_impl(repo, tmp, registry):
    """跨仓可配置性：夹具仓换掉全部名字仍全绿；默认名下指定的闸门必须红。

    三段（各是 helper）：`_configurable_fixture` / `_renamed_all_green` /
    `_default_names_go_red`。本函数只编排 —— 85 行 → 20 行。
    """
    env, gates = _configurable_fixture(repo, tmp, registry)
    lines = []
    if not gates:
        lines.append(str(M("harness.no_gates_in_fixture")))
        return False, lines

    ok, bad = _renamed_all_green(repo, gates, env)
    for rel in bad:
        lines.append(str(M("harness.rename_failed", file=rel)))

    red_need, not_red = _default_names_go_red(repo, gates, tmp)
    if not red_need:
        lines.append(str(M("harness.empty_red_list")))
        return False, lines
    for b in not_red:
        lines.append(str(M("harness.not_red_under_defaults", gate=b)))
        return False, lines

    if ok != len(gates):
        lines.append(str(M("harness.configurable_failed",
                           ok=ok, total=len(gates))))
        return False, lines
    lines.append(str(M("harness.configurable_ok",
                       ok=ok, total=len(gates),
                       red=", ".join(red_need))))
    return True, lines


# 端到端零语言的探针：这些入口**都会产出用户可见文本**。
# 未装语言包时它们必须只输出 code —— 一个中文字符都不许有。
# ⚠️ 探针只选**不把用户数据填进输出**的入口。
#
# `zreflect/next.py` 不能当探针：它会列出未推送提交的**标题** —— 提交标题是
# 作者写的自然语言（中文），那是**用户数据**，作为 `%(count)s` 之外的参数值
# 原样输出。零语言制度管的是**模板**（`M()` 的话术），不是数据。
# 把它当探针会让「刚用中文写了提交信息」变成假红（实测：这条正是被自己的
# 提交标题打红的）。
#
# 它的模板由 `check_i18n` 的 `null_pack_output_has_no_cjk` 覆盖（那条**只喂
# 固定参数**，不碰 git 状态）—— 所以它没有离开判据面，只是换了正确的测法。
ZERO_LANG_PROBES: tuple = (
    ("zreflect/gate.py", []),
    # ⚠️ 探针清掉全部 `REFLECT_*`（判的就是「没要语言包」那条路径），所以
    # 只能选**既不吃配置、也不产 PINNED 文本**的入口。两处实测教训：
    #
    #   · `facts.py --check` —— 依赖 `REFLECT_DOCS`/`REFLECT_DOC` 决定查哪几份
    #     文档。清空后它用默认名单，与本仓实际配置不符 ⇒ 恒红，
    #     而那是一条与语言毫无关系的红灯。
    #   · `facts.py --render` —— 输出的 `PREAMBLE` 是**固定中文**（`PINNED:`：
    #     机器块要逐字节对账，跟随语言会让 `--check` 永不收敛）⇒ 恒报 CJK 泄漏。
    #
    # `registry --red-need` 是纯文件名清单：零配置依赖、零自然语言。
    ("zreflect/registry.py", ["--red-need"]),
    ("zreflect/knobs.py", ["--list"]),
)


def run_zero_language(repo):
    """**端到端**零语言：不装语言包跑真实入口，断言输出零中文。

    为什么这条必须在 harness 里而不是 `check_i18n` 里：`check_i18n` 是
    **静态** AST 扫描（源码里的裸中文字面量）。它看不见「运行时拼出来的中文」，
    也看不见 shell 脚本。实测那次事故正是这个形状：源码干净、注入吐全中文
    （`inject_state` 自动挑了 zh 包）。静态判据永远抓不到它。

    这条是**行为**判据：真跑、真看输出。

    ⚠️ 环境里**必须**没有 `REFLECT_LANG` —— 判的就是「没要语言包」那条路径。
    """
    import i18n  # noqa: PLC0415
    lines = []
    bad = 0
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("REFLECT_")}
    env["GATE_REPO"] = repo
    for rel, extra in ZERO_LANG_PROBES:
        path = os.path.join(repo, rel)
        if not os.path.isfile(path):
            lines.append(str(M("harness.missing_file", file=rel)))
            bad += 1
            continue
        rc, out = _run([sys.executable, path] + extra, cwd=repo, env=env)
        if rc != 0:
            lines.append(str(M("harness.zero_lang_rc", file=rel, rc=rc)))
            bad += 1
            continue
        cjk_lines = [ln for ln in (out or "").splitlines() if i18n.han(ln)]
        if cjk_lines:
            lines.append(str(M("harness.zero_lang_leak",
                               file=rel, count=len(cjk_lines),
                               sample=cjk_lines[0][:60])))
            bad += 1
            continue
        lines.append(str(M("harness.zero_lang_ok", file=rel)))
    if not ZERO_LANG_PROBES:
        lines.append(str(M("harness.no_probes")))
        return False, lines
    return bad == 0, lines


def _section(heading, runner):
    """跑一段、打印、返回该段的 rc（0 = 通过）。main 的循环体曾重复五次。"""
    print(str(M(heading)))
    ok, *_, lines = runner()
    for ln in lines:
        print(ln)
    return 0 if ok else 1


def main(argv):
    repo = HERE
    if "--selftest" in argv:
        return _selftest()
    rc = _section("harness.heading", lambda: run_gates(repo))
    rc = rc or _section("harness.plugins_heading",
                        lambda: run_plugins(repo))
    rc = rc or _section("harness.modules_heading",
                        lambda: run_modules(repo))
    rc = rc or _section("harness.configurable_heading",
                        lambda: run_configurable(repo))
    # 最后一段：**端到端零语言**（未装包时必须零中文）。
    return rc or _section("harness.zero_lang_heading",
                          lambda: run_zero_language(repo))


# ── 自证 ──────────────────────────────────────────────────────────────────────

def _fixture(files, listing=None):
    """造一个夹具仓，跑 `run_gates`。返回 (ok, n, bad, lines)。"""
    d = tempfile.mkdtemp()
    try:
        for rel, body in files.items():
            p = os.path.join(d, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, "w", encoding="utf-8").write(body)
        return run_gates(d, listing=listing)
    finally:
        shutil.rmtree(d, True)


GOOD_GATE = '''import sys
print("=== %d PASS / 0 FAIL ===")
sys.exit(0 if "--selftest" in sys.argv else 0)
'''


def _cases():
    return [
        # ① 正常不报：广告了 --selftest、打摘要行、rc=0
        ("harness.good_gate_is_green",
         lambda: _fixture({"zreflect/check_ok.py": GOOD_GATE % 3,
                           }, listing=["zreflect/check_ok.py"])[0]),
        # ② 该报的必须报
        ("★ harness.gate_without_selftest_entry_is_red",
         lambda: not _fixture({"zreflect/check_silent.py": "import sys\nsys.exit(0)\n"},
                              listing=["zreflect/check_silent.py"])[0]),
        ("★ harness.gate_that_cannot_go_red_is_red",
         lambda: not _fixture(
             {"zreflect/check_bad.py":
              'import sys\nprint("=== 1 PASS / 1 FAIL ===")\n'
              'sys.exit(1 if "--selftest" in sys.argv else 0)\n'},
             listing=["zreflect/check_bad.py"])[0]),
        ("★ harness.gate_without_summary_is_red",
         lambda: not _fixture(
             {"zreflect/check_nosummary.py": 'import sys\nsys.exit(0)\n'},
             listing=["zreflect/check_nosummary.py"])[0]),
        ("★ harness.missing_file_is_red",
         lambda: not _fixture({}, listing=["zreflect/check_gone.py"])[0]),
        # ③ 空输入必须报 —— 零值守卫
        ("★ harness.no_gates_at_all_is_red",
         lambda: not _fixture({}, listing=[])[0]),
        # 摘要行判据本身有牙（判据在 machine.is_summary）
        ("★ harness.summary_shape_can_red", lambda: _summary_shape_ok()),
    ]


def _summary_shape_ok():
    import machine  # noqa: PLC0415
    return machine.is_summary("=== 3 PASS / 0 FAIL ===") and \
        not machine.is_summary("=== 3 PASS / 0 fail ===")


def _selftest():
    from gate import selftest  # noqa: PLC0415
    return selftest(M("gate.title.harness"), _cases())


from gate import module_meta  # noqa: E402

MODULE = module_meta(
    "闸门自证 harness",
    "发现式跑每个闸门的 --selftest（必须能红 + 必须打机器摘要行）+ 插件 + 平台模块 + 跨仓可配置性",
    selftest=True)

if __name__ == "__main__":
    from gate import activate_or_fatal  # noqa: PLC0415
    rc = activate_or_fatal()
    sys.exit(rc or main(sys.argv[1:]))
