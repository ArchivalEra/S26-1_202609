#!/bin/sh
# einfacht-next.sh —— 本仓自搓的 kimi-code 薄壳（AGENTS.md 说的「使用方自己加的一层」）。
#
# 为什么是仓级壳而不是用户级钩子：kimi-code 的钩子注册只有用户级
# （~/.kimi-code/config.toml 的 [[hooks]]），没有按仓挂载；用户级 = 影响这台
# 机器上**所有**会话（实测四代全回滚：外仓会话被注进 Einfacht 待办、老仓
# python 报错被当成闸门红假拦截 37 次提交）。所以：壳住在本仓 .kimi-code/hooks/
# 下，**不注册进任何用户级 config**——要注入时，把本仓 cwd 的 payload 喂给它
# （手跑，或使用者自己的本地手段）；别的仓各跑各的，宿主不代管。
#
# 输入：stdin 里的 JSON payload（只认 cwd 字段；heredoc 会占用 stdin，
# payload 必须走 printf 管道）。
# 门禁：从 cwd 向上找「有 zreflect/ 的 git 仓」（普通 clone 与 worktree 的
# .git 文件都认）；找不到 ⇒ 静默退出（rc 0 无输出 = 不注入，不猜不假装）。
# REFLECT_* 从该仓的 env 载体来（einfacht-env.sh 插件契约，
# EINFACHT_PLUGIN_DIR 显式给目录——被 source 时 $0 不可靠，见插件注释）。
#
# ⚠️ 本壳必须是 /bin/sh 且**无后缀**：带 .py 落仓根会被 measure_example 的
# os.walk 扫进 py_files，台账立刻对不上（临时通知文档实测踩过）。
# ⚠️ 这里不走 `python3 zreflect/next.py`：上游 #31——手跑路径不激活语言包，
# REFLECT_LANG=zh 下也只出裸 code。本壳自己走 activate_or_fatal()；
# 上游修复后 python 块可简化成 `sys.exit(next.main([repo]))`。

input=$(cat)
cwd=$(printf '%s' "$input" | python3 -c 'import json,sys
print(json.load(sys.stdin).get("cwd",""))' 2>/dev/null) || exit 0

REPO=""
while [ -n "$cwd" ] && [ "$cwd" != "/" ]; do
  if [ -d "$cwd/zreflect" ] && { [ -d "$cwd/.git" ] || [ -f "$cwd/.git" ]; }; then
    REPO=$cwd
    break
  fi
  cwd=$(dirname "$cwd")
done
[ -n "$REPO" ] || exit 0

EINFACHT_PLUGIN_DIR="$REPO/reflect-hooks" . "$REPO/reflect-hooks/einfacht-env.sh"

python3 - "$REPO" <<'PY'
import sys
sys.path.insert(0, sys.argv[1] + "/zreflect")
from gate import activate_or_fatal
rc = activate_or_fatal()
if rc:
    sys.exit(rc)
import next
print("\n".join(next.section(sys.argv[1])))
PY
