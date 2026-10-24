// build-asset-version.test.mjs —— assetVersion 硬失败守卫（issue #18 决策 #6）。
//
// 此前引用不存在的资产会静默降级成无 ?v= 的裸引用（审计 γ P1-3）：
// 产物里出现 404 死链接、构建零警告。现在必须抛错。
// 测法：从 build.mjs 源码**提取真函数体**，在 DIST_DIR=空临时目录的隔离环境里跑
// ——不复制实现（复制会漂移），不整跑构建（整跑太重）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

function extractAssetVersion() {
  const src = readFileSync(new URL('../build.mjs', import.meta.url), 'utf8');
  const m = src.match(/const assetVersion = (\(relFromDist\) => \{[\s\S]*?\n\});/);
  assert.ok(m, 'build.mjs 里应有 assetVersion 函数');
  return new Function('fs', 'path', 'DIST_DIR', 'createHash', `return (${m[1]})`)(fsLike, path, '', createHash);
}

// fs 只用到 readFileSync——传真的，DIST_DIR 由闭包变量控制
import * as fsLike from 'node:fs';

test('assetVersion：资产不存在时抛错并点名资产（不静默给空串）', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'assetver-'));
  try {
    const fn = new Function('fs', 'path', 'DIST_DIR', 'createHash', `
      const assetVersion = ${readFileSync(new URL('../build.mjs', import.meta.url), 'utf8')
        .match(/const assetVersion = (\(relFromDist\) => \{[\s\S]*?\n\});/)[1]};
      return assetVersion;
    `)(fsLike, path, tmp, createHash);
    assert.throws(() => fn('assets/plugins/no-such.js'),
      /no-such\.js/, '错误信息必须点名资产，构建日志才能直接定位');
    // 反向：资产在时正常给 10 位哈希（happy path 不能被改坏）
    mkdirSync(path.join(tmp, 'assets'), { recursive: true });
    writeFileSync(path.join(tmp, 'assets', 'ok.js'), 'console.log(1)');
    const v = fn('assets/ok.js');
    assert.match(v, /^[0-9a-f]{10}$/, '内容哈希前 10 位');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
