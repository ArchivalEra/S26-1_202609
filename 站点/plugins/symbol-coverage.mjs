/**
 * 符号覆盖统计 —— 「哪些符号冒了泡、哪些该冒没冒」的**唯一量法**。
 *
 * ## 为什么要单独成模块（2026-11-05 站长定案）
 *
 * 站长原话：「其他页仍然有无法冒泡的符号，并且我们无法统计，这是个顽疾，
 * 我希望构建期能跟公式一样直接 CI 来测试每个是否能冒泡并且能统计。」
 *
 * 「无法统计」的根因是两处静默丢弃，都在 `build.mjs`：
 *
 *   ① `glossaryWarn` 在**页面循环之前**（旧 203 行）就打印了。逐页产生的
 *      「令牌原样保留」「符号包未注册」「符号排除指向没有的词条」全部在循环里
 *      `add` 进 Set，却永远轮不到打印 —— 构建日志里一条都看不见。
 *   ② `term-href-missing`（公式里认出了符号，却找不到链接目标）是 `warn`，
 *      而构建只数 `severity === 'error'`，于是又一批漏网。
 *
 * 结果：页面上 `[tex]{#id}` 字面留在正文、点不动，构建 0 错误、全部闸门绿。
 *
 * 本模块把「漏」变成**数据**：`measurePage()` 是纯函数，构建与测试共用同一把尺；
 * 构建把逐页结果写成 `dist/symbol-coverage.json`，FACTS 的两条数直接读它。
 * 数字只生产一次，别处不许再判「谁该是符号」。
 *
 * ## 口径：认**作者已经写明意图**的信号，不猜裸字母
 *
 *   - 公式内符号：`math/` 引擎在 IR 树上判定（唯一判定点）；`decorateAnchors`
 *     包不成的（裸 `<span data-term>` / `term-href-missing`）是漏；
 *   - 正文令牌 `[tex]{#id}`：`renderGlossary` 解析不了就留字面，产物里直接扫得到。
 *
 * 计划里原本写「按页环境比对公式 TeX 里出现的形状」，落地改成读**渲染判定的
 * 产物**：重跑一遍形状匹配会与 `bindTerms` 漂移（排除、遮蔽、纯包装组都会误报），
 * 而判定产物是唯一真相。正文「强调色 == 冒泡」仍由 `symbol-parity.test.mjs` 管。
 */

/**
 * 量一页**最终产物 HTML**。
 *
 * 先把 `<script>` 与 `<code>` 挖掉再量正文：
 *   · `sym-glossary-json` 里的气泡文本会**故意**保留 `[tex]{#id}` 写法说明；
 *   · 符号入门页用 `<code>` 教人写令牌，那是给人看的示例。
 * 两者都不是「该冒泡却没冒」，不排除就会假报。
 *
 * @param {string} html 页面产物（含 `sym-glossary-json` 与正文）
 * @returns {{
 *   anchors: number,          本页 a.sym-gloss 锚点个数（真冒泡数）
 *   distinct: string[],       去重后的 data-term 键
 *   baked: string[],          sym-glossary-json 里的词条键
 *   literalTokens: string[],  正文里字面残留的 [tex]{#id} 令牌（没被解析＝冒不了泡）
 *   bareSpans: string[],      裸 <span data-term>（decorateAnchors 没包成链接＝冒不了泡）
 * }}
 */
export function measurePage(html) {
  const src = String(html);

  // 当页环境：气泡词典按页烘焙，客户端与测试都读这一份。
  const baked = new Set();
  const tag = /<script[^>]*id="sym-glossary-json"[^>]*>([\s\S]*?)<\/script>/.exec(src);
  if (tag) {
    try {
      for (const k of Object.keys(JSON.parse(tag[1]).terms || {})) baked.add(k);
    } catch { /* 坏 JSON 由 glossary-bubble.test.mjs 报，这里不猜 */ }
  }

  const prose = src
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace(/<code\b[^>]*>[\s\S]*?<\/code>/g, '');

  // 锚点：产物里真实的 `<a class="sym-gloss" data-term="…">`。
  const distinct = new Set();
  const anchorRe = /class="sym-gloss"[^>]*data-term="([^"]+)"/g;
  let m;
  let anchors = 0;
  while ((m = anchorRe.exec(prose)) !== null) {
    distinct.add(m[1]);
    anchors += 1;
  }

  // 裸 span：`decorateAnchors` 成功时 `<span data-term>` 会被换成 `<a>`，
  // 所以产物里**任何** `<span data-term>` 都意味着「认出了符号、却没包成链接」。
  const bareSpans = [];
  const spanRe = /<span\b[^>]*\bdata-term="([^"]*)"[^>]*>/g;
  while ((m = spanRe.exec(prose)) !== null) bareSpans.push(m[1]);

  // 字面残留令牌：renderGlossary 解析不了就原样留在正文，读者点不动。
  const literalTokens = [];
  const tokRe = /\[([^\]\n]{1,80})\]\{#([^\]\n{}]{1,60})\}/g;
  while ((m = tokRe.exec(prose)) !== null) literalTokens.push(`[${m[1]}]{#${m[2]}}`);

  return { anchors, distinct: [...distinct], baked: [...baked], literalTokens, bareSpans };
}

/**
 * 把一页的构建期诊断合成「未冒泡」条目。**去重**：一个坏令牌会同时触发
 * `glossaryWarn` 与产物里的字面残留，只算一次（按页面 + 词条 id）。
 *
 * @param {{relPath: string, pageWarns?: string[], missingHrefs?: string[],
 *          literalTokens?: string[], bareSpans?: string[]}} p
 * @returns {{page: string, kind: string, detail: string}[]}
 */
export function diagnosePage({ relPath, pageWarns = [], missingHrefs = [], literalTokens = [], bareSpans = [] }) {
  const out = [];
  const seen = new Set();
  const push = (kind, detail, dedup = null) => {
    const k = dedup ? `${relPath}:${dedup}` : null;
    if (k && seen.has(k)) return;
    if (k) seen.add(k);
    out.push({ page: relPath, kind, detail });
  };

  // ① 公式内符号：判定成功却找不到链接目标（render() 已升为 error）。
  for (const k of missingHrefs) push('term-href-missing', `词条 ${k} 找不到链接目标`, `href:${k}`);
  // ② 公式内符号：渲染成裸 span，没包成可点锚点。
  for (const k of bareSpans) push('bare-term-span', `词条 ${k} 是裸 span，没包成可点锚点`, `span:${k}`);
  // ③ 正文字面残留令牌：最直观的「冒不了泡」，按词条 id 去重。
  for (const t of literalTokens) {
    const id = /\{#(?:[^:{}]+:)?([A-Za-z_][A-Za-z0-9_-]*)\}/.exec(t)?.[1] || t;
    push('literal-token', `未解析令牌 ${t}`, `token:${id}`);
  }
  // ④ 其余逐页警告：坏令牌那条与 ③ 重复（同样按词条 id 去重），别的结构问题照记。
  for (const w of pageWarns) {
    const tokMiss = /没有词条\s+([A-Za-z_][A-Za-z0-9_-]*)[，,]\s*令牌原样保留/.exec(w);
    push('glossary-warn', w, tokMiss ? `token:${tokMiss[1]}` : null);
  }

  return out;
}
