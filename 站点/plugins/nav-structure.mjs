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
  if (/\/index\.md$/.test(mdPath)) return mdPath.replace(/\/index\.md$/, '/');
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
 * 自身 active 或任一后代 active（组节点据此展开）。
 * @param {object} node
 * @param {string} target
 * @param {boolean} [htmlSpace=false]
 */
export function isExpanded(node, target, htmlSpace) {
  if (!node) return false;
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
  if (!node || !node.children || !node.children.length) return null;
  if (!node.path || !/index\.md$/.test(node.path)) return null;
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
    const children = raw.children && raw.children.length
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
 * 浏览器内联的运行时代码（与 webmcp-tools.mjs 的 WEBMCP_TOOLS_JS 同款模式）。
 * drawer-sync.mjs 把它拼在自己的 IIFE 之前，得到一份自包含产物。
 *
 * 暴露：
 *   window.__navStructure.NAV_JSON_ID     JSON 脚本 id
 *   window.__navStructure.readNavJson()   读 `#nav-structure-json`（缺失/损坏返回 null）
 *   window.__navStructure.collectActive() 同 buildNavModel 用的那份判定（html 空间）
 *
 * **每一段都由上面的真函数 `.toString()` 派生**——测试跑的就是浏览器跑的。
 */
export const NAV_STRUCTURE_JS = `(function () {
"use strict";
if (typeof window === "undefined" || window.__navStructure) return;
var NAV_JSON_ID = "nav-structure-json";
var nodeKey = ${nodeKey.toString()};
var isActive = ${isActive.toString()};
var isExpanded = ${isExpanded.toString()};
var collectActive = ${collectActive.toString()};
function readNavJson() {
  try {
    var tag = document.getElementById(NAV_JSON_ID);
    if (!tag) return null;
    var data = JSON.parse(tag.textContent || "");
    return (data && Array.isArray(data.nodes)) ? data : null;
  } catch (e) { return null; }
}
window.__navStructure = { NAV_JSON_ID: NAV_JSON_ID, readNavJson: readNavJson, collectActive: collectActive };
})();`;