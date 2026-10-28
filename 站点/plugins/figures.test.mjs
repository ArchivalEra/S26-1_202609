import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parseFigureLib,
  kindOf,
  renderFigures,
  restoreFigures,
  renderStructureTable,
  labelToTspans,
  buildFigureIndex,
  FIGURES_CSS,
  FIGURES_JS,
} from './figures.mjs';

// ── 图库解析 ─────────────────────────────────────────────────────────────

test('图库：一行一条图元，id | DSL（首词即图种或元件名）', () => {
  const lib = parseFigureLib([
    '# 注释不算',
    'y-bc  | and B C -> Y',
    'y-not | not B -> nB',
    'wave-8 | wave 8',
  ].join('\n'));
  assert.equal(lib.size, 3);
  assert.equal(kindOf(lib.get('y-bc')), 'logic');
  assert.equal(kindOf(lib.get('wave-8')), 'wave');
  // body 保留整行原文——解析器自己认识首行
  assert.deepEqual(lib.get('y-bc').body, ['and B C -> Y']);
});

test('图库：续行属于上一个图元', () => {
  const lib = parseFigureLib([
    'wave-8 | wave 8',
    '  A: 01001100',
    '  B: 00110011',
  ].join('\n'));
  assert.deepEqual(lib.get('wave-8').body, ['wave 8', 'A: 01001100', 'B: 00110011']);
});

test('图库：id 重复要报错并指出两处行号', () => {
  assert.throws(
    () => parseFigureLib('a | and B C -> Y\na | or B C -> Y', 'lib.txt'),
    /id 重复.*「a」.*第 1 行/s);
});

test('图库：续行前没有图元要报错', () => {
  assert.throws(() => parseFigureLib('  孤立续行', 'lib.txt'), /不属于任何图元/);
});

// ── logic 图种 ───────────────────────────────────────────────────────────

test('logic：单行子句解析成输入/输出', () => {
  const lib = parseFigureLib('y | and B C -> Y');
  // 注意：kind 是 logic，DSL 第一词是 logic
  const r = renderFigures(':::figure y', { lib, pagePath: 'p.md' });
  const c = r.figures[0].payload.clauses[0];
  assert.equal(c.op, 'and');
  assert.deepEqual(c.ins, [
    { label: 'B', neg: false, term: null },
    { label: 'C', neg: false, term: null },
  ]);
  assert.deepEqual(c.outs, ['Y']);
});

test('logic：分号分隔多条子句，同名标签自动成网', () => {
  const lib = parseFigureLib('f | not B -> nB ; and A nB -> Y');
  const r = renderFigures(':::figure f', { lib });
  const cl = r.figures[0].payload.clauses;
  assert.equal(cl.length, 2);
  assert.deepEqual(cl[1].ins.map((x) => x.label), ['A', 'nB']);
});

test('logic：! 前缀表示取反输入', () => {
  const lib = parseFigureLib('f | and !B C -> Y');
  const r = renderFigures(':::figure f', { lib });
  assert.deepEqual(r.figures[0].payload.clauses[0].ins[0], { label: 'B', neg: true, term: null });
});

test('logic：不认识的元件要报错并列出可用的', () => {
  const lib = parseFigureLib('f | xyzzy A B -> Y', 'lib.txt');
  // 首词既不是已知元件也不是 wave/kmap ⇒ 图种都不认识，报错要列出全部可用图种
  assert.throws(() => renderFigures(':::figure f', { lib, libName: 'lib.txt' }),
    /图种不认识（首词「xyzzy」）.*可用.*and.*wave.*kmap/s);
});

test('logic：看不懂的子句要报错（不是静默丢弃）', () => {
  const lib = parseFigureLib('f | and B C Y', 'lib.txt');
  assert.throws(() => renderFigures(':::figure f', { lib, libName: 'lib.txt' }),
    /看不懂子句/);
});

test('logic：多输入的门至少两个输入', () => {
  const lib = parseFigureLib('f | and B -> Y', 'lib.txt');
  assert.throws(() => renderFigures(':::figure f', { lib, libName: 'lib.txt' }),
    /至少要有两个输入/);
});

// ── wave 图种 ────────────────────────────────────────────────────────────

test('wave：首行声明格数，之后标签: 电平串', () => {
  const lib = parseFigureLib(['w | wave 4', 'A: 0110', 'Q: 0011'].join('\n'));
  const r = renderFigures(':::figure w', { lib });
  const p = r.figures[0].payload;
  assert.equal(p.slots, 4);
  assert.equal(p.rows.length, 2);
  assert.deepEqual(p.rows[0].cells, ['0', '1', '1', '0']);
});

test('wave：`.` 表示保持上一格', () => {
  const lib = parseFigureLib(['w | wave 4', 'A: 01..'].join('\n'));
  const r = renderFigures(':::figure w', { lib });
  assert.deepEqual(r.figures[0].payload.rows[0].cells, ['0', '1', '1', '1']);
});

test('wave：非法电平字符要报错', () => {
  const lib = parseFigureLib(['w | wave 4', 'A: 01x1'].join('\n'), 'lib.txt');
  assert.throws(() => renderFigures(':::figure w', { lib, libName: 'lib.txt' }),
    /只能含 0\/1\/\.\/-/);
});

test('wave：缺格数声明要报错', () => {
  const lib = parseFigureLib(['w | wave', 'A: 0110'].join('\n'), 'lib.txt');
  assert.throws(() => renderFigures(':::figure w', { lib, libName: 'lib.txt' }),
    /首行要写成「wave <格数>」/);
});

// ── kmap 图种 ────────────────────────────────────────────────────────────

test('kmap：四变量网格 + 圈组', () => {
  const lib = parseFigureLib([
    'k | kmap 4',
    '0000', '1111', '1111', '0000',
    'box r1-2 c0-3',
  ].join('\n'));
  const r = renderFigures(':::figure k', { lib });
  const p = r.figures[0].payload;
  assert.equal(p.vars, 4);
  assert.deepEqual(p.rowCodes, ['00', '01', '11', '10']);
  assert.deepEqual(p.colCodes, ['00', '01', '11', '10']);
  assert.deepEqual(p.boxes, [{ r: [1, 2], c: [0, 3] }]);
});

test('kmap：格值行宽不匹配要报错', () => {
  const lib = parseFigureLib(['k | kmap 4', '000', '1111', '1111', '0000'].join('\n'), 'lib.txt');
  assert.throws(() => renderFigures(':::figure k', { lib, libName: 'lib.txt' }),
    /格值行宽应为 4/);
});

test('kmap：圈组超出网格要报错', () => {
  const lib = parseFigureLib(['k | kmap 4', '0000', '1111', '1111', '0000', 'box r0-9 c0-1'].join('\n'), 'lib.txt');
  assert.throws(() => renderFigures(':::figure k', { lib, libName: 'lib.txt' }),
    /超出网格/);
});

test('kmap：行数不匹配要报错', () => {
  const lib = parseFigureLib(['k | kmap 4', '0000', '1111'].join('\n'), 'lib.txt');
  assert.throws(() => renderFigures(':::figure k', { lib, libName: 'lib.txt' }),
    /应有 4 行格值/);
});

// ── 指令与占位符 ─────────────────────────────────────────────────────────

test('指令：单行换成占位符，正文其余不动', () => {
  const lib = parseFigureLib('y | and B C -> Y');
  const src = ['前文。', '', ':::figure y | 图 1 与门', '', '后文。'].join('\n');
  const r = renderFigures(src, { lib });
  assert.equal(r.figures.length, 1);
  assert.ok(r.source.includes('@@FIGURE_0@@'));
  assert.ok(!r.source.includes(':::figure'));
  assert.ok(r.source.includes('前文。') && r.source.includes('后文。'));
});

test('指令：图注取第一个 | 之后的全部（保留后续 |）', () => {
  const lib = parseFigureLib('y | and B C -> Y');
  const r = renderFigures(':::figure y | 图注里有 | 竖线', { lib });
  assert.equal(r.figures[0].caption, '图注里有 | 竖线');
});

test('指令：无图库中不存在的 id 要抛错并列出可用图元', () => {
  const lib = parseFigureLib('y-bc | and B C -> Y');
  assert.throws(
    () => renderFigures(':::figure 不存在', { lib, pagePath: 'p.md', libName: 'lib.txt' }),
    /不在图库.*现有图元.*y-bc/s);
});

test('指令：代码围栏里出现的 :::figure 不动', () => {
  const lib = parseFigureLib('y | and B C -> Y');
  const src = ['```', ':::figure y', '```'].join('\n');
  const r = renderFigures(src, { lib });
  assert.equal(r.figures.length, 0);
  assert.ok(r.source.includes(':::figure y'));
});

test('指令：没有 :::figure 时恒等返回（零改动）', () => {
  const src = '# 标题\n\n正文。\n';
  const r = renderFigures(src, {});
  assert.equal(r.source, src);
  assert.deepEqual(r.figures, []);
});

test('指令：一次只能引用一个图元（多图并排不做，明确拒绝）', () => {
  const lib = parseFigureLib(['a | and B C -> Y', 'b | or B C -> Y'].join('\n'));
  assert.throws(
    () => renderFigures(':::figure a b | 四联图', { lib, pagePath: 'p.md' }),
    /一次只能引用一个图元/);
});

test('指令：缺 id 要抛错', () => {
  assert.throws(() => renderFigures(':::figure | 只有图注', { pagePath: 'p.md' }),
    /缺少图元 id/);
});

test('logic：@词条 显式挂载，未写的标签不挂（不猜）', () => {
  const lib = parseFigureLib('f | and B@sym-VB C -> Y@sym-Y');
  const r = renderFigures(':::figure f', { lib });
  const c = r.figures[0].payload.clauses[0];
  assert.equal(c.ins[0].term, 'sym-VB');
  assert.equal(c.ins[1].term, null);
  assert.deepEqual(c.outTerms, ['sym-Y']);
});

test('logic：@词条 引用的词条不存在时不进 symbols（零回退，由 restore 决定上不上色）', () => {
  const lib = parseFigureLib('f | and B@sym-不存在 C -> Y');
  const r = renderFigures(':::figure f', {
    lib,
    lookupGloss: (id) => (id === 'sym-不存在' ? null : { key: id, href: '#' }),
  });
  assert.deepEqual(r.figures[0].symbols, []);
});

// ── 还原 ─────────────────────────────────────────────────────────────────

test('还原：占位符换成 <figure>，含 svg / 结构表 / JSON', () => {
  const lib = parseFigureLib('y | and B C -> Y');
  const r = renderFigures(':::figure y | 图 1', { lib });
  const html = restoreFigures(`<p>前</p>\n${r.source}\n<p>后</p>`, r.figures);
  assert.ok(html.includes('<figure class="fig"'));
  assert.ok(html.includes('<svg'));
  assert.ok(html.includes('<figcaption>图 1</figcaption>'));
  assert.ok(html.includes('class="fig-structure"'));
  assert.ok(html.includes('class="fig-data"'));
  assert.ok(!html.includes('@@FIGURE_'));
});

test('还原：JSON 里的 </ 被转义（防提前闭合 script）', () => {
  const lib = parseFigureLib('y | and B C -> Y');
  const r = renderFigures(':::figure y | 含 </script> 的图注', { lib });
  const html = restoreFigures(r.source, r.figures);
  assert.ok(!/<\/script>\s*<\/figure>/.test(html) || html.includes('<\\/'));
});

test('还原：没有 figures 时恒等返回', () => {
  const html = '<p>无图</p>';
  assert.equal(restoreFigures(html, []), html);
});

// ── 结构表（AI 读的那份）─────────────────────────────────────────────────

test('结构表：logic 输出门/类型/输入/输出四列', () => {
  const lib = parseFigureLib('y | and B C -> Y');
  const r = renderFigures(':::figure y', { lib });
  const t = renderStructureTable(r.figures[0]);
  assert.ok(t.includes('<th>门</th>'));
  assert.ok(t.includes('<td>AND</td>'));
  assert.ok(t.includes('<td>B、C</td>'));
  assert.ok(t.includes('<td>Y</td>'));
});

test('结构表：wave 输出信号/电平/格数', () => {
  const lib = parseFigureLib(['w | wave 4', 'A: 0110'].join('\n'));
  const r = renderFigures(':::figure w', { lib });
  const t = renderStructureTable(r.figures[0]);
  assert.ok(t.includes('<th>信号</th>'));
  assert.ok(t.includes('<td>0110</td>'));
});

test('结构表：kmap 输出行列表头与格值', () => {
  const lib = parseFigureLib(['k | kmap 4', '0000', '1111', '1111', '0000'].join('\n'));
  const r = renderFigures(':::figure k', { lib });
  const t = renderStructureTable(r.figures[0]);
  assert.ok(t.includes('<th>行 \\ 列</th>'));
  assert.ok(t.includes('<td>11</td>'));
});

// ── 标签 → tspan ─────────────────────────────────────────────────────────

test('标签：普通文字原样转义', () => {
  assert.equal(labelToTspans('R'), 'R');
  assert.equal(labelToTspans('A&B'), 'A&amp;B');
});

test('标签：~x~ 变下标 tspan', () => {
  const out = labelToTspans('U~1~');
  assert.ok(out.includes('<tspan baseline-shift="sub"'));
  assert.ok(out.includes('>1</tspan>'));
  assert.ok(out.startsWith('U'));
});

test('标签：未闭合的 ~ 原样保留（不吞字）', () => {
  assert.equal(labelToTspans('A~B'), 'A~B');
});

// ── 取反记法（三签抓到的图与图注不一致）────────────────────────────────

test('标签：^B^ 渲染上划线（图注与图内用同一套否定记法）', () => {
  const out = labelToTspans('^B^');
  assert.ok(out.includes('text-decoration="overline"'), '上划线未生效');
  assert.ok(out.includes('>B</tspan>'));
});

test('标签：上划线可与下标组合（R̄_D 这类器件记号）', () => {
  const out = labelToTspans('^R^~D~');
  assert.ok(out.includes('overline'));
  assert.ok(out.includes('baseline-shift="sub"'));
});

test('门符号：非门必须有取反圈（否则画成了缓冲器，与图注矛盾）', () => {
  // 三签实测：not 与 buf 曾共用几何、都没有圈，画出的是缓冲器 nB=B，
  // 而图注写 Y=A·B̄ —— 图和图注给出不同答案，读者必做错题。
  const lib = parseFigureLib('f | not B -> ^B^ ; and A ^B^ -> Y');
  const r = renderFigures(':::figure f', { lib });
  const html = restoreFigures(r.source, r.figures);
  const notBlock = html.slice(html.indexOf('data-op="not"'));
  assert.ok(/data-op="not"[\s\S]{0,400}?<circle/.test(notBlock), '非门缺取反圈');
});

test('门符号：与门不带取反圈（别把非门的圈泄漏给其它门）', () => {
  const lib = parseFigureLib('f | and A B -> Y');
  const r = renderFigures(':::figure f', { lib });
  const html = restoreFigures(r.source, r.figures);
  const andBlock = html.slice(html.indexOf('data-op="and"'));
  assert.ok(!/data-op="and"[\s\S]{0,300}?<circle/.test(andBlock), '与门不该有取反圈');
});

// ── 图内符号：复用现有气泡锚点 ───────────────────────────────────────────

test('符号：图内标签挂词条后产出 a.sym-gloss（包 tspan，不包裸文本）', () => {
  const lib = parseFigureLib('y | and B@sym-VB C -> Y');
  const lookup = (id) => (id === 'sym-VB'
    ? { key: 'sym-VB', href: '../符号入门.html#sym-VB' }
    : null);
  const r = renderFigures(':::figure y', { lib, lookupGloss: lookup });
  assert.equal(r.figures[0].symbols.length, 1);
  const html = restoreFigures(r.source, r.figures);
  assert.ok(html.includes('class="sym-gloss"'));
  assert.ok(html.includes('data-term="sym-VB"'));
  // 关键：锚点里必须是 <tspan>，不能是裸文本（SVG 的 <a> 不许包裸文本）
  assert.match(html, /<a class="sym-gloss"[^>]*><tspan[^>]*>B<\/tspan><\/a>/);
  // C 没挂词条 ⇒ 不上色
  assert.ok(!/data-term="[^"]*">C</.test(html));
});

test('符号：没写 @词条 的标签一律不上色（不猜、不骗人）', () => {
  const lib = parseFigureLib('y | and B C -> Y');
  const r = renderFigures(':::figure y', {
    lib,
    // 即使词典里真有个叫 B 的词条，没写 @ 也不该被自动挂上
    lookupGloss: (id) => ({ key: id, href: '#' }),
  });
  assert.deepEqual(r.figures[0].symbols, []);
  const html = restoreFigures(r.source, r.figures);
  assert.ok(!html.includes('sym-gloss'));
});

test('onHit：把命中条目的 key 交出去（宿主靠它烘焙气泡词典）', () => {
  const lib = parseFigureLib('f | and B@sym-VB C -> Y');
  const hits = [];
  renderFigures(':::figure f', {
    lib,
    // 宿主返回的是包里的词条对象，**不带 key**——模块必须自己补
    lookupGloss: (id) => ({ title: '标题', text: '释义', href: '#' + id }),
    onHit: (key, entry) => hits.push([key, entry.title]),
  });
  assert.deepEqual(hits, [['sym-VB', '标题']]);
});

test('onHit：命中条目必须带 title/text，否则宿主烘焙时会把它滤掉', () => {
  // 这条锁住一个实测 bug：lookupGloss 只回 {key, href} 时，宿主拿到的
  // entry.title 是 undefined，按页词典的 filter 会把整条滤掉——图上锚点在、
  // 点了没气泡。所以模块不替宿主决定形状，但测试要求宿主传全。
  const lib = parseFigureLib('f | and B@sym-VB C -> Y');
  let got = null;
  renderFigures(':::figure f', {
    lib,
    lookupGloss: (id) => ({ title: 'T', text: 'X', href: '#' + id }),
    onHit: (key, entry) => { got = entry; },
  });
  assert.equal(got.title, 'T');
  assert.equal(got.text, 'X');
});

// ── 布局与语义：三签该抓的那几类（2026-10-28 站长实测指出的）────────────

const coordsOf = (html) => {
  const texts = [...html.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>([^<]*)<\/text>/g)]
    .map((m) => ({ x: +m[1], y: +m[2], label: m[3] }));
  const wires = [...html.matchAll(/data-net="([^"]+)"[^>]*d="([^"]+)"/g)]
    .map((m) => ({ net: m[1], d: m[2] }));
  const vb = (html.match(/viewBox="([^"]+)"/) || [])[1];
  return { texts, wires, vb };
};

test('布局：输入端点的纵向范围收在门高内（不铺满整张画布）', () => {
  const lib = parseFigureLib('f | and B C -> Y');
  const r = renderFigures(':::figure f', { lib });
  const { texts, vb } = coordsOf(restoreFigures(r.source, r.figures));
  const h = +vb.split(/\s+/)[3];
  const ins = texts.filter((t) => t.label === 'B' || t.label === 'C');
  assert.equal(ins.length, 2);
  // 两个输入标签的纵向跨度不该超过画布高度的一半——超过就是把端点铺满画布
  const span = Math.abs(ins[0].y - ins[1].y);
  assert.ok(span < h / 2, `输入跨度 ${span} 应小于画布高度一半 ${h / 2}`);
});

test('布局：多输入均匀分布（三输入等距）', () => {
  const lib = parseFigureLib('f | or A B C -> Y');
  const r = renderFigures(':::figure f', { lib });
  const { texts } = coordsOf(restoreFigures(r.source, r.figures));
  const ys = ['A', 'B', 'C'].map((l) => texts.find((t) => t.label === l).y);
  const d1 = Math.round((ys[1] - ys[0]) * 100) / 100;
  const d2 = Math.round((ys[2] - ys[1]) * 100) / 100;
  assert.ok(Math.abs(d1 - d2) < 0.5, `三输入应等距，实得 ${d1} 与 ${d2}`);
});

test('布局：所有文字落在画布内（不越界）', () => {
  const lib = parseFigureLib(['a | and B C -> Y', 'b | or A B C -> Y', 'c | not B -> nB ; and A nB -> Y'].join('\n'));
  for (const id of ['a', 'b', 'c']) {
    const r = renderFigures(`:::figure ${id}`, { lib });
    const { texts, vb } = coordsOf(restoreFigures(r.source, r.figures));
    const [, , w, h] = vb.split(/\s+/).map(Number);
    for (const t of texts) {
      assert.ok(t.x >= 0 && t.x <= w, `${id} 的「${t.label}」x=${t.x} 超出画布宽 ${w}`);
      assert.ok(t.y >= 0 && t.y <= h, `${id} 的「${t.label}」y=${t.y} 超出画布高 ${h}`);
    }
  }
});

test('语义：逻辑变量不挂器件词条（防「B 弹出基极电位」这类误导）', () => {
  // 这是实测抓到的真错：图里 B 是逻辑输入（0/1），却被挂上 sym-VB（晶体管基极电位）。
  // 词条语义与图元语义不符，比不挂更糟——读者会被引到完全无关的知识点上。
  const lib = parseFigureLib('f | and B@sym-VB C -> Y');
  const r = renderFigures(':::figure f', {
    lib,
    lookupGloss: (id) => (id === 'sym-VB'
      ? { title: '$V_B$：基极电位', text: '晶体管基极对地电位', href: '#sym-VB' }
      : null),
  });
  // 模块本身允许挂载（它是通用机制），所以这里锁的是**图库内容**：
  // 电子技术图库里的逻辑电路图不得出现 @sym-V 开头的器件词条。
  const libText = readFileSync(new URL('../图库/电子技术.figures.txt', import.meta.url), 'utf-8');
  const logicLines = libText.split('\n').filter((l) => /\|\s*(and|or|not|nand|nor|xor|xnor)\s/.test(l));
  for (const line of logicLines) {
    assert.ok(!/@sym-(VB|VC|VE|Uce|Ube|Ib|Ic|Ie)\b/.test(line),
      `逻辑门图里挂了器件词条（语义不符）：${line.trim()}`);
  }
});

test('语义：同一张图的端口要么都挂词条、要么都不挂（不一致也是错）', () => {
  const libText = readFileSync(new URL('../图库/电子技术.figures.txt', import.meta.url), 'utf-8');
  const logicLines = libText.split('\n').filter((l) => /\|\s*(and|or|not|nand|nor|xor|xnor)\s/.test(l));
  for (const line of logicLines) {
    const tagged = (line.match(/@[a-z]/gi) || []).length;
    const labels = (line.split('|')[1] || '').split(/\s+/).filter((t) => /^(?:!?[A-Za-z0-9]+)(?:@\S+)?$/.test(t) && t !== '->');
    assert.ok(tagged === 0 || tagged === labels.length,
      `端口挂载不一致（${tagged}/${labels.length}）：${line.trim()}`);
  }
});

// ── 交互层：图必须真的能操作（2026-10-28 站长实测「这图我能操作吗」）─────

test('交互层：SVG 里元件与连线都带可寻址属性', () => {
  const lib = parseFigureLib('f | and B C -> Y');
  const r = renderFigures(':::figure f | 图', { lib });
  const html = restoreFigures(r.source, r.figures);

  // 元件可选中：data-comp / data-op / data-ins / data-outs
  assert.match(html, /class="fig-comp" data-comp="g1" data-op="and"/);
  assert.match(html, /data-ins="B,C"/);
  assert.match(html, /data-outs="Y"/);

  // 连线可点：class=fig-wire + data-net
  assert.match(html, /class="fig-wire" data-net="B"/);
  assert.match(html, /class="fig-wire" data-net="C"/);

  // figure 记下原始 viewBox，供「复位」用
  assert.match(html, /data-viewbox="[^"]*"/);
});

test('交互层：客户端脚本含四个必需能力（选中 / 高亮 / 面板 / 缩放）', () => {
  // 单元测试跑不了浏览器，但这些字符串是交互能力的可执行契约：
  // 谁把它们删了，浏览器里就静默失效——而静默失效正是这个仓库反复踩的坑。
  // 「点元件」在两处出现：鼠标点击与键盘 Enter。用计数而非 match——
  // 只 match 的话删掉其中一处仍命中另一处而假绿（第一次变异就这么漏掉）。
  const compHits = (FIGURES_JS.match(/closest\("\.fig-comp"\)/g) || []).length;
  assert.ok(compHits >= 2, `缺「点元件」处理（应 ≥2 次：点击 + 键盘，实得 ${compHits}）`);
  assert.match(FIGURES_JS, /closest\("\.fig-wire"\)/, '缺「点连线」处理');
  assert.match(FIGURES_JS, /fig-inspector/, '缺属性面板');
  assert.match(FIGURES_JS, /function zoom/, '缺缩放');
  assert.match(FIGURES_JS, /__figuresReset/, '缺 SPA 换页重挂');
  // 符号气泡优先：点符号时不能抢事件
  assert.match(FIGURES_JS, /closest\("a\.sym-gloss"\)\s*\)\s*return/, '符号点击未被让出');
  // 键盘可达
  assert.match(FIGURES_JS, /keydown/, '缺键盘处理');
  assert.match(FIGURES_JS, /setAttribute\("tabindex"/, '元件不可 Tab 聚焦');
});

test('交互层：双击复位避开缩放条与符号（连点两下「＋」不该被重置）', () => {
  // 实测抓到的真错：dblclick 复位没排除 .fig-zoom，连点两下放大按钮会
  // 「先放大再复位」，读者看到的是按了没反应。
  const dbl = FIGURES_JS.slice(FIGURES_JS.indexOf('addEventListener("dblclick"'));
  const block = dbl.slice(0, dbl.indexOf('});') + 3);
  assert.match(block, /closest\("\.fig-zoom"\)/, '双击复位未排除缩放条');
  assert.match(block, /closest\("a\.sym-gloss"\)/, '双击复位未排除符号锚点');
});

test('全屏查看：SVG 与位图都挂了灯箱（不只图元，习题册 img 也要）', () => {
  // 站长要求：「所有图片都能点击然后全屏查看」。图元渲染的 SVG 只是一类，
  // 电路原理习题册那 169 张位图是另一类，两条都要挂。
  assert.match(FIGURES_JS, /querySelectorAll\("figure\.fig"\)/, '未处理图元的 SVG');
  assert.match(FIGURES_JS, /querySelectorAll\("\.article-content img"\)/, '未处理正文位图');
  assert.match(FIGURES_JS, /function openLightbox/, '缺灯箱打开');
  assert.match(FIGURES_JS, /function closeLightbox/, '缺灯箱关闭');
  // 关闭方式：Esc + 点背景
  assert.match(FIGURES_JS, /Escape/, '缺 Esc 关闭');
});

test('全屏查看：点图内符号或元件时不触发全屏（与气泡/选中不抢事件）', () => {
  const lb = FIGURES_JS.slice(FIGURES_JS.indexOf('setupLightbox'));
  assert.match(lb, /closest\("a\.sym-gloss"\)/, '点符号时未让出事件');
  assert.match(lb, /closest\("\.fig-comp"\)/, '点元件时未让出事件');
  assert.match(lb, /closest\("\.fig-wire"\)/, '点连线时未让出事件');
});

test('全屏查看：SVG 克隆用 setAttribute 设类名（className 在 SVGElement 上只读）', () => {
  // 实测真错：克隆的 SVG 上写 clone.className 会抛
  // TypeError: Cannot set property className of #<SVGElement> which has only a getter
  // —— 整个 openLightbox 中断，表现为「点了完全没反应」。
  const lb = FIGURES_JS.slice(FIGURES_JS.indexOf('function openLightbox'));
  assert.match(lb, /setAttribute\("class", "fig-lightbox-content"\)/, 'SVG 未用 setAttribute 设类名');
});

test('全屏查看：就绪标记必须在绑定成功之后（否则首轮没 SVG 就永久跳过）', () => {
  // 实测真错：__lbReady = true 写在「检查 svg 是否存在」之前，
  // 首轮 SVG 还没进 DOM ⇒ 永久跳过该图，且后续 boot() 因已标记不再重试。
  const lb = FIGURES_JS.slice(FIGURES_JS.indexOf('function setupLightbox'), FIGURES_JS.indexOf('function boot'));
  const iCheck = lb.indexOf('if (!svg) continue;');
  const iReady = lb.indexOf('figs[i].__lbReady = true');
  assert.ok(iCheck >= 0 && iReady >= 0, '找不到就绪标记或 svg 检查');
  assert.ok(iReady > iCheck, '__lbReady 必须在 svg 检查之后才设');
});

test('全屏查看：纯前端能力，不写任何 MCP 工具或选择器', () => {
  // 站长定案：「这个东西不能暴露给 MCP，豆包只需要能看到 detail 就够了」。
  // 灯箱是给人看的，AI 读的仍是 <details> 结构表——这里锁死两边不串。
  const lbStart = FIGURES_JS.indexOf('var lb = null;');
  const lbEnd = FIGURES_JS.indexOf('function boot()');
  const lbCode = FIGURES_JS.slice(lbStart, lbEnd);
  assert.ok(!/modelContext|registerTool|site_/.test(lbCode), '灯箱代码里不该出现 MCP 工具痕迹');
});

test('自动贴合：viewBox 由 getBBox 量出（不靠构建期猜字宽）', () => {
  // 站长定案：「这种东西应该做成全自动的」。构建期估宽两次都偏（估大右空、估小裁字），
  // 正解是让浏览器用 getBBox() 量真实包围盒（含文字实际宽度）。
  assert.match(FIGURES_JS, /function fitViewBox/, '缺自动贴合');
  assert.match(FIGURES_JS, /getBBox\(\)/, '未用 getBBox 量真实边界');
  // 字体未就绪时量出来偏窄，webfont 到了要重量
  assert.match(FIGURES_JS, /document\.fonts\.ready/, '字体加载后未重量');
});

test('交互层：CSS 含选中/高亮/面板/缩放条四类样式', () => {
  assert.match(FIGURES_CSS, /\.fig-comp\.is-selected/);
  assert.match(FIGURES_CSS, /\.fig-wire\.is-hot/);
  assert.match(FIGURES_CSS, /\.fig-inspector/);
  assert.match(FIGURES_CSS, /\.fig-zoom/);
});

// ── 副作用与纯度 ─────────────────────────────────────────────────────────

test('warnings：显式 @词条 查不到时给出可见警告（不静默）', () => {
  const lib = parseFigureLib('f | and B@sym-不存在 C -> Y');
  const r = renderFigures(':::figure f', { lib, lookupGloss: () => null });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /sym-不存在/);
  assert.match(r.warnings[0], /不会有气泡/);
});

test('warnings：没写 @词条 的标签不产生警告（纯图形文字是正常的）', () => {
  const lib = parseFigureLib('f | and B C -> Y');
  const r = renderFigures(':::figure f', { lib, lookupGloss: () => null });
  assert.deepEqual(r.warnings, []);
});

test('渲染是纯函数：同输入两次结果逐字节相同', () => {
  const lib = parseFigureLib('y | and B C -> Y');
  const a = renderFigures(':::figure y | 图', { lib });
  const b = renderFigures(':::figure y | 图', { lib });
  assert.equal(a.source, b.source);
  assert.deepEqual(a.figures, b.figures);
  const ha = restoreFigures(a.source, a.figures);
  const hb = restoreFigures(b.source, b.figures);
  assert.equal(ha, hb);
});

test('CSS 常量存在且非空', () => {
  assert.ok(FIGURES_CSS.length > 100);
  assert.ok(FIGURES_CSS.includes('.fig-svg'));
});

test('图索引：只含 MCP 需要的最小字段', () => {
  const lib = parseFigureLib('y | and B C -> Y');
  const r = renderFigures(':::figure y | 图 1', { lib });
  const idx = buildFigureIndex(r.figures);
  assert.equal(idx.length, 1);
  assert.deepEqual(Object.keys(idx[0]).sort(), ['caption', 'id', 'kind', 'symbols']);
});

// ── 失败可见：这是旧系统病根的对症药 ─────────────────────────────────────

test('旧病根对照：引用不存在的图元一律抛错，绝不静默丢弃', () => {
  const lib = parseFigureLib('y | and B C -> Y');
  const cases = [
    ':::figure 无此图元',
    ':::figure',
  ];
  for (const src of cases) {
    assert.throws(() => renderFigures(src, { lib, pagePath: 'p.md' }),
      /不在图库|缺少图元 id/);
  }
});

test('旧病根对照：DSL 写错时给的是「看不懂」而不是空图', () => {
  const lib = parseFigureLib('f | and B C Y', 'lib.txt');
  assert.throws(() => renderFigures(':::figure f', { lib, libName: 'lib.txt' }),
    /看不懂子句/);
});
