// formula-cells.mjs —— 公式单元格：把「可编辑 + 可计算」这一对能力装进页内每个公式。
//
// ## 为什么是独立模块
//
// 之前这套交互挤在 `pack-runtime.mjs`（592 行）里，而且形态是**覆盖层**：
// 点公式 → 弹出模态 → 改 → 点运行 → 关掉。读者用它得先"进一个页面"，
// 而不是像笔记本那样**单元格就在正文里**。
//
// `pack-runtime` 已经承担了太多事（OPFS 状态派生、面板渲染、诊断、下载/删除）。
// 再往里塞「公式单元格的完整生命周期」会让它变成一个谁都不敢改的巨物。
// 所以把单元格这一块提成独立模块，**接口小、行为深**：
//
//   const cells = createFormulaCells({ compute, canEdit, onState });
//   cells.attach(rootEl)      // 扫 rootEl 里的公式，为每个建单元格
//   cells.detach()            // SPA 换页前清掉（别把旧 DOM 的引用留在内存里）
//   cells.setAutoCompute(bool)
//   cells.refresh()           // 重算可见的
//
// 调用方只需要知道这五个动作。所有细节（IntersectionObserver 只算可见、
// 公式变了才重算、MathLive 实例复用、结果区渲染、键盘按钮）都在里面。
//
// ## 三个不变量
//
// ① **MCP 读面不动**：绝不替换或删除原来的 `.katex` 节点，也不改它的
//    `data-math-plain` / `data-math-tex`。单元格是**包在外层**的容器，
//    `site_read` / `site_search` 读到的仍是构建期烘的同一份。
// ② **不破坏 SPA**：`attach` 只在本模块自己创建的容器里动 DOM；
//    `detach` 之后不残留任何 document 级监听。
// ③ **只在公式真的变了才重算**：每次计算记下「算的是哪串 LaTeX」，
//    同一串不重复算（自动计算开着时，滚动/重排会反复触发回调）。

const WRAP_CLASS = 'fcell';
const RESULT_CLASS = 'fcell-result';
const PLAY_CLASS = 'fcell-play';

/**
 * 建一个公式单元格管理器。
 *
 * @param {object} deps
 * @param {(tex: string) => Promise<{ok: boolean, output?: string, error?: string, code?: string}>} deps.compute
 *   计算适配器（页面上是 window 的那个 compute）。**必须是注入的**，不在这里读全局——
 *   这样 node 里能注入假实现测，页面里注入真的。
 * @param {() => boolean} [deps.canEdit]  能不能编辑（= 编辑器与内核都到位）
 * @param {(showing: boolean) => void} [deps.onEditToggle] 进入/退出编辑态的通知
 * @param {Function} [deps.onNeedEditor]  首次要编辑时，请调用方确保 MathLive 已载入
 */
export function createFormulaCells(deps = {}) {
  const compute = deps.compute;
  if (typeof compute !== 'function') throw new Error('formula-cells: 需要注入 compute');

  /** 每个单元格的状态。key 是公式容器的 DOM 节点。 */
  const cells = new Map();
  /** 同一个 LaTeX 串的算过的结果缓存（跨单元格共享，自动计算时省重复调用）。 */
  const resultCache = new Map();
  let autoCompute = false;
  let io = null;          // IntersectionObserver：只算可见的
  let rootEl = null;
  let destroyed = false;

  function canEdit() {
    return typeof deps.canEdit === 'function' ? !!deps.canEdit() : true;
  }

  /* ── 建单元格 ──────────────────────────────────────────────────── */

  /**
   * 扫描 rootEl 里的公式，为每个建一格。
   *
   * 幂等：同一个公式重复 attach 不会建两个格子（用 `data-fcell-wrapped` 标记）。
   * 只处理**带 data-math-tex** 的公式 —— 没有 LaTeX 源就没法编辑，
   * 建个空壳只会误导。
   */
  function attach(root) {
    if (destroyed) return;
    rootEl = root || document;
    // ⚠️ 只挑**构建期判过能算的**公式（2026-10-31 站长：只让带 mathfield 的能算）。
    // 判据是 `data-computable="1"`，由 build.mjs 用同一个转译器烘出来——
    // 含裸变量的公式（a₁₁、D_j）、含 ⟺ 的关系式一律不在其中。
    // 不给它们建单元格：既不出播放按钮，也不会在自动计算时刷一屏「没有数值」。
    const anchors = rootEl.querySelectorAll('.katex[data-computable="1"][data-math-tex]');
    for (let i = 0; i < anchors.length; i += 1) {
      const anchor = anchors[i];
      if (anchor.closest('.' + WRAP_CLASS)) continue;      // 已经包过了
      wrapOne(anchor);
    }
    if (autoCompute) refresh();
  }

  function wrapOne(anchor) {
    const tex = anchor.getAttribute('data-math-tex') || '';
    if (!tex.trim()) return;

    // ⚠️ 包一层**外层容器**，不动 anchor 本身（不变量 ①）。
    const wrap = document.createElement('span');
    wrap.className = WRAP_CLASS;
    wrap.setAttribute('data-fcell-tex', tex);
    // 可点提示的锚：CSS 把 hover 描边挂在这个属性上（不是挂 .katex）。
    // 为什么：.katex 是 display:inline 的行内盒，高度只有一行（3×3 矩阵实测
    // 22px vs 公式整体 70px），描边会只框住中间一行（2026-11-01 站长报「错位」）。
    wrap.setAttribute('data-fcell-wrapped', '1');

    const play = document.createElement('button');
    play.type = 'button';
    play.className = PLAY_CLASS;
    play.setAttribute('aria-label', '计算这条公式');
    play.title = '计算';
    play.textContent = '▶';

    const result = document.createElement('span');
    result.className = RESULT_CLASS;
    result.hidden = true;

    // 插在 anchor 前面（公式本体位置不变，只是外面多了一层）
    anchor.parentNode.insertBefore(wrap, anchor);
    wrap.appendChild(play);
    wrap.appendChild(anchor);
    wrap.appendChild(result);

    const cell = { wrap, anchor, play, result, tex, lastComputedFor: null, editing: false, busy: false };
    cells.set(wrap, cell);

    play.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      computeCell(cell, { force: true });
    });

    // 点公式本体 → 原地编辑（不再弹覆盖层）
    anchor.addEventListener('click', (ev) => {
      if (!canEdit()) return;                 // 不能编辑时保持原来的点击行为（符号气泡等）
      if (ev.target.closest && ev.target.closest('[data-term]')) return;   // 符号气泡优先
      ev.preventDefault();
      ev.stopPropagation();
      enterEdit(cell);
    });

    if (io) io.observe(wrap);
    return cell;
  }

  /* ── 计算 ──────────────────────────────────────────────────────── */

  async function computeCell(cell, o = {}) {
    if (!cell || cell.busy || destroyed) return;
    // quiet：自动计算路径专用。算不了（含裸变量的公式占多数）时**不显示**任何东西，
    // 保持版面干净。手动点播放时才把原因亮出来——那时读者是主动问"这条能不能算"。
    const quiet = o.quiet === true;
    const tex = cell.editing ? cell.currentTex() : cell.wrap.getAttribute('data-fcell-tex') || '';
    if (!tex.trim()) return;

    // 不变量 ③：同一串不重复算（自动计算时滚动会反复触发）
    if (!o.force && cell.lastComputedFor === tex) return;

    cell.busy = true;
    cell.play.disabled = true;
    cell.play.textContent = '◌';
    cell.result.hidden = false;
    cell.result.className = RESULT_CLASS + ' is-pending';
    cell.result.textContent = '计算中…';

    try {
      let r = resultCache.get(tex);
      if (!r) {
        r = await compute(tex);
        // 只缓存成功结果：算不了的公式下次可能因为别的原因能算（比如内核刚载入完）
        if (r?.ok) resultCache.set(tex, r);
      }
      if (destroyed) return;
      cell.lastComputedFor = tex;
      if (r?.ok) {
        cell.result.className = RESULT_CLASS + ' is-ok';
        cell.result.textContent = '= ' + (r.output == null ? '' : String(r.output));
      } else if (quiet) {
        // 自动计算时算不了 ⇒ 整块收起，不占版面。
        // ⚠️ **必须同时清 className**（2026-10-31 实测）：只设 hidden 的话
        // `is-pending` 会留在元素上，一旦哪条 CSS 让 [hidden] 失效，页面上就
        // 会冒出一堆永远停在「计算中…」的格子。隐藏的东西也要保持状态干净。
        cell.result.hidden = true;
        cell.result.className = RESULT_CLASS;
        cell.result.textContent = '';
        cell.lastComputedFor = tex;     // 记住"这条算不了"，避免滚动时反复重试
      } else {
        cell.result.className = RESULT_CLASS + ' is-err';
        cell.result.textContent = (r?.error) || '算不了';
      }
    } catch (e) {
      if (!destroyed) {
        cell.result.className = RESULT_CLASS + ' is-err';
        cell.result.textContent = '失败：' + ((e?.message) || e);
      }
    } finally {
      if (!destroyed) {
        cell.busy = false;
        cell.play.disabled = false;
        cell.play.textContent = '▶';
      }
    }
  }

  /* ── 编辑 ──────────────────────────────────────────────────────── */

  function enterEdit(cell) {
    if (cell.editing || destroyed) return;
    // 请调用方确保 MathLive 已载入（本模块不自己拉脚本，那是装配层的事）
    if (typeof deps.onNeedEditor === 'function') deps.onNeedEditor();
    if (!(window.customElements && window.customElements.get('math-field'))) {
      showCellError(cell, 'MathLive 还没载入（编辑器资产未就绪）');
      return;
    }

    const tex = cell.wrap.getAttribute('data-fcell-tex') || '';
    const mf = document.createElement('math-field');
    mf.className = 'fcell-mathfield';
    try { mf.value = tex; } catch (e) { mf.textContent = tex; }

    // 原公式先藏起来（**不删**：MCP 读面要它，见不变量 ①）
    cell.anchor.style.display = 'none';
    cell.wrap.insertBefore(mf, cell.result);
    cell.editing = true;
    cell.mf = mf;
    cell.currentTex = () => {
      try { return mf.value || ''; } catch (e) { return ''; }
    };

    // 编辑时改一个字：如果自动计算开着，值得重算（改了就是新公式）
    mf.addEventListener('input', () => {
      cell.lastComputedFor = null;      // 公式变了 ⇒ 允许重算
      if (autoCompute) scheduleCompute(cell);
    });

    // 退出编辑：失焦且没在算 ⇒ 回到静态显示
    mf.addEventListener('blur', () => {
      // 用 setTimeout 让「点播放按钮」这类操作先跑完，别把单元格拆了
      setTimeout(() => {
        if (!cell.editing || destroyed) return;
        if (cell.wrap.contains(document.activeElement)) return;   // 焦点还在格子里
        exitEdit(cell);
      }, 150);
    });

    try { mf.focus(); } catch (e) {}
    if (typeof deps.onEditToggle === 'function') deps.onEditToggle(true);
  }

  function exitEdit(cell) {
    if (!cell.editing || destroyed) return;
    const mf = cell.mf;
    let tex = '';
    try { tex = mf.value || ''; } catch (e) { tex = ''; }
    // 把改过的 LaTeX 记到容器上（下次编辑从改后的开始）
    if (tex.trim()) cell.wrap.setAttribute('data-fcell-tex', tex);
    if (mf.parentNode) mf.parentNode.removeChild(mf);
    cell.anchor.style.display = '';
    cell.editing = false;
    cell.mf = null;
    cell.currentTex = null;
    if (typeof deps.onEditToggle === 'function') deps.onEditToggle(false);
  }

  function showCellError(cell, msg) {
    cell.result.hidden = false;
    cell.result.className = RESULT_CLASS + ' is-err';
    cell.result.textContent = msg;
  }

  /* ── 自动计算：只算可见的 ────────────────────────────────────────── */

  /** 排队算一格（同一个单元格连点多次只排队一次）。 */
  const queued = new Set();
  let queueTimer = null;
  function scheduleCompute(cell) {
    if (!cell || queued.has(cell)) return;
    queued.add(cell);
    if (!draining) drain();
  }

  /**
   * 消费队列。**串行**跑（Octave 单线程，并发只会互相排队）。
   *
   * ⚠️ 2026-10-31 实测 bug：第一版用「一个定时器 + queueTimer 非空就 return」，
   * 结果**第一批跑完就再也不排了** —— 定时器回调清空 queued 后不再看新成员，
   * 之后加入的格子永远留在 queued 里。表现正是「SPA 换页后自动计算全卡在
   * 计算中…（pending 13 但永远不变）」。
   *
   * 正确形状：一个**循环**，每轮取一批、算完再看队列里还有没有；
   * 队列空了才退出。draining 只是防重入的闸，不是「已经安排过就别再来」。
   */
  let draining = false;
  function drain() {
    if (draining || destroyed) return;
    draining = true;
    const step = async () => {
      if (destroyed) { draining = false; return; }
      const batch = [...queued];
      queued.clear();
      if (!batch.length) { draining = false; return; }
      for (const c of batch) {
        if (destroyed) { draining = false; return; }
        if (c.lastComputedFor === (c.wrap.getAttribute('data-fcell-tex') || '')) continue;
        await computeCell(c, { quiet: true });
      }
      // 算完这一批再看有没有新加入的（自动计算开着时滚动会持续触发）
      step();
    };
    // 用微任务起步，让「同一帧内多次 schedule」先攒成一批
    queueTimer = setTimeout(() => { queueTimer = null; step(); }, 30);
  }

  function ensureObserver() {
    if (io || typeof IntersectionObserver !== 'function') return;
    io = new IntersectionObserver((entries) => {
      if (!autoCompute) return;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const cell = cells.get(e.target);
        if (cell) scheduleCompute(cell);
      }
    }, { rootMargin: '200px' });      // 提前 200px 算，滚到位时结果已经在了
  }

  function setAutoCompute(on) {
    autoCompute = !!on;
    if (!autoCompute) return;
    ensureObserver();
    // 观察所有已建的格子
    for (const wrap of cells.keys()) if (io) io.observe(wrap);
    // 立刻处理当前可见的
    for (const cell of cells.values()) {
      if (isVisible(cell.wrap)) scheduleCompute(cell);
    }
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    return r.bottom > -200 && r.top < (window.innerHeight + 200) && r.width > 0;
  }

  /** 手动刷新：把所有当前可见的格子算一遍（自动计算关着时也能用）。 */
  function refresh() {
    ensureObserver();
    for (const cell of cells.values()) {
      if (isVisible(cell.wrap)) scheduleCompute(cell);
    }
  }

  /* ── 拆除（SPA 换页前）──────────────────────────────────────────── */

  /**
   * 清空所有单元格，断开所有观察与监听。
   *
   * ⚠️ SPA 换页会把 `.article-content` 整块换掉，旧单元格节点随之消失。
   * 但 `cells` 这个 Map 与 IntersectionObserver 还指着旧节点 —— 不清就是
   * 内存泄漏 + 在已脱离文档的节点上跑计算。所以换页前必须 detach。
   */
  function detach() {
    if (io) { io.disconnect(); io = null; }
    for (const cell of cells.values()) {
      if (cell.editing) exitEdit(cell);
      // 把包装层拆掉，恢复原始 DOM 形态（anchor 放回父节点原位）
      const wrap = cell.wrap;
      if (wrap?.parentNode) {
        const parent = wrap.parentNode;
        if (cell.anchor && cell.anchor.parentNode === wrap) {
          wrap.removeChild(cell.anchor);
          cell.anchor.style.display = '';
          parent.insertBefore(cell.anchor, wrap);
        }
        parent.removeChild(wrap);
      }
    }
    cells.clear();
    queued.clear();
    if (queueTimer) { clearTimeout(queueTimer); queueTimer = null; }
  }

  /** 彻底销毁（不再接受 attach）。 */
  function destroy() {
    detach();
    destroyed = true;
    resultCache.clear();
  }

  return {
    attach,
    detach,
    destroy,
    setAutoCompute,
    refresh,
    get autoCompute() { return autoCompute; },
    /** 诊断用：当前建了多少格、算过多少结果。 */
    stats() { return { cells: cells.size, cached: resultCache.size }; },
  };
}
