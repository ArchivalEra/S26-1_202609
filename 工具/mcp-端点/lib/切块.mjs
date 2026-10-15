/**
 * 切块：`ask` 在小节内切出一段「够读」正文的纯函数（设计文档 §7.5）。
 *
 * ## 为什么要有它
 * `ask` 的命中位置在**折叠文本坐标系**里（已剥 KaTeX、已 NFKC/小写折叠），
 * 它**不是**源 markdown 偏移——只能用来定位小节。小节内要选一段正文，必须**按块切**，
 * 否则会切断 `$$` 公式、``` 围栏、`:::collapse` 围栏，破坏「正文保公式」这条硬不变量。
 *
 * ## 核心不变量（一条等式钉死三类切坏）
 * **窗口两端切点的 `openStack` 逐元素相等** ⇒ `$$` / ``` / `:::` 全部成对，
 * 构建期生成的 `<details>` 无半对。这是本模块存在的全部理由。
 *
 * ## 两条实测硬约束（设计文档 §7.4，朴素写法会错）
 * ① **`$$` 分两种**：独占行的 `$$`（该行只有 `$$`）切换跨行公式态；行内闭合的
 *    `$$x=1$$` 不切换。全仓实测：很多页的行首 `$$` 行数是奇数（两种写法混用），
 *    一律按行首切换会把正常段落误判成「公式内」。
 * ② **围栏必须按嵌套深度扫描**：朴素「行首 `:::` 即开围栏」会把 `:::collapse` 内部的
 *    markdown 标题（`:::###`）与分隔线误当新围栏。
 */

/** 独占行的 `$$`：整行只有 $$ 与空白。 */
const BARE_DISPLAY_MATH = /^\s*\$\$\s*$/;
/** 行首 `:::` 开围栏：`:::collapse` / `:::glossary-dict {…}` / `:::glossary-match`。 */
const FENCE_OPEN = /^:::\s*([A-Za-z][\w-]*)/;
/** 闭围栏：整行只有 `:::`。 */
const FENCE_CLOSE = /^:::\s*$/;
/** 代码围栏（``` 或 ~~~）。 */
const CODE_FENCE = /^\s*(```+|~~~+)/;

/**
 * 把源 markdown 切成**安全切点数组**。切点恒在行首，每个切点记「此刻仍未闭合的围栏栈」。
 *
 * @param {string} source 源 markdown
 * @returns {{ cuts: {offset:number, openStack:string[]}[], lineStarts:number[], lineOfOffset:(o:number)=>number }}
 */
export function buildCutIndex(source) {
  const cuts = [];
  const lines = source.split('\n');
  // 每行的起始偏移（split 丢掉换行符，这里补回）
  const lineStarts = [];
  let off = 0;
  for (const line of lines) {
    lineStarts.push(off);
    off += line.length + 1; // + '\n'
  }

  const stack = [];      // 围栏栈：'collapse' | 'glossary-dict' | … | '```' | '$$'
  let codeFence = null;  // 代码围栏的定界符（``` 或 ~~~）

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\r$/, ''); // 容 CRLF

    // 切点：行首。先记录**进入本行之前**的栈状态。
    cuts.push({ offset: lineStarts[i], openStack: stack.slice() });

    // —— 代码围栏内：只找同种围栏的收尾，其他一律不当围栏 ——
    if (codeFence) {
      const m = line.match(CODE_FENCE);
      if (m && m[1][0] === codeFence[0] && m[1].length >= codeFence.length) {
        codeFence = null;
        stack.pop(); // 代码围栏收尾：把 '```' 出栈（否则栈永久污染）
      }
      continue;
    }
    const cf = line.match(CODE_FENCE);
    if (cf) { codeFence = cf[1]; stack.push('```'); continue; }

    // —— 独占行的 $$：切换跨行公式态 ——
    if (BARE_DISPLAY_MATH.test(line)) {
      const top = stack[stack.length - 1];
      if (top === '$$') stack.pop(); else stack.push('$$');
      continue;
    }

    // —— ::: 围栏：按嵌套深度 ——
    const open = line.match(FENCE_OPEN);
    if (open) { stack.push(open[1]); continue; }
    if (FENCE_CLOSE.test(line)) { if (stack.length) stack.pop(); continue; }
  }

  // 文末追加一个「终点切点」，让任意窗口都能以它为右端。
  // 注意：`source.length` **不一定在行首**（无尾换行的文件，最后一行终点就落在行内）。
  // 若直接用它当切点，就会切在行内——违反「切点恒在行首」。这里按实际情况处理：
  // 源以 `\n` 结尾 ⇒ length 本身即行首；否则回退到**最后一行的行首**（保证合法），
  // 并额外记下 trueEnd 供调用方知道「最后一行不可切」。
  const endsWithNewline = source.length > 0 && source[source.length - 1] === '\n';
  const lastCutOffset = endsWithNewline ? source.length : (lineStarts[lineStarts.length - 1] || 0);
  cuts.push({ offset: lastCutOffset, openStack: stack.slice() });

  return {
    cuts,
    lineStarts,
    endsWithNewline,
    trueEnd: source.length,
    lineOfOffset(o) {
      // 二分找最后一个 <= o 的行号
      let lo = 0, hi = lineStarts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= o) lo = mid; else hi = mid - 1; }
      return lo;
    },
  };
}

/**
 * 在小节内切一段正文。
 *
 * @param {{source:string, index:object, sectionId:string, headings:object[], grams:object, budget:number}} input
 *   - `source`：源 markdown 全文
 *   - `index`：`buildCutIndex(source)` 的结果（同源，用 source.length 粗校验）
 *   - `sectionId`：小节锚点（来自 `sectionForPosition`，**不是**折叠坐标偏移）
 *   - `headings`：源侧标题数组（{a/id, level, offset}），用来定小节范围
 *   - `grams`：`queryGrams(foldSearchText(query))` 的产物
 *   - `budget`：字符预算（调用方已 clamp）
 * @returns {{ok:true, text:string, range:object, truncated:boolean, oversize:boolean,
 *            insideCollapse:boolean, hits:number, ref:object}
 *          | {ok:false, reason:string}}
 */
export function planExcerpt(input) {
  const { source, index, sectionId, headings, grams, budget } = input;

  if (!Number.isInteger(budget) || budget < 64 || budget > 100000) {
    return { ok: false, reason: 'bad-budget' };
  }
  if (!index || index.trueEnd !== source.length) {
    return { ok: false, reason: 'stale-index' };
  }
  const idx = headings.findIndex((h) => (h.a || h.id) === sectionId);
  if (idx < 0) return { ok: false, reason: 'unknown-section' };

  const secStart = headings[idx].offset;
  const secEnd = idx + 1 < headings.length ? headings[idx + 1].offset : index.trueEnd;

  // 该小节范围内的切点（含起点、不含下一节起点）
  const cuts = index.cuts.filter((c) => c.offset >= secStart && c.offset < secEnd);
  if (cuts.length < 2) {
    // 极小/空小节
    return {
      ok: true, text: '', range: { start: secStart, end: secStart },
      truncated: false, oversize: false, insideCollapse: false, hits: 0,
      ref: { anchor: sectionId },
    };
  }

  // 给每段（相邻两切点之间）打分：段内源码重折叠后数 gram 命中。
  // **坐标纪律**：这里对**源切片**重新折叠，绝不拿折叠坐标去对源偏移。
  const segs = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const start = cuts[i].offset;
    const end = cuts[i + 1].offset;
    const text = source.slice(start, end);
    const folded = fold(text);
    let score = 0;
    for (const g of grams.bigrams) score += countOcc(folded, g) * 2;
    for (const u of grams.unigrams) score += countOcc(folded, u);
    // 折叠块内降权：本站折叠块是「提示/解答/复盘」，命中落进去等于把解答当正文返回。
    const inCollapse = cuts[i].openStack.includes('collapse');
    segs.push({ start, end, score, inCollapse, len: end - start });
  }

  // 选「命中最多且长度 ≤ budget」的连续段区间（滑动窗口）。
  // **硬约束**：窗口右端切点的 openStack 必须与左端**逐元素相等**——
  // 否则窗口就停在某个围栏内部（半对 `<details>`、`$$` 未闭合）。
  // 所以这里不直接取「第 j 段的末尾」，而是取「第 j 段之后、栈回到左端状态的那个切点」。
  const chosen = pickWindow(segs, budget, cuts);
  if (!chosen) return { ok: false, reason: 'bad-budget' };

  const text = source.slice(chosen.start, chosen.end);
  const secText = source.slice(secStart, secEnd);
  const truncated = !(chosen.start === secStart && chosen.end >= secEnd);
  const insideCollapse = segs.filter((s) => s.start >= chosen.start && s.start < chosen.end)
    .every((s) => s.inCollapse) && segs.some((s) => s.start >= chosen.start && s.start < chosen.end && s.inCollapse);

  return {
    ok: true,
    text,
    range: { start: chosen.start, end: chosen.end },
    truncated,
    oversize: text.length > budget,
    insideCollapse,
    hits: chosen.hits,
    ref: { anchor: sectionId },
  };
}

/** 折叠：只用于段内打分（与站内搜索同一套规则，但这里只做最小实现避免耦合坐标）。 */
function fold(s) {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
}
function countOcc(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
  return n;
}

/**
 * 按**显式范围**切一段正文（供「父节 + 全部子节」的扩展用）。
 * 同样守两条硬约束：切点对齐、**两端栈相等**。
 * @returns {string|null} 切出的正文；范围内没有合法切点时返回 null。
 */
export function planExcerptRange(source, index, from, to, grams, budget) {
  const cuts = index.cuts.filter((c) => c.offset >= from && c.offset <= to);
  if (cuts.length < 2) return null;
  const segs = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const start = cuts[i].offset;
    const end = cuts[i + 1].offset;
    const folded = fold(source.slice(start, end));
    let score = 0;
    for (const g of grams.bigrams) score += countOcc(folded, g) * 2;
    for (const u of grams.unigrams) score += countOcc(folded, u);
    segs.push({ start, end, score, inCollapse: cuts[i].openStack.includes('collapse'), len: end - start });
  }
  const chosen = pickWindow(segs, budget, cuts);
  if (!chosen) return null;
  return source.slice(chosen.start, chosen.end);
}

/**
 * 滑动窗口：找「加权命中最多、总长 ≤ budget、**且两端栈相等**」的连续段区间。
 *
 * 折叠块外的段权重 ×4（优先返回正文而非解答）。
 *
 * **栈相等约束**：`segs[i]` 对应切点 `cuts[i]`（段 = cuts[i]→cuts[i+1]）。
 * 选段区间 [i, j] 时，右端切点是 `cuts[j+1]`——必须满足
 * `cuts[j+1].openStack === cuts[i].openStack`，否则窗口停在围栏内部。
 */
function pickWindow(segs, budget, cuts) {
  if (!segs.length) return null;
  const W = (s) => (s.inCollapse ? 1 : 4) * s.score;
  const sameStack = (i, j) =>
    JSON.stringify(cuts[i].openStack) === JSON.stringify(cuts[j + 1].openStack);

  // 没有任何命中：从节首往后装到预算，且**右端栈必须相等**（不能停在围栏内）。
  if (!segs.some((s) => s.score > 0)) {
    let len = 0, last = -1;
    for (let j = 0; j < segs.length; j++) {
      if (len + segs[j].len > budget && j > 0) break;
      len += segs[j].len;
      if (sameStack(0, j)) last = j;
      if (len > budget) break;
    }
    if (last < 0) last = 0; // 首段就超预算/栈不配 → 退化到首段（oversize）
    return { start: segs[0].start, end: segs[last].end, hits: 0 };
  }

  let best = null;
  for (let i = 0; i < segs.length; i++) {
    let len = 0, score = 0;
    for (let j = i; j < segs.length; j++) {
      const add = segs[j].len;
      if (len + add > budget && j > i) break;
      len += add;
      score += W(segs[j]);
      // 只有右端栈与左端相等时，这个 [i,j] 才是合法窗口。
      if (sameStack(i, j)) {
        const cand = { start: segs[i].start, end: segs[j].end, hits: score };
        if (!best || cand.hits > best.hits
          || (cand.hits === best.hits && (cand.end - cand.start) < (best.end - best.start))) {
          best = cand;
        }
      }
      if (len > budget) break;
    }
  }
  if (best) return best;
  // 兜底：所有区间栈都不配（罕见，如整节都在一个围栏内）→ 取整节
  const lastIdx = segs.length - 1;
  return { start: segs[0].start, end: segs[lastIdx].end, hits: 0 };
}
