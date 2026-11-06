/**
 * static-release.mjs —— 从 Static-Contract 镜像拉取大包的**最小浏览器客户端**。
 *
 * ## 为什么存在
 *
 * 能力包（capability-pack.mjs）原先从本站 `assets/octave/*` 拉三个大文件
 * （octave.wasm 29.6 MB、octave.data 9.7 MB、octave.js 0.46 MB）到 OPFS。
 * 但 EdgeOne Pages 对**单文件**有 25 MB 硬上限，且这些二进制从未进仓库
 * （`.gitignore` 精确白名单没有它们，CI 的 dist 里其实没有）——本地能跑只是
 * 因为本机磁盘上有历史副本被 `copyDir` 拷进了 dist。
 *
 * Static-Contract（mail/071，2026-11-06 整改完成）把每个 release 切成 ≤5 MiB
 * 的独立 chunk，逐块带 sha256，manifest 按 release 固定。本模块照
 * `Static-Contract/examples/fetch-concurrent.ts` 的契约实现一个最小消费端：
 * 拉 manifest → 校验 pin → 选可解码的 codec → 并发拉 chunk → 逐块验 sha
 * → 逐块解码 → 拼接 → 验全局 sha → 交回完整字节。
 *
 * ## 与参考客户端的差异（刻意的）
 *
 * 参考客户端是通用库（重试策略、健康账本、codecPreference、readAll 流式……）。
 * 这里只服务一个固定用途：把 Octave 三件套取回 OPFS。所以：
 *   · 不引 fzstd —— **优先 gzip**（浏览器原生 `DecompressionStream('gzip')`），
 *     zstd 仅当平台原生支持时才用，identity 最后保底；零外部依赖。
 *   · 不做 RootHealth 的复杂账本：base 不通就换 base_proxy，每个 chunk 3 次尝试。
 *   · 并发固定 2（镜像在 ~10–15 MiB in-flight 时会限速，5 MiB × 2 = 10 MiB 安全）。
 *   · **每块 sha + 全局 sha 两道都留着**，这是契约的安全内核，不省。
 *
 * ## 端点
 *
 * catalogue: https://static.isui.ren/catalogue.json（EdgeOne，取 release 的
 * base / base_proxy / manifest_sha256）；manifest 与各 chunk 都在 base 下。
 * 本模块**不硬编码 catalogue**：站点侧把需要的 release 描述（含 pin）烘成常量，
 * 运行时只用 base + pin——pin 不匹配立即拒绝，不给投毒留缝。
 */

const CATALOGUE_URL = 'https://static.isui.ren/catalogue.json';
const CONCURRENCY = 2;
const ATTEMPTS = 3;

/** 解析根：base 先，base_proxy 兜底（canon §5.3）。 */
function rootsOf(ref) {
  return [ref.base, ref.base_proxy].filter((x) => typeof x === 'string' && x.length);
}

function joinUrl(root, file) {
  return root.endsWith('/') ? root + file : root + '/' + file;
}

async function sha256Hex(buf) {
  const got = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(got)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 这个运行时能不能解某个 codec。
 * `DecompressionStream` 的构造函数本身就是探针（canon V9）：
 * 平台不支持 zstd 时 `new DecompressionStream('zstd')` 会抛。
 */
function canDecode(codec) {
  if (codec === 'identity') return true;
  try {
    new DecompressionStream(codec);
    return true;
  } catch {
    return false;
  }
}

async function decodeChunk(codec, bytes) {
  if (codec === 'identity') return new Uint8Array(bytes);
  const ds = new DecompressionStream(codec);
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function httpGet(url, signal, get) {
  const res = await get(url, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.arrayBuffer();
}

/** 一个 URL 在多个根上取：base 三次不通才换 proxy。 */
async function fetchAcrossRoots(roots, file, signal, expectBytes, get) {
  let lastErr;
  for (const root of roots) {
    for (let i = 0; i < ATTEMPTS; i += 1) {
      try {
        const buf = await httpGet(joinUrl(root, file), signal, get);
        if (expectBytes != null && buf.byteLength !== expectBytes) {
          throw new Error(`字节数不符：期望 ${expectBytes}，实收 ${buf.byteLength}`);
        }
        return buf;
      } catch (e) {
        lastErr = e;
        if (signal?.aborted) throw e;
      }
    }
  }
  throw lastErr || new Error(`取 ${file} 失败`);
}

/**
 * 打开一个 release：拉 manifest、校验 pin、按 codec 可解码性排好每个 entry 的分支。
 * @param {{id:string, base:string, base_proxy?:string, manifest_sha256:string}} ref
 * @param {{signal?:AbortSignal, fetchImpl?:function}} [o]
 */
export async function openRelease(ref, o = {}) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('static-release: 需要 crypto.subtle（https / localhost）');
  }
  const roots = rootsOf(ref);
  if (!roots.length) throw new Error(`static-release: release ${ref.id} 没有 fetch 根`);

  const get = o.fetchImpl || fetch;
  const raw = await fetchAcrossRoots(roots, 'manifest.json', o.signal, null, get);
  const pin = await sha256Hex(raw);
  if (pin !== ref.manifest_sha256.toLowerCase()) {
    throw new Error(`static-release: manifest sha256 与 catalogue pin 不符（${pin}）`);
  }
  const manifest = JSON.parse(new TextDecoder().decode(raw));

  const entries = new Map();
  for (const e of manifest.entries || manifest.products || []) {
    const key = `${e.product}/${e.name}`;
    // codec 顺序：gzip 优先（全平台可解、体积小），再 zstd（仅当平台支持），
    // identity 保底——与参考客户端「按 manifest 顺序选第一个可解码」语义一致，
    // 只是把消费者偏好写死在这里，避免为一次用途引入 codecPreference 参数面。
    const order = ['gzip', 'zstd', 'identity'];
    const variant = order
      .map((codec) => e.variants.find((v) => v.codec === codec))
      .find((v) => v && canDecode(v.codec));
    if (!variant) throw new Error(`static-release: ${key} 没有可解码的分支`);
    entries.set(key, { info: e, variant });
  }

  /** 取一个 entry 的完整字节（逐块校验 + 拼接 + 全局校验）。 */
  async function read(key) {
    const planned = entries.get(key);
    if (!planned) throw new Error(`static-release: 未知 entry ${key}`);
    const { info, variant } = planned;
    const chunks = [...variant.chunks].sort((a, b) => a.part - b.part);
    const parts = new Array(chunks.length);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= chunks.length) return;
        const c = chunks[i];
        const encoded = await fetchAcrossRoots(roots, c.file, o.signal, c.bytes, get);
        const got = await sha256Hex(encoded);
        if (got !== c.sha256) {
          throw new Error(`static-release: ${key} 第 ${c.part} 块 sha256 不符`);
        }
        parts[i] = await decodeChunk(variant.codec, encoded);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));

    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    if (out.length !== info.bytes) {
      throw new Error(`static-release: ${key} 拼接后 ${out.length} B，manifest 说 ${info.bytes} B`);
    }
    const whole = await sha256Hex(out);
    if (whole !== info.sha256) {
      throw new Error(`static-release: ${key} 全局 sha256 不符`);
    }
    return out.buffer;
  }

  return { id: ref.id, keys: [...entries.keys()], read };
}

/**
 * 从线上 catalogue 取指定 release 的引用（base / pin）。
 * 站点侧**只在首次下载时**调一次；失败就抛，不静默回退到本地路径
 * （本地路径已随本次整改从 dist 移除）。
 */
export async function resolveCatalogueRelease(id, o = {}) {
  const get = o.fetchImpl || fetch;
  const res = await get(CATALOGUE_URL, { cache: 'no-store', signal: o.signal });
  if (!res.ok) throw new Error(`static-release: catalogue HTTP ${res.status}`);
  const cat = await res.json();
  const r = (cat.releases || []).find((x) => x.id === id);
  if (!r) throw new Error(`static-release: catalogue 里没有 release ${id}`);
  return r;
}
