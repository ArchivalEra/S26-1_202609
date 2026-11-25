/**
 * 符号系统全局契约常量与唯一锚点构造器（全站唯一真相源）。
 *
 * 所有前端 CSS/JS、图元 SVG、公式后处理、正文取词、WebMCP 与测试
 * 共用这里的形状选择器与 `<a class="sym-gloss">` 生成契约——不再各处手拼或硬编码。
 */

/** 运行时/CSS 可识别的符号元素选择器列表（正文/图元链接 + KaTeX 公式内部锚点）。 */
export const SYMBOL_SELECTORS = [
  'a.sym-gloss',
  '.katex [data-term]',
];

/** 完整 CSS/DOM 选择器字符串。 */
export const SYMBOL_SELECTOR = SYMBOL_SELECTORS.join(', ');

/** 浏览器端气泡运行时产物相对路径（由 build.mjs 写出）。 */
export const SYMBOL_RUNTIME_ASSET = 'assets/plugins/symbols-bubble.js';

/** 每页烘焙的符号词典 `<script type="application/json">` 元素 id。 */
export const SYMBOL_JSON_SCRIPT_ID = 'sym-glossary-json';

export function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 剥除 TeX 分隔与花括号/反斜杠，生成纯文本气泡标题与摘要。 */
export function plainBubbleText(s) {
  return String(s == null ? '' : s)
    .replace(/\$([^$\n]+)\$/g, (_, tex) => tex.replace(/\\/g, '').replace(/[{}]/g, ''));
}

/**
 * 唯一 `<a class="sym-gloss">` 锚点构造器：正文、公式（decorateAnchors）、图元（SVG `<tspan>`）共用。
 *
 * @param {{ key: string, href: string, label?: string, innerHtml: string }} spec
 * @returns {string}
 */
export function formatSymbolAnchor({ key, href, label, innerHtml }) {
  const aria = label || key;
  return (
    `<a class="sym-gloss" data-term="${escHtml(key)}" href="${escHtml(href)}"` +
    ` aria-label="${escHtml(aria)}">${innerHtml}</a>`
  );
}
