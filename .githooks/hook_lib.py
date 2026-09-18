#!/usr/bin/env python3
"""Shared snapshot validation for the semester repository.

每次提交时从暂存内容重新生成两处自动区块：
- README.md 的 AUTO-CATALOG：课程目录。
- 维护细则.md 的 AUTO-MAINTENANCE：仓库状态、解析进度与验证基线。

推送前校验待推送提交里的两处区块都已同步。
"""
import datetime
import hashlib
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import subprocess
import sys
from urllib.parse import quote, unquote, urlsplit

START = '<!-- AUTO-CATALOG:START -->'
END = '<!-- AUTO-CATALOG:END -->'
MAINT_PATH = '维护细则.md'
MAINT_START = '<!-- AUTO-MAINTENANCE:START -->'
MAINT_END = '<!-- AUTO-MAINTENANCE:END -->'
KINDS = ('作业', '教材解析', '课堂笔记', '原始资料', '音频')
INDEX_LABEL = '五类索引'


def git(*args):
    return subprocess.check_output(['git', *args])


def snapshot(ref=None, worktree=False):
    if worktree:
        paths = git('ls-files', '--cached', '--others', '--exclude-standard', '-z')
        return {p.decode(): Path(p.decode()).read_bytes() for p in paths.split(b'\0')
                if p and Path(p.decode()).is_file()}
    if ref is None and git('ls-files', '--unmerged', '-z'):
        raise ValueError('请先解决合并冲突。')
    entries = git('ls-tree', '-r', '-z', ref) if ref else git('ls-files', '--stage', '-z')
    files = {}
    for entry in entries.split(b'\0'):
        if not entry:
            continue
        metadata, path = entry.split(b'\t', 1)
        fields = metadata.split()
        mode, oid = fields[0], fields[2] if ref else fields[1]
        if mode not in (b'100644', b'100755'):
            raise ValueError(f'资料库仅支持普通文件：{path.decode()}')
        files[path.decode()] = git('cat-file', 'blob', oid.decode())
    return files


def classify(path):
    parts = PurePosixPath(path).parts
    if len(parts) >= 4 and parts[0] == '课程' and parts[2] in KINDS and parts[-1] != 'index.md':
        return parts[1], parts[2]
    return None


def courses(files):
    return sorted({PurePosixPath(p).parts[1] for p in files
                   if p.startswith('课程/') and len(PurePosixPath(p).parts) == 3
                   and p.endswith('/index.md')})


def count_kind(files, course, kind):
    return sum(1 for p in files if classify(p) == (course, kind))


def render(readme, files):
    if readme.count(START) != 1 or readme.count(END) != 1 or readme.index(START) > readme.index(END):
        raise ValueError('README.md 必须包含唯一且顺序正确的 AUTO-CATALOG 起止标记。')
    before, rest = readme.split(START)
    _, after = rest.split(END)
    digest = hashlib.sha256()
    names = courses(files)
    lines = ['## 按课程浏览', '']
    total = 0
    for path, data in sorted(files.items()):
        if path != 'README.md':
            digest.update(path.encode() + b'\0' + hashlib.sha256(data).digest())
    for course in names:
        lines.extend([f'### [{course}](./{quote("课程/" + course + "/index.md")})', ''])
        for kind in KINDS:
            paths = sorted(p for p in files if classify(p) == (course, kind))
            total += len(paths)
            lines.extend([f'#### {kind}（{len(paths)} 份）', ''])
            for path in paths:
                title = PurePosixPath(path).name
                if path.endswith('.md'):
                    heading = re.search(r'^# (.+)$', files[path].decode(), re.M)
                    if heading:
                        title = heading.group(1)
                title = title.replace('[', '\\[').replace(']', '\\]')
                lines.append(f'- [{title}](./{quote(path)})')
            if not paths:
                lines.append('暂无已归档资料。')
            lines.append('')
    lines.extend([f'已登记 **{len(names)}** 门课程、**{total}** 份资料（不含索引、模板和历史入口）。', '',
                  f'<!-- 仓库内容摘要（不含 README）：{digest.hexdigest()} -->'])
    return before + START + '\n\n' + '\n'.join(lines) + '\n\n' + END + after


def whitelist_rules(files):
    rules = [line.strip() for line in files['.gitignore'].decode().splitlines()
             if line.strip() and not line.lstrip().startswith('#')]
    return rules


def render_maintenance(text, files):
    if text.count(MAINT_START) != 1 or text.count(MAINT_END) != 1 or text.index(MAINT_START) > text.index(MAINT_END):
        raise ValueError(f'{MAINT_PATH} 必须包含唯一且顺序正确的 AUTO-MAINTENANCE 起止标记。')
    before, rest = text.split(MAINT_START)
    _, after = rest.split(MAINT_END)
    names = courses(files)
    total = sum(1 for p in files if classify(p))
    rules = whitelist_rules(files)
    digest = hashlib.sha256()
    for path, data in sorted(files.items()):
        if path not in ('README.md', MAINT_PATH):
            digest.update(path.encode() + b'\0' + hashlib.sha256(data).digest())
    lines = ['## 仓库状态（自动生成）', '',
             '> 本区块由 `.githooks/hook_lib.py` 在**每次提交时从暂存内容重新生成**，推送前校验一致性；'
             '手工修改会在下次提交时被覆盖。要改内容请改这一节之外的正文。', '',
             f'- 课程 **{len(names)}** 门；正式资料 **{total}** 份（不含索引、模板和历史入口）。',
             f'- 精确白名单 **{len(rules) - 2}** 条逐文件路径（无通配符），仓库共 **{len(files)}** 个受管文件。',
             f'- 暂存内容摘要（不含本文件与 README）：`{digest.hexdigest()}`。任何正文改动都会改变这一行。',
             '']
    lines.extend(['### 课程分类一览', ''])
    header = '| 课程 | ' + ' | '.join(KINDS) + f' | {INDEX_LABEL} |'
    lines.extend([header, '| :--- | ' + ' | '.join(['---:'] * len(KINDS)) + ' | :--- |'])
    for course in names:
        cells = [str(count_kind(files, course, kind)) for kind in KINDS]
        missing = [kind for kind in KINDS if f'课程/{course}/{kind}/index.md' not in files]
        lines.append(f'| {course} | ' + ' | '.join(cells) + ' | ' + ('齐全' if not missing else '缺 ' + '、'.join(missing)) + ' |')
    lines.append('')
    lines.extend(['### 教材解析进度', ''])
    for course in names:
        paths = sorted(p for p in files if classify(p) == (course, '教材解析'))
        lines.append(f'**{course}**（{len(paths)} 个文件）')
        lines.append('')
        if not paths:
            lines.append('- 尚未建立章节解析。')
        for path in paths:
            heading = re.search(r'^# (.+)$', files[path].decode(), re.M)
            title = heading.group(1) if heading else PurePosixPath(path).name
            lines.append(f'- `{path}` — {title}')
        lines.append('')
    lines.extend(['### 原始资料构成', ''])
    exts = {}
    for course in names:
        counter = {}
        for path in files:
            if classify(path) == (course, '原始资料'):
                suffix = PurePosixPath(path).suffix.lower() or '（无扩展名）'
                counter[suffix] = counter.get(suffix, 0) + 1
        exts[course] = counter
    lines.extend(['| 课程 | ' + ' | '.join('`' + e + '`' for e in sorted({e for c in exts.values() for e in c})) + ' |',
                  '| :--- | ' + ' | '.join('---:' for _ in sorted({e for c in exts.values() for e in c})) + ' |'])
    for course in names:
        columns = sorted({e for c in exts.values() for e in c})
        lines.append(f'| {course} | ' + ' | '.join(str(exts[course].get(e, 0)) for e in columns) + ' |')
    lines.append('')
    lines.extend(['### 待补提示（自动列出，非错误）', ''])
    hints = []
    for course in names:
        for kind in ('作业', '音频'):
            if count_kind(files, course, kind) == 0:
                hints.append(f'- {course}：{kind}目录尚无记录，待正式通知或链接，登记前不得编造。')
    if hints:
        lines.extend(hints)
    else:
        lines.append('- 各课程五类资料均已有记录。')
    lines.append('')
    lines.extend(['### 验证基线', '',
                  '- `python3 .githooks/update-readme.py --worktree`：同步 README 与维护细则自动区块。',
                  '- `python3 .githooks/test-update-readme.py`：目录、白名单、命名、索引与移动的集成测试。',
                  '- `python3 .githooks/check-markdown.py`：Markdown 美观度与可读性检查，错误项必须为 0。',
                  '- `git fsck --no-progress`：仓库对象完整性，不应有输出。',
                  '- 推送由 `.githooks/pre-push` 校验待推送提交的两处自动区块。'])
    return before + MAINT_START + '\n\n' + '\n'.join(lines) + '\n\n' + MAINT_END + after


def links(path, data):
    text = re.sub(r'```.*?```', '', data.decode(), flags=re.S)
    found = set()
    for target in re.findall(r'\[[^\]\n]*\]\(([^\s)]+)(?:\s+[^)]*)?\)', text):
        target = target.strip('<>')
        parsed = urlsplit(target)
        if parsed.scheme or target.startswith('#') or not parsed.path:
            continue
        found.add(posixpath.normpath(posixpath.join(posixpath.dirname(path), unquote(parsed.path))))
    return found


def validate(files):
    if '.gitignore' not in files:
        raise ValueError('缺少精确白名单 .gitignore。')
    rules = whitelist_rules(files)
    if rules[:2] != ['*', '!*/']:
        raise ValueError('白名单必须先使用 * 和 !*/，再列出精确文件路径。')
    allowed = set()
    for rule in rules[2:]:
        path = rule[2:]
        if not rule.startswith('!/') or not path or any(c in path for c in '*?[]\\') or path.endswith('/') or posixpath.normpath(path) != path or path.startswith('/') or '..' in PurePosixPath(path).parts:
            raise ValueError(f'非法精确白名单：{rule}')
        allowed.add(path)
    missing = set(files) - allowed
    if missing:
        raise ValueError('文件未列入精确白名单：' + ', '.join(sorted(missing)))
    for path in files:
        category = classify(path)
        if not category:
            continue
        course, kind = category
        name = PurePosixPath(path).name
        if kind != '原始资料':
            if kind == '教材解析':
                if not re.fullmatch(r'第\d{2,}章-.+\.md', name):
                    raise ValueError(f'教材解析须使用第01章-节号-名称.md：{path}')
            else:
                if not re.fullmatch(r'\d{4}-\d{2}-\d{2}-.+\.md', name):
                    raise ValueError(f'日期资料须使用 YYYY-MM-DD-名称.md：{path}')
                datetime.date.fromisoformat(name[:10])
        index = f'课程/{course}/{kind}/index.md'
        if index not in files or path not in links(index, files[index]):
            raise ValueError(f'资料未登记到分类索引 {index}：{path}')
    for path, data in files.items():
        if not path.endswith('.md') or path.startswith('模板/'):
            continue
        for target in links(path, data):
            if target not in files and not any(p.startswith(target.rstrip('/') + '/') for p in files):
                raise ValueError(f'本地链接失效：{path} → {target}')
    names = {PurePosixPath(p).parts[1] for p in files if p.startswith('课程/') and len(PurePosixPath(p).parts) >= 3}
    for course in names:
        course_index = f'课程/{course}/index.md'
        if '课程/index.md' not in files or course_index not in links('课程/index.md', files['课程/index.md']):
            raise ValueError(f'课程未登记到课程总索引：{course}')
        if course_index not in files:
            raise ValueError(f'缺少课程入口：{course_index}')
        for kind in KINDS:
            index = f'课程/{course}/{kind}/index.md'
            if index not in files or index not in links(course_index, files[course_index]):
                raise ValueError(f'课程入口缺少分类链接：{index}')


def check_worktree_sync(files):
    """未加 --worktree 时，工作区的两处自动区块文件必须与暂存内容一致。"""
    for path in ('README.md', MAINT_PATH):
        if path not in files:
            raise ValueError(f'缺少 {path}。')
        if not Path(path).is_file() or Path(path).read_bytes() != files[path]:
            raise ValueError(f'{path} 有未暂存修改；请先暂存或保存这些修改。')


def sync(worktree=False):
    files = snapshot(worktree=worktree)
    if not worktree:
        check_worktree_sync(files)
    if MAINT_PATH not in files:
        raise ValueError(f'缺少 {MAINT_PATH}，无法生成自动状态区块。')
    # 维护细则的内容摘要不包含 README 与本文件，先算；README 的摘要包含维护细则，
    # 必须基于“已更新的维护细则”计算，否则推送时两处区块会互相判定为未同步。
    maintenance = render_maintenance(files[MAINT_PATH].decode(), files).encode()
    staged = dict(files)
    staged[MAINT_PATH] = maintenance
    staged['README.md'] = render(staged['README.md'].decode(), staged).encode()
    outputs = {'README.md': staged['README.md'], MAINT_PATH: maintenance}
    validate(staged)
    for path, data in outputs.items():
        if files[path] != data:
            Path(path).write_bytes(data)
            if not worktree:
                git('add', '--', path)
    print('README 课程目录、维护细则状态、白名单、命名与索引检查通过。')


def main():
    os.chdir(git('rev-parse', '--show-toplevel').decode().strip())
    if sys.argv[1:] == ['pre-push']:
        for line in sys.stdin:
            local_ref, oid, remote_ref, remote_oid = line.split()
            if set(oid) == {'0'}:
                continue
            files = snapshot(git('rev-parse', oid + '^{commit}').decode().strip())
            validate(files)
            if render(files['README.md'].decode(), files).encode() != files['README.md']:
                raise ValueError(f'待推送提交 README 自动目录未同步：{local_ref}')
            if MAINT_PATH not in files:
                raise ValueError(f'待推送提交缺少 {MAINT_PATH}：{local_ref}')
            if render_maintenance(files[MAINT_PATH].decode(), files).encode() != files[MAINT_PATH]:
                raise ValueError(f'待推送提交维护细则自动区块未同步：{local_ref}')
        print('待推送提交的目录、维护细则与资料检查通过。')
    elif sys.argv[1:] in ([], ['--worktree']):
        sync(worktree=bool(sys.argv[1:]))
    else:
        raise ValueError('用法：hook_lib.py [--worktree|pre-push]')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(f'检查失败：{error}', file=sys.stderr)
        sys.exit(1)
