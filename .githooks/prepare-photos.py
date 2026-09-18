#!/usr/bin/env python3
"""为教材照片生成统一的「阅读副本」，让 Read 工具能正常看图。

背景（实测结论）：Read 只把 PNG / JPG / GIF 当作图像解码，走图像通道，
此时**文件大小不影响可读性**；HEIC/HEIF、AVIF、WebP 格式不被支持，
TIFF/BMP/PDF 等不被识别为图像，跌进 256KB 的文本读取上限。

预处理做三件事，源图一律不动：
1. **统一竖屏**：拍摄一律竖持，但手机陀螺仪会把竖拍存成横版。这里按需旋转
   90°，使副本高 > 宽，省去读图者自己判断方向。
2. **无损解码**：HEIC 等解码为全分辨率 PNG，不缩放、不降质、不裁剪。
3. **ASCII 文件名**：中文名会让子代理读不出图（实测误报「分辨率不足」），
   非 ASCII 名统一改为 `photo-<序号>` 并在末尾打印对照表。

读不出的补救办法是 `--rotate 180`（比让用户重拍便宜）；仍不行才报页码重拍。

用法：
    python3 .githooks/prepare-photos.py 源文件或目录... [--out DIR]
                                                 [--rotate DEG] [--no-portrait] [--force]

约定：
    --out 默认 /tmp/reading-copies；副本比源文件新则跳过（加 --force 强制重建）。
"""
import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True

READABLE_SUFFIXES = {'.png', '.jpg', '.jpeg', '.gif'}
CONVERT_SUFFIXES = {'.heic', '.heif', '.avif', '.webp', '.tif', '.tiff', '.bmp',
                    '.jp2', '.ppm', '.pcx', '.tga', '.dds', '.qoi', '.psd', '.pdf'}
ALL_SUFFIXES = READABLE_SUFFIXES | CONVERT_SUFFIXES
DEFAULT_OUT = Path('/tmp/reading-copies')
ASCII_SAFE = re.compile(r'^[A-Za-z0-9._-]+$')


def run_identify(path, *pre_args):
    result = subprocess.run(['magick', 'identify', '-format', '%wx%h', *pre_args, str(path)],
                            check=True, capture_output=True, text=True)
    return tuple(int(v) for v in result.stdout.strip().split('x'))


def collect(inputs):
    """把命令行参数展开成待处理的图片文件列表，保持稳定顺序。"""
    files = []
    for raw in inputs:
        path = Path(raw)
        if path.is_dir():
            files.extend(sorted(p for p in path.iterdir()
                                if p.is_file() and p.suffix.lower() in ALL_SUFFIXES))
        elif path.is_file():
            files.append(path)
        else:
            raise SystemExit(f'找不到输入：{raw}')
    if not files:
        raise SystemExit('没有可处理的图片（只处理常见图片扩展名）。')
    return files


def plan_ops(src, portrait, rotate):
    """决定要施加的旋转：-auto-orient → 统一竖屏 → 额外旋转。返回 (操作列表, 说明)。"""
    if shutil.which('magick') is None:
        raise SystemExit('缺少 ImageMagick（magick 命令），无法转换。')

    ops = ['-auto-orient']
    notes = []

    width, height = run_identify(src, '-auto-orient')
    if portrait and width > height:
        # 竖持拍摄却被陀螺仪存成横版：顺时针转 90° 立起来。
        ops.append('-rotate')
        ops.append('90')
        notes.append('竖屏校正')
    if rotate:
        ops.append('-rotate')
        ops.append(str(rotate))
        notes.append(f'旋转 {rotate}°')

    return ops, notes


def output_name(src, index, used):
    """ASCII 名原样保留（后缀随内容统一为 .png 或保持可读格式）；否则改为 photo-<序号>。"""
    stem = src.stem
    if not ASCII_SAFE.match(src.name):
        stem = f'photo-{index:02d}'
    suffix = '.png' if src.suffix.lower() not in READABLE_SUFFIXES else src.suffix.lower()
    name = stem + suffix
    counter = 1
    while name in used:
        counter += 1
        name = f'{stem}-{counter}{suffix}'
    used.add(name)
    return name


def main():
    parser = argparse.ArgumentParser(description='生成教材照片的阅读副本（源文件不动）。')
    parser.add_argument('inputs', nargs='+', help='源图片或目录')
    parser.add_argument('--out', default=str(DEFAULT_OUT), help=f'输出目录（默认 {DEFAULT_OUT}）')
    parser.add_argument('--rotate', type=int, default=0, choices=[0, 90, 180, 270],
                        help='额外旋转角度，用于读不出时转 180° 重试')
    parser.add_argument('--no-portrait', action='store_true', help='不做竖屏校正')
    parser.add_argument('--force', action='store_true', help='即使副本已存在也重新生成')
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    files = collect(args.inputs)
    portrait = not args.no_portrait
    used_names = set()
    mapping = []
    converted = copied = skipped = 0

    print(f'输出目录：{out_dir}'
          f'（竖屏校正：{"开" if portrait else "关"}'
          f'，额外旋转：{args.rotate}°）')
    for index, src in enumerate(files, start=1):
        dst = out_dir / output_name(src, index, used_names)
        if dst.exists() and not args.force and dst.stat().st_mtime >= src.stat().st_mtime:
            print(f'  跳过  {src.name}  →  {dst.name}')
            skipped += 1
            mapping.append((dst.name, src.name, '跳过'))
            continue

        ops, notes = plan_ops(src, portrait, args.rotate)
        subprocess.run(['magick', str(src), *ops, str(dst)], check=True)
        if dst.suffix.lower() in READABLE_SUFFIXES and src.suffix.lower() in READABLE_SUFFIXES \
                and not ops[1:]:
            copied += 1
        else:
            converted += 1
        width, height = run_identify(dst)
        note = '、'.join(notes) if notes else '无'
        print(f'  {src.name}  →  {dst.name}  ({width}x{height} 竖版'
              f'{"是" if height >= width else "否"}, {dst.stat().st_size / 1024 / 1024:.1f} MB, {note})')
        mapping.append((dst.name, src.name, note))

    print(f'\n完成：{converted} 张解码/处理，{copied} 张原样复制，{skipped} 张跳过。')
    print('文件名对照（阅读副本 → 源文件）：')
    for dst_name, src_name, note in mapping:
        print(f'  {dst_name}  ←  {src_name}  [{note}]')
    print('提醒：副本只供 Read/子代理查看，源图保持字节不变，副本不入库。'
          '若有页读不出，用 --rotate 180 重建后再读。')


if __name__ == '__main__':
    main()
