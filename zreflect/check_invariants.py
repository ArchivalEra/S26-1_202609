#!/usr/bin/env python3
"""声明式不变量闸门（**可插拔模块**，issue #7）。

「仓库文件必须/不得含某片段」做成**数据**（JSON 规格），
引擎通用、与仓无关。规格文件：

    { "checks": [
        { "path": "build/113/link-web.sh",
          "must_contain": ["ALLOW_TABLE_GROWTH=1"],
          "must_not_contain": ["-flto"],
          "why": "dlopen 需可增长函数表；-flto 是被证伪的杠杆" } ] }

引擎只读文件、**不构建、不碰容器、不跑网络** ⇒ 能进
pre-commit。零值守卫：清单为空 / 检查项缺 path / 读不到
文件 ⇒ 都报（不是静默通过）。`why` 必填是有意的：没有
理由的检查项没人敢删，会变成僵尸。

**边界（issue #7 明说的，不藏）**：这是 **grep 级**不变式
—— 分不清注释与代码（片段出现在注释里也算"存在"），它
证明的是"这段文字还在"，不是"代码里真在用"。声明式检查
的强度上限 = 它匹配的文本形态。要更强保证的，别用 grep：
那是 `calibrate`（对**产物**量）或 `witness`（对**来源**
量）的活。与 `calibrate`（#6 ①）正交、别混：一个守
**量测仪器**，一个守**仓库文件本身**（配方/源码该长
什么样）。

**可插拔**：`REFLECT_INVARIANTS` 未配 ⇒ 明说未启用、退 0
（不配的仓库完全不受影响；发现式名录照样收编它，自证
照样证明它能红）。与 `collect.py` 原则 5 的接法：
不变量文件 = 输入落点；不变量闸门 = 该落点的便宜来源
不变式。

用法（直接跑，cwd=仓库根）：
    python3 zreflect/check_invariants.py [--selftest]
退出码：0=绿 / 1=发现问题 / 2=配置或环境坏了（配置性失败 ≠ 检查失败）。
"""
from __future__ import annotations

import os
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

INVARIANTS_RAW = os.environ.get("REFLECT_INVARIANTS", "").strip()


def _shape_problems(c):
    """一条检查项的形状校验：返回 `(问题清单, 规范化字段或 None)`。

    「形状坏」与「内容不符」是两件事：形状坏时**没有可比的片段**，
    必须早退（否则 `frag not in text` 会 TypeError）。五道守挤在调用点
    就是 5 个连续 `continue`（复杂度 14）。
    """
    if not isinstance(c, dict):
        return [M("invariants.not_object", entry=c)], None
    path = str(c.get("path") or "").strip()
    why = str(c.get("why") or "").strip()
    mc, mnc = c.get("must_contain"), c.get("must_not_contain")
    if not path:
        return [M("invariants.missing_path", entry=c)], None
    out = [] if why else [M("invariants.missing_why", path=path)]
    crit = _criteria_problems(path, mc, mnc)
    if crit is not None:
        return out + crit, None
    return out, (path, why, mc or [], mnc or [])


def _criteria_problems(path, mc, mnc):
    """判据字段（must_contain / must_not_contain）的形状校验。

    返回 None = 形状可用；返回清单 = 形状坏（调用方早退）。
    三个坏形状各是一道守（没有判据 / 不是清单 / 元素不是串），从
    `_shape_problems` 拆出来 —— 那边剩的是「逐字段收值」，这边是「判据本身」。
    """
    if not isinstance(mc, list) and not isinstance(mnc, list):
        return [M("invariants.no_criteria", path=path)]
    if (mc is not None and not isinstance(mc, list)) or \
            (mnc is not None and not isinstance(mnc, list)):
        return [M("invariants.not_string_list", path=path)]
    if any(not isinstance(x, str) for x in (mc or [])) or \
            any(not isinstance(x, str) for x in (mnc or [])):
        return [M("invariants.fragment_not_string", path=path)]
    return None


def _content_problems(path, why, mc, mnc, read):
    """片段比对：`must_contain` 必须都在、`must_not_contain` 必须都不在。"""
    try:
        text = read(path)
    except OSError:
        return [M("invariants.unreadable", path=path)]
    out = []
    for frag in mc:
        if frag not in text:
            # `DRIFT` 是机器可读标记：**字面量留在发射点**（参数值），
            # 语言包只负责把它摆进句子里 —— 包值不许以 `^[A-Z][A-Z0-9_]*:`
            # 开头（否则一条翻译就能伪装成机器契约行，见 i18n._validate）。
            out.append(M("invariants.drift_missing", marker="DRIFT",
                         path=path, fragment=frag, why=why))
    for frag in mnc:
        if frag in text:
            out.append(M("invariants.drift_forbidden", marker="DRIFT",
                         path=path, fragment=frag, why=why))
    return out


def problems(checks, read=None):
    """纯函数：返回问题清单（空 = 绿）。自证期间不许 print。

    `read(path) -> str` 可注入（自证用假文件系统 —— 真文件
    进了自证，自证就依赖机器了）。判据 = 片段的**存在/
    不存在**（grep 级，见模块文档的边界）。

    两段各是一个 helper（形状 / 内容）：形状坏时没有可比的片段，
    必须早退 —— 把两段拼在一起时，5 个形状守 + 2 个内容守 = 复杂度 14。
    """
    if not checks:
        return [M("invariants.empty")]
    read = read or (lambda p: open(repo(p), encoding="utf-8").read())
    out = []
    for c in checks:
        shape_probs, spec = _shape_problems(c)
        out += shape_probs
        if spec is not None:
            out += _content_problems(*spec, read=read)
    return out


def run(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    name = INVARIANTS_RAW
    if not name:
        return off(M("invariants.off"))
    spec_path = repo(name)
    if not os.path.exists(spec_path):
        return fatal(M("invariants.spec_missing", name=name))
    spec, err = load_spec(spec_path)
    if err:
        return fatal(M("invariants.spec_broken", name=spec_path, error=err))
    checks = spec.get("checks") if isinstance(spec, dict) else None
    if not isinstance(checks, list):
        return fatal(M("invariants.bad_shape", path=spec_path))
    return finish(M("invariants.title"), problems(checks),
                  M("invariants.ok", count=len(checks)))


def _fake_read(files):
    """假文件系统：不给的文件名抛 `FileNotFoundError`（真读路径的 OSError）。"""
    def r(path):
        if path not in files:
            raise FileNotFoundError(path)
        return files[path]
    return r


def _cases_ok(read):
    """① 正常不报：片段在 / 不在都符合声明。"""
    return [
        ("invariants.must_contain_present",
         lambda: problems([{"path": "a.sh", "why": "w",
                            "must_contain": ["ALLOW_TABLE_GROWTH=1"]}],
                         read=read) == []),
        ("invariants.must_not_contain_absent",
         lambda: problems([{"path": "a.sh", "why": "w",
                            "must_not_contain": ["-flto"]}],
                         read=read) == []),
        ("invariants.both_criteria_met",
         lambda: problems([{"path": "a.sh", "why": "w",
                            "must_contain": ["ALLOW_TABLE_GROWTH=1"],
                            "must_not_contain": ["-flto"]}],
                         read=read) == []),
    ]


def _cases_content(read):
    """② 该报的必须报：内容不符 / 读不到。"""
    return [
        ("\u2605 invariants.drift_missing",
         lambda: [x.code for x in problems(
             [{"path": "a.sh", "why": "w", "must_contain": ["-flto"]}],
             read=read)] == ["invariants.drift_missing"]),
        ("\u2605 invariants.drift_forbidden",
         lambda: [x.code for x in problems(
             [{"path": "a.sh", "why": "w",
               "must_not_contain": ["ALLOW_TABLE_GROWTH=1"]}],
             read=read)] == ["invariants.drift_forbidden"]),
        ("\u2605 invariants.unreadable",
         lambda: [x.code for x in problems(
             [{"path": "b.sh", "why": "w", "must_contain": ["x"]}],
             read=read)] == ["invariants.unreadable"]),
        # why 缺了**先报**（它不 continue：同一检查项可能还有 DRIFT，两条都报）
        ("\u2605 invariants.missing_why",
         lambda: [x.code for x in problems(
             [{"path": "a.sh", "must_contain": ["x"]}],
             read=read)] == ["invariants.missing_why",
                             "invariants.drift_missing"]),
    ]


def _cases_shape(read):
    """② 该报的必须报：规格形状坏了（五道守）。"""
    return [
        ("\u2605 invariants.missing_path",
         lambda: [x.code for x in problems(
             [{"why": "w", "must_contain": ["x"]}],
             read=read)] == ["invariants.missing_path"]),
        ("\u2605 invariants.no_criteria",
         lambda: [x.code for x in problems(
             [{"path": "a.sh", "why": "w"}],
             read=read)] == ["invariants.no_criteria"]),
        ("\u2605 invariants.not_object",
         lambda: [x.code for x in problems(["not-a-dict"], read=read)
                  ] == ["invariants.not_object"]),
        ("\u2605 invariants.not_string_list",
         # 一条 list、另一条非 list（两侧都非 list 走的是 no_criteria）
         lambda: [x.code for x in problems(
             [{"path": "a.sh", "why": "w", "must_contain": ["x"],
               "must_not_contain": "y"}],
             read=read)] == ["invariants.not_string_list"]),
        ("\u2605 invariants.fragment_not_string",
         lambda: [x.code for x in problems(
             [{"path": "a.sh", "why": "w", "must_contain": [1]}],
             read=read)] == ["invariants.fragment_not_string"]),
    ]


def _cases():
    read = _fake_read({"a.sh": "ALLOW_TABLE_GROWTH=1\n"
                              "SFLAGS=(-sMEMORY64=1)"})
    return (_cases_ok(read) + _cases_content(read) + _cases_shape(read)
            # ③ 空输入必须报
            + [("\u2605 invariants.empty",
                lambda: [x.code for x in problems([], read=read)]
                == ["invariants.empty"])])


GATE = meta("不变量闸门", "声明式不变量：仓库文件必须/不得含某片段（grep 级）",
            knobs=("REFLECT_INVARIANTS",),
            off_reason="不写声明式不变量的仓不需要它：规格未配 ⇒ 明说未启用（可插拔）")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:],
                              M("gate.title.invariants"),
                              _cases(), run))
