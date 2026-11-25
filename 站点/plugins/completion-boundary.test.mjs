// 「完成边界」唯一产地门禁 + 「来源气泡」篇幅门禁（2026-11-25 收敛定案）。
//
// 为什么只允许写单一 issue 指针：
//   缺件、是否双签、是否三签的真实状态只住 GitHub Issue；
//   以前在完成边界里抄一遍「缺 SVG / 挂 issue #31 / 尚未双签」，issue 结案后页面就腐烂成第二产地。
//   现在正文 ## 完成边界 只留一个 issue 指针，构建期按 issue 开闭态自动显隐（已关则整节移除）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBoundaryPointer, extractBoundaryIssueNumber, stripClosedBoundary } from './issue-status.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const COURSES = path.join(ROOT, '课程总览');

const SRC_LIMIT = 30;

function walkMd(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walkMd(p, out);
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** 取「## 完成边界」到下一个同级标题（或文件末尾）之间的完整片段。 */
function wbSection(text) {
  const m = /(?:^|\n)## 完成边界[ \t]*\n([\s\S]*?)(?=\n## |\n---\n|$)/.exec(text);
  return m ? m[1] : null;
}

function sourcesOf(text) {
  if (!text.startsWith('---')) return null;
  const fm = text.split('---', 2)[1];
  const m = /^sources:\s*(\[\])?\s*$/m.exec(fm);
  if (!m) return null;
  if (m[1]) return [];
  const lines = fm.slice(m.index + m[0].length).split('\n');
  const items = [];
  for (const line of lines) {
    if (/^\s+-\s+/.test(line)) items.push(line.replace(/^\s+-\s+/, '').trim());
    else if (items.length && line.trim() && /^\s{2,}/.test(line)) items[items.length - 1] += line.trim();
    else if (line.trim()) break;
  }
  return items;
}

test('完成边界：仅允许单一 issue 指针，严禁写缺件/双签/已解析等第二产地文本', () => {
  assert.ok(existsSync(COURSES), '课程总览 目录不存在');
  const bad = [];
  for (const f of walkMd(COURSES)) {
    const text = readFileSync(f, 'utf8');
    const sec = wbSection(text);
    if (sec === null) continue;
    const rel = path.relative(ROOT, f);
    if (/^###\s+/m.test(sec)) {
      bad.push(`${rel}: 完成边界下禁止 ### 子节（双签/三签统一归 GitHub Issue 追踪）`);
      continue;
    }
    const afterWb = text.slice(text.indexOf('## 完成边界') + '## 完成边界'.length);
    if (/\n##\s+/.test(afterWb)) {
      bad.push(`${rel}: 完成边界必须居末（后面还有 ## 节）`);
      continue;
    }
    const parsed = parseBoundaryPointer(sec);
    if (!parsed.ok) bad.push(`${rel}: ${parsed.reason}`);
  }
  for (const f of walkMd(COURSES)) {
    const text = readFileSync(f, 'utf8');
    if (/^##\s+(?:双签|三签)/m.test(text)) {
      bad.push(`${path.relative(ROOT, f)}: 禁止单独成节 ## 双签 / ## 三签（统一归 GitHub Issue 追踪）`);
    }
  }
  assert.deepEqual(bad, [],
    '完成边界违规（仅允许唯一一行 issue #N 或 GitHub issue 超链接）：\n' + bad.join('\n'));
});

test('完成边界：构建期按 issue 开闭态自动显隐（OPEN 保留，CLOSED 整节移除）', () => {
  const sample = '# 页\n\n## 正文\n\n内容。\n\n## 完成边界\n\n- [issue #40](https://github.com/ArchivalEra/S26-1_202609/issues/40)\n';
  assert.equal(extractBoundaryIssueNumber(sample), 40);
  const kept = stripClosedBoundary(sample, new Map([[40, 'OPEN']]));
  assert.ok(kept.includes('## 完成边界'), 'OPEN 的 issue 必须保留完成边界');
  const hidden = stripClosedBoundary(sample, new Map([[40, 'CLOSED']]));
  assert.ok(!hidden.includes('## 完成边界') && !hidden.includes('#40'), 'CLOSED 的 issue 必须整节隐去');
  assert.ok(hidden.includes('## 正文'), '正文必须保留');
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
