// assistant-wire.mjs —— 站点侧接线器（阶段二 T11）
//
// 把三样东西接成面板认识的 transport：
//   ① `window.__assistantBridge`  ← 插件暴露的跨 origin 通道（薄桥）
//   ② `createAssistantClient`     ← T10 从 userscript/proto 搬来的协议栈
//   ③ `runTool`                   ← 本目录 webmcp-tools.mjs 的页面工具执行
//
// 结果：工具循环（提示词 → ask → 解析 → 执行工具 → 回喂 → 再 ask）**在站点侧跑**，
// 插件只剩「握手 + 跨 origin 通道」。这是两阶段重构的目标形态。
//
// ## 为什么要这一层
//
// 面板（chat-panel.mjs）只认 `setTransport(fn)`，`fn = {ask, cancel, upload}`。
// 而 `createAssistantClient` 的内部形态是「manager + chatService」——两者之间
// 需要一个 adapter。放这里而不是塞进面板：面板不该知道协议栈的存在，
// 就像它今天不知道 bridge 是怎么实现的（interface 要小）。
//
// ## 时序
//
// 插件注入晚于站点脚本是常态（油猴 document-end）。所以本模块**轮询等待**
// `window.__assistantBridge`，出现后才组装 transport 并调 `setTransport`。
// 超时（默认 20s）则保持面板原有的「连本机桥」形态——不报错、不阻塞。

/**
 * @param {object} p
 * @param {object} [p.win=window]          页面 window（测试注入）
 * @param {function} p.createAssistantClient  T10 的入口（由调用方 import，避免本模块硬依赖）
 * @param {function} p.runTool             工具执行器（webmcp-tools.mjs 的 runTool 绑定 doc）
 * @param {function} [p.serializeTools]    取当前页工具清单（默认从 modelContext 读）
 * @param {number} [p.pollMs=400]
 * @param {number} [p.deadlineMs=20000]
 * @returns {{ cancel(): void, promise: Promise<'attached'|'timeout'|'no-panel'> }}
 */
export function wireAssistant({
  win = (typeof window !== 'undefined' ? window : null),
  createAssistantClient,
  runTool,
  serializeTools = null,
  pollMs = 400,
  deadlineMs = 20000,
} = {}) {
  if (!win) throw new Error('wireAssistant: 需要 window');
  if (typeof createAssistantClient !== 'function')
    throw new Error('wireAssistant: 需要 createAssistantClient');

  let stopped = false;
  let pollTimer = null;

  const p = (async () => {
    const t0 = Date.now();
    for (;;) {
      if (stopped) return 'timeout';
      const bridge = win.__assistantBridge;
      const panel = win.__chatPanel;
      if (bridge && panel && typeof panel.setTransport === 'function') {
        const transport = makeTransport({ win, bridge, createAssistantClient, runTool, serializeTools });
        panel.setTransport(transport);
        return 'attached';
      }
      if (Date.now() - t0 > deadlineMs) return 'timeout';
      await new Promise((r) => { pollTimer = setTimeout(r, pollMs); pollTimer = null; });
    }
  })();

  return {
    promise: p,
    cancel() {
      stopped = true;
      if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
    },
  };
}

/**
 * 组装 transport。三个方法正好对上面板契约。
 *
 * 关键：`ask` 里**每问现取工具清单**——页面导航后工具可能变化（站点是 SPA），
 * 沿用上一问的清单会让模型调用已经不存在的工具。这与旧 roleA 的
 * `toolsProvider` 是同一个理由。
 */
function makeTransport({ win, bridge, createAssistantClient, runTool, serializeTools }) {
  let activeSid = null;
  let seq = 0;

  // ⚠️ 2026-10-25 修（生产验收「提示词不见了」）：getTools() 在规范/polyfill
  // 注册表上返回 **Promise**（只有 Firefox 原生是同步数组，见 webmcp-shim 头注释
  // 的对照表）。旧实现同步当数组用 ⇒ Array.isArray(Promise) 为假 ⇒ 工具表恒空
  // ⇒ 站点侧 allowed.length === 0 ⇒ 不加提示词，用户正文裸发上游。
  const toolList = async () => {
    if (typeof serializeTools === 'function') {
      try { return await serializeTools(); } catch { return []; }
    }
    // 默认：从页面注册表读（与 webmcp-tools 的 registerTools 同一个源）
    try {
      const mc = (win.document && win.document.modelContext)
        || (win.navigator && win.navigator.modelContext) || null;
      if (!mc || typeof mc.getTools !== 'function') return [];
      const list = await mc.getTools();   // 规范/polyfill 返回 Promise；Firefox 原生是数组
      if (!Array.isArray(list)) return [];
      // 只留模型需要知道的三样（实现细节不过通道）
      return list.map((t) => ({
        name: t.name,
        description: t.description || t.desc || '',
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
      }));
    } catch { return []; }
  };

  // 每个 sid 一个 client（保留各自的会话历史）
  const clients = new Map();

  const clientFor = async (sid) => {
    let c = clients.get(sid);
    if (c) return c;
    c = createAssistantClient({
      bridge: {
        ask: (payload, onEvent) => bridge.ask(payload, onEvent),
        cancel: () => bridge.cancel(),
      },
      tools: await toolList(),
      invoke: (name, args) => runTool(name, args),
      contextProvider: null,
    });
    clients.set(sid, c);
    return c;
  };

  return {
    ask(payload = {}, onEvent = () => {}) {
      // async 执行器：toolList() 要 await（getTools 在 polyfill 下是 Promise）。
      // 内部仍显式 new Promise + settle 门闩，语义不变。
      return new Promise(async (resolve) => {
        if (activeSid !== null) {
          resolve({ ok: false, reason: '上一问还没结束（先停止或等终态）' });
          return;
        }
        const sid = 'site-' + (++seq);
        activeSid = sid;
        let settled = false;
        const settle = (r) => {
          if (settled) return;
          settled = true;
          activeSid = null;
          resolve(r);
        };
        try {
          const client = await clientFor(sid);
          // ⚠️ 2026-10-22 修：client.ask 返回的是 `{status, text, calls}`，
          // **没有 ok 字段**（chatsvc.mjs 的契约）。旧代码判 `r.ok` ⇒ 恒为假 ⇒
          // 每次成功回答都落到 `{ok:false, reason:'未知错误'}`——面板上看到的
          // 「（未知错误）」就是这么来的。改为按 status 判定：
          //   ok / blocked / unresolved → 有答案（blocked 是内容层拦截，也要把话说给用户）
          //   cancelled / partial       → 用户停的，按成功交回（保留半截正文）
          //   其余（transport/deadline/empty/frozen）→ 真失败，带上 error 原文
          const OK_STATUS = ['ok', 'blocked', 'unresolved', 'cancelled', 'partial'];
          // ⚠️ 2026-10-25 修（生产验收「上游反复解释同一段代码」）：
          // createAssistantClient().ask 是**四参** (sessionId, text, emit, attach)，
          // 这里曾只传两参 ⇒ text 落进 sessionId、onEvent 落进 text ⇒
          // `String(onEvent)` 把**回调函数源码**当成问题发给上游（面板上表现为
          // 上游一直解释同一段 JS），用户输入从未到达。emit 也一直是 undefined，
          // 流式事件全丢。三个位置必须按契约填满。
          client.ask(sid, String(payload.text ?? ''), onEvent)
            .then((r) => {
              const st = String((r && r.status) || '');
              if (OK_STATUS.includes(st)) {
                settle({ ok: true, text: String((r && r.text) ?? '') });
                return;
              }
              settle({
                ok: false,
                reason: String((r && r.error) || st || '未收到上游响应'),
              });
            })
            .catch((e) => settle({ ok: false, reason: String((e && e.message) || e) }));
        } catch (e) {
          settle({ ok: false, reason: String((e && e.message) || e) });
        }
      });
    },

    cancel() {
      if (activeSid === null) return;
      try { bridge.cancel(); } catch { /* 无事可停 */ }
    },

    abandon(reason) {
      if (activeSid === null) return false;
      const sid = activeSid;
      activeSid = null;
      const c = clients.get(sid);
      if (c && typeof c.abandon === 'function') { try { c.abandon(reason); } catch { /* 已收 */ } }
      return true;
    },

    get busy() { return activeSid !== null; },
  };
}
