// 编辑器与预览区必须显式给前景色（2026-10-31，站长报「深色模式 mathlive 进去字是黑的」）。
//
// ## 缺陷形状
//
// MathLive 的 `math-field` 是**自定义元素**，内部 shadow DOM 的样式从宿主继承。
// 而 MathLive 自己的 `:host` 只写了 `display: block`，**没有** `color` —— 于是它
// 吃浏览器默认的黑色。
//
// 本站深色是 `data-theme="dark"` **手动切**的，而 MathLive 只认
// `@media (prefers-color-scheme: dark)`（系统偏好）。两者不同步：
// 系统是浅色 + 页面切深色 ⇒ 背景变深、字还是黑的，完全看不清。
//
// KaTeX 同理：它的字形用 `currentColor` 画，容器不设 `color` 就跟宿主走。
//
// ## 判据
//
// 两个容器都必须同时声明 `background` 与 `color`。只设背景不设前景，
// 就是「深色背景 + 黑字」这个组合的来源。
//
// 这条闸门**截图类自动检查抓不到**（渲染无报错、元素存在、尺寸正常），
// 只有真看对比度才发现——所以必须写成结构断言。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = path.join(HERE, '../assets/theme/shirone-reader.css');

/** 取出某个选择器的声明块（第一处）。 */
function blockOf(css, selector) {
  const i = css.indexOf(selector + ' {');
  if (i < 0) return null;
  const start = css.indexOf('{', i) + 1;
  const end = css.indexOf('}', start);
  return css.slice(start, end);
}

test('math-field 必须同时声明 color 与 background（否则深色模式黑字黑底）', () => {
  const css = readFileSync(CSS, 'utf8');
  const blk = blockOf(css, '.pack-mathfield');
  assert.ok(blk, '找不到 .pack-mathfield 规则 —— 选择器改名了？');
  assert.match(blk, /background\s*:/, '.pack-mathfield 没设 background');
  assert.match(blk, /(^|[^-])color\s*:/,
    'math-field 没设 color —— 它内部 shadow DOM 继承宿主，会吃浏览器默认黑字，'
    + '深色模式下变成深底黑字看不清');
});

test('KaTeX 预览容器必须同时声明 color 与 background', () => {
  const css = readFileSync(CSS, 'utf8');
  const blk = blockOf(css, '.pack-editor-preview');
  assert.ok(blk, '找不到 .pack-editor-preview 规则');
  assert.match(blk, /background\s*:/, '预览区没设 background');
  assert.match(blk, /(^|[^-])color\s*:/,
    '预览区没设 color —— KaTeX 字形用 currentColor 画，会跟宿主走成深色背景 + 黑字');
});

test('theme 切换机制是 data-theme 属性（不是媒体查询），MathLive 的媒体查询靠不住', () => {
  // 这条守「上面为什么要显式写 color」的前提：本站主题是手动切的。
  // 哪天改成纯 prefers-color-scheme，那 MathLive 自己的暗色规则就够用了，
  // 这个文件里的显式 color 才可以去掉 —— 前提变了，本闸门要重写。
  const css = readFileSync(CSS, 'utf8');
  assert.match(css, /\[data-theme="dark"\]/,
    '主题不再用 data-theme 属性 —— 请重新检查 math-field 的显式 color 是否还需要');
});
