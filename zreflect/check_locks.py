#!/usr/bin/env python3
"""锁定源清单闸门（**可插拔模块**；源自 Octave-Full-Wasm 仓库架构批的通用化）。

不是每个上游都有可 git 化的官方仓（netlib 的 f2c/lapack 老版、freedesktop 的 glu、
sourceforge 的 qrupdate…）。对它们，"钉版"只能退而求其次：**URL + 文件 + sha256**
的锁定清单。本闸门核对这份清单：

    { "locked": [
        { "name": "glpk", "version": "5.0",
          "url": "https://ftp.gnu.org/gnu/glpk/glpk-5.0.tar.gz",
          "file": "third_party/glpk-5.0.tar.gz",      # 相对仓库根或绝对
          "sha256": "…" },                             # 文件形态必填；目录形态可省
        { "name": "lapack", "version": "3.4.2", "file": "…/lapack-3.4.2",
          "form": "dir", "optional": true } ] }

- 文件形态：**sha256 必填且必须匹配**（缺失/不符都报——这是"钉版"的全部含义）；
- 目录形态：只查存在（目录无单值哈希；`optional: true` 的条目在本机缺席 ⇒ SKIP
  明说，不是通过——跨机器构建的仓库需要这个口子）；
- `locked` 为空 / 条目缺 name/url ⇒ 报（零值守卫；没有理由的锁定条目是僵尸）。

与 `check_invariants`（#7）正交：那边守"文件该长什么样（文本）"，这边守
"外部工件的**内容指纹**"——它们共同把"上游"从散装 tarball 变成可查事实。

**边界（不藏）**：sha256 只证明"还是那份字节"，不证明"那份字节是对的"——
URL 与版本的对应关系是清单作者的主张，闸门不做网络验证（重取是 build 脚本的事）。

用法（cwd=仓库根）：python3 zreflect/check_locks.py [--spec upstream-lock.json]
（规格名解析：--spec 显式 > 默认 `upstream-lock.json`；显式指定而文件不在 ⇒ FATAL 2）
退出码：0=绿或未启用 / 1=问题 / 2=配置坏。自证：--selftest。
"""
from __future__ import annotations

import hashlib
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
DEFAULT_SPEC = knobs.REGISTRY["REFLECT_LOCKS"][1]


def resolve_spec(argv, knob=""):
    """见 `gate.resolve_spec`：实现只有一处，这里只绑定本闸门的默认名。"""
    return gate.resolve_spec(argv, knob, DEFAULT_SPEC)


def _sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


REQUIRED_FIELDS = ("name", "url", "file")


def _entry_missing_fields(entry):
    """缺字段的问题清单。**任一缺失 ⇒ 这条不可检查**（不能拿 None 去 hasher）。"""
    return [M("locks.entry_missing_field", field=f, entry=entry)
            for f in REQUIRED_FIELDS if not entry.get(f)]


def _check_one(entry, hasher, root):
    """检查一条锁定项。返回 `(问题清单, 跳过清单)`。"""
    missing = _entry_missing_fields(entry)
    if missing:
        return missing, []
    path = gate.repo_path(entry["file"], root)
    if not os.path.exists(path):
        if entry.get("optional"):
            return [], [M("locks.absent_optional", name=entry["name"])]
        return [M("locks.file_missing", name=entry["name"], path=path)], []
    want = entry.get("sha256")
    if not want:
        if (entry.get("form") or "file") == "dir":
            return [], []                     # 目录形态：只查存在
        return [M("locks.no_sha256", name=entry["name"])], []
    got = hasher(path)
    if got != want:
        return [M("locks.sha_mismatch", name=entry["name"],
                  declared=want[:12], actual=got[:12])], []
    return [], []


def check(spec, hasher=_sha, root=None):
    """纯逻辑（自证注入 hasher）。返回 (problems, skips)。

    `root` = 相对 file 路径的锚（默认被检查仓库根；自证传夹具目录）。

    单条检查是一个具名 helper（`_check_one`）：此前它的 `problems[-1].code`
    回看上一轮追加的条目来判断「这条缺字段」—— 那既脆（别人在中间追加一条
    就失效）又把复杂度推到 12。现在缺字段是**返回值**，不是上下文。
    """
    root = repo() if root is None else root
    locked = spec.get("locked") or spec.get("sources") or []
    if not locked:
        return [M("locks.empty")], []
    problems, skips = [], []
    for entry in locked:
        probs, sk = _check_one(entry, hasher, root)
        problems += probs
        skips += sk
    return problems, skips


def main(argv):
    spec_path, explicit = resolve_spec(argv, os.environ.get("REFLECT_LOCKS", ""))
    path = gate.repo_path(spec_path)
    if not os.path.isfile(path):
        if explicit:
            return fatal(M("locks.explicit_spec_missing", name=spec_path))
        return off(M("locks.off", name=spec_path))
    spec, err = load_spec(path)
    if err:
        return fatal(M("locks.spec_broken", name=spec_path, error=err))
    problems, skips = check(spec)
    for x in skips:
        print(machine().emit("skip", str(x)), file=sys.stderr)
    return finish(M("locks.title"), problems,
                  M("locks.ok", count=len(spec.get("locked")
                                         or spec.get("sources") or [])))


def _cases():
    import atexit  # noqa: PLC0415
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    d = tempfile.mkdtemp()
    atexit.register(shutil.rmtree, d, True)
    payload = b"UPSTREAM-FIXTURE"
    good = hashlib.sha256(payload).hexdigest()
    open(os.path.join(d, "glpk.tar.gz"), "wb").write(payload)
    os.makedirs(os.path.join(d, "lapack-3.4.2"))
    # 夹具用**绝对路径**（引擎按仓库根解析相对路径；夹具树在临时目录）
    g = os.path.join(d, "glpk.tar.gz")
    lp = os.path.join(d, "lapack-3.4.2")
    spec = {"locked": [
        {"name": "glpk", "version": "5.0", "url": "u", "file": g, "sha256": good},
        {"name": "lapack", "version": "3.4.2", "url": "u", "file": lp, "form": "dir"},
        {"name": "mesa", "version": "x", "url": "u", "file": "nope.tar.xz", "optional": True},
    ]}
    bad_hash = {"locked": [{"name": "glpk", "version": "5.0", "url": "u",
                            "file": g, "sha256": "0" * 64}]}
    missing = {"locked": [{"name": "glpk", "version": "5.0", "url": "u", "file": "nope.tar.gz",
                           "sha256": good}]}
    no_sha = {"locked": [{"name": "glpk", "version": "5.0", "url": "u", "file": g}]}
    empty = {"locked": []}
    return [
        ("locks.resolve_spec",
         lambda: resolve_spec(["--spec", "x.json"], "K.json") == ("x.json", True)
         and resolve_spec([], "K.json") == ("K.json", True)
         and resolve_spec([]) == ("upstream-lock.json", False)),
        # ① 正常不报
        ("locks.ok",
         lambda: check(spec, root=d)[0] == [] and check(spec, root=d)[1] != []),
        # ② 该报的必须报
        ("★ locks.sha_mismatch",
         lambda: [p.code for p in check(bad_hash, root=d)[0]] == ["locks.sha_mismatch"]),
        ("★ locks.file_missing",
         lambda: [p.code for p in check(missing, root=d)[0]] == ["locks.file_missing"]),
        ("★ locks.no_sha256",
         lambda: [p.code for p in check(no_sha, root=d)[0]] == ["locks.no_sha256"]),
        # ③ 空输入必须报
        ("★ locks.empty",
         lambda: [p.code for p in check(empty, root=d)[0]] == ["locks.empty"]),
    ]


GATE = meta("锁定源闸门", "锁定源清单（URL + 文件 + sha256 的内容指纹）",
            knobs=("REFLECT_LOCKS",),
            off_reason="不钉上游字节的仓不需要它：规格未配 ⇒ 明说未启用")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], M("gate.title.locks"), _cases, main))
