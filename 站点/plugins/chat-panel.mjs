/**
 * 豆姐聊天面板（站点侧）。
 *
 * ## 结构（三层，只有最后一层碰 DOM）
 *
 *   ① 纯函数（本文件的 parseIncremental / parseInline / renderBlockToOps 来自 chat-render.mjs）
 *   ② 挂载层：op[] → DOM（applyOps，只用 createElement + textContent）
 *   ③ 传输层：SSE 连桥（/chat）
 *
 * ## 安全不变量（测试守着）
 *
 *   I1  **innerHTML 只用于公式节点**，且只接收 katex.renderToString 的产出。
 *   I2  链接协议白名单（在 chat-render.mjs 里）。
 *   I3  图片只允许同源相对路径（在 chat-render.mjs 里）。
 *   I4  任何原始 HTML 标签一律按文本处理（chat-render.mjs 不解析它们）。
 *
 * ## 与站点的关系
 *
 *   · 面板 DOM 放在 `#search-panel` 旁边（`.article-content` 之外）——SPA 换页不会销毁它
 *   · 与 TOC 互斥：`body.chat-open` 类让 `.m3-toc` 隐藏
 *   · 触发按钮是 `#assistant-toggle`（手形图标，build.mjs 已埋好）
 *   · SPA 导航时 `window.__chatSync()` 被调用，只更新「当前页」上下文，不销毁历史
 */

import {
  parseIncremental, parseInline, renderBlockToOps, safeHref, safeSrc,
  isMathOpen, findClosingDollar, splitRow, MAX_MESSAGE_CHARS,
} from './chat-render.mjs';

// ════════════════════════════════════════════════════════════════
// ① 样式（构建期写盘，不靠 JS 注入）
// ════════════════════════════════════════════════════════════════

export const CHAT_CSS = `
/* ── 豆姐聊天面板（2026-10-19）────────────────────────────────
   布局三档：
     · > 1200px  右栏，接管 TOC 的 240px
     · 861-1200  浮层 360px（该区间 TOC 本就隐藏）
     · ≤ 860px   底部窗口 70dvh
   与 TOC 互斥由 body.chat-open 控制。 */

.chat-panel {
  display: none;
  flex-direction: column;
  min-height: 0;
  background-color: var(--md-sys-color-surface-container-lowest);
  color: var(--md-sys-color-on-surface);
}

/* 桌面：右栏，位置与宽度对齐 TOC */
@media (min-width: 1201px) {
  .chat-panel {
    width: var(--toc-width);
    flex-shrink: 0;
    height: calc(100vh - var(--header-height));
    position: sticky;
    top: var(--header-height);
    border-left: 1px solid var(--md-sys-color-outline-variant);
  }
  body.chat-open .chat-panel { display: flex; }
  body.chat-open .m3-toc { display: none; }
}

/* 中等：浮层 */
@media (min-width: 861px) and (max-width: 1200px) {
  .chat-panel {
    position: fixed;
    right: 16px;
    top: calc(var(--header-height) + 16px);
    bottom: 16px;
    width: 360px;
    border-radius: 16px;
    border: 1px solid var(--md-sys-color-outline-variant);
    box-shadow: var(--shadow-3);
    z-index: 150;
  }
  body.chat-open .chat-panel { display: flex; }
}

/* 手机：底部窗口 */
@media (max-width: 860px) {
  .chat-panel {
    position: fixed;
    left: 0;
    right: 0;
    bottom: var(--chat-kb-inset, 0px);
    height: 70dvh;
    max-height: 70dvh;
    border-radius: 20px 20px 0 0;
    border-top: 1px solid var(--md-sys-color-outline-variant);
    box-shadow: var(--shadow-3);
    z-index: 150;
    transition: transform .22s cubic-bezier(.2, .8, .3, 1);
    transform: translateY(100%);
  }
  body.chat-open .chat-panel { display: flex; transform: translateY(0); }
  /* 收起态：只剩标题条 */
  body.chat-open.chat-min .chat-panel { transform: translateY(calc(100% - 52px)); }
}

/* ── 头部 ── */
.chat-head {
  display: flex;
  align-items: center;
  gap: .5rem;
  padding: .7rem .9rem;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  flex-shrink: 0;
}
.chat-title {
  font-size: 0.85rem;
  font-weight: 700;
  color: var(--md-sys-color-on-surface);
  flex: 1;
}
.chat-head-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px; height: 28px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--md-sys-color-on-surface-variant);
  cursor: pointer;
}
.chat-head-btn:hover { background-color: var(--md-sys-color-surface-container-high); }
.chat-min-btn { display: none; }
@media (max-width: 860px) { .chat-min-btn { display: inline-flex; } }

/* ── 消息区 ── */
.chat-log {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-anchor: none;   /* Safari 不支持，靠 JS 的 stuck 状态位 */
  padding: .8rem .9rem 1rem;
  display: flex;
  flex-direction: column;
  gap: .9rem;
}

.chat-msg { display: flex; flex-direction: column; gap: .35rem; }

/* 用户消息：气泡，右对齐 */
.chat-msg--user { align-items: flex-end; }
.chat-msg--user .chat-body {
  max-width: 88%;
  padding: .5rem .75rem;
  border-radius: 14px 14px 4px 14px;
  background-color: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
  font-size: 0.82rem;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 助手消息：通栏无气泡（Shirone 的正文气质） */
.chat-msg--bot .chat-body {
  font-size: 0.82rem;
  line-height: 1.65;
  color: var(--md-sys-color-on-surface);
  word-break: break-word;
}

/* 助手消息里的块级元素 */
.chat-body p { margin: 0 0 .55rem; }
.chat-body p:last-child { margin-bottom: 0; }
.chat-body h1, .chat-body h2, .chat-body h3, .chat-body h4 {
  font-size: 0.86rem;
  font-weight: 700;
  margin: .7rem 0 .4rem;
  line-height: 1.35;
}
.chat-body h1:first-child, .chat-body h2:first-child { margin-top: 0; }
.chat-body ul, .chat-body ol { margin: 0 0 .55rem; padding-left: 1.15rem; }
.chat-body li { margin-bottom: .22rem; }
.chat-body strong { font-weight: 700; }
.chat-body em { font-style: italic; }
.chat-body code {
  font-family: var(--font-mono);
  font-size: 0.78em;
  padding: .08em .3em;
  border-radius: 4px;
  background-color: var(--md-sys-color-surface-container-high);
}
.chat-body pre {
  margin: 0 0 .55rem;
  padding: .55rem .65rem;
  border-radius: 10px;
  background-color: var(--md-sys-color-surface-container);
  overflow-x: auto;
}
.chat-body pre code { padding: 0; background: none; font-size: 0.75rem; }
.chat-body a {
  color: var(--md-sys-color-primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}
/* 宽内容横向滚动（240px 下表格/公式会溢出） */
.chat-body table {
  border-collapse: collapse;
  font-size: 0.76rem;
  display: block;
  overflow-x: auto;
  max-width: 100%;
  margin: 0 0 .55rem;
}
.chat-body th, .chat-body td {
  border: 1px solid var(--md-sys-color-outline-variant);
  padding: .25rem .45rem;
  text-align: left;
  white-space: nowrap;
}
.chat-body th { background-color: var(--md-sys-color-surface-container); font-weight: 700; }
.chat-body .katex-display {
  overflow-x: auto;
  overflow-y: hidden;
  padding: .2rem 0;
  margin: .35rem 0;
}
.chat-body .chat-math-err {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--md-sys-color-error, #b3261e);
}

/* 流式光标 */
.chat-cursor::after {
  content: '▍';
  margin-left: 1px;
  animation: chat-blink 1s steps(2) infinite;
}
@keyframes chat-blink { 50% { opacity: 0; } }

/* 空状态 */
.chat-empty {
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.78rem;
  line-height: 1.7;
  padding: .4rem 0;
}
.chat-empty ul { margin: .4rem 0 0; padding-left: 1.1rem; }
.chat-empty li { margin-bottom: .3rem; }

/* 「有新消息」提示 */
.chat-jump {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: 76px;
  padding: .28rem .7rem;
  border: none;
  border-radius: 999px;
  background-color: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
  font-size: 0.72rem;
  cursor: pointer;
  box-shadow: var(--shadow-2);
  z-index: 2;
}
.chat-panel { position: relative; }
@media (min-width: 1201px) { .chat-panel { position: sticky; } }

/* ── 输入区 ── */
.chat-input {
  flex-shrink: 0;
  display: flex;
  align-items: flex-end;
  gap: .4rem;
  padding: .6rem .9rem calc(.6rem + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--md-sys-color-outline-variant);
}
.chat-textarea {
  flex: 1;
  min-height: 34px;
  max-height: 132px;   /* 约 6 行 */
  resize: none;
  padding: .45rem .6rem;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: 12px;
  background-color: var(--md-sys-color-surface-container-lowest);
  color: var(--md-sys-color-on-surface);
  font-family: inherit;
  font-size: 16px;     /* iOS 防自动放大（<16px 会缩放） */
  line-height: 1.45;
  outline: none;
}
.chat-textarea:focus { border-color: var(--md-sys-color-primary); }
.chat-send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px; height: 34px;
  flex-shrink: 0;
  border: none;
  border-radius: 50%;
  background-color: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
  cursor: pointer;
}
.chat-send:disabled { opacity: .45; cursor: default; }
.chat-send.stop { background-color: var(--md-sys-color-error, #b3261e); }

@media (prefers-reduced-motion: reduce) {
  .chat-panel { transition: none; }
  .chat-cursor::after { animation: none; }
}
`;

// ════════════════════════════════════════════════════════════════
// ② 客户端源码（构建期内联；纯逻辑由 toString 派生，保证测的就是跑的）
// ════════════════════════════════════════════════════════════════

/**
 * 把 op 序列挂到 DOM。**这是唯一碰 innerHTML 的地方**，且只用于公式。
 * @param {object} doc
 * @param {object} el  容器
 * @param {Array} ops
 * @param {object} katex  KaTeX 全局对象（可能为 null）
 */
export function applyOps(doc, el, ops, katex) {
  const mk = (tag) => doc.createElement(tag);

  /** 行内 ops → 一串节点。 */
  const inlineNodes = (list) => {
    const out = [];
    for (const o of (list || [])) {
      switch (o.kind) {
        case 'text': {
          out.push(doc.createTextNode(o.text));
          break;
        }
        case 'strong': { const n = mk('strong'); n.textContent = o.text; out.push(n); break; }
        case 'em': { const n = mk('em'); n.textContent = o.text; out.push(n); break; }
        case 'code': { const n = mk('code'); n.textContent = o.text; out.push(n); break; }
        case 'math': {
          const n = mk('span');
          n.className = 'chat-math';
          renderMathInto(doc, n, o.tex, false, katex);
          out.push(n);
          break;
        }
        case 'link': {
          const n = mk('a');
          n.setAttribute('href', o.href);
          // 外链新窗口；站内链接（# 或相对）同窗
          if (/^https?:/i.test(o.href)) { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer'); }
          n.textContent = o.text;
          out.push(n);
          break;
        }
        case 'img': {
          const n = mk('img');
          n.setAttribute('src', o.src);
          n.setAttribute('alt', o.alt || '');
          n.setAttribute('loading', 'lazy');
          n.style.maxWidth = '100%';
          out.push(n);
          break;
        }
        default: break;
      }
    }
    return out;
  };

  for (const op of (ops || [])) {
    let node = null;
    switch (op.kind) {
      case 'heading': {
        const lvl = Math.min(4, Math.max(1, op.level || 2));
        node = mk('h' + lvl);
        for (const c of inlineNodes(op.ops)) node.appendChild(c);
        break;
      }
      case 'para': {
        node = mk('p');
        for (const c of inlineNodes(op.ops)) node.appendChild(c);
        break;
      }
      case 'list': {
        node = mk(op.ordered ? 'ol' : 'ul');
        for (const item of op.items) {
          const li = mk('li');
          for (const c of inlineNodes(item)) li.appendChild(c);
          node.appendChild(li);
        }
        break;
      }
      case 'codeblock': {
        node = mk('pre');
        const code = mk('code');
        if (op.lang) code.className = 'language-' + op.lang;
        code.textContent = op.text;      // 代码块永远 textContent
        node.appendChild(code);
        break;
      }
      case 'mathblock': {
        node = mk('div');
        node.className = 'chat-math-block';
        renderMathInto(doc, node, op.tex, true, katex);
        break;
      }
      case 'table': {
        node = mk('table');
        const thead = mk('thead');
        const trh = mk('tr');
        for (const cell of op.header) {
          const th = mk('th');
          for (const c of inlineNodes(cell)) th.appendChild(c);
          trh.appendChild(th);
        }
        thead.appendChild(trh);
        node.appendChild(thead);
        if (op.rows && op.rows.length) {
          const tbody = mk('tbody');
          for (const row of op.rows) {
            const tr = mk('tr');
            for (const cell of row) {
              const td = mk('td');
              for (const c of inlineNodes(cell)) td.appendChild(c);
              tr.appendChild(td);
            }
            tbody.appendChild(tr);
          }
          node.appendChild(tbody);
        }
        break;
      }
      default: break;
    }
    if (node) el.appendChild(node);
  }
}

/**
 * 渲染一个公式节点。
 *
 * ⚠️ **安全不变量 I1**：`innerHTML` 只在这里出现，且只接收 KaTeX 的产出。
 * 失败时走 `textContent`——KaTeX 的错误信息可能含**未转义**的 LaTeX 源码，
 * 直接插进 innerHTML 就是注入面。
 */
export function renderMathInto(doc, node, tex, display, katex) {
  if (!katex || typeof katex.renderToString !== 'function') {
    node.textContent = (display ? '$$' : '$') + tex + (display ? '$$' : '$');
    return;
  }
  try {
    // trust:false 是默认；显式写出来是给读代码的人看
    const html = katex.renderToString(tex, {
      displayMode: !!display,
      throwOnError: false,
      trust: false,
      maxSize: 10,
      maxExpand: 1000,
      strict: 'ignore',
    });
    node.innerHTML = html;   // ← 全文件唯一一处，且来源受限
  } catch (e) {
    node.className = (node.className ? node.className + ' ' : '') + 'chat-math-err';
    node.textContent = String((e && e.message) || e);   // 错误串走 textContent
  }
}

// ════════════════════════════════════════════════════════════════
// ③ 客户端 IIFE（面板 UI + SSE + 挂载）
// ════════════════════════════════════════════════════════════════

export const CHAT_JS = `(function () {
"use strict";
if (typeof document === "undefined") return;

// 纯逻辑从模块派生——测的就是跑的
var MAX_MESSAGE_CHARS = ${MAX_MESSAGE_CHARS};
var parseInline = ${parseInline.toString()};
var safeHref = ${safeHref.toString()};
var safeSrc = ${safeSrc.toString()};
var isMathOpen = ${isMathOpen.toString()};
var findClosingDollar = ${findClosingDollar.toString()};
var splitRow = ${splitRow.toString()};
var parseIncremental = ${parseIncremental.toString()};
var renderBlockToOps = ${renderBlockToOps.toString()};
var applyOps = ${applyOps.toString()};
var renderMathInto = ${renderMathInto.toString()};

var BRIDGE = "http://127.0.0.1:9345";

// ── 状态 ────────────────────────────────────────────────────
var panel = null, logEl = null, inputEl = null, sendBtn = null, jumpBtn = null;
var open = false;
var busy = false;
var sessionKey = "web-" + (Date.now() % 100000);
var katexLoading = null;
var stream = null;          // 当前 AbortController
var stuck = true;           // 是否贴底
var msgEls = [];            // 消息 DOM 引用（用于流式更新最后一条）

// ── 工具函数 ────────────────────────────────────────────────
function token() {
  try { return localStorage.getItem("webmcp_bridge_token") || ""; } catch (e) { return ""; }
}
function withToken(u) {
  var t = token();
  return t ? (u + (u.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(t)) : u;
}

/** KaTeX 按需加载（站点已有 katex.min.css，但没有页面引 katex.min.js）。 */
function ensureKatex() {
  if (window.katex) return Promise.resolve(window.katex);
  if (katexLoading) return katexLoading;
  katexLoading = new Promise(function (resolve) {
    var root = document.documentElement.getAttribute("data-root") || "./";
    var s = document.createElement("script");
    s.src = root + "assets/katex/katex.min.js";
    s.async = true;
    s.onload = function () { resolve(window.katex || null); };
    s.onerror = function () { resolve(null); };
    document.head.appendChild(s);
  });
  return katexLoading;
}

// ── 滚动吸附（use-stick-to-bottom 思路的极简移植）──────────
function nearBottom() {
  if (!logEl) return true;
  return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48;
}
function scrollToBottom(instant) {
  if (!logEl) return;
  logEl.scrollTop = logEl.scrollHeight;
}
function onUserScroll() {
  if (!logEl) return;
  stuck = nearBottom();
  if (stuck && jumpBtn) jumpBtn.remove();
}

// ── 消息渲染 ────────────────────────────────────────────────
function addMsg(role) {
  var wrap = document.createElement("div");
  wrap.className = "chat-msg chat-msg--" + role;
  var body = document.createElement("div");
  body.className = "chat-body";
  wrap.appendChild(body);
  logEl.appendChild(wrap);
  msgEls.push({ role: role, body: body, raw: "" });
  if (stuck) scrollToBottom();
  return msgEls[msgEls.length - 1];
}

/** 把累积的原文重新渲染进消息体（增量解析 + 只追加新块）。 */
function renderMessage(msg, final) {
  var parsed = parseIncremental(msg.raw);
  // 已渲染块数
  var done = msg.rendered || 0;
  for (var i = done; i < parsed.blocks.length; i++) {
    var ops = renderBlockToOps(parsed.blocks[i]);
    applyOps(document, msg.body, ops, window.katex);
  }
  msg.rendered = parsed.blocks.length;
  // 尾巴（未闭合）以纯文本预览显示，闭合后会被替换
  if (msg.tailEl) { msg.tailEl.remove(); msg.tailEl = null; }
  if (!final && parsed.rest) {
    var tail = document.createElement("span");
    tail.textContent = parsed.rest;
    tail.className = "chat-tail";
    msg.body.appendChild(tail);
    msg.tailEl = tail;
  }
  if (!final) {
    msg.body.classList.add("chat-cursor");
  } else {
    msg.body.classList.remove("chat-cursor");
  }
  if (stuck) scrollToBottom();
  else if (!jumpBtn) showJump();
}

function showJump() {
  if (!jumpBtn || !panel) return;
  jumpBtn = document.createElement("button");
  jumpBtn.className = "chat-jump";
  jumpBtn.textContent = "有新消息 ↓";
  jumpBtn.onclick = function () {
    stuck = true;
    scrollToBottom();
    if (jumpBtn) { jumpBtn.remove(); jumpBtn = null; }
  };
  panel.appendChild(jumpBtn);
}

// ── SSE 请求 ────────────────────────────────────────────────
function askChat(text) {
  if (busy) return;
  var userMsg = addMsg("user");
  userMsg.body.textContent = text;

  var botMsg = addMsg("bot");
  busy = true;
  if (sendBtn) { sendBtn.classList.add("stop"); sendBtn.disabled = false; }
  stream = (typeof AbortController !== "undefined") ? new AbortController() : null;

  var body = JSON.stringify({ text: text, sessionId: sessionKey });
  fetch(withToken(BRIDGE + "/chat"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body,
    signal: stream ? stream.signal : undefined,
  }).then(function (res) {
    if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = "";
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return finish();
        buf += dec.decode(r.value, { stream: true });
        var parts = buf.split("\\n\\n");
        buf = parts.pop();
        for (var i = 0; i < parts.length; i++) handleEvent(parts[i]);
        return pump();
      });
    }
    function handleEvent(raw) {
      var line = raw.split("\\n").filter(function (l) { return l.indexOf("data:") === 0; })[0];
      if (!line) return;                     // 注释/心跳
      var ev;
      try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { return; }
      if (ev.type === "delta") {
        botMsg.raw += String(ev.text || "");
        if (botMsg.raw.length > MAX_MESSAGE_CHARS) botMsg.raw = botMsg.raw.slice(0, MAX_MESSAGE_CHARS);
        renderMessage(botMsg, false);
      } else if (ev.type === "done") {
        if (ev.text && !botMsg.raw) botMsg.raw = String(ev.text);
        renderMessage(botMsg, true);
      } else if (ev.type === "error") {
        botMsg.raw = botMsg.raw || ("（连接失败：" + (ev.reason || "未知") + "）");
        renderMessage(botMsg, true);
      }
      // ev.type === "tool" 不显示
    }
    function finish() {
      if (!botMsg.rendered && !botMsg.raw) {
        botMsg.body.textContent = "（没有收到回答）";
      } else {
        renderMessage(botMsg, true);
      }
      busy = false;
      if (sendBtn) { sendBtn.classList.remove("stop"); sendBtn.disabled = false; }
      stream = null;
    }
    return pump();
  }).catch(function (e) {
    if (e && e.name === "AbortError") {
      renderMessage(botMsg, true);
    } else {
      botMsg.body.textContent = "连不上助手（" + String((e && e.message) || e) + "）";
    }
    busy = false;
    if (sendBtn) { sendBtn.classList.remove("stop"); sendBtn.disabled = false; }
    stream = null;
  });
}

// ── 面板开关 ────────────────────────────────────────────────
function buildPanel() {
  if (panel) return;
  panel = document.createElement("aside");
  panel.id = "chat-panel";
  panel.className = "chat-panel";
  panel.setAttribute("aria-label", "豆姐助手");

  var head = document.createElement("div");
  head.className = "chat-head";
  var title = document.createElement("span");
  title.className = "chat-title";
  title.textContent = "豆姐";
  var minBtn = document.createElement("button");
  minBtn.className = "chat-head-btn chat-min-btn";
  minBtn.setAttribute("aria-label", "收起");
  minBtn.textContent = "▾";
  minBtn.onclick = function () { document.body.classList.toggle("chat-min"); };
  var closeBtn = document.createElement("button");
  closeBtn.className = "chat-head-btn";
  closeBtn.setAttribute("aria-label", "关闭");
  closeBtn.textContent = "✕";
  closeBtn.onclick = close;
  head.appendChild(title); head.appendChild(minBtn); head.appendChild(closeBtn);

  logEl = document.createElement("div");
  logEl.className = "chat-log";
  logEl.setAttribute("role", "log");
  logEl.setAttribute("aria-live", "polite");
  logEl.addEventListener("scroll", onUserScroll, { passive: true });
  logEl.addEventListener("wheel", function () { stuck = false; }, { passive: true });
  logEl.addEventListener("touchmove", function () { stuck = false; }, { passive: true });

  var form = document.createElement("form");
  form.className = "chat-input";
  inputEl = document.createElement("textarea");
  inputEl.className = "chat-textarea";
  inputEl.rows = 1;
  inputEl.placeholder = "问豆姐…";
  inputEl.addEventListener("input", function () {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(132, inputEl.scrollHeight) + "px";
  });
  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit ? form.requestSubmit() : sendNow();
    }
  });
  sendBtn = document.createElement("button");
  sendBtn.className = "chat-send";
  sendBtn.type = "submit";
  sendBtn.setAttribute("aria-label", "发送");
  sendBtn.textContent = "↑";
  form.appendChild(inputEl); form.appendChild(sendBtn);
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (busy) { if (stream) stream.abort(); return; }
    sendNow();
  });

  panel.appendChild(head); panel.appendChild(logEl); panel.appendChild(form);

  // 放在 #search-panel 旁边（.article-content 之外 → SPA 不销毁）
  var anchor = document.getElementById("search-panel");
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(panel, anchor.nextSibling);
  else document.body.appendChild(panel);

  ensureKatex();
}

function sendNow() {
  var t = String(inputEl && inputEl.value || "").trim();
  if (!t || busy) return;
  inputEl.value = "";
  inputEl.style.height = "auto";
  askChat(t.slice(0, MAX_MESSAGE_CHARS));
}

function showEmpty() {
  var box = document.createElement("div");
  box.className = "chat-empty";
  box.innerHTML = "";   // 下面用 createElement 建，不用 innerHTML
  var p = document.createElement("p");
  p.textContent = "我可以帮你在这套课程资料里找东西、读页面、看图。试试：";
  var ul = document.createElement("ul");
  ["这一页讲了什么？", "电机学有哪些课堂笔记？", "跳到「铁芯损耗」那一节"].forEach(function (s) {
    var li = document.createElement("li");
    li.textContent = s;
    ul.appendChild(li);
  });
  box.appendChild(p); box.appendChild(ul);
  logEl.appendChild(box);
}

function openPanel() {
  buildPanel();
  open = true;
  document.body.classList.add("chat-open");
  document.body.classList.remove("chat-min");
  var btn = document.getElementById("assistant-toggle");
  if (btn) btn.setAttribute("aria-expanded", "true");
  if (logEl && !logEl.children.length) showEmpty();
  if (inputEl) inputEl.focus();
  stuck = true;
  scrollToBottom();
}

function close() {
  open = false;
  document.body.classList.remove("chat-open", "chat-min");
  var btn = document.getElementById("assistant-toggle");
  if (btn) btn.setAttribute("aria-expanded", "false");
}

function toggle() { open ? close() : openPanel(); }

// ── 接线 ────────────────────────────────────────────────────
var toggleBtn = document.getElementById("assistant-toggle");
if (toggleBtn) toggleBtn.addEventListener("click", function (e) { e.stopPropagation(); toggle(); });

document.addEventListener("keydown", function (e) {
  if (e.key === "Escape" && open) {
    // 输入框有内容时先不清空，只关面板
    close();
  }
});

// SPA 导航钩子：面板不销毁，只更新「当前页」感知（历史保留）
window.__chatSync = function () {
  if (!open) return;
  // 目前不需要额外动作：下一轮 ask 时 contextProvider 会取新页信息。
  // 这里只做滚动位置复位，避免换页后仍停在旧位置。
  stuck = true;
  scrollToBottom();
};

window.__chatPanel = { open: openPanel, close: close, toggle: toggle, ask: askChat, get isOpen() { return open; } };
})();`;
