// table-responsive.test.mjs —— 响应式表格分级的构建期测试（零依赖，跑 dist 产物断言）。
// 运行：node --test plugins/table-responsive.test.mjs（在 站点/ 下，需先 build）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '../dist');

const readPage = (rel) => fs.readFileSync(path.join(DIST, rel), 'utf8');

test('三态类都存在于产物（compact/cards/matrix）', () => {
  // 全 dist 扫：任何一页包含三类之一即可（样本页必含）
  const page = readPage('课程总览/电子技术/作业/2026-10-10作业.html');
  assert.ok(page.includes('t-matrix'), '11 列真值表 → t-matrix');
  assert.ok(page.includes('t-compact'), '5 列真值表 → t-compact');
  assert.ok(page.includes('t-cards'), '句子型表 → t-cards');
});

test('renderer.table 注入 ARIA 与 data-label', () => {
  const page = readPage('课程总览/电子技术/作业/2026-10-10作业.html');
  assert.ok(/table-scroll-container t-\w+" role="region" aria-label="[^"]+" tabindex="0"/.test(page), 'ARIA 容器属性');
  assert.ok(page.includes('data-label="'), 'data-label 已注入');
});

test('旧的正则包裹已删（容器由 renderer 产出，不再双重包裹）', () => {
  const page = readPage('课程总览/电子技术/作业/2026-10-10作业.html');
  assert.ok(!page.includes('table-scroll-container"><table'), '无裸正则容器残留');
  assert.ok(!/<div class="table-scroll-container"><div class="table-scroll-container/.test(page), '无双重包裹');
});

test('matrix 表的 data-label 数 ≥ compact（宽表逐格标签多）', () => {
  const page = readPage('课程总览/电子技术/作业/2026-10-10作业.html');
  const n = (page.match(/data-label="/g) || []).length;
  assert.ok(n > 100, `data-label 总数 ${n} 应过百（10 张表 × 多行）`);
});

test('CSS 三态样式块存在于主题（local 滚动阴影/separate sticky/容器查询 cards）', () => {
  const css = fs.readFileSync(path.join(HERE, '../assets/theme/shirone-reader.css'), 'utf8');
  assert.ok(css.includes('background-attachment: local'), 'Lea Verou 滚动阴影');
  assert.ok(css.includes('.t-matrix table') && css.includes('border-collapse: separate'), 'matrix separate');
  assert.ok(css.includes('container-type: inline-size') && css.includes('@container'), 'cards 容器查询');
  assert.ok(css.includes('overflow-wrap: anywhere'), 'anywhere 降 min-content');
  assert.ok(css.includes('margin-inline: -0.85rem'), '窄屏出血');
});
