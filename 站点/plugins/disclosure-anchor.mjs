/**
 * 折叠面板深链接（disclosure anchor）—— 独立可拆卸模块
 *
 * 解决的问题：其他页面用 [xxx](攻略.md#pass-1-2) 深链接到某个 <details>
 * 折叠面板时，浏览器只会把面板标题滚进视口——面板默认**收起**，
 * 学生看到的是一个被高亮的、内容看不见的面板。
 * 本模块在页面载入与 hash 变化时，把 hash 指向的 <details> 及其祖先
 * 自动展开，让「跳转到位」和「内容可见」同时成立。
 *
 * ============================ 架构约束 ============================
 *
 * 1) **本模块不需要改宿主**：与宿主的接缝只有 build.mjs 里的两行——
 *    把 DISCLOSURE_ANCHOR_JS 写成 dist 资产 + 在页面尾加一个 <script>。
 *    删掉本文件并摘掉那两行，行为即回退（锚点仍能滚动定位，
 *    只是收起的面板需要手动点开）。
 *    （宿主 shirone-reader.js 的滚动高亮同样围绕折叠面板修过一处，见该文件
 *    ScrollSpy 段注释——那是独立的一处宿主改动，与「本模块的接缝」无关。）
 *
 * 2) 与 collapse.mjs 的分工：collapse.mjs 负责把 Markdown 变成
 *    原生 <details> 并支持 {#id} 锚点语法，**零 JavaScript**；
 *    本模块是可选的渐进增强——没有它页面照样工作，有它深链接体验完整。
 *
 * 3) 刻意只做一件事：不注入样式（:target 高亮走 shirone-reader.css 里的
 *    原生 CSS）、不监听滚动、不改 URL。打开目标面板及其祖先，若因此改变了
 *    布局就补一次重滚（见下）。
 *
 * ==================== 2026-10-13 修「跟着算一遍」锚点漂移 ====================
 * 用户报：右侧目录里「跟着算一遍」相关条目点下去落点会漂。根因是那些标题是
 * **收起面板里的 `<h3>`**——原生锚点滚动按「面板收起」的几何算落点（标题落到
 * y≈0、被固定顶栏盖住），本模块随后展开面板、整页回流，落点再偏一截，两个误差
 * 叠加。修法两半：
 *   ① 样式侧给所有带 id 的元素加 `scroll-margin-top`（=顶栏高 + 余量，见
 *      shirone-reader.css 的 `.article-content [id]` 规则），让落点稳定留出顶栏；
 *   ② 本模块在**展开过面板之后**用 rAF 等布局完成、再重滚一次，因为展开改变了
 *      目标自身的文档位置。面板本就开着时不重滚，交还浏览器原生滚动。
 */

export const DISCLOSURE_ANCHOR_JS = String.raw`(/* disclosure-anchor: 深链接到收起面板时自动展开（独立插件模块，构建期内联） */
function () {
  "use strict";
  function openTarget() {
    var raw = window.location.hash.slice(1);
    if (!raw) return;
    var id;
    try { id = decodeURIComponent(raw); } catch (e) { id = raw; }
    var el = document.getElementById(id);
    if (!el) return;
    // 目标面板与它的祖先面板都要展开，否则目标仍然不可见
    var opened = false;
    for (var node = el; node; node = node.parentElement) {
      if (node.tagName === "DETAILS" && !node.open) { node.open = true; opened = true; }
    }
    // 展开改变了布局：原生锚点滚动按「展开前」几何算的落点已经不准，重滚一次。
    // rAF 等一帧，确保 <details> 展开（含 accordion 同组兄弟收起）的布局已完成；
    // 顶栏留白由 CSS 的 scroll-margin-top 提供。面板本就开着时不抢用户的滚动。
    if (opened) {
      requestAnimationFrame(function () {
        try { el.scrollIntoView({ block: "start" }); } catch (e) { el.scrollIntoView(); }
      });
    }
  }

  // SPA 换页钩子：手动触发深链接展开（spa-router 调用；hash 可选）
  window.__disclosureOpen = function (hash) {
    if (hash) { try { location.hash = hash; } catch (e) {} }
    openTarget();
  };
  window.addEventListener("DOMContentLoaded", openTarget);
  window.addEventListener("hashchange", openTarget);
}());`;
