#!/usr/bin/env python3
"""声明式验证对象闸门（reflection world，**可插拔模块**，issue #13）。

多线仓库（若干条独立维护的产线，共享同一套闸门与
同一个验证环境）里，验证闸门读的是「**恰好部署的
那个世界**」—— 三起真实事故（Octave-Full-Wasm，
2026-10-07）：

  1. 提交拣选到 wasm64-NEXT 后闸门红：NEXT 的插件
     登记表对上的是 IllegalPerformance 部署的站点
     —— 闸门没坏，它忠实地比对了环境里恰好部署的
     那个世界，而那个世界属于另一条线；
  2. master 上同形状再红：master 线的验证对象应是
     仓库自带的 site/，不是共享部署站点；
  3. NEXT 重编的产物混入 rust_sort：共享容器里跑
     的是另一条线的构建脚本（IP 翻过表的版本）。

根因（用 seam 的语言）：seam 存在，但它是**四条
平行的半缝** —— 名字不同、默认值不同、覆盖面不同
（有的闸门读 env、有的硬编码容器、有的读「最新」），
换线时没有任何东西强迫闸门与「本线世界」对齐。

世界声明（**数据不是代码**，同 #7 体例）：

    { "lines": {
        "wasm64-NEXT": { "site": "/…/next-base/site",
                          "artifacts": "/…/next-base/w64-artifacts",
                          "container": "o113",
                          "fork_pin_ref": "upstream/octave" } },
      "active": "wasm64-NEXT",
      "stamps": {
        "container": { "value": "sha256:…",
                        "cmd": "docker inspect --format '{{.Image}}' o113" },
        "site":     { "value": "sha256:…",
                        "cmd": "find /…/site -type f | sort | xargs sha256sum | sha256sum" },
        "scripts":  { "value": "sha256:…",
                        "cmd": "sha256sum relink.sh link-web.sh | sha256sum" } } }

闸门做三件事：

  · **解析当前线**（统一 interface）：`REFLECT_WORLD_LINE`
    （CI / 特殊跑法的覆盖）> 当前分支名（若分支是清单
    里的线）> `active`（人的决定）。其他闸门经
    `resolve_line()` 拿验证对象 —— 替代四个 ambient
    旋钮；闸门的深模块性质不变，藏进去的是「世界
    怎么解析」；
  · **分支对账**：分支是清单里的线却 ≠ `active` ⇒ 红
    （事故 1/2 的形状：人换了分支，没跑换线脚本，
    active 还指着另一条线）；
  · **印章对账**：每个 stamp 的 `cmd` 逐字复跑
    （裸值契约 —— `run_cmd` 直接嫁接复跑闸门），
    stdout ≠ `value` ⇒ 红（事故 3 的形状：容器里
    跑的是另一条线的脚本，产物被污染）。

**换线 = 跑一个被本闸门核对的脚本**：脚本做完三步
（submodule update + 重供给 + cp 脚本）后**写出**
世界声明（active + 印章），本闸门在提交时刻核对
声明 vs 环境 —— 把「换线三步」从口头纪律变成有
证人的动作（同 doctor/witness 的嫁接方式）。

可插拔：`REFLECT_WORLD` 未配且默认 `world.json`
不在 ⇒ 明说未启用、退 0。**单线仓库不受益也不
受损**（一个世界 = 现状行为 —— issue 明说的边界；
这咬的是「多条独立维护线共享一个验证环境」的
形状）。

诚实边界（issue 明说的，不藏）：

  · **不提案自动选线** —— 哪条线算当前是人的决定
    （`active` 字段），机器只负责声明与核对一致；
  · 跨引擎可复现性（relaxed_madd 让 BLAS 结果
    末位可变，IEEE 合规但不可复现）是另一个议题，
    与本条的「验错世界」正交，别混；
  · 印章的 `cmd` 是仓库自己写的 —— 信任边界与
    复跑闸门相同（仓库自己生产、自己审查）。

用法（直接跑，cwd=仓库根）：
    python3 zreflect/check_world.py [--selftest]
退出码：0=绿 / 1=发现问题 / 2=配置或环境坏了。
"""
from __future__ import annotations

import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gate import (  # noqa: E402
    fatal,
    finish,
    load_spec,
    main_selftest_or,
    meta,
    off,
    repo,  # noqa: E402
)
from i18n import M  # noqa: E402
from runner import quote, run_cmd  # noqa: E402

WORLD_RAW = os.environ.get("REFLECT_WORLD", "").strip()
LINE_OVERRIDE = os.environ.get("REFLECT_WORLD_LINE", "").strip()

# 线的必填字段（issue #13 建议形状的四件套；额外字段
# 允许原样透传 —— 各线自定的验证对象字段由消费方
# 闸门经 resolve_line() 读）。
LINE_FIELDS = ("site", "artifacts", "container", "fork_pin_ref")


def current_branch():
    """当前 git 分支名（detached HEAD / 非仓库 ⇒ 空串 =
    不参与选线；CI 的覆盖走 REFLECT_WORLD_LINE）。"""
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=5,
            cwd=repo(),
                           encoding="utf-8", errors="replace")
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def resolve_line(spec, branch, override=None):
    """统一 interface：返回 (线名, 线的世界 dict)。

    解析顺序：覆盖（CI / 特殊跑法）> 分支名（若分支
    是清单里的线）> active（人的决定）。其他闸门消费
    验证对象走这里 —— 替代名字不同、默认值不同、
    覆盖面不同的四个 ambient 旋钮。解析不出 ⇒
    (None, None)（调用方该报的形状由 spec_problems
    报，这里不重复判）。
    """
    lines = spec.get("lines") if isinstance(spec, dict) else None
    lines = lines if isinstance(lines, dict) else {}
    active = str(spec.get("active") or "").strip() \
        if isinstance(spec, dict) else ""
    ov = (override if override is not None else LINE_OVERRIDE).strip()
    if ov and ov in lines:
        return ov, lines[ov]
    if branch and branch in lines:
        return branch, lines[branch]
    if active and active in lines:
        return active, lines[active]
    return None, None


def _line_problems(lines):
    """每条线（line）的形状：必须是对象且字段齐。"""
    out = []
    for name in sorted(lines):
        ln = lines[name]
        if not isinstance(ln, dict):
            out.append(M("world.line_not_object", line_name=name, line=ln))
            continue
        for f in LINE_FIELDS:
            if not str(ln.get(f) or "").strip():
                out.append(M("world.line_missing_field", line_name=name,
                             field=f, fields=", ".join(LINE_FIELDS)))
    return out


def _active_problems(active, lines):
    """`active` 必须在场且是已知的线。"""
    if not active:
        return [M("world.active_missing")]
    if active not in lines:
        return [M("world.active_unknown", active=active,
                  lines=", ".join(sorted(lines)))]
    return []


def _branch_problems(branch, active, lines, override):
    """分支对账：分支是线却 ≠ active ⇒ 红（换线没跑换线脚本 —— 事故 1/2 的
    形状）。覆盖在场时是 CI 的明确选择，不替人猜。"""
    if (branch and branch in lines and active
            and branch != active and not override):
        return [M("world.branch_mismatch", branch=branch, active=active)]
    return []


def spec_problems(spec, branch, override):
    """纯函数：规格形状 + 分支对账问题（空 = 合法）。
    自证期间不许 print。

    四组判据各是一个具名 helper（容器形状 / 线形状 / active / 分支对账）：
    它们互不依赖，拼在一起只是让调用点看起来短。
    """
    if not isinstance(spec, dict):
        return [M("world.spec_not_object")]
    lines = spec.get("lines")
    if not isinstance(lines, dict) or not lines:
        return [M("world.lines_empty")]
    active = str(spec.get("active") or "").strip()
    out = _active_problems(active, lines) + _line_problems(lines)
    if override and override not in lines:
        out.append(M("world.override_unknown", line_name=override))
    return out + _branch_problems(branch, active, lines, override)


def _one_stamp_problem(name, st, run):
    """一个印章的判定。返回问题清单（空 = 通过）。"""
    if not isinstance(st, dict):
        return [M("world.stamp_not_object", name=name, entry=st)]
    value = str(st.get("value") or "").strip()
    cmd = str(st.get("cmd") or "").strip()
    if not value:
        return [M("world.stamp_missing_value", name=name)]
    if not cmd:
        return [M("world.stamp_missing_cmd", name=name)]
    rc, stdout = run(cmd)
    if rc is None:
        return [M("world.stamp_timeout", name=name, command=cmd)]
    if rc != 0:
        return [M("world.stamp_command_failed", name=name,
                  return_code=rc, command=cmd)]
    got = stdout.strip()
    if got != value:
        return [M("world.stamp_mismatch", name=name,
                  actual=quote(got), expected=quote(value))]
    return []


def stamp_problems(spec, runner=None):
    """印章对账（纯副作用只经 runner）：每个印章的 cmd
    逐字复跑，stdout 必须等于声明的 value —— 裸值契约
    与判据直接嫁接复跑闸门（`run_cmd` / `_q`）。

    单印章的判定是一个具名 helper：五个 `continue` 各是一种不同的失败
    （形状 / 缺值 / 缺命令 / 超时 / 退出码 / 值不符），挤在循环里时
    读者要数 continue 才知道哪个都覆盖了。
    """
    stamps = spec.get("stamps") if isinstance(spec, dict) else None
    if not isinstance(stamps, dict) or not stamps:
        return [M("world.stamps_empty")]
    run = runner or run_cmd
    return [p for name in sorted(stamps)
            for p in _one_stamp_problem(name, stamps[name], run)]


def _spec_path():
    """显式旋钮 > 默认名。显式配置却指向不存在的文件 ⇒
    返回该路径（run 当场 FATAL）；未配且默认名不在 ⇒
    None（未启用）。"""
    if WORLD_RAW:
        return repo(WORLD_RAW)
    p = repo("world.json")
    return p if os.path.exists(p) else None


def run(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    p = _spec_path()
    if p is None:
        return off(M("world.off"))
    if not os.path.exists(p):
        return fatal(M("world.knob_file_missing"))
    spec, err = load_spec(p)
    if err:
        return fatal(M("world.spec_broken", name=p, error=err))
    if not isinstance(spec, dict):
        return fatal(M("world.spec_shape_bad", name=p))
    branch = current_branch()
    probs = spec_problems(spec, branch, LINE_OVERRIDE)
    probs += stamp_problems(spec)
    line, world = resolve_line(spec, branch, LINE_OVERRIDE)
    return finish(M("world.title"), probs,
                  M("world.ok", line_name=line,
                    container=world.get("container"), site=world.get("site"),
                    count=len(spec.get("stamps") or {})))


def _cases_fixture():
    """夹具（原 `_cases` 的前置段原样搬入）。"""
    def line(site, art):
        return {"site": site, "artifacts": art,
                "container": "o113",
                "fork_pin_ref": "upstream/octave"}
    good = {
        "lines": {"wasm64-NEXT": line("/srv/next/site",
                                       "/srv/next/art"),
                  "IllegalPerformance": line("/srv/ip/site",
                                             "/srv/ip/art")},
        "active": "wasm64-NEXT",
        "stamps": {"container": {"value": "img-1",
                                  "cmd": "docker stamp"},
                   "site": {"value": "site-sha",
                             "cmd": "site sha"}},
    }

    def fake(outputs, rc=0):
        def r(cmd):
            return (rc, outputs.get(cmd, ""))
        return r

    match = fake({"docker stamp": "img-1", "site sha": "site-sha"})

    def all_green(spec, branch, runner):
        return (spec_problems(spec, branch, "") == []
                and stamp_problems(spec, runner) == [])

    return {'line': line, 'good': good, 'fake': fake, 'match': match, 'all_green': all_green}


def _cases_resolve(fx):
    """见 `_cases()`：本组 7 条。"""
    good, match, all_green = fx["good"], fx["match"], fx["all_green"]
    return [
    # ① 正常不报
    ("world.ok",
     lambda: all_green(good, "wasm64-NEXT", match)),
    ("world.resolve_line_by_branch",
     lambda: resolve_line(good, "wasm64-NEXT", "")
     == ("wasm64-NEXT", good["lines"]["wasm64-NEXT"])),
    ("world.resolve_line_override_wins",
     lambda: resolve_line(good, "wasm64-NEXT",
                           "IllegalPerformance")[0]
     == "IllegalPerformance"),
    ("world.resolve_line_falls_back_to_active",
     lambda: resolve_line(good, "feature/x", "")[0]
     == "wasm64-NEXT"),
    ("★ world.override_unknown",
     lambda: [p.code for p in spec_problems(good, "", "ghost")]
     == ["world.override_unknown"]),
    ("★ world.branch_mismatch",
     lambda: [p.code for p in spec_problems(
         good, "IllegalPerformance", "")] == ["world.branch_mismatch"]),
    ("world.branch_mismatch_override_present",
     lambda: spec_problems(good, "IllegalPerformance",
                            "IllegalPerformance") == []),
    ]


def _cases_stamps(fx):
    """见 `_cases()`：本组 5 条。"""
    good, fake = fx["good"], fx["fake"]
    return [
    ("★ world.stamp_mismatch",
     lambda: [p.code for p in stamp_problems(
         good, fake({"docker stamp": "img-2",
                     "site sha": "site-sha"}))] == ["world.stamp_mismatch"]),
    ("★ world.stamp_command_failed",
     lambda: [p.code for p in stamp_problems(
         good, fake({}, rc=1))] == ["world.stamp_command_failed"] * 2),
    ("★ world.stamp_timeout",
     lambda: [p.code for p in stamp_problems(
         good, fake({}, rc=None))] == ["world.stamp_timeout"] * 2),
    ("★ world.stamp_missing_cmd",
     lambda: [p.code for p in stamp_problems(
         {"stamps": {"s": {"value": "v"}}})] == ["world.stamp_missing_cmd"]),
    ("★ world.stamps_empty",
     lambda: [p.code for p in stamp_problems({"stamps": {}})]
     == ["world.stamps_empty"]),
    ]


def _cases_shape(fx):
    """见 `_cases()`：本组 6 条。"""
    good = fx["good"]
    return [
    # ② 该报的必须报
    ("★ world.lines_empty",
     lambda: [p.code for p in spec_problems(
         {"lines": {}, "active": "x", "stamps": {}}, "", "")]
     == ["world.lines_empty"]),
    ("★ world.active_missing",
     lambda: [p.code for p in spec_problems(
         {"lines": good["lines"], "stamps": {}}, "", "")]
     == ["world.active_missing"]),
    ("★ world.active_unknown",
     lambda: [p.code for p in spec_problems(
         {"lines": good["lines"], "active": "ghost",
          "stamps": {}}, "", "")] == ["world.active_unknown"]),
    ("★ world.line_missing_field",
     lambda: [p.code for p in spec_problems(
         {"lines": {"L": {"site": "s",
                          "artifacts": "a",
                          "fork_pin_ref": "r"}},
          "active": "L", "stamps": {}}, "", "")]
     == ["world.line_missing_field"]),
    # ③ 空输入必须报
    ("★ world.spec_not_object",
     lambda: [p.code for p in spec_problems(None, "", "")]
     == ["world.spec_not_object"]),
    ("★ world.lines_empty_declared",
     lambda: [p.code for p in spec_problems({}, "", "")]
     == ["world.lines_empty"]),
    ]


def _cases():
    """拼装 3 组夹具断言。**只拼装** —— 判据在各分组函数里。"""
    fx = _cases_fixture()
    return (
    _cases_resolve(fx)
    + _cases_stamps(fx)
    + _cases_shape(fx)
    )


GATE = meta("world 闸门", "声明式验证对象：多线仓库共享验证环境的世界对账",
            knobs=("REFLECT_WORLD", "REFLECT_WORLD_LINE"),
            off_reason="单线仓库不需要它：规格未配 ⇒ 明说未启用")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], "check_world", _cases(), run))
