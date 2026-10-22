/**
 * 锚点反推契约测试（设计文档第 5 步判据）：遍历真实全部页面，
 * 断言「源侧切出的小节标题序列」与产物 `headings` 对齐；不一致报 `section_mismatch`。
 *
 * 实测基线（2026-10-15）：115 页里 **114 页对齐**，唯一例外是符号包页
 * （`站点/符号包/通用.md`——`:::glossary-dict` 围栏内的 `###` 不渲染成标题）。
 * 所以这条测试把「114 对齐 + 1 已知例外」写死：**将来谁改坏了会立刻红**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCatalog, scanHeadings } from '../lib/catalog-source.mjs';
import { TARGET_FILES } from '../../../站点/页面清单.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const DIST = path.join(ROOT, '站点/dist');

/** 已知例外：符号包页（glossary-dict 围栏内的 ### 不渲染成标题）。 */
const KNOWN_EXCEPTIONS = new Set(['站点/符号包/通用.md']);

function loadProductHeadings() {
  const data = JSON.parse(fs.readFileSync(path.join(DIST, 'search/index.json'), 'utf-8'));
  const byPath = new Map();
  for (const doc of data.docs) {
    const rel = doc.url === 'index.html' ? 'README.md' : decodeURIComponent(doc.url).replace(/\.html$/, '.md');
    byPath.set(rel, doc.headings || []);
  }
  return byPath;
}

test('锚点反推：114/115 页源侧标题序列与产物 headings 对齐（1 页已知例外）', () => {
  const catalog = createCatalog({ root: ROOT, targetFiles: TARGET_FILES });
  const byPath = loadProductHeadings();
  const mismatches = [];
  let aligned = 0;
  for (const rel of TARGET_FILES) {
    const prod = byPath.get(rel);
    if (!prod) { mismatches.push(`${rel}: 产物里没有该页`); continue; }
    const chk = catalog.alignCheck(rel, prod);
    if (chk.ok) aligned++;
    else if (!KNOWN_EXCEPTIONS.has(rel)) mismatches.push(`${rel}: src=${chk.srcCount} prod=${chk.prodCount}`);
  }
  assert.deepEqual(mismatches, [], '锚点反推不一致（section_mismatch）：\n' + mismatches.join('\n'));
  assert.equal(aligned, 114, `对齐页数应为 114，实际 ${aligned}`);
});

test('headings() 返回的锚点与产物逐个相同（对齐页）', () => {
  const catalog = createCatalog({ root: ROOT, targetFiles: TARGET_FILES });
  const byPath = loadProductHeadings();
  let checked = 0;
  for (const rel of TARGET_FILES) {
    if (KNOWN_EXCEPTIONS.has(rel)) continue;
    const prod = byPath.get(rel);
    if (!prod) continue;
    const hs = catalog.headings(rel, prod);
    assert.equal(hs.length, prod.length, `${rel} 长度不等`);
    for (let i = 0; i < hs.length; i++) {
      assert.equal(hs[i].a, prod[i].a, `${rel} 第 ${i + 1} 个锚点不等`);
    }
    checked++;
  }
  assert.equal(checked, 114);
});

test('scanHeadings 跳过代码围栏内的 # 与 frontmatter', () => {
  const src = [
    '---',
    'name: 测试',
    '---',
    '',
    '# 页面标题',
    '',
    '```',
    '# 这不是标题',
    '```',
    '',
    '## 真标题',
    '',
    '  ### 缩进的标题（折叠块内）',
    '',
  ].join('\n');
  const hs = scanHeadings(src);
  assert.deepEqual(hs.map((h) => h.title), ['页面标题', '真标题', '缩进的标题（折叠块内）']);
  assert.deepEqual(hs.map((h) => h.level), [1, 2, 3]);
});

test('pages() 的 url 规则与构建期一致（README → index.html）', () => {
  const catalog = createCatalog({ root: ROOT, targetFiles: TARGET_FILES });
  const pages = catalog.pages();
  assert.equal(pages.length, 115);
  assert.equal(pages[0].path, 'README.md');
  assert.equal(pages[0].url, 'index.html');
  assert.equal(pages[1].url, '课程/index.html');
});

test('source() 读不到的页报 unknown_page', () => {
  const catalog = createCatalog({ root: ROOT, targetFiles: TARGET_FILES });
  assert.throws(() => catalog.source('课程/不存在的页.md'), (e) => e.code === 'unknown_page');
});
