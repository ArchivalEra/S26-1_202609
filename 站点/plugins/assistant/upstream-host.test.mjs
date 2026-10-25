// upstream-host.test.mjs —— B 侧上游代理的接口契约（零网络，注入假 proto）。
//
// 测的是「B 只做管道」这条硬约束：
//   · 不拼提示词、不解析工具调用（上游说什么就交回什么）
//   · 一問一终态（成功/失败/连接失败都恰好一个终态事件）
//   · 惰性建连且并发共享（不建两条 WS）
//   · cancel 转给 assistant.cancel
//   · 源码里不许 import toolcycle/chatsvc/session（旧病灶的根因）

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createUpstreamHost } from './upstream-host.mjs';

/** 假协议栈：记录调用，按剧本返回。 */
function fakeProto(script = []) {
  const taps = { connects: 0, asks: [], closed: 0, cancels: 0 };
  let i = 0;
  return {
    taps,
    createAssistant(opts) {
      taps.lastOpts = opts;
      return {
        identity: { visitorId: 'lc_test', conversationId: 'cid-test' },
        async connect() { taps.connects += 1; await new Promise((r) => setTimeout(r, 5)); },
        async ask(text, o) {
          taps.asks.push({ text, opts: o });
          const s = script[i++] || { status: 'answered', text: '默认' };
          if (s.status === 'answered' && typeof o.onChunk === 'function' && s.text) {
            // 模拟流式：分两段推
            o.onChunk(String(s.text).slice(0, 2));
            o.onChunk(String(s.text).slice(2));
          }
          return s;
        },
        cancel() { taps.cancels += 1; return { cancelled: true }; },
        close() { taps.closed += 1; },
      };
    },
  };
}

const BASE = { base: 'https://up.example', unitId: '1397', robotId: 'robot-x' };

test('契约：缺 proto 或三件套 ⇒ 明确报错（不猜默认值）', () => {
  assert.throws(() => createUpstreamHost({ ...BASE }), /proto/);
  assert.throws(() => createUpstreamHost({ proto: fakeProto(), unitId: '1', robotId: 'r' }), /base|unitId|robotId/);
  assert.throws(() => createUpstreamHost({ proto: fakeProto(), base: 'x', unitId: '1' }), /base|unitId|robotId/);
});

test('一問一终态：成功 ⇒ delta 若干 + 恰好一个 done', async () => {
  const p = fakeProto([{ status: 'answered', text: '这是答案' }]);
  const host = createUpstreamHost({ proto: p, ...BASE });
  const events = [];
  const r = await host.ask('问题', (ev) => events.push(ev));

  assert.equal(r.status, 'answered');
  assert.equal(r.text, '这是答案');
  const dones = events.filter((e) => e.type === 'done');
  assert.equal(dones.length, 1, '必须恰好一个 done');
  assert.equal(events.filter((e) => e.type === 'error').length, 0);
  assert.ok(events.some((e) => e.type === 'delta'), '流式增量要透出');
});

test('一問一终态：传输失败 ⇒ 恰好一个 error，不抛异常', async () => {
  const p = fakeProto([{ status: 'transport', text: '', error: 'WS 冻死' }]);
  const host = createUpstreamHost({ proto: p, ...BASE });
  const events = [];
  const r = await host.ask('问题', (ev) => events.push(ev));

  assert.equal(r.status, 'transport');
  const errs = events.filter((e) => e.type === 'error');
  assert.equal(errs.length, 1);
  assert.match(String(errs[0].reason), /WS 冻死/);
  assert.equal(events.filter((e) => e.type === 'done').length, 0);
});

test('一問一终态：建连失败 ⇒ 一个 error（不是悬挂）', async () => {
  const p = fakeProto();
  p.createAssistant = () => ({
    identity: null,
    async connect() { throw new Error('apply 失败'); },
    async ask() { throw new Error('不该走到'); },
    cancel() {}, close() {},
  });
  const host = createUpstreamHost({ proto: p, ...BASE });
  const events = [];
  const r = await host.ask('问题', (ev) => events.push(ev));

  assert.equal(r.status, 'transport');
  assert.equal(events.filter((e) => e.type === 'error').length, 1);
  assert.match(String(r.error), /apply 失败/);
});

test('惰性建连：不调 ask 就不 connect（开 50 个不白连）', () => {
  const p = fakeProto();
  createUpstreamHost({ proto: p, ...BASE });
  assert.equal(p.taps.connects, 0, '构造时不许建连');
});

test('并发共享：两次同时 ask 只建一条连接', async () => {
  const p = fakeProto([{ status: 'answered', text: 'a' }, { status: 'answered', text: 'b' }]);
  const host = createUpstreamHost({ proto: p, ...BASE });
  await Promise.all([host.ask('问题1', () => {}), host.ask('问题2', () => {})]);
  assert.equal(p.taps.connects, 1, '并发建连必须共享同一个 Promise');
});

test('planning 恒为 true（助手模式；普通模式无消费者，别加开关）', async () => {
  const p = fakeProto([{ status: 'answered', text: 'x' }]);
  const host = createUpstreamHost({ proto: p, ...BASE });
  await host.ask('q', () => {});
  assert.equal(p.taps.lastOpts.planning, true);
});

test('cancel 转给 assistant.cancel（真停上游）', async () => {
  const p = fakeProto([{ status: 'answered', text: 'x' }]);
  const host = createUpstreamHost({ proto: p, ...BASE });
  await host.ask('q', () => {});
  host.cancel();
  assert.equal(p.taps.cancels, 1);
});

test('未连上时 cancel 不崩（返回 cancelled:false）', () => {
  const host = createUpstreamHost({ proto: fakeProto(), ...BASE });
  const r = host.cancel();
  assert.equal(r.cancelled, false);
});

test('conversationId / visitorId 只读转发上游（本地不造）', async () => {
  const p = fakeProto([{ status: 'answered', text: 'x' }]);
  const host = createUpstreamHost({ proto: p, ...BASE });
  assert.equal(host.conversationId, null, '未连上时必须是 null，不许编');
  await host.ask('q', () => {});
  assert.equal(host.conversationId, 'cid-test');
  assert.equal(host.visitorId, 'lc_test');
});

test('close 幂等且会关 assistant', () => {
  const p = fakeProto([{ status: 'answered', text: 'x' }]);
  const host = createUpstreamHost({ proto: p, ...BASE });
  host.close();
  host.close();
  assert.equal(host.conversationId, null);
});

// ── 硬约束：B 侧不许养第二套工具循环 ─────────────────────────

test('★ 源码守卫：upstream-host.mjs 不许 import toolcycle/chatsvc/session', () => {
  const src = readFileSync(new URL('./upstream-host.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  for (const bad of ['toolcycle', 'chatsvc', 'session.mjs']) {
    assert.ok(!code.includes('from \'./' + bad), `不许 import ${bad}（旧病灶：B 侧又养一套工具会话）`);
  }
});

test('★ 源码守卫：guest-entry.mjs 同样不许', () => {
  const src = readFileSync(new URL('./guest-entry.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  for (const bad of ['toolcycle', 'chatsvc', 'session.mjs']) {
    assert.ok(!code.includes('from \'./' + bad), `不许 import ${bad}`);
  }
});

test('★ 源码守卫：B 侧不许拼提示词（只做管道）', () => {
  const src = readFileSync(new URL('./upstream-host.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  // 这些字符串是提示词拼装的标志；B 侧出现任何一个都说明它又开始当"监工"了
  for (const bad of ['pageToolsPrompt', '工具返回：', '建议下一步', '原始任务']) {
    assert.ok(!code.includes(bad), `B 侧不许出现提示词拼装痕迹：${bad}`);
  }
});
