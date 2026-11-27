/**
 * IR 投影层：从同一棵树产出多种视图。**零依赖、纯函数**。
 *
 * ## 为什么所有投影都从 IR 出，而不是从 HTML 反推
 *
 * 旧代码有五处在「从渲染产物里再猜一次语义」：
 *   · `mathPlain()` 用正则从 TeX 抠纯文本 → 标题锚点
 *   · `stripHtmlData` 按花括号配平剥产物里的装饰 → MCP 读页面
 *   · `site-search` 用 `class="katex"` 整块跳过 → 公式从搜索里消失
 *   · `webmcp-tools` 嗅 `annotation` 取 LaTeX 源
 *   · 两处 `includes('katex-error')` 判失败
 *
 * 每一处都是一次「重新回答同一个问题」，答案稍有不同就是一次线上事故。
 * 现在只有一棵树，五个消费者读同一份数据。
 */

/** 深度优先遍历。visit 返回 false 时剪枝（不进子树）。 */
export function walk(node, visit, parent = null, path = '0') {
  if (!node || typeof node !== 'object') return;
  if (visit(node, parent, path) === false) return;
  for (const { key, node: child } of childrenOf(node)) {
    if (child) walk(child, visit, node, `${path}.${key}`);
  }
}

const CHILDREN_OF = {
  group: (n) => (n.items || []).map((node, i) => ({ node, key: String(i) })),
  script: (n) => [
    { node: n.base, key: 'base' },
    ...(n.sub ? [{ node: n.sub, key: 'sub' }] : []),
    ...(n.sup ? [{ node: n.sup, key: 'sup' }] : []),
  ],
  frac: (n) => [{ node: n.num, key: 'num' }, { node: n.den, key: 'den' }],
  styled: (n) => [{ node: n.body, key: 'body' }],
  accent: (n) => [{ node: n.body, key: 'body' }],
  root: (n) => [...(n.index ? [{ node: n.index, key: 'index' }] : []), { node: n.body, key: 'body' }],
  arrow: (n) => [{ node: n.above, key: 'above' }, ...(n.below ? [{ node: n.below, key: 'below' }] : [])],
  stack: (n) => (n.rows || []).flatMap((row, r) => (row || []).map((node, c) => ({ node, key: `${r}.${c}` }))),
  env: (n) => (n.rows || []).flatMap((row, r) =>
    (row || []).flatMap((cell, c) => (cell || []).map((node, k) => ({ node, key: `${r}.${c}.${k}` })))),
  phantom: (n) => [{ node: n.body, key: 'body' }],
  label: (n) => (n.text || []).map((node, i) => ({ node, key: String(i) })),
};

/** 一个节点的直接子节点（有序，带它们在父里的角色名）。 */
export function* childrenOf(node) {
  const fn = CHILDREN_OF[node.kind];
  if (fn) yield* fn(node);
}

const SHAPE_KEY = {
  sym: (n) => `sym:${n.tex}`,
  num: (n) => `num:${n.literal}`,
  op: (n) => `op:${n.tex}`,
  ellipsis: (n) => `ellipsis:${n.tex}`,
  bigop: (n) => `bigop:${n.tex}`,
  fence: (n) => `fence:${n.glyph || ''}`,
  script: (n) => `script(${shapeKey(n.base)}/${n.sub ? shapeKey(n.sub) : ''}/${n.sup ? shapeKey(n.sup) : ''})`,
  frac: (n) => `frac:${n.fractionStyle}(${shapeKey(n.num)}/${shapeKey(n.den)})`,
  group: (n) => {
    const items = n.items || [];
    if (!n.fence && items.length === 1) return shapeKey(items[0]);
    const body = items.map(shapeKey).join('·');
    return n.fence ? `group${n.fence.open}${body}${n.fence.close}` : `group(${body})`;
  },
  styled: (n) => (n.style === 'bold' || n.style === 'bold-italic'
    ? shapeKey(n.body)
    : `styled:${n.style}(${shapeKey(n.body)})`),
  accent: (n) => `accent:${n.accent}(${shapeKey(n.body)})`,
  root: (n) => `root:${n.index ? shapeKey(n.index) : ''}(${shapeKey(n.body)})`,
  arrow: (n) => `arrow:${n.dir}(${shapeKey(n.above)}/${n.below ? shapeKey(n.below) : ''})`,
  stack: (n) => `stack:${n.stackKind}(${(n.rows || []).map((r) => r.map(shapeKey).join('·')).join('|')})`,
  env: (n) => `env:${n.env}(${(n.rows || []).map((r) => r.map((c) => c.map(shapeKey).join('·')).join('&')).join('|')})`,
  literal: (n) => `literal:${n.literalMode}:${n.text}`,
  space: (n) => `space:${n.tex}`,
  rowbreak: () => 'rowbreak',
  phantom: (n) => `phantom(${shapeKey(n.body)})`,
  label: (n) => `label:${(n.text || []).map(shapeKey).join('·')}`,
  raw: (n) => `raw:${n.tex}`,
};

export function shapeKey(node) {
  if (!node) return '∅';
  const fn = SHAPE_KEY[node.kind];
  return fn ? fn(node) : `${node.kind}:?`;
}

export function toPlain(expr) {
  return foldPlain(expr.root);
}

const FOLD_PLAIN = {
  sym: (n) => n.glyph ?? n.tex ?? '',
  num: (n) => n.literal,
  op: (n) => n.glyph ?? n.tex ?? '',
  ellipsis: (n) => n.glyph ?? '…',
  bigop: (n) => n.glyph ?? '',
  fence: (n) => n.glyph ?? '',
  script: (n) => `${foldPlain(n.base)}${n.sub ? foldPlain(n.sub) : ''}${n.sup ? foldPlain(n.sup) : ''}`,
  frac: (n) => `${foldPlain(n.num)}/${foldPlain(n.den)}`,
  group: (n) => (n.items || []).map(foldPlain).join(''),
  styled: (n) => foldPlain(n.body),
  accent: (n) => foldPlain(n.body),
  root: (n) => `√${foldPlain(n.body)}`,
  arrow: (n) => (n.dir === 'right' ? '→' : '←'),
  stack: (n) => (n.rows || []).map((r) => r.map(foldPlain).join('')).join(''),
  env: (n) => (n.rows || []).map((r) => r.map((c) => c.map(foldPlain).join('')).join(' ')).join('; '),
  literal: (n) => n.text,
  space: () => ' ',
  rowbreak: () => ' ',
  phantom: () => '',
  label: (n) => (n.text || []).map(foldPlain).join(''),
  raw: (n) => n.tex.replace(/\\/g, ''),
};

function foldPlain(node) {
  if (!node) return '';
  const fn = FOLD_PLAIN[node.kind];
  return fn ? fn(node) : '';
}

export function digest(expr) {
  return hash32(JSON.stringify(canonical(expr.root)));
}

function firstDefined(vals) {
  return vals.find((v) => v !== undefined) ?? null;
}

function canonicalFields(node) {
  return {
    k: node.kind,
    r: node.role,
    t: node.term ? `${node.term.pack}:${node.term.entry}` : null,
    x: firstDefined([node.tex, node.glyph, node.literal, node.text, node.env]),
    f: node.fence ?? null,
    s: firstDefined([node.fractionStyle, node.style, node.accent]),
  };
}

function canonical(node) {
  if (!node) return null;
  const kids = {};
  for (const { key, node: child } of childrenOf(node)) kids[key] = canonical(child);
  return {
    ...canonicalFields(node),
    c: Object.keys(kids).length ? kids : undefined,
  };
}

/** 32 位 FNV-1a：够用、无依赖、结果稳定。 */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 术语命中集：**从树直接读**，不爬 `data-term`、不解析 HTML。
 *
 * 这是「同一份数据双投影」里的文本侧：AI / 搜索 / MCP 需要知道
 * 「这页有哪些符号、各指向哪个词条」，答案在这里，不在渲染产物里。
 */
export function collectTerms(expr) {
  const hits = [];
  walk(expr.root, (n) => {
    if (n.term) hits.push({ node: n.id, ref: n.term, shape: shapeKey(n) });
  });
  return hits;
}

/** 节点总数（诊断与「这页公式多复杂」的量尺）。 */
export function nodeCount(expr) {
  let n = 0;
  walk(expr.root, () => { n += 1; });
  return n;
}
