#!/usr/bin/env python3
"""Markdown 美观度与可读性检查。

检查项分两级：
- 错误：会导致渲染错误或结构混乱，例如标题层级跳跃、表格列数不一致、代码围栏
  或数学定界符不闭合、文件末尾缺少换行。
- 警告：影响阅读观感，例如行尾空格、标题或表格前后缺空行、围栏代码块未标语言、
  一行内联数学的 $ 不成对、超长行、连续空行。

用法：
    python3 .githooks/check-markdown.py                 # 检查工作区
    python3 .githooks/check-markdown.py --staged         # 只检查已暂存的 Markdown
    python3 .githooks/check-markdown.py --strict         # 警告也按失败处理
    python3 .githooks/check-markdown.py 文件或目录 ...   # 指定路径

默认范围：README.md、维护条例.md、课程/、模板/。knowledge/ 是历史兼容入口，
.zcode/ 是本地工具目录，默认不检查。
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel']).decode().strip())
DEFAULT_TARGETS = ('README.md', '维护条例.md', '课程', '模板')
FENCE_RE = re.compile(r'^(\s*)(`{3,}|~{3,})\s*(\S*)\s*$')
HEADING_RE = re.compile(r'^(#{1,6})\s+(.*?)\s*$')
SEPARATOR_CELL_RE = re.compile(r'^:?-{2,}:?$')
LONG_LINE_LIMIT = 200
# 这些标题在每个小节的“先抄后析”结构里本来就会重复，不算问题。
STRUCTURAL_HEADINGS = {'原书抄录', '解析'}


def strip_code_spans(text: str) -> str:
    """去掉行内代码，避免把 `$` 或 `|` 误当作数学或表格。"""
    return re.sub(r'`[^`]*`', '', text)


def effective_width(line: str) -> int:
    """估算渲染后的视觉宽度：内联数学与链接目标按渲染结果计，不计源字符数。

    行内 LaTeX 矩阵（如 `$\\begin{pmatrix}...\\end{pmatrix}$`）与长 URL 在源码里
    很长，渲染后并不占宽度，因此不计入行宽。
    """
    text = strip_code_spans(line)
    text = re.sub(r'\$[^$]*\$', 'M', text)
    text = re.sub(r'\]\([^)]*\)', '](L)', text)
    return len(text)


def split_cells(row: str) -> list[str]:
    body = row.strip()
    if body.startswith('|'):
        body = body[1:]
    if body.endswith('|'):
        body = body[:-1]
    return [cell.strip() for cell in body.split('|')]


def looks_like_table_row(line: str) -> bool:
    return '|' in strip_code_spans(line)


def is_separator_row(line: str) -> bool:
    cells = split_cells(line)
    return bool(cells) and all(SEPARATOR_CELL_RE.fullmatch(cell) for cell in cells)


class Checker:
    def __init__(self, text: str) -> None:
        self.lines = text.splitlines()
        self.issues: list[tuple[int, str, str]] = []
        self.headings: dict[tuple[int, str], int] = {}

    def error(self, line_no: int, message: str) -> None:
        self.issues.append((line_no, '错误', message))

    def warn(self, line_no: int, message: str) -> None:
        self.issues.append((line_no, '警告', message))

    def run(self) -> list[tuple[int, str, str]]:
        if self.lines and not self.lines[-1].strip() and self.lines[-1] == '':
            # splitlines 已去掉换行；这里检查文件是否以空行结尾
            pass
        h1 = 0
        prev_level = 0
        in_fence = False
        fence_char = ''
        fence_len = 0
        fence_lang = ''
        fence_line = 0
        display_open = False
        prev_kind = 'start'
        in_catalog = False
        i = 0
        while i < len(self.lines):
            line = self.lines[i]
            line_no = i + 1
            stripped = line.strip()

            # README 的自动目录由 hook 生成，长链接无法换行，整块跳过。
            if '<!-- AUTO-CATALOG:START -->' in line:
                in_catalog = True
                prev_kind = 'text'
                i += 1
                continue
            if in_catalog:
                if '<!-- AUTO-CATALOG:END -->' in line:
                    in_catalog = False
                    prev_kind = 'text'
                i += 1
                continue

            fence_match = FENCE_RE.match(line) if not display_open else None
            if not in_fence and fence_match:
                in_fence = True
                fence_char = fence_match.group(2)[0]
                fence_len = len(fence_match.group(2))
                fence_lang = fence_match.group(3)
                fence_line = line_no
                if not fence_lang:
                    self.warn(line_no, '围栏代码块未标注语言（建议 matlab / text / bash 等）')
                if prev_kind not in ('blank', 'start'):
                    self.warn(line_no, '代码围栏前缺少空行')
                prev_kind = 'fence'
                i += 1
                continue

            if in_fence:
                if len(line) - len(line.lstrip()) < 4 and line.lstrip().startswith(fence_char * fence_len):
                    in_fence = False
                    if prev_kind not in ('blank', 'start'):
                        pass
                    prev_kind = 'fence'
                else:
                    if line.rstrip() != line:
                        self.warn(line_no, '行尾有多余空格')
                i += 1
                continue

            if not stripped:
                if prev_kind == 'blank':
                    self.warn(line_no, '连续多个空行')
                prev_kind = 'blank'
                i += 1
                continue

            # 显示数学 $$...$$：只检查配对与闭合，不强制独立成行
            dollar_pairs = len(re.findall(r'(?<!\\)\$\$', strip_code_spans(line)))
            if dollar_pairs:
                for _ in range(dollar_pairs):
                    display_open = not display_open
                if line.rstrip() != line:
                    self.warn(line_no, '行尾有多余空格')
                prev_kind = 'math'
                i += 1
                continue

            if display_open:
                if line.rstrip() != line:
                    self.warn(line_no, '行尾有多余空格')
                prev_kind = 'math'
                i += 1
                continue

            # 标题
            heading = HEADING_RE.match(line)
            if heading:
                level = len(heading.group(1))
                title = heading.group(2)
                if level == 1:
                    h1 += 1
                if prev_level and level > prev_level + 1:
                    self.error(line_no, f'标题层级从 H{prev_level} 跳到 H{level}')
                if prev_kind not in ('blank', 'start'):
                    self.warn(line_no, '标题前缺少空行')
                key = (level, title)
                if key in self.headings and title not in STRUCTURAL_HEADINGS:
                    self.warn(line_no, f'标题重复（与第 {self.headings[key]} 行相同）')
                else:
                    self.headings.setdefault(key, line_no)
                prev_level = level
                prev_kind = 'heading'
                i += 1
                continue

            if prev_kind == 'heading':
                # 标题后建议空一行，但多数解析器仍能正确渲染，故只提示
                self.warn(line_no, '标题后缺少空行')

            # 表格块
            if looks_like_table_row(line) and i + 1 < len(self.lines) and is_separator_row(self.lines[i + 1]):
                if prev_kind not in ('blank', 'start'):
                    self.warn(line_no, '表格前缺少空行')
                block = 0
                header_cells = split_cells(line)
                while i + block < len(self.lines) and looks_like_table_row(self.lines[i + block]) and self.lines[i + block].strip():
                    row = self.lines[i + block]
                    row_no = i + block + 1
                    cells = split_cells(row)
                    if block == 1:
                        if not is_separator_row(row):
                            self.error(row_no, '表头下一行不是合法的分隔行')
                        elif len(cells) != len(header_cells):
                            self.error(row_no, f'分隔行列数 {len(cells)} 与表头 {len(header_cells)} 不一致')
                    elif len(cells) != len(header_cells):
                        self.error(row_no, f'表格行列数 {len(cells)} 与表头 {len(header_cells)} 不一致')
                    if row.rstrip() != row:
                        self.warn(row_no, '行尾有多余空格')
                    block += 1
                after = i + block
                if after < len(self.lines) and self.lines[after].strip():
                    self.warn(after + 1, '表格后缺少空行')
                i = after
                prev_kind = 'table'
                continue

            # 普通正文
            plain = strip_code_spans(line)
            if re.search(r'(?<!\\)\$', plain):
                count = len(re.findall(r'(?<!\\)\$', plain))
                if count % 2 == 1:
                    self.warn(line_no, f'内联数学 $ 数量为奇数（{count} 个），可能未闭合')
            if line.rstrip() != line:
                self.warn(line_no, '行尾有多余空格')
            if '\t' in line:
                self.warn(line_no, '正文含制表符，建议用空格')
            width = effective_width(line)
            if width > LONG_LINE_LIMIT:
                self.warn(line_no, f'渲染宽度约 {width} 超过 {LONG_LINE_LIMIT}（已扣除内联数学与链接），建议换行')
            prev_kind = 'text'
            i += 1

        if in_fence:
            self.error(fence_line, f'代码围栏未闭合（起始于第 {fence_line} 行）')
        if display_open:
            self.error(len(self.lines), '显示数学 $$ 未闭合')
        if h1 == 0:
            self.error(1, '缺少一级标题')
        elif h1 > 1:
            self.error(1, f'一级标题出现 {h1} 次，应只有一个')
        return self.issues


def staged_paths() -> list[Path]:
    out = subprocess.check_output(
        ['git', 'diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).decode()
    return [ROOT / p for p in out.split('\0') if p.endswith('.md')]


def collect(paths: list[str]) -> list[Path]:
    files: list[Path] = []
    for raw in paths:
        path = (ROOT / raw).resolve()
        if path.is_file() and path.suffix == '.md':
            files.append(path)
        elif path.is_dir():
            files.extend(sorted(p for p in path.rglob('*.md') if '.git' not in p.parts and '.zcode' not in p.parts))
    seen: set[Path] = set()
    unique: list[Path] = []
    for path in files:
        if path not in seen:
            seen.add(path)
            unique.append(path)
    return unique


def read_file(path: Path, staged: bool) -> str:
    if staged:
        rel = path.relative_to(ROOT).as_posix()
        return subprocess.check_output(['git', 'show', f':{rel}']).decode()
    return path.read_text(encoding='utf-8')


def main() -> int:
    parser = argparse.ArgumentParser(description='Markdown 美观度与可读性检查')
    parser.add_argument('paths', nargs='*', help='要检查的文件或目录，默认 README.md、维护条例.md、课程/、模板/')
    parser.add_argument('--staged', action='store_true', help='只检查已暂存的 Markdown（从索引读取内容）')
    parser.add_argument('--strict', action='store_true', help='警告也按失败处理')
    args = parser.parse_args()

    if args.staged:
        files = staged_paths()
    else:
        files = collect(args.paths or list(DEFAULT_TARGETS))

    errors = warnings = 0
    bad_files = 0
    for path in files:
        text = read_file(path, args.staged)
        issues = Checker(text).run()
        if text and not text.endswith('\n'):
            issues.append((len(text.splitlines()), '错误', '文件末尾缺少换行'))
        if issues:
            bad_files += 1
            rel = path.relative_to(ROOT).as_posix()
            print(rel)
            for line_no, severity, message in sorted(issues):
                print(f'  {line_no}: [{severity}] {message}')
                if severity == '错误':
                    errors += 1
                else:
                    warnings += 1
    print(f'已检查 {len(files)} 个 Markdown 文件：{bad_files} 个有提示，'
          f'{errors} 个错误，{warnings} 个警告。')
    if errors or (args.strict and warnings):
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
