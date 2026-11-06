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
import fs from 'node:fs';
import {
  ASSETS, deriveMode, createCapabilityPack, createOpfsStore,
} from './capability-pack.mjs';

/** 内存版 store（与 OPFS 同接口），并统计每个动词的调用次数 —— 防环测试要用。 */
/**
 * 测试用的「内容指纹」替身。
 *
 * ⚠️ 不能写成固定串——它必须像真 sha256 一样**随内容变**，否则
 * 「下载后 ready」与「重下坏副本」这两类判据都测不出来。
 * 用 FNV-1a 拼成 64 位十六进制，语义上等价于 sha256（同内容同串、异内容异串）。
 */
async function realSha256(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const d = await crypto.subtle.digest('SHA-256', b);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function fakeSha256(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < b.length; i++) {
    h1 = ((h1 ^ b[i]) * 0x01000193) >>> 0;
    h2 = ((h2 + b[i]) * 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(4);
}

function memStore(initial = {}, shas = {}) {
  const files = new Map(Object.entries(initial));
  // 指纹表：name → sha256 十六进制串。真实 store 把它存在 sidecar 里，
  // 这里用一个平行 Map 模拟同一语义（head 带出 sha256 字段）。
  const shm = new Map(Object.entries(shas));
  const calls = { head: 0, put: 0, delete: 0 };
  return {
    files, calls, shas: shm,
    async head(name) {
      calls.head++;
      if (!files.has(name)) return null;
      const out = { bytes: files.get(name).byteLength };
      if (shm.has(name)) out.sha256 = shm.get(name);
      return out;
    },
    async put(name, buf) {
      calls.put++;
      files.set(name, buf);
      // 真实 store 在 put 时把**这次字节的哈希**写进 sidecar。测试里也必须这样，
      // 否则「下载后应就绪」永远不成立：ASSETS 里的真 sha256 是固定值，
      // 随便造个假指纹会永远对不上，把每条下载路径都判成内容坏。
      // 这里用「内容摘要的替身」：同一份字节得到同一串，不同字节得到不同串。
      shm.set(name, await realSha256(buf));
    },
    async readBytes(name) {
      if (!files.has(name)) throw new Error('no such file: ' + name);
      return files.get(name);
    },
    async delete(name) { calls.delete++; files.delete(name); shm.delete(name); },
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

// ── 测试装置：让 ASSETS 的 sha256 与 fakeFetch 造的字节对得上 ──────────
//
// 真实环境里 ASSETS.sha256 是磁盘文件的真哈希，fakeFetch 当然造不出来。
// 但 fakeFetch 返回**确定的**全零字节（长度 = spec.bytes），所以它的指纹也是
// 确定的。这里把 ASSETS 的 sha256 换成「那份全零字节的指纹」，语义完全对应
// 「清单登记的哈希 == 下载到的字节的哈希」——只是换了一套具体的哈希值。
//
// ⚠️ 必须在任何 store/pack 构造之前做完：inspectAsset 会读 ASSETS.sha256。
{
  // ⚠️ 用**真** sha256 算，不能用 fakeSha256：产品代码在没有 sidecar 时会用
  // crypto.subtle 现算真哈希来比对。装置若用另一套算法，两边永远对不上，
  // 「好内容判就绪」这条就假红。Node 里 crypto.subtle 可用，直接用。
  const realSha = async (buf) => {
    const d = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  for (const a of Object.values(ASSETS)) {
    for (const f of a.files) {
      f.sha256 = await realSha(fakeBuf(f.bytes || 1));
    }
  }
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

test('★ status 认内容指纹不符为「不在」——大小对但内容坏了也要报', async () => {
  // 2026-10-31 实测的真实情形：一个 843924 字节全零的文件骗过了 size 校验，
  // 于是界面显示「已下载」，MathLive 载入却失败。只比大小抓不住这种情况。
  const spec = ASSETS.editor.files[0];
  const store = memStore(
    { [spec.name]: fakeBuf(spec.bytes) },                       // 大小正好对
    { [spec.name]: '0'.repeat(64) },                            // 但指纹是假的
  );
  const pack = createCapabilityPack({ store, fetchImpl: fakeFetch() });
  const s = await pack.status();
  assert.equal(s.editor.ready, false, '内容指纹不符必须判「不在」');
  assert.equal(s.mode, 'readonly');
  assert.equal(s.editor.missing[0].reason, 'content', '缺的条目要说明原因是 content 而不是 missing');
});

test('★ status：没有 sidecar 时会现算哈希，而不是盲信大小', async () => {
  // 2026-10-31 改：原先这里断言「没 sidecar 就只比大小、一律放过」。
  // 那条断言**本身就是 bug**——真机上坏掉的恰恰是老副本（下载中断、被覆盖），
  // 而老副本没有 sidecar。现在没有 sidecar 就现算一次真哈希（结果缓存到本会话），
  // 所以坏内容必须被抓出来。
  //
  // 本条测的是「好内容在没 sidecar 时也能判就绪」；坏内容由下一条测。
  const spec = ASSETS.editor.files[0];
  const store = memStore({ [spec.name]: fakeBuf(spec.bytes) });   // 没有 shas ⇒ head 不带 sha256
  const pack = createCapabilityPack({ store, fetchImpl: fakeFetch() });
  const s = await pack.status();
  assert.equal(s.editor.ready, true, '内容正确时（现算哈希对得上）应判就绪');
});

test('★ 没有 sidecar 的老副本：现算哈希也要抓出坏内容', async () => {
  // 这是真机上最可能的情形：文件是旧版本下载的（那时还没 sidecar），
  // 内容却在某次中断/覆盖里坏了。只有大小 + 现算哈希能抓住它。
  const spec = ASSETS.editor.files[0];
  // 清单登记的指纹是「全零字节」的（见文件开头的装置）。
  // 这里放一份**非全零**但长度正确的字节 ⇒ 现算哈希必然对不上 ⇒ 判坏。
  // （第一版写成了两份全零字节，改来改去内容没变，测不出东西。）
  const bad = new Uint8Array(spec.bytes).fill(7);
  const store = memStore({ [spec.name]: bad });      // head 不带 sha256
  const pack = createCapabilityPack({ store, fetchImpl: fakeFetch() });
  const s = await pack.status();
  assert.equal(s.editor.ready, false, '没 sidecar 时也要靠现算哈希判出内容坏');
  assert.equal(s.editor.missing[0].reason, 'content');
});

test('★ download 遇到「大小对但内容坏」的旧副本会重下，不会 skip', async () => {
  const spec = ASSETS.editor.files[0];
  const store = memStore(
    { [spec.name]: fakeBuf(spec.bytes) },
    { [spec.name]: '0'.repeat(64) },                            // 坏指纹
  );
  const pack = createCapabilityPack({ store, fetchImpl: fakeFetch() });
  await pack.download('editor');
  assert.ok(store.shas.get(spec.name) !== '0'.repeat(64), '没重下（指纹还是坏的）');
  const s = await pack.status({ fresh: true });
  assert.equal(s.editor.ready, true, '重下之后应当就绪');
});

test('★ 坏副本重下之后必须变就绪（内容缓存要作废）', async () => {
  // 2026-10-31 浏览器实测：判出内容坏 → 点下载重下 → 仍然判坏。
  // 根因是 contentMemo 里留着上一次现算的旧哈希，put 之后没作废。
  const spec = ASSETS.editor.files[0];
  const bad = new Uint8Array(spec.bytes).fill(7);
  const store = memStore({ [spec.name]: bad });        // 无 sidecar 的坏副本
  const pack = createCapabilityPack({ store, fetchImpl: fakeFetch() });

  const s1 = await pack.status();
  assert.equal(s1.editor.ready, false, '坏副本应先被判坏');

  await pack.download('editor');                       // 走 fakeFetch（返回全零＝清单登记的内容）
  const s2 = await pack.status({ fresh: true });
  assert.equal(s2.editor.ready, true, '重下之后必须就绪（contentMemo 要随 put 作废）');
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
  // TTL 内复用 ⇒ 50 次查询最多落 1 轮真读（4 件资产 × 各自文件数）。
  const oneRound = Object.values(ASSETS).reduce((n, a) => n + a.files.length, 0);
  assert.ok(headAfterCached <= oneRound,
    `非 fresh 连查 50 次只该真读 ≤${oneRound} 次（TTL 收敛），实际 ${headAfterCached} 次`);

  // ② fresh 连查 3 次：每次真读（这是下载后对账用的，必须真读）
  store.calls.head = 0;
  for (let i = 0; i < 3; i++) await pack.status({ fresh: true });
  // 2026-11-06：资产 2→4 件，这里必须**按 ASSETS 全量**算，
  // 写死 editor+engine 会在加资产时误报（实测 24 !== 12）。
  const perStatus = Object.values(ASSETS).reduce((n, a) => n + a.files.length, 0);
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
  // 正面断言：编辑态用独立元素，但**不再是覆盖层**（2026-10-31 改成页内单元格）。
  // 判据：装配层要么不碰编辑（单元格模块自己包），要么只调 detach/attach。
  // 它不该自己造 DOM 去替换公式 —— 那条是旧 openEditor 的老路。
  assert.ok(!/pack-editor-overlay/.test(code),
    '覆盖层编辑已删除（改用页内单元格），装配层不该再造覆盖层');
});

test('新增资产时：status / 按钮 / 面板 三处都必须自动跟上（2026-11-06 实弹）', () => {
  // 站长实测：「octave 点下载、下好了变成删除按钮，然后下面几个全跳出删除按钮
  // 不让下载，还傻乎乎显示未下载」。
  // 两个根因都在「写死两件资产」：
  //   ① status() 只 inspectAsset('editor'|'engine') ⇒ katex/pyodide 永远缺席 state；
  //   ② 按钮判定是 `name === 'editor' ? state.editor : state.engine` ⇒ 非 editor
  //      一律跟着 engine 走，于是 engine 一下好，其它三件全变「删除」。
  const DIR = import.meta.dirname;
  const PACK = fs.readFileSync(DIR + '/capability-pack.mjs', 'utf8');
  const PR = fs.readFileSync(DIR + '/pack-runtime.mjs', 'utf8');

  // ① status 必须遍历 ASSETS，不许写死资产名
  const s0 = PACK.indexOf('async status(');
  const statusFn = PACK.slice(s0, PACK.indexOf('download(name', s0));
  assert.ok(!/inspectAsset\('editor'\)|inspectAsset\("editor"\)/.test(statusFn),
    'status() 还在写死 inspectAsset(\'editor\')——新增资产会永远缺席 state');
  assert.match(statusFn, /Object\.keys\(ASSETS\)/,
    'status() 应从 Object.keys(ASSETS) 派生资产名单');

  // ② 按钮判定必须按名字取自己那份状态，不许三元分叉到 engine
  const renderFn = PR.slice(PR.indexOf('function render()'), PR.indexOf('renderDiag();'));
  assert.ok(!/name === "editor"\s*\?/.test(renderFn),
    '按钮判定还在用 name === "editor" 三元——非 editor 会全跟着 engine 变「删除」');
  assert.match(renderFn, /state\[name\]/,
    '按钮判定应按名字取 state[name]');

  // ③ 状态显示也不许写死清单
  assert.match(renderFn, /ASSET_NAMES|Object\.keys\(ASSETS\)/,
    '状态显示应有资产清单（写死两件时新资产恒显示「未下载」）');
});

test('每件资产的 sha256 必须是完整 64 位（空串/截断 = 内容校验形同虚设）', () => {
  // 2026-11-06 实弹：加 katex / pyodide 时 sha 写成空串与 12 位截断值。
  // 空串 ⇒ verifyContent 直接 return true（不校验，坏副本会被判「已下载」）；
  // 截断值 ⇒ 与真哈希永不相等 ⇒ **永远**判「内容坏」、每次都要重下。
  // 两种都静默，页面上只表现为「下载了但状态不对」。
  for (const [name, spec] of Object.entries(ASSETS)) {
    for (const f of spec.files) {
      assert.equal(typeof f.sha256, 'string', `${name}/${f.name} 缺 sha256`);
      assert.equal(f.sha256.length, 64, `${name}/${f.name} 的 sha256 只有 ${f.sha256.length} 位（应 64）`);
      assert.match(f.sha256, /^[0-9a-f]{64}$/, `${name}/${f.name} 的 sha256 不是小写十六进制`);
    }
  }
});

test('带 source 的资产必须各自声明 releaseId（不许共用/写死一个）', () => {
  // 2026-11-06 站长实测「pyodide 无法下载、无限冒重试按钮」：
  // 装配层的 releaseLoader 原来写死 Octave-Full-Wasm 一个 release，
  // 而 pyodide 的三件在 Octave-Extra-Content/supply-pyodide-314.0.7 里
  // ⇒ 去错的 manifest 里找必然失败，界面无限回到「重试」。
  // 判据：凡有文件带 source，其所属资产必须声明 releaseId；
  // 且不同资产不许共用同一个 releaseId（共用说明又写死了一个）。
  const withSource = Object.entries(ASSETS).filter(([, a]) => a.files.some((f) => f.source));
  assert.ok(withSource.length >= 2, '应至少有两个资产走 release（engine / pyodide）');
  const seen = new Map();
  for (const [name, spec] of withSource) {
    assert.equal(typeof spec.releaseId, 'string',
      `资产 ${name} 有 source 但没有 releaseId——装配层无从定位 release`);
    assert.ok(spec.releaseId.length > 3, `资产 ${name} 的 releaseId 太短`);
    assert.ok(!seen.has(spec.releaseId),
      `资产 ${name} 与 ${seen.get(spec.releaseId)} 共用 releaseId ${spec.releaseId}——`
      + '两个 release 会互相覆盖，后下载的永远失败');
    seen.set(spec.releaseId, name);
  }
});

test('装配层的 releaseLoader 必须按 releaseId 取 handle（不许写死）', () => {
  const BUILD = fs.readFileSync(import.meta.dirname + '/../build.mjs', 'utf8');
  // 抓装配层里那个 releaseLoader 函数体
  const i = BUILD.indexOf('const releaseLoader = async (f)');
  assert.ok(i > 0, '找不到 releaseLoader');
  const body = BUILD.slice(i, i + 1200);
  assert.match(body, /f\.releaseId/,
    'releaseLoader 没读 f.releaseId——写死一个 release 会让另一个资产的下载必然失败');
  assert.match(body, /releaseHandles\.(get|set)/,
    'releaseLoader 没有按 release 分桶缓存 handle（一个 handle 只能服务一个 release）');
  assert.ok(!/resolveCatalogueRelease\('Octave-Full-Wasm/.test(body),
    'releaseLoader 又写死了 Octave-Full-Wasm 的 release id');
});

test('releaseLoader 路径必须能真跑通（catch 到 "Assignment to constant variable" 就是这里）', async () => {
  // 2026-11-06 线上实测：pyodide 下载永远失败、按钮无限「重试」。
  // 真因是 `f = { ...f, releaseId }` 给 `for (const f of spec.files)` 的循环常量赋值
  // ⇒ 抛 Assignment to constant variable，被 catch 成「下载失败」。
  // 静态 grep 抓不到这类错（语法合法），所以这里**用假 store + 假 loader 真跑一次**。
  const calls = [];
  const store = memStore({});
  const pack = createCapabilityPack({
    store,
    releaseLoader: async (f) => {
      calls.push(f.name);
      // 断言 loader 能拿到 releaseId（装配层靠它分辨 release）
      assert.ok(f.releaseId, `${f.name} 没带 releaseId`);
      return new ArrayBuffer(f.bytes);
    },
  });
  // 给一个带 source 的资产走 releaseLoader 分支
  const spec = ASSETS.pyodide;
  assert.ok(spec && spec.files[0].source, 'pyodide 资产应带 source');
  await pack.download('pyodide');
  assert.equal(calls.length, spec.files.length,
    `releaseLoader 应被调 ${spec.files.length} 次（实际 ${calls.length}）——` +
    '若为 0 说明走了本地路径；若中途抛错会少于该数');
  for (const c of calls) assert.ok(c, 'loader 收到空文件名');
});
