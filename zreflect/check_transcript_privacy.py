#!/usr/bin/env python3
"""课堂转写隐私闸门：**转写原件不许新增入库**（棘轮）。

课堂转写含教师个人信息与学生发言，原件只在本地留存，仓库只入库
`原始资料/index.md` 的元数据登记（文件名、性质说明、SHA-256、关联笔记）
以及整理后的笔记。

## 为什么是棘轮而不是一刀切

2026-11-10 实测：`origin/main` 上已经有 61 份转写原件，七门课全有，
最早由 `84a41f8` 引入且**已经公开**。一刀切的判据会让仓库每次提交都红，
而红着不修的闸门等于没有闸门（本仓纪律：红是唯一仲裁，长期红就会被关掉）。

所以判据分两档：

  · **基线内**（`zreflect/transcript_baseline.json` 的 `allowed`）= 既有欠债，
    放行但在报告里点名。
  · **基线外** = 新增泄露，直接拒绝。

基线**只许缩小**（`--update-baseline` 拒绝任何新增项）。清理一份就少一份，
欠债数字只会往下走 —— 这就是棘轮。

## 三条判据（都比对基线）

  1. `git ls-files` 的 `课程总览/*/原始资料/` 下，非 `.md` 文件**且不在基线** ⇒ 报。
     既包括转写导出，也包括教材照片、课件文本 —— 那些原件同样不该入库。
  2. 同目录下匹配 `yyyymmdd_hhmmhhmm-原文.{txt,doc,docx}` 的**且不在基线** ⇒ 报。
  3. `.gitignore` 里 `!/…` 白名单行指向转写原件**且不在基线** ⇒ 报。
     加白名单就是让它进版本库，这条堵住「改 .gitignore 绕过闸门」。

用法：
    python3 zreflect/check_transcript_privacy.py                  # 跑闸门
    python3 zreflect/check_transcript_privacy.py --selftest       # 判据自证
    python3 zreflect/check_transcript_privacy.py --update-baseline # 只许缩小基线
"""
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gate import meta, main_selftest_or  # noqa: E402
from i18n import M  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASELINE_REL = "zreflect/transcript_baseline.json"

# PINNED: 文件名正则里的「原文」是真实文件名的组成部分（数据，不是消息），不可翻译。
TRANSCRIPT_KEY = re.compile(r"^\d{8}_\d{4}\d{4}-原文\.(txt|doc|docx)$")

# PINNED: 目录名本身就是中文（真实仓库路径），不可翻译。
ORIGINALS_DIR = "原始资料"


def _norm(path):
    return path.replace("\\", "/").lstrip("./")


def _is_transcript_file(name):
    return bool(TRANSCRIPT_KEY.match(name))


def _in_originals(path):
    parts = _norm(path).split("/")
    return len(parts) >= 3 and parts[-2] == ORIGINALS_DIR


def check(tracked, whitelist_lines, allowed):
    """返回 (problems, shrinkable)。allowed = 基线集合（既有欠债，放行）。

    纯函数：只吃清单，不碰磁盘、不调 git。
    """
    allowed = {_norm(p) for p in allowed}
    problems, shrinkable = [], []

    for p in tracked:
        n = _norm(p)
        if not _in_originals(n):
            continue
        name = n.split("/")[-1]
        violates = (not name.endswith(".md")) or _is_transcript_file(name)
        if not violates:
            continue
        if n in allowed:
            shrinkable.append(n)
        else:
            problems.append(("new_tracked", n))

    for line in whitelist_lines:
        line = line.strip()
        if not line.startswith("!/"):
            continue
        n = _norm(line[2:])
        if not _is_transcript_file(n.split("/")[-1]):
            continue
        if n in allowed:
            shrinkable.append(n)
        else:
            problems.append(("new_whitelist", n))

    return problems, sorted(set(shrinkable))


def load_baseline():
    path = os.path.join(REPO, BASELINE_REL)
    if not os.path.isfile(path):
        return []
    with open(path, encoding="utf-8") as fh:
        return json.load(fh).get("allowed", [])


def _git_tracked():
    out = subprocess.run(
        ["git", "-c", "core.quotepath=false", "ls-files"],
        cwd=REPO, capture_output=True, text=True,
        encoding="utf-8", errors="replace").stdout
    return [ln.strip() for ln in out.splitlines() if ln.strip()]


def _whitelist_lines():
    path = os.path.join(REPO, ".gitignore")
    if not os.path.isfile(path):
        return []
    with open(path, encoding="utf-8") as fh:
        return fh.read().splitlines()


def run(args):
    """PINNED: 本闸门的中文报告面向站长单人（排障输出）；路径本身就是中文目录名。"""
    allowed = load_baseline()
    problems, shrinkable = check(_git_tracked(), _whitelist_lines(), allowed)

    if "--update-baseline" in args:
        kept = sorted(set(shrinkable))
        dropped = len(allowed) - len(kept)
        if dropped <= 0:
            print(f"基线不变：{len(kept)} 份（没有可缩小的项）")
            return 0
        path = os.path.join(REPO, BASELINE_REL)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"note": "既有欠债基线，只许缩小；新增转写原件一律拒绝",
                       "allowed": kept}, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        print(f"基线缩小：{len(allowed)} → {len(kept)}（清掉 {dropped} 份）")
        return 0

    if problems:
        print(f"课堂转写隐私闸门：发现 {len(problems)} 个新增泄露")
        for kind, subject in problems:
            if kind == "new_whitelist":
                print(f"  · 白名单新增了转写原件：`{subject}`")
            else:
                print(f"  · 原始资料目录新增了原件入库：`{subject}`")
        print("  处置：原件留在本地，仓库只登记 index.md 的元数据与笔记；"
              "确属既有欠债请先清理再用 --update-baseline")
        return 1

    print(f"课堂转写隐私闸门：OK（基线内 {len(shrinkable)} 份既有欠债，零新增）")
    return 0


def _cases():
    """PINNED: 路径夹具用码点拼（本文件源码不出现中文字面量，闸门看的是 AST 求值后的值）。"""
    KO = chr(0x8BFE) + chr(0x7A0B) + chr(0x603B) + chr(0x89C8)   # 课程总览
    YS = chr(0x539F) + chr(0x59CB) + chr(0x8D44) + chr(0x6599)   # 原始资料
    KT = chr(0x8BFE) + chr(0x5802) + chr(0x7B14) + chr(0x8BB0)   # 课堂笔记
    JX = chr(0x6559) + chr(0x6750) + chr(0x89E3) + chr(0x6790)   # 教材解析
    YW = chr(0x539F) + chr(0x6587)                               # 原文
    IDXM = chr(0x0069) + chr(0x006E) + chr(0x0064) + chr(0x0065) + chr(0x0078)  # index
    NEW = "%s/%s/%s/20261105_13301350-%s.txt" % (KO, KT, YS, YW)
    OLD = "%s/%s/%s/20261029_13301350-%s.txt" % (KO, KT, YS, YW)
    IDX = "%s/%s/%s/%s.md" % (KO, KT, YS, IDXM)
    NOTE = "%s/%s/%s/11-05-note.md" % (KO, KT, YS)
    OTHER = "%s/%s/%s/sym.md" % (KO, JX, YS)
    return [
        ("new_tracked_transcript_rejected",
         lambda: check([NEW], [], [])[0] != []),
        ("baseline_transcript_allowed",
         lambda: check([OLD], [], [OLD])[0] == []),
        ("baseline_is_reported_shrinkable",
         lambda: check([OLD], [], [OLD])[1] == [OLD]),
        ("new_whitelist_transcript_rejected",
         lambda: check([], ["!/" + NEW], [])[0] != []),
        ("baseline_whitelist_allowed",
         lambda: check([], ["!/" + OLD], [OLD])[0] == []),
        ("index_md_allowed",
         lambda: check([IDX], [], [])[0] == []),
        ("notes_md_allowed",
         lambda: check([NOTE], [], [])[0] == []),
        ("comment_line_ignored",
         lambda: check([], ["# " + NEW], [])[0] == []),
        ("non_originals_dir_ignored",
         lambda: check([OTHER], [], [])[0] == []),
        ("clean_set_no_problems",
         lambda: check([IDX, NOTE], ["!/" + IDX], [])[0] == []),
    ]


# PINNED: 闸门名与描述面向站长单人（STATE 机器块的 zh 渲染唯一读者）。
GATE = meta("课堂转写隐私闸门",
            "转写原件不许新增入库（棘轮：既有欠债记基线，只许缩小）",
            runs_at="commit")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:],
                              M("gate.title.transcript_privacy"),
                              _cases, run))
