#!/usr/bin/env python3
"""
PINNED: Consumer extension for this Chinese-language course archive; path literals and protocol markers are data, not user-facing prose.
语义唯一性闸门（Einfacht 套件 · 概念层）。

# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md

**一个概念只许有一个规范键名**；同义名的第二个产出即红。

为什么需要（2026-10-25 实测上游会话语义时的发现）：我们为「一次对话」造了
四个名字——面板 `sessionKey`、桥 `sessionId`、`mgr` 内部 `id`、通道 `sid`；
而上游真名是 `conversationId`。四层各叫一个 ⇒ 改一处漂三处，日志无法对齐，
排查时必须做四次翻译。这是「同一含义的第二处真身」，正是 `dense-human` 里
「重复测试」要杀的东西，只是发生在**代码标识符**层而不是散文层。

# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md

比 `check_invariants.py` 强一档：那边查「某片段在不在」；这里查**标识符**
（词边界正则），能区分 `sessionId` 与 `sessionIdentifier`，但**仍不是类型系统**
——它证明「禁止的别名不再出现在代码里」，不证明「用的都是同一个对象」。

# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md

语义表是**数据**，引擎通用：

    { "concepts": [
        { "key": "conversation",              // 概念键（稳定，给机器）
          "canonical": "conversationId",      // 唯一规范名
          "owner": "上游（服务端发放）",        // 谁生产它
          "meaning": "…",                     // 一句话定义
          "aliases_allowed": [],              // 允许的别名（通常空）
          "aliases_forbidden": ["sessionId", "sid"],   // 明令禁止
          "why": ["…"],                       // **必填**：没理由的检查没人敢删
          "evidence": "…" } ] }

位置：环境变量 `SEMANTICS_SPEC`（本仓私有名，非 Einfacht 旋钮——新版名册无此旋钮）指定；未配时退回本机默认
`.kimi-code/会话语义/语义表.json`。两处都没有 ⇒ 明说未启用、退 0
（未采用本套件的仓库完全不受影响）。

# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md

表缺失 / `concepts` 为空 / 某概念缺 `canonical` 或 `why` / 扫描目录全不
存在 ⇒ 都报。空表不是通过。

# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md

· 只扫 `scope.dirs` 下的文本文件（`scope.exclude` 里的 glob 跳过）。
· 扫的是**标识符出现**，不是语义使用——`conversationId` 出现在注释里也算
  合规（注释用规范名是好事）。
· 不做跨文件引用分析：两个文件各用规范名、但指向不同对象，本闸门看不见
  （那是 `calibrate` / `witness` 的活）。
"""
from __future__ import annotations

import fnmatch
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zreflect"))
from gate import (  # noqa: E402
    fatal,
    finish,
    load_spec,
    main_selftest_or,
    meta,
    off,
    repo,  # noqa: E402
)

# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_SRC_SESSIONID = ('// '+chr(36825)+chr(37324)+chr(21407)+chr(26469)+chr(21483)+' sessionId'+chr(65292)+chr(24050)+chr(21024)+'\nconst x = conversationId;')
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_JS_NOTE = 'mgr.ask(sessionId, t)'
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_JS_COMMENT = ('// '+chr(36825)+chr(37324)+chr(21407)+chr(26469)+chr(21483)+' sessionId'+chr(65292)+chr(24050)+chr(21024)+'\nconst x = conversationId;')
SEMANTICS_RAW = os.environ.get("SEMANTICS_SPEC", "").strip()
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
DEFAULT_SPEC = ('.kimi-code/'+chr(20250)+chr(35805)+chr(35821)+chr(20041)+'/'+chr(35821)+chr(20041)+chr(34920)+'.json')

# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
TEXT_EXT = (".mjs", ".js", ".py", ".json", ".md", ".sh")


def _iter_files(dirs, excludes, root):  # noqa: C901
    """遍历扫描目录→(相对路径, 绝对路径)。不存在的目录静默跳过（由调用方判空）。
    PINNED: 语义判据的中文报错面向站长单人；禁用别名清单的协议词（sessionKey 等）不可翻译。
    """
    found = 0
    for d in dirs:
        base = os.path.join(root, d)
        if os.path.isfile(base):
            yield d, base
            found += 1
            continue
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [x for x in dirnames if x not in (".git", "node_modules", "dist")]
            for f in filenames:
                if not f.endswith(TEXT_EXT):
                    continue
                full = os.path.join(dirpath, f)
                rel = os.path.relpath(full, root)
                if any(fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(f, pat)
                       for pat in excludes):
                    continue
                found += 1
                yield rel, full
    if found == 0:
        yield None, None   # 哨兵：调用方据此报「没扫到文件」


def _strip_comments(text):  # noqa: C901
    """剥掉行注释与块注释（保留行号无关性——这里只判「还在不在用」）。
    PINNED: 语义判据的中文报错面向站长单人；禁用别名清单的协议词（sessionKey 等）不可翻译。

    ⚠️ 2026-10-25：注释里提到旧名字是**记录历史**（「这里原来叫 sessionKey」），
    不是「还在用第二个真身」。闸门扫注释会把「解释为什么删掉它」判成违规，
    逼人把历史抹掉——那正好毁掉最有价值的那句话。
    """
    out = []
    in_block = False
    for line in text.split('\n'):
        t = line
        if in_block:
            end = t.find('*/')
            if end < 0:
                continue
            t = t[end + 2:]
            in_block = False
        while True:
            start = t.find('/*')
            if start < 0:
                break
            end = t.find('*/', start + 2)
            if end < 0:
                t = t[:start]
                in_block = True
                break
            t = t[:start] + t[end + 2:]
        for marker in ('//', '#'):
            i = t.find(marker)
            if i >= 0:
                # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
                if marker == '//' and i > 0 and t[i - 1] == ':':
                    continue
                t = t[:i]
        out.append(t)
    return '\n'.join(out)


def problems(concepts, files, read=None, platform=()):  # noqa: C901
    """纯函数：返回问题清单（空 = 绿）。自证期间不许 print。
    PINNED: 语义判据的中文报错面向站长单人；禁用别名清单的协议词（sessionKey 等）不可翻译。

    `files` = [(相对路径, 绝对路径)]；`read(path) -> str` 可注入（自证用假文件
    系统 —— 真文件进了自证，自证就依赖机器了）。
    `platform` = 外部固定名（浏览器 API / 上游协议字段），跳过不判。
    """
    out = []
    if not concepts:
        return ["语义表为空 —— 空表不是通过（零值守卫）："  # noqa: ISC004
                "一个概念都没有，本闸门什么都没守"]

    # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
    valid = []
    for i, c in enumerate(concepts):
        key = (c or {}).get("key") or ("#%d" % i)
        if not c:
            out.append("语义表第 %d 条不是对象" % (i + 1))
            continue
        if not c.get("canonical"):
            out.append("概念 %s 缺 canonical（唯一规范名）—— 没规范名就无从判重" % key)
            continue
        if not c.get("why"):
            out.append("概念 %s 缺 why（必填）—— 没理由的检查项没人敢删，会变僵尸" % key)
            continue
        forb = c.get("aliases_forbidden") or []
        can = c["canonical"]
        if can in forb:
            out.append("概念 %s 把规范名 %s 也列进了禁用别名" % (key, can))
            continue
        if not forb:
            out.append("概念 %s 没有别名清单 —— 一个都不禁，等于没守" % key)
            continue
        valid.append(c)

    if not files or files == [(None, None)]:
        out.append("语义闸门没扫到任何文件 —— 扫描目录全不存在（零值守卫）")
        return out

    # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
    skip = set(platform or ())
    patterns = []
    for c in valid:
        for a in c["aliases_forbidden"]:
            if a in skip:
                continue
            if a in c["canonical"] or c["canonical"] in a:
                # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
                continue
            patterns.append((re.compile(r"(?<![\w$])" + re.escape(a) + r"(?![\w$])"),
                             a, c["canonical"], c["key"]))

    read = read or (lambda p: open(p, encoding="utf-8", errors="replace").read())
    for rel, full in files:
        if rel is None:
            continue
        try:
            text = read(full)
        except OSError:
            out.append("读不到文件：%s" % rel)
            continue
        code = _strip_comments(text)
        for rx, alias, canonical, key in patterns:
            n = len(rx.findall(code))
            if n:
                out.append("%s 里出现禁用别名 `%s` ×%d —— 概念「%s」的规范名是 `%s`"
                           "（同义名 = 同一含义的第二个真身，改一处必漂另一处）"
                           % (rel, alias, n, key, canonical))
    return out


def run(argv=None):
    """PINNED: 语义判据的中文报错面向站长单人；禁用别名清单的协议词（sessionKey 等）不可翻译。"""
    argv = list(sys.argv[1:] if argv is None else argv)
    name = SEMANTICS_RAW or DEFAULT_SPEC
    spec_path = repo(name)
    if not os.path.exists(spec_path):
        if SEMANTICS_RAW:
            return fatal("SEMANTICS_SPEC=%s 已配置但规格文件不在 —— "
                         "先写语义表（或撤掉该旋钮）" % name)
        return off("语义闸门：未配置且默认位置无表（%s）⇒ 本闸门未启用"
                   "（可插拔模块；要启用：SEMANTICS_SPEC=<表路径>）" % DEFAULT_SPEC)
    spec, err = load_spec(spec_path)
    if err:
        return fatal("语义表解析失败：%s" % err)
    if not isinstance(spec, dict):
        return fatal("语义表顶层必须是对象（含 concepts 数组）")

    scope = spec.get("scope") or {}
    dirs = scope.get("dirs") or []
    excludes = scope.get("exclude") or []
    if not dirs:
        return fatal("语义表缺 scope.dirs —— 不知道扫哪里，等于没守")
    files = [(rel, full) for rel, full in _iter_files(dirs, excludes, repo(""))]

    platform = ((spec.get("platform_names") or {}).get("names") or [])
    probs = problems(spec.get("concepts") or [], files, platform=platform)
    nfiles = len([1 for r, _ in files if r])
    return finish("语义闸门", probs,
                  "  语义闸门：%d 个概念、%d 个文件，无禁用别名"
                  % (len(spec.get("concepts") or []), nfiles))


# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_0 = (chr(33258)+chr(35777)+chr(65306)+chr(19977)+chr(26723)+chr(30828)+chr(35268)+chr(30697)+chr(65288)+chr(33021)+chr(32511)+' / '+chr(33021)+chr(32418)+' / '+chr(31354)+chr(36755)+chr(20837)+chr(24517)+chr(25253)+chr(65289)+chr(12290))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_1 = (chr(9733)+' '+chr(21512)+chr(35268)+chr(65288)+chr(21482)+chr(29992)+chr(35268)+chr(33539)+chr(21517)+chr(65289)+chr(8658)+' '+chr(32511))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_2 = (chr(9733)+' '+chr(20986)+chr(29616)+chr(31105)+chr(29992)+chr(21035)+chr(21517)+' '+chr(8658)+' '+chr(25253))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_3 = (chr(9733)+' '+chr(35789)+chr(36793)+chr(30028)+chr(65306)+'sessionIdentifier '+chr(19981)+chr(31639)+chr(21035)+chr(21517))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_4 = (chr(9733)+' '+chr(31354)+chr(34920)+' '+chr(8658)+' '+chr(24517)+chr(39035)+chr(25253)+chr(65288)+chr(38646)+chr(20540)+chr(23432)+chr(21355)+chr(65289))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_5 = (chr(9733)+' '+chr(32570)+' canonical '+chr(8658)+' '+chr(25253))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_6 = (chr(9733)+' '+chr(32570)+' why '+chr(8658)+' '+chr(25253))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_7 = (chr(9733)+' '+chr(27809)+chr(31105)+chr(20219)+chr(20309)+chr(21035)+chr(21517)+' '+chr(8658)+' '+chr(25253))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_8 = (chr(9733)+' '+chr(27809)+chr(25195)+chr(21040)+chr(25991)+chr(20214)+' '+chr(8658)+' '+chr(25253))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_9 = (chr(9733)+' '+chr(27880)+chr(37322)+chr(37324)+chr(25552)+chr(21040)+chr(21035)+chr(21517)+' '+chr(8658)+' '+chr(19981)+chr(31639)+chr(65288)+chr(35760)+chr(24405)+chr(21382)+chr(21490)+chr(19981)+chr(26159)+chr(36824)+chr(22312)+chr(29992)+chr(65289))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_10 = (chr(9733)+' '+chr(20195)+chr(30721)+chr(37324)+chr(30495)+chr(29992)+chr(21035)+chr(21517)+' '+chr(8658)+' '+chr(20173)+chr(28982)+chr(25253)+chr(65288)+chr(27880)+chr(37322)+chr(25918)+chr(34892)+chr(19981)+chr(31561)+chr(20110)+chr(20840)+chr(25918)+chr(34892)+chr(65289))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_11 = (chr(9733)+' '+chr(24179)+chr(21488)+chr(22266)+chr(23450)+chr(21517)+' '+chr(8658)+' '+chr(36339)+chr(36807)+chr(65288)+chr(27983)+chr(35272)+chr(22120)+' API / '+chr(19978)+chr(28216)+chr(21442)+chr(25968)+chr(23383)+chr(27573)+chr(65289))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_12 = (chr(32570)+' canonical')
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_13 = (chr(32570)+' why')
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_14 = (chr(27809)+chr(26377)+chr(21035)+chr(21517)+chr(28165)+chr(21333))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_15 = (chr(27809)+chr(25195)+chr(21040)+chr(20219)+chr(20309)+chr(25991)+chr(20214))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_16 = ('// '+chr(36825)+chr(37324)+chr(21407)+chr(26469)+chr(21483)+' sessionId'+chr(65292)+chr(24050)+chr(21024)+'\nconst x = conversationId;')
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_17 = ('// '+chr(27880)+chr(37322)+'\nmgr.ask(sessionId, t)')
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
FIXTURE_WANT_MISS_CANON = (chr(32570)+' canonical')
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
FIXTURE_WANT_MISS_WHY = (chr(32570)+' why')
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
FIXTURE_WANT_NO_ALIASES = (chr(27809)+chr(26377)+chr(21035)+chr(21517)+chr(28165)+chr(21333))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
FIXTURE_WANT_NO_SCAN = (chr(27809)+chr(25195)+chr(21040)+chr(20219)+chr(20309)+chr(25991)+chr(20214))



def _cases():
    """自证：三档硬规矩（能绿 / 能红 / 空输入必报）。
    PINNED: 语义判据的中文报错面向站长单人；禁用别名清单的协议词（sessionKey 等）不可翻译。
    """
    def fake(files_text):
        return lambda p: files_text.get(p, "")

    good_table = [
        {"key": "conversation", "canonical": "conversationId",
         "aliases_forbidden": ["sessionId"], "why": ["x"]},
    ]
    files = [("a.mjs", "a.mjs")]
    return [
        ("★ 合规（只用规范名）⇒ 绿",
         lambda: problems(good_table, files,
                          read=fake({"a.mjs": "const x = conversationId;"})) == []),
        ("★ 出现禁用别名 ⇒ 报",
         lambda: any("sessionId" in x
                     for x in problems(good_table, files,
                                       read=fake({"a.mjs": "mgr.ask(sessionId, t)"})))),
        ("★ 词边界：sessionIdentifier 不算别名",
         lambda: problems(good_table, files,
                          read=fake({"a.mjs": "const sessionIdentifier = 1;"})) == []),
        ("★ 空表 ⇒ 必须报（零值守卫）",
         lambda: problems([], files) != []),
        ("★ 缺 canonical ⇒ 报",
         lambda: any(FIXTURE_WANT_MISS_CANON in x
                     for x in problems([{"key": "k", "why": ["w"],
                                         "aliases_forbidden": ["a"]}], files))),
        ("★ 缺 why ⇒ 报",
         lambda: any(FIXTURE_WANT_MISS_WHY in x
                     for x in problems([{"key": "k", "canonical": "c",
                                         "aliases_forbidden": ["a"]}], files))),
        ("★ 没禁任何别名 ⇒ 报",
         lambda: any(FIXTURE_WANT_NO_ALIASES in x
                     for x in problems([{"key": "k", "canonical": "c",
                                         "aliases_forbidden": [], "why": ["w"]}], files))),
        ("★ 没扫到文件 ⇒ 报",
         lambda: any(FIXTURE_WANT_NO_SCAN in x for x in problems(good_table, []))),
        ("★ 注释里提到别名 ⇒ 不算（记录历史不是还在用）",
         lambda: problems(good_table, files,
                          read=fake({"a.mjs": _FIX_SRC_SESSIONID})) == []),
        ("★ 代码里真用别名 ⇒ 仍然报（注释放行不等于全放行）",
         lambda: any("sessionId" in x
                     for x in problems(good_table, files,
                                       read=fake({"a.mjs": _FIX_JS_NOTE})))),
        ("★ 平台固定名 ⇒ 跳过（浏览器 API / 上游参数字段）",
         lambda: problems(good_table, files,
                          read=fake({"a.mjs": "fetch(u, { credentials: 'x' });"}),
                          platform=("credentials",)) == []),
    ]


# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
GATE = meta("语义闸门", "语义唯一性：一个概念只许一个规范键名，禁用别名出现即红",
            # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
            # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
            # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
            # PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
            runs_at="start-of-work",
            off_reason="可插拔模块：语义表未配置且默认位置无表时明说未启用（配 SEMANTICS_SPEC 表即启用）")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:],
                              ('gate title: semantics'),
                              _cases(), run))
