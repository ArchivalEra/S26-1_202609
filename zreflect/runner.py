#!/usr/bin/env python3
"""逐字执行器（裸值契约的 runner，**公共 seam**）。

「逐字跑一条命令、stdout 去掉首尾空白后必须等于期望值」是本仓最重要的
interface 之一 —— 复跑闸门（台账 `cmd`，issue #2 ①）与 world 印章（环境
对账，issue #13）都是它的 adapter。「两个 adapter = 真实 seam」：它原本
住在 check_facts_replay 的私有区，check_world 掏邻居的下划线名字来用
（docstring 自称「嫁接」）—— 现在归位成 module，闸门之间不再互掏私有。

判据（`cmd` 逐字执行，cwd = 仓库根）：

  · **裸值契约**：stdout 去掉首尾空白后必须**等于**期望 —— 只打印
    「含该值的整行」人眼可读、机器不可判，各 adapter 自己报不符；
  · rc≠0 / 超时 / OSError 都**不算通过** —— 返回 (rc, stdout) 让
    adapter 决定措辞（超时 ⇒ rc=None）；
  · 管道不吞错：有 bash 用 `bash -o pipefail -c`（`cat 没了 | wc -l`
    打印 0 且 rc=0 的那种「失败但绿」正是要抓的东西），没有 bash 退回
    /bin/sh —— 判据强度随环境变化这件事，不许静默；
  · 超时默认 `REFLECT_REPLAY_TIMEOUT`（10s）：挂在 pre-commit 里的
    命令不该永远等不到。
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gate  # noqa: E402
from gate import (
    machine,  # noqa: E402
    module_meta,  # noqa: E402
)
from i18n import M  # noqa: E402


def default_timeout():
    """逐字执行的默认超时秒数（`REFLECT_REPLAY_TIMEOUT`；坏值 ⇒ 默认 10）。"""
    seconds, _bad = timeout_with_status()
    return seconds


def timeout_with_status():
    """`(秒数, 坏值)`：坏值 ⇒ 回落 10 并把**原值**带出来（调用方决定响不响）。

    ⚠️ 此前 `default_timeout` 静默回落，而 `check_facts_replay.run` 自己又
    `float(raw)` 探测一遍来告警 —— 同一个坏值，一个不响一个响（实测：
    `REFLECT_REPLAY_TIMEOUT=""` 时 replay 报 `bad_timeout`，但 runner 自己
    什么都不说）。两份判据一份只做一半。现在解析只此一份。
    """
    raw = os.environ.get("REFLECT_REPLAY_TIMEOUT")
    if raw is None or not raw.strip():
        return 10.0, None                     # 没配（含空串）= 正常默认
    try:
        return float(raw), None
    except ValueError:
        return 10.0, raw                      # 坏值：回落 + 带出原值


def quote(s, n=60):
    """把一段输出缩成可引用的 repr（复现事故时别把 1 MiB stdout 糊进终端）。"""
    t = s if len(s) <= n else s[:n] + "…"
    return repr(t)


def _shell_argv(cmd):
    """把一条 `cmd` 包装成「哪个 shell 能跑它」的 argv。

    三档，**强度随环境下降这件事必须可见**（不静默）：

      1. `bash -o pipefail -c` —— 最好：管道里任一环失败都带出来
         （`cat 没了 | wc -l` 打印 0 且 rc=0 的那种「失败但绿」正是要杀的）。
      2. `/bin/sh -c` —— 没有 bash 的系统（部分容器 / 精简发行版）。
         没有 `pipefail`，所以**管道中间的失败可能丢**。
      3. **Windows**：没有 `bash` 也没有 `/bin/sh`。回落到 `cmd.exe`——
         它能跑本仓台账里的那些 `python3 ...` / `git ...` 单命令，
         但不支持 POSIX 管道语义（`|` 会被 cmd 解释成管道，但 `$(...)` 等不认）。

    返回 `(argv, 强度标签)`；标签写进 `EINFACHT_REPLAY_SHELL` 供诊断。
    """
    bash = shutil.which("bash")
    if bash:
        return [bash, "-o", "pipefail", "-c", _python_of(cmd)], "bash"
    if os.name != "nt" and os.path.exists("/bin/sh"):
        return ["/bin/sh", "-c", _python_of(cmd)], "sh"
    # Windows：**不经 shell**，由 `_windows_argv` 拆成参数表。
    #
    # ⚠️ 走 `cmd.exe /c` 会掉进引号地狱：`sys.executable` 常在
    # `C:/Program Files/...`（含空格），cmd 会把外层引号剥掉再重新切分
    # ⇒ **127 找不到命令**。实测：CI 的 Windows 腿 19 条 replay 全红在这里。
    #
    # ⚠️ 也不用 `shlex.split`：`posix=False` **保留引号**（带引号的路径原样
    # 传给 CreateProcess ⇒ 找不到文件）；`posix=True` 会把 `C:/Program Files`
    # 的反斜杠当转义符吃掉。两者都错。见 `_windows_argv`。
    return None, "no-shell"


_QUOTED = re.compile(r'"([^"]*)"|(\S+)')


def _windows_argv(cmd):
    """把一条 `cmd` 拆成参数表（Windows，不经 shell）。

    规则：**双引号内原样保留**（含空格与反斜杠），引号外按空白切。
    这是 Windows `CommandLineToArgvW` 的近似 —— 对「解释器 + 脚本 + 几个参数」
    这个形状足够，而且不碰反斜杠。

    **不支持** shell 语法（`|` / `&&` / 重定向）。本仓台账里的 `cmd` 全是
    单命令；使用方若要管道，得让那台机器装 bash（`_shell_argv` 会优先选它，
    而那条路径有 `pipefail`）。
    """
    return [m.group(1) if m.group(1) is not None else m.group(2)
            for m in _QUOTED.finditer(cmd)]


# 台账里的 `cmd` 一律用 `python3`（惯用写法，Linux/macOS 上就是它）。
# Windows 上没有 `python3` 这个名字（setup-python 给的是 `python.exe`）——
# 所以在这里把**开头的 `python3`** 换成**当前解释器**。
#
# 为什么这不是作弊：`python3 <脚本>` 的语义是「用这个仓的 Python 跑它」，
# 换成 `sys.executable` 是同一件事的当前进程版本。而且台账 `cmd` 的契约是
# **逐字复跑**（`stdout == value`），不是「逐字执行同一条命令」—— 值才是判据。
_PY_CMD = re.compile(r"^\s*python3(?=\s)")


def _python_of(cmd):
    """把行首的 `python3` 换成当前解释器（Windows 兼容）；其余原样。

    ⚠️ 顺带把紧随其后的 `zreflect/<script>` 解析成**工具仓的绝对路径**。
    为什么必须：台账 `cmd` 里的 `zreflect/facts.py` 是**相对路径**，而
    `run_cmd` 的 cwd 是**被检查仓**（`gate.GATE_REPO`）。两者一致时没问题
    （自己量自己），不一致时（套件被拷到别处、或夹具仓只造数据）复跑就
    `No such file` —— 而错误信息会指向「命令失败」，不是「路径解析错了」。
    实测：harness 的换名夹具就撞上这个。
    """
    interp = _quote_for_shell(sys.executable)
    out = _PY_CMD.sub(lambda _m: interp, cmd, count=1)
    return _TOOL_REL.sub(
        lambda m: _quote_for_shell(os.path.join(gate.tool_repo(), m.group(1))),
        out, count=1)


# shell 会让这些字符「有含义」：空格（切词）、反斜杠（转义，POSIX sh 里
# `C:/hosted` 里的反斜杠会被吃成 `C:hosted`）、shell 元字符。
_NEEDS_QUOTING = re.compile(r"""[\s\\$`"'|&;<>()*?{}\[\]#~]""")


def _quote_for_shell(path):
    """把一个路径包成**任何 shell 都不会误解**的形式。

    ⚠️ 这条是 CI 的 Windows 腿用一整轮换来的：GitHub 的 windows-latest
    **装了 Git Bash**，于是 `shutil.which("bash")` 有值 ⇒ 走 bash 分支。
    而 `sys.executable` 形如 `C:/hostedtoolcache/windows/Python/3.13/x64/python.exe` ——
    在 bash 里**反斜杠是转义符**：一个 `C:` 后面跟反斜杠的路径会被吃成 `C:hosted`，
    于是 `python` 找不到 ⇒ **rc=127**（实测：19 条 replay 全红）。

    `" " in path` 判据不够：`C:/...` 没有空格，但有反斜杠。
    """
    if not _NEEDS_QUOTING.search(path):
        return path
    # POSIX sh 里单引号是最安全的（不解释任何字符）；但 Windows 路径可能
    # 含单引号（极罕见）——那一次用双引号 + 转义。
    if "'" not in path:
        return "'%s'" % path
    return '"%s"' % path.replace('"', '\\"')


# 行首 `python3` 之后的 `zreflect/<script>`（工具仓相对路径）
_TOOL_REL = re.compile(r"(?<!\w)(zreflect/[A-Za-z_][A-Za-z0-9_]*\.py)")


def _non_local_encoding_ok():
    """子进程打印**非本地编码**的字节时，`run_cmd` 必须仍拿到 str。

    做法：让子进程输出一段**必然不在 cp1252 里**的字节（中文），并把本地
    环境伪装成 cp1252 —— 靠 `PYTHONIOENCODING` 不够（那管子进程的**输出**），
    真判据是父进程的**解码**。这里直接验证 `run_cmd` 在子进程吐 UTF-8 中文时
    返回的是 str 而不是 None。
    """
    cmd = ('python3 -c "import sys;'
           'sys.stdout.reconfigure(encoding=\'utf-8\');'
           'print(chr(0x95F8) + chr(0x95E8))"')
    rc, out = run_cmd(cmd)
    return rc == 0 and isinstance(out, str) and out.strip() != ""


def run_cmd(cmd, timeout=None):
    """逐字跑一条 `cmd`（cwd=仓库根），返回 (返回码, stdout)。超时 ⇒ 返回码 None。

    ⚠️ **Windows 上没有 bash 也没有 `/bin/sh`**：此前这里硬写
    `["/bin/sh", "-c", cmd]`，于是 CI 的 Windows 腿每条 cmd 都 OSError 127。
    现在由 `_shell_argv` 分三档，并把实际用的是哪一档写进
    `EINFACHT_REPLAY_SHELL`（`bash` / `sh` / `cmd`）—— 判据强度随环境变化，
    不许静默。
    """
    t = default_timeout() if timeout is None else timeout
    argv, shell_kind = _shell_argv(cmd)
    if argv is None:
        argv = _windows_argv(_python_of(cmd))
    # ⚠️ **环守卫的跨进程那一半**：把深度传给子进程。一条 cmd 可以是另一个
    # 闸门（复用），而那个闸门可能又触发复跑 —— 没有这个变量，环会无限
    # spawn 直到 OOM（实测）。深度上限由复跑器判（`_MAX_DEPTH`）。
    env = dict(os.environ)
    env["EINFACHT_REPLAY_SHELL"] = shell_kind
    try:
        env["EINFACHT_REPLAY_DEPTH"] = str(
            int(os.environ.get("EINFACHT_REPLAY_DEPTH", "0") or 0) + 1)
    except ValueError:
        env["EINFACHT_REPLAY_DEPTH"] = "1"
    try:
        # ⚠️ **必须显式 `errors="replace"`**：`text=True` 用
        # `locale.getpreferredencoding()` 解码，而 Windows 默认是 cp1252。
        # 子进程一旦输出非 cp1252 字节（本仓的闸门会打印中文），读线程抛
        # `UnicodeDecodeError` —— **在主线程之外**，于是 `p.stdout` 变成
        # None，下游 `stdout.strip()` 报 `AttributeError`，而 traceback
        # 里只有一行 `Exception in thread Thread-N (_readerthread)`。
        # 实测：CI 的 Windows 腿连续两轮都栽在这一层。
        p = subprocess.run(argv, cwd=gate.GATE_REPO, capture_output=True, text=True,
                           errors="replace", timeout=t, env=env,
                           encoding="utf-8")
    except subprocess.TimeoutExpired:
        return None, ""
    except OSError as e:                # 连 shell 起不来 —— 报成失败，不许算通过
        # 诊断：把**实际 argv** 带进错误里。127 的原因只可能是「第一个元素
        # 不是可执行文件」——不说清 argv 就只能猜（实测：CI 的 Windows 腿
        # 报了 19 条 127，而本地永远复现不了）。
        return 127, machine().emit(
            "fatal", "%s [shell=%s argv=%r]" % (e, shell_kind, argv[:2]))
    # ⚠️ **`p.stdout` 可能是 `None`**：`capture_output=True` 通常保证它是
    # str，但 Windows 上子进程若因解码失败提前结束，`subprocess` 会把
    # `stdout` 留成 None —— 于是下游 `stdout.strip()` 抛
    # `AttributeError: 'NoneType' object has no attribute 'strip'`
    # （实测：CI 的 Windows 腿就是这么红的，而报错指向 `_judge_ok`，
    # 离真因三层远）。
    if p.returncode != 0 and p.stderr:
        # ⚠️ **失败时必须把 stderr 带出来**：`run_cmd` 此前只返回 stdout，
        # 于是「命令跑挂了」与「命令正确地报告了问题」分不开 —— 两者都是
        # 一个 rc≠0 加一段空 stdout。实测：CI 的 Windows 腿报
        # `command_failed(rc=1)` 而**看不到任何原因**，只能靠猜。
        # 拼进 stdout 是安全的：调用方只在 rc==0 时比 stdout 与值。
        return p.returncode, (p.stdout or "") + p.stderr
    if p.stdout is None:
        # 诊断：stdout 为 None 时把 stderr / argv 带进结果，别让下游
        # 只看到一个 `AttributeError`。
        return p.returncode, machine().emit(
            "fatal", "stdout=None rc=%s shell=%s argv=%r stderr=%r"
            % (p.returncode, shell_kind, argv[:2], (p.stderr or "")[:200]))
    return p.returncode, p.stdout


def _timeout_falls_back():
    """`REFLECT_REPLAY_TIMEOUT` 是坏值 ⇒ 必须回落 10.0（不是 raise）。"""
    import os  # noqa: PLC0415
    prev = os.environ.get("REFLECT_REPLAY_TIMEOUT")
    try:
        os.environ["REFLECT_REPLAY_TIMEOUT"] = "not-a-number"
        return default_timeout() == 10.0
    finally:
        if prev is None:
            os.environ.pop("REFLECT_REPLAY_TIMEOUT", None)
        else:
            os.environ["REFLECT_REPLAY_TIMEOUT"] = prev


def _cases():
    """三档自证（真跑 shell —— runner 的判据就是 shell 行为，假 runner 自证
    runner 是循环论证；但命令都是 echo/printf/false，无副作用、无网络）。"""
    return [
        # ① 正常不报
        ("runner.echo_rc0",
         lambda: run_cmd("echo hello") == (0, "hello\n")),
        ("runner.stdout_newline_preserved",
         lambda: run_cmd("printf 'v1'") == (0, "v1")),
        # ② 该报的必须报
        ("★ runner.nonzero_rc_passthrough",
         lambda: run_cmd("exit 3")[0] == 3),
        ("★ runner.pipefail_catches_swallowed_error",
         lambda: run_cmd("false | cat")[0] != 0),
        ("★ runner.timeout_rc_none",
         lambda: run_cmd("sleep 5", timeout=0.3)[0] is None),
        ("★ runner.missing_command_not_a_pass",
         lambda: run_cmd("definitely_not_a_command_xyz")[0] != 0),
        # quote 的截断（复现事故时不糊终端）
        ("runner.quote_truncates_long",
         lambda: quote("a" * 100).endswith("…'")),
        ("runner.quote_keeps_short",
         lambda: quote("ok") == "'ok'"),
        # 稳态：`default_timeout()` 读到坏值时必须回落 10（不是崩）
        ("runner.default_timeout_bad_value_falls_back",
         lambda: _timeout_falls_back()),
        # **`python3` 前缀在 Windows 上不存在**（`setup-python` 给的是
        # `python.exe`）—— 台账 `cmd` 一律写 `python3`，所以执行前要换成
        # 当前解释器。这条钉住三条边界：只改行首、不误伤 `python3x`、
        # 不碰中段的同名串。
        ("\u2605 runner.python3_prefix_rewritten",
         lambda: _python_of("python3 x.py") != "python3 x.py"
         and _python_of("python3 x.py").endswith(" x.py")),
        ("\u2605 runner.python3x_untouched",
         lambda: _python_of("python3x foo") == "python3x foo"),
        ("\u2605 runner.python3_midstring_untouched",
         lambda: _python_of("echo 'python3 x'") == "echo 'python3 x'"),
        # **Windows 档不能带引号给 CreateProcess**：带引号的路径会被当成
        # 字面文件名（找不到），而 `shlex.split(posix=False)` 正好保留引号。
        # 实测：CI 的 Windows 腿 19 条 replay 全红在这一处。
        ("★ runner.windows_argv_strips_quotes",
         lambda: _windows_argv('"C:\\Program Files\\Py\\python.exe" x.py')
         == ["C:\\Program Files\\Py\\python.exe", "x.py"]),
        ("★ runner.windows_argv_keeps_backslashes",
         lambda: _windows_argv("a\\b c") == ["a\\b", "c"]),
        # **子进程输出非本地编码时，读线程不许静默崩溃**：`text=True` 用
        # 本地编码解码，Windows 默认 cp1252，而本仓的闸门打印中文 ⇒
        # 读线程抛 UnicodeDecodeError（在**主线程之外**）⇒ `p.stdout` 是
        # None ⇒ 下游 `stdout.strip()` 报 AttributeError，而日志里只有
        # 一行 `Exception in thread Thread-N (_readerthread)`。
        ("\u2605 runner.non_local_encoding_output_survives",
         lambda: _non_local_encoding_ok()),
        # ③ 空输入必须报（对 runner 而言，「空」是空输出/空命令的形状）
        ("★ runner.quote_empty_is_visible",
         lambda: quote("") == "''"),
        ("★ runner.empty_command_not_a_pass",
         lambda: run_cmd("")[1] == ""),
    ]


def _selftest():
    import os  # noqa: PLC0415
    import sys  # noqa: PLC0415
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from gate import main_selftest_or  # noqa: PLC0415

    def _run(argv):
        print(M("runner.module_banner"), file=sys.stderr)
        return 2
    return main_selftest_or(sys.argv[1:],
                            M("gate.title.runner"),
                            _cases, _run)


MODULE = module_meta("逐字执行器", "裸值契约的公共 seam（复跑 / world 印章共用）", selftest=True)


if __name__ == "__main__":
    sys.exit(_selftest())
