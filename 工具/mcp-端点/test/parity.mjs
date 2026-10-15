/**
 * parity 快照生成器：把「读层检索结果」与「浏览器端检索结果」逐项对照。
 *
 * 这是设计文档第 3 步的硬闸（「不做完不往下走」）：读层与站内搜索面板必须给出
 * **逐项一致的命中顺序**。做法：
 *   1. 读层侧：用 `corpus-dist` + `检索核心` 在 Node 里算一遍（本文件）；
 *   2. 浏览器侧：把同一批查询喂给真实页面的搜索框，抓它的结果（另一步，见 parity 脚本）；
 *   3. 比对：命中 url 序列、每条的 score / total / anchor。
 *
 * 本文件只负责第 1 步，并输出 JSON 供比对。查询集固定（覆盖：中文词、跨页词、
 * 单位/字母、长短语、单字、无结果词）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDistCorpus } from '../lib/corpus-dist.mjs';
import { collectHits, fillSingleCharCounts } from '../lib/检索核心.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../../..');
export const DIST = path.join(ROOT, '站点/dist');

/** 固定查询集：覆盖检索的各类边界。 */
export const PARITY_QUERIES = [
  '变压器',
  '额定电流',
  '戴维南',
  '沙路法则',
  '卡诺图',
  '逻辑化简',
  'KCL',
  'jXL',
  '欧姆',
  '磁滞损耗',
  '逆矩阵',
  '克拉默',
  '异或门',
  '状态表',
  '波形',
  '的',
  '无此词汇xyz',
];

/** 用读层算一批查询的命中（形状与浏览器端可对照的字段）。 */
export function readLayerHits(queries = PARITY_QUERIES) {
  const corpus = createDistCorpus({ distDir: DIST });
  const data = corpus.manifest();
  const out = {};
  for (const q of queries) {
    let { query, hits, grams } = collectHits(data, (n) => corpus.bucket(n), q);
    hits = fillSingleCharCounts(hits, grams, (id) => corpus.text(id));
    out[q] = {
      query,
      total: hits.length,
      hits: hits.map((h) => ({
        url: h.url,
        score: h.score,
        total: h.total,
        anchor: h.anchor,
        titleHit: h.titleHit,
      })),
    };
  }
  return out;
}

// CLI：node parity.mjs > /tmp/readlayer.json
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  console.log(JSON.stringify(readLayerHits(), null, 1));
}
