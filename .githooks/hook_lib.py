#!/usr/bin/env python3
"""Shared snapshot validation for the semester repository.

每次提交时从暂存内容重新生成两处自动区块：
- README.md 的 AUTO-CATALOG：课程目录。
- 维护细则.md 的 AUTO-MAINTENANCE：仓库状态、解析进度与验证基线。
- 各 md frontmatter 的 last_updated：按「该文件自己的最后一次实质修改」推导
  （实质变更 ⇒ 提交当日；未变 ⇒ 最后一次实质修改该文件的提交日期），自动改写入库。

推送前校验待推送提交里的两处区块都已同步。
"""
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import subprocess
import sys
import unicodedata
from urllib.parse import quote, unquote, urlsplit

START = '<!-- AUTO-CATALOG:START -->'
END = '<!-- AUTO-CATALOG:END -->'
MAINT_PATH = '维护细则.md'
MAINT_START = '<!-- AUTO-MAINTENANCE:START -->'
MAINT_END = '<!-- AUTO-MAINTENANCE:END -->'
KINDS = ('作业', '教材解析', '课堂笔记', '原始资料', '音频')
INDEX_LABEL = '分类索引'

# 默认每门课建五类子目录；但确实没有某一类内容的课程可以在这里声明豁免。
# 例：形势与政策、思政类公共课没有可整理的教材正文，强行建一个永远空着的
# 「教材解析」目录只会给课程入口和自动目录添噪音。
#
# 边界（很重要）：豁免只声明「本课不建该类目录」，**不是**「该类资料可以乱放」。
# 若某课豁免后仍然出现了该类资料文件，register 环节的「资料未登记到分类索引」
# 会要求它有自己的 index.md——半吊子状态自然被堵住。
COURSE_SKIPPED_KINDS = {
    '形势与政策': ('教材解析',),
    '劳动教育': ('教材解析',),
}


def kinds_of(course):
    """该课程应建/应校验的分类，默认即 KINDS，按 COURSE_SKIPPED_KINDS 去掉豁免项。"""
    skipped = COURSE_SKIPPED_KINDS.get(course, ())
    return tuple(kind for kind in KINDS if kind not in skipped)


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
    if len(parts) >= 4 and parts[0] == '课程总览' and parts[2] in KINDS and parts[-1] != 'index.md':
        return parts[1], parts[2]
    return None


def courses(files):
    return sorted({PurePosixPath(p).parts[1] for p in files
                   if p.startswith('课程总览/') and len(PurePosixPath(p).parts) == 3
                   and p.endswith('/index.md')})


def count_kind(files, course, kind):
    return sum(1 for p in files if classify(p) == (course, kind))


def render(readme, files):
    """README 的 AUTO-CATALOG 区块（2026-10-17 瘦身：不再平铺资料清单）。

    平铺目录与「课程首页 → 分类 index」两层完全重复（三层登记），483 行的 README
    79% 是它。现在只生成**课程一行摘要**——门数与每课资料计数；细节看各课 index。
    digest 保留（内容摘要仍是「仓库变了没」的硬判据）。
    """
    if readme.count(START) != 1 or readme.count(END) != 1 or readme.index(START) > readme.index(END):
        raise ValueError('README.md 必须包含唯一且顺序正确的 AUTO-CATALOG 起止标记。')
    before, rest = readme.split(START)
    _, after = rest.split(END)
    digest = hashlib.sha256()
    names = courses(files)
    for path, data in sorted(files.items()):
        if path != 'README.md':
            digest.update(path.encode() + b'\0' + hashlib.sha256(data).digest())
    total = sum(1 for p in files if classify(p))
    lines = ['## 课程目录', '',
             '| 课程 | 资料数 | 入口 |',
             '| :--- | ---: | :--- |']
    for course in names:
        n = sum(1 for p in files if classify(p) and classify(p)[0] == course)
        lines.append(f'| {course} | {n} | [进入](./{quote("课程总览/" + course + "/index.md")}) |')
    lines.extend(['', f'共 **{len(names)}** 门课程、**{total}** 份资料。',
                  f'<!-- 仓库内容摘要（不含 README）：{digest.hexdigest()} -->'])
    return before + START + '\n\n' + '\n'.join(lines) + '\n\n' + END + after


def whitelist_rules(files):
    rules = [line.strip() for line in files['.gitignore'].decode().splitlines()
             if line.strip() and not line.lstrip().startswith('#')]
    return rules


def render_maintenance(text, files):
    """维护细则的 AUTO-MAINTENANCE 区块（2026-10-17 同步瘦身）。

    保留：仓库状态三行摘要 + 课程分类一览表 + 验证基线。
    删除：教材解析进度、原始资料构成、待补提示（与各课 index 重复；
    「待补」按 2026-10-12 定案归 GitHub issue，不在仓库正文里列）。
    """
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
        required = kinds_of(course)
        cells = ['—' if kind not in required else str(count_kind(files, course, kind))
                 for kind in KINDS]
        missing = [kind for kind in required if f'课程总览/{course}/{kind}/index.md' not in files]
        lines.append(f'| {course} | ' + ' | '.join(cells) + ' | ' + ('齐全' if not missing else '缺 ' + '、'.join(missing)) + ' |')
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


def fragments(path, data):
    """本文件写下的全部深链接：(目标文件, 锚点)。覆盖 相对.md#锚点 与 同页 #锚点。"""
    text = re.sub(r'```.*?```', '', data.decode(), flags=re.S)
    text = re.sub(r'`[^`\n]*`', '', text)
    found = []
    for target in re.findall(r'\[[^\]\n]*\]\(([^\s)]+)(?:\s+[^)]*)?\)', text):
        target = target.strip('<>')
        parsed = urlsplit(target)
        if not parsed.fragment:
            continue
        if parsed.scheme or not parsed.path:
            found.append((path, unquote(parsed.fragment)))
        else:
            resolved = posixpath.normpath(
                posixpath.join(posixpath.dirname(path), unquote(parsed.path)))
            found.append((resolved, unquote(parsed.fragment)))
    return found


def anchors(path, data):
    """目标文件里可被深链接命中的锚点集合（近似 站点/build.mjs 的生成规则）：

    ① 折叠面板/令牌的 {#id}（collapse 面板与符号词条都走这个语法）；
    ② 显式 HTML id="…"；
    ③ 符号入门页的 :::glossary-dict table 围栏——每条词条在页面上是 id="<词条id>" 的一行
       （见 站点/plugins/math-glossary.mjs 的 table 选项与 build.mjs 的 renderDictTable）；
    ④ 标题 slug——行内公式剔除后小写、非字词序列转单个 -、去首尾 -；
       重复 slug 依次追加 -2、-3……与渲染器的逐页去重规则一致。
    代码围栏内的内容不算锚点。近似点：标题里的公式按「整体剔除」处理，
    而渲染器会保留其纯文本——因此含公式的标题请用面板锚点或显式 id 深链接。
    """
    text = re.sub(r'```.*?```', '', data.decode(), flags=re.S)
    ids = set(re.findall(r'\{#([A-Za-z_][A-Za-z0-9_-]*)\}', text))
    ids |= set(re.findall(r'\bid="([^"]+)"', text))
    for block in re.findall(r'^:::glossary-dict[ \t]+table[ \t]*$(.*?)^:{3,}[ \t]*$', text, flags=re.S | re.M):
        ids |= set(re.findall(r'^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*\|', block, flags=re.M))
    used = set()
    for line in text.splitlines():
        if not re.match(r'#{1,6}\s', line):
            continue
        h = re.sub(r'\$[^$]*\$', ' ', line)
        h = re.sub(r'<[^>]+>', '', h)
        h = re.sub(r'^#{1,6}\s+', '', h).strip()
        slug = re.sub(r'[^\w\u4e00-\u9fa5]+', '-', h).strip('-').lower()
        if not slug:
            continue
        if slug in used:
            n = 2
            while f'{slug}-{n}' in used:
                n += 1
            slug = f'{slug}-{n}'
        used.add(slug)
    return ids | used


def check_fragments(files):
    """深链接锚点校验：xxx.md#锚点 与同页 #锚点 的目标必须真实存在。
    目标文件本身缺失由本地链接检查负责；这里只管「文件在、锚点不在」。"""
    for path, data in files.items():
        if not path.endswith('.md') or path.startswith('模板/'):
            continue
        for target, fragment in fragments(path, data):
            if target not in files:
                continue
            if fragment not in anchors(target, files[target]):
                raise ValueError(f'深链接锚点失效：{path} → {target}#{fragment}')


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
    # 课程状态**唯一产地 = README 的 COURSE-STATUS 块**（2026-10-11 定案）：
    # 只允许「开课 / 结课」两档（页面顶端的第一条信息，语义是「这门课还在不在上」）。
    # 资料页**不再自己写 status**——它们由构建期从 README 继承（见 站点/build.mjs
    # 的 loadCourseStatus）。这里校验产地：块在、课齐、值合法。
    if 'README.md' in files:
        readme = files['README.md'].decode()
        m = re.search(r'<!-- COURSE-STATUS:START -->(.*?)<!-- COURSE-STATUS:END -->',
                      readme, flags=re.S)
        if not m:
            raise ValueError('README.md 缺 COURSE-STATUS 块——课程状态的唯一产地，别删。')
        status_rows = {}
        for line in m.group(1).splitlines():
            row = re.fullmatch(r'\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|', line.strip())
            if not row:
                continue
            name, status = row.group(1), row.group(2)
            if name == '课程' or set(name) <= set('-: '):
                continue
            if status not in ('开课', '结课'):
                raise ValueError(
                    f'README 课程状态表：{name} 的状态「{status}」非法——只允许「开课」或「结课」两档。')
            status_rows[name] = status
        if not status_rows:
            raise ValueError('README 的 COURSE-STATUS 块里一条课程都没有——空不是通过。')
        # 每门课都要在状态表里（漏一门 ⇒ 该课页面顶端就没有状态）
        for course in courses(files):
            if course not in status_rows:
                raise ValueError(f'README 课程状态表漏了「{course}」——每门课都要有一行状态。')
    for path, data in files.items():
        if path.startswith('课程总览/') and path.endswith('.md'):
            text = data.decode()
            if re.search(r'(?m)^status:', text):
                raise ValueError(
                    f'{path} 写了 status —— 课程状态由 README 的 COURSE-STATUS 块统一给出，'
                    '资料页不写（构建期自动继承）。')
    for path in files:
        category = classify(path)
        if not category:
            continue
        course, kind = category
        name = PurePosixPath(path).name
        # ⚠️ 2026-10-29 站长定案：**文件名 = 侧栏标签**，不再按类别套不同命名模板。
        #
        # 旧实现按类别各有一套正则（教材解析必须 `<节号>-<名称>.md`、日期资料必须
        # `YYYY-MM-DD-名称.md`），后果是**同一个页面有三个名字**：
        #   网址 `2026-10-16-作业3.html` / 侧栏「作业3（习题 2.3、2.4、3.1）」/ H1 又是另一个。
        # 站点导航要靠人脑在三个名字之间换算，机器（含 AI）更容易走错。
        #
        # 现在只有一条：**文件名（去 .md）= 侧栏标签**。三条结构（网址 / 侧栏 / 面包屑）
        # 因此天然逐字一致；命名是否美观由侧栏标签决定，而侧栏标签本来就要求短（§3.4.1 宽度预算）。
        # 这条规则替代了原来按类别分支的两套正则——「美观看标签」而不是「看类别模板」。
        if kind == '原始资料' and not name.endswith('.md'):
            # 配图等二进制资产（如 作业/figures/*.jpg）豁免命名检查；
            # 是否随批次登记到分类索引仍由 index-sync 检查统一把关。
            continue
        nav_label = _nav_label_of(files, path)
        if nav_label is not None:
            expect = nav_label + '.md'
            if name != expect:
                raise ValueError(
                    f'文件名必须与侧栏标签逐字一致：本页侧栏写「{nav_label}」，'
                    f'所以文件应叫「{expect}」，实际是「{name}」（{path}）。'
                    '三条结构（网址/侧栏/面包屑）以网址为准，改哪边都要两边一起改。')
        index = f'课程总览/{course}/{kind}/index.md'
        # 教材解析分三部分，链接登记在分部索引里（如 …/教材解析/第一部分-线性代数/index.md），
        # 所以除分类总索引外，也接受该分类下**任意一层的 index.md** 里被链接到。
        # 其它分类仍只认分类索引本身。
        candidates = [index]
        if kind == '教材解析':
            prefix = f'课程总览/{course}/教材解析/'
            candidates += sorted(
                p for p in files
                if p.startswith(prefix) and p.endswith('/index.md')
            )
        # 配图等非 .md 资产（如 作业/figures/*.jpg）是所属页面的内嵌资产：
        # 命名豁免同理，不要求逐张登记进分类索引（随作业页一起入库）。
        if not path.endswith('.md'):
            continue
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
    check_fragments(files)
    names = {PurePosixPath(p).parts[1] for p in files if p.startswith('课程总览/') and len(PurePosixPath(p).parts) >= 3}
    for course in names:
        course_index = f'课程总览/{course}/index.md'
        if '课程总览/index.md' not in files or course_index not in links('课程总览/index.md', files['课程总览/index.md']):
            raise ValueError(f'课程未登记到课程总索引：{course}')
        if course_index not in files:
            raise ValueError(f'缺少课程入口：{course_index}')
        for kind in kinds_of(course):
            index = f'课程总览/{course}/{kind}/index.md'
            if index not in files or index not in links(course_index, files[course_index]):
                raise ValueError(f'课程入口缺少分类链接：{index}')
    check_build_targets(files)
    check_nav_coverage(files)
    check_nav_titles(files)
    check_readme_documents_ui(files)
    check_exam_prep(files)


# ── last_updated：推导字段（2026-10-17 定案）────────────────────────────────────
# 「last_updated 需要手动更新」是个假事实：日期本来就映射「该文件自己的最后一次
# 实质修改」，直接由 git 推导——实质变更（剥掉日期行后内容仍不同）⇒ 提交当日；
# 未变 ⇒ 最后一次**实质**修改该文件的提交日期（纯改日期行的提交不算修改——
# 否则钩子自己的纠正会让日期永漂不居）。钩子每次提交自动改写并 git add，手抄作废；
# 只改日期行不算内容变化——既不能充当「索引已更新」，也不触发 handoff 时效。
# （开课/结课的 status 不同：那是上位事实，仍由 README 课程状态表统一传导。）
LAST_UPDATED_LINE_RE = re.compile(r'(?m)^(last_updated:[ \t]*"?)[^"\n]*("?[ \t]*)$')


def _frontmatter_date_match(path, data):
    """md 带 frontmatter 且含 last_updated 键 ⇒ (全文文本, 行匹配)；否则 None。"""
    if not path.endswith('.md'):
        return None
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        return None
    if not text.startswith('---\n'):
        return None
    end = text.find('\n---', 4)
    if end < 0:
        return None
    m = LAST_UPDATED_LINE_RE.search(text[:end])
    return (text, m) if m else None


def normalized_for_compare(path, data):
    """比较用的规范化内容：md 的 last_updated 行值抹平（日期是推导字段，不算内容）。"""
    if not path.endswith('.md'):
        return data
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        return data
    if not text.startswith('---\n'):
        return data
    end = text.find('\n---', 4)
    if end < 0:
        return data
    head = LAST_UPDATED_LINE_RE.sub(lambda m: m.group(1) + '@' + m.group(2), text[:end], count=1)
    return (head + text[end:]).encode('utf-8')


def last_commit_dates(paths):
    """每个路径最后一次**实质**修改的提交日期（YYYY-MM-DD）。

    git log 新→旧拿候选提交（core.quotePath=off——中文路径不转义成八进制，
    否则永远查不到、全部回退成「今天」）；每个路径从最新候选往回走，
    剥掉 last_updated 行比较前后 blob——只有实质变更的提交才算数，
    钩子自己改写日期产生的提交被跳过，日期因此收敛不漂。
    """
    if not paths:
        return {}
    candidates = {}
    current = None
    out = git('-c', 'core.quotePath=off', 'log', '--date=short',
              '--format=@%H %ad', '--name-only', '--no-renames').decode('utf-8')
    for line in out.splitlines():
        if line.startswith('@'):
            current = tuple(line[1:].split(' ', 1))
        elif line and current is not None:
            candidates.setdefault(line, []).append(current)
    dates = {}
    for path in paths:
        for commit, date in candidates.get(path, ()):
            # 父提交没有该路径 ⇒ 本次为新增；本提交没有 ⇒ 该提交删除了它，都不算修改。
            # cat-file 的 stderr 静音：这两种情况是正常分支，不该往钩子输出里喷 git 报错。
            def blob(ref):
                result = subprocess.run(['git', 'cat-file', 'blob', f'{ref}:{path}'],
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                return result.stdout if result.returncode == 0 else None
            new = blob(commit)
            old = blob(commit + '^')
            if new is not None and (old is None
                                    or normalized_for_compare(path, new) != normalized_for_compare(path, old)):
                dates[path] = date
                break
    return dates


def sync_last_updated(files, base, worktree=False):
    """把 md frontmatter 的 last_updated 对齐为该文件自己的最后一次实质修改日期。

    实质变更（相对基线，剥掉日期行后内容仍不同）⇒ 提交当日；新文件 ⇒ 提交当日；
    未变 ⇒ 最后一次实质修改它的提交日期。改写工作区、更新 files 快照；提交模式
    下 git add（与两处自动区块同一模式）。模板/ 保留占位值不碰；工作区与暂存
    不一致的文件跳过（不把未暂存编辑带入提交）。
    """
    base = base or {}
    today = datetime.date.today().isoformat()
    entries = []
    for path, data in sorted(files.items()):
        if path.startswith('模板/'):
            continue
        hit = _frontmatter_date_match(path, data)
        if hit:
            entries.append((path, *hit))
    unchanged, targets = [], {}
    for path, text, m in entries:
        if path not in base or normalized_for_compare(path, files[path]) != normalized_for_compare(path, base[path]):
            targets[path] = today
        else:
            unchanged.append(path)
    targets.update(last_commit_dates(unchanged))
    changed = []
    for path, text, m in entries:
        target = targets.get(path, today)
        if m.group(0) == m.group(1) + target + m.group(2):
            continue
        p = Path(path)
        if not worktree and (not p.is_file() or p.read_bytes() != files[path]):
            print(f'[last_updated] {path}：工作区与暂存不一致，跳过日期对齐')
            continue
        new = (text[:m.start()] + m.group(1) + target + m.group(2) + text[m.end():]).encode('utf-8')
        p.write_bytes(new)
        files[path] = new
        changed.append(path)
    if changed and not worktree:
        git('add', '--', *changed)
        print(f'last_updated 已按各文件自己的提交日期自动对齐：{len(changed)} 个文件。')
    return changed


def changed_paths(files, base):
    """相对基线有变化的路径：新增、删除、修改都算（md 只改 last_updated 行不算）。"""
    def differs(p):
        if p in files and p in base:
            return normalized_for_compare(p, files[p]) != normalized_for_compare(p, base[p])
        return files.get(p) != base.get(p)
    return {p for p in set(files) | set(base) if differs(p)}


def ancestor_indexes(path, files):
    """该页面的全部祖先 index.md，由近及远，不含自身。

    「父页面」= 最近一级上级目录里的 index.md；它的父页面再往上一级……直到
    `课程/index.md`。中间目录若没建 index.md 就跳过——教材解析的章节目录不单独
    建索引，层级并入最近的分部索引（`第一部分-线性代数/index.md`）。
    """
    parts = PurePosixPath(path).parts
    out, seen = [], set()
    for i in range(len(parts) - 1, 0, -1):
        candidate = (PurePosixPath(*parts[:i]) / 'index.md').as_posix()
        if candidate == path or candidate in seen:
            continue
        seen.add(candidate)
        if candidate in files:
            out.append(candidate)
    return out


def check_index_sync(files, base):
    """子页面有变动，父页面必须在同一次提交更新——**层层递进**。

    规则：`课程/` 下任何**页面**（`.md`）实质变化（新增、删除、修改都算；只改
    last_updated 不算，那是推导字段）⇒ 它**每一层**祖先 index.md 都必须同时变化：
    `章节目录里的某节 → 分部索引 → 分类索引 → 课程索引 → 课程总索引`。

    **只算 `.md`**：原始资料里的 `.heic`/`.txt`/`figures/` 是内嵌资产不是页面，
    换一张图不该逼着三层索引一起动；它们归属的登记页（`原始资料/index.md` 等）
    本身是 `.md`，登记变了自然会往上传导。

    **为什么要把链条拉满（2026-10-28 实弹）**：此前只校验「资料 → 分类索引」
    一层，上面两层从无校验。于是 `课程/index.md` 里电子技术长期写着「两次作业」
    （实际六次）、工程数学写着「第 1–2 章教材解析」（实际到第 3 章）——
    摘要页不更新就腐烂，而且腐烂时没有任何信号：构建照过、链接照通、
    读者看到的是一句过期的概述。层级由目录结构决定，不写死层数。
    """
    if base is None:
        return
    changed = changed_paths(files, base)
    missing = {}
    for path in sorted(changed):
        if not path.startswith('课程总览/') or not path.endswith('.md'):
            continue
        for ancestor in ancestor_indexes(path, files):
            if ancestor not in changed:
                missing.setdefault(ancestor, []).append(path)
    if not missing:
        return
    detail = '；'.join(f'{idx}（因 {"、".join(items)}）'
                      for idx, items in sorted(missing.items()))
    raise ValueError(
        '课程资料有变动，必须在同一次提交逐层更新父页面，直到课程总索引——'
        '每一层都要动（父页面指上级目录的 index.md，摘要/入口内容随之更新）：' + detail)


BUILD_SCRIPT = '站点/build.mjs'
HANDOFF_PATH = '.zcode/handoff.md'
# 「实施一步」的工作区：这两处有改动，就要求自更新 handoff 同步更新过
WORK_AREAS = ('课程总览/', '站点/')


def check_handoff_freshness(files, base):
    """改动 课程/ 或 站点/ 的提交，`.zcode/handoff.md` 必须比上一次提交更新。

    自更新 handoff 是抗上下文压缩的唯一载体，此前只靠「维护约定」——此处改为强制：
    handoff 的修改时间不早于 HEAD 的提交时间，才算「实施完一步回来更新过」。
    **仅当工作区存在该文件时强制**：handoff 按用户要求不入库，外部克隆与 CI
    没有它，不应被这条规则拦截。
    """
    if base is None:
        return
    handoff = Path(HANDOFF_PATH)
    if not handoff.is_file():
        return
    changed = changed_paths(files, base)
    if not any(p.startswith(WORK_AREAS) for p in changed):
        return
    head_time = int(git('log', '-1', '--format=%ct').decode().strip() or '0')
    if handoff.stat().st_mtime < head_time:
        raise ValueError(
            '本次提交改动了 课程/ 或 站点/，但 .zcode/handoff.md 未更新——'
            '按维护约定「实施完一步就回来更新」：改 §1 当前状态 / §6 下一步 / §7 速查，'
            '把新踩的坑追加进 §8 坑清单。'
            '（确认本次改动无需更新 handoff 时：touch .zcode/handoff.md）')
# 待渲染清单。**2026-10-15 起搬到独立模块** `站点/页面清单.mjs`（构建期与 MCP 读层共用同一份，
# 避免读层 import build.mjs 触发整站重建、或抄一份清单制造第二个真相源）。
# 清单仍是显式枚举，漏填不会报错、只会静默不上线，故在此校验它与仓库实况一致。
PAGE_MANIFEST = '站点/页面清单.mjs'
TARGET_FILES_RE = re.compile(r'^export const TARGET_FILES = \[(.*?)^\];', re.M | re.S)
# 兼容旧位置（build.mjs 内联）——两者都找不到才算错。
TARGET_FILES_RE_LEGACY = re.compile(r'^const TARGET_FILES = \[(.*?)^\];', re.M | re.S)


def build_targets(files):
    """读出待渲染清单；清单模块与构建脚本都不在变更集里时返回 None。"""
    if PAGE_MANIFEST in files:
        match = TARGET_FILES_RE.search(files[PAGE_MANIFEST].decode())
        if match:
            return re.findall(r"'([^']+)'", match.group(1))
        raise ValueError(f'{PAGE_MANIFEST} 中找不到 TARGET_FILES 清单，无法校验站点渲染范围。')
    if BUILD_SCRIPT in files:
        match = TARGET_FILES_RE_LEGACY.search(files[BUILD_SCRIPT].decode())
        if match:
            return re.findall(r"'([^']+)'", match.group(1))
        raise ValueError(
            f'{BUILD_SCRIPT} 与 {PAGE_MANIFEST} 中都没有 TARGET_FILES 清单，无法校验站点渲染范围。')
    return None


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
                 if p.startswith('课程总览/') and p.endswith('.md')}
    missing = sorted(expected - listed)
    if missing:
        raise ValueError(f'{BUILD_SCRIPT} 的 TARGET_FILES 漏列以下文件，站点不会渲染它们：'
                         + '、'.join(missing))
    stale = sorted(p for p in listed if p not in files)
    if stale:
        raise ValueError(f'{BUILD_SCRIPT} 的 TARGET_FILES 列了仓库中不存在的文件：'
                         + '、'.join(stale))


# 侧栏覆盖：渲染成页面的 md 必须有侧栏入口。
# 为什么需要这条：`页面清单.mjs` 的 TARGET_FILES 决定「哪些 md 渲染成页面」，
# `build.mjs` 的 NAV_STRUCTURE 决定「侧栏怎么摆」——两者独立、无一致性校验。
# 于是漏加导航**永远不会报错**：页面渲染出来、侧栏没入口、`site_index` 也看不到，
# 资料「存在但不可达」。这条把两个清单对齐：TARGET_FILES − NAV_STRUCTURE 非空即失败。
#
# 有意旁路的页面必须**逐条写清原因**登记在此（与 COURSE_SKIPPED_KINDS 同款白名单纪律）：
# 明确声明「本页不进侧栏」，而不是让差集检查对它们沉默。
NAV_COVERAGE_EXEMPT = {
    '站点/符号包/通用.md': '跨课程共用的符号定义页，只作为气泡「详细 ↗」的落点被引用，'
                          '不属于任何课程的导航层级，故不挂侧栏入口。',
}


def _balanced_array(text, marker):
    """从 `marker` 之后的首个 `[` 起，按括号配对截出整个数组字面量（返回 None 表示找不到）。

    不用正则硬解：NAV_STRUCTURE 是嵌套的 JS 字面量（内含注释、字符串、模板串），
    正则会在第一个 `]` 或字符串里的括号处截断。这里逐字符配对，跳过注释与字符串。
    """
    start = text.find(marker)
    if start < 0:
        return None
    start = text.find('[', start + len(marker))
    if start < 0:
        return None
    depth, i, quote, escaped = 0, start, None, False
    while i < len(text):
        ch = text[i]
        if quote:
            if escaped:
                escaped = False
            elif ch == '\\':
                escaped = True
            elif ch == quote:
                quote = None
            i += 1
            continue
        if ch in '"\'':
            quote = ch
        elif ch == '`':
            quote = ch
        elif ch == '/' and text.startswith('//', i):
            nl = text.find('\n', i)
            i = len(text) if nl < 0 else nl
            continue
        elif ch == '/' and text.startswith('/*', i):
            end = text.find('*/', i)
            i = len(text) if end < 0 else end + 2
            continue
        elif ch == '[':
            depth += 1
        elif ch == ']':
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
        i += 1
    return None


def _nav_paths(script_text):
    """在 node 里求值 NAV_STRUCTURE，收集所有节点的 `[path, label, depth]`。

    用子进程求值而非正则：结构是嵌套 JS，交给 JS 引擎解析才可靠。
    label 缺失时给空串（对齐检查会跳过这种节点）；`depth` 是节点在侧栏里的层级，
    宽度预算按它算（越深越窄，见 NAV_WIDTH_BUDGET）。
    """
    literal = _balanced_array(script_text, 'const NAV_STRUCTURE =')
    if literal is None:
        return None
    program = (
        'const NAV = ' + literal + ';\n'
        'const out = [];\n'
        '(function walk(nodes, depth) {\n'
        '  for (const node of nodes || []) {\n'
        "    if (typeof node.path === 'string') out.push([node.path, "
        "typeof node.label === 'string' ? node.label : '', depth]);\n"
        '    if (Array.isArray(node.children)) walk(node.children, depth + 1);\n'
        '  }\n'
        '})(NAV, 0);\n'
        'process.stdout.write(JSON.stringify(out));'
    )
    try:
        result = subprocess.run(['node', '-e', program],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError:
        raise ValueError('未找到 node，无法求值 NAV_STRUCTURE——钩子校验侧栏覆盖需要 node。')
    if result.returncode != 0:
        raise ValueError(f'求值 {BUILD_SCRIPT} 的 NAV_STRUCTURE 失败：'
                         + result.stderr.decode().strip())
    return json.loads(result.stdout.decode())



_NAV_LABEL_CACHE = {}


def _nav_label_of(files, path):
    """查某个 md 路径在侧栏里的标签；不在侧栏里（或取不到 NAV_STRUCTURE）返回 None。

    为什么要缓存：`_nav_paths` 每次要起一个 node 子进程求值 JS 字面量，
    逐个文件调会把 300 多个文件的检查拖成几十秒。整个提交里 NAV_STRUCTURE 只读一次即可。
    """
    if 'nav' not in _NAV_LABEL_CACHE:
        script = files.get(BUILD_SCRIPT)
        if script is None:
            _NAV_LABEL_CACHE['nav'] = None
        else:
            try:
                rows = _nav_paths(script.decode())
            except (ValueError, UnicodeDecodeError):
                rows = None
            _NAV_LABEL_CACHE['nav'] = (
                {r[0]: r[1] for r in rows} if rows else None)
    table = _NAV_LABEL_CACHE['nav']
    if not table:
        return None
    label = table.get(path)
    return label if label else None


def _h1_title(text):
    """页面 H1 标题：首个 `# ` 行的文本；没有 H1 时返回 None。"""
    for line in text.splitlines():
        if line.startswith('# '):
            return line[2:].strip()
    return None


# 侧栏标签与页面标题的比对口径：**逐字相等**（只折叠连续空白与首尾空白——渲染时
# 空白本就会被 HTML 折叠，把「两个空格」判成不同没有意义）。
# 为什么不许「侧栏写简写」：同一份作业两个名字，读者在侧栏认的是一套、点进去看的是
# 另一套，找东西时对不上号。窄栏显示不下的问题用 CSS 省略号 + `title` 悬停解决，
# **不用改名字的方式解决**——名字是内容事实，栏宽是显示问题，不能拿内容迁就布局。


def _norm_title(text):
    """标题比较用的规范化：折叠连续空白、去首尾。"""
    return re.sub(r'\s+', ' ', text).strip()


# 侧栏标签的宽度预算，按**实际渲染宽度**实测出来的（2026-10-28）。
#
# 侧栏固定 320px（--sidebar-width），每层缩进 20px、左右 padding 各 ~19px，
# 14.08px 字号下一个全角字 ≈ 14.09px。在真实 Chromium 里逐层量 `.drawer-nav-link`
# 的 span 可用宽度，得到各层能放下的全角字数：
#   depth 0 → 18、1 → 17、2 → 15、3 → 14、4 → 13、5 → 11
# 取的是**实测值本身**，不留虚数：写大了标签就会被省略号截断，那正是要防的事。
#
# 为什么按层给而不是一刀切 11：一刀切会把所有页面压到最窄那层的能力，
# 而 depth 5 只有教材解析的章内小节，depth 3 是绝大多数资料页——按各层真实
# 宽度给预算，等于「每一层都刚好不截断」，信息保留最多。
NAV_WIDTH_BUDGET = {0: 18, 1: 17, 2: 15, 3: 14, 4: 13, 5: 11}
# 更深（理论上不该有）按最窄的算。
NAV_WIDTH_BUDGET_FLOOR = 11


def _label_width(text):
    """侧栏标签的等效全角宽度：全角/汉字 1.0、ASCII 0.55、空格 0.3。

    与上面实测的「一个全角字 ≈ 14.09px」对表——所以这里算出来的数就是
    「占多少个全角字的宽度」，直接和 NAV_WIDTH_BUDGET 比。
    """
    total = 0.0
    for ch in text:
        if ch == ' ':
            total += 0.3
        elif unicodedata.east_asian_width(ch) in ('W', 'F', 'A'):
            total += 1.0
        elif ch.isascii():
            total += 0.55
        else:
            total += 1.0
    return total


def check_nav_titles(files):
    """侧栏标签与页面 H1 **必须逐字一致**，且都不得超过该层的宽度预算。

    这是 2026-10-28 站长定案的最终形态（中途试过两个错方向，记在这里防回头）：
    · 先试「H1 权威、侧栏跟着长长」——错。侧栏是导航，职责是短而可扫；
      让导航长成内容标题的样子，等于牺牲导航去迁就标题。
    · 再试「侧栏写简写、H1 自便」——也错。同一份资料两个名字，
      读者在侧栏认一套、点进去看另一套，找东西对不上号。

    **现在的规则**：侧栏标签就是这篇的**正式短名**，H1 等于它，长描述降级进正文。
    所以两件事一起校验：
      ① `label == H1`（逐字，只折叠空白）——一个页面只有一个名字；
      ② `width(label) ≤ 该层预算`——名字短到侧栏放得下，不用省略号截断。

    全部页面都查（不再只管作业页）：短名是站点的导航契约，任何页面都不该例外。
    实测这条把 112 个页面的 H1 与 125 个标签中的 27 个收敛到了预算内。
    """
    if BUILD_SCRIPT not in files:
        return
    nav = _nav_paths(files[BUILD_SCRIPT].decode())
    if nav is None:
        return
    mismatch, too_wide = [], []
    seen = {}
    for path, label, depth in nav:
        if not path.endswith('.md') or not label or path not in files:
            continue
        title = _h1_title(files[path].decode())
        if title is None:
            mismatch.append(f'{path}：页面没有 H1 标题，侧栏标签「{label}」无从对齐')
            continue
        want = _norm_title(title)
        if _norm_title(label) != want:
            mismatch.append(f'侧栏写「{label}」，页面是「{want}」 ⇒ label 应改为 '
                            f'{json.dumps(want, ensure_ascii=False)}（{path}）')
        budget = NAV_WIDTH_BUDGET.get(depth, NAV_WIDTH_BUDGET_FLOOR)
        width = _label_width(label)
        if width > budget:
            too_wide.append(f'「{label}」宽 {width:.1f} > 第 {depth} 层预算 {budget}（{path}）')
        seen.setdefault(path, []).append(label)
    if mismatch:
        raise ValueError(
            '侧栏标签必须与页面 H1 标题逐字一致——一个页面只能有一个正式名字'
            '（侧栏标签即短名，长描述写进正文）：' + '；'.join(mismatch))
    if too_wide:
        raise ValueError(
            '侧栏标签超出该层的宽度预算，会被省略号截断——把名字改短'
            '（长描述写进正文 H2；预算来自真实 Chromium 逐层实测，见 NAV_WIDTH_BUDGET）：'
            + '；'.join(too_wide))

    # 同一个页面被挂了两个不同标签：读者会看到同一份资料在侧栏出现两次，
    # 且两个名字必然有一个不等于 H1。2026-10-28 实测电机学两处（章组节点
    # 借子页当落点），改成纯组节点后消除。
    dup = [f'{p}：{"、".join(f"「{l}」" for l in ls)}'
           for p, ls in seen.items() if len(set(ls)) > 1]
    if dup:
        raise ValueError(
            '同一页面在侧栏里挂了多个不同标签——一个页面只能有一个入口名：'
            + '；'.join(dup))



def check_nav_coverage(files):
    """站点渲染的页面必须都有侧栏入口（TARGET_FILES − NAV_STRUCTURE 非空即失败）。

    资料「存在但不可达」是静默故障：页面照渲染、侧栏无入口、`site_index` 也查不到。
    这里让两个清单（渲染范围 / 侧栏形状）在提交时对齐——有意旁路的页面走
    NAV_COVERAGE_EXEMPT 显式豁免，不豁免的漏项一律报出。
    """
    if BUILD_SCRIPT not in files or PAGE_MANIFEST not in files:
        return
    targets = build_targets(files)
    if targets is None:
        return
    nav = _nav_paths(files[BUILD_SCRIPT].decode())
    if nav is None:
        # 找不到 NAV_STRUCTURE 定义（脚本被替换/改名）时跳过本校验：yaml 结构本就可能变，
        # 真正该拦的是「清单里的页面没有侧栏入口」，别在定义缺失时误伤。
        return
    covered = {path for path, _, _ in nav} | set(NAV_COVERAGE_EXEMPT)
    missing = sorted(set(targets) - covered)
    if missing:
        raise ValueError(
            f'{BUILD_SCRIPT} 的 NAV_STRUCTURE 漏了以下页面——它们会渲染成页面却没有侧栏入口'
            '（站点上看不到、site_index 也搜不到）：' + '、'.join(missing)
            + '。请为该页补一个导航节点；若确实有意不进侧栏，'
            '在 hook_lib.py 的 NAV_COVERAGE_EXEMPT 里逐条写明原因豁免。')


# README 手写区里的「网页版怎么看」按钮表，与站点顶栏实际按钮必须对得上。
# 为什么需要这条：钩子原来只管 AUTO-CATALOG 自动区块，README 正文是手写的——
# 于是站点加了搜索按钮，README 的按钮表还是三个，没有任何校验发现。
# 这里只做**单向**检查（站点有的按钮，README 必须提到），不做措辞检查。
BUTTON_IDS_RE = re.compile(r'class="m3-icon-btn" id="([a-z-]+)"')
# 不参与检查的按钮：搜索面板内部的关闭键、以及将来可能的辅助控件
BUTTON_SKIP = {'search-close'}
# 站点按钮 id → README 里应当出现的说明关键词（任一命中即可）
BUTTON_HINTS = {
    'drawer-toggle': ('导航', '汉堡'),
    'palette-toggle': ('调色盘', '强调色'),
    'search-toggle': ('搜索',),
    'theme-toggle': ('昼夜', '深浅', '深色'),
}


def check_readme_documents_ui(files):
    """站点顶栏按钮必须在 README 手写区里有说明。

    只做**单向**检查：站点有的按钮，README 必须提到。
    找不到按钮定义时**不报错**——那样会让「只改 TARGET_FILES」之类的场景被误伤，
    而且站点结构本来就可能变。真正该拦的是「有按钮、README 没写」。
    新增按钮时若未登记到 BUTTON_HINTS，则提示补登记（防止加按钮时忘了同步检查）。
    """
    if BUILD_SCRIPT not in files or 'README.md' not in files:
        return
    ids = set(BUTTON_IDS_RE.findall(files[BUILD_SCRIPT].decode()))
    ids -= BUTTON_SKIP
    if not ids:
        return
    readme = files['README.md'].decode()
    unknown = sorted(i for i in ids if i not in BUTTON_HINTS)
    if unknown:
        raise ValueError('以下站点按钮未登记到 README 按钮说明的校验表 '
                         f'（BUTTON_HINTS），请补上：' + '、'.join(unknown))
    missing = sorted(
        i for i in ids
        if not any(h in readme for h in BUTTON_HINTS[i])
    )
    if missing:
        raise ValueError(
            '站点顶栏有这些按钮，但 README 的「网页版怎么看」没有介绍：'
            + '、'.join(missing)
            + '。请在 README.md 里补上（按钮表就在「网页版怎么看」那一段）。')


# ── 备考页检查（2026-10-13 用户改定：轻检查，不定形态）────────────────────────
# **备考页没有固定形态**——各课结构本就不同（水课与工程数学不可能一样），钩子不规定骨架。
# 钩子只做两件「事实性」的事，都不涉及文风与结构：
#   ① 考点覆盖：**Walkthrough 里的考点条目，备考页应当都有**——即「Walkthrough 更新后，
#      备考有没有漏掉新考点」。判据取 Walkthrough 的条目关键词，在备考页正文里找。
#      （只提示不拦截见下方 warning 通道；漏考点的信号是「备考过期」，不是「格式错」。）
#   ② 弱保真：备考页里的百分比与「四位年份」型事实，必须能在本课资料（笔记/作业）里找到
#      （防「备考自己编数」——这是「Walkthrough 不严 → 后面全白搭」的信号）。
PREP_STRONG_NUM_RE = re.compile(r'\d+(?:\.\d+)?%|(?:19|20)\d{2}\s*年?')
# Walkthrough 里「一条考点」的形态：以 `- **关键词**：` 或 `- **关键词**（` 开头的列表项
WT_POINT_RE = re.compile(r'^-\s+\*\*(.+?)\*\*', re.M)


def check_exam_prep(files):
    """备考页检查（轻）。文件不存在则跳过（备考是可插拔栏目）。"""
    problems = []
    warnings = []
    for path in sorted(p for p in files if p.endswith('/备考.md') and p.startswith('课程总览/')):
        course = PurePosixPath(path).parts[1]
        text = files[path].decode()
        wt = f'课程总览/{course}/Walkthrough.md'
        if wt not in files:
            problems.append(f'{path}：本课没有 {WALKTHROUGH_NAME}——备考以它为底，先建 Walkthrough')
            continue
        wt_text = files[wt].decode()
        # ① 考点覆盖：Walkthrough 的每条考点关键词，备考正文里应能找到（找不到 → 提示，不拦）
        missing = []
        # 比对时去掉标点/空格（「两类数据来源」与「数据来源分两类」这类同义改写不该误报）
        def _norm(t):
            return re.sub(r'[\s（）()：:，,。.、·—\-]', '', t)
        norm_text = _norm(text)
        for m in WT_POINT_RE.finditer(wt_text):
            kw = m.group(1).strip().rstrip('：:')
            key = re.split(r'[（(]', kw)[0].strip()
            if len(key) < 2:
                continue
            if _norm(key) not in norm_text:
                missing.append(key)
        if missing:
            head = '、'.join(missing[:6])
            tail = '…' if len(missing) > 6 else ''
            warnings.append(f'{path}：Walkthrough 有 {len(missing)} 条考点在备考页里没找到'
                            f'（{head}{tail}）——检查备考是否漏了新考点')
        # ② 弱保真：强特征数字必须能在本课资料里找到
        source_text = ''
        prefix = f'课程总览/{course}/'
        for p, data in files.items():
            if p.startswith(prefix) and p.endswith('.md') and p != path:
                source_text += data.decode()
        for num in sorted(set(PREP_STRONG_NUM_RE.findall(text))):
            token = num.replace(' ', '')
            if token not in source_text.replace(' ', ''):
                problems.append(f'{path}：数字「{num}」在本课笔记/作业里找不到出处'
                                f'（备考不得自己编数）')
    for w in warnings:
        print(f'[备考] {w}')
    if problems:
        raise ValueError('备考页检查未过 —— ' + '；'.join(problems))


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
    # last_updated 是推导字段：先对齐日期再算自动区块——摘要里看到的是最终内容。
    sync_last_updated(files, head_snapshot(), worktree)
    # 维护细则的内容摘要不包含 README 与本文件，先算；README 的摘要包含维护细则，
    # 必须基于“已更新的维护细则”计算，否则推送时两处区块会互相判定为未同步。
    maintenance = render_maintenance(files[MAINT_PATH].decode(), files).encode()
    staged = dict(files)
    staged[MAINT_PATH] = maintenance
    staged['README.md'] = render(staged['README.md'].decode(), staged).encode()
    outputs = {'README.md': staged['README.md'], MAINT_PATH: maintenance}
    validate(staged)
    check_index_sync(staged, head_snapshot())
    if not worktree:
        # 提交时强制「实施一步 → 更新 handoff」；--worktree 只生成文件、不提交，不拦
        check_handoff_freshness(staged, head_snapshot())
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
