/**
 * 站点语义工具：把页面的**交互能力**注册成 WebMCP 工具（独立可拆卸模块）。
 *
 * 与 `工具/mcp-端点/`（读层）的分工：
 *   - **读层**给「内容」——搜全站、取正文、查符号，不需要浏览器；
 *   - **本模块**给「交互」——跳锚点、开搜索面板、展开折叠、查页面上的符号，
 *     这些只有在**打开的页面上**才有意义。
 *
 * ## 为什么用 DOM 接口而不是内部 API
 * 站点的搜索/气泡/折叠模块都只暴露**纯函数**（`window.__siteSearch` 那类），
 * 没有「跑一次搜索」「弹一个气泡」的编程入口。所以工具走 DOM：
 * 点按钮、填输入框、派发事件——**与真人操作同一条路径**，
 * 不依赖任何模块的内部实现，模块改了也不容易坏。
 *
 * ## 工具清单（名字带 `site_` 前缀，避与读层的 `course_`、relay 的 `webmcp_` 相撞）
 *   site_get_page_info  当前页信息（标题、课程、类别、小节清单）
 *   site_open_section   跳到某小节（按标题或锚点）
 *   site_search         用页面自带的搜索面板搜（返回命中标题与链接）
 *   site_show_symbol    查页面上某个符号（点开它的气泡）
 *   site_toggle_panels  展开/收起全部折叠面板
 */

/** 站点工具的源码（构建期内联；浏览器端执行）。 */
export const WEBMCP_TOOLS_JS = `(function () {
"use strict";
if (typeof navigator === "undefined") return;
var mc = navigator.modelContext;
if (!mc || typeof mc.registerTool !== "function") return;   // 没有 WebMCP 就什么都不做

function text(el) { return el ? (el.textContent || "").trim() : ""; }

function headings() {
  return Array.prototype.slice.call(document.querySelectorAll(".article-content h2, .article-content h3, .article-content h4"))
    .map(function (h) { return { level: Number(h.tagName.slice(1)), title: text(h), anchor: h.id }; })
    .filter(function (h) { return h.title; });
}

function pageInfo() {
  var chip = document.querySelector(".meta-chip");
  return {
    title: (document.querySelector(".article-content h1") ? text(document.querySelector(".article-content h1")) : document.title),
    course: chip ? text(chip).replace(/^\\u{1F4DA}\\s*/u, "") : "",
    url: location.href,
    sections: headings(),
  };
}

function openSection(byTitle, byAnchor) {
  var list = headings();
  var target = null;
  if (byAnchor) {
    target = document.getElementById(byAnchor);
  } else if (byTitle) {
    var needle = String(byTitle).trim();
    var hit = list.filter(function (h) { return h.title.indexOf(needle) >= 0; });
    if (hit.length) target = document.getElementById(hit[0].anchor);
  }
  if (!target) return { ok: false, reason: "not_found", available: list.map(function (h) { return h.title; }).slice(0, 30) };
  // 展开它所在的折叠面板（与深链接同一条路径），再滚动
  for (var node = target; node; node = node.parentElement) {
    if (node.tagName === "DETAILS" && !node.open) node.open = true;
  }
  try { target.scrollIntoView({ block: "start" }); } catch (e) { target.scrollIntoView(); }
  return { ok: true, title: text(target), anchor: target.id };
}

function togglePanels(open) {
  var ds = Array.prototype.slice.call(document.querySelectorAll("details"));
  var want = (open === undefined) ? null : !!open;
  ds.forEach(function (d) { d.open = (want === null) ? !d.open : want; });
  return { count: ds.length, open: want === null ? "toggled" : want };
}

function showSymbol(term) {
  var needle = String(term || "").trim();
  if (!needle) return { ok: false, reason: "empty_term" };
  var nodes = Array.prototype.slice.call(document.querySelectorAll(".katex [data-term]"));
  var found = nodes.filter(function (n) {
    return (n.getAttribute("data-term") || "").indexOf(needle) >= 0
      || text(n).indexOf(needle) >= 0;
  });
  if (!found.length) return { ok: false, reason: "symbol_not_on_page", total: nodes.length };
  var el = found[0];
  el.scrollIntoView({ block: "center" });
  // 走与真人点击同一条路径
  var ev = new MouseEvent("click", { bubbles: true, cancelable: true, view: window });
  el.dispatchEvent(ev);
  var bubble = document.querySelector(".glossary-bubble, .sym-bubble, [class*=bubble]");
  return { ok: true, term: el.getAttribute("data-term"), bubble: text(bubble).slice(0, 400) };
}

function siteSearch(query) {
  var q = String(query || "").trim();
  if (!q) return { ok: false, reason: "empty_query" };
  var panel = document.getElementById("search-panel");
  var input = document.getElementById("search-input");
  if (!input) return { ok: false, reason: "search_ui_missing" };
  if (panel) panel.hidden = false;
  input.focus();
  input.value = q;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return new Promise(function (resolve) {
    setTimeout(function () {
      var hits = Array.prototype.slice.call(document.querySelectorAll(".search-hit")).map(function (a) {
        return { title: text(a.querySelector(".search-hit-title")), href: a.getAttribute("href") };
      });
      var txt = text(document.getElementById("search-results"));
      var m = txt.match(/共\\s*(\\d+)\\s*页命中/);
      resolve({ ok: true, query: q, total: m ? Number(m[1]) : hits.length, hits: hits.slice(0, 12) });
    }, 1200);
  });
}

var defs = [
  { name: "site_get_page_info", description: "取当前页的信息：标题、所属课程、小节清单（含锚点）。",
    inputSchema: { type: "object", properties: {} },
    execute: function () { return pageInfo(); } },
  { name: "site_open_section", description: "跳到本页的某个小节（按标题片段或锚点 id），会自动展开折叠面板。",
    inputSchema: { type: "object", properties: { title: { type: "string" }, anchor: { type: "string" } } },
    execute: function (a) { return openSection(a && a.title, a && a.anchor); } },
  { name: "site_search", description: "用页面自带的搜索面板搜全站，返回命中标题与链接。",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    execute: function (a) { return siteSearch(a && a.query); } },
  { name: "site_show_symbol", description: "查本页上某个符号的含义（点开它的气泡），返回气泡文字。",
    inputSchema: { type: "object", properties: { term: { type: "string" } }, required: ["term"] },
    execute: function (a) { return showSymbol(a && a.term); } },
  { name: "site_toggle_panels", description: "展开或收起本页全部折叠面板（不传 open 则切换）。",
    inputSchema: { type: "object", properties: { open: { type: "boolean" } } },
    execute: function (a) { return togglePanels(a && a.open); } },
];

defs.forEach(function (d) {
  try { Promise.resolve(mc.registerTool(d)).catch(function () {}); } catch (e) {}
});
})();`;
