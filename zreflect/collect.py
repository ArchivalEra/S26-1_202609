#!/usr/bin/env python3
"""事实采集器的契约与帮手 —— 从 Octave-Full-Wasm 的 `.githooks/handoff_facts.py` 迁移。

`measure()`（facts.py）怎么写，决定了台账里的数是**测出来的**还是**编出来的**。
那边把采集器单独成一个模块、并把下面四条原则写在文件头，因为这个模块同时喂两个
消费者（重算机器块的生成器 + 查陈旧断言的闸门）—— **两边必须用同一套读法**，
否则口径分叉，闸门查的就是另一套数字了。

四条原则（都是那边踩出来的，采集器必须遵守）：

  1. **只读持久盘产物**，不跑服务、不碰网络。pre-commit 里不该依赖"某个东西正在跑"。
  2. **不引入会自己在变的输入**：机器块里不放"墙上时钟"、不放 HEAD 的 sha ——
     否则同一个提交里 `--check` 永远不收敛。要用时间就用**提交日期**。
     （issue #4 ⑤ 续：**值会变 ≠ 不能进台账，得先声明它怎么变** ——
     每跑必变的量（随机填充长度、GREASE 载荷、时间戳类）存**一次实测采样**，
     配一对 `*_stable` 稳定性标记键（消费侧分两档：stable 档逐字判、
     不稳定档结构判），或显式 `replay=False`；**不许裸存** —— 裸存会让
     复跑闸门永远红，最后被整闸 `REFLECT_REPLAY=off` 糊掉，那才是真正的
     无人看管。）
  3. **读不到就明说**：产物不在（换了机器 / 没挂盘）⇒ `unavailable(what, why)`，
     让调用方决定是警告还是跳过。**绝不编一个数字** —— 0 是一个数字，会被人当结果引用。
  4. **贵的测量要有缓存**：先从现有机器块里回收上一次的测量值（`prev_values`），
     输入没变就沿用。那边用它免掉"每次提交都重压 36 MiB"。
  5. **输入要有便宜的落点**（issue #6 ②）：产物生成之后，它的输入
     （源 / 工具 / 旗标 / 环境）必须有一条**不依赖重跑**的可读记录，
     并配一条**便宜的来源不变式**（`witness`，issue #5）在每次
     提交时核对。否则"产物没变、产出它的东西变了"不可见。
     （`witness` 是这条原则的实例；声明式不变量（issue #7，
     `check_invariants.py`）是另一实例：不变量文件 = 输入落点，
     不变量闸门 = 该落点的便宜来源不变式。其强度上限 = 它
     匹配的文本形态 —— grep 型分不清注释与代码，证明的是
     「这段文字还在」而不是「代码里真在用」；更强的保证是
     `calibrate`（对产物量）或 `witness`（对来源量）的活。
     分层构建里这类不变式很多：输入文件 sha、编译器版本 +
     旗标、环境变量快照、中间产物架构。）

复跑可判定性（issue #2 ① —— 五条之外的一条硬前提）：`cmd` **不是注释**。
`zreflect/check_facts_replay.py` 会在仓库根逐字执行它（bash + `pipefail`，所以管道
不再吞错），stdout 去掉首尾空白后必须**等于**台账值 —— 所以只许打印**裸值**，
"含该值的整行"人眼可读、机器不可判。要起服务/要构建产物的量法不适用复跑：
`fact(值, cmd, 出处, replay=False)` 显式退出，留给各仓自己的上层闸门。
（issue #5：贵事实别落在**永不复查**档 —— 挂便宜见证
`fact(值, cmd, 出处, replay=False, witness=…, witness_expect=…)`：
值不逐字复跑，但**来源/上下文**（"产出它的工具/输入就是我以为的
那个"）每提交真跑、判据同裸值契约。两者必须同给，残缺形状由
`ledger.fact()` 当场报错。）
"""
import re

from gate import module_meta, repo                                    # noqa: F401  (re-export 便利)


def unavailable(what, why):
    """「读不到」的诚实形状。调用方（渲染/闸门）必须把它渲染成明说，不许当成 0。"""
    return {"ok": False, "why": why}


def parse_prev_values(doc_text, row_pattern, group_names):
    """从现有机器块里回收上一次的测量值（原则 4 的通用形状）。

    `row_pattern`：一行的正则，用命名分组 `(?P<名字>…)` 标出要回收的值；
    `group_names`：要回收的分组名元组。返回 {行首键: {名字: 值}}。

    返回的值是**字符串** —— 数字不数字由采集器自己解释（它知道口径）。
    典型用法：先把上次的 (raw, gz) 拿回来，输入没变就跳过贵的测量。
    """
    out = {}
    if not doc_text:
        return out
    pat = re.compile(row_pattern)
    for m in pat.finditer(doc_text):
        key = m.group(1)
        rec = {}
        for name in group_names:
            try:
                rec[name] = m.group(name)
            except IndexError as error:
                # 未命名分组 = 配置错，必须响，不许静默拿错值。
                raise SystemExit(
                    "FATAL: parse_prev_values：行正则里没有命名分组 %r —— "
                    "回收靠命名分组，别用位置分组（换行序 = 静默拿错值）" % name) from error
        out[key] = rec
    return out


MODULE = module_meta("采集器契约", "measure() 的四条原则 + 帮手（无独立自证）", selftest=False)
