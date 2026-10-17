// spa-router.test.mjs —— SPA 路由器与 SW 的测试（node:test 零依赖）。
// 运行：node --test plugins/spa-router.test.mjs（在 站点/ 下）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRoutableHref } from './spa-router.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'http://127.0.0.1:8899';

test('isRoutableHref：站内 html 链接可路由', () => {
  assert.equal(isRoutableHref('/课程/电子技术/index.html', ORIGIN), true);
  assert.equal(isRoutableHref('./other.html', ORIGIN), true);
  assert.equal(isRoutableHref('https://example.com/x.html', 'http://other'), false, '跨域不可路由');
});

test('isRoutableHref：锚点/协议/资源文件直通（不接管）', () => {
  assert.equal(isRoutableHref('#sec', ORIGIN), false, '纯锚点');
  assert.equal(isRoutableHref('mailto:a@b.c', ORIGIN), false);
  assert.equal(isRoutableHref('javascript:void(0)', ORIGIN), false);
  for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'jxl', 'pdf', 'doc', 'txt', 'mp3', 'mp4']) {
    assert.equal(isRoutableHref(`/a/b.${ext}`, ORIGIN), false, `${ext} 应直通`);
  }
});

test('isRoutableHref：空与缺省不可路由', () => {
  assert.equal(isRoutableHref('', ORIGIN), false);
  assert.equal(isRoutableHref(null, ORIGIN), false);
});

test('SPA_ROUTER_JS 源码形状：三个 reset 钩子调用与兜底都在', () => {
  const src = fs.readFileSync(path.join(HERE, 'spa-router.mjs'), 'utf8');
  assert.ok(src.includes('__glossaryReset'), '调 glossary reset');
  assert.ok(src.includes('__readerRescan'), '调 reader rescan');
  assert.ok(src.includes('__disclosureOpen'), '调 disclosure open');
  assert.ok(src.includes('replaceWith'), '正文替换用 replaceWith');
  assert.ok(src.includes('pushState') && src.includes('popstate'), '前进后退');
  assert.ok(src.includes('location.href = url'), '失败兜底整页跳转');
});

test('三个插件真的暴露了 reset 钩子（构建产物检查）', () => {
  const g = fs.readFileSync(path.join(HERE, '../dist/assets/plugins/math-glossary.js'), 'utf8');
  assert.ok(g.includes('__glossaryReset'), 'math-glossary 暴露 __glossaryReset');
  const d = fs.readFileSync(path.join(HERE, '../dist/assets/plugins/disclosure-anchor.js'), 'utf8');
  assert.ok(d.includes('__disclosureOpen'), 'disclosure-anchor 暴露 __disclosureOpen');
  const t = fs.readFileSync(path.join(HERE, '../dist/assets/theme/shirone-reader.js'), 'utf8');
  assert.ok(t.includes('__readerRescan'), 'shirone-reader 暴露 __readerRescan');
});

test('sw.js 形状：双策略 + 版本注入 + 无写死域名', () => {
  const sw = fs.readFileSync(path.join(HERE, '../dist/sw.js'), 'utf8');
  assert.ok(sw.includes('cache-first') || sw.includes('caches.match(req)'), '资产 cache-first');
  assert.ok(sw.includes('stale-while-revalidate') || (sw.includes('PAGE_CACHE') && sw.includes('refresh')), '页面 SWR');
  assert.ok(!sw.includes('github.io') && !sw.includes('isui.ren'), '不得写死域名（双部署）');
  assert.ok(/VERSION = 'v[0-9a-z]+'/.test(sw), '版本号已注入');
});

test('sw 预缓存清单来自实际产物', () => {
  const sw = fs.readFileSync(path.join(HERE, '../dist/sw.js'), 'utf8');
  const m = sw.match(/const SW_ASSETS = (\[[^\]]*\]);/);
  assert.ok(m, 'ASSETS 清单存在');
  const list = JSON.parse(m[1].replace(/"/g, '"'));
  assert.ok(list.length > 5, '清单非空');
  for (const rel of list) {
    assert.ok(fs.existsSync(path.join(HERE, '../dist', rel)), `预缓存文件存在: ${rel}`);
  }
});
