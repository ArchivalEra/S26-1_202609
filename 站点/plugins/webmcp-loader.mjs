/**
 * WebMCP 加载与编排 —— 独立可拆卸模块。
 *
 * ## 为什么按需
 * `@mcp-b/global` 的 polyfill 有 **281 KB**；本站是离线阅读站、一直在控体积
 * （全站配图加起来才 738 KB）。**无条件每页加载不可接受**。
 *
 * ## 谁来付这 281 KB（2026-10-15 修正的判断）
 * **只有「要用 AI 交互」的人才付**——即 URL 带 `?relay=1`（连本机中继）
 * 或 `?webmcp=1`（显式启用）的人。**不看浏览器的原生能力**：
 * 零 pref 的普通 Firefox **既没有 `navigator.modelContext` 也没有 `document.modelContext`**，
 * 而那正是 polyfill 要造出来的东西——按「有没有原生 API」判断会漏掉最大的那批用户
 * （实测踩到：零设置 Firefox 下形态被判成 `absent`、polyfill 不载、工具全无）。
 *
 * ## 为什么由本模块**统管序列**（而不是三个并列 `<script>`）
 * 顺序陷阱：polyfill 是**动态加载**的，`document.modelContext` 要等它到位才存在；
 * 而 shim 必须在「任何工具注册之前」包好两个注册表，否则抓不到已注册的工具。
 * 所以这里按顺序编排：**判断要不要 → 载 polyfill → 注入 shim → 注入 tools**。
 *
 * ## 四种形态
 * | 形态 | 触发 | 做什么 |
 * | :--- | :--- | :--- |
 * | `native-document` | 已有 `document.modelContext`（Chrome 预览版） | 直接注入 shim + tools，**不载 polyfill** |
 * | `polyfill+wanted` | `?relay=1` / `?webmcp=1` / `localStorage` 开关（**典型场景**） | 载 polyfill → 注入 shim + tools |
 * | `absent` | 没要（普通读者） | **什么都不做**（与不带本模块时完全一致，零请求） |
 *
 * 注：`navigator.modelContext`（Firefox 开了 pref）**不单独触发加载**——
 * 那种环境下用户同样会因为要用而带 `?relay=1`；不带就说明他不需要页面工具。
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
// 「要不要页面工具」由用户**显式表达**：?relay=1（连中继）或 ?webmcp=1（启用），
// 或 localStorage 里的持久开关。**不看浏览器原生能力**——零 pref 的普通 Firefox
// 两者都没有，而那正是 polyfill 要造出来的东西（按原生判断会漏掉这批用户）。
var wanted = false;
try {
  wanted = (qs && (qs.get("relay") === "1" || qs.get("webmcp") === "1"))
    || localStorage.getItem("webmcp") === "on"
    || localStorage.getItem("webmcp_relay") === "on";
} catch (e) {}

var hasDoc = !!document.modelContext;

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
  // ⭐ 2026-10-19：页面桥植入站点（用户定案「每次搭桥太傻逼」）。
  // 工具注册是异步的（registerTool 返回 Promise），桥要等它们进注册表再报到，
  // 所以延后一拍注入。守卫见 shouldBridge()。
  if (shouldBridge()) setTimeout(function () { injectBridge(); }, 300);
}

/**
 * 注入页面桥（2026-10-19 修 P0-2）。
 *
 * 关键：**先把源码取回来塞进 window.__mcpBridgeSource**，再插 <script>。
 * 这样断线看门狗有源码可 eval 重建——旧实现靠 arguments.callee（箭头函数里没有），
 * 源码恒为 null，看门狗自杀后永不重连。
 *
 * 顺带把 token 也塞进 window.__bridgeToken（bridge 启动时写 .bridge-token）。
 */
function injectBridge() {
  var url = baseDir() + "webmcp-bridge.js";
  window.__mcpBridgeReload = url;
  // token：优先 localStorage（用户可手配），否则空（本机开发桥可能未开鉴权）
  try {
    var t = localStorage.getItem("webmcp_bridge_token");
    if (t) window.__bridgeToken = t;
  } catch (e) {}
  fetch(url, { cache: "force-cache" })
    .then(function (r) { return r.text(); })
    .then(function (src) {
      window.__mcpBridgeSource = src;
      var el = document.createElement("script");
      el.src = url;
      el.async = false;
      document.head.appendChild(el);
    })
    .catch(function () {
      // 取源码失败也别放弃：直接插标签，桥本身能跑，只是重建能力退化到 reinjectTag
      var el = document.createElement("script");
      el.src = url;
      el.async = false;
      document.head.appendChild(el);
    });
}

// 只在「本机 / 显式开启」时连桥。线上访客一个请求都不会打到 127.0.0.1。
function shouldBridge() {
  try {
    if (qs && qs.get("bridge") === "1") return true;
    if (localStorage.getItem("webmcp_bridge") === "on") return true;
    // 本机环境默认开（开发/实验）
    return /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
  } catch (e) { return false; }
}

if (hasDoc) {                       // 形态 1：原生已有 document 注册表 → 直接用
  window.__webmcpMode = "native-document";
  injectPlugins();
} else if (wanted) {                // 形态 2：用户要 → 载 polyfill 造出 document 注册表
  window.__webmcpMode = "polyfill+wanted";
  var p = inject("../vendor/webmcp/polyfill.iife.js");
  p.onload = function () { injectPlugins(); };
  p.onerror = function () { window.__webmcpMode = "polyfill-failed"; };
} else {                            // 形态 3：普通读者没要 → 一个字节都不拉
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
