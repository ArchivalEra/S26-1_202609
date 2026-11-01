// pack-runtime.mjs —— 能力包的浏览器端装配（把 capability-pack.mjs 接进页面）。
//
// ## 分工（为什么分两个文件）
//
// · `capability-pack.mjs` 是**纯逻辑**：状态怎么派生、下载怎么对账、防环怎么做。
//   Node 里能直接 import 测（不需要 DOM）。
// · 本文件是**装配**：拿 DOM 元素、绑按钮、读站点根、把模块接到页面上。
//   它故意做得很薄——装配层最容易漏东西，越薄越好审。
//
// ## 三态怎么落到页面上
//
//   readonly   → 公式不可点，不显示任何编辑提示（与现在完全一样）
//   editable   → 公式包一层可点样式；点了进编辑态（MathLive）
//   computable → 编辑态里多一个「运行」按钮
//
// ## 热重载（站长要求）
//
// 「页面做热重载」= 下载完不需要手动刷新就生效。做法：
//   · 编辑器就绪 ⇒ 动态 import MathLive 浏览器版 → 注册 <math-field> → 把页面里
//     公式容器的**点击委托**打开（事件委托，不需要重新绑定已有的公式）；
//   · 内核就绪 ⇒ 只把「运行」按钮显示出来；真正加载 38 MB wasm 推迟到**第一次点运行**。
//
// ## MCP 兼容（站长要求：工具不改、插件不更新）
//
// 站内工具（webmcp-tools.mjs）读公式靠 `data-math-plain`（构建期烘的纯文本投影）
// 和 `.ML__latex` 容器。本文件**不碰这两样**：
//   · 编辑态用独立的 `<math-field>` 覆盖层，**不替换**原来的 `.ML__latex` 节点；
//   · 所以 site_read / site_search / site_show_symbol 全部照旧工作。
// 这是刻意的结构选择，不是巧合——测试里有一条断言「编辑态不改变 .ML__latex 的数量」。

export const PACK_RUNTIME_JS = String.raw`(function () {
"use strict";
if (typeof document === "undefined" || window.__packRuntime) return;

var S = {
  toggle: "pack-toggle",
  popover: "pack-popover",
};

var state = { mode: "readonly", editor: null, engine: null };
var pack = null;
var mathliveLoading = null;

/* ── 两个开关（2026-10-31 站长定案）────────────────────────────────
 *
 * 「允许编辑和计算公式」：打开后每个公式左上角出播放按钮、点公式本体可原地编辑。
 * 「自动计算公式」：打开后可见的公式**自动**出结果（没有播放按钮也要算）。
 *
 * 两者互相独立：只允许编辑不开自动计算 ⇒ 读者手动点播放；两个都开 ⇒ 笔记本式，
 * 改完立刻出结果。只开自动计算不开编辑 ⇒ 只读公式也自动出结果（有用：
 * 复习时想一眼看到所有能算的值）。
 *
 * **必须持久化**（站长原话「我希望记忆功能发挥作用」）：存 localStorage，
 * 刷新与 SPA 跳页都记得。之前「两个都下载了还得点一下按钮才能编辑」就是
 * 因为没有任何持久状态 —— 每次进页面都从「什么都没开」开始。
 */
var PREFS_KEY = "pack-prefs";
var prefs = { allowEdit: false, autoCompute: false };
try {
  var rawPrefs = localStorage.getItem(PREFS_KEY);
  if (rawPrefs) {
    var parsed = JSON.parse(rawPrefs);
    prefs.allowEdit = !!parsed.allowEdit;
    prefs.autoCompute = !!parsed.autoCompute;
  }
} catch (e) { /* 隐私模式读不到就保持默认 */ }

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {}
}

/* 单元格管理器（深模块见 plugins/formula-cells.mjs）。装配层只做三件事：
   注入 compute、告诉它「能不能编辑」、SPA 换页时 attach/detach。 */
var cells = null;

function $(id) { return document.getElementById(id); }
function root() {
  return (document.documentElement.getAttribute("data-root") || "./");
}

/* ── 状态渲染（纯读 DOM，不发查询）─────────────────────────────
   注意：渲染函数只读 state，绝不调 pack.status() —— 那是环的入口。 */
function render() {
  var lv = $("pack-state-editor");
  if (lv) {
    var e = state.editor || {};
    lv.textContent = e.ready ? "已下载" : (e.missing && e.missing.length ? "未下载" : "未下载");
    lv.className = "pack-state" + (e.ready ? " is-ready" : "");
  }
  var gv = $("pack-state-engine");
  if (gv) {
    var g = state.engine || {};
    gv.textContent = g.ready ? "已下载" : "未下载";
    gv.className = "pack-state" + (g.ready ? " is-ready" : "");
  }

  // 每件资产的按钮：**已下载就变成「删除」**（2026-10-31 站长定案）。
  // 已下载了还摆一个「下载」按钮是自相矛盾；而「已下载」状态下读者真正能做的
  // 只有一件事——把它删掉。所以文案跟着状态走，不给两个互相打架的按钮。
  // ⚠️ 只在没有进行中的操作时刷文案：正在「下载中…/删除中…」的按钮不许被覆盖。
  var abtns = document.querySelectorAll("[data-pack-action]");
  for (var k = 0; k < abtns.length; k++) {
    var b = abtns[k];
    if (b.disabled) continue;                 // 进行中，别动
    var name = b.getAttribute("data-pack-action");
    var isReady = name === "editor"
      ? !!(state.editor && state.editor.ready)
      : !!(state.engine && state.engine.ready);
    b.textContent = isReady ? "删除" : "下载";
    b.className = "pack-btn" + (isReady ? " pack-btn-danger" : "");
    b.setAttribute("title", isReady ? "删除已下载的副本" : "");
  }
  // 「当前：只读/可编辑/可计算」那一行 2026-11-01 删掉了（站长：本来就只需要
  // 下俩玩意开俩开关，不必再摆一个模式读数）。模式仍然写在 body[data-pack-mode]
  // 上——那是 CSS 与测试的判据，只是不再给读者看一行文本。
  // 正文里的公式：只在可编辑态才显示可点样式（用 body 上的属性做 CSS 开关，
  // 不改任何公式节点本身 —— 那条是 MCP 的读面）
  document.body.setAttribute("data-pack-mode", state.mode);
  renderDiag();
}

/* ── 诊断 ──────────────────────────────────────────────────────────
 *
 * 为什么需要：这套能力包有四个部件（OPFS 存储 / 状态派生 / MathLive 载入 /
 * 公式点击绑定），每一处失败都可能被吞掉，而**症状全都一样**——
 * 「下载完了但点公式没反应」。2026-10-31 站长实测就撞上这个：
 * 存储请求弹了、按钮也变「已下载」，但模式仍是只读、MathLive 影子都没有，
 * 界面上没有任何一处能说他到底卡在哪一环。
 *
 * 判据是「**任何一环失败都能被看见**」，不是「成功后显示成功」。
 *
 * ⚠️ 2026-11-01 站长定案：正常态**一个字都不许显示**。
 * 第一版把五环（编辑器资产/内核资产/编辑器脚本/预览引擎/点击绑定）逐行常驻，
 * 占了大半屏。站长原话「本来就只需要下俩玩意开俩开关给你搞这么复杂干什么」。
 * 现在：全绿 ⇒ 空；有问题 ⇒ 只报**有问题的那几行** + 一行总述。正常的不报。
 *
 * ⚠️ 「点击绑定」这一环 2026-11-01 拆掉：它描述的是**旧覆盖层**的
 * bindFormulaClicks 委托，那套已经整条删除（编辑入口只剩公式单元格）。
 * 留着它只会恒报「未绑定」，把「没部件坏」的面板刷成假警报。 */
var diag = {
  storeEditor: "未查",   // 编辑器资产在不在
  storeEngine: "未查",   // 内核资产在不在
  mathlive: "未载入",  // MathLive 脚本
  katex: "未载入",     // 预览引擎
  lastError: "",
};
/** 判定某环的值是否算「有问题」。这些词一旦出现就是坏了。 */
var DIAG_BAD_RE = /失败|不可用|不支持|未载入|未绑定|缺 |内容坏|大小不对/;
function setDiag(key, value) {
  diag[key] = value;
  renderDiag();
}
function renderDiag() {
  var box = $("pack-diag");
  if (!box) return;
  var rows = [
    ["编辑器资产", diag.storeEditor],
    ["内核资产", diag.storeEngine],
    ["编辑器脚本", diag.mathlive],
    ["预览引擎", diag.katex],
  ];
  // 只挑坏的。全好 ⇒ html 为空 ⇒ .pack-diag:empty { display:none } 整块消失。
  var bad = [];
  for (var i = 0; i < rows.length; i++) {
    if (DIAG_BAD_RE.test(rows[i][1])) bad.push(rows[i]);
  }
  var html = "";
  if (bad.length) {
    // 一行总述 + 逐行细节：总述让人知道「现在有问题」，细节让人知道是哪一环。
    html += "<div class='pack-diag-head'>有部件没就绪</div>";
    for (var j = 0; j < bad.length; j++) {
      html += "<div class='pack-diag-row is-bad'>" +
        "<span>" + bad[j][0] + "</span><span>" + bad[j][1] + "</span></div>";
    }
  }
  if (diag.lastError) {
    html += "<div class='pack-diag-err'>" + diag.lastError + "</div>";
  }
  box.innerHTML = html;
}

/* ── 能力装配：编辑器就绪 ⇒ 动态载入 MathLive 并开编辑态 ───────── */
/** KaTeX 运行时（编辑器里的实时预览用）。
 *
 * 页面正文根本不需要它——公式是构建期烘死的 HTML，首屏零 JS 排版。
 * 只有「用户点了公式、进编辑态」才拉这一次（277 KB，UMD，挂 window.katex）。
 * 加载失败不算致命：预览退化成原始 TeX 文本，编辑与运行照常。
 */
var katexLoading = null;
function ensureKatex() {
  if (window.katex) { setDiag("katex", "已就绪"); return Promise.resolve(window.katex); }
  if (katexLoading) return katexLoading;
  katexLoading = new Promise(function (res) {
    var s = document.createElement("script");
    s.src = root() + "assets/katex/katex.min.js";
    s.onload = function () {
      if (window.katex && typeof window.katex.renderToString === "function") {
        setDiag("katex", "已就绪"); res(window.katex);
      } else {
        setDiag("katex", "失败：脚本加载了但没挂上 window.katex"); res(null);
      }
    };
    s.onerror = function () {
      setDiag("katex", "失败：取不到 assets/katex/katex.min.js");
      res(null);
    };
    document.head.appendChild(s);
    setTimeout(function () {
      if (!window.katex) setDiag("katex", "失败：8 秒内没就绪");
      res(window.katex || null);
    }, 8000);
  });
  return katexLoading;
}

function ensureEditor() {
  if (mathliveLoading) return mathliveLoading;
  // KaTeX 与 MathLive 一起拉：编辑器要的是「MathLive 输入 + KaTeX 预览」,
  // 缺哪个都不成。两个互不影响（一个失败另一个照常），所以不串联失败。
  ensureKatex();
  setDiag("mathlive", "载入中…");
  // ⚠️ 直接用 script 标签，**不走 import() 试错**（2026-11-01）。
  //
  // 原写法先动态 import 那个 UMD 包，import 的 URL 会相对**调用它的模块**
  // （pack-runtime.js，在 assets/plugins/ 下）解析，于是拼成
  // …/assets/plugins/assets/mathlive/…，**每次进编辑器都在服务端打一条 404**，
  // 再回退到 script 标签成功。功能上是通的，但日志里留个假警报，
  // 排查真 404 时要先排除它。既然它本来就是 UMD，直接上 script 标签即可。
  mathliveLoading = new Promise(function (res, rej) {
    var sc = document.createElement("script");
    sc.src = root() + "assets/mathlive/mathlive-browser.min.js";
    sc.onload = res;
    sc.onerror = function () { rej(new Error("取不到 mathlive-browser.min.js（HTTP 失败）")); };
    document.head.appendChild(sc);
  })
    .then(function () {
      // ⚠️ 判据必须是「math-field 自定义元素注册上了」，不是「脚本没抛错」。
      // UMD 包加载成功但没注册元素的路径真实存在（依赖缺失、被 CSP 拦、版本不合）。
      var reg = window.customElements && window.customElements.get("math-field");
      if (!reg) {
        setDiag("mathlive", "失败：脚本加载了但没注册 math-field");
        diag.lastError = "MathLive 载入成功却未注册 math-field 元素——编辑器无法打开";
        renderDiag();
        return false;
      }
      setDiag("mathlive", "已就绪");
      // 不再 bindFormulaClicks —— 编辑入口只有单元格那一条（见下方注释块）。
      // MathLive 就绪后单元格的 canEdit() 才会返回真；那时读者点公式才会进编辑态。
      return true;
    })
    .catch(function (e) {
      setDiag("mathlive", "失败：" + ((e?.message) || e));
      diag.lastError = "MathLive 载入失败，公式无法编辑。可点上方「重新下载」再试。";
      renderDiag();
      return false;
    });
  return mathliveLoading;
}

/* ── 旧的「覆盖层编辑」整条路径已删除（2026-10-31）─────────────────
 *
 * 这里原本有一整套覆盖层编辑（弹出模态框改完点运行）：
 * 点公式 → 弹出模态框 → 改 → 点运行 → 关掉；还带一个 KaTeX 实时预览区。
 *
 * **为什么删**：它与新的「页内单元格」（plugins/formula-cells.mjs）**并存**，
 * 而且用的是 document 的**捕获阶段**监听 —— 于是它先于单元格触发，
 * 读者点公式总是弹出旧模态框。站长实测报的「没有开启的时候也能点击公式编辑」
 * 就是这个：新开关拦得住单元格那条路，拦不住这条。
 *
 * 现在编辑只有一个入口：单元格在 「canEdit()」 为真时把 anchor 点击接管。
 * 两套机制并存 = 两套判据 = 必然有一个漏，这是本仓反复吃过的教训。
 */


/* ── 引擎加载器已删除（2026-10-31）─────────────────────────────────
 *
 * 这里原本有 「ensureEngine()」 / 「loadOctave()」：它去页面上找
 * 「window.OctaveEmbed」 再 「Embed.create(...)」。**那个接口从来不存在** ——
 * 「OctaveEmbed」 是 Octave-UI 的 UI 层封装，上游产物 「octave.js」 只导出全局工厂
 * 「OCTAVE」（实测 「grep -c OctaveEmbed octave.js」 = 0）。
 *
 * 现在引擎生命周期整个搬进页面里的 「window.__packCompute」：它按上游
 * 「mail/002」 做 「OCTAVE({...})」 → 「M.execute_interp()」 → 「promising(_eval_wait)」，
 * 首次调用时载入三件，之后复用同一个实例。本层只管「按钮 → 调它 → 展示结果」。
 */

/* ── 运行：把编辑器里的 LaTeX 交给计算适配器 ────────────────────────
 *
 * 2026-10-31 重写：「window.__packCompute」 现在是**真的**（上游 002 那个
 * 「execute_interp()」 + 「promising(_eval_wait)」 的最小实现），它自己管引擎
 * 生命周期（首次调用时载入三件 38 MB），所以这里**不要再传 Embed**——
 * 旧代码等 「ensureEngine()」 拿一个 「OctaveEmbed.create()」，而那个接口压根不存在。
 *
 * 结果展示分三种，读者要能分清是哪一种：
 *   · 算出数 → 直接印数值
 *   · 这条公式算不了（有裸变量、求和、分段）→ 印中文原因
 *   · Octave 报错 → 印 rc / stderr
 */
function runFormula(latex, outEl, btn) {
  if (typeof window.__packCompute !== "function") {
    if (outEl) outEl.textContent = "计算适配器没装好（页面脚本没跑完？）";
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = "运行中…"; }
  if (outEl) { outEl.textContent = "（首次运行要载入约 38 MB 内核，慢一点）"; outEl.className = "pack-editor-result"; }
  var restore = function () {
    if (btn) { btn.disabled = false; btn.textContent = "运行"; }
  };
  Promise.resolve()
    .then(function () { return window.__packCompute(String(latex || "")); })
    .then(function (r) {
      if (!outEl) return;
      if (r?.ok) {
        outEl.textContent = String(r.output == null ? "" : r.output);
        outEl.className = "pack-editor-result is-ok";
      } else {
        outEl.textContent = (r?.error) || "未知错误";
        outEl.className = "pack-editor-result is-err";
      }
    })
    .catch(function (e) {
      if (outEl) {
        outEl.textContent = "失败：" + ((e?.message) || e);
        outEl.className = "pack-editor-result is-err";
      }
    })
    .then(restore, restore);
}

/* ════════════════════════════════════════════════════════════════
   能力入口胶囊（2026-11-01 站长定案）
   ════════════════════════════════════════════════════════════════
 *
 * 一枚胶囊两半：左 加号 资源包（恒在）、右 减号 笔记本（**本页有可算公式**时才在）。
 *
 * 三个事实决定了这个模块的形状：
 *
 * ① **「有没有可算公式」是页面的属性，不是胶囊的**。
 *    所以判据是扫正文的 data-computable="1"，而不是「读者装没装编辑器」。
 *    没下载计算内核时，可算公式照样存在（按钮照样该在）——点进去会提示去下载。
 *
 * ② **SPA 换页后正文整块换掉，胶囊 DOM 却常驻**（顶栏不被 SPA 替换）。
 *    所以每次换页都必须**重算** data-has-calc，否则上一页没公式、
 *    这一页有公式时胶囊永远不展开。这就是 refreshCapsule() 存在的原因，
 *    由 __packCellsReset 钩子调用（与单元格一起重接）。
 *
 * ③ **两个面板互斥**。它们是同一枚胶囊的两半，开一个必须关另一个——
 *    否则右上角会同时挂两个弹窗，互相遮挡。
 */

/** 本页有没有可算公式（纯读 DOM，不看资产状态）。 */
function hasComputable() {
  var body = document.querySelector(".article-content") || document.body;
  return !!body.querySelector('.katex[data-computable="1"]');
}

/** 把 data-has-calc 刷成当前页面的事实。换页后必须调一次。 */
function refreshCapsule() {
  var cap = $("pack-capsule");
  if (!cap) return;
  var has = hasComputable();
  cap.setAttribute("data-has-calc", has ? "1" : "0");
  // 右半收起时把 aria-hidden 也设上：不可见的控件不该被读屏读到。
  var minus = $("notebook-toggle");
  if (minus) minus.setAttribute("aria-hidden", has ? "false" : "true");
}

/** 关掉某个面板（幂等）。 */
function closePanel(which) {
  var pop, btn;
  if (which === "pack") { pop = $("pack-popover"); btn = $("pack-toggle"); }
  else { pop = $("notebook-popover"); btn = $("notebook-toggle"); }
  if (pop) { pop.hidden = true; pop.classList.remove("open"); }
  if (btn) btn.setAttribute("aria-expanded", "false");
}

/** 打开某个面板并关掉另一个。 */
function openPanel(which) {
  closePanel(which === "pack" ? "notebook" : "pack");
  var pop, btn;
  if (which === "pack") { pop = $("pack-popover"); btn = $("pack-toggle"); }
  else { pop = $("notebook-popover"); btn = $("notebook-toggle"); }
  if (!pop) return;
  pop.hidden = false;
  // ⚠️ 必须同时切 .open 类 类：.palette-popover 默认 display:none，
  // 只有 .palette-popover.open 才 flex（这个坑 2026-10-31 吃过一次）。
  pop.classList.add("open");
  if (btn) btn.setAttribute("aria-expanded", "true");
}

/**
 * 笔记本的一块（两个块共用一个执行器）。
 *
 * @param {{input:string, run:string, out:string, hint:string, mode:'code'|'tex'}} ids
 */
function bindNotebookBlock(ids) {
  var input = $(ids.input);
  var runBtn = $(ids.run);
  var outEl = $(ids.out);
  if (!input || !runBtn || !outEl) return;

  function showOut(text, isErr) {
    outEl.hidden = false;
    outEl.textContent = text;
    outEl.className = "nb-out" + (isErr ? " is-err" : "");
  }

  function run() {
    var src = String(input.value || "").trim();
    if (!src) { showOut("先写点什么。", true); return; }
    runBtn.disabled = true;
    showOut(ids.mode === "tex" ? "计算中…" : "运行中…", false);
    var p = (ids.mode === "tex")
      ? (typeof window.__packCompute === "function"
          ? window.__packCompute(src)
          : Promise.resolve({ ok: false, error: "计算适配器没装好" }))
      : (typeof window.__packRunCode === "function"
          ? window.__packRunCode(src)
          : Promise.resolve({ ok: false, error: "计算适配器没装好" }));
    Promise.resolve(p).then(function (r) {
      if (r && r.ok) showOut(String(r.output == null ? "" : r.output) || "(无输出)", false);
      else showOut(String((r && r.error) || "算不了"), true);
    }).catch(function (e) {
      showOut("失败：" + ((e && e.message) || e), true);
    }).then(function () {
      runBtn.disabled = false;
    });
  }

  runBtn.addEventListener("click", function (ev) { ev.stopPropagation(); run(); });
  // Ctrl/⌘ + Enter 直接运行（笔记本的肌肉记忆）
  input.addEventListener("keydown", function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") {
      ev.preventDefault();
      run();
    }
  });
  return { run: run };
}

/** 绑胶囊两半 + 笔记本面板。**幂等**（重复调不会重复绑）。 */
var capsuleBound = false;
function bindCapsule() {
  refreshCapsule();
  if (capsuleBound) return;
  var cap = $("pack-capsule");
  if (!cap) return;
  capsuleBound = true;

  var plus = $("pack-toggle");
  var minus = $("notebook-toggle");
  var notePop = $("notebook-popover");

  if (minus && notePop) {
    minus.addEventListener("click", function (ev) {
      ev.stopPropagation();
      var isOpen = !notePop.hidden;
      if (isOpen) closePanel("notebook");
      else openPanel("notebook");
    });
    notePop.addEventListener("click", function (ev) { ev.stopPropagation(); });
  }

  // 点空白处关掉笔记本（与资源包面板同一套行为）
  document.addEventListener("click", function () {
    if (notePop && !notePop.hidden) closePanel("notebook");
  });

  // 两块：MATLAB（原生代码）+ 公式（LaTeX）
  bindNotebookBlock({ input: "nb-code", run: "nb-run-code", out: "nb-code-out", hint: "nb-code-hint", mode: "code" });
  bindNotebookBlock({ input: "nb-tex", run: "nb-run-tex", out: "nb-tex-out", hint: "nb-tex-hint", mode: "tex" });
}

/* ── 启动：只在**用户点开弹窗**时才查一次状态（不在页面加载时查）───── */
function init() {
  var toggle = $(S.toggle);
  var pop = $(S.popover);
  if (!toggle || !pop) return;

  // 胶囊另一半（笔记本）与它自己的面板
  bindCapsule();

  // 开关：先绑、再把 DOM 刷成持久化值。
  // ⚠️ 顺序：bindSwitches 里读 checkbox.checked，所以必须先 renderSwitches
  // 让 DOM 与 prefs 一致，否则读者看到的是「关」而状态是「开」。
  renderSwitches();
  bindSwitches();

  // 页面加载就查一次状态并把单元格装上（2026-10-31 修「必须点按钮才能编辑」）。
  // 这一句是「记忆功能」真正生效的地方：prefs 从 localStorage 恢复，
  // 资产状态查一次，两者都到位 ⇒ 公式立刻可编辑、可算，读者什么都不用点。
  syncOnce();

  toggle.addEventListener("click", function (ev) {
    ev.stopPropagation();
    // ⚠️ 走 openPanel/closePanel 而不再就地翻 hidden：
    // 两个面板**互斥**（胶囊两半，开一个必须关另一个）。就地翻 hidden 会
    // 让资源包面板开着时点减号那一半，右上角同时挂两个弹窗。
    if (pop.hidden) {
      openPanel("pack");
      syncOnce();            // ← 只在打开时查，一次
    } else {
      closePanel("pack");
    }
  });
  pop.addEventListener("click", function (ev) { ev.stopPropagation(); });
  document.addEventListener("click", function () {
    if (!pop.hidden) closePanel("pack");
  });

  // 每件资产一个按钮，**动作由状态决定**（2026-10-31 站长定案）：
  //
  //   未下载 → 「下载」      点 → download()
  //   已下载 → 「删除」      点 → remove()（带一个确认，因为这是不可逆的）
  //   下载中 → 「下载中…」   禁用
  //
  // 为什么不再固定一个下载按钮：已下载了还给一个「下载」按钮是自相矛盾——
  // 站长原话「已下载居然还开放下载按钮」。而且它对「旧副本坏了」这个场景也
  // 没法表达：读者点下去只是又跑一遍 size 校验，看不出发生了什么。
  //
  // ⚠️ 这里**不再单独有一个「清空重来」按钮**：那是个带侵略性的说法
  // （「清空」「重来」暗示要推倒重来），而读者想要的只是「这件我不要了」。
  // 每件的「删除」就是那个动作，语义正好。
  var actBtns = pop.querySelectorAll("[data-pack-action]");
  for (var i = 0; i < actBtns.length; i++) {
    actBtns[i].addEventListener("click", function (ev) {
      var which = ev.currentTarget.getAttribute("data-pack-action");
      var btn = ev.currentTarget;
      var ready = which === "editor"
        ? !!(state.editor && state.editor.ready)
        : !!(state.engine && state.engine.ready);

      if (!ready) { downloadAsset(which, btn); return; }

      // 已下载 ⇒ 删除。确认一次：删掉要重下 824 KB / 38 MB，不可逆。
      var label = which === "editor" ? "公式编辑器" : "计算内核";
      var size = which === "editor" ? "824 KB" : "38 MB";
      if (!window.confirm("删除" + label + "？\n\n下次要用得重新下载（" + size + "）。")) return;
      btn.disabled = true;
      btn.textContent = "删除中…";
      pack.remove(which).then(function () {
        // 删完把内存里的加载标记复位，否则 ensureEditor 的 Promise 缓存
        // 还指着上一次的尝试，重下也不会重新载入。
        if (which === "editor") {
          mathliveLoading = null;
          setDiag("mathlive", "未载入");
        }
        diag.lastError = "";
        return syncOnce();
      }).catch(function (e) {
        diag.lastError = "删除失败：" + ((e?.message) || e);
        renderDiag();
      }).then(function () {
        btn.disabled = false;
        render();          // 文案由 render 统一刷（见下）
      });
    });
  }

  /** 下载一件资产（按钮文案与进度条在本函数内维护）。 */
  function downloadAsset(which, btn) {
    var prog = $("pack-progress-" + which);
    btn.disabled = true; btn.textContent = "下载中…";
    if (prog) prog.hidden = false;
    pack.download(which, {
      onProgress: function (p) {
        if (prog) {
          var bar = prog.querySelector(".pack-progress-bar");
          if (bar && p?.bytes) bar.style.width = "100%";
        }
      },
    }).then(function () {
      if (prog) prog.hidden = true;
      // ⚠️ 必须显式把新状态取回来渲染。
      // 本层**故意不订阅** pack.subscribe —— 订阅会把「广播 → 渲染 → 万一渲染里再查」
      // 这条链重新打开，正是 Octave-UI 那个放大环的形状。改成「谁改了状态，谁负责同步一次」：
      // 下载完成后由这里调一次 syncOnce()，事件驱动、方向单一、不闭环。
      return syncOnce().then(function () {
        if (which === "editor") ensureEditor();
        btn.disabled = false;
        render();
      });
    }).catch(function (e) {
      var msg = (e?.message) || String(e);
      setDiag(which === "editor" ? "storeEditor" : "storeEngine", "下载失败：" + msg);
      diag.lastError = "下载失败：" + msg;
      renderDiag();
      btn.disabled = false;
      btn.textContent = "重试";
    });
  }

  render();
}

/* 查一次状态并渲染；**不订阅**（订阅会在每次广播时重复渲染，若渲染里再查就是环）。 */
function syncOnce() {
  if (!pack) {
    setDiag("storeEditor", "失败：能力包实例没建起来（capability-pack.mjs 装配失败）");
    return Promise.resolve();
  }
  return pack.status().then(function (s) {
    state = s;
    // 存储层要报**两件资产**的状态。
    // 2026-10-31 实测：只报了 editor，于是「引擎已下载、编辑器没下」时诊断行写的是
    // 「缺 mathlive-browser.min.js」——读者会以为引擎没下成功，实际是编辑器没下。
    // 两件事必须分开说。
    var LABEL = { editor: "公式编辑器", engine: "计算内核" };
    var desc = function (a) {
      if (!a) return "未查";
      if (a.ready) return "已就绪 " + (a.present || 0) + "/" + (a.total || 1);
      if (a.missing && a.missing.length) {
        var m = a.missing[0];
        var why = m.reason === "content" ? "内容坏" : m.reason === "size" ? "大小不对" : "缺";
        return why + " " + (m.name || "");
      }
      return "未就绪";
    };
    setDiag("storeEditor", desc(s.editor));
    setDiag("storeEngine", desc(s.engine));
    render();
    renderSwitches();
    // 资产到位就**自动**载入编辑器并挂上单元格——不再等读者点一下按钮。
    //
    // 站长原话：「即使两个部件都下载了，进了页面也编辑不了公式，必须点一下那个
    // 按钮才能来编辑，我希望记忆功能发挥作用」。根因就是激活只发生在「点开面板」
    // 那条路径上（syncOnce 只在打开发面板时被调）。现在：
    //   · 页面初始化时无条件 syncOnce 一次（见 init）；
    //   · 状态到位 ⇒ ensureEditor() 载入 MathLive + mountCells() 挂单元格；
    //   · 「允许编辑」开关也持久化，两者合起来 = 进页面就能编辑。
    if (s.editor && s.editor.ready) {
      ensureEditor();
      mountCells();
    }
  }).catch(function (e) {
    setDiag("storeEditor", "失败：" + ((e?.message) || e));
    diag.lastError = "查询存储状态出错：" + ((e?.message) || e);
    renderDiag();
  });
}

/* 由 inline 装配脚本注入 pack 实例与 compute 适配器（见 build.mjs 的模板）。 */
window.__initPackRuntime = function (packInstance) {
  pack = packInstance;
  init();
};

/* ════════════════════════════════════════════════════════════════
   公式单元格装配（2026-10-31）
   ════════════════════════════════════════════════════════════════
 *
 * 三件事：
 *   ① 两个开关的绑定与持久化；
 *   ② 把 「plugins/formula-cells.mjs」 接进来（注入 compute、canEdit）；
 *   ③ 接 SPA reset 钩子：换页后 attach 新正文、detach 旧的。
 *
 * ⚠️ **这里不能自己造 compute**：真实现是页面内联脚本里的
 * 「window.__packCompute」（它管 Octave 实例生命周期）。本层只转发。
 */

function ensureCells() {
  if (cells) return cells;
  if (typeof window.__createFormulaCells !== "function") return null;
  cells = window.__createFormulaCells({
    compute: function (tex) {
      if (typeof window.__packCompute !== "function") {
        return Promise.resolve({ ok: false, error: "计算适配器没装好" });
      }
      return window.__packCompute(tex);
    },
    // 能不能编辑 = 编辑器资产就位 **且** 读者打开了「允许编辑和计算」开关
    canEdit: function () {
      return !!(prefs.allowEdit && state.editor && state.editor.ready && window.customElements
        && window.customElements.get("math-field"));
    },
    // 首次要编辑时确保 MathLive 已载入（懒加载只发生一次）
    onNeedEditor: function () { try { ensureEditor(); } catch (e) {} },
    onEditToggle: function (on) {
      document.body.setAttribute("data-fcell-editing", on ? "1" : "0");
    },
  });
  return cells;
}

/** 按当前状态把单元格装上（幂等）。 */
function mountCells() {
  var c = ensureCells();
  if (!c) return;
  // ⚠️ 「允许编辑和计算」关着 ⇒ **一个单元格都不挂**（2026-10-31 站长）。
  // 第一版这里无条件 attach，于是页面加载就冒出 71 个播放按钮，
  // 而读者明明没开那个开关 —— 开关看起来是坏的。
  // 「自动计算」单独开着但编辑关着时也不挂：没有单元格就没有可算的目标，
  // 那种组合下读者要的是「只读看数」，不是「能改」。
  if (!prefs.allowEdit) { c.detach(); return; }
  c.attach(document.querySelector(".article-content") || document.body);
  c.setAutoCompute(!!prefs.autoCompute);
}

/** 把开关的 DOM 状态刷成 prefs（不触发 change 事件）。 */
function renderSwitches() {
  var ae = $("pack-allow-edit");
  if (ae) ae.checked = !!prefs.allowEdit;
  var ac = $("pack-auto-compute");
  if (ac) ac.checked = !!prefs.autoCompute;
  // 「允许编辑」需要编辑器资产就位；没下载时禁用并给提示（别让读者以为开关坏了）
  if (ae) {
    var ready = !!(state.editor && state.editor.ready);
    ae.disabled = !ready;
    var hint = ae.parentNode && ae.parentNode.querySelector(".pack-switch-hint");
    if (hint) {
      hint.textContent = ready
        ? "公式旁出播放按钮，点公式本体可原地编辑"
        : "需要先下载「公式编辑器」";
    }
  }
}

function bindSwitches() {
  var ae = $("pack-allow-edit");
  if (ae && !ae.__packBound) {
    ae.__packBound = true;
    ae.addEventListener("change", function () {
      prefs.allowEdit = !!ae.checked;
      savePrefs();
      // 开 ⇒ 立刻挂上单元格（不进面板、不刷新就能编辑）；
      // **关 ⇒ 立刻收回**（2026-10-31 站长：「开关关掉的时候也要坦荡收回啊」）。
      // 第一版只有 if、没有 else —— 关掉开关后播放按钮和原地编辑全都还在，
      // 读者会以为开关坏了。收回的动作就是 detach：拆掉包装层、还原原始 DOM。
      if (prefs.allowEdit) {
        try { ensureEditor(); } catch (e) {}
        mountCells();
      } else if (cells) {
        cells.detach();
      }
      renderSwitches();
    });
  }
  var ac = $("pack-auto-compute");
  if (ac && !ac.__packBound) {
    ac.__packBound = true;
    ac.addEventListener("change", function () {
      prefs.autoCompute = !!ac.checked;
      savePrefs();
      var c = ensureCells();
      if (c) c.setAutoCompute(prefs.autoCompute);
      renderSwitches();
    });
  }
}

/* SPA 换页钩子：换页前拆单元格、换页后重建。
 * 为什么必须拆：SPA 会把 .article-content 整块换掉，旧单元格节点随之消失，
 * 但 cells Map 与 IntersectionObserver 还指着它们 —— 不清就是内存泄漏，
 * 还会在已脱离文档的节点上跑计算（白烧 CPU、算完没人看得到）。 */
window.__packCellsReset = function () {
  if (cells) cells.detach();
  mountCells();
  // ⚠️ **换页后必须重算胶囊**（2026-11-01）：顶栏常驻，但正文是全新的——
  // 上一页没有可算公式、这一页有（或反过来），不重算的话胶囊永远停在旧状态。
  // 这是「跟 SPA 兼容」的全部要点：DOM 常驻的东西必须由换页钩子主动刷新。
  try { refreshCapsule(); } catch (e) { /* 没胶囊的页（理论上不存在）忽略 */ }
  // 换页时把笔记本的输出清掉：那条结果属于上一页的上下文，留着会误导
  // （读者看到「= 2」却不知道是哪条公式算的）。
  try {
    ["nb-code-out", "nb-tex-out"].forEach(function (id) {
      var el = $(id);
      if (el) { el.hidden = true; el.textContent = ""; el.className = "nb-out"; }
    });
  } catch (e) {}
};

window.__packRuntime = {
  status: function () { return pack ? pack.status() : Promise.resolve(state); },
  syncOnce: syncOnce,
  get mode() { return state.mode; },
  get prefs() { return { allowEdit: prefs.allowEdit, autoCompute: prefs.autoCompute }; },
  /** 测试/调试用：手动重挂单元格。 */
  remountCells: mountCells,
};
})();`;
