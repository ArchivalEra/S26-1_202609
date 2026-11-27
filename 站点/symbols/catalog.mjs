/**
 * 符号深核心：词库装载/编译 + 查词 + 页面会话（统一规范键 `包:词条`）。
 *
 * 零 DOM、零 KaTeX、零传输 —— HTML 构建、/machine/、WebMCP、本地 stdio MCP 共用这唯一语义内核。
 */

import fs from 'node:fs';
import path from 'node:path';
import { SYMBOL_PACKS, COURSE_ENV, BUILD_PHASES } from '../符号环境.mjs';
import { compileDictionary } from '../math/terms.mjs';
import { escHtml, plainBubbleText } from './contracts.mjs';
import { parseFrontmatter, readPageSymbolPolicy } from './frontmatter.mjs';
import {
  parseGlossaryDict,
  parseGlossaryMatch,
  validateMatchSyntax,
  applySymbolExclusions,
} from './fences.mjs';
import { renderGlossary } from './prose.mjs';

function defaultCourseOf(relPath) {
  return String(relPath || '').split('/')[1] || '';
}

function parseSlashRegex(raw) {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(String(raw || ''));
  if (!m) return null;
  try {
    return new RegExp(m[1], m[2]);
  } catch {
    return null;
  }
}

function matchesSingleForm(f, q) {
  if (f === q || f.replace(/^\\/, '') === q.replace(/^\\/, '')) return true;
  const rx = parseSlashRegex(f);
  if (!rx) return false;
  rx.lastIndex = 0;
  const m = rx.exec(q);
  return Boolean(m && m[0] === q);
}

function matchesForm(entry, formNeedle) {
  const q = String(formNeedle || '').trim();
  if (!q) return false;
  const plainTitle = plainBubbleText(entry.title).replace(/[：:].*$/, '').trim();
  if (plainTitle === q) return true;
  return [...(entry.prose || []), ...(entry.tex || [])].some((f) => matchesSingleForm(f, q));
}

function loadPackSource(root, relPage, provided, warnings, packName) {
  if (provided?.source != null) return provided.source;
  const abs = path.join(root, relPage);
  if (!fs.existsSync(abs)) {
    warnings.push(`包「${packName}」的页面不在仓库里：${relPage}`);
    return null;
  }
  return fs.readFileSync(abs, 'utf-8');
}

function buildPackDict(packName, source, warnings) {
  const entries = parseGlossaryDict(source);
  const matches = parseGlossaryMatch(source);
  warnings.push(...validateMatchSyntax(packName, matches));

  const dict = {};
  for (const [id, e] of Object.entries(entries)) {
    dict[id] = {
      ...e,
      key: `${packName}:${id}`,
      pack: packName,
      id,
      titleText: plainBubbleText(e.title),
      bubble: true,
    };
  }
  for (const [id, m] of Object.entries(matches)) {
    if (dict[id]) dict[id] = { ...dict[id], prose: m.prose, tex: m.tex };
    else warnings.push(`包「${packName}」的 ${id} 只声明了形式、没有词条内容——自动取词不生效`);
  }
  return dict;
}

function lookupByKey(key, packs) {
  const idx = String(key).indexOf(':');
  if (idx <= 0) return [];
  const p = packs[String(key).slice(0, idx)];
  const e = p?.dict?.[String(key).slice(idx + 1)];
  return e ? [{ ...e, page: p.page }] : [];
}

function lookupByCourse(q, packs, packChainFor) {
  const chainInfo = packChainFor({ course: q.course, relPath: q.relPath || '' });
  const merged = new Map();
  for (const name of chainInfo.packNames) {
    const p = packs[name];
    if (!p) continue;
    for (const [id, e] of Object.entries(p.dict)) merged.set(id, { ...e, page: p.page });
  }
  return { chainInfo, rawEntries: [...merged.values()] };
}

function collectLookupEntries(q, packs, packChainFor) {
  if (q.key) return { chainInfo: null, rawEntries: lookupByKey(q.key, packs) };
  if (q.pack) {
    const p = packs[q.pack];
    return { chainInfo: null, rawEntries: Object.values(p.dict).map((e) => ({ ...e, page: p.page })) };
  }
  if (q.course) return lookupByCourse(q, packs, packChainFor);
  const rawEntries = [];
  for (const p of Object.values(packs)) {
    for (const e of Object.values(p.dict)) rawEntries.push({ ...e, page: p.page });
  }
  return { chainInfo: null, rawEntries };
}

function hasNeedle(val, needle) {
  return String(val || '').toLowerCase().includes(needle);
}

function entryMatchesNeedle(e, needle) {
  const hasIn = (arr) => (arr || []).some((f) => f.toLowerCase().includes(needle));
  const hasSense = (e.senses || []).some(
    (s) => hasNeedle(s.text, needle) || hasNeedle(s.ctx, needle),
  );
  return (
    hasNeedle(e.key, needle)
    || hasNeedle(e.id, needle)
    || hasNeedle(e.title, needle)
    || hasNeedle(e.text, needle)
    || hasIn(e.prose)
    || hasIn(e.tex)
    || hasSense
  );
}

function formatLookupEntry(e, ctx) {
  const senses = (e.senses || []).map((s) => ({ ...s, isCurrentCtx: Boolean(ctx && s.ctx === ctx) }));
  const out = { key: e.key, pack: e.pack, id: e.id, page: e.page, title: e.title, text: e.text };
  if (senses.length) out.senses = senses;
  if (e.prose?.length) out.prose = e.prose;
  if (e.tex?.length) out.tex = e.tex;
  return out;
}

function lookupFigureEntry(ref, packsForPage, pins, pageDict) {
  const colon = ref.indexOf(':');
  if (colon > 0) {
    const p = packsForPage[ref.slice(0, colon)];
    return p ? (p.dict[ref.slice(colon + 1)] || null) : null;
  }
  if (Object.hasOwn(pins, ref)) {
    const p = packsForPage[pins[ref]];
    return p ? (p.dict[ref] || null) : null;
  }
  return pageDict[ref] || null;
}

function resolvePackMeta(source, relPage, provided, packName) {
  const { meta } = parseFrontmatter(source, { strict: false, filePath: relPage });
  const fm = provided?.frontmatter || meta || {};
  return {
    okfId: fm.id ? String(fm.id) : '',
    course: fm.course ? String(fm.course) : packName,
  };
}

function buildOnePack(packName, packPage, opts, root, warnings) {
  const provided = opts.packsData?.[packName];
  const relPage = provided?.page || packPage;
  const source = loadPackSource(root, relPage, provided, warnings, packName);
  if (source === null) return null;
  const { okfId, course } = resolvePackMeta(source, relPage, provided, packName);
  return {
    name: packName,
    page: relPage,
    htmlPage: relPage.replace(/\\/g, '/').replace(/\.md$/, '.html'),
    okfId,
    course,
    dict: buildPackDict(packName, source, warnings),
  };
}

function filterLookupEntries(rawEntries, q) {
  let out = rawEntries;
  if (q.id) out = out.filter((e) => e.id === q.id || e.key === q.id);
  if (q.form) out = out.filter((e) => matchesForm(e, q.form));
  if (q.q) {
    const needle = String(q.q).toLowerCase();
    out = out.filter((e) => entryMatchesNeedle(e, needle));
  }
  return out;
}

function buildHitItem(key, entry) {
  const idx = String(key).indexOf(':');
  const pack = entry.pack || (idx > 0 ? String(key).slice(0, idx) : '');
  const id = entry.id || (idx > 0 ? String(key).slice(idx + 1) : String(key));
  const item = { key, pack, id, title: entry.title, text: entry.text, href: entry.href };
  if (entry.senses?.length) item.senses = entry.senses;
  return item;
}

function buildFinalizeTerms(hits, toHtml, toPlain, here) {
  const terms = {};
  const rawHits = {};
  for (const [key, e] of hits.entries()) {
    if (e?.title === undefined) continue;
    rawHits[key] = e;
    const item = {
      pack: e.pack,
      id: e.id,
      title: toHtml(e.title),
      titleText: toPlain(e.title),
      text: toHtml(e.text),
      plainText: toPlain(e.text),
      href: e.href,
    };
    if (e.senses?.length) {
      item.senses = e.senses.map((s) => ({
        ctx: s.ctx,
        text: toHtml(s.text),
        plainText: toPlain(s.text),
        here: Boolean(here && s.ctx === here),
      }));
      item.ctx = here;
    }
    terms[key] = item;
  }
  return { terms, rawHits };
}

function buildPageDictEntries(pack, relPath, pageRelativeHref) {
  const out = {};
  for (const [id, e] of Object.entries(pack.dict)) {
    out[id] = {
      ...e,
      key: `${pack.name}:${id}`,
      pack: pack.name,
      id,
      href: pageRelativeHref(relPath, pack.page, id),
      titleText: plainBubbleText(e.title),
    };
  }
  return out;
}

function buildPageDict(envPacks, relPath, pageRelativeHref) {
  const pageDict = {};
  for (const pack of envPacks) {
    if (pack) Object.assign(pageDict, buildPageDictEntries(pack, relPath, pageRelativeHref));
  }
  return pageDict;
}

function buildPacksForPage(packs, relPath, pageRelativeBase, pageRelativeHref) {
  return Object.fromEntries(
    Object.entries(packs).map(([name, pack]) => [
      name,
      {
        hrefBase: pageRelativeBase(relPath, pack.page),
        dict: buildPageDictEntries(pack, relPath, pageRelativeHref),
      },
    ]),
  );
}

function applyPagePins(pageDict, packsForPage, pins, pageWarns) {
  const effectiveDict = { ...pageDict };
  for (const [termId, targetPack] of Object.entries(pins)) {
    const pinned = packsForPage[targetPack]?.dict[termId];
    if (pinned) effectiveDict[termId] = pinned;
    else pageWarns.push(`符号强制指向的包「${targetPack}」没有词条 ${termId}`);
  }
  return effectiveDict;
}

function buildPacksFromRegistry(registry, opts, root, warnings) {
  const packs = {};
  for (const [packName, packPage] of Object.entries(registry)) {
    const built = buildOnePack(packName, packPage, opts, root, warnings);
    if (built) packs[packName] = built;
  }
  return packs;
}

/**
 * 构建全站唯一符号目录核心。
 *
 * @param {{
 *   root?: string,
 *   parseMath?: Function,
 *   compileMathDict?: boolean,
 *   packsRegistry?: Record<string, string>,
 *   courseEnv?: Record<string, Record<string, string>>,
 *   buildPhases?: object[],
 *   packsData?: Record<string, { page?: string, source?: string, frontmatter?: object }>,
 * }} [opts]
 */
export function createSymbolCatalog(opts = {}) {
  const root = opts.root || process.cwd();
  const courseEnv = opts.courseEnv || COURSE_ENV;
  const buildPhases = opts.buildPhases || BUILD_PHASES;

  const warnings = [];
  const dictProblems = [];
  const packs = buildPacksFromRegistry(opts.packsRegistry || SYMBOL_PACKS, opts, root, warnings);

  let mathDictionary = null;
  if (opts.parseMath && opts.compileMathDict !== false) {
    const compiled = compileDictionary(
      Object.fromEntries(
        Object.entries(packs).map(([name, pack]) => [
          name,
          {
            page: pack.page,
            entries: Object.entries(pack.dict).map(([id, e]) => ({
              id,
              tex: e.tex || [],
              bubble: e.bubble !== false,
            })),
          },
        ]),
      ),
      { parse: opts.parseMath },
    );
    mathDictionary = compiled.dictionary;
    dictProblems.push(...compiled.problems);
  }

  function packChainFor({ course = '', relPath = '' } = {}) {
    const baseEnv = courseEnv[course] || {};
    const phase = buildPhases.find((ph) => ph.pages?.includes(relPath));
    const envSpec = { ...baseEnv, ...phase?.env }['符号'] || null;
    const packNames = envSpec ? envSpec.split('+').map((s) => s.trim()).filter(Boolean) : [];
    return { envName: envSpec, packNames };
  }

  function pageRelativeHref(fromRelPath, targetPackPage, entryId) {
    const fromAbs = path.join(root, fromRelPath || 'README.md');
    const toAbs = path.join(root, targetPackPage);
    return (
      encodeURI(
        path.relative(path.dirname(fromAbs), toAbs).replace(/\\/g, '/').replace(/\.md$/, '.html'),
      ) + '#' + entryId
    );
  }

  function pageRelativeBase(fromRelPath, targetPackPage) {
    const fromAbs = path.join(root, fromRelPath || 'README.md');
    const toAbs = path.join(root, targetPackPage);
    return encodeURI(
      path.relative(path.dirname(fromAbs), toAbs).replace(/\\/g, '/').replace(/\.md$/, '.html'),
    );
  }

  return {
    packs,
    warnings,
    dictProblems,
    mathDictionary,

    manifest() {
      const packMeta = {};
      for (const [name, p] of Object.entries(packs)) {
        packMeta[name] = {
          name,
          page: p.page,
          htmlPage: p.htmlPage,
          okfId: p.okfId,
          course: p.course,
          entriesCount: Object.keys(p.dict).length,
        };
      }
      return {
        packs: packMeta,
        courseEnv: Object.fromEntries(
          Object.entries(courseEnv).map(([k, v]) => [k, v?.['符号'] || null]),
        ),
        buildPhases: [...buildPhases],
        packChainFor,
        mathDictionary,
      };
    },

    /**
     * 统一查词接口（本地 MCP / 工具 / 跨端校验共用）：
     * - 指定 `key`（`包:词条`）：精确命中一条；
     * - 指定 `course`：按课程包链（后者覆盖前者同名 `id`），并标记 `senses[].isCurrentCtx`；
     * - 不指定 `course` 与 `pack`：**多包并列返回**（以规范键 `包:词条` 保留每包各自词条，绝不覆写）；
     * - 支持 `form` 按 `:::glossary-match` 词形/TeX 形式或标题记号反查。
     */
    lookup(q = {}) {
      if (q.pack && !packs[q.pack]) {
        const err = new Error(`未知符号包：${q.pack}`);
        err.code = 'no_symbol_pack';
        throw err;
      }
      const { chainInfo, rawEntries } = collectLookupEntries(q, packs, packChainFor);
      const filtered = filterLookupEntries(rawEntries, q);
      const ctx = q.course || null;
      return {
        env: chainInfo ? chainInfo.envName : null,
        chain: chainInfo ? chainInfo.packNames : null,
        matches: filtered.map((e) => formatLookupEntry(e, ctx)),
      };
    },

    /**
     * 构造全站机器导出结构（供 `/machine/symbols/index.json` 与 `/machine/symbols/<包>.json`）。
     */
    machineCatalog({ machineBase = '' } = {}) {
      const packFiles = {};
      const packIndex = {};
      for (const [name, p] of Object.entries(packs)) {
        const fileName = `${name}.json`;
        packFiles[name] = {
          pack: name,
          okfId: p.okfId,
          course: p.course,
          sourcePage: p.page,
          entries: Object.values(p.dict).map((e) => {
            const row = {
              key: e.key,
              id: e.id,
              title: e.title,
              text: e.text,
            };
            if (e.senses?.length) row.senses = e.senses;
            if (e.prose?.length) row.prose = e.prose;
            if (e.tex?.length) row.tex = e.tex;
            return row;
          }),
        };
        packIndex[name] = {
          okfId: p.okfId,
          course: p.course,
          sourcePage: p.page,
          entriesCount: Object.keys(p.dict).length,
          file: fileName,
          url: machineBase ? `${machineBase}symbols/${encodeURI(fileName)}` : fileName,
        };
      }

      return {
        indexJson: {
          note: '全站符号系统机器目录：课程通过 courseEnv 解析包链（+ 表示叠加，后者覆盖前者）；页面 frontmatter 的 pins/exclusions 见单页 JSON 的 symbols 字段。',
          courseEnv: Object.fromEntries(
            Object.entries(courseEnv).map(([c, v]) => [c, v?.['符号'] || null]),
          ),
          buildPhases: buildPhases.map((ph) => ({
            label: ph.label,
            env: ph.env?.['符号'] || null,
            pages: ph.pages || [],
          })),
          packs: packIndex,
        },
        packFiles,
      };
    },

    /**
     * 打开一个页面的符号解析会话：唯一环境装配与命中记账入口。
     */
    openPage({ relPath = '', frontmatter = {}, course = '' } = {}) {
      const policy = readPageSymbolPolicy(frontmatter);
      const here = course || policy.course || defaultCourseOf(relPath);
      const { envName, packNames } = packChainFor({ course: here, relPath });
      const pageWarns = [];

      const envPacks = packNames.map((n) => {
        if (!packs[n]) pageWarns.push(`页面 ${relPath} 锚定的符号包「${n}」未注册——本页零符号行为`);
        return packs[n];
      });

      const pageDict = buildPageDict(envPacks, relPath, pageRelativeHref);
      const packsForPage = buildPacksForPage(packs, relPath, pageRelativeBase, pageRelativeHref);
      const effectiveDict = applyPagePins(pageDict, packsForPage, policy.pins, pageWarns);

      const { proseDict, texDict } = applySymbolExclusions(
        effectiveDict,
        policy.exclude,
        (msg) => pageWarns.push(msg),
      );

      const hits = new Map();
      const matchedForms = new Set();

      function recordHit(key, entry) {
        if (!key || !entry || hits.has(key)) return;
        hits.set(key, buildHitItem(key, entry));
      }

      function resolveEntryByKey(key) {
        if (hits.has(key)) return hits.get(key);
        const idx = String(key).indexOf(':');
        if (idx > 0) {
          const packName = String(key).slice(0, idx);
          const id = String(key).slice(idx + 1);
          const entry = packsForPage[packName]?.dict?.[id];
          if (entry) {
            recordHit(key, entry);
            return hits.get(key);
          }
        }
        return null;
      }

      return {
        envName,
        packNames,
        ctx: here,
        pins: policy.pins,
        exclusions: policy.exclude,
        pageDict,
        proseDict,
        texDict,
        warnings: pageWarns,

        mathEnv() {
          return {
            dictionary: mathDictionary,
            packs: packNames,
            exclude: { tex: policy.exclude.tex, prose: policy.exclude.prose },
            forceTerm: policy.pins,
            page: relPath,
          };
        },

        recordMathTerms(terms) {
          for (const t of terms || []) {
            const { pack, entry: id } = t.ref;
            recordHit(`${pack}:${id}`, packsForPage[pack]?.dict[id]);
          }
        },

        recordMathDoc(doc) {
          if (!doc) return;
          for (const d of doc.decisions || []) {
            if (d.matched && d.ref) matchedForms.add(d.matched.trim());
          }
          this.recordMathTerms(doc.terms);
        },

        resolveHref(key) {
          const hit = resolveEntryByKey(key);
          return hit ? { href: hit.href, label: plainBubbleText(hit.title) } : null;
        },

        resolveProse(source, proseOpts = {}) {
          return renderGlossary(source, {
            dict: proseDict,
            tokenDict: pageDict,
            packs: packsForPage,
            pins: policy.pins,
            envName: envName || '',
            renderTex: proseOpts.renderTex || null,
            resolvePlaceholderTex: proseOpts.resolvePlaceholderTex || null,
            dictTable: proseOpts.renderDictTable
              ? (entries) =>
                  proseOpts.renderDictTable(
                    entries.map((ent) => {
                      const e = pageDict[ent.id] || {};
                      return {
                        id: ent.id,
                        title: e.title ?? ent.title ?? ent.id,
                        text: e.text ?? ent.text ?? '',
                      };
                    }),
                  )
              : null,
            notationHref: '',
            onWarn: (msg) => pageWarns.push(msg),
            onHit: (key, entry) => recordHit(key, entry),
          });
        },

        /**
         * 图元 `@词条` / `@包:词条` 解析：统一支持跨包 `@包:id`、页面 `符号强制` 与默认环境词典。
         */
        resolveFigureTerm(termRef) {
          const ref = String(termRef || '').trim();
          if (!ref) return null;
          const entry = lookupFigureEntry(ref, packsForPage, policy.pins, pageDict);
          if (!entry || entry.bubble === false) return null;
          recordHit(entry.key, entry);
          return {
            key: entry.key,
            pack: entry.pack,
            id: entry.id,
            href: entry.href,
            title: entry.title,
            text: entry.text,
            senses: entry.senses,
          };
        },

        recordBubbleHit(key, entry) {
          recordHit(key, entry);
        },

        finalize({ renderBubbleText, plainBubbleText: customPlain } = {}) {
          const toHtml = renderBubbleText || escHtml;
          const toPlain = customPlain || plainBubbleText;
          const { terms, rawHits } = buildFinalizeTerms(hits, toHtml, toPlain, here);

          const termKeys = Object.keys(terms);
          const hasExcl = policy.exclude.prose.length > 0 || policy.exclude.tex.length > 0;
          const machineSummary = {
            env: envName,
            packs: packNames,
            ctx: here,
            ...(Object.keys(policy.pins).length ? { pins: policy.pins } : {}),
            ...(hasExcl ? { exclusions: policy.exclude } : {}),
            termKeys,
          };

          return {
            env: envName,
            packs: packNames,
            ctx: here,
            pins: policy.pins,
            exclusions: policy.exclude,
            termKeys,
            hits: rawHits,
            glossaryJsonPayload: {
              env: envName,
              ctx: here,
              terms,
            },
            machineSummary,
            matchedForms: new Set(matchedForms),
            warnings: [...pageWarns],
          };
        },
      };
    },
  };
}
