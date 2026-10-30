// 「完成边界」与「来源气泡」两道篇幅闸门（2026-10-30 站长定案）。
//
// ## 为什么要有
//
// 2026-10-29 定过「完成边界 ≤400 字」，实测 77 页里 71 页超、最长 1,072 字，
// 累计 2.3 万字——读者要的是「这份资料能不能信」，不是施工日志。
// 10-30 再定：**≤150 字**，且 `来源与口径` 一栏整条删除（出处已进 frontmatter 的
// `sources` 气泡，正文再抄一遍是重复）。
//
// 同时 `sources` 本身也收紧到 **≤30 字**——它是页面顶部那颗气泡芯片的文本，
// 写长了会把 chip 撑成一条横幅（实测 303 字那页）。
//
// ## 判据是「形态」不是「字数」
//
// 只数字数会漏掉真正的病：压缩时切在公式或括注中间（`$1.` / `（图 2.7`），
// 页面渲染出半截。所以一并断言 `$`、括号、反引号必须成对。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const COURSES = path.join(ROOT, '课程总览');

const WB_LIMIT = 150;
const SRC_LIMIT = 30;

function walkMd(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walkMd(p, out);
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** 取「## 完成边界」到下一个同级或更高级标题之间的正文。 */
function wbBody(text) {
  const i = text.indexOf('## 完成边界');
  if (i < 0) return null;
  const rest = text.slice(i + '## 完成边界'.length);
  const m = /\n(#{2,3}) /.exec(rest);
  return (m ? rest.slice(0, m.index) : rest).trim();
}

function sourcesOf(text) {
  if (!text.startsWith('---')) return null;
  const fm = text.split('---', 2)[1];
  const m = /^sources:\s*(\[\])?\s*$/m.exec(fm);
  if (!m) return null;
  if (m[1]) return [];
  // 逐行收集：`  - xxx` 与后续缩进续行
  // ⚠️ 只认 `sources:` 之后连续的、以 `  - ` 开头的行。遇到别的顶层键
  // （`tags:` 之类，同样是 `^\w`）立即停——否则会把下一段的列表项吞进来。
  const lines = fm.slice(m.index + m[0].length).split('\n');
  const items = [];
  for (const line of lines) {
    if (/^\s+-\s+/.test(line)) items.push(line.replace(/^\s+-\s+/, '').trim());
    else if (items.length && line.trim() && /^\s{2,}/.test(line)) items[items.length - 1] += line.trim();
    else if (line.trim()) break;   // 顶层键或空行之后的内容都不属于 sources
  }
  return items;
}

test('完成边界：每页主列表 ≤150 字（2026-10-30 定案，原 400）', () => {
  assert.ok(existsSync(COURSES), '课程总览 目录不存在');
  const bad = [];
  for (const f of walkMd(COURSES)) {
    const body = wbBody(readFileSync(f, 'utf8'));
    if (body === null) continue;
    const n = [...body].length;
    if (n > WB_LIMIT) bad.push(`${path.relative(ROOT, f)}: ${n} 字`);
  }
  assert.deepEqual(bad, [],
    `完成边界超 ${WB_LIMIT} 字（压缩只删过程、保留结论）：\n` + bad.join('\n'));
});

test('完成边界：不许再有「来源与口径」一栏（出处归 frontmatter 的 sources）', () => {
  const bad = [];
  for (const f of walkMd(COURSES)) {
    const body = wbBody(readFileSync(f, 'utf8'));
    if (body === null) continue;
    if (/^-\s+\*{0,2}来源与口径/m.test(body)) bad.push(path.relative(ROOT, f));
  }
  assert.deepEqual(bad, [],
    '「来源与口径」已废（2026-10-30）：出处在 sources 气泡与原始资料索引里，正文不重抄：\n' + bad.join('\n'));
});

test('完成边界：压缩不许切在公式/括注中间（$、括号、反引号必须成对）', () => {
  const bad = [];
  for (const f of walkMd(COURSES)) {
    const body = wbBody(readFileSync(f, 'utf8'));
    if (body === null) continue;
    const probs = [];
    if ((body.match(/\$/g) || []).length % 2) probs.push('$ 未配对');
    if ((body.match(/（/g) || []).length !== (body.match(/）/g) || []).length) probs.push('全角括号不配对');
    if ((body.match(/\(/g) || []).length !== (body.match(/\)/g) || []).length) probs.push('半角括号不配对');
    if ((body.match(/`/g) || []).length % 2) probs.push('反引号未配对');
    if (probs.length) bad.push(`${path.relative(ROOT, f)}: ${probs.join(' / ')}`);
  }
  assert.deepEqual(bad, [],
    '压缩把公式或括注切断了（页面上会显示半截），必须退回到安全切口：\n' + bad.join('\n'));
});

test('来源气泡：sources 每条 ≤30 字（它是 chip 文本，写长了撑成横幅）', () => {
  const bad = [];
  for (const f of walkMd(COURSES)) {
    const items = sourcesOf(readFileSync(f, 'utf8'));
    if (!items) continue;
    for (const it of items) {
      if ([...it].length > SRC_LIMIT) bad.push(`${path.relative(ROOT, f)}: ${[...it].length} 字 — ${it.slice(0, 40)}`);
    }
  }
  assert.deepEqual(bad, [],
    `sources 超过 ${SRC_LIMIT} 字：\n` + bad.join('\n'));
});

test('来源气泡：不许把原始文件路径/截图哈希写进 sources（那些归原始资料索引）', () => {
  const bad = [];
  for (const f of walkMd(COURSES)) {
    const items = sourcesOf(readFileSync(f, 'utf8'));
    if (!items) continue;
    for (const it of items) {
      if (/原始资料\/|IMG\d{8}|SHA-?256/i.test(it)) {
        bad.push(`${path.relative(ROOT, f)} — ${it.slice(0, 50)}`);
      }
    }
  }
  assert.deepEqual(bad, [],
    'sources 只写「这是什么 + 在哪一层」，不写文件路径与哈希（登记在原始资料/index.md）：\n' + bad.join('\n'));
});

test('作业页：正文不许再有「## 1. 来源与边界」这种首节（依赖必须是第一节）', () => {
  const bad = [];
  for (const f of walkMd(COURSES)) {
    const text = readFileSync(f, 'utf8');
    if (!/^## 1\.\s*来源与边界/m.test(text)) continue;
    bad.push(path.relative(ROOT, f));
  }
  assert.deepEqual(bad, [],
    '来源与边界一节已废（2026-10-30）：依赖应是第一节，出处归 sources 气泡：\n' + bad.join('\n'));
});
