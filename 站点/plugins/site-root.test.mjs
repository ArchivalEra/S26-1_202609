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
  assert.equal(detect('课程总览/电机学/index.html', encodeURI('/repo/S26-1_202609/课程总览/电机学/index.html')), '/repo/S26-1_202609/');
});

test('探测：镜像入口（无前缀）→ 根为 /（触发规范化）', () => {
  assert.equal(detect('课程总览/电机学/index.html', encodeURI('/课程总览/电机学/index.html')), '/');
});

test('探测：首页自身', () => {
  assert.equal(detect('index.html', encodeURI('/repo/S26-1_202609/index.html')), '/repo/S26-1_202609/');
  assert.equal(detect('index.html', '/index.html'), '/');
});

test('探测：最深层页（教材解析四级）', () => {
  const sp = '课程总览/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.1-二阶与三阶行列式.html';
  const pn = '/repo/S26-1_202609/' + sp;
  assert.equal(detect(sp, encodeURI(pn)), '/repo/S26-1_202609/');
});

test('探测：中文路径百分号编码形态（浏览器保证）', () => {
  // location.pathname 一定是编码形态；decodeURIComponent 在函数内部做
  assert.equal(detect('课程总览/电机学/index.html', '/repo/S26-1_202609/%E8%AF%BE%E7%A8%8B%E6%80%BB%E8%A7%88/%E7%94%B5%E6%9C%BA%E5%AD%A6/index.html'), '/repo/S26-1_202609/');
});

test('探测：目录部分多次出现时取最后一次对齐（避免错配到更早位置）', () => {
  // /repo/课程总览/课程总览/index.html 的 data-site-path 是 课程总览/index.html
  // 最后一次对齐得到 /repo/课程总览/ ——正确（该文件确实在那个目录下）
  assert.equal(detect('课程总览/index.html', encodeURI('/repo/S26-1_202609/课程总览/课程总览/index.html')), '/repo/S26-1_202609/课程总览/');
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

// ══════════ rewriteLinks 双前缀回归（票 A 遗留修复，2026-10-22）══════════
// 票 A 给面包屑/分页卡埋了 data-path 后，rewriteLinks 第 1 分支先把它们的 href
// 改写成「root + 仓库相对」；第 2 分支的旧选择器（.m3-breadcrumb a、.paging-card）
// 会再命中同一批元素，镜像入口（actual≠canonical）场景下「剥掉实际根再拼正式根」
// 对已拼好的前缀二次操作，产出双前缀 /repo/S26-1_202609/repo/S26-1_202609/课程总览/index.html。
// 修法 = 第 2 分支选择器 :not([data-path]) 排除。这里用函数级模拟钉住分工。

test('rewriteLinks：带 data-path 的元素只走第 1 分支，不被第 2 分支二次拼前缀', () => {
  const rw = src.slice(src.indexOf('function rewriteLinks'), src.indexOf('// 全局暴露'));
  // 用 new Function 在假 DOM 上真跑 rewriteLinks（与上方 detect 同款手法）。
  // 假 DOM 的选择器语义按「rewriteLinks 实际用的两个查询」建模：
  //   'a[data-path]' → 有 data-path 的元素；CSS 类选择器 → 按类名匹配，
  //   且 :not([data-path]) 把有 data-path 的元素排除（这正是被测的分工规则——
  //   真浏览器里由选择器引擎保证，这里由 fakeDoc 实现同一语义，钉住契约）。
  const fn = new Function('document', 'siteRoot', 'location', rw + '\n return rewriteLinks;');
  const location = { href: 'https://x.test/课程总览/index.html', origin: 'https://x.test' };
  const run = (els, root, actual) => fn(fakeDoc(els), () => actual, location)(root);

  // 镜像入口场景：actual='/' ≠ canonical='/repo/S26-1_202609/'
  // · 面包屑 <a>（带 data-path，第 1 分支已拼好 href="/repo/S26-1_202609/课程总览/index.html"）
  // · 品牌 <a>（无 data-path，href 是相对值 '../../index.html'）
  const crumb = {
    sel: 'm3-breadcrumb a',
    attrs: { 'data-path': '课程总览/index.html' },
    href: '/repo/S26-1_202609/课程总览/index.html', // 第 1 分支刚改写过的值
  };
  const brand = {
    sel: 'sidebar-brand',
    attrs: {},
    href: '../../index.html',
  };
  run([crumb, brand], '/repo/S26-1_202609/', '/');

  // 带 data-path 的元素：href 必须仍是「root + data-path」单前缀（第 2 分支没碰它）
  assert.equal(crumb.href, '/repo/S26-1_202609/课程总览/index.html',
    `面包屑 href 不得被二次拼接（实际值：${crumb.href}）`);
  assert.ok(!crumb.href.includes('/repo/S26-1_202609/repo'),
    '双前缀回归：/repo/S26-1_202609/repo/… 不得出现');
  // 无 data-path 的元素照旧被第 2 分支规范化（剥实际根 → 拼正式根）
  assert.equal(brand.href, '/repo/S26-1_202609/index.html',
    `品牌 href 应被规范化到正式根（实际值：${brand.href}）`);
});

/** 极简假 DOM：只实现 rewriteLinks 用到的接口。
 *  选择器语义按被测的两个查询建模：'a[data-path]' 命中有 data-path 的元素；
 *  类选择器按类名命中、':not([data-path])' 排除有 data-path 的——与真浏览器
 *  选择器引擎对这两个查询的行为一致，契约钉在这里。 */
function fakeDoc(els) {
  const matches = (e, part) => {
    part = part.trim();
    if (part === 'a[data-path]') return Boolean(e.attrs['data-path']);
    const notDp = /\[data-path\]\)$/.test(part) && /:not\(/.test(part);
    const cls = part.replace(/^\.|:not\(\[data-path\]\)$/g, '');
    if (!e.sel.includes(cls)) return false;
    if (notDp && e.attrs['data-path']) return false;
    return true;
  };
  return {
    querySelectorAll: (sel) => els.filter((e) => sel.split(',').some((p) => matches(e, p))).map(fakeEl),
  };
}
const fakeEl = (e) => ({
  getAttribute: (k) => (k === 'data-path' ? e.attrs['data-path'] : (k === 'href' ? e.href : null)),
  setAttribute: (k, v) => { if (k === 'href') e.href = v; },
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

test('票 A：深层页面包屑的目录 crumb 用**目录形式** data-path，首页走根', () => {
  const rel = '课程总览/工程数学/教材解析/符号入门.html';
  const html = needDist(rel);
  for (const navClass of ['top-bar-breadcrumbs', 'm3-breadcrumb']) {
    const dps = crumbDataPaths(html, navClass);
    // 2026-10-29 定案：面包屑写**事实上指向的网址**。首页 = `/`（README 即站点根），
    // 不带 data-path、由 site-root 的无 data-path 分支处理；其余三层是目录形式。
    // 所以带 data-path 的链接是 3 条（课程总览 / 工程数学 / 教材解析），不是 4 条。
    assert.equal(dps.length, 3, `${navClass}: 3 条目录 crumb 带 data-path`);
    for (const dp of dps) {
      assert.ok(dp.length > 0, `${navClass}: data-path 非空`);
      assert.ok(!dp.startsWith('../'), `${navClass}: data-path 不得以 ../ 开头（${dp}）`);
      assert.ok(!dp.startsWith('/'), `${navClass}: data-path 不得以 / 开头（${dp}）`);
      assert.ok(dp.endsWith('/'), `${navClass}: 目录形式必须以 / 结尾（${dp}）`);
    }
  }
  // 具体锚点：目录形式，不是 index.html 文件名（断言限定在面包屑 nav 内——
  // 侧栏链接是另一套结构，不在本条判据范围内）
  for (const navClass of ['top-bar-breadcrumbs', 'm3-breadcrumb']) {
    const m = html.match(new RegExp(`<nav class="${navClass}"[^>]*>([\\s\\S]*?)</nav>`));
    assert.ok(m, `页面缺 .${navClass}`);
    assert.ok(m[1].includes('data-path="课程总览/"'), `${navClass}: 课程总览 crumb 用目录形式`);
    assert.ok(!m[1].includes('index.html'),
      `${navClass}: 面包屑不得出现 index.html（读者看到的网址最后一段是层名，不是 index）`);
  }
});

test('票 A：浅层页两份面包屑的 <a> 全带 data-path', () => {
  const rel = '课程总览/工程数学/index.html';
  const html = needDist(rel);
  for (const navClass of ['top-bar-breadcrumbs', 'm3-breadcrumb']) {
    const dps = crumbDataPaths(html, navClass);
    // 本页是 `课程总览/工程数学/index.html`，层级「首页 / 课程总览 / 工程数学」；
    // 末项是当前页（<span>）。首页走 `/` 不带 data-path，所以只有 1 条目录 crumb 带它。
    assert.equal(dps.length, 1, `${navClass}: 只有「课程总览」这一层带 data-path`);
    for (const dp of dps) {
      assert.ok(dp.length > 0 && !dp.startsWith('../') && !dp.startsWith('/'),
        `${navClass}: data-path 形态（${dp}）`);
    }
  }
});

test('票 A：分页卡带 data-path（在场时），值为仓库相对路径', () => {
  // 教材解析顺序页有 prev/next；0.0-符号入门是首篇只有 next
  const html = needDist('课程总览/工程数学/教材解析/符号入门.html');
  const cards = [...html.matchAll(/<a class="paging-card[^>]*data-path="([^"]+)"/g)].map((x) => x[1]);
  assert.ok(cards.length >= 1, '该页应至少有一张分页卡');
  for (const dp of cards) {
    assert.ok(dp.length > 0 && !dp.startsWith('../') && !dp.startsWith('/'),
      `paging-card data-path 形态（${dp}）`);
  }
  // 课堂笔记顺序页 prev/next 双卡
  const html2 = needDist('课程总览/工程数学/课堂笔记/09-17-课堂听课整理.html');
  const cards2 = [...html2.matchAll(/<a class="paging-card[^>]*data-path="([^"]+)"/g)].map((x) => x[1]);
  assert.equal(cards2.length, 2, '笔记中间页应有 prev/next 两张卡都带 data-path');
});

test('票 A：href:# 的章节 crumb 与当前页 crumb 不渲染成链接、不带 data-path', () => {
  // 第01章-行列式 目录下的页：章节 crumb（第01章 行列式）在构建里是 href:'#'，
  // 渲染成 current-crumb 前的 span——不该出现 data-path="#" 这类脏值
  const html = needDist('课程总览/工程数学/教材解析/第一部分-线性代数/第1章-行列式/1.1-二阶与三阶行列式.html');
  assert.ok(!html.includes('data-path="#"'), 'href:# 的 crumb 不得带 data-path');
  const m = html.match(/<nav class="m3-breadcrumb"[^>]*>([\s\S]*?)<\/nav>/);
  assert.ok(m, '页面缺 .m3-breadcrumb');
  // 判据收敛为：面包屑 nav 里**唯一的**无 data-path 链接是「首页」（href 指向站点根），
  // 其余 <a> 都必须带 data-path。首页刻意不带——它的事实网址就是 `/`，给 data-path
  // 反而要多绕一层反推。
  const noDp = [...m[1].matchAll(/<a ((?![^>]*data-path=)[^>]*)>([^<]*)</g)];
  assert.equal(noDp.length, 1, '只允许「首页」这一条无 data-path 的链接');
  assert.match(noDp[0][2], /首页/, '无 data-path 的那条必须是首页');
});
