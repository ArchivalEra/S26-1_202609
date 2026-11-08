#!/bin/sh
# selftest.sh —— .kimi-code/hooks/einfacht-next.sh 的自证（手动跑；照
# Static-Contract 同名体例）。
#
# 五个用例，判据写死在期望值里（不读夹具动态生成的东西断言自己）：
#   ① 本仓注入：payload cwd 在本仓 ⇒ stdout 含 zh 载体渲染的两段标题；
#   ② 未接线仓静默：cwd 无 zreflect/ ⇒ 无输出 rc 0（不注入也不报错）；
#   ③ 垃圾 stdin 静默：非 JSON ⇒ 无输出 rc 0（fail-open，不挡用户消息）；
#   ④ 空 stdin 静默：钩子意外被无 payload 调用 ⇒ 同上；
#   ⑤ 外部 REFLECT_LANG=en ⇒ 仍按本仓载体出中文（载体显式覆盖环境，
#      「各跑各的」契约）。

set -u
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SHELL_SCRIPT="$HERE/einfacht-next.sh"
REPO=$(CDPATH= cd -- "$HERE/../.." && pwd)

bad=0
chk() {
  if [ "$2" = "$3" ]; then
    echo "PASS | $1"
  else
    echo "fail | $1 (expected=$2 actual=$3)"
    bad=$((bad + 1))
  fi
}

# ① 本仓注入（zh 载体 REFLECT_LANG=zh 的实测渲染文本；上游修 #31 改措辞时
#    这里会红 —— 那正是想要的重算时机）
out=$(printf '{"cwd":"%s"}' "$REPO" | sh "$SHELL_SCRIPT")
rc=$?
chk "injects_wired_repo(rc)" "0" "$rc"
case "$out" in
  *"接着上一轮（每次会话现算，不落盘）："*) chk "injects_wired_repo(zh)" "zh-header" "zh-header" ;;
  *) chk "injects_wired_repo(zh)" "zh-header" "missing" ;;
esac

# ② 未接线仓静默（/tmp 没有 zreflect/）
out=$(printf '{"cwd":"/tmp"}' | sh "$SHELL_SCRIPT"); rc=$?
chk "unwired_repo_silent(rc)" "0" "$rc"
chk "unwired_repo_silent(out)" "" "$out"

# ③ 垃圾 stdin 静默
out=$(printf 'not-json' | sh "$SHELL_SCRIPT"); rc=$?
chk "garbage_stdin_silent(rc)" "0" "$rc"
chk "garbage_stdin_silent(out)" "" "$out"

# ④ 空 stdin 静默
out=$(printf '' | sh "$SHELL_SCRIPT"); rc=$?
chk "empty_stdin_silent(rc)" "0" "$rc"
chk "empty_stdin_silent(out)" "" "$out"

# ⑤ 外部语言被仓载体覆盖
out=$(printf '{"cwd":"%s"}' "$REPO" | REFLECT_LANG=en sh "$SHELL_SCRIPT")
case "$out" in
  *"接着上一轮"*) chk "env_lang_overridden_by_carrier" "zh" "zh" ;;
  *) chk "env_lang_overridden_by_carrier" "zh" "non-zh" ;;
esac

echo "=== $((5 - bad)) PASS / $bad FAIL ==="
[ "$bad" -eq 0 ] || exit 1
