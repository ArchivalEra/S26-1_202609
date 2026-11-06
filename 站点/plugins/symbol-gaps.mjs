/**
 * 符号缺口账本 —— 「公式里出现了、但本页词条里没有对应形状」的**全量清单**。
 *
 * ## 为什么需要（2026-11-06 站长实测发现）
 *
 * 已有的两道符号闸都只看**判定之后**的事：
 *   · `glossary-bubble.test.mjs`：锚点 ↔ 气泡词典对不对得上；
 *   · `symbol-coverage.test.mjs`：认出来了却没包成链接的（裸 span / 字面令牌）。
 *
 * 两者都抓不到**最要命的一类：压根没被判定为符号的形状**。
 * 实测电路原理习题册第二章：公式里 `V` 出现 46 次、`A` 27 次、`T` 26 次、
 * `N` 16 次、`B` 11 次、`M` 9 次——通用包的 `:::glossary-match` 表里
 * **没有 V/A/T/N/B 的声明行**，所以它们永远不会冒泡，而构建日志一个字都不说。
 *
 * 这就是「符号系统还是不能响亮报错」的真正含义：缺的是**词条覆盖**，
 * 不是「包链接失败」。所以本模块把缺口变成可统计的账：
 * 逐页比对「公式里出现的 operand 形状」vs「该页词条声明的形状」，
 * 差额按出现次数降序列出。
 *
 * ## 口径（只管公式，且只报「像符号」的形状）
 *
 * - 只看**公式**（`data-math-tex`）：正文裸字母归 `symbol-parity` 管。
 * - 只统计 `role === 'operand'` 的叶子与整枚上下标（`V_{ab}` 这种应当整体成泡）。
 * - 排除：单字母以外的数字、运算符号（`+ - =`）、`\text{}` 里的字面。
 * - **不判断「该不该冒」**：本模块只报「出现了但没有词条」。该不该补词条是
 *   内容决策（`V` 在电路里是电压、在别的课可能是别的），由人/闸门一起定。
 */

import { parse } from '../math/parser.mjs';
import { shapeKey } from '../math/ir.mjs';

/** 收集一个 IR 树里「像符号」的形状：operand 的 sym 叶子与整枚上下标。 */
function collectShapes(node, out, srcTex) {
  if (!node || typeof node !== 'object') return;

  if (node.role === 'operand' && (node.kind === 'sym' || node.kind === 'script')) {
    // 整枚上下标（`V_{ab}`）优先：它命中就不该再拆成 V 与 ab 两条。
    const key = shapeKey(node);
    const label = (srcTex && node.span)
      ? srcTex.slice(node.span[0], node.span[1])
      : (node.tex || key);
    const rec = out.get(key) || { key, label, count: 0, kind: node.kind };
    rec.count += 1;
    out.set(key, rec);
    // 上下标整枚记完之后**不再往下走**（否则 V 与 ab 会被重复计入）
    if (node.kind === 'script') return;
  }

  const kids = [];
  if (node.items) kids.push(...node.items);
  if (node.base) kids.push(node.base);
  if (node.sub) kids.push(node.sub);
  if (node.sup) kids.push(node.sup);
  if (node.num) kids.push(node.num);
  if (node.den) kids.push(node.den);
  if (node.body) kids.push(node.body);
  if (node.index) kids.push(node.index);
  if (node.above) kids.push(node.above);
  if (node.below) kids.push(node.below);
  if (node.rows) {
    for (const r of node.rows) {
      if (Array.isArray(r)) for (const c of r) Array.isArray(c) ? kids.push(...c) : kids.push(c);
    }
  }
  for (const k of kids) collectShapes(k, out, srcTex);
}

function decodeAttr(s) {
  return String(s)
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * 从一页产物 HTML 里量出「公式中出现的形状」与「已冒泡的形状」。
 *
 * @param {string} html 页面产物
 * @returns {{
 *   occurrences: Map<string, {key:string,label:string,count:number}>,
 *   bubbled: Set<string>,       已冒泡的 data-term 键集合（形如 `电路原理:sym-U`）
 *   parseErrors: number,
 * }}
 */
export function measureFormulaShapes(html) {
  const occurrences = new Map();
  const bubbled = new Set();
  const bubbledLabels = new Set();
  let parseErrors = 0;

  const prose = String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');

  // 已冒泡锚点：`<a class="sym-gloss" data-term="包:sym-X" ...>…</a>`。
  // 从锚点内容里取 `aria-label`（构建期写入的是词条标题）之外的第二个来源
  // 不可靠 —— 所以真正用于比对的 label 由**调用方**从 IR 侧提供（构建期烘）；
  // 这里退一步：用锚点的 **data-math-tex 切片**不可得，只能记 key。
  // 因此本函数保证两件事：形状清单 + 冒泡键清单；精确 label 比对交给
  // coverageOf 的可选参数（构建期可精确提供）。
  for (const m of prose.matchAll(/class="sym-gloss"[^>]*data-term="([^"]+)"/g)) {
    bubbled.add(m[1]);
  }
  // 锚点内部的纯文本（KaTeX 会拆成多个 span，但 aria-label / data-math-plain
  // 在 `.katex` 容器上）——用它做「这一页确实冒过这个字面」的弱证据。
  for (const m of prose.matchAll(/class="sym-gloss"[^>]*aria-label="([^"]*)"/g)) {
    bubbledLabels.add(decodeAttr(m[1]));
  }

  for (const m of prose.matchAll(/data-math-tex="([^"]*)"/g)) {
    const tex = decodeAttr(m[1]);
    let expr;
    try {
      const r = parse(tex);
      if (r.problems && r.problems.some((p) => p.severity === 'error')) { parseErrors += 1; continue; }
      expr = r.expr;
    } catch {
      parseErrors += 1;
      continue;
    }
    collectShapes(expr.root, occurrences, tex);
  }
  return { occurrences, bubbled, bubbledLabels, parseErrors };
}

/**
 * 噪声过滤：这些形状**不该**算「缺失词条」，报出来只会淹没有用的信号。
 *
 * 三条判据（都来自实测的 1154 种里最闹的那批）：
 *   ① **函数名**：`\sin`/`\cos`/`\log`/`\det`/`\lim` 这类是运算符，读者不需要
 *      点它看释义；`\Omega`（单位欧姆）这类**单位符号**也归此列（单位该在符号
 *      入门里讲，但不必每个都成泡——否则每道题都挂一串）。
 *   ② **纯运算/标点**：`/`、`|`、`°`、`'`、`.`、`!`、`…`、`−`、`、`、`⊙` 等。
 *   ③ **函数调用形态**：`\sin x` 里的 `x` 不是「sin 的符号」而是它的参数，
 *      形状键会把它们粘在一起——这类整枚形状按噪声处理。
 */
const FUNCTION_LIKE = new Set([
  '\\sin', '\\cos', '\\tan', '\\cot', '\\sec', '\\csc',
  '\\arcsin', '\\arccos', '\\arctan',
  '\\log', '\\ln', '\\lg', '\\exp', '\\det', '\\lim', '\\max', '\\min',
  '\\sup', '\\inf', '\\arg', '\\gcd',
  // 单位与常量符号：该讲但不必逐处成泡
  '\\Omega', '\\circ', '\\degree', '\\%',
]);

const PUNCTUATION_LIKE = new Set([
  '/', '|', '°', "'", '.', '!', '…', '−', '、', '⊙', ',', ';', ':', '~',
  '+', '-', '=', '<', '>', '(', ')', '[', ']', '{', '}',
]);

/** 这个形状该不该进「缺失词条」清单。 */
export function isMeaningfulGap(rec) {
  const label = String(rec.label || '').trim();
  if (!label) return false;
  if (PUNCTUATION_LIKE.has(label)) return false;
  // 单字符但不是字母（含 unicode 运算符、箭头等）⇒ 噪声
  if (label.length === 1 && !/\p{L}/u.test(label)) return false;
  // 函数名整体（`\sin`）⇒ 噪声；但 `\sin x` 这种带参数的整枚也跳过
  if (FUNCTION_LIKE.has(label)) return false;
  if (/^\\(sin|cos|tan|cot|sec|csc|arcsin|arccos|arctan|log|ln|lg|exp|det|lim|max|min|sup|inf|arg|gcd)\b/.test(label)) {
    return false;
  }
  return true;
}

/**
 * 把「出现的形状」分成：已覆盖 / 未覆盖。
 *
 * ## 判据（精确版，2026-11-06 修过一版假阴性）
 *
 * 一个形状算「已覆盖」，当且仅当：**本页冒泡词条的某个 label 与它的源文本
 * 完全相等**。
 *
 * ⚠️ 不能用 `k.includes(label)` 这种模糊匹配：`label='V'` 会被
 * `sym-V_a` 命中而判成「已覆盖」，实测把 `V` 单独出现 46 次的情况漏掉了
 * （`V_a` 是节点电压 a，与裸 `V` 不是同一个东西）。宁可多报，不许漏报——
 * 这个闸的产出是「待补词条清单」，多报只是清单长一点，漏报就是永远不知道。
 *
 * @param {ReturnType<typeof measureFormulaShapes>} m
 * @param {Set<string>} [bubbledLabels] 已冒泡词条的 **label**（源文本）集合
 * @param {{filterNoise?: boolean}} [o] filterNoise 默认 true：滤掉函数名/标点
 * @returns {{covered: object[], uncovered: object[]}}
 */
export function coverageOf(m, bubbledLabels = null, o = {}) {
  const filterNoise = o.filterNoise !== false;
  const labels = bubbledLabels || new Set(
    [...m.bubbled].map((k) => (k.includes(':') ? k.slice(k.indexOf(':') + 1) : k))
      .map((x) => x.replace(/^sym-/, '')),
  );
  const covered = [];
  const uncovered = [];
  for (const rec of m.occurrences.values()) {
    const hit = labels.has(rec.label) || labels.has(rec.label.replace(/^\\/, ''));
    if (hit) { covered.push(rec); continue; }
    if (filterNoise && !isMeaningfulGap(rec)) continue;
    uncovered.push(rec);
  }
  uncovered.sort((a, b) => b.count - a.count);
  return { covered, uncovered };
}
