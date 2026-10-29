/**
 * 命令表：125 个命令的语义分类。**这是全站公式语料的实测边界，不是 TeX 全集的子集**。
 *
 * ## 这份表从哪来
 *
 * 2026-10-29 对**全仓 11514 条现存公式**做了命令计数（脚本见 `.zcode/` 的语料测绘），
 * 得出：**125 个控制序列、6 个环境**。这份表就是那 125 个 + 为「同类但尚未出现」
 * 留的少量余量。
 *
 * ## 为什么是一张显式表，而不是「不认识的命令一律放过」
 *
 * 因为「不认识的命令」是本仓最容易悄悄坏掉的一类：写错一个字母（`\mathord` 写成
 * `\mathor`）渲染器可能画出空白、也可能画成红字，而构建报表显示 0 错。
 * 显式表把「不认识」变成一条**带位置的构建错误**，与新架构的零回退原则一致。
 *
 * ## 五种角色（role）
 *
 * | role | 含义 | 解析器怎么处理 | 例子 |
 * | :--- | :--- | :--- | :--- |
 * | `symbol`   | 自带字形、没有参数 | 产出叶子节点 | `\alpha` `\infty` `\cdot` |
 * | `function` | 函数名，正体排，可能带参数 | 叶子 + 可选 apply | `\sin` `\det` `\max` |
 * | `accent`   | 一个参数、画在上方 | 吃 1 个原子 | `\overline` `\hat` `\vec` |
 * | `frac`     | 两个参数的分数类 | 吃 2 个组 | `\frac` `\dfrac` `\tfrac` |
 * | `stretch`  | 可伸缩定界符 / 箭头，带可选参数 | 特殊处理 | `\left` `\xrightarrow` |
 *
 * 另有 `style`（`\mathbf` `\mathrm` `\boldsymbol`）、`space`（`\quad` `\,`）、
 * `environment`（`\begin` `\end`）、`ignore`（`\limits` `\left.` 的空白）几类。
 */

/** 自带字形、无参数的符号 → 渲染时的字形（MathLive 用同一套命令名，这里只登记语义）。 */
export const SYMBOLS = {
  // ── 希腊字母（小写）
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ',
  varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ',
  varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  // ── 希腊字母（大写）
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  // ── 运算与关系
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓',
  neq: '≠', ne: '≠', approx: '≈', equiv: '≡', cong: '≅', sim: '∼', propto: '∝',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', ll: '≪', gg: '≫',
  leqslant: '⩽', geqslant: '⩾',
  to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔',
  Rightarrow: '⇒', Longrightarrow: '⟹', Longleftrightarrow: '⟺', iff: '⟺',
  longrightarrow: '⟶', longleftarrow: '⟵',
  uparrow: '↑', downarrow: '↓',
  partial: '∂', nabla: '∇', infty: '∞',
  int: '∫', oint: '∮', sum: '∑',
  in: '∈', notin: '∉', ni: '∋',
  oplus: '⊕', odot: '⊙',
  circ: '∘', angle: '∠', triangle: '△', parallel: '∥', mid: '∣',
  prime: '′', backslash: '∖', blacksquare: '■', boxed: '□',
  lvert: '|', rvert: '|', vert: '|', lVert: '‖', rVert: '‖',
  langle: '⟨', rangle: '⟩', lbrace: '{', rbrace: '}',
  lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉',
  // ── 省略号
  cdots: '⋯', ldots: '…', dots: '…', vdots: '⋮', ddots: '⋱',
};

/** 函数名：正体排，不带斜体。 */
export const FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
  'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh',
  'exp', 'log', 'ln', 'lg',
  'max', 'min', 'sup', 'inf', 'lim', 'limsup', 'liminf',
  'det', 'dim', 'ker', 'deg', 'arg', 'gcd', 'lcm',
  'mod', 'bmod',
]);

/** 带「上划/上帽」类：吃一个原子，画在上方。 */
export const ACCENTS = {
  overline: 'overline', bar: 'bar', hat: 'hat', widehat: 'widehat',
  vec: 'vec', dot: 'dot', ddot: 'ddot', tilde: 'tilde', widetilde: 'widetilde',
  overrightarrow: 'overrightarrow', overleftarrow: 'overleftarrow',
  underbrace: 'underbrace', overbrace: 'overbrace',
};

/** 分数类：吃两个组。 */
export const FRACTIONS = {
  frac: 'auto', dfrac: 'display', tfrac: 'text', cfrac: 'display',
  binom: 'binom', dbinom: 'binom', tbinom: 'binom',
};

/** 字体样式类：吃一个组，改字形外观（不参与符号判定）。 */
export const STYLES = {
  mathbf: 'bold', mathrm: 'upright', mathit: 'italic', mathcal: 'cal',
  mathbb: 'double-struck', mathfrak: 'fraktur', mathsf: 'sans',
  mathtt: 'mono', boldsymbol: 'bold-italic', bm: 'bold-italic',
  operatorname: 'operator-name',
};

/** 空白：无可见内容，只有宽度。 */
export const SPACES = {
  quad: '1em', qquad: '2em',
  ',': '0.167em', ':': '0.222em', ';': '0.278em', '!': '-0.167em',
  ' ': '0.25em', '\\': null,   // `\\` 单独处理（换行）
};

/** 定界符命令 → 实际字形。`\left`/`\right` 后面接它。 */
export const DELIMITERS = {
  '(': '(', ')': ')', '[': '[', ']': ']', '|': '|', '.': '',
  '\\{': '{', '\\}': '}',
  lbrace: '{', rbrace: '}', langle: '⟨', rangle: '⟩',
  lvert: '|', rvert: '|', vert: '|',
  lVert: '‖', rVert: '‖',
  lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉',
  uparrow: '↑', downarrow: '↓', backslash: '∖',
};

/**
 * 需要特殊语法的命令。
 *
 * - `left` / `right`：吃一个定界符记号；`\left.` 是「不画这一侧」。
 * - `xrightarrow` / `xleftarrow`：可选参数（下）+ 必选参数（上）。
 * - `overset` / `underset` / `stackrel`：两个参数叠放。
 * - `substack`：多行堆叠，行内用 `\\` 分隔。
 * - `tag`：公式编号；网页上外置为块级标签，不进排版流。
 * - `text` / `mbox` / `hbox`：「当文字排」，内容原样保留，**不参与符号判定**。
 * - `begin` / `end`：环境边界。
 * - `limits` / `nolimits`：只影响排版位置，解析期忽略。
 */
export const SPECIAL = new Set([
  'left', 'right', 'middle',
  'xrightarrow', 'xleftarrow', 'sqrt',
  'overset', 'underset', 'stackrel',
  'substack',
  'tag',
  'text', 'mbox', 'hbox', 'textnormal', 'textrm', 'textsf', 'texttt',
  'begin', 'end',
  'limits', 'nolimits',
  'phantom', 'hphantom', 'vphantom',
  'color', 'textcolor',
  'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr',
  'left.', 'right.',
]);

/** 允许出现的环境名（语料实测 6 个 + 2 个余量）。 */
export const ENVIRONMENTS = {
  pmatrix: { delims: ['(', ')'], columns: null },
  bmatrix: { delims: ['[', ']'], columns: null },
  vmatrix: { delims: ['|', '|'], columns: null },
  Vmatrix: { delims: ['‖', '‖'], columns: null },
  matrix: { delims: ['', ''], columns: null },
  cases: { delims: ['{', ''], columns: 'left' },
  array: { delims: ['', ''], columns: 'explicit' },  // \begin{array}{cc}
  aligned: { delims: ['', ''], columns: null },
  split: { delims: ['', ''], columns: null },
};

/**
 * 查一个控制序列是什么角色。
 *
 * @param {string} name 控制序列名（不含反斜杠）
 * @returns {{role: string, glyph?: string, style?: string, kind?: string, columns?: string}|null}
 *   null = **不认识**。调用方必须把它变成一条带位置的构建错误，不许静默放过。
 */
export function classifyCommand(name) {
  if (Object.hasOwn(SYMBOLS, name)) return { role: 'symbol', glyph: SYMBOLS[name] };
  if (FUNCTIONS.has(name)) return { role: 'function' };
  if (Object.hasOwn(ACCENTS, name)) return { role: 'accent', kind: ACCENTS[name] };
  if (Object.hasOwn(FRACTIONS, name)) return { role: 'frac', style: FRACTIONS[name] };
  if (Object.hasOwn(STYLES, name)) return { role: 'style', style: STYLES[name] };
  if (SPECIAL.has(name)) return { role: 'special' };
  return null;
}

/** 是否是空白类命令（`\quad` `\,` …）。 */
export function isSpaceCommand(name) {
  return Object.hasOwn(SPACES, name) && name !== '\\';
}
