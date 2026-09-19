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
 * 渲染为一个虚线下的可点击符号（构建期 KaTeX 出公式）。
 * 无 JavaScript 时它就是普通链接，点击直达符号入门页锚点——
 * 气泡只是渐进增强，不装 JS 页面照样可用。
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
const CLOSE_RE = /^[\t ]{0,3}:{3,}[\t ]*$/;
const FENCE_RE = /^[\t ]{0,3}(`{3,}|~{3,})/;
const TERM_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** 行内令牌：[tex]{#id}。只认合法 id，防止误伤普通方括号文本。 */
const TOKEN_RE = /\[([^\][\n]+)\]\{#([A-Za-z_][A-Za-z0-9_-]*)\}/g;

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

/** 从源里剥掉全部 :::glossary-dict 围栏（数据块不该出现在正文里）。 */
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
    if (!inDict && DICT_OPEN_RE.test(line)) {
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
 * 主转换：剥词典围栏 + 把 [tex]{#id} 令牌换成可点击符号。
 * 词典里没有的 id **原样保留**（显式可见的坏令牌好过静默吞掉）。
 *
 * @param {string} source
 * @param {{dict: object, renderTex?: (tex: string) => string, notationHref?: string}} opts
 *   renderTex   宿主注入的 KaTeX 行内渲染回调；缺省时令牌用纯文本。
 *   notationHref 当页到符号入门页的链接（.html）；缺省落到 '#id' 纯锚点。
 */
export function renderGlossary(source, opts = {}) {
  if (typeof source !== "string") return source;
  const { dict = {}, renderTex = null, notationHref = "" } = opts;
  const hasWork = source.includes(":::glossary-dict") || TOKEN_RE.test(source);
  TOKEN_RE.lastIndex = 0; // 全局正则带状态，复用前必须归零
  if (!hasWork) return source;

  const lines = stripDictFences(source.split(/\r?\n/));
  const src = lines.join("\n");
  return src.replace(TOKEN_RE, (match, tex, term) => {
    if (!Object.prototype.hasOwnProperty.call(dict, term)) return match;
    const entry = dict[term];
    const inner =
      renderTex && tex.trim() !== ""
        ? renderTex(tex)
        : esc(tex);
    const href = `${notationHref}#${term}`;
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
    var link = e.target.closest ? e.target.closest("a.sym-gloss") : null;
    if (link) { e.preventDefault(); openFor(link); return; }
    if (pop && !pop.contains(e.target)) close();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") close();
  });
  window.addEventListener("hashchange", close);
}());`;
