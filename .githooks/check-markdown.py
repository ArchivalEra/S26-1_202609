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

默认范围：README.md、课程总览/、模板/、站点/、.agents/。knowledge/ 是历史兼容入口，
.kimi-code/ 是本地工具目录，默认不检查。
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel']).decode().strip())
DEFAULT_TARGETS = ('README.md', '课程总览', '模板', '站点', '.agents')
FENCE_RE = re.compile(r'^(\s*)(`{3,}|~{3,})\s*(\S*)\s*$')
FENCE_ANY_RE = re.compile(r'^\s*(`{3,}|~{3,})')
HEADING_RE = re.compile(r'^(#{1,6})\s+(.*?)\s*$')
SEPARATOR_CELL_RE = re.compile(r'^:?-{2,}:?$')
LONG_LINE_LIMIT = 200
# 这些标题在每个小节的“先抄后析”结构里本来就会重复，不算问题。
STRUCTURAL_HEADINGS = {'原书抄录', '解析'}

CJK_RE = re.compile(r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]')
# 把中文包进这些命令后，数学模式里出现中文才是合法的。
TEXT_WRAP_RE = re.compile(r'\\(?:text|textrm|textit|textbf|mathrm|mathbf|operatorname|mbox)\s*\{[^{}]*\}')
DISPLAY_MATH_RE = re.compile(r'\$\$(.+?)\$\$', re.S)
INLINE_MATH_RE = re.compile(r'(?<!\$)\$(?!\$)((?:[^$\\]|\\.)+?)\$(?!\$)')

# ── 折叠面板标题必须**裸词**（2026-10-10 用户定案）────────────────────────────
# 收起状态只显示 `<summary>` 里的标题，标题行一旦写了内容，学生**不用点开**
# 就看到了提示/解答——「先自己动笔」的前提被破坏。所以标题行只许是标签本身
# （可带 `{#锚点}` 与 `:+`/`:-` 装饰），标签后不得跟任何描述文字。
# 检测范围限定在 `:::collapse` 块内的顶格列表项，避免误伤正文里「提示：…」的句子。
COLLAPSE_OPEN_RE = re.compile(r'^[\t ]{0,3}:{3,}[\t ]*collapse(?:[\t ]+(.*?))?[\t ]*$', re.I)
COLLAPSE_CLOSE_RE = re.compile(r'^[\t ]{0,3}:{3,}[\t ]*$')
PANEL_ITEM_RE = re.compile(r'^[-*+][\t ]+(.*)$')
PANEL_LABELS = ('完整解答', '解答', '答案', '提示', '复盘')
PANEL_DECOR_RE = re.compile(r'[\t ]*(?:[：:][+-]|\{#[A-Za-z_][A-Za-z0-9_-]*\})[\t ]*$')


def masked_for_math(lines: list[str]) -> str:
    """屏蔽围栏代码块与行内代码（保留行数），只留下可能含数学的正文。"""
    masked: list[str] = []
    in_fence = False
    fence_char = ''
    fence_len = 0
    for line in lines:
        if in_fence:
            if len(line) - len(line.lstrip()) < 4 and line.lstrip().startswith(fence_char * fence_len):
                in_fence = False
            masked.append('')
            continue
        fence = FENCE_ANY_RE.match(line)
        if fence:
            in_fence = True
            fence_char = fence.group(1)[0]
            fence_len = len(fence.group(1))
            masked.append('')
            continue
        masked.append(strip_code_spans(line))
    return '\n'.join(masked)


def math_cjk_issues(lines: list[str]) -> list[tuple[int, str]]:
    """找出数学模式里未用 \\text{} 之类包裹的中文。

    KaTeX 在数学模式遇到非 ASCII 会直接报错，而这类写法肉眼很难发现，
    所以单独扫一遍：先取 $$...$$ 与 $...$ 的公式体，去掉 \\text{} 包裹后再找中文。
    """
    text = masked_for_math(lines)
    spans: list[tuple[int, str]] = []
    for match in DISPLAY_MATH_RE.finditer(text):
        spans.append((match.start(), match.group(1)))
    without_display = DISPLAY_MATH_RE.sub(lambda m: ' ' * (m.end() - m.start()), text)
    for match in INLINE_MATH_RE.finditer(without_display):
        spans.append((match.start(), match.group(1)))

    issues: list[tuple[int, str]] = []
    reported: set[int] = set()
    for position, segment in sorted(spans):
        hit = CJK_RE.search(TEXT_WRAP_RE.sub('', segment))
        if not hit:
            continue
        line_no = text.count('\n', 0, position) + 1
        if line_no in reported:
            continue
        reported.add(line_no)
        issues.append((
            line_no,
            (
                f'数学模式内出现未包裹的中文「{hit.group()}」，'
                f'KaTeX 会解析失败，请用 \\text{{}} 包裹'
            ),
        ))
    return issues


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
    # GFM 表格里用 \| 表示字面竖线，不能当列分隔符。
    parts = re.split(r'(?<!\\)\|', body)
    return [cell.strip().replace('\\|', '|') for cell in parts]


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

    def _check_panel_item(self, line_no: int, line: str) -> None:
        item = PANEL_ITEM_RE.match(line)
        if not item:
            return
        title = item.group(1).strip()
        # 循环剥掉行尾装饰（:+ / :- / {#id}），二者顺序任意
        while True:
            stripped_title = PANEL_DECOR_RE.sub('', title).strip()
            if stripped_title == title:
                break
            title = stripped_title
        for label in PANEL_LABELS:
            if title == label:
                return
            if title.startswith(label):
                rest = title[len(label):].strip()
                # 「提示 1」「提示 2」这类**纯序号**后缀不算内容泄露
                # （学生看到序号得不到任何信息，而多提示题需要编号区分）。
                if re.fullmatch(r'[0-9]+', rest):
                    return
                self.error(
                    line_no,
                    f'折叠面板标题必须裸词：`{title[:40]}` —— 标签「{label}」后'
                    f'不得跟描述文字（收起状态会直接显示，学生不用点开就看到内容）。'
                    f'把「{rest[:20]}」移到标题的下一行、作为面板正文'
                )
                return

    def _update_panel_state(self, line_no: int, line: str, in_panel: bool) -> bool:
        if COLLAPSE_OPEN_RE.match(line):
            return True
        if in_panel and COLLAPSE_CLOSE_RE.match(line):
            return False
        if in_panel:
            self._check_panel_item(line_no, line)
        return in_panel

    def _check_table_block(self, idx: int) -> int:
        block = 0
        header_cells = split_cells(self.lines[idx])
        while idx + block < len(self.lines) and looks_like_table_row(self.lines[idx + block]) and self.lines[idx + block].strip():
            row = self.lines[idx + block]
            row_no = idx + block + 1
            cells = split_cells(row)
            self._check_table_row(row_no, block, cells, header_cells, row)
            block += 1
        after = idx + block
        if after < len(self.lines) and self.lines[after].strip():
            self.warn(after + 1, '表格后缺少空行')
        return after

    def _check_table_row(
        self,
        row_no: int,
        block: int,
        cells: list[str],
        header_cells: list[str],
        row: str,
    ) -> None:
        if block == 1:
            if not is_separator_row(row):
                self.error(row_no, '表头下一行不是合法的分隔行')
            elif len(cells) != len(header_cells):
                self.error(row_no, f'分隔行列数 {len(cells)} 与表头 {len(header_cells)} 不一致')
        elif len(cells) != len(header_cells):
            self.error(row_no, f'表格行列数 {len(cells)} 与表头 {len(header_cells)} 不一致')
        if row.rstrip() != row:
            self.warn(row_no, '行尾有多余空格')

    def _check_prose_line(self, line_no: int, line: str) -> None:
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

    def _check_heading_line(
        self,
        line_no: int,
        heading: re.Match[str],
        h1: int,
        prev_level: int,
        prev_kind: str,
    ) -> tuple[int, int]:
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
        return h1, level

    def _finish_checks(self, in_fence: bool, fence_line: int, display_open: bool, h1: int) -> None:
        if in_fence:
            self.error(fence_line, f'代码围栏未闭合（起始于第 {fence_line} 行）')
        if display_open:
            self.error(len(self.lines), '显示数学 $$ 未闭合')
        if h1 == 0:
            self.error(1, '缺少一级标题')
        elif h1 > 1:
            self.error(1, f'一级标题出现 {h1} 次，应只有一个')
        for line_no, message in math_cjk_issues(self.lines):
            self.warn(line_no, message)

    def _open_fence(
        self,
        line_no: int,
        line: str,
        fence_match: re.Match[str],
        state: dict[str, object],
    ) -> None:
        state['in_fence'] = True
        state['fence_char'] = fence_match.group(2)[0]
        state['fence_len'] = len(fence_match.group(2))
        state['fence_line'] = line_no
        if not fence_match.group(3):
            self.warn(line_no, '围栏代码块未标注语言（建议 matlab / text / bash 等）')
        if state['prev_kind'] not in ('blank', 'start') and len(line) == len(line.lstrip()):
            self.warn(line_no, '代码围栏前缺少空行')
        state['prev_kind'] = 'fence'

    def _step_fence_or_blank(
        self,
        line_no: int,
        line: str,
        state: dict[str, object],
    ) -> bool:
        fence_match = FENCE_RE.match(line) if not state['display_open'] else None
        if not state['in_fence'] and fence_match:
            self._open_fence(line_no, line, fence_match, state)
            return True
        if state['in_fence']:
            closer = str(state['fence_char']) * int(state['fence_len'])
            if len(line) - len(line.lstrip()) < 4 and line.lstrip().startswith(closer):
                state['in_fence'] = False
                state['prev_kind'] = 'fence'
            elif line.rstrip() != line:
                self.warn(line_no, '行尾有多余空格')
            return True
        if not line.strip():
            if state['prev_kind'] == 'blank':
                self.warn(line_no, '连续多个空行')
            state['prev_kind'] = 'blank'
            return True
        return False

    def _step_math(self, line_no: int, line: str, state: dict[str, object]) -> bool:
        dollar_pairs = len(re.findall(r'(?<!\\)\$\$', strip_code_spans(line)))
        if dollar_pairs:
            if dollar_pairs % 2 == 1:
                state['display_open'] = not state['display_open']
            if line.rstrip() != line:
                self.warn(line_no, '行尾有多余空格')
            state['prev_kind'] = 'math'
            return True
        if state['display_open']:
            if line.rstrip() != line:
                self.warn(line_no, '行尾有多余空格')
            state['prev_kind'] = 'math'
            return True
        return False

    def _step_body_line(
        self,
        i: int,
        line_no: int,
        line: str,
        state: dict[str, object],
    ) -> int:
        heading = HEADING_RE.match(line)
        if heading:
            h1, prev_level = self._check_heading_line(
                line_no, heading, int(state['h1']), int(state['prev_level']), str(state['prev_kind']))
            state['h1'], state['prev_level'], state['prev_kind'] = h1, prev_level, 'heading'
            return i + 1
        if state['prev_kind'] == 'heading':
            self.warn(line_no, '标题后缺少空行')
        if looks_like_table_row(line) and i + 1 < len(self.lines) and is_separator_row(self.lines[i + 1]):
            if state['prev_kind'] not in ('blank', 'start'):
                self.warn(line_no, '表格前缺少空行')
            state['prev_kind'] = 'table'
            return self._check_table_block(i)
        self._check_prose_line(line_no, line)
        state['prev_kind'] = 'text'
        return i + 1

    def run(self) -> list[tuple[int, str, str]]:
        state: dict[str, object] = {
            'h1': 0,
            'prev_level': 0,
            'in_fence': False,
            'fence_char': '',
            'fence_len': 0,
            'fence_line': 0,
            'display_open': False,
            'prev_kind': 'start',
            'in_catalog': False,
            'in_panel': False,
        }
        i = 0
        while i < len(self.lines):
            line = self.lines[i]
            line_no = i + 1
            if '<!-- AUTO-CATALOG:START -->' in line or state['in_catalog']:
                state['in_catalog'] = '<!-- AUTO-CATALOG:END -->' not in line
                state['prev_kind'] = 'text'
                i += 1
                continue
            if not state['in_fence'] and not state['display_open']:
                state['in_panel'] = self._update_panel_state(line_no, line, bool(state['in_panel']))
            if self._step_fence_or_blank(line_no, line, state) or self._step_math(line_no, line, state):
                i += 1
                continue
            i = self._step_body_line(i, line_no, line, state)
        self._finish_checks(
            bool(state['in_fence']), int(state['fence_line']),
            bool(state['display_open']), int(state['h1']))
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
            skip = {'.git', '.kimi-code', 'node_modules', 'dist', '.venv', '__pycache__'}
            files.extend(sorted(p for p in path.rglob('*.md') if not (skip & set(p.parts))))
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
    parser.add_argument('paths', nargs='*', help='要检查的文件或目录，默认 README.md、课程总览/、模板/')
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
            rel = path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else str(path)
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
