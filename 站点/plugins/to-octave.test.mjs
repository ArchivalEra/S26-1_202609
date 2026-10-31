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

test('绝不返回空代码的「成功」', () => {
  // 空串交给 Octave 会得到 rc=0 但什么都没算 —— 比报错更糟（读者以为算过了）。
  for (const tex of COMPUTES.map((c) => c[0])) {
    const r = tr(tex);
    assert.equal(r.ok, true);
    assert.ok(r.code && r.code.trim().length > 0, `${tex} 转出了空代码`);
  }
});
