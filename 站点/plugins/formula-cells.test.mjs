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
// ## 三条不变量（改这个模块的人必须知道）
//
// ① **MCP 读面不动**：绝不替换/删除原来的 `.katex` 节点，也不改它的
//    `data-math-plain` / `data-math-tex`。单元格是**包在外层**的容器。
// ② **SPA 安全**：`detach()` 之后不残留 document 级监听与观察者。
// ③ **不重复算**：同一串 LaTeX 只算一次（自动计算时滚动会反复触发）。
//
// ## 这条闸门测什么
//
// 测**结构**（源码里必须有的写法），不测行为——行为要真浏览器（Playwright）
// 才能验，那是另一层。结构断言的价值在于：改动这个模块的人若破坏上面三条
// 不变量里的任何一条，闸门立刻红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, 'formula-cells.mjs'), 'utf8');

test('不变量①：绝不删除或替换原公式节点（MCP 读面）', () => {
  // 编辑时原 .katex 只能 display:none，不能 remove / replaceWith / innerHTML 清空
  assert.ok(!/anchor\.remove\(\)/.test(SRC), '不许 remove 原公式节点');
  assert.ok(!/replaceWith\(/.test(SRC), '不许 replaceWith 原公式节点');
  assert.ok(!/anchor\.innerHTML\s*=/.test(SRC), '不许改原公式节点的 innerHTML');
  assert.match(SRC, /anchor\.style\.display\s*=\s*['"]none['"]/,
    '编辑态应把原节点 display:none 藏起来（而不是删掉）');
});

test('不变量②：detach 必须断开观察者并清空 Map（SPA 换页防泄漏）', () => {
  const fn = SRC.slice(SRC.indexOf('function detach()'), SRC.indexOf('function destroy()'));
  assert.match(fn, /io\.disconnect\(\)/, 'detach 没断开 IntersectionObserver');
  assert.match(fn, /cells\.clear\(\)/, 'detach 没清空 cells Map（旧节点引用会留着）');
  assert.match(fn, /clearTimeout/, 'detach 没清排队定时器');
});

test('不变量③：同一串 LaTeX 不重复算', () => {
  assert.match(SRC, /lastComputedFor/, '没有「上次算的是哪串」的记录');
  assert.match(SRC, /cell\.lastComputedFor === tex/, '没有跳过同串重算的判据');
});

test('自动计算只算可见的（IntersectionObserver，不是整页遍历）', () => {
  assert.match(SRC, /new IntersectionObserver\(/, '没建 IntersectionObserver');
  assert.match(SRC, /rootMargin:/, '没设 rootMargin（滚到位时结果应已就绪）');
  // 断言它真的按 isIntersecting 过滤，而不是把 entries 全算
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
  // 两套机制并存 = 两套判据 = 必然有一个漏，这是本仓反复吃过的教训。
  const pr = readFileSync(path.join(HERE, 'pack-runtime.mjs'), 'utf8');
  assert.ok(!/function openEditor/.test(pr), '旧覆盖层 openEditor 又回来了');
  assert.ok(!/function bindFormulaClicks/.test(pr), '旧绑定 bindFormulaClicks 又回来了');
  assert.ok(!/openEditor\(tex, el\)/.test(pr), '还在调用旧的 openEditor');
});

test('开关关掉时必须收回单元格（detach），不是只翻个 UI 状态', () => {
  // 站长原话：「开关关掉的时候也要坦荡收回啊」。
  // 第一版 change 处理器只有 if、没有 else —— 关掉后播放按钮与原地编辑全都还在。
  const pr = readFileSync(path.join(HERE, 'pack-runtime.mjs'), 'utf8');
  const i = pr.indexOf('prefs.allowEdit = !!ae.checked');
  assert.ok(i > 0, '找不到 allowEdit 的 change 处理器');
  const seg = pr.slice(i, i + 900);
  assert.match(seg, /else if \(cells\)/, '关掉开关时没有收回分支');
  assert.match(seg, /cells\.detach\(\)/, '关掉开关时没有真的 detach');
});

test('mountCells 必须按开关门控（关着不许挂单元格）', () => {
  const pr = readFileSync(path.join(HERE, 'pack-runtime.mjs'), 'utf8');
  const i = pr.indexOf('function mountCells()');
  const seg = pr.slice(i, i + 700);
  assert.match(seg, /if \(!prefs\.allowEdit\)/, 'mountCells 没检查 allowEdit —— 开关关着也会冒出播放按钮');
});

test('compute 是注入的，不在模块里读全局（node 里能测）', () => {
  assert.match(SRC, /deps\.compute/, '没从 deps 取 compute');
  assert.ok(!/window\.__packCompute/.test(SRC),
    '模块里直接读 window.__packCompute —— 那 node 里不可测，且把装配层的责任漏进来');
});

test('不变量④：编辑入口不许挂在「会被隐藏的那份节点」上（否则第二遍点不进去）', () => {
  // ## 2026-11-06 站长实弹：「公式编辑一遍保存后就不让编辑了」
  //
  // 病因链：
  //   ① 退出编辑时为了显示改后的内容，在 anchor 旁边插了重绘副本 `.fcell-painted`，
  //      并把原 anchor 设成 display:none（不变量①不许删它）；
  //   ② 「点公式进编辑」的 click 监听**只挂在原 anchor 上**；
  //   ③ 读者看到、点到的是副本 ⇒ 副本没有监听 ⇒ 第二遍点了没反应。
  //
  // 判据：click 监听必须挂在**容器 body**（它不随显示层切换而变），
  // 而不是挂在 anchor 上。
  assert.match(SRC, /body\.addEventListener\('click'/,
    '编辑入口没挂在 .fcell-body 上 —— 换成重绘副本后读者就点不动了');
  assert.ok(!/anchor\.addEventListener\('click'/.test(SRC),
    '编辑入口还挂在原 anchor 上 —— anchor 退出编辑后是 display:none，副本上没有监听，第二遍点不进去');
  // 进编辑时必须把重绘副本也藏起来，否则编辑态里「旧显示 + 编辑器」并排两份
  const enter = SRC.slice(SRC.indexOf('function enterEdit'), SRC.indexOf('function exitEdit'));
  assert.match(enter, /fcell-painted/,
    'enterEdit 没处理重绘副本 —— 再进编辑时副本会和 math-field 并排显示两份公式');
  assert.match(enter, /painted\.style\.display\s*=\s*'none'/,
    'enterEdit 没把重绘副本藏起来');
  // 退出编辑重绘时必须把副本显示恢复（否则第二次「改完退出」屏幕全空）
  const exit = SRC.slice(SRC.indexOf('function exitEdit'), SRC.indexOf('function showCellError'));
  assert.match(exit, /painted\.style\.display\s*=\s*''/,
    'exitEdit 重绘后没恢复副本显示 —— 副本在 enterEdit 里被藏过，不恢复就什么都看不见');
});
