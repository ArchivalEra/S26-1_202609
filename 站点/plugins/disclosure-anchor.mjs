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
 * 1) **宿主框架零改动**：assets/theme/shirone-reader.js 一个字不动。
 *    本文件是唯一实现，与宿主的接缝只有 build.mjs 里的两行——
 *    把 DISCLOSURE_ANCHOR_JS 写成 dist 资产 + 在页面尾加一个 <script>。
 *    删掉本文件并摘掉那两行，行为即回退（锚点仍能滚动定位，
 *    只是收起的面板需要手动点开）。
 *
 * 2) 与 collapse.mjs 的分工：collapse.mjs 负责把 Markdown 变成
 *    原生 <details> 并支持 {#id} 锚点语法，**零 JavaScript**；
 *    本模块是可选的渐进增强——没有它页面照样工作，有它深链接体验完整。
 *
 * 3) 刻意只做一件事：不注入样式（:target 高亮走 shirone-reader.css 里的
 *    原生 CSS）、不监听滚动、不改 URL。打开目标面板及其祖先即止。
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
    for (var node = el; node; node = node.parentElement) {
      if (node.tagName === "DETAILS" && !node.open) node.open = true;
    }
  }
  window.addEventListener("DOMContentLoaded", openTarget);
  window.addEventListener("hashchange", openTarget);
}());`;
