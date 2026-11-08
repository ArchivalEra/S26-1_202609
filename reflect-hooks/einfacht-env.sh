#!/bin/sh
# einfacht-env.sh —— 可拔插件（issue #8）：钩子的 repo-local Einfacht.env 载体。
#
# 为什么是「插件」而不是焊进钩子的代码：机制要能拔 ——
# 删掉本文件，钩子什么都不改地回落「纯环境变量 + 各闸门
# 默认名」（钩子里的 source 行带 [ -f ] 守卫）。钩子本体
# 保持通用；「REFLECT_* 的值从哪里来」是这一个文件的事，
# 换来源 = 换/删这一个文件，不用动两道钩子（焊进两处 =
# 两份会漂移的拷贝，正是本仓要消灭的坏法）。
#
# 本项目认的唯一一份 env 文件是 Einfacht.env（默认名；
# REFLECT_ENV_FILE 可换 —— 那个旋钮经环境变量到达，
# 钩子语境里靠默认名才 durably 生效）。其他仓库用
# Einfacht 时想用自己的 env 文件 / 名字：改自己仓库里的
# 这份插件即可 —— 那是他们自己的事。
#
# 加载顺序（第一个命中的生效）：
#   1. 本文件所在目录的 Einfacht.env（随机制分发的位置）
#   2. 仓库根的 Einfacht.env
# 都没有 ⇒ 什么也不做（守卫：缺文件不是错误，全部回落
# 默认名）。Einfacht.env 里的 export 覆盖环境里的同名值
# —— 对钩子来说文件才是可复现的来源（「谁记得 export」
# 换机器 / 换 CI / 换人就没了，不算数）。
#
# $0 约定：被钩子 source 时 $0 = 钩子路径（dirname = 本
# 目录）；直接跑本文件时 $0 = 本文件路径（dirname = 本
# 目录）——两种情形都指向 reflect-hooks/，故从 $0 推目录。

# —— 自证（先于加载逻辑：自证期间不许 source 当前仓库的
#    Einfacht.env。被钩子 source 时 $0 是钩子路径，进不来；
#    钩子即便被带 --selftest 调用，basename 也对不上）——
if [ "${1:-}" = "--selftest" ] && [ "$(basename -- "$0")" = "einfacht-env.sh" ]; then
  _bad=0
  # 文案走语言包：本文件**必须**是 shell（被钩子 `source` 以导出变量），
  # 但输出是用户可见文本 ⇒ 经 `M()` 取。`_say <code> key=value…`。
  _PY="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/zreflect"
  _say() {
    _code="$1"; shift
    python3 -c "
import sys
sys.path.insert(0, sys.argv[1])
from gate import activate_or_fatal
activate_or_fatal()
from i18n import M
code = sys.argv[2]
params = {}
for a in sys.argv[3:]:
    if '=' in a:
        k, v = a.split('=', 1)
        params[k] = v
print(M(code, **params))
" "$_PY" "$_code" "$@"
  }
  _t=$(mktemp -d) || { echo "FATAL: $(_say hookenv.mktemp_failed)" >&2; exit 2; }
  mkdir -p "$_t/h"
  cp "$(dirname -- "$0")/einfacht-env.sh" "$_t/h/"
  # 假钩子：与真钩子同款的两行（带守卫的 source）后报出 REFLECT_DOC
  printf '#!/bin/sh\nHERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\n[ -f "$HERE/einfacht-env.sh" ] && . "$HERE/einfacht-env.sh"\necho "DOC=${REFLECT_DOC:-STATE.md}"\n' > "$_t/h/fake"
  chmod +x "$_t/h/fake"
  # _chk <标签> <期望> <实测>
  _chk() {
    if [ "$2" = "$3" ]; then
      echo "PASS | $1"
    else
      echo "fail | $(_say hookenv.case_failed label="$1" expected="$2" actual="$3")"
      _bad=$((_bad + 1))
    fi
  }
  # ① 无 Einfacht.env ⇒ 回落默认名
  _chk "hookenv.default_name" "DOC=STATE.md" "$("$_t/h/fake")"
  # ② 钩子目录 Einfacht.env ⇒ 生效
  printf 'export REFLECT_DOC="MYSTATE.md"\n' > "$_t/h/Einfacht.env"
  _chk "hookenv.hooks_dir_env" "DOC=MYSTATE.md" "$("$_t/h/fake")"
  # ③ 仓库根 Einfacht.env（钩子目录没有时回落）
  rm "$_t/h/Einfacht.env"
  printf 'export REFLECT_DOC="ROOTSTATE.md"\n' > "$_t/Einfacht.env"
  _chk "hookenv.repo_root_env" "DOC=ROOTSTATE.md" "$("$_t/h/fake")"
  # ④ 两处都有 ⇒ 钩子目录优先
  printf 'export REFLECT_DOC="HOOKS.md"\n' > "$_t/h/Einfacht.env"
  _chk "hookenv.hooks_dir_wins" "DOC=HOOKS.md" "$("$_t/h/fake")"
  # ⑤ 环境 export 与文件同时在 ⇒ 文件覆盖（对钩子，文件是可复现来源）
  _chk "hookenv.file_beats_export" "DOC=HOOKS.md" "$(REFLECT_DOC=ENVVALUE "$_t/h/fake")"
  # ⑥ 拔掉插件 ⇒ 钩子什么都不改地回落（「能拔」的证伪证明）
  rm "$_t/h/einfacht-env.sh"
  _chk "hookenv.plugin_removable" "DOC=STATE.md" "$("$_t/h/fake")"
  rm -rf "$_t"
  # 人读摘要行（翻译）+ 机器摘要行（字面量，不译）。
  echo "=== $(_say hookenv.summary passed="$((6 - _bad))" failed="$_bad") ==="
  echo "=== $((6 - _bad)) PASS / $_bad FAIL ==="
  if [ "$_bad" -eq 0 ]; then exit 0; else exit 1; fi
fi

# —— 加载逻辑 ——
# ⚠️ `$0` 不可靠：被 `sh -c '. "$1"' sh <plugin>` 调用时 `$0` 是 `sh`，
# `dirname` 就成了 `/`，插件目录找错 ⇒ **钩子目录里的 Einfacht.env 被静默忽略**
# （实测：`env -0` 里一个 REFLECT_* 都没有）。调用方可以用
# `EINFACHT_PLUGIN_DIR` 显式告诉它 —— 有就用它，没有才回落 `$0`（直接跑本文件
# 或旧的 `source` 用法都走这条）。
_ENV_DIR=${EINFACHT_PLUGIN_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}
_ENV_REPO=$(CDPATH= cd -- "$_ENV_DIR/.." && pwd)
_ENV_FILE=${REFLECT_ENV_FILE:-Einfacht.env}
if [ -f "$_ENV_DIR/$_ENV_FILE" ]; then
  . "$_ENV_DIR/$_ENV_FILE"
elif [ -f "$_ENV_REPO/$_ENV_FILE" ]; then
  . "$_ENV_REPO/$_ENV_FILE"
fi
unset _ENV_DIR _ENV_REPO _ENV_FILE
