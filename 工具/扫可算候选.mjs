// 扫出候选可算公式（给子代理审核用，不是最终判定）。
//
// 为什么需要这个：手动标记的判据是「这条公式**是一个可求值的量**」，
// 不是「转译器能不能过」。但光看公式不好判断，所以这里把
// 「公式原文 + 转译产物」并排列出来，让审的人一眼看出产物是否荒谬。
//
// 用法：node 工具/扫可算候选.mjs <md 路径...>
// 输出：每条 display 公式一行（TSV），字段：行号 · 公式 · 产物 · 提示

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { translate } = await import(path.join(ROOT, '站点/math/to-octave.mjs'));
const { parse } = await import(path.join(ROOT, '站点/math/parser.mjs'));

const files = process.argv.slice(2);
if (!files.length) {
  console.error('用法：node 工具/扫可算候选.mjs <md路径...>');
  process.exit(2);
}

for (const rel of files) {
  const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  const src = fs.readFileSync(abs, 'utf8');
  const lines = src.split('\n');
  // 逐行找 $$…$$（含跨行块：从开 $$ 到下一个 $$）
  let buf = '';
  let startLine = 0;
  let i = 0;
  let inBlock = false;
  for (const line of lines) {
    i += 1;
    if (!inBlock && line.includes('$$')) {
      const a = line.indexOf('$$');
      const b = line.indexOf('$$', a + 2);
      if (b >= 0) {
        // 单行内的 $$…$$
        const tex = line.slice(a + 2, b).trim();
        report(i, tex, line.includes('{:calc}'));
        continue;
      }
      inBlock = true; buf = line.slice(a + 2); startLine = i;
      continue;
    }
    if (inBlock) {
      const b = line.indexOf('$$');
      if (b >= 0) {
        buf += '\n' + line.slice(0, b);
        inBlock = false;
        report(startLine, buf.trim(), line.includes('{:calc}'));
        buf = '';
      } else {
        buf += '\n' + line;
      }
    }
  }
}

function report(line, tex, marked) {
  if (!tex) return;
  // ⚠️ 与 build.mjs 一致：显示公式末尾的**一个**句末标点会先被剥掉
  // （教材排版惯例把标点写进公式，网页上独立成块后会多出一个点）。
  // 扫描器必须同口径，否则会误报「不认识的符号『.』」——实测踩到。
  const src = tex.trim().replace(/[.。，、；;][ \t]*$/, '');
  let out;
  try {
    const r = translate(parse(src).expr.root);
    out = r.ok ? r.code : '✖ ' + r.reason;
  } catch (e) {
    out = '✖ 抛错 ' + e.message;
  }
  const flag = marked ? '[已标]' : '';
  console.log(`${line}\t${oneLine(src)}\t${oneLine(out)}\t${flag}`);
}

function oneLine(s) {
  return String(s).replace(/\s+/g, ' ').replace(/\t/g, ' ').trim();
}
