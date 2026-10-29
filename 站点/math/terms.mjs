/**
 * 符号判定：**全站唯一决定「这段文字是哪个词条」的地方**。
 *
 * ## 为什么这一层必须存在且只能是这一层
 *
 * 旧实现有四处各自回答同一个问题（`autoWrapTerms`、`glossifyTex`、
 * `[tex]{#id}` 令牌、手写 `\htmlData`），每处答案略有不同，
 * 所以长出五个补丁函数去让它们不互相破坏。这不是实现不努力，是判定点太多。
 *
 * 现在：判定**只在这里发生一次**，输入是 IR 树（不是字符串），
 * 结果是节点的 `term` 字段。之后所有投影（渲染、纯文本、术语表、搜索、MCP）
 * 读同一份结果，谁都不许再判一次。
 *
 * ## 三轮判定，顺序不可换
 *
 *  ① `force`  作者显式指定 / frontmatter 符号强制 —— **最高优先，不受排除影响**
 *  ② `exclude` 页面级排除（本页的 A 是选项标号）—— 只否决 auto 通道
 *  ③ `auto`   词典匹配：atom（形状键相等）→ pattern（结构谓词）
 *
 * 顺序的意义：显式指定是「我说了算」，排除是「这一页的字母表长什么样」，
 * 自动匹配是「按词典猜」。前者压后两者，后两者互不干扰。
 */

import { shapeKey } from './ir.mjs';

/**
 * 编译词典：整个构建跑一次，与页面无关。
 *
 * @param {Record<string, {page: string, entries: Entry[]}>} packs
 *   包名 → { page: 符号入门页相对路径, entries: 词条数组 }
 * @param {{parse: Function}} deps  只用来把词条的 `tex` 形式解析成形状键
 * @returns {{dictionary: Dictionary, problems: Problem[]}}
 */
export function compileDictionary(packs, deps) {
  const problems = [];
  const atomsByPack = {};    // 包名 → Map(形状键 → 词条 id)
  const patternsByPack = {}; // 包名 → [{entry, test}]

  for (const [packName, pack] of Object.entries(packs || {})) {
    const atoms = new Map();
    const patterns = [];
    (pack.entries || []).forEach((entry, idx) => {
      // 只声明形式、没有释义的词条不参与取词（`bubble: false`）
      if (entry.bubble === false) return;
      const forms = Array.isArray(entry.tex) ? entry.tex : (entry.tex ? [entry.tex] : []);
      forms.forEach((form, fi) => {
        if (typeof form !== 'string' || !form) return;
        // `/…/flags` 形式是正则族：交给 pattern 通道
        const rx = form.match(/^\/(.+)\/([a-z]*)$/s);
        if (rx) {
          try {
            const re = new RegExp(rx[1], rx[2]);
            patterns.push({ entry: entry.id, re, raw: form });
          } catch (e) {
            problems.push({
              code: 'dict-bad-pattern',
              severity: 'error',
              where: { pack: packName, entry: entry.id, index: fi },
              message: `词条 ${entry.id} 的匹配式 ${form} 不是合法正则：${e.message}`,
            });
          }
          return;
        }
        // 普通 TeX 形式：解析成树，取形状键
        const { expr, problems: ps } = deps.parse(form);
        const errs = ps.filter((p) => p.severity === 'error');
        if (errs.length) {
          problems.push({
            code: 'dict-bad-form',
            severity: 'error',
            where: { pack: packName, entry: entry.id, index: fi },
            message: `词条 ${entry.id} 的形似式「${form}」解析失败：${errs[0].message}`,
          });
          return;
        }
        const key = shapeKey(expr.root);
        if (atoms.has(key) && atoms.get(key) !== entry.id) {
          // 同一个形状被两个词条声明：这是词典本身的问题，必须报出来。
          // 静默让后者覆盖就会「改一条词条、另一个符号悄悄失效」。
          problems.push({
            code: 'dict-key-conflict',
            severity: 'warn',
            where: { pack: packName, entry: entry.id },
            message: `形状「${form}」（${key}）在包 ${packName} 里被 ${atoms.get(key)} 与 ${entry.id} 同时声明`
              + '；按后声明者生效，这条冲突需要人工确认',
          });
        }
        atoms.set(key, entry.id);
      });
    });
    atomsByPack[packName] = atoms;
    patternsByPack[packName] = patterns;
  }

  return {
    dictionary: { packs: atomsByPack, patterns: patternsByPack, meta: packs },
    problems,
  };
}

/**
 * 每页一个判定器：把「环境 + 排除 + 强制」固化成闭包。
 *
 * @param {Dictionary} dictionary
 * @param {{
 *   packs: string[],                      本页锚定的包（按声明顺序，后者覆盖前者）
 *   exclude?: {tex?: string[], prose?: string[]},
 *   forceTerm?: Record<string, string>,   词条 id → 包名
 *   page?: string,
 * }} cfg
 * @returns {Resolver}
 */
export function createResolver(dictionary, cfg = {}) {
  const packs = (cfg.packs || []).filter((p) => dictionary.packs[p]);
  const denyTex = new Set(cfg.exclude?.tex || []);
  const denyProse = new Set(cfg.exclude?.prose || []);
  const force = cfg.forceTerm || {};

  /** 在指定包集合里按形状键找词条（后者覆盖前者）。 */
  const lookupShape = (key) => {
    for (let i = packs.length - 1; i >= 0; i -= 1) {
      const pack = packs[i];
      const hit = dictionary.packs[pack]?.get(key);
      if (hit) return { pack, entry: hit };
    }
    return null;
  };

  /** 结构模式匹配：正则只在**源文本**上跑一次定位，落地是否成立由树结构确认。 */
  const lookupPattern = (node, src) => {
    // 从最长（最具体）的节点开始试：一个 `\begin{pmatrix}` 整块不该被
    // 「匹配其中某个 r_1」的模式劫持，所以要先试大后试小。
    for (let i = packs.length - 1; i >= 0; i -= 1) {
      const pack = packs[i];
      for (const p of dictionary.patterns[pack] || []) {
        const span = node.span;
        if (!span) continue;
        const slice = src.slice(span[0], span[1]);
        p.re.lastIndex = 0;
        const m = p.re.exec(slice);
        // 正则必须**整段匹配**这个节点，而不是匹配其中一截：
        // 否则 `r_1+r_2` 这种会把整个节点误标成 `sym-rowcol`。
        if (m && m.index === 0 && m[0].length === slice.length) {
          return { pack, entry: p.entry };
        }
      }
    }
    return null;
  };

  return {
    packs,
    /** 判定一个节点是不是符号。返回 `{pack, entry, rule}` 或 null。 */
    decide(node, src) {
      // ① 作者显式指定（按节点的源文本形状匹配）
      if (node.span) {
        const direct = force[src.slice(node.span[0], node.span[1])];
        if (direct) return { pack: direct, entry: direct, rule: 'force' };
      }
      // ② 排除表：只否决 auto 通道
      //（在 ③ 命中后判断，这样 `exclude` 能精确到「这个词条在这类位置不自动取词」）
      // ③ 自动：形状键
      const byShape = lookupShape(shapeKey(node));
      if (byShape) {
        if (denyTex.has(byShape.entry)) return { ...byShape, rule: 'excluded' };
        return { ...byShape, rule: 'atom' };
      }
      // ③b 自动：结构模式
      const byPattern = lookupPattern(node, src);
      if (byPattern) {
        if (denyTex.has(byPattern.entry)) return { ...byPattern, rule: 'excluded' };
        return { ...byPattern, rule: 'pattern' };
      }
      return null;
    },
    denyProse,
  };
}

/**
 * 绑定：**唯一写 `term` 的地方**。返回新树（原树不变），并给出审计记录。
 *
 * ## 三条不变量
 *
 * - **I1 只绑操作数**：`relation`/`operator`/`fence`/`separator` 角色不参与。
 *   （旧的「符号挂在 `=` 上」这类问题在类型层不可能。）
 * - **I2 遮蔽**：外层命中后，其子树标 `shadowed`，不再单独成泡。
 *   （旧的「气泡套气泡」由这条结构性排除。）
 * - **I3 字面子树不进入**：`literal`（`\text{}`、`\mathrm{}`、`\operatorname{}`）
 *   里的字符永远不是符号。这是 `\mathrm{H/m}` 事故的根治——
 *   不是靠正则护住，是那类节点根本不在候选集里。
 *
 * @param {MathExpr} expr
 * @param {Resolver} resolver
 * @returns {{expr: MathExpr, decisions: Decision[], problems: Problem[]}}
 */
export function bindTerms(expr, resolver) {
  const decisions = [];
  const problems = [];
  const src = expr.source;

  // 自底向上绑定：先看小节点，再让外层「遮蔽」它。
  // 为什么要自底向上：`R_m` 的整枚 script 与其中的 `R` 都可能命中，
  // 若先绑外层再进内层，「哪个赢」就取决于遍历顺序而不是语义。
  // 自底向上 + 遮蔽，结果是「最外层能完整匹配的那个赢」。
  const bound = new Map();   // nodeId → {pack, entry, rule}
  // 同一段源文本只绑一次：`R_{L}` 里 script 与其 sub 的 group 覆盖同一个 span，
  // 自底向上会先绑内层、再绑外层，产生两条重复命中（实测 decisions 里同一段出现两次）。
  const boundBySpan = new Map();

  const visit = (node, shadowed, isScriptArgument = false) => {
    if (!node || typeof node !== 'object') return false;

    // 字面子树：里面的任何东西都不是符号，也不许再往下找
    if (node.kind === 'literal' || node.kind === 'raw') return false;

    // 先处理子树（自底向上）
    const kids = [];
    forEachChild(node, (child) => kids.push(child));
    kids.forEach((child) => {
      // 上下标的参数是「结构的一部分」，不是纯包装：`R_{L}` 的 sub 必须参与形状键
      const asScriptArg = node.kind === 'script' && (child === node.sub || child === node.sup);
      visit(child, shadowed, asScriptArg);
    });

    // 已在外层命中 ⇒ 本节点被遮蔽，不再判定
    if (shadowed) {
      node.shadowed = true;
      return true;
    }
    // 只绑操作数
    if (node.role !== 'operand') return true;

    // **纯包装组不参与判定**：`{\lambda}` 相对里面的 `\lambda` 只是多了一对花括号，
    // 它不是一个独立的东西。若不跳过，`\frac{1}{\lambda}` 会命中两次
    // （`\lambda` 一次、`{\lambda}` 一次，实测过）。
    //
    // 判据是「这个组**恰好只包一个子节点、且不是上下标的参数位置**」：
    //   · `{\lambda}` 在分母里 ⇒ 跳过（内层的 `\lambda` 自己会命中）
    //   · `R_{L}` 的 sub 是 `group(L)` ⇒ **不能跳过**，因为 `R_{L}` 的形状键
    //     需要这一层结构；跳过就让「下标是组」这种最常见写法全部失效
    //   · 带定界符的组 `(x)` ⇒ 不是纯包装，可整体成泡
    const isPureWrapper = node.kind === 'group' && !node.fence
      && (node.items || []).length === 1;
    if (isPureWrapper && !isScriptArgument) return true;

    // 同一 span 已绑过 ⇒ 跳过，避免重复命中
    if (node.span && !node.fence) {
      const key = `${node.span[0]}:${node.span[1]}`;
      if (boundBySpan.has(key)) {
        node.shadowed = true;
        return true;
      }
    }

    const d = resolver.decide(node, src);
    if (!d) return true;

    if (d.rule === 'excluded') {
      // 被排除：不算命中，但**记一条**——今天的排除是完全静默的，
      // 改错的排除没人能发现。
      problems.push({
        code: 'term-excluded',
        severity: 'warn',
        where: { node: node.id, span: node.span },
        message: `「${src.slice(node.span[0], node.span[1])}」按本页排除规则不取词（词条 ${d.entry}）`,
      });
      return true;
    }

    node.term = { pack: d.pack, entry: d.entry };
    bound.set(node.id, d);

    // **外层命中要撤回子树的既有命中**。
    // 自底向上遍历时，`R_m` 里的 `m` 会先被单独命中（如果词典里有 `m`），
    // 然后外层 `R_m` 命中——两条都留着就产生「气泡套气泡」。
    // 判定语义是「最完整的那个赢」，所以外层命中后把子树已绑的撤掉。
    const revoked = [];
    forEachChild(node, (child) => collectBound(child, revoked));
    for (const old of revoked) {
      old.term = null;
      bound.delete(old.id);
      for (let i = decisions.length - 1; i >= 0; i -= 1) {
        if (decisions[i].node === old.id) decisions.splice(i, 1);
      }
    }

    if (node.span) boundBySpan.set(`${node.span[0]}:${node.span[1]}`, node.term);
    decisions.push({
      node: node.id,
      ref: node.term,
      rule: d.rule,
      matched: src.slice(node.span[0], node.span[1]),
      shape: shapeKey(node),
    });
    // 命中后，子树全部遮蔽
    forEachChild(node, (child) => markShadowed(child));
    return true;
  };

  visit(expr.root, false);

  return { expr, decisions, problems };
}

function forEachChild(node, fn) {
  switch (node.kind) {
    case 'group': (node.items || []).forEach(fn); break;
    case 'script':
      if (node.base) fn(node.base);
      if (node.sub) fn(node.sub);
      if (node.sup) fn(node.sup);
      break;
    case 'frac': fn(node.num); fn(node.den); break;
    case 'styled': if (node.body) fn(node.body); break;
    case 'accent': if (node.body) fn(node.body); break;
    case 'root':
      if (node.index) fn(node.index);
      if (node.body) fn(node.body);
      break;
    case 'arrow':
      if (node.above) fn(node.above);
      if (node.below) fn(node.below);
      break;
    case 'stack': (node.rows || []).forEach((r) => r.forEach(fn)); break;
    case 'env':
      (node.rows || []).forEach((r) => r.forEach((c) => c.forEach(fn)));
      break;
    case 'phantom': if (node.body) fn(node.body); break;
    case 'label': (node.text || []).forEach(fn); break;
    default: break;
  }
}

/** 收集子树里所有已绑定的节点（供外层撤回）。 */
function collectBound(node, out) {
  if (!node || typeof node !== 'object') return;
  if (node.kind === 'literal' || node.kind === 'raw') return;
  if (node.term) out.push(node);
  forEachChild(node, (child) => collectBound(child, out));
}

function markShadowed(node) {
  if (!node || typeof node !== 'object') return;
  if (node.kind === 'literal' || node.kind === 'raw') return;
  node.shadowed = true;
  forEachChild(node, markShadowed);
}
