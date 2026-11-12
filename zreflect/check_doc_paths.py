#!/usr/bin/env python3
"""活文档路径闸门：**活状态文档里写的路径必须真实存在**。

## 挡的是什么

2026-11-10 拆分 handoff 时实测出来的形态：活文档里写着「接缝 `插件/math-glossary.mjs`」，
而仓库里根本没有 `站点/插件/` 这个目录（实际是 `站点/plugins/`）；
写着判据 `grep -rl katex-error 站点/dist/课程/` 必须为空，而 `站点/dist/课程/`
不存在（实际是 `站点/dist/课程总览/`）——**命令直接报 No such file**，
于是「必须为空」这条判据既跑不通、也判不出空。

这就是 Einfacht 立身要消灭的东西：一句「现在如此」没有任何人复跑过，
却被当成事实照着做。文本规矩拦不住下一次，所以把它变成提交时真跑的判据。

## 判据

只扫**活状态文档**（`REFLECT_DOCS` + `PRINCIPLES.md` + `README.md`），
从里面抽出「像仓库内路径的串」，逐条 `os.path.exists`：

  · 被反引号包住的、形如 `站点/…`、`zreflect/…`、`.githooks/…`、`课程总览/…`、
    `工具/…`、`模板/…`、`questions/…`、`reflect-hooks/…`、`站点/plugins/…` 的串；
  · 以 `.py` / `.mjs` / `.js` / `.md` / `.json` / `.sh` / `.txt` 结尾的才算
    （避免把 `课程总览/<课>/原始资料/` 这类占位模板当路径）；
  · **排除**明显是模板或占位的：含 `<` `>` `*` `…` `{{` `[[`、以 `/` 结尾的目录占位；
  · **排除**历史文件（`HISTORY.md` 不扫——它是历史，允许提到已删除的路径）。

命中不存在的路径 ⇒ 报，并指出是哪份文档的哪一行。

## 为什么不做成「扫全部 md」

课程内容页里本来就大量引用「教材图号」「题号」这种非路径串，扫全仓会淹掉信号。
本闸门只管**活文档**——它们的断言强度最高（读者默认它们说的是此刻真相）。

用法：
    python3 zreflect/check_doc_paths.py             # 跑闸门
    python3 zreflect/check_doc_paths.py --selftest  # 判据自证
"""
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gate import meta, main_selftest_or  # noqa: E402
from i18n import M  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 活状态文档：断言强度最高的那批。HISTORY.md 刻意不在内（历史允许提已删路径）。
DEFAULT_DOCS = ("STATE.md", "AGENTS.md", "PRINCIPLES.md", "README.md")

# PINNED: 这些是仓库的真实目录名（数据，不是用户可见消息），不可翻译。
ROOTS = ("站点", "zreflect", "reflect-hooks", ".githooks", "课程总览", "工具",
         "模板", "questions", "mail", "docs", "src", "assets", ".agents", ".kimi-code")
EXTS = (".py", ".mjs", ".js", ".md", ".json", ".sh", ".mts", ".ts", ".txt", ".css")
PLACEHOLDER = ("<", ">", "*", "…", "{{", "[[", "${")


def looks_like_path(tok):
    """能不能当「仓库内路径」来判。纯函数。"""
    if not tok or any(p in tok for p in PLACEHOLDER):
        return False
    if not tok.endswith(EXTS):
        return False
    first = tok.split("/")[0]
    return first in ROOTS


def extract_paths(text):
    """抽反引号里的路径候选，返回 [(行号, 路径)]。纯函数。"""
    out = []
    for lineno, line in enumerate(text.splitlines(), 1):
        for tok in re.findall(r"`([^`\n]+)`", line):
            tok = tok.strip()
            if looks_like_path(tok):
                out.append((lineno, tok))
    return out


def check(docs, ignored=None, repo=None):
    """docs = {相对路径: 正文}。返回 [(文档, 行号, 路径)]（**硬失败**）。纯函数。

    分三类，判据是**这条路径在版本库里吗**（不是「目录在不在」）：

      · 本工作树存在 ⇒ 查，通过；
      · 不存在、但**被 git 排除**（按规则不入库）⇒ 本环境不适用，由 `skipped`
        报出来（干净克隆 / CI 里这一类必然落到这里）；
      · 不存在、且没被排除 ⇒ **硬失败**（写错名字，或删了没提交）。

    2026-11-12 干净克隆实测逼出这个三分：第一版按「`.kimi-code/` 根目录在不在」
    判，而该目录里有两个入库的 hook 文件，于是目录一直在、判据永远走不到豁免分支。
    「按规则不入库」的真相在 `.gitignore` 里，只有问 git 才准确。
    """
    ignore = _ignored_fn(ignored, repo)
    problems = []
    for rel, text in docs.items():
        for lineno, tok in extract_paths(text):
            if os.path.exists(os.path.join(repo or REPO, tok)):
                continue
            if ignore(tok):
                continue
            problems.append((rel, lineno, tok))
    return problems


def _ignored_fn(ignored, repo):
    """返回 `ignored(tok) -> bool`。默认问 git；注入时用注入的实现（自证）。"""
    if ignored is not None:
        return ignored
    base = repo or REPO

    def ask(tok):
        rc, _out = _git(base, "check-ignore", "-q", "--", tok)
        # rc 0 = 被排除；1 = 没被排除；128 = 不是 git 仓（导出包/压缩包）
        # —— 那时无从判断，**按没排除处理**，宁可红也不静默豁免。
        return rc == 0

    return ask


def _git(cwd, *args):
    """跑一条 git（`cwd` 是仓库根）。返回 (rc, stdout)。失败不抛。"""
    try:
        p = subprocess.run(["git", "-C", cwd, *args], capture_output=True,
                           text=True, encoding="utf-8", errors="replace",
                           timeout=30, check=False)
        return p.returncode, p.stdout
    except (OSError, subprocess.SubprocessError):
        return 128, ""


def skipped(docs, ignored=None, repo=None):
    """本环境不适用的路径（可见地报出来，不静默）。纯函数。"""
    ignore = _ignored_fn(ignored, repo)
    base = repo or REPO
    out = []
    for rel, text in docs.items():
        for lineno, tok in extract_paths(text):
            if not os.path.exists(os.path.join(base, tok)) and ignore(tok):
                out.append((rel, lineno, tok))
    return out


def _read_docs():
    docs = {}
    for rel in DEFAULT_DOCS:
        p = os.path.join(REPO, rel)
        if os.path.isfile(p):
            with open(p, encoding="utf-8") as fh:
                docs[rel] = fh.read()
    return docs


def run(args):
    """PINNED: 本闸门的中文报告面向站长单人（排障输出）；路径本身就是中文目录名。"""
    docs = _read_docs()
    if not docs:
        print("活文档路径闸门：零文档可扫 —— 这不是通过（零值守卫）")
        return 1
    problems = check(docs)
    absent = skipped(docs)
    if problems:
        print(f"活文档路径闸门：{len(problems)} 个路径在仓库里不存在")
        for rel, lineno, tok in problems:
            print(f"  · {rel}:{lineno} → `{tok}`")
        print("  处置：改对路径，或把该断言移进 HISTORY.md（历史允许提已删路径）")
        if absent:
            print(f"  （另有 {len(absent)} 处属本地专属目录、本环境无该目录，未计入）")
        return 1
    if absent:
        # 不适用必须说出来：干净 clone / CI 里这几条没被查过，不是「查过且通过」。
        print(f"活文档路径闸门：OK（{len(docs)} 份活文档）——"
              f"但 {len(absent)} 处**本环境不适用**（被 .gitignore 排除、此处不存在）：")
        for rel, lineno, tok in absent:
            print(f"  · {rel}:{lineno} → `{tok}`（本地专属，未查）")
        return 0
    print(f"活文档路径闸门：OK（{len(docs)} 份活文档，路径全部真实存在）")
    return 0


def _guard_problems(docs):
    """零文档不是「通过」——没查过的东西不许报绿。纯函数，自证用。"""
    if not docs:
        return ["zero_docs"]
    return check(docs)


def _empty_docs_guard():
    return _guard_problems({}) == ["zero_docs"] and _guard_problems({"a.md": "no path here"}) == []


def _cases():
    """PINNED: 夹具一律用 ASCII 路径（`ROOTS` 里的中文目录名由模块级常量覆盖，夹具不复述）。

    每条都注入 `ignored=`（假实现），**不落到默认的 git 询问**——否则自证结果依赖
    跑它的那台机器上 `.gitignore` 写了什么，同一份代码在两台机器上红绿不同。
    """
    gone = "zreflect/definitely-not-here.py"
    nothing_ignored = lambda _t: False  # noqa: E731 —— 夹具用的假实现，值恒定
    return [
        ("real_path_passes",
         lambda: check({"doc.md": "see `AGENTS.md`"}, ignored=nothing_ignored) == []),
        ("vanished_path_reported",
         lambda: check({"doc.md": "seam `" + gone + "`"},
                       ignored=nothing_ignored) != []),
        ("placeholder_ignored",
         lambda: check({"doc.md": "see `src/<name>/x.md` placeholder"},
                       ignored=nothing_ignored) == []),
        ("glob_ignored",
         lambda: check({"doc.md": "scan `zreflect/**/*.md`"},
                       ignored=nothing_ignored) == []),
        ("non_path_token_ignored",
         lambda: check({"doc.md": "key `symbol_packs`"},
                       ignored=nothing_ignored) == []),
        ("bare_filename_not_rooted_ignored",
         lambda: check({"doc.md": "see `build.mjs`"},
                       ignored=nothing_ignored) == []),
        ("line_number_reported",
         lambda: (lambda ps: bool(ps) and ps[0][1] == 2)(
             check({"doc.md": "first line\nseam `" + gone + "`"},
                   ignored=nothing_ignored))),
        ("empty_docs_is_not_pass_guard",
         lambda: _empty_docs_guard()),
        # 2026-11-12 干净克隆实测：`.kimi-code/` 里大部分文件按规则不入库，
        # 所以 CI 上那几条路径必然不存在。判据改成问 git（「这条路径被排除吗」），
        # 而不是猜目录在不在——第一版按目录判，栽在「目录里有两个入库的 hook」上。
        ("ignored_path_is_not_a_failure",
         lambda: check({"doc.md": "note `.kimi-code/handoff.md`"},
                       ignored=lambda t: t.startswith(".kimi-code/")) == []),
        ("unignored_missing_path_still_fails",
         lambda: check({"doc.md": "seam `.kimi-code/no-such-file-xyz.md`"},
                       ignored=nothing_ignored) != []),
        ("skipped_is_visible_not_silent",
         # 夹具必须用**本机不存在**的路径：`.kimi-code/handoff.md` 在开发机上是
         # 真有的，用它做夹具会在本机 pass、在 CI 上 fail（第一版就这么错）。
         lambda: skipped({"doc.md": "note `.kimi-code/no-such-file-xyz.md`"},
                         ignored=lambda t: t.startswith(".kimi-code/")) != []),
    ]


# PINNED: 闸门名与描述面向站长单人（STATE 机器块的 zh 渲染唯一读者）。
GATE = meta("活文档路径闸门",
            "活状态文档里写的仓库内路径必须真实存在（消灭跑不通的判据）",
            runs_at="commit")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:],
                              M("gate.title.doc_paths"),
                              _cases, run))
