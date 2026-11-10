#!/usr/bin/env python3
"""课堂转写检索：以 `yyyymmdd_hhmmhhmm` 原版文件名为唯一主键。

隐私边界：课堂转写原件含教师个人信息与学生发言，**原件一律不入库**。
本地副本分布在两处，都只是工作区文件（git 不跟踪、不推送、不加白名单）：

  · 历史归档：`课程总览/<课>/原始资料/`（沿袭至今的本地副本）
  · 新收件暂存：`/mnt/hdd/study/<课>/原始资料/`

仓库只把 `index.md` 的文件名与哈希登记入库。本脚本只读这两处的**文件名**，
按原版 key 去重，不复制、不改名、不重写、不输出转写正文。

按日期把「转写 / 笔记 / 索引登记 / 音频登记」串起来，答两问：

  · 哪些课次有转写、没笔记;
  · 按课表周律，哪些日期没有转写（站长没给录音的候选，供人工核实）。

用法：
    python3 工具/录音检索.py                 # 全仓报告
    python3 工具/录音检索.py --course 工程数学  # 单课
    python3 工具/录音检索.py --missing       # 只列缺口
    python3 工具/录音检索.py --json          # 结构化输出
    python3 工具/录音检索.py --selftest      # 判据自证

命名契约（唯一产地）：`^(\\d{8})_(\\d{4})(\\d{4})-原文\\.(txt|doc|docx)$`。
`.doc` 实为 UTF-8 HTML 文本，保留原扩展名与字节，只作身份凭证，不改。
"""
from __future__ import annotations

import argparse
import datetime as dt
import glob
import json
import os
import re
import sys
from collections import defaultdict

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY = re.compile(r"^(\d{8})_(\d{4})(\d{4})-原文\.(txt|doc|docx)$")
INDEX_ROW = re.compile(r"\|\s*`(20\d{6}_\d{4}\d{4}-原文[^`]*)`\s*\|")
MP3_ROW = re.compile(r"\|\s*`(20\d{6}_\d{4}\d{4}\.mp3)`\s*\|")
NOTE_LINK = re.compile(r"\]\(\.\./课堂笔记/")
MERGED = ("同上", "合一篇", "同一节课的第二段", "同上第二段", "连堂", "第二段")
CALENDAR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "校历.json")


def load_calendar():
    if not os.path.isfile(CALENDAR):
        return {"holidays": [], "makeup": []}
    with open(CALENDAR, encoding="utf-8") as fh:
        return json.load(fh)


def is_off_day(d: dt.date, cal) -> bool:
    return d.isoformat() in cal.get("holidays", []) or d.strftime("%Y-%m-%d") in cal.get("holidays", [])


def date_of(key: str) -> str:
    return f"{key[:4]}-{key[4:6]}-{key[6:8]}"


def parse_date(text: str) -> dt.date:
    return dt.date(int(text[:4]), int(text[4:6]), int(text[6:8]))


def scan():
    """返回 (records, problems)。records 按 (课程, 日期) 聚合。

    转写原件只读两处本地副本的文件名（历史归档 + 新收件暂存），按 key 去重；
    仓库目录里的 `index.md` 只读登记。原件含个人信息，不入库、不输出正文。
    """
    records = defaultdict(lambda: {
        "course": "", "date": "", "keys": [], "notes": [], "mp3": [],
        "indexed": set(), "wrong_name": [],
    })
    LOCAL_DIRS = (
        (os.path.join(REPO, "课程总览"), "*", "原始资料", "*"),
        ("/mnt/hdd/study", "*", "原始资料", "*"),
    )
    for base in LOCAL_DIRS:
      for path in sorted(glob.glob(os.path.join(*base))):
        if not os.path.isfile(path) or path.endswith("index.md"):
            continue
        name = os.path.basename(path)
        ext = os.path.splitext(name)[1].lower()
        # 只把「像是课堂转写导出」的文件纳入命名审计；教材照片、题图、课件文本不归本系统管。
        if ext not in (".txt", ".doc", ".docx") or "-原文" not in name:
            continue
        m = KEY.match(name)
        course = path.split(os.sep)[-3]
        if not m:
            records[(course, "(命名不符)")]["wrong_name"].append(name)
            continue
        key = m.group(1) + "_" + m.group(2) + m.group(3)
        rec = records[(course, m.group(1))]
        rec["course"] = course
        rec["date"] = date_of(m.group(1))
        if any(x["key"] == key for x in rec["keys"]):
            continue
        rec["keys"].append({"key": key, "file": name, "ext": m.group(4),
                            "start": m.group(2), "end": m.group(3)})

    for path in sorted(glob.glob(os.path.join(REPO, "课程总览", "*", "课堂笔记", "*.md"))):
        if path.endswith("index.md"):
            continue
        course = path.split(os.sep)[-3]
        head = open(path, encoding="utf-8").read(4000)
        m = re.search(r'^date:\s*"?(\d{4}-\d{2}-\d{2})"?', head, re.M)
        if not m:
            continue
        d = m.group(1).replace("-", "")
        rec = records.get((course, d))
        if rec is None:
            rec = records[(course, d)]
            rec["course"] = course
            rec["date"] = m.group(1)
        rec["notes"].append(os.path.basename(path))

    for path in sorted(glob.glob(os.path.join(REPO, "课程总览", "*", "原始资料", "index.md"))):
        course = path.split(os.sep)[-3]
        for line in open(path, encoding="utf-8"):
            t = INDEX_ROW.search(line)
            if t:
                key = t.group(1).split("-原文")[0]
                rec = records.get((course, key[:8]))
                if rec is None:
                    rec = records[(course, key[:8])]
                    rec["course"], rec["date"] = course, date_of(key[:8])
                # 登记行有笔记链接、或明说是连堂合并段，都算「已关联」
                if NOTE_LINK.search(line) or any(w in line for w in MERGED):
                    rec["indexed"].add(key)
                else:
                    rec.setdefault("unlinked", set()).add(key)
            a = MP3_ROW.search(line)
            if a:
                key = a.group(1)[:-4]
                rec = records.get((course, key[:8]))
                if rec is None:
                    rec = records[(course, key[:8])]
                    rec["course"], rec["date"] = course, date_of(key[:8])
                rec["mp3"].append(a.group(1))

    problems = []
    for (course, d), rec in records.items():
        if rec["wrong_name"]:
            problems.append(f"{course} 本地原件：命名不符 {rec['wrong_name']}")
        if rec["keys"] and not rec["notes"] and not rec["indexed"]:
            problems.append(f"{course} {rec['date']}：有 {len(rec['keys'])} 份转写，无课堂笔记、无合并登记")
        for k in rec.get("unlinked", set()):
            problems.append(f"{course} 原始资料/index.md：`{k}-原文` 登记行无笔记链接")
    return records, problems


def weekday_gaps(records, cal=None):
    """按「同一课程、同一星期」的已知课次序列，找隔周以上缺口；校历假日不算缺。"""
    cal = cal if cal is not None else load_calendar()
    by_course = defaultdict(list)
    for (course, d), rec in records.items():
        if d == "(命名不符)" or not rec["keys"]:
            continue
        by_course[course].append(parse_date(d))
    gaps = []
    for course, ds in sorted(by_course.items()):
        ds = sorted(set(ds))
        wd = defaultdict(list)
        for d in ds:
            wd[d.weekday()].append(d)
        for weekday, seq in sorted(wd.items()):
            for a, b in zip(seq, seq[1:]):
                n = (b - a).days
                if 10 < n <= 40:
                    missing = [a + dt.timedelta(days=7 * i)
                               for i in range(1, n // 7 + 1)
                               if a + dt.timedelta(days=7 * i) < b
                               and not is_off_day(a + dt.timedelta(days=7 * i), cal)]
                    if not missing:
                        continue
                    gaps.append({"course": course, "weekday": dt.date(2026, 1, 5 + weekday).strftime("%a"),
                                 "from": a.isoformat(), "to": b.isoformat(), "days": n,
                                 "candidates": [x.isoformat() for x in missing]})
    return gaps


def report(records, problems, gaps, only_missing=False):
    out = []
    if not only_missing:
        out.append("课堂转写检索（主键 yyyymmdd_hhmmhhmm）")
        out.append("=" * 72)
        for (course, d), rec in sorted(records.items()):
            if d == "(命名不符)":
                out.append(f"【{course}】命名不符：{rec['wrong_name']}")
                continue
            keys = ", ".join(x["key"] for x in rec["keys"]) or "—"
            notes = ", ".join(rec["notes"]) or "—"
            linked = ", ".join(sorted(rec["indexed"])) or "—"
            mp3 = ", ".join(rec["mp3"]) or "—"
            out.append(f"\n【{course} · {rec['date']}】")
            out.append(f"  转写 [{len(rec['keys'])}]: {keys}")
            out.append(f"  笔记 [{len(rec['notes'])}]: {notes}")
            out.append(f"  索引已关联: {linked}")
            out.append(f"  音频登记: {mp3}")
    out.append("\n" + "=" * 72)
    out.append(f"缺口（有转写无笔记 / 登记未关联 / 命名不符）：{len(problems)}")
    for p in problems:
        out.append("  · " + p)
    out.append("\n课表周律缺口（仅供核实，不等于缺录音）：")
    if not gaps:
        out.append("  无")
    for g in gaps:
        out.append(f"  · {g['course']} {g['weekday']} {g['from']} → {g['to']} 隔 {g['days']} 天；"
                   f"中间候选 {', '.join(g['candidates']) or '—'}")
    return "\n".join(out)


def selftest():
    cases = [
        ("key 形状", bool(KEY.match("20261105_13551545-原文.txt"))),
        ("key 形状：.doc", bool(KEY.match("20260917_13301545-原文.doc"))),
        ("拒收非原版名", not KEY.match("11-05-笔记.txt")),
        ("拒收缺时段", not KEY.match("20261105-原文.txt")),
        ("key 拆段", (lambda m: (m.group(1), m.group(2), m.group(3)))(KEY.match("20261109_09501115-原文.txt"))
         == ("20261109", "0950", "1115")),
        ("日期换算", date_of("20261109") == "2026-11-09"),
    ]
    recs, probs = scan()
    cases.append(("扫描到转写", any(r["keys"] for r in recs.values())))
    cases.append(("命名零不符", not any(r["wrong_name"] for r in recs.values())))
    cases.append(("10-29 工程数学有转写",
                  len(recs[("工程数学", "20261029")]["keys"]) == 2))
    cases.append(("10-29 工程数学有笔记",
                  len(recs[("工程数学", "20261029")]["notes"]) == 1))
    bad = [n for n, ok in cases if not ok]
    for n, ok in cases:
        print(("ok  " if ok else "FAIL") + "  " + n)
    print(f"--- {len(cases) - len(bad)}/{len(cases)} ---")
    return 1 if bad else 0


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--course")
    ap.add_argument("--missing", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        return selftest()
    records, problems = scan()
    if a.course:
        records = {k: v for k, v in records.items() if k[0] == a.course}
        problems = [p for p in problems if p.startswith(a.course)]
    gaps = weekday_gaps(records)
    if a.json:
        print(json.dumps({
            "records": [{"course": v["course"], "date": v["date"],
                         "transcripts": v["keys"], "notes": v["notes"],
                         "indexed": sorted(v["indexed"]), "mp3": v["mp3"]}
                        for v in records.values()],
            "problems": problems, "weekday_gaps": gaps,
        }, ensure_ascii=False, indent=2))
        return 0
    print(report(records, problems, gaps, only_missing=a.missing))
    return 0


if __name__ == "__main__":
    sys.exit(main())
