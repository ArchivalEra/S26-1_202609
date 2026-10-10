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
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gate import fatal, load_spec, main_selftest_or, meta, off, repo, selftest  # noqa: E402

DEFAULT_SPEC = "doctor.json"
DEFAULT_TIMEOUT = 2.0


# —— 纯判据（自证可注入假响应；返回 (满足?, 原因)）——

def _http_verdict(status, headers, check):
    """HTTP 响应是否满足判据。headers 键已小写化。"""
    want = check.get("expect_status")
    if want is not None and status != want:
        return False, "状态 %s ≠ 期望 %s" % (status, want)
    for k, v in (check.get("expect_headers") or {}).items():
        got = headers.get(k.lower())
        if got != v:
            return False, "头 %s=%r ≠ 期望 %r" % (k, got, v)
    return True, ""


def _docker_verdict(stdout):
    ok = stdout.strip() == "true"
    return ok, "" if ok else \
        "容器不在 running（inspect 说 %r）" % stdout.strip()


def _port_free_verdict(connect_succeeded):
    """connect 成功 = 被占；拒绝 = 空着。"""
    return (not connect_succeeded,
            "" if not connect_succeeded else "端口被占（连上了）")


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
    except (urllib.error.URLError, OSError, ValueError) as e:
        return False, "GET 失败：%s" % e


def _docker_probe(check, timeout):
    try:
        r = subprocess.run(
            ["docker", "inspect", "--format", "{{.State.Running}}",
             check["container"]],
            capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, "docker inspect 失败：%s" % e
    return _docker_verdict(r.stdout)


def _port_free_probe(check, timeout):
    try:
        socket.create_connection(("127.0.0.1", check["port"]),
                                 timeout=timeout).close()
    except ConnectionRefusedError:
        return True, ""                       # 拒绝连接 = 空着
    except OSError as e:
        return False, "探测既非占用也非空闲（%s）—— 不许静默通过" % e
    return _port_free_verdict(True)


_PROBES = {"http": _http_probe, "docker": _docker_probe,
           "port-free": _port_free_probe}


def label(check):
    """DOWN 行点名用的标签：kind:目标。"""
    target = check.get("url") or check.get("container") \
        or check.get("port")
    return "%s:%s" % (check.get("kind"), target)


# —— 规格校验（纯函数：零值守卫 + 形状判据）——

def spec_problems(checks):
    """纯函数：规格形状问题清单（空 = 形状合法）。"""
    out = []
    if not isinstance(checks, list) or not checks:
        return ["doctor 清单为空或不是数组 —— 空清单不是通过"
                "（零值守卫）：清单要有理由才存在"]
    for c in checks:
        if not isinstance(c, dict):
            out.append("检查项不是对象：%r" % (c,))
            continue
        kind = str(c.get("kind") or "").strip()
        why = str(c.get("why") or "").strip()
        if not kind:
            out.append("检查项缺 kind（必填）：%r" % (c,))
            continue
        if kind not in _PROBES:
            out.append("未知 kind `%s`（支持：%s）—— 未知判据"
                       "等于静默通过"
                       % (kind, ", ".join(sorted(_PROBES))))
            continue
        if not why:
            out.append("`%s` 缺 why（必填：没有理由的检查项"
                       "没人敢删，会变成僵尸）" % label(c))
        if kind == "http":
            if not str(c.get("url") or "").strip():
                out.append("`%s` 缺 url（必填）" % label(c))
                continue
            es = c.get("expect_status")
            if es is not None and (isinstance(es, bool)
                                   or not isinstance(es, int)):
                out.append("`%s` 的 expect_status 必须是整数"
                           % label(c))
                continue
            eh = c.get("expect_headers")
            if eh is not None and (not isinstance(eh, dict) or any(
                    not isinstance(k, str) or not isinstance(v, str)
                    for k, v in eh.items())):
                out.append("`%s` 的 expect_headers 必须是"
                           " {头名: 值} 字符串对象" % label(c))
                continue
        elif kind == "docker":
            if not str(c.get("container") or "").strip():
                out.append("`%s` 缺 container（必填）" % label(c))
                continue
            if str(c.get("state") or "").strip() != "running":
                out.append("`%s` 的 state 只支持 running"
                           "（给的是 %r）"
                           % (label(c), c.get("state")))
                continue
        else:                                        # port-free
            port = c.get("port")
            if (not isinstance(port, int) or isinstance(port, bool)
                    or not 1 <= port <= 65535):
                out.append("`%s` 的 port 必须是 1-65535 的整数"
                           "（给的是 %r）" % (label(c), port))
                continue
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
            downs.append("%s（%s）" % (label(c), detail))
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


def run(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    raw_timeout = os.environ.get("REFLECT_DOCTOR_TIMEOUT", "").strip()
    if raw_timeout:
        try:
            if float(raw_timeout) <= 0:
                raise ValueError
        except ValueError:
            return fatal("REFLECT_DOCTOR_TIMEOUT=%r 不是正数"
                         "秒 —— 超时是探针的解耦绳，不许坏" % raw_timeout)
    p = _spec_path()
    if p is None:
        return off("doctor 预检：未配置（REFLECT_DOCTOR 未配且默认 "
                   "%s 不在）⇒ 本预检未启用（小插件；要启用："
                   "cp zreflect/%s.example %s）"
                   % (DEFAULT_SPEC, DEFAULT_SPEC, DEFAULT_SPEC))
    if not os.path.exists(p):
        return fatal("REFLECT_DOCTOR 已配置但规格文件不在 —— "
                     "先写规格（或撤掉该旋钮）")
    spec, err = load_spec(p)
    if err:
        return fatal(err)
    checks = spec.get("checks") if isinstance(spec, dict) else None
    probs = spec_problems(checks)
    if probs:
        print("doctor 预检：规格 %d 个问题" % len(probs),
              file=sys.stderr)
        for x in probs:
            print("  · " + x, file=sys.stderr)
        return 2
    downs = down_labels(checks)
    if downs:
        print("DOWN: " + ", ".join(downs))
        return 1
    print("ok")
    return 0


def _cases():
    ok_probe = lambda c, t: (True, "")           # noqa: E731

    def down_probe(c, t):
        return (False, "假 DOWN")

    good = [
        {"kind": "http", "url": "http://127.0.0.1:8761/",
         "expect_status": 200,
         "expect_headers": {"Cross-Origin-Opener-Policy":
                            "same-origin"},
         "why": "验收底线"},
        {"kind": "docker", "container": "o113",
         "state": "running", "why": "构建车道"},
        {"kind": "port-free", "port": 8868,
         "why": "实验独占端口"},
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

    return [
        # ① 正常不报
        ("合法清单 + 全活 ⇒ 无问题、无 DOWN",
         lambda: spec_problems(good) == []
         and down_labels(good, probe=ok_probe) == []),
        ("http 状态 + 头都满足 ⇒ 满足",
         lambda: _http_verdict(
             200, {"cross-origin-opener-policy": "same-origin"},
             good[0]) == (True, "")),
        ("docker running ⇒ 满足",
         lambda: _docker_verdict("true\n") == (True, "")),
        ("端口拒绝连接 = 空着 ⇒ 满足",
         lambda: _port_free_verdict(False) == (True, "")),
        # ② 该报的必须报
        ("★ http 状态不符 ⇒ 必须报",
         lambda: _http_verdict(500, {}, good[0])[0] is False),
        ("★ http 头缺失 ⇒ 必须报",
         lambda: _http_verdict(200, {}, good[0])[0] is False),
        ("★ http 头值不符 ⇒ 必须报",
         lambda: _http_verdict(
             200, {"cross-origin-opener-policy": "credentials"},
             good[0])[0] is False),
        ("★ docker 不 running ⇒ 必须报",
         lambda: _docker_verdict("false")[0] is False),
        ("★ 端口被占（连上了）⇒ 必须报",
         lambda: _port_free_verdict(True)[0] is False),
        ("★ 一条 DOWN ⇒ 标签点名（裸值契约）",
         lambda: down_labels([good[1]], probe=down_probe)
         == ["docker:o113（假 DOWN）"]),
        ("★ 清单空 ⇒ 必须报（零值守卫）",
         lambda: spec_problems([]) != []),
        ("★ 缺 kind ⇒ 必须报",
         lambda: any("缺 kind" in x
                     for x in spec_problems([{"why": "w"}]))),
        ("★ 未知 kind ⇒ 必须报（未知判据 = 静默通过）",
         lambda: any("未知 kind" in x for x in spec_problems(
             [{"kind": "smtp", "why": "w"}]))),
        ("★ 缺 why ⇒ 必须报（僵尸守卫）",
         lambda: any("缺 why" in x for x in spec_problems(
             [{"kind": "http", "url": "http://x/"}]))),
        ("★ http 缺 url ⇒ 必须报",
         lambda: any("缺 url" in x for x in spec_problems(
             [{"kind": "http", "why": "w"}]))),
        ("★ docker 坏 state ⇒ 必须报",
         lambda: any("只支持 running" in x for x in spec_problems(
             [{"kind": "docker", "container": "c",
               "state": "paused", "why": "w"}]))),
        ("★ port-free 坏 port ⇒ 必须报",
         lambda: any("port 必须是" in x for x in spec_problems(
             [{"kind": "port-free", "port": 70000,
               "why": "w"}]))),
        ("★ 每条探测带超时（探针收到配置的超时值）",
         lambda: timeout_threaded()),
        # ③ 空输入必须报
        ("★ checks 是 None ⇒ 必须报（零值守卫）",
         lambda: spec_problems(None) != []),
    ]


GATE = meta("开工预检 doctor",
            "进程 / 端口活性（查会死的东西 ⇒ runs_at=start-of-work，不进 pre-commit）",
            knobs=("REFLECT_DOCTOR", "REFLECT_DOCTOR_TIMEOUT"),
            runs_at="start-of-work")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:],
                              "开工预检 doctor（进程/端口活性）",
                              _cases(), run))
