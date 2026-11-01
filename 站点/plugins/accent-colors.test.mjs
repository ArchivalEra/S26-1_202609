// 顶栏入口的四档强调色 + 符号色（2026-11-01 站长定案）。
//
// ## 需求原文
//
// 「只需要将 headline 那边所有按钮统一成助手那样的展开时候高亮就好，
//  四个颜色要不一样，就是说都跟着 hue 但是色深不一样，参考 M3E」，
// 以及「强调色的符号可读性一直不怎么好，也选个高对比度的色」。
//
// ## 两处实测得出的**必须**（不是风格偏好）
//
// ① **必须用 oklch，不能用 hsl 定死 L。**
//    第一版用 `hsl()` 给四档定 `L=40/36/34/38`，一测黄色的档只有 **2.6:1**。
//    hsl 的 L 是物理亮度，同一个 L 下黄色比蓝色亮得多（人眼更甚），
//    想补救就得按色相查表 —— 但调色盘的 hue 是**滑块连续值**（0–359），
//    CSS 里做不了查表。oklch 的 L 是**感知亮度**，一档参数覆盖全部色相：
//    实测 L=0.48 / C=0.12 时所有色相最差 5.26:1（AA 门槛 4.5）。
//
// ② **调透明底必须用 `color-mix(in oklab, …)` 或 oklch 的 alpha，
//    绝不能用 `color-mix(in srgb, oklch(…) 20%, transparent)`。**
//    Chromium 在 srgb 空间混合 oklch 时**跳过色域映射**，产物是
//    `color(srgb -0.255691 …)` 这种**负值**（实测抓到的真 bug）——
//    负值 sRGB 在渲染上是未定义行为，某些色相下会直接出怪色。
//
// ③ **调色盘与搜索也要有 `aria-expanded`。**
//    统一高亮的判据就是这个属性；原来只有资源包/笔记本/助手有，
//    调色盘只切 `.open` 类、搜索什么都不切 —— 它们的按钮永远不亮。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.join(HERE, '../assets/theme/shirone-reader.css'), 'utf8');
const THEME_JS = fs.readFileSync(path.join(HERE, '../assets/theme/shirone-reader.js'), 'utf8');
const SEARCH = fs.readFileSync(path.join(HERE, 'site-search.mjs'), 'utf8');

function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

test('① 四档色走 oklch（感知亮度），不用 hsl 定死 L', () => {
  const code = stripCssComments(CSS);
  // 四个 accent 色相变量都必须存在且由 --hue 派生
  for (const n of [1, 2, 3, 4]) {
    assert.match(code, new RegExp(`--accent-${n}-h:\\s*calc\\(var\\(--hue\\)\\s*\\+`),
      `第 ${n} 档色相没有由 --hue 派生 —— 换调色盘时它不会跟着变`);
    assert.match(code, new RegExp(`--accent-${n}-l:`), `第 ${n} 档没有 oklch 亮度变量`);
  }
  // 使用处必须是 oklch（hsl 会把黄色档压到 2.6:1）
  const use = code.slice(code.indexOf('#pack-toggle {'), code.indexOf(':is(#pack-toggle'));
  assert.ok(use.length > 100, '找不到四档的消费处');
  assert.match(use, /oklch\(/, '四档没有用 oklch —— hsl 下黄色档的对比度会掉到 2.6:1');
  assert.ok(!/hsl\(/.test(use), '四档又用 hsl 了');
});

test('① 四档的色相是等距偏移（任意 hue 下都均匀分布）', () => {
  const code = stripCssComments(CSS);
  // 90° 一档：+60 / +150 / +240 / +330
  const m = [...code.matchAll(/--accent-([1-4])-h:\s*calc\(var\(--hue\)\s*\+\s*(\d+)\)/g)]
    .map((x) => ({ n: Number(x[1]), off: Number(x[2]) }));
  assert.equal(m.length, 4, '四档色相变量不全');
  const offs = m.sort((a, b) => a.n - b.n).map((x) => x.off);
  assert.deepEqual(offs, [60, 150, 240, 330],
    `四档偏移应为等距的 60/150/240/330（每 90° 一档），实际 ${offs.join('/')}`);
});

test('② 透明底用 oklab 混合或 alpha，绝不用 srgb 混合 oklch（会产生负值）', () => {
  const code = stripCssComments(CSS);
  // 实测 bug：color-mix(in srgb, oklch(…) 20%, transparent) →
  //   color(srgb -0.255691 0.358937 0.497507 / 0.2)  ← 负值
  assert.ok(!/color-mix\(in\s+srgb,\s*var\(--pack-accent\)/i.test(code),
    '用 srgb 空间混合 oklch 变体 —— Chromium 会跳过色域映射产出负值（实测抓到的真 bug）');
  // 必须有 oklab 混合（或 oklch alpha 形式）
  assert.match(code, /color-mix\(in\s+oklab,\s*var\(--pack-accent\)/,
    '没有 oklab 混合 —— 请改用 color-mix(in oklab, …) 或 oklch(… / alpha)');
});

test('② 色相变量必须 mod(…, 360)（accent-4 最大到 hue+330 = 689）', () => {
  const code = stripCssComments(CSS);
  const use = code.slice(code.indexOf('#pack-toggle {'), code.indexOf(':is(#pack-toggle'));
  // 消费处必须环绕（虽然 oklch 自己会取模，但显式 mod 让产物可读、也避免
  // 某些引擎在 calc 里把 >360 当字面值处理）
  const uses = (use.match(/mod\(var\(--accent-/g) || []).length;
  assert.ok(uses >= 4, `四档色相没都用 mod(…, 360) 环绕（实际 ${uses} 处）—— accent-4 = hue+330 会超 360`);
});

test('③ 五个入口按钮的展开态由同一条规则驱动', () => {
  const code = stripCssComments(CSS);
  // 必须有一条 :is(...) 覆盖五个 id + aria-expanded 的规则
  assert.match(code, /:is\(#pack-toggle,\s*#notebook-toggle,\s*#palette-toggle,\s*#search-toggle,\s*#assistant-toggle\)\[aria-expanded="true"\]/,
    '五个入口没有走同一条展开态规则 —— 又会有一个按钮展开后不亮');
  // 每档都要有自己的 --pack-accent
  for (const id of ['#pack-toggle', '#notebook-toggle', '#palette-toggle', '#search-toggle', '#assistant-toggle']) {
    assert.match(code, new RegExp(`${id}\\s*\\{[^}]*--pack-accent:`), `${id} 没有 --pack-accent`);
  }
});

test('③ 调色盘与搜索都会置 aria-expanded（否则按钮永远不亮）', () => {
  // 调色盘：原来只切 .open 类
  assert.match(THEME_JS, /paletteToggleBtn\.setAttribute\(["']aria-expanded["']/,
    '调色盘没置 aria-expanded —— 展开后按钮不会亮');
  // 搜索：原来什么都不切
  assert.match(SEARCH, /toggleBtn\.setAttribute\(["']aria-expanded["'],\s*["']true["']\)/,
    '搜索打开时没置 aria-expanded');
  assert.match(SEARCH, /toggleBtn\.setAttribute\(["']aria-expanded["'],\s*["']false["']\)/,
    '搜索关闭时没有复位 aria-expanded');
});

test('④ 符号色是独立令牌，且用 oklch 高饱和（不是 tertiary 的低饱和 30%）', () => {
  const code = stripCssComments(CSS);
  // 令牌必须存在
  assert.match(code, /--md-sys-color-symbol:\s*oklch\(/,
    '没有独立的符号色令牌 —— 用回 tertiary 的话饱和度只有 30%（读上去是灰紫色）');
  // 消费处：正文令牌与公式内符号都要用它
  const gloss = code.slice(code.indexOf('a.sym-gloss {'), code.indexOf('a.sym-gloss:hover'));
  assert.match(gloss, /var\(--md-sys-color-symbol\)/, '正文符号令牌没用新色');
  const inMath = code.slice(code.indexOf('.katex [data-term] {'), code.indexOf('.katex [data-term]:hover'));
  assert.match(inMath, /var\(--md-sys-color-symbol\)/, '公式内符号没用新色');
  // 反面：不许再用 tertiary（那是低饱和的那一档）
  assert.ok(!/a\.sym-gloss\s*\{[\s\S]*?color:\s*var\(--md-sys-color-tertiary\)/.test(gloss),
    '又用回 tertiary 了 —— 它的饱和度只有 30%');
});
