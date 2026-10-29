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
  const keepGoing = visit(node, parent, path);
  if (keepGoing === false) return;
  for (const child of childrenOf(node)) {
    if (child && child.node) walk(child.node, visit, node, `${path}.${child.key}`);
  }
}

/** 一个节点的直接子节点（有序，带它们在父里的角色名）。 */
export function* childrenOf(node) {
  switch (node.kind) {
    case 'group':
      for (let i = 0; i < (node.items || []).length; i += 1) yield { node: node.items[i], key: String(i) };
      break;
    case 'script':
      yield { node: node.base, key: 'base' };
      if (node.sub) yield { node: node.sub, key: 'sub' };
      if (node.sup) yield { node: node.sup, key: 'sup' };
      break;
    case 'frac':
      yield { node: node.num, key: 'num' };
      yield { node: node.den, key: 'den' };
      break;
    case 'styled':
      yield { node: node.body, key: 'body' };
      break;
    case 'accent':
      yield { node: node.body, key: 'body' };
      break;
    case 'root':
      if (node.index) yield { node: node.index, key: 'index' };
      yield { node: node.body, key: 'body' };
      break;
    case 'arrow':
      yield { node: node.above, key: 'above' };
      if (node.below) yield { node: node.below, key: 'below' };
      break;
    case 'stack':
      for (let r = 0; r < (node.rows || []).length; r += 1) {
        for (let c = 0; c < (node.rows[r] || []).length; c += 1) {
          yield { node: node.rows[r][c], key: `${r}.${c}` };
        }
      }
      break;
    case 'env':
      for (let r = 0; r < (node.rows || []).length; r += 1) {
        for (let c = 0; c < (node.rows[r] || []).length; c += 1) {
          for (let k = 0; k < (node.rows[r][c] || []).length; k += 1) {
            yield { node: node.rows[r][c][k], key: `${r}.${c}.${k}` };
          }
        }
      }
      break;
    case 'phantom':
      yield { node: node.body, key: 'body' };
      break;
    case 'label':
      for (let i = 0; i < (node.text || []).length; i += 1) yield { node: node.text[i], key: String(i) };
      break;
    default:
      break;
  }
}

/**
 * 形状键：**结构等价类的字符串形式**，与书写细节无关。
 *
 * 这是「贴合 MATLAB 语义」落地的地方：`R_L` 与 `R_{L}` 是**同一个键**，
 * 因为它们在树上都是 `script(sym:R/ sym:L)`。旧实现里它们是两个不同字符串，
 * 词典写哪个就漏另一个——实测这类漏网在 191 条 match 声明里广泛存在。
 *
 * 形状键不含：`span`（位置）、`term`（身份）、`style`（外观）。
 * 含：`kind`、以及决定语义的那些字段（`tex`、`fence`、环境名）。
 */
export function shapeKey(node) {
  if (!node) return '∅';
  switch (node.kind) {
    case 'sym':
      // 函数名与普通符号分开：`\sin` 的 tex 是 `\sin`，本身就是区分开的
      return `sym:${node.tex}`;
    case 'num':
      return `num:${node.literal}`;
    case 'op':
      return `op:${node.tex}`;
    case 'ellipsis':
      return `ellipsis:${node.tex}`;
    case 'bigop':
      return `bigop:${node.tex}`;
    case 'fence':
      return `fence:${node.glyph || ''}`;
    case 'script': {
      // 上下标位置的**纯包装组要拍平**：`R_m` 与 `R_{L}` 的差别只是后者多写了一对
      // 花括号。group 的 shapeKey 在「单元素无定界符」时已经拍平了
      // （见 group 分支），所以这里直接取即可——两者必得同一个键。
      const sub = node.sub ? shapeKey(node.sub) : '';
      const sup = node.sup ? shapeKey(node.sup) : '';
      return `script(${shapeKey(node.base)}/${sub}/${sup})`;
    }
    case 'frac':
      return `frac:${node.fractionStyle}(${shapeKey(node.num)}/${shapeKey(node.den)})`;
    case 'group': {
      const items = node.items || [];
      // 透明组（无定界符）在形状键里要**拍平**：`R_L` 与 `R_{L}` 是同一个东西，
      // 差别只是后者多写了一对花括号。不拍平的话词典写 `R_L` 就漏掉 `R_{L}`
      // ——旧实现里这类漏网在 191 条 match 声明里广泛存在。
      if (!node.fence && items.length === 1) return shapeKey(items[0]);
      const body = items.map(shapeKey).join('·');
      return node.fence ? `group${node.fence.open}${body}${node.fence.close}` : `group(${body})`;
    }
    case 'styled':
      // 样式**参与**形状键，但要分清哪一类：
      //   · 粗体类（`\mathbf{F}`）只是强调，`F` 与 `\mathbf F` 是同一个符号 ⇒ 拍平
      //   · 正体类（`\mathrm{d}`）是**不同的记号**：`d`（直径，斜体变量）与
      //     `\mathrm d`（微分号）是两个词条，实测冲突就是由此而来
      //   · 其余（花体、哥特体、双线体）通常对应不同的数学对象（集合 vs 变量）⇒ 保留
      if (node.style === 'bold' || node.style === 'bold-italic') return shapeKey(node.body);
      return `styled:${node.style}(${shapeKey(node.body)})`;
    case 'accent':
      return `accent:${node.accent}(${shapeKey(node.body)})`;
    case 'root':
      return `root:${node.index ? shapeKey(node.index) : ''}(${shapeKey(node.body)})`;
    case 'arrow':
      return `arrow:${node.dir}(${shapeKey(node.above)}/${node.below ? shapeKey(node.below) : ''})`;
    case 'stack':
      return `stack:${node.stackKind}(${(node.rows || []).map(r => r.map(shapeKey).join('·')).join('|')})`;
    case 'env': {
      const body = (node.rows || [])
        .map((r) => r.map((c) => c.map(shapeKey).join('·')).join('&'))
        .join('|');
      return `env:${node.env}(${body})`;
    }
    case 'literal':
      // 字面模式参与键：`\text{H/m}` 与 `\mathrm{H/m}` 语义不同（一个当文字、一个当单位）
      return `literal:${node.literalMode}:${node.text}`;
    case 'space':
      return `space:${node.tex}`;
    case 'rowbreak':
      return 'rowbreak';
    case 'phantom':
      return `phantom(${shapeKey(node.body)})`;
    case 'label':
      return `label:${(node.text || []).map(shapeKey).join('·')}`;
    case 'raw':
      return `raw:${node.tex}`;
    default:
      return `${node.kind}:?`;
  }
}

/**
 * 纯文本投影：标题锚点、读屏、搜索索引共用。
 *
 * ## 与旧 `mathPlain()` 的关系
 *
 * 旧实现是对 TeX **字符串**做正则替换（`\frac{a}{b}` → `a/b`、清掉反斜杠）。
 * 新实现从树折叠——同一个语义，但不会因为「正则没覆盖到某个写法」而输出
 * 一段带反斜杠的脏锚点（实测有标题变成 `#第一步-处理前两行-提出-math_inline_125`）。
 *
 * 阶段一要求输出与旧 `mathPlain()` 一致的**语义**（不要求逐字节），
 * 因为它决定全站目录链接；迁移时逐页比对锚点集合。
 */
export function toPlain(expr) {
  return foldPlain(expr.root);
}

function foldPlain(node) {
  if (!node) return '';
  switch (node.kind) {
    case 'sym':
      return node.glyph ?? node.tex ?? '';
    case 'num':
      return node.literal;
    case 'op':
      return node.glyph ?? node.tex ?? '';
    case 'ellipsis':
      return node.glyph ?? '…';
    case 'bigop':
      return node.glyph ?? '';
    case 'fence':
      return node.glyph ?? '';
    case 'script': {
      const base = foldPlain(node.base);
      const sub = node.sub ? foldPlain(node.sub) : '';
      const sup = node.sup ? foldPlain(node.sup) : '';
      return `${base}${sub}${sup}`;
    }
    case 'frac':
      return `${foldPlain(node.num)}/${foldPlain(node.den)}`;
    case 'group':
      return (node.items || []).map(foldPlain).join('');
    case 'styled':
      return foldPlain(node.body);
    case 'accent':
      return foldPlain(node.body);
    case 'root':
      return `√${foldPlain(node.body)}`;
    case 'arrow':
      return node.dir === 'right' ? '→' : '←';
    case 'stack':
      return (node.rows || []).map(r => r.map(foldPlain).join('')).join('');
    case 'env':
      return (node.rows || []).map(r => r.map(c => c.map(foldPlain).join('')).join(' ')).join('; ');
    case 'literal':
      return node.text;
    case 'space':
      return ' ';
    case 'rowbreak':
      return ' ';
    case 'phantom':
      return '';
    case 'label':
      return (node.text || []).map(foldPlain).join('');
    case 'raw':
      return node.tex.replace(/\\/g, '');
    default:
      return '';
  }
}

/**
 * 稳定摘要：同一份 IR 必得同一个值，用于全量回归时逐条比对。
 *
 * 不含 `span`（位置会随输入长度变化，但对「这条公式是什么」无关）。
 */
export function digest(expr) {
  return hash32(JSON.stringify(canonical(expr.root)));
}

function canonical(node) {
  if (!node) return null;
  const kids = {};
  for (const { key, node: child } of childrenOf(node)) kids[key] = canonical(child);
  return {
    k: node.kind,
    r: node.role,
    t: node.term ? `${node.term.pack}:${node.term.entry}` : null,
    x: node.tex ?? node.glyph ?? node.literal ?? node.text ?? node.env ?? null,
    f: node.fence ?? null,
    s: node.fractionStyle ?? node.style ?? node.accent ?? null,
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
