// iframe-bridge.mjs —— A 侧装配：把面板的 transport 换成「经 iframe 走上游通道」
//
// ## 它解决什么
//
// 面板 `chat-panel.mjs` 只认三个东西：`ask(payload, onEvent)` / `cancel()` / `upload`。
// 本机桥形态下这三个走 `http://127.0.0.1:9345`（Node）。装脚本后换成走 postMessage 到
// 上游域 iframe 里的 B 侧代理。
//
// 面板**不知道** iframe/通道/密文的存在——这就是「只定制 UI」的落点。
//
// ## 为什么 A 侧不自己跑工具循环
//
// 它跑。工具循环在**站点协议栈**（assistant/toolcycle.mjs）里，由 `createAssistantClient`
// 用它自己的 `bridgeAdapter` → `bridge.ask` 驱动。本模块只提供那个 `bridge`。
//
//   面板 →（transport.ask）→ assistant/ 协议栈（含工具循环）→（bridge.ask）→ 通道 → B → 上游
//
// ## 用法
//
//   const bridge = await attachIframeBridge({ aOrigin, bOrigin, unitId, robotId, iframe });
//   window.__chatPanel.setTransport(bridge.transport);   // 面板走通道
//   bridge.dispose();                                    // 拆除
//
// ⚠️ 本轮**不做密文**（站长定案：先跑通功能）。上游地址由调用方明文传入。

import { createHostEndpoint, createRequester } from './channel.mjs';

/**
 * @param {object} p
 * @param {string} p.aOrigin    本站 origin（如 'https://isui.ren'）
 * @param {string} p.bOrigin    上游 origin（如 'https://robot-lc.chaoxing.com'）
 * @param {HTMLIFrameElement|Window} p.target  iframe 元素或其 contentWindow
 * @param {number} [p.askTimeoutMs]
 * @param {Function} [p.log]
 */
export function createIframeBridge({ aOrigin, bOrigin, target, askTimeoutMs = 240000, log = () => {} }) {
  if (!aOrigin || !bOrigin) throw new Error('createIframeBridge: 缺 aOrigin/bOrigin');
  if (!target) throw new Error('createIframeBridge: 缺 target（iframe 或其 contentWindow）');

  const win = target.contentWindow || target;
  const endpoint = createHostEndpoint({
    target: win,
    bOrigin,
    listenOn: (typeof window !== 'undefined' ? window : null),
  });
  const req = createRequester({ endpoint, askTimeoutMs, log });

  // 帧日志缓冲（2026-10-25，站长要求）：
  // B 侧的 proto 日志发生在**另一个 window**（iframe），A 侧默认看不到。
  // 这里把 B 转发过来的日志行收在本地环形缓冲里，面板/控制台可随时取。
  // 上限 2000 行：一次长任务几百帧，留 10 倍余量足够；无上限会吃内存。
  const LOG_LIMIT = 2000;
  const logLines = [];
  endpoint.on('log', (m) => {
    const lines = Array.isArray(m && m.lines) ? m.lines : (m && m.line ? [m.line] : []);
    if (!lines.length) return;
    for (const raw of lines) {
      const line = String(raw);
      if (line) logLines.push(line);
    }
    if (logLines.length > LOG_LIMIT) logLines.splice(0, logLines.length - LOG_LIMIT);
  });

  /** 面板要的 transport 形状。 */
  const transport = {
    /**
     * 一次提问。onEvent 收到的 ev 词汇与 SSE 完全一致。
     * @returns {Promise<{ok:boolean, text?:string, reason?:string}>}
     */
    async ask(payload, onEvent) {
      const text = String((payload && payload.text) || '');
      const r = await req.ask(text, onEvent, {});
      if (r.ok) return { ok: true, text: (r.value && r.value.text) || '' };
      return { ok: false, reason: String(r.error || 'upstream_failed') };
    },
    /** 停当前这一问。 */
    cancel() {
      req.stop();
      return { cancelled: true };
    },
    /** 本轮不做图片上传（视觉链路在 iframe 内要另接，见方案第 5 步）。 */
    upload() {
      return Promise.reject(new Error('通道形态暂不支持附件'));
    },
  };

  return {
    transport,
    /** 只读查询：会话列表 / 历史（本轮 UI 用）。 */
    conversations: () => req.query('conversations'),
    history: (conversationId) => req.query('history', { conversationId }),
    /** B 侧日志快照（帧级日志经通道转发上来的）。 */
    get logLines() { return logLines.slice(); },
    /** 清空日志缓冲（换会话/重连时）。 */
    clearLog() { logLines.length = 0; },
    dispose() {
      try { req.abortAll('disposed'); } catch { /* 忽略 */ }
      endpoint.dispose();
    },
  };
}

/**
 * 装配辅助：创建隐藏 iframe 并等它就绪。
 *
 * iframe 形态的两个坑（旧蓝图实测）：
 *   ① **不能** `display:none` —— Chrome 会对隐藏 iframe 节流计时器（5 分钟后 1/min），
 *      WS 的 KEEPALIVE 与看门狗会被拖死。用 1×1 + `opacity:0`。
 *   ② 必须落在 viewport 内（`left/top` 为 0），否则同样被判定为不可见。
 *
 * @param {object} p
 * @param {string} p.bOrigin
 * @param {string} p.path       上游页面路径（含 query）
 * @param {Document} [p.doc]
 * @returns {{ iframe: HTMLIFrameElement, ready: Promise<void> }}
 */
export function mountHiddenIframe({ bOrigin, path, doc }) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d) throw new Error('mountHiddenIframe: 没有 document');
  const iframe = d.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('tabindex', '-1');
  iframe.style.cssText =
    'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;border:0;' +
    'pointer-events:none;z-index:-1';
  iframe.src = bOrigin.replace(/\/$/, '') + path;
  d.body.appendChild(iframe);

  const ready = new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('iframe 装载超时（' + bOrigin + '）'));
    }, 30000);
    iframe.addEventListener('load', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
  return { iframe, ready };
}
