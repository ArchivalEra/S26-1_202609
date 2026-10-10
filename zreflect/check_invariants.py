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
from gate import fatal, finish, load_spec, main_selftest_or, meta, off  # noqa: E402
from gate import repo, selftest                            # noqa: E402

INVARIANTS_RAW = os.environ.get("REFLECT_INVARIANTS", "").strip()


def problems(checks, read=None):
    """纯函数：返回问题清单（空 = 绿）。自证期间不许 print。

    `read(path) -> str` 可注入（自证用假文件系统 —— 真文件
    进了自证，自证就依赖机器了）。判据 = 片段的**存在/
    不存在**（grep 级，见模块文档的边界）。
    """
    out = []
    if not checks:
        return ["不变量清单为空 —— 空清单不是通过（零值守卫）："
                "清单要有理由才存在"]
    read = read or (lambda p: open(repo(p), encoding="utf-8").read())
    for c in checks:
        if not isinstance(c, dict):
            out.append("检查项不是对象：%r" % (c,))
            continue
        path = str(c.get("path") or "").strip()
        why = str(c.get("why") or "").strip()
        mc = c.get("must_contain")
        mnc = c.get("must_not_contain")
        if not path:
            out.append("检查项缺 path（必填）：%r" % (c,))
            continue
        if not why:
            out.append("`%s` 缺 why（必填：没有理由的检查项没人"
                       "敢删，会变成僵尸）" % path)
        if not isinstance(mc, list) and not isinstance(mnc, list):
            out.append("`%s` 没有任何判据（must_contain / "
                       "must_not_contain 至少给一个）" % path)
            continue
        if (mc is not None and not isinstance(mc, list)) or \
                (mnc is not None and not isinstance(mnc, list)):
            out.append("`%s` 的 must_contain / must_not_contain "
                       "必须是字符串数组" % path)
            continue
        if any(not isinstance(x, str) for x in (mc or [])) or \
                any(not isinstance(x, str) for x in (mnc or [])):
            out.append("`%s` 的判据片段必须是字符串" % path)
            continue
        try:
            text = read(path)
        except OSError:
            out.append("`%s` 读不到（文件在吗？路径相对仓库根）"
                       "—— 读不到就明说，不许静默通过" % path)
            continue
        for frag in mc or []:
            if frag not in text:
                out.append("DRIFT: `%s` 缺少应有片段 %r（%s）"
                           % (path, frag, why))
        for frag in mnc or []:
            if frag in text:
                out.append("DRIFT: `%s` 出现被禁片段 %r（%s）"
                           % (path, frag, why))
    return out


def run(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    name = INVARIANTS_RAW
    if not name:
        return off("不变量闸门：REFLECT_INVARIANTS 未配置 ⇒ 本闸门未启用"
                   "（可插拔模块；要启用：REFLECT_INVARIANTS=invariants.json，"
                   "规格 = {\"checks\": [{path, must_contain?, "
                   "must_not_contain?, why}]}）")
    spec_path = repo(name)
    if not os.path.exists(spec_path):
        return fatal("REFLECT_INVARIANTS=%s 已配置但规格文件不在 —— "
                     "先写规格（或撤掉该旋钮）" % name)
    spec, err = load_spec(spec_path)
    if err:
        return fatal(err)
    checks = spec.get("checks") if isinstance(spec, dict) else None
    if not isinstance(checks, list):
        return fatal("规格文件 %s 形状坏：需要 {\"checks\": [...]}" % spec_path)
    return finish("不变量闸门", problems(checks),
                  "不变量闸门：OK（%d 条不变量）" % len(checks))


def _cases():
    def fake_read(files):
        def r(path):
            if path not in files:
                raise FileNotFoundError(path)
            return files[path]
        return r
    good = fake_read({"a.sh": "ALLOW_TABLE_GROWTH=1\n"
                               "SFLAGS=(-sMEMORY64=1)"})
    return [
        # ① 正常不报
        ("must_contain 在 ⇒ 不报",
         lambda: problems([{"path": "a.sh", "why": "w",
                               "must_contain": ["ALLOW_TABLE_GROWTH=1"]}],
                             read=good) == []),
        ("must_not_contain 不在 ⇒ 不报",
         lambda: problems([{"path": "a.sh", "why": "w",
                               "must_not_contain": ["-flto"]}],
                             read=good) == []),
        ("两条判据同时满足 ⇒ 不报",
         lambda: problems([{"path": "a.sh", "why": "w",
                               "must_contain": ["ALLOW_TABLE_GROWTH=1"],
                               "must_not_contain": ["-flto"]}],
                             read=good) == []),
        # ② 该报的必须报
        ("★ must_contain 缺失 ⇒ 必须报（DRIFT）",
         lambda: any("DRIFT" in x and "缺少应有片段" in x
                     for x in problems([{"path": "a.sh", "why": "w",
                                            "must_contain": ["-flto"]}],
                                           read=good))),
        ("★ must_not_contain 出现 ⇒ 必须报（DRIFT）",
         lambda: any("DRIFT" in x and "被禁片段" in x
                     for x in problems([{"path": "a.sh", "why": "w",
                                            "must_not_contain":
                                                ["ALLOW_TABLE_GROWTH=1"]}],
                                           read=good))),
        ("★ 文件读不到 ⇒ 必须报（读不到就明说）",
         lambda: any("读不到" in x
                     for x in problems([{"path": "b.sh", "why": "w",
                                            "must_contain": ["x"]}],
                                           read=good))),
        ("★ 缺 why ⇒ 必须报（僵尸守卫）",
         lambda: any("缺 why" in x
                     for x in problems([{"path": "a.sh",
                                            "must_contain": ["x"]}],
                                           read=good))),
        ("★ 缺 path ⇒ 必须报",
         lambda: any("缺 path" in x
                     for x in problems([{"why": "w",
                                            "must_contain": ["x"]}],
                                           read=good))),
        ("★ 无判据 ⇒ 必须报",
         lambda: any("没有任何判据" in x
                     for x in problems([{"path": "a.sh", "why": "w"}],
                                           read=good))),
        # ③ 空输入必须报
        ("★ 空清单 ⇒ 必须报（零值守卫）",
         lambda: problems([], read=good) != []),
    ]


GATE = meta("不变量闸门", "声明式不变量：仓库文件必须/不得含某片段（grep 级）",
            knobs=("REFLECT_INVARIANTS",))

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:],
                              "不变量闸门（声明式：仓库文件必须/不得含某片段）",
                              _cases(), run))
