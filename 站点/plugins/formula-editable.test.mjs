// 公式必须带可编辑的 LaTeX 源（2026-10-31，为能力包的 MathLive 编辑态）。
//
// ## 为什么这条必须存在
//
// 2026-10-31 实测：产物里每个公式只有 `data-math-plain`（给人读的纯文本投影，
// 形如 `x1,x2,x3`），**没有** `data-math-tex`。而 pack-runtime 当时把 plain 当
// LaTeX 喂进 `<math-field>`——用户点开编辑器看到的是 `x1,x2,x3`，
// 一改就把 `x_{1},x_{2},x_{3}` 改成别的东西。
//
// 这类缺陷自动闸门全绿：页面能开、公式能渲染、构建 0 错误。只有真去编辑才暴露。
// 所以把「公式必须带 LaTeX 源」变成构建后可测的判据。
//
// ## 为什么还要验「能重新解析」
//
// 只查属性存在会漏掉「烘了个残串」：多一个 `\right`、少一个 `}`，属性在、
// 值也能塞进 math-field，但编辑器一打开就是错的。所以把 tex 真的喂回
// `parse()`，解析报错就红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseMath } from '../math/parser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '../dist');

function walkHtml(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walkHtml(p, out);
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

/** 取出产物里所有 kaTeX 公式容器的开标签属性串。 */
function formulaTags(html) {
  return [...html.matchAll(/<span class="katex"([^>]*)>/g)].map((m) => m[1]);
}

const attrOf = (attrs, name) => {
  const m = new RegExp(`${name}="([^"]*)"`).exec(attrs);
  return m ? m[1] : null;
};

test('每个公式容器都带 data-math-tex（能力包编辑态的 LaTeX 源）', () => {
  assert.ok(existsSync(DIST), 'dist 不存在');
  const files = walkHtml(DIST).filter((f) => f.includes('课程总览'));
  assert.ok(files.length > 0, '没扫到课程页');
  const bad = [];
  let total = 0;
  for (const file of files) {
    const html = readFileSync(file, 'utf8');
    for (const attrs of formulaTags(html)) {
      total++;
      if (attrOf(attrs, 'data-math-tex') === null) {
        bad.push(path.relative(DIST, file));
        break;
      }
    }
    if (bad.length >= 5) break;
  }
  assert.ok(total > 0, '一条公式都没扫到——选择器或产物结构变了');
  assert.deepEqual(bad, [],
    '这些页面有公式缺 data-math-tex（编辑器拿不到 LaTeX，只能拿纯文本投影＝会改错公式）：\n'
    + bad.join('\n'));
});

test('data-math-tex 的源头必须是公式原文，不是纯文本投影', () => {
  // 反向守卫：防「哪天有人图省事把 plain 抄进 tex 属性」。
  //
  // ⚠️ 这条**不能靠扫产物判断**。第一版试过「tex === plain 就红」，实测 165 处
  // 假阳性：`196`、`(4,11,11)`、`10x+5y+2z=0`、单字符 `D` 这些公式**本来**就没有
  // LaTeX 结构，tex 与 plain 相同是正确结果，不是抄来的。
  //
  // 在产物里无法区分「合法的无结构公式」与「抄了投影」，所以改查**源头**：
  // 适配器里给 data-math-tex 赋的值必须是 `expr.source`（构建期从 markdown 的
  // `$…$` 里原样取出的那串），不能是 `expr.plainHint` / `doc.plain`。
  const src = readFileSync(path.join(HERE, '../math/render.mjs'), 'utf8');
  assert.match(src, /const srcTex = expr\.source/, 'data-math-tex 的取值不是 expr.source');
  assert.ok(!/const srcTex = expr\.plainHint/.test(src),
    'data-math-tex 取成了纯文本投影（plainHint）——编辑器会把公式改错');
  assert.ok(!/data-math-tex="[^"]*"\s*\+[^;]*plainHint/.test(src),
    'data-math-tex 里混进了 plainHint');

  // 正向佐证（产物侧，只查一类**必然**有结构差异的公式）：
  // 含下标/上标的公式，其 tex 必含 `_` 或 `^`，而 plain 必不含——若某条 tex===plain
  // 且页面里同位置 plain 有数字尾缀，说明 tex 退化了。抽样前 40 页即可。
  assert.ok(existsSync(DIST), 'dist 不存在');
  const files = walkHtml(DIST).filter((f) => f.includes('课程总览')).slice(0, 40);
  const bad = [];
  for (const file of files) {
    const html = readFileSync(file, 'utf8');
    for (const attrs of formulaTags(html)) {
      const tex = attrOf(attrs, 'data-math-tex');
      const plain = attrOf(attrs, 'data-math-plain');
      if (!tex || !plain || tex !== plain) continue;
      // 只有「plain 里明显有下标/上标的痕迹」才算可疑：形如 `x1`、`a11`、`r3-r1`
      // 这种「小写字母紧跟数字」在 LaTeX 里必然写成 `x_{1}`。
      if (/[a-zA-Z]\d/.test(tex)) {
        bad.push(`${path.relative(DIST, file)}: tex === plain === 「${tex.slice(0, 30)}」`);
      }
    }
    if (bad.length >= 5) break;
  }
  assert.deepEqual(bad, [],
    '这些公式的 tex 像是纯文本投影（形如 x1 而不是 x_{1}）：\n' + bad.join('\n'));
});

test('data-math-tex 必须能被解析器重新读进去（防「烘了个残串」）', () => {
  assert.ok(existsSync(DIST), 'dist 不存在');
  const files = walkHtml(DIST).filter((f) => f.includes('课程总览'));
  const bad = [];
  let checked = 0;
  for (const file of files) {
    const html = readFileSync(file, 'utf8');
    for (const attrs of formulaTags(html)) {
      const tex = attrOf(attrs, 'data-math-tex');
      if (!tex) continue;
      checked++;
      const decoded = tex
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      let errs = [];
      try {
        const r = parseMath(decoded);
        errs = (r.problems || []).filter((p) => p.severity === 'error');
      } catch (e) {
        errs = [{ message: e.message }];
      }
      if (errs.length) {
        bad.push(`${path.relative(DIST, file)}: 「${decoded.slice(0, 40)}」→ ${errs[0].message}`);
      }
      if (bad.length >= 5) break;
    }
    if (bad.length >= 5) break;
  }
  assert.ok(checked > 0, '一条 data-math-tex 都没检查到');
  assert.deepEqual(bad, [],
    'data-math-tex 解析不回原文（编辑器打开就是错的）：\n' + bad.join('\n'));
});

test('pack-runtime 只认 data-math-tex，不许回退到 data-math-plain', () => {
  const src = readFileSync(path.join(HERE, 'pack-runtime.mjs'), 'utf8');
  assert.match(src, /getAttribute\("data-math-tex"\)/, '没读 data-math-tex');
  // 关键：不许出现「拿 plain 当 latex 传进 openEditor」这条老路
  assert.ok(!/getAttribute\("data-math-plain"\)\s*\|\|\s*el\.getAttribute\("aria-label"\)/.test(src),
    '又回到「读 data-math-plain 当 LaTeX」了——那会把公式改错（见本条测试的头注释）');
});
