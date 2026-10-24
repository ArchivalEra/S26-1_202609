// assistant-wire.test.mjs —— 接线器的契约测试（2026-10-22 新增）。
//
// ## 为什么现在才补
//
// 这个模块是「插件薄桥 ↔ 站点协议栈 ↔ 面板」的装配缝，之前**一条测试都没有**。
// 结果一个字段名写错（`r.ok` vs `r.status`）活了很久，症状是**每次回答都显示
// 「（未知错误）」**——用户以为连不上，其实是判据读错了字段。
//
// 这类 bug 的特征：单测全绿（模块本身没测）、功能全坏、错误信息误导。
// 所以这里钉的不是「能连上」，而是**契约**：
//   ① client.ask 返回 `{status, text}`（没有 ok 字段）⇒ 成功必须判成 ok
//   ② 失败必须把真实 error 带出去，不许退化成「未知错误」
//   ③ 上一次没结束时的并发保护仍然生效

import test from 'node:test';
import assert from 'node:assert/strict';
import { wireAssistant } from './assistant-wire.mjs';

/** 假 client：按给定 status 返回 chatsvc 的真实契约形态 `{status, text, calls}`。 */
function fakeClient({ status = 'ok', text = '答案', error = undefined, taps = {} } = {}) {
  return {
    // ⚠️ 真实契约是四参 (sessionId, text, emit, attach)——夹具必须照抄，
    // 否则「调用方传错参数个数」这类 bug 在夹具里根本显不出来（2026-10-25
    // 生产验收的教训：夹具写成两参，于是两参调用恒绿，函数源码被当问题发了出去）。
    async ask(sessionId, askText, emit, attach) {
      taps.sessionId = sessionId;
      taps.text = askText;
      taps.emit = emit;
      taps.attach = attach;
      if (status === 'ok') return { status: 'ok', text, calls: [] };
      return { status, error, text: text || '', calls: [] };
    },
    cancel() { return { cancelled: true }; },
    upload() { return null; },
    setTools() {},
    snapshot() { return null; },
    close() {},
  };
}

/** 造一个已就绪的假 window（bridge + panel 都在场，wire 立刻 attach）。 */
function fakeWin({ client }) {
  const transportRef = { current: null };
  return {
    __assistantBridge: { ask: async () => ({ ok: true, text: '' }), cancel() {} },
    __chatPanel: {
      setTransport(t) { transportRef.current = t; },
    },
    transportRef,
    __client: client,
  };
}

test('契约①：client 返回 {status:"ok"} ⇒ transport 判成功（不是「未知错误」）', async () => {
  const win = fakeWin({ client: fakeClient({ status: 'ok', text: '这是答案' }) });
  const w = wireAssistant({
    win,
    createAssistantClient: () => win.__client,
    runTool: async () => ({ ok: true }),
    pollMs: 1,
  });
  assert.equal(await w.promise, 'attached');
  assert.ok(win.transportRef.current, 'transport 必须已装上面板');

  const r = await win.transportRef.current.ask({ text: '问一句' });
  assert.equal(r.ok, true, 'status=ok 必须判成成功（旧版判 r.ok 恒假，症状是「未知错误」）');
  assert.equal(r.text, '这是答案');
});

test('契约②：传输失败必须带真实 error，不许退化成「未知错误」', async () => {
  const win = fakeWin({ client: fakeClient({ status: 'transport', error: '密文解不开' }) });
  const w = wireAssistant({
    win, createAssistantClient: () => win.__client, runTool: async () => ({}), pollMs: 1,
  });
  await w.promise;

  const r = await win.transportRef.current.ask({ text: '问一句' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, '密文解不开', '必须透传真实原因');
  assert.ok(!/未知错误/.test(r.reason), '不得出现「未知错误」这种无信息兜底');
});

test('契约②b：连 error 都没有时，至少带出 status 枚举（不是「未知错误」）', async () => {
  const win = fakeWin({ client: fakeClient({ status: 'deadline' }) });
  const w = wireAssistant({
    win, createAssistantClient: () => win.__client, runTool: async () => ({}), pollMs: 1,
  });
  await w.promise;

  const r = await win.transportRef.current.ask({ text: '问一句' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'deadline', 'status 是最低限度的诊断信息，比「未知错误」有用');
});

test('契约②c：cancelled/partial 按成功交回（保留半截正文）', async () => {
  for (const status of ['cancelled', 'partial']) {
    const win = fakeWin({ client: fakeClient({ status, text: '半截' }) });
    const w = wireAssistant({
      win, createAssistantClient: () => win.__client, runTool: async () => ({}), pollMs: 1,
    });
    await w.promise;
    const r = await win.transportRef.current.ask({ text: '问一句' });
    assert.equal(r.ok, true, `${status} 是用户主动停的，不是故障`);
    assert.equal(r.text, '半截');
  }
});

test('契约③：上一问未结束时并发保护仍生效', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const win = fakeWin({
    client: { async ask() { await gate; return { status: 'ok', text: '慢答案' }; }, cancel() {}, upload() {}, setTools() {}, snapshot() {}, close() {} },
  });
  const w = wireAssistant({
    win, createAssistantClient: () => win.__client, runTool: async () => ({}), pollMs: 1,
  });
  await w.promise;

  const first = win.transportRef.current.ask({ text: '第一问' });
  const second = await win.transportRef.current.ask({ text: '第二问' });
  assert.equal(second.ok, false);
  assert.match(second.reason, /上一问还没结束/);

  release();
  const r1 = await first;
  assert.equal(r1.ok, true);
  assert.equal(win.transportRef.current.busy, false, '终态后 busy 必须落回 false');
});

test('wire 超时：桥不在场时返回 timeout，不抛异常', async () => {
  const win = { __chatPanel: { setTransport() {} } };   // 没有 bridge
  const w = wireAssistant({
    win, createAssistantClient: () => fakeClient(), runTool: async () => ({}), pollMs: 1, deadlineMs: 30,
  });
  assert.equal(await w.promise, 'timeout');
});

// ── 契约④：ask 的参数位置（2026-10-25 生产验收实弹）──────────────
// 症状：上游一直解释同一段 JS。根因是接线器只传两参，而 chatsvc.ask 是四参
// (sessionId, text, emit, attach) ⇒ text 落进 sessionId、onEvent 落进 text
// ⇒ String(函数) 被当成问题发给上游，用户输入从未到达；emit 也恒 undefined。
test('契约④：用户正文必须落在 text 位，回调必须落在 emit 位（参数不许错位）', async () => {
  const taps = {};
  const client = fakeClient({ taps });
  const win = fakeWin({ client });
  win.__assistantBridge = { ask: async () => ({ ok: true, text: '' }), cancel() {} };
  await wireAssistant({ win, createAssistantClient: () => client, runTool: async () => ({ ok: true }), serializeTools: () => [] }).promise;
  const t = win.transportRef.current;
  const onEvent = function (ev) { void ev; };
  await t.ask({ text: '电机学有哪些课堂笔记' }, onEvent);
  assert.equal(taps.text, '电机学有哪些课堂笔记', '用户输入必须原样落在 text 位');
  assert.equal(typeof taps.emit, 'function', 'emit 必须是回调（不是 undefined）');
  assert.equal(taps.emit, onEvent, 'emit 必须就是调用方给的 onEvent');
  assert.ok(!/function|=>/.test(String(taps.text)), 'text 位绝不能出现函数源码');
  assert.equal(typeof taps.sessionId, 'string', 'sessionId 必须是字符串');
  assert.ok(!taps.sessionId.includes('电机学'), '用户输入不得串到 sessionId 位');
});

// ── 契约⑤：工具表必须来自注册表，且 Promise 形态也要吃 ─────────────
// 症状（2026-10-25 生产验收）：用户正文到了上游，但**提示词没包上**。
// 机制：getTools() 在规范/polyfill 注册表返回 Promise，旧实现同步当数组用
// ⇒ Array.isArray(Promise) 为假 ⇒ 工具表恒空 ⇒ allowed.length === 0
// ⇒ 站点侧不加提示词，正文裸发。
test('契约⑤：getTools() 返回 Promise 时工具表仍要读到（不许静默变空）', async () => {
  const tools = [{ name: 'site_read', description: '读正文', inputSchema: { type: 'object', properties: {} } }];
  let gotTools = null;
  const client = {
    async ask() { return { status: 'ok', text: '好', calls: [] }; },
    cancel() {}, upload() { return null; }, setTools() {}, snapshot() { return null; }, close() {},
  };
  const win = {
    __assistantBridge: { ask: async () => ({ ok: true, text: '' }), cancel() {} },
    __chatPanel: { setTransport(t) { win.transport = t; } },
    document: { modelContext: { getTools: () => Promise.resolve(tools) } },
    navigator: {},
  };
  await wireAssistant({
    win,
    createAssistantClient: ({ tools: t }) => { gotTools = t; return client; },
    runTool: async () => ({ ok: true }),
    pollMs: 1,
  }).promise;
  await win.transport.ask({ text: '问一句' }, () => {});
  assert.ok(Array.isArray(gotTools), '工具表必须是数组');
  assert.equal(gotTools.length, 1, 'Promise 形态的 getTools 结果不许丢');
});
