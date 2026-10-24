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
  assert.match(taps.asks[1].payload.text, /已经执行了。结果如下/);
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

// ── 会话身份透传（2026-10-24 生产验收「发得太快了」修复）──────────────
// 病灶：bridgeAdapter 的 ask 不带会话身份 ⇒ A 侧薄桥每轮自铸 sid（web-1、web-2…）
// ⇒ roleB 的「新问才受闸」把每一轮工具循环都当成新的一问 ⇒ 第二轮起全被
// 3 秒速率闸拒掉。修复：每个管理器会话一个稳定 sid 随每轮 payload 递下去。

test('会话身份透传：同一会话的每轮 ask 带同一个 sessionId，换会话才换', async () => {
  // 剧本：第一问两轮（工具循环形态——调用行在**终态文本**里，非末轮的 delta
  // 会被工具会话剥掉不进转录），第二问一轮
  const { bridge, taps } = fakeBridge([
    { ok: true, text: '我先搜一下\nsite_search，query=x' },
    { ok: true, text: '第一问答完' },
    { ok: true, text: '第二问答完' },
  ]);
  const svc = createAssistantClient({ bridge, tools: TOOLS, invoke: async () => ({ ok: true, value: '' }) });
  await svc.ask('conv-A', '第一问', () => {});
  await svc.ask('conv-B', '第二问', () => {});
  const sids = taps.asks.map((a) => a.payload.sessionId);
  assert.ok(sids.every((s) => typeof s === 'string' && s), '每轮 payload 都要带 sessionId');
  assert.equal(new Set(sids).size, 2, '两个会话 ⇒ 恰好两个 sid');
  assert.equal(sids[0], sids[1], '同一会话的多轮必须同一个 sid（roleB 闸的续轮放行前提）');
  assert.notEqual(sids[0], sids[2], '新会话必须新 sid（速率闸对连发新问的限速语义）');
});

test('会话身份透传：sid 形态可识别且不含上游信息', async () => {
  const { bridge, taps } = fakeBridge([{ ok: true, text: '好' }]);
  const svc = createAssistantClient({ bridge, tools: TOOLS, invoke: async () => ({ ok: true, value: '' }) });
  await svc.ask('c1', '你好', () => {});
  assert.match(taps.asks[0].payload.sessionId, /^site-\d+-[a-z0-9]{6}$/, 'sid = site-序号-每页随机量（刷新即新 id，污染会话甩得掉）');
});

// ── payload.tools 必须随每问递到上游（2026-10-25 生产验收）──────────
// 症状：上游回「我环境里没有 site_* 工具，但我知道它们存在」——教学文案到了，
// payload.tools 却是空数组：工具定义只进了本地工具会话（解析/执行用），
// 从没随 ask 递出去。roleA 头注释写明「tools 由站点侧每问现取填入」。
test('payload.tools：工具定义必须随 ask 递到桥（不许空数组）', async () => {
  const { bridge, taps } = fakeBridge([{ ok: true, text: '好' }]);
  const svc = createAssistantClient({ bridge, tools: TOOLS, invoke: async () => ({ ok: true, value: '' }) });
  await svc.ask('c1', '你好', () => {});
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
  await svc.ask('c1', '第一问', () => {});
  live.push({ name: 'site_new', inputSchema: { type: 'object', properties: {} } });
  await svc.ask('c1', '第二问', () => {});
  assert.equal(asks[0], live.length - 1, '第一问看到注册时的工具数');
  assert.equal(asks[1], live.length, '第二问看到新增后的数量（每问现取，不许缓存快照）');
});
