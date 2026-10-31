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
  const { decorate = true, dialect = 'katex' } = opts;
  const dialectName = dialect;
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
      // ⚠️ 2026-10-30 真 bug（KaTeX 报 9 处 katex-error）：原先一律 `.join(' ')`，
      // 于是 `T''_{d3}` 的两个撇号被编成 `T ' '_{{d3}}` ——
      // MathLive 容忍，**KaTeX 直接 parse error**（`' '` 不是合法序列）。
      //
      // 撇号是**后缀运算符**，必须紧贴前一项：`T''` 要编成 `T''`，不是 `T ' '`。
      // 这里逐项拼接：遇到 tex 为撇号（单/双/三）的项就不加分隔空格。
      const items = node.items || [];
      let inner = '';
      for (let k = 0; k < items.length; k += 1) {
        const piece = irToTex(items[k], opts);
        if (k > 0) {
          const prevTex = String(items[k - 1].tex || '').trim();
          const curTex = String(items[k].tex || '').trim();
          // 上一项是撇号链、或当前项是撇号 ⇒ 都不插空格
          const isPrime = (t) => t === "'" || t === '′' || /^'+$/.test(t);
          if (!isPrime(prevTex) && !isPrime(curTex)) inner += ' ';
        }
        inner += piece;
      }
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
    case 'label': {
      // ⚠️ 2026-10-30 改：原来一律返回 ''（「网页上没有 equation 计数器」），
      // 于是 `\tag{1-31}` 被静默丢掉——而**丢掉比留着更糟**：
      // 读者看不到这些编号，正文里「由式（1-31）」就再也对不上。
      // KaTeX 原生支持 `\tag{}`（需 displayMode），所以按结点类型分派：
      //   · katex   → 编回 `\tag{…}`（编号显示在公式右侧）
      //   · 其他引擎 → 仍丢弃（MathLive 不支持）
      const body = (node.text || []).map((n) => irToTex(n, opts)).join(' ');
      if (dialectName === 'katex') return `\\tag{${body}}`;
      return '';
    }
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
      // KaTeX 是「全支持」方言：`toDialect` 对 katex 原样返回，方言表里 unsupported 为空。
      const { tex, rewrites } = toDialect(raw, 'katex');

      // ⚠️ displayMode 必须跟着公式的 mode 走（2026-10-30 实测）：
      // `\tag{1-31}` 这类编号宏**只在 displayMode 下可用**，inline 模式直接 parse error
      // （电机学 1.2 / 1.3 两页就栽在这——9 处 katex-error 里有 2 处是它）。
      const opts = expr.mode === 'display' ? { ...OPTS, displayMode: true } : OPTS;

      let html = '';
      try {
        html = katex.renderToString(tex, opts);
      } catch (e) {
        problems.push({
          code: 'render-failed',
          severity: 'error',
          where: { source: expr.source },
          message: `KaTeX 渲染失败：${e.message}`,
          hint: tex.slice(0, 120),
        });
        return { html: fallbackHtml(expr), tex, problems, rewrites };
      }

      // 结构判据：KaTeX 的 `throwOnError:false` 会在产物里塞 `.katex-error`，
      // 那是「这条公式它排不了」的明确标记——不嗅探别的字符串。
      if (/katex-error/.test(html)) {
        problems.push({
          code: 'render-error-markup',
          severity: 'error',
          where: { source: expr.source },
          message: '产物里出现 katex-error（这条公式排不了）',
          hint: tex.slice(0, 120),
        });
        return { html: fallbackHtml(expr), tex, problems, rewrites };
      }

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
export function decorateAnchors(html, opts) {
  const missing = [];
  let decorated = 0;

  // ⚠️ 2026-10-30 真 bug（站长报「没几个公式是对的」，实测一条分式只剩 `η(β`）：
  // 原实现用非贪婪正则 `/<span data-term="…">([\s\S]*?)<\/span>/`。
  // 它的隐含假设是「被包的 span 里没有嵌套 span」——**这个假设是错的**：
  // MathLive 的 `<span data-term>` 里恰恰嵌着 `<span class="ML__mathit">η</span>`，
  // 于是非贪婪匹配到**内层那个** `</span>` 就收工，产出 `…η</a></span>` 这种畸形：
  // 外层 span 的闭合被吃掉、`</a>` 出现在 span 内部。
  // 浏览器的错误恢复策略会在这里把整个公式截断——DOM 里只剩前几个字符，
  // 后面的分式、下标**根本没被解析**。所以问题不是「字体小」，是**结构坏了**。
  //
  // 修法：不用非贪婪正则，改成**标签配对扫描**——从 `<span data-term` 起数嵌套深度，
  // 深度回到 0 的那个 `</span>` 才是它自己的收尾。
  const out = [];
  // ⚠️ 2026-10-30：KaTeX 产的形状是 `<span class="enclosing" data-term="…">`——
  // `data-term` 不在属性首位。原正则写死 `<span data-term="` 只认 MathLive 的形状，
  // 换 KaTeX 后一个锚点都包不上（实测 9 处 data-term 全成了裸 span，气泡点了不弹）。
  // 放宽成「`<span` 后面任意属性、其中含 data-term」。
  const openRe = /<span\b[^>]*?\bdata-term="([^"]*)"[^>]*>/g;
  let last = 0;
  let m;
  while ((m = openRe.exec(html)) !== null) {
    const start = m.index;
    const key = m[1];
    // 从开标签之后数深度（开标签本身已算一层）
    let depth = 1;
    let i = openRe.lastIndex;
    while (i < html.length && depth > 0) {
      const nextOpen = html.indexOf('<span', i);
      const nextClose = html.indexOf('</span>', i);
      if (nextClose < 0) break;                       // 结构不完整，放弃这一处
      if (nextOpen >= 0 && nextOpen < nextClose) { depth++; i = nextOpen + 5; }
      else { depth--; if (depth === 0) { i = nextClose + 7; break; } i = nextClose + 7; }
    }
    if (depth !== 0) continue;                        // 没配平 ⇒ 不碰它（宁可不动，不要弄坏）
    const end = i;                                    // 指向闭合 `</span>` 之后
    const inner = html.slice(openRe.lastIndex, i - 7);
    const hit = opts.resolve(key);
    if (!hit) {
      missing.push(key);
      openRe.lastIndex = end;
      continue;
    }
    decorated += 1;
    const label = escapeAttr(hit.label || key);
    out.push(html.slice(last, start));
    out.push(`<a class="sym-gloss" data-term="${escapeAttr(key)}" href="${escapeAttr(hit.href)}" aria-label="${label}">${inner}</a>`);
    last = end;
    openRe.lastIndex = end;
  }
  out.push(html.slice(last));
  return { html: out.join(''), decorated, missing };
}
