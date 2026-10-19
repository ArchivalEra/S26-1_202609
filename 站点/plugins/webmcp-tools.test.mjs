/**
 * 站点工具的性质测试（2026-10-16 候选 2+5；2026-10-19 大补全扩到 8 工具）。
 *
 * **这份测试跑的就是浏览器跑的那份**：`buildToolDefs` / `createPageView` 是真函数，
 * `WEBMCP_TOOLS_JS` 由它们的 `toString()` 派生——不再是「字符串与可测版本各活各的」。
 *
 * 用**假 DOM**（只需要 `querySelectorAll` / `querySelector` / `getElementById` 这几个方法），
 * 所以不需要浏览器环境、`node --test` 直接跑。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAGE_SELECTORS, textOf, hasClass, renderMarkdown, createPageView, buildToolDefs, registerTools,
  serializeSelectors, WEBMCP_TOOLS_JS,
} from './webmcp-tools.mjs';

// ---------------------------------------------------------------- 假 DOM

/** 最小元素：支持 textContent / tagName / id / class 相关 / 父子链 / scrollIntoView。 */
function el(tag, text, props = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    textContent: text,
    _bareText: text,
    id: props.id || '',
    className: props.className || '',
    open: props.open,
    hidden: props.hidden,
    parentElement: null,
    children: [],
    _attrs: props.attrs || {},
    style: {
      _v: {},
      setProperty(k, v) { this._v[k] = v; },
      getPropertyValue(k) { return this._v[k] || ''; },
    },
    getAttribute(k) { return this._attrs[k] !== undefined ? this._attrs[k] : null; },
    setAttribute(k, v) { this._attrs[k] = v; },
    focus() { this._focused = true; },
    click() { this._clicked = true; (this._events = this._events || []).push({ type: 'click' }); },
    dispatchEvent(ev) { (this._events = this._events || []).push(ev); return true; },
    scrollIntoView() { this._scrolled = true; },
    querySelector(sel) { return matchIn(this, sel)[0] || null; },
    querySelectorAll(sel) { return matchIn(this, sel); },
  };
  node._events = [];
  // 真实 DOM 的 childNodes 含文本节点；假 DOM 用「有 children 时把它们当 childNodes，
  // 否则把 textContent 包成一个文本节点」近似——renderMarkdown 依赖这个语义。
  Object.defineProperty(node, 'childNodes', {
    get() {
      if (this._childNodes) return this._childNodes;
      if (this.children && this.children.length) return this.children;
      if (this._bareText) return [{ nodeType: 3, textContent: this._bareText }];
      return [];
    },
    set(v) { this._childNodes = v; },
  });
  node.classList = {
    add(c) { if (!hasClass(node, c)) node.className = (node.className ? node.className + ' ' : '') + c; },
    remove(c) {
      node.className = String(node.className).split(/\s+/).filter((x) => x && x !== c).join(' ');
    },
    contains(c) { return hasClass(node, c); },
  };
  return node;
}

/** 单个复合选择器（`a.sym-gloss[data-term]` / `.toc-item.active` / `h2`）的匹配。
 *  真实 DOM 的复合语义：tag + 任意个 .class + 任意个 [attr] 同时成立。 */
function matchesSimple(node, s) {
  // 拆成 tag / .class / [attr] 三段
  const tagMatch = s.match(/^([a-zA-Z][\w-]*)/);
  const tag = tagMatch ? tagMatch[1] : '';
  const classes = (s.match(/\.([\w-]+)/g) || []).map((x) => x.slice(1));
  const attrs = (s.match(/\[([^\]=]+)(?:[~*^$|]?=[^\]]*)?\]/g) || [])
    .map((x) => x.slice(1, -1).split(/[~*^$|]?=/)[0]);

  if (tag && node.tagName !== tag.toUpperCase()) return false;
  for (const c of classes) {
    if (!String(node.className).split(/\s+/).includes(c)) return false;
  }
  for (const a of attrs) {
    if (node.getAttribute(a) === null) return false;
  }
  return Boolean(tag || classes.length || attrs.length);
}

/** 选择器匹配：支持 `a, b` 并列；组内空格按**后代关系**判
 *  （`.katex [data-term]` 要求末段元素的祖先里有 `.katex`——与真实 DOM 同语义）。 */
function matches(node, sel) {
  return sel.split(',').some((one) => {
    const parts = one.trim().split(/\s+/);
    if (!matchesSimple(node, parts[parts.length - 1])) return false;
    let i = parts.length - 2;
    for (let p = node.parentElement; p && i >= 0; p = p.parentElement) {
      if (matchesSimple(p, parts[i])) i -= 1;
    }
    return i < 0;
  });
}

function flatten(root) {
  const out = [];
  (function walk(n) { for (const c of n.children || []) { out.push(c); walk(c); } })(root);
  return out;
}

function matchIn(root, sel) {
  return flatten(root).filter((n) => matches(n, sel));
}

/** 造一个像 document 的对象。 */
function fakeDoc({ title = '测试页', url = 'http://x/y.html', withSearch = true, withPaging = true } = {}) {
  const h1 = el('h1', '变压器额定电流', { id: 'h1' });
  const chip = el('span', '📚 电机学', { className: 'meta-chip primary' });
  const chip2 = el('span', '🏷️ 教材解析', { className: 'meta-chip' });
  const h2a = el('h2', '第一节', { id: 'sec-1' });
  const p1 = el('p', '第一节正文，讲变压器额定容量。');
  const h3 = el('h3', '小节 A', { id: 'sub-a' });
  const p2 = el('p', '小节 A 正文，提到铁芯损耗。');
  const h2b = el('h2', '第二节', { id: 'sec-2' });
  const p3 = el('p', '第二节正文，讲磁路。');

  const details1 = el('details', '', { open: false, id: 'panel-1' });
  const sum1 = el('summary', '折叠里的标题');
  const innerP = el('p', '折叠里的正文内容。');
  const innerH3 = el('h3', '折叠里的标题', { id: 'in-details' });
  details1.children = [sum1, innerH3, innerP];
  sum1.parentElement = details1;
  innerH3.parentElement = details1;
  innerP.parentElement = details1;

  // 真实结构：data-term 在 <a class="sym-gloss"> 上，而它在 .katex **内部**（祖先关系）
  const katex = el('span', '', { className: 'katex' });
  const annotation = el('annotation', 'U');
  const term = el('a', 'U', { className: 'sym-gloss', attrs: { 'data-term': 'sym-U' } });
  katex.children = [annotation, term];
  annotation.parentElement = katex;
  term.parentElement = katex;

  // 正文里的符号（不在 .katex 内）——2026-10-19 修：旧选择器只认公式内
  const proseTerm = el('a', 'I', { className: 'sym-gloss', attrs: { 'data-term': 'sym-I' } });

  const bubble = el('div', '电压：两点间的电位差', { className: 'sym-gloss-pop' });

  const panel = el('div', '', { id: 'search-panel', hidden: true });
  const input = el('input', '', { id: 'search-input' });
  const results = el('div', '仅显示相关度最高的 2 页（共 7 页命中）', { id: 'search-results' });
  const hitTitle = el('span', '电机学 2026-10-08', { className: 'search-hit-title' });
  const hit = el('a', '', { className: 'search-hit', attrs: { href: '课程/电机学/x.html' } });
  hit.children = [hitTitle];

  // 侧栏
  const navLink = el('a', '第二章 变压器', { className: 'drawer-nav-link', attrs: { 'data-path': '课程/电机学/第二章.html', href: '第二章.html' } });
  // 侧栏树（site_index 的数据源）：课程总览 → 电机学 → 分类 → 页面
  const mkLeaf = (label, path) => {
    const li = el('li', '', { className: 'drawer-nav-item' });
    const a = el('a', label, { className: 'drawer-nav-link', attrs: { 'data-path': path } });
    li.children = [a]; a.parentElement = li;
    return li;
  };
  const mkGroup = (label, children) => {
    const li = el('li', '', { className: 'drawer-nav-group expanded' });
    const head = el('div', '', { className: 'nav-group-header nav-header-clickable' });
    const title = el('span', label, { className: 'drawer-section-title-text' });
    head.children = [title]; title.parentElement = head;
    const wrap = el('div', '', { className: 'nav-nested-wrapper' });
    const ul = el('ul', '', { className: 'drawer-nav-list' });
    ul.children = children;
    children.forEach((c) => { c.parentElement = ul; });
    wrap.children = [ul]; ul.parentElement = wrap;
    li.children = [head, wrap]; head.parentElement = li; wrap.parentElement = li;
    return li;
  };
  const notesGroup = mkGroup('课堂笔记', [
    mkLeaf('10-08 磁路', '课程/电机学/课堂笔记/2026-10-08-磁路.html'),
  ]);
  const assignGroup = mkGroup('作业', [
    mkLeaf('作业1', '课程/电机学/作业/2026-09-28-作业1.html'),
  ]);
  const motorGroup = mkGroup('电机学', [notesGroup, assignGroup]);
  const otherCourse = mkGroup('电路原理', [mkLeaf('习题册第一章', '课程/电路原理/作业/x.html')]);
  const overviewGroup = mkGroup('课程总览', [motorGroup, otherCourse]);
  const drawerRootUl = el('ul', '', { className: 'drawer-nav-list' });
  drawerRootUl.children = [overviewGroup];
  overviewGroup.parentElement = drawerRootUl;
  const drawerArea = el('div', '', { className: 'drawer-nav-scroll-area' });
  drawerArea.children = [drawerRootUl]; drawerRootUl.parentElement = drawerArea;
  const brand = el('a', 'S26', { className: 'sidebar-brand', attrs: { href: '../index.html' } });

  // 上一节/下一节
  const prev = el('a', '上一节：第一章', { className: 'paging-card paging-prev', attrs: { href: 'prev.html' } });
  const prevTitle = el('span', '第一章 概述', { className: 'paging-title' });
  prev.children = [prevTitle];
  const next = el('a', '下一节：第三章', { className: 'paging-card paging-next', attrs: { href: 'next.html' } });
  const nextTitle = el('span', '第三章 直流电机', { className: 'paging-title' });
  next.children = [nextTitle];

  const tocActive = el('li', '第二节', { className: 'toc-item level-2 active' });
  const tocA = el('a', '第二节', { attrs: { href: '#sec-2' } });
  tocActive.children = [tocA];

  // 符号词典
  const glossJson = el('script', JSON.stringify({
    terms: { 'sym-U': { title: 'U', text: '电压', senses: [{ ctx: '电路原理', text: '电压' }, { ctx: '电机学', text: '线电压' }] } },
  }), { id: 'sym-glossary-json' });

  const article = el('div', '', { className: 'article-content' });
  article.children = [h1, chip, chip2, h2a, p1, h3, p2, h2b, p3, details1, katex, proseTerm, bubble];
  for (const c of article.children) c.parentElement = article;
  // 让 p2 与 h3 的祖先关系成立（h3 在 h2a 后）
  const all = [article, prev, next, navLink, brand, tocActive, glossJson, drawerArea];
  if (withSearch) all.push(panel, input, results, hit);
  if (withPaging) all.push(prev, next);
  // 建父子链（details 里放一个标题，测「开面板」）

  const body = el('body', '', { attrs: { 'data-site-path': '课程/电机学/教材解析/x.html' } });
  const documentElement = el('html', '', { attrs: { 'data-theme': 'light', 'data-root': '../../../' } });
  documentElement.style._v['--hue'] = '248';

  const doc = {
    title,
    body,
    documentElement,
    location: { href: url, hash: '' },
    defaultView: { setTimeout: (fn) => setTimeout(fn, 0), scrollY: 100, innerHeight: 800, innerWidth: 1200 },
    querySelectorAll(sel) { return matchIn(doc, sel); },
    querySelector(sel) { return matchIn(doc, sel)[0] || null; },
    getElementById(id) { return flatten(doc).find((n) => n.id === id) || null; },
    _all: all,
  };
  doc.children = all;
  // 把 details 的父链接上（openSection 要沿 parentElement 上溯）
  details1.parentElement = article;
  return doc;
}

// ---------------------------------------------------------------- pageInfo

test('pageInfo：标题/课程/小节清单（课程 chip 取 primary，去掉 emoji 前缀）', () => {
  const view = createPageView(fakeDoc());
  const info = view.pageInfo();
  assert.equal(info.title, '变压器额定电流');
  assert.equal(info.course, '电机学', '应取 primary chip，而不是第一个 meta-chip');
  assert.equal(info.url, 'http://x/y.html');
  assert.deepEqual(info.sections.map((s) => s.title), ['第一节', '小节 A', '第二节', '折叠里的标题'],
    '折叠面板内的标题也算小节（querySelectorAll 不看 details 开合，与真实 DOM 同）');
  assert.equal(info.sections[0].anchor, 'sec-1');
  assert.equal(info.sections[0].level, 2);
});

test('pageInfo：含当前高亮目录项、面板统计、显示设置、阅读进度', () => {
  const view = createPageView(fakeDoc());
  const info = view.pageInfo();
  assert.deepEqual(info.activeToc, { title: '第二节', anchor: 'sec-2' });
  assert.deepEqual(info.panels, { total: 1, open: 0 });
  assert.equal(info.view.theme, 'light');
  assert.equal(info.view.hue, 248);
  assert.equal(info.path, '课程/电机学/教材解析/x.html');
  assert.ok(info.position && typeof info.position.scrollPct === 'number');
});

test('pageInfo：页面无 h1 时退化到 document.title', () => {
  const doc = fakeDoc();
  doc.children[0].children = doc.children[0].children.filter((c) => c.tagName !== 'H1');
  const info = createPageView(doc).pageInfo();
  assert.equal(info.title, '测试页');
});

// ---------------------------------------------------------------- renderMarkdown

test('renderMarkdown：标题/段落/列表/粗体', () => {
  const root = el('div', '');
  const h2 = el('h2', '标题二');
  const p = el('p', '');
  const strong = el('strong', '重点');
  const pText = el('span', ' 普通文本 ');
  p.children = [strong, pText];
  strong.parentElement = p; pText.parentElement = p;
  const ul = el('ul', '');
  const li1 = el('li', '第一项');
  const li2 = el('li', '第二项');
  ul.children = [li1, li2];
  root.children = [h2, p, ul];
  const md = renderMarkdown(root);
  assert.match(md, /^## 标题二$/m);
  assert.match(md, /\*\*重点\*\*/);
  assert.match(md, /^- 第一项$/m);
  assert.match(md, /^- 第二项$/m);
});

test('renderMarkdown：表格出 Markdown 表格；代码块出围栏', () => {
  const root = el('div', '');
  const table = el('table', '');
  const tr = el('tr', '');
  const th1 = el('th', '符号');
  const th2 = el('th', '含义');
  tr.children = [th1, th2];
  const tr2 = el('tr', '');
  const td1 = el('td', 'U');
  const td2 = el('td', '电压');
  tr2.children = [td1, td2];
  table.children = [tr, tr2];
  const pre = el('pre', '');
  const code = el('code', 'console.log(1)', { className: 'language-js' });
  pre.children = [code];
  root.children = [table, pre];
  const md = renderMarkdown(root);
  assert.match(md, /\| 符号 \| 含义 \|/);
  assert.match(md, /\| --- \| --- \|/);
  assert.match(md, /```js/);
  assert.match(md, /console\.log\(1\)/);
});

test('renderMarkdown：KaTeX 用 annotation 里的 LaTeX 源（模型读公式最准）', () => {
  const root = el('div', '');
  const katex = el('span', '', { className: 'katex' });
  const annotation = el('annotation', 'R_m = \\frac{l}{\\mu A}');
  const htmlPart = el('span', 'Rm=lμA', { className: 'katex-html' });
  katex.children = [annotation, htmlPart];
  root.children = [katex];
  const md = renderMarkdown(root);
  assert.equal(md, '$R_m = \\frac{l}{\\mu A}$');
});

test('renderMarkdown：剥掉站点注入的 \\htmlData{term=…}{…} 取词包裹（2026-10-19 实测缺陷）', () => {
  const root = el('div', '');
  const katex = el('span', '', { className: 'katex' });
  const annotation = el('annotation', '\\htmlData{term=sym-p}{p}_h = \\htmlData{term=sym-k}{k}_h f');
  const htmlPart = el('span', 'ph=khf', { className: 'katex-html' });
  katex.children = [annotation, htmlPart];
  root.children = [katex];
  const md = renderMarkdown(root);
  assert.equal(md, '$p_h = k_h f$');
});

test('renderMarkdown：\\htmlData 内容里带嵌套花括号也要正确剥（\\frac 不被切坏）', () => {
  const root = el('div', '');
  const katex = el('span', '', { className: 'katex' });
  const annotation = el('annotation', '\\htmlData{term=sym-x}{\\frac{a}{b}}');
  katex.children = [annotation];
  root.children = [katex];
  assert.equal(renderMarkdown(root), '$\\frac{a}{b}$');
});

test('renderMarkdown：KaTeX 的 html 副本不重复读（实测出现 BBBHHH 与孤立 $ 行）', () => {
  const root = el('div', '');
  const p = el('p', '');
  const katex = el('span', '', { className: 'katex' });
  const annotation = el('annotation', 'B');
  const mathml = el('span', '', { className: 'katex-mathml' });
  const htmlPart = el('span', 'B', { className: 'katex-html' });
  katex.children = [annotation, mathml, htmlPart];
  const span = el('span', 'B');
  p.children = [katex, span];
  root.children = [p];
  const md = renderMarkdown(root);
  assert.equal(md, '$B$B', '公式只读一次，正文里的 B 是另一处内容');
});

test('renderMarkdown：深嵌套列表/引用不栈溢出（2026-10-19 真实页 Maximum call stack）', () => {
  // 旧实现 walk→renderMarkdown→walk 从根重来，真实页 18000 节点直接爆栈。
  let node = el('p', '最内层文字');
  for (let i = 0; i < 60; i++) {
    const ul = el('ul', '');
    const li = el('li', '');
    li.children = [node];
    node.parentElement = li;
    ul.children = [li];
    li.parentElement = ul;
    node = ul;
  }
  const md = renderMarkdown(node);
  assert.match(md, /最内层文字/);
});

test('renderMarkdown：引用块不重复整页内容（旧实现从根重来）', () => {
  const root = el('div', '');
  const h1 = el('h1', '标题一');
  const bq = el('blockquote', '');
  const p = el('p', '引用里的话');
  bq.children = [p];
  p.parentElement = bq;
  root.children = [h1, bq];
  const md = renderMarkdown(root);
  assert.match(md, /引用里的话/);
  const hits = (md.match(/# 标题一/g) || []).length;
  assert.equal(hits, 1, '标题只出现一次（不该被引用块再渲染一遍）');
});

test('renderMarkdown：折叠面板保留内容并标〔折叠〕；includeCollapsed=false 时跳过', () => {
  const doc = fakeDoc();
  const root = doc.children[0];
  const md = renderMarkdown(root);
  assert.match(md, /折叠里的正文内容/, '默认读折叠内容');
  assert.match(md, /〔折叠〕/);
  const md2 = renderMarkdown(root, { includeCollapsed: false });
  assert.doesNotMatch(md2, /折叠里的正文内容/);
});

// ---------------------------------------------------------------- openSection / togglePanels

test('openSection：按标题片段跳转（命中返回锚点）', () => {
  const view = createPageView(fakeDoc());
  const r = view.openSection('第二');
  assert.equal(r.ok, true);
  assert.equal(r.anchor, 'sec-2');
});

test('openSection：找不到时返回候选清单（不是抛错）', () => {
  const view = createPageView(fakeDoc());
  const r = view.openSection('不存在的节');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_found');
  assert.ok(r.available.includes('第一节'));
});

test('openSection：会展开目标所在的折叠面板（深链接同款行为）', () => {
  const doc = fakeDoc();
  const view = createPageView(doc);
  const det = doc.querySelector('details');
  assert.equal(det.open, false);
  view.openSection(undefined, 'in-details');
  assert.equal(det.open, true, '目标在折叠面板里 → 应自动展开');
});

test('togglePanels：能开、能关、不传参则切换', () => {
  const doc = fakeDoc();
  const view = createPageView(doc);
  const det = doc.querySelector('details');
  const r1 = view.togglePanels(true);
  assert.equal(r1.count, 1);
  assert.equal(r1.changed, 1);
  assert.equal(det.open, true);
  const r2 = view.togglePanels(false);
  assert.equal(r2.changed, 1);
  assert.equal(det.open, false);
  const r3 = view.togglePanels();
  assert.equal(r3.open, 'toggled');
  assert.equal(det.open, true);
});

test('togglePanels：match 只作用于标题匹配的面板', () => {
  const doc = fakeDoc();
  // 再加一个不匹配的 details
  const other = el('details', '', { open: false });
  const otherSum = el('summary', '另一个面板');
  other.children = [otherSum];
  otherSum.parentElement = other;
  other.parentElement = doc.children[0];
  doc.children[0].children.push(other);

  const view = createPageView(doc);
  const r = view.togglePanels(true, '折叠里的标题');
  assert.equal(r.count, 1, '只命中匹配的那个');
  assert.equal(r.state.open, 1);
  assert.equal(other.open, false, '不匹配的不动');
});

// ---------------------------------------------------------------- readContent

test('site_read：what=page 读整页 Markdown', () => {
  const doc = fakeDoc();
  const r = createPageView(doc).readContent({ what: 'page' });
  assert.equal(r.ok, true);
  assert.match(r.text, /# 变压器额定电流/);
  assert.match(r.text, /第一节正文/);
  assert.ok(r.totalChars > 0);
});

test('site_read：what=outline 只列标题', () => {
  const r = createPageView(fakeDoc()).readContent({ what: 'outline' });
  assert.equal(r.ok, true);
  assert.equal(r.count, 4, '含折叠面板内的那个标题（与真实 DOM 同）');
  assert.match(r.text, /第一节/);
  assert.doesNotMatch(r.text, /正文/);
});

test('site_read：what=section 只读那一节（含子标题）', () => {
  const doc = fakeDoc();
  const r = createPageView(doc).readContent({ what: 'section', query: '第一节' });
  assert.equal(r.ok, true);
  assert.equal(r.anchor, 'sec-1');
  assert.match(r.text, /第一节正文/);
  assert.match(r.text, /小节 A 正文/, '应含下级小节');
  assert.doesNotMatch(r.text, /第二节正文/, '不应含同级下一节');
});

test('site_read：section 读到的正文不含父级标题（线性前进不越界）', () => {
  // 2026-10-19 真实页崩过（HTMLCollection 无 indexOf）；修完后用真页复验通过。
  // 这里守的是同一条契约：从某节开始读，遇到同级标题就停，且不重复父级内容。
  const doc = fakeDoc();
  const r = createPageView(doc).readContent({ what: 'section', query: '第一节' });
  assert.equal(r.ok, true);
  assert.match(r.text, /第一节正文/);
  assert.match(r.text, /小节 A 正文/, '含下级小节');
  assert.doesNotMatch(r.text, /第二节正文/, '不含同级下一节');
  assert.doesNotMatch(r.text, /变压器额定电流/, '不含页面 h1（父级标题）');
});

test('site_read：what=section 找不到给候选', () => {
  const r = createPageView(fakeDoc()).readContent({ what: 'section', query: '不存在' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_found');
  assert.ok(r.available.length >= 3);
});

test('site_read：what=panel 读折叠面板', () => {
  const r = createPageView(fakeDoc()).readContent({ what: 'panel', query: '折叠里的标题' });
  assert.equal(r.ok, true);
  assert.match(r.text, /折叠里的正文内容/);
});

test('site_read：what=symbols 列出本页可查符号（公式内与正文里都算）', () => {
  const r = createPageView(fakeDoc()).readContent({ what: 'symbols' });
  assert.equal(r.ok, true);
  const ids = r.symbols.map((s) => s.id);
  assert.ok(ids.includes('sym-U'), '公式内的符号');
  assert.ok(ids.includes('sym-I'), '正文里的符号（2026-10-19 修：旧选择器漏掉）');
});

test('site_read：maxChars 截断并标记', () => {
  const r = createPageView(fakeDoc()).readContent({ what: 'page', maxChars: 20 });
  assert.equal(r.truncated, true);
  assert.equal(r.text.length, 20);
  assert.ok(r.totalChars > 20);
});

// ---------------------------------------------------------------- findInPage

test('site_find：页内查找返回片段与所在小节', () => {
  const r = createPageView(fakeDoc()).findInPage('铁芯损耗');
  assert.equal(r.ok, true);
  assert.ok(r.total >= 1);
  assert.equal(r.hits[0].section, '小节 A');
  assert.match(r.hits[0].snippet, /铁芯损耗/);
});

test('site_find：查不到返回 0 条（不报错）', () => {
  const r = createPageView(fakeDoc()).findInPage('完全不存在');
  assert.equal(r.ok, true);
  assert.equal(r.total, 0);
});

// ---------------------------------------------------------------- navigate

test('site_navigate：prev/next 点分页卡并回报目标', () => {
  const doc = fakeDoc();
  const view = createPageView(doc);
  const prev = view.navigate({ to: 'prev' });
  assert.equal(prev.ok, true);
  assert.equal(prev.title, '第一章 概述');
  assert.ok(doc.querySelector('a.paging-prev')._clicked);
});

test('site_navigate：link 点侧栏页并回报 data-path', () => {
  const doc = fakeDoc();
  const r = createPageView(doc).navigate({ to: 'link', query: '第二章' });
  assert.equal(r.ok, true);
  assert.equal(r.path, '课程/电机学/第二章.html');
});

test('site_navigate：link 找不到给候选清单', () => {
  const r = createPageView(fakeDoc()).navigate({ to: 'link', query: '不存在' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_found');
  assert.ok(r.available.includes('第二章 变压器'));
});

test('site_navigate：page 走 SPA 路由（若页面暴露 __spaRouter）', () => {
  const doc = fakeDoc();
  const seen = [];
  doc.defaultView.__spaRouter = { navigate: (...a) => seen.push(a) };
  // 2026-10-19 起 page 分支会做侧栏校验：路径必须在该页的 data-path 里。
  // 夹具里那条侧栏链接就是合法目标。
  const r = createPageView(doc).navigate({ to: 'page', path: '课程/电机学/第二章.html', hash: 'sec-1' });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'spa');
  assert.equal(seen.length, 1);
});

test('site_navigate：索引页即使不在侧栏也放行（build.mjs 定案：group 无链接）', () => {
  const doc = fakeDoc();
  const seen = [];
  doc.defaultView.__spaRouter = { navigate: (...a) => seen.push(a) };
  const r = createPageView(doc).navigate({ to: 'page', path: '课程/电机学/index.html' });
  assert.equal(r.ok, true, '索引页应放行');
  assert.equal(r.verified, false, '但要标出未经侧栏校验');
});

test('site_navigate：page 路径不在侧栏时报 not_in_nav 并给同课程候选', () => {
  const doc = fakeDoc();
  doc.defaultView.__spaRouter = { navigate: () => {} };
  doc.body._attrs['data-site-path'] = '课程/电机学/教材解析/x.html';
  const r = createPageView(doc).navigate({ to: 'page', path: '课程/电机学/不存在.html' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_in_nav');
  assert.ok(r.candidates.includes('课程/电机学/第二章.html'), '要给同课程的合法路径');
});

// ---------------------------------------------------------------- setView

test('site_view：切明暗主题并写 localStorage', () => {
  const doc = fakeDoc();
  const store = {};
  doc.defaultView.localStorage = { setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } };
  const r = createPageView(doc).setView({ theme: 'dark' });
  assert.equal(r.ok, true);
  assert.equal(r.state.theme, 'dark');
  assert.equal(store.theme, 'dark');
});

test('site_view：改色相并夹在 0-360', () => {
  const doc = fakeDoc();
  const r = createPageView(doc).setView({ hue: 999 });
  assert.equal(r.hue, 360);
  assert.equal(doc.documentElement.style._v['--hue'], '360');
});

test('site_view：什么都不给时明确报 nothing_to_do（不静默成功）', () => {
  const r = createPageView(fakeDoc()).setView({});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'nothing_to_do');
  assert.ok(r.state, '仍回报当前状态');
});

// ---------------------------------------------------------------- search

test('searchResults：读 DOM 的命中与总数（认「共 N 页命中」文案）', () => {
  const view = createPageView(fakeDoc());
  const r = view.searchResults();
  assert.equal(r.total, 7);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].title, '电机学 2026-10-08');
});

// ---------------------------------------------------------------- 工具清单

test('buildToolDefs：十一个工具、名字与 schema 齐备', () => {
  const defs = buildToolDefs(fakeDoc());
  assert.deepEqual(defs.map((d) => d.name), [
    'site_get_page_info', 'site_read', 'site_index', 'site_navigate', 'site_search',
    'site_show_symbol', 'site_panels', 'site_view',
    'site_list_images', 'site_image', 'site_capture_view',
  ]);
  for (const d of defs) {
    assert.ok(d.description && d.description.length > 10, `${d.name} 缺 description`);
    assert.equal(d.inputSchema.type, 'object');
    assert.equal(typeof d.execute, 'function');
  }
});

test('site_get_page_info.execute：直接返回页面事实', async () => {
  const defs = buildToolDefs(fakeDoc());
  const info = await defs[0].execute();
  assert.equal(info.title, '变压器额定电流');
  assert.ok(info.sections.length >= 3);
});

test('site_read.execute：默认 what=page', async () => {
  const defs = buildToolDefs(fakeDoc());
  const r = await defs[1].execute({});
  assert.equal(r.ok, true);
  assert.equal(r.what, 'page');
});

test('site_navigate.execute：默认 to=section', async () => {
  const defs = buildToolDefs(fakeDoc());
  const r = await defs[3].execute({ query: '第二' });
  assert.equal(r.ok, true);
  assert.equal(r.anchor, 'sec-2');
});

test('site_panels.execute：action=open 生效', async () => {
  const doc = fakeDoc();
  const defs = buildToolDefs(doc);
  const r = await defs[6].execute({ action: 'open' });
  assert.equal(r.open, true);
  assert.equal(doc.querySelector('details').open, true);
});

test('site_view.execute：只给 theme 也能改', async () => {
  const doc = fakeDoc();
  const defs = buildToolDefs(doc);
  const r = await defs[7].execute({ theme: 'dark' });
  assert.equal(r.ok, true);
  assert.equal(r.state.theme, 'dark');
});

// ---------------------------------------------------------------- 图片（webp → jpeg）

/** 给假 doc 挂两张正文图：一张 webp（要转）、一张 png（可直接传）。 */
function withImages(doc) {
  const article = doc.children[0];
  const w1 = el('img', '', { attrs: { src: 'figures/fig-1.1.webp?v=1', alt: '图 1.1：并联电路' } });
  w1.naturalWidth = 800; w1.naturalHeight = 600;
  w1.getBoundingClientRect = () => ({ top: 300, left: 0, width: 800, height: 600 });
  const w2 = el('img', '', { attrs: { src: 'figures/fig-1.2.png', alt: '图 1.2' } });
  w2.naturalWidth = 400; w2.naturalHeight = 300;
  w2.getBoundingClientRect = () => ({ top: 900, left: 0, width: 400, height: 300 });
  const icon = el('img', '', { attrs: { src: '../../../assets/favicon/brand.gif', alt: '' } });
  article.children.push(w1, w2, icon);
  w1.parentElement = article; w2.parentElement = article; icon.parentElement = article;
  return { w1, w2, icon };
}

test('site_list_images：列出正文图，标出哪些要转码（webp 不可直传）', async () => {
  const doc = fakeDoc();
  withImages(doc);
  const defs = buildToolDefs(doc);
  const r = await defs[8].execute({});
  assert.equal(r.ok, true);
  assert.equal(r.total, 2, '站点头像不算正文图');
  assert.equal(r.needConvert, 1, 'webp 那张要转');
  const webp = r.images.find((x) => x.ext === 'webp');
  assert.equal(webp.uploadable, false);
  assert.match(webp.alt, /图 1.1/);
  assert.deepEqual(webp.natural, { w: 800, h: 600 });
  const png = r.images.find((x) => x.ext === 'png');
  assert.equal(png.uploadable, true);
  assert.match(r.hint, /转成 jpeg/);
});

test('site_list_images：includeIcons 时把站点头像也列上', async () => {
  const doc = fakeDoc();
  withImages(doc);
  const r = await buildToolDefs(doc)[8].execute({ includeIcons: true });
  assert.equal(r.total, 3);
});

test('site_image：环境无 canvas 时明确报 canvas_unavailable（不假装成功）', async () => {
  const doc = fakeDoc();
  withImages(doc);
  const r = await buildToolDefs(doc)[9].execute({ index: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'canvas_unavailable');
});

test('site_image：index 越界时报 index_out_of_range 并给总数', async () => {
  const doc = fakeDoc();
  withImages(doc);
  const r = await buildToolDefs(doc)[9].execute({ index: 99 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'index_out_of_range');
  assert.equal(r.total, 2);
});

test('site_image：不给 index/src 时报 empty_src 并提示先用 site_list_images', async () => {
  const doc = fakeDoc();
  const r = await buildToolDefs(doc)[9].execute({});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty_src');
  assert.match(r.hint, /site_list_images/);
});

test('site_image：真 canvas 路径——webp 解码后出 JPEG dataUrl，超宽自动缩', async () => {
  const doc = fakeDoc();
  withImages(doc);
  // 造最小 canvas / Image：只实现被测逻辑用到的方法
  const calls = [];
  const fakeCanvas = {
    width: 0, height: 0,
    getContext() {
      return {
        fillStyle: '', fillRect() {}, drawImage(img, x, y, w, h) { calls.push({ w, h }); },
      };
    },
    toDataURL(mime, q) {
      calls.push({ mime, q });
      // 600 字节 payload（base64 长 800）
      return 'data:' + mime + ';base64,' + 'A'.repeat(800);
    },
  };
  const w = {
    setTimeout, clearTimeout,
    document: { createElement: () => fakeCanvas },
    Image: class {
      constructor() { this.naturalWidth = 0; this.naturalHeight = 0; }
      set src(v) { this._src = v; this.naturalWidth = 2000; this.naturalHeight = 1000; this.onload(); }
      get src() { return this._src; }
    },
  };
  const r = await buildToolDefs(doc, w)[9].execute({ index: 0, maxWidth: 1000, quality: 82 });
  assert.equal(r.ok, true);
  assert.equal(r.mimeType, 'image/jpeg');
  assert.equal(r.width, 1000, '2000 宽 → 限到 1000');
  assert.equal(r.height, 500, '等比');
  assert.equal(r.resized, true);
  assert.equal(r.quality, 82);
  assert.equal(r.bytes, 600);
  assert.ok(calls.some((c) => c.mime === 'image/jpeg'));
});

test('site_image：体积超 maxBytes 时逐档降质量', async () => {
  const doc = fakeDoc();
  withImages(doc);
  const qs = [];
  const fakeCanvas = {
    width: 0, height: 0,
    getContext() { return { fillStyle: '', fillRect() {}, drawImage() {} }; },
    toDataURL(mime, q) {
      qs.push(q);
      // 质量越低体积越小：q=0.82 → 8000 字节，降到 0.7 以下才合格
      const size = q > 0.7 ? 1600 : 400;
      return 'data:' + mime + ';base64,' + 'A'.repeat(size);
    },
  };
  const w = {
    setTimeout, clearTimeout,
    document: { createElement: () => fakeCanvas },
    Image: class {
      set src(v) { this.naturalWidth = 400; this.naturalHeight = 300; this.onload(); }
    },
  };
  const r = await buildToolDefs(doc, w)[9].execute({ index: 0, maxBytes: 1000 });
  assert.equal(r.ok, true);
  assert.ok(qs.length > 1, '应重编多次');
  assert.ok(r.quality < 82, '质量应降过');
  assert.equal(r.overLimit, false);
});

test('site_image：图片加载失败时报 image_load_failed（不返回空图）', async () => {
  const doc = fakeDoc();
  withImages(doc);
  const fakeCanvas = { width: 0, height: 0, getContext() { return {}; }, toDataURL() { return ''; } };
  const w = {
    setTimeout, clearTimeout,
    document: { createElement: () => fakeCanvas },
    Image: class {
      set src(v) { this.onerror(); }
    },
  };
  const r = await buildToolDefs(doc, w)[9].execute({ index: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'image_load_failed');
});

test('site_capture_view：给 selector 时走区域截图（不依赖宿主整屏能力）', async () => {
  const doc = fakeDoc();
  const article = doc.children[0];
  article.getBoundingClientRect = () => ({ top: 0, left: 0, width: 800, height: 600 });
  article.cloneNode = () => ({ outerHTML: '<div class="article-content">正文</div>' });
  const fakeCanvas = {
    width: 0, height: 0,
    getContext() { return { fillStyle: '', fillRect() {}, drawImage() {} }; },
    toDataURL(mime) { return 'data:' + mime + ';base64,' + 'A'.repeat(400); },
  };
  const w = {
    setTimeout, clearTimeout,
    document: { createElement: () => fakeCanvas },
    Image: class { set src(v) { this.onload(); } },
  };
  const r = await buildToolDefs(doc, w)[10].execute({ selector: '.article-content' });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'region');
  assert.equal(r.selector, '.article-content');
  assert.equal(r.width, 800);
});

test('site_capture_view：selector 不存在时报 selector_not_found', async () => {
  const doc = fakeDoc();
  const r = await buildToolDefs(doc)[10].execute({ selector: '.不存在' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'selector_not_found');
});

// ---------------------------------------------------------------- site_index

test('site_index：默认给当前课程（从 body[data-site-path] 判）', async () => {
  const doc = fakeDoc();
  doc.body._attrs['data-site-path'] = '课程/电机学/课堂笔记/x.html';
  const r = await buildToolDefs(doc)[2].execute({});
  assert.equal(r.ok, true);
  assert.equal(r.scope, 'course');
  assert.equal(r.current.course, '电机学');
  assert.match(r.text, /电机学/);
  assert.match(r.text, /课堂笔记/);
  assert.match(r.text, /课程\/电机学\/课堂笔记\/2026-10-08-磁路\.html/);
  assert.doesNotMatch(r.text, /习题册第一章/, '不该混进别的课');
});

test('site_index：scope=all 给全站树（含其他课程）', async () => {
  const doc = fakeDoc();
  doc.body._attrs['data-site-path'] = '课程/电机学/x.html';
  const r = await buildToolDefs(doc)[2].execute({ scope: 'all' });
  assert.equal(r.scope, 'all');
  assert.match(r.text, /电机学/);
  assert.match(r.text, /电路原理/, '全站应含别的课');
});

test('site_index：列出全部课程名（供跨课程发现）', async () => {
  const r = await buildToolDefs(fakeDoc())[2].execute({});
  assert.deepEqual(r.courses, ['电机学', '电路原理']);
});

test('site_index：没有侧栏时报 no_sidebar（不返回空树假装成功）', async () => {
  const doc = fakeDoc();
  doc.children = doc.children.filter((c) => c !== doc._all.find((x) => x.className === 'drawer-nav-scroll-area'));
  const r = await buildToolDefs(doc)[2].execute({});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_sidebar');
});

// ---------------------------------------------------------------- links 开关

test('renderMarkdown：links 默认关，链接只留文字', () => {
  const root = el('div', '');
  const p = el('p', '');
  const a = el('a', '第二章', { attrs: { href: '课程/电机学/第二章.html' } });
  p.children = [a]; a.parentElement = p;
  root.children = [p];
  assert.equal(renderMarkdown(root), '第二章');
});

test('renderMarkdown：links=true 时站内链接出 [文字](路径)', () => {
  const root = el('div', '');
  const p = el('p', '');
  const a = el('a', '第二章', { attrs: { href: '课程/电机学/第二章.html' } });
  p.children = [a]; a.parentElement = p;
  root.children = [p];
  assert.equal(renderMarkdown(root, { links: true }), '[第二章](课程/电机学/第二章.html)');
});

test('renderMarkdown：百分号编码的站内链接解码成可读中文（2026-10-19 实测）', () => {
  const root = el('div', '');
  const p = el('p', '');
  const a = el('a', '课程索引', { attrs: { href: './%E5%B7%A5%E7%A8%8B%E6%95%B0%E5%AD%A6/index.html' } });
  p.children = [a]; a.parentElement = p;
  root.children = [p];
  const md = renderMarkdown(root, { links: true });
  assert.match(md, /\[课程索引\]\(\.\/工程数学\/index\.html\)/);
});

test('renderMarkdown：links=true 时外链加 ⧉ 标记、锚点保留 #', () => {
  const root = el('div', '');
  const p1 = el('p', '');
  const ext = el('a', '官网', { attrs: { href: 'https://example.com' } });
  p1.children = [ext]; ext.parentElement = p1;
  const p2 = el('p', '');
  const anc = el('a', '见本节', { attrs: { href: '#sec-1' } });
  p2.children = [anc]; anc.parentElement = p2;
  root.children = [p1, p2];
  const md = renderMarkdown(root, { links: true });
  assert.match(md, /⧉\[官网\]\(https:\/\/example\.com\)/);
  assert.match(md, /\[见本节\]\(#sec-1\)/);
});

test('site_read：links 参数透传到 renderMarkdown', async () => {
  const doc = fakeDoc();
  const article = doc.children[0];
  const p = el('p', '');
  const a = el('a', '第二章', { attrs: { href: '课程/电机学/第二章.html' } });
  p.children = [a]; a.parentElement = p;
  article.children.push(p); p.parentElement = article;
  const r = await buildToolDefs(doc)[1].execute({ what: 'page', links: true });
  assert.match(r.text, /\[第二章\]\(课程\/电机学\/第二章\.html\)/);
});

test('site_capture_view：宿主未注入能力时明确报错（不静默、不假成功）', async () => {
  const defs = buildToolDefs(fakeDoc());
  const r = await defs[10].execute({});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'capture_unavailable');
  assert.ok(r.hint && r.hint.length > 10, '要告诉宿主该注入什么');
  assert.ok(r.alternatives && r.alternatives.selector, '要给可执行的替代方案（区域截图）');
  assert.ok(r.url && r.title, '即使失败也回页面元信息，宿主日志能定位');
});

test('site_capture_view：有宿主能力时透传参数并回 JPEG dataUrl', async () => {
  const doc = fakeDoc();
  const seen = [];
  const win = {
    innerWidth: 390, innerHeight: 844, scrollY: 120,
    __siteCapture: (opts) => {
      seen.push(opts);
      return Promise.resolve({
        dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(400),
        mimeType: 'image/jpeg', width: 390, height: 844,
      });
    },
  };
  const defs = buildToolDefs(doc, win);
  const r = await defs[10].execute({ format: 'jpeg', quality: 70, reason: '看版面' });
  assert.equal(r.ok, true);
  assert.equal(r.mimeType, 'image/jpeg');
  assert.ok(r.dataUrl.startsWith('data:image/jpeg;base64,'));
  assert.equal(r.width, 390);
  assert.equal(r.height, 844);
  assert.equal(r.bytes, 300, 'base64 长度 400 ⇒ 约 300 字节');
  assert.equal(r.reason, '看版面');
  assert.equal(r.viewport.w, 390);
  assert.equal(seen[0].format, 'jpeg');
  assert.equal(seen[0].quality, 70);
  assert.equal(seen[0].meta.scrollY, 120);
});

test('site_capture_view：宿主抛错/回空都收敛成 ok:false（不把异常漏给模型）', async () => {
  const doc = fakeDoc();
  const boom = buildToolDefs(doc, { innerWidth: 1, innerHeight: 1, __siteCapture: () => { throw new Error('quota'); } });
  const r1 = await boom[10].execute({});
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'capture_error');
  assert.ok(r1.detail.includes('quota'));

  const empty = buildToolDefs(doc, { innerWidth: 1, innerHeight: 1, __siteCapture: () => Promise.resolve({}) });
  const r2 = await empty[10].execute({});
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'capture_failed');
});

test('site_navigate.execute：按锚点跳', async () => {
  const defs = buildToolDefs(fakeDoc());
  const r = await defs[3].execute({ to: 'section', anchor: 'sec-1' });
  assert.equal(r.ok, true);
  assert.equal(r.anchor, 'sec-1');
});

test('site_search.execute：空查询报 empty_query；无面板报 search_ui_missing', async () => {
  const a = await buildToolDefs(fakeDoc())[4].execute({ query: '  ' });
  assert.deepEqual(a, { ok: false, reason: 'empty_query' });
  const b = await buildToolDefs(fakeDoc({ withSearch: false }))[4].execute({ query: '变压器' });
  assert.equal(b.reason, 'search_ui_missing');
});

test('site_search.execute：填输入框、开面板、加滚动锁、派发 input 事件（与真人同路径）', async () => {
  const doc = fakeDoc();
  const defs = buildToolDefs(doc);
  const p = defs[4].execute({ query: '变压器' });
  const input = doc.getElementById('search-input');
  const panel = doc.getElementById('search-panel');
  assert.equal(input.value, '变压器');
  assert.equal(panel.hidden, false);
  assert.equal(input._focused, true);
  assert.ok(hasClass(doc.body, 'search-open'), '2026-10-19 修：旧版漏了滚动锁');
  assert.equal(input._events.length, 1, '应派发一次 input 事件');
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.total, 7);
});

test('site_search.execute：scope=page 走页内查找', async () => {
  const defs = buildToolDefs(fakeDoc());
  const r = await defs[4].execute({ query: '铁芯损耗', scope: 'page' });
  assert.equal(r.ok, true);
  assert.equal(r.scope, undefined);
  assert.ok(r.total >= 1);
  assert.equal(r.hits[0].section, '小节 A');
});

test('site_show_symbol.execute：找到符号则派发点击并回读气泡', async () => {
  const doc = fakeDoc();
  const defs = buildToolDefs(doc);
  const r = await defs[5].execute({ term: 'sym-U' });
  assert.equal(r.ok, true);
  assert.equal(r.term, 'sym-U');
  assert.ok(r.bubble.includes('电压'), '应回读气泡文字');
});

test('site_show_symbol.execute：正文里的符号也能查（2026-10-19 修）', async () => {
  const doc = fakeDoc();
  const r = await buildToolDefs(doc)[5].execute({ term: 'sym-I' });
  assert.equal(r.ok, true);
  assert.equal(r.term, 'sym-I');
});

test('site_show_symbol.execute：页面上没有该符号时报 symbol_not_on_page 并给候选', async () => {
  const defs = buildToolDefs(fakeDoc());
  const r = await defs[5].execute({ term: 'sym-NOPE' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'symbol_not_on_page');
  assert.ok(Array.isArray(r.available) && r.available.length >= 2, '要给可查清单');
});

test('PAGE_SELECTORS.glossaryBubble 必须匹配真实气泡类名 .sym-gloss-pop（2026-10-19 真 bug）', () => {
  assert.equal(PAGE_SELECTORS.glossaryBubble, '.sym-gloss-pop');
  assert.doesNotMatch(PAGE_SELECTORS.glossaryBubble, /bubble/, '真实 DOM 里没有含 bubble 的类');
});

test('registerTools：探测两个注册表；都没有时返回 0 且不抛', () => {
  assert.equal(registerTools({}, null), 0);
  assert.equal(registerTools(null, {}), 0);
});

test('registerTools：document 侧注册表可用时注册 11 个（Chromium 形态）', () => {
  const registered = [];
  const doc = fakeDoc();
  doc.modelContext = { registerTool: (t) => { registered.push(t.name); return Promise.resolve(); } };
  assert.equal(registerTools(doc, null), 11);
  assert.deepEqual(registered, [
    'site_get_page_info', 'site_read', 'site_index', 'site_navigate', 'site_search',
    'site_show_symbol', 'site_panels', 'site_view',
    'site_list_images', 'site_image', 'site_capture_view',
  ]);
});

test('registerTools：只有 navigator 侧时也注册（Firefox 原生形态）', () => {
  const registered = [];
  const nav = { modelContext: { registerTool: (t) => { registered.push(t.name); return Promise.resolve(); } } };
  assert.equal(registerTools(fakeDoc(), nav), 11);
  assert.equal(registered.length, 11);
});

test('registerTools：单个工具注册失败不影响其余', () => {
  let n = 0;
  const doc = fakeDoc();
  doc.modelContext = {
    registerTool: () => { n += 1; if (n === 2) throw new Error('boom'); return Promise.resolve(); },
  };
  assert.equal(registerTools(doc, null), 11, '仍应尝试注册全部 11 个');
});

test('textOf：空/缺元素都给空串（永不 undefined）', () => {
  assert.equal(textOf(null), '');
  assert.equal(textOf(undefined), '');
  assert.equal(textOf({ textContent: '' }), '');
  assert.equal(textOf({ textContent: '  x  ' }), 'x');
});

test('hasClass：不依赖 classList（假 DOM 也能跑）', () => {
  assert.equal(hasClass({ className: 'a b c' }, 'b'), true);
  assert.equal(hasClass({ className: 'a bc' }, 'b'), false);
  assert.equal(hasClass({ className: '' }, 'b'), false);
  assert.equal(hasClass(null, 'b'), false);
});

test('serializeSelectors：RegExp 序列化成 new RegExp（JSON 会丢它）', () => {
  const s = serializeSelectors({ re: /共\s*(\d+)/, plain: 'x' });
  assert.ok(s.includes('new RegExp('), '正则要显式还原');
  assert.ok(s.includes('"plain":"x"'));
  // 还原后行为一致
  const restored = new Function(`return ${s}`)();
  assert.ok(restored.re instanceof RegExp);
  assert.equal('共 7 页命中'.match(restored.re)[1], '7');
});

test('WEBMCP_TOOLS_JS：是真函数派生的、语法可解析、含两个注册表探测', () => {
  assert.ok(WEBMCP_TOOLS_JS.includes(createPageView.toString().slice(0, 80)), '应由 createPageView 派生');
  assert.ok(WEBMCP_TOOLS_JS.includes(renderMarkdown.toString().slice(0, 80)), '应由 renderMarkdown 派生');
  assert.ok(WEBMCP_TOOLS_JS.includes('doc.modelContext') && WEBMCP_TOOLS_JS.includes('nav.modelContext'),
    '两个注册表都要探测（Chromium 回归的判据）');
  assert.doesNotThrow(() => new Function(WEBMCP_TOOLS_JS), '内联源码必须语法可解析');
});

test('WEBMCP_TOOLS_JS：内联源码必须自带全部依赖（2026-10-19 真实页崩过：isTextNode is not defined）', async () => {
  // 盲区：模块测试直接 import 函数，能跑；浏览器跑的是内联字符串，
  // 漏了一个依赖（childrenOf/isTextNode 提升到模块级后忘了加）就整条 site_read 崩。
  // 这里在**隔离 vm** 里跑内联源码，并真的调用 site_read 的 section 分支。
  const vm = await import('node:vm');
  const doc = fakeDoc();
  let captured = null;
  doc.modelContext = {
    registerTool: (t) => { if (t.name === 'site_read') captured = t; return Promise.resolve(); },
  };
  const sandbox = {
    document: doc, navigator: null, Promise, RegExp, JSON, Array, Number, String, Object,
    Math, URL, Event: class {}, MouseEvent: class {}, setTimeout, console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(WEBMCP_TOOLS_JS, sandbox);
  assert.ok(captured, 'site_read 应已注册');
  const r = await captured.execute({ what: 'section', query: '第一节' });
  assert.equal(r.ok, true, 'section 分支在内联环境里必须能跑：' + JSON.stringify(r));
  assert.match(r.text, /第一节正文/);
});

test('WEBMCP_TOOLS_JS：内联源码引用的每个模块级函数都在（派生完整性）', () => {
  // 粗粒度守卫：源码里出现的「裸函数名调用」必须要么是内联过的，要么是 JS 内置。
  const inlined = ['textOf', 'hasClass', 'childrenOf', 'isTextNode', 'renderMarkdown',
    'createPageView', 'buildToolDefs', 'registerTools'];
  for (const fn of inlined) {
    assert.ok(WEBMCP_TOOLS_JS.includes(`var ${fn} = `), `内联源码缺 ${fn}`);
  }
});

test('WEBMCP_TOOLS_JS：在假环境里能真的注册上（端到端，不靠浏览器）', async () => {
  // 用 node:vm 跑那段内联源码，喂假 document/navigator
  const vm = await import('node:vm');
  const registered = [];
  const doc = fakeDoc();
  doc.modelContext = { registerTool: (t) => { registered.push(t.name); return Promise.resolve(); } };
  const sandbox = {
    document: doc, navigator: null, Promise, RegExp, JSON, Array, Number, String, Object,
    Math, URL, Event: class {}, MouseEvent: class {}, setTimeout, console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(WEBMCP_TOOLS_JS, sandbox);
  assert.equal(registered.length, 11, '内联源码应注册 11 个工具');
});
