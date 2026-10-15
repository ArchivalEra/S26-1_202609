/**
 * WebMCP shim 的性质测试（`node --test`，零依赖）。
 *
 * 验的是**双注册**的核心契约：同一个 `execute` 闭包同时进两个注册表；
 * 注册/解除都同步；任一侧不接受也不影响另一侧。
 *
 * 浏览器端实测见 handoff §0.30 与需求书 §7.1（Firefox 155 + relay：
 * 只经 navigator 注册的工具，经 shim 后 relay 也能看到并调用）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDual, WEBMCP_SHIM_JS } from './webmcp-shim.mjs';

/** 假注册表：记录注册过的工具，形状同 navigator/document.modelContext。 */
function fakeRegistry(name) {
  const tools = new Map();
  return {
    name,
    tools,
    async registerTool(tool) { tools.set(tool.name, tool); return { ok: true }; },
    async unregisterTool(arg) {
      const n = (arg && arg.name) ? arg.name : arg;
      tools.delete(n);
      return { ok: true };
    },
  };
}

test('双注册：一侧注册，另一侧也拿到同一个工具对象', async () => {
  const nav = fakeRegistry('nav');
  const doc = fakeRegistry('doc');
  const dual = makeDual(nav, doc);

  const tool = { name: 'site_test', execute: async () => ({ content: [{ type: 'text', text: 'OK' }] }) };
  await dual.registerTool(tool);

  assert.ok(nav.tools.has('site_test'), '本侧应有');
  assert.ok(doc.tools.has('site_test'), '对侧也应有');
  assert.equal(nav.tools.get('site_test'), doc.tools.get('site_test'), '两侧应是同一个对象（同一 execute 闭包）');
});

test('双注册：解除时两侧都解除', async () => {
  const nav = fakeRegistry('nav');
  const doc = fakeRegistry('doc');
  const dual = makeDual(nav, doc);
  await dual.registerTool({ name: 't1' });
  await dual.unregisterTool('t1');
  assert.ok(!nav.tools.has('t1') && !doc.tools.has('t1'));
});

test('双注册：不重复推给对侧（同名二次注册只同步一次）', async () => {
  const nav = fakeRegistry('nav');
  let docCalls = 0;
  const doc = {
    async registerTool() { docCalls++; },
    async unregisterTool() {},
  };
  const dual = makeDual(nav, doc);
  await dual.registerTool({ name: 'dup' });
  await dual.registerTool({ name: 'dup' });
  assert.equal(docCalls, 1, '同名只应同步一次');
});

test('对侧抛错不影响本侧（容错）', async () => {
  const nav = fakeRegistry('nav');
  const doc = {
    async registerTool() { throw new Error('对方不支持'); },
    async unregisterTool() { throw new Error('对方不支持'); },
  };
  const dual = makeDual(nav, doc);
  await dual.registerTool({ name: 'x' });
  assert.ok(nav.tools.has('x'), '本侧仍应注册成功');
  await dual.unregisterTool('x');
  assert.ok(!nav.tools.has('x'), '解除也应成功');
});

test('对侧没有 unregisterTool 时不报错', async () => {
  const nav = fakeRegistry('nav');
  const doc = { async registerTool() {} }; // 没有 unregisterTool
  const dual = makeDual(nav, doc);
  await dual.registerTool({ name: 'y' });
  await dual.unregisterTool('y');
  assert.ok(!nav.tools.has('y'));
});

test('内联源码与 makeDual 行为一致（源码含关键守卫）', () => {
  assert.ok(WEBMCP_SHIM_JS.includes('registerTool'), '源码应包装 registerTool');
  assert.ok(WEBMCP_SHIM_JS.includes('navigator.modelContext'), '源码应读 navigator 注册表');
  assert.ok(WEBMCP_SHIM_JS.includes('document.modelContext'), '源码应读 document 注册表');
  assert.ok(WEBMCP_SHIM_JS.includes('nav === doc'), '源码应有「本就同一个就什么都不做」的守卫');
});
