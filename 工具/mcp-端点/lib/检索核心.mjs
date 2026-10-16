/**
 * 检索核心：**与浏览器端共用同一套纯函数**，把「查询 → 命中列表」这件事做一遍。
 *
 * 为什么单独一个模块：MCP 读层的 `SearchCorpus` adapter 与站内搜索面板必须给出
 * **逐项一致**的命中顺序（否则用户会遇到「网页搜得到、AI 搜不到」这类最难查的分叉）。
 * 所以这里的每一行都直接 import 自 `站点/plugins/site-search.mjs`——**不重写、不复制**。
 *
 * 坐标纪律：本模块只在**折叠文本坐标系**里工作（`foldSearchText` 之后的位置）。
 * 折叠文本已剥 KaTeX、已 NFKC/小写折叠，其偏移**不等于**源 markdown 偏移；
 * 这里的 `firstPos` 只许交给 `sectionForPosition` 用来定位小节，**不许**当源偏移用。
 */

import {
  foldSearchText,
  queryGrams,
  hashGram,
  verifyPhrase,
  sectionForPosition,
  countOccurrences,
  makeSnippet,
  scoreSearchHit,
} from '../../../站点/plugins/site-search.mjs';

/**
 * 复现浏览器端 `collectHits` 的候选→命中逻辑（见 `site-search.mjs` 的 SEARCH_JS）。
 * 差别只有一处：浏览器端从已 fetch 的桶里取 postings，这里从注入的 `getBucket` 取。
 *
 * @param {object} data          index.json 的内容（{v,buckets,pages,docs,sourceHash?}）
 * @param {(n:number)=>object} getBucket  按桶号取 {grams,uni}
 * @param {string} rawQuery      用户原始查询串
 * @returns {{query:string, hits:object[], grams:object}}
 */
export function collectHits(data, getBucket, rawQuery) {
  const query = foldSearchText(rawQuery);
  if (!query) return { query: '', hits: [], grams: { bigrams: [], unigrams: [] } };

  const grams = queryGrams(query);
  const bucketOf = (gram) => getBucket(hashGram(gram) % data.buckets);
  const postingsFor = (gram) => {
    const bucket = bucketOf(gram);
    return bucket && bucket.grams ? bucket.grams[gram] : undefined;
  };
  const unigramDocsFor = (ch) => {
    const bucket = bucketOf(ch);
    return bucket && bucket.uni ? bucket.uni[ch] : undefined;
  };

  const hits = [];
  for (const doc of data.docs) {
    const positions = [];
    let total = 0;
    let firstPos = -1;
    let matchedByBody = false;

    if (grams.bigrams.length) {
      const perGram = grams.bigrams.map(postingsFor);
      // 有 gram 缺口 ⇒ 该文档不可能有连续命中；但标题/小标题仍可能命中，交给下面判断。
      if (!perGram.some((postings) => !postings || !postings[doc.id])) {
        const found = verifyPhrase(perGram.map((postings) => postings[doc.id]));
        if (found.length) {
          matchedByBody = true;
          total = found.length;
          firstPos = found[0];
          for (const p of found) positions.push(p);
        }
      }
    } else if (grams.unigrams.length) {
      const lists = grams.unigrams.map(unigramDocsFor);
      if (!lists.some((list) => !list || list.indexOf(doc.id) < 0)) {
        matchedByBody = true;
        total = 0; // 单字查询不数次数，拉正文后再算
      }
    }

    const foldedTitle = foldSearchText(doc.title || '');
    const titleHit = foldedTitle.indexOf(query) >= 0;
    const headingHits = [];
    for (const heading of doc.headings || []) {
      if (heading.t && heading.t.indexOf(query) >= 0) headingHits.push(heading);
    }
    if (!matchedByBody && !titleHit && !headingHits.length) continue;

    const section = firstPos >= 0
      ? sectionForPosition(doc.headings, firstPos)
      : (headingHits[0] || null);

    hits.push({
      id: doc.id,
      url: doc.url,
      title: doc.title,
      chars: doc.chars,
      positions,
      total,
      firstPos,
      titleHit,
      titleExact: foldedTitle === query,
      headingHits: headingHits.length,
      headingHitText: headingHits.length ? (headingHits[0].d || headingHits[0].t) : '',
      anchor: section ? section.a : '',
      sectionText: section ? (section.d || section.t) : '',
      snippet: '',
      score: 0,
    });
  }

  for (const hit of hits) hit.score = scoreSearchHit(hit);
  // 排序与浏览器端逐字一致：分数降序、**url 破平**（共用模块已有，读层不额外加规则）。
  hits.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  return { query, hits, grams };
}

/** 单字查询的命中次数：拉正文后才算（与浏览器端同）。 */
export function fillSingleCharCounts(hits, grams, getText) {
  if (grams.bigrams.length || !grams.unigrams.length) return hits;
  const needles = grams.unigrams;
  return hits.map((hit) => {
    const text = getText(hit.id);
    if (!text) return hit;
    let total = 0;
    for (const ch of needles) total += countOccurrences(text, ch);
    return { ...hit, total };
  });
}

/**
 * 给命中补摘要（`snippet`）——**与浏览器端逐字同一套逻辑**
 * （`site-search.mjs` 的 `runSearch`：`makeSnippet(text, query, { radius: 44 })`，
 *   短语搜不到时退化为「命中位置附近开窗」，都没有就只数次数）。
 *
 * 2026-10-16 候选 6：从前读层的 `snippet` 恒为 `''`（字段白带、`makeSnippet` 只是死转发）。
 * 那不是「该删的字段」而是「缺的实现」——浏览器端有现成的，搬过来即可。
 *
 * @param {object[]} hits  `collectHits` 的产物
 * @param {string} query   已折叠的查询串
 * @param {(id:number)=>string} getText 取某页折叠正文
 * @param {number} [limit] 只给前 N 条补（浏览器端也是「只给前 8 条拉正文」，避免全量读盘）
 */
export function fillSnippets(hits, query, getText, limit = 8) {
  return hits.map((hit, i) => {
    if (i >= limit || !query) return hit;
    const text = getText(hit.id);
    if (!text) return hit;
    const snippet = makeSnippet(text, query, { radius: 44 });
    if (snippet.html) return { ...hit, snippet: snippet.html, total: snippet.total };
    if (hit.positions && hit.positions.length) {
      const around = makeSnippet(text, text.slice(hit.positions[0], hit.positions[0] + query.length) || query, { radius: 44 });
      return { ...hit, snippet: around.html || '' };
    }
    return { ...hit, total: countOccurrences(text, query) };
  });
}

export { makeSnippet, sectionForPosition, foldSearchText };
