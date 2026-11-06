// spa-perpage-json.test.mjs —— SPA 换页必须同步「按页烘焙的 JSON 数据块」。
//
// ## 站长原话（2026-11-06）
//
// 「卧槽不对！原来是符号冒泡会在SPA后失效！」
//
// ## 病因（实测复现过，正反两向都验了）
//
// `#sym-glossary-json`（气泡词典）与 `#figure-index-json`（图元索引）都在
// `<body>` 末尾、`.article-content` **之外**。而 SPA 路由只换 `.article-content`
// 与它周围那几块（TOC、面包屑、chip 条）。
//
// 于是：从首页点进任何一页 —— 词典还是**首页那份**（首页没有符号，0 条）
// ⇒ 新页所有符号的 data-term 键都查不到 ⇒ **点了弹不出气泡**。
// `__glossaryReset()` 只清缓存，清完再读仍是 old DOM 那把 JSON。
//
// 实测数字（习题册第七章）：
//   · 修复前：SPA 后 dictTerms = 0，点 `通用:sym-U` → popup = null
//   · 修复后：SPA 后 dictTerms = 16，点 `通用:sym-U` → 弹出「U：电压…」
//
// ## 为什么静态断言也能守住
//
// 这个缺陷的**代码形状**是可断言的：`spa-router.mjs` 的换页逻辑里必须出现
// 「按 id 换这些 JSON 块」的循环，且 id 清单必须覆盖当前所有 per-page JSON。
// 浏览器行为（点得出泡）由 `工具/符号体检.mjs` 那支 CDP 探针实测，不进 CI。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPA = readFileSync(path.join(HERE, 'spa-router.mjs'), 'utf8');
const DIST = path.join(HERE, '../dist');

test('SPA 换页必须同步 sym-glossary-json（否则换页后符号全不冒泡）', () => {
  assert.match(SPA, /PER_PAGE_JSON_IDS/, 'spa-router 没有 per-page JSON 同步逻辑');
  assert.match(SPA, /"sym-glossary-json"/, 'per-page JSON 清单里缺 sym-glossary-json');
  assert.match(SPA, /"figure-index-json"/, 'per-page JSON 清单里缺 figure-index-json');
  // 必须真的换节点，而不是只清缓存
  assert.match(SPA, /curJson\.replaceWith\(nextJson\)/,
    '没有真的替换节点——只调 __glossaryReset() 清缓存不够（清完再读还是旧 JSON）');
});

test('per-page JSON 清单必须覆盖产物里所有「article 之外」的烘焙块', () => {
  assert.ok(existsSync(DIST), 'dist 不存在——先跑 node build.mjs');
  // 找一页有公式的产物，列出所有 id="*-json" 且在 article 之外的 script
  const sample = path.join(DIST, '课程总览/电路原理/作业/习题册第二章.html');
  assert.ok(existsSync(sample), '缺样本页——先构建');
  const html = readFileSync(sample, 'utf8');
  const a = html.indexOf('<article');
  const b = html.indexOf('</article>');
  const outside = [];
  for (const m of html.matchAll(/<script[^>]*id="([a-z-]+-json)"[^>]*>/g)) {
    if (!(a < m.index && m.index < b)) outside.push(m[1]);
  }
  assert.ok(outside.length > 0, '样本页里没找到 article 之外的 -json 块——切错页了？');

  // 清单覆盖判据：每个 outside 的 id 要么在 PER_PAGE_JSON_IDS 里，要么在
  // 「全局常量」白名单里（nav-structure-json / site-pages-json 是整站一份、
  // 与页面无关，不需要换）。
  const GLOBAL_ONLY = new Set(['nav-structure-json', 'site-pages-json']);
  const listMatch = /PER_PAGE_JSON_IDS = \[([^\]]+)\]/.exec(SPA);
  assert.ok(listMatch, '抓不到 PER_PAGE_JSON_IDS 的定义');
  const listed = new Set([...listMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  const missing = outside.filter((id) => !listed.has(id) && !GLOBAL_ONLY.has(id));
  assert.deepEqual(missing, [],
    '这些按页烘焙的 JSON 块没被 SPA 同步——换页后依赖它们的功会静默失效：\n'
    + missing.map((x) => `  #${x}`).join('\n'))
});
