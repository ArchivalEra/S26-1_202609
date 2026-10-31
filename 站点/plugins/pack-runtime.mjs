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
  modeLabel: "pack-mode-label",
};

var state = { mode: "readonly", editor: null, engine: null };
var pack = null;
var mathliveLoading = null;
var engineLoaded = null;

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
  var ml = $(S.modeLabel);
  if (ml) {
    ml.textContent = state.mode === "computable" ? "可计算"
      : state.mode === "editable" ? "可编辑" : "只读";
  }
  // 「运行」按钮只在可计算态出现
  var runBtns = document.querySelectorAll(".pack-run-btn");
  for (var i = 0; i < runBtns.length; i++) {
    runBtns[i].hidden = state.mode !== "computable";
  }
  // 正文里的公式：只在可编辑态才显示可点样式（用 body 上的属性做 CSS 开关，
  // 不改任何公式节点本身 —— 那条是 MCP 的读面）
  document.body.setAttribute("data-pack-mode", state.mode);
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
  if (window.katex) return Promise.resolve(window.katex);
  if (katexLoading) return katexLoading;
  katexLoading = new Promise(function (res) {
    var s = document.createElement("script");
    s.src = root() + "assets/katex/katex.min.js";
    s.onload = function () { res(window.katex || null); };
    s.onerror = function () { res(null); };
    document.head.appendChild(s);
    setTimeout(function () { res(window.katex || null); }, 8000);
  });
  return katexLoading;
}

function ensureEditor() {
  if (mathliveLoading) return mathliveLoading;
  // KaTeX 与 MathLive 一起拉：编辑器要的是「MathLive 输入 + KaTeX 预览」,
  // 缺哪个都不成。两个互不影响（一个失败另一个照常），所以不串联失败。
  ensureKatex();
  mathliveLoading = import(root() + "assets/mathlive/mathlive-browser.min.js")
    .catch(function () {
      // 浏览器版是 UMD，import() 可能拿不到副作用注册；退化成 script 标签
      return new Promise(function (res, rej) {
        var sc = document.createElement("script");
        sc.src = root() + "assets/mathlive/mathlive-browser.min.js";
        sc.onload = res; sc.onerror = function () { rej(new Error("mathlive 载入失败")); };
        document.head.appendChild(sc);
      });
    })
    .then(function () { bindFormulaClicks(); });
  return mathliveLoading;
}

/* ── 点公式进编辑态：**覆盖层**，不替换原节点 ───────────────────── */
var overlay = null;

/**
 * 这条公式是不是显示式（独立成块）？
 *
 * 判据是**容器**不是公式本身：构建期给块级公式包了 「.math-display」
 * （见 build.mjs 的 renderOneMath），行内公式没有这层。
 * 用 closest 而不是 parentElement：中间可能还夹着 「.katex-scroll-container」。
 */
function isDisplayAnchor(el) {
  return !!(el && el.closest && el.closest(".math-display"));
}

/**
 * 打开编辑器。
 *
 * @param {string} tex    公式的 LaTeX 源（「data-math-tex」，作者原文）
 * @param {Element} anchorEl 被点的公式容器（用来回读 display/inline）
 *
 * ⚠️ 传进来的必须是 **LaTeX**，不是纯文本投影。「data-math-plain」 是给人读的
 * （「x1,x2,x3」），把它喂进 math-field 会当场把公式改错——见下面 bindFormulaClicks
 * 里的守卫。
 */
function openEditor(tex, anchorEl) {
  closeEditor();
  overlay = document.createElement("div");
  overlay.className = "pack-editor-overlay";
  overlay.innerHTML =
    '<div class="pack-editor-card" role="dialog" aria-label="编辑公式">' +
      '<div class="pack-editor-head">编辑公式<span class="pack-editor-close" role="button" aria-label="关闭">×</span></div>' +
      '<math-field class="pack-mathfield"></math-field>' +
      '<div class="pack-editor-preview" aria-live="polite"></div>' +
      '<div class="pack-editor-actions">' +
        '<button class="pack-btn pack-run-btn" hidden>运行</button>' +
        '<span class="pack-editor-result" aria-live="polite"></span>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  var mf = overlay.querySelector("math-field");
  try { mf.value = tex || ""; } catch (e) { mf.textContent = tex || ""; }

  // 实时预览：编辑框里改一个字，下面立刻用 **KaTeX** 重排。
  // 为什么不用 math-field 自己的渲染：MathLive 的拉伸括号由小片拼成、接缝有
  // 亚像素缝（站长 2026-10-30 定案），而读者最终看到的就是 KaTeX 版本——
  // 预览必须预览那个版本，否则「编辑时好看、确认后变样」。
  var preview = overlay.querySelector(".pack-editor-preview");
  // lastRendered 既是「上次渲染的源」（给下面的轮询比对），也挡重复渲染。
  var lastRendered = "__init__";
  var renderPreview = function () {
    if (!preview) return;
    var src = "";
    try { src = mf.value || ""; } catch (e) { src = ""; }
    lastRendered = src;
    if (!src.trim()) { preview.innerHTML = ""; return; }
    if (!window.katex || typeof window.katex.renderToString !== "function") {
      // KaTeX 还没到（正常：页面首屏没加载它时能力包自己拉）
      preview.textContent = src;
      return;
    }
    try {
      preview.innerHTML = window.katex.renderToString(src, {
        throwOnError: false, displayMode: isDisplayAnchor(anchorEl), output: "html", strict: false,
      });
    } catch (e) {
      preview.textContent = src;
    }
  };
  // 实时预览的触发源，**三条都要接**：
  //   ① input  —— 真人敲键盘（MathLive 每次编辑都发）
  //   ② change —— 某些程序化路径只发 change
  //   ③ 定时兜底 —— MathLive 的 value 属性被直接赋值时**两种事件都不发**
  //      （2026-10-31 浏览器实测：mf.value = '...' 之后预览不更新，这是真 bug）。
  //      兜底比对「当前源 vs 上次渲染的源」，变了才重排；不挂 MutationObserver ——
  //      math-field 内部结构频繁变动，监听它会把 CPU 吃光。
  var pending = null;
  var scheduleRender = function () {
    if (pending) clearTimeout(pending);
    pending = setTimeout(renderPreview, 60);
  };
  mf.addEventListener("input", scheduleRender);
  mf.addEventListener("change", scheduleRender);
  renderPreview();
  var poll = setInterval(function () {
    if (!overlay || !overlay.parentNode) { clearInterval(poll); return; }
    var cur = "";
    try { cur = mf.value || ""; } catch (e) { cur = ""; }
    if (cur !== lastRendered) renderPreview();
  }, 120);

  overlay.querySelector(".pack-editor-close").addEventListener("click", closeEditor);
  overlay.addEventListener("click", function (ev) {
    if (ev.target === overlay) closeEditor();
  });

  var runBtn = overlay.querySelector(".pack-run-btn");
  runBtn.hidden = state.mode !== "computable";
  runBtn.addEventListener("click", function () {
    runFormula(mf.value, overlay.querySelector(".pack-editor-result"), runBtn);
  });

  try { mf.focus(); } catch (e) {}
}

function closeEditor() {
  if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  overlay = null;
}

/* ── 点公式 → 打开编辑态（事件委托，对后加载的内容也有效）──────── */
function bindFormulaClicks() {
  if (document.__packClickBound) return;
  document.__packClickBound = true;
  document.addEventListener("click", function (ev) {
    if (state.mode === "readonly") return;
    var el = ev.target && ev.target.closest ? ev.target.closest(".ML__latex, .katex") : null;
    if (!el) return;
    // 符号锚点自己有气泡行为，别抢
    if (ev.target.closest && ev.target.closest("[data-term]")) return;
    if (overlay) return;
    ev.preventDefault();

    // ⚠️ 只认 data-math-tex（LaTeX 源）。**绝不回退到 data-math-plain**：
    // plain 是给人读的纯文本投影（「x1,x2,x3」），当作 LaTeX 喂进 math-field 会
    // 静默把公式改错——用户以为在编辑原式，其实拿到的是另一条公式。
    // 缺 tex 说明构建期没烘上（回归），这时**明说**比给个错值好。
    var tex = el.getAttribute("data-math-tex") || "";
    if (!tex) {
      showEditorError("这条公式没有可编辑的 LaTeX 源（data-math-tex 缺失）——是构建期没烘上，请报告");
      return;
    }
    openEditor(tex, el);
  }, true);
}

/** 编辑器无法打开时，把原因直接说在页面上（不 console 里闷着）。 */
function showEditorError(msg) {
  var box = document.getElementById("pack-editor-error");
  if (!box) {
    box = document.createElement("div");
    box.id = "pack-editor-error";
    box.className = "pack-editor-error";
    document.body.appendChild(box);
  }
  box.textContent = msg;
  box.hidden = false;
  setTimeout(function () { if (box) box.hidden = true; }, 6000);
}

/* ── 运行（第一次点才真正加载 38 MB）─────────────────────────── */
function ensureEngine() {
  if (engineLoaded) return engineLoaded;
  engineLoaded = loadOctave();
  return engineLoaded;
}

function loadOctave() {
  // 产物由 vendor 进来（assets/octave/）。加载顺序：先 octave.js（胶水）再建实例。
  // ⚠️ 这里**只做加载**，具体 eval 由页面注入的 OctaveEmbed 提供（上游 API）。
  return new Promise(function (res, rej) {
    if (window.OctaveEmbed) return res(window.OctaveEmbed);
    var sc = document.createElement("script");
    sc.src = root() + "assets/octave/octave.js";
    sc.onload = function () {
      if (window.OctaveEmbed) res(window.OctaveEmbed);
      else rej(new Error("octave.js 未导出 OctaveEmbed"));
    };
    sc.onerror = function () { rej(new Error("octave.js 载入失败")); };
    document.head.appendChild(sc);
  });
}

function runFormula(latex, outEl, btn) {
  if (btn) { btn.disabled = true; btn.textContent = "运行中…"; }
  if (outEl) outEl.textContent = "";
  var restore = function () {
    if (btn) { btn.disabled = false; btn.textContent = "运行"; }
  };
  ensureEngine()
    .then(function (Embed) {
      return window.__packCompute(latex, Embed);
    })
    .then(function (r) {
      if (outEl) outEl.textContent = (r && r.ok) ? String(r.output || "") : ("失败：" + ((r && r.error) || "未知"));
    })
    .catch(function (e) {
      if (outEl) outEl.textContent = "失败：" + ((e && e.message) || e);
    })
    .then(restore, restore);
}

/* ── 启动：只在**用户点开弹窗**时才查一次状态（不在页面加载时查）───── */
function init() {
  var toggle = $(S.toggle);
  var pop = $(S.popover);
  if (!toggle || !pop) return;

  toggle.addEventListener("click", function (ev) {
    ev.stopPropagation();
    var open = pop.hidden;
    pop.hidden = !open;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) { syncOnce(); }        // ← 只在打开时查，一次
  });
  pop.addEventListener("click", function (ev) { ev.stopPropagation(); });
  document.addEventListener("click", function () {
    if (!pop.hidden) { pop.hidden = true; toggle.setAttribute("aria-expanded", "false"); }
  });

  // 下载按钮
  var btns = pop.querySelectorAll("[data-pack-download]");
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener("click", function (ev) {
      var which = ev.currentTarget.getAttribute("data-pack-download");
      var prog = $("pack-progress-" + which);
      var btn = ev.currentTarget;
      btn.disabled = true; btn.textContent = "下载中…";
      if (prog) prog.hidden = false;
      pack.download(which, {
        onProgress: function (p) {
          if (prog) {
            var bar = prog.querySelector(".pack-progress-bar");
            if (bar && p && p.bytes) bar.style.width = "100%";
          }
        },
      }).then(function () {
        btn.textContent = "已下载";
        if (prog) prog.hidden = true;
        // ⚠️ 必须显式把新状态取回来渲染。
        // 本层**故意不订阅** pack.subscribe —— 订阅会把「广播 → 渲染 → 万一渲染里再查」
        // 这条链重新打开，正是 Octave-UI 那个放大环的形状。改成「谁改了状态，谁负责同步一次」：
        // 下载完成后由这里调一次 syncOnce()，事件驱动、方向单一、不闭环。
        return syncOnce().then(function () {
          if (which === "editor") ensureEditor();
        });
      }).catch(function (e) {
        btn.disabled = false;
        btn.textContent = "重试";
        alert("下载失败：" + ((e && e.message) || e));
      });
    });
  }

  render();
}

/* 查一次状态并渲染；**不订阅**（订阅会在每次广播时重复渲染，若渲染里再查就是环）。 */
function syncOnce() {
  if (!pack) return;
  return pack.status().then(function (s) {
    state = s;
    render();
    if (s.editor && s.editor.ready) ensureEditor();
  }).catch(function () { /* 状态查不到就保持只读 */ });
}

/* 由 inline 装配脚本注入 pack 实例与 compute 适配器（见 build.mjs 的模板）。 */
window.__initPackRuntime = function (packInstance) {
  pack = packInstance;
  init();
};

window.__packRuntime = {
  status: function () { return pack ? pack.status() : Promise.resolve(state); },
  syncOnce: syncOnce,
  get mode() { return state.mode; },
};
})();`;
