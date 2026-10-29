import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { marked, yaml } from './vendor.mjs';
// 数学引擎（2026-10-29 重构）：自建 TeX 解析器 → IR → MathLive 渲染。
// 为什么不再直接用 KaTeX：符号取词寄生在 TeX 字符串上（`\htmlData` 插宏），
// 四处各自回答「哪段是符号」，于是长出五个补丁函数互相互相修，改一处崩两处。
// 现在解析成树、判定一次、渲染与标注都是同一棵树的投影。见 站点/math/。
import { parse as parseMath } from './math/parser.mjs';
import { compile as compileMath, render as renderMathDoc, probeRenderer } from './math/index.mjs';
import { compileDictionary } from './math/terms.mjs';
import { createMathliveRenderer, decorateAnchors, DIALECTS } from './math/render.mjs';
import * as mathliveSsr from './assets/mathlive/mathlive-ssr.min.mjs';
import { renderCollapse } from './plugins/collapse.mjs';
import { parseFigureLib, renderFigures, restoreFigures, buildFigureIndex, FIGURES_CSS, FIGURES_JS } from './plugins/figures.mjs';
import { DISCLOSURE_ANCHOR_JS } from './plugins/disclosure-anchor.mjs';
// 正文符号取词（2026-10-29 从 math-glossary.mjs 拆出）：公式内部的符号归 站点/math/，
// 这里只管**正文**里的 `B`、`p_Fe` 这类文本形式（不是 TeX，靠文本匹配）。
import { parseGlossaryDict, parseGlossaryMatch, renderGlossary, applySymbolExclusions, GLOSSARY_JS } from './plugins/prose-terms.mjs';
import { SYMBOL_PACKS, COURSE_ENV, BUILD_PHASES } from './符号环境.mjs';
import { extractSearchDoc, buildSearchBundle, SEARCH_JS, SEARCH_CSS } from './plugins/site-search.mjs';
import { WEBMCP_LOADER_JS, WEBMCP_RELAY_JS } from './plugins/webmcp-loader.mjs';
import { PAGE_BRIDGE_JS } from './plugins/page-bridge.mjs';
import { CHAT_JS, CHAT_CSS } from './plugins/chat-panel.mjs';
import { SPA_ROUTER_JS } from './plugins/spa-router.mjs';
// SW 根除（2026-10-23）：一次性反注册脚本——见下方写盘段注释
import { SW_KILL_JS } from './plugins/sw-kill.mjs';
import { DRAWER_SYNC_JS } from './plugins/drawer-sync.mjs';
import { buildNavModel, isActive, isExpanded, htmlPathOf, filePathOf, urlSegments, NAV_STRUCTURE_JS } from './plugins/nav-structure.mjs';
import { WEBMCP_SHIM_JS } from './plugins/webmcp-shim.mjs';
import { WEBMCP_TOOLS_JS } from './plugins/webmcp-tools.mjs';
import { TARGET_FILES } from './页面清单.mjs';
import { computeSourceHash } from './源树hash.mjs';

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
const CANONICAL_ROOT = argvCanonical ? (argvCanonical.endsWith('/') ? argvCanonical : argvCanonical + '/') : '/';

// 学习助手激活材料（2026-10-27 单向锁模型，设计见 .zcode/设计-加解密模块-20261026.md）：
//   <html data-assistant-key> = K_page，32 字节随机数的 base64url
// 站点**只埋这一件**。它单独无处可用：没有插件内置的 C_upstream 密文，K_page
// 这串随机字节打不开任何东西；反过来 C_upstream 没有这把钥匙也解不出上游配置。
// 两件合体才出 material（见 .zcode/userscript/vault.mjs）。
//
// ⚠️ 不传 --assistant-secrets 时**不埋**：本机构建与 CI 未配 secret 都落这一档，
// 页面没有钥匙 ⇒ 插件探测到无钥匙 ⇒ 永久休眠。这是特性不是遗漏（设计文档 §八）。
// 传法：--assistant-secrets <secrets.json>，文件形如 {kPage, cUpstream}。
// 只校验 kPage（站点要埋的那件）；cUpstream 是插件产物，站点侧不需要。
const argvSecrets = process.argv.includes('--assistant-secrets')
  ? process.argv[process.argv.indexOf('--assistant-secrets') + 1] : null;
let ASSISTANT_KEY = null;      // K_page 钥匙（base64url）
if (argvSecrets) {
  const sec = JSON.parse(fs.readFileSync(argvSecrets, 'utf8'));
  if (!sec.kPage) throw new Error('--assistant-secrets 文件缺 kPage');
  ASSISTANT_KEY = sec.kPage;
}

console.log(`[build] Starting static site generation...`);
console.log(`[build] Repo Root: ${ROOT}`);
console.log(`[build] Output: ${DIST_DIR}`);
console.log(`[build] Canonical Root: ${CANONICAL_ROOT}`);
console.log(`[build] Assistant: ${ASSISTANT_KEY ? '埋入页面钥匙' : '未埋（无 --assistant-secrets）'}`);

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

copyDir(path.join(SITE_DIR, 'assets'), path.join(DIST_DIR, 'assets'));
console.log(`[build] Copied offline assets to dist/assets/`);

// 工具清单（2026-10-22）：给学习通助手读的 Skill.md，原样复制到 dist 根。
// 为什么复制而不是渲染：它是**纯文本契约**，给模型读的，不是给人看的页面——
// 走 markdown 渲染管线反而会加导航/样式噪音。线上地址 /repo/.../Skill.md。
// 可拆卸：删掉本段与 .gitignore 的那行白名单即回退（提示词里的 URL 会 404，
// 但提示词本身仍内联工具名，功能降级不中断）。
{
  const skillSrc = path.join(SITE_DIR, 'Skill.md');
  if (fs.existsSync(skillSrc)) {
    copyFileAtomic(skillSrc, path.join(DIST_DIR, 'Skill.md'));
    console.log(`[build] Copied Skill.md to dist/Skill.md`);
  }
}

// 课程目录内的配图目录（figures/）原样拷进 dist，路径保持相对仓库根。
for (const course of fs.readdirSync(path.join(ROOT, '课程总览'), { withFileTypes: true })) {
  if (!course.isDirectory()) continue;
  const figDir = path.join(ROOT, '课程总览', course.name, '作业', 'figures');
  if (fs.existsSync(figDir)) {
    copyDir(figDir, path.join(DIST_DIR, '课程总览', course.name, '作业', 'figures'));
    console.log(`[build] Copied homework figures: 课程总览/${course.name}/作业/figures/`);
  }
}

// 折叠面板深链接的客户端增强，来自独立插件模块 disclosure-anchor.mjs。
// 可拆卸：删掉本段与页面模板里的 disclosure-anchor <script> 即回退
// （锚点仍可滚动定位，只是收起的面板要手动点开）。
const disclosureAnchorDist = path.join(DIST_DIR, 'assets', 'plugins', 'disclosure-anchor.js');
fs.mkdirSync(path.dirname(disclosureAnchorDist), { recursive: true });
fs.writeFileSync(disclosureAnchorDist, DISCLOSURE_ANCHOR_JS);

// 图元样式（2026-10-28）：与 SEARCH_CSS / CHAT_CSS 同款——模块导出字符串，构建期写盘。
// 可拆卸：删掉本段与页面模板里的对应 <link> 即回退（图仍渲染，只是没有排版）。
const figuresCssDist = path.join(DIST_DIR, 'assets', 'plugins', 'figures.css');
fs.mkdirSync(path.dirname(figuresCssDist), { recursive: true });
fs.writeFileSync(figuresCssDist, FIGURES_CSS);
// 交互层（选中元件 / 高亮网络 / 属性面板 / 缩放）。可拆卸：删本段与模板里的 <script>。
const figuresJsDist = path.join(DIST_DIR, 'assets', 'plugins', 'figures.js');
fs.writeFileSync(figuresJsDist, FIGURES_JS);

// 符号包：构建期环境变量包络的「定义集」。每包 = 一页 :::glossary-dict / :::glossary-match
// 围栏（内容侧维护），包注册表与课程环境表见 站点/符号环境.mjs。三层显式锚定
// （符号级 > 段级 > 课程级）、零回退：页面解析永远只看被锚定的那个包，查不到的 id
// 原样保留 + 构建期警告。实现见 站点/plugins/math-glossary.mjs（独立可拆卸模块：
// 删掉本段、Step 2.6 与页面模板里对应 <script> 即回退，令牌恢复成字面文本）。
const glossaryPacks = {};
const glossaryWarn = new Set();
for (const [packName, packPage] of Object.entries(SYMBOL_PACKS)) {
  const abs = path.join(ROOT, packPage);
  if (!fs.existsSync(abs)) {
    glossaryWarn.add(`包「${packName}」的页面不在仓库里：${packPage}`);
    continue;
  }
  const source = fs.readFileSync(abs, 'utf-8');
  const entries = parseGlossaryDict(source);
  const matches = parseGlossaryMatch(source);
  // 形式声明的**静默失效**防线（2026-10-12 实弹）：match 行按「、,，」切分列表，
  // 所以 TeX 字段写成 /…/ 正则时**不能含这三个字面字符**——含了会被切成几段，
  // 段首不成对斜杠 ⇒ 被当字面原子，规则**从未生效且无人报错**
  // （实弹：通用包 sym-C 的 `(?![A-Za-z0-9.．、。，])` 被切碎，电容 C 全站零包裹）。
  // 判据：段里既有 `/` 又不以 `/` 起头且含正则元字符 ⇒ 明确警告，要求改用 \uXXXX 转义。
  for (const [id, m] of Object.entries(matches)) {
    for (const form of [...(m.prose || []), ...(m.tex || [])]) {
      if (!form.includes("/")) continue;
      if (form.startsWith("/") && /^\/(.+)\/([a-z]*)$/s.test(form)) continue; // 规规矩矩的 /…/ 正则
      glossaryWarn.add(
        `包「${packName}」的 ${id} 声明「${form}」像被列表分隔符切碎的正则——若确要整条正则，`
        + `请把「、。，」写成 \\u3001\\u3002\\uff0c 转义（否则该声明静默失效）`,
      );
    }
  }
  const dict = {};
  for (const [id, e] of Object.entries(entries)) dict[id] = { ...e, bubble: true };
  // 形式声明（match）并入词条；只声明了形式、没有词条内容的（bubble=false）
  // **不参与取词**——没有气泡内容的上色是骗人。旧版把这类声明静默丢弃，现在显式警告。
  for (const [id, m] of Object.entries(matches)) {
    if (dict[id]) dict[id] = { ...dict[id], prose: m.prose, tex: m.tex };
    else glossaryWarn.add(`包「${packName}」的 ${id} 只声明了形式、没有词条内容——自动取词不生效`);
  }
  glossaryPacks[packName] = { page: packPage, dict };
}
for (const w of glossaryWarn) console.warn(`[符号] ${w}`);
console.log(`[符号] 包：${Object.entries(glossaryPacks).map(([n, p]) => `${n}(${Object.keys(p.dict).length} 条)`).join('、')}`);
/**
 * 渲染一条公式：编译（解析 + 唯一一次符号判定）→ 渲染 → 包锚点。
 *
 * **这是全站唯一一处渲染数学的地方**。旧实现有六处各自调渲染器，每处各自决定
 * 「要不要取词、错了怎么办、降级成什么」——六个副本就是六个 bug 面。
 *
 * @param {string} src     公式源（不含 `$`）
 * @param {'inline'|'display'} mode
 * @param {string} relPath 页面路径（诊断定位）
 * @param {object} env     本页数学环境（词典 + 包 + 排除）
 * @param {Map}    hits    本页命中集（累加，供气泡 JSON）
 * @returns {{rendered: string, plain: string}}
 */
function renderOneMath(src, mode, relPath, env, hits) {
  const compiled = compileMath({ blocks: [{ raw: src, mode }] }, env);
  const doc = compiled.docs[0];

  // 诊断：错误计一次、警告记下。**不嗅探产物字符串**——错误是返回值里的数据。
  let hasError = false;
  for (const prob of compiled.problems) {
    if (prob.severity === 'error') {
      hasError = true;
      formulaErrors++;
      console.warn(`[build] ⚠ 公式渲染失败 ${relPath}：${prob.message}｜${src.slice(0, 60)}`);
    } else if (prob.code !== 'term-excluded') {
      // term-excluded 会非常多（每页几十处正常排除），不逐条打印
      console.warn(`[build] ⚠ ${relPath}：${prob.message}`);
    }
  }

  // 命中记账：只记真正绑上的（旧实现在插宏时就记，所以「插了但渲染器不认」的词条
  // 会进气泡 JSON 却没有锚点——那是空气泡的来源）。
  for (const t of doc.terms) {
    const key = `${t.ref.pack}:${t.ref.entry}`;
    if (!hits.has(key)) {
      const pack = glossaryPacks[t.ref.pack];
      const entry = pack?.dict?.[t.ref.entry];
      if (entry) {
        hits.set(key, {
          key,
          pack: t.ref.pack,
          entry: t.ref.entry,
          href: encodeURI(
            path.relative(path.dirname(path.join(ROOT, relPath)),
              path.join(ROOT, pack.page)).replace(/\\/g, '/').replace(/\.md$/, '.html'),
          ) + '#' + t.ref.entry,
          title: entry.title,
          text: entry.text,
          senses: entry.senses,
        });
      }
    }
  }

  const out = renderMathDoc(doc, mathRenderer, {
    decorateAnchors,
    resolveHref: (key) => {
      const hit = hits.get(key);
      return hit ? { href: hit.href, label: hit.title } : null;
    },
  });
  for (const prob of out.problems) {
    if (prob.severity === 'error') {
      hasError = true;
      formulaErrors++;
      console.warn(`[build] ⚠ ${relPath}：${prob.message}`);
    }
  }

  const rendered = mode === 'display'
    // 容器类名：`math-display` 是语义中立的正式名；`katex-scroll-container`
    // 保留为兼容别名（主题 CSS 与 webmcp 工具还在认它），等两处都改完再删。
    ? `<div class="math-display katex-scroll-container">${out.html}</div>`
    : out.html;
  return { rendered: hasError ? rendered : rendered, plain: doc.plain };
}

const mathGlossaryDist = path.join(DIST_DIR, 'assets', 'plugins', 'math-glossary.js');
fs.mkdirSync(path.dirname(mathGlossaryDist), { recursive: true });
fs.writeFileSync(mathGlossaryDist, GLOSSARY_JS);

// ── 数学引擎（2026-10-29 重构）────────────────────────────────────────────
// 词典在这里编译一次：把每个词条的 `tex` 形式解析成**形状键**（结构等价类），
// 于是 `R_L` 与 `R_{L}` 自动同键——旧实现在字符串上比对，写哪个就漏另一个。
const { dictionary: mathDictionary, problems: dictProblems } = compileDictionary(
  Object.fromEntries(Object.entries(glossaryPacks).map(([name, pack]) => [name, {
    page: pack.page,
    entries: Object.entries(pack.dict).map(([id, e]) => ({
      id,
      tex: e.tex || [],
      bubble: e.bubble !== false,
    })),
  }])),
  { parse: parseMath },
);
for (const p of dictProblems) {
  if (p.severity === 'error') console.error(`[数学] 词典：${p.message}`);
  else console.warn(`[数学] 词典：${p.message}`);
}

// 渲染器 + 启动期自检：契约不成立就别开工。
// 这替代了旧实现「每条公式嗅产物里有没有 katex-error」——检查一次协议，不是嗅一万次。
const mathRenderer = createMathliveRenderer(mathliveSsr);
const probeProblems = probeRenderer(mathRenderer);
if (probeProblems.some((p) => p.severity === 'error')) {
  throw new Error(`[数学] 渲染器自检失败：${probeProblems[0].message}`);
}
console.log(`[数学] 引擎 ${mathRenderer.id}；词典 ${Object.keys(mathDictionary.packs).length} 包；` +
  `方言已知差异 ${DIALECTS.mathlive.unsupported.length} 项`);

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
  } catch (e) {
    throw new Error(`assetVersion：dist 里没有资产 ${relFromDist}——引用了不存在的文件（先构建该资产再引用）`);
  }
};
const assetUrl = (relFromDist) => {
  const v = assetVersion(relFromDist);
  return v ? `${relFromDist}?v=${v}` : relFromDist;
};

const webmcpDir = path.join(DIST_DIR, 'assets', 'plugins');
fs.mkdirSync(webmcpDir, { recursive: true });
// ⚠️ 2026-10-23 修（Node 桥实测抓到）：loader 动态注入 shim/tools 时**不带缓存戳**，
// 改了 webmcp-tools.js 浏览器一直用旧副本（工具行为怎么改都不生效，只能手动硬刷）。
// 现在先写 shim/tools，算出内容哈希，再把它替换进 loader 源码里的 __SHIM_VER__/__TOOLS_VER__。
// 顺序必须是这样（先写被注入方、后写注入方），否则哈希算的是上一轮的旧内容。
fs.writeFileSync(path.join(webmcpDir, 'webmcp-shim.js'), WEBMCP_SHIM_JS);
fs.writeFileSync(path.join(webmcpDir, 'webmcp-tools.js'), WEBMCP_TOOLS_JS);
// 页面桥（2026-10-19 植入）：也由 loader 动态注入，所以必须在这算哈希之前写盘。
fs.writeFileSync(path.join(webmcpDir, 'webmcp-bridge.js'), PAGE_BRIDGE_JS);
{
  const shimVer = assetVersion('assets/plugins/webmcp-shim.js');
  const toolsVer = assetVersion('assets/plugins/webmcp-tools.js');
  const bridgeVer = assetVersion('assets/plugins/webmcp-bridge.js');
  const loaderSrc = WEBMCP_LOADER_JS
    .split('__SHIM_VER__').join(shimVer)
    .split('__TOOLS_VER__').join(toolsVer)
    .split('__BRIDGE_VER__').join(bridgeVer)
    .split('__POLYFILL_VER__').join(assetVersion('assets/vendor/webmcp/polyfill.iife.js'));
  fs.writeFileSync(path.join(webmcpDir, 'webmcp-loader.js'), loaderSrc);
}
fs.writeFileSync(path.join(webmcpDir, 'webmcp-relay.js'), WEBMCP_RELAY_JS);
// 学习助手面板（2026-10-19）：JS + CSS 都是构建期写盘，SW 会自动预缓存
fs.writeFileSync(path.join(webmcpDir, 'chat-panel.js'), CHAT_JS);
fs.writeFileSync(path.join(webmcpDir, 'chat-panel.css'), CHAT_CSS);
// 部署根探测（2026-10-20）：修「无前缀入口下相对链接退到域名根」的线上 404。
// 原样拷贝源文件（内含全局暴露，模板里同步加载并立即调用 fixSiteRoot()）。
fs.writeFileSync(path.join(webmcpDir, 'site-root.js'), fs.readFileSync(path.join(SITE_DIR, 'plugins', 'site-root.mjs'), 'utf8'));
// vendor 第三方资产（polyfill + relay embed/widget）逐字节拷贝。
copyDir(path.join(SITE_DIR, 'assets', 'vendor', 'webmcp'), path.join(DIST_DIR, 'assets', 'vendor', 'webmcp'));
console.log('[build] Wrote WebMCP plugins + copied vendor assets (polyfill + relay embed)');

// SPA 路由 + Service Worker（2026-10-17 大重构）：站内点击不重载（fetch → 换正文/TOC/标题），
//   document 不销毁 ⇒ WebMCP 工具注册一次永久有效。SW 双策略：资产 cache-first、页面 SWR。
//   可拆卸：删掉本段与模板里 spa-router 一行 + dist/sw.js 即回退。
fs.writeFileSync(path.join(webmcpDir, 'spa-router.js'), SPA_ROUTER_JS);
// 侧栏形状运行时（阶段一，2026-10-21）：读 #nav-structure-json + 共享判定。
// 由 nav-structure.mjs 的真函数派生（浏览器跑的就是测试跑的）。drawer-sync 依赖它。
fs.writeFileSync(path.join(webmcpDir, 'nav-structure.js'), NAV_STRUCTURE_JS);
fs.writeFileSync(path.join(webmcpDir, 'drawer-sync.js'), DRAWER_SYNC_JS);

// SW 已根除（2026-10-23 用户定案：长任务要「永远新鲜的页面」，SW 的 SWR/预缓存
// 与它正面冲突——页面先出旧缓存、后台静默更新、下次才生效，模型跳十几次页会拿到
// 上一版 HTML；且 SW 修过两次版本错配/部署形态坑，是纯负资产。浏览器 HTTP 缓存 +
// CDN + 站点自带的 ?v=<内容哈希> 接管静态资产缓存）。
//
// 这里写的是**一次性清老用户**的 sw-kill.js：老浏览器里已注册的旧 SW 还活着，
// 页面加载时反注册 + 清全部 caches。跑一两周（老用户都来过一次）后删本段。
fs.writeFileSync(path.join(webmcpDir, 'sw-kill.js'), SW_KILL_JS);
console.log('[build] Wrote sw-kill.js (one-shot SW removal for legacy visitors)');

// 检索语料：渲染循环里逐页填，循环结束后统一建索引。
const searchDocs = [];

// 2. Pre-read metadata of all files for navigation & paging
const pageMetaMap = new Map();

// 课程状态的**唯一产地** = README 的 COURSE-STATUS 块（2026-10-11 定案）：
// 只允许「开课 / 结课」两档；课程页与各资料页顶端的状态都从这里继承，
// 资料文件不再自己写 `status`。README 缺块 ⇒ 明确报错（不静默降级成空状态）。
function loadCourseStatus() {
  const p = path.join(ROOT, 'README.md');
  const text = fs.readFileSync(p, 'utf-8');
  const m = text.match(/<!-- COURSE-STATUS:START -->([\s\S]*?)<!-- COURSE-STATUS:END -->/);
  if (!m) {
    throw new Error('README.md 缺 COURSE-STATUS 块——课程状态的唯一产地，别删（见 README「课程状态」节）。');
  }
  const map = new Map();
  for (const line of m[1].split('\n')) {
    const row = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/);
    if (!row) continue;
    const [, name, status] = row;
    // 跳过表头与分隔行（`| :--- | :--- |`）
    if (name === '课程' || /^[-: ]+$/.test(name)) continue;
    if (status !== '开课' && status !== '结课') {
      throw new Error(`README 课程状态表：${name} 的状态「${status}」非法——只允许「开课」或「结课」。`);
    }
    map.set(name, status);
  }
  if (!map.size) throw new Error('README 的 COURSE-STATUS 块里一条课程都没有——空不是通过。');
  return map;
}
const COURSE_STATUS = loadCourseStatus();

for (const relPath of TARGET_FILES) {
  const fullPath = path.join(ROOT, relPath);
  if (!fs.existsSync(fullPath)) continue;
  const content = fs.readFileSync(fullPath, 'utf-8');
  let title = path.basename(relPath, '.md');
  let frontmatter = {};

  const fmMatch = content.match(/^---\r?\n([\s\S]+?)\r?\n---/);
  if (fmMatch) {
    // frontmatter 解析失败 = 硬失败（2026-10-22 悬案 Q1 结算）：这里曾用 console.warn
    // 静默吞掉，字段全空、页面照常生成、全部闸门绿——2026-10-12 实弹：frontmatter 写进
    // 非 YAML 行（注：…），「符号排除」清单静默失效，只有浏览器里逐页点才看得出来。
    // 构建（node build.mjs）对 课程总览/**/*.md 与其余全部目标文件逐个走到这里，
    // 坏 YAML 使构建 rc≠0 并指出文件（裸抛只给 vendor 栈，不带文件名——所以要包一层）。
    try {
      frontmatter = yaml.load(fmMatch[1]) || {};
    } catch (e) {
      throw new Error(`frontmatter 解析失败（元数据遍） ${relPath}: ${e.message}`);
    }
    if (frontmatter.name) title = frontmatter.name;
  } else {
    // Check first H1
    const h1Match = content.match(/^#\s+(.+)$/m);
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
// README / 维护条例 / 维护细则 / 站点符号包都没有侧栏入口，但它们是真页面。
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
              { label: "作业3", path: "课程总览/工程数学/作业/作业3.md" }
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
              { label: "10-22-矩阵的秩与向量", path: "课程总览/工程数学/课堂笔记/10-22-矩阵的秩与向量.md" },
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
                  }
                ]
              }
            ]
          },
          { label: "原始资料", path: "课程总览/工程数学/原始资料/index.md" },
          { label: "音频", path: "课程总览/工程数学/音频/index.md" }
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
            ]
          },
          { label: "原始资料", path: "课程总览/电力大数据与人工智能/原始资料/index.md" },
          { label: "音频", path: "课程总览/电力大数据与人工智能/音频/index.md" }
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
          { label: "原始资料", path: "课程总览/形势与政策/原始资料/index.md" },
          { label: "音频", path: "课程总览/形势与政策/音频/index.md" }
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
              { label: "10-10-受控源与例题", path: "课程总览/电路原理/课堂笔记/10-10-受控源与例题.md" },
              { label: "10-12-习题册与等效变换", path: "课程总览/电路原理/课堂笔记/10-12-习题册与等效变换.md" },
              { label: "10-14-电源等效变换", path: "课程总览/电路原理/课堂笔记/10-14-电源等效变换.md" },
              { label: "10-21-网孔电流法", path: "课程总览/电路原理/课堂笔记/10-21-网孔电流法.md" },
              { label: "10-26-节点电压法", path: "课程总览/电路原理/课堂笔记/10-26-节点电压法.md" },
              { label: "10-26-补课叠加戴维南", path: "课程总览/电路原理/课堂笔记/10-26-补课叠加戴维南.md" },
              { label: "10-28-戴维南与诺顿", path: "课程总览/电路原理/课堂笔记/10-28-戴维南与诺顿.md" },
              { label: "09-30-电容电感与独立电源", path: "课程总览/电路原理/课堂笔记/09-30-电容电感与独立电源.md" },
              { label: "09-28-KCL与KVL", path: "课程总览/电路原理/课堂笔记/09-28-KCL与KVL.md" },
            ]
          },
          { label: "原始资料", path: "课程总览/电路原理/原始资料/index.md" },
          { label: "音频", path: "课程总览/电路原理/音频/index.md" }
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
              { label: "2026-10-21作业", path: "课程总览/电子技术/作业/2026-10-21作业.md" }
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
              { label: "10-10-逻辑代数与公式法化简", path: "课程总览/电子技术/课堂笔记/10-10-逻辑代数与公式法化简.md" },
              { label: "09-28-三极管与场效应管", path: "课程总览/电子技术/课堂笔记/09-28-三极管与场效应管.md" },
              { label: "10-12-卡诺图化简法与无关项", path: "课程总览/电子技术/课堂笔记/10-12-卡诺图化简法与无关项.md" },
              { label: "10-19-三态门与组合逻辑电路", path: "课程总览/电子技术/课堂笔记/10-19-三态门与组合逻辑电路.md" },
              { label: "10-21-实验一常用逻辑门电路", path: "课程总览/电子技术/课堂笔记/10-21-实验一常用逻辑门电路.md" },
              { label: "10-21-编码器与译码器", path: "课程总览/电子技术/课堂笔记/10-21-编码器与译码器.md" },
            ]
          },
          { label: "原始资料", path: "课程总览/电子技术/原始资料/index.md" },
          { label: "音频", path: "课程总览/电子技术/音频/index.md" }
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
              { label: "10-15-变压器变比", path: "课程总览/电机学/作业/10-15-变压器变比.md" }
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
              { label: "10-22-参数测定与电压变化率", path: "课程总览/电机学/课堂笔记/10-22-参数测定与电压变化率.md" }
            ]
          },
          { label: "原始资料", path: "课程总览/电机学/原始资料/index.md" },
          { label: "音频", path: "课程总览/电机学/音频/index.md" }
        ]
      },
      {
        label: "劳动教育",
        path: "课程总览/劳动教育/index.md",
        children: [
          { label: "作业", path: "课程总览/劳动教育/作业/index.md" },
          { label: "课堂笔记", path: "课程总览/劳动教育/课堂笔记/index.md",
            children: [
              { label: "10-26-劳动教育导论与考核", path: "课程总览/劳动教育/课堂笔记/10-26-劳动教育导论与考核.md" }
            ]
          },
          { label: "原始资料", path: "课程总览/劳动教育/原始资料/index.md" },
          { label: "音频", path: "课程总览/劳动教育/音频/index.md" }
        ]
      }
    ]
  },
  {
    label: "仓库规约",
    children: [
      { label: "维护条例", path: "维护条例.md" },
      { label: "维护细则", path: "维护细则.md" }
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

// Helper: Wrap bare CJK in math mode
function wrapBareCJK(tex) {
  const textEnvRegex = /(\\(?:text|textrm|textit|textbf|mathrm|mathbf|operatorname|mbox)\s*\{[^{}]*\})/g;
  const parts = tex.split(textEnvRegex);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(/([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+)/g, '\\text{$1}');
  }
  return parts.join('');
}

/**
 * TeX → 可读纯文本，**只用于标题锚点**。
 *
 * 为什么需要：标题里的公式在 Step 2 已变成 @@MATH_INLINE_N@@ 占位符，
 * 而 marked 用那时的文本生成 heading id，于是锚点会变成
 * `#第一步-处理前两行-提出-math_inline_125` 这种脏值、点击直接失效。
 * 这里给出一份去掉 TeX 标记的纯文本，供 id 与 TOC 使用；
 * 正文里显示的仍是完整 KaTeX 排版，二者互不影响。
 *
 * 注意这是**有损**转换：`\frac{a}{b}` 变成 `a/b`、`x^2` 变成 `x2`……
 * 对锚点足够（可读、稳定），但它不是数学排版，不用于正文。
 */
function mathPlain(tex) {
  let s = String(tex);
  // 先处理常见的分数/上下标，再统一清掉反斜杠命令
  s = s.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1/$2');
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, '√$1');
  s = s.replace(/\\text\s*\{([^{}]*)\}/g, '$1');
  s = s.replace(/\\times/g, '×').replace(/\\cdot/g, '·')
       .replace(/\\div/g, '÷').replace(/\\pm/g, '±')
       .replace(/\\neq/g, '≠').replace(/\\leq/g, '≤').replace(/\\geq/g, '≥')
       .replace(/\\to/g, '→').replace(/\\Rightarrow/g, '⇒')
       .replace(/\\alpha/g, 'α').replace(/\\beta/g, 'β').replace(/\\lambda/g, 'λ')
       .replace(/\\pi/g, 'π').replace(/\\infty/g, '∞');
  s = s.replace(/\^\{([^{}]*)\}/g, '$1').replace(/\^(\S)/g, '$1');
  s = s.replace(/_\{([^{}]*)\}/g, '$1').replace(/_(\S)/g, '$1');
  s = s.replace(/\\[a-zA-Z]+/g, ' ');   // 其余命令（\begin 等）一律去掉
  s = s.replace(/[{}$]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// Custom renderer for Marked
const renderer = new marked.Renderer();

/* ── 响应式表格分级（2026-10-17，外审定案：Claude 评审版方案）──────────────
 * 判定顺序：<!-- table:xxx --> 显式覆盖 > 按内容分级。
 *   t-compact：W_min ≤ 400（窄屏缩字号/减 padding 即可放下；实测 6 列 364、5 列 376）
 *   t-cards  ：放不下且句子型（平均单元格 >6 字）→ data-label 转卡片（窄容器查询触发）
 *   t-matrix ：放不下且短格/数字型 → 横滚 + sticky 首列（真值表/参数矩阵）
 * W_min = Σ(每列最长不可断片段) + 列数×padding；句子判据 = 表体平均字符数。
 * 注释标记通过 processAllTokens 挂到紧随其后的 table token（html token 不进 renderer）。
 */
const tableModeOf = (token) => {
  const cols = token.header.length;
  const padPx = cols * 32;                       // 两侧 padding 1rem×2×0.9 字号缩放后 ~32px/列
  let wMin = padPx;
  let charSum = 0, cells = 0;
  const longest = new Array(cols).fill(0);
  const cellPlain = (c) => c.text.replace(/\s+/g, ' ').trim();
  token.header.forEach((h, i) => { const t = cellPlain(h); longest[i] = Math.max(longest[i], t.length); });
  for (const row of token.rows) {
    row.forEach((c, i) => {
      const t = cellPlain(c);
      longest[i] = Math.max(longest[i], t.length);
      charSum += t.length; cells++;
    });
  }
  for (const L of longest) wMin += Math.min(L, 20) * 9;   // 0.8rem 中文 ≈9px/字，长列封顶 20
  // 阈值标定（Playwright 360px 实测）：compact 收紧后可容 ~420px；出血 +22px。
  // 420~520 是灰带——句子型给 cards（窄容器才转卡，宽屏无感）、短格给 matrix 横滚。
  if (wMin <= 420) return 't-compact';
  const avg = cells ? charSum / cells : 0;
  return avg > 6 ? 't-cards' : 't-matrix';
};

renderer.table = function (token) {
  const mode = token.__tableMode || tableModeOf(token);
  // data-label：cards 需要表头文本进每个 td（attr() 只能读自身属性——外审确认）
  const headerText = token.header.map((h) => h.text.replace(/\s+/g, ' ').trim());
  let body = '';
  for (const row of token.rows) {
    body += '<tr>' + row.map((c, i) => `<td data-label="${headerText[i] ?? ''}">${this.parser.parseInline(c.tokens)}</td>`).join('') + '</tr>\n';
  }
  const thead = '<thead><tr>' + token.header.map((h, i) => {
    const al = token.align[i] ? ` align="${token.align[i]}"` : '';
    return `<th${al}>${this.parser.parseInline(h.tokens)}</th>`;
  }).join('') + '</tr></thead>\n';
  // ARIA：滚动容器独立包裹层（不覆盖 table 语义）；aria-label 取前一个标题（processAllTokens 里挂）
  const label = (token.__tableLabel || '数据表').replace(/"/g, '&quot;');
  return `<div class="table-scroll-container ${mode}" role="region" aria-label="${label}" tabindex="0">\n<table>\n${thead}${body}</table>\n</div>\n`;
};


/**
 * 标题锚点用的公式纯文本中转表（下标与 mathBlocks **完全同构**）。
 *
 * 为什么需要中转：`renderer.heading` 定义在模块级，而 `mathBlocks`
 * 建在每个 Markdown 文件的循环里（函数作用域），两者不通用。
 * 这里按同一套下标记「纯文本」，供 heading 渲染器取用。
 * 每个文件开始处理前清空，避免下标串到别的文件。
 */
const mathPlainOf = [];
// 每页已用的标题锚点 id（renderer 是模块级的，与 mathPlainOf 同款桥接：
// 建页循环开头清空，页内用来做碰撞去重）
const usedHeadingIds = new Set();

renderer.heading = function ({ depth, text, tokens }) {
  // 标题里可能内嵌行内语法（README 自动目录的 `### [工程数学](./…)` 就是链接），
  // 必须走行内解析，否则会以字面 markdown 泄漏到页面与右侧目录。
  const inner = tokens
    ? this.parser.parseInline(tokens)
    : text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 锚点 id 的清洗：从**渲染后**的 HTML 里取纯文本，
  // 并把公式占位符先换成可读的纯文本（否则 id 会变成
  // `第一步-处理前两行-提出-math_inline_125` 这种脏值，点击跳转失效）。
  //
  // 注意：**只在算 id 时**做这个替换——<h3> 里输出的仍是完整 KaTeX 排版。
  // 曾试过在 marked 之前把整个标题行的公式替换成纯文本，那样标题就不排版了，
  // 属于过度修正；现在改成只在 id 这一处降级，两边都拿到。
  //
  // mathPlainOf 是模块级的中转表：mathBlocks 建在每个文件的循环里，
  // 而本 renderer 是模块级的，作用域不通用它来桥接（见其定义处的注释）。
  const forId = inner
    .replace(/@@MATH_INLINE_(\d+)@@/g, (_, i) => mathPlainOf[parseInt(i)] ?? '')
    .replace(/@@MATH_BLOCK_(\d+)@@/g, (_, i) => mathPlainOf[parseInt(i)] ?? '');
  let clean = forId.replace(/<[^>]+>/g, '');

  // ⭐ 显式锚点：「标题 {#my-id}」末尾的 {#…} 直接当 id，并从标题文本里剥掉。
  //
  // 为什么要支持：技法库用「一题一条」的稳定短锚（#m-adj3、#m-kmap-nand），
  // 但此前渲染器不识别 {#…}，会把它拼进中文 slug（`三阶整数阵求逆-伴随法逐元算-m-adj3`），
  // 于是索引里 11 条 href="#m-…" 全部落空、页面上还印着字面花括号（2026-10-28 三签抓出）。
  //
  // 支持后两个好处：① 锚点稳定（改标题措辞不破链接）；② 标题与右侧目录不再带 {#…} 字面量。
  const explicit = clean.match(/\{#([^}\s]+)\}\s*$/);
  const explicitId = explicit ? explicit[1] : null;
  if (explicitId) clean = clean.slice(0, explicit.index).trim();

  let id = explicitId || clean
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '') || ('h-' + Math.random().toString(36).substring(2, 7));
  // 逐页去重：解析文件每个小节都有「原书抄录」「解析」标题，重复 id 会让
  // 目录点击永远跳到第一处、滚动高亮一串全亮（用户实测反馈「目录崩坏」）。
  // 碰撞时追加 -2、-3……（GitHub 风格）；首个出现保持裸 id，旧深链接不受影响。
  if (usedHeadingIds.has(id)) {
    let n = 2;
    while (usedHeadingIds.has(`${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }
  usedHeadingIds.add(id);
  // 显示用文本也要剥掉尾部 {#…}，否则页面上会印出字面花括号
  const shown = explicitId
    ? inner.replace(/\s*\{#([^}\s]+)\}\s*$/, '').trim()
    : inner;
  return `<h${depth} id="${id}">${shown}</h${depth}>`;
};

marked.use({
  renderer,
  hooks: {
    // <!-- table:matrix|cards|compact --> 显式覆盖：挂到紧随其后的 table token；
    // 同时记最近一个 heading 文本，作滚动容器的 aria-label（外审建议的取法）。
    processAllTokens(tokens) {
      let pendingMode = null, lastHeading = '';
      const walk = (ts) => {
        for (const t of ts) {
          // 标题里的 {#显式锚点} 不属标题文字，aria-label 里要剥掉（2026-10-28）
          if (t.type === 'heading') {
            lastHeading = t.text.replace(/\s*\{[^}\s]+\}\s*$/, '').replace(/\s+/g, ' ').trim();
          }
          if (t.type === 'html') {
            const m = /<!--\s*table:(compact|cards|matrix)\s*-->/.exec(t.text || '');
            if (m) { pendingMode = 't-' + m[1]; continue; }
          }
          if (t.type === 'table') {
            if (pendingMode) { t.__tableMode = pendingMode; pendingMode = null; }
            t.__tableLabel = lastHeading;
          }
          if (t.tokens) walk(t.tokens);
          if (t.items) walk(t.items);
        }
      };
      walk(tokens);
      return tokens;
    },
  },
});

// 4. Build each page
let totalFormulasRendered = 0;
let formulaErrors = 0;
/** 引用了但磁盘上没有的配图（多半是白名单漏了 → 从未入库，CI 上缺图）。 */
const missingFigureRefs = new Set();

for (const relPath of TARGET_FILES) {
  const fullPath = path.join(ROOT, relPath);
  if (!fs.existsSync(fullPath)) continue;

  let raw = fs.readFileSync(fullPath, 'utf-8');
  const pageMeta = pageMetaMap.get(relPath);

  const courseOf = (p) => String(p).split('/')[1] || '';
  const notationHrefOf = (id, entry) => encodeURI(
    path.relative(path.dirname(fullPath), path.join(ROOT, entry.page))
      .replace(/\\/g, '/').replace(/\.md$/, '.html') + '#' + id
  );
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
  const renderBubbleText = (s) =>
    String(s)
      .split(/\$([^$\n]+)\$/g)
      .map((part, i) => {
        if (i % 2 === 1) {
          const out = compileMath({ blocks: [{ raw: part, mode: 'inline' }] },
            { dictionary: mathDictionary, packs: [] });
          const bad = out.problems.filter((x) => x.severity === 'error');
          if (bad.length) {
            formulaErrors++;
            console.warn(`[build] ⚠ 气泡公式渲染失败 ${relPath}：${bad[0].message}｜${part.slice(0, 60)}`);
            return escapeHtmlText('$' + part + '$');
          }
          return renderMathDoc(out.docs[0], mathRenderer).html;
        }
        return escapeHtmlText(part);
      })
      .join('');
  // 同一段文字的**纯文本**版（读屏用）：只脱掉 $ 与 TeX 的反斜杠花括号，够读即可——
  // 标题的 aria-label 不该念出「美元号、反斜杠、下划线」。
  const plainBubbleText = (s) =>
    String(s).replace(/\$([^$\n]+)\$/g, (m, tex) => tex.replace(/\\/g, '').replace(/[{}]/g, ''));

  // Strip frontmatter
  let frontmatter = {};
  const fmMatch = raw.match(/^---\r?\n([\s\S]+?)\r?\n---/);
  if (fmMatch) {
    // 同 Step 3 的 frontmatter 硬失败（悬案 Q1）：此处曾 catch(_){} 全静默，
    // 字段全空导致「符号强制/符号排除」等行为悄悄失效。同一份解析在 Step 3 已
    // 校验过一次，这里再显式抛出带文件名的错误——不依赖两个循环间的隐式不变量。
    try {
      frontmatter = yaml.load(fmMatch[1]) || {};
    } catch (e) {
      throw new Error(`frontmatter 解析失败（渲染遍） ${relPath}: ${e.message}`);
    }
    raw = raw.slice(fmMatch[0].length).trim();
  }

  // Strip HTML comments (like AUTO-CATALOG)
  raw = raw.replace(/<!--[\s\S]*?-->/g, '');

  // 构建期符号环境解析（三层锚定，零回退）：段级（显式构建段）覆盖课程级（课程环境表），
  // 符号级（frontmatter「符号强制」+ 令牌包限定）在渲染期最高优先。环境没设「符号」键
  // = 本页零符号行为（围栏照剥）。
  const envVars = {
    ...(COURSE_ENV[here] || {}),
    ...((BUILD_PHASES.find((ph) => (ph.pages || []).includes(relPath)) || {}).env || {}),
  };
  const envPackName = envVars['符号'] || null;
  // 多包叠加（v2，2026-10-11）：值可以是 `通用+电路原理`——按 `+` 拆开、**后者覆盖前者**。
  // 通用符号只维护一份（站点/符号包/通用.md），各课只写自己的增量。零回退不变：
  // 环境里任何一段包名没注册 ⇒ 明确警告，本页零符号行为。
  const envPackNames = envPackName ? envPackName.split('+').map((s) => s.trim()).filter(Boolean) : [];
  const envPacks = envPackNames.map((n) => glossaryPacks[n]);
  for (const [i, n] of envPackNames.entries()) {
    if (!envPacks[i]) glossaryWarn.add(`页面 ${relPath} 锚定的符号包「${n}」未注册——本页零符号行为`);
  }
  // 环境包词典（本页口径：词条带 href 与纯文本标题）；glossifyTex 与 autoWrapTerms 只看它。
  // 叠加顺序 = 声明顺序，后面的包覆盖前面的同名词条。
  const pageGlossaryDict = {};
  for (const [i, pack] of envPacks.entries()) {
    if (!pack) continue;
    for (const [id, e] of Object.entries(pack.dict)) {
      pageGlossaryDict[id] = {
        ...e,
        href: notationHrefOf(id, { page: pack.page }),
        titleText: plainBubbleText(e.title),
      };
    }
  }
  // 全部包的当页形态（符号级强制令牌用）：hrefBase 不带锚点，按词条补。
  const glossaryPacksForPage = Object.fromEntries(
    Object.entries(glossaryPacks).map(([name, pack]) => [
      name,
      {
        hrefBase: encodeURI(
          path.relative(path.dirname(fullPath), path.join(ROOT, pack.page))
            .replace(/\\/g, '/').replace(/\.md$/, '.html')
        ),
        dict: Object.fromEntries(Object.entries(pack.dict).map(([id, e]) => [
          id, { ...e, titleText: plainBubbleText(e.title) },
        ])),
      },
    ])
  );
  const glossaryPins = frontmatter['符号强制'] || {};
  // 符号排除（2026-10-12）：页面级显式收窄「宽覆盖包」的自动取词——撞车场合
  // （选项标号、单位、人名缩写、绝缘等级）用 frontmatter 指定禁包，手写令牌照常。
  // 两个键分别管正文（符号排除）与公式（符号排除公式）；都写 = 完全禁自动取词。
  const asIdList = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((s) => String(s).trim()).filter(Boolean);
  const symbolExclusions = {
    noProse: asIdList(frontmatter['符号排除']),
    noTex: asIdList(frontmatter['符号排除公式']),
  };
  const { proseDict: pageProseDict, texDict: pageTexDict } = applySymbolExclusions(
    pageGlossaryDict,
    symbolExclusions,
    (msg) => glossaryWarn.add(`${relPath}：${msg}`),
  );
  const glossaryHits = new Map(); // key → {title, text, href}（按需烘焙气泡 JSON）
  const pageFigures = [];        // Step 2.4 解析出的图元 IR（Step 6.5 还原成 <figure>）

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
  // 同步清空标题锚点用的中转表（下标与 mathBlocks 完全同构）
  mathPlainOf.length = 0;
  usedHeadingIds.clear();

  // ── 本页数学环境：解析 + 唯一一次符号判定（2026-10-29 重构）───────────
  // 旧实现在这一步之后还有 Step 2.6 的 autoWrapTerms 与 glossifyTex 两轮取词，
  // 各自在字符串上做正则；现在它们都不存在——判定只在这里发生一次，
  // 结果写进 IR 的节点 term 字段，渲染与标注都是同一棵树的投影。
  const pageMathEnv = {
    dictionary: mathDictionary,
    packs: envPackNames,
    exclude: {
      tex: symbolExclusions.noTex,
      prose: symbolExclusions.noProse,
    },
    forceTerm: {},
    page: relPath,
  };
  /** 本页的公式命中集（词条 id → 词条），供气泡 JSON 使用。 */
  const pageMathHits = new Map();
  // ⚠️ 2026-10-29 修：公式命中必须**合并进** `glossaryHits`（气泡 JSON 的真相源）。
  //
  // 此前公式取词写进 `pageMathHits`、正文令牌写进 `glossaryHits`，而气泡 JSON 只读
  // 后者 ⇒ **凡是在 `$…$` 里命中的符号，页面有锚点、气泡却查不到词条**，点了没反应。
  // 用户实测「det 冒不了泡」正是这个：`\det` 只出现在公式里，从不走正文取词。
  //
  // 写成「每次 renderOneMath 之后同步一份」而不是「渲染完统一合并」：`renderOneMath`
  // 内部已按 `hits.has(key)` 去重，合并本身幂等；统一合并还得记着所有调用点。
  const syncMathHits = () => {
    for (const [key, hit] of pageMathHits) {
      if (!glossaryHits.has(key)) glossaryHits.set(key, hit);
    }
  };

  // 2.1 Display Math $$...$$
  raw = raw.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
    const id = mathBlocks.length;
    totalFormulasRendered++;
    // 教材排版惯例把句末标点写进显示公式（$$….$$），在网页上独立成块后
    // 看着像渲染出了一个多余的点（用户实测反馈）。渲染前剥掉**收尾的一个**
    // 标点——只剥一个：万一公式真以省略号收尾不至于被整串误删。
    const src = tex.trim().replace(/[.。，、；;][ \t]*$/, '');
    const { rendered, plain } = renderOneMath(src, 'display', relPath, pageMathEnv, pageMathHits);
    mathBlocks.push({ display: true, html: rendered, plain });
    mathPlainOf[id] = plain;
    return `@@MATH_BLOCK_${id}@@`;
  });

  // 2.2 Inline Math $...$
  raw = raw.replace(/(?<!\$)\$(?!\$)((?:[^$\\\r\n]|\\.)+?)\$(?!\$)/g, (_, tex) => {
    const id = mathBlocks.length;
    totalFormulasRendered++;
    const { rendered, plain } = renderOneMath(tex.trim(), 'inline', relPath, pageMathEnv, pageMathHits);
    mathBlocks.push({ display: false, html: rendered, plain });
    mathPlainOf[id] = plain;
    return `@@MATH_INLINE_${id}@@`;
  });

  // Step 2.4: 图元 :::figure → @@FIGURE_n@@ 占位符（2026-10-28）
  //
  // 位置是刻意的：在公式提取（Step 2）**之后**、折叠块（Step 2.5）**之前**。
  //   · 之后：图注里的 $…$ 已是单行占位符，本模块不必懂公式；
  //   · 之前：解答层的图**就写在 :::collapse 面板里**（实测 17 张），
  //     图先换成单行占位符，collapse 的裸 `:::` 深度计数就不会把
  //     figure 的闭合当自己要配对的（块式围栏会打坏折叠块，实测过）。
  //
  // 为什么吐占位符而不是 raw HTML：Step 2.6 的 autoWrapTerms 会伸手进正文，
  // 把 `<text>B</text>` 改成 `<text>[B]{#sym-B}</text>`，随后变成 `<a>` 直接
  // 套在 `<text>` 里——SVG 的 `<a>` 不许包裸文本，是非法 SVG。占位符让 SVG
  // 在 Step 6 之后才落地，从根上避开这一步。
  //
  // 图元定义住在 站点/图库/<课程>.figures.txt（改一处、三处引用全对）。
  // 实现见 站点/plugins/figures.mjs（独立可拆卸：删文件 + 摘掉这几行即回退）。
  {
    const courseName = courseOf(relPath);
    const libFile = courseName ? `站点/图库/${courseName}.figures.txt` : null;
    const libPath = libFile ? path.join(ROOT, libFile) : null;
    // 页面里写了 :::figure 但本课没有图库 / 图库读不到 ⇒ **硬错**，不许静默把指令
    // 漏进正文（那会变成页面上的一行字面 `:::figure xxx`，读者与 AI 都当正文读）。
    if (raw.includes(':::figure')) {
      if (!courseName) {
        throw new Error(`${relPath}：页面里有 :::figure，但它不属于任何课程（无法定位图库）`);
      }
      if (!libPath || !fs.existsSync(libPath)) {
        throw new Error(`${relPath}：页面里有 :::figure，但图库 ${libFile} 不存在——先建图库或去掉该指令`);
      }
    }
    if (libPath && fs.existsSync(libPath)) {
      const lib = parseFigureLib(fs.readFileSync(libPath, 'utf-8'), libFile);
      const figOut = renderFigures(raw, {
        lib,
        libName: libFile,
        pagePath: relPath,
        // 图内标签 → 词条：只查本页符号环境，零回退
        // 返回值要给全：restore 只取 href，但 onHit 还要 title/text 才能烘出真气泡
        lookupGloss: (label) => {
          const entry = pageTexDict[label];
          if (!entry || entry.bubble === false) return null;
          return {
            key: label,
            href: entry.href || notationHrefOf(label, entry),
            title: entry.title,
            text: entry.text,
            senses: entry.senses,
          };
        },
        // 图内符号必须在这时并入 glossaryHits——气泡词典是按页烘焙的「实际命中集」，
        // 晚于 Step 2.6 的烘焙就只剩一条空气泡（这本页 JSON 里没有该词条）。
        onHit: (key, entry) => {
          const hit = { title: entry.title, text: entry.text, href: entry.href };
          if (entry.senses) hit.senses = entry.senses;
          glossaryHits.set(key, hit);
        },
      });
      raw = figOut.source;
      pageFigures.push(...figOut.figures);
      for (const w of figOut.warnings) console.warn(`[图] ${relPath}：${w}`);
    }
  }

  // Step 2.5: 折叠块 :::collapse → 原生 <details>（零 JS）
  //
  // 位置是刻意的：必须在公式提取（Step 2）**之后**、链接降级（Step 3）**之前**。
  //   - 之后：折叠块内的 $…$ 已变成单行占位符 @@MATH_*@@，模块不必懂公式语法；
  //     代码围栏也已保护，`:::` 出现在代码里不会被误转。
  //   - 之前：折叠块内的链接仍会被 Step 3/4 正常降级与重写。
  // 实现见 站点/plugins/collapse.mjs（独立可拆卸：删文件 + 摘掉这一行即回退）。
  raw = renderCollapse(raw);

  // Step 2.6: 符号气泡 [tex]{#term} → 可点击符号（渐进增强，零 JS 也可用）。
  // 位置：公式提取之后（令牌内 TeX 不与 $…$ 冲突，且渲染回调走同一套
  // wrapBareCJK）、链接降级（Step 3/4）之前（本步产物是 raw HTML，由
  // marked 原样透传）。实现见 站点/plugins/math-glossary.mjs（独立可拆卸）。
  // 词典（pageGlossaryDict）在本页处理开头就备好了——Step 2 也用它。
  // `:::glossary-dict table` 的围栏（电机学符号入门页用的）渲染成**符号总表**：
  // 每行以词条 id 作锚点，气泡里的「详细 ↗」才有精确落点。族面板只讲其中一部分符号，
  // 光靠它们拿不到逐符号的锚点（130 个符号里有 100 个只出现在教材那张符号表里）。
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

  raw = renderGlossary(raw, {
    // 正文用**排除后**的词典（被禁 id 的 prose 已清空）；手写令牌走同一份——
    // 令牌要「显式优先于自动」，所以这里传全量 dict 作 tokenDict，正文取词只认 proseDict。
    dict: pageProseDict,
    tokenDict: pageGlossaryDict,
    packs: glossaryPacksForPage,
    pins: glossaryPins,
    envName: envPackName,
    onWarn: (msg) => glossaryWarn.add(`${relPath}：${msg}`),
    onHit: (key, entry) => {
      const hit = { title: entry.title, text: entry.text, href: entry.href };
      if (entry.senses) hit.senses = entry.senses;   // v2 多义项：别在命中时丢掉
      glossaryHits.set(key, hit);
    },
    // 总表的词条**按围栏给的顺序、但取模块级解析的原文**：围栏行里的 $…$ 在 Step 2 已经
    // 被换成 MATH 占位符，还原出来的是**正文口径**的渲染（带自动取词的 \htmlData），
    // 与气泡口径（renderBubbleText，不取词）不一致，而且会在 `\mathbf F` 这种
    // 「命令 + 空格 + 参数」处把命令劈开（KaTeX 直接报错）。
    dictTable: (entries) =>
      renderDictTable(
        entries.map(({ id }) => {
          const e = pageGlossaryDict[id] || {};
          return { id, title: e.title ?? id, text: e.text ?? '' };
        }),
      ),
    renderTex: (tex) => {
      // 令牌内部的 TeX 同样用**空词库**编译：令牌自己就是可点符号，
      // 里面再套一层锚点就是嵌套 <a>（非法 DOM）。结构保证，不是约定。
      const out = compileMath({ blocks: [{ raw: tex, mode: 'inline' }] },
        { dictionary: mathDictionary, packs: [] });
      if (out.problems.some((x) => x.severity === 'error')) {
        return `<span class="math-fallback">${tex.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</span>`;
      }
      return renderMathDoc(out.docs[0], mathRenderer).html;
    },
    // 链接一律走词条自带的 href（多课程词典）；这个回退参数只作兜底
    notationHref: '',
  });
  // 气泡词典按页烘焙成 JSON——**只烘本页命中**的词条（令牌、自动取词、公式取词的
  // 实际命中集），不再是全量词典：页面体积随使用增长，不随词典增长。
  // 客户端模块从 #sym-glossary-json 读，不发任何请求。
  //
  // v2 多义项（2026-10-11）：词条可声明多个**义项**（同一个符号在不同课程下含义不同，
  // 如 $Z$ = 阻抗 or 槽数）。这里把义项一并烘进 JSON，并带上 `ctx` = **本页所属课程**——
  // 气泡列出全部义项、把本页语境那一条排在最前并标记（「实时能查到」）。
  const pageCtx = here || '';
  // 公式命中并入（见 `syncMathHits` 注释：不合并就会「有锚点、没气泡」）。
  syncMathHits();
  const glossaryJsonPayload = {
    terms: Object.fromEntries(
      [...glossaryHits.entries()]
        .filter(([, e]) => e && e.title !== undefined)
        .map(([key, e]) => {
          const item = { title: renderBubbleText(e.title), text: renderBubbleText(e.text), href: e.href };
          if (e.senses && e.senses.length) {
            item.senses = e.senses.map((s) => ({ ctx: s.ctx, text: renderBubbleText(s.text) }));
            item.ctx = pageCtx;
          }
          return [key, item];
        })
    )
  };

  // Step 3: Degrade Non-MD resources (.jpg, .heic, .doc)
  raw = raw.replace(/\[([^\]]*)\]\(([^)]+\.(?:jpg|heic|doc))\)/gi, (_, text, filePath) => {
    const baseName = path.basename(filePath);
    return `<span class="res-degrade-badge">📄 原件: ${baseName} (原件不入库，网页不提供)</span>`;
  });

  // Degrade template links
  raw = raw.replace(/\[([^\]]*)\]\(([^)]*模板\/[^)]*)\)/gi, (_, text) => {
    return `<span class="res-degrade-badge">📋 ${text} (模板不随站点发布)</span>`;
  });

  // Step 4: Rewrite internal Markdown links (.md -> .html)
  raw = raw.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, href) => {
    if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('#') || href.startsWith('mailto:')) {
      return match;
    }
    try {
      const decoded = decodeURIComponent(href);
      if (decoded.includes('.md')) {
        const rewritten = decoded.replace(/\.md(#.*)?$/, '.html$1');
        return `[${text}](${encodeURI(rewritten)})`;
      }
    } catch (_) {}
    return match;
  });

  // Step 5: Render Markdown to HTML via marked
  //
  // 标题里的公式锚点问题在 renderer.heading 里解决（只对 id 降级、不影响排版），
  // 详见上面 renderer.heading 的注释。
  // 表格的滚动容器/分级类/ARIA 全部在 renderer.table 里产出（不再正则后处理）
  let htmlContent = marked.parse(raw);

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
    return `<div class="katex-scroll-container">${math.html}</div>`;
  });

  htmlContent = htmlContent.replace(/@@MATH_INLINE_(\d+)@@/g, (_, id) => {
    const math = mathBlocks[parseInt(id)];
    return math.html;
  });

  // Step 6.5: 图元还原 @@FIGURE_n@@ → 完整 <figure>（2026-10-28）
  //
  // 为什么放到这么晚：Step 2.6 的 autoWrapTerms 会伸手进正文把术语包成令牌，
  // 那一刻正文里**必须还没有 SVG**（否则它会把 `<text>B</text>` 改成
  // `<text>[B]{#sym-B}</text>`，随后产生非法的 `<text><a>B</a></text>`）。
  // marked 也已经跑完，SVG 里的 `*`、`|`、`[]()` 不会被当 Markdown 语法。
  if (pageFigures.length) {
    // 不需要 lookupGloss：图内符号在 Step 2.4 解析期就已按 `@词条` 解析完，
    // IR.symbols 里带着 key/href，restore 只按标签做替换。
    htmlContent = restoreFigures(htmlContent, pageFigures);
    // ⚠️ 图注里的行内公式要再还原一次。
    // 图注文字来自 `:::figure id | 图注`，作者会在里面写 `$u_i$`；但它在 Step 2
    // 就变成了 `@@MATH_INLINE_n@@`（那是 **Step 6** 才换回 KaTeX 的），而
    // restoreFigures 在 Step 6.5 才跑——它把图注原文带进 HTML 时，Step 6 的
    // 整轮 replace 已经过去了。实测后果：页面上直接显示
    // 「上一行为输入 @@MATH_INLINE_84@@（幅值 20 V…」这种占位符。
    //
    // 图注在**三处各存一份**，必须一起换，否则页面显示对了、AI 读到的仍是占位符：
    //   ① <figcaption>（人看的）
    //   ② 图元 <svg> 的 aria-label + <script class="fig-data">（AI 读的结构表来源）
    //   ③ 页脚 <script id="figure-index-json">（MCP 的图索引）
    // ①②在下面的 figure 块替换里一并处理；③ 由模板调 buildFigureIndex 现算，
    // 所以那边直接对**已经填好的 caption** 取（见模板处的 figureIndexMath）。
    const fillMath = (s) => s.replace(
      /@@MATH_INLINE_(\d+)@@/g,
      (_, id) => (mathBlocks[parseInt(id)] || {}).html || '');
    htmlContent = htmlContent.replace(
      /<figure class="fig"[\s\S]*?<\/figure>/g, fillMath);
  }

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
    const rawTitle = hMatch[3]
      .replace(/<span class="ML__latex"[^>]*data-math-plain="([^"]*)"[\s\S]*?<\/span>/g,
        (m0, plain) => plain)
      .replace(/<span class="katex"[\s\S]*?<\/span><\/span><\/span>/g,
        (m0) => {
          const ann = m0.match(/<annotation encoding="application\/x-tex">([\s\S]*?)<\/annotation>/);
          return ann ? ann[1].replace(/&amp;/g, '&') : '';
        })
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
    // 「首页」只在真正看首页时出现：站长定案「点大标题就能回首页」，
    // 所以面包屑首项不必一直挂一个「首页」——但保留它会多一层噪声。
    // 折中：首页自己不加（否则显示「首页 / 首页」），其余页加。
    if (relPath !== 'README.md') {
      // 首页就是站点根 `/`（README 即根）。data-path 给空串没有意义
      // （模板按 `b.dataPath ?` 判，空串等于不给，链接会落到 site-root 的
      // 无 data-path 分支去反推，白绕一圈）——所以这里**显式**给 `./`。
      breadcrumbs.push({ label: '首页', href: `${rootRel}` });
    }
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
  // buildNavModel 产出归一化节点树 + 烘焙 JSON；本处只负责出 HTML。
  const navModel = buildNavModel(NAV_STRUCTURE, relPath);
  const navJsonPayload = navModel.json;

  // Render Sidebar Tree HTML with Collapsible Groups
  // 每个 <li> 带 data-node-id（归一化节点 id）：SPA 换页后 drawer-sync 据此对齐 active。
  const attrEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  function renderNav(nodes, depth = 0) {
    let out = '<ul class="drawer-nav-list">';
    for (const node of nodes) {
      const hasChildren = node.children && node.children.length > 0;
      const nodeActive = isActive(node, relPath);
      const nodeExpanded = isExpanded(node, relPath)
        || (depth === 0 && node.label === "课程总览");

      // 有子节点的组节点（票 B，2026-10-22 回归 530427c 始冀形态）：
      // · 有索引页（indexHref 非空）→ 标题本身就是 drawer-nav-link 链接（点击进索引页），
      //   header **不带** nav-header-clickable——shirone-reader 的 clickableHeader 绑定
      //   只命中带该类的 header，点击只走 spa-router 的 data-path 拼接，不折叠；
      //   折叠由 chevron 按钮单独负责（530427c 原版同款天然分离，零事件机关）。
      // · 无索引页（无 path 的组、path 与子项重复的电机学章节点）→ 纯标题 +
      //   nav-header-clickable（整行点击 = 折叠），现状不变。
      // indexHref 判据零改动（nav-structure.mjs 的 indexHrefOf 是唯一真相源），
      // 本处只把它的输出从「小图标链接」改接到「标题链接」上。
      if (hasChildren) {
        const titleHtml = node.indexHref
          ? `<a href="${rootRel}${node.indexHref}" data-path="${node.indexHref}" class="drawer-nav-link"><span>${node.label}</span></a>`
          : `<span class="drawer-section-title-text">${node.label}</span>`;
        // ⚠️ 2026-10-26 修（首帧闪烁）：组节点此前**不输出 active 类**——
        // 只有运行时 drawer-sync 的 recompute() 会补上，于是「首屏直进目录页」时
        // 侧栏先无高亮、几十~一两百毫秒后才闪出来。
        // 判定用的就是上面那一个 nodeActive（与运行时 collectActive 同一份 isActive），
        // 两边输出对齐即可，不新增任何判定逻辑。
        out += `<li class="drawer-nav-group ${nodeActive ? 'active' : ''} ${nodeExpanded ? 'expanded' : 'collapsed'}" data-node-id="${attrEsc(node.id)}">
          <div class="nav-group-header ${node.indexHref ? '' : 'nav-header-clickable'}">
            ${titleHtml}
            <button class="nav-collapse-btn" aria-label="折叠或展开 ${node.label}" title="折叠/展开">
              <svg class="chevron-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>
            </button>
          </div>
          <div class="nav-nested-wrapper">
            <div class="nav-nested">
              ${renderNav(node.children, depth + 1)}
            </div>
          </div>
        </li>`;
      } else {
        if (node.href) {
          out += `<li class="drawer-nav-item ${nodeActive ? 'active' : ''}" data-node-id="${attrEsc(node.id)}">
            <a href="${rootRel}${node.href}" data-path="${node.href}" class="drawer-nav-link">
              <span>${node.label}</span>
            </a>
          </li>`;
        } else {
          out += `<li class="drawer-section-title" data-node-id="${attrEsc(node.id)}">${node.label}</li>`;
        }
      }
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
    const match = rawTitle.match(/[（(](原书\s*p[^）)]+)[）)]/);
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
      <div class="toc-title">目录</div>
      <ul class="toc-list">
        ${toc.map(item => `<li class="toc-item level-${item.level}"><a href="#${item.id}">${item.title}</a></li>`).join('')}
      </ul>
    </aside>`;
  }

  // Final HTML Document
  const finalHtml = `<!DOCTYPE html>
<html lang="zh-CN" data-depth="${rootRel === './' ? 0 : rootRel.split('../').length - 1}" data-root="${rootRel}" data-canonical-root="${CANONICAL_ROOT}"${ASSISTANT_KEY ? ` data-assistant-key="${ASSISTANT_KEY}"` : ''}>
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
    } catch (e) { /* 隐私模式下 localStorage 可能抛错，忽略 */ }
  })();
  </script>
  <!-- 数学排版样式（2026-10-29 换引擎）：MathLive 静态样式。
       它复用同一批 woff2 字体（assets/mathlive/fonts/），字体文件不用另备。
       ⚠️ 必须走 assetUrl（同其余四张样式表）：此前它是唯一裸引用的 CSS，没有内容哈希戳，
       于是**改了它浏览器永远读旧缓存**——补丁明明写进 dist、页面就是不生效，
       排查时会误判成「CSS 规则不对」。（2026-10-29 实测踩到。） -->
  <link rel="stylesheet" href="${rootRel}${assetUrl('assets/mathlive/mathlive-static.css')}">
  <link rel="stylesheet" href="${rootRel}${assetUrl('assets/theme/shirone-reader.css')}">
  <link rel="stylesheet" href="${rootRel}${assetUrl('assets/plugins/site-search.css')}">
  <link rel="stylesheet" href="${rootRel}${assetUrl('assets/plugins/chat-panel.css')}">
  <link rel="stylesheet" href="${rootRel}${assetUrl('assets/plugins/figures.css')}">
  <!-- 站点图标：动画 GIF 为主（Chrome/Firefox/Edge 会动），静态 PNG 作不支持动画时的回退 -->
  <link rel="icon" type="image/gif" href="${rootRel}assets/favicon/favicon.gif">
  <link rel="alternate icon" type="image/png" href="${rootRel}assets/favicon/favicon.png">
  <link rel="apple-touch-icon" href="${rootRel}assets/favicon/apple-touch-icon.png">
</head>
<body data-site-path="${sitePathOf(relPath)}">
  <div class="drawer-backdrop" id="drawer-backdrop"></div>

  <div class="site-shell">
    <!-- Left Column: Full-Height Sidebar (整列导航栏) -->
    <aside class="m3-drawer" id="m3-drawer">
      <div class="drawer-header-brand">
        <a href="${rootRel}" class="sidebar-brand">
          <img class="site-title-icon" src="${rootRel}assets/favicon/brand.gif" alt="" width="48" height="48" aria-hidden="true">
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
              </div>
            </div>
          </div>

          <button class="m3-icon-btn" id="search-toggle" aria-label="全站搜索" title="全站搜索">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
          </button>

          <!-- 学习助手入口：图标简化自 r-906《In My Hands》封面的左手。
               识别特征保留：四指分开向上、碎片白缝、拇指外撇、掌心圆洞、分离的腕部。 -->
          <button class="m3-icon-btn hand-btn" id="assistant-toggle" aria-label="学习助手" title="学习助手" aria-expanded="false">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <!-- 四指：指缝留 0.8px 以上，22px 下才不糊成一坨 -->
              <rect x="6.2" y="3.4" width="2.3" height="9.2" rx="1.15"/>
              <rect x="9.3" y="2.2" width="2.3" height="10.4" rx="1.15"/>
              <rect x="12.4" y="3.0" width="2.3" height="9.6" rx="1.15"/>
              <rect x="15.5" y="5.6" width="2.2" height="7.0" rx="1.1"/>
              <!-- 掌部 -->
              <path d="M6.1 11.4h11.8v4.4a2.3 2.3 0 0 1-2.3 2.3H8.4a2.3 2.3 0 0 1-2.3-2.3z"/>
              <!-- 拇指：外撇，与掌留白缝 -->
              <path d="M6.0 12.4 3.9 14.5a1.3 1.3 0 1 0 1.84 1.84l2.1-2.1z"/>
              <!-- 掌心空洞 -->
              <circle cx="11.5" cy="14.0" r="1.3" fill="#fff"/>
              <!-- 腕部：分离的一截 -->
              <path d="M8.6 19.4h6.8v1.3a1.6 1.6 0 0 1-1.6 1.6h-3.6a1.6 1.6 0 0 1-1.6-1.6z"/>
            </svg>
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
            <!-- Breadcrumb in page body -->
            <nav class="m3-breadcrumb">
              ${breadcrumbs.map((b, i) => (i === breadcrumbs.length - 1 || b.href === '#') ? `<span>${b.label}</span>${i === breadcrumbs.length - 1 ? '' : '<span class="m3-breadcrumb-sep">/</span>'}` : `<a href="${b.href}"${b.dataPath ? ` data-path="${b.dataPath}"` : ''}>${b.label}</a><span class="m3-breadcrumb-sep">/</span>`).join('')}
            </nav>

            ${metaChipsHtml ? `<div class="meta-chip-bar">${metaChipsHtml}</div>` : ''}

            <div class="article-content">
              ${htmlContent}
            </div>

            ${pagingHtml}

            <footer class="site-footer">
              <p class="site-footer__legal">
                © 2026 ArchivalEra · 本站自研代码与解析文字以
                <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="license noopener">AGPL-3.0</a>
                许可发布 · <a href="https://github.com/ArchivalEra/S26-1_202609" target="_blank" rel="noopener">仓库源码</a>
              </p>
              <p class="site-footer__disclaimer">
                本站涉及的教材题目原文与章节结构，版权归各原书作者与出版社所有，本站解析为个人学习笔记；
                页面主题样式来自 Shirone Material 3 Reader（MIT）；KaTeX、marked 等第三方库依其自身许可证分发。
              </p>
            </footer>
          </article>
        </main>

        <!-- Table of Contents -->
        ${tocHtml}
      </div>
    </div>
  </div>

  <script src="${rootRel}${assetUrl('assets/theme/shirone-reader.js')}" defer></script>
  <script src="${rootRel}${assetUrl('assets/plugins/disclosure-anchor.js')}" defer></script>
  <script src="${rootRel}${assetUrl('assets/plugins/figures.js')}" defer></script>
  <script type="application/json" id="sym-glossary-json">${JSON.stringify(glossaryJsonPayload).replace(/<\//g, '<\\/')}</script>
  <!-- 图元索引烘焙（2026-10-28）：本页所有图的 IR 汇总。
       三个消费者读同一份——页面交互、site_figure 工具、构建期提到的静态结构表。
       与 sym-glossary-json / nav-structure-json 同一个范式：构建期烘、客户端不发请求。 -->
  <script type="application/json" id="figure-index-json">${JSON.stringify(buildFigureIndex(pageFigures)).replace(/<\//g, '<\\/').replace(/@@MATH_INLINE_(\d+)@@/g, (_, i) => (mathBlocks[parseInt(i)] || {}).html || '')}</script>
  <!-- 侧栏形状烘焙（阶段一）：nav-structure.mjs（buildNavModel）产出的归一化树 + 判定结果。
       site_index / site_navigate / drawer-sync 三个消费者都读这一份，不再爬侧栏 DOM。 -->
  <script type="application/json" id="nav-structure-json">${JSON.stringify(navJsonPayload).replace(/<\//g, '<\\/')}</script>
  <!-- 站点页面清单烘焙（2026-10-29）：TARGET_FILES 派生的**真实产物路径**。
       site_navigate 的 to=page 靠它判「这一页到底存不存在」——此前判据是「像不像
       index.html」，于是模型拼错层级的路径（少了课程层）也能通过，SPA fetch 撞 404。
       注意它是**产物清单**不是导航清单：README / 维护条例 / 符号包都在内。 -->
  <script type="application/json" id="site-pages-json">${JSON.stringify(SITE_PAGE_PATHS).replace(/<\//g, '<\\/')}</script>
  <script src="${rootRel}${assetUrl('assets/plugins/math-glossary.js')}" defer></script>
  <script src="${rootRel}${assetUrl('assets/plugins/site-search.js')}" defer></script>
  <script src="${rootRel}${assetUrl('assets/plugins/webmcp-loader.js')}" defer></script>
  <!-- relay 连接器**不带 defer**：它要在解析期用 document.write 插入 vendor 的 embed.js，
       而 embed.js 靠 document.currentScript.src 定位同目录的 widget.html——
       defer 脚本执行时 readyState 已是 interactive，document.write 会毁掉文档。 -->
  <script src="${rootRel}${assetUrl('assets/plugins/webmcp-relay.js')}"></script>
  <!-- site-root：部署根探测与链接修正。同步执行、先于一切读 data-root 的脚本
       （drawer-sync / spa-router / chat-panel / loader），否则它们拿到错误的相对根。 -->
  <script src="${rootRel}${assetUrl('assets/plugins/site-root.js')}"></script>
  <script>try { fixSiteRoot(); } catch (e) { /* 探测失败保持构建期相对路径 */ }</script>
  <!-- 侧栏形状运行时：先于 drawer-sync，暴露 window.__navStructure（读 JSON + 共享判定）。 -->
  <script src="${rootRel}${assetUrl('assets/plugins/nav-structure.js')}" defer></script>
  <script src="${rootRel}${assetUrl('assets/plugins/drawer-sync.js')}" defer></script>
  <script src="${rootRel}${assetUrl('assets/plugins/chat-panel.js')}" defer></script>
  <script src="${rootRel}${assetUrl('assets/plugins/spa-router.js')}" defer></script>
  <!-- SW 已根除（2026-10-23）：只保留一次性清理，反注册老用户的旧 SW + 清 caches。
       localStorage 标记去重，清完一次后本脚本自动变 no-op。 -->
  <script src="${rootRel}${assetUrl('assets/plugins/sw-kill.js')}" defer></script>
</body>
</html>`;

  const outFilePath = path.join(DIST_DIR, targetHtmlPath);
  // 构建期兜底：任何 `@@MATH_INLINE_<数字>@@` 残留在产物里都是 bug。
  // 它意味着某段文字走了「数学占位符已生成、但没被 Step 6 还原」的路径——
  // 2026-10-29 实测发生在图注上（`:::figure id | 图注里写 $u_i$`）：
  // 图注在 Step 2 变占位符、restoreFigures 在 Step 6.5 才把它写进 HTML，
  // 那时 Step 6 的整轮替换已过去，页面上就直挺挺显示 `@@MATH_INLINE_84@@`。
  // 这类残留**肉眼一眼能看出、但构建与全部测试都不报错**，所以在这里硬拦。
  //
  // 只认带数字的形式：文档页（维护细则）会**故意**写出这个模式的字面例子，
  // 那种没有数字的 `@@MATH_INLINE_n@@` 是正文，不是残留。
  const leaked = finalHtml.match(/@@MATH_INLINE_\d+@@/);
  if (leaked) {
    throw new Error(
      `${targetHtmlPath} 的产物里残留数学占位符 ${leaked[0]}` +
      '（说明有段文字晚了 Step 6 才进 HTML——多半是图注或模板里新加的字段）');
  }
  fs.mkdirSync(path.dirname(outFilePath), { recursive: true });
  fs.writeFileSync(outFilePath, finalHtml, 'utf-8');

  // 检索语料：只收正文（htmlContent），标题用页面标题；URL 存**相对站点根**的路径
  // （不带前导斜杠），这样部署在任意子路径下都能由客户端补上站点根前缀。
  searchDocs.push(extractSearchDoc(htmlContent, {
    url: targetHtmlPath.split('/').map(seg => encodeURIComponent(seg)).join('/'),
    title: pageMeta.title
  }));

  // Also create README.html at root if it's README.md
  if (relPath === 'README.md') {
    fs.writeFileSync(path.join(DIST_DIR, 'README.html'), finalHtml, 'utf-8');
  }

  console.log(`[build] Generated: ${targetHtmlPath}`);
  // **不再生成 encoded alias**（2026-10-11 用户定案「纯中文路径」）：
  // 同页面在 dist 里双写（中文目录 + %-编码目录）会让浏览器把相对路径解析到编码那一份下——
  // 图片/子资源在那份里不存在，从编码 URL 进入时整批图片挂掉（实测习题册第一章
  // 35 张图里 33 张加载失败）。站点与 EdgeOne 都支持中文路径，站内链接也一律写中文。
}

console.log(`[build] Completed! Rendered ${totalFormulasRendered} math formulas with ${formulaErrors} errors.`);

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
