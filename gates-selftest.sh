#!/bin/sh
# 兼容薄壳：**老调用方式**（`sh gates-selftest.sh`）仍然有效，逻辑全在
# `zreflect/harness.py`。新代码请直接调 `python3 zreflect/harness.py`。
#
# 为什么它还留着一个 .sh（全 Python 化目标的唯一例外）：
#   别的仓的 CI / hook 里写的是这一行；删掉它，那些仓会在自己的 CI 里拿
#   rc=127（file not found）静默变红 —— 那是「只升级不破坏」的反面。
#   本文件只有一行 exec、**零文案**（没有中文可漏），代价可忽略。
exec python3 "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/zreflect/harness.py" "$@"
