/**
 * 切块的性质测试（设计文档 §7.5 的判据）。
 *
 * 最重要的一条：**无损拼接**（顺次拼接切点之间的切片，逐字节等于源）——
 * 它保证「切」这件事没有丢字符，是其余一切不变量的地基。
 * 其次：切点全在行首、窗口两端栈相等、跨行 `$$` 不被切、`:::` 无半对。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCutIndex, planExcerpt, planExcerptRange, widenToChildren } from '../lib/切块.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

/** 取一批真实页做 fixture（覆盖：折叠块、跨行 $$、表格、SVG、代码围栏）。 */
function realFixtures() {
  const files = [
    '课程/电子技术/作业/2026-10-10-逻辑化简与状态表.md',
    '课程/电机学/课堂笔记/2026-10-08-磁路例题与变压器概述.md',
    '课程/电路原理/课堂笔记/2026-10-14-电源等效变换与无源二端网络等效.md',
    '课程/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.2-n阶行列式.md',
    '课程/电机学/教材解析/第02章-变压器的基本作用原理与理论分析/2.0-本章通关攻略.md',
  ];
  return files.map((rel) => ({ rel, text: fs.readFileSync(path.join(ROOT, rel), 'utf-8') }));
}

const SYNTHETIC = {
  '跨行 $$ + 行内 $$ 混用': [
    '# 标题',
    '',
    '前段文字。',
    '',
    '$$',
    'x = \\frac{1}{2}',
    '$$',
    '',
    '行内公式 $a=1$ 与行内双美元 $$b=2$$ 都在同一行。',
    '',
    '后段文字。',
    '',
  ].join('\n'),
  '折叠块内嵌表格与公式': [
    '# 标题',
    '',
    '题面在外。',
    '',
    ':::collapse accordion',
    '- 提示',
    '  看这里。',
    '',
    '  | a | b |',
    '  | :-: | :-: |',
    '  | 1 | 2 |',
    '',
    '  $$',
    '  y = 2',
    '  $$',
    ':::',
    '',
    '结尾段。',
    '',
  ].join('\n'),
  '代码围栏里有裸 ::: 与 $$': [
    '# 标题',
    '',
    '```',
    ':::collapse 这是围栏内的字面文本',
    '$$',
    'not math',
    '$$',
    '```',
    '',
    '真正的段落。',
    '',
  ].join('\n'),
  'CRLF 与无尾换行': '# 标题\r\n\r\n段落一。\r\n\r\n段落二。',
};

/** 切点切片顺次拼接，再补上「最后一行」（终点切点可能不含它，见 buildCutIndex 的说明）。 */
function joinedWithTail(text, idx) {
  let joined = '';
  for (let i = 0; i + 1 < idx.cuts.length; i++) {
    joined += text.slice(idx.cuts[i].offset, idx.cuts[i + 1].offset);
  }
  const last = idx.cuts[idx.cuts.length - 1].offset;
  if (last < text.length) joined += text.slice(last); // 无尾换行：补最后一行
  return joined;
}

test('无损拼接：切点之间的切片顺次拼接逐字节等于源（真实页）', () => {
  for (const { rel, text } of realFixtures()) {
    const idx = buildCutIndex(text);
    assert.equal(joinedWithTail(text, idx), text, `${rel} 拼接不等于源`);
  }
});

test('无损拼接：合成边界页（CRLF / 无尾换行 / 围栏内字面 :::）', () => {
  for (const [name, text] of Object.entries(SYNTHETIC)) {
    const idx = buildCutIndex(text);
    assert.equal(joinedWithTail(text, idx), text, `${name} 拼接不等于源`);
  }
});

test('切点恒在行首（真实页 + 合成页）', () => {
  const all = [...realFixtures().map((f) => f.text), ...Object.values(SYNTHETIC)];
  for (const text of all) {
    const idx = buildCutIndex(text);
    for (const c of idx.cuts) {
      assert.ok(c.offset === 0 || text[c.offset - 1] === '\n', `切点 ${c.offset} 不在行首`);
    }
  }
});

test('窗口两端 openStack 逐元素相等（真实页，多个小节 + 多档预算）', () => {
  for (const { rel, text } of realFixtures()) {
    const idx = buildCutIndex(text);
    const headings = sourceHeadings(text);
    for (const h of headings) {
      for (const budget of [200, 500, 1200, 4000]) {
        const r = planExcerpt({
          source: text, index: idx, sectionId: h.a, headings,
          grams: { bigrams: ['公式'], unigrams: ['式'] }, budget,
        });
        if (!r.ok) continue;
        const left = idx.cuts.find((c) => c.offset === r.range.start);
        const right = idx.cuts.find((c) => c.offset === r.range.end);
        assert.ok(left && right, `${rel} 窗口端不是切点`);
        assert.deepEqual(left.openStack, right.openStack, `${rel} §${h.a} 预算${budget} 两端栈不等`);
      }
    }
  }
});

test('跨行 $$ 不被切开：窗口内 $$ 独占行成对出现', () => {
  const text = SYNTHETIC['跨行 $$ + 行内 $$ 混用'];
  const idx = buildCutIndex(text);
  const headings = sourceHeadings(text);
  for (const budget of [60, 100, 200, 400]) {
    const r = planExcerpt({ source: text, index: idx, sectionId: headings[0].a, headings, grams: { bigrams: [], unigrams: [] }, budget });
    if (!r.ok) continue;
    const bare = (r.text.match(/^\s*\$\$\s*$/gm) || []).length;
    assert.equal(bare % 2, 0, `预算${budget}：窗口内独占行 $$ 不成对（${bare} 个）`);
  }
});

test('代码围栏内的字面 ::: 与 $$ 不算围栏（不污染栈）', () => {
  const text = SYNTHETIC['代码围栏里有裸 ::: 与 $$'];
  const idx = buildCutIndex(text);
  // 全文扫完，栈应回到空
  const last = idx.cuts[idx.cuts.length - 1];
  assert.deepEqual(last.openStack, [], '代码围栏内的字面标记污染了栈');
});

test(':::collapse 内嵌表格/公式：整块进出，窗口无半对', () => {
  const text = SYNTHETIC['折叠块内嵌表格与公式'];
  const idx = buildCutIndex(text);
  const headings = sourceHeadings(text);
  for (const budget of [80, 150, 300, 800]) {
    const r = planExcerpt({ source: text, index: idx, sectionId: headings[0].a, headings, grams: { bigrams: ['提示'], unigrams: [] }, budget });
    if (!r.ok) continue;
    const opens = (r.text.match(/^:::\s*[A-Za-z]/gm) || []).length;
    const closes = (r.text.match(/^:::\s*$/gm) || []).length;
    assert.equal(opens, closes, `预算${budget}：::: 开合不配（开${opens} 闭${closes}）`);
  }
});

test('预算越界报 bad-budget；未知小节报 unknown-section', () => {
  const text = SYNTHETIC['CRLF 与无尾换行'];
  const idx = buildCutIndex(text);
  const headings = sourceHeadings(text);
  assert.equal(planExcerpt({ source: text, index: idx, sectionId: headings[0].a, headings, grams: { bigrams: [], unigrams: [] }, budget: 1 }).reason, 'bad-budget');
  assert.equal(planExcerpt({ source: text, index: idx, sectionId: '不存在', headings, grams: { bigrams: [], unigrams: [] }, budget: 500 }).reason, 'unknown-section');
});

test('truncated 时 ref.anchor 等于小节 id', () => {
  const { text } = realFixtures()[0];
  const idx = buildCutIndex(text);
  const headings = sourceHeadings(text);
  const h = headings.find((x) => x.level >= 2) || headings[0];
  const r = planExcerpt({ source: text, index: idx, sectionId: h.a, headings, grams: { bigrams: ['逻辑'], unigrams: [] }, budget: 300 });
  if (r.ok && r.truncated) assert.equal(r.ref.anchor, h.a);
});

/** 从源 markdown 里扫标题（本站标题都在行首、`#`+空格）。 */
function sourceHeadings(text) {
  const out = [];
  const re = /^(#{1,6})\s+(.*)$/gm;
  let m;
  while ((m = re.exec(text))) {
    const title = m[2].trim();
    // 复刻 build.mjs 的 slug 规则（简化版：够测试用）
    const a = title.toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '');
    out.push({ a, level: m[1].length, offset: m.index, title });
  }
  return out;
}

test('widenToChildren：扩窗后标志与正文同源（候选3 的核心断言）', () => {
  // 造一页：父标题下只有一行，子节里有大段内容
  const text = [
    '# 页面',
    '',
    '## 父节',
    '',
    '一句话。',
    '',
    '### 子节一',
    '',
    '子节一的正文内容，讲了很多东西。'.repeat(12),
    '',
    '### 子节二',
    '',
    '子节二的正文内容。'.repeat(12),
    '',
    '## 下一节',
    '',
    '别的。',
    '',
  ].join('\n');
  const idx = buildCutIndex(text);
  const hs = sourceHeadings(text);
  const parent = hs.find((h) => h.title === '父节');
  const first = planExcerpt({
    source: text, index: idx, sectionId: parent.a, headings: hs,
    grams: { bigrams: ['正文'], unigrams: [] }, budget: 2000,
  });
  assert.ok(first.ok);
  const wider = widenToChildren(text, idx, first, hs, parent.a, { bigrams: ['正文'], unigrams: [] }, 2000);
  assert.ok(wider.ok);
  assert.ok(wider.text.length > first.text.length, '应扩到子节');
  // ★ 核心：标志与正文同源 —— 扩窗后 range 必须覆盖新 text，而不是父节的
  assert.equal(text.slice(wider.range.start, wider.range.end), wider.text, 'range 与 text 必须同源');
  // 且 truncated 是按**新窗口**算的（不再无条件改写）
  assert.equal(typeof wider.truncated, 'boolean');
  // insideCollapse/oversize 也是新窗口的事实
  assert.equal(typeof wider.insideCollapse, 'boolean');
  assert.equal(wider.oversize, wider.text.length > 2000);
});

test('planExcerptRange 与 planExcerpt 返回同一个值类型', () => {
  const text = ['# 页', '', '## 节', '', '正文一。'.repeat(30), ''].join('\n');
  const idx = buildCutIndex(text);
  const hs = sourceHeadings(text);
  const a = planExcerpt({ source: text, index: idx, sectionId: hs[0].a, headings: hs, grams: { bigrams: [], unigrams: [] }, budget: 500 });
  const b = planExcerptRange(text, idx, 0, text.length, { bigrams: [], unigrams: [] }, 500, hs[0].a);
  const keysA = Object.keys(a).sort().join(',');
  const keysB = Object.keys(b).sort().join(',');
  assert.equal(keysB, keysA, '两个入口的返回形状必须一致');
});

test('planExcerptRange：无合法切点时报 bad-range（不返回 null）', () => {
  const text = '# 页\n';
  const idx = buildCutIndex(text);
  const r = planExcerptRange(text, idx, 0, 0, { bigrams: [], unigrams: [] }, 500, 'x');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-range');
});
