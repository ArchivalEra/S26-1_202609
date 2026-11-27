// symbol-parity.test.mjs —— 强调色判定 == 冒泡判定 == 各适配器运行时契约的奇偶校验。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYMBOL_SELECTORS, SYMBOL_SELECTOR, SYMBOL_RUNTIME_ASSET } from '../symbols/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '../dist');
const CSS = fs.readFileSync(path.join(HERE, '../assets/theme/shirone-reader.css'), 'utf8');
const RUNTIME = fs.readFileSync(path.join(HERE, '../symbols/runtime.mjs'), 'utf8');
const HELPERS = fs.readFileSync(path.join(HERE, 'site-helpers.mjs'), 'utf8');

function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

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
      if (sel.includes('a.sym-gloss')) shapes.add('a.sym-gloss');
      else if (/\.katex\s+\[data-term\]/.test(sel)) shapes.add('.katex [data-term]');
      else if (/\[data-term\]/.test(sel)) shapes.add(sel);
    }
  }
  return shapes;
}

test('符号奇偶校验：强调色（CSS 着色）与冒泡/守卫/页面便利函数使用同一单一真相', () => {
  // ── 真源：已清理退场 .ML__latex [data-term]，只留两条现役形状 ──
  assert.deepEqual(SYMBOL_SELECTORS, ['a.sym-gloss', '.katex [data-term]']);
  assert.equal(SYMBOL_SELECTOR, 'a.sym-gloss, .katex [data-term]');

  // ── 冒泡侧：symbols/runtime.mjs 必须用真源插值 ──
  assert.match(RUNTIME, /e\.target\.closest\("\$\{SYMBOL_SELECTOR\}"\)/,
    'symbols/runtime.mjs 的点击判定没用 SYMBOL_SELECTOR');

  // ── 强调色侧：CSS 着色的形状集合必须与真源逐项一致 ──
  const shapes = cssSymbolShapes(CSS);
  for (const s of SYMBOL_SELECTORS) {
    assert.ok(shapes.has(s), `CSS 强调色缺形状「${s}」`);
  }
  for (const s of shapes) {
    assert.ok(SYMBOL_SELECTORS.includes(s),
      `CSS 强调色多出真源之外的形状「${s}」`);
  }
  assert.ok(!/\.ML__latex\s+\[data-term\]/.test(stripCssComments(CSS)),
    'shirone-reader.css 应已清理退场的 .ML__latex [data-term]');

  // ── 其余源码适配器：一律直接 import symbols/index.mjs，不再手工复写 ──
  for (const [label, src] of [
    ['site-helpers', HELPERS],
  ]) {
    assert.match(src, /from ['"]\.\.\/symbols\/index\.mjs['"]/,
      `${label} 必须直接从 ../symbols/index.mjs 导入真源`);
    assert.ok(!/"a\.sym-gloss,/.test(src),
      `${label} 不应再手工硬编码选择器副本`);
  }

  // ── 构建产物端一致性（dist 存在时一并核验） ──
  if (fs.existsSync(DIST)) {
    const bubbleJs = fs.readFileSync(path.join(DIST, SYMBOL_RUNTIME_ASSET), 'utf8');
    const helpersJs = fs.readFileSync(path.join(DIST, 'assets/plugins/site-helpers.js'), 'utf8');
    for (const [name, js] of [
      [SYMBOL_RUNTIME_ASSET, bubbleJs],
      ['site-helpers.js', helpersJs],
    ]) {
      assert.ok(js.includes(SYMBOL_SELECTOR), `dist/${name} 未注入一致的 SYMBOL_SELECTOR`);
    }
  }
});
