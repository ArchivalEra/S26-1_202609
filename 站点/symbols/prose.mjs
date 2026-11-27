/**
 * 正文符号取词与令牌渲染（使用统一的 formatSymbolAnchor 契约）。
 */

import { escHtml, formatSymbolAnchor } from './contracts.mjs';
import { stripDictFences } from './fences.mjs';

const FENCE_RE = /^[\t ]{0,3}(`{3,}|~{3,})/;
const TOKEN_RE = /\[([^\][\n]+)\]\{#(?:([^\][{}:\n]+):)?([A-Za-z_][A-Za-z0-9_-]*)\}/g;
// 保护：行内代码 / 行内数学 / 符号令牌 / 完整 Markdown 链接 / 构建占位符 / <summary> 折叠标题 / HTML 标签。
const PROTECT_RE = /(`[^`\n]*`|\$[^$\n]*\$|\[[^\]\n]+\]\{#(?:[^\]:{}\n]+:)?[A-Za-z_][A-Za-z0-9_-]*\}|\[[^\]\n]+\]\([^)\n]*\)|@@[A-Z_]+_\d+@@|<summary\b[^>]*>.*?<\/summary>|<[^>\n]+>)/;
const SKIP_AFTER = '图表级相极端样附';

export function autoWrapTerms(source, dict = {}) {
  const forms = [];
  for (const [id, entry] of Object.entries(dict)) {
    for (const form of entry.prose || []) if (form) forms.push({ form, id });
  }
  if (!forms.length) return source;
  forms.sort((a, b) => b.form.length - a.form.length);
  const alt = forms.map((x) => x.form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const idOf = new Map(forms.map((x) => [x.form, x.id]));
  const re = new RegExp(`(${alt})(?![A-Za-z0-9_₀-₉ᵣ])`, 'g');
  let inFence = false;
  return source
    .split('\n')
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
            const before = offset > 0 ? seg[offset - 1] : '';
            const rest = seg.slice(offset + form.length).replace(/^[\s\u3000]+/, '');
            const after = rest[0] || '';
            if (before && /\w/.test(before)) return whole;
            if (after && SKIP_AFTER.includes(after)) return whole;
            return `[${form}]{#${idOf.get(form)}}`;
          });
        })
        .join('');
    })
    .join('\n');
}

function resolvePackTerm(packs, pack, term) {
  const p = packs?.[pack];
  if (!p) return { miss: `令牌指向未注册的符号包「${pack}」` };
  const e = p.dict[term];
  if (!e || e.bubble === false) return { miss: `包「${pack}」没有词条 ${term}` };
  return { key: e.key || `${pack}:${term}`, entry: e, href: `${p.hrefBase}#${term}` };
}

function resolvePinnedTerm(packs, pins, term) {
  const packName = pins[term];
  const p = packs?.[packName];
  const e = p?.dict[term];
  if (!e || e.bubble === false) {
    return { miss: `符号强制指向的包「${packName}」没有词条 ${term}` };
  }
  return { key: e.key || `${packName}:${term}`, entry: e, href: `${p.hrefBase}#${term}` };
}

function resolveEnvTerm(tokens, notationHref, envName, term) {
  if (!Object.hasOwn(tokens, term)) {
    return { miss: `环境包「${envName}」没有词条 ${term}，令牌原样保留` };
  }
  const e = tokens[term];
  if (e.bubble === false) {
    return { miss: `词条 ${term} 只声明了形式、没有气泡内容（补词典行才会生效）` };
  }
  const key = e.key || (e.pack ? `${e.pack}:${term}` : term);
  return { key, entry: e, href: e.href || `${notationHref}#${term}` };
}

function resolveTermWithContext(ctx, pack, term) {
  if (pack !== undefined) return resolvePackTerm(ctx.packs, pack, term);
  if (ctx.pins && Object.hasOwn(ctx.pins, term)) return resolvePinnedTerm(ctx.packs, ctx.pins, term);
  return resolveEnvTerm(ctx.tokens, ctx.notationHref, ctx.envName, term);
}

function renderInnerTex(tex, opts) {
  const realTex = opts.resolvePlaceholderTex ? opts.resolvePlaceholderTex(tex) : tex;
  return opts.renderTex && realTex.trim() !== '' ? opts.renderTex(realTex) : escHtml(realTex);
}

function emitGlossaryHit(onHit, key, entry, pack, pins, term, href) {
  if (!onHit) return;
  const hit = {
    pack: entry.pack || pack || pins?.[term] || '',
    id: entry.id || term,
    title: entry.title,
    text: entry.text,
    href,
  };
  if (entry.senses) hit.senses = entry.senses;
  onHit(key, hit);
}

function hasGlossaryWork(source, wrapped) {
  const hit =
    source.includes(':::glossary-dict') ||
    source.includes(':::glossary-match') ||
    TOKEN_RE.test(wrapped);
  TOKEN_RE.lastIndex = 0;
  return hit;
}

function buildGlossaryReplacer(ctx, opts) {
  const { renderTex, resolvePlaceholderTex, onWarn, onHit, pins } = opts;
  return (match, tex, pack, term) => {
    const r = resolveTermWithContext(ctx, pack, term);
    if (r.miss) {
      onWarn?.(r.miss);
      return match;
    }
    const { key, entry, href } = r;
    const inner = renderInnerTex(tex, { renderTex, resolvePlaceholderTex });
    const label = entry.titleText || entry.title;
    emitGlossaryHit(onHit, key, entry, pack, pins, term, href);
    return formatSymbolAnchor({ key, href, label, innerHtml: inner });
  };
}

function buildGlossaryCtx(opts, dict) {
  return {
    tokens: opts.tokenDict || dict,
    packs: opts.packs ?? null,
    pins: opts.pins ?? null,
    envName: opts.envName ?? '',
    notationHref: opts.notationHref ?? '',
  };
}

export function renderGlossary(source, opts = {}) {
  if (typeof source !== 'string') return source;
  const dict = opts.dict || {};
  const ctx = buildGlossaryCtx(opts, dict);

  const tables = [];
  const tableReplacer = opts.dictTable
    ? (entries) => {
        tables.push(opts.dictTable(entries));
        return `@@GLOSS_TABLE_${tables.length - 1}@@`;
      }
    : null;
  const stripped = stripDictFences(source.split(/\r?\n/), tableReplacer).join('\n');
  const wrapped = autoWrapTerms(stripped, dict);
  if (!hasGlossaryWork(source, wrapped)) return source;

  return wrapped
    .replace(TOKEN_RE, buildGlossaryReplacer(ctx, opts))
    .replace(/@@GLOSS_TABLE_(\d+)@@/g, (match, i) => tables[Number(i)] ?? '');
}
