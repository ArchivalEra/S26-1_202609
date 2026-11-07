// 公式单元格（`站点/plugins/formula-cells.mjs`）的契约闸门。
//
// ## 这个模块承担什么
//
// 站长 2026-10-31 定案：从「点开覆盖层才能用」改成**页内笔记本式**——
// 每个公式旁边出播放按钮、点公式本体原地编辑、结果出在公式下方独立区域。
//
// 它是个**深模块**：接口只有 attach/detach/setAutoCompute/refresh，
// 但内部要管单元格生命周期、MathLive 实例、IntersectionObserver（只算可见）、
// 结果缓存（同一串不重算）、SPA 换页拆除。所以它值得单独守。
//
// ## 2026-11-06 重构：编辑态成为一个显式状态
//
// 站长实测「编辑一遍保存后就不让编辑了」+「编辑仍然无法使用」+「三道杠全站迷失」。
// 根因不是某一行写错，是**编辑态从来不是一个状态**：6 处分头写的内联
// style.display 加上 cell.editing / cell.mf / cell.currentTex 一堆并行信号，
// 它们必然漂移。现在 `wrap[data-fcell-state]` 是唯一真相，
// setState() 是唯一写入点，显示层全由 CSS 属性选择器派生。
//
// ## 五条不变量（改这个模块的人必须知道）
//
// ① **MCP 读面不动**：绝不替换/删除原来的 `.katex` 节点，也不改它的
//    `data-math-plain` / `data-math-tex`。单元格是**包在外层**的容器。
// ② **SPA 安全**：`detach()` 之后不残留 document 级监听与观察者。
// ③ **不重复算**：同一串 LaTeX 只算一次（自动计算时滚动会反复触发）。
// ④ **编辑态单一真相**：一个属性 + 一个写入点 + 一张合法转换表，零内联 display。
// ⑤ **首次点击能进编辑**：onNeedEditor 必须被 await，不许同步检查后直接 return。
//
// ## 这条闸门测什么
//
// 测**结构**（源码里必须有的写法），不测行为——行为要真浏览器（CDP）才能验，
// 那是另一层（`edit-state.test.mjs` 与本地手工复验）。结构断言的价值在于：
// 改动这个模块的人若破坏上面五条不变量里的任何一条，闸门立刻红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, 'formula-cells.mjs'), 'utf8');
const CSS = readFileSync(path.join(HERE, '../assets/theme/shirone-reader.css'), 'utf8');
const PR = readFileSync(path.join(HERE, 'pack-runtime.mjs'), 'utf8');

/** 切出一个具名函数的函数体（到下一个具名函数之前）。 */
function fnBody(src, name, nextName) {
  const a = src.indexOf('function ' + name);
  const b = src.indexOf('function ' + nextName, a + 1);
  assert.ok(a > 0 && b > a, `找不到 ${name} … ${nextName} 的函数区间`);
  return src.slice(a, b);
}

test('不变量①：绝不删除或替换原公式节点（MCP 读面）', () => {
  assert.ok(!/anchor\.remove\(\)/.test(SRC), '不许 remove 原公式节点');
  assert.ok(!/replaceWith\(/.test(SRC), '不许 replaceWith 原公式节点');
  assert.ok(!/anchor\.innerHTML\s*=/.test(SRC), '不许改原公式节点的 innerHTML');
  // 三层显示节点必须常驻：anchor 只 appendChild 一次，不在编辑/退出时增删
  assert.match(SRC, /body\.appendChild\(anchor\)/, 'anchor 没挂进 .fcell-body');
  assert.ok(!/body\.removeChild\(mf\)|mf\.remove\(\)/.test(SRC),
    'math-field 不许在退出编辑时删除 —— 常驻复用才不会重复触发自定义元素 upgrade');
});

test('不变量④：编辑态是单一属性 + 唯一写入点 + 合法转换表', () => {
  // 状态常量与转换表
  assert.match(SRC, /const STATE_DISPLAY = 'display'/, '缺 display 状态常量');
  assert.match(SRC, /const STATE_EDITING = 'editing'/, '缺 editing 状态常量');
  assert.match(SRC, /const STATE_TRANSITIONS = \{[\s\S]*?display: \[STATE_EDITING\][\s\S]*?editing: \[STATE_DISPLAY\]/,
    '没有 display → editing → display 的合法转换表');
  // 唯一真相：现场读属性，不缓存镜像
  assert.match(SRC, /function stateOf\(cell\)[\s\S]*?getAttribute\('data-fcell-state'\)/,
    '缺 stateOf() 或它没现场读 data-fcell-state（缓存镜像会漂移）');
  // 唯一写入点
  assert.match(SRC, /function setState\(cell, next\)/,
    '缺 setState() —— 状态必须只有一个写入点');
  const writes = [...SRC.matchAll(/setAttribute\('data-fcell-state',\s*([^)]+)\)/g)].map((m) => m[1].trim());
  assert.deepEqual(writes.sort(), ['STATE_DISPLAY', 'next'],
    'data-fcell-state 的写入点数量不对：只允许 wrapOne 初始化一次 + setState 一次');
  // 合法转换必须拦住非法跳跃，且不静默吞掉
  const setState = fnBody(SRC, 'setState', 'attach');
  assert.match(setState, /STATE_TRANSITIONS\[cur\]/, 'setState 没查转换表');
  assert.match(setState, /showCellError/, '非法转换没有响亮报错（静默 return 会重演「点了没反应」）');
  // 行为判定都读状态属性，不许再出现 cell.editing 布尔（注释里可以提旧模型）
  const code = SRC.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/cell\.editing/.test(code),
    '又出现了 cell.editing 布尔 —— 那是与属性并行的第二份真相');
  assert.ok(!/cell\.currentTex/.test(code), 'cell.currentTex 是旧模型的多余信号');
});

test('不变量④b：零内联 display —— 谁可见全由 CSS 属性选择器派生', () => {
  // 2026-11-06 的病根就是 6 处分头写的 style.display = …。
  const inline = [...SRC.matchAll(/\.style\.display\s*=/g)];
  assert.deepEqual(inline.map(() => 'style.display ='), [],
    '源码里又出现内联 style.display 写入 —— 编辑态显隐必须由 CSS 按 data-fcell-state 派生');
  // CSS 侧必须为每个状态值都写明三层节点的显隐
  for (const state of ['display', 'editing']) {
    assert.ok(CSS.includes(`.fcell[data-fcell-state="${state}"]`),
      `CSS 里缺 [data-fcell-state="${state}"] 的派生规则`);
  }
  assert.match(CSS, /\.fcell-painted:empty\s*\{\s*display:\s*none/,
    '副本为空时没有藏起来 —— 会显示一个空 span 或遮住原公式');
  assert.match(CSS, /\.fcell-painted:not\(:empty\)\s*\+\s*\.katex\s*\{\s*display:\s*none/,
    '副本有内容时没藏原公式 —— 会同时出现新旧两份');
  assert.match(CSS, /\[data-fcell-state="editing"\][\s\S]{0,120}\.fcell-painted[\s\S]{0,120}display:\s*none/,
    '编辑态没藏重绘副本');
  assert.match(CSS, /\[data-fcell-state="editing"\][\s\S]{0,120}\.katex\s*\{\s*display:\s*none/,
    '编辑态没藏原公式');
});

test('不变量⑤：首次点击能进编辑 —— onNeedEditor 必须被 await', () => {
  // 旧实现：同步调 onNeedEditor()、紧接着同步查 customElements ⇒ 第一次必假，
  // 直接 showCellError 后 return 且不重试。站长看到的就是「编辑仍然无法使用」，
  // 而 MathLive 其实已经加载好（右键菜单都能弹）。
  const enter = SRC.slice(SRC.indexOf('async function enterEdit'), SRC.indexOf('function exitEdit'));
  assert.ok(enter.length > 100, '找不到 async enterEdit 的函数体');
  assert.match(enter, /await deps\.onNeedEditor\(\)/,
    '没有 await onNeedEditor() —— 首次点击会在脚本就绪前被同步判死');
  // await 之前不许再有同步查 customElements 的早退（旧实现正是这样）
  const beforeAwait = enter.slice(0, enter.indexOf('await deps.onNeedEditor()'));
  assert.ok(!/customElements/.test(beforeAwait),
    'await 之前还在同步查 customElements —— 那会在脚本就绪前把首次点击判死');
  // 装配层必须返回 Promise，且粗门控不许再拦 customElements
  assert.match(PR, /onNeedEditor: function \(\) \{ return ensureEditor\(\); \}/,
    'pack-runtime 的 onNeedEditor 没返回 ensureEditor() 的 Promise');
  const canEditRaw = PR.slice(PR.indexOf('canEdit: function ()'), PR.indexOf('onNeedEditor:'));
  const canEdit = canEditRaw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/customElements/.test(canEdit),
    'canEdit 粗门控还在查 customElements —— 页面刚开时脚本懒加载未注册，会把首次点击挡在 enterEdit 之前');
});

test('不变量②：detach 必须断开观察者并清空 Map（SPA 换页防泄漏）', () => {
  const fn = fnBody(SRC, 'detach', 'destroy').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(fn, /io\.disconnect\(\)/, 'detach 没断开 IntersectionObserver');
  assert.match(fn, /cells\.clear\(\)/, 'detach 没清空 cells Map（旧节点引用会留着）');
  assert.match(fn, /clearTimeout/, 'detach 没清排队定时器');
  assert.ok(!/exitEdit/.test(fn), 'detach 不该再触发重绘 —— SPA 换页后 wrap 马上被丢弃');
});

test('不变量③：同一串 LaTeX 不重复算', () => {
  assert.match(SRC, /lastComputedFor/, '没有「上次算的是哪串」的记录');
  assert.match(SRC, /cell\.lastComputedFor === tex/, '没有跳过同串重算的判据');
});

test('自动计算只算可见的（IntersectionObserver，不是整页遍历）', () => {
  assert.match(SRC, /new IntersectionObserver\(/, '没建 IntersectionObserver');
  assert.match(SRC, /rootMargin:/, '没设 rootMargin（滚到位时结果应已就绪）');
  assert.match(SRC, /if \(!e\.isIntersecting\) continue;/, '没按可见性过滤');
});

test('自动计算遇到算不了的公式要静默（不把版面铺满红字）', () => {
  // 2026-10-31 实测：一页 283 条公式里多数含裸变量、算不了；自动计算若把
  // 「符号没有数值」全部显示出来，可见区 10 条里 8 条红字，比公式本身还吵。
  assert.match(SRC, /quiet/, '没有 quiet 模式');
  const fn = SRC.slice(SRC.indexOf('} else if (quiet)'), SRC.indexOf('} else {', SRC.indexOf('} else if (quiet)')));
  assert.match(fn, /result\.hidden = true/, 'quiet 模式下算不了的结果没有收起');
});

test('编辑入口只有一个：旧覆盖层路径必须已删除（两套并存必漏）', () => {
  // 2026-10-31 站长报「没有开启的时候也能点击公式编辑」。根因是 pack-runtime 里
  // 还留着旧的 openEditor/bindFormulaClicks —— 它用 document 的**捕获阶段**监听，
  // 先于单元格触发，于是新开关拦得住单元格、拦不住它。
  assert.ok(!/function openEditor/.test(PR), '旧覆盖层 openEditor 又回来了');
  assert.ok(!/function bindFormulaClicks/.test(PR), '旧绑定 bindFormulaClicks 又回来了');
  assert.ok(!/openEditor\(tex, el\)/.test(PR), '还在调用旧的 openEditor');
  assert.match(SRC, /body\.addEventListener\('click'/,
    '编辑入口没挂在常驻的 .fcell-body 上 —— 显示层切换会丢监听');
  assert.ok(!/anchor\.addEventListener\('click'/.test(SRC),
    '编辑入口还挂在原 anchor 上 —— 副本显示时 anchor 是藏的，点不到');
});

test('开关关掉时必须收回单元格（detach），不是只翻个 UI 状态', () => {
  // 站长原话：「开关关掉的时候也要坦荡收回啊」。
  const i = PR.indexOf('prefs.allowEdit = !!ae.checked');
  assert.ok(i > 0, '找不到 allowEdit 的 change 处理器');
  const seg = PR.slice(i, i + 900);
  assert.match(seg, /else if \(cells\)/, '关掉开关时没有收回分支');
  assert.match(seg, /cells\.detach\(\)/, '关掉开关时没有真的 detach');
});

test('mountCells 必须按开关门控（关着不许挂单元格）', () => {
  const i = PR.indexOf('function mountCells()');
  const seg = PR.slice(i, i + 700);
  assert.match(seg, /if \(!prefs\.allowEdit\)/, 'mountCells 没检查 allowEdit —— 开关关着也会冒出播放按钮');
});

test('compute 是注入的，不在模块里读全局（node 里能测）', () => {
  assert.match(SRC, /deps\.compute/, '没从 deps 取 compute');
  assert.ok(!/window\.__packCompute/.test(SRC),
    '模块里直接读 window.__packCompute —— 那 node 里不可测，且把装配层的责任漏进来');
});

