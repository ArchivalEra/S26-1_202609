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

from gate import finish, main_selftest_or, meta, repo, selftest  # noqa: E402

READMES = "README.md,README.zh.md,README.de.md"


def lang_names():
    return tuple(s.strip() for s in os.environ.get("REFLECT_READMES", READMES).split(",")
                 if s.strip())


def problems_structure(files, langs):
    """结构判据（纯函数：自证要用）。`files` = {名字: 正文（读不到就没有这个键）}。"""
    out = []
    if not langs:
        # 零值守卫：清单为空 ⇒ 「README 组都齐」是一句无法判定的话。
        return ["REFLECT_READMES 是空的 —— 拿空清单判「README 组」是空话（零值守卫）"]
    # 单条目 ⇒ 互链判据退化（issue #8）：只有一份语言时「切换器必须
    # 指全全部语言」自动成立，自引用是退化要求。存在 / 非空判据照常，
    # 互链不查（退化判据由 run() 明说不适用 —— 不许假装查过）。
    switcher_applies = len(langs) > 1
    for name in langs:
        if name not in files:
            out.append("缺 README：%s —— 三语是同一条断言的三份拷贝，缺一份 = 断言散了架" % name)
            continue
        body = files[name] or ""
        if not body.strip():
            out.append("%s 存在但为空 —— 空文件不是一门语言" % name)
        if not switcher_applies:
            continue
        for other in langs:
            if other not in body:
                out.append("%s 里没有对 %s 的引用 —— 语言切换器必须指全全部语言，"
                           "否则读者从这一份走不到另一份" % (name, other))
    return out


def problems_push(changed, langs):
    """推送集判据（纯函数）。`changed` = 本次推送改动过的文件路径集合。"""
    out = []
    if not langs:
        return ["REFLECT_READMES 是空的 —— 「三语同批」没有判据对象（零值守卫）"]
    if not changed:
        return ["本次推送的改动集是空的 —— 空输入不是通过（零值守卫）："
                "「每次推送必须更新全部 README」无法在一堆空上成立"]
    for name in langs:
        if name not in changed:
            out.append("%s 不在这次要推送的改动文件里 ⇒ README 必须**同批**更新"
                       "（苛刻是有意的：缺一份 = 另两份从这一刻起过期）" % name)
    return out


def run(argv):
    langs = lang_names()
    if argv and argv[0] == "--changed":
        src = argv[1] if len(argv) > 1 else "-"
        if src == "-":
            lines = sys.stdin.read().splitlines()
        elif not os.path.exists(src):
            print("FATAL: 改动清单文件不存在：%s —— 找不到清单不许算通过（零值守卫）" % src,
                  file=sys.stderr)
            return 2
        else:
            lines = open(src, encoding="utf-8", errors="replace").read().splitlines()
        changed = {l.strip().strip('"') for l in lines if l.strip()}
        probs = problems_push(changed, langs)
        return finish("三语 README 闸门", probs,
                      "三语 README 闸门：OK（推送改动集含全部 %d 份 README）" % len(langs))
    files = {}
    for name in langs:
        p = repo(name)
        if os.path.exists(p):
            files[name] = open(p, encoding="utf-8", errors="replace").read()
    if len(langs) == 1:
        # 退化的互链判据要说出口（issue #8）—— 与其他闸门声明
        # 「未启用」同款：单条目时互链自动成立，不许假装查过。
        print("三语 README 闸门：REFLECT_READMES 只有一份（%s）⇒ 切换器互链"
              "判据不适用（单条目时「必须指全全部语言」自动成立，自引用是"
              "退化要求）；存在 / 非空判据照常" % langs[0], file=sys.stderr)
    probs = problems_structure(files, langs)
    if len(langs) == 1:
        return finish("三语 README 闸门", probs,
                      "三语 README 闸门：OK（%s 存在且非空；切换器互链判据不适用）"
                      % langs[0])
    return finish("三语 README 闸门", probs,
                  "三语 README 闸门：OK（%d 份 README 都在、非空、切换器互链完好）"
                  % len(langs))


LANGS = ("README.md", "README.zh.md", "README.de.md")


def _trio():
    return {n: "x [%s](%s) [%s](%s) [%s](%s) x" % (LANGS * 2) for n in LANGS}


def _cases():
    return [
        # ① 正常不报
        ("三份齐全且互链 ⇒ 不报", lambda: problems_structure(_trio(), LANGS) == []),
        ("推送改动集含全部三份 ⇒ 不报",
         lambda: problems_push(set(LANGS) | {"code.py"}, LANGS) == []),
        # ① 正常不报（单条目：互链判据退化，issue #8）
        ("单条目且无自引用 ⇒ 不报（互链 vacuous，issue #8）",
         lambda: problems_structure({"maintaince.md": "# 纪律\n\n正文里没有任何链接。"},
                                    ("maintaince.md",)) == []),
        ("单条目推送改动集含它 ⇒ 不报",
         lambda: problems_push({"maintaince.md", "a.py"}, ("maintaince.md",)) == []),
        # ② 该报的必须报
        ("★ 少一份 README ⇒ 必须报（缺的那份点名）",
         lambda: any("README.de.md" in x for x in problems_structure(
             {k: v for k, v in _trio().items() if k != "README.de.md"}, LANGS))),
        ("★ 某份里缺对第三份的切换器链接 ⇒ 必须报",
         lambda: any("切换器" in x for x in problems_structure(
             dict(_trio(), **{"README.md": "只有 [README.md](README.md) 和 "
                                  "[README.zh.md](README.zh.md)"}), LANGS))),
        ("★ README 存在但为空 ⇒ 必须报（空文件不是一门语言）",
         lambda: any("为空" in x for x in problems_structure(
             dict(_trio(), **{"README.zh.md": "   \n"}), LANGS))),
        ("★ 推送改动集缺一份 ⇒ 必须报（苛刻是有意的）",
         lambda: any("README.de.md" in x for x in problems_push(
             {"README.md", "README.zh.md", "zreflect/facts.py"}, LANGS))),
        # ② 该报的必须报（单条目：存在 / 非空 / 同批 三判据都不退化，issue #8）
        ("★ 单条目但文件缺失 ⇒ 必须报（存在判据不退化）",
         lambda: any("缺 README" in x and "maintaince.md" in x
                     for x in problems_structure({}, ("maintaince.md",)))),
        ("★ 单条目但为空 ⇒ 必须报（非空判据不退化）",
         lambda: any("为空" in x for x in problems_structure(
             {"maintaince.md": "  \n"}, ("maintaince.md",)))),
        ("★ 单条目推送集不含它 ⇒ 必须报（同批判据不退化）",
         lambda: any("maintaince.md" in x for x in problems_push(
             {"other.md"}, ("maintaince.md",)))),
        # ③ 空输入必须报
        ("★ 空清单（REFLECT_READMES=空）⇒ 结构判据必须报（零值守卫）",
         lambda: problems_structure(_trio(), ()) != []),
        ("★ 空清单 ⇒ 推送判据必须报", lambda: problems_push({"README.md"}, ()) != []),
        ("★ 空改动集 ⇒ 推送判据必须报（空不是通过）",
         lambda: problems_push(set(), LANGS) != []),
    ]


GATE = meta("三语 README 闸门", "语言版本是同一条断言的三份拷贝：结构互链 + 每次推送同批",
            knobs=("REFLECT_READMES",), name_dependent=True)

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:],
                              "check_readme_sync（三语 README：结构互链 + 每次推送必须同批）",
                              _cases, run))
