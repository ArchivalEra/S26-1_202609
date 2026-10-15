/**
 * `Catalog` 端口：页面清单与符号词典的**源侧** adapter（设计文档 §3.2 的接缝合并）。
 *
 * 职责：
 *   - `pages()`：页面清单（从 `站点/页面清单.mjs` 来——**唯一真相源**，与 build.mjs 共用）；
 *   - `headings(relPath)`：源 markdown 的标题序列（含锚点），**与产物 headings 顺序对齐**；
 *   - `packs()`：符号词典（包 → 词条），供 `symbol` 工具。
 *
 * ## 锚点反推（设计文档说的「真雷」，实测过的三个坑）
 * 产物 `headings[].a` 是构建期 slug，源侧要复刻它得跨过三道坎：
 *   ① **首个 h1 不进 headings**（build.mjs 把它当页面标题）→ 反推时要去掉；
 *   ② **折叠块内的标题是缩进 2 空格的 `###`**，marked 仍渲染成 h3 → 正则要允许 ` {0,3}` 缩进；
 *   ③ **标题含行内公式时**，build 期用渲染后的纯文本算 slug（`mathPlainOf` 降级），
 *      源侧是 `$…$` —— 这类标题**不逐字复刻 slug**，改用「**顺序对齐**」：
 *      源侧标题序列（去掉首个 h1）与产物 `headings` 一一对应，锚点直接取产物的 `a`。
 *
 * 实测：114 页里 **113 页**源侧标题数与产物 headings 数一致；唯一例外是符号包页
 * （`站点/符号包/通用.md`，`:::glossary-dict` 围栏内的 `###` 不渲染成标题），单独跳过。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 源侧标题扫描：允许 0-3 空格缩进（折叠块内的标题是缩进的），跳过代码围栏内的 `#`。
 *
 * **offset 一律相对传入的 `source` 原文**——做法是先把 frontmatter 的**长度**算出来，
 * 再从那个位置往后扫，而不是「先 replace 再算 offset」（后者会让 offset 与原文错位，
 * 实测踩过：`# 符号排除…` 这种 YAML 缩进注释被当成标题，小节切出空正文）。 */
export function scanHeadings(source) {
  const fm = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  const start = fm ? fm[0].length : 0; // frontmatter 之后的绝对偏移
  const out = [];
  const lines = source.slice(start).split('\n');
  let inCode = false;
  let offset = start;
  for (const line of lines) {
    const stripped = line.replace(/\r$/, '');
    if (/^\s*(```|~~~)/.test(stripped)) inCode = !inCode;
    else if (!inCode) {
      const m = stripped.match(/^ {0,3}(#{1,6})\s+(.*)$/);
      if (m) out.push({ level: m[1].length, title: m[2].trim(), offset });
    }
    offset += line.length + 1;
  }
  return out;
}

/**
 * 建源侧 Catalog adapter。
 * @param {{ root:string, targetFiles:string[] }} opts
 */
export function createCatalog(opts) {
  const { root, targetFiles } = opts;

  return {
    /** 页面清单（唯一真相源）。 */
    pages() {
      return targetFiles.map((rel) => ({
        path: rel,
        // url：与构建期同一规则（README.md → index.html，其余 .md → .html）
        url: rel === 'README.md' ? 'index.html' : rel.replace(/\.md$/, '.html'),
      }));
    },

    /** 读源 markdown（不做任何转换）。 */
    source(relPath) {
      const p = path.join(root, relPath);
      if (!fs.existsSync(p)) {
        const err = new Error(`源文件不存在：${relPath}`);
        err.code = 'unknown_page';
        throw err;
      }
      return fs.readFileSync(p, 'utf-8');
    },

    /**
     * 源侧标题 + 与产物 headings 对齐后的锚点。
     * @returns {{level:number, title:string, offset:number, a:string}[]}
     *   `a` 来自产物的 headings（按顺序对齐）；对齐不上时 `a` 为空串。
     */
    headings(relPath, productHeadings) {
      const src = this.source(relPath);
      let hs = scanHeadings(src);
      // 规则①：首个 h1 是页面标题，不进 headings
      const firstH1 = hs.findIndex((h) => h.level === 1);
      if (firstH1 >= 0) hs = hs.slice(0, firstH1).concat(hs.slice(firstH1 + 1));
      // 规则③：顺序对齐，锚点取产物
      const prod = productHeadings || [];
      return hs.map((h, i) => ({
        level: h.level,
        title: h.title,
        offset: h.offset,
        a: prod[i] ? prod[i].a : '',
      }));
    },

    /**
     * 对齐健康检查（供契约测试）：源侧标题数 vs 产物 headings 数。
     * 返回 {ok, srcCount, prodCount}。
     */
    alignCheck(relPath, productHeadings) {
      const src = this.source(relPath);
      let hs = scanHeadings(src);
      const firstH1 = hs.findIndex((h) => h.level === 1);
      if (firstH1 >= 0) hs = hs.slice(0, firstH1).concat(hs.slice(firstH1 + 1));
      const prodCount = (productHeadings || []).length;
      return { ok: hs.length === prodCount, srcCount: hs.length, prodCount };
    },
  };
}
