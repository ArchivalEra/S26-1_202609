/**
 * `SearchCorpus` 端口的 **dist adapter**：读构建产物 `站点/dist/search/`。
 *
 * 端口职责（设计文档 §3.2）：提供「检索形态」的三样东西——页面清单（含小节锚点）、
 * 倒排桶、每页折叠正文。核心（ReadCore）只认这个形状，不认磁盘。
 *
 * **为什么检索只走 dist、不从源 markdown 重建**（设计文档的承重事实 B）：
 * 索引的抽取器 `extractSearchDoc` 吃的是**构建后的 HTML**；从源侧重建要么渲染全部页面（慢），
 * 要么重写折叠逻辑——后者直接违反「检索只有一份实现」。所以本 adapter 只读产物；
 * 产物缺失时报 `index_not_built`，**不自行构建**。
 *
 * `stale` 判定：产物顶层带 `sourceHash`（构建期对清单内每个源文件内容取 sha256 再整体取一次）。
 * 本 adapter 会**重算**当前源树的同一个 hash 并与产物比对——不一致即 `stale`（产物落后于源）。
 * 注意用**内容 hash 而非 mtime**：`git checkout` 会改 mtime，内容没变也会误判。
 */

import fs from 'node:fs';
import path from 'node:path';
// 源树 hash 的算法在 站点/源树hash.mjs（构建期与读层共用同一份实现）。
// 从前本文件自己抄了一份、靠注释「必须与 build.mjs 逐字一致」维系——
// 那种约定会静默失效（一边改分隔符，stale 判定永远说不 stale）。现在不可能再漂。
import { computeSourceHash } from '../../../站点/源树hash.mjs';

// 再导出，供测试与调用方从本 adapter 取（不改变它们的 import 路径）。
export { computeSourceHash };

const INDEX_REL = 'search/index.json';

/**
 * 建 dist adapter。
 * @param {{ distDir: string, root?: string, targetFiles?: string[] }} opts
 *   distDir：`站点/dist`；root + targetFiles 给了才能判 stale。
 */
export function createDistCorpus(opts) {
  const distDir = opts.distDir;
  const root = opts.root || null;
  const targetFiles = opts.targetFiles || null;

  let manifestCache = null;
  const bucketCache = new Map();
  const textCache = new Map();

  const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(distDir, rel), 'utf-8'));

  return {
    /** 页面清单（含每页小节锚点）。首次调用读盘，之后缓存。 */
    manifest() {
      if (manifestCache) return manifestCache;
      const p = path.join(distDir, INDEX_REL);
      if (!fs.existsSync(p)) {
        const err = new Error('搜索索引产物不存在');
        err.code = 'index_not_built';
        err.hint = '先在 站点/ 下跑 node build.mjs';
        throw err;
      }
      manifestCache = readJson(INDEX_REL);
      return manifestCache;
    },

    /** 按桶号取倒排（{grams, uni}）。桶不存在时返回空桶，与浏览器端同。 */
    bucket(n) {
      if (bucketCache.has(n)) return bucketCache.get(n);
      const p = path.join(distDir, `search/g/${n}.json`);
      const value = fs.existsSync(p) ? readJson(`search/g/${n}.json`) : { grams: {}, uni: {} };
      bucketCache.set(n, value);
      return value;
    },

    /** 取某页折叠正文（供摘要/单字计数）。 */
    text(id) {
      if (textCache.has(id)) return textCache.get(id);
      const p = path.join(distDir, `search/t/${id}.json`);
      const value = fs.existsSync(p) ? (readJson(`search/t/${id}.json`).text || '') : '';
      textCache.set(id, value);
      return value;
    },

    /**
     * 产物是否落后于源。返回 {stale, builtHash, currentHash, reason?}。
     * 没有 sourceHash（旧产物）⇒ stale=true 且 reason='no-hash'（如实报，不算错）。
     */
    staleness() {
      const m = this.manifest();
      if (!m.sourceHash) return { stale: true, builtHash: null, currentHash: null, reason: 'no-hash' };
      if (!root || !targetFiles) return { stale: false, builtHash: m.sourceHash, currentHash: null, reason: 'unchecked' };
      const current = computeSourceHash(root, targetFiles);
      return {
        stale: current !== m.sourceHash,
        builtHash: m.sourceHash,
        currentHash: current,
      };
    },
  };
}
