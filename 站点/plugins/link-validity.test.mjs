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

// machine/Birthright.txt 是全站目录（括号树压缩格式，2026-11-12）：
//   A(B,C) ⇒ A/ 与 A/B 与 A/C ；A[B,C] ⇒ 只 A/B 与 A/C ；非 / 结尾补 .html
// 它是给「只有 webfetch」的模型用的唯一索引：一条还原不出来 = 照着走就 404，
// 而它无从发现。所以判据是**独立反向解析**：还原的 URL 集合必须与全站页面清单
// 完全相等，且每条都落到 dist 里的真实文件。
test('machine/Birthright.txt：括号树能无损还原全站且每条都真实存在', () => {
  const file = path.join(DIST, 'machine', 'Birthright.txt');
  assert.ok(existsSync(file), 'Birthright.txt 不存在——先跑 node build.mjs');
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
  // 结构：规则行 + 树行 + 空行 + 题外话（给读不懂规则的来访者）。
  assert.ok(lines.length >= 3, '至少要有「规则行 + 树行 + 题外话」');
  assert.ok(/A\(B,C\)/.test(lines[0]) && /A\[B,C\]/.test(lines[0]),
    '首行必须是自解释的压缩规则');
  const tree = lines[1];
  assert.ok(tree.startsWith('https://'), '第二行是整棵树，必须以 base 开头');

  // 解析器刻意不复用构建里的实现——用一份独立写法，才验得出「树本身对不对」。
  // 树行以完整 base 开头（根节点自身就是首页）；剥掉它再按相对路径判。
  const base = 'https://isui.ren/repo/S26-1_202609/';
  const out = [];
  const parse = (s, prefix) => {
    const items = []; let depth = 0; let start = 0;
    for (let i = 0; i < s.length; i += 1) {
      const c = s[i];
      if (c === '(' || c === '[') depth += 1;
      else if (c === ')' || c === ']') depth -= 1;
      else if (c === ',' && depth === 0) { items.push(s.slice(start, i)); start = i + 1; }
    }
    items.push(s.slice(start));
    for (const item of items) {
      const i1 = item.indexOf('('); const i2 = item.indexOf('[');
      const idx = i1 === -1 ? i2 : (i2 === -1 ? i1 : Math.min(i1, i2));
      const path = prefix + (idx === -1 ? item : item.slice(0, idx));
      if (idx === -1) { out.push(path.endsWith('/') ? path : `${path}.html`); continue; }
      if (item[idx] === '(') out.push(`${path}/`);   // A(...) 自身也是页面
      parse(item.slice(idx + 1, -1), `${path}/`);
    }
  };
  parse(tree, '');

  const restored = new Set(out.map((u) => (u.startsWith(base) ? u.slice(base.length) : u)));
  const sitePages = JSON.parse(
    readFileSync(path.join(DIST, 'index.html'), 'utf8')
      .match(/id="site-pages-json">(.*?)<\/script>/s)[1],
  );
  assert.equal(restored.size, sitePages.length,
    `还原数不符：${restored.size} vs 全站 ${sitePages.length}；`
    + `缺：${sitePages.filter((p) => !restored.has(p)).slice(0, 5)} `
    + `多：${[...restored].filter((p) => !sitePages.includes(p)).slice(0, 5)}`);

  // 每条还原出的路径都落到真实产物：目录形态（末尾 /）落 index.html。
  const missing = [...restored].filter((p) => {
    const rel = p === '' ? 'index.html' : (p.endsWith('/') ? p + 'index.html' : p);
    return !existsSync(path.join(DIST, rel));
  });
  assert.deepEqual(missing, [], `Birthright 里这些路径线上会 404：\n${missing.slice(0, 12).join('\n')}`);

  // 题外话里的示范网址必须是真页面——给来访者指错路比不给例子更糟。
  const guide = lines.slice(2).join('\n');
  const demo = guide.match(/https:\/\/\S+/g) || [];
  assert.ok(demo.length > 0, '题外话必须给至少一条现成示范网址');
  const badDemo = demo.filter((u) => {
    const rel = u.replace(base, '');
    return !restored.has(rel) || !existsSync(path.join(DIST, rel));
  });
  assert.deepEqual(badDemo, [], `题外话里的示范网址不存在：\n${badDemo.join('\n')}`);
  assert.ok(/fetch/.test(guide), '题外话要说明「拼出网址后 fetch 正文再回答」');
});
