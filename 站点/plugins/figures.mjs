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
 * @returns {'logic'|'wave'|'kmap'|'net'|'plot'|null} null = 不认识（调用方负责报错）
 */
export function kindOf(def) {
  const first = (def.body[0] || '').trim().split(/[\t ]+/)[0].toLowerCase();
  if (LOGIC_OPS.has(first)) return 'logic';
  if (first === 'wave') return 'wave';
  if (first === 'kmap') return 'kmap';
  if (first === 'net') return 'net';
  if (first === 'plot') return 'plot';
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
 *
 * ## 首行可选的三个子句（`;` 分隔）
 *
 *   wave 40 ; guides 10,20,30 ; axis ; cellw=16
 *
 * - `guides <格边界列表>`：在这些格边界上画**贯穿全部行的细竖线**。
 *   触发器波形不画这个就读不出题：图 8.02 要判「CP 上升沿那一刻 S、R 各是什么」，
 *   原图靠八条贯穿三行的竖线替读者对齐，删掉就只剩「10%/25%…」这串百分比让人自己在
 *   脑子里竖着连（2026-10-29 子代理指出，是信息量实打实的下降）。
 * - `axis` / `noaxis`：每行画不带刻度的 `t` 时间轴箭头与原点 `O`，**默认开**。
 * - `cellw=<数>`：显式指定每格宽度；不写则按目标宽度 700 反解
 *   （见 `drawWave` 里 `TARGET_W` 的注释——写死 34 会让 40 格超宽被 CSS 压到 0.5 倍，
 *   12px 标签缩成 6px 读不动）。
 *
 * ## 行标签的两个可选后缀
 *
 *   初态 0 [blue]: 00000011111111111111
 *   ^R^~D~@sym-RDd: 11111111111111111111
 *
 * - `@词条id`：与 `logic` 同一套语义，点字母弹气泡。
 * - `[颜色]`：这一行单独着色。两初态的 Q 波形同色就看不出「自 CP₂ 起两条重合」
 *   ——那是该题的结论，原图正是靠蓝/红两条线让人一眼看到的。
 *   方括号记法不占 `@`（那个已被词条用了），也不与 `~下标~`／`^上划线^` 冲突。
 */
// 配色沿用原手写 SVG 的三色（蓝 #1a5fb4 / 红 #c01c28 / 绿 #26a269），
// 不另引入一套色板——读者在原图里认的就是这三种颜色。
const WAVE_COLORS = {
  blue: '#1a5fb4', red: '#c01c28', green: '#26a269',
  orange: '#c64600', purple: '#9141ac', muted: '#8b8b8b',
};

function parseWaveBody(id, body) {
  if (!body.length) throw new Error(`图元「${id}」（wave）：正文为空`);
  const parts = body[0].split(';').map((s) => s.trim()).filter(Boolean);
  const head = parts[0].match(/^wave[\t ]+(\d+)$/);
  if (!head) {
    throw new Error(`图元「${id}」（wave）：首行要写成「wave <格数>」，得到「${body[0]}」`);
  }
  const slots = Number(head[1]);
  if (!Number.isInteger(slots) || slots < 1) {
    throw new Error(`图元「${id}」（wave）：格数必须是正整数，得到「${head[1]}」`);
  }
  let guides = [];
  let axis = true;
  let cellw = null;
  for (const opt of parts.slice(1)) {
    const g = opt.match(/^guides[\t ]+(.+)$/);
    if (g) {
      guides = g[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
        const n = Number(s);
        if (!Number.isInteger(n) || n < 0 || n > slots) {
          throw new Error(
            `图元「${id}」（wave）：参考线位置「${s}」必须是 0 到 ${slots} 之间的整数`);
        }
        return n;
      });
      continue;
    }
    if (opt === 'axis') { axis = true; continue; }
    if (opt === 'noaxis') { axis = false; continue; }
    const cw = opt.match(/^cellw=(\d+(?:\.\d+)?)$/);
    if (cw) {
      cellw = Number(cw[1]);
      if (!(cellw > 0)) throw new Error(`图元「${id}」（wave）：cellw 必须是正数`);
      continue;
    }
    throw new Error(
      `图元「${id}」（wave）：首行看不懂「${opt}」` +
      '（可用：guides 10,20 / axis / noaxis / cellw=16）');
  }
  const rows = [];
  for (const line of body.slice(1)) {
    const m = line.match(/^([^:]+):[\t ]*([^:]*)$/);
    if (!m) throw new Error(`图元「${id}」（wave）：看不懂「${line}」（要写成「A: 0101」）`);
    let label = m[1].trim();
    let color = null;
    const crayon = label.match(/\[([a-z]+)\]$/);
    if (crayon) {
      color = crayon[1];
      if (!WAVE_COLORS[color]) {
        throw new Error(
          `图元「${id}」（wave）：不认识的配色「${color}」` +
          `（可用：${Object.keys(WAVE_COLORS).join('、')}）`);
      }
      label = label.slice(0, crayon.index).trim();
    }
    let term = null;
    const at = label.indexOf('@');
    if (at > 0) {
      term = label.slice(at + 1).trim() || null;
      label = label.slice(0, at).trim();
    }
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
    // 短串要补齐：声明 wave 20 却给 8 个字符，以前是**静默**画成半截图，
    // 读者会以为后面 12 格没波形（2026-10-29 实测库里四条全是这种残缺串）。
    if (cells.length < slots) {
      throw new Error(
        `图元「${id}」（wave）：行「${label}」只有 ${cells.length} 格，` +
        `但首行声明了 ${slots} 格（要么补足电平，要么用 . 保持）`);
    }
    if (cells.length > slots) {
      throw new Error(
        `图元「${id}」（wave）：行「${label}」有 ${cells.length} 格，` +
        `超过首行声明的 ${slots} 格`);
    }
    rows.push({ label, levels, cells, slots: cells.length, term, color });
  }
  if (!rows.length) throw new Error(`图元「${id}」（wave）：没有信号行`);
  return { slots, rows, guides, axis, cellw };
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

/**
 * `net` 图种的元件类型白名单。
 *
 * 键是 DSL 里写的记号，值给出「中文名 + 引脚数 + 控制量」。白名单是**一份**
 * 而不是两处：解析期拿它判「认不认识」，绘制期拿它算引脚位置，结构表拿它写中文名。
 * 先前 logic 的 GATE_GEOM / LOGIC_OPS 分两份写，改一处忘另一处就漂；
 * 这里从一开始就把「认识什么」和「怎么画」拆开，但**名称只此一份**。
 *
 * 为什么受控源要拆成四型而不是一个 `cs`：四种受控源的符号靠菱形里的
 * +/− 或箭头区分，读者判断「这是 VCVS 还是 VCCS」全靠图上那个记号。
 * 合成一个类型，画出来就是「一个菱形，看不出控什么」，题就没法做。
 *
 * `ctrl` 字段是**控制量**：`v` = 电压控、`i` = 电流控。它决定结构表里的说明，
 * 也决定控制支路那根虚线的标号写 `U`（电压）还是 `I`（电流）。
 */
const NET_COMPONENTS = {
  r:    { label: '电阻',       pins: 2, ctrl: null },
  c:    { label: '电容',       pins: 2, ctrl: null },
  l:    { label: '电感',       pins: 2, ctrl: null },
  v:    { label: '电压源',     pins: 2, ctrl: null },
  i:    { label: '电流源',     pins: 2, ctrl: null },
  sw:   { label: '开关',       pins: 2, ctrl: null },
  // 单刀双投（three-way switch）：**3 个引脚**——公共端 + 两个触点。
  // 为什么要它：两地控制灯的图必须两个这样的开关串联中段，而 `sw` 只有 2 脚、
  // 也画不出「刀切在上还是下」。硬拆成两只 2 脚开关会画成两处都断（灯永远不亮），
  // 那是错图（2026-10-29 子代理拒绝出这张图，理由正确）。
  spdt: { label: '单刀双投',   pins: 3, ctrl: null, pos: true },
  d:    { label: '二极管',     pins: 2, ctrl: null },
  // 灯（⊗）：两地控制那类题里的负载。**不能用 `r` 冒充**——电阻符号画出来是矩形，
  // 题面写的是「灯 ⊗ 标 Y」，读者对不上图注就是错图（2026-10-29 子代理用 `r` 顶替，
  // 理由是「没有灯类型」，这属于「画个像的」，本仓明令禁止）。
  lamp: { label: '灯',         pins: 2, ctrl: null },
  // 交流源（~220 V）：**不带 ± 极性**。用 `v`（直流源，圆圈里画 +/−）冒充交流源，
  // 图注写「~220 V」而符号画着正负号，是自相矛盾的图。
  vac:  { label: '交流电源',   pins: 2, ctrl: null },
  // 受控源：四型分设，**四端**（2 输出 + 2 控制），`ctrl` 说控制量是什么。
  // 四端是教材的画法：菱形只管输出，控制端另有一对，标 U 或 I。
  vcvs: { label: '压控电压源', pins: 4, ctrl: 'v' },
  vccs: { label: '压控电流源', pins: 4, ctrl: 'v' },
  ccvs: { label: '流控电压源', pins: 4, ctrl: 'i' },
  cccs: { label: '流控电流源', pins: 4, ctrl: 'i' },
};

/** 受控源的判定：四个类型共用一套几何 + 一套「控制端」语法。 */
const isControlledType = (t) => t === 'vcvs' || t === 'vccs' || t === 'ccvs' || t === 'cccs';

/**
 * 电路（元件-引脚-网络）的 DSL —— 一行一个元件：
 *
 *   net
 *   V1 v 24V  top bottom                 两元的：位号 类型 数值 引脚1 引脚2
 *   R1 r 6Ω   top a
 *   R2 r 6Ω   a   bottom
 *   E1 vcvs 10 out 0 a b                 受控源：再接两段控制端（测 a、b 之间的电压）
 *   F1 cccs 4  out 0 a b                 流控源：控制端同样写 a b（测 a→b 的支路电流）
 *
 * 数值写 `-` 表示图上不标值（`-` 是有意的「不标」，与漏写区分开）。
 *
 * ## 受控源为什么必须写控制端
 *
 * 受控源的意义就是「输出由别处某个量决定」。只画一个写 VCVS 的菱形，
 * 读者不知道控制量取自哪里，题就做不出来。控制端两个网络名，正好回答
 * 「控制的是哪两个点之间的电压 / 哪条支路的电流」。
 *
 * ## 控制端为什么**不算**电气引脚
 *
 * 压控源的控制端不取电流、流控源的控制量是别处的支路电流——两者都只是
 * 「测量点」，不是电气连接。所以控制端**不进网络表**（否则读者会以为
 * 那里真接上了一根线，拓扑就错了）。它在图上画成**虚线**并标 `U`/`I`，
 * 虚线的通行含义就是「非导线」。
 *
 * 但它必须指向**真实存在的网络**：写错的网络名同样报错——否则图上会牵一根
 * 虚线指向虚空，读者找不着控制量在哪。
 *
 * ## 为什么不要求作者写坐标
 *
 * 电路图的拓扑才是语义，坐标是排版产物。写坐标换一张图就得重排；写拓扑则由绘制器算。
 *
 * ## 为什么引脚必须显式命名网络
 *
 * 同名即同网（同一根导线），是电路图的**唯一**结构事实。若允许「不写网络名就自动连」
 * 或「按顺序连」，作者写错一处会变成**另一张电路**，而图上还画得像对的——比报错糟得多。
 */
function parseNetBody(id, body) {
  if (!body.length) throw new Error(`图元「${id}」（net）：正文为空`);
  const head = body[0].trim().toLowerCase();
  if (head !== 'net') {
    throw new Error(`图元「${id}」（net）：首行要写成「net」，得到「${body[0]}」`);
  }
  const comps = [];
  const seen = new Set();
  for (const line of body.slice(1)) {
    if (!line.trim()) continue;
    const tok = line.trim().split(/[\t ]+/);
    const [ref, typeRaw, value] = tok;
    const type = (typeRaw || '').toLowerCase();
    if (tok.length < 5) {
      throw new Error(
        `图元「${id}」（net）：看不懂「${line}」` +
        '（两元要写成「R1 r 6Ω a bottom」：位号 类型 数值 引脚1 引脚2；' +
        '受控源写成「E1 vcvs 10 out 0 a b」：位号 类型 数值 输出1 输出2 控制1 控制2）');
    }
    if (!NET_COMPONENTS[type]) {
      throw new Error(
        `图元「${id}」（net）：不认识的元件类型「${typeRaw}」` +
        `（可用：${Object.keys(NET_COMPONENTS).join('、')}）`);
    }
    const controlled = isControlledType(type);
    const spec = NET_COMPONENTS[type];
    // 段数由类型定，不靠作者数段数：写多了/写少了都报错。
    // 少写一段就少画一个引脚，图上看着像「四端画成三端」，比报错更难发现。
    //
    // 三种形状：
    //   两元（r/c/l/v/i/sw/d/…）  位号 类型 数值 引脚1 引脚2                = 5 段
    //   受控源                    位号 类型 数值 输出1 输出2 控制1 控制2     = 7 段
    //   单刀双投（spdt）          位号 类型 数值 公共 触点1 触点2 刀位      = 7 段
    //     ↑ 末段 `pos` 说刀接在哪一侧（1 或 2）——这一笔是语义，不是坐标
    const want = controlled ? 7 : (spec.pins === 3 ? 7 : 5);
    if (tok.length !== want) {
      throw new Error(
        `图元「${id}」（net）：「${ref}」是 ${type}，应写 ${want} 段` +
        `（位号 类型 数值 ${controlled
          ? '输出1 输出2 控制1 控制2'
          : spec.pins === 3 ? '公共端 触点1 触点2 刀位(1|2)' : '引脚1 引脚2'}），` +
        `实际 ${tok.length} 段：${line}`);
    }
    if (seen.has(ref)) {
      throw new Error(`图元「${id}」（net）：位号「${ref}」重复`);
    }
    seen.add(ref);
    comps.push({
      ref,
      type,
      value,
      pins: spec.pins === 3 ? [tok[3], tok[4], tok[5]] : [tok[3], tok[4]],
      ctrlPins: controlled ? [tok[5], tok[6]] : null,
      // `pos` 只在 spdt 上出现（刀位 1|2）。不给别的元件塞 `pos: null`——
      // 那会让 payload 多一个永远为 null 的字段，烘进 JSON 后白白占体积。
      ...(spec.pos ? { pos: Number(tok[6]) } : {}),
    });
  }
  if (!comps.length) throw new Error(`图元「${id}」（net）：没有元件`);

  // 网络表：名字 → 挂在它上面的引脚列表。这里只做「是否成形」的检查，
  // 真正画线在绘制期按这份表布线。
  //
  // 只收 `pins`（电气引脚），控制端不收——见上面「控制端为什么不算电气引脚」。
  //
  // 存成**数组**而不是 Map：这份 payload 会被 JSON.stringify 烘进页面
  // （`<script class="fig-data">`），Map 序列化出来是 `{}`——拓扑会在
  // MCP 那一侧整段消失，而页面上看着一切正常。这是实测抓到的。
  const netMap = new Map();
  for (const c of comps) {
    c.pins.forEach((net, k) => {
      if (!netMap.has(net)) netMap.set(net, []);
      netMap.get(net).push({ ref: c.ref, pin: k + 1 });
    });
  }
  // 只有一个引脚的「网络」不可能是电线（一根线至少两端），
  // 也不可能是外部端点——电路图里没有悬空端点这种合法情况。报错，
  // 因为静默画一根悬空短线，读者会以为那里接着什么没画出来的东西。
  for (const [net, pins] of netMap) {
    if (pins.length < 2) {
      throw new Error(
        `图元「${id}」（net）：网络「${net}」只连了 1 个引脚（${pins[0].ref}）` +
        '——每个网络至少要有两个引脚');
    }
  }
  // 控制端必须指向已存在的网络（否则虚线指向虚空，读者找不着控制量）
  for (const c of comps) {
    if (!c.ctrlPins) continue;
    for (const net of c.ctrlPins) {
      if (!netMap.has(net)) {
        throw new Error(
          `图元「${id}」（net）：「${c.ref}」的控制端指向网络「${net}」，` +
          `但图里没有这个网络（现有：${[...netMap.keys()].join('、')}）`);
      }
    }
    if (c.ctrlPins[0] === c.ctrlPins[1]) {
      throw new Error(
        `图元「${id}」（net）：「${c.ref}」的两个控制端写成了同一个网络「${c.ctrlPins[0]}」` +
        '——控制量取自两点之间，两端不能是同一点');
    }
  }
  return {
    comps,
    nets: [...netMap.entries()].map(([name, pins]) => ({ name, pins })),
  };
}

/**
 * 模拟波形（连续幅值）的 DSL —— `plot` 图种。
 *
 * 为什么必须有它：`wave` 只画 0/1 两档电平，而二极管限幅题的图是**正弦被削平**——
 * 信息全在连续曲线上（哪一段被削、削在 ±10 V、原正弦幅值 20 V）。
 * 用多格 `wave` 去逼近会画成方波，等于把题换了（2026-10-29 子代理判定，
 * 结论正确：宁可留手写 SVG 也不许画方波冒充正弦）。
 *
 * ## 语法
 *
 *   plot 2 rows 340
 *   yrange -24 24
 *   ref 10
 *   ref -10
 *   grid 0
 *   row1 axis -20 20 label u~i~
 *   row1 curve sine 20 1.0
 *   row2 axis -20 20 label u~O~
 *   row2 ghost sine 20 1.0
 *   row2 curve clip 20 10
 *
 * - 首行：`plot <行数> rows <每行横向格数>`（格数只影响采样密度，不影响出图宽高）
 * - `yrange <min> <max>`：纵轴范围（伏特）。**必须写**，否则削顶比例无从谈起。
 * - `ref <值>`：画一条虚线参考电平（±10 V 这类）。可多条。
 * - `grid <值>`：画一条浅色实线基准（0 V）。可省略。
 * - `row<n> axis <min> <max> label <记号>`：该行的纵轴刻度与行名
 * - `row<n> curve sine <幅值> <周期数>`：正弦
 * - `row<n> curve clip <幅值> <限幅值>`：正弦被上下削平在 ±限幅值
 * - `row<n> ghost sine <幅值> <周期数>`：**浅色虚线**，画「本来该长什么样」
 *
 * 为什么 ghost 是独立指令而不是 curve 的开关：限幅题的读法就是「细线是输入本来的样子、
 * 粗线才是输出」——两条线在同一行里对比，是这个题的全部内容。
 */
const PLOT_CURVES = new Set(['sine', 'clip']);

function parsePlotBody(id, body) {
  if (!body.length) throw new Error(`图元「${id}」（plot）：正文为空`);
  const head = body[0].match(/^plot[\t ]+(\d+)[\t ]+rows[\t ]+(\d+)$/);
  if (!head) {
    throw new Error(
      `图元「${id}」（plot）：首行要写成「plot <行数> rows <每行格数>」，得到「${body[0]}」`);
  }
  const rowCount = Number(head[1]);
  const slots = Number(head[2]);
  if (!(rowCount >= 1) || !(slots >= 2)) {
    throw new Error(`图元「${id}」（plot）：行数与格数都要 ≥1（得到 ${rowCount} 行 /${slots} 格）`);
  }
  const rows = Array.from({ length: rowCount }, () => ({
    axis: null, label: '', curves: [],
  }));
  let yrange = null;
  let grid = null;
  const refs = [];
  for (const line of body.slice(1)) {
    const y = line.match(/^yrange[\t ]+(-?[\d.]+)[\t ]+(-?[\d.]+)$/);
    if (y) {
      const lo = Number(y[1]); const hi = Number(y[2]);
      if (!(hi > lo)) throw new Error(`图元「${id}」（plot）：yrange 上界要大于下界`);
      yrange = [lo, hi];
      continue;
    }
    const r = line.match(/^ref[\t ]+(-?[\d.]+)$/);
    if (r) { refs.push(Number(r[1])); continue; }
    const g = line.match(/^grid[\t ]+(-?[\d.]+)$/);
    if (g) { grid = Number(g[1]); continue; }
    const ax = line.match(/^row(\d+)[\t ]+axis[\t ]+(-?[\d.]+)[\t ]+(-?[\d.]+)[\t ]+label[\t ]+(.+)$/);
    if (ax) {
      const n = Number(ax[1]) - 1;
      if (!rows[n]) throw new Error(`图元「${id}」（plot）：没有第 ${ax[1]} 行`);
      rows[n].axis = [Number(ax[2]), Number(ax[3])];
      rows[n].label = ax[4].trim();
      continue;
    }
    const cv = line.match(/^(?:row(\d+))[\t ]+(curve|ghost)[\t ]+([a-z]+)[\t ]+(-?[\d.]+)(?:[\t ]+(-?[\d.]+))?$/);
    if (cv) {
      const n = Number(cv[1]) - 1;
      if (!rows[n]) throw new Error(`图元「${id}」（plot）：没有第 ${cv[1]} 行`);
      const kind = cv[3];
      if (!PLOT_CURVES.has(kind)) {
        throw new Error(
          `图元「${id}」（plot）：不认识的曲线「${kind}」` +
          `（可用：${[...PLOT_CURVES].join('、')}）`);
      }
      const amp = Number(cv[4]);
      const second = cv[5] !== undefined ? Number(cv[5]) : null;
      if (kind === 'clip' && second === null) {
        throw new Error(`图元「${id}」（plot）：clip 必须写限幅值（row2 curve clip 20 10）`);
      }
      rows[n].curves.push({ kind, amp, param: second, ghost: cv[2] === 'ghost' });
      continue;
    }
    throw new Error(
      `图元「${id}」（plot）：看不懂「${line}」` +
      '（可用：yrange / ref / grid / row<n> axis … label … / row<n> curve|ghost sine|clip …）');
  }
  if (!yrange) throw new Error(`图元「${id}」（plot）：缺 yrange（纵轴范围，限幅题没有它读不出削到多少伏）`);
  rows.forEach((r, i) => {
    if (!r.axis) {
      throw new Error(`图元「${id}」（plot）：第 ${i + 1} 行缺 axis（刻度范围与行名）`);
    }
    if (!r.curves.length) {
      throw new Error(`图元「${id}」（plot）：第 ${i + 1} 行没有任何曲线`);
    }
  });
  return { rowCount, slots, rows, yrange, grid, refs };
}

const KIND_PARSERS = {
  logic: parseLogicBody,
  wave: parseWaveBody,
  kmap: parseKmapBody,
  net: parseNetBody,
  plot: parsePlotBody,
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
  // 宽度按**所有门的最右边缘**算，不是最后一个子句。
  // 2026-10-29 子代理抓到：原来用 `pos[clauses.length-1]`，当最后一条子句不在最右列时，
  // 宽度兜底漏掉 OUT_LEAD 与输出标签槽，实测 3 门最小复现宽 226、标签右边界 234，裁掉 8px。
  // 同拓扑换个书写顺序宽度就正常——这种「看运气」的布局必须去掉。
  let maxRight = PAD;
  clauses.forEach((c, ci) => {
    const g = GATE_GEOM[c.op] || GATE_GEOM.and;
    maxRight = Math.max(maxRight, pos[ci].x + g.w + (g.outBubble ? 11 : 0));
  });
  const width = Math.max(
    maxRight + OUT_LEAD + 80 + PAD_X_IN,
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
  // 输入端点的纵向分布：**每个输入对齐到它自己那只门的输入口高度**。
  //
  // 早先的写法是把所有输入平均铺在第一只门的门高范围内（`firstGate.y ± h/2`），
  // 只在「一张图只有一只门」时成立。一旦有多只门分处不同的行（`gate-g` 上是
  // A·B、下是 C·D 分属两只与门），所有输入就被挤到第一只门那一小段里：
  // 2026-10-29 三签实测——四个标签 A/B/C/D 堆成一条竖列、互相重叠、字都粘连，
  // 读者**读不出哪个变量进哪只门**，于是 (A·B + C·D) 与 (A·C + B·D) 只能猜，
  // 猜错直接做错题。这不是观感问题，是语义丢失。
  //
  // 现在：对每个纯输入标签，找它**第一次被用到**的那只门，按该门第 k 个输入口
  // 的高度定位。同一标签被多只门用到时，取第一只（后续那只会有折线接过去）。
  const inputAnchor = new Map();
  clauses.forEach((c, ci) => {
    const g = GATE_GEOM[c.op] || GATE_GEOM.and;
    const p = pos[ci];
    const inCount = c.ins.length;
    c.ins.forEach((inp, k) => {
      if (producer.has(inp.label)) return;
      if (inputAnchor.has(inp.label)) return;   // 已由前一只门定位
      inputAnchor.set(inp.label, {
        x: PAD_X_IN,
        y: p.y - g.h / 2 + (g.h * (k + 1)) / (inCount + 1),
      });
    });
  });
  // 同列错开：两个输入若都落在最左的重合区（同一行的相邻输入口只差十几像素），
  // 标签会互相压字。2026-10-29 三签实测 prob-7-14 的 `A`（y=50.3）与 `B`（y=59）
  // 只差 9px，比字高还小，两个字母糊成一团，读者分不出哪条总线是 A、哪条是 B。
  // 修法：按 y 排序后逐个保证与上一个至少隔 MIN_INPUT_GAP，必要时整体下推。
  const MIN_INPUT_GAP = 18;   // 略大于 13px 字号的字高，留出呼吸
  {
    const entries = [...inputAnchor.entries()].sort((a, b) => a[1].y - b[1].y);
    let prevY = -Infinity;
    entries.forEach(([label, pt]) => {
      if (pt.y - prevY < MIN_INPUT_GAP) pt.y = prevY + MIN_INPUT_GAP;
      prevY = pt.y;
    });
  }
  // 兜底：理论上有 anchor 的输入都会进这个循环；万一有遗漏，按原分布补上
  inputLabels.forEach((label, i) => {
    if (inputAnchor.has(label)) { portPos.set(label, inputAnchor.get(label)); return; }
    const gateSpan = GATE_GEOM.and.h;
    const firstGate = pos[0] || { y: height / 2 };
    const inputRows = Math.max(inputLabels.length, 1);
    const inputPitch = inputRows > 1 ? gateSpan / (inputRows + 1) : 0;
    const inputTop = firstGate.y - gateSpan / 2;
    portPos.set(label, {
      x: PAD_X_IN,
      y: inputRows > 1 ? inputTop + inputPitch * (i + 1) : firstGate.y,
    });
  });

  const body = [];
  body.push(`<g class="fig-logic" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">`);

  // 先画线（画在门下面）
  //
  // ## 走线为什么要绕
  //
  // 原来每根线都是「从起点水平到中点 → 竖到目标高度 → 再水平进门」。
  // 起点在最左（输入端口）而目标门在右边时，那条水平段会**横穿中间列的门框**。
  // 2026-10-29 实测穿透：`y-a-nb` 4 段、`prob-7-14` 17 段、`prob-7-16` 15 段。
  // 电路图的约定是「线穿过方框 = 没画完」，而且穿过非门方框会让读者以为信号
  // 经过了那只门——那是另一张逻辑图，会做错题。
  //
  // 算法：把线分成「竖段」与「横段」，横段若与某只门的矩形相交，就把它抬到
  // 该门上方的**走线带**（每条线各占一层，避免互相重叠），过完障碍再落回来。
  // 这是正交绕行，全程没有斜线（与 net 图种同一套不变量）。
  const gateRects = pos.map((p, ci) => {
    const g = GATE_GEOM[clauses[ci].op] || GATE_GEOM.and;
    return { x1: p.x, y1: p.y - g.h / 2, x2: p.x + g.w, y2: p.y + g.h / 2, ci };
  });
  const TRACK_STEP = 14;      // 走线带每层间距
  let trackTop = Infinity;    // 已占用的最高层（越小越高）
  // 判断水平段 (y, xa..xb) 撞不撞门框（留 1px 容差，贴边不算）
  const hitsGate = (y, xa, xb) => gateRects.find(
    (r) => y > r.y1 + 1 && y < r.y2 - 1 && xb > r.x1 + 1 && xa < r.x2 - 1);

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
      // ---- 绕行判定：两段水平线（from→midX 与 midX→sx）各自可能穿门
      const hor1 = { y: from.y, xa: Math.min(from.x, midX), xb: Math.max(from.x, midX) };
      const hor2 = { y: sy, xa: Math.min(midX, sx), xb: Math.max(midX, sx) };
      const blocked = hitsGate(hor1.y, hor1.xa, hor1.xb) || hitsGate(hor2.y, hor2.xa, hor2.xb);
      let d;
      if (!blocked) {
        d = `M${from.x} ${from.y} H${midX} V${sy} H${sx}`;
      } else {
        // 抬到当前走线带上方（每遇一次障碍就再抬一层，避免多条线叠在一条道上）
        const yTrack = (Number.isFinite(trackTop) ? trackTop : Math.min(
          ...[from.y, sy, ...gateRects.map((r) => r.y1)])) - TRACK_STEP;
        trackTop = yTrack;
        d = `M${from.x} ${from.y} V${yTrack} H${sx} V${sy}`;
      }
      // data-net / data-from / data-to：交互层靠它做「点一根线高亮整条网络」
      body.push(
        `<path class="fig-wire" data-net="${esc(inp.label)}" data-from="${esc(clauses.indexOf(producer.get(inp.label)) >= 0 ? 'g' + (producer.get(inp.label) + 1) : inp.label)}" data-to="g${ci + 1}" ` +
        `d="${d}" />`);
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
    body.push(`<text x="${ex + 4}" y="${p.y + Math.round(font * 0.35)}" data-label="${attrEsc(label)}">${labelToTspans(label)}</text>`);
  });
  // 输入端标签
  const baseline = Math.round(font * 0.35);
  inputLabels.forEach((label) => {
    const pp = portPos.get(label);
    // 标签放在线的**左端上方**而不是压在线头上：线从 x=10 起画，
    // 标签锚在同样的 x 但垂直居中于端点，读者一眼对上「这个字母是这根线」
    body.push(`<text x="${pp.x}" y="${pp.y + baseline}" text-anchor="start" data-label="${attrEsc(label)}">${labelToTspans(label)}</text>`);
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
  const guides = payload.guides || [];
  const axis = payload.axis !== false;
  const font = opts.fontSize || 12;
  const LANE_H = 58;         // 行高：要明显大于「行内跳变高度」(lo−hi = 22)，
                             // 否则跨行读时会串行——2026-10-29 三签实测：
                             // 行间间距曾与行内跳变高度同量级，(c) 的平线贴着 (b) 的行底。
  const PAD_X = axis ? 44 : 34;
  const PAD_Y = axis ? 26 : 14;
  const AXIS_X = 30;         // 时间轴竖线的 x
  const TARGET_W = 700;      // 目标画布宽度
  // 每格宽度的来历：以前写死 34，40 格 → viewBox 1436，而 `.fig-svg` 的
  // `max-width:720px` 会把它压到 0.50 倍，构建期写的 12px 字号在屏幕上只剩 6px，
  // **字比线还细，读不动**。于是有人把格数从 40 降到 20 来「解决」——
  // 那是拿边沿精度换字号（实测非整格边沿被挪 2.5%）。
  // 正确做法是让图**一开始就画在目标宽度内**：格宽由目标宽度反解，
  // 40 格排进 700px 就是每格 16.4，不必缩放。
  const avail = TARGET_W - PAD_X - 24;
  const CELL_W = payload.cellw || Math.max(7, Math.min(34, avail / slots));
  const width = PAD_X + slots * CELL_W + 24;
  const height = PAD_Y * 2 + rows.length * LANE_H;

  const body = [];
  const laneTop = (ri) => PAD_Y + ri * LANE_H;
  // 行内几何：**波形区固定在顶部 30px 内**，剩下的全部留给行间空白。
  // 这样「高/低两条参考轨」与「时间轴」之间有 ≥16px 的空档——
  // 2026-10-29 三签实测：轴只比 0 轨低 7px 时，两条线会被读成同一回事
  // （「这条平线是高还是低」「低电平下方怎么还有一条线」都是这么来的）。
  const SWING = 22;           // 高电平与低电平的纵向间距（= 行内跳变高度）
  const hiOf = (ri) => laneTop(ri) + 8;
  const loOf = (ri) => laneTop(ri) + 8 + SWING;

  // 参考线画在最底层：贯穿全部行的细竖线，钉在格边界上。
  // 触发器题靠它读「CP 上升沿那一刻 S、R 是什么」，是读图手段不是装饰。
  if (guides.length) {
    body.push(`<g class="fig-guides" stroke="currentColor" stroke-width="0.8" stroke-dasharray="3 3" opacity="0.42">`);
    guides.forEach((g) => {
      const x = Math.round(PAD_X + g * CELL_W);
      body.push(`<line x1="${x}" y1="${PAD_Y - 4}" x2="${x}" y2="${height - PAD_Y + 4}"/>`);
    });
    body.push(`</g>`);
  }

  // 高低电平参考轨：每行在 1 与 0 两个高度各画一条浅色虚线。
  //
  // 2026-10-29 三签实测两个真问题，都出在缺这两条轨上：
  //   ① **常高与常低分不出来**。门(c) 的输出 Y ≡ 1（因为 C·0 = 0，取反是 1），
  //      整行是一条平线；没有参考轨，读者不知道这条线是高还是低，直接判错。
  //   ② **低电平段看起来是双线**。时间轴画在 `loOf+7`，只比低电平线低 7px，
  //      两线贴太近，被读成「还有一路信号」或「保持上一格」。
  // 有了参考轨，波形线与「1 轨」「0 轨」的相对位置就是判据；时间轴也挪到行底，
  // 不再贴着 0 轨。
  const RAIL_OPACITY = 0.18;
  body.push(`<g class="fig-rails" stroke="currentColor" stroke-width="1" ` +
            `stroke-dasharray="2 4" opacity="${RAIL_OPACITY}" fill="none">`);
  rows.forEach((row, ri) => {
    const x1 = PAD_X + slots * CELL_W;
    body.push(`<line x1="${PAD_X}" y1="${hiOf(ri)}" x2="${x1}" y2="${hiOf(ri)}"/>`);
    body.push(`<line x1="${PAD_X}" y1="${loOf(ri)}" x2="${x1}" y2="${loOf(ri)}"/>`);
  });
  body.push(`</g>`);

  // 时间轴：每行一条横轴（带箭头）与原点 O。原图每行都有，删掉读者不知道
  // 波形从哪开始、往哪走。
  // 轴放在**行底之下**（LANE_H-4），与 0 轨拉开距离，避免被当成第二路信号。
  if (axis) {
    const ax = [];
    rows.forEach((row, ri) => {
      const y = laneTop(ri) + LANE_H - 4;
      const x0 = PAD_X;
      const x1 = PAD_X + slots * CELL_W;
      ax.push(`<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}"/>`);
      ax.push(`<path d="M${x1 + 7} ${y} L${x1} ${y - 4} L${x1} ${y + 4}"/>`);
      ax.push(`<line x1="${AXIS_X}" y1="${hiOf(ri) - 5}" x2="${AXIS_X}" y2="${y}" opacity="0.5"/>`);
    });
    body.push(`<g class="fig-axis" stroke="currentColor" stroke-width="1" fill="none">${ax.join('')}</g>`);
  }

  // 波形：**逐行**一个 g，行级着色（两初态同色就看不出「自 CP₂ 起重合」）。
  rows.forEach((row, ri) => {
    const hi = hiOf(ri);
    const lo = loOf(ri);
    const stroke = row.color ? WAVE_COLORS[row.color] : 'currentColor';
    const pieces = [];
    let d = '';
    let prevY = null;
    row.cells.forEach((cell, ci) => {
      const x0 = PAD_X + ci * CELL_W;
      const x1 = x0 + CELL_W;
      if (cell === '-') {
        // 高阻：中间虚线，单独一段（不能留在实线 d 里，否则实线会被拉过去）
        if (d.trim()) { pieces.push(`<path d="${d.trim()}" />`); d = ''; }
        const mid = (hi + lo) / 2;
        pieces.push(
          `<line x1="${x0}" y1="${mid}" x2="${x1}" y2="${mid}" stroke-dasharray="4 3" opacity="0.55"/>`);
        prevY = mid;
        return;
      }
      const y = cell === '1' ? hi : lo;
      if (prevY === null) d += `M${x0} ${y} `;
      else if (prevY !== y) d += `V${y} `;
      d += `H${x1} `;
      prevY = y;
    });
    if (d.trim()) pieces.push(`<path d="${d.trim()}" />`);
    body.push(
      `<g class="fig-wave-row"${row.color ? ` data-color="${attrEsc(row.color)}"` : ''} ` +
      `fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linejoin="round">${pieces.join('')}</g>`);
  });

  body.push(`<g class="fig-labels" fill="currentColor" stroke="none" font-size="${font}" font-family="sans-serif">`);
  rows.forEach((row, ri) => {
    const y = laneTop(ri) + LANE_H / 2 + 4;
    // 行标签按行色一起着色：颜色既是曲线属性也是标签属性，读者才对得上
    const fill = row.color ? ` fill="${WAVE_COLORS[row.color]}"` : '';
    body.push(`<text x="8" y="${y}"${fill} data-label="${attrEsc(row.label)}">${labelToTspans(row.label)}</text>`);
  });
  // 时间轴刻度字：只标两端与 guides 的位置，避免字挤成一团
  if (axis) {
    const marks = new Set([0, slots, ...guides]);
    [...marks].sort((a, b) => a - b).forEach((g) => {
      const x = PAD_X + g * CELL_W;
      body.push(
        `<text x="${Math.round(x)}" y="${height - 6}" text-anchor="middle" ` +
        `font-size="${Math.max(8, font - 3)}" opacity="0.6">${g}</text>`);
    });
  }
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

// ════════════════════════════════════════════════════════════════
// ⑦ 绘制：net（模拟/电气电路）
// ════════════════════════════════════════════════════════════════

/** 元件符号在**局部坐标**里的引脚半长：引脚永远在 x = ±NET_PIN 处。
 *  所有符号都画成「横躺」的样子，竖放时整组 rotate(90)——只写一份几何，
 *  不会出现「横着画对、竖着画歪」。 */
const NET_PIN = 26;

/**
 * 元件符号（局部坐标，轴线沿 x，pin1 在 −x、pin2 在 +x）。
 *
 * 为什么用矩形电阻而不是锯齿：本课教材与全仓的门电路图都是 IEC 方框风格
 * （门是方框、框内写 AND/≥1），电阻也走 IEC 矩形，一套体系。
 * 混用 ANSI 锯齿会让同一批图看起来像两本书拼的。
 *
 * 每个符号只画「元件本体」，引脚引线由 drawNet 按实际位置画——引线长度随
 * 布局变化，符号必须与位置解耦，否则每个元件都要一份定制几何。
 */
const NET_SYMBOLS = {
  // 电阻：IEC 矩形（引线自 ±26 收到矩形两端，一条线不断）
  r: () => `<line x1="-26" y1="0" x2="-13" y2="0"/>` +
           `<rect x="-13" y="-7" width="26" height="14" rx="1"/>` +
           `<line x1="13" y1="0" x2="26" y2="0"/>`,

  // 电容：两平行极板（垂直于轴线）+ 引线
  c: () => `<line x1="-26" y1="0" x2="-4.5" y2="0"/>` +
           `<line x1="-4.5" y1="-11" x2="-4.5" y2="11"/>` +
           `<line x1="4.5" y1="-11" x2="4.5" y2="11"/>` +
           `<line x1="4.5" y1="0" x2="26" y2="0"/>`,

  // 电感：三个半圆沿轴线串联，两端引线补齐到 ±26
  l: () => `<line x1="-26" y1="0" x2="-18" y2="0"/>` +
           `<path d="M-18 0 a6 6 0 0 1 12 0 a6 6 0 0 1 12 0 a6 6 0 0 1 12 0"/>` +
           `<line x1="18" y1="0" x2="26" y2="0"/>`,

  // 电压源：圆 + 极性（+ 靠 pin1、− 靠 pin2）。
  // 极性必须画出来：不画极性的圆圈就是一个「不知道正负」的源，读者没法列方程。
  // 用笔画而不是 <text>：文字进 SVG 会被宿主的词条自动标注盯上（见文件头坑①），
  // 而且字形的正负号在不同字体下大小不一。
  v: () => `<line x1="-26" y1="0" x2="-15" y2="0"/>` +
           `<circle cx="0" cy="0" r="15"/>` +
           `<path d="M-12 -7H-4M-8 -11V-3"/>` +
           `<path d="M4 -7H12"/>` +
           `<line x1="15" y1="0" x2="26" y2="0"/>`,

  // 电流源：圆 + 方向箭头（pin1 → pin2）
  i: () => `<line x1="-26" y1="0" x2="-15" y2="0"/>` +
           `<circle cx="0" cy="0" r="15"/>` +
           `<path d="M-9 0H5"/>` +
           `<path d="M9 0 L3 -5 L3 5 Z" fill="currentColor" stroke="currentColor"/>` +
           `<line x1="15" y1="0" x2="26" y2="0"/>`,

  // 开关：断口 + 倾斜刀片（刀片没合上 = 断开，这就是「开关」的可辨识特征）
  sw: () => `<line x1="-26" y1="0" x2="-9" y2="0"/>` +
            `<circle cx="-9" cy="0" r="2.4" fill="currentColor" stroke="none"/>` +
            `<circle cx="9" cy="0" r="2.4" fill="currentColor" stroke="none"/>` +
            `<line x1="9" y1="0" x2="26" y2="0"/>` +
            `<line x1="-9" y1="0" x2="7" y2="-10"/>`,

  // 单刀双投：公共端在下（刀枢），两个触点在上（左=pin2、右=pin3）。
  // 刀片画到**实际接通的**那个触点——`pos` 由 DSL 末段给（1 或 2）。
  // 这一笔是这张图唯一的语义承载：刀不指对触点，读者就会判错通路。
  spdt: (pos) => {
    const up = 2;          // 触点所在的高度（负 = 向上）
    const tip = (pos === 2) ? { x: 9, y: -up } : { x: -9, y: -up };
    return `<line x1="0" y1="26" x2="0" y2="4"/>` +                       // 公共端引线
           `<circle cx="0" cy="4" r="2.4" fill="currentColor" stroke="none"/>` +  // 刀枢
           `<line x1="-9" y1="${-up}" x2="-9" y2="${-up - 8}"/>` +        // 左触点引线
           `<line x1="9" y1="${-up}" x2="9" y2="${-up - 8}"/>` +          // 右触点引线
           `<circle cx="-9" cy="${-up}" r="2.4" fill="currentColor" stroke="none"/>` +
           `<circle cx="9" cy="${-up}" r="2.4" fill="currentColor" stroke="none"/>` +
           `<line x1="0" y1="4" x2="${tip.x}" y2="${tip.y}"/>`;           // 刀片指向接通侧
  },

  // 二极管：三角形（pin1 是阳极）+ 阴极竖线
  d: () => `<line x1="-26" y1="0" x2="-8" y2="0"/>` +
           `<path d="M-8 -9 L-8 9 L8 0 Z" fill="currentColor" stroke="currentColor"/>` +
           `<line x1="8" y1="-9" x2="8" y2="9"/>` +
           `<line x1="8" y1="0" x2="26" y2="0"/>`,

  // 灯：圆圈里画 ×（教材的 ⊗ 记号）。
  // 不用 `r` 顶替：电阻是矩形、灯是 ⊗，题面按 ⊗ 写，图注与符号必须对得上。
  lamp: () => `<line x1="-26" y1="0" x2="-14" y2="0"/>` +
              `<circle cx="0" cy="0" r="14"/>` +
              `<line x1="-9.9" y1="-9.9" x2="9.9" y2="9.9"/>` +
              `<line x1="9.9" y1="-9.9" x2="-9.9" y2="9.9"/>` +
              `<line x1="14" y1="0" x2="26" y2="0"/>`,

  // 交流源：圆圈里画一条正弦。**不画 +/−**——画了就成了直流源，
  // 与图注「~220 V」矛盾（2026-10-29 用 `v` 顶替交流源时就是这个错）。
  vac: () => `<line x1="-26" y1="0" x2="-15" y2="0"/>` +
             `<circle cx="0" cy="0" r="15"/>` +
             `<path d="M-9 0 q4.5 -9 9 0 q4.5 9 9 0"/>` +
             `<line x1="15" y1="0" x2="26" y2="0"/>`,
};

/**
 * 每种元件**端子在自己的局部坐标里在哪**。绘制器按它牵引线。
 *
 * 为什么必须显式写：两脚元件习惯性地把端子放在轴线上 `(±26, 0)`，
 * 于是布线代码里到处是 `x = cx ± NET_PIN` 这种硬编码。单刀双投的三个端子
 * **一个都不在轴线上**（公共端 `(0, 26)` 在下方、两触点 `(±9, -10)` 在上方），
 * 硬编码的引线一条都接不上——2026-10-29 实测：7.05 的下联络线 `lo` 画出来
 * 导线数为 0，只剩一个孤立网络名。
 *
 * 顺序必须与 `pins` 一一对应（pins[0] 是主端子）。
 */
const NET_TERMINALS = {
  r:    [{ x: -26, y: 0 }, { x: 26, y: 0 }],
  c:    [{ x: -26, y: 0 }, { x: 26, y: 0 }],
  l:    [{ x: -26, y: 0 }, { x: 26, y: 0 }],
  v:    [{ x: -26, y: 0 }, { x: 26, y: 0 }],
  i:    [{ x: -26, y: 0 }, { x: 26, y: 0 }],
  sw:   [{ x: -26, y: 0 }, { x: 26, y: 0 }],
  d:    [{ x: -26, y: 0 }, { x: 26, y: 0 }],
  lamp: [{ x: -26, y: 0 }, { x: 26, y: 0 }],
  vac:  [{ x: -26, y: 0 }, { x: 26, y: 0 }],
  vcvs: [{ x: -26, y: 0 }, { x: 26, y: 0 }],
  vccs: [{ x: -26, y: 0 }, { x: 26, y: 0 }],
  ccvs: [{ x: -26, y: 0 }, { x: 26, y: 0 }],
  cccs: [{ x: -26, y: 0 }, { x: 26, y: 0 }],
  // 公共端在下、两触点在上：与 `NET_SYMBOLS.spdt` 的几何严格同一份数字
  spdt: [{ x: 0, y: 26 }, { x: -9, y: -10 }, { x: 9, y: -10 }],
};

/** 端子多于两个的元件（现在只有单刀双投）走专用布线分支。 */
const isMultiPin = (type) => (NET_TERMINALS[type] || []).length > 2;

/**
 * 受控源：菱形 + 输出量记号。
 *
 * 四型分开画，是因为「菱形里是 +/− 还是箭头」直接决定读者认成电压源还是电流源：
 *   · 电压输出（vcvs / ccvs）→ 菱形里 + −
 *   · 电流输出（vccs / cccs）→ 菱形里箭头
 * 而且竖放时整体 rotate(90)，+/− 自动变成「上正下负」，不需要第二套几何。
 *
 * 控制量（电压控 / 电流控）**不在菱形里画**——菱形太小，塞第四个记号就糊成一团。
 * 控制类型写在位号旁边（见 drawNet 的类型小字）：`VCVS` 这类四字母，
 * 读者一眼分清，比让他从符号细节里猜靠谱。
 */
function controlledSourceSymbol(type) {
  const diamond = `<line x1="-26" y1="0" x2="-19" y2="0"/>` +
                  `<path d="M-19 0 L0 -16 L19 0 L0 16 Z"/>` +
                  `<line x1="19" y1="0" x2="26" y2="0"/>`;
  const isCurrentOut = type === 'vccs' || type === 'cccs';
  const mark = isCurrentOut
    // 电流输出：箭头沿轴线指向 pin2
    ? `<path d="M-7 0H5"/><path d="M9 0 L3 -5 L3 5 Z" fill="currentColor" stroke="currentColor"/>`
    // 电压输出：+ 靠 pin1、− 靠 pin2
    : `<path d="M-11 -5H-3M-7 -9V-1"/><path d="M3 -5H11"/>`;
  return diamond + mark;
}

/** 取某个类型的符号串（受控源四型走同一个函数，参数区分）。 */
function netSymbol(type, pos) {
  if (type === 'vcvs' || type === 'vccs' || type === 'ccvs' || type === 'cccs') {
    return controlledSourceSymbol(type);
  }
  const fn = NET_SYMBOLS[type];
  return fn ? fn(pos) : '';
}

/**
 * 电路图的自动排布。
 *
 * ## 为什么按「网络分层」而不是按元件排
 *
 * 电路图的结构事实是**网络**（同一根导线上的所有引脚），不是元件顺序。
 * 所以把网络当节点、元件当边做 BFS 分层：跨层的元件竖放、同层的元件横放，
 * 这与教科书里「电源在左、负载在右、并联支路上下排开」的画法同构。
 * 元件顺序排则会把串联回路画成一条直线，并联处挤成一团。
 *
 * ## 走线为什么是正交的、且要单独分配「通道」
 *
 * 三签只看画面：斜线在电路图里等于「这里没画完」。所以所有导线只有水平/垂直段。
 * 竖直元件如果都落在网络自己的 x 上，同一个网络下挂两个元件就会重叠
 * （实测推演：串联回路的电源与第一只电阻会画在同一条竖线上，互相压住）。
 * 于是每层间隙里给元件分配独立通道 x，两端再用短横段接到网络点上。
 *
 * ## 同层横向元件为什么要抬高走线
 *
 * 同层两个网络如果中间还夹着别的网络点，直接沿本行画线会**经过别人的引脚**——
 * 读者会读成「这里接上了」，那是另一张电路。所以这种情况把线抬到本行上方的
 * 走线带里，横向段专门避开所有网络点。交叉（无圆点）在电路图里是公认的「不相连」。
 */
function drawNet(payload, opts = {}) {
  const { comps, nets } = payload;
  const font = opts.fontSize || 12;
  const ROW_H = 130;
  const COL_W = 120;
  const LEAD = (ROW_H - NET_PIN * 2) / 2;   // 竖直元件两端引线长度
  const JOG = 13;                           // 端点折线距本行的偏移

  const netNames = nets.map((n) => n.name);
  const netPins = new Map(nets.map((n) => [n.name, n.pins]));

  // 画布包围盒：所有图元都往里登记，最后按真实范围设 viewBox。
  // 不在布局前拍一个「大概够大」的宽度——构建期猜字宽两次都错过（见 drawLogic 注释）。
  const bb = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  const grow = (x, y) => {
    if (x < bb.x1) bb.x1 = x;
    if (y < bb.y1) bb.y1 = y;
    if (x > bb.x2) bb.x2 = x;
    if (y > bb.y2) bb.y2 = y;
  };
  // 文字按「每字 0.6 字号」估宽，只用于包围盒（真实宽度由客户端 getBBox 校正）
  const growText = (x, y, text, anchor = 'start', size = font) => {
    const w = String(text).replace(/[~^]/g, '').length * size * 0.6;
    const x0 = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
    grow(x0, y - size);
    grow(x0 + w, y + size * 0.35);
  };

  // ── ① 网络图 + BFS 分层
  //
  // 邻接表按**全部引脚**建，不是只认前两个。三脚元件（单刀双投）以前只登记
  // pins[0]/pins[1]，第三脚进了网络表却从不接进邻接表 ⇒ 那条网络一根导线都不画，
  // 只剩一个孤立网络名标签（2026-10-29 子代理实测：7.05 的下联络线 `lo` 导线数为 0）。
  // 图 7.05 没有这条线就不成立（刀只能从一侧接通，灯永远不亮），是错图不是缺图。
  const adj = new Map();
  for (const net of netNames) adj.set(net, []);
  for (const c of comps) {
    c.pins.forEach((p, i) => {
      if (!adj.has(p)) adj.set(p, []);
      // 每个引脚与「其余引脚」相连：电路里一只元件就是若干个端子之间的一条通路
      c.pins.forEach((q, j) => {
        if (i !== j) adj.get(p).push({ ref: c.ref, other: q, pin: j + 1 });
      });
    });
  }
  // BFS：从一个网络出发，每过一只元件加一层。这就是「电源 → 第一级 → 第二级」的
  // 电气深度，竖放/横放由此决定（跨层＝竖放、同层＝横放）。
  // 独立回路（与已排部分不连通）另起一轮，排在右边而不是叠在原点。
  const rank = new Map();
  const order = [];
  for (const start of netNames) {
    if (rank.has(start)) continue;
    rank.set(start, 0);
    order.push(start);
    const queue = [start];
    while (queue.length) {
      const n = queue.shift();
      for (const e of adj.get(n)) {
        if (!rank.has(e.other)) {
          rank.set(e.other, rank.get(n) + 1);
          order.push(e.other);
          queue.push(e.other);
        }
      }
    }
  }

  const rowsNets = [];
  for (const n of order) {
    const r = rank.get(n);
    if (!rowsNets[r]) rowsNets[r] = [];
    rowsNets[r].push(n);
  }

  // ── ② 每层内定 x：优先继承上级网络的位置（父子同 x ⇒ 竖直元件是直线）
  const xOf = new Map();
  const yOf = (r) => r * ROW_H + ROW_H / 2;
  rowsNets.forEach((list, r) => {
    if (!list) return;
    const claimed = new Set();      // 本层已被某个子网络继承走的上级网络
    let cursor = null;
    list.forEach((n) => {
      let desire = null;
      if (r > 0) {
        for (const e of adj.get(n)) {
          if (rank.get(e.other) === r - 1 && xOf.has(e.other) && !claimed.has(e.other)) {
            desire = xOf.get(e.other);
            claimed.add(e.other);
            break;
          }
        }
      }
      let x;
      if (desire === null) {
        x = cursor === null ? 0 : cursor + COL_W;
      } else {
        x = cursor === null ? desire : Math.max(desire, cursor + COL_W);
      }
      // 最小间距：横向元件的符号 + 两端引线要放得下
      xOf.set(n, Math.round(x));
      cursor = Math.round(x);
    });
  });

  // ── ③ 竖直元件分配通道 x（同一层间隙里不许两条竖线重合）
  const vChannels = new Map();     // gap 索引 → Set(已用 x)
  const compChannel = new Map();   // comp.ref → {x, up:boolean, upNet, downNet}
  for (const c of comps) {
    if (isMultiPin(c.type)) continue;   // 三脚走 ③b 专用分支
    const r0 = rank.get(c.pins[0]);
    const r1 = rank.get(c.pins[1]);
    if (r0 === r1) continue;       // 同层 → 横向，另行处理
    const upNet = r0 < r1 ? c.pins[0] : c.pins[1];
    const downNet = r0 < r1 ? c.pins[1] : c.pins[0];
    const gap = rank.get(upNet);
    if (!vChannels.has(gap)) vChannels.set(gap, new Set());
    const used = vChannels.get(gap);
    const base = xOf.get(upNet);
    let x = base;
    let k = 1;
    while (used.has(x)) { x = base + k * (COL_W / 2); k += 1; }
    used.add(x);
    compChannel.set(c.ref, { x, upNet, downNet });
  }

  // ── ③b 多脚元件（单刀双投）：主轴是 pins[0]，其余引脚各自牵一根正交引线
  //
  // 以前这里完全没有分支：三脚元件被当成两脚处理，第三脚进了网络表却
  // **一根线都不画**（2026-10-29 实测，7.05 的下联络线 `lo` 导线数为 0）。
  // 那张图少一条联络线 = 两只开关只有一侧能通 = 灯永远不亮，是错图。
  //
  // 摆法是「pins[0] 朝行、其余朝另一侧」：元件中心放在 pins[0] 所在行与
  // 其余引脚最深层之间，旋转按「对端在哪边」决定（见下面 rot 的取舍）。
  const multiLayout = new Map();   // comp.ref → {x, cy, rot, r0, rMax}
  for (const c of comps) {
    if (!isMultiPin(c.type)) continue;
    const r0 = rank.get(c.pins[0]);
    const rMax = Math.max(...c.pins.slice(1).map((p) => rank.get(p)));
    if (!vChannels.has(r0)) vChannels.set(r0, new Set());
    const used = vChannels.get(r0);
    const base = xOf.get(c.pins[0]);
    let x = base;
    let k = 1;
    while (used.has(x)) { x = base + k * (COL_W / 2); k += 1; }
    used.add(x);
    const cy = rMax === r0 ? yOf(r0) - ROW_H / 2 : (yOf(r0) + yOf(rMax)) / 2;
    // rot=180 ⇒ 局部 (0,26) 的 pins[0] 转到上方；rot=0 ⇒ 留在下方。
    // 对端在下方就用前者，在上方就用后者——**pins[0] 永远朝向自己那一行**。
    const rot = rMax >= r0 ? 180 : 0;
    multiLayout.set(c.ref, { x, cy, rot, r0, rMax });
  }

  const body = [];
  body.push(`<g class="fig-net" fill="none" stroke="currentColor" stroke-width="1.6" ` +
            `stroke-linecap="round" stroke-linejoin="round">`);

  // ── ④ 先把所有导线画在底下（元件压在线上面，接头处干净）
  const wire = (net, d) => {
    body.push(`<path class="fig-wire" data-net="${esc(net)}" d="${d}" />`);
  };

  // 竖直元件：上端点 → 通道 → 下端点
  for (const c of comps) {
    const ch = compChannel.get(c.ref);
    if (!ch) continue;
    const yU = yOf(rank.get(ch.upNet));
    const yD = yOf(rank.get(ch.downNet));
    const xU = xOf.get(ch.upNet);
    const xD = xOf.get(ch.downNet);
    // 通道与网络点同 x 时不要写 `H0`（零长度段）：视觉上没区别，但 SVG 里
    // 多一个退化子路径，有些渲染器会给零长度水平段画出一个小 tick。
    const lead = (net, xFrom, yFrom, chX, yJog, yPin) => {
      const jog = chX === xFrom ? `V${yJog}` : `V${yJog} H${chX}`;
      wire(net, `M${xFrom} ${yFrom} ${jog} V${yPin}`);
    };
    lead(ch.upNet, xU, yU, ch.x, yU + JOG, yU + LEAD);
    lead(ch.downNet, xD, yD, ch.x, yD - JOG, yD - LEAD);
    grow(xU, yU); grow(xD, yD); grow(ch.x, yU + LEAD); grow(ch.x, yD - LEAD);
    grow(Math.min(xU, ch.x), yU + JOG); grow(Math.max(xU, ch.x), yU + JOG);
    grow(Math.min(xD, ch.x), yD - JOG); grow(Math.max(xD, ch.x), yD - JOG);
  }

  // 横向元件（两端在同层）：符号本身就跨 ±26，所以两端引脚直接落在
  // 「中点 ∓ 26」上，到网络点之间补一段水平引线——**永远不需要斜线**。
  const trackIndex = new Map();
  const hLayout = new Map();       // comp.ref → {x, y, leftNet, rightNet}
  for (const c of comps) {
    if (compChannel.has(c.ref)) continue;
    if (multiLayout.has(c.ref)) continue;   // 三脚已由 ③b 摆好
    const [n1, n2] = c.pins;
    const x1 = xOf.get(n1);
    const x2 = xOf.get(n2);
    const leftNet = x1 <= x2 ? n1 : n2;
    const rightNet = x1 <= x2 ? n2 : n1;
    const xa = Math.min(x1, x2);
    const xb = Math.max(x1, x2);
    const rowY = yOf(rank.get(n1));
    const midX = (xa + xb) / 2;
    // 本行还有别的网络点落在 (xa, xb) 之间吗？有就必须抬高——
    // 沿本行直穿会经过别人的引脚，读者会读成「这里接上了」，那是另一张电路。
    const blocked = (rowsNets[rank.get(n1)] || []).some((n) => {
      const x = xOf.get(n);
      return n !== n1 && n !== n2 && x > xa - 1 && x < xb + 1;
    });
    let yy = rowY;
    if (blocked) {
      const k = (trackIndex.get(rank.get(n1)) || 0) + 1;
      trackIndex.set(rank.get(n1), k);
      yy = rowY - 34 - (k - 1) * 22;   // 走线带：本行上方，避开竖直元件下端
      // 两端各竖起来到走线带，再水平接到引脚——三段正交
      wire(leftNet, `M${xa} ${rowY} V${yy} H${midX - NET_PIN}`);
      wire(rightNet, `M${xb} ${rowY} V${yy} H${midX + NET_PIN}`);
      grow(xa, rowY); grow(xb, rowY); grow(xa, yy); grow(xb, yy);
    } else {
      // 水平引线：网络点 → 引脚（符号自己含 ±26 的引线，这里只补差额）
      if (midX - NET_PIN > xa) wire(leftNet, `M${xa} ${rowY} H${midX - NET_PIN}`);
      if (xb > midX + NET_PIN) wire(rightNet, `M${midX + NET_PIN} ${rowY} H${xb}`);
      grow(xa, rowY); grow(xb, rowY);
    }
    hLayout.set(c.ref, { x: midX, y: yy, leftNet, rightNet });
  }

  // 多脚元件（单刀双投）：每个引脚从自己的局部端子牵一根正交线到所属网络点。
  // 端子位置取自 NET_TERMINALS，与符号几何是同一份数字——这样「画出来的触点」
  // 与「接线的触点」不可能对不上（错开一格就是一张接错线的图）。
  for (const c of comps) {
    const ml = multiLayout.get(c.ref);
    if (!ml) continue;
    const terms = NET_TERMINALS[c.type];
    // 元件整体旋转后，局部端子在画布上的位置要跟着转
    const rad = (ml.rot * Math.PI) / 180;
    const rotPt = (p) => ({
      x: ml.x + p.x * Math.cos(rad) - p.y * Math.sin(rad),
      y: ml.cy + p.x * Math.sin(rad) + p.y * Math.cos(rad),
    });
    c.pins.forEach((net, idx) => {
      const t = rotPt(terms[idx]);
      const nx = xOf.get(net);
      const ny = yOf(rank.get(net));
      // 先竖到本端子高度、再横到网络点 x、再竖落到网络点：
      // 全程正交，无斜线（本模块的电路图里斜线一律读作「没画完」）。
      const jx = nx === t.x ? '' : `H${nx}`;
      wire(net, `M${t.x} ${t.y} V${ny} ${jx}`.replace(/\s+/g, ' ').trim());
      grow(t.x, t.y); grow(nx, ny);
    });
    growText(ml.x, ml.cy, c.ref);
  }

  body.push(`</g>`);
  body.push(`<g class="fig-netnames" fill="currentColor" stroke="none" ` +
            `font-size="${Math.max(9, font - 3)}" font-family="sans-serif">`);
  for (const net of netNames) {
    const x = xOf.get(net);
    const y = yOf(rank.get(net));
    const label = String(net);
    body.push(`<text x="${x - 6}" y="${y - 7}" text-anchor="end">${labelToTspans(label)}</text>`);
    growText(x - 6, y - 7, label, 'end', Math.max(9, font - 3));
    // 三条以上支路的节点画实心圆点：电路图里「有圆点＝接上」，不画点读者会
    // 把三岔口当成跨线。两分支是拐角，不需要点。
    if (netPins.get(net).length >= 3) {
      body.push(`<circle class="fig-junction" cx="${x}" cy="${y}" r="3.2" ` +
                `fill="currentColor" stroke="none"/>`);
    }
  }
  body.push(`</g>`);

  // ── ⑤ 元件
  // 先把每只元件的落点算出来存一份：受控源的控制端要牵到它测的那两个网络点上，
  // 而网络点坐标是已知的，得在这次循环里取用。
  const centerOf = new Map();
  // ⚠️ 这层必须显式写 `fill="none" stroke="currentColor"`。
  // SVG 形状默认 `fill:black`，漏掉就是：电压源变成实心黑圆、电阻变成黑条、
  // 二极管只剩一个黑三角（阴极横杠被填掉看不见）——2026-10-29 子代理用真实
  // 构建产物 + 站点 CSS + headless Chromium 截图实测，符号全部不可辨。
  // 全仓 CSS 没有任何兜底，所以写在元素上（与上面 fig-net 分组同一套属性）。
  body.push(`<g class="fig-comps" fill="none" stroke="currentColor" stroke-width="1.6" ` +
            `stroke-linecap="round" stroke-linejoin="round">`);
  for (const c of comps) {
    const ch = compChannel.get(c.ref);
    const ml = multiLayout.get(c.ref);
    let cx; let cy; let rot;
    if (ml) {
      cx = ml.x;
      cy = ml.cy;
      rot = ml.rot;
    } else if (ch) {
      cx = ch.x;
      cy = (yOf(rank.get(ch.upNet)) + yOf(rank.get(ch.downNet))) / 2;
      // pin1 在上：局部 −x 转到上方 ⇒ rotate(90)。pin1 在下则反向。
      rot = ch.upNet === c.pins[0] ? 90 : -90;
    } else {
      const l = hLayout.get(c.ref);
      cx = l.x;
      cy = l.y;
      rot = l.leftNet === c.pins[0] ? 0 : 180;
    }
    centerOf.set(c.ref, { x: cx, y: cy, rot });
    // 每个引脚都要写 data-pinN：交互面板靠它回答「这个元件接在哪几个网络上」。
    // 三脚元件以前只输出 pin1/pin2，第三脚既没线也没属性，面板上看不出它接了什么。
    const pinAttrs = c.pins
      .map((p, i) => ` data-pin${i + 1}="${attrEsc(p)}"`).join('');
    body.push(
      `<g class="fig-comp" data-comp="${attrEsc(c.ref)}" data-type="${attrEsc(c.type)}"` +
      pinAttrs +
      (c.ctrlPins ? ` data-ctrl1="${attrEsc(c.ctrlPins[0])}" ` +
                    `data-ctrl2="${attrEsc(c.ctrlPins[1])}"` : '') +
      ` transform="translate(${cx} ${cy}) rotate(${rot})">` +
      netSymbol(c.type, c.pos) + `</g>`);
    grow(cx - NET_PIN, cy - NET_PIN); grow(cx + NET_PIN, cy + NET_PIN);
  }
  body.push(`</g>`);

  // ── ⑤b 受控源的控制端：虚线（非导线）+ 控制量记号
  //
  // 受控源的意义就是「输出由别处某个量决定」。只画一个写 VCVS 的菱形，
  // 读者不知道控制量取在哪两点之间，题就做不出来。所以从菱形向它的两个
  // 控制网络各牵一根**虚线**，中间标 `U` / `I`。
  //
  // 为什么是虚线而不是导线：电路图里实线一律读作「电气相连」。控制端不取电流
  // （压控）或测的是别处支路电流（流控），都不是电气连接。实线会让读者判错拓扑。
  // 也正因为不是导线，这里**不挂 fig-wire / data-net**：交互面板把它当网络高亮
  // 会给出错误的「连了几处端点」。
  //
  // 为什么走折线而不是两点直连：斜线在本模块的电路图里一律读作「没画完」
  // （与导线同一个不变量）。控制线也走正交折线——先向下出本体，再水平到
  // 目标网络点，最后垂直落到点上。两条控制线各占一个出线高度，不重合。
  const ctrlLines = [];
  for (const c of comps) {
    if (!c.ctrlPins) continue;
    const from = centerOf.get(c.ref);
    if (!from) continue;
    const def = NET_COMPONENTS[c.type];
    const mark = def.ctrl === 'v' ? 'U' : 'I';
    c.ctrlPins.forEach((net, idx) => {
      const tgt = { x: xOf.get(net), y: yOf(rank.get(net)) };
      // 出线高度错开：两条控制线共用一个起点，不错开就叠成一条
      const outY = from.y + NET_PIN + 12 + idx * 11;
      ctrlLines.push(
        `<path d="M${from.x} ${from.y + 16} V${outY} H${tgt.x} V${tgt.y}" ` +
        `stroke-dasharray="5 4" opacity="0.65"/>`);
      grow(from.x, outY); grow(tgt.x, outY); grow(tgt.x, tgt.y);
    });
    // 标号放在菱形下方出线处：那里只有控制线，不会压字
    const lx = from.x;
    const ly = from.y + NET_PIN + 8;
    ctrlLines.push(
      `<text x="${lx}" y="${ly}" text-anchor="middle" class="fig-ctrl-label" ` +
      `font-size="${Math.max(9, font - 2)}">${labelToTspans(mark)}</text>`);
    growText(lx, ly, mark, 'middle', Math.max(9, font - 2));
  }
  if (ctrlLines.length) {
    body.push(`<g class="fig-ctrls" fill="none" stroke="currentColor" stroke-width="1.2">` +
             ctrlLines.join('') + `</g>`);
  }

  // ── ⑥ 位号与数值（横放标在元件上方，竖放标在右侧）
  body.push(`<g class="fig-compnames" fill="currentColor" stroke="none" ` +
            `font-size="${font}" font-family="sans-serif">`);
  for (const c of comps) {
    const ch = compChannel.get(c.ref);
    const ml = multiLayout.get(c.ref);
    const hasValue = c.value && c.value !== '-';
    const isControlled = isControlledType(c.type);
    if (ml) {
      // 三脚元件：位号标在元件正中上方，数值在它下面（两侧都是引线，标中间不压线）
      const lx = ml.x;
      const ly = ml.cy - NET_PIN + 2;
      body.push(`<text x="${lx}" y="${ly}" text-anchor="middle">${labelToTspans(c.ref)}</text>`);
      growText(lx, ly, c.ref, 'middle');
      if (hasValue) {
        body.push(`<text x="${lx}" y="${ly + 13}" text-anchor="middle">${labelToTspans(c.value)}</text>`);
        growText(lx, ly + 13, c.value, 'middle');
      }
    } else if (ch) {
      const cy = (yOf(rank.get(ch.upNet)) + yOf(rank.get(ch.downNet))) / 2;
      const lx = ch.x + NET_PIN + 6;
      body.push(`<text x="${lx}" y="${cy - 5}">${labelToTspans(c.ref)}</text>`);
      growText(lx, cy - 5, c.ref);
      let ly = cy + 10;
      if (hasValue) {
        body.push(`<text x="${lx}" y="${ly}">${labelToTspans(c.value)}</text>`);
        growText(lx, ly, c.value);
        ly += 15;
      }
      if (isControlled) {
        body.push(`<text x="${lx}" y="${ly}" font-size="${Math.max(9, font - 2)}">${esc(c.type.toUpperCase())}</text>`);
        growText(lx, ly, c.type.toUpperCase(), 'start', Math.max(9, font - 2));
      }
    } else {
      const l = hLayout.get(c.ref);
      body.push(`<text x="${l.x}" y="${l.y - 10}" text-anchor="middle">${labelToTspans(c.ref)}</text>`);
      growText(l.x, l.y - 10, c.ref, 'middle');
      let ly = l.y + 18;
      if (hasValue) {
        body.push(`<text x="${l.x}" y="${ly}" text-anchor="middle">${labelToTspans(c.value)}</text>`);
        growText(l.x, ly, c.value, 'middle');
        ly += 15;
      }
      if (isControlled) {
        body.push(`<text x="${l.x}" y="${ly}" text-anchor="middle" font-size="${Math.max(9, font - 2)}">${esc(c.type.toUpperCase())}</text>`);
        growText(l.x, ly, c.type.toUpperCase(), 'middle', Math.max(9, font - 2));
      }
    }
  }
  body.push(`</g>`);

  // 规范化到正象限再出 viewBox：包围盒生长过程中会出现负坐标（BFS 分层把
  // 第 0 层放在 y=ROW_H/2，向上折的引脚就成了负 y），viewBox 带负原点会让
  // 客户端 getBBox 校正后仍然偏移。整体平移 body，viewBox 从 (0,0) 起。
  const M = 16;
  const dx = Math.round(-(bb.x1 - M));
  const dy = Math.round(-(bb.y1 - M));
  const w = Math.round(bb.x2 - bb.x1 + M * 2);
  const h = Math.round(bb.y2 - bb.y1 + M * 2);
  // body 是一个 <g>…</g> 序列，整体套一层 translate 最省事且不动内部坐标
  const shifted = `<g transform="translate(${dx} ${dy})">${body.join('')}</g>`;
  return {
    viewBox: `0 0 ${w} ${h}`,
    body: shifted,
  };
}

// ════════════════════════════════════════════════════════════════
// ⑦b 绘制：plot（模拟波形，连续幅值）
// ════════════════════════════════════════════════════════════════

/**
 * 模拟波形：连续幅值曲线，不是 0/1 电平。
 *
 * 与 `wave` 的关键差别：
 *   · y 是**连续量**（伏特），不是两档；所以必须有 yrange 刻度与参考电平线；
 *   · 允许 `ghost` 线（浅色虚线）画「本来该长什么样」——限幅题的读法就是
 *     细线对粗线，缺了这条线读者不知道被削掉多少；
 *   · 削顶用真的取 min/max 实现，不是「画个平台」近似。
 */
function drawPlot(payload, opts = {}) {
  const { rows, slots, yrange, grid, refs } = payload;
  const font = opts.fontSize || 12;
  const LANE_H = 120;
  const PAD_X = 58;
  const PAD_Y = 22;
  const WAVE_W = 660;                 // 波形区宽度（与 wave 的目标宽度一致）
  const CELL_W = WAVE_W / slots;
  const width = PAD_X + WAVE_W + 26;
  const height = PAD_Y * 2 + rows.length * LANE_H + 16;
  const [yLo, yHi] = yrange;
  const yOf = (v) => (yHi - v) / (yHi - yLo);      // 0..1，0 在顶

  const body = [];

  rows.forEach((row, ri) => {
    const top = PAD_Y + ri * LANE_H;
    const h = LANE_H - 26;
    const yPix = (v) => top + yOf(v) * h;
    const x0 = PAD_X;
    const x1 = PAD_X + WAVE_W;

    // ── 参考电平（±10 V 这类）：虚线，贯穿该行
    if (refs.length) {
      body.push(`<g class="fig-plot-ref" stroke="currentColor" stroke-width="0.9" ` +
                `stroke-dasharray="5 4" opacity="0.5">`);
      refs.forEach((v) => {
        if (v < row.axis[0] || v > row.axis[1]) return;
        body.push(`<line x1="${x0}" y1="${yPix(v).toFixed(1)}" x2="${x1}" y2="${yPix(v).toFixed(1)}"/>`);
      });
      body.push(`</g>`);
      // 参考电平的字：贴着右端写，读者不用回图注找「虚线是多少伏」
      body.push(`<g class="fig-plot-reflabels" fill="currentColor" stroke="none" ` +
                `font-size="${Math.max(9, font - 2)}" font-family="sans-serif">`);
      refs.forEach((v) => {
        if (v < row.axis[0] || v > row.axis[1]) return;
        const yy = yPix(v);
        body.push(`<text x="${x1 + 4}" y="${(yy + 3).toFixed(1)}">${v > 0 ? `+${v}` : v} V</text>`);
      });
      body.push(`</g>`);
    }

    // ── 基准线（0 V）：浅实线
    if (grid !== null && grid >= row.axis[0] && grid <= row.axis[1]) {
      body.push(`<line class="fig-plot-grid" x1="${x0}" y1="${yPix(grid).toFixed(1)}" ` +
                `x2="${x1}" y2="${yPix(grid).toFixed(1)}" stroke="currentColor" ` +
                `stroke-width="1" opacity="0.28"/>`);
    }

    // ── 曲线：按格采样，削顶用真 min/max
    // 采样密度取 slots 的两倍（下限 64）：正弦要画得顺滑，但点数太多只会撑大 HTML。
    row.curves.forEach((c) => {
      const pts = [];
      const N = Math.max(64, slots * 2);
      const lim = c.kind === 'clip' ? Math.abs(c.param) : null;
      // sine 的第二个参数是周期数；clip 的第二个参数是限幅值，
      // 所以 clip 固定画一个周期（限幅图的题面就是一个周期）。
      const cycles = c.kind === 'clip' ? 1 : (c.param || 1);
      for (let i = 0; i <= N; i += 1) {
        const t = i / N;
        const raw = c.amp * Math.sin(2 * Math.PI * cycles * t);
        const v = lim === null ? raw : Math.max(-lim, Math.min(lim, raw));
        pts.push(`${(x0 + t * WAVE_W).toFixed(1)},${yPix(v).toFixed(1)}`);
      }
      const cls = `fig-plot-curve${c.ghost ? ' is-ghost' : ''}`;
      body.push(
        `<polyline class="${cls}" points="${pts.join(' ')}" fill="none" stroke="currentColor" ` +
        `stroke-width="${c.ghost ? 1.1 : 2.2}"` +
        (c.ghost ? ' stroke-dasharray="5 4" opacity="0.45"' : ' stroke-linejoin="round"') + '/>');
    });

    // ── 纵轴刻度：上下界各标一次（题面只要读者看出削到几伏，不需要密刻度）
    body.push(`<line class="fig-plot-axis" x1="${x0}" y1="${yPix(row.axis[0]).toFixed(1)}" ` +
              `x2="${x0}" y2="${yPix(row.axis[1]).toFixed(1)}" stroke="currentColor" ` +
              `stroke-width="1" opacity="0.5"/>`);
    body.push(`<g class="fig-plot-labels" fill="currentColor" stroke="none" ` +
              `font-size="${Math.max(9, font - 2)}" font-family="sans-serif">`);
    [row.axis[0], row.axis[1]].forEach((v) => {
      body.push(`<text x="${x0 - 6}" y="${(yPix(v) + 3).toFixed(1)}" text-anchor="end">${v} V</text>`);
    });
    body.push(`</g>`);

    // ── 行名（u_i / u_O）：左上角，与波形不打架
    body.push(`<text class="fig-plot-rownames" x="4" y="${(top + 12).toFixed(1)}" ` +
              `fill="currentColor" stroke="none" font-size="${font}" ` +
              `font-family="sans-serif">${labelToTspans(row.label)}</text>`);
  });

  return {
    viewBox: `0 0 ${Math.round(width)} ${Math.round(height)}`,
    body: body.join(''),
  };
}

const KIND_DRAWERS = {
  logic: drawLogic,
  wave: drawWave,
  kmap: drawKmap,
  net: drawNet,
  plot: drawPlot,
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
  // 表格是**一组**而不是一张：net 要两张（元件表 + 网络表），其它图种一张。
  // 先前硬把「网络」当表体里的一行推，结果表头是元件四列、网络行也挤在里面，
  // 列数对不上——表格被读成「网络是某个元件的属性」，拓扑就没了。
  // 形状统一成「表头 + 行」的数组数组，最后逐张渲染，谁也不必迁就谁。
  const tables = [];
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
    ir.payload.rows.forEach((r) => {
      const extra = [];
      if (r.color) extra.push(`配色 ${r.color}`);
      if (r.term) extra.push(`词条 ${r.term}`);
      rows.push([r.label + (extra.length ? `（${extra.join('，')}）` : ''), r.levels, String(r.slots)]);
    });
    // 参考线与时间轴是**读图依据**，AI 也要能读到，否则它只能数电平串自己推
    if (ir.payload.guides && ir.payload.guides.length) {
      rows.push(['参考线', ir.payload.guides.join('、'), '格边界']);
    }
  } else if (ir.kind === 'kmap') {
    rows.push(['行 \\ 列', ...ir.payload.colCodes]);
    ir.payload.cells.forEach((line, r) => {
      rows.push([ir.payload.rowCodes[r], ...line.split('')]);
    });
    if (ir.payload.boxes.length) {
      rows.push(['圈组', ...ir.payload.boxes.map(
        (b, i) => `#${i + 1}: 行${b.r[0]}–${b.r[1]} 列${b.c[0]}–${b.c[1]}`)]);
    }
  } else if (ir.kind === 'net') {
    // 元件表回答「图里有什么」，网络表回答「谁和谁接在一起」。
    // 两张表缺一张，AI 就读不出拓扑——只看元件表会以为所有引脚都无处可去，
    // 只看网络表会丢元件类型。
    //
    // 控制端单列一栏而不是塞进引脚栏：它**不是**电气引脚（不进网络表），
    // 混在一起会让 AI 把控制点当成「接了根线」，拓扑就错了。
    // 非受控元件这一栏写 `—`，而不是留空——留空看起来像「漏了没填」。
    const { comps, nets } = ir.payload;
    rows.push(['元件', '类型', '引脚1', '引脚2', '控制端']);
    comps.forEach((c) => {
      const def = NET_COMPONENTS[c.type];
      rows.push([
        c.ref,
        `${def.label}（${c.type}）`,
        c.pins[0],
        c.pins[1],
        c.ctrlPins
          ? `${c.ctrlPins[0]}、${c.ctrlPins[1]}（取${def.ctrl === 'v' ? '电压' : '电流'}）`
          : '—',
      ]);
    });
    tables.push(rows);
    const netRows = [['网络', '连到的引脚', '引脚数']];
    nets.forEach(({ name, pins }) => {
      netRows.push([
        name,
        pins.map((p) => `${p.ref} 的 ${p.pin} 脚`).join('、'),
        String(pins.length),
      ]);
    });
    tables.push(netRows);
  }
  if (rows.length >= 2) tables.push(rows);
  return tables
    .map((t) => {
      const head = t[0].map((h) => `<th>${esc(h)}</th>`).join('');
      const body = t.slice(1)
        .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
        .join('');
      return `<table class="fig-structure-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    })
    .join('');
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
          `（可用：${[...LOGIC_OPS].join('、')}、wave、kmap、net、plot）`);
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
    const unattrEsc = (s) => s
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const byLabel = new Map((ir.symbols || []).map((sym) => [sym.label, sym]));
    let inner = body;
    if (byLabel.size) {
      // 匹配靠 **data-label 属性**，不靠解析渲染后的文本。
      // 原因：`^R^~D~` 这种带上下划线的标签渲染出来是嵌套 <tspan>，
      // 按 `<text>(纯文本)</text>` 去匹配根本匹配不到（2026-10-29 实测：
      // 触发器波形给 R̄D 挂词条时锚点完全没生成，而 logic 的 `^B^` 也一样）。
      // 绘制期在 <text> 上写 data-label="原始记号"，这里按它精确对齐 IR 里的 label。
      inner = body.replace(
        /<text([^>]*)>([\s\S]*?)<\/text>/g,
        (whole, attrs, content) => {
          const m = attrs.match(/data-label="([^"]*)"/);
          const label = m ? unattrEsc(m[1]) : (content.includes('<') ? null : content);
          if (label === null) return whole;
          const sym = byLabel.get(label);
          const spans = content;
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
