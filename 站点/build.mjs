import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import katex from 'katex';
import { createMarkdownRenderer } from './markdown.mjs';
// 自建 TeX 解析器 → IR → 可替换的展示引擎，符号判定与展示共用同一棵树。
import { parse as parseMath } from './math/parser.mjs';
import { compile as compileMath, render as renderMathDoc, probeRenderer } from './math/index.mjs';
import { createKatexRenderer, decorateAnchors, replaceKatexWithText, KATEX_STYLESHEET } from './math/render.mjs';
import { renderCollapse } from './plugins/collapse.mjs';
import { DISCLOSURE_ANCHOR_JS } from './plugins/disclosure-anchor.mjs';
// 符号深核心（2026-11-25 收口）：加载/编译/查词/页面会话/运行时全部收进 站点/symbols/。
import {
  createSymbolCatalog,
  parseFrontmatter,
  SYMBOL_RUNTIME_ASSET,
  SYMBOL_JSON_SCRIPT_ID,
  SYMBOLS_BUBBLE_JS,
  escHtml,
  plainBubbleText,
} from './symbols/index.mjs';
import { extractSearchDoc, buildSearchBundle, SEARCH_JS, SEARCH_CSS } from './plugins/site-search.mjs';
import { SPA_ROUTER_JS } from './plugins/spa-router.mjs';
// SW 根除（2026-10-23）：一次性反注册脚本——见下方写盘段注释
import { SW_KILL_JS } from './plugins/sw-kill.mjs';
import { DRAWER_SYNC_JS } from './plugins/drawer-sync.mjs';
import { buildNavModel, isActive, isExpanded, htmlPathOf, filePathOf, NAV_STRUCTURE_JS } from './plugins/nav-structure.mjs';
import { SITE_HELPERS_JS } from './plugins/site-helpers.mjs';
import { TARGET_FILES } from './页面清单.mjs';
import { computeSourceHash } from './源树hash.mjs';
// 符号覆盖统计（2026-11-05）：构建期把「哪些符号冒了泡、哪些该冒没冒」写成数据，
// 供 plugins/symbol-coverage.test.mjs 与 FACTS 量。旧版逐页警告在页面循环之前就打印，
// 全部被静默丢弃——这正是「符号冒不了泡且无法统计」的根因，见模块头注释。
import { measurePage, diagnosePage } from './plugins/symbol-coverage.mjs';
// 符号**缺口**账本（2026-11-06）：公式里出现、但本页词条没覆盖的形状。
// 前两道闸只看「判定之后」的事，抓不到「压根没被判定为符号」那一类——
// 实测电路原理习题册 V/A/T/N/B/M 从没被声明过，构建日志一个字都不说。
import { measureFormulaShapes, coverageOf } from './plugins/symbol-gaps.mjs';
import { loadIssueStates, stripClosedBoundary } from './plugins/issue-status.mjs';

const SITE_DIR = fileURLToPath(new URL('.', import.meta.url));
const ROOT = path.resolve(SITE_DIR, '..');
const DIST_DIR = path.join(SITE_DIR, 'dist');

// 正式部署根（2026-10-20 镜像入口修复）：站点在 isui.ren 上挂在子路径
// /repo/S26-1_202609/ 下，但托管层让无前缀路径也返回 200——两个入口指向
// 同一份文件。构建期把正式根写进 <html data-canonical-root>，运行时
// site-root.mjs 探测实际根，不一致就把链接规范到正式根。
// 不传（默认 /）= 部署在域名根（GitHub Pages 用户页场景），行为不变。
const argvCanonical = process.argv.includes('--canonical-root')
  ? process.argv[process.argv.indexOf('--canonical-root') + 1] : null;
let CANONICAL_ROOT = '/';
if (argvCanonical) {
  CANONICAL_ROOT = argvCanonical.endsWith('/') ? argvCanonical : argvCanonical + '/';
}

const argvIssueStates = process.argv.includes('--issue-states')
  ? process.argv[process.argv.indexOf('--issue-states') + 1] : null;
const ISSUE_STATES = await loadIssueStates({ statesFile: argvIssueStates });

console.log(`[build] Starting static site generation...`);
console.log(`[build] Repo Root: ${ROOT}`);
console.log(`[build] Output: ${DIST_DIR}`);
console.log(`[build] Canonical Root: ${CANONICAL_ROOT}`);

// 1. 页面清单：唯一真相源在 ./页面清单.mjs（build 与 MCP 读层共用），此处 import

// Clean and recreate dist
if (fs.existsSync(DIST_DIR)) {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(DIST_DIR, { recursive: true });

// Copy assets
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      if (/\.png$/i.test(entry.name)) {
        throw new Error(`[build] 禁止向静态站输出 PNG 文件（请改用 SVG 或 WebP）：${srcPath}`);
      }
      copyFileAtomic(srcPath, destPath);
    }
  }
}

// 原子复制：先写临时文件再 rename，构建期间被预览服务器服务的请求永远读不到半截文件
// （2026-10-11 实弹：复写 figures 的瞬间被请求的图以半截响应进了浏览器缓存，
// Last-Modified 是秒级精度，之后 304 永远放行那份坏体）。内容没变就不落盘，
// dest 的 mtime 保持稳定，配图 src 的 ?v= 才不会每次构建空转。
function copyFileAtomic(srcPath, destPath) {
  const buf = fs.readFileSync(srcPath);
  if (fs.existsSync(destPath) && fs.readFileSync(destPath).equals(buf)) return;
  const tmpPath = destPath + '.tmp';
  fs.writeFileSync(tmpPath, buf);
  fs.renameSync(tmpPath, destPath);
}

// 已退役的运行时目录（octave / pyodide / m / oct）不得残留进站点资产或发布产物。
const RETIRED_RUNTIME_ASSET_DIRS = new Set(['octave', 'pyodide', 'm', 'oct']);
function copySiteAssets(src, dest, isRoot = true) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (isRoot && entry.isDirectory() && RETIRED_RUNTIME_ASSET_DIRS.has(entry.name)) {
      throw new Error(`[build] 禁止在 assets/ 残留已退役的运行时目录（请删除）：${path.join(src, entry.name)}`);
    }
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copySiteAssets(srcPath, destPath, false);
    else {
      if (/\.png$/i.test(entry.name)) {
        throw new Error(`[build] 禁止向静态站输出 PNG 资产（请改用 SVG/WebP/GIF）：${srcPath}`);
      }
      copyFileAtomic(srcPath, destPath);
    }
  }
}
copySiteAssets(path.join(SITE_DIR, 'assets'), path.join(DIST_DIR, 'assets'));
// KaTeX 前端样式、字体与 LICENSE 直接随 npm 包拷贝进 dist/assets/katex/，仓库不保留上游副本。
{
  const katexPkgDir = path.dirname(fileURLToPath(import.meta.resolve('katex/package.json')));
  const katexDistOut = path.join(DIST_DIR, 'assets', 'katex');
  const katexFontsOut = path.join(katexDistOut, 'fonts');
  fs.mkdirSync(katexFontsOut, { recursive: true });
  copyFileAtomic(path.join(katexPkgDir, 'dist', 'katex.min.css'), path.join(katexDistOut, 'katex.min.css'));
  copyFileAtomic(path.join(katexPkgDir, 'LICENSE'), path.join(katexDistOut, 'LICENSE'));
  for (const entry of fs.readdirSync(path.join(katexPkgDir, 'dist', 'fonts'), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.woff2')) {
      copyFileAtomic(path.join(katexPkgDir, 'dist', 'fonts', entry.name), path.join(katexFontsOut, entry.name));
    }
  }
  const copyPkgLicense = (pkgJsonSpec, outSubdir) => {
    const pkgDir = path.dirname(fileURLToPath(import.meta.resolve(pkgJsonSpec)));
    const outDir = path.join(DIST_DIR, 'assets', outSubdir);
    fs.mkdirSync(outDir, { recursive: true });
    copyFileAtomic(path.join(pkgDir, 'LICENSE'), path.join(outDir, 'LICENSE'));
  };
  copyPkgLicense('marked/package.json', 'marked');
  copyPkgLicense('js-yaml/package.json', 'js-yaml');
}
console.log(`[build] Copied offline assets to dist/assets/`);

{
  const helpersDocSrc = path.join(SITE_DIR, 'HELPERS.md');
  if (fs.existsSync(helpersDocSrc)) {
    copyFileAtomic(helpersDocSrc, path.join(DIST_DIR, 'HELPERS.md'));
  }
  const licJsonSrc = path.join(SITE_DIR, 'licenses.json');
  if (fs.existsSync(licJsonSrc)) {
    copyFileAtomic(licJsonSrc, path.join(DIST_DIR, 'licenses.json'));
  }
  const rootLicSrc = path.join(ROOT, 'LICENSE');
  if (fs.existsSync(rootLicSrc)) {
    copyFileAtomic(rootLicSrc, path.join(DIST_DIR, 'LICENSE'));
  }
}

// 课程目录内的配图目录（figures/）原样拷进 dist，路径保持相对仓库根。
// 配图目录按**发现式**扫：`<课>/<任意一层>/figures/`。此前写死成 `作业/figures`，
// 于是交叉课的 `交叉内容/figures/` 不会被拷进 dist（图 404、页面裂图）。
const FIG_PARENTS = ['作业', '交叉内容'];
for (const course of fs.readdirSync(path.join(ROOT, '课程总览'), { withFileTypes: true })) {
  if (!course.isDirectory()) continue;
  for (const parent of FIG_PARENTS) {
    const figDir = path.join(ROOT, '课程总览', course.name, parent, 'figures');
    if (!fs.existsSync(figDir)) continue;
    copyDir(figDir, path.join(DIST_DIR, '课程总览', course.name, parent, 'figures'));
    console.log(`[build] Copied figures: 课程总览/${course.name}/${parent}/figures/`);
  }
}

// 折叠面板深链接的客户端增强，来自独立插件模块 disclosure-anchor.mjs。
// 可拆卸：删掉本段与页面模板里的 disclosure-anchor <script> 即回退
// （锚点仍可滚动定位，只是收起的面板要手动点开）。
const disclosureAnchorDist = path.join(DIST_DIR, 'assets', 'plugins', 'disclosure-anchor.js');
fs.mkdirSync(path.dirname(disclosureAnchorDist), { recursive: true });
fs.writeFileSync(disclosureAnchorDist, DISCLOSURE_ANCHOR_JS);

// 符号深核心：加载全部符号包、校验 match 正则防呆、编译数学词典（统一规范键 `包:词条`）。
const symbolCatalog = createSymbolCatalog({ root: ROOT, parseMath });
for (const w of symbolCatalog.warnings) console.warn(`[符号] ${w}`);
for (const p of symbolCatalog.dictProblems) {
  if (p.severity === 'error') console.error(`[数学] 词典：${p.message}`);
  else console.warn(`[数学] 词典：${p.message}`);
}
console.log(`[符号] 包：${Object.entries(symbolCatalog.packs).map(([n, p]) => `${n}(${Object.keys(p.dict).length} 条)`).join('、')}`);

/**
 * 渲染一条公式：编译（解析 + 唯一一次符号判定）→ 渲染 → 包锚点。
 *
 * **这是全站唯一一处渲染数学的地方**。
 *
 * @param {string} src     公式源（不含 `$`）
 * @param {'inline'|'display'} mode
 * @param {string} relPath 页面路径（诊断定位）
 * @param {object} symSession 本页符号解析会话（来自 symbolCatalog.openPage）
 * @param {{record?: boolean}} [o]
 * @returns {{rendered: string, plain: string}}
 */
function reportCompileProblems(problems, relPath, src) {
  for (const prob of problems) {
    if (prob.severity === 'error') {
      formulaErrors++;
      console.warn(`[build] ⚠ 公式渲染失败 ${relPath}：${prob.message}｜${src.slice(0, 60)}`);
    } else if (prob.code !== 'term-excluded') {
      console.warn(`[build] ⚠ ${relPath}：${prob.message}`);
    }
  }
}

function renderOneMath(src, mode, relPath, symSession, o = {}) {
  const env = o.record === false
    ? { dictionary: symbolCatalog.mathDictionary, packs: [] }
    : symSession.mathEnv();
  const compiled = compileMath({ blocks: [{ raw: src, mode }] }, env);
  const doc = compiled.docs[0];
  reportCompileProblems(compiled.problems, relPath, src);
  if (o.record !== false) symSession.recordMathDoc(doc);

  const out = renderMathDoc(doc, mathRenderer, {
    decorateAnchors,
    resolveHref: (key) => symSession.resolveHref(key),
  });
  for (const prob of out.problems) {
    if (prob.severity === 'error') {
      formulaErrors++;
      console.warn(`[build] ⚠ ${relPath}：${prob.message}`);
    }
  }

  const rendered = mode === 'display'
    ? `<div class="math-display katex-scroll-container">${out.html}</div>`
    : out.html;
  return { rendered, plain: doc.plain };
}

const symbolBubbleDist = path.join(DIST_DIR, SYMBOL_RUNTIME_ASSET);
fs.mkdirSync(path.dirname(symbolBubbleDist), { recursive: true });
fs.writeFileSync(symbolBubbleDist, SYMBOLS_BUBBLE_JS);

// 渲染器 + 启动期自检：契约不成立就别开工。
const mathRenderer = createKatexRenderer(katex);
const probeProblems = probeRenderer(mathRenderer);
if (probeProblems.some((p) => p.severity === 'error')) {
  throw new Error(`[数学] 渲染器自检失败：${probeProblems[0].message}`);
}
console.log(`[数学] 展示引擎 ${mathRenderer.id}；词典 ${Object.keys(symbolCatalog.mathDictionary.packs).length} 包`);

// 全站搜索：构建期生成倒排索引，浏览器端零依赖。实现与设计理由见
// 站点/plugins/site-search.mjs（那里也记录了为什么弃用 Pagefind：它按单字索引中文，
// 「的」能命中 62/66 页）。
// 可拆卸：删掉本段、页面模板里的两行注入、以及最后的 buildSearchBundle 写盘即回退。
const searchPluginDir = path.join(DIST_DIR, 'assets', 'plugins');
fs.mkdirSync(searchPluginDir, { recursive: true });
fs.writeFileSync(path.join(searchPluginDir, 'site-search.js'), SEARCH_JS);
fs.writeFileSync(path.join(searchPluginDir, 'site-search.css'), SEARCH_CSS);

// WebMCP（浏览器内置 AI 与页面交互）：**零依赖、可整体拆卸**。
//   页面只注入两个脚本：webmcp-loader.js（编排器）+ webmcp-relay.js（本机 relay 连接器）。
//   loader 按形态决定是否加载 polyfill，再**按顺序**注入 shim 与 tools——
//   顺序神圣：shim 必须在任何工具注册之前包好两个注册表，否则抓不到已注册的工具。
//   polyfill（281 KB）**绝不无条件加载**：没有 WebMCP 环境的浏览器一个字节都不拉。
// 资产版本戳（2026-10-12）：页面里的样式表与脚本引用一律追加 `?v=<内容哈希前 10 位>`。
// 为什么必须做：这些资产不发指纹文件名、服务器按 mtime 走 304，**改完内容浏览器仍可能用旧副本**
// （本仓已踩过「改了 JS/CSS 浏览器不见效」的负缓存坑）。内容哈希进 URL ⇒ 内容变、URL 才变，
// 新旧副本共存无关紧要，且不变时 URL 稳定、缓存照常命中。
// 只哈希**站点自己的**资产（主题/插件）：katex 是第三方 vendored，改它就该整份换版本。
// 2026-10-24（issue #18 决策 #6）：引用不存在的资产时**抛错**，不静默降级成无 ?v= 的
// 裸引用——那会产出一个 404 死链接且构建零警告（审计 γ P1-3）。与仓库既有硬失败
// 定案一致（frontmatter 硬失败、COURSE_STATUS 硬失败）。
const assetVersion = (relFromDist) => {
  try {
    return createHash('sha256').update(fs.readFileSync(path.join(DIST_DIR, relFromDist))).digest('hex').slice(0, 10);
  } catch {
    throw new Error(`assetVersion：dist 里没有资产 ${relFromDist}——引用了不存在的文件（先构建该资产再引用）`);
  }
};
const assetUrl = (relFromDist) => {
  const v = assetVersion(relFromDist);
  return v ? `${relFromDist}?v=${v}` : relFromDist;
};

const pluginDir = path.join(DIST_DIR, 'assets', 'plugins');
fs.mkdirSync(pluginDir, { recursive: true });
// 页面便利函数（Q19）：写盘供 `?helpers=1` / 测试按需加载，正常页面不注入。
fs.writeFileSync(path.join(pluginDir, 'site-helpers.js'), SITE_HELPERS_JS);
// 部署根探测（2026-10-20）：修「无前缀入口下相对链接退到域名根」的线上 404（模板以 defer 加载并自动执行）。
fs.writeFileSync(path.join(pluginDir, 'site-root.js'), fs.readFileSync(path.join(SITE_DIR, 'plugins', 'site-root.mjs'), 'utf8'));
console.log('[build] Wrote site-helpers + site-root plugins');

fs.writeFileSync(path.join(pluginDir, 'spa-router.js'), SPA_ROUTER_JS);
// 侧栏形状运行时（阶段一，2026-10-21）：外置共享 JSON + 按需水合。
fs.writeFileSync(path.join(pluginDir, 'nav-structure.js'), NAV_STRUCTURE_JS);
fs.writeFileSync(path.join(pluginDir, 'drawer-sync.js'), DRAWER_SYNC_JS);
// 这里写的是**一次性清老用户**的 sw-kill.js：老浏览器里已注册的旧 SW 还活着，
// 页面加载时反注册 + 清全部 caches。跑一两周（老用户都来过一次）后删本段。
fs.writeFileSync(path.join(pluginDir, 'sw-kill.js'), SW_KILL_JS);
console.log('[build] Wrote sw-kill.js (one-shot SW removal for legacy visitors)');

// 合并首屏必加载的 6 个脚本为单一 assets/app.js，减少 5 次 HTTP 请求
const APP_BUNDLE_PARTS = [
  fs.readFileSync(path.join(DIST_DIR, 'assets', 'theme', 'shirone-reader.js'), 'utf8'),
  fs.readFileSync(path.join(pluginDir, 'disclosure-anchor.js'), 'utf8'),
  fs.readFileSync(path.join(pluginDir, 'site-root.js'), 'utf8'),
  NAV_STRUCTURE_JS,
  DRAWER_SYNC_JS,
  SW_KILL_JS,
];
fs.writeFileSync(path.join(DIST_DIR, 'assets', 'app.js'), APP_BUNDLE_PARTS.join('\n;\n'));
console.log('[build] Bundled assets/app.js (6 core scripts -> 1 request)');

// 检索语料：渲染循环里逐页填，循环结束后统一建索引。
const searchDocs = [];

// 2. Pre-read metadata of all files for navigation & paging
const pageMetaMap = new Map();

// 课程状态的**唯一产地** = README 的 COURSE-STATUS 块（2026-10-11 定案）：
// 只允许「开课 / 结课」两档；课程页与各资料页顶端的状态都从这里继承，
// 资料文件不再自己写 `status`。README 缺块 ⇒ 明确报错（不静默降级成空状态）。
function parseCourseRow(line, map) {
  const row = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/.exec(line);
  if (!row) return;
  const [, name, status] = row;
  if (name === '课程' || /^[-: ]+$/.test(name)) return;
  if (status !== '开课' && status !== '结课') {
    throw new Error(`README 课程状态表：${name} 的状态「${status}」非法——只允许「开课」或「结课」。`);
  }
  map.set(name, status);
}

function loadCourseStatus() {
  const p = path.join(ROOT, 'README.md');
  const text = fs.readFileSync(p, 'utf-8');
  const m = /<!-- COURSE-STATUS:START -->([\s\S]*?)<!-- COURSE-STATUS:END -->/.exec(text);
  if (!m) {
    throw new Error('README.md 缺 COURSE-STATUS 块——课程状态的唯一产地，别删（见 README「课程状态」节）。');
  }
  const map = new Map();
  for (const line of m[1].split('\n')) parseCourseRow(line, map);
  if (!map.size) throw new Error('README 的 COURSE-STATUS 块里一条课程都没有——空不是通过。');
  return map;
}
const COURSE_STATUS = loadCourseStatus();

for (const relPath of TARGET_FILES) {
  const fullPath = path.join(ROOT, relPath);
  if (!fs.existsSync(fullPath)) continue;
  const content = fs.readFileSync(fullPath, 'utf-8');
  let title = path.basename(relPath, '.md');

  const { meta: frontmatter, hasFrontmatter } = parseFrontmatter(content, {
    strict: true,
    filePath: `${relPath}（元数据遍）`,
  });
  if (hasFrontmatter && frontmatter.name) {
    title = frontmatter.name;
  } else if (!hasFrontmatter) {
    // Check first H1
    const h1Match = /^#\s+(.+)$/m.exec(content);
    if (h1Match) title = h1Match[1];
  }

  pageMetaMap.set(relPath, {
    relPath,
    title,
    frontmatter,
    category: frontmatter.category || '',
    course: frontmatter.course || '',
    // 物理产物路径（翻页卡等页面间跳转用它 → 但见下方 url 字段：2026-10-29 起
    // 跳转一律用**网址**形态，htmlRelPath 保留给需要真实文件名的场合）
    htmlRelPath: filePathOf(relPath),
    // 站内**网址**（唯一规则来自 htmlPathOf）：目录索引页为 `目录/`，首页为 ''。
    urlRelPath: htmlPathOf(relPath)
  });
}

// 站点**真实产物路径**清单（2026-10-29）：`页面清单.mjs` 的 TARGET_FILES 逐个换成 html。
// 这是 site_navigate 的 to=page 判「这一页存不存在」的**唯一真相**——不是导航形状：
// README / 站点符号包都没有侧栏入口，但它们是真页面。
// 每个页面都烘一份（`#site-pages-json`），客户端不发请求即可校验。
// 用**网址**形态（不是文件名）：模型的 to=page 参数写的是它从 site_index / 侧栏
// 看到的那个东西，而侧栏现在给的就是目录形式。用文件名会让「侧栏看到 /课程总览/、
// 工具只认 课程总览/index.html」两套并存——正是本轮要消灭的分叉。
const SITE_PAGE_PATHS = TARGET_FILES.map((p) => htmlPathOf(p));

// 站点名（唯一产地）。页面 title 后缀、侧栏品牌、移动端大标题都取它。
const SITE_NAME = 'S26-1 课程知识库';

// 3. Define navigation structure
// ⚠️ 2026-10-29 站长定案：**侧栏不挂「首页」项**。回首页由侧栏顶部的品牌区块
// （`.sidebar-brand`）与大标题「S26-1 课程知识库」分担，面包屑的「首页」直接指 `/`。
// 侧栏若也有首页项，就会有两条指向同一页的链接、且形态不一（`/` 与 `index.html`）
// ——「网址 / 侧栏 / 面包屑」四条一致就永远差这一格。去掉它，隐患消失。
const NAV_STRUCTURE = [
  {
    label: "课程总览",
    path: "课程总览/index.md",
    children: [
      {
        label: "工程数学",
        path: "课程总览/工程数学/index.md",
        children: [
          { label: "Walkthrough", path: "课程总览/工程数学/Walkthrough.md" },
          { label: "技法库", path: "课程总览/工程数学/技法库.md" },
          {
            label: "作业",
            path: "课程总览/工程数学/作业/index.md",
            children: [
              { label: "作业1", path: "课程总览/工程数学/作业/作业1.md" },
              { label: "作业2", path: "课程总览/工程数学/作业/作业2.md" },
              { label: "作业3", path: "课程总览/工程数学/作业/作业3.md" },
              { label: "作业4", path: "课程总览/工程数学/作业/作业4.md" },
              { label: "作业5", path: "课程总览/工程数学/作业/作业5.md" }
            ]
          },
          {
            label: "课堂笔记",
            path: "课程总览/工程数学/课堂笔记/index.md",
            children: [
              { label: "09-17-行列式与沙路法则", path: "课程总览/工程数学/课堂笔记/09-17-行列式与沙路法则.md" },
              { label: "09-17-课堂听课整理", path: "课程总览/工程数学/课堂笔记/09-17-课堂听课整理.md" },
              { label: "09-24-降阶法与克拉默法则", path: "课程总览/工程数学/课堂笔记/09-24-降阶法与克拉默法则.md" },
              { label: "10-08-矩阵与逆", path: "课程总览/工程数学/课堂笔记/10-08-矩阵与逆.md" },
              { label: "10-15-初等变换与矩阵的秩", path: "课程总览/工程数学/课堂笔记/10-15-初等变换与矩阵的秩.md" },
              { label: "10-22-矩阵的秩与向量", path: "课程总览/工程数学/课堂笔记/10-22-矩阵的秩与向量.md" },
              { label: "10-29-向量相关性与秩", path: "课程总览/工程数学/课堂笔记/10-29-向量相关性与秩.md" },
              { label: "11-05-行秩列秩与极大无关组", path: "课程总览/工程数学/课堂笔记/11-05-行秩列秩与极大无关组.md" },
              { label: "11-12-线性方程组解的结构", path: "课程总览/工程数学/课堂笔记/11-12-线性方程组解的结构.md" },
              { label: "11-19-非齐次组与向量空间", path: "课程总览/工程数学/课堂笔记/11-19-非齐次组与向量空间.md" },
            ]
          },
          {
            label: "教材解析",
            path: "课程总览/工程数学/教材解析/index.md",
            children: [
              { label: "符号入门", path: "课程总览/工程数学/教材解析/符号入门.md" },
              {
                label: "第一部分-线性代数",
                path: "课程总览/工程数学/教材解析/第一部分-线性代数/index.md",
                children: [
                  {
                    label: "第1章-行列式",
                    children: [
                      { label: "1.0-通关攻略", path: "课程总览/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.0-通关攻略.md" },
                      { label: "1.1-二阶与三阶行列式", path: "课程总览/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.1-二阶与三阶行列式.md" },
                      { label: "1.2-n阶行列式", path: "课程总览/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.2-n阶行列式.md" },
                      { label: "1.3-克莱姆法则", path: "课程总览/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.3-克莱姆法则.md" },
                      { label: "1.4-MATLAB-行列式", path: "课程总览/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.4-MATLAB-行列式.md" }
                    ]
                  },
                  {
                    label: "第2章-矩阵",
                    children: [
                      { label: "2.0-通关攻略", path: "课程总览/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.0-通关攻略.md" },
                      { label: "2.1-矩阵的概念及运算", path: "课程总览/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.1-矩阵的概念及运算.md" },
                      { label: "2.2-逆矩阵", path: "课程总览/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.2-逆矩阵.md" },
                      { label: "2.3-初等变换与矩阵", path: "课程总览/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.3-初等变换与矩阵.md" },
                      { label: "2.4-矩阵的秩", path: "课程总览/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.4-矩阵的秩.md" },
                      { label: "2.5-MATLAB-矩阵运算", path: "课程总览/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.5-MATLAB-矩阵运算.md" }
                    ]
                  },
                  {
                    label: "第3章-n维向量与向量空间",
                    children: [
                      { label: "3.0-通关攻略", path: "课程总览/工程数学/教材解析/第一部分-线性代数/第3章-n维向量与向量空间/3.0-通关攻略.md" },
                      { label: "3.1-n维向量", path: "课程总览/工程数学/教材解析/第一部分-线性代数/第3章-n维向量与向量空间/3.1-n维向量.md" },
                      { label: "3.2-向量相关性", path: "课程总览/工程数学/教材解析/第一部分-线性代数/第3章-n维向量与向量空间/3.2-向量相关性.md" },
                      { label: "3.3-向量组的秩", path: "课程总览/工程数学/教材解析/第一部分-线性代数/第3章-n维向量与向量空间/3.3-向量组的秩.md" },
                      { label: "3.4-向量空间", path: "课程总览/工程数学/教材解析/第一部分-线性代数/第3章-n维向量与向量空间/3.4-向量空间.md" },
                      { label: "3.5-MATLAB-向量运算", path: "课程总览/工程数学/教材解析/第一部分-线性代数/第3章-n维向量与向量空间/3.5-MATLAB-向量运算.md" }
                    ]
                  },
                  {
                    label: "第4章-线性方程组",
                    children: [
                      { label: "4.1-消元法", path: "课程总览/工程数学/教材解析/第一部分-线性代数/第4章-线性方程组/4.1-消元法.md" },
                      { label: "4.2-判别定理", path: "课程总览/工程数学/教材解析/第一部分-线性代数/第4章-线性方程组/4.2-判别定理.md" },
                      { label: "4.3-解的结构", path: "课程总览/工程数学/教材解析/第一部分-线性代数/第4章-线性方程组/4.3-解的结构.md" },
                      { label: "4.4-用MATLAB求解", path: "课程总览/工程数学/教材解析/第一部分-线性代数/第4章-线性方程组/4.4-用MATLAB求解.md" }
                    ]
                  }
                ]
              }
            ]
          },
          { label: "原始资料", path: "课程总览/工程数学/原始资料/index.md" }
        ]
      },
      {
        label: "电力大数据与人工智能",
        path: "课程总览/电力大数据与人工智能/index.md",
        children: [
          { label: "Walkthrough", path: "课程总览/电力大数据与人工智能/Walkthrough.md" },
          { label: "备考", path: "课程总览/电力大数据与人工智能/备考.md" },
          { label: "作业", path: "课程总览/电力大数据与人工智能/作业/index.md",
            children: [
              { label: "2026-09-29作业", path: "课程总览/电力大数据与人工智能/作业/2026-09-29作业.md" }
            ]
          },
          { label: "教材解析", path: "课程总览/电力大数据与人工智能/教材解析/index.md" },
          { label: "课堂笔记", path: "课程总览/电力大数据与人工智能/课堂笔记/index.md",
            children: [
              { label: "09-20-开课第一讲", path: "课程总览/电力大数据与人工智能/课堂笔记/09-20-开课第一讲.md" },
              { label: "09-22-暂态稳定评估", path: "课程总览/电力大数据与人工智能/课堂笔记/09-22-暂态稳定评估.md" },
              { label: "09-29-大数据与AI算法", path: "课程总览/电力大数据与人工智能/课堂笔记/09-29-大数据与AI算法.md" },
              { label: "10-13-常用算法开篇", path: "课程总览/电力大数据与人工智能/课堂笔记/10-13-常用算法开篇.md" },
              { label: "10-20-聚类与神经网络", path: "课程总览/电力大数据与人工智能/课堂笔记/10-20-聚类与神经网络.md" },
              { label: "10-27-密度初筛与调频", path: "课程总览/电力大数据与人工智能/课堂笔记/10-27-密度初筛与调频.md" },
              { label: "11-03-一次调频性能评价", path: "课程总览/电力大数据与人工智能/课堂笔记/11-03-一次调频性能评价.md" },
              { label: "11-10-二次调频与无功电压", path: "课程总览/电力大数据与人工智能/课堂笔记/11-10-二次调频与无功电压.md" },
              { label: "11-17-特征选择与信息熵", path: "课程总览/电力大数据与人工智能/课堂笔记/11-17-特征选择与信息熵.md" },
              { label: "11-24-特征提取与选择", path: "课程总览/电力大数据与人工智能/课堂笔记/11-24-特征提取与选择.md" },
            ]
          },
          { label: "原始资料", path: "课程总览/电力大数据与人工智能/原始资料/index.md" }
        ]
      },
      {
        // 本课按 COURSE_SKIPPED_KINDS 声明豁免「教材解析」，故此处也不列该子节点
        // （与 .githooks/hook_lib.py 保持一致，别只改一边）。
        label: "形势与政策",
        path: "课程总览/形势与政策/index.md",
        children: [
          { label: "Walkthrough", path: "课程总览/形势与政策/Walkthrough.md" },
          { label: "备考", path: "课程总览/形势与政策/备考.md" },
          { label: "作业", path: "课程总览/形势与政策/作业/index.md" },
          { label: "课堂笔记", path: "课程总览/形势与政策/课堂笔记/index.md",
            children: [
              { label: "09-21-经济热点专题", path: "课程总览/形势与政策/课堂笔记/09-21-经济热点专题.md" },
              { label: "09-28-人工智能专题", path: "课程总览/形势与政策/课堂笔记/09-28-人工智能专题.md" },
              { label: "10-12-美丽中国建设", path: "课程总览/形势与政策/课堂笔记/10-12-美丽中国建设.md" },
              { label: "10-20-铸牢共同体意识", path: "课程总览/形势与政策/课堂笔记/10-20-铸牢共同体意识.md" },
            ]
          },
          { label: "原始资料", path: "课程总览/形势与政策/原始资料/index.md" }
        ]
      },
      {
        label: "电路原理",
        path: "课程总览/电路原理/index.md",
        children: [
          { label: "Walkthrough", path: "课程总览/电路原理/Walkthrough.md" },
          { label: "作业", path: "课程总览/电路原理/作业/index.md",
            children: [
              { label: "习题册第一章", path: "课程总览/电路原理/作业/习题册第一章.md" },
              { label: "习题册第二章", path: "课程总览/电路原理/作业/习题册第二章.md" },
              { label: "习题册第三章", path: "课程总览/电路原理/作业/习题册第三章.md" },
              { label: "习题册第四章", path: "课程总览/电路原理/作业/习题册第四章.md" },
              { label: "习题册第五章", path: "课程总览/电路原理/作业/习题册第五章.md" },
              { label: "习题册第六章", path: "课程总览/电路原理/作业/习题册第六章.md" },
              { label: "习题册第七章", path: "课程总览/电路原理/作业/习题册第七章.md" },
              { label: "习题册第九章", path: "课程总览/电路原理/作业/习题册第九章.md" }
            ]
          },
          { label: "教材解析", path: "课程总览/电路原理/教材解析/index.md",
            children: [
              { label: "符号入门", path: "课程总览/电路原理/教材解析/符号入门.md" }
            ]
          },
          { label: "课堂笔记", path: "课程总览/电路原理/课堂笔记/index.md",
            children: [
              { label: "09-21-开课与基本概念", path: "课程总览/电路原理/课堂笔记/09-21-开课与基本概念.md" },
              { label: "09-23-电压电位与电路名词", path: "课程总览/电路原理/课堂笔记/09-23-电压电位与电路名词.md" },
              { label: "09-28-KCL与KVL", path: "课程总览/电路原理/课堂笔记/09-28-KCL与KVL.md" },
              { label: "09-30-电容电感与独立电源", path: "课程总览/电路原理/课堂笔记/09-30-电容电感与独立电源.md" },
              { label: "10-10-受控源与例题", path: "课程总览/电路原理/课堂笔记/10-10-受控源与例题.md" },
              { label: "10-12-习题册与等效变换", path: "课程总览/电路原理/课堂笔记/10-12-习题册与等效变换.md" },
              { label: "10-14-电源等效变换", path: "课程总览/电路原理/课堂笔记/10-14-电源等效变换.md" },
              { label: "10-19-第二章讲评与支路法", path: "课程总览/电路原理/课堂笔记/10-19-第二章讲评与支路法.md" },
              { label: "10-21-网孔电流法", path: "课程总览/电路原理/课堂笔记/10-21-网孔电流法.md" },
              { label: "10-26-节点电压法", path: "课程总览/电路原理/课堂笔记/10-26-节点电压法.md" },
              { label: "10-26-补课叠加戴维南", path: "课程总览/电路原理/课堂笔记/10-26-补课叠加戴维南.md" },
              { label: "10-28-戴维南与诺顿", path: "课程总览/电路原理/课堂笔记/10-28-戴维南与诺顿.md" },
              { label: "11-02-习题册第三章讲评", path: "课程总览/电路原理/课堂笔记/11-02-习题册第三章讲评.md" },
              { label: "11-04-正弦量与相量", path: "课程总览/电路原理/课堂笔记/11-04-正弦量与相量.md" },
              { label: "11-09-相量运算与向量图", path: "课程总览/电路原理/课堂笔记/11-09-相量运算与向量图.md" },
              { label: "11-11-相量复习与复阻抗", path: "课程总览/电路原理/课堂笔记/11-11-相量复习与复阻抗.md" },
              { label: "11-16-相量法解题与串并联", path: "课程总览/电路原理/课堂笔记/11-16-相量法解题与串并联.md" },
              { label: "11-18-交流功率与功率因数", path: "课程总览/电路原理/课堂笔记/11-18-交流功率与功率因数.md" },
              { label: "11-23-功率因数与谐振", path: "课程总览/电路原理/课堂笔记/11-23-功率因数与谐振.md" },
              { label: "11-25-正弦稳态习题课", path: "课程总览/电路原理/课堂笔记/11-25-正弦稳态习题课.md" },
            ]
          },
          { label: "原始资料", path: "课程总览/电路原理/原始资料/index.md" }
        ]
      },
      {
        label: "电子技术",
        path: "课程总览/电子技术/index.md",
        children: [
          { label: "Walkthrough", path: "课程总览/电子技术/Walkthrough.md" },
          { label: "技法库", path: "课程总览/电子技术/技法库.md" },
          { label: "作业", path: "课程总览/电子技术/作业/index.md",
            children: [
              { label: "2026-9-23作业", path: "课程总览/电子技术/作业/2026-9-23作业.md" },
              { label: "2026-9-28作业", path: "课程总览/电子技术/作业/2026-9-28作业.md" },
              { label: "2026-9-30作业", path: "课程总览/电子技术/作业/2026-9-30作业.md" },
              { label: "2026-10-09作业", path: "课程总览/电子技术/作业/2026-10-09作业.md" },
              { label: "2026-10-10作业", path: "课程总览/电子技术/作业/2026-10-10作业.md" },
              { label: "2026-10-12作业", path: "课程总览/电子技术/作业/2026-10-12作业.md" },
              { label: "2026-10-14作业", path: "课程总览/电子技术/作业/2026-10-14作业.md" },
              { label: "2026-10-19作业", path: "课程总览/电子技术/作业/2026-10-19作业.md" },
              { label: "2026-10-21作业", path: "课程总览/电子技术/作业/2026-10-21作业.md" },
              { label: "2026-10-26作业", path: "课程总览/电子技术/作业/2026-10-26作业.md" },
              { label: "2026-10-28作业", path: "课程总览/电子技术/作业/2026-10-28作业.md" },
              { label: "2026-11-02作业", path: "课程总览/电子技术/作业/2026-11-02作业.md" },
              { label: "2026-11-04作业", path: "课程总览/电子技术/作业/2026-11-04作业.md" },
              { label: "2026-11-09作业", path: "课程总览/电子技术/作业/2026-11-09作业.md" },
              { label: "2026-11-18作业", path: "课程总览/电子技术/作业/2026-11-18作业.md" },
              { label: "2026-11-23作业", path: "课程总览/电子技术/作业/2026-11-23作业.md" }
            ]
          },
          { label: "教材解析", path: "课程总览/电子技术/教材解析/index.md",
            children: [
              { label: "符号入门", path: "课程总览/电子技术/教材解析/符号入门.md" }
            ]
          },
          { label: "课堂笔记", path: "课程总览/电子技术/课堂笔记/index.md",
            children: [
              { label: "09-21-开课与半导体基础", path: "课程总览/电子技术/课堂笔记/09-21-开课与半导体基础.md" },
              { label: "09-23-二极管与含二极管电路", path: "课程总览/电子技术/课堂笔记/09-23-二极管与含二极管电路.md" },
              { label: "09-28-三极管与场效应管", path: "课程总览/电子技术/课堂笔记/09-28-三极管与场效应管.md" },
              { label: "10-10-逻辑代数与公式法化简", path: "课程总览/电子技术/课堂笔记/10-10-逻辑代数与公式法化简.md" },
              { label: "10-12-卡诺图化简法与无关项", path: "课程总览/电子技术/课堂笔记/10-12-卡诺图化简法与无关项.md" },
              { label: "10-14-门电路与TTL集成电路", path: "课程总览/电子技术/课堂笔记/10-14-门电路与TTL集成电路.md" },
              { label: "10-19-三态门与组合逻辑电路", path: "课程总览/电子技术/课堂笔记/10-19-三态门与组合逻辑电路.md" },
              { label: "10-21-实验一常用逻辑门电路", path: "课程总览/电子技术/课堂笔记/10-21-实验一常用逻辑门电路.md" },
              { label: "10-21-编码器与译码器", path: "课程总览/电子技术/课堂笔记/10-21-编码器与译码器.md" },
              { label: "10-26-显示译码器与RS触发器", path: "课程总览/电子技术/课堂笔记/10-26-显示译码器与RS触发器.md" },
              { label: "10-28-触发器与时序逻辑电路", path: "课程总览/电子技术/课堂笔记/10-28-触发器与时序逻辑电路.md" },
              { label: "11-02-实验二三人表决器", path: "课程总览/电子技术/课堂笔记/11-02-实验二三人表决器.md" },
              { label: "11-02-时序分析与设计", path: "课程总览/电子技术/课堂笔记/11-02-时序分析与设计.md" },
              { label: "11-04-集成计数器与数码显示", path: "课程总览/电子技术/课堂笔记/11-04-集成计数器与数码显示.md" },
              { label: "11-09-555定时器与共射放大", path: "课程总览/电子技术/课堂笔记/11-09-555定时器与共射放大.md" },
              { label: "11-11-共射放大电路与耦合", path: "课程总览/电子技术/课堂笔记/11-11-共射放大电路与耦合.md" },
              { label: "11-16-多级放大与差分电路", path: "课程总览/电子技术/课堂笔记/11-16-多级放大与差分电路.md" },
              { label: "11-18-差分与功率放大电路", path: "课程总览/电子技术/课堂笔记/11-18-差分与功率放大电路.md" },
              { label: "11-23-负反馈与正弦振荡", path: "课程总览/电子技术/课堂笔记/11-23-负反馈与正弦振荡.md" },
            ]
          },
          { label: "原始资料", path: "课程总览/电子技术/原始资料/index.md" }
        ]
      },
      {
        label: "电机学",
        path: "课程总览/电机学/index.md",
        children: [
          { label: "Walkthrough", path: "课程总览/电机学/Walkthrough.md" },
          { label: "作业", path: "课程总览/电机学/作业/index.md",
            children: [
              { label: "09-22-第1章客观题", path: "课程总览/电机学/作业/09-22-第1章客观题.md" },
              { label: "1概述部分客观题", path: "课程总览/电机学/作业/1概述部分客观题.md" },
              { label: "10-15-变压器变比", path: "课程总览/电机学/作业/10-15-变压器变比.md" },
              { label: "2.1变压器认识与生产", path: "课程总览/电机学/作业/2.1变压器认识与生产.md" },
              { label: "2.2.1-1变压器空载运行", path: "课程总览/电机学/作业/2.2.1-1变压器空载运行.md" },
              { label: "2.2.1-2变压器负载运行", path: "课程总览/电机学/作业/2.2.1-2变压器负载运行.md" },
              { label: "2.2.2变压器参数测定及计算", path: "课程总览/电机学/作业/2.2.2变压器参数测定及计算.md" },
              { label: "2.2.3变压器运行性能", path: "课程总览/电机学/作业/2.2.3变压器运行性能.md" },
              { label: "2.3.1三相电力变压器", path: "课程总览/电机学/作业/2.3.1三相电力变压器.md" },
              { label: "2.3.3变压器瞬态过程", path: "课程总览/电机学/作业/2.3.3变压器瞬态过程.md" },
              { label: "3.1.1旋转电机及交流绕组", path: "课程总览/电机学/作业/3.1.1旋转电机及交流绕组.md" },
              { label: "3.1.2交流绕组电动势", path: "课程总览/电机学/作业/3.1.2交流绕组电动势.md" },
              { label: "3.1.3交流绕组磁动势", path: "课程总览/电机学/作业/3.1.3交流绕组磁动势.md" },
              { label: "3.2.1异步电动机运行分析", path: "课程总览/电机学/作业/3.2.1异步电动机运行分析.md" },
              { label: "期中考卷解析", path: "课程总览/电机学/作业/期中考卷解析.md" },
              { label: "变压器训练用56题", path: "课程总览/电机学/作业/变压器训练用56题.md" }
            ]
          },
          { label: "教材解析", path: "课程总览/电机学/教材解析/index.md",
            children: [
              { label: "符号入门", path: "课程总览/电机学/教材解析/符号入门.md" },
              { label: "第01章-概述",
                children: [
                  { label: "1.1-电机的分类", path: "课程总览/电机学/教材解析/第01章-概述/1.1-电机的分类.md" },
                  { label: "1.2-电机的磁路和磁路定律", path: "课程总览/电机学/教材解析/第01章-概述/1.2-电机的磁路和磁路定律.md" },
                  { label: "1.3-电机的电磁基本理论", path: "课程总览/电机学/教材解析/第01章-概述/1.3-电机的电磁基本理论.md" },
                  { label: "1.4-电机的制造材料", path: "课程总览/电机学/教材解析/第01章-概述/1.4-电机的制造材料.md" },
                  { label: "第01章-小结与思考题习题", path: "课程总览/电机学/教材解析/第01章-概述/第01章-小结与思考题习题.md" }
                ]
              },
              { label: "第02章-变压器的基本作用原理与理论分析",
                children: [
                  { label: "2.0-通关攻略", path: "课程总览/电机学/教材解析/第02章-变压器的基本作用原理与理论分析/2.0-通关攻略.md" }
                ]
              }
            ]
          },
          { label: "课堂笔记", path: "课程总览/电机学/课堂笔记/index.md",
            children: [
              { label: "09-24-电机概述与磁路", path: "课程总览/电机学/课堂笔记/09-24-电机概述与磁路.md" },
              { label: "10-08-磁路例题与变压器概述", path: "课程总览/电机学/课堂笔记/10-08-磁路例题与变压器概述.md" },
              { label: "10-15-空载运行与负载运行", path: "课程总览/电机学/课堂笔记/10-15-空载运行与负载运行.md" },
              { label: "10-22-参数测定与电压变化率", path: "课程总览/电机学/课堂笔记/10-22-参数测定与电压变化率.md" },
              { label: "10-29-三相变压器与三次谐波", path: "课程总览/电机学/课堂笔记/10-29-三相变压器与三次谐波.md" },
              { label: "11-05-并联运行与瞬态过程", path: "课程总览/电机学/课堂笔记/11-05-并联运行与瞬态过程.md" },
              { label: "11-12-旋转电机与交流绕组", path: "课程总览/电机学/课堂笔记/11-12-旋转电机与交流绕组.md" },
              { label: "11-19-交流绕组电动势与谐波", path: "课程总览/电机学/课堂笔记/11-19-交流绕组电动势与谐波.md" },
            ]
          },
          { label: "原始资料", path: "课程总览/电机学/原始资料/index.md" }
        ]
      },
      {
        label: "劳动教育",
        path: "课程总览/劳动教育/index.md",
        children: [
          { label: "作业", path: "课程总览/劳动教育/作业/index.md" },
          { label: "课堂笔记", path: "课程总览/劳动教育/课堂笔记/index.md",
            children: [
              { label: "10-26-劳动教育导论与考核", path: "课程总览/劳动教育/课堂笔记/10-26-劳动教育导论与考核.md" },
              { label: "11-23-劳动关系与保障", path: "课程总览/劳动教育/课堂笔记/11-23-劳动关系与保障.md" }
            ]
          },
          { label: "原始资料", path: "课程总览/劳动教育/原始资料/index.md" }
        ]
      }
      ,
      {
        label: "通用电气",
        path: "课程总览/通用电气/index.md",
        children: [
          { label: "Walkthrough", path: "课程总览/通用电气/Walkthrough.md" },
          {
            label: "教材解析",
            path: "课程总览/通用电气/教材解析/index.md",
            children: [
              { label: "符号入门", path: "课程总览/通用电气/教材解析/符号入门.md" },
            ]
          },
          {
            label: "交叉内容",
            path: "课程总览/通用电气/交叉内容/index.md",
            children: [
              { label: "01-电路矩阵与消元判解", path: "课程总览/通用电气/交叉内容/01-电路矩阵与消元判解.md" },
              { label: "02-行最简形与通解结构", path: "课程总览/通用电气/交叉内容/02-行最简形与通解结构.md" },
              { label: "03-正弦量、有效值与相量", path: "课程总览/通用电气/交叉内容/03-正弦量、有效值与相量.md" },
              { label: "04-微积分变乘除与复阻抗", path: "课程总览/通用电气/交叉内容/04-微积分变乘除与复阻抗.md" },
              { label: "05-相量加减与仪表读数", path: "课程总览/通用电气/交叉内容/05-相量加减与仪表读数.md" },
              { label: "06-交流功率与电容补偿", path: "课程总览/通用电气/交叉内容/06-交流功率与电容补偿.md" },
              { label: "07-谐振与最大功率匹配", path: "课程总览/通用电气/交叉内容/07-谐振与最大功率匹配.md" },
              { label: "08-非线性器件与Q点隔离", path: "课程总览/通用电气/交叉内容/08-非线性器件与Q点隔离.md" },
              { label: "09-小信号线性化与级间加载", path: "课程总览/通用电气/交叉内容/09-小信号线性化与级间加载.md" },
              { label: "10-差分放大与功率输出级", path: "课程总览/通用电气/交叉内容/10-差分放大与功率输出级.md" },
              { label: "11-理想运放与负反馈判别", path: "课程总览/通用电气/交叉内容/11-理想运放与负反馈判别.md" },
              { label: "12-磁路规律与电磁感应", path: "课程总览/通用电气/交叉内容/12-磁路规律与电磁感应.md" },
              { label: "13-变压器电路化与归算", path: "课程总览/通用电气/交叉内容/13-变压器电路化与归算.md" },
              { label: "14-试验标幺值与效率变化率", path: "课程总览/通用电气/交叉内容/14-试验标幺值与效率变化率.md" },
              { label: "15-三相换算与联结组时钟法", path: "课程总览/通用电气/交叉内容/15-三相换算与联结组时钟法.md" },
              { label: "16-对称分量与三次谐波", path: "课程总览/通用电气/交叉内容/16-对称分量与三次谐波.md" },
              { label: "17-变压器并联与瞬态过程", path: "课程总览/通用电气/交叉内容/17-变压器并联与瞬态过程.md" },
              { label: "18-交流绕组与电动势打折", path: "课程总览/通用电气/交叉内容/18-交流绕组与电动势打折.md" },
              { label: "19-脉振分解与圆形旋转磁场", path: "课程总览/通用电气/交叉内容/19-脉振分解与圆形旋转磁场.md" }
            ]
          }
        ]
      },
      {
        label: "电气前沿",
        path: "课程总览/电气前沿/index.md",
        children: [
          { label: "作业", path: "课程总览/电气前沿/作业/index.md" },
          { label: "课堂笔记", path: "课程总览/电气前沿/课堂笔记/index.md",
            children: [
              { label: "11-09-新质生产力与就业前景", path: "课程总览/电气前沿/课堂笔记/11-09-新质生产力与就业前景.md" },
              { label: "11-16-科技创新与双碳转型", path: "课程总览/电气前沿/课堂笔记/11-16-科技创新与双碳转型.md" },
              { label: "11-23-新型电力系统建设", path: "课程总览/电气前沿/课堂笔记/11-23-新型电力系统建设.md" }
            ]
          },
          { label: "原始资料", path: "课程总览/电气前沿/原始资料/index.md" }
        ]
      }
    ]
  }
];

// Linear sequence for textbook chapters and lecture notes
const TEXTBOOK_ORDER = [
  "课程总览/工程数学/教材解析/符号入门.md",
  "课程总览/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.0-通关攻略.md",
  "课程总览/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.1-二阶与三阶行列式.md",
  "课程总览/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.2-n阶行列式.md",
  "课程总览/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.3-克莱姆法则.md",
  "课程总览/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.4-MATLAB-行列式.md",
  "课程总览/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.0-通关攻略.md",
  "课程总览/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.1-矩阵的概念及运算.md",
  "课程总览/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.2-逆矩阵.md",
  "课程总览/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.3-初等变换与矩阵.md",
  "课程总览/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.4-矩阵的秩.md",
  "课程总览/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.5-MATLAB-矩阵运算.md"
];

// 2026-10-24（issue #18 决策 #9）补 2026-10-08 那篇——NOTES_ORDER 只列 3 条时第 4 篇
// 笔记永远拿不到下一节分页（审计 γ P1-2）。派生化（从文件系统枚举）列为后续项。
const NOTES_ORDER = [
  "课程总览/工程数学/课堂笔记/09-17-行列式与沙路法则.md",
  "课程总览/工程数学/课堂笔记/09-17-课堂听课整理.md",
  "课程总览/工程数学/课堂笔记/09-24-降阶法与克拉默法则.md",
  "课程总览/工程数学/课堂笔记/10-08-矩阵与逆.md"
];

const markdownRenderer = createMarkdownRenderer();

// 外置共享导航树与站点页面清单（Q19）：构建期单次产出，带内容哈希 URL 供浏览器缓存，不再每页重复内联 ~50 KB。
const sharedNavModel = buildNavModel(NAV_STRUCTURE, null);
fs.writeFileSync(path.join(DIST_DIR, 'assets', 'nav-structure.json'),
  JSON.stringify({ v: 1, nodes: sharedNavModel.nodes }) + '\n', 'utf-8');
fs.writeFileSync(path.join(DIST_DIR, 'assets', 'site-pages.json'),
  JSON.stringify(SITE_PAGE_PATHS) + '\n', 'utf-8');
const NAV_JSON_ASSET_URL = assetUrl('assets/nav-structure.json');
const PAGES_JSON_ASSET_URL = assetUrl('assets/site-pages.json');
const SEARCH_CSS_ASSET_URL = assetUrl('assets/plugins/site-search.css');
const SEARCH_JS_ASSET_URL = assetUrl('assets/plugins/site-search.js');
const SPA_JS_ASSET_URL = assetUrl('assets/plugins/spa-router.js');
const HELPERS_JS_ASSET_URL = assetUrl('assets/plugins/site-helpers.js');

// 4. Build each page
let totalFormulasRendered = 0;
let formulaErrors = 0;
// 符号覆盖（2026-11-05）：锚点数从**最终产物**量（measurePage，公式+正文令牌+图内
// 三路都算；renderOneMath 的 out.anchors 只覆盖公式一路，不当全站口径），
// 「未冒泡」明细由 diagnosePage 把逐页警告与产物信号去重合成。不重跑形状匹配。
let totalSymbolsBubbled = 0;
const symbolUncovered = [];
/** 符号**缺口**：公式里出现但词条没覆盖的形状（跨页累加）。 */
const symbolGaps = [];
const symbolCoveragePages = [];
/** 引用了但磁盘上没有的配图（多半是白名单漏了 → 从未入库，CI 上缺图）。 */
const missingFigureRefs = new Set();
/** machine/ 映射：每页的结构化数据（公式 TeX + 配图），构建期从管线现成数据收集。 */
const machinePages = [];

const symbolPageWarns = [];
for (const relPath of TARGET_FILES) {
  const fullPath = path.join(ROOT, relPath);
  if (!fs.existsSync(fullPath)) continue;

  let raw = fs.readFileSync(fullPath, 'utf-8');
  const pageMeta = pageMetaMap.get(relPath);

  const courseOf = (p) => String(p).split('/')[1] || '';
  const here = courseOf(relPath || path.relative(ROOT, fullPath));

  // 气泡文本在构建期处理好：① 先转义 HTML；② 把 $…$ 渲染成 KaTeX（词条里就能写真分式
  // `\frac`，而不是拿斜杠或 unicode 上下标凑）；③ 文本里若出现 [tex]{#id} 令牌写法，
  // 保持字面——气泡里不套气泡。**标题与文本走同一条路**（气泡顶上的 `B_r：…` 也该是真公式）。
  // 客户端两者都用 innerHTML 插入（见 GLOSSARY_JS）。
  // ⚠ 顺序神圣：**公式先渲染，其余文本后转义**。反过来（先转义再渲染公式）会把
  // `$X>0$` 里的 > 先变成 `&gt;`，KaTeX 拿到 `X&gt;0` 直接 ParseError、红字原样
  // 吐回页面（2026-10-10 实弹：符号入门页 4 处公式在气泡里字面显示）。
  const escapeHtmlText = (t) =>
    t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // 气泡里的公式：**用空词库编译**。
  // 这不是「记得别取词」的约定，是结构保证：词库为空 ⇒ 判定器手里没有词条
  // ⇒ 结构上产不出锚点 ⇒ 「气泡里套气泡」没有对应的代码路径。
  // 旧实现靠一条禁令加一层 `peelNotationFences` 剥壳，仍会漏。
  //
  // ## 处理顺序：**公式先变占位符 → 再处理行内标记 → 最后把公式插回**
  //
  // 2026-10-29 修（用户报「气泡里裸 `**`」）：原先按 `$…$` 分段、只对奇数段做转义，
  // 于是 `**不是 $1/A$**` 这种「粗体包住一处公式」的写法被切成
  // `**不是 ` + 公式 + `**` 三段，粗体的两个星号落在不同段里，永远配不上。
  // 这不是正则写得不够好，而是**顺序错了**：一旦先把公式切走，跨公式的标记就不可能再配对。
  //
  // 正确顺序：先把公式换成不含任何标记字符的占位符（`\u0000MATH<i>\u0000`），
  // 于是整段文字重新连成一个字符串，`**…**` 可以横跨公式位置正常配对；
  // 处理完粗体/反引号，再把占位符换回渲染好的公式 HTML。
  //
  // 只支持**两种**行内标记（粗体、反引号代码），刻意不上 full markdown：
  // 气泡是「一句话释义」不是文档；未闭合的孤立 `**` 原样保留——宁可看见一个星号，
  // 也不要把句子吞掉。
  const renderBubbleText = (s) => {
    const pieces = [];
    const NUL = String.fromCharCode(0);
    // ① 抽走公式 → 占位符（NUL 不会出现在正常文本里，也不会被正则的 * ` $ 匹配到）
    let text = String(s).replace(/\$([^$\n]+)\$/g, (m, tex) => {
      const out = compileMath({ blocks: [{ raw: tex, mode: 'inline' }] },
        { dictionary: symbolCatalog.mathDictionary, packs: [] });
      const bad = out.problems.filter((x) => x.severity === 'error');
      let html;
      if (bad.length) {
        formulaErrors++;
        console.warn(`[build] ⚠ 气泡公式渲染失败 ${relPath}：${bad[0].message}｜${tex.slice(0, 60)}`);
        html = escapeHtmlText(m);
      } else {
        html = renderMathDoc(out.docs[0], mathRenderer).html;
      }
      const idx = pieces.length;
      pieces.push(html);
      return `${NUL}M${idx}${NUL}`;
    });
    // ② 处理行内标记（此时公式已成占位符，粗体可以横跨公式配对）
    text = escapeHtmlText(text);
    text = text.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/`([^\n]+?)`/g, '<code>$1</code>');
    // ③ 公式插回
    return text.replace(new RegExp(`${NUL}M(\\d+)${NUL}`, 'g'), (_m, i) => pieces[Number(i)] ?? '');
  };

  const fmParsed = parseFrontmatter(raw, { strict: true, filePath: `${relPath}（渲染遍）` });
  const frontmatter = fmParsed.meta;
  raw = fmParsed.body.trim();

  // Strip HTML comments (like AUTO-CATALOG)
  raw = raw.replace(/<!--[\s\S]*?-->/g, '');
  // 已结案的 issue ⇒ 构建期自动隐去「## 完成边界」栏
  raw = stripClosedBoundary(raw, ISSUE_STATES);

  // 打开本页符号会话（唯一环境装配 + 强制/排除 + 规范键包:词条）
  const symSession = symbolCatalog.openPage({ relPath, frontmatter, course: here });

  // Step 1: Protect Code Fences
  const codeBlocks = [];
  raw = raw.replace(/(```|~~~)(\w*)\r?\n([\s\S]*?)\r?\n\1/g, (_, fence, lang, code) => {
    const id = codeBlocks.length;
    codeBlocks.push({ lang: lang || 'text', code });
    return `@@CODE_FENCE_${id}@@`;
  });

  // Protect Inline Code
  const inlineCodes = [];
  raw = raw.replace(/`([^`\n]+)`/g, (_, code) => {
    const id = inlineCodes.length;
    inlineCodes.push(code);
    return `@@INLINE_CODE_${id}@@`;
  });

  // Step 2: Extract and Render Math
  const mathBlocks = [];

  // 2.1 Display Math $$...$$
  raw = raw.replace(/\$\$([\s\S]+?)\$\$(?:[ \t]*\{:\s*calc\s*\})?/g, (whole, tex) => {
    const id = mathBlocks.length;
    totalFormulasRendered++;
    const src = tex.trim().replace(/[.。，、；;][ \t]*$/, '');
    const { rendered, plain } = renderOneMath(src, 'display', relPath, symSession);
    mathBlocks.push({ display: true, html: rendered, plain, tex: src });
    return `@@MATH_BLOCK_${id}@@`;
  });

  // 2.2 Inline Math $...$（位于显式符号令牌 `[$tex$]{#id}` 内的公式不计入默认环境 hits）
  raw = raw.replace(/(?<!\$)\$(?!\$)((?:[^$\\\r\n]|\\.)+?)\$(?!\$)/g, (match, tex, offset, full) => {
    const isExplicitToken = offset > 0 && full[offset - 1] === '['
      && /^\]\{#(?:[^\]\n{}:]+:)?[A-Za-z_][A-Za-z0-9_-]*\}/.test(full.slice(offset + match.length));
    const id = mathBlocks.length;
    totalFormulasRendered++;
    const { rendered, plain } = renderOneMath(tex.trim(), 'inline', relPath, symSession, { record: !isExplicitToken });
    mathBlocks.push({ display: false, html: rendered, plain, tex: tex.trim() });
    return `@@MATH_INLINE_${id}@@`;
  });

  // Step 2.4: 图元 :::figure → @@FIGURE_n@@ 占位符
  {
    const courseName = courseOf(relPath);
    const libFile = courseName ? `站点/图库/${courseName}.figures.txt` : null;
    const libPath = libFile ? path.join(ROOT, libFile) : null;
    if (raw.includes(':::figure')) {
      if (!courseName) {
        throw new Error(`${relPath}：页面里有 :::figure，但它不属于任何课程（无法定位图库）`);
      }
      if (!libPath || !fs.existsSync(libPath)) {
        throw new Error(`${relPath}：页面里有 :::figure，但图库 ${libFile} 不存在——先建图库或去掉该指令`);
      }
    }
  }

  // Step 2.5: 折叠块 :::collapse → 原生 <details>
  raw = renderCollapse(raw);

  // Step 2.6: 符号气泡与总表（委托给符号深核心页会话）
  const renderDictTable = (entries) =>
    [
      '<table>',
      '<thead><tr><th>符号</th><th>含义</th></tr></thead>',
      '<tbody>',
      ...entries.map(
        (e) =>
          `<tr id="${e.id}"><th scope="row">${renderBubbleText(e.title)}</th>` +
          `<td>${renderBubbleText(e.text)}</td></tr>`,
      ),
      '</tbody>',
      '</table>',
    ].join('\n');

  raw = symSession.resolveProse(raw, {
    resolvePlaceholderTex: (tex) => {
      const ph = /^@@MATH_INLINE_(\d+)@@$/.exec(tex.trim());
      return ph ? (mathBlocks[Number(ph[1])]?.tex ?? tex) : tex;
    },
    renderTex: (realTex) => {
      const out = compileMath({ blocks: [{ raw: realTex, mode: 'inline' }] },
        { dictionary: symbolCatalog.mathDictionary, packs: [] });
      if (out.problems.some((x) => x.severity === 'error')) {
        return `<span class="math-fallback">${realTex.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</span>`;
      }
      return renderMathDoc(out.docs[0], mathRenderer).html;
    },
    renderDictTable,
  });

  const symBundle = symSession.finalize({ renderBubbleText, plainBubbleText });
  const glossaryJsonPayload = symBundle.glossaryJsonPayload;

  // Step 3: Degrade Non-MD resources (.jpg, .heic, .doc)
  raw = raw.replace(/\[([^\]]*)\]\(([^)]+\.(?:jpg|heic|doc))\)/gi, (_, text, filePath) => {
    const baseName = path.basename(filePath);
    return `<span class="res-degrade-badge">📄 原件: ${baseName} (原件不入库，网页不提供)</span>`;
  });

  // Degrade template links
  // ⚠️ 必须同时匹配 `.md` 与 `.html`：本步（Step 3）跑在「.md → 网址」换算（Step 4）**之前**，
  // 源文件里写的是 `../模板/课程索引.md`。此前只按 `模板/` 前缀匹配、却因为正则里带了
  // 扩展名限制而漏网，于是 Step 4 把它换成 `.html` 后就成了一条指向不存在文件的链接
  // （2026-10-30 体检残留 32 处）。
  raw = raw.replace(/\[([^\]]*)\]\(([^)]*模板\/[^)]*)\)/gi, (_, text) => {
    return `<span class="res-degrade-badge">📋 ${text} (模板不随站点发布)</span>`;
  });

  // ⚠️ 2026-10-30（体检抓到 61 处死链）：**两类文件在仓库里、但不随站点发布**，
  // 而正文把它们写成了链接 ⇒ 线上全是 404。此前只在「登记表」里写着「原件不入库、
  // 网页不提供」，链接本身却照旧是 `<a href>`，点下去就是 404 页。
  //
  // 为什么**不发布**而是降级：
  //   · `*-原文.txt` 是课堂录音的逐字转写（体量上万字、含口语与口误），
  //     它们是**整理者的工作底稿**，不是给读者读的成品；读者要的是同一目录下的
  //     课堂笔记。发布它们等于把底稿当成品发出去。
  //   · `AGENTS.md` 与 `.agents/skills/**` 是**给 AI 助手用的内部规程**（skill 路由表、
  //     硬约束、维护流程），与站点读者无关，且其中含仓库内部操作细节。
  // 两类都改成「纯文本 + 一句出处说明」，点不动但也不会 404。
  raw = raw.replace(/\[([^\]]*)\]\(([^)]*\.txt)\)/gi, (_, text, filePath) => {
    const baseName = path.basename(decodeURIComponent(filePath));
    return `<span class="res-degrade-badge" title="${baseName}">📄 ${text}<span class="res-degrade-note">（转写底稿，随仓库保存，站点不发布）</span></span>`;
  });
  raw = raw.replace(/\[([^\]]*)\]\(([^)]*(?:AGENTS\.md|\.agents\/)[^)]*)\)/gi, (_, text) => {
    const label = text.replace(/`/g, '');
    return `<span class="res-degrade-badge">📘 ${label}<span class="res-degrade-note">（仓库内规程，站点不发布）</span></span>`;
  });

  // Step 4: Rewrite internal Markdown links (.md → 站内网址)
  //
  // 2026-10-29「大一统最后一步」：**索引页一律写成目录形式，全站不再出现 index.html 链接**。
  // 此前这里把 `.md` 一律换成 `.html`，于是正文里的 `../原始资料/index.md` 变成
  // `../原始资料/index.html`——而侧栏与面包屑早已改用 `../原始资料/`（目录形式）。
  // 同一页因此有了两个网址，且 markdown 那一份最后一段是 `index`，与层名对不上。
  //
  // 规则与 `htmlPathOf` 一致，但这里拿到的是**相对路径**（`../a/b.md`），
  // 不是仓库相对路径，所以不能直接调它：
  //   · 以 `index.md` 结尾 → 去掉 `index.md`，保留目录部分（含尾斜杠）
  //   · 其余 `.md` → `.html`
  // 锚点挂在目录上：`index.md#foo` → `#foo`。
  const rewriteMdLink = (match, text, href) => {
    if (/^(https?:\/\/|#|mailto:)/.test(href)) return match;
    try {
      const decoded = decodeURIComponent(href);
      if (!decoded.includes('.md')) return match;
      const m = /^(.*?)index\.md(#.*)?$/.exec(decoded);
      if (m) {
        const base = m[1] || './';
        return `[${text}](${encodeURI(base + (m[2] || ''))})`;
      }
      return `[${text}](${encodeURI(decoded.replace(/\.md(#.*)?$/, '.html$1'))})`;
    } catch {
      return match;
    }
  };
  raw = raw.replace(/\[([^\]]+)\]\(([^)]+)\)/g, rewriteMdLink);

  // Step 5: Render Markdown to HTML
  //
  // 标题锚点、表格滚动容器、分级与 ARIA 由 markdown.mjs 的站点策略生成。
  let htmlContent = markdownRenderer.render(raw);

  // Step 6: Restore Code Fences
  htmlContent = htmlContent.replace(/@@CODE_FENCE_(\d+)@@/g, (_, id) => {
    const block = codeBlocks[parseInt(id)];
    const escaped = block.code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<div class="code-fence-wrapper">
      <div class="code-fence-header">
        <span>${block.lang}</span>
        <button class="copy-btn">复制</button>
      </div>
      <pre><code>${escaped}</code></pre>
    </div>`;
  });

  // Restore Inline Code
  htmlContent = htmlContent.replace(/@@INLINE_CODE_(\d+)@@/g, (_, id) => {
    const code = inlineCodes[parseInt(id)];
    const escaped = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<code>${escaped}</code>`;
  });

  // Restore Math
  htmlContent = htmlContent.replace(/@@MATH_BLOCK_(\d+)@@/g, (_, id) => {
    const math = mathBlocks[parseInt(id)];
    // ⚠️ **这里不能再套一层容器**（2026-11-01 站长报「包的框数量越来越多」）。
    //
    // display 公式的 `html` 已经是 renderOneMath 的产物
    // （`<div class="math-display katex-scroll-container">…`，见上面 Step 2.1），
    // 而这一层原本无条件再包一次 `katex-scroll-container` —— 于是每个块级公式
    // 外面套了**两层同样带边框的框**。截图里「外框 + 内框」就是这么来的。
    //
    // 判据：容器由**生产方**负责（renderOneMath 知道这是 display 公式），
    // 消费方只管把占位符换成 HTML。两处都包 = 两层框，而且改样式时不知道该改哪层。
    return math.html;
  });

  // ⚠️ 2026-10-30 真 bug（站长截图：表格里冒字面 `">`、整行被拆成竖排）：
  // 表头里若含行内公式，构建期它先变占位符 `@@MATH_INLINE_N@@`、再被写进
  // `data-label="…"` 属性。而这一步的替换**无条件塞完整 HTML**——
  // 那串 HTML 自带 `class="ML__latex"` 之类的双引号，一进属性就把属性闭死，
  // 余下的标签全成了单元格里的游离文本（页面上就是 `">` 残片 + 错位的行）。
  //
  // 判据：占位符若出现在**属性值里**（前面最近的引号是属性开引号），
  // 就只能换成纯文本投影，绝不能换 HTML。
  const inAttribute = (full, pos) => {
    // 从 pos 往回找最近的 `<tag`，看它到 pos 之间是否有一个未闭合的 `"`
    const since = full.lastIndexOf('<', pos);
    if (since < 0) return false;
    const seg = full.slice(since, pos);
    const q = (seg.match(/"/g) || []).length;   // 计数场景：要全部匹配（exec 只给第一个）
    return q % 2 === 1;          // 落在某个属性值内部
  };
  htmlContent = htmlContent.replace(/@@MATH_INLINE_(\d+)@@/g, (whole, id, offset) => {
    const math = mathBlocks[parseInt(id)];
    if (inAttribute(htmlContent, offset)) {
      // 纯文本投影（`data-math-plain` 就是它），再转义成属性安全形式
      return escHtml(math.plain || '');
    }
    return math.html;
  });

  // Step 6.5: 图元还原 @@FIGURE_n@@ → 完整 <figure>（2026-10-28）
  //
  // 为什么放到这么晚：Step 2.6 的 autoWrapTerms 会伸手进正文把术语包成令牌，
  // 那一刻正文里**必须还没有 SVG**（否则它会把 `<text>B</text>` 改成
  // `<text>[B]{#sym-B}</text>`，随后产生非法的 `<text><a>B</a></text>`）。
  // marked 也已经跑完，SVG 里的 `*`、`|`、`[]()` 不会被当 Markdown 语法。

  // Extract TOC headings —— **必须在公式还原之后**。
  //
  // 曾经的顺序是「marked 之后立刻提取 TOC、再还原公式」，结果是标题里的公式
  // 还是占位符，锚点变成 `#第一步-处理前两行-提出-math_inline_125` 这种脏值，
  // 点击目录跳转直接失效（dist 里可见）。
  // 现在改为：① marked 之前先把**标题行**里的占位符换成纯文本（供 id 生成）；
  //           ② 公式还原之后再提取 TOC，此时标题已是真 HTML，取纯文本即可。
  const toc = [];
  const headingRegex = /<h([23]) id="([^"]+)">([\s\S]*?)<\/h[23]>/g;
  let hMatch;
  while ((hMatch = headingRegex.exec(htmlContent)) !== null) {
    // TOC 标题取纯文本：**先把公式容器整块换成它的纯文本投影，再剥标签**。
    //
    // 直接 `<[^>]+>` 剥标签会把一个公式的排版结构（无数嵌套 span 的分子分母）
    // 拼成一串重复文字——实测 `(A\mid E)` 在目录里印成 `(A∣E)(A\mid E)(A∣E)`
    // （2026-10-28 三签抓出）。
    // 2026-10-29 换引擎后判据变了：不再读 annotation（MathLive 不产），
    // 改读构建期烘的 `data-math-plain`（IR 的纯文本投影）。
    const rawTitle = replaceKatexWithText(hMatch[3])
      .replace(/<[^>]+>/g, '')
      .replace(/\{#([^}\s]+)\}/g, '')   // 万一残留显式锚点标记
      .replace(/\s+/g, ' ')
      .trim();
    toc.push({
      level: parseInt(hMatch[1]),
      id: hMatch[2],
      title: rawTitle,
    });
  }

  // Step 7: Compute relative path to root for assets
  const targetHtmlPath = relPath === 'README.md' ? 'index.html' : relPath.replace(/\.md$/, '.html');
  const depth = targetHtmlPath.split('/').length - 1;
  const rootRel = depth === 0 ? './' : '../'.repeat(depth);

  // `body[data-site-path]` 用**网址**形态（与侧栏 JSON 的 href 同一空间，drawer-sync 要靠它
  // 比对 active）。唯一的例外是首页：它的网址是 `''`（站点根），而 site-root 的部署根探测
  // 需要一段非空后缀才能对齐 pathname，所以首页写物理名 `index.html`
  // （首页已不挂侧栏，不需要 active，写文件名无副作用）。
  const sitePathOf = (p) => htmlPathOf(p) || filePathOf(p);

  // 配图（作业 figures/）**保持页面内写的那份纯相对路径**（`figures/xxx.png`）。
  // 2026-10-11 修：此前统一改写成「站点根相对」（`../../../课程总览/…/figures/…`），
  // 而浏览器会把含非 ASCII 的文档 URL 规范成百分号编码形式——从编码 URL 出发上溯、
  // 再拼中文目录段，解析结果不稳定，实测习题册第一章 35 张图里 33 张加载失败。
  // 图片是「作业/figures/」下的子目录，纯相对路径按文档 URL 解析，中文与编码两种
  // 文档 URL 都指向同一份文件，因此不再改写。
  // （页面到页面的 md 链接改写见 Step 4，那是另一回事，仍走站点根相对。）
  // 配图 src 追加查询串 ?v=<源文件mtime>：源图变了 URL 才变（取源文件而非 dist 产物——
  // dist 每轮重建、mtime 不稳定），浏览器/CDN 里残留的坏图缓存随 URL 更换自愈，
  // 不依赖秒级 Last-Modified 校验。
  // 源文件不存在 = 这张图**从未入库**（2026-10-12 实弹：白名单后缀写成 .jpg，实际是 .png，
  // git add 被静默挡下，本地有文件所以看不出来，CI 上就是缺图）——显式警告，别静默。
  htmlContent = htmlContent.replace(/src="(figures\/[^"?]+)"/g, (m, p1) => {
    try {
      const v = Math.floor(fs.statSync(path.join(ROOT, path.dirname(relPath), p1)).mtimeMs);
      return `src="${p1}?v=${v}"`;
    } catch (_) {
      missingFigureRefs.add(`${path.dirname(relPath)}/${p1}`);
      return m;
    }
  });

  // Compute Breadcrumbs —— **完全由网址路径推出**（2026-10-29 站长定案）。
  //
  // ## 为什么不再逐课硬编码
  //
  // 旧实现是一串 `if (relPath.startsWith('课程总览/工程数学/'))` + 每类目录一条
  // `else if`。后果实测：作业页漏掉「作业」这一层（只处理了教材解析与课堂笔记），
  // 面包屑显示「工程数学 / 作业3」而实际网址是 `课程总览/工程数学/作业/…`——
  // 三套结构（网址、侧边栏、面包屑）里只有面包屑是错的。
  //
  // 现在：把 relPath 的目录链逐段查 NAV_STRUCTURE 里的同路径节点，拿到 label。
  //   ① 单一真相＝网址（目录结构本身就是分类）；
  //   ② 侧边栏与面包屑都从 NAV_STRUCTURE 取 label，而 NAV_STRUCTURE 的 path 与
  //      真实目录逐段一致（150 个节点实测 0 处前缀不符）⇒ 三者天然统一；
  //   ③ 新增一类目录时，只要目录存在、侧栏有入口，面包屑自动正确，不用改代码。
  //
  // dataPath：仓库相对 html 路径——面包屑在 .article-content 之外（SPA 换页不替换），
  // 带 data-path 后点击委托与侧栏同款走「data-root + data-path」拼接。
  const navLabelByMdPath = new Map();
  (function collectLabels(nodes) {
    for (const n of nodes) {
      if (n.path) navLabelByMdPath.set(n.path, n.label);
      if (n.children) collectLabels(n.children);
    }
  })(NAV_STRUCTURE);

  const breadcrumbs = [];
  {
    // 面包屑的 `href` / `dataPath` 写**事实上指向的网址**，不是产物文件名
    // （2026-10-29 站长定案：「/ 事实意义上指向 README 页，/课程总览 也事实意义上指向
    //  课程总览索引」）。所以：
    //   · 首页 → `/`（README 就是站点根），不写 `index.html`；
    //   · 目录层 → `/课程总览/`、`/课程总览/工程数学/` …（该层的 index 页）。
    // 这样面包屑文字（`首页`、`课程总览`）与该层网址的最后一段逐字相同，
    // 「三条逐字一致」才真的成立——写 `index.html` 时最后一段是 `index`，多一层噪声。
    //
    // 目录形式能被托管层直接服务（实测 `/`、`/课程总览/`、`/课程总览/工程数学/作业/`
    // 全部 200；不带尾斜杠 301 到带斜杠）。所以写目录是安全的，且不依赖 index.html 的存在。
    //
    // `data-path` 与 `href` 同形（都是网址形态）：site-root 与 SPA 用它拼 URL，
    // 二者若形态不同，线上就会分叉成两个网址。
    // ⚠️ **不挂「首页」crumb**（2026-10-30 站长定案，此前 10-29 只做了一半）：
    // `/` 就是「S26-1 课程知识库」那一页本身，面包屑再写一格「首页」是把同一件事
    // 说两遍、还多一条与网址末段不逐字相同的链接（`首页` vs ``）。
    // 回首页由侧栏品牌区块与大标题承担。于是面包屑首项恒为 `课程总览`，
    // 与网址逐段对齐：面包屑有几格 = 网址有几层目录。
    // 从 `课程总览/` 开始逐段：`课程` → `课程总览/<课>` → `课程总览/<课>/<分类>` …
    // i 从 0 起：第 0 段就是 `课程`，对应「课程总览」那一层。
    const segs = relPath.replace(/\.md$/, '').split('/');
    // 逐段出 crumb —— **网址有几层目录，面包屑就几层**。
    //
    // 站长定案「三条逐字一致」：段名直接用目录名，不再查侧栏 label 表
    // （那张表在无 index 的组节点上会漏层——`第3章-n维向量与向量空间` 就没有 index.md，
    // 于是面包屑少了整章一层，而侧栏与网址都有）。
    // 目录名本身就是可读的短标签（文件名已按标签改过），所以直接用它。
    // 有 index.md 的层给可点链接，没有的只是文字（无页面可去）。
    for (let i = 0; i < segs.length - 1; i += 1) {   // 最后一段是页面自己，单独处理
      const dirName = segs[i];
      const dirMd = segs.slice(0, i + 1).join('/') + '/index.md';
      const hasIndex = navLabelByMdPath.has(dirMd);
      // 该层网址 = htmlPathOf(该层 index.md) —— `课程总览/index.md` → `课程总览/`。
      // 不在这里手拼斜杠：网址规则只有 htmlPathOf 一处（本轮大一统的正题）。
      const dirPath = htmlPathOf(dirMd);
      breadcrumbs.push({
        label: dirName,
        href: hasIndex ? `${rootRel}${dirPath}` : '#',
        ...(hasIndex ? { dataPath: dirPath } : {}),
      });
    }
  }
  // 当前页标签 = **文件名**（去掉 .md），不是页面 H1。
  // 站长定案「三条逐字一致」：网址最后一段就是文件名，所以面包屑末项只能用它。
  // H1 与标签在 144 条上已经一致（会话内实测），但个别页 H1 带括注（`习题册第一章（43 题）`），
  // 名称与网址不同 → 以网址为准，面包屑显示 `习题册第一章`。
  {
    // 索引页（`…/index.md`）本身就是它那层目录，不该再挂一个「index」末端。
    // 网址是 `…/作业/index.html`，而读者看到的层级就是「作业」——加 index 是多一层噪声。
    const segs2 = relPath.replace(/\.md$/, '').split('/');
    const isIndexPage = segs2[segs2.length - 1] === 'index';
    // 首页（网址就是 `/`）**不挂面包屑**——它自己就是根，再写一个「S26-1 课程知识库」
    // 是同一句话重复一遍。侧栏没有首页项、品牌与大标题已承担回首页，
    // 面包屑在首页上没有需要表达的层级。2026-10-29 站长定案的直接推论。
    const isRootPage = relPath === 'README.md';
    if (!isIndexPage && !isRootPage) {
      breadcrumbs.push({ label: segs2[segs2.length - 1], href: '#' });
    }
  }

  // Compute Paging (Prev / Next)
  let prevPage = null;
  let nextPage = null;

  if (TEXTBOOK_ORDER.includes(relPath)) {
    const idx = TEXTBOOK_ORDER.indexOf(relPath);
    if (idx > 0) prevPage = pageMetaMap.get(TEXTBOOK_ORDER[idx - 1]);
    if (idx < TEXTBOOK_ORDER.length - 1) nextPage = pageMetaMap.get(TEXTBOOK_ORDER[idx + 1]);
  } else if (NOTES_ORDER.includes(relPath)) {
    const idx = NOTES_ORDER.indexOf(relPath);
    if (idx > 0) prevPage = pageMetaMap.get(NOTES_ORDER[idx - 1]);
    if (idx < NOTES_ORDER.length - 1) nextPage = pageMetaMap.get(NOTES_ORDER[idx + 1]);
  }

  // 侧栏形状 = 唯一真相源 nav-structure.mjs（阶段一，2026-10-21）。
  // buildNavModel 产出归一化节点树；本处只直出顶层与当前激活分支，折叠分支按需水合。
  const navModel = buildNavModel(NAV_STRUCTURE, relPath);

  // Render Sidebar Tree HTML with Collapsible Groups
  // 每个 <li> 带 data-node-id（归一化节点 id）：SPA 换页后 drawer-sync 据此对齐 active。
  const attrEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const renderNavGroup = (node, nodeActive, nodeExpanded) => {
    const titleHtml = node.indexHref
      ? `<a href="${rootRel}${node.indexHref}" data-path="${node.indexHref}" class="drawer-nav-link"><span>${node.label}</span></a>`
      : `<span class="drawer-section-title-text">${node.label}</span>`;
    const childrenHtml = nodeExpanded ? renderNav(node.children) : '';
    const lazyAttr = nodeExpanded ? '' : ' data-nav-lazy="1"';
    let out = '';
    out += `<li class="drawer-nav-group ${nodeActive ? 'active' : ''} ${nodeExpanded ? 'expanded' : 'collapsed'}" data-node-id="${attrEsc(node.id)}"${lazyAttr}>
          <div class="nav-group-header ${node.indexHref ? '' : 'nav-header-clickable'}">
            ${titleHtml}
            <button class="nav-collapse-btn" aria-label="折叠或展开 ${node.label}" title="折叠/展开">
              <svg class="chevron-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>
            </button>
          </div>
          <div class="nav-nested-wrapper">
            <div class="nav-nested">
              ${childrenHtml}
            </div>
          </div>
        </li>`;
    return out;
  };
  const renderNavLeaf = (node, nodeActive) => (node.href
    ? `<li class="drawer-nav-item ${nodeActive ? 'active' : ''}" data-node-id="${attrEsc(node.id)}">
            <a href="${rootRel}${node.href}" data-path="${node.href}" class="drawer-nav-link">
              <span>${node.label}</span>
            </a>
          </li>`
    : `<li class="drawer-section-title" data-node-id="${attrEsc(node.id)}">${node.label}</li>`);
  function renderNav(nodes) {
    let out = '<ul class="drawer-nav-list">';
    for (const node of nodes) {
      const nodeActive = isActive(node, relPath);
      out += node.children?.length
        ? renderNavGroup(node, nodeActive, isExpanded(node, relPath))
        : renderNavLeaf(node, nodeActive);
    }
    out += '</ul>';
    return out;
  }

  const drawerHtml = renderNav(navModel.nodes);

  // Render Frontmatter Meta Chips
  // 状态**不读 frontmatter**（2026-10-11 定案）：从 README 的课程状态表继承。
  // 资料页没有 course 字段时（如 README 自身）就不出状态 chip。
  const courseName = frontmatter.course || (relPath.startsWith('课程总览/') ? relPath.split('/')[1] : '');
  const inheritedStatus = courseName ? COURSE_STATUS.get(courseName) : undefined;
  let metaChipsHtml = '';
  if (frontmatter.course) metaChipsHtml += `<span class="meta-chip primary">📚 ${frontmatter.course}</span>`;
  if (frontmatter.category) metaChipsHtml += `<span class="meta-chip">🏷️ ${frontmatter.category}</span>`;
  if (inheritedStatus) metaChipsHtml += `<span class="meta-chip">⚡ 状态: ${inheritedStatus}</span>`;
  if (frontmatter.last_updated) metaChipsHtml += `<span class="meta-chip">📅 更新: ${frontmatter.last_updated}</span>`;
  if (frontmatter.sources) metaChipsHtml += `<span class="meta-chip">📖 来源: ${Array.isArray(frontmatter.sources) ? frontmatter.sources.join(', ') : frontmatter.sources}</span>`;

  // Helper to format paging cards cleanly and prevent orphan single character on line break
  function formatPagingCard(page) {
    if (!page || !page.title) return { title: '', pages: '' };
    let rawTitle = page.title.trim();
    let pagesTag = '';
    const match = /[（(](原书\s*p[^）)]+)[）)]/.exec(rawTitle);
    if (match) {
      pagesTag = match[1];
      rawTitle = rawTitle.replace(/[（(]原书\s*p[^）)]+[）)]/, '').trim();
    }
    // Prevent orphan single character at the end of the title
    if (rawTitle.length > 3) {
      const head = rawTitle.slice(0, -2);
      const tail = rawTitle.slice(-2);
      rawTitle = `${head}<span class="paging-tail">${tail}</span>`;
    }
    return { title: rawTitle, pages: pagesTag };
  }

  // Render Paging HTML
  let pagingHtml = '';
  if (prevPage || nextPage) {
    pagingHtml = '<div class="m3-paging-container">';
    if (prevPage) {
      const p = formatPagingCard(prevPage);
      pagingHtml += `<a class="paging-card paging-prev" href="${rootRel}${prevPage.urlRelPath}" data-path="${prevPage.urlRelPath}">
        <div class="paging-label-row">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          <span class="paging-label">上一节</span>
          ${p.pages ? `<span class="paging-pages-badge">${p.pages}</span>` : ''}
        </div>
        <span class="paging-title">${p.title}</span>
      </a>`;
    }
    if (nextPage) {
      const p = formatPagingCard(nextPage);
      pagingHtml += `<a class="paging-card paging-next" href="${rootRel}${nextPage.urlRelPath}" data-path="${nextPage.urlRelPath}">
        <div class="paging-label-row paging-label-row-next">
          <div class="paging-label-group">
            <span class="paging-label">下一节</span>
            ${p.pages ? `<span class="paging-pages-badge">${p.pages}</span>` : ''}
          </div>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </div>
        <span class="paging-title">${p.title}</span>
      </a>`;
    }
    pagingHtml += '</div>';
  }

  // Render TOC HTML
  let tocHtml = '';
  if (toc.length > 0) {
    tocHtml = `<aside class="m3-toc">
      <div class="toc-resizer" id="toc-resizer" title="按住拖拽调整目录宽度，双击恢复默认宽度"></div>
      <div class="toc-title">目录</div>
      <ul class="toc-list">
        ${toc.map(item => `<li class="toc-item level-${item.level}"><a href="#${item.id}">${item.title}</a></li>`).join('')}
      </ul>
    </aside>`;
  }

  const hasMath = mathBlocks.length > 0;
  const hasGlossary = Object.keys(glossaryJsonPayload.terms || {}).length > 0 || /data-term=/.test(htmlContent);

  // Final HTML Document
  const finalHtml = `<!DOCTYPE html>
<html lang="zh-CN" data-depth="${rootRel === './' ? 0 : rootRel.split('../').length - 1}" data-root="${rootRel}" data-canonical-root="${CANONICAL_ROOT}" data-nav-path="${NAV_JSON_ASSET_URL}" data-pages-path="${PAGES_JSON_ASSET_URL}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${pageMeta.title === SITE_NAME ? SITE_NAME : `${pageMeta.title} | ${SITE_NAME}`}</title>
  <script>
  /* 首帧前应用已保存的主题色与明暗，避免先用默认色渲染再变色（闪光弹 + 二次全量重绘） */
  (function () {
    try {
      var root = document.documentElement;
      var m = localStorage.getItem("theme") ||
        (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      root.setAttribute("data-theme", m === "dark" ? "dark" : "light");
      var hue = localStorage.getItem("theme-hue");
      if (hue !== null && /^\\d+$/.test(hue)) {
        root.style.setProperty("--hue", hue);
        root.style.setProperty("--primary-h", hue);
      }
      // 字号也必须在**首帧**恢复，否则会先按 16px 排一次版、脚本跑完再跳一下
      // （主题闪光弹的同款问题，2026-10-13 已为明暗修过，字号同理）。
      var fs = localStorage.getItem("site-font-size");
      if (fs !== null && /^\\d+$/.test(fs)) {
        root.style.fontSize = fs + "px";
        root.style.setProperty("--base-font-size", fs + "px");
      }
    } catch (e) { /* 隐私模式下 localStorage 可能抛错，忽略 */ }
  })();
  </script>
  <!-- 按页条件加载数学/图元样式，基础页零额外 CSS 阻塞。 -->
  ${hasMath ? `<link rel="stylesheet" href="${rootRel}${assetUrl(KATEX_STYLESHEET)}" data-opt-asset="katex-css">\n  ` : ''}<link rel="stylesheet" href="${rootRel}${assetUrl('assets/theme/shirone-reader.css')}">
  <!-- 站点图标统一使用轻量静态 WebP（较 GIF 体积减重 >90%） -->
  <link rel="icon" type="image/webp" href="${rootRel}assets/favicon/favicon.webp">
  <link rel="apple-touch-icon" href="${rootRel}assets/favicon/apple-touch-icon.webp">
</head>
<body data-site-path="${sitePathOf(relPath)}">
  <div class="drawer-backdrop" id="drawer-backdrop"></div>

  <div class="site-shell">
    <!-- Left Column: Full-Height Sidebar (整列导航栏) -->
    <aside class="m3-drawer" id="m3-drawer">
      <div class="drawer-header-brand">
        <a href="${rootRel}" class="sidebar-brand">
          <img class="site-title-icon" src="${rootRel}assets/favicon/brand.webp" alt="" width="48" height="48" aria-hidden="true">
          <span class="sidebar-brand-text">${SITE_NAME}</span>
        </a>
        <button class="m3-icon-btn drawer-collapse-btn" id="drawer-collapse-btn" aria-label="收起侧边栏" title="收起侧边栏">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 18l-6-6 6-6"/>
          </svg>
        </button>
      </div>

      <div class="drawer-header-toolbar">
        <span class="drawer-section-title">课程导航目录</span>
        <button class="drawer-action-btn" id="toggle-all-groups-btn" title="一键收起或展开所有课程分类">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M7 15l5 5 5-5M7 9l5-5 5 5"/>
          </svg>
          <span id="toggle-all-text">全部收起</span>
        </button>
      </div>

      <div class="drawer-nav-scroll-area">
        ${drawerHtml}
      </div>

      <div class="sidebar-resizer" id="sidebar-resizer" title="按住拖拽调整侧边栏宽度，双击恢复默认宽度"></div>
    </aside>

    <!-- Right Column: Main Content Column (主内容列) -->
    <div class="main-column">
      <!-- Top App Bar -->
      <header class="m3-top-app-bar">
        <div class="top-bar-left">
          <button class="m3-icon-btn" id="drawer-toggle" aria-label="展开/收起侧边栏" title="展开/收起侧边栏">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
          </button>
          <a href="${rootRel}" class="top-bar-mobile-title">
            <span>${SITE_NAME}</span>
          </a>
          <nav class="top-bar-breadcrumbs" aria-label="当前路径">
            ${breadcrumbs.map((b, i) => (i === breadcrumbs.length - 1 || b.href === '#') ? `<span class="${i === breadcrumbs.length - 1 ? 'current-crumb' : 'm3-breadcrumb-plain'}">${b.label}</span>${i === breadcrumbs.length - 1 ? '' : '<span class="m3-breadcrumb-sep">/</span>'}` : `<a href="${b.href}"${b.dataPath ? ` data-path="${b.dataPath}"` : ''}>${b.label}</a><span class="m3-breadcrumb-sep">/</span>`).join('')}
          </nav>
        </div>

        <div class="top-bar-right">
          <button class="m3-icon-btn" id="palette-toggle" aria-label="调色盘" title="主题与调色盘" aria-expanded="false">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/>
              <circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/>
              <circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/>
              <circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/>
              <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>
            </svg>
          </button>

          <!-- Palette Popover -->
          <div class="palette-popover" id="palette-popover">
            <div class="palette-header">
              <span class="palette-title">主题强调色调色盘</span>
              <button class="palette-reset-btn" id="palette-reset-btn" title="重置为默认色">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
              </button>
            </div>
            <div class="palette-current-row">
              <span class="palette-hue-badge" id="palette-hue-badge">Hue 248°</span>
              <div class="palette-color-dot" id="palette-color-dot"></div>
            </div>
            <div class="palette-mode-row">
              <span class="palette-mode-label">明暗</span>
              <div class="palette-mode-switch" role="group" aria-label="明暗主题">
                <button class="palette-mode-btn" data-theme-set="light" title="浅色">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
                  <span>浅色</span>
                </button>
                <button class="palette-mode-btn" data-theme-set="dark" title="深色">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8z"/></svg>
                  <span>深色</span>
                </button>
              </div>
            </div>
            <div class="palette-slider-container">
              <span class="palette-slider-label">色相微调 (0° - 360°)</span>
              <input type="range" min="0" max="360" value="248" class="palette-slider" id="hue-slider">
            </div>
            <!-- 字号（2026-10-29 站长定案）：全站缩放。站内所有尺寸都用 rem，
                 所以改 html 的 font-size 一处即全站生效——正文、侧栏、代码块、
                 连同公式字号一起缩放。范围与默认值参照 Octave-UI 的
                 ThemeManager（12–20px，默认 16）。 -->
            <div class="palette-slider-container">
              <span class="palette-slider-label">
                字号 <span class="palette-font-sample" id="font-sample">Aa</span>
                <span class="palette-font-value" id="font-size-value">16px</span>
              </span>
              <input type="range" min="14" max="25" step="1" value="16" class="palette-slider" id="font-size-slider">
            </div>
            <div>
              <div class="palette-swatches-title">预设配色</div>
              <div class="palette-swatches-grid">
                <button class="palette-swatch-item" data-hue="315" title="经典粉紫">
                  <span class="palette-swatch-dot" style="background: hsl(315, 75%, 45%);"></span>
                  <span class="palette-swatch-name">粉紫</span>
                </button>
                <button class="palette-swatch-item" data-hue="280" title="紫罗兰">
                  <span class="palette-swatch-dot" style="background: hsl(280, 75%, 45%);"></span>
                  <span class="palette-swatch-name">紫罗兰</span>
                </button>
                <button class="palette-swatch-item active" data-hue="248" title="学术深蓝">
                  <span class="palette-swatch-dot" style="background: hsl(248, 75%, 45%);"></span>
                  <span class="palette-swatch-name">深蓝</span>
                </button>
                <button class="palette-swatch-item" data-hue="205" title="天青蓝">
                  <span class="palette-swatch-dot" style="background: hsl(205, 75%, 45%);"></span>
                  <span class="palette-swatch-name">天青</span>
                </button>
                <button class="palette-swatch-item" data-hue="150" title="翡翠绿">
                  <span class="palette-swatch-dot" style="background: hsl(150, 75%, 40%);"></span>
                  <span class="palette-swatch-name">翡翠</span>
                </button>
                <button class="palette-swatch-item" data-hue="75" title="琥珀黄">
                  <span class="palette-swatch-dot" style="background: hsl(75, 75%, 40%);"></span>
                  <span class="palette-swatch-name">琥珀</span>
                </button>
                <button class="palette-swatch-item" data-hue="30" title="晚霞橙">
                  <span class="palette-swatch-dot" style="background: hsl(30, 80%, 48%);"></span>
                  <span class="palette-swatch-name">晚霞</span>
                </button>
                <button class="palette-swatch-item" data-hue="355" title="绯红">
                  <span class="palette-swatch-dot" style="background: hsl(355, 75%, 45%);"></span>
                  <span class="palette-swatch-name">绯红</span>
                </button>
                <button class="palette-swatch-item" data-hue="182" title="青碧">
                  <span class="palette-swatch-dot" style="background: hsl(182, 75%, 42%);"></span>
                  <span class="palette-swatch-name">青碧</span>
                </button>
                <button class="palette-swatch-item" data-hue="335" title="玫瑰红">
                  <span class="palette-swatch-dot" style="background: hsl(335, 75%, 48%);"></span>
                  <span class="palette-swatch-name">玫瑰</span>
                </button>
                <button class="palette-swatch-item" data-hue="225" title="靛蓝">
                  <span class="palette-swatch-dot" style="background: hsl(225, 75%, 48%);"></span>
                  <span class="palette-swatch-name">靛蓝</span>
                </button>
                <button class="palette-swatch-item" id="palette-random-btn" title="随机配色">
                  <span class="palette-swatch-dot palette-swatch-mosaic"></span>
                  <span class="palette-swatch-name">随机</span>
                </button>
              </div>
            </div>
          </div>

          <button class="m3-icon-btn" id="search-toggle" aria-label="全站搜索" title="全站搜索">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
          </button>

        </div>
      </header>

      <!-- 全站搜索面板（点击顶栏放大镜展开；ESC 或点外部关闭） -->
      <div class="search-panel" id="search-panel" hidden>
        <div class="search-panel-inner" role="dialog" aria-modal="true" aria-label="全站搜索">
          <div class="search-panel-head">
            <svg class="search-panel-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
            <input type="search" id="search-input" class="search-panel-input" placeholder="搜索知识点、例题、习题…" autocomplete="off" spellcheck="false">
            <button class="m3-icon-btn" id="search-close" aria-label="关闭搜索" title="关闭（ESC）">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
          <div class="search-panel-body" id="search-results">
            <p class="search-hint">输入关键词开始搜索。中文按字面子串匹配——搜「沙路法则」只出真正连着出现这四个字的地方；结果按相关度排序，回车打开第一条。</p>
          </div>
        </div>
      </div>

      <div class="layout-container">
        <!-- Content Area -->
        <main class="content-wrapper">
          <article class="article-container">
            ${/* 正文面包屑已删（2026-10-30 站长定案）：顶栏 .top-bar-breadcrumbs 已经
                 表达同一条路径，读者在同一屏看到两遍完全相同的层级没有任何信息增益，
                 只有噪声。全站**只有顶栏**一条面包屑。 */ ''}
            ${metaChipsHtml ? `<div class="meta-chip-bar">${metaChipsHtml}</div>` : ''}

            <div class="article-content">
              ${htmlContent}
            </div>

            ${pagingHtml}

            <footer class="site-footer">
              <p class="site-footer__legal">
                © 2026 ArchivalEra ·
                <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="license noopener">AGPL-3.0</a> ·
                <a href="https://isui.ren/repo/S26-1_202609/licenses.json" target="_blank" rel="noopener">许可清单</a> ·
                <a href="https://github.com/ArchivalEra/S26-1_202609" target="_blank" rel="noopener">GitHub</a>
              </p>
              <p class="site-footer__disclaimer">
                教材原题版权归原书作者与出版社所有，本站仅作个人学习整理。
              </p>
            </footer>
          </article>
        </main>

        <!-- Table of Contents -->
        ${tocHtml}
      </div>
    </div>
  </div>

  <script src="${rootRel}${assetUrl('assets/app.js')}" defer></script>
  ${hasGlossary ? `<script type="application/json" id="${SYMBOL_JSON_SCRIPT_ID}">${JSON.stringify(glossaryJsonPayload).replace(/<\//g, '<\\/')}</script>\n  ` : ''}${hasGlossary ? `<script src="${rootRel}${assetUrl(SYMBOL_RUNTIME_ASSET)}" data-opt-asset="symbols-bubble" defer></script>\n  ` : ''}
  <script>(function(){
    var CFG={sc:${JSON.stringify(SEARCH_CSS_ASSET_URL)},sj:${JSON.stringify(SEARCH_JS_ASSET_URL)},sp:${JSON.stringify(SPA_JS_ASSET_URL)},hp:${JSON.stringify(HELPERS_JS_ASSET_URL)}};
    var loaded={};
    function urlOf(rel){var r=document.documentElement.getAttribute("data-root")||"./";return new URL(r+rel,location.href).href;}
    function addCss(rel,key){if(loaded[key])return;loaded[key]=1;var l=document.createElement("link");l.rel="stylesheet";l.href=urlOf(rel);document.head.appendChild(l);}
    function addJs(rel){if(loaded[rel])return loaded[rel];loaded[rel]=new Promise(function(res){var s=document.createElement("script");s.defer=true;s.src=urlOf(rel);s.onload=res;s.onerror=res;document.body.appendChild(s);});return loaded[rel];}
    function bootSearch(open){
      if(window.__siteSearchLoaded){if(open&&window.__siteSearch&&window.__siteSearch.open)window.__siteSearch.open();return;}
      window.__siteSearchWantOpen=window.__siteSearchWantOpen||!!open;
      addCss(CFG.sc,"sc");addJs(CFG.sj);
    }
    var st=document.getElementById("search-toggle"),si=document.getElementById("search-input");
    if(st)st.addEventListener("click",function(){if(!window.__siteSearchLoaded)bootSearch(true);});
    if(si)si.addEventListener("focus",function(){if(!window.__siteSearchLoaded)bootSearch(false);});
    document.addEventListener("keydown",function(e){
      if(window.__siteSearchLoaded)return;
      var ae=document.activeElement,typing=/^(INPUT|TEXTAREA|SELECT)$/.test((ae&&ae.tagName)||"");
      if((e.key==="/"&&!typing)||((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k")){e.preventDefault();bootSearch(true);}
    });
    function bootSpa(){if(!window.__spaRouter)addJs(CFG.sp);}
    var onHover=function(e){if(e.target&&e.target.closest&&e.target.closest("a")){document.removeEventListener("pointerover",onHover);document.removeEventListener("touchstart",onHover);bootSpa();}};
    document.addEventListener("pointerover",onHover,{passive:true});
    document.addEventListener("touchstart",onHover,{passive:true});
    if(typeof requestIdleCallback==="function")requestIdleCallback(bootSpa,{timeout:2000});
    else setTimeout(bootSpa,1500);
    if((location.search||"").indexOf("helpers=1")>=0){try{if(new URLSearchParams(location.search).get("helpers")==="1")addJs(CFG.hp);}catch(_e){}}
  })();</script>
</body>
</html>`;

  const outFilePath = path.join(DIST_DIR, targetHtmlPath);
  const htmlWithVers = finalHtml;
  // 构建期兜底：任何版本占位符残留都是 bug（上一条断言的就是这个形状，
  // 但它是人工约定的；这里硬拦，免得下次再加第三个占位符时又漏一个）。
  const leakedVer = /__[A-Z]+_VER__/.exec(htmlWithVers);
  if (leakedVer) {
    throw new Error(
      `[build] 产物里残留版本占位符 ${leakedVer[0]}（${targetHtmlPath}）——` +
      `某处 import 的 ?v= 没被替换，该模块会永不更新。检查 build.mjs 的 htmlWithVers 链。`);
  }
  // 构建期兜底：任何 `@@MATH_INLINE_<数字>@@` 残留在产物里都是 bug。
  // 它意味着某段文字走了「数学占位符已生成、但没被 Step 6 还原」的路径——
  // 2026-10-29 实测发生在图注上（`:::figure id | 图注里写 $u_i$`）：
  // 图注在 Step 2 变占位符、restoreFigures 在 Step 6.5 才把它写进 HTML，
  // 那时 Step 6 的整轮替换已过去，页面上就直挺挺显示 `@@MATH_INLINE_84@@`。
  // 这类残留**肉眼一眼能看出、但构建与全部测试都不报错**，所以在这里硬拦。
  //
  // 只认带数字的形式：文档/测试页会**故意**写出这个模式的字面例子，
  // 那种没有数字的 `@@MATH_INLINE_n@@` 是正文，不是残留。
  //
  // ⚠️ 2026-11-11 补第二个形态（issue #37）：占位符若被**当公式编译过一遍**，
  // 产物里不再是裸文本 `@@MATH_INLINE_3@@`，而是
  // `aria-label="@@MATH\u200bINLINE3@@"`——下划线被 KaTeX 当子标记吃掉，还掺了
  // 零宽空格。只匹配裸文本的正则对它**永远返回 null**，于是
  // 「构建绿 + 31 项闸门全过 + 页面上摆着乱码」。两个形态都要拦。
  const leaked = /@@MATH_INLINE_\d+@@/.exec(htmlWithVers)
    ?? /@@MATH[\u200b\s]*INLINE\d+@@/.exec(htmlWithVers);
  if (leaked) {
    throw new Error(
      `${targetHtmlPath} 的产物里残留数学占位符 ${leaked[0]}` +
      '（说明有段文字晚了 Step 6 才进 HTML，或被当成 TeX 又编译了一遍——' +
      '多半是图注/依赖表令牌或模板里新加的字段）');
  }
  fs.mkdirSync(path.dirname(outFilePath), { recursive: true });
  fs.writeFileSync(outFilePath, htmlWithVers, 'utf-8');

  // 符号覆盖（2026-11-05）：量**最终产物**，不量中间数据——renderOneMath 的
  // anchors 只覆盖公式一路，正文令牌与图内符号不经过它；裸 <span data-term>、
  // 字面残留令牌、气泡词典也都只有产物里看得全。逐页警告用页首的分界线切出来。
  // diagnosePage 按词条 id 去重：一个坏令牌会同时触发 glossaryWarn 与字面残留。
  const pageCoverage = measurePage(htmlWithVers);
  totalSymbolsBubbled += pageCoverage.anchors;
  const shapeStats = measureFormulaShapes(htmlWithVers);
  const { uncovered: shapeGaps } = coverageOf(shapeStats, symBundle.matchedForms);
  for (const w of symBundle.warnings) symbolPageWarns.push(`${relPath}：${w}`);
  const pageUncovered = diagnosePage({
    relPath,
    pageWarns: symBundle.warnings,
    literalTokens: pageCoverage.literalTokens,
    bareSpans: pageCoverage.bareSpans,
  });
  symbolUncovered.push(...pageUncovered);
  // 符号缺口：公式里出现、但本页词条没覆盖的形状（按出现次数降序）。
  for (const g of shapeGaps) {
    symbolGaps.push({ page: relPath, label: g.label, count: g.count });
  }
  symbolCoveragePages.push({
    page: relPath,
    html: targetHtmlPath,
    anchors: pageCoverage.anchors,
    uncovered: pageUncovered.length,
    gaps: shapeGaps.length,
  });

  // 检索语料：只收正文（htmlContent），标题用页面标题；URL 存**相对站点根**的路径
  // （不带前导斜杠），这样部署在任意子路径下都能由客户端补上站点根前缀。
  searchDocs.push(extractSearchDoc(htmlContent, {
    url: targetHtmlPath.split('/').map(seg => encodeURIComponent(seg)).join('/'),
    title: pageMeta.title
  }));

  // machine/ 镜像（2026-11-13 站长裁定）：装**渲染前的整篇源文**，不是抽出来的字段。
  // 读者的 agent 读不到页面里的公式（KaTeX 把 TeX 烤成排版），所以镜像给的就是
  // 「还没进渲染管线」的那一份：正文照原样（Markdown）、公式保持 TeX 原文、
  // 图片路径换成完整 URL、符号保持原样（不冒泡——冒泡是给人页面的交互）。
  // frontmatter 去掉（那是台账字段，不是正文）。
  const srcNoFm = stripClosedBoundary(
    fs.readFileSync(fullPath, 'utf-8').replace(/^---\r?\n[\s\S]+?\r?\n---\r?\n?/, ''),
    ISSUE_STATES
  );
  // 图片：源里的相对路径（figures/xxx.svg）→ 相对该页的绝对 URL。
  const siteBase = 'https://isui.ren/repo/S26-1_202609/';
  const pageDir = targetHtmlPath.replace(/[^/]+$/, '');
  const bodyMd = srcNoFm.replace(/(!\[[^\]]*\]\()([^)\s]+\.(?:svg|png|jpe?g|webp|gif))(\s[^)]*)?\)/g,
    (_, pre, src, tail) => {
      if (/^https?:/.test(src)) return `${pre}${src}${tail || ''})`;
      return `${pre}${siteBase}${pageDir}${src}${tail || ''})`;
    }).replace(/(<img[^>]+src=")([^"]+)([^>]*>)/g, (_, pre, src, tail) => {
    if (/^https?:/.test(src)) return `${pre}${src}${tail}`;
    return `${pre}${siteBase}${pageDir}${src}${tail}`;
  });
  // 切片（2026-11-13）：腾讯侧 fetch 有体积限制，整页 JSON 可能取不全。
  // 按 Markdown 标题切成小节，**每片一个文件**——agent 先取 _index.json（几十行，
  // 几十 KB 也放行），挑出想读的那片再 fetch，不必自己截断、也不受整页体积限制。
  // 切片边界：`##`/`###` 标题（`#` H1 是页名，不单独切片）。
  const sections = [];
  {
    const lines2 = bodyMd.split('\n');
    let cur = { id: 'intro', heading: '', lines: [] };
    for (const line of lines2) {
      const h = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
      if (h) {
        sections.push(cur);
        cur = { id: '', heading: h[2].replace(/\s*\{#[^}]+\}\s*$/, '').trim(), lines: [line] };
      } else {
        cur.lines.push(line);
      }
    }
    sections.push(cur);
  }
  // 每片给一个稳定短 id：取标题里的编号/序号（`选 1（图 1.1）` → `选-1`），
  // 没标题的（intro）用 `00-开头`。重复的加 -2、-3。
  const used = new Map();
  const slugify = (h) => h.toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')          // 去掉括号里的图号/补充
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/(?:^-+)|(?:-+$)/g, '') || 'x';
  const sliced = [];
  sections.forEach((sec, i) => {
    const text = sec.lines.join('\n').trim();
    if (!text) return;
    const base = sec.heading ? slugify(sec.heading) : `${String(i).padStart(2, '0')}-开头`;
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    const id = n === 1 ? base : `${base}-${n}`;
    sliced.push({ id, heading: sec.heading || '（开头）', text });
  });

  machinePages.push({
    url: targetHtmlPath,
    title: pageMeta.title,
    body: bodyMd,
    sections: sliced,
    symbols: symBundle.machineSummary,
  });

  // Also create README.html at root if it's README.md
  if (relPath === 'README.md') {
    fs.writeFileSync(path.join(DIST_DIR, 'README.html'), htmlWithVers, 'utf-8');
  }

  console.log(`[build] Generated: ${targetHtmlPath}`);
  // **不再生成 encoded alias**（2026-10-11 用户定案「纯中文路径」）：
  // 同页面在 dist 里双写（中文目录 + %-编码目录）会让浏览器把相对路径解析到编码那一份下——
  // 图片/子资源在那份里不存在，从编码 URL 进入时整批图片挂掉（实测习题册第一章
  // 35 张图里 33 张加载失败）。站点与 EdgeOne 都支持中文路径，站内链接也一律写中文。
}

for (const w of symbolPageWarns) console.warn(`[符号·逐页] ${w}`);

// 账本落盘：FACTS 的 symbols_bubbled / symbols_uncovered 与
// plugins/symbol-coverage.test.mjs 都读这一份，别处不重算。
// 缺口按词形聚合（跨页）：同一符号在多页缺失只算一条，带总出现次数与涉及页数。
const gapByLabel = new Map();
for (const g of symbolGaps) {
  const rec = gapByLabel.get(g.label) || { label: g.label, count: 0, pages: new Set() };
  rec.count += g.count;
  rec.pages.add(g.page);
  gapByLabel.set(g.label, rec);
}
const symbolGapSummary = [...gapByLabel.values()]
  .map((r) => ({ label: r.label, count: r.count, pages: r.pages.size }))
  .sort((a, b) => b.count - a.count);

const symbolCoverageReport = {
  symbols_bubbled: totalSymbolsBubbled,
  symbols_uncovered: symbolUncovered.length,
  uncovered: symbolUncovered,
  // 缺口 = **没有词条**（不是「包链接失败」）。这是习题册那批不冒泡的真因。
  symbols_missing_entries: symbolGapSummary.length,
  gaps: symbolGapSummary,
  pages: symbolCoveragePages,
};
fs.writeFileSync(
  path.join(DIST_DIR, 'symbol-coverage.json'),
  JSON.stringify(symbolCoverageReport, null, 2) + '\n',
  'utf-8',
);

{
  const top = symbolGapSummary.slice(0, 10).map((g) => `${g.label}×${g.count}`).join(' ');
  console.log(`[符号] 全站 ${totalSymbolsBubbled} 个锚点 / ${symbolUncovered.length} 个未解析`);
  console.log(`[符号] 缺口：${symbolGapSummary.length} 种形状在公式里出现但词条没覆盖`
    + (top ? `，前 10：${top}` : ''));
}
console.log(`[build] Completed! Rendered ${totalFormulasRendered} math formulas with ${formulaErrors} errors.`);

if (symbolUncovered.length > 0) {
  // 硬拦：一个冒不了泡的符号，读者点的是字面文本。
  // 修法看每条 detail——补词条 / 修令牌 / 修排除；真修不了的归 issue 后放行。
  for (const u of symbolUncovered) {
    console.error(`[符号] 未解析：${u.page} · ${u.kind} · ${u.detail}`);
  }
  console.error(`[build] 符号覆盖闸门未过：${symbolUncovered.length} 处符号该冒泡却没冒（明细见上）。`);
  process.exitCode = 1;
}

// 全站搜索索引：等所有页面都渲染完再建（每页正文在渲染循环里已经收进 searchDocs）。
// 产物落在 dist/search/：index.json（页面清单 + 小节锚点 + **源树 hash**）、g/<n>.json（二元组倒排分桶）、
// t/<id>.json（单页正文，供摘要按需拉取）。
{
  // 源树内容 hash：**算法在 站点/源树hash.mjs**（与 MCP 读层共用同一份实现——
  // 从前这里与 corpus-dist.mjs 各有一份拷贝，靠注释维系，改一边就静默失效）。
  const sourceHash = computeSourceHash(ROOT, TARGET_FILES);
  const { files, stats } = buildSearchBundle(searchDocs, { sourceHash });
  for (const [relPath, content] of Object.entries(files)) {
    const filePath = path.join(DIST_DIR, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }
  const bytes = Object.values(files).reduce((sum, content) => sum + Buffer.byteLength(content, 'utf-8'), 0);
  console.log(`[search] Indexed ${stats.pages} pages → ${stats.buckets} buckets, `
    + `${stats.grams} grams / ${stats.positions} positions, ${(bytes / 1024 / 1024).toFixed(2)} MB raw`);
}

// machine/ 全站镜像（2026-11-13 站长裁定）：**按站内路径一比一复刻整页内容**。
//   站内  /课程总览/工程数学/Walkthrough.html
//   镜像  /machine/课程总览/工程数学/Walkthrough.json
// 目录页同理（/课程总览/工程数学/ → /machine/课程总览/工程数学/index.json）。
// 每份镜像 = 渲染前的整篇源文：正文 Markdown 原样、公式保持 TeX 原文、
// 图片换成完整 URL、符号不冒泡。就是「进 Shirone reader 之前」的那一份。
{
  const machineBase = 'https://isui.ren/repo/S26-1_202609/machine/';
  const machineDir = path.join(DIST_DIR, 'machine');
  fs.rmSync(machineDir, { recursive: true, force: true });
  fs.mkdirSync(machineDir, { recursive: true });

  const index = [];
  const MAX_BODY = 5000;
  const writeBodyPieces = (firstPath, text, heading, url, title, symbols) => {
    const pieces = [];
    let rest = text;
    while (Buffer.byteLength(rest) > MAX_BODY) {
      let cut = Math.floor(rest.length * MAX_BODY / Buffer.byteLength(rest));
      while (Buffer.byteLength(rest.slice(0, cut)) > MAX_BODY) cut -= 1;
      while (cut > 0 && cut < rest.length && (rest.charCodeAt(cut) & 0xFC00) === 0xD800) cut -= 1;
      pieces.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    pieces.push(rest);
    pieces.forEach((body, i) => {
      const stem = firstPath.replace(/\.json$/, '');
      const rel = i === 0 ? firstPath : `${stem}-piece-${i + 1}.json`;
      const nextRel = i + 1 < pieces.length ? `${stem}-piece-${i + 2}.json` : null;
      const outAbs = path.join(machineDir, rel);
      fs.mkdirSync(path.dirname(outAbs), { recursive: true });
      let out = body;
      if (nextRel) out += `\n\n剩余见${machineBase}${nextRel}`;
      const payload = { url, title, section: heading, body: out };
      if (i === 0 && symbols) payload.symbols = symbols;
      fs.writeFileSync(path.join(machineDir, rel),
        JSON.stringify(payload) + '\n', 'utf-8');
    });
    return pieces.length;
  };

  for (const m of machinePages) {
    const mirror = m.url.replace(/\.html$/, '.json');   // 整页镜像路径（含目录）
    const pageStem = mirror.replace(/\.json$/, '');     // 无后缀（目录页=目录名，普通页=页名）

    // ① 整页正文：首片直接写在 mirror（Birthright 指向它），续片进 <stem>/piece-N.json。
    fs.mkdirSync(path.dirname(path.join(machineDir, mirror)), { recursive: true });
    let pagePieces = 1;
    if (Buffer.byteLength(m.body) <= MAX_BODY) {
      fs.writeFileSync(path.join(machineDir, mirror),
        JSON.stringify({ url: m.url, title: m.title, section: '', body: m.body, symbols: m.symbols }) + '\n', 'utf-8');
    } else {
      pagePieces = writeBodyPieces(mirror, m.body, '', m.url, m.title, m.symbols);
    }

    // ② 小节片：始终在 <stem>/ 下；超长小节续片名 <id>-piece-N.json。
    if (m.sections.length > 1) {
      const secDir = path.join(machineDir, pageStem);
      fs.mkdirSync(secDir, { recursive: true });
      const idxRows = [];
      for (const sec of m.sections) {
        const byteLen = Buffer.byteLength(sec.text);
        if (byteLen <= MAX_BODY) {
          fs.writeFileSync(path.join(secDir, `${sec.id}.json`),
            JSON.stringify({ url: m.url, title: m.title, section: sec.heading,
              body: sec.text }) + '\n', 'utf-8');
        } else {
          writeBodyPieces(`${pageStem}/${sec.id}`, sec.text, sec.heading, m.url, m.title, null);
        }
        idxRows.push({ id: sec.id, heading: sec.heading,
          chars: byteLen, file: `${sec.id}.json` });
      }
      fs.writeFileSync(path.join(secDir, '_index.json'), JSON.stringify({
        url: m.url, title: m.title,
        symbols: m.symbols,
        howToUse: '整页太大就按这里挑一片取：<本目录>/<file>；片尾有「剩余见…」就接着取',
        sections: idxRows,
      }) + '\n', 'utf-8');
    }
    index.push({ page: m.url, mirror, pieces: pagePieces });
  }

  // ③ 符号系统结构化导出：/machine/symbols/index.json + /machine/symbols/<pack>.json
  const symMachDir = path.join(machineDir, 'symbols');
  fs.mkdirSync(symMachDir, { recursive: true });
  const { indexJson: symMachIndex, packFiles: symMachPacks } = symbolCatalog.machineCatalog({ machineBase });
  fs.writeFileSync(path.join(symMachDir, 'index.json'), JSON.stringify(symMachIndex, null, 2) + '\n', 'utf-8');
  for (const [packName, packPayload] of Object.entries(symMachPacks)) {
    fs.writeFileSync(path.join(symMachDir, `${packName}.json`), JSON.stringify(packPayload, null, 2) + '\n', 'utf-8');
  }
  console.log(`[machine/symbols] 1 份总目录 + ${Object.keys(symMachPacks).length} 个包导出 → dist/machine/symbols/`);

  // 覆盖自证：镜像数 = 页面数，且每个镜像文件真的存在。
  if (index.length !== SITE_PAGE_PATHS.length) {
    throw new Error(`[machine] 镜像数 ${index.length} ≠ 页面数 ${SITE_PAGE_PATHS.length}`);
  }
  const missing = index.filter((i) => !fs.existsSync(path.join(machineDir, i.mirror)));
  if (missing.length) {
    throw new Error(`[machine] 这些镜像没写出来：${missing.slice(0, 5).map((i) => i.mirror).join(' ')}`);
  }
  const bodyBytes = machinePages.reduce((s2, m) => s2 + Buffer.byteLength(m.body), 0);
  console.log(`[machine] ${index.length} 页镜像（正文合计 ${(bodyBytes / 1024 / 1024).toFixed(2)} MB）`
    + ` → dist/machine/<与站内同路径>.json`);
}

// Birthright（2026-11-13 站长最终裁定）：**人类可读的树形 HTML**，每条都是
// `/machine/` 下的**完整绝对链接**。
//
// 为什么放弃括号树：对方前面有风控，会拆链接、会吞掉规则行。依赖「按规则拼地址」
// 的编码形态在那种环境下不可靠——它读不到规则就拼不出来，拼错也发现不了。
// 这个页面把每条镜像的完整 URL 逐条写死：能点、能复制、不依赖任何拼接规则。
// 树形只是便于人/模型看清层级；链接本身是自足的。
{
  const machineBase = 'https://isui.ren/repo/S26-1_202609/machine/';
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // 把镜像清单（targetHtmlPath → 镜像路径）组织成树：目录节点 + 叶子链接。
  // 节点只保留「本层名字」，链接一律给完整绝对地址。
  const root = { name: '', dirs: new Map(), files: [] };
  for (const m of machinePages) {
    const mirror = m.url.replace(/\.html$/, '.json');
    const parts = mirror.split('/');
    const file = parts.pop();
    let cur = root;
    for (const seg of parts) {
      if (!cur.dirs.has(seg)) cur.dirs.set(seg, { name: seg, dirs: new Map(), files: [] });
      cur = cur.dirs.get(seg);
    }
    cur.files.push({ label: file === 'index.json' ? '（本目录）' : file.replace(/\.json$/, ''),
      href: machineBase + mirror });
  }

  const render = (node, depth) => {
    const pad = '  '.repeat(depth);
    let out = '';
    for (const [seg, child] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN', { numeric: true }))) {
      out += `${pad}${esc(seg)}/\n`;
      out += render(child, depth + 1);
    }
    for (const f of node.files.sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN', { numeric: true }))) {
      out += `${pad}${esc(f.label)}  ${esc(f.href)}\n`;
    }
    return out;
  };
  const treeText = render(root, 0);

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Birthright</title>
<style>
body{margin:0;padding:1.5rem;background:#14110f;color:#e8e2da;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
h1{font-size:1rem;margin:0 0 .5rem;color:#d9c9a3}
p{margin:0 0 1rem;color:#9a9086}
pre{margin:0;white-space:pre-wrap;word-break:break-all}
a{color:#8fb8ff;text-decoration:none}
a:hover{text-decoration:underline}
</style>
</head>
<body>
<h1>Birthright · S26-1 课程知识库 /machine/ 镜像目录</h1>
<p>每条都是完整网址，直接可取。整页 JSON 里是渲染前的源文（正文 + TeX 原文 + 图片完整 URL）。</p>
<p>页面太大取不全时，改取同名的目录下的 <code>_index.json</code>：它按小节列出每片（heading / 字数 / 文件名），挑中哪片就取 <code>&lt;页面&gt;/&lt;file&gt;</code>。</p>
<p>符号词典与课程包链规则见 <a href="${machineBase}symbols/index.json">${machineBase}symbols/index.json</a>（每页 JSON 亦附带本页生效 <code>symbols</code> 上下文）。</p>
<pre>${treeText.replace(/&lt;/, '&lt;')}</pre>
</body>
</html>
`;

  // 校验：树里每条链接必须对应真实镜像文件；条数必须等于页面数。
  const links = [...treeText.matchAll(/(https:\/\/\S+\.json)/g)].map((m) => m[1]);
  if (links.length !== SITE_PAGE_PATHS.length) {
    throw new Error(`[Birthright] 链接数 ${links.length} ≠ 页面数 ${SITE_PAGE_PATHS.length}`);
  }
  const ghost = links.filter((u) => {
    const rel = u.slice(machineBase.length);
    return !fs.existsSync(path.join(DIST_DIR, 'machine', rel));
  });
  if (ghost.length) {
    throw new Error(`[Birthright] 这些链接指向的镜像不存在：${ghost.slice(0, 5).join(' ')}`);
  }
  fs.writeFileSync(path.join(DIST_DIR, 'machine', 'Birthright.html'), html, 'utf-8');
  console.log(`[Birthright] ${links.length} 条完整镜像链接 → dist/machine/Birthright.html`
    + `（${Buffer.byteLength(html)} bytes，逐条校验文件存在）`);
}

// 硬守门：dist/ 内禁止存在任何 .png 文件（serve 阶段禁 PNG；MCP canvas 截图不落盘不受影响）
(function assertNoPngInDist(dir) {
  const bad = [];
  (function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.png$/i.test(ent.name)) bad.push(path.relative(DIST_DIR, p));
    }
  })(dir);
  if (bad.length) {
    throw new Error(`[build] dist/ 内存在禁止服务的 PNG 文件：\n  ${bad.join('\n  ')}`);
  }
})(DIST_DIR);
