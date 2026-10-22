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
  var sp = (document.body && document.body.getAttribute('data-site-path')) || '';
  if (!sp) return null;
  // pathname 解码后与 sitePath 对齐（构建期写的是未编码的仓库路径）
  var pathname;
  try { pathname = decodeURIComponent(location.pathname); } catch (e) { pathname = location.pathname; }
  // 后缀对齐：sitePath 必须是 pathname 的尾部
  var idx = pathname.lastIndexOf(sp);
  if (idx < 0 || idx + sp.length !== pathname.length) {
    // sitePath 带 .html 而 pathname 是目录形式（trailing slash）之类——
    // 退一步只按目录部分对齐
    var dir = sp.replace(/[^/]*$/, '');
    var di = pathname.lastIndexOf(dir);
    if (di < 0) return null;
    return ensureSlash(pathname.slice(0, di));
  }
  return ensureSlash(pathname.slice(0, idx));
}

function ensureSlash(s) {
  if (!s) return '/';
  if (s.charAt(s.length - 1) !== '/') s += '/';
  return s;
}

/** 惰性缓存（部署根在一次加载内不变）。 */
var cached = null;
var detected = false;

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
  var canonical = document.documentElement.getAttribute('data-canonical-root') || '/';
  var actual = siteRoot();
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
  // 1) 侧栏 data-path 链接：仓库相对路径直接拼
  var links = document.querySelectorAll('a[data-path]');
  for (var i = 0; i < links.length; i++) {
    var dp = links[i].getAttribute('data-path');
    if (dp) links[i].setAttribute('href', root + dp);
  }
  // 2) 无 data-path 的站内导航（品牌/移动标题/旧式链接）：
  //    它们的 href 是 data-root 相对值（如 ../../index.html），先解析成
  //    绝对 URL，剥掉实际根得到仓库路径，再拼正式根。
  //    ⚠️ 分工（票 A 引入，2026-10-22 补丁）：带 data-path 的元素（侧栏、面包屑、
  //    分页卡）由上面第 1 分支负责——它们的 href 已被改写成「root + 仓库相对」
  //    绝对路径；若本分支再命中它们，「剥掉实际根再拼正式根」会把已拼好的前缀
  //    重复叠加（镜像入口场景 actual≠canonical 时出双前缀
  //    /repo/S26-1_202609/repo/S26-1_202609/课程/index.html）。所以选择器用
  //    :not([data-path]) 把它们排除，本分支只管无 data-path 的站内导航
  //    （品牌/移动标题/将来漏埋 data-path 的旧式链接）。:not([attr]) 属性选择器
  //    形态现代浏览器均支持，无兼容顾虑。
  var navs = document.querySelectorAll('.sidebar-brand, .top-bar-mobile-title, .m3-breadcrumb a:not([data-path]), .paging-card:not([data-path])');
  var actual = siteRoot();
  for (var j = 0; j < navs.length; j++) {
    var a = navs[j];
    var href = a.getAttribute('href');
    if (!href || /^(https?:|mailto:|#|javascript:)/i.test(href)) continue;
    try {
      var abs = new URL(href, location.href);
      if (abs.origin !== location.origin) continue;
      var rel = abs.pathname;
      // 剥掉实际根前缀得到仓库相对路径（探测不出实际根时按整段处理）
      if (actual && actual !== '/' && rel.indexOf(actual) === 0) rel = rel.slice(actual.length);
      rel = rel.replace(/^\/+/, '');
      a.setAttribute('href', root + rel);
    } catch (e) { /* 坏 href 跳过 */ }
  }
}

// 全局暴露（写盘为普通 <script>，非 module；构建期与测试都可调用）
if (typeof window !== 'undefined') {
  window.__siteRoot = { detectSiteRoot: detectSiteRoot, siteRoot: siteRoot, fixSiteRoot: fixSiteRoot };
  window.fixSiteRoot = fixSiteRoot;
  window.siteRoot = siteRoot;
}
