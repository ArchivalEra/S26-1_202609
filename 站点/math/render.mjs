/**
 * 渲染 adapter 契约 + KaTeX 实现。
 *
 * ## 这一层唯一的职责
 *
 * **IR → HTML**。它不做符号判定（那是 `terms.mjs` 的事），不读词典，
 * 不认识 `\text{}` 里该不该取词。它只把树上已有的 `term` 变成产物里的锚点。
 *
 * ## 为什么可以换引擎而不用改别的
 *
 * 实测两件事（2026-10-29）：
 *   ① 渲染器认 `\htmlData{term=x}{…}`，产物是 `<span data-term="x">`；
 *   ② 引擎不负责生成最终站内 `<a>` 锚点，所以锚点由本模块统一调 `formatSymbolAnchor` 包裹。
 */

import { formatSymbolAnchor } from '../symbols/contracts.mjs';

/** KaTeX 前端样式表在 dist 中的相对路径（随构建从 npm 包拷贝）。 */
export const KATEX_STYLESHEET = 'assets/katex/katex.min.css';

/** 目录提取前，将公式块换成文本，兼容历史 MathLive 标记与 annotation 回退。 */
export function replaceKatexWithText(html) {
  return html.replace(/<span class="ML__latex"[^>]*data-math-plain="([^"]*)"[\s\S]*?<\/span>/g,
    (markup, plain) => plain)
    .replace(/<span class="katex"[\s\S]*?<\/span><\/span><\/span>/g, (markup) => {
      const annotation = /<annotation encoding="application\/x-tex">([\s\S]*?)<\/annotation>/.exec(markup);
      return annotation ? annotation[1].replace(/&amp;/g, '&') : '';
    });
}

/**
 * 把 IR 编回 TeX。**这是唯一生成 `\htmlData` 的地方**。
 *
 * 关键设计：`\htmlData` 的位置由**树结构**决定，不由字符串搜索决定。
 * 旧实现在 TeX 字符串上找位置插宏，于是要写 `ARG_COMMANDS` 防劈命令、
 * `braceBareArgs` 补花括号——两个补丁都在防同一类事故。这里没有这个位置。
 */
const STYLE_COMMANDS = {
  bold: 'mathbf',
  upright: 'mathrm',
  italic: 'mathit',
  cal: 'mathcal',
  'double-struck': 'mathbb',
  fraktur: 'mathfrak',
  sans: 'mathsf',
  mono: 'mathtt',
  'bold-italic': 'boldsymbol',
};

const isPrimeTex = (t) => t === "'" || t === '′' || /^'+$/.test(t);

function needsGroupSpace(items, k) {
  if (k <= 0) return false;
  const prevTex = String(items[k - 1].tex || '').trim();
  const curTex = String(items[k].tex || '').trim();
  return !isPrimeTex(prevTex) && !isPrimeTex(curTex);
}

function renderGroupTex(node, childOpts, opts, wrap) {
  const items = node.items || [];
  let inner = '';
  for (let k = 0; k < items.length; k += 1) {
    if (needsGroupSpace(items, k)) inner += ' ';
    inner += irToTex(items[k], childOpts);
  }
  if (node.fence) return wrap(`${node.fence.open}${inner}${node.fence.close}`);
  return opts._nested ? wrap(`{${inner}}`) : wrap(inner);
}

const TEX_RENDERERS = {
  sym: (n, _c, _o, wrap) => wrap(n.tex),
  num: (n, _c, _o, wrap) => wrap(n.literal),
  op: (n, _c, _o, wrap) => wrap(n.tex),
  ellipsis: (n, _c, _o, wrap) => wrap(n.tex),
  bigop: (n, _c, _o, wrap) => wrap(n.tex),
  fence: (n, _c, _o, wrap) => n.tex || wrap(n.glyph || ''),
  script: (n, c, _o, wrap) => {
    let s = irToTex(n.base, c);
    if (n.sub) s += `_{${irToTex(n.sub, c)}}`;
    if (n.sup) s += `^{${irToTex(n.sup, c)}}`;
    return wrap(s);
  },
  frac: (n, c, _o, wrap) => wrap(`\\${fracCommand(n.fractionStyle)}{${irToTex(n.num, c)}}{${irToTex(n.den, c)}}`),
  group: (n, c, o, wrap) => renderGroupTex(n, c, o, wrap),
  styled: (n, c, _o, wrap) => {
    const body = irToTex(n.body, c);
    if (n.style === 'operator-name') return wrap(`\\operatorname{${body}}`);
    return wrap(`\\${STYLE_COMMANDS[n.style] || 'mathrm'}{${body}}`);
  },
  accent: (n, c, _o, wrap) => wrap(`\\${n.accent}{${irToTex(n.body, c)}}`),
  root: (n, c, _o, wrap) => wrap(`\\sqrt${n.index ? `[${irToTex(n.index, c)}]` : ''}{${irToTex(n.body, c)}}`),
  arrow: (n, c, _o, wrap) => wrap(`${n.tex}${n.below ? `[${irToTex(n.below, c)}]` : ''}{${irToTex(n.above, c)}}`),
  stack: (n, c, _o, wrap) => {
    const rows = (n.rows || []).map((r) => r.map((x) => irToTex(x, c)).join(' ')).join(' \\\\ ');
    return n.stackKind === 'substack' ? wrap(`\\substack{${rows}}`) : wrap(`\\begin{matrix}${rows}\\end{matrix}`);
  },
  env: (n, c, _o, wrap) => {
    const body = (n.rows || []).map((r) => r.map((col) => col.map((x) => irToTex(x, c)).join(' ')).join(' & ')).join(' \\\\ ');
    const colSpec = n.columnSpec ? `{${n.columnSpec}}` : '';
    return wrap(`\\begin{${n.env}}${colSpec}${body}\\end{${n.env}}`);
  },
  literal: (n, _c, _o, wrap) => wrap(`\\text{${n.text}}`),
  space: (n) => n.tex || '\\,',
  rowbreak: () => ' \\\\ ',
  phantom: (n, c) => `\\phantom{${irToTex(n.body, c)}}`,
  label: (n, c, o) => (o.dialect === 'katex' ? `\\tag{${(n.text || []).map((x) => irToTex(x, c)).join(' ')}}` : ''),
  raw: (n) => n.tex,
};

export function irToTex(node, opts = {}) {
  if (!node) return '';
  const { decorate = true } = opts;
  const childOpts = opts._nested ? opts : { ...opts, _nested: true };
  const wrap = (inner) => {
    if (!decorate || !node.term) return inner;
    const key = `${node.term.pack}:${node.term.entry}`.replace(/[{}]/g, '');
    return `\\htmlData{term=${key}}{${inner}}`;
  };
  const fn = TEX_RENDERERS[node.kind];
  return fn ? fn(node, childOpts, opts, wrap) : '';
}

const fracCommand = (style) => {
  if (style === 'display') return 'dfrac';
  if (style === 'text') return 'tfrac';
  return 'frac';
};

/**
 * 方言变换：把 IR 编出的 TeX 调成目标引擎能吃的写法。
 *
 * ## 为什么单独一层
 *
 * 实测 MathLive 0.111.1 与 KaTeX 的差异是**方言**，不是语义：
 *   · `\dots` / `\tag` / `\substack` 三个命令它不认；
 *   · `\end{env}` 后面紧跟命令（哪怕只隔换行）会被它解析成命令名的一部分，
 *     必须在中间插 `{}` 分隔。
 *
 * 这些差异集中在这一个纯函数里，就成了**可数、可测、可回归**的一张清单；
 * 散在 adapter 各处就变成「渲染随机爆」。
 */
export const DIALECTS = {
  katex: { name: 'katex', unsupported: [] },
  mathlive: {
    name: 'mathlive',
    /** 已知需要改写的构造（用于诊断与文档）。 */
    unsupported: ['\\dots', '\\tag', '\\substack', '\\end{…} 后接命令'],
  },
};

function findMatchingBrace(s, open) {
  let depth = 0;
  let i = open;
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === '{') depth += 1;
    else if (s[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function rewriteSubstack(s, rewrites) {
  if (!/\\substack\{/.test(s)) return s;
  let out = s;
  for (let guard = 0; guard < 20 && out.includes('\\substack{'); guard += 1) {
    const at = out.indexOf('\\substack{');
    const open = at + '\\substack'.length;
    const close = findMatchingBrace(out, open);
    if (close < 0) break;
    out = `${out.slice(0, at)}\\begin{smallmatrix}${out.slice(open + 1, close)}\\end{smallmatrix}${out.slice(close + 1)}`;
  }
  rewrites.push('\\substack→smallmatrix');
  return out;
}

export function toDialect(tex, dialectName) {
  if (dialectName !== 'mathlive') return { tex, rewrites: [] };
  const rewrites = [];
  let s = tex;
  if (/\\dots(?![a-zA-Z])/.test(s)) {
    s = s.replace(/\\dots(?![a-zA-Z])/g, '\\ldots');
    rewrites.push('\\dots→\\ldots');
  }
  s = rewriteSubstack(s, rewrites);
  if (/\\tag\*?\{/.test(s)) {
    s = s.replace(/\\tag\*?\{[^{}]*\}/g, '');
    rewrites.push('\\tag→外置');
  }
  // 环境边界两侧都要分隔：MathLive 的解析器会把 `\end{pmatrix}\longrightarrow`
  // 里的 `\longrightarrow` 当成 `pmatrix` 之后紧接着的裸反斜杠命令而报 unknown-command。
  // 判据是实测：`\end{X}` 与相邻命令之间插 `{}` 后 11514 条全部通过。
  if (/\\end\{[^{}]+\}/.test(s)) {
    const before = s;
    // 环境边界两侧都要**紧贴**插 `{}`：MathLive 把 `\end{X}` 后面的一切都当续接，
    // 中间的空白（空格、换行）不算分隔。实测：`\end{pmatrix}\longrightarrow` 与
    // `\end{pmatrix}\n\longrightarrow` 都报 unknown-command:\begin。
    // 所以 `{}` 要插在**紧贴**位置，不能保留原空白在 `{}` 之前。
    s = s.replace(/(\\end\{[^{}]+\})(\s*)(?=\\)/g, '$1{}$2');
    // `\begin{env}` **前面**也要分隔：`\longrightarrow \begin{pmatrix}` 会让它把
    // `\begin` 当成上一条命令的续接（实测 unknown-command:\begin）。
    // 只在「前面紧邻的是命令或组结束」时插 `{}`，不能在 `{` 之后插
    // （否则 `\xrightarrow{\begin{…}…}` 的**参数**会被 `{}` 顶掉）。
    s = s.replace(/(\\[a-zA-Z]+|[}\]])(\s*)(\\begin\{)/g, '$1{}$2$3');
    if (s !== before) rewrites.push('环境边界插 {}');
  }
  return { tex: s, rewrites };
}

/**
 * 展示引擎只有一个：KaTeX（见下方 createKatexRenderer）。
 *
 * 2026-10-31 删除 MathLive 渲染 adapter：站长定案「MathLive 的拉伸括号由
 * ⎛⎜⎝/⎞⎟⎠ 小片拼成，接缝处有亚像素缝」，展示改回 KaTeX 之后这个 adapter
 * 就没有消费者了（构建期走 createKatexRenderer、聊天面板走 katex.renderToString）。
 * MathLive 只以**浏览器版**留在能力包里，用途是 math-field 的编辑交互——
 * 那是另一种需求，不是排版。
 */

/**
 * KaTeX 渲染 adapter（2026-10-30 站长定案：展示用 KaTeX，编辑用 MathLive）。
 *
 * ## 为什么换回来
 *
 * MathLive 的**拉伸括号是拼出来的**：`\left( \right)` 被拆成
 * `⎛⎜⎝` / `⎞⎟⎠` 若干小片纵向拼接。相邻两片之间必然留亚像素缝——
 * 这是它实现方式决定的，不是参数没调好、也不是 CSS 能修的。
 * 表现就是看大括号/矩阵/分式时那圈「虚线感」。KaTeX 用字形的伸展机制，没有这个缝。
 *
 * ## 为什么这次换不欠债
 *
 * 上一轮把引擎换掉、又换回来，看起来像打脸——但结构变了：
 * 解析器与 IR 是**我们自己的**（`lexer`/`parser`/`ir`/`terms` 不动），
 * 渲染器只是最末端的 adapter（`{id, caps, render, probe}` 三件套）。
 * 换引擎 = 换一个 adapter 实现 + 一张方言表，其余零改动。
 * 这正是当初说「契约是 `<span data-term>`，换任何能满足它的引擎都不用改」的兑现。
 *
 * ## 标注怎么带过去
 *
 * IR 的 `term` 字段由 `irToTex({decorate:true})` 编成 `\htmlData{term=pack:entry}{…}`。
 * KaTeX 认这个宏（需要 `trust` 放行 `\htmlData` + `strict:false`），
 * 产出的正是 `<span data-term="…">`——与 MathLive 同一种 substrate，
 * 所以下游的 `decorateAnchors` **一行都不用改**。
 *
 * @param {{renderToString: Function, version?: string}} katex
 * @returns {Renderer}
 */
function renderKatexSafe(katex, tex, opts, expr, problems) {
  try {
    const html = katex.renderToString(tex, opts);
    if (/katex-error/.test(html)) {
      problems.push({ code: 'render-error-markup', severity: 'error', where: { source: expr.source }, message: '产物里出现 katex-error（这条公式排不了）', hint: tex.slice(0, 120) });
      return null;
    }
    return html;
  } catch (e) {
    problems.push({ code: 'render-failed', severity: 'error', where: { source: expr.source }, message: `KaTeX 渲染失败：${e.message}`, hint: tex.slice(0, 120) });
    return null;
  }
}

export function createKatexRenderer(katex) {
  const OPTS = {
    throwOnError: false,
    errorColor: 'inherit',
    output: 'html',
    // `strict:false` 是 `\htmlData` 的前提（否则 KaTeX 把 HTML 扩展判为不合规）。
    // 我们自己控制输入（IR 产物），不接用户任意 TeX，所以这里没有注入风险。
    strict: false,
    trust: (ctx) => ['\\htmlData', '\\htmlClass', '\\htmlId', '\\htmlStyle'].includes(ctx.command),
  };

  return {
    id: 'katex',
    caps: { markSubstrate: true, producesMathml: true, producesAnnotation: true },

    render(expr) {
      const problems = [];
      const raw = irToTex(expr.root, { decorate: true, dialect: 'katex' });
      const { tex, rewrites } = toDialect(raw, 'katex');
      const opts = expr.mode === 'display' ? { ...OPTS, displayMode: true } : OPTS;
      let html = renderKatexSafe(katex, tex, opts, expr, problems);
      if (html === null) return { html: fallbackHtml(expr), tex, problems, rewrites };

      // 把 IR 的纯文本投影烘进 aria-label / data-math-plain（与 MathLive 版同一套约定）：
      // 读屏念人话、AI 与搜索索引拿同一份文本，都不必从产物里剥 LaTeX。
      //
      // 同时烘 `data-math-tex` = **作者原始写的 LaTeX**（`expr.source`，不含 `$`）。
      // 为什么不重建：用 irToTex 从 IR 反推会把 `U_{ab}` 拆成 `U_{{a b}}`（实测），
      // 下标里的空白与嵌套变了，意思也可能变；而编辑器的初始值必须是作者亲手写的
      // 那串——MathLive 能吃、用户改起来也认得出。
      // 这个属性是能力包「点公式进 MathLive 编辑」的**唯一数据来源**：
      // data-math-plain 是纯文本投影（`x1,x2,x3` 这种），喂进编辑器会当场改错公式。
      const plain = expr.plainHint || '';
      const srcTex = expr.source || '';
      const attrs = [];
      if (plain) {
        attrs.push('role="math"');
        attrs.push(`aria-label="${escapeAttr(plain)}"`);
        attrs.push(`data-math-plain="${escapeAttr(plain)}"`);
      }
      if (srcTex) attrs.push(`data-math-tex="${escapeAttr(srcTex)}"`);
      if (attrs.length) {
        // ⚠️ 不能锚在行首（`^`）：display 模式下 KaTeX 产的是
        // `<span class="katex-display"><span class="katex">…`，`.katex` 在第二层，
        // 锚行首就一个属性都注不上（2026-10-31 实测：38 条显示式公式全缺 tex）。
        // `class="katex"` 带闭引号，所以不会误中 `class="katex-display"`。
        html = html.replace('<span class="katex"', `<span class="katex" ${attrs.join(' ')}`);
      }
      return { html, tex, problems, rewrites };
    },

    probe() {
      const problems = [];
      const out = katex.renderToString('B=\\htmlData{term=sym-B}{B}', OPTS);
      if (!out.includes('data-term')) {
        problems.push({
          code: 'adapter-contract',
          severity: 'error',
          where: {},
          message: '渲染器不认 \\htmlData{term=…}——标注会静默消失，适配器契约不成立',
        });
      }
      return problems;
    },
  };
}

/** 渲染失败时的降级：显示原文而不是空白。 */
function fallbackHtml(expr) {
  return `<span class="math-fallback" data-tex="${escapeAttr(expr.source)}">${escapeHtml(expr.source)}</span>`;
}

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeHtml(s).replace(/"/g, '&quot;');

/**
 * 把产物里的 `<span data-term="…">` 包成可点的锚点。
 *
 * ## 为什么必须在渲染之后做，而不是让渲染器直接产 `<a>`
 *
 * 实测：KaTeX 与 MathLive **都不产 `<a>`**；MathLive 的 `\href` 拒绝相对锚点
 * （报 `Invalid URL`），只给 `<span href>`。所以「锚点是链接」这件事只能在这一层补，
 * 而这一层的输入是 `<span data-term>` 这个**最小契约**——换任何能满足它的引擎都不用改。
 *
 * @param {string} html
 * @param {{resolve: (key: string) => {href: string, label?: string} | null}} opts
 * @returns {{html: string, decorated: number, missing: string[]}}
 */
function findSpanClose(html, from) {
  let depth = 1;
  let i = from;
  while (i < html.length && depth > 0) {
    const nextOpen = html.indexOf('<span', i);
    const nextClose = html.indexOf('</span>', i);
    if (nextClose < 0) return -1;
    if (nextOpen >= 0 && nextOpen < nextClose) { depth++; i = nextOpen + 5; }
    else { depth--; i = nextClose + 7; }
  }
  return depth === 0 ? i : -1;
}

export function decorateAnchors(html, opts) {
  const missing = [];
  let decorated = 0;
  const out = [];
  const openRe = /<span\b[^>]*?\bdata-term="([^"]*)"[^>]*>/g;
  let last = 0;
  let m;
  while ((m = openRe.exec(html)) !== null) {
    const end = findSpanClose(html, openRe.lastIndex);
    if (end < 0) continue;
    const start = m.index;
    const key = m[1];
    const inner = html.slice(openRe.lastIndex, end - 7);
    const hit = opts.resolve(key);
    if (!hit) {
      missing.push(key);
      openRe.lastIndex = end;
      continue;
    }
    decorated += 1;
    out.push(html.slice(last, start));
    out.push(formatSymbolAnchor({
      key,
      href: hit.href,
      label: hit.label || key,
      innerHtml: inner,
    }));
    last = end;
    openRe.lastIndex = end;
  }
  out.push(html.slice(last));
  return { html: out.join(''), decorated, missing };
}
