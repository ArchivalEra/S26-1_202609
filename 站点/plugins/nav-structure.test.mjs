// nav-structure.test.mjs —— 侧栏形状模块的测试（阶段一 T5 + T5b）
//
// 两层：
//   ① 纯函数边界（isActive / isExpanded / indexHrefOf / buildNavModel）
//   ② **产物级**（T5b）：读 dist/ 真实文件，钉住「构建期埋点 → 运行时消费」这条装配缝。
//
// 为什么需要第 ② 层（2026-10-21 审计结论）：302 个站点测试里只有 spa-router.test.mjs
// 读过真实产物，其余全在函数内部打转。而这一轮出的三个 bug（tools 从未送达 /
// EXECUTE_TOOL 重复声明 / pageToolsPrompt 从未被调用）**全部发生在装配缝隙上**——
// 单测全绿、功能全坏。所以这里必须站到产物边界上。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  htmlPathOf, isActive, isExpanded, collectActive, indexHrefOf, buildNavModel,
} from './nav-structure.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');

// ── 小夹具：一棵含四种特殊情况的树 ────────────────────────
//   · 普通叶子
//   · 有 index.md 的组（应出图标）
//   · path 与子项重复的组（不应出图标 —— 电机学第01章形态）
//   · 无 path 的组（不应出图标 —— 工程数学第01章形态）
const TREE = [
  { label: '首页', path: 'README.md' },
  {
    label: '课程', path: '课程/index.md',
    children: [
      {
        label: '作业', path: '课程/作业/index.md',
        children: [
          { label: '作业1', path: '课程/作业/2026-09-17-作业1.md' },
          { label: '作业2', path: '课程/作业/2026-10-08-作业2.md' },
        ],
      },
      {
        // 重复 path：组 path == 子项 path
        label: '第01章 概述', path: '课程/第01章/1.1-分类.md',
        children: [
          { label: '1.1 分类', path: '课程/第01章/1.1-分类.md' },
          { label: '1.2 磁路', path: '课程/第01章/1.2-磁路.md' },
        ],
      },
      {
        // 无 path 的组
        label: '第02章 矩阵',
        children: [{ label: '2.1 概念', path: '课程/第02章/2.1-概念.md' }],
      },
    ],
  },
];

const findByLabel = (nodes, label) => {
  for (const n of nodes) {
    if (n.label === label) return n;
    if (n.children) { const hit = findByLabel(n.children, label); if (hit) return hit; }
  }
  return null;
};

// ══════════ ① 纯函数 ══════════

test('htmlPathOf：README 落成 index.html，其余换后缀，非法输入 null', () => {
  assert.equal(htmlPathOf('README.md'), 'index.html');
  assert.equal(htmlPathOf('课程/作业/index.md'), '课程/作业/index.html');
  assert.equal(htmlPathOf(''), null);
  assert.equal(htmlPathOf(null), null);
});

test('buildNavModel：归一化字段齐全，id 稳定', () => {
  const { nodes, json } = buildNavModel(TREE, '课程/作业/index.md');
  const leaf = findByLabel(nodes, '作业1');
  assert.equal(leaf.path, '课程/作业/2026-09-17-作业1.md');
  assert.equal(leaf.href, '课程/作业/2026-09-17-作业1.html');
  assert.equal(leaf.depth, 2);
  assert.equal(leaf.children, null);
  assert.equal(json.v, 1);
  assert.equal(json.current, '课程/作业/index.html');
});

test('无 path 的组也要有 id（用父键+label 合成，且不与真实 html 路径相撞）', () => {
  const { nodes } = buildNavModel(TREE, 'README.md');
  const noPath = findByLabel(nodes, '第02章 矩阵');
  assert.ok(noPath.id, '无 path 组必须有 id');
  assert.match(noPath.id, /#/, '合成 id 应带 # 前缀（不可能与真实路径相同）');
  assert.equal(noPath.path, null);
  assert.equal(noPath.href, null);
});

test('isActive：只认自带键的节点；无 path 组永不 active', () => {
  const { nodes } = buildNavModel(TREE, '课程/作业/index.md');
  const group = findByLabel(nodes, '作业');
  const noPath = findByLabel(nodes, '第02章 矩阵');

  assert.equal(isActive(group, '课程/作业/index.html', true), true);
  assert.equal(isActive(group, '课程/作业/index.html', false), false, 'md 空间用 path 比');
  assert.equal(isActive(noPath, noPath.id, true), false, '无 path 组不该 active');
});

test('isExpanded：自身 active 或任一后代 active', () => {
  const { nodes } = buildNavModel(TREE, '课程/作业/2026-10-08-作业2.md');
  const root = findByLabel(nodes, '课程');
  const group = findByLabel(nodes, '作业');
  const other = findByLabel(nodes, '第01章 概述');

  assert.equal(isExpanded(root, '课程/作业/2026-10-08-作业2.html', true), true, '祖先展开');
  assert.equal(isExpanded(group, '课程/作业/2026-10-08-作业2.html', true), true, '父展开');
  assert.equal(isExpanded(other, '课程/作业/2026-10-08-作业2.html', true), false, '无关分支不展开');
});

test('indexHrefOf：仅「组 + index.md + 不与子项重复」才出图标', () => {
  const { nodes } = buildNavModel(TREE, 'README.md');

  assert.equal(indexHrefOf(findByLabel(nodes, '作业')), '课程/作业/index.html', '正常组出图标');
  assert.equal(indexHrefOf(findByLabel(nodes, '第01章 概述')), null, '重复 path 组不出（防父子双亮）');
  assert.equal(indexHrefOf(findByLabel(nodes, '第02章 矩阵')), null, '无 path 组不出');
  assert.equal(indexHrefOf(findByLabel(nodes, '作业1')), null, '叶子不出');
});

test('collectActive：activeIds/expandedIds 与 isActive/isExpanded 同源', () => {
  const { nodes, json } = buildNavModel(TREE, '课程/作业/index.md');
  const group = findByLabel(nodes, '作业');
  assert.deepEqual(json.activeIds, [group.id]);
  assert.ok(json.expandedIds.includes(findByLabel(nodes, '课程').id), '祖先在 expanded');
  assert.ok(json.expandedIds.includes(group.id), '自身在 expanded');
});

// ══════════ ② 产物级（T5b）══════════
// 前置：dist 必须已构建。缺产物时给出明确失败信息，而不是静默跳过。

const needDist = (rel) => {
  const p = path.join(DIST, rel);
  assert.ok(existsSync(p), `产物缺失：${rel}——先跑 cd 站点 && node build.mjs`);
  return readFileSync(p, 'utf8');
};

const navJsonOf = (html) => {
  const m = html.match(/<script[^>]*id="nav-structure-json"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(m, '页面里没有 nav-structure-json 脚本块');
  return JSON.parse(m[1]);
};

test('T5b-① 抽样页面都埋了可解析的 nav JSON，且 nodes 非空', () => {
  const pages = [
    'index.html',                                        // 顶层
    '课程/工程数学/作业/index.html',                        // 中层索引
    '课程/工程数学/作业/2026-10-08-作业2.html',              // 深层叶子
  ];
  for (const rel of pages) {
    const json = navJsonOf(needDist(rel));
    assert.equal(json.v, 1, `${rel}: schema 版本`);
    assert.ok(Array.isArray(json.nodes) && json.nodes.length > 0, `${rel}: nodes 非空`);
    assert.ok(Array.isArray(json.activeIds), `${rel}: activeIds 是数组`);
  }
});

test('T5b-② JSON 的 current 与该页 data-site-path 一致（防「埋了但埋错」）', () => {
  const rel = '课程/工程数学/作业/2026-10-08-作业2.html';
  const html = needDist(rel);
  const json = navJsonOf(html);
  const m = html.match(/<body[^>]*data-site-path="([^"]+)"/);
  assert.ok(m, '页面缺 data-site-path');
  assert.equal(json.current, m[1], 'JSON.current 必须等于本页 data-site-path');
});

test('T5b-③ 索引图标在应有处出现、在重复 path 组处不出现', () => {
  // 应有：作业索引页里，「工程数学」组（path 指向 index.md 且无重复）出图标
  const withIcon = needDist('课程/工程数学/作业/index.html');
  assert.ok(withIcon.includes('nav-index-link'), '应有 nav-index-link');

  // 不应有：电机学第01章（path == 子项 path）在 JSON 里 indexHref 必须是 null
  const motor = navJsonOf(needDist('课程/电机学/教材解析/第01章-概述/1.1-电机的分类.html'));
  const walk = (ns, out = []) => {
    for (const n of ns) {
      if (n.children && (n.label || '').includes('第01章')) out.push(n);
      if (n.children) walk(n.children, out);
    }
    return out;
  };
  const dupGroups = walk(motor.nodes).filter((n) => n.label.includes('概述'));
  assert.ok(dupGroups.length > 0, '应能找到电机学第01章组');
  for (const g of dupGroups) {
    assert.equal(g.indexHref, null, `${g.label}: 重复 path 组不得有 indexHref`);
  }
});

test('T5b-④ drawer-sync 产物靠 nav JSON 判定，不再有 data-path 全等收集循环', () => {
  const js = needDist('assets/plugins/drawer-sync.js');

  // ① 不再有旧的全等收集循环（这是被替换掉的那段）
  assert.ok(!js.includes('a.drawer-nav-link[href]'),
    '不应再有旧的 a.drawer-nav-link[href] 全等收集');

  // ② 改为依赖 nav-structure 提供的运行时接口（字面量 id 在 nav-structure.js 里，
  //    drawer-sync 通过 __navStructure.readNavJson 间接读——所以查接口，不查字面量）
  assert.ok(js.includes('__navStructure'), '应依赖 window.__navStructure');
  assert.ok(js.includes('readNavJson'), '应调用 readNavJson 读侧栏形状');
  assert.ok(js.includes('collectActive'), '应用共享判定 collectActive（不自己实现一套）');

  // ③ 装配缝：提供者必须真的存在，且页面里先于 drawer-sync 加载
  const provider = needDist('assets/plugins/nav-structure.js');
  assert.ok(provider.includes('window.__navStructure ='),
    'nav-structure.js 必须定义 __navStructure');
  assert.ok(provider.includes('nav-structure-json'),
    '提供者里必须有 JSON 脚本 id');

  const html = needDist('index.html');
  const iProvider = html.indexOf('nav-structure.js');
  const iConsumer = html.indexOf('drawer-sync.js');
  assert.ok(iProvider > 0, '页面应加载 nav-structure.js');
  assert.ok(iConsumer > 0, '页面应加载 drawer-sync.js');
  assert.ok(iProvider < iConsumer,
    '加载顺序：nav-structure.js 必须在 drawer-sync.js 之前（否则运行时 undefined）');
});
