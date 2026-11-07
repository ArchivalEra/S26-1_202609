// formula-cells.mjs —— 公式单元格：把「可编辑 + 可计算」这一对能力装进页内每个公式。
//
// ## 为什么是独立模块
//
// 之前这套交互挤在 `pack-runtime.mjs` 里，而且形态是**覆盖层**：
// 点公式 → 弹出模态 → 改 → 点运行 → 关掉。读者用它得先"进一个页面"，
// 而不是像笔记本那样**单元格就在正文里**。
//
// `pack-runtime` 已经承担了太多事（OPFS 状态派生、面板渲染、诊断、下载/删除）。
// 所以把单元格这一块提成独立模块，**接口小、行为深**：
//
//   const cells = createFormulaCells({ compute, canEdit, onState });
//   cells.attach(rootEl)      // 扫 rootEl 里的公式，为每个建单元格
//   cells.detach()            // SPA 换页前清掉（别把旧 DOM 的引用留在内存里）
//   cells.setAutoCompute(bool)
//   cells.refresh()           // 重算可见的
//
// ## 编辑态是一个**显式状态**（2026-11-06 重构，站长定案）
//
// 旧实现里「正在编辑」由一堆互不同步的信号拼出来：`cell.editing` 布尔、
// `cell.mf`、`cell.currentTex`、原 `.katex` 的 display、重绘副本的 display、
// 以及 6 处分头写的内联 `style.display`。它们会漂移：改完退出后读者看到的是
// 副本、监听却挂在被藏起来的原节点上 ⇒ 第二遍点不进去；或者副本藏了没恢复
// ⇒ 屏幕空白。站长原话：「编辑态应该成为一个明确的状态」。
//
// 现在的判据：
//   ① `wrap[data-fcell-state]` 是**唯一状态真相**，取值只有 display / editing；
//   ② `setState()` 是**唯一写入点**，带显式合法转换表，非法转换响亮报错；
//   ③ 三层显示节点（原 `.katex` / 重绘副本 / math-field）**常驻 DOM、不增删**，
//      谁可见全由 CSS 按状态属性派生 —— 源码里**不许再出现 style.display =**；
//   ④ 所有行为判定（点公式、取 tex、失焦退场、拆除）都读 `stateOf(cell)`，
//      即现场读属性，不缓存镜像，杜绝两份真相。
//
// ## 四个不变量
//
// ① **MCP 读面不动**：绝不替换或删除原来的 `.katex` 节点，也不改它的
//    `data-math-plain` / `data-math-tex`。单元格是**包在外层**的容器。
// ② **不破坏 SPA**：`attach` 只在本模块自己创建的容器里动 DOM；
//    `detach` 之后不残留任何 document 级监听。
// ③ **只在公式真的变了才重算**：同一串 LaTeX 不重复算。
// ④ **编辑态单一真相**：见上，`data-fcell-state` + `setState` 唯一写入点。

// 「什么是一个符号」的唯一真相住在 站点/plugins/symbol-selector.mjs。
// 本文件是**自包含**的（测试用 toString() 派生浏览器副本，不能带 import），
// 这里复写一份；parity 闸门（symbol-parity.test.mjs）比对复写与真源是否一致。
const SYMBOL_SELECTOR = "a.sym-gloss, .ML__latex [data-term], .katex [data-term]";

const WRAP_CLASS = 'fcell';
const RESULT_CLASS = 'fcell-result';
const PLAY_CLASS = 'fcell-play';

/** 编辑态的两个取值。写在这里是为了让状态机与 CSS 共用同一批字面量。 */
const STATE_DISPLAY = 'display';
const STATE_EDITING = 'editing';
/** 合法转换表：`display → editing → display`，其余一律拒绝。 */
const STATE_TRANSITIONS = {
  display: [STATE_EDITING],
  editing: [STATE_DISPLAY],
};

/**
 * 建一个公式单元格管理器。
 *
 * @param {object} deps
 * @param {(tex: string) => Promise<{ok: boolean, output?: string, error?: string, code?: string}>} deps.compute
 *   计算适配器（页面上是 window 的那个 compute）。**必须是注入的**，不在这里读全局。
 * @param {() => boolean} [deps.canEdit]  能不能编辑（= 编辑器与内核都到位）
 * @param {(showing: boolean) => void} [deps.onEditToggle] 进入/退出编辑态的通知
 * @param {() => Promise<boolean|void>} [deps.onNeedEditor] 确保 MathLive 已载入；
 *   **必须返回 Promise**（装配层 ensureEditor 的缓存 Promise）。等它 resolve 才进编辑态，
 *   这样修掉旧实现「同步调用后立刻同步检查 customElements ⇒ 首次点击必假」的竞态。
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

  /** 现场读状态属性 —— 不缓存镜像，避免两份真相。 */
  function stateOf(cell) {
    return cell.wrap.getAttribute('data-fcell-state') || STATE_DISPLAY;
  }

  /**
   * 编辑态的**唯一写入点**。
   *
   * 非法转换不静默吞掉：把原因亮在结果区，这样「谁在什么时候试图跳跃状态」
   * 一眼可见。合法转换只做三件事 —— 写属性、通知装配层、返回成功。
   * 三层显示节点的显隐由 CSS 按属性派生，本函数一个 display 都不碰。
   */
  function setState(cell, next) {
    const cur = stateOf(cell);
    if (next === cur) return true;
    const allowed = STATE_TRANSITIONS[cur] || [];
    if (allowed.indexOf(next) === -1) {
      showCellError(cell, '编辑态转换不合法：' + cur + ' → ' + next);
      return false;
    }
    cell.wrap.setAttribute('data-fcell-state', next);
    if (typeof deps.onEditToggle === 'function') deps.onEditToggle(next === STATE_EDITING);
    return true;
  }

  /* ── 建单元格 ──────────────────────────────────────────────────── */

  /**
   * 扫描 rootEl 里的公式，为每个建一格。
   *
   * 幂等：同一个公式重复 attach 不会建两个格子（用 `data-fcell-wrapped` 标记）。
   * 只处理**带 data-math-tex** 的公式 —— 没有 LaTeX 源就没法编辑。
   */
  function attach(root) {
    if (destroyed) return;
    rootEl = root || document;
    // ⚠️ 只挑**构建期判过能算的**公式（2026-10-31 站长：只让带 mathfield 的能算）。
    // 判据是 `data-computable="1"`，由 build.mjs 用同一个转译器烘出来——
    // 含裸变量的公式（a₁₁、D_j）、含 ⟺ 的关系式一律不在其中。
    const anchors = rootEl.querySelectorAll('.katex[data-computable="1"][data-math-tex]');
    for (const anchor of anchors) {
      if (anchor.closest('.' + WRAP_CLASS)) continue;      // 已经包过了
      wrapOne(anchor);
    }
    if (autoCompute) refresh();
  }

  function wrapOne(anchor) {
    const tex = anchor.getAttribute('data-math-tex') || '';
    if (!tex.trim()) return;

    // ⚠️ 包**两层**容器，不动 anchor 本身（不变量 ①）。
    //   外层 wrap 满宽（按钮对齐）、内层 body 收缩（hover 描边贴公式）。
    const wrap = document.createElement('span');
    wrap.className = WRAP_CLASS;
    wrap.setAttribute('data-fcell-tex', tex);
    // 状态属性从建格子那一刻就存在，且**只有 setState 会改它**。
    wrap.setAttribute('data-fcell-state', STATE_DISPLAY);

    const body = document.createElement('span');
    body.className = 'fcell-body';
    const isBlock = !!anchor.closest('.math-display, .katex-display');
    if (isBlock) wrap.classList.add('fcell-block');
    body.setAttribute('data-fcell-wrapped', '1');

    const play = document.createElement('button');
    play.type = 'button';
    play.className = PLAY_CLASS;
    play.setAttribute('aria-label', '计算这条公式');
    play.title = '计算';
    play.textContent = '▶';

    const result = document.createElement('span');
    result.className = RESULT_CLASS;
    result.hidden = true;

    // 三层显示节点**常驻**：
    //   painted  空壳（:empty ⇒ CSS 藏它，显示原 SSR 公式）；重绘后装新 KaTeX
    //   anchor   构建期烘死的原公式，永不删/替换/改 innerHTML
    //   mf       懒建，首次进编辑时由 ensureMathField 追加；复用不删
    // painted 必须排在 anchor 之前：CSS 用相邻兄弟选择器
    // `.fcell-painted:not(:empty) + .katex { display:none }` 藏旧显示，不依赖 :has()。
    const painted = document.createElement('span');
    painted.className = 'fcell-painted';

    anchor.parentNode.insertBefore(wrap, anchor);
    wrap.appendChild(play);
    wrap.appendChild(body);
    body.appendChild(anchor);
    body.insertBefore(painted, anchor);
    wrap.appendChild(result);

    const cell = {
      wrap, body, anchor, painted, play, result, tex,
      mf: null, pendingEditor: false, lastComputedFor: null, busy: false,
    };
    cells.set(wrap, cell);

    play.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      computeCell(cell, { force: true });
    });

    // 点公式本体 → 进编辑态。监听挂在**容器 body** 上：它是常驻节点，
    // 不会像旧实现那样因为「显示层换成副本」而丢监听（2026-11-06 实弹）。
    body.addEventListener('click', (ev) => {
      if (!canEdit()) return;                 // 不能编辑时保持原来的点击行为（符号气泡等）
      if (typeof ev.target.closest === 'function' && ev.target.closest(SYMBOL_SELECTOR)) return;   // 符号气泡优先
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
    // quiet：自动计算路径专用。算不了时**不显示**任何东西，保持版面干净。
    const quiet = o.quiet === true;
    // 取哪份 tex **只看状态属性**：editing ⇒ 读 live math-field；display ⇒ 读容器属性。
    // 点 ▶ 会让 math-field 失焦、150ms 后 blur 退场；无论 blur 先到还是后到，
    // 两条路径拿到的都是当前内容（exitEdit 退场前已把 tex 写回 data-fcell-tex）。
    let tex = '';
    if (stateOf(cell) === STATE_EDITING && cell.mf) {
      try { tex = cell.mf.value || ''; } catch { tex = ''; }   // math-field 取值失败按空串走兜底
    }
    if (!tex) tex = cell.wrap.getAttribute('data-fcell-tex') || '';
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

  /* ── 编辑：display ⇄ editing ───────────────────────────────────── */

  /** 懒建并复用 math-field（不在退出时删除，省掉每次自定义元素 upgrade）。 */
  function ensureMathField(cell) {
    if (cell.mf?.isConnected) return cell.mf;
    const mf = document.createElement('math-field');
    mf.className = 'fcell-mathfield';
    // 虚拟键盘**全站不要**（2026-11-01 站长定案）：本站是桌面阅读场景。
    mf.setAttribute('math-virtual-keyboard-policy', 'manual');
    cell.body.appendChild(mf);
    // 配置一次（注入 shadow 样式：藏虚拟键盘按钮 + 三道杠 display 覆盖 + 提亮）。
    try { if (window.__configureMathField) window.__configureMathField(mf); } catch { /* 配置缺失不影响编辑本身 */ }

    mf.addEventListener('input', () => {
      cell.lastComputedFor = null;      // 公式变了 ⇒ 允许重算
      if (autoCompute) scheduleCompute(cell);
    });
    // 退出编辑：失焦且焦点不在格子里 ⇒ 回到 display
    mf.addEventListener('blur', () => {
      setTimeout(() => {
        if (stateOf(cell) !== STATE_EDITING || destroyed) return;
        if (cell.wrap.contains(document.activeElement)) return;
        exitEdit(cell);
      }, 150);
    });
    mf.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); exitEdit(cell); }
    });
    cell.mf = mf;
    return mf;
  }

  /**
   * display → editing。**async**：先等编辑器就绪再切状态。
   *
   * 旧实现同步调 onNeedEditor()、紧接着同步检查 customElements.get('math-field')，
   * 第一次点击必然为假并直接 return（不重试）—— 那就是站长看到的
   * 「编辑仍然无法使用」：MathLive 其实已经加载好了，右键菜单都能弹，
   * 但点公式永远进不去。
   */
  async function enterEdit(cell) {
    if (stateOf(cell) === STATE_EDITING || destroyed || cell.pendingEditor) return;

    if (typeof deps.onNeedEditor === 'function') {
      cell.pendingEditor = true;
      let ready;
      try {
        ready = await deps.onNeedEditor();
      } catch (e) {
        cell.pendingEditor = false;
        showCellError(cell, '编辑器载入失败：' + ((e?.message) || e));
        return;
      }
      cell.pendingEditor = false;
      // 允许装配层返回 void（老式调用）：那就退回查自定义元素。
      if (ready === undefined) {
        ready = !!window.customElements?.get('math-field');
      }
      if (destroyed || stateOf(cell) === STATE_EDITING) return;
      if (!ready) {
        showCellError(cell, 'MathLive 还没载入（编辑器资产未就绪）');
        return;
      }
    }
    if (!window.customElements?.get('math-field')) {
      showCellError(cell, 'MathLive 还没载入（编辑器资产未就绪）');
      return;
    }

    const mf = ensureMathField(cell);
    const tex = cell.wrap.getAttribute('data-fcell-tex') || '';
    try { mf.value = tex; } catch { mf.textContent = tex; }   // value 赋值失败退回 textContent
    if (!setState(cell, STATE_EDITING)) return;
    // MathLive 在宿主宽度为 0 时会给 [part=menu-toggle] 写 inline display:none
    // （笔记本面板默认 hidden 必命中）。每次进编辑都清一次，让三道杠跟着回来。
    try { if (window.__refreshMathFieldChrome) window.__refreshMathFieldChrome(mf); } catch { /* 装配层没暴露就跳过 */ }
    try { mf.focus(); } catch { /* 焦点失败不阻塞进入编辑态 */ }
  }

  /** editing → display：写回 tex、重绘副本、切状态。**不删 math-field**。 */
  function exitEdit(cell) {
    if (stateOf(cell) !== STATE_EDITING || destroyed) return;
    let tex = '';
    if (cell.mf) {
      try { tex = cell.mf.value || ''; } catch { tex = ''; }   // math-field 取值失败按空串走兜底
    }
    if (tex.trim()) {
      cell.wrap.setAttribute('data-fcell-tex', tex);
      repaint(cell, tex);
    }
    setState(cell, STATE_DISPLAY);
  }

  /** 把新 LaTeX 渲进常驻副本；渲染器都不可用就留空 ⇒ CSS 显示原 SSR 公式。 */
  function repaint(cell, tex) {
    const isBlock = cell.wrap.classList.contains('fcell-block');
    let html = '';
    try {
      const k = globalThis.katex;
      if (k && typeof k.renderToString === 'function') {
        html = k.renderToString(tex, { displayMode: !!isBlock, throwOnError: false });
      } else {
        const ML = globalThis.MathLive;
        if (ML && typeof ML.convertLatexToMarkup === 'function') {
          html = ML.convertLatexToMarkup(tex, { displayMode: !!isBlock });
        }
      }
    } catch (e) { /* 渲染失败：副本留空，退回显示原公式，不阻塞退场 */ }
    if (html) cell.painted.innerHTML = html;
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
   * 正确形状是一个**循环**：每轮取一批、算完再看队列里还有没有，空了才退出。
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
    for (const wrap of cells.keys()) if (io) io.observe(wrap);
    for (const cell of cells.values()) {
      if (isVisible(cell.wrap)) scheduleCompute(cell);
    }
  }

  function isVisible(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
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
   * ⚠️ 不再在拆除时 exitEdit 重绘（旧实现会白烧一次 KaTeX）：SPA 已把正文整块
   * 换掉，重绘结果马上随 wrap 一起被丢弃。只做「清引用 + 把 anchor 放回原位」。
   * 编辑态属性随 wrap 一起消失，不存在残留。
   */
  function detach() {
    if (io) { io.disconnect(); io = null; }
    for (const cell of cells.values()) {
      const wrap = cell.wrap;
      if (wrap?.parentNode) {
        const parent = wrap.parentNode;
        if (cell.anchor && cell.anchor.parentNode === cell.body) {
          cell.body.removeChild(cell.anchor);
          parent.insertBefore(cell.anchor, wrap);
        }
        parent.removeChild(wrap);
      }
    }
    cells.clear();
    queued.clear();
    if (queueTimer) { clearTimeout(queueTimer); queueTimer = null; }
    // detach 不再逐格 exitEdit（SPA 已把正文换掉，重绘是白烧），但全局的
    // 「正在编辑」标记要主动清 —— 它是装配层给 CSS/其它模块看的，留着会
    // 让下一页以为还有格子在编辑（2026-11-06 CDP 实测：detach 后仍为 "1"）。
    if (typeof deps.onEditToggle === 'function') deps.onEditToggle(false);
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
    /** 诊断用：格子数、缓存数、以及各状态各有几格（状态可数）。 */
    stats() {
      const states = {};
      for (const cell of cells.values()) {
        const s = stateOf(cell);
        states[s] = (states[s] || 0) + 1;
      }
      return { cells: cells.size, cached: resultCache.size, states };
    },
  };
}
