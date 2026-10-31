// SPA 换页后复制按钮必须仍然可点（issue #17，2026-10-31 修）。
//
// ## 为什么这条必须存在
//
// copy-btn 在 `.article-content` **内**，而 SPA 换页换掉的正是这块 DOM。
// 2026-10-22 之前的实现是启动时 `querySelectorAll('.copy-btn').forEach(绑定)`：
// 首屏直达正常，站内跳到任何含代码块的页后再点——**没反应**。
// 这类缺陷自动闸门全绿（页面能开、链接能通、构建 0 错误），只有人手点才发现。
//
// 判据取「结构」而不是「行为」：断言绑定方式是**事件委托**（document 级监听 +
// closest），而不是逐个绑定。因为逐个绑定必然是错的——它不可能覆盖换页后新插入的
// 按钮，除非每次换页都重绑（那就多一条会漂移的维护点）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const THEME_JS = path.join(HERE, '../assets/theme/shirone-reader.js');

test('复制按钮必须用事件委托（SPA 换页后新按钮才有点击监听）', () => {
  // 剥掉注释再判：文件顶部记着「旧实现是 querySelectorAll(".copy-btn").forEach(绑定)」
  // 这条历史说明，不剥会把它当成现行代码误报。
  const src = readFileSync(THEME_JS, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // 行注释（不碰 http:// 这类）
  assert.ok(!/querySelectorAll\(["']\.copy-btn["']\)\s*\.forEach/.test(src),
    '复制按钮又回到「启动时逐个绑定」了——SPA 换页后新页的按钮不会有监听器（issue #17）');
  assert.match(src, /addEventListener\(["']click["'],\s*async\s*\(e\)\s*=>/,
    '没找到 document 级的 click 委托（复制按钮的绑定方式变了）');
  assert.match(src, /closest\(["']\.copy-btn["']\)/,
    '委托里必须用 closest(".copy-btn") 找到按钮——点到的可能是按钮内的子节点');
});
