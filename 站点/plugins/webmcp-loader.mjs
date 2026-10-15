/**
 * WebMCP 加载与编排 —— 独立可拆卸模块。
 *
 * ## 为什么按需
 * `@mcp-b/global` 的 polyfill 有 **281 KB**；本站是离线阅读站、一直在控体积
 * （全站配图加起来才 738 KB）。**无条件每页加载不可接受**。
 *
 * ## 为什么由本模块**统管序列**（而不是三个并列 `<script>`）
 * 有个真实的顺序陷阱：polyfill 是**动态加载**的，`document.modelContext` 要等它到位才存在；
 * 而 shim 必须在「任何工具注册之前」包好两个注册表，否则抓不到已注册的工具。
 * 三个并列的 `defer` 脚本会踩这个坑（shim 跑时 polyfill 还没到）。
 * 所以这里按顺序编排：**决定形态 → （必要时）载 polyfill → 注入 shim → 注入 tools**。
 *
 * ## 四种形态
 * | 形态 | 触发 | 做什么 |
 * | :--- | :--- | :--- |
 * | `native-document` | 已有 `document.modelContext`（Chrome 预览版） | 直接注入 shim + tools，不载 polyfill |
 * | `polyfill+shim` | 有 `navigator.modelContext`（Firefox 开了 pref） | 载 polyfill → 注入 shim + tools |
 * | `polyfill-forced` | URL `?webmcp=1` 或 `localStorage.webmcp='on'` | 同上（调试/显式启用） |
 * | `absent` | 都没有且没强制 | **什么都不做**（页面与不带本模块时完全一致） |
 *
 * ## 可拆卸
 * 删掉本文件、build.mjs 的注入段、页面模板里的一行 `<script>` 即回退。
 */

/** 编排器源码（构建期内联；只有这一个脚本进页面，其余按需注入）。 */
export const WEBMCP_LOADER_JS = `(function () {
"use strict";
if (typeof navigator === "undefined" || typeof document === "undefined") return;

var qs = null;
try { qs = new URLSearchParams(location.search); } catch (e) {}
var forced = false;
try { forced = (qs && qs.get("webmcp") === "1") || localStorage.getItem("webmcp") === "on"; } catch (e) {}

var hasDoc = !!document.modelContext;
var hasNav = !!navigator.modelContext;

function baseDir() {
  var s = document.currentScript;
  if (!s || !s.src) {
    var all = document.querySelectorAll("script[src*='webmcp-loader']");
    s = all[all.length - 1];
  }
  return new URL(".", new URL(s.src, location.href)).href;
}

function inject(rel) {
  var el = document.createElement("script");
  el.src = baseDir() + rel;
  el.async = false;
  document.head.appendChild(el);
  return el;
}

function injectPlugins() {
  inject("webmcp-shim.js");
  inject("webmcp-tools.js");
}

if (hasDoc) {                       // 形态 1：原生 document 已就绪
  window.__webmcpMode = "native-document";
  injectPlugins();
} else if (hasNav || forced) {      // 形态 2/3：需要 polyfill
  window.__webmcpMode = hasNav ? "polyfill+shim" : "polyfill-forced";
  var p = inject("../vendor/webmcp/polyfill.iife.js");
  p.onload = function () { injectPlugins(); };
  p.onerror = function () { window.__webmcpMode = "polyfill-failed"; };
} else {                            // 形态 4：都没有
  window.__webmcpMode = "absent";
}
})();`;

/**
 * relay 连接器：把页面接到本机 relay（`webmcp-local-relay`）。
 * **只在显式开启时加载**——relay 是本机进程，不是所有读者都跑。
 *
 * ## 为什么用 document.write 而不是 createElement
 * relay 的 `embed.js` 靠 **`document.currentScript.src`** 定位同目录的 `widget.html`，
 * 拿不到 src 会直接 **throw**（实测踩到：动态 `createElement` 注入时 `currentScript` 为 null，
 * widget iframe 从未被创建、relay 一个页面工具都看不到）。
 * `document.write` 插入的脚本在解析期同步执行，`currentScript` 有效——
 * 但 `document.write` 只在**解析期**可用，所以本脚本必须留在 `defer` 之外同步执行。
 * 为稳妥：解析已结束（`readyState` 非 loading）时退化为 createElement，
 * 并给 embed 传 `data-auto-connect="false"`（加载但不自动连，避免无谓的连接尝试）。
 */
export const WEBMCP_RELAY_JS = `(function () {
"use strict";
if (typeof navigator === "undefined" || typeof document === "undefined") return;
var on = false;
try {
  var qs = new URLSearchParams(location.search);
  on = qs.get("relay") === "1" || localStorage.getItem("webmcp_relay") === "on";
} catch (e) {}
if (!on) return;

var s = document.currentScript;
if (!s || !s.src) {
  var all = document.querySelectorAll("script[src*='webmcp-relay']");
  s = all[all.length - 1];
}
if (!s || !s.src) { window.__webmcpRelay = "no-base"; return; }
var src = new URL("../vendor/webmcp/relay-embed.js", new URL(s.src, location.href)).href;

if (document.readyState === "loading") {
  // 解析期：document.write 让 currentScript 对 embed.js 有效
  document.write('<script src="' + src + '" data-auto-connect="true"><\\/script>');
  window.__webmcpRelay = "written";
} else {
  // 解析已结束：只能动态插入；embed 拿不到 currentScript，但它会退化为「不建 widget」。
  // 这种情况下给用户一个明确信号，而不是静默失败。
  var el = document.createElement("script");
  el.src = src;
  el.setAttribute("data-auto-connect", "true");
  el.onerror = function () { window.__webmcpRelay = "failed"; };
  el.onload = function () { window.__webmcpRelay = "loaded-late"; };
  document.head.appendChild(el);
  window.__webmcpRelay = "late";
}
})();`;
