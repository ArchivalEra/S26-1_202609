import { marked } from 'marked';
import { createMarkedProvider } from './adapters/marked.mjs';
import { escHtml } from './symbols/contracts.mjs';

const defaultMarkdownProvider = createMarkedProvider(marked);

// 显式 table 注释优先，其余按估计宽度与单元格平均字数分级。
function tableModeOf(table) {
  const cols = table.header.length;
  let wMin = cols * 32;
  let charSum = 0;
  let cells = 0;
  const longest = new Array(cols).fill(0);
  const cellPlain = (cell) => cell.text.replace(/\s+/g, ' ').trim();
  table.header.forEach((cell, i) => { longest[i] = cellPlain(cell).length; });
  for (const row of table.rows) {
    row.forEach((cell, i) => {
      const text = cellPlain(cell);
      longest[i] = Math.max(longest[i], text.length);
      charSum += text.length;
      cells++;
    });
  }
  for (const length of longest) wMin += Math.min(length, 20) * 9;
  if (wMin <= 420) return 't-compact';
  const avg = cells ? charSum / cells : 0;
  return avg > 6 ? 't-cards' : 't-matrix';
}

const decodeEntities = (text) => text
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** 站点的标题锚点与响应式表格策略。provider 只交换普通文本和已渲染的 HTML。 */
export function createMarkdownRenderer(provider = defaultMarkdownProvider) {
  const usedHeadingIds = new Set();
  const heading = ({ depth, html: inner }) => {
    // 公式保持排版，锚点只用普通文字。显式 {#id} 优先，页内重复 id 依次加后缀。
    const forId = inner
      .replace(/@@MATH_INLINE_(\d+)@@/g, '')
      .replace(/@@MATH_BLOCK_(\d+)@@/g, '');
    let clean = decodeEntities(forId.replace(/<[^>]+>/g, ''));
    const explicit = /\{#([^}\s]+)\}\s*$/.exec(clean);
    const explicitId = explicit ? explicit[1] : null;
    if (explicitId) clean = clean.slice(0, explicit.index).trim();
    let id = explicitId || clean.toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
      .replace(/(?:^-+)|(?:-+$)/g, '') || ('h-' + Math.random().toString(36).substring(2, 7));
    if (usedHeadingIds.has(id)) {
      let n = 2;
      while (usedHeadingIds.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    usedHeadingIds.add(id);
    const shown = explicitId ? inner.replace(/\s*\{#([^}\s]+)\}\s*$/, '').trim() : inner;
    return `<h${depth} id="${id}">${shown}</h${depth}>`;
  };
  const table = (data) => {
    const mode = data.mode || tableModeOf(data);
    // data-label 用纯文本，公式占位符由构建管线在属性恢复阶段处理。
    const attrText = (text) => decodeEntities(String(text || '').replace(/<[^>]*>/g, ''))
      .replace(/\s+/g, ' ').trim();
    const headerText = data.header.map((cell) => attrText(cell.text));
    let body = '';
    for (const row of data.rows) {
      body += '<tr>' + row.map((cell, i) => `<td data-label="${escHtml(headerText[i] ?? '')}">${cell.html}</td>`).join('') + '</tr>\n';
    }
    const thead = '<thead><tr>' + data.header.map((cell, i) => {
      const align = data.align[i] ? ` align="${data.align[i]}"` : '';
      return `<th${align}>${cell.html}</th>`;
    }).join('') + '</tr></thead>\n';
    const label = (data.label || '数据表').replace(/"/g, '&quot;');
    return `<div class="table-scroll-container ${mode}" role="region" aria-label="${label}" tabindex="0">\n<table>\n${thead}${body}</table>\n</div>\n`;
  };
  return {
    render(source) {
      usedHeadingIds.clear();
      return provider.render(source, { heading, table });
    },
  };
}
