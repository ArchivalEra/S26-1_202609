/**
 * TeX 解析器：记号流 → IR 树。**零依赖、纯函数、永不抛异常**（错误进 problems）。
 *
 * ## IR 的形状（也是本仓数学的「唯一真相」）
 *
 * 每个节点都有 `{id, kind, role, term, span}`：
 *   · `id`   页内唯一的节点号（`n1`、`n2`…），供诊断与术语表三方互指
 *   · `kind` 结构类型（`sym` `num` `op` `script` `frac` `group` `matrix` `literal` …）
 *   · `role` **语义角色**（`operand` `operator` `relation` `fence` `separator`）
 *            —— 符号判定只看它，从不看字符
 *   · `term` 符号身份（`{pack, entry}` 或 null）。**只有绑定阶段会写它**，
 *            解析器一律产出 null
 *   · `span` 源文本区间，只用于诊断定位
 *
 * ## 为什么这一层是整个重构的支点
 *
 * 旧的四处取词（`autoWrapTerms`、`glossifyTex`、`[tex]{#id}`、手写 `\htmlData`）
 * 全都在**字符串**上做正则，于是「谁是符号」这个判断被回答了三遍，每遍略有不同。
 * 一旦解析成树，这个判断只需要在树上做一次，且能看结构：
 *   · `\mathrm{H/m}` 里的 `H` 在 `literal` 子树里 ⇒ 结构上不是可绑定类型
 *   · `\frac1\lambda` 的两个参数在树里就是 `group` ⇒ 编译回去必然带花括号
 *     （旧代码的 "Unexpected end of input in a macro argument" 事故没有发生的位置）
 */

import { tokenize, checkEnvironments } from './lexer.mjs';
import {
  classifyCommand, isSpaceCommand, ENVIRONMENTS,
} from './commands.mjs';

/** 二元运算符：两侧都是操作数时，它自己是 `operator` 角色。 */
const BIN_OPS = new Set([
  '+', '-', '±', '∓', '×', '÷', '·', '*', '∪', '∩',
]);

/** 关系运算符。 */
const REL_OPS = new Set([
  '=', '<', '>', '≠', '≈', '≡', '≅', '∼', '∝', '≤', '≥', '⩽', '⩾', '≪', '≫',
  '→', '←', '↔', '⇒', '⟹', '⟺', '∈', '∉', '∋', '∣', '∥', '⊂', '⊃', '⊆', '⊇',
]);

/** 开/闭定界符字符。 */
const OPEN_FENCE = new Set(['(', '[', '{', '⟨', '⌊', '⌈']);
const CLOSE_FENCE = new Set([')', ']', '}', '⟩', '⌋', '⌉']);
const PUNCT = new Set([',', ';', ':']);

/**
 * 解析一条公式。
 *
 * @param {string} src 公式源（不含 `$`）
 * @param {{mode?: 'inline'|'display'}} [opts]
 * @returns {{
 *   expr: MathExpr,
 *   problems: Problem[],
 * }}
 */
export function parse(src, opts = {}) {
  const mode = opts.mode === 'display' ? 'display' : 'inline';
  const source = String(src);
  const { tokens, problems: lexProblems } = tokenize(source);
  const problems = [...lexProblems, ...checkEnvironments(tokens)];

  let nextId = 0;
  const newId = () => `n${(nextId += 1)}`;

  /** 读一个「原子」：一个字符、一个命令、或一个花括号组。 */
  let pos = 0;
  const peek = (k = 0) => tokens[pos + k];
  const at = (kind, value) => {
    const t = peek();
    return t && t.kind === kind && (value === undefined || t.value === value);
  };

  const node = (kind, role, extra, spanStart, spanEnd) => ({
    id: newId(),
    kind,
    role,
    term: null,
    span: [spanStart, spanEnd],
    ...extra,
  });

  const skipSpace = () => {
    while (at('space')) pos += 1;
  };

  /** 字符 → 角色。 */
  const charRole = (c) => {
    if (REL_OPS.has(c)) return 'relation';
    if (BIN_OPS.has(c)) return 'operator';
    if (OPEN_FENCE.has(c) || CLOSE_FENCE.has(c)) return 'fence';
    if (PUNCT.has(c)) return 'separator';
    return 'operand';
  };

  /** 吃一个定界符记号（`\left`/`\right` 后面那个）。 */
  const takeDelimiter = () => {
    skipSpace();
    const t = peek();
    if (!t) return { glyph: '', span: null };
    if (t.kind === 'char') { pos += 1; return { glyph: t.value, span: [t.start, t.end] }; }
    if (t.kind === 'cs' || t.kind === 'sym') {
      pos += 1;
      const g = t.value === '.' ? '' : t.value;
      return { glyph: t.kind === 'sym' ? t.value : g, span: [t.start, t.end] };
    }
    return { glyph: '', span: null };
  };

  /**
   * 读一个参数：`{…}` 整组，或单个原子。
   * 这是 I6（花括号组）的落地点：**返回值永远是 group 或原子节点，不会是「裸参数」**。
   */
  const takeArg = (what) => {
    skipSpace();
    const t = peek();
    // 裸数字参数：`\frac14` 是 `\frac{1}{4}`，TeX 把**一个字符**当参数。
    // 旧实现靠 `braceBareArgs` 事后补花括号，补丁本身就是事故来源
    // （补错位置会把 `\frac1\lambda` 变成 `\frac1\htmlData{…}{\lambda}` → 宏参数报错）。
    // 在解析期直接按「一位数字」取，从根上不会出现裸参数残留。
    if (t && t.kind === 'char' && t.numeric && t.value.length > 1) {
      pos += 1;
      const first = t.value[0];
      // 把剩下的位数塞回记号流：构造一个「残片」记号原位补齐
      tokens.splice(pos, 0, {
        kind: 'char', value: t.value.slice(1),
        start: t.start + 1, end: t.end, numeric: true,
      });
      return node('num', 'operand', { literal: first }, t.start, t.start + 1);
    }
    if (!t) {
      problems.push({
        code: 'parse-missing-arg',
        severity: 'error',
        start: source.length, end: source.length,
        message: `${what} 缺少参数`,
      });
      return node('group', 'operand', { items: [], fence: null }, source.length, source.length);
    }
    if (t.kind === 'open') {
      const start = t.start;
      pos += 1;
      const items = parseList(/* untilClose */ true);
      const endTok = peek();
      const end = endTok && endTok.kind === 'close' ? endTok.end : (items.at(-1)?.span?.[1] ?? start);
      if (endTok && endTok.kind === 'close') pos += 1;
      return node('group', 'operand', { items, fence: null }, start, end);
    }
    return parseAtom();
  };

  /** 解析一串节点，直到 `}` 或输入结束。 */
  const parseList = (untilClose) => {
    const items = [];
    while (pos < tokens.length) {
      const t = peek();
      if (untilClose && t.kind === 'close') break;
      if (t.kind === 'space') { pos += 1; continue; }
      if (t.kind === 'close') {
        // 不配对的右括号：词法层已报过，这里跳过避免死循环
        pos += 1;
        continue;
      }
      const n = parseScripted();
      if (n) items.push(n);
    }
    return items;
  };

  /** 解析「原子 + 可选上下标」。 */
  const parseScripted = () => {
    skipSpace();
    // 「上标无基」：`{}^\circ`、`\mathrm{^\circ C}` 这类写法在 TeX 里合法
    // （温度符号、同位素记号的常见写法）。给一个空 group 当基，而不是报错。
    if (at('sub') || at('sup')) {
      const markTok = peek();
      const emptyBase = node('group', 'operand',
        { items: [], fence: null }, markTok.start, markTok.start);
      return parseScripts(emptyBase);
    }
    const base = parseAtom();
    if (!base) return null;
    return parseScripts(base);
  };

  /** 给一个基吃上下标。 */
  const parseScripts = (base) => {
    let sub = null;
    let sup = null;
    for (;;) {
      skipSpace();
      if (at('sub')) {
        pos += 1;
        if (sub) {
          problems.push({
            code: 'parse-double-sub',
            severity: 'warn',
            start: base.span[0], end: base.span[1],
            message: '同一个基上出现了两个下标，后一个被忽略',
          });
        } else sub = takeArg('下标');
        continue;
      }
      if (at('sup')) {
        pos += 1;
        if (sup) {
          problems.push({
            code: 'parse-double-sup',
            severity: 'warn',
            start: base.span[0], end: base.span[1],
            message: '同一个基上出现了两个上标，后一个被忽略',
          });
        } else sup = takeArg('上标');
        continue;
      }
      break;
    }
    if (!sub && !sup) return base;
    return node('script', base.role, { base, sub, sup }, base.span[0], (sup || sub).span[1]);
  };

  /** 解析一个原子（不含上下标）。返回 null 表示「没有可解析的东西」。 */
  const parseAtom = () => {
    skipSpace();
    const t = peek();
    if (!t) return null;

    if (t.kind === 'open') {
      const start = t.start;
      pos += 1;
      const items = parseList(true);
      const endTok = peek();
      const end = endTok && endTok.kind === 'close' ? endTok.end : (items.at(-1)?.span?.[1] ?? start);
      if (endTok && endTok.kind === 'close') pos += 1;
      return node('group', 'operand', { items, fence: null }, start, end);
    }

    if (t.kind === 'char') {
      pos += 1;
      const c = t.value;
      if (t.numeric) {
        return node('num', 'operand', { literal: c }, t.start, t.end);
      }
      if (t.kind === 'char' && /[\u4e00-\u9fff]/.test(c)) {
        // 数学模式里的裸中文：按「当文字排」处理（渲染期包 \text{}），不参与符号判定。
        // 这是旧代码 wrapBareCJK 在做的事，现在由结构表达。
        return node('literal', 'operand', { text: c, literalMode: 'text' }, t.start, t.end);
      }
      const role = charRole(c);
      // 操作数位置的字母是**符号**（可被词典绑定），不是运算符。
      // 旧实现在这一步就丢了「这是变量还是运算符」的区分，导致形状键里
      // `R` 与 `+` 同类，`R_L` 与 `R_{L}` 也就对不上词典。
      if (role === 'operand') {
        return node('sym', 'operand', { tex: c, glyph: c }, t.start, t.end);
      }
      return node('op', role, { tex: c, glyph: c }, t.start, t.end);
    }

    if (t.kind === 'sym') {
      // 控制符号：`\,` `\;` `\{` `\\`
      pos += 1;
      if (t.value === '\\') {
        return node('rowbreak', 'separator', {}, t.start, t.end);
      }
      if (isSpaceCommand(t.value)) {
        return node('space', 'separator', { tex: `\\${t.value}` }, t.start, t.end);
      }
      // `\{` `\}` 等定界符
      const glyph = t.value;
      return node('op', OPEN_FENCE.has(glyph) || CLOSE_FENCE.has(glyph) ? 'fence' : 'operand',
        { tex: `\\${glyph}`, glyph }, t.start, t.end);
    }

    if (t.kind === 'cs') {
      return parseCommand();
    }

    // 裸结构记号出现在原子位置（如 `_x` 缺基）：报错并跳过
    problems.push({
      code: 'parse-unexpected-token',
      severity: 'error',
      start: t.start, end: t.end,
      message: `这里不该出现「${t.value}」`,
    });
    pos += 1;
    return null;
  };

  /** 解析一个控制序列。 */
  const parseCommand = () => {
    const t = peek();
    const start = t.start;

    // ── 环境：\begin{name} … \end{name}
    if (t.value === 'begin') {
      return parseEnvironment();
    }
    if (t.value === 'end') {
      // 环境配平已由词法层检查；这里遇到游离的 \end 直接跳过
      pos += 1;
      return null;
    }

    // ── 文字模式：\text{…} 内容原样保留
    if (t.value === 'text' || t.value === 'mbox' || t.value === 'hbox'
      || t.value === 'textnormal' || t.value === 'textrm'
      || t.value === 'textsf' || t.value === 'texttt') {
      pos += 1;
      const arg = takeRawText();
      return node('literal', 'operand',
        { text: arg.text, literalMode: 'text' }, start, arg.end);
    }

    // ── 字体样式：\mathbf{…} 吃一个组，改外观不改语义
    const cls = classifyCommand(t.value);
    if (cls && cls.role === 'style') {
      pos += 1;
      const arg = takeArg(`\\${t.value}`);
      // **正体类命令下的内容一律当「字面」**：`\mathrm{H/m}` 里的 H、m 是单位，
      // 不是变量；`\operatorname{rank}` 是函数名。
      // 这是 `\mathrm{H/m}` 事故的结构性根治——那类节点根本不进判定候选集，
      // 不是靠正则护住（旧实现写了几条正则去躲，仍会漏）。
      //
      // 只对 `mathrm` / `operatorname` / `mathsf` / `mathtt` 这类「排成正体文字」的
      // 生效；`\mathbf{F}`、`\boldsymbol{\alpha}` 仍是**数学内容**（粗体变量，
      // 该取词），不能一并当字面。
      const asLiteral = ['upright', 'operator-name', 'sans', 'mono'].includes(cls.style);
      if (asLiteral && arg.kind === 'group') {
        const text = arg.items.map(n => n.text ?? n.glyph ?? n.tex ?? '').join('');
        return node('literal', 'operand',
          { text, literalMode: cls.style === 'operator-name' ? 'operator-name' : 'unit' },
          start, arg.span[1]);
      }
      return node('styled', arg.role, { style: cls.style, body: arg }, start, arg.span[1]);
    }

    // ── 分数
    if (cls && cls.role === 'frac') {
      pos += 1;
      const num = takeArg(`\\${t.value}`);
      const den = takeArg(`\\${t.value}`);
      return node('frac', 'operand',
        { num, den, fractionStyle: cls.style }, start, den.span[1]);
    }

    // ── 重音
    if (cls && cls.role === 'accent') {
      pos += 1;
      const body = takeArg(`\\${t.value}`);
      return node('accent', 'operand',
        { accent: cls.kind, body }, start, body.span[1]);
    }

    // ── 函数名（正体排的原子，可带上下标）
    if (cls && cls.role === 'function') {
      pos += 1;
      return node('sym', 'operand',
        { tex: `\\${t.value}`, glyph: t.value, upright: true, isFunctionName: true },
        start, t.end);
    }

    // ── 自带字形的符号
    if (cls && cls.role === 'symbol') {
      pos += 1;
      const glyph = cls.glyph;
      let role = 'operand';
      if (REL_OPS.has(glyph)) role = 'relation';
      else if (BIN_OPS.has(glyph)) role = 'operator';
      else if (OPEN_FENCE.has(glyph) || CLOSE_FENCE.has(glyph)) role = 'fence';
      if (t.value === 'cdots' || t.value === 'ldots' || t.value === 'dots'
        || t.value === 'vdots' || t.value === 'ddots') {
        return node('ellipsis', 'operator', { tex: `\\${t.value}`, glyph }, start, t.end);
      }
      if (t.value === 'int' || t.value === 'oint' || t.value === 'sum') {
        return node('bigop', 'operator', { tex: `\\${t.value}`, glyph }, start, t.end);
      }
      return node('sym', role, { tex: `\\${t.value}`, glyph }, start, t.end);
    }

    // ── 空白命令
    if (isSpaceCommand(t.value)) {
      pos += 1;
      return node('space', 'separator', { tex: `\\${t.value}` }, start, t.end);
    }

    // ── 特殊命令
    if (cls && cls.role === 'special') {
      return parseSpecial(t, start);
    }

    // ── 不认识：零回退，报错并原样保留
    pos += 1;
    problems.push({
      code: 'parse-unknown-command',
      severity: 'error',
      start: t.start, end: t.end,
      message: `不认识的命令 \\${t.value}（命令表见 站点/math/commands.mjs，语料实测共 125 个）`,
    });
    return node('raw', 'operand', { tex: `\\${t.value}`, reason: 'unknown-command' }, start, t.end);
  };

  /** `\text{…}` 的内容**原样**取出（不解析其中的 TeX）。 */
  const takeRawText = () => {
    skipSpace();
    const t = peek();
    if (!t || t.kind !== 'open') {
      const arg = takeArg('\\text');
      const text = arg.items?.map(n => n.glyph ?? n.tex ?? '').join('') ?? '';
      return { text, end: arg.span[1] };
    }
    // 从当前 `{` 到匹配的 `}`，按原文切
    const openStart = t.start;
    pos += 1;
    let depth = 1;
    let last = null;
    while (pos < tokens.length) {
      const cur = peek();
      pos += 1;
      if (cur.kind === 'open') depth += 1;
      else if (cur.kind === 'close') {
        depth -= 1;
        if (depth === 0) { last = cur; break; }
      }
    }
    const end = last ? last.end : (tokens[pos - 1]?.end ?? openStart);
    return { text: source.slice(openStart + 1, end - 1), end };
  };

  /** 特殊命令。 */
  const parseSpecial = (t, start) => {
    const name = t.value;

    if (name === 'left' || name === 'right' || name === 'middle') {
      pos += 1;
      const d = takeDelimiter();
      return node('fence', 'fence',
        { tex: `\\${name}${d.glyph}`, glyph: d.glyph, side: name }, start, d.span?.[1] ?? t.end);
    }

    if (name === 'sqrt') {
      pos += 1;
      let index = null;
      skipSpace();
      if (at('char', '[')) index = takeBracketArg();
      const body = takeArg('\\sqrt');
      return node('root', 'operand', { index, body }, start, body.span[1]);
    }

    if (name === 'xrightarrow' || name === 'xleftarrow') {
      pos += 1;
      // 可选参数 `[…]` 在下、必选 `{…}` 在上
      let below = null;
      skipSpace();
      if (at('char', '[')) {
        below = takeBracketArg();
      }
      const above = takeArg(`\\${name}`);
      return node('arrow', 'relation',
        { tex: `\\${name}`, dir: name === 'xrightarrow' ? 'right' : 'left', above, below },
        start, above.span[1]);
    }

    if (name === 'overset' || name === 'underset' || name === 'stackrel') {
      pos += 1;
      const first = takeArg(`\\${name}`);
      const second = takeArg(`\\${name}`);
      const over = name !== 'underset';
      return node('stack', 'operand',
        { rows: over ? [[second], [first]] : [[first], [second]], stackKind: name },
        start, second.span[1]);
    }

    if (name === 'substack') {
      pos += 1;
      const arg = takeArg('\\substack');
      // 组内按 `\\` 断行
      const rows = [];
      let cur = [];
      for (const item of arg.items || []) {
        if (item.kind === 'rowbreak') { rows.push(cur); cur = []; continue; }
        cur.push(item);
      }
      if (cur.length || !rows.length) rows.push(cur);
      return node('stack', 'operand', { rows, stackKind: 'substack' }, start, arg.span[1]);
    }

    if (name === 'tag') {
      pos += 1;
      skipSpace();
      // `\tag*{…}` 的星号
      if (at('char', '*')) pos += 1;
      const arg = takeArg('\\tag');
      return node('label', 'separator',
        { text: arg.items || [] }, start, arg.span[1]);
    }

    if (name === 'limits' || name === 'nolimits') {
      pos += 1;
      return node('space', 'separator', { tex: `\\${name}` }, start, t.end);
    }

    if (name === 'phantom' || name === 'hphantom' || name === 'vphantom') {
      pos += 1;
      const arg = takeArg(`\\${name}`);
      return node('phantom', 'separator', { body: arg }, start, arg.span[1]);
    }

    if (name === 'color' || name === 'textcolor') {
      pos += 1;
      const c = takeArg(`\\${name}`);
      if (name === 'textcolor') {
        const body = takeArg('\\textcolor');
        return node('styled', body.role,
          { style: 'color', colorArg: c, body }, start, body.span[1]);
      }
      return node('space', 'separator', { tex: '\\color' }, start, c.span[1]);
    }

    if (name === 'big' || name === 'Big' || name === 'bigg' || name === 'Bigg'
      || name === 'bigl' || name === 'bigr' || name === 'Bigl' || name === 'Bigr') {
      pos += 1;
      const d = takeDelimiter();
      return node('fence', 'fence',
        { tex: `\\${name}${d.glyph}`, glyph: d.glyph, side: name }, start, d.span?.[1] ?? t.end);
    }

    // 其余 special（`left.` 之类）当空白处理
    pos += 1;
    return node('space', 'separator', { tex: `\\${name}` }, start, t.end);
  };

  /** `\xrightarrow[…]` 的方括号参数。 */
  const takeBracketArg = () => {
    const openTok = peek();
    const start = openTok.start;
    pos += 1;
    const items = [];
    while (pos < tokens.length) {
      const cur = peek();
      if (cur.kind === 'char' && cur.value === ']') { pos += 1; break; }
      if (cur.kind === 'space') { pos += 1; continue; }
      const n = parseScripted();
      if (n) items.push(n);
    }
    const end = tokens[pos - 1]?.end ?? start;
    return node('group', 'operand', { items, fence: null }, start, end);
  };

  /** 环境：`\begin{name}` … `\end{name}` */
  const parseEnvironment = () => {
    const beginTok = peek();
    const start = beginTok.start;
    const envName = beginTok.envName;
    pos += 1;   // 吃掉 \begin
    const spec = ENVIRONMENTS[envName];
    if (!spec) {
      problems.push({
        code: 'parse-unknown-environment',
        severity: 'error',
        start: beginTok.start, end: beginTok.end,
        message: `不认识的环境 ${envName}（可用：${Object.keys(ENVIRONMENTS).join('、')}）`,
      });
    }
    // `\begin{array}{cc}` 的列格式
    let columnSpec = null;
    if (envName === 'array') {
      skipSpace();
      if (at('open')) {
        const arg = takeArg('array');
        columnSpec = (arg.items || []).map(n => n.glyph ?? n.tex ?? '').join('');
      }
    }
    // 读到配对的 \end{同名}
    const rows = [];
    let curRow = [];
    let depth = 0;
    let end = beginTok.end;
    while (pos < tokens.length) {
      const cur = peek();
      if (cur.kind === 'cs' && cur.value === 'begin') {
        // 嵌套环境：整段当一个原子（内部再解析）
        const nested = parseEnvironment();
        if (nested) curRow.push(nested);
        continue;
      }
      if (cur.kind === 'cs' && cur.value === 'end') {
        pos += 1;
        end = cur.end;
        break;
      }
      if (cur.kind === 'amp') { pos += 1; curRow.push({ marker: 'col' }); continue; }
      if (cur.kind === 'sym' && cur.value === '\\') {
        pos += 1;
        rows.push(curRow); curRow = [];
        continue;
      }
      if (cur.kind === 'space') { pos += 1; continue; }
      const n = parseScripted();
      if (n) curRow.push(n);
    }
    rows.push(curRow);

    // 把列分隔记号拆成二维
    const grid = rows.map((row) => {
      const cells = [[]];
      for (const item of row) {
        if (item.marker === 'col') cells.push([]);
        else cells.at(-1).push(item);
      }
      return cells;
    });

    return node('env', 'operand', {
      env: envName,
      delims: spec ? spec.delims : ['', ''],
      columnSpec,
      rows: grid,
    }, start, end);
  };

  // 顶层：解析成透明组
  const items = [];
  while (pos < tokens.length) {
    if (at('space')) { pos += 1; continue; }
    const before = pos;
    const n = parseScripted();
    if (n) items.push(n);
    // 没有进展时强制前进，避免死循环（病态输入不应让构建挂住）
    if (pos === before) pos += 1;
  }

  const root = {
    id: newId(),
    kind: 'group',
    role: 'operand',
    term: null,
    span: [0, source.length],
    items,
    fence: null,
  };

  const expr = {
    v: 1,
    mode,
    source,
    root,
  };

  return { expr, problems };
}
