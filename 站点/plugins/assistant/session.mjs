// session.mjs —— 多会话管理器（2026-10-25 按上游语义重写：身份只来自上游）
//
// ## 为什么删掉自造 id，而不是改名
//
// 2026-10-25 实测上游语义（.zcode/会话语义/）：一场对话的唯一身份是服务端发放的
// **conversationId**。我们此前为同一件事造了四层名字——
//   面板 sessionKey（"web-" + Date.now()%100000）
//   线上 sessionId
//   chatsvc 的 Map 键
//   管理器的 s1 / s2
// 四层各有一套生命周期（面板是页面常量、线上是路由标、Map 键是查找键、句柄是引用），
// 日志无法对齐，改一处漂三处。
//
// 但**多会话本身是纳入迭代的能力**（登录态下会话列表 + 恢复是上游真实提供的），
// 所以这里不做「退化成一场对话」，而是换掉身份的来源：
//   · `open()` 返回一个**不透明句柄对象**（不是字符串、不是计数器）——本地不造 id；
//   · 句柄上的 `conversationId` 是**上游发的**（未连上时为 null，绝不编一个）；
//   · `find(conversationId)` 按上游真名找回会话——恢复会话走这条路，不走自造键。
//
// ## 接口
//   createManager(opts) → {
//     open(cfg?)                → handle     同步、零网络（开 50 个会话零成本）
//     ask(handle, text, opts?)  → result     唯一触碰连接生命周期的入口
//     cancel(handle)            → {cancelled}
//     rotate(handle)            → bool       拆热连接（转录保留），下次 ask 冷启动 + 重放
//     uploadImage(handle, bytes, opts) → fileInfo
//     snapshot(handle?)         → 单会话快照 / 全部句柄快照数组
//     conversations()           → handle[]   全部会话（面板列表用）
//     find(conversationId)      → handle|null 按上游真名找回
//     close(handle?)            → void       带参关一个，不带销毁全部；幂等
//   }
//
// ## 不变量
//   I1 转录唯一真相源：ask resolve 前必已 transcript.add；连接随时可杀不丢轮。
//   I2 全局串行：同一时刻至多一个请求在飞（FIFO，跨会话）。
//   I3 冷启动三段式：connect → switchModel(记录的 modelId) → 首条消息
//      （有水位缺口 ⇒ buildRestoreParts 打包，否则裸问题）。
//   I4 句柄稳定：轮换/逐出/断线都不影响调用方手里的句柄（它是对象引用）。
//   I5 传输失败管理器扛（换线重放 ≤ reconnectAttempts）；内容失败（BLOCKED/gaveUp）
//      原样 resolve 上抛，话术策略留调用方。
//   I6 身份只来自上游：`conversationId` 只读转发，本地不生产任何会话标识。
//
// ## 热槽 2 个（不是 1）：双会话比较是真实场景，乒乓成本不该由用户付。
//   LRU 逐出；在飞会话即 MRU，不可能被逐出。

import { createAssistant, isBlockedText, isTooLongText, isContextMissingText } from './proto.mjs';
import { createTranscript } from './context.mjs';

/** 真实 adapter（默认）：唯一 import createAssistant 的地方。生灭权在管理器，这里只有动作。
 *  @param {{base: string, unitId: string|number, robotId: string|number}} upstream
 *    上游地址三件套——运行时由密文层解出（cipher.unlockUpstream），最外层传入，不硬编码。 */
export function chaoxingAdapter(upstream) {
  return {
    async open(cfg) {
      const a = createAssistant({
        base: upstream.base, unitId: upstream.unitId, robotId: upstream.robotId,
        planning: !!cfg.planning,
        // 诊断开关：ZHEN_DEBUG=1 时把 proto 的帧级日志打到 stderr
        log: process.env.ZHEN_DEBUG ? (...a) => console.error('[proto]', ...a) : () => {},
        // 帧级日志档位（2026-10-25）：ZHEN_TRACE=0/1/2/3
        //   0 关闭  1 每帧一行摘要（默认）  2 +原始 JSON(截断 4KB)  3 全帧累积供落盘
        // 只在 ZHEN_DEBUG 打开时才有效——否则没地方打。
        trace: process.env.ZHEN_DEBUG
          ? Number(process.env.ZHEN_TRACE != null ? process.env.ZHEN_TRACE : 1)
          : 0,
      });
      await a.connect();
      // I3：每次建连必重切模型（上游实测：新会话回退默认 223）
      if (cfg.modelId) {
        try { await a.switchModel(cfg.modelId); } catch { /* 模型不可用则用默认 */ }
      }
      return {
        // 2026-10-19 流式：askOpts.onChunk 由 chaoxing.ask 直接消费，这里无需额外处理；
        // 但 adapter 契约要显式承认它存在（askOpts 原样透传）。
        ask: (prompt, askOpts) => a.ask(prompt, askOpts),
        // 快路径：只发帧不等回答（重放背景段用，见 context.mjs 的 replayBudget）
        send: (text) => a.send(text),
        // 视觉通道（2026-10-19）：上传图返回 fileInfo，供后续 ask 的 askOpts.fileInfo 使用。
        uploadImage: (bytes, opts) => a.uploadImage(bytes, opts),
        // 中止在飞提问（2026-10-19 用户要求「停止回答」）：
        // **必须在这里显式转发**，否则管理器那侧的 `typeof channel.cancel`
        // 判定为假、静默跳过——实测症状就是面板按了停止，桥回 cancelled:false，
        // 上游继续生成 26 秒后照常交答案。
        cancel: () => a.cancel(),
        // 上游真名（只读）：本通道所在的那一场对话。管理器拿它做「恢复会话」的键，
        // 但绝不自己造一个——未连上时是 null。
        conversationId: () => (a.identity && a.identity.conversationId) || null,
        // 帧级日志累积（ZHEN_TRACE>=3 时才有内容）：供调用方落盘回放。
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
 *   上游地址三件套——仅默认 adapter 使用（运行时由密文层解出传入，不硬编码）
 * @param {Function} [opts.transcriptFactory] seam：默认 createTranscript（测试调小阈值）
 * @param {number} [opts.hotSlots]            热连接上限，默认 2
 * @param {number} [opts.reconnectAttempts]   传输层换线重试上限，默认 2
 * @param {number} [opts.deadlineMs]          单次 ask 墙钟上限，默认 360000
 */
export function createManager(opts = {}) {
  const adapter = opts.adapter || chaoxingAdapter(opts.upstream || {});
  const transcriptFactory = opts.transcriptFactory || createTranscript;
  const hotSlots = opts.hotSlots != null ? opts.hotSlots : 2;
  const reconnectAttempts = opts.reconnectAttempts != null ? opts.reconnectAttempts : 2;
  const openTimeoutMs = opts.openTimeoutMs != null ? opts.openTimeoutMs : 45000;
  const retryBackoffMs = opts.retryBackoffMs != null ? opts.retryBackoffMs : 2000;
  const deadlineMs = opts.deadlineMs != null ? opts.deadlineMs : 360000;

  /** 会话记录（内部）。**不作为调用方句柄暴露**——外面拿到的是 handle。 */
  const records = new Map();   // handle → record
  const hotOrder = [];         // LRU 序（MRU 在尾），元素是 handle
  let closed = false;
  let chain = Promise.resolve();   // 全局串行队列（I2）

  /**
   * 句柄：调用方手里唯一的会话引用。
   *
   * 为什么是对象而不是字符串 id：字符串 id 必须由某处生成（计数器 / 随机量），
   * 那就是「自造 id」本身。对象引用天然唯一、天然稳定，且不参与任何序列化——
   * 跨进程边界时用上游 conversationId，不跨边界时用它。
   */
  const handleOf = (rec) => Object.freeze({
    /** 上游发放的真名（未连上时为 null）。这是唯一允许跨边界传播的身份。 */
    get conversationId() {
      try {
        return (rec.channel && typeof rec.channel.conversationId === 'function'
          ? rec.channel.conversationId()
          : null) || null;
      } catch { return null; }
    },
    /** 第几次建连（诊断用：轮换/换线会递增）。 */
    get generation() { return rec.generation || 0; },
    /** 当前是否有热连接。 */
    get hot() { return !!rec.channel; },
    /** 配置（只读副本）。 */
    get config() { return { ...rec.cfg }; },
  });

  const touch = (h) => {
    const i = hotOrder.indexOf(h);
    if (i >= 0) hotOrder.splice(i, 1);
    hotOrder.push(h);
  };

  /** 逐出最久未用的热连接（在飞的即 MRU，不会被逐）。通道没了 = 水位归零。 */
  const evictIfNeeded = () => {
    while (hotOrder.length > hotSlots) {
      const victim = hotOrder.shift();
      const rec = records.get(victim);
      if (rec && rec.channel) {
        try { rec.channel.close(); } catch { /* ignore */ }
        rec.channel = null;
        rec.deliveredSeq = 0;   // ⚠️ 通道消失 = 它交付的历史全丢（上游内存清零）
      }
    }
  };

  const recOf = (h) => {
    const rec = records.get(h);
    if (!rec) throw Object.assign(new Error('未知会话（句柄已失效）'), { code: 'SESSION_NOT_FOUND' });
    return rec;
  };

  /** 冷启动：open 带超时兜底（connect 握手挂起既不 open 也不 error 时，没有这层就死锁）。
   *  超时值取 openTimeoutMs（默认 45s）——与 chaoxing 内部的 30s 握手超时形成两级保险，
   *  外层略大，让内层先报更精确的原因。 */
  const ensureChannel = async (h) => {
    const rec = recOf(h);
    if (rec.channel) return rec.channel;
    rec.generation += 1;
    // 2026-10-19 修 P1-7：超时定时器**必须在 open 胜出时清掉**。
    // 旧实现每个冷启动都留一个活着的 45s timer（测试套件耗时 45.5s 就是证据），
    // 长跑进程里会累积并吊住事件循环。
    let openTimer = null;
    try {
      rec.channel = await Promise.race([
        adapter.open(rec.cfg),
        new Promise((_, rej) => { openTimer = setTimeout(() => rej(new Error('connect 超时')), openTimeoutMs); }),
      ]);
    } finally {
      if (openTimer) { clearTimeout(openTimer); openTimer = null; }
    }
    rec.deliveredSeq = 0;   // 新通道什么都还没交付
    touch(h);
    evictIfNeeded();
    return rec.channel;
  };

  const dropChannel = (rec) => {
    if (rec.channel) { try { rec.channel.close(); } catch { /* ignore */ } }
    rec.channel = null;
    rec.deliveredSeq = 0;
    if (rec.deadlineTimer) { clearTimeout(rec.deadlineTimer); rec.deadlineTimer = null; }
  };

  const doAsk = async (h, text, askOpts = {}) => {
    const rec = recOf(h);
    const t0 = Date.now();

    // 惰性轮换：成本阈值命中 ⇒ 先变冷（复用同一条冷启动路径）
    if (rec.channel && rec.transcript.shouldRotate()) dropChannel(rec);

    let attempt = 0;
    let level = 0;   // 重放降级阶梯
    for (;;) {
      if (Date.now() - t0 > deadlineMs) {
        return { text: '', calls: [], attempts: attempt,
                 generation: rec.generation, restored: false, status: 'deadline' };
      }
      let ch;
      try {
        ch = await ensureChannel(h);
      } catch (e) {
        return { text: '', calls: [], attempts: attempt, error: String(e.message || e),
                 generation: rec.generation, restored: false, status: 'transport' };
      }
      // I3 首条消息：水位有缺口（存在通道未交付的可见轮）⇒ 重放。
      // ⭐ 2026-10-19 修正：上游限制的是**单条消息长度**（实测 1030 过 / 2030 拒），
      // 不是会话总量。所以重放要**拆成多条短消息依次发送**，而不是压成一条——
      // 实测同会话连发 655/751 字两条，第三问仍能同时记得两段内容。
      const hasGap = rec.transcript.turns.some((t) => t.status === 'ok' && t.seq > rec.deliveredSeq);
      const parts = hasGap ? rec.transcript.buildRestoreParts(text, level) : [text];
      const prompt = parts[parts.length - 1];   // 最后一条是本轮问题
      try {
        // 先发背景段（每条独立短消息），最后一条（问题）走正常的 ask 收答案。
        // 2026-10-19 修 P2-18：**记录背景段是否全部发出**——原先即使失败也照样把
        // deliveredSeq 推到最新，导致管理器以为历史已交付，后续重放会静默漏掉上下文。
        let replayOk = true;
        for (const bg of parts.slice(0, -1)) {
          // 快路径：只发帧不等回答（send 已在 chaoxing 实现；P0-4 的核心修复）
          if (typeof ch.send === 'function') {
            if (!ch.send(bg)) replayOk = false;
            continue;
          }
          try { await ch.ask(bg, { timeout: 30000, idleMs: 8000 }); } catch { replayOk = false; }
        }
        // 墙钟兜底必须罩住挂死的 ask：用 Promise.race，永不返回的通道也能收束。
        // （真上游有 idleMs 看门狗，但 adapter 契约不保证——管理器自己兜底。）
        const r = await Promise.race([
          ch.ask(prompt, askOpts),
          new Promise((_, rej) => {
            const left = deadlineMs - (Date.now() - t0);
            if (left <= 0) { rej(new Error('deadline')); return; }
            rec.deadlineTimer = setTimeout(() => rej(new Error('deadline')), left);
          }),
        ]);
        if (rec.deadlineTimer) { clearTimeout(rec.deadlineTimer); rec.deadlineTimer = null; }
        const txt = (r.text || '').trim();
        // ⭐ 用上游返回的**类型化 status** 决定策略（不再靠「text 是否为空」反推）：
        //   answered → 成功；blocked → 内容层失败（上抛，不重试）
        //   partial / cancelled → **用户点了停止**：直接返回，绝不重试
        //   frozen / transport / empty → 通道废了（G6/G7：冻死会话救不活），换线重试
        //   deadline → 墙钟到点，直接收束
        const st = r.status || (txt ? 'answered' : 'frozen');
        // 取消标记（第二层保险）：cancel() 可能扑空（SSE 先断，桥已收尾），
        // 但标记留着。这里消费它——即使上游正常答完，也按 partial 交回去，
        // 因为**用户已经明确表示不要这一条了**。
        const wasCancelled = !!rec.cancelRequested;
        if (wasCancelled) rec.cancelRequested = false;
        if (st === 'partial' || st === 'cancelled' || wasCancelled) {
          // 用户的意图是「停下来」，不是「重试」。
          // 已收到的正文按 partial 落进转录（可重放），但**不标记 ok**——
          // 半截答案不该在下次提问时被当成完整上下文重放。
          rec.transcript.add(text, txt, 'partial');
          return { text: txt, calls: [], attempts: attempt,
                   generation: rec.generation, restored: hasGap,
                   status: st === 'cancelled' ? 'cancelled' : 'partial', cancelled: true };
        }
        // ⚠️ 2026-10-25：**frozen 但有正文**时不许丢（长任务后期误杀的主要损失点）。
        // 旧行为把已收到的半截正文丢掉去重试，而重试往往又冻结——用户最后拿到
        // 的是碎片。有正文就按 partial 交回：诚实告知「只答了一部分」，
        // 比丢掉重试再拿个空答案好。
        if (st === 'frozen' && txt) {
          rec.transcript.add(text, txt, 'partial');
          return { text: txt, calls: [], attempts: attempt,
                   generation: rec.generation, restored: hasGap,
                   status: 'partial', error: 'frozen_with_text' };
        }
        if (st === 'frozen' || st === 'transport' || st === 'empty') {
          dropChannel(rec);
          attempt += 1;
          if (st === 'empty') {
            // 有终止帧却零正文 = 上游真的答了空。重试一次即可，不要无限换线。
            if (attempt > 1 || Date.now() - t0 > deadlineMs) {
              rec.transcript.add(text, '', 'frozen');
              return { text: '', calls: [], attempts: attempt, error: 'empty',
                       generation: rec.generation, restored: hasGap, status: 'empty' };
            }
          } else if (attempt > reconnectAttempts || Date.now() - t0 > deadlineMs) {
            rec.transcript.add(text, '', 'frozen');
            // 2026-10-22：优先带 adapter 给的**真实原因**（r.error），没有才退回枚举值。
            // 之前恒写 st，于是「桥没起」「密文解不开」「上游拒答」在面板上全显示成
            // 「未知错误」——查连通问题时等于没有诊断信息。
            return { text: '', calls: [], attempts: attempt, error: (r && r.error) || st,
                     generation: rec.generation, restored: hasGap, status: st };
          }
          continue;   // 换线重试
        }
        if (st === 'context_missing') {
          // 模型说「指代不明 / 未提供具体内容」——它没接上前文。
          // 补救：强制把历史重放一遍（当作冷启动），再问一次。只补救一次，避免循环。
          attempt += 1;
          if (attempt > 1) {
            rec.transcript.add(text, '', 'frozen');
            return { text: '', calls: [], attempts: attempt, error: 'context_missing',
                     generation: rec.generation, restored: hasGap, status: 'context_missing' };
          }
          dropChannel(rec);          // ⭐ 水位归零 = 强制下一轮重放
          continue;
        }
        if (st === 'too_long') {
          // 上游拒绝「输入过长」：降一级重放（L0→L1→L2），每次用更短的视图重发。
          // 不能当正常回答返回给用户（那是"输入信息过长"这种系统话）。
          level = Math.min(3, level + 1);
          attempt += 1;
          dropChannel(rec);
          if (attempt > reconnectAttempts + 2 || Date.now() - t0 > deadlineMs) {
            rec.transcript.add(text, '', 'frozen');
            return { text: '(上下文过长，已按新话题继续)', calls: [], attempts: attempt,
                     generation: rec.generation, restored: hasGap, status: 'too_long' };
          }
          continue;
        }
        if (st === 'deadline') {
          rec.transcript.add(text, '', 'frozen');
          return { text: txt, calls: [], attempts: attempt + 1, error: 'deadline',
                   generation: rec.generation, restored: hasGap, status: 'deadline' };
        }
        // I1：记账先于 resolve
        rec.transcript.add(text, txt, st === 'blocked' ? 'blocked' : 'ok');
        // 背景段没全发出去 ⇒ 水位停在原处，下次还会重放（宁可多发，不可漏发）
        if (replayOk) {
          rec.deliveredSeq = rec.transcript.turns.length
            ? rec.transcript.turns[rec.transcript.turns.length - 1].seq
            : 0;
        }
        touch(h);
        return {
          text: txt, calls: r.calls || [], attempts: attempt + 1,
          // ⚠️ 2026-10-25 修（审计 C2）：`sandboxCalls` 此前在这里断了。
          // proto.mjs 产出（`tool_call_chunk` 里模型把 site_* 包进 execute/read_file
          // 时会被收集），toolcycle.mjs 消费，中间这一层没透传 ⇒ 拦截机制
          // 从 2026-10-23 上线起从未生效（唯一产品路径上恒 undefined）。
          sandboxCalls: r.sandboxCalls || [],
          generation: rec.generation, restored: hasGap, terminal: r.terminal,
          status: st === 'blocked' ? 'blocked' : 'ok',
          // 诊断（2026-10-21 回填）：此前只有 Node 侧适配器带 ms，T2 收敛后
          // 这份才是唯一实现 ⇒ 必须在这里。否则面板永远显示「0.0s」，
          // 耗时诊断等于没有（用户实测就是这个症状）。
          ms: Date.now() - t0,
          roundMs: r.ms != null ? r.ms : null,
        };
      } catch (e) {
        // 传输失败（超时/断线/冻死/墙钟抛出）⇒ 换线重试（管理器扛）
        dropChannel(rec);
        attempt += 1;
        // 墙钟到点：不再重试，收束返回（避免 deadline 后又开新连接白跑）
        if (String(e.message) === 'deadline' || Date.now() - t0 > deadlineMs) {
          rec.transcript.add(text, '', 'frozen');
          return { text: '', calls: [], attempts: attempt, error: 'deadline',
                   generation: rec.generation, restored: hasGap, status: 'deadline' };
        }
        if (attempt > reconnectAttempts) {
          rec.transcript.add(text, '', 'frozen');
          return { text: '', calls: [], attempts: attempt, error: String(e.message || e),
                   generation: rec.generation, restored: hasGap, status: 'transport' };
        }
        // 重放被拦（有历史时）⇒ 降级阶梯；裸问题被拦 ⇒ 原样上抛
        if (hasGap && isBlockedText(String(e.message || ''))) level = Math.min(3, level + 1);
        await new Promise((r2) => setTimeout(r2, Math.min(retryBackoffMs * attempt, 60000)));
      }
    }
  };

  return {
    /** 开一个逻辑会话。同步、零网络。返回不透明句柄（对象引用，不是字符串 id）。 */
    open(cfg = {}) {
      if (closed) throw new Error('管理器已关闭');
      const rec = {
        cfg: { planning: !!cfg.planning, modelId: cfg.modelId || 559 },
        transcript: transcriptFactory(cfg.transcript || {}),
        channel: null, deliveredSeq: 0, generation: 0,
        cancelRequested: false, deadlineTimer: null,
      };
      const h = handleOf(rec);
      records.set(h, rec);
      return h;
    },

    /** 问。串行排队；轮换/逐出/断线/重放对调用方不可见（结果字段里可观测）。 */
    ask(h, text, askOpts) {
      if (closed) return Promise.reject(new Error('管理器已关闭'));
      if (!records.has(h)) {
        return Promise.reject(Object.assign(new Error('未知会话（句柄已失效）'), { code: 'SESSION_NOT_FOUND' }));
      }
      const run = chain.then(() => doAsk(h, text, askOpts));
      chain = run.catch(() => {});   // 队列不断链
      return run;
    },

    /** 主动轮换：拆掉热连接（转录保留）。下一次 ask 走冷启动 + 重放。 */
    rotate(h) {
      const rec = records.get(h);
      if (!rec) return false;
      dropChannel(rec);
      const i = hotOrder.indexOf(h);
      if (i >= 0) hotOrder.splice(i, 1);
      return true;
    },

    /**
     * 中止某个会话正在进行的提问（用户点「停止回答」，2026-10-19）。
     *
     * 语义：**只停当前这一问，连接与转录都留着**。
     *   · 不 close 通道 —— 否则下次提问要重新握手，还可能丢上下文
     *   · 已收到的正文作为 `partial` 返回，由上层决定怎么落盘
     *
     * ⚠️ 2026-10-19 实测的两层保险：
     *   ① 通道在 ⇒ 立刻 cancel（最快，上游马上停）
     *   ② 通道不在 / cancel 没命中 ⇒ **在会话上打标记**，doAsk 收尾时看到标记
     *      就把结果改写成 partial。这一层是必要的：SSE 一断，桥那边的 /chat
     *      handler 可能已经收尾，cancel 扑空；标记保证「停止」不会变成假象。
     */
    cancel(h) {
      const rec = records.get(h);
      if (!rec) return { cancelled: false };
      let hit = { cancelled: false };
      if (rec.channel && typeof rec.channel.cancel === 'function') {
        try { hit = rec.channel.cancel() || hit; } catch (e) { hit = { cancelled: false, error: String(e.message || e) }; }
      }
      // 无论通道有没有命中，都留一个标记——下一拍 doAsk 收尾时消费它
      rec.cancelRequested = true;
      return hit;
    },

    /** 上传一张图，返回 fileInfo（视觉通道）。转发到当前热通道的 uploadImage。
     *  管理器只做转交：图的字节从哪来（页面 canvas / 文件）不是它的事。 */
    uploadImage(h, bytes, opts) {
      // 2026-10-19 修 P2-19：原先直接调 ensureChannel，绕过全局串行链（chain），
      // 可能与在飞的 ask 并发改 channel / 触发逐出。现在排队走同一条链。
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

    /** 只读快照：不带参 = 全部会话；带参 = 单会话历史（纯数据，可直接渲染）。 */
    snapshot(h) {
      const one = (rec, handle) => ({
        // ⚠️ 这里唯一的身份是上游 conversationId（可能还是 null）。
        // 本地不补一个「临时 id」——面板要显示「未命名会话」就显示字面量。
        conversationId: handle.conversationId,
        generation: rec.generation, deliveredSeq: rec.deliveredSeq,
        hot: !!rec.channel, config: rec.cfg,
        size: rec.transcript.size,
        turns: rec.transcript.turns.map((t) => ({ seq: t.seq, user: t.user, assistant: t.assistant, status: t.status })),
      });
      if (h != null) {
        const rec = records.get(h);
        return rec ? one(rec, h) : null;
      }
      return [...records.entries()].map(([handle, rec]) => ({
        conversationId: handle.conversationId,
        generation: rec.generation, hot: !!rec.channel,
        turns: rec.transcript.turns.length, chars: rec.transcript.size.chars,
      }));
    },

    /** 全部会话句柄（面板列表用）。 */
    conversations() {
      return [...records.keys()];
    },

    /** 帧级日志累积（仅 ZHEN_TRACE>=3 时有内容）。调用方拿它落盘做回放。 */
    traceFrames(h) {
      const rec = records.get(h);
      if (!rec || !rec.channel || typeof rec.channel.traceFrames !== 'function') return [];
      try { return rec.channel.traceFrames() || []; } catch { return []; }
    },

    /** 当前帧计数（诊断：一次问答收了多少帧）。 */
    frameCount(h) {
      const rec = records.get(h);
      if (!rec || !rec.channel || typeof rec.channel.frameCount !== 'function') return 0;
      try { return rec.channel.frameCount() || 0; } catch { return 0; }
    },

    /** 按**上游 conversationId** 找回会话（恢复会话走这条）。未连上的会话还没有 id，找不到。 */
    find(conversationId) {
      if (!conversationId) return null;
      for (const [handle, rec] of records) {
        try {
          const cid = rec.channel && typeof rec.channel.conversationId === 'function'
            ? rec.channel.conversationId()
            : null;
          if (cid && cid === conversationId) return handle;
        } catch { /* 忽略坏通道 */ }
      }
      return null;
    },

    /** 带参关一个（通道关、转录保留，句柄失效）；不带销毁全部。幂等。 */
    close(h) {
      if (h != null) {
        const rec = records.get(h);
        if (rec) {
          dropChannel(rec);
          const i = hotOrder.indexOf(h);
          if (i >= 0) hotOrder.splice(i, 1);
          records.delete(h);
        }
        return;
      }
      closed = true;
      for (const [, rec] of records) dropChannel(rec);
      records.clear();
      hotOrder.length = 0;
    },
  };
}
