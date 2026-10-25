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
  // 表格外面多了一层滚动容器（2026-10-19：overflow 不能挂在 table 上，
  // 否则边框盒撑满容器而列按内容宽，右侧留白）
  const wrap = root.children[2];
  assert.equal(wrap.tagName, 'DIV');
  assert.equal(wrap.className, 'chat-table-wrap');
  assert.equal(wrap.children[0].tagName, 'TABLE');
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

// ── 联网开关 ↔ 附件互斥（2026-10-25，官方语义照抄）──────────────
//
// 实测（.zcode/会话语义/实测-多会话与联网-20261025.md §五）：
// 官方开启联网时给附件加 disabled 属性 + cursor:not-allowed，
// **没有** .disabled 类、不改 pointer-events、不置灰。
// 这组测试钉住「我们照抄的是同一个判据」，防止将来有人改用 class。

test('联网按钮存在于 CHAT_JS（构造 + 点击绑定）', () => {
  assert.ok(CHAT_JS.includes('chat-web-btn'), '联网按钮的 class 必须在');
  assert.ok(CHAT_JS.includes('"联网搜索"'), '要有 aria-label');
  assert.match(CHAT_JS, /webBtn\.addEventListener\("click"/, '点击要绑 setWebSearch');
});

test('互斥判据是 disabled 属性，不是 class（照抄官方）', () => {
  // 找到 setWebSearch 的函数体
  const i = CHAT_JS.indexOf('function setWebSearch');
  assert.ok(i > 0, 'setWebSearch 必须在');
  const body = CHAT_JS.slice(i, CHAT_JS.indexOf('\n  }', i) + 4);
  assert.match(body, /attachBtn\.disabled = true/, '开启联网要设 disabled 属性');
  assert.match(body, /attachBtn\.disabled = false/, '关闭联网要清 disabled 属性');
  assert.doesNotMatch(body, /classList\.(add|remove)\(["']disabled/, '不许改用 .disabled 类');
  assert.doesNotMatch(body, /pointerEvents/, '不许改 pointer-events（官方没改）');
});

test('联网按钮用 active 类 + aria-pressed 表示开启（与官方 .tool-button.active 同判据）', () => {
  const i = CHAT_JS.indexOf('function setWebSearch');
  const body = CHAT_JS.slice(i, CHAT_JS.indexOf('\n  }', i) + 4);
  assert.match(body, /classList\.toggle\("active"/, '开启态用 active 类');
  assert.match(body, /aria-pressed/, '无障碍状态要同步');
});

test('附件按钮排在联网按钮之前（与官方同一行、顺序一致）', () => {
  const i = CHAT_JS.indexOf('form.appendChild(attachBtn)');
  assert.ok(i > 0);
  const line = CHAT_JS.slice(i, i + 120);   // 同一行：attach → web → input → send
  assert.ok(line.indexOf('attachBtn') < line.indexOf('webBtn'), '附件在联网左边');
  assert.ok(line.indexOf('webBtn') < line.indexOf('inputEl'), '联网在输入框左边');
});

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

// ── 宽度拖拽（2026-10-20，与左侧边栏同一套手法）─────────────────

test('CHAT_CSS：桌面档宽用 --chat-width 变量，不再写死 --toc-width', () => {
  const desktop = CHAT_CSS.match(/@media \(min-width:\s*1201px\)\s*\{[\s\S]*?\n\}/);
  assert.ok(desktop, '缺桌面档媒体查询');
  assert.match(desktop[0], /width:\s*var\(--chat-width\)/, '桌面档宽应来自可改变的变量');
  assert.match(CHAT_CSS, /:root\s*\{\s*--chat-width:/, '缺 --chat-width 定义');
});

test('CHAT_CSS：拖拽手柄有命中区与视觉反馈，且只在桌面档显示', () => {
  const m = CHAT_CSS.match(/\.chat-resizer\s*\{[\s\S]*?\n\}/);
  assert.ok(m, '缺 .chat-resizer 样式');
  assert.match(m[0], /cursor:\s*col-resize/);
  assert.match(m[0], /position:\s*absolute/);
  assert.match(m[0], /left:\s*-3px/, '右侧面板的手柄应贴左缘');
  assert.match(m[0], /display:\s*none/, '默认隐藏，由桌面档打开');
  assert.match(CHAT_CSS, /\.chat-resizer:hover[\s\S]*?background-color/, '缺悬停反馈');
  assert.match(CHAT_CSS, /body\.chat-resizing[\s\S]*?cursor:\s*col-resize/, '拖拽期应全局竖光标');
  assert.match(CHAT_CSS, /body\.chat-resizing \.chat-panel\s*\{[\s\S]*?transition:\s*none/, '拖拽期应掐掉过渡');
});

test('CHAT_CSS：手机档仍用 fixed（手柄的 absolute 不得反客为主）', () => {
  const mobile = CHAT_CSS.match(/@media \(max-width:\s*860px\)\s*\{[\s\S]*?\n\}\n/);
  assert.ok(mobile, '缺手机档媒体查询');
  assert.match(mobile[0], /position:\s*fixed/, '手机档必须是 fixed 抽屉');
  // 无条件的 .chat-panel { position: relative } 会覆盖上面这条（同特异度后者胜）
  assert.doesNotMatch(CHAT_CSS, /^\.chat-panel\s*\{[^}]*position:\s*relative/m,
    '不得有覆盖手机档的无条件 position:relative');
});

test('CHAT_JS：拖拽方向与左栏相反、宽度夹在合法区间、双击复位', () => {
  // 右侧面板往左拖是变宽 ⇒ startX - clientX
  assert.match(CHAT_JS, /startW \+ \(startX - e\.clientX\)/, '拖拽方向应取负（右栏特性）');
  assert.match(CHAT_JS, /CHAT_W_MIN/);
  assert.match(CHAT_JS, /CHAT_W_MAX/);
  assert.match(CHAT_JS, /dblclick/);
  assert.match(CHAT_JS, /shirone-chat-width/, '宽度要记住');
  assert.match(CHAT_JS, /localStorage\.setItem/, '宽度要落 localStorage');
});

test('CHAT_JS：宽屏恢复记忆值，窄屏不施加（手机档不用这个变量）', () => {
  const fn = CHAT_JS.match(/function restoreChatWidth\([\s\S]*?\n\}/);
  assert.ok(fn, '缺 restoreChatWidth');
  assert.match(fn[0], /innerWidth <= 860\) return/, '窄屏直接跳过');
  assert.match(CHAT_JS, /restoreChatWidth\(\)/, 'openPanel 里要调用');
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
  // 允许的硬编码只有两类，且都写成"带主题回退"的形式：
  //   · var(--md-sys-color-error, #b3261e) —— 主题变量缺失时的错误色回退
  //   · color-mix(in srgb, #000 …)        —— 叠在任意图片上的半透明黑
  // 除此之外任何写死的颜色都算主题失守。
  const hexes = (CHAT_CSS.match(/#[0-9a-fA-F]{3,6}\b/g) || []);
  const allowed = hexes.filter((h) => h === '#b3261e' || h === '#000');
  assert.equal(hexes.length, allowed.length,
    '出现未被允许的硬编码颜色：' + hexes.filter((h) => !allowed.includes(h)).join(', '));
});

test('CHAT_CSS：输入框字号 ≥16px（iOS 防缩放）', () => {
  const m = CHAT_CSS.match(/\.chat-textarea[\s\S]*?font-size:\s*(\d+)px/);
  assert.ok(m, '缺 textarea font-size');
  assert.ok(Number(m[1]) >= 16, 'iOS 会自动放大 <16px 的输入框');
});

test('CHAT_CSS：宽内容横向滚动（240px 下表格/公式会溢出）', () => {
  // 表格的横滚挂在包裹层上，不挂在 table 本身（2026-10-19 截图实测：
  // overflow 挂 table 时边框盒撑满容器、列却按内容宽，右侧留白）。
  assert.match(CHAT_CSS, /\.chat-table-wrap[\s\S]*?overflow-x:\s*auto/);
  assert.match(CHAT_CSS, /katex-display[\s\S]*?overflow-x:\s*auto/);
});

test('CHAT_CSS：表格观感与站点正文一致（表头分区 / 行线 / 斑马纹）', () => {
  // 用户报「这个表格不美观」。原来四边全框 + 0.25rem padding，像一堆格子。
  assert.match(CHAT_CSS, /\.chat-body th[\s\S]*?surface-container/, '表头要有底色');
  assert.match(CHAT_CSS, /\.chat-body tr:last-child td\s*\{\s*border-bottom:\s*none/, '末行不要多余底边');
  assert.match(CHAT_CSS, /tbody tr:nth-child\(even\)/, '要有斑马纹');
  // 单元格不再四边全框
  assert.match(CHAT_CSS, /\.chat-body th, \.chat-body td[\s\S]*?border:\s*none/);
});

test('CHAT_JS：表格包在 .chat-table-wrap 里（让列宽与外框对齐）', () => {
  assert.match(CHAT_JS, /chat-table-wrap/);
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

// ── 模板串吃掉正则转义的泛化守卫（2026-10-24，第六坑后收口）─────────
//
// 坑的机理：`*_JS` 导出是普通模板串，源码里写单反斜杠 s/d/w，模板串求值时会把
// 单个反斜杠当转义吃掉，产物正则变成 /（s*d+s*秒s*）/——第五坑（HTTP 的 d{3}）、
// 第六坑（秒表叠字）同一个机理。单点守卫只能护住已知那一条；这里泛化为扫描
// **全部** *_JS 模板串导出的 cooked 产物：把每个产物当 JS 逐字符走一遍（跳过
// 字符串、注释、模板串——裸串全扫会把注释里的 **加粗**、代码里的 fails++、
// 字符串里的 LaTeX end{ 全误伤成命中），抠出全部正则字面量，体内出现
// 「字母 s/d/w 后跟量词（* + {）且字母前无反斜杠」即红。免疫对照（η 审计已证）：
//   · 源里写双反斜杠 d{3} ⇒ 产物字母前有反斜杠，不报；
//   · toString 插值路径（chat-render 等函数源码）字节原样，转义带着反斜杠进来，不报。
// 已知保守性：正则/除号的判别用的是「前一个 token」启发式，误判只会**漏报**
// （把正则当除号跳过），不会误报；模板串里的嵌套插值同理。守卫宁可漏不可错杀。

function scanEatenRegexEscapes(code) {
  const hits = [];
  const n = code.length;
  const KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of',
    'case', 'delete', 'void', 'throw', 'new', 'do', 'else', 'yield', 'await']);
  let i = 0, line = 1, prevWord = '', prevChar = '';
  while (i < n) {
    const c = code[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && code[i + 1] === '/') { while (i < n && code[i] !== '\n') i++; continue; }
    if (c === '/' && code[i + 1] === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) { if (code[i] === '\n') line++; i++; }
      i += 2; continue;
    }
    if (c === '"' || c === "'") { // 字符串：整段跳过
      const q = c; i++;
      while (i < n && code[i] !== q) { if (code[i] === '\\') i++; else if (code[i] === '\n') line++; i++; }
      i++; prevWord = ''; prevChar = '"'; continue;
    }
    if (c === '`') { // 模板串：产物里目前只在 toString 注入段出现，防御性跳过
      i++;
      while (i < n && code[i] !== '`') { if (code[i] === '\\') i++; else if (code[i] === '\n') line++; i++; }
      i++; prevWord = ''; prevChar = '"'; continue;
    }
    if (/[A-Za-z0-9_$]/.test(c)) { // 标识符/关键字/数字——其后紧跟的 / 按除号处理
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(code[j])) j++;
      prevWord = code.slice(i, j); prevChar = '';
      i = j; continue;
    }
    if (c === '/') {
      // 除号 vs 正则开头：前一个是普通标识符/数字/右括号/右方括号/字符串 ⇒ 除号
      const isRegex = (prevWord !== '' && KEYWORDS.has(prevWord))
        || (prevWord === '' && prevChar !== ')' && prevChar !== ']' && prevChar !== '"');
      if (!isRegex) { prevWord = ''; prevChar = '/'; i++; continue; }
      const startLine = line;
      let j = i + 1, inClass = false;
      while (j < n) { // 正则体：到未转义的 / 为止；字符类里的 / 不算结束
        const d = code[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') { line++; j++; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        j++;
      }
      const body = code.slice(i + 1, j);
      // 体内扫描：字母前有反斜杠 ⇒ 免疫；字符类内部不算（类里的字母是字面字符，
      // 量词跟不到它头上，[d*] 是合法写法）
      let cls = false;
      for (let k = 0; k < body.length; k++) {
        const b = body[k];
        if (b === '\\') { k++; continue; }
        if (b === '[') { cls = true; continue; }
        if (b === ']') { cls = false; continue; }
        if (!cls && (b === 's' || b === 'd' || b === 'w')
          && (body[k + 1] === '*' || body[k + 1] === '+' || body[k + 1] === '{')) {
          hits.push({ line: startLine, body });
          break;
        }
      }
      i = j + 1; prevWord = ''; prevChar = '"'; continue;
    }
    prevWord = ''; prevChar = c; i++;
  }
  return hits;
}

test('全部 *_JS 产物：正则字面量里没有裸 s/d/w 转义（泛化扫描）', async () => {
  // 导出清单动态发现（读源码找 export const *_JS =），新加的插件模板串自动进扫描。
  // 这些模块 build.mjs 在 Node 里都要 import，天然无 DOM 依赖，测试里 import 是安全的。
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('.', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));
  const offenders = [];
  const seen = [];
  for (const f of files) {
    const names = [...readFileSync(new URL(f, dir), 'utf8').matchAll(/export const (\w+_JS)\s*=/g)]
      .map((m) => m[1]);
    if (!names.length) continue;
    const mod = await import('./' + f);
    for (const name of names) {
      const cooked = mod[name];
      if (typeof cooked !== 'string') { offenders.push(f + ' 的 ' + name + ' 不是字符串'); continue; }
      seen.push(name);
      for (const hit of scanEatenRegexEscapes(cooked)) {
        offenders.push(name + '（' + f + '）产物第 ' + hit.line + ' 行正则 /' + hit.body + '/');
      }
    }
  }
  // 清单健全性：主干导出必须在场，防止「目录读空导致假绿」
  for (const must of ['CHAT_JS', 'WEBMCP_TOOLS_JS', 'SPA_ROUTER_JS', 'PAGE_BRIDGE_JS', 'DRAWER_SYNC_JS']) {
    assert.ok(seen.includes(must), '导出清单异常，缺 ' + must + '（实际：' + seen.join(', ') + '）');
  }
  assert.deepEqual(offenders, [],
    '模板串吃掉了正则转义（字母 s/d/w 前无反斜杠，源码应写双反斜杠）：\n' + offenders.join('\n'));
});

test('CHAT_JS：秒表正则能剥掉服务端带的秒数（第六坑修复的行为验证）', () => {
  // 抠出 setStatus 里 replace(/（…）/g 那条正则，用真实叠字样例跑一遍。
  // 修复前产物是 /（s*d+s*秒s*）/：一个「（N 秒）」也剥不掉，秒数会一直叠下去。
  const m = CHAT_JS.match(/replace\((\/（.*?秒.*?\/)g/);
  assert.ok(m, '应能抠出秒表正则');
  const re = new RegExp(m[1].slice(1, -1), 'g');
  assert.equal('正在思考（15 秒）（16 秒）'.replace(re, ''), '正在思考', '两个秒数都得剥掉');
  assert.equal('正在检索资料'.replace(re, ''), '正在检索资料', '没带秒数时不得误伤正文');
});

test('CHAT_JS：状态码正则能匹配 HTTP 429/401（第五坑的行为回归）', () => {
  // 字符形态的把关已由上面的泛化扫描接管；这里只留行为验证：抠出正则真跑一次。
  const m = CHAT_JS.match(/msg\.match\((\/\^HTTP[^)]*\)\$?\/)\)/);
  assert.ok(m, '应能抠出状态码正则');
  const re = new RegExp(m[1].slice(1, -1));
  assert.equal(re.test('HTTP 429'), true, '必须能匹配 HTTP 429');
  assert.equal(re.test('HTTP 401'), true, '必须能匹配 HTTP 401');
});

test('CHAT_JS：失败原因翻译成人话', () => {
  assert.match(CHAT_JS, /function describeFailure/);
  // 2026-10-22 更正：旧断言钉的是「本地桥没在运行（跑 node bridge.mjs）」，
  // 而那个脚本在两阶段重构后已不存在——断言把一句**做不到的指引**钉成了契约。
  // 现在钉的是：连不上时要指向用户真能做到的动作（检查油猴脚本）。
  assert.match(CHAT_JS, /连不上助手[^"'\n]*油猴/, '连不上要指向可执行动作（检查油猴脚本）');
  // 只查**用户看得到的字符串**（return/ textContent 那几句），不查注释——
  // 注释里保留「以前写 node bridge.mjs」是有意为之的考古说明。
  const userFacing = CHAT_JS.split('\n')
    .filter((l) => /return\s+["']|textContent\s*=/.test(l))
    .join('\n');
  assert.ok(!/node bridge\.mjs/.test(userFacing), '不得再向用户提示跑已废弃的 bridge.mjs');
  assert.match(CHAT_JS, /刷新页面再试/, '401/403 要给出可执行动作');
});

// ── 模板字符串陷阱（2026-10-19，同一类错误犯了四次）───────────────
//
// CHAT_JS 是用反引号模板串生成的：整段客户端 IIFE 都在这一个字符串里。
// 因此**注释里也不能出现反引号**——它会提前闭合模板串，报的却是
// "Unexpected identifier"，指向的行往往离真正的问题很远。
// 这个坑在本轮改了四次代码、踩了四次，每次都要重新定位（反引号一律写成中文引号）。
//
// 判据：CHAT_JS 已经是个字符串了，源码里不该再有裸反引号；而产出的
// 字符串本身必须能解析（下面的测试已经在做）。
test('CHAT_JS：模板串内没有裸反引号（会提前闭合模板）', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('./chat-panel.mjs', import.meta.url), 'utf8');
  const start = src.indexOf('export const CHAT_JS = `');
  const end = src.indexOf('})();`;', start);
  assert.ok(start > 0 && end > start, '找不到 CHAT_JS 模板串边界');
  // 第一行是模板串的开始标记（export const CHAT_JS = `），它本来就该有反引号
  const body = src.slice(start, end).split('\n').slice(1);
  const offenders = [];
  body.forEach((line, i) => {
    // 去掉 ${...} 插值后再找反引号
    const stripped = line.replace(/\$\{[^}]*\}/g, '');
    if (stripped.includes('`')) offenders.push(`${i + 1}: ${line.trim().slice(0, 60)}`);
  });
  assert.deepEqual(offenders, [], '模板串内出现反引号，会提前闭合：\n' + offenders.join('\n'));
});

// ── 本机守卫（2026-10-19 审计修复）──────────────────────────
//
// 审计发现：页面桥有 loopback 判断（webmcp-loader 的 shouldBridge），
// 但**助手面板漏了** —— BRIDGE 是硬编码常量，文件里没有任何 hostname 检查。
// 线上访客点助手会去请求 127.0.0.1:9345，语义上是「公网页面探测访问者本机服务」。
//
// 判据：三个出站路径（/chat、/upload、/bootstrap）都必须先看 LOCAL_ONLY。

test('本机守卫：LOCAL_ONLY 存在且按 hostname 判断', () => {
  assert.match(CHAT_JS, /var LOCAL_ONLY = \(function \(\)/);
  assert.match(CHAT_JS, /location\.hostname/);
  // 三种回环写法都要认
  for (const h of ['127.0.0.1', 'localhost', '::1']) {
    assert.ok(CHAT_JS.includes(h), 'LOCAL_ONLY 缺 ' + h);
  }
});

test('本机守卫：非本机时 tokenAsync 不请求 127.0.0.1', () => {
  const fn = CHAT_JS.slice(CHAT_JS.indexOf('function tokenAsync'), CHAT_JS.indexOf('function withToken'));
  assert.match(fn, /if \(!LOCAL_ONLY\) return resolve\(""\)/, 'tokenAsync 要先判 LOCAL_ONLY');
});

test('本机守卫：非本机时 askChat 不发请求', () => {
  const fn = CHAT_JS.slice(CHAT_JS.indexOf('function askChat'), CHAT_JS.indexOf('function resetSendButton'));
  // 2026-10-25：插件形态整体删除，本机门不再有 transport 豁免。
  assert.match(fn, /if \(!LOCAL_ONLY\)/, 'askChat 要拦截（无豁免分支）');
  assert.match(fn, /只在你自己电脑上可用/, '要给出说明');
});

test('本机守卫：非本机时上传被拒', () => {
  const fn = CHAT_JS.slice(CHAT_JS.indexOf('function uploadAttachment'), CHAT_JS.indexOf('function renderAttachBar'));
  assert.match(fn, /if \(!LOCAL_ONLY\) return Promise\.reject/, 'uploadAttachment 要拦截');
});

test('本机守卫：非本机时输入框禁用并显示说明', () => {
  assert.match(CHAT_JS, /function showLocalOnlyNotice/);
  // 该函数定义在 openPanel 之后，用下一个已知函数名收边界
  const start = CHAT_JS.indexOf('function showLocalOnlyNotice');
  const end = CHAT_JS.indexOf('function close()', start);
  const fn = CHAT_JS.slice(start, end);
  assert.ok(fn.length > 0, '找不到 showLocalOnlyNotice');
  assert.match(fn, /inputEl\.disabled = true/);
  assert.match(fn, /sendBtn\.disabled = true/);
  assert.match(fn, /attachBtn\.disabled = true/);
});

// ── setTransport 钩子（2026-10-20，油猴脚本形态）──────────────

test('钩子：setTransport/showNotice 暴露在 __chatPanel 上', () => {
  assert.match(CHAT_JS, /window\.__chatPanel\.setTransport\s*=/, 'setTransport 要暴露');
  assert.match(CHAT_JS, /window\.__chatPanel\.showNotice\s*=/, 'showNotice 要暴露');
});

test('askChat：脚本形态已删除，只剩本机桥路径（2026-10-25 架构收口）', () => {
  // 站长定案：删掉插件与站点侧衔接层，回到 node 桥形态。transport 分支
  // （走 userscript iframe 通道）整段移除——它带来的重复工具循环、参数错位、
  // 工具表空、白名单双份等缺陷随之消失。
  const fn = CHAT_JS.slice(CHAT_JS.indexOf('function askChat'), CHAT_JS.indexOf('function resetSendButton'));
  assert.doesNotMatch(fn, /transport\.ask\(payload/, '脚本形态的通道分派不许回来');
  assert.match(fn, /attempt\(1\)\.then/, '本机桥路径必须在');
  assert.match(fn, /handleEventPlain/, '事件仍走统一消费者');
});

test('钩子：事件词汇两路共用 handleEventPlain', () => {
  // 2026-10-20 提升：handleEventPlain 在 askChat 顶层（transport 分派可达），
  // handleEvent 壳留在 SSE pump 里转发给它。
  const hi = CHAT_JS.indexOf('function handleEventPlain(ev)');
  assert.ok(hi > 0, 'handleEventPlain 存在');
  const heStart = CHAT_JS.indexOf('function handleEvent(raw)');
  const heBody = CHAT_JS.slice(heStart, heStart + 400);
  assert.match(heBody, /handleEventPlain\(ev\)/, 'SSE 路径要转发');
  // transport 分派点在 handleEventPlain 定义之后（作用域可达——当年 bug 的判据）
  const dispatch = CHAT_JS.indexOf('if (transport) {');
  assert.ok(dispatch < 0 || hi < dispatch || CHAT_JS.indexOf('transport.ask(payload', dispatch) > hi,
    '分派点能看见 handleEventPlain');
});

test('stopAnswer / uploadAttachment：插件形态的分派已删除（只剩本机桥）', () => {
  // 2026-10-25 站长定案：插件侧整体删除，面板只保留本机桥 SSE。
  const fn = CHAT_JS.slice(CHAT_JS.indexOf('function askChat'), CHAT_JS.indexOf('function resetSendButton'));
  assert.doesNotMatch(fn, /transport\.cancel\(\)/, '停止不再走通道');
  const up = CHAT_JS.slice(CHAT_JS.indexOf('function uploadAttachment'), CHAT_JS.indexOf('function renderAttachBar'));
  assert.doesNotMatch(up, /transport\.upload\(item\)/, '上传不再走 transport');
});

test('钩子：setTransport(null) 逃生门 + 切换时停在飞问答', () => {
  const fn = CHAT_JS.slice(CHAT_JS.indexOf('window.__chatPanel.setTransport'));
  assert.match(fn, /transport = fn \|\| null/, 'null 恢复本机桥');
  assert.match(fn, /if \(busy\) \{[\s\S]{0,40}stopAnswerRef\(\)/, '切换前停掉在飞一问');
  assert.match(fn, /setTimeout[\s\S]{0,120}busy = false/, '2s 强制复位兜底（失联不永卡）');
});

// ── 工具标签派生（issue #18 决策 #10）──────────────────────────
// 标签从 buildToolDefs 派生，不再手抄——此前手抄版 site_view 是复制粘贴错误
// （「截图查看版面」，与 site_capture_view 重复）。

test('TOOL_LABEL 从 buildToolDefs 派生：标签集与 defs 一致，site_view 不再是截图', async () => {
  const { buildToolDefs } = await import('./webmcp-tools.mjs');
  const defs = buildToolDefs(null, null);
  const expected = Object.fromEntries(defs.map((d) => [d.name, d.label || d.name]));
  const m = CHAT_JS.match(/var TOOL_LABEL = (\{[^;]+\});/);
  assert.ok(m, 'CHAT_JS 应有 TOOL_LABEL 映射');
  assert.deepEqual(JSON.parse(m[1]), expected, '标签必须逐字来自 defs 的 label——工具改名时自动跟随');
  assert.equal(expected.site_view, '显示设置', 'site_view 是显示设置，不是截图');
  assert.equal(expected.site_capture_view, '截图查看版面', '截图是 capture_view 的职责');
  // 全覆盖：每个注册工具都有标签（少一条会在面板上显示裸工具名）
  assert.equal(Object.keys(expected).length, defs.length);
});
