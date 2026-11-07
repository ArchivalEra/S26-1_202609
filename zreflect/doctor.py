#!/usr/bin/env python3
"""开工预检 doctor（**小插件**，issue #10）：进程 / 端口活性。

「文件不变量全绿」≠「环境还活着」—— 两起真实事故
（Octave-Full-Wasm HISTORY §5.86 / §5.83）：机器重启后
验收站点与构建容器双双消失，文件层一切不变量为真，
但验收底线不可用，白跑一整轮才发现；另一仓的 dev
server 占了实验端口，探针连上别人的页面 ⇒ 误判
「新产物起不来」。git、闸门、witness 管的全是文件
与产物；服务进程、容器状态、端口占用不在任何机制
管辖内 —— 本插件补上这一条：**开工前**点名。

策略是**数据**（同 #7 体例），机制只出引擎 + 契约：

    { "checks": [
      { "kind": "http", "url": "http://127.0.0.1:8761/",
        "expect_status": 200,
        "expect_headers": {"Cross-Origin-Opener-Policy": "same-origin"},
        "why": "验收底线：必须活着且带 COI 头" },
      { "kind": "docker", "container": "o113",
        "state": "running", "why": "构建车道" },
      { "kind": "port-free", "port": 8868,
        "why": "实验独占端口——被占 ⇒ 探测误判" } ] }

两类断言都要：「必须活着」（http / docker）与
「必须空着」（port-free）。判据 **stdout 裸值契约**：
`ok` / `DOWN: <哪条>`（全部存活才打 `ok`）。全部
**无害**：只读 GET / `docker inspect` / connect 探测。

**每条探测必须带超时**（`REFLECT_DOCTOR_TIMEOUT`，
默认 2 秒）：对死端口 connect 会等到天荒地老 ——
那是探针自身的失败模式，必须与被探测物解耦
（同「探测不进开机路径」的教训）。

**不挂 pre-commit**（issue 明说）：它查的是**会死
的东西**，放提交钩子里频率错、且拖慢每次提交。
所以本文件**不是** `check_*.py` —— 发现式名录
（`for g in zreflect/check_*.py`）扫不到它，pre-commit
不跑它；`gates-selftest.sh` 点名一次证明它能红
（同 einfacht-env.sh 插件体例）。开工前手动跑：

    python3 zreflect/doctor.py

可插拔：`REFLECT_DOCTOR` 未配且默认 `doctor.json`
不在 ⇒ 明说未启用、退 0。显式配置了却指向不存在的
文件 ⇒ FATAL 退 2（ dangling pointer 不是「未启用」）。
活性是瞬时事实 ⇒ **不进台账 replay**（每次开工真跑
即可，ledger 的裸值契约抓不住会死的东西）。

**边界（issue 明说的，不藏）**：doctor 只做**活性**
探测，不做内容校验（内容由既有闸门 / 验收管）；
「哪台服务必须活着、哪些端口必须独占」是**策略**，
各仓自配（spec 数据）。零值守卫：清单空 / 缺 kind /
缺 why / 未知 kind ⇒ 都报（未知判据 = 静默通过）。

用法（直接跑，cwd=仓库根）：
    python3 zreflect/doctor.py [--selftest]
退出码：0=全活（或未启用）/ 1=有 DOWN / 2=配置或
环境坏了（规格形状坏 ≠ 检查失败）。
"""
from __future__ import annotations

import os
import socket
import subprocess
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import knobs  # noqa: E402
import machine  # noqa: E402
from gate import fatal, load_spec, main_selftest_or, meta, off, repo  # noqa: E402
from i18n import M  # noqa: E402

# 从旋钮登记表派生（唯一产地）—— 手写字面量会与它漂（本仓最贵的一类债）。
DEFAULT_SPEC = knobs.REGISTRY["REFLECT_DOCTOR"][1]
DEFAULT_TIMEOUT = 2.0


# —— 纯判据（自证可注入假响应；返回 (满足?, 原因)）——

def _http_verdict(status, headers, check):
    """HTTP 响应是否满足判据。headers 键已小写化。"""
    want = check.get("expect_status")
    if want is not None and status != want:
        return False, M("doctor.http_status_mismatch", actual=status, expected=want)
    for k, v in (check.get("expect_headers") or {}).items():
        got = headers.get(k.lower())
        if got != v:
            return False, M("doctor.http_header_mismatch",
                            header=k, actual=got, expected=v)
    return True, ""


def _docker_verdict(stdout):
    ok = stdout.strip() == "true"
    return ok, "" if ok else \
        M("doctor.container_not_running", actual=stdout.strip())


def _port_free_verdict(connect_succeeded):
    """connect 成功 = 被占；拒绝 = 空着。"""
    return (not connect_succeeded,
            "" if not connect_succeeded else M("doctor.port_in_use"))


# —— 真实传输（薄层；自证不跑它们，自证必须无网无 docker）——

def _http_probe(check, timeout):
    try:
        req = urllib.request.Request(check["url"], method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            ok, why = _http_verdict(
                resp.status,
                {k.lower(): v for k, v in resp.headers.items()},
                check)
            return ok, why
    # URLError 是 OSError 的子类，不必单列。
    except (OSError, ValueError) as e:
        return False, M("doctor.get_failed", error=e)


def _docker_probe(check, timeout):
    try:
        r = subprocess.run(
            ["docker", "inspect", "--format", "{{.State.Running}}",
             check["container"]],
            capture_output=True, text=True, timeout=timeout,
                           encoding="utf-8", errors="replace")
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, M("doctor.docker_inspect_failed", error=e)
    return _docker_verdict(r.stdout)


def _port_free_probe(check, timeout):
    try:
        socket.create_connection(("127.0.0.1", check["port"]),
                                 timeout=timeout).close()
    except ConnectionRefusedError:
        return True, ""                       # 拒绝连接 = 空着
    except OSError as e:
        return False, M("doctor.probe_inconclusive", error=e)
    return _port_free_verdict(True)


_PROBES = {"http": _http_probe, "docker": _docker_probe,
           "port-free": _port_free_probe}


def label(check):
    """DOWN 行点名用的标签：kind:目标。"""
    target = check.get("url") or check.get("container") \
        or check.get("port")
    return "%s:%s" % (check.get("kind"), target)


# —— 规格校验（纯函数：零值守卫 + 形状判据）——

def _http_shape_problems(c):
    """http 检查项的字段判据（缺 url / expect_status 非整数 / expect_headers 形状）。"""
    out = []
    if not str(c.get("url") or "").strip():
        return [M("doctor.http_missing_url", check=label(c))]
    es = c.get("expect_status")
    if es is not None and (isinstance(es, bool) or not isinstance(es, int)):
        return [M("doctor.http_status_not_int", check=label(c))]
    eh = c.get("expect_headers")
    if eh is not None and (not isinstance(eh, dict) or any(
            not isinstance(k, str) or not isinstance(v, str)
            for k, v in eh.items())):
        return [M("doctor.http_headers_not_object", check=label(c))]
    return out


def _docker_shape_problems(c):
    """docker 检查项的字段判据（缺 container / state 只支持 running）。"""
    if not str(c.get("container") or "").strip():
        return [M("doctor.docker_missing_container", check=label(c))]
    if str(c.get("state") or "").strip() != "running":
        return [M("doctor.docker_bad_state",
                  check=label(c), actual=c.get("state"))]
    return []


def _port_free_shape_problems(c):
    """port-free 检查项的字段判据（port 必须是 1-65535 整数）。"""
    port = c.get("port")
    if (not isinstance(port, int) or isinstance(port, bool)
            or not 1 <= port <= 65535):
        return [M("doctor.port_not_in_range", check=label(c), actual=port)]
    return []


# kind → 该 kind 的字段判据函数（新 kind 加一行，主循环不动）
_KIND_SHAPE = {
    "http": _http_shape_problems,
    "docker": _docker_shape_problems,
    "port-free": _port_free_shape_problems,
}


def spec_problems(checks):
    """纯函数：规格形状问题清单（空 = 形状合法）。

    issue #22 整改：按「一层判据 = 一个函数」拆开 —— 每个 kind 的字段判据
    独立成函数（`_KIND_SHAPE` 一张表），主函数只做通用部分（非对象 / 缺 kind /
    未知 kind / 缺 why）+ 分派。消息措辞与顺序保持原样。
    """
    if not isinstance(checks, list) or not checks:
        return [M("doctor.empty_spec")]
    out = []
    for c in checks:
        if not isinstance(c, dict):
            out.append(M("doctor.not_object", check=c))
            continue
        kind = str(c.get("kind") or "").strip()
        why = str(c.get("why") or "").strip()
        if not kind:
            out.append(M("doctor.missing_kind", check=c))
            continue
        if kind not in _PROBES:
            out.append(M("doctor.unknown_kind",
                         kind=kind, supported=", ".join(sorted(_PROBES))))
            continue
        if not why:
            out.append(M("doctor.missing_why", check=label(c)))
        out += _KIND_SHAPE[kind](c)
    return out


# —— 编排（probe 可注入：自证用假探针，不碰网络 / docker）——

def _timeout():
    raw = os.environ.get("REFLECT_DOCTOR_TIMEOUT", "").strip()
    if not raw:
        return DEFAULT_TIMEOUT
    try:
        t = float(raw)
    except ValueError:
        return DEFAULT_TIMEOUT
    return t if t > 0 else DEFAULT_TIMEOUT


def down_labels(checks, probe=None, timeout=None):
    """返回 DOWN 的标签清单（空 = 全活）。每条探测都带
    超时（timeout=None ⇒ 读旋钮 / 默认）。"""
    probe = probe or _dispatch
    t = _timeout() if timeout is None else timeout
    downs = []
    for c in checks:
        ok, detail = probe(c, t)
        if not ok:
            downs.append(M("doctor.down_label", label=label(c), detail=detail))
    return downs


def _dispatch(check, timeout):
    return _PROBES[check["kind"]](check, timeout)


# —— 入口 ——

def _spec_path():
    """解析顺序：显式旋钮 > 默认名。显式配置却指向不存在的
    文件 ⇒ 返回该路径（run 当场 FATAL）；未配且默认名不在
    ⇒ None（未启用）。"""
    name = os.environ.get("REFLECT_DOCTOR", "").strip()
    if name:
        return repo(name)
    p = repo(DEFAULT_SPEC)
    return p if os.path.exists(p) else None


def _timeout_problem():
    """`REFLECT_DOCTOR_TIMEOUT` 必须是正数。返回问题或 None。"""
    raw = os.environ.get("REFLECT_DOCTOR_TIMEOUT", "").strip()
    if not raw:
        return None
    try:
        value = float(raw)
    except ValueError:
        return M("doctor.bad_timeout", value=raw)
    # 显式判范围，不用 `raise ValueError` 造控制流（`float()` 已处理「不是数字」，
    # 这里只是「是数字但不是正数」—— 一个独立的失败原因，不该借异常的通道）
    if value <= 0:
        return M("doctor.bad_timeout", value=raw)
    return None


def _load_checks():
    """装载规格并取 `checks`。返回 `(checks, done_rc)`。

    `done_rc is not None` ⇒ 调用方**应当直接返回**它（可能是 0，`off` 就是 0）。
    `None` ⇒ 继续往下判。

    ⚠️ 这里不能用「rc 非 0」当「已处理」的信号：`off()` 的 rc 是 **0**
    （off 不是失败）。早先写成 `if rc: return rc` 时，`off` 之后照常往下跑
    `spec_problems(None)`，于是「未启用」变成 `doctor.empty_spec` + rc=2
    （实测：跨仓夹具里 doctor 每次红）。
    """
    p = _spec_path()
    if p is None:
        return None, off(M("doctor.off", name=DEFAULT_SPEC,
                           path=os.path.join("zreflect", DEFAULT_SPEC)
                           + ".example"))
    if not os.path.exists(p):
        return None, fatal(M("doctor.spec_missing"))
    spec, err = load_spec(p)
    if err:
        return None, fatal(err)
    return (spec.get("checks") if isinstance(spec, dict) else None), None


def run(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    bad = _timeout_problem()
    if bad:
        return fatal(bad)
    checks, done_rc = _load_checks()
    if done_rc is not None:
        return done_rc
    probs = spec_problems(checks)
    if probs:
        print(M("doctor.spec_problems", count=len(probs)), file=sys.stderr)
        for x in probs:
            print("  · " + x, file=sys.stderr)
        return 2
    downs = down_labels(checks)
    if downs:
        print(machine().emit("down", ", ".join(downs)))
        return 1
    print("ok")
    return 0


def _cases_fixture():
    """探针夹具 + 规格正文。返回 dict，喂给五个分组函数。"""
    ok_probe = lambda c, t: (True, "")           # noqa: E731

    def down_probe(c, t):
        return (False, "fake DOWN")

    # 夹具（spec 正文）用英文：它们是被校验的**输入**，不是本体输出。
    good = [
        {"kind": "http", "url": "http://127.0.0.1:8761/",
         "expect_status": 200,
         "expect_headers": {"Cross-Origin-Opener-Policy":
                            "same-origin"},
         "why": "acceptance baseline"},
        {"kind": "docker", "container": "o113",
         "state": "running", "why": "build lane"},
        {"kind": "port-free", "port": 8868,
         "why": "experiment-only port"},
    ]

    def timeout_threaded():
        """每条探测带超时的可证伪断言：探针收到的是配置的
        超时值（不是 None、不是 0）。"""
        seen = []

        def p(c, t):
            seen.append(t)
            return (True, "")
        down_labels(good, probe=p, timeout=5.5)
        return seen == [5.5, 5.5, 5.5]

    return {"ok_probe": ok_probe, "down_probe": down_probe,
            "good": good, "timeout_threaded": timeout_threaded}


def _cases_spec(fx):
    """见 `_cases()`：本组 6 条。"""
    ok_probe = fx["ok_probe"]
    good = fx["good"]
    return [
    # ① 正常不报
    ("doctor.valid_spec_all_alive",
     lambda: spec_problems(good) == []
     and down_labels(good, probe=ok_probe) == []),
    ("★ doctor.empty_spec",
     lambda: [p.code for p in spec_problems([])] == ["doctor.empty_spec"]),
    ("★ doctor.missing_kind",
     lambda: [p.code for p in spec_problems([{"why": "w"}])
              ] == ["doctor.missing_kind"]),
    ("★ doctor.unknown_kind",
     lambda: [p.code for p in spec_problems(
         [{"kind": "smtp", "why": "w"}])] == ["doctor.unknown_kind"]),
    ("★ doctor.missing_why",
     lambda: [p.code for p in spec_problems(
         [{"kind": "http", "url": "http://x/"}])] == ["doctor.missing_why"]),
    # ③ 空输入必须报
    ("★ doctor.empty_spec_none",
     lambda: [p.code for p in spec_problems(None)] == ["doctor.empty_spec"]),
    ]


def _cases_http(fx):
    """见 `_cases()`：本组 7 条。"""
    good = fx["good"]
    return [
    ("doctor.http_verdict_ok",
     lambda: _http_verdict(
         200, {"cross-origin-opener-policy": "same-origin"},
         good[0]) == (True, "")),
    # ② 该报的必须报
    ("★ doctor.http_status_mismatch",
     lambda: _http_verdict(500, {}, good[0])[0] is False
     and _http_verdict(500, {}, good[0])[1].code
     == "doctor.http_status_mismatch"),
    ("★ doctor.http_header_missing",
     lambda: _http_verdict(200, {}, good[0])[0] is False
     and _http_verdict(200, {}, good[0])[1].code
     == "doctor.http_header_mismatch"),
    ("★ doctor.http_header_value_mismatch",
     lambda: _http_verdict(
         200, {"cross-origin-opener-policy": "credentials"},
         good[0])[0] is False),
    ("★ doctor.http_missing_url",
     lambda: [p.code for p in spec_problems(
         [{"kind": "http", "why": "w"}])] == ["doctor.http_missing_url"]),
    ("★ doctor.http_status_not_int",
     lambda: [p.code for p in spec_problems(
         [{"kind": "http", "url": "http://x/",
           "expect_status": "200", "why": "w"}])
         ] == ["doctor.http_status_not_int"]),
    ("★ doctor.http_headers_not_object",
     lambda: [p.code for p in spec_problems(
         [{"kind": "http", "url": "http://x/",
           "expect_headers": ["a"], "why": "w"}])
         ] == ["doctor.http_headers_not_object"]),
    ]


def _cases_docker(fx):
    """见 `_cases()`：本组 4 条。"""
    return [
    ("doctor.docker_verdict_ok",
     lambda: _docker_verdict("true\n") == (True, "")),
    ("★ doctor.container_not_running",
     lambda: _docker_verdict("false")[0] is False
     and _docker_verdict("false")[1].code
     == "doctor.container_not_running"),
    ("★ doctor.docker_bad_state",
     lambda: [p.code for p in spec_problems(
         [{"kind": "docker", "container": "c",
           "state": "paused", "why": "w"}])] == ["doctor.docker_bad_state"]),
    ("★ doctor.docker_missing_container",
     lambda: [p.code for p in spec_problems(
         [{"kind": "docker", "state": "running", "why": "w"}])
         ] == ["doctor.docker_missing_container"]),
    ]


def _cases_port(fx):
    """见 `_cases()`：本组 3 条。"""
    return [
    ("doctor.port_free_verdict_ok",
     lambda: _port_free_verdict(False) == (True, "")),
    ("★ doctor.port_in_use",
     lambda: _port_free_verdict(True)[0] is False
     and _port_free_verdict(True)[1].code == "doctor.port_in_use"),
    ("★ doctor.port_not_in_range",
     lambda: [p.code for p in spec_problems(
         [{"kind": "port-free", "port": 70000,
           "why": "w"}])] == ["doctor.port_not_in_range"]),
    ]


def _cases_misc(fx):
    """见 `_cases()`：本组 2 条。"""
    down_probe = fx["down_probe"]
    good = fx["good"]
    timeout_threaded = fx["timeout_threaded"]
    return [
    ("★ doctor.down_label_names_the_target",
     # 只钉**用例名宣称**的那件事（label 指向目标）；`detail` 是夹具
     # probe 的透传，钉进整字典会让这条断言随夹具改字而红。
     lambda: [p.code for p in down_labels([good[1]], probe=down_probe)
              ] == ["doctor.down_label"]
     and down_labels([good[1]], probe=down_probe)[0].params["label"]
     == "docker:o113"),
    ("★ doctor.timeout_passed_to_every_probe",
     lambda: timeout_threaded()),
    ]


def _cases():
    """拼装五组夹具断言。**只拼装** —— 判据在各分组函数里。"""
    fx = _cases_fixture()
    return (
    _cases_spec(fx)
    + _cases_http(fx)
    + _cases_docker(fx)
    + _cases_port(fx)
    + _cases_misc(fx)
    )


GATE = meta("开工预检 doctor",
            "进程 / 端口活性（查会死的东西 ⇒ runs_at=start-of-work，不进 pre-commit）",
            knobs=("REFLECT_DOCTOR", "REFLECT_DOCTOR_TIMEOUT"),
            runs_at="start-of-work",
            off_reason="本仓没有 doctor.json 规格：不查进程/端口活性 ⇒ 明说未启用")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:],
                              M("gate.title.doctor"),
                              _cases(), run))
