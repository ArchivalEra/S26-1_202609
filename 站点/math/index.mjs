/**
 * 对外接口：**两个入口，没有第三个**。
 *
 *   compile(源, 环境) → Doc      语义层：解析 + 唯一一次符号判定
 *   render(Doc, 渲染器) → HTML   排版层：纯投影
 *
 * ## 为什么只有两个
 *
 * 旧的数学管线有六处直接调渲染器（`build.mjs` 里四处、气泡文字一处、
 * `renderGlossary` 回调一处），每处各自决定「要不要取词」「错了怎么办」
 * 「降级成什么」。接口一多，规则就有六个副本，改一处忘五处——这正是
 * 「反复爆掉」的机制。
 *
 * 这里把「要不要取词」沉进 `compile`（一次），把「错了怎么办」沉进
 * `Diagnostic`（返回值，不是产物里的字符串）。
 */

import { parse } from './parser.mjs';
import { digest, toPlain, collectTerms, nodeCount } from './ir.mjs';
import { createResolver, bindTerms } from './terms.mjs';

/**
 * 编译一条或一页数学。
 *
 * @param {string|{blocks: {raw: string, mode: 'inline'|'display'}[], page?: string}} input
 *   传字符串 = 单条公式；传对象 = 一页里的全部公式（推荐，能统一出诊断）
 * @param {{
 *   dictionary: Dictionary,
 *   packs: string[],
 *   exclude?: {tex?: string[], prose?: string[]},
 *   forceTerm?: Record<string, string>,
 *   page?: string,
 * }} env
 * @returns {{
 *   docs: Doc[],
 *   problems: Problem[],
 *   stats: { formulas: number, terms: number, nodes: number },
 * }}
 */
export function compile(input, env) {
  const resolver = createResolver(env.dictionary, {
    packs: env.packs,
    exclude: env.exclude,
    forceTerm: env.forceTerm,
    page: env.page,
  });

  const blocks = typeof input === 'string'
    ? [{ raw: input, mode: 'inline' }]
    : (input.blocks || []);

  const docs = [];
  const problems = [];
  let termCount = 0;
  let nodeTotal = 0;

  blocks.forEach((block, index) => {
    const { expr, problems: parseProblems } = parse(block.raw, { mode: block.mode });
    const { expr: bound, decisions, problems: bindProblems } = bindTerms(expr, resolver);

    problems.push(...parseProblems.map((p) => ({ ...p, block: index })));
    problems.push(...bindProblems.map((p) => ({ ...p, block: index })));

    termCount += decisions.length;
    nodeTotal += nodeCount(bound);

    docs.push({
      index,
      expr: bound,
      decisions,
      plain: toPlain(bound),
      digest: digest(bound),
      terms: collectTerms(bound),
    });
  });

  return {
    docs,
    problems,
    stats: { formulas: docs.length, terms: termCount, nodes: nodeTotal },
  };
}

/**
 * 渲染：Doc → HTML。**纯投影，不判定、不改树**。
 *
 * @param {Doc} doc
 * @param {Renderer} renderer  `{render(expr), probe()}`，见 `render.mjs`
 * @param {{
 *   resolveHref?: (key: string) => {href: string, label?: string} | null,
 * }} [opts]
 * @returns {{html: string, problems: Problem[], rewrites: string[], anchors: number}}
 */
export function render(doc, renderer, opts = {}) {
  // 把纯文本投影一并交给渲染器：它写进 aria-label，读屏与 AI 都读这份。
  // 这样「图形」与「文本」是同一棵树的两次投影，不是两套各自解析的表示。
  const exprWithPlain = { ...doc.expr, plainHint: doc.plain };
  const out = renderer.render(exprWithPlain, { decorate: opts.decorate !== false });
  const problems = [...out.problems];

  let html = out.html;
  let anchors = 0;

  // 锚点包裹：产物里的 `<span data-term>` → `<a class="sym-gloss">`。
  // 放在这一层的理由：两个引擎都不产 `<a>`，所以「锚点是链接」只能在这里补；
  // 而这里的输入只是 `<span data-term>` 这个最小契约，换引擎不用改。
  if (opts.resolveHref) {
    const { decorateAnchors } = opts;
    if (typeof decorateAnchors === 'function') {
      const dec = decorateAnchors(html, { resolve: opts.resolveHref });
      html = dec.html;
      anchors = dec.decorated;
      dec.missing.forEach((key) => problems.push({
        code: 'term-href-missing',
        severity: 'warn',
        where: { key, block: doc.index },
        message: `词条 ${key} 在当页环境里找不到链接目标`,
      }));
    }
  }

  return { html, problems, rewrites: out.rewrites || [], anchors };
}

/**
 * 启动期自检：渲染器契约是否成立。**每构建跑一次，失败就别开工**。
 *
 * 这是替代「每条公式嗅探产物字符串」的东西：检查一次协议，而不是嗅 11514 次。
 */
export function probeRenderer(renderer) {
  const problems = [];
  if (typeof renderer.render !== 'function') {
    problems.push({
      code: 'adapter-contract',
      severity: 'error',
      message: '渲染器没有 render 方法',
    });
    return problems;
  }
  if (typeof renderer.probe === 'function') {
    problems.push(...renderer.probe());
  }
  return problems;
}
