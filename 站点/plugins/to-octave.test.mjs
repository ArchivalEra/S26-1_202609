// LaTeX → Octave 转译器（`站点/math/to-octave.mjs`）的闸门。
//
// ## 为什么这个模块值得单独测
//
// 它是「运行」按钮的唯一翻译层：读者在 MathLive 里改了公式、点运行，能不能算出
// 数全看它。错一条就是算错一个数——而且**看起来像对的**（Octave 会给个值）。
//
// 实测踩过两个真 bug，都在这条测试里钉住：
//   ① `\sin\frac{\pi}{2}` 的 IR 是「函数名 sym + 参数」两个**同级 item**，
//      逐项拼接得到 `sin (pi)/(2)`，Octave 读成 sin(pi)/2 = 0（正确是 1）；
//   ② 矩阵的 `rows[row][cell]` 里 cell 是**节点数组**，当成单节点 emit 会崩。
//
// ## 判据两层
//
// ① 结构：能转的转出**预期代码**（精确匹配，不是「包含某子串」）；
// ② 态度：不能转的必须给出**非空中文原因**，绝不返回一个「看起来能跑」的串。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../math/parser.mjs';
import { translate } from '../math/to-octave.mjs';

const tr = (tex) => translate(parse(tex).expr.root);

/** 能算的：断言转出的代码与预期逐字一致。 */
const COMPUTES = [
  // [LaTeX, 预期 Octave 代码]
  ['5', '5'],
  ['\\frac{3}{4}', '(3)/(4)'],
  ['\\sqrt{16}', 'sqrt(16)'],
  ['2\\times 3', '2*3'],
  ['\\pi', 'pi'],
  ['\\frac{3}{4}+\\sin\\frac{\\pi}{2}', '(3)/(4)+sin((pi)/(2))'],
  ['\\det\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}', 'det([1 2; 3 4])'],
  ['\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}', '[1 2; 3 4]'],
  // 竖线包起来的是**行列式**不是矩阵（2026-10-31 站长指出「3x3 矩阵算出来是
  // 数字本身」—— 因为 vmatrix 被当普通矩阵输出了，语义错）
  ['\\begin{vmatrix}1&2\\\\3&4\\end{vmatrix}', 'det([1 2; 3 4])'],
  ['\\begin{Vmatrix}1&2\\\\3&4\\end{Vmatrix}', 'det([1 2; 3 4])'],
  ['\\sin\\frac{\\pi}{2}', 'sin((pi)/(2))'],
];

for (const [tex, want] of COMPUTES) {
  test(`可算：${tex} → ${want}`, () => {
    const r = tr(tex);
    assert.equal(r.ok, true, `应当能转，实际拒绝：${r.reason || ''}`);
    assert.equal(r.code, want);
  });
}

/** 算不了的：必须拒绝，且原因是中文、非空、说得出为什么。 */
const REFUSES = [
  ['U=IR', /没有数值/],
  ['U_{ab}', /没有数值/],
  ['\\sum_{k=1}^{3}k', /求和/],
  ['\\begin{cases} 1 & x>0 \\\\ 0 & x\\le 0 \\end{cases}', /分段|cases|不认识/],
  ['\\cdots', /省略号|不认识/],
  ['x \\to 0', /没有数值|箭头/],
];

for (const [tex, pat] of REFUSES) {
  test(`不可算：${tex} 必须明说原因`, () => {
    const r = tr(tex);
    assert.equal(r.ok, false, `这条不该被转成可执行代码（会算出错数）`);
    assert.ok(r.reason && r.reason.length >= 4, '原因不能是空串');
    assert.match(r.reason, pat, `原因要说清为什么：实际「${r.reason}」`);
  });
}

test('矩阵单元格：负号不能与数字之间留空格（会变成减法）', () => {
  // 2026-10-31 站长实测报 `vertical dimensions mismatch (1x2 vs 1x3)`，公式是
  //   \begin{vmatrix}2&-1&1\\3&2&1\\1&-2&1\end{vmatrix}
  // 根因：`-1` 在 IR 里是**两个节点**（op '-' + num '1'），用空格拼成 `- 1`，
  // Octave 读作「减 1」⇒ 该行 `2 - 1 1` 被解析成 `[2-1, 1]` 两个元素，
  // 与邻行的三列不符。
  const r = tr('\\begin{vmatrix}2&-1&1\\\\3&2&1\\\\1&-2&1\\end{vmatrix}');
  assert.equal(r.ok, true, `应当能转：${r.reason || ''}`);
  assert.equal(r.code, 'det([2 -1 1; 3 2 1; 1 -2 1])',
    `负号必须紧贴数字（写成 '- 1' 会被 Octave 当成减法，整行少一列）：${r.code}`);
});

test('函数应用：参数必须整体进括号（sin(pi)/(2) 是错的）', () => {
  // 这条单独钉住实测 bug ①：拼错会得到 sin (pi)/(2)，Octave 算成 sin(pi)/2。
  const r = tr('\\sin\\frac{\\pi}{2}');
  assert.equal(r.ok, true);
  // 精确匹配：参数整体在括号里。拼错的形态是 `sin (pi)/(2)`（空格 + 单层括号）。
  assert.equal(r.code, 'sin((pi)/(2))',
    `函数参数没整体包住（拼成 sin (pi)/(2) 会让 Octave 算 sin(pi)/2）：${r.code}`);
});

test('矩阵：多层 rows/cell 结构不能崩（实测 bug ②）', () => {
  const r = tr('\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}');
  assert.equal(r.ok, true);
  assert.equal(r.code, '[1 2; 3 4]');
});

test('纯运算符不算完整表达式（不许「成功」转出 +、=、-）', () => {
  // 2026-10-31 实测：孤零零的 `+`、`-`、`=` 也被判成可算 —— 构建期据此给它们
  // 挂了播放按钮，运行时 Octave 报 syntax error（页面上就是一串红字框）。
  // 判据：转出来的代码去掉运算符/括号/空白后必须还剩东西。
  for (const tex of ['+', '-', '=', '(', ')']) {
    const r = tr(tex);
    assert.equal(r.ok, false, `「${tex}」不该被判成可算，实际转出「${r.code}」`);
    assert.match(r.reason, /不是一个完整的表达式|不认识|空|等式|不等式|运算符开头|运算符结尾/,
      `原因要说清：${r.reason}`);
  }
});

test('绝不返回空代码的「成功」', () => {
  // 空串交给 Octave 会得到 rc=0 但什么都没算 —— 比报错更糟（读者以为算过了）。
  for (const tex of COMPUTES.map((c) => c[0])) {
    const r = tr(tex);
    assert.equal(r.ok, true);
    assert.ok(r.code && r.code.trim().length > 0, `${tex} 转出了空代码`);
  }
});

// ══════════════════════════════════════════════════════════════════
// 2026-11-01 「仍然是计算错误」那一批（站长第三次报同一个症状）
//
// 病根与前两轮**同一个**：构建期判「能不能算」的判据太弱，于是页面挂上
// 播放按钮、读者一点就吃红字框。
//
// 这一轮不再靠猜判据，而是**在真浏览器里跑一遍全站**：
//   142 页、925 条挂按钮的公式，逐条喂给 Octave，记录每条的报错。
//   实测 50 条失败，全部落在下面这五个形态。于是每条形态一个断言 ——
//   这些**不是想象的边界情况**，是真实失败样本的归纳。
// ══════════════════════════════════════════════════════════════════

test('隐含乘法：数或括号紧贴标识符 → 不可算（实测 `2 pi`、`500 kVA` 报 syntax error）', () => {
  for (const tex of ['2\\pi', '4\\pi\\times10^{-7}', '\\sqrt2\\pi', '500\\ \\mathrm{kVA}']) {
    const r = tr(tex);
    assert.equal(r.ok, false, `「${tex}」不该判可算，实际转出「${r.code}」`);
  }
});

test('单位：\\mathrm{} 标成 literalMode=unit 的不是数值', () => {
  // 实测最后两条漏网是 `\mathrm{Y}`（单字母单位）。它走 literal 分支、
  // 根本不经过 sym 的「单字母 = 未定义变量」判据，所以必须单独拦。
  for (const tex of ['\\mathrm{Y}', '\\mathrm{kVA}', '\\mathrm{mm}']) {
    const r = tr(tex);
    assert.equal(r.ok, false, `单位「${tex}」不该判可算，实际转出「${r.code}」`);
  }
});

test('百分号 → 不可算（Octave 里 % 是注释符，后面整行被吃掉）', () => {
  for (const tex of ['3.21\\%', '1\\%']) {
    const r = tr(tex);
    assert.equal(r.ok, false, `「${tex}」不该判可算，实际转出「${r.code}」`);
  }
});

test('坐标记法：空格分隔的数串 → 不可算（要写成 [a, b, c]）', () => {
  for (const tex of ['(-12\\quad-14\\quad0)', '0\\ 0\\ 1', '(1, 2)', '(0, 1, 3, 6)']) {
    const r = tr(tex);
    assert.equal(r.ok, false, `「${tex}」不该判可算，实际转出「${r.code}」`);
  }
  // 反例：带方括号的向量是**合法**的，不能误伤
  const ok = tr('\\begin{pmatrix}1&2&3\\end{pmatrix}');
  assert.equal(ok.ok, true, '矩阵必须仍可算');
});

test('题号前缀后跟表达式 → 不可算（`(1) det(...)` 是两个并置的量）', () => {
  for (const tex of ['(1)\\quad\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}', '(1)\\ \\det(A)']) {
    const r = tr(tex);
    assert.equal(r.ok, false, `「${tex}」不该判可算，实际转出「${r.code}」`);
  }
});

test('关系式不给播放按钮（算出来是布尔值，不是读者要的答案）', () => {
  // 实测 `det([3 2; 1 2])==4~=0` 点开得到 `1` —— 那是推理步骤的真值，
  // 不是「这个行列式等于几」。关系式的数学内容是「成不成立」，不是「值是多少」。
  for (const tex of ['1=2', 'x=y', 'a\\le b']) {
    const r = tr(tex);
    assert.equal(r.ok, false, `关系式「${tex}」不该判可算，实际转出「${r.code}」`);
  }
  // 纯数值等式走的是「关系式」那条判据，理由必须点明（读者要知道为什么没按钮）
  const pure = tr('1=2');
  assert.match(pure.reason, /等式|不等式/, `纯数值等式要说清是关系式：${pure.reason}`);
});

test('函数应用：嵌套调用的括号必须成对（`\\sin(\\cos(0))` → sin(cos(0))）', () => {
  // 实测第一版输出 `sin(() cos(() 0))` —— 函数名吃掉的是那个 `(` 而不是括号内容。
  const r = tr('\\sin(\\cos(0))');
  assert.equal(r.ok, true);
  assert.equal(r.code, 'sin(cos(0))');
  // 括号数量必须配平（多一个少一个都是语法错）
  const bal = (s) => [...s].reduce((n, c) => n + (c === '(' ? 1 : c === ')' ? -1 : 0), 0);
  assert.equal(bal(r.code), 0, `括号不配平：${r.code}`);
});

test('希腊字母不许映射成同名变量（Octave 里它是未定义函数，实测报 unable to open）', () => {
  // 实测 `disp(alpha(1))` → `error: unable to open /src/work/...` ——
  // Octave 把 `alpha` 当函数名去加载同名脚本。上一版把它映射成变量，
  // 于是 8 条公式挂着按钮、一点一个红字框。
  for (const tex of ['\\alpha', '\\alpha_{1}', '2\\alpha_{1}+3\\alpha_{2}']) {
    const r = tr(tex);
    assert.equal(r.ok, false, `「${tex}」不该判可算，实际转出「${r.code}」`);
  }
});
