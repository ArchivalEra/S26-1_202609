// channel.mjs —— A↔B 通道（postMessage 封装）
//
// ## 为什么需要独立一层
//
// A（课程页）与 B（上游域 iframe）是**两个 origin**，浏览器不让直接调用，
// 只能 postMessage。这一层把「消息收发 + 安全校验 + 超时」收成一个小接口，
// 让上层（bridgeAdapter、上游代理）不知道 postMessage 存在。
//
// ## 安全不变量（测试守着）
//
//   I1 **双向校验**：收消息时必须同时校验 `event.origin` 在允许集合里
//      **且** `event.source` 是预期窗口。少一个都拒。
//   I2 **禁 `'*'`**：发送时 targetOrigin 必须是具体 origin，绝不通配。
//   I3 **一問一终态**：每条 ask 恰好收到一个 done 或 error（超时也算终态）。
//   I4 **requestId 配对**：call/result 按 requestId 一一对应；每条 call 恰好一条 result（失败也回）。
//   I5 **timer 必清**：所有定时器在 finally 里清（P1-7 教训：漏一个就吊住事件循环）。
//
// ## 消息集（定稿，2026-10-20；本轮只实现 ask/event/ready/stop）
//
//   A→B  ask    {v:1, t:'ask', requestId, text, opts?}
//        stop   {v:1, t:'stop'}
//        query  {v:1, t:'query', requestId, what:'conversations'|'history', conversationId?}
//   B→A  event  {v:1, t:'event', requestId, ev:{type, ...}}
//        result {v:1, t:'result', requestId, ok, value?, error?}
//        ready  {v:1, t:'ready', protocol:1}

export const PROTOCOL = 1;

/**
 * 造一个「发送者」——被 A 或 B 共用，只是方向不同。
 *
 * @param {object} p
 * @param {Window} p.target        对端窗口（A→B 时是 iframe.contentWindow）
 * @param {string} p.targetOrigin  对端 origin（**不许是 '*'**）
 * @param {string[]} p.allowOrigins 允许收消息的 origin 集合
 * @param {Function} [p.isExpectedSource] (source) → bool；默认「等于 target」
 * @param {Window} [p.listenOn]    在哪收消息（默认 window）
 * @param {Function} [p.log]
 */
export function createEndpoint({ target, targetOrigin, allowOrigins, isExpectedSource, listenOn, log = () => {} }) {
  if (!targetOrigin || targetOrigin === '*') {
    throw new Error('channel: targetOrigin 不许为空或通配（I2）');
  }
  if (!Array.isArray(allowOrigins) || !allowOrigins.length) {
    throw new Error('channel: allowOrigins 必须非空（I1）');
  }
  const win = listenOn || (typeof window !== 'undefined' ? window : null);
  if (!win) throw new Error('channel: 没有可监听的消息窗口');

  const handlers = new Map();   // t → fn(msg, ev)
  const expected = isExpectedSource || ((src) => src === target);

  const onMessage = (ev) => {
    // I1：origin 与 source **同时**校验
    if (!allowOrigins.includes(ev.origin)) return;
    if (!expected(ev.source)) return;
    const m = ev.data;
    if (!m || typeof m !== 'object' || m.v !== PROTOCOL) return;
    const fn = handlers.get(m.t);
    if (!fn) return;
    try { fn(m, ev); } catch (e) { log('[channel] handler 抛错', String(e.message || e)); }
  };
  win.addEventListener('message', onMessage);

  return {
    /** 发一条消息（targetOrigin 具体，I2）。 */
    send(msg) {
      if (!target || typeof target.postMessage !== 'function') {
        throw new Error('channel: 对端窗口不可用');
      }
      target.postMessage({ v: PROTOCOL, ...msg }, targetOrigin);
    },
    /** 注册处理器。 */
    on(t, fn) { handlers.set(t, fn); },
    /** 拆除监听。 */
    dispose() { win.removeEventListener('message', onMessage); handlers.clear(); },
  };
}

/** A 侧：对 B（iframe）发消息。 */
export function createHostEndpoint(opts) {
  return createEndpoint({
    ...opts,
    targetOrigin: opts.bOrigin,
    allowOrigins: [opts.bOrigin],
  });
}

/** B 侧：对 A（父窗口）发消息。 */
export function createGuestEndpoint(opts) {
  return createEndpoint({
    ...opts,
    target: opts.parentWindow,
    targetOrigin: opts.aOrigin,
    allowOrigins: [opts.aOrigin],
    // 父窗口的 source 就是 window.parent
    isExpectedSource: (src) => src === opts.parentWindow,
  });
}

/**
 * A 侧的请求器：把 ask/query 包装成 Promise，管 requestId 与超时。
 *
 * @param {object} p
 * @param {object} p.endpoint   createHostEndpoint 的返回值
 * @param {number} [p.askTimeoutMs=240000]
 * @param {number} [p.queryTimeoutMs=20000]
 */
export function createRequester({ endpoint, askTimeoutMs = 240000, queryTimeoutMs = 20000, log = () => {} }) {
  let seq = 0;
  const pending = new Map();   // requestId → { resolve, reject, onEvent, timer }

  endpoint.on('event', (m) => {
    const p = pending.get(m.requestId);
    if (!p) return;
    if (m.ev && p.onEvent) { try { p.onEvent(m.ev); } catch { /* 消费方自理 */ } }
  });
  endpoint.on('result', (m) => {
    const p = pending.get(m.requestId);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(m.requestId);
    p.resolve(m);
  });
  endpoint.on('ready', () => { log('[A] B 侧就绪'); });

  /** 问一句；事件走 onEvent，resolve 成 {ok, value?, error?}。 */
  function ask(text, onEvent, opts) {
    const requestId = 'r' + (++seq);
    return new Promise((resolve) => {
      // I5：定时器一定要清
      const timer = setTimeout(() => {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        log('[A] ask 超时', requestId);
        resolve({ ok: false, error: 'timeout' });
      }, askTimeoutMs);
      pending.set(requestId, { resolve, onEvent, timer });
      try {
        endpoint.send({ t: 'ask', requestId, text: String(text == null ? '' : text), opts: opts || {} });
      } catch (e) {
        clearTimeout(timer);
        pending.delete(requestId);
        resolve({ ok: false, error: String(e.message || e) });
      }
    });
  }

  /** 只读查询（会话列表 / 历史）。 */
  function query(what, extra = {}) {
    const requestId = 'q' + (++seq);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        resolve({ ok: false, error: 'timeout' });
      }, queryTimeoutMs);
      pending.set(requestId, { resolve, onEvent: null, timer });
      try {
        endpoint.send({ t: 'query', requestId, what, ...extra });
      } catch (e) {
        clearTimeout(timer);
        pending.delete(requestId);
        resolve({ ok: false, error: String(e.message || e) });
      }
    });
  }

  function stop() {
    try { endpoint.send({ t: 'stop' }); } catch { /* 对端不在 */ }
  }

  /** 清掉所有在飞的等待（页面卸载/重连时用）。 */
  function abortAll(reason = 'aborted') {
    for (const [requestId, p] of pending) {
      clearTimeout(p.timer);
      try { p.resolve({ ok: false, error: reason }); } catch { /* 已 settle */ }
      pending.delete(requestId);
    }
  }

  return { ask, query, stop, abortAll, get size() { return pending.size; } };
}

/**
 * B 侧的应答器：收 ask/query，调上游代理，把结果打回 A。
 *
 * @param {object} p
 * @param {object} p.endpoint  createGuestEndpoint 的返回值
 * @param {object} p.host      createUpstreamHost 的返回值
 */
export function createResponder({ endpoint, host, log = () => {} }) {
  let current = null;   // 在飞的 requestId（用于 stop）

  endpoint.on('ask', async (m) => {
    const requestId = m.requestId;
    current = requestId;
    // I3：无论成败，恰好一条 result
    const emit = (ev) => {
      try { endpoint.send({ t: 'event', requestId, ev }); } catch (e) { log('[B] event 发送失败', String(e.message || e)); }
    };
    try {
      const r = await host.ask(m.text, emit, m.opts || {});
      endpoint.send({ t: 'result', requestId, ok: r.status === 'answered' || r.status === 'blocked',
                      value: { status: r.status, text: r.text }, error: r.error });
    } catch (e) {
      endpoint.send({ t: 'result', requestId, ok: false, error: String(e.message || e) });
    } finally {
      if (current === requestId) current = null;
    }
  });

  endpoint.on('stop', () => {
    try { host.cancel(); } catch (e) { log('[B] cancel 失败', String(e.message || e)); }
  });

  endpoint.on('query', async (m) => {
    try {
      let value;
      if (m.what === 'conversations') value = await host.conversations();
      else if (m.what === 'history') value = await host.history(m.conversationId);
      else throw new Error('未知 query: ' + m.what);
      endpoint.send({ t: 'result', requestId: m.requestId, ok: true, value });
    } catch (e) {
      endpoint.send({ t: 'result', requestId: m.requestId, ok: false, error: String(e.message || e) });
    }
  });

  /** 报到（B 装载完成后第一条消息）。 */
  function announce() {
    try { endpoint.send({ t: 'ready' }); } catch (e) { log('[B] ready 发送失败', String(e.message || e)); }
  }

  // A 侧的 ready 探针（2026-10-25）：A 建桥可能晚于 B 的 announce，
  // 那次 announce 会丢。A 主动 ping 一次，B 收到就重发 announce。
  endpoint.on('ping', () => announce());

  return { announce, get busy() { return current !== null; } };
}
