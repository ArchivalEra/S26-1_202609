#!/bin/sh
# einfacht-next.sh —— 本仓自搓的 kimi-code 薄壳（stdout 喂给会话启动注入）。
# 从 cwd 向上找「有 zreflect/ 的 git 仓」；找不到 ⇒ 静默退出（rc 0 无输出）。

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

python3 - "$REPO" <<'PY'
import json, os, sys
repo = sys.argv[1]
os.chdir(repo)
sys.path.insert(0, os.path.join(repo, "zreflect"))
lang = None
knobs_path = os.path.join(repo, "knobs.json")
if os.path.isfile(knobs_path):
    try:
        lang = json.load(open(knobs_path, encoding="utf-8")).get("REFLECT_LANG")
    except Exception:
        lang = None
from gate import activate_or_fatal
rc = activate_or_fatal(lang or "zh")
if rc:
    sys.exit(rc)
import next
print("\n".join(next.section(repo)))
PY
