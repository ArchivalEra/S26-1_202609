import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked, yaml } from './vendor.mjs';
import katex from './assets/katex/katex.mjs';
import { renderCollapse } from './plugins/collapse.mjs';
import { DISCLOSURE_ANCHOR_JS } from './plugins/disclosure-anchor.mjs';
import { parseGlossaryDict, renderGlossary, glossifyTex, GLOSSARY_JS } from './plugins/math-glossary.mjs';
import { extractSearchDoc, buildSearchBundle, SEARCH_JS, SEARCH_CSS } from './plugins/site-search.mjs';

const SITE_DIR = fileURLToPath(new URL('.', import.meta.url));
const ROOT = path.resolve(SITE_DIR, '..');
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
  '课程/工程数学/作业/2026-09-17-作业1.md',
  '课程/工程数学/教材解析/index.md',
  '课程/工程数学/教材解析/0.0-符号入门.md',
  '课程/工程数学/教材解析/第一部分-线性代数/index.md',
  '课程/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.0-本章通关攻略.md',
  '课程/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.1-二阶与三阶行列式.md',
  '课程/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.2-n阶行列式.md',
  '课程/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.3-克莱姆法则.md',
  '课程/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.4-用MATLAB计算行列式.md',
  '课程/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.0-本章通关攻略.md',
  '课程/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.1-矩阵的概念及运算.md',
  '课程/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.2-逆矩阵.md',
  '课程/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.3-矩阵的初等变换与初等矩阵.md',
  '课程/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.4-矩阵的秩.md',
  '课程/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.5-用MATLAB进行矩阵运算.md',
  '课程/工程数学/课堂笔记/index.md',
  '课程/工程数学/课堂笔记/2026-09-17-determinants-order-2-3.md',
  '课程/工程数学/课堂笔记/2026-09-17-determinants-transcript-notes.md',
  '课程/工程数学/原始资料/index.md',
  '课程/工程数学/音频/index.md',
  '课程/大电网安全稳定智能分析与控制/index.md',
  '课程/大电网安全稳定智能分析与控制/作业/index.md',
  '课程/大电网安全稳定智能分析与控制/教材解析/index.md',
  '课程/大电网安全稳定智能分析与控制/课堂笔记/index.md',
  '课程/大电网安全稳定智能分析与控制/课堂笔记/2026-09-20-课程定位与考核要求.md',
  '课程/大电网安全稳定智能分析与控制/原始资料/index.md',
  '课程/大电网安全稳定智能分析与控制/音频/index.md',
  '课程/形势与政策/index.md',
  '课程/形势与政策/作业/index.md',
  '课程/形势与政策/课堂笔记/index.md',
  '课程/形势与政策/课堂笔记/2026-09-21-经济热点专题与考试安排.md',
  '课程/形势与政策/原始资料/index.md',
  '课程/形势与政策/音频/index.md',
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

// 折叠面板深链接的客户端增强，来自独立插件模块 disclosure-anchor.mjs。
// 可拆卸：删掉本段与页面模板里的 disclosure-anchor <script> 即回退
// （锚点仍可滚动定位，只是收起的面板要手动点开）。
const disclosureAnchorDist = path.join(DIST_DIR, 'assets', 'plugins', 'disclosure-anchor.js');
fs.mkdirSync(path.dirname(disclosureAnchorDist), { recursive: true });
fs.writeFileSync(disclosureAnchorDist, DISCLOSURE_ANCHOR_JS);

// 符号气泡词典：唯一来源是符号入门页里的 :::glossary-dict 围栏（内容侧维护，
// 改词条不碰代码）。实现见 站点/plugins/math-glossary.mjs（独立可拆卸模块：
// 删掉本段、Step 2.6 与页面模板里对应 <script> 即回退，令牌恢复成字面文本）。
const NOTATION_PAGE = '课程/工程数学/教材解析/0.0-符号入门.md';
const glossaryDict = fs.existsSync(path.join(ROOT, NOTATION_PAGE))
  ? parseGlossaryDict(fs.readFileSync(path.join(ROOT, NOTATION_PAGE), 'utf-8'))
  : {};
const mathGlossaryDist = path.join(DIST_DIR, 'assets', 'plugins', 'math-glossary.js');
fs.mkdirSync(path.dirname(mathGlossaryDist), { recursive: true });
fs.writeFileSync(mathGlossaryDist, GLOSSARY_JS);

// 全站搜索：构建期生成倒排索引，浏览器端零依赖。实现与设计理由见
// 站点/plugins/site-search.mjs（那里也记录了为什么弃用 Pagefind：它按单字索引中文，
// 「的」能命中 62/66 页）。
// 可拆卸：删掉本段、页面模板里的两行注入、以及最后的 buildSearchBundle 写盘即回退。
const searchPluginDir = path.join(DIST_DIR, 'assets', 'plugins');
fs.mkdirSync(searchPluginDir, { recursive: true });
fs.writeFileSync(path.join(searchPluginDir, 'site-search.js'), SEARCH_JS);
fs.writeFileSync(path.join(searchPluginDir, 'site-search.css'), SEARCH_CSS);

// 检索语料：渲染循环里逐页填，循环结束后统一建索引。
const searchDocs = [];

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
              { label: "符号入门", path: "课程/工程数学/教材解析/0.0-符号入门.md" },
              {
                label: "第一部分 线性代数",
                path: "课程/工程数学/教材解析/第一部分-线性代数/index.md",
                children: [
                  {
                    label: "第01章 行列式",
                    children: [
                      { label: "★ 通关攻略", path: "课程/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.0-本章通关攻略.md" },
                      { label: "1.1 二阶与三阶行列式", path: "课程/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.1-二阶与三阶行列式.md" },
                      { label: "1.2 n阶行列式", path: "课程/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.2-n阶行列式.md" },
                      { label: "1.3 克莱姆法则", path: "课程/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.3-克莱姆法则.md" },
                      { label: "1.4 用MATLAB计算行列式", path: "课程/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.4-用MATLAB计算行列式.md" }
                    ]
                  },
                  {
                    label: "第02章 矩阵",
                    children: [
                      { label: "★ 通关攻略", path: "课程/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.0-本章通关攻略.md" },
                      { label: "2.1 矩阵的概念及运算", path: "课程/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.1-矩阵的概念及运算.md" },
                      { label: "2.2 逆矩阵", path: "课程/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.2-逆矩阵.md" },
                      { label: "2.3 初等变换与初等矩阵", path: "课程/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.3-矩阵的初等变换与初等矩阵.md" },
                      { label: "2.4 矩阵的秩", path: "课程/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.4-矩阵的秩.md" },
                      { label: "2.5 用MATLAB进行矩阵运算", path: "课程/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.5-用MATLAB进行矩阵运算.md" }
                    ]
                  }
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
          {
            label: "作业",
            path: "课程/工程数学/作业/index.md",
            children: [
              { label: "作业1", path: "课程/工程数学/作业/2026-09-17-作业1.md" }
            ]
          },
          { label: "原始资料", path: "课程/工程数学/原始资料/index.md" },
          { label: "音频", path: "课程/工程数学/音频/index.md" }
        ]
      },
      {
        label: "大电网安全稳定智能分析与控制",
        path: "课程/大电网安全稳定智能分析与控制/index.md",
        children: [
          { label: "作业", path: "课程/大电网安全稳定智能分析与控制/作业/index.md" },
          { label: "教材解析", path: "课程/大电网安全稳定智能分析与控制/教材解析/index.md" },
          { label: "课堂笔记", path: "课程/大电网安全稳定智能分析与控制/课堂笔记/index.md",
            children: [
              { label: "09-20 开课第一讲", path: "课程/大电网安全稳定智能分析与控制/课堂笔记/2026-09-20-课程定位与考核要求.md" }
            ]
          },
          { label: "原始资料", path: "课程/大电网安全稳定智能分析与控制/原始资料/index.md" },
          { label: "音频", path: "课程/大电网安全稳定智能分析与控制/音频/index.md" }
        ]
      },
      {
        // 本课按 COURSE_SKIPPED_KINDS 声明豁免「教材解析」，故此处也不列该子节点
        // （与 .githooks/hook_lib.py 保持一致，别只改一边）。
        label: "形势与政策",
        path: "课程/形势与政策/index.md",
        children: [
          { label: "作业", path: "课程/形势与政策/作业/index.md" },
          { label: "课堂笔记", path: "课程/形势与政策/课堂笔记/index.md",
            children: [
              { label: "09-21 经济热点专题与考试安排", path: "课程/形势与政策/课堂笔记/2026-09-21-经济热点专题与考试安排.md" }
            ]
          },
          { label: "原始资料", path: "课程/形势与政策/原始资料/index.md" },
          { label: "音频", path: "课程/形势与政策/音频/index.md" }
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
  "课程/工程数学/教材解析/0.0-符号入门.md",
  "课程/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.0-本章通关攻略.md",
  "课程/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.1-二阶与三阶行列式.md",
  "课程/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.2-n阶行列式.md",
  "课程/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.3-克莱姆法则.md",
  "课程/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.4-用MATLAB计算行列式.md",
  "课程/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.0-本章通关攻略.md",
  "课程/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.1-矩阵的概念及运算.md",
  "课程/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.2-逆矩阵.md",
  "课程/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.3-矩阵的初等变换与初等矩阵.md",
  "课程/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.4-矩阵的秩.md",
  "课程/工程数学/教材解析/第一部分-线性代数/第2章-矩阵/2.5-用MATLAB进行矩阵运算.md"
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
  const clean = forId.replace(/<[^>]+>/g, '');
  let id = clean
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
  return `<h${depth} id="${id}">${inner}</h${depth}>`;
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
  // 同步清空标题锚点用的中转表（下标与 mathBlocks 完全同构）
  mathPlainOf.length = 0;
  usedHeadingIds.clear();

  // 2.1 Display Math $$...$$
  raw = raw.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
    const id = mathBlocks.length;
    totalFormulasRendered++;
    // 教材排版惯例把句末标点写进显示公式（$$….$$），在网页上独立成块后
    // 看着像渲染出了一个多余的点（用户实测反馈）。渲染前剥掉**收尾的一个**
    // 标点——只剥一个：万一公式真以省略号收尾不至于被整串误删。
    const safeTex = wrapBareCJK(glossifyTex(tex.trim().replace(/[.。，、；;][ \t]*$/, ''), glossaryDict));
    let rendered = '';
    try {
      rendered = katex.renderToString(safeTex, {
        displayMode: true,
        throwOnError: false,
        trust: true,
        strict: false
      });
    } catch (e) {
      formulaErrors++;
      rendered = `<span class="katex-error">${e.message}</span>`;
    }
    const plain = mathPlain(safeTex);
    mathBlocks.push({ display: true, html: rendered, plain });
    mathPlainOf[id] = plain;
    return `@@MATH_BLOCK_${id}@@`;
  });

  // 2.2 Inline Math $...$
  raw = raw.replace(/(?<!\$)\$(?!\$)((?:[^$\\\r\n]|\\.)+?)\$(?!\$)/g, (_, tex) => {
    const id = mathBlocks.length;
    totalFormulasRendered++;
    const safeTex = wrapBareCJK(glossifyTex(tex.trim(), glossaryDict));
    let rendered = '';
    try {
      rendered = katex.renderToString(safeTex, {
        displayMode: false,
        throwOnError: false,
        trust: true,
        strict: false
      });
    } catch (e) {
      formulaErrors++;
      rendered = `<span class="katex-error">${e.message}</span>`;
    }
    const plain = mathPlain(safeTex);
    mathBlocks.push({ display: false, html: rendered, plain });
    mathPlainOf[id] = plain;
    return `@@MATH_INLINE_${id}@@`;
  });

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
  const notationHref = encodeURI(
    path.relative(path.dirname(fullPath), path.join(ROOT, NOTATION_PAGE))
      .replace(/\\/g, '/').replace(/\.md$/, '.html')
  );
  raw = renderGlossary(raw, {
    dict: glossaryDict,
    renderTex: (tex) => {
      try {
        return katex.renderToString(wrapBareCJK(glossifyTex(tex, glossaryDict)), {
          displayMode: false,
          throwOnError: false,
          trust: true,
          strict: false,
        strict: false
        });
      } catch (e) {
        return `<span class="katex-error">${e.message}</span>`;
      }
    },
    notationHref,
  });
  // 气泡词典按页烘焙成 JSON（词条的 href 已是当页可用的相对链接），
  // 客户端模块从 #sym-glossary-json 读，不发任何请求。
  const glossaryJsonPayload = {
    terms: Object.fromEntries(
      Object.entries(glossaryDict).map(([id, e]) => [id, { title: e.title, text: e.text, href: notationHref }])
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
  let htmlContent = marked.parse(raw);
  htmlContent = htmlContent
    .replace(/<table>/g, '<div class="table-scroll-container"><table>')
    .replace(/<\/table>/g, '</table></div>');

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
    toc.push({
      level: parseInt(hMatch[1]),
      id: hMatch[2],
      title: hMatch[3].replace(/<[^>]+>/g, '').trim()
    });
  }

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

  // Helper to check if node or any descendant is active
  function isNodeOrDescendantActive(node, targetPath) {
    if (node.path === targetPath) return true;
    if (node.children) {
      return node.children.some(child => isNodeOrDescendantActive(child, targetPath));
    }
    return false;
  }

  // Render Sidebar Tree HTML with Collapsible Groups
  function renderNav(nodes, depth = 0) {
    let out = '<ul class="drawer-nav-list">';
    for (const node of nodes) {
      const hasChildren = node.children && node.children.length > 0;
      const isActive = node.path === relPath;
      const isDescendantActive = isNodeOrDescendantActive(node, relPath);

      // Default expanded if active, or any descendant is active, or top-level "课程总览"
      const isExpanded = isDescendantActive || (depth === 0 && node.label === "课程总览");

      if (hasChildren) {
        const itemMeta = node.path ? pageMetaMap.get(node.path) : null;
        const itemHref = node.path ? `${rootRel}${itemMeta ? itemMeta.htmlRelPath : node.path}` : '';

        out += `<li class="drawer-nav-group ${isExpanded ? 'expanded' : 'collapsed'}">
          <div class="nav-group-header ${!node.path ? 'nav-header-clickable' : ''}">
            ${node.path ? `
              <a href="${itemHref}" class="drawer-nav-link ${isActive ? 'active' : ''}">
                <span>${node.label}</span>
              </a>
            ` : `
              <span class="drawer-section-title-text">${node.label}</span>
            `}
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
        if (node.path) {
          const itemMeta = pageMetaMap.get(node.path);
          const itemHref = `${rootRel}${itemMeta ? itemMeta.htmlRelPath : node.path}`;
          out += `<li class="drawer-nav-item ${isActive ? 'active' : ''}">
            <a href="${itemHref}" class="drawer-nav-link">
              <span>${node.label}</span>
            </a>
          </li>`;
        } else {
          out += `<li class="drawer-section-title">${node.label}</li>`;
        }
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
      pagingHtml += `<a class="paging-card paging-prev" href="${rootRel}${prevPage.htmlRelPath}">
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
      pagingHtml += `<a class="paging-card paging-next" href="${rootRel}${nextPage.htmlRelPath}">
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
<html lang="zh-CN" data-depth="${rootRel === './' ? 0 : rootRel.split('../').length - 1}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${pageMeta.title} | S26-1 课程知识库 - isui.ren</title>
  <link rel="stylesheet" href="${rootRel}assets/katex/katex.min.css">
  <link rel="stylesheet" href="${rootRel}assets/theme/shirone-reader.css">
  <link rel="stylesheet" href="${rootRel}assets/plugins/site-search.css">
</head>
<body>
  <div class="drawer-backdrop" id="drawer-backdrop"></div>

  <div class="site-shell">
    <!-- Left Column: Full-Height Sidebar (整列导航栏) -->
    <aside class="m3-drawer" id="m3-drawer">
      <div class="drawer-header-brand">
        <a href="${rootRel}index.html" class="sidebar-brand">
          <span class="site-title-icon">📚</span>
          <span class="sidebar-brand-text">S26-1 课程知识库</span>
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
          <a href="${rootRel}index.html" class="top-bar-mobile-title">
            <span>S26-1 课程知识库</span>
          </a>
          <nav class="top-bar-breadcrumbs" aria-label="当前路径">
            ${breadcrumbs.map((b, i) => i === breadcrumbs.length - 1 ? `<span class="current-crumb">${b.label}</span>` : `<a href="${b.href}">${b.label}</a><span class="m3-breadcrumb-sep">/</span>`).join('')}
          </nav>
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

          <button class="m3-icon-btn" id="search-toggle" aria-label="全站搜索" title="全站搜索">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
          </button>

          <button class="m3-icon-btn" id="theme-toggle" aria-label="切换昼夜主题">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
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
              ${breadcrumbs.map((b, i) => i === breadcrumbs.length - 1 ? `<span>${b.label}</span>` : `<a href="${b.href}">${b.label}</a><span class="m3-breadcrumb-sep">/</span>`).join('')}
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
                教材《工程数学基础》的题目原文与章节结构版权归原书作者与出版社所有，本站解析为个人学习笔记；
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

  <script src="${rootRel}assets/katex/katex.min.js"></script>
  <script src="${rootRel}assets/theme/shirone-reader.js"></script>
  <script src="${rootRel}assets/plugins/disclosure-anchor.js" defer></script>
  <script type="application/json" id="sym-glossary-json">${JSON.stringify(glossaryJsonPayload).replace(/<\//g, '<\\/')}</script>
  <script src="${rootRel}assets/plugins/math-glossary.js" defer></script>
  <script src="${rootRel}assets/plugins/site-search.js" defer></script>
</body>
</html>`;

  const outFilePath = path.join(DIST_DIR, targetHtmlPath);
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
  const encodedTargetHtmlPath = targetHtmlPath.split('/').map(seg => encodeURIComponent(seg)).join('/');
  if (encodedTargetHtmlPath !== targetHtmlPath) {
    const encodedOutFilePath = path.join(DIST_DIR, encodedTargetHtmlPath);
    fs.mkdirSync(path.dirname(encodedOutFilePath), { recursive: true });
    fs.writeFileSync(encodedOutFilePath, finalHtml, 'utf-8');
    console.log(`[build] Generated encoded alias: ${encodedTargetHtmlPath}`);
  }
}

console.log(`[build] Completed! Rendered ${totalFormulasRendered} math formulas with ${formulaErrors} errors.`);

// 全站搜索索引：等所有页面都渲染完再建（每页正文在渲染循环里已经收进 searchDocs）。
// 产物落在 dist/search/：index.json（页面清单 + 小节锚点）、g/<n>.json（二元组倒排分桶）、
// t/<id>.json（单页正文，供摘要按需拉取）。
{
  const { files, stats } = buildSearchBundle(searchDocs);
  for (const [relPath, content] of Object.entries(files)) {
    const filePath = path.join(DIST_DIR, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }
  const bytes = Object.values(files).reduce((sum, content) => sum + Buffer.byteLength(content, 'utf-8'), 0);
  console.log(`[search] Indexed ${stats.pages} pages → ${stats.buckets} buckets, `
    + `${stats.grams} grams / ${stats.positions} positions, ${(bytes / 1024 / 1024).toFixed(2)} MB raw`);
}
