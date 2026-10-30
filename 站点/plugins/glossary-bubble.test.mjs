// 气泡词典完整性闸门（对**真实构建产物**断言，不是对中间数据）。
//
// ## 为什么必须有这一条
//
// 气泡（点公式里的符号弹出释义）需要两样东西同时成立：
//   ① 页面上有 `<a class="sym-gloss" data-term="…">` 锚点；
//   ② `#sym-glossary-json` 里有同名词条。
// 只有 ① 没有 ② = **锚点点了没反应**——用户看到的是「det 冒不了泡」。
//
// 2026-10-29 实测成因：正文取词写进 `glossaryHits`，公式取词写进另一个 `pageMathHits`，
// 而气泡 JSON 只读前者 ⇒ 凡是在 `$…$` 里命中的符号全都没有气泡。`\det` 只在公式里
// 出现，所以它是第一个被用户发现的（矩阵行列式页）——但同批坏掉的远不止它。
//
// 这个缺陷单靠「构建 0 错误」和「锚点数 > 0」都发现不了：锚点照常生成、页面照常渲染，
// 只是点下去没东西。所以判据必须是**两个集合的差集为空**。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '../dist');

function walkHtml(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkHtml(p, out);
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

/** 从页面里取 { anchors:Set<term>, baked:Set<term> }。 */
function glossaryOf(html) {
  const anchors = new Set();
  const re = /class="sym-gloss"[^>]*data-term="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) anchors.add(m[1]);
  const baked = new Set();
  const tag = /<script[^>]*id="sym-glossary-json"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (tag) {
    try {
      const data = JSON.parse(tag[1]);
      for (const k of Object.keys(data.terms || {})) baked.add(k);
    } catch { /* 解析失败由下面的断言暴露 */ }
  }
  return { anchors, baked };
}

test('气泡词典：任何锚点都必须在同页的 sym-glossary-json 里有词条', () => {
  assert.ok(existsSync(DIST), 'dist 不存在——先跑 node build.mjs');
  const problems = [];
  for (const file of walkHtml(DIST)) {
    const html = readFileSync(file, 'utf8');
    const { anchors, baked } = glossaryOf(html);
    const missing = [...anchors].filter((t) => !baked.has(t));
    if (missing.length) {
      problems.push({ page: path.relative(DIST, file), n: missing.length, sample: missing.slice(0, 4) });
    }
  }
  assert.deepEqual(problems, [],
    '这些页面的符号点了不会冒泡（锚点在、词条不在）：\n'
    + problems.map((p) => `  ${p.page}：缺 ${p.n} 条，如 ${p.sample.join('、')}`).join('\n'));
});

test('气泡词典：公式里的符号也进得了气泡（det 这一个具体回归）', () => {
  // `\det` 只出现在 `$…$` 里，从不走正文取词——它冒不出泡就说明公式命中根本没并入。
  // 1.2 那页是用户实测发现的地方，用它当定点回归。
  const p = path.join(DIST, '课程总览/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.2-n阶行列式.html');
  assert.ok(existsSync(p), `缺产物：${p}（先构建）`);
  const html = readFileSync(p, 'utf8');
  const { anchors, baked } = glossaryOf(html);
  const dets = [...anchors].filter((t) => t.includes('sym-det'));
  assert.ok(dets.length > 0, '该页应出现 det 的锚点');
  for (const d of dets) {
    assert.ok(baked.has(d), `${d} 有锚点却没有词条——点了不会冒泡`);
  }
});

test('气泡「详细 ↗」的目标锚点必须真实存在（2026-10-30 实弹）', () => {
  // 病根：工程数学的符号入门页写的是 `:::glossary-dict`，而其余四门课与通用包
  // 都写 `:::glossary-dict table`。少一个 `table` 参数 ⇒ **只定义词条、不渲染词条总表**
  // ⇒ 18 页气泡里的「详细 ↗ 符号入门」全部指向不存在的 `#sym-inv` 等 id，点了落到页首。
  //
  // 一个参数之差、构建零错误、所有闸门全绿，只有真点气泡才看得见。
  // 判据：气泡 JSON 里每个词条的 href 锚点，都必须在**目标页**里有对应 id。
  const bad = [];
  for (const file of walkHtml(DIST)) {
    const html = readFileSync(file, 'utf8');
    const tag = /<script[^>]*id="sym-glossary-json"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    if (!tag) continue;
    let terms;
    try { terms = JSON.parse(tag[1]).terms || {}; } catch { continue; }
    for (const [key, v] of Object.entries(terms)) {
      const href = String(v.href || '');
      const hashAt = href.indexOf('#');
      if (hashAt < 0) continue;
      const anchor = decodeURIComponent(href.slice(hashAt + 1));
      // 解出目标页的 dist 相对路径（href 是相对当前页的）
      const relTarget = decodeURIComponent(href.slice(0, hashAt));
      const curDir = path.dirname(path.relative(DIST, file));
      const targetPath = path.normalize(path.join(DIST, curDir, relTarget));
      if (!existsSync(targetPath)) {
        bad.push(`${path.relative(DIST, file)} · ${key} → 目标页不存在：${relTarget}`);
        continue;
      }
      const target = readFileSync(targetPath, 'utf8');
      if (!target.includes(`id="${anchor}"`)) {
        bad.push(`${path.relative(DIST, file)} · ${key} → #${anchor} 在 ${path.basename(targetPath)} 里不存在`);
      }
    }
  }
  assert.deepEqual(bad, [],
    `这些气泡的「详细 ↗」点了落不到地方：\n${[...new Set(bad)].slice(0, 20).join('\n')}`);
});
