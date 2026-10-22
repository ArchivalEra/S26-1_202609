// context.mjs ——（浏览器移植版，源 .zcode/学习通API/上下文.mjs，逻辑零改动）单会话的上下文记录与压缩（2026-10-18）
//
// 背景（用户定案）：上游 256K 上下文 / 32K 输出，正常对话约 400 轮才顶满，
// **所以不做多会话、不做模型摘要、不做检索**——只做「单会话上下文的记录 + 压缩 + 重放」。
//
// 为什么需要它：上游会话是「活连接 + 内存上下文」，断线/冻死/主动轮换就清零。
// 产品要"连续对话"，就必须能在新会话里接上旧话题——这就是重放。
//
// 设计（采纳外部方案的三条核心）：
//   ① **本地转录是唯一真相源**，上游会话是随时可丢弃的热缓存。
//   ② 压缩只发生在「重放视图」里，**不改写原文**——压缩算法再差也不会不可逆丢信息。
//   ③ 重放必须是**一条打包消息**（逐轮回放 N 轮 = N × 20~100 秒，不可行）。
//
// 保真三条硬规则：
//   · 用户原话不改写（只做首尾截断）
//   · 只在句子/行边界取舍，不做句内改写
//   · 事实台账逐字摘录

const CFG = {
  // 重放预算（字符）。**2026-10-19 实测：上游单条消息约 1000-2000 字之间就拒**
  // （1030 字通过，2030 字返回「输入信息过长，请重新输入」）——
  // 256K 是模型窗口，但 API 层的输入限制远小于此。原值 3500 严重超限，
  // 导致第二次轮换重放被拒、会话假死（M3-1 R5 实测）。
  // 取 1400：留足余量（含问题本身），又足够放下「事实 + 近 2 轮 + 旧轮要点」。
  replayBudget: 1400,
  // **单条消息上限**（2026-10-19 实测：1030 字过、2030 字被拒"输入信息过长"）。
  // 与 replayBudget 的区别：replayBudget 是重放总量，maxPartChars 是每条消息的硬顶。
  // 超过它就拆成多条发——上游按**条**限制，不是按会话总量限制。
  maxPartChars: 900,
  tailTurns: 2,             // 近轮保留原文的轮数
  tailAssistantClip: 1200,  // 近轮助手回答截断
  oldDigest: 240,           // 旧轮助手要点上限
  userClip: [300, 100],     // 用户单条：头 300 + 尾 100
  factsMax: 15,
  factMax: 120,
  // 活会话轮换阈值：256K 下这不是"防溢出"，是"防变慢"。保守设 12 万字符（约 1/2 窗口）。
  liveBudget: 120000,
  liveMaxTurns: 200,
};

// ── 文本工具（全部在块/句边界操作，绝不切半句）───────────────

/** 按句号/问号/感叹号/换行切句，保留分隔符。 */
function splitSentences(text) {
  const out = [];
  let buf = '';
  for (const ch of String(text || '')) {
    buf += ch;
    if ('。！？；\n'.includes(ch)) { if (buf.trim()) out.push(buf.trim()); buf = ''; }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** 按空行 / 代码围栏切块（块是不可分割的取舍单位）。 */
function splitBlocks(text) {
  const t = String(text || '');
  const parts = t.split(/\n{2,}|```/);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** 头尾截断（中间省略），用于用户原话——不改写内容。 */
function clipMiddle(text, head, tail) {
  const s = String(text || '');
  const chars = Array.from(s);   // 按码点切，避免切开 emoji
  if (chars.length <= head + tail + 20) return s;
  return chars.slice(0, head).join('') + '……' + chars.slice(-tail).join('');
}

/** 整块选取直到 cap（放不下就整块丢，绝不切半块）。 */
function fitWholeBlocks(blocks, cap) {
  const out = [];
  let n = 0;
  for (const b of blocks) {
    if (n + b.length > cap) continue;   // 跳过放不下的块，继续试更短的
    out.push(b);
    n += b.length;
    if (n >= cap * 0.9) break;
  }
  return out.join('\n');
}

/** 从助手回答里抽「要点」：首句 + 含关键标记的整块（数字/结论/限定词）。 */
const KEY = /([0-9]+([.][0-9]+)?[ ]*[%a-zA-Zμ°Ω]|=|因此|所以|结论|注意|必须|不能|不要|禁止|仅|只有|默认|前提|除非)/;

function digestAssistant(text, cap) {
  const blocks = splitBlocks(text);
  const picked = [];
  const first = splitSentences(text)[0];
  if (first) picked.push(first);
  for (const b of blocks) if (KEY.test(b)) picked.push(b);
  const uniq = [...new Set(picked)];
  return fitWholeBlocks(uniq, cap);
}

// ── 事实台账：逐字摘录用户原句（第二道保险，不是唯一一道）────────

const FACT = /(不要|别|不能|不可以|禁止|无需|必须|一定要|只能|只用|限制|预算|截止|版本|我们的|我用|我的)/;

function extractFacts(text, seq) {
  return splitSentences(text)
    .filter((s) => s.length <= CFG.factMax && (FACT.test(s) || /[0-9]/.test(s)))
    .map((s) => ({ text: s.trim(), srcSeq: seq, pinned: false, source: 'rule' }));
}

// ── 会话转录 ─────────────────────────────────────────────────

/**
 * 建一个转录器。**只追加**，不改写历史。
 *
 * @param {object} [opts]
 * @param {number} [opts.liveBudget] 活会话累计字符上限（超过则建议轮换）
 * @param {number} [opts.liveMaxTurns] 活会话轮数上限
 */
export function createTranscript(opts = {}) {
  const cfg = { ...CFG, ...opts };
  const turns = [];        // { seq, user, assistant, status, ts, chars }
  const facts = [];
  let seq = 0;
  let liveChars = 0;

  /** 记录一轮。status: 'ok' | 'blocked' | 'frozen' | 'partial' */
  function add(userText, assistantText, status = 'ok') {
    seq += 1;
    // 助手回答先剥掉 <think> 推理块：它是过程噪音，进重放既占预算又可能干扰模型。
    const cleanAssistant = String(assistantText || '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/＜think＞[\s\S]*?＜\/think＞/gi, '')
      .trim();
    const chars = String(userText || '').length + cleanAssistant.length;
    const turn = { seq, user: String(userText || ''), assistant: cleanAssistant, status, ts: Date.now(), chars };
    turns.push(turn);
    liveChars += chars;
    for (const f of extractFacts(userText, seq)) {
      if (facts.length < cfg.factsMax) facts.push(f);
      else {
        const i = facts.findIndex((x) => !x.pinned);
        if (i >= 0) facts[i] = f;   // 淘汰最旧的非 pinned
      }
    }
    return turn;
  }

  /** 该轮换了吗（成本阈值，不是溢出阈值）。 */
  function shouldRotate() {
    const okTurns = turns.filter((t) => t.status === 'ok').length;
    return liveChars > cfg.liveBudget || okTurns >= cfg.liveMaxTurns;
  }

  /** 清空上下文（用户主动）：保留转录，但重放只看此后。 */
  let ctxFloorSeq = 0;
  function clearContext() { ctxFloorSeq = seq; }

  /**
   * 生成重放消息（一条打包消息）。level 0..3 是降级阶梯。
   * @param {string} question 本轮问题
   * @param {number} [level] 0=完整 1=精简 2=最小 3=话题重置
   */
  function buildRestore(question, level = 0) {
    const q = String(question || '').trim();
    if (level >= 3) return q;   // L3：只发问题，调用方负责告知"话题重置"

    // 只有 ok 的轮进重放：blocked 的用户消息很可能就是触发审查的内容；
    // partial/frozen 的回答不完整，重放会误导模型。
    const usable = turns.filter((t) => t.status === 'ok' && t.seq > ctxFloorSeq);
    if (!usable.length) return q;

    const tailN = level === 0 ? cfg.tailTurns : 1;
    const tail = usable.slice(-tailN);
    const old = usable.slice(0, -tailN);

    const factBlock = facts.length
      // 事实台账也要受 ctxFloorSeq 约束：用户点「清空上下文」后，旧事实同样不该重放。
      ? (() => {
        const live = facts.filter((f) => f.srcSeq > ctxFloorSeq);
        return live.length
          ? '■ 已确认的事实与约束\n' + live.map((f, i) => `${i + 1}. ${f.text}`).join('\n')
          : '';
      })()
      : '';

    // 旧轮：用户原话（截首尾）+ 助手要点。level>=1 时丢掉助手要点。
    const oldBlock = old.length
      ? '■ 此前讨论\n' + old.map((t) => {
        const u = clipMiddle(t.user, ...(level >= 2 ? [150, 50] : cfg.userClip));
        if (level >= 1) return `第${t.seq}轮 用户：${u}`;
        const d = digestAssistant(t.assistant, cfg.oldDigest);
        return `第${t.seq}轮 用户：${u}` + (d ? `\n      要点：${d}` : '');
      }).join('\n')
      : '';

    const tailBlock = tail.length
      ? '■ 最近的对话\n' + tail.map((t) =>
        `用户：${clipMiddle(t.user, ...cfg.userClip)}\n助手：${clipMiddle(t.assistant, level === 0 ? cfg.tailAssistantClip : 400, 100)}`
      ).join('\n')
      : '';

    // L2（最小）：只留事实 + 首轮用户消息（话题锚点）+ 上一轮
    let parts;
    if (level >= 2) {
      const anchor = usable[0];
      const prev = usable[usable.length - 1];
      parts = [
        factBlock,
        `■ 话题起点\n用户：${clipMiddle(anchor.user, ...cfg.userClip)}`,
        prev && prev !== anchor ? `■ 上一轮\n用户：${clipMiddle(prev.user, ...cfg.userClip)}` : '',
      ];
    } else {
      parts = [factBlock, oldBlock, tailBlock];
    }

    // 格式避坑：不用 XML 标签（上游工具调用就是 XML，可能被误解析）；
    // 历史里的尖括号转全角，防止标签复活。
    const safe = (s) => s.replace(/</g, '＜').replace(/>/g, '＞');
    const blocks = parts.filter(Boolean).map(safe);

    return {
      blocks,          // 背景分段（每段会被独立发送）
      question: safe(q),
    };
  }

  /**
   * 生成**重放消息序列**（2026-10-19 修正核心设计）。
   *
   * ## 为什么不是一个字符串
   * 实测（1030 字过 / 2030 字拒）证明上游限制的是**单条消息**，不是会话总量。
   * 而实测同会话连发两条 655/751 字的长内容，第三次提问时**两段都还记得**。
   * ⇒ 正确做法是**把历史拆成多条短消息依次发送**，而不是压成一条长消息。
   * 压成一条既会撞单条上限，又白白丢掉上下文。
   *
   * @returns {string[]} 依次发送的消息数组，最后一条是【本轮问题】
   */
  function buildRestoreParts(question, level = 0) {
    const q = String(question || '').trim();
    if (level >= 3) return [q];

    const usable = turns.filter((t) => t.status === 'ok' && t.seq > ctxFloorSeq);
    if (!usable.length) return [q];

    const tailN = level === 0 ? cfg.tailTurns : 1;
    const tail = usable.slice(-tailN);
    const old = usable.slice(0, -tailN);

    const sections = [];
    // ① 事实台账：单独一条
    const liveFacts = facts.filter((f) => f.srcSeq > ctxFloorSeq);
    if (liveFacts.length) {
      sections.push('这是我此前告诉你的、需要记住的约束与事实：\n'
        + liveFacts.map((f, i) => `${i + 1}. ${f.text}`).join('\n'));
    }
    // ② 旧轮：按轮拆条（每轮的「用户+要点」一条）
    //
    // ⚠️ 2026-10-19 修 P0-4：replayBudget 之前**定义了从未读取**。
    // 实测 200 轮 → 203 条 part / 64,088 字，每条都是一次完整模型往返。
    // 现在按**从新到旧**累计，撞到预算就停——越老的轮越先丢（它们对当前问题最不重要）。
    const budget = Math.max(200, Number(cfg.replayBudget) || 1400);
    let used = 0;
    const keptOld = [];
    for (let i = old.length - 1; i >= 0; i--) {
      const t = old[i];
      const u = clipMiddle(t.user, ...(level >= 2 ? [150, 50] : cfg.userClip));
      const d = level >= 1 ? '' : digestAssistant(t.assistant, cfg.oldDigest);
      const piece = `此前第${t.seq}轮，我问过：「${u}」` + (d ? `\n你当时的回答要点：${d}` : '');
      if (used + piece.length > budget) break;
      used += piece.length;
      keptOld.push(piece);
    }
    // 恢复时间顺序（我们是倒着遍历的）
    keptOld.reverse();
    const dropped = old.length - keptOld.length;
    if (dropped > 0) {
      // 丢掉的轮给一行摘要，让模型知道「有更早的对话被省略」而不是以为没有
      sections.push(`（更早的 ${dropped} 轮对话因篇幅省略）`);
    }
    for (const piece of keptOld) sections.push(piece);
    // ③ 近轮：每轮原文一条（比旧轮重要，不受 replayBudget 裁剪）
    for (const t of tail) {
      sections.push(`我们刚才的对话：\n我问：「${clipMiddle(t.user, ...cfg.userClip)}」\n你答：「${clipMiddle(t.assistant, level === 0 ? cfg.tailAssistantClip : 400, 100)}」`);
    }
    // ④ 本轮问题：最后一条，单独发
    sections.push(`以上是我们的对话背景。现在请回答这个新问题（不必复述背景）：\n${q}`);

    // 按单条上限切分：过长的段落自己再拆（在句边界）
    const out = [];
    for (const sec of sections) {
      const safeSec = String(sec).replace(/</g, '＜').replace(/>/g, '＞');
      if (safeSec.length <= cfg.maxPartChars) { out.push(safeSec); continue; }
      // 超长：按句子边界切片
      const sents = splitSentences(safeSec);
      let buf = '';
      for (const snt of sents) {
        if (buf.length + snt.length > cfg.maxPartChars && buf) { out.push(buf); buf = ''; }
        buf += snt;
      }
      if (buf) out.push(buf);
    }
    return out;
  }

  /** 兼容旧接口：把重放序列拼成一条（**仅用于调试/展示**，实际发送请用 buildRestoreParts）。 */
  function buildRestore(question, level = 0) {
    return buildRestoreParts(question, level).join('\n\n');
  }

  return {
    add, shouldRotate, clearContext, buildRestore, buildRestoreParts,
    get turns() { return turns.slice(); },
    get facts() { return facts.slice(); },
    get size() { return { turns: turns.length, chars: liveChars }; },
    config: cfg,
  };
}

export { CFG, splitSentences, splitBlocks, clipMiddle, digestAssistant, extractFacts };
