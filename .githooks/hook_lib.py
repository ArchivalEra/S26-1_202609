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
    # 行内代码里的 ]( 不是链接（CommonMark），示例与讨论文本不应被判为失效链接。
    text = re.sub(r'`[^`\n]*`', '', text)
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
                # 教材分三部分，每部分各有自己的第 1、2、3 章，所以目录顶层用
                # 「第N部分-<部分名>/第M章-<章名>/」区分，文件名只写真章节号：
                #   第一部分-线性代数/第1章-行列式/1.1-二阶与三阶行列式.md
                # 两种写法都接受（后者是兼容早期的整章单文件写法）：
                #   <节号>-<名称>.md             如 1.1-二阶与三阶行列式.md
                #   第NN章-<名称>.md             如 第01章-测试.md
                # 前面可再带「第N部分-」（更早期写法）。
                ok = (
                    re.fullmatch(r'(?:第\d+部分-)?(?:第\d{2,}章-)?\d+\.\d+.*\.md', name)
                    or re.fullmatch(r'(?:第\d+部分-)?第\d{2,}章-.+\.md', name)
                )
                if not ok:
                    raise ValueError(
                        f'教材解析须使用「<节号>-<名称>.md」（如 1.1-二阶与三阶行列式.md）：{path}')
            else:
                if not re.fullmatch(r'\d{4}-\d{2}-\d{2}-.+\.md', name):
                    raise ValueError(f'日期资料须使用 YYYY-MM-DD-名称.md：{path}')
                datetime.date.fromisoformat(name[:10])
        index = f'课程/{course}/{kind}/index.md'
        # 教材解析分三部分，链接登记在分部索引里（如 …/教材解析/第一部分-线性代数/index.md），
        # 所以除分类总索引外，也接受该分类下**任意一层的 index.md** 里被链接到。
        # 其它分类仍只认分类索引本身。
        candidates = [index]
        if kind == '教材解析':
            prefix = f'课程/{course}/教材解析/'
            candidates += sorted(
                p for p in files
                if p.startswith(prefix) and p.endswith('/index.md')
            )
        if not any(c in files and path in links(c, files[c]) for c in candidates):
            raise ValueError(
                f'资料未登记到分类索引 {index}'
                + ('（或其分部索引）' if kind == '教材解析' else '')
                + f'：{path}')
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
    check_build_targets(files)


def changed_paths(files, base):
    """相对基线有变化的路径：新增、修改、删除都算。"""
    return {p for p in set(files) | set(base) if files.get(p) != base.get(p)}


def check_index_sync(files, base):
    """课程资料有变动，对应分类索引必须在同一次提交更新。

    规则：`课程/<课程>/<类别>/` 下任何文件（不含 index.md）内容变化——
    新增、删除、修改都算——则 `课程/<课程>/<类别>/index.md` 必须同时变化。
    索引是该类资料的登记处（含 `last_updated`），资料动了索引不动即为过期。
    """
    if base is None:
        return
    changed = changed_paths(files, base)
    stale = {}
    for path in sorted(changed):
        category = classify(path)
        if not category:
            continue
        course, kind = category
        stale.setdefault(f'课程/{course}/{kind}/index.md', []).append(path)
    problems = [f'{index}：' + '、'.join(items)
                for index, items in sorted(stale.items()) if index not in changed]
    if problems:
        raise ValueError('课程资料有变动，必须在同一次提交更新对应分类索引（并更新其中的 '
                         'last_updated）—— ' + '；'.join(problems))


BUILD_SCRIPT = '站点/build.mjs'
# 静态站构建脚本里硬编码的待渲染清单。它与 .gitignore 白名单一样是显式枚举，
# 但漏填不会报错、只会静默不上线，故在此校验二者一致。
TARGET_FILES_RE = re.compile(r'^const TARGET_FILES = \[(.*?)^\];', re.M | re.S)


def build_targets(files):
    """从 build.mjs 读出的 TARGET_FILES 清单；脚本不存在时返回 None。"""
    if BUILD_SCRIPT not in files:
        return None
    match = TARGET_FILES_RE.search(files[BUILD_SCRIPT].decode())
    if not match:
        raise ValueError(f'{BUILD_SCRIPT} 中找不到 TARGET_FILES 清单，无法校验站点渲染范围。')
    return re.findall(r"'([^']+)'", match.group(1))


def check_build_targets(files):
    """站点要渲染的文件必须都被 build.mjs 的 TARGET_FILES 覆盖。

    清单是硬编码的（与白名单同理，便于人工确认站点范围），代价是新增资料
    容易漏填——漏填不报错、页面静默不上线。这里把"应渲染"与"清单"对齐：
    清单里列出但仓库没有的文件视为过期条目，仓库有却没列出的视为漏填。
    """
    targets = build_targets(files)
    if targets is None:
        return
    listed = set(targets)
    # 应渲染范围：仓库说明 + 课程目录下所有 Markdown（模板、历史入口除外）
    expected = {'README.md', '维护条例.md', '维护细则.md'}
    expected |= {p for p in files
                 if p.startswith('课程/') and p.endswith('.md')}
    missing = sorted(expected - listed)
    if missing:
        raise ValueError(f'{BUILD_SCRIPT} 的 TARGET_FILES 漏列以下文件，站点不会渲染它们：'
                         + '、'.join(missing))
    stale = sorted(p for p in listed if p not in files)
    if stale:
        raise ValueError(f'{BUILD_SCRIPT} 的 TARGET_FILES 列了仓库中不存在的文件：'
                         + '、'.join(stale))


def check_worktree_sync(files):
    """未加 --worktree 时，工作区的两处自动区块文件必须与暂存内容一致。"""
    for path in ('README.md', MAINT_PATH):
        if path not in files:
            raise ValueError(f'缺少 {path}。')
        if not Path(path).is_file() or Path(path).read_bytes() != files[path]:
            raise ValueError(f'{path} 有未暂存修改；请先暂存或保存这些修改。')


def head_snapshot(base_ref=None):
    """基线快照（默认 HEAD）。仓库尚无提交时返回 None，索引同步检查跳过。"""
    ref = base_ref or 'HEAD'
    try:
        git('rev-parse', '--verify', '--quiet', ref + '^{commit}')
    except subprocess.CalledProcessError:
        return None
    return snapshot(git('rev-parse', ref + '^{commit}').decode().strip())


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
    check_index_sync(staged, head_snapshot())
    for path, data in outputs.items():
        if files[path] != data:
            Path(path).write_bytes(data)
            if not worktree:
                git('add', '--', path)
    print('README 课程目录、维护细则状态、白名单、命名与索引检查通过。')
    print('课程资料与分类索引同步检查通过。')


def main():
    os.chdir(git('rev-parse', '--show-toplevel').decode().strip())
    if sys.argv[1:] == ['pre-push']:
        for line in sys.stdin:
            local_ref, oid, remote_ref, remote_oid = line.split()
            if set(oid) == {'0'}:
                continue
            files = snapshot(git('rev-parse', oid + '^{commit}').decode().strip())
            validate(files)
            check_index_sync(files, head_snapshot(oid + '^'))
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
