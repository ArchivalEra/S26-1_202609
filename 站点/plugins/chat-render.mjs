/**
 * 聊天消息渲染管线（纯函数，不碰 DOM）。
 *
 * ## 为什么单独一个模块
 *
 * 流式 Markdown + 公式的边界情况（未闭合代码块、表格跨块、`$` 与货币符号）很容易
 * 写出「看着对但边缘会崩」的代码。把**解析**与**挂载**分开：
 *
 *   本模块：文本 → 块 → 操作序列（op[]）      ← 可测，纯函数
 *   面板模块：op[] → DOM 节点                  ← 只能靠浏览器
 *
 * 接口只有两个：
 *   parseIncremental(buffer) → { blocks, rest }   已完整的块 + 还没闭合的尾巴
 *   renderBlockToOps(block)  → op[]               一个块 → 操作序列
 *
 * ## 为什么不用 streaming-markdown
 *
 * 计划里说「先用它，不行就自写」。调研后发现两个问题：
 *   ① 它是 WIP，公式没有稳定的 token 契约；
 *   ② 它**确实**处理 `div`/`span`/`a`/`img` —— 所以「事件流里没有 HTML 所以安全」
 *      这个前提不成立，还得自己加协议白名单。
 * 既然安全层要自己写、公式要自己识别，那不如整个解析器自己写：聊天的 Markdown
 * 子集很小（段落/标题/列表/代码块/表格/强调/链接/公式），自写 300 行可控可测。
 *
 * ## 安全不变量（测试守着）
 *
 *   I1  **不产出 HTML 字符串**。op 只带结构化数据；唯一例外是公式块的 `html`
 *       字段，它只接收 katex.renderToString 的产出（由面板负责注入）。
 *   I2  链接协议白名单：href 只允许 http/https/mailto/#。
 *   I3  图片只允许同源相对路径（不产出外链 img）。
 *   I4  任何原始 HTML 标签一律按**文本**处理（不解析、不转发）。
 */

// ── 常量 ────────────────────────────────────────────────────

/** 单条消息上限（防 ReDoS / 防面板卡死）。 */
export const MAX_MESSAGE_CHARS = 20000;

/** 允许的链接协议。 */
const SAFE_HREF_RE = /^(https?:\/\/|mailto:|#)/i;

/**
 * 单个 `$` 是否当公式起点的判据（pandoc 规则）：
 * 前面不能是数字或字母（否则 `$5` 是货币），后面不能是空白。
 */
export function isMathOpen(text, i) {
  const prev = i > 0 ? text[i - 1] : '';
  const next = text[i + 1] || '';
  if (/[0-9A-Za-z]/.test(prev)) return false;
  if (/\s/.test(next)) return false;
  return true;
}

// ── 块级解析 ────────────────────────────────────────────────

/**
 * 增量解析：把累积的文本切成「已完成的块」+「还没闭合的尾巴」。
 *
 * 判据：一个块什么时候算完整？
 *   · 段落 —— 遇到空行
 *   · 标题 —— 单行，遇到换行即完整
 *   · 代码块 —— 遇到闭合的 ``` 围栏
 *   · 表格 —— 连续的行都含 `|`，遇到非表格行或空行结束
 *   · 公式块（$$…$$）—— 遇到闭合的 $$
 *   · 列表 —— 连续的行都以 `- ` / `* ` / `1. ` 开头
 *
 * 未闭合的块留在 `rest` 里，下一轮 delta 到来时继续累积。这样**已渲染的块
 * 永远不会被重排**（不闪烁）。
 *
 * `restStart` 是 `rest` 在入参里的起点。调用方存下它，下一次只把
 * `buffer.slice(restStart)` 交回本函数——流式长消息因此从 O(n²) 降到 O(n)。
 * 解析是严格从左到右、块与块互不影响，所以从块边界续解与整段重解等价。
 *
 * @param {string} buffer 累积的全部文本
 * @returns {{blocks: Array<{kind:string, ...}>, rest: string, restStart: number}}
 */
export function parseIncremental(buffer) {
  const text = String(buffer || '').slice(0, MAX_MESSAGE_CHARS);
  const blocks = [];
  let i = 0;
  const n = text.length;

  /** 从 i 起读一行（含行尾换行），返回 {line, next}。 */
  const readLine = (at) => {
    const nl = text.indexOf('\n', at);
    if (nl < 0) return { line: text.slice(at), next: n, complete: false };
    return { line: text.slice(at, nl), next: nl + 1, complete: true };
  };

  while (i < n) {
    // ① 空行：跳过
    if (text[i] === '\n') { i += 1; continue; }

    // ② 代码块围栏
    if (text.startsWith('```', i)) {
      const open = readLine(i);
      const lang = open.line.slice(3).trim();
      let j = open.next;
      let body = '';
      let closed = false;
      while (j < n) {
        const l = readLine(j);
        if (!l.complete) break;                    // 最后一行没有换行 → 未闭合
        if (l.line.trim() === '```') { j = l.next; closed = true; break; }
        body += l.line + '\n';
        j = l.next;
      }
      if (!closed) return { blocks, rest: text.slice(i), restStart: i };
      blocks.push({ kind: 'code', lang, text: body.replace(/\n$/, '') });
      i = j;
      continue;
    }

    // ③ 块级公式 $$…$$
    if (text.startsWith('$$', i)) {
      const end = text.indexOf('$$', i + 2);
      if (end < 0) return { blocks, rest: text.slice(i), restStart: i };
      const tex = text.slice(i + 2, end).trim();
      if (tex) blocks.push({ kind: 'math', tex, display: true });
      i = end + 2;
      continue;
    }

    // ④ 裸写的 \begin{…}…\end{…}：模型常这么写，包成块级公式
    if (text.startsWith('\\begin{', i)) {
      const env = text.slice(i + 7).match(/^([a-zA-Z*]+)\}/);
      if (env) {
        const close = '\\end{' + env[1] + '}';
        const end = text.indexOf(close, i);
        if (end < 0) return { blocks, rest: text.slice(i), restStart: i };
        const tex = text.slice(i, end + close.length);
        blocks.push({ kind: 'math', tex, display: true });
        i = end + close.length;
        continue;
      }
    }

    // ⑤ 标题
    const hm = text.slice(i).match(/^(#{1,6})[ \t]+([^\n]*)\n/);
    if (hm) {
      blocks.push({ kind: 'h', level: hm[1].length, text: hm[2].trim() });
      i += hm[0].length;
      continue;
    }

    // ⑥ 表格：当前行含 `|`，且下一行是分隔行
    const line1 = readLine(i);
    if (line1.line.includes('|') && line1.complete) {
      const line2 = readLine(line1.next);
      const isSep = /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(line2.line) && line2.complete;
      if (isSep) {
        const rows = [splitRow(line1.line)];
        let j = line2.next;
        let terminated = false;   // 遇到了表格之外的行（或空行）⇒ 表格确实结束了
        while (j < n) {
          const l = readLine(j);
          if (!l.complete) { j = -1; break; }           // 最后一行未结束 → 等下一个 delta
          if (!l.line.includes('|') || l.line.trim() === '') { terminated = true; break; }
          rows.push(splitRow(l.line));
          j = l.next;
        }
        // j === -1 表示撞到不完整的尾巴；没 terminated 表示读到了文本末尾（也没结束）
        if (j < 0 || (!terminated && j >= n)) return { blocks, rest: text.slice(i), restStart: i };
        blocks.push({ kind: 'table', header: rows[0], rows: rows.slice(1) });
        i = j;
        continue;
      }
    }

    // ⑦ 列表：连续的行以 `- `/`* `/`N. ` 开头
    // ⚠️ 2026-10-22 修：必须允许**前导缩进**。上游模型的回答里嵌套子列表很常见
    // （`1. **最紧急**：…` 下面跟 `   - 子项 A`），旧正则 `^(?:[-*]|\d+\.)`
    // 匹配不到缩进行 ⇒ 列表提前 terminated ⇒ 后续内容全被吞进段落，
    // 面板上会看到字面的 "   - 子项 A\n   - 子项 B\n3. "。
    // 现在记录每项的缩进层级（depth），渲染侧据此嵌套。
    const li0 = text.slice(i).match(/^([ \t]*)(?:[-*]|\d+\.)[ \t]+/);
    if (li0) {
      const items = [];
      let j = i;
      let terminated = false;
      while (j < n) {
        const l = readLine(j);
        if (!l.complete) { j = -1; break; }             // 最后一行未结束 → 等
        const m = l.line.match(/^([ \t]*)(?:[-*]|\d+\.)[ \t]+(.*)$/);
        if (!m) { terminated = true; break; }
        // 缩进 → 层级（每 2 空格或 1 tab 算一级，上限 4 级防跑飞）
        const indent = m[1].replace(/\t/g, '  ').length;
        const depth = Math.min(4, Math.floor(indent / 2));
        items.push({ text: m[2], depth });
        j = l.next;
      }
      if (j < 0 || (!terminated && j >= n)) return { blocks, rest: text.slice(i), restStart: i };
      blocks.push({ kind: 'list', ordered: /^\d/.test(li0[0].trim()), items });
      i = j;
      continue;
    }

    // ⑧ 段落：读到空行或特殊块开头为止
    {
      let j = i;
      let buf = '';
      let hitSpecial = false;
      while (j < n) {
        const l = readLine(j);
        if (!l.complete) break;                         // 最后一行未结束 → 先不渲染
        if (l.line.trim() === '') { j = l.next; break; }
        if (/^(#{1,6}[ \t]|```|\$\$|\\begin\{)/.test(l.line)) { hitSpecial = true; break; }
        buf += (buf ? '\n' : '') + l.line;
        j = l.next;
      }

      // ⚠️ 两种情况必须分开处理（2026-10-19 实测死循环）：
      //   · 撞到特殊块开头（且段内还没内容）⇒ 不能 i=j（j 没动），
      //     要落到下面「兜底前进」——但那会让特殊块被当文本吃掉。
      //     正确做法：直接 continue，让外层重新进入分支判断（i 未变，但下一轮会走 ②-⑦）。
      //     为避免再次进入段落分支，这里在撞特殊块且 buf 为空时**显式跳过一行**的语义不对，
      //     所以我们改为：撞特殊块时把已累积的段落先产出，然后 i 前进到 j；
      //     若 buf 为空（i 本身就是特殊块开头）说明上面的 ②-⑦ 没匹配上，
      //     那是未支持的语法（如 `> 引用`），兜底当普通段落吃掉一行。
      if (buf) {
        blocks.push({ kind: 'p', text: buf });
        i = j;
        continue;
      }
      if (hitSpecial) {
        // 走到了这里说明 ②-⑦ 都不认这个「特殊块」（例如 `> 引用`、`---` 分隔线）。
        // 兜底：吃一整行当段落，保证 i 前进。行没结束时**不能**吃掉——
        // 否则不完整的半行会被当成一段渲染，补全后再来一遍就重了。
        const l = readLine(i);
        if (!l.complete) return { blocks, rest: text.slice(i), restStart: i };
        const raw = l.line.trim();
        if (raw) blocks.push({ kind: 'p', text: raw });
        i = l.next;
        continue;
      }
      // 段落没遇到空行就到底了 ⇒ 还没完整，整段留 rest 等下一个 delta。
      // ⚠️ 判据是「最后一行的 readLine 不完整」（没有换行符），不是 j >= n——
      // 后者在 `'x'`（长度 1、j=0）时为假，会 i=j=0 死循环（2026-10-19 实测）。
      const last = readLine(j === i ? i : Math.max(i, j - 1));
      if (!last.complete) return { blocks, rest: text.slice(i), restStart: i };
      i = j;
    }
  }

  return { blocks, rest: '', restStart: n };
}

/** 拆表格行：`| a | b |` → ['a','b']。 */
export function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

// ── 行内解析 ────────────────────────────────────────────────

/**
 * 行内文本 → op 序列。
 *
 * op 类型：
 *   {kind:'text', text}                     纯文本
 *   {kind:'strong'|'em'|'code', text}       强调/行内代码
 *   {kind:'math', tex, display:false}       行内公式
 *   {kind:'link', href, text}               链接（href 已白名单校验）
 *
 * 未闭合的 `$` / `**` / `` ` `` 留在尾巴里，返回 `pendingTail` 让调用方保留。
 *
 * @param {string} src
 * @returns {{ops: Array, pendingTail: string}}
 */
export function parseInline(src) {
  const s = String(src || '');
  const ops = [];
  let i = 0;
  let textBuf = '';
  const flush = () => { if (textBuf) { ops.push({ kind: 'text', text: textBuf }); textBuf = ''; } };

  while (i < s.length) {
    const ch = s[i];

    // 转义
    if (ch === '\\' && i + 1 < s.length) {
      textBuf += s[i + 1];
      i += 2;
      continue;
    }

    // 行内公式 $…$
    if (ch === '$' && isMathOpen(s, i)) {
      const end = findClosingDollar(s, i + 1);
      if (end < 0) {
        // 未闭合：整段尾巴留着（流式时会补上）
        flush();
        return { ops, pendingTail: s.slice(i) };
      }
      const tex = s.slice(i + 1, end);
      if (tex.trim()) { flush(); ops.push({ kind: 'math', tex: tex.trim(), display: false }); }
      else textBuf += s.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    // 行内代码 `…`
    if (ch === '`') {
      const end = s.indexOf('`', i + 1);
      if (end < 0) { flush(); return { ops, pendingTail: s.slice(i) }; }
      flush();
      ops.push({ kind: 'code', text: s.slice(i + 1, end) });
      i = end + 1;
      continue;
    }

    // 粗体 **…**
    if (s.startsWith('**', i)) {
      const end = s.indexOf('**', i + 2);
      if (end < 0) { flush(); return { ops, pendingTail: s.slice(i) }; }
      flush();
      ops.push({ kind: 'strong', text: s.slice(i + 2, end) });
      i = end + 2;
      continue;
    }

    // 斜体 *…*（避开 ** ）
    if (ch === '*' && s[i + 1] !== '*') {
      const end = s.indexOf('*', i + 1);
      if (end > i + 1 && s[end + 1] !== '*') {
        flush();
        ops.push({ kind: 'em', text: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // 链接 [text](href)
    if (ch === '[') {
      const m = s.slice(i).match(/^\[([^\]]*)\]\(([^)\s]*)\)/);
      if (m) {
        const href = safeHref(m[2]);
        flush();
        if (href) ops.push({ kind: 'link', href, text: m[1] });
        else textBuf += m[1];       // 不安全协议：只留文字
        i += m[0].length;
        continue;
      }
    }

    // 图片 ![alt](src)：只接受同源相对路径，否则丢弃
    if (ch === '!' && s[i + 1] === '[') {
      const m = s.slice(i).match(/^!\[([^\]]*)\]\(([^)\s]*)\)/);
      if (m) {
        const src = safeSrc(m[2]);
        flush();
        if (src) ops.push({ kind: 'img', src, alt: m[1] });
        else textBuf += m[1];
        i += m[0].length;
        continue;
      }
    }

    textBuf += ch;
    i += 1;
  }

  flush();
  return { ops, pendingTail: '' };
}

/** 找行内公式的闭合 `$`（跳过转义的 `\$`）。 */
export function findClosingDollar(s, from) {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') { i += 1; continue; }
    if (s[i] === '$') {
      // 闭合 $ 后面不能紧跟数字（`$5 and $10` 这种）
      const next = s[i + 1] || '';
      if (/[0-9]/.test(next)) continue;
      return i;
    }
  }
  return -1;
}

/** 链接协议白名单（I2）。返回 null 表示丢弃。 */
export function safeHref(href) {
  const h = String(href || '').trim();
  if (!h) return null;
  if (!SAFE_HREF_RE.test(h)) return null;
  // 额外拦一下 javascript: 的变形（虽然上面的正则已经排除）
  if (/^javascript:/i.test(h)) return null;
  return h;
}

/** 图片只允许同源相对路径（I3）。 */
export function safeSrc(src) {
  const s = String(src || '').trim();
  if (!s) return null;
  if (/^(https?:)?\/\//i.test(s)) return null;   // 外链图丢弃
  if (/^data:/i.test(s)) return null;            // data URI 也丢弃（体积与安全）
  if (/^javascript:/i.test(s)) return null;
  return s;
}

// ── 块 → op 序列 ────────────────────────────────────────────

/**
 * 把一个块渲染成操作序列。公式块的 `html` 由调用方（面板）用 KaTeX 填。
 *
 * @param {object} block parseIncremental 产出的块
 * @returns {Array<object>} op 序列
 */
export function renderBlockToOps(block) {
  if (!block) return [];
  switch (block.kind) {
    case 'h':
      return [{ kind: 'heading', level: block.level, ops: parseInline(block.text).ops }];
    case 'p':
      return [{ kind: 'para', ops: parseInline(block.text).ops }];
    case 'list':
      return [{
        kind: 'list',
        ordered: !!block.ordered,
        // items 现为 {text, depth}（2026-10-22 嵌套支持）；兼容旧形态的纯字符串
        items: block.items.map((it) => {
          const text = typeof it === 'string' ? it : it.text;
          const depth = typeof it === 'string' ? 0 : (it.depth || 0);
          return { ops: parseInline(text).ops, depth };
        }),
      }];
    case 'code':
      return [{ kind: 'codeblock', lang: block.lang || '', text: block.text }];
    case 'math':
      return [{ kind: 'mathblock', tex: block.tex }];
    case 'table':
      return [{
        kind: 'table',
        header: block.header.map((c) => parseInline(c).ops),
        rows: block.rows.map((r) => r.map((c) => parseInline(c).ops)),
      }];
    default:
      return [];
  }
}

// ── 调试/测试辅助 ───────────────────────────────────────────

/** 把 op 序列拍成纯文本（测试断言用）。 */
export function opsToText(ops) {
  const one = (o) => {
    switch (o.kind) {
      case 'text': case 'strong': case 'em': case 'code': return o.text;
      case 'math': return '$' + o.tex + '$';
      case 'link': return '[' + o.text + '](' + o.href + ')';
      case 'img': return '![' + o.alt + '](' + o.src + ')';
      default: return '';
    }
  };
  return (ops || []).map((o) => {
    if (o.kind === 'heading' || o.kind === 'para') return o.ops.map(one).join('');
    if (o.kind === 'list') return o.items.map((it) => {
      // 2026-10-22：items 是 {ops, depth}；兼容旧的纯 op 数组形态
      const arr = it && it.ops ? it.ops : (Array.isArray(it) ? it : []);
      return arr.map(one).join('');
    }).join(' | ');
    if (o.kind === 'codeblock') return '```' + o.lang + '\n' + o.text + '\n```';
    if (o.kind === 'mathblock') return '$$' + o.tex + '$$';
    if (o.kind === 'table') return [o.header, ...o.rows].map((r) => r.map((c) => c.map(one).join('')).join(' | ')).join(' / ');
    return one(o);
  }).join('\n');
}
