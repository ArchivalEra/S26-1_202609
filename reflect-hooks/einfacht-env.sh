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
  _t=$(mktemp -d) || { echo "FATAL: mktemp 失败"; exit 2; }
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
      echo "fail | $1（期望「$2」实测「$3」）"
      _bad=$((_bad + 1))
    fi
  }
  # ① 无 Einfacht.env ⇒ 回落默认名
  _chk "无 Einfacht.env ⇒ 默认 STATE.md" "DOC=STATE.md" "$("$_t/h/fake")"
  # ② 钩子目录 Einfacht.env ⇒ 生效
  printf 'export REFLECT_DOC="MYSTATE.md"\n' > "$_t/h/Einfacht.env"
  _chk "reflect-hooks/Einfacht.env ⇒ MYSTATE.md" "DOC=MYSTATE.md" "$("$_t/h/fake")"
  # ③ 仓库根 Einfacht.env（钩子目录没有时回落）
  rm "$_t/h/Einfacht.env"
  printf 'export REFLECT_DOC="ROOTSTATE.md"\n' > "$_t/Einfacht.env"
  _chk "仓库根 Einfacht.env ⇒ ROOTSTATE.md" "DOC=ROOTSTATE.md" "$("$_t/h/fake")"
  # ④ 两处都有 ⇒ 钩子目录优先
  printf 'export REFLECT_DOC="HOOKS.md"\n' > "$_t/h/Einfacht.env"
  _chk "两处都有 ⇒ 钩子目录优先" "DOC=HOOKS.md" "$("$_t/h/fake")"
  # ⑤ 环境 export 与文件同时在 ⇒ 文件覆盖（对钩子，文件是可复现来源）
  _chk "文件覆盖环境 export" "DOC=HOOKS.md" "$(REFLECT_DOC=ENVVALUE "$_t/h/fake")"
  # ⑥ 拔掉插件 ⇒ 钩子什么都不改地回落（「能拔」的证伪证明）
  rm "$_t/h/einfacht-env.sh"
  _chk "拔掉插件 ⇒ 回落默认名" "DOC=STATE.md" "$("$_t/h/fake")"
  rm -rf "$_t"
  echo "=== einfacht-env 插件自证：$((6 - _bad)) PASS / $_bad fail ==="
  echo "=== $((6 - _bad)) PASS / $_bad FAIL ==="
  if [ "$_bad" -eq 0 ]; then exit 0; else exit 1; fi
fi

# —— 加载逻辑 ——
_ENV_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
_ENV_REPO=$(CDPATH= cd -- "$_ENV_DIR/.." && pwd)
_ENV_FILE=${REFLECT_ENV_FILE:-Einfacht.env}
if [ -f "$_ENV_DIR/$_ENV_FILE" ]; then
  . "$_ENV_DIR/$_ENV_FILE"
elif [ -f "$_ENV_REPO/$_ENV_FILE" ]; then
  . "$_ENV_REPO/$_ENV_FILE"
fi
unset _ENV_DIR _ENV_REPO _ENV_FILE
