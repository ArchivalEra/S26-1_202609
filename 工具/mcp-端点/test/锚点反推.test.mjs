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
  // 2026-10-31 修：原写死 114。页面清单长到 140 后这条断言红得毫无信息量
  // （只说明「测试抄了旧数字」，不说明代码坏）。改成「等于可对齐的页数」——
  // 即 TARGET_FILES 里排除了已知例外、且产物里真有该页的那些。
  const expectedAligned = TARGET_FILES.filter(
    (rel) => !KNOWN_EXCEPTIONS.has(rel) && byPath.has(rel)).length;
  assert.equal(aligned, expectedAligned,
    `对齐页数应为 ${expectedAligned}（清单 ${TARGET_FILES.length} 页减已知例外与缺产物），实际 ${aligned}`);
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
  assert.equal(checked, TARGET_FILES.filter((rel) => !KNOWN_EXCEPTIONS.has(rel)).length,
    '逐页核过一遍（清单减已知例外）');
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

test('pages() 的 url 规则与构建期一致（首页 → 空串、目录页 → 目录/）', () => {
  // ⚠️ 2026-10-31 改：这条原本断言 `README → index.html`、`课程总览/index.md → 课程总览/index.html`。
  // 那是**旧规则**。构建期已统一到 htmlPathOf：首页网址是空串 `''`（站点根），
  // 目录索引页是 `目录/`（不带 index.html）。读层现在直接 import 那个函数，
  // 所以这条断言的对象也换成**新规则**——否则它会逼读层保留一个读者点不开的 url。
  const catalog = createCatalog({ root: ROOT, targetFiles: TARGET_FILES });
  const pages = catalog.pages();
  assert.equal(pages.length, TARGET_FILES.length, '页数 = 页面清单条数');
  assert.equal(pages[0].path, 'README.md');
  assert.equal(pages[0].url, '', '首页的网址是站点根（空串），不是 index.html');
  const idx = pages.find((p) => p.path === '课程总览/index.md');
  assert.ok(idx, '清单里应有课程总览索引页');
  assert.equal(idx.url, '课程总览/', '目录索引页的网址是 `目录/`，不写 index.html');
  // 普通页仍是 .html
  const normal = pages.find((p) => p.path.endsWith('.md') && !p.path.endsWith('index.md')
    && p.path !== 'README.md');
  assert.ok(normal && normal.url.endsWith('.html'), '普通页的网址以 .html 结尾');
});

test('source() 读不到的页报 unknown_page', () => {
  const catalog = createCatalog({ root: ROOT, targetFiles: TARGET_FILES });
  assert.throws(() => catalog.source('课程/不存在的页.md'), (e) => e.code === 'unknown_page');
});
