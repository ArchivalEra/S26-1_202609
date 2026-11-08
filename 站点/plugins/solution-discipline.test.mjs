// solution-discipline.test.mjs —— 解析纪律闸（node --test，入 npm test 递归面）。
//
// 三条判据都来自本仓反复犯错、且已被写成文字规则的条目（维护细则 §3.3 / §3.5.1、
// human-first-solution skill）。它们此前只靠「写解析的人自觉 + 双签三签抽查」；
// 本文件把它们变成每次 node --test 都重证一次的断言。
//
// 判据范围与豁免（为什么这么切，别扩大）：
//   · 只查「完整解答」层（`- 完整解答` 折叠层主体，到下一层标记为止）——
//     提示层按设计就是入口判据，复盘层按设计就是对照（提「教材用试探法」再给
//     机械做法是本仓的标准写法，判它就是误伤）。
//   · 题面引用教材图号 ⇒ 图必须画在题面里（:::figure / 内联 SVG / 图片）；
//     题面明说「图缺」的（照「不猜补」走 issue）豁免——那是不猜补原则的合规形态。
//   · 「## 完成边界」主列表 ≤150 字、`已解析` 与 `已验证` 两项在场（维护细则 §3.5.1
//     规矩三）。只对有该节的页面生效；历史页缺节走 issue，不在这里追认。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const COURSES = path.join(ROOT, '课程总览');

if (!existsSync(COURSES)) {
  test('课程总览 不存在（clone 环境）⇒ 本闸无事可查', () => {
    assert.ok(true);
  });
} else {
  walkMd(COURSES).forEach(runFile);
}

function walkMd(dir) {
  const out = [];
  for (const name of readdirSorted(dir)) {
    const p = path.join(dir, name);
    if (statIsDir(p)) out.push(...walkMd(p));
    else if (name.endsWith('.md') && name !== 'index.md') out.push(p);
  }
  return out;
}

function statIsDir(p) {
  try { return statDir(p); } catch { return false; }
}
import { readdirSync, statSync } from 'node:fs';
function readdirSorted(dir) { return readdirSync(dir).sort(); }
function statDir(p) { return statSync(p).isDirectory(); }

// ── ① 反人类解析词：完整解答层禁用 ──────────────────────────────────────────
// 逐条挑而不是一条大正则：各词误伤面不同（「凑」单字会吃掉「凑整」，故带出/来）。
const ANTI_HUMAN = [
  /巧妙/, /容易看出/, /显然可得/, /一眼看出/, /凭感觉/, /灵光一现/,
  /试探/, /凑出|凑出[来去]/, /试[出一]+[组组次下]/,
];

// ── ② 题面引用图号 ⇒ 题面里必须看得见图 ────────────────────────────────────
const FIG_REF = /图\s*\d+[\.．-]\d+/;
const HAS_FIG = /:::figure|<svg|!\[/;
// 接线/波形转写表也算「题面里的图」：图元库还没有 counter 类图元时，本仓的合规
// 写法是把引脚接线（或波形跳变时刻）逐条转写进题面——「**图 X.Y**（…转写…）：」
// 标题行之后、`:::collapse` 之前出现 markdown 表格（紧邻或隔一段说明文字都可，
// 11-02 作业 8.16/8.18、10-26 作业 8.04/8.05 即此形态）——图的信息完整落在
// 题面里，读者不用翻别处。
const HAS_WIRING_TABLE = (stem) => {
  const m = /\*\*图\s*\d+[\.．-]\d+\**[^\n]*转写[^\n]*：/.exec(stem);
  if (!m) return false;
  return /\n\|/.test(stem.slice(m.index));
};
const FIG_MISSING = /图\s*\d+[\.．-]\d+\s*不在|图缺|未加载|不在截图|截图里没有/;

function solutionLayer(text) {
  // `- 完整解答` 起到下一层标记（`- 提示` / `- 复盘` / `- 完整解答`）或收口 `:::`。
  const out = [];
  const re = /- 完整解答\n([\s\S]*?)(?=\n- (?:提示|复盘|完整解答)|\n\s*:::)/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

function stemBlocks(text) {
  // 题面节：`**题面**（逐字）` / `**题面（逐字抄录）` 等带括注的变体所在 `## ` 题块，
  // 截到 `:::collapse`。只认「逐字」系括注——那是题面的正式标记
  // （其余「题面（教师口述）」等是笔记里的叙述，不是可判据的题面节）。
  const out = [];
  for (const part of text.split(/(?=\n## )/)) {
    if (!/\*{0,2}题面\*{0,2}（逐字[抄录）]*|\*{0,2}题面\*{0,2}\(逐字/.test(part)) continue;
    const cut = part.indexOf(':::collapse');
    out.push(cut === -1 ? part : part.slice(0, cut));
  }
  return out;
}

function boundaryMain(text) {
  const m = /## 完成边界\n([\s\S]*?)(?=\n## |\n---\n|$)/.exec(text);
  if (!m) return null;
  const blk = m[1];
  const cuts = [blk.indexOf('### '), blk.indexOf('\n---')].filter((x) => x !== -1);
  return blk.slice(0, Math.min(...(cuts.length ? cuts : [blk.length])));
}

function runFile(f) {
  const rel = path.relative(ROOT, f);
  const text = readFileSync(f, 'utf8');

  test(`解析纪律 · ${rel} · 完整解答层零反人类用语`, () => {
    const bad = [];
    for (const blk of solutionLayer(text)) {
      for (const p of ANTI_HUMAN) {
        const m = p.exec(blk);
        if (m) bad.push(`「${m[0]}」…${blk.slice(Math.max(0, m.index - 30), m.index + 40).replace(/\n/g, ' ')}…`);
      }
    }
    assert.deepEqual(bad, [],
      '完整解答层出现「试探/凑/巧妙看出」类用语 = 没写完（反人类解析禁令）：\n'
      + bad.map((x) => `  ${x}`).join('\n')
      + '\n  处置：按 human-first-solution 的模板改写成机械步骤；对照性提及放复盘层。');
  });

  test(`解析纪律 · ${rel} · 题面引用图号时图必须在题面里`, () => {
    const bad = [];
    for (const stem of stemBlocks(text)) {
      if (!FIG_REF.test(stem)) continue;
      if (HAS_FIG.test(stem)) continue;
      if (HAS_WIRING_TABLE(stem)) continue;   // 接线转写表 = 合规的「图画进题面」形态
      if (FIG_MISSING.test(stem)) continue;   // 「图缺」= 不猜补的合规形态，归 issue
      bad.push(stem.trim().split('\n')[0].slice(0, 60));
    }
    assert.deepEqual(bad, [],
      '这些题面引用了教材图号，但图没画在题面里——只读题面做不了题（2026-10-13 定案）：\n'
      + bad.map((x) => `  ${x}`).join('\n')
      + '\n  处置：图补进题面（:::figure / 内联 SVG）；原图真缺就写明「图缺」并归 issue。');
  });

  test(`解析纪律 · ${rel} · 完成边界 ≤150 字且已解析/已验证在场`, () => {
    const main = boundaryMain(text);
    if (main === null) return;               // 没有该节的页面不归本闸
    const hasParsed = /已解析|已整理/.test(main);
    const hasVerified = /已验证|已独立验算|双签|三签/.test(main);
    const n = main.replace(/^[-*] /gm, '').replace(/\s/g, '').length;
    const probs = [];
    if (n > 150) probs.push(`主列表 ${n} 字 > 150`);
    if (!hasParsed) probs.push('缺「已解析」项');
    if (!hasVerified) probs.push('缺「已验证」项');
    assert.deepEqual(probs, [],
      '完成边界不合口径（维护细则 §3.5.1）：\n  ' + probs.join('；')
      + '\n  处置：压缩到 150 字内，四条固定项各一句；历史页补节或归 issue。');
  });
}
