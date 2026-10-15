/**
 * parity 断言：读层检索 **vs** 浏览器端搜索面板，逐项比对。
 *
 * 判据（设计文档第 3 步，硬闸）：
 *   对同一批查询，读层的「前 12 条命中 url 序列」与「总命中数」必须与浏览器端**逐项相同**。
 *   浏览器端取前 12 条（`site-search.mjs` 的 `slice(0, 12)`），`totalPages` 是总命中数。
 *
 * 用法：
 *   node test/parity-assert.mjs <browser.json>      # browser.json 由浏览器侧抓取（见 parity-browser.mjs）
 *   不带参数时只跑读层侧自检（确定性 + 已知锚点）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLayerHits, PARITY_QUERIES } from './parity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 从 url 里取「文件名 + 锚点」作为稳定标识（浏览器端 href 是站点根相对、已编码）。 */
function keyOf(url) {
  const [p, hash] = String(url).split('#');
  const name = decodeURIComponent(p.split('/').pop() || '');
  return hash ? `${name}#${decodeURIComponent(hash)}` : name;
}

export function compare(readLayer, browser) {
  const problems = [];
  for (const q of Object.keys(browser)) {
    const a = readLayer[q];
    const b = browser[q];
    if (!a) { problems.push(`${q}: 读层缺该查询`); continue; }
    // 总命中数
    if (a.total !== b.total) problems.push(`${q}: 总命中数 读层=${a.total} 浏览器=${b.total}`);
    // 前 12 条逐项
    const an = a.hits.slice(0, 12).map((h) => keyOf(h.url) + (h.anchor ? '#' + decodeURIComponent(h.anchor) : ''));
    const bn = (b.hits || []).map(keyOf);
    const n = Math.max(an.length, bn.length);
    for (let i = 0; i < n; i++) {
      if (an[i] !== bn[i]) problems.push(`${q}: 第 ${i + 1} 条 读层=${an[i] || '(缺)'} 浏览器=${bn[i] || '(缺)'}`);
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const readLayer = readLayerHits();
  const arg = process.argv[2];
  if (!arg) {
    // 无浏览器数据：只做读层自检
    console.log(`读层自检：${PARITY_QUERIES.length} 条查询`);
    for (const q of PARITY_QUERIES) console.log(`  ${q}: ${readLayer[q].total} 页`);
    process.exit(0);
  }
  const browser = JSON.parse(fs.readFileSync(arg, 'utf-8'));
  const problems = compare(readLayer, browser);
  if (problems.length) {
    console.log(`✗ parity 不一致 ${problems.length} 处：`);
    for (const p of problems.slice(0, 30)) console.log('  ' + p);
    process.exit(1);
  }
  console.log(`✓ parity 通过：${Object.keys(browser).length} 条查询，前 12 条与总命中数逐项一致`);
}
