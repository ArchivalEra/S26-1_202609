// site-root.test.mjs —— 部署根探测的纯逻辑测试（2026-10-20 镜像入口修复）。
//
// 背景：isui.ren 把站点挂在 /repo/S26-1_202609/，但托管层让无前缀路径也
// 返回 200（双入口同一份文件）。用户从镜像入口进入时，相对链接退到域名根，
// 命中站长另一个站。修复 = 构建期埋正式根 + 运行时探测实际根 + 不一致则重写。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(new URL('./site-root.mjs', import.meta.url), 'utf8');
const fns = src.slice(src.indexOf('function detectSiteRoot'), src.indexOf('/** 惰性缓存'));
const detect = (sp, pathname) => new Function('document', 'location', 'decodeURIComponent',
  fns + '\n return detectSiteRoot();')(
  { body: { getAttribute: (k) => (k === 'data-site-path' ? sp : null) } },
  { pathname }, decodeURIComponent);

test('探测：带前缀入口 → 前缀即根', () => {
  assert.equal(detect('课程/电机学/index.html', encodeURI('/repo/S26-1_202609/课程/电机学/index.html')), '/repo/S26-1_202609/');
});

test('探测：镜像入口（无前缀）→ 根为 /（触发规范化）', () => {
  assert.equal(detect('课程/电机学/index.html', encodeURI('/课程/电机学/index.html')), '/');
});

test('探测：首页自身', () => {
  assert.equal(detect('index.html', encodeURI('/repo/S26-1_202609/index.html')), '/repo/S26-1_202609/');
  assert.equal(detect('index.html', '/index.html'), '/');
});

test('探测：最深层页（教材解析四级）', () => {
  const sp = '课程/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.1-二阶与三阶行列式.html';
  const pn = '/repo/S26-1_202609/' + sp;
  assert.equal(detect(sp, encodeURI(pn)), '/repo/S26-1_202609/');
});

test('探测：中文路径百分号编码形态（浏览器保证）', () => {
  // location.pathname 一定是编码形态；decodeURIComponent 在函数内部做
  assert.equal(detect('课程/电机学/index.html', '/repo/S26-1_202609/%E8%AF%BE%E7%A8%8B/%E7%94%B5%E6%9C%BA%E5%AD%A6/index.html'), '/repo/S26-1_202609/');
});

test('探测：目录部分多次出现时取最后一次对齐（避免错配到更早位置）', () => {
  // /repo/课程/课程/index.html 的 data-site-path 是 课程/index.html
  // 最后一次对齐得到 /repo/课程/ ——正确（该文件确实在那个目录下）
  assert.equal(detect('课程/index.html', encodeURI('/repo/S26-1_202609/课程/课程/index.html')), '/repo/S26-1_202609/课程/');
});

test('源码契约：fixSiteRoot 以正式根（data-canonical-root）为准重写', () => {
  // 不一致 → 规范到正式根（镜像入口的核心行为）
  assert.match(src, /data-canonical-root/, '要读构建期埋的正式根');
  assert.match(src, /actual === canonical/, '一致才跳过');
  assert.match(src, /rewriteLinks\(canonical\)/, '重写目标必须是正式根');
});

test('源码契约：重写只动构建期知道语义的三类元素', () => {
  const rw = src.slice(src.indexOf('function rewriteLinks'), src.indexOf('// 全局暴露'));
  assert.match(rw, /a\[data-path\]/, '侧栏 data-path 链接');
  assert.match(rw, /\.sidebar-brand/, '品牌');
  assert.match(rw, /m3-breadcrumb a/, '面包屑');
  // 不许批量改所有链接
  assert.doesNotMatch(rw, /querySelectorAll\('a'\)/);
});

// ══════════ 产物级（票 A：导航链接三处 data-path 化，2026-10-22）══════════
// 面包屑两份（顶栏 .top-bar-breadcrumbs / 正文 .m3-breadcrumb）与分页卡
// .paging-card 都在 .article-content 之外——SPA 换页（spa-router 只换正文块）
// 后它们仍是首屏页按本页深度烘焙的相对 href，深→浅方向剥过头即丢 SPA（spec
// 病根）。埋 data-path 后点击委托走「data-root + data-path」拼接，与侧栏同款。
// 前置约定与 nav-structure.test.mjs 一致：dist 必须已构建（构建由收尾四连跑
// 保证），缺产物给明确失败信息，不静默跳过。

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');

const needDist = (rel) => {
  const p = path.join(DIST, rel);
  assert.ok(existsSync(p), `产物缺失：${rel}——先跑 cd 站点 && node build.mjs`);
  return readFileSync(p, 'utf8');
};

// 从一段面包屑 HTML 里收全部 <a> 的 data-path（span 的 current-crumb 不算链接）
const crumbDataPaths = (html, navClass) => {
  const m = html.match(new RegExp(`<nav class="${navClass}"[^>]*>([\\s\\S]*?)</nav>`));
  assert.ok(m, `页面缺 .${navClass}`);
  return [...m[1].matchAll(/<a [^>]*data-path="([^"]+)"/g)].map((x) => x[1]);
};

test('票 A：深层页两份面包屑的 <a> 全带 data-path，值为仓库相对路径', () => {
  const rel = '课程/工程数学/教材解析/0.0-符号入门.html';
  const html = needDist(rel);
  for (const navClass of ['top-bar-breadcrumbs', 'm3-breadcrumb']) {
    const dps = crumbDataPaths(html, navClass);
    // 首页/课程总览/工程数学/教材解析 = 4 条真链接（当前页 crumb 是 span）
    assert.equal(dps.length, 4, `${navClass}: 4 条链接都该带 data-path`);
    for (const dp of dps) {
      assert.ok(dp.length > 0, `${navClass}: data-path 非空`);
      assert.ok(!dp.startsWith('../'), `${navClass}: data-path 不得以 ../ 开头（${dp}）`);
      assert.ok(!dp.startsWith('/'), `${navClass}: data-path 不得以 / 开头（${dp}）`);
    }
  }
  // 具体锚点：SPA 丢页的那条「课程总览」链接
  assert.ok(html.includes('data-path="课程/index.html"'), '课程总览 crumb 带裸路径 data-path');
});

test('票 A：浅层页两份面包屑的 <a> 全带 data-path', () => {
  const rel = '课程/工程数学/index.html';
  const html = needDist(rel);
  for (const navClass of ['top-bar-breadcrumbs', 'm3-breadcrumb']) {
    const dps = crumbDataPaths(html, navClass);
    assert.equal(dps.length, 3, `${navClass}: 3 条链接都该带 data-path`);
    for (const dp of dps) {
      assert.ok(dp.length > 0 && !dp.startsWith('../') && !dp.startsWith('/'),
        `${navClass}: data-path 形态（${dp}）`);
    }
  }
});

test('票 A：分页卡带 data-path（在场时），值为仓库相对路径', () => {
  // 教材解析顺序页有 prev/next；0.0-符号入门是首篇只有 next
  const html = needDist('课程/工程数学/教材解析/0.0-符号入门.html');
  const cards = [...html.matchAll(/<a class="paging-card[^>]*data-path="([^"]+)"/g)].map((x) => x[1]);
  assert.ok(cards.length >= 1, '该页应至少有一张分页卡');
  for (const dp of cards) {
    assert.ok(dp.length > 0 && !dp.startsWith('../') && !dp.startsWith('/'),
      `paging-card data-path 形态（${dp}）`);
  }
  // 课堂笔记顺序页 prev/next 双卡
  const html2 = needDist('课程/工程数学/课堂笔记/2026-09-17-determinants-transcript-notes.html');
  const cards2 = [...html2.matchAll(/<a class="paging-card[^>]*data-path="([^"]+)"/g)].map((x) => x[1]);
  assert.equal(cards2.length, 2, '笔记中间页应有 prev/next 两张卡都带 data-path');
});

test('票 A：href:# 的章节 crumb 与当前页 crumb 不渲染成链接、不带 data-path', () => {
  // 第01章-行列式 目录下的页：章节 crumb（第01章 行列式）在构建里是 href:'#'，
  // 渲染成 current-crumb 前的 span——不该出现 data-path="#" 这类脏值
  const html = needDist('课程/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.1-二阶与三阶行列式.html');
  assert.ok(!html.includes('data-path="#"'), 'href:# 的 crumb 不得带 data-path');
  const m = html.match(/<nav class="m3-breadcrumb"[^>]*>([\s\S]*?)<\/nav>/);
  assert.ok(m, '页面缺 .m3-breadcrumb');
  // 非最后一条也不是链接的（章节 crumb）在这个构建分支里其实并入 current-crumb 逻辑——
  // 判据收敛为：面包屑 nav 里所有 <a> 都带 data-path，无一例外
  const anchorsNoDp = [...m[1].matchAll(/<a (?![^>]*data-path=)[^>]*>/g)];
  assert.equal(anchorsNoDp.length, 0, '面包屑里的 <a> 要么带 data-path 要么根本不该是 <a>');
});
