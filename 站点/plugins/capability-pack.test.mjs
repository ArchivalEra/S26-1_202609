// capability-pack 的测试。
//
// 这一份的重点不是「功能对不对」（那部分直白），而是**三条结构性防御**——
// 它们对应 Octave-UI 踩过最狠的那个坑（回信 §三 A8）：
//
//   「查询触发查询」的自我放大环：订阅存储变化 → 查状态 → list() → refresh()
//   → 无条件 notify() → 又通知订阅者 → 回到起点。实测一次启动 checkPhysicalStatus
//   被调 39,803 次，RSS 以 8.9 MB/s 无界爬升到浏览器崩溃，而 JS 堆看着正常
//   （增长在 wasm 线性内存，不在 JS 堆）。
//
// 我们的状态机与他们完全同形（订阅 → 查状态 → 写存储 → 通知），所以必须把
// 那三条防御钉成测试，而不是写在注释里靠自觉。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSETS, deriveMode, createCapabilityPack, createOpfsStore,
} from './capability-pack.mjs';

/** 内存版 store（与 OPFS 同接口），并统计每个动词的调用次数 —— 防环测试要用。 */
function memStore(initial = {}) {
  const files = new Map(Object.entries(initial));
  const calls = { head: 0, put: 0, delete: 0 };
  return {
    files, calls,
    async head(name) { calls.head++; return files.has(name) ? { bytes: files.get(name).byteLength } : null; },
    async put(name, buf) { calls.put++; files.set(name, buf); },
    async delete(name) { calls.delete++; files.delete(name); },
  };
}

/** 造一个大小正确但内容随意的 buffer（size 校验会比对 bytes）。 */
const fakeBuf = (n) => new Uint8Array(n);

/** 假 fetch：按 path 返回正确大小的 buffer。 */
function fakeFetch() {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const spec = Object.values(ASSETS).flatMap((a) => a.files).find((f) => url.endsWith(f.path));
    if (!spec) return { ok: false, status: 404 };
    return {
      ok: true, status: 200,
      async arrayBuffer() { return fakeBuf(spec.bytes || 1).buffer; },
    };
  };
  impl.calls = calls;
  return impl;
}

test('deriveMode：三态由两件资产的 ready 派生', () => {
  const A = (ready) => ({ ready });
  assert.equal(deriveMode({ editor: A(false), engine: A(false) }), 'readonly');
  assert.equal(deriveMode({ editor: A(true), engine: A(false) }), 'editable');
  assert.equal(deriveMode({ editor: A(true), engine: A(true) }), 'computable');
  // 引擎在位但编辑器不在：现实中不该出现（引擎依赖编辑器才有意义），
  // 但仍然不许判成 computable —— 那会让 UI 显示一个点不开的「运行」。
  assert.equal(deriveMode({ editor: A(false), engine: A(true) }), 'readonly');
});

test('status：全新环境是只读，且 ready 逐件派生', async () => {
  const store = memStore();
  const pack = createCapabilityPack({ store, fetchImpl: fakeFetch() });
  const s = await pack.status();
  assert.equal(s.mode, 'readonly');
  assert.equal(s.editor.ready, false);
  assert.equal(s.engine.ready, false);
  assert.equal(s.editor.total, ASSETS.editor.files.length);
});

test('status 认大小不符为「不在」——不是有文件就算数', async () => {
  // 用户清了存储、或下载到一半 —— 只剩一个错尺寸的残file。
  // 只按「文件存在」判会报 ready，然后 compute 时炸在 wasm 编译上。
  const store = memStore({
    [ASSETS.editor.files[0].name]: fakeBuf(100),   // 尺寸显然不对
  });
  const pack = createCapabilityPack({ store, fetchImpl: fakeFetch() });
  const s = await pack.status();
  assert.equal(s.editor.ready, false, '尺寸不符必须判「不在」');
  assert.equal(s.mode, 'readonly');
});

test('★ 防环①：status() 是纯读——不写存储、不触发订阅回调', async () => {
  const store = memStore();
  let fired = 0;
  const pack = createCapabilityPack({ store, fetchImpl: fakeFetch(), onState: () => fired++ });
  let subFired = 0;
  pack.subscribe(() => subFired++);
  await new Promise((r) => setTimeout(r, 0));   // 订阅会异步给一次初始状态

  const baseFired = fired, baseSub = subFired;

  // ① 非 fresh 连查 50 次：TTL 应把它们收敛成一次真实读（否则就是 N 次，环的形状）
  store.calls.head = 0;
  for (let i = 0; i < 50; i++) await pack.status();
  const headAfterCached = store.calls.head;
  assert.ok(headAfterCached <= 4,
    `非 fresh 连查 50 次只该真读 ≤4 次（TTL 收敛），实际 ${headAfterCached} 次`);

  // ② fresh 连查 3 次：每次真读（这是下载后对账用的，必须真读）
  store.calls.head = 0;
  for (let i = 0; i < 3; i++) await pack.status({ fresh: true });
  const perStatus = ASSETS.editor.files.length + ASSETS.engine.files.length;
  assert.equal(store.calls.head, 3 * perStatus, `fresh 每次都该真读（每次 ${perStatus} 个文件各一次 head）`);

  // ③ 无论查多少次，都不许写存储、不许发通知
  assert.equal(store.calls.put, 0, 'status 不许写存储');
  assert.equal(store.calls.delete, 0, 'status 不许删存储');
  assert.equal(fired, baseFired, 'status 不许触发 onState');
  assert.equal(subFired, baseSub, 'status 不许触发订阅回调');
});

test('★ 防环②③：只有派生状态真变才广播；相同状态重复广播被压掉', async () => {
  const store = memStore();
  const fetchImpl = fakeFetch();
  let fired = 0;
  const pack = createCapabilityPack({ store, fetchImpl, onState: () => fired++ });
  let subFired = 0;
  pack.subscribe(() => subFired++);
  await new Promise((r) => setTimeout(r, 0));

  const f0 = fired, s0 = subFired;

  // 第一次下载编辑器 ⇒ 状态变了 ⇒ 广播一次
  await pack.download('editor');
  assert.equal(fired, f0 + 1, '状态从 readonly→editable，应广播恰好一次');
  assert.equal(subFired, s0 + 1);

  const f1 = fired, s1 = subFired;

  // 再下载同一个（已在位）⇒ 状态没变 ⇒ **不许**再广播
  await pack.download('editor');
  assert.equal(fired, f1, '状态没变就不许广播（这是环的入口）');
  assert.equal(subFired, s1);

  // 直接再 status 若干次，同样不许广播
  for (let i = 0; i < 20; i++) await pack.status({ fresh: true });
  assert.equal(fired, f1, '重复查状态不许广播');
});

test('★ 防环判据（照抄 Octave-UI）：一次正常操作，查询次数 ≤ 常数；静置再来一轮不增长', async () => {
  const store = memStore();
  const pack = createCapabilityPack({ store, fetchImpl: fakeFetch() });
  let subFired = 0;
  pack.subscribe(() => subFired++);
  await new Promise((r) => setTimeout(r, 0));

  // 一轮「正常用户操作」：下载编辑器 → 再下载引擎 → 查两次状态
  const round = async () => {
    store.calls.head = 0;
    const before = subFired;
    await pack.download('editor');
    await pack.download('engine');
    await pack.status();
    await pack.status();
    return { head: store.calls.head, fired: subFired - before };
  };

  const r1 = await round();
  const r2 = await round();

  // head 的调用次数必须是个小常数（资产文件数 × 少量次数），不是随轮次累积增长。
  assert.ok(r1.head <= 20, `一轮正常操作 head 调用 ${r1.head} 次，超出常数上限`);
  assert.equal(r2.head, r1.head, '静置后再来一轮，查询次数不许增长（这是环的判据）');
  assert.equal(r2.fired, 0, '第二轮状态没变，不许有任何广播');
});

test('download：大小不符直接拒，且不把坏字节写进存储', async () => {
  const store = memStore();
  const badFetch = async () => ({
    ok: true, status: 200,
    async arrayBuffer() { return fakeBuf(10).buffer; },   // 故意给错尺寸
  });
  const pack = createCapabilityPack({ store, fetchImpl: badFetch });
  await assert.rejects(() => pack.download('editor'), (e) => e.code === 'SIZE_MISMATCH');
  assert.equal(store.calls.put, 0, '坏字节不许进存储');
});

test('download：HTTP 失败抛 DOWNLOAD_FAILED 且带状态码', async () => {
  const store = memStore();
  const pack = createCapabilityPack({ store, fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(() => pack.download('editor'), (e) => e.code === 'DOWNLOAD_FAILED' && e.status === 503);
});

test('download：失败后 inflight 被清掉 —— 可以重试（不会永久卡住）', async () => {
  const store = memStore();
  let n = 0;
  const flaky = async (url) => {
    n++;
    if (n === 1) return { ok: false, status: 500 };
    const spec = Object.values(ASSETS).flatMap((a) => a.files).find((f) => url.endsWith(f.path));
    return { ok: true, status: 200, async arrayBuffer() { return fakeBuf(spec.bytes || 1).buffer; } };
  };
  const pack = createCapabilityPack({ store, fetchImpl: flaky });
  await assert.rejects(() => pack.download('editor'));
  // 第二次必须真的重试，而不是复用那个已失败的 Promise
  const s = await pack.download('editor');
  assert.equal(s.editor.ready, true, '失败后应能重试成功');
});

test('download：同资产并发调用复用同一个 Promise（不重复下载）', async () => {
  const store = memStore();
  const fetchImpl = fakeFetch();
  const pack = createCapabilityPack({ store, fetchImpl });
  await Promise.all([pack.download('editor'), pack.download('editor'), pack.download('editor')]);
  assert.equal(fetchImpl.calls.length, ASSETS.editor.files.length, '并发三次只该真下载一遍');
});

test('compute：引擎不在位抛 ENGINE_NOT_READY；在位则转给注入的 evaluate', async () => {
  const store = memStore();
  const pack = createCapabilityPack({ store, fetchImpl: fakeFetch() });
  await assert.rejects(() => pack.compute('1+1'), (e) => e.code === 'ENGINE_NOT_READY');

  await pack.download('engine');
  // 只下了引擎、没下编辑器 ⇒ 仍是只读态，compute 仍应拒绝（引擎单独没有意义）
  await assert.rejects(() => pack.compute('1+1'), (e) => e.code === 'ENGINE_NOT_READY');

  await pack.download('editor');
  const pack2 = createCapabilityPack({
    store, fetchImpl: fakeFetch(),
    evaluate: async (code) => ({ ok: true, output: `ran:${code}` }),
  });
  const r = await pack2.compute('disp(42)');
  assert.equal(r.output, 'ran:disp(42)');
});

test('remove：删掉资产后状态回落，且广播一次', async () => {
  const store = memStore();
  const pack = createCapabilityPack({ store, fetchImpl: fakeFetch() });
  let fired = 0;
  pack.subscribe(() => fired++);
  await new Promise((r) => setTimeout(r, 0));

  await pack.download('editor');
  const f1 = fired;
  const s = await pack.remove('editor');
  assert.equal(s.mode, 'readonly');
  assert.equal(fired, f1 + 1, '状态回落应广播一次');
});

test('createOpfsStore：没有 OPFS 的环境给出明确错误码（不静默）', async () => {
  const store = createOpfsStore();
  // Node 里没有 navigator.storage.getDirectory
  const r = await store.head('x');
  assert.equal(r, null, 'head 在无 OPFS 时应返回 null（表示「不在」），而不是抛');
  await assert.rejects(() => store.put('x', new Uint8Array(1)), (e) => e.code === 'OPFS_UNSUPPORTED');
});

// ── 结构约束：能力包不许改动 MCP 的读面（2026-10-30 站长定案「mcp 工具兼容」）──
//
// 站内 11 个工具读公式靠两样构建期产物：
//   ① `.ML__latex` 容器（site_read 的正文渲染跳过它，只看 data-math-plain）
//   ② `data-math-plain`（IR 的纯文本投影，site_read / site_search 直接读）
// 能力包一旦「替换」公式节点（比如把 .ML__latex 换成 <math-field>），这两样就没了，
// 所有工具静默退化——页面看着正常，AI 读不到公式。
//
// 所以编辑态必须是**覆盖层**，不是替换。这条只能靠读源码结构来守：
// 断言 pack-runtime 里不含对 .ML__latex 的写入（replaceWith / innerHTML / remove）。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('★ 装配层不许改动公式节点（MCP 读面必须是只读的旁路）', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, 'pack-runtime.mjs'), 'utf8');
  // 剥注释后再判：注释里会正当地提到这些 API 名字
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  for (const bad of ['replaceWith', 'outerHTML', 'insertAdjacentHTML']) {
    assert.ok(!new RegExp('\\b' + bad + '\\b').test(code),
      `装配层出现了 ${bad} —— 那是替换既有节点的手法，会破坏 MCP 的读面`);
  }
  // .ML__latex 只许**读**（querySelectorAll / closest / getAttribute），
  // 不许作为写入目标（.ML__latex 后面紧跟赋值或 remove）。
  assert.ok(!/\.ML__latex[\s\S]{0,40}?\.remove\(/.test(code), '不许 remove 公式容器');
  assert.ok(!/querySelectorAll\(['"]\.ML__latex['"]\)[\s\S]{0,80}?\.innerHTML\s*=/.test(code),
    '不许写公式容器的 innerHTML');
  // 正面断言：编辑态用的是独立元素
  assert.ok(code.includes('pack-editor-overlay'), '编辑态应是独立覆盖层');
});
