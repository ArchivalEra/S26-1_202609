#!/usr/bin/env python3
"""闸门入口：**给别人的钩子体系调用**，不抢占钩子位置。

## 为什么是「暴露一个入口」而不是 `git config core.hooksPath`

`core.hooksPath` 是 git 的**全局覆盖开关** —— 一旦设上，git 就**完全不再看**
`.git/hooks/`。实测：设了之后 `.git/hooks/pre-commit` 里的脚本一次都不跑，
提交照样成功、没有任何提示。于是 husky / lefthook / pre-commit(Python) /
手写钩子全被**静默废掉** —— 正是本仓立身要消灭的「部署了 ≠ 在跑」。

所以本仓只**暴露一张口**：任何钩子体系在自己的钩子里调这一行即可。钩子位置、
顺序、其它工具，全归你自己 —— 我们只提供判据，不抢座位。

    用法（任何钩子脚本里）：
        python3 <repo>/reflect-hooks/gate.py commit "$(git rev-parse --show-toplevel)"
        python3 <repo>/reflect-hooks/gate.py push   "$(git rev-parse --show-toplevel)"

    commit  重渲染机器块（并 `git add`）+ 跑 runs_at="commit" 的全部闸门
    push    只校验不修改：机器块必须新鲜 + 全部闸门 + 三语 README 同批

    退出码：0 = 绿；1 = 判据红（拒）；2 = 环境/配置坏。

## 为什么用 Python 而不是 sh

此前这是 `einfacht-gate.sh`（155 行 shell，26 处 `echo` 中文）。三个病：

  1. **它绕过了零语言制度**：`check_i18n` 是 AST 扫描器（只认 `.py`），看不见
     shell ⇒「未装语言包却输出中文」在这里长期存在且无人拦。
  2. 跨平台：Windows 上 `sh` 不一定在，`$(...)` / `[ -f ]` 也各有各的方言。
  3. pre-push 的 ref 协议是**文本解析** —— Python 写它比 shell 清楚得多。

## 旧装法仍然可用

`core.hooksPath reflect-hooks` 的老用户调的是目录里的 `pre-commit` / `pre-push`，
它们是本入口的薄壳（仍然在），只升级不破坏。
"""
from __future__ import annotations

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL_REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(TOOL_REPO, "zreflect"))

from gate import activate_or_fatal, meta  # noqa: E402
from i18n import M  # noqa: E402

ZERO_SHA = "0" * 40
PHASES = ("commit", "push")


def _sh(cmd, stdin=None, env=None):
    """跑一条命令，返回 `(rc, 合并输出)`。"""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, input=stdin,
                           env=env,
                           encoding="utf-8", errors="replace")
    except (OSError, subprocess.SubprocessError) as e:
        return 127, "gate: %r" % (e,)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def _usage():
    print(str(M("hookgate.usage")), file=sys.stderr)
    return 0


def _load_env_plugin(tool_dir):
    """可拔插件（issue #8）：`einfacht-env.sh` 里 `export` 的旋钮。

    ⚠️ 这是**唯一**必须留 shell 的地方 —— shell 的 `export` 只能由 shell 做。
    我们用「跑一个 shell、把它的环境打出来」的方式把它搬进 Python 进程：
    插件本身仍然是一份 shell，但**它只做 export，不产任何文案**（无中文可漏）。
    """
    plugin = os.path.join(tool_dir, "einfacht-env.sh")
    if not os.path.isfile(plugin):
        return
    # ⚠️ 必须显式告诉插件**它自己在哪**：`sh -c '...' sh <plugin>` 里 `$0` 是
    # `sh`，插件用 `dirname $0` 推目录会推到 `/`，于是**钩子目录里的
    # Einfacht.env 被静默忽略**（实测：`env -0` 里一个 REFLECT_* 都没有）。
    env = dict(os.environ)
    env["EINFACHT_PLUGIN_DIR"] = tool_dir
    rc, out = _sh(["sh", "-c",
                   '. "$1" >/dev/null 2>&1; env -0', "sh", plugin], env=env)
    if rc != 0:
        return
    for chunk in out.split("\0"):
        if "=" not in chunk:
            continue
        k, v = chunk.split("=", 1)
        if k.startswith("REFLECT_"):
            os.environ[k] = v


def _refs_from_stdin():
    """git 的 pre-push ref 协议：每行 `<local ref> <local sha> <remote ref> <remote sha>`。"""
    try:
        raw = sys.stdin.read() if not sys.stdin.isatty() else ""
    except (OSError, ValueError):
        return []
    rows = []
    for ln in raw.splitlines():
        parts = ln.split()
        if len(parts) == 4:
            rows.append(tuple(parts))
    return rows


def _new_content_refs(repo, refs):
    """把 ref 协议行过滤成「这次真的要发布新内容的分支」，返回 `[(lref, revs)]`。"""
    out = []
    for lref, lsha, _rref, rsha in refs:
        if lref.startswith("refs/tags/"):
            continue                       # tag 不携带新内容
        if lsha == ZERO_SHA:
            continue                       # 删分支
        if rsha == ZERO_SHA:
            rc, revs = _sh(["git", "-C", repo, "rev-list", lsha,
                            "--not", "--remotes"])
            revs = revs.strip() if rc == 0 else ""
        else:
            rc, _o = _sh(["git", "-C", repo, "rev-list", "%s..%s" % (rsha, lsha)])
            revs = "%s..%s" % (rsha, lsha) if rc == 0 else lsha
        out.append((lref, revs.strip()))
    return out


def _push_readmes_together(repo, refs):
    """pre-push 第三条：这批推送必须把三语 README 同批更新。返回 (ok, lines)。"""
    import tempfile  # noqa: PLC0415
    lines = []
    refs_with_content = _new_content_refs(repo, refs)
    if not refs_with_content:
        lines.append(str(M("hookgate.push_nothing_to_check")))
        return True, lines
    checked = 0
    for lref, revs in refs_with_content:
        if not revs:
            lines.append(str(M("hookgate.ref_has_nothing", ref=lref)))
            checked += 1
            continue
        rc, log = _sh(["git", "-C", repo, "log", "--name-only",
                       "--pretty=format:", revs])
        changed = [ln for ln in (log or "").splitlines() if ln.strip()]
        fd, path = tempfile.mkstemp()
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write("\n".join(changed) + "\n")
            rc, out = _sh([sys.executable,
                           os.path.join(repo, "zreflect", "check_readme_sync.py"),
                           "--changed", path])
            if rc != 0:
                lines.append(str(M("hookgate.push_readmes_not_together",
                                   ref=lref)))
                lines.extend(ln for ln in (out or "").splitlines()[:5])
                return False, lines
        finally:
            os.unlink(path)
        checked += 1
    lines.append(str(M("hookgate.push_readmes_ok", count=checked)))
    return True, lines


def _prepare(phase, repo, doc):
    """① 相位的前置步。返回 `(是否应当拒绝)`。

    两个相位做**性质相反**的事，因此各是一个具名分支：

      · commit —— 重渲染机器块并 `git add`（**只渲染，不重测**；重测由人负责）
      · push   —— **不改文件、不动历史**：块不新鲜就直接拒
    """
    facts = os.path.join(repo, "zreflect", "facts.py")
    if phase == "commit":
        if os.path.isfile(os.path.join(repo, doc)):
            _sh([sys.executable, facts, "--render-doc", doc])
            _sh(["git", "-C", repo, "add", doc])
        return False
    rc, out = _sh([sys.executable, facts, "--check"])
    if rc == 0:
        return False
    print(str(M("hookgate.blocks_stale", detail=(out or "").strip()[:400])),
          file=sys.stderr)
    return True


def run(phase, repo, stdin_rows=None):
    """执行一个相位。返回 rc。**纯编排**：所有判断都在被调的命令里。"""
    if phase not in PHASES:
        print(str(M("hookgate.unknown_phase", phase=phase)), file=sys.stderr)
        return 2
    if not os.path.isdir(repo):
        print(str(M("hookgate.repo_missing", repo=repo)), file=sys.stderr)
        return 2

    _load_env_plugin(HERE)
    doc = os.environ.get("REFLECT_DOC", "").strip() or "STATE.md"

    if _prepare(phase, repo, doc):
        return 1

    # ② 全部闸门：执行面唯一产地（C1）
    rc, out = _sh([sys.executable, os.path.join(repo, "zreflect", "registry.py"),
                   "--run", "commit"])
    if rc != 0:
        print(out, file=sys.stderr)
        return 1

    if phase == "push":
        ok, lines = _push_readmes_together(repo, stdin_rows or [])
        for ln in lines:
            print(ln, file=sys.stderr)
        if not ok:
            return 1
    return 0


# ── 自证 ──────────────────────────────────────────────────────────────────────

def _cases():
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415

    def mk_repo(with_zreflect):
        d = tempfile.mkdtemp()
        _sh(["git", "init", "-q", d])
        if with_zreflect:
            os.makedirs(os.path.join(d, "zreflect"), exist_ok=True)
        return d

    def case(args):
        return _run_cli(list(args), quiet=True)

    return [
        # ① 正常不报：无参数 ⇒ 打印用法、退 0（求帮助不是错误）
        ("hookgate.no_args_prints_usage", lambda: case([]) == 0),
        # ② 该报的必须报
        ("★ hookgate.unknown_phase_is_2", lambda: case(["bogus", "/tmp"]) == 2),
        ("★ hookgate.missing_repo_is_2",
         lambda: case(["commit", "/nonexistent-xyz"]) == 2),
        # ③ 空输入必须报：只给相位，不给仓根
        ("★ hookgate.missing_root_is_2", lambda: case(["commit"]) == 2),
        # ④ 仓里没有 zreflect ⇒ 明说「不是套件落地的仓库」（rc=2，不是静默 0）
        ("★ hookgate.no_zreflect_is_2", lambda: _no_zreflect_case(mk_repo,
                                                                  shutil)),
        # 摘要行判据本身有牙
        ("★ hookgate.summary_shape_can_red", lambda: _summary_shape_ok()),
        # ref 协议解析：零 sha 的删除行要被跳过
        ("★ hookgate.refs_skip_deletions", lambda: _refs_case()),
    ]


def _no_zreflect_case(mk_repo, shutil):
    d = mk_repo(False)
    try:
        return _run_cli(["commit", d], quiet=True) == 2
    finally:
        shutil.rmtree(d, True)


def _summary_shape_ok():
    """判据在 `machine.is_summary()`（唯一产地，不再各写一份正则）。"""
    import machine  # noqa: PLC0415
    return machine.is_summary("=== 3 PASS / 0 FAIL ===") and \
        not machine.is_summary("=== 3 PASS / 0 fail ===")


def _refs_case():
    rows = [("refs/heads/main", ZERO_SHA, "refs/heads/main", ZERO_SHA)]
    got = _new_content_refs(".", rows)
    return got == []


def _run_cli(argv, quiet=False):
    """走一遍 CLI 分派，返回 rc。

    `quiet=True`（**自证专用**）：不打印任何东西 —— 自证输出是给人核对的接口，
    被诊断刷屏就没法核对了（本仓纪律「纯函数保持安静」）。
    ⚠️ 此前自证里它会打印，于是那些行排在机器摘要行**之后**，harness 取
    "最后一行当摘要"时拿到的是错误消息（实测）。
    """
    def _say(code, **kw):
        if not quiet:
            print(str(M(code, **kw)), file=sys.stderr)

    if not argv:
        if not quiet:
            _usage()
        return 0
    rc = _validate(argv, _say)
    if rc is not None:
        return rc
    return run(argv[0], argv[1], _refs_from_stdin())


def _validate(argv, say):
    """命令行形状校验。返回 rc（`None` = 形状合法，可以往下跑）。

    四道校验各是一个「不值得继续」的出口，全挤在调用点时复杂度 9 —— 而
    它们判的是**同一个问题**（这次调用能不能跑），所以归一个函数。
    """
    phase = argv[0]
    if phase not in PHASES:
        say("hookgate.unknown_phase", phase=phase)
        return 2
    if len(argv) < 2:
        say("hookgate.missing_root")
        return 2
    repo = argv[1]
    if not os.path.isdir(repo):
        say("hookgate.repo_missing", repo=repo)
        return 2
    if not os.path.isdir(os.path.join(repo, "zreflect")):
        say("hookgate.not_a_suite_repo", repo=repo)
        return 2
    return None


def _main(argv):
    if "--selftest" in argv:
        rc = activate_or_fatal()
        if rc:
            return rc
        from gate import selftest  # noqa: PLC0415
        return selftest(M("gate.title.hookgate"), _cases())
    rc = activate_or_fatal()
    if rc:
        return rc
    return _run_cli(argv)


GATE = meta("钩子入口",
            "给别人的钩子体系调用的单一口：commit 重渲染 + 跑闸门；"
            "push 只校验 + 三语 README 同批",
            knobs=("REFLECT_DOC",),
            runs_at="start-of-work",
            off_reason="钩子入口由 git 调用，不挂 pre-commit 相位")

if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
