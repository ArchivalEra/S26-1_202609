// chat-render.test.mjs —— 聊天渲染管线的纯函数测试。
//
// 重点覆盖「流式边缘」：未闭合的代码块/公式/表格、`$` 与货币、部分 delta。
// 这些是最容易写出「看着对但边缘崩」的地方。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseIncremental, parseInline, renderBlockToOps, opsToText,
  safeHref, safeSrc, MAX_MESSAGE_CHARS,
} from './chat-render.mjs';

// ── 增量解析：完整块 ────────────────────────────────────────

test('段落：遇到空行才算完整', () => {
  const r1 = parseIncremental('这是一段话');
  assert.equal(r1.blocks.length, 0, '没有空行 → 还不完整');
  assert.equal(r1.rest, '这是一段话');

  const r2 = parseIncremental('这是一段话\n\n');
  assert.equal(r2.blocks.length, 1);
  assert.equal(r2.blocks[0].kind, 'p');
  assert.equal(r2.rest, '');
});

test('标题：单行即完整', () => {
  const r = parseIncremental('## 二级标题\n');
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].kind, 'h');
  assert.equal(r.blocks[0].level, 2);
  assert.equal(r.blocks[0].text, '二级标题');
});

test('代码块：闭合围栏才完整；未闭合留在 rest', () => {
  const open = parseIncremental('```js\nconst a = 1;\n');
  assert.equal(open.blocks.length, 0, '未闭合不该渲染');
  assert.match(open.rest, /```js/);

  const closed = parseIncremental('```js\nconst a = 1;\n```\n');
  assert.equal(closed.blocks.length, 1);
  assert.equal(closed.blocks[0].kind, 'code');
  assert.equal(closed.blocks[0].lang, 'js');
  assert.equal(closed.blocks[0].text, 'const a = 1;');
});

test('块级公式 $$…$$：未闭合留在 rest', () => {
  const open = parseIncremental('$$x^2');
  assert.equal(open.blocks.length, 0);
  assert.equal(open.rest, '$$x^2');

  const closed = parseIncremental('$$x^2 + y^2$$\n');
  assert.equal(closed.blocks.length, 1);
  assert.equal(closed.blocks[0].kind, 'math');
  assert.equal(closed.blocks[0].display, true);
  assert.equal(closed.blocks[0].tex, 'x^2 + y^2');
});

test('裸写的 \\begin{…}…\\end{…} 包成块级公式（模型常这么写）', () => {
  const r = parseIncremental('\\begin{aligned}a&=1\\\\b&=2\\end{aligned}\n');
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].kind, 'math');
  assert.match(r.blocks[0].tex, /^\\begin\{aligned\}/);
});

test('表格：需要分隔行才认；最后一行未结束时不渲染', () => {
  // 没有分隔行 ⇒ 不是表格，按普通段落处理（这是正确兜底，不是 bug）
  const noSep = parseIncremental('| a | b |\n');
  assert.equal(noSep.blocks.length, 1);
  assert.equal(noSep.blocks[0].kind, 'p');

  const partial = parseIncremental('| a | b |\n| --- | --- |\n| 1 |');
  assert.equal(partial.blocks.length, 0, '最后一行没换行 → 等下一块');

  const full = parseIncremental('| a | b |\n| --- | --- |\n| 1 | 2 |\n\n');
  assert.equal(full.blocks.length, 1);
  assert.equal(full.blocks[0].kind, 'table');
  assert.deepEqual(full.blocks[0].header, ['a', 'b']);
  assert.deepEqual(full.blocks[0].rows, [['1', '2']]);
});

test('列表：连续项一组；最后一项未结束时等待', () => {
  const partial = parseIncremental('- 第一项\n- 第二');
  assert.equal(partial.blocks.length, 0);

  const full = parseIncremental('- 第一项\n- 第二项\n\n');
  assert.equal(full.blocks.length, 1);
  assert.equal(full.blocks[0].kind, 'list');
  // 2026-10-22 起 items 是 {text, depth}（支持嵌套子列表）；depth=0 是顶层
  assert.deepEqual(full.blocks[0].items, [
    { text: '第一项', depth: 0 },
    { text: '第二项', depth: 0 },
  ]);
});

test('嵌套列表：缩进子项保留层级，不被吞进段落（2026-10-22 上游真实样本）', () => {
  // 真实上游回答里很常见：编号项下面跟缩进子项
  const src = '1. **最紧急**：只剩 2 小时\n   - 子项 A\n   - 子项 B\n2. **时间充裕**\n\n';
  const r = parseIncremental(src);
  assert.equal(r.blocks.length, 1, '整段应是一个列表块，不是列表+段落');
  assert.equal(r.blocks[0].kind, 'list');
  assert.deepEqual(r.blocks[0].items, [
    { text: '**最紧急**：只剩 2 小时', depth: 0 },
    { text: '子项 A', depth: 1 },
    { text: '子项 B', depth: 1 },
    { text: '**时间充裕**', depth: 0 },
  ]);
  // 渲染侧：depth 透传，ops 是结构化数据不是字面缩进文本
  const ops = renderBlockToOps(r.blocks[0]);
  assert.equal(ops[0].kind, 'list');
  assert.deepEqual(ops[0].items.map((x) => x.depth), [0, 1, 1, 0]);
  assert.ok(!JSON.stringify(ops).includes('   - 子项'), '缩进标记不得作为字面文本出现');
});

test('有序列表识别', () => {
  const r = parseIncremental('1. 甲\n2. 乙\n\n');
  assert.equal(r.blocks[0].ordered, true);
});

// ── 增量解析：流式不重排 ────────────────────────────────────

test('流式：逐块到达时，已完成的块不回到 rest', () => {
  const chunks = ['# 标题\n\n', '第一段\n\n', '```js\ncode\n```\n'];
  let buffer = '';
  const seen = [];
  for (const c of chunks) {
    buffer += c;
    const { blocks, rest } = parseIncremental(buffer);
    seen.push({ n: blocks.length, rest });
    buffer = rest;   // 只保留未完成部分，已渲染的不再传
  }
  assert.equal(seen[0].n, 1, '标题立刻完成');
  assert.equal(seen[1].n, 1, '段落完成');
  assert.equal(seen[2].n, 1, '代码块完成');
});

test('流式：未闭合代码块跨越多个 delta 后闭合', () => {
  let r = parseIncremental('```py\nprint(1)\n');
  assert.equal(r.blocks.length, 0);
  r = parseIncremental(r.rest + 'print(2)\n```\n');
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].text, 'print(1)\nprint(2)');
});

// ── 行内解析 ────────────────────────────────────────────────

test('行内公式：$…$ 识别', () => {
  const { ops, pendingTail } = parseInline('能量 $E=mc^2$ 很大');
  assert.equal(pendingTail, '');
  const math = ops.find((o) => o.kind === 'math');
  assert.ok(math);
  assert.equal(math.tex, 'E=mc^2');
  assert.equal(math.display, false);
});

test('行内公式：未闭合的 $ 留在 pendingTail（流式补全）', () => {
  const { ops, pendingTail } = parseInline('公式 $x^2');
  assert.equal(pendingTail, '$x^2');
  assert.equal(ops.filter((o) => o.kind === 'math').length, 0);
});

test('单个 $ 当货币：前面是数字/字母时不认作公式', () => {
  const a = parseInline('价格 $5 元');
  assert.equal(a.ops.filter((o) => o.kind === 'math').length, 0, '$5 应是货币');
  const b = parseInline('A$B');
  assert.equal(b.ops.filter((o) => o.kind === 'math').length, 0, '字母后的 $ 不算');
});

test('行内代码、粗体、斜体', () => {
  const { ops } = parseInline('用 `code` 和 **粗** 和 *斜*');
  assert.ok(ops.some((o) => o.kind === 'code' && o.text === 'code'));
  assert.ok(ops.some((o) => o.kind === 'strong' && o.text === '粗'));
  assert.ok(ops.some((o) => o.kind === 'em' && o.text === '斜'));
});

test('未闭合的 ** 留在 pendingTail', () => {
  const { pendingTail } = parseInline('这是 **粗体');
  assert.equal(pendingTail, '**粗体');
});

test('转义 \\$ 不触发公式', () => {
  const { ops } = parseInline('价格 \\$5');
  assert.equal(ops.filter((o) => o.kind === 'math').length, 0);
  assert.match(opsToText(ops), /\$5/);
});

// ── 安全不变量 ──────────────────────────────────────────────

test('I2 链接白名单：只放行 http/https/mailto/#', () => {
  assert.equal(safeHref('https://example.com'), 'https://example.com');
  assert.equal(safeHref('http://a.b'), 'http://a.b');
  assert.equal(safeHref('mailto:x@y.z'), 'mailto:x@y.z');
  assert.equal(safeHref('#sec-1'), '#sec-1');
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('data:text/html,<script>'), null);
  assert.equal(safeHref('vbscript:x'), null);
});

test('I2 不安全协议的链接只保留文字', () => {
  const { ops } = parseInline('[点我](javascript:alert(1))');
  assert.equal(ops.filter((o) => o.kind === 'link').length, 0);
  assert.match(opsToText(ops), /点我/);
});

test('I3 图片只允许同源相对路径', () => {
  assert.equal(safeSrc('figures/a.webp'), 'figures/a.webp');
  assert.equal(safeSrc('./x.png'), './x.png');
  assert.equal(safeSrc('https://evil.com/x.png'), null);
  assert.equal(safeSrc('//evil.com/x.png'), null);
  assert.equal(safeSrc('data:image/png;base64,AAA'), null);
});

test('I4 原始 HTML 标签按文本处理（不解析、不转发）', () => {
  const { ops } = parseInline('<script>alert(1)</script>');
  // 不产出任何结构化节点，只当文字
  assert.ok(ops.every((o) => o.kind === 'text'));
  assert.match(opsToText(ops), /<script>/);
});

// ── 块 → op ─────────────────────────────────────────────────

test('renderBlockToOps：各类型产出正确的 op', () => {
  assert.equal(renderBlockToOps({ kind: 'h', level: 2, text: '标题' })[0].kind, 'heading');
  assert.equal(renderBlockToOps({ kind: 'p', text: '段落' })[0].kind, 'para');
  assert.equal(renderBlockToOps({ kind: 'code', lang: 'js', text: 'x' })[0].kind, 'codeblock');
  assert.equal(renderBlockToOps({ kind: 'math', tex: 'x', display: true })[0].kind, 'mathblock');
  assert.equal(renderBlockToOps({ kind: 'list', items: ['a'] })[0].kind, 'list');
  assert.equal(renderBlockToOps({ kind: 'table', header: ['a'], rows: [] })[0].kind, 'table');
});

// ── 真实样本 ────────────────────────────────────────────────

test('真实模型输出样本：混合内容一次解析', () => {
  const sample = [
    '## 电机学课堂笔记',
    '',
    '电机学共有 **2 篇**课堂笔记：',
    '',
    '1. 09-24 绪论（电机概述、分类与磁路基础）',
    '2. 10-08 磁路例题 1-1 与变压器概述',
    '',
    '| 日期 | 标题 |',
    '| --- | --- |',
    '| 09-24 | 绪论 |',
    '',
    '磁路欧姆定律 $R_m = \\frac{l}{\\mu A}$ 是基础。',
    '',
    '```text',
    '路径：课程总览/电机学/课堂笔记/',
    '```',
    '',
  ].join('\n');
  const { blocks, rest } = parseIncremental(sample);
  assert.equal(rest, '');
  const kinds = blocks.map((b) => b.kind);
  assert.deepEqual(kinds, ['h', 'p', 'list', 'table', 'p', 'code']);
});

test('超长输入被截断（防 ReDoS）', () => {
  const huge = 'x'.repeat(MAX_MESSAGE_CHARS + 5000);
  const r = parseIncremental(huge);
  assert.ok(r.rest.length <= MAX_MESSAGE_CHARS);
});

// ── 边界：空输入与纯空白 ────────────────────────────────────

test('空输入返回空块与空 rest', () => {
  assert.deepEqual(parseIncremental(''), { blocks: [], rest: '', restStart: 0 });
  assert.deepEqual(parseIncremental('\n\n\n'), { blocks: [], rest: '', restStart: 3 });
});

test('parseInline 空输入不崩', () => {
  assert.deepEqual(parseInline(''), { ops: [], pendingTail: '' });
});
