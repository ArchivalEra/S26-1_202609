// iframe-bridge.test.mjs —— A 侧装配的接口契约（零网络、无真 iframe）。
//
// 测的是「面板要的那三个方法」与「装配形态」：
//   · transport.ask 把 text 经通道送出去，事件原样回来
//   · cancel 会发 stop（真停上游，不只是断本地）
//   · upload 明确拒绝（本轮不做图片，不许假装支持）
//   · mountHiddenIframe 的样式：**不许 display:none**（Chrome 会节流计时器）

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createIframeBridge, mountHiddenIframe } from './iframe-bridge.mjs';
import { createGuestEndpoint, createResponder } from './channel.mjs';

// ── 假 window（与 channel.test 同形，但这里只需最小可用）─────────

function makeWindow(origin) {
  const listeners = [];
  const w = {
    origin,
    peer: null,
    addEventListener(t, fn) { if (t === 'message') listeners.push(fn); },
    removeEventListener(t, fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    postMessage(data) {
      const caller = w.peer;
      if (!caller) return;
      const ev = { data, origin: caller.origin, source: caller };
      for (const fn of listeners.slice()) fn(ev);
    },
    get listeners() { return listeners; },
  };
  return w;
}

const A_ORIGIN = 'https://a.example';
const B_ORIGIN = 'https://b.example';

/** 装一套 A↔B：A 用 createIframeBridge，B 用 guest 端 responder。 */
function setup(hostImpl) {
  const a = makeWindow(A_ORIGIN);
  const b = makeWindow(B_ORIGIN);
  a.peer = b; b.peer = a;

  const bridge = createIframeBridge({
    aOrigin: A_ORIGIN, bOrigin: B_ORIGIN,
    target: { contentWindow: b },
    askTimeoutMs: 3000,
  });
  // A 侧的 listenOn 是全局 window —— 测试里用桥内部的 endpoint 无法替换，
  // 所以这里改用 createIframeBridge 的通道对象直接桥接：把 A 的监听挂到 a 上。
  // （createIframeBridge 用全局 window，单测环境没有；见下面的 globalThis 注记）

  const bep = createGuestEndpoint({ parentWindow: a, aOrigin: A_ORIGIN, bOrigin: B_ORIGIN, listenOn: b });
  const resp = createResponder({ endpoint: bep, host: hostImpl });
  resp.announce();
  return { bridge, resp, a, b };
}

// createIframeBridge 内部用全局 window 收消息；Node 里给它一个假的。
globalThis.window = globalThis.window || makeWindow(A_ORIGIN);

function withGlobalWindow(origin, fn) {
  const prev = globalThis.window;
  const w = makeWindow(origin);
  globalThis.window = w;
  try { return fn(w); } finally { globalThis.window = prev; }
}

function setupWithGlobal(hostImpl) {
  const a = makeWindow(A_ORIGIN);
  const b = makeWindow(B_ORIGIN);
  a.peer = b; b.peer = a;
  const prev = globalThis.window;
  globalThis.window = a;   // A 侧的 listenOn
  try {
    const bridge = createIframeBridge({
      aOrigin: A_ORIGIN, bOrigin: B_ORIGIN,
      target: { contentWindow: b },
      askTimeoutMs: 3000,
    });
    const bep = createGuestEndpoint({ parentWindow: a, aOrigin: A_ORIGIN, bOrigin: B_ORIGIN, listenOn: b });
    const resp = createResponder({ endpoint: bep, host: hostImpl });
    resp.announce();
    return { bridge, resp, a, b, restore: () => { globalThis.window = prev; } };
  } catch (e) { globalThis.window = prev; throw e; }
}

// ── transport 契约 ──────────────────────────────────────────

test('transport.ask：文本经通道送出，事件原样回来，resolve ok:true', async () => {
  const got = [];
  const ctx = setupWithGlobal({
    async ask(text, emit) {
      got.push(text);
      emit({ type: 'delta', text: '半句' });
      emit({ type: 'done', status: 'answered', text: '完整答案' });
      return { status: 'answered', text: '完整答案' };
    },
    cancel() { return { cancelled: true }; },
  });
  try {
    const events = [];
    const r = await ctx.bridge.transport.ask({ text: '你好' }, (ev) => events.push(ev));
    assert.equal(r.ok, true);
    assert.equal(r.text, '完整答案');
    assert.deepEqual(got, ['你好'], '文本必须逐字送到 B');
    assert.deepEqual(events.map((e) => e.type), ['delta', 'done']);
  } finally { ctx.restore(); }
});

test('transport.ask：B 失败 ⇒ ok:false + reason（面板据此显示错误）', async () => {
  const ctx = setupWithGlobal({
    async ask() { return { status: 'transport', text: '', error: '冻死' }; },
    cancel() {},
  });
  try {
    const r = await ctx.bridge.transport.ask({ text: 'x' }, () => {});
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /冻死/);
  } finally { ctx.restore(); }
});

test('transport.cancel：发 stop 到 B（真停上游，不是只断本地）', async () => {
  let cancelled = 0;
  const ctx = setupWithGlobal({
    async ask() { return { status: 'answered', text: '' }; },
    cancel() { cancelled += 1; return { cancelled: true }; },
  });
  try {
    ctx.bridge.transport.cancel();
    assert.equal(cancelled, 1, '停必须打到上游');
  } finally { ctx.restore(); }
});

test('transport.upload：明确拒绝（本轮不做图片，不许假装成功）', async () => {
  const ctx = setupWithGlobal({ async ask() { return { status: 'answered', text: '' }; }, cancel() {} });
  try {
    await assert.rejects(() => ctx.bridge.transport.upload(), /暂不支持附件/);
  } finally { ctx.restore(); }
});

test('ready：B announce 之后 A 侧 ready 为 true', async () => {
  const ctx = setupWithGlobal({ async ask() { return { status: 'answered', text: '' }; }, cancel() {} });
  try {
    // announce 已在 setup 里发过（同步投递）
    assert.equal(ctx.bridge.ready, true);
  } finally { ctx.restore(); }
});

test('dispose：拆除后不再收消息（不留悬挂监听）', async () => {
  const ctx = setupWithGlobal({ async ask() { return { status: 'answered', text: '' }; }, cancel() {} });
  try {
    ctx.bridge.dispose();
    assert.equal(ctx.a.listeners.length, 0, '监听必须摘干净');
  } finally { ctx.restore(); }
});

// ── iframe 形态 ─────────────────────────────────────────────

test('mountHiddenIframe：**不许** display:none（Chrome 会对隐藏 iframe 节流计时器）', () => {
  const src = readFileSync(new URL('./iframe-bridge.mjs', import.meta.url), 'utf8');
  // 只查**运行时字符串**：注释里写「不能 display:none」是在解释约束，不该被误判
  const code = src.split('\n')
    .filter((l) => { const t = l.trim(); return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); })
    .join('\n');
  assert.doesNotMatch(code, /display:\s*none/, '硬约束：隐藏 iframe 不能用 display:none');
  assert.match(code, /opacity:0/, '应该是 1×1 + opacity:0');
  assert.match(code, /width:2px/, '尺寸要极小');
});

test('mountHiddenIframe：落 viewport 内（left/top 为 0）', () => {
  const src = readFileSync(new URL('./iframe-bridge.mjs', import.meta.url), 'utf8');
  assert.match(src, /left:0;top:0/, '必须在 viewport 内，否则同样被判定不可见');
});

test('mountHiddenIframe：拒绝没有 document 的环境（明确报错，不静默）', () => {
  assert.throws(() => mountHiddenIframe({ bOrigin: B_ORIGIN, path: '/x', doc: null }), /document/);
});

// ── ready 竞态回归（2026-10-25 端到端抓到的真 bug）──────────────
//
// 病灶：B 的 announce 在桥建好**之前**就发了（iframe 先装载完是常见顺序），
// 那次 announce 落到没有监听器的窗口上就丢了 ⇒ `bridge.ready` 永远 false。
// 实测：端到端第一次跑 `ready=false`，但问答本身是通的。
//
// 修法：A 建桥后主动发 `ping`，B 收到就重发 announce；同时 waitReady 支持等待。

test('ready 竞态：B 先 announce、A 后建桥 ⇒ waitReady 仍能拿到 true', async () => {
  const a = makeWindow(A_ORIGIN);
  const b = makeWindow(B_ORIGIN);
  a.peer = b; b.peer = a;
  const prev = globalThis.window;
  globalThis.window = a;
  try {
    // ① B 侧先就绪并 announce（此时 A 还没有监听器 —— 这次 announce 必然丢）
    const bep = createGuestEndpoint({ parentWindow: a, aOrigin: A_ORIGIN, bOrigin: B_ORIGIN, listenOn: b });
    const resp = createResponder({ endpoint: bep, host: { async ask() { return { status: 'answered', text: '' }; }, cancel() {} } });
    resp.announce();
    assert.equal(a.listeners.length, 0, '此刻 A 还没有监听器，announce 确实丢了');

    // ② A 现在才建桥
    const bridge = createIframeBridge({
      aOrigin: A_ORIGIN, bOrigin: B_ORIGIN, target: { contentWindow: b }, askTimeoutMs: 2000,
    });
    assert.equal(bridge.ready, false, '建桥瞬间还没报到');

    // ③ waitReady 会发 ping，B 收到重发 announce
    const ok = await bridge.waitReady(2000);
    assert.equal(ok, true, 'ping 探针必须让 B 重发 ready');
    assert.equal(bridge.ready, true);
  } finally { globalThis.window = prev; }
});

test('waitReady：B 一直不响应 ⇒ 超时返回 false（不悬挂）', async () => {
  const a = makeWindow(A_ORIGIN);
  const b = makeWindow(B_ORIGIN);
  a.peer = b; b.peer = a;   // b 上没有 responder ⇒ 不会回 ready
  const prev = globalThis.window;
  globalThis.window = a;
  try {
    const bridge = createIframeBridge({
      aOrigin: A_ORIGIN, bOrigin: B_ORIGIN, target: { contentWindow: b }, askTimeoutMs: 1000,
    });
    const ok = await bridge.waitReady(120);
    assert.equal(ok, false, '超时要明确返回 false，不能一直挂');
  } finally { globalThis.window = prev; }
});

test('waitReady：已经报到过 ⇒ 立即 true（不重复等）', async () => {
  const ctx = setupWithGlobal({ async ask() { return { status: 'answered', text: '' }; }, cancel() {} });
  try {
    const ok = await ctx.bridge.waitReady(5000);
    assert.equal(ok, true);
  } finally { ctx.restore(); }
});
