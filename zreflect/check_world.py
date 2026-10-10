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
from gate import fatal, finish, load_spec, main_selftest_or, meta, off  # noqa: E402
from gate import repo, selftest                            # noqa: E402
from runner import quote, run_cmd                          # noqa: E402

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
            cwd=repo())
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


def spec_problems(spec, branch, override):
    """纯函数：规格形状 + 分支对账问题（空 = 合法）。
    自证期间不许 print。"""
    out = []
    if not isinstance(spec, dict):
        return ["world 声明不是对象 —— 形状坏（需要 "
                "{lines, active, stamps}）"]
    lines = spec.get("lines")
    if not isinstance(lines, dict) or not lines:
        return ["world 清单为空或不是对象 —— 空清单不是"
                "通过（零值守卫）：清单要有理由才存在"]
    active = str(spec.get("active") or "").strip()
    if not active:
        out.append("缺 active（必填：哪条线算当前是人的"
                   "决定，但决定必须写下来 —— 不写 = "
                   "每个人都猜）")
    elif active not in lines:
        out.append("active=`%s` 不在清单里（已知线：%s）"
                   % (active, ", ".join(sorted(lines))))
    for name in sorted(lines):
        ln = lines[name]
        if not isinstance(ln, dict):
            out.append("线 `%s` 不是对象：%r" % (name, ln))
            continue
        for f in LINE_FIELDS:
            if not str(ln.get(f) or "").strip():
                out.append("线 `%s` 缺字段 `%s`（必填四件"
                           "套：%s）" % (name, f,
                                          ", ".join(LINE_FIELDS)))
    if override and override not in lines:
        out.append("REFLECT_WORLD_LINE=%s 不在清单里 —— "
                   "覆盖指向不存在的线（要么写对，要么"
                   "撤掉该旋钮）" % override)
    # 分支对账：分支是线却 ≠ active ⇒ 红（换线没跑
    # 换线脚本 —— 事故 1/2 的形状）。覆盖在场时是
    # CI 的明确选择，不替人猜。
    if (branch and branch in lines and active
            and branch != active and not override):
        out.append("当前分支 `%s` 是清单里的线，但 active "
                   "声明的是 `%s` —— 换线没跑换线脚本"
                   "（或 active 忘了改）：闸门此刻验证的"
                   "世界属于另一条线" % (branch, active))
    return out


def stamp_problems(spec, runner=None):
    """印章对账（纯副作用只经 runner）：每个印章的 cmd
    逐字复跑，stdout 必须等于声明的 value —— 裸值契约
    与判据直接嫁接复跑闸门（`run_cmd` / `_q`）。"""
    out = []
    stamps = spec.get("stamps") if isinstance(spec, dict) else None
    if not isinstance(stamps, dict) or not stamps:
        return ["印章清单为空或不是对象 —— 没有印章的 "
                "world 声明守不住换线（零值守卫）：换线"
                "三步必须有证人"]
    run = runner or run_cmd
    for name in sorted(stamps):
        st = stamps[name]
        if not isinstance(st, dict):
            out.append("印章 `%s` 不是对象：%r" % (name, st))
            continue
        value = str(st.get("value") or "").strip()
        cmd = str(st.get("cmd") or "").strip()
        if not value:
            out.append("印章 `%s` 缺 value（必填：换线脚本"
                       "写下的一次实测采样）" % name)
            continue
        if not cmd:
            out.append("印章 `%s` 缺 cmd（必填：对账的复跑"
                       "命令 —— 没 cmd 的印章就是散文）" % name)
            continue
        rc, stdout = run(cmd)
        if rc is None:
            out.append("印章 `%s` 对账**超时**：`%s` —— "
                       "挂在 pre-commit 里的命令不该永远"
                       "等不到" % (name, cmd))
            continue
        if rc != 0:
            out.append("印章 `%s` 对账命令报错（rc=%s）："
                       "`%s` —— 对账方式本身死了"
                       % (name, rc, cmd))
            continue
        got = stdout.strip()
        if got != value:
            out.append("印章 `%s` 对账不符：环境=%s vs 声明=%s"
                       " —— 声明与环境不一致（换线后环境没"
                       "跟上，或环境被别的线污染）；修法是"
                       "重跑换线脚本" % (name, quote(got), quote(value)))
    return out


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
        return off("world 闸门：未配置（REFLECT_WORLD 未配且默认 "
                   "world.json 不在）⇒ 本闸门未启用（可插拔模块；"
                   "单线仓库不受益也不受损 —— 一个世界 = 现状"
                   "行为。要启用：cp zreflect/world.json.example "
                   "world.json）")
    if not os.path.exists(p):
        return fatal("REFLECT_WORLD 已配置但声明文件不在 —— "
                     "先写声明（或撤掉该旋钮）")
    spec, err = load_spec(p)
    if err:
        return fatal(err)
    if not isinstance(spec, dict):
        return fatal("world 声明 %s 形状坏：需要 {lines, active, stamps} 对象" % p)
    branch = current_branch()
    probs = spec_problems(spec, branch, LINE_OVERRIDE)
    probs += stamp_problems(spec)
    line, world = resolve_line(spec, branch, LINE_OVERRIDE)
    return finish("world 闸门", probs,
                  "world 闸门：OK（线 `%s`：容器 `%s`、站点 `%s`，"
                  "%d 枚印章对账一致）"
                  % (line, world.get("container"), world.get("site"),
                     len(spec.get("stamps") or {})))


def _cases():
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

    return [
        # ① 正常不报
        ("合法清单 + 分支=active + 印章全符 ⇒ 不报",
         lambda: all_green(good, "wasm64-NEXT", match)),
        ("解析：分支是线 ⇒ 返回分支的世界（统一 interface）",
         lambda: resolve_line(good, "wasm64-NEXT", "")
         == ("wasm64-NEXT", good["lines"]["wasm64-NEXT"])),
        ("解析：覆盖 > 分支（CI 特殊跑法）",
         lambda: resolve_line(good, "wasm64-NEXT",
                               "IllegalPerformance")[0]
         == "IllegalPerformance"),
        ("解析：分支不是线 ⇒ 回落 active（人的决定）",
         lambda: resolve_line(good, "feature/x", "")[0]
         == "wasm64-NEXT"),
        # ② 该报的必须报
        ("★ 清单空 ⇒ 必须报（零值守卫）",
         lambda: spec_problems({"lines": {}, "active": "x",
                                 "stamps": {}}, "", "") != []),
        ("★ 缺 active ⇒ 必须报（人的决定必须写下来）",
         lambda: any("缺 active" in x for x in spec_problems(
             {"lines": good["lines"], "stamps": {}}, "", ""))),
        ("★ active 不在清单 ⇒ 必须报",
         lambda: any("不在清单里" in x for x in spec_problems(
             {"lines": good["lines"], "active": "ghost",
              "stamps": {}}, "", ""))),
        ("★ 线缺字段 ⇒ 必须报（四件套）",
         lambda: any("缺字段 `container`" in x for x in
                     spec_problems(
                         {"lines": {"L": {"site": "s",
                                          "artifacts": "a",
                                          "fork_pin_ref": "r"}},
                          "active": "L", "stamps": {}}, "", ""))),
        ("★ 覆盖指向不存在的线 ⇒ 必须报（dangling 覆盖）",
         lambda: any("不在清单里" in x for x in spec_problems(
             good, "", "ghost"))),
        ("★ 分支是线却 ≠ active ⇒ 必须报（事故 1/2 形状："
         "换线没跑换线脚本）",
         lambda: any("换线没跑换线脚本" in x for x in
                     spec_problems(good, "IllegalPerformance", ""))),
        ("★ 覆盖在场 ⇒ 分支≠active 不报（CI 的明确选择）",
         lambda: spec_problems(good, "IllegalPerformance",
                                "IllegalPerformance") == []),
        ("★ 印章对账不符 ⇒ 必须报（事故 3 形状：环境被"
         "别的线污染）",
         lambda: any("对账不符" in x for x in stamp_problems(
             good, fake({"docker stamp": "img-2",
                         "site sha": "site-sha"})))),
        ("★ 印章命令 rc≠0 ⇒ 必须报（对账方式本身死了）",
         lambda: any("命令报错" in x for x in stamp_problems(
             good, fake({}, rc=1)))),
        ("★ 印章对账超时 ⇒ 必须报（挂在 pre-commit 里"
         "永远等不到）",
         lambda: any("超时" in x for x in stamp_problems(
             good, fake({}, rc=None)))),
        ("★ 印章缺 cmd ⇒ 必须报（没 cmd 的印章就是散文）",
         lambda: any("缺 cmd" in x for x in stamp_problems(
             {"stamps": {"s": {"value": "v"}}}))),
        ("★ 印章清单空 ⇒ 必须报（没有印章守不住换线）",
         lambda: stamp_problems({"stamps": {}}) != []),
        # ③ 空输入必须报
        ("★ 声明是 None ⇒ 必须报（零值守卫）",
         lambda: spec_problems(None, "", "") != []),
        ("★ 声明是 {} ⇒ 必须报",
         lambda: spec_problems({}, "", "") != []),
    ]


GATE = meta("world 闸门", "声明式验证对象：多线仓库共享验证环境的世界对账",
            knobs=("REFLECT_WORLD", "REFLECT_WORLD_LINE"))

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:],
                              "world 闸门（声明式验证对象：多线仓库的"
                              "世界对账）", _cases(), run))
