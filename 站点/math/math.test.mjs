/**
 * 数学引擎测试：钉住这轮重构建立的不变量。
 *
 * 每条测试都对应一个**真实发生过或结构上必须成立**的事实，不是凑覆盖率。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenize, checkEnvironments } from './lexer.mjs';
import { parse } from './parser.mjs';
import { shapeKey, toPlain, digest, walk, collectTerms } from './ir.mjs';
import { compileDictionary, createResolver, bindTerms } from './terms.mjs';
import { irToTex, toDialect } from './render.mjs';
import { compile } from './index.mjs';

// ── 词法 ────────────────────────────────────────────────────────────

test('词法：控制序列与控制符号分开', () => {
  const { tokens } = tokenize('\\frac{1}{2}\\,x');
  const cs = tokens.filter((t) => t.kind === 'cs').map((t) => t.value);
  assert.deepEqual(cs, ['frac']);
  assert.ok(tokens.some((t) => t.kind === 'sym' && t.value === ','));
});

test('词法：数字合成一个记号（3.14 不是四个）', () => {
  const { tokens } = tokenize('3.14');
  const chars = tokens.filter((t) => t.kind === 'char');
  assert.equal(chars.length, 1);
  assert.equal(chars[0].value, '3.14');
});

test('词法：花括号不配平要报错且带位置', () => {
  const { problems } = tokenize('\\frac{1}{2');
  const p = problems.find((x) => x.code === 'lex-unclosed-group');
  assert.ok(p, '应报未闭合');
  assert.equal(typeof p.start, 'number');
});

test('词法：环境名不配对要报错', () => {
  const { tokens } = tokenize('\\begin{pmatrix}1\\end{vmatrix}');
  const problems = checkEnvironments(tokens);
  assert.ok(problems.some((p) => p.code === 'env-name-mismatch'));
});

// ── 解析 ────────────────────────────────────────────────────────────

test('解析：上下标成为 script 节点', () => {
  const { expr, problems } = parse('R_m^2');
  assert.equal(problems.length, 0);
  const n = expr.root.items[0];
  assert.equal(n.kind, 'script');
  assert.equal(n.sub.kind, 'sym');
  assert.equal(n.sup.kind, 'num');
});

test('解析：`\\frac14` 按两个单字符参数解（不是 `{14}`）', () => {
  const { expr, problems } = parse('\\frac14');
  assert.equal(problems.length, 0);
  const f = expr.root.items[0];
  assert.equal(f.kind, 'frac');
  assert.equal(f.num.literal, '1');
  assert.equal(f.den.literal, '4');
});

test('解析：`\\frac1\\lambda` 的参数是组，不是裸参数', () => {
  // 这是旧实现最容易崩的写法（插宏后 "Unexpected end of input in a macro argument"）。
  // 新解析器把参数包成 group，编回去必然带花括号 —— 结构上不可能再出这个错。
  const { expr } = parse('\\frac1\\lambda');
  const f = expr.root.items[0];
  assert.equal(f.kind, 'frac');
  assert.equal(f.num.kind, 'num');
  assert.equal(f.den.kind, 'sym');
  // 编回时必须带花括号
  const tex = irToTex(expr.root, { decorate: false });
  assert.match(tex, /\\frac\{1\}\{\\lambda\}/);
});

test('解析：`\\mathrm{…}` 里的内容是不可绑定的字面节点', () => {
  const { expr } = parse('\\mathrm{H/m}');
  const hit = [];
  walk(expr.root, (n) => { if (n.kind === 'literal') hit.push(n.text); });
  assert.ok(hit.includes('H/m'), '应产出 literal 节点');
  // 里面的 H、m 不该成为独立 sym 节点
  const syms = [];
  walk(expr.root, (n) => { if (n.kind === 'sym') syms.push(n.tex); });
  assert.deepEqual(syms, []);
});

test('解析：`\\text{…}` 内的中文原样保留', () => {
  const { expr } = parse('\\text{解}=x');
  assert.equal(expr.root.items[0].kind, 'literal');
  assert.equal(expr.root.items[0].text, '解');
});

test('解析：上标无基（`{}^14C`、`\\mathrm{^\\circ C}`）不报错', () => {
  for (const src of ['{}^14C', '\\mathrm{^\\circ C}']) {
    const { problems } = parse(src);
    assert.equal(problems.filter((p) => p.severity === 'error').length, 0, src);
  }
});

test('解析：环境成为 env 节点，行列拆开', () => {
  const { expr } = parse('\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}');
  const env = expr.root.items[0];
  assert.equal(env.kind, 'env');
  assert.equal(env.env, 'pmatrix');
  assert.equal(env.rows.length, 2);
  assert.equal(env.rows[0].length, 2);
});

test('解析：不认识的命令报错并保留原文（零回退）', () => {
  const { expr, problems } = parse('\\foobar{x}');
  const err = problems.find((p) => p.code === 'parse-unknown-command');
  assert.ok(err);
  assert.ok(expr.root.items.some((n) => n.kind === 'raw' && n.tex === '\\foobar'));
});

// ── IR 投影 ─────────────────────────────────────────────────────────

test('IR：形状键与书写细节无关（`R_L` 与 `R_{L}` 同键）', () => {
  // 旧实现在字符串上匹配，词典写 `R_L` 就漏掉 `R_{L}` —— 这是实测的漏网类型。
  const a = shapeKey(parse('R_L').expr.root);
  const b = shapeKey(parse('R_{L}').expr.root);
  assert.equal(a, b);
});

test('IR：形状键不受字体样式影响（`\\mathbf{F}` 与 `F` 同键）', () => {
  const a = shapeKey(parse('\\mathbf{F}').expr.root);
  const b = shapeKey(parse('F').expr.root);
  assert.equal(a, b);
});

test('IR：纯文本投影给出可读结果（标题锚点用）', () => {
  assert.equal(toPlain(parse('R_m').expr), 'Rm');
  assert.equal(toPlain(parse('\\frac{1}{2}').expr), '1/2');
  assert.equal(toPlain(parse('\\sqrt{2}').expr), '√2');
});

test('IR：摘要稳定（同输入同摘要，不同输入不同摘要）', () => {
  const a = digest(parse('R_m').expr);
  const b = digest(parse('R_m').expr);
  const c = digest(parse('R_L').expr);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

// ── 符号判定 ────────────────────────────────────────────────────────

const mkDict = (packEntries) => {
  const packs = { 测试: { page: 'p.md', entries: packEntries } };
  const { dictionary, problems } = compileDictionary(packs, { parse });
  return { dictionary, problems, packs };
};

test('判定：形状键命中（atom）', () => {
  const { dictionary } = mkDict([{ id: 'sym-Rm', tex: ['R_m'] }]);
  const res = createResolver(dictionary, { packs: ['测试'] });
  const { decisions } = bindTerms(parse('R_m').expr, res);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].ref.entry, 'sym-Rm');
  assert.equal(decisions[0].rule, 'atom');
});

test('判定：`\\mathrm{H/m}` 里的字母**不会**被取词', () => {
  // 这是旧系统最经典的事故：单位里的 H、m 被当成符号弹泡。
  // 新结构里它们是 literal 子树，判定器根本不进 —— 不是靠正则护住。
  const { dictionary } = mkDict([
    { id: 'sym-H', tex: ['H'] },
    { id: 'sym-m', tex: ['m'] },
  ]);
  const res = createResolver(dictionary, { packs: ['测试'] });
  const { decisions } = bindTerms(parse('\\mathrm{H/m}').expr, res);
  assert.equal(decisions.length, 0);
});

test('判定：同一个符号出现两次，命中两次（不是一次）', () => {
  const { dictionary } = mkDict([{ id: 'sym-Rm', tex: ['R_m'] }]);
  const res = createResolver(dictionary, { packs: ['测试'] });
  const { decisions } = bindTerms(parse('R_m+R_m').expr, res);
  assert.equal(decisions.length, 2);
  assert.equal(new Set(decisions.map((d) => d.ref.entry)).size, 1);
});

test('判定：外层命中后子树被遮蔽（不产生气泡套气泡）', () => {
  const { dictionary } = mkDict([
    { id: 'sym-Rm', tex: ['R_m'] },
    { id: 'sym-m', tex: ['m'] },
  ]);
  const res = createResolver(dictionary, { packs: ['测试'] });
  const { decisions } = bindTerms(parse('R_m').expr, res);
  assert.equal(decisions.length, 1, '只应有外层一条');
  assert.equal(decisions[0].ref.entry, 'sym-Rm');
});

test('判定：页面排除只否决自动通道，并记一条诊断', () => {
  const { dictionary } = mkDict([{ id: 'sym-A', tex: ['A'] }]);
  const res = createResolver(dictionary, {
    packs: ['测试'],
    exclude: { tex: ['sym-A'] },
  });
  const { decisions, problems } = bindTerms(parse('A=1').expr, res);
  assert.equal(decisions.length, 0);
  assert.ok(problems.some((p) => p.code === 'term-excluded'));
});

test('判定：正则族（pattern）只在整段匹配时命中', () => {
  const { dictionary } = mkDict([
    { id: 'sym-rowcol', tex: ['/([rc])_[0-9]+/'] },
  ]);
  const res = createResolver(dictionary, { packs: ['测试'] });
  const hits = bindTerms(parse('r_1+r_2').expr, res).decisions;
  assert.equal(hits.length, 2);
  // `r_1+r_2` 整段不该被当成一个 sym-rowcol
  assert.ok(hits.every((d) => d.matched !== 'r_1+r_2'));
});

test('判定：词典里形状键冲突要报出来（不许静默覆盖）', () => {
  const { problems } = mkDict([
    { id: 'sym-a', tex: ['R_m'] },
    { id: 'sym-b', tex: ['R_{m}'] },
  ]);
  assert.ok(problems.some((p) => p.code === 'dict-key-conflict'));
});

// ── 渲染与方言 ──────────────────────────────────────────────────────

test('渲染：IR 编回 TeX 时 `\\htmlData` 只包有 term 的节点', () => {
  const { dictionary } = mkDict([{ id: 'sym-Rm', tex: ['R_m'] }]);
  const res = createResolver(dictionary, { packs: ['测试'] });
  const { expr } = bindTerms(parse('R_m+x').expr, res);
  const tex = irToTex(expr.root, { decorate: true });
  assert.match(tex, /\\htmlData\{term=测试:sym-Rm\}/);
  assert.equal((tex.match(/htmlData/g) || []).length, 1, 'x 没有 term，不该被包');
});

test('方言：MathLive 需要 `\\dots`→`\\ldots`、`\\substack`→smallmatrix、环境边界插 {}', () => {
  const a = toDialect('a\\dots b', 'mathlive');
  assert.match(a.tex, /\\ldots/);
  const b = toDialect('\\substack{a\\\\b}', 'mathlive');
  assert.match(b.tex, /smallmatrix/);
  const c = toDialect('\\end{pmatrix}\\longrightarrow', 'mathlive');
  assert.match(c.tex, /\\end\{pmatrix\}\{\}/);
});

test('方言：嵌套花括号的 `\\substack` 也要被改写（实测漏过）', () => {
  const src = '\\xrightarrow[\\substack{a_{12}A_{12}\\\\+a_{32}A_{32}}]{x}';
  const out = toDialect(src, 'mathlive');
  assert.ok(!out.tex.includes('\\substack'), '不该残留 substack');
  assert.match(out.tex, /smallmatrix/);
});

test('方言：KaTeX 不做任何改写（它是原生支持）', () => {
  const src = 'a\\dots b\\substack{x}';
  const out = toDialect(src, 'katex');
  assert.equal(out.tex, src);
  assert.deepEqual(out.rewrites, []);
});

// ── 对外接口 ────────────────────────────────────────────────────────

test('compile：一次编译给出 docs、诊断、统计', () => {
  const { dictionary } = mkDict([{ id: 'sym-Rm', tex: ['R_m'] }]);
  const out = compile({
    blocks: [
      { raw: 'R_m=1', mode: 'display' },
      { raw: 'x+y', mode: 'inline' },
    ],
    page: 'p.md',
  }, { dictionary, packs: ['测试'], page: 'p.md' });
  assert.equal(out.docs.length, 2);
  assert.equal(out.stats.formulas, 2);
  assert.equal(out.stats.terms, 1);
  assert.equal(out.docs[0].terms.length, 1);
  assert.equal(out.docs[0].terms[0].ref.entry, 'sym-Rm');
});

test('compile：坏公式不抛异常，错误进 problems 带位置', () => {
  const { dictionary } = mkDict([]);
  const out = compile({ blocks: [{ raw: '\\frac{1}{2', mode: 'inline' }] },
    { dictionary, packs: ['测试'] });
  assert.ok(out.problems.some((p) => p.severity === 'error'));
  assert.equal(out.docs.length, 1, '坏公式仍产出 doc，不中断整页');
});

test('compile：collectTerms 从 IR 读，不依赖渲染', () => {
  const { dictionary } = mkDict([{ id: 'sym-Rm', tex: ['R_m'] }]);
  const out = compile({ blocks: [{ raw: 'R_m' }] }, { dictionary, packs: ['测试'] });
  const terms = collectTerms(out.docs[0].expr);
  assert.equal(terms.length, 1);
  assert.equal(terms[0].ref.entry, 'sym-Rm');
  // 形状键也在命中记录里，供回归比对
  assert.equal(typeof terms[0].shape, 'string');
});
