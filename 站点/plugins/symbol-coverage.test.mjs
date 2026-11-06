// symbol-coverage.test.mjs —— 符号覆盖闸门（对**真实构建产物**断言）。
//
// 站长原话（2026-11-05）：「我希望构建期能跟公式一样直接 CI 来测试
//   每个是否能冒泡并且能统计。」
//
// ## 为什么不能只信构建自报
//
// build.mjs 把逐页量测写进 `dist/symbol-coverage.json`，但「构建 0 错误、
// 闸门全绿、页面却是坏的」在本仓发生过太多次（glossary-bubble.test.mjs 的
// 头注释记着 `\det` 那次）。所以这里的断言**全部对真实 dist HTML 独立重量**，
// 构建自报只用来对账——两边对不上就是构建在说谎。
//
// ## 判据（与 measurePage 同一把尺，见模块头注释）
//
//   冒泡 = 产物里有 `<a class="sym-gloss" data-term="…">`；
//   漏   = ① 正文里字面残留 `[tex]{#id}`（renderGlossary 解析不了就原样留下）；
//          ② 裸 `<span data-term>`（decorateAnchors 包不成链接）；
//          ③ 构建期 glossaryWarn（令牌原样保留 / 包未注册 / 排除指向坏词条）。
//   `<code>` 与 `<script>` 里的写法示例是文档、不是页面符号，不排除会假报。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { measurePage } from './symbol-coverage.mjs';

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

test('符号覆盖：构建自报的「未冒泡」必须为空（账本 = 事实）', () => {
  const reportPath = path.join(DIST, 'symbol-coverage.json');
  assert.ok(existsSync(reportPath), 'dist/symbol-coverage.json 不存在——先跑 node build.mjs');
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.deepEqual(report.uncovered, [],
    '这些符号该冒泡却没冒（补词条 / 修令牌 / 修排除；真修不了归 issue）：\n'
    + report.uncovered.map((u) => `  ${u.page} · ${u.kind} · ${u.detail}`).join('\n'));
});

test('符号覆盖：独立复测 dist——字面残留令牌与裸 span 必须为零', () => {
  assert.ok(existsSync(DIST), 'dist 不存在——先跑 node build.mjs');
  const problems = [];
  let pages = 0;
  for (const file of walkHtml(DIST)) {
    pages += 1;
    const m = measurePage(readFileSync(file, 'utf8'));
    for (const t of m.literalTokens) {
      problems.push(`  ${path.relative(DIST, file)}：未解析令牌 ${t}`);
    }
    for (const k of m.bareSpans) {
      problems.push(`  ${path.relative(DIST, file)}：裸 <span data-term="${k}">`);
    }
  }
  assert.ok(pages > 100, `dist 只扫到 ${pages} 页——产物不像完整构建`);
  assert.deepEqual(problems, [],
    '这些页面有符号冒不了泡（构建自报为绿，独立复测抓到漏——构建在说谎）：\n'
    + problems.join('\n'));
});

test('符号覆盖：构建自报的冒泡数与独立复测对得上（数字同源）', () => {
  const report = JSON.parse(readFileSync(path.join(DIST, 'symbol-coverage.json'), 'utf8'));
  let anchors = 0;
  for (const file of walkHtml(DIST)) {
    anchors += measurePage(readFileSync(file, 'utf8')).anchors;
  }
  assert.equal(report.symbols_bubbled, anchors,
    '账本说冒了 ' + report.symbols_bubbled + ' 个，产物里只数出 ' + anchors
    + ' 个——两边不是同一份产物，先重建再断言');
  assert.ok(anchors > 0, '全站一个符号锚点都没有——符号系统整个下线了？');
});

test('符号覆盖：变异自证——量法必须抓得到人为制造的漏', () => {
  // 「临时删一条词条」在产物里的形状 = 一个未解析令牌 + 一个裸 span。
  // 这两个假 HTML 就按删掉词条后的产物造：量法抓不到 ⇒ 闸门是纸糊的。
  const good = '<p>看 <a class="sym-gloss" data-term="工程数学:sym-det" '
    + 'href="../符号入门.html#sym-det">det</a> 这一处，正常冒泡。</p>';
  const mutated = '<p>向量 [\\boldsymbol{\\alpha}]{#sym-vec} 没解析，字面留在正文。</p>'
    + '<span class="katex"><span class="enclosing" data-term="工程数学:sym-lost">x</span></span>';
  const docExample = '<p>写法：<code>[a_{ij}]{#sym-index}</code>（<code> 里是示例，不算漏）</p>';

  const ok = measurePage(good);
  assert.equal(ok.literalTokens.length, 0, '好页面不该报未解析令牌');
  assert.equal(ok.bareSpans.length, 0, '好页面不该报裸 span');
  assert.equal(ok.anchors, 1, '好页面的锚点数应是 1');

  const bad = measurePage(mutated);
  assert.deepEqual(bad.literalTokens, ['[\\boldsymbol{\\alpha}]{#sym-vec}'],
    '删词条后留下的字面令牌必须被抓到');
  assert.deepEqual(bad.bareSpans, ['工程数学:sym-lost'],
    '包不成链接的裸 span 必须被抓到');

  const doc = measurePage(docExample);
  assert.equal(doc.literalTokens.length, 0,
    '<code> 里的写法示例是文档，不是页面符号——排除失灵会假报一片');
});
