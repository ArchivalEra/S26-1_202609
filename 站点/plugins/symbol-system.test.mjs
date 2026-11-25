// symbol-system.test.mjs —— 全站符号深核心（站点/symbols/）与四适配器端到端契约测试。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSymbolCatalog,
  parseFrontmatter,
  readPageSymbolPolicy,
  formatSymbolAnchor,
  autoWrapTerms,
  SYMBOL_RUNTIME_ASSET,
} from '../symbols/index.mjs';
import { parse as parseMath } from '../math/parser.mjs';
import { compile as compileMath } from '../math/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const DIST = path.join(HERE, '../dist');

test('OKF v0.2 frontmatter 解析保留列表（符号排除）与映射（符号强制）', () => {
  const src = [
    '---',
    'id: okf.test.page',
    'spec_version: "0.2"',
    'course: 电路原理',
    '符号排除: [sym-A, sym-B]',
    '符号排除公式:',
    '  - sym-C',
    '符号强制:',
    '  sym-B: 电机学',
    '---',
    '# 正文',
  ].join('\n');
  const { meta, body } = parseFrontmatter(src, { strict: true });
  const policy = readPageSymbolPolicy(meta);
  assert.equal(policy.okfId, 'okf.test.page');
  assert.equal(policy.course, '电路原理');
  assert.deepEqual(policy.exclude.prose, ['sym-A', 'sym-B']);
  assert.deepEqual(policy.exclude.tex, ['sym-C']);
  assert.deepEqual(policy.pins, { 'sym-B': '电机学' });
  assert.ok(body.startsWith('# 正文'));
});

test('createSymbolCatalog.lookup：缺省 course 多包并列不覆盖；支持 form 词形反查与包链标记', () => {
  const catalog = createSymbolCatalog({ root: ROOT, compileMathDict: false });

  // 不给 course：通用与工程数学同名词条不得互相覆盖（均以包:词条返回）
  const all = catalog.lookup({});
  const keys = new Set(all.matches.map((m) => m.key));
  assert.ok(all.matches.length >= 200);
  assert.equal(keys.size, all.matches.length, '每个匹配必须带唯一规范 key，不可覆盖');

  // 指定 course：通用+电路原理，sym-Z 应标出电路原理 isCurrentCtx=true
  const z = catalog.lookup({ id: 'sym-Z', course: '电路原理' });
  assert.equal(z.env, '通用+电路原理');
  assert.equal(z.matches.length, 1);
  assert.equal(z.matches[0].key, '通用:sym-Z');
  const cur = z.matches[0].senses.find((s) => s.ctx === '电路原理');
  assert.equal(cur?.isCurrentCtx, true);

  // form 词形反查：通过 glossary-match 声明的 TeX/正则形式命中
  const phi = catalog.lookup({ form: '\\varphi', course: '电路原理' });
  assert.ok(phi.matches.some((m) => m.id === 'sym-phi'));
});

test('openPage：三路统一规范键（包:词条）且 符号强制 在公式/正文/图元同时生效', () => {
  const catalog = createSymbolCatalog({ root: ROOT, parseMath });
  const sess = catalog.openPage({
    relPath: '课程总览/电路原理/作业/习题册第一章.md',
    frontmatter: {
      course: '电路原理',
      符号排除公式: ['sym-B'],
      符号强制: { 'sym-B': '电机学' },
    },
  });

  // ① 公式路：forceTerm 已连通，覆盖电路环境排除，锚定到 电机学:sym-B
  const compiled = compileMath({ blocks: [{ raw: 'B=1', mode: 'inline' }] }, sess.mathEnv());
  assert.equal(compiled.docs[0].decisions[0].rule, 'force');
  assert.equal(compiled.docs[0].decisions[0].ref.pack, '电机学');
  assert.equal(compiled.docs[0].decisions[0].ref.entry, 'sym-B');
  sess.recordMathDoc(compiled.docs[0]);

  // ② 正文路：规范键为 `通用:sym-U`（不再出现裸 `sym-U`）
  const proseOut = sess.resolveProse('电压 [U]{#sym-U} 与 [B]{#sym-B}');
  assert.match(proseOut, /data-term="通用:sym-U"/);
  assert.match(proseOut, /data-term="电机学:sym-B"/);

  // ③ 图元路：支持 @包:词条 与 frontmatter 符号强制
  const fig1 = sess.resolveFigureTerm('sym-B');
  assert.equal(fig1?.key, '电机学:sym-B');
  const fig2 = sess.resolveFigureTerm('电子技术:sym-VB');
  assert.equal(fig2?.key, '电子技术:sym-VB');

  // ④ finalize 产出单一 PageSymbolBundle
  const bundle = sess.finalize();
  assert.equal(bundle.glossaryJsonPayload.env, '通用+电路原理');
  assert.equal(bundle.glossaryJsonPayload.ctx, '电路原理');
  assert.ok(bundle.glossaryJsonPayload.terms['通用:sym-U']);
  assert.ok(bundle.glossaryJsonPayload.terms['电机学:sym-B']);
  assert.ok(bundle.glossaryJsonPayload.terms['电子技术:sym-VB']);
  assert.deepEqual(bundle.machineSummary.pins, { 'sym-B': '电机学' });
});

test('构建产物：symbols-bubble.js 存在且无 math-glossary.js 旧名；#sym-glossary-json 只含规范键', () => {
  if (!fs.existsSync(DIST)) return;
  assert.ok(fs.existsSync(path.join(DIST, SYMBOL_RUNTIME_ASSET)), `缺少 ${SYMBOL_RUNTIME_ASSET}`);
  assert.ok(!fs.existsSync(path.join(DIST, 'assets/plugins/math-glossary.js')), '不应再产出旧名 math-glossary.js');

  const samplePath = path.join(DIST, '课程总览/电路原理/作业/习题册第二章.html');
  if (fs.existsSync(samplePath)) {
    const html = fs.readFileSync(samplePath, 'utf8');
    const tag = /<script[^>]*id="sym-glossary-json"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(tag, '缺少 #sym-glossary-json');
    const json = JSON.parse(tag[1]);
    assert.equal(json.env, '通用+电路原理');
    assert.equal(json.ctx, '电路原理');
    const keys = Object.keys(json.terms || {});
    assert.ok(keys.length > 0);
    for (const k of keys) {
      assert.ok(k.includes(':'), `词典键应为规范键 包:词条，实得：${k}`);
    }
  }
});

test('formatSymbolAnchor：唯一 <a> 构造器转义属性且保留语义标签', () => {
  const html = formatSymbolAnchor({
    key: '通用:sym-U',
    href: '../符号包/通用.html#sym-U',
    label: 'U："电压"',
    innerHtml: '<span>U</span>',
  });
  assert.match(html, /^<a class="sym-gloss" data-term="通用:sym-U" href="\.\.\/符号包\/通用\.html#sym-U" aria-label="U：&quot;电压&quot;"><span>U<\/span><\/a>$/);
});

test('autoWrapTerms：完整保护 Markdown 链接文字、构建占位符与 <summary> 折叠标题', () => {
  const dict = {
    'sym-op': { prose: ['运算'] },
  };
  const src = [
    '这里有运算需要标注，而[点此看运算说明](notes.md)里的文字不能套娃；',
    '公式占位 @@MATH_INLINE_0@@ 不能拆；',
    '<details><summary><span class="m3-disclosure__title">第1题：运算性质</span></summary>',
    '折叠正文里的运算照样要包。',
    '</details>',
  ].join('\n');
  const out = autoWrapTerms(src, dict);
  assert.ok(out.includes('这里有[运算]{#sym-op}需要标注'));
  assert.ok(out.includes('[点此看运算说明](notes.md)'), '链接标签不应被包进 {#sym-op}');
  assert.ok(out.includes('@@MATH_INLINE_0@@'));
  assert.ok(out.includes('<summary><span class="m3-disclosure__title">第1题：运算性质</span></summary>'), '<summary> 内不应插入锚点');
  assert.ok(out.includes('折叠正文里的[运算]{#sym-op}照样要包'));
});

test('parseSenses & resolveFigureTerm：数学等式不被切为多义项；符号排除公式不拦显式图元 @词条；跨包强制同步 proseDict', () => {
  const catalog = createSymbolCatalog({ root: ROOT, parseMath });
  const mLookup = catalog.lookup({ pack: '通用', id: 'sym-M' }).matches[0];
  assert.equal(mLookup.senses.length, 2, 'sym-M 的 $u_2=M...$ 不应被切成第三个假义项');
  const sigLookup = catalog.lookup({ course: '电力大数据与人工智能', id: 'sym-sigma' }).matches[0];
  assert.ok(sigLookup.senses.some((s) => s.ctx === '电力大数据与人工智能' && s.isCurrentCtx === true));

  const session = catalog.openPage({
    relPath: '课程总览/工程数学/教材解析/test.md',
    course: '工程数学',
    frontmatter: {
      '符号强制': { 'sym-U': '通用' },
      '符号排除': ['sym-U'],
      '符号排除公式': ['sym-rank'],
    },
  });
  assert.equal(session.warnings.length, 0, `跨包符号强制配合排除不应产生误报警告，实得：${session.warnings.join('; ')}`);
  const figHit = session.resolveFigureTerm('sym-rank');
  assert.equal(figHit?.key, '工程数学:sym-rank', '显式 @词条 应读取 pageDict，不被符号排除公式拦截');

  const bundle = session.finalize();
  assert.ok(!bundle.glossaryJsonPayload.terms['工程数学:sym-rank'].title.includes('<script'));
});

test('构建产物回归：通用.json sym-M 无假义项且图元页 JSON 全数可解析', () => {
  if (!fs.existsSync(DIST)) return;
  const commonJson = path.join(DIST, 'machine/symbols/通用.json');
  if (fs.existsSync(commonJson)) {
    const data = JSON.parse(fs.readFileSync(commonJson, 'utf8'));
    const mEntry = data.entries.find((e) => e.id === 'sym-M');
    assert.equal(mEntry?.senses?.length, 2);
  }
  const figPage = path.join(DIST, '课程总览/电子技术/课堂笔记/2026-10-12课堂.html');
  if (fs.existsSync(figPage)) {
    const html = fs.readFileSync(figPage, 'utf8');
    const idxTag = /<script[^>]*id="figure-index-json"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(idxTag);
    assert.doesNotThrow(() => JSON.parse(idxTag[1]));
    for (const m of html.matchAll(/<script[^>]*class="fig-data"[^>]*>([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => JSON.parse(m[1]));
    }
  }
});
