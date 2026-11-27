// site-root.mjs —— 运行时探测部署根，修正部署在子路径时的相对链接。
//
// ## 为什么需要（2026-10-20 线上实测的 bug）
//
// 站点部署在 https://isui.ren/repo/S26-1_202609/，但托管层（EdgeOne）同时让
// **无前缀**路径 https://isui.ren/课程/电机学/index.html 也返回 200（同一份
// 文件两个 URL）。用户从搜索引擎/历史记录进入无前缀版本时：
//
//   · 页面里所有相对链接（../../../index.html）按**当前 URL** 解析；
//   · 在无前缀路径下，三级 ../ 一路退到域名根；
//   · 域名根是站长**另一个站点**（isui.ren/ 跳 /heart/）——
//     于是「首页」按钮把用户送出了课程站。
//
// ## 探测原理
//
// 每页构建期都埋了 body[data-site-path]（本页的**仓库相对路径**，如
// 课程/电机学/index.html）。把它与 location.pathname 做后缀对齐：
//
//   pathname = /repo/S26-1_202609/课程/电机学/index.html
//   sitePath =                课程/电机学/index.html
//   ⇒ 部署根 = /repo/S26-1_202609/
//
//   pathname = /课程/电机学/index.html（无前缀入口）
//   sitePath = 课程/电机学/index.html
//   ⇒ 实际根 = /——链接的相对解析虽然自洽，但用户此刻在**镜像入口**上：
//     侧栏「首页」(../../../index.html) 会退到域名根，命中站长另一个站。
//
// 所以光探测实际根不够，还要知道**正式根**（构建期由 CANONICAL_BASE 埋进
// <html data-canonical-root>）。实际根 ≠ 正式根时，把站内链接全部规范到
// 正式根——顺带把镜像入口的用户带回主入口，URL 统一后 SW 缓存、历史记录、
// 分享链接也不再分裂成两套。
//
// ## 用法（构建期注入，首次加载最早执行）
//
//   fixSiteRoot();            // 探测 + 重写链接 + 给 <html data-root> 换绝对值
//   siteRoot()                // → "/repo/S26-1_202609/"（恒以 / 开头，恒以 / 结尾）
//
// SPA 换页后 data-site-path 会更新，但部署根不变——探测一次即可。
// 幂等：重复调用无副作用。
//
// ## 可拆卸
//
// 删掉本文件与 build.mjs 注入行即回退。部署在域名根（GitHub Pages 项目页之外
// 的场景）时探测结果为 "/"，全部操作退化为 no-op。

/**
 * 探测部署根。
 * 返回以 / 开头、以 / 结尾的绝对路径；无法探测时返回 null。
 */
function detectSiteRoot() {
  const decodePathname = () => {
    try { return decodeURIComponent(location.pathname); } catch { return location.pathname; }
  };
  const matchDirFallback = (pathname, sp) => {
    const dir = sp.replace(/[^/]*$/, '');
    const di = dir ? pathname.lastIndexOf(dir) : -1;
    return di >= 0 ? ensureSlash(pathname.slice(0, di)) : null;
  };
  const sp = document.body?.getAttribute('data-site-path') || '';
  if (!sp) return null;
  const pathname = decodePathname();
  const idx = pathname.lastIndexOf(sp);
  if (idx >= 0 && idx + sp.length === pathname.length) return ensureSlash(pathname.slice(0, idx));
  if (/^index\.html$/.test(sp)) return ensureSlash(pathname);
  return matchDirFallback(pathname, sp);
}

function ensureSlash(s) {
  if (!s) return '/';
  if (s.charAt(s.length - 1) !== '/') s += '/';
  return s;
}

/** 惰性缓存（部署根在一次加载内不变）。 */
let cached = null;
let detected = false;

/** 部署根（探测不出时回退到 /，即"部署在域名根"的原行为）。 */
function siteRoot() {
  if (!detected) { cached = detectSiteRoot() || '/'; detected = true; }
  return cached;
}

/**
 * 重写页面里的站内链接为「部署根 + 仓库相对路径」。
 *
 * 只动三类**本站**元素（其它一律不碰）：
 *   · <a data-path=…>        侧栏导航项（构建期带仓库相对路径）
 *   · a[href^=相对路径] 内的 .sidebar-brand / .top-bar-mobile-title / 面包屑
 *     —— 这些没有 data-path，用「当前 data-root 相对值 + 本页深度」反推
 *   · <html data-root>        改成绝对根，SPA 与 drawer-sync 后续直接用
 *
 * 为什么不改所有 <a>：正文里的链接可能指外站、锚点、下载——批量改会误伤。
 * 只改构建期知道语义的那些。
 */
function fixSiteRoot() {
  const canonical = document.documentElement.getAttribute('data-canonical-root') || '/';
  const actual = siteRoot();
  // 实际根与正式根一致 → 一切正常，构建期相对链接本来就是对的
  if (actual === canonical) {
    if (canonical === '/') return;  // 部署在域名根，无镜像问题
    // 一致但仍把 data-root 换成绝对值：SPA/drawer-sync 拼路径更稳
    document.documentElement.setAttribute('data-root', canonical);
    rewriteLinks(canonical);
    return;
  }
  // 实际根 ≠ 正式根 = 用户在镜像入口（如无前缀路径）。
  // 规范到正式根：链接全部指向主入口，点击即回到正确路径。
  document.documentElement.setAttribute('data-root', canonical);
  rewriteLinks(canonical);
}

/**
 * 把站内链接重写为「部署根 + 仓库相对路径」。
 * 只动构建期知道语义的三类元素，不碰正文链接（可能指外站/锚点/下载）。
 */
function rewriteLinks(root) {
  const rewriteRelativeNav = (a, actual) => {
    const href = a.getAttribute('href');
    if (!href || /^(https?:|mailto:|#|javascript:)/i.test(href)) return;
    try {
      const abs = new URL(href, location.href);
      if (abs.origin !== location.origin) return;
      let rel = abs.pathname;
      if (actual && actual !== '/' && rel.startsWith(actual)) rel = rel.slice(actual.length);
      a.setAttribute('href', root + rel.replace(/^\/+/, ''));
    } catch (_e) { /* 坏 href 跳过 */ }
  };
  for (const link of document.querySelectorAll('a[data-path]')) {
    const dp = link.getAttribute('data-path');
    if (dp) link.setAttribute('href', root + dp);
  }
  const navs = document.querySelectorAll('.sidebar-brand, .top-bar-mobile-title, .top-bar-breadcrumbs a:not([data-path]), .paging-card:not([data-path])');
  const actual = siteRoot();
  for (const a of navs) rewriteRelativeNav(a, actual);
}

// 全局暴露（写盘为 <script defer>，非 module；构建期、首屏延迟执行与测试都可调用）
if (typeof window !== 'undefined') {
  window.__siteRoot = { detectSiteRoot: detectSiteRoot, siteRoot: siteRoot, fixSiteRoot: fixSiteRoot };
  window.fixSiteRoot = fixSiteRoot;
  window.siteRoot = siteRoot;
  if (typeof document !== 'undefined' && document.body) {
    try { fixSiteRoot(); } catch (_e) { /* 探测失败保持构建期相对路径 */ }
  }
}
