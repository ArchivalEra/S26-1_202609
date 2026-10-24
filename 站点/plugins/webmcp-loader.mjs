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
//
// ⚠️ 2026-10-19 补：**本机（loopback）默认开**。
// 旧实现只在 shouldBridge() 里放行了本机，但那是 injectPlugins 内部——
// 而 injectPlugins 只有 wanted 为真才会被调用。于是「本机默认开」这句注释
// 从来没有生效过：直接打开 127.0.0.1:8899（不带任何 query）时形态判成
// absent，工具一个都不注册，助手面板拿到的是一张空工具表。
// 站长的本机就是这套助手的唯一使用场景，这里必须默认开。
var loopback = false;
try { loopback = /^(127\\.0\\.0\\.1|localhost|\\[::1\\])$/.test(location.hostname); } catch (e) {}
var wanted = loopback;
try {
  wanted = wanted
    || (qs && (qs.get("relay") === "1" || qs.get("webmcp") === "1"))
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
  // ⚠️ 2026-10-23 修（Node 桥实测抓到）：这两个脚本原先**不带内容哈希**，
  // 而站点其他资产（主题/插件）都由 build 的 assetUrl() 追加 ?v=<内容哈希>。
  // 结果：改了 webmcp-tools.js 之后浏览器一直用旧副本——工具行为怎么改都不生效，
  // 只有手动硬刷新（或换浏览器）才看得见。__TOOLS_VER__ / __SHIM_VER__ 是
  // build 期替换的内容哈希（空串 = 未替换，退化为原行为，不报错）。
  // ⚠️ 2026-10-23（审计二抓到）：原来只列了 shim/tools，**漏了 webmcp-bridge.js**——
  // 它同样由 loader 动态注入，URL 无 ?v=，还配 fetch(cache:"force-cache")。
  // 实测改 page-bridge.mjs 后产物内容变了、请求 URL 一个字节没变 ⇒ 浏览器用旧副本。
  // 三个动态注入的脚本必须都在这里。
  // ⚠️ 2026-10-24 补（生产验收抓到）：**polyfill 同样动态注入却不在表里**——
  // EdgeOne 边缘给 288KB 的 polyfill 卖了份 32KB 截断副本（源仓完好，CDN 毒缓存），
  // 无内容戳的 URL 永远绕不开它，脚本加载即抛错 ⇒ 工具零注册 ⇒ 面板裸文本问答。
  // 内容戳让每次内容变化都换新 URL，毒缓存/旧缓存一律自然绕行。
  var VERS = { "webmcp-shim.js": "__SHIM_VER__", "webmcp-tools.js": "__TOOLS_VER__", "webmcp-bridge.js": "__BRIDGE_VER__", "../vendor/webmcp/polyfill.iife.js": "__POLYFILL_VER__" };
  var v = VERS[rel] || "";
  el.src = baseDir() + rel + (v && v.indexOf("__") !== 0 ? "?v=" + v : "");
  el.async = false;
  document.head.appendChild(el);
  return el;
}

function injectPlugins() {
  inject("webmcp-shim.js");
  var toolsScript = inject("webmcp-tools.js");
  if (!shouldBridge()) return;

  // ⭐ 2026-10-19 修 P2-20：300ms 魔法延迟改**就绪握手**。
  //
  // 旧实现：setTimeout(300) 猜「工具应该注册完了」——慢机器上工具还没进注册表，
  // 桥报到时就拿到空清单（然后永远不重报，除非 toolchange 恰好触发）。
  //
  // 新实现：等 tools 脚本 load 完 + 轮询 getTools() 直到非空（最多 3s），
  // 再注入桥。任何一步失败都退回一个短延迟，保证桥总会注入。
  var injected = false;
  function ready() {
    if (injected) return;
    injected = true;
    injectBridge();
  }
  function poll(n) {
    var mc = document.modelContext || (typeof navigator !== "undefined" && navigator.modelContext) || null;
    if (!mc || typeof mc.getTools !== "function") {
      if (n <= 0) return ready();
      return setTimeout(function () { poll(n - 1); }, 100);
    }
    Promise.resolve()
      .then(function () { return mc.getTools(); })
      .then(function (list) {
        if (Array.isArray(list) && list.length) return ready();
        if (n <= 0) return ready();
        setTimeout(function () { poll(n - 1); }, 100);
      })
      .catch(function () {
        if (n <= 0) return ready();
        setTimeout(function () { poll(n - 1); }, 100);
      });
  }
  // tools 脚本 onload 后再等注册表（最多 30 次 × 100ms = 3s）
  if (toolsScript && typeof toolsScript.addEventListener === "function") {
    toolsScript.addEventListener("load", function () { poll(30); });
    toolsScript.addEventListener("error", function () { setTimeout(ready, 300); });
  } else {
    setTimeout(function () { poll(30); }, 50);
  }
}

/**
 * 注入页面桥（2026-10-19 修 P0-2）。
 *
 * 关键：**先把源码取回来塞进 window.__mcpBridgeSource**，再插 <script>。
 * 这样断线看门狗有源码可 eval 重建——旧实现靠 arguments.callee（箭头函数里没有），
 * 源码恒为 null，看门狗自杀后永不重连。
 *
 * 顺带把 token 也塞进 window.__bridgeToken。
 *
 * ## token 谁给（2026-10-19 修「永远是连不上助手」）
 *
 * 原来只从 localStorage.webmcp_bridge_token 读，而**没有任何东西往那里写**——
 * 于是面板和页面桥都拿到空 token，/chat 与 /events 永远 401。
 * 现在三级来源，按可靠性降序：
 *   ① localStorage —— 用户显式配置的（也缓存上一次握手结果）
 *   ② URL query ?token= —— 调试/临时用
 *   ③ **问桥要**：GET /bootstrap（桥只对**本机 Origin** 回它自己的 token）。
 *      这是常规路径：本机页面对本机桥，本来就该零手工。
 * 拿到后写进 localStorage，刷新后 ① 直接命中，不再每次握手。
 */
function injectBridge() {
  var url = baseDir() + "webmcp-bridge.js";
  window.__mcpBridgeReload = url;
  // 先取 token（可能要问桥要，是一次网络请求），**拿到再注入**——
  // 页面桥在 IIFE 里一次性读 TOKEN，注入之后再塞就晚了（读到空串）。
  resolveToken().then(function () {
    return fetch(url, { cache: "force-cache" });
  })
    .then(function (r) { return r.text(); })
    .then(function (src) {
      window.__mcpBridgeSource = src;
      injectBridgeTag(url);
    })
    .catch(function () {
      // 取源码失败也别放弃：直接插标签，桥本身能跑，只是重建能力退化到 reinjectTag
      injectBridgeTag(url);
    });
}

/** 插 <script> 跑页面桥。 */
function injectBridgeTag(url) {
  var el = document.createElement("script");
  el.src = url;
  el.async = false;
  document.head.appendChild(el);
}

/**
 * 取桥 token（三级来源），拿到就写 localStorage 并返回。
 *
 * 失败一律 resolve('')，绝不 reject——拿不到 token 只是回到「401」的旧行为，
 * 不该阻塞页面桥注入（否则连报错都看不到）。
 */
function resolveToken() {
  try {
    if (window.__bridgeToken) return Promise.resolve(window.__bridgeToken);
  } catch (e) {}
  var fromLs = '';
  try { fromLs = localStorage.getItem("webmcp_bridge_token") || ""; } catch (e) {}
  if (fromLs) { window.__bridgeToken = fromLs; return Promise.resolve(fromLs); }

  var fromQs = "";
  try { fromQs = (qs && qs.get("token")) || ""; } catch (e) {}
  if (fromQs) {
    window.__bridgeToken = fromQs;
    try { localStorage.setItem("webmcp_bridge_token", fromQs); } catch (e) {}
    return Promise.resolve(fromQs);
  }

  // 问桥要。本机页面对本机桥，这是常规路径。
  var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
  var timer = setTimeout(function () { try { ctrl && ctrl.abort(); } catch (e) {} }, 3000);
  return fetch("http://127.0.0.1:9345/bootstrap", {
    method: "GET",
    signal: ctrl ? ctrl.signal : undefined,
    cache: "no-store",
  })
    .then(function (r) { clearTimeout(timer); return r.ok ? r.json() : null; })
    .then(function (j) {
      var t = j && j.token ? String(j.token) : "";
      if (t) {
        window.__bridgeToken = t;
        try { localStorage.setItem("webmcp_bridge_token", t); } catch (e) {}
      }
      return t;
    })
    .catch(function () { clearTimeout(timer); return ""; });
}

// 站点部署域名（2026-10-19 扩到公网）：同学在 isui.ren 上打开时也要连
// **他自己机器**的桥。127.0.0.1 在浏览器里永远指访问者本机，所以这不是
// 「连站长的服务器」，而是「连访客自己的本地程序」。
var SITE_HOSTS = ['isui.ren', 'archivalera.github.io'];

// 只在「本机 / 本站部署域名 / 显式开启」时连桥。
function shouldBridge() {
  try {
    if (qs && qs.get("bridge") === "1") return true;
    if (localStorage.getItem("webmcp_bridge") === "on") return true;
    var h = location.hostname;
    // 本机环境默认开（开发/实验）
    if (/^(127\\.0\\.0\\.1|localhost|\\[::1\\]|::1)$/.test(h)) return true;
    // 本站的部署域名
    for (var i = 0; i < SITE_HOSTS.length; i++) if (h === SITE_HOSTS[i]) return true;
    return false;
  } catch (e) { return false; }
}

// 2026-10-25（生产验收）：形态 3 保留「读者不付 281KB」，但**给面板留一个
// 运行时开关** window.__webmcpEnable()——面板打开/首次发问时调它，
// 当场补载 polyfill 并注册工具。这样「要不要页面工具」不再要求用户记住
// ?webmcp=1 或手写 localStorage（验收里正因为没人记，mode 一直是 absent，
// 工具零注册 → 提示词整段被跳过 → 模型只回「我没有 site_* 工具」）。
window.__webmcpEnable = function () {
  if (window.__webmcpMode === "polyfill+wanted" || window.__webmcpMode === "native-document") return window.__webmcpMode;
  if (hasDoc) { window.__webmcpMode = "native-document"; injectPlugins(); return window.__webmcpMode; }
  window.__webmcpMode = "polyfill+wanted";
  var p = inject("../vendor/webmcp/polyfill.iife.js");
  p.onload = function () { injectPlugins(); };
  p.onerror = function () { window.__webmcpMode = "polyfill-failed"; };
  return window.__webmcpMode;
};

if (hasDoc) {                       // 形态 1：原生已有 document 注册表 → 直接用
  window.__webmcpMode = "native-document";
  injectPlugins();
} else if (wanted) {                // 形态 2：用户要 → 载 polyfill 造出 document 注册表
  window.__webmcpMode = "polyfill+wanted";
  var p = inject("../vendor/webmcp/polyfill.iife.js");
  p.onload = function () { injectPlugins(); };
  p.onerror = function () { window.__webmcpMode = "polyfill-failed"; };
} else {                            // 形态 3：普通读者没要 → 一个字节都不拉（面板可随时开）
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
