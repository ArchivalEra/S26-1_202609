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

// machine/ 是**全站镜像**（2026-11-12 站长裁定）：按站内路径一比一复刻。
//   站内 /课程总览/工程数学/Walkthrough.html
//   镜像 /machine/课程总览/工程数学/Walkthrough.json
// 每份镜像只放「HTML 里取不到源码」的部分（公式 TeX + 配图），正文仍 fetch 页面。
// Birthright.txt 是括号树目录（4 KB 装 180 页），首行规则即「怎么拼地址」。
test('machine/：镜像与站内页面一一对应，Birthright 括号树无损', () => {
  const machDir = path.join(DIST, 'machine');
  const catFile = path.join(machDir, 'Birthright.txt');
  assert.ok(existsSync(catFile), 'Birthright.txt 不存在——先跑 node build.mjs');
  assert.ok(existsSync(path.join(machDir, '_index.json')), '_index.json 不存在');

  const sitePages = JSON.parse(
    readFileSync(path.join(DIST, 'index.html'), 'utf8')
      .match(/id="site-pages-json">(.*?)<\/script>/s)[1],
  );

  // ① 镜像页数 = 全站页数，且「.html → .json + machine/ 前缀」逐条成立。
  const idx = JSON.parse(readFileSync(path.join(machDir, '_index.json'), 'utf8'));
  assert.equal(idx.pages.length, sitePages.length,
    `镜像数 ${idx.pages.length} ≠ 页面数 ${sitePages.length}`);
  const badMap = idx.pages.filter((p) => p.mirror !== p.page.replace(/\.html$/, '.json')
    || !existsSync(path.join(machDir, p.mirror)));
  assert.deepEqual(badMap.slice(0, 5), [], '镜像路径与站内路径不是一一对应');
  assert.ok(/\.html/.test(idx.howToBuild) && /\.json/.test(idx.howToBuild),
    'howToBuild 必须写清怎么拼地址');

  // ② Birthright 括号树：独立解析器还原，必须与页面清单完全相等。
  const lines2 = readFileSync(catFile, 'utf8').trimEnd().split('\n');
  const ruleIdx = lines2.findIndex((l) => /A\(B,C\)/.test(l) && /A\[B,C\]/.test(l));
  assert.ok(ruleIdx > 0, '规则行必须在示范网址之后');
  const tree = lines2[ruleIdx + 1];
  assert.ok(tree?.startsWith('https://'), '规则行下一行是整棵树');
  const base = 'https://isui.ren/repo/S26-1_202609/';
  const out = [];
  const parse = (s, prefix) => {
    const items = []; let depth = 0; let start2 = 0;
    for (let i = 0; i < s.length; i += 1) {
      const c = s[i];
      if (c === '(' || c === '[') depth += 1;
      else if (c === ')' || c === ']') depth -= 1;
      else if (c === ',' && depth === 0) { items.push(s.slice(start2, i)); start2 = i + 1; }
    }
    items.push(s.slice(start2));
    for (const item of items) {
      const i1 = item.indexOf('('); const i2 = item.indexOf('[');
      const ix = i1 === -1 ? i2 : (i2 === -1 ? i1 : Math.min(i1, i2));
      const path = prefix + (ix === -1 ? item : item.slice(0, ix));
      if (ix === -1) { out.push(path.endsWith('/') ? path : `${path}.html`); continue; }
      const self = path.endsWith('/') ? path : `${path}/`;
      if (item[ix] === '(') out.push(self);
      parse(item.slice(ix + 1, -1), self);
    }
  };
  parse(tree, '');
  const restored = new Set(out.map((u) => (u.startsWith(base) ? u.slice(base.length) : u)));
  assert.equal(restored.size, sitePages.length,
    `括号树还原 ${restored.size} ≠ 页面 ${sitePages.length}；`
    + `缺：${sitePages.filter((p) => !restored.has(p)).slice(0, 5)}`);

  // ③ 镜像与产物抽样一致：挑公式最多的一页，核其 TeX 与图。
  let richest = null; let n = -1;
  const walkJson = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walkJson(p);
      else if (e.name.endsWith('.json') && e.name !== '_index.json') {
        const d = JSON.parse(readFileSync(p, 'utf8'));
        const c = (d.math?.length || 0) + (d.figures?.length || 0);
        if (c > n) { n = c; richest = { p, d }; }
      }
    }
  };
  walkJson(machDir);
  assert.ok(n > 100, `镜像结构数据太少（最多 ${n}），收集可能坏了`);
  const built = readFileSync(path.join(DIST, richest.d.url), 'utf8');
  for (const f of richest.d.figures || []) {
    assert.ok(built.includes(f.src), `${richest.d.url} 产物里没有 ${f.src}`);
    assert.ok(built.includes(f.alt.slice(0, 12)), 'alt 必须与产物 HTML 一致');
  }
  const display = (richest.d.math || []).filter((m) => m.display).length;
  const katex = (built.match(/class="katex-display"/g) || []).length;
  assert.ok(katex >= display, `产物块级公式 ${katex} < 镜像记录 ${display}`);
});
