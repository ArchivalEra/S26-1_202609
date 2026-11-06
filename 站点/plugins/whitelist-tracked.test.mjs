// whitelist-tracked.test.mjs —— 白名单声明的文件必须真的在仓库里（2026-11-06 实弹）。
//
// ## 病因（CI 直接炸，本地全绿）
//
// 本仓 `.gitignore` 是「`*` → `!*/` → 逐文件 `!/完整路径`」的精确白名单。
// 白名单只是**解除忽略**，不等于**已入库**——还要 `git add`。
//
// 2026-11-06 实测：`站点/plugins/static-release.mjs` 白名单写了、却忘了 `git add`。
// 本地构建一切正常（文件就在磁盘上），CI 克隆下来找不到它，`build.mjs` 第 511 行
// `readFileSync` 直接 ENOENT，14 秒后 CI 红。
//
// ## 判据
//
// 遍历 `.gitignore` 里所有 `!/...` 白名单行（且是**具体文件**、非目录）：
// 该路径要么被 `git ls-files` 跟踪，要么是明确的「白名单但永不入库」例外
// （转写原件：隐私规则，只允许存在磁盘上、供链接检查看见）。
//
// 例外名单写在下面 `ALLOWED_UNTRACKED` 里，每一条都要带理由。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');

/** 白名单里声明了、但**故意**不入库的路径模式（每条都要理由）。 */
const ALLOWED_UNTRACKED = [
  // 课堂转写原件：含点名与个人信息，隐私规则要求「只存 study/课程总览 磁盘上，永不 git add」。
  // 白名单声明它们只是为了让 `git ls-files --others --exclude-standard` 能看见（链接检查要用）。
  /\/原始资料\/[^/]*原文\.(txt|doc|docx)$/,
  // 同理：`.zcode/` 一律不推送，只落盘。
  /^\.zcode\//,
];

test('白名单里声明的文件必须已入库（否则 CI 克隆后缺失）', () => {
  const gi = readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  // ⚠️ 必须 `-z` + `core.quotepath=false`：默认 git 会把中文路径转义成
  // `"\345\267\245..."` 带引号形式，与白名单里的原文永远对不上——
  // 那样这个测试会把 500+ 个已跟踪文件全报成「未入库」（实测踩过）。
  const tracked = new Set(
    execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-z'],
      { cwd: ROOT, encoding: 'utf8' })
      .split('\0').filter(Boolean),
  );

  const missing = [];
  for (const line of gi.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('!/')) continue;
    const rel = t.slice(2);
    if (rel.endsWith('/')) continue;                       // 目录白名单，不查
    if (ALLOWED_UNTRACKED.some((rx) => rx.test(rel))) continue;
    if (tracked.has(rel)) continue;
    if (!existsSync(path.join(ROOT, rel))) continue;       // 磁盘上都没有 ⇒ 白名单过时（另一类问题）
    missing.push(rel);
  }

  assert.deepEqual(missing, [],
    '这些文件在白名单里、磁盘上也有，但**没有 git add** —— 本地能构建、CI 会 ENOENT：\n'
    + missing.map((x) => `  ${x}`).join('\n')
    + '\n  处置：git add 它们（白名单只解除忽略，不等于入库）。');
});
