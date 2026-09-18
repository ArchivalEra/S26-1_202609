#!/usr/bin/env python3
"""把一张阅读副本转 180°，供子代理在「图能看清但明确是倒立」时自行纠正。

给读图的子代理用：只允许在**能看清内容、但版面明显倒立**时调用，
转完再读一次即可（这不算重复读——第一次读的是方向错的副本）。
内容看不清时不要用这个：那属于「看不清」，应当停下并报告。

用法：
    python3 .githooks/flip-photo.py /tmp/reading/p38.png            # 原地转 180°
    python3 .githooks/flip-photo.py /tmp/reading/p38.png --out /tmp/reading/p38-flip.png

只写输出文件，不动源图。默认就地覆盖输入副本（副本本身是可丢弃的临时文件）。
"""
import argparse
import shutil
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True


def main():
    parser = argparse.ArgumentParser(description='把阅读副本转 180°（供子代理纠正倒立方向）。')
    parser.add_argument('image', help='要旋转的图片（阅读副本）')
    parser.add_argument('--out', help='输出路径，默认就地覆盖')
    parser.add_argument('--degrees', type=int, default=180, choices=[90, 180, 270],
                        help='旋转角度，默认 180')
    args = parser.parse_args()

    src = Path(args.image)
    if not src.is_file():
        raise SystemExit(f'找不到文件：{src}')
    if shutil.which('magick') is None:
        raise SystemExit('缺少 ImageMagick（magick 命令）。')

    dst = Path(args.out) if args.out else src
    before = subprocess.run(['magick', 'identify', '-format', '%wx%h', str(src)],
                            check=True, capture_output=True, text=True).stdout.strip()
    subprocess.run(['magick', str(src), '-rotate', str(args.degrees), str(dst)], check=True)
    after = subprocess.run(['magick', 'identify', '-format', '%wx%h', str(dst)],
                           check=True, capture_output=True, text=True).stdout.strip()
    print(f'已旋转 {args.degrees}°：{src.name} ({before}) → {dst.name} ({after})。'
          '请重新 Read 该文件。')


if __name__ == '__main__':
    main()
