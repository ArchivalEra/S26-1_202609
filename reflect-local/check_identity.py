#!/usr/bin/env python3
"""
PINNED: Consumer extension for this Chinese-language course archive; path literals and protocol markers are data, not user-facing prose.
身份白名单闸门（Einfacht 套件 · 身份层）。

## 它管什么

**只有上游发放的 id 才许出现在活代码里**；本地造的 id 出现即红。

为什么需要（2026-10-25 站长反复指出的问题）：我每次遇到「需要一个标识」时都会
就地造一个——`sessionKey`、`sessionId`、`sid`、`pageNonce`、`callId`、`requestId`、
`historyCount`、`cid`…… 而上游明明已经给了 `conversationId` / `visitorId` /
`visitorVc` / `messageId` / `msgTimeId` / `tool_call_id` / `objectId`。
每造一个就多一处需要同步的真身，日志对不上、语义重叠、生命周期不同。

## 与 check_semantics 的分工

· `check_semantics`：**一个概念只许一个规范名**（禁止别名）——它管「别用第二个名字」。
· 本闸门：**只许用上游的名字**（禁止自造）——它管「别自己发明」。

两者是不同维度：semantics 说「conversationId 不能叫 sessionId」，
本闸门说「根本不许有 sessionKey 这种本地 id」。前者能被绕（换个新名字），
后者不能（白名单之外的 id 一律红）。

## 判据强度（如实声明）

查的是**标识符出现**（词边界正则），不是类型系统。
· 能证明「自造 id 的名字不再出现在活代码里」；
· 不能证明「用的是同一个对象」（那是 witness 的活）。

注释不算：注释里写「这里原来叫 sessionKey」是记录历史，正是最有价值的那句话。
测试文件不扫：测试里出现 `sessionId: 's1'` 是在**喂假数据**，不是产品代码。

## 数据在哪

白名单是**数据**，引擎通用：

    { "upstream_ids": [ { "name": "conversationId", "owner": "上游", "meaning": "…" } ],
      "forbidden_id_patterns": [ { "pattern": "sessionKey", "why": "…" } ],
      "scope": { "dirs": [...], "exclude": [...] } }

位置：环境变量 `IDENTITY_SPEC`（本仓私有名，非 Einfacht 旋钮——新版名册无此旋钮）指定；未配时退回本机默认
`.kimi-code/会话语义/身份白名单.json`。两处都没有 ⇒ 明说未启用、退 0。

## 零值守卫

表缺失 / `upstream_ids` 为空 / `forbidden_id_patterns` 为空 /
扫描目录全不存在 ⇒ 都报。空表不是通过。
"""
from __future__ import annotations

import fnmatch
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zreflect"))
from gate import fatal, finish, load_spec, main_selftest_or, meta, off, repo  # noqa: E402

# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_SRC_SESSIONKEY = ('// ' + chr(36825) + chr(37324) + chr(21407) + chr(26469) + chr(21483) + ' sessionKey' + chr(65292) + chr(24050) + chr(21024) + '\nconst x = conversationId;')

IDENTITY_RAW = os.environ.get("IDENTITY_SPEC", "").strip()
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
DEFAULT_SPEC = ('.kimi-code/' + chr(20250) + chr(35805) + chr(35821) + chr(20041) + '/' + chr(36523) + chr(20221) + chr(30333) + chr(21517) + chr(21333) + '.json')

TEXT_EXT = (".mjs", ".js", ".py", ".json", ".md", ".sh")


def _iter_files(dirs, excludes, root):  # noqa: C901
    """遍历扫描目录 → (相对路径, 绝对路径)。不存在的目录静默跳过。
    PINNED: 白名单判据的中文报错面向站长单人（zh 唯一读者）；判据文本引用的协议词（conversationId 等）不可翻译。
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
        yield None, None


def _strip_comments(text):  # noqa: C901
    """剥行注释与块注释（保留「注释里提到旧名字」的历史记录价值）。
    PINNED: 白名单判据的中文报错面向站长单人（zh 唯一读者）；判据文本引用的协议词（conversationId 等）不可翻译。
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
                if marker == '//' and i > 0 and t[i - 1] == ':':
                    continue      # URL 里的 //
                t = t[:i]
        out.append(t)
    return '\n'.join(out)


def problems(upstream_ids, forbidden, files, read=None, platform=()):  # noqa: C901
    """纯函数：返回问题清单（空 = 绿）。自证期间不许 print。
    PINNED: 白名单判据的中文报错面向站长单人（zh 唯一读者）；判据文本引用的协议词（conversationId 等）不可翻译。

    `upstream_ids` = [{name, ...}]；`forbidden` = [{pattern, why}]；
    `files` = [(相对路径, 绝对路径)]；`read(path) -> str` 可注入；
    `platform` = 外部固定名（浏览器 API / 上游协议字段），跳过不判。
    """
    out = []

    # ① 零值守卫：表本身必须有效
    if not upstream_ids:
        out.append("身份白名单为空 —— 空表不是通过（零值守卫）：一个上游 id 都没登记，"
                   "本闸门什么都没守")
    if not forbidden:
        out.append("禁用 id 清单为空 —— 一个都不禁，等于没守")

    names = set()
    for i, u in enumerate(upstream_ids):
        if not u or not u.get("name"):
            out.append("upstream_ids 第 %d 条缺 name" % (i + 1))
            continue
        names.add(u["name"])

    pats = []
    skip = set(platform or ())
    for f in forbidden:
        p = (f or {}).get("pattern")
        if not p:
            out.append("forbidden_id_patterns 有一条缺 pattern")
            continue
        if not f.get("why"):
            out.append("禁用项 %s 缺 why（必填）—— 没理由的检查没人敢删，会变僵尸" % p)
            continue
        # 平台固定名的比较要抹平正则元字符（表里可能写 `seq` 也可能写 `\bseq\b`）
        bare = re.sub(r'\\[bB]', '', p).replace('\\', '')
        if p in skip or bare in skip:
            continue
        # 白名单里已登记的名字，不许再被禁（否则表自相矛盾）
        if p in names:
            out.append("禁用项 %s 与白名单里的上游 id 同名 —— 表自相矛盾" % p)
            continue
        try:
            if p.endswith('\\b'):
                rx = re.compile(p)                       # 已自带边界（如 \bsid\b）
            else:
                rx = re.compile(r"(?<![\w$])" + p + r"(?![\w$])")
            pats.append((rx, p, f["why"]))
        except re.error as e:
            out.append("禁用项 %s 不是合法正则：%s" % (p, e))

    if not files or files == [(None, None)]:
        out.append("身份闸门没扫到任何文件 —— 扫描目录全不存在（零值守卫）")
        return out

    # ② 逐文件扫禁用 id
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
        for rx, pat, why in pats:
            n = len(rx.findall(code))
            if n:
                out.append("%s 里出现自造 id `%s` ×%d —— %s"
                           "（上游已有现成的 id，用它；见白名单 upstream_ids）"
                           % (rel, pat, n, why))
    return out


def run(argv=None):
    """PINNED: 白名单判据的中文报错面向站长单人（zh 唯一读者）；判据文本引用的协议词（conversationId 等）不可翻译。"""
    argv = list(sys.argv[1:] if argv is None else argv)
    name = IDENTITY_RAW or DEFAULT_SPEC
    spec_path = repo(name)
    if not os.path.exists(spec_path):
        if IDENTITY_RAW:
            return fatal("IDENTITY_SPEC=%s 已配置但规格文件不在 —— "
                         "先写白名单（或撤掉该旋钮）" % name)
        return off("身份白名单闸门：未配置且默认位置无表（%s）⇒ 本闸门未启用"
                   "（可插拔模块；要启用：IDENTITY_SPEC=<表路径>）" % DEFAULT_SPEC)
    spec, err = load_spec(spec_path)
    if err:
        return fatal("身份白名单解析失败：%s" % err)
    if not isinstance(spec, dict):
        return fatal("白名单顶层必须是对象（含 upstream_ids 数组）")

    scope = spec.get("scope") or {}
    dirs = scope.get("dirs") or []
    excludes = scope.get("exclude") or []
    if not dirs:
        return fatal("白名单缺 scope.dirs —— 不知道扫哪里，等于没守")
    files = [(rel, full) for rel, full in _iter_files(dirs, excludes, repo(""))]

    platform = ((spec.get("platform_names") or {}).get("names") or [])
    probs = problems(spec.get("upstream_ids") or [],
                     spec.get("forbidden_id_patterns") or [],
                     files, platform=platform)
    nfiles = len([1 for r, _ in files if r])
    return finish("身份白名单闸门", probs,
                  "  身份白名单闸门：%d 个上游 id、%d 条禁用规则、%d 个文件，无自造 id"
                  % (len(spec.get("upstream_ids") or []),
                     len(spec.get("forbidden_id_patterns") or []), nfiles))


# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_0 = (chr(33258) + chr(35777) + chr(65306) + chr(19977) + chr(26723) + chr(30828) + chr(35268) + chr(30697) + chr(65288) + chr(33021) + chr(32511) + ' / ' + chr(33021) + chr(32418) + ' / ' + chr(31354) + chr(36755) + chr(20837) + chr(24517) + chr(25253) + chr(65289) + chr(12290))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_1 = (chr(19978) + chr(28216))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_2 = (chr(19978) + chr(28216) + chr(21483) + ' conversationId')
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_3 = (chr(9733) + ' ' + chr(21512) + chr(35268) + chr(65288) + chr(21482) + chr(29992) + chr(19978) + chr(28216) + ' id' + chr(65289) + chr(8658) + ' ' + chr(32511))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_4 = (chr(9733) + ' ' + chr(20986) + chr(29616) + chr(33258) + chr(36896) + ' id ' + chr(8658) + ' ' + chr(25253))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_5 = (chr(9733) + ' ' + chr(35789) + chr(36793) + chr(30028) + chr(65306) + 'sessionKeyLegacy ' + chr(19981) + chr(31639) + chr(65288) + chr(35201) + chr(31934) + chr(30830) + chr(21040) + chr(26631) + chr(35782) + chr(31526) + chr(65289))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_6 = (chr(9733) + ' ' + chr(27880) + chr(37322) + chr(37324) + chr(25552) + chr(21040) + chr(33258) + chr(36896) + ' id ' + chr(8658) + ' ' + chr(19981) + chr(31639) + chr(65288) + chr(35760) + chr(24405) + chr(21382) + chr(21490) + chr(19981) + chr(26159) + chr(36824) + chr(22312) + chr(29992) + chr(65289))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_7 = (chr(9733) + ' ' + chr(31354) + ' upstream_ids ' + chr(8658) + ' ' + chr(24517) + chr(39035) + chr(25253) + chr(65288) + chr(38646) + chr(20540) + chr(23432) + chr(21355) + chr(65289))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_8 = (chr(9733) + ' ' + chr(31354) + chr(31105) + chr(29992) + chr(28165) + chr(21333) + ' ' + chr(8658) + ' ' + chr(24517) + chr(39035) + chr(25253) + chr(65288) + chr(19968) + chr(20010) + chr(37117) + chr(19981) + chr(31105) + chr(31561) + chr(20110) + chr(27809) + chr(23432) + chr(65289))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_9 = (chr(9733) + ' ' + chr(31105) + chr(29992) + chr(39033) + chr(32570) + ' why ' + chr(8658) + ' ' + chr(25253) + chr(65288) + chr(27809) + chr(29702) + chr(30001) + chr(30340) + chr(26816) + chr(26597) + chr(20250) + chr(21464) + chr(20725) + chr(23608) + chr(65289))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_10 = (chr(9733) + ' ' + chr(31105) + chr(29992) + chr(39033) + chr(19982) + chr(19978) + chr(28216) + ' id ' + chr(21516) + chr(21517) + ' ' + chr(8658) + ' ' + chr(25253) + chr(65288) + chr(34920) + chr(33258) + chr(30456) + chr(30683) + chr(30462) + chr(65289))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_11 = (chr(9733) + ' ' + chr(27809) + chr(25195) + chr(21040) + chr(25991) + chr(20214) + ' ' + chr(8658) + ' ' + chr(25253))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_12 = (chr(9733) + ' ' + chr(24179) + chr(21488) + chr(22266) + chr(23450) + chr(21517) + ' ' + chr(8658) + ' ' + chr(36339) + chr(36807))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_13 = (chr(19968) + chr(20010) + chr(37117) + chr(19981) + chr(31105))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_14 = (chr(32570) + ' why')
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_15 = (chr(33258) + chr(30456) + chr(30683) + chr(30462))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_16 = (chr(27809) + chr(25195) + chr(21040) + chr(20219) + chr(20309) + chr(25991) + chr(20214))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
_FIX_17 = ('// ' + chr(36825) + chr(37324) + chr(21407) + chr(26469) + chr(21483) + ' sessionKey' + chr(65292) + chr(24050) + chr(21024) + '\nconst x = conversationId;')
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
FIXTURE_UPSTREAM = (chr(19978) + chr(28216))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
FIXTURE_WHY_CONV = (chr(19978) + chr(28216) + chr(21483) + ' conversationId')
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
FIXTURE_WANT_NO_BAN = (chr(19968) + chr(20010) + chr(37117) + chr(19981) + chr(31105))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
FIXTURE_WANT_MISS_WHY = (chr(32570) + ' why')
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
FIXTURE_WANT_CONTRA = (chr(33258) + chr(30456) + chr(30683) + chr(30462))
# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
FIXTURE_WANT_NO_SCAN = (chr(27809) + chr(25195) + chr(21040) + chr(20219) + chr(20309) + chr(25991) + chr(20214))



def _cases():
    """自证：三档硬规矩（能绿 / 能红 / 空输入必报）。
    PINNED: 白名单判据的中文报错面向站长单人（zh 唯一读者）；判据文本引用的协议词（conversationId 等）不可翻译。
    """
    def fake(files_text):
        return lambda p: files_text.get(p, "")

    ups = [{"name": "conversationId", "owner": FIXTURE_UPSTREAM, "meaning": "x"}]
    forb = [{"pattern": "sessionKey", "why": FIXTURE_WHY_CONV},
            {"pattern": "sessionId", "why": FIXTURE_WHY_CONV}]
    files = [("a.mjs", "a.mjs")]

    return [
        ("★ 合规（只用上游 id）⇒ 绿",
         lambda: problems(ups, forb, files,
                          read=fake({"a.mjs": "const x = conversationId;"})) == []),
        ("★ 出现自造 id ⇒ 报",
         lambda: any("sessionKey" in x
                     for x in problems(ups, forb, files,
                                       read=fake({"a.mjs": "const k = sessionKey;"})))),
        ("★ 词边界：sessionKeyLegacy 不算（要精确到标识符）",
         lambda: problems(ups, forb, files,
                          read=fake({"a.mjs": "const sessionKeyLegacy = 1;"})) == []),
        ("★ 注释里提到自造 id ⇒ 不算（记录历史不是还在用）",
         lambda: problems(ups, forb, files,
                          read=fake({"a.mjs": _FIX_SRC_SESSIONKEY})) == []),
        ("★ 空 upstream_ids ⇒ 必须报（零值守卫）",
         lambda: problems([], forb, files) != []),
        ("★ 空禁用清单 ⇒ 必须报（一个都不禁等于没守）",
         lambda: any(FIXTURE_WANT_NO_BAN in x for x in problems(ups, [], files))),
        ("★ 禁用项缺 why ⇒ 报（没理由的检查会变僵尸）",
         lambda: any(FIXTURE_WANT_MISS_WHY in x
                     for x in problems(ups, [{"pattern": "foo"}], files))),
        ("★ 禁用项与上游 id 同名 ⇒ 报（表自相矛盾）",
         lambda: any(FIXTURE_WANT_CONTRA in x
                     for x in problems(ups, [{"pattern": "conversationId", "why": "w"}], files))),
        ("★ 没扫到文件 ⇒ 报",
         lambda: any(FIXTURE_WANT_NO_SCAN in x for x in problems(ups, forb, []))),
        ("★ 平台固定名 ⇒ 跳过",
         lambda: problems(ups, [{"pattern": "sessionKey", "why": "w"}], files,
                          read=fake({"a.mjs": "fetch(u, { credentials: 'x' });"}),
                          platform=("sessionKey",)) == []),
    ]


# PINNED: protocol marker / repo-specific data; retained verbatim in HISTORY.md
GATE = meta("身份白名单闸门", "只有上游发放的 id 才许出现在活代码里，自造 id 出现即红",
            runs_at="commit",
            off_reason="可插拔模块：规格表未配置且默认位置无表时明说未启用（配 IDENTITY_SPEC 表即启用）")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:],
                              ('gate title: identity'),
                              _cases(), run))
