// spa-router.mjs —— 站内不重载导航（SPA）+ 三个插件的 reset 钩子调度。
//
// ## 设计（2026-10-17 大重构方案 §4）
// 首屏完整 HTML（服务端渲染照旧——直接访问与爬虫拿到全页）；站内点击链接时：
//   fetch 目标页 → DOMParser 解析 → 只替换三块：
//     ① .article-content（正文）
//     ② .m3-toc（右侧目录）
//     ③ <title>
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
function navigate(rawUrl, hash, push) {
  // URL 规范化：防拼接污染（hash 误粘进 path 之类）；hash 一律走 URL.hash，不手拼字符串
  var u = new URL(rawUrl, location.href);
  u.hash = hash ? encodeURIComponent(hash) : "";
  var url = u.pathname + u.search;
  hash = hash || "";
  if (inflight) inflight.abort();
  var ctl = ("AbortController" in window) ? new AbortController() : null;
  inflight = ctl;
  var opts = ctl ? { signal: ctl.signal, credentials: "same-origin" } : { credentials: "same-origin" };
  return fetch(url, opts).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.text();
  }).then(function (html) {
    if (inflight !== ctl) return; // 已被更新的一次导航取代
    inflight = null;
    var doc = new DOMParser().parseFromString(html, "text/html");

    // ① 正文：article-content（容器 article-container 一并换，保 frontmatter 区域结构）
    var nextMain = doc.querySelector(".article-content");
    var curMain = document.querySelector(".article-content");
    if (!nextMain || !curMain) { location.href = url; return; } // 结构不符 → 整页跳转兜底
    curMain.replaceWith(nextMain);

    // ② TOC：m3-toc（aside）
    var nextToc = doc.querySelector(".m3-toc");
    var curToc = document.querySelector(".m3-toc");
    if (nextToc && curToc) curToc.replaceWith(nextToc);

    // ③ 标题
    if (doc.title) document.title = doc.title;

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

    // 侧栏 active 重算（用户实弹报「页面变了侧边栏强调没变」）：构建期按页烘焙
    // active 类，SPA 不换侧栏 DOM 就必须手动刷。侧栏容器是 .m3-drawer，
    // 链接 .drawer-nav-link；分组头是 div.nav-group-header（无 li 包裹）。
    try {
      var navLinks = document.querySelectorAll(".m3-drawer a.drawer-nav-link[href]");
      var herePath = decodeURIComponent(location.pathname);
      navLinks.forEach(function (a) {
        var dp = a.getAttribute("data-path");
        var ap = dp ? "/" + decodeURIComponent(dp)
          : (function () { try { return new URL(a.getAttribute("href"), location.href).pathname; } catch (e) { return null; } })();
        if (ap === null) return;
        var isOn = ap === herePath;
        a.classList.toggle("active", isOn);
        var li = a.closest("li");
        if (li) li.classList.toggle("active", isOn);
        if (isOn) {
          for (var g = li || a; g; g = g.parentElement) {
            if (g.classList && g.classList.contains("drawer-nav-group")) g.classList.add("expanded");
          }
        }
      });
    } catch (e) { /* 侧栏结构变化不致命 */ }

    // reset 钩子（全部可选存在）
    try { if (window.__glossaryReset) window.__glossaryReset(); } catch (e) {}
    try { if (window.__readerRescan) window.__readerRescan(); } catch (e) {}
    try { if (window.__disclosureOpen) window.__disclosureOpen(hash); } catch (e) {}
  }).catch(function (err) {
    inflight = null;
    if (err && err.name === "AbortError") return;
    // 网络/解析失败 → 整页跳转兜底（保底可用性优先于不重载）
    location.href = url;
  });
}

// 点击委托（document 级——SPA 换正文不丢绑定）
document.addEventListener("click", function (ev) {
  if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  var a = ev.target.closest ? ev.target.closest("a") : null;
  if (!isPageLink(a)) return;
  var u = new URL(a.href, location.href);
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
