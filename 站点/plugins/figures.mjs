/**
 * 图元（figures）—— 把「电路/波形/卡诺图」当**数据**而不是手绘 SVG
 *
 * ## 它解决什么
 *
 * 2026-10-28 之前的电路图是手写内联 SVG：每张 20–80 行坐标，图里的符号是
 * `<text>R</text>` 这样的纯文本——点不动、没有释义，符号气泡系统完全够不着
 * （它只认 KaTeX 公式里的令牌）。电子技术 31 张图全是这个状态。
 *
 * 本模块让作者只写**语义**，几何由模块算：
 *
 *   :::figure y-bc | Y=BC 的逻辑图
 *
 * 一行指令换掉 40 行手写坐标；图元定义住在图库里
 * （`站点/图库/<课程>.figures.txt`），一个图元可以被多个页面引用。
 *
 * ## 三个消费者，同一份数据
 *
 * 一张图解析成一份 IR，再投到三个目标：
 *
 *   svg  → 人看的活图（图内符号是 <a class="sym-gloss"><tspan>，复用既有气泡）
 *   text → 不跑 JS 的 AI 客户端 / site_read / 站内搜索（<details> 里的结构表）
 *   json → MCP 工具与页面烘焙的 #figure-index-json
 *
 * 这正是旧系统缺的：它只有「渲染成 HTML」一条路，所以 AI 读不到图里的符号。
 *
 * ## 两个必须绕开的实测坑（都踩过，别再踩）
 *
 * ① **不能直接往正文吐 raw HTML**。`math-glossary.mjs` 的 autoWrapTerms 会把
 *    正文里形如术语的词包成令牌，它伸手进 `<text>` 内部把 `<text>B</text>`
 *    改成 `<text>[B]{#sym-B}</text>`，随后变成 `<a>` 直接套在 `<text>` 里——
 *    而 SVG 的 `<a>` 必须包 `<tspan>`，包裸文本是**非法 SVG**（浏览器容错，
 *    但文本布局、主题化、读屏全受影响）。所以本模块吐的是**单行占位符**
 *    `@@FIGURE_n@@`，与仓库既有的 `@@MATH_BLOCK_n@@` / `@@CODE_FENCE_n@@`
 *    同一种做法，Step 6 再统一换回来。
 *
 * ② **块式围栏会打坏折叠面板**。`collapse.mjs` 用裸 `:::` 深度计数配对，
 *    它不认识 `:::figure`，于是把 figure 的闭合 `:::` 当成折叠块的结束
 *    （实测：折叠块里嵌块式 figure，期望 2 个 `<details>`，实得 1 个，
 *    后半段掉出面板）。单行指令没有闭合行，这个坑不存在。
 *
 * 所以本模块的管线位置是 **Step 2.4：公式提取之后、折叠块之前**：
 *
 *   Step 1    代码围栏保护
 *   Step 2    公式提取        ← 图注里的 $…$ 已是占位符，本模块不必懂公式
 *   Step 2.4  ★ 本模块       ← 图换成 @@FIGURE_n@@ 占位符
 *   Step 2.5  折叠块          ← 图已在折叠块体里，但已是单行占位符，不干扰配对
 *   Step 2.6  符号气泡        ← 此时正文里没有 SVG，autoWrapTerms 伸不进去
 *   Step 5    marked
 *   Step 6    还原占位符      ← 本模块的 restore 在这里把占位符换成真 <figure>
 *
 * ## 图内符号为什么能白拿气泡
 *
 * 图里每个带词条的标签产出 `<a class="sym-gloss" data-term="…"><tspan>…</tspan></a>`。
 * 客户端气泡脚本是全局 `document` 委托监听 `a.sym-gloss`（math-glossary.mjs 的
 * GLOSSARY_JS），SVG 里的 `<a>` 一样命中——实测点得动。于是：
 *
 *   · 不需要第二套气泡
 *   · 不需要第二份词典
 *   · 不需要第二个 SPA 换页重置点
 *
 * 唯一代价：图内标签**不能写 KaTeX**（`<span>` 塞进 `<text>` 会毁掉 SVG 文本布局），
 * 所以标签只认纯文本 + 有限的上下标写法（见 `labelToTspans`）。
 *
 * ## 零回落 / 失败可见
 *
 * 旧符号系统的病根是**静默丢弃**（引用了不存在的词条，构建期一声不吭）。
 * 本模块的所有引用都有明确结局：
 *
 *   · 引用不存在的图元 id  → 抛错（带行号），构建失败
 *   · 引用不存在的词条 id  → 该标签不上色 + 警告（不骗人：不上色说明没词条）
 *   · 元件引脚指向不存在的网络 → 解析期抛错
 *   · 图种不认识 → 抛错
 *
 * 「不上色 + 警告」与「静默丢弃」的区别是：警告会出现在构建日志里，
 * 而且是**按页聚合**打印的，没人漏得掉。
 */

// ════════════════════════════════════════════════════════════════
// ① 围栏与占位符
// ════════════════════════════════════════════════════════════════

/** 单行指令：`:::figure <id> [<id> …] [cols=N] [| 图注]`。
 *  **没有闭合行**——图没有正文，块体永远为空。
 *  `(.+?)` 允许只写 `:::figure`（后面什么都没有）以走到「缺少图元 id」那条明确报错，
 *  而不是被正则静默漏掉、当成普通文本留在页面上。 */
const FIGURE_RE = /^[\t ]{0,3}:{3,}[\t ]*figure(?:[\t ]+(.*?))?[\t ]*$/i;
const FENCE_RE = /^[\t ]{0,3}(`{3,}|~{3,})/;
/** 占位符：不可能被 Markdown 语法误伤。
 *  restore 时要同时认两种形态：
 *    · 独立成行 —— `@@FIGURE_0@@`
 *    · 被 marked 包成段落 —— `<p>@@FIGURE_0@@</p>`
 *  后者是常态（占位符在源里是一整行，marked 会把它当一个段落）。 */
const PLACEHOLDER_RE = /(?:<p>\s*)?([\t ]*)@@FIGURE_(\d+)@@\s*(?:<\/p>)?/g;

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** SVG 属性值转义（比 HTML 少一层：SVG 里 `'` 也要转，属性一律用双引号）。 */
const attrEsc = esc;

// ════════════════════════════════════════════════════════════════
// ② 图库解析（图元定义住在这里，页面只写 id）
// ════════════════════════════════════════════════════════════════

/**
 * 图库文件格式：
 *
 * ```
 * # 注释行以 # 开头
 * y-bc    | and B C -> Y
 * wave-8  | wave 8
 *           A: 01001100
 *           B: 00110011
 * ```
 *
 * 规则很简单：`<id> | <kind 特定的一行或多行 DSL>`。
 * 续行（缩进且不以 `<id> |` 开头）属于上一个图元。
 *
 * 为什么是外面一个文件而不是内联展开：同一个门电路在讲义、作业、攻略里
 * 各用一次，三处写三份必然漂移；住一个文件则改一处全对，且**图元名可被
 * MCP 检索**（"这张图叫什么" → `y-bc`）。
 *
 * @param {string} text 图库文件全文
 * @param {string} [sourceName] 报错时显示的文件名
 * @returns {Map<string, {id: string, kind: string, body: string[], line: number}>}
 */
export function parseFigureLib(text, sourceName = 'figures.txt') {
  const lib = new Map();
  if (typeof text !== 'string') return lib;
  let cur = null;
  text.split(/\r?\n/).forEach((raw, idx) => {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) return;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)[\t ]*\|[\t ]*(.*)$/);
    if (m) {
      const id = m[1];
      if (lib.has(id)) {
        throw new Error(
          `${sourceName}:${idx + 1} 图元 id 重复：「${id}」` +
          `（第一次出现在第 ${lib.get(id).line} 行）`);
      }
      const dsl = m[2].trim();
      if (!dsl) {
        throw new Error(`${sourceName}:${idx + 1} 图元「${id}」后面没有 DSL（形如 and B C -> Y）`);
      }
      // body 保留**整行原文**：各 kind 的解析器自己认识自己的首行
      // （wave 要看到 `wave 8` 才知道格数，logic 要看到 `and B C -> Y`）。
      cur = { id, body: [dsl], line: idx + 1 };
      lib.set(id, cur);
      return;
    }
    if (!cur) {
      throw new Error(`${sourceName}:${idx + 1} 这一行不属于任何图元（续行前必须先有一个「id | …」）`);
    }
    cur.body.push(line.trim());
  });
  return lib;
}

/**
 * 从图元 DSL 的首词判图种。
 * 图库里不写显式 kind：`and B C -> Y` 的首词就是元件名、`wave 8` 的首词
 * 就是图种名——作者少写一个字段，也不会有「kind 说了 wave、正文却是门电路」
 * 这种自相矛盾。
 *
 * @returns {'logic'|'wave'|'kmap'|null} null = 不认识（调用方负责报错）
 */
export function kindOf(def) {
  const first = (def.body[0] || '').trim().split(/[\t ]+/)[0].toLowerCase();
  if (LOGIC_OPS.has(first)) return 'logic';
  if (first === 'wave') return 'wave';
  if (first === 'kmap') return 'kmap';
  return null;
}

// ════════════════════════════════════════════════════════════════
// ③ 三种图种的解析（DSL → 语义结构）
// ════════════════════════════════════════════════════════════════

/** 逻辑门 DSL 的元件名集合：既是「判图种」的判据，也是「元件是否认识」的白名单。
 *  两处必须同一份——先前它们各写一遍，改一处忘另一处就会漂移。 */
const LOGIC_OPS = new Set(['and', 'or', 'not', 'nand', 'nor', 'xor', 'xnor', 'buf']);

/**
 * 逻辑门电路的 DSL —— 一行一条子句，`;` 分隔，`->` 指向输出：
 *
 *   and B C -> Y            与门：输入 B、C，输出 Y
 *   not B -> nB             非门
 *   or A nB -> Y            或门
 *   nand A B C -> Y         与非门（输出带取反泡）
 *   xor A D -> Y            异或门
 *
 * 输入可以带取反标记 `!B`（画小圆圈）。
 * 网络由「同名标签」自动合并：`not B -> nB` 与 `and A nB -> Y` 里
 * 两处 `nB` 是同一根线，不需要作者手写网络表。
 *
 * **标签挂词条**：`B@sym-VB` 表示这个标签用词条 `sym-VB` 的释义（气泡）。
 * 不写 `@` 的标签就只是图形上的字，点不动——**这不是失败，是如实**：
 * 电子技术的词条都是 `sym-VB` 这种带前缀的 id，图里写的是 `B`，
 * 两者本就没有自动对应关系。要冒泡就显式写，不写就不假装有。
 */
/**
 * 解析一个端点记号：`!B` = 取反输入，`B@sym-VB` = 挂词条。
 * 返回 `{label, neg, term}`（term 为 null 表示不挂词条）。
 */
function parseToken(tok) {
  const neg = tok.startsWith('!');
  const body = neg ? tok.slice(1) : tok;
  const at = body.indexOf('@');
  return {
    label: at > 0 ? body.slice(0, at) : body,
    neg,
    term: at > 0 ? body.slice(at + 1) : null,
  };
}

function parseLogicBody(id, body) {
  const clauses = [];
  const text = body.join(' ').trim();
  if (!text) throw new Error(`图元「${id}」（logic）：正文为空`);
  for (const rawClause of text.split(';')) {
    const clause = rawClause.trim();
    if (!clause) continue;
    const m = clause.match(/^([a-z]+)[\t ]+(.+?)[\t ]*->[\t ]*(.+)$/);
    if (!m) {
      throw new Error(
        `图元「${id}」（logic）：看不懂子句「${clause}」` +
        '（要写成「and B C -> Y」）');
    }
    const op = m[1].toLowerCase();
    if (!LOGIC_OPS.has(op)) {
      throw new Error(
        `图元「${id}」（logic）：不认识的元件「${op}」` +
        `（可用：${[...LOGIC_OPS].join('、')}）`);
    }
    const ins = m[2].trim().split(/[\t ]+/).map(parseToken);
    const outTokens = m[3].trim().split(/[\t ]+/).filter(Boolean).map(parseToken);
    const outs = outTokens.map((t) => t.label);
    if (!outs.length) throw new Error(`图元「${id}」（logic）：「${clause}」没有输出`);
    if (op !== 'not' && op !== 'buf' && ins.length < 2) {
      throw new Error(`图元「${id}」（logic）：「${op}」至少要有两个输入（${clause}）`);
    }
    clauses.push({ op, ins, outs, outTerms: outTokens.map((t) => t.term) });
  }
  if (!clauses.length) throw new Error(`图元「${id}」（logic）：没有可用的子句`);
  return { clauses };
}

/**
 * 波形的 DSL：
 *
 *   wave 8
 *   A: 01001100
 *   B: 00110011
 *
 * 第一行 `wave <每行格数>`；之后每行是 `<标签>: <电平串>`。
 * 电平串每个字符是一格：`0`/`1` 画电平，`.` 表示「保持上一格」，
 * `-` 表示高阻（画中间虚线）。
 */
function parseWaveBody(id, body) {
  if (!body.length) throw new Error(`图元「${id}」（wave）：正文为空`);
  const head = body[0].match(/^wave[\t ]+(\d+)$/);
  if (!head) {
    throw new Error(`图元「${id}」（wave）：首行要写成「wave <格数>」，得到「${body[0]}」`);
  }
  const slots = Number(head[1]);
  if (!Number.isInteger(slots) || slots < 1) {
    throw new Error(`图元「${id}」（wave）：格数必须是正整数，得到「${head[1]}」`);
  }
  const rows = [];
  for (const line of body.slice(1)) {
    const m = line.match(/^([^:]+):[\t ]*([^:]*)$/);
    if (!m) throw new Error(`图元「${id}」（wave）：看不懂「${line}」（要写成「A: 0101」）`);
    const label = m[1].trim();
    const levels = m[2].trim();
    if (!/^[01.-]+$/.test(levels)) {
      throw new Error(
        `图元「${id}」（wave）：电平串只能含 0/1/./-，得到「${levels}」`);
    }
    // 解析成每格的实际电平（`.` 沿续上一格）
    const cells = [];
    let prev = '0';
    for (const ch of levels) {
      if (ch === '.') cells.push(prev);
      else { cells.push(ch); if (ch !== '-') prev = ch; }
    }
    rows.push({ label, levels, cells, slots: cells.length });
  }
  if (!rows.length) throw new Error(`图元「${id}」（wave）：没有信号行`);
  return { slots, rows };
}

/**
 * 卡诺图的 DSL：
 *
 *   kmap 4
 *   0000
 *   1111
 *   1111
 *   0000
 *   box r1-2 c0-3           圈组（行 1..2 × 列 0..3）
 *
 * 第一行 `kmap <变量数>`（2 或 4——3 变量的行序也是循环码，但列只有 2 个，
 * 用 2 行的写法反而更清楚）。之后是宽度 = 列数 的格值行，最后是若干圈组。
 * 行序与列序一律按**循环码**生成，作者不必手写 00 01 11 10。
 */
function parseKmapBody(id, body) {
  if (!body.length) throw new Error(`图元「${id}」（kmap）：正文为空`);
  const head = body[0].match(/^kmap[\t ]+(\d+)$/);
  if (!head) {
    throw new Error(`图元「${id}」（kmap）：首行要写成「kmap <变量数>」，得到「${body[0]}」`);
  }
  const vars = Number(head[1]);
  if (vars !== 2 && vars !== 3 && vars !== 4) {
    throw new Error(`图元「${id}」（kmap）：只支持 2、3、4 变量，得到「${vars}」`);
  }
  // 循环码序列：2 变量 → 00 01 11 10（4 行/列）；3 变量 → 一维 4 一维 2
  const gray = vars === 2 ? ['00', '01', '11', '10'] : ['00', '01', '11', '10'];
  const rowCodes = vars === 2 ? gray : gray;
  const colCodes = vars === 3 ? ['0', '1'] : gray;
  const cells = [];
  const boxes = [];
  for (const line of body.slice(1)) {
    const box = line.match(/^box[\t ]+r(\d+)-r?(\d+)[\t ]+c(\d+)-c?(\d+)$/);
    if (box) {
      const r1 = Number(box[1]), r2 = Number(box[2]);
      const c1 = Number(box[3]), c2 = Number(box[4]);
      const maxR = rowCodes.length - 1, maxC = colCodes.length - 1;
      if (r1 > r2 || c1 > c2) {
        throw new Error(`图元「${id}」（kmap）：圈组「${line}」的起止反了`);
      }
      if (r1 < 0 || r2 > maxR || c1 < 0 || c2 > maxC) {
        throw new Error(
          `图元「${id}」（kmap）：圈组「${line}」超出网格（行 0–${maxR}、列 0–${maxC}）`);
      }
      boxes.push({ r: [r1, r2], c: [c1, c2] });
      continue;
    }
    if (!/^[01]+$/.test(line)) {
      throw new Error(
        `图元「${id}」（kmap）：格值行只能含 0/1，得到「${line}」`);
    }
    if (line.length !== colCodes.length) {
      throw new Error(
        `图元「${id}」（kmap）：格值行宽应为 ${colCodes.length}（列数），得到 ${line.length}（「${line}」）`);
    }
    cells.push(line);
  }
  if (cells.length !== rowCodes.length) {
    throw new Error(
      `图元「${id}」（kmap）：应有 ${rowCodes.length} 行格值，得到 ${cells.length} 行`);
  }
  return { vars, rowCodes, colCodes, cells, boxes };
}

const KIND_PARSERS = {
  logic: parseLogicBody,
  wave: parseWaveBody,
  kmap: parseKmapBody,
};

// ════════════════════════════════════════════════════════════════
// ④ 标签 → <tspan>（图内不能有 KaTeX，只能纯文本 + 上下标）
// ════════════════════════════════════════════════════════════════

/**
 * 图内标签的写法约定（**故意做得极窄**）：
 *
 *   `Y`        普通文字
 *   `Y~1~`     下标记法：`~x~` → 下标 x
 *   `^B^`      **上划线（取反）**：`^…^` → 在文字上方画一条横线（`^B^` 读作 B̄）
 *
 * ⚠️ 2026-10-28 三签抓到：图注里写 `B̄`（上划线）而图里写 `nB`（n 前缀），
 * 两套否定记法在页面上**没有任何映射说明**，读者要自己猜它们是同一个东西。
 * 现在图内直接支持上划线，**图与图注用同一套记法**，不需要猜。
 *
 * 为什么不做成 LaTeX：`<span class="katex">` 塞进 SVG `<text>` 会毁掉
 * 文本布局（KaTeX 输出一整棵 span 树 + MathML，SVG 只认文本与 tspan）。
 * 作业图的标签本来就只是 `A/B/C/D/Y/CP/S/R/R̄_D/Y₁` 这类短名字，
 * 用不上公式；真需要公式时写进图注（那走正常的 Markdown 管线）。
 *
 * @returns {string} SVG 片段（`<tspan>` 序列，已转义）
 */
export function labelToTspans(label, opts = {}) {
  const text = String(label);
  if (!text) return '';
  // 拆成「正文 / 下标」两类片段
  const parts = [];
  let i = 0;
  let buf = '';
  while (i < text.length) {
    // 上划线：`^…^`
    if (text[i] === '^') {
      const end = text.indexOf('^', i + 1);
      if (end > i + 1) {
        if (buf) { parts.push({ kind: 'base', text: buf }); buf = ''; }
        parts.push({ kind: 'over', text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (text[i] === '~') {
      const end = text.indexOf('~', i + 1);
      if (end > i + 1) {
        if (buf) { parts.push({ kind: 'base', text: buf }); buf = ''; }
        parts.push({ kind: 'sub', text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    buf += text[i];
    i += 1;
  }
  if (buf) parts.push({ kind: 'base', text: buf });
  return parts
    .map((p) => {
      if (p.kind === 'sub') {
        return `<tspan baseline-shift="sub" font-size="${opts.subSize || 0.72}em">${esc(p.text)}</tspan>`;
      }
      // 上划线：`^_^` 包起来的那段加一条横线。用 text-decoration 而不是另画 path，
      // 这样字号变化时线的位置自动跟着走（SVG 的 text-decoration 是浏览器实现的）。
      if (p.kind === 'over') {
        return `<tspan text-decoration="overline">${esc(p.text)}</tspan>`;
      }
      return esc(p.text);
    })
    .join('');
}

// ════════════════════════════════════════════════════════════════
// ⑤ 绘制：logic
// ════════════════════════════════════════════════════════════════

/**
 * 门符号的几何。
 *
 * **必须是 IEC 方框风格**：本课教材与全部既有图约定「与门方框写 AND、或门写 ≥1、
 * 非门是方框内写 1 且输出端加小圆圈」（见作业页正文的「逻辑图符号」一条）。
 * 早期草图用的是 ANSI 曲线符号，与同页其它 6 张手绘图不一致——实测被审出后改回。
 * 一门课里两套符号体系，学生照着图做作业会认错门。
 *
 * 每个门 = 一个方框 + 框内文字（`AND` / `≥1` / `1` / `=1`），NAND/NOR/XNOR 再在
 * 输出端加取反小圆圈。原点在门的左边中点，输入分布在左边、输出在右边中点。
 */
const GATE_GEOM = {
  and:  { w: 64, h: 52, label: 'AND' },
  nand: { w: 64, h: 52, label: 'AND', outBubble: true },
  or:   { w: 64, h: 52, label: '≥1' },
  nor:  { w: 64, h: 52, label: '≥1', outBubble: true },
  xor:  { w: 64, h: 52, label: '=1' },
  xnor: { w: 64, h: 52, label: '=1', outBubble: true },
  // ⚠️ not 与 buf 的区别**只在输出端的取反小圆圈**——本课约定「非门是方框内写 1
  // 且输出端加小圆圈」。2026-10-28 三签抓到：这两者曾共用同一份几何、都没有圆圈，
  // 于是画出的是缓冲器（nB = B），图注却写 Y = A·B̄ —— **图和图注矛盾，读者会做错题**。
  not:  { w: 52, h: 40, label: '1', outBubble: true },
  buf:  { w: 52, h: 40, label: '1' },
};

/** 门框：矩形 + 框内标签。IEC 风格，与既有手绘图一致。 */
function gateShape(kind, w, h) {
  const half = h / 2;
  const g = GATE_GEOM[kind];
  if (!g) {
    // 不认识的元件**不许**悄悄画成别的门——报错由调用方处理，这里给显式占位
    return `<rect x="0" y="${-half}" width="${w}" height="${h}" rx="3" ` +
           `stroke-dasharray="4 3"/>`;
  }
  return `<rect x="0" y="${-half}" width="${w}" height="${h}" rx="3"/>` +
         (g.outBubble ? '' : '');
}

/**
 * 逻辑电路的几何：**分层布局**（输入列 → 门列 → 输出列），正交走线。
 *
 * 布局算法只做三件事：按依赖深度给每个门定列、同列内平均分行、然后画线。
 * 它画不好带反馈的网络——那种图请用显式坐标（`at=`），或者干脆退回手写 SVG。
 */
function drawLogic(payload, opts = {}) {
  const { clauses } = payload;
  const font = opts.fontSize || 13;

  // 谁产出了哪个标签（用于定列）
  const producer = new Map();
  clauses.forEach((c, ci) => {
    for (const out of c.outs) producer.set(out, ci);
  });

  // 每个门的列 = 输入里最深的产出者列 + 1；纯输入端点的列 = 0
  const colOf = new Array(clauses.length).fill(0);
  for (let pass = 0; pass < clauses.length + 1; pass += 1) {
    clauses.forEach((c, ci) => {
      let need = 0;
      for (const inp of c.ins) {
        const p = producer.get(inp.label);
        if (p !== undefined && p !== ci) need = Math.max(need, colOf[p] + 1);
      }
      if (need > colOf[ci]) colOf[ci] = need;
    });
  }

  const colCount = Math.max(...colOf, 0) + 1;
  const perCol = Array.from({ length: colCount }, () => []);
  clauses.forEach((c, ci) => perCol[colOf[ci]].push(ci));

  // 同列内平均分布；列间距按最宽的门算
  const COL_GAP = 96;
  const PAD_X_IN = 10;
  const OUT_LEAD = 26;        // 门输出到标签的引线长度
  const OUT_LABEL_SLOT = 34;  // 输出标签的预留槽位（够放 Y / nB / B̄ 这类）
  const ROW_GAP = 26;
  const PAD = 28;
  const pos = [];
  let maxRows = 1;
  perCol.forEach((list) => { maxRows = Math.max(maxRows, list.length); });

  perCol.forEach((list, col) => {
    const totalH = (list.length - 1) * (GATE_GEOM.and.h + ROW_GAP);
    const startY = PAD + (maxRows - 1) * (GATE_GEOM.and.h + ROW_GAP) / 2 - totalH / 2
      + GATE_GEOM.and.h / 2;
    list.forEach((ci, row) => {
      pos[ci] = {
        x: PAD + col * COL_GAP,
        y: startY + row * (GATE_GEOM.and.h + ROW_GAP),
      };
    });
  });

  const height = PAD * 2 + (maxRows - 1) * (GATE_GEOM.and.h + ROW_GAP) + GATE_GEOM.and.h;
  // 宽度由「最后一个门的右边缘 + 引出线段 + 输出标签宽度」算出，
  // 不用固定余量去猜——猜大了右边空一大块，整张图看起来左偏
  // （2026-10-28 站长实测指出：viewBox 宽 196，最右元素只到 122，空了 74px）。
  // 构建期**不追求精确宽度**：文字的真实宽度只有浏览器量得准（字体、字距、
  // 上划线的组合 tspan 都会影响）。这里给一个宽松的 viewBox 保证不裁切，
  // 精确的「包围盒 + 等边距」由客户端 getBBox() 校正（见 FIGURES_JS 的 fitViewBox）。
  //
  // 为什么不在构建期估：2026-10-28 站长指出「这图偏左」，我先试着按字数估宽、
  // 又试着加固定槽位——两次都是人肉调常数，估大一点就右侧空一块、估小一点就裁字。
  // 排版这种事交给排版引擎，别在构建期猜。
  const lastGate = pos[pos.length - 1] || { x: PAD, y: 0 };
  const lastGeom = GATE_GEOM[clauses[clauses.length - 1].op] || GATE_GEOM.and;
  const outRight = lastGate.x + lastGeom.w + (lastGeom.outBubble ? 11 : 0) + OUT_LEAD + 80;
  const width = Math.max(
    outRight + PAD_X_IN,
    PAD * 2 + (colCount - 1) * COL_GAP + GATE_GEOM.or.w + PAD_X_IN
  );

  // 端点坐标：标签 → {x, y}
  const portPos = new Map();
  // 输入端（没有被任何门产出的标签）统一摆在最左
  const inputLabels = [];
  clauses.forEach((c) => {
    for (const inp of c.ins) {
      if (!producer.has(inp.label) && !inputLabels.includes(inp.label)) {
        inputLabels.push(inp.label);
      }
    }
  });
  // 输入端点的纵向分布：**收在门的实际高度范围内**，而不是铺满整张画布。
  // 铺满会让 B、C 一个贴顶一个贴底（实测 B@32 / C@84，门只有 52 高），
  // 线从很远处斜着汇进来，读不出「这两根是同一个门的两个输入」。
  const firstGate = pos[0] || { y: height / 2 };
  const gateSpan = GATE_GEOM.and.h;
  const inputRows = Math.max(inputLabels.length, 1);
  const inputPitch = inputRows > 1 ? gateSpan / (inputRows + 1) : 0;
  const inputTop = firstGate.y - gateSpan / 2;
  inputLabels.forEach((label, i) => {
    portPos.set(label, {
      x: PAD_X_IN,
      y: inputRows > 1 ? inputTop + inputPitch * (i + 1) : firstGate.y,
    });
  });

  const body = [];
  body.push(`<g class="fig-logic" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">`);

  // 先画线（画在门下面）
  clauses.forEach((c, ci) => {
    const g = GATE_GEOM[c.op] || GATE_GEOM.and;
    const p = pos[ci];
    const inCount = c.ins.length;
    c.ins.forEach((inp, k) => {
      const sy = p.y - g.h / 2 + (g.h * (k + 1)) / (inCount + 1);
      const sx = p.x;
      let from = portPos.get(inp.label);
      if (!from) {
        // 来自别处的门输出：取那个门的右侧中点
        const pi = producer.get(inp.label);
        const pg = GATE_GEOM[clauses[pi].op] || GATE_GEOM.and;
        from = { x: pos[pi].x + pg.w, y: pos[pi].y };
      }
      const midX = (from.x + sx) / 2;
      // data-net / data-from / data-to：交互层靠它做「点一根线高亮整条网络」
      body.push(
        `<path class="fig-wire" data-net="${esc(inp.label)}" data-from="${esc(clauses.indexOf(producer.get(inp.label)) >= 0 ? 'g' + (producer.get(inp.label) + 1) : inp.label)}" data-to="g${ci + 1}" ` +
        `d="M${from.x} ${from.y} H${midX} V${sy} H${sx}" />`);
      if (inp.neg) {
        body.push(`<circle class="fig-inv" cx="${sx - 5}" cy="${sy}" r="4" fill="var(--fig-bg, #fff)" />`);
      }
    });
  });

  // 再画门
  clauses.forEach((c, ci) => {
    const g = GATE_GEOM[c.op] || GATE_GEOM.and;
    const p = pos[ci];
    // 门本体挂 data-comp：点它 = 选中这个元件，属性面板据此显示类型/输入/输出
    body.push(
      `<g class="fig-comp" data-comp="g${ci + 1}" data-op="${esc(c.op)}" ` +
      `data-ins="${esc(c.ins.map((x) => x.label).join(','))}" ` +
      `data-outs="${esc(c.outs.join(','))}" ` +
      `transform="translate(${p.x} ${p.y})">${gateShape(c.op, g.w, g.h)}` +
      (g.outBubble
        ? `<circle cx="${g.w + 6}" cy="0" r="5" fill="var(--fig-bg, #fff)"/>`
        : '') +
      `</g>`);
    // 框内标签（AND / ≥1 / 1 / =1）：本课约定，必画
    body.push(
      `<text x="${p.x + g.w / 2}" y="${p.y + 5}" text-anchor="middle" ` +
      `font-size="${g.w > 56 ? 14 : 15}" font-weight="600" fill="currentColor" ` +
      `stroke="none" font-family="sans-serif">${esc(g.label)}</text>`);
  });

  body.push(`</g>`);

  // 输出端：最后一个门的输出画到右边并标名字
  const outLabels = [];
  clauses.forEach((c) => {
    for (const out of c.outs) {
      if (out.startsWith('_')) continue; // 内部线，不画标签
      outLabels.push({ label: out, ci: c });
    }
  });
  body.push(`<g class="fig-labels" fill="currentColor" stroke="none" font-size="${font}" font-family="sans-serif">`);
  outLabels.forEach(({ label, ci }, i) => {
    const g = GATE_GEOM[ci.op] || GATE_GEOM.and;
    const p = pos[clauses.indexOf(ci)];
    const bx = g.outBubble ? p.x + g.w + 11 : p.x + g.w;
    const ex = bx + OUT_LEAD;
    body.push(`<line x1="${bx}" y1="${p.y}" x2="${ex}" y2="${p.y}" stroke="currentColor" stroke-width="1.6"/>`);
    // 输出标签**左对齐接在引线末端**（text-anchor=start，x=ex+4），
    // 宽度由 DRAW_OUT_SLOT 预留——几何量出来的宽度就不必估字形，
    // 右侧留白与左侧 PAD_X_IN 相等（2026-10-28 修「整张图偏左」）。
    body.push(`<text x="${ex + 4}" y="${p.y + Math.round(font * 0.35)}">${labelToTspans(label)}</text>`);
  });
  // 输入端标签
  const baseline = Math.round(font * 0.35);
  inputLabels.forEach((label) => {
    const pp = portPos.get(label);
    // 标签放在线的**左端上方**而不是压在线头上：线从 x=10 起画，
    // 标签锚在同样的 x 但垂直居中于端点，读者一眼对上「这个字母是这根线」
    body.push(`<text x="${pp.x}" y="${pp.y + baseline}" text-anchor="start">${labelToTspans(label)}</text>`);
  });
  body.push(`</g>`);

  return {
    viewBox: `0 0 ${Math.round(width)} ${Math.round(height)}`,
    body: body.join(''),
  };
}

// ════════════════════════════════════════════════════════════════
// ⑥ 绘制：wave
// ════════════════════════════════════════════════════════════════

function drawWave(payload, opts = {}) {
  const { rows, slots } = payload;
  const font = opts.fontSize || 12;
  const LANE_H = 42;
  const PAD_X = 52;
  const CELL_W = 34;
  const PAD_Y = 22;
  const width = PAD_X + slots * CELL_W + 24;
  const height = PAD_Y * 2 + rows.length * LANE_H;

  const body = [];
  body.push(`<g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">`);
  rows.forEach((row, ri) => {
    const top = PAD_Y + ri * LANE_H;
    const hi = top + 8;
    const lo = top + LANE_H - 14;
    let d = '';
    let prevY = null;
    row.cells.forEach((cell, ci) => {
      const x0 = PAD_X + ci * CELL_W;
      const x1 = x0 + CELL_W;
      if (cell === '-') {
        // 高阻：中间虚线
        const mid = (hi + lo) / 2;
        d += `M${x0} ${mid} H${x1} `;
        prevY = mid;
        return;
      }
      const y = cell === '1' ? hi : lo;
      if (prevY === null) d += `M${x0} ${y} `;
      else if (prevY !== y) d += `V${y} `;
      d += `H${x1} `;
      prevY = y;
    });
    body.push(`<path d="${d.trim()}" />`);
  });
  body.push(`</g>`);

  body.push(`<g fill="currentColor" stroke="none" font-size="${font}" font-family="sans-serif">`);
  rows.forEach((row, ri) => {
    const top = PAD_Y + ri * LANE_H;
    body.push(`<text x="8" y="${top + LANE_H / 2 + 4}">${labelToTspans(row.label)}</text>`);
  });
  body.push(`</g>`);

  return {
    viewBox: `0 0 ${Math.round(width)} ${Math.round(height)}`,
    body: body.join(''),
  };
}

// ════════════════════════════════════════════════════════════════
// ⑦ 绘制：kmap
// ════════════════════════════════════════════════════════════════

function drawKmap(payload, opts = {}) {
  const { rowCodes, colCodes, cells, boxes } = payload;
  const font = opts.fontSize || 13;
  const CELL = 40;
  const HDR = 30;
  const PAD = 10;
  const width = PAD * 2 + HDR + colCodes.length * CELL;
  const height = PAD * 2 + HDR + rowCodes.length * CELL;

  const body = [];
  body.push(`<g fill="none" stroke="currentColor" stroke-width="1.4">`);
  // 网格
  for (let r = 0; r <= rowCodes.length; r += 1) {
    const y = PAD + HDR + r * CELL;
    body.push(`<line x1="${PAD + HDR}" y1="${y}" x2="${PAD + HDR + colCodes.length * CELL}" y2="${y}"/>`);
  }
  for (let c = 0; c <= colCodes.length; c += 1) {
    const x = PAD + HDR + c * CELL;
    body.push(`<line x1="${x}" y1="${PAD + HDR}" x2="${x}" y2="${PAD + HDR + rowCodes.length * CELL}"/>`);
  }
  body.push(`</g>`);

  // 圈组（画在最底层之上、文字之下）
  const COLORS = ['#e5484d', '#3b82f6', '#16a34a', '#a855f7'];
  boxes.forEach((b, bi) => {
    const x = PAD + HDR + b.c[0] * CELL + 4;
    const y = PAD + HDR + b.r[0] * CELL + 4;
    const w = (b.c[1] - b.c[0] + 1) * CELL - 8;
    const h = (b.r[1] - b.r[0] + 1) * CELL - 8;
    body.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="none" ` +
      `stroke="${COLORS[bi % COLORS.length]}" stroke-width="2.4" opacity="0.9"/>`);
  });

  // 行列表头 + 格值
  body.push(`<g fill="currentColor" stroke="none" font-size="${font}" font-family="sans-serif">`);
  colCodes.forEach((code, c) => {
    body.push(`<text x="${PAD + HDR + c * CELL + CELL / 2}" y="${PAD + HDR - 8}" text-anchor="middle">${esc(code)}</text>`);
  });
  rowCodes.forEach((code, r) => {
    body.push(`<text x="${PAD + HDR - 8}" y="${PAD + HDR + r * CELL + CELL / 2 + 5}" text-anchor="end">${esc(code)}</text>`);
  });
  cells.forEach((line, r) => {
    for (let c = 0; c < line.length; c += 1) {
      body.push(
        `<text x="${PAD + HDR + c * CELL + CELL / 2}" y="${PAD + HDR + r * CELL + CELL / 2 + 5}" ` +
        `text-anchor="middle">${esc(line[c])}</text>`);
    }
  });
  body.push(`</g>`);

  return {
    viewBox: `0 0 ${Math.round(width)} ${Math.round(height)}`,
    body: body.join(''),
  };
}

const KIND_DRAWERS = {
  logic: drawLogic,
  wave: drawWave,
  kmap: drawKmap,
};

// ════════════════════════════════════════════════════════════════
// ⑧ 文字投影：不跑 JS 的 AI / site_read / 搜索读这个
// ════════════════════════════════════════════════════════════════

/**
 * 把图投成**结构表**（HTML）。这是「AI 不执行 JS 也能读到图」的唯一依靠：
 *
 *   · 逻辑图 → 一行一个门：类型 / 输入 / 输出
 *   · 波形   → 一行一个信号：标签 / 电平串 / 格数
 *   · 卡诺图 → 行列表头 + 格值 + 圈组
 *
 * 为什么要专门出这张表，而不是让 AI 去读 `aria-label`：`aria-label` 是
 * 一句话概括，读者拿不到「哪个门的输入接哪个网络」这种结构事实。
 * 而 `site_read` 的 `renderMarkdown` 会读 `<details>`（跳过 `<svg>`），
 * 所以这张表**自动**进得了 AI 的视野，一行客户端代码都不用写。
 */
export function renderStructureTable(ir) {
  const rows = [];
  if (ir.kind === 'logic') {
    rows.push(['门', '类型', '输入', '输出']);
    ir.payload.clauses.forEach((c, i) => {
      rows.push([
        `g${i + 1}`,
        c.op.toUpperCase(),
        c.ins.map((x) => (x.neg ? `NOT ${x.label}` : x.label)).join('、'),
        c.outs.join('、'),
      ]);
    });
  } else if (ir.kind === 'wave') {
    rows.push(['信号', '电平', '格数']);
    ir.payload.rows.forEach((r) => rows.push([r.label, r.levels, String(r.slots)]));
  } else if (ir.kind === 'kmap') {
    rows.push(['行 \\ 列', ...ir.payload.colCodes]);
    ir.payload.cells.forEach((line, r) => {
      rows.push([ir.payload.rowCodes[r], ...line.split('')]);
    });
    if (ir.payload.boxes.length) {
      rows.push(['圈组', ...ir.payload.boxes.map(
        (b, i) => `#${i + 1}: 行${b.r[0]}–${b.r[1]} 列${b.c[0]}–${b.c[1]}`)]);
    }
  }
  if (rows.length < 2) return '';
  const head = rows[0].map((h) => `<th>${esc(h)}</th>`).join('');
  const body = rows.slice(1)
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
    .join('');
  return `<table class="fig-structure-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// ════════════════════════════════════════════════════════════════
// ⑨ 主入口 ①：Markdown 源 → 占位符源 + IR 列表
// ════════════════════════════════════════════════════════════════

/**
 * 扫一遍 Markdown，把 `:::figure <id…>` 单行指令换成 `@@FIGURE_n@@` 占位符，
 * 同时把每张图解析成 IR。
 *
 * @param {string} source   当页 Markdown 源
 * @param {object} opts
 * @param {Map}    opts.lib        图库（parseFigureLib 的产物）
 * @param {string} [opts.libName]  图库文件名（报错用）
 * @param {string} [opts.pagePath] 当页路径（报错用）
 * @param {(id:string)=>object|null} [opts.lookupGloss] 词条查询（图内符号上色用）
 * @param {(key:string, entry:object)=>void} [opts.onHit] 命中回调
 *        图内符号必须在这里并进宿主的「本页命中集」——气泡词典是按页烘焙的
 *        实际命中集，晚于烘焙就只剩一条点了没反应的空锚点（实测踩过）。
 * @param {string} [opts.glossHref]  词条详解页的相对 href 前缀
 * @returns {{ source: string, figures: object[], warnings: string[] }}
 */
export function renderFigures(source, opts = {}) {
  if (typeof source !== 'string') return { source, figures: [], warnings: [] };
  if (!source.includes(':::figure')) return { source, figures: [], warnings: [] };

  const { lib = new Map(), libName = 'figures.txt', pagePath = '',
    lookupGloss = null, onHit = null, glossHref = '' } = opts;
  const lines = source.split(/\r?\n/);
  const out = [];
  const figures = [];
  const warnings = [];
  let fence = null;

  lines.forEach((line, idx) => {
    // 代码围栏内的 `:::` 一律不动
    const f = line.match(FENCE_RE);
    if (f) {
      const marker = f[1];
      if (!fence) fence = { ch: marker[0], len: marker.length };
      else if (marker[0] === fence.ch && marker.length >= fence.len) fence = null;
      out.push(line);
      return;
    }
    if (fence) { out.push(line); return; }

    const m = line.match(FIGURE_RE);
    if (!m) { out.push(line); return; }

    const spec = m[1] || '';
    const [headPart, ...captionParts] = spec.split('|');
    const caption = captionParts.join('|').trim();
    const tokens = headPart.trim().split(/[\t ]+/).filter(Boolean);
    const ids = tokens.filter((tok) => !tok.includes('='));
    if (!ids.length) {
      throw new Error(
        `${pagePath}:${idx + 1} :::figure 缺少图元 id（写法：:::figure y-bc | 图注）`);
    }
    if (ids.length > 1) {
      // 多图并排（四联图）**不做**：31 张现行图里一张都不需要它，而它会把
      // 接口、渲染、JSON 三处都撑出一层递归。真要并排时，写多个 :::figure
      // 或者退回手写 SVG，都比为一个用例养一条分支划算。
      throw new Error(
        `${pagePath}:${idx + 1} :::figure 一次只能引用一个图元（得到 ${ids.length} 个：${ids.join('、')}）`);
    }

    const resolved = ids.map((id) => {
      const def = lib.get(id);
      if (!def) {
        throw new Error(
          `${pagePath}:${idx + 1} 图元「${id}」不在图库 ${libName} 里` +
          `（现有图元：${[...lib.keys()].slice(0, 8).join('、')}${lib.size > 8 ? ' …' : ''}）`);
      }
      const kind = kindOf(def);
      if (!kind) {
        const first = (def.body[0] || '').trim().split(/[\t ]+/)[0] || '(空)';
        throw new Error(
          `${pagePath}:${idx + 1} 图元「${id}」的图种不认识（首词「${first}」）` +
          `（可用：${[...LOGIC_OPS].join('、')}、wave、kmap）`);
      }
      const parser = KIND_PARSERS[kind];
      let payload;
      try {
        payload = parser(def.id, def.body);
      } catch (e) {
        throw new Error(`${libName}:${def.line} ${e.message}`);
      }
      // 图内符号：把标签里形如词条 id 的引用解析掉（作者的记号是 `label`，
      // 词条 id 写在图库行的尾部，形如 `sym-diode:sym-...`——这里只查标签本身）
      const symbols = [];
      const collect = (label, term) => {
        if (!lookupGloss) return;
        // 只有显式写了 @词条 的标签才挂气泡。没写的就不挂——图里 `B` 这种
        // 单字母本来就不该自动关联到某个词条，猜出来的释义只会误导。
        const probe = term || null;
        if (!probe) return;
        const entry = lookupGloss(probe);
        if (!entry) {
          // 显式写了 @词条 却查不到：这是**配置错误**，必须可见。
          // 不写 @ 的标签是正常情况（纯图形文字），不算警告。
          warnings.push(`图元「${def.id}」的标签「${label}」指向词条「${probe}」，` +
            '但本页符号环境里没有它——该标签不会有气泡');
          return;
        }
        // key 以**查到的 id**为准（lookupGloss 未必要在返回值里带 key——
        // 宿主传的往往是包里的词条对象，它只有 title/text/href）。
        const key = entry.key || probe;
        symbols.push({ label, term: probe, key, href: entry.href });
        if (onHit) onHit(key, entry);
      };
      if (kind === 'logic') payload.clauses.forEach((c) => {
        c.ins.forEach((x) => collect(x.label, x.term));
        (c.outs || []).forEach((o, i) => collect(o, (c.outTerms || [])[i]));
      });
      if (kind === 'wave') payload.rows.forEach((r) => collect(r.label, r.term));
      return {
        v: 1,
        id,
        kind,
        caption,
        symbols,
        payload,
        origin: { file: libName, line: def.line, page: pagePath },
      };
    });

    const figIndex = figures.length;
    figures.push(resolved[0]);

    out.push(`@@FIGURE_${figIndex}@@`);
  });

  return { source: out.join('\n'), figures, warnings };
}

// ════════════════════════════════════════════════════════════════
// ⑩ 主入口 ②：占位符 → 真 <figure>
// ════════════════════════════════════════════════════════════════

/**
 * 把 `@@FIGURE_n@@` 换成完整的 `<figure>`。
 *
 * **为什么此时才换**：这一步在 marked 之后（Step 6 附近）。那时正文里的
 * 术语自动标注（autoWrapTerms）已经跑完，不会再伸手进 SVG 的 `<text>`；
 * Markdown 的各种语法也不会把 SVG 里的字符吃掉。
 *
 * 一个 `<figure>` 里放四样东西：
 *   <svg>            活图（图内符号是可点锚点）
 *   <figcaption>     图注
 *   <details>        结构表（AI / 无 JS / 读屏读这个）
 *   <script json>    烘焙的 IR（MCP 读这个）
 */
export function restoreFigures(html, figures) {
  if (typeof html !== 'string' || !figures.length) return html;

  const buildSymbolAnchor = (label, entry, inner) => {
    if (!entry) return inner;
    // ⚠️ SVG 的 <a> 只能包 <tspan> 等图形元素，**不能直接包裸文本**——
    // 实测过：`<text><a>B</a></text>` 在浏览器里容错能显示，但文本布局、
    // 主题化与读屏都会出问题。所以纯文本标签也要裹一层 <tspan>。
    const wrapped = inner.startsWith('<tspan') ? inner : `<tspan>${inner}</tspan>`;
    return (
      `<a class="sym-gloss" data-term="${attrEsc(entry.key)}" href="${attrEsc(entry.href || `${glossHref}#${entry.key}`)}"` +
      ` aria-label="${attrEsc(label)}">${wrapped}</a>`);
  };

  const drawOne = (ir) => {
    const drawer = KIND_DRAWERS[ir.kind];
    if (!drawer) return null;
    const { viewBox, body } = drawer(ir.payload, {});
    // 图内符号 → 可点锚点：按 IR 里**已解析的** symbols 匹配标签，
    // 不在这里重新查词典——解析期才知道哪个标签挂了哪个词条（`B@sym-VB`），
    // 渲染期只做替换。这样「哪些标签能点」与烘进 JSON 的 symbols 一定一致。
    const byLabel = new Map((ir.symbols || []).map((sym) => [sym.label, sym]));
    let inner = body;
    if (byLabel.size) {
      inner = body.replace(
        /<text([^>]*)>([^<]*)<\/text>/g,
        (whole, attrs, label) => {
          const sym = byLabel.get(label);
          const spans = labelToTspans(label);
          if (!sym) return `<text${attrs}>${spans}</text>`;
          return `<text${attrs}>${buildSymbolAnchor(label, sym, spans)}</text>`;
        });
    }
    return `<svg viewBox="${viewBox}" role="img" aria-label="${attrEsc(ir.caption || ir.id)}" class="fig-svg">${inner}</svg>`;
  };

  return html.replace(PLACEHOLDER_RE, (whole, indent, n) => {
    const ir = figures[Number(n)];
    if (!ir) return whole;
    const svg = drawOne(ir) || '';
    const table = renderStructureTable(ir);
    const caption = ir.caption ? `<figcaption>${ir.caption}</figcaption>` : '';
    const json = JSON.stringify(ir).replace(/<\//g, '<\\/');
    const vbMatch = /viewBox="([^"]+)"/.exec(svg);
    return (
      `${indent}<figure class="fig" id="fig-${attrEsc(ir.id)}" data-figure-id="${attrEsc(ir.id)}" ` +
      `data-figure-kind="${attrEsc(ir.kind)}" data-viewbox="${attrEsc(vbMatch ? vbMatch[1] : '')}">` +
      svg + caption +
      (table ? `<details class="fig-structure"><summary>图形的结构</summary>${table}</details>` : '') +
      `<script type="application/json" class="fig-data">${json}</script>` +
      `</figure>`);
  });
}


/**
 * 客户端交互层（渐进增强，独立字符串常量，构建期写盘）。
 *
 * ## 它让图真的能操作
 *
 * 没有它，图只是「一张能点符号字母的静态 SVG」——2026-10-28 站长实测：
 * 「这图真的我能操作吗」，当时 SVG 里只有 1 个可点锚点，元件与连线全不可选。
 *
 * 装上之后：
 *   · **点元件** → 选中（描边高亮），侧栏面板显示它的类型、输入、输出
 *   · **点连线** → 高亮整条网络（同名的所有线段一起亮），面板显示它连了哪些端点
 *   · **点空白** → 取消选中
 *   · **键盘** → 元件可 Tab 聚焦、Enter 选中（不只鼠标能操作）
 *   · **滚轮/按钮缩放** → 图局部看不清时放大细看
 *
 * ## 为什么用事件委托挂在 figure 上，而不是给每个元素绑监听
 *
 * 图是构建期烘进 HTML 的静态 SVG，页内可能有多张。委托一次挂在 figure 容器上，
 * 新增图种、新增元件都自动生效，不用改这段脚本——与 math-glossary 的
 * `document.addEventListener('click', … closest('a.sym-gloss'))` 同一个套路。
 *
 * ## 与符号气泡的关系
 *
 * 点图里的符号字母（`a.sym-gloss`）时，**不抢事件**——气泡脚本自己处理，
 * 这里只在 `closest('a.sym-gloss')` 命中时提前 return。否则会出现
 * 「点符号既弹气泡又选中元件」的双重反应。
 */
export const FIGURES_JS = String.raw`(function () {
  "use strict";
  var SVG_NS = "http://www.w3.org/2000/svg";

  function clearSelection(fig) {
    var i;
    var prev = fig.querySelectorAll(".is-selected");
    for (i = 0; i < prev.length; i++) prev[i].classList.remove("is-selected");
    var hot = fig.querySelectorAll(".is-hot");
    for (i = 0; i < hot.length; i++) hot[i].classList.remove("is-hot");
  }

  /** 把一条网络涉及的线段全点亮（同名 data-net 的所有 path）。 */
  function highlightNet(fig, net) {
    var wires = fig.querySelectorAll('.fig-wire[data-net="' + net.replace(/"/g, '') + '"]');
    for (var i = 0; i < wires.length; i++) wires[i].classList.add("is-hot");
    return wires.length;
  }

  /** 侧栏面板：显示选中物的结构事实（与 <details> 结构表同一份 IR）。 */
  function showPanel(fig, html) {
    var box = fig.querySelector(".fig-inspector");
    if (!box) {
      box = document.createElement("div");
      box.className = "fig-inspector";
      fig.appendChild(box);
    }
    box.innerHTML = html;
    box.hidden = false;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function onFigureClick(e) {
    var fig = e.currentTarget;
    var t = e.target;

    // 符号气泡优先：它自己会处理，别抢
    if (t.closest && t.closest("a.sym-gloss")) return;

    // 点元件
    var comp = t.closest && t.closest(".fig-comp");
    if (comp) {
      clearSelection(fig);
      comp.classList.add("is-selected");
      var ins = (comp.getAttribute("data-ins") || "").split(",").filter(Boolean);
      var outs = (comp.getAttribute("data-outs") || "").split(",").filter(Boolean);
      var op = comp.getAttribute("data-op") || "";
      // 顺带把它的输入网络也点亮：读者一眼看到「这个门吃的是哪几根线」
      for (var i = 0; i < ins.length; i++) highlightNet(fig, ins[i]);
      showPanel(fig,
        "<strong>" + esc(comp.getAttribute("data-comp")) + "</strong> · " +
        esc(op.toUpperCase()) +
        "<br>输入：" + esc(ins.join("、") || "—") +
        "<br>输出：" + esc(outs.join("、") || "—"));
      return;
    }

    // 点连线
    var wire = t.closest && t.closest(".fig-wire");
    if (wire) {
      clearSelection(fig);
      var net = wire.getAttribute("data-net") || "";
      var n = highlightNet(fig, net);
      showPanel(fig,
        "网络 <strong>" + esc(net) + "</strong><br>连到 " + n + " 处端点");
      return;
    }

    // 点空白：取消
    clearSelection(fig);
    var box = fig.querySelector(".fig-inspector");
    if (box) box.hidden = true;
  }

  /** 键盘：元件可聚焦与选中（不能只让鼠标能操作）。 */
  function onFigureKey(e) {
    var fig = e.currentTarget;
    if (e.key !== "Enter" && e.key !== " ") return;
    var comp = e.target.closest && e.target.closest(".fig-comp");
    if (!comp) return;
    e.preventDefault();
    comp.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }

  /** 缩放：滚轮 + 双击复位。只改 viewBox，不重排任何东西。 */
  function zoom(fig, factor) {
    var svg = fig.querySelector("svg");
    if (!svg) return;
    var vb = (svg.getAttribute("viewBox") || "0 0 100 100").split(/\s+/).map(Number);
    if (vb.length !== 4) return;
    var cx = vb[0] + vb[2] / 2;
    var cy = vb[1] + vb[3] / 2;
    var w = vb[2] * factor;
    var h = vb[3] * factor;
    // 视觉上限定范围：放大到 3 倍、缩小到原图 3 倍为止，别缩成一个点
    if (w < 20 || h < 20) return;
    svg.setAttribute("viewBox", [cx - w / 2, cy - h / 2, w, h].join(" "));
  }

  /**
   * 自动贴合：用 getBBox() 量真实内容包围盒（**含文字实际宽度**），
   * 把 viewBox 设成「包围盒 + 四边等距的边距」。
   *
   * 为什么必须由浏览器量：文字宽度取决于实际字体、字距、上下标的组合 tspan，
   * 构建期估不准。2026-10-28 站长指出「这图偏左」，我先按字数估、又加固定槽位，
   * 两次都是人肉调常数——估大右侧空一块、估小裁掉字。排版交给排版引擎。
   *
   * 只在首帧跑一次；缩放/复位都基于这个校正后的 viewBox。
   */
  function fitViewBox(fig) {
    var svg = fig.querySelector("svg");
    if (!svg || typeof svg.getBBox !== "function") return;
    var b;
    try { b = svg.getBBox(); } catch (e) { return; }
    if (!b || !isFinite(b.width) || !isFinite(b.height) || b.width <= 0 || b.height <= 0) return;
    // 四边同一个边距：内容在画布里天然居中，不偏左也不偏右
    var M = Math.max(6, Math.round(Math.min(b.width, b.height) * 0.12));
    var vb = [b.x - M, b.y - M, b.width + M * 2, b.height + M * 2]
      .map(function (n) { return Math.round(n * 100) / 100; }).join(" ");
    svg.setAttribute("viewBox", vb);
    // 记下校正后的 viewBox 供「复位」用（覆盖构建期那个宽松值）
    fig.setAttribute("data-viewbox", vb);
  }

  function setupFig(fig) {
    if (fig.__figReady) return;
    fig.__figReady = true;
    fig.addEventListener("click", onFigureClick);
    fig.addEventListener("keydown", onFigureKey);

    var svg = fig.querySelector("svg");
    if (!svg) return;
    // 首帧贴合：字体加载完再量才准（webfont 晚到会改变文字宽度）
    fitViewBox(fig);
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(function () { fitViewBox(fig); }).catch(function () {});
    }
    // 元件可聚焦：给每个门加 tabindex（SVG 元素也能收焦点）
    var comps = fig.querySelectorAll(".fig-comp");
    for (var i = 0; i < comps.length; i++) {
      comps[i].setAttribute("tabindex", "0");
      comps[i].setAttribute("role", "button");
    }
    // 缩放按钮：滚轮之外给一个显式入口（触屏与键盘用户也有路）
    var bar = document.createElement("div");
    bar.className = "fig-zoom";
    bar.innerHTML =
      '<button type="button" data-zoom="in" aria-label="放大">＋</button>' +
      '<button type="button" data-zoom="out" aria-label="缩小">－</button>' +
      '<button type="button" data-zoom="reset" aria-label="复位">⟲</button>';
    bar.addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-zoom]");
      if (!b) return;
      var act = b.getAttribute("data-zoom");
      if (act === "reset") {
        var orig = fig.getAttribute("data-viewbox");
        if (orig) svg.setAttribute("viewBox", orig);
      } else {
        zoom(fig, act === "in" ? 0.8 : 1.25);
      }
    });
    fig.appendChild(bar);
    fig.addEventListener("wheel", function (ev) {
      if (!ev.ctrlKey && !ev.metaKey) return;   // 普通滚动不劫持，避免滚不动页面
      ev.preventDefault();
      zoom(fig, ev.deltaY > 0 ? 1.15 : 0.87);
    }, { passive: false });
    // 双击复位。**必须排除缩放条与符号锚点**——否则连点两下「＋」会既放大又复位，
    // 读者看到的是「按了没反应」（2026-10-28 站长实测指出）。
    fig.addEventListener("dblclick", function (ev) {
      var t = ev.target;
      if (t.closest && (t.closest("a.sym-gloss") || t.closest(".fig-zoom"))) return;
      var orig = fig.getAttribute("data-viewbox");
      if (orig) svg.setAttribute("viewBox", orig);
    });
  }

  /**
   * 全屏查看（灯箱）。**所有图**都能点开——图元渲染的 SVG 与位图（<img>）都算。
   *
   * 纯前端、零依赖、**不进 MCP**：这是给人用的阅读体验，不是给 AI 的数据通道。
   * AI 读的仍是 <details> 结构表与 figure-index JSON，与这里无关。
   *
   * 打开方式：点图本身；关闭：点背景 / 按 Esc / 再点一次图。
   */
  var lb = null;
  function ensureLightbox() {
    if (lb) return lb;
    lb = document.createElement("div");
    lb.className = "fig-lightbox";
    lb.setAttribute("role", "dialog");
    lb.setAttribute("aria-modal", "true");
    lb.setAttribute("aria-label", "全屏查看");
    lb.innerHTML = '<button type="button" class="fig-lightbox-close" aria-label="关闭">×</button>' +
                   '<div class="fig-lightbox-body"></div>';
    lb.addEventListener("click", function (ev) {
      // 点背景或关闭按钮即关；点图本身不关（允许在灯箱里缩放）
      if (ev.target === lb || (ev.target.closest && ev.target.closest(".fig-lightbox-close"))) closeLightbox();
    });
    document.body.appendChild(lb);
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && lb && lb.classList.contains("is-open")) closeLightbox();
    });
    return lb;
  }

  function openLightbox(sourceEl, label) {
    var box = ensureLightbox();
    var body = box.querySelector(".fig-lightbox-body");
    body.innerHTML = "";
    var clone;
    if (sourceEl.tagName && sourceEl.tagName.toLowerCase() === "img") {
      clone = document.createElement("img");
      clone.src = sourceEl.getAttribute("src");
      clone.alt = sourceEl.getAttribute("alt") || "";
    } else {
      // SVG：整块克隆（含图内符号的锚点，气泡仍可用）
      clone = sourceEl.cloneNode(true);
      clone.removeAttribute("style");
      clone.style.maxWidth = "none";
      clone.style.width = "auto";
      clone.style.height = "auto";
    }
    // ⚠️ SVGElement 的 className 是**只读**的（SVGAnimatedString），
    // 用 clone.className 赋值会抛 TypeError 并中断整个 openLightbox——
    // 表现为「点了完全没反应」（2026-10-28 实测抓到）。SVG 走 setAttribute，
    // HTML 元素两法皆可。
    if (clone.tagName && clone.tagName.toLowerCase() === "svg") {
      clone.setAttribute("class", "fig-lightbox-content");
    } else {
      clone.className = "fig-lightbox-content";
    }
    body.appendChild(clone);
    if (label) {
      var cap = document.createElement("p");
      cap.className = "fig-lightbox-caption";
      cap.textContent = label;
      body.appendChild(cap);
    }
    box.classList.add("is-open");
    document.documentElement.style.overflow = "hidden";
  }

  function closeLightbox() {
    if (!lb) return;
    lb.classList.remove("is-open");
    document.documentElement.style.overflow = "";
    var body = lb.querySelector(".fig-lightbox-body");
    if (body) body.innerHTML = "";
  }

  /** 给「所有图」挂全屏入口：figure.fig 里的 svg、正文里的 img。 */
  function setupLightbox() {
    // ① 图元渲染的 SVG
    var figs = document.querySelectorAll("figure.fig");
    for (var i = 0; i < figs.length; i++) {
      if (figs[i].__lbReady) continue;
      var svg = figs[i].querySelector("svg");
      // ⚠️ 标记必须在**成功绑定之后**才设。先前写成「先设 __lbReady 再检查 svg」，
      // 首轮若 SVG 还没进 DOM 就永久跳过——灯箱对这张图永远不生效，
      // 而 __lbReady 已经是 true，后续 boot() 也不会重试（2026-10-28 实测踩到）。
      if (!svg) continue;
      svg.classList.add("fig-zoomable");
      svg.setAttribute("title", "点击全屏查看");
      (function (figEl, svgEl) {
        svgEl.addEventListener("click", function (ev) {
          // 点图内符号时先让气泡处理，不全屏
          if (ev.target.closest && ev.target.closest("a.sym-gloss")) return;
          // 点元件/连线时是「选中」，也不全屏
          if (ev.target.closest && (ev.target.closest(".fig-comp") || ev.target.closest(".fig-wire"))) return;
          var capEl = figEl.querySelector("figcaption");
          openLightbox(svgEl, capEl ? capEl.textContent.trim() : "");
        });
      })(figs[i], svg);
      figs[i].__lbReady = true;   // 绑定成功才标记
    }
    // ② 位图（习题册那 169 张走这条）
    var imgs = document.querySelectorAll(".article-content img");
    for (var j = 0; j < imgs.length; j++) {
      var im = imgs[j];
      if (im.__lbReady) continue;
      im.__lbReady = true;
      im.classList.add("fig-zoomable");
      im.setAttribute("title", "点击全屏查看");
      im.setAttribute("tabindex", "0");
      (function (img) {
        img.addEventListener("click", function () {
          openLightbox(img, img.getAttribute("alt") || "");
        });
        img.addEventListener("keydown", function (ev) {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            openLightbox(img, img.getAttribute("alt") || "");
          }
        });
      })(im);
    }
  }

  function boot() {
    var figs = document.querySelectorAll("figure.fig");
    for (var i = 0; i < figs.length; i++) setupFig(figs[i]);
    setupLightbox();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
  // SPA 换页后新图要重新接管（与 __glossaryReset 同一个接缝约定）
  window.__figuresReset = boot;
})();`;

// ════════════════════════════════════════════════════════════════
// ⑪ 样式（构建期写盘，与 SEARCH_CSS / CHAT_CSS 同款）
// ════════════════════════════════════════════════════════════════

export const FIGURES_CSS = `
.fig { margin: 1.4em 0; padding: 0; }
.fig-svg { display: block; width: 100%; max-width: 720px; height: auto; margin: 0 auto; color: var(--md-sys-color-on-surface, #1b1b1f); }
.fig figcaption { margin-top: .6em; text-align: center; font-size: .875em; color: var(--md-sys-color-on-surface-variant, #5c5c66); }
.fig-structure { margin-top: .8em; font-size: .875em; }
.fig-structure summary { cursor: pointer; color: var(--md-sys-color-on-surface-variant, #5c5c66); }
.fig-structure-table { border-collapse: collapse; margin-top: .5em; width: 100%; }
.fig-structure-table th, .fig-structure-table td { border: 1px solid var(--md-sys-color-outline-variant, #c9c9d1); padding: .28em .55em; text-align: left; }
.fig-structure-table th { background: var(--md-sys-color-surface-container, #f2f2f6); font-weight: 600; }
/* ── 交互态（2026-10-28 补：图必须真的能操作）────────────────────────── */
/* 元件可选：hover 提亮、选中加粗描边 */
.fig-svg .fig-comp { cursor: pointer; transition: opacity .15s; }
.fig-svg .fig-comp:hover { opacity: .75; }
.fig-svg .fig-comp:focus-visible { outline: none; }
.fig-svg .fig-comp:focus-visible rect { stroke-width: 3; stroke-dasharray: 4 2; }
.fig-svg .fig-comp.is-selected rect { stroke-width: 3; stroke: var(--md-sys-color-primary, #3b82f6); }
/* 连线可点：命中区加宽（细线不好点，靠 stroke-width 放大命中范围） */
.fig-svg .fig-wire { cursor: pointer; }
.fig-svg .fig-wire.is-hot { stroke: var(--md-sys-color-primary, #3b82f6); stroke-width: 2.6; }
/* 属性面板 */
.fig-inspector { margin-top: .6em; padding: .55em .75em; border-radius: 8px; font-size: .875em;
  background: var(--md-sys-color-surface-container, #f2f2f6);
  color: var(--md-sys-color-on-surface, #1b1b1f); }
/* 缩放条 */
.fig-zoom { position: absolute; right: .5em; top: .5em; display: flex; gap: .25em; opacity: .35; transition: opacity .2s; }
.fig:hover .fig-zoom, .fig-zoom:focus-within { opacity: 1; }
.fig-zoom button { width: 1.9em; height: 1.9em; border: 1px solid var(--md-sys-color-outline-variant, #c9c9d1);
  border-radius: 6px; background: var(--md-sys-color-surface, #fff); color: inherit;
  cursor: pointer; font-size: .85em; line-height: 1; }
.fig-zoom button:hover { background: var(--md-sys-color-surface-container, #f2f2f6); }
.fig { position: relative; }
/* ── 全屏查看（灯箱）：所有图都能点开，纯前端、不进 MCP ─────────────────── */
.fig-zoomable { cursor: zoom-in; }
.article-content img.fig-zoomable { transition: opacity .15s; }
.article-content img.fig-zoomable:hover { opacity: .9; }
.fig-lightbox {
  display: none; position: fixed; inset: 0; z-index: 9999;
  background: rgba(0, 0, 0, .88);
  align-items: center; justify-content: center;
  padding: 2vmin; cursor: zoom-out;
}
.fig-lightbox.is-open { display: flex; }
.fig-lightbox-body {
  display: flex; flex-direction: column; align-items: center; gap: .8em;
  max-width: 100%; max-height: 100%;
}
.fig-lightbox-content {
  max-width: 96vw; max-height: 86vh; width: auto; height: auto;
  background: var(--md-sys-color-surface, #fff); border-radius: 8px;
  cursor: default;
}
svg.fig-lightbox-content { padding: 1.2vmin; }
.fig-lightbox-caption {
  margin: 0; color: #e6e1e5; font-size: .9em; text-align: center;
  max-width: 90vw;
}
.fig-lightbox-close {
  position: absolute; top: 1.2vmin; right: 1.6vmin;
  width: 2.6em; height: 2.6em; border-radius: 50%;
  border: none; background: rgba(255, 255, 255, .14); color: #fff;
  font-size: 1.4em; line-height: 1; cursor: pointer;
}
.fig-lightbox-close:hover { background: rgba(255, 255, 255, .28); }
@media (max-width: 600px) {
  .fig-lightbox { padding: 1vmin; }
  .fig-lightbox-content { max-height: 80vh; }
}

/* 图中的符号锚点：只加下划线提示，不抢正文气泡的样式 */
.fig-svg a.sym-gloss { text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px; cursor: pointer; }
.fig-svg a.sym-gloss:focus-visible { outline: 2px solid var(--md-sys-color-primary, #3b82f6); outline-offset: 2px; }
`.trim();

/**
 * 客户端增强（可选，纯锦上添花）：把页面所有图的 IR 汇总成一份 JSON 供 MCP 读。
 *
 * 为什么要汇总一份：`site_figure` 工具一次要拿到「本页有哪些图」，
 * 逐个去翻 `<script class="fig-data">` 也行，但那是 N 次 DOM 遍历。
 * 一份汇总与 `nav-structure.mjs` 的 `nav-structure-json` 是同一个范式。
 */
export function buildFigureIndex(figures) {
  return figures.map((f) => ({
    id: f.id,
    kind: f.kind,
    caption: f.caption || '',
    symbols: (f.symbols || []).map((s) => s.label),
  }));
}
