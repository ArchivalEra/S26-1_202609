#!/usr/bin/env python3
"""把课堂转写提取成纯文本，并打印回查用的元信息。

转写文件是第三方服务导出的 UTF-8 HTML，扩展名却写成 `.doc`——直接按 Word 解析会出错，
所以统一走这个脚本：

    python3 .githooks/extract-transcript.py 20260923_09501115-原文.doc
    # 默认写到 /tmp/<原名>.txt，并打印行数、时间戳范围、说话人标签、手机号命中

需要原文片段时按打印出来的相对时间戳回查 .doc 原文（Read 那个 .txt 即可，不必再看 HTML）。
"""
import argparse
import html
import pathlib
import re
import sys


def to_text(raw: str) -> str:
    raw = re.sub(r'(?is)<(script|style).*?</\1>', '', raw)
    raw = re.sub(r'(?i)<br\s*/?>', '\n', raw)
    raw = re.sub(r'(?i)</(p|div|h1|h2|li)>', '\n', raw)
    raw = re.sub(r'(?s)<[^>]+>', '', raw)
    raw = html.unescape(raw)
    raw = re.sub(r'[ \t\u00a0]+', ' ', raw)
    return re.sub(r'\n{2,}', '\n', raw)


def main() -> int:
    parser = argparse.ArgumentParser(description='提取课堂转写为纯文本并打印元信息')
    parser.add_argument('source', help='转写文件（UTF-8 HTML，扩展名通常是 .doc）')
    parser.add_argument('--out', help='输出路径，默认 /tmp/<原名>.txt')
    args = parser.parse_args()

    src = pathlib.Path(args.source)
    text = to_text(src.read_text(encoding='utf-8'))
    out = pathlib.Path(args.out) if args.out else pathlib.Path('/tmp') / (src.stem + '.txt')
    out.write_text(text, encoding='utf-8')

    lines = [l for l in text.splitlines() if l.strip()]
    speakers = sorted({m.strip() for m in re.findall(r'讲话人\s*\d+', text)})
    stamp_meta = re.search(r'时间[:：]\s*([0-9年月日 :]+)', text)
    # 相对时间戳只在正文里找：跳过文件头的「主题/参会人」元信息段
    body_start = text.find(speakers[0]) if speakers else 0
    stamps = re.findall(r'\b\d{1,2}:\d{2}(?::\d{2})?\b', text[body_start:] if body_start > 0 else text)

    print(f'输出：{out}')
    print(f'大小：{src.stat().st_size} 字节 → 纯文本 {len(text)} 字符 / {len(lines)} 行')
    if stamp_meta:
        print(f'内页「时间:」{stamp_meta.group(1).strip()}（转写服务自己的时间，不是上课时间）')
    if stamps:
        print(f'相对时间戳：{stamps[0]} … {stamps[-1]}（共 {len(stamps)} 处）')
    print(f'说话人标签：{"、".join(speakers) if speakers else "无（连续文本）"}')
    phones = re.findall(r'(?<!\d)1[3-9]\d{9}(?!\d)', text)
    print(f'11 位手机号：{"、".join(phones) if phones else "无"}（有命中也不入库，见维护条例第 5 条）')
    print('回查原文：按上面时间戳到源文件里找；笔记里引用片段一律带相对时间。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
