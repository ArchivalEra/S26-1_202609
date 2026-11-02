// symbol-parity.test.mjs —— **强调色判定 == 冒泡判定** 的奇偶校验（2026-11-01 站长定案）。
//
// ## 站长原话与为什么是「一个测试」
//
// 「先回到老生常谈的符号系统冒不了泡问题，我认为你应该让强调色的判定与
//  是否冒泡合并为一个测试」。
//
// 「符号系统冒不了泡」反复发作的**根因**不是某一个 bug，是**「什么是一个符号」
// 在全站有 5 处消费、4 种写法**：
//
//   消费处                | 语义               | 漂移后果
//   ----------------------|--------------------|---------------------------
//   prose-terms（点击）    | 点谁能冒泡          | 亮了点不出泡
//   webmcp（MCP 读面）     | 助手看到谁是符号    | 模型看到的符号集与读者不同
//   formula-cells（编辑）  | 点符号不进编辑      | 点符号进了编辑框
//   figures（让路）×3      | 图里点符号不抢事件  | 图元处理器抢走点击
//   CSS（强调色）          | 谁看着像符号        | 看着能点其实点不出泡
//
// 任何两处漂移就是一次「冒不了泡」。所以唯一真相收进
// `symbol-selector.mjs`（SYMBOL_SELECTORS / SYMBOL_SELECTOR），
// 本文件用**一个测试**守住：五个消费处 + CSS 着色，选出的集合必须与真源一致。
//
// ## 为什么 CSS 也进这个测试
//
// CSS 不能 import JS —— 它是唯一的「复写后无法用模块系统锁住」的消费方。
// 但强调色判定恰恰是 CSS 在做的（`.katex [data-term] { color: symbol }`）。
// 所以测试里把 CSS 的着色选择器**解析出来**与真源比对：不是逐字符比对
// （CSS 有作用域前缀，是同一集合的合法展开），而是比对**形状集合**。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYMBOL_SELECTORS, SYMBOL_SELECTOR } from './symbol-selector.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.join(HERE, '../assets/theme/shirone-reader.css'), 'utf8');
const PROSE = fs.readFileSync(path.join(HERE, 'prose-terms.mjs'), 'utf8');
const CELLS = fs.readFileSync(path.join(HERE, 'formula-cells.mjs'), 'utf8');
const FIGS = fs.readFileSync(path.join(HERE, 'figures.mjs'), 'utf8');
const WEBMCP = fs.readFileSync(path.join(HERE, 'webmcp-tools.mjs'), 'utf8');

/** 去掉 CSS 注释（断言不想被说明文字里的选择器误伤）。 */
function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * 从 CSS 里抽出「着色符号」的选择器形状集合。
 *
 * 判据：规则体里含 `color: var(--md-sys-color-symbol)`（强调色令牌）或
 * `color: var(--md-sys-color-symbol-hover)`（hover）的规则，其选择器列表
 * 按逗号拆开、剥掉作用域前缀后归一化。
 *
 * 剥作用域前缀的规则：`.article-content a.sym-gloss` / `.custom-md a.sym-gloss`
 * 都是 `a.sym-gloss` 的**同一集合的合法展开**（不同容器下的同一元素），
 * 所以归一化时去掉前导的类/容器前缀，只留**形状**：
 *   a.sym-gloss | .ML__latex [data-term] | .katex [data-term]
 */
function cssSymbolShapes(css) {
  const code = stripCssComments(css);
  const shapes = new Set();
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const body = m[2];
    if (!/color:\s*var\(--md-sys-color-symbol(-hover)?\)/.test(body)) continue;
    for (let sel of m[1].split(',')) {
      sel = sel.trim();
      if (!sel) continue;
      // 剥作用域前缀：取「最后一个能确定形状」的部分
      if (sel.includes('a.sym-gloss')) shapes.add('a.sym-gloss');
      else if (/\.ML__latex\s+\[data-term\]/.test(sel)) shapes.add('.ML__latex [data-term]');
      else if (/\.katex\s+\[data-term\]/.test(sel)) shapes.add('.katex [data-term]');
      else if (/\[data-term\]/.test(sel)) shapes.add(sel);   // 未知形状：原样记，让断言点名
    }
  }
  return shapes;
}

test('符号奇偶校验：强调色（CSS 着色）与冒泡（点击）选的是同一个集合', () => {
  // ── 真源 ──
  assert.equal(SYMBOL_SELECTORS.length, 3, '符号形状应有三条（正文/公式现役/公式兼容）');
  assert.match(SYMBOL_SELECTOR, /^a\.sym-gloss, \.ML__latex \[data-term\], \.katex \[data-term\]$/);

  // ── 冒泡侧：prose-terms 的点击委托必须用真源（插值进 GLOSSARY_JS）──
  assert.match(PROSE, /e\.target\.closest\("\$\{SYMBOL_SELECTOR\}"\)/,
    'prose-terms 的点击判定没用 SYMBOL_SELECTOR —— 它还是自己写的一份');

  // ── 强调色侧：CSS 着色的形状集合必须与真源一致 ──
  const shapes = cssSymbolShapes(CSS);
  for (const s of SYMBOL_SELECTORS) {
    assert.ok(shapes.has(s), `CSS 强调色缺形状「${s}」—— 它看着不像符号，但点了必须冒泡`);
  }
  // 反向：CSS 里不许出现**真源之外**的符号着色形状（那就是新的漂移点）
  for (const s of shapes) {
    assert.ok(SYMBOL_SELECTORS.includes(s),
      `CSS 强调色多出真源之外的形状「${s}」—— 要么进 symbol-selector.mjs，要么这不是符号`);
  }

  // ── 其余三个消费处 ──
  // MCP 读面：webmcp-tools 是自包含文件（测试用 toString 派生浏览器副本），
  // 它本地复写了一份 —— 断言复写与真源**逐字一致**。
  const m = WEBMCP.match(/const SYMBOL_SELECTOR = ("[^"]+")/);
  assert.ok(m, 'webmcp-tools 缺本地复写的 SYMBOL_SELECTOR');
  assert.equal(JSON.parse(m[1]), SYMBOL_SELECTOR, 'webmcp 的复写与真源漂移了');

  // 编辑守卫：formula-cells 点符号不进编辑，也用同一份（本地复写）
  const c = CELLS.match(/const SYMBOL_SELECTOR = ("[^"]+")/);
  assert.ok(c, 'formula-cells 缺本地复写的 SYMBOL_SELECTOR');
  assert.equal(JSON.parse(c[1]), SYMBOL_SELECTOR, 'formula-cells 的复写与真源漂移了');
  assert.match(CELLS, /closest\(SYMBOL_SELECTOR\)/, 'formula-cells 守卫没用常量');

  // figures 让路守卫 ×3：全部用同一份（图里公式符号曾被抢点击）
  const guards = (FIGS.match(/closest\(SYMBOL_SELECTOR\)/g) || []).length;
  assert.ok(guards >= 3, `figures 的让路守卫应至少 3 处用常量，实际 ${guards}`);
  assert.ok(!/closest\("a\.sym-gloss"\)/.test(FIGS),
    'figures 还有写死的 a.sym-gloss 让路守卫 —— 图里公式符号会被抢点击');
});
