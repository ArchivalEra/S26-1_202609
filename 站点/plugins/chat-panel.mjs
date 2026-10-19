/**
 * 学习助手面板（站点侧）。
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
 *   · 与 TOC 互斥：`body.chat-open` 类让 `.m3-toc` 隐藏（桌面档）
 *   · 触发按钮是 `#assistant-toggle`（手形图标，build.mjs 已埋好）
 *   · SPA 导航时 `window.__chatSync()` 被调用，只更新「当前页」上下文，不销毁历史
 *
 * ## 手机档 = 右侧抽屉，与左侧边栏同一套手法（2026-10-19 用户定案）
 *
 * 左侧边栏在 `max-width:860px` 是 `position:fixed; transform:translateX(-100%)`，
 * 加 `.open` 类滑入，配 `.drawer-backdrop` 遮罩。右侧助手照抄这套：
 *
 *   · 同样 `fixed` + `translateX(100%)` → `.open` 时归零（**不再用 dvh 高度 + 底部窗口**）
 *   · 同样 `visibility` 切换（收起时不可聚焦，也不参与命中测试）
 *   · 同样的遮罩层与手势：点遮罩关闭、Esc 关闭
 *   · 宽度 `min(88vw, 380px)`——手机上远宽于桌面档的 240px，且**不覆盖整页**
 *
 * 为什么原来的底部窗口会「划一下像磕大」：`height:70dvh` + `bottom:var(--chat-kb-inset)`
 * 在移动浏览器里随 URL 栏收放与键盘弹起**每帧改布局**，`position:fixed` 的元素跟着重排，
 * 主线程被拖住。抽屉用 `100dvh` 一次算好，滚动时不动。
 */

import {
  parseIncremental, parseInline, renderBlockToOps, safeHref, safeSrc,
  isMathOpen, findClosingDollar, splitRow, MAX_MESSAGE_CHARS,
} from './chat-render.mjs';

// ════════════════════════════════════════════════════════════════
// ① 样式（构建期写盘，不靠 JS 注入）
// ════════════════════════════════════════════════════════════════

export const CHAT_CSS = `
/* ── 学习助手面板（2026-10-19）────────────────────────────────
   布局三档：
     · > 1200px  右栏，接管 TOC 的 240px
     · 861-1200  浮层 360px（该区间 TOC 本就隐藏）
     · ≤ 860px   右侧抽屉，与左侧边栏同一套手法（fixed + translateX）
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

/* 手机：右侧抽屉（与左侧边栏同一套手法，只是方向相反） */
@media (max-width: 860px) {
  .chat-panel {
    /* 常驻 display:flex —— 与左侧抽屉一致，靠 visibility+transform 显隐。
       若用 display:none 切显隐，滑入过渡不会播（元素从无到有）。 */
    display: flex;
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    left: auto;
    width: 380px;
    max-width: 88vw;
    height: 100vh;
    height: 100dvh;
    border-radius: 0;
    border: none;
    border-left: 1px solid var(--md-sys-color-outline-variant);
    box-shadow: var(--shadow-3);
    z-index: 100;
    /* 收起态：整块滑到视口外，且不可聚焦/不可命中 */
    transform: translateX(100%);
    visibility: hidden;
    pointer-events: none;
    transition: transform .3s cubic-bezier(.2, 0, 0, 1), visibility .3s;
    /* 抽屉自身独立成层：页面滚动不带着它重排 */
    contain: layout paint style;
  }
  body.chat-open .chat-panel {
    transform: translateX(0);
    visibility: visible;
    pointer-events: auto;
  }
}

/* 助手抽屉的遮罩：复用 .drawer-backdrop 的观感，独立一个元素避免与左侧互抢 */
.chat-backdrop {
  display: none;
}
@media (max-width: 860px) {
  .chat-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 99;
    opacity: 0;
    pointer-events: none;
    transition: opacity .3s;
  }
  body.chat-open .chat-backdrop {
    opacity: 1;
    pointer-events: auto;
  }
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

/* ── 消息区 ── */
.chat-log {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-anchor: none;   /* Safari 不支持，靠 JS 的 stuck 状态位 */
  overscroll-behavior: contain;  /* 滚到边界不回传给页面——手机上尤为明显 */
  -webkit-overflow-scrolling: touch;
  padding: .8rem .9rem 1rem;
  display: flex;
  flex-direction: column;
  gap: .9rem;
  /* 只把这一个元素提升成独立合成层：流式追加不触发整页重绘 */
  contain: layout paint style;
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
/* ── 表格（2026-10-19 用户报「表格不美观」）─────────────────────
   原来为了宽内容不撑破 240px，把 table 直接设成 display:block + 四边全框，
   结果是「一堆格子」而不是一张表：没有表头分区、没有行分隔层次、
   内边距挤成 0.25rem、首尾还多出边框。

   现在与站点正文表格同一套观感（shirone-reader.css 的 table 段），
   并补上一个滚动包裹层：
     · .chat-table-wrap 负责**横滚 + 外框 + 圆角**（宽度随容器）
     · table 用 width:max-content 按内容排，不被拉伸
   早先把 overflow 挂在 table 上时，边框盒撑满整行而列只有内容宽，
   右侧会留一条空白、圆角画在空盒上（截图实测）。 */
.chat-table-wrap {
  overflow-x: auto;
  max-width: 100%;
  margin: .2rem 0 .7rem;
  border-radius: 10px;
  /* 只留外圈一道淡边，避免"每个格子都是框"的网格感 */
  box-shadow: 0 0 0 1px var(--md-sys-color-outline-variant);
}
.chat-body table {
  border-collapse: collapse;
  font-size: 0.78rem;
  width: max-content;
  min-width: 100%;
}
.chat-body th, .chat-body td {
  border: none;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  padding: .45rem .6rem;
  text-align: left;
  white-space: nowrap;
  vertical-align: top;
}
.chat-body th {
  background-color: var(--md-sys-color-surface-container);
  font-weight: 600;
  color: var(--md-sys-color-on-surface);
  /* 表头下沿加重一档：一眼分得出哪行是表头 */
  border-bottom-color: var(--md-sys-color-outline);
}
.chat-body tr:last-child td { border-bottom: none; }
/* 斑马纹：数字型表格最容易看串行 */
.chat-body tbody tr:nth-child(even) {
  background-color: color-mix(in srgb, var(--md-sys-color-surface-container) 45%, transparent);
}
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

/* ── 过程提示（思考 ↔ 输出的分界，2026-10-19）─────────────────
   模型检索期间显示的一行灰字：小号、无气泡、不在正文流里。
   与助手正文（黑字通栏、0.82rem）刻意拉开差别，一眼能看出
   「这不是答案，它在干活」。答案第一个字到达时由 JS 移除。 */
.chat-status {
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.74rem;
  line-height: 1.5;
  font-style: italic;
  opacity: .85;
  margin: 0 0 .2rem;
}
.chat-status::before {
  content: '';
  display: inline-block;
  width: 6px; height: 6px;
  margin-right: .4rem;
  border-radius: 50%;
  background-color: var(--md-sys-color-primary);
  animation: chat-pulse 1.4s ease-in-out infinite;
  vertical-align: middle;
}
@keyframes chat-pulse {
  0%, 100% { opacity: .25; }
  50% { opacity: 1; }
}

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
/* 注意：这里不能写无条件的 position: relative。
   它是给 .chat-jump 做包含块的，但会覆盖手机档的 position: fixed——
   CSS 里同特异度后者胜，而这条写在媒体查询之后。三个档位各自都已
   建立了包含块（sticky / fixed），所以这条不需要存在。 */

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
/* 停止态：正方形（▢）比圆更符合「中止」的语义，也让「正在回答」一眼可辨 */
.chat-send.stop {
  border-radius: 10px;
}

/* ── 附件（2026-10-19 用户要求）─────────────────────────────
   回形针按钮 + 待发图片缩略图条。
   缩略图条在输入区**上方**：发送前能看到自己附了什么，发完自动收起。 */
.chat-attach-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px; height: 34px;
  flex-shrink: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--md-sys-color-on-surface-variant);
  cursor: pointer;
}
.chat-attach-btn:hover { background-color: var(--md-sys-color-surface-container-high); }
.chat-attach-btn:disabled { opacity: .4; cursor: default; }

.chat-attach-bar {
  display: flex;
  gap: .4rem;
  padding: .5rem .9rem .1rem;
  flex-shrink: 0;
  overflow-x: auto;
}
.chat-attach-bar:empty { display: none; }
.chat-attach-item {
  position: relative;
  flex: 0 0 auto;
  width: 56px; height: 56px;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--md-sys-color-outline-variant);
  background-color: var(--md-sys-color-surface-container);
}
.chat-attach-item img {
  width: 100%; height: 100%;
  object-fit: cover;
  display: block;
}
.chat-attach-item.uploading::after {
  content: '';
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--md-sys-color-surface) 60%, transparent);
  animation: chat-pulse 1.2s ease-in-out infinite;
}
.chat-attach-item.failed { border-color: var(--md-sys-color-error, #b3261e); }
/* 浏览器解不了的格式（HEIC）画不出缩略图：显示扩展名方块，别露出破图图标 */
.chat-attach-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%; height: 100%;
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: .04em;
  color: var(--md-sys-color-on-surface-variant);
  background-color: var(--md-sys-color-surface-container-high);
}
.chat-attach-x {
  position: absolute;
  top: 1px; right: 1px;
  width: 18px; height: 18px;
  padding: 0;
  border: none;
  border-radius: 50%;
  /* 缩略图上叠的删除键：底色必须与图片内容解耦（图片可能是任意颜色），
     所以用半透明黑而不是主题色——换成 primary 会在浅色图上消失。 */
  background: color-mix(in srgb, #000 55%, transparent);
  color: var(--md-sys-color-on-primary);
  font-size: 12px;
  line-height: 18px;
  text-align: center;
  cursor: pointer;
}
/* 拖拽悬停：整块面板给个提示色 */
.chat-panel.chat-dragover {
  outline: 2px dashed var(--md-sys-color-primary);
  outline-offset: -6px;
}

@media (prefers-reduced-motion: reduce) {
  .chat-panel { transition: none; }
  .chat-cursor::after { animation: none; }
  .chat-attach-item.uploading::after { animation: none; }
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
        // 包一层滚动容器（2026-10-19 截图实测）：
        // 直接给 table 设 display:block + overflow-x:auto 时，**边框盒**撑满
        // 整个容器宽度，而列按内容宽排——右侧于是留出一条空白，圆角也画在
        // 空盒上。改成外层 div 负责滚动与外框、table 按内容宽，二者才对齐。
        // 这与站点正文的 .table-scroll-container 是同一手法。
        var tableWrap = mk('div');
        tableWrap.className = 'chat-table-wrap';
        tableWrap.appendChild(node);
        node = tableWrap;
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
var panel = null, logEl = null, inputEl = null, sendBtn = null, jumpBtn = null, backdrop = null;
var attachBtn = null, attachBar = null, fileInput = null;
var open = false;
var busy = false;
var sessionKey = "web-" + (Date.now() % 100000);
var katexLoading = null;
var stream = null;          // 当前 AbortController
var stuck = true;           // 是否贴底
var msgEls = [];            // 消息 DOM 引用（用于流式更新最后一条）
var pending_attach = [];    // 待发附件：{id, name, dataUrl, fileInfo, status:'uploading'|'ready'|'failed'}
var stopAnswerRef = function () {};   // 当前提问的停止句柄（askChat 里赋值）

// ── 工具函数 ────────────────────────────────────────────────

/**
 * 桥 token 的三级来源（2026-10-19 修「永远是连不上助手」）。
 *
 * 面板与页面桥各自独立，**不能假设对方先跑过**：用户可能直接把面板叫起来
 * 而页面桥还没注入完成。所以这里自己解析，顺序与 loader 一致：
 * window.__bridgeToken → localStorage → GET /bootstrap（桥对本机 Origin 回 token）。
 */
var tokenPromise = null;
function tokenAsync(force) {
  if (!force && tokenPromise) return tokenPromise;
  tokenPromise = new Promise(function (resolve) {
    var t = "";
    try { t = window.__bridgeToken || localStorage.getItem("webmcp_bridge_token") || ""; } catch (e) {}
    if (t) { window.__bridgeToken = t; return resolve(t); }
    var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timer = setTimeout(function () { try { ctrl && ctrl.abort(); } catch (e) {} }, 3000);
    fetch(BRIDGE + "/bootstrap", { cache: "no-store", signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { clearTimeout(timer); return r.ok ? r.json() : null; })
      .then(function (j) {
        var v = (j && j.token) ? String(j.token) : "";
        if (v) {
          window.__bridgeToken = v;
          try { localStorage.setItem("webmcp_bridge_token", v); } catch (e) {}
        }
        resolve(v);
      })
      .catch(function () { clearTimeout(timer); resolve(""); });
  });
  return tokenPromise;
}

function withToken(u, t) {
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

// ── 附件（2026-10-19 用户要求）──────────────────────────────
//
// 上游只收 jpg/png。浏览器里 input[type=file] 能拿到 png/jpeg/webp/heic…
// 所以这里做两道：
//   ① 选图时按 **magic bytes** 判真实格式（不信任扩展名）
//   ② 非 jpg/png 的画到 canvas 上转成 jpeg（和 site_image 的 webp→jpeg 同一套思路）
//
// 为什么在浏览器转而不是后端转：转码要解码图片，Node 侧没有可靠的零依赖解码器，
// 而浏览器本来就要把图画到缩略图上——顺手就转了，零额外成本。

/**
 * 按文件头判真实类型。返回 'jpeg' | 'png' | 'gif' | 'webp' | 'heic' | 'unknown'。
 *
 * HEIC 单独认出来（2026-10-19 实测）：iPhone 拍照默认就是它，而**绝大多数
 * 桌面浏览器（Chromium/Firefox on Linux/Windows）根本解不了**——
 * new Image() 直接 onerror、createImageBitmap 报 "could not be decoded"。
 * 所以这不是「转码失败」，是「这个环境读不了这个格式」，得给用户明确的出路。
 */
function sniffImage(bytes) {
  var b = bytes;
  if (b.length < 12) return "unknown";
  if (b[0] === 0xFF && b[1] === 0xD8) return "jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return "png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  // HEIF/HEIC：ISO BMFF，第 4..7 字节是 'ftyp'，brand 在 8..11
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    var brand = "";
    for (var i = 8; i < 12; i++) brand += String.fromCharCode(b[i]);
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return "heic";
  }
  return "unknown";
}

/** 把任意可解码图片重绘成 jpeg（透明底铺白），返回 {dataUrl, mimeType}。 */
function transcodeToJpeg(dataUrl, maxEdge) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    img.onload = function () {
      var w = img.naturalWidth || img.width;
      var h = img.naturalHeight || img.height;
      if (!w || !h) return reject(new Error("图片尺寸为 0"));
      var scale = Math.min(1, (maxEdge || 2048) / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * scale));
      var ch = Math.max(1, Math.round(h * scale));
      var canvas = document.createElement("canvas");
      canvas.width = cw; canvas.height = ch;
      var g = canvas.getContext("2d");
      if (!g) return reject(new Error("canvas 不可用"));
      // jpeg 没有 alpha：先铺白，否则透明区会变黑
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, cw, ch);
      g.drawImage(img, 0, 0, cw, ch);
      try {
        resolve({ dataUrl: canvas.toDataURL("image/jpeg", 0.9), mimeType: "image/jpeg" });
      } catch (e) { reject(e); }
    };
    img.onerror = function () { reject(new Error("图片无法解码")); };
    img.src = dataUrl;
  });
}

/** File → {dataUrl, mimeType}（非 jpg/png 自动转码）。 */
function prepareImage(file) {
  return new Promise(function (resolve, reject) {
    if (file.size > 12 * 1024 * 1024) return reject(new Error("图片太大（上限 12 MB）"));
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = String(reader.result || "");
      var b64 = dataUrl.split(",")[1] || "";
      var head;
      try {
        var bin = atob(b64.slice(0, 16));
        head = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) head[i] = bin.charCodeAt(i);
      } catch (e) { head = new Uint8Array(0); }
      var kind = sniffImage(head);
      if (kind === "jpeg") return resolve({ dataUrl: dataUrl, mimeType: "image/jpeg" });
      if (kind === "png") return resolve({ dataUrl: dataUrl, mimeType: "image/png" });
      // 其余先试浏览器转码：Safari（macOS/iOS）能直接解 HEIC，那就照常走。
      transcodeToJpeg(dataUrl, 2048).then(resolve, function () {
        // 浏览器解不了（2026-10-19 实测：Chromium/Firefox 在 Linux/Windows 上
        // 对 HEIC 一律失败）。**不要把原始字节丢掉**——桥那边有 ImageMagick，
        // 它能解。这里原样交给桥，由它转完再上传。
        //
        // 前端不再自己判"能不能转"，也不给用户抛「请改相机设置」这种
        // 让他去改设备的建议：本机桥能解决的事，不该推给用户。
        resolve({
          dataUrl: dataUrl,
          mimeType: kind === "heic" ? "image/heic"
            : kind === "gif" ? "image/gif"
            : kind === "webp" ? "image/webp"
            : "application/octet-stream",
          needsServerConvert: true,
        });
      });
    };
    reader.onerror = function () { reject(new Error("读文件失败")); };
    reader.readAsDataURL(file);
  });
}

/** 把一张图 POST 到桥的 /upload，拿回 fileInfo。 */
function uploadAttachment(item, tk) {
  var b64 = String(item.dataUrl || "").split(",")[1] || "";
  return fetch(withToken(BRIDGE + "/upload", tk), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      data: b64,
      mimeType: item.mimeType,
      filename: item.name,
      sessionId: sessionKey,
    }),
  }).then(function (r) { return r.json(); }).then(function (j) {
    if (!j || !j.ok) throw new Error((j && j.error) || "上传失败");
    item.fileInfo = j.fileInfo;
    item.status = "ready";
    return item;
  }).catch(function (e) {
    item.status = "failed";
    item.error = String((e && e.message) || e);
    throw e;
  });
}

/** 重画附件条（缩略图 + 删除按钮）。 */
function renderAttachBar() {
  if (!attachBar) return;
  while (attachBar.firstChild) attachBar.removeChild(attachBar.firstChild);
  for (var i = 0; i < pending_attach.length; i++) {
    (function (item) {
      var box = document.createElement("div");
      box.className = "chat-attach-item" + (item.status === "uploading" ? " uploading" : "")
        + (item.status === "failed" ? " failed" : "");
      box.title = item.status === "failed" ? ("上传失败：" + (item.error || "")) : item.name;
      var img = document.createElement("img");
      img.src = item.dataUrl;
      img.alt = item.name;
      // 浏览器解不了的格式（HEIC 等）画不出缩略图——退成文件名方块，
      // 别让用户看到破图图标还以为是自己传坏了。
      img.onerror = function () {
        img.style.display = "none";
        if (!box.querySelector(".chat-attach-fallback")) {
          var fb = document.createElement("span");
          fb.className = "chat-attach-fallback";
          fb.textContent = (item.name || "").split(".").pop().toUpperCase() || "IMG";
          box.appendChild(fb);
        }
      };
      box.appendChild(img);
      var x = document.createElement("button");
      x.type = "button";
      x.className = "chat-attach-x";
      x.textContent = "×";
      x.setAttribute("aria-label", "移除这张图");
      x.onclick = function () {
        var k = pending_attach.indexOf(item);
        if (k >= 0) pending_attach.splice(k, 1);
        renderAttachBar();
      };
      box.appendChild(x);
      attachBar.appendChild(box);
    })(pending_attach[i]);
  }
}

/** 收文件（来自选择器、粘贴、拖拽）。 */
function acceptFiles(files) {
  var list = Array.prototype.slice.call(files || []);
  if (!list.length) return;
  list.forEach(function (f) {
    if (!f || !/^image\\//.test(f.type || "")) {
      // HEIC 等有时 type 为空——只要文件名像图就试
      if (!/\\.(jpe?g|png|webp|gif|heic|heif|bmp)$/i.test(f.name || "")) return;
    }
    var item = { id: "a" + Date.now() + Math.random().toString(16).slice(2, 6), name: f.name || "image", status: "uploading" };
    pending_attach.push(item);
    renderAttachBar();
    prepareImage(f)
      .then(function (prep) {
        item.dataUrl = prep.dataUrl;
        item.mimeType = prep.mimeType;
        renderAttachBar();
        return tokenAsync(false);
      })
      .then(function (tk) { return uploadAttachment(item, tk); })
      .then(function () { renderAttachBar(); })
      .catch(function (e) {
        item.status = "failed";
        item.error = String((e && e.message) || e);
        renderAttachBar();
      });
  });
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
  msgEls.push({ role: role, body: body, raw: "", restStart: 0 });
  if (stuck) scrollToBottom();
  return msgEls[msgEls.length - 1];
}

/** 给一条消息配一个过程提示槽（**正文之外**，见 chat-status 的注释）。 */
function attachStatusSlot(msg) {
  var el = document.createElement("div");
  el.className = "chat-status";
  el.textContent = "正在思考…";
  // 插在 .chat-body 之前：过程提示在视觉与语义上都不属于答案正文，
  // 放进 body 里会被 renderMessage 当内容、也会被当答案读屏。
  msg.body.parentNode.insertBefore(el, msg.body);
  msg.statusEl = el;
  msg.statusBase = "正在思考…";
  msg.queryStartedAt = Date.now();
  // 本地秒表（2026-10-19 实测）：服务端只在**阶段切换**时推 status，
  // 一次工具调用可能等 60 秒不推帧——秒数会冻在旧值上，看起来又像卡死。
  // 秒数从**本次提问开始**算：用户关心的是「等了多久」。
  if (!msg.statusTick) {
    msg.statusTick = setInterval(function () {
      if (!msg.statusEl || !msg.queryStartedAt) return;
      var secs = Math.round((Date.now() - msg.queryStartedAt) / 1000);
      if (secs < 2) return;
      msg.statusEl.textContent = msg.statusBase + "（" + secs + " 秒）";
    }, 1000);
  }
  return el;
}

/** 把累积的原文重新渲染进消息体（增量解析 + 只追加新块）。
 *
 * 两处「别重算」的克制（2026-10-19 手机端实测「划一下像磕大」）：
 *
 *   ① **续解而不是重解**：parser 返回 restStart，下一轮只把 rest 起点之后
 *      的新文本交回去。整段重解是 O(n²)，长回答到几千字时每来一个 delta
 *      就要把前文重扫一遍，主线程被占满 → 页面滚动掉帧。
 *   ② **不每 delta 动 DOM**：delta 可能一秒来十几个，逐个渲染会让
 *      scrollHeight 读取与 DOM 写入交替发生（layout thrash）。用 rAF 合并，
 *      一帧最多渲染一次。SSE 的最终 done 仍然立刻落盘，不等帧。
 */
function renderMessage(msg, final) {
  var parsed = parseIncremental(msg.raw.slice(msg.restStart || 0));
  for (var i = 0; i < parsed.blocks.length; i++) {
    applyOps(document, msg.body, renderBlockToOps(parsed.blocks[i]), window.katex);
  }
  msg.restStart = (msg.restStart || 0) + parsed.restStart;

  // 尾巴（未闭合）以纯文本预览显示，闭合后会被替换
  if (msg.tailEl) { msg.tailEl.remove(); msg.tailEl = null; }
  if (!final && parsed.rest) {
    var tail = document.createElement("span");
    tail.textContent = parsed.rest;
    tail.className = "chat-tail";
    msg.body.appendChild(tail);
    msg.tailEl = tail;
  } else if (final && parsed.rest) {
    // ⭐ 收尾时还没闭合的尾巴必须**显示出来**（2026-10-19 实测）：
    // 上游常在最后一句中间结束（或其他原因不再有 delta），
    // 只清掉 tailEl 会让最后一截正文凭空消失——用户看到的是半句话。
    // 这里把它当普通段落追加，保证「流结束时面板里的字 >= 已经收到的字」。
    var lastP = document.createElement("p");
    lastP.textContent = parsed.rest;
    msg.body.appendChild(lastP);
    // 追加后把水位推到末尾：这条尾巴已经被"消费"。
    // 不推的话，任何后续解析都会从同一位置再取一遍 rest（2026-10-19 调查
    // 实测的正文重复就是这么来的）。flushRender 现在已幂等，但水位正确是
    // 更底层的保证，不该依赖调用方只调一次。
    msg.restStart = msg.raw.length;
  }
  if (final) msg.body.classList.remove("chat-cursor");
  else msg.body.classList.add("chat-cursor");

  // 最后一道保险（2026-10-19 实测）：收尾时若正文仍是空的、而 raw 里明明
  // 有字，说明解析链在某个边界上把内容全丢了。宁可**降级成纯文本**，
  // 也不能让用户看到一片空白——这比排版难看严重得多。
  if (final && msg.raw && !msg.body.textContent.trim()) {
    msg.body.textContent = msg.raw;
  }

  if (stuck) scrollToBottom();
  else if (!jumpBtn) showJump();
}

/** 合并到下一帧再渲染（同一帧来的多个 delta 只算一次）。 */
function scheduleRender(msg) {
  if (msg.pending) return;
  msg.pending = true;
  var run = function () {
    msg.pending = false;
    if (!msg.done) renderMessage(msg, false);
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 16);
}

/** 立刻渲染并标记收尾（绕过 rAF，保证最终状态不丢）。 */
function flushRender(msg) {
  // ⚠️ 幂等（2026-10-19 调查发现的真 bug）：done 事件会 flush 一次，
  // 随后 SSE 正常结束的 finish() 又 flush 一次；停止分支、error 分支同理。
  //
  // 而 renderMessage(final) 会把**未闭合的尾巴**追加成 <p>（答案最后一行
  // 没有尾换行是最常见的情况），且不推进 restStart ⇒ 第二次 flush 从同一
  // 位置再解析、再追加一遍，正文重复（实测「第二段第二段」）。
  //
  // 收尾只做一次。
  if (msg.done) return;
  msg.done = true;
  renderMessage(msg, true);
}

// ── 思考 ↔ 输出 的区分（2026-10-19 用户要求）───────────────
//
// 面板在模型检索的整段时间里原本完全空白（实测最长 384 秒），用户分不清
// 是卡死还是在干活。这里给每条机器人消息配一行**过程提示**：
//   · 灰色、小号、无气泡，与正文（黑字通栏）在视觉上明确分开
//   · 只在等待期间存在；第一个 delta 到达即移除
//   · 文案说明「在做什么」，而不是只转圈
var TOOL_LABEL = {
  site_search: "检索资料库",
  site_read: "读取页面正文",
  site_index: "查看站点目录",
  site_navigate: "翻到目标页面",
  site_get_page_info: "确认当前页面",
  site_list_images: "查找页面配图",
  site_image: "查看图片",
  site_view: "截图查看版面",
  site_show_symbol: "查符号释义",
  site_panels: "展开折叠内容",
  site_capture_view: "截图查看版面",
};

function setStatus(msg, text) {
  // 过程提示可能已经被 clearStatus 清掉（第一个 delta 到达时就会清）。
  // 撤回场景需要它「回来」，所以这里允许重建——没有槽就补一个。
  if (!msg.statusEl) { attachStatusSlot(msg); if (!msg.statusEl) return; }
  // 秒数一律由本地秒表负责：把服务端可能带的所有「（N 秒）」全剥掉，
  // 否则会出现「…（15 秒）（16 秒）」这种叠字。
  msg.statusBase = String(text).replace(/（\s*\d+\s*秒\s*）/g, "").trim();
  if (!msg.queryStartedAt) msg.queryStartedAt = Date.now();
  msg.statusEl.textContent = msg.statusBase;
}

function clearStatus(msg) {
  if (msg.statusTick) { clearInterval(msg.statusTick); msg.statusTick = null; }
  msg.queryStartedAt = 0;
  if (msg.statusEl && msg.statusEl.parentNode) msg.statusEl.parentNode.removeChild(msg.statusEl);
  msg.statusEl = null;
}

/** 把服务端 status 事件翻成一句人话。**不带秒数**——秒数由本地秒表统一追加。 */
function statusText(ev) {
  var phase = ev && ev.phase;
  var what = ev && ev.tool ? (TOOL_LABEL[ev.tool] || ev.tool) : "";
  if (phase === "thinking") return "正在理解问题…";
  if (phase === "generating") return "正在检索资料并组织回答…";
  if (phase === "tool") return "正在" + (what || "查询") + "…";
  if (phase === "tool-ok") return (what || "查询") + "完成，继续整理…";
  if (phase === "tool-fail") return (what || "查询") + "失败，换一种方式…";
  return null;
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

  // 取走已就绪的附件（上传中的不算——它们还没 fileInfo，发出去等于丢图）
  var ready = [];
  var stillUploading = 0;
  for (var ai = 0; ai < pending_attach.length; ai++) {
    var a = pending_attach[ai];
    if (a.status === "ready" && a.fileInfo) ready.push(a.fileInfo);
    else if (a.status === "uploading") stillUploading += 1;
  }
  pending_attach = pending_attach.filter(function (x) {
    return x.status === "uploading" || x.status === "failed";
  });
  renderAttachBar();
  if (stillUploading && !ready.length && !text) {
    // 只有图还在传、又没写字：别发空消息，等图
    var wait = addMsg("bot");
    wait.body.textContent = "（图片还在上传，稍等一下再发）";
    wait.done = true;
    return;
  }

  var botMsg = addMsg("bot");
  attachStatusSlot(botMsg);
  busy = true;
  if (sendBtn) {
    sendBtn.classList.add("stop");
    sendBtn.disabled = false;
    // ▢ 而不是 ⏹：实心方块在一堆图标里显得过重，且部分安卓字体会画成彩色 emoji
    sendBtn.textContent = "■";
    sendBtn.setAttribute("aria-label", "停止回答");
    sendBtn.title = "停止回答";
  }
  if (attachBtn) attachBtn.disabled = true;
  stream = (typeof AbortController !== "undefined") ? new AbortController() : null;

  var payload = { text: text, sessionId: sessionKey };
  if (ready.length) payload.attachments = ready;
  var body = JSON.stringify(payload);

  /**
   * 停止回答：**两步都要做**，但顺序不能反。
   *
   *   ① POST /chat/cancel —— 让**上游**停下（真正的取消在这里）
   *   ② 断本地 SSE —— 同时断，让面板立刻不再追字
   *
   * ⚠️ 2026-10-19 实测：先 abort 再发 cancel 不行——SSE 一断，
   * 桥那边的 res.on('close') 立刻触发，/chat 的 handler 认为客户端
   * 走了就直接收尾，**再来的 cancel 找不到在飞的提问**（返回 cancelled:false）。
   * 于是上游继续生成、token 照烧，用户看到的「已停止」只是本地假象。
   *
   * 现在：cancel 请求**先发出去**（不等响应），下一拍再 abort。
   * 用 setTimeout(0) 而不是 await —— 取消要立刻生效，不能等网络往返。
   */
  function stopAnswer() {
    if (!busy) return;
    var tk = (function () {
      try { return window.__bridgeToken || localStorage.getItem("webmcp_bridge_token") || ""; } catch (e) { return ""; }
    })();
    var cancelReq = fetch(withToken(BRIDGE + "/chat/cancel", tk), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sessionKey }),
    }).catch(function () { /* 断网也要把本地停掉 */ });
    // 先把 cancel 交出去，再断流。0ms 足够让请求离开事件循环（fetch 同步入队），
    // 又不会让用户感觉「按了没反应」。
    setTimeout(function () {
      if (stream) { try { stream.abort(); } catch (e) { /* 已断 */ } }
    }, 0);
    return cancelReq;
  }
  // 暴露给表单的 submit 处理器（它在 askChat 外面，拿不到闭包里的 stopAnswer）
  stopAnswerRef = stopAnswer;

  /** 发一次 /chat。401/403 时刷新一次 token 再试——桥可能重装过（新 token）。 */
  function attempt(n) {
    return tokenAsync(n > 1).then(function (tk) {
      return fetch(withToken(BRIDGE + "/chat", tk), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body,
        signal: stream ? stream.signal : undefined,
      });
    }).then(function (res) {
      if ((res.status === 401 || res.status === 403) && n === 1) return attempt(2);
      return res;
    });
  }

  attempt(1).then(function (res) {
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
        // 答案已开始：过程提示该退了（思考与输出的分界就在这里）
        clearStatus(botMsg);
        botMsg.raw += String(ev.text || "");
        if (botMsg.raw.length > MAX_MESSAGE_CHARS) botMsg.raw = botMsg.raw.slice(0, MAX_MESSAGE_CHARS);
        scheduleRender(botMsg);
      } else if (ev.type === "status") {
        var s = statusText(ev);
        if (s) setStatus(botMsg, s);
      } else if (ev.type === "done") {
        clearStatus(botMsg);
        // ⚠️ 2026-10-19 实测 bug：done.text 是**完整答案**，不是增量。
        // 旧代码只在 raw 为空时把它塞进 raw，然后又走「续解」路径——
        // 此时 restStart 已经推进到旧文本末尾，raw.slice(restStart) 从
        // 答案中间开始，解析出来的块全乱、面板显示空白（实测流结束、busy 复位、
        // 正文一个字都没有）。
        //
        // 正确处理分两种：
        //   · raw 为空（没走流式）⇒ 用它当全文，restStart 归零后整体渲染
        //   · raw 有值（已流过 delta）⇒ 通常 done.text 是同一份答案的副本；
        //     但**不总是**：流出去的是未清洗原文，done.text 才是 cleanAnswer
        //     之后的版本（think 块、工具调用标记都会在服务端被剥掉）。
        //     2026-10-19 调查实测：先说话再吐 function_calls 时，面板会永久
        //     保留那段 XML。所以这里以 **done.text 为准**重建一次，
        //     而不是只在 raw 为空时才用。
        if (ev.text) {
          var clean = String(ev.text);
          if (clean !== botMsg.raw) {
            botMsg.raw = clean;
            botMsg.restStart = 0;
            while (botMsg.body.firstChild) botMsg.body.removeChild(botMsg.body.firstChild);
            botMsg.tailEl = null;
          }
        }
        flushRender(botMsg);
      } else if (ev.type === "error") {
        clearStatus(botMsg);
        botMsg.raw = botMsg.raw || ("（" + describeFailure(new Error(ev.reason || "未知")) + "）");
        flushRender(botMsg);
      }
      // ev.type === "tool" 不显示
    }
    function finish() {
      clearStatus(botMsg);
      if (!botMsg.raw) {
        botMsg.body.textContent = "（没有收到回答）";
        botMsg.done = true;
      } else {
        flushRender(botMsg);
      }
      busy = false;
      resetSendButton();
      if (attachBtn) attachBtn.disabled = false;
      stream = null;
    }
    return pump();
  }).catch(function (e) {
    clearStatus(botMsg);
    if (e && e.name === "AbortError") {
      // 用户点的「停止」：保留已收到的正文，补一句收尾标记，
      // **不当错误**（否则用户会以为请求失败了）。
      flushRender(botMsg);
      if (!botMsg.raw) {
        botMsg.body.textContent = "（已停止）";
      } else {
        var tail = document.createElement("span");
        tail.className = "chat-stopped";
        tail.textContent = "（已停止）";
        botMsg.body.appendChild(tail);
      }
    } else {
      botMsg.raw = "";
      botMsg.done = true;
      botMsg.body.textContent = "连不上助手（" + describeFailure(e) + "）";
    }
    busy = false;
    resetSendButton();
    if (attachBtn) attachBtn.disabled = false;
    stream = null;
  });
}

/** 把发送按钮恢复成「发送」态（停止与结束共用）。 */
function resetSendButton() {
  if (!sendBtn) return;
  sendBtn.classList.remove("stop");
  sendBtn.disabled = false;
  sendBtn.textContent = "↑";
  sendBtn.setAttribute("aria-label", "发送");
  sendBtn.title = "";
  stopAnswerRef = function () {};
}

/**
 * 把请求失败翻译成人能照着做的句子。
 *
 * HTTP 401 这种原文对用户毫无信息量——它其实意味着「桥在跑但 token 对不上」
 * （桥重装过 / 换了 BRIDGE_TOKEN），处理动作是刷新页面让面板重新握手。
 */
function describeFailure(e) {
  var msg = String((e && e.message) || e);
  var m = msg.match(/^HTTP (\d{3})$/);
  if (m) {
    var code = Number(m[1]);
    if (code === 401 || code === 403) return "本地桥拒绝了这次请求，刷新页面再试（token 可能已更换）";
    if (code === 404) return "本地桥没有 /chat 端点，先更新桥脚本";
    if (code === 413) return "这条消息太长";
  }
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return "本地桥没在运行（先在电脑上跑 node bridge.mjs）";
  }
  return msg;
}

// ── 面板开关 ────────────────────────────────────────────────
function buildPanel() {
  if (panel) return;
  panel = document.createElement("aside");
  panel.id = "chat-panel";
  panel.className = "chat-panel";
  panel.setAttribute("aria-label", "学习助手");

  var head = document.createElement("div");
  head.className = "chat-head";
  var title = document.createElement("span");
  title.className = "chat-title";
  title.textContent = "学习助手";
  var closeBtn = document.createElement("button");
  closeBtn.className = "chat-head-btn";
  closeBtn.setAttribute("aria-label", "关闭");
  // 叉号用 SVG，不用字符：字符 ✕ 在部分安卓字体里会被渲染成彩色 emoji 或偏移基线
  var x = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  x.setAttribute("width", "16"); x.setAttribute("height", "16");
  x.setAttribute("viewBox", "0 0 24 24"); x.setAttribute("fill", "none");
  x.setAttribute("stroke", "currentColor"); x.setAttribute("stroke-width", "2");
  x.setAttribute("stroke-linecap", "round");
  var xp = document.createElementNS("http://www.w3.org/2000/svg", "path");
  xp.setAttribute("d", "M18 6L6 18M6 6l12 12");
  x.appendChild(xp);
  closeBtn.appendChild(x);
  closeBtn.onclick = close;
  head.appendChild(title); head.appendChild(closeBtn);

  logEl = document.createElement("div");
  logEl.className = "chat-log";
  logEl.setAttribute("role", "log");
  logEl.setAttribute("aria-live", "polite");
  logEl.addEventListener("scroll", onUserScroll, { passive: true });
  logEl.addEventListener("wheel", function () { stuck = false; }, { passive: true });
  logEl.addEventListener("touchmove", function () { stuck = false; }, { passive: true });

  var form = document.createElement("form");
  form.className = "chat-input";

  // 附件条（输入区上方）：待发图片缩略图
  attachBar = document.createElement("div");
  attachBar.className = "chat-attach-bar";

  // 隐藏的文件选择器：回形针按钮点它就等价于点「选择文件」
  fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.multiple = true;
  fileInput.style.display = "none";
  fileInput.addEventListener("change", function () {
    acceptFiles(fileInput.files);
    fileInput.value = "";      // 允许连续选同一个文件
  });

  attachBtn = document.createElement("button");
  attachBtn.type = "button";
  attachBtn.className = "chat-attach-btn";
  attachBtn.setAttribute("aria-label", "添加图片");
  attachBtn.title = "添加图片（也可以直接粘贴或拖进来）";
  attachBtn.innerHTML = "";
  (function () {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "18"); svg.setAttribute("height", "18");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round");
    var p1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p1.setAttribute("d", "M21.4 11.6l-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8");
    svg.appendChild(p1);
    attachBtn.appendChild(svg);
  })();
  attachBtn.addEventListener("click", function () { fileInput.click(); });

  inputEl = document.createElement("textarea");
  inputEl.className = "chat-textarea";
  inputEl.rows = 1;
  inputEl.placeholder = "问学习助手…";
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
  // 粘贴图片：截图后直接 Ctrl+V 是最自然的上图方式
  inputEl.addEventListener("paste", function (e) {
    var items = (e.clipboardData && e.clipboardData.items) || [];
    var files = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === "file" && /^image\\//.test(items[i].type)) {
        var f = items[i].getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) { e.preventDefault(); acceptFiles(files); }
  });

  sendBtn = document.createElement("button");
  sendBtn.className = "chat-send";
  sendBtn.type = "submit";
  sendBtn.setAttribute("aria-label", "发送");
  sendBtn.textContent = "↑";
  form.appendChild(attachBtn); form.appendChild(inputEl); form.appendChild(sendBtn);
  form.appendChild(fileInput);
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    // busy 时这个按钮就是「停止」：走真正的取消，不只是断本地流
    if (busy) { stopAnswerRef(); return; }
    sendNow();
  });

  // 拖图进面板 = 附件
  panel.addEventListener("dragover", function (e) {
    if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") < 0) return;
    e.preventDefault();
    panel.classList.add("chat-dragover");
  });
  panel.addEventListener("dragleave", function (e) {
    if (e.target === panel) panel.classList.remove("chat-dragover");
  });
  panel.addEventListener("drop", function (e) {
    panel.classList.remove("chat-dragover");
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    acceptFiles(e.dataTransfer.files);
  });

  panel.appendChild(head);
  panel.appendChild(logEl);
  panel.appendChild(attachBar);
  panel.appendChild(form);

  // 挂载点必须同时满足两件事（2026-10-19 实测桌面档跑到正文上方，就是这里没做对）：
  //   ① **桌面档**要作为 .layout-container 的 flex 子项排在正文右侧（原来挂在
  //      #search-panel 后面 = .main-column 里、.layout-container 之前 ⇒ 横在正文上方）；
  //   ② **手机/中等档**是 position:fixed，祖先不能有 transform / filter / contain:paint，
  //      否则包含块被改，抽屉就不贴视口边。.layout-container 只有 overflow-x:clip，
  //      不建立固定定位包含块。
  // .m3-toc 在 SPA 里会被整块替换，而 panel 是它的**后一个兄弟**，不会跟着被换掉。
  var anchor = document.querySelector(".layout-container .m3-toc");
  if (!anchor) anchor = document.querySelector(".layout-container");
  if (anchor && anchor.parentNode) {
    anchor.parentNode.insertBefore(panel, anchor.nextSibling);
  } else {
    var search = document.getElementById("search-panel");
    (search && search.parentNode ? search.parentNode : document.body).appendChild(panel);
  }

  // 手机抽屉遮罩：与左侧边栏同款手法，点它关面板。
  // 遮罩要 **inset:0 盖全屏**，所以挂在 body 下，避开 .layout-container 的 overflow 裁剪。
  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.className = "chat-backdrop";
    backdrop.addEventListener("click", close);
    document.body.appendChild(backdrop);
  }

  ensureKatex();
}

function sendNow() {
  var t = String(inputEl && inputEl.value || "").trim();
  if (busy) return;
  // 只有图没写字也要能发（「这图里是什么」是最常见的用法，
  // 让人再打一遍字是多余的）。附件里至少一张 ready 就放行。
  var hasReadyImage = false;
  for (var i = 0; i < pending_attach.length; i++) {
    if (pending_attach[i].status === "ready") { hasReadyImage = true; break; }
  }
  if (!t && !hasReadyImage) return;
  // 桥端要求 text 非空（它没法区分「空问题」和「坏包」）。只发图时补一个问题——
  // 上游对「图里有什么」这类极简问法配合度最高（实测比任务式描述更少被拦）。
  if (!t) t = "图里有什么？";
  inputEl.value = "";
  inputEl.style.height = "auto";
  askChat(t.slice(0, MAX_MESSAGE_CHARS));
}

function showEmpty() {
  var box = document.createElement("div");
  box.className = "chat-empty";
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
  var btn = document.getElementById("assistant-toggle");
  if (btn) btn.setAttribute("aria-expanded", "true");
  if (logEl && !logEl.children.length) showEmpty();
  // 手机上不自动抢焦点：会立刻弹键盘，把抽屉顶成半屏
  if (inputEl && !(window.innerWidth <= 860)) inputEl.focus();
  stuck = true;
  scrollToBottom();
}

function close() {
  open = false;
  document.body.classList.remove("chat-open");
  var btn = document.getElementById("assistant-toggle");
  if (btn) btn.setAttribute("aria-expanded", "false");
  if (inputEl) inputEl.blur();
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
