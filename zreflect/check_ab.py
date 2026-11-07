#!/usr/bin/env python3
"""A/B 同旗标不变式闸门（**可插拔模块**；源自 Octave-Full-Wasm 工单 57/61 的通用化）。

对比两个工件（构建产物身份证、基准报告、任何 JSON）的**声明面**时，唯一的合法差异
是**被测轴**本身。除此之外任何键不同 = 混淆变量混进了 A/B —— 结论作废。
真实事故：分配器 A/B 首报 −39%，事后发现基线带了运行期断言（`--diag` 全套）而候选只带
`NAMES=1` ⇒ 同旗标重测真实差 −27%。如果 A/B 前有这道闸门，−39% 根本不会落档。

规格（`REFLECT_AB`，默认 `ab.json`；数据不是代码）：

    { "pairs": [
        { "name": "分配器 A/B",
          "a": "artifacts/base/octave.build.json",
          "b": "artifacts/cand/octave.build.json",
          "key": "declared",            # 可选：JSON 内点分路径（默认整文件）
          "allow": ["malloc"],          # 被测轴（唯一允许不同的键）
          "why": "…必填…" } ] }

- 除 `allow` 外任何键的值差异 ⇒ 报（混淆变量）；
- `allow` 内的键在两件中**必须都存在且不同或同值**——都存在即可，缺失本身不算
  （缺失语义由产出方管）；
- 工件读不到 ⇒ `SKIP:` 明说（跨机器现实，不是通过）；
- `pairs` 为空 / 条目缺 why ⇒ 报（零值守卫）；
- `REFLECT_AB` 未配 ⇒ 明说未启用退 0；显式指定（--spec / 旋钮）而文件
  不在 ⇒ FATAL 退 2。

用法（cwd=仓库根）：python3 zreflect/check_ab.py [--spec ab.json]
（规格名解析：--spec 显式 > `REFLECT_AB` 旋钮 > 默认 `ab.json`）
退出码：0=绿或未启用 / 1=发现问题 / 2=配置坏。自证：--selftest（夹具注入）。
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import gate  # noqa: E402
import knobs  # noqa: E402
import machine  # noqa: E402
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

# 从旋钮登记表派生（唯一产地）—— 手写字面量会与它漂（本仓最贵的一类债）。
DEFAULT_SPEC = knobs.REGISTRY["REFLECT_AB"][1]


def resolve_spec(argv, knob=""):
    """见 `gate.resolve_spec`：实现只有一处，这里只绑定本闸门的默认名。"""
    return gate.resolve_spec(argv, knob, DEFAULT_SPEC)


def _load(path):
    try:
        return json.load(open(path, encoding="utf-8")), None
    except (OSError, ValueError) as e:
        return None, str(e)


def _dig(obj, dotted):
    cur = obj
    for k in dotted.split("."):
        if isinstance(cur, dict) and k in cur:
            cur = cur[k]
        else:
            return None
    return cur


def _pair_field_problems(pr):
    """pair 条目必填字段（name / a / b / why）缺失 ⇒ 报。"""
    return [M("ab.pair_missing_field", field=f, entry=pr)
            for f in ("name", "a", "b", "why") if not pr.get(f)]


def _declared(obj, key):
    """取声明面：key 为空 ⇒ 整文件，否则按点分路径下钻。"""
    return _dig(obj, key) if key else obj


def _confound_problems(pr, key, da, db):
    """除 allow 轴外任何键的值不一致 ⇒ 混淆变量（A/B 作废）。"""
    allow = set(pr.get("allow") or [])
    return [M("ab.confound", name=pr["name"],
              key=key or M("ab.root_label"), field=k,
              value_a=da.get(k), value_b=db.get(k))
            for k in sorted(set(da) | set(db))
            if k not in allow and da.get(k) != db.get(k)]


def _pair_problems(pr, root, loader):
    """单组 A/B 对比：字段 / 可读性 / 声明面类型 / 混淆变量。返回 (problems, skips)。"""
    problems, skips = _pair_field_problems(pr), []
    if problems:
        # 必填字段缺失 ⇒ 到此为止（后续 a/b/key 的读取会 KeyError ——
        # 「缺字段」本身就是这次要报的东西，别让它变成崩溃）。
        return problems, skips
    key = pr.get("key") or ""
    ra, ea = loader(gate.repo_path(pr["a"], root))
    rb, eb = loader(gate.repo_path(pr["b"], root))
    if ra is None or rb is None:
        skips.append(M("ab.artifact_unreadable", name=pr["name"],
                       error_a=ea or "", error_b=eb or ""))
        return problems, skips
    da, db = _declared(ra, key), _declared(rb, key)
    if not isinstance(da, dict) or not isinstance(db, dict):
        problems.append(M("ab.not_a_dict", name=pr["name"],
                          key=key or M("ab.root_label")))
        return problems, skips
    return problems + _confound_problems(pr, key, da, db), skips


def check(spec, root, loader=_load):
    """纯逻辑（自证注入 loader）。返回 (problems, skips)。"""
    pairs = spec.get("pairs") or []
    if not pairs:
        return [M("ab.empty")], []
    problems, skips = [], []
    for pr in pairs:
        probs, sks = _pair_problems(pr, root, loader)
        problems += probs
        skips += sks
    return problems, skips


def main(argv):
    spec_path, explicit = resolve_spec(argv, os.environ.get("REFLECT_AB", ""))
    path = gate.repo_path(spec_path)
    if not os.path.isfile(path):
        if explicit:
            return fatal(M("ab.explicit_spec_missing", name=spec_path))
        return off(M("ab.off", name=spec_path))
    spec, err = load_spec(path)
    if err:
        return fatal(M("ab.spec_broken", name=spec_path, error=err))
    problems, skips = check(spec, repo())
    for x in skips:
        print(machine().emit("skip", str(x)), file=sys.stderr)
    return finish(M("ab.title"), problems,
                  M("ab.ok", count=len(spec.get("pairs") or [])))


def _cases():
    import atexit  # noqa: PLC0415
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    atexit.register(shutil.rmtree, d, True)

    def wf(rel, obj):
        p = os.path.join(d, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        json.dump(obj, open(p, "w", encoding="utf-8"))
        return rel
    spec = {"pairs": [
        {"name": "allocator A/B", "a": "a.json", "b": "b.json", "key": "declared",
         "allow": ["malloc"], "why": "axis under test = allocator"}]}
    # a/b：除 malloc 外全等
    wf("a.json", {"declared": {"simd": True, "malloc": "mimalloc", "v128": 4752}})
    wf("b.json", {"declared": {"simd": True, "malloc": "dlmalloc", "v128": 4752}})
    wf("mut-a.json", {"declared": {"simd": True, "malloc": "mimalloc", "v128": 4752}})
    wf("mut-b.json", {"declared": {"simd": False, "malloc": "mimalloc", "v128": 4752}})
    wf("nokey.json", {"declared": "not-a-dict"})
    empty = {"pairs": []}
    confound_spec = {"pairs": [{"name": "m", "a": "mut-a.json", "b": "mut-b.json",
                                "key": "declared", "allow": ["malloc"], "why": "w"}]}
    return [
        ("ab.resolve_spec",
         lambda: resolve_spec(["--spec", "x.json"], "K.json") == ("x.json", True)
         and resolve_spec([], "K.json") == ("K.json", True)
         and resolve_spec([], "") == ("ab.json", False)
         and resolve_spec([], "  ") == ("ab.json", False)),
        # ① 正常不报
        ("ab.ok", lambda: check(spec, d)[0] == []),
        # ② 该报的必须报
        ("★ ab.confound",
         lambda: [p.code for p in check(confound_spec, d)[0]] == ["ab.confound"]),
        ("★ ab.artifact_unreadable",
         lambda: [p.code for p in check(
             {"pairs": [{"name": "x", "a": "nope-a.json", "b": "nope-b.json",
                         "why": "w"}]}, d)[1]] == ["ab.artifact_unreadable"]),
        ("★ ab.not_a_dict",
         lambda: [p.code for p in check(
             {"pairs": [{"name": "x", "a": "nokey.json", "b": "nokey.json",
                         "key": "declared", "why": "w"}]}, d)[0]] == ["ab.not_a_dict"]),
        ("★ ab.pair_missing_field",
         lambda: [p.code for p in check(
             {"pairs": [{"a": "a.json", "b": "b.json", "why": "w"}]}, d)[0]]
         == ["ab.pair_missing_field"]),
        # ③ 空输入必须报
        ("★ ab.empty",
         lambda: [p.code for p in check(empty, d)[0]] == ["ab.empty"]),
    ]


GATE = meta("A/B 闸门", "A/B 同旗标不变式（非 allow 轴差异 = 混淆变量，A/B 作废）",
            knobs=("REFLECT_AB",),
            off_reason="不做 A/B 对照实验的仓不需要它：规格未配 ⇒ 明说未启用")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], "check_ab", _cases, main))
