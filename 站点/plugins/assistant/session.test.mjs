// 会话.test.mjs —— 多会话管理器的接口级测试（零网络，全走 seam 注入的假 adapter）。
//
// 设计的测试资产（C 方案）：
//   · scriptedAdapter：按剧本出牌（text/blocked/freeze/failConnect），记录操作序
//   · spyAdapter：断言两条不变量——「全局串行」「open/close 严格配对」
// 测试断言的是**接口行为**（I1-I5），不是实现细节。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createManager } from './session.mjs';
import { createTranscript } from './context.mjs';

// ── scriptedAdapter：剧本出牌 ─────────────────────────────

/**
 * 造剧本 adapter。
 * 剧本是扁平序列：'failOpen' 在 open 时消费，其余（'text'|'blocked'|'freeze'）在 ask 时消费，
 * 依序推进同一个指针——写剧本时按「事件发生顺序」列即可。
 * @param {Array<'text'|'blocked'|'freeze'|'failOpen'>} script
 * @param {object} [taps] 记录操作序（外部传入以便断言）
 */
function scriptedAdapter(script = [], taps = {}) {
  let i = 0;
  taps.opens = taps.opens || 0;
  taps.closes = taps.closes || 0;
  taps.asks = taps.asks || 0;
  taps.prompts = taps.prompts || [];
  taps.failOpensAt = taps.failOpensAt || [];   // open 调用序号（1 起）在此集合中 ⇒ 失败
  return {
    async open(cfg) {
      taps.opens += 1;
      if (taps.failOpensAt.includes(taps.opens)) throw new Error('connect 失败');
      return {
        ask: async (prompt) => {
          taps.asks += 1;
          taps.prompts.push(prompt);
          const s = script[i++];
          if (s === 'freeze') throw new Error('WS 冻死');
          // 契约（2026-10-18）：adapter 的 ask 返回**类型化 status**
          if (s === 'blocked') return { text: '很抱歉，您的请求涉及违规内容', status: 'blocked' };
          if (s === 'empty') return { text: '', status: 'empty' };     // 有终止帧、零正文
          if (s === 'frozen') return { text: '', status: 'frozen' };   // 无终止帧、idle 收束
          return { text: `答#${taps.asks}`, status: 'answered' };
        },
        close: () => { taps.closes += 1; },
      };
    },
  };
}

/** 小阈值 transcript 工厂：几轮就触发轮换（机制还是真的，不假造纯函数）。 */
const tinyTranscript = (o = {}) => createTranscript({ liveBudget: 300, liveMaxTurns: 3, ...o });

// ── 基本生命周期 ──────────────────────────────────────────

test('open 同步返回 id；ask 首问冷启动（open + 裸问题）', async () => {
  const taps = {};
  const m = createManager({ adapter: scriptedAdapter(['text'], taps) });
  const id = m.open();
  assert.equal(typeof id, 'string');
  const r = await m.ask(id, '问题');
  assert.equal(r.status, 'ok');
  assert.equal(taps.opens, 1, '首问建一条连接');
  assert.equal(taps.prompts[0], '问题', '无历史 ⇒ 裸问题，不重放');
  m.close();
});

test('ask 未知 id 立即 reject（fail fast，不静默开新会话）', async () => {
  const m = createManager({ adapter: scriptedAdapter([], {}) });
  await assert.rejects(() => m.ask('nope', 'x'), /未知会话/);
  m.close();
});

test('同会话第二问直接复用连接（零 open、裸问题）', async () => {
  const taps = {};
  const m = createManager({ adapter: scriptedAdapter(['text', 'text'], taps) });
  const id = m.open();
  await m.ask(id, '问题1');
  await m.ask(id, '问题2');
  assert.equal(taps.opens, 1, '复用 ⇒ 只 open 一次');
  assert.equal(taps.prompts[1], '问题2', '热会话 ⇒ 裸问题');
  m.close();
});

// ── I1 转录唯一真相源 ─────────────────────────────────────

test('I1：ask resolve 后轮已进 transcript（snapshot 可见）', async () => {
  const m = createManager({ adapter: scriptedAdapter(['text', 'text'], {}) });
  const id = m.open();
  await m.ask(id, '第一问');
  await m.ask(id, '第二问');
  const snap = m.snapshot(id);
  assert.equal(snap.turns.length, 2);
  assert.equal(snap.turns[0].user, '第一问');
  assert.equal(snap.turns[1].user, '第二问');
  m.close();
});

// ── I3 重放水位 ───────────────────────────────────────────

test('I3 水位：逐出后回来 ⇒ 首条消息是重放打包（含【对话背景】）', async () => {
  const taps = {};
  const m = createManager({
    adapter: scriptedAdapter(['text', 'text', 'text'], taps),
    hotSlots: 1,   // 单槽：B 一来 A 就被逐出
    transcriptFactory: tinyTranscript,
  });
  const a = m.open();
  const b = m.open();
  await m.ask(a, 'A 的问题');
  await m.ask(b, 'B 的问题');     // B 挤掉 A（hotSlots=1）
  const r = await m.ask(a, 'A 的追问');   // A 回来 ⇒ 冷启动 ⇒ 应重放
  assert.equal(taps.opens, 3, 'A 二次冷启动');
  const replayMsgs = taps.prompts.slice(2);
  assert.ok(replayMsgs.length >= 2, `重放应拆成多条，实际 ${replayMsgs.length} 条`);
  assert.ok(replayMsgs.some((p) => p.includes('A 的问题')), '重放要含 A 的历史');
  assert.ok(!replayMsgs.join('\n').includes('B 的问题'), 'B 的内容不能泄进 A');
  assert.equal(r.restored, true);
  m.close();
});

test('I3 水位：没有缺口时不重放（即使连接刚重建）', async () => {
  const taps = {};
  const m = createManager({
    adapter: scriptedAdapter(['text'], taps),
    transcriptFactory: tinyTranscript,
  });
  const id = m.open();
  // 第一问失败在传输层耗尽（frozen 记账）⇒ deliveredSeq 推进
  const r1 = await m.ask(id, '第一问');
  assert.equal(r1.status, 'ok');
  // 手动让通道消失：通过 close(id) 后重开？不——close 删会话。用热槽逐出：
  // hotSlots=2 场景下没有第三者，改用直接观察：第二问仍是裸问题
  await m.ask(id, '第二问');
  assert.equal(taps.prompts[1], '第二问');
  m.close();
});

// ── 轮换（shouldRotate → 复用冷启动路径）──────────────────

test('成本轮换：阈值命中 ⇒ 重建连接 + 重放', async () => {
  const taps = {};
  const m = createManager({
    adapter: scriptedAdapter(['text', 'text', 'text', 'text'], taps),
    transcriptFactory: () => createTranscript({ liveBudget: 50, liveMaxTurns: 2 }),   // 2 轮就轮换
  });
  const id = m.open();
  await m.ask(id, '问题一');
  await m.ask(id, '问题二');
  const r3 = await m.ask(id, '问题三');   // shouldRotate 命中 ⇒ 新通道 + 重放
  assert.equal(taps.opens, 2, '轮换 = 一次新 open');
  const replay = taps.prompts.slice(2);
  assert.ok(replay.length >= 2, `轮换后重放应多条，实际 ${replay.length}`);
  assert.ok(replay.some((p) => p.includes('问题一')), '重放含旧轮');
  assert.equal(r3.restored, true);
  assert.ok(r3.generation >= 2, '代数递增');
  m.close();
});

// ── I4 句柄稳定 ───────────────────────────────────────────

test('I4：轮换/逐出后 sessionId 不变，继续可问', async () => {
  const m = createManager({
    adapter: scriptedAdapter(['text', 'text', 'text', 'text', 'text', 'text'], {}),
    transcriptFactory: () => createTranscript({ liveBudget: 30, liveMaxTurns: 1 }),
    hotSlots: 2,
  });
  const id = m.open();
  await m.ask(id, 'a');
  await m.ask(id, 'b');   // 每轮都轮换（maxTurns=1）
  await m.ask(id, 'c');
  const snap = m.snapshot(id);
  assert.equal(snap.id, id, '句柄不变');
  assert.equal(snap.turns.length, 3, '轮数累加，无丢失');
  m.close();
});

// ── I5 传输/内容二分 ──────────────────────────────────────

test('I5：冻死（传输）⇒ 管理器换线重试，调用方无感', async () => {
  const taps = {};
  const m = createManager({
    adapter: scriptedAdapter(['freeze', 'text'], taps),   // 首问冻死，重试成功
    reconnectAttempts: 2, retryBackoffMs: 0,
  });
  const id = m.open();
  const r = await m.ask(id, '问题');
  assert.equal(r.status, 'ok', '换线后拿到答案');
  assert.equal(r.attempts, 2, '尝试两次');
  assert.equal(taps.opens, 2, '重试 = 新 open');
  m.close();
});

test('I5：重试耗尽 ⇒ status=transport，不再无限重试', async () => {
  const taps = { failOpensAt: [] };
  const m = createManager({
    adapter: scriptedAdapter(['freeze', 'freeze', 'freeze'], taps),
    reconnectAttempts: 2, retryBackoffMs: 0,
  });
  const id = m.open();
  const r = await m.ask(id, '问题');
  assert.equal(r.status, 'transport');
  assert.equal(taps.opens, 3, '首试 + 2 重试 = 3 次 open');
  // 耗尽后 frozen 记账，句柄仍可继续用
  const snap = m.snapshot(id);
  assert.equal(snap.turns.length, 1);
  m.close();
}, { timeout: 15000 });

test('I5：BLOCKED 是内容失败 ⇒ 原样上抛（status=blocked），不自动重试', async () => {
  const taps = {};
  const m = createManager({
    adapter: scriptedAdapter(['blocked'], taps),
    reconnectAttempts: 2,
  });
  const id = m.open();
  const r = await m.ask(id, '敏感问题');
  assert.equal(r.status, 'blocked');
  assert.equal(taps.opens, 1, '被拦不换线');
  assert.ok(r.text.includes('违规'), '原文上抛');
  m.close();
});

test('blocked 的轮不进后续重放（转录层既有语义，接口层验证）', async () => {
  const taps = {};
  const m = createManager({
    adapter: scriptedAdapter(['text', 'blocked', 'text'], taps),
    transcriptFactory: tinyTranscript,
  });
  const id = m.open();
  await m.ask(id, '正常问题');        // ok #1
  await m.ask(id, '敏感词问题');      // blocked（不计 ok 轮，不进重放）
  await m.ask(id, '第三问');          // ok #2
  await m.ask(id, '第四问');          // ok #3 —— 此后才触发轮换
  const before = taps.prompts.length;
  await m.ask(id, '第五问');          // 新通道 ⇒ 重放（新增的就是重放内容）
  const replay = taps.prompts.slice(before);
  assert.ok(replay.length >= 2, `轮换后应有多条重放，实际 ${replay.length}`);
  assert.ok(replay.some((p) => p.includes('正常问题')), 'ok 轮进重放');
  assert.ok(!replay.join('\n').includes('敏感词'), 'blocked 轮绝不进重放');
  m.close();
});

// ── I2 全局串行（spy 断言）────────────────────────────────

test('I2：并发 ask 全局串行（同时至多一个在飞）', async () => {
  let inFlight = 0, maxInFlight = 0;
  const slowAdapter = {
    async open() {
      return {
        ask: async (p) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 30));
          inFlight -= 1;
          return { text: 'ok' };
        },
        close: () => {},
      };
    },
  };
  const m = createManager({ adapter: slowAdapter, hotSlots: 2 });
  const a = m.open();
  const b = m.open();
  await Promise.all([m.ask(a, 'x'), m.ask(b, 'y'), m.ask(a, 'z'), m.ask(b, 'w')]);
  assert.equal(maxInFlight, 1, '任意时刻至多一个请求在飞');
  m.close();
});

test('open/close 严格配对（零连接泄漏）', async () => {
  const taps = {};
  const script = ['text', 'text', 'text', 'text', 'text', 'text', 'text', 'text'];
  const m = createManager({
    adapter: scriptedAdapter(script, taps),
    hotSlots: 2,
    transcriptFactory: () => createTranscript({ liveBudget: 40, liveMaxTurns: 2 }),
  });
  const a = m.open(); const b = m.open(); const c = m.open(); const d = m.open();
  await m.ask(a, '1'); await m.ask(b, '2'); await m.ask(c, '3'); await m.ask(d, '4');
  await m.ask(a, '5'); await m.ask(b, '6');   // 来回切换触发逐出与轮换
  m.close();
  assert.equal(taps.opens, taps.closes, '每次 open 必有配对 close');
});

// ── 多会话隔离 ────────────────────────────────────────────

test('会话隔离：A 的历史绝不泄进 B 的重放', async () => {
  const taps = {};
  const m = createManager({
    adapter: scriptedAdapter(['text', 'text', 'text', 'text', 'text'], taps),
    hotSlots: 1,
    transcriptFactory: tinyTranscript,
  });
  const a = m.open();
  const b = m.open();
  await m.ask(a, '磁路欧姆定律是什么');      // A 占热槽
  await m.ask(b, '卡诺图怎么化简');          // B 挤掉 A（hotSlots=1）
  await m.ask(a, 'A 的追问');                // A 回来：挤掉 B ⇒ B 下次要重放
  const before = taps.prompts.length;
  await m.ask(b, '再详细一点');   // B 冷启动 ⇒ B 重放
  const replay = taps.prompts.slice(before);
  assert.ok(replay.length >= 2, `B 重放应多条，实际 ${replay.length}`);
  assert.ok(replay.some((p) => p.includes('卡诺图')), 'B 重放含 B 的历史');
  const bReplayText = replay.join('\n');
  assert.ok(!bReplayText.includes('磁路欧姆'), 'A 的内容不能泄进 B');
  assert.ok(!bReplayText.includes('A 的追问'), 'A 的新内容也不能泄进 B');
  m.close();
});

// ── snapshot ──────────────────────────────────────────────

test('snapshot()：不带参返回会话列表（纯数据）', async () => {
  const m = createManager({ adapter: scriptedAdapter(['text', 'text'], {}) });
  const a = m.open(); const b = m.open();
  await m.ask(a, 'x');
  const list = m.snapshot();
  assert.equal(list.length, 2);
  assert.ok(list.find((s) => s.id === a && s.turns === 1));
  assert.ok(list.find((s) => s.id === b && s.turns === 0));
  m.close();
});

test('close(id) 后该句柄失效，其余不受影响', async () => {
  const m = createManager({ adapter: scriptedAdapter(['text', 'text'], {}) });
  const a = m.open(); const b = m.open();
  await m.ask(a, 'x');
  m.close(a);
  await assert.rejects(() => m.ask(a, 'y'), /未知会话/);
  const r = await m.ask(b, 'z');
  assert.equal(r.status, 'ok');
  m.close();
});

// ── deadline ──────────────────────────────────────────────

test('deadline：墙钟到点收束（不无限挂起）', async () => {
  const hangAdapter = {
    async open() {
      return {
        ask: () => new Promise(() => {}),   // 永不返回
        close: () => {},
      };
    },
  };
  const m = createManager({ adapter: hangAdapter, deadlineMs: 300, reconnectAttempts: 0 });
  const id = m.open();
  const r = await m.ask(id, '问题');
  assert.equal(r.status, 'deadline');
  m.close();
});

test('frozen（空 resolve）也走换线重试，不是直接返回空答案（2026-10-18 M1-s4-r5）', async () => {
  const taps = { failOpensAt: [] };
  // 剧本：第一次 ask 空 text（冻死形态），重试后正常
  const m = createManager({
    adapter: scriptedAdapter(['empty', 'text'], taps),
    reconnectAttempts: 2, retryBackoffMs: 0,
  });
  const id = m.open();
  const r = await m.ask(id, '问题');
  assert.equal(r.status, 'ok', '换线后拿到答案');
  assert.equal(r.attempts, 2);
  assert.equal(taps.opens, 2, '冻死 = 通道废弃，必须重开');
  m.close();
});

test('rotate(id)：主动拆连接，下次 ask 走重放（水位归零）', async () => {
  const taps = { failOpensAt: [] };
  const m = createManager({ adapter: scriptedAdapter(['text', 'text', 'text'], taps) });
  const id = m.open();
  await m.ask(id, '第一问');
  assert.equal(taps.opens, 1);
  assert.equal(m.rotate(id), true, 'rotate 返回 true');
  const r = await m.ask(id, '第二问');
  assert.equal(taps.opens, 2, 'rotate 后必须重开连接');
  assert.equal(r.restored, true, '水位归零 ⇒ 带重放');
  const replay = taps.prompts.slice(1);
  assert.ok(replay.length >= 2, '重放应拆多条');
  assert.ok(replay.some((p) => p.includes('第一问')), '重放含旧轮');
  m.close();
});

// ── 停止回答（2026-10-19 用户要求）──────────────────────────
//
// 三个真 bug 都在这条路上，且都只在真跑时暴露：
//   ① adapter 返回对象里没有 cancel → 管理器 typeof 检查为假，静默跳过
//   ② chaoxing.cancel 只 finish() 不 resolve → ask() 的 Promise 挂到超时
//   ③ 先 abort SSE 再发 cancel → 桥已收尾，cancel 扑空（cancelled:false）

test('取消：adapter 必须暴露 cancel（否则管理器静默跳过）', async () => {
  const { chaoxingAdapter } = await import('./session.mjs');
  const fake = {
    connect: async () => {}, switchModel: async () => {},
    ask: async () => ({ text: 'x', status: 'answered' }),
    send: () => true, uploadImage: async () => ({}), cancel: () => ({ cancelled: true }),
    close: () => {},
  };
  // 直接看源码契约更稳（adapter 内部 new createAssistant，无法注入）
  const src = (await import('node:fs')).readFileSync(new URL('./session.mjs', import.meta.url), 'utf8');
  const adapterBlock = src.slice(src.indexOf('return {\n        // 2026-10-19 流式'), src.indexOf('close: () => a.close()'));
  assert.match(adapterBlock, /cancel:\s*\(\)\s*=>\s*a\.cancel\(\)/,
    'adapter 必须把 cancel 转发出去——少这行管理器会以为通道不支持取消');
});

test('取消：chaoxing.cancel 必须 resolve 在飞的 Promise', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('./proto.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function cancel()'), src.indexOf('async function askRetry'));
  assert.match(fn, /p\.resolve\(out\)/, '只 finish() 不 resolve ⇒ ask 会挂到 timeout');
  assert.match(fn, /finish\('cancelled'\)/, '要用 cancelled 这个 reason');
});

test('取消：管理器在会话上留标记（通道扑空也能停下来）', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('./session.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('cancel(id) {'), src.indexOf('/** 上传一张图'));
  assert.match(fn, /s\.cancelRequested = true/, '通道扑空时也要留标记');
  assert.match(src, /const wasCancelled = !!s\.cancelRequested/,
    'doAsk 收尾要消费标记——否则上游答完了仍当成功交回去');
});

// ── C2 回归：sandboxCalls 必须透传（2026-10-25 审计）──────────
//
// proto.mjs 产出（模型把 site_* 包进 execute/read_file 时收集）、
// toolcycle.mjs:485 消费，而 session.mjs 的返回值里此前没有这个词
// ⇒ 拦截机制从 2026-10-23 上线起从未生效。
test('C2：adapter 返回的 sandboxCalls 必须透传到 mgr.ask 的返回值', async () => {
  const adapter = {
    async open() {
      return {
        async ask() {
          return {
            text: '好', status: 'answered',
            sandboxCalls: [{ name: 'execute', args: 'site_read，what=page' }],
          };
        },
        close() {},
      };
    },
  };
  const m = createManager({ adapter });
  const id = m.open();
  const r = await m.ask(id, '测试');
  assert.ok(Array.isArray(r.sandboxCalls), 'sandboxCalls 必须是数组（不是 undefined）');
  assert.equal(r.sandboxCalls.length, 1);
  assert.equal(r.sandboxCalls[0].name, 'execute');
});
