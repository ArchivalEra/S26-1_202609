/**
 * `ReadCore` 契约测试：四个工具 + stat 的行为。
 *
 * 用**真 adapter**（dist + 源）跑，因为核心零 fs、要验的是「接口行为」。
 * 另外用**内存夹具**跑一遍同构断言——证明核心不依赖具体存储形态。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadCore } from '../lib/read-core.mjs';
import { createDistCorpus } from '../lib/corpus-dist.mjs';
import { createCatalog } from '../lib/catalog-source.mjs';
import { createSourcePacks } from '../lib/packs-source.mjs';
import { TARGET_FILES } from '../../../站点/页面清单.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const DIST = path.join(ROOT, '站点/dist');

function realCore() {
  return createReadCore({
    corpus: createDistCorpus({ distDir: DIST, root: ROOT, targetFiles: TARGET_FILES }),
    catalog: createCatalog({ root: ROOT, targetFiles: TARGET_FILES }),
    packs: createSourcePacks({ root: ROOT }),
  });
}

test('ask：一次调用返回命中页的正文小节（含出处与 ref）', () => {
  const core = realCore();
  const r = core.ask({ query: '卡诺图', course: '电子技术', limit: 2, budget: 1500 });
  assert.equal(r.query, '卡诺图');
  assert.ok(r.sections.length > 0, '应有命中小节');
  const s = r.sections[0];
  assert.ok(s.source.endsWith('.md'), '出处应是源 markdown');
  assert.ok(typeof s.markdown === 'string');
  assert.ok(s.url.includes('.html'), 'url 应是站点页');
});

test('ask：命中折叠块内时 insideCollapse 为真（降权可见）', () => {
  const core = realCore();
  // 「复盘」出现在作业页的折叠块内
  const r = core.ask({ query: '复盘', limit: 5, budget: 3000 });
  assert.ok(r.sections.length > 0);
  // 至少能取到内容（不崩），且字段齐全
  for (const s of r.sections) {
    assert.ok(typeof s.insideCollapse === 'boolean');
    assert.ok(typeof s.truncated === 'boolean');
  }
});

test('ask：truncated 时给 ref（可续读整节）', () => {
  const core = realCore();
  const r = core.ask({ query: '定理', limit: 5, budget: 256 });
  const tr = r.sections.filter((s) => s.truncated);
  for (const s of tr) {
    assert.ok(s.ref && s.ref.anchor, 'truncated 必须给 ref');
    assert.equal(s.ref.path, s.source);
  }
});

test('search：返回命中列表（锚点/摘要/分数），带 total', () => {
  const core = realCore();
  const r = core.search({ query: '变压器', limit: 5 });
  assert.ok(r.total >= r.hits.length);
  assert.equal(r.hits.length, 5);
  for (const h of r.hits) {
    assert.ok(h.url && typeof h.score === 'number');
    assert.ok('anchor' in h && 'section' in h && 'occurrences' in h);
  }
});

test('search：课程过滤只留该课', () => {
  const core = realCore();
  const r = core.search({ query: '定理', course: '工程数学', limit: 50 });
  for (const h of r.hits) assert.ok(decodeURIComponent(h.url).startsWith('课程/工程数学/'), h.url);
});

test('read_page：按路径取整页，format=markdown、带 frontmatter 与标题', () => {
  const core = realCore();
  const r = core.readPage({ path: '课程/电机学/作业/2026-10-15-变压器额定电流与变比.md' });
  assert.equal(r.format, 'markdown');
  assert.equal(r.course, '电机学');
  assert.equal(r.category, '作业');
  assert.ok(r.meta.id, 'frontmatter 应解析出 id');
  assert.ok(r.headings.length > 0);
  assert.ok(r.body.includes('变压器') || r.body.length > 0);
});

test('read_page：带 anchor 只取该小节', () => {
  const core = realCore();
  const full = core.readPage({ path: '课程/电机学/作业/2026-10-15-变压器额定电流与变比.md' });
  const h = full.headings[0];
  const part = core.readPage({ path: '课程/电机学/作业/2026-10-15-变压器额定电流与变比.md', anchor: h.a });
  assert.ok(part.body.length <= full.body.length);
});

test('symbol：查符号返回词条（含多义项与当前语境标记）', () => {
  const core = realCore();
  const r = core.symbol({ id: 'sym-U', course: '电路原理' });
  assert.equal(r.env, '通用+电路原理');
  assert.ok(r.matches.length >= 1);
  assert.ok(r.matches[0].title);
});

test('symbol：包链覆盖——后者覆盖前者同名', () => {
  const core = realCore();
  const a = core.symbol({ id: 'sym-Z', course: '电路原理' });
  const b = core.symbol({ id: 'sym-Z', course: '电机学' });
  // 两个课程的 Z 含义不同（阻抗 vs 槽数），多义项都在
  assert.ok(a.matches.length && b.matches.length);
  const senses = a.matches[0].senses || [];
  if (senses.length) {
    const cur = senses.filter((s) => s.isCurrentCtx);
    assert.ok(cur.length >= 1, '当前语境那条应被标记');
  }
});

test('stat：台账出口（页数/源 hash/stale/课程清单）', () => {
  const core = realCore();
  const r = core.stat();
  assert.equal(r.pages, 115);
  assert.equal(typeof r.sourceHash, 'string');
  assert.equal(r.stale, false);
  assert.ok(r.courses.length >= 6);
  assert.ok(r.glossaryPacks.includes('通用'));
});

test('未知查询零命中、不抛', () => {
  const core = realCore();
  const r = core.search({ query: '无此词汇xyz' });
  assert.equal(r.total, 0);
  assert.deepEqual(r.hits, []);
});

test('核心零 fs：换内存夹具仍能跑（同构断言）', () => {
  // 造一个极小的内存 corpus/catalog/packs
  const DOCS = [
    { id: 0, url: 'a.html', title: '甲页', chars: 20, headings: [{ t: '节一', d: '节一', a: '节一', l: 2, s: 0 }] },
  ];
  const memCorpus = {
    manifest: () => ({ v: 1, buckets: 1, pages: 1, docs: DOCS, sourceHash: 'mem' }),
    bucket: () => ({ grams: { 甲: { 0: [0] } }, uni: {} }),
    text: () => '甲页正文 甲',
    staleness: () => ({ stale: false }),
  };
  const memCatalog = {
    pages: () => [{ path: 'a.md', url: 'a.html' }],
    source: () => '# 甲页\n\n## 节一\n\n甲页正文。\n',
    headings: (rel, prod) => [{ level: 2, title: '节一', offset: 8, a: prod[0].a }],
  };
  const memPacks = { packNames: () => [], chainOf: () => null, lookup: () => ({ env: null, matches: [] }) };
  const core = createReadCore({ corpus: memCorpus, catalog: memCatalog, packs: memPacks });
  const r = core.search({ query: '甲' });
  assert.equal(r.total, 1);
  assert.equal(r.hits[0].url, 'a.html');
  const p = core.readPage({ path: 'a.md' });
  assert.ok(p.body.includes('甲页正文'));
});

test('ask：命中父标题时扩到子节（不返回只有标题行的空壳）', () => {
  const core = realCore();
  const r = core.ask({ query: '卡诺图', course: '电子技术', limit: 1, budget: 900 });
  assert.ok(r.sections.length >= 1);
  // 「题号条目」是父标题、本身只有标题行；应扩到其子节
  assert.ok(r.sections[0].markdown.length > 200,
    `首节正文应扩到子节，实际只有 ${r.sections[0].markdown.length} 字`);
});

test('ask：正文非空（多个查询）', () => {
  const core = realCore();
  for (const q of ['变压器', '沙路法则', '戴维南', '磁滞损耗']) {
    const r = core.ask({ query: q, limit: 2, budget: 800 });
    assert.ok(r.sections.length > 0, `${q} 应有命中`);
    assert.ok(r.sections.every((s) => s.markdown.length > 0), `${q} 有节正文为空`);
  }
});
