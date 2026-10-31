// to-octave.mjs —— 把公式的 IR 转成 Octave 表达式（能力包「运行」按钮用）。
//
// ## 为什么吃 IR 不吃字符串
//
// 站点已经有一棵解析好的 IR（`站点/math/`）：符号身份、上下标归属、环境边界
// 都在那里判过了。再从 LaTeX 字符串做一遍正则替换是第二套真相——同一件事写两遍
// 必然漂移（本仓在 `inspectAsset`/`download` 上刚吃过这个亏）。
//
// ## 为什么只支持一个**可计算子集**
//
// 站里 11,759 条公式，能直接算出数的只有一小部分（纯数值、矩阵、内置函数）。
// 剩下的（含裸变量、求和、分段、关系式）**不是"暂时算不了"，是语义上没法算**：
// `U=IR` 里的 U、I、R 没有赋值，Octave 只能报 undefined。
//
// 所以本模块的契约是：**能转就转，不能转就说清为什么**。绝不静默返回一个
// 看起来能跑、实际算错的串。
//
// ## 输出形态
//
// `translate(node)` → `{ ok: true, code }` 或 `{ ok: false, reason }`。
// `reason` 是中文、面向读者的（会直接显示在编辑器里），不是错误码。

/**
 * 能一一映射到 Octave 的 TeX 命令名。
 * 只收**语义相同**的：`\sin` → `sin`，但 `\sum`（求和）不在表里——它要展开成循环，
 * 不是一次函数调用。
 */
const FN_MAP = {
  sin: 'sin', cos: 'cos', tan: 'tan', cot: 'cot', sec: 'sec', csc: 'csc',
  arcsin: 'asin', arccos: 'acos', arctan: 'atan',
  sinh: 'sinh', cosh: 'cosh', tanh: 'tanh',
  exp: 'exp', log: 'log', ln: 'log', lg: 'log10',
  sqrt: 'sqrt', abs: 'abs',
  det: 'det', inv: 'inv', rank: 'rank', trace: 'trace',
  transpose: 'transpose',
};

/** 能直接换成数值常量的符号。 */
const CONST_MAP = {
  pi: 'pi', '\\pi': 'pi',
  infty: 'Inf', '\\infty': 'Inf',
};

/** LaTeX 判断：这个 sym 节点是不是「排版用的装饰」而不是数学内容。 */
function isOperatorGlyph(glyph) {
  return /^[×·⋅÷±\-\+\=<>（）()\[\]|/,;:]$/.test(glyph || '');
}

/**
 * 把 IR 节点转成 Octave 代码。
 * @returns {{ok: true, code: string} | {ok: false, reason: string}}
 */
export function translate(node) {
  const r = emit(node);
  if (!r.ok) return r;

  // ⚠️ **结构校验：转出来的必须是个完整表达式**（2026-10-31 实测）。
  // 不校验的话，孤零零的 `+`、`-`、`=` 也会「成功」转出 `+`、`=` —— 构建期
  // 于是给它们挂上播放按钮，运行时 Octave 报 `syntax error`（页面上就是一串
  // 红字框）。判据：
  //   · 必须含至少一个**操作数**（数字、标识符、函数调用、矩阵…）；
  //   · 不能只是个运算符 / 关系符。
  // 判据用「去掉所有运算符后还剩不剩东西」——比逐个白名单可靠。
  const bare = String(r.code)
    .replace(/[\s()\[\]]/g, '')          // 空白与括号不算内容
    .replace(/==|~=|<=|>=|[+\-*/^=~]/g, ''); // 运算符不算内容
  if (!bare) return fail('这不是一个完整的表达式（只有运算符，没有可算的量）');

  return { ok: true, code: r.code };
}

function emit(n) {
  if (!n || typeof n !== 'object') return fail('空节点');

  switch (n.kind) {
    case 'group': {
      // group 是**透明**的：它只是排版上的分组，数学上是同一个表达式。
      //
      // ⚠️ 但函数名要特殊处理（2026-10-31 实测）：`\sin\frac{\pi}{2}` 的 IR 是
      // **同级的两个 item** —— 一个 `sym(isFunctionName)` + 一个 `frac`。
      // 逐项 emit 再拼会得到 `sin (pi)/(2)`，Octave 把它读成 `sin(pi)` 除以 2，
      // 结果 0.75 而不是 1.75（多轮实测：`\frac34+\sin\frac\pi2` 算出 0.75）。
      // 所以遇到函数名，必须把**紧跟其后的那个操作数**整体包进调用括号。
      const items = n.items || [];
      const parts = [];
      for (let i = 0; i < items.length; i += 1) {
        const it = items[i];
        const isFn = it?.kind === 'sym' && it.isFunctionName;
        if (isFn) {
          const fn = emit(it);
          if (!fn.ok) return fn;
          // 后面的那个 item 是它的参数（数学排版里函数名与参数就是相邻的两块）
          const next = items[i + 1];
          if (next) {
            const arg = emit(next);
            if (!arg.ok) return arg;
            parts.push(`${fn.code}(${arg.code})`);
            i += 1;                        // 参数已消费
          } else {
            parts.push(fn.code);           // 光秃秃的函数名：留着，由外层判错
          }
          continue;
        }
        const r = emit(it);
        if (!r.ok) return r;
        parts.push(r.code);
      }
      return { ok: true, code: joinParts(parts) };
    }

    case 'num':
      return { ok: true, code: String(n.literal ?? n.glyph ?? n.value ?? '') };

    case 'sym':
      return emitSym(n);

    case 'op': {
      const g = n.glyph || n.tex || '';
      if (g === '×' || g === '·' || g === '⋅' || g === '\\times' || g === '\\cdot') {
        return { ok: true, code: '*' };
      }
      if (g === '÷') return { ok: true, code: '/' };
      if (g === '−' || g === '-') return { ok: true, code: '-' };
      if (g === '+') return { ok: true, code: '+' };
      if (g === '=' ) return { ok: true, code: '==' };   // 关系式在 Octave 里是 ==
      return { ok: true, code: g };
    }

    case 'frac': {
      const a = emit(n.num), b = emit(n.den);
      if (!a.ok) return a; if (!b.ok) return b;
      return { ok: true, code: `(${a.code})/(${b.code})` };
    }

    case 'root': {
      // \sqrt{x} → sqrt(x)；n 次根暂不支持（Octave 里要写成 x^(1/n)，
      // 但 IR 的 index 语义要逐个核对，先不做）
      const body = emit(n.body || n.base);
      if (!body.ok) return body;
      return { ok: true, code: `sqrt(${body.code})` };
    }

    case 'script': {
      // 上下标：`x^{2}` → `x^2`，`x_{1}` → `x(1)`（下标在 Octave 里是索引）
      const base = emit(n.base);
      if (!base.ok) return base;
      if (n.sup) {
        const s = emit(n.sup);
        if (!s.ok) return s;
        return { ok: true, code: `(${base.code})^(${s.code})` };
      }
      if (n.sub) {
        const s = emit(n.sub);
        if (!s.ok) return s;
        // 纯数字下标 → 索引；非数字下标 → 变量名的一部分（如 U_{ab}）
        if (/^[0-9]+$/.test(s.code)) return { ok: true, code: `${base.code}(${s.code})` };
        return fail(`带字母的下标（${n.sub.text || ''}）在 Octave 里没有直接对应物`);
      }
      return { ok: true, code: base.code };
    }

    case 'env':
      return emitEnv(n);

    case 'accent': {
      // 上划线 = 逻辑取反，在 Octave 里是 ~
      const g = n.glyph || n.accent || '';
      const body = emit(n.base || n.body);
      if (!body.ok) return body;
      if (/^[‾_¯̄]$/.test(g) || n.tex === '\\overline') {
        return { ok: true, code: `(~(${body.code}))` };
      }
      return fail(`不认识的修饰符「${g}」`);
    }

    case 'space':
      return { ok: true, code: ' ' };

    case 'bigop':
      return fail('求和/连乘（\\sum、\\prod）要展开成循环，暂不支持');

    case 'ellipsis':
      return fail('省略号（\\cdots 等）不是可计算的表达式');

    case 'fence': {
      // 括号本身透明：`(a+b)` 的分组语义已由 group 承担
      const body = emit(n.body);
      return body.ok ? body : body;
    }

    case 'label':
      return fail('公式编号（\\tag）不是表达式的一部分');

    case 'phantom':
      return fail('占位符（\\phantom）不可计算');

    case 'raw':
      return fail(`无法翻译的原始片段「${(n.text || '').slice(0, 20)}」`);

    case 'stack':
      return fail('堆叠结构（\\substack / 分段）暂不支持');

    case 'arrow':
      return fail('箭头（→）不是可计算的运算符');

    case 'literal':
      return { ok: true, code: String(n.text ?? '') };

    case 'rowbreak':
      return fail('换行符不是表达式的一部分');

    case 'styled': {
      // \mathbf / \mathrm 之类只改字形，数学上是同一个符号
      return emit(n.base || n.body);
    }

    default:
      return fail(`不认识的节点类型「${n.kind}」`);
  }
}

function emitSym(n) {
  const tex = n.tex || '';
  const glyph = n.glyph || '';

  // 常量
  if (CONST_MAP[tex] || CONST_MAP[glyph]) {
    return { ok: true, code: CONST_MAP[tex] || CONST_MAP[glyph] };
  }

  // 函数名（`\sin` 这类，isFunctionName 由解析器标出）
  const bare = tex.replace(/^\\/, '');
  if (FN_MAP[bare]) return { ok: true, code: FN_MAP[bare] };
  if (n.isFunctionName && FN_MAP[glyph]) return { ok: true, code: FN_MAP[glyph] };

  // 希腊字母：Octave 里没有 α 变量，但同名英文是可用的
  const GREEK = {
    alpha: 'alpha', beta: 'beta', gamma: 'gamma', delta: 'delta',
    epsilon: 'epsilon', zeta: 'zeta', eta: 'eta', theta: 'theta',
    lambda: 'lambda', mu: 'mu', nu: 'nu', xi: 'xi', rho: 'rho',
    sigma: 'sigma', tau: 'tau', phi: 'phi', chi: 'chi', psi: 'psi', omega: 'omega',
    Gamma: 'Gamma', Delta: 'Delta', Theta: 'Theta', Lambda: 'Lambda',
    Sigma: 'Sigma', Phi: 'Phi', Psi: 'Psi', Omega: 'Omega',
  };
  if (GREEK[bare]) return { ok: true, code: GREEK[bare] };

  // 普通字母：**这是"算不了"的主要来源**——U、I、R 在 Octave 里是未定义变量
  if (/^[A-Za-z]$/.test(glyph)) {
    return fail(`符号「${glyph}」没有数值，Octave 里是未定义变量。要算就把它的值写进去`);
  }
  // 多字母（如 \mathrm{d}x 里的 dx）
  if (/^[A-Za-z]+$/.test(glyph)) {
    return fail(`符号「${glyph}」没有数值，Octave 里是未定义变量`);
  }
  // 运算符符号（`site/math` 把 `\times` 这类判成 role=operator 的 sym，
  // 不是 op 节点）——必须换成 Octave 认的运算符，不能原样吐 `×`。
  const OP_MAP = {
    '×': '*', '·': '*', '⋅': '*', '÷': '/', '−': '-',
    '≤': '<=', '≥': '>=', '≠': '~=', '≈': '~=', '±': '+/-',
    '=': '==',
  };
  if (OP_MAP[glyph]) return { ok: true, code: OP_MAP[glyph] };
  if (isOperatorGlyph(glyph)) return { ok: true, code: glyph };

  return fail(`不认识的符号「${glyph || tex}」`);
}

function emitEnv(n) {
  const name = (n.env || n.name || '').replace(/\*$/, '');
  // ⚠️ 竖线包起来的**不是矩阵，是行列式**（2026-10-31 站长指出：
  //    `\begin{vmatrix}2&-1&1\\…\end{vmatrix}` 输出"矩阵中的数字本身"是错的）。
  //    `vmatrix` 的 delims 是 `|…|`、`Vmatrix` 是 `‖…‖`——数学语义都是 det，
  //    不是"把元素列出来"。所以这两类要包一层 det()。
  const DET_ENVS = ['vmatrix', 'Vmatrix'];
  const MATRIX_ENVS = ['pmatrix', 'bmatrix', 'matrix', 'Bmatrix'];
  if (DET_ENVS.includes(name) || MATRIX_ENVS.includes(name)) {
    const rows = n.rows || [];
    if (!rows.length) return fail('空矩阵');
    const parts = [];
    // ⚠️ 结构是 `rows[rowIdx][cellIdx]` = **节点数组**（一个单元格里可以有多个节点，
    // 如 `-1`、`1/2`）。第一版把 cell 当成单个节点 emit，递归进去遇到数组就
    // 报「不认识的节点类型 undefined」。
    for (const row of rows) {
      const cells = [];
      for (const cell of (row || [])) {
        const nodes = Array.isArray(cell) ? cell : [cell];
        // ⚠️ 单元格内的片段**不能一律用空格拼**（2026-10-31 站长实测
        // `\begin{vmatrix}2&-1&1\\...` 报 `vertical dimensions mismatch (1x2 vs 1x3)`）。
        //
        // 原因：`-1` 在 IR 里是**两个节点**（`op '-'` + `num '1'`），用空格拼成
        // `- 1`，Octave 把它读作「减 1」而不是「负一」——于是 `2 - 1 1` 被当成
        // `[2-1, 1]` 两个元素，该行少一列，与别的行列数不符。
        //
        // 正确拼法照 Octave 的列分隔规则：只有**相邻两个操作数之间**才需要空格
        // （否则 `2 3` 会粘成 `23`）；运算符两侧**不留空格**。
        let cellCode = '';
        let prevWasOperand = false;
        for (const node of nodes) {
          const r = emit(node);
          if (!r.ok) return r;
          const isOperand = node.kind === 'num' || node.kind === 'sym' || node.kind === 'env'
            || node.kind === 'root' || node.kind === 'frac' || node.kind === 'script';
          // 只在「前一个是操作数 且 当前也是操作数」时补空格
          if (cellCode && prevWasOperand && isOperand) cellCode += ' ';
          cellCode += r.code;
          prevWasOperand = isOperand;
        }
        cells.push(cellCode || '0');
      }
      parts.push(cells.join(' '));
    }
    const mat = `[${parts.join('; ')}]`;
    // 竖线包起来 ⇒ 行列式，包一层 det()
    if (DET_ENVS.includes(name)) return { ok: true, code: `det(${mat})` };
    return { ok: true, code: mat };
  }
  if (name === 'cases' || name === 'array') {
    return fail('分段定义（cases/array）不是单个表达式，没法一次求值');
  }
  return fail(`不认识的数学环境「${name}」`);
}

/** 把一串片段拼起来，按需补运算符间的空格（`2 3` 会被 Octave 当成矩阵）。 */
function joinParts(parts) {
  let out = '';
  for (const p of parts) {
    if (!p) continue;
    if (p === ' ') { out += ' '; continue; }
    const needSpace = out && !/[\s(\[{+\-*/^==~]$/.test(out) && !/^[\s)\]},;+\-*/^==~]/.test(p);
    out += (needSpace ? ' ' : '') + p;
  }
  return out.trim();
}

function fail(reason) {
  return { ok: false, reason };
}
