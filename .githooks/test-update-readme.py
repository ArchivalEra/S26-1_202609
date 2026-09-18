#!/usr/bin/env python3
"""Exercise commits and pushes exclusively in temporary local repositories."""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
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
        self.readme = self.write('README.md', '# 学期\n\n<!-- AUTO-CATALOG:START -->\n<!-- AUTO-CATALOG:END -->\n')
        self.details = self.write('维护细则.md', '# 维护细则\n\n见[仓库维护条例](./维护条例.md)。\n\n<!-- AUTO-MAINTENANCE:START -->\n<!-- AUTO-MAINTENANCE:END -->\n')
        self.write('维护条例.md', '# 仓库维护条例\n\n原则性规定。\n')
        self.write('课程/index.md', '[工程数学](工程数学/index.md)\n')
        self.course('工程数学')
        self.note = self.write('课程/工程数学/课堂笔记/2026-09-17-test.md', '# 行列式学习\n\n课堂方法。\n')
        self.index = self.write('课程/工程数学/课堂笔记/index.md', '[笔记](2026-09-17-test.md)\n')
        self.original = self.write('课程/工程数学/原始资料/中文 原文.doc', '<html>课堂转写</html>')
        self.write('课程/工程数学/原始资料/index.md', '[原文](中文%20原文.doc)\n')
        self.stage()
        self.git('commit', '-m', '初始化课程')

    def write(self, path, text):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        return target

    def course(self, name):
        self.write(f'课程/{name}/index.md', ''.join(f'[{kind}]({kind}/index.md)\n' for kind in KINDS))
        for kind in KINDS:
            self.write(f'课程/{name}/{kind}/index.md', f'# {kind}\n')

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
        self.stage()
        self.git('commit', '-m', '仅修改正文，无需索引假更新')
        self.assertNotEqual(before, self.readme.read_bytes())
        self.assertIn('%E4%B8%AD%E6%96%87%20', self.readme.read_text())
        self.assertEqual(self.git('status', '--porcelain').stdout, b'')
        self.git('push')

    def test_preserves_unstaged_readme(self):
        self.readme.write_text(self.readme.read_text() + '\n未准备提交。\n')
        before = self.readme.read_bytes()
        self.note.write_text('# 新标题\n')
        self.git('add', '课程')
        result = self.git('commit', '-m', '拒绝', success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('未暂存修改', result.stdout.decode())
        self.assertEqual(before, self.readme.read_bytes())

    def test_uses_staged_content_only(self):
        self.note.write_text('# 暂存标题\n')
        self.git('add', '课程')
        self.note.write_text('# 尚未暂存的标题\n')
        self.git('commit', '-m', '部分暂存')
        self.assertIn('暂存标题', self.readme.read_text())
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
        self.write('课程/工程数学/原始资料/index.md', '# 原始资料\n')
        self.stage()
        self.git('commit', '-m', '删除资料并同步索引')
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
        # 纯正文编辑也要改变状态区块（内容摘要行）。
        self.note.write_text(self.note.read_text() + '\n补充说明。\n')
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
        self.git('add', '课程')
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
        self.write('课程/index.md', '[数学](工程数学/index.md)\n[物理](大学物理/index.md)\n')
        self.write('课程/大学物理/课堂笔记/2026-09-17-test.md', '# 同名不同课程\n')
        self.write('课程/大学物理/课堂笔记/index.md', '[笔记](2026-09-17-test.md)\n')
        self.write('课程/大学物理/教材解析/第二版/第01章-测试.md', '# 章节测试\n')
        self.write('课程/大学物理/教材解析/index.md', '[章节](第二版/第01章-测试.md)\n')
        self.write('课程/大学物理/音频/2026-09-17-上午.md', '# 音频记录测试\n')
        self.write('课程/大学物理/音频/index.md', '[记录](2026-09-17-上午.md)\n')
        self.stage()
        self.git('commit', '-m', '多课程资料')
        self.assertIn('**2** 门课程、**5** 份资料', self.readme.read_text())
        self.remote()
        self.git('push', 'origin', 'main')

    def test_bad_date_and_chapter_rejected(self):
        for name, kind in [('2026-02-30-测试.md', '课堂笔记'), ('第一章.md', '教材解析')]:
            with self.subTest(name=name):
                path = self.write(f'课程/工程数学/{kind}/{name}', '# 测试\n')
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

    def test_move_and_index_links(self):
        moved = self.note.with_name('2026-09-17-移动.md')
        self.note.rename(moved)
        self.stage()
        self.assertNotEqual(self.git('commit', '-m', '旧索引应拒绝', success=False).returncode, 0)
        self.index.write_text('[笔记](2026-09-17-移动.md)\n')
        self.stage()
        self.git('commit', '-m', '修复移动链接')
        self.remote()
        self.git('push', 'origin', 'main')

    def test_push_checks_target_not_worktree(self):
        self.remote()
        self.git('branch', 'good')
        self.note.write_text('# 未同步目录\n')
        self.git('add', '课程')
        self.git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', '故意绕过')
        self.git('branch', 'bad')
        self.git('switch', 'good')
        self.assertNotEqual(self.git('push', 'origin', 'bad', success=False).returncode, 0)
        self.note.write_text('# 工作区未暂存\n')
        self.readme.write_text('# 工作区未暂存且无标记\n')
        self.git('push', 'origin', 'good')


if __name__ == '__main__':
    unittest.main(verbosity=2)
