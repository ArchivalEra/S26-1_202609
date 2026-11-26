// nav-structure.mjs —— 侧栏导航的**形状**（构造/判定）的唯一真相源（阶段一，2026-10-21）。
//
// ## 为什么存在
// 侧栏的形状原先只活在 DOM 的 class 名里：renderNav 自己算 active/expanded，
// site_index 靠爬 DOM 重建树，drawer-sync 再收集 `a[data-path]` 全等比对一遍。
// 三个消费者各解析同一份 DOM，规则各不相同——改一处必崩另一处（架构评审候选 1）。
//
// 本模块把形状收拢成**纯函数**：输入 NAV_STRUCTURE + 当前页 relPath，
// 输出归一化节点树与一份烘焙进页面的 JSON。判定（active/expanded/索引链接）
// 只此一处，三个消费者共用。
//
// ## 零 DOM
// 本文件不碰 document/window，node 能直接 import。浏览器运行时辅助见
// `NAV_STRUCTURE_JS`：那是一个可内联的字符串，**由本文件的真函数 `.toString()` 派生**
// （与 webmcp-tools.mjs 的 WEBMCP_TOOLS_JS 同款）——drawer-sync 拼在自己的 IIFE 前，
// 于是「浏览器跑的就是测试跑的那份」，不做第二份判定实现。
//
// ## 两个路径空间（别混）
//   · **md 空间**：NAV_STRUCTURE 里写的、build.mjs 的 relPath —— 构建期判定用。
//   · **html 空间**：产物真实文件名（README.md → index.html，其余 `*.md` → `*.html`）。
//     JSON 的 `id` / `href` / `current` / activeIds / expandedIds 全用 html 空间，
//     好让运行时（drawer-sync）直接与 `body[data-site-path]`（html）对齐。
// 归一化节点的 `path` 保留 md 原值（忠实于 NAV_STRUCTURE），`href` 是它的 html 形态。
// 判定函数带一个 `htmlSpace` 开关：false 用 node.path，true 用 node.href。

/**
 * md 路径 → **物理产物路径**（构建写盘用）。
 *
 * README.md 落成 index.html；目录索引页落成 `<目录>/index.html`；其余换后缀。
 * **这不是网址**——网址见 `htmlPathOf`。二者在索引页上不同：
 * 文件叫 `课程总览/index.html`，而网址是 `课程总览/`（托管层对目录请求返回 index.html）。
 *
 * @param {string} mdPath
 * @returns {string|null}
 */
export function filePathOf(mdPath) {
  if (!mdPath || typeof mdPath !== 'string') return null;
  if (mdPath === 'README.md') return 'index.html';
  return mdPath.replace(/\.md$/, '.html');
}

/**
 * md 路径 → 站内**网址**。**全站唯一的网址规则**（2026-10-29 站长定案「大一统」）。
 *
 * ```
 * 站点首页     README.md          → ''           （就是 /，浏览器自然解析到站点根）
 * 目录索引页   课程总览/index.md   → '课程总览/'
 * 普通页面     作业3.md           → '作业3.html'
 * ```
 *
 * ## 为什么索引页用目录形式而不是 index.html
 *
 * 「文件名 = 侧栏标签 = 页面 H1 = 网址最后一段」这条四者一致，在索引页上只有目录
 * 形式能成立：写 `课程总览/index.html` 时最后一段是 `index`，与层名「课程总览」对不上。
 * 写成 `课程总览/`，最后一段就是层名本身。
 *
 * ## 为什么这是安全的
 *
 * 目录形式是托管层原生能力，不依赖任何 rewrite：本地实测 `/`、`/课程总览/`、
 * `/课程总览/工程数学/作业/` 全部 200（不带尾斜杠 301 到带斜杠）。
 * 浏览器请求目录时服务器自己返回 `index.html`——「网址 ↔ 文件」的换算交给服务器，
 * 我们只在**生成链接**这一侧统一用网址形态。
 *
 * 返回站内相对网址（不带前导 `/`，首页为空串）。拼绝对链接时由调用方加 `rootRel`。
 *
 * @param {string} mdPath
 * @returns {string|null}
 */
export function htmlPathOf(mdPath) {
  if (!mdPath || typeof mdPath !== 'string') return null;
  if (mdPath === 'README.md') return '';
  if (mdPath.endsWith('/index.md')) return mdPath.replace(/\/index\.md$/, '/');
  return mdPath.replace(/\.md$/, '.html');
}

/**
 * 把一个网址形态的路径拆成「面包屑/侧栏能用的段」：去掉末尾斜杠再分段。
 * `课程总览/工程数学/作业/` → ['课程总览','工程数学','作业']；`''` → []。
 * @param {string} url
 * @returns {string[]}
 */
export function urlSegments(url) {
  const u = String(url || '').replace(/\/+$/, '');
  return u ? u.split('/') : [];
}

/** 节点在指定空间的键（md 用 path，html 用 href）。 */
function nodeKey(node, htmlSpace) {
  return htmlSpace ? node.href : node.path;
}

/**
 * 本节点是否**当前页**（给定空间精确相等）。只认自带键的节点；
 * 无 path 的组节点永不 active。
 * @param {object} node
 * @param {string} target  当前页（md 空间的 relPath，或 html 空间的路径）
 * @param {boolean} [htmlSpace=false]
 */
export function isActive(node, target, htmlSpace) {
  const key = nodeKey(node, htmlSpace);
  return Boolean(key && key === target);
}

/**
 * 自身 active 或任一后代 active（组节点据此展开），
 * 且顶层「课程总览」（depth=0）默认保持展开，让首页访客首屏即可看见全部课程列表。
 * @param {object} node
 * @param {string} target
 * @param {boolean} [htmlSpace=false]
 */
export function isExpanded(node, target, htmlSpace) {
  if (!node) return false;
  if (node.depth === 0 && node.label === '课程总览') return true;
  if (isActive(node, target, htmlSpace)) return true;
  if (node.children) return node.children.some((c) => isExpanded(c, target, htmlSpace));
  return false;
}

/**
 * 遍历一棵归一化节点树，收集当前页的 active / expanded 节点 id。
 * 唯一真相：active = 节点键 === target，expanded = 自身或某后代 active。
 * 构建期（htmlSpace=false，target=relPath）与运行时（htmlSpace=true，target=body[data-site-path]）
 * **共用这一份**——SPA 换页后烘焙的 activeIds 属旧页，运行时用同一规则按新页重算。
 *
 * @param {Array} nodes   归一化节点数组
 * @param {string} target 当前页
 * @param {boolean} [htmlSpace=false]
 * @returns {{activeIds: string[], expandedIds: string[]}}
 */
export function collectActive(nodes, target, htmlSpace) {
  const activeIds = [];
  const expandedIds = [];
  (function walk(arr) {
    for (const n of arr || []) {
      if (isActive(n, target, htmlSpace)) activeIds.push(n.id);
      if (isExpanded(n, target, htmlSpace)) expandedIds.push(n.id);
      if (n.children) walk(n.children);
    }
  })(nodes);
  return { activeIds, expandedIds };
}

/** 组节点的全部后代 md 路径（含孙、曾孙……）。 */
function descendantPaths(node) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children || []) {
      if (c.path) out.push(c.path);
      walk(c);
    }
  };
  walk(node);
  return out;
}

/**
 * 组节点索引链接：**有子节点**且 path 指向 `index.md`，且该 path **不与任何子项重复**时，
 * 返回它的 html 相对路径；否则 null（出 null 就不渲染图标）。
 *
 * 为什么「重复」要排除（电机学 :487/:496 两处）：那种组节点的 path 就是某个子项自己的
 * 页面，链接与子项 URL 相同，会造成父子一起亮——所以不出图标。
 * 无 path 的那 3 个组（工程数学第01章/第02章、仓库规约）也因「非 index.md」返回 null。
 *
 * @param {object} node          归一化节点（含 children 与 path）
 * @param {function} [htmlRelPathFn] md → html 的换算（默认 htmlPathOf）
 * @returns {string|null}
 */
export function indexHrefOf(node, htmlRelPathFn) {
  const htmlOf = htmlRelPathFn || htmlPathOf;
  if (!node?.children?.length) return null;
  if (!node.path || !node.path.endsWith('/index.md')) return null;
  if (descendantPaths(node).includes(node.path)) return null;
  return htmlOf(node.path);
}

/**
 * 把 NAV_STRUCTURE 转成导航模型。
 *
 * @param {Array} structure  原始的 NAV_STRUCTURE（嵌套 {label, path?, children?}）
 * @param {string} relPath   当前页的仓库相对 md 路径（如 `课程/工程数学/作业/index.md`）
 * @param {function} [htmlRelPathFn] md → html 换算（默认 htmlPathOf；注入便于测试）
 * @returns {{nodes: Array, json: object}}
 *   nodes：归一化树——每节点 `{id, label, path, href, depth, indexHref, children}`
 *   json：烘焙进页面（schema 见下），三个运行时消费者共用：
 *     `{v, current, activeIds, expandedIds, nodes}`（均 html 空间）
 */
export function buildNavModel(structure, relPath, htmlRelPathFn) {
  const htmlOf = htmlRelPathFn || htmlPathOf;
  let synthetic = 0;

  const normalize = (list, depth, parentKey) => list.map((raw) => {
    const md = raw.path || null;
    const href = md ? htmlOf(md) : null;
    // 无 path 的组节点（第01章/第02章/仓库规约）也要有稳定 id：用父键 + label 拼一个
    // 不可能与任何真实 html 路径相撞的值（带 `#` 前缀）。
    const id = href || `${parentKey}#${raw.label || 'node' + (synthetic++)}`;
    const children = raw.children?.length
      ? normalize(raw.children, depth + 1, id)
      : null;
    const node = { id, label: raw.label, path: md, href, depth, indexHref: null, children };
    node.indexHref = indexHrefOf(node, htmlOf);
    return node;
  });

  const nodes = normalize(structure, 0, '');

  const currentHtml = relPath != null ? htmlOf(relPath) : null;
  const { activeIds, expandedIds } = collectActive(nodes, currentHtml, true);
  const json = {
    v: 1,
    current: currentHtml,
    // 与归一化节点同源的判定结果（html 空间），运行时直接可用。
    activeIds,
    expandedIds,
    nodes,
  };

  return { nodes, json };
}

/**
 * 浏览器内联的运行时代码（与 site-helpers.mjs 的 SITE_HELPERS_JS 同款模式）。
 * 支持外置共享 JSON（data-nav-path / data-pages-path）与折叠分支按需水合，
 * 同时兼容页面内嵌 `#nav-structure-json`（单测与旧页面）。
 *
 * **判定逻辑由上面的真函数 `.toString()` 派生**——测试跑的就是浏览器跑的。
 */
export const NAV_STRUCTURE_JS = `(function () {
"use strict";
if (typeof window === "undefined" || window.__navStructure) return;
var NAV_JSON_ID = "nav-structure-json";
var PAGES_JSON_ID = "site-pages-json";
var nodeKey = ${nodeKey.toString()};
var isActive = ${isActive.toString()};
var isExpanded = ${isExpanded.toString()};
var collectActive = ${collectActive.toString()};
var navPromise = null;
var pagesPromise = null;

function escAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function resolveSiteUrl(attrName) {
  var docEl = document.documentElement;
  if (!docEl) return null;
  var rel = docEl.getAttribute(attrName);
  if (!rel) return null;
  var root = docEl.getAttribute("data-root") || "./";
  return new URL(root + rel, location.href).href;
}

function readNavJson() {
  if (window.__siteNavData && Array.isArray(window.__siteNavData.nodes)) {
    return window.__siteNavData;
  }
  try {
    var tag = document.getElementById(NAV_JSON_ID);
    if (!tag) return null;
    var data = JSON.parse(tag.textContent || "");
    if (data && Array.isArray(data.nodes)) {
      window.__siteNavData = data;
      return data;
    }
    return null;
  } catch (e) { return null; }
}

function readPagesJson() {
  if (Array.isArray(window.__sitePagesData)) return window.__sitePagesData;
  try {
    var tag = document.getElementById(PAGES_JSON_ID);
    if (!tag) return null;
    var data = JSON.parse(tag.textContent || "");
    if (Array.isArray(data)) {
      window.__sitePagesData = data;
      return data;
    }
    return null;
  } catch (e) { return null; }
}

function loadNavJson() {
  var sync = readNavJson();
  if (sync) return Promise.resolve(sync);
  if (navPromise) return navPromise;
  var url = resolveSiteUrl("data-nav-path");
  if (!url) return Promise.resolve(null);
  navPromise = fetch(url, { credentials: "same-origin" })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (data && Array.isArray(data.nodes)) {
        window.__siteNavData = data;
        return data;
      }
      navPromise = null;
      return null;
    })
    .catch(function () { navPromise = null; return null; });
  return navPromise;
}

function loadPagesJson() {
  var sync = readPagesJson();
  if (sync) return Promise.resolve(sync);
  if (pagesPromise) return pagesPromise;
  var url = resolveSiteUrl("data-pages-path");
  if (!url) return Promise.resolve(null);
  pagesPromise = fetch(url, { credentials: "same-origin" })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (Array.isArray(data)) {
        window.__sitePagesData = data;
        return data;
      }
      pagesPromise = null;
      return null;
    })
    .catch(function () { pagesPromise = null; return null; });
  return pagesPromise;
}

function findNode(nodes, id) {
  for (var i = 0; i < (nodes || []).length; i++) {
    var n = nodes[i];
    if (n.id === id) return n;
    if (n.children) {
      var hit = findNode(n.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

function renderListHtml(nodes, target, rootRel, recursive, expandedSet) {
  var out = '<ul class="drawer-nav-list">';
  for (var i = 0; i < (nodes || []).length; i++) {
    var node = nodes[i];
    var hasChildren = !!(node.children && node.children.length > 0);
    var nodeActive = target != null ? isActive(node, target, true) : false;
    var nodeExpanded = expandedSet ? !!expandedSet[node.id] : (target != null ? isExpanded(node, target, true) : false);
    if (hasChildren) {
      var titleHtml = node.indexHref
        ? '<a href="' + escAttr(rootRel + node.indexHref) + '" data-path="' + escAttr(node.indexHref) + '" class="drawer-nav-link"><span>' + node.label + '</span></a>'
        : '<span class="drawer-section-title-text">' + node.label + '</span>';
      var eager = recursive || nodeExpanded;
      var innerHtml = eager ? renderListHtml(node.children, target, rootRel, recursive, expandedSet) : "";
      var lazyAttr = eager ? "" : ' data-nav-lazy="1"';
      out += '<li class="drawer-nav-group ' + (nodeActive ? "active " : "") + (nodeExpanded ? "expanded" : "collapsed") + '" data-node-id="' + escAttr(node.id) + '"' + lazyAttr + '>'
        + '<div class="nav-group-header ' + (node.indexHref ? "" : "nav-header-clickable") + '">'
        + titleHtml
        + '<button class="nav-collapse-btn" aria-label="折叠或展开 ' + escAttr(node.label) + '" title="折叠/展开">'
        + '<svg class="chevron-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>'
        + '</button></div>'
        + '<div class="nav-nested-wrapper"><div class="nav-nested">' + innerHtml + '</div></div></li>';
    } else if (node.href) {
      out += '<li class="drawer-nav-item ' + (nodeActive ? "active" : "") + '" data-node-id="' + escAttr(node.id) + '">'
        + '<a href="' + escAttr(rootRel + node.href) + '" data-path="' + escAttr(node.href) + '" class="drawer-nav-link">'
        + '<span>' + node.label + '</span></a></li>';
    } else {
      out += '<li class="drawer-section-title" data-node-id="' + escAttr(node.id) + '">' + node.label + '</li>';
    }
  }
  out += "</ul>";
  return out;
}

function hydrateGroupEl(groupLi, nodes, recursive, expandedSet) {
  if (!groupLi || !nodes) return false;
  if (!groupLi.hasAttribute("data-nav-lazy")) {
    if (recursive) {
      var nestedLazies = groupLi.querySelectorAll("li[data-nav-lazy='1']");
      for (var k = 0; k < nestedLazies.length; k++) {
        hydrateGroupEl(nestedLazies[k], nodes, true, expandedSet);
      }
    }
    return true;
  }
  var id = groupLi.getAttribute("data-node-id");
  var node = findNode(nodes, id);
  var container = groupLi.querySelector(":scope > .nav-nested-wrapper > .nav-nested");
  if (!node || !node.children || !container) {
    groupLi.removeAttribute("data-nav-lazy");
    return false;
  }
  var target = document.body ? (document.body.getAttribute("data-site-path") || "") : "";
  var rootRel = (document.documentElement && document.documentElement.getAttribute("data-root")) || "./";
  container.innerHTML = renderListHtml(node.children, target, rootRel, recursive, expandedSet);
  groupLi.removeAttribute("data-nav-lazy");
  return true;
}

function hydrateIdsSync(nodes, ids) {
  if (!nodes || !ids || !ids.length) return;
  var expSet = {};
  for (var i = 0; i < ids.length; i++) expSet[ids[i]] = 1;
  // 按从外到内顺序水合（数组里祖先先于后代），确保父级渲染出子级 DOM 后再继续向下。
  var progress = true;
  while (progress) {
    progress = false;
    for (var j = 0; j < ids.length; j++) {
      var el = document.querySelector('li[data-node-id="' + ids[j].replace(/"/g, '\\"') + '"][data-nav-lazy="1"]');
      if (el && hydrateGroupEl(el, nodes, false, expSet)) progress = true;
    }
  }
}

function ensureHydrated(groupLi) {
  if (!groupLi || !groupLi.hasAttribute("data-nav-lazy")) return Promise.resolve(true);
  return loadNavJson().then(function (data) {
    if (!data || !data.nodes) return false;
    return hydrateGroupEl(groupLi, data.nodes, false, null);
  });
}

function hydrateAll() {
  return loadNavJson().then(function (data) {
    if (!data || !data.nodes) return false;
    var lazies = document.querySelectorAll("li[data-nav-lazy='1']");
    for (var i = 0; i < lazies.length; i++) {
      hydrateGroupEl(lazies[i], data.nodes, true, null);
    }
    return true;
  });
}

window.__navStructure = {
  NAV_JSON_ID: NAV_JSON_ID,
  PAGES_JSON_ID: PAGES_JSON_ID,
  readNavJson: readNavJson,
  readPagesJson: readPagesJson,
  loadNavJson: loadNavJson,
  loadPagesJson: loadPagesJson,
  collectActive: collectActive,
  hydrateIdsSync: hydrateIdsSync,
  ensureHydrated: ensureHydrated,
  hydrateAll: hydrateAll
};
})();`;