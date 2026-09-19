#!/usr/bin/env bash
# ============================================================
#  数学动画构建入口：Octave 渲染帧 → ffmpeg 合成 mp4 / gif
#
#  用法：
#     ./build.sh                 # 全部动画
#     ./build.sh det2            # 只做 2x2 矩阵变换
#     SMOKE=1 ./build.sh det2    # 只出 4 帧，验证版面
#
#  磁盘约定（本机）：home 是 NVMe、/mnt/hdd 是机械盘。
#  帧序列与视频是「写量大、只顺序读写」的东西 → 放 HDD。
#  构建缓存、node_modules 这类随机 IO 密集的 → 留 home。
# ============================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${ANIM_OUT:-/mnt/hdd/工程数学动画}"
FPS=30
WHICH="${1:-all}"

mkdir -p "$OUT"

# Octave 出图需要图形上下文；无显示器时用 xvfb 提供虚拟 X
run_octave() {
  local script="$1"
  if [ -n "${DISPLAY:-}" ]; then
    ( cd "$HERE" && ANIM_OUT="$OUT" ${SMOKE:+ANIM_SMOKE=1} octave-cli --no-gui --quiet "$script" )
  else
    ( cd "$HERE" && ANIM_OUT="$OUT" ${SMOKE:+ANIM_SMOKE=1} \
        xvfb-run -a octave-cli --no-gui --quiet "$script" )
  fi
}

# 合成 mp4（H.264 + yuv420p，浏览器/播放器通吃）与 gif（调色板两遍法）
encode() {
  local name="$1" frames="$OUT/${1}_frames"
  local n; n=$(find "$frames" -name 'f*.png' | wc -l)
  [ "$n" -gt 0 ] || { echo "  没有帧，跳过 $name"; return; }
  echo "  合成 $name（$n 帧 @ ${FPS}fps = $(echo "scale=1; $n/$FPS" | bc)s）"
  ffmpeg -y -loglevel error -framerate "$FPS" -i "$frames/f%04d.png" \
    -c:v libx264 -pix_fmt yuv420p -crf 20 -movflags +faststart \
    "$OUT/$name.mp4"
  ffmpeg -y -loglevel error -framerate "$FPS" -i "$frames/f%04d.png" \
    -vf "fps=15,scale=760:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" \
    "$OUT/$name.gif"
  printf '    mp4 %s KB    gif %s KB\n' \
    "$(( $(stat -c%s "$OUT/$name.mp4") / 1024 ))" \
    "$(( $(stat -c%s "$OUT/$name.gif") / 1024 ))"
}

echo "输出目录：$OUT"
case "$WHICH" in
  det2|all)
    echo "── 2x2 矩阵变换 ──"
    run_octave det2_transform.m
    [ -n "${SMOKE:-}" ] || encode det2
    ;;
esac
echo "完成。"
