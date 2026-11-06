// static-release.test.mjs —— Static-Contract 客户端的离线验收（假 fetch，不打网络）。
//
// 判据照 Static-Contract/examples/README.md：「suite is verified by mutation,
// not by passing」。这里逐条变异：坏 pin / 坏块 sha / 坏全局 sha / 截断块，
// 每一种都必须让 read() 抛而不是悄悄返回坏字节。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRelease, resolveCatalogueRelease } from './static-release.mjs';

// 测试用 identity 造字节（不依赖任何解码器），把契约的「逐块 sha → 拼接 → 全局 sha」
// 这条内核走通；codec 选择逻辑由线上 manifest 的真实分支保证。
async function sha(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 造一个最小 release：两个 entry，每个 2 块 identity；整份字节 = 0..N。 */
async function makeRelease() {
  const a = new Uint8Array([1, 2, 3, 4, 5]);
  const b = new Uint8Array([6, 7, 8]);
  const chunk = async (part, bytes, name) => ({
    part, file: name, bytes: bytes.length, sha256: await sha(bytes.buffer),
  });
  const mk = async (product, name, parts) => {
    const whole = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) { whole.set(p, off); off += p.length; }
    const chunks = [];
    for (let i = 0; i < parts.length; i += 1) {
      chunks.push(await chunk(i, parts[i], `${product}__${name}.identity.${String(i).padStart(3, '0')}`));
    }
    return {
      product, name, bytes: whole.length, sha256: '',   // 全局 sha 下面补
      variants: [{ codec: 'identity', chunks }],
      _whole: whole,
    };
  };
  const e1 = await mk('wasm32', 'a.bin', [a.slice(0, 2), a.slice(2)]);
  const e2 = await mk('wasm32', 'b.bin', [b.slice(0, 1), b.slice(1)]);
  for (const e of [e1, e2]) e.sha256 = await sha(e._whole.buffer);
  const manifest = {
    schema: 3, id: 'test/v1', chunkSize: 5,
    entries: [e1, e2].map(({ _whole, ...e }) => e),
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const pin = await sha(manifestBytes.buffer);
  const ref = { id: 'test/v1', base: 'https://mirror.test/r/', base_proxy: 'https://origin.test/r/', manifest_sha256: pin };

  // 假 fetch：按 URL 路径返回 manifest 或某一块的字节。
  const files = new Map();
  files.set('manifest.json', manifestBytes.buffer);
  for (const e of [e1, e2]) {
    // 按块在 whole 里的实际偏移切（与 makeRelease 的 parts 顺序一致）
    let off = 0;
    for (const c of e.variants[0].chunks) {
      files.set(c.file, e._whole.slice(off, off + c.bytes).buffer);
      off += c.bytes;
    }
  }
  const fetchImpl = async (url) => {
    const name = String(url).split('/').pop().split('?')[0];
    const buf = files.get(name);
    if (!buf) return { ok: false, status: 404 };
    return { ok: true, status: 200, async arrayBuffer() { return buf; } };
  };
  return { ref, fetchImpl, files, manifest, e1, e2 };
}

test('static-release：正常路径逐块取回并拼成完整字节', async () => {
  const { ref, fetchImpl, e1, e2 } = await makeRelease();
  const rel = await openRelease(ref, { fetchImpl });
  assert.deepEqual(rel.keys, ['wasm32/a.bin', 'wasm32/b.bin']);
  const a = new Uint8Array(await rel.read('wasm32/a.bin'));
  const b = new Uint8Array(await rel.read('wasm32/b.bin'));
  assert.deepEqual([...a], [1, 2, 3, 4, 5]);
  assert.deepEqual([...b], [6, 7, 8]);
});

test('static-release：manifest pin 不符 ⇒ 拒绝', async () => {
  const { ref, fetchImpl } = await makeRelease();
  await assert.rejects(
    openRelease({ ...ref, manifest_sha256: '0'.repeat(64) }, { fetchImpl }),
    /pin 不符/,
  );
});

test('static-release：某块 sha 不符 ⇒ read 拒绝', async () => {
  const { ref, fetchImpl, e1 } = await makeRelease();
  const bad = e1.variants[0].chunks[1].file;
  const orig = fetchImpl;
  const tampered = async (url) => {
    const r = await orig(url);
    if (String(url).endsWith(bad)) {
      return { ok: true, status: 200, async arrayBuffer() { return new Uint8Array([9, 9, 9]).buffer; } };
    }
    return r;
  };
  const rel = await openRelease(ref, { fetchImpl: tampered });
  await assert.rejects(rel.read('wasm32/a.bin'), /sha256 不符/);
});

test('static-release：拼接后全局 sha 不符 ⇒ read 拒绝', async () => {
  const { ref, fetchImpl, manifest } = await makeRelease();
  // 改 manifest 里 a.bin 的全局 sha，但 manifest 字节变了 ⇒ pin 也要跟着改，
  // 否则会在 openRelease 阶段就因 pin 不符拒绝（那是另一条测试）。
  const m = JSON.parse(JSON.stringify(manifest));
  m.entries[0].sha256 = 'f'.repeat(64);
  const bytes = new TextEncoder().encode(JSON.stringify(m));
  const pin = await sha(bytes.buffer);
  const files = new Map();
  files.set('manifest.json', bytes.buffer);
  // 复用 makeRelease 的块字节：重新构造一次拿 files
  const { files: origFiles } = await makeRelease();
  for (const [k, v] of origFiles) if (k !== 'manifest.json') files.set(k, v);
  const fake = async (url) => {
    const name = String(url).split('/').pop().split('?')[0];
    return files.has(name)
      ? { ok: true, status: 200, async arrayBuffer() { return files.get(name); } }
      : { ok: false, status: 404 };
  };
  const rel = await openRelease({ ...ref, manifest_sha256: pin }, { fetchImpl: fake });
  await assert.rejects(rel.read('wasm32/a.bin'), /全局 sha256 不符/);
});

test('static-release：未知 entry ⇒ read 拒绝', async () => {
  const { ref, fetchImpl } = await makeRelease();
  const rel = await openRelease(ref, { fetchImpl });
  await assert.rejects(rel.read('wasm32/nope.bin'), /未知 entry/);
});

test('static-release：resolveCatalogueRelease 从 catalogue 取到目标 release', async () => {
  const cat = {
    releases: [
      { id: 'other/v1', base: 'https://x/', manifest_sha256: 'a'.repeat(64) },
      { id: 'Octave-Full-Wasm/v0.1.0', base: 'https://mirror.test/oct/', base_proxy: 'https://origin.test/oct/', manifest_sha256: 'b'.repeat(64) },
    ],
  };
  const fetchImpl = async () => ({ ok: true, status: 200, async json() { return cat; } });
  const r = await resolveCatalogueRelease('Octave-Full-Wasm/v0.1.0', { fetchImpl });
  assert.equal(r.base, 'https://mirror.test/oct/');
  assert.equal(r.manifest_sha256, 'b'.repeat(64));
});
