// session.mjs —— 多会话管理器（2026-10-25 大删除：本地零会话数据）
//
// ## 为什么把转录整条链删掉
//
// 2026-10-25 登录态实测（ZCode 浏览器，真账号）：
//   · `visitor/apply` 连续三次返回**同一个** conversationId；
//   · 发一条消息后 `msgList.total` 从 0 变 2；
//   · **刷新页面后 conversationId 不变、total 仍是 2、上游还记得前文**。
//
// ⇒ **上游自己存历史、自己压缩上下文。本地保留转录是纯粹的重复建设。**
//   更糟的是它会主动制造事故：工具循环中间轮传给 ask 的 `text` 是回喂文本
//   （实测一段 3.7K 字的工具结果），旧实现把它当「用户提问」记进转录，
//   一旦触发重放就把几万字工具结果塞回上游，模型回「人家没看懂耶」。
//
// 删掉的东西：context.mjs（转录/压缩/重放/事实台账，315 行）、
// 重放水位 deliveredSeq、成本轮换 shouldRotate、context_missing 的历史补救、
// too_long 的降级重放。**`too_long` 不再特殊处理**（站长定案）。
//
// ## 剩下的职责
//
// 只有三件：① 建连/换线重试 ② 全局串行 ③ 取消。
//
// ## 身份
//
// 唯一身份是上游发放的 **conversationId**（`open()` 返回不透明句柄对象，
// 句柄上的 `conversationId` 只读转发上游；未连上时为 null，绝不编一个）。
//
// ## 「当前会话是不是新的」怎么判
//
// 不看本地状态，看上游：`msgList(conversationId).total > 0` ⇒ 旧会话（有历史）。
// 这个判断由调用方（toolcycle）在建连后做一次，决定要不要发工具清单。
// 匿名态每次连接都是新 conversationId、total 恒 0 ⇒ 永远按新会话处理，这是上游正常行为。
//
// ## 不变量
//
//   I1 全局串行：同一时刻至多一个请求在飞（FIFO，跨会话）。
//   I2 冷启动：connect → switchModel(记录的 modelId) → 首条消息。
//   I3 句柄稳定：换线/断线都不影响调用方手里的句柄（它是对象引用）。
//   I4 传输失败管理器扛（换线重试 ≤ reconnectAttempts）；内容失败原样上抛。
//   I5 身份只来自上游：`conversationId` 只读转发，本地不生产任何会话标识。
//
// ## 热连接不再有上限（2026-10-26 靶子 1 删除 LRU 热槽）
//   每个会话建连后就一直热着，直到调用方 close。
//   会话数量上限由上层（chatsvc 的 maxConversations）负责，这里不重复调度。

import { createAssistant } from './proto.mjs';

/** 真实 adapter（默认）：唯一 import createAssistant 的地方。生灭权在管理器，这里只有动作。
 *  @param {{base: string, unitId: string|number, robotId: string|number}} upstream
 *    上游地址三件套——运行时由密文层解出（cipher.unlockUpstream），最外层传入，不硬编码。 */
export function chaoxingAdapter(upstream, hostOpts = {}) {
  // 日志策略由**宿主**注入（2026-10-25，为「node 侧整套搬进插件」做准备）。
  // 旧实现直接读 `process.env.ZHEN_DEBUG` / `ZHEN_TRACE`——那在 Node 里有效，
  // 但搬到浏览器（B 侧 iframe）会直接 `process is not defined` 崩掉。
  const log = typeof hostOpts.log === 'function' ? hostOpts.log : () => {};
  const trace = hostOpts.trace != null ? Number(hostOpts.trace) : 0;
  return {
    async open(cfg) {
      const a = createAssistant({
        base: upstream.base, unitId: upstream.unitId, robotId: upstream.robotId,
        isLLMPlanning: Number(cfg.isLLMPlanning) === 1 ? 1 : 0,
        log,
        trace,
      });
      await a.connect();
      // I2：每次建连必重切模型（上游实测：新会话回退默认 223）
      if (cfg.modelId) {
        try { await a.switchModel(cfg.modelId); } catch { /* 模型不可用则用默认 */ }
      }
      return {
        ask: (prompt, askOpts) => a.ask(prompt, askOpts),
        uploadImage: (bytes, opts) => a.uploadImage(bytes, opts),
        // 中止在飞提问：**必须显式转发**，否则管理器那侧的 typeof 判定为假、
        // 静默跳过（实测症状：按了停止，桥回 cancelled:false，上游继续生成）。
        cancel: () => a.cancel(),
        // 上游真名（只读）：本通道所在的那一场对话。未连上时是 null。
        conversationId: () => (a.identity && a.identity.conversationId) || null,
        // 「当前会话是不是新的」判据：上游 msgList 的 total。
        // 建连后调一次即可（同一个 conversationId 下 total 只会增）。
        msgListTotal: () => a.msgListTotal(),
        traceFrames: () => (typeof a.traceFrames !== 'undefined' ? a.traceFrames : []),
        frameCount: () => (typeof a.frameCount === 'number' ? a.frameCount : 0),
        close: () => a.close(),
      };
    },
  };
}

/**
 * 建管理器。
 * @param {object} [opts]
 * @param {{open: Function}} [opts.adapter]   seam：默认 chaoxingAdapter()（需 opts.upstream）
 * @param {{base: string, unitId: string|number, robotId: string|number}} [opts.upstream]
 * @param {number} [opts.reconnectAttempts]   传输层换线重试上限，默认 2
 * @param {number} [opts.deadlineMs]          单次 ask 墙钟上限，默认 360000
 */
export function createManager(opts = {}) {
  const adapter = opts.adapter || chaoxingAdapter(opts.upstream || {});
  const reconnectAttempts = opts.reconnectAttempts != null ? opts.reconnectAttempts : 2;
  const openTimeoutMs = opts.openTimeoutMs != null ? opts.openTimeoutMs : 45000;
  const retryBackoffMs = opts.retryBackoffMs != null ? opts.retryBackoffMs : 2000;
  const deadlineMs = opts.deadlineMs != null ? opts.deadlineMs : 360000;

  /** 会话记录（内部）。**不作为调用方句柄暴露**——外面拿到的是 handle。 */
  const records = new Map();   // handle → record
  let closed = false;
  let chain = Promise.resolve();   // 全局串行队列（I1）

  /**
   * 句柄：调用方手里唯一的会话引用。
   *
   * 为什么是对象而不是字符串 id：字符串 id 必须由某处生成（计数器 / 随机量），
   * 那就是「自造 id」本身。对象引用天然唯一、天然稳定。
   */
  const handleOf = (rec) => Object.freeze({
    /** 上游发放的真名（未连上时为 null）。唯一允许跨边界传播的身份。 */
    get conversationId() {
      try {
        return (rec.channel && typeof rec.channel.conversationId === 'function'
          ? rec.channel.conversationId()
          : null) || null;
      } catch { return null; }
    },
    /** 当前会话的历史条数（上游 msgList.total）。null = 还没连过。
     *  判据：> 0 就是旧会话（有历史），不必再发工具清单。 */
    get msgListTotal() {
      // 建连时缓存的（见 ensureChannel）。null = 还没连过 / 取不到。
      return rec.msgListTotal != null ? rec.msgListTotal : null;
    },
    // 2026-10-26 语义大逃杀（靶子 2）：这里原有 `hot` 与 `config` 两个 getter，
    // 全仓零读者（hot 的唯一读者是 snapshot 测试，而 snapshot 已删）——删掉。
    // 保留 conversationId（chatsvc.attach 用于找回会话）与 msgListTotal
    // （toolcycle 判新会话/旧会话）。句柄对象本身删不掉：实测用 conversationId
    // 当 Map 键会让两场本地会话撞同一个键（visitor/apply 连续三次返回同一 cid），
    // 第二场覆盖第一场 ⇒ 会话丢失 + 热通道泄漏。对象身份是它真正在解决的问题。
  });

  const recOf = (h) => {
    const rec = records.get(h);
    if (!rec) throw Object.assign(new Error('未知会话（句柄已失效）'), { code: 'SESSION_NOT_FOUND' });
    return rec;
  };

  /** 冷启动：open 带超时兜底（connect 握手挂起既不 open 也不 error 时，没有这层就死锁）。
   *  超时值取 openTimeoutMs（默认 45s）——与 chaoxing 内部的 30s 握手超时形成两级保险。 */
  const ensureChannel = async (h) => {
    const rec = recOf(h);
    if (rec.channel) return rec.channel;
    // 超时定时器**必须在 open 胜出时清掉**（P1-7 教训：漏一个就吊住事件循环）。
    let openTimer = null;
    try {
      rec.channel = await Promise.race([
        adapter.open(rec.cfg),
        new Promise((_, rej) => { openTimer = setTimeout(() => rej(new Error('connect 超时')), openTimeoutMs); }),
      ]);
    } finally {
      if (openTimer) { clearTimeout(openTimer); openTimer = null; }
    }
    // ⚠️ 2026-10-25 修：`msgListTotal()` 是 **async**（要发一次 HTTP），
    // 旧实现把它当同步值读 ⇒ 拿到的是 Promise 对象，`typeof === 'number'` 恒假
    // ⇒ 判据永远认为「新会话」，第二次提问照样发工具清单（实测提示词 1286 字）。
    //
    // 正确做法：建连后取一次，缓存在 record 上。同一个 conversationId 下
    // total 只会增不会减，取一次够用。
    try {
      rec.msgListTotal = await rec.channel.msgListTotal();
    } catch { rec.msgListTotal = null; }
    return rec.channel;
  };

  const dropChannel = (rec) => {
    if (rec.channel) { try { rec.channel.close(); } catch { /* ignore */ } }
    rec.channel = null;
    if (rec.deadlineTimer) { clearTimeout(rec.deadlineTimer); rec.deadlineTimer = null; }
  };

  const doAsk = async (h, text, askOpts = {}) => {
    const rec = recOf(h);
    const t0 = Date.now();

    // ⚠️ 2026-10-25 修：`msgListTotal` 必须**每次提问前刷新**，不能只在建连时取。
    //
    // 实测（两次提问）：第一次提问后上游 total 从 0 变成 2，但缓存还停在 0
    // ⇒ 第二次提问的第一轮照样发工具清单（实测提示词带 site_search）。
    //
    // 刷新时机放在这里（doAsk 开头）而不是 ensureChannel：ensureChannel 在
    // 热连接时直接 return，不会重取；而 doAsk 每次提问都会走到。
    // 失败不影响问答（判据取不到 ⇒ null ⇒ 上层按新会话处理，多发一次清单）。
    if (rec.channel && typeof rec.channel.msgListTotal === 'function') {
      try { rec.msgListTotal = await rec.channel.msgListTotal(); }
      catch { rec.msgListTotal = null; }
    }

    let attempt = 0;
    for (;;) {
      if (Date.now() - t0 > deadlineMs) {
        return { text: '', calls: [], attempts: attempt, status: 'deadline' };
      }
      let ch;
      try {
        ch = await ensureChannel(h);
      } catch (e) {
        return { text: '', calls: [], attempts: attempt, error: String(e.message || e), status: 'transport' };
      }
      try {
        // 墙钟兜底必须罩住挂死的 ask：用 Promise.race，永不返回的通道也能收束。
        const r = await Promise.race([
          ch.ask(text, askOpts),
          new Promise((_, rej) => {
            const left = deadlineMs - (Date.now() - t0);
            if (left <= 0) { rej(new Error('deadline')); return; }
            rec.deadlineTimer = setTimeout(() => rej(new Error('deadline')), left);
          }),
        ]);
        if (rec.deadlineTimer) { clearTimeout(rec.deadlineTimer); rec.deadlineTimer = null; }
        const txt = (r.text || '').trim();
        // 用上游返回的**类型化 status** 决定策略（不靠「text 是否为空」反推）：
        //   answered → 成功；blocked → 内容层失败（上抛，不重试）
        //   partial / cancelled → 用户点了停止：直接返回，绝不重试
        //   frozen / transport / empty → 通道废了，换线重试
        //   deadline → 墙钟到点，直接收束
        const st = r.status || (txt ? 'answered' : 'frozen');
        // 取消标记（第二层保险）：cancel() 可能扑空（SSE 先断，桥已收尾），
        // 但标记留着。这里消费它——即使上游正常答完，也按 partial 交回去。
        const wasCancelled = !!rec.cancelRequested;
        if (wasCancelled) rec.cancelRequested = false;
        if (st === 'partial' || st === 'cancelled' || wasCancelled) {
          return { text: txt, calls: [], attempts: attempt,
                   status: st === 'cancelled' ? 'cancelled' : 'partial', cancelled: true };
        }
        // **frozen 但有正文**时不许丢（长任务后期误杀的主要损失点）：
        // 有正文就按 partial 交回，比丢掉重试再拿个空答案好。
        if (st === 'frozen' && txt) {
          return { text: txt, calls: [], attempts: attempt, status: 'partial', error: 'frozen_with_text' };
        }
        if (st === 'frozen' || st === 'transport' || st === 'empty') {
          dropChannel(rec);
          attempt += 1;
          if (st === 'empty') {
            // 有终止帧却零正文 = 上游真的答了空。重试一次即可，不要无限换线。
            if (attempt > 1 || Date.now() - t0 > deadlineMs) {
              return { text: '', calls: [], attempts: attempt, error: 'empty', status: 'empty' };
            }
          } else if (attempt > reconnectAttempts || Date.now() - t0 > deadlineMs) {
            // 优先带 adapter 给的**真实原因**（r.error），没有才退回枚举值。
            return { text: '', calls: [], attempts: attempt, error: (r && r.error) || st, status: st };
          }
          continue;   // 换线重试
        }
        // too_long / context_missing：**不再特殊处理**（站长定案）。
        // 上游自己压缩上下文；它若仍拒绝，如实把原文交回去，让上层按内容失败处理。
        if (st === 'deadline') {
          return { text: txt, calls: [], attempts: attempt + 1, error: 'deadline', status: 'deadline' };
        }
        return {
          text: txt, calls: r.calls || [], attempts: attempt + 1,
          // sandboxCalls 必须透传（审计 C2）：proto 产出、toolcycle 消费，
          // 中间这一层断过 ⇒ 拦截机制从上线起从未生效。
          sandboxCalls: r.sandboxCalls || [], terminal: r.terminal,
          status: st === 'blocked' ? 'blocked' : 'ok',
          // 耗时诊断：这份是唯一实现，缺了面板永远显示「0.0s」。
          ms: Date.now() - t0,
          roundMs: r.ms != null ? r.ms : null,
        };
      } catch (e) {
        // 传输失败（超时/断线/冻死/墙钟抛出）⇒ 换线重试（管理器扛）
        dropChannel(rec);
        attempt += 1;
        // 墙钟到点：不再重试，收束返回（避免 deadline 后又开新连接白跑）
        if (String(e.message) === 'deadline' || Date.now() - t0 > deadlineMs) {
          return { text: '', calls: [], attempts: attempt, error: 'deadline', status: 'deadline' };
        }
        if (attempt > reconnectAttempts) {
          return { text: '', calls: [], attempts: attempt, error: String(e.message || e), status: 'transport' };
        }
        await new Promise((r2) => setTimeout(r2, Math.min(retryBackoffMs * attempt, 60000)));
      }
    }
  };

  return {
    /** 开一个逻辑会话。同步、零网络。返回不透明句柄（对象引用，不是字符串 id）。 */
    open(cfg = {}) {
      if (closed) throw new Error('管理器已关闭');
      const rec = {
        cfg: { isLLMPlanning: Number(cfg.isLLMPlanning) === 1 ? 1 : 0, modelId: cfg.modelId || 559 },
        channel: null,
        msgListTotal: null,   // 建连后取一次（上游 msgList.total）
        cancelRequested: false, deadlineTimer: null,
      };
      const h = handleOf(rec);
      records.set(h, rec);
      return h;
    },

    /** 问。串行排队；换线对调用方不可见（结果字段里可观测）。 */
    ask(h, text, askOpts) {
      if (closed) return Promise.reject(new Error('管理器已关闭'));
      if (!records.has(h)) {
        return Promise.reject(Object.assign(new Error('未知会话（句柄已失效）'), { code: 'SESSION_NOT_FOUND' }));
      }
      const run = chain.then(() => doAsk(h, text, askOpts));
      chain = run.catch(() => {});   // 队列不断链
      return run;
    },

    /**
     * 中止某个会话正在进行的提问（用户点「停止回答」）。
     *
     * 语义：**只停当前这一问，连接留着**。
     *   · 不 close 通道 —— 否则下次提问要重新握手，还可能丢上下文
     *   · 已收到的正文作为 `partial` 返回，由上层决定怎么落盘
     *
     * 两层保险：① 通道在 ⇒ 立刻 cancel（上游马上停）；
     * ② 通道不在 / cancel 没命中 ⇒ 在会话上打标记，doAsk 收尾时看到就改写成 partial。
     * 第二层是必要的：SSE 一断，桥那边的 handler 可能已收尾，cancel 扑空。
     */
    cancel(h) {
      const rec = records.get(h);
      if (!rec) return { cancelled: false };
      let hit = { cancelled: false };
      if (rec.channel && typeof rec.channel.cancel === 'function') {
        try { hit = rec.channel.cancel() || hit; } catch (e) { hit = { cancelled: false, error: String(e.message || e) }; }
      }
      rec.cancelRequested = true;
      return hit;
    },

    /** 上传一张图，返回 fileInfo（视觉通道）。转发到当前热通道。 */
    uploadImage(h, bytes, opts) {
      // 排队走同一条链（P2-19：绕过 chain 可能与在飞的 ask 并发改 channel）。
      if (closed) return Promise.reject(new Error('管理器已关闭'));
      const run = chain.then(async () => {
        if (!records.has(h)) throw new Error('未知会话（句柄已失效）');
        const ch = await ensureChannel(h);
        if (!ch || typeof ch.uploadImage !== 'function') {
          throw new Error('当前通道不支持图片上传（adapter 未实现 uploadImage）');
        }
        return ch.uploadImage(bytes, opts);
      });
      chain = run.catch(() => {});
      return run;
    },

    /** 全部会话句柄。 */
    conversations() {
      return [...records.keys()];
    },

    /** 某会话的历史条数（上游 msgList.total）。null = 还没连过 / 取不到。
     *  判据：> 0 ⇒ 旧会话（有历史），不必再发工具清单。 */
    msgListTotal(h) {
      const rec = records.get(h);
      if (!rec) return null;
      // 建连时缓存的（见 ensureChannel）——**同步读**，因为 toolcycle 在拼提示词时
      // 需要立刻决定发不发清单，不能 await。
      return rec.msgListTotal != null ? rec.msgListTotal : null;
    },

    /** 帧级日志累积（仅 ZHEN_TRACE>=3 时有内容）。 */
    traceFrames(h) {
      const rec = records.get(h);
      if (!rec || !rec.channel || typeof rec.channel.traceFrames !== 'function') return [];
      try { return rec.channel.traceFrames() || []; } catch { return []; }
    },

    /** 当前帧计数（诊断）。 */
    frameCount(h) {
      const rec = records.get(h);
      if (!rec || !rec.channel || typeof rec.channel.frameCount !== 'function') return 0;
      try { return rec.channel.frameCount() || 0; } catch { return 0; }
    },

    /** 按**上游 conversationId** 找回会话（登录态恢复走这条）。 */
    find(conversationId) {
      if (!conversationId) return null;
      for (const [handle, rec] of records) {
        try {
          const id = rec.channel && typeof rec.channel.conversationId === 'function'
            ? rec.channel.conversationId()
            : null;
          if (id && id === conversationId) return handle;
        } catch { /* 忽略坏通道 */ }
      }
      return null;
    },

    /** 带参关一个；不带销毁全部。幂等。 */
    close(h) {
      if (h != null) {
        const rec = records.get(h);
        if (rec) {
          dropChannel(rec);
          records.delete(h);
        }
        return;
      }
      closed = true;
      for (const [, rec] of records) dropChannel(rec);
      records.clear();
    },
  };
}
