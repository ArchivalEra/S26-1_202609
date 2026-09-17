#!/usr/bin/env python3
"""Run real commits and local pushes without touching the working repository."""

from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parent


class ReadmeHookTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='math-readme-test-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.repo = self.base / 'work'
        self.repo.mkdir()
        self.git('init', '-b', 'main')
        self.git('config', 'user.name', 'Hook Test')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'core.hooksPath', '.githooks')
        shutil.copytree(SOURCE, self.repo / '.githooks')
        self.readme = self.repo / 'README.md'
        self.readme.write_text('# 工程数学\n\n<!-- AUTO-CATALOG:START -->\n<!-- AUTO-CATALOG:END -->\n')
        self.note = self.repo / 'knowledge/linear-algebra/2026-09-17-test.md'
        self.note.parent.mkdir(parents=True)
        self.note.write_text('# 行列式学习\n\n课堂方法。\n')
        self.index = self.repo / 'knowledge/index.md'
        self.index.write_text('[行列式](linear-algebra/2026-09-17-test.md)\n')
        self.original = self.repo / 'Original/中文 原文.doc'
        self.original.parent.mkdir()
        self.original.write_text('<html>课堂转写</html>')
        self.git('add', '.')
        self.git('commit', '-m', '初始化中文课时')

    def git(self, *args, success=True):
        result = subprocess.run(['git', *args], cwd=self.repo,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        if success:
            self.assertEqual(result.returncode, 0, result.stdout.decode())
        return result

    def test_update_and_push(self):
        self.git('init', '--bare', str(self.base / 'remote.git'))
        self.git('remote', 'add', 'origin', str(self.base / 'remote.git'))
        self.git('push', '-u', 'origin', 'main')
        before = self.readme.read_bytes()
        self.note.write_text(self.note.read_text() + '\n新增方法。\n')
        self.index.write_text(self.index.read_text() + '\n方法已更新。\n')
        self.git('add', '.')
        self.git('commit', '-m', '补充方法')
        self.assertNotEqual(before, self.readme.read_bytes())
        self.assertIn('行列式学习', self.readme.read_text())
        self.assertIn('%E4%B8%AD%E6%96%87%20', self.readme.read_text())
        self.assertEqual(self.git('status', '--porcelain').stdout, b'')
        self.git('push')

    def test_preserves_unstaged_readme(self):
        self.readme.write_text(self.readme.read_text() + '\n未准备提交的内容。\n')
        before = self.readme.read_bytes()
        self.note.write_text('# 新标题\n')
        self.git('add', 'knowledge')
        result = self.git('commit', '-m', '应被拒绝', success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('未暂存修改', result.stdout.decode())
        self.assertEqual(before, self.readme.read_bytes())

    def test_uses_staged_content_only(self):
        self.note.write_text('# 暂存标题\n')
        self.git('add', 'knowledge')
        self.note.write_text('# 尚未暂存的标题\n')
        self.git('commit', '-m', '部分暂存')
        self.assertIn('暂存标题', self.readme.read_text())
        self.assertNotIn('尚未暂存的标题', self.readme.read_text())
        self.assertEqual(self.note.read_text(), '# 尚未暂存的标题\n')

    def test_empty_commit_is_idempotent(self):
        before = self.readme.read_bytes()
        self.git('commit', '--allow-empty', '-m', '空提交')
        self.assertEqual(before, self.readme.read_bytes())
        self.assertEqual(self.git('status', '--porcelain').stdout, b'')

    def test_deletion_updates_catalog(self):
        self.git('rm', str(self.note.relative_to(self.repo)))
        self.git('rm', str(self.original.relative_to(self.repo)))
        self.git('commit', '-m', '移除测试资料')
        self.assertNotIn('行列式学习', self.readme.read_text())
        self.assertIn('**0** 篇笔记、**0** 份原始资料', self.readme.read_text())

    def test_missing_markers_rejects_without_overwrite(self):
        self.readme.write_text('# 未设置自动区块\n')
        self.git('add', 'README.md')
        before = self.readme.read_bytes()
        result = self.git('commit', '-m', '应被拒绝', success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(before, self.readme.read_bytes())


if __name__ == '__main__':
    unittest.main(verbosity=2)
