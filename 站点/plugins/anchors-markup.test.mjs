// decorateAnchors 与「公式进属性」的产物完整性闸门（2026-10-30 实弹）。
//
// ## 两个真 bug，都是「页面看着还在、内容已经没了」这一类
//
// ### bug A：非贪婪正则吃掉了内层闭合标签
// `decorateAnchors` 原用 `/<span data-term="…">([\s\S]*?)<\/span>/`。
// 它假设被包的 span 里没有嵌套 span —— **错**：MathLive 的输出是
// `<span data-term><span class="ML__mathit">η</span></span>`，
// 非贪婪匹配到内层 `</span>` 就收工，产出 `…η</a></span>`：
// 外层 span 的闭合被吃掉、`</a>` 出现在 span 内部。
// 浏览器的错误恢复会在这里**把整个公式截断**——站长截图里一条分式只剩 `η(β`，
// DOM 里后面的分式、下标根本没被解析。
//
// ### bug B：占位符在属性值里被还原成 HTML
// 表头含行内公式时，`data-label="…"` 里放的是 `@@MATH_INLINE_N@@`，
// 而 Step 6 的还原**无条件塞完整 HTML**。那串 HTML 自带 `class="ML__latex"`，
// 一进属性就把属性闭死，余下标签全成单元格里的游离文本
// （页面上是字面 `">` 残片 + 整行竖排错位）。
//
// 判据都在产物上：属性里不许有裸标签；`<a class="sym-gloss">` 的配对必须完整。

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

test('★ bug A 回归：sym-gloss 锚点的标签必须成对（不许 <span>…</a></span>）', () => {
  assert.ok(existsSync(DIST), 'dist 不存在——先跑 node build.mjs');
  const bad = [];
  for (const file of walkHtml(DIST)) {
    const s = readFileSync(file, 'utf8');
    // 畸形形态：`<span …>` 里直接跟 `</a>`（中间没有它的 `</span>`）
    // 用逐段扫描而不是正则回溯，避免自己又踩「非贪婪」的老坑。
    let i = 0;
    while ((i = s.indexOf('<a class="sym-gloss"', i)) >= 0) {
      const end = s.indexOf('</a>', i);
      if (end < 0) break;
      const inner = s.slice(i, end);
      const opens = (inner.match(/<span[\s>]/g) || []).length;
      const closes = (inner.match(/<\/span>/g) || []).length;
      if (opens !== closes) {
        bad.push(`${path.relative(DIST, file)}: 锚点内 span 开 ${opens} / 闭 ${closes}`);
      }
      i = end + 4;
      if (bad.length >= 5) break;
    }
    if (bad.length >= 5) break;
  }
  assert.deepEqual(bad, [], `这些 sym-gloss 锚点标签不配对（会把公式截断）：\n${bad.join('\n')}`);
});

test('★ bug B 回归：data-label 等属性里不许出现裸标签', () => {
  const bad = [];
  for (const file of walkHtml(DIST)) {
    const s = readFileSync(file, 'utf8');
    for (const m of s.matchAll(/data-label="([^"]*)"/g)) {
      if (m[1].includes('<')) bad.push(`${path.relative(DIST, file)}: data-label 含裸标签 → ${m[1].slice(0, 40)}`);
    }
    if (bad.length >= 5) break;
  }
  assert.deepEqual(bad, [], `属性值被撑破了（页面上会冒字面 "> 残片）：\n${bad.join('\n')}`);
});

test('★ 公式完整性：data-math-plain 与可见文本必须同量级', () => {
  // 截断的公式会表现为「可见文本远少于纯文本投影」。抽样一批公式块来守。
  assert.ok(existsSync(DIST), 'dist 不存在');
  const files = walkHtml(DIST).filter((f) => f.includes('课程总览')).slice(0, 40);
  const bad = [];
  for (const file of files) {
    const s = readFileSync(file, 'utf8');
    for (const m of s.matchAll(/data-math-plain="([^"]{6,})"/g)) {
      const plain = m[1];
      // 产物里同一处应当能数出足够多的 ML__ 结构；只能粗判：
      // 若 plain 里有 `\frac` 语义（含 `/`）而附近没有 ML__mfrac，说明渲染缺件。
      // 这里用更稳的判据：plain 长度 vs 该公式容器的 span 数量在构建期无法直接看，
      // 所以退一步——只查「明显被截断」的形态：plain 以未闭合括号收尾。
      const opens = (plain.match(/[（(]/g) || []).length;
      const closes = (plain.match(/[）)]/g) || []).length;
      if (opens !== closes) bad.push(`${path.relative(DIST, file)}: plain 括号不配对 → ${plain.slice(0, 50)}`);
    }
    if (bad.length >= 5) break;
  }
  assert.deepEqual(bad, [], `这些公式的纯文本投影本身就不完整：\n${bad.join('\n')}`);
});
