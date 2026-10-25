// upstream-host.mjs —— B 侧：上游代理（跑在上游域的同源 iframe 里）
//
// ## 它是什么
//
// 一个**薄代理**：接收通道发来的请求，转成上游 HTTP/WS，把结果原样打回去。
//
// ## 它不是什么（硬约束，违反即退回旧病灶）
//
// 2026-10-25 的插件失败根因（handoff §0.133）是 B 侧又养了一套工具会话：
// 用 `tools: []` 建 chatsvc → 把站点拼好的整段当成「用户问题」再走一遍工具循环
// → `callPeer('executeTool')` → A 侧不接 → 上游永远拿不到可用工具。
//
// 所以本模块**禁止** import：
//   · toolcycle.mjs（工具循环只在 A 侧）
//   · chatsvc.mjs（提示词拼装只在 A 侧）
//   · session.mjs（重放/轮换策略只在 A 侧）
//
// 它只做三件事：① 建一条 WS ② 发问收帧 ③ 转发上游的只读查询（会话列表/历史）。
//
// ## 为什么需要它
//
// 登录态只存在于浏览器上下文（实测：Node 侧应用层全对齐也认不出，见
// `.zcode/会话语义/实测-身份派生与匿名留存-20261025.md` §6.5）。
// 而 A 侧（我们的站点）跨域读不到上游 iframe（`contentDocument` 为 null，实测）。
// ⇒ 必须有个东西**住在上游域内部**替我们发请求。这就是 B。
//
// ## 接口
//
//   createUpstreamHost({ proto, base, unitId, robotId, log, trace })
//     → { ask, cancel, conversations, history, close, get conversationId }
//
// `ask(text, onEvent)` 的事件词汇与 `bridgeAdapter` 期望的完全一致：
//   { type:'delta', text } / { type:'status', phase } / { type:'done', status, text } / { type:'error', reason }
//
// ⚠️ 这块**不拼提示词、不解析工具调用**——那是 A 侧的事。B 只把上游原话交回去。

/**
 * @param {object} p
 * @param {object} p.proto       协议栈（createAssistant 等；由调用方注入，便于单测）
 * @param {string} p.base        上游站点根（运行时由密文层给；本轮明文）
 * @param {string} p.unitId
 * @param {string} p.robotId
 * @param {Function} [p.log]
 * @param {number} [p.trace=1]
 */
export function createUpstreamHost({ proto, base, unitId, robotId, log = () => {}, trace = 1 }) {
  if (!proto || typeof proto.createAssistant !== 'function') {
    throw new Error('createUpstreamHost: 缺少 proto.createAssistant');
  }
  if (!base || !unitId || !robotId) {
    throw new Error('createUpstreamHost: base/unitId/robotId 三者缺一不可（不猜默认值）');
  }

  let assistant = null;
  let connecting = null;

  /** 惰性建连（并发调用共享同一个 Promise，避免建两条 WS）。 */
  function ensure() {
    if (assistant) return Promise.resolve(assistant);
    if (connecting) return connecting;
    connecting = (async () => {
      const a = proto.createAssistant({ base, unitId, robotId, planning: true, trace, log });
      await a.connect();
      assistant = a;
      connecting = null;
      log('[B] 已连接', a.identity && a.identity.visitorId);
      return a;
    })().catch((e) => { connecting = null; throw e; });
    return connecting;
  }

  /**
   * 问一句。事件通过 onEvent 流出。
   *
   * @param {string} text
   * @param {Function} [onEvent]
   * @param {object} [opts] 透传给 proto.ask（timeout/idleMs/fileInfo）
   * @returns {Promise<{status, text, error?}>}
   */
  async function ask(text, onEvent = () => {}, opts = {}) {
    let a;
    try {
      a = await ensure();
    } catch (e) {
      onEvent({ type: 'error', reason: 'connect: ' + String(e.message || e) });
      return { status: 'transport', text: '', error: String(e.message || e) };
    }

    const onChunk = (chunk) => {
      if (chunk) { try { onEvent({ type: 'delta', text: String(chunk) }); } catch { /* 消费方自理 */ } }
    };
    try {
      onEvent({ type: 'status', phase: 'generating' });
      const r = await a.ask(String(text == null ? '' : text), {
        timeout: opts.timeout != null ? opts.timeout : 180000,
        idleMs: opts.idleMs != null ? opts.idleMs : 90000,
        onChunk,
        ...(opts.fileInfo ? { fileInfo: opts.fileInfo } : {}),
      });
      const finalText = String(r.text || '');
      // 上游的类型化 status 原样透出（manager/bridgeAdapter 认这个词表）
      const status = r.status || 'answered';
      if (status === 'answered' || status === 'blocked') {
        onEvent({ type: 'done', status, text: finalText });
      } else {
        onEvent({ type: 'error', reason: r.error || status });
      }
      return { status, text: finalText, error: r.error };
    } catch (e) {
      onEvent({ type: 'error', reason: String(e.message || e) });
      return { status: 'transport', text: '', error: String(e.message || e) };
    }
  }

  /** 停当前这一问（不动连接）。 */
  function cancel() {
    try {
      return assistant && typeof assistant.cancel === 'function'
        ? assistant.cancel()
        : { cancelled: false };
    } catch (e) { return { cancelled: false, error: String(e.message || e) }; }
  }

  /** 会话列表（登录态专属能力；匿名态上游恒返回空数组）。 */
  async function conversations() {
    const a = await ensure();
    const id = a.identity || {};
    const qs = new URLSearchParams({
      pageNo: '1', pageSize: '50', unitId, robotId,
    });
    // 复用 proto 的 fetch 通道（带上上游要的 Referer 等，避免另起一套请求头）
    const r = await fetch(`${base}/v1/front/conversationList?${qs}&safeformat=json`, {
      headers: { Accept: 'application/json, text/plain, */*' },
      credentials: 'include',
    });
    const j = await r.json();
    return Array.isArray(j.data) ? j.data : [];
  }

  /** 某场会话的历史消息（原样返回上游结构）。 */
  async function history(conversationId) {
    if (!conversationId) throw new Error('history: 缺 conversationId');
    const qs = new URLSearchParams({
      pageNo: '1', pageSize: '9999', conversationId, scene: '', unitId, robotId,
    });
    const r = await fetch(`${base}/v1/front/msgList?${qs}&safeformat=json`, {
      headers: { Accept: 'application/json, text/plain, */*' },
      credentials: 'include',
    });
    const j = await r.json();
    // data 是分页对象：{ records, total }
    return (j.data && Array.isArray(j.data.records)) ? j.data.records : [];
  }

  function close() {
    try { assistant && assistant.close(); } catch { /* 已关 */ }
    assistant = null;
    connecting = null;
  }

  return {
    ask, cancel, conversations, history, close,
    /** 上游真名（未连上时为 null）。只读转发，本地不造。 */
    get conversationId() {
      try { return (assistant && assistant.identity && assistant.identity.conversationId) || null; }
      catch { return null; }
    },
    get visitorId() {
      try { return (assistant && assistant.identity && assistant.identity.visitorId) || null; }
      catch { return null; }
    },
  };
}
