#!/usr/bin/env python3
"""三语 README 同步闸门：语言版本是同一条断言的三份拷贝 —— 不同批动，就是漂移。

门面 README 有三份语言拷贝（默认 `README.md` 英语 + `README.zh.md` + `README.de.md`，
名单见 `REFLECT_READMES`）。三语化引入一个新的静默坏法：**改了一份、放任另两份** ⇒
三份从"同一句话"变成互相矛盾的断言。用户的纪律（2026-10-01）刻意做得苛刻：
**每次推送必须三份同批更新** —— 本闸门是它的判据与证人：

  · 默认模式（pre-commit / 手动 / gates-selftest 跑的是它）：**结构判据** ——
    `REFLECT_READMES` 声明的每份 README 必须存在、非空、且含 trio 全部文件名
    （语言切换器必须指全所有语言：切换器断 = 入口断）。
    单条目清单（`REFLECT_READMES=maintaince.md`）⇒ 互链判据**退化**：
    只有一份语言时「必须指全全部语言」自动成立，自引用是退化要求
    （issue #8）—— 此时互链不查，由 run() 明说「不适用」（与其他
    闸门声明 off 状态的同款）；存在 / 非空判据照常；
  · `--changed <文件|->`：**推送集判据** —— 从文件（或 `-` = stdin）读本次推送
    改动的文件路径（一行一个），**每份 README 都必须在改动集里**，缺一份报一份。
    改动集为空 ⇒ 必须报（空不是通过）。pre-push 与 CI 走这个模式。
    ⚠️ 推送集判据**不退化**：单条目时「每次推送必须更新它」仍是实打实的判据。

零值守卫：`REFLECT_READMES` 为空 ⇒ 报（拿空清单判"README 组"是空话）；推送模式收到
空改动集 ⇒ 报。

⚠️ 诚实的边界：pre-push 可被 `git push --no-verify` 跳过 —— 那是 git 的原生出口，
任何 hook 都拦不住它。所以 CI（`.github/workflows/readme-sync.yml`）跑**同一条判据**：
本地 hook 是第一时间疼，CI 才是承诺的正面。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gate import (  # noqa: E402
    finish,
    machine,  # noqa: E402
    main_selftest_or,
    meta,
    repo,
)
from i18n import M  # noqa: E402


def lang_names():
    """三语 README 名单 —— 转调 `knobs.readme_names()`（唯一产地）。

    ⚠️ 此前这里自己 `os.environ.get("REFLECT_READMES", READMES)`：**空串不
    回落** —— `REFLECT_READMES=`（空 = 没配）返回 `()`，下游零值守卫把它
    当「拿空清单判 README 组」报错；而 `knobs.readme_names()` 同一环境下
    正确回落登记表。两份判据、空串语义分叉（实测）。
    """
    import knobs  # noqa: PLC0415
    return tuple(knobs.readme_names())


def problems_structure(files, langs):
    """结构判据（纯函数：自证要用）。`files` = {名字: 正文（读不到就没有这个键）}。"""
    out = []
    if not langs:
        # 零值守卫：清单为空 ⇒ 「README 组都齐」是一句无法判定的话。
        return [M("readme.names_empty_structure")]
    # 单条目 ⇒ 互链判据退化（issue #8）：只有一份语言时「切换器必须
    # 指全全部语言」自动成立，自引用是退化要求。存在 / 非空判据照常，
    # 互链不查（退化判据由 run() 明说不适用 —— 不许假装查过）。
    switcher_applies = len(langs) > 1
    for name in langs:
        if name not in files:
            out.append(M("readme.file_missing", name=name))
            continue
        body = files[name] or ""
        if not body.strip():
            out.append(M("readme.file_empty", name=name))
        if not switcher_applies:
            continue
        for other in langs:
            if other not in body:
                out.append(M("readme.switcher_incomplete",
                             name=name, expected=other))
    return out


def problems_push(changed, langs):
    """推送集判据（纯函数）。`changed` = 本次推送改动过的文件路径集合。

    **条件式**（与 AGENTS 原话一致：「改任何一份 ⇒ 这次推送的改动集必须三份
    全含」）：
      · 一份 README 都没改 ⇒ 不适用（纯代码 / 纯文档提交不该被拦）
      · 改了至少一份 ⇒ 三份都必须在推送集里（缺一份报一份）

    **两种名单形态，两条判据**（文档第 12/19 行的区分）：

      · **多条目**（默认三语 trio）⇒ **条件式**：「改任何一份 ⇒ 这次推送的
        改动集必须三份全含」。一份都没碰 ⇒ 不适用（纯代码提交不该被拦）。
      · **单条目**（`REFLECT_READMES=maintaince.md` 这种「把一份活文档当
        README」的用法）⇒ **无条件**：「每次推送必须更新它」。这是更强的那条
        —— 单份清单没有「同批」可言，它的判据就是「必须有」。

    ⚠️ 此前对**多条目**也是无条件，于是任何不改 README 的提交都被判红
    （CI 上连续红：`0cef263` 只改了 `i18n.py` + 台账）。多条目按文档是条件式。
    """
    out = []
    if not langs:
        return [M("readme.names_empty_push")]
    if not changed:
        return [M("readme.changed_empty")]
    multi = len(langs) > 1
    # 多条目的条件式：一份都没碰 ⇒ 不适用
    if multi and not any(name in changed for name in langs):
        return []
    for name in langs:
        if name not in changed:
            out.append(M("readme.not_in_push", name=name))
    return out


def run(argv):
    langs = lang_names()
    if argv and argv[0] == "--changed":
        src = argv[1] if len(argv) > 1 else "-"
        if src == "-":
            lines = sys.stdin.read().splitlines()
        elif not os.path.exists(src):
            print(machine().emit("fatal", M("readme.changed_file_missing", name=src)),
                  file=sys.stderr)
            return 2
        else:
            lines = open(src, encoding="utf-8", errors="replace").read().splitlines()
        changed = {l.strip().strip('"') for l in lines if l.strip()}
        probs = problems_push(changed, langs)
        return finish(M("readme.title"), probs,
                      M("readme.ok_push", count=len(langs)))
    files = {}
    for name in langs:
        p = repo(name)
        if os.path.exists(p):
            files[name] = open(p, encoding="utf-8", errors="replace").read()
    if len(langs) == 1:
        # 退化的互链判据要说出口（issue #8）—— 与其他闸门声明
        # 「未启用」同款：单条目时互链自动成立，不许假装查过。
        print(M("readme.switcher_not_applicable", name=langs[0]),
              file=sys.stderr)
    probs = problems_structure(files, langs)
    if len(langs) == 1:
        return finish(M("readme.title"), probs,
                      M("readme.ok_single", name=langs[0]))
    return finish(M("readme.title"), probs,
                  M("readme.ok_structure", count=len(langs)))


LANGS = ("README.md", "README.zh.md", "README.de.md")


def _trio():
    return dict.fromkeys(LANGS, "x [%s](%s) [%s](%s) [%s](%s) x" % (LANGS * 2))


def _cases_structure():
    """① 结构判据：互链（trio）/ 存在 / 非空（单条目）。"""
    return [
        ("readme.trio_linked",
         lambda: problems_structure(_trio(), LANGS) == []),
        # ① 正常不报（单条目：互链判据退化，issue #8）
        ("readme.single_no_self_reference",
         lambda: problems_structure({"maintaince.md": "# rules\n\nno links here."},
                                    ("maintaince.md",)) == []),
        ("\u2605 readme.file_missing",
         lambda: [p.code for p in problems_structure(
             {k: v for k, v in _trio().items() if k != "README.de.md"}, LANGS)]
         == ["readme.file_missing"]),
        ("\u2605 readme.switcher_incomplete",
         lambda: [p.code for p in problems_structure(
             dict(_trio(), **{"README.md": "only [README.md](README.md) and "
                                            "[README.zh.md](README.zh.md)"}),
             LANGS)] == ["readme.switcher_incomplete"]),
        ("\u2605 readme.file_empty",
         lambda: "readme.file_empty" in [p.code for p in problems_structure(
             dict(_trio(), **{"README.zh.md": "   \n"}), LANGS)]),
        # 单条目：存在 / 非空不退化（issue #8）
        ("\u2605 readme.single_file_missing",
         lambda: [p.code for p in problems_structure({}, ("maintaince.md",))]
         == ["readme.file_missing"]),
        ("\u2605 readme.single_file_empty",
         lambda: "readme.file_empty" in [p.code for p in problems_structure(
             {"maintaince.md": "  \n"}, ("maintaince.md",))]),
        # ③ 空输入必须报
        ("\u2605 readme.names_empty_structure",
         lambda: [p.code for p in problems_structure(_trio(), ())]
         == ["readme.names_empty_structure"]),
    ]


def _cases_push():
    """② 推送集判据：trio 条件式 / 单条目无条件。"""
    return [
        ("readme.push_all_present",
         lambda: problems_push(set(LANGS) | {"code.py"}, LANGS) == []),
        ("readme.single_push_contains_it",
         lambda: problems_push({"maintaince.md", "a.py"}, ("maintaince.md",))
         == []),
        ("\u2605 readme.not_in_push",
         lambda: [p.code for p in problems_push(
             {"README.md", "README.zh.md", "zreflect/facts.py"}, LANGS)]
         == ["readme.not_in_push"]),
        # 单条目：同批判据不退化（issue #8）
        ("\u2605 readme.single_not_in_push",
         lambda: [p.code for p in problems_push({"other.md"}, ("maintaince.md",))]
         == ["readme.not_in_push"]),
        # **多条目条件式**：一份 README 都没碰 ⇒ 不适用（纯代码提交不该被拦）。
        # 这是 CI 上 `0cef263`（只改 i18n.py + 台账）被判红的那一类 ——
        # 文档说的是条件判据（「改任何一份 ⇒ 三份全含」），不是无条件。
        ("readme.multi_untouched_is_not_in_scope",
         lambda: problems_push({"zreflect/x.py"},
                               ("README.md", "README.zh.md")) == []),
        # 但**碰了一份就必须三份全含**（否则改成条件式就等于放水了）
        ("\u2605 readme.multi_partial_still_fires",
         lambda: [p.code for p in problems_push(
             {"README.md", "zreflect/x.py"}, ("README.md", "README.zh.md"))
         ] == ["readme.not_in_push"]),
        # ③ 空输入必须报
        ("\u2605 readme.names_empty_push",
         lambda: [p.code for p in problems_push({"README.md"}, ())]
         == ["readme.names_empty_push"]),
        ("\u2605 readme.changed_empty",
         lambda: [p.code for p in problems_push(set(), LANGS)]
         == ["readme.changed_empty"]),
    ]


def _cases():
    """两条判据各一组（结构 / 推送集）：它们读不同的输入、管不同的事。"""
    return _cases_structure() + _cases_push()


GATE = meta("三语 README 闸门", "语言版本是同一条断言的三份拷贝：结构互链 + 每次推送同批",
            knobs=("REFLECT_READMES",), name_dependent=True)

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], "check_readme_sync", _cases, run))
