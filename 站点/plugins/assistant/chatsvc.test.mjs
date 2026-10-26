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
    open(cfg) { taps.opened += 1; taps.lastCfg = cfg; return { conversationId: 'c' + taps.opened }; },
    async ask(h, text, opts) {
      taps.asks.push({ h, text, opts });
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
    find() { return null; },
    close() {},
  };
}

const H = Object.freeze({ conversationId: null });
const H2 = Object.freeze({ conversationId: null });

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
  const r = await svc.ask(H, '你好', emit);

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
  await svc.ask(H, '问', emit);

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
  await svc.ask(H, '问', emit);

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
  await svc.ask(H, '读一下', emit);

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
  await svc.ask(H, '读', emit);

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
  await svc.ask(H, '读', emit);

  const tools = events.filter((e) => e.type === 'tool');
  assert.equal(tools[0].ok, false);
  assert.match(tools[0].error, /页面失败/);
});

// ── 故障 ────────────────────────────────────────────────────

test('ask：传输层故障转成 error 事件，不抛异常', async () => {
  const mgr = fakeMgr(['frozen']);
  const svc = createChatService({ mgr, tools: TOOLS, invoke: async () => ({}) });
  const { events, emit } = collect();
  const r = await svc.ask(H, '问', emit);

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
  const r = await svc.ask(H, '问', emit);
  assert.equal(r.status, 'error');
  assert.equal(events.filter((e) => e.type === 'error').length, 1);
});

// ── 会话管理 ────────────────────────────────────────────────

test('open()：每调一次开一场新对话（本地不铸 id）', async () => {
  const taps = {};
  const mgr = fakeMgr(['answer:a', 'answer:b'], taps);
  const svc = createChatService({ mgr, tools: TOOLS, invoke: async () => ({}) });
  const a = svc.open();
  const b = svc.open();
  assert.notEqual(a, b, '两次 open 是两个不同句柄');
  assert.notEqual(typeof a, 'string', '句柄不是自造的字符串 id');
  assert.equal(taps.opened, 2);
});

test('同一句柄的多次 ask 复用同一个管理器会话', async () => {
  const taps = {};
  const mgr = fakeMgr(['answer:a', 'answer:b'], taps);
  const svc = createChatService({ mgr, tools: TOOLS, invoke: async () => ({}) });
  const h = svc.open();
  await svc.ask(h, '第一问', () => {});
  await svc.ask(h, '第二问', () => {});
  assert.equal(taps.opened, 1, '同一句柄不该重复 open');
});

test('attach()：按上游 conversationId 找回会话；找不到返回 null', async () => {
  const mgr = {
    open() { return { conversationId: null }; },
    find(cid) { return cid === 'up-1' ? 'FOUND' : null; },
    async ask() { return { text: 'x', status: 'ok' }; },
    close() {},
  };
  const svc = createChatService({ mgr, tools: TOOLS, invoke: async () => ({}) });
  assert.equal(svc.attach('up-1'), 'FOUND');
  assert.equal(svc.attach('nope'), null);
});

test('setTools：更新后下次 ask 用新清单', async () => {
  const taps = {};
  const mgr = fakeMgr(['answer:a', 'answer:b'], taps);
  const svc = createChatService({ mgr, tools: TOOLS, invoke: async () => ({}) });
  svc.setTools([{ name: 'site_index', description: '地图', inputSchema: { type: 'object', properties: {} } }]);
  await svc.ask(H, '问', () => {});
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
  const r = await svc.ask(H, '问');   // 不传 emit
  assert.equal(r.status, 'ok');
});

// ── C1 回归：upload 接缝签名（2026-10-25 审计）────────────────
//
// 旧实现：`createChatService({ upload })` 的参数被同文件的
// `function upload(sessionId, bytes, opts)` 声明提升覆盖，而工具会话按
// `(bytes, opts)` 两参调用 ⇒ sessionId 收到 Uint8Array、bytes 收到 {filename,mime}。
// 视觉链路从上线起就是坏的，而 chatsvc.test.mjs 里没有一条 upload 用例。
test('C1：upload(bytes, opts) 的字节原样到达 mgr.uploadImage（不被 id 挤位）', async () => {
  const taps = { uploads: [] };
  const HANDLE = { conversationId: 'up-1' };
  const mgr = {
    open() { return HANDLE; },
    async ask() { return { text: '好', status: 'ok', calls: [] }; },
    async uploadImage(h, bytes, opts) {
      taps.uploads.push({ h, bytesType: typeof bytes, bytesLen: bytes && bytes.length, opts });
      return { objectId: 'obj-c1', filePath: 'x' };
    },
    find() { return null; }, close() {},
  };
  const svc = createChatService({ mgr, tools: TOOLS, invoke: async () => ({ value: {} }) });
  const fi = await svc.upload(HANDLE, new Uint8Array([1, 2, 3]), { filename: 'a.png' });
  assert.equal(taps.uploads.length, 1);
  assert.equal(taps.uploads[0].h, HANDLE, '句柄原样透传（旧 bug：id 挤掉 bytes 的位置）');
  assert.equal(taps.uploads[0].bytesLen, 3, 'bytes 必须是原始字节，不是 {filename}');
  assert.equal(fi.objectId, 'obj-c1');
});

test('C1：createChatService 不再接受 upload 参数（防止同名遮蔽复发）', async () => {
  // 静态断言：参数列表里不许出现 upload
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./chatsvc.mjs', import.meta.url), 'utf8');
  const sig = src.slice(src.indexOf('export function createChatService'), src.indexOf(') {', src.indexOf('export function createChatService')));
  assert.doesNotMatch(sig, /\bupload\b\s*=\s*null/, 'createChatService 的签名里不许再有 upload 参数');
});
