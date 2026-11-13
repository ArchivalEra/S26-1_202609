// 全站站内链接可达性闸门（2026-10-30，体检抓到 64 处死链）。
//
// ## 为什么需要这一条
//
// 钩子里的 `check-markdown` 只查**源 md 里的相对路径是否指向存在的源文件**，
// 而站点产物是另一套路径（`.md → 网址`、`模板/` 与 `.txt` 不发布）。
// 源文件都在 ⇒ 闸门是绿的，产物里却可能指向不存在的目标 —— 线上就是 404。
// 只有对 `dist/` 做可达性扫描才看得见。
//
// 2026-10-30 抓到的三类（都已修）：
//   ① `*-原文.txt`（课堂转写底稿）与 `AGENTS.md` / `.agents/**`（内部规程）
//      在仓库里、但不随站点发布 ⇒ 降级成纯文本说明，不再出 `<a href>`；
//   ② 模板链接的正则写成 `[^]]*`（应为 `[^\]]*`），**从来没匹配成功过**，
//      于是 `../模板/*.md` 一路被换成 `.html` 后指向不存在的文件；
//   ③ 索引页 `index.html` 形态（已由 nav-structure.test.mjs 单独守）。
//
// 判据：产物里每个站内 `href`，剥掉 `#锚点` 与 `?查询串` 后，目标文件必须存在。

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

test('产物里每个站内链接都指向真实存在的文件', () => {
  assert.ok(existsSync(DIST), 'dist 不存在——先跑 node build.mjs');
  const bad = [];
  for (const file of walkHtml(DIST)) {
    const s = readFileSync(file, 'utf8');
    for (const m of s.matchAll(/href="([^"]+)"/g)) {
      const href = m[1];
      if (/^(https?:)?\/\//.test(href) || href.startsWith('#') || href.startsWith('mailto:')) continue;
      const bare = href.split('#')[0].split('?')[0];
      if (!bare) continue;
      const tgt = path.normalize(path.join(path.dirname(file), decodeURIComponent(bare)));
      if (!existsSync(tgt)) {
        bad.push(`${path.relative(DIST, file)} → ${href}`);
      }
    }
  }
  const uniq = [...new Set(bad)];
  assert.deepEqual(uniq, [], `这些站内链接目标不存在（线上会 404）：\n${uniq.slice(0, 20).join('\n')}`);
});

test('不发布的文件不许以 <a href> 形式出现在产物里', () => {
  // 转写底稿与内部规程是**刻意不发布**的；它们只能以降级说明出现。
  // 这条比上面的泛化检查更早报出根因（「有人又把它写成链接了」）。
  const bad = [];
  for (const file of walkHtml(DIST)) {
    const s = readFileSync(file, 'utf8');
    for (const m of s.matchAll(/href="([^"]+)"/g)) {
      const href = m[1];
      if (/(\.txt)$/i.test(href.split('#')[0].split('?')[0])) {
        bad.push(`${path.relative(DIST, file)} → ${href}（.txt 转写底稿不发布）`);
      }
      if (/(?:^|\/)(?:AGENTS\.md|\.agents\/)/.test(href)) {
        bad.push(`${path.relative(DIST, file)} → ${href}（内部规程不发布）`);
      }
      if (/模板\//.test(decodeURIComponent(href))) {
        bad.push(`${path.relative(DIST, file)} → ${href}（模板不发布）`);
      }
    }
  }
  const uniq = [...new Set(bad)];
  assert.deepEqual(uniq, [], `这些不发布的文件被写成了链接：\n${uniq.slice(0, 12).join('\n')}`);
});

// machine/Birthright.json 格式**不变**（base + example + pages 平铺数组），
// 但 pages 条目多一个 meta 字段 → machine/pages/<n>.json（每页的结构数据：
// 公式 TeX 源 + 配图）。对方 agent 读不到 KaTeX 排版后的 TeX，meta 补这一块；
// 正文仍以 fetch 对应 HTML 为准——meta 不收页面内容，只收「HTML 里看不见源码」的。
// 判据：① pages 覆盖 = 全站页面清单（不重不漏）且每条落到真实文件；
//       ② meta 文件与 HTML 抽样一致（公式 TeX 数、图 src/alt）；
//       ③ example 指向的 meta 必须存在且 url 对得上。
test('machine/Birthright.json：pages 覆盖全站，meta 结构数据与产物一致', () => {
  const catFile = path.join(DIST, 'machine', 'Birthright.json');
  assert.ok(existsSync(catFile), 'Birthright.json 不存在——先跑 node build.mjs');
  const cat = JSON.parse(readFileSync(catFile, 'utf8'));
  assert.ok(cat.base.startsWith('https://') && cat.base.endsWith('/'));
  assert.ok(Array.isArray(cat.pages) && cat.pages.length > 0, 'pages 不能为空');
  assert.ok(cat.example?.meta && cat.example?.path, 'example 必须带 path + meta');

  // ① 覆盖：pages.path（targetHtmlPath 形态）归一到网址形态后 = 页面清单。
  const normalize = (p) => (p === 'index.html' ? ''
    : (p.endsWith('/index.html') ? p.slice(0, -'index.html'.length) : p));
  const covered = new Set(cat.pages.map((p) => normalize(p.path)));
  const sitePages = JSON.parse(
    readFileSync(path.join(DIST, 'index.html'), 'utf8')
      .match(/id="site-pages-json">(.*?)<\/script>/s)[1],
  );
  assert.equal(covered.size, sitePages.length,
    `覆盖数不符：${covered.size} vs 全站 ${sitePages.length}；`
    + `缺：${sitePages.filter((p) => !covered.has(p)).slice(0, 5)} `
    + `多：${[...covered].filter((p) => !sitePages.includes(p)).slice(0, 5)}`);
  const missing = cat.pages.filter((p) => !existsSync(path.join(DIST, p.path)));
  assert.deepEqual(missing, [], `pages 里这些文件线上会 404：\n${missing.slice(0, 8).map((p) => p.path).join('\n')}`);

  // ② meta 抽样：每个 meta 文件必须存在；抽公式最多的一页与产物 HTML 对照。
  for (const p of cat.pages) {
    assert.ok(existsSync(path.join(DIST, 'machine', p.meta)), `缺 meta 文件：${p.meta}`);
  }
  let richest = null; let richestN = -1;
  for (const p of cat.pages) {
    const meta = JSON.parse(readFileSync(path.join(DIST, 'machine', p.meta), 'utf8'));
    assert.equal(meta.url, p.path, `meta.url 与 pages.path 不一致：${p.meta}`);
    const n = (meta.math?.length || 0) + (meta.figures?.length || 0);
    if (n > richestN) { richestN = n; richest = { p, meta }; }
  }
  assert.ok(richestN > 100, `结构数据太少（最多 ${richestN} 条），收集逻辑可能坏了`);
  const { p: richPage, meta } = richest;
  const built = readFileSync(path.join(DIST, richPage.path), 'utf8');
  for (const f of meta.figures || []) {
    assert.ok(built.includes(f.src), `${richPage.path} 产物里没有 ${f.src}`);
    assert.ok(built.includes(f.alt.slice(0, 12)), 'alt 必须与产物 HTML 一致');
  }
  // 公式 TeX：meta 里的 tex 源在产物里只以 KaTeX 排版出现，反查「产物里的
  // katex-display 公式个数 ≥ meta 记录的 display 公式数」作粗校。
  const katexCount = (built.match(/class="katex-display"/g) || []).length;
  const displayCount = (meta.math || []).filter((m) => m.display).length;
  assert.ok(katexCount >= displayCount,
    `${richPage.path}：产物块级公式 ${katexCount} < meta 记录的 ${displayCount}`);

  // ③ example 指向的 meta 必须真的存在、url 对得上。
  const exMeta = JSON.parse(readFileSync(path.join(DIST, 'machine', cat.example.meta), 'utf8'));
  assert.equal(exMeta.url, cat.example.path, 'example.meta 指向的页面 url 不对');
  assert.ok((exMeta.math?.length || 0) + (exMeta.figures?.length || 0) > 0,
    'example 指向的页必须是带结构数据的（空页没得学）');
});
