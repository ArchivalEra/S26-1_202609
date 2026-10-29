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

test('renderMathInto：用公式引擎的产出填 innerHTML（现为 MathLive）', () => {
  // 2026-10-29 换引擎：接口从 `{renderToString}` 换成 `{convertLatexToMarkup}`。
  // 安全不变量 I1 不变——innerHTML 仍只接引擎产物（纯排版结构，不含脚本）。
  const doc = makeDoc();
  const n = doc.createElement('span');
  const fakeMaths = {
    convertLatexToMarkup: (tex) => '<span class="ML__latex">' + tex + '</span>',
  };
  renderMathInto(doc, n, 'x^2', false, fakeMaths);
  assert.match(n.innerHTML, /class="ML__latex"/);
});

test('renderMathInto：未加载引擎时退回字面 TeX（不抛）', () => {
  const doc = makeDoc();
  const n = doc.createElement('span');
  renderMathInto(doc, n, 'x^2', false, null);
  assert.equal(n.textContent, '$x^2$');
});

test('renderMathInto：引擎抛错时错误走 textContent（不注入错误串）', () => {
  const doc = makeDoc();
  const n = doc.createElement('span');
  const boom = { convertLatexToMarkup: () => { throw new Error('<img src=x onerror=alert(1)>'); } };
  renderMathInto(doc, n, 'bad', false, boom);
  assert.ok(!n.innerHTML.includes('onerror'), '错误串绝不能进 innerHTML');
  assert.ok(n.textContent.includes('$bad$'), '退回字面 TeX');
  assert.match(n.className, /chat-math-err/);
});

test('renderMathInto：引擎产物带 ML__error 时也按失败处理', () => {
  // MathLive 遇到不支持的构造不会抛异常，而是吐带 ML__error 的产物。
  // 判据必须是「检查产物」，不能只看有没有抛。
  const doc = makeDoc();
  const n = doc.createElement('span');
  const bad = { convertLatexToMarkup: () => '<span class="ML__error">?</span>' };
  renderMathInto(doc, n, 'whatever', false, bad);
  assert.ok(!n.innerHTML.includes('ML__error'), '错误产物不该被塞进页面');
  assert.match(n.className, /chat-math-err/);
});

test('renderMathInto：显示公式包一层可横向滚动的容器', () => {
  const doc = makeDoc();
  const n = doc.createElement('span');
  const fakeMaths = { convertLatexToMarkup: (tex) => '<span class="ML__latex">' + tex + '</span>' };
  renderMathInto(doc, n, 'a+b', true, fakeMaths);
  assert.match(n.innerHTML, /chat-math-display/);
});

// ── 字符串完整性 ───────────────────────────────────────────

// ── 联网开关已删除（2026-10-26 站长定案）──────────────────────
//
// 实测（.zcode/会话语义/实测-多会话与联网-20261025.md §5.1）：上游 WS 协议里
// 没有联网字段——按钮只能改自己的 UI 态、影响不到上游，等于骗用户。
// 定案：删。官方真实通道找到之前不复活；复活时从 git 历史取旧实现，
// 别凭记忆重写。这组断言钉住「确实删干净了」，防止半截复活。

test('联网开关物理删除：按钮/状态变量/互斥逻辑都不在 CHAT_JS', () => {
  for (const frag of ['chat-web-btn', 'webBtn', 'webSearch', 'setWebSearch', '联网搜索']) {
    assert.ok(!CHAT_JS.includes(frag), `不允许出现 ${frag}（已删除的功能，复活须先找到官方真实通道）`);
  }
});

test('附件按钮不再被联网互斥禁用：appendChild 行只剩 attach → input → send', () => {
  const i = CHAT_JS.indexOf('form.appendChild(attachBtn)');
  assert.ok(i > 0);
  const line = CHAT_JS.slice(i, i + 120);
  assert.ok(line.indexOf('inputEl') > 0 && line.indexOf('sendBtn') > 0, '输入框与发送键仍在');
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

test('CHAT_JS：innerHTML 赋值极少，且只接公式引擎产物', () => {
  const hits = (CHAT_JS.match(/\.innerHTML\s*=/g) || []).length;
  // renderMathInto 里两处（行内与显示各一）；showEmpty 的 box.innerHTML = "" 是清空
  assert.ok(hits <= 3, 'innerHTML 赋值应极少（实际 ' + hits + ' 处）');
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

test('CHAT_JS：面板与书签栏优先挂载到 .site-shell，且保留挂载到 body 的优雅回退', () => {
  assert.match(CHAT_JS, /siteShell\.querySelector\("\.m3-drawer"\)/, '查找站点抽屉');
  assert.match(CHAT_JS, /drawer\.after\(dockEl\)/, '会话列表插入站点抽屉后');
  assert.match(CHAT_JS, /siteShell\.appendChild\(panel\)/, '对话面板挂入 site-shell');
  assert.match(CHAT_JS, /document\.body\.appendChild\(dockEl\)/, '回退书签坞挂 body');
  assert.match(CHAT_JS, /document\.body\.appendChild\(panel\)/, '回退面板挂 body');
  assert.match(CHAT_JS, /document\.body\.appendChild\(backdrop\)/, '遮罩挂 body');
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

// ── 2026-10-26 架构重写守卫（冷态、书签条、会话管理、中性契约）────

function createTestSandbox({ onFetch, withSiteShell = false } = {}) {
  const windowListeners = {};
  const docListeners = {};
  const toggleBtn = {
    id: 'assistant-toggle',
    listeners: {},
    attrs: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] || null; },
  };
  function makeElem(tag, id = '', className = '') {
    const classes = new Set(className ? className.split(/\s+/).filter(Boolean) : []);
    const el = {
      tagName: tag.toUpperCase(),
      id,
      children: [],
      childNodes: [],
      parentNode: null,
      dataset: {},
      attrs: {},
      get className() { return Array.from(classes).join(' '); },
      set className(v) {
        classes.clear();
        String(v || '').split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
      },
      classList: {
        classes,
        add(c) { classes.add(c); },
        remove(c) { classes.delete(c); },
        contains(c) { return classes.has(c); },
        toggle(c, force) {
          const res = force !== undefined ? Boolean(force) : !classes.has(c);
          if (res) classes.add(c); else classes.delete(c);
          return res;
        },
      },
      setAttribute(k, v) { el.attrs[k] = String(v); },
      getAttribute(k) { return el.attrs[k] !== undefined ? el.attrs[k] : null; },
      appendChild(c) {
        c.parentNode = el;
        el.children.push(c);
        el.childNodes.push(c);
        return c;
      },
      insertBefore(newChild, refChild) {
        newChild.parentNode = el;
        const idx = el.children.indexOf(refChild);
        if (idx >= 0) {
          el.children.splice(idx, 0, newChild);
          el.childNodes.splice(idx, 0, newChild);
        } else {
          el.children.push(newChild);
          el.childNodes.push(newChild);
        }
        return newChild;
      },
      removeChild(c) {
        const idx = el.children.indexOf(c);
        if (idx >= 0) {
          el.children.splice(idx, 1);
          el.childNodes.splice(idx, 1);
          c.parentNode = null;
        }
        return c;
      },
      after(newChild) {
        if (!el.parentNode) return;
        el.parentNode.insertBefore(newChild, el.nextSibling);
      },
      get firstChild() { return el.children[0] || null; },
      get nextSibling() {
        if (!el.parentNode) return null;
        const siblings = el.parentNode.children;
        const idx = siblings.indexOf(el);
        return idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null;
      },
      addEventListener(type, fn) { ((el._listeners ||= {})[type] ||= []).push(fn); },
      querySelectorAll(selector) {
        const results = [];
        function walk(node) {
          for (const ch of node.children) {
            if (selector === '.bm-item' && ch.classList.contains('bm-item')) results.push(ch);
            else if (selector === '.m3-drawer' && ch.classList.contains('m3-drawer')) results.push(ch);
            else if (selector === '.site-shell' && ch.classList.contains('site-shell')) results.push(ch);
            walk(ch);
          }
        }
        walk(el);
        return results;
      },
      querySelector(selector) {
        const list = el.querySelectorAll(selector);
        return list[0] || null;
      },
      focus() {},
      blur() {},
      style: { setProperty() {}, height: '' },
      scrollTop: 0,
      getBoundingClientRect() { return { width: 360, height: 600 }; },
    };
    return el;
  }

  const body = makeElem('body');
  let siteShell = null;
  let drawer = null;
  if (withSiteShell) {
    siteShell = makeElem('div', 'site-shell', 'site-shell');
    drawer = makeElem('aside', 'm3-drawer', 'm3-drawer');
    const mainCol = makeElem('div', 'main-column', 'main-column');
    siteShell.appendChild(drawer);
    siteShell.appendChild(mainCol);
    body.appendChild(siteShell);
  }

  const doc = {
    body,
    documentElement: { getAttribute: () => './', style: { setProperty() {} } },
    head: { appendChild() {} },
    getElementById(id) {
      if (id === 'assistant-toggle') return toggleBtn;
      return null;
    },
    createElement(tag) { return makeElem(tag); },
    createElementNS(ns, tag) { return makeElem(tag); },
    createTextNode(t) { return { nodeType: 3, textContent: t }; },
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
    removeEventListener() {},
    querySelector(sel) {
      if (sel === '.site-shell') return siteShell;
      if (sel === '.m3-drawer') return drawer;
      return null;
    },
  };

  const store = {};
  const sandbox = {
    document: doc,
    location: { hostname: '127.0.0.1', search: '' },
    localStorage: {
      getItem(k) { return store[k] !== undefined ? store[k] : null; },
      setItem(k, v) { store[k] = String(v); },
    },
    fetch: onFetch || (() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) })),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    setTimeout,
    clearTimeout,
    addEventListener(type, fn) { (windowListeners[type] ||= []).push(fn); },
    removeEventListener() {},
    innerWidth: 1440,
    console,
  };
  sandbox.window = sandbox;
  return { sandbox, toggleBtn, body, siteShell, drawer, doc, windowListeners, docListeners };
}

test('冷态惰性注水：初始执行 0 fetch、0 面板 DOM；点击 #assistant-toggle 才按需建树与拉取会话', async () => {
  const { runInNewContext } = await import('node:vm');
  const fetchCalls = [];
  const { sandbox, toggleBtn, body } = createTestSandbox({
    onFetch: (url, opts) => {
      fetchCalls.push({ url, opts });
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    },
  });

  // ① 初次加载执行
  runInNewContext(CHAT_JS, sandbox);
  assert.equal(fetchCalls.length, 0, '冷态下绝不发任何网络请求');
  assert.equal(body.children.length, 0, '冷态下不往 body 插入面板或书签 DOM');

  // ② 触发点击
  assert.ok(typeof toggleBtn.listeners.click === 'function', '必须监听 #assistant-toggle 的 click');
  toggleBtn.listeners.click({ stopPropagation() {} });
  await new Promise((resolve) => setTimeout(resolve, 10));

  // ③ 唤醒后
  assert.ok(fetchCalls.length >= 1, '唤醒后必须触发网络请求');
  assert.ok(fetchCalls.some((c) => /\/chat\/sessions/.test(c.url)), '必须触发拉取会话列表');
  assert.equal(body.children.length, 3, '唤醒后向 body 挂载书签坞、面板与遮罩');
  const idsOrClasses = body.children.map((c) => c.id || c.className || c.tagName);
  assert.ok(idsOrClasses.includes('chat-dock'), 'body 直下必须包含 chat-dock');
  assert.ok(idsOrClasses.includes('chat-panel'), 'body 直下必须包含 chat-panel');
  assert.ok(idsOrClasses.includes('chat-backdrop'), 'body 直下必须包含 chat-backdrop');
});

test('会话管理契约：中性 API 路径与乐观删除 + Toast 提示', () => {
  // 必须采用全中性 REST 路径
  assert.match(CHAT_JS, /\/chat\/sessions["']/, '拉取会话列表端点');
  assert.match(CHAT_JS, /\/chat\/sessions\/new["']/, '新建会话端点');
  assert.match(CHAT_JS, /\/chat\/sessions\/"\s*\+\s*encodeURIComponent\(id\)\s*\+\s*"\/(?:delete|messages)/, '删除与切会话路径中性编码');

  // 乐观更新与 Toast
  assert.match(CHAT_JS, /showToast\("已从列表移除"\)/, '删除时必须有轻量 Toast 提示');
  assert.match(CHAT_JS, /function showToast/, 'Toast 展示函数');
  assert.match(CHAT_CSS, /\.chat-toast/, 'Toast 样式');
});

test('网络异常优雅降级：离线或拉取会话失败时降级显示，不抛未捕获异常', async () => {
  const { runInNewContext } = await import('node:vm');
  const { sandbox, toggleBtn } = createTestSandbox({
    onFetch: () => Promise.reject(new Error('Connection refused')),
  });

  runInNewContext(CHAT_JS, sandbox);
  assert.doesNotThrow(() => {
    toggleBtn.listeners.click({ stopPropagation() {} });
  }, '网络异常时点开助手绝不抛未捕获异常崩溃');

  // 源码中应具备 "+ 新会话" 与 "暂无会话" 降级占位
  assert.match(CHAT_JS, /bm-new/, '必须有新建会话按钮');
  assert.match(CHAT_JS, /bm-empty/, '必须有空会话占位');
  assert.match(CHAT_JS, /暂无会话/, '必须有暂无会话文案');
});

test('移动端与无障碍契约：20×56px 侧边把手在 CSS 与 JS 中齐备', () => {
  // CSS 结构与尺寸
  assert.match(CHAT_CSS, /\.chat-mobile-handle[\s\S]*?width:\s*20px/, '手机把手宽 20px');
  assert.match(CHAT_CSS, /\.chat-mobile-handle[\s\S]*?height:\s*56px/, '手机把手高 56px');
  assert.match(CHAT_CSS, /@media \(max-width: 860px\)[\s\S]*?#chat-dock \.chat-mobile-handle[\s\S]*?display:\s*flex/, '手机档把手必须显示');
  assert.match(CHAT_CSS, /#chat-dock \.chat-mobile-handle[\s\S]*?display:\s*none/, '宽屏档把手必须隐藏');

  // JS 无障碍属性
  assert.match(CHAT_JS, /mobileHandle\.setAttribute\("aria-label",\s*"会话列表"\)/, '无障碍名称');
  assert.match(CHAT_JS, /mobileHandle\.setAttribute\("aria-expanded"/, '展开状态透出');
});

test('安全与厂商隔离硬闸：CHAT_JS 与 CHAT_CSS 绝不泄漏超星厂商语义', () => {
  const forbidden = /chaoxing|robot-lc|visitor|msgList|conversationId|visitorVc|passport2/i;
  assert.doesNotMatch(CHAT_JS, forbidden, 'CHAT_JS 严禁出现任何超星专有词');
  assert.doesNotMatch(CHAT_CSS, forbidden, 'CHAT_CSS 严禁出现任何超星专有词');
});

// ── 2026-10-26 助手侧栏化三栏融入与交互测试 ─────────────────

test('DOM 挂载：优先挂入 .site-shell 参与 Flex 流，位置与主内容并列', async () => {
  const { runInNewContext } = await import('node:vm');
  const { sandbox, toggleBtn, siteShell, body } = createTestSandbox({
    withSiteShell: true,
  });
  runInNewContext(CHAT_JS, sandbox);

  toggleBtn.listeners.click({ stopPropagation() {} });
  await new Promise((resolve) => setTimeout(resolve, 10));

  // 验证 siteShell 的子项顺序：[m3-drawer, chat-dock (chat-sessions), main-column, chat-panel (chat-dialog)]
  assert.equal(siteShell.children.length, 4, 'siteShell 内应有 4 个 flex 子项');
  assert.equal(siteShell.children[0].id, 'm3-drawer', '左栏首位为站点目录');
  assert.equal(siteShell.children[1].id, 'chat-dock', '第二位为会话列表');
  assert.ok(siteShell.children[1].classList.contains('chat-sessions'));
  assert.equal(siteShell.children[2].id, 'main-column', '第三位为主内容列');
  assert.equal(siteShell.children[3].id, 'chat-panel', '第四位为对话区');
  assert.ok(siteShell.children[3].classList.contains('chat-dialog'));

  // 遮罩在 body 直下
  assert.ok(body.children.some((c) => c.className === 'chat-backdrop'));
});

test('全局快捷键：Ctrl+S / Cmd+S 触发助手开关并 preventDefault；禁用 Escape 关面板', async () => {
  const { runInNewContext } = await import('node:vm');
  const { sandbox, windowListeners } = createTestSandbox();
  runInNewContext(CHAT_JS, sandbox);

  const keydownFns = windowListeners.keydown || [];
  assert.ok(keydownFns.length > 0, 'window 上必须挂有 keydown 监听器');

  // ① 按 Escape：不得唤醒或关闭助手
  let escPrevented = false;
  keydownFns.forEach((fn) => fn({ key: 'Escape', preventDefault() { escPrevented = true; } }));
  assert.equal(sandbox.window.__chatPanel.isOpen, false, 'Escape 不得打开助手');
  assert.equal(escPrevented, false);

  // ② 按 Ctrl+S：阻止浏览器默认保存行为，并打开助手
  let ctrlSPrevented = false;
  keydownFns.forEach((fn) => fn({
    ctrlKey: true,
    key: 's',
    preventDefault() { ctrlSPrevented = true; },
  }));
  assert.equal(ctrlSPrevented, true, 'Ctrl+S 必须调用 preventDefault');
  assert.equal(sandbox.window.__chatPanel.isOpen, true, 'Ctrl+S 必须打开助手');

  // ③ Escape 在助手打开时也不得关闭助手（用户定案：不允许使用 esc）
  keydownFns.forEach((fn) => fn({ key: 'Escape', preventDefault() {} }));
  assert.equal(sandbox.window.__chatPanel.isOpen, true, 'Escape 绝不得关闭助手');

  // ④ 按 Cmd+S (metaKey)：关闭助手
  let cmdSPrevented = false;
  keydownFns.forEach((fn) => fn({
    metaKey: true,
    key: 'S',
    preventDefault() { cmdSPrevented = true; },
  }));
  assert.equal(cmdSPrevented, true, 'Cmd+S 必须调用 preventDefault');
  assert.equal(sandbox.window.__chatPanel.isOpen, false, 'Cmd+S 必须关闭助手');
});

test('状态记忆：开助手记录 sidebar-collapsed，关助手准确恢复原始状态', async () => {
  const { runInNewContext } = await import('node:vm');

  // 场景 A：用户原先未收起侧边栏
  {
    const { sandbox, body } = createTestSandbox();
    runInNewContext(CHAT_JS, sandbox);

    assert.equal(body.classList.contains('sidebar-collapsed'), false);
    sandbox.window.__chatPanel.open();
    assert.equal(body.classList.contains('sidebar-collapsed'), true, '开助手后收起左栏');
    assert.equal(body.dataset.sidebarWasCollapsed, 'false', '记录原先未收起');

    sandbox.window.__chatPanel.close();
    assert.equal(body.dataset.sidebarWasCollapsed, undefined, '关闭后清空标记');
    await new Promise((resolve) => setTimeout(resolve, 140));
    assert.equal(body.classList.contains('sidebar-collapsed'), false, '未收起态恢复展开');
  }

  // 场景 B：用户原先已自行收起侧边栏（不擅自展开）
  {
    const { sandbox, body } = createTestSandbox();
    body.classList.add('sidebar-collapsed');
    runInNewContext(CHAT_JS, sandbox);

    sandbox.window.__chatPanel.open();
    assert.equal(body.dataset.sidebarWasCollapsed, 'true', '记录原先已收起');

    sandbox.window.__chatPanel.close();
    await new Promise((resolve) => setTimeout(resolve, 140));
    assert.equal(body.classList.contains('sidebar-collapsed'), true, '原本收起态保持收起，不擅自展开');
  }
});

test('Bug 5.1 根治：关闭助手后会话目录与把手状态彻底收回', async () => {
  const { runInNewContext } = await import('node:vm');
  const { sandbox, body } = createTestSandbox();
  runInNewContext(CHAT_JS, sandbox);

  sandbox.window.__chatPanel.open();
  const dock = body.children.find((c) => c.id === 'chat-dock');
  assert.ok(dock, '找到 chat-dock');

  // 模拟手机把手展开会话列表
  dock.classList.add('open');
  const handle = dock.children.find((c) => c.className === 'chat-mobile-handle');
  assert.ok(handle, '找到 mobileHandle');
  handle.setAttribute('aria-expanded', 'true');

  // 关闭助手
  sandbox.window.__chatPanel.close();
  assert.equal(dock.classList.contains('open'), false, 'close() 必须移除 dock 的 open 类');
  assert.equal(handle.getAttribute('aria-expanded'), 'false', '把手无障碍态必须重置为 false');
});

test('Bug 5.2 根治：selectSession 仅切 active 类，保持滚动位置不归零', async () => {
  const { runInNewContext } = await import('node:vm');
  const { sandbox } = createTestSandbox();
  sandbox.window.__MOCK_SESSIONS__ = [
    { id: 'sess-1', title: '会话 1' },
    { id: 'sess-2', title: '会话 2' },
  ];
  sandbox.window.__MOCK_MESSAGES__ = {
    'sess-1': [{ role: 'user', text: '你好' }],
    'sess-2': [{ role: 'user', text: '第二会话' }],
  };
  runInNewContext(CHAT_JS, sandbox);

  sandbox.window.__chatPanel.open();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const bmList = sandbox.document.body.children
    .find((c) => c.id === 'chat-dock').children
    .find((c) => c.className === 'chat-bookmarks').children[0];

  assert.ok(bmList && bmList.className === 'bm-list');
  const items = bmList.querySelectorAll('.bm-item');
  assert.equal(items.length, 3, '包含 1 个新建按钮 + 2 个会话项');

  // 模拟滚动到 200px
  bmList.scrollTop = 200;

  // 切换会话
  await sandbox.window.__chatPanel.selectSession('sess-2');

  // 滚动条未被清零
  assert.equal(bmList.scrollTop, 200, '选择会话后 scrollTop 必须保持');

  // active 类正确更新
  const item1 = items.find((it) => it.getAttribute('data-session-id') === 'sess-1');
  const item2 = items.find((it) => it.getAttribute('data-session-id') === 'sess-2');
  assert.equal(item1.classList.contains('active'), false);
  assert.equal(item2.classList.contains('active'), true);
});

test('双栏独立拖拽与持久化：会话栏与对话区具备各自的尺寸区间与 localStorage 键名', () => {
  // 会话栏变量与范围
  assert.match(CHAT_JS, /shirone-chat-sessions-width/, '会话栏持久化键名');
  assert.match(CHAT_JS, /SESS_W_MIN = 200/, '会话栏下限 200');
  assert.match(CHAT_JS, /SESS_W_MAX = 420/, '会话栏上限 420');
  assert.match(CHAT_JS, /SESS_W_DEFAULT = 280/, '会话栏默认 280');
  assert.match(CHAT_JS, /buildSessionsResizer/, '会话栏独立拖拽手柄');

  // 对话区变量与范围
  assert.match(CHAT_JS, /shirone-chat-dialog-width/, '对话区持久化键名');
  assert.match(CHAT_JS, /CHAT_W_MIN = 300/, '对话区下限 300');
  assert.match(CHAT_JS, /CHAT_W_MAX = 720/, '对话区上限 720');
  assert.match(CHAT_JS, /CHAT_W_DEFAULT = 380/, '对话区默认 380');
  assert.match(CHAT_JS, /buildResizer/, '对话区独立拖拽手柄');
});
