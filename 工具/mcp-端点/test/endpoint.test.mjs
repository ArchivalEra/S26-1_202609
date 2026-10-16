/**
 * Endpoint 契约测试：工具名与 relay 不相交、stdio 握手、工具错不升级。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadCore } from '../lib/read-core.mjs';
import { createDistCorpus } from '../lib/corpus-dist.mjs';
import { createCatalog } from '../lib/catalog-source.mjs';
import { createSourcePacks } from '../lib/packs-source.mjs';
import { createDirectEndpoint, TOOL_PREFIX, RELAY_RESERVED } from '../lib/endpoint-direct.mjs';
import { COURSE_TOOLS, SITE_TOOLS_COURSE, ALL_TOOL_NAMES, renderToolCatalogForPrompt } from '../lib/tool-catalog.mjs';
import { createStdioEndpoint } from '../lib/endpoint-stdio.mjs';
import { TARGET_FILES } from '../../../站点/页面清单.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

function core() {
  return createReadCore({
    corpus: createDistCorpus({ distDir: path.join(ROOT, '站点/dist'), root: ROOT, targetFiles: TARGET_FILES }),
    catalog: createCatalog({ root: ROOT, targetFiles: TARGET_FILES }),
    packs: createSourcePacks({ root: ROOT }),
  });
}

test('工具名带 course_ 前缀，且与 relay 保留名不相交', () => {
  const names = COURSE_TOOLS.map((d) => TOOL_PREFIX + d.name);
  for (const n of names) {
    assert.ok(!RELAY_RESERVED.includes(n), `${n} 与 relay 保留名相撞`);
  }
  assert.deepEqual(names.sort(), ['course_ask', 'course_read_page', 'course_search', 'course_stat', 'course_symbol']);
});

test('每个工具都有 description（给模型的选择依据）与 inputSchema', () => {
  for (const d of COURSE_TOOLS) {
    assert.ok(d.description && d.description.length > 20, `${d.name} 缺 description`);
    assert.ok(d.inputSchema && d.inputSchema.type === 'object');
  }
});

test('Direct endpoint：call 返回 content + structuredContent', async () => {
  const ep = createDirectEndpoint(core());
  const r = await ep.call('course_stat', {});
  assert.ok(!r.isError);
  assert.ok(r.structuredContent.pages === 114);
  assert.ok(r.content[0].type === 'text');
});

test('Direct endpoint：未知工具走 isError，不抛', async () => {
  const ep = createDirectEndpoint(core());
  const r = await ep.call('course_nope', {});
  assert.equal(r.isError, true);
  assert.equal(r.code, 'unknown_tool');
});

test('stdio：握手前调用 tools/list 回 -32002', async () => {
  const { PassThrough } = await import('node:stream');
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (d) => chunks.push(d.toString()));
  const ep = createStdioEndpoint({ core: core(), input, output, log: () => {} });
  ep.listen();
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  await new Promise((r) => setTimeout(r, 50));
  const msg = JSON.parse(chunks.join('').split('\n')[0]);
  assert.equal(msg.error.code, -32002);
});

test('stdio：initialize → tools/list → tools/call 全流程', async () => {
  const { PassThrough } = await import('node:stream');
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (d) => chunks.push(d.toString()));
  const ep = createStdioEndpoint({ core: core(), input, output, log: () => {} });
  ep.listen();
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  await new Promise((r) => setTimeout(r, 80));
  const msgs = chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const init = msgs.find((m) => m.id === 1);
  assert.ok(init.result.serverInfo.name);
  const list = msgs.find((m) => m.id === 2);
  assert.equal(list.result.tools.length, 5);
});

test('stdio：工具错走 result.isError（不升级成协议错）', async () => {
  const { PassThrough } = await import('node:stream');
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (d) => chunks.push(d.toString()));
  const ep = createStdioEndpoint({ core: core(), input, output, log: () => {} });
  ep.listen();
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'course_nope', arguments: {} } }) + '\n');
  await new Promise((r) => setTimeout(r, 80));
  const msgs = chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const call = msgs.find((m) => m.id === 2);
  assert.equal(call.result.isError, true);
  assert.equal(call.error, undefined, '工具错不该是协议错');
});

// ── 候选 1：工具目录是单一真相源 ──────────────────────────────

test('目录：每条都有 name / title / description / inputSchema / coreMethod', () => {
  for (const d of COURSE_TOOLS) {
    assert.ok(d.name, '缺 name');
    assert.ok(d.title, `${d.name} 缺 title`);
    assert.ok(d.description && d.description.length > 15, `${d.name} 缺 description`);
    assert.equal(d.inputSchema.type, 'object');
    assert.ok(d.coreMethod, `${d.name} 缺 coreMethod（改名表该住在目录里）`);
  }
});

test('目录：coreMethod 都是 ReadCore 上真有的方法', () => {
  const c = core();
  for (const d of COURSE_TOOLS) {
    assert.equal(typeof c[d.coreMethod], 'function', `${d.coreMethod} 不是 ReadCore 方法`);
  }
});

test('目录：两套工具名与 relay 保留名都不相交', () => {
  for (const n of ALL_TOOL_NAMES) {
    assert.ok(!RELAY_RESERVED.includes(n), `${n} 撞了 relay 保留名`);
  }
  // course_ 与 site_ 两套互不相撞
  const course = COURSE_TOOLS.map((d) => TOOL_PREFIX + d.name);
  const site = SITE_TOOLS_COURSE.map((d) => d.name);
  for (const n of course) assert.ok(!site.includes(n), `${n} 两套重名`);
});

test('目录：list() 的条目与目录逐项一致（含 title，不再被 stdio 丢掉）', () => {
  const ep = createDirectEndpoint(core());
  const listed = ep.list();
  assert.equal(listed.length, COURSE_TOOLS.length);
  listed.forEach((t, i) => {
    assert.equal(t.name, TOOL_PREFIX + COURSE_TOOLS[i].name);
    assert.equal(t.title, COURSE_TOOLS[i].title);
    assert.equal(t.description, COURSE_TOOLS[i].description);
  });
});

test('目录：renderToolCatalogForPrompt 产出课程语义（破甲话术的唯一来源）', () => {
  const txt = renderToolCatalogForPrompt();
  for (const d of COURSE_TOOLS) {
    assert.ok(txt.includes(d.course.label), `话术清单缺「${d.course.label}」`);
    assert.ok(txt.includes(`<invoke name="${TOOL_PREFIX}${d.name}">`), `缺 ${d.name} 的标记写法`);
  }
  // 站点侧也能生成
  const siteTxt = renderToolCatalogForPrompt(SITE_TOOLS_COURSE, '');
  assert.ok(siteTxt.includes('页面信息登记标记'));
});
