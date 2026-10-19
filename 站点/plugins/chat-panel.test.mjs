// chat-panel.test.mjs —— 面板的挂载层与字符串完整性测试。
//
// 渲染逻辑的纯部分在 chat-render.test.mjs；这里测「op → DOM」与「内联字符串」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, renderMathInto, CHAT_JS, CHAT_CSS } from './chat-panel.mjs';

// ── 最小假 DOM ─────────────────────────────────────────────

function makeDoc() {
  function node(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      children: [],
      childNodes: [],
      attrs: {},
      className: '',
      style: {},
      _text: '',
      set textContent(v) { this._text = String(v); this.childNodes = []; this.children = []; },
      get textContent() { return this._text || this.childNodes.map((c) => c.textContent || '').join(''); },
      set innerHTML(v) { this._html = String(v); },
      get innerHTML() { return this._html || ''; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k] !== undefined ? this.attrs[k] : null; },
      appendChild(c) { this.children.push(c); this.childNodes.push(c); this._text = ''; return c; },
      remove() {},
      addEventListener() {},
    };
  }
  return {
    createElement: (t) => node(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t), children: [] }),
  };
}

// ── applyOps ───────────────────────────────────────────────

test('applyOps：段落与粗体建出正确节点', () => {
  const doc = makeDoc();
  const root = doc.createElement('div');
  applyOps(doc, root, [{
    kind: 'para',
    ops: [{ kind: 'text', text: '这是' }, { kind: 'strong', text: '重点' }],
  }], null);
  assert.equal(root.children.length, 1);
  const p = root.children[0];
  assert.equal(p.tagName, 'P');
  assert.equal(p.children.length, 2);
  assert.equal(p.children[1].tagName, 'STRONG');
  assert.equal(p.children[1].textContent, '重点');
});

test('applyOps：代码块用 textContent（不走 innerHTML）', () => {
  const doc = makeDoc();
  const root = doc.createElement('div');
  applyOps(doc, root, [{ kind: 'codeblock', lang: 'js', text: '<script>alert(1)</script>' }], null);
  const pre = root.children[0];
  assert.equal(pre.tagName, 'PRE');
  const code = pre.children[0];
  assert.equal(code.tagName, 'CODE');
  assert.equal(code.textContent, '<script>alert(1)</script>');
  assert.equal(code.innerHTML, '', '代码块不该走 innerHTML');
});

test('applyOps：列表、表格、标题', () => {
  const doc = makeDoc();
  const root = doc.createElement('div');
  applyOps(doc, root, [
    { kind: 'heading', level: 2, ops: [{ kind: 'text', text: '标题' }] },
    { kind: 'list', ordered: true, items: [[{ kind: 'text', text: '甲' }], [{ kind: 'text', text: '乙' }]] },
    { kind: 'table', header: [[{ kind: 'text', text: 'A' }]], rows: [[[{ kind: 'text', text: '1' }]]] },
  ], null);
  assert.equal(root.children[0].tagName, 'H2');
  assert.equal(root.children[1].tagName, 'OL');
  assert.equal(root.children[1].children.length, 2);
  assert.equal(root.children[2].tagName, 'TABLE');
});

test('applyOps：链接外链加 target=_blank 与 rel', () => {
  const doc = makeDoc();
  const root = doc.createElement('div');
  applyOps(doc, root, [{
    kind: 'para',
    ops: [{ kind: 'link', href: 'https://example.com', text: '外链' }],
  }], null);
  const a = root.children[0].children[0];
  assert.equal(a.tagName, 'A');
  assert.equal(a.attrs.href, 'https://example.com');
  assert.equal(a.attrs.target, '_blank');
  assert.match(a.attrs.rel, /noopener/);
});

test('applyOps：站内链接不加 target', () => {
  const doc = makeDoc();
  const root = doc.createElement('div');
  applyOps(doc, root, [{
    kind: 'para',
    ops: [{ kind: 'link', href: '#sec-1', text: '本节' }],
  }], null);
  const a = root.children[0].children[0];
  assert.equal(a.attrs.target, undefined);
});

// ── 公式安全 ───────────────────────────────────────────────

test('renderMathInto：无 KaTeX 时退化成纯文本（不注入）', () => {
  const doc = makeDoc();
  const n = doc.createElement('span');
  renderMathInto(doc, n, 'x^2', false, null);
  assert.equal(n.textContent, '$x^2$');
  assert.equal(n.innerHTML, '', '没有 KaTeX 不该产生 HTML');
});

test('renderMathInto：有 KaTeX 时用它的产出填 innerHTML', () => {
  const doc = makeDoc();
  const n = doc.createElement('span');
  const fakeKatex = {
    renderToString: (tex, opts) => {
      assert.equal(opts.trust, false, 'trust 必须是 false');
      assert.equal(opts.throwOnError, false);
      assert.ok(opts.maxSize > 0);
      assert.ok(opts.maxExpand > 0);
      return '<span class="katex">' + tex + '</span>';
    },
  };
  renderMathInto(doc, n, 'x^2', false, fakeKatex);
  assert.match(n.innerHTML, /class="katex"/);
});

test('renderMathInto：KaTeX 抛错时错误走 textContent（不注入错误串）', () => {
  const doc = makeDoc();
  const n = doc.createElement('span');
  const boom = { renderToString: () => { throw new Error('<img src=x onerror=alert(1)>'); } };
  renderMathInto(doc, n, 'bad', false, boom);
  assert.equal(n.innerHTML, '', '错误串绝不能进 innerHTML');
  assert.match(n.textContent, /onerror/);
  assert.match(n.className, /chat-math-err/);
});

// ── 字符串完整性 ───────────────────────────────────────────

test('CHAT_JS：语法可解析', () => {
  assert.doesNotThrow(() => new Function(CHAT_JS));
});

test('CHAT_JS：内联了全部依赖（含 renderBlockToOps 间接调用的辅助函数）', () => {
  // 2026-10-19 在真实浏览器踩到：parseInline/safeHref/safeSrc 没内联，
  // 页面报 "parseInline is not defined"。这条守住全部传递依赖。
  const deps = [
    'parseIncremental', 'parseInline', 'renderBlockToOps', 'applyOps', 'renderMathInto',
    'safeHref', 'safeSrc', 'isMathOpen', 'findClosingDollar', 'splitRow', 'MAX_MESSAGE_CHARS',
  ];
  for (const fn of deps) {
    assert.ok(CHAT_JS.includes('var ' + fn + ' = '), '缺内联依赖 ' + fn);
  }
});

test('CHAT_JS：不含危险的内联事件或 eval', () => {
  assert.doesNotMatch(CHAT_JS, /\beval\s*\(/);
  assert.doesNotMatch(CHAT_JS, /document\.write/);
});

test('CHAT_JS：只有一处 innerHTML，且在 renderMathInto 里', () => {
  const hits = (CHAT_JS.match(/\.innerHTML\s*=/g) || []).length;
  // renderMathInto 里一处；showEmpty 里的 box.innerHTML = "" 是清空（安全）
  assert.ok(hits <= 2, 'innerHTML 赋值应极少（实际 ' + hits + ' 处）');
  // 关键：渲染公式那一处必须存在
  assert.match(CHAT_JS, /node\.innerHTML = html/);
});

test('CHAT_JS：SSE 走 fetch + ReadableStream（EventSource 不能设 header）', () => {
  assert.match(CHAT_JS, /getReader\(\)/);
  assert.match(CHAT_JS, /\/chat/);
});

test('CHAT_JS：暴露 window.__chatPanel 与 __chatSync', () => {
  assert.match(CHAT_JS, /window\.__chatPanel/);
  assert.match(CHAT_JS, /window\.__chatSync/);
});

test('CHAT_JS：与 TOC 互斥用 body.chat-open 类', () => {
  assert.match(CHAT_JS, /chat-open/);
  assert.match(CHAT_CSS, /body\.chat-open \.m3-toc\s*\{\s*display:\s*none/);
});

test('CHAT_CSS：三档布局断点齐全', () => {
  assert.match(CHAT_CSS, /min-width:\s*1201px/);
  assert.match(CHAT_CSS, /min-width:\s*861px\) and \(max-width:\s*1200px/);
  assert.match(CHAT_CSS, /max-width:\s*860px/);
});

test('CHAT_CSS：用站点语义色，不写死颜色', () => {
  assert.match(CHAT_CSS, /--md-sys-color-primary/);
  // 除了 KaTeX 错误色回退值，不应出现大量硬编码 hex
  const hexes = (CHAT_CSS.match(/#[0-9a-fA-F]{3,6}\b/g) || []);
  assert.ok(hexes.length <= 2, '硬编码颜色应极少（实际 ' + hexes.length + '）');
});

test('CHAT_CSS：输入框字号 ≥16px（iOS 防缩放）', () => {
  const m = CHAT_CSS.match(/\.chat-textarea[\s\S]*?font-size:\s*(\d+)px/);
  assert.ok(m, '缺 textarea font-size');
  assert.ok(Number(m[1]) >= 16, 'iOS 会自动放大 <16px 的输入框');
});

test('CHAT_CSS：宽内容横向滚动（240px 下表格/公式会溢出）', () => {
  assert.match(CHAT_CSS, /\.chat-body table[\s\S]*?overflow-x:\s*auto/);
  assert.match(CHAT_CSS, /katex-display[\s\S]*?overflow-x:\s*auto/);
});

test('CHAT_CSS：尊重 prefers-reduced-motion', () => {
  assert.match(CHAT_CSS, /prefers-reduced-motion/);
});

// ── 手机档是右侧抽屉（2026-10-19 用户定案）─────────────────

test('CHAT_CSS：手机档是右侧抽屉，不是底部窗口', () => {
  // 原来 height:70dvh + bottom:var(--chat-kb-inset) 会随 URL 栏/键盘每帧改布局，
  // 用户在手机上「划一下像磕大」。改成与左侧边栏同款 fixed + translateX 抽屉。
  assert.doesNotMatch(CHAT_CSS, /70dvh/, '底部窗口已废弃');
  assert.doesNotMatch(CHAT_CSS, /--chat-kb-inset/, '键盘内缩变量已废弃');
  const mobile = CHAT_CSS.slice(CHAT_CSS.indexOf('@media (max-width: 860px)'));
  assert.match(mobile, /position:\s*fixed/);
  assert.match(mobile, /transform:\s*translateX\(100%\)/, '收起态要滑到视口外');
  assert.match(mobile, /visibility:\s*hidden/, '收起态要不可聚焦');
  assert.match(mobile, /pointer-events:\s*none/, '收起态不能吃点击');
});

test('CHAT_CSS：不允许出现会覆盖手机档 fixed 的无条件 position', () => {
  // 2026-10-19 实测：媒体查询之后再写一条 `.chat-panel { position: relative }`
  // （给 .chat-jump 做包含块用的）会以同特异度覆盖手机档的 fixed，
  // 抽屉退回文档流、贴着正文顶部——浏览器里表现为「面板横在正文上方」。
  for (const m of CHAT_CSS.matchAll(/^\.chat-panel\s*\{([^}]*)\}/gm)) {
    assert.doesNotMatch(m[1], /position\s*:/, '无条件 .chat-panel 规则里不能写 position');
  }
});

test('CHAT_JS：面板挂到 .layout-container 内，遮罩挂 body', () => {
  // 桌面档面板是 flex 子项，必须排在正文右侧（挂在 .main-column 里会横在正文上方）；
  // 手机档遮罩要盖全屏，挂在 body 才不会被 overflow 裁剪。
  assert.match(CHAT_JS, /\.layout-container \.m3-toc/, '桌面档要以 TOC 为锚点插入');
  assert.match(CHAT_JS, /document\.body\.appendChild\(backdrop\)/, '遮罩要挂 body');
});

test('CHAT_JS：流式渲染续解 + 帧合并', () => {
  // ① 续解：用 parser 返回的 restStart 只解未闭合的尾巴，否则长回答是 O(n²)
  assert.match(CHAT_JS, /msg\.raw\.slice\(msg\.restStart/, '必须只交未解析的尾巴');
  // ② 帧合并：delta 用 scheduleRender（rAF），收尾用 flushRender
  assert.match(CHAT_JS, /function scheduleRender/);
  assert.match(CHAT_JS, /requestAnimationFrame/);
  assert.match(CHAT_JS, /function flushRender/);
});

test('CHAT_JS：面板自称学习助手，不出现豆姐', () => {
  assert.match(CHAT_JS, /学习助手/);
  assert.doesNotMatch(CHAT_JS, /豆姐/);
  assert.doesNotMatch(CHAT_JS, /豆包/);
});

// ── 思考 ↔ 输出 的区分（2026-10-19 用户要求）───────────────

test('CHAT_JS：有 status 事件通道，且与 delta 分开处理', () => {
  // 用户原话：「做成思考与输出有区分的」。模型检索期间面板原本完全空白
  // （实测最长 384 秒），用户分不清卡死还是在干活。
  assert.match(CHAT_JS, /ev\.type === "status"/, '要处理 status 事件');
  assert.match(CHAT_JS, /function attachStatusSlot/, '要能插入过程提示');
  assert.match(CHAT_JS, /function clearStatus/, '答案到达要能清掉过程提示');
});

test('CHAT_JS：过程提示不能混进最终答案文本', () => {
  // status 只写 statusEl，绝不写 msg.raw —— 否则会被当成答案渲染/持久化。
  const setStatus = CHAT_JS.slice(
    CHAT_JS.indexOf('function setStatus'),
    CHAT_JS.indexOf('function clearStatus'),
  );
  assert.ok(setStatus.length > 0);
  assert.doesNotMatch(setStatus, /\.raw/, 'status 不许碰 msg.raw');
});

test('CHAT_JS：delta 到达先清过程提示（思考与输出的分界）', () => {
  const delta = CHAT_JS.slice(
    CHAT_JS.indexOf('ev.type === "delta"'),
    CHAT_JS.indexOf('ev.type === "status"'),
  );
  assert.match(delta, /clearStatus\(botMsg\)/, '第一个 delta 就该清掉过程提示');
});

test('CHAT_CSS：过程提示在视觉上与正文分开', () => {
  assert.match(CHAT_CSS, /\.chat-status[\s\S]*?font-style:\s*italic/, '过程提示要斜体');
  assert.match(CHAT_CSS, /\.chat-status[\s\S]*?on-surface-variant/, '过程提示要用弱化色');
});

test('CHAT_JS：失败原因翻译成人话', () => {
  assert.match(CHAT_JS, /function describeFailure/);
  assert.match(CHAT_JS, /本地桥没在运行/, '连不上要说清是桥没起');
  assert.match(CHAT_JS, /刷新页面再试/, '401/403 要给出可执行动作');
});
