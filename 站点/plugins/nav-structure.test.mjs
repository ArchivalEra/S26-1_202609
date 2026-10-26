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

test('T5b-③ 组标题链接在应有处出现、在重复 path 组处不出现（纯标题 + 整行点击）', () => {
  // 票 B（2026-10-22 回归 530427c 始冀形态）：有索引页的组，标题本身是
  // drawer-nav-link（带 data-path）；无索引页的组（重复 path / 无 path）是
  // 纯标题 + nav-header-clickable。nav-index-link 小图标已全站删除。

  // 应有：作业索引页里，「工程数学」组（indexHref 非空）标题是带 data-path 的链接
  const withIcon = needDist('课程/工程数学/作业/index.html');
  assert.ok(!withIcon.includes('nav-index-link'), 'nav-index-link 应已全站清零');
  const gongcheng = withIcon.match(
    /<li class="drawer-nav-group [^"]*" data-node-id="课程\/工程数学\/index\.html">\s*<div class="nav-group-header ">\s*<a href="[^"]*课程\/工程数学\/index\.html" data-path="课程\/工程数学\/index\.html" class="drawer-nav-link"><span>工程数学<\/span><\/a>/);
  assert.ok(gongcheng, '工程数学组标题应是 drawer-nav-link 链接（header 无 nav-header-clickable）');

  // 不应有：电机学第01章（path == 子项 path）——纯标题 span + nav-header-clickable
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
  // 产物侧：该页侧栏里「第01章 概述」组是纯标题（无 <a>）且 header 可整行点击折叠
  const motorHtml = needDist('课程/电机学/教材解析/第01章-概述/1.1-电机的分类.html');
  const ch1 = motorHtml.match(
    /<li class="drawer-nav-group [^"]*" data-node-id="[^"]*">\s*<div class="nav-group-header nav-header-clickable">\s*<span class="drawer-section-title-text">第01章 概述<\/span>/);
  assert.ok(ch1, '电机学第01章组应是纯标题 + nav-header-clickable（标题不是链接）');
  // 断言对象是组 header 匹配片段本身（ch1[0] 到 </span> 为止无 <a>）——
  // 不是全文档：1.1 是叶子节点，它自己的链接当然带这个 data-path（票 B 之前就有）。
  assert.ok(!/<a[\s>]/.test(ch1[0]), '重复 path 组标题区不得渲染 <a>（纯标题）');
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

// ── 侧栏 active 的「应用层」契约（2026-10-26）────────────────────
//
// 背景（站长手机截图实测）：父组「课堂笔记」高亮时，它下面**所有子项跟着蓝底**。
// 根因不是判定函数（isActive 是精确相等、collectActive 有 8 条测试护着），
// 而是把判定结果落到 DOM/样式的**三处写法不一致**：
//   ① CSS 用**后代**选择器 `.drawer-nav-group.active .drawer-nav-link` ——
//      子项本身也是 .drawer-nav-link 且在组内后代树里 ⇒ 整组上背景；
//   ② build.mjs 的组节点分支漏了 active 类 ⇒ 首屏进目录页时先无高亮、再闪出来。
// 下面三条把这两个应用层前提钉住。判定函数本身不在此重复测（上面已有）。
test('CSS：组节点 active 只命中标题那一层，不许用后代选择器波及子项', () => {
  const raw = readFileSync(path.join(HERE, '../assets/theme/shirone-reader.css'), 'utf8');
  // 剥掉注释再判——注释里会引用旧写法作说明（第一次写这条测试时就被自己的注释误伤了）
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(css.includes('.drawer-nav-group.active > .nav-group-header > .drawer-nav-link'),
    '组节点 active 的高亮规则必须用直系子选择器（> .nav-group-header >）限定到标题层');
  assert.ok(!/\.drawer-nav-group\.active\s+\.drawer-nav-link/.test(css),
    '不许再有后代选择器（会波及该组全部子项——2026-10-26 手机截图的蓝底 bug 就是这个）');
});

test('构建期：组节点也输出 active 类（与运行时 collectActive 对齐，消首帧闪烁）', () => {
  const src = readFileSync(path.join(HERE, '../build.mjs'), 'utf8');
  // 组节点模板串里必须出现 nodeActive
  const groupTpl = src.slice(src.indexOf("out += `<li class=\"drawer-nav-group"), src.indexOf("out += `<li class=\"drawer-nav-group") + 300);
  assert.ok(groupTpl.includes('nodeActive'), '组节点 <li> 的 class 里必须拼上 active（nodeActive）');
  assert.ok(groupTpl.includes('nodeExpanded'), 'expanded 照旧保留');
});

test('DOM 层级：组标题链接确实在 .nav-group-header 下（上面那两条的前提）', () => {
  const html = needDist('课程/形势与政策/课堂笔记/index.html');
  // 组节点结构：li.drawer-nav-group > div.nav-group-header > a.drawer-nav-link
  assert.ok(/<li class="drawer-nav-group[^"]*"[^>]*>\s*<div class="nav-group-header[^"]*">\s*<a[^>]*class="drawer-nav-link"/.test(html),
    '组标题链接必须是 .drawer-nav-group > .nav-group-header > a.drawer-nav-link 这一层——'
    + '若结构变了，直系选择器就会失配（静默失去高亮，不报错）');
});
