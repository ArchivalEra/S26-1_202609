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

// machine/Birthright.html 是全站目录的**唯一载体**（2026-11-12 站长裁定：
// 不要 JSON、不要花哨渲染，越小越好）。每个条目都是拼好的完整绝对网址——
// 人点了就走，webfetch 模型抓这一页就能走到全站任何一页。
// 一条 404 链接 = 照着走的模型撞墙且无从发现，所以判据直接对着 dist 产物核。
test('machine/Birthright.html：每条链接都指向真实存在的页面，且覆盖全站', () => {
  const htmlFile = path.join(DIST, 'machine', 'Birthright.html');
  assert.ok(existsSync(htmlFile), 'Birthright.html 不存在——先跑 node build.mjs');
  const html = readFileSync(htmlFile, 'utf8');
  assert.ok(/<title>Birthright<\/title>/.test(html),
    '<title> 必须是 Birthright（浏览器标签页显示的就是它）');

  // 页面里所有站内 href（都在 base 之后），逐条解析回相对路径。
  const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])
    .filter((u) => u.startsWith('https://isui.ren/repo/S26-1_202609/'));
  assert.ok(links.length > 100, `目录链接太少（${links.length}），构建可能坏了`);
  const rels = links.map((u) => decodeURIComponent(
    u.slice('https://isui.ren/repo/S26-1_202609/'.length)));

  // 每条链接都落到真实产物：目录形态（末尾 /）落 index.html。
  const missing = rels.filter((p) => {
    const rel = p === '' ? 'index.html' : (p.endsWith('/') ? p + 'index.html' : p);
    return !existsSync(path.join(DIST, rel));
  });
  assert.deepEqual(missing, [], `Birthright 里这些链接线上会 404：\n${missing.slice(0, 12).join('\n')}`);

  // 覆盖数 = 全站页面清单（site-pages-json），不重不漏。
  const sitePages = JSON.parse(
    readFileSync(path.join(DIST, 'index.html'), 'utf8')
      .match(/id="site-pages-json">(.*?)<\/script>/s)[1],
  );
  assert.equal(new Set(rels).size, sitePages.length,
    `覆盖数不符：Birthright ${new Set(rels).size} vs site-pages ${sitePages.length}；`
    + `缺：${sitePages.filter((p) => !new Set(rels).has(p)).slice(0, 5)} 多：${[...new Set(rels)].filter((p) => !sitePages.includes(p)).slice(0, 5)}`);
});
