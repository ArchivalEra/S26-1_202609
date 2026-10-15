/**
 * `SymbolPacks` 端口：符号词典的**源侧** adapter。
 *
 * 直接复用站点构建期的两张表与两个解析器——**不重写**：
 *   - `站点/符号环境.mjs` 的 `SYMBOL_PACKS`（包 → 符号页路径）与 `COURSE_ENV`（课程 → 包链）；
 *   - `站点/plugins/math-glossary.mjs` 的 `parseGlossaryDict`（围栏 → 词条）。
 *
 * 语义与页面气泡**完全一致**：包链 `通用+电路原理` 用 `+` 拆开、**后者覆盖前者**；
 * 多义项按 `语境=含义` 列在 `senses`；**零回退**——链上没有的 id 就是没有，不去别的包捞。
 */

import fs from 'node:fs';
import path from 'node:path';
import { SYMBOL_PACKS, COURSE_ENV } from '../../../站点/符号环境.mjs';
import { parseGlossaryDict } from '../../../站点/plugins/math-glossary.mjs';

/**
 * 建符号词典 adapter。
 * @param {{ root:string }} opts
 */
export function createSourcePacks(opts) {
  const { root } = opts;
  const cache = new Map(); // 包名 → {id: {title,text,senses?}}

  /** 解析一个包（带缓存）。 */
  function pack(name) {
    if (cache.has(name)) return cache.get(name);
    const rel = SYMBOL_PACKS[name];
    if (!rel) {
      const err = new Error(`未知符号包：${name}`);
      err.code = 'no_symbol_pack';
      throw err;
    }
    const p = path.join(root, rel);
    const dict = fs.existsSync(p) ? parseGlossaryDict(fs.readFileSync(p, 'utf-8')) : {};
    cache.set(name, dict);
    return dict;
  }

  /** 课程 → 生效的包链（`通用+电路原理` → ['通用','电路原理']）。 */
  function chainOf(course) {
    const env = COURSE_ENV[course];
    const spec = env && env['符号'];
    if (!spec) return null;
    return spec.split('+').map((s) => s.trim()).filter(Boolean);
  }

  return {
    /** 列全部包名。 */
    packNames() {
      return Object.keys(SYMBOL_PACKS);
    },

    /** 课程 → 包链（没配符号环境的课返回 null）。 */
    chainOf,

    /**
     * 查词条。`course` 决定包链（后者覆盖前者）；不传则查**全部包**（并列返回）。
     * @param {{id?:string, q?:string, course?:string}} q
     * @returns {{env:string|null, matches:object[]}}
     */
    lookup(q) {
      const chain = q.course ? chainOf(q.course) : null;
      const names = chain || Object.keys(SYMBOL_PACKS);
      const merged = new Map(); // id → {pack, entry}（后者覆盖前者）
      for (const name of names) {
        const dict = pack(name);
        for (const [id, entry] of Object.entries(dict)) {
          merged.set(id, { pack: name, id, ...entry });
        }
      }
      let matches = [...merged.values()];
      if (q.id) matches = matches.filter((m) => m.id === q.id);
      if (q.q) {
        const needle = String(q.q).toLowerCase();
        matches = matches.filter((m) =>
          m.id.toLowerCase().includes(needle)
          || (m.title || '').toLowerCase().includes(needle)
          || (m.text || '').toLowerCase().includes(needle));
      }
      // 标注「当前语境」：多义项里属于本课的那条
      const ctx = q.course || null;
      matches = matches.map((m) => ({
        ...m,
        senses: (m.senses || []).map((s) => ({ ...s, isCurrentCtx: !!ctx && s.ctx === ctx })),
      }));
      return { env: chain ? chain.join('+') : null, matches };
    },
  };
}
