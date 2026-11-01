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

// ══════════════════════════════════════════════════════════════════
// 2026-11-01 站长两条：「右下拖拽标给它改亮一点」「全站都有的框大小自动排版
// 怎么这里没接上」。
//
// 这两条都属于「全站已经有的机制，新面板没接」那一类 —— 新面板是后加的，
// 老机制在新地方不自动生效。所以判据取「**与老地方同一套**」：
// 拿全站已有的框（.fcell-result / .pack-popover）当参照，逐条比对。
// ══════════════════════════════════════════════════════════════════

/**
 * 取某个选择器的**全部**规则体（同一个选择器可能有多条规则，例如
 * `.pack-popover` 就分两条写：一条管宽度、一条管高度约束）。
 * 只取第一条会漏掉一半属性 —— 实测踩到（闸门报「找不到参照物」）。
 */
function ruleBody(src, sel) {
  const code = stripCssComments(src);
  let out = '';
  let from = 0;
  while (true) {
    const i = code.indexOf(sel + ' {', from);
    if (i < 0) break;
    const j = code.indexOf('}', i);
    if (j < 0) break;
    out += code.slice(i + sel.length, j) + '\n';
    from = j + 1;
  }
  return out;
}

test('⑨ 笔记本面板接上全站弹层那套约束（max-height / overflow / overscroll）', () => {
  // .pack-popover 早就有这三条；笔记本面板原先只有 width/max-width。
  // 后果：两块输入框 + 两块输出框叠起来在小视口上把面板顶穿。
  const nb = ruleBody(CSS, '.notebook-popover');
  const pk = ruleBody(CSS, '.pack-popover');
  assert.ok(nb.length > 50, '找不到 .notebook-popover 规则');
  assert.ok(pk.length > 50, '找不到 .pack-popover 规则（参照物）');
  // 与参照物同一套：三条都必须有
  for (const prop of ['max-height', 'overflow-y', 'overscroll-behavior']) {
    assert.match(nb, new RegExp(prop), `.notebook-popover 缺 ${prop} —— 全站弹层都有这条`);
    assert.match(pk, new RegExp(prop), `参照物 .pack-popover 也没有 ${prop}？闸门前提变了`);
  }
});

test('⑩ 输出框接上结果框那套自动伸缩（min/max + 双向滚动 + 不折行）', () => {
  // .fcell-result 的完整形态：min-height 撑出「块」、min-width 防挤成竖条、
  // max-height/max-width 封顶、overflow:auto、white-space:pre。
  // .nb-out 原先只有 max-height + overflow —— 短结果是个贴边小条、长结果横向撑破。
  const nb = ruleBody(CSS, '.nb-out');
  const fc = ruleBody(CSS, '.fcell-result');
  assert.ok(nb.length > 50, '找不到 .nb-out 规则');
  assert.ok(fc.length > 50, '找不到 .fcell-result 规则（参照物）');
  for (const prop of ['min-height', 'min-width', 'max-height', 'max-width', 'overflow', 'white-space: pre']) {
    assert.match(nb, new RegExp(prop.replace(':', '[\\s]*:')),
      `.nb-out 缺 ${prop} —— 结果框有这条，输出框该跟它一致`);
    assert.match(fc, new RegExp(prop.replace(':', '[\\s]*:')),
      `参照物 .fcell-result 也没有 ${prop}？闸门前提变了`);
  }
});

test('⑪ 输入框的拖拽把手必须跟主题（不许写死 color-scheme: light）', () => {
  // 2026-11-01 站长报「右下拖拽标看不见」。病因：.nb-code 写死
  // `color-scheme: light`（那条本来是为修「深色页面里原生控件黑字」），
  // 但它同时把**原生 resize 把手**锁成浅色系 —— 深色底上几乎看不见。
  // 原生把手颜色**只由 color-scheme 决定**，没有别的 CSS 能改。
  const code = stripCssComments(CSS);
  const nb = ruleBody(CSS, '.nb-code');
  assert.match(nb, /color-scheme:\s*inherit/, '.nb-code 该跟随主题（color-scheme: inherit）');
  assert.ok(!/color-scheme:\s*light/.test(nb), '.nb-code 又写死 color-scheme: light 了 —— 深色下把手会看不见');
  // 还要自绘一个高对比把手（原生色跟主题走不一定够亮）
  assert.match(code, /\.nb-code::-webkit-resizer\s*\{/, '没有 ::-webkit-resizer 的自绘把手');
  assert.match(code, /\.nb-code::-webkit-resizer\s*\{[\s\S]*linear-gradient/, '自绘把手没画斜纹');
  assert.match(code, /\.nb-code::-webkit-resizer\s*\{[\s\S]*var\(--md-sys-color-primary\)/,
    '自绘把手没用主题强调色 —— 亮度和对比度要靠它');
});
