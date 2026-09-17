#!/usr/bin/env python3
"""Shared snapshot validation for the semester repository."""
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
KINDS = ('作业', '教材解析', '课堂笔记', '原始资料', '音频')


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


def render(readme, files):
    if readme.count(START) != 1 or readme.count(END) != 1 or readme.index(START) > readme.index(END):
        raise ValueError('README.md 必须包含唯一且顺序正确的 AUTO-CATALOG 起止标记。')
    before, rest = readme.split(START)
    _, after = rest.split(END)
    digest = hashlib.sha256()
    courses = sorted({PurePosixPath(p).parts[1] for p in files
                      if p.startswith('课程/') and len(PurePosixPath(p).parts) == 3
                      and p.endswith('/index.md')})
    lines = ['## 按课程浏览', '']
    total = 0
    for path, data in sorted(files.items()):
        if path != 'README.md':
            digest.update(path.encode() + b'\0' + hashlib.sha256(data).digest())
    for course in courses:
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
    lines.extend([f'已登记 **{len(courses)}** 门课程、**{total}** 份资料（不含索引、模板和历史入口）。', '',
                  f'<!-- 仓库内容摘要（不含 README）：{digest.hexdigest()} -->'])
    return before + START + '\n\n' + '\n'.join(lines) + '\n\n' + END + after


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
    rules = [line.strip() for line in files['.gitignore'].decode().splitlines()
             if line.strip() and not line.lstrip().startswith('#')]
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
                    raise ValueError(f'教材解析须使用第01章-名称.md：{path}')
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
    courses = {PurePosixPath(p).parts[1] for p in files if p.startswith('课程/') and len(PurePosixPath(p).parts) >= 3}
    for course in courses:
        course_index = f'课程/{course}/index.md'
        if '课程/index.md' not in files or course_index not in links('课程/index.md', files['课程/index.md']):
            raise ValueError(f'课程未登记到课程总索引：{course}')
        if course_index not in files:
            raise ValueError(f'缺少课程入口：{course_index}')
        for kind in KINDS:
            index = f'课程/{course}/{kind}/index.md'
            if index not in files or index not in links(course_index, files[course_index]):
                raise ValueError(f'课程入口缺少分类链接：{index}')


def sync(worktree=False):
    files = snapshot(worktree=worktree)
    readme = files['README.md']
    if not worktree and (not Path('README.md').is_file() or Path('README.md').read_bytes() != readme):
        raise ValueError('README.md 有未暂存修改；请先暂存或保存这些修改。')
    output = render(readme.decode(), files).encode()
    files['README.md'] = output
    validate(files)
    if Path('README.md').read_bytes() != output:
        Path('README.md').write_bytes(output)
        if not worktree:
            git('add', '--', 'README.md')
    print('README 课程目录、白名单、命名与索引检查通过。')


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
        print('待推送提交的目录与资料检查通过。')
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
