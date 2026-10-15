/**
 * `ReadCore`：读层的**深核心**（设计文档 §3.2）。
 *
 * 四个工具（`ask` / `search` / `read_page` / `symbol`）与 `stat` 的行为都在这里，
 * 背后是检索栈 + 切块 + 符号词典。**核心零 `fs`、零 JSON-RPC**——磁盘只活在 adapter 里，
 * 传输只活在 Endpoint 里。这样核心可以用内存夹具全量测，且换传输不改核心。
 *
 * 坐标纪律（设计文档 §3.3 不变量 3）：命中位置在**折叠文本坐标系**里，
 * 只用来定位小节；小节内选段一律交给 `planExcerpt` 在**源 markdown** 上按块切。
 */

import { collectHits, fillSingleCharCounts } from './检索核心.mjs';
import { buildCutIndex, planExcerpt, planExcerptRange } from './切块.mjs';
import { foldSearchText, queryGrams } from '../../../站点/plugins/site-search.mjs';

const DEFAULT_BUDGET = 4000;
const HARD_CAP = 20000;

/**
 * @param {{
 *   corpus: object,     // SearchCorpus 端口（manifest/bucket/text/staleness）
 *   catalog: object,    // Catalog 端口（pages/source/headings）
 *   packs: object,      // SymbolPacks 端口（lookup/chainOf）
 * }} deps
 */
export function createReadCore(deps) {
  const { corpus, catalog, packs } = deps;
  const cutCache = new Map(); // relPath → buildCutIndex 结果

  /** url → 源路径（与构建期规则互逆）。 */
  function pathOfUrl(url) {
    if (!url) return null;
    const u = decodeURIComponent(url);
    return u === 'index.html' ? 'README.md' : u.replace(/\.html$/, '.md');
  }

  function cutIndexOf(relPath) {
    if (cutCache.has(relPath)) return cutCache.get(relPath);
    const src = catalog.source(relPath);
    const idx = buildCutIndex(src);
    cutCache.set(relPath, { src, idx });
    return cutCache.get(relPath);
  }

  /** 取某页的源侧标题（带锚点，顺序对齐产物 headings）。 */
  function headingsOf(relPath, productHeadings) {
    return catalog.headings(relPath, productHeadings);
  }

  return {
    /**
     * 主路径：搜 + 定位小节 + 取正文，一次返回。
     * @param {{query:string, course?:string, limit?:number, budget?:number}} input
     */
    ask(input) {
      const query = String(input.query || '');
      const limit = Math.min(Math.max(input.limit || 3, 1), 10);
      const budget = Math.min(Math.max(input.budget || DEFAULT_BUDGET, 256), HARD_CAP);
      const data = corpus.manifest();

      let { hits, grams } = collectHits(data, (n) => corpus.bucket(n), query);
      hits = fillSingleCharCounts(hits, grams, (id) => corpus.text(id));

      // 课程过滤（按 url 前缀 `课程/<课>/`）
      if (input.course) {
        const prefix = `课程/${input.course}/`;
        hits = hits.filter((h) => decodeURIComponent(h.url).startsWith(prefix));
      }

      const folded = foldSearchText(query);
      const qgrams = queryGrams(folded);
      const sections = [];
      for (const hit of hits.slice(0, limit)) {
        const relPath = pathOfUrl(hit.url);
        let excerpt = null;
        let secId = hit.anchor || '';
        try {
          const { src, idx } = cutIndexOf(relPath);
          const hs = headingsOf(relPath, (data.docs[hit.id] && data.docs[hit.id].headings) || []);
          if (!secId) secId = (hs[0] && hs[0].a) || '';
          if (secId) {
            let r = planExcerpt({ source: src, index: idx, sectionId: secId, headings: hs, grams: qgrams, budget });
            // 命中落在**父标题**上时（如「题号条目」），它到下一个标题之间可能只有标题行本身，
            // 切出的正文极短——而真正含内容的是它的**子节**。此时把窗口扩到子节范围。
            if (r.ok && r.text.length < Math.min(200, budget)) {
              const i = hs.findIndex((h) => h.a === secId);
              if (i >= 0) {
                const parentLevel = hs[i].level;
                let j = i + 1;
                while (j < hs.length && hs[j].level > parentLevel) j++;
                if (j > i + 1) {
                  // 用「本父节 + 其全部子节」的范围重切
                  const wider = planExcerptRange(src, idx, hs[i].offset, j < hs.length ? hs[j].offset : src.length, qgrams, budget);
                  if (wider && wider.length > r.text.length) r = { ...r, text: wider, truncated: true };
                }
              }
            }
            excerpt = r;
          }
        } catch (e) {
          if (e.code !== 'unknown_page') throw e;
        }
        // truncated ⇒ 必须给续读 ref（用实际取到的小节 id，不是可能为空的 hit.anchor）
        const truncated = excerpt ? excerpt.truncated : false;
        sections.push({
          course: courseOf(hit.url),
          pageTitle: hit.title,
          sectionTitle: hit.sectionText,
          anchor: secId,
          url: hit.url,
          source: relPath,
          markdown: excerpt ? excerpt.text : '',
          snippet: hit.snippet || '',
          score: hit.score,
          truncated,
          oversize: excerpt ? excerpt.oversize : false,
          insideCollapse: excerpt ? excerpt.insideCollapse : false,
          ref: truncated && secId ? { path: relPath, anchor: secId } : null,
        });
      }

      // 顺带查符号（只在查询命中词典术语时返回）
      let symbols = [];
      if (input.course || true) {
        const found = packs.lookup({ q: query, course: input.course });
        symbols = found.matches.slice(0, 5).map((m) => ({
          id: m.id, pack: m.pack, title: m.title, text: m.text, senses: m.senses,
        }));
      }

      return {
        query: folded,
        sections,
        symbols,
        truncated: sections.some((s) => s.truncated),
        index: { pages: data.pages, sourceHash: data.sourceHash || null },
        stale: stalenessFlag(),
      };
    },

    /** 只要命中列表（带锚点、摘要、分数）。 */
    search(input) {
      const query = String(input.query || '');
      const limit = Math.min(Math.max(input.limit || 20, 1), 200);
      const data = corpus.manifest();
      let { hits, grams } = collectHits(data, (n) => corpus.bucket(n), query);
      hits = fillSingleCharCounts(hits, grams, (id) => corpus.text(id));

      if (input.course) {
        const prefix = `课程/${input.course}/`;
        hits = hits.filter((h) => decodeURIComponent(h.url).startsWith(prefix));
      }
      if (input.category) {
        hits = hits.filter((h) => categoryOf(h.url) === input.category);
      }

      const total = hits.length;
      const page = hits.slice(0, limit).map((h) => ({
        id: h.id,
        url: h.url,
        title: h.title,
        anchor: h.anchor,
        section: h.sectionText,
        snippet: h.snippet,
        occurrences: h.total,
        score: h.score,
      }));
      return { query, total, hits: page, stale: stalenessFlag() };
    },

    /**
     * 取整页（正文来自**源 markdown**，保 LaTeX、保 frontmatter）。
     * @param {{path?:string, course?:string, category?:string, file?:string, anchor?:string}} ref
     */
    readPage(ref) {
      const relPath = resolveRef(ref);
      const src = catalog.source(relPath);
      const data = corpus.manifest();
      const doc = data.docs.find((d) => pathOfUrl(d.url) === relPath);
      const hs = headingsOf(relPath, doc ? doc.headings : []);
      const meta = parseFrontmatter(src);
      let body = src.replace(/^---\n[\s\S]*?\n---\n/, '');
      if (ref.anchor) {
        const i = hs.findIndex((h) => h.a === ref.anchor);
        if (i >= 0) {
          const start = hs[i].offset;
          const end = i + 1 < hs.length ? hs[i + 1].offset : src.length;
          body = src.slice(start, end);
        }
      }
      return {
        path: relPath,
        url: doc ? doc.url : relPath.replace(/\.md$/, '.html'),
        title: meta.name || (doc && doc.title) || relPath,
        course: meta.course || courseOf(doc ? doc.url : ''),
        category: meta.category || '',
        format: 'markdown',
        meta,
        headings: hs.map((h) => ({ t: h.title, d: h.title, a: h.a, l: h.level })),
        body,
        stale: stalenessFlag(),
      };
    },

    /** 查符号（含多义项、当前语境标记）。 */
    symbol(input) {
      return packs.lookup({ id: input.id, q: input.q, course: input.course });
    },

    /** 台账出口：页数、源 hash、stale、课程清单。 */
    stat() {
      const data = corpus.manifest();
      const st = corpus.staleness ? corpus.staleness() : { stale: false };
      return {
        pages: data.pages,
        buckets: data.buckets,
        sourceHash: data.sourceHash || null,
        stale: st.stale,
        builtHash: st.builtHash || null,
        currentHash: st.currentHash || null,
        courses: coursesOf(data.docs),
        glossaryPacks: packs.packNames ? packs.packNames() : [],
      };
    },
  };

  function stalenessFlag() {
    try { return corpus.staleness ? corpus.staleness().stale : false; } catch { return false; }
  }
}

// ---------------------------------------------------------------- 小工具

function courseOf(url) {
  const u = decodeURIComponent(url || '');
  const m = u.match(/^课程\/([^/]+)\//);
  return m ? m[1] : '';
}

function categoryOf(url) {
  const u = decodeURIComponent(url || '');
  const m = u.match(/^课程\/[^/]+\/([^/]+)\//);
  return m ? m[1] : '';
}

function coursesOf(docs) {
  const set = new Set();
  for (const d of docs) {
    const c = courseOf(d.url);
    if (c) set.add(c);
  }
  return [...set];
}

/** 极简 frontmatter 解析（只取标量字段；够本读层用）。 */
function parseFrontmatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w\u4e00-\u9fa5-]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[kv[1]] = v;
  }
  return out;
}

/** 解析 read_page 的 ref：完整路径 / (course,category,file) / 唯一文件名后缀。 */
function resolveRef(ref) {
  if (ref.path) return ref.path;
  const pages = arguments[1]; // 未用；保留签名兼容
  const parts = [];
  if (ref.course) parts.push('课程', ref.course);
  if (ref.category) parts.push(ref.category);
  if (ref.file) parts.push(ref.file);
  if (parts.length >= 3) return parts.join('/');
  const err = new Error('read_page 需要 path，或 (course, category, file) 三元组');
  err.code = 'ambiguous_ref';
  throw err;
}
