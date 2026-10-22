// chatsvc.mjs ——（浏览器移植版，源 .zcode/学习通API/聊天服务.mjs，逻辑零改动）
// 聊天服务 —— 模型驱动的深模块（2026-10-19）。
//
// ## 为什么单独一个模块
//
// 桥（bridge.mjs）现在只做中继：SSE 下行工具调用、/result 上行结果、/dialog-call 手动执行。
// 但「浏览器发一句话 → 模型思考 → 调工具 → 回答」这条链路此前只存在于 CLI 的 对话.mjs 里。
// 面板要能聊天，就得有个能被 HTTP 调用的模型驱动层。
//
// 把它做成独立模块而不是塞进 bridge.mjs：bridge 是 HTTP 门面（鉴权/CORS/SSE 编码），
// 本模块是业务逻辑（会话、工具循环、事件流）。两者用 `emit` 接缝隔开——
// bridge 不关心模型怎么想，本模块不关心事件怎么传出去。
//
// ## 接口（小）
//
//   createChatService({ mgr, tools, invoke, upload, contextProvider }) → {
//     ask(sessionId, text, emit) → Promise<{status, text, calls}>
//     snapshot(sessionId)        → 会话状态
//     close()
//   }
//
// `emit(event)` 是唯一输出通道，事件类型固定四种：
//   { type:'delta', text }        文本增量（流式）
//   { type:'tool',  name, ok }    工具执行完（前端不显示，调试用）
//   { type:'done',  status, text } 完成
//   { type:'error', reason }      失败
//
// ## 为什么 emit 而不是返回流
//
// 调用方可能是 SSE（bridge）、CLI（对话.mjs）、测试（直接收集数组）。
// 回调是最小的公共接口——不需要 async iterator，也不需要知道 SSE 编码。
//
// ## 浏览器移植差异（仅一处）：import 从 ./工具会话.mjs 改为 ./toolcycle.mjs。

import { createToolSession } from './toolcycle.mjs';

/**
 * 建聊天服务。
 *
 * @param {object} p
 * @param {object} p.mgr             会话管理器（createManager 的返回值）
 * @param {Array}  [p.tools]         页面报上来的工具定义（可由调用方每次更新）
 * @param {Function} p.invoke        (name, args) → {value, effect}
 * @param {Function} [p.upload]      (bytes, opts) → fileInfo（视觉链路）
 * @param {Function} [p.contextProvider] () → 页面上下文
 * @param {number} [p.rounds=4]      工具闭环轮数
 * @param {string[]} [p.navToolNames] 提示词里放行的工具（G20：只放前 3 个进提示词）
 */
export function createChatService({
  mgr, tools = [], invoke, upload = null, contextProvider = null,
  rounds = 4, navToolNames = null, visionQuestion = '图里有什么？',
}) {
  if (!mgr) throw new Error('createChatService: 缺少 mgr');
  if (typeof invoke !== 'function') throw new Error('createChatService: 缺少 invoke');

  // sessionId（浏览器侧的会话名）→ 管理器 id
  const sessions = new Map();
  // 每次 ask 时更新：工具清单可能随页面导航变化
  let currentTools = tools;

  const getSession = (key) => {
    if (!sessions.has(key)) {
      sessions.set(key, mgr.open({ planning: true, modelId: 559 }));
    }
    return sessions.get(key);
  };

  /**
   * 上传一张图给上游，返回 fileInfo（2026-10-19 用户附件）。
   *
   * 与工具会话里那个 `upload` 是同一件事，只是入口不同：
   *   · 工具会话：模型调 site_image 取到页面图 → 自动上传
   *   · 这里：用户自己挑的图 → 面板 POST /upload → 桥调本方法
   *
   * 为什么要走会话：上传要带 conversationId，而它绑在具体通道上。
   * 所以先 getSession 确保会话存在（顺带触发热通道），再转交管理器。
   */
  async function uploadOne(sessionId, bytes, opts) {
    const sid = getSession(String(sessionId || 'default'));
    return mgr.uploadImage(sid, bytes, opts || {});
  }

  /**
   * 问一句，事件通过 emit 流出去。
   *
   * 保证：
   *   · 无论成功失败，**恰好 emit 一次 done 或 error**（调用方可以据此关流）
   *   · delta 只来自最后一轮（工具循环的过程话不推给用户）
   *   · 传输层故障不抛异常，转成 {type:'error'}
   *
   * @param {string} sessionId 浏览器侧的会话名（不同名字 = 不同上下文）
   * @param {string} text      用户输入
   * @param {Function} emit    (event) => void
   * @param {Array} [attach]   已上传的 fileInfo（用户附件；随首轮发出）
   * @returns {Promise<{status:string, text:string, calls:Array}>}
   */
  async function ask(sessionId, text, emit, attach) {
    const say = typeof emit === 'function' ? emit : () => {};
    const key = String(sessionId || 'default');
    const sid = getSession(key);

    // 流式：只在最后一轮转发（工具会话内部已按 lastRound 过滤）
    //
    // ⚠️ 已知：由于 lastRound 几乎走不到，这条流式**实际很少生效**。
    // 2026-10-19 试过「每轮都转发 + retract 撤回」，调查判定不成熟已回退，
    // 四个致命问题记在 toolcycle.mjs 的流式注释里。
    let streamed = false;
    const onChunk = (chunk) => {
      if (!chunk) return;
      streamed = true;
      say({ type: 'delta', text: String(chunk) });
    };

    // ── 思考 ↔ 输出 的区分（2026-10-19 用户要求）────────────────
    //
    // 问题：面板在「模型正在查资料」的整段时间里完全空白。实测一问两次工具
    // 调用后挂了 384 秒才收束——用户看到的只有静默，分不清是卡死还是在干活。
    //
    // 做法：`emit` 的第四类事件 `status` 专报**过程**（阶段 + 已用秒数 + 工具名），
    // 与 `delta`（答案正文）走不同通道。前端把 status 渲染成一行灰色的
    // 「正在检索资料库…」而不是正文气泡；答案一到，这行自动消失。
    //
    // 为什么单独一类事件而不是往 delta 里塞标记：任何带内标记都会污染
    // 「accumulate → parse → render」这条纯管线，也会被写进最终文本。
    const t0 = Date.now();
    const phase = (p, extra) => {
      say(Object.assign({ type: 'status', phase: p, ms: Date.now() - t0 }, extra || {}));
    };
    phase('thinking');

    // 包装 invoke：每次工具执行完 emit 一个 tool 事件（前端不显示，调试/日志用）
    const wrappedInvoke = async (name, args) => {
      phase('tool', { tool: name });
      try {
        const r = await invoke(name, args);
        say({ type: 'tool', name, ok: true });
        phase('tool-ok', { tool: name });
        return r;
      } catch (e) {
        say({ type: 'tool', name, ok: false, error: String(e.message || e) });
        phase('tool-fail', { tool: name });
        throw e;
      }
    };

    const ts = createToolSession({
      mgr, sessionId: sid, invoke: wrappedInvoke,
      tools: currentTools,
      rounds, navToolNames,
      upload, visionQuestion, contextProvider,
    });

    let result;
    try {
      phase('generating');
      // 用户附件（2026-10-19）：作为首轮 fileInfo 进入工具会话 ——
      // 与「模型调 site_image 自动上传」共用同一条视觉通道。
      const runOpts = { timeout: 180000, idleMs: 50000, onChunk };
      if (Array.isArray(attach) && attach.length) runOpts.fileInfo = attach;
      result = await ts.run(text, runOpts);
    } catch (e) {
      say({ type: 'error', reason: String(e.message || e) });
      return { status: 'error', text: '', calls: [] };
    }

    // ── 用户点了停止（2026-10-19）──────────────────────────────
    //
    // 工具会话把管理器返回的 partial/cancelled 透传到这里。此时：
    //   · 已经流出去的 delta 就是用户看到的「半截答案」，**不要再补发**
    //   · 发 done 而不是 error —— 这是用户主动要的正常结束，不是故障
    //   · status 带上 cancelled，前端据此把光标收掉、不显示任何错误
    if (result.status === 'partial' || result.status === 'cancelled') {
      const keptText = String(result.text || '');
      say({ type: 'done', status: 'cancelled', text: keptText });
      return { status: 'cancelled', text: keptText, calls: result.calls || [] };
    }

    // 传输层故障：工具会话已经如实返回 status，这里翻译成 error 事件
    if (result.status && result.status !== 'ok' && result.status !== 'blocked' && result.status !== 'unresolved') {
      say({ type: 'error', reason: result.status });
      return { status: result.status, text: result.text || '', calls: result.calls || [] };
    }

    // 若模型没走流式（例如答案很短、或者非流式通道），把完整答案当作一个 delta 补发，
    // 保证前端拿到的文本与 done.text 一致。
    const finalText = String(result.answer || '');
    if (!streamed && finalText) say({ type: 'delta', text: finalText });

    say({ type: 'done', status: result.status || 'ok', text: finalText,
          // 诊断（2026-10-20 查「每次都 50 秒」）：每轮耗时随 done 一起送到前端。
          // 面板把它显示在状态行里，用户能直接看出是「一轮就慢」还是「轮数叠加」。
          timings: Array.isArray(result.timings) ? result.timings : undefined });
    return { status: result.status || 'ok', text: finalText, calls: result.calls || [] };
  }

  /** 更新工具清单（页面导航后工具可能变化）。 */
  function setTools(next) {
    if (Array.isArray(next)) currentTools = next;
  }

  /** 会话状态（刷新页面后恢复用）。 */
  function snapshot(sessionId) {
    const sid = sessions.get(String(sessionId || 'default'));
    if (!sid) return null;
    return mgr.snapshot(sid);
  }

  /**
   * 中止某个会话正在进行的回答（2026-10-19）。
   *
   * 只在**有在飞提问**时有效；没有就返回 `{cancelled:false}`。
   * 返回的 `text` 是中止前已收到的正文——调用方（bridge）用它收尾 SSE，
   * 这样前端不会因为「流突然断掉」而误判成网络故障。
   */
  function cancel(sessionId) {
    const key = String(sessionId || 'default');
    const sid = sessions.get(key);
    if (!sid) return { cancelled: false };
    try {
      return mgr.cancel(sid) || { cancelled: false };
    } catch (e) {
      return { cancelled: false, error: String(e.message || e) };
    }
  }

  /** 关掉一个会话或全部。 */
  function close(sessionId) {
    if (sessionId != null) {
      const sid = sessions.get(String(sessionId));
      if (sid) { mgr.close(sid); sessions.delete(String(sessionId)); }
      return;
    }
    for (const sid of sessions.values()) { try { mgr.close(sid); } catch { /* 已关 */ } }
    sessions.clear();
  }

  /** 调用方（bridge /upload）用的上传入口：转交 uploadOne。 */
  function upload(sessionId, bytes, opts) {
    return uploadOne(sessionId, bytes, opts);
  }

  return { ask, cancel, upload, setTools, snapshot, close };
}
