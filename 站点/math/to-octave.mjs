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
 * 若节点是 `标签 = 表达式` 的形状，返回**右边**那部分；否则返回 null。
 *
 * 只在最保守的形态上下手（见 translate 里的说明）：左边必须**恰好一个操作数**。
 * 左边一旦是复合表达式（`a+b = c`），那就是真等式，不该当成赋值。
 */
function stripAssignment(n) {
  if (!n || n.kind !== 'group') return null;
  const items = n.items || [];
  const eq = items.findIndex((it) => it.kind === 'op' && (it.glyph || it.tex) === '=');
  if (eq <= 0 || eq >= items.length - 1) return null;

  const lhs = items.slice(0, eq).filter((it) => it.kind !== 'space');
  const rhs = items.slice(eq + 1).filter((it) => it.kind !== 'space');
  if (!lhs.length || !rhs.length) return null;

  // 左边必须是「名字」形态：`X`、`X_1`、`R(A)` 这类**标签**。
  //
  // ⚠️ 第一版只认 `lhs.length === 1`，于是 `R(A) = 2` 被拒（2026-11-01 实测）：
  // `R(A)` 在 IR 里是**四个**同级 item（`sym(R) | ( | sym(A) | )`），
  // 不是嵌套结构。所以判据要看「整段是不是一个名字形状」，不是「几个 item」。
  if (!isNameLikeSeq(lhs)) return null;

  // 右边如果还有 `=`（`a = b = c`），不猜，交给后续判据（会判成关系式）。
  if (rhs.some((it) => it.kind === 'op' && (it.glyph || it.tex) === '=')) return null;

  // 把右边的项重新构成一个 group 节点（保持 kind/items 结构，emit 能直接吃）
  return { ...n, items: rhs };
}

/**
 * 一段 item 序列是不是「能当等号左边的名字」。
 *
 * 认三种形态（都是「一个标签」而不是「一个算式」）：
 *   · `X`          一个符号
 *   · `X_1`        符号 + 上下标
 *   · `R(A)`       符号 + 一对配平括号（括号里任意）
 * 不认：`3`、`a+b`、矩阵、裸运算符 —— 那些是算式或字面，不是名字。
 */
function isNameLikeSeq(seq) {
  if (!seq.length) return false;
  // 带样式壳（`\mathrm{R}`）先剥
  const items = [];
  for (const it of seq) {
    if (it.kind === 'styled') {
      const inner = [it.base || it.body].filter(Boolean);
      items.push(...inner);
    } else if (it.kind === 'script' && it.base) {
      // `X_1` 整体当一个名字
      items.push({ kind: '__name__' });
    } else {
      items.push(it);
    }
  }
  if (!items.length) return false;
  // 形态 A：整段就是一个符号
  if (items.length === 1 && (items[0].kind === 'sym' || items[0].kind === '__name__')) return true;
  // 形态 B：符号开头，后面全是一对配平括号包着的东西（`R(A)`、`f(x,y)`）
  const head = items[0];
  if (!(head.kind === 'sym' || head.kind === '__name__')) return false;
  const rest = items.slice(1);
  if (!rest.length) return true;
  if (rest[0].kind !== 'op') return false;
  let depth = 0;
  for (const it of rest) {
    const g = it.glyph || it.tex || '';
    if (it.kind === 'op' && (g === '(' || g === '[')) depth += 1;
    else if (it.kind === 'op' && (g === ')' || g === ']')) {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;      // 括号必须配平，且整段都是括号段
}

/**
 * 把 IR 节点转成 Octave 代码。
 * @returns {{ok: true, code: string} | {ok: false, reason: string}}
 */
export function translate(node) {
  // ⚠️ **赋值形式 `X = 表达式` 只算右边**（2026-11-01 站长实拍）。
  //
  // 现场：`$$D=\begin{vmatrix}0&-27&-35\\…\end{vmatrix}$$` 被判「不可算」，
  // 因为左边那个 `D` 是未定义符号 —— 但 `D` 在这里是**标签**（「这个行列式的
  // 值记作 D」），不是参与运算的量。读者想算的显然是右边那个行列式。
  //
  // 判据：group 的同级 items 形如 `<单个操作数>  =  <其余>` 时，只 emit 其余部分。
  // 只认「左边是**恰好一个**操作数（或样式包裹里的一个操作数）」这种最保守的形态：
  //   · `D = det(...)`        ✔ 左边一个符号
  //   · `R(A) = 2`            ✔ 左边一个调用
  //   · `x = 3`               ✔
  //   · `a + b = c`           ✘ 左边是表达式，那是真等式（照旧判关系式不可算）
  //   · `D_1 = …`             ✔ 左边一个带下标符号
  const rhsNode = stripAssignment(node);
  const target = rhsNode || node;

  const r = emit(target);
  if (!r.ok) return r;
  const out = String(r.code).trim();

  // ── 最低限度的合法性校验（**只留这三条**）────────────────────────────
  //
  // 2026-11-01 站长定案：**可算性只认手动标记**（md 里写 `{:calc}`），
  // 构建期标了但算不了就抛错。所以这个函数不再负责「这条公式适不适合给
  // 读者算」—— 那个判断交给作者。这里只拦**产物的结构性残缺**：
  // 这种产物连 Octave 都读不成表达式，说明转译器本身出了问题（或者原文
  // 根本不是表达式），无论谁标记都不该放过。
  //
  // ⚠️ **历史上这里堆过 18 条启发式判据**（隐含乘法、坐标记法、单位、
  // 百分号、题号前缀、孤立常数…）。结论：那条路不通。
  //    · 每加一条都可能误伤 —— 实测 `] [` 被当成并置，把所有矩阵乘法
  //      误杀；`-10` 被当成「以运算符开头」，一元负号全灭；
  //    · 形态是**无穷的**（数学排版里的隐含乘法怎么写都行），判据永远补不完；
  //    · 而且它解决的是「该不该有按钮」，那本该由作者说话，不该由正则猜。
  // 现在只留三条，且每条都是**产物结构坏到无法求值**的判据。

  // ① 只有运算符，没有可算的量（`+`、`=`、`-` 这类）。
  //    判据：去掉空白/括号/运算符后还剩不剩东西。
  const bare = out
    .replace(/[\s()\[\]]/g, '')
    .replace(/==|~=|<=|>=|[+\-*/^=~]/g, '');
  if (!bare) return fail('这不是一个完整的表达式（只有运算符，没有可算的量）');

  // ② 空括号 `()`：说明函数名的参数被吃掉了（`det()`、`sin()`）。
  //    那是转译器漏了东西，产物必然求值失败。
  if (/\(\s*\)/.test(out)) return fail('公式里有空括号（函数没拿到参数），没法求值');

  // ③ 运算符悬空：以运算符开头（关系符/连接符，`==0`、`=x`）或
  //    以运算符结尾（`2*`、`x+`）。
  //    ⚠️ **一元负号是合法开头**（`-10`、`-(2+3)`），所以开头允许 `-`。
  if (!/^[0-9A-Za-z_([~\-]/.test(out)) {
    return fail('公式以运算符开头（没有左边的量），没法求值');
  }
  if (/[+\-*/^<>=~&|]$/.test(out)) {
    return fail('公式以运算符结尾（右边的量缺了），没法求值');
  }

  // ④ 两个操作数并置（`(1) [3 2 -4; …]`、`) 标识符`）。
  //
  // ⚠️ 这条**必须留**（2026-11-01 实测）：上一轮精简判据时把它一起删了，
  // 于是「题号写进公式」的形态重新被判成可算 —— 产物 `(1) [3 2 -4; …]`
  // 在 Octave 里是 syntax error，读者一点就吃红字。
  // 这里只拦**产物层面**的并置（转译确实产出了两个挨着的操作数），
  // 不再从原文猜「题号是不是不该在公式里」—— 那属于作者的选择，由
  // `{:calc}` 标记把关（标了但算不了 → 构建期抛错）。
  //
  // ⚠️ **`] [` 不能拦**：两个矩阵挨着是 Octave 里合法的**矩阵乘法**
  // （`[1 2;3 4][5;6]` 完全能跑）。只认「圆括号后接东西」那种形态。
  if (/\)\s*[\[(]/.test(out) || /\)\s*[A-Za-z_]/.test(out)) {
    return fail('公式里有两个并排的量（例如题号加矩阵），Octave 里没法当成一个表达式求值');
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

      // ⚠️ **特例：`\det` 后面直接跟竖线矩阵**（2026-11-06 站长实测：
      // 「矩阵能出结果，改 border 成行列式竖线后点计算出不了结果」）。
      //
      // 病因：`vmatrix`/`Vmatrix` 在 emitEnv 里**已经自己包了一层 det()**
      // （那是为了「只有竖线、没写 \det」的写法）。而 `\det\begin{vmatrix}…`
      // 里 \det 是函数名，按情形 B 吃掉整个 vmatrix ⇒ `det(det([...]))`，
      // Octave 报参数错。全站 `\det|A|` 与 `\det\begin{vmatrix}` 两种写法都有，
      // 所以这里必须去重而不是删掉 emitEnv 的包裹。
      if (next && next.kind === 'env') {
        const envName = String(next.env || next.name || '').replace(/\*$/, '');
        if (fn.code === 'det' && (envName === 'vmatrix' || envName === 'Vmatrix')) {
          // 直接内联矩阵本体，外层这一个 det 就是语义上的那个
          const bare = emitEnvBare(next);
          if (!bare.ok) return bare;
          parts.push(`det(${bare.code})`);
          i += 1;
          continue;
        }
      }

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
 * ⚠️ 只认 `) [` 与 `) (`（**不含 `] [`**，2026-11-01 实测）：`] [` 是合法的
 * 矩阵乘法（`[1 2;3 4][5;6]` 在 Octave 里完全能跑）。把 `] [` 写进判据会让
 * 所有矩阵乘法失去播放按钮。
 * 也不认 `2 3`（矩阵内部合法的列分隔）。
 * 误报代价很高（会让能算的公式失去播放按钮），所以判据取最保守的形态。
 */
const JUXTAPOSED_RE = /\)\s*[\[(]/;

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

/**
 * 输出矩阵环境的**裸矩阵代码**（不包 det），供「\det + vmatrix」去重使用。
 *
 * 与 emitEnv 共用同一套单元格拼接规则（见 emitEnv 里的长注释：单元格内
 * 「相邻操作数才补空格，运算符两侧不补」——否则 `-1` 会被读成「减 1」）。
 */
function emitEnvBare(n) {
  const rows = n.rows || [];
  if (!rows.length) return fail('空矩阵');
  const parts = [];
  for (const row of rows) {
    const cells = [];
    for (const cell of (row || [])) {
      const nodes = Array.isArray(cell) ? cell : [cell];
      let cellCode = '';
      let prevWasOperand = false;
      for (const node of nodes) {
        const r = emit(node);
        if (!r.ok) return r;
        const isOperand = node.kind === 'num' || node.kind === 'sym' || node.kind === 'env'
          || node.kind === 'root' || node.kind === 'frac' || node.kind === 'script';
        if (cellCode && prevWasOperand && isOperand) cellCode += ' ';
        cellCode += r.code;
        prevWasOperand = isOperand;
      }
      cells.push(cellCode || '0');
    }
    parts.push(cells.join(' '));
  }
  return { ok: true, code: `[${parts.join('; ')}]` };
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
    // ⚠️ 两个**矩阵/括号**挨着时不能补空格（2026-11-01 实测）：
    // `] [` 在 Octave 里是**两条语句**（`disp([1 2][3 4])` 才是矩阵乘法），
    // 于是 `[1 2;0 1] [2 1;1 1]` 报 syntax error。并置矩阵必须紧贴。
    const needSpace = out && !/[\s(\[{+\-*/^==~]$/.test(out)
      && !/^[\s)\]},;+\-*/^==~]/.test(p)
      && !(/[)\]]$/.test(out) && /^\[/.test(p));     // `]` + `[` = 乘法，不能空格
    out += (needSpace ? ' ' : '') + p;
  }
  return out.trim();
}

function fail(reason) {
  return { ok: false, reason };
}
