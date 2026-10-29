// spa-router.mjs —— 站内不重载导航（SPA）+ 三个插件的 reset 钩子调度。
//
// ## 设计（2026-10-17 大重构方案 §4）
// 首屏完整 HTML（服务端渲染照旧——直接访问与爬虫拿到全页）；站内点击链接时：
//   fetch 目标页 → DOMParser 解析 → 替换五块：
//     ① .article-content（正文）
//     ② .m3-toc（右侧目录）
//     ③ <title>
//     ④ 两份面包屑：顶栏 .top-bar-breadcrumbs 与正文 .m3-breadcrumb
//     ⑤ .meta-chip-bar（来源/状态/更新日期三颗 chip）
//
// ⚠️ 2026-10-28 修（站长指出「大标题上方那栏永远是刚进站那页的信息」）：
// 面包屑此前**不在替换清单里**，所以站点内跳转后它一直显示初页的路径。
// 两份面包屑都烘死在每页 HTML 里（构建期生成），换页必须整块换掉——
// 2026-10-22 那次只给链接加了 data-path 让它「点得动」，文案从未更新过。
//   pushState 改 URL；document 不销毁。
//
// ## 为什么对 WebMCP 友好
// webmcp-tools 全部实时 doc.querySelectorAll（不缓存节点）——document 换正文后
// 工具自动作用于新页面，注册一次永久有效。这是「不重载」的核心收益。
//
// ## 三个 reset 钩子（换页后必须调）
//   __glossaryReset()   math-glossary 的 dict 缓存按页烘焙，换页要清
//   __readerRescan()    shirone-reader 启动时缓存 headings/tocLinks，换页要重扫
//   __disclosureOpen()  disclosure-anchor 只在 DOMContentLoaded/hashchange 跑，换页手动调
//
// ## 锚点与后退
//   带锚点链接：先换正文，再滚到锚点（触发 disclosure 展开由钩子完成）。
//   popstate：与正向导航同路径；滚动位置由浏览器 history 恢复。
//
// ## 可拆卸
// 删掉本文件与 build.mjs 的注入行即回退到普通多页站。

/** 路由器源码（构建期内联进页面；无依赖）。 */
export const SPA_ROUTER_JS = `(function () {
"use strict";
if (typeof window === "undefined" || window.__spaRouter) return;

// 只接管站内链接：同源、.html（或目录尾斜杠→index.html）、非下载、非新窗口
function sameSite(url) {
  try { return new URL(url, location.href).origin === location.origin; } catch (e) { return false; }
}

function isPageLink(a) {
  if (!a || a.target === "_blank" || a.hasAttribute("download")) return false;
  var href = a.getAttribute("href") || "";
  if (!href || href.charAt(0) === "#") return false;
  if (/^(mailto:|javascript:|tel:)/i.test(href)) return false;
  if (!sameSite(href)) return false;
  var u = new URL(href, location.href);
  if (/\\.(png|jpe?g|webp|gif|svg|jxl|pdf|zip|doc|docx|txt|mp3|mp4)$/i.test(u.pathname)) return false;
  return true;
}

// 换页：fetch → 解析 → 替换三块 → reset 钩子
var inflight = null;
function navigate(rawUrl, hash, push, opts4) {
  // 第 4 参「soft」（2026-10-29）：**不许整页重载**。
  //
  // 站内点击走默认（hard）：fetch 失败就 location.href 兜底，那是正常浏览该有的
  // 保底可用性。但助手工具循环调用时**整页重载会销毁 document，把助手自己的面板与
  // 已注册工具一起杀掉**——用户看到「学数学」跳过去，回来连接没了。
  // 所以工具传 soft=true：任何失败都 reject，由调用方回报「跳不过去」，绝不换页。
  var soft = opts4 && opts4.soft === true;
  // URL 规范化：防拼接污染（hash 误粘进 path 之类）；hash 一律走 URL.hash，不手拼字符串
  var u = new URL(rawUrl, location.href);
  u.hash = hash ? encodeURIComponent(hash) : "";
  var url = u.pathname + u.search;
  hash = hash || "";
  if (inflight) inflight.abort();
  var ctl = ("AbortController" in window) ? new AbortController() : null;
  inflight = ctl;
  var opts = ctl ? { signal: ctl.signal, credentials: "same-origin" } : { credentials: "same-origin" };
  var doFetch = function (extra) { return fetch(url, Object.assign({}, opts, extra || {})); };
  return doFetch().catch(function (err) {
    // 网络/缓存竞态先绕过 SW 重试一次（cache:reload 直连网络），移动端整页跳代价最大
    if (err && err.name === "AbortError") throw err;
    return doFetch({ cache: "reload" });
  }).then(function (res) {
    if (!res || !res.ok) throw new Error("HTTP " + (res ? res.status : "unknown"));
    return res.text();
  }).then(function (html) {
    if (inflight !== ctl) return; // 已被更新的一次导航取代
    inflight = null;
    var doc = new DOMParser().parseFromString(html, "text/html");

    // ① 正文：article-content（容器 article-container 一并换，保 frontmatter 区域结构）
    var nextMain = doc.querySelector(".article-content");
    var curMain = document.querySelector(".article-content");
    if (!nextMain || !curMain) {
      // 结构不符 → 整页跳转兜底（soft 模式改为上报失败，见函数头）
      if (soft) throw new Error("not_a_site_page");
      location.href = url; return;
    }
    curMain.replaceWith(nextMain);

    // ② TOC：m3-toc（aside）
    var nextToc = doc.querySelector(".m3-toc");
    var curToc = document.querySelector(".m3-toc");
    if (nextToc && curToc) curToc.replaceWith(nextToc);

    // ③ 标题
    if (doc.title) document.title = doc.title;

    // ③b data-root 同步：html[data-root] 是每页的回根前缀，SPA 不换 <html> 就
    // 要把新页的值搬过来——否则后续侧栏点击用旧页前缀拼 URL（子路径/深层页下错位）。
    var nr = doc.documentElement && doc.documentElement.getAttribute("data-root");
    if (nr) document.documentElement.setAttribute("data-root", nr);
    // ③c data-site-path 同步：body[data-site-path] 是本页的仓库相对路径，
    // drawer-sync 用它做【纯字符串】 active 判定——零 pathname 解析、部署前缀无关。
    var sp = doc.body && doc.body.getAttribute("data-site-path");
    if (sp) document.body.setAttribute("data-site-path", sp);

    // ③d 面包屑两份 + meta chip 条：这三处烘死在每页 HTML 里、又都在
    // .article-content 之外，SPA 不换就永远是初页的信息（2026-10-28 修）。
    // 整块 replaceWith 而不是改文字：面包屑的**层级深度随页面变**
    // （首页 1 段、课程页 2 段、教材解析章节页 5 段），逐段改会留下残段。
    var crumbSelectors = [".top-bar-breadcrumbs", ".m3-breadcrumb"];
    for (var ci = 0; ci < crumbSelectors.length; ci++) {
      var sel = crumbSelectors[ci];
      var nextCrumb = doc.querySelector(sel);
      var curCrumb = document.querySelector(sel);
      if (nextCrumb && curCrumb) curCrumb.replaceWith(nextCrumb);
    }
    // meta chip 条可能在新页不存在（例如 README / 课程索引没有 course 字段）——
    // 那种情况要**删掉旧页的**，否则会挂着上一页的课程/状态标签。
    var nextChips = doc.querySelector(".meta-chip-bar");
    var curChips = document.querySelector(".meta-chip-bar");
    if (nextChips && curChips) curChips.replaceWith(nextChips);
    else if (curChips && !nextChips) curChips.remove();

    // ④ 侧栏 active 态（drawer 里当前页高亮由 theme 脚本管；这里触发它的重扫）
    // （shirone-reader 的 active 类基于 URL data 属性——换页后由 __readerRescan 处理）

    if (push) history.pushState({ spa: true }, "", u.href);
    if (hash) {
      // 锚点落位要等正文渲染稳定（KaTeX/TOC 会改文档高度，立刻滚会漂——§8.23 同款）。
      // 两段式：先展开折叠面板（钩子），300ms 后再滚；scroll-margin-top 由主题 CSS 管。
      try { if (window.__disclosureOpen) window.__disclosureOpen(hash); } catch (e) {}
      setTimeout(function () {
        var el = document.getElementById(hash);
        if (el) el.scrollIntoView({ block: "start" });
      }, 300);
    } else {
      window.scrollTo(0, 0);
    }

    // 抽屉导航（active 重算/自动关/滚到高亮）统一由 drawer-sync 负责
    try { if (window.__drawerSync) window.__drawerSync.onNavigate(); } catch (e) {}

    // reset 钩子（全部可选存在）
    // 2026-10-19：聊天面板不销毁，只做位置复位（历史保留）
    try { if (window.__chatSync) window.__chatSync(); } catch (e) {}
    try { if (window.__glossaryReset) window.__glossaryReset(); } catch (e) {}
    try { if (window.__readerRescan) window.__readerRescan(); } catch (e) {}
    try { if (window.__disclosureOpen) window.__disclosureOpen(hash); } catch (e) {}
  }).catch(function (err) {
    inflight = null;
    if (err && err.name === "AbortError") return;
    // 网络/解析失败 → 整页跳转兜底（保底可用性优先于不重载）。
    // soft 模式（助手工具调用）：**不许跳**——整页重载会销毁 document，
    // 连助手面板与已注册工具一起没了，用户回头就发现连接断了。改成 reject 上报。
    if (soft) throw err;
    location.href = url;
  });
}

// 点击委托（document 级——SPA 换正文不丢绑定）
document.addEventListener("click", function (ev) {
  if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  var a = ev.target.closest ? ev.target.closest("a") : null;
  if (!isPageLink(a)) return;
  // ⭐ 部署根无关导航（2026-10-17 线上 404 的根因修复）：
  // 侧栏 DOM 是首次加载页的，其相对 href 在换页后的 location 下解析会层级错位
  // （首页的 ./课程/x 在 /课程/工程数学/ 下解析 = 双拼 404）。侧栏链接都带
  // data-path（仓库相对路径），用 <html data-root>（构建期每页埋的回根前缀）
  // 拼出与"侧栏来自哪页"和"部署在哪个子路径"都无关的 URL。
  var dp = a.getAttribute("data-path");
  if (dp) {
    var root = document.documentElement.getAttribute("data-root") || "./";
    var u2 = new URL(root + dp, location.href);
    var u = u2;
  } else {
    var u = new URL(a.href, location.href);
  }
  var hash = u.hash ? u.hash.slice(1) : "";
  var target = u.pathname + u.search;
  if (target === location.pathname + location.search) {
    // 同页锚点：不换正文，直接滚
    if (hash) {
      var el = document.getElementById(hash);
      if (el) { ev.preventDefault(); el.scrollIntoView({ block: "start" });
        try { if (window.__disclosureOpen) window.__disclosureOpen(hash); } catch (e) {} }
    }
    return; // 同页无锚点 → 让默认行为（一般不会发生）
  }
  ev.preventDefault();
  navigate(target, hash, true);
});

// 前进/后退
window.addEventListener("popstate", function () {
  navigate(location.pathname + location.search, location.hash ? location.hash.slice(1) : "", false);
});

window.__spaRouter = { navigate: navigate };
})();`;

// ── 构建期/测试用的纯函数 ─────────────────────────────────────

/** 判断一个 <a href> 是否会被路由器接管（与内联源码同一套判据，测试用）。 */
export function isRoutableHref(href, origin) {
  if (!href) return false;
  if (href.charAt(0) === '#') return false;
  if (/^(mailto:|javascript:|tel:)/i.test(href)) return false;
  let u;
  try { u = new URL(href, origin + '/'); } catch { return false; }
  if (u.origin !== origin) return false;
  if (/\.(png|jpe?g|webp|gif|svg|jxl|pdf|zip|doc|docx|txt|mp3|mp4)$/i.test(u.pathname)) return false;
  return true;
}
