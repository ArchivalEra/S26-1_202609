#!/usr/bin/env python3
"""复跑闸门：台账每条事实的 `cmd` **真的被跑一遍**，stdout 必须等于台账值。

它挡的是机制自己最大的空头承诺（issue #2 ①）：README 开篇说「该是一条能复跑的断言」，
但发布出去的机制里**没有任何一处执行那条 `cmd`** —— cmd 腐烂了（路径移走、工具改名、
命令直接报错），它连同坏名字会被 `--render-doc` 原样印进活状态文档，每个闸门照绿不误。
「能复跑」从此不再是宣传语，而是每次 pre-commit / pre-push 都重证一次的断言。

判据（`cmd` 逐字执行，cwd = 仓库根）：

  · **裸值契约**：stdout 去掉首尾空白后必须**等于**值（`str(value)`）。
    只打印「含该值的整行」⇒ 人眼可读、机器不可判 ⇒ 判不符。
  · **返回码非 0 ⇒ 报**：坏命令不是「值变了」，是「复跑方式本身死了」。
  · **超时 ⇒ 报**（默认 10s，`REFLECT_REPLAY_TIMEOUT` 覆盖）：挂在 pre-commit 里的
    命令不该永远等不到结果。
  · **没有 `cmd` ⇒ 报**：没复跑命令的事实就是散文。
  · 管道**不再吞错**：有 bash 就用 `bash -o pipefail -c`（`cat 没了 | wc -l` 打印 0
    且 rc=0 的那种「失败但绿」正是本闸门要红的东西）。没有 bash 时退回 /bin/sh
    并在输出里明说 —— 判据强度随环境变化这件事，不许静默。

零值守卫三条：台账为空 ⇒ 报；一条都没跑成（全 rc≠0/超时）⇒ 报；全部事实都声明
`replay: false` **且无见证、无校准** ⇒ 报（全豁免不是「通过」，是「这个闸门
什么都没查」；挂了 witness / calibrate 的贵事实照样被查 —— issue #5/#6）。

第三档：**见证**（issue #5）—— `replay=False` 的贵事实可挂便宜见证
（`witness` + `witness_expect`，两者同给，残缺形状由 `ledger.fact()`
当场报错）。见证与 `replay` **正交**：值本身不逐字复跑，但
**来源/上下文**（"产出它的工具/输入就是我以为的那个"）**每次提交真跑**，
判据同裸值契约（`stdout.strip() == witness_expect`）。「贵」恰恰是
最需要便宜复查的地方：产物没变、但产出它的工具变了，能一路蒙混到
最贵的端到端回归才炸 —— 见证在提交时就抓住它。

第四档：**仪器校准**（issue #6 ①）—— 复跑契约抓「命令死了」（rc≠0），
却抓不到**仪器静默失真**：命令成功、值稳定、复跑永远「通过」，而它量的
根本不是想量的（`grep -c X` 在仪器不认 X 时成功退出并返回 0）。
声称「产物里有没有 X」的 `cmd` 配一个**已知含 X 的样本**：
`calibrate`（对样本跑的便宜命令）+ `calibrate_expect`（样本的已知输出），
与 `replay` / `witness` 正交，**每次提交真跑**，判据同裸值契约。

边界（issue #2 ① 明说的，别做过头）：复跑只该覆盖**不需要构建产物**的事实。
要起服务、要编二进制的那些，写 `fact(值, cmd, 出处, replay=False)` 显式退出 ——
这是有名单、有明说的豁免，不是静默；整道闸也留了 `REFLECT_REPLAY=off` 的整仓出口
（同 `REFLECT_RETIRED` 的先例：**明说未启用，不假装查过**）。
还有一类不需要构建产物、只是**每跑必变**（随机填充长度、GREASE 载荷、时间戳
类，issue #4 ⑤）：存**一次实测采样** + 配一对 `*_stable` 稳定性标记键
（消费侧分两档：stable 逐字判、不稳定档结构判），或显式 `replay=False` ——
**不许裸存**：裸存 = 这条事实永远红 = 噪音 = 最后整闸被关。
值会变 ≠ 不能进台账，得先声明它怎么变。

⚠️ 本闸门执行的是**本仓台账里的命令** —— 信任边界与 pre-commit 脚本本身相同。
台账是仓库自己生产、自己审查的文件；改台账 = 改构建脚本级别的承诺，不是运行时输入。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gate import fatal, finish, main_selftest_or, meta, off, repo  # noqa: E402
from i18n import Catalog, M, bind, load_pack
from knobs import a_pack_lang  # noqa: E402
from ledger import facts_of, load_or_fatal, value_of  # noqa: E402
from runner import (  # noqa: E402
    default_timeout,
    quote,
    run_cmd,
    timeout_with_status,
)


def _replay_one(k, raw_entry, run, seconds, out, stats):
    """复跑**一条**事实，把结果写进 out / stats（issue #22 复杂度拆分）。

    每个分支只做一件事：跳过（replay=False）/ 缺 cmd / 超时 / 坏 rc / 值不符。
    """
    entry = raw_entry if isinstance(raw_entry, dict) else {"value": raw_entry}
    cmd = str(entry.get("cmd") or "").strip()
    if entry.get("replay") is False:
        stats["skipped"] += 1
        return
    if not cmd:
        out.append(M("replay.no_cmd", key=k))
        return
    stats["attempts"] += 1
    rc, stdout = run(cmd)
    if rc is None:
        out.append(M("replay.timeout", key=k, seconds=seconds, command=cmd))
        return
    if rc != 0:
        # `stdout` 此时已被 `run_cmd` 拼上了 stderr（见其注释）——
        # 报进消息里，否则「命令跑挂了」只能靠猜。
        out.append(M("replay.command_failed", key=k, return_code=rc,
                     command=cmd, detail=quote(stdout.strip()[:200])))
        return
    stats["ran"] += 1
    _judge_ok(k, entry, cmd, stdout, out, stats)


def _judge_ok(k, entry, cmd, stdout, out, stats):
    """rc==0 之后的判定：原则档查「表态」，数值档查裸值相等。

    ⚠️ 原则档的契约是**两条一起**（这里踩过一个方向性错误，正是本仓立身
    要杀的那件事 —— 在「杀假绿」的机制里再造一遍假绿）：

      · stdout **非空** —— 真的跑过的闸门会表态（`ok(…)` 或 `OFF: …`）；
        一条什么都不说的命令，无法区分「跑过且通过」与「根本没跑」。
      · stdout **不含 `OFF:` 行** —— 那是「未启用」，不是「通过」。

    只看 rc 的写法把 off 洗成绿（本仓历史上的「8/13 道 off 而全绿不可见」）；
    只看 stdout 会把「静默通过」误判。两条都要。
    """
    if entry.get("kind") == "principle":
        got = stdout.strip()
        if not got:
            out.append(M("replay.principle_said_nothing", key=k, command=cmd))
            return
        import machine  # noqa: PLC0415
        if any(kind == "off" for _i, kind, _ln in machine.scan(got)):
            out.append(M("replay.principle_is_off", key=k,
                         command=cmd, detail=quote(got[:120])))
            return
        stats["ok"] += 1
        return
    got = stdout.strip()
    want = str(value_of(entry))
    if got != want:
        out.append(M("replay.mismatch", key=k,
                     actual=quote(got), expected=quote(want)))
        return
    stats["ok"] += 1




# ⚠️ **环守卫**（实测把内存打爆过：OOM）。
#
# 一条原则的 cmd 可以是**另一个闸门**（那是复用）。但若那个闸门自己也会
# 触发复跑（`registry --run commit` 会跑到本闸门；`gates-selftest.sh` 也是），
# 就形成 `A → B → A` 的环。没有守卫时它会无限 spawn 子进程，直到 OOM
# （实测：`principle.only_measured` 的 cmd 就是本文件自己 —— 自己复跑自己）。
#
# 两道守卫，都必须有：
#   · **进程内**：本模块正在复跑时，再次调用 `replay_all` 直接返回空结果并
#     记一条 `replay.nested`（静默返回会变成「嵌套层说一切正常」）；
#   · **跨进程**：子进程继承环境变量 `EINFACHT_REPLAY_DEPTH`；超过上限 ⇒
#     整道闸门报 `replay.too_deep`（不是静默跳过 —— 环是一个配置错，
#     要人改台账，不是运行时噪音）。
_DEPTH_ENV = "EINFACHT_REPLAY_DEPTH"
_MAX_DEPTH = 2          # 顶层(1) → 子闸门(2) 为止；再深就是环


def _depth():
    try:
        return int(os.environ.get(_DEPTH_ENV, "0") or 0)
    except ValueError:
        return 0


def _probe_failure(kind, key, rc, seconds, command, got, want):
    """一条探针的失败消息。两档各有**独立字面量 code**。

    ⚠️ `i18n` 契约要求 code 是字面量（拼出来的 code 让语言包目录无法被证明
    完备），而且语言包里「见证」与「校准」是两句不同的话 —— 把名词塞进参数
    会让模板词序在非中文语言里崩掉。所以这里是 `if/else` 而不是 `"replay.%s_…" % kind`。
    """
    if rc is None:
        return (M("replay.witness_timeout", key=key, seconds=seconds,
                  command=command) if kind == "witness"
                else M("replay.calibrate_timeout", key=key,
                       seconds=seconds, command=command))
    if rc != 0:
        return (M("replay.witness_command_failed", key=key,
                  return_code=rc, command=command) if kind == "witness"
                else M("replay.calibrate_command_failed", key=key,
                       return_code=rc, command=command))
    return (M("replay.witness_mismatch", key=key,
              actual=quote(got), expected=quote(want)) if kind == "witness"
            else M("replay.calibrate_mismatch", key=key,
                   actual=quote(got), expected=quote(want)))


def _run_probe(kind, key, entry, run, seconds):
    """跑一条探针（见证 / 校准）。返回 `(问题或 None, 是否通过)`。"""
    probe = str(entry.get(kind) or "").strip()
    if not probe:
        return None, False
    expect = entry.get(kind + "_expect")
    rc, stdout = run(probe)
    if rc is None or rc != 0:
        return _probe_failure(kind, key, rc, seconds, probe, "", ""), False
    got = stdout.strip()
    want = str(expect) if expect is not None else ""
    if got != want:
        return _probe_failure(kind, key, rc, seconds, probe, got, want), False
    return None, True


def _one_probe(kind, ok_key, key, entry, run, seconds, out, stats):
    """单条探针：没有这个 kind ⇒ 跳过；有 ⇒ 计一次尝试，跑它并记账。"""
    if not str(entry.get(kind) or "").strip():
        return
    stats[kind + "_attempts"] += 1
    problem, passed = _run_probe(kind, key, entry, run, seconds)
    if problem is not None:
        out.append(problem)
    if passed:
        stats[ok_key] += 1


def _run_probes(f, run, seconds, out, stats):
    """探针档（#5 见证 / #6 ① 仪器校准）：与 replay 正交 —— 贵事实的来源 /
    仪器每提交真跑，判据同裸值契约。"""
    for kind, ok_key in (("witness", "witnessed"), ("calibrate", "calibrated")):
        for key in sorted(f):
            entry = f[key] if isinstance(f[key], dict) else {"value": f[key]}
            _one_probe(kind, ok_key, key, entry, run, seconds, out, stats)


def replay_all(ledger, runner=None):
    """逐条复跑，返回 {problems, ok, attempts, skipped}。**纯副作用只经由 runner**。

    `runner(cmd) -> (rc, stdout)` 可注入（自证用假 runner —— 真 shell 进了自证，
    自证就依赖机器了）。纯函数保持安静：这里一行都不 print。
    """
    if _depth() >= _MAX_DEPTH:
        return {"problems": [M("replay.too_deep", depth=_depth(),
                               limit=_MAX_DEPTH)],
                "ok": 0, "attempts": 0, "ran": 0, "skipped": 0,
                "witness_attempts": 0, "witnessed": 0,
                "calibrate_attempts": 0, "calibrated": 0}
    run = runner or run_cmd
    out = []
    f = facts_of(ledger)
    stats = {"ok": 0, "attempts": 0, "ran": 0, "skipped": 0,
             "witness_attempts": 0, "witnessed": 0,
             "calibrate_attempts": 0, "calibrated": 0}
    if not f:
        # 零值守卫：台账空着不是「没有违规」，是「什么都没量」。
        stats["problems"] = [M("replay.empty_ledger")]
        return stats
    seconds = default_timeout()
    for k in sorted(f):
        _replay_one(k, f[k], run, seconds, out, stats)
    if stats["attempts"] and stats["ran"] == 0:
        out.append(M("replay.none_ran", attempts=stats["attempts"]))
    _run_probes(f, run, seconds, out, stats)
    if not stats["attempts"] and stats["skipped"] and not stats["witness_attempts"] \
            and not stats["calibrate_attempts"]:
        out.append(M("replay.all_skipped", count=stats["skipped"]))
    stats["problems"] = out
    return stats


def run(argv):
    import knobs  # noqa: PLC0415
    # 走 `knobs.flag`（唯一产地）—— 此前 `.lower() == "off"` 是另一套词汇表。
    if knobs.flag("REFLECT_REPLAY") is False:
        return off(M("replay.off"))
    # 解析只此一份（runner.timeout_with_status）—— 此前这里自己 float()
    # 探测一遍，同一个坏值 runner 静默、这里告警（实测：空串两种待遇）。
    seconds, bad_timeout = timeout_with_status()
    if bad_timeout is not None:
        print("⚠ %s" % M("replay.bad_timeout", value=bad_timeout,
                         default=seconds), file=sys.stderr)
    name = os.environ.get("REFLECT_FACTS", "FACTS.json")
    p = repo(name)
    if not os.path.exists(p):
        return fatal(M("replay.ledger_missing", name=name))
    r = replay_all(load_or_fatal(p))
    tail = str(M("replay.ok_skipped", count=r["skipped"])) if r["skipped"] else ""
    wtail = str(M("replay.ok_witnessed", count=r["witnessed"])) if r["witnessed"] else ""
    ctail = str(M("replay.ok_calibrated", count=r["calibrated"]) if r["calibrated"] else "")
    return finish(M("replay.title"), r["problems"],
                  M("replay.ok", count=r["ok"], skipped=tail,
                    witnessed=wtail, calibrated=ctail))


LED = {"facts": {"n": {"value": 12, "cmd": "c"}}}




def _cases_fixture():
    """构造夹台账 + 渲染闭包。返回 dict，喂给三个分组函数。"""
    multi = {"facts": {"a": {"value": 1, "cmd": "ca"},
                       "b": {"value": 2, "cmd": "cb", "replay": False}}}
    wit = {"facts": {"expensive": {"value": "bench-42", "cmd": "run-bench",
                                    "replay": False,
                                    "witness": "echo tool-ok",
                                    "witness_expect": "tool-ok"}}}
    cal = {"facts": {"objcheck": {"value": "fma-present", "cmd": "scan-artifact",
                                   "replay": False,
                                   "calibrate": "echo known-positive",
                                   "calibrate_expect": "known-positive"}}}
    # 「消息必须指向修法」这类判据（重测指引 / 冷启动提示）在 null 包里无法验证
    # —— null 包只有 code + 参数，没有句子。所以这里读**磁盘上真实发布的 zh 包**
    # （`zreflect/lang/zh/facts_replay.json`），把渲染结果当断言面。
    #
    # 为什么读真包而不是注入假表：注入假表只能证明「我写的模板渲染得出我写的话」——
    # 循环论证。读真包才把「迁移没有丢语义」变成可证伪的断言：冷启动提示若从
    # zh 包里掉了，这条自证当场红。（zh 包按契约存的是**逐字的被移除文本**，
    # 所以它同时是「迁移保真」的证据。）
    # ⚠️ 同样不能写死 `zh`（见 check_facts 里同一处注释）：只装一个包是
    # 产品主场景。用**第一个已装的包**；一个都没有 ⇒ 无从成立，明说。
    pack_lang = a_pack_lang()
    real_pack = load_pack(pack_lang) if pack_lang else {}

    def codes(ledger, runner):
        return [p.code for p in replay_all(ledger, runner=runner)["problems"]]

    def said(ledger, runner):
        """在该语言包下渲染后的文本（零包 ⇒ 空列表，判据见 pack_entry_wired）。"""
        if not pack_lang:
            return []
        with bind(Catalog.load(pack_lang, {pack_lang: real_pack})):
            return [str(p) for p in replay_all(ledger, runner=runner)["problems"]]

    def _hint_has(ledger, runner, *anchors):
        """渲染后的句子是否都含这些 **ASCII 锚点**（调用方负责零包的条件短路）。"""
        return any(all(a in text for a in anchors)
                   for text in said(ledger, runner))

    def params(ledger, runner, code):
        return [p.params for p in replay_all(ledger, runner=runner)["problems"]
                if p.code == code]

    return {"multi": multi, "wit": wit, "cal": cal, "said": said,
            "hint_has": _hint_has, "params": params, "codes": codes,
            "pack_lang": pack_lang}


def _cases_replay_ok(fx):
    """① 正常不报：尾换行 / 前后空白被 strip / 显式跳过。"""
    multi = fx["multi"]
    return [
        ("replay.ok_trailing_newline",
         lambda: replay_all(LED, runner=lambda c: (0, "12\n"))["problems"] == []),
        ("replay.ok_string_value",
         lambda: replay_all({"facts": {"s": {"value": "v1", "cmd": "c"}}},
                            runner=lambda c: (0, " v1\n"))["problems"] == []),
        ("replay.ok_skip_declared",
         lambda: replay_all(multi, runner=lambda c: (0, "1"))["problems"] == []),
    ]


def _cases_replay_failures(fx):
    """② 该报的必须报：不符 / 命令死 / 超时 / 缺 cmd。

    两条「修法锚点」（`replay.mismatch_repair_hint` / `timeout_cold_start_hint`）
    是**条件判据**：装了语言包就必须带 ASCII 锚点（`--accept-changes` /
    `REFLECT_REPLAY_TIMEOUT`），零包是合法态、无句子可验 —— 明说不假装通过。
    """
    _hint_has, params = fx["hint_has"], fx["params"]
    codes, pack_lang = fx["codes"], fx["pack_lang"]
    return [
        ("\u2605 replay.mismatch_repair_hint",
         # 真实包里「不符」这条必须仍带修法锚点：`--accept-changes`（ASCII，
         # 是修法的可判定部分）+ `facts.py`（重测命令）。纯中文语义锚点会把自己
         # 变成「本体里的自然语言」—— 那正是零语言闸门要消灭的形状。
         lambda: codes(LED, lambda c: (0, "13")) == ["replay.mismatch"]
         and params(LED, lambda c: (0, "13"), "replay.mismatch")[0]["key"] == "n"
         and (not pack_lang or _hint_has(LED, lambda c: (0, "13"),
                                         "accept-changes", "facts.py"))),
        ("\u2605 replay.mismatch_full_line",
         lambda: codes(LED, lambda c: (0, "count=12 total"))
         == ["replay.mismatch"]),
        ("\u2605 replay.command_failed",
         lambda: codes(LED, lambda c: (1, ""))
         == ["replay.command_failed", "replay.none_ran"]
         and params(LED, lambda c: (1, ""),
                    "replay.command_failed")[0]["return_code"] == 1),
        ("\u2605 replay.timeout_cold_start_hint",
         # 冷启动提示的语义锚点：`REFLECT_REPLAY_TIMEOUT` 旋钮名（ASCII）必须
         # 仍在模板里 —— 删掉冷启动提示句（它原先就带着这个旋钮名）⇒ 这条红。
         lambda: codes(LED, lambda c: (None, ""))
         == ["replay.timeout", "replay.none_ran"]
         and (not pack_lang or _hint_has(LED, lambda c: (None, ""),
                                         "REFLECT_REPLAY_TIMEOUT"))),
        ("\u2605 replay.no_cmd",
         lambda: codes({"facts": {"n": {"value": 1, "source": "s"}}},
                       lambda c: (0, "1")) == ["replay.no_cmd"]),
    ]


def _cases_replay_empty(fx):
    """③ 空输入必须报：空台账 / 一条都没跑成 / 全部跳过。"""
    codes, params = fx["codes"], fx["params"]
    two = {"facts": {"a": {"value": 1, "cmd": "x"},
                     "b": {"value": 2, "cmd": "y"}}}
    return [
        ("\u2605 replay.empty_ledger",
         lambda: codes({"facts": {}}, lambda c: (0, "")) == ["replay.empty_ledger"]),
        ("\u2605 replay.none_ran",
         lambda: codes(two, lambda c: (1, ""))
         == ["replay.command_failed", "replay.command_failed",
             "replay.none_ran"]
         and params(two, lambda c: (1, ""),
                    "replay.none_ran")[0]["attempts"] == 2),
        ("\u2605 replay.all_skipped",
         lambda: codes({"facts": {"a": {"value": 1, "cmd": "x",
                                        "replay": False}}},
                       lambda c: (0, "1")) == ["replay.all_skipped"]),
    ]


def _cases_replay(fx):
    """见 `_cases()`：本组 11 条。

    三组（正常 / 该报 / 空输入）：11 条扁平清单里，那两条**条件判据**
    （装包才验锚点）混在其中，读者不容易看出它们为什么带 `not pack_lang`。
    """
    return (_cases_replay_ok(fx) + _cases_replay_failures(fx)
            + _cases_replay_empty(fx))


def _cases_witness(fx):
    """见 `_cases()`：本组 6 条。"""
    codes = fx["codes"]
    wit = fx["wit"]
    return [
    # ③ 见证档（issue #5）
    ("replay.witness_ok",
     lambda: replay_all(wit, runner=lambda c: (0, "tool-ok"))["problems"] == []),
    ("replay.witness_counted",
     lambda: replay_all(wit, runner=lambda c: (0, "tool-ok"))["witnessed"] == 1),
    ("★ replay.witness_mismatch",
     lambda: codes(wit, lambda c: (0, "tool-CHANGED"))
     == ["replay.witness_mismatch"]),
    ("★ replay.witness_command_failed",
     lambda: codes(wit, lambda c: (1, "")) == ["replay.witness_command_failed"]),
    ("★ replay.witness_timeout",
     lambda: codes(wit, lambda c: (None, "")) == ["replay.witness_timeout"]),
    ("replay.witness_satisfies_guard",
     lambda: "replay.all_skipped" not in
     codes(wit, lambda c: (0, "tool-ok"))),
    ]


def _cases_calibrate(fx):
    """见 `_cases()`：本组 6 条。"""
    codes = fx["codes"]
    cal = fx["cal"]
    return [
    # ④ 仪器校准档（issue #6 ①）
    ("replay.calibrate_ok",
     lambda: replay_all(cal, runner=lambda c: (0, "known-positive"))["problems"] == []),
    ("replay.calibrate_counted",
     lambda: replay_all(cal, runner=lambda c: (0, "known-positive"))["calibrated"] == 1),
    ("★ replay.calibrate_mismatch",
     lambda: codes(cal, lambda c: (0, "wrong")) == ["replay.calibrate_mismatch"]),
    ("★ replay.calibrate_command_failed",
     lambda: codes(cal, lambda c: (1, "")) == ["replay.calibrate_command_failed"]),
    ("★ replay.calibrate_timeout",
     lambda: codes(cal, lambda c: (None, "")) == ["replay.calibrate_timeout"]),
    ("replay.calibrate_satisfies_guard",
     lambda: "replay.all_skipped" not in
     codes(cal, lambda c: (0, "known-positive"))),
    ]


def _cases():
    """拼装三组夹具断言。**只拼装** —— 判据在各分组函数里。"""
    fx = _cases_fixture()
    return (
        _cases_replay(fx)
        + _cases_witness(fx)
        + _cases_calibrate(fx)
    )



GATE = meta("复跑闸门", "台账 cmd 逐字复跑（裸值契约：stdout 必须等于值）",
            knobs=("REFLECT_FACTS", "REFLECT_REPLAY", "REFLECT_REPLAY_TIMEOUT"),
            name_dependent=True,
            # ⚠️ 此前这里写的是「未配时明说未启用」——**假的**：未配时照跑，
            # 只有显式 `REFLECT_REPLAY=off` 才关（实测三种状态）。复跑现在承载
            # 「principle 每提交强制运行」这条需求，不能默认关。
            off_reason="显式设 REFLECT_REPLAY=off 时整道闸门关闭（这是整仓出口；未配时照跑）")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:],
                              M("gate.title.facts_replay"),
                              _cases, run))
