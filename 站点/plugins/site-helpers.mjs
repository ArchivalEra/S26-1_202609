/**
 * 站点语义便利函数（Q19 从原 WebMCP 协议栈退役而来）。
 *
 * 正常页面加载零字节下发；仅作纯辅助函数导出（测试、Playwright/WebBridge eval、
 * 或 URL 带 `?helpers=1` 显式按需加载到 `window.__siteHelpers`）。
 *
 * ## 结构
 *   ① **page-view**：纯函数 + 依赖注入——输入 `document` 抽象，输出结构化页面事实。
 *   ② **helper defs**：在 page-view 之上提供统一动作定义与 `runTool` 分派入口。
 *   ③ **按需包**：`SITE_HELPERS_JS` 用 `Function.prototype.toString()` 派生浏览器包，
 *      不向 `document.modelContext` / `navigator.modelContext` 自动注册协议工具。
 */

// ════════════════════════════════════════════════════════════════
// ① page-view：选择器与发布格式的唯一集中处（纯函数，依赖注入）
// ════════════════════════════════════════════════════════════════

/** 站点主题的选择器与发布文案（**改主题只改这里**）。 */
// 「什么是一个符号」的唯一真相住在 站点/symbols/contracts.mjs。
import { SYMBOL_SELECTOR, SYMBOL_JSON_SCRIPT_ID } from '../symbols/index.mjs';

export const PAGE_SELECTORS = {
  article: '.article-content',
  articleHeadings: '.article-content h2, .article-content h3, .article-content h4',
  articleTitle: '.article-content h1',
  // 正文配图（本站主要是 webp；外部视觉客户端通常只接收 jpg/png，所以要能列出来再转码）
  articleImages: '.article-content img',
  courseChip: '.meta-chip',
  details: 'details',
  glossaryTerm: SYMBOL_SELECTOR,
  glossaryBubble: '.sym-gloss-pop',
  glossaryJson: SYMBOL_JSON_SCRIPT_ID,
  searchPanel: 'search-panel',
  searchInput: 'search-input',
  searchResults: 'search-results',
  searchHit: '.search-hit',
  searchHitTitle: '.search-hit-title',
  /** 搜索结果总数文案：「仅显示相关度最高的 N 页（共 M 页命中）」。 */
  hitCountRe: /共\s*(\d+)\s*页命中/,
  tocItem: '.toc-item',
  tocActive: '.toc-item.active',
  navLink: 'a.drawer-nav-link',
  navGroup: 'li.drawer-nav-group',
  /** 侧栏形状烘焙（阶段一）：nav-structure.mjs 产出的 JSON 的脚本 id。
   *  site_index / site_navigate 都读它，不再爬侧栏 DOM。 */
  navJson: 'nav-structure-json',
  /** 站点**实际生成了的页面**清单（构建期从 页面清单.mjs 烘进每页）。
   *  site_navigate 的 to=page 用它判「这页到底存不存在」——侧栏形状只覆盖导航里的页，
   * 拿它当白名单会让 README / 符号包这类页面进不去，也会让拼错的路径（少了课程层）
   * 蒙混过关。 */
  pagesJson: 'site-pages-json',
  pagingPrev: 'a.paging-prev',
  pagingNext: 'a.paging-next',
  brand: 'a.sidebar-brand',
  copyBtn: 'button.copy-btn',
  katex: '.katex',
  /** 读正文时整段丢弃的标签（不是内容）。 */
  skipTags: 'SCRIPT,STYLE,NOSCRIPT,TEMPLATE,SVG',
};

/** 取元素文字（空/缺失都给空串——**永不返回 undefined**，调用方不必再判）。 */
export function textOf(el) {
  return el ? (el.textContent || '').trim() : '';
}

/** 元素是否带某个 class（不依赖 classList，假 DOM 也能跑）。 */
export function hasClass(el, name) {
  return (' ' + String((el?.className) || '') + ' ').indexOf(' ' + name + ' ') >= 0;
}

/**
 * 把一段 DOM 渲染成 **Markdown 文本**（模型读得懂的结构）。
 *
 * 为什么是 Markdown 而不是纯文本：标题层级、列表、表格、代码块都是内容的一部分；
 * 拍平成纯文本后「第 3 步」和「第 1 步」在模型眼里没有区别。
 *
 * @param {object} root  像 Element 的对象（一般是 `.article-content`）
 * @param {object} [opts]
 * @param {boolean} [opts.includeCollapsed=true] 折叠面板里未展开的内容要不要读（默认读，加〔折叠〕标记）
 * @returns {string}
 */
/** 子节点（**必须用 childNodes**：`children` 只含元素，会把段落里的裸文字整段丢掉
 *  ——2026-10-19 实测「式中 p_h ——每磁化一周引起的磁滞损耗」的说明全没了）。 */
export function childrenOf(node) {
  if (!node) return [];
  const list = node.childNodes || node.children;
  if (!list) return [];
  return Array.prototype.slice.call(list);
}

/** 文本节点判定（假 DOM 里文本节点是带 tagName='' 的普通对象）。 */
export function isTextNode(n) {
  return n && (n.nodeType === 3 || (!n.tagName && typeof n.textContent === 'string'));
}

export function renderMarkdown(root, opts) {
  const o = opts || {};
  const includeCollapsed = o.includeCollapsed !== false;
  // links（2026-10-19 grill Q15 定案）：默认**关**。开了之后站内相对链接渲染成
  // `[文字](路径)`，外链渲染成 `[文字](http://…)`（前缀 ⧉ 标记，提示 site_navigate 跳不了），
  // 页内锚点渲染成 `[文字](#id)`。
  // 为什么默认关：整页读取时链接会显著增加字数（正文里「见第 2 章」这类引用很多），
  // 而导航已经由 site_index 承担；只在需要「顺着正文引用走」时才开。
  const withLinks = o.links === true;

  /** 把 <a> 的 href 归成模型能用的形态；返回 null 表示这个链接不该渲染成链接。
   *
   *  ⚠️ 2026-10-19 实测：构建产物里的站内链接是**百分号编码**的
   *  （`./%E5%B7%A5%E7%A8%8B%E6%95%B0%E5%AD%A6/index.html`），模型拿这串去
   *  site_navigate 很难受。这里解码成可读中文路径；跳转时 site_navigate 会重新编码。
   */
  function linkTarget(href) {
    const h = String(href || '').trim();
    if (!h) return null;
    if (h.startsWith('#')) return { kind: 'anchor', href: h };
    if (/^(https?:|mailto:)/i.test(h)) return { kind: 'external', href: h };
    if (/^javascript:/i.test(h)) return null;
    let decoded = h;
    try { decoded = decodeURI(h); } catch (_e) { /* 保留原样 */ }
    return { kind: 'internal', href: decoded };
  }
  const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1 };
  const out = [];

  const push = (s) => { if (s) out.push(s); };
  const ensureNl = (n) => {
    let tail = '';
    for (let i = out.length - 1; i >= 0 && tail.length < n; i--) tail = out[i] + tail;
    const have = (tail.match(/\n/g) || []).length;   // 计数场景：要全部匹配（exec 只给第一个）
    for (let i = have; i < n; i++) out.push('\n');
  };
  /** KaTeX：优先用 annotation 里的 LaTeX 源（模型读公式最准），退化到可见文本。
   *
   *  ⚠️ 2026-10-19 两个真缺陷（实测页面读出 BBBHHH 与 \htmlData{...}）：
   *   ① annotation 里存的是**取词前**的 LaTeX 源，但站点在 KaTeX 渲染后往公式里
   *      注入了 `\htmlData{term=sym-x}{…}` 包裹——那是给浏览器点击用的，对模型是纯噪声。
   *      读之前必须剥掉这层包裹，只留内容。
   *   ② KaTeX 输出**两份**：`<span class="katex-mathml">`（含 annotation）与
   *      `<span class="katex-html" aria-hidden="true">`（可见副本）。两份都读会重复。
   *      只读 mathml 那一份。
   */
  function katexText(el) {
    // 构建期已把 IR 的**纯文本投影**烘进 `data-math-plain`（见 站点/math/render.mjs）。
    // 这是首选：一串人读得懂的文本，不含任何 LaTeX 与装饰宏。
    // 2026-10-29 换引擎前这里靠读 `<annotation>` 再剥 `\htmlData`——那是
    // 「从产物反推语义」，换引擎就失效，而且剥壳函数本身又是一处 bug 面。
    const plain = el.getAttribute ? el.getAttribute('data-math-plain') : null;
    if (plain) return plain;
    const aria = el.getAttribute ? el.getAttribute('aria-label') : null;
    if (aria) return aria;
    // 兜底：公式的可见文本（MathLive 产物里带的是排版后的字符）
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  const INLINE_SIMPLE = {
    CODE: (n) => '`' + (n.textContent || '') + '`',
    STRONG: (n) => '**' + walkInlineAll(n) + '**',
    B: (n) => '**' + walkInlineAll(n) + '**',
    EM: (n) => '*' + walkInlineAll(n) + '*',
    I: (n) => '*' + walkInlineAll(n) + '*',
    BR: () => '\n',
  };

  function formatAnchorLink(node) {
    const t = linkTarget(node.getAttribute?.('href'));
    const label = walkInlineAll(node).trim();
    if (!t || !label) return label;
    return (t.kind === 'external' ? '⧉[' : '[') + label + '](' + t.href + ')';
  }

  function renderAnchorInline(node) {
    if (hasClass(node, 'sym-gloss')) {
      const k = childrenOf(node).find((c) => hasClass(c, 'katex'));
      return k ? katexText(k) : (node.textContent || '');
    }
    return withLinks ? formatAnchorLink(node) : null;
  }

  function isHiddenInline(node, tag) {
    return Boolean(SKIP[tag] || hasClass(node, 'katex-html') || hasClass(node, 'katex-mathml') || hasClass(node, 'm3-disclosure__indicator'));
  }

  function isMathInline(node) {
    return Boolean(hasClass(node, 'katex') || hasClass(node, 'ML__latex') || node.getAttribute?.('data-math-plain'));
  }

  function walkInlineElement(node, tag) {
    if (tag === 'A') {
      const res = renderAnchorInline(node);
      if (res !== null) return res;
    }
    if (INLINE_SIMPLE[tag]) return INLINE_SIMPLE[tag](node);
    const kids = childrenOf(node);
    return kids.length ? kids.map(walkInline).join('') : (node.textContent || '');
  }

  function walkInline(node) {
    if (!node) return '';
    if (isTextNode(node)) return node.textContent || '';
    const tag = String(node.tagName || '').toUpperCase();
    if (isHiddenInline(node, tag)) return '';
    if (isMathInline(node)) return katexText(node);
    return walkInlineElement(node, tag);
  }

  function walkInlineAll(node) {
    return childrenOf(node).map(walkInline).join('');
  }

  function walkBlockquote(node, depth) {
    ensureNl(1);
    const mark = out.length;
    childrenOf(node).forEach((c) => walk(c, depth));
    const inner = out.splice(mark).join('').trim();
    if (inner) push(inner.split('\n').map((l) => '> ' + l).join('\n') + '\n\n');
  }

  function walkList(node, tag, depth) {
    ensureNl(1);
    const items = childrenOf(node).filter((c) => String(c.tagName || '').toUpperCase() === 'LI');
    items.forEach((li, i) => {
      const marker = tag === 'OL' ? `${i + 1}. ` : '- ';
      const mark = out.length;
      childrenOf(li).forEach((c) => walk(c, depth + 1));
      const body = out.splice(mark).join('').trim()
        .replace(/\n{2,}/g, '\n').replace(/\n/g, '\n  ');
      push(marker + body + '\n');
    });
    push('\n');
  }

  function walkTable(node) {
    ensureNl(2);
    const rows = [];
    (function collect(n) {
      for (const c of childrenOf(n)) {
        const ct = String(c.tagName || '').toUpperCase();
        if (ct === 'TR') rows.push(c);
        else if (ct === 'THEAD' || ct === 'TBODY' || ct === 'TFOOT') collect(c);
      }
    })(node);
    const lines = rows.map((tr) => {
      const cells = childrenOf(tr)
        .filter((c) => /^T[HD]$/.test(String(c.tagName || '').toUpperCase()))
        .map((c) => walkInlineAll(c).trim().replace(/\n+/g, ' ').replace(/\|/g, '\\|'));
      return '| ' + cells.join(' | ') + ' |';
    });
    if (!lines.length) return;
    const cols = (lines[0].match(/\|/g) || []).length - 1;
    lines.splice(1, 0, '|' + Array(cols).fill(' --- ').join('|') + '|');
    push(lines.join('\n') + '\n\n');
  }

  function walkPre(node) {
    ensureNl(2);
    const codeEl = childrenOf(node).find((c) => String(c.tagName || '').toUpperCase() === 'CODE');
    const lang = codeEl ? (codeEl.getAttribute?.('class') || codeEl.className || '') : '';
    const m = /language-([\w-]+)/.exec(String(lang));
    push('```' + (m ? m[1] : '') + '\n' + ((codeEl || node).textContent || '').replace(/\n$/, '') + '\n```\n\n');
  }

  function walkDetails(node, depth) {
    const open = node.open !== false;
    if (!open && !includeCollapsed) return;
    const kids = childrenOf(node);
    const sum = kids.find((c) => String(c.tagName || '').toUpperCase() === 'SUMMARY');
    ensureNl(2);
    if (sum) {
      const title = walkInline(sum).replace(/\s+/g, ' ').trim();
      if (title) push('**' + title + '**' + (open ? '' : '〔折叠〕') + '\n\n');
    } else if (!open) {
      push('〔折叠〕\n\n');
    }
    kids.filter((c) => c !== sum).forEach((c) => walk(c, depth));
    ensureNl(1);
  }

  const WALK_TAGS = {
    A: (n) => push(walkInline(n)),
    P: (n) => { const t = walkInline(n).trim(); if (t) { ensureNl(1); push(t + '\n\n'); } },
    BLOCKQUOTE: (n, d) => walkBlockquote(n, d),
    UL: (n, d) => walkList(n, 'UL', d),
    OL: (n, d) => walkList(n, 'OL', d),
    TABLE: (n) => walkTable(n),
    PRE: (n) => walkPre(n),
    HR: () => { ensureNl(2); push('---\n\n'); },
    DETAILS: (n, d) => walkDetails(n, d),
    SUMMARY: () => {},
  };

  function walkElement(node, tag, depth) {
    if (hasClass(node, 'katex-scroll-container') || hasClass(node, 'katex-display')) { ensureNl(2); push(walkInline(node) + '\n\n'); return; }
    if (/^H[1-6]$/.test(tag)) { ensureNl(2); push('\n' + '#'.repeat(Number(tag.slice(1))) + ' ' + walkInline(node).trim() + '\n\n'); return; }
    if (WALK_TAGS[tag]) { WALK_TAGS[tag](node, depth); return; }
    const kids = childrenOf(node);
    if (kids.length) kids.forEach((c) => walk(c, depth));
    else { const t = (node.textContent || '').trim(); if (t) { ensureNl(1); push(t + '\n'); } }
  }

  function isSkippableBlock(node, tag) {
    return Boolean(SKIP[tag] || hasClass(node, 'katex-html') || hasClass(node, 'katex-mathml'));
  }

  function walk(node, depth) {
    if (!node) return;
    if (isTextNode(node)) {
      const t = (node.textContent || '').trim();
      if (t) { ensureNl(1); push(t); }
      return;
    }
    const tag = String(node.tagName || '').toUpperCase();
    if (isSkippableBlock(node, tag)) return;
    if (isMathInline(node)) { push(katexText(node)); return; }
    walkElement(node, tag, depth);
  }

  walk(root, 0);
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 建 page-view。
 * @param {object} doc  像 `document` 的对象（测试可喂假 DOM）
 * @param {object} [loc] 像 `location` 的对象（默认取 `doc.location` 或空）
 */
export function createPageView(doc, loc, winOverride) {
  const S = PAGE_SELECTORS;
  const location = loc || (doc?.location) || { href: '' };
  // winOverride 让调用方（含测试）注入一个「像 window 的对象」——
  // 需要 Image/canvas 的图片转码、需要 getComputedStyle 的显示设置都靠它。
  const win = winOverride || (doc?.defaultView) || null;

  const all = (sel) => {
    try { return Array.prototype.slice.call(doc.querySelectorAll(sel)); } catch { return []; }   // 坏选择器按空集
  };
  const first = (sel) => {
    try { return doc.querySelector(sel); } catch { return null; }   // 坏选择器按未找到
  };
  const byId = (id) => { try { return doc.getElementById(id); } catch { return null; } };

  /** 当前页的小节清单（标题、层级、锚点）。 */
  function headings() {
    return all(S.articleHeadings)
      .map((h) => ({ level: Number(String(h.tagName || '').slice(1)), title: textOf(h), anchor: h.id }))
      .filter((h) => h.title);
  }

  /** 课程 chip：优先带 primary 的那个（首页/无课程页可能没有）。 */
  function courseChip() {
    const chips = all(S.courseChip);
    return chips.find((c) => hasClass(c, 'primary')) || chips[0] || null;
  }

  /** 当前 TOC 高亮项（滚动高亮由主题脚本维护 .active）。 */
  function activeToc() {
    const el = first(S.tocActive);
    if (!el) return null;
    const a = el.querySelector ? el.querySelector('a') : null;
    return { title: textOf(el), anchor: a ? String(a.getAttribute('href') || '').replace(/^#/, '') : '' };
  }

  /** 折叠面板状态汇总。 */
  function panelState() {
    const ds = all(S.details);
    return { total: ds.length, open: ds.filter((d) => d.open).length };
  }

  function tryReadInt(fn) {
    try {
      const v = fn();
      return v ? parseInt(v, 10) : null;
    } catch (_e) { return null; }
  }

  /** 显示设置（主题 / 色相 / 侧栏）。 */
  function readHue(rootEl) {
    if (!rootEl) return null;
    const computed = tryReadInt(() => win?.getComputedStyle?.(rootEl).getPropertyValue('--hue'));
    if (computed !== null) return computed;
    return tryReadInt(() => rootEl.style?.getPropertyValue?.('--hue') || rootEl.getAttribute?.('data-hue'));
  }

  function readSidebarState() {
    const drawer = byId('m3-drawer');
    if (drawer && hasClass(drawer, 'open')) return 'open';
    const body = doc?.body;
    return body && hasClass(body, 'sidebar-collapsed') ? 'collapsed' : null;
  }

  function viewState() {
    const rootEl = doc?.documentElement || null;
    const hue = readHue(rootEl);
    return {
      theme: rootEl?.getAttribute('data-theme') || null,
      hue: Number.isFinite(hue) ? hue : null,
      sidebar: readSidebarState(),
    };
  }

  function calcScrollPct(y, docObj, winObj) {
    const docHeight = docObj?.documentElement?.scrollHeight || 0;
    const viewH = winObj?.innerHeight || 0;
    return docHeight > viewH ? Math.min(100, Math.round(y / (docHeight - viewH) * 100)) : 0;
  }

  function readScrollPosition() {
    try {
      const y = Math.round(win?.scrollY || 0);
      return { scrollY: y, scrollPct: calcScrollPct(y, doc, win) };
    } catch (_e) {
      return { scrollY: 0, scrollPct: 0 };
    }
  }

  function readCourseLabel() {
    const chip = courseChip();
    return chip ? textOf(chip).replace(/^\S+\s*/, '') : '';
  }

  function readPageHeader() {
    const titleEl = first(S.articleTitle);
    return {
      title: titleEl ? textOf(titleEl) : (doc.title || ''),
      course: readCourseLabel(),
      url: location.href || '',
      path: doc?.body?.getAttribute('data-site-path') || '',
      hash: String(location.hash || '').replace(/^#/, ''),
    };
  }

  /** 当前页信息（含状态）。 */
  function pageInfo() {
    return {
      ...readPageHeader(),
      sections: headings(),
      activeToc: activeToc(),
      panels: panelState(),
      view: viewState(),
      position: readScrollPosition(),
    };
  }

  /**
   * 跳到某小节（按标题片段或锚点 id）。会**展开它所在的折叠面板**（与深链接同一条路径）。
   * @returns {{ok:boolean, title?:string, anchor?:string, reason?:string, available?:string[]}}
   */
  function findSectionTarget(byTitle, byAnchor, list) {
    const needle = byTitle ? String(byTitle).trim() : '';
    if (byAnchor) return { target: byId(byAnchor), needle };
    if (!byTitle) return { target: null, needle };
    const m = matchHeadings(list, needle);
    if (m.hits.length > 1) {
      return {
        error: {
          ok: false, reason: 'ambiguous', query: needle, tier: m.tier,
          candidates: m.hits.slice(0, 10).map((h) => ({ title: h.title, anchor: h.anchor })),
          hint: '这个 query 同时命中多个小节。从 candidates 里挑一个，用它的 anchor 重发。',
        },
      };
    }
    return { target: m.hits[0] ? byId(m.hits[0].anchor) : null, needle };
  }

  function openParentDetails(target) {
    for (let node = target; node; node = node.parentElement) {
      if (String(node.tagName || '').toUpperCase() === 'DETAILS' && !node.open) node.open = true;
    }
  }

  function syncSectionHash(id, win2) {
    if (!id) return;
    try {
      if (win2?.__disclosureOpen) win2.__disclosureOpen(id);
      else if (location && typeof location === 'object') location.hash = id;
    } catch (_e) { /* 无 hash 能力 */ }
  }

  function revealAndScroll(target, win2) {
    openParentDetails(target);
    syncSectionHash(target.id, win2);
    try { target.scrollIntoView({ block: 'start' }); } catch (_e) {
      try { target.scrollIntoView(); } catch (_e2) { /* 无滚动也能返回锚点 */ }
    }
  }

  function openSection(byTitle, byAnchor, win2) {
    const list = headings();
    const res = findSectionTarget(byTitle, byAnchor, list);
    if (res.error) return res.error;
    if (!res.target) {
      return {
        ok: false, reason: 'not_found', query: res.needle,
        candidates: nearestTitles(res.needle, list.map((h) => h.title)),
        hint: '标题里没有完全匹配。从 candidates 里挑一个最近的重试，或先调 site_read（what=outline）看全量标题。',
        available: list.map((h) => h.title).slice(0, 30),
      };
    }
    revealAndScroll(res.target, win2);
    return { ok: true, title: textOf(res.target), anchor: res.target.id };
  }

  /** 展开/收起折叠面板（不传 open 则切换；match 只作用于标题匹配的那些）。 */
  function togglePanels(open, match) {
    let ds = all(S.details);
    if (match) {
      const needle = String(match).trim();
      ds = ds.filter((d) => {
        const sum = d.querySelector ? d.querySelector('summary') : null;
        return (textOf(sum) + ' ' + textOf(d)).indexOf(needle) >= 0;
      });
    }
    const want = (open === undefined) ? null : !!open;
    const before = ds.map((d) => !!d.open);
    ds.forEach((d) => { d.open = (want === null) ? !d.open : want; });
    const changed = ds.filter((d, i) => !!d.open !== before[i]).length;
    return {
      count: ds.length, changed,
      open: want === null ? 'toggled' : want,
      state: panelState(),
    };
  }

  /** 读页内烘焙的符号词典 JSON（#sym-glossary-json），不经 DOM 气泡。 */
  function glossaryData() {
    const tag = byId(S.glossaryJson);
    if (!tag) return null;
    try {
      const data = JSON.parse(tag.textContent || '');
      if (!data || typeof data !== 'object' || !data.terms) return null;
      return data;
    } catch (_e) { return null; }
  }

  function matchGlossaryEntry(entries, n) {
    return entries.find(([k, e]) => e.id === n || k.endsWith(':' + n))
      || entries.find(([, e]) => String(e.titleText || e.title || '').split(/[：:]/)[0].trim() === n)
      || entries.find(([k, e]) => k.indexOf(n) >= 0 || String(e.titleText || e.title || '').indexOf(n) >= 0)
      || null;
  }

  /** 从 #sym-glossary-json 按规范 key / 裸 id / 标题精确或模糊查一条词条。 */
  function findGlossaryEntry(needle) {
    const n = String(needle || '').trim();
    if (!n) return null;
    const data = glossaryData();
    const terms = data?.terms;
    if (!terms) return null;
    if (Object.hasOwn(terms, n)) return { key: n, entry: terms[n], data };
    const hit = matchGlossaryEntry(Object.entries(terms), n);
    return hit ? { key: hit[0], entry: hit[1], data } : null;
  }

  /** 页面上首个匹配某符号的可点元素（没命中返回 null）。 */
  function findSymbol(needle) {
    const n = String(needle).trim();
    if (!n) return null;
    const nodes = all(S.glossaryTerm);
    // 先按 data-term 精确/包含，再退化到显示文字
    return nodes.find((x) => (x.getAttribute && String(x.getAttribute('data-term') || '').indexOf(n) >= 0))
      || nodes.find((x) => textOf(x).indexOf(n) >= 0)
      || null;
  }

  function buildSymbolRec(id, text, meta) {
    const rec = { id, text };
    if (meta?.titleText) rec.titleText = meta.titleText;
    if (meta?.pack) rec.pack = meta.pack;
    return rec;
  }

  function collectDomSymbols(seen, out, terms, limit) {
    for (const x of all(S.glossaryTerm)) {
      const id = String(x.getAttribute?.('data-term') || '');
      if (!id || seen[id]) continue;
      seen[id] = 1;
      out.push(buildSymbolRec(id, textOf(x), terms[id]));
      if (limit && out.length >= limit) return true;
    }
    return false;
  }

  function collectGlossarySymbols(seen, out, terms, limit) {
    for (const [id, meta] of Object.entries(terms)) {
      if (seen[id]) continue;
      seen[id] = 1;
      out.push(buildSymbolRec(id, meta.titleText || meta.id || id, meta));
      if (limit && out.length >= limit) break;
    }
  }

  /** 页面上全部符号（优先合并 #sym-glossary-json 的结构化元数据）。 */
  function listSymbols(limit) {
    const seen = {};
    const out = [];
    const terms = glossaryData()?.terms || {};
    if (collectDomSymbols(seen, out, terms, limit)) return out;
    collectGlossarySymbols(seen, out, terms, limit);
    return out;
  }

  function readJsonScript(id, isValid) {
    const tag = byId(id);
    if (!tag) return null;
    try {
      const data = JSON.parse(tag.textContent || '');
      return isValid(data) ? data : null;
    } catch { return null; }
  }

  /**
   * 读页内嵌的**侧栏形状**（阶段一）：`#nav-structure-json`，由 nav-structure.mjs
   * 构建期烘焙。这是 site_index / site_navigate 的**唯一数据源**——不再爬侧栏 DOM。
   * 返回 `{v, current, activeIds, expandedIds, nodes}`；缺失/损坏返回 null（调用方给明确 reason）。
   */
  function navStructure() {
    return readJsonScript(S.navJson, (d) => Array.isArray(d?.nodes))
      ?? win?.__navStructure?.readNavJson?.()
      ?? null;
  }

  function sitePages() {
    return readJsonScript(S.pagesJson, Array.isArray)
      ?? win?.__navStructure?.readPagesJson?.()
      ?? null;
  }

  /**
   * 把一个路径归一化成「站内网址路径」，用于和页面清单比对。
   *
   * 模型给的写法五花八门：`课程总览/x.html`、`/repo/S26-1_202609/课程总览/x.html`、
   * `./课程总览/x.html`、目录形式 `课程总览/x/`、`课程总览/x`。这里全收敛成
   * **清单里的那种形态**——2026-10-29 起清单用网址形态：目录索引页是 `课程总览/x/`，
   * 首页是 `''`，普通页是 `作业3.html`。
   *
   * 所以「补 index.html」这一步已经作废（那会把 `课程总览/` 变成
   * `课程总览/index.html`，与清单对不上）。现在：**带尾斜杠就当目录索引页原样保留**，
   * 不带后缀也不带斜杠的（`课程总览/x`）两种都试——先当目录，再当页面。
   *
   * 部署前缀（`/repo/S26-1_202609/`）不能写死——它随部署环境变，而且本站还有
   * 无前缀镜像入口。所以给绝对路径时不猜前缀，而是**按已知页面做后缀对齐**。
   */
  function matchAbsoluteSuffix(p, known) {
    const hit = known
      .filter((k) => k && (p === k || p.slice(-(k.length + 1)) === '/' + k))
      .sort((a, b) => b.length - a.length);
    return hit.length ? hit[0] : null;
  }

  function matchStemPath(p, known) {
    if (/\.html?$/i.test(p) || /[.][a-z0-9]+$/i.test(p)) return p;
    if (known.indexOf(p + '/') >= 0) return p + '/';
    return known.indexOf(p + '.html') >= 0 ? p + '.html' : p;
  }

  function matchKnownPath(p, wasAbsolute, known) {
    if (!known?.length) return p;
    if (wasAbsolute && known.indexOf(p) < 0) {
      const hit = matchAbsoluteSuffix(p, known);
      if (hit) return hit;
    }
    return known.indexOf(p) >= 0 ? p : matchStemPath(p, known);
  }

  function safeDecodeUri(s) {
    try { return decodeURI(s); } catch (_e) { return s; }
  }

  function parsePathInput(raw) {
    let p = safeDecodeUri(String(raw || '').trim());
    let wasAbsolute = /^https?:\/\//i.test(p) || p.charAt(0) === '/';
    if (/^https?:\/\//i.test(p)) {
      try { p = safeDecodeUri(new URL(p).pathname); } catch (_e) { /* 保持原样 */ }
      wasAbsolute = true;
    }
    return { p, wasAbsolute };
  }

  function canonicalPagePath(raw, known) {
    if (!String(raw || '').trim()) return '';
    let { p, wasAbsolute } = parsePathInput(raw);
    p = p.replace(/^\.\//, '').replace(/^\/+/, '');
    if (/^index\.html$/i.test(p)) p = '';
    else p = p.replace(/\/index\.html$/i, '/');
    return matchKnownPath(p, wasAbsolute, known);
  }

  /**
   * JSON 里**全部可导航的 html 目标**：叶子节点的 href + 有索引页的组节点的 indexHref。
   * site_navigate 的白名单用（不再爬 `a[data-path]`）。
   */
  function navTargets(navData) {
    const out = [];
    (function walk(arr) {
      for (const n of arr || []) {
        if (n.children && n.children.length) {
          if (n.indexHref) out.push(n.indexHref); // 组节点：索引页可达
          walk(n.children);
        } else if (n.href) {
          out.push(n.href);
        }
      }
    })(navData.nodes);
    return out;
  }


  /**
   * 给「找不到」找最近候选（2026-10-23，Coze MCP-Builder 的「错误要可落地」口径）：
   * 返回 candidates = 按相似度排序的最近标题，模型下一轮直接拿候选值重试，
   * 不用把全部 30 个标题读完再猜。
   * 相似度 = query 的字在标题里出现的比例（中文按字，拉丁按词），≥0.34 才入选。
   */
  /**
   * 标题匹配：**精确优先，其次才子串**，并返回**全部命中**（不是第一个）。
   *
   * ## 为什么必须精确优先
   *
   * 2026-10-29 实测灾难：作业 3 的小节标题是
   *   「三、习题 2.4(2)：求秩」
   *   「四、习题 2.4(3)：求秩」
   * 旧实现用 `filter(标题含 query)[0]` 取第一个命中，于是查询「2.4(3)」
   * 或「第四题」时永远落到「三、…2.4(2)…」，**第 4 题死命读不出来**。
   * 根因不是候选排序不够好，是「只留一个」这个决策本身错了——
   * 同一页里标题高度相似是常态（习题册、作业页尤其如此）。
   *
   * ## 四档匹配（从强到弱）
   *
   * 1. `exact`  归一化后完全相等（`习题2.4(3)` == `四、习题2.4(3)：求秩` 的尾部？不——那是 suffix）
   * 2. `suffix` 标题归一化后以 query 结尾（「四、习题 2.4(3)：求秩」以「2.4(3)」结尾为真）
   * 3. `substr` 标题含 query
   * 4. 都没命中 ⇒ 返回空，让调用方走 `nearestTitles` 给候选
   *
   * ## 为什么加 `suffix` 这一档
   *
   * 标题普遍带「一、二、三、」这类序号前缀与「：副标题」后缀，
   * 而模型的 query 往往只给核心词（`2.4(3)`、`求秩`）。
   * 只做「含」会让「2.4(2)」与「2.4(3)」同分；加了 suffix 档，
   * 「2.4(3)」对「…2.4(3)：求秩」的匹配强度高于「…2.4(2)：求秩」，排序就分得开。
   * 但仍然返回**全部**同档命中——让调用方（和模型）看得到有几个候选。
   *
   * @returns {{tier: string, hits: Array<{title:string,anchor:string,level:number}>}}
   */
  function matchHeadings(list, needle) {
    const norm = (x) => String(x || '').replace(/[\s\p{P}\p{S}]/gu, '');
    const nn = norm(needle);
    if (!nn) return { tier: 'none', hits: [] };
    const tiers = { exact: [], suffix: [], substr: [] };
    for (const h of list) {
      const ns = norm(h.title);
      if (!ns) continue;
      if (ns === nn) tiers.exact.push(h);
      else if (ns.endsWith(nn)) tiers.suffix.push(h);
      else if (ns.indexOf(nn) >= 0) tiers.substr.push(h);
    }
    const found = ['exact', 'suffix', 'substr'].find((t) => tiers[t].length);
    return found ? { tier: found, hits: tiers[found] } : { tier: 'none', hits: [] };
  }

  function nearestTitles(needle, titles, max) {
    const n = String(needle || '').trim();
    if (!n) return [];
    // 归一化：去空白与标点（中文标题里「习题 2.2」与 query「习题2.2」应算同形）
    const norm = (x) => String(x || '').replace(/[\s\p{P}\p{S}]/gu, '');
    const nn = norm(n);
    const chars = Array.from(new Set(nn));
    const scored = titles.map((t) => {
      const s = String(t || '');
      const ns = norm(s);
      let score = 0;
      if (ns.indexOf(nn) >= 0) score = 1;                 // 子串命中（最强）
      else if (nn.indexOf(ns) >= 0 && ns) score = 0.95;   // query 是标题的超集
      else if (chars.length) {                            // 逐字覆盖
        let hit = 0;
        for (const c of chars) if (ns.indexOf(c) >= 0) hit += 1;
        score = hit / chars.length;
      }
      return { t: s, score };
    }).filter((x) => x.score >= 0.34);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, max || 5).map((x) => x.t);
  }

  /** 搜索面板里的命中列表与总数（读 DOM，不重跑检索）。 */
  function searchResults() {
    const hits = all(S.searchHit).map((a) => ({
      title: textOf(a.querySelector ? a.querySelector(S.searchHitTitle) : null),
      href: a.getAttribute ? a.getAttribute('href') : '',
    }));
    const txt = textOf(byId(S.searchResults));
    const m = txt.match(S.hitCountRe);
    return { total: m ? Number(m[1]) : hits.length, hits: hits.slice(0, 12) };
  }

  /**
   * 宽容类型转换 + 语义严格（2026-10-23，Coze MCP-Builder Phase 2 定案 ③）。
   *
   * 原则：**能无歧义转换的就转，有歧义的直接拒**。
   *   · "6000" → 6000        转（模型明显想要数字，省一轮重试）
   *   · "abc"  → 拒           歧义（不是数字）
   *   · -5     → 拒           语义错误（offset 不能为负）
   *   · 50000  → 拒           超硬上限，hint 写明上限
   * 宽容是安全网，不替代 schema——枚举/范围/必填仍在 schema 里。
   */
  function validateIntRange(n, o) {
    if (o.min !== undefined && n < o.min) {
      return { ok: false, reason: 'out_of_range', hint: o.name + ' 不能小于 ' + o.min + '，收到的是 ' + n };
    }
    if (o.max !== undefined && n > o.max) {
      return { ok: false, reason: 'out_of_range', hint: o.name + ' 上限是 ' + o.max + '，收到的是 ' + n + '（请用 offset 分页读）' };
    }
    return { ok: true, value: n };
  }

  function asInt(raw, opt) {
    const o = opt || {};
    if (raw === undefined || raw === null || raw === '') return { ok: true, value: o.def };
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (!Number.isFinite(n)) return { ok: false, reason: 'bad_type', hint: o.name + ' 必须是数字，收到的是「' + raw + '」' };
    if (!Number.isInteger(n)) return { ok: false, reason: 'bad_type', hint: o.name + ' 必须是整数，收到的是 ' + n };
    return validateIntRange(n, o);
  }

  /**
   * 读正文。
   * @param {object} [o]
   * @param {'page'|'outline'|'section'|'panel'|'symbols'} [o.what='page']
   * @param {string} [o.query]     section/panel 用：标题片段
   * @param {number} [o.maxChars=8000]
   * @param {number} [o.offset=0]  字符偏移（2026-10-23：分页读长页）
   * @param {boolean} [o.includeCollapsed=true]
   */
  function parseReadWindow(opt) {
    const ln = asInt(opt.limit != null ? opt.limit : opt.maxLines, { name: 'limit', def: 30, min: 1, max: 400 });
    if (!ln.ok) return { error: { ok: false, reason: ln.reason, hint: ln.hint, param: 'limit' } };
    const of = asInt(opt.offset, { name: 'offset', def: 0, min: 0 });
    if (!of.ok) return { error: { ok: false, reason: of.reason, hint: of.hint, param: 'offset' } };
    const mc = asInt(opt.maxChars, { name: 'maxChars', def: 12000, min: 1, max: 20000 });
    if (!mc.ok) return { error: { ok: false, reason: mc.reason, hint: mc.hint, param: 'maxChars' } };
    return { limitLines: ln.value, offset: of.value, maxChars: mc.value };
  }

  function pickWindowLines(lines, fromLine, limitLines, maxChars) {
    const picked = [];
    let used = 0;
    for (let i = fromLine; i < lines.length && picked.length < limitLines; i++) {
      const one = lines[i];
      if (used + one.length + 1 > maxChars && picked.length > 0) break;
      picked.push(one);
      used += one.length + 1;
    }
    return picked;
  }

  function makeClipper(what, { limitLines, offset, maxChars }) {
    return (s) => {
      const t = String(s || '');
      const lines = t.split('\n');
      const totalLines = lines.length;
      const fromLine = Math.min(offset, totalLines);
      const picked = pickWindowLines(lines, fromLine, limitLines, maxChars);
      const text = picked.join('\n');
      const nextOffset = fromLine + picked.length;
      const hasMore = nextOffset < totalLines;
      return {
        text,
        total_chars: t.length, totalChars: t.length,
        total_lines: totalLines, totalLines,
        offset: fromLine, limit: limitLines,
        returned_lines: picked.length, returnedLines: picked.length,
        chars: text.length,
        next_offset: hasMore ? nextOffset : null,
        nextOffset: hasMore ? nextOffset : null,
        has_more: hasMore, truncated: hasMore,
        hint: hasMore
          ? `默认只给 ${limitLines} 行（本段 ${picked.length}/${totalLines} 行）。要接着读后半段：site_read，what=${what}，offset=${nextOffset}，limit=${limitLines}（或一次多要点：limit=100；行数硬上限 400）`
          : undefined,
      };
    };
  }

  function resolveSectionHit(hs, needle) {
    if (needle && byId(needle)) {
      const byAnchor = hs.find((h) => h.anchor === needle);
      if (byAnchor) return { hit: byAnchor };
    }
    const matched = matchHeadings(hs, needle);
    if (matched.hits.length > 1) {
      return {
        error: {
          ok: false, reason: 'ambiguous', query: needle, tier: matched.tier,
          candidates: matched.hits.slice(0, 10).map((h) => ({ title: h.title, anchor: h.anchor })),
          hint: '这个 query 同时命中多个小节。从 candidates 里挑一个，用**它的 anchor**重发（query 填 anchor 值可精确命中，不会再歧义）。',
        },
      };
    }
    return { hit: matched.hits[0] || null };
  }

  function readSectionContent(needle, opt, clip) {
    const hs = headings();
    const { hit, error } = resolveSectionHit(hs, needle);
    if (error) return error;
    if (!hit) {
      const cand = nearestTitles(needle, hs.map((h) => h.title));
      return {
        ok: false, reason: 'not_found', query: needle, candidates: cand,
        hint: cand.length
          ? '小节标题里没有匹配。从 candidates 里挑最近的一个重试。'
          : '这一页没有相关小节（候选为空）。别在本页重试——换一页：先用 site_search 搜全站，或 site_index 看站点地图。',
        available: hs.map((h) => h.title).slice(0, 30),
      };
    }
    const target = byId(hit.anchor);
    if (!target) return { ok: false, reason: 'anchor_missing', anchor: hit.anchor };
    const top = collectSectionTopNodes(target, hit.level);
    const md = renderMarkdown({ children: top, tagName: 'DIV' }, { includeCollapsed: opt.includeCollapsed, links: opt.links });
    return { ok: true, what: 'section', title: hit.title, anchor: hit.anchor, level: hit.level, ...clip(md) };
  }

  function readTargetedContent(what, opt, clip) {
    const needle = String(opt.query || '').trim();
    if (!needle) return { ok: false, reason: 'empty_query', hint: '给 query（标题片段）' };
    return what === 'section' ? readSectionContent(needle, opt, clip) : readPanelContent(needle, opt, clip);
  }

  function readOutline() {
    const hs = headings();
    return { ok: true, what: 'outline', outline: hs, count: hs.length, text: hs.map((h) => '  '.repeat(Math.max(0, h.level - 2)) + '- ' + h.title).join('\n') };
  }

  function readSymbolsList() {
    const list = listSymbols(80);
    return { ok: true, what: 'symbols', symbols: list, count: list.length };
  }

  function readPageMarkdown(article, opt, clip) {
    const md = renderMarkdown(article, { includeCollapsed: opt.includeCollapsed, links: opt.links });
    return { ok: true, what: 'page', title: pageInfo().title, sections: headings().length, ...clip(md) };
  }

  function readContent(o) {
    const opt = o || {};
    const what = opt.what || 'page';
    const winCfg = parseReadWindow(opt);
    if (winCfg.error) return winCfg.error;
    const article = first(S.article);
    if (!article) {
      return {
        ok: false, reason: 'article_not_found',
        hint: `当前页没有 ${S.article} 容器（不是站点标准页），读不到正文。可用 site_get_page_info 看这是什么页。`,
      };
    }
    const simple = { outline: readOutline, symbols: readSymbolsList }[what];
    if (simple) return simple();
    const clip = makeClipper(what, winCfg);
    return (what === 'section' || what === 'panel')
      ? readTargetedContent(what, opt, clip)
      : readPageMarkdown(article, opt, clip);
  }

  function isHeadingStop(node, target, level) {
    if (node === target) return false;
    const tag = String(node.tagName || '').toUpperCase();
    return /^H[1-4]$/.test(tag) && Number(tag.slice(1)) <= level;
  }

  function collectSectionTopNodes(target, level) {
    const body = [];
    for (let node = target; node && !isHeadingStop(node, target, level); node = nextInDoc(node, target)) {
      body.push(node);
    }
    const top = [];
    for (const el of body) {
      if (el === target || (!isAncestor(target, el) && !top.some((t) => isAncestor(t, el)))) top.push(el);
    }
    return top;
  }

  function readPanelContent(needle, opt, clip) {
    const ds = all(S.details).filter((d) => {
      const sum = d.querySelector ? d.querySelector('summary') : null;
      return (textOf(sum) + ' ' + textOf(d)).indexOf(needle) >= 0;
    });
    if (!ds.length) {
      return {
        ok: false, reason: 'not_found',
        available: all(S.details).map((d) => textOf(d.querySelector?.('summary')).slice(0, 60)).slice(0, 30),
      };
    }
    const md = ds.map((d) => renderMarkdown(d, { includeCollapsed: true, links: opt.links })).join('\n\n');
    return { ok: true, what: 'panel', count: ds.length, ...clip(md) };
  }

  /**
   * DOM 顺序的下一个节点（先子后兄弟后上溯），但不进入 `stopAt` 之前已收元素的内部。
   * 用于「从某标题开始读到下一个同级标题」——线性、不摊平整棵树。
   */
  function nextSiblingOf(cur) {
    if (cur.nextElementSibling) return cur.nextElementSibling;
    const par = cur.parentElement;
    if (!par) return null;
    const sibs = Array.prototype.slice.call(par.children || []);
    const at = sibs.indexOf(cur);
    return at >= 0 && at + 1 < sibs.length ? sibs[at + 1] : null;
  }

  function nextInDoc(node, _stopAt) {
    if (node.children?.length) return node.children[0];
    for (let cur = node; cur; cur = cur.parentElement) {
      const sib = nextSiblingOf(cur);
      if (sib) return sib;
    }
    return null;
  }

  function isAncestor(a, b) {
    for (let p = b?.parentElement; p; p = p.parentElement) if (p === a) return true;
    return false;
  }

  function collectSectionBuckets(article, hs) {
    const buckets = hs.map((h) => ({ h, text: '' }));
    const flat = [];
    (function collect(n) {
      for (const c of childrenOf(n)) {
        if (!isTextNode(c)) { flat.push(c); collect(c); }
      }
    })(article);
    let cur = -1;
    for (const el of flat) {
      const t = String(el.tagName || '').toUpperCase();
      if (/^H[2-4]$/.test(t)) {
        const hit = hs.findIndex((h) => h.anchor && h.anchor === el.id);
        if (hit >= 0) cur = hit;
        continue;
      }
      if (cur >= 0 && /^(P|LI|TD|TH|BLOCKQUOTE|PRE|DD|DT)$/.test(t)) {
        const md = renderMarkdown(el);
        if (md) buckets[cur].text += ' ' + md;
      }
    }
    return buckets;
  }

  function collectBucketHits(b, q, lowerQ, hits, cap) {
    const hay = b.text.toLowerCase();
    for (let from = 0; hits.length < cap;) {
      const at = hay.indexOf(lowerQ, from);
      if (at < 0) break;
      hits.push({
        section: b.h.title,
        anchor: b.h.anchor,
        snippet: b.text.slice(Math.max(0, at - 40), at + q.length + 40).replace(/\s+/g, ' ').trim(),
      });
      from = at + lowerQ.length;
    }
  }

  /** 页内查找（Ctrl+F 的语义）：返回命中片段与所在小节。 */
  function findInPage(query, limit) {
    const q = String(query || '').trim();
    if (!q) return { ok: false, reason: 'empty_query' };
    const article = first(S.article);
    if (!article) {
      return { ok: false, reason: 'article_not_found', hint: '当前页没有正文容器（不是站点标准页），读不到小节。' };
    }
    const buckets = collectSectionBuckets(article, headings());
    const hits = [];
    const cap = limit || 10;
    const lowerQ = q.toLowerCase();
    for (const b of buckets) {
      if (hits.length >= cap) break;
      collectBucketHits(b, q, lowerQ, hits, cap);
    }
    return { ok: true, query: q, total: hits.length, hits, truncated: hits.length >= cap };
  }

  function currentCourseName() {
    const segs = (doc?.body?.getAttribute?.('data-site-path') || '').split('/');
    return segs.length > 2 && segs[0] === '课程总览' ? segs[1] : '';
  }

  function matchLinkPools(pools, labels, needle, bare) {
    const matchers = [
      (pool) => pool.filter((x) => labels[x.i]?.includes(needle)),
      (pool) => (bare && bare !== needle ? pool.filter((x) => labels[x.i]?.includes(bare)) : []),
      (pool) => pool.filter((x) => labels[x.i] && needle.includes(labels[x.i])),
    ];
    for (const pool of pools) {
      for (const fn of matchers) {
        const hits = fn(pool);
        if (hits.length) return hits;
      }
    }
    return [];
  }

  function dedupeLinkHits(hits, labels) {
    const uniq = [];
    const seen = {};
    for (const x of hits) {
      const key = x.a.getAttribute?.('data-path') || labels[x.i];
      if (!seen[key]) { seen[key] = 1; uniq.push(x); }
    }
    return uniq;
  }

  function buildLinkPools(links, scopeCourse) {
    const allItems = links.map((a, i) => ({ a, i }));
    if (!scopeCourse) return [allItems];
    const prefix = '课程总览/' + scopeCourse + '/';
    const scopedPool = allItems.filter((x) => (x.a.getAttribute?.('data-path') || '').startsWith(prefix));
    return scopedPool.length ? [scopedPool, allItems] : [allItems];
  }

  function clickNavLink(el, click) {
    return click(el)
      ? { ok: true, to: 'link', title: textOf(el), path: el.getAttribute?.('data-path') || '' }
      : { ok: false, reason: 'click_failed' };
  }

  function findCourseInQuery(needle) {
    return ['工程数学', '电力大数据与人工智能', '形势与政策', '电路原理', '电子技术', '电机学']
      .find((c) => needle.includes(c)) || '';
  }

  function linkMatchError(uniq, needle, scopeCourse, labels) {
    if (!uniq.length) {
      return { ok: false, reason: 'not_found', query: needle, course: scopeCourse || undefined, available: labels.filter(Boolean).slice(0, 40) };
    }
    return {
      ok: false, reason: 'ambiguous', query: needle, course: scopeCourse || undefined,
      candidates: uniq.map((x) => labels[x.i]).slice(0, 20),
      hint: '侧栏里有多个匹配项，把 query 写得更具体（或改用 to=page 直接给路径）。',
    };
  }

  function navigateLink(opt, click) {
    const needle = String(opt.query || '').trim();
    if (!needle) return { ok: false, reason: 'empty_query' };
    const links = all(S.navLink);
    const labels = links.map((a) => textOf(a));
    const courseFromQuery = findCourseInQuery(needle);
    const scopeCourse = currentCourseName() || courseFromQuery;
    const bare = courseFromQuery ? needle.replace(courseFromQuery, '').trim() : needle;
    const uniq = dedupeLinkHits(matchLinkPools(buildLinkPools(links, scopeCourse), labels, needle, bare), labels);
    return uniq.length === 1 ? clickNavLink(uniq[0].a, click) : linkMatchError(uniq, needle, scopeCourse, labels);
  }

  function pageNotFoundPayload(normalized, pool) {
    const curCourse = currentCourseName();
    const sameCourse = curCourse ? pool.filter((x) => x.startsWith('课程总览/' + curCourse + '/')) : [];
    const tail = normalized.split('/').pop() || '';
    const basePool = sameCourse.length ? sameCourse : pool;
    const sameName = basePool.filter((x) => x.split('/').pop() === tail);
    const candidates = (sameName.length ? sameName : basePool).slice(0, 20);
    return {
      ok: false, reason: 'no_such_page', path: normalized,
      hint: '站点里没有这一页，跳不过去。下面是真实存在的路径，从里面挑一个；不确定整站结构就先用 site_index 看地图。',
      candidates,
    };
  }

  function runSpaNavigate(w, normalized, hash, verified) {
    const rootAttr = doc.documentElement?.getAttribute('data-root') || './';
    const url = new URL(rootAttr + normalized, location.href).pathname;
    return Promise.resolve(w.__spaRouter.navigate(url, hash, true, { soft: true }))
      .then(() => ({ ok: true, to: 'page', path: normalized, hash, via: 'spa', verified }),
            (err) => ({ ok: false, reason: 'navigate_failed', path: normalized,
                        hint: '路由换页失败（页面可能已失效）。别重试同一路径，换个候选。',
                        error: String(err?.message || err) }));
  }

  function finishPageNav(navData, pages, path, hash) {
    const w = win || {};
    const navPaths = navData ? navTargets(navData) : [];
    const pool = pages || navPaths;
    const normalized = canonicalPagePath(path, pool);
    if (pool.indexOf(normalized) < 0) return pageNotFoundPayload(normalized, pool);
    if (typeof w.__spaRouter?.navigate !== 'function') {
      return { ok: false, reason: 'no_spa_router', path: normalized,
               hint: '当前页面没有站内路由，跳转会整页重载并中断助手会话，已放弃跳转。' };
    }
    return runSpaNavigate(w, normalized, hash, navPaths.indexOf(normalized) >= 0);
  }

  function resolveJsonStore(syncVal, loader) {
    if (syncVal) return Promise.resolve(syncVal);
    return loader ? loader().catch(() => null) : Promise.resolve(null);
  }

  function canFinishPageSync(syncNav, syncPages, loadNavJson, loadPagesJson) {
    return (syncNav || !loadNavJson) && (syncPages || !loadPagesJson);
  }

  function navigatePage(opt) {
    const { loadNavJson, loadPagesJson } = win?.__navStructure || {};
    const path = String(opt.path || '').trim();
    if (!path) return { ok: false, reason: 'empty_path' };
    const hash = String(opt.hash || '').trim();
    const syncNav = navStructure();
    const syncPages = sitePages();
    if (canFinishPageSync(syncNav, syncPages, loadNavJson, loadPagesJson)) {
      return finishPageNav(syncNav, syncPages, path, hash);
    }
    return Promise.all([resolveJsonStore(syncNav, loadNavJson), resolveJsonStore(syncPages, loadPagesJson)])
      .then(([navData, pages]) => finishPageNav(navData, pages, path, hash));
  }

  function clickElement(el, w) {
    if (!el) return false;
    try {
      if (typeof el.click === 'function') { el.click(); return true; }
      const Ev = w.MouseEvent || (typeof MouseEvent !== 'undefined' ? MouseEvent : null);
      if (Ev && el.dispatchEvent) {
        el.dispatchEvent(new Ev('click', { bubbles: true, cancelable: true, view: w }));
        return true;
      }
    } catch (_e) { /* 无事件能力 */ }
    return false;
  }

  function navigateScroll(to, w) {
    try {
      const y = to === 'top' ? 0 : (doc.documentElement?.scrollHeight || 0);
      if (!w.scrollTo) return { ok: false, reason: 'scroll_unavailable' };
      w.scrollTo({ top: y, behavior: 'smooth' });
      return { ok: true, to, y };
    } catch { return { ok: false, reason: 'scroll_unavailable' }; }
  }

  function navigateBack(w) {
    try {
      if (w.history?.back) { w.history.back(); return { ok: true, to: 'back' }; }
    } catch (_e) { /* 无 history */ }
    return { ok: false, reason: 'history_unavailable' };
  }

  function navigatePaging(to, click) {
    const el = first(to === 'prev' ? S.pagingPrev : S.pagingNext);
    if (!el) return { ok: false, reason: 'no_paging', hint: to === 'prev' ? '本页没有上一节' : '本页没有下一节' };
    const href = el.getAttribute ? el.getAttribute('href') : '';
    const title = textOf(el.querySelector ? el.querySelector('.paging-title') : null);
    return click(el) ? { ok: true, to, href, title } : { ok: false, reason: 'click_failed' };
  }

  /** 跳转（页面级）。 */
  function navigate(o) {
    const opt = o || {};
    const to = opt.to || 'section';
    const w = win || {};
    const click = (el) => clickElement(el, w);
    const routes = {
      section: () => openSection(opt.query || opt.title, opt.anchor, w),
      top: () => navigateScroll('top', w),
      bottom: () => navigateScroll('bottom', w),
      back: () => navigateBack(w),
      prev: () => navigatePaging('prev', click),
      next: () => navigatePaging('next', click),
      home: () => {
        const el = first(S.brand);
        return !el ? { ok: false, reason: 'no_brand' } : (click(el) ? { ok: true, to } : { ok: false, reason: 'click_failed' });
      },
      link: () => navigateLink(opt, click),
      page: () => navigatePage(opt),
    };
    return routes[to] ? routes[to]() : { ok: false, reason: 'unknown_target', to };
  }

  function setHueDom(hue, rootEl) {
    if (rootEl?.style?.setProperty) {
      rootEl.style.setProperty('--hue', String(hue));
      rootEl.style.setProperty('--primary-h', String(hue));
    }
    const slider = byId('hue-slider');
    if (slider) slider.value = String(hue);
    const badge = byId('palette-hue-badge');
    if (badge) badge.textContent = 'Hue ' + hue + '°';
  }

  function applyHueView(hueRaw, rootEl, w) {
    const hue = Math.max(0, Math.min(360, parseInt(hueRaw, 10) || 0));
    setHueDom(hue, rootEl);
    try { w.localStorage?.setItem('theme-hue', String(hue)); } catch (_e) { /* 无存储 */ }
    return hue;
  }

  function toggleSidebarDom(drawer, want) {
    drawer.classList.toggle('open', want);
    byId('drawer-backdrop')?.classList?.toggle('open', want);
    return want ? 'open' : 'closed';
  }

  function applySidebarView(sidebarOpt, body) {
    const drawer = byId('m3-drawer');
    const isOpen = Boolean(drawer && hasClass(drawer, 'open'));
    const want = sidebarOpt === 'toggle' ? !isOpen : sidebarOpt === 'open';
    if (drawer?.classList) return toggleSidebarDom(drawer, want);
    if (body?.classList) {
      body.classList.toggle('sidebar-collapsed', !want);
      return want ? 'open' : 'collapsed';
    }
    return undefined;
  }

  function applyThemeView(theme, rootEl, w) {
    if (theme !== 'light' && theme !== 'dark') return undefined;
    rootEl?.setAttribute?.('data-theme', theme);
    try { w.localStorage?.setItem('theme', theme); } catch (_e) { /* 无存储 */ }
    return theme;
  }

  function applySidebarIfRequested(sidebar, done) {
    if (!['open', 'closed', 'toggle'].includes(sidebar)) return;
    const s = applySidebarView(sidebar, doc?.body || null);
    if (s !== undefined) done.sidebar = s;
  }

  /** 显示设置（明暗 / 色相 / 侧栏）。 */
  function setView(o) {
    const opt = o || {};
    const w = win || {};
    const rootEl = doc?.documentElement || null;
    const done = {};
    const theme = applyThemeView(opt.theme, rootEl, w);
    if (theme) done.theme = theme;
    if (opt.hue != null) done.hue = applyHueView(opt.hue, rootEl, w);
    applySidebarIfRequested(opt.sidebar, done);
    if (!Object.keys(done).length) {
      return { ok: false, reason: 'nothing_to_do', hint: '给 theme / hue / sidebar 之一', state: viewState() };
    }
    return { ok: true, ...done, state: viewState() };
  }

  /**
   * 把当前视口截成 JPEG（**能力由宿主注入**，页面自身无权截图）。
   *
   * 页面只能提供「截什么」的元信息（标题、URL、视口尺寸、滚动位置），真正的像素
   * 由宿主拿——扩展用 `chrome.tabs.captureVisibleTab`，无头环境用 CDP
   * `Page.captureScreenshot`。两条路都返回同一形状，产品侧不必分叉。
   */
  function pickDim(a, b) { return a || b || 0; }

  function viewportSize(w, el) {
    return { w: pickDim(w?.innerWidth, el?.clientWidth), h: pickDim(w?.innerHeight, el?.clientHeight) };
  }

  function docTitleAndUrl() {
    return { title: doc?.title || '', url: location?.href || '' };
  }

  function buildCaptureMeta(o, w) {
    const el = doc?.documentElement || null;
    return {
      ...docTitleAndUrl(),
      scrollY: Math.round(w?.scrollY || 0),
      docHeight: el ? el.scrollHeight : 0,
      viewport: viewportSize(w, el),
      reason: String(o.reason || ''),
    };
  }

  function dataUrlBytes(dataUrl) {
    const b64 = String(dataUrl).split(',')[1] || '';
    return Math.round(b64.length * 3 / 4);
  }

  function formatCaptureResult(res, meta, format) {
    if (!res?.dataUrl) {
      return { ...meta, ok: false, reason: 'capture_failed', detail: String(res?.error || '') };
    }
    return {
      ...meta,
      ok: true, mimeType: res.mimeType || `image/${format}`, dataUrl: res.dataUrl,
      width: res.width || meta.viewport.w, height: res.height || meta.viewport.h,
      bytes: dataUrlBytes(res.dataUrl),
    };
  }

  function captureUnavailablePayload(meta) {
    return {
      ...meta, ok: false, reason: 'capture_unavailable',
      hint: '宿主未注入整屏截图能力。替代：给 selector（如 "article"）或 rect 用页面内 canvas 截指定区域，'
        + '或先调 site_list_images + site_image 取具体图片。',
      alternatives: { selector: '.article-content', rect: { x: 0, y: 0, w: meta.viewport.w, h: meta.viewport.h } },
    };
  }

  function runCaptureProvider(provider, o, format, quality, meta) {
    return Promise.resolve()
      .then(() => provider({ format, quality, fullPage: !!o.fullPage, meta }))
      .then((res) => formatCaptureResult(res, meta, format))
      .catch((e) => ({ ...meta, ok: false, reason: 'capture_error', detail: String(e?.message || e) }));
  }

  function parseCaptureOpts(o, meta) {
    return {
      format: o.format === 'png' ? 'png' : 'jpeg',
      quality: Math.max(1, Math.min(100, Number(o.quality) || 80)),
      meta,
    };
  }

  function captureView(opts, win2) {
    const o = opts || {};
    const w = win2 || win || null;
    const meta = buildCaptureMeta(o, w);
    const cfg = parseCaptureOpts(o, meta);
    if (o.selector || o.rect) return captureRegion(o, cfg);
    const provider = w?.__siteCapture;
    return typeof provider === 'function'
      ? runCaptureProvider(provider, o, cfg.format, cfg.quality, meta)
      : Promise.resolve(captureUnavailablePayload(meta));
  }

  /**
   * 区域截图：把 selector 元素或 rect 区域画到 canvas 上出 JPEG。
   *
   * 限制（必须如实说，别假装能截一切）：canvas 只能画**已经渲染且同源**的内容。
   * 跨域图片会污染画布导致 toDataURL 抛错——本站全同源，所以可用；
   * 若将来有外链图，会返回 capture_tainted 而不是半白图。
   */
  function resolveSelectorRect(selector) {
    let target;
    try { target = doc.querySelector(String(selector)); } catch { target = null; }
    if (!target) return { error: { ok: false, reason: 'selector_not_found', selector } };
    try {
      const r = target.getBoundingClientRect();
      return { target, rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
    } catch { return { error: { ok: false, reason: 'no_layout' } }; }
  }

  function resolveRegionRect(o) {
    if (o.selector) return resolveSelectorRect(o.selector);
    const r = o.rect || {};
    return { target: null, rect: { x: Number(r.x) || 0, y: Number(r.y) || 0, w: Number(r.w) || 0, h: Number(r.h) || 0 } };
  }

  function createRegionCanvas(w, cw, ch) {
    const canvas = w.document?.createElement ? w.document.createElement('canvas') : doc.createElement?.('canvas');
    if (!canvas?.getContext) return null;
    canvas.width = cw;
    canvas.height = ch;
    return canvas;
  }

  function drawRegionToDataUrl(canvas, img, ctx) {
    const { cw, ch, format, quality, meta, selector, rect, scale } = ctx;
    const g = canvas.getContext('2d');
    if (format === 'jpeg') { g.fillStyle = '#ffffff'; g.fillRect(0, 0, cw, ch); }
    g.drawImage(img, 0, 0, cw, ch);
    const mime = format === 'png' ? 'image/png' : 'image/jpeg';
    const dataUrl = canvas.toDataURL(mime, quality / 100);
    const b64 = dataUrl.split(',')[1] || '';
    return {
      ...meta, ok: true, mode: 'region', selector: selector || null, rect,
      mimeType: mime, dataUrl, width: cw, height: ch, resized: scale < 1,
      bytes: Math.round(b64.length * 3 / 4),
    };
  }

  function prepareRegionCtx(o, meta) {
    const resolved = resolveRegionRect(o);
    if (resolved.error) return { error: { ...meta, ...resolved.error } };
    const { target, rect } = resolved;
    if (!rect.w || !rect.h) return { error: { ...meta, ok: false, reason: 'empty_rect', rect } };
    const maxWidth = Math.max(64, Number(o.maxWidth) || 1400);
    const scale = rect.w > maxWidth ? maxWidth / rect.w : 1;
    return { target, rect, scale, cw: Math.max(1, Math.round(rect.w * scale)), ch: Math.max(1, Math.round(rect.h * scale)) };
  }

  function captureRegion(o, ctx0) {
    const w = win || {};
    const { format, quality, meta } = ctx0;
    const prep = prepareRegionCtx(o, meta);
    if (prep.error) return Promise.resolve(prep.error);
    const { target, rect, scale, cw, ch } = prep;
    const canvas = createRegionCanvas(w, cw, ch);
    const xml = canvas ? serializeTarget(target, rect, cw, ch, scale) : null;
    const SvgImage = w.Image || globalThis.Image;
    if (!canvas || !SvgImage) return Promise.resolve({ ...meta, ok: false, reason: 'canvas_unavailable' });
    if (!xml) return Promise.resolve({ ...meta, ok: false, reason: 'serialize_failed' });

    return new Promise((resolve) => {
      const img = new SvgImage();
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const timer = (w.setTimeout ?? setTimeout)(() => done({ ...meta, ok: false, reason: 'region_timeout' }), 15000);
      const clrT = w.clearTimeout || clearTimeout;
      img.onerror = () => { clrT(timer); done({ ...meta, ok: false, reason: 'region_render_failed', hint: 'SVG 渲染失败（可能是跨域字体/图片）' }); };
      img.onload = () => {
        clrT(timer);
        try { done(drawRegionToDataUrl(canvas, img, { cw, ch, format, quality, meta, selector: o.selector, rect, scale })); }
        catch (e) { done({ ...meta, ok: false, reason: 'capture_tainted', detail: String(e?.message || e) }); }
      };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
    });
  }

  /** 把目标元素序列化成 foreignObject SVG（同源静态页可用）。 */
  function serializeTarget(target, rect, cw, ch, scale) {
    try {
      const clone = target.cloneNode ? target.cloneNode(true) : null;
      if (!clone) return null;
      const html = clone.outerHTML || '';
      if (!html) return null;
      // 内联一份最小样式，保证离线渲染时版面不至于全塌
      const css = 'body{margin:0;font-family:system-ui,sans-serif}'
        + 'img{max-width:100%}'
        + '.katex{font-size:1em}'
        + '.article-content{color:#111;background:#fff;padding:8px}';
      return '<svg xmlns="http://www.w3.org/2000/svg" width="' + cw + '" height="' + ch + '">'
        + '<foreignObject x="0" y="0" width="' + cw + '" height="' + ch + '">'
        + '<div xmlns="http://www.w3.org/1999/xhtml" style="width:' + Math.round(rect.w) + 'px;'
        + 'transform:scale(' + scale + ');transform-origin:0 0;background:#fff">'
        + '<style>' + css + '</style>' + html + '</div>'
        + '</foreignObject></svg>';
    } catch { return null; }   // SVG 序列化失败 ⇒ 截图降级路径接管
  }

  /**
   * 直读搜索索引（2026-10-19 用户定案）：**搜索框是给人用的，模型要的是结果**。
   *
   * 旧实现走 UI：开面板 → 填输入框 → 派发 input → 等 1200ms → 读 DOM，
   * 拿到的永远是被 UI 截断的 12 条，且没有锚点。
   * 而 `search/index.json` 里有 114 页 × 1286 个标题（标题 + 锚点 + 层级），
   * 同步、无上限、可精确到节。
   *
   * @param {string} q 查询词
   * @param {object} [o]
   * @param {number} [o.limit=20] 命中上限
   * @param {boolean} [o.includeHeadings=true] 是否返回页内小节命中
   */
  function matchDocSections(headingsList, needle) {
    return (headingsList || [])
      .filter((h) => String(h.t || h.d || '').toLowerCase().includes(needle))
      .slice(0, 8)
      .map((h) => ({ title: h.d || h.t, anchor: h.a, level: h.l }));
  }

  function matchIndexDoc(d, needle, withHeadings) {
    const titleHit = String(d.title || '').toLowerCase().includes(needle);
    const sections = withHeadings ? matchDocSections(d.headings, needle) : [];
    if (!titleHit && !sections.length) return null;
    let path = String(d.url || '').replace(/^\//, '');
    try { path = decodeURI(path); } catch (_e) { /* 原样 */ }
    const hit = { title: d.title, path, chars: d.chars };
    if (sections.length) hit.sections = sections;
    return hit;
  }

  function searchIndex(q, o) {
    const opt = o || {};
    const query = String(q || '').trim();
    if (!query) return Promise.resolve({ ok: false, reason: 'empty_query' });
    const limit = Math.max(1, Math.min(100, Number(opt.limit) || 20));
    const withHeadings = opt.includeHeadings !== false;
    const rootAttr = (doc.documentElement && doc.documentElement.getAttribute('data-root')) || './';
    const url = rootAttr + 'search/index.json';

    return fetch(url).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then((idx) => {
      const docs = idx?.docs || [];
      const needle = query.toLowerCase();
      const hits = [];
      for (const d of docs) {
        const hit = matchIndexDoc(d, needle, withHeadings);
        if (hit) hits.push(hit);
        if (hits.length >= limit) break;
      }
      return {
        ok: true, query, scope: 'index',
        total: hits.length, totalPages: docs.length, truncated: hits.length >= limit, hits,
        hint: hits.length
          ? '跳页用 site_navigate(to="page", path=…)，需要节内定位再加 hash'
          : '索引里没有匹配的标题/小节；试试换个词，或用 site_index 看全站结构',
      };
    }).catch((e) => ({
      ok: false, reason: 'index_unavailable',
      detail: String((e?.message) || e),
      hint: 'search/index.json 取不到（可能未构建或跨域）。退路：site_index 看结构，或 site_read 读本页',
    }));
  }

  /**
   * 站点索引：读页内烘焙的**侧栏形状 JSON**（`#nav-structure-json`，阶段一，2026-10-21）。
   *
   * 为什么不爬侧栏 DOM：形状的唯一真相源现在是 nav-structure.mjs（构建期产出 JSON），
   * DOM 只是它的渲染产物。读 JSON ⇒ 工具与渲染解耦（DOM class 改名不再波及工具），
   * 且组节点能带出**索引页 path**（DOM 里组节点是纯标题，爬不到）。
   *
   * 默认只给**当前课程**（按 body[data-site-path] 判），`scope='all'` 才给全站。
   * 全站节点数不写死——按实际 JSON 计。
   *
   * @param {object} [o]
   * @param {'course'|'all'} [o.scope='course']
   * @param {number} [o.max] 节点上限（默认 course=60 / all=140）
   */
  function withNavData(fn) {
    const syncNav = navStructure();
    const loadNav = win?.__navStructure?.loadNavJson;
    if (syncNav || !loadNav) return fn(syncNav);
    return loadNav().catch(() => null).then(fn);
  }

  function siteIndex(o) {
    const opt = o || {};
    const scope = opt.scope === 'all' ? 'all' : 'course';
    const max = Math.max(1, Number(opt.max) || (scope === 'all' ? 140 : 60));
    return withNavData((navData) => (navData
      ? finishSiteIndex(navData, opt, scope, max)
      : { ok: false, reason: 'no_sidebar', hint: '本页没有侧栏导航数据（nav-structure 数据缺失或损坏）' }));
  }

  function siteIndexHint(needle, scope) {
    if (needle) return '已按 match 过滤（含该词的子树，保留祖先以看清层级）。要看全量就去掉 match。';
    return scope === 'course'
      ? '这是当前课程的全部页面，层级与侧边栏一致。只想找某类内容就用 match（例如 match="作业"）；要精确路径用 paths:true。'
      : '全站导航树。跳页用 site_navigate(to="page", path=…)，path 可从 paths:true 拿到。';
  }

  function toSiteIndexNode(n) {
    const isGroup = !!n.children?.length;
    const node = { name: n.label, depth: n.depth };
    if (isGroup) {
      if (n.indexHref) node.path = n.indexHref;
      node.children = n.children.map(toSiteIndexNode);
    } else if (n.href) {
      node.path = n.href;
    }
    return node;
  }

  function pickSiteIndexScope(nodes, scope) {
    const curPath = doc?.body?.getAttribute('data-site-path') || '';
    const curCourse = currentCourseName();
    const coursesNode = nodes.find((n) => n.name === '课程总览');
    const courseChildren = coursesNode?.children || [];
    const only = scope === 'course' ? courseChildren.find((n) => n.name === curCourse) : null;
    return {
      curPath, curCourse,
      picked: only ? [only] : nodes,
      allCourses: courseChildren.map((n) => n.name),
    };
  }

  function finishSiteIndex(navData, opt, scope, max) {
    const nodes = navData.nodes.map(toSiteIndexNode);
    const { curPath, curCourse, picked, allCourses } = pickSiteIndexScope(nodes, scope);

    // 渲染：**照侧边栏的样子**（层级 + 标签），而不是把完整仓库路径铺在每行。
    //
    // 2026-10-29 站长反馈：「他去看给人看的 index 页太痛苦了」「index 改成严格匹配侧边栏」。
    // 旧输出每行都缀一个 `课程/工程数学/作业/2026-10-16-作业3.html` 这种长路径，
    // 38 行里光是重复前缀就占掉大半——模型扫起来抓不到重点。
    // 现在：
    //   · 文本形态就是侧边栏的层级（缩进 + 标签），**路径不另起一列**；
    //   · 页面级条目在末尾用 `→ 文件名` 给一个短线索（不是完整路径）；
    //   · 需要精确路径时用 `paths: true` 展开，或直接 `site_navigate`。
    //
    // 过滤（`match`）也是为「费劲」这一条加的：只给含该词的子树，
    // 免得模型为了找「作业3」把整门课的树读一遍。
    const wantPaths = !!opt.paths;
    const needle = String(opt.match || '').trim().toLowerCase();
    const shortOf = (p) => String(p || '').split('/').pop().replace(/\.html$/, '');

    // 过滤：保留命中节点及其祖先链（祖先保留是为了保住层级含义）
    const filterTree = (arr) => {
      if (!needle) return arr;
      const walk2 = (n) => {
        const kids = (n.children || []).map(walk2).filter(Boolean);
        const selfHit = String(n.name || '').toLowerCase().indexOf(needle) >= 0
          || String(n.path || '').toLowerCase().indexOf(needle) >= 0;
        if (selfHit || kids.length) return { ...n, children: kids };
        return null;
      };
      return arr.map(walk2).filter(Boolean);
    };
    const shownTree = filterTree(picked);

    const formatLeaf = (n, indent) => {
      const tail = wantPaths
        ? (n.path ? '  `' + n.path + '`' : '')
        : (n.path ? '  → ' + shortOf(n.path) : '');
      return indent + '- ' + n.name + tail;
    };

    const lines = [];
    const flatten = (arr, indent) => {
      for (const n of arr) {
        if (lines.length >= max) { lines.push(indent + '…（已达上限，可用 match 缩小范围）'); return; }
        if (n.children?.length) {
          lines.push(indent + n.name + (wantPaths && n.path ? '  `' + n.path + '`' : ''));
          flatten(n.children, indent + '  ');
        } else {
          lines.push(formatLeaf(n, indent));
        }
      }
    };
    flatten(shownTree, '');

    return {
      ok: true,
      scope,
      current: { path: curPath, course: curCourse },
      courses: allCourses,
      totalNodes: countNodes(nodes),
      shown: lines.length,
      filtered: needle ? countNodes(shownTree) : undefined,
      text: lines.join('\n'),
      hint: siteIndexHint(needle, scope),
    };
  }

  function countNodes(arr) {
    let n = 0;
    for (const x of arr) { n += 1; if (x.children) n += countNodes(x.children); }
    return n;
  }

  /**
   * 列出本页图片（正文内的，不含站点头像）。
   * 常见外部客户端通常只接收 jpg/png，而本站配图主要是 webp——模型需要知道格式并在必要时转码。
   */
  function imageBox(el) {
    try {
      const r = el.getBoundingClientRect?.();
      return r ? { top: Math.round(r.top + (win?.scrollY || 0)), w: Math.round(r.width), h: Math.round(r.height) } : undefined;
    } catch (_e) { return undefined; }
  }

  function imageAbsUrl(src) {
    try { return new URL(src, location.href).href; } catch (_e) { return src; }
  }

  function imageMetrics(el) {
    return {
      alt: el.getAttribute?.('alt') || '',
      natural: el.naturalWidth ? { w: el.naturalWidth, h: el.naturalHeight } : undefined,
      box: imageBox(el),
    };
  }

  function listImages(o) {
    const opt = o || {};
    const includeIcons = Boolean(opt.includeIcons);
    const max = Math.max(1, Number(opt.max) || 50);
    const buildImageRec = (el, index) => {
      const src = String(el.getAttribute?.('src') || '');
      if (!src || (!includeIcons && /assets\/favicon|site-title-icon/.test(src))) return null;
      const ext = ((/[/.]([a-z0-9]+)$/i.exec(src.split('?')[0]) || [])[1] || '').toLowerCase();
      return {
        index, src, abs: imageAbsUrl(src), ext,
        ...imageMetrics(el),
        uploadable: /^(jpe?g|png)$/i.test(ext),
      };
    };
    const out = [];
    for (const el of all(S.articleImages)) {
      const rec = buildImageRec(el, out.length);
      if (rec) out.push(rec);
      if (out.length >= max) break;
    }
    const needConvert = out.filter((x) => !x.uploadable).length;
    return {
      ok: true, total: out.length, needConvert, images: out,
      hint: needConvert
        ? '有 ' + needConvert + ' 张不是 jpg/png，需要时先调 site_image 用 index 转成 jpeg'
        : '全部为 jpg/png，可直接读取',
    };
  }

  /**
   * 把一张页面图片转成 JPEG/PNG 的 dataURL（浏览器 canvas 解码）。
   *
   * 为什么必须在页面里做：本站配图多为 webp，转换要在能原生解码的浏览器环境里完成。
   * 图片同源、无 CSP，canvas 不会被污染，toDataURL 可直接取像素。
   *
   * @param {object} o
   * @param {number} [o.index]    listImages 的下标（与 src 二选一）
   * @param {string} [o.src]      图片地址（相对或绝对）
   * @param {string} [o.format]   'jpeg'（默认）| 'png'
   * @param {number} [o.quality]  1-100，默认 82
   * @param {number} [o.maxWidth] 超过则等比缩小，默认 1400
   * @param {number} [o.maxBytes] 目标体积上限（默认 120000）——超了自动降质量重编
   */
  function resolveImageSrc(opt) {
    const src = String(opt.src || '').trim();
    if (src) return { src };
    if (opt.index == null) return { error: { ok: false, reason: 'empty_src', hint: '给 index（先用 site_list_images 取）或 src' } };
    const list = all(S.articleImages).filter((el) => {
      const s = String(el.getAttribute?.('src') || '');
      return s && !/assets\/favicon|site-title-icon/.test(s);
    });
    const el = list[Number(opt.index)];
    return el ? { src: String(el.getAttribute('src')) } : { error: { ok: false, reason: 'index_out_of_range', total: list.length } };
  }

  function createImageEnv(w) {
    const Ctor = w.Image || globalThis.Image;
    const canvas = (w.document || doc).createElement?.('canvas');
    return Ctor && canvas?.getContext ? { Ctor, canvas } : null;
  }

  function compressJpegToBudget(canvas, mime, quality, maxBytes) {
    let q = quality;
    let dataUrl = canvas.toDataURL(mime, q / 100);
    let bytes = Math.round(((dataUrl.split(',')[1] || '').length) * 3 / 4);
    for (let tries = 0; bytes > maxBytes && q > 40 && tries < 6; tries += 1) {
      q = Math.max(40, q - 12);
      dataUrl = canvas.toDataURL(mime, q / 100);
      bytes = Math.round(((dataUrl.split(',')[1] || '').length) * 3 / 4);
    }
    return { q, dataUrl, bytes };
  }

  function encodeImageCanvas(canvas, img, cfg) {
    const { format, mime, quality, maxWidth, maxBytes } = cfg;
    const nw = img.naturalWidth || img.width || 0;
    const nh = img.naturalHeight || img.height || 0;
    const scale = nw > maxWidth ? maxWidth / nw : 1;
    const cw = Math.max(1, Math.round(nw * scale));
    const ch = Math.max(1, Math.round(nh * scale));
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (format === 'jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cw, ch); }
    ctx.drawImage(img, 0, 0, cw, ch);
    const enc = format === 'jpeg'
      ? compressJpegToBudget(canvas, mime, quality, maxBytes)
      : (() => {
          const dataUrl = canvas.toDataURL(mime, quality / 100);
          return { q: null, dataUrl, bytes: Math.round(((dataUrl.split(',')[1] || '').length) * 3 / 4) };
        })();
    return {
      ok: true, format, mimeType: mime, width: cw, height: ch,
      originalWidth: nw, originalHeight: nh, resized: scale < 1,
      quality: enc.q, bytes: enc.bytes, dataUrl: enc.dataUrl, overLimit: enc.bytes > maxBytes,
    };
  }

  function parseImageOptions(o) {
    const opt = o || {};
    const format = opt.format === 'png' ? 'png' : 'jpeg';
    return {
      opt,
      cfg: {
        format,
        mime: format === 'png' ? 'image/png' : 'image/jpeg',
        quality: Math.max(1, Math.min(100, Number(opt.quality) || 82)),
        maxWidth: Math.max(64, Number(opt.maxWidth) || 1400),
        maxBytes: Math.max(1000, Number(opt.maxBytes) || 120000),
      },
    };
  }

  function imageToDataUrl(o) {
    const w = win || {};
    const { opt, cfg } = parseImageOptions(o);
    const resolved = resolveImageSrc(opt);
    if (resolved.error) return Promise.resolve(resolved.error);
    const abs = imageAbsUrl(resolved.src);
    const env = createImageEnv(w);
    if (!env) {
      return Promise.resolve({
        ok: false, reason: 'canvas_unavailable',
        hint: '当前环境不能解码图片：需要浏览器 canvas（扩展/Playwright 里可用）',
      });
    }
    return new Promise((resolve) => {
      const img = new env.Ctor();
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const timer = (w.setTimeout || setTimeout)(() => done({ ok: false, reason: 'image_timeout', src: abs }), 20000);
      const clrT = w.clearTimeout || clearTimeout;
      img.onerror = () => { clrT(timer); done({ ok: false, reason: 'image_load_failed', src: abs }); };
      img.onload = () => {
        clrT(timer);
        try { done({ ...encodeImageCanvas(env.canvas, img, cfg), src: abs }); }
        catch (e) { done({ ok: false, reason: 'convert_failed', detail: String(e?.message || e), src: abs }); }
      };
      try { img.src = abs; } catch (e) {
        clrT(timer);
        done({ ok: false, reason: 'image_load_failed', detail: String(e.message || e), src: abs });
      }
    });
  }

  return {
    headings, pageInfo, openSection, togglePanels, findSymbol, listSymbols, glossaryData, findGlossaryEntry,
    // 测试钩子：标题匹配规则（精确优先 + 全部命中）需要单独测，不经过 DOM
    __matchHeadings: matchHeadings,
    searchResults, captureView,
    readContent, findInPage, navigate, setView, viewState, panelState,
    listImages, imageToDataUrl, siteIndex, searchIndex,
  };
}

// ════════════════════════════════════════════════════════════════
// ② 工具定义（在 page-view 之上；不含任何 querySelector）
// ════════════════════════════════════════════════════════════════

/**
 * 把「注入的 DOM 环境」变成工具定义。
 *
 * ## annotations（2026-10-23，按 MCP 规范 ToolAnnotations）
 *
 * 每个工具带 `readOnlyHint / destructiveHint / idempotentHint / openWorldHint`。
 * 语义（Coze MCP-Builder Phase 2 定案 ②）：
 *   · 只读工具（get_page_info / read / index / search / list_images / image / capture）：
 *     readOnly=true、idempotent=true
 *   · site_navigate：readOnly=false（改了「当前页」这个状态）、destructive=false、idempotent=true
 *   · site_panels / site_view / site_show_symbol：idempotent=**false**
 *     （toggle 调两次回到原状态；改主题/侧栏同理）
 *   · openWorldHint 恒 false：全程本地，不碰外部系统
 *
 * ⚠️ **诚实边界（实测）**：浏览器侧 WebMCP polyfill 注册后只保留
 * `readOnlyHint`（映射成它自己的 `consequentialHint` 的补集）与
 * `untrustedContentHint`，**丢掉了 destructive/idempotent/openWorld 三个**。
 * 所以这三个 hint 在我们当前链路里**不生效**——写在这里是为：
 *   ① 将来若改走真 MCP SDK（stdio server）时直接可用；
 *   ② 让读代码的人知道「哪些语义是声明过但未落地的」，别以为它们在起作用。
 */

export function buildToolDefs(doc, win) {
  const w = win || (doc?.defaultView) || null;
  const view = createPageView(doc, null, w);

  return [
    {
      name: 'site_get_page_info',
      label: '确认当前页面',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: '我在哪：当前页标题、所属课程、URL、小节清单（含锚点）、当前高亮目录项、折叠面板开合数、显示设置（主题/色相/侧栏）、阅读进度。',
      inputSchema: { type: 'object', properties: {} },
      execute: () => view.pageInfo(),
    },
    {
      name: 'site_read',
      label: '读取页面正文',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: '读页面内容（Markdown）。**默认只给前 30 行**——够判断这一页讲什么；要更多必须显式给 offset/limit。'
        + 'what=page 读整页正文；outline 只列小节标题；section 读某一节（给 query 标题片段）；panel 读某个折叠面板；symbols 列出本页所有可查符号。'
        + '返回值里带完整分页变量：total_lines / total_chars / offset / limit / returned_lines / next_offset / has_more。',
      inputSchema: {
        type: 'object',
        properties: {
          what: { type: 'string', enum: ['page', 'outline', 'section', 'panel', 'symbols'] },
          query: { type: 'string' },
          limit: { type: 'number', description: '本次要几**行**（默认 30，硬上限 400）。想一次读完整页就给大数，例如 limit=200' },
          offset: { type: 'number', description: '从第几**行**开始（默认 0，行号从 0 数）。续读直接填上次返回值里的 next_offset' },
          maxChars: { type: 'number', description: '字符硬顶（默认 12000，防单行超长撑爆）。一般不用填' },
          includeCollapsed: { type: 'boolean' },
          links: { type: 'boolean' },
        },
      },
      execute: (a) => view.readContent(a || {}),
    },
    {
      name: 'site_index',
      label: '查看站点目录',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: '站点地图：**层级与侧边栏完全一致**（课程 → 分类 → 页面）。默认给当前课程；scope="all" 给全站。'
        + '想找某类内容就带 match（例如 match="作业"）——只返回含该词的子树，省得读整棵树。'
        + '需要可跳转的完整路径时才加 paths:true。',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['course', 'all'] },
          match: { type: 'string', description: '只保留名字或路径含该词的子树（保留祖先，层级仍清楚）' },
          paths: { type: 'boolean', description: '给完整仓库路径（默认只给短文件名，够认出是哪个页面）' },
          max: { type: 'number' },
        },
      },
      execute: (a) => view.siteIndex(a || {}),
    },
    {
      name: 'site_navigate',
      label: '翻到目标页面',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: '去别处。to=section 跳到本页某小节（query 或 anchor）；link 点侧栏某页（query 页面名）；page 按仓库相对路径打开（path）；prev/next 上一节/下一节；home 回首页；back 浏览器后退；top/bottom 到页首/页尾。',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', enum: ['section', 'link', 'page', 'prev', 'next', 'home', 'back', 'top', 'bottom'] },
          query: { type: 'string' },
          anchor: { type: 'string' },
          path: { type: 'string' },
          hash: { type: 'string' },
        },
      },
      execute: (a) => view.navigate(a || {}),
    },
    {
      name: 'site_search',
      label: '检索资料库',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: '找内容。scope=site（默认）直读全站索引，返回命中页面的标题、路径、以及页内命中小节（含锚点）；scope=page 在本页内文里找（像 Ctrl+F），返回片段与所在小节。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          scope: { type: 'string', enum: ['site', 'page'] },
        },
        required: ['query'],
      },
      execute: (a) => {
        const q = String((a?.query) || '').trim();
        if (!q) return { ok: false, reason: 'empty_query' };
        // scope=page：页内查找（Ctrl+F 语义）
        if ((a?.scope) === 'page') return view.findInPage(q);
        // scope=site（默认）：**直读 search/index.json**，不开搜索框。
        // 2026-10-19 用户定案：「搜索框明显是给人类用的」——模型要的是结果+链接+锚点。
        return view.searchIndex(q, { limit: a?.limit, includeHeadings: true });
      },
    },
    {
      name: 'site_show_symbol',
      label: '查符号释义',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: '查本页某个符号的含义：直读页面烘焙的符号词典（#sym-glossary-json），返回标题、一句话释义、全部义项与所属语境 ctx、详细链接；给 popup=true 时同步在页面弹出视觉气泡。给 term 可用规范键（如 通用:sym-U）、符号 id（如 sym-U）或显示文字（如 U）。',
      inputSchema: {
        type: 'object',
        properties: {
          term: { type: 'string' },
          popup: { type: 'boolean', description: '可选：true 时同时在页面上点开视觉气泡' },
        },
        required: ['term'],
      },
      execute: (a) => {
        const needle = String((a?.term) || '').trim();
        if (!needle) return { ok: false, reason: 'empty_term' };
        const firstSentence = (t, cap) => {
          const flat = String(t || '').replace(/\s+/g, ' ').trim();
          const m = /^[^。；;]{1,200}[。；;]?/.exec(flat);
          const one = (m ? m[0] : flat).trim();
          return one.length > cap ? one.slice(0, cap) + '…' : one;
        };
        const clickSymbolEl = (el) => {
          try { el.scrollIntoView({ block: 'center' }); } catch (_e) { /* 无滚动不影响点击 */ }
          const win2 = w || {};
          const ClickEvent = win2.MouseEvent || (typeof MouseEvent !== 'undefined' ? MouseEvent : null);
          if (ClickEvent) el.dispatchEvent(new ClickEvent('click', { bubbles: true, cancelable: true, view: win2 }));
          else el.click?.();
        };
        const formatSenses = (entry) => (Array.isArray(entry.senses) && entry.senses.length
          ? entry.senses.map((s) => ({
              ctx: s.ctx,
              brief: firstSentence(s.plainText || s.text || '', 80),
              here: s.here === true || (Boolean(entry.ctx) && s.ctx === entry.ctx),
            }))
          : undefined);
  function splitTermKey(key) {
    const colon = key.indexOf(':');
    return colon >= 0 ? [key.slice(0, colon), key.slice(colon + 1)] : [undefined, key];
  }

  function jsonHitBrief(rawTitle, entry) {
    const prefix = rawTitle ? rawTitle + '：' : '';
    return firstSentence(prefix + (entry.plainText || entry.text || ''), 120);
  }

  function formatJsonHit({ key, entry, data }) {
    const rawTitle = entry.titleText || entry.title || '';
    const [p0, p1] = splitTermKey(key);
    return {
      ok: true, term: key, id: entry.id || p1, pack: entry.pack || p0,
      title: rawTitle,
      brief: jsonHitBrief(rawTitle, entry),
      senses: formatSenses(entry),
      ctx: entry.ctx || data?.ctx,
      detailHref: entry.href,
      source: 'sym-glossary-json',
      hint: '要看全文就 site_read 那个 detailHref 指向的页面（用 what=section 或 what=page）',
    };
  }
        const formatBubbleSenses = (senses) => (senses.length > 1
          ? senses.map((x) => ({ brief: firstSentence(x.text, 80), here: x.here }))
          : undefined);
        const queryGlossaryBubble = () => {
          try { return doc.querySelector(PAGE_SELECTORS.glossaryBubble); } catch (_e) { return null; }
        };
        const readBubbleSenses = (bubble) => {
          const lis = bubble?.querySelectorAll?.('li') || [];
          return Array.prototype.slice.call(lis).map((li) => ({
            text: renderMarkdown(li), here: hasClass(li, 'is-here'),
          }));
        };
        const readBubbleDom = (el) => {
          const bubble = queryGlossaryBubble();
          const moreHref = bubble?.querySelector?.('a')?.getAttribute?.('href');
          return {
            ok: true,
            term: el.getAttribute?.('data-term') || needle,
            brief: firstSentence(bubble ? renderMarkdown(bubble) : '', 120),
            senses: formatBubbleSenses(readBubbleSenses(bubble)),
            detailHref: moreHref,
            hint: '要看全文就 site_read 那个 detailHref 指向的页面（用 what=section 或 what=page）',
          };
        };

        const readBubbleWithRaf = (read) => (typeof w?.requestAnimationFrame === 'function'
          ? new Promise((resolve) => w.requestAnimationFrame(() => resolve(read())))
          : read());
        const dispatchShowSymbol = () => {
          const jsonHit = view.findGlossaryEntry ? view.findGlossaryEntry(needle) : null;
          const el = view.findSymbol(needle);
          if (a?.popup && el) clickSymbolEl(el);
          if (jsonHit) return formatJsonHit(jsonHit);
          if (!el) {
            const all = view.listSymbols(200);
            return { ok: false, reason: 'symbol_not_on_page', total: all.length, available: all.slice(0, 40) };
          }
          clickSymbolEl(el);
          return readBubbleWithRaf(() => readBubbleDom(el));
        };
        return dispatchShowSymbol();
      },
    },
    {
      name: 'site_panels',
      label: '展开折叠内容',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: '折叠面板：action=open/close/toggle 全部（或只作用于 match 匹配标题的那些）。返回命中数、实际改变数与最新开合统计。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['open', 'close', 'toggle'] },
          match: { type: 'string' },
        },
      },
      execute: (a) => {
        const act = (a?.action) || 'toggle';
        const open = act === 'open' ? true : act === 'close' ? false : undefined;
        return view.togglePanels(open, a?.match);
      },
    },
    {
      name: 'site_view',
      label: '显示设置',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: '显示设置：theme=light/dark 切明暗；hue=0-360 改主题色相；sidebar=open/closed/toggle 开合侧栏。只给想改的字段，返回改后状态。',
      inputSchema: {
        type: 'object',
        properties: {
          theme: { type: 'string', enum: ['light', 'dark'] },
          hue: { type: 'number' },
          sidebar: { type: 'string', enum: ['open', 'closed', 'toggle'] },
        },
      },
      execute: (a) => view.setView(a || {}),
    },
    {
      name: 'site_list_images',
      label: '查找页面配图',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: '列出本页正文里的图片（下标、地址、格式、alt、尺寸、是否可直接用于仅收 jpg/png 的接口）。本站配图多为 webp，uploadable=false 的可用 site_image 转码。',
      inputSchema: {
        type: 'object',
        properties: {
          includeIcons: { type: 'boolean' },
          max: { type: 'number' },
        },
      },
      execute: (a) => view.listImages(a || {}),
    },
    {
      name: 'site_image',
      label: '查看图片',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: '把页面图片转成 JPEG/PNG 的 dataURL（浏览器 canvas 解码，webp/jxl 都能转）。给 index（先用 site_list_images 取）或 src；自动限宽限体积（默认 1400px / 120KB，超了逐档降质量）。返回可直接交给上传通道的 dataUrl 与字节数。',
      inputSchema: {
        type: 'object',
        properties: {
          index: { type: 'number' },
          src: { type: 'string' },
          format: { type: 'string', enum: ['jpeg', 'png'] },
          quality: { type: 'number' },
          maxWidth: { type: 'number' },
          maxBytes: { type: 'number' },
        },
      },
      execute: (a) => view.imageToDataUrl(a || {}),
    },
    {
      name: 'site_capture_view',
      label: '截图查看版面',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: '把页面的一处区域截成图片，交给你自己看（你看不到页面本身）。给 selector 截某个元素（如 .article-content、table），或给 rect 截一块视口坐标区域。区域截图总能成功；不给 selector/rect 的整屏截图需要宿主能力，通常不可用。',
      inputSchema: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['jpeg', 'png'] },
          quality: { type: 'number' },
          fullPage: { type: 'boolean' },
          selector: { type: 'string' },
          rect: { type: 'object' },
          reason: { type: 'string' },
        },
      },
      execute: (a) => view.captureView(a, w),
    },
  ];
}

// ════════════════════════════════════════════════════════════════
// ③ 按需浏览器包：由真函数 toString() 派生（零自动协议注册）
// ════════════════════════════════════════════════════════════════

/**
 * 便利函数调用入口。
 *
 * 与 `buildToolDefs` 共用同一套 `createPageView`，保持构建外调用一致。
 *
 * @param {Document} doc
 * @param {string} name  函数/工具名（site_index 等）
 * @param {object} args  参数
 * @returns {Promise<{ok:boolean, value?:any, effect?:object, error?:string}>}
 *   恒 resolve——失败也回 `{ok:false, error}`。
 */

/**
 * 工具结果 → 可读文本（feed）。
 *
 * 产出紧凑、自描述的执行回执（含工具名、参数、成功/失败状态、元数据与正文），
 * 并按 950 字符单条上限兜底。
 */
/**
 * 工具结果的统一抬头行。
 * 直接表明工具名、参数与成功/失败状态，不使用拟人寒暄或绕检变体。
 */
function feedHead(tool, argStr, failed) {
  const detail = tool + (argStr ? '（' + argStr + '）' : '');
  return failed ? '[工具失败] · ' + detail + ' · 没成：' : '[工具返回] · ' + detail + '：';
}

/**
 * 失败枚举 → 一句人话（2026-10-29 站长定案）。
 *
 * `原因：no_such_page` 这种机器码模型很可能原样复述给用户，读起来像报错日志。
 * 这里把 39 个 reason 码逐个译成一句能直接说出口的话。**枚举值不删**——
 * 返回值里的 `reason` 字段照旧，机器侧判据（`/no_such_page/` 之类）仍可用。
 *
 * 表里没有的码（新加的忘了补）退回原码，不至于把信息吞掉——漏补能看见，
 * 静默变成「执行失败」才是真危险（本轮修的就是那个）。
 *
 * ⚠️ 与 `feedHead` 同款坑：词表定义在函数内部。模块级 const 不会被
 * `toString()` 带进浏览器产物，会抛「REASON_TEXT is not defined」。
 */
function reasonText(code) {
  const REASON_TEXT = {
    // 导航与页面
    no_such_page: '站点里没有这一页，跳不了',
    no_spa_router: '当前页面不支持站内跳转，跳不了',
    navigate_failed: '换页失败了，页面没动',
    unknown_target: '不认识的跳转方向，没执行',
    empty_path: '没给要跳的路径',
    empty_query: '没给要找的标题或关键词',
    no_paging: '本页没有上一节或下一节',
    no_brand: '找不到回首页的入口',
    click_failed: '点不动那个元素',
    scroll_unavailable: '这个环境滚不动页面',
    history_unavailable: '这个环境没有后退历史',
    // 检索与阅读
    not_found: '没找到',
    ambiguous: '匹配到好几个，分不清是哪一个',
    article_not_found: '当前页没有正文容器，读不到内容',
    anchor_missing: '那一节在这页里不存在',
    selector_not_found: '页面上没有匹配的元素',
    index_unavailable: '全站检索索引取不到',
    index_out_of_range: '下标越界',
    // 参数
    bad_type: '参数类型不对',
    out_of_range: '参数超出允许范围',
    empty_term: '没给要查的符号',
    empty_src: '没给图片来源',
    nothing_to_do: '没给要做哪一项',
    // 符号
    symbol_not_on_page: '本页没有这个符号',
    // 截图与图片
    capture_unavailable: '这个环境不提供截图能力',
    capture_failed: '截图没成功',
    capture_error: '截图出错了',
    capture_tainted: '截图被跨域限制挡住了',
    canvas_unavailable: '这个环境没有 canvas，转不了图',
    no_layout: '拿不到元素的位置',
    empty_rect: '元素尺寸是 0，截不到内容',
    serialize_failed: '图转不成数据',
    convert_failed: '格式转换失败',
    image_load_failed: '图片没加载出来',
    image_timeout: '等图片超时了',
    region_timeout: '截取区域超时了',
    region_render_failed: '区域渲染失败',
  };
  const k = String(code || '').trim();
  if (!k) return '执行失败';
  return REASON_TEXT[k] || k;
}

export function feedText(name, args, r) {
  const SINGLE_MSG_LIMIT = 950;
  const a = args || {};
  const argStr = Object.keys(a)
    .filter((k) => a[k] !== undefined && a[k] !== '' && k !== '_positional')
    .map((k) => k + '=' + String(a[k]).slice(0, 40))
    .join(' | ');
  const head = feedHead(name, argStr, !(r?.ok));

  const nextStepHint = (code, hasCand) => {
    if (code === 'ambiguous' && hasCand) return '建议下一步：从上一条候选里挑一个准确的名字重试，别再用现在这个词。';
    if (/no_such_page|not_found|not_in_nav|unknown_target|empty_query|empty_path/.test(code)) {
      return '建议下一步：换一个更短的关键词重试，或先用 site_read，what=outline 看全部标题。';
    }
    return '建议下一步：换个参数重试；连续失败就直接告诉用户当前做不到。';
  };

  const listSnippet = (arr, label) => (Array.isArray(arr) && arr.length
    ? label + '：' + arr.slice(0, 12).map((c) => '「' + c + '」').join(' / ')
    : null);

  const formatCandidateLine = (v) => listSnippet(v?.candidates, '候选') || listSnippet(v?.available, '可选');

  const appendFailureExtras = (lines, v, code) => {
    const hasCand = Boolean(v?.candidates?.length);
    if (v?.hint) lines.push('提示：' + String(v.hint).slice(0, 200));
    const candLine = formatCandidateLine(v);
    if (candLine) lines.push(candLine);
    if (!v?.hint) lines.push(nextStepHint(code, hasCand));
  };

  const feedFailure = () => {
    const v = r?.value && typeof r.value === 'object' ? r.value : null;
    const code = String(r?.error || v?.reason || '');
    const lines = [head, '- 原因：' + reasonText(code)];
    appendFailureExtras(lines, v, code);
    return lines.join('\n').slice(0, SINGLE_MSG_LIMIT);
  };

  const appendPagingMeta = (meta, v) => {
    if (v.total_lines != null) meta.push('本段 ' + (v.returned_lines ?? '?') + '/' + v.total_lines + ' 行');
    if (v.has_more) meta.push('还有更多：下一段用 offset=' + v.next_offset + '（或一次多要点 limit=100）');
  };

  const buildMeta = (v) => {
    const meta = [];
    if (v.ok === false) meta.push('执行未成功：' + String(v.reason || ''));
    if (v.title) meta.push('标题：' + v.title);
    if (v.what) meta.push('类型：' + v.what);
    appendPagingMeta(meta, v);
    const cand = listSnippet(v.candidates, '候选');
    if (cand) meta.push(cand);
    if (v.hint) meta.push('提示：' + String(v.hint).slice(0, 200));
    return meta;
  };

  const groupIndexLines = (lines) => {
    const groups = [];
    let cur = null;
    for (const ln of lines) {
      if (/^\s{2}\S/.test(ln) && !/^\s{2}-/.test(ln)) { cur = { title: ln.trim(), count: 0 }; groups.push(cur); }
      else if (cur && /^\s+-/.test(ln)) cur.count += 1;
      else if (!cur) groups.push({ title: ln.trim(), count: 0, raw: true });
    }
    return groups;
  };

  const formatCompressedIndex = (groups) => {
    const compressed = groups.map((g) => (g.raw ? g.title : '  ' + g.title + '（' + g.count + ' 页）'));
    const courseCount = groups.filter((g) => !g.raw).length;
    return (head + '\n'
      + '- 全站共 ' + courseCount + ' 门课（清单较大，已压缩为课程级摘要）\n'
      + '---正文开始---\n' + compressed.join('\n') + '\n---正文结束---\n'
      + '（要看某门课的完整页面清单，用 site_index，scope=course）').slice(0, SINGLE_MSG_LIMIT);
  };

  const compressSiteIndex = (v) => {
    const text = String(v.text).replace(/%[0-9A-Fa-f]{2}/g, '').replace(/`/g, '');
    if (text.length <= 700) return null;
    return formatCompressedIndex(groupIndexLines(text.split('\n')));
  };

  const stringifyResultBody = (v) => {
    if (typeof v.text === 'string' && v.text) return v.text;
    try { return JSON.stringify(v); } catch { return String(v); }
  };

  const feedSuccess = (v) => {
    if (!v || typeof v !== 'object') {
      return (head + '\n' + String(v ?? '')).slice(0, SINGLE_MSG_LIMIT);
    }
    const meta = buildMeta(v);
    if (name === 'site_index' && typeof v.text === 'string') {
      const compressed = compressSiteIndex(v);
      if (compressed) return compressed;
    }
    const metaBlock = meta.length ? meta.map((m) => '- ' + m).join('\n') + '\n' : '';
    return (head + '\n' + metaBlock + '---正文开始---\n' + stringifyResultBody(v) + '\n---正文结束---').slice(0, SINGLE_MSG_LIMIT);
  };

  if (!r || !r.ok) return feedFailure();
  return feedSuccess(r.value);
}

export async function runTool(doc, name, args) {
  // 分派唯一真相（issue #18 P0-1）：直接取 buildToolDefs 的 execute——
  // 注册（WebMCP）与执行（工具循环）走同一份实现、同一套参数解包。
  // 此前这里有一份手写 MAP，参数解包与 buildToolDefs 各活各的：
  // site_panels 把 {action:"close"} 整个塞给标量参数 open（对象恒真 → close 变 open）、
  // site_show_symbol 把 {term} 塞给字符串参数（String() 出 "[object Object]" → 永远查不到）。
  const defs = buildToolDefs(doc, doc?.defaultView);
  const def = defs.find((d) => d.name === name);
  if (!def || typeof def.execute !== 'function') return { ok: false, error: '页面没有工具 ' + String(name) };
  const safeArgs = args || {};
  let out;
  try {
    const value = await def.execute(safeArgs);
    out = { ok: value?.ok !== false, value };
  } catch (e) {
    out = { ok: false, error: String(e) };
  }
  out.feed = feedText(name, safeArgs, out);
  return out;
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
 * 站点便利函数浏览器包（仅当显式 `?helpers=1` 或调试/eval 引入时执行，正常访问零加载）。
 */
export const SITE_HELPERS_JS = `(function () {
"use strict";
if (typeof document === "undefined") return;

var PAGE_SELECTORS = ${serializeSelectors(PAGE_SELECTORS)};
var textOf = ${textOf.toString()};
var hasClass = ${hasClass.toString()};
var childrenOf = ${childrenOf.toString()};
var isTextNode = ${isTextNode.toString()};
var renderMarkdown = ${renderMarkdown.toString()};
var createPageView = ${createPageView.toString()};
var buildToolDefs = ${buildToolDefs.toString()};
var feedHead = ${feedHead.toString()};
var reasonText = ${reasonText.toString()};
var feedText = ${feedText.toString()};
var runTool = ${runTool.toString()};

// 按需挂载纯便利函数（零自动注册行为）
window.__siteHelpers = {
  runTool: function (name, args) { return runTool(document, name, args); },
  call: function (name, args) { return runTool(document, name, args); },
  defs: function () { return buildToolDefs(document, window); },
  createPageView: function () { return createPageView(document, location, window); },
};
})();`;
