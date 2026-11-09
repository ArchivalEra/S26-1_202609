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

test('① 减号常驻（2026-11-07 站长定案）：refreshCapsule 恒写 "1"，判据不许是资产状态', () => {
  // 2026-11-01 的旧判据「本页有 data-computable="1" 公式才展开」已废除：
  // 笔记本不只是给本页公式代算，也是随手写公式的入口；页面没有可算公式时
  // 把入口藏掉，读者要找时永远在翻页找哪页有公式。站长：「减号胶囊还是常驻吧」。
  const fn = PR.slice(PR.indexOf('function refreshCapsule()'), PR.indexOf('function hasComputable()') === -1 ? PR.indexOf('/** 顶栏四个面板') : PR.indexOf('/**\n * 顶栏四个面板'));
  assert.ok(fn.length > 40, '找不到 refreshCapsule 函数体');
  assert.match(fn, /setAttribute\("data-has-calc", "1"\)/,
    'refreshCapsule 没有恒写 "1" —— 减号又会被「本页有没有可算公式」收起来了');
  assert.match(fn, /aria-hidden/, 'aria-hidden 没有同步（读屏会读到不可见控件或漏读可见控件）');
  // 反面：不许拿资产状态当代替（那是「下载了就展开」，判据错了）
  assert.ok(!/\bstate\.editor\b|\bstate\.engine\b|\.ready/.test(fn),
    'refreshCapsule 里读到了资产状态 —— 那是「下载了就展开」，与常驻无关');
  // 初始标记也是常驻：首屏就展开，不加载后跳一下
  assert.match(BUILD, /id="pack-capsule" data-has-calc="1"/,
    '胶囊初始标记还是 "0" —— 首屏收起、JS 跑完再跳开');
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
  // 2026-11-01 演进：从「关另一半」扩到「关其余全部」（四面板互斥）。
  assert.ok(fn.includes('closeOthers(which)'),
    'openPanel 没有关其余面板 —— 右上角会同时挂多个弹窗');
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

// ══════════════════════════════════════════════════════════════════
// 2026-11-01 站长三条：
//   「面板里居然没有 mathlive 的选择器」
//   「深色模式下 mathlive 那两个按钮有点不可视」
//   「编辑器与面板里面都不要出现虚拟键盘按钮吧，那个全站都不需要」
//   ↑ 第三条已于 2026-11-09 改定案：手机端没有物理键盘，按钮是唯一输入方式，
//     改为「桌面隐藏、触屏恢复」；前两条（math-field 选择器、深色可见度）照旧。
// ══════════════════════════════════════════════════════════════════

test('⑬ 笔记本的公式块用 math-field（MathLive），不是 textarea', () => {
  // 站长原话「面板里居然没有 mathlive 的选择器」—— 页面上公式点开是
  // MathLive，笔记本里却只有纯文本框，同一个能力两套输入体验说不过去。
  // 按锚点切：从「公式」块名到下一个 section 结束（正则跨嵌套不可靠）
  const i = BUILD.indexOf('<span class="nb-block-name">公式</span>');
  assert.ok(i > 0, '找不到「公式」块');
  const seg = BUILD.slice(i, BUILD.indexOf('</section>', i));
  assert.ok(seg.length > 100, '「公式」块切不出来');
  assert.match(seg, /<math-field/, '公式块不是 math-field —— 它还是纯文本框');
  assert.ok(!/<textarea/.test(seg), '公式块还在用 textarea（MathLive 才是所见即所得）');
  // 与之相对：MATLAB 块**必须**还是 textarea（原生代码没有 MathLive 版本）
  assert.match(BUILD, /<textarea class="nb-code" id="nb-code"/, 'MATLAB 块被误改成 math-field 了');
});

test('⑭ 虚拟键盘按钮桌面隐藏、触屏保留（2026-11-09 改定案）', () => {
  // 2026-11-01 曾全站隐藏；站长 2026-11-09 恢复：手机端没有物理键盘，
  // 按钮是唯一输入方式。policy=manual 仍设（只禁自动弹出）。
  const pr = PR;
  assert.match(pr, /\.ML__virtual-keyboard-toggle/, '虚拟键盘按钮的规则丢了');
  assert.match(pr, /@media \(pointer: fine\)/, '桌面隐藏的媒体查询丢了');
  assert.match(pr, /@media \(pointer: coarse\)/, '触屏恢复的媒体查询丢了');
  // 属性层面（MathLive 自己也会读）
  assert.match(pr, /math-virtual-keyboard-policy/, '没有设 math-virtual-keyboard-policy');
  assert.match(pr, /virtualKeyboardMode:\s*"manual"/, '没有设 virtualKeyboardMode: manual');
  // 页面编辑器（formula-cells 动态建的 math-field）也要设属性
  const cells = fs.readFileSync(path.join(HERE, 'formula-cells.mjs'), 'utf8');
  assert.match(cells, /setAttribute\('math-virtual-keyboard-policy',\s*'manual'\)/,
    '页面公式编辑器的 math-field 没设 policy —— 键盘会未经点击自动弹出');
});

test('⑮ math-field 的内置按钮在深色下必须可见（不许吃 MathLive 的硬编码暗色）', () => {
  // 站长：「深色模式下 mathlive 那两个按钮有点不可视」。
  // MathLive 的图标色是 hsl(hue, 25%, 35%) 那套硬编码 —— 深色面板上 35%
  // 亮度几乎与背景同色。CSS 穿不过 shadow 边界（那两个按钮没声明 part=），
  // 所以必须在运行期注入样式，把它们提到主题前景色。
  const pr = PR;
  assert.match(pr, /\.ML__menu-toggle/, '没有给菜单按钮提亮的规则');
  assert.match(pr, /shadowRoot/, '没有访问 shadowRoot —— 穿不过 shadow 边界就改不了那两个按钮');
  // 注入的样式要用**具体颜色值**（shadow 内部拿不到外部自定义属性）
  assert.match(pr, /getComputedStyle\(mf\)\.color/, '注入的样式应该用具体颜色值而不是 var(--…)');
  // CSS 层面也要给宿主兜底（MathLive 的 :host 不写 color）
  const code = stripCssComments(CSS);
  assert.match(code, /\.nb-mathfield\s*\{[^}]*color:\s*var\(--md-sys-color-on-surface\)/,
    '.nb-mathfield 没显式给 color —— 深色下面板里的公式字会是黑的');
});

test('⑮b 三道杠必须可见：注入 CSS 要有 display:flex !important 压住 MathLive 的 inline 隐藏', () => {
  // ## 2026-11-06 深夜实弹（站长报「三道杠在全站迷失」）
  //
  // 前一轮我把它当成罪魁直接 `display:none`；再前一轮改成「只提亮 opacity」——
  // 两次都在 CSS 层打转，测试全绿而按钮依旧不在。**真凶是 MathLive 自己**：
  // mathlive-browser.min.js 的渲染函数在宿主 offsetWidth<50 时会写
  // `[part=menu-toggle].style.display = "none"`；笔记本 nb-tex 在默认 hidden
  // 的面板里首渲染宽度为 0 ⇒ 必命中，且面板打开时站点侧没有钩子让它恢复。
  // 作者样式表的 !important 能压过非 important 的 inline style，
  // 而只写 color/opacity **压不住** display 的盒生成。
  //
  // 判据：注入样式里 menu-toggle 规则块必须含 display:flex !important，
  // 且不许出现 display:none。
  const pr = PR;
  const rules = [...pr.matchAll(/"([^"]*\.ML__menu-toggle[^"]*?)\s*\{",?([\s\S]{0,240}?)"\}"/g)]
    .map((m) => ({ sel: m[1], body: m[2] }));
  const offenders = rules.filter((r) => /display\s*:\s*none/.test(r.body));
  assert.deepEqual(offenders.map((o) => o.sel), [],
    '注入样式把三道杠 display:none 掉了 —— 站长要这个按钮在（真凶是虚拟键盘和 MathLive 的 inline 隐藏）。');
  assert.ok(rules.some((r) => /display\s*:\s*flex\s*!important/.test(r.body)),
    'menu-toggle 规则块缺 display:flex !important —— 只写 color/opacity 压不住 MathLive 写的 inline display:none');
  // 正向断言：提亮规则也还在（深色下不可视是另一类回归）
  assert.match(pr, /\.ML__menu-toggle[^"]*\{",?[\s\S]{0,240}?opacity/s,
    '菜单按钮没有提亮/可见规则 —— 深色下它会不可视');
});

test('⑮c 面板打开与进编辑态都必须清 MathLive 写的 inline display 并重算', () => {
  // 光靠 CSS 覆盖能「看起来在」，但 MathLive 内部仍认为按钮是隐藏的；
  // 右键菜单 / 布局重算等路径可能漂移。refreshMathFieldChrome 清掉 inline
  // display 并派一次 resize 让 MathLive 按新宽度重渲染。
  // 三处调用缺一不可：shadowRoot 就绪、笔记本面板打开、页内单元格进编辑态。
  assert.match(PR, /function refreshMathFieldChrome\(mf\)/, '缺 refreshMathFieldChrome 实现');
  assert.match(PR, /btn\.style\.removeProperty\("display"\)/,
    'refreshMathFieldChrome 没清 MathLive 写的 inline display:none');
  assert.match(PR, /dispatchEvent\(new Event\("resize"\)\)/,
    'refreshMathFieldChrome 没触发 MathLive 重算按钮布局');
  // ① 笔记本面板打开（nb-tex 在 hidden 面板里宽度为 0，是最典型的命中场景）
  const openPanel = PR.slice(PR.indexOf('function openPanel('), PR.indexOf('function bindNotebookBlock'));
  assert.match(openPanel, /which === "notebook"[\s\S]{0,200}refreshMathFieldChrome\(\$\("nb-tex"\)\)/,
    'openPanel 打开笔记本时没重算 nb-tex 的三道杠 —— 面板隐藏时 MathLive 已把按钮 inline 藏了');
  // ② 页内单元格每次进编辑态
  const CELLS = fs.readFileSync(path.join(HERE, 'formula-cells.mjs'), 'utf8');
  assert.match(CELLS, /__refreshMathFieldChrome/,
    'formula-cells 进编辑态没调 __refreshMathFieldChrome —— 懒建/复用的 math-field 三道杠可能仍被 inline 藏');
  // ③ 暴露到 window（跨模块边界只能用这个）
  assert.match(PR, /window\.__refreshMathFieldChrome = refreshMathFieldChrome/,
    '__refreshMathFieldChrome 没挂到 window —— formula-cells 是独立模块，拿不到本文件的局部函数');
  // ④ shadowRoot 就绪后也要补一次
  const cfg = PR.slice(PR.indexOf('function configureMathField('), PR.indexOf('function refreshMathFieldChrome'));
  assert.match(cfg, /refreshMathFieldChrome\(mf\)/,
    'shadowRoot 就绪后没补一次 refresh —— 新建实例拿不到配置就永远缺三道杠');
});

// ══════════════════════════════════════════════════════════════════
// 2026-11-01 站长：**调色盘与能力包会互相遮挡**。
//
// 根因不是「位置算错」，是**四个顶栏面板各自开关、互不管**：
//   · pack-runtime 的 openPanel/closePanel 只管 pack 与 notebook；
//   · 调色盘自己 classList.toggle("open")；
//   · 搜索自己 panel.hidden = …。
// 于是「调色盘 + 能力包」能同时开着 —— 两个面板都 right:0、宽度不同
// （实测 280px 与 340px），左边缘错开、右侧贴边，视觉上就是互相压住。
//
// 修法：四个面板走**同一个开关入口**，开任何一个先关掉其余三个。
// 判据取「有没有统一入口」+「四键都在」——因为真重叠要跑浏览器。
// ══════════════════════════════════════════════════════════════════

test('⑯ 顶栏四个面板必须走同一个开关入口（否则会互相遮挡）', () => {
  const pr = PR;
  // ① 四键锚点表必须在
  assert.match(pr, /PANEL_ANCHORS/, '没有四面板锚点表 —— 又会各自开关');
  for (const k of ['palette', 'pack', 'notebook', 'search']) {
    assert.match(pr, new RegExp(`${k}:\\s*\\{`), `PANEL_ANCHORS 缺 ${k}`);
  }
  // ② openPanel 必须关掉**其余三个**（不是只关一个）
  const openFn = pr.slice(pr.indexOf('function openPanel('), pr.indexOf('function bindNotebookBlock('));
  assert.match(openFn, /closeOthers\(which\)/, 'openPanel 没关其余面板 —— 会重叠');
  const closeOthers = pr.slice(pr.indexOf('function closeOthers('), pr.indexOf('function openPanel('));
  assert.match(closeOthers, /for \(var k in PANEL_ANCHORS\)/, 'closeOthers 没遍历全部面板');
  // ③ 跨模块入口必须暴露（调色盘/搜索是**先于本模块**加载的独立脚本）
  assert.match(pr, /window\.__panelToggle\s*=/,
    '没有暴露 window.__panelToggle —— 调色盘与搜索接不上互斥');
  assert.match(pr, /toggle:\s*function/, '桥没有 toggle 动作');
  assert.match(pr, /close:\s*function/, '桥没有 close 动作');
});

test('⑯ 调色盘与搜索都接了统一入口（各自 toggle 的老写法必须退役）', () => {
  const themeJs = fs.readFileSync(path.join(HERE, '../assets/theme/shirone-reader.js'), 'utf8');
  // 判据必须查「真的调了」而不是「字符串出现过」——实测变体验证：
  // 只写 `const bridge = window.__panelToggle` 而不调用，字符串在、逻辑没接，
  // 那样的断言会放过缺陷。所以查 call 形态。
  assert.match(themeJs, /bridge\.toggle\(["']palette["']\)/,
    '调色盘没**调用**统一入口的 toggle —— 它还会和能力包同时开');
  const search = fs.readFileSync(path.join(HERE, 'site-search.mjs'), 'utf8');
  assert.match(search, /bridge\.toggle\(["']search["']\)/,
    '搜索没**调用**统一入口的 toggle');
  // 反面：不许再有无条件的本地 toggle（那会绕过互斥）
  assert.ok(!/palettePopover\.classList\.toggle\("open"\);\n      setExpanded/.test(themeJs.replace(/\s+/g,' ')),
    '调色盘还留着无条件的本地 toggle 路径（绕过互斥）');
});

test('胶囊监听器必须绑在 syncOnce 之前（否则存储抛错会让加号变死按钮）', () => {
  // 2026-11-06 站长实测「点加号弹不出面板」：原实现把 syncOnce()（碰 OPFS /
  // localStorage）放在 toggle.addEventListener 之前。无痕模式/隐私设置下
  // 它抛错 ⇒ 后面的监听器永远绑不上 ⇒ DOM 在、点了没反应。
  // 判据：源码里 toggle.addEventListener 的位置必须早于 syncOnce() 的**裸调用**。
  const PR = fs.readFileSync(path.join(HERE, 'pack-runtime.mjs'), 'utf8');
  const initAt = PR.indexOf('function init()');
  assert.ok(initAt > 0, '找不到 init()');
  const body = PR.slice(initAt, initAt + 3000);
  const bindAt = body.indexOf('toggle.addEventListener');
  // 找 syncOnce() 的调用点（跳过注释行）。判据是「第一个非注释的 syncOnce(」
  const lines = body.split('\n');
  let syncAt = -1;
  let offset = 0;
  for (const line of lines) {
    const isComment = /^\s*\//.test(line);
    if (!isComment && /syncOnce\s*\(/.test(line)) { syncAt = offset + line.indexOf('syncOnce'); break; }
    offset += line.length + 1;
  }
  assert.ok(bindAt > 0, 'init() 里没有 toggle.addEventListener');
  assert.ok(syncAt > 0, 'init() 里找不到 syncOnce() 的调用');
  assert.ok(bindAt < syncAt,
    `监听器绑定（offset ${bindAt}）必须在 syncOnce()（offset ${syncAt}）之前——`
    + '否则存储一抛错，加号就是死按钮');
  // 还要真的被 try/catch 包着
  assert.match(body, /try \{ syncOnce\(\); \} catch/,
    'syncOnce() 没被 try/catch 包住——存储不可用时会中断整个 init()');
});
