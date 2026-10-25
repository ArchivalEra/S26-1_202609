// session.mjs ——（浏览器移植版，源 .zcode/学习通API/会话.mjs，逻辑零改动）
// 多会话管理器（2026-10-18 定稿，杂交方案落地）
//
// 设计来源：三路并行设计对比后的杂交（A 骨架 + B 机制 + C 测试资产）。
//
// ## 接口（A 的极小骨架 + snapshot）
//   createManager(opts) → { open, ask, close, snapshot }
//   · open(cfg) → sessionId           同步、懒连接（开 50 个会话零成本）
//   · ask(id, text, opts) → result    唯一触碰连接生命周期的入口
//   · close(id?)                       带参关一个，不带销毁全部；幂等
//   · snapshot(id?) → 纯数据           会话列表/单会话历史（面板渲染用）
//
// ## 采纳 B 的两个机制
//   ① 重放水位 deliveredSeq：通道记录它亲自交付到第几轮；
//      转录里存在「seq > deliveredSeq 的可见轮」⇒ 首条消息带 buildRestore 重放。
//      比粗判定「连接在/不在」更准——通道活着但上下文不完整的边界也能覆盖。
//   ② 生灭权唯一：adapter 只暴露 connect/ask/close 三方法，**不用 askWithRetry**
//      （它内部自建/自杀会话，会和管理器抢生灭权，转录水位对不上）。
//      重试策略全部上移到管理器。
//
// ## 采纳 C 的测试资产（在同目录 session.test.mjs）
//   · scriptedAdapter：按剧本出牌（text/blocked/freeze/failConnect），零网络
//   · spyAdapter：断言「全局串行」「open/close 严格配对」两条不变量
//
// ## 热槽 2 个（不是 1）：双会话比较是真实场景，乒乓成本不该由用户付。
//   LRU 逐出；在飞会话即 MRU，不可能被逐出。
//
// ## 不变量
//   I1 转录唯一真相源：ask resolve 前必已 transcript.add；连接随时可杀不丢轮。
//   I2 全局串行：同一时刻至多一个请求在飞（FIFO，跨会话）。
//   I3 冷启动三段式：connect → switchModel(记录的 modelId) → 首条消息
//      （有水位缺口 ⇒ buildRestore 打包，否则裸问题——buildRestore 无历史时自己退化）。
//   I4 sessionId 永不改义：轮换/逐出/断线都不影响调用方句柄。
//   I5 传输失败管理器扛（换线重放 ≤ reconnectAttempts）；内容失败（BLOCKED/gaveUp）
//      原样 resolve 上抛，话术策略留调用方。
//
// ## 浏览器移植差异（仅此三处，逻辑零改动）
//   · import 从 ./chaoxing.mjs 改为 ./proto.mjs（协议栈模块）；
//   · chaoxingAdapter 需要上游地址：base/unitId/robotId 从最外层传入（不硬编码）；
//   · 其余（重放水位 deliveredSeq、LRU 热槽、cancel 两层保险、deadline 等）原样。

import { createAssistant, isBlockedText, isTooLongText, isContextMissingText } from './proto.mjs';
import { createTranscript } from './context.mjs';

/** 真实 adapter（默认）：唯一 import createAssistant 的地方。生灭权在管理器，这里只有三个动作。
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
        // 适配器契约从两方法扩到三方法——图片是产品能力（看图/截图），不是实验专属。
        uploadImage: (bytes, opts) => a.uploadImage(bytes, opts),
        // 中止在飞提问（2026-10-19 用户要求「停止回答」）：
        // **必须在这里显式转发**，否则管理器那侧的 `typeof channel.cancel`
        // 判定为假、静默跳过——实测症状就是面板按了停止，桥回 cancelled:false，
        // 上游继续生成 26 秒后照常交答案。
        cancel: () => a.cancel(),
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

  const sessions = new Map();   // id → { cfg, transcript, channel?, deliveredSeq, lastUsed, generation }
  const hotOrder = [];          // LRU 序（MRU 在尾）
  let nextId = 1;
  let closed = false;
  let chain = Promise.resolve();   // 全局串行队列（I2）

  const touch = (id) => {
    const i = hotOrder.indexOf(id);
    if (i >= 0) hotOrder.splice(i, 1);
    hotOrder.push(id);
  };

  /** 逐出最久未用的热连接（在飞的即 MRU，不会被逐）。通道没了 = 水位归零。 */
  const evictIfNeeded = () => {
    while (hotOrder.length > hotSlots) {
      const victim = hotOrder.shift();
      const s = sessions.get(victim);
      if (s && s.channel) {
        try { s.channel.close(); } catch { /* ignore */ }
        s.channel = null;
        s.deliveredSeq = 0;   // ⚠️ 通道消失 = 它交付的历史全丢（上游内存清零）
      }
    }
  };

  /** 冷启动：open 带超时兜底（connect 握手挂起既不 open 也不 error 时，没有这层就死锁）。
   *  超时值取 openTimeoutMs（默认 45s）——与 chaoxing 内部的 30s 握手超时形成两级保险，
   *  外层略大，让内层先报更精确的原因。 */
  const ensureChannel = async (id) => {
    const s = sessions.get(id);
    if (s.channel) return s.channel;
    s.generation += 1;
    // 2026-10-19 修 P1-7：超时定时器**必须在 open 胜出时清掉**。
    // 旧实现每个冷启动都留一个活着的 45s timer（测试套件耗时 45.5s 就是证据），
    // 长跑进程里会累积并吊住事件循环。
    let openTimer = null;
    try {
      s.channel = await Promise.race([
        adapter.open(s.cfg),
        new Promise((_, rej) => { openTimer = setTimeout(() => rej(new Error('connect 超时')), openTimeoutMs); }),
      ]);
    } finally {
      if (openTimer) { clearTimeout(openTimer); openTimer = null; }
    }
    s.deliveredSeq = 0;   // 新通道什么都还没交付
    touch(id);
    evictIfNeeded();
    return s.channel;
  };

  const doAsk = async (id, text, askOpts = {}) => {
    const s = sessions.get(id);
    if (!s) throw Object.assign(new Error(`未知会话 ${id}`), { code: 'SESSION_NOT_FOUND' });
    const t0 = Date.now();

    // 惰性轮换：成本阈值命中 ⇒ 先变冷（复用同一条冷启动路径）
    if (s.channel && s.transcript.shouldRotate()) {
      try { s.channel.close(); } catch { /* ignore */ }
      s.channel = null;
    }

    let attempt = 0;
    let level = 0;   // 重放降级阶梯
    for (;;) {
      if (Date.now() - t0 > deadlineMs) {
        return { text: '', calls: [], attempts: attempt,
                 generation: s.generation, restored: false, status: 'deadline' };
      }
      let channel;
      try {
        channel = await ensureChannel(id);
      } catch (e) {
        return { text: '', calls: [], attempts: attempt, error: String(e.message || e),
                 generation: s.generation, restored: false, status: 'transport' };
      }
      // I3 首条消息：水位有缺口（存在通道未交付的可见轮）⇒ 重放。
      // ⭐ 2026-10-19 修正：上游限制的是**单条消息长度**（实测 1030 过 / 2030 拒），
      // 不是会话总量。所以重放要**拆成多条短消息依次发送**，而不是压成一条——
      // 实测同会话连发 655/751 字两条，第三问仍能同时记得两段内容。
      const hasGap = s.transcript.turns.some((t) => t.status === 'ok' && t.seq > s.deliveredSeq);
      const parts = hasGap ? s.transcript.buildRestoreParts(text, level) : [text];
      const prompt = parts[parts.length - 1];   // 最后一条是本轮问题
      try {
        // 先发背景段（每条独立短消息），最后一条（问题）走正常的 ask 收答案。
        // 2026-10-19 修 P2-18：**记录背景段是否全部发出**——原先即使失败也照样把
        // deliveredSeq 推到最新，导致管理器以为历史已交付，后续重放会静默漏掉上下文。
        let replayOk = true;
        for (const bg of parts.slice(0, -1)) {
          // 快路径：只发帧不等回答（send 已在 chaoxing 实现；P0-4 的核心修复）
          if (typeof channel.send === 'function') {
            if (!channel.send(bg)) replayOk = false;
            continue;
          }
          try { await channel.ask(bg, { timeout: 30000, idleMs: 8000 }); } catch { replayOk = false; }
        }
        // 墙钟兜底必须罩住挂死的 ask：用 Promise.race，永不返回的通道也能收束。
        // （真上游有 idleMs 看门狗，但 adapter 契约不保证——管理器自己兜底。）
        const r = await Promise.race([
          channel.ask(prompt, askOpts),
          new Promise((_, rej) => {
            const left = deadlineMs - (Date.now() - t0);
            if (left <= 0) { rej(new Error('deadline')); return; }
            s.deadlineTimer = setTimeout(() => rej(new Error('deadline')), left);
          }),
        ]);
        if (s.deadlineTimer) { clearTimeout(s.deadlineTimer); s.deadlineTimer = null; }
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
        const wasCancelled = !!s.cancelRequested;
        if (wasCancelled) { s.cancelRequested = false; s.cancelAt = 0; }
        if (st === 'partial' || st === 'cancelled' || wasCancelled) {
          // 用户的意图是「停下来」，不是「重试」。
          // 已收到的正文按 partial 落进转录（可重放），但**不标记 ok**——
          // 半截答案不该在下次提问时被当成完整上下文重放。
          s.transcript.add(text, txt, 'partial');
          return { text: txt, calls: [], attempts: attempt,
                   generation: s.generation, restored: hasGap,
                   status: st === 'cancelled' ? 'cancelled' : 'partial', cancelled: true };
        }
        // ⚠️ 2026-10-25：**frozen 但有正文**时不许丢（长任务后期误杀的主要损失点）。
        // 旧行为把已收到的半截正文丢掉去重试，而重试往往又冻结——用户最后拿到
        // 的是碎片。有正文就按 partial 交回：诚实告知「只答了一部分」，
        // 比丢掉重试再拿个空答案好。
        if (st === 'frozen' && txt) {
          s.transcript.add(text, txt, 'partial');
          return { text: txt, calls: [], attempts: attempt,
                   generation: s.generation, restored: hasGap,
                   status: 'partial', error: 'frozen_with_text' };
        }
        if (st === 'frozen' || st === 'transport' || st === 'empty') {
          try { channel.close(); } catch { /* ignore */ }
          s.channel = null;
          attempt += 1;
          if (st === 'empty') {
            // 有终止帧却零正文 = 上游真的答了空。重试一次即可，不要无限换线。
            if (attempt > 1 || Date.now() - t0 > deadlineMs) {
              s.transcript.add(text, '', 'frozen');
              return { text: '', calls: [], attempts: attempt, error: 'empty',
                       generation: s.generation, restored: hasGap, status: 'empty' };
            }
          } else if (attempt > reconnectAttempts || Date.now() - t0 > deadlineMs) {
            s.transcript.add(text, '', 'frozen');
            // 2026-10-22：优先带 adapter 给的**真实原因**（r.error），没有才退回枚举值。
            // 之前恒写 st，于是「桥没起」「密文解不开」「上游拒答」在面板上全显示成
            // 「未知错误」——查连通问题时等于没有诊断信息。
            return { text: '', calls: [], attempts: attempt, error: (r && r.error) || st,
                     generation: s.generation, restored: hasGap, status: st };
          }
          continue;   // 换线重试
        }
        if (st === 'context_missing') {
          // 模型说「指代不明 / 未提供具体内容」——它没接上前文。
          // 补救：强制把历史重放一遍（当作冷启动），再问一次。只补救一次，避免循环。
          attempt += 1;
          if (attempt > 1) {
            s.transcript.add(text, '', 'frozen');
            return { text: '', calls: [], attempts: attempt, error: 'context_missing',
                     generation: s.generation, restored: hasGap, status: 'context_missing' };
          }
          try { channel.close(); } catch { /* ignore */ }
          s.channel = null;
          s.deliveredSeq = 0;          // ⭐ 水位归零 = 强制下一轮重放
          continue;
        }
        if (st === 'too_long') {
          // 上游拒绝「输入过长」：降一级重放（L0→L1→L2），每次用更短的视图重发。
          // 不能当正常回答返回给用户（那是"输入信息过长"这种系统话）。
          level = Math.min(3, level + 1);
          attempt += 1;
          try { channel.close(); } catch { /* ignore */ }
          s.channel = null;
          if (attempt > reconnectAttempts + 2 || Date.now() - t0 > deadlineMs) {
            s.transcript.add(text, '', 'frozen');
            return { text: '(上下文过长，已按新话题继续)', calls: [], attempts: attempt,
                     generation: s.generation, restored: hasGap, status: 'too_long' };
          }
          continue;
        }
        if (st === 'deadline') {
          s.transcript.add(text, '', 'frozen');
          return { text: txt, calls: [], attempts: attempt + 1, error: 'deadline',
                   generation: s.generation, restored: hasGap, status: 'deadline' };
        }
        // I1：记账先于 resolve
        s.transcript.add(text, txt, st === 'blocked' ? 'blocked' : 'ok');
        // 背景段没全发出去 ⇒ 水位停在原处，下次还会重放（宁可多发，不可漏发）
        if (replayOk) {
          s.deliveredSeq = s.transcript.turns.length
            ? s.transcript.turns[s.transcript.turns.length - 1].seq
            : 0;
        }
        touch(id);
        return {
          text: txt, calls: r.calls || [], attempts: attempt + 1,
          // ⚠️ 2026-10-25 修（审计 C2）：`sandboxCalls` 此前在这里断了。
          // proto.mjs 产出（`tool_call_chunk` 里模型把 site_* 包进 execute/read_file
          // 时会被收集），toolcycle.mjs:485 消费，中间这一层没透传 ⇒ 拦截机制
          // 从 2026-10-23 上线起从未生效（唯一产品路径上恒 undefined）。
          sandboxCalls: r.sandboxCalls || [],
          generation: s.generation, restored: hasGap, terminal: r.terminal,
          status: st === 'blocked' ? 'blocked' : 'ok',
          // 诊断（2026-10-21 回填）：此前只有 Node 侧适配器带 ms，T2 收敛后
          // 这份才是唯一实现 ⇒ 必须在这里。否则面板永远显示「0.0s」，
          // 耗时诊断等于没有（用户实测就是这个症状）。
          ms: Date.now() - t0,
          roundMs: r.ms != null ? r.ms : null,
        };
      } catch (e) {
        // 传输失败（超时/断线/冻死/墙钟抛出）⇒ 换线重试（管理器扛）
        if (s.deadlineTimer) { clearTimeout(s.deadlineTimer); s.deadlineTimer = null; }
        try { channel.close(); } catch { /* ignore */ }
        s.channel = null;
        attempt += 1;
        // 墙钟到点：不再重试，收束返回（避免 deadline 后又开新连接白跑）
        if (String(e.message) === 'deadline' || Date.now() - t0 > deadlineMs) {
          s.transcript.add(text, '', 'frozen');
          return { text: '', calls: [], attempts: attempt, error: 'deadline',
                   generation: s.generation, restored: hasGap, status: 'deadline' };
        }
        if (attempt > reconnectAttempts) {
          s.transcript.add(text, '', 'frozen');
          return { text: '', calls: [], attempts: attempt, error: String(e.message || e),
                   generation: s.generation, restored: hasGap, status: 'transport' };
        }
        // 重放被拦（有历史时）⇒ 降级阶梯；裸问题被拦 ⇒ 原样上抛
        if (hasGap && isBlockedText(String(e.message || ''))) level = Math.min(3, level + 1);
        await new Promise((r2) => setTimeout(r2, Math.min(retryBackoffMs * attempt, 60000)));
      }
    }
  };

  return {
    /** 开一个逻辑会话。同步、零网络。 */
    open(cfg = {}) {
      if (closed) throw new Error('管理器已关闭');
      const id = `s${nextId++}`;
      sessions.set(id, {
        cfg: { planning: !!cfg.planning, modelId: cfg.modelId || 559 },
        transcript: transcriptFactory(cfg.transcript || {}),
        channel: null, deliveredSeq: 0, lastUsed: Date.now(), generation: 0,
      });
      return id;
    },

    /** 问。串行排队；轮换/逐出/断线/重放对调用方不可见（结果字段里可观测）。 */
    ask(id, text, askOpts) {
      if (closed) return Promise.reject(new Error('管理器已关闭'));
      if (!sessions.has(id)) {
        return Promise.reject(Object.assign(new Error(`未知会话 ${id}`), { code: 'SESSION_NOT_FOUND' }));
      }
      const run = chain.then(() => doAsk(id, text, askOpts));
      chain = run.catch(() => {});   // 队列不断链
      return run;
    },

    /** 主动轮换：拆掉热连接（转录保留）。下一次 ask 走冷启动 + 重放。
     *  设计里的「最便宜的第五入口」——实验的 rotateBefore、面板的「重开连接」都靠它。 */
    rotate(id) {
      const s = sessions.get(id);
      if (!s) return false;
      if (s.channel) { try { s.channel.close(); } catch { /* ignore */ } }
      s.channel = null;
      s.deliveredSeq = 0;   // 通道没了 = 水位归零（同逐出）
      const i = hotOrder.indexOf(id);
      if (i >= 0) hotOrder.splice(i, 1);
      return true;
    },

    /**
     * 中止某个会话正在进行的提问（用户点「停止回答」，2026-10-19）。
     *
     * 语义：**只停当前这一问，连接与转录都留着**。
     *   · 不 close 通道 —— 否则下次提问要重新握手，还可能丢上下文
     *   · 已收到的正文作为 `partial` 返回，由上层决定怎么落盘
     *   · 队列里的后续 ask 不受影响（它们还没开始）
     *
     * ⚠️ 2026-10-19 实测的两层保险：
     *   ① 通道在 ⇒ 立刻 cancel（最快，上游马上停）
     *   ② 通道不在 / cancel 没命中 ⇒ **在会话上打标记**，doAsk 收尾时看到标记
     *      就把结果改写成 partial。这一层是必要的：SSE 一断，桥那边的 /chat
     *      handler 可能已经收尾，cancel 扑空；标记保证「停止」不会变成假象。
     *
     * 返回 `{cancelled:boolean, text?:string}`；没有在飞的提问时 cancelled=false。
     */
    cancel(id) {
      const s = sessions.get(id);
      if (!s) return { cancelled: false };
      let hit = { cancelled: false };
      if (s.channel && typeof s.channel.cancel === 'function') {
        try { hit = s.channel.cancel() || hit; } catch (e) { hit = { cancelled: false, error: String(e.message || e) }; }
      }
      // 无论通道有没有命中，都留一个标记——下一拍 doAsk 收尾时消费它
      s.cancelRequested = true;
      s.cancelAt = Date.now();
      return hit;
    },

    /** 上传一张图，返回 fileInfo（视觉通道）。转发到当前热通道的 uploadImage。
     *  管理器只做转交：图的字节从哪来（页面 canvas / 文件）不是它的事。 */
    uploadImage(id, bytes, opts) {
      // 2026-10-19 修 P2-19：原先直接调 ensureChannel，绕过全局串行链（chain），
      // 可能与在飞的 ask 并发改 s.channel / 触发逐出。现在排队走同一条链。
      if (closed) return Promise.reject(new Error('管理器已关闭'));
      const s = sessions.get(id);
      if (!s) return Promise.reject(new Error(`未知会话 ${id}`));
      const run = chain.then(async () => {
        if (!sessions.has(id)) throw new Error(`未知会话 ${id}（已关闭）`);
        const ch = await ensureChannel(id);
        if (!ch || typeof ch.uploadImage !== 'function') {
          throw new Error('当前通道不支持图片上传（adapter 未实现 uploadImage）');
        }
        return ch.uploadImage(bytes, opts);
      });
      chain = run.catch(() => {});
      return run;
    },

    /** 只读快照：不带参 = 会话列表；带参 = 单会话历史（纯数据，面板可直接渲染）。 */
    snapshot(id) {
      if (id != null) {
        const s = sessions.get(id);
        if (!s) return null;
        return {
          id, generation: s.generation, deliveredSeq: s.deliveredSeq,
          hot: !!s.channel, config: s.cfg,
          size: s.transcript.size,
          turns: s.transcript.turns.map((t) => ({ seq: t.seq, user: t.user, assistant: t.assistant, status: t.status })),
        };
      }
      return [...sessions.entries()].map(([sid, s]) => ({
        id: sid, generation: s.generation, hot: !!s.channel,
        turns: s.transcript.turns.length, chars: s.transcript.size.chars,
      }));
    },

    /** 带参关一个（通道关、transcript 保留，句柄失效）；不带销毁全部。幂等。 */
    close(id) {
      if (id != null) {
        const s = sessions.get(id);
        if (s) {
          if (s.channel) { try { s.channel.close(); } catch { /* ignore */ } }
          const i = hotOrder.indexOf(id);
          if (i >= 0) hotOrder.splice(i, 1);
          sessions.delete(id);
        }
        return;
      }
      closed = true;
      for (const [, s] of sessions) {
        if (s.channel) { try { s.channel.close(); } catch { /* ignore */ } }
      }
      sessions.clear();
      hotOrder.length = 0;
    },
  };
}
