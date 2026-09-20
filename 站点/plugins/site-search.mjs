/**
 * 全站搜索（自持模块，替代 Pagefind）
 *
 * 为什么不用 Pagefind：Pagefind 1.5.2 把中文**按单字**建索引，查询也被拆成单字做 AND
 * 匹配。实测（本仓 66 页）：搜「的」命中 62 页、搜「行」命中 50 页；「沙路法则」与
 * 「法则沙路」结果数完全相同；生造词「拉普拉斯」也能命中 2 页——它的字在别的页里散落
 * 出现过。CLI 只有 --force-language 与 --include-characters 两个开关，没有中文分词；
 * 改成 en 后更不可解释（实测「法则」→ 0 而「则法」→ 18）。中文用户输入的是词，期望的是
 * **字面子串**命中，所以这里自己建索引。
 *
 * 结构（构建期生成静态文件，浏览器端零依赖）：
 *   1. 每页抽纯文本：去掉 KaTeX（<annotation> 里是 LaTeX 源码）、脚本、样式；块级标签记
 *      换行为边界；行内标签不留分隔符——否则 <strong>行列</strong>式 会变成搜不到的
 *      「行列 式」。
 *   2. 倒排索引：**二元组（bigram）→ 文档 → 位置**，另存单字 → 文档（只服务单字查询）。
 *      按 gram 哈希分桶，查询只拉用到的那几个桶，不需要把全站文本拖下来。
 *   3. 每页文本单独成文件，只给确实要显示摘要的那几条结果按需拉取。
 *   4. 查询串同样切 gram 取候选，再按位置**逐字校验相邻**，所以「沙路法则」只命中真正
 *      连着出现这四个字的地方；命中位置还能映射回所在小节，结果直接深链到锚点。
 *
 * 可拆卸：删掉本文件、build.mjs 里的写盘/注入段落、页面模板里的两行 <script>/<link>
 * 即可回退（搜索面板消失，其余功能不受影响）。
 *
 * 构建端与浏览器端**共用**同一批纯函数：SEARCH_JS 用 Function.prototype.toString() 把
 * 它们内联进客户端脚本，避免两边各写一份算法而算出不同结果。
 */

// ---------------------------------------------------------------- 共享纯函数

// 汉字与全角标点：用于「合并汉字之间的空格」这一步。
const CJK_CLASS = '\\u3000-\\u303f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
const ALNUM_CLASS = '0-9a-z';
const CJK_RE_SRC = `[${CJK_CLASS}]`;

/**
 * 查询与索引共用的规范化：NFKC → 小写 → 折叠空白 → 合并汉字旁的空格。
 * 两边必须逐字一致，否则位置对不上、短语校验会全灭。
 */
export function foldSearchText(input) {
  if (input === null || input === undefined) return '';
  let s = String(input);
  try { s = s.normalize('NFKC'); } catch (_) { /* 无 NFKC 时退化为原样 */ }
  s = s.toLowerCase();
  s = s.replace(/[ \t\u00a0\u3000]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{2,}/g, '\n');
  // 「第 1 章」「MATLAB 函数」这类空格是排版习惯，用户不会照着敲；汉字与汉字、汉字与
  // 字母数字之间的空格一律吃掉。字母数字之间的空格保留（那里空格是词的一部分）。
  s = s.replace(new RegExp(`([${CJK_CLASS}${ALNUM_CLASS}]) (?=${CJK_RE_SRC})`, 'g'), '$1');
  s = s.replace(new RegExp(`(${CJK_RE_SRC}) (?=[${ALNUM_CLASS}])`, 'g'), '$1');
  return s.trim();
}

export function escapeHtmlText(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** gram 只索引不含空白的二元组：跨空白的二元组没有检索价值，只会把索引撑大。 */
export function isIndexableGram(gram) {
  return gram.length === 2 && gram.indexOf(' ') < 0 && gram.indexOf('\n') < 0;
}

/** 查询切分：bigrams 保留出现顺序与重复（链式校验需要），unigrams 只服务单字与兜底。 */
export function queryGrams(foldedQuery) {
  const bigrams = [];
  const unigrams = [];
  const q = String(foldedQuery || '');
  for (let i = 0; i < q.length; i++) {
    const ch = q[i];
    if (ch !== ' ' && ch !== '\n' && unigrams.indexOf(ch) < 0) unigrams.push(ch);
    if (i + 1 < q.length) {
      const gram = q.slice(i, i + 2);
      if (isIndexableGram(gram)) bigrams.push(gram);
    }
  }
  return { bigrams, unigrams };
}

export function hashGram(gram) {
  let h = 0x811c9dc5;
  for (let i = 0; i < gram.length; i++) {
    h ^= gram.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 短语校验：postingsList[k] 是查询第 k 个二元组在该文档中的位置数组。
 * 返回短语起点的位置数组（升序）。以最短的一列当锚，减少比较次数。
 */
export function verifyPhrase(postingsList) {
  if (!postingsList || !postingsList.length) return [];
  let anchor = 0;
  for (let k = 1; k < postingsList.length; k++) {
    if (!postingsList[k] || !postingsList[k].length) return [];
    if (postingsList[k].length < postingsList[anchor].length) anchor = k;
  }
  if (!postingsList[anchor].length) return [];
  const sets = postingsList.map((list) => new Set(list));
  const found = [];
  for (const p of postingsList[anchor]) {
    const base = p - anchor;
    if (base < 0) continue;
    let ok = true;
    for (let k = 0; k < postingsList.length; k++) {
      if (k !== anchor && !sets[k].has(base + k)) { ok = false; break; }
    }
    if (ok) found.push(base);
  }
  found.sort((a, b) => a - b);
  return found;
}

/** 位置 → 所属小节（headings 按 s 升序，s 是标题在正文中的偏移）。 */
export function sectionForPosition(headings, position) {
  if (!headings || !headings.length) return null;
  let found = null;
  for (const heading of headings) {
    if (heading.s <= position) found = heading;
    else break;
  }
  return found;
}

export function countOccurrences(text, needle) {
  if (!text || !needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

/** 摘要：截命中点周围一段，标出窗口内的每次命中。\n 在显示时算空格。 */
export function makeSnippet(text, needle, options) {
  const opts = options || {};
  const radius = opts.radius || 42;
  const maxMarks = opts.maxMarks || 6;
  const total = countOccurrences(text, needle);
  const at = text.indexOf(needle);
  if (at < 0) return { html: '', total: 0 };
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + needle.length + radius);
  const segment = text.slice(start, end);
  let html = '';
  let cursor = 0;
  let marks = 0;
  for (;;) {
    const hit = segment.indexOf(needle, cursor);
    if (hit < 0 || marks >= maxMarks) break;
    html += escapeHtmlText(segment.slice(cursor, hit)) + '<mark>' + escapeHtmlText(needle) + '</mark>';
    cursor = hit + needle.length;
    marks += 1;
  }
  html += escapeHtmlText(segment.slice(cursor));
  html = html.replace(/\n/g, ' ');
  return { html: (start > 0 ? '…' : '') + html + (end < text.length ? '…' : ''), total };
}

/** 相关度：标题命中权重最高，其次小标题，再按正文命中密度与首次出现位置。 */
export function scoreSearchHit(entry) {
  let score = 0;
  if (entry.titleHit) score += 1000;
  if (entry.titleExact) score += 500;
  score += Math.min(entry.headingHits || 0, 3) * 220;
  score += Math.min(entry.total || 0, 8) * 14;
  if (entry.firstPos >= 0) score += Math.max(0, 36 - Math.floor(entry.firstPos / 240));
  const density = (entry.total || 0) / Math.max(400, entry.chars || 0);
  score += Math.min(70, Math.round(density * 4000));
  return score;
}

// ---------------------------------------------------------------- 实体与正文抽取

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', times: '×', divide: '÷', minus: '−', middot: '·',
  le: '≤', ge: '≥', ne: '≠', deg: '°', copy: '©', reg: '®', laquo: '«', raquo: '»',
  larr: '←', rarr: '→', harr: '↔', prime: '′', radic: '√', infin: '∞',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', lambda: 'λ', mu: 'μ', pi: 'π',
  sigma: 'σ', omega: 'ω', theta: 'θ', phi: 'φ', epsilon: 'ε',
  Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω'
};

export function decodeHtmlEntities(input) {
  if (!input) return '';
  return String(input).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    const named = HTML_ENTITIES[body];
    return named === undefined ? whole : named;
  });
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr'
]);
// KaTeX 的 <annotation> 存着 LaTeX 源码，索引进去会让「\begin{vmatrix}」这类噪声
// 出现在搜索结果里（Pagefind 时代也是这么排除的）。
const SKIP_TAGS = new Set(['script', 'style', 'template', 'svg', 'noscript']);
// 块级边界记为换行：跨段的两段文字不应被当成一个连续子串命中。
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'details', 'div', 'dl', 'dt',
  'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul'
]);
const HEADING_LEVELS = { h2: 2, h3: 3, h4: 4 };
// 标题边界用哨兵标记，折叠完再切出来算偏移——折叠会改长度，事后按字符串找回位置不可靠。
const SENTINEL_OPEN = '\u0000';
const SENTINEL_MID = '\u0001';
const SENTINEL_CLOSE = '\u0002';

function readTag(html, lt) {
  // 属性值里可能出现 '>'（如 title="a > b"），按引号跳过，别把标签截断在半路。
  let i = lt + 1;
  let quote = '';
  while (i < html.length) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return { raw: html.slice(lt + 1, i), end: i + 1 };
    }
    i += 1;
  }
  return { raw: html.slice(lt + 1), end: html.length };
}

function parseTag(raw) {
  const closing = raw[0] === '/';
  const body = closing ? raw.slice(1) : raw;
  const nameMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(body);
  if (!nameMatch) return null;
  const name = nameMatch[1].toLowerCase();
  const attrText = body.slice(nameMatch[0].length);
  const classMatch = /class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrText);
  const className = classMatch ? (classMatch[1] || classMatch[2] || classMatch[3] || '') : '';
  const idMatch = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrText);
  const id = idMatch ? (idMatch[1] || idMatch[2] || idMatch[3] || '') : '';
  return {
    closing,
    name,
    className,
    id,
    selfClosing: !closing && (/\/\s*$/.test(raw) || VOID_TAGS.has(name))
  };
}

/**
 * 按哨兵切出标题与正文。对**折叠前**的原始串跑一遍拿显示文本，对折叠后的串跑一遍拿匹配
 * 文本与偏移——标题要以原样显示（「开始之前：前置检查」不该显示成「开始之前:前置检查」）。
 */
function splitSentinels(source) {
  const parts = [];
  const headings = [];
  let out = '';
  let cursor = 0;
  for (;;) {
    const open = source.indexOf(SENTINEL_OPEN, cursor);
    if (open < 0) { out += source.slice(cursor); break; }
    out += source.slice(cursor, open);
    const mid = source.indexOf(SENTINEL_MID, open);
    const close = mid < 0 ? -1 : source.indexOf(SENTINEL_CLOSE, mid);
    if (mid < 0 || close < 0) { out += source.slice(open); break; }
    const meta = source.slice(open + 1, mid);
    const colon = meta.indexOf(':');
    const level = parseInt(meta.slice(0, colon), 10);
    const headingText = source.slice(mid + 1, close);
    headings.push({
      level: Number.isFinite(level) ? level : 3,
      anchor: meta.slice(colon + 1),
      text: headingText
    });
    parts.push({ start: out.length, text: headingText });
    out += headingText;
    cursor = close + 1;
  }
  return { text: out, headings, parts };
}

/**
 * 从渲染后的页面 HTML 抽出检索正文。
 * 返回 { url, title, headings, text }：text 已规范化；headings 的 s 是标题在 text 中的
 * 偏移，用来把正文命中位置映射回小节，从而把结果深链到锚点。每个标题存两份文本：
 * t 是折叠后的（匹配用），d 是原样的（显示用）。
 */
export function extractSearchDoc(html, options) {
  const opts = options || {};
  const chunks = [];
  const openTags = [];
  let skipping = 0;
  let pendingHeading = null;

  const pushText = (text) => {
    if (!text || skipping > 0) return;
    chunks.push(decodeHtmlEntities(text));
  };
  const pushBreak = () => {
    if (skipping > 0) return;
    chunks.push('\n');
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { pushText(html.slice(i)); break; }
    if (lt > i) pushText(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const tag = readTag(html, lt);
    i = tag.end;
    const parsed = parseTag(tag.raw);
    if (!parsed) continue;

    if (parsed.closing) {
      const top = openTags.pop();
      if (top && top.skip) skipping = Math.max(0, skipping - 1);
      if (pendingHeading && top && top.name === parsed.name) {
        chunks.push(SENTINEL_CLOSE);
        pendingHeading = null;
      }
      if (BLOCK_TAGS.has(parsed.name)) pushBreak();
      continue;
    }

    const isSkip = SKIP_TAGS.has(parsed.name) || parsed.className.split(/\s+/).indexOf('katex') >= 0;
    openTags.push({ name: parsed.name, skip: isSkip });
    if (isSkip) skipping += 1;
    if (parsed.selfClosing) continue;
    if (HEADING_LEVELS[parsed.name] && parsed.id) {
      pendingHeading = { name: parsed.name, level: HEADING_LEVELS[parsed.name], anchor: parsed.id };
      chunks.push(`${SENTINEL_OPEN}${pendingHeading.level}:${pendingHeading.anchor}${SENTINEL_MID}`);
    }
    if (BLOCK_TAGS.has(parsed.name)) pushBreak();
  }
  const raw = chunks.join('');
  const folded = foldSearchText(raw);
  const foldedSplit = splitSentinels(folded);
  const rawSplit = splitSentinels(raw);

  const headings = foldedSplit.parts.map((part, index) => {
    const display = rawSplit.parts[index];
    return {
      t: part.text.trim(),
      d: (display ? display.text : part.text).replace(/\s+/g, ' ').trim(),
      a: foldedSplit.headings[index] ? foldedSplit.headings[index].anchor : '',
      l: foldedSplit.headings[index] ? foldedSplit.headings[index].level : 3,
      s: part.start
    };
  });

  return {
    url: opts.url || '',
    title: opts.title || '',
    headings,
    text: foldedSplit.text.trim()
  };
}

// ---------------------------------------------------------------- 索引构建

/** 二元组 → 位置数组；不含空白的 gram 才收，且不跨段（\n 是段边界）。 */
export function gramPositions(text) {
  const map = new Map();
  for (let i = 0; i + 1 < text.length; i++) {
    const gram = text.slice(i, i + 2);
    if (!isIndexableGram(gram)) continue;
    const list = map.get(gram);
    if (list) list.push(i);
    else map.set(gram, [i]);
  }
  return map;
}

/**
 * 生成检索bundle 的全部文件内容。
 * 返回 { files, stats }：files 的键是相对 dist 的路径，值是文件内容。
 */
export function buildSearchBundle(docs, options) {
  const opts = options || {};
  const bucketCount = opts.buckets || 64;
  const files = {};
  const indexDocs = [];
  const buckets = [];
  for (let i = 0; i < bucketCount; i++) buckets.push({ grams: new Map(), uni: new Map() });

  let gramCount = 0;
  let positionCount = 0;

  docs.forEach((doc, id) => {
    const text = doc.text || '';
    indexDocs.push({
      id,
      url: doc.url,
      title: doc.title,
      chars: text.length,
      headings: doc.headings || []
    });
    files[`search/t/${id}.json`] = JSON.stringify({ text });

    const grams = gramPositions(text);
    for (const [gram, positions] of grams) {
      const bucket = buckets[hashGram(gram) % bucketCount];
      let byDoc = bucket.grams.get(gram);
      if (!byDoc) { byDoc = new Map(); bucket.grams.set(gram, byDoc); }
      byDoc.set(id, positions);
      gramCount += 1;
      positionCount += positions.length;
    }
    for (const ch of new Set(text)) {
      if (ch === '\n' || ch === ' ') continue;
      const bucket = buckets[hashGram(ch) % bucketCount];
      let list = bucket.uni.get(ch);
      if (!list) { list = []; bucket.uni.set(ch, list); }
      list.push(id);
    }
  });

  buckets.forEach((bucket, i) => {
    const grams = {};
    for (const [gram, byDoc] of bucket.grams) {
      const postings = {};
      for (const [id, positions] of byDoc) postings[id] = positions;
      grams[gram] = postings;
    }
    const uni = {};
    for (const [ch, ids] of bucket.uni) uni[ch] = ids;
    files[`search/g/${i}.json`] = JSON.stringify({ grams, uni });
  });

  files['search/index.json'] = JSON.stringify({
    v: 1,
    buckets: bucketCount,
    pages: indexDocs.length,
    docs: indexDocs
  });

  return {
    files,
    stats: { pages: indexDocs.length, buckets: bucketCount, grams: gramCount, positions: positionCount }
  };
}

// ---------------------------------------------------------------- 浏览器端脚本

const SEARCH_CSS = `/* 自持搜索模块的样式（站点/plugins/site-search.mjs） */
.search-hit-section {
  display: block;
  margin-bottom: 2px;
  font-size: 0.78rem;
  letter-spacing: 0.02em;
  color: var(--md-sys-color-primary, #6750a4);
  opacity: 0.85;
}
.search-hit-excerpt mark {
  background: var(--md-sys-color-tertiary-container, #ffd8e4);
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}
.search-panel-empty {
  font-size: 0.85rem;
  opacity: 0.75;
  padding: 4px 0;
}`;

export { SEARCH_CSS };

/**
 * 客户端脚本。这里用 toString() 把上面那些纯函数原样内联，构建端与浏览器端共用一份
 * 实现；window.__siteSearch 把内部函数暴露出来，便于在浏览器里排查，也方便测试做一致性
 * 校验。
 */
export const SEARCH_JS = `(function () {
"use strict";
const CJK_CLASS = ${JSON.stringify(CJK_CLASS)};
const ALNUM_CLASS = ${JSON.stringify(ALNUM_CLASS)};
const CJK_RE_SRC = ${JSON.stringify(CJK_RE_SRC)};
const foldSearchText = ${foldSearchText.toString()};
const isIndexableGram = ${isIndexableGram.toString()};
const queryGrams = ${queryGrams.toString()};
const hashGram = ${hashGram.toString()};
const verifyPhrase = ${verifyPhrase.toString()};
const sectionForPosition = ${sectionForPosition.toString()};
const countOccurrences = ${countOccurrences.toString()};
const makeSnippet = ${makeSnippet.toString()};
const scoreSearchHit = ${scoreSearchHit.toString()};
const escapeHtmlText = ${escapeHtmlText.toString()};

const toggleBtn = document.getElementById("search-toggle");
const panel = document.getElementById("search-panel");
const input = document.getElementById("search-input");
const results = document.getElementById("search-results");
const closeBtn = document.getElementById("search-close");

window.__siteSearch = {
  foldSearchText, queryGrams, hashGram, verifyPhrase, sectionForPosition,
  makeSnippet, scoreSearchHit, countOccurrences
};
if (!toggleBtn || !panel || !input || !results) return;

let activeIndex = -1;
let currentHits = [];
let searchSeq = 0;
let indexData = null;
const bucketCache = new Map();
const textCache = new Map();

// 站点根：从当前页地址按 data-depth 逐级上跳（与 build.mjs 的 rootRel 同一套约定）。
function siteRootUrl() {
  const depth = parseInt(document.documentElement.dataset.depth || "0", 10);
  let dir = location.pathname.replace(/[^/]*$/, "");
  for (let i = 0; i < depth; i++) dir = dir.replace(/[^/]+\\/$/, "");
  if (!dir.endsWith("/")) dir += "/";
  return location.origin + dir;
}

function assetUrl(path) {
  return siteRootUrl() + path;
}

function loadIndex() {
  if (indexData) return Promise.resolve(indexData);
  return fetch(assetUrl("search/index.json"))
    .then((res) => {
      if (!res.ok) throw new Error("index " + res.status);
      return res.json();
    })
    .then((data) => { indexData = data; return data; });
}

function loadBucket(number) {
  if (bucketCache.has(number)) return bucketCache.get(number);
  const promise = fetch(assetUrl("search/g/" + number + ".json"))
    .then((res) => (res.ok ? res.json() : { grams: {}, uni: {} }))
    .catch(() => ({ grams: {}, uni: {} }));
  bucketCache.set(number, promise);
  return promise;
}

function loadText(id) {
  if (textCache.has(id)) return textCache.get(id);
  const promise = fetch(assetUrl("search/t/" + id + ".json"))
    .then((res) => (res.ok ? res.json() : { text: "" }))
    .catch(() => ({ text: "" }));
  textCache.set(id, promise);
  return promise;
}

function openPanel() {
  panel.hidden = false;
  document.body.classList.add("search-open");
  input.focus();
}
function closePanel() {
  panel.hidden = true;
  document.body.classList.remove("search-open");
  activeIndex = -1;
}

function showProgress(percent, label) {
  results.innerHTML =
    '<div class="search-progress"><div class="search-progress-label">' + escapeHtmlText(label) +
    '</div><div class="search-progress-track"><div class="search-progress-bar" style="width:' +
    percent + '%"></div></div></div>';
}

function hitHref(hit) {
  // 索引里的 url 是**相对站点根**的路径（不带前导斜杠），这里补上站点根，
  // 于是 /repo/xxx/ 这类部署前缀下也能正确跳转。
  return siteRootUrl() + hit.url + (hit.anchor ? "#" + hit.anchor : "");
}

function renderHits(hits, query, options) {
  const opts = options || {};
  currentHits = hits;
  activeIndex = -1;
  if (!hits.length && !opts.partial) {
    results.innerHTML = '<p class="search-hint">没有找到「' + escapeHtmlText(query) + '」相关内容。换个说法或只搜关键词试试。</p>';
    return;
  }
  const list = hits.map((hit, i) => {
    const section = hit.sectionText
      ? '<span class="search-hit-section">' + escapeHtmlText(hit.sectionText) + "</span>"
      : "";
    const excerpt = hit.snippet
      ? hit.snippet
      : '<span class="search-panel-empty">命中 ' + (hit.total || 0) + " 处" +
        (hit.headingHitText ? "（小标题：" + escapeHtmlText(hit.headingHitText) + "）" : "") + "…</span>";
    return '<a class="search-hit" href="' + escapeHtmlText(hitHref(hit)) + '" data-index="' + i + '">' +
      section +
      '<span class="search-hit-title">' + escapeHtmlText(hit.title || hit.url) + "</span>" +
      '<span class="search-hit-excerpt">' + excerpt + "</span></a>";
  }).join("");
  const more = opts.partial
    ? '<div class="search-progress search-progress-inline"><div class="search-progress-label">正在载入更多结果…</div><div class="search-progress-track"><div class="search-progress-bar search-progress-bar-indeterminate"></div></div></div>'
    : "";
  const truncated = opts.totalPages && opts.totalPages > hits.length
    ? '<p class="search-panel-empty">仅显示相关度最高的 ' + hits.length + " 页（共 " + opts.totalPages + " 页命中）。</p>"
    : "";
  results.innerHTML = list + truncated + more;
}

function setActive(next) {
  const items = results.querySelectorAll(".search-hit");
  if (!items.length) return;
  if (activeIndex >= 0 && items[activeIndex]) items[activeIndex].classList.remove("active");
  activeIndex = (next + items.length) % items.length;
  items[activeIndex].classList.add("active");
  items[activeIndex].scrollIntoView({ block: "nearest" });
}

// 候选 → 命中。先只算位置与权重（不需要正文），正文摘要随后按需拉取。
function collectHits(data, bucketsByNumber, query) {
  const grams = queryGrams(query);
  const bucketOf = (gram) => bucketsByNumber.get(hashGram(gram) % data.buckets);
  const postingsFor = (gram) => {
    const bucket = bucketOf(gram);
    return bucket && bucket.grams ? bucket.grams[gram] : undefined;
  };
  const unigramDocsFor = (ch) => {
    const bucket = bucketOf(ch);
    return bucket && bucket.uni ? bucket.uni[ch] : undefined;
  };

  const hits = [];
  for (const doc of data.docs) {
    const positions = [];
    let total = 0;
    let firstPos = -1;
    let matchedByBody = false;

    if (grams.bigrams.length) {
      const perGram = grams.bigrams.map(postingsFor);
      if (perGram.some((postings) => !postings || !postings[doc.id])) {
        // 有 gram 缺口：这个文档不可能是连续命中，但标题仍可能命中，交给下面的标题判断
      } else {
        const found = verifyPhrase(perGram.map((postings) => postings[doc.id]));
        if (found.length) {
          matchedByBody = true;
          total = found.length;
          firstPos = found[0];
          for (const p of found) positions.push(p);
        }
      }
    } else if (grams.unigrams.length) {
      const lists = grams.unigrams.map(unigramDocsFor);
      if (!lists.some((list) => !list || list.indexOf(doc.id) < 0)) {
        matchedByBody = true;
        total = 0; // 单字查询不数次数，拉正文后再算
      }
    }

    const foldedTitle = foldSearchText(doc.title || "");
    const titleHit = foldedTitle.indexOf(query) >= 0;
    const headingHits = [];
    for (const heading of doc.headings || []) {
      if (heading.t && heading.t.indexOf(query) >= 0) headingHits.push(heading);
    }
    if (!matchedByBody && !titleHit && !headingHits.length) continue;

    const section = firstPos >= 0 ? sectionForPosition(doc.headings, firstPos) : (headingHits[0] || null);
    hits.push({
      id: doc.id,
      url: doc.url,
      title: doc.title,
      chars: doc.chars,
      positions,
      total,
      firstPos,
      titleHit,
      titleExact: foldedTitle === query,
      headingHits: headingHits.length,
      headingHitText: headingHits.length ? (headingHits[0].d || headingHits[0].t) : "",
      anchor: section ? section.a : "",
      sectionText: section ? (section.d || section.t) : "",
      snippet: "",
      score: 0
    });
  }
  for (const hit of hits) hit.score = scoreSearchHit(hit);
  hits.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  return { hits, grams };
}

async function runSearch(rawQuery) {
  const query = foldSearchText(rawQuery);
  if (!query) {
    results.innerHTML = '<p class="search-hint">输入关键词开始搜索。中文按字面子串匹配（搜「沙路法则」只出真正连着出现的地方），结果按相关度排序，回车打开第一条。</p>';
    return;
  }
  const seq = ++searchSeq;
  const firstLoad = !indexData;
  if (firstLoad) showProgress(15, "正在加载搜索索引…");

  let data;
  try {
    data = await loadIndex();
  } catch (err) {
    results.innerHTML = '<p class="search-hint">搜索索引未能加载（本地直接打开文件时不可用，请通过站点地址访问）。</p>';
    return;
  }
  if (seq !== searchSeq) return;

  const grams = queryGrams(query);
  const needed = [];
  for (const gram of grams.bigrams.concat(grams.unigrams)) {
    const number = hashGram(gram) % data.buckets;
    if (needed.indexOf(number) < 0) needed.push(number);
  }
  if (firstLoad) showProgress(45, "正在检索…");
  const loaded = await Promise.all(needed.map(loadBucket));
  if (seq !== searchSeq) return;
  const bucketsByNumber = new Map();
  needed.forEach((number, i) => bucketsByNumber.set(number, loaded[i]));

  const collected = collectHits(data, bucketsByNumber, query);
  if (!collected.hits.length) { renderHits([], rawQuery); return; }

  const top = collected.hits.slice(0, 12);
  const totalPages = collected.hits.length;
  renderHits(top, rawQuery, { partial: true, totalPages });

  // 摘要要正文，只给前 8 条拉，拉到一条刷新一次。
  const wantText = top.slice(0, 8);
  let arrived = 0;
  await Promise.all(wantText.map(async (hit) => {
    let payload;
    try { payload = await loadText(hit.id); } catch (_) { return; }
    if (seq !== searchSeq) return;
    const text = payload.text || "";
    const snippet = makeSnippet(text, query, { radius: 44 });
    if (snippet.html) {
      hit.snippet = snippet.html;
      hit.total = snippet.total;
    } else if (hit.positions.length) {
      const around = makeSnippet(text, text.slice(hit.positions[0], hit.positions[0] + query.length) || query, { radius: 44 });
      hit.snippet = around.html || "";
    } else {
      hit.total = countOccurrences(text, query);
    }
    arrived += 1;
    if (arrived === 1 || arrived % 3 === 0 || arrived === wantText.length) {
      renderHits(top, rawQuery, { partial: arrived < top.length, totalPages });
    }
  }));
  if (seq === searchSeq) renderHits(top, rawQuery, { totalPages });
}

let debounceTimer = null;
input.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runSearch(input.value), 160);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const items = results.querySelectorAll(".search-hit");
    const target = activeIndex >= 0 ? items[activeIndex] : items[0];
    if (target) { e.preventDefault(); target.click(); }
  } else if (e.key === "ArrowDown") {
    e.preventDefault(); setActive(activeIndex + 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault(); setActive(activeIndex - 1);
  } else if (e.key === "Escape") {
    closePanel();
  }
});

toggleBtn.addEventListener("click", () => { if (panel.hidden) openPanel(); else closePanel(); });
if (closeBtn) closeBtn.addEventListener("click", closePanel);
panel.addEventListener("click", (e) => { if (e.target === panel) closePanel(); });

document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement && document.activeElement.tagName) || "");
  if ((e.key === "/" && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) {
    e.preventDefault();
    openPanel();
  } else if (e.key === "Escape" && !panel.hidden) {
    closePanel();
  }
});
})();`;
