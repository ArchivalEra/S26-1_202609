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

// 2026-10-29：这五条锁的是「画得出形状但表达不了原图信息」的那一类缺口。
// 起因是触发器波形迁移时子代理撞到：没有参考线读不出 CP 窗口、两初态同色看不出重合、
// 40 格被 CSS 压到标签 6px（于是有人把 40 格降成 20 格，拿边沿精度换字号）。

test('wave：参考线钉在格边界、贯穿全部行（触发器题靠它读 CP 窗口）', () => {
  const lib = parseFigureLib(['w | wave 8 ; guides 2,4', 'CP: 00110011', 'S: 00001100'].join('\n'));
  const r = renderFigures(':::figure w', { lib });
  assert.deepEqual(r.figures[0].payload.guides, [2, 4]);
  const html = restoreFigures(r.source, r.figures);
  const g = html.match(/<g class="fig-guides"[^>]*>(.*?)<\/g>/s);
  assert.ok(g, '应画出 fig-guides 分组');
  const ys = [...g[1].matchAll(/y1="([\d.]+)"[^>]*y2="([\d.]+)"/g)].map((m) => +m[2]);
  assert.equal(ys.length, 2, '两条参考线');
  // 贯穿全部行：每条线的 y2 都要落到最后一行下沿之外
  const vb = (html.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/) || []);
  for (const y of ys) assert.ok(y > +vb[2] - 30, `参考线 y2=${y} 应贯穿到底部附近（画布高 ${vb[2]}）`);
});

test('wave：参考线位置越界要报错（静默丢弃等于假图）', () => {
  const lib = parseFigureLib(['w | wave 8 ; guides 9', 'A: 00110011'].join('\n'), 'l');
  assert.throws(() => renderFigures(':::figure w', { lib, libName: 'l' }),
    /参考线位置「9」必须是 0 到 8 之间的整数/);
});

test('wave：行级配色（两初态同色就看不出「自 CP₂ 起重合」）', () => {
  const lib = parseFigureLib(['w | wave 4', '初态 0 [blue]: 0000', '初态 1 [red]: 1100'].join('\n'));
  const r = renderFigures(':::figure w', { lib });
  assert.equal(r.figures[0].payload.rows[0].color, 'blue');
  assert.equal(r.figures[0].payload.rows[1].color, 'red');
  // 标签里不该残留 [blue]
  assert.equal(r.figures[0].payload.rows[0].label, '初态 0');
  const html = restoreFigures(r.source, r.figures);
  assert.match(html, /class="fig-wave-row" data-color="blue"/);
  assert.match(html, /class="fig-wave-row" data-color="red"/);
  assert.match(html, /stroke="#1a5fb4"/);
  assert.match(html, /stroke="#c01c28"/);
});

test('wave：不认识的配色要报错', () => {
  const lib = parseFigureLib(['w | wave 4', 'A [chartreuse]: 0101'].join('\n'), 'l');
  assert.throws(() => renderFigures(':::figure w', { lib, libName: 'l' }),
    /不认识的配色「chartreuse」/);
});

test('wave：行标签可挂词条（与 logic 同一套 @ 语义）', () => {
  const lib = parseFigureLib(['w | wave 4', '^R^~D~@sym-RDd: 1111'].join('\n'));
  const r = renderFigures(':::figure w', {
    lib,
    lookupGloss: (id) => (id === 'sym-RDd'
      ? { title: '直接置 0 端', text: '低电平有效，置 Q=0', href: '#sym-RDd' } : null),
  });
  assert.equal(r.figures[0].payload.rows[0].term, 'sym-RDd');
  assert.equal(r.figures[0].payload.rows[0].label, '^R^~D~');
  const html = restoreFigures(r.source, r.figures);
  assert.match(html, /data-term="sym-RDd"/);
});

test('wave：40 格不被压成看不清的字（格宽按目标宽度反解，不写死 34）', () => {
  // 写死 CELL_W=34 时 40 格 → viewBox 宽 1436，而 .fig-svg 的 max-width 是 720px，
  // 缩放 0.50 把 12px 标签压成 6px。反解后 viewBox 宽应落在 720 以内。
  const levels = '01'.repeat(20);
  const lib = parseFigureLib(['w | wave 40', `A: ${levels}`].join('\n'));
  const r = renderFigures(':::figure w', { lib });
  const vb = (restoreFigures(r.source, r.figures).match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/) || []);
  assert.ok(+vb[1] <= 720, `40 格画布宽 ${vb[1]} 应在 720 上限内，否则会被 CSS 缩放`);
});

test('wave：电平串长度必须与声明格数一致（短了不许静默画半截）', () => {
  const lib = parseFigureLib(['w | wave 8', 'A: 0011'].join('\n'), 'l');
  assert.throws(() => renderFigures(':::figure w', { lib, libName: 'l' }),
    /只有 4 格，但首行声明了 8 格/);
  const lib2 = parseFigureLib(['w | wave 4', 'A: 001100'].join('\n'), 'l');
  assert.throws(() => renderFigures(':::figure w', { lib: lib2, libName: 'l' }),
    /有 6 格，超过首行声明的 4 格/);
});

test('wave：高阻段单独成虚线，不把实线拉过去', () => {
  const lib = parseFigureLib(['w | wave 4', 'A: 01-0'].join('\n'));
  const html = restoreFigures(...(() => {
    const r = renderFigures(':::figure w', { lib });
    return [r.source, r.figures];
  })());
  assert.match(html, /stroke-dasharray="4 3"/, '高阻格要画成虚线');
});

test('wave：结构表带出参考线（AI 也要能读到读图依据）', () => {
  const lib = parseFigureLib(['w | wave 8 ; guides 2,4', 'CP: 00110011'].join('\n'));
  const html = restoreFigures(...(() => {
    const r = renderFigures(':::figure w', { lib });
    return [r.source, r.figures];
  })());
  const detail = html.match(/<details class="fig-structure">.*?<\/details>/s);
  assert.ok(detail);
  assert.match(detail[0], /参考线/);
  assert.match(detail[0], /2、4/);
});

// ── plot 图种（模拟波形：连续幅值，不是 0/1 电平）────────────────────────
// 2026-10-29：二极管限幅题的正弦削顶图。`wave` 只画 0/1 两档，用它逼近会画成方波，
// 而削顶题的信息全在连续曲线上——画成方波等于换了一道题。

const PLOT_LIB = [
  'f | plot 2 rows 340',
  '  yrange -24 24',
  '  ref 10',
  '  ref -10',
  '  grid 0',
  '  row1 axis -20 20 label u~i~',
  '  row1 curve sine 20 1.0',
  '  row2 axis -20 20 label u~O~',
  '  row2 ghost sine 20 1.0',
  '  row2 curve clip 20 10',
].join('\n');

test('plot：首行 plot <行数> rows <格数>，两种曲线各自成形', () => {
  const lib = parseFigureLib(PLOT_LIB);
  const r = renderFigures(':::figure f', { lib });
  const p = r.figures[0].payload;
  assert.equal(p.rowCount, 2);
  assert.deepEqual(p.yrange, [-24, 24]);
  assert.deepEqual(p.refs, [10, -10]);
  assert.equal(p.grid, 0);
  assert.equal(p.rows[0].curves[0].kind, 'sine');
  assert.equal(p.rows[1].curves[1].kind, 'clip');
  assert.equal(p.rows[1].curves[1].param, 10);
});

test('plot：削顶是真取 min/max，不是画个平台糊过去', () => {
  const lib = parseFigureLib(PLOT_LIB);
  const r = renderFigures(':::figure f', { lib });
  const html = restoreFigures(r.source, r.figures);
  // 取 clip 那条**粗实线**（stroke-width="2.2"，即实际输出）。
  // 注意两点：① 不能按「含 2.2 子串」筛——points 里的坐标也含 2.2，会挑错元素；
  // ② 粗线有两条（row1 的正弦、row2 削顶后的输出），要取**最后**一条。
  const thick = [...html.matchAll(/<polyline[^>]*\/>/g)]
    .map((m) => m[0])
    .filter((s) => s.includes('fig-plot-curve') && s.includes('stroke-width="2.2"'));
  assert.equal(thick.length, 2, `应有两条粗线（输入正弦 + 输出削顶），实得 ${thick.length}`);
  const pm = thick[1].match(/points="([^"]+)"/);
  const ys = pm[1].trim().split(/\s+/).map((s) => Number(s.split(',')[1]));
  // viewBox 里 y 越小越高。削平意味着**大片采样点落在同一个极值**上。
  // 未削顶的正弦因为坐标保留一位小数，峰顶附近也会有 7 个点同值——所以阈值要明显高于它。
  const flatTop = ys.filter((y) => y === Math.min(...ys)).length;
  const flatBot = ys.filter((y) => y === Math.max(...ys)).length;
  assert.ok(flatTop > 50, `上削平台点数 ${flatTop} 太少（未削顶的正弦峰顶约 7），削顶没画出来`);
  assert.ok(flatBot > 50, `下削平台点数 ${flatBot} 太少，削顶没画出来`);
});

test('plot：ghost 线画成虚线（细虚线对粗线，是限幅题的读法）', () => {
  const lib = parseFigureLib(PLOT_LIB);
  const html = restoreFigures(...(() => {
    const r = renderFigures(':::figure f', { lib });
    return [r.source, r.figures];
  })());
  const ghost = html.match(/<polyline class="fig-plot-curve is-ghost"[^>]*\/>/);
  assert.ok(ghost, '应有 is-ghost 曲线');
  assert.match(ghost[0], /stroke-dasharray/, 'ghost 必须是虚线');
});

test('plot：参考电平线（±10 V）画出来并标注数值', () => {
  const lib = parseFigureLib(PLOT_LIB);
  const html = restoreFigures(...(() => {
    const r = renderFigures(':::figure f', { lib });
    return [r.source, r.figures];
  })());
  assert.match(html, /class="fig-plot-ref"/);
  assert.match(html, /\+10 V/);
  assert.match(html, /-10 V/);
});

test('plot：缺 yrange 要报错（没有纵轴范围，削到几伏就无从谈起）', () => {
  const lib = parseFigureLib([
    'f | plot 1 rows 40',
    '  row1 axis -20 20 label u', '  row1 curve sine 20 1',
  ].join('\n'), 'l');
  assert.throws(() => renderFigures(':::figure f', { lib, libName: 'l' }),
    /缺 yrange/);
});

test('plot：clip 不写限幅值要报错（否则画成和 sine 一样，题就变了）', () => {
  const lib = parseFigureLib([
    'f | plot 1 rows 40', '  yrange -24 24',
    '  row1 axis -20 20 label u', '  row1 curve clip 20',
  ].join('\n'), 'l');
  assert.throws(() => renderFigures(':::figure f', { lib, libName: 'l' }),
    /clip 必须写限幅值/);
});

test('plot：没有曲线的行要报错', () => {
  const lib = parseFigureLib([
    'f | plot 2 rows 40', '  yrange -24 24',
    '  row1 axis -20 20 label u', '  row1 curve sine 20 1',
    '  row2 axis -20 20 label v',
  ].join('\n'), 'l');
  assert.throws(() => renderFigures(':::figure f', { lib, libName: 'l' }),
    /第 2 行没有任何曲线/);
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

// ── net 图种（元件-引脚-网络）─────────────────────────────────────────────

const netLib = (lines) => parseFigureLib(['x | net', ...lines].join('\n'), 'lib.txt');

test('net：两元件串联电路解析成元件表与网络表', () => {
  const lib = netLib(['V1 v 24V top bottom', 'R1 r 6Ω top a', 'R2 r 6Ω a bottom']);
  const r = renderFigures(':::figure x', { lib });
  const p = r.figures[0].payload;
  assert.equal(p.comps.length, 3);
  assert.deepEqual(p.comps[0], {
    ref: 'V1', type: 'v', value: '24V', pins: ['top', 'bottom'], ctrlPins: null,
  });
  // 网络表是**数组**而不是 Map——Map 过 JSON.stringify 会变成 {}，
  // 拓扑会在 MCP 那一侧整段消失，而页面上看着一切正常。
  assert.ok(Array.isArray(p.nets), 'nets 必须是数组，不能是 Map');
  assert.deepEqual(p.nets.map((n) => n.name), ['top', 'bottom', 'a']);
  assert.deepEqual(p.nets[0].pins, [{ ref: 'V1', pin: 1 }, { ref: 'R1', pin: 1 }]);
});

test('net：并联支路（三只电阻都跨同一对网络）', () => {
  const lib = netLib([
    'I1 i 2A n0 top', 'R1 r 6Ω top n0', 'R2 r 3Ω top n0', 'R3 r 6Ω top n0',
  ]);
  const r = renderFigures(':::figure x', { lib });
  const nets = r.figures[0].payload.nets;
  assert.equal(nets.find((n) => n.name === 'n0').pins.length, 4);
  assert.equal(nets.find((n) => n.name === 'top').pins.length, 4);
});

test('net：payload 能过 JSON.stringify 且拓扑不丢（Map 序列化成 {} 的坑）', () => {
  const lib = netLib(['V1 v 24V top bottom', 'R1 r 6Ω top bottom']);
  const r = renderFigures(':::figure x', { lib });
  const round = JSON.parse(JSON.stringify(r.figures[0]));
  assert.equal(round.payload.nets.length, 2);
  assert.equal(round.payload.nets[0].pins.length, 2);
});

test('net：不认识的元件类型要报错并列出全部可用类型', () => {
  const lib = netLib(['R1 resistor 6Ω a b']);
  assert.throws(() => renderFigures(':::figure x', { lib, libName: 'lib.txt' }),
    /不认识的元件类型「resistor」.*可用.*r.*c.*l.*v.*i.*sw.*d.*vcvs.*vccs.*ccvs.*cccs/s);
});

test('net：引脚指向不存在的网络要报错（单点网络不是合法电路）', () => {
  // 「b」只被 R1 一个引脚引用：一根线至少两端，悬空端点不是合法电路图。
  const lib = netLib(['V1 v 24V a b', 'R1 r 6Ω a c']);
  assert.throws(() => renderFigures(':::figure x', { lib, libName: 'lib.txt' }),
    /网络「b」只连了 1 个引脚|网络「c」只连了 1 个引脚/);
});

test('net：受控源四型分开画（菱形里 +/− 还是箭头决定读者认成电压/电流源）', () => {
  const lib = netLib([
    'V1 v 1 a 0', 'R1 r 2 a 0',
    'E1 vcvs 5 o1 0 a 0',
    'G1 vccs 2 o1 0 a 0',
    'H1 ccvs 3 a 0 o1 0',
    'F1 cccs 4 a 0 o1 0',
  ]);
  const r = renderFigures(':::figure x', { lib });
  const types = r.figures[0].payload.comps.map((c) => c.type);
  for (const t of ['vcvs', 'vccs', 'ccvs', 'cccs']) {
    assert.ok(types.includes(t), `缺类型 ${t}`);
  }
  const html = restoreFigures(r.source, r.figures);
  // 四型必须是四个不同的 data-type，不能合成一个 cs
  for (const t of ['vcvs', 'vccs', 'ccvs', 'cccs']) {
    assert.match(html, new RegExp(`data-type="${t}"`), `SVG 里没有 ${t}`);
  }
  // 压控两型菱形里是 +/−，流控两型是箭头——这里锁「不是同一套记号」
  const vol = html.slice(html.indexOf('data-type="vcvs"'), html.indexOf('data-type="vccs"'));
  const cur = html.slice(html.indexOf('data-type="vccs"'), html.indexOf('data-type="ccvs"'));
  assert.ok(vol !== cur, 'vcvs 与 vccs 画成了同一个符号');
});

test('net：受控源控制端指向不存在的网络要报错', () => {
  // o1 要接一个负载才算合法网络（否则先报「网络只连了 1 个引脚」）
  const lib = netLib(['V1 v 1 a 0', 'R1 r 2 a 0', 'E1 vcvs 5 o1 0 a zz', 'RL r 3 o1 0']);
  assert.throws(() => renderFigures(':::figure x', { lib, libName: 'lib.txt' }),
    /控制端指向网络「zz」.*图里没有这个网络/s);
});

test('net：受控源的段数必须对（少一段就少画一个引脚，不能静默容忍）', () => {
  // vcvs 是四端：位号 类型 数值 输出1 输出2 控制1 控制2 = 7 段
  const lib = netLib(['V1 v 1 a 0', 'R1 r 2 a 0', 'E1 vcvs 5 o1 0 a']);
  assert.throws(() => renderFigures(':::figure x', { lib, libName: 'lib.txt' }),
    /应写 7 段.*实际 6 段/s);
});

test('net：两元元件多写一段要报错（受控源字段不许泄漏给电阻）', () => {
  const lib = netLib(['V1 v 1 a 0', 'R1 r 2 a 0 extra']);
  assert.throws(() => renderFigures(':::figure x', { lib, libName: 'lib.txt' }),
    /应写 5 段.*实际 6 段/s);
});

test('net：控制端不进网络表（控制关系不是电气连接，混进去会让拓扑判错）', () => {
  const lib = netLib(['V1 v 1 a 0', 'R1 r 2 a 0', 'E1 vcvs 5 o1 0 a 0', 'RL r 3 o1 0']);
  const r = renderFigures(':::figure x', { lib });
  const p = r.figures[0].payload;
  // a 只连 V1.1 与 R1.1——受控源的控制端（E1 的第 5、6 段）**不进网络表**，
  // 因为「取哪个量」不是电气连接。这正是本测试要守的行为。
  const a = p.nets.find((n) => n.name === 'a');
  assert.deepEqual(a.pins.map((x) => `${x.ref}.${x.pin}`), ['V1.1', 'R1.1']);
});

test('net：单刀双投 spdt 是 3 脚 + 刀位（两地控制灯必须它）', () => {
  // 2026-10-29：子代理拒绝为「图 7.05 两地控制灯」出图，理由是 sw 只有 2 脚、
  // 也画不出「刀接在哪侧」——硬拆两只 2 脚开关会画成两处都断（灯永远不亮），是错图。
  // 那个判断正确，所以补这个元件。
  const lib = parseFigureLib('f | net\n  V1 v 220V L N\n  S1 spdt - L a b 1\n  S2 spdt - b a c 2\n  H1 r 100 c N');
  const r = renderFigures(':::figure f', { lib });
  const comps = r.figures[0].payload.comps;
  assert.equal(comps[1].type, 'spdt');
  assert.equal(comps[1].pins.length, 3, 'spdt 必须有 3 个电气引脚');
  assert.equal(comps[1].pos, 1, '刀位 1');
  assert.equal(comps[2].pos, 2, '刀位 2');
});

test('net：spdt 段数写错要报错（多一段少一段都不行）', () => {
  const lib = parseFigureLib('f | net\n  S1 spdt - L a b', 'lib.txt');
  assert.throws(() => renderFigures(':::figure f', { lib, libName: 'lib.txt' }),
    /应写 7 段.*公共端 触点1 触点2 刀位/s);
});

test('net：spdt 刀位不同则符号不同（刀必须指对触点）', () => {
  const mk = (pos) => {
    const lib = parseFigureLib(`f | net\n  V1 v 1 L N\n  S1 spdt - L a b ${pos}\n  R1 r 1 a N\n  R2 r 1 b N`);
    const r = renderFigures(':::figure f', { lib });
    return restoreFigures(r.source, r.figures);
  };
  const a = mk(1), b = mk(2);
  // 两张图的 spdt 符号几何必须不同——相同就等于「刀位没画出来」
  const seg = (h) => {
    const i = h.indexOf('data-type="spdt"');
    return h.slice(i, i + 600);
  };
  assert.notEqual(seg(a), seg(b), '刀位 1 与 2 画出了同一个符号');
});

test('net：位号重复要报错', () => {
  const lib = netLib(['V1 v 1 a 0', 'V1 r 2 a 0']);
  assert.throws(() => renderFigures(':::figure x', { lib, libName: 'lib.txt' }),
    /位号「V1」重复/);
});

test('net：渲染出的 SVG 含可寻址的元件与导线（交互层靠这两个类名）', () => {
  const lib = netLib(['V1 v 24V top bottom', 'R1 r 6Ω top a', 'R2 r 6Ω a bottom']);
  const r = renderFigures(':::figure x', { lib });
  const html = restoreFigures(r.source, r.figures);
  assert.match(html, /class="fig-comp" data-comp="V1" data-type="v"/);
  assert.match(html, /class="fig-comp" data-comp="R1" data-type="r"/);
  assert.match(html, /data-pin1="top" data-pin2="a"/);
  assert.match(html, /class="fig-wire" data-net="top"/);
  assert.match(html, /class="fig-wire" data-net="a"/);
});

test('net：导线只有水平/垂直段（斜线在电路图里等于「没画完」）', () => {
  const lib = netLib([
    'V1 v 24V top bottom', 'R1 r 6Ω top a', 'R2 r 6Ω a bottom',
    'R3 r 3Ω top bottom',   // 再加一条对侧并联支路，逼出走线带
  ]);
  const r = renderFigures(':::figure x', { lib });
  const html = restoreFigures(r.source, r.figures);
  // 导线 path 里只允许 M/H/V，出现 L 或斜向 a 就是斜线
  for (const m of html.matchAll(/class="fig-wire" data-net="[^"]*" d="([^"]+)"/g)) {
    assert.ok(!/[LA]/.test(m[1]), `导线含斜线段：${m[1]}`);
  }
});

test('net：每个元件的符号都可辨识（不是空壳）', () => {
  const lib = netLib([
    'V1 v 1 a 0', 'R1 r 2 a b', 'C1 c 3 b 0', 'L1 l 4 a 0',
    'I1 i 5 a 0', 'S1 sw - a 0', 'D1 d - a 0',
  ]);
  const r = renderFigures(':::figure x', { lib });
  const html = restoreFigures(r.source, r.figures);
  const between = (ref) => {
    const i = html.indexOf(`data-comp="${ref}"`);
    const j = html.indexOf('</g>', i);
    return html.slice(i, j);
  };
  const shapes = {
    R1: /<rect[^>]*width="26"/,            // 电阻：IEC 矩形
    C1: /<line[^>]*x1="-4\.5"/,            // 电容：两平行极板
    L1: /a6 6 0 0 1/,                      // 电感：半圆弧
    V1: /<circle[^>]*r="15"/,              // 电压源：圆
    I1: /r="15"[\s\S]*Z"/,                 // 电流源：圆 + 箭头
    S1: /x2="7" y2="-10"/,                 // 开关：倾斜刀片
    D1: /L-8 9 L8 0 Z/,                    // 二极管：三角
  };
  for (const [ref, re] of Object.entries(shapes)) {
    assert.match(between(ref), re, `${ref} 的符号画不出来`);
  }
});

test('net：结构表含元件名、类型、两个引脚与网络表', () => {
  const lib = netLib(['V1 v 24V top bottom', 'R1 r 6Ω top a', 'R2 r 6Ω a bottom']);
  const r = renderFigures(':::figure x', { lib });
  const t = renderStructureTable(r.figures[0]);
  assert.ok(t.includes('<th>元件</th>'));
  assert.ok(t.includes('<th>类型</th>'));
  assert.ok(t.includes('<th>引脚1</th>'));
  assert.ok(t.includes('<th>引脚2</th>'));
  assert.ok(t.includes('<td>V1</td>'));
  assert.ok(t.includes('<td>电压源（v）</td>'));
  assert.ok(t.includes('<td>电阻（r）</td>'));
  // 网络表：谁和谁接在一起，这是拓扑的唯一文字投影
  assert.ok(t.includes('<th>网络</th>'));
  assert.ok(t.includes('<td>top</td>'));
  assert.ok(t.includes('V1 的 1 脚、R1 的 1 脚'));
});

test('net：受控源在结构表里标出控制端与取什么量', () => {
  const lib = netLib(['V1 v 1 a 0', 'R1 r 2 a 0', 'E1 vcvs 5 o1 0 a 0', 'RL r 3 o1 0']);
  const r = renderFigures(':::figure x', { lib });
  const t = renderStructureTable(r.figures[0]);
  assert.ok(t.includes('<th>控制端</th>'));
  assert.ok(t.includes('压控电压源（vcvs）'));
  assert.ok(t.includes('a、0（取电压）'));
  // 非受控元件这一栏写 —，不写空（空着像「漏填」）
  assert.ok(t.includes('<td>—</td>'));
});

test('net：图种不认识时可用列表里含 net', () => {
  const lib = parseFigureLib('f | xyzzy A B -> Y', 'lib.txt');
  assert.throws(() => renderFigures(':::figure f', { lib, libName: 'lib.txt' }),
    /图种不认识（首词「xyzzy」）.*net/s);
});

test('net：首行不是 net 要报错', () => {
  const lib = parseFigureLib(['x | netx', 'V1 v 1 a 0'].join('\n'), 'lib.txt');
  // 首词 netx 不认识 ⇒ 图种都不认识
  assert.throws(() => renderFigures(':::figure x', { lib, libName: 'lib.txt' }),
    /图种不认识/);
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

test('布局：多门分处不同行时，每个输入贴到它自己那只门的输入口高度', () => {
  // 2026-10-29 三签实测 gate-g：四个输入标签 A/B/C/D 全挤在第一只门那一小段里、
  // 互相重叠，读者读不出哪个变量进哪只门 ⇒ (A·B+C·D) 与 (A·C+B·D) 只能猜，
  // 猜错直接做错题。根因是输入端点的纵向分布只参照 `pos[0]`。
  const lib = parseFigureLib('f | and A B -> _p1 ; and C D -> _p2 ; nor _p1 _p2 -> Y');
  const html = restoreFigures(...(() => {
    const r = renderFigures(':::figure f', { lib });
    return [r.source, r.figures];
  })());
  const at = (lab) => {
    const m = html.match(new RegExp(`<text x="([\\d.]+)" y="([\\d.]+)"[^>]*data-label="${lab}"`));
    return m ? { x: +m[1], y: +m[2] } : null;
  };
  const A = at('A'); const B = at('B'); const C = at('C'); const D = at('D');
  assert.ok(A && B && C && D, '四个输入标签都要画出来');
  // A、B 同属上门 ⇒ 彼此靠近；C、D 同属下门 ⇒ 彼此靠近；而上组与下组要明显分开
  assert.ok(Math.abs(A.y - B.y) < 30, `A 与 B 应贴在同一个门的两个输入口（实得 ${A.y} / ${B.y}）`);
  assert.ok(Math.abs(C.y - D.y) < 30, `C 与 D 应贴在同一个门（实得 ${C.y} / ${D.y}）`);
  assert.ok(Math.abs(A.y - C.y) > 30, `上门与下门的输入不该挤在一起（实得 ${A.y} / ${C.y}）`);
  // 同门两输入的间距要够字高，不能重叠
  assert.ok(Math.abs(A.y - B.y) > 12, `A 与 B 的纵向间距 ${Math.abs(A.y - B.y)} 太小，标签会叠`);
});

test('wave：每行画高低电平参考轨（常高/常低的平线才分得出来）', () => {
  // 2026-10-29 三签实测：门(c) 的输出 Y ≡ 1，整行是一条平线；
  // 没有参考轨读者不知道这条线是高还是低，直接判错。
  const lib = parseFigureLib(['w | wave 4', 'C: 0000', 'Y: 1111'].join('\n'));
  const html = restoreFigures(...(() => {
    const r = renderFigures(':::figure w', { lib });
    return [r.source, r.figures];
  })());
  const rails = html.match(/<g class="fig-rails"[^>]*>([\s\S]*?)<\/g>/);
  assert.ok(rails, '应画出 fig-rails 分组');
  const n = [...rails[1].matchAll(/<line /g)].length;
  assert.equal(n, 4, `两行 × 两条轨 = 4 条，实得 ${n}`);
});

test('wave：时间轴与 0 轨拉开距离（贴太近会被读成第二路信号）', () => {
  const lib = parseFigureLib(['w | wave 4', 'A: 0000'].join('\n'));
  const html = restoreFigures(...(() => {
    const r = renderFigures(':::figure w', { lib });
    return [r.source, r.figures];
  })());
  const rail = html.match(/<g class="fig-rails"[^>]*>([\s\S]*?)<\/g>/)[1];
  const railYs = [...rail.matchAll(/y1="([\d.]+)"/g)].map((m) => +m[1]);
  const axisG = html.match(/<g class="fig-axis"[^>]*>([\s\S]*?)<\/g>/)[1];
  const axisYs = [...axisG.matchAll(/<line x1="[^"]*" y1="([\d.]+)"/g)].map((m) => +m[1]);
  const loRail = Math.max(...railYs);
  const axisY = Math.max(...axisYs);
  assert.ok(axisY - loRail >= 8, `时间轴 y=${axisY} 与 0 轨 y=${loRail} 只差 ${axisY - loRail}px，太近`);
});

test('布局：同列输入标签不得互相压字（间距 ≥ 字高）', () => {
  // 2026-10-29 三签实测 prob-7-14：`A`（y=50.3）与 `B`（y=59）只差 9px，
  // 比 13px 字号的字高还小，两个字母糊成一团，读者分不出哪条总线是 A、哪条是 B。
  const lib = parseFigureLib('f | not B -> ^B^ ; not C -> ^C^ ; not D -> ^D^ ; nand A ^D^ -> _p1 ; nand ^B^ C ^D^ -> _p2 ; nand B ^C^ ^D^ -> _p3 ; nand _p1 _p2 _p3 -> Y');
  const html = restoreFigures(...(() => {
    const r = renderFigures(':::figure f', { lib });
    return [r.source, r.figures];
  })());
  // 只取最左列的纯输入标签（x 很小）
  const ins = [...html.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*data-label="([^"]*)"/g)]
    .map((m) => ({ x: +m[1], y: +m[2], label: m[3] }))
    .filter((t) => t.x < 20)
    .sort((a, b) => a.y - b.y);
  assert.ok(ins.length >= 2, '应至少有两个纯输入标签');
  for (let i = 1; i < ins.length; i += 1) {
    const gap = ins[i].y - ins[i - 1].y;
    assert.ok(gap >= 17,
      `「${ins[i - 1].label}」与「${ins[i].label}」只隔 ${gap.toFixed(1)}px，会压字`);
  }
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

test('布局：走线不穿过任何门方框（穿过 = 读者以为信号经过了那只门）', () => {
  // 2026-10-29 实测：输入端口从最左端直接横穿中间列的门。
  // 穿透数 y-a-nb 4 段、prob-7-14 17 段、prob-7-16 15 段。
  // 电路图里「线穿方框」一律读作没画完，而且穿过非门会让读者以为取了反——会做错题。
  const GEOM = {
    and: [64, 52], nand: [64, 52], or: [64, 52], nor: [64, 52],
    xor: [64, 52], xnor: [64, 52], not: [52, 40], buf: [52, 40],
  };
  const countPen = (html) => {
    const gates = [...html.matchAll(
      /<g class="fig-comp"[^>]*data-op="([a-z]+)"[^>]*transform="translate\(([-\d.]+) ([-\d.]+)\)"/g)]
      .map((g) => {
        const [w, h] = GEOM[g[1]] || [64, 52];
        const x = +g[2]; const y = +g[3];
        return { x1: x, y1: y - h / 2, x2: x + w, y2: y + h / 2 };
      });
    const segs = [];
    for (const m of html.matchAll(/class="fig-wire"[^>]*d="([^"]+)"/g)) {
      let cur = null;
      for (const t of m[1].matchAll(/([MHV])\s*([-\d.]+)(?:\s+([-\d.]+))?/g)) {
        const op = t[1]; const a = +t[2]; const b = t[3] !== undefined ? +t[3] : null;
        if (op === 'M') cur = [a, b];
        else if (op === 'H') { segs.push({ x1: cur[0], y1: cur[1], x2: a, y2: cur[1] }); cur = [a, cur[1]]; }
        else if (op === 'V') { segs.push({ x1: cur[0], y1: cur[1], x2: cur[0], y2: a }); cur = [cur[0], a]; }
      }
    }
    let n = 0;
    for (const s of segs) {
      for (const g of gates) {
        if (s.y1 === s.y2) {
          const lo = Math.min(s.x1, s.x2); const hi = Math.max(s.x1, s.x2);
          if (s.y1 > g.y1 + 1 && s.y1 < g.y2 - 1 && hi > g.x1 + 1 && lo < g.x2 - 1) n += 1;
        } else if (s.x1 === s.x2) {
          const lo = Math.min(s.y1, s.y2); const hi = Math.max(s.y1, s.y2);
          if (s.x1 > g.x1 + 1 && s.x1 < g.x2 - 1 && hi > g.y1 + 1 && lo < g.y2 - 1) n += 1;
        }
      }
    }
    return n;
  };

  const lib = parseFigureLib([
    'a | not B -> ^B^ ; and A ^B^ -> Y',
    'b | not A -> ^A^ ; not B -> ^B^ ; and A ^B^ -> Y~1~ ; and ^A^ B -> Y~2~ ; and ^A^ ^B^ -> _p1 ; and A B -> _p2 ; or _p1 _p2 -> Y~3~',
    'c | not B -> ^B^ ; not C -> ^C^ ; not D -> ^D^ ; nand A ^D^ -> _p1 ; nand ^B^ C ^D^ -> _p2 ; nand B ^C^ ^D^ -> _p3 ; nand _p1 _p2 _p3 -> Y',
  ].join('\n'));
  for (const id of ['a', 'b', 'c']) {
    const r = renderFigures(`:::figure ${id}`, { lib });
    const pen = countPen(restoreFigures(r.source, r.figures));
    assert.equal(pen, 0, `${id} 有 ${pen} 段走线穿过门方框`);
  }
});

test('布局：画布宽度按最右门算，不看子句书写顺序', () => {
  // 原来宽度取 `pos[clauses.length-1]`，最后一条子句不在最右列时就会裁字
  // （实测 3 门最小复现宽 226、标签右边界 234，裁掉 8px）。
  const a = parseFigureLib('f | not B -> nB ; and A nB -> Y ; not C -> nC');
  const b = parseFigureLib('f | not C -> nC ; not B -> nB ; and A nB -> Y');
  const wr = (lib, id) => {
    const r = renderFigures(`:::figure ${id}`, { lib });
    return +(restoreFigures(r.source, r.figures)
      .match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/) || [])[1];
  };
  // 同样的门、不同的书写顺序 ⇒ 宽度必须一致（布局不依赖顺序）
  assert.equal(wr(a, 'f'), wr(b, 'f'), '同一组门换个书写顺序，画布宽度就变了');
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
