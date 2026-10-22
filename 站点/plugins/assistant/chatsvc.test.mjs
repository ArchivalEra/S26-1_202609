// 聊天服务.test.mjs —— 模型驱动层的接口测试（零网络，全走 seam 注入）。
//
// 测的是「emit 契约」：
//   · 恰好一次 done 或 error
//   · delta 只来自最后一轮
//   · 工具执行完有 tool 事件
//   · 传输层故障转成 error，不抛

import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatService } from './chatsvc.mjs';

/** 假管理器：按剧本出牌。 */
function fakeMgr(script, taps = {}) {
  taps.opened = 0;
  taps.asks = [];
  let i = 0;
  return {
    open(cfg) { taps.opened += 1; taps.lastCfg = cfg; return 's' + taps.opened; },
    async ask(sid, text, opts) {
      taps.asks.push({ sid, text, opts });
      const s = script[i++] || 'answer:默认';
      if (s === 'frozen') return { text: '', status: 'frozen', calls: [] };
      if (s === 'transport') return { text: '', status: 'transport', calls: [] };
      if (s.startsWith('call:')) {
        // 模拟「模型想调工具」：工具会话会解析并执行，然后下一轮再问
        return { text: `site_read，what=page`, status: 'ok', calls: [] };
      }
      if (s === 'stream') {
        // 模拟流式：调 onChunk 三次
        if (opts && typeof opts.onChunk === 'function') {
          opts.onChunk('第一段');
          opts.onChunk('第二段');
        }
        return { text: '第一段第二段', status: 'ok', calls: [] };
      }
      return { text: s.replace(/^answer:/, ''), status: 'ok', calls: [] };
    },
    snapshot() { return { id: 's1', turns: 1 }; },
    close() {},
  };
}

const TOOLS = [
  { name: 'site_read', description: '读正文', inputSchema: { type: 'object', properties: { what: { type: 'string' } } } },
];

const collect = () => {
  const events = [];
  return { events, emit: (e) => events.push(e) };
};

// ── 基本 ────────────────────────────────────────────────────

test('ask：成功时恰好一次 done，且带最终文本', async () => {
  const mgr = fakeMgr(['answer:这是回答']);
  const svc = createChatService({ mgr, tools: TOOLS, invoke: async () => ({ value: {} }) });
  const { events, emit } = collect();
  const r = await svc.ask('c1', '你好', emit);

  assert.equal(r.status, 'ok');
  const dones = events.filter((e) => e.type === 'done');
  assert.equal(dones.length, 1, '必须恰好一次 done');
  assert.equal(dones[0].text, '这是回答');
  assert.equal(events.filter((e) => e.type === 'error').length, 0);
});

test('ask：非流式时把完整答案补成一个 delta（前端文本与 done.text 一致）', async () => {
  const mgr = fakeMgr(['answer:完整答案']);
  const svc = createChatService({ mgr, tools: TOOLS, invoke: async () => ({}) });
  const { events, emit } = collect();
  await svc.ask('c1', '问', emit);

  const deltas = events.filter((e) => e.type === 'delta');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].text, '完整答案');
});

// ── 流式 ────────────────────────────────────────────────────

test('ask：流式时 delta 逐段到达（不重复补发完整答案）', async () => {
  const mgr = fakeMgr(['stream']);
  // rounds:1 ⇒ 第一轮即最后一轮，onChunk 生效
  const svc = createChatService({ mgr, tools: TOOLS, rounds: 1, invoke: async () => ({}) });
  const { events, emit } = collect();
  await svc.ask('c1', '问', emit);

  const deltas = events.filter((e) => e.type === 'delta');
  assert.equal(deltas.length, 2, '两段增量');
  assert.equal(deltas.map((d) => d.text).join(''), '第一段第二段');
});

test('ask：delta 只在最后一轮出现（工具循环的过程话不推）', async () => {
  // 第 1 轮模型要调工具，第 2 轮（最后一轮）才回答
  const mgr = fakeMgr(['call:x', 'answer:最终答案']);
  const svc = createChatService({
    mgr, tools: TOOLS, rounds: 2,
    invoke: async () => ({ value: { ok: true, text: '页面内容' } }),
  });
  const { events, emit } = collect();
  await svc.ask('c1', '读一下', emit);

  const deltas = events.filter((e) => e.type === 'delta');
  // 第 1 轮的 "site_read，what=page" 不该变成 delta
  assert.ok(deltas.every((d) => !d.text.includes('site_read')), '过程话不该进 delta');
});

// ── 工具事件 ────────────────────────────────────────────────

test('ask：工具执行完 emit 一个 tool 事件', async () => {
  const mgr = fakeMgr(['call:x', 'answer:完成']);
  const svc = createChatService({
    mgr, tools: TOOLS, rounds: 2,
    invoke: async () => ({ value: { ok: true } }),
  });
  const { events, emit } = collect();
  await svc.ask('c1', '读', emit);

  const tools = events.filter((e) => e.type === 'tool');
  assert.ok(tools.length >= 1, '应至少有一个 tool 事件');
  assert.equal(tools[0].name, 'site_read');
  assert.equal(tools[0].ok, true);
});

test('ask：工具失败时 tool 事件带 ok:false', async () => {
  const mgr = fakeMgr(['call:x', 'answer:好吧']);
  const svc = createChatService({
    mgr, tools: TOOLS, rounds: 2,
    invoke: async () => { throw new Error('页面失败'); },
  });
  const { events, emit } = collect();
  await svc.ask('c1', '读', emit);

  const tools = events.filter((e) => e.type === 'tool');
  assert.equal(tools[0].ok, false);
  assert.match(tools[0].error, /页面失败/);
});

// ── 故障 ────────────────────────────────────────────────────

test('ask：传输层故障转成 error 事件，不抛异常', async () => {
  const mgr = fakeMgr(['frozen']);
  const svc = createChatService({ mgr, tools: TOOLS, invoke: async () => ({}) });
  const { events, emit } = collect();
  const r = await svc.ask('c1', '问', emit);

  assert.equal(r.status, 'frozen');
  const errs = events.filter((e) => e.type === 'error');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].reason, 'frozen');
  assert.equal(events.filter((e) => e.type === 'done').length, 0);
});

test('ask：run 抛异常也转成 error', async () => {
  const mgr = {
    open: () => 's1',
    async ask() { throw new Error('炸了'); },
  };
  const svc = createChatService({ mgr, tools: TOOLS, invoke: async () => ({}) });
  const { events, emit } = collect();
  const r = await svc.ask('c1', '问', emit);
  assert.equal(r.status, 'error');
  assert.equal(events.filter((e) => e.type === 'error').length, 1);
});

// ── 会话管理 ────────────────────────────────────────────────

test('同一 sessionId 复用同一个管理器会话', async () => {
  const taps = {};
  const mgr = fakeMgr(['answer:a', 'answer:b'], taps);
  const svc = createChatService({ mgr, tools: TOOLS, invoke: async () => ({}) });
  await svc.ask('c1', '第一问', () => {});
  await svc.ask('c1', '第二问', () => {});
  assert.equal(taps.opened, 1, '不该重复 open');
});

test('不同 sessionId 各自开会话（上下文隔离）', async () => {
  const taps = {};
  const mgr = fakeMgr(['answer:a', 'answer:b'], taps);
  const svc = createChatService({ mgr, tools: TOOLS, invoke: async () => ({}) });
  await svc.ask('c1', '问', () => {});
  await svc.ask('c2', '问', () => {});
  assert.equal(taps.opened, 2);
});

test('snapshot：无会话返回 null，有会话返回管理器快照', async () => {
  const mgr = fakeMgr(['answer:a']);
  const svc = createChatService({ mgr, tools: TOOLS, invoke: async () => ({}) });
  assert.equal(svc.snapshot('nope'), null);
  await svc.ask('c1', '问', () => {});
  assert.ok(svc.snapshot('c1'));
});

test('setTools：更新后下次 ask 用新清单', async () => {
  const taps = {};
  const mgr = fakeMgr(['answer:a', 'answer:b'], taps);
  const svc = createChatService({ mgr, tools: TOOLS, invoke: async () => ({}) });
  svc.setTools([{ name: 'site_index', description: '地图', inputSchema: { type: 'object', properties: {} } }]);
  await svc.ask('c1', '问', () => {});
  // 提示词里应出现新工具名
  assert.match(taps.asks[0].text, /site_index/);
});

// ── 契约 ────────────────────────────────────────────────────

test('createChatService：缺 mgr / invoke 时明确报错', () => {
  assert.throws(() => createChatService({ invoke: () => {} }), /缺少 mgr/);
  assert.throws(() => createChatService({ mgr: {} }), /缺少 invoke/);
});

test('emit 不是函数时不崩（调用方可省略）', async () => {
  const mgr = fakeMgr(['answer:a']);
  const svc = createChatService({ mgr, tools: TOOLS, invoke: async () => ({}) });
  const r = await svc.ask('c1', '问');   // 不传 emit
  assert.equal(r.status, 'ok');
});
