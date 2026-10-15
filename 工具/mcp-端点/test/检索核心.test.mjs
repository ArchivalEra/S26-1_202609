/**
 * SearchCorpus 的契约与 parity 测试（`node --test`，零依赖）。
 *
 * 两类断言：
 *   ① **parity**：读层检索 vs 浏览器端快照（`parity-browser.snapshot.json`）逐项一致。
 *      快照由 in-app 浏览器对真实页面抓取（见 parity-assert.mjs 的用法注释）。
 *      这是「检索只有一份实现」的**可重复**证明——只要有人改了排序/折叠/打分，
 *      这条测试立刻红。
 *   ② **确定性 / 边界**：同输入同输出；空查询不抛；未知词零命中。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLayerHits, PARITY_QUERIES } from './parity.mjs';
import { compare } from './parity-assert.mjs';
import { createDistCorpus, computeSourceHash } from '../lib/corpus-dist.mjs';
import { collectHits } from '../lib/检索核心.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = path.join(HERE, 'parity-browser.snapshot.json');
const DIST = path.resolve(HERE, '../../../站点/dist');

test('parity：读层检索与浏览器端快照逐项一致（前 12 条 + 总命中数）', () => {
  assert.ok(fs.existsSync(SNAPSHOT), '缺少 parity 快照');
  const browser = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf-8'));
  const readLayer = readLayerHits(Object.keys(browser));
  const problems = compare(readLayer, browser);
  assert.deepEqual(problems, [], 'parity 不一致：\n' + problems.join('\n'));
});

test('parity 快照覆盖 17 条查询（含空结果与单字）', () => {
  const browser = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf-8'));
  assert.equal(Object.keys(browser).length, 17);
  assert.ok(Object.prototype.hasOwnProperty.call(browser, '无此词汇xyz'), '应有空结果用例');
  assert.ok(Object.prototype.hasOwnProperty.call(browser, '的'), '应有单字用例');
});

test('确定性：同一查询两次结果逐字节相同', () => {
  const a = readLayerHits(['变压器', '卡诺图', '的']);
  const b = readLayerHits(['变压器', '卡诺图', '的']);
  assert.deepEqual(a, b);
});

test('空查询不抛：返回空命中', () => {
  const corpus = createDistCorpus({ distDir: DIST });
  const data = corpus.manifest();
  const r = collectHits(data, (n) => corpus.bucket(n), '   ');
  assert.equal(r.query, '');
  assert.deepEqual(r.hits, []);
});

test('未知词零命中', () => {
  const corpus = createDistCorpus({ distDir: DIST });
  const data = corpus.manifest();
  const r = collectHits(data, (n) => corpus.bucket(n), '无此词汇xyz');
  assert.equal(r.hits.length, 0);
});

test('manifest 带 sourceHash；staleness 可判', () => {
  const corpus = createDistCorpus({ distDir: DIST });
  const m = corpus.manifest();
  assert.ok(typeof m.sourceHash === 'string' && m.sourceHash.length === 16, 'index.json 应带 16 位 sourceHash');
  const s = corpus.staleness();
  assert.equal(s.stale, false, '刚构建完不该 stale');
  assert.equal(s.builtHash, m.sourceHash);
});

test('computeSourceHash 与构建期算法一致（对同一份源得到同一值）', async () => {
  const { TARGET_FILES } = await import('../../../站点/页面清单.mjs');
  const ROOT = path.resolve(HERE, '../../..');
  const corpus = createDistCorpus({ distDir: DIST, root: ROOT, targetFiles: TARGET_FILES });
  const s = corpus.staleness();
  assert.equal(s.currentHash, s.builtHash, '重算的源 hash 应与产物内一致（构建后未改源）');
});

test('产物缺失时报 index_not_built（不自行构建）', () => {
  const corpus = createDistCorpus({ distDir: '/nonexistent-dist-xyz' });
  assert.throws(() => corpus.manifest(), (e) => e.code === 'index_not_built');
});
