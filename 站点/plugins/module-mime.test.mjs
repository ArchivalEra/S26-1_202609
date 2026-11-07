// module-mime.test.mjs —— 浏览器 import 的模块**不许用 .mjs**（2026-11-06 线上实测）。
//
// ## 病因（线上实测，本地全绿也发现不了）
//
// EdgeOne Pages 对 `.mjs` 回 `Content-Type: application/octet-stream`，
// 而 `<script type="module">` 里的 `import()` 有严格 MIME 检查：
// 非 JS 类型直接抛「Failed to fetch dynamically imported module」。
//
// 后果不是「某个功能降级」，是**整段装配脚本被 try/catch 吞掉**：
// `window.__initPackRuntime` 永不调用 ⇒ 胶囊的 `init()` 不跑 ⇒
// **胶囊 DOM 在、点不出面板**（站长实测：「线上胶囊面板都点不出来」）。
//
// 同一批里 `capability-pack.mjs`、`formula-cells.mjs`、`assets/math/*.mjs`
// 全是 octet-stream，所以「编辑」「运行」也一并挂了——但页面上什么都没有提示。
//
// ## 判据
//
// 产物里凡是浏览器 `import()` 加载的模块，扩展名必须是 `.js`（EdgeOne 与
// GitHub Pages 都按 `application/javascript` 发）。`.mjs` 只允许留在构建期的
// Node 侧（`站点/build.mjs` 自己 import 的那些），不进 dist、不出现在页面。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '../dist');
const BUILD = readFileSync(path.join(HERE, '../build.mjs'), 'utf8');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test('产物里不许有浏览器要 import 的 .mjs（EdgeOne 会发 octet-stream）', () => {
  assert.ok(existsSync(DIST), 'dist 不存在——先跑 node build.mjs');
  // katex.mjs 是**构建期**（Node 侧）import 的，浏览器从不加载它——它是 vendored
  // 上游 ESM 构建，改后缀会破坏上游完整性。所以只查浏览器会 import 的两处：
  // assets/plugins/（能力包三件）与 assets/math/（解析器子集）。
  const browserLoaded = ['assets/plugins', 'assets/math'];
  const bad = walk(DIST)
    .map((p) => path.relative(DIST, p))
    .filter((rel) => rel.endsWith('.mjs'))
    .filter((rel) => browserLoaded.some((d) => rel.startsWith(d + '/')));
  assert.deepEqual(bad, [],
    '这些 .mjs 会被 EdgeOne 发成 application/octet-stream，浏览器 import() 直接失败：\n'
    + bad.map((x) => `  ${x}`).join('\n')
    + '\n  处置：抄进 dist 时改后缀为 .js（见 build.mjs 里 math 模块与 plugins 的写盘段）。');
});

test('页面里的 import 路径一律 .js', () => {
  assert.ok(existsSync(DIST), 'dist 不存在——先跑 node build.mjs');
  const html = readFileSync(path.join(DIST, 'index.html'), 'utf8');
  // 页面里是 `await import(assetRoot() + 'assets/plugins/xxx.js?v=…')` 这种拼接形态，
  // 正则只认引号里的路径片段。
  const paths = [...html.matchAll(/'(assets\/(?:plugins|math)\/[^']+)'/g)].map((m) => m[1]);
  assert.ok(paths.length > 0, '页面上一个 assets/(plugins|math) 路径都没找到——切不到装配脚本？');
  const mjs = paths.filter((x) => x.includes('.mjs'));
  assert.deepEqual(mjs, [],
    `页面还在 import .mjs（会 MIME 拒绝）：\n${mjs.map((x) => `  ${x}`).join('\n')}`);
});

test('构建脚本里浏览器侧的模块写盘用 .js', () => {
  // 三个能力包模块 + 数学子集，都是浏览器 import 的，写盘必须是 .js
  for (const name of ['capability-pack', 'formula-cells', 'static-release']) {
    assert.match(BUILD, new RegExp(`webmcpDir, '${name}\\.js'\\)`),
      `${name} 没写成 .js —— 线上会被当 octet-stream 拒掉`);
  }
  assert.match(BUILD, /const out = f\.replace\(\/\\\.mjs\$\/, '\.js'\)/,
    'math 子集没有改名逻辑，拷过去还是 .mjs');
});

test('运行期动态 import 的 math 模块必须带 ?v= 内容哈希（2026-11-07 线上 404 之一）', () => {
  // 2026-11-07 站长线上实报「公式解析失败：error loading dynamically imported
  // module: …/assets/math/parser.js」。当时页面里 plugins 三件都有 ?v= 内容哈希，
  // 唯独 math 两件（parser/to-octave）没有 —— 它们是仅有的无戳动态 import，
  // 撞上 EdgeOne 的旧缓存副本时没有任何自愈手段（§0.218 缓存滞后那一类）。
  // 判据：页面模板里对 math 模块的 import 必须带 ?v=__XXX_VER__ 占位符，
  // 且占位符在 htmlWithVers 替换链里（兜底断言已在 build.mjs 内，这里防模板本身漏写）。
  assert.match(BUILD, /import\(moduleRoot\(\) \+ 'assets\/math\/parser\.js\?v=__PARSER_VER__'\)/,
    'parser.js 的 import 没走 moduleRoot() + ?v= —— 相对前缀会 404、无戳会吃缓存旧副本');
  assert.match(BUILD, /import\(moduleRoot\(\) \+ 'assets\/math\/to-octave\.js\?v=__OCTAVE_VER__'\)/,
    'to-octave.js 的 import 没走 moduleRoot() + ?v=');
  // 两个占位符都要进替换链（只加占位符不加替换 = 又一次字面量泄漏）
  const chain = BUILD.slice(BUILD.indexOf('const htmlWithVers = finalHtml'), BUILD.indexOf('const leakedVer'));
  assert.match(chain, /split\('__PARSER_VER__'\)\.join\(parserVer\)/, '__PARSER_VER__ 没进替换链');
  assert.match(chain, /split\('__OCTAVE_VER__'\)\.join\(octaveVer\)/, '__OCTAVE_VER__ 没进替换链');
});

test('运行期模块 import 必须用绝对正式根（moduleRoot），不许裸相对 assetRoot', () => {
  // 相对前缀的坑：data-root 在「镜像入口 / site-root 探测失配 / SPA 竞态」下
  // 可能仍是 './'，从 isui.ren 根解析出 /assets/math/parser.js ⇒ 404
  // （线上报错 URL 正是这种不带 /repo/S26-1_202609/ 的形状）。
  // 判据：页面模板里必须定义 moduleRoot()（canonical 优先），且 math 两件用它；
  // capability-pack / formula-cells 等首屏 import 保持 assetRoot（它们在
  // fixSiteRoot 之后才跑，且改动它们超出本次事故范围）。
  assert.match(BUILD, /const moduleRoot = \(\) => \{/, '页面模板缺 moduleRoot() 定义');
  assert.match(BUILD, /data-canonical-root/, 'moduleRoot 没读 data-canonical-root');
  assert.match(BUILD, /return \(c && c !== '\/'\) \? c : assetRoot\(\)/,
    'moduleRoot 没做「canonical 优先、缺失退回 data-root」的分流');
});
