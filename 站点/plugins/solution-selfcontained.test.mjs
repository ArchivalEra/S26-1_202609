// solution-selfcontained.test.mjs —— 作业页「完整解答」必须自足（2026-11-06 站长定案）。
//
// ## 站长原话与背景
//
// 「每道题还是得出完整做法放到完整解答里的，只是顺便说一句技法库已收录。
//   现在作业2、3都是看解答完全做不了，还必须跳到技法库那一页，
//   我现在我觉得这是违反三签的，看依赖能做但是看解答不会的奇怪现象」
//
// 三签 skill 的「可复现」判据原文：「读者只拿题面 + 依赖，照这个解答走一遍，
// 能不能得到同样的结果？」——解答里写着「照库条目走，完整演算见 [库条目]」，
// 读者就**做不出来**：解答不是答案的载体，只是答案的目录。
//
// ## 判据（机器可查，不靠人眼）
//
// 作业页的「完整解答」层里若出现下列**把步骤推给别的页面**的句式 ⇒ 报红：
//
//   ① 「照…条目走 / 照…条目四步走 / 照条目逐段走」——步骤在别处；
//   ② 「完整演算见」「完整步骤见」「详见」「见 [库条目]」——把演算推到别处；
//   ③ 「按技法库条目：」后紧跟列表（= 步骤是引来的）。
//
// **允许**的（不算违规）：
//   · 依赖表里指向技法库/教材解析的行——依赖表说「这题用哪种方法」是合法的；
//   · 解答层末尾的旁注「技法库已收录此题型，见 …」——**旁注是补充，不是唯一来源**；
//   · 「提示」与「复盘」层里提技法库——提示本来就是入口判据。
//
// 为什么只查「完整解答」层：提示层按设计就是入口判据（「本题落在某条目，照条目走」），
// 复盘层是回顾。**只有解答层必须自带全部步骤**——它是学生做完题后核对的那份。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const COURSES = path.join(ROOT, '课程总览');

function walkMd(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walkMd(p, out);
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** 取每个「- 完整解答」块（到下一个「- 提示/- 复盘」或折叠结束）。 */
export function solutionBlocks(text) {
  const out = [];
  const re = /^- 完整解答\s*\n([\s\S]*?)(?=\n- (?:提示|复盘)|^\n:::|\Z)/gm;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

/**
 * 剥掉「技法库已收录」旁注：形如
 *   （该题型技法库已收录，见[条目](../技法库.md#x)。）
 * 它是**补充**，不是步骤来源，剥掉后判据才不会误放过紧随其后的「照条目走」。
 * 只剥含「已收录」的括号整句，别的括号说明不动。
 */
export function stripCollectionNotes(text) {
  return text.replace(/[（(][^）)]*已收录[^）)]*[）)]/g, '');
}

/**
 * 把步骤推给别的页面的句式。
 *
 * 逐条挑而不是一条大正则：这些句子各有各的形态（有的带链接、有的不带、
 * 有的中英混排），一条正则要么漏要么误伤。判据是「句子里出现这些说法」。
 */
const DELEGATE_PATTERNS = [
  { re: /照[^。\n]{0,12}条目[^。\n]{0,6}走/, why: '「照…条目走」＝步骤在别处' },
  { re: /完整(?:演算|计算|步骤|过程|做法)[^。\n]{0,8}(?:见|在)[^。\n]{0,12}/, why: '「完整演算见…」＝把演算推到别处' },
  { re: /详见[^。\n]{0,10}\[|见\s*\[[^\]]+\]\([^)]*技法库/, why: '「详见/见…」＝指向别处承载步骤' },
  { re: /按[^。\n]{0,10}条目[:：]/, why: '「按…条目：」后面接的步骤是引来的' },
];

test('解答自足：完整解答层不许把步骤推给别的页面', () => {
  assert.ok(existsSync(COURSES), '课程总览 目录不存在');
  const bad = [];
  for (const f of walkMd(COURSES)) {
    if (f.endsWith('index.md')) continue;
    const text = readFileSync(f, 'utf8');
    if (!text.includes('完整解答')) continue;
    const blocks = solutionBlocks(text);
    blocks.forEach((raw, i) => {
      // 「已收录」旁注不算步骤来源：先剥掉，再查有没有把步骤推走的句子。
      const b = stripCollectionNotes(raw);
      for (const { re, why } of DELEGATE_PATTERNS) {
        const m = re.exec(b);
        if (!m) continue;
        bad.push(`${path.relative(ROOT, f)} · 第 ${i + 1} 个解答块 · ${why}：「${m[0].trim().slice(0, 40)}」`);
      }
    });
  }
  assert.deepEqual(bad, [],
    '这些解答把步骤推给了别的页面——读者只看作业页做不出来（违反三签「可复现」）：\n'
    + bad.map((x) => `  ${x}`).join('\n')
    + '\n  处置：把步骤补回本页的完整解答层；技法库只留一句「已收录」的旁注。');
});

test('解答自足：变异自证——推走句必须被抓到，旁注必须被放过', () => {
  // 「已收录」旁注单独出现 ⇒ 通过（它是补充，不是步骤来源）。
  const ok = stripCollectionNotes('按功能表逐段走。（该题型技法库已收录，见[条目](../技法库.md#x)。）');
  assert.equal(DELEGATE_PATTERNS.some(({ re }) => re.test(ok)), false,
    '旁注不该被判成违规');
  // 把步骤推走 ⇒ 必须被抓到（旁注紧随其后也不能放过）。
  const bad = '照库条目走。完整演算见 [库条目](../技法库.md#m-rowreduce-inv)。（技法库已收录。）';
  assert.ok(DELEGATE_PATTERNS.some(({ re }) => re.test(stripCollectionNotes(bad))),
    '「照库条目走/完整演算见」必须报红——纸糊的闸门等于没有');
});
