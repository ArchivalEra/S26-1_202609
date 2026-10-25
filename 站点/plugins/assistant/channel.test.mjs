// channel.test.mjs —— A↔B 通道的接口契约（零网络，全走假 window / 假 host）。
//
// 测的是**安全不变量**（channel.mjs 头注释的 I1–I5），不是 postMessage 本身：
//   I1 双向校验：origin **且** source
//   I2 禁 '*' targetOrigin
//   I3 一問一终态
//   I4 requestId 配对
//   I5 timer 必清

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostEndpoint, createGuestEndpoint, createRequester, createResponder } from './channel.mjs';
import { createEndpoint as createEndpointRaw } from './channel.mjs';

// ── 假 window：能派发 message、能收 postMessage ──────────────

function makeWindow(origin) {
  const listeners = [];
  const sent = [];
  const w = {
    origin,
    sent,
    addEventListener(t, fn) { if (t === 'message') listeners.push(fn); },
    removeEventListener(t, fn) {
      if (t !== 'message') return;
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    /** 模拟 postMessage（同步，方便断言）。
     *
     * ⚠️ 真实语义是 `otherWindow.postMessage(...)` **投递给 otherWindow 自己**，
     * 而 `event.source` 是**调用者**。所以这里：
     *   · 投递目标是 w 自己的 listeners；
     *   · source / origin 是 peer（两窗口成对时，调用者必然是对方）。
     * 第一版写反了（投给 peer），导致所有请求都到不了对端——测试才抓出来。 */
    postMessage(data, targetOrigin) {
      sent.push({ data, targetOrigin });
      const caller = w.peer;
      if (!caller) return;
      const ev = { data, origin: caller.origin, source: caller };
      for (const fn of listeners.slice()) fn(ev);
    },
    /** 模拟“收到一条来自 origin 的消息”。 */
    deliver(ev) {
      for (const fn of listeners.slice()) fn(ev);
    },
    get listeners() { return listeners; },
    peer: null,
  };
  return w;
}

/** 造一对互连的假窗口（A ↔ B）。 */
function makePair(aOrigin = 'https://a.example', bOrigin = 'https://b.example') {
  const a = makeWindow(aOrigin);
  const b = makeWindow(bOrigin);
  a.peer = b; b.peer = a;
  return { a, b };
}

// ── I2：targetOrigin 不许通配 ────────────────────────────────

test('I2：targetOrigin 为 * 时直接抛错（禁通配）', () => {
  const { b } = makePair();
  assert.throws(
    () => createHostEndpoint({ target: b, bOrigin: '*', listenOn: makeWindow('x') }),
    /通配|targetOrigin/,
  );
});

test('I2：allowOrigins 为空时抛错（不许退化成全放行）', () => {
  // 直接调底层 createEndpoint：hostEndpoint 自己会填 [bOrigin]，测不到空集这条
  assert.throws(
    () => createEndpointRaw({ target: makeWindow('b'), targetOrigin: 'https://b.example', allowOrigins: [], listenOn: makeWindow('x') }),
    /allowOrigins/,
  );
});

// ── I1：双向校验 ────────────────────────────────────────────

test('I1：origin 不对 ⇒ 丢弃（不入 handler）', () => {
  const { a, b } = makePair();
  const ep = createHostEndpoint({ target: b, bOrigin: 'https://b.example', listenOn: a });
  let hit = 0;
  ep.on('event', () => { hit += 1; });
  a.deliver({ data: { v: 1, t: 'event', requestId: 'r1', ev: { type: 'delta' } }, origin: 'https://evil.example', source: b });
  assert.equal(hit, 0, '错 origin 必须丢弃');
  a.deliver({ data: { v: 1, t: 'event', requestId: 'r1', ev: { type: 'delta' } }, origin: 'https://b.example', source: b });
  assert.equal(hit, 1, '正确 origin + source 才入 handler');
});

test('I1：source 不对 ⇒ 丢弃（防同 origin 的另一窗口冒充）', () => {
  const { a, b } = makePair();
  const ep = createHostEndpoint({ target: b, bOrigin: 'https://b.example', listenOn: a });
  let hit = 0;
  ep.on('event', () => { hit += 1; });
  // origin 对，但 source 是别的窗口
  a.deliver({ data: { v: 1, t: 'event', requestId: 'r1', ev: {} }, origin: 'https://b.example', source: makeWindow('https://b.example') });
  assert.equal(hit, 0, 'source 不对必须丢弃');
});

test('I1：协议版本不符 ⇒ 丢弃（v 必须等于 1）', () => {
  const { a, b } = makePair();
  const ep = createHostEndpoint({ target: b, bOrigin: 'https://b.example', listenOn: a });
  let hit = 0;
  ep.on('event', () => { hit += 1; });
  a.deliver({ data: { v: 2, t: 'event', requestId: 'r1', ev: {} }, origin: 'https://b.example', source: b });
  assert.equal(hit, 0);
});

test('dispose 之后不再收消息（不留悬挂监听）', () => {
  const { a, b } = makePair();
  const ep = createHostEndpoint({ target: b, bOrigin: 'https://b.example', listenOn: a });
  let hit = 0;
  ep.on('event', () => { hit += 1; });
  ep.dispose();
  a.deliver({ data: { v: 1, t: 'event', requestId: 'r1', ev: {} }, origin: 'https://b.example', source: b });
  assert.equal(hit, 0);
});

// ── I3 / I4：请求器的一問一终态 ──────────────────────────────

test('I3：ask 收到 result ⇒ resolve，且事件已按序送达', async () => {
  const { a, b } = makePair();
  const aep = createHostEndpoint({ target: b, bOrigin: 'https://b.example', listenOn: a });
  const bep = createGuestEndpoint({ parentWindow: a, aOrigin: 'https://a.example', bOrigin: 'https://b.example', listenOn: b });
  const req = createRequester({ endpoint: aep, askTimeoutMs: 5000 });
  createResponder({
    endpoint: bep,
    host: {
      async ask(text, emit) {
        emit({ type: 'delta', text: '第一段' });
        emit({ type: 'done', status: 'answered', text: '第一段' });
        return { status: 'answered', text: '第一段' };
      },
      cancel() { return { cancelled: true }; },
    },
  });

  const events = [];
  const r = await req.ask('你好', (ev) => events.push(ev));
  assert.equal(r.ok, true);
  assert.equal(r.value.text, '第一段');
  assert.deepEqual(events.map((e) => e.type), ['delta', 'done'], 'delta 与 done 都要到');
});

test('I3：host 抛错 ⇒ resolve 成 ok:false（不 reject、不悬挂）', async () => {
  const { a, b } = makePair();
  const aep = createHostEndpoint({ target: b, bOrigin: 'https://b.example', listenOn: a });
  const bep = createGuestEndpoint({ parentWindow: a, aOrigin: 'https://a.example', bOrigin: 'https://b.example', listenOn: b });
  const req = createRequester({ endpoint: aep, askTimeoutMs: 5000 });
  createResponder({ endpoint: bep, host: { async ask() { throw new Error('上游炸了'); }, cancel() {} } });

  const r = await req.ask('问题', () => {});
  assert.equal(r.ok, false);
  assert.match(String(r.error), /上游炸了/);
});

test('I3：超时 ⇒ 也 resolve 成 ok:false（超时也算终态）', async () => {
  const { a, b } = makePair();
  const aep = createHostEndpoint({ target: b, bOrigin: 'https://b.example', listenOn: a });
  const req = createRequester({ endpoint: aep, askTimeoutMs: 120 });
  // 没有 responder —— 永远不会有 result
  const r = await req.ask('问题', () => {});
  assert.equal(r.ok, false);
  assert.equal(r.error, 'timeout');
});

test('I4：requestId 配对——两条并发 ask 各自拿到自己的结果', async () => {
  const { a, b } = makePair();
  const aep = createHostEndpoint({ target: b, bOrigin: 'https://b.example', listenOn: a });
  const bep = createGuestEndpoint({ parentWindow: a, aOrigin: 'https://a.example', bOrigin: 'https://b.example', listenOn: b });
  const req = createRequester({ endpoint: aep, askTimeoutMs: 5000 });
  createResponder({
    endpoint: bep,
    host: {
      async ask(text) {
        await new Promise((r) => setTimeout(r, text === '慢' ? 60 : 5));
        return { status: 'answered', text: '答:' + text };
      },
      cancel() {},
    },
  });

  const [r1, r2] = await Promise.all([req.ask('慢', () => {}), req.ask('快', () => {})]);
  assert.equal(r1.value.text, '答:慢', '慢的那条不能被快的串了');
  assert.equal(r2.value.text, '答:快');
});

test('I4：query 也能配对（会话列表 / 历史）', async () => {
  const { a, b } = makePair();
  const aep = createHostEndpoint({ target: b, bOrigin: 'https://b.example', listenOn: a });
  const bep = createGuestEndpoint({ parentWindow: a, aOrigin: 'https://a.example', bOrigin: 'https://b.example', listenOn: b });
  const req = createRequester({ endpoint: aep, queryTimeoutMs: 5000 });
  createResponder({
    endpoint: bep,
    host: {
      async ask() { return { status: 'answered', text: '' }; },
      async conversations() { return [{ timeRange: '今天', list: [{ conversationId: 'c1' }] }]; },
      async history(cid) { return [{ messageId: 'm1', conversationId: cid }]; },
      cancel() {},
    },
  });

  const cl = await req.query('conversations');
  assert.equal(cl.ok, true);
  assert.equal(cl.value[0].list[0].conversationId, 'c1');

  const h = await req.query('history', { conversationId: 'c1' });
  assert.equal(h.ok, true);
  assert.equal(h.value[0].conversationId, 'c1');
});

test('I5：abortAll 清掉在飞的等待（不留悬挂 Promise / 不定时器）', async () => {
  const { a, b } = makePair();
  const aep = createHostEndpoint({ target: b, bOrigin: 'https://b.example', listenOn: a });
  const req = createRequester({ endpoint: aep, askTimeoutMs: 60000 });
  const p = req.ask('永不返回', () => {});
  assert.equal(req.size, 1, '在飞 1 条');
  req.abortAll('disposed');
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.error, 'disposed');
  assert.equal(req.size, 0, '清空后不能残留');
});

// ── stop 的路由 ────────────────────────────────────────────

test('stop：A 发 stop ⇒ B 调 host.cancel（真停上游，不只是断本地）', async () => {
  const { a, b } = makePair();
  const aep = createHostEndpoint({ target: b, bOrigin: 'https://b.example', listenOn: a });
  const bep = createGuestEndpoint({ parentWindow: a, aOrigin: 'https://a.example', bOrigin: 'https://b.example', listenOn: b });
  let cancelled = 0;
  createResponder({ endpoint: bep, host: { async ask() { return { status: 'answered', text: '' }; }, cancel() { cancelled += 1; return { cancelled: true }; } } });

  const req = createRequester({ endpoint: aep });
  req.stop();
  assert.equal(cancelled, 1);
});

// ── ready ──────────────────────────────────────────────────

test('ready：B 报到后 A 能观测到 ready 状态', () => {
  const { a, b } = makePair();
  const aep = createHostEndpoint({ target: b, bOrigin: 'https://b.example', listenOn: a });
  let readyAt = null;
  aep.on('ready', () => { readyAt = Date.now(); });
  const bep = createGuestEndpoint({ parentWindow: a, aOrigin: 'https://a.example', bOrigin: 'https://b.example', listenOn: b });
  const resp = createResponder({ endpoint: bep, host: { async ask() {}, cancel() {} } });
  resp.announce();
  assert.ok(readyAt, 'A 侧必须收到 ready');
});

// ── 安全：B 侧也只认 A 的 origin ────────────────────────────

test('I1（反向）：A 侧 origin 不对 ⇒ B 侧不执行', () => {
  const { a, b } = makePair();
  const bep = createGuestEndpoint({ parentWindow: a, aOrigin: 'https://a.example', bOrigin: 'https://b.example', listenOn: b });
  let asked = 0;
  createResponder({ endpoint: bep, host: { async ask() { asked += 1; }, cancel() {} } });
  // 冒充者：origin 不对
  b.deliver({ data: { v: 1, t: 'ask', requestId: 'r1', text: 'x' }, origin: 'https://evil.example', source: a });
  assert.equal(asked, 0, '错 origin 的 ask 不许执行');
});
