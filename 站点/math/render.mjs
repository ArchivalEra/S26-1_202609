/**
 * 渲染 adapter 契约 + MathLive 实现。
 *
 * ## 这一层唯一的职责
 *
 * **IR → HTML**。它不做符号判定（那是 `terms.mjs` 的事），不读词典，
 * 不认识 `\text{}` 里该不该取词。它只把树上已有的 `term` 变成产物里的锚点。
 *
 * ## 为什么可以换引擎而不用改别的
 *
 * 实测两件事（2026-10-29）：
 *   ① MathLive 认 `\htmlData{term=x}{…}`，产物是 `<span data-term="x">`
 *      ——与 KaTeX 的机制同名同形；
 *   ② 两者都**不产** `<a>` 锚点（MathLive 的 `\href` 还拒绝相对锚点）。
 * 因此锚点由本模块统一包裹，与引擎无关——这正是「标注不寄生在渲染器语法上」。
 */

/**
 * 把 IR 编回 TeX。**这是唯一生成 `\htmlData` 的地方**。
 *
 * 关键设计：`\htmlData` 的位置由**树结构**决定，不由字符串搜索决定。
 * 旧实现在 TeX 字符串上找位置插宏，于是要写 `ARG_COMMANDS` 防劈命令、
 * `braceBareArgs` 补花括号——两个补丁都在防同一类事故。这里没有这个位置。
 */
export function irToTex(node, opts = {}) {
  const { decorate = true } = opts;
  if (!node) return '';

  const wrap = (inner) => {
    if (!decorate || !node.term) return inner;
    // 门牌号用词条键；escape 进属性值
    const key = `${node.term.pack}:${node.term.entry}`.replace(/[{}]/g, '');
    return `\\htmlData{term=${key}}{${inner}}`;
  };

  switch (node.kind) {
    case 'sym':
      return wrap(node.tex);
    case 'num':
      return wrap(node.literal);
    case 'op':
      return wrap(node.tex);
    case 'ellipsis':
      return wrap(node.tex);
    case 'bigop':
      return wrap(node.tex);
    case 'fence':
      // `\left(` / `\right)` 这类：tex 已含命令名
      return node.tex || wrap(node.glyph || '');
    case 'script': {
      const base = irToTex(node.base, opts);
      let s = base;
      if (node.sub) s += `_{${irToTex(node.sub, opts)}}`;
      if (node.sup) s += `^{${irToTex(node.sup, opts)}}`;
      return wrap(s);
    }
    case 'frac':
      return wrap(`\\${fracCommand(node.fractionStyle)}{${irToTex(node.num, opts)}}{${irToTex(node.den, opts)}}`);
    case 'group': {
      const inner = (node.items || []).map((i) => irToTex(i, opts)).join(' ');
      if (node.fence) return wrap(`${node.fence.open}${inner}${node.fence.close}`);
      return wrap(`{${inner}}`);
    }
    case 'styled': {
      const body = irToTex(node.body, opts);
      if (node.style === 'operator-name') return wrap(`\\operatorname{${body}}`);
      const cmd = { bold: 'mathbf', upright: 'mathrm', italic: 'mathit', cal: 'mathcal',
        'double-struck': 'mathbb', fraktur: 'mathfrak', sans: 'mathsf',
        mono: 'mathtt', 'bold-italic': 'boldsymbol' }[node.style] || 'mathrm';
      return wrap(`\\${cmd}{${body}}`);
    }
    case 'accent':
      return wrap(`\\${node.accent}{${irToTex(node.body, opts)}}`);
    case 'root': {
      const idx = node.index ? `[${irToTex(node.index, opts)}]` : '';
      return wrap(`\\sqrt${idx}{${irToTex(node.body, opts)}}`);
    }
    case 'arrow': {
      const below = node.below ? `[${irToTex(node.below, opts)}]` : '';
      // node.tex 已是 `\\xrightarrow` 这种自带反斜杠的形式，不要再加一个
      return wrap(`${node.tex}${below}{${irToTex(node.above, opts)}}`);
    }
    case 'stack': {
      if (node.stackKind === 'substack') {
        const rows = (node.rows || []).map((r) => r.map((n) => irToTex(n, opts)).join(' ')).join(' \\\\ ');
        return wrap(`\\substack{${rows}}`);
      }
      const rows = (node.rows || []).map((r) => r.map((n) => irToTex(n, opts)).join(' ')).join(' \\\\ ');
      return wrap(`\\begin{matrix}${rows}\\end{matrix}`);
    }
    case 'env': {
      const body = (node.rows || [])
        .map((r) => r.map((c) => c.map((n) => irToTex(n, opts)).join(' ')).join(' & '))
        .join(' \\\\ ');
      const colSpec = node.columnSpec ? `{${node.columnSpec}}` : '';
      return wrap(`\\begin{${node.env}}${colSpec}${body}\\end{${node.env}}`);
    }
    case 'literal':
      return wrap(`\\text{${node.text}}`);
    case 'space':
      return node.tex || '\\,';
    case 'rowbreak':
      return ' \\\\ ';
    case 'phantom':
      return `\\phantom{${irToTex(node.body, opts)}}`;
    case 'label':
      // 公式编号外置为块级标签，不进排版流（网页上没有 equation 计数器）
      return '';
    case 'raw':
      return node.tex;
    default:
      return '';
  }
}

const fracCommand = (style) => (style === 'display' ? 'dfrac' : style === 'text' ? 'tfrac' : 'frac');

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

export function toDialect(tex, dialectName) {
  if (dialectName !== 'mathlive') return { tex, rewrites: [] };
  const rewrites = [];
  let s = tex;

  if (/\\dots(?![a-zA-Z])/.test(s)) {
    s = s.replace(/\\dots(?![a-zA-Z])/g, '\\ldots');
    rewrites.push('\\dots→\\ldots');
  }
  if (/\\substack\{/.test(s)) {
    // `\substack` 的内容常含嵌套花括号（`a_{12}A_{12}`），所以不能用一个固定层数的
    // 正则——实测 `\xrightarrow[\substack{a_{12}A_{12}+…}]` 这种就漏掉了，
    // 改成**按花括号配平**找到配对的 `}`，逐处替换。
    let guard = 0;
    while (s.includes('\\substack{') && guard < 20) {
      guard += 1;
      const at = s.indexOf('\\substack{');
      const open = at + '\\substack'.length;   // 指向 `{`
      let depth = 0;
      let close = -1;
      for (let i = open; i < s.length; i += 1) {
        if (s[i] === '\\') { i += 1; continue; }   // 跳过被转义的字符
        if (s[i] === '{') depth += 1;
        else if (s[i] === '}') {
          depth -= 1;
          if (depth === 0) { close = i; break; }
        }
      }
      if (close < 0) break;   // 配不平：留给渲染器的结构诊断
      const inner = s.slice(open + 1, close);
      s = `${s.slice(0, at)}\\begin{smallmatrix}${inner}\\end{smallmatrix}${s.slice(close + 1)}`;
    }
    rewrites.push('\\substack→smallmatrix');
  }
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
 * MathLive 渲染 adapter。
 *
 * @param {{convertLatexToMarkup: Function, validateLatex: Function}} mathlive
 *   MathLive 的 SSR 模块（`mathlive-ssr.min.mjs`）
 * @returns {Renderer}
 */
export function createMathliveRenderer(mathlive) {
  return {
    id: 'mathlive',
    caps: { markSubstrate: true, producesMathml: false, producesAnnotation: false },

    /**
     * @param {MathExpr} expr 已绑定的 IR
     * @returns {{html: string, tex: string, problems: Problem[], rewrites: string[]}}
     */
    render(expr) {
      const problems = [];
      const raw = irToTex(expr.root, { decorate: true });
      const { tex, rewrites } = toDialect(raw, 'mathlive');

      // 先验：结构化的错误列表，不嗅探产物字符串
      let verdict = [];
      try {
        verdict = mathlive.validateLatex(tex) || [];
      } catch (e) {
        problems.push({
          code: 'render-validate-threw',
          severity: 'warn',
          where: { source: expr.source },
          message: `MathLive 校验抛异常：${e.message}`,
        });
      }

      let html = '';
      try {
        html = mathlive.convertLatexToMarkup(tex);
      } catch (e) {
        problems.push({
          code: 'render-failed',
          severity: 'error',
          where: { source: expr.source },
          message: `渲染失败：${e.message}`,
          hint: tex.slice(0, 120),
        });
        return { html: fallbackHtml(expr), tex, problems, rewrites };
      }

      if (verdict.length) {
        problems.push({
          code: 'render-unsupported',
          severity: 'error',
          where: { source: expr.source, index: Math.max(0, verdict[0].before?.length ?? 0) },
          message: `该引擎不支持 ${verdict[0].arg || verdict[0].code}`,
          hint: tex.slice(0, 120),
        });
      }
      // 结构判据：`ML__error` 是 MathLive 明确的错误标记
      if (/ML__error/.test(html)) {
        problems.push({
          code: 'render-error-markup',
          severity: 'error',
          where: { source: expr.source },
          message: '渲染产物里出现了错误标记（该引擎无法排版这条公式）',
          hint: tex.slice(0, 120),
        });
        return { html: fallbackHtml(expr), tex, problems, rewrites };
      }

      // 把 IR 的纯文本投影烘进 aria-label：
      //   ① 读屏软件念人话，不念 `\frac{a}{b}`；
      //   ② AI 读页面（webmcp）与搜索索引拿同一份文本——不必再从产物里剥 LaTeX。
      // 这是「同一份数据双投影」的落地：图形给人看，文本给机器读，两者都从 IR 出。
      const plain = expr.plainHint || '';
      if (plain) {
        html = html.replace(/^<span class="ML__latex"/, `<span class="ML__latex" role="math" aria-label="${escapeAttr(plain)}" data-math-plain="${escapeAttr(plain)}"`);
      }
      return { html, tex, problems, rewrites };
    },

    probe() {
      const problems = [];
      const sample = 'B=\\htmlData{term=sym-B}{B}';
      const out = mathlive.convertLatexToMarkup(sample);
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
export function decorateAnchors(html, opts) {
  const missing = [];
  let decorated = 0;
  // `data-term="pack:entry"`——属性值里不会有 `<` `>`，可以安全用正则。
  // 不用完整 HTML parser：契约规定 substrate 只有这一种形态（adapter 保证）。
  const out = html.replace(
    /<span data-term="([^"]*)">([\s\S]*?)<\/span>/g,
    (whole, key, inner) => {
      const hit = opts.resolve(key);
      if (!hit) { missing.push(key); return whole; }
      decorated += 1;
      const label = escapeAttr(hit.label || key);
      return `<a class="sym-gloss" data-term="${escapeAttr(key)}" href="${escapeAttr(hit.href)}" aria-label="${label}">${inner}</a>`;
    },
  );
  return { html: out, decorated, missing };
}
