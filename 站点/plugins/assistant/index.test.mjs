// index.test.mjs —— 站点侧入口的薄壳契约（T10 新增，四个搬来的套件之外）。
//
// 搬来的四个套件测的是协议栈本身（零改动）；这个文件只钉住**新写的壳**：
//   · 缺 bridge / invoke 立刻报错
//   · bridge.ask 的 {ok,text,reason} 被翻译成管理器认识的 status
//   · 工具循环在站点侧跑（bridge 第一轮给调用 → invoke 执行 → 回喂 → 再 ask）
//   · 用户取消 → done{status:'cancelled'}，不出 error

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantClient } from './index.mjs';

const TOOLS = [
  { name: 'site_search', description: '搜全站', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
];

/** 剧本桥：按顺序出牌，记录每次收到的 payload 与 onEvent。 */
function fakeBridge(script) {
  const taps = { asks: [] };
  const bridge = {
    async ask(payload, onEvent) {
      taps.asks.push({ payload, onEvent });
      const s = script.shift() || { ok: true, text: '默认回答' };
      if (typeof s === 'function') return s(payload, onEvent);
      return s;
    },
    cancel() { taps.cancelled = true; return { cancelled: true }; },
  };
  return { bridge, taps };
}

const collect = () => {
  const events = [];
  return { events, emit: (e) => events.push(e) };
};

test('createAssistantClient：缺 bridge / invoke 时明确报错', () => {
  assert.throws(() => createAssistantClient({ invoke: () => {} }), /缺少 bridge/);
  assert.throws(() => createAssistantClient({ bridge: { ask: () => {} } }), /缺少 invoke/);
});

test('一问一答：提示词经 bridge 上送，delta + done 恰好一次终态', async () => {
  const { bridge, taps } = fakeBridge([{ ok: true, text: '铁芯损耗在第二章。' }]);
  const svc = createAssistantClient({
    bridge, tools: TOOLS, invoke: async () => ({ value: { ok: true } }),
  });
  const { events, emit } = collect();
  const r = await svc.ask('c1', '电机学的铁芯损耗在哪一节', emit);

  assert.equal(r.status, 'ok');
  assert.equal(r.text, '铁芯损耗在第二章。');
  // 工具表进了提示词（G15：任务句在最后）
  assert.match(taps.asks[0].payload.text, /site_search/);
  assert.match(taps.asks[0].payload.text, /电机学的铁芯损耗在哪一节/);
  assert.equal(events.filter((e) => e.type === 'done').length, 1);
  assert.equal(events.filter((e) => e.type === 'error').length, 0);
  assert.ok(events.some((e) => e.type === 'delta' && e.text.includes('铁芯损耗')));
});

test('工具循环在站点侧跑：解析调用 → invoke → 回喂 → 再 ask', async () => {
  const { bridge, taps } = fakeBridge([
    { ok: true, text: '<function_calls><invoke name="site_search"><parameter name="query">铁芯损耗</parameter></invoke></function_calls>' },
    { ok: true, text: '找到 1 条结果。' },
  ]);
  const calls = [];
  const svc = createAssistantClient({
    bridge, tools: TOOLS, rounds: 3,
    invoke: async (name, args) => { calls.push({ name, args }); return { value: { ok: true, hits: [] } }; },
  });
  const { events, emit } = collect();
  const r = await svc.ask('c1', '搜一下铁芯损耗', emit);

  assert.deepEqual(calls, [{ name: 'site_search', args: { query: '铁芯损耗' } }]);
  assert.equal(taps.asks.length, 2, '调用一轮 + 回答一轮');
  assert.match(taps.asks[1].payload.text, /刚才的操作结果/);
  assert.match(taps.asks[1].payload.text, /site_search/);
  assert.equal(r.text, '找到 1 条结果。');
  assert.ok(events.some((e) => e.type === 'tool' && e.name === 'site_search' && e.ok));
});

test('取消：bridge 回 ok:false/reason=cancelled → done{cancelled}，不出 error', async () => {
  const { bridge, taps } = fakeBridge([{ ok: false, reason: 'cancelled' }]);
  const svc = createAssistantClient({
    bridge, tools: [], invoke: async () => ({ value: {} }),
  });
  const { events, emit } = collect();
  const r = await svc.ask('c1', '你好', emit);

  assert.equal(r.status, 'cancelled');
  assert.equal(events.filter((e) => e.type === 'done')[0].status, 'cancelled');
  assert.equal(events.filter((e) => e.type === 'error').length, 0);
  assert.ok(taps.asks.length >= 1);
});

test('bridge.cancel 被转到桥（站点停问）', async () => {
  const { bridge, taps } = fakeBridge([{ ok: true, text: 'x' }]);
  const svc = createAssistantClient({
    bridge, tools: [], invoke: async () => ({ value: {} }),
  });
  svc.cancel('c1');   // 未问过：管理器里没会话，桥不被打扰
  assert.equal(taps.cancelled, undefined);
  await svc.ask('c1', '你好', () => {});
  svc.cancel('c1');
  assert.equal(taps.cancelled, true);
});
