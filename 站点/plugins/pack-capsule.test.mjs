// 能力入口胶囊 + 计算笔记本（2026-11-01 站长定案）的契约闸门。
//
// ## 这个模块承担什么
//
// 站长要的形态是一枚**胶囊两半**：
//   · 左半 `+` 资源包（下载编辑器/内核）—— **恒在**；
//   · 右半 `-` 笔记本（写 MATLAB 多行 / 写 LaTeX 当场算）——
//     只有**本页有可算公式**时向右展开出现；
//   · 两半各有各的面板，**互斥**（开一个必须关另一个）。
//
// ## 为什么值得单独守
//
// 这个控件有**三个容易一起错、又都不报错**的地方：
//
// ① **「有没有可算公式」是页面的属性，不是胶囊的**。
//    很多实现会写成「资产下载了就展开」——那是错的：没下载内核时
//    可算公式照样存在于正文，`-` 半照样该在（点进去会提示去下载）。
//    判据必须是扫正文的 `data-computable="1"`。
//
// ② **SPA 换页后必须重算**。顶栏常驻（SPA 只换 `.article-content`），
//    所以胶囊 DOM 不会重建；不主动刷新的话，从无可算页跳到有可算页时
//    胶囊永远停在「收起」——而**所有表态断言都会过**（DOM 对、属性对、
//    只是值过期）。这类缺陷只有换页路径才露头。
//
// ③ **两半面板必须互斥**。就地翻 `hidden` 的写法会让右上角同时挂两个弹窗。
//
// 判据取「源码里必须有的写法」，因为这三条都**无法靠单元测试验**
// （要有真 DOM + SPA 换页）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PR = fs.readFileSync(path.join(HERE, 'pack-runtime.mjs'), 'utf8');
const CSS = fs.readFileSync(path.join(HERE, '../assets/theme/shirone-reader.css'), 'utf8');
const BUILD = fs.readFileSync(path.join(HERE, '../build.mjs'), 'utf8');

function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

test('① 展开判据是「本页有可算公式」，不是「资产下载了」', () => {
  const fn = PR.slice(PR.indexOf('function hasComputable()'), PR.indexOf('function refreshCapsule()'));
  assert.ok(fn.length > 60, '找不到 hasComputable 函数体');
  // 必须扫正文的 data-computable
  assert.match(fn, /data-computable="1"/, 'hasComputable 没扫 data-computable —— 判据从哪来？');
  // 反面：不许拿资产状态当代替（那是「下载了就展开」，判据错了）
  assert.ok(!/\bstate\.editor\b|\bstate\.engine\b|\.ready/.test(fn),
    'hasComputable 里读到了资产状态 —— 那是「下载了就展开」，与「本页有没有可算公式」是两件事');
});

test('② SPA 换页钩子必须刷新胶囊（否则胶囊停在上一页的状态）', () => {
  // ⚠️ 用最后出现的位置定右界：`window.__packRuntime` 在文件开头也出现
  // （`if (… || window.__packRuntime) return;`），用 indexOf 会切出空串。
  const start = PR.lastIndexOf('window.__packCellsReset');
  const fn = PR.slice(start, PR.lastIndexOf('window.__packRuntime = {'));
  assert.ok(fn.length > 100, '找不到 __packCellsReset');
  assert.match(fn, /refreshCapsule\(\)/, '换页钩子没刷新胶囊 —— 从无可算页跳到有可算页时胶囊永远不展开');
});

test('③ 两半面板互斥：openPanel 必须关掉另一半', () => {
  const fn = PR.slice(PR.indexOf('function openPanel('), PR.indexOf('function bindNotebookBlock('));
  assert.ok(fn.length > 80, '找不到 openPanel');
  assert.ok(fn.includes('closePanel(which === "pack" ? "notebook" : "pack")'),
    'openPanel 没有关另一半 —— 右上角会同时挂两个弹窗');
  // 反面：资源包面板的点击不许再就地翻 hidden（那会绕过互斥）
  const click = PR.slice(PR.indexOf('toggle.addEventListener("click"'), PR.indexOf('pop.addEventListener("click"'));
  assert.ok(!/pop\.hidden = !open/.test(click), '资源包按钮又就地翻 hidden 了 —— 绕过了互斥');
  assert.match(click, /openPanel\("pack"\)|closePanel\("pack"\)/, '资源包按钮没走 openPanel/closePanel');
});

test('④ 展开态由 data-has-calc 驱动：容器宽度是那个动画量（纯 CSS）', () => {
  const code = stripCssComments(CSS);
  // 收起：右半透明 + 不可点
  assert.match(code, /\.pack-cap-minus\s*\{[^}]*opacity:\s*0/, '右半收起态没有 opacity:0');
  assert.match(code, /\.pack-cap-minus\s*\{[^}]*pointer-events:\s*none/, '右半收起态仍可点');
  // 容器宽度承载动画（两半绝对定位，宽度变了它们只是被「推出来」，形状不变形）
  assert.match(code, /\.pack-capsule\s*\{[^}]*width:\s*38px/, '收起态容器宽度不是 38px（原来那颗圆按钮）');
  assert.match(code, /\[data-has-calc="1"\]\s*\{[^}]*width:\s*68px/, '展开态容器宽度不是 68px');
  assert.match(code, /transition:[^;]*width/, '容器宽度没有过渡 —— 展开会是硬跳');
});

test('⑤ 两半是**斜边切出来的块**（半圆+梯形），不是竖直切一半再画道装饰线', () => {
  // 2026-11-01 站长第二次纠正：「形状用斜线分割，所以我会提到按钮形状是
  // 梯形与半圆组合的样子」。第一版做成「竖直切一半 + 中间画斜线装饰」，
  // 悬停点亮时一眼就看出亮的是矩形块 —— 装饰线画在哪都行，形状才是判据。
  //
  // 判据取 clip-path：两半各自被一条斜边裁开，且**顶点与底点不同 x**
  // （同 x 就是竖直切）。
  const code = stripCssComments(CSS);
  const plus = code.slice(code.indexOf('.pack-capsule[data-has-calc="1"] .pack-cap-plus'),
                          code.indexOf('.pack-capsule[data-has-calc="1"] .pack-cap-minus'));
  const minus = code.slice(code.indexOf('.pack-capsule[data-has-calc="1"] .pack-cap-minus'),
                           code.indexOf('/* ── 点亮'));
  assert.ok(plus.length > 60, '找不到展开态的左半规则');
  assert.ok(minus.length > 60, '找不到展开态的右半规则');
  // 两半都要 clip-path
  assert.match(plus, /clip-path:\s*polygon/, '左半没有 clip-path —— 它不是斜边块');
  assert.match(minus, /clip-path:\s*polygon/, '右半没有 clip-path —— 它不是斜边块');
  // 左半的三/四号顶点必须**不同 x**（顶 100%，底 calc(100% - 8px)）
  assert.match(plus, /polygon\([^)]*100%\s*0[^)]*calc\(100%\s*-\s*8px\)\s*100%/,
    '左半的边缘是竖直的（顶底同 x）—— 要的是斜边');
  // 右半的三号顶点（左上）必须偏移（8px 0），不是 0 0
  assert.match(minus, /polygon\(8px\s*0/, '右半的边缘是竖直的（从 0 0 起）—— 要的是斜边');
  // 两半的圆角必须是「半圆 + 直边」，不是四角全圆（四角全圆就没法拼成胶囊）
  assert.match(plus, /border-radius:\s*9999px\s*0\s*0\s*9999px/, '左半圆角不是「左侧半圆 + 右侧直边」');
  assert.match(minus, /border-radius:\s*0\s*9999px\s*9999px\s*0/, '右半圆角不是「左侧直边 + 右侧半圆」');
});

test('⑤b 斜线分割只在两半都在时画（单独一颗圆按钮不该有斜线）', () => {
  const code = stripCssComments(CSS);
  // 斜线是 .pack-capsule::after，且选择器带 data-has-calc="1"
  assert.match(code, /\.pack-capsule\[data-has-calc="1"\]::after/, '斜线没有绑定在展开态上');
  assert.ok(!/\.pack-capsule::after\s*\{/.test(code),
    '斜线无条件画了 —— 无可算公式时会在圆按钮中间画一道莫名其妙的斜线');
});

test('⑥ 笔记本两块：MATLAB 走原生代码，公式走 LaTeX 翻译', () => {
  // 两个块共用一个执行器，但分派到两个**不同**的适配器：
  //   code → __packRunCode（原生 Octave，不套 disp）
  //   tex  → __packCompute（LaTeX → 转译 → disp）
  // 混用会有一边算不了：tex 喂给 RunCode 是语法错，code 喂给 Compute 是解析错。
  const fn = PR.slice(PR.indexOf('function bindNotebookBlock('), PR.indexOf('var capsuleBound = false'));
  assert.match(fn, /__packRunCode/, 'MATLAB 块没走 __packRunCode');
  assert.match(fn, /__packCompute/, '公式块没走 __packCompute');
  assert.ok(fn.includes('ids.mode === "tex"'), '两块没有按 mode 分派');
  // 两个适配器都要由页面装配脚本提供
  assert.match(BUILD, /window\.__packRunCode = async/, '页面里没有 __packRunCode 的实现');
  assert.match(BUILD, /window\.__packCompute = async/, '页面里没有 __packCompute 的实现');
});

test('⑦ 换页时清掉笔记本输出（那条结果属于上一页的上下文）', () => {
  const fn = PR.slice(PR.lastIndexOf('window.__packCellsReset'), PR.lastIndexOf('window.__packRuntime = {'));
  assert.match(fn, /nb-code-out/, '换页没清 MATLAB 输出');
  assert.match(fn, /nb-tex-out/, '换页没清公式输出');
});

test('⑧ 深色模式：笔记本输入框必须显式给前景色（不许吃浏览器默认黑）', () => {
  // 同一类坑本站已吃过两次（.pack-mathfield / .fcell-result）。
  // textarea 继承不到主题前景色时会用浏览器默认黑，深色页面上就是黑字黑底。
  const code = stripCssComments(CSS);
  const rule = code.slice(code.indexOf('.nb-code {'), code.indexOf('.nb-code:focus-visible'));
  assert.ok(rule.length > 100, '找不到 .nb-code 规则');
  assert.match(rule, /color:\s*var\(--md-sys-color-on-surface\)/, '.nb-code 没给前景色');
  assert.match(rule, /background/, '.nb-code 没给背景色');
});
