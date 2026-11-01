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

/**
 * 希腊字母（含大写）。它们**不是** Octave 变量 —— 见 emitSym 里的实测记录。
 * 判据用 tex 名而不是字形（`\alpha` 的 glyph 也是 `alpha`，两者要一致）。
 */
const GREEK_LETTERS = new Set([
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta',
  'theta', 'vartheta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'rho',
  'varrho', 'sigma', 'varsigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi',
  'psi', 'omega',
  'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon',
  'Phi', 'Psi', 'Omega',
]);

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

  // ⚠️ **并置校验：两个操作数挨在一起不是合法 Octave 表达式**
  // （2026-11-01 站长实测 `error: syntax error >>> disp((1) [3 2 -4; …])`）。
  //
  // 病根：题号 `(1)` 被当成 ordinary 的「数字加括号」，与紧随其后的矩阵
  // 拼成 `(1) [3 2 -4; …]`。数学排版里那是「(1) 这个矩阵」，书写合法；
  // Octave 里那是两个操作数并置，**语法错**。
  //
  // 而构建期判「能不能算」用的是同一个 translate —— 于是它给这条公式
  // 挂上了播放按钮，读者一点就吃一个红字框。这就是「判据太弱」的代价：
  // 只会「有没有内容」，不会「内容合不合法」。
  //
  // 判据：顶层出现 `) [`、`] [`、`) (` 这类**无运算符连接**的相邻操作数。
  // 注意排除正常形态：`a.*b`、函数调用 `sin(x)`、下标 `x(1)` 都有运算符或
  // 在同一操作数内部，不会命中。
  if (JUXTAPOSED_RE.test(r.code)) {
    return fail('公式里有两个并排的量（例如题号加矩阵），Octave 里没法当成一个表达式求值');
  }

  // ⚠️ **剩下的残缺形态**（2026-11-01 站长第三次报「仍然是计算错误」）。
  // 上一轮只拦了「并置」，但实测这一页还有一批**语法不成立**的产物被挂上了
  // 播放按钮：`det`（光秃秃函数名）、`==0`（只有关系符）、
  // `det(==) 1`（关系符当参数）、`3, 3, 1`（裸逗号列表）、
  // `diag (1, 1, 0)`（函数名与括号之间有空格 → Octave 读成两条语句）。
  // 读者一点就是红字框，比没有按钮更糟。
  //
  // 判据分两类，都取「**产物本身**」而不是「原文长什么样」——因为产物是
  // 唯一的真相（原文合法但译歪了，也必须拦下）：
  //
  //   ⓐ 顶层出现裸逗号（`a, b, c`）：Octave 里逗号只作语句分隔或在 `[]` 内作
  //      列分隔。顶层裸逗号 = 多条语句，`disp()` 吃不下 ⇒ 必错。
  //      （矩阵内部是 `[a, b]` 形态，有方括号包着，不算顶层。）
  //   ⓑ 空括号 `()`：说明函数名的参数被吃掉了（`det()`、`sin()`）⇒ 必错。
  const out = String(r.code).trim();

  // ⓑ 空括号
  if (/\(\s*\)/.test(out)) return fail('公式里有空括号（函数没拿到参数），没法求值');

  // ⓐ 顶层裸逗号：扫一遍，记括号/方括号深度，深度 0 处的逗号即非法。
  {
    let depth = 0;
    for (let k = 0; k < out.length; k += 1) {
      const ch = out[k];
      if (ch === '(' || ch === '[') depth += 1;
      else if (ch === ')' || ch === ']') depth -= 1;
      else if (ch === ',' && depth === 0) {
        return fail('公式里有一串并列的量（逗号分隔），不是一个能求值的表达式');
      }
    }
  }

  // ⓐ₂ **圆括号里的逗号列表**（`(1, 2)`、`(0, 1, 3, 6)`、`(1,0,-\frac32)`）：
  //     写成 `(a, b)` 是数学里的「坐标/向量」记法，Octave 里圆括号只做分组或
  //     索引，`(1, 2)` 是语法错（实测 14 条全栽在这一个形态）。
  //
  //     ⚠️ 判据必须**按深度扫描**，不能用正则（2026-11-01 实测）：
  //     `(1,0,-\frac32)` 译成 `(1, 0,-(3)/(2))` —— 里面有嵌套的 `(3)`，
  //     一层正则匹配不到最外层的逗号，于是漏了一条。
  //
  //     规则：对每个 `(`，找它配平的 `)`；这一段里**如果含逗号，且这个 `(`
  //     前面**没有**标识符（即不是函数调用），就是坐标记法 ⇒ 非法。
  {
    const stack = [];
    for (let k = 0; k < out.length; k += 1) {
      const ch = out[k];
      if (ch === '(') stack.push(k);
      else if (ch === ')') {
        const open = stack.pop();
        if (open === undefined) continue;
        const seg = out.slice(open + 1, k);
        if (seg.includes(',')) {
          // 看这个 `(` 前面紧邻的是不是函数名/标识符
          const before = out.slice(0, open).replace(/\s+$/, '');
          const isCall = /[A-Za-z0-9_]$/.test(before);
          if (!isCall) {
            return fail('公式里有「(a, b)」这种坐标记法，Octave 里要写成向量 [a, b]');
          }
        }
      }
    }
  }

  // ⓐ₃ **符号占位矩阵**（`[+ - +; - + -; + - +]`）：那种「正负号示意图」
  //     里每个格子是裸的 + / -，不是数。Octave 读成 `[+ - +]` 就是语法错。
  //     判据：方括号内出现「运算符紧挨运算符或分号」的连续段。
  if (/\[[^\]\[]*(\+|\-|;)\s*(\+|\-|;)[^\]\[]*\]/.test(out) && !/[0-9A-Za-z(]/.test(out.replace(/\[[^\]]*\]/g, ''))) {
    return fail('这是符号示意图（格子里只有正负号），不是数值矩阵');
  }

  // ⚠️ **工程公式的几个必错形态**（2026-11-01 全站实测：858 条可算公式里
  // 50 条在真 Octave 里报 syntax error，全部落在这几类）。
  // 共同点：它们**看起来**是数，实际带着单位/百分号/隐含乘法 ——
  // 数学上完全合理，Octave 里却不是表达式。
  // 每条判据都来自实测样本，不是猜的。

  // ① **数紧贴标识符**（`2 pi`、`500 kVA`、`10000 V`、`1 m`、`8.9 g/c`）：
  //    Octave 不认并置 —— 这就是 `2 pi` 报 `syntax error` 的形态。
  //    单位（`\mathrm{kVA}`）与常量（`pi`）在这一层看不出区别，也不必区分：
  //    「数字紧跟空白再跟标识符」本身就是非法表达式。
  //    `2 pi` / `500 kVA` / `4 pi` 全部命中；`sin(x)`、`2*pi`、`x(1)` 不命中。
  if (/[0-9]\s+[A-Za-z_][A-Za-z0-9_]*/.test(out)) {
    return fail('公式里有隐含乘法（数紧贴着符号/单位），Octave 里要显式写 * 或去掉单位');
  }
  // 右括号后紧跟标识符（`sqrt(2) pi`）同理。
  if (/\)\s+[A-Za-z_][A-Za-z0-9_]*(?![A-Za-z0-9_(])/.test(out)) {
    return fail('公式里有隐含乘法（括号紧贴着符号），Octave 里要显式写 *');
  }

  // ② 百分号：`\%` → `%`，在 Octave 里是**注释符**，后面整行都被吃掉。
  if (out.includes('%')) return fail('公式里有百分号，Octave 里那是注释符');

  // ③ 坐标记法/空格分隔的数字串（`(-12 -14 0)`、`0 0 1`）：
  //    产物里是「空格分隔的裸数字」，没有逗号也没有运算符。
  //    ⚠️ 两个写法都要拦（2026-11-01 实测）：`(-12 -14 0)` 有括号，
  //    `0 0 1` 没有 —— 上一版只写了带括号的形态，漏了后者。
  if (/[0-9\-]\s+[0-9\-]/.test(out)
      && !/[+*/^=<>~,;]/.test(out.replace(/^-/, ''))
      && !/\[/.test(out)) {
    return fail('公式里是空格分隔的一串数（坐标/向量记法），Octave 里要写成 [a, b, c]');
  }

  // ④ 题号前缀后跟函数调用（`(1) det(...)`）：与矩阵那条同族，
  //    但 JUXTAPOSED_RE 只认 `) [` / `) (`，漏了 `) 函数名`。
  if (/(?:\)|\]) *[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(out)) {
    return fail('公式里有两个并排的量（例如题号加表达式），Octave 里没法当成一个表达式求值');
  }

  // ⓒ 括号里只有运算符（`det(==)`、`(==)`）：那不是可求值的参数。
  const onlyOpsInParen = /[(\[]\s*(?:==|~=|<=|>=|[+\-*/^])+\s*[)\]]/;
  if (onlyOpsInParen.test(out)) return fail('公式里有只含运算符的括号，没法求值');

  // ⓓ 函数名与括号之间有空格（`det (1, 1, 0)`）：Octave 里 `f (x)` 是合法的
  //    调用写法，所以这条**不能拦**（实测 `diag (1, 1, 0)` 在 Octave 里能跑）。
  //    记在这里是因为上一版把它列进了怀疑名单：实测否掉了，不拦。

  // ⓔ 光秃秃的函数名（`det`、`sin`）：没有参数就没有值。
  //    （emit 遇到「函数名后面什么都没有」时会原样返回函数名。）
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(out) && FN_MAP[out]) {
    return fail(`公式里只有函数名「${out}」，没有要作用的对象`);
  }

  // ⓕ 开头/结尾是**运算符**（`==0`、`2*`、`x+`）：残缺表达式。
  //    实测原文 `==0`（两个等号）会被逐项转成 `==` + `==` + `0` = `====0` ——
  //    更荒谬的是它居然通过了前面所有判据（因为它有操作数 `0`）。
  //    还有 `(2,-4, 6,-2)==2*`（右侧运算符悬空）这种。
  //
  //    ⚠️ 一元负号是**合法**的（`-10`、`-x`、`-(2+3)` 都要能过），
  //    所以开头允许集里带 `-`；结尾一律不许是运算符（`x^2` 没问题，
  //    `x^` 不行）。
  if (!/^[0-9A-Za-z_([~\-]/.test(out)) {
    return fail('公式以运算符开头（没有左边的量），没法求值');
  }
  if (/[+\-*/^<>=~&|]$/.test(out)) {
    return fail('公式以运算符结尾（右边的量缺了），没法求值');
  }

  return { ok: true, code: out };
}


/**
 * 把一串「同级 item」转成一段代码。**group 与函数参数都走这里**。
 *
 * ## 为什么必须共用（2026-11-01 实测）
 *
 * `\sin(\cos(0))` 的 IR 是扁平的：`sym(sin) | ( | sym(cos) | ( | 0 | ) | )`。
 * 第一版把「函数参数的内部」用「逐项 emit」单独处理，于是内层的 `cos`
 * 不走函数应用逻辑，输出 `sin(cos (0))` —— 多一个空格（`joinParts` 以为
 * `cos` 与 `(0)` 是两个并排的量，补了空格）。
 *
 * 规则本身是**同一件事**：一串 token 里，函数名吞掉紧随的操作数。
 * 所以抽成一个函数，外层 group 与内层参数都必须调它。
 */
function emitSequence(items) {
  const parts = [];
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    const isFn = it?.kind === 'sym' && it.isFunctionName;
    if (isFn) {
      const fn = emit(it);
      if (!fn.ok) return fn;

      // 情形 A：函数名后紧跟开括号 ⇒ 参数是到配平闭括号为止的**整段**。
      // 这一步是第一版缺的：它只取「下一个 item」，于是 `sin` 吃掉那个 `(`。
      const maybeOpen = items[i + 1];
      if (maybeOpen && maybeOpen.kind === 'op'
          && (maybeOpen.glyph === '(' || maybeOpen.glyph === '[' || maybeOpen.tex === '\\left(')) {
        let depth = 0;
        let end = -1;
        for (let j = i + 1; j < items.length; j += 1) {
          const g = items[j].glyph || items[j].tex || '';
          if (g === '(' || g === '[') depth += 1;
          else if (g === ')' || g === ']') {
            depth -= 1;
            if (depth === 0) { end = j; break; }
          }
        }
        if (end < 0) return fail('函数调用的括号没有闭合');
        const inner = items.slice(i + 2, end);
        const arg = emitSequence(inner);        // ← 递归，同一套逻辑
        if (!arg.ok) return arg;
        parts.push(`${fn.code}(${arg.code})`);
        i = end;                                // 整个调用块已消费
        continue;
      }

      // 情形 B：函数名后紧跟一个普通操作数（`\sin\frac{\pi}{2}`、`\sin x`）
      const next = items[i + 1];
      if (next) {
        const arg = emit(next);
        if (!arg.ok) return arg;
        parts.push(`${fn.code}(${arg.code})`);
        i += 1;
      } else {
        parts.push(fn.code);                    // 光秃秃的函数名：留给外层判错
      }
      continue;
    }
    const r = emit(it);
    if (!r.ok) return r;
    parts.push(r.code);
  }
  return { ok: true, code: joinParts(parts) };
}

/**
 * 顶层「两个操作数并置」的形态。
 *
 * 只认**明显非法**的几种：`)` 或 `]` 紧跟着 `[` 或 `(`（中间只允许空白）。
 * 不去认 `2 3`（那在矩阵内部是合法的列分隔，且顶层被 joinParts 已经补过运算符）。
 * 误报代价很高（会让能算的公式失去播放按钮），所以判据取最保守的形态。
 */
const JUXTAPOSED_RE = /(?:\)|\])\s*[\[(]/;

function emit(n) {
  if (!n || typeof n !== 'object') return fail('空节点');

  switch (n.kind) {
    case 'group':
      // group 是**透明**的：它只是排版上的分组，数学上是同一个表达式。
      // 函数应用的整套判据都在 emitSequence 里（内外层必须**同一套**逻辑——
      // 2026-11-01 实测：第一版把内层参数逐项 emit，于是 `\sin(\cos(0))` 的
      // 内层 `cos` 不走函数应用，输出 `sin(cos (0))`，多一个空格、语义也偏）。
      return emitSequence(n.items || []);

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
      // ⚠️ 关系符**不给播放按钮**（2026-11-01 浏览器实测）。
      //
      // 上一版把 `=` 转成 `==`，于是 `det([3 2; 1 2])==4~=0` 这种**推理步骤**
      // 也被判「能算」，读者点开得到 `1`（布尔真）——那不是他想要的答案，
      // 反而像是「算错了」。关系式的数学内容是「这个等式成立」，不是「值是多少」。
      // 所以：`=`、`~=`、`<=`、`>=` 一律判为不可算（说清楚原因）。
      if (g === '=' || g === '\\approx' || g === '\\neq' || g === '~=') {
        return fail('这是等式/不等式（判断成不成立），不是能求值的算式');
      }
      if (g === '<' || g === '>' || g === '\\le' || g === '\\ge' || g === '\\leq' || g === '\\geq') {
        return fail('这是不等式（判断成不成立），不是能求值的算式');
      }
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
      // ⚠️ **单位**（`\mathrm{kVA}`、`\mathrm{Y}`、`\mathrm{mm}`）不是数值。
      // 解析器已经把它们的 `literalMode` 标成 `unit`（2026-11-01 全站实测抓到的
      // 最后两条漏网：`\mathrm{Y}` 单字母，靠「单字母 = 未定义变量」那条判据
      // 拦不住，因为它走的是 literal 分支，根本没经过 sym）。
      // 单位在物理公式里是**量纲标注**，不是可计算的量。
      if (n.literalMode === 'unit') {
        return fail(`「${n.text || ''}」是单位/量纲标注，不是可以求值的数`);
      }
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

  // ⚠️ **希腊字母不能映射成同名英文变量**（2026-11-01 浏览器实测）。
  //
  // 上一版把 `\alpha` → `alpha` 当作「Octave 里有同名变量」。实测：
  //   `disp(alpha(1))` → `error: unable to open /src/work/octave-install/
  //                       share/octave/11.3.0/...`（Octave 把它当**函数名**去
  //                       加载同名脚本，找不到就报这个错）
  //   `disp(2 alpha(1)+3 alpha(2))` → `error: syntax error`
  // 也就是说这个映射**从来没成功过**，它只是把「算不了」拖到了运行时，
  // 让 20 条里的 8 条挂着播放按钮、一点一个红字框。
  // 正确处置：希腊字母一律当「没有数值的符号」，与普通字母同待遇。
  if (GREEK_LETTERS.has(bare)) {
    return fail(`符号「${n.tex || bare}」没有数值，Octave 里是未定义变量。要算就把它的值写进去`);
  }

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
  // ⚠️ 关系符**不在**这张表里（理由见 op 分支：等式不是能求值的算式）。
  const OP_MAP = {
    '×': '*', '·': '*', '⋅': '*', '÷': '/', '−': '-',
  };
  if (OP_MAP[glyph]) return { ok: true, code: OP_MAP[glyph] };
  // 关系符：明确失败，别让它走到「原样吐符号」那条路
  if (/[=≈≠≤≥<>]|^\\[a-z]*eq|^\\[a-z]*leq|^\\[a-z]*geq/i.test(glyph)) {
    return fail('这是等式/不等式（判断成不成立），不是能求值的算式');
  }
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
