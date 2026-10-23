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

// ⭐ SW 已根除（2026-10-23 用户定案：长任务要「永远新鲜的页面」——SW 的
// stale-while-revalidate 会先出旧缓存、下次才生效，模型连跳十几页会拿到上一版 HTML；
// 资产缓存由浏览器 HTTP 缓存 + CDN + 站点自带 ?v=<内容哈希> 接管）。旧的两个
// 形状测试随 sw.js 一起退役，换成根除后的守卫：
//   ① 产物里没有 sw.js、页面里没有注册行（防「复活」）
//   ② 一次性清理脚本在场（老用户旧 SW 的退役通道，跑一两周后连它一起删）

test('SW 根除：产物无 sw.js、页面无注册行（防复活）', () => {
  assert.ok(!fs.existsSync(path.join(HERE, '../dist/sw.js')), 'dist/sw.js 不得存在');
  const page = fs.readFileSync(path.join(HERE, '../dist/index.html'), 'utf8');
  assert.ok(!page.includes('serviceWorker.register'), '页面不得注册 SW');
  assert.ok(!/"sw\.js"/.test(page), '页面不得引用 sw.js');
});

test('SW 根除：一次性清理脚本在场且被页面引用（老用户退役通道）', () => {
  const kill = fs.readFileSync(path.join(HERE, '../dist/assets/plugins/sw-kill.js'), 'utf8');
  assert.ok(kill.includes('unregister'), '清理脚本必须反注册');
  assert.ok(kill.includes('caches.delete') || kill.includes('caches.keys'), '清理脚本必须清缓存');
  assert.ok(kill.includes('sw_killed'), '必须有去重标记（清完变 no-op）');
  const page = fs.readFileSync(path.join(HERE, '../dist/index.html'), 'utf8');
  assert.ok(page.includes('sw-kill.js'), '页面必须引用清理脚本');
});


test('① 旧缓存页防御：读不到侧栏形状时 active 不被清空（return undefined = 不动）', () => {
  const src = fs.readFileSync(path.join(HERE, 'drawer-sync.mjs'), 'utf8');
  // 阶段一（2026-10-21）：数据源从「侧栏 DOM 的 data-path」换成 `#nav-structure-json`，
  // 但「无证据时不动」这条守卫语义**原样保留**——只是证据的形式变了。
  assert.ok(src.includes('无侧栏形状') || src.includes('无证据时不动'),
    '设计原则注释在（无 JSON 时不动）');
  assert.match(src, /if \(!json \|\| !json\.nodes\) return undefined/,
    '读不到 nav JSON 时返回 undefined（保留烘焙态，不清空强调栏）');
});

// ② SW 版本握手测试随 sw-template.js 一起退役（SW 已根除，见上方根除守卫测试）。

test('③ 兜底分级：网络失败先 cache:reload 重试再整页跳', () => {
  const src = fs.readFileSync(path.join(HERE, 'spa-router.mjs'), 'utf8');
  assert.ok(src.includes('cache: "reload"'), 'reload 重试存在');
});
