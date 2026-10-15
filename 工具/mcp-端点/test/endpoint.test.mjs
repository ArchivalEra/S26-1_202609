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
import { createDirectEndpoint, TOOL_DEFS, TOOL_PREFIX, RELAY_RESERVED } from '../lib/endpoint-direct.mjs';
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
  const names = TOOL_DEFS.map((d) => TOOL_PREFIX + d.name);
  for (const n of names) {
    assert.ok(!RELAY_RESERVED.includes(n), `${n} 与 relay 保留名相撞`);
  }
  assert.deepEqual(names.sort(), ['course_ask', 'course_read_page', 'course_search', 'course_stat', 'course_symbol']);
});

test('每个工具都有 description（给模型的选择依据）与 inputSchema', () => {
  for (const d of TOOL_DEFS) {
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
