// 2026-11-01 站长实拍的三个缺陷，逐条锁死。
//
// 起因是一张截图里的三件事：
//   ① 公式上的 hover 框只框住中间一行（「选择框错位」）
//   ② 能力包面板摆着五行诊断 + 一行「当前：只读」（「本来只需要下俩玩意开俩开关」）
//   ③ 下了两个部件、开了两个开关，点公式还是「取不到 assets/octave/octave.js」
//
// 三条都**不是笔误**，是各自一类会再次发生的错。所以每条一个闸门，
// 判据取「源码里必须有的写法」——这些缺陷的特征恰恰是**行为测试全绿、
// 自动闸门全过，只有真在浏览器里看一眼才发现**（和 pack-popover 那个同族）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(path.join(HERE, '../assets/theme/shirone-reader.css'), 'utf8');
const PR = readFileSync(path.join(HERE, 'pack-runtime.mjs'), 'utf8');
const CELLS = readFileSync(path.join(HERE, 'formula-cells.mjs'), 'utf8');
const BUILD = readFileSync(path.join(HERE, '../build.mjs'), 'utf8');

/** 剥掉注释，避免断言被说明文字误伤（CSS 里大段注释讲了反面例子）。 */
function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

test('① hover 描边挂在**收缩的内层** .fcell-body，不挂 .katex 也不挂满宽的 .fcell', () => {
  // 病因（2026-11-01 站长两次纠正，两个方向各错一次）：
  //   · 挂 `.katex` ⇒ 它是 display:inline 的行内盒，盒高只有一行
  //     （3×3 矩阵实测 22px vs 公式整体 70px），框只套住中间一行 = 「错位」。
  //   · 挂满宽的 `.fcell` ⇒ 框横贯整行（732px）包着一片空白，也不像套住公式。
  //   · 挂收缩的 `.fcell-body` ⇒ 正好贴住公式。
  const code = stripCssComments(CSS);
  assert.match(code, /\.fcell-body\[data-fcell-wrapped\]:hover\s*\{[^}]*outline\s*:/,
    '收缩的内层 .fcell-body 上必须有 hover 描边（否则公式没有可点提示，或框会包空白）');
  // 反向：`.katex:hover` 不许再画描边（两份描边会叠成两条框）
  assert.ok(!/\.katex:hover[^{]*\{[^}]*outline\s*:\s*2px/.test(code),
    '.katex:hover 又在画描边了 —— 它的盒只有一行高，会把框画错位');
  // 标记必须打在 body 上（否则上面那条选择器永远不命中）
  assert.match(CELLS, /body\.setAttribute\('data-fcell-wrapped'/,
    'wrapOne 没把 data-fcell-wrapped 打到 .fcell-body 上');
});

test('① 两层盒子必须分开职责：外层满宽（按钮对齐）、内层收缩（描边贴公式）', () => {
  // 2026-11-01 站长第二次定案「计算按钮统一左上角」：
  // 如果外层也收缩，块级公式居中后按钮就跟着飘（实测 758px 的框里按钮在 x=680，
  // 每条公式的按钮 x 坐标都不同）。所以：
  //   外层 `.fcell-block` = block（满宽）→ 所有按钮落在同一条竖线
  //   内层 `.fcell-body` = inline-block（收缩）→ 描边与编辑贴公式
  const code = stripCssComments(CSS);
  assert.match(code, /\.math-display\s+\.fcell[^{]*\{[^}]*display:\s*block/,
    '块级公式的外层必须 display:block（满宽），否则播放按钮跟着公式居中飘');
  assert.match(code, /\.fcell-body\s*\{[^}]*display:\s*inline-block/,
    '内层 .fcell-body 必须 inline-block（收缩），否则 hover 框横贯整行');
  // DOM 结构也要对：wrap > body > anchor
  assert.match(CELLS, /body\.appendChild\(anchor\)/, 'anchor 没有挂进 .fcell-body');
});

test('② 正常态面板不许显示诊断行（站长：只需下俩玩意开俩开关）', () => {
  // 判据：renderDiag 只输出**有问题**的行；全部正常时 innerHTML 必须是空串。
  assert.match(PR, /DIAG_BAD_RE/, '没有「哪些值算坏」的判据');
  const fn = PR.slice(PR.indexOf('function renderDiag()'), PR.indexOf('var katexLoading'));
  assert.ok(fn.length > 100, '找不到 renderDiag 函数体');
  // 必须有「只挑坏的」这一步
  assert.match(fn, /if\s*\(DIAG_BAD_RE\.test\(/, 'renderDiag 没按 DIAG_BAD_RE 过滤，正常态仍会全部输出');
  // 不许有无条件 rows 全量的写入（旧写法是 for 循环里直接 html +=，不看 bad）
  assert.ok(!/html\s*\+=\s*"<div class='pack-diag-row"\s*\+\s*\(bad\s*\?/.test(fn),
    'renderDiag 又变回「五行全量输出」了 —— 正常态会把面板刷满');
  // 「当前：只读」那行已删
  assert.ok(!/pack-mode-label/.test(PR), 'modeLabel 又回来了（站长要求去掉这一行）');
});

test('② 「点击绑定」这一环已废（旧覆盖层删了，它会恒报未绑定）', () => {
  assert.ok(!/clicks:\s*"未绑定"/.test(PR), 'diag.clicks 又回来了 —— 它对应的旧委托已删除');
  assert.ok(!/\[\s*"点击绑定"\s*,\s*diag\.clicks\s*\]/.test(PR), 'renderDiag 里又摆了「点击绑定」行');
});

test('③ 站点根前缀必须现取，不许在加载时快照（SPA 换页会改 data-root）', () => {
  // 病因：rootRel = getAttribute('data-root') 在页面加载那一刻读一次；
  // SPA 换页把 data-root 换成 ../../../ 之后，闭包里的还是 ./，
  // 于是 octave.js 拼成 /课程总览/工程数学/作业/assets/octave/octave.js → 404。
  const inline = BUILD.slice(BUILD.indexOf('<script type="module">'),
    BUILD.indexOf("console.warn('[pack] 装配失败，保持只读'"));
  assert.ok(inline.length > 500, '切不到装配脚本');
  assert.match(inline, /const assetRoot = \(\) =>/, '没有 assetRoot() 现取函数');
  // 反面判据用**废弃的变量名** rootRel —— 它就是这个缺陷的化石：
  // 只要它还在某个代码行里被赋值/使用，就说明又有人把前缀快照回来了。
  // （注释里提到它不算：先剥掉行注释再查。）
  const codeOnly = inline.split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))       // 去掉行注释
    .join('\n');
  assert.ok(!/\brootRel\b/.test(codeOnly),
    'rootRel 又出现在装配脚本的活代码里 —— 那是「加载时快照根前缀」的化石，SPA 换页后会拼出 404');
  // 2026-11-06 起三件套改从 OPFS 读（Static-Contract 分块下载后落盘），
  // 不再拼站点目录前缀 ⇒ octBase/OCT_BASE 都不该存在。
  // 旧断言「const octBase = () =>」是针对「从 assets/octave/ 取」那版的，已过时：
  // 现在连那个目录都不进 dist 了，再要求它现取反而会把死变量焊回来。
  assert.ok(!/const octBase\s*=/.test(inline), 'octBase 还在 —— 三件套不该再从站点目录取');
  assert.ok(!/const OCT_BASE\s*=/.test(inline), 'OCT_BASE 又被做成常量快照了');
  assert.match(inline, /octBlobUrl\(/, '没有从 OPFS 读字节造 blob URL 的装配');
  assert.match(inline, /store:\s*octStore/, '能力包与 ensureOctave 没共用同一份 OPFS store');
  // 能力包那边：root 必须是函数（拼 URL 时现取）
  assert.match(inline, /root:\s*assetRoot/, '能力包没拿到现取的 root，下载仍会用过期前缀');
  const PACK = readFileSync(path.join(HERE, 'capability-pack.mjs'), 'utf8');
  assert.match(PACK, /function resolveRoot\(/, 'capability-pack 里没有 resolveRoot');
  assert.match(PACK, /typeof r === 'function'/, 'resolveRoot 没处理「root 是函数」这种形态');
});

test('④ 版本占位符必须全部替换（三个占位符，不止一个）', () => {
  // 病因：模板里有 __PACK_VER__ / __CELLS_VER__ / __STATIC_RELEASE_VER__，
  // 每加一个新占位符都容易漏进替换链（2026-11-01 漏 CELLS、11-06 漏 STATIC_RELEASE，
  // 两次都是产物里留着字面 ?v=__XXX_VER__ ⇒ 模块永不更新）。
  const seg = BUILD.slice(BUILD.indexOf('const htmlWithVers'),
    BUILD.indexOf('const leakedVer') + 400);
  assert.match(seg, /split\('__PACK_VER__'\)/, '产物没替换 __PACK_VER__');
  assert.match(seg, /split\('__CELLS_VER__'\)/, '产物没替换 __CELLS_VER__');
  assert.match(seg, /split\('__STATIC_RELEASE_VER__'\)/, '产物没替换 __STATIC_RELEASE_VER__');
  // 还要有兜底硬拦，免得以后加第四个占位符时又漏一个
  assert.match(seg, /const leakedVer = \/__/, '没有「占位符残留」的兜底正则');
});

test('⑤ MathLive 不许走 import() 试错（会先打一条假 404）', () => {
  // import() 的相对 URL 是按**调用它的模块**解析的，pack-runtime.js 在
  // assets/plugins/ 下 ⇒ 拼成 assets/plugins/assets/mathlive/… ⇒ 每次进编辑器
  // 都在服务端留一条 404，再回退 script 标签。功能通但日志有假警报。
  assert.ok(!/import\(root\(\)\s*\+\s*"assets\/mathlive/.test(PR),
    'MathLive 又走 import() 了 —— 会先打一条 assets/plugins/assets/… 的假 404');
  assert.match(PR, /sc\.src = root\(\) \+ "assets\/mathlive\/mathlive-browser\.min\.js"/,
    '应该直接用 script 标签加载那个 UMD 包');
});
