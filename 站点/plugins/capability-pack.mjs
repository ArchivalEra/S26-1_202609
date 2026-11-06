// capability-pack.mjs —— 「读者能在页面里编辑公式并当场求值」这条能力的唯一门面。
//
// ## 为什么要有这一层（设计）
//
// 这条能力由**两件互相正交的东西**拼成：
//   · **编辑器**（MathLive 浏览器版，约 824 KB）——负责「公式能改」；
//   · **计算内核**（Octave wasm32，约 9.9 MiB gz / 38 MiB 解压）——负责「改了能算」。
//
// Octave-UI 在回信里明确纠正过我一个错：**不要把两者绑成「都到位才能用」**。
// 它们的成功率差一个数量级（824 KB vs 38 MB），绑在一起会白白丢掉
// 「读者能编辑但算不了」这个中间态——那也比现在只能看强。
//
// 所以状态是**三态**，由两件资产各自在不在**派生**出来，不是存出来的：
//
//   只读   editor=absent  engine=absent   ← 现状（构建期烘死的静态 HTML）
//   可编辑 editor=ready   engine=absent   ← 能改公式、能复制 LaTeX，但不能算
//   可计算 editor=ready   engine=ready    ← 改完点运行，Octave 真算
//
// 「存出来的状态」和「派生出来的状态」的区别很重要：存的状态会和真实字节脱节
// （用户清了浏览器存储、或下载到一半），派生的状态永远等于此刻的事实。
//
// ## 接口（只有三个动词 + 一个事件）
//
//   await pack.status()             → { editor, engine, phase, ... } 纯读，无副作用
//   await pack.download('editor')   → 下载 + 持久化 + 对账（可重入，进行中会复用同一个 Promise）
//   await pack.download('engine')
//   await pack.compute(latexOrCode) → { ok, output }   引擎不在位 ⇒ 抛带 code 的错
//   pack.subscribe(fn)              → 订阅状态变化，返回取消函数
//
// 门外的一切（UI 按钮、公式的编辑态）都只跟这三个动词打交道。
//
// ## 持久化：OPFS，但真正的规矩是「永远假设它不在」
//
// Octave-UI 的原话（他们踩过）：浏览器不保证持久 —— Safari 的 7 天未访问清理
// 对 OPFS 也生效过。所以本模块**每次 status() 都真去读存储对账**（size 硬判），
// 绝不缓存一个「我记得它在了」的布尔值。缓存只在**同一次会话内**用于省掉重复的
// 大文件读取，且随 `invalidate()` 立即失效。
//
// ## 防「查询触发查询」的放大环（Octave-UI 踩过最狠的坑）
//
// 他们的实测：组件订阅存储变化 → 收到通知就查状态 → 查状态会 list() →
// list 之后 refresh() → refresh() 无条件 notify() → 又通知订阅者 → 回到起点。
// 一次启动里 checkPhysicalStatus 被调 39,803 次，RSS 以 8.9 MB/s 无界爬升，
// 而 JS 堆看着「正常」（增长在 wasm 线性内存）。
//
// 本模块的结构性防御（三条，缺一不可）：
//   ① `status()` 是**纯读**：不写存储、不发通知、不改任何字段；
//   ② `subscribe` 的回调只在**派生状态真的变了**时触发（differ 后比较，不是无条件 notify）；
//   ③ 每次 notify 前把「上一次广播的状态」记下来，相同就不再发。
// 判据（照抄他们的）：给状态查询路径加计数器，一次正常用户操作断言调用次数 ≤ 常数，
// 静置后再来一轮次数不许增长。测试见 capability-pack.test.mjs。

/** 各资产的元数据。`files` 是「下载闭包」，即少一件就跑不起来的全部文件。 */
export const ASSETS = {
  editor: {
    label: '公式编辑器',
    hint: '下载后公式可以点击编辑',
    bytes: 843924,
    files: [
      // `bytes` 必须逐个文件给准：size 校验是「文件在不在」的**硬判据**
      // （浏览器不保证持久，只能靠大小对账）。
      // `sha256` 是「内容对不对」的第二层判据——2026-10-31 加：实测一个 843924
      // 字节全零的文件能骗过 size 校验，于是 MathLive 载入失败而界面显示「已下载」。
      // 由 `zreflect/measure_edu.py`（或手工 sha256sum）在资产更新时同步。
      {
        path: 'assets/mathlive/mathlive-browser.min.js',
        name: 'mathlive-browser.min.js',
        bytes: 843924,
        sha256: '51e9ab5c4739209a2951a550042dcecb99ad3047269c1d791d09d7d613226eae',
      },
    ],
  },
  engine: {
    label: '计算内核',
    hint: '下载后可以点「运行」用 Octave 求值',
    bytes: 29621256 + 9712192 + 464339,
    // ⚠️ 2026-11-06 起三个文件**不再从本站 assets/ 拉**：
    // EdgeOne Pages 单文件 25 MB 硬上限（octave.wasm 解压 29.6 MB 超限），
    // 且这些二进制从未进仓库白名单，CI 的 dist 里根本没有本地副本。
    // 改从 Static-Contract 的 release 分块拉（≤5 MiB/块，逐块 sha + 全局 sha），
    // 见 static-release.mjs。files[].path 保留只为让既有测试的对账逻辑有稳定键，
    // 实际下载走 release.read(key)；`source` 是分流开关。
    releaseId: 'Octave-Full-Wasm/v0.1.0',
    files: [
      // 三件的字节与 sha 取自 release manifest 的 wasm32 三个 entry
      // （manifest pin c3c1adfe…）。本地历史副本与它们有几十字节差异，
      // 以 release 为准——内容判据随来源一起换，不能沿用旧的 SHA256SUMS。
      {
        path: 'assets/octave/octave.wasm', name: 'octave.wasm', bytes: 29621256,
        sha256: 'a4f5a4143178314075d3b213fd5a48cf02450e9153dd32d2e3be21a987ba1f69',
        source: { product: 'wasm32', name: 'octave.wasm' },
      },
      {
        path: 'assets/octave/octave.data', name: 'octave.data', bytes: 9712192,
        sha256: '1a2e71a64d8e9b223fb8162ce2714e1fce18d3517ed95c73b7adfada31d7c35f',
        source: { product: 'wasm32', name: 'octave.data' },
      },
      {
        path: 'assets/octave/octave.js', name: 'octave.js', bytes: 464339,
        sha256: 'a12acb29190aff83331d40b7a796f8eecb2aba9d42e3d74b32c4c57dc27ef4f0',
        source: { product: 'wasm32', name: 'octave.js' },
      },
    ],
  },
};

/** 三态：由两件资产的存在**派生**（不是存出来的）。 */
export function deriveMode(s) {
  const editor = !!(s?.editor && s.editor.ready);
  const engine = !!(s?.engine && s.engine.ready);
  if (editor && engine) return 'computable';
  if (editor) return 'editable';
  return 'readonly';
}

/**
 * 建一个能力包实例。
 *
 * @param {object} deps
 * @param {object} deps.store         持久化实现（默认见 createOpfsStore；测试注入内存实现）
 * @param {function} [deps.onState]   状态变化回调（可选；subscribe 是主要通道）
 * @param {string|function} [deps.root] 站点根前缀。**传函数**：SPA 换页会把
 *   `<html data-root>` 换掉，字符串会在页面加载那一刻过期（2026-11-01 站长实测
 *   「进了页面算不了」：产物请求变成 `/课程总览/工程数学/作业/assets/octave/…` 404）。
 *   传函数则**每次拼 URL 时现取**；传字符串是兼容旧调用（会在下载时快照）。
 * @param {object} [deps.fetchImpl]   fetch 实现（测试注入）
 */
/**
 * 算一份字节的 sha256（十六进制小写）。
 *
 * ⚠️ 必须是**模块级**函数：能力包（createCapabilityPack）与 OPFS 存储
 * （createOpfsStore）都要用它。2026-10-31 它原本嵌在 createOpfsStore 里，
 * 于是能力包那边调用时抛 ReferenceError，又被 try/catch 当成「算不出来」
 * 静默放过——坏副本因此一路被判成「已就绪」。
 *
 * crypto.subtle 只在安全上下文（https / localhost）可用。取不到就返回 null，
 * 调用方据此**不做内容校验**而不是判失败——功能不该因为校验手段缺失而不可用。
 */
async function sha256Hex(buf) {
  try {
    if (!(globalThis.crypto && globalThis.crypto.subtle)) return null;
    const d = await globalThis.crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    return null;
  }
}

export function createCapabilityPack(deps = {}) {
  const store = deps.store;
  if (!store) throw new Error('capability-pack: 需要注入 store');

  const listeners = new Set();
  /** 每次广播的「上一次状态」快照 —— 防环的第 ③ 条。 */
  let lastBroadcast = null;
  /** 进行中的下载（按资产名）。同一资产的重复调用复用同一个 Promise。 */
  const inflight = new Map();
  /** 本会话内的状态缓存，避免重复读大文件；invalidate() 立即失效。 */
  let cached = null;
  /**
   * 并发请求合并：同一时刻的多个 status() 只真读一次存储。
   *
   * 为什么需要：`head()` 每次都要真读存储（必须——不能缓存「它还在」的布尔值，
   * 用户随时可能清掉）。但若 UI 在多个地方同时问状态（按钮、订阅、渲染），
   * 就会并发打 N 次。合并之后同一 tick 的查询只落一次真实读。
   * 这**不是**环的修复（环要靠「不无条件广播」），是让正常路径的调用次数收敛到常数。
   */
  let inflightStatus = null;
  /**
   * 极短 TTL（毫秒）：`status()` 在这个窗口内复用上一次读数。
   *
   * 为什么必须有：`head()` 必须真读存储（不能缓存「它还在」——用户随时可能清掉），
   * 但 UI 侧「按钮渲染 / 订阅回调 / 定时刷新」会**串行**地问很多次，
   * 每次都真读就是 N 次，和 Octave-UI 那个放大环同一形状（他们的数字是 39,803 次）。
   *
   * 200ms 的依据：存储状态不会在一瞬间反复变；下载/删除之后本模块会显式
   * 用 `status({fresh:true})` 强制重读，所以正确性不依赖这个 TTL。
   * TTL 只吸收「同一屏渲染里的重复询问」。
   */
  const STATUS_TTL_MS = 200;
  let lastReadAt = 0;

  /**
   * 站点根前缀，**每次都现算**。
   *
   * 为什么要有这一层：`deps.root` 在旧装配里是加载那一刻读到的字符串
   * （`html[data-root]`），而 SPA 换页会把那个属性换成新页的前缀 —— 快照的
   * 字符串于是指向上一页的目录，下载/加载产物全 404（2026-11-01 站长实测）。
   * 传函数就每次现取；传字符串当兼容（那是调用方的选择，语义是「固定前缀」）。
   */
  function resolveRoot() {
    const r = deps.root;
    if (typeof r === 'function') {
      try { return String(r() || ''); } catch (e) { return ''; }
    }
    return r != null ? String(r) : '';
  }

  function fire(state) {
    for (const fn of [...listeners]) {
      try { fn(state); } catch (e) { /* 单个订阅者抛错不影响其余 */ }
    }
    if (typeof deps.onState === 'function') {
      try { deps.onState(state); } catch (e) { /* 同上 */ }
    }
  }

  /**
   * 广播：**只在派生状态真的变了时**才发。
   *
   * 这是防环的核心。`status()` 本身不调用它 —— 只有 mutate（下载/删除）之后才调。
   */
  function broadcast(state) {
    const sig = JSON.stringify({ mode: state.mode, e: state.editor.ready, g: state.engine.ready });
    if (sig === lastBroadcast) return;      // ← 防环第 ③ 条：相同不发
    lastBroadcast = sig;
    fire(state);
  }

  /**
   * 读单个资产在存储里的实际情况（纯读：不写、不发通知）。
   *
   * 判据三层，从便宜到贵：
   *   ① 文件不存在 ⇒ missing
   *   ② 大小不等于清单字节数 ⇒ size（**硬判据**，唯一无条件成立的）
   *   ③ 内容对不对：
   *      · sidecar 有指纹 ⇒ 比对（便宜，只读几十字节）
   *      · sidecar 没有 ⇒ **现算一次真哈希**（贵：要读整个文件）
   *
   * 为什么③要现算：老版本下载的文件没有 sidecar，而「旧副本坏掉」
   * （下载中断、磁盘写坏、被别的东西覆盖）恰恰最可能发生在老副本上。
   * 只在没有 sidecar 时算，且算完把结果缓存到本会话（`contentMemo`），
   * 所以打开面板最多付一次——不是每次 status() 都重算 824 KB。
   */
  const contentMemo = new Map();     // name → 实测 sha256（本会话内有效）
  async function verifyContent(f, info) {
    if (!f.sha256) return true;                    // 清单没登记指纹 ⇒ 不比
    if (info.sha256) return info.sha256 === f.sha256;  // 有 sidecar ⇒ 便宜路径
    const mem = contentMemo.get(f.name);
    if (mem) return mem === f.sha256;              // 本会话算过
    // 现算：让 store 读整份字节。store 没有 readBytes 就跳过（不做假断言）。
    if (typeof store.readBytes !== 'function') return true;
    try {
      const buf = await store.readBytes(f.name);
      const sha = await sha256Hex(buf);
      if (!sha) return true;                       // 算不出来（非安全上下文）⇒ 不比
      contentMemo.set(f.name, sha);
      return sha === f.sha256;
    } catch (e) {
      return true;                                 // 读失败当作「无法判定」，不判坏
    }
  }

  async function inspectAsset(name) {
    const spec = ASSETS[name];
    if (!spec) throw new Error(`未知资产：${name}`);
    const present = [];
    const missing = [];
    for (const f of spec.files) {
      const info = await store.head(f.name);     // 纯读：只问「有没有、多大、指纹」
      if (!info) { missing.push({ ...f, reason: 'missing' }); continue; }
      if (info.bytes !== f.bytes) {
        missing.push({ ...f, reason: 'size', actual: info.bytes });
        continue;
      }
      if (!(await verifyContent(f, info))) {
        missing.push({ ...f, reason: 'content', actual: info.bytes });
        continue;
      }
      present.push({ ...f, bytes: info.bytes });
    }
    return {
      name,
      ready: missing.length === 0,
      present: present.length,
      total: spec.files.length,
      missing,
      bytes: spec.bytes,
    };
  }

  const pack = {
    /**
     * 当前状态（**纯读，无副作用**）。
     * @param {{fresh?: boolean}} [o] fresh=true 跳过会话缓存、真去读存储
     */
    async status(o = {}) {
      // ① TTL 内复用（吸收同一屏的重复询问）；fresh=true 跳过
      if (!o.fresh && cached && (Date.now() - lastReadAt) < STATUS_TTL_MS) return cached;
      // ② 并发合并（同一 tick 的多个查询只落一次真实读）
      if (inflightStatus) return inflightStatus;
      inflightStatus = (async () => {
        try {
          const [editor, engine] = await Promise.all([inspectAsset('editor'), inspectAsset('engine')]);
          const state = { editor, engine };
          state.mode = deriveMode(state);
          cached = state;
          lastReadAt = Date.now();
          return state;
        } finally {
          inflightStatus = null;
        }
      })();
      return inflightStatus;
    },

    /** 让会话缓存失效（例如用户手动清了浏览器存储，或另一标签页改了）。 */
    invalidate() { cached = null; },

    /**
     * 下载一件资产并持久化。可重入：同一资产进行中时复用同一个 Promise。
     *
     * @param {'editor'|'engine'} name
     * @param {{onProgress?: function}} [o]
     */
    download(name, o = {}) {
      if (inflight.has(name)) return inflight.get(name);
      const p = (async () => {
        const spec = ASSETS[name];
        if (!spec) throw new Error(`未知资产：${name}`);
        // ⚠️ 每次下载都**现取**根前缀（2026-11-01）：SPA 换页会把 html[data-root] 换掉，
        // 在这里快照一次就会拼出 `/课程总览/工程数学/作业/assets/…` 这种 404。
        const rootNow = resolveRoot();
        for (const f of spec.files) {
          const existing = await store.head(f.name);
          // ⚠️ 跳过判据必须与 inspectAsset **完全一致**——两处各写一套必然漂移。
          // 2026-10-31 实测：inspectAsset 现算哈希能判出坏副本，download 这里却
          // 「没 sidecar 就当内容对」于是跳过 ⇒ 用户点了下载也没重下，一直卡在只读。
          // 现在统一走 verifyContent（同一份内容缓存、同一套判定）。
          const sameSize = !!(existing?.bytes === f.bytes);
          const sameContent = sameSize ? await verifyContent(f, existing) : false;
          if (sameSize && sameContent) {
            if (o.onProgress) o.onProgress({ name, file: f.name, done: true, skipped: true });
            continue;                                  // 已在位且内容对 ⇒ 不重下
          }
          let buf;
          if (f.source && deps.releaseLoader) {
            // Static-Contract 路径（2026-11-06）：大包从镜像分块拉，不再走本站 assets/。
            // releaseLoader 是装配层注入的 `(f) => Promise<ArrayBuffer>`；它内部做
            // manifest pin 校验、逐块 sha、解码、拼接、全局 sha，这里只收完整字节。
            buf = await deps.releaseLoader(f);
          } else {
            const url = rootNow + f.path;
            const res = await (deps.fetchImpl || fetch)(url);
            if (!res.ok) throw mkErr('DOWNLOAD_FAILED', `取 ${f.name} 失败：HTTP ${res.status}`, { status: res.status });
            buf = await res.arrayBuffer();
          }
          if (buf.byteLength !== f.bytes) {
            throw mkErr('SIZE_MISMATCH', `${f.name} 大小不符：期望 ${f.bytes}，实收 ${buf.byteLength}`);
          }
          await store.put(f.name, buf);
          // 新字节落地 ⇒ 该文件的内容缓存作废（否则下一次 status 还拿旧哈希比对，
          // 重下完了仍判「内容坏」——2026-10-31 浏览器实测到这条）。
          contentMemo.delete(f.name);
          if (o.onProgress) o.onProgress({ name, file: f.name, done: true, bytes: buf.byteLength });
        }
        cached = null;                                  // 状态变了 ⇒ 缓存失效
        const state = await pack.status({ fresh: true });
        broadcast(state);                               // 只在派生状态真变时发
        return state;
      })();
      inflight.set(name, p);
      // 无论成败都清 inflight —— 否则失败后永久卡在这个 Promise 上
      p.then(() => inflight.delete(name), () => inflight.delete(name));
      return p;
    },

    /** 删掉一件资产（调试 / 用户主动清理）。 */
    async remove(name) {
      const spec = ASSETS[name];
      if (!spec) throw new Error(`未知资产：${name}`);
      for (const f of spec.files) {
        await store.delete(f.name);
        contentMemo.delete(f.name);                     // 删掉了，内容缓存也作废
      }
      cached = null;
      const state = await pack.status({ fresh: true });
      broadcast(state);
      return state;
    },

    /**
     * 用计算内核求值。引擎不在位 ⇒ 抛 `ENGINE_NOT_READY`。
     *
     * ⚠️ 这里**不实现** Octave 的具体调用 —— 那是 adapter 的事，注入进来。
     * 本模块只负责「在不在、能不能调、失败了怎么报」。
     */
    async compute(code, o = {}) {
      const state = await pack.status();
      // 判据用**派生模式**而不是「引擎在不在」：三态里只有 computable 才允许算。
      // 引擎单独在位（编辑器没下）仍是 readonly —— 那种状态下 UI 不会给「运行」按钮，
      // 但工具也可能被别处直接调用，所以这里也拦。
      if (state.mode !== 'computable') throw mkErr('ENGINE_NOT_READY', '计算内核还没下载（或编辑器未就位）');
      if (typeof deps.evaluate !== 'function') throw mkErr('ENGINE_ADAPTER_MISSING', '没有注入 evaluate');
      return deps.evaluate(code, o);
    },

    /** 订阅状态变化。回调只在**派生状态真的变了**时触发。返回取消函数。 */
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      // 立即给一次当前状态（异步，不阻塞订阅者）
      pack.status().then((s) => { try { fn(s); } catch (e) {} });
      return () => listeners.delete(fn);
    },
  };

  return pack;
}

function mkErr(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

/**
 * OPFS 持久化实现（浏览器）。
 *
 * 只暴露三个动词：`head(name)` 纯读 / `put(name, buf)` / `delete(name)`。
 * 为什么不用 IndexedDB：37.96 MiB 要走 base64 或整读 ArrayBuffer，峰值内存翻倍；
 * OPFS 能给 Blob/流，且语义清楚（它是「站点私有文件系统」，不是「缓存」）。
 *
 * ⚠️ 浏览器**不保证**持久：`navigator.storage.persist()` 只是申请，Safari 的
 * 7 天未访问清理对 OPFS 也生效过。所以调用方必须每次都真读对账，不要缓存布尔值。
 */
export function createOpfsStore(dirName = 'capability-pack') {
  let dirPromise = null;

  async function getDir() {
    if (!dirPromise) {
      dirPromise = (async () => {
        if (!navigator.storage || !navigator.storage.getDirectory) {
          throw mkErr('OPFS_UNSUPPORTED', '这个浏览器没有 OPFS');
        }
        // 申请持久化：只是「申请」，浏览器可以拒绝；拒绝也不影响读写，只影响会不会被清。
        try { if (navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle(dirName, { create: true });
      })();
    }
    return dirPromise;
  }

  // ── 内容指纹 sidecar ───────────────────────────────────────────────
  //
  // 为什么需要：`head()` 只比大小，抓不住「大小对但内容坏了」——真实情形包括
  // 下载中途被打断后留下同长度垃圾、磁盘写坏、别的东西覆盖了同名文件。
  // 2026-10-31 实测：预置一个 843924 字节全零的文件，`head()` 判定「已就绪」，
  // 于是 MathLive 载入失败，而界面上显示「已下载」。
  //
  // 做法：`put()` 时算 sha256 写进 `<name>.sha256`（小文本文件），`head()` 只
  // **读** sidecar 比对，不重算——重算要对 824 KB 做 sha256，每次 status() 都算
  // 会让打开面板明显卡顿。sidecar 缺失（老版本下载的）就退化成只比大小，
  // 不做假断言。
  const sidecarOf = (name) => name + '.sha256';

  async function readSidecar(dir, name) {
    try {
      const fh = await dir.getFileHandle(sidecarOf(name));
      const f = await fh.getFile();
      const t = (await f.text()).trim();
      return /^[0-9a-f]{64}$/.test(t) ? t : null;
    } catch (e) {
      return null;
    }
  }

  return {
    /** 纯读：只问「有没有、多大、指纹对不对」，不创建任何东西。 */
    async head(name) {
      try {
        const dir = await getDir();
        const fh = await dir.getFileHandle(name);
        const file = await fh.getFile();
        const out = { bytes: file.size };
        const sha = await readSidecar(dir, name);
        if (sha) out.sha256 = sha;      // 有 sidecar 才带指纹，没有就只比大小
        return out;
      } catch (e) {
        return null;
      }
    },
    /** 读整份字节（内容校验用）。只在没有 sidecar 时被调一次。 */
    async readBytes(name) {
      const dir = await getDir();
      const fh = await dir.getFileHandle(name);
      const file = await fh.getFile();
      return new Uint8Array(await file.arrayBuffer());
    },
    async put(name, buf) {
      const dir = await getDir();
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(buf);
      await w.close();
      // 写指纹。算不出来（非安全上下文）就不写 sidecar——head() 会退化成只比大小。
      const sha = await sha256Hex(buf);
      if (sha) {
        try {
          const sfh = await dir.getFileHandle(sidecarOf(name), { create: true });
          const sw = await sfh.createWritable();
          await sw.write(sha);
          await sw.close();
        } catch (e) { /* sidecar 写失败不影响主文件；只是少了内容校验 */ }
      }
    },
    async delete(name) {
      const dir = await getDir().catch(() => null);
      if (!dir) return;
      try { await dir.removeEntry(name); } catch (e) { /* 不存在即视为已删 */ }
      try { await dir.removeEntry(sidecarOf(name)); } catch (e) { /* 同上 */ }
    },
  };
}
