/**
 * 站点语义工具：把页面的**全部交互能力**注册成 WebMCP 工具（独立可拆卸模块）。
 *
 * 与 `工具/mcp-端点/`（读层）的分工：
 *   - **读层**给「内容」——搜全站、取正文、查符号，不需要浏览器；
 *   - **本模块**给「交互」——跳页、跳锚点、开搜索、展开折叠、查页面上的符号、改显示设置，
 *     这些只有在**打开的页面上**才有意义。
 *
 * ## 2026-10-19 大补全：从 6 个浅工具到 8 个深工具
 *
 * 原工具集只能「跳小节 / 搜一下 / 点符号」，**读不到正文**——模型看不见页面内容，
 * 就不可能完成人能做的大部分事。本轮按「人在这页上能干什么」重划接口：
 *
 *   site_get_page_info  我在哪（标题/课程/URL/小节/当前定位/面板状态/显示设置）
 *   site_read           **读内容**（整页 / 大纲 / 某一节 / 折叠面板 / 某表格），输出 Markdown
 *   site_navigate       去别处（小节 / 侧栏某页 / 上一节 / 下一节 / 首页 / 后退 / 顶 / 底）
 *   site_search         找（全站索引 / 本页内文）
 *   site_show_symbol    查符号（点开气泡，读全部义项）
 *   site_panels         折叠面板（全部 / 按标题匹配 / 单个）
 *   site_view           显示设置（明暗主题 / 主题色相 / 侧栏开合）
 *   site_capture_view   截图（宿主注入能力）
 *
 * ## 结构（2026-10-16 候选 2+5 重构，本轮沿用）
 *
 *   ① **page-view**：**纯函数 + 依赖注入**——输入是「一个像 document 的对象」，
 *      输出是结构化页面事实。站点主题的选择器全部收缩在 `PAGE_SELECTORS`。
 *   ② **工具定义**：在 page-view 之上写，不含任何 `querySelector`。
 *   ③ **内联**：`WEBMCP_TOOLS_JS` 用 `Function.prototype.toString()` 把上面两者原样塞进页面。
 *
 * ## 为什么用 DOM 接口而不是内部 API
 * 站点的搜索/气泡/折叠模块只暴露纯函数，没有「跑一次搜索」的编程入口。
 * 所以交互走 DOM：点按钮、填输入框、派发事件——**与真人操作同一条路径**。
 */

// ════════════════════════════════════════════════════════════════
// ① page-view：选择器与发布格式的唯一集中处（纯函数，依赖注入）
// ════════════════════════════════════════════════════════════════

/** 站点主题的选择器与发布文案（**改主题只改这里**）。 */
export const PAGE_SELECTORS = {
  article: '.article-content',
  articleHeadings: '.article-content h2, .article-content h3, .article-content h4',
  articleTitle: '.article-content h1',
  // 正文配图（本站是 webp；学习通只收 jpg/png，所以要能列出来再转码）
  articleImages: '.article-content img',
  courseChip: '.meta-chip',
  details: 'details',
  // 符号可点元素：公式里的（.katex 内）与正文里的（a.sym-gloss）**两处都要认**
  glossaryTerm: '.katex [data-term], a.sym-gloss[data-term]',
  // 气泡的真实类名是 .sym-gloss-pop（2026-10-19 修：旧值 '.glossary-bubble, [class*=bubble]'
  // 与真实 DOM 完全不匹配，导致 site_show_symbol 的 bubble 字段恒为空——测试用假 DOM
  // 里的 class="glossary-bubble" 掩盖了这个 bug）
  glossaryBubble: '.sym-gloss-pop',
  glossaryJson: 'sym-glossary-json',
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
  return (' ' + String((el && el.className) || '') + ' ').indexOf(' ' + name + ' ') >= 0;
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
    try { decoded = decodeURI(h); } catch (e) { /* 保留原样 */ }
    return { kind: 'internal', href: decoded };
  }
  const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1 };
  const out = [];

  const push = (s) => { if (s) out.push(s); };
  const endsWith = (ch) => {
    for (let i = out.length - 1; i >= 0; i--) {
      if (!out[i]) continue;
      return out[i].slice(-1) === ch;
    }
    return false;
  };
  const ensureNl = (n) => {
    let tail = '';
    for (let i = out.length - 1; i >= 0 && tail.length < n; i--) tail = out[i] + tail;
    const have = (tail.match(/\n/g) || []).length;
    for (let i = have; i < n; i++) out.push('\n');
  };
  const trimTail = () => {
    for (let i = out.length - 1; i >= 0; i--) {
      if (!out[i]) continue;
      out[i] = out[i].replace(/[ \t]+$/, '');
      return;
    }
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
    let ann = null;
    try { ann = el.querySelector ? el.querySelector('annotation') : null; } catch (e) { /* 假 DOM */ }
    if (ann && ann.textContent) {
      return '$' + stripHtmlData(String(ann.textContent)).trim() + '$';
    }
    // 没有 annotation：优先 mathml 的文本（比 katex-html 干净），再退到可见副本
    let mathml = null;
    try { mathml = el.querySelector ? el.querySelector('.katex-mathml') : null; } catch (e) { /* 假 DOM */ }
    if (mathml && mathml.textContent) return mathml.textContent;
    let html = null;
    try { html = el.querySelector ? el.querySelector('.katex-html') : null; } catch (e) { /* 假 DOM */ }
    return (html ? html.textContent : el.textContent) || '';
  }

  /**
   * 剥掉站点注入的 `\htmlData{term=sym-x}{内容}` 包裹，只留内容。
   * **必须按括号配对扫描**——内容里可能还有 `\frac{a}{b}` 这样的嵌套花括号，
   * 正则的非贪婪写法在嵌套时会把公式切坏（实测 `p_h` 变 `\htmlData{...`）。
   */
  function stripHtmlData(src) {
    const s = String(src);
    const TAG = '\\htmlData{';
    let out = '';
    let i = 0;
    while (i < s.length) {
      const at = s.indexOf(TAG, i);
      if (at < 0) { out += s.slice(i); break; }
      out += s.slice(i, at);
      // 跳过第一组 {…}（term 参数）
      let j = at + TAG.length;
      let depth = 1;
      while (j < s.length && depth > 0) {
        if (s[j] === '{') depth += 1;
        else if (s[j] === '}') depth -= 1;
        j += 1;
      }
      // 紧接着第二组 {…}（内容）
      if (s[j] === '{') {
        let k = j + 1;
        depth = 1;
        while (k < s.length && depth > 0) {
          if (s[k] === '{') depth += 1;
          else if (s[k] === '}') depth -= 1;
          k += 1;
        }
        out += stripHtmlData(s.slice(j + 1, k - 1));   // 递归剥嵌套
        i = k;
      } else {
        i = j;   // 没有内容组：整段丢掉
      }
    }
    return out;
  }

  function walkInline(node) {
    if (!node) return '';
    if (isTextNode(node)) return node.textContent || '';
    const tag = String(node.tagName || '').toUpperCase();
    if (SKIP[tag]) return '';
    if (hasClass(node, 'katex')) return katexText(node);
    // KaTeX 的**内部**节点：外层 .katex 已经整体处理过，这里再遇到就是重复
    //（实测正文里出现孤立的 `$...$` 行与 BBBHHH——都是 katex-html 副本被二次读取）
    if (hasClass(node, 'katex-html') || hasClass(node, 'katex-mathml')) return '';
    // 符号链接：只留符号本身（后面的气泡内容靠 site_show_symbol 取）。
    // **不能直接取 textContent**——KaTeX 在 <math> 里同时有 <mi>B</mi> 与
    // <annotation>B</annotation>，textContent 会给出 "BB"（实测页面出现 BBB）。
    if (tag === 'A' && hasClass(node, 'sym-gloss')) {
      const k = childrenOf(node).find((c) => hasClass(c, 'katex'));
      return k ? katexText(k) : (node.textContent || '');
    }
    if (tag === 'A' && withLinks) {
      const t = linkTarget(node.getAttribute && node.getAttribute('href'));
      const label = walkInlineAll(node).trim();
      if (!t || !label) return label;
      // 外链加 ⧉ 前缀：模型据此知道 site_navigate 处理不了
      return t.kind === 'external'
        ? '⧉[' + label + '](' + t.href + ')'
        : '[' + label + '](' + t.href + ')';
    }
    if (tag === 'CODE') return '`' + (node.textContent || '') + '`';
    if (tag === 'STRONG' || tag === 'B') return '**' + walkInlineAll(node) + '**';
    if (tag === 'EM' || tag === 'I') return '*' + walkInlineAll(node) + '*';
    if (tag === 'BR') return '\n';
    if (hasClass(node, 'm3-disclosure__indicator')) return '';
    const kids = childrenOf(node);
    if (!kids.length) return node.textContent || '';
    return kids.map(walkInline).join('');
  }

  function walkInlineAll(node) {
    return childrenOf(node).map(walkInline).join('');
  }

  function walk(node, depth) {
    if (!node) return;
    if (isTextNode(node)) {
      const t = (node.textContent || '').trim();
      if (t) { ensureNl(1); push(t); }
      return;
    }
    const tag = String(node.tagName || '').toUpperCase();
    if (SKIP[tag]) return;

    if (hasClass(node, 'katex')) { push(katexText(node)); return; }
    if (hasClass(node, 'katex-html') || hasClass(node, 'katex-mathml')) return;
    if (tag === 'A') { push(walkInline(node)); return; }

    // 公式块容器：整块出一个独立段落（display 公式本来就是块级）
    if (hasClass(node, 'katex-scroll-container') || hasClass(node, 'katex-display')) {
      ensureNl(2);
      push(walkInline(node) + '\n\n');
      return;
    }

    if (/^H[1-6]$/.test(tag)) {
      ensureNl(2);
      const lvl = Number(tag.slice(1));
      push('\n' + '#'.repeat(lvl) + ' ' + walkInline(node).trim() + '\n\n');
      return;
    }
    if (tag === 'P') {
      const t = walkInline(node).trim();
      if (t) { ensureNl(1); push(t + '\n\n'); }
      return;
    }
    if (tag === 'BLOCKQUOTE') {
      ensureNl(1);
      // 用**局部渲染器**（同一份 out 缓冲），不要递归调 renderMarkdown——
      // 那会从根节点重来，在嵌套结构上直接栈溢出（2026-10-19 真实页实测）。
      const mark = out.length;
      childrenOf(node).forEach((c) => walk(c, depth));
      const inner = out.splice(mark).join('').trim();
      if (inner) push(inner.split('\n').map((l) => '> ' + l).join('\n') + '\n\n');
      return;
    }
    if (tag === 'UL' || tag === 'OL') {
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
      return;
    }
    if (tag === 'TABLE') {
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
      if (lines.length) {
        const cols = (lines[0].match(/\|/g) || []).length - 1;
        lines.splice(1, 0, '|' + Array(cols).fill(' --- ').join('|') + '|');
        push(lines.join('\n') + '\n\n');
      }
      return;
    }
    if (tag === 'PRE') {
      ensureNl(2);
      const codeEl = childrenOf(node).find((c) => String(c.tagName || '').toUpperCase() === 'CODE');
      // 真 DOM 里 class 属性与 className 是同一份；假 DOM 两者分开，都认一遍
      const lang = codeEl
        ? (codeEl.getAttribute && codeEl.getAttribute('class')) || codeEl.className || ''
        : '';
      const m = String(lang).match(/language-([\w-]+)/);
      push('```' + (m ? m[1] : '') + '\n' + ((codeEl || node).textContent || '').replace(/\n$/, '') + '\n```\n\n');
      return;
    }
    if (tag === 'HR') { ensureNl(2); push('---\n\n'); return; }
    if (tag === 'DETAILS') {
      const open = node.open !== false;
      if (!open && !includeCollapsed) return;
      const kids = childrenOf(node);
      const sum = kids.find((c) => String(c.tagName || '').toUpperCase() === 'SUMMARY');
      ensureNl(2);
      if (sum) {
        // summary 里的标题/序号是内容的一部分；指示三角要滤掉
        const title = walkInline(sum).replace(/\s+/g, ' ').trim();
        if (title) push('**' + title + '**' + (open ? '' : '〔折叠〕') + '\n\n');
      } else if (!open) {
        push('〔折叠〕\n\n');
      }
      kids.filter((c) => c !== sum).forEach((c) => walk(c, depth));
      ensureNl(1);
      return;
    }
    if (tag === 'SUMMARY') return;   // 由 DETAILS 处理
    // 其余块级/行内容器：继续下钻
    const kids = childrenOf(node);
    if (kids.length) {
      kids.forEach((c) => walk(c, depth));
    } else {
      const t = (node.textContent || '').trim();
      if (t) { ensureNl(1); push(t + '\n'); }
    }
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
  const location = loc || (doc && doc.location) || { href: '' };
  // winOverride 让调用方（含测试）注入一个「像 window 的对象」——
  // 需要 Image/canvas 的图片转码、需要 getComputedStyle 的显示设置都靠它。
  const win = winOverride || (doc && doc.defaultView) || null;

  const all = (sel) => {
    try { return Array.prototype.slice.call(doc.querySelectorAll(sel)); } catch (e) { return []; }
  };
  const first = (sel) => {
    try { return doc.querySelector(sel); } catch (e) { return null; }
  };
  const byId = (id) => { try { return doc.getElementById(id); } catch (e) { return null; } };

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

  /** 显示设置（主题 / 色相 / 侧栏）。 */
  function viewState() {
    const rootEl = (doc && doc.documentElement) || null;
    let hue = null;
    try {
      // 真 DOM：样式表里 --hue 有默认值，getComputedStyle 读得到；
      // 也认内联 style 与属性（测试/无计算样式环境）。
      if (win && win.getComputedStyle && rootEl) {
        const v = win.getComputedStyle(rootEl).getPropertyValue('--hue');
        if (v) hue = parseInt(v, 10);
      }
    } catch (e) { /* 无计算样式 */ }
    if (!Number.isFinite(hue) && rootEl) {
      try {
        const inline = rootEl.style && rootEl.style.getPropertyValue
          ? rootEl.style.getPropertyValue('--hue') : '';
        if (inline) hue = parseInt(inline, 10);
        if (!Number.isFinite(hue) && rootEl.getAttribute) {
          const attr = rootEl.getAttribute('data-hue');
          if (attr) hue = parseInt(attr, 10);
        }
      } catch (e) { /* 无内联样式 */ }
    }
    let sidebar = null;
    const body = (doc && doc.body) || null;
    const drawer = byId('m3-drawer');
    if (drawer && hasClass(drawer, 'open')) sidebar = 'open';
    else if (body && hasClass(body, 'sidebar-collapsed')) sidebar = 'collapsed';
    return {
      theme: rootEl ? (rootEl.getAttribute('data-theme') || null) : null,
      hue: Number.isFinite(hue) ? hue : null,
      sidebar,
    };
  }

  /** 当前页信息（含状态）。 */
  function pageInfo() {
    const titleEl = first(S.articleTitle);
    const chip = courseChip();
    const body = (doc && doc.body) || null;
    let scrollY = 0, docHeight = 0, viewH = 0;
    try {
      scrollY = win ? Math.round(win.scrollY || 0) : 0;
      docHeight = doc && doc.documentElement ? doc.documentElement.scrollHeight : 0;
      viewH = win ? win.innerHeight || 0 : 0;
    } catch (e) { /* 无窗口 */ }
    return {
      title: titleEl ? textOf(titleEl) : (doc.title || ''),
      course: chip ? textOf(chip).replace(/^\S+\s*/, '') : '',
      url: location.href || '',
      path: body ? (body.getAttribute('data-site-path') || '') : '',
      hash: String((location.hash || '')).replace(/^#/, ''),
      sections: headings(),
      activeToc: activeToc(),
      panels: panelState(),
      view: viewState(),
      position: {
        scrollY,
        scrollPct: docHeight > viewH && docHeight > 0
          ? Math.min(100, Math.round(scrollY / (docHeight - viewH) * 100)) : 0,
      },
    };
  }

  /**
   * 跳到某小节（按标题片段或锚点 id）。会**展开它所在的折叠面板**（与深链接同一条路径）。
   * @returns {{ok:boolean, title?:string, anchor?:string, reason?:string, available?:string[]}}
   */
  function openSection(byTitle, byAnchor, win2) {
    const list = headings();
    let target = null;
    const needle = byTitle ? String(byTitle).trim() : '';
    if (byAnchor) {
      target = byId(byAnchor);
    } else if (byTitle) {
      const hit = list.filter((h) => h.title.indexOf(needle) >= 0)[0];
      if (hit) target = byId(hit.anchor);
    }
    if (!target) {
      return { ok: false, reason: 'not_found', query: needle,
               candidates: nearestTitles(needle, list.map((h) => h.title)),
               hint: '标题里没有完全匹配。从 candidates 里挑一个最近的重试，或先调 site_read（what=outline）看全量标题。',
               available: list.map((h) => h.title).slice(0, 30) };
    }
    for (let node = target; node; node = node.parentElement) {
      if (String(node.tagName || '').toUpperCase() === 'DETAILS' && !node.open) node.open = true;
    }
    // 走真人的深链接路径（会同步 URL hash 并触发 :target 高亮与抽屉同步）
    if (target.id) {
      try {
        if (win2 && win2.__disclosureOpen) win2.__disclosureOpen(target.id);
        else if (location && typeof location === 'object') location.hash = target.id;
      } catch (e) { /* 无 hash 能力 */ }
    }
    const w = win2 || win || null;
    try { target.scrollIntoView({ block: 'start' }); } catch (e) {
      try { target.scrollIntoView(); } catch (e2) { /* 无滚动也能返回锚点 */ }
    }
    return { ok: true, title: textOf(target), anchor: target.id };
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

  /** 页面上全部符号（供模型知道能查什么）。 */
  function listSymbols(limit) {
    const seen = {};
    const out = [];
    for (const x of all(S.glossaryTerm)) {
      const id = x.getAttribute ? String(x.getAttribute('data-term') || '') : '';
      if (!id || seen[id]) continue;
      seen[id] = 1;
      out.push({ id, text: textOf(x) });
      if (limit && out.length >= limit) break;
    }
    return out;
  }

  /** 读页内嵌的符号词典（构建期按页烘焙）。 */
  function glossaryDict() {
    const tag = byId(S.glossaryJson);
    if (!tag) return null;
    try { return JSON.parse(tag.textContent || '{}'); } catch (e) { return null; }
  }

  /**
   * 读页内嵌的**侧栏形状**（阶段一）：`#nav-structure-json`，由 nav-structure.mjs
   * 构建期烘焙。这是 site_index / site_navigate 的**唯一数据源**——不再爬侧栏 DOM。
   * 返回 `{v, current, activeIds, expandedIds, nodes}`；缺失/损坏返回 null（调用方给明确 reason）。
   */
  function navStructure() {
    const tag = byId(S.navJson);
    if (!tag) return null;
    try {
      const data = JSON.parse(tag.textContent || '');
      if (!data || !Array.isArray(data.nodes)) return null;
      return data;
    } catch (e) { return null; }
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

  /** 搜索面板的输入框与容器（打开面板用）。 */
  function searchUi() {
    return { panel: byId(S.searchPanel), input: byId(S.searchInput) };
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
  function asInt(raw, opt) {
    const o = opt || {};
    if (raw === undefined || raw === null || raw === '') return { ok: true, value: o.def };
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (!Number.isFinite(n)) {
      return { ok: false, reason: 'bad_type', hint: o.name + ' 必须是数字，收到的是「' + raw + '」' };
    }
    if (!Number.isInteger(n)) {
      return { ok: false, reason: 'bad_type', hint: o.name + ' 必须是整数，收到的是 ' + n };
    }
    if (o.min !== undefined && n < o.min) {
      return { ok: false, reason: 'out_of_range', hint: o.name + ' 不能小于 ' + o.min + '，收到的是 ' + n };
    }
    if (o.max !== undefined && n > o.max) {
      return { ok: false, reason: 'out_of_range', hint: o.name + ' 上限是 ' + o.max + '，收到的是 ' + n + '（请用 offset 分页读）' };
    }
    return { ok: true, value: n };
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
  function readContent(o) {
    const opt = o || {};
    const what = opt.what || 'page';
    // 硬上限 12000（Coze MCP-Builder 定案：中文 1 字≈1 token，12k 字符不爆上下文）
    // 2026-10-23：改用 asInt 做「宽容类型转换 + 语义严格」——
    // "6000" 能转就转，"abc" / -5 / 50000 拒并给可落地 hint（Phase 2 定案 ③）。
    const mc = asInt(opt.maxChars, { name: 'maxChars', def: 8000, min: 1, max: 12000 });
    if (!mc.ok) return { ok: false, reason: mc.reason, hint: mc.hint, param: 'maxChars' };
    const of = asInt(opt.offset, { name: 'offset', def: 0, min: 0 });
    if (!of.ok) return { ok: false, reason: of.reason, hint: of.hint, param: 'offset' };
    const maxChars = mc.value;
    const offset = of.value;
    const article = first(S.article) || (doc && doc.body) || doc;

    // ⭐ 2026-10-23 分页（Coze MCP-Builder Phase 1 定案的 offset+limit 口径）：
    // 旧版超 maxChars 直接截断，**没有翻页手段**——19,735 字的攻略页整页读会丢
    // 后半段（调查 C 的盲区 4）。现在 offset+limit 切窗，返回带元数据
    // total_chars / offset / limit / has_more，模型自己判断要不要继续翻。
    // 用 offset 不用 cursor：每次调用都重读 DOM（零缓存），cursor 编码的偏移在
    // DOM 变化后同样失效，反而多一层状态。
    const clip = (s) => {
      const t = String(s || '');
      const total = t.length;
      const from = Math.min(offset, total);
      const slice = t.slice(from, from + maxChars);
      return {
        text: slice,
        totalChars: total,
        total_chars: total,          // 双写：snake_case 是 MCP 侧惯用名
        offset: from,
        limit: maxChars,
        has_more: from + slice.length < total,
        truncated: from + slice.length < total,
      };
    };

    if (what === 'outline') {
      const hs = headings();
      return {
        ok: true, what, outline: hs, count: hs.length,
        text: hs.map((h) => '  '.repeat(Math.max(0, h.level - 2)) + '- ' + h.title).join('\n'),
      };
    }
    if (what === 'symbols') {
      const list = listSymbols(80);
      return { ok: true, what, symbols: list, count: list.length };
    }
    if (what === 'section' || what === 'panel') {
      const needle = String(opt.query || '').trim();
      if (!needle) return { ok: false, reason: 'empty_query', hint: '给 query（标题片段）' };
      if (what === 'section') {
        const hs = headings();
        const hit = hs.filter((h) => h.title.indexOf(needle) >= 0 || h.anchor === needle)[0];
        if (!hit) return { ok: false, reason: 'not_found', query: needle,
          candidates: nearestTitles(needle, hs.map((h) => h.title)),
          hint: '小节标题里没有匹配。从 candidates 里挑最近的一个重试。',
          available: hs.map((h) => h.title).slice(0, 30) };
        const target = byId(hit.anchor);
        if (!target) return { ok: false, reason: 'anchor_missing', anchor: hit.anchor };

        // ⚠️ 2026-10-19 实测：真实页有 **18000+ 节点**（KaTeX 每公式 ~30 个 span）。
        // 旧实现把整棵树摊平成数组再逐对做祖先检查（O(n²)），在真实页上直接卡死/抛错
        // ——「Tool execution failed」就是这么来的。
        // 新实现：从目标标题开始，**沿 DOM 顺序线性前进**，遇到同级或更高级标题就停。
        const body = [];
        let node = target;
        const LEVEL = hit.level;
        while (node) {
          const tag = String(node.tagName || '').toUpperCase();
          if (node !== target && /^H[1-4]$/.test(tag) && Number(tag.slice(1)) <= LEVEL) break;
          body.push(node);
          // 深度优先取下一个节点（不进入已收元素的子树，交给 renderMarkdown 下钻）
          node = nextInDoc(node, target);
        }
        // 只保留「直接属于这一节」的顶层块：跳过被已收元素包含的节点
        const top = [];
        for (const el of body) {
          if (el === target) { top.push(el); continue; }
          if (!isAncestor(target, el) && !top.some((t) => isAncestor(t, el))) top.push(el);
        }
        const md = renderMarkdown({ children: top, tagName: 'DIV' }, { includeCollapsed: opt.includeCollapsed, links: opt.links });
        const c = clip(md);
        return { ok: true, what, title: hit.title, anchor: hit.anchor, level: hit.level, ...c };
      }
      // panel：按标题匹配 details
      const ds = all(S.details).filter((d) => {
        const sum = d.querySelector ? d.querySelector('summary') : null;
        return (textOf(sum) + ' ' + textOf(d)).indexOf(needle) >= 0;
      });
      if (!ds.length) {
        return {
          ok: false, reason: 'not_found',
          available: all(S.details).map((d) => {
            const sum = d.querySelector ? d.querySelector('summary') : null;
            return textOf(sum).slice(0, 60);
          }).slice(0, 30),
        };
      }
      const md = ds.map((d) => renderMarkdown(d, { includeCollapsed: true, links: opt.links })).join('\n\n');
      const c = clip(md);
      return { ok: true, what, count: ds.length, ...c };
    }
    // page
    const md = renderMarkdown(article, { includeCollapsed: opt.includeCollapsed, links: opt.links });
    const c = clip(md);
    return { ok: true, what: 'page', title: pageInfo().title, sections: headings().length, ...c };
  }

  /**
   * DOM 顺序的下一个节点（先子后兄弟后上溯），但不进入 `stopAt` 之前已收元素的内部。
   * 用于「从某标题开始读到下一个同级标题」——线性、不摊平整棵树。
   */
  function nextInDoc(node, stopAt) {
    const kids = node.children;
    if (kids && kids.length) return kids[0];
    // 真实 DOM 有 nextElementSibling；假 DOM 没有 → 退化成「父节点里找我的下一个兄弟」
    let cur = node;
    while (cur) {
      if (cur.nextElementSibling) return cur.nextElementSibling;
      const par = cur.parentElement;
      if (!par) return null;
      // ⚠️ 真实 DOM 的 children 是 **HTMLCollection（没有 indexOf）**——
      // 2026-10-19 在真实页上炸出 `sibs.indexOf is not a function`。
      // 转成数组再找；假 DOM 的数组也照样能跑。
      const sibs = Array.prototype.slice.call(par.children || []);
      const at = sibs.indexOf(cur);
      if (at >= 0 && at + 1 < sibs.length) return sibs[at + 1];
      cur = par;
    }
    return null;
  }

  function isAncestor(a, b) {
    for (let p = b && b.parentElement; p; p = p.parentElement) if (p === a) return true;
    return false;
  }

  /** 页内查找（Ctrl+F 的语义）：返回命中片段与所在小节。 */
  function findInPage(query, limit) {
    const q = String(query || '').trim();
    if (!q) return { ok: false, reason: 'empty_query' };
    const hs = headings();
    const hits = [];
    const cap = limit || 10;
    // 逐节取文本（比整页扫更可定位）。用 renderMarkdown 而不是 textContent——
    // 后者会把 KaTeX 的 mathml/annotation/html 三份副本都算进去（实测片段里 BBB BBB BB…）。
    const buckets = hs.map((h) => ({ h, text: '' }));
    const article = first(S.article) || doc;
    const flat = [];
    (function collect(n) {
      for (const c of childrenOf(n)) {
        if (isTextNode(c)) continue;
        flat.push(c);
        collect(c);
      }
    })(article);
    let cur = -1;
    for (const el of flat) {
      const t = String(el.tagName || '').toUpperCase();
      if (/^H[2-4]$/.test(t)) {
        const hit = hs.findIndex((h) => h.anchor && h.anchor === el.id);
        if (hit >= 0) cur = hit;
        continue;   // 标题本身不进正文桶
      }
      if (cur >= 0) {
        // 只取「块级」节点：段落/列表/表格，避免把每个行内 span 重复计入
        if (/^(P|LI|TD|TH|BLOCKQUOTE|PRE|DD|DT)$/.test(t)) {
          const md = renderMarkdown(el);
          if (md) buckets[cur].text += ' ' + md;
        }
      }
    }
    const lowerQ = q.toLowerCase();
    for (const b of buckets) {
      const hay = b.text.toLowerCase();
      let from = 0;
      while (hits.length < cap) {
        const at = hay.indexOf(lowerQ, from);
        if (at < 0) break;
        hits.push({
          section: b.h.title,
          anchor: b.h.anchor,
          snippet: b.text.slice(Math.max(0, at - 40), at + q.length + 40).replace(/\s+/g, ' ').trim(),
        });
        from = at + lowerQ.length;
      }
      if (hits.length >= cap) break;
    }
    return { ok: true, query: q, total: hits.length, hits, truncated: hits.length >= cap };
  }

  /** 跳转（页面级）。 */
  function navigate(o) {
    const opt = o || {};
    const to = opt.to || 'section';
    const w = win || {};

    const click = (el) => {
      if (!el) return false;
      try {
        if (typeof el.click === 'function') { el.click(); return true; }
        const Ev = w.MouseEvent || (typeof MouseEvent !== 'undefined' ? MouseEvent : null);
        if (Ev && el.dispatchEvent) {
          el.dispatchEvent(new Ev('click', { bubbles: true, cancelable: true, view: w }));
          return true;
        }
      } catch (e) { /* 无事件能力 */ }
      return false;
    };

    if (to === 'section') return openSection(opt.query || opt.title, opt.anchor, w);

    if (to === 'top' || to === 'bottom') {
      try {
        const y = to === 'top' ? 0 : ((doc.documentElement && doc.documentElement.scrollHeight) || 0);
        if (w.scrollTo) w.scrollTo({ top: y, behavior: 'smooth' });
        else if (w.scrollTo) w.scrollTo(0, y);
        return { ok: true, to, y };
      } catch (e) { return { ok: false, reason: 'scroll_unavailable' }; }
    }

    if (to === 'back') {
      try { if (w.history && w.history.back) { w.history.back(); return { ok: true, to }; } } catch (e) { /* 无 history */ }
      return { ok: false, reason: 'history_unavailable' };
    }

    if (to === 'prev' || to === 'next') {
      const el = first(to === 'prev' ? S.pagingPrev : S.pagingNext);
      if (!el) return { ok: false, reason: 'no_paging', hint: to === 'prev' ? '本页没有上一节' : '本页没有下一节' };
      const href = el.getAttribute ? el.getAttribute('href') : '';
      const title = textOf(el.querySelector ? el.querySelector('.paging-title') : null);
      return click(el) ? { ok: true, to, href, title } : { ok: false, reason: 'click_failed' };
    }

    if (to === 'home') {
      const el = first(S.brand);
      if (!el) return { ok: false, reason: 'no_brand' };
      return click(el) ? { ok: true, to } : { ok: false, reason: 'click_failed' };
    }

    if (to === 'link') {
      const needle = String(opt.query || '').trim();
      if (!needle) return { ok: false, reason: 'empty_query' };
      const links = all(S.navLink);
      const labels = links.map((a) => textOf(a));

      // 2026-10-23 修（Node 桥实测）：模型给的是**带课程名的完整说法**
      // （「工程数学作业2」），而侧栏链接文本只有「作业2」——单向 indexOf 匹配不上，
      // 于是 navigate 返回 not_found、页面纹丝不动（用户看到「跳转没反应」）。
      //
      // 匹配按「候选池收窄 → 精确优先」两段走：
      //   ① 候选池：**当前课程子树里的链接优先**（侧栏有 6 门课，每门都有「作业」
      //      「课堂笔记」等同名项；不收窄会命中 4 个「作业」判成 ambiguous）。
      //      当前课程从 body[data-site-path] 取；拿不到就用全量。
      //   ② 在池内按三级强度取：文本包含 query > query 包含文本 > 去掉课程名后再比。
      const courseName = (function () {
        const bodyEl = (doc && doc.body) || null;
        const p = bodyEl && bodyEl.getAttribute ? (bodyEl.getAttribute('data-site-path') || '') : '';
        return p.split('/')[1] || '';
      })();
      // 当前课程作用域：链接的 data-path 以「课程/<当前课>/」开头。
      // ⚠️ 2026-10-23 补：在**首页/课程总览页**上 body[data-site-path] 里没有课程名
      // （README.html），此时「当前课程」不成立——但 query 自己可能带着课程名
      // （「工程数学作业2」）。所以再补一条：**query 里出现的课程名**也当作作用域。
      // 两条都不成立才用全量池（这时多命中就是真歧义，该让模型自己选）。
      const COURSE_NAMES = ['工程数学', '电力大数据与人工智能', '形势与政策', '电路原理', '电子技术', '电机学'];
      const courseFromQuery = COURSE_NAMES.filter((c) => needle.indexOf(c) >= 0)[0] || '';
      const scopeCourse = courseName || courseFromQuery;
      const inCourse = links.map((a, i) => ({ a, i, path: a.getAttribute ? (a.getAttribute('data-path') || '') : '' }))
        .filter((x) => scopeCourse && x.path.indexOf('课程/' + scopeCourse + '/') === 0);
      const pools = inCourse.length ? [inCourse, links.map((a, i) => ({ a, i }))] : [links.map((a, i) => ({ a, i }))];

      const tier1 = (pool) => pool.filter((x) => labels[x.i].indexOf(needle) >= 0);
      const tier2 = (pool) => pool.filter((x) => labels[x.i] && needle.indexOf(labels[x.i]) >= 0);
      const bare = scopeCourse ? needle.split(scopeCourse).join('') : needle;
      const tier3 = (pool) => (bare && bare !== needle
        ? pool.filter((x) => labels[x.i] && labels[x.i].indexOf(bare) >= 0)
        : []);

      let hits = [];
      for (const pool of pools) {
        // 强度顺序（2026-10-23 调整）：tier1 文本含 query > tier3 **去掉课程名后精确**
        // > tier2 query 含文本。tier2 最宽松——它会把「工程数学」也算命中
        // （「工程数学作业2」包含「工程数学」），排前面会让真目标「作业2」被歧义化。
        // tier3 剥掉课程名后是「作业2」，与侧栏文本精确对上，更该优先。
        for (const fn of [tier1, tier3, tier2]) {
          hits = fn(pool);
          if (hits.length) break;
        }
        if (hits.length) break;
      }

      if (!hits.length) {
        return { ok: false, reason: "not_found", query: needle, course: scopeCourse || undefined,
                 available: labels.filter(Boolean).slice(0, 40) };
      }
      // 同一目标出现多次（侧栏父子都指向同一页）时按 data-path 去重，避免假 ambiguous
      const uniq = [];
      const seen = {};
      for (const x of hits) {
        const key = (x.a.getAttribute ? x.a.getAttribute('data-path') : '') || labels[x.i];
        if (seen[key]) continue;
        seen[key] = 1;
        uniq.push(x);
      }
      if (uniq.length > 1) {
        return { ok: false, reason: "ambiguous", query: needle, course: scopeCourse || undefined,
                 candidates: uniq.map((x) => labels[x.i]).slice(0, 20),
                 hint: '侧栏里有多个匹配项，把 query 写得更具体（或改用 to=page 直接给路径）。' };
      }
      const el = uniq[0].a;
      return click(el) ? { ok: true, to, title: textOf(el), path: el.getAttribute ? el.getAttribute('data-path') : '' }
                       : { ok: false, reason: 'click_failed' };
    }

    if (to === 'page') {
      const path = String(opt.path || '').trim();
      const hash = String(opt.hash || '').trim();
      if (!path) return { ok: false, reason: 'empty_path' };

      // 侧栏校验（阶段一，2026-10-21）：白名单改从**侧栏形状 JSON**取（不再爬 data-path）。
      // 命中 ⇒ 放行；未命中 ⇒ 也放行，但把同课程的合法路径一并返回，
      // 让模型一次看对，不用瞎试三轮。**索引页本就在白名单里**（组节点带 indexHref）。
      const navData = navStructure();
      const navPaths = navData ? navTargets(navData) : [];
      const normalized = path.replace(/^\.\//, '').replace(/^\//, '');
      if (!navPaths.includes(normalized)) {
        // 索引页（…/index.html）即使没进白名单（数据缺失时）也不拦——跳转靠 404/标题变化暴露。
        const isIndexPage = /\/index\.html$/.test(normalized);
        if (!isIndexPage) {
          const bodyEl = (doc && doc.body) || null;
          const curPath = bodyEl && bodyEl.getAttribute ? (bodyEl.getAttribute('data-site-path') || '') : '';
          const curCourse = curPath.split('/')[1] || '';
          const sameCourse = navPaths.filter((x) => curCourse && x.startsWith('课程/' + curCourse + '/'));
          return {
            ok: false, reason: 'not_in_nav', path: normalized,
            hint: '这个路径不在侧栏导航里，也不像索引页。从候选里挑一个，或先用 site_index 看地图。',
            candidates: (sameCourse.length ? sameCourse : navPaths).slice(0, 20),
          };
        }
      }

      // 优先走 SPA（不整页刷新，且保留侧栏）
      try {
        if (w.__spaRouter && typeof w.__spaRouter.navigate === 'function') {
          const rootAttr = (doc.documentElement && doc.documentElement.getAttribute('data-root')) || './';
          const url = new URL(rootAttr + path, location.href).pathname;
          w.__spaRouter.navigate(url, hash, true);
          const verified = navPaths.includes(normalized);
          return { ok: true, to, path: normalized, hash, via: 'spa', verified };
        }
      } catch (e) { /* 退化到整页跳转 */ }
      try {
        const rootAttr = (doc.documentElement && doc.documentElement.getAttribute('data-root')) || './';
        location.href = new URL(rootAttr + path, location.href).href + (hash ? '#' + hash : '');
        return { ok: true, to, path, hash, via: 'reload' };
      } catch (e) { return { ok: false, reason: 'navigate_failed' }; }
    }

    return { ok: false, reason: 'unknown_target', to };
  }

  /** 显示设置（明暗 / 色相 / 侧栏）。 */
  function setView(o) {
    const opt = o || {};
    const w = win || {};
    const rootEl = (doc && doc.documentElement) || null;
    const body = (doc && doc.body) || null;
    const done = {};

    if (opt.theme === 'light' || opt.theme === 'dark') {
      if (rootEl && rootEl.setAttribute) rootEl.setAttribute('data-theme', opt.theme);
      try { if (w.localStorage) w.localStorage.setItem('theme', opt.theme); } catch (e) { /* 无存储 */ }
      done.theme = opt.theme;
    }
    if (opt.hue !== undefined && opt.hue !== null) {
      const hue = Math.max(0, Math.min(360, parseInt(opt.hue, 10) || 0));
      if (rootEl && rootEl.style && rootEl.style.setProperty) {
        rootEl.style.setProperty('--hue', String(hue));
        rootEl.style.setProperty('--primary-h', String(hue));
      }
      // 让面板上的滑块/徽标同步（人看得到变化）
      const slider = byId('hue-slider');
      if (slider) slider.value = String(hue);
      const badge = byId('palette-hue-badge');
      if (badge) badge.textContent = 'Hue ' + hue + '°';
      try { if (w.localStorage) w.localStorage.setItem('theme-hue', String(hue)); } catch (e) { /* 无存储 */ }
      done.hue = hue;
    }
    if (opt.sidebar === 'open' || opt.sidebar === 'closed' || opt.sidebar === 'toggle') {
      const drawer = byId('m3-drawer');
      const backdrop = byId('drawer-backdrop');
      const isOpen = drawer && hasClass(drawer, 'open');
      const want = opt.sidebar === 'toggle' ? !isOpen : opt.sidebar === 'open';
      if (drawer && drawer.classList) {
        if (want) drawer.classList.add('open'); else drawer.classList.remove('open');
        if (backdrop && backdrop.classList) {
          if (want) backdrop.classList.add('open'); else backdrop.classList.remove('open');
        }
        done.sidebar = want ? 'open' : 'closed';
      } else if (body && body.classList) {
        // 桌面形态：折叠与否是 body 上的类
        if (want) body.classList.remove('sidebar-collapsed');
        else body.classList.add('sidebar-collapsed');
        done.sidebar = want ? 'open' : 'collapsed';
      }
    }
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
  function captureView(opts, win2) {
    const o = opts || {};
    const w = win2 || win || null;
    const viewport = w ? { w: w.innerWidth || 0, h: w.innerHeight || 0 } : { w: 0, h: 0 };
    const meta = {
      title: (doc && doc.title) || '',
      url: (location && location.href) || '',
      scrollY: w ? Math.round(w.scrollY || 0) : 0,
      docHeight: doc && doc.documentElement ? doc.documentElement.scrollHeight : 0,
      viewport,
      reason: String(o.reason || ''),
    };
    const format = (o.format === 'png') ? 'png' : 'jpeg';
    const quality = Math.max(1, Math.min(100, Number(o.quality) || 80));

    // ── 区域/元素截图（2026-10-19 补）：优先走页面内 canvas ──────────
    // 元素截图不需要浏览器 chrome，同源图/文字/canvas 都能画。这解决了「只想看
    // 某个电路图」时截整屏的问题（整屏 1400px 宽会把图缩到看不清）。
    // 目标：selector 命中的元素，或 rect={x,y,w,h}（视口坐标），或整页（fullPage+canvas）。
    if (o.selector || o.rect) {
      return captureRegion(o, { format, quality, meta });
    }

    // 宿主能力：**整屏**截图只能由宿主给（页面截不到浏览器 chrome）。
    const provider = (w && typeof w.__siteCapture === 'function') ? w.__siteCapture : null;
    if (!provider) {
      // 没有宿主能力时，退一步：整页/可视区用 canvas 画不出来（跨域资源会污染），
      // 但**正文区域**可以——给出可执行的替代方案，而不是干巴巴报错。
      return Promise.resolve({
        ...meta, ok: false, reason: 'capture_unavailable',
        hint: '宿主未注入整屏截图能力。替代：给 selector（如 "article"）或 rect 用页面内 canvas 截指定区域，'
          + '或先调 site_list_images + site_image 取具体图片。',
        alternatives: { selector: '.article-content', rect: { x: 0, y: 0, w: viewport.w, h: viewport.h } },
      });
    }
    return Promise.resolve()
      .then(() => provider({ format, quality, fullPage: !!o.fullPage, meta }))
      .then((res) => {
        if (!res || !res.dataUrl) {
          return { ...meta, ok: false, reason: 'capture_failed', detail: res && res.error ? String(res.error) : '' };
        }
        const b64 = String(res.dataUrl).split(',')[1] || '';
        return {
          ...meta,
          ok: true, mimeType: res.mimeType || `image/${format}`, dataUrl: res.dataUrl,
          width: res.width || viewport.w, height: res.height || viewport.h,
          bytes: Math.round(b64.length * 3 / 4),
        };
      })
      .catch((e) => ({ ...meta, ok: false, reason: 'capture_error', detail: String((e && e.message) || e) }));
  }

  /**
   * 区域截图：把 selector 元素或 rect 区域画到 canvas 上出 JPEG。
   *
   * 限制（必须如实说，别假装能截一切）：canvas 只能画**已经渲染且同源**的内容。
   * 跨域图片会污染画布导致 toDataURL 抛错——本站全同源，所以可用；
   * 若将来有外链图，会返回 capture_tainted 而不是半白图。
   */
  function captureRegion(o, ctx0) {
    const w = win || {};
    const format = ctx0.format, quality = ctx0.quality, meta = ctx0.meta;
    let rect = null;
    let target = null;

    if (o.selector) {
      try { target = doc.querySelector(String(o.selector)); } catch (e) { target = null; }
      if (!target) return Promise.resolve({ ...meta, ok: false, reason: 'selector_not_found', selector: o.selector });
      try {
        const r = target.getBoundingClientRect();
        rect = { x: r.left, y: r.top, w: r.width, h: r.height };
      } catch (e) { return Promise.resolve({ ...meta, ok: false, reason: 'no_layout' }); }
    } else {
      const r = o.rect || {};
      rect = { x: Number(r.x) || 0, y: Number(r.y) || 0, w: Number(r.w) || 0, h: Number(r.h) || 0 };
    }
    if (!rect.w || !rect.h) {
      return Promise.resolve({ ...meta, ok: false, reason: 'empty_rect', rect });
    }

    // 缩放：区域宽度超 maxWidth 就等比缩
    const maxWidth = Math.max(64, Number(o.maxWidth) || 1400);
    const scale = rect.w > maxWidth ? maxWidth / rect.w : 1;
    const cw = Math.max(1, Math.round(rect.w * scale));
    const ch = Math.max(1, Math.round(rect.h * scale));

    const canvas = (w.document && w.document.createElement)
      ? w.document.createElement('canvas')
      : (doc.createElement ? doc.createElement('canvas') : null);
    if (!canvas || !canvas.getContext) {
      return Promise.resolve({ ...meta, ok: false, reason: 'canvas_unavailable' });
    }
    canvas.width = cw;
    canvas.height = ch;
    const g = canvas.getContext('2d');

    // 用 html2canvas 式的「画整页再裁」不可行（无依赖）。这里用 SVG foreignObject
    // 把目标元素的 HTML 序列化后画进来——对同源、无外链的静态页足够。
    const xml = serializeTarget(target, rect, cw, ch, scale);
    if (!xml) return Promise.resolve({ ...meta, ok: false, reason: 'serialize_failed' });
    const SvgImage = w.Image || (typeof Image !== 'undefined' ? Image : null);
    if (!SvgImage) return Promise.resolve({ ...meta, ok: false, reason: 'canvas_unavailable' });

    return new Promise((resolve) => {
      const img = new SvgImage();
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const setT = w.setTimeout ? w.setTimeout : setTimeout;
      const clrT = w.clearTimeout ? w.clearTimeout : clearTimeout;
      const timer = setT(() => done({ ...meta, ok: false, reason: 'region_timeout' }), 15000);
      img.onerror = () => { clrT(timer); done({ ...meta, ok: false, reason: 'region_render_failed', hint: 'SVG 渲染失败（可能是跨域字体/图片）' }); };
      img.onload = () => {
        clrT(timer);
        try {
          if (format === 'jpeg') { g.fillStyle = '#ffffff'; g.fillRect(0, 0, cw, ch); }
          g.drawImage(img, 0, 0, cw, ch);
          const dataUrl = canvas.toDataURL(format === 'png' ? 'image/png' : 'image/jpeg', quality / 100);
          const b64 = dataUrl.split(',')[1] || '';
          done({
            ...meta, ok: true, mode: 'region', selector: o.selector || null, rect,
            mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
            dataUrl, width: cw, height: ch, resized: scale < 1,
            bytes: Math.round(b64.length * 3 / 4),
          });
        } catch (e) {
          done({ ...meta, ok: false, reason: 'capture_tainted', detail: String((e && e.message) || e) });
        }
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
    } catch (e) { return null; }
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
      const docs = (idx && idx.docs) || [];
      const needle = query.toLowerCase();
      const hits = [];
      for (const d of docs) {
        // ① 标题命中
        const titleHit = String(d.title || '').toLowerCase().indexOf(needle) >= 0;
        // ② 小节标题命中
        const secHits = withHeadings
          ? (d.headings || []).filter((h) => String(h.t || h.d || '').toLowerCase().indexOf(needle) >= 0)
          : [];
        if (!titleHit && !secHits.length) continue;
        const hit = {
          title: d.title,
          path: String(d.url || '').replace(/^\//, ''),
          chars: d.chars,
        };
        if (secHits.length) {
          hit.sections = secHits.slice(0, 8).map((h) => ({
            title: h.d || h.t, anchor: h.a, level: h.l,
          }));
        }
        hits.push(hit);
        if (hits.length >= limit) break;
      }
      // 站内路径解码（索引里是百分号编码）
      for (const h of hits) {
        try { h.path = decodeURI(h.path); } catch (e) { /* 原样 */ }
      }
      return {
        ok: true, query, scope: 'index',
        total: hits.length,
        totalPages: docs.length,
        truncated: hits.length >= limit,
        hits,
        hint: hits.length
          ? '跳页用 site_navigate(to="page", path=…)，需要节内定位再加 hash'
          : '索引里没有匹配的标题/小节；试试换个词，或用 site_index 看全站结构',
      };
    }).catch((e) => ({
      ok: false, reason: 'index_unavailable',
      detail: String((e && e.message) || e),
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
  function siteIndex(o) {
    const opt = o || {};
    const scope = opt.scope === 'all' ? 'all' : 'course';
    const max = Math.max(1, Number(opt.max) || (scope === 'all' ? 140 : 60));

    const navData = navStructure();
    if (!navData) {
      return { ok: false, reason: 'no_sidebar', hint: '本页没有侧栏导航数据（#nav-structure-json 缺失或损坏）' };
    }

    // JSON 节点 → site_index 输出形态：组节点带 indexHref（若有）作 path，叶子带 href。
    const toNode = (n) => {
      const isGroup = !!(n.children && n.children.length);
      const node = { name: n.label, depth: n.depth };
      if (isGroup) {
        if (n.indexHref) node.path = n.indexHref;
        node.children = n.children.map(toNode);
      } else if (n.href) {
        node.path = n.href;
      }
      return node;
    };
    const nodes = navData.nodes.map(toNode);

    // 当前课程：从 body[data-site-path] 取第二段
    const body = (doc && doc.body) || null;
    const curPath = body && body.getAttribute ? (body.getAttribute('data-site-path') || '') : '';
    const curCourse = curPath.split('/')[1] || '';

    // 找「课程总览」子树，再按课程名筛选
    const coursesNode = nodes.find((n) => n.name === '课程总览');
    let picked = nodes;
    if (scope === 'course' && coursesNode && coursesNode.children) {
      const only = coursesNode.children.find((n) => n.name === curCourse);
      picked = only ? [only] : nodes;
    }

    // 同时把「其余课程入口」告诉模型（一行提示，不展开）
    const allCourses = (coursesNode && coursesNode.children ? coursesNode.children : [])
      .map((n) => n.name);

    // 渲染成人能读也机器能读的缩进文本
    const lines = [];
    const flatten = (arr, indent) => {
      for (const n of arr) {
        if (lines.length >= max) { lines.push(indent + '…（已达上限）'); return; }
        if (n.children && n.children.length) {
          lines.push(indent + n.name + (n.path ? '  `' + n.path + '`' : ''));
          flatten(n.children, indent + '  ');
        } else {
          lines.push(indent + '- ' + n.name + (n.path ? '  `' + n.path + '`' : ''));
        }
      }
    };
    flatten(picked, '');

    return {
      ok: true,
      scope,
      current: { path: curPath, course: curCourse },
      courses: allCourses,
      totalNodes: countNodes(nodes),
      shown: lines.length,
      text: lines.join('\n'),
      hint: scope === 'course'
        ? '这是当前课程的全部页面。要看别的课：site_index(scope="all")，或 site_navigate(to="page", path="课程/<课名>/index.html")'
        : '全站导航树。跳页用 site_navigate(to="page", path=…)',
    };
  }

  function countNodes(arr) {
    let n = 0;
    for (const x of arr) { n += 1; if (x.children) n += countNodes(x.children); }
    return n;
  }

  /**
   * 列出本页图片（正文内的，不含站点头像）。
   * 学习通只收 jpg/png，而本站配图是 webp——模型必须知道「这页有哪些图、是什么格式」。
   */
  function listImages(o) {
    const opt = o || {};
    const includeIcons = !!opt.includeIcons;
    const max = Math.max(1, Number(opt.max) || 50);
    const out = [];
    for (const el of all(S.articleImages)) {
      const src = String((el.getAttribute && el.getAttribute('src')) || '');
      if (!src) continue;
      if (!includeIcons && /assets\/favicon|site-title-icon/.test(src)) continue;
      const ext = (src.split('?')[0].match(/\.([a-z0-9]+)$/i) || [])[1] || '';
      let abs = src;
      try { abs = new URL(src, location.href).href; } catch (e) { /* 相对原样 */ }
      let box = null;
      try {
        if (el.getBoundingClientRect) {
          const r = el.getBoundingClientRect();
          box = { top: Math.round(r.top + (win ? win.scrollY || 0 : 0)), w: Math.round(r.width), h: Math.round(r.height) };
        }
      } catch (e) { /* 无布局 */ }
      out.push({
        index: out.length,
        src, abs, ext: ext.toLowerCase(),
        alt: (el.getAttribute && el.getAttribute('alt')) || '',
        natural: el.naturalWidth ? { w: el.naturalWidth, h: el.naturalHeight } : undefined,
        box: box || undefined,
        // 学习通能直接收的格式；webp/jxl/avif/gif 都要先转
        uploadable: /^(jpe?g|png)$/i.test(ext),
      });
      if (out.length >= max) break;
    }
    const needConvert = out.filter((x) => !x.uploadable).length;
    return {
      ok: true, total: out.length, needConvert, images: out,
      hint: needConvert
        ? '有 ' + needConvert + ' 张不是 jpg/png（学习通只收这两种），先调 site_image 用 index 转成 jpeg 再上传'
        : '全部可直接上传',
    };
  }

  /**
   * 把一张页面图片转成 JPEG/PNG 的 dataURL（浏览器 canvas 解码）。
   *
   * 为什么必须在页面里做：本站配图是 webp（学习通不收），转换要在能解码 webp 的
   * 环境里完成——浏览器原生支持，Node 侧还要装编码器。图片同源、无 CSP，
   * canvas 不会被污染，toDataURL 可直接取像素。
   *
   * @param {object} o
   * @param {number} [o.index]    listImages 的下标（与 src 二选一）
   * @param {string} [o.src]      图片地址（相对或绝对）
   * @param {string} [o.format]   'jpeg'（默认）| 'png'
   * @param {number} [o.quality]  1-100，默认 82（学习通实测 59KB JPEG 稳过、266KB PNG 被拦）
   * @param {number} [o.maxWidth] 超过则等比缩小，默认 1400
   * @param {number} [o.maxBytes] 目标体积上限（默认 120000）——超了自动降质量重编
   */
  function imageToDataUrl(o) {
    const opt = o || {};
    const w = win || {};
    const format = opt.format === 'png' ? 'png' : 'jpeg';
    const mime = format === 'png' ? 'image/png' : 'image/jpeg';
    const quality = Math.max(1, Math.min(100, Number(opt.quality) || 82));
    const maxWidth = Math.max(64, Number(opt.maxWidth) || 1400);
    const maxBytes = Math.max(1000, Number(opt.maxBytes) || 120000);

    // 定位图片元素
    let src = String(opt.src || '').trim();
    if (!src && opt.index !== undefined && opt.index !== null) {
      const list = all(S.articleImages).filter((el) => {
        const s = String((el.getAttribute && el.getAttribute('src')) || '');
        return s && !/assets\/favicon|site-title-icon/.test(s);
      });
      const el = list[Number(opt.index)];
      if (!el) return Promise.resolve({ ok: false, reason: 'index_out_of_range', total: list.length });
      src = String(el.getAttribute('src'));
    }
    if (!src) return Promise.resolve({ ok: false, reason: 'empty_src', hint: '给 index（先用 site_list_images 取）或 src' });
    let abs = src;
    try { abs = new URL(src, location.href).href; } catch (e) { /* 相对原样 */ }

    const Ctor = w.Image || (typeof Image !== 'undefined' ? Image : null);
    const canvas = (w.document && w.document.createElement)
      ? w.document.createElement('canvas')
      : (doc.createElement ? doc.createElement('canvas') : null);
    if (!Ctor || !canvas || !canvas.getContext) {
      return Promise.resolve({
        ok: false, reason: 'canvas_unavailable',
        hint: '当前环境不能解码图片：需要浏览器 canvas（扩展/Playwright 里可用）',
      });
    }

    return new Promise((resolve) => {
      const img = new Ctor();
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const setT = w.setTimeout ? w.setTimeout : setTimeout;
      const clrT = w.clearTimeout ? w.clearTimeout : clearTimeout;
      const timer = setT(() => done({ ok: false, reason: 'image_timeout', src: abs }), 20000);

      img.onerror = () => { clrT(timer); done({ ok: false, reason: 'image_load_failed', src: abs }); };
      img.onload = () => {
        try {
          const nw = img.naturalWidth || img.width || 0;
          const nh = img.naturalHeight || img.height || 0;
          const scale = nw > maxWidth ? maxWidth / nw : 1;
          const cw = Math.max(1, Math.round(nw * scale));
          const ch = Math.max(1, Math.round(nh * scale));
          canvas.width = cw;
          canvas.height = ch;
          const ctx = canvas.getContext('2d');
          // JPEG 不支持透明：先铺白底，否则透明区会变黑
          if (format === 'jpeg') {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, cw, ch);
          }
          ctx.drawImage(img, 0, 0, cw, ch);

          // 体积控制：超上限就逐档降质量（最低 40）
          let q = quality;
          let dataUrl = canvas.toDataURL(mime, q / 100);
          let bytes = Math.round(((dataUrl.split(',')[1] || '').length) * 3 / 4);
          let tries = 0;
          while (bytes > maxBytes && format === 'jpeg' && q > 40 && tries < 6) {
            q = Math.max(40, q - 12);
            dataUrl = canvas.toDataURL(mime, q / 100);
            bytes = Math.round(((dataUrl.split(',')[1] || '').length) * 3 / 4);
            tries += 1;
          }
          clrT(timer);
          done({
            ok: true, src: abs, format, mimeType: mime,
            width: cw, height: ch,
            originalWidth: nw, originalHeight: nh,
            resized: scale < 1,
            quality: format === 'jpeg' ? q : null,
            bytes, dataUrl,
            overLimit: bytes > maxBytes,
          });
        } catch (e) {
          clrT(timer);
          done({ ok: false, reason: 'convert_failed', detail: String((e && e.message) || e), src: abs });
        }
      };
      // 同源图不需要 crossOrigin；设了反而在部分环境触发 CORS 预检
      try { img.src = abs; } catch (e) {
        clrT(timer);
        done({ ok: false, reason: 'image_load_failed', detail: String(e.message || e), src: abs });
      }
    });
  }

  return {
    headings, pageInfo, openSection, togglePanels, findSymbol, listSymbols, glossaryDict,
    searchResults, searchUi, captureView,
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
  const w = win || (doc && doc.defaultView) || null;
  const view = createPageView(doc, null, w);

  return [
    {
      name: 'site_get_page_info',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: '我在哪：当前页标题、所属课程、URL、小节清单（含锚点）、当前高亮目录项、折叠面板开合数、显示设置（主题/色相/侧栏）、阅读进度。',
      inputSchema: { type: 'object', properties: {} },
      execute: () => view.pageInfo(),
    },
    {
      name: 'site_read',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: '读页面内容（Markdown）。what=page 读整页正文（长页用 offset+maxChars 分页，返回带 total_chars/offset/limit/has_more，按 has_more 继续翻）；outline 只列小节标题；section 读某一节（给 query 标题片段；找不到时返回 candidates 供重试）；panel 读某个折叠面板；symbols 列出本页所有可查符号。',
      inputSchema: {
        type: 'object',
        properties: {
          what: { type: 'string', enum: ['page', 'outline', 'section', 'panel', 'symbols'] },
          query: { type: 'string' },
          maxChars: { type: 'number', description: '单次返回上限（默认 8000，硬上限 12000）' },
          offset: { type: 'number', description: '字符偏移（默认 0）。长页分页：先读 0，看 has_more 再按 offset 续读' },
          includeCollapsed: { type: 'boolean' },
          links: { type: 'boolean' },
        },
      },
      execute: (a) => view.readContent(a || {}),
    },
    {
      name: 'site_index',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: '站点地图：从页内烘焙的侧栏形状返回层级结构（课程 → 分类 → 页面，带路径）。默认给当前课程的全部页面；scope="all" 给全站。先看地图，再决定读哪页。',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['course', 'all'] },
          max: { type: 'number' },
        },
      },
      execute: (a) => view.siteIndex(a || {}),
    },
    {
      name: 'site_navigate',
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
        const q = String((a && a.query) || '').trim();
        if (!q) return { ok: false, reason: 'empty_query' };
        // scope=page：页内查找（Ctrl+F 语义）
        if ((a && a.scope) === 'page') return view.findInPage(q);
        // scope=site（默认）：**直读 search/index.json**，不开搜索框。
        // 2026-10-19 用户定案：「搜索框明显是给人类用的」——模型要的是结果+链接+锚点。
        return view.searchIndex(q, { limit: a && a.limit, includeHeadings: true });
      },
    },
    {
      name: 'site_show_symbol',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: '查本页某个符号的含义：点开它的气泡，返回标题、解释、全部义项（当前语境标 is-here）与「详细」链接。给 term 可用符号 id（如 sym-U）或显示文字（如 U）。',
      inputSchema: { type: 'object', properties: { term: { type: 'string' } }, required: ['term'] },
      execute: (a) => {
        const needle = String((a && a.term) || '').trim();
        if (!needle) return { ok: false, reason: 'empty_term' };
        const el = view.findSymbol(needle);
        if (!el) {
          const all = view.listSymbols(200);
          return { ok: false, reason: 'symbol_not_on_page', total: all.length, available: all.slice(0, 40) };
        }
        try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* 无滚动不影响点击 */ }
        // 走与真人点击同一条路径（气泡脚本监听 click）。
        const win2 = w || {};
        const ClickEvent = win2.MouseEvent || (typeof MouseEvent !== 'undefined' ? MouseEvent : null);
        if (ClickEvent) {
          el.dispatchEvent(new ClickEvent('click', { bubbles: true, cancelable: true, view: win2 }));
        } else if (el.click) {
          el.click();
        }
        // **气泡是异步渲染的**（点击后下一拍才进 DOM）——同步读会恒空。
        // 用 renderMarkdown 而不是 textContent：气泡里也嵌 KaTeX，
        // textContent 会给出三份副本（实测「BBB：磁通密度…B=μHB=\mu HB=μH」）。
        const read = () => {
          let bubble = null;
          try { bubble = doc.querySelector(PAGE_SELECTORS.glossaryBubble); } catch (e) { /* 假 DOM */ }
          const senses = [];
          if (bubble && bubble.querySelectorAll) {
            try {
              Array.prototype.slice.call(bubble.querySelectorAll('li')).forEach((li) => {
                senses.push({ text: renderMarkdown(li), here: hasClass(li, 'is-here') });
              });
            } catch (e) { /* 无子查询 */ }
          }
          const more = bubble && bubble.querySelector ? bubble.querySelector('a') : null;
          return {
            ok: true,
            term: el.getAttribute ? el.getAttribute('data-term') : needle,
            bubble: bubble ? renderMarkdown(bubble).slice(0, 1200) : '',
            senses: senses.length ? senses : undefined,
            detailHref: more && more.getAttribute ? more.getAttribute('href') : undefined,
          };
        };
        return new Promise((resolve) => {
          (win2.setTimeout ? win2.setTimeout : setTimeout)(() => resolve(read()), 250);
        });
      },
    },
    {
      name: 'site_panels',
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
        const act = (a && a.action) || 'toggle';
        const open = act === 'open' ? true : act === 'close' ? false : undefined;
        return view.togglePanels(open, a && a.match);
      },
    },
    {
      name: 'site_view',
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: '列出本页正文里的图片（下标、地址、格式、alt、尺寸、是否可直接上传）。本站配图是 webp，学习通只收 jpg/png——uploadable=false 的先用 site_image 转码。',
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: '把当前页面截成 JPEG 图片（宿主注入能力），供看不见页面的模型查看版面与图表。可给 selector 只截某个元素、或给 rect 只截一块区域。',
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
    try { Promise.resolve(mc.registerTool(d)).catch(() => {}); } catch (e) { /* 单个失败不影响其余 */ }
  }
  return attempts;
}

/**
 * 在页面里执行一个已注册的工具（阶段二 T11 新增）。
 *
 * 这是站点侧工具循环的 `invoke` 实现——T10 搬来的 `createAssistantClient`
 * 需要它把模型的工具调用落到真实页面上。
 *
 * 为什么放在本模块：它和 `registerTools` 共用同一套 `createPageView` /
 * `buildToolDefs`，是同一个 module 的两面（注册 ↔ 执行）。放在别处会造成
 * 「注册用一套、执行用另一套」——那正是探察报告里 page-bridge / roleA /
 * 页面桥.js 三份重复的成因。
 *
 * @param {Document} doc
 * @param {string} name  工具名（site_index 等）
 * @param {object} args  参数
 * @returns {Promise<{ok:boolean, value?:any, effect?:object, error?:string}>}
 *   恒 resolve——失败也回 `{ok:false, error}`，由工具循环按「失败也回喂」消费。
 */
export async function runTool(doc, name, args) {
  const view = createPageView(doc, null, null);
  // 直接调 view 的具名方法（与 buildToolDefs 里的 execute 是同一批实现）——
  // 不经 modelContext.executeTool，避免 polyfill 把异常压成
  // "Tool execution failed"（page-bridge.mjs 2026-10-19 吃过这个亏）。
  const MAP = {
    site_get_page_info: () => view.pageInfo(),
    site_read: (a) => view.readContent(a || {}),
    site_index: (a) => view.siteIndex(a || {}),
    site_navigate: (a) => view.navigate(a || {}),
    site_search: (a) => {
      const q = String((a && a.query) || '').trim();
      if (!q) return { ok: false, reason: 'empty_query' };
      if ((a && a.scope) === 'page') return view.findInPage(q);
      return view.searchIndex(q, { limit: a && a.limit, includeHeadings: true });
    },
    site_show_symbol: (a) => view.findSymbol(a || {}),
    site_panels: (a) => view.togglePanels(a || {}),
    site_view: (a) => view.setView(a || {}),
    site_list_images: (a) => view.listImages(a || {}),
    site_image: (a) => view.imageToDataUrl(a || {}),
    site_capture_view: (a) => view.captureView(a || {}),
  };
  const fn = MAP[name];
  if (!fn) return { ok: false, error: '页面没有工具 ' + String(name) };
  try {
    const value = await fn(args);
    return { ok: !(value && typeof value === 'object' && value.ok === false), value };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
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
var hasClass = ${hasClass.toString()};
var childrenOf = ${childrenOf.toString()};
var isTextNode = ${isTextNode.toString()};
var renderMarkdown = ${renderMarkdown.toString()};
var createPageView = ${createPageView.toString()};
var buildToolDefs = ${buildToolDefs.toString()};
var registerTools = ${registerTools.toString()};
// 阶段二 T11：站点侧协议栈的 invoke 入口（runTool 依赖 createPageView，已在上面）
var runTool = ${runTool.toString()};
registerTools(document, typeof navigator !== "undefined" ? navigator : null);

// 阶段二 T11：把工具执行器暴露给站点侧协议栈（assistant-bundle.js 的 invoke）。
// 为什么是 window：bundle 与 tools 是两个独立写盘的 IIFE，没有模块系统可共享。
// 为什么只暴露 runTool：注册（modelContext）已有标准接口，执行才是站点侧需要的。
window.__mcpTools = {
  runTool: function (name, args) { return runTool(document, name, args); },
};
})();`;
