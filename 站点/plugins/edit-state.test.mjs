// edit-state.test.mjs —— 「编辑态是一个明确的状态」这条重构的专门闸门。
//
// ## 为什么单独一个文件
//
// 2026-11-06 深夜站长报「极其严重的退化：三道杠仍然看不见、编辑仍然无法使用，
// 我认为是时候重构了，编辑态应该成为一个明确的状态」。
//
// 前两轮我都在 CSS 层打补丁：先把三道杠 display:none，再改成「只提亮 opacity」。
// 两次测试全绿，两次线上依然坏。病因从来不是某一条 CSS：
//
//   ① 编辑态由 6 处分头写的内联 style.display + 一堆并行布尔拼出来，必然漂移；
//   ② enterEdit 同步调 onNeedEditor() 后立刻同步查 customElements ⇒ 首次点击必假；
//   ③ 三道杠是 MathLive 自己在 offsetWidth<50 时写 inline display:none 藏的，
//      而笔记本面板默认 hidden ⇒ 宽度 0 ⇒ 必命中；CSS 里只写 color/opacity 压不住。
//
// 这个文件盯的是**结构**：状态机的形状、首次点击的异步链、三道杠的 display 覆盖，
// 以及 CSS 与状态值是否一一对齐。真浏览器行为由本地 CDP 复验（不进 CI）。
//
// ## 变异自证
//
// 每条断言都配一个「把源码改坏」的反向验证：改坏后必须红。跑法见文件末尾
// 的注释（手工：临时改坏 → node --test → 看红 → 还原）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CELLS = readFileSync(path.join(HERE, 'formula-cells.mjs'), 'utf8');
const PR = readFileSync(path.join(HERE, 'pack-runtime.mjs'), 'utf8');
const CSS = readFileSync(path.join(HERE, '../assets/theme/shirone-reader.css'), 'utf8');

/** 去掉 CSS 注释，避免注释里的示例代码骗过正则。 */
function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}
const CSS_CODE = stripCssComments(CSS);

test('状态机有且只有两个状态与一张合法转换表', () => {
  // 状态值必须与 CSS 属性选择器里出现的字面量完全一致（不许 JS 用 editing、
  // CSS 却写 edit —— 那种不对齐正是「状态不明确」的典型形状）。
  const states = [...CELLS.matchAll(/const STATE_(DISPLAY|EDITING) = '([a-z]+)'/g)]
    .map((m) => ({ name: m[1].toLowerCase(), value: m[2] }));
  assert.deepEqual(states.map((s) => s.value).sort(), ['display', 'editing'],
    '状态字面量不是 display / editing 两个');
  for (const s of states) {
    assert.ok(CSS_CODE.includes(`.fcell[data-fcell-state="${s.value}"]`),
      `CSS 里没有 [data-fcell-state="${s.value}"] 的派生规则 —— JS 与 CSS 不对齐`);
  }
  const trans = CELLS.slice(CELLS.indexOf('const STATE_TRANSITIONS'), CELLS.indexOf('export function createFormulaCells'));
  assert.match(trans, /display: \[STATE_EDITING\]/, '缺 display → editing 这条合法转换');
  assert.match(trans, /editing: \[STATE_DISPLAY\]/, '缺 editing → display 这条合法转换');
  // 不允许第三状态偷偷出现
  assert.ok(!/data-fcell-state['"],?\s*['"](?:pending|loading|error)/.test(CELLS),
    '出现了第三个状态值 —— 状态机要的是两个明确状态，不是又一堆中间态');
});

test('setState 是唯一写入点，且非法转换会响亮报错', () => {
  const allWrites = [...CELLS.matchAll(/setAttribute\('data-fcell-state'/g)];
  assert.equal(allWrites.length, 2,
    'data-fcell-state 只允许写两处：wrapOne 初始化 + setState。多一处就又是一份真相');
  const body = CELLS.slice(CELLS.indexOf('function setState('), CELLS.indexOf('function attach('));
  assert.match(body, /if \(next === cur\) return true/, 'setState 没做幂等短路');
  assert.match(body, /STATE_TRANSITIONS\[cur\]/, 'setState 没查合法转换表');
  assert.match(body, /indexOf\(next\) === -1/, 'setState 没有「非法转换」判据');
  assert.match(body, /showCellError/, '非法转换静默吞掉了 —— 那会重演「点了没反应」');
  assert.match(body, /setAttribute\('data-fcell-state', next\)/, 'setState 没写状态属性');
  // 状态属性只能由 setState 与 wrapOne 写；不许出现在别处
  const other = CELLS.replace(/function setState\([\s\S]*?\n  \}\n/, '')
    .replace(/wrap\.setAttribute\('data-fcell-state', STATE_DISPLAY\);/, '');
  assert.ok(!/setAttribute\('data-fcell-state'/.test(other),
    'setState 之外还有第三处写状态属性');
});

test('零内联 display：三层显示节点的显隐全由 CSS 派生', () => {
  // 旧实现 6 处 style.display = 是「编辑一遍就点不开」的直接病根。
  assert.equal((CELLS.match(/\.style\.display\s*=/g) || []).length, 0,
    '又出现内联 style.display 写入 —— 显隐必须由 data-fcell-state 的 CSS 派生');
  // 三层节点必须都在 wrapOne 里建好且常驻
  const wrapOne = CELLS.slice(CELLS.indexOf('function wrapOne('), CELLS.indexOf('async function computeCell'));
  assert.match(wrapOne, /painted\.className = 'fcell-painted'/, '没建常驻重绘副本');
  assert.match(wrapOne, /body\.appendChild\(anchor\)/, '没把原 katex 挂进 body');
  assert.match(wrapOne, /body\.insertBefore\(painted, anchor\)/,
    '副本必须排在 anchor 之前 —— CSS 用相邻兄弟选择器藏旧显示，不依赖 :has()');
  // CSS 四条派生规则
  assert.match(CSS_CODE, /\[data-fcell-state="display"\][\s\S]{0,100}\.fcell-mathfield\s*\{\s*display:\s*none/,
    'display 态没藏 math-field');
  assert.match(CSS_CODE, /\[data-fcell-state="editing"\][\s\S]{0,100}\.fcell-mathfield\s*\{\s*display:\s*inline-block/,
    'editing 态没显示 math-field');
  assert.match(CSS_CODE, /\.fcell-painted:empty\s*\{\s*display:\s*none/, '空副本没藏');
  assert.match(CSS_CODE, /\.fcell-painted:not\(:empty\)\s*\+\s*\.katex\s*\{\s*display:\s*none/,
    '有副本时没藏原公式');
});

test('首次点击能进编辑：onNeedEditor 是 await 的，粗门控不再查 customElements', () => {
  const enter = CELLS.slice(CELLS.indexOf('async function enterEdit'), CELLS.indexOf('function exitEdit'));
  assert.match(enter, /await deps\.onNeedEditor\(\)/, '没 await onNeedEditor()');
  const beforeAwait = enter.slice(0, enter.indexOf('await deps.onNeedEditor()'));
  assert.ok(!/customElements/.test(beforeAwait),
    'await 之前同步查 customElements —— 页面刚开时脚本懒加载未注册，首次点击会被判死');
  // 装配层返回 Promise
  assert.match(PR, /onNeedEditor: function \(\) \{ return ensureEditor\(\); \}/,
    'pack-runtime 的 onNeedEditor 没返回 Promise');
  const canEditRaw = PR.slice(PR.indexOf('canEdit: function ()'), PR.indexOf('onNeedEditor:'));
  const canEdit = canEditRaw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/customElements/.test(canEdit),
    'canEdit 里还有 customElements 粗门控 —— 会把首次点击挡在 enterEdit 之前');
  // 等待失败要亮原因，不能静默
  assert.match(enter, /编辑器载入失败/, 'onNeedEditor 抛错时没给读者看原因');
});

test('三道杠：注入 CSS 用 display:flex !important 压住 MathLive 的 inline 隐藏', () => {
  // 真凶：mathlive-browser.min.js 的 _t() 在 offsetWidth<50 时写
  // [part=menu-toggle].style.display="none"；nb-tex 在 hidden 面板里宽度 0 必命中。
  const cfg = PR.slice(PR.indexOf('function configureMathField('), PR.indexOf('function refreshMathFieldChrome'));
  assert.match(cfg, /"\.ML__menu-toggle \{",/, 'menu-toggle 规则块不见了');
  assert.match(cfg, /"  display: flex !important;",/,
    '缺 display:flex !important —— 只写 color/opacity 压不住 inline display:none（上一轮就是这么错的）');
  assert.ok(!/"[^"]*\.ML__menu-toggle[^"]*\{",[\s\S]{0,240}?"  display: none/.test(cfg),
    'menu-toggle 规则块里又写了 display:none');
  // refreshMathFieldChrome 必须清 inline 并触发重算，且三处都被调用
  const refresh = PR.slice(PR.indexOf('function refreshMathFieldChrome('), PR.indexOf('function configureAllMathFields'));
  assert.match(refresh, /removeProperty\("display"\)/, '没清 MathLive 写的 inline display');
  assert.match(refresh, /dispatchEvent\(new Event\("resize"\)\)/, '没触发 MathLive 重算');
  const openPanel = PR.slice(PR.indexOf('function openPanel('), PR.indexOf('function bindNotebookBlock'));
  assert.match(openPanel, /refreshMathFieldChrome\(\$\("nb-tex"\)\)/,
    '笔记本面板打开时没重算 —— 面板隐藏宽度为 0 时按钮已被 inline 藏掉');
  assert.match(cfg, /refreshMathFieldChrome\(mf\)/, 'shadowRoot 就绪时没补一次 refresh');
  assert.match(CELLS, /__refreshMathFieldChrome/, '进编辑态没调 refresh');
  assert.match(PR, /window\.__refreshMathFieldChrome = refreshMathFieldChrome/,
    'refresh 没挂 window —— formula-cells 是独立模块，拿不到局部函数');
});

test('虚拟键盘仍然全站关闭（三道杠回归不许把真凶放出来）', () => {
  const cfg = PR.slice(PR.indexOf('function configureMathField('), PR.indexOf('function refreshMathFieldChrome'));
  assert.match(cfg, /"  display: none !important;",/, '虚拟键盘按钮没被藏');
  assert.match(cfg, /\.ML__virtual-keyboard-toggle/, '虚拟键盘规则整块丢了');
  // 菜单/工具栏弹层尺寸兜底还在
  assert.match(cfg, /max-height: 60vh/, '菜单弹层的尺寸兜底丢了');
  assert.match(CELLS, /setAttribute\('math-virtual-keyboard-policy', 'manual'\)/,
    '页内 math-field 没设 manual policy');
});

test('detach 必须清掉装配层的全局「正在编辑」标记（SPA 换页不残留）', () => {
  // 2026-11-06 CDP 实测：detach() 不再逐格 exitEdit 后，document.body 上的
  // data-fcell-editing 仍然是 "1" —— 下一页会以为还有格子在编辑。
  const fn = CELLS.slice(CELLS.indexOf('function detach()'), CELLS.indexOf('function destroy()'))
    .replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(fn, /onEditToggle\(false\)/,
    'detach 没通知装配层退出编辑态 —— document.body[data-fcell-editing] 会残留在 1');
  assert.ok(!/exitEdit/.test(fn), 'detach 不该再逐格重绘（SPA 换页后 wrap 马上丢弃）');
});

test('不变量①仍成立：原 katex 常驻、不许删/替换/改 innerHTML', () => {
  assert.ok(!/anchor\.remove\(\)/.test(CELLS), '删了原 katex');
  assert.ok(!/replaceWith\(/.test(CELLS), '替换了原 katex');
  assert.ok(!/anchor\.innerHTML\s*=/.test(CELLS), '改了原 katex 的 innerHTML');
  // 重绘只写副本
  const repaint = CELLS.slice(CELLS.indexOf('function repaint('), CELLS.indexOf('function showCellError'));
  assert.match(repaint, /cell\.painted\.innerHTML = html/, '重绘没写副本');
});

// ── 变异自证（手工跑法，不进 CI）────────────────────────────────────
// 逐条临时改坏，node --test plugins/edit-state.test.mjs 必须红，然后还原：
//   ① 把 "  display: flex !important;", 删掉        → 三道杠那条红
//   ② 把 await deps.onNeedEditor() 的 await 去掉    → 首次点击那条红
//   ③ 在 wrapOne 里加一句 anchor.style.display=''    → 零内联 display 那条红
//   ④ 把 STATE_TRANSITIONS 里 editing: [] 改坏      → 转换表那条红
//   ⑤ 删掉 CSS 的 .fcell-painted:empty 规则          → CSS 派生那条红
// 这是「闸门真的能拦住回归」的证据，不是「测试写完了」的证据。
