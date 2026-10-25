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
  const h = svc.open();
  const r = await svc.ask(h, '电机学的铁芯损耗在哪一节', emit);

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
  const h = svc.open();
  const r = await svc.ask(h, '搜一下铁芯损耗', emit);

  assert.deepEqual(calls, [{ name: 'site_search', args: { query: '铁芯损耗' } }]);
  assert.equal(taps.asks.length, 2, '调用一轮 + 回答一轮');
  // 2026-10-25 站长定案：回喂**只搬工具结果**，不加引导语、不复述任务。
  assert.match(taps.asks[1].payload.text, /\[工具返回：site_search/, '只搬结果');
  assert.doesNotMatch(taps.asks[1].payload.text, /已经执行了|原始任务|你上一轮/, '不许夹带引导语');
  assert.equal(r.text, '找到 1 条结果。');
  assert.ok(events.some((e) => e.type === 'tool' && e.name === 'site_search' && e.ok));
});

test('取消：bridge 回 ok:false/reason=cancelled → done{cancelled}，不出 error', async () => {
  const { bridge, taps } = fakeBridge([{ ok: false, reason: 'cancelled' }]);
  const svc = createAssistantClient({
    bridge, tools: [], invoke: async () => ({ value: {} }),
  });
  const { events, emit } = collect();
  const h = svc.open();
  const r = await svc.ask(h, '你好', emit);

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
  svc.cancel(null);   // 没有句柄：桥不被打扰
  assert.equal(taps.cancelled, undefined);
  const h = svc.open();
  await svc.ask(h, '你好', () => {});
  svc.cancel(h);
  assert.equal(taps.cancelled, true);
});

// ── 会话身份：本地不铸 id（2026-10-25 定案）────────────────────
// 病灶（2026-10-24 生产验收「发得太快了」）：bridgeAdapter 每轮自铸 sid
// （web-1、web-2…）⇒ 桥的「新问才受闸」把每一轮工具循环都当成新的一问。
// 当时的修法是「每个管理器会话铸一个稳定 sid 递下去」——那是在自造 id 上加层。
// 2026-10-25 换成：payload 根本不带会话标识。上游 identity 由桥侧那一场对话持有，
// 一轮工具循环与下一轮天然是同一场对话，无需我们告诉它。

test('会话身份：payload 不带自造 id（会话身份归上游）', async () => {
  const { bridge, taps } = fakeBridge([
    { ok: true, text: '我先搜一下\nsite_search，query=x' },
    { ok: true, text: '第一问答完' },
    { ok: true, text: '第二问答完' },
  ]);
  const svc = createAssistantClient({ bridge, tools: TOOLS, invoke: async () => ({ ok: true, value: '' }) });
  const a = svc.open();
  const b = svc.open();
  await svc.ask(a, '第一问', () => {});
  await svc.ask(b, '第二问', () => {});
  for (const call of taps.asks) {
    assert.equal(call.payload.sessionId, undefined, '不许再带自造 sessionId');
    assert.equal(call.payload.sessionKey, undefined, '不许再带自造 sessionKey');
  }
});

test('会话身份：两个句柄互相独立（多会话能力保留）', async () => {
  const { bridge, taps } = fakeBridge([
    { ok: true, text: 'A 的答案' },
    { ok: true, text: 'B 的答案' },
  ]);
  const svc = createAssistantClient({ bridge, tools: TOOLS, invoke: async () => ({ ok: true, value: '' }) });
  const a = svc.open();
  const b = svc.open();
  assert.notEqual(a, b, '两次 open 拿到不同句柄');
  const ra = await svc.ask(a, 'A 问', () => {});
  const rb = await svc.ask(b, 'B 问', () => {});
  assert.equal(ra.text, 'A 的答案');
  assert.equal(rb.text, 'B 的答案');
  assert.equal(taps.asks.length, 2);
});

// ── payload.tools 必须随每问递到上游（2026-10-25 生产验收）──────────
// 症状：上游回「我环境里没有 site_* 工具，但我知道它们存在」——教学文案到了，
// payload.tools 却是空数组：工具定义只进了本地工具会话（解析/执行用），
// 从没随 ask 递出去。roleA 头注释写明「tools 由站点侧每问现取填入」。
test('payload.tools：工具定义必须随 ask 递到桥（不许空数组）', async () => {
  const { bridge, taps } = fakeBridge([{ ok: true, text: '好' }]);
  const svc = createAssistantClient({ bridge, tools: TOOLS, invoke: async () => ({ ok: true, value: '' }) });
  const h = svc.open();
  await svc.ask(h, '你好', () => {});
  const t = taps.asks[0].payload.tools;
  assert.ok(Array.isArray(t), 'payload.tools 必须是数组');
  assert.equal(t.length, TOOLS.length, '工具数量必须与注册表一致');
  assert.deepEqual(t.map((x) => x.name).sort(), TOOLS.map((x) => x.name).sort());
  assert.ok(t[0].inputSchema, '每项要带 inputSchema（上游据此填参数）');
});

test('payload.tools：工具表变化时每问现取（SPA 换页后不复用旧清单）', async () => {
  const asks = [];
  const bridge = {
    async ask(pl) { asks.push(pl.tools.length); return { ok: true, text: '好' }; },
    cancel() {},
  };
  const live = [...TOOLS];
  const svc = createAssistantClient({ bridge, tools: live, invoke: async () => ({ ok: true, value: '' }) });
  const h = svc.open();
  await svc.ask(h, '第一问', () => {});
  live.push({ name: 'site_new', inputSchema: { type: 'object', properties: {} } });
  await svc.ask(h, '第二问', () => {});
  assert.equal(asks[0], live.length - 1, '第一问看到注册时的工具数');
  assert.equal(asks[1], live.length, '第二问看到新增后的数量（每问现取，不许缓存快照）');
});
