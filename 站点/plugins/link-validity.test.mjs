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

// machine/ 是**全站镜像**（2026-11-13 站长裁定）：按站内路径一比一复刻整页内容。
//   站内 /课程总览/工程数学/Walkthrough.html
//   镜像 /machine/课程总览/工程数学/Walkthrough.json
// 每份镜像 = **渲染前的整篇源文**：正文 Markdown 原样、公式保持 TeX 原文、
// 图片换成完整 URL、符号不冒泡。就是「进 Shirone reader 之前」的那一份。
// Birthright.html 是人类可读的树，每条叶子是完整绝对链接（风控会拆链接，
// 不依赖任何拼接规则）。
test('machine/：镜像含整篇源文（TeX 原文 + 图片绝对 URL），Birthright 链接完整', () => {
  const machDir = path.join(DIST, 'machine');
  const catFile = path.join(machDir, 'Birthright.html');
  const MACHINE_BASE = 'https://isui.ren/repo/S26-1_202609/machine/';
  const SITE_BASE = 'https://isui.ren/repo/S26-1_202609/';
  assert.ok(existsSync(catFile), 'Birthright.html 不存在——先跑 node build.mjs');

  const sitePages = JSON.parse(
    readFileSync(path.join(DIST, 'index.html'), 'utf8')
      .match(/id="site-pages-json">(.*?)<\/script>/s)[1],
  );

  // ① 镜像数 = 全站页数，且「.html → .json」逐条成立。
  const mirrorOf = (p) => (p === '' ? 'index.json'
    : (p.endsWith('/') ? `${p}index.json` : p.replace(/\.html$/, '.json')));
  const badMap = sitePages.filter((p) => !existsSync(path.join(machDir, mirrorOf(p))));
  assert.deepEqual(badMap.slice(0, 5), [], '这些页面的镜像不存在');

  // ② 镜像内容是**整篇源文**，不是抽出来的字段：
  //    有 body、无 math/figures 这类抽稀字段、无占位符、无气泡标记。
  const samplePage = '课程总览/电路原理/作业/习题册第一章.html';
  const sample = JSON.parse(readFileSync(path.join(machDir, mirrorOf(samplePage)), 'utf8'));
  assert.equal(sample.url, samplePage);
  assert.ok(typeof sample.body === 'string' && sample.body.length > 1000,
    '镜像必须含完整正文（body）');
  assert.ok(!('math' in sample) && !('figures' in sample),
    '镜像不该只剩抽稀字段——要整篇源文');
  assert.ok(!/@@MATH|@@CODE|@@FIGURE/.test(sample.body), '源文里不许残留构建占位符');
  assert.ok(!/data-term|sym-gloss/.test(sample.body), '符号不冒泡（那是给人页面的交互）');
  // 公式保持 TeX 原文（不是 KaTeX 排版后的 HTML）。
  const dispTex = [...sample.body.matchAll(/\$\$(.+?)\$\$/gs)].map((m) => m[1]);
  assert.ok(dispTex.length > 10, `块级公式太少（${dispTex.length}），TeX 原文可能丢了`);
  assert.ok(dispTex.some((t) => /\\[a-zA-Z]/.test(t)), 'TeX 原文必须带反斜杠命令');
  assert.ok(!/<span class="katex/.test(sample.body), '正文里不该有 KaTeX 排版产物');
  // 图片全部是完整绝对 URL。
  const imgs = [...sample.body.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(imgs.length > 5, `图片太少（${imgs.length}）`);
  const relImg = imgs.filter((u) => !u.startsWith('https://'));
  assert.deepEqual(relImg.slice(0, 5), [], '图片必须换成完整 URL');

  // ③ Birthright.html：每条是完整绝对链接、指向真实镜像、总数 = 页面数。
  const html = readFileSync(catFile, 'utf8');
  assert.ok(/<title>Birthright<\/title>/.test(html), '<title> 必须是 Birthright');
  const links = [...new Set([...html.matchAll(/https:\/\/[^<\s"]+\.json/g)].map((m) => m[0]))];
  assert.equal(links.length, sitePages.length,
    `链接数 ${links.length} ≠ 页面数 ${sitePages.length}`);
  const badLinks = links.filter((u) => !u.startsWith(MACHINE_BASE)
    || !existsSync(path.join(DIST, 'machine', u.slice(MACHINE_BASE.length))));
  assert.deepEqual(badLinks.slice(0, 5), [], '这些链接不是 machine/ 下的真实镜像');
  const tails = new Set(links.map((u) => u.slice(MACHINE_BASE.length)));
  const missing = sitePages.filter((p) => !tails.has(mirrorOf(p)));
  assert.deepEqual(missing.slice(0, 5), [], '这些页面在 Birthright 里没有链接');
});
