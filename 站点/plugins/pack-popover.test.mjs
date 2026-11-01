// 能力包面板必须真的能打开（2026-10-31，站长实测「面板根本打不开」）。
//
// ## 这个 bug 的形状
//
// 面板复用了主题的 `.palette-popover` 样式，那张样式表里写死：
//
//     .palette-popover      { display: none }      ← 默认隐藏
//     .palette-popover.open { display: flex }      ← 只有带 .open 才显示
//
// 而 pack-runtime 只切 `hidden` 属性，**从不加 .open 类**。`hidden` 只能把
// display 设成 none，没有任何规则会把它设回 flex ⇒ 元素 `hidden=false`、
// `display:none`、宽高为 0：DOM 上「打开了」，屏幕上什么都没有。
//
// 调色盘那份实现是对的（`classList.toggle("open")`），pack 那份抄漏了这一步。
//
// ## 为什么要闸门
//
// 这个缺陷**所有自动闸门原先都绿**：元素存在、监听器绑上、`hidden` 属性正确翻转。
// 只有真在浏览器里看渲染结果才发现它从来没显示过。判据取「结构」：
// 切 hidden 的地方必须同时切 .open 类。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK = path.join(HERE, 'pack-runtime.mjs');
const THEME_JS = path.join(HERE, '../assets/theme/shirone-reader.js');
const THEME_CSS = path.join(HERE, '../assets/theme/shirone-reader.css');

test('能力包面板：切 hidden 时必须同时切 .open 类', () => {
  const src = readFileSync(PACK, 'utf8');
  // ⚠️ 2026-11-01 形态变了：胶囊两半要**互斥**，所以开/关收进了
  // openPanel / closePanel 两个函数（资源包按钮不再就地翻 hidden）。
  // 判据本身**一字未改**：显示/隐藏必须同时切 `.open` 类。
  const openFn = src.slice(src.indexOf('function openPanel('), src.indexOf('function bindNotebookBlock('));
  const closeFn = src.slice(src.indexOf('function closePanel('), src.indexOf('function openPanel('));
  assert.ok(openFn.length > 50, '找不到 openPanel');
  assert.ok(closeFn.length > 50, '找不到 closePanel');
  // 打开路径
  assert.match(openFn, /classList\.add\(["']open["']\)/,
    '打开面板只切了 hidden、没切 .open —— 面板会 display:none 而「打不开」');
  // 关闭路径（点别处 / 再点一次）也要清掉
  assert.match(closeFn, /classList\.remove\(["']open["']\)/,
    '关闭路径没清 .open —— 下次再点会残留一个已打开的类');
});

test('主题样式：.palette-popover 默认 display:none 且靠 .open 显示（判据前提）', () => {
  const css = readFileSync(THEME_CSS, 'utf8');
  // 剥注释，避免被说明文字误伤
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(code, /\.palette-popover\s*\{[^}]*display:\s*none/,
    '.palette-popover 不再默认 display:none —— 上面那条断言的前提变了，本闸门要重写');
  assert.match(code, /\.palette-popover\.open\s*\{[^}]*display:\s*flex/,
    '.palette-popover.open 不再设 display:flex —— 面板将永远显示不出来');
});

test('调色盘那份实现是正确参照：它用 .open 类而不是 hidden 属性', () => {
  const src = readFileSync(THEME_JS, 'utf8');
  assert.match(src, /palettePopover\.classList\.toggle\(["']open["']\)/,
    '调色盘的 popover 实现变了 —— 请同步检查能力包面板是否还对齐同一套显示机制');
});

test('能力包面板有高度约束（内容比调色盘高，不约束会顶出视口）', () => {
  const css = readFileSync(THEME_CSS, 'utf8');
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(code, /\.pack-popover\s*\{[^}]*max-height/,
    '.pack-popover 没有 max-height —— 加上诊断行后在小视口上会被切掉底部');
  assert.match(code, /\.pack-popover\s*\{[^}]*overflow-y:\s*auto/,
    '.pack-popover 没有 overflow-y:auto —— 超高内容无法滚动查看');
});
