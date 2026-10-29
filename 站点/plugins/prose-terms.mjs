/**
 * 正文符号取词：词条围栏解析、页面级排除、正文自动取词、符号总表、客户端气泡脚本。
 *
 * ## 与 站点/math/ 的分工（2026-10-29 重构后）
 *
 * `站点/math/` 管**公式内部**的符号：它有自己的 TeX 解析器，判定发生在 IR 树上。
 * 本文件管**正文里**的符号：正文是 Markdown 文本（不是 TeX），`$X$` 之外的
 * `B`、`p_Fe` 这些写法要靠文本匹配包成令牌——这是另一类问题，不该塞进 TeX 解析器。
 *
 * ## 从 math-glossary.mjs 拆出来的原因
 *
 * 原文件 867 行里混着两代机制：KaTeX 时代的 `glossifyTex`（往 TeX 字符串里插
 * `\\htmlData` 宏取词）与正文取词。前者已被 `站点/math/terms.mjs` 取代，
 * 留着只会让后来人以为还要用。这里只保留**仍在服务正文**的部分。
 */

const DICT_OPEN_RE = /^[\t ]{0,3}:::glossary-dict(?:[\t ]+([A-Za-z][A-Za-z0-9_-]*))?[\t ]*$/;
/** 自动取词声明：`id | 正文形式（、分隔）| TeX 形式（、分隔，可省）`。 */
const MATCH_OPEN_RE = /^[\t ]{0,3}:::glossary-match[\t ]*$/;
const CLOSE_RE = /^[\t ]{0,3}:{3,}[\t ]*$/;
const FENCE_RE = /^[\t ]{0,3}(`{3,}|~{3,})/;
const TERM_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** 行内令牌：[tex]{#id} 或跨包强制 [tex]{#包名:id}（包名可中文，id 仍限 ASCII）。 */
const TOKEN_RE = /\[([^\][\n]+)\]\{#(?:([^\][{}:\n]+):)?([A-Za-z_][A-Za-z0-9_-]*)\}/g;

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * 解析一行词典词条：`id | 标题 | 文本`（文本里可再含 |，按前两根切分）。
 * 缺字段或 id 不合法返回 null——跳过，不猜。
 *
 * **v2 多义项**（2026-10-11）：文本里可写「语境：…」段声明**同一个符号的不同含义**——
 * 一个符号不该被一门课独占名字（$Z$ 在电路原理是阻抗、在电机学是槽数；$\\varphi$ 在
 * 电路原理是功率因数角、在电机学是磁通瞬时值）。义项写法：
 *
 *     sym-Z | Z | 阻抗；槽数 | 电路原理=阻抗 $Z=R+jX$；电机学=槽数
 *
 * 即：第 4 段起（或文本段内）用 `语境=含义`、多个义项用 `；` 分隔。
 * 解析成 `senses: [{ctx, text}]`——渲染时**列出全部义项、标出语境**，
 * 当前页面所属语境的义项排在最前。**单义词条不受影响**（没有 senses）。
 */

const SENSE_SPLIT_RE = /[;；]/;
const SENSE_RE = /^\s*([^=＝]{1,24})\s*[=＝]\s*(.+)$/;

function parseSenses(text) {
  // 义项段用「；」分隔，每段形如「语境=含义」；只要有一段不成形，就整条不当作多义
  // （宁可不拆，也不把普通释义误判成义项）。
  const parts = String(text || "").split(SENSE_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const senses = [];
  for (const p of parts) {
    const m = p.match(SENSE_RE);
    if (!m) return null;
    senses.push({ ctx: m[1].trim(), text: m[2].trim() });
  }
  return senses;
}

function parseDictLine(line) {
  const parts = line.split("|");
  if (parts.length < 3) return null;
  const id = parts[0].trim();
  if (!TERM_ID_RE.test(id)) return null;
  const title = parts[1].trim();
  // v2：第 3 段是**总述**（单义词条的释义）；第 4 段起若形如「语境=含义；语境=含义」
  // 则整体当**义项**（此时第 3 段仍是总述，气泡里先显示它、再列各义项）。
  const head = parts[2].trim();
  const tail = parts.slice(3).join("|").trim();
  const senses = parseSenses(tail);
  return { id, title, text: senses ? head : parts.slice(2).join("|").trim(), senses };
}

/**
 * 从 Markdown 源里解析 :::glossary-dict 围栏，返回 { id: {title, text} }。
 * 跟踪代码围栏（围栏内的 ::: 不算数）；重复 id 后者覆盖前者。
 */

export function parseGlossaryDict(source) {
  const dict = {};
  if (typeof source !== "string") return dict;
  const lines = source.split(/\r?\n/);
  let fence = null;
  let inDict = false;
  for (const line of lines) {
    const f = line.match(FENCE_RE);
    if (f) {
      const marker = f[1];
      if (!fence) fence = { ch: marker[0], len: marker.length };
      else if (marker[0] === fence.ch && marker.length >= fence.len) fence = null;
      continue;
    }
    if (fence) continue;
    if (!inDict) {
      if (DICT_OPEN_RE.test(line)) inDict = true;
      continue;
    }
    if (CLOSE_RE.test(line)) {
      inDict = false;
      continue;
    }
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const entry = parseDictLine(line);
    if (entry) {
      const e = { title: entry.title, text: entry.text };
      if (entry.senses) e.senses = entry.senses;
      dict[entry.id] = e;
    }
  }
  return dict;
}

/**
 * 解析 :::glossary-match 围栏：`id | 正文形式（、分隔）| TeX 形式（、分隔，可省）`。
 * 返回 { id: { prose: [...], tex: [...] } }——声明了形式，正文与公式里的符号才会**自动**取词。
 * 没声明的词条只能靠手写令牌，这是刻意的：自动取词只在内容侧明确点名时才发生。
 */

export function parseGlossaryMatch(source) {
  const out = {};
  if (typeof source !== "string") return out;
  const lines = source.split(/\r?\n/);
  let fence = null;
  let inMatch = false;
  const list = (s) => String(s || "").split(/[、,，]/).map((x) => x.trim()).filter(Boolean);
  for (const line of lines) {
    const f = line.match(FENCE_RE);
    if (f) {
      const marker = f[1];
      if (!fence) fence = { ch: marker[0], len: marker.length };
      else if (marker[0] === fence.ch && marker.length >= fence.len) fence = null;
      continue;
    }
    if (fence) continue;
    if (!inMatch) {
      if (MATCH_OPEN_RE.test(line)) inMatch = true;
      continue;
    }
    if (CLOSE_RE.test(line)) {
      inMatch = false;
      continue;
    }
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const parts = line.split("|");
    if (parts.length < 2) continue;
    const id = parts[0].trim();
    if (!TERM_ID_RE.test(id)) continue;
    out[id] = { prose: list(parts[1]), tex: list(parts[2]) };
  }
  return out;
}

/**
 * 剥掉全部 :::glossary-dict 与 :::glossary-match 围栏（数据块不该出现在正文里）。
 * `:::glossary-dict table` 且给了 onTable 时，围栏原位置留下 onTable(entries) 的产物
 * （entry 按围栏里的书写顺序），供符号入门页把词典本身列成表。
 * @param {string[]} lines
 * @param {((entries: {id: string, title: string, text: string}[]) => string) | null} [onTable]
 */

function stripDictFences(lines, onTable = null) {
  const out = [];
  let fence = null;
  let inDict = false;
  let asTable = false;
  let entries = [];
  const flush = () => {
    if (asTable && onTable && entries.length) out.push(onTable(entries));
  };
  for (const line of lines) {
    const f = line.match(FENCE_RE);
    if (f) {
      const marker = f[1];
      if (!fence) fence = { ch: marker[0], len: marker.length };
      else if (marker[0] === fence.ch && marker.length >= fence.len) fence = null;
      out.push(line);
      continue;
    }
    if (fence) {
      out.push(line);
      continue;
    }
    if (!inDict) {
      const open = line.match(DICT_OPEN_RE);
      if (open) {
        inDict = true;
        asTable = open[1] === "table";
        entries = [];
        continue;
      }
      if (MATCH_OPEN_RE.test(line)) {
        inDict = true;
        asTable = false;
        entries = [];
        continue;
      }
      out.push(line);
      continue;
    }
    if (CLOSE_RE.test(line)) {
      inDict = false;
      flush();
      asTable = false;
      entries = [];
      continue;
    }
    if (asTable) {
      const entry = parseDictLine(line);
      if (entry) entries.push(entry);
    }
  }
  return out;
}

/**
 * 正文自动取词：把词典声明过的**正文形式**（`entry.prose`，见 :::glossary-match）包成令牌，
 * 交给 TOKEN_RE 统一处理。没声明的词条仍只能手写令牌——自动取词只在内容侧点过名时发生。
 *
 * 不动这些地方：代码围栏与行内代码、行内/独立公式、已有令牌、markdown 链接目标、HTML 标签、标题行
 * （标题里插令牌会让右侧目录重复三遍，见 handoff §8.1）。
 * 另外跳过紧跟「图／表／级／相／极／端」的情况：「B 级绝缘」「B 图」里的 B 不是磁通密度。
 */
const PROTECT_RE = /(`[^`\n]*`|\$[^$\n]*\$|\[[^\]\n]+\]\{#(?:[^\]:{}\n]+:)?[A-Za-z_][A-Za-z0-9_-]*\}|\]\([^)\n]*\)|<[^>\n]+>)/;
const SKIP_AFTER = "图表级相极端样附";
/**
 * 符号排除（页面 frontmatter）——「全部包起来」是默认，撞车处**显式**收窄。
 *
 * 宽覆盖的包（电机学给全部拉丁单字母声明了正文形式）会在少数页面撞上
 * 选项标号（「答案：C」）、单位（`A/m`、`1 T`）、人名缩写（`H. C. Ørsted`）、
 * 绝缘等级（Y/A/E/B/F/H/C 七级）这类同形不同义的场合。启发式判据必然误伤
 * （同一页里 `B` 既是选项标号又是磁通密度），所以只有**显式指定**才是可靠的：
 *
 *   frontmatter:
 *     符号排除: [sym-A, sym-B]        ← 这些词条在本页**正文**里不自动取词
 *     符号排除公式: [sym-A]            ← 这些词条在本页**公式**里不自动取词
 *
 * 两个键都列 = 完全禁自动取词。**手写令牌永远照常**（`[B]{#sym-B}` 不受影响）——
 * 显式优先于自动，与三层锚定同一哲学（符号级现在有两个动词：强制、排除）。
 * id 不在本页符号环境里 ⇒ 经 onWarn 报出（零回退纪律：不猜、不静默）。
 *
 * @param {object} dict 本页环境包词典（未过滤）
 * @param {{noProse?: string[], noTex?: string[]}} exclusions
 * @param {(msg: string) => void} [onWarn]
 * @returns {{proseDict: object, texDict: object}} 正文用 / 公式用 两份词典
 */

export function applySymbolExclusions(dict = {}, exclusions = {}, onWarn = null) {
  const warn = (m) => onWarn && onWarn(m);
  const noProse = exclusions.noProse || [];
  const noTex = exclusions.noTex || [];
  const proseDict = { ...dict };
  const texDict = { ...dict };
  for (const id of noProse) {
    if (!Object.prototype.hasOwnProperty.call(dict, id)) {
      warn(`符号排除指向本页环境里没有的词条 ${id}`);
      continue;
    }
    const e = proseDict[id];
    if (e && e.prose && e.prose.length) proseDict[id] = { ...e, prose: [] };
  }
  for (const id of noTex) {
    if (!Object.prototype.hasOwnProperty.call(dict, id)) {
      warn(`符号排除公式指向本页环境里没有的词条 ${id}`);
      continue;
    }
    delete texDict[id];
  }
  return { proseDict, texDict };
}

export function autoWrapTerms(source, dict = {}) {
  const forms = [];
  for (const [id, entry] of Object.entries(dict)) {
    for (const form of entry.prose || []) if (form) forms.push({ form, id });
  }
  if (!forms.length) return source;
  forms.sort((a, b) => b.form.length - a.form.length);
  const alt = forms.map((x) => x.form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const idOf = new Map(forms.map((x) => [x.form, x.id]));
  const re = new RegExp(`(${alt})(?![A-Za-z0-9_₀-₉ᵣ])`, "g");
  let inFence = false;
  return source
    .split("\n")
    .map((line) => {
      if (FENCE_RE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      if (/^[\t ]{0,3}#{1,6}[\t ]/.test(line)) return line;
      return line
        .split(PROTECT_RE)
        .map((seg, i) => {
          if (i % 2 === 1) return seg;
          return seg.replace(re, (whole, form, offset) => {
            const before = offset > 0 ? seg[offset - 1] : "";
            const rest = seg.slice(offset + form.length).replace(/^[\s\u3000]+/, "");
            const after = rest[0] || "";
            if (before && /[A-Za-z0-9_]/.test(before)) return whole;
            if (after && SKIP_AFTER.includes(after)) return whole;
            return `[${form}]{#${idOf.get(form)}}`;
          });
        })
        .join("");
    })
    .join("\n");
}

export function renderGlossary(source, opts = {}) {
  if (typeof source !== "string") return source;
  const {
    dict = {},
    tokenDict = null,   // 手写令牌专用词典（默认同 dict）——页面「符号排除」只收窄自动取词，
                        // 显式令牌永远照常（显式优先于自动，与三层锚定同一哲学）
    packs = null,
    pins = null,
    envName = "",
    renderTex = null,
    notationHref = "",
    dictTable = null,
    onWarn = null,
    onHit = null,
  } = opts;
  const tokens = tokenDict || dict;
  const warn = (msg) => onWarn && onWarn(msg);
  // 解析一个令牌：返回 {key, entry, href} 或 {miss}。**只查被锚定的地方，零回退**。
  const resolveTerm = (pack, term) => {
    if (pack !== undefined) {
      const p = packs && packs[pack];
      if (!p) return { miss: `令牌指向未注册的符号包「${pack}」` };
      const e = p.dict[term];
      if (!e || e.bubble === false) return { miss: `包「${pack}」没有词条 ${term}` };
      return { key: `${pack}:${term}`, entry: e, href: `${p.hrefBase}#${term}` };
    }
    if (pins && Object.prototype.hasOwnProperty.call(pins, term)) {
      const packName = pins[term];
      const p = packs && packs[packName];
      const e = p && p.dict[term];
      if (!e || e.bubble === false) {
        return { miss: `符号强制指向的包「${packName}」没有词条 ${term}` };
      }
      return { key: `${packName}:${term}`, entry: e, href: `${p.hrefBase}#${term}` };
    }
    if (Object.prototype.hasOwnProperty.call(tokens, term)) {
      const e = tokens[term];
      if (e.bubble === false) {
        return { miss: `词条 ${term} 只声明了形式、没有气泡内容（补词典行才会生效）` };
      }
      return { key: term, entry: e, href: e.href || `${notationHref}#${term}` };
    }
    return { miss: `环境包「${envName}」没有词条 ${term}，令牌原样保留` };
  };
  // 先剥数据围栏（table 围栏换成占位符——总表 HTML 里全是 KaTeX 产物，若此刻插进来，
  // 自动取词会把手伸进标签之间），再自动取词，最后才判断「有没有活干」。
  const tables = [];
  const stripped = stripDictFences(
    source.split(/\r?\n/),
    dictTable
      ? (entries) => {
          tables.push(dictTable(entries));
          return `@@GLOSS_TABLE_${tables.length - 1}@@`;
        }
      : null,
  ).join("\n");
  const wrapped = autoWrapTerms(stripped, dict);
  const hasWork =
    source.includes(":::glossary-dict") ||
    source.includes(":::glossary-match") ||
    TOKEN_RE.test(wrapped);
  TOKEN_RE.lastIndex = 0; // 全局正则带状态，复用前必须归零
  if (!hasWork) return source;

  return wrapped
    .replace(TOKEN_RE, (match, tex, pack, term) => {
      const r = resolveTerm(pack, term);
      if (r.miss) {
        warn(r.miss);
        return match;
      }
      const { key, entry, href } = r;
      const inner =
        renderTex && tex.trim() !== ""
          ? renderTex(tex)
          : esc(tex);
      // aria-label 用**纯文本**标题（词条标题可为 $…$，读屏不该念出美元号与反斜杠）
      const label = entry.titleText || entry.title;
      if (onHit) {
        const hit = { title: entry.title, text: entry.text, href };
        if (entry.senses) hit.senses = entry.senses;   // v2 多义项（供气泡列出全部含义）
        onHit(key, hit);
      }
      return (
        `<a class="sym-gloss" data-term="${esc(key)}" href="${esc(href)}"` +
        ` aria-label="${esc(label)}">${inner}</a>`
      );
    })
    .replace(/@@GLOSS_TABLE_(\d+)@@/g, (match, i) => tables[Number(i)] ?? "");
}

/**
 * 客户端气泡脚本（渐进增强）：
 * 点击 .sym-gloss → 在符号旁弹出气泡（词典标题 + 一句解释 + 详细链接）；
 * 再点同一个、点别处、按 Esc 或 hash 变化都收起。
 * 词典从页面内 <script type="application/json" id="sym-glossary-json"> 读
 * （构建期按页烘焙好的绝对可用链接），不发任何请求。
 */

export const GLOSSARY_JS = String.raw`(/* math-glossary: 符号气泡（独立插件模块，构建期内联） */
function () {
  "use strict";
  var dict = null;
  var pop = null;
  var current = null;
  function ensureDict() {
    if (dict !== null) return dict;
    var tag = document.getElementById("sym-glossary-json");
    if (!tag) return null;
    try { dict = JSON.parse(tag.textContent); } catch (e) { dict = null; }
    return dict;
  }
  function close() {
    if (pop) pop.remove();
    pop = null;
    current = null;
  }

  // SPA 换页钩子：dict 按页烘焙，换页必须清缓存（spa-router 调用）
  window.__glossaryReset = function () { dict = null; close(); };
  function openFor(link) {
    var d = ensureDict();
    if (!d) return;
    var term = link.getAttribute("data-term");
    var entry = d.terms && d.terms[term];
    if (!entry) return;
    if (current === link) { close(); return; }
    close();
    pop = document.createElement("div");
    pop.className = "sym-gloss-pop";
    var t = document.createElement("strong");
    // 标题与正文一样由构建期渲染：HTML 已转义、$…$ 已出公式（所以两者都用 innerHTML）
    t.innerHTML = entry.title;
    pop.appendChild(t);
    var p = document.createElement("p");
    // 词条文本由构建期处理好：HTML 已转义、$…$ 已渲染成公式（所以这里用 innerHTML），
    // 而文本里若出现 [tex]{#id} 这样的令牌写法，**保持字面**——气泡里不再套气泡。
    p.innerHTML = entry.text;
    pop.appendChild(p);
    // v2 多义项：同一个符号在不同课程/语境下含义不同（$Z$ = 阻抗 or 槽数）。
    // 列出**全部**义项并标出语境——「实时能查到」就是这里：点一个符号看到它的所有含义，
    // 而 entry.ctx 是当前页面所属语境，那一条排在最前并加标记。
    if (entry.senses && entry.senses.length) {
      var ul = document.createElement("ul");
      ul.className = "sym-gloss-pop__senses";
      var list = entry.senses.slice().sort(function (a, b) {
        var ac = a.ctx === entry.ctx ? 0 : 1, bc = b.ctx === entry.ctx ? 0 : 1;
        return ac - bc;
      });
      for (var si = 0; si < list.length; si++) {
        var li = document.createElement("li");
        if (list[si].ctx === entry.ctx) li.className = "is-here";
        var ctx = document.createElement("em");
        ctx.textContent = list[si].ctx + "：";
        li.appendChild(ctx);
        var st = document.createElement("span");
        st.innerHTML = list[si].text;
        li.appendChild(st);
        ul.appendChild(li);
      }
      pop.appendChild(ul);
    }
    if (entry.href) {
      var a = document.createElement("a");
      a.className = "sym-gloss-pop__more";
      // href 是构建期按词条所属课程烘焙好的（可能已含 #锚点，也可能指向别的课程那一页），
      // 只有没带锚点时才补上，否则会拼成 #id#id 这种双锚点。
      a.href = entry.href.indexOf("#") >= 0 ? entry.href : entry.href + "#" + term;
      a.textContent = "详细 \u2197 符号入门";
      pop.appendChild(a);
    }
    document.body.appendChild(pop);
    var r = link.getBoundingClientRect();
    var width = document.documentElement.clientWidth;
    var left = Math.min(Math.max(8, r.left + window.scrollX), window.scrollX + width - pop.offsetWidth - 8);
    var top = r.bottom + window.scrollY + 8;
    if (r.bottom + pop.offsetHeight + 16 > window.innerHeight + window.scrollY) {
      top = r.top + window.scrollY - pop.offsetHeight - 8;
    }
    pop.style.left = left + "px";
    pop.style.top = top + "px";
    current = link;
  }
  // 公式内命中回退：见 click 处理器里的说明。用 elementsFromPoint 拿该点的完整元素栈，
  // 在其中挑「面积最小」的 [data-term]（越小的盒 = 越具体的目标）。
  // 用 elementsFromPoint 而不是遍历全页符号：只查这一点上的几个元素，与公式规模无关。
  function termAtPoint(x, y) {
    var stack = document.elementsFromPoint
      ? document.elementsFromPoint(x, y)
      : [document.elementFromPoint(x, y)];
    var best = null, bestArea = Infinity, bestDist = Infinity;
    for (var i = 0; i < stack.length; i++) {
      var node = stack[i];
      if (!node || !node.getAttribute) continue;
      var term = node.getAttribute("data-term");
      if (!term) continue;
      var r = node.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      var area = r.width * r.height;
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var dist = (cx - x) * (cx - x) + (cy - y) * (cy - y);
      // 取最小面积；面积相同时取中心离点击点最近的那个。
      if (area < bestArea - 0.5 || (Math.abs(area - bestArea) <= 0.5 && dist < bestDist)) {
        best = node; bestArea = area; bestDist = dist;
      }
    }
    return best;
  }
  document.addEventListener("click", function (e) {
    var link = e.target.closest
      ? e.target.closest("a.sym-gloss, .ML__latex [data-term], .katex [data-term]")
      : null;
    // 公式内的几何回退（2026-10-12 用户实测「公式框里符号点击范围严重漂移、几乎点不了」）：
    // KaTeX 的透明堆叠结构盒（.vlist 一套，position:relative）会抢走点击让 closest 落空，
    // 相邻/嵌套符号的 inline 盒也会互相覆盖。所以只要点在公式容器里，就按几何重挑一次：
   // 2026-10-29 换引擎后容器类名是 .ML__latex（旧 .katex 保留兼容）。
    // 取「包含该点、面积最小」的 [data-term] 盒——嵌套角标里最小 = 最内层，
    // 重叠邻居里最小 = 更该点的那个；同面积取中心最近。实测把 14 个堆叠公式的
    // 104 个符号从 25 个点不动降到 0。CSS 侧的提层（.katex [data-term] 提 z-index）
    // 是同批的另一半修法，两者互为兜底。
    if (e.target.closest && (e.target.closest(".ML__latex") || e.target.closest(".katex"))) {
      var geo = termAtPoint(e.clientX, e.clientY);
      if (geo) link = geo;
    }
    if (link) { e.preventDefault(); openFor(link); return; }
    if (pop && !pop.contains(e.target)) close();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") close();
  });
  window.addEventListener("hashchange", close);
}());`;
