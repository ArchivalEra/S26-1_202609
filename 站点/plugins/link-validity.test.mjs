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
// 收集一页的全部片：镜像文件 + <stem>-piece-N.json（同一目录、同前缀）。
function allJsonOfPage(page, machDir, mirrorOf) {
  const main = path.join(machDir, mirrorOf(page));
  const stem = path.basename(mirrorOf(page), '.json');
  const dir = path.dirname(main);
  const out = [main];
  if (existsSync(dir)) {
    for (const e of readdirSync(dir)) {
      const m = /^(.+?)-piece-\d+\.json$/.exec(e);
      if (m && m[1] === stem) out.push(path.join(dir, e));
    }
  }
  return out;
}

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
  // 整页可能被切成多片——把同页全部片拼起来再核（含首片及 piece-N 续片）。
  const samePage = (f) => path.basename(f).startsWith(path.basename(mirrorOf(samplePage), '.json'))
    || f === path.join(machDir, mirrorOf(samplePage));
  const pieces = allJsonOfPage(samplePage, machDir, mirrorOf);
  const full = pieces.map((f) => JSON.parse(readFileSync(f, 'utf8')).body).join('\n');
  const dispTex = [...full.matchAll(/\$\$(.+?)\$\$/gs)].map((m) => m[1]);
  assert.ok(dispTex.length > 10, `块级公式太少（${dispTex.length}），TeX 原文可能丢了`);
  assert.ok(dispTex.some((t) => /\\[a-zA-Z]/.test(t)), 'TeX 原文必须带反斜杠命令');
  assert.ok(!/<span class="katex/.test(full), '正文里不该有 KaTeX 排版产物');
  // 图片全部是完整绝对 URL。
  const imgs = [...full.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
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

  // ④ 分片（2026-11-13）：腾讯侧 fetch 有体积限制，整页可能取不全。
  //    每页切成小节，`<页名>/_index.json` 是「挑哪片」的小索引（必须小到能一次取完），
  //    `<页名>/<id>.json` 是单题片。索引里的每一项都必须真的存在，且片内容自洽。
  const sliceDir = path.join(machDir, '课程总览/电路原理/作业/习题册第一章');
  const sliceIdx = JSON.parse(readFileSync(path.join(sliceDir, '_index.json'), 'utf8'));
  assert.ok(Buffer.byteLength(JSON.stringify(sliceIdx)) < 64 * 1024,
    '分片索引必须足够小（风控一次 fetch 能取完）');
  assert.ok(sliceIdx.sections.length > 10,
    `切片太少（${sliceIdx.sections.length}），按标题切分可能失效`);
  for (const sec of sliceIdx.sections) {
    const f = path.join(sliceDir, sec.file);
    assert.ok(existsSync(f), `索引里的片不存在：${sec.file}`);
    const piece = JSON.parse(readFileSync(f, 'utf8'));
    assert.equal(piece.section, sec.heading, '片的 section 必须与索引 heading 一致');
    assert.equal(Buffer.byteLength(piece.body), sec.chars, '片的字节数必须与索引 chars 一致');
    assert.ok(piece.body.length > 0, '片内容不能为空');
  }
  // 片拼起来必须还是整页正文（不丢内容）——只判「有片」不够，要判覆盖。
  const whole = JSON.parse(readFileSync(path.join(machDir, mirrorOf(samplePage)), 'utf8'));
  const joined = sliceIdx.sections
    .map((sec) => JSON.parse(readFileSync(path.join(sliceDir, sec.file), 'utf8')).body)
    .join('\n').replace(/\n{2,}/g, '\n').trim();
  const norm = (t) => t.replace(/\n{2,}/g, '\n').trim();
  assert.equal(norm(joined).length >= norm(whole.body).length - 200, true,
    `切片拼起来比整页短太多（${norm(joined).length} vs ${norm(whole.body).length}），有内容丢失`);

  // ⑤ 5000 字节上限（2026-11-13 站长定）：腾讯 fetch 会截断，**任何**一份
  //    正文都不许超限。被切的那份尾部写「剩余见<下一个文件的完整网址>」，
  //    续链必须指向真实存在的文件，且下一片也不超限（链不断）。
  const allJson = [];
  const walkAll = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walkAll(p);
      else if (e.name.endsWith('.json')) allJson.push(p);
    }
  };
  walkAll(machDir);
  const BODY_CAP = 5000;
  let checked = 0;
  for (const f of allJson) {
    if (path.basename(f) === '_index.json') continue;
    const d = JSON.parse(readFileSync(f, 'utf8'));
    if (!d.body) continue;
    checked += 1;
    // body 含续链文本；剥掉「剩余见…」再量正文，正文必须 ≤ 上限。
    const bare = d.body.replace(/\n\n剩余见https:\/\/\S+$/, '');
    assert.ok(Buffer.byteLength(bare) <= BODY_CAP,
      `${f} 正文 ${Buffer.byteLength(bare)} 超 ${BODY_CAP}，必须切片`);
    const cont = /剩余见(https:\/\/\S+)$/.exec(d.body);
    if (cont) {
      const rel = cont[1].slice('https://isui.ren/repo/S26-1_202609/machine/'.length);
      assert.ok(existsSync(path.join(machDir, rel)), `${f} 的续链不存在：${cont[1]}`);
    }
  }
  assert.ok(checked >= 200, `只核了 ${checked} 份 JSON，覆盖不足`);
});
