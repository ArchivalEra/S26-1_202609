/**
 * 客户端符号气泡脚本（由 SYMBOL_SELECTOR 单源插值派生，零外部请求）。
 */

import { SYMBOL_SELECTOR, SYMBOL_JSON_SCRIPT_ID } from './contracts.mjs';

export const SYMBOLS_BUBBLE_JS = String.raw`(/* symbols-bubble: 符号气泡（深核心客户端运行时，构建期内联） */
function () {
  "use strict";
  var dict = null;
  var pop = null;
  var current = null;
  function ensureDict() {
    if (dict !== null) return dict;
    var tag = document.getElementById("${SYMBOL_JSON_SCRIPT_ID}");
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
    t.innerHTML = entry.title;
    pop.appendChild(t);
    var p = document.createElement("p");
    p.innerHTML = entry.text;
    pop.appendChild(p);
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
      var anchorId = term && term.indexOf(":") >= 0 ? term.slice(term.indexOf(":") + 1) : term;
      a.href = entry.href.indexOf("#") >= 0 ? entry.href : entry.href + "#" + anchorId;
      // 链接文字跟着包名走：词条键形如「包名:词条id」，符号包已平铺到 符号总览/<包名>.md，
      // 写死页名会在搬页后指着一个不存在的名字。（本段在 String.raw 模板里，别用反引号。）
      var packName = term && term.indexOf(":") >= 0 ? term.slice(0, term.indexOf(":")) : "";
      a.textContent = "详细 \u2197 " + (packName || "符号总览");
      pop.appendChild(a);
    }
    document.body.appendChild(pop);
    var r = link.getAttribute ? link.getBoundingClientRect() : null;
    if (r) {
      var width = document.documentElement.clientWidth;
      var left = Math.min(Math.max(8, r.left + window.scrollX), window.scrollX + width - pop.offsetWidth - 8);
      var top = r.bottom + window.scrollY + 8;
      if (r.bottom + pop.offsetHeight + 16 > window.innerHeight) {
        top = r.top + window.scrollY - pop.offsetHeight - 8;
      }
      pop.style.left = left + "px";
      pop.style.top = top + "px";
    }
    current = link;
  }
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
      if (area < bestArea - 0.5 || (Math.abs(area - bestArea) <= 0.5 && dist < bestDist)) {
        best = node; bestArea = area; bestDist = dist;
      }
    }
    return best;
  }
  document.addEventListener("click", function (e) {
    var link = e.target.closest
      ? e.target.closest("${SYMBOL_SELECTOR}")
      : null;
    if (e.target.closest && e.target.closest(".katex")) {
      var geo = termAtPoint(e.clientX, e.clientY);
      if (geo) link = geo;
    }
    if (link) { e.preventDefault(); e.stopPropagation(); openFor(link); return; }
    if (pop && !pop.contains(e.target)) close();
  }, true);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") close();
  });
  window.addEventListener("hashchange", close);
}());`;
