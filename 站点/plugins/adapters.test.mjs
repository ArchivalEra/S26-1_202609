// adapters.test.mjs —— 第三方依赖可插拔契约 + 包管理器清单与 check_right 双向对齐测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import katex from 'katex';
import { createMarkedProvider } from '../adapters/marked.mjs';
import { createMarkdownRenderer } from '../markdown.mjs';
import { createFrontmatterParser, parseFrontmatter } from '../symbols/frontmatter.mjs';
import { parse } from '../math/parser.mjs';
import { createKatexRenderer, replaceKatexWithText, KATEX_STYLESHEET } from '../math/render.mjs';
import { probeRenderer } from '../math/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.resolve(HERE, '..');
const ROOT_DIR = path.resolve(SITE_DIR, '..');

test('marked 适配器把标题、表格与嵌套上下文转换为普通数据', () => {
  const headings = [];
  const tables = [];
  const provider = createMarkedProvider(marked);
  const html = provider.render(`## [标题][ref] {#stable}

> <!-- table:matrix -->
>
> | **量** | 值 |
> | :--- | ---: |
> | [链接][ref] | 1 |

[ref]: /target
`, {
    heading(data) { headings.push(data); return data.html; },
    table(data) { tables.push(data); return '<table>替换表格</table>'; },
  });
  assert.deepEqual(headings, [{ depth: 2, text: '[标题][ref] {#stable}', html: '<a href="/target">标题</a> {#stable}' }]);
  assert.deepEqual(tables, [{
    header: [{ text: '**量**', html: '<strong>量</strong>' }, { text: '值', html: '值' }],
    rows: [[{ text: '[链接][ref]', html: '<a href="/target">链接</a>' }, { text: '1', html: '1' }]],
    align: ['left', 'right'], mode: 't-matrix', label: '[标题][ref]',
  }]);
  assert.match(html, /<blockquote>[\s\S]*<table>替换表格<\/table>/);
});

test('marked 的渲染配置按调用隔离，并保留普通解析入口的行为', () => {
  const provider = createMarkedProvider(marked);
  const raw = marked.parse('# 标题');
  const callbacks = (label) => ({ heading: () => label, table: () => label });
  assert.equal(provider.render('# 标题', callbacks('甲')), '甲');
  assert.equal(provider.render('# 标题', callbacks('乙')), '乙');
  assert.equal(provider.render('# 标题', callbacks('甲')), '甲');
  assert.equal(marked.parse('# 标题'), raw);
  assert.equal(marked.defaults.renderer, null);
  assert.equal(marked.defaults.hooks, null);
});

test('站点 Markdown 策略可接入另一 provider，自动重置每页标题去重状态', () => {
  const seen = [];
  const alternate = {
    render(source, { heading, table }) {
      seen.push(source);
      const title = { depth: 2, text: '标题 {#fixed}', html: '<em>标题</em> {#fixed}' };
      return heading(title) + heading(title) + table({
        header: [{ text: '<b>"A&B"</b>', html: '<b>"A&amp;B"</b>' }],
        rows: [[{ text: '内容', html: '<em>内容</em>' }]],
        align: ['right'], mode: 't-cards', label: '数据标题',
      });
    },
  };
  const renderer = createMarkdownRenderer(alternate);
  const html = renderer.render('第一页');
  assert.match(html, /<h2 id="fixed"><em>标题<\/em><\/h2><h2 id="fixed-2">/);
  assert.match(html, /table-scroll-container t-cards" role="region" aria-label="数据标题"/);
  assert.match(html, /<th align="right">/);
  assert.match(html, /data-label="&quot;A&amp;B&quot;"><em>内容<\/em>/);
  assert.equal(renderer.render('第二页'), html);
  assert.deepEqual(seen, ['第一页', '第二页']);
});

test('默认 Markdown provider 保留公式标题锚点、显式表格模式与逐页去重', () => {
  const renderer = createMarkdownRenderer();
  const source = `## 标题 @@MATH_INLINE_0@@
## 标题 @@MATH_INLINE_1@@

<!-- table:matrix -->

| 量 | 值 |
| --- | --- |
| A | 1 |

| 下一表 | 值 |
| --- | --- |
| B | 2 |
`;
  const html = renderer.render(source);
  assert.match(html, /<h2 id="标题">标题 @@MATH_INLINE_0@@<\/h2>/);
  assert.match(html, /<h2 id="标题-2">/);
  assert.equal((html.match(/table-scroll-container t-matrix/g) || []).length, 1);
  assert.equal((html.match(/table-scroll-container t-compact/g) || []).length, 1);
  assert.equal(renderer.render(source), html);
  assert.equal(createMarkdownRenderer().render(source), html);
});

test('YAML provider 可单独替换，frontmatter 仍负责边界、映射检查与错误策略', () => {
  const seen = [];
  const parser = createFrontmatterParser({ parse(source) { seen.push(source); return { fork: true }; } });
  assert.deepEqual(parser('---\r\na: b\r\n---\r\n正文'), {
    meta: { fork: true }, rawFrontmatter: 'a: b', body: '正文', hasFrontmatter: true,
  });
  assert.equal(parser('正文').hasFrontmatter, false);
  assert.deepEqual(seen, ['a: b']);
  for (const value of [null, ['a'], 'a', 1]) {
    assert.deepEqual(createFrontmatterParser({ parse: () => value })('---\na\n---\n').meta, {});
  }
  const broken = createFrontmatterParser({ parse() { throw new Error('无效 YAML'); } });
  assert.deepEqual(broken('---\na\n---\n正文').meta, {});
  assert.throws(() => broken('---\na\n---\n正文', { strict: true, filePath: 'sample.md' }),
    /frontmatter 解析失败 sample\.md: 无效 YAML/);
  assert.deepEqual(parseFrontmatter('---\n符号排除: [A, B]\n---\n').meta, { 符号排除: ['A', 'B'] });
});

test('KaTeX 兼容实现可注入，公式渲染与目录投影契约完整', () => {
  const calls = [];
  const renderer = createKatexRenderer({
    renderToString(tex, options) {
      calls.push({ tex, options });
      return '<span class="katex"><span data-term="sym-A">A</span></span>';
    },
  });
  assert.deepEqual(probeRenderer(renderer), []);
  const { expr } = parse('A', { mode: 'display' });
  const out = renderer.render({ ...expr, plainHint: 'A' });
  assert.match(out.html, /data-math-plain="A"/);
  assert.match(out.html, /data-math-tex="A"/);
  assert.equal(calls.at(-1).options.displayMode, true);
  assert.deepEqual(out.problems, []);
  assert.deepEqual(probeRenderer(createKatexRenderer(katex)), []);
  assert.equal(KATEX_STYLESHEET, 'assets/katex/katex.min.css');
  assert.equal(replaceKatexWithText('前<span class="katex"><span><annotation encoding="application/x-tex">A&amp;B</annotation></span></span></span>后'), '前A&B后');
});

test('package-lock.json 与 right.json / licenses.json 双向闭环（防漏包与防空扫）', () => {
  const pkg = JSON.parse(readFileSync(path.join(SITE_DIR, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(path.join(SITE_DIR, 'package-lock.json'), 'utf8'));
  const right = JSON.parse(readFileSync(path.join(ROOT_DIR, 'right.json'), 'utf8'));
  const licenses = JSON.parse(readFileSync(path.join(SITE_DIR, 'licenses.json'), 'utf8'));

  const lockPkgs = new Map(
    Object.entries(lock.packages || {}).filter(([key]) => key !== ''),
  );
  const lockDecls = (right.declarations || []).filter((d) => d.path === '站点/package-lock.json');
  const declByField = new Map(lockDecls.map((d) => [d.field, d]));

  const ALLOWED_SPDX = new Set([
    'MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'Python-2.0', 'BlueOak-1.0.0', '0BSD',
  ]);
  const directDeps = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ]);

  // 1. 锁文件里每个生产依赖与直接 dev 依赖都必须在 right.json 有对应字段检查与 SPDX 标记；
  //    所有锁文件传递依赖都必须持有明确的白名单 SPDX 许可（开发依赖如 lodash.merge 键含 '.' 故不强塞点路径）。
  for (const [pkgKey, meta] of lockPkgs) {
    assert.ok(meta.license && ALLOWED_SPDX.has(meta.license),
      `package-lock 依赖 ${pkgKey} 许可未在允许的宽松 SPDX 列表中: ${meta.license}`);
    const pkgName = pkgKey.replace(/^node_modules\//, '');
    if (meta.dev && !directDeps.has(pkgName)) continue;
    assert.ok(!pkgKey.includes('.'), `package-lock 键名含 '.' 无法用 check_right 点路径定位: ${pkgKey}`);
    const field = `packages.${pkgKey}.license`;
    const decl = declByField.get(field);
    assert.ok(decl, `right.json 漏登记锁文件依赖: ${field}`);
    assert.equal(decl.spdx, true, `${field} 必须启用 spdx 检查`);
    assert.equal(decl.equals, meta.license, `${field} 预期许可与 package-lock.json 不一致`);
  }

  // 2. right.json 对 package-lock.json 的每一条检查都必须命中现存包，禁止空扫过时清单
  for (const decl of lockDecls) {
    const m = /^packages\.(.+)\.license$/.exec(decl.field);
    assert.ok(m, `right.json 锁文件检查路径不规范: ${decl.field}`);
    assert.ok(lockPkgs.has(m[1]), `right.json 指向已不存在的锁文件依赖（防空扫）: ${m[1]}`);
  }

  // 3. package.json 的直接依赖必须全部落在 licenses.json 的 components 中且许可一致
  for (const depName of Object.keys(pkg.dependencies || {})) {
    const compKey = depName.replace(/-/g, '_');
    const comp = licenses.components?.[compKey];
    const lockMeta = lockPkgs.get(`node_modules/${depName}`);
    assert.ok(lockMeta, `package.json 依赖未写入 package-lock.json: ${depName}`);
    assert.ok(comp, `licenses.json.components 漏登记直接依赖 ${depName}（期望键 ${compKey}）`);
    assert.equal(comp.license, lockMeta.license, `${depName} 许可在 licenses.json 与锁文件中不一致`);
  }

  // 4. 顺跑真实 check_right.py --spec right.json，确保源清单当下可过门禁
  execFileSync('python3', [path.join(ROOT_DIR, 'zreflect', 'check_right.py'), '--spec', 'right.json'], {
    cwd: ROOT_DIR,
    stdio: 'pipe',
  });
});
