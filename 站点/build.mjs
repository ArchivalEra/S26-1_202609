import fs from 'node:fs';
import path from 'node:path';
import { marked, yaml } from './vendor.mjs';
import katex from './assets/katex/katex.mjs';

const ROOT = path.resolve('..'); // /mnt/hdd/zcode-on-the-move/S26-1Shitass
const SITE_DIR = path.resolve('.');
const DIST_DIR = path.join(SITE_DIR, 'dist');

console.log(`[build] Starting static site generation...`);
console.log(`[build] Repo Root: ${ROOT}`);
console.log(`[build] Output: ${DIST_DIR}`);

// 1. Scan target markdown files
const TARGET_FILES = [
  'README.md',
  '课程/index.md',
  '课程/工程数学/index.md',
  '课程/工程数学/作业/index.md',
  '课程/工程数学/教材解析/index.md',
  '课程/工程数学/教材解析/第01章-行列式/第01章-1.1-二阶与三阶行列式.md',
  '课程/工程数学/教材解析/第01章-行列式/第01章-1.2-n阶行列式.md',
  '课程/工程数学/教材解析/第01章-行列式/第01章-1.3-克莱姆法则.md',
  '课程/工程数学/教材解析/第01章-行列式/第01章-1.4-用MATLAB计算行列式.md',
  '课程/工程数学/教材解析/第02章-矩阵/第02章-2.1-矩阵的概念及运算.md',
  '课程/工程数学/教材解析/第02章-矩阵/第02章-2.2-逆矩阵.md',
  '课程/工程数学/教材解析/第02章-矩阵/第02章-2.3-矩阵的初等变换与初等矩阵.md',
  '课程/工程数学/教材解析/第02章-矩阵/第02章-2.4-矩阵的秩.md',
  '课程/工程数学/教材解析/第02章-矩阵/第02章-2.5-用MATLAB进行矩阵运算.md',
  '课程/工程数学/课堂笔记/index.md',
  '课程/工程数学/课堂笔记/2026-09-17-determinants-order-2-3.md',
  '课程/工程数学/课堂笔记/2026-09-17-determinants-transcript-notes.md',
  '课程/工程数学/原始资料/index.md',
  '课程/工程数学/音频/index.md',
  '维护条例.md',
  '维护细则.md'
];

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
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

copyDir(path.join(SITE_DIR, 'assets'), path.join(DIST_DIR, 'assets'));
console.log(`[build] Copied offline assets to dist/assets/`);

// 2. Pre-read metadata of all files for navigation & paging
const pageMetaMap = new Map();

for (const relPath of TARGET_FILES) {
  const fullPath = path.join(ROOT, relPath);
  if (!fs.existsSync(fullPath)) continue;
  const content = fs.readFileSync(fullPath, 'utf-8');
  let title = path.basename(relPath, '.md');
  let frontmatter = {};

  const fmMatch = content.match(/^---\r?\n([\s\S]+?)\r?\n---/);
  if (fmMatch) {
    try {
      frontmatter = yaml.load(fmMatch[1]) || {};
      if (frontmatter.name) title = frontmatter.name;
    } catch (e) {
      console.warn(`[warn] Failed to parse frontmatter in ${relPath}: ${e.message}`);
    }
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
    htmlRelPath: relPath === 'README.md' ? 'index.html' : relPath.replace(/\.md$/, '.html')
  });
}

// 3. Define navigation structure
const NAV_STRUCTURE = [
  { label: "首页", path: "README.md" },
  {
    label: "课程总览",
    path: "课程/index.md",
    children: [
      {
        label: "工程数学",
        path: "课程/工程数学/index.md",
        children: [
          {
            label: "教材解析",
            path: "课程/工程数学/教材解析/index.md",
            children: [
              {
                label: "第01章 行列式",
                children: [
                  { label: "1.1 二阶与三阶行列式", path: "课程/工程数学/教材解析/第01章-行列式/第01章-1.1-二阶与三阶行列式.md" },
                  { label: "1.2 n阶行列式", path: "课程/工程数学/教材解析/第01章-行列式/第01章-1.2-n阶行列式.md" },
                  { label: "1.3 克莱姆法则", path: "课程/工程数学/教材解析/第01章-行列式/第01章-1.3-克莱姆法则.md" },
                  { label: "1.4 用MATLAB计算行列式", path: "课程/工程数学/教材解析/第01章-行列式/第01章-1.4-用MATLAB计算行列式.md" }
                ]
              },
              {
                label: "第02章 矩阵",
                children: [
                  { label: "2.1 矩阵的概念及运算", path: "课程/工程数学/教材解析/第02章-矩阵/第02章-2.1-矩阵的概念及运算.md" },
                  { label: "2.2 逆矩阵", path: "课程/工程数学/教材解析/第02章-矩阵/第02章-2.2-逆矩阵.md" },
                  { label: "2.3 初等变换与初等矩阵", path: "课程/工程数学/教材解析/第02章-矩阵/第02章-2.3-矩阵的初等变换与初等矩阵.md" },
                  { label: "2.4 矩阵的秩", path: "课程/工程数学/教材解析/第02章-矩阵/第02章-2.4-矩阵的秩.md" },
                  { label: "2.5 用MATLAB进行矩阵运算", path: "课程/工程数学/教材解析/第02章-矩阵/第02章-2.5-用MATLAB进行矩阵运算.md" }
                ]
              }
            ]
          },
          {
            label: "课堂笔记",
            path: "课程/工程数学/课堂笔记/index.md",
            children: [
              { label: "09-17 行列式与沙路法则", path: "课程/工程数学/课堂笔记/2026-09-17-determinants-order-2-3.md" },
              { label: "09-17 课堂听课整理", path: "课程/工程数学/课堂笔记/2026-09-17-determinants-transcript-notes.md" }
            ]
          },
          { label: "作业 (索引)", path: "课程/工程数学/作业/index.md" },
          { label: "原始资料 (索引)", path: "课程/工程数学/原始资料/index.md" },
          { label: "音频 (索引)", path: "课程/工程数学/音频/index.md" }
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
  "课程/工程数学/教材解析/第01章-行列式/第01章-1.1-二阶与三阶行列式.md",
  "课程/工程数学/教材解析/第01章-行列式/第01章-1.2-n阶行列式.md",
  "课程/工程数学/教材解析/第01章-行列式/第01章-1.3-克莱姆法则.md",
  "课程/工程数学/教材解析/第01章-行列式/第01章-1.4-用MATLAB计算行列式.md",
  "课程/工程数学/教材解析/第02章-矩阵/第02章-2.1-矩阵的概念及运算.md",
  "课程/工程数学/教材解析/第02章-矩阵/第02章-2.2-逆矩阵.md",
  "课程/工程数学/教材解析/第02章-矩阵/第02章-2.3-矩阵的初等变换与初等矩阵.md",
  "课程/工程数学/教材解析/第02章-矩阵/第02章-2.4-矩阵的秩.md",
  "课程/工程数学/教材解析/第02章-矩阵/第02章-2.5-用MATLAB进行矩阵运算.md"
];

const NOTES_ORDER = [
  "课程/工程数学/课堂笔记/2026-09-17-determinants-order-2-3.md",
  "课程/工程数学/课堂笔记/2026-09-17-determinants-transcript-notes.md"
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

// Custom renderer for Marked
const renderer = new marked.Renderer();

renderer.heading = function ({ depth, text }) {
  const clean = text.replace(/<[^>]+>/g, '');
  const id = clean
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '') || ('h-' + Math.random().toString(36).substring(2, 7));
  return `<h${depth} id="${id}">${text}</h${depth}>`;
};

marked.use({ renderer });

// 4. Build each page
let totalFormulasRendered = 0;
let formulaErrors = 0;

for (const relPath of TARGET_FILES) {
  const fullPath = path.join(ROOT, relPath);
  if (!fs.existsSync(fullPath)) continue;

  let raw = fs.readFileSync(fullPath, 'utf-8');
  const pageMeta = pageMetaMap.get(relPath);

  // Strip frontmatter
  let frontmatter = {};
  const fmMatch = raw.match(/^---\r?\n([\s\S]+?)\r?\n---/);
  if (fmMatch) {
    try {
      frontmatter = yaml.load(fmMatch[1]) || {};
    } catch (_) {}
    raw = raw.slice(fmMatch[0].length).trim();
  }

  // Strip HTML comments (like AUTO-CATALOG)
  raw = raw.replace(/<!--[\s\S]*?-->/g, '');

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
  raw = raw.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
    const id = mathBlocks.length;
    totalFormulasRendered++;
    const safeTex = wrapBareCJK(tex.trim());
    let rendered = '';
    try {
      rendered = katex.renderToString(safeTex, {
        displayMode: true,
        throwOnError: false,
        trust: true
      });
    } catch (e) {
      formulaErrors++;
      rendered = `<span class="katex-error">${e.message}</span>`;
    }
    mathBlocks.push({ display: true, html: rendered });
    return `@@MATH_BLOCK_${id}@@`;
  });

  // 2.2 Inline Math $...$
  raw = raw.replace(/(?<!\$)\$(?!\$)((?:[^$\\\r\n]|\\.)+?)\$(?!\$)/g, (_, tex) => {
    const id = mathBlocks.length;
    totalFormulasRendered++;
    const safeTex = wrapBareCJK(tex.trim());
    let rendered = '';
    try {
      rendered = katex.renderToString(safeTex, {
        displayMode: false,
        throwOnError: false,
        trust: true
      });
    } catch (e) {
      formulaErrors++;
      rendered = `<span class="katex-error">${e.message}</span>`;
    }
    mathBlocks.push({ display: false, html: rendered });
    return `@@MATH_INLINE_${id}@@`;
  });

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
  let htmlContent = marked.parse(raw);
  htmlContent = htmlContent
    .replace(/<table>/g, '<div class="table-scroll-container"><table>')
    .replace(/<\/table>/g, '</table></div>');

  // Extract TOC headings
  const toc = [];
  const headingRegex = /<h([23]) id="([^"]+)">([^<]+)<\/h[23]>/g;
  let hMatch;
  while ((hMatch = headingRegex.exec(htmlContent)) !== null) {
    toc.push({
      level: parseInt(hMatch[1]),
      id: hMatch[2],
      title: hMatch[3]
    });
  }

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

  // Step 7: Compute relative path to root for assets
  const targetHtmlPath = relPath === 'README.md' ? 'index.html' : relPath.replace(/\.md$/, '.html');
  const depth = targetHtmlPath.split('/').length - 1;
  const rootRel = depth === 0 ? './' : '../'.repeat(depth);

  // Compute Breadcrumbs
  const breadcrumbs = [
    { label: "首页", href: `${rootRel}index.html` }
  ];
  if (relPath === '课程/index.md') {
    // Top-level course index
  } else if (relPath.startsWith('课程/工程数学/')) {
    breadcrumbs.push({ label: "课程总览", href: `${rootRel}课程/index.html` });
    breadcrumbs.push({ label: "工程数学", href: `${rootRel}课程/工程数学/index.html` });
    if (relPath.includes('/教材解析/')) {
      breadcrumbs.push({ label: "教材解析", href: `${rootRel}课程/工程数学/教材解析/index.html` });
      if (relPath.includes('/第01章-行列式/')) breadcrumbs.push({ label: "第01章 行列式", href: '#' });
      if (relPath.includes('/第02章-矩阵/')) breadcrumbs.push({ label: "第02章 矩阵", href: '#' });
    } else if (relPath.includes('/课堂笔记/')) {
      breadcrumbs.push({ label: "课堂笔记", href: `${rootRel}课程/工程数学/课堂笔记/index.html` });
    }
  }
  breadcrumbs.push({ label: pageMeta.title, href: '#' });

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

  // Render Sidebar Tree HTML
  function renderNav(nodes) {
    let out = '<ul class="drawer-nav-list">';
    for (const node of nodes) {
      if (node.path) {
        const itemMeta = pageMetaMap.get(node.path);
        const isActive = node.path === relPath;
        const itemHref = `${rootRel}${itemMeta ? itemMeta.htmlRelPath : node.path}`;
        out += `<li class="drawer-nav-item ${isActive ? 'active' : ''}">
          <a href="${itemHref}">
            <span>${node.label}</span>
          </a>
        </li>`;
      } else {
        out += `<li class="drawer-section-title">${node.label}</li>`;
      }
      if (node.children) {
        out += `<div class="nav-nested">${renderNav(node.children)}</div>`;
      }
    }
    out += '</ul>';
    return out;
  }

  const drawerHtml = renderNav(NAV_STRUCTURE);

  // Render Frontmatter Meta Chips
  let metaChipsHtml = '';
  if (frontmatter.course) metaChipsHtml += `<span class="meta-chip primary">📚 ${frontmatter.course}</span>`;
  if (frontmatter.category) metaChipsHtml += `<span class="meta-chip">🏷️ ${frontmatter.category}</span>`;
  if (frontmatter.status) metaChipsHtml += `<span class="meta-chip">⚡ 状态: ${frontmatter.status}</span>`;
  if (frontmatter.last_updated) metaChipsHtml += `<span class="meta-chip">📅 更新: ${frontmatter.last_updated}</span>`;
  if (frontmatter.sources) metaChipsHtml += `<span class="meta-chip">📖 来源: ${Array.isArray(frontmatter.sources) ? frontmatter.sources.join(', ') : frontmatter.sources}</span>`;

  // Render Paging HTML
  let pagingHtml = '';
  if (prevPage || nextPage) {
    pagingHtml = '<div class="m3-paging-container">';
    if (prevPage) {
      pagingHtml += `<a class="paging-card paging-prev" href="${rootRel}${prevPage.htmlRelPath}">
        <span class="paging-label">← 上一节</span>
        <span class="paging-title">${prevPage.title}</span>
      </a>`;
    }
    if (nextPage) {
      pagingHtml += `<a class="paging-card paging-next" href="${rootRel}${nextPage.htmlRelPath}">
        <span class="paging-label">下一节 →</span>
        <span class="paging-title">${nextPage.title}</span>
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
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${pageMeta.title} | S26-1 课程知识库 - isui.ren</title>
  <link rel="stylesheet" href="${rootRel}assets/katex/katex.min.css">
  <link rel="stylesheet" href="${rootRel}assets/theme/shirone-reader.css">
</head>
<body>
  <!-- Top App Bar -->
  <header class="m3-top-app-bar">
    <div class="top-bar-left">
      <button class="m3-icon-btn" id="drawer-toggle" aria-label="打开菜单">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
      </button>
      <a href="${rootRel}index.html" class="site-title">
        <span>S26-1 课程知识库</span>
      </a>
    </div>
    <div class="top-bar-right">
      <button class="m3-icon-btn" id="palette-toggle" aria-label="调色盘" title="自定义主题强调色">
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

      <button class="m3-icon-btn" id="theme-toggle" aria-label="切换昼夜主题">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
      </button>
    </div>
  </header>

  <div class="drawer-backdrop" id="drawer-backdrop"></div>

  <div class="layout-container">
    <!-- Sidebar Drawer -->
    <nav class="m3-drawer" id="m3-drawer">
      <div class="drawer-section-title">课程导航目录</div>
      ${drawerHtml}
    </nav>

    <!-- Content Area -->
    <main class="content-wrapper">
      <article class="article-container">
        <!-- Breadcrumb -->
        <nav class="m3-breadcrumb">
          ${breadcrumbs.map((b, i) => i === breadcrumbs.length - 1 ? `<span>${b.label}</span>` : `<a href="${b.href}">${b.label}</a><span class="m3-breadcrumb-sep">/</span>`).join('')}
        </nav>

        ${metaChipsHtml ? `<div class="meta-chip-bar">${metaChipsHtml}</div>` : ''}

        <div class="article-content">
          ${htmlContent}
        </div>

        ${pagingHtml}
      </article>
    </main>

    <!-- Table of Contents -->
    ${tocHtml}
  </div>

  <script src="${rootRel}assets/katex/katex.min.js"></script>
  <script src="${rootRel}assets/theme/shirone-reader.js"></script>
</body>
</html>`;

  const outFilePath = path.join(DIST_DIR, targetHtmlPath);
  fs.mkdirSync(path.dirname(outFilePath), { recursive: true });
  fs.writeFileSync(outFilePath, finalHtml, 'utf-8');

  // Also create README.html at root if it's README.md
  if (relPath === 'README.md') {
    fs.writeFileSync(path.join(DIST_DIR, 'README.html'), finalHtml, 'utf-8');
  }

  console.log(`[build] Generated: ${targetHtmlPath}`);
  const encodedTargetHtmlPath = targetHtmlPath.split('/').map(seg => encodeURIComponent(seg)).join('/');
  if (encodedTargetHtmlPath !== targetHtmlPath) {
    const encodedOutFilePath = path.join(DIST_DIR, encodedTargetHtmlPath);
    fs.mkdirSync(path.dirname(encodedOutFilePath), { recursive: true });
    fs.writeFileSync(encodedOutFilePath, finalHtml, 'utf-8');
    console.log(`[build] Generated encoded alias: ${encodedTargetHtmlPath}`);
  }
}

console.log(`[build] Completed! Rendered ${totalFormulasRendered} math formulas with ${formulaErrors} errors.`);
