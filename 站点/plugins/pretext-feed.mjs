/**
 * pretext 资料门户（pretext feed）—— 独立可拆卸模块
 *
 * 移植目标：@chenglou/pretext（MIT，v0.0.9，vendored 到 assets/vendor/pretext.mjs）
 * 的「canvas 一次性测宽 + 纯算术排版」思想，做成 Shirone 式的布局性能插件：
 * 首页「全站资料门户」卡片流的列分配**不读 offsetHeight**——卡片高度由
 * prepare()/layout() 预测得出，resize 时只重跑 layout 热路径。
 * 随课程增多、卡片变多，DOM 测量路线会出现逐卡强制重排，而本插件的
 * 布局成本与卡片数近乎线性且无 reflow（?feedmode=dom 提供对照基线）。
 *
 * ============================ 与宿主的接缝 ============================
 *
 * build.mjs 三件事：① 把 FEED_JS 写成 dist/assets/plugins/pretext-feed.js
 * （type="module"，静态 import '../vendor/pretext.mjs'）；
 * ② 仅在首页（README）注入门户容器 + 卡片数据 JSON + 该 <script>；
 * ③ 白名单两个文件。摘掉即回退：无 JS 时门户区显示服务端渲染的静态列表。
 *
 * 数据契约（#pretext-feed-data，application/json）：
 *   { font: "14px …", lineHeight: 22, titleLineHeight: 24, cards: [
 *       { title, href, meta, snippet } ] }
 *
 * URL 参数：?feedmode=dom 切换 DOM 测量基线；?feedstress=N 复制卡片到 N 条
 * 供压测；?bench=1 在 window.__pretextBench 暴露布局耗时与 longtask 统计。
 */

/**
 * 纯函数：把卡片高度按「最短列优先」分配到 n 列（masonry 的本质）。
 * @param {number[]} heights
 * @param {number} colCount
 * @returns {number[][]} 每列的卡片下标（按输入顺序稳定分配）
 */
export function distributeCards(heights, colCount) {
  const cols = Array.from({ length: Math.max(1, colCount) }, () => []);
  const sums = new Array(Math.max(1, colCount)).fill(0);
  heights.forEach((h, i) => {
    let best = 0;
    for (let c = 1; c < sums.length; c++) if (sums[c] < sums[best]) best = c;
    cols[best].push(i);
    sums[best] += h;
  });
  return cols;
}

/** 纯函数：桌面/移动宽度下的列数（列宽落在 [minCol, maxCol] 区间内取最多个数）。 */
export function columnCount(containerWidth, minCol = 240, maxCol = 380) {
  if (containerWidth < minCol) return 1;
  return Math.max(1, Math.floor(containerWidth / minCol));
}

/** 纯函数：pretext 路线的卡片高度预测（不接触 DOM）。
 * measureLines(text, lineHeight) → 行数；返回像素高度。meta 行也会折行，同样预测。 */
export function predictedHeight(
  { title, snippet, meta },
  { padY, titleLineHeight, lineHeight, metaLineHeight, gap },
  measureLines,
) {
  const titleLines = measureLines(title, titleLineHeight);
  const snippetLines = measureLines(snippet, lineHeight);
  const metaLines = measureLines(meta, metaLineHeight);
  return padY * 2 + titleLines * titleLineHeight + gap + snippetLines * lineHeight + gap + metaLines * metaLineHeight;
}

export const FEED_JS = String.raw`/* pretext-feed 客户端：预测式卡片流（独立插件模块，构建期产出） */
const root = document.getElementById("pretext-feed");
const dataTag = document.getElementById("pretext-feed-data");
window.__feedLoaded = "v2";
if (root && dataTag) try {
  let prepare, layout;
  try {
    // ?v= 库版本：既是缓存破坏，也是 vendored 库升级时的正确姿势
    ({ prepare, layout } = await import("../vendor/layout.js?v=0.0.9"));
  } catch (e) {
    window.__feedError = "vendor import: " + (e && e.message || e);
    throw e;
  }
  const cfg = JSON.parse(dataTag.textContent);
  const params = new URLSearchParams(location.search);
  const mode = params.get("feedmode") === "dom" ? "dom" : "pretext";
  const stress = Math.max(0, parseInt(params.get("feedstress") || "0", 10) || 0);
  const bench = params.get("bench") === "1";
  let cards = cfg.cards.slice();
  while (stress > 0 && cards.length < stress) {
    cards = cards.concat(cfg.cards.map(c => ({ ...c, title: c.title + " ∙" })));
  }
  cards = cards.slice(0, stress || cards.length);

  const padY = 14, gap = 8, metaH = 20, minCol = 240;
  const font = cfg.font || "14px system-ui, sans-serif";
  const titleFont = "600 16px " + font.replace(/^\d+px\s*/, "");
  const preparedCache = new Map();
  function linesOf(text, f, lh, width) {
    const key = f + "|" + text;
    let p = preparedCache.get(key);
    if (!p) { p = prepare(text, f); preparedCache.set(key, p); }
    return layout(p, Math.max(40, width), lh).lineCount;
  }

  function render() {
    const width = root.clientWidth || root.getBoundingClientRect().width;
    const colCount = Math.max(1, Math.floor(width / minCol));
    // 精确列内容宽：flex gap 12px×(列数-1)、卡片内边距 14×2、边框 1×2
    const available = width - 12 * (colCount - 1);
    const contentW = Math.floor(available / colCount) - 30;
    root.textContent = "";
    const t0 = performance.now();
    const longTasks = [];
    let obs = null;
    if (bench) {
      try {
        obs = new PerformanceObserver(list => { for (const e of list.getEntries()) longTasks.push(e.duration); });
        obs.observe({ entryTypes: ["longtask"] });
      } catch (e) {}
    }
    let heights;
    const metaFont = "12px " + font.replace(/^\d+px\s*/, "");
    if (mode === "pretext") {
      heights = cards.map(c => padY * 2 +
        linesOf(c.title, titleFont, cfg.titleLineHeight, contentW) * cfg.titleLineHeight + gap +
        linesOf(c.snippet, font, cfg.lineHeight, contentW) * cfg.lineHeight + gap +
        linesOf(c.meta, metaFont, metaH, contentW) * metaH);
    } else {
      // 对照基线：经典 DOM 测量 masonry——逐卡「先挂载再读 offsetHeight」，
      // 卡片多时每读一次都可能强制同步重排，这正是 pretext 要替代的模式。
      const probe = document.createElement("div");
      probe.style.cssText = "position:absolute;left:-9999px;top:0;width:" + contentW + "px;visibility:hidden";
      document.body.appendChild(probe);
      heights = cards.map(c => {
        probe.innerHTML =
          '<div class="pretext-card"><div class="pretext-card__title">' + c.title +
          '</div><div class="pretext-card__snippet">' + c.snippet + "</div></div>";
        const el = probe.firstElementChild;
        return el.offsetHeight + 14 * 2 + 8 + 20;
      });
      probe.remove();
    }
    const cols = Math.max(1, colCount);
    const sums = new Array(cols).fill(0);
    const buckets = cards.map((c, i) => ({ c, h: heights[i] }));
    const per = Array.from({ length: cols }, () => []);
    for (const it of buckets) {
      let best = 0;
      for (let k = 1; k < cols; k++) if (sums[k] < sums[best]) best = k;
      per[best].push(it);
      sums[best] += it.h;
    }
    const frag = document.createDocumentFragment();
    const colEls = per.map(() => {
      const d = document.createElement("div");
      d.className = "pretext-feed__col";
      frag.appendChild(d);
      return d;
    });
    const placed = [];
    per.forEach((items, ci) => {
      for (const it of items) {
        const a = document.createElement("a");
        a.className = "pretext-card";
        a.href = it.c.href;
        a.innerHTML =
          '<div class="pretext-card__title">' + it.c.title + "</div>" +
          '<div class="pretext-card__snippet">' + it.c.snippet + "</div>" +
          '<div class="pretext-card__meta">' + it.c.meta + "</div>";
        colEls[ci].appendChild(a);
        placed.push({ el: a, predicted: it.h });
      }
    });
    root.appendChild(frag);
    const fb = document.getElementById("pretext-feed-fallback");
    if (fb) fb.remove();
    const layoutMs = performance.now() - t0;
    if (obs) obs.disconnect();
    if (bench) {
      let actualSum = 0, maxErr = 0;
      for (const p of placed) {
        const actual = p.el.offsetHeight;
        actualSum += actual;
        maxErr = Math.max(maxErr, Math.abs(actual - p.predicted));
      }
      window.__pretextBench = {
        mode, cards: cards.length, cols,
        layoutMs: Math.round(layoutMs * 100) / 100,
        longTasks: longTasks.length,
        longTaskMs: Math.round(longTasks.reduce((a, b) => a + b, 0) * 100) / 100,
        maxPredictErr: mode === "pretext" ? maxErr : null,
      };
    }
  }

  render();
  let raf = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      // pretext 路线：prepare 缓存仍在，重跑的只是 layout 热路径 + 列分配
      render();
    });
  });
} catch (e) {
  // 优雅降级：任何失败都保留服务端渲染的静态列表，并把原因暴露给诊断
  window.__feedError = String(e && e.message || e);
  console.warn("[pretext-feed]", e);
}
`;
