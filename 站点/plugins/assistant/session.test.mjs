// session.test.mjs —— 一场对话的生命周期管理（零网络，全走 seam 注入的假 adapter）。
//
// 2026-10-25 重写：管理器从「N 个会话的 Map」变成「一场对话」——本地不再造任何
// 会话 id（面板 sessionKey / 线上 sessionId / Map 键 / s1 四层全删），
// 身份只来自上游 conversationId。所以原来测「多会话隔离 / 热槽逐出 / 句柄稳定」
// 的那批用例，连同它们服务的需求一起消失了。
//
// 留下并加固的是**真正的不变量**：
//   I1 转录唯一真相源（ask resolve 前必已落账）
//   I2 全局串行（同一时刻至多一个请求在飞）
//   I3 重放水位（通道换了要补历史；没缺口不补）
//   I5 传输/内容二分（冻死换线重试；BLOCKED 原样上抛）
//   I6 上游身份只读透出（conversationId 来自上游，不是我们造的）

import test from 'node:test';
import assert from 'node:assert/strict';
import { createManager } from './session.mjs';
import { createTranscript } from './context.mjs';

// ── scriptedAdapter：剧本出牌 ─────────────────────────────

/**
 * 造剧本 adapter。
 * 剧本是扁平序列：'failOpen' 在 open 时消费，其余（'text'|'blocked'|'freeze'|'empty'）
 * 在 ask 时消费，依序推进同一个指针——写剧本时按「事件发生顺序」列即可。
 * @param {Array<'text'|'blocked'|'freeze'|'empty'|'failOpen'>} script
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
        // 上游真名：只读透出（本测试里造一个固定值，验证「我们只转发、不生产」）
        conversationId: () => taps.upstreamConversationId || null,
        close: () => { taps.closes += 1; },
      };
    },
  };
}

/** 小阈值 transcript 工厂：几轮就触发轮换（机制还是真的，不假造纯函数）。 */
const tinyTranscript = (o = {}) => createTranscript({ liveBudget: 300, liveMaxTurns: 3, ...o });

// ── 基本生命周期 ──────────────────────────────────────────

test('ask 首问冷启动（open + 裸问题）', async () => {
  const taps = {};
  const m = createManager({ adapter: scriptedAdapter(['text'], taps) });
  const h = m.open();
  const r = await m.ask(h, '问题');
  assert.equal(r.status, 'ok');
  assert.equal(taps.opens, 1, '首问建一条连接');
  assert.equal(taps.prompts[0], '问题', '无历史 ⇒ 裸问题，不重放');
  m.close();
});

test('第二问直接复用连接（零 open、裸问题）', async () => {
  const taps = {};
  const m = createManager({ adapter: scriptedAdapter(['text', 'text'], taps) });
  const h = m.open();
  await m.ask(h, '问题1');
  await m.ask(h, '问题2');
  assert.equal(taps.opens, 1, '复用 ⇒ 只 open 一次');
  assert.equal(taps.prompts[1], '问题2', '热会话 ⇒ 裸问题');
  m.close();
});

// ── I1 转录唯一真相源 ─────────────────────────────────────

test('I1：ask resolve 后轮已进 transcript（snapshot 可见）', async () => {
  const m = createManager({ adapter: scriptedAdapter(['text', 'text'], {}) });
  const h = m.open();
  await m.ask(h, '第一问');
  await m.ask(h, '第二问');
  const snap = m.snapshot(h);
  assert.equal(snap.turns.length, 2);
  assert.equal(snap.turns[0].user, '第一问');
  assert.equal(snap.turns[1].user, '第二问');
  m.close();
});

// ── I3 重放水位 ───────────────────────────────────────────

test('I3 水位：rotate 后回来 ⇒ 首条消息是重放打包（含旧轮）', async () => {
  const taps = {};
  const m = createManager({
    adapter: scriptedAdapter(['text', 'text', 'text'], taps),
    transcriptFactory: tinyTranscript,
  });
  const h = m.open();
  await m.ask(h, 'A 的问题');
  assert.equal(taps.opens, 1);
  assert.equal(m.rotate(h), true, 'rotate 返回 true');
  const r = await m.ask(h, 'A 的追问');
  assert.equal(taps.opens, 2, 'rotate 后必须重开连接');
  const replayMsgs = taps.prompts.slice(1);
  assert.ok(replayMsgs.length >= 2, `重放应拆成多条，实际 ${replayMsgs.length} 条`);
  assert.ok(replayMsgs.some((p) => p.includes('A 的问题')), '重放要含历史');
  assert.equal(r.restored, true);
  m.close();
});

test('I3 水位：没有缺口时不重放（即使连接刚重建）', async () => {
  const taps = {};
  const m = createManager({
    adapter: scriptedAdapter(['text'], taps),
    transcriptFactory: tinyTranscript,
  });
  const h = m.open();
  const r1 = await m.ask(h, '第一问');
  assert.equal(r1.status, 'ok');
  await m.ask(h, '第二问');
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
  const h = m.open();
  await m.ask(h, '问题一');
  await m.ask(h, '问题二');
  const r3 = await m.ask(h, '问题三');   // shouldRotate 命中 ⇒ 新通道 + 重放
  assert.equal(taps.opens, 2, '轮换 = 一次新 open');
  const replay = taps.prompts.slice(2);
  assert.ok(replay.length >= 2, `轮换后重放应多条，实际 ${replay.length}`);
  assert.ok(replay.some((p) => p.includes('问题一')), '重放含旧轮');
  assert.equal(r3.restored, true);
  assert.ok(r3.generation >= 2, '代数递增');
  m.close();
});

// ── I5 传输/内容二分 ──────────────────────────────────────

test('I5：冻死（传输）⇒ 管理器换线重试，调用方无感', async () => {
  const taps = {};
  const m = createManager({
    adapter: scriptedAdapter(['freeze', 'text'], taps),   // 首问冻死，重试成功
    reconnectAttempts: 2, retryBackoffMs: 0,
  });
  const h = m.open();
  const r = await m.ask(h, '问题');
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
  const h = m.open();
  const r = await m.ask(h, '问题');
  assert.equal(r.status, 'transport');
  assert.equal(taps.opens, 3, '首试 + 2 重试 = 3 次 open');
  // 耗尽后 frozen 记账，仍可继续用
  const snap = m.snapshot(h);
  assert.equal(snap.turns.length, 1);
  m.close();
}, { timeout: 15000 });

test('I5：BLOCKED 是内容失败 ⇒ 原样上抛（status=blocked），不自动重试', async () => {
  const taps = {};
  const m = createManager({
    adapter: scriptedAdapter(['blocked'], taps),
    reconnectAttempts: 2,
  });
  const h = m.open();
  const r = await m.ask(h, '敏感问题');
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
  const h = m.open();
  await m.ask(h, '正常问题');        // ok #1
  await m.ask(h, '敏感词问题');      // blocked（不计 ok 轮，不进重放）
  await m.ask(h, '第三问');          // ok #2
  await m.ask(h, '第四问');          // ok #3 —— 此后才触发轮换
  const before = taps.prompts.length;
  await m.ask(h, '第五问');          // 新通道 ⇒ 重放（新增的就是重放内容）
  const replay = taps.prompts.slice(before);
  assert.ok(replay.length >= 2, `轮换后应有多条重放，实际 ${replay.length}`);
  assert.ok(replay.some((p) => p.includes('正常问题')), 'ok 轮进重放');
  assert.ok(!replay.join('\n').includes('敏感词'), 'blocked 轮绝不进重放');
  m.close();
});

// ── I2 全局串行 ───────────────────────────────────────────

test('I2：并发 ask 全局串行（同时至多一个在飞）', async () => {
  let inFlight = 0, maxInFlight = 0;
  const slowAdapter = {
    async open() {
      return {
        ask: async () => {
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
  const m = createManager({ adapter: slowAdapter });
  const h = m.open();
  await Promise.all([m.ask(h, 'x'), m.ask(h, 'y'), m.ask(h, 'z'), m.ask(h, 'w')]);
  assert.equal(maxInFlight, 1, '任意时刻至多一个请求在飞');
  m.close();
});

test('open/close 严格配对（零连接泄漏）', async () => {
  const taps = {};
  const script = ['text', 'text', 'text', 'text', 'text', 'text', 'text', 'text'];
  const m = createManager({
    adapter: scriptedAdapter(script, taps),
    transcriptFactory: () => createTranscript({ liveBudget: 40, liveMaxTurns: 2 }),
  });
  const h = m.open();
  await m.ask(h, '1'); await m.ask(h, '2'); await m.ask(h, '3'); await m.ask(h, '4');
  m.close();
  assert.equal(taps.opens, taps.closes, '每次 open 必有配对 close');
});

// ── snapshot ──────────────────────────────────────────────

test('snapshot()：纯数据，带上游 conversationId', async () => {
  const taps = { upstreamConversationId: 'abc123def456' };
  const m = createManager({ adapter: scriptedAdapter(['text'], taps) });
  const h = m.open();
  await m.ask(h, 'x');
  const snap = m.snapshot(h);
  assert.equal(snap.turns.length, 1);
  assert.equal(snap.conversationId, 'abc123def456', 'conversationId 来自上游，不是我们造的');
  m.close();
});

test('conversationId 未连上时为 null（我们绝不自己造一个）', async () => {
  const m = createManager({ adapter: scriptedAdapter([], {}) });
  const h = m.open();
  assert.equal(h.conversationId, null, '没有通道就没有身份——不许编');
  assert.equal(m.find(null), null, '空 id 找不到任何会话');
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
  const h = m.open();
  const r = await m.ask(h, '问题');
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
  const h = m.open();
  const r = await m.ask(h, '问题');
  assert.equal(r.status, 'ok', '换线后拿到答案');
  assert.equal(r.attempts, 2);
  assert.equal(taps.opens, 2, '冻死 = 通道废弃，必须重开');
  m.close();
});

test('rotate()：主动拆连接，下次 ask 走重放（水位归零）', async () => {
  const taps = { failOpensAt: [] };
  const m = createManager({ adapter: scriptedAdapter(['text', 'text', 'text'], taps) });
  const h = m.open();
  await m.ask(h, '第一问');
  assert.equal(taps.opens, 1);
  assert.equal(m.rotate(h), true, 'rotate 返回 true');
  const r = await m.ask(h, '第二问');
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

test('取消：管理器留标记（通道扑空也能停下来）', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('./session.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('cancel(h) {'), src.indexOf('/** 上传一张图'));
  assert.match(fn, /cancelRequested = true/, '通道扑空时也要留标记');
  assert.match(src, /const wasCancelled = !!rec\.cancelRequested/,
    'doAsk 收尾要消费标记——否则上游答完了仍当成功交回去');
});

// ── C2 回归：sandboxCalls 必须透传（2026-10-25 审计）──────────
//
// proto.mjs 产出（模型把 site_* 包进 execute/read_file 时收集）、
// toolcycle.mjs 消费，而 session.mjs 的返回值里此前没有这个词
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
  const h = m.open();
  const r = await m.ask(h, '测试');
  assert.ok(Array.isArray(r.sandboxCalls), 'sandboxCalls 必须是数组（不是 undefined）');
  assert.equal(r.sandboxCalls.length, 1);
  assert.equal(r.sandboxCalls[0].name, 'execute');
});

// ── I6：本地不造 id（2026-10-25 定案）─────────────────────
//
// 这是本轮改动的**判据本身**：源码里不许再出现自造的会话标识。
// 它守的不是行为，是「这一层没有被悄悄长回来」。
test('I6：session.mjs 源码里不再出现自造会话 id', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('./session.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  for (const bad of ['sessionId', 'sessionKey', 'nextId', '`s${']) {
    assert.ok(!code.includes(bad), `不许再出现自造 id：${bad}`);
  }
  // 句柄本身必须是对象（不是字符串、不是计数器）
  assert.match(code, /Object\.freeze\(\{/, '句柄必须是冻结对象，不是字符串 id');
});
