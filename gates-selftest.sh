#!/bin/sh
# 闸门自证：**发现**闸门（不靠手写名单）+ 每个闸门必须先证明自己会红。
#
# 为什么是「发现」而不是「清单」：手写名录一定会漂。加新检查器时忘了登记，那个检查器
# 就变成「没人盯着的检查器」—— 而名录本身还绿着告诉你一切正常。实测过：一个自证脚本
# 自己拿某个检查器的 `0/0` bug 当立论依据，而那个检查器至今不在它的名单里。
# 所以这里反过来：**登记是被发现的，不是被记得的。**
#
# 用法：sh gates-selftest.sh          跑全部闸门
#       sh gates-selftest.sh --selftest   证明这个 runner 自己会红（它也需要）
set -u
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

run_gates() {
  # $1 = 仓库根；$2 = 文件清单（可选，换行分隔）。
  # 生产：清单 = `registry --all-runnable`（声明派生，glob 退役 —— C1）。
  # 自证：夹具显式传假清单（不依赖真仓）。
  # 全绿返回 0；否则返回 1。
  d=$1
  if [ -n "${2:-}" ]; then
    list=$2
  else
    list=$(cd "$d" && python3 zreflect/registry.py --all-runnable 2>/dev/null)
  fi
  n=0
  bad=0
  for rel in $list; do
    g="$d/$rel"
    [ -f "$g" ] || { echo "  ❌ $rel 不在（registry 点了名，文件却不在）"; bad=$((bad + 1)); continue; }
    n=$((n + 1))
    # 自证的广告标记：平台尾巴 main_selftest_or（--selftest 的路由在
    # gate.py），或老式字面量。两者都没有 = 没人盯着的闸门。
    if ! grep -qE '(main_selftest_or|--selftest)' "$g"; then
      echo "  ❌ $rel 没有 --selftest（未登记的闸门 = 没人盯着的闸门）"
      bad=$((bad + 1))
      continue
    fi
    out=$(GATE_REPO="$d" python3 "$g" --selftest 2>&1)
    if [ $? -ne 0 ]; then
      echo "  ❌ $rel"
      printf '%s\n' "$out" | tail -3 | sed 's/^/      /'
      bad=$((bad + 1))
      continue
    fi
    # 机器摘要行（issue #3 ③）：每个自证必须以 `=== N PASS / M FAIL ===` 收尾。
    # 缺了 ⇒ 红（runner/CI 靠它机器读；没有它的自证 = 不可机器读的自证）。
    if ! printf '%s\n' "$out" | grep -qE '^=== [0-9]+ PASS / [0-9]+ FAIL ===$'; then
      echo "  ❌ $rel 自证缺机器摘要行（=== N PASS / M FAIL ===，issue #3 ③）"
      bad=$((bad + 1))
      continue
    fi
    echo "  ✅ $rel  $(printf '%s\n' "$out" | tail -1)"
  done
  if [ "$n" -eq 0 ]; then
    echo "  ❌ 一个闸门都没发现 —— 零值守卫：空输入不是通过"
    return 1
  fi
  if [ "$bad" -ne 0 ]; then
    echo "  ---- 发现 $n 个闸门，其中 $bad 个有问题"
    return 1
  fi
  echo "  ---- 发现 $n 个闸门，全部能红 ✅"
  return 0
}

selftest() {
  t=$(mktemp -d)
  bad=0
  mkdir -p "$t/good/zreflect" "$t/nomark/zreflect" "$t/failing/zreflect" "$t/empty/zreflect" "$t/nomachine/zreflect"

  # 夹具①：广告了 --selftest 且全过（含机器摘要行）⇒ 应该全绿
  cat >"$t/good/zreflect/check_ok.py" <<'EOF'
import sys
print("=== ok 自证：3 PASS / 0 fail ===")
print("=== 3 PASS / 0 FAIL ===")
sys.exit(0 if "--selftest" in sys.argv else 0)
EOF
  # 夹具②：没广告 --selftest ⇒ 必须红
  cat >"$t/nomark/zreflect/check_silent.py" <<'EOF'
import sys
sys.exit(0)
EOF
  # 夹具③：广告了但自证失败 ⇒ 必须红
  cat >"$t/failing/zreflect/check_bad.py" <<'EOF'
import sys
print("=== bad 自证：1 PASS / 1 fail ===")
print("=== 1 PASS / 1 FAIL ===")
sys.exit(1 if "--selftest" in sys.argv else 0)
EOF
  # 夹具④：一个闸门都没有 ⇒ 必须红（零值守卫）
  # 夹具⑤：rc=0 且广告了 --selftest、但自证缺机器摘要行 ⇒ 必须红（issue #3 ③）
  cat >"$t/nomachine/zreflect/check_nomachine.py" <<'EOF'
import sys
print("=== no machine line ===")
sys.exit(0 if "--selftest" in sys.argv else 0)
EOF

  show() { printf '%s' "$1" | sed 's/^/      /'; }

  out=$(run_gates "$t/good" "zreflect/check_ok.py" 2>&1) && { echo "  PASS | 全绿夹具 ⇒ runner 绿"; } \
    || { echo "  fail | 全绿夹具 ⇒ runner 却是红的（阳性对照失败：runner 可能是'总是红'）"; show "$out"; bad=1; }

  out=$(run_gates "$t/nomark" "zreflect/check_silent.py" 2>&1) && { echo "  fail | 缺 --selftest 的闸门 ⇒ runner 竟然绿了"; bad=1; } \
    || echo "  PASS | 缺 --selftest 的闸门 ⇒ runner 红"

  out=$(run_gates "$t/failing" "zreflect/check_bad.py" 2>&1) && { echo "  fail | 自证失败的闸门 ⇒ runner 竟然绿了"; bad=1; } \
    || echo "  PASS | 自证失败的闸门 ⇒ runner 红"

  out=$(run_gates "$t/empty" "" 2>&1) && { echo "  fail | 一个闸门都没有 ⇒ runner 竟然绿了（零值守卫失效）"; bad=1; } \
    || echo "  PASS | 一个闸门都没有 ⇒ runner 红（零值守卫）"

  out=$(run_gates "$t/nomachine" "zreflect/check_nomachine.py" 2>&1) && { echo "  fail | 缺机器摘要行的闸门 ⇒ runner 竟然绿了（issue #3 ③）"; bad=1; } \
    || echo "  PASS | 缺机器摘要行的闸门 ⇒ runner 红（issue #3 ③）"

  rm -rf "$t"
  if [ "$bad" -eq 0 ]; then
    echo "=== gates-selftest 自证：5 PASS / 0 fail ==="
    return 0
  fi
  echo "=== gates-selftest 自证：有失败 ==="
  return 1
}

plugin_selftest() {
  # 自证点名的插件清单从 registry 派生（Phase 3）：reflect-hooks/*.sh
  # 带自证标记的（发现式收编）+ 点名特殊件（doctor.py —— 「查会死的东西，
  # 故意不进发现式名录」的理由住在 registry.SPECIAL_PLUGINS 数据旁）。
  # 此前 plugin / doctor 各手写一段 —— 新插件忘了点名就静默没人盯。
  bad=0
  for p in $(python3 "$HERE/zreflect/registry.py" --plugins); do
    f="$HERE/$p"
    if [ ! -f "$f" ]; then
      echo "  ❌ $p 不存在（registry 点了名，文件却不在）"
      bad=$((bad + 1))
      continue
    fi
    case "$p" in
      *.sh) cmd="sh" ;;
      *)    cmd="python3" ;;
    esac
    out=$("$cmd" "$f" --selftest 2>&1)
    if [ $? -ne 0 ]; then
      echo "  ❌ $p"
      printf '%s\n' "$out" | tail -3 | sed 's/^/      /'
      bad=$((bad + 1))
      continue
    fi
    if ! printf '%s\n' "$out" | grep -qE '^=== [0-9]+ PASS / [0-9]+ FAIL ===$'; then
      echo "  ❌ $p 自证缺机器摘要行（=== N PASS / M FAIL ===，issue #3 ③）"
      bad=$((bad + 1))
      continue
    fi
    echo "  ✅ $p  $(printf '%s\n' "$out" | tail -1)"
  done
  [ "$(python3 "$HERE/zreflect/registry.py" --plugins | wc -l)" -ge 1 ] || {
    echo "  ❌ 插件名单为空 —— 零值守卫：einfacht-env.sh / doctor 至少要在册"; bad=$((bad + 1)); }
  return "$bad"
}

module_selftest() {
  # 平台模块（不是闸门：gate / runner / knobs / registry / guard / ledger /
  # render / facts …）也写自证 —— 但 run_gates 只跑**闸门**（registry
  # --all-runnable），平台模块的自证此前【无人执行】= 装饰（实测：guard.py
  # 正犯此病）。这里只跑**闸门以外**的自证模块（差集 —— 闸门的自证已在
  # run_gates 跑过，不再跑第二遍；此前两段各跑一遍 13 道，重复执行）。
  all_gates=$(cd "$HERE" && python3 zreflect/registry.py --all-runnable | tr '\n' ' ')
  bad=0
  mods=$(python3 "$HERE/zreflect/registry.py" --selftest-modules) || {
    echo "  ❌ 平台模块自证名录不干净（有写了自证却没入口的模块）"
    printf '%s\n' "$mods" | sed 's/^/      /'
    bad=$((bad + 1))
    mods=""
  }
  n=0
  for m in $mods; do
    case " $all_gates " in *" $m "*) continue ;; esac   # 闸门的自证归 run_gates
    n=$((n + 1))
    f="$HERE/$m"
    out=$(python3 "$f" --selftest 2>&1)
    if [ $? -ne 0 ]; then
      echo "  ❌ $m"
      printf '%s\n' "$out" | tail -3 | sed 's/^/      /'
      bad=$((bad + 1))
      continue
    fi
    if ! printf '%s\n' "$out" | grep -qE '^=== [0-9]+ PASS / [0-9]+ FAIL ===$'; then
      echo "  ❌ $m 自证缺机器摘要行（=== N PASS / M FAIL ===）"
      bad=$((bad + 1))
      continue
    fi
    echo "  ✅ $m  $(printf '%s\n' "$out" | tail -1)"
  done
  [ "$n" -ge 1 ] || { echo "  ❌ 一个平台模块自证都没发现 —— 零值守卫"; bad=$((bad + 1)); }
  return "$bad"
}

# ── 跨仓库可配置性自证（**没有硬编码**的可证伪证据）────────────────────────────
# 做法：搭一个**临时夹具仓库**，把三个名字全换掉（REFLECT_FACTS/REFLECT_DOC/DOCS），
#       三个闸门必须仍全绿；再用**默认名字**跑同一夹具 —— **必须红**
#       （否则说明这一节是恒真的空转，什么都没证明）。
configurable_selftest() {
  tmp=$(mktemp -d)
  # C4 对账③：夹具的改名集必须与 registry.FIXTURE_RENAMES 一致（唯一产地）——
  # 夹具用的每个改名名都必须在表里，表里的每项都必须在夹具里出现。
  fr=$(cd "$HERE" && python3 zreflect/registry.py --fixture-renames)
  fixture_facts=$(printf '%s\n' "$fr" | sed -n 's/^FACTS\.json=//p')
  fixture_doc=$(printf '%s\n' "$fr" | sed -n 's/^STATE\.md=//p')
  : "${fixture_facts:=LEDGER.json}" "${fixture_doc:=NOTES.md}"
  printf 'x = 1\n' > "$tmp/a.py"
  # 机器块标记要**先手工放一次**（工具自己的约定：找不到块 ≠ 块是对的）。
  # Phase 3 起文档有两个机器块（事实 + 闸门名录），标记都要先放。
  printf '# 标题\n\n正文引用 [[py_files]] 与 [[md_files]]（引用键，不手抄数字）。\n\n<!-- AUTO:FACTS -->\n<!-- /AUTO:FACTS -->\n\n<!-- AUTO:GATES -->\n<!-- /AUTO:GATES -->\n' > "$tmp/$fixture_doc"
  printf '# AGENTS\n' > "$tmp/AGENTS.md"
  printf '{"schema":1,"retractions":[]}\n' > "$tmp/RETRACT.json"        # 换名：REFLECT_RETRACTIONS
  mkdir -p "$tmp/cases"                                                  # 换名：REFLECT_QUESTIONS
  printf '# 例2\n\n**Status:** ready-for-agent\n\n**Settling:** `python3 a.py` —— rc=0 ⇒ A；rc=7 ⇒ B\n' > "$tmp/cases/02-y.md"
  # 换名：REFLECT_READMES —— 三语 trio 在夹具里也全部改名（互链判据按名单全员链接）
  for f in R1 R2 R3; do
    printf '# %s\n\n切换器：[R1.md](R1.md) [R2.md](R2.md) [R3.md](R3.md)\n' "$f" > "$tmp/$f.md"
  done
  # 生成台账并把机器块渲染进 **夹具文档名**（名字全换掉）
  # ① 先量一遍（新仓库的正确顺序：量测 → 渲染）
  GATE_REPO="$tmp" REFLECT_FACTS="$fixture_facts" REFLECT_DOC="$fixture_doc" \
    python3 "$HERE/zreflect/facts.py" >/dev/null 2>&1
  # ② 再把机器块渲染进夹具文档（名字全换掉）
  GATE_REPO="$tmp" REFLECT_FACTS="$fixture_facts" REFLECT_DOC="$fixture_doc" \
    python3 "$HERE/zreflect/facts.py" --render-doc "$fixture_doc" >/dev/null 2>&1
  ok=0; n=0
  for rel in $(cd "$HERE" && python3 zreflect/registry.py --all-runnable); do
    g="$HERE/$rel"
    n=$((n + 1))
    if GATE_REPO="$tmp" REFLECT_FACTS="$fixture_facts" REFLECT_DOC="$fixture_doc" \
       REFLECT_DOCS="$fixture_doc,AGENTS.md" REFLECT_RETRACTIONS=RETRACT.json \
       REFLECT_QUESTIONS=cases REFLECT_READMES=R1.md,R2.md,R3.md \
       python3 "$g" >/dev/null 2>&1; then
      ok=$((ok + 1))
    else
      echo "  ❌ 换名字后 $g 红了（说明名字还被写死在代码里）"
    fi
  done
  [ "$n" -gt 0 ] || { echo "  ❌ 夹具里一个闸门都没跑到"; rm -rf "$tmp"; return 1; }
  # 反向：用**默认名字**跑同一夹具 ⇒ **每一个依赖改名输入的闸门都必须红**。
  # ⚠️ 这一段的判据第一版只数了个数（`red>0`）—— 分辨力不足：夹具当时没换
  #    retractions.json/questions 的名字，那两个闸门绿着却被算作"证明过了"
  #    （issue #1 ② 的原话）。随后改成手写名单 —— 也漂了：默认名下实际红的
  #    六道里名单只写了四道。现在红名单从 registry 的 name_dependent 声明
  #    派生（登记被两头拦：problems 要求真消费改名默认名，这里要求真红）。
  red_need=$(python3 "$HERE/zreflect/registry.py" --red-need)
  [ -n "$red_need" ] || { echo "  ❌ 红名单为空 —— 零值守卫：没有它这一节什么都没证明"; rm -rf "$tmp"; return 1; }
  red=""
  for rel in $(cd "$HERE" && python3 zreflect/registry.py --all-runnable); do
    b=$(basename "$rel")
    if ! GATE_REPO="$tmp" python3 "$HERE/$rel" >/dev/null 2>&1; then red="$red $b"; fi
  done
  for b in $red_need; do
    case " $red " in *" $b "*) ;; *) echo "  ❌ 默认名字下 $b **没有红** ⇒ 换名自证对它的名字什么都没证明"; red=""; break;; esac
  done
  rm -rf "$tmp"
  [ "$ok" = "$n" ] && [ -n "$red" ] || {
    echo "  ❌ 可配置性自证不成立（换名全绿=$ok/$n；默认名下没红的闸门=[$red_need]）"; return 1; }
  echo "  ✅ 五个名字全换（LEDGER.json/NOTES.md/RETRACT.json/cases/R1-R3.md）$ok/$n 全绿；默认名字下 [$red_need] 全红 ⇒ 没有硬编码"
  return 0
}


# —— 主流程（所有函数定义之后）——————————————————————————————
rc=0
if [ "${1:-}" = "--selftest" ]; then
  selftest || rc=1
else
  echo "闸门自证（发现式名录）："
  run_gates "$HERE" || rc=1
  echo "── 可拔插件与点名自证（名单从 registry 派生）──"
  plugin_selftest || rc=1
  echo "── 平台模块自证（gate / runner / knobs / registry / guard / ledger / render / facts）──"
  module_selftest || rc=1
  echo "── 跨仓库可配置性 ──"
  configurable_selftest || rc=1
fi
exit "$rc"
