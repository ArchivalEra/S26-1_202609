// 学习助手协议栈：浏览器版（计划书-油猴脚本-最终架构，实现顺序步骤 3）。
//
// 移植自仓库 .zcode/ 逆向 API 目录的 Node 直连客户端，**协议零改动**（帧格式、WS URL
// 拼装、终止表、自动确认、multipart 上传逐字节保持语义），只换运行环境：
//   · 删光伪装头（计划书 10.2/六：「光明正大」是方案立足点）——同源 iframe 里浏览器
//     自动带真实 UA/来源/Cookie，脚本不伪造任何请求头；
//   · 上游 base / unitId / robotId / cdnBase 全部运行时传入（密文层解锁），
//     模块内零上游明文（静态翻文件搜不到）；
//   · fetch 超时改用 withTimeout（AbortController + setTimeout，finally 清定时器）；
//   · base64 解码改用 atob（b64ToBytes），不再依赖 Node 专有 API。
//
// 协议逆向自站点前端 bundle（运行时 chunk 6026 = 学生侧 WS composable，
// all/5495.js = RadioConfirm/RadioPicker 组件）。完整链路：
//
//   ① GET  /v1/front/chat/visitor/apply   匿名身份（无需登录）→ visitorId + visitorVc + conversationId
//   ② POST /v1/front/chat/initCookie      body = {visitorId, location:""}
//   ③ WS   /v1/ws/chat/<unitId>/visitor   URL 必须带全套参数，缺一个服务端就静默不理
//   ④ 发提问帧  → 服务端跑 SEMANTIC（问题理解/意图识别）→ 知识库召回
//   ⑤ 命中知识库 ⇒ 直接流式回答；未命中 ⇒ 下发 RADIO_CONFIRM 选项框（是/否 + 确认）
//   ⑥ 发确认帧  {communicateType:"LLM_ANSWER_CONFIRM", messageType:"HIDDEN_MESSAGE", option:"1"}
//   ⑦ 大模型流式回答（mobileProperties.type="MACHINE_READ"，content JSON 的
//      responseText/content 累积，flag="stop" 结束）
//
// 模型（2026-10-16 定案）：**559 豆包为主力**（全模态、最新），**254 DeepSeek-R1 为回退**，223 汇雅是课程默认小模型
// （取自 /v1/front/llm/getModelSettingInfo 的 switchModelList；走确认路径时
//   帧里加 chatModel:"ASSIGN_MODEL" + modelId）
//
// 用法（库，跑在上游域的同源 iframe 里）：
//   import { createAssistant } from './proto.mjs';
//   const a = createAssistant({ base, unitId, robotId });   // 三要素由密文层运行时给
//   await a.connect();
//   const r = await a.ask('什么是卡诺图');          // 自动走「确认」拿大模型回答
//   console.log(r.text);

const qs = (o) => Object.entries(o)
  .filter(([, v]) => v !== undefined && v !== null)
  .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
  .join('&');

/** fetch 超时小工具：AbortController + setTimeout（AbortSignal.timeout 的兼容替身，
 *  旧浏览器没有后者）。语义等价：到点 abort 整个 fetch（含读 body），拒绝原因是 AbortError。
 *  ⚠️ 用完必须在 finally 里 clear()——定时器不许漏（P1-7 教训）。 */
function withTimeout(ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, clear: () => clearTimeout(timer) };
}

/** base64 / dataUrl → Uint8Array（浏览器 atob 路径，替代 Node 侧的 base64 字节解码）。
 *  坏输入（空串/非法字符）返回 null（不抛），与上层 dataUrlBytes 的口径一致。
 *  边界差异（可接受）：裸尾字符如 `a`，宽松解码器会静默丢弃，atob 会抛——
 *  我们走 catch 返回 null，语义同为「拿不到字节」，视觉链路对 null 上报格式问题。 */
export function b64ToBytes(b64) {
  const s = String(b64 || '');
  const payload = /^data:/i.test(s) ? (s.split(',')[1] || '') : s;
  if (!payload) return null;
  try {
    const bin = atob(payload);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null; }
}

/**
 * 解析上游回复里的工具调用（**唯一实现**——此前 18 份拷贝写反过 3 次方向）。
 * 上游输出的尖括号一律 HTML 转义（&lt;invoke&gt;），先反转义再抠。
 * @param {string} rawText 模型回复原文
 * @returns {Array<{name:string, args:object}>} 可直接执行的工具调用
 */
export function parseToolCalls(rawText, knownTools) {
  const text = String(rawText || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const out = [];
  const invRe = /<invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/invoke>/g;
  let m;
  while ((m = invRe.exec(text)) !== null) {
    const args = {};
    const pRe = /<parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/parameter>/g;
    let p;
    while ((p = pRe.exec(m[2])) !== null) args[p[1]] = p[2].trim();
    out.push({ name: m[1], args });
  }
  if (out.length) return out;

  // ── 退化形态（2026-10-19 实测）：上游某些时段不输出 XML，只回一行
  //    「site_open_section铁芯损耗」「调用site_read读取选3章节」这种「工具名+参数」的
  //    裸文本。这不是正常调用格式，但把工具名认出来至少能：
  //    ① 在日志里看到模型想干什么；② 需要时按 knownTools 白名单执行。
  //    只认**传入的 knownTools**（不猜），且要求整段很短（长正文里偶然出现工具名不算调用）。
  //    误判防护：① 整段必须很短（≤80 字，正常回答不会这么短还提工具名）；
  //              ② 工具名可以带短前缀（模型常写「检索登记site_search，query=…」）。
  //              ③ 支持 `key=value, key=value` 形态（2026-10-19 话术改版后的主力格式）。
  // 2026-10-22（Node 桥实测）：退化形态的实际输出常把标记包在代码围栏里——
  //   「…所在页面：\n\n```\nsite_search，query=工程数学作业2\n```」
  // 围栏只是排版。这里先剥围栏再解析（剥完内容不变，长度变短）。
  //
  // 2026-10-23（长任务实测 run9）：**围栏内的调用自带强信号**——模型长篇解释
  // 自己的思路（127 字引导语）再用围栏给出正式调用。此时前缀长度上限反而成了
  // 拦路的：先提取「围栏内的行」作为优先候选（围栏内的调用不受前缀限制），
  // 围栏内没有才退回全文退化解析。
  const fenceBlocks = [];
  const fenceRe = /```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)```/g;
  let fm;
  while ((fm = fenceRe.exec(text)) !== null) {
    const inner = fm[1].trim();
    if (inner && inner.length <= 200) fenceBlocks.push(inner);
  }
  // ① 围栏优先：围栏里是一行调用（短、无前缀噪音）——直接按退化解析走，
  //    不受前缀/整段长度限制（围栏本身就是「这是可执行代码」的排版声明）。
  for (const block of fenceBlocks) {
    if (!knownTools || !Array.isArray(knownTools) || !knownTools.length) break;
    // 词边界：围栏里是「site_search_utils(...)」这种代码引用时不该命中
    // （2026-10-23 防护实测：示例代码块里的 import site_search_utils 被误判）。
    if (!knownTools.some((n) => new RegExp('(^|[^\\w])' + n + '([^\\w]|$)').test(block))) continue;
    const inner = parseToolCalls(block, knownTools);   // 围栏内无围栏，走退化分支
    if (inner.length) return inner.map((c) => ({ ...c, degraded: true }));
  }
  const deFenced = text
    .replace(/^\s*```[a-zA-Z0-9_-]*\s*$/gm, '')
    .replace(/```/g, '')
    .trim();
  const t = deFenced || text.trim();
  if (Array.isArray(knownTools) && knownTools.length && t.length <= 160) {
    for (const name of knownTools) {
      // ⚠️ 2026-10-23 修（防护实测）：indexOf 会命中「别的标识符的一部分」——
      // 正文里 `import site_search_utils` 的 site_search 不是我们的工具。
      // 工具名后面必须是 参数语法（，,）或行尾/空白/围栏边界，不能是 [_a-zA-Z0-9]。
      let at = -1;
      {
        const re = new RegExp('(^|[^\\w])' + name + '([^\\w]|$)');
        const m = re.exec(t);
        if (m) at = m.index + m[1].length;
      }
      if (at < 0) continue;
      // 前缀必须是**纯引导语**。
      // 2026-10-19 实测：模型会写「浙江水利水电学院电路原理习题册电机学课堂笔记检索site_search，…」，
      // 前缀 32 字全是铺垫。按「前缀里有没有参数语法」判断比按长度更准。
      //
      // ⚠️ 2026-10-22 修（Node 桥实测三轮，每轮都被真实输出打脸）：
      //   ① 换行只是排版，不算参数语法。
      //   ② 中文冒号「：」和中文逗号「，」是**句子标点**——实测输出
      //      「先查全站目录，定位…所在页面：」正好两者都有 ⇒ 整条调用被丢弃。
      //   ③ **判据收窄到只看英文等号 `=`**：参数语法的唯一可靠标志是 `key=value`。
      //      唯一的漏网是「引导语里写了 foo=bar」——但那本来就是模型在解释参数，
      //      不是纯引导语，拒掉是对的（下面的误判防护用例守着这条）。
      //   ④ 前缀上限 40 → 60（带一句完整引导语很容易到 50 字）。
      //   ⑤ 整段上限 80 → 160（含引导语 + 代码围栏）。
      // ⭐ 2026-10-23（长任务 run10）：调用**独立成行**时前缀上限放宽到 120。
      // 模型的思考叙述长度天然波动（实测 63 字被 60 上限拒掉），而
      // 「换行 + 工具名行首」本身已是强排版信号（与围栏同源）。
      // 只有调用挤在正文中间（同行）才维持 60 字的紧限制。
      const onOwnLine = /(^|\n)\s*$/.test(t.slice(0, at).slice(-Math.min(at + 1, 200)) ? t.slice(0, at) : '');
      const lineStart = at === 0 || t.slice(0, at).endsWith('\n');
      const prefixLimit = lineStart ? 120 : 60;
      const prefix = t.slice(0, at).replace(/[\r\n]+/g, ' ');
      if (prefix.trim().length > prefixLimit || prefix.includes('=')) continue;
      // ⚠️ 2026-10-23 修（防护实测）：区分「调用」与「陈述里的工具名」——
      //   调用形态 A：「site_search，query=…」（分隔符，/）——主力格式
      //   调用形态 B：「site_search铁芯损耗」（直接连写非拉丁参数，2026-10-19
      //     实测上游真实输出过，词边界 [^\w] 正好覆盖中文）
      //   陈述形态：「site_search 来搜索内容哦」（空格后拉丁/动词）——拒。
      // 判据：紧跟的第一字符属于「，,/中文等非\w」或紧贴 name；若先遇到空白，
      // 除非空白后就是「，/,」，否则视为陈述句。
      const after = t.slice(at + name.length);
      const lead = after.match(/^\s*([^\s])/);
      const isCallForm = !after.startsWith(' ') && !after.startsWith('\n')
        ? true                                    // B：直接连写（铁芯损耗形态）
        : /^\s*[，,]/.test(after);                // A：空白后紧跟分隔符
      if (!isCallForm) continue;
      const rest = t.slice(at + name.length)
        .replace(/^[\s:：,，、的]+/, '')
        .replace(/[。.]\s*$/, '')
        .trim();
      // ⚠️ 2026-10-23 修（lab 闸门红）：rest 也必须短。真实调用的参数是关键词
      // （「工程数学作业2」「卡诺图」），不会是几十字的整段。这条守的是
      // 「长正文里偶然提到工具名」——前缀短 + 正文长 ⇒ 第一处命中就把
      // 后面整段吞成 _positional。rest > 60 字 = 不是调用，跳过。
      if (rest.length > 60) continue;
      const args = {};
      if (rest) {
        // `query=电机学 课堂笔记, scope=site` → {query:'电机学 课堂笔记', scope:'site'}
        const kv = /([a-zA-Z_][\w]*)\s*=\s*([^,，;；]+)/g;
        let mm;
        while ((mm = kv.exec(rest)) !== null) args[mm[1]] = mm[2].trim();
        if (!Object.keys(args).length) args._positional = rest;
      }
      out.push({ name, args, degraded: true });
      break;   // 一行只当一次调用
    }
  }
  return out;
}

/** 回复是否命中**内容审查**拦截（真违规）。
 *  ⚠️ 2026-10-19 区分：`不能继续处理` 这个词太重，模型在「指代不明」时也会用，
 *  把它一律当内容拦截会误伤（实测 M1-s6-r5）。这里只认真正的违规措辞。
 *
 *  ⚠️ 2026-10-21 补（用户实测：提示词被误判成越狱，白重试一轮 62 秒）：
 *  上游安全层拒答时会说「属于典型的越狱尝试 / 违背安全原则 / 试图诱导模型」，
 *  这些是**确定性**的安全拦截措辞，不含「指代不明」那种歧义，可以安全收进来。
 *  仍然**不**收裸的「不能继续处理」——上面那条误伤结论依然成立。
 */
export function isBlockedText(t) {
  return /违规|不符合内容规范|越狱|安全原则|诱导模型|绕过安全|无法协助/.test(String(t || ''));
}

/** 回复是「指代不明 / 上下文缺失」类拒绝（**可补救**：重放历史再问一次）。 */
export function isContextMissingText(t) {
  // 2026-10-19 修 P2-17：原来的裸「上下文」会误判正常回答（「根据上下文…」），
  // 导致强制重放 + 重试。收紧为**拒绝句式**才认。
  return /指代不明|未提供具体|没有提供具体|不清楚你指|不知道你指|请说明你指|你说的.{0,6}是指/.test(String(t || ''));
}

/** 上游是否明确拒绝「输入过长」（2026-10-19 实测：单条约 1000-2000 字即拒）。
 *  它不是内容拦截，也不是冻死——是**可降级重试**的信号（换更短的重放）。 */
export function isTooLongText(t) {
  // 2026-10-19 修 P2-17：裸「请重新输入」太泛，会误判正常提示。
  return /输入信息过长/.test(String(t || ''));
}

/**
 * 上游帧的**终止判据表**（2026-10-18 架构收敛：唯一真相源）。
 *
 * 为什么是一张表：终止判定此前散落在四份代码里（直连客户端的 if 链、识图、出题、
 * 管理器的「空 text 即冻死」），且互相矛盾——MIX 的 `finish` 在直连客户端被漏掉、
 * 识图/出题根本没有 MIX 分支。漏一行的代价是「每次问答都干等到 idle 超时」，
 * 长答案（总结类）因此被系统性误判成冻死。
 *
 * 键是 `下划线拼接的帧特征`，值统一为终止类型。**加一种上游帧形态 = 加一行 + 一条回放测试。**
 *
 * @param {object} j 已解析的帧对象
 * @returns {string|null} 终止类型；null = 非终止帧
 */
export function terminalKind(j) {
  if (!j || typeof j !== 'object') return null;
  const mp = j.mobileProperties || {};
  const type = String(mp.type || '');
  const sub = String(mp.subType || '');
  const top = String(j.type || '');

  // 助手模式（isLLMPlanning=1）：MIX 家族
  //   实测序列：chat_start → tool_call_thought → tool_call_chunk → tool_call_result
  //             → message_chunk → finish
  if (type === 'MIX') {
    if (sub === 'finish') return 'mix_finish';
    if (sub === 'chat_end') return 'mix_chat_end';
    if (mp.isStop) return 'mix_stop';
    return null;
  }
  // 大模型流式（普通模式）
  if (type === 'MACHINE_READ') {
    try {
      const c = JSON.parse(mp.content || '{}');
      if (c.flag === 'stop') return 'machine_flag_stop';
    } catch { /* 非 JSON 内容 */ }
    return null;
  }
  // 拦截帧（带 content 的 MACHINE_STOP）
  if (type === 'MACHINE_STOP' && mp.content) return 'machine_stop';
  // 顶层语义流程结束
  if (top === 'FINAL_FINISH') return 'final_finish';
  // 纯文本回答结束
  if (j.sseStop) return 'sse_stop';
  // 确认框（不是终止，是交互）
  return null;
}

/**
 * 从一帧里抽出**正文增量**（0..n 段字符串）。纯函数，喂假帧可直接测。
 *
 * 已知的三类载体：
 *   · MIX  → mobileProperties.subType==='message_chunk' 的 content
 *   · MACHINE_READ → mobileProperties.content JSON 里的 content/responseText
 *   · 顶层/msg.answer → 纯文本（含 `{"index":…,"responseText":…}` 这种 JSON 包装，
 *     2026-10-18 实证：拦截文案就藏在这个包装里，整条丢弃会把它误判成 EMPTY）
 */
export function extractChunks(j) {
  if (!j || typeof j !== 'object') return [];
  const mp = j.mobileProperties || {};
  const out = [];
  const pushAnswer = (a) => {
    const s = String(a == null ? '' : a);
    if (!s) return;
    let body = s;
    if (/^\{"index"/.test(s)) {
      // JSON 包装：正文/拦截文案在 responseText 里
      try {
        const c = JSON.parse(s);
        body = c.responseText ? String(c.responseText) : '';
      } catch { /* 坏 JSON 忽略 */ }
      if (!body) return;
    }
    // 占位语不是正文：JSON 包装里的「正在生成中」与裸文本「我还在学习中」都算。
    if (/正在生成中/.test(body) || /我还在学习中/.test(body)) return;
    out.push(body);
  };

  if (mp.type === 'MIX') {
    if (mp.subType === 'message_chunk' && mp.content) out.push(String(mp.content));
    return out;
  }
  if (mp.type === 'MACHINE_READ' && mp.content) {
    try {
      const c = JSON.parse(mp.content);
      const chunk = c.content || c.responseText || '';
      if (chunk) out.push(String(chunk));
    } catch { /* 单帧坏 */ }
    return out;
  }
  if (j.msg && j.msg.answer != null) pushAnswer(j.msg.answer);
  if (j.answer != null) pushAnswer(j.answer);
  return out;
}

/**
 * 建一个直连会话（浏览器版：跑在上游域的同源 iframe 里，UA/来源/Cookie/Origin
 * 全由浏览器真实携带，本模块不伪造任何请求头）。
 *
 * ⚠️ 上游三要素零默认值（计划书 2.2：解密产物只进内存，源码/静态文件无上游明文）——
 * 少一个直接抛错，不猜、不硬编码。
 *
 * @param {object} opts
 * @param {string} opts.base       上游站点根（运行时由密文层给）
 * @param {string} opts.unitId     课程 unitId（运行时由密文层给）
 * @param {string} opts.robotId    课程机器人 id（运行时由密文层给）
 * @param {string} [opts.cdnBase]  图片 CDN 根（uploadImage 拼 star4 最终 URL 用；缺它时 uploadImage 报错）
 * @param {number} [opts.modelId]  模型 id（223/254/559），省略用课程默认
 * @param {boolean} [opts.autoConfirm] 命中选项框时是否自动确认（默认 true ⇒ 走大模型）
 * @param {function} [opts.log]    日志回调，默认静默
 */
export function createAssistant(opts = {}) {
  if (!opts.base) throw new Error('createAssistant 需要 base（上游站点根，运行时由密文层给）');
  if (!opts.unitId) throw new Error('createAssistant 需要 unitId（课程 id，运行时由密文层给）');
  if (!opts.robotId) throw new Error('createAssistant 需要 robotId（课程机器人 id，运行时由密文层给）');
  const base = String(opts.base);
  const unitId = String(opts.unitId);
  const robotId = String(opts.robotId);
  const cdnBase = opts.cdnBase ? String(opts.cdnBase) : null;
  const modelId = opts.modelId ? Number(opts.modelId) : null;
  const autoConfirm = opts.autoConfirm !== false;
  // 助手模式（2026-10-18 抓帧实证）：开关是 visitor/apply 与 WS URL 上的 isLLMPlanning。
  //   0 = 普通模式（知识库直答 / MACHINE_READ 流式）
  //   1 = 助手模式（agent 规划，正文走 MIX 帧；平台自带 43 个工具在此模式可用）
  // ⚠️ 页面上切模型会把模式重置回普通——顺序必须是「先助手模式 → 再切模型 → 再开联网」。
  const planning = opts.planning ? 1 : 0;
  // 2026-10-19 流式：每段正文增量回调（可选）。handleFrame 早已在调 pending.onChunk，
  // 但 pending 从未赋值过它——死代码。这里把外部回调存起来，ask() 时挂上去。
  const externalOnChunk = typeof opts.onChunk === 'function' ? opts.onChunk : null;
  const log = opts.log || (() => {});
  const onFrame = opts.onFrame || null;
  const referer = `${base}/prime/web?unitId=${unitId}&robotId=${robotId}`;

  let ws = null;
  let keepalive = null;
  let identity = null;
  let activeModelId = modelId;
  // 每题一个 pending：累积流式正文、记录是否已确认、resolve 时机
  let pending = null;

  async function jfetch(path, { method = 'GET', body, timeoutMs = 30000 } = {}) {
    // 2026-10-19 修 P1-11：裸 fetch 无超时 ⇒ 半开 TCP 可挂几分钟。
    // 浏览器化：AbortSignal.timeout → withTimeout（finally 清定时器）。
    //
    // ⚠️ 2026-10-22 修「Node 桥必挂」：这里原来只带 Accept/Content-Type，注释说
    // 「UA/来源由同源浏览器自动带，不伪造」——那句话在**浏览器里**成立（同源 iframe
    // 的 fetch 自动带 Referer），但在 **Node 里不成立**：Node 的 fetch 不加 Referer，
    // 上游直接回 `{"msg":"请求异常","code":"-1"}`（实测：无 Referer 必挂、带 Referer
    // 立刻成功）。所以这里显式带 Referer（值就是本连接对应的页面地址，不是伪造的
    // 第三方来源）。浏览器里显式设置 Referer 会被禁止，因此只在能设的环境里加。
    const to = withTimeout(timeoutMs);
    try {
      const headers = {
        Accept: 'application/json, text/plain, */*',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      };
      // 浏览器禁止脚本设置 Referer（会被静默忽略，不会报错），所以这段对浏览器无副作用。
      try { headers.Referer = referer; } catch { /* 只读头 */ }
      const res = await fetch(path.startsWith('http') ? path : base + path, {
        method,
        signal: to.signal,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 非 JSON */ }
      return { status: res.status, json, text };
    } finally {
      to.clear();   // body 读完/抛错都要清（P1-7 教训）
    }
  }

  async function apply() {
    const r = await jfetch(`/v1/front/chat/visitor/apply?${qs({
      unitId, robotId, channel: 'WEB', scene: '',
      referUrl: encodeURIComponent(referer), isLLMPlanning: planning,
    })}`);
    if (!r.json || !r.json.visitorId) throw new Error('visitor/apply 失败: ' + r.text.slice(0, 200));
    identity = {
      visitorId: r.json.visitorId,
      visitorVc: r.json.visitorVc,
      conversationId: (r.json.cvsInfo || {}).conversationId,
    };
    await jfetch('/v1/front/chat/initCookie', {
      method: 'POST',
      body: { visitorId: identity.visitorId, location: '' },
    });
    log('[identity]', identity.visitorId, identity.conversationId);
    return identity;
  }

  /** 拉可用模型（含 modelId 与是否多模态）。 */
  async function models() {
    if (!identity) await apply();
    const r = await jfetch(`/v1/front/llm/getModelSettingInfo?${qs({
      unitId, robotId, visitorId: identity.visitorId, conversationId: identity.conversationId,
    })}`);
    return ((r.json || {}).data || {}).switchModelList || [];
  }

  /**
   * 切换本会话的大模型。
   * ⚠️ 模型切换**不是**发帧字段——往 `msg` 里塞 `chatModel:"ASSIGN_MODEL"` 会被服务端
   * 以 WS 1002 直接断连。正确做法是这条 REST：
   *   POST /v1/front/chat/saveConversationModel
   *   body = {unitId, visitorId, conversationId, modelInfo:{modelId, modelName, ifOpenStageThinkProcess}}
   * （前端 `fnChangeModelApplied` 走的就是它；`defaultModelId` 不变、`frontSelectModel` 变即生效。）
   * @param {number} targetModelId 223 汇雅 / 254 DeepSeek-R1满血版 / 559 豆包
   */
  async function switchModel(targetModelId) {
    if (!identity) await apply();
    const list = await models();
    const info = list.find((m) => Number(m.modelId) === Number(targetModelId));
    if (!info) throw new Error(`模型 ${targetModelId} 不在可用列表：${list.map((m) => m.modelId).join('/')}`);
    const r = await jfetch('/v1/front/chat/saveConversationModel', {
      method: 'POST',
      body: {
        unitId,
        visitorId: identity.visitorId,
        conversationId: identity.conversationId,
        modelInfo: {
          modelId: Number(targetModelId),
          modelName: info.modelName,
          ifOpenStageThinkProcess: info.ifOpenStageThinkProcess || 0,
        },
      },
    });
    if (!r.json || r.json.statusCode !== 0) throw new Error('切换模型失败: ' + r.text.slice(0, 200));
    activeModelId = Number(targetModelId);
    log('[已切模型]', info.modelName, `(${targetModelId})`);
    return info;
  }

  function frame(msgPatch, topPatch = {}) {
    const t = Date.now();
    return {
      msgTimeId: t, time: t, direction: 'IN', messageType: 'TEXT',
      communicateType: 'DATA', lang: 'zh-CN',
      msg: { channel: 'WEB', question: '', visibleQuestion: '', questionType: 'TEXT', ...msgPatch },
      robot: { type: '', scene: -1, extend: '', subject: '', spage: 1 },
      ...topPatch,
    };
  }

  /**
   * 上传一张图片，返回可直接塞进提问帧 fileInfo 的条目（2026-10-18 从取证脚本库化）。
   *
   * 三个坑（都在取证脚本踩穿）：
   *   ① `uploadType=IMAGE`——传 `UPLOAD_FILE` 会被拒；
   *   ② FormData 必须自补 unitId/robotId/conversationId，光有 query 参数不够；
   *   ③ 帧里 filePath 用 star4 的**最终** URL（`<cdnBase>/star4/<objectId>/origin.png`），
   *      不是上传返回的原路径。
   *
   * 浏览器化：伪装头（UA/来源/手拼 Cookie/前端版本头）全删——initCookie 落的真实
   * cookie 同源自动携带；star4 的 CDN 根由 cdnBase 传入（模块内零上游明文）。
   *
   * @param {Uint8Array} bytes 图片字节（dataUrl 先过 b64ToBytes）
   * @param {object} [opts]
   * @param {string} [opts.filename] 默认 shot.png（**只收 png/jpg**，JXL 存档格式不能直接传）
   * @param {string} [opts.mime] 默认按扩展名推断
   * @returns {Promise<{objectId:string, taskFileId:string, name:string, size:number,
   *   ext:string, hidden:boolean, filePath:string}>}
   */
  async function uploadImage(bytes, opts = {}) {
    if (!cdnBase) throw new Error('uploadImage 需要 cdnBase（图片 CDN 根，运行时由密文层给）');
    if (!identity) await apply();
    const name = opts.filename || 'shot.png';
    const ext = (name.split('.').pop() || 'png').toLowerCase();
    const mime = opts.mime || (ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png');
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type: mime }), name);
    fd.append('unitId', unitId);
    fd.append('robotId', robotId);
    fd.append('conversationId', identity.conversationId);
    const url = `${base}/v1/front/chat/upload/multipart?${qs({
      conversationId: identity.conversationId, uploadType: 'IMAGE', unitId,
    })}`;
    // 上传大图给 60s（2026-10-19 修 P1-11）
    const to = withTimeout(60000);
    let text;
    try {
      const res = await fetch(url, { method: 'POST', signal: to.signal, body: fd });
      text = await res.text();
    } finally {
      to.clear();
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    const first = json && Array.isArray(json.datas) ? json.datas[0] : null;
    if (!first || !first.objectId) throw new Error('图片上传失败: ' + text.slice(0, 200));
    const objectId = first.objectId;
    log('[图片已上传]', objectId, `${Math.round(bytes.length / 1024)}KB`);
    return {
      objectId, taskFileId: objectId, name, size: bytes.length, ext, hidden: false,
      filePath: `${cdnBase}/star4/${objectId}/origin.${ext === 'jpg' ? 'png' : ext}`,
    };
  }

  /**
   * 带图片提问（视觉）。帧形态与纯文本相同，只多 `msg.fileInfo` 数组——
   * `questionType` 仍是 TEXT（改别的值服务端不认图）。
   *
   * @param {string} question 问题
   * @param {Array} fileInfo uploadImage 的返回值（可多张）
   * @param {object} [askOpts] 同 ask()
   */
  function askImage(question, fileInfo, askOpts = {}) {
    if (!ws || ws.readyState !== 1) throw new Error('未连接，先 await connect()');
    const infos = Array.isArray(fileInfo) ? fileInfo : [fileInfo];
    return ask(question, { ...askOpts, fileInfo: infos });
  }

  /**
   * **只发帧，不等待回答**（2026-10-19 修 P0-4 的快路径）。
   *
   * 为什么需要它：会话管理器重放历史时，背景段只是「让上游吸收上下文」，
   * 它们的回答会被丢弃。走 ask() 每条都要等一次完整往返（实测 200 轮 →
   * 203 次往返，约 7 分钟到 1.7 小时）。send() 只把帧推出去，立刻返回。
   *
   * 代价与边界：上游仍会为这条消息生成回答，但没人收——后续 ask 的正文里
   * 不会混入它们（pending 是独立对象，且我们不注册）。如果上游因为并发帧
   * 而错乱，调用方应退回 ask()。
   *
   * @returns {boolean} 帧是否发出
   */
  function send(question) {
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(frame({ question, visibleQuestion: question })));
      log('[→]', question, '（不等待回答）');
      return true;
    } catch (e) {
      log('[send 失败]', e.message);
      return false;
    }
  }

  function handleFrame(raw) {
    let j;
    try { j = JSON.parse(String(raw)); } catch { return; }
    if (onFrame) { try { onFrame(j); } catch { /* 日志回调不许影响主流程 */ } }
    if (!pending) return;

    const mp = j.mobileProperties || {};
    // ① 进展判定：只认**正文类**帧。逐字推送的思考帧（tool_call_thought/sub_agent_thought）
    //    和 KEEPALIVE 都会把看门狗喂饱——实测助手模式因此空转过 414 秒。
    const chunks = extractChunks(j);
    if (chunks.length) {
      pending.frames += 1;
      pending.lastFrameAt = Date.now();
    }

    // ② 选项框：知识库答不了 → 问要不要转大模型（交互帧，不是终止）
    if (mp.type === 'RADIO_CONFIRM' && mp.option === 'LLM_ANSWER_CONFIRM') {
      log('[选项框]', String(j.msg && j.msg.answer || ''));
      if (autoConfirm && !pending.confirmed) {
        pending.confirmed = true;
        const f = frame({});
        f.communicateType = 'LLM_ANSWER_CONFIRM';
        f.messageType = 'HIDDEN_MESSAGE';
        f.option = pending.confirmOption;
        ws.send(JSON.stringify(f));
        log('[已确认] option=' + pending.confirmOption);
      }
      return;
    }

    // ③ 正文累积
    for (const c of chunks) {
      pending.text += c;
      pending.onChunk && pending.onChunk(c);
    }

    // ③b 沙箱工具调用收集（2026-10-23）：tool_call_chunk 的 content 是多个
    //     JSON 对象连写（帧结构.md §三），按平衡括号切开，args_chunk 按
    //     tool_call_id 累积。只收集，不执行——finish 时透出给 toolcycle 拦截。
    if (mp.subType === 'tool_call_chunk' && mp.content && pending) {
      const c = String(mp.content);
      let depth = 0, start = null;
      for (let k = 0; k < c.length; k++) {
        const ch = c[k];
        if (ch === '{') { if (depth === 0) start = k; depth++; }
        else if (ch === '}') {
          depth--;
          if (depth === 0 && start !== null) {
            try {
              const o = JSON.parse(c.slice(start, k + 1));
              const tid = o.tool_call_id || o.toolCallId;
              if (tid) {
                if (!pending.sandbox[tid]) pending.sandbox[tid] = { name: o.name || '', args: '' };
                if (o.args_chunk) pending.sandbox[tid].args += o.args_chunk;
              }
            } catch { /* 半截 JSON 等下一帧 */ }
            start = null;
          }
        }
      }
    }

    // ④ 终止判定：**只看表格**（terminalKind 是唯一真相源）
    const terminal = terminalKind(j);
    if (terminal) {
      pending.terminal = terminal;
      pending.resolve(pending.finish());
    }
  }

  async function connect() {
    if (!identity) await apply();
    const url = `wss://${new URL(base).host}/v1/ws/chat/${unitId}/visitor?${qs({
      userId: identity.visitorId, channel: 'WEB', conversationId: identity.conversationId,
      robotId, visitorVc: identity.visitorVc, scene: '', lang: 'zh-CN', isLLMPlanning: planning,
    })}`;
    log('[WS]', url);
    return new Promise((resolve, reject) => {
      // 浏览器 WS 构造器第二参是子协议（不是选项对象）——同源 iframe 里
      // Origin/来源由浏览器自动带，单参直连即可，不伪造任何头。
      ws = new WebSocket(url);
      ws.addEventListener('message', (ev) => handleFrame(String(ev.data)));
      ws.addEventListener('open', () => {
        keepalive = setInterval(() => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'KEEPALIVE' }));
        }, 30000);
        resolve();
      });
      // ⚠️ 握手挂起兜底（2026-10-18 线上死锁根因）：DNS/TCP 半开时 open 和 error 都不触发，
      // 没有这层 connect 的 Promise 永不 settle，上层全链路跟着挂死（实测卡 2 小时+）。
      const handshake = setTimeout(() => {
        if (ws.readyState !== 1) {
          try { ws.terminate ? ws.terminate() : ws.close(); } catch { /* ignore */ }
          reject(new Error('WS 握手超时（30s）'));
        }
      }, 30000);
      ws.addEventListener('open', () => clearTimeout(handshake));
      // ⚠️ 连接被服务端/网络关闭：必须收束在飞的 pending，否则 ask 悬死到 timeout。
      ws.addEventListener('close', () => {
        clearTimeout(handshake);
        if (pending) {
          const p = pending;
          try { p.resolve(p.finish('transport')); } catch { /* ignore */ }
        }
      });
      ws.addEventListener('error', (ev) => { clearTimeout(handshake); reject(new Error('WS 错误: ' + (ev.message || ev.type))); });
    });
  }

  /**
   * 问一个问题，等完整回答（自动处理「转大模型」确认）。
   * @returns {Promise<{text:string, confirmed:boolean, modelId:number|null}>}
   */
  function ask(question, { modelId: perQuestionModel, confirmOption = '1', timeout = 120000, idleMs = 20000, fileInfo = null, onChunk: perAskOnChunk = null } = {}) {
    if (!ws || ws.readyState !== 1) throw new Error('未连接，先 await connect()');
    const mid = perQuestionModel ? Number(perQuestionModel) : activeModelId;
    return new Promise((resolve, reject) => {
      // ⚠️ 2026-10-19 修：墙钟定时器与空闲定时器**必须是两个变量**。
      //
      // 旧实现把墙钟 timer 存在 `pending.timer` 上，随后又要用这个字段装空闲
      // interval，于是 `pending.timer && clearTimeout(pending.timer)` 把**墙钟自己**
      // 清掉了——`timeout` 从此永不生效。实测后果：一问在工具调用后挂 384 秒，
      // 靠上层管理器 360s 的 deadline 才收束，面板上是六分钟一片空白。
      const deadlineTimer = setTimeout(() => {
        if (pending) resolve(pending.finish('deadline'));
      }, timeout);
      pending = {
        text: '', confirmed: false, confirmOption, deadlineTimer,
        frames: 0, lastFrameAt: Date.now(), idleMs, idleTimer: null,
        // 流式回调：单次 ask 的 askOpts.onChunk 优先，其次构造时的 onChunk
        onChunk: (typeof perAskOnChunk === 'function' ? perAskOnChunk : externalOnChunk),
        terminal: null,     // 终止类型（terminalKind 的返回值）
        // ⭐ 2026-10-23（长任务实测发现）：模型会把 site_* 行包进它自己的沙箱工具
        //   （execute("echo \"site_read，what=outline\"") 或 read_file）——意图全在，
        //   只是通道选错。tool_call_chunk 按 tool_call_id 拼接收集于此，
        //   finish 时以 sandboxCalls 透出，由 toolcycle 拦截转成我们的调用。
        sandbox: {},        // tool_call_id → { name, args }
        finish(reason) {
          clearTimeout(deadlineTimer);
          if (pending.idleTimer) clearInterval(pending.idleTimer);
          const txt = pending.text.trim();
          // ⭐ 类型化的轮次结果（2026-10-18 架构收敛）：
          // 上层不再靠「text 是否为空」反推协议状态。
          //   answered  —— 有正文
          //   blocked   —— 命中拦截文案
          //   partial   —— 用户点了停止，已收到一部分正文
          //   cancelled —— 用户点了停止，还没收到正文
          //   empty     —— 上游明确终止但没正文（真空回答）
          //   frozen    —— 无终止帧、被 idle 看门狗收束
          //   deadline  —— 撞总墙钟
          //   transport —— 连接层异常/被关闭
          //
          // 停止要单独成 status：若混进 frozen，管理器会把它当「通道冻死」
          // 而**关闭连接并重试**——用户点了停止，反而触发重连重问。
          const status = reason === 'cancelled' ? (txt ? 'partial' : 'cancelled')
            : reason === 'deadline' ? 'deadline'
            : reason === 'transport' ? 'transport'
            : isTooLongText(txt) ? 'too_long'
            : isBlockedText(txt) ? 'blocked'
            : isContextMissingText(txt) ? 'context_missing'
            : txt ? 'answered'
            : pending.terminal ? 'empty'      // 有终止帧却零正文 = 真空回答
            : 'frozen';                       // 无终止帧 = 冻死
          const out = {
            text: txt, confirmed: pending.confirmed, modelId: mid,
            frames: pending.frames, status, terminal: pending.terminal,
            ms: Date.now() - startedAt,
            // 沙箱调用（2026-10-23）：模型用它的 execute/read_file 包 site_* 行时，
            // 从这里透出 {name, args} 列表给 toolcycle 拦截。仅 toolcycle 消费。
            sandboxCalls: Object.values(pending.sandbox),
          };
          pending = null;
          return out;
        },
        resolve: (v) => resolve(v),
      };
      const startedAt = Date.now();
      // 注意：**不要**往 msg 里塞 chatModel/modelId（会 1002 断连）；
      // 模型由 switchModel() 走 REST 切换，此处只发纯提问帧。
      // 带图：questionType 仍是 TEXT，额外挂 fileInfo 数组（改别的值服务端不认图）。
      const patch = { question, visibleQuestion: question };
      if (fileInfo && fileInfo.length) patch.fileInfo = fileInfo;
      const f = frame(patch);
      log('[→]', question, fileInfo && fileInfo.length ? `（+${fileInfo.length} 图）` : '');
      ws.send(JSON.stringify(f));
      // 空闲看门狗：服务端偶发推两三帧就冻住（§0.47 的时序坑），
      // 与其干等满 timeout，不如 idleMs 无新帧就收工，好让上层重试。
      const idle = setInterval(() => {
        if (!pending) { clearInterval(idle); return; }
        if (Date.now() - pending.lastFrameAt > pending.idleMs) {
          resolve(pending.finish('frozen'));
        }
      }, 1000);
      pending.idleTimer = idle;
    });
  }

  function close() {
    clearInterval(keepalive);
    try { ws && ws.close(); } catch { /* ignore */ }
  }

  /**
   * 中止当前这一问（用户点「停止回答」，2026-10-19）。
   *
   * 与 close() 的区别：**只收束在飞的 pending，连接留着**。
   * close() 会拆掉整个 WS 会话，下一次提问得重新握手（几秒 + 可能丢上下文）。
   * 用户只是想「别再往下写了」，不是想退出。
   *
   * 返回被中止时已经收到的正文——上层拿它当「部分回答」落进面板，
   * 不要让用户觉得白问了一场。
   */
  function cancel() {
    if (!pending) return { cancelled: false };
    const p = pending;
    // ⚠️ 必须走 resolve，不能只 finish()：
    // finish() 只清定时器并返回结果对象，**不会 settle `ask()` 的 Promise**。
    // 旧写法让 ask 一直挂着等 timeout —— 管理器那边的 Promise.race 也得
    // 等到 deadline 才收束，用户按了停止却要等几分钟。
    const out = p.finish('cancelled');
    try { p.resolve(out); } catch (e) { /* 已 settle */ }
    return { cancelled: true, text: out.text || '', frames: out.frames || 0 };
  }

  /** 问一个问题并自动重试「冻死」的情况（§0.47 时序坑）。 */
  async function askRetry(question, askOpts = {}, tries = 3) {
    let last = null;
    for (let i = 1; i <= tries; i++) {
      last = await ask(question, askOpts);
      if (last.text) return last;
      (opts.onRetry || log)(`[冻死重试 ${i}/${tries}] 只收到 ${last.frames} 帧、无正文，重问`);
    }
    return last;
  }

  /**
   * 带策略的重试提问（G 系列结论的代码化）——调用方不再自己管会话生灭。
   *
   * 策略（policy，纯数据）：
   *   maxSessionRetries  被拦/冻死时换全新会话重试的次数上限（默认 2，G21：新会话必须重切模型）
   *   idleMs             空闲止损（默认 12000，G14：冻死会话 22s 才收，12s 判死足够）
   *   timeout            单次 ask 上限（默认 60000）
   *   fallbackPrompt     全部会话重试失败后改用此提示词再试一轮（caveman 降级用）
   *   retryDelayMs       每次换会话重试前的退避（默认 0 = 立即；K1000 实测拦截有时段性，
   *                      立刻重试常撞同一窗口，退避 10-20s 能显著提高复活率）
   *   onRetry            每次重试的日志回调
   *
   * 返回 { text, calls, attempts, gaveUp }：calls 已用 parseToolCalls 解析好。
   * 会话的创建/关闭/重切模型全部封在这里——调用方绝不接触第二个 assistant 引用
   * （对话层曾因 a/a2 双引用 close 错对象，交互模式第二问踩僵尸 WS）。
   */
  async function askWithRetry(prompt, policy = {}) {
    const maxSessionRetries = policy.maxSessionRetries != null ? policy.maxSessionRetries : 2;
    const fallbackPrompt = policy.fallbackPrompt || null;
    const retryDelayMs = policy.retryDelayMs != null ? policy.retryDelayMs : 0;
    const onRetry = policy.onRetry || (() => {});
    const askOpts = { timeout: policy.timeout != null ? policy.timeout : 60000,
                      idleMs: policy.idleMs != null ? policy.idleMs : 12000 };
    // 图片帧（视觉）：随每次 ask 透传，重试的新会话也带得上（uploadImage 的产物跨会话有效）
    if (policy.fileInfo && policy.fileInfo.length) askOpts.fileInfo = policy.fileInfo;

    const tryOnce = async (p) => {
      const r = await ask(p, askOpts);
      const calls = parseToolCalls(r.text);
      // 沙箱调用透传（2026-10-23）：tryOnce 的合并口径也带上
      return { r, calls, sandboxCalls: r.sandboxCalls || [], dead: !calls.length && (isBlockedText(r.text) || !r.text) };
    };

    let attempts = 0;
    let first = await tryOnce(prompt);
    attempts++;
    if (!first.dead) {
      return { text: first.r.text, calls: first.calls, sandboxCalls: first.sandboxCalls, attempts, gaveUp: false };
    }
    onRetry({ attempt: attempts, reason: isBlockedText(first.r.text) ? '拦截' : '空', text: first.r.text });

    // 阶段一：换全新会话重试（每次都重切模型——新会话默认回退 huiya）。
    // ⚠️ identity 必须清空：connect() 复用旧 visitorId 的话，重连进的还是
    // 刚被冻死的那个会话（G6/G7：冻死会话救不活），等于没换。
    for (let i = 0; i < maxSessionRetries; i++) {
      // 退避：拦截有时段性（K1000 实测），立刻重试常撞同一窗口。
      // 递增退避（第 i 次等 (i+1)×delay）——越往后越该等久一点。
      if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs * (i + 1)));
      close();
      ws = null; pending = null; identity = null;
      await connect();
      if (activeModelId) await switchModel(activeModelId);
      attempts++;
      const t = await tryOnce(prompt);
      if (!t.dead) return { text: t.r.text, calls: t.calls, attempts, gaveUp: false };
      onRetry({ attempt: attempts, reason: isBlockedText(t.r.text) ? '拦截' : '空', text: t.r.text });
    }

    // 阶段二：caveman 降级提示词（同一会话最后一搏）
    if (fallbackPrompt) {
      attempts++;
      const t = await tryOnce(fallbackPrompt);
      if (!t.dead) return { text: t.r.text, calls: t.calls, attempts, gaveUp: false };
      onRetry({ attempt: attempts, reason: '降级后仍无产出', text: t.r.text });
    }
    return { text: first.r.text, calls: [], attempts, gaveUp: true };
  }

  return { apply, models, switchModel, connect, ask, askRetry, askWithRetry, uploadImage, askImage, send, close, cancel,
    get identity() { return identity; },
    get activeModelId() { return activeModelId; },
    get planning() { return planning; } };
}
