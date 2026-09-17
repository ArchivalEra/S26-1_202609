#!/usr/bin/env python3
"""Synchronize the README catalog from the commit's index, not unstaged files."""

import hashlib
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import quote

START = '<!-- AUTO-CATALOG:START -->'
END = '<!-- AUTO-CATALOG:END -->'


def git(*args):
    return subprocess.check_output(['git', *args])


def render(readme, files):
    if readme.count(START) != 1 or readme.count(END) != 1:
        raise ValueError('README.md 必须包含唯一的 AUTO-CATALOG 起止标记。')
    before, rest = readme.split(START)
    _, after = rest.split(END)
    digest = hashlib.sha256()
    notes = []
    originals = []
    for path, data in sorted(files.items()):
        if path == 'README.md':
            continue
        digest.update(path.encode() + b'\0' + hashlib.sha256(data).digest())
        if re.fullmatch(r'knowledge/.+/\d{4}-\d{2}-\d{2}-.+\.md', path):
            text = data.decode('utf-8')
            heading = re.search(r'^# (.+)$', text, re.MULTILINE)
            title = heading.group(1) if heading else Path(path).stem
            title = title.replace('[', '\\[').replace(']', '\\]')
            notes.append(f'- **{Path(path).name[:10]}**：[{title}](./{quote(path)})')
        elif path.startswith('Original/') and path != 'Original/README.md':
            originals.append(f'- [{Path(path).name}](./{quote(path)})')
    lines = ['## 课时与概念归档', '', *(notes or ['暂无课时笔记。']), '',
             '## 原始资料', '', *(originals or ['暂无原始资料。']), '',
             f'已归档 **{len(notes)}** 篇笔记、**{len(originals)}** 份原始资料。', '',
             f'<!-- 仓库内容摘要（不含 README）：{digest.hexdigest()} -->']
    return before + START + '\n\n' + '\n'.join(lines) + '\n\n' + END + after


def main():
    root = Path(git('rev-parse', '--show-toplevel').decode().strip())
    import os
    os.chdir(root)
    preview = sys.argv[1:] == ['--worktree']
    if sys.argv[1:] and not preview:
        raise ValueError('用法：update-readme.py [--worktree]')
    if preview:
        paths = git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split(b'\0')
        files = {p.decode(): Path(p.decode()).read_bytes() for p in paths
                 if p and Path(p.decode()).is_file()}
    else:
        if git('ls-files', '--unmerged'):
            raise ValueError('请先解决合并冲突，再同步 README。')
        staged_readme = git('show', ':README.md')
        # Never stage the user's unstaged README edits as a side effect.
        if not Path('README.md').is_file() or Path('README.md').read_bytes() != staged_readme:
            raise ValueError('README.md 有未暂存修改；请先暂存或保存这些修改后重试。')
        files = {}
        for entry in git('ls-files', '--stage', '-z').split(b'\0'):
            if not entry:
                continue
            metadata, path = entry.split(b'\t', 1)
            mode, oid, _ = metadata.split()
            if mode == b'160000':
                files[path.decode()] = oid
            else:
                files[path.decode()] = git('cat-file', 'blob', oid.decode())
    output = render(files['README.md'].decode('utf-8'), files).encode('utf-8')
    if output != Path('README.md').read_bytes():
        Path('README.md').write_bytes(output)
        if not preview:
            git('add', '--', 'README.md')
    print('✅ README 目录与内容摘要已同步。')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, subprocess.CalledProcessError, OSError) as error:
        print(f'❌ README 自动同步失败：{error}', file=sys.stderr)
        sys.exit(1)
