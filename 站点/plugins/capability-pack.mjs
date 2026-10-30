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
      // `bytes` 必须逐个文件给准：size 校验是「文件在不在」的唯一硬判据
      // （浏览器不保证持久，只能靠大小对账）。
      { path: 'assets/mathlive/mathlive-browser.min.js', name: 'mathlive-browser.min.js', bytes: 843924 },
    ],
  },
  engine: {
    label: '计算内核',
    hint: '下载后可以点「运行」用 Octave 求值',
    bytes: 29632229 + 9712174 + 462821,
    files: [
      { path: 'assets/octave/octave.wasm', name: 'octave.wasm', bytes: 29632229 },
      { path: 'assets/octave/octave.data', name: 'octave.data', bytes: 9712174 },
      { path: 'assets/octave/octave.js', name: 'octave.js', bytes: 462821 },
    ],
  },
};

/** 三态：由两件资产的存在**派生**（不是存出来的）。 */
export function deriveMode(s) {
  const editor = !!(s && s.editor && s.editor.ready);
  const engine = !!(s && s.engine && s.engine.ready);
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
 * @param {string} [deps.root]        站点根（默认从 <html data-root> 取）
 * @param {object} [deps.fetchImpl]   fetch 实现（测试注入）
 */
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

  /** 读单个资产在存储里的实际情况（纯读：不写、不发通知）。 */
  async function inspectAsset(name) {
    const spec = ASSETS[name];
    if (!spec) throw new Error(`未知资产：${name}`);
    const present = [];
    const missing = [];
    for (const f of spec.files) {
      const info = await store.head(f.name);     // 纯读：只问「有没有、多大」
      if (info && info.bytes === f.bytes) present.push({ ...f, bytes: info.bytes });
      else missing.push(f);
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
        const root = deps.root != null ? deps.root : '';
        for (const f of spec.files) {
          const existing = await store.head(f.name);
          if (existing && existing.bytes === f.bytes) {
            if (o.onProgress) o.onProgress({ name, file: f.name, done: true, skipped: true });
            continue;                                  // 已在位 ⇒ 不重下
          }
          const url = root + f.path;
          const res = await (deps.fetchImpl || fetch)(url);
          if (!res.ok) throw mkErr('DOWNLOAD_FAILED', `取 ${f.name} 失败：HTTP ${res.status}`, { status: res.status });
          const buf = await res.arrayBuffer();
          if (buf.byteLength !== f.bytes) {
            throw mkErr('SIZE_MISMATCH', `${f.name} 大小不符：期望 ${f.bytes}，实收 ${buf.byteLength}`);
          }
          await store.put(f.name, buf);
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
      for (const f of spec.files) await store.delete(f.name);
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

  return {
    /** 纯读：只问「有没有、多大」，不创建任何东西。 */
    async head(name) {
      try {
        const dir = await getDir();
        const fh = await dir.getFileHandle(name);
        const file = await fh.getFile();
        return { bytes: file.size };
      } catch (e) {
        return null;
      }
    },
    async put(name, buf) {
      const dir = await getDir();
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(buf);
      await w.close();
    },
    async delete(name) {
      try {
        const dir = await getDir();
        await dir.removeEntry(name);
      } catch (e) { /* 不存在即视为已删 */ }
    },
  };
}
