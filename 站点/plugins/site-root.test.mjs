// site-root.test.mjs —— 部署根探测的纯逻辑测试（2026-10-20 镜像入口修复）。
//
// 背景：isui.ren 把站点挂在 /repo/S26-1_202609/，但托管层让无前缀路径也
// 返回 200（双入口同一份文件）。用户从镜像入口进入时，相对链接退到域名根，
// 命中站长另一个站。修复 = 构建期埋正式根 + 运行时探测实际根 + 不一致则重写。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
