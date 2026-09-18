#!/usr/bin/env python3
"""为教材照片生成统一的「阅读副本」，让 Read 工具能正常看图。

背景（实测结论）：Read 只把 PNG / JPG / GIF 当作图像解码，走图像通道，
此时**文件大小不影响可读性**；HEIC/HEIF、AVIF、WebP 是格式不被支持，
TIFF/BMP/PDF 等则不被识别为图像、跌进 256KB 的文本读取上限。

因此本工具把源图**无损、全分辨率**解码为 PNG（仅做 EXIF 方向校正，
不缩放、不降质、不裁剪），输出到临时目录供子代理阅读。
**不修改、不替换、不移动源文件**；阅读副本一律不入库。

用法：
    python3 .githooks/prepare-photos.py 源文件或目录... [--out DIR] [--force]

约定：
    --out 默认 /tmp/reading-copies；已存在且比源文件新的副本默认跳过。
"""
import argparse
import shutil
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True

READABLE_SUFFIXES = {'.png', '.jpg', '.jpeg', '.gif'}
CONVERT_SUFFIXES = {'.heic', '.heif', '.avif', '.webp', '.tif', '.tiff', '.bmp',
                    '.jp2', '.ppm', '.pcx', '.tga', '.dds', '.qoi', '.psd', '.pdf'}
DEFAULT_OUT = Path('/tmp/reading-copies')


def collect(inputs):
    """把命令行参数展开成待处理的图片文件列表，保持稳定顺序。"""
    files = []
    for raw in inputs:
        path = Path(raw)
        if path.is_dir():
            files.extend(sorted(p for p in path.iterdir()
                                if p.is_file() and p.suffix.lower() in READABLE_SUFFIXES | CONVERT_SUFFIXES))
        elif path.is_file():
            files.append(path)
        else:
            raise SystemExit(f'找不到输入：{raw}')
    if not files:
        raise SystemExit('没有可处理的图片（只处理常见图片扩展名）。')
    return files


def needs_conversion(path):
    return path.suffix.lower() not in READABLE_SUFFIXES


def convert(src, dst):
    """无损解码为全分辨率 PNG，只做方向校正。"""
    if shutil.which('magick') is None:
        raise SystemExit('缺少 ImageMagick（magick 命令），无法转换。')
    subprocess.run(['magick', str(src), '-auto-orient', str(dst)], check=True)


def copy_through(src, dst):
    """源图已是可读格式：原样复制，不做任何重新编码。"""
    shutil.copyfile(src, dst)


def dimensions(path):
    result = subprocess.run(['magick', 'identify', '-format', '%wx%h', str(path)],
                            check=True, capture_output=True, text=True)
    return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser(description='生成教材照片的 PNG 阅读副本（源文件不动）。')
    parser.add_argument('inputs', nargs='+', help='源图片或目录')
    parser.add_argument('--out', default=str(DEFAULT_OUT), help=f'输出目录（默认 {DEFAULT_OUT}）')
    parser.add_argument('--force', action='store_true', help='即使副本已存在也重新生成')
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    files = collect(args.inputs)
    converted = copied = skipped = 0
    print(f'输出目录：{out_dir}')
    for src in files:
        convert_it = needs_conversion(src)
        # 已是可读格式的保留原后缀（内容与名称一致）；需解码的统一输出 .png
        dst = out_dir / (src.stem + '.png' if convert_it else src.name)
        if dst.exists() and not args.force and dst.stat().st_mtime >= src.stat().st_mtime:
            print(f'  跳过  {src.name}  → 已有 {dst.name}')
            skipped += 1
            continue
        if convert_it:
            convert(src, dst)
            converted += 1
        else:
            copy_through(src, dst)
            copied += 1
        print(f'  {"解码" if convert_it else "复制"}  {src.name}  →  {dst.name}  '
              f'({dst.stat().st_size / 1024 / 1024:.1f} MB, {dimensions(dst)})')

    print(f'\n完成：解码 {converted} 张，原样复制 {copied} 张，跳过 {skipped} 张。')
    print('提醒：阅读副本只供 Read/子代理查看，源图保持字节不变，副本不要入库。')


if __name__ == '__main__':
    main()
