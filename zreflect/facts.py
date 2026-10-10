#!/usr/bin/env python3
"""事实台账的 CLI：量一遍、写台账、渲染机器块，以及**两道守卫**。

用法
    python3 zreflect/facts.py                      # 量一遍并写 FACTS.json（掉条/改口会拒绝）
    python3 zreflect/facts.py --allow-drop         # 允许本次掉条（掉掉的键会打出来）
    python3 zreflect/facts.py --accept-changes     # 允许本次改口（旧值→新值会打出来）
    python3 zreflect/facts.py --accept-changes=k1,k2  # 只接受列出的键，其余改口仍拒绝（issue #3 ①）
    python3 zreflect/facts.py --render-doc [文件]  # 把机器块写进文档（默认 STATE.md）
    python3 zreflect/facts.py --check [文件]       # 文档里的块是否与台账一致
    python3 zreflect/facts.py --get 键名           # 只打印该键的值（消费方出口，issue #4 ④）
    python3 zreflect/facts.py show [键]            # 打印某条事实
    python3 zreflect/facts.py --selftest           # 自证：两道守卫必须都能红

⚠️ **量不到的项不写**（宁缺勿假）。比如「最近一次全绿回归」只在有日志的机器上量得出来；
没日志就把那条事实**留空**，而不是写 0 —— 0 是一个数字，会被人当结果引用。
"""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gate import module_meta, GATE_REPO, main_selftest_or, repo, selftest  # noqa: E402
from ledger import age_days, fact, facts_of, load, value_of  # noqa: E402
from render import BLOCK_BEGIN, BLOCK_END, body_of, prose_of, render_block  # noqa: E402
import guard                                             # noqa: E402
import registry                                          # noqa: E402

LEDGER_NAME = os.environ.get("REFLECT_FACTS", "FACTS.json")
OUT = repo(LEDGER_NAME)
DOC = os.environ.get("REFLECT_DOC", "STATE.md")


# ══ 你的部分（本仓数据层）════════════════════════════════════════════════════
# 机制在本目录（Einfacht 上游，逐字节照抄、可原样升级）；**本仓要量的东西**在
# measure_edu.py（数据 vs 机制分离：换仓库只换那一个文件）。
#
# ⚠️ 为什么还留着上游那个「通用 measure」（数 py/md 文件）：
#   `gates-selftest.sh` 的**跨仓库可配置性自证**会搭一个**临时夹具仓库**，
#   把三个默认名全换掉、在夹具里真跑 `facts.py` 生成台账。夹具里没有本仓的
#   课程/站点 ⇒ 本仓的 measure 量出的是空表，于是 check_facts / replay 在
#   夹具里必红 —— 那会误报成「名字写死在代码里」（**正是这条自证要抓的**，
#   但这里不是真因）。所以：**真仓用本仓 measure，夹具用通用 measure**
#   （判据 = GATE_REPO 是不是本仓）。
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from measure_edu import measure as measure_edu              # noqa: E402

_REAL_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _generic_measure():
    """上游自带的通用 measure（数 py/md 文件）—— **GATE_REPO 相对**，夹具里也能跑。

    照抄上游语义：cmd 用 `find .`（闸门在仓库根逐字执行），计数用
    `os.walk(GATE_REPO)` —— 换名自证里量到的必须是**夹具**的行数。
    """
    facts = {}
    n_py = 0
    n_md = 0
    lines_py = 0
    for root, _dirs, files in os.walk(GATE_REPO):
        if "/.git" in root:
            continue
        for f in files:
            if f.endswith(".py"):
                n_py += 1
                try:
                    lines_py += sum(1 for _ in open(os.path.join(root, f), encoding="utf-8",
                                                    errors="replace"))
                except OSError:
                    pass                      # 数不出来的文件不计数 —— 宁缺勿假
            elif f.endswith(".md"):
                n_md += 1
    facts["py_files"] = fact(n_py, "find . -name '*.py' -not -path './.git/*' | wc -l", "repo")
    facts["md_files"] = fact(n_md, "find . -name '*.md' -not -path './.git/*' | wc -l", "repo")
    # 这条刻意大于 BARE_MIN（check_facts 的裸数字阈值 = 100），好在 STATE.md 里
    # 演示「手抄这个数字会被闸门拦下」。太小的数字遍地都是，查了全是噪音 ⇒ 不查。
    facts["py_lines"] = fact(lines_py, "find . -name '*.py' -not -path './.git/*' "
                             "-exec cat {} + | wc -l", "repo",
                             "刻意 ≥100，用来示范裸数字判据")
    # ⑥ 块排除模式（issue #4 ⑥）：md_lines 数**块以外**的行 —— 机器块
    # 就渲染在这些文档里，数进去 ⇒ 渲染一遍值就过期 ⇒ 复跑恒定失败
    # （而 check_facts 比的是「块↔台账」，两边一起陈旧 ⇒ 全绿）。
    # awk 的 FNR==1{b=0} 是必需的：find -exec {} + 会把多个文件喂给
    # 同一个 awk 进程，漏了按文件重置，第一个带块的文件之后全被跳过，
    # 而输出仍然「像个行数」。起始标记与 render.py 的输出逐字一致。
    md_lines_cmd = ("find . -name '*.md' -not -path './.git/*'"
                    " -exec awk 'FNR==1{b=0} /<!-- AUTO:FACTS -->/{b=1} !b' {} + | wc -l")
    # cwd=GATE_REPO：计数（os.walk(GATE_REPO)）与复跑（闸门在仓库根
    # 逐字执行 cmd）都锚定 GATE_REPO —— 不传 cwd 时，在夹具里量到的是
    # 调用方仓库的行数，换名自证会红（跨仓库可配置性自证抓到的回归）。
    facts["md_lines"] = fact(
        int(subprocess.run(md_lines_cmd, shell=True, capture_output=True,
                             text=True, check=True,
                             cwd=GATE_REPO).stdout.strip()),
        md_lines_cmd, "repo",
        "不含机器块：块就渲染在文档里，数进去会让渲染一遍值就过期")

    # 例：**量不到就不写**。把 UPSTREAM_VERSION 设上才有这条事实。
    v = os.environ.get("UPSTREAM_VERSION", "").strip()
    if v:
        facts["upstream_version"] = fact(v, "echo \"$UPSTREAM_VERSION\"", "env",
                                         "量不到就不写 —— 宁缺勿假")
    return facts


def measure_example():
    """平台契约要求的入口：真仓走本仓 measure，夹具（换名自证）走通用 measure。"""
    if os.path.abspath(GATE_REPO) == os.path.abspath(_REAL_REPO):
        return measure_edu()
    return _generic_measure()


# ══ 以下不用改 ════════════════════════════════════════════════════════════════
def _machine_blocks(ledger):
    """文档里要维护的两个机器块（Phase 3 起）：

      · 事实块（AUTO:FACTS）—— 台账渲染，**数字的唯一产地**；
      · 闸门名录块（AUTO:GATES）—— 发现式名录渲染，**闸门叙述的唯一产地**
        （手写的「N 道闸门」清单漂过：ab/locks/pins 并入当天清单就少了
        三道 —— 叙述从声明行派生，手写退役）。

    返回 (blocks, 错误句)。名录对账不过（缺声明 / 孤儿 / 旗标错）⇒ 拒绝渲染
    —— 判据只有一份产地：`registry.problems()`。
    """
    gs, missing = registry.gates()
    probs = registry.problems(gs, missing)
    if probs:
        return None, "名录对账不过，拒绝渲染：\n  · " + "\n  · ".join(probs)
    return ((BLOCK_BEGIN, BLOCK_END, render_block(ledger)),
            (registry.GATES_BEGIN, registry.GATES_END,
             registry.render_gates(gs))), None


def write_doc(path_rel, ledger):
    """把机器块写进文档（就地替换）。没有标记就报错，**不悄悄追加** ——
    悄悄追加会让「块过期」变成「有两份块」，那是更难查的坏法。"""
    p = path_rel if os.path.isabs(path_rel) else repo(path_rel)
    if not os.path.exists(p):
        print("FATAL: %s 不存在。先手工放一次机器块标记。" % p,
              file=sys.stderr)
        return 2
    blocks, err = _machine_blocks(ledger)
    if err:
        print("FATAL: %s" % err, file=sys.stderr)
        return 2
    text = open(p, encoding="utf-8").read()
    new = text
    for begin, end, body in blocks:
        if begin not in new or end not in new:
            print("FATAL: %s 缺 %s / %s 标记（第一次落地时要手工放一次）"
                  % (path_rel, begin, end), file=sys.stderr)
            return 2
        pre, _, rest = new.partition(begin)
        _, _, post = rest.partition(end)
        new = pre + body + post
    # 写盘前的完整性守卫：替换必须保得住**全部**块的标记。标记字面量若被
    # 写进正文（哪怕在行内代码里），首现替换会把两块之间的内容整个吞掉、
    # 让别的块消失 —— 实测踩过：bullet 里写了标记字面量，渲染一次丢掉整个
    # 事实块。歧义 ⇒ 拒绝写盘，人先修文档（块内 cmd 引用 begin 字面量是
    # 合法嵌套 —— md_lines 的 awk 判据 —— 故不做替换前的计数断言）。
    for begin, end, _ in blocks:
        if begin not in new or end not in new:
            print("FATAL: %s 的标记字面量混进了正文（%s）—— 渲染会吞块，"
                  "拒绝写盘；标记只许出现在机器块首尾"
                  % (path_rel, begin), file=sys.stderr)
            return 2
    if new != text:
        open(p, "w", encoding="utf-8").write(new)
        print("已刷新 %s 的机器块" % path_rel)
    else:
        print("%s 的机器块无变化" % path_rel)
    return 0


def check_doc(path_rel, ledger):
    p = path_rel if os.path.isabs(path_rel) else repo(path_rel)
    if not os.path.exists(p):
        print("FATAL: 文档 %s 不存在（--check 不能因为找不到文件就算通过）" % p, file=sys.stderr)
        return 2
    blocks, err = _machine_blocks(ledger)
    if err:
        print("FATAL: %s" % err, file=sys.stderr)
        return 2
    text = open(p, encoding="utf-8").read()
    for begin, end, body in blocks:
        if begin not in text or end not in text:
            print("FATAL: %s 缺 %s / %s 标记" % (path_rel, begin, end),
                  file=sys.stderr)
            return 2
        cur = text.split(begin, 1)[1].split(end, 1)[0]
        fresh = body.split(begin, 1)[1].split(end, 1)[0]
        if cur != fresh:
            print("FATAL: %s 的 %s 块与现算不一致 ⇒ 跑 --render-doc"
                  % (path_rel, begin), file=sys.stderr)
            return 1
    print("%s 的机器块与现算一致" % path_rel)
    return 0


def _age_human(entry):
    """`measured_at` 的人话（issue #3 ②）：今天 / N 天前 / 未记录。"""
    d = age_days(entry)
    if d is None:
        return "未记录测量时间"
    if d < 1:
        return "今天测的"
    return "%d 天前测的" % int(d)


def measure(argv):
    """量一遍并写台账。**必须接 `argv`** —— 两道守卫都要读它。

    ⚠️ 这里踩过：`measure()` 曾经没有 `argv` 参数，而守卫里写着 `not in argv`。
    因为 `and` 短路，**只在真的掉条时**才走到那句 ⇒ 报的不是「掉了哪几条」而是一段
    NameError traceback；`--allow-drop` 从未生效过。写盘被拦住只是**顺带**（异常早于写盘），
    那不叫守卫，那叫故障。所以本文件把 argv 显式传进来；守卫的**决策**在
    `zreflect/guard.py`（decide()，接线有自证），本函数只执行它。
    """
    facts = measure_example()

    old = facts_of(load(OUT)) if os.path.exists(OUT) else {}

    verdict, problems, notes = guard.decide(old, facts,
                                            accepted=guard.accepted_keys(argv),
                                            allow_drop="--allow-drop" in argv)
    for x in notes["err"]:
        print(x, file=sys.stderr)
    for x in notes["out"]:
        print(x)
    if verdict == "refuse":
        for x in problems:
            print("FATAL: %s" % x, file=sys.stderr)
        return 2

    # 仪器生命周期（issue #6 ①）：值没变的键沿用旧 first_seen
    # （换值 / 新键的 first_seen 已由 ledger.fact() 盖今天）——
    # 恒常检测（可插拔闸门 check_instruments.py）靠它。
    for k, entry in facts.items():
        o = old.get(k)
        fs = o.get("first_seen") if isinstance(o, dict) else None
        if fs and value_of(o) == value_of(entry):
            entry["first_seen"] = fs

    import json                                         # noqa: PLC0415
    import time                                         # noqa: PLC0415
    doc = {"schema": 1, "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
           "_why": "事实台账：每条 = 一个**测出来**的值 + 复跑命令 + 出处。"
                   "别手改，跑 zreflect/facts.py。",
           "facts": facts}
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    print("已写出 %s（%d 条事实）" % (os.path.relpath(OUT, GATE_REPO), len(facts)))
    for k, v in sorted(facts.items()):
        print("  %-20s %s（%s）" % (k, v["value"], _age_human(v)))
    return 0


def get_value(ledger, key):
    """按键取台账值 —— 跨语言消费方的**官方只读出口**（issue #4 ④）。

    消费方（CI、其它语言的测试进程）一律走 `facts.py --get KEY`，
    **不要自己解析 FACTS.json**：手写 parser 的经典坑是 substring 找
    `"value"` 再取引号内 —— 同一文件里到处都是 `"value": …`，会取到
    **别的键**上的值。这里把值取完整。
    键不存在 ⇒ (False, 错误句)；存在 ⇒ (True, 值)。
    """
    f = facts_of(ledger)
    if key not in f:
        return False, "台账里没有键 `%s`（现有：%s）" % (
            key, ", ".join(sorted(f)) or "空")
    return True, value_of(f[key])


def _load_or_die():
    """读台账；**没有就给出可操作的提示**而不是原始 traceback。
    为什么单列：新仓库第一次用时台账还不存在，而这个脚本今天会直接抛
    FileNotFoundError —— 那是"为本仓写死"的味道（我们那边永远有 FACTS.json）。
    语义仍是 fail-loud（空台账照样拒绝渲染），只是**把下一步写在错误里**。"""
    if not os.path.exists(OUT):
        print("FATAL: 还没有台账 %s\n"
              "       先在仓库根跑一遍量测：python3 zreflect/facts.py\n"
              "       然后再 --render-doc 把机器块写进文档。" % os.path.basename(OUT),
              file=sys.stderr)
        raise SystemExit(2)
    return load(OUT)


def main(argv):
    if argv and argv[0] == "--render":
        sys.stdout.write(render_block(_load_or_die()) + "\n")
        return 0
    if argv and argv[0] == "--render-doc":
        return write_doc(argv[1] if len(argv) > 1 else DOC, _load_or_die())
    if argv and argv[0] == "--check":
        return check_doc(argv[1] if len(argv) > 1 else DOC, _load_or_die())
    if argv and argv[0] == "--get":
        if len(argv) < 2:
            print("FATAL: --get 需要一个键名：--get KEY", file=sys.stderr)
            return 2
        ok, v = get_value(_load_or_die(), argv[1])
        if not ok:
            print("FATAL: %s" % v, file=sys.stderr)
            return 2
        print(v)                       # 只打印值本身：不解释、不带前缀
        return 0
    if argv and argv[0] == "show":
        led = _load_or_die()
        f = facts_of(led)
        keys = [argv[1]] if len(argv) > 1 else sorted(f)
        rc = 0
        for k in keys:
            if k not in f:
                print("没有这条事实：%s（现有：%s）" % (k, ", ".join(sorted(f))), file=sys.stderr)
                rc = 1
                continue
            e = f[k] if isinstance(f[k], dict) else {"value": f[k]}
            print("%-20s %s" % (k, e.get("value")))
            print("    出处  %s" % e.get("source", "?"))
            print("    复跑  %s" % e.get("cmd", "?"))
            if e.get("note"):
                print("    备注  %s" % e["note"])
        return rc
    return measure(argv)


def _tmp_doc(content, name="doc.md"):
    """自证用的临时文档（tempfile + atexit 清理 —— 此前写固定的 /tmp
    路径，非 pid 唯一，并行跑两份自证会互相踩）。"""
    import atexit                                        # noqa: PLC0415
    import shutil                                        # noqa: PLC0415
    import tempfile                                      # noqa: PLC0415
    d = tempfile.mkdtemp()
    atexit.register(shutil.rmtree, d, True)
    p = os.path.join(d, name)
    open(p, "w").write(content)
    return p


CASES = [
    # ③ 空输入必须报（守卫的决策接线在 zreflect/guard.py 的自证里；
    #    掉条 / 改口的纯函数在 ledger.py 的自证里 —— 各归各）
    ("★ 空文档（没有块标记）⇒ check_doc 必须报，不许算通过",
     lambda: check_doc(_tmp_doc("空空如也\n"), {"facts": {"a": 1}}) == 2),
    ("★ 文档文件不存在 ⇒ check_doc 必须报（不许因为找不到就算通过）",
     lambda: check_doc(os.path.join(_tmp_doc("", "x.md"), "..",
                                    "no_such_%d.md" % os.getpid()),
                       {"facts": {"a": 1}}) == 2),
    # ② 测龄人话（issue #3 ②）
    ("年龄：缺失 measured_at ⇒ 明说未记录",
     lambda: _age_human({"value": 1}) == "未记录测量时间"),
    ("年龄：刚刚测的 ⇒ 今天",
     lambda: _age_human({"measured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}) == "今天测的"),
    # ④ 官方只读出口（issue #4 ④）
    ("--get：键存在（字典形状）⇒ (True, 裸值)",
     lambda: get_value({"facts": {"n": {"value": 12, "cmd": "c"}}}, "n") == (True, 12)),
    ("--get：键存在（裸值形状）⇒ (True, 值)",
     lambda: get_value({"facts": {"n": 7}}, "n") == (True, 7)),
    ("★ --get：键不存在 ⇒ (False, 错误句)（空输入不是通过）",
     lambda: get_value({"facts": {"n": 1}}, "zzz")[0] is False),
]


MODULE = module_meta("台账 CLI", "量一遍 / 渲染 / --get / 两道守卫", selftest=True)


if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:], "facts.py（两道守卫 + 文档一致性）",
                              CASES, main))
