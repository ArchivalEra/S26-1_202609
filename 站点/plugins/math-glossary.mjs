/**
 * 符号气泡（math glossary）—— 独立可拆卸模块
 *
 * 解决的问题：教材通篇使用 $a_{ij}$、$r_2-3r_1$ 这类记号却从不解释；
 * 符号入门页（0.0-符号入门.md）做了系统的讲解，但「为看一个符号跳一页」
 * 太重。本模块让正文里的符号**点了出气泡**就地解释，气泡里留
 * 「详细 ↗」链接跳到符号入门页对应锚点；符号页照常存在，气泡只是捷径。
 *
 * ============================ 用法 ============================
 *
 * Markdown 里把符号写成「令牌」：
 *
 *   [a_{ij}]{#sym-index}
 *   [r_2-3r_1]{#sym-rowcol}
 *
 * 渲染为一个**强调色**的可点击符号（构建期 KaTeX 出公式），
 * 无下划线、无链接框——术语高亮的样子，不是链接的样子。
 * 无 JavaScript 时它就是普通链接，点击直达符号入门页锚点——
 * 气泡只是渐进增强，不装 JS 页面照样可用。
 *
 * 公式内部同样可点：glossifyTex 把 TeX 里的 r_1/c_4 行列记号与
 * (-1)^{...} 正负号公式包成 \htmlData{term=...}{...}（需 KaTeX
 * trust 选项），渲染产物里的 <span data-term> 由同一个气泡脚本接管。
 *
 * **自动取词**（2026-09-24 加）：符号入门页里再用一个围栏声明每个词条的写法，
 *
 *   :::glossary-match
 *   sym-B | B | B              ← id | 正文形式（、分隔） | TeX 形式（、分隔，可省）
 *   sym-Phi | Φ | \Phi
 *   sym-pFe | p_Fe | p_{Fe}
 *   :::
 *
 * 声明过的符号，正文里裸写（「磁场强度 H」）与公式里出现（$B=\mu H$）都**自动**变成可点符号，
 * 不必手写令牌；没声明的词条只能手写——自动取词只在内容侧点过名时发生，避免把每个字母都上色。
 * 正文侧不碰代码、公式、链接、标题与已有令牌，并跳过「B 级绝缘」「B 图」这类明显不是术语的场合。
 *
 * 词典数据**不放在本模块**，放在符号入门页自己的 :::glossary-dict 围栏里
 * （内容侧单一来源，改词条不用碰代码）：
 *
 *   :::glossary-dict
 *   sym-index | 下标：门牌号 | 下标是坐标：前行后列，a₂₃ 即第 2 行第 3 列。
 *   sym-power | 上标：乘方 | 右上角是乘方；(-1)^{i+j} 只管正负号。
 *   :::
 *
 * 每行 `id | 标题 | 气泡文本`；文本里的 | 用不着转义（按前两根切分）。
 * 渲染符号页自身时围栏会被剥掉（那是给构建读的数据，不是给人看的正文）。
 *
 * ============================ 与宿主的接缝 ============================
 *
 * build.mjs 三件事：① 读符号入门页 parseGlossaryDict 得词典；
 * ② 每页 Step 2.5 之后调 renderGlossary（传入 KaTeX 渲染回调与
 * 当页到符号入门页的相对链接）；③ 写出 GLOSSARY_JS 资产 + 页面尾
 * <script> + 词典 JSON 标签。摘掉这些即回退：令牌恢复成字面文本。
 *
 * 本模块自己**不懂 KaTeX**——renderTex 由宿主注入（宿主才知道
 * wrapBareCJK 等私有约定），没有回调时令牌退化为纯文本。
 */

const DICT_OPEN_RE = /^[\t ]{0,3}:::glossary-dict[\t ]*$/;
/** 自动取词声明：`id | 正文形式（、分隔）| TeX 形式（、分隔，可省）`。 */
const MATCH_OPEN_RE = /^[\t ]{0,3}:::glossary-match[\t ]*$/;
const CLOSE_RE = /^[\t ]{0,3}:{3,}[\t ]*$/;
const FENCE_RE = /^[\t ]{0,3}(`{3,}|~{3,})/;
const TERM_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** 行内令牌：[tex]{#id}。只认合法 id，防止误伤普通方括号文本。 */
const TOKEN_RE = /\[([^\][\n]+)\]\{#([A-Za-z_][A-Za-z0-9_-]*)\}/g;

/**
 * TeX 内自动取词的模式（按用户约定收窄）：
 *   [rc]_<数字/字母>          —— r_1、c_4 这类行列记号（sym-rowcol）
 *   (-1)^{...} 或 (-1)^n      —— 正负号公式（sym-power）
 * 刻意**不**匹配裸字母与 a_{ij} 一类矩阵元素——a、b、c 本身不是术语，
 * 矩阵里的 a_{11} 满屏都是，逐个上色是灾难。
 */
const TEX_TERM_RE = /([rc])_(\{[A-Za-z0-9]+\}|[A-Za-z0-9]+)|\(-1\)\^(\{[^{}]*\}|[A-Za-z0-9]+)/g;

/**
 * 把 TeX 源里的行列记号与正负号公式包进 \htmlData{term=...}{...}，
 * 使它们在 KaTeX 渲染产物里带 data-term，可被气泡脚本点中。
 * 只在词典里确有对应词条时才包（没有词条的上色是骗人）；
 * 已在 \htmlData 内的内容不会重复匹配（替换结果里 term= 挡住了回扫）。
 * @param {string} tex
 * @param {object} dict parseGlossaryDict 的产物
 */
export function glossifyTex(tex, dict = {}) {
  if (typeof tex !== "string") return tex;
  let out = tex;

  // ⓪ 先把「当文字排」的片段与「环境骨架」保护起来，否则取词会把公式打断：
  //    \mathrm{...}/\text{...} 里是单位（H/m、Wb、N·m）；
  //    \begin{aligned}、\begin{array}{l} 里的字母是环境名与列格式——KaTeX 遇到
  //    \htmlData 混进这两处会直接报 "Expected node of ... type, but got node of type html"。
  const guarded = [];
  out = out.replace(
    /\\(?:mathrm|text|textrm|operatorname|mbox)\{[^{}]*\}|\\(?:begin|end)\{[^{}]*\}(?:\{[^{}]*\})*/g,
    (m) => {
      guarded.push(m);
      return `\u0001${guarded.length - 1}\u0001`;
    },
  );

  // ① 词典声明过的 TeX 原子（entry.tex）：整原子取词，长的优先。
  //    前后不挨字母/数字/下划线（B 不会被 \Big 之类命令吃掉），
  //    后面紧跟 _ 或 ^ 的跳过（B_m、H_c 另有词条，不拆开单个字母）。
  const atoms = [];
  for (const [id, entry] of Object.entries(dict)) {
    for (const atom of entry.tex || []) if (atom) atoms.push({ atom, id });
  }
  if (atoms.length) {
    atoms.sort((a, b) => b.atom.length - a.atom.length);
    const alt = atoms.map((x) => x.atom.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const idOf = new Map(atoms.map((x) => [x.atom, x.id]));
    out = out.replace(
      new RegExp(`(?<![A-Za-z0-9_\\\\])(${alt})(?![_^])`, "g"),
      (m, atom) => `\\htmlData{term=${idOf.get(atom)}}{${atom}}`,
    );
  }

  // ② 行列记号与正负号公式（按用户约定收窄，与词典是否声明无关）
  const restore = (s) => s.replace(/\u0001(\d+)\u0001/g, (m, i) => guarded[Number(i)] ?? m);
  const hasRowcol = Object.prototype.hasOwnProperty.call(dict, "sym-rowcol");
  const hasPower = Object.prototype.hasOwnProperty.call(dict, "sym-power");
  if (!hasRowcol && !hasPower) return restore(out);
  return restore(out.replace(TEX_TERM_RE, (match, rc, rcSub, powExp) => {
    if (rc && hasRowcol) {
      return `\\htmlData{term=sym-rowcol}{${rc}_${rcSub}}`;
    }
    if (powExp && hasPower) {
      return `\\htmlData{term=sym-power}{(-1)^${powExp}}`;
    }
    return match;
  }));
}

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

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
    const parts = line.split("|");
    if (parts.length < 3) continue; // 缺字段：跳过，不猜
    const id = parts[0].trim();
    if (!TERM_ID_RE.test(id)) continue;
    dict[id] = { title: parts[1].trim(), text: parts.slice(2).join("|").trim() };
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

/** 从源里剥掉全部 :::glossary-dict 与 :::glossary-match 围栏（数据块不该出现在正文里）。 */
function stripDictFences(lines) {
  const out = [];
  let fence = null;
  let inDict = false;
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
    if (!inDict && (DICT_OPEN_RE.test(line) || MATCH_OPEN_RE.test(line))) {
      inDict = true;
      continue;
    }
    if (inDict) {
      if (CLOSE_RE.test(line)) inDict = false;
      continue;
    }
    out.push(line);
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
const PROTECT_RE = /(`[^`\n]*`|\$[^$\n]*\$|\[[^\]\n]+\]\{#[A-Za-z_][A-Za-z0-9_-]*\}|\]\([^)\n]*\)|<[^>\n]+>)/;
const SKIP_AFTER = "图表级相极端样附";
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

/**
 * 主转换：剥词典围栏 + 把 [tex]{#id} 令牌换成可点击符号。
 * 词典里没有的 id **原样保留**（显式可见的坏令牌好过静默吞掉）。
 *
 * @param {string} source
 * @param {{dict: object, renderTex?: (tex: string) => string, notationHref?: string}} opts
 *   renderTex   宿主注入的 KaTeX 行内渲染回调；缺省时令牌用纯文本。
 *   notationHref 当页到符号入门页的链接（.html）；缺省落到 '#id' 纯锚点。
 *                多课程合并词典时，改在词条上带 href（优先级更高，见 build.mjs）。
 */
export function renderGlossary(source, opts = {}) {
  if (typeof source !== "string") return source;
  const { dict = {}, renderTex = null, notationHref = "" } = opts;
  // 先剥数据围栏、再按词典声明自动取词，最后才判断「这一页有没有活干」——
  // 短路必须在自动取词之后，否则裸写符号的页面会被当成没活干而原样返回。
  const stripped = stripDictFences(source.split(/\r?\n/)).join("\n");
  const wrapped = autoWrapTerms(stripped, dict);
  const hasWork =
    source.includes(":::glossary-dict") ||
    source.includes(":::glossary-match") ||
    TOKEN_RE.test(wrapped);
  TOKEN_RE.lastIndex = 0; // 全局正则带状态，复用前必须归零
  if (!hasWork) return source;

  return wrapped.replace(TOKEN_RE, (match, tex, term) => {
    if (!Object.prototype.hasOwnProperty.call(dict, term)) return match;
    const entry = dict[term];
    const inner =
      renderTex && tex.trim() !== ""
        ? renderTex(tex)
        : esc(tex);
    const href = entry.href || `${notationHref}#${term}`;
    return (
      `<a class="sym-gloss" data-term="${esc(term)}" href="${esc(href)}"` +
      ` aria-label="${esc(entry.title)}">${inner}</a>`
    );
  });
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
    t.textContent = entry.title;
    pop.appendChild(t);
    var p = document.createElement("p");
    p.textContent = entry.text;
    pop.appendChild(p);
    if (entry.href) {
      var a = document.createElement("a");
      a.className = "sym-gloss-pop__more";
      a.href = entry.href + "#" + term;
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
  document.addEventListener("click", function (e) {
    var link = e.target.closest
      ? e.target.closest("a.sym-gloss, .katex [data-term]")
      : null;
    if (link) { e.preventDefault(); openFor(link); return; }
    if (pop && !pop.contains(e.target)) close();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") close();
  });
  window.addEventListener("hashchange", close);
}());`;
