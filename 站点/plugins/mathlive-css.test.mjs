// 数学样式表必须带内容哈希戳（2026-10-30 立，2026-10-31 换引擎后仍适用）。
//
// ## 为什么只剩这一条
//
// 前三类测试（MathLive 的 `.ML__mtable` 要 display:inline-block 等）是编辑器
// 时代的补丁守卫——那张 static.css 2026-10-31 已随 SSR 版一起删除，补丁本身没了，
// 守卫自然也没有对象。KaTeX 的 katex.min.css 是完整发行版，不需要补丁。
//
// 但这条**与引擎无关**的教训必须留着：**样式表必须带内容哈希戳**。
// 2026-10-29 实测：mathlive-static.css 曾是唯一裸引用的 CSS，于是补丁写进 dist、
// 页面也重建了，浏览器永远拿缓存——表现是「CSS 规则明明对，就是不生效」，
// 排查时会误判成规则写错。换 KaTeX 后这条同样适用。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('数学样式表必须带内容哈希戳（否则改了它浏览器永远读旧缓存）', () => {
  // 2026-10-29 实测踩到的坑：这张 CSS 曾是**唯一**裸引用的样式表（其余四张都走
  // assetUrl 带 `?v=<内容哈希>`）。于是补丁写进 dist、页面也重新构建了，
  // 浏览器照样拿缓存副本 —— 表现是「CSS 规则明明对，就是不生效」，
  // 排查时会误判成规则写错。判据：构建产物里的 link 必须带 `?v=`。
  const html = readFileSync(path.join(HERE, '../dist/index.html'), 'utf8');
  const m = /<link[^>]*href="([^"]*katex\.min\.css[^"]*)"/.exec(html);
  assert.ok(m, '页面里没有 katex.min.css 的 link');
  assert.match(m[1], /\?v=[0-9a-f]+/,
    'katex.min.css 的 link 必须带内容哈希戳（走 assetUrl），否则改它不生效');
});
