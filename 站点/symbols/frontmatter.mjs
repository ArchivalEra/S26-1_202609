/**
 * OKF v0.2 frontmatter 统一解析器（构建期与本地 MCP 共用同一份 YAML 解析）。
 *
 * 替代过去 `build.mjs` 内部散落调用与 `工具/mcp-端点/lib/read-core.mjs` 的
 * 单行标量正则（后者会直接丢失 `符号排除` 列表与 `符号强制` 映射）。
 */

import * as yaml from 'js-yaml';

const defaultYamlProvider = { parse: (source) => yaml.load(source) };

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * 创建同步 frontmatter 解析器，保留严格报错与宽松回退的站点策略。
 *
 * @param {{parse: (source: string) => any}} [provider]
 * @returns {(source: string, opts?: {strict?: boolean, filePath?: string}) => {
 *   meta: Record<string, any>, body: string, rawFrontmatter: string, hasFrontmatter: boolean
 * }}
 */
export function createFrontmatterParser(provider = defaultYamlProvider) {
  return function parseFrontmatter(source, opts = {}) {
    const text = String(source || '');
    const m = FM_RE.exec(text);
    if (!m) {
      return { meta: {}, body: text, rawFrontmatter: '', hasFrontmatter: false };
    }
    const rawFrontmatter = m[1];
    const body = text.slice(m[0].length);
    let parsed = {};
    try {
      const loaded = provider.parse(rawFrontmatter);
      if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
        parsed = loaded;
      }
    } catch (err) {
      if (opts.strict) {
        const label = opts.filePath ? ` ${opts.filePath}` : '';
        throw new Error(`frontmatter 解析失败${label}: ${err.message}`, { cause: err });
      }
      parsed = {};
    }
    return { meta: parsed, body, rawFrontmatter, hasFrontmatter: true };
  };
}

export const parseFrontmatter = createFrontmatterParser();

function asIdList(v) {
  let arr = [];
  if (Array.isArray(v)) arr = v;
  else if (v) arr = [v];
  return arr.map((s) => String(s).trim()).filter(Boolean);
}

/**
 * 从 OKF v0.2 frontmatter 抽取本页的符号策略字段。
 *
 * @param {Record<string, any>} meta
 * @returns {{
 *   okfId: string,
 *   course: string,
 *   pins: Record<string, string>,
 *   exclude: { prose: string[], tex: string[] },
 * }}
 */
export function readPageSymbolPolicy(meta = {}) {
  const rawPins = meta['符号强制'];
  const pins = {};
  if (rawPins && typeof rawPins === 'object' && !Array.isArray(rawPins)) {
    for (const [k, v] of Object.entries(rawPins)) {
      const id = String(k).trim();
      const pack = String(v || '').trim();
      if (id && pack) pins[id] = pack;
    }
  }
  return {
    okfId: meta.id ? String(meta.id).trim() : '',
    course: meta.course ? String(meta.course).trim() : '',
    pins,
    exclude: {
      prose: asIdList(meta['符号排除']),
      tex: asIdList(meta['符号排除公式']),
    },
  };
}
