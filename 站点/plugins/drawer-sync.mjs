// drawer-sync.mjs —— 移动端抽屉导航的唯一负责人（2026-10-17 简化重构；
// 2026-10-21 阶段一：active 判定改读侧栏形状 JSON，删掉 a[data-path] 全等比对）。
//
// ## 为什么存在（用户三报「手机上强调色还是错的」后重写）
// 「点完链接抽屉应该怎样」原先没有主人：shirone 只管 open class 开关，
// spa-router 只管 active 重算，结果手机端 SPA 换页后抽屉开着盖住半屏、
// 抽屉滚动位置停在旧页——新强调栏在视口外，用户看到的就是「强调色消失」。
//
// 本模块把三件事收拢为一个深接口：
//   window.__drawerSync.onNavigate()   SPA 换页后调（spa-router 里只有这一行）
//   window.__drawerSync.sync()         手动刷新（调试/将来入口用）
// 做的事：
//   ① active 重算（**读侧栏形状 JSON + 共享判定**，见下）
//   ② ≤860px 自动关抽屉（点完链接正文直接可见，移动端 SPA 的核心体验）
//   ③ 重开抽屉时滚动到 active 链接（强调栏永远在视口内）
//
// ## active 判定（阶段一，2026-10-21）
// 不再收集 `a[data-path]` 做全等比对——那与渲染、构建各解析一遍同一份 DOM。
// 现在 DOM 里只带 `data-path`（给 SPA 拼 URL 用），**active 靠 id 对齐**：
//   ① 读 `#nav-structure-json`（nav-structure.mjs 烘焙的归一化树，带稳定 id）；
//   ② 用 nav-structure 的共享判定（__navStructure.collectActive，由真函数派生）
//      按**当前** body[data-site-path] 重算 active/expanded 的 id 集合；
//      （烘焙的 activeIds 是首屏页的——SPA 换页后必须重算，所以用共享函数而非烤死的值）
//   ③ 每个 `<li>` 打上 data-node-id（构建期 renderNav 写），据此 toggle active/expanded。
// 判定只此一处（nav-structure.mjs），DOM class 名不再是隐式契约。
//
// 可拆卸：删掉本文件、build.mjs 的写盘行、spa-router 里的一行调用即回退。

export const DRAWER_SYNC_JS = String.raw`(function () {
"use strict";
if (typeof window === "undefined" || window.__drawerSync) return;

var MOBILE_MAX = 860; // 与 shirone-reader.css 的断点一致

/** active/expanded 重算：读 JSON + 共享判定按当前页重算 id，再对齐到 DOM 的 data-node-id。 */
function recompute() {
  var nav = window.__navStructure;
  var json = nav && nav.readNavJson ? nav.readNavJson() : null;
  if (!json || !json.nodes) return undefined; // 无侧栏形状 ⇒ 不动（保留烘焙态）
  var here = document.body.getAttribute("data-site-path") || "";
  // 共享判定（html 空间）——与构建期 activeIds 同一份实现。
  var state = nav.collectActive(json.nodes, here, true);
  var activeIds = {}; for (var i = 0; i < state.activeIds.length; i++) activeIds[state.activeIds[i]] = 1;
  var expandedIds = {}; for (var k = 0; k < state.expandedIds.length; k++) expandedIds[state.expandedIds[k]] = 1;

  var lis = document.querySelectorAll("li[data-node-id]");
  var hit = null;
  for (var j = 0; j < lis.length; j++) {
    var li = lis[j];
    var id = li.getAttribute("data-node-id");
    var on = !!activeIds[id];
    // ⚠️ 2026-10-21 阶段一：**组节点也能 active**。
    // 旧世界组节点无链接、永远不是当前页，所以这里写死 drawer-nav-item 就够了；
    // 现在组节点带 indexHref（索引页可达），停在索引页时该组必须高亮——
    // 否则「点索引 › 进去，左侧一片没有强调」，正是用户会立刻发现的那种坏。
    var isGroup = li.classList.contains("drawer-nav-group");
    var liActive = on;
    var liExpanded = isGroup && !!expandedIds[id];
    li.classList.toggle("active", liActive);
    if (isGroup) {
      li.classList.toggle("expanded", liExpanded);
      li.classList.toggle("collapsed", !liExpanded);
    }
    if (liActive && !hit) hit = li.querySelector("a.drawer-nav-link") || li.querySelector("a.nav-index-link");
  }
  return hit;
}

/** 抽屉滚动到 active 链接可见（居中最佳，clamp 兜底）。 */
function scrollIntoView(link) {
  if (!link) return;
  var area = document.querySelector(".drawer-nav-scroll-area");
  if (!area) return;
  var lr = link.getBoundingClientRect();
  var ar = area.getBoundingClientRect();
  // 链接不在抽屉视口内 ⇒ 滚到居中
  if (lr.top < ar.top || lr.bottom > ar.bottom) {
    area.scrollTop += (lr.top + lr.height / 2) - (ar.top + ar.height / 2);
  }
}

function isMobile() { return window.innerWidth <= MOBILE_MAX; }

/** SPA 换页后：重算 → 手机关抽屉 → （重开时）滚到高亮。 */
function onNavigate() {
  var hit = recompute();
  if (isMobile()) {
    // 点完链接自动合上抽屉——正文直接可见，这是移动端 SPA 的核心交互
    var d = document.querySelector(".m3-drawer");
    var b = document.querySelector(".drawer-backdrop");
    if (d && d.classList.contains("open")) {
      d.classList.remove("open");
      if (b) b.classList.remove("open");
    }
    // 记住高亮位置：用户重开抽屉时滚动到位（shirone 的 toggleDrawer 只开合不滚动）
    if (hit) scrollIntoView(hit);
  }
}

/** 手动刷新：重算 + 滚动（无论端）。 */
function sync() {
  scrollIntoView(recompute());
}

window.__drawerSync = { onNavigate: onNavigate, sync: sync };

// 首屏自调一次（2026-10-21 阶段一补）：active 从「构建期烘焙」改成「运行时按 nav JSON 算」，
// 首屏就没人算了——以前 build.mjs 直接把 active 类写进 HTML，所以不需要这一步。
// 不补的症状：每个页面首屏强调栏全空，只有 SPA 换页后才亮。
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", function () {
    try { recompute(); } catch (e) { /* 不动 */ }
  });
} else {
  try { recompute(); } catch (e) { /* 不动 */ }
}
})();`;