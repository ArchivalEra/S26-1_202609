/**
 * 站点语义工具：把页面的**交互能力**注册成 WebMCP 工具（独立可拆卸模块）。
 *
 * 与 `工具/mcp-端点/`（读层）的分工：
 *   - **读层**给「内容」——搜全站、取正文、查符号，不需要浏览器；
 *   - **本模块**给「交互」——跳锚点、开搜索面板、展开折叠、查页面上的符号，
 *     这些只有在**打开的页面上**才有意义。
 *
 * ## 结构（2026-10-16 候选 2+5 重构）
 *
 *   ① **page-view**（本文件下半部分）：**纯函数 + 依赖注入**——输入是「一个像 document 的对象」，
 *      输出是结构化页面事实。站点主题的选择器全部收缩在这一层。
 *   ② **工具定义**：在 page-view 之上写，不含任何 `querySelector`。
 *   ③ **内联**：`WEBMCP_TOOLS_JS` 用 `Function.prototype.toString()` 把上面两者原样塞进页面
 *      ——**与站点既有做法一致**（`site-search.mjs` 的 `SEARCH_JS`、`math-glossary.mjs` 的 `GLOSSARY_JS`）。
 *
 * ## 为什么这么改（候选 2 的教训）
 * 从前本文件**全文是一个模板字符串、无导出函数、零测试**——而浏览器跑的就是那份字符串。
 * 结果：Chromium 下 5 个工具全灭（第一行只认 `navigator.modelContext`）**改坏了没人拦**，
 * 测试只能对字符串做 `.includes()` 子串断言。现在 page-view 是**真函数**，
 * 可以直接喂假 DOM 测——**测试跑的就是浏览器跑的那份**。
 *
 * ## 为什么用 DOM 接口而不是内部 API
 * 站点的搜索/气泡/折叠模块只暴露纯函数（`window.__siteSearch` 那类），没有「跑一次搜索」的编程入口。
 * 所以交互走 DOM：点按钮、填输入框、派发事件——**与真人操作同一条路径**。
 *
 * ## 工具清单（名字带 `site_` 前缀，避与读层的 `course_`、relay 的 `webmcp_` 相撞）
 *   site_get_page_info  当前页信息（标题、课程、类别、小节清单）
 *   site_open_section   跳到某小节（按标题或锚点）
 *   site_search         用页面自带的搜索面板搜（返回命中标题与链接）
 *   site_show_symbol    查页面上某个符号（点开它的气泡）
 *   site_toggle_panels  展开/收起全部折叠面板
 */

// ════════════════════════════════════════════════════════════════
// ① page-view：选择器与发布格式的唯一集中处（纯函数，依赖注入）
// ════════════════════════════════════════════════════════════════

/** 站点主题的选择器与发布文案（**改主题只改这里**）。 */
export const PAGE_SELECTORS = {
  articleHeadings: '.article-content h2, .article-content h3, .article-content h4',
  articleTitle: '.article-content h1',
  courseChip: '.meta-chip',
  details: 'details',
  glossaryTerm: '.katex [data-term]',
  glossaryBubble: '.glossary-bubble, .sym-bubble, [class*=bubble]',
  searchPanel: 'search-panel',
  searchInput: 'search-input',
  searchResults: 'search-results',
  searchHit: '.search-hit',
  searchHitTitle: '.search-hit-title',
  /** 搜索结果总数文案：「仅显示相关度最高的 N 页（共 M 页命中）」。 */
  hitCountRe: /共\s*(\d+)\s*页命中/,
};

/** 取元素文字（空/缺失都给空串——**永不返回 undefined**，调用方不必再判）。 */
export function textOf(el) {
  return el ? (el.textContent || '').trim() : '';
}

/**
 * 建 page-view。
 * @param {object} doc  像 `document` 的对象（测试可喂假 DOM）
 * @param {object} [loc] 像 `location` 的对象（默认取 `doc.location` 或空）
 */
export function createPageView(doc, loc) {
  const S = PAGE_SELECTORS;
  const location = loc || (doc && doc.location) || { href: '' };

  /** 当前页的小节清单（标题、层级、锚点）。 */
  function headings() {
    return Array.prototype.slice.call(doc.querySelectorAll(S.articleHeadings))
      .map((h) => ({ level: Number(String(h.tagName || '').slice(1)), title: textOf(h), anchor: h.id }))
      .filter((h) => h.title);
  }

  /** 当前页信息。 */
  function pageInfo() {
    const titleEl = doc.querySelector(S.articleTitle);
    const chip = doc.querySelector(S.courseChip);
    return {
      title: titleEl ? textOf(titleEl) : (doc.title || ''),
      // 课程 chip 的文字形如「📚 电机学」——去掉前缀 emoji 与空白。
      course: chip ? textOf(chip).replace(/^\S+\s*/, '') : '',
      url: location.href || '',
      sections: headings(),
    };
  }

  /**
   * 跳到某小节（按标题片段或锚点 id）。会**展开它所在的折叠面板**（与深链接同一条路径）。
   * @returns {{ok:boolean, title?:string, anchor?:string, reason?:string, available?:string[]}}
   */
  function openSection(byTitle, byAnchor, win) {
    const list = headings();
    let target = null;
    if (byAnchor) {
      target = doc.getElementById(byAnchor);
    } else if (byTitle) {
      const needle = String(byTitle).trim();
      const hit = list.filter((h) => h.title.indexOf(needle) >= 0);
      if (hit.length) target = doc.getElementById(hit[0].anchor);
    }
    if (!target) {
      return { ok: false, reason: 'not_found', available: list.map((h) => h.title).slice(0, 30) };
    }
    for (let node = target; node; node = node.parentElement) {
      if (node.tagName === 'DETAILS' && !node.open) node.open = true;
    }
    const w = win || (doc.defaultView || null);
    try { target.scrollIntoView({ block: 'start' }); } catch { try { target.scrollIntoView(); } catch { /* 无滚动也能返回锚点 */ } }
    return { ok: true, title: textOf(target), anchor: target.id };
  }

  /** 展开/收起全部折叠面板（不传 open 则切换）。 */
  function togglePanels(open) {
    const ds = Array.prototype.slice.call(doc.querySelectorAll(S.details));
    const want = (open === undefined) ? null : !!open;
    ds.forEach((d) => { d.open = (want === null) ? !d.open : want; });
    return { count: ds.length, open: want === null ? 'toggled' : want };
  }

  /** 页面上首个匹配某符号的可点元素（没命中返回 null）。 */
  function findSymbol(needle) {
    const nodes = Array.prototype.slice.call(doc.querySelectorAll(S.glossaryTerm));
    return nodes.find((n) => (n.getAttribute('data-term') || '').indexOf(needle) >= 0
      || textOf(n).indexOf(needle) >= 0) || null;
  }

  /** 搜索面板里的命中列表与总数（读 DOM，不重跑检索）。 */
  function searchResults() {
    const hits = Array.prototype.slice.call(doc.querySelectorAll(S.searchHit)).map((a) => ({
      title: textOf(a.querySelector(S.searchHitTitle)),
      href: a.getAttribute('href'),
    }));
    const txt = textOf(doc.getElementById(S.searchResults));
    const m = txt.match(S.hitCountRe);
    return { total: m ? Number(m[1]) : hits.length, hits: hits.slice(0, 12) };
  }

  /** 搜索面板的输入框与容器（打开面板用）。 */
  function searchUi() {
    return { panel: doc.getElementById(S.searchPanel), input: doc.getElementById(S.searchInput) };
  }

  return { headings, pageInfo, openSection, togglePanels, findSymbol, searchResults, searchUi };
}

// ════════════════════════════════════════════════════════════════
// ② 工具定义（在 page-view 之上；不含任何 querySelector）
// ════════════════════════════════════════════════════════════════

/** 把「注入的 DOM 环境」变成 5 个工具定义。 */
export function buildToolDefs(doc, win) {
  const view = createPageView(doc);
  const w = win || (doc && doc.defaultView) || null;

  return [
    {
      name: 'site_get_page_info',
      description: '取当前页的信息：标题、所属课程、小节清单（含锚点）。',
      inputSchema: { type: 'object', properties: {} },
      execute: () => view.pageInfo(),
    },
    {
      name: 'site_open_section',
      description: '跳到本页的某个小节（按标题片段或锚点 id），会自动展开折叠面板。',
      inputSchema: { type: 'object', properties: { title: { type: 'string' }, anchor: { type: 'string' } } },
      execute: (a) => view.openSection(a && a.title, a && a.anchor, w),
    },
    {
      name: 'site_search',
      description: '用页面自带的搜索面板搜全站，返回命中标题与链接。',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      execute: (a) => {
        const q = String((a && a.query) || '').trim();
        if (!q) return { ok: false, reason: 'empty_query' };
        const { panel, input } = view.searchUi();
        if (!input) return { ok: false, reason: 'search_ui_missing' };
        if (panel) panel.hidden = false;
        input.focus();
        input.value = q;
        // 事件构造器从注入的 win 取（同 show_symbol：浏览器里等价，测试环境也能跑）。
        const win = w || {};
        const InputEvent = win.Event || (typeof Event !== 'undefined' ? Event : null);
        if (InputEvent) input.dispatchEvent(new InputEvent('input', { bubbles: true }));
        // 面板是异步渲染的——等一拍再读（与真人「输入后等一下」同）。
        return new Promise((resolve) => {
          const read = () => {
            const r = view.searchResults();
            if (r.hits.length || r.total) resolve({ ok: true, query: q, ...r });
            else resolve({ ok: true, query: q, ...r });
          };
          (w && w.setTimeout ? w.setTimeout : setTimeout)(read, 1200);
        });
      },
    },
    {
      name: 'site_show_symbol',
      description: '查本页上某个符号的含义（点开它的气泡），返回气泡文字。',
      inputSchema: { type: 'object', properties: { term: { type: 'string' } }, required: ['term'] },
      execute: (a) => {
        const needle = String((a && a.term) || '').trim();
        if (!needle) return { ok: false, reason: 'empty_term' };
        const el = view.findSymbol(needle);
        if (!el) {
          const total = doc.querySelectorAll(PAGE_SELECTORS.glossaryTerm).length;
          return { ok: false, reason: 'symbol_not_on_page', total };
        }
        try { el.scrollIntoView({ block: 'center' }); } catch { /* 无滚动不影响点击 */ }
        // 走与真人点击同一条路径（气泡脚本监听 click）。
        // **事件构造器从注入的 win 取**，不直接用全局 `MouseEvent`——
        // 浏览器里两者等价，但这样测试环境（无 DOM 构造器）也能跑（2026-10-16 测试抓出）。
        const win = w || {};
        const ClickEvent = win.MouseEvent || (typeof MouseEvent !== 'undefined' ? MouseEvent : null);
        if (ClickEvent) {
          el.dispatchEvent(new ClickEvent('click', { bubbles: true, cancelable: true, view: win }));
        } else {
          el.click && el.click();
        }
        // **气泡是异步渲染的**（点击后下一拍才进 DOM）——同步读会恒空。
        // 与 site_search 同款：等一拍再回读（2026-10-16 测试抓出）。
        const read = () => ({
          ok: true,
          term: el.getAttribute('data-term'),
          bubble: textOf(doc.querySelector(PAGE_SELECTORS.glossaryBubble)).slice(0, 400),
        });
        return new Promise((resolve) => {
          (w && w.setTimeout ? w.setTimeout : setTimeout)(() => resolve(read()), 250);
        });
      },
    },
    {
      name: 'site_toggle_panels',
      description: '展开或收起本页全部折叠面板（不传 open 则切换）。',
      inputSchema: { type: 'object', properties: { open: { type: 'boolean' } } },
      execute: (a) => view.togglePanels(a && a.open),
    },
  ];
}

// ════════════════════════════════════════════════════════════════
// ③ 内联：把上面两者原样塞进页面（与站点既有做法一致）
// ════════════════════════════════════════════════════════════════

/** 注册引导：探测两个注册表、建 defs、逐个注册。依赖注入（document/navigator 由页面给）。
 *  @returns {number} **尝试注册的个数**（不是成功数——单个抛错不影响其余，也不该让计数漏掉那一个）。 */
export function registerTools(doc, nav) {
  // **两个注册表都要探测**（2026-10-16 修）：
  //   Firefox 原生只有 navigator.modelContext；Chromium 走 polyfill 只有 document.modelContext。
  //   只认 navigator ⇒ Chromium 下第一行就 return、工具一个都没注册（实测踩到）。
  const mc = (doc && doc.modelContext) || (nav && nav.modelContext) || null;
  if (!mc || typeof mc.registerTool !== 'function') return 0;
  const defs = buildToolDefs(doc, (doc && doc.defaultView) || null);
  let attempts = 0;
  for (const d of defs) {
    attempts += 1; // 先记「试了」——单个失败不该把它算漏（2026-10-16 测试抓出的计数偏差）
    try { Promise.resolve(mc.registerTool(d)).catch(() => {}); } catch { /* 单个失败不影响其余 */ }
  }
  return attempts;
}

/**
 * 把「含 RegExp 的配置对象」序列化成**可还原的 JS 源码**。
 * `JSON.stringify` 会把 `RegExp` 变成 `{}`——所以 `hitCountRe` 得显式写成
 * `new RegExp("...")` 的字面，才能在页面里还原成真正则。
 */
export function serializeSelectors(sel) {
  const parts = Object.entries(sel).map(([k, v]) => {
    if (v instanceof RegExp) return `${JSON.stringify(k)}:new RegExp(${JSON.stringify(v.source)})`;
    return `${JSON.stringify(k)}:${JSON.stringify(v)}`;
  });
  return `{${parts.join(',')}}`;
}

/**
 * 站点工具的源码（构建期内联；浏览器端执行）。
 *
 * **每一段都由上面的真函数 `toString()` 派生**——测试跑的就是浏览器跑的
 * （从前这里是一份手写的独立字符串，与可测版本各活各的，改坏了没人拦）。
 */
export const WEBMCP_TOOLS_JS = `(function () {
"use strict";
if (typeof document === "undefined") return;

var PAGE_SELECTORS = ${serializeSelectors(PAGE_SELECTORS)};
var textOf = ${textOf.toString()};
var createPageView = ${createPageView.toString()};
var buildToolDefs = ${buildToolDefs.toString()};
var registerTools = ${registerTools.toString()};
registerTools(document, typeof navigator !== "undefined" ? navigator : null);
})();`;
