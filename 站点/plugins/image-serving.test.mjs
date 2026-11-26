// 禁止服务阶段出现 PNG（MCP canvas 处理除外）＋ 透明底低对比配图自动反色测试

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(SITE_DIR, '..');
const DIST_DIR = path.join(SITE_DIR, 'dist');
const THEME_CSS = path.join(SITE_DIR, 'assets/theme/shirone-reader.css');
const THEME_JS = path.join(SITE_DIR, 'assets/theme/shirone-reader.js');

function collectPngs(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) collectPngs(p, out);
    else if (/\.png$/i.test(ent.name)) out.push(path.relative(REPO_ROOT, p));
  }
  return out;
}

test('serve 产物 dist/、站点/assets/ 与课程配图目录不得存在 PNG 文件', () => {
  const bad = [
    ...collectPngs(DIST_DIR),
    ...collectPngs(path.join(SITE_DIR, 'assets')),
  ];
  const coursesDir = path.join(REPO_ROOT, '课程总览');
  for (const c of readdirSync(coursesDir, { withFileTypes: true })) {
    if (!c.isDirectory()) continue;
    for (const sub of ['作业', '交叉内容']) {
      bad.push(...collectPngs(path.join(coursesDir, c.name, sub, 'figures')));
    }
  }
  assert.deepEqual(bad, [], `发现禁止在 serve 阶段出现的文件：\n${bad.join('\n')}`);
});

test('构建产物 HTML 不得引用 .png 资源 URL（MCP canvas 截图除外）', () => {
  const sampleHtml = path.join(DIST_DIR, '课程总览/通用电气/交叉内容/01-电路矩阵与消元判解.html');
  assert.ok(existsSync(sampleHtml), '示例页面应已构建');
  const html = readFileSync(sampleHtml, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+\.png(?:[?#][^"]*)?)"/gi)].map((m) => m[1]);
  assert.deepEqual(refs, [], `HTML 中仍残留 PNG 引用：${refs.join(', ')}`);
});

test('透明底黑线配图与页面底色对比度过低时自动反色呈现', () => {
  const css = readFileSync(THEME_CSS, 'utf8');
  assert.match(css, /\.article-content\s+img\.img-auto-invert\s*\{[^}]*filter:\s*invert\(1\)\s+hue-rotate\(180deg\)/,
    'shirone-reader.css 须提供 .article-content img.img-auto-invert 反色样式');

  const noop = () => {};
  const fakeStyle = {
    getPropertyValue: () => '',
    backgroundColor: 'rgb(18, 17, 23)',
    setProperty: noop,
    removeProperty: noop,
  };
  const fakeEl = {
    setAttribute: noop,
    getAttribute: () => 'dark',
    classList: { toggle: noop, add: noop, remove: noop },
    addEventListener: noop,
    parentElement: null,
    nodeType: 1,
    style: fakeStyle,
  };
  const sandbox = {
    addEventListener: noop,
    getComputedStyle: () => fakeStyle,
    innerWidth: 1280,
    pageYOffset: 0,
    scrollY: 0,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    document: {
      documentElement: fakeEl,
      body: fakeEl,
      activeElement: null,
      fonts: null,
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
      addEventListener: noop,
      createElement: () => ({ getContext: () => null }),
    },
    window: null,
    requestAnimationFrame: (cb) => cb(),
    MutationObserver: function () { return { observe: noop }; },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(readFileSync(THEME_JS, 'utf8'), sandbox);

  const api = sandbox.__contrastInvert;
  assert.ok(api && typeof api.shouldInvertSamples === 'function', '应暴露对比度检测逻辑');

  // 构造 4x4 = 16 像素样本：12 个全透明背景 + 4 个纯黑描边
  const blackOnTransparent = new Uint8ClampedArray(16 * 4);
  for (let p = 0; p < 4; p++) {
    blackOnTransparent[p * 4 + 3] = 255; // #000, alpha=255
  }
  assert.equal(api.shouldInvertSamples(blackOnTransparent, { r: 18, g: 17, b: 23 }), true,
    '深色底 + 透明底黑线应触发反色');
  assert.equal(api.shouldInvertSamples(blackOnTransparent, { r: 250, g: 250, b: 254 }), false,
    '浅色底 + 透明底黑线对比度高，不应反色');

  // 透明底白线在浅色底上也应反色
  const whiteOnTransparent = new Uint8ClampedArray(16 * 4);
  for (let p = 0; p < 4; p++) {
    whiteOnTransparent[p * 4] = 255;
    whiteOnTransparent[p * 4 + 1] = 255;
    whiteOnTransparent[p * 4 + 2] = 255;
    whiteOnTransparent[p * 4 + 3] = 255;
  }
  assert.equal(api.shouldInvertSamples(whiteOnTransparent, { r: 250, g: 250, b: 254 }), true,
    '浅色底 + 透明底白线对比度低，应反色');

  // 不透明白底黑字扫描图在深色底上不应误反色
  const opaqueWhiteCard = new Uint8ClampedArray(16 * 4);
  for (let p = 0; p < 16; p++) {
    const v = p < 2 ? 0 : 255;
    opaqueWhiteCard[p * 4] = v;
    opaqueWhiteCard[p * 4 + 1] = v;
    opaqueWhiteCard[p * 4 + 2] = v;
    opaqueWhiteCard[p * 4 + 3] = 255;
  }
  assert.equal(api.shouldInvertSamples(opaqueWhiteCard, { r: 18, g: 17, b: 23 }), false,
    '不透明白底图已有自身底色对比度，不应误反色');
});
