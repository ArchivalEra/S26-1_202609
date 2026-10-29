// MathLive 静态样式表的完整性闸门。
//
// 为什么需要这一份：`assets/mathlive/mathlive-static.css` 是从 MathLive 的静态渲染
// 产物里拿的，不是完整的发行版样式表——它少了若干**元素自身**的布局规则，只有后代
// 规则。症状不是「报错」，是**排版静默塌陷**：
//
//   2026-10-29 实测（1.2-n阶行列式页，真实 Chromium）：`.ML__mtable` 没有
//   `display:inline-block`，退回默认 inline ⇒ 内部的 `display:table-cell` +
//   绝对定位撑不起高度 ⇒ 整张多行矩阵高度恒为 22px、各行重叠。用户看到的是
//   「矩阵行列式不如换引擎之前美观」。补上那一条，高度立刻恢复到真实值
//   （2 行 39px / 3 行 78px / 4 行 117px）。
//
// 闸门形态：把「渲染产物里会出现、且必须由自身规则定位」的类逐个核对，
// 缺一个就红。这类缺陷自动化测试抓不到运行时表现，只能守样式表本身。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS_SRC = path.join(HERE, '../assets/mathlive/mathlive-static.css');
const CSS_DIST = path.join(HERE, '../dist/assets/mathlive/mathlive-static.css');

const read = () => readFileSync(CSS_SRC, 'utf8');

/**
 * 从 CSS 里取「某类作为选择器末尾」的声明块（该元素**自身**的规则）。
 * 只认选择器最后一段是 `.类名`（可带伪类），不算 `.X .类名` 这种后代形态。
 *
 * 先剥注释：`/* … *\/` 里可能就写着 `.ML__mtable{...}` 这样的示例，
 * 不剥会把它当成真规则（本轮补丁的注释里正好有一份）。
 */
function selfRule(cssIn, cls) {
  const css = String(cssIn).replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    for (const part of m[1].split(',')) {
      const sel = part.trim();
      // 去伪类后以 .类名 结尾
      const bare = sel.replace(/::?[a-z-]+(\([^)]*\))?$/i, '');
      if (bare === '.' + cls) out.push(m[2].trim());
    }
  }
  return out;
}

test('MathLive 样式表：.ML__mtable 必须有自身的 display:inline-block', () => {
  // 这一条是矩阵/行列式排版的地基（见文件头注释的实测记录）。
  const rules = selfRule(read(), 'ML__mtable');
  assert.ok(rules.length > 0, '.ML__mtable 没有任何自身规则——矩阵会塌成一行');
  assert.ok(rules.some((r) => /display\s*:\s*inline-block/.test(r)),
    '.ML__mtable 缺少 display:inline-block，矩阵高度会塌陷且各行重叠');
});

test('MathLive 样式表：承载绝对定位的容器类都要有自身规则', () => {
  // 这些类在产物里作为**元素自身**出现，靠自己的 display 建立包含块。
  // 只写后代规则不够——后代规则的生效前提是父级先排对。
  const css = read();
  const need = {
    'ML__mtable': /display\s*:\s*inline-block/,
    'ML__vlist': /display\s*:\s*table-cell/,
    'ML__vlist-t': /display\s*:\s*inline-table/,
    'ML__vlist-r': /display\s*:\s*table-row/,
    'ML__base': /position\s*:\s*relative/,
    'ML__latex': /display\s*:\s*inline-block/,
  };
  const missing = [];
  for (const [cls, re] of Object.entries(need)) {
    const rules = selfRule(css, cls);
    // vlist 系列是 `.ML__latex .ML__vlist` 形态（后代作用域），单独放行
    const scoped = new RegExp('\\.ML__latex\\s+\\.' + cls + '\\s*\\{([^}]*)\\}').exec(css);
    const bodies = rules.concat(scoped ? [scoped[1]] : []);
    if (!bodies.length) { missing.push(`${cls}（无规则）`); continue; }
    if (!bodies.some((b) => re.test(b))) missing.push(`${cls}（缺 ${re.source}）`);
  }
  assert.deepEqual(missing, [], `这些类的自身布局规则缺失，排版会静默塌陷：${missing.join('、')}`);
});

test('MathLive 样式表：dist 副本与源文件一致（构建必须带出补丁）', () => {
  assert.ok(existsSync(CSS_DIST), 'dist 里没有 mathlive-static.css——先跑 node build.mjs');
  assert.equal(readFileSync(CSS_DIST, 'utf8'), read(),
    'dist 的 MathLive 样式与源文件不一致：构建没把补丁带出去，页面仍是坏的');
});
