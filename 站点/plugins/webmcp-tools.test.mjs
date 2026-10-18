/**
 * 站点工具的性质测试（2026-10-16 候选 2+5）。
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
  PAGE_SELECTORS, textOf, createPageView, buildToolDefs, registerTools,
  serializeSelectors, WEBMCP_TOOLS_JS,
} from './webmcp-tools.mjs';

// ---------------------------------------------------------------- 假 DOM

/** 最小元素：支持 textContent / tagName / id / class 相关 / 父子链 / scrollIntoView。 */
function el(tag, text, props = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    textContent: text,
    id: props.id || '',
    className: props.className || '',
    open: props.open,
    hidden: props.hidden,
    parentElement: null,
    children: [],
    _attrs: props.attrs || {},
    getAttribute(k) { return this._attrs[k] !== undefined ? this._attrs[k] : null; },
    setAttribute(k, v) { this._attrs[k] = v; },
    focus() { this._focused = true; },
    dispatchEvent(ev) { (this._events || []).push(ev); this._events = this._events || []; return true; },
    scrollIntoView() { this._scrolled = true; },
    querySelector(sel) { return matchIn(this, sel)[0] || null; },
  };
  node._events = [];
  return node;
}

/** 单个简单选择器（class / tag / `[class*=x]`）的匹配。 */
function matchesSimple(node, s) {
  if (s.startsWith('.')) return String(node.className).split(/\s+/).includes(s.slice(1));
  if (s.startsWith('[') && s.includes('*=')) {
    const mm = s.match(/\[class\*=([^\]]+)\]/); return mm ? String(node.className).includes(mm[1]) : false;
  }
  // `[data-term]` 这类**存在性属性选择器**（真实 DOM 认它；假 DOM 也得认）
  if (s.startsWith('[') && s.endsWith(']')) {
    const attr = s.slice(1, -1);
    return node.getAttribute(attr) !== null;
  }
  if (s === 'details') return node.tagName === 'DETAILS';
  return node.tagName === s.toUpperCase();
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
  // 只支持到「后代选择器取末段」的精度：`.katex [data-term]` → 找带 data-term 的元素。
  // 假 DOM 里所有元素都算「在同一棵树内」，所以末段匹配就是全部匹配。
  return flatten(root).filter((n) => matches(n, sel));
}

/** 造一个像 document 的对象。 */
function fakeDoc({ title = '测试页', url = 'http://x/y.html', withSearch = true } = {}) {
  const h1 = el('h1', '变压器额定电流');
  const chip = el('span', '📚 电机学', { className: 'meta-chip' });
  const h2a = el('h2', '第一节', { id: 'sec-1' });
  const h3 = el('h3', '小节 A', { id: 'sub-a' });
  const h2b = el('h2', '第二节', { id: 'sec-2' });

  const details1 = el('details', '', { open: false });
  // 真实结构：data-term 在 <a class="sym-gloss"> 上，而它在 .katex **内部**（祖先关系）
  const katex = el('span', '', { className: 'katex' });
  const term = el('a', 'U', { className: 'sym-gloss', attrs: { 'data-term': 'sym-U' } });
  katex.children = [term]; term.parentElement = katex;
  const bubble = el('div', '电压：两点间的电位差', { className: 'glossary-bubble' });

  const panel = el('div', '', { id: 'search-panel', hidden: true });
  const input = el('input', '', { id: 'search-input' });
  const results = el('div', '仅显示相关度最高的 2 页（共 7 页命中）', { id: 'search-results' });
  const hitTitle = el('span', '电机学 2026-10-08', { className: 'search-hit-title' });
  const hit = el('a', '', { className: 'search-hit', attrs: { href: '课程/电机学/x.html' } });
  hit.children = [hitTitle];

  // term 与 bubble 挂到同一个 article 祖先下（真实页面上气泡脚本也在 article 内）
  const article = el('div', '', { className: 'article-content' });
  article.children = [h1, chip, h2a, h3, h2b, details1, katex, bubble];
  for (const c of article.children) c.parentElement = article;
  const all = [article];
  if (withSearch) all.push(panel, input, results, hit);
  // 建父子链（details 里放一个标题，测「开面板」）
  details1.children = [el('h3', '折叠里的标题', { id: 'in-details' })];

  const doc = {
    title,
    location: { href: url },
    defaultView: { setTimeout: (fn) => setTimeout(fn, 0) },
    querySelectorAll(sel) { return matchIn(doc, sel); },
    querySelector(sel) { return matchIn(doc, sel)[0] || null; },
    getElementById(id) { return flatten(doc).find((n) => n.id === id) || null; },
    _all: all,
  };
  doc.children = all;
  // 把 details 的父链接上（openSection 要沿 parentElement 上溯）
  details1.children[0].parentElement = details1;
  details1.parentElement = doc.children[0];
  return doc;
}

// ---------------------------------------------------------------- 测试

test('pageInfo：标题/课程/小节清单（课程 chip 去掉 emoji 前缀）', () => {
  const view = createPageView(fakeDoc());
  const info = view.pageInfo();
  assert.equal(info.title, '变压器额定电流');
  assert.equal(info.course, '电机学');
  assert.equal(info.url, 'http://x/y.html');
  // 注意：折叠面板**内**的标题也会被收进 sections（真实 DOM 同样如此——querySelectorAll 不看 details 开合）
  assert.deepEqual(info.sections.map((s) => s.title), ['第一节', '小节 A', '第二节', '折叠里的标题']);
  assert.equal(info.sections[0].anchor, 'sec-1');
  assert.equal(info.sections[0].level, 2);
});

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
  assert.deepEqual(view.togglePanels(true), { count: 1, open: true });
  assert.equal(det.open, true);
  assert.deepEqual(view.togglePanels(false), { count: 1, open: false });
  assert.equal(det.open, false);
  assert.deepEqual(view.togglePanels(), { count: 1, open: 'toggled' });
  assert.equal(det.open, true);
});

test('searchResults：读 DOM 的命中与总数（认「共 N 页命中」文案）', () => {
  const view = createPageView(fakeDoc());
  const r = view.searchResults();
  assert.equal(r.total, 7);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].title, '电机学 2026-10-08');
});

test('buildToolDefs：六个工具、名字与 schema 齐备', () => {
  const defs = buildToolDefs(fakeDoc());
  assert.deepEqual(defs.map((d) => d.name), [
    'site_get_page_info', 'site_open_section', 'site_search', 'site_show_symbol', 'site_toggle_panels',
    'site_capture_view',
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

test('site_toggle_panels.execute：传 open 后生效', async () => {
  const doc = fakeDoc();
  const defs = buildToolDefs(doc);
  const r = await defs[4].execute({ open: true });
  assert.equal(r.open, true);
  assert.equal(doc.querySelector('details').open, true);
});

test('site_capture_view：宿主未注入能力时明确报错（不静默、不假成功）', async () => {
  const defs = buildToolDefs(fakeDoc());
  const r = await defs[5].execute({});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'capture_unavailable');
  assert.ok(r.hint && r.hint.includes('__siteCapture'), '要告诉宿主该注入什么');
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
  const r = await defs[5].execute({ format: 'jpeg', quality: 70, reason: '看版面' });
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
  const r1 = await boom[5].execute({});
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'capture_error');
  assert.ok(r1.detail.includes('quota'));

  const empty = buildToolDefs(doc, { innerWidth: 1, innerHeight: 1, __siteCapture: () => Promise.resolve({}) });
  const r2 = await empty[5].execute({});
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'capture_failed');
});

test('site_open_section.execute：按锚点跳', async () => {
  const defs = buildToolDefs(fakeDoc());
  const r = await defs[1].execute({ anchor: 'sec-1' });
  assert.equal(r.ok, true);
  assert.equal(r.anchor, 'sec-1');
});

test('site_search.execute：空查询报 empty_query；无面板报 search_ui_missing', async () => {
  const a = await buildToolDefs(fakeDoc())[2].execute({ query: '  ' });
  assert.deepEqual(a, { ok: false, reason: 'empty_query' });
  const b = await buildToolDefs(fakeDoc({ withSearch: false }))[2].execute({ query: '变压器' });
  assert.equal(b.reason, 'search_ui_missing');
});

test('site_search.execute：填输入框、开面板、派发 input 事件（与真人同路径）', async () => {
  const doc = fakeDoc();
  const defs = buildToolDefs(doc);
  const p = defs[2].execute({ query: '变压器' });
  const input = doc.getElementById('search-input');
  const panel = doc.getElementById('search-panel');
  assert.equal(input.value, '变压器');
  assert.equal(panel.hidden, false);
  assert.equal(input._focused, true);
  assert.equal(input._events.length, 1, '应派发一次 input 事件');
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.total, 7);
});

test('site_show_symbol.execute：找到符号则派发点击并回读气泡', async () => {
  const doc = fakeDoc();
  const defs = buildToolDefs(doc);
  const r = await defs[3].execute({ term: 'sym-U' });
  assert.equal(r.ok, true);
  assert.equal(r.term, 'sym-U');
  assert.ok(r.bubble.includes('电压'), '应回读气泡文字');
});

test('site_show_symbol.execute：页面上没有该符号时报 symbol_not_on_page', async () => {
  const defs = buildToolDefs(fakeDoc());
  const r = await defs[3].execute({ term: 'sym-NOPE' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'symbol_not_on_page');
});

test('registerTools：探测两个注册表；都没有时返回 0 且不抛', () => {
  assert.equal(registerTools({}, null), 0);
  assert.equal(registerTools(null, {}), 0);
});

test('registerTools：document 侧注册表可用时注册 6 个（Chromium 形态）', () => {
  const registered = [];
  const doc = fakeDoc();
  doc.modelContext = { registerTool: (t) => { registered.push(t.name); return Promise.resolve(); } };
  assert.equal(registerTools(doc, null), 6);
  assert.deepEqual(registered, [
    'site_get_page_info', 'site_open_section', 'site_search', 'site_show_symbol', 'site_toggle_panels',
    'site_capture_view',
  ]);
});

test('registerTools：只有 navigator 侧时也注册（Firefox 原生形态）', () => {
  const registered = [];
  const nav = { modelContext: { registerTool: (t) => { registered.push(t.name); return Promise.resolve(); } } };
  assert.equal(registerTools(fakeDoc(), nav), 6);
  assert.equal(registered.length, 6);
});

test('registerTools：单个工具注册失败不影响其余', () => {
  let n = 0;
  const doc = fakeDoc();
  doc.modelContext = {
    registerTool: () => { n += 1; if (n === 2) throw new Error('boom'); return Promise.resolve(); },
  };
  assert.equal(registerTools(doc, null), 6, '仍应尝试注册全部 6 个');
});

test('textOf：空/缺元素都给空串（永不 undefined）', () => {
  assert.equal(textOf(null), '');
  assert.equal(textOf(undefined), '');
  assert.equal(textOf({ textContent: '' }), '');
  assert.equal(textOf({ textContent: '  x  ' }), 'x');
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
  assert.ok(WEBMCP_TOOLS_JS.includes('doc.modelContext') && WEBMCP_TOOLS_JS.includes('nav.modelContext'),
    '两个注册表都要探测（Chromium 回归的判据）');
  assert.doesNotThrow(() => new Function(WEBMCP_TOOLS_JS), '内联源码必须语法可解析');
});

test('WEBMCP_TOOLS_JS：在假环境里能真的注册上（端到端，不靠浏览器）', async () => {
  // 用 node:vm 跑那段内联源码，喂假 document/navigator
  const vm = await import('node:vm');
  const registered = [];
  const doc = fakeDoc();
  doc.modelContext = { registerTool: (t) => { registered.push(t.name); return Promise.resolve(); } };
  const sandbox = {
    document: doc, navigator: null, Promise, RegExp, JSON, Array, Number, String,
    Event: class {}, MouseEvent: class {}, setTimeout, console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(WEBMCP_TOOLS_JS, sandbox);
  assert.equal(registered.length, 6, '内联源码应注册 6 个工具');
});
