// chatsvc.mjs —— 聊天服务（一场对话）——模型驱动的深模块（2026-10-19 建，2026-10-25 去 id）
//
// ## 为什么单独一个模块
//
// 桥（bridge.mjs）只做中继：SSE 下行工具调用、/result 上行结果、/dialog-call 手动执行。
// 面板要能聊天，就得有个能被 HTTP 调用的模型驱动层。
//
// 把它做成独立模块而不是塞进 bridge.mjs：bridge 是 HTTP 门面（鉴权/CORS/SSE 编码），
// 本模块是业务逻辑（工具循环、事件流）。两者用 `emit` 接缝隔开——
// bridge 不关心模型怎么想，本模块不关心事件怎么传出去。
//
// ## 2026-10-25：会话表保留，但键不再是自造 id
//
// 这里原来有一张 `sessionId（字符串）→ 管理器 id（字符串）` 的 Map + LRU。
// 两个键都是自造的：面板铸 `"web-"+时间戳`，管理器铸 `s1`/`s2`。
// 四层名字（面板 sessionKey / 线上 sessionId / 本 Map 键 / 管理器 s1）各自
// 演化出不同生命周期，日志无法对齐（2026-10-25 上游语义实测的起点）。
//
// 现在：对外只有**管理器句柄**这一种身份。调用方要么直接拿句柄，要么用上游
// conversationId 找回（`attach(conversationId)`）。本模块不再生成任何字符串 id。
//
// 多会话本身保留：它是纳入迭代的能力（登录态下会话列表 + 恢复是上游真有的）。
//
// ⚠️ 2026-10-25（长任务实测的教训）：桥是长命单例，而每次 open 都连一条上游 WS，
// 历史在服务端累积，表现为模型反复念叨之前某场对话的内容（实测「浙江水利水电学院」）。
// 所以仍然要有上限 + LRU。
//
// ## 接口（小）
//
//   createChatService({ mgr, tools, invoke, contextProvider }) → {
//     open()                  → handle   开一场新对话（不铸 id）
//     ask(h, text, emit, attach) → Promise<{status, text, calls}>
//     cancel(h)               → {cancelled}
//     upload(h, bytes, opts)  → fileInfo
//     attach(conversationId)  → handle|null   按上游真名找回
//     close(h?)
//     traceFrames(h)          → 帧级日志（ZHEN_TRACE>=3 时有内容）
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

import { createToolSession } from './toolcycle.mjs';

/**
 * 建聊天服务。
 *
 * @param {object} p
 * @param {object} p.mgr             会话管理器（createManager 的返回值，一场对话）
 * @param {Array}  [p.tools]         页面报上来的工具定义（可由调用方每次更新）
 * @param {Function} p.invoke        (name, args) → {value, effect}
 * @param {Function} [p.contextProvider] () → 页面上下文
 * @param {number} [p.rounds=4]      工具闭环轮数
 * @param {string[]} [p.navToolNames] 提示词里放行的工具
 */
export function createChatService({
  mgr, tools = [], invoke, contextProvider = null,
  rounds = 4, navToolNames = null, visionQuestion = '图里有什么？',
  maxConversations = 4,
}) {
  if (!mgr) throw new Error('createChatService: 缺少 mgr');
  if (typeof invoke !== 'function') throw new Error('createChatService: 缺少 invoke');

  // 每次 ask 时更新：工具清单可能随页面导航变化
  // 2026-10-25：tools 可能是**提供器**（() => 数组 / Promise）——每问现取，
  // 否则 SPA 换页后新增/移除的工具跟不上（站点侧注册表会变）。
  let currentTools = tools;

  // 句柄集合（不是字符串键的 Map）：上限 + LRU，防上游历史在服务端无限累积。
  const handles = [];
  const touch = (h) => {
    const i = handles.indexOf(h);
    if (i >= 0) handles.splice(i, 1);
    handles.push(h);
    while (handles.length > maxConversations) {
      const old = handles.shift();
      try { mgr.close(old); } catch { /* 已关 */ }
    }
  };

  /** 开一场新对话，返回管理器句柄（本地不铸 id）。 */
  function open() {
    const h = mgr.open({ isLLMPlanning: 1, modelId: 559 });
    touch(h);
    return h;
  }

  /** 按上游 conversationId 找回已有会话（登录态恢复用）。 */
  function attach(conversationId) {
    const h = typeof mgr.find === 'function' ? mgr.find(conversationId) : null;
    if (h) touch(h);
    return h || null;
  }

  /**
   * 开一场新对话（在**已有句柄**上换场，不新开句柄）。
   *
   * 为什么换场而不是新 open：产品路径上「新建对话」之后接着提问的，还是同一个
   * UI 会话位——新开一个句柄会让引用四处散落。这里让管理器直接在这场上换掉上游会话
   * 身份（`conversationId` 变了，句柄对象不变），调用方手里的引用继续有效。
   *
   * @param {object} h 现有句柄
   * @returns {Promise<{conversationId: string|null, changed: boolean}>}
   */
  async function newConversation(h) {
    // 换场逻辑在管理器（它持有通道与缓存），这里只转发——不在这里摸内部记录。
    if (typeof mgr.newConversation !== 'function') {
      throw new Error('管理器不支持新建会话');
    }
    return mgr.newConversation(h);
  }

  /**
   * 问一句，事件通过 emit 流出去。
   *
   * 保证：
   *   · 无论成功失败，**恰好 emit 一次 done 或 error**（调用方可以据此关流）
   *   · delta 只来自最后一轮（工具循环的过程话不推给用户）
   *   · 传输层故障不抛异常，转成 {type:'error'}
   *
   * @param {object} h        会话句柄（open() 或 attach() 给的）
   * @param {string} text     用户输入
   * @param {Function} emit   (event) => void
   * @param {Array} [attachFiles] 已上传的 fileInfo（用户附件；随首轮发出）
   * @returns {Promise<{status:string, text:string, calls:Array}>}
   */
  async function ask(h, text, emit, attachFiles) {
    const say = typeof emit === 'function' ? emit : () => {};
    if (!h) {
      say({ type: 'error', reason: '没有会话句柄' });
      return { status: 'error', text: '', calls: [] };
    }
    touch(h);

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
      mgr, session: h, invoke: wrappedInvoke,
      tools: typeof currentTools === 'function'
        ? await currentTools()
        : (Array.isArray(currentTools) ? currentTools : []),
      rounds, navToolNames,
      // 视觉接缝：工具会话按 `(bytes, opts)` 两参调用；管理器句柄由这里绑。
      upload: (bytes, opts) => mgr.uploadImage(h, bytes, opts),
      visionQuestion, contextProvider,
    });

    let result;
    try {
      phase('generating');
      // 用户附件（2026-10-19）：作为首轮 fileInfo 进入工具会话 ——
      // 与「模型调 site_image 自动上传」共用同一条视觉通道。
      // ⚠️ 2026-10-25（无上限长任务实测：40 轮后答案退化成 15 字碎片）：
      // idleMs 50000 → 120000。长任务后期上游思考时间显著变长（实测第 40 轮
      // 63 秒无帧），50 秒的看门狗把它误判成「冻死」，已收到的正文被丢弃后重试。
      const runOpts = { timeout: 240000, idleMs: 120000, onChunk };
      if (Array.isArray(attachFiles) && attachFiles.length) runOpts.fileInfo = attachFiles;
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
      // 2026-10-22：reason 优先用真实错误（result.error），枚举值只作兜底。
      // 之前恒发 status（'transport' 之类），面板再翻译一层就变成「未知错误」，
      // 连通故障完全无法诊断。
      say({ type: 'error', reason: String(result.error || result.status) });
      return { status: result.status, error: result.error, text: result.text || '', calls: result.calls || [] };
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

  /**
   * 中止正在进行的回答（2026-10-19）。
   *
   * 只在**有在飞提问**时有效；没有就返回 `{cancelled:false}`。
   * 返回的 `text` 是中止前已收到的正文——调用方（bridge）用它收尾 SSE，
   * 这样前端不会因为「流突然断掉」而误判成网络故障。
   */
  function cancel(h) {
    if (!h) return { cancelled: false };
    try {
      return mgr.cancel(h) || { cancelled: false };
    } catch (e) {
      return { cancelled: false, error: String(e.message || e) };
    }
  }

  /** 关掉一个会话或全部。 */
  function close(h) {
    if (h != null) {
      try { mgr.close(h); } catch { /* 已关 */ }
      const i = handles.indexOf(h);
      if (i >= 0) handles.splice(i, 1);
      return;
    }
    for (const x of handles) { try { mgr.close(x); } catch { /* 已关 */ } }
    handles.length = 0;
  }

  /** 上传一张图（用户附件）。 */
  function upload(h, bytes, opts) {
    if (!h) return Promise.reject(new Error('没有会话句柄'));
    touch(h);
    return mgr.uploadImage(h, bytes, opts);
  }

  /** 帧级日志累积（仅 ZHEN_TRACE>=3 时有内容）。桥的 /trace 端点用它。 */
  function traceFrames(h) {
    if (!h || typeof mgr.traceFrames !== 'function') return [];
    try { return mgr.traceFrames(h) || []; } catch { return []; }
  }

  return { open, attach, newConversation, ask, cancel, upload, setTools, close, traceFrames };
}
