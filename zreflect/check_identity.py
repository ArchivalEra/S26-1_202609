#!/usr/bin/env python3
"""身份白名单闸门（Einfacht 套件 · 身份层）。

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

位置：`REFLECT_IDENTITY` 旋钮指定；未配时退回本机默认
`.zcode/会话语义/身份白名单.json`。两处都没有 ⇒ 明说未启用、退 0。

## 零值守卫

表缺失 / `upstream_ids` 为空 / `forbidden_id_patterns` 为空 /
扫描目录全不存在 ⇒ 都报。空表不是通过。
"""
from __future__ import annotations

import fnmatch
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gate import fatal, finish, load_spec, main_selftest_or, meta, off  # noqa: E402
from gate import repo, selftest                            # noqa: E402

IDENTITY_RAW = os.environ.get("REFLECT_IDENTITY", "").strip()
DEFAULT_SPEC = ".zcode/会话语义/身份白名单.json"

TEXT_EXT = (".mjs", ".js", ".py", ".json", ".md", ".sh")


def _iter_files(dirs, excludes, root):
    """遍历扫描目录 → (相对路径, 绝对路径)。不存在的目录静默跳过。"""
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


def _strip_comments(text):
    """剥行注释与块注释（保留「注释里提到旧名字」的历史记录价值）。"""
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


def problems(upstream_ids, forbidden, files, read=None, platform=()):
    """纯函数：返回问题清单（空 = 绿）。自证期间不许 print。

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
    argv = list(sys.argv[1:] if argv is None else argv)
    name = IDENTITY_RAW or DEFAULT_SPEC
    spec_path = repo(name)
    if not os.path.exists(spec_path):
        if IDENTITY_RAW:
            return fatal("REFLECT_IDENTITY=%s 已配置但规格文件不在 —— "
                         "先写白名单（或撤掉该旋钮）" % name)
        return off("身份白名单闸门：未配置且默认位置无表（%s）⇒ 本闸门未启用"
                   "（可插拔模块；要启用：REFLECT_IDENTITY=<表路径>）" % DEFAULT_SPEC)
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


def _cases():
    """自证：三档硬规矩（能绿 / 能红 / 空输入必报）。"""
    def fake(files_text):
        return lambda p: files_text.get(p, "")

    ups = [{"name": "conversationId", "owner": "上游", "meaning": "x"}]
    forb = [{"pattern": "sessionKey", "why": "上游叫 conversationId"},
            {"pattern": "sessionId", "why": "上游叫 conversationId"}]
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
                          read=fake({"a.mjs": "// 这里原来叫 sessionKey，已删\nconst x = conversationId;"})) == []),
        ("★ 空 upstream_ids ⇒ 必须报（零值守卫）",
         lambda: problems([], forb, files) != []),
        ("★ 空禁用清单 ⇒ 必须报（一个都不禁等于没守）",
         lambda: any("一个都不禁" in x for x in problems(ups, [], files))),
        ("★ 禁用项缺 why ⇒ 报（没理由的检查会变僵尸）",
         lambda: any("缺 why" in x
                     for x in problems(ups, [{"pattern": "foo"}], files))),
        ("★ 禁用项与上游 id 同名 ⇒ 报（表自相矛盾）",
         lambda: any("自相矛盾" in x
                     for x in problems(ups, [{"pattern": "conversationId", "why": "w"}], files))),
        ("★ 没扫到文件 ⇒ 报",
         lambda: any("没扫到任何文件" in x for x in problems(ups, forb, []))),
        ("★ 平台固定名 ⇒ 跳过",
         lambda: problems(ups, [{"pattern": "sessionKey", "why": "w"}], files,
                          read=fake({"a.mjs": "fetch(u, { credentials: 'x' });"}),
                          platform=("sessionKey",)) == []),
    ]


GATE = meta("身份白名单闸门", "只有上游发放的 id 才许出现在活代码里，自造 id 出现即红",
            knobs=("REFLECT_IDENTITY",),
            runs_at="commit")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:],
                              "身份白名单闸门（只许用上游 id）",
                              _cases(), run))
