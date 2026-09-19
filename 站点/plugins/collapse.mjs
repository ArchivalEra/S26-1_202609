/**
 * 折叠块（collapse panels）—— 独立可拆卸模块
 *
 * 语法与 Shirone 生态（My-Shirone-Plugins / Shirone-personalized 的
 * remarkCollapsePanels）兼容，便于以后迁移或复用：
 *
 *   :::collapse accordion
 *   - 提示 1：先看第 3 行与第 1 行有什么关系 :+
 *     把它写成两个行列式之和，让其中一列出现两个 0。
 *   - 提示 2：造零之后怎么办 :-
 *     按那一列展开，降成 2 阶。
 *   :::
 *
 * 选项：
 *   accordion  同组只允许展开一个（用原生 <details name=...> 实现）
 *   expand     渲染为默认展开
 * 列表项标记：
 *   :+  该项默认展开
 *   :-  该项默认收起
 * 面板锚点：
 *   {#id} 写在标题行尾（与 :+/:- 谁前谁后都行），渲染为 <details id="...">，
 *   让别的页面能深链接到具体面板，例如 [xxx](攻略.md#pass-1-2)。
 *   id 只认 ASCII 字母开头的字母/数字/下划线/连字符；不合法的 {#…} 原样保留。
 *   注意：锚点只负责定位，收起面板被跳到时默认不会自动展开——
 *   自动展开由独立模块 disclosure-anchor.mjs（客户端渐进增强）负责，
 *   本模块自己保持零 JavaScript。
 *
 * 产物是**原生 <details>/<summary>**，不产生任何 JavaScript，
 * 也没有客户端水合——这是从 Shirone 的 createDisclosure 学来的做法
 * （其源码注释原话：compose without hydration）。
 *
 * ============================ 为什么这样实现 ============================
 *
 * 1) 处理阶段：本模块必须在「公式已提取、链接尚未处理」之间运行。
 *    在 站点/build.mjs 里的调用点是 Step 2 之后、Step 3 之前。
 *    理由：
 *      - 那时 `$$…$$` 与 `$…$` 已经变成单行占位符 @@MATH_*_N@@，
 *        所以折叠块内部的数学**自动可用**，本模块根本不需要懂公式语法；
 *      - 代码围栏与行内代码也已保护，`:::` 出现在代码里不会被误转；
 *      - 链接降级/重写还没跑，折叠块内的链接会被后续步骤正常处理。
 *
 * 2) 必须避开的一个真实坑：**`<summary>` 之后、`</details>` 之前必须留空行**。
 *    否则 marked 会把整块当成 raw HTML 整体透传，内部的 `**粗体**`、
 *    行内代码、列表都不会被解析——实测踩到过。
 *    本模块因此在 summary 行后与闭合标签前各插入一个空行。
 *
 * 3) 嵌套：用**深度计数**匹配闭合的 `:::`，不用非贪婪正则——
 *    非贪婪会把内层 `:::` 与外层错配。
 *
 * 4) 可拆卸：本文件是唯一实现，调用点是 build.mjs 里的一行。
 *    删掉本文件 + 摘掉那一行，构建即回到改造前状态，不残留任何东西。
 *
 * 5) **不支持嵌套**（有意为之）。折叠块的体里若再写 `:::collapse`，
 *    它会被原样保留在面板正文里，不会被递归转换——`:::` 在 Markdown
 *    里只是普通文本，最终显示成字面量。教学场景不需要折叠套折叠
 *    （套得越深学生越迷路），所以不做，也不假装能做。
 *    深度计数只用于**正确配对闭合**（避免内层 `:::` 把外层提前收尾）。
 */

const OPEN_RE = /^[\t ]{0,3}:{3,}[\t ]*collapse(?:[\t ]+(.*?))?[\t ]*$/i;
const CLOSE_RE = /^[\t ]{0,3}:{3,}[\t ]*$/;
const FENCE_RE = /^[\t ]{0,3}(`{3,}|~{3,})/;
const ALLOWED_OPTIONS = new Set(["accordion", "expand"]);

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** 把一段 Markdown 正文缩进剥离（保留相对缩进）。 */
function dedent(lines) {
  const indents = lines
    .filter((l) => l.trim() !== "")
    .map((l) => (l.match(/^[\t ]*/) || [""])[0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(cut));
}

/**
 * 解析折叠块体：若首行是列表项，则每个**顶格**列表项变成一个面板；
 * 否则整块作为单个面板，标题取首行。
 *
 * 缩进处理很讲究：不能先用 dedent 把整体左移再判断顶格——
 * 那样列表项下的正文（原本缩进 2 格）会被剥到与列表项同级，
 * 子列表也会被误判成新面板。所以先用**原始行**按「是否顶格」切分，再逐个去缩进。
 */
function parseItems(bodyLines) {
  const firstNonEmptyIdx = bodyLines.findIndex((l) => l.trim() !== "");
  if (firstNonEmptyIdx < 0) return [{ title: "展开", bodyLines: [], open: false }];
  const isList = /^[-*+][\t ]+/.test(bodyLines[firstNonEmptyIdx]);

  if (!isList) {
    return [
      {
        title: bodyLines[firstNonEmptyIdx].trim(),
        bodyLines: bodyLines.slice(firstNonEmptyIdx + 1),
        open: false,
      },
    ];
  }

  const items = [];
  let cur = null;
  for (const line of bodyLines) {
    const isTopLevelItem = /^[-*+][\t ]+/.test(line); // 必须是顶格（无前导空白）
    if (isTopLevelItem) {
      if (cur) items.push(cur);
      cur = { title: line.replace(/^[-*+][\t ]+/, ""), bodyLines: [], open: false };
    } else if (cur) {
      cur.bodyLines.push(line);
    }
  }
  if (cur) items.push(cur);

  // 各面板体分别去缩进（只剥公共前导空白，保留子列表的相对缩进）
  return items.map((it) => ({ ...it, bodyLines: dedent(it.bodyLines) }));
}

/** 标题行尾的锚点 {#id}：只认 ASCII 字母开头、字母/数字/下划线/连字符组成。 */
const TRAILING_ID_RE = /[\t ]*\{#([A-Za-z_][A-Za-z0-9_-]*)\}[\t ]*$/;

/**
 * 从标题尾部剥掉 `:+` / `:-` 标记与 `{#id}` 锚点，二者谁前谁后都认。
 * 都靠「行尾」锚定并循环剥离，所以只吃行尾的标记，不会误伤标题中间
 * 恰好长得像标记的文本；不合法的 `{#…}`（如空 id、带空格）原样保留。
 */
function stripTitleDecor(title) {
  let cur = title.trim();
  let open = false;
  let id = null;
  for (;;) {
    const m = cur.match(/[\t ]*[：:]([+-])[\t ]*$/);
    if (m) {
      cur = cur.slice(0, m.index).trim();
      // 全角冒号「：」也要认——手写中文时很容易打成全角（本攻略就踩过，
      // 残留的「：-」在标题里显示成一个小点）。
      open = m[1] === "+";
      continue;
    }
    const a = cur.match(TRAILING_ID_RE);
    if (a) {
      cur = cur.slice(0, a.index).trim();
      id = a[1];
      continue;
    }
    break;
  }
  return { title: cur, open, id };
}

/**
 * 主转换：把 Markdown 里的 `:::collapse` 块替换成原生 `<details>` HTML。
 * 不匹配的 `:::` 原样保留（不会动普通的冒号文本）。
 */
export function renderCollapse(source) {
  if (typeof source !== "string" || !source.includes("collapse")) return source;

  const lines = source.split(/\r?\n/);
  const out = [];
  let fence = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 跟踪代码围栏：围栏内的 `:::` 一律不动
    const f = line.match(FENCE_RE);
    if (f) {
      const marker = f[1];
      if (!fence) {
        fence = { ch: marker[0], len: marker.length };
      } else if (
        marker[0] === fence.ch &&
        marker.length >= fence.len &&
        new RegExp(`^[\\t ]{0,3}${fence.ch}{${fence.len},}[\\t ]*$`).test(line)
      ) {
        fence = null;
      }
      out.push(line);
      i++;
      continue;
    }
    if (fence) {
      out.push(line);
      i++;
      continue;
    }

    const open = line.match(OPEN_RE);
    if (!open) {
      out.push(line);
      i++;
      continue;
    }

    // 解析选项（大小写不敏感；非法选项按无选项处理，不改写原文）
    const rawOpts = (open[1] || "").trim().split(/[\t ]+/).filter(Boolean);
    const opts = rawOpts.map((o) => o.toLowerCase());
    const accordion = opts.includes("accordion");
    const expandAll = opts.includes("expand");

    // 用深度计数找配对的闭合 :::
    const body = [];
    let depth = 1;
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (OPEN_RE.test(l)) {
        depth++;
        body.push(l);
        continue;
      }
      if (CLOSE_RE.test(l)) {
        depth--;
        if (depth === 0) {
          closed = true;
          break;
        }
        body.push(l);
        continue;
      }
      body.push(l);
    }
    if (!closed) {
      // 没闭合：原样输出，绝不吞掉后面整篇内容
      out.push(line);
      i++;
      continue;
    }

    const items = parseItems(body);
    const groupName = `collapse-${out.length}-${i}`;
    const parts = [];

    for (const it of items) {
      const { title, open: marked, id } = stripTitleDecor(it.title);
      const isOpen = marked || expandAll;
      const attrs = [
        `class="m3-disclosure"`,
        id ? `id="${esc(id)}"` : "",
        isOpen ? "open" : "",
        accordion ? `name="${esc(groupName)}"` : "",
      ]
        .filter(Boolean)
        .join(" ");

      // 标题内的行内 Markdown（粗体/代码）不解析——与宿主行为一致，
      // 所以这里只做 HTML 转义；正文则交给后续 marked 正常解析。
      parts.push(
        `<details ${attrs}>`,
        `<summary class="m3-disclosure__summary">` +
          `<span class="m3-disclosure__indicator" aria-hidden="true"></span>` +
          `<span class="m3-disclosure__title">${esc(title)}</span>` +
          `</summary>`,
        // 空行：让 marked 把内部当 Markdown 解析而不是 raw HTML 整块透传
        "",
        ...it.bodyLines,
        "",
        `</details>`,
        "",
      );
    }

    out.push(...parts);
    i = j + 1;
  }

  return out.join("\n");
}
