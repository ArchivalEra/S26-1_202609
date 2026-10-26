// session.test.mjs —— 多会话管理器的接口契约（零网络，全走 seam 注入的假 adapter）。
//
// 2026-10-25 大删除后重写：转录/压缩/重放整条链已删（上游自己存历史、自己压缩）。
// 留在这里的都是**真正还在的不变量**：
//   I1 全局串行（同一时刻至多一个请求在飞）
//   I2 冷启动三段式（connect → switchModel → 首条消息）
//   I3 句柄稳定（换线不影响调用方手里的引用）
//   I4 传输/内容二分（冻死换线重试；BLOCKED 原样上抛）
//   I5 身份只来自上游（conversationId 只读转发，本地不造）

import test from 'node:test';
import assert from 'node:assert/strict';
import { createManager } from './session.mjs';

/** 剧本 adapter：按顺序出牌，记录操作。 */
function scriptedAdapter(script = [], taps = {}) {
  let i = 0;
  taps.opens = taps.opens || 0;
  taps.closes = taps.closes || 0;
  taps.asks = taps.asks || 0;
  taps.prompts = taps.prompts || [];
  taps.failOpensAt = taps.failOpensAt || [];
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
          if (s === 'blocked') return { text: '很抱歉，您的请求涉及违规内容', status: 'blocked' };
          if (s === 'empty') return { text: '', status: 'empty' };
          if (s === 'frozen') return { text: '', status: 'frozen' };
          return { text: `答#${taps.asks}`, status: 'answered' };
        },
        conversationId: () => taps.conversationId || null,
        msgListTotal: () => (taps.msgListTotal !== undefined ? taps.msgListTotal : null),
        close: () => { taps.closes += 1; },
      };
    },
  };
}

// ── 基本生命周期 ──────────────────────────────────────────

test('ask 首问冷启动（open + 裸问题）', async () => {
  const taps = {};
  const m = createManager({ adapter: scriptedAdapter(['text'], taps) });
  const h = m.open();
  const r = await m.ask(h, '问题');
  assert.equal(r.status, 'ok');
  assert.equal(taps.opens, 1);
  assert.equal(taps.prompts[0], '问题', '裸问题，不重放（本地零会话数据）');
  m.close();
});

test('第二问直接复用连接（零 open）', async () => {
  const taps = {};
  const m = createManager({ adapter: scriptedAdapter(['text', 'text'], taps) });
  const h = m.open();
  await m.ask(h, '问题1');
  await m.ask(h, '问题2');
  assert.equal(taps.opens, 1, '复用 ⇒ 只 open 一次');
  m.close();
});

test('★ 不再重放：第二问原样发出去，不拼任何历史', async () => {
  const taps = {};
  const m = createManager({ adapter: scriptedAdapter(['text', 'text', 'text'], taps) });
  const h = m.open();
  await m.ask(h, '第一问');
  await m.ask(h, '第二问');
  await m.ask(h, '第三问');
  // 三问都必须是**原样**——这是「本地零会话数据」的核心断言
  assert.deepEqual(taps.prompts, ['第一问', '第二问', '第三问']);
  m.close();
});

// ── I4 传输/内容二分 ──────────────────────────────────────

test('冻死（传输）⇒ 换线重试，调用方无感', async () => {
  const taps = {};
  const m = createManager({
    adapter: scriptedAdapter(['freeze', 'text'], taps),
    reconnectAttempts: 2, retryBackoffMs: 0,
  });
  const h = m.open();
  const r = await m.ask(h, '问题');
  assert.equal(r.status, 'ok');
  assert.equal(r.attempts, 2);
  assert.equal(taps.opens, 2, '重试 = 新 open');
  m.close();
});

test('重试耗尽 ⇒ status=transport，不再无限重试', async () => {
  const taps = { failOpensAt: [] };
  const m = createManager({
    adapter: scriptedAdapter(['freeze', 'freeze', 'freeze'], taps),
    reconnectAttempts: 2, retryBackoffMs: 0,
  });
  const h = m.open();
  const r = await m.ask(h, '问题');
  assert.equal(r.status, 'transport');
  assert.equal(taps.opens, 3, '首试 + 2 重试 = 3 次 open');
  m.close();
}, { timeout: 15000 });

test('BLOCKED 是内容失败 ⇒ 原样上抛，不自动重试', async () => {
  const taps = {};
  const m = createManager({ adapter: scriptedAdapter(['blocked'], taps), reconnectAttempts: 2 });
  const h = m.open();
  const r = await m.ask(h, '敏感问题');
  assert.equal(r.status, 'blocked');
  assert.equal(taps.opens, 1, '被拦不换线');
  assert.ok(r.text.includes('违规'));
  m.close();
});

test('frozen 但有正文 ⇒ 按 partial 交回（不丢掉重试）', async () => {
  const m = createManager({
    adapter: { async open() { return { async ask() { return { text: '半截答案', status: 'frozen' }; }, close() {} }; } },
    reconnectAttempts: 2,
  });
  const h = m.open();
  const r = await m.ask(h, '问题');
  assert.equal(r.status, 'partial', '有正文就不能丢');
  assert.equal(r.text, '半截答案');
  m.close();
});

// ── I1 全局串行 ───────────────────────────────────────────

test('I1：并发 ask 全局串行（同时至多一个在飞）', async () => {
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
  const m = createManager({ adapter: scriptedAdapter(Array(8).fill('text'), taps) });
  const h = m.open();
  await m.ask(h, '1'); await m.ask(h, '2'); await m.ask(h, '3'); await m.ask(h, '4');
  m.close();
  assert.equal(taps.opens, taps.closes, '每次 open 必有配对 close');
});

// ── deadline ──────────────────────────────────────────────

test('deadline：墙钟到点收束（不无限挂起）', async () => {
  const hangAdapter = {
    async open() { return { ask: () => new Promise(() => {}), close: () => {} }; },
  };
  const m = createManager({ adapter: hangAdapter, deadlineMs: 300, reconnectAttempts: 0 });
  const h = m.open();
  const r = await m.ask(h, '问题');
  assert.equal(r.status, 'deadline');
  m.close();
});

// ── I5 身份只来自上游 ─────────────────────────────────────

test('I5：conversationId 只读转发上游；未连上时为 null', async () => {
  const taps = { conversationId: 'upstream-conv-123' };
  const m = createManager({ adapter: scriptedAdapter(['text'], taps) });
  const h = m.open();
  assert.equal(h.conversationId, null, '没有通道就没有身份——不许编');
  await m.ask(h, 'x');
  assert.equal(h.conversationId, 'upstream-conv-123');
  m.close();
});

test('★ msgListTotal：上游 msgList.total 的只读透出（判「是不是新会话」）', async () => {
  const taps = { msgListTotal: 0 };
  const m = createManager({ adapter: scriptedAdapter(['text'], taps) });
  const h = m.open();
  assert.equal(h.msgListTotal, null, '未连上时是 null');
  await m.ask(h, 'x');
  assert.equal(h.msgListTotal, 0, '新会话 ⇒ total 0 ⇒ 要发工具清单');

  // 换成有历史的会话
  const taps2 = { msgListTotal: 5 };
  const m2 = createManager({ adapter: scriptedAdapter(['text'], taps2) });
  const h2 = m2.open();
  await m2.ask(h2, 'x');
  assert.equal(h2.msgListTotal, 5, '旧会话 ⇒ total > 0 ⇒ 不发工具清单');
  m.close(); m2.close();
});

test('find：按上游 conversationId 找回会话；找不到返回 null', async () => {
  const taps = { conversationId: 'conv-abc' };
  const m = createManager({ adapter: scriptedAdapter(['text'], taps) });
  const h = m.open();
  await m.ask(h, 'x');
  assert.equal(m.find('conv-abc'), h);
  assert.equal(m.find('nope'), null);
  assert.equal(m.find(null), null);
  m.close();
});

// ── 取消 ──────────────────────────────────────────────────

test('取消：adapter 必须暴露 cancel（否则管理器静默跳过）', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('./session.mjs', import.meta.url), 'utf8');
  assert.match(src, /cancel:\s*\(\)\s*=>\s*a\.cancel\(\)/,
    'adapter 必须把 cancel 转发出去——少这行管理器会以为通道不支持取消');
});

test('取消：管理器留标记（通道扑空也能停下来）', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('./session.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('cancel(h) {'), src.indexOf('/** 上传一张图'));
  assert.match(fn, /cancelRequested = true/, '通道扑空时也要留标记');
  assert.match(src, /const wasCancelled = !!rec\.cancelRequested/,
    'doAsk 收尾要消费标记——否则上游答完了仍当成功交回去');
});

// ── C2 回归：sandboxCalls 必须透传 ────────────────────────

test('C2：adapter 返回的 sandboxCalls 必须透传到返回值', async () => {
  const adapter = {
    async open() {
      return {
        async ask() {
          return { text: '好', status: 'answered', sandboxCalls: [{ name: 'execute', args: 'site_read，what=page' }] };
        },
        close() {},
      };
    },
  };
  const m = createManager({ adapter });
  const h = m.open();
  const r = await m.ask(h, '测试');
  assert.ok(Array.isArray(r.sandboxCalls));
  assert.equal(r.sandboxCalls.length, 1);
});

// ── 源码守卫：本地零会话数据 ──────────────────────────────

test('★ 源码守卫：session.mjs 里不许再有转录/重放/水位', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('./session.mjs', import.meta.url), 'utf8');
  const code = src.split('\n')
    .filter((l) => { const t = l.trim(); return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); })
    .join('\n');
  for (const bad of ['transcript', 'buildRestore', 'deliveredSeq', 'shouldRotate', 'createTranscript']) {
    assert.ok(!code.includes(bad), `本地零会话数据：不许再出现 ${bad}`);
  }
});

test('★ 文件守卫：context.mjs 必须已删（上游自己存历史、自己压缩）', async () => {
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(new URL('./context.mjs', import.meta.url)), false,
    '转录模块已删——本地不存任何会话数据');
});

// ── msgListTotal 必须是**同步可读的缓存值**（2026-10-25 实测抓到的真 bug）──
//
// 病灶：proto 的 msgListTotal() 是 async（要发一次 HTTP），旧实现把它当同步值读
// ⇒ 拿到 Promise 对象，`typeof === 'number'` 恒假 ⇒ 判据永远认为「新会话」
// ⇒ 第二次提问照样发工具清单（实测提示词 1286 字，本该是裸问题）。
//
// 修法：建连时取一次、缓存在 record 上，句柄与管理器都同步读缓存。

test('★ msgListTotal 是同步数值（不是 Promise）——建连后立即读得到', async () => {
  const taps = { msgListTotal: 5 };
  const adapter = {
    async open() {
      return {
        async ask() { return { text: 'x', status: 'answered' }; },
        conversationId: () => 'conv-1',
        // 模拟 proto 的 async 签名：返回 Promise<number>
        async msgListTotal() { return taps.msgListTotal; },
        close() {},
      };
    },
  };
  const m = createManager({ adapter });
  const h = m.open();
  await m.ask(h, '第一问');   // 建连 + 缓存

  // 关键断言：读出来必须是数字，不能是 Promise
  const v = m.msgListTotal(h);
  assert.equal(typeof v, 'number', '必须是数字——Promise 会让判据恒假');
  assert.equal(v, 5);
  assert.equal(h.msgListTotal, 5, '句柄上也要是数字');
});

test('★ 建连后 total=0 ⇒ 仍按新会话（第一次提问要发清单）', async () => {
  const adapter = {
    async open() {
      return {
        async ask() { return { text: 'x', status: 'answered' }; },
        conversationId: () => 'conv-new',
        async msgListTotal() { return 0; },
        close() {},
      };
    },
  };
  const m = createManager({ adapter });
  const h = m.open();
  await m.ask(h, '第一问');
  assert.equal(m.msgListTotal(h), 0, '0 是有效值，不是「取不到」');
});

test('★ msgListTotal 取不到（抛错）⇒ null，不崩', async () => {
  const adapter = {
    async open() {
      return {
        async ask() { return { text: 'x', status: 'answered' }; },
        conversationId: () => 'conv-x',
        async msgListTotal() { throw new Error('网络挂了'); },
        close() {},
      };
    },
  };
  const m = createManager({ adapter });
  const h = m.open();
  const r = await m.ask(h, '第一问');
  assert.equal(r.status, 'ok', '取不到判据不该影响问答');
  assert.equal(m.msgListTotal(h), null);
});
