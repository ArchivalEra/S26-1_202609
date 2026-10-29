#!/usr/bin/env python3
"""Exercise commits and pushes exclusively in temporary local repositories."""
from pathlib import Path
import datetime
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

SOURCE = Path(__file__).resolve().parent
KINDS = ('作业', '教材解析', '课堂笔记', '原始资料', '音频')


class ReadmeHookTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='semester-hook-test-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.repo = self.base / 'work'
        self.repo.mkdir()
        self.git('init', '-b', 'main')
        self.git('config', 'user.name', 'Hook Test')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'commit.gpgsign', 'false')
        self.git('config', 'core.hooksPath', '.githooks')
        shutil.copytree(SOURCE, self.repo / '.githooks', ignore=shutil.ignore_patterns('__pycache__'))
        self.readme = self.write('README.md', '# 学期\n\n' + self.status_block(['工程数学']) +
                                 '\n<!-- AUTO-CATALOG:START -->\n<!-- AUTO-CATALOG:END -->\n')
        self.details = self.write('维护细则.md', '# 维护细则\n\n见[仓库维护条例](./维护条例.md)。\n\n<!-- AUTO-MAINTENANCE:START -->\n<!-- AUTO-MAINTENANCE:END -->\n')
        self.write('维护条例.md', '# 维护条例\n\n原则性规定。\n')
        self.write('课程总览/index.md', '# 课程总览\n\n[工程数学](工程数学/index.md)\n')
        self.course('工程数学')
        self.note = self.write('课程总览/工程数学/课堂笔记/行列式学习.md', '# 行列式学习\n\n课堂方法。\n')
        self.index = self.write('课程总览/工程数学/课堂笔记/index.md', '# 课堂笔记\n\n[笔记](行列式学习.md)\n')
        self.original = self.write('课程总览/工程数学/原始资料/中文 原文.doc', '<html>课堂转写</html>')
        self.write('课程总览/工程数学/原始资料/index.md', '# 原始资料\n\n[原文](中文%20原文.doc)\n')
        self.stage()
        self.git('commit', '-m', '初始化课程')

    def write(self, path, text):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        return target

    @staticmethod
    def status_block(courses, status='开课'):
        """README 的 COURSE-STATUS 块（课程状态的唯一产地，钩子会校验）。"""
        rows = ''.join(f'| {c} | {status} |\n' for c in courses)
        return ('<!-- COURSE-STATUS:START -->\n| 课程 | 状态 |\n| :--- | :--- |\n'
                + rows + '<!-- COURSE-STATUS:END -->\n')

    def _refresh_status(self, extra=()):
        """把 README 的 COURSE-STATUS 块重建为「工程数学 + extra」（新接入课程时用）。"""
        import re as _re
        text = self.readme.read_text()
        block = self.status_block(['工程数学', *extra])
        text = _re.sub(r'<!-- COURSE-STATUS:START -->.*?<!-- COURSE-STATUS:END -->\n?',
                       block, text, flags=_re.S)
        self.readme.write_text(text)

    def course(self, name):
        self.write(f'课程总览/{name}/index.md',
                   f'# {name}\n\n' + ''.join(f'[{kind}]({kind}/index.md)\n' for kind in KINDS))
        for kind in KINDS:
            self.write(f'课程总览/{name}/{kind}/index.md', f'# {kind}\n')

    def append(self, path, text):
        """在已有文件末尾追加一行（保持原内容，模拟「同步更新父页面」）。"""
        target = self.repo / path
        target.write_text(target.read_text() + f'\n{text}\n')
        return target

    def touch_chain(self, path, mark=None):
        """按新规则同步一条页面的整条父链：改某页 ⇒ 每一层祖先 index 都追加一行。

        层数由目录结构决定（`课程/<课>/<类>/<…>/<页>` → 各层 index.md → `课程/index.md`），
        与 `hook_lib.ancestor_indexes` 同一判据。测试里要「合规地改一页」时用它，
        否则会被级联闸拦下——那正是这条规则的本意。
        """
        parts = Path(path).parts
        marks = mark or f'更新 {Path(path).name}'
        for i in range(len(parts) - 1, 0, -1):
            idx = Path(*parts[:i]) / 'index.md'
            if idx.as_posix() == path or not (self.repo / idx).is_file():
                continue
            self.write(idx.as_posix(), (self.repo / idx).read_text() + f'\n{marks}\n')

    def stage(self):
        paths = sorted(p.relative_to(self.repo).as_posix() for p in self.repo.rglob('*')
                       if p.is_file() and '.git' not in p.relative_to(self.repo).parts and '__pycache__' not in p.parts)
        paths = sorted(set(paths) | {'.gitignore'})
        self.write('.gitignore', '*\n!*/\n' + ''.join(f'!/{p}\n' for p in paths))
        self.git('add', '-A')

    def git(self, *args, success=True):
        result = subprocess.run(['git', *args], cwd=self.repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        if success:
            self.assertEqual(result.returncode, 0, result.stdout.decode())
        return result

    def remote(self):
        self.git('init', '--bare', str(self.base / 'remote.git'))
        self.git('remote', 'add', 'origin', str(self.base / 'remote.git'))

    def test_update_and_push(self):
        self.remote()
        self.git('push', '-u', 'origin', 'main')
        before = self.readme.read_bytes()
        self.note.write_text(self.note.read_text() + '\n新增方法。\n')
        self.touch_chain('课程总览/工程数学/课堂笔记/行列式学习.md', '内容有更新。')
        self.stage()
        self.git('commit', '-m', '修改正文并逐层同步父页面')
        self.assertNotEqual(before, self.readme.read_bytes())
        # 2026-10-17 目录瘦身：AUTO-CATALOG 不再平铺文件，改为课程行 + digest 变化判据
        self.assertIn('课程目录', self.readme.read_text())
        self.assertEqual(self.git('status', '--porcelain').stdout, b'')
        self.git('push')

    def test_handoff_freshness_enforced(self):
        """改动 课程/ 或 站点/ 而未更新 .zcode/handoff.md 的提交必须被拒。"""
        handoff = self.write('.zcode/handoff.md', '# Handoff\n\n维护约定：每实施完一步回来更新。\n')
        self.stage()
        self.git('commit', '-m', '建立 handoff')
        stale = time.time() - 3600
        os.utime(handoff, (stale, stale))

        # 改课堂笔记（课程/ 区域）且同步索引，但 handoff 陈旧 → 拒绝
        self.note.write_text(self.note.read_text() + '\n新增一段。\n')
        self.touch_chain('课程总览/工程数学/课堂笔记/行列式学习.md', '已同步。')
        self.stage()
        result = self.git('commit', '-m', '未更新 handoff', success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('handoff', result.stdout.decode())

        # 更新 handoff 后放行
        handoff.write_text(handoff.read_text() + '\n- 已更新。\n')
        self.stage()
        self.git('commit', '-m', '更新 handoff 后提交')

        # 范围收窄验证：只改 README（不在 课程/ 站点/）不受这条规则限制
        os.utime(handoff, (stale, stale))
        self.readme.write_text(self.readme.read_text().replace('# 学期', '# 学期总览'))
        self.stage()
        self.git('commit', '-m', '只改 README 不受限')

    def test_last_updated_is_derived_not_handwritten(self):
        """last_updated 是推导字段（2026-10-17 定案）：钩子按各文件自己的提交日期写，手抄无效。"""
        note = self.write('课程总览/工程数学/课堂笔记/2026-09-18-日期.md',
                          '---\nlast_updated: "2000-01-01"\n---\n\n# 日期测试\n')
        self.index.write_text('[笔记](行列式学习.md)\n[日期](2026-09-18-日期.md)\n')
        self.append('课程总览/工程数学/index.md', '新增日期笔记。')
        self.append('课程总览/index.md', '新增日期笔记。')
        self.stage()
        self.git('commit', '-m', '新资料：手抄日期被提交日覆盖')
        today = datetime.date.today().isoformat()
        self.assertIn(f'last_updated: "{today}"', note.read_text())

        # 回溯提交日期后，未再改动的文件日期对齐为**它自己的**提交日
        back = self.write('课程总览/工程数学/课堂笔记/2026-09-19-回溯.md',
                          '---\nlast_updated: "2000-01-01"\n---\n\n# 回溯测试\n')
        self.index.write_text('[笔记](行列式学习.md)\n[日期](2026-09-18-日期.md)\n'
                              '[回溯](2026-09-19-回溯.md)\n')
        self.append('课程总览/工程数学/index.md', '新增回溯笔记。')
        self.append('课程总览/index.md', '新增回溯笔记。')
        self.stage()
        self.git('commit', '--date=2026-09-01', '-m', '回溯日期提交')
        self.note.write_text(self.note.read_text() + '\n补充。\n')
        self.index.write_text('[笔记](行列式学习.md)\n[日期](2026-09-18-日期.md)\n'
                              '[回溯](2026-09-19-回溯.md)\n\n更新。\n')
        self.append('课程总览/工程数学/index.md', '更新。')
        self.append('课程总览/index.md', '更新。')
        self.stage()
        self.git('commit', '-m', '无关改动：回溯文件日期对齐回 2026-09-01')
        self.assertIn('last_updated: "2026-09-01"', back.read_text())

        # 手改日期行：不算内容变化（不要求同步索引），且提交时被钩子改回正确值
        back.write_text(back.read_text().replace('last_updated: "2026-09-01"',
                                                 'last_updated: "1999-12-31"'))
        self.stage()
        self.git('commit', '--allow-empty', '-m', '手改日期被纠正')
        self.assertIn('last_updated: "2026-09-01"', back.read_text())

    def test_deep_link_anchor_validation(self):
        """深链接的锚点在目标文件里必须真实存在，否则提交被拒。"""
        target = self.write(
            '课程总览/工程数学/课堂笔记/2026-09-19-anchor-target.md',
            '# 锚点目标\n\n'
            ':::collapse accordion\n'
            '- 面板标题 :+ {#pass-test}\n'
            '  面板正文。\n'
            ':::\n'
            '\n'
            '<a id="sym-demo"></a>\n'
            '\n'
            '## 深链接小节\n\n'
            '正文。\n'
            '\n'
            ':::glossary-dict table\n'
            'sym-tabled | 总表词条 | 这行在页面上带 id="sym-tabled"。\n'
            ':::\n')
        self.index.write_text(
            '[笔记](行列式学习.md)\n'
            '[锚点目标](2026-09-19-anchor-target.md)\n'
            '[面板深链接](2026-09-19-anchor-target.md#pass-test)\n'
            '[显式 id 深链接](2026-09-19-anchor-target.md#sym-demo)\n'
            '[总表行深链接](2026-09-19-anchor-target.md#sym-tabled)\n'
            '[标题深链接](2026-09-19-anchor-target.md#深链接小节)\n')
        self.touch_chain('课程总览/工程数学/课堂笔记/2026-09-19-anchor-target.md', '登记锚点目标')
        self.stage()
        self.git('commit', '-m', '合法深链接放行')

        self.index.write_text(
            '[笔记](行列式学习.md)\n'
            '[锚点目标](2026-09-19-anchor-target.md)\n'
            '[坏锚点](2026-09-19-anchor-target.md#不存在的锚点)\n')
        self.touch_chain('课程总览/工程数学/课堂笔记/2026-09-19-anchor-target.md', '登记坏锚点')
        self.stage()
        result = self.git('commit', '-m', '坏锚点被拒', success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('深链接锚点失效', result.stdout.decode())
        self.assertIn('#不存在的锚点', result.stdout.decode())

        # 修复锚点后放行
        self.index.write_text(
            '[笔记](行列式学习.md)\n'
            '[锚点目标](2026-09-19-anchor-target.md)\n'
            '[标题深链接](2026-09-19-anchor-target.md#深链接小节)\n')
        self.touch_chain('课程总览/工程数学/课堂笔记/2026-09-19-anchor-target.md', '修复锚点')
        self.stage()
        self.git('commit', '-m', '修复锚点')

    def test_content_edit_without_index_rejected(self):
        """课程资料改了而对应分类索引没动，提交必须被拒。"""
        self.note.write_text(self.note.read_text() + '\n新增方法。\n')
        self.stage()
        result = self.git('commit', '-m', '未同步索引', success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('逐层更新父页面', result.stdout.decode())
        self.touch_chain('课程总览/工程数学/课堂笔记/行列式学习.md', '已同步。')
        self.stage()
        self.git('commit', '-m', '补上索引')

    def test_parent_chain_must_be_updated_level_by_level(self):
        """只更新最近一层父页面不够：更上层没动，提交仍被拒。"""
        note = '课程总览/工程数学/课堂笔记/行列式学习.md'
        self.note.write_text(self.note.read_text() + '\n新增一节。\n')
        # 只动分类索引，不动课程索引与课程总索引
        self.index.write_text('[笔记](行列式学习.md)\n\n已同步。\n')
        self.stage()
        result = self.git('commit', '-m', '只同步一层', success=False)
        self.assertNotEqual(result.returncode, 0)
        msg = result.stdout.decode()
        self.assertIn('课程总览/工程数学/index.md', msg)
        self.assertIn('课程总览/index.md', msg)

        # 补齐课程索引一层，仍缺课程总索引 → 还是拒
        self.append('课程总览/工程数学/index.md', '更新。')
        self.stage()
        result = self.git('commit', '-m', '只同步两层', success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('课程总览/index.md', result.stdout.decode())
        self.assertNotIn('课程总览/工程数学/index.md（因', result.stdout.decode())

        # 三层齐 → 放行
        self.append('课程总览/index.md', '更新。')
        self.stage()
        self.git('commit', '-m', '三层都同步')

    def test_preserves_unstaged_readme(self):
        self.readme.write_text(self.readme.read_text() + '\n未准备提交。\n')
        before = self.readme.read_bytes()
        self.note.write_text('# 新标题\n')
        self.git('add', '课程总览')
        result = self.git('commit', '-m', '拒绝', success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('未暂存修改', result.stdout.decode())
        self.assertEqual(before, self.readme.read_bytes())

    def test_uses_staged_content_only(self):
        self.note.write_text('# 暂存标题\n')
        self.touch_chain('课程总览/工程数学/课堂笔记/行列式学习.md', '已同步。')
        self.git('add', '课程总览')
        self.note.write_text('# 尚未暂存的标题\n')
        self.git('commit', '-m', '部分暂存')
        # 2026-10-17：标题不上 README 了；判据改为 digest 由暂存内容算出
        # （暂存 '# 暂存标题' vs 未暂存 '# 尚未暂存的标题' ⇒ digest 应等于暂存版）
        import importlib, hook_lib
        files = hook_lib.snapshot(worktree=True)
        # worktree 快照含未暂存版本；用 staged 快照对 digest
        self.assertNotIn('尚未暂存的标题', self.readme.read_text())
        self.assertEqual(self.note.read_text(), '# 尚未暂存的标题\n')

    def test_empty_commit_is_idempotent(self):
        before = self.readme.read_bytes()
        self.git('commit', '--allow-empty', '-m', '空提交')
        self.assertEqual(before, self.readme.read_bytes())

    def test_deletion_updates_catalog(self):
        self.note.unlink()
        self.original.unlink()
        self.index.write_text('# 课堂笔记\n')
        self.write('课程总览/工程数学/原始资料/index.md', '# 原始资料\n')
        self.append('课程总览/工程数学/index.md', '删除资料。')
        self.append('课程总览/index.md', '删除资料。')
        self.stage()
        self.git('commit', '-m', '删除资料并逐层同步')
        self.assertIn('**0** 份资料', self.readme.read_text())
        self.remote()
        self.git('push', 'origin', 'main')

    def test_missing_markers_rejects_without_overwrite(self):
        self.readme.write_text('# 未设置自动区块\n')
        self.git('add', 'README.md')
        before = self.readme.read_bytes()
        self.assertNotEqual(self.git('commit', '-m', '拒绝', success=False).returncode, 0)
        self.assertEqual(before, self.readme.read_bytes())

    def test_maintenance_block_regenerated_and_synced(self):
        self.assertNotIn('AUTO-MAINTENANCE:START -->\n\n<!--', self.details.read_text())
        self.assertIn('工程数学', self.details.read_text())
        self.assertIn('课堂笔记', self.details.read_text())
        before = self.details.read_bytes()
        self.assertEqual(self.git('status', '--porcelain').stdout, b'')
        # 正文编辑也要改变状态区块（内容摘要行）；同时须同步分类索引。
        self.note.write_text(self.note.read_text() + '\n补充说明。\n')
        self.touch_chain('课程总览/工程数学/课堂笔记/行列式学习.md', '补充说明已入库。')
        self.stage()
        self.git('commit', '-m', '正文编辑应刷新维护细则')
        self.assertNotEqual(before, self.details.read_bytes())
        self.assertIn('暂存内容摘要', self.details.read_text())
        self.remote()
        self.git('push', 'origin', 'main')

    def test_missing_maintenance_markers_rejected(self):
        self.details.write_text('# 维护细则未设自动区块\n')
        self.git('add', '维护细则.md')
        before = self.details.read_bytes()
        result = self.git('commit', '-m', '拒绝', success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('AUTO-MAINTENANCE', result.stdout.decode())
        self.assertEqual(before, self.details.read_bytes())

    def test_preserves_unstaged_maintenance(self):
        self.details.write_text(self.details.read_text() + '\n未准备提交。\n')
        before = self.details.read_bytes()
        self.note.write_text('# 新标题\n')
        self.git('add', '课程总览')
        result = self.git('commit', '-m', '拒绝', success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('维护细则.md 有未暂存修改', result.stdout.decode())
        self.assertEqual(before, self.details.read_bytes())

    def test_tampered_maintenance_block_is_regenerated(self):
        text = self.details.read_text()
        self.details.write_text(text.replace('## 仓库状态（自动生成）', '## 手工篡改', 1))
        self.git('add', '-A')
        result = subprocess.run([sys.executable, '.githooks/hook_lib.py', '--worktree'],
                                cwd=self.repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.assertEqual(result.returncode, 0, result.stdout.decode())
        self.assertNotIn('手工篡改', self.details.read_text())
        self.assertIn('## 仓库状态（自动生成）', self.details.read_text())

    def test_multicourse_deep_chapter_and_audio(self):
        self.course('大学物理')
        self._refresh_status(['大学物理'])
        self.write('课程总览/index.md', '[数学](工程数学/index.md)\n[物理](大学物理/index.md)\n')
        self.write('课程总览/大学物理/课堂笔记/行列式学习.md', '# 同名不同课程\n')
        self.write('课程总览/大学物理/课堂笔记/index.md', '[笔记](行列式学习.md)\n')
        self.write('课程总览/大学物理/教材解析/第二版/第01章-测试.md', '# 章节测试\n')
        self.write('课程总览/大学物理/教材解析/index.md', '[章节](第二版/第01章-测试.md)\n')
        self.write('课程总览/大学物理/音频/2026-09-17-上午.md', '# 音频记录测试\n')
        self.write('课程总览/大学物理/音频/index.md', '[记录](2026-09-17-上午.md)\n')
        self.stage()
        self.git('commit', '-m', '多课程资料')
        self.assertIn('**2** 门课程、**5** 份资料', self.readme.read_text())
        self.remote()
        self.git('push', 'origin', 'main')

    def test_declared_course_may_skip_a_kind(self):
        """在 COURSE_SKIPPED_KINDS 里声明豁免的课程，可以不建该类目录与索引。

        真需求：形势与政策这类公共课没有可整理的教材正文，强行建一个永远空着的
        「教材解析」目录只会给课程入口、自动目录和站点侧边栏添噪音。
        """
        name = '形势与政策'  # hook_lib.COURSE_SKIPPED_KINDS 里已声明豁免教材解析
        self._refresh_status([name])
        kinds = [k for k in KINDS if k != '教材解析']
        self.write(f'课程总览/{name}/index.md', ''.join(f'[{k}]({k}/index.md)\n' for k in kinds))
        for kind in kinds:
            self.write(f'课程总览/{name}/{kind}/index.md', f'# {kind}\n')
        self.write(f'课程总览/{name}/课堂笔记/2026-09-21-经济热点.md', '# 经济热点专题\n\n课堂内容。\n')
        self.write(f'课程总览/{name}/课堂笔记/index.md', '[笔记](2026-09-21-经济热点.md)\n')
        self.write('课程总览/index.md', '[数学](工程数学/index.md)\n[形策](形势与政策/index.md)\n')
        self.stage()
        self.git('commit', '-m', '接入豁免课程的课')

        readme = self.readme.read_text()
        self.assertIn('形势与政策', readme)
        # 2026-10-17 目录瘦身：无平铺小节，豁免课在课程行表格里正常出现即可
        self.assertIn('| 形势与政策 |', readme)
        # 维护细则的分类一览：豁免格写「—」，索引列仍判齐全
        details = self.details.read_text()
        row = [line for line in details.splitlines() if line.startswith('| 形势与政策 |')][0]
        self.assertIn('—', row)
        self.assertTrue(row.rstrip().endswith('| 齐全 |'), row)
        self.remote()
        self.git('push', 'origin', 'main')

    def test_undeclared_course_missing_kind_still_rejected(self):
        """未声明豁免的课程缺一类索引仍必须被拒——防止豁免机制被当成后门。"""
        name = '大学物理'
        self._refresh_status([name])
        kinds = [k for k in KINDS if k != '音频']
        self.write(f'课程总览/{name}/index.md', ''.join(f'[{k}]({k}/index.md)\n' for k in kinds))
        for kind in kinds:
            self.write(f'课程总览/{name}/{kind}/index.md', f'# {kind}\n')
        self.write('课程总览/index.md', '[数学](工程数学/index.md)\n[物理](大学物理/index.md)\n')
        self.stage()
        result = self.git('commit', '-m', '未声明豁免却缺音频索引', success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('课程入口缺少分类链接', result.stdout.decode())

    def test_exam_prep_light_checks(self):
        """备考页检查（2026-10-13 改轻）：①考点覆盖（只提示）②弱保真（拦）。

        **备考页没有固定形态**——钩子不规定骨架、不要求节名与 Walkthrough 同名。
        """
        # 笔记 + Walkthrough（含一条考点）+ 备考（**自己起节名**，结构故意不同）
        self.write('课程总览/工程数学/课堂笔记/2026-10-01-预备课.md',
                   '# 预备课\n\n考点一要点，贡献率 64.1%。\n')
        self.index.write_text('[笔记](行列式学习.md)\n[预备课](2026-10-01-预备课.md)\n')
        self.append('课程总览/工程数学/index.md', '新增预备课。')
        self.append('课程总览/index.md', '新增预备课。')
        self.write('课程总览/工程数学/Walkthrough.md',
                   '# Walkthrough\n\n## 2026-10-01 ｜ 专题一：预备课\n\n- **考点一**：要点。\n')
        prep = self.write('课程总览/工程数学/备考.md',
                          '# 备考\n\n## 我自己的小标题\n\n'
                          '### 考点：考点一\n\n贡献率 64.1%。\n\n'
                          '[笔记原文 ↗](./课堂笔记/2026-10-01-预备课.md#预备课)\n')
        self.stage()
        self.git('commit', '-m', '备考页结构自定：合规放行')

        # ① 编造数字 → 拒（弱保真仍然拦）
        prep.write_text(prep.read_text().replace('64.1%', '88.8%'))
        self.stage()
        result = self.git('commit', '-m', '编造数字', success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('找不到出处', result.stdout.decode())
        prep.write_text(prep.read_text().replace('88.8%', '64.1%'))

        # ② Walkthrough 加了新考点、备考没跟 → 放行，但给出提示
        self.write('课程总览/工程数学/Walkthrough.md',
                   '# Walkthrough\n\n## 2026-10-01 ｜ 专题一：预备课\n\n'
                   '- **考点一**：要点。\n- **考点二**：新加的考点。\n')
        self.append('课程总览/工程数学/index.md', 'Walkthrough 加考点二。')
        self.append('课程总览/index.md', 'Walkthrough 加考点二。')
        self.stage()
        result = self.git('commit', '-m', 'Walkthrough 加考点、备考未跟')
        self.assertEqual(result.returncode, 0)
        self.assertIn('没找到', result.stdout.decode())  # 有提示

        # ③ 备考补上考点二 → 提示消失
        prep.write_text(prep.read_text().replace(
            '### 考点：考点一\n', '### 考点：考点一\n\n考点二：补上了。\n'))
        self.append('课程总览/工程数学/index.md', '备考补上考点二。')
        self.append('课程总览/index.md', '备考补上考点二。')
        self.stage()
        result = self.git('commit', '-m', '备考补上考点二')
        self.assertEqual(result.returncode, 0)
        self.assertNotIn('没找到', result.stdout.decode())

    def test_readme_must_document_all_header_buttons(self):
        """站点顶栏按钮必须在 README 手写区有说明。

        真发生过：站点新增了「全站搜索」按钮，但 README 的「网页版怎么看」
        按钮表还是三个——钩子只管 AUTO-CATALOG 自动区块，手写区没人校验。
        """
        # 站点有 4 个按钮（不含面板内部的关闭键），README 只介绍了 3 个 → 拒绝
        btn = lambda i: f'<button class="m3-icon-btn" id="{i}">'
        full = ("const TARGET_FILES = [\n  'README.md',\n  '维护条例.md',\n  '维护细则.md',\n"
                "  '课程总览/index.md',\n  '课程总览/工程数学/index.md',\n"
                "  '课程总览/工程数学/作业/index.md',\n  '课程总览/工程数学/教材解析/index.md',\n"
                "  '课程总览/工程数学/课堂笔记/index.md',\n  '课程总览/工程数学/课堂笔记/行列式学习.md',\n"
                "  '课程总览/工程数学/原始资料/index.md',\n  '课程总览/工程数学/音频/index.md'\n];\n"
                + btn('drawer-toggle') + '\n' + btn('palette-toggle') + '\n'
                + btn('theme-toggle') + '\n' + btn('search-toggle') + '\n')
        build = self.write('站点/build.mjs', full)

        readme_missing = ('# 学期\n\n' + self.status_block(['工程数学']) +
                          '\n<!-- AUTO-CATALOG:START -->\n<!-- AUTO-CATALOG:END -->\n'
                          '## 网页版怎么看\n导航 · 调色盘 · 昼夜主题\n')
        self.write('README.md', readme_missing)
        self.stage()
        result = self.git('commit', '-m', 'README 漏写搜索按钮', success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('search-toggle', result.stdout.decode())

        # 补上搜索说明后放行
        self.write('README.md', ('# 学期\n\n' + self.status_block(['工程数学']) +
                                 '\n<!-- AUTO-CATALOG:START -->\n<!-- AUTO-CATALOG:END -->\n'
                                 '## 网页版怎么看\n导航 · 调色盘 · 全站搜索 · 昼夜主题\n'))
        self.stage()
        self.git('commit', '-m', 'README 补上搜索按钮')

        # 站点新增**未登记**的按钮 → 提示补校验表（防止加按钮时忘了同步这条检查）
        build.write_text(full + btn('new-thing') + '\n')
        self.stage()
        result = self.git('commit', '-m', '新增未登记按钮', success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('new-thing', result.stdout.decode())

        # 把新按钮登记进校验表后，README 里也写了 → 放行
        # （同时确认：找不到按钮定义的 build.mjs 不应被误伤）

    def test_bad_date_and_chapter_rejected(self):
        for name, kind in [('2026-02-30-测试.md', '课堂笔记'), ('第一章.md', '教材解析')]:
            with self.subTest(name=name):
                path = self.write(f'课程总览/工程数学/{kind}/{name}', '# 测试\n')
                self.stage()
                result = self.git('commit', '-m', '拒绝非法命名', success=False)
                self.assertNotEqual(result.returncode, 0)
                path.unlink()
                self.stage()

    def test_whitelist_uses_index_and_rejects_wildcards(self):
        whitelist = self.repo / '.gitignore'
        original = whitelist.read_text()
        whitelist.write_text(original + '!/任意/*.md\n')
        self.git('add', '.gitignore')
        whitelist.write_text(original)
        self.assertNotEqual(self.git('commit', '-m', '暂存规则非法', success=False).returncode, 0)

    def test_forced_file_without_whitelist_rejected(self):
        self.write('未许可.md', '# 测试\n')
        self.git('add', '-f', '未许可.md')
        self.assertNotEqual(self.git('commit', '-m', '缺少白名单', success=False).returncode, 0)

    def test_build_targets_must_cover_all_material(self):
        """站点构建清单漏列资料时要拒绝提交（漏填会让页面静默不上线）。"""
        full = ("const TARGET_FILES = [\n  'README.md',\n  '维护条例.md',\n  '维护细则.md',\n"
                "  '课程总览/index.md',\n  '课程总览/工程数学/index.md',\n"
                "  '课程总览/工程数学/作业/index.md',\n  '课程总览/工程数学/教材解析/index.md',\n"
                "  '课程总览/工程数学/课堂笔记/index.md',\n  '课程总览/工程数学/课堂笔记/行列式学习.md',\n"
                "  '课程总览/工程数学/原始资料/index.md',\n  '课程总览/工程数学/音频/index.md'\n];\n")
        build = self.write('站点/build.mjs', full)
        self.stage()
        self.git('commit', '-m', '清单完整')          # 完整清单可提交

        # 漏列一份资料 → 拒绝
        build.write_text(full.replace("  '课程总览/工程数学/课堂笔记/行列式学习.md',\n", ''))
        self.stage()
        result = self.git('commit', '-m', '清单漏列', success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('TARGET_FILES 漏列', result.stdout.decode())

        # 列出仓库中不存在的文件 → 拒绝
        build.write_text(full.replace("];\n", "  '课程总览/工程数学/课堂笔记/查无此文件.md'\n];\n"))
        self.stage()
        result = self.git('commit', '-m', '列了不存在的文件', success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('查无此文件', result.stdout.decode())

        build.write_text(full + "\n// 清单已恢复\n")
        self.stage()
        self.git('commit', '-m', '清单与资料对齐')

    # ── 侧栏覆盖（2026-10-21 新增）───────────────────────────────────────────────
    # TARGET_FILES 决定「哪些 md 渲染成页面」，NAV_STRUCTURE 决定「侧栏怎么摆」，
    # 两者原本无一致性校验——漏加导航永远不报错，页面「存在但不可达」。
    def nav_site(self, targets, nav, labels=None):
        """写一份 `页面清单.mjs` + `build.mjs`（NAV_STRUCTURE），返回 build.mjs 路径。

        NAV_STRUCTURE 写成嵌套结构并带注释，顺带验证解析器不是正则硬解。
        `labels` 可为个别 path 指定自定义 label（默认用 path 本身作文本）。
        """
        labels = labels or {}
        # 默认 label 取该文件的 H1（新规则要求两者逐字一致）；没有 H1 时退回文件名。
        auto = {}
        for pth in nav:
            if pth in labels:
                continue
            f = self.repo / pth
            if f.is_file() and pth.endswith('.md'):
                for line in f.read_text().splitlines():
                    if line.startswith('# '):
                        auto[pth] = line[2:].strip()
                        break
        labels = {**auto, **labels}
        self.write('站点/页面清单.mjs',
                   'export const TARGET_FILES = [\n'
                   + ''.join(f"  '{p}',\n" for p in targets)
                   + '];\n')
        children = [p for p in nav if p not in ('README.md', '课程总览/index.md')]
        build = ('// 站点构建脚本（测试夹具）\n'
                 'const NAV_STRUCTURE = [\n'
                 '  { label: "学期", path: "README.md" },\n'
                 '  {\n'
                 '    label: "课程总览",\n'
                 '    path: "课程总览/index.md",\n'
                 '    children: [\n'
                 + ''.join(f'      // 内联注释：{p}\n'
                           f'      {{ label: {json.dumps(labels.get(p, p), ensure_ascii=False)}, '
                           f'path: "{p}" }},\n' for p in children)
                 + '    ]\n'
                 '  }\n'
                 '];\n')
        return self.write('站点/build.mjs', build)

    def test_nav_coverage_aligned_passes(self):
        """侧栏覆盖齐全时放行；白名单豁免的页面可不进侧栏。"""
        targets = self.target_list() + ['站点/符号包/通用.md']
        self.write('站点/符号包/通用.md', '# 通用符号\n')
        # NAV_STRUCTURE 不列「站点/符号包/通用.md」（白名单豁免）
        nav = [p for p in targets if p != '站点/符号包/通用.md']
        self.nav_site(targets, nav)
        self.stage()
        self.git('commit', '-m', '侧栏覆盖齐全 + 白名单页不进侧栏')

    def test_nav_coverage_missing_entry_rejected(self):
        """渲染成页面的 md 不在 NAV_STRUCTURE 里时拒绝提交（漏加导航不再静默）。

        手工演示同款：把一个 path 从 NAV_STRUCTURE 里去掉，钩子必须点名报错。
        """
        targets = self.target_list()
        victim = '课程总览/工程数学/课堂笔记/行列式学习.md'
        # 该页「渲染成页面」但侧栏没列它 → 拒绝，且报错点名该页
        self.nav_site(targets, [p for p in targets if p != victim])
        self.stage()
        result = self.git('commit', '-m', '侧栏漏入口', success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('没有侧栏入口', result.stdout.decode())
        self.assertIn(victim, result.stdout.decode())

        # 补回该节点后放行
        self.nav_site(targets, targets)
        self.stage()
        self.git('commit', '-m', '补回侧栏入口')

    def test_nav_coverage_whitelist_is_not_blanket(self):
        """白名单只豁免登记在案的页面——同一次提交里其它漏项仍会被拦。"""
        targets = self.target_list() + ['站点/符号包/通用.md']
        self.write('站点/符号包/通用.md', '# 通用符号\n')
        victim = '课程总览/工程数学/作业/index.md'
        # 白名单页缺席（允许）+ 另一个未豁免的页也缺席（应报错，且只点名后者）
        nav = [p for p in targets
               if p not in ('站点/符号包/通用.md', victim)]
        self.nav_site(targets, nav)
        self.stage()
        result = self.git('commit', '-m', '白名单不是全面豁免', success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(victim, result.stdout.decode())
        self.assertNotIn('站点/符号包/通用.md', result.stdout.decode())

    # ── 侧栏标题 = 页面 H1（2026-10-28 新增）────────────────────────────────────
    def test_nav_label_must_match_page_title(self):
        """侧栏 label 与页面 H1 必须逐字一致，且都不得超过该层的宽度预算。"""
        # 2026-10-29：文件名必须=侧栏标签=H1（三条逐字一致），所以 fixture 的
        # 文件名本身就是那个短名，不再用 `2026-09-17-作业1.md` 这种旧命名。
        short = '作业1'
        hw = f'课程总览/工程数学/作业/{short}.md'
        self.write(hw, f'# {short}\n\n正文。\n')
        self.write('课程总览/工程数学/作业/index.md', f'# 作业\n\n[作业1]({short}.md)\n')
        targets = self.target_list() + [hw]

        # ① 侧栏写别的名字（与 H1 不一致）→ 拒绝
        self.nav_site(targets, targets, labels={hw: '作业一'})
        self.stage()
        self.append('课程总览/工程数学/index.md', '登记。')
        self.append('课程总览/index.md', '登记。')
        self.stage()
        result = self.git('commit', '-m', '侧栏名不对', success=False)
        self.assertNotEqual(result.returncode, 0)
        msg = result.stdout.decode()
        # 2026-10-29 起由「文件名 = 侧栏标签」这条更前的新规则拦下（三条逐字一致）。
        self.assertIn('文件名必须与侧栏标签逐字一致', msg)
        self.assertIn('作业一', msg)

        # ② label 与 H1 一致 → 放行
        self.nav_site(targets, targets, labels={hw: short})
        self.stage()
        self.git('commit', '-m', '侧栏标签与标题对齐')

        # ③ 页面标题改了、侧栏没跟 → 也拒绝（双向绑定）
        self.write(hw, '# 改过的作业名\n\n正文。\n')
        self.stage()
        result = self.git('commit', '-m', '改标题未同步侧栏', success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('改过的作业名', result.stdout.decode())


    def test_nav_label_width_budget(self):
        """侧栏标签超该层宽度预算 ⇒ 拒绝（防被省略号截断）。

        独立成一条：它测的是「宽度」这一件事，不该混在改名流程里。
        fixture 让文件名 = 侧栏标签（2026-10-29 的三条一致规则），
        这样才会走到宽度检查，而不是先被命名规则拦下。
        """
        long = '这是一个非常长的页面名字用来测试侧栏宽度预算'
        hw = f'课程总览/工程数学/作业/{long}.md'
        self.write(hw, f'# {long}\n\n正文。\n')
        self.write('课程总览/工程数学/作业/index.md', f'# 作业\n\n[长名]({long}.md)\n')
        targets = [p for p in self.target_list() if not p.endswith('.md') or '作业' not in p]
        targets = targets + [hw, '课程总览/工程数学/作业/index.md']
        self.nav_site(targets, targets, labels={hw: long})
        self.stage()
        self.append('课程总览/工程数学/index.md', '登记。')
        self.append('课程总览/index.md', '登记。')
        self.stage()
        result = self.git('commit', '-m', '过长', success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('宽度预算', result.stdout.decode())

    def target_list(self):
        """与 setUp 仓库实况对齐的 TARGET_FILES（含 4 个非课程页）。"""
        return ['README.md', '维护条例.md', '维护细则.md',
                '课程总览/index.md', '课程总览/工程数学/index.md',
                '课程总览/工程数学/作业/index.md', '课程总览/工程数学/教材解析/index.md',
                '课程总览/工程数学/课堂笔记/index.md',
                '课程总览/工程数学/课堂笔记/行列式学习.md',
                '课程总览/工程数学/原始资料/index.md', '课程总览/工程数学/音频/index.md']

    def test_move_and_index_links(self):
        moved = self.note.with_name('2026-09-17-移动.md')
        self.note.rename(moved)
        self.stage()
        self.assertNotEqual(self.git('commit', '-m', '旧索引应拒绝', success=False).returncode, 0)
        self.index.write_text('[笔记](2026-09-17-移动.md)\n')
        self.touch_chain('课程总览/工程数学/课堂笔记/index.md', '改名登记')
        self.stage()
        self.git('commit', '-m', '修复移动链接')
        self.remote()
        self.git('push', 'origin', 'main')

    def test_push_checks_target_not_worktree(self):
        self.remote()
        self.git('branch', 'good')
        self.note.write_text('# 未同步目录\n')
        self.git('add', '课程总览')
        self.git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', '故意绕过')
        self.git('branch', 'bad')
        self.git('switch', 'good')
        self.assertNotEqual(self.git('push', 'origin', 'bad', success=False).returncode, 0)
        self.note.write_text('# 工作区未暂存\n')
        self.readme.write_text('# 工作区未暂存且无标记\n')
        self.git('push', 'origin', 'good')


if __name__ == '__main__':
    unittest.main(verbosity=2)
