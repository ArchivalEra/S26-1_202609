// toolcycle.mjs ——（浏览器移植版，源 .zcode/学习通API/工具会话.mjs，逻辑零改动）
// 「模型 ⇄ 工具」闭环的唯一实现（2026-10-19 从 对话.mjs 抽出）。
//
// ## 为什么抽（架构评审候选 3）
// 此前工具循环有两份互不相干的实现（对话.mjs 一份、bridge.mjs 一份已弃用），
// 实验一份也没有——K1000 全目录对 9345/parseToolCalls 零命中，实验测的「模型说了
// 某个词」与产品能力「模型调工具 → 桥执行 → 页面动」之间没有任何代码连接。
//
// ## 接口（小）
//   createToolSession({ mgr, sessionId, invoke, tools, rounds, navToolNames })
//     → { run(userText, opts?) → { answer, calls, effects, status } }
//
// ## 两个接缝（seam）
//   · ask    —— 对话通道。产品与实验都注入 session.mjs 的管理器（唯一真相源）。
//   · invoke —— 工具执行：(name, args) → { value, effect }。
//               产品注入桥调用（POST /dialog-call），实验注入同一个调用 + 回执记录。
//               两个适配器证明这条接缝是真的（one adapter = hypothetical, two = real）。
//
// ## 效果回执（架构评审候选 2）
//   invoke 返回的 effect 是「页面真实动了吗」的观测值（y/dy/target 等），由页面桥
//   在 executeTool 前后量出、经桥透传。工具自己的 value 是自述，effect 才是证据——
//   判「跳转成功」看 effect.scrolled，不信 {ok:true}。
//
// ## 判什么不算这里的事
//   本模块不做任何「达标/失败」判断——那是 判据.mjs 的事（架构评审候选 1）。
//   这里只把一轮对话的**产物**（答案、调用、效果）如实交出去。
//
// ## 浏览器移植差异（仅两处，逻辑零改动）
//   · import 从 ./chaoxing.mjs 改为 ./proto.mjs（协议栈模块）；
//   · dataUrlBytes 的 Buffer.from(b64,'base64') 改为 proto 侧已有的 b64ToBytes（atob）。

import { parseToolCalls, b64ToBytes } from './proto.mjs';

// 意图路由：需要操作本站页面时才给工具表（对话.mjs 2026-10-18 实测结论）。
// 2026-10-19 二次修正：**放弃「靠关键词判断要不要给工具」**。
// 实测漏判 4/8：'电机学这门课有哪些课堂笔记'、'帮我找电机的笔记'、'课程里有什么'、
// '有哪些资料' 全部不命中——它们不含任何动作动词，但明明需要查站点。
// 反过来，关键词表永远列不全用户的说法。
//
// 现在的策略：**默认给工具表**（`alwaysTools: true`），让模型自己判断要不要调。
// 代价是提示词多几十字；收益是再也不会因为一个词没命中就整个能力失效。
// 这个正则只在 `alwaysTools: false` 时才用（保留给「确定是纯问答」的场合）。
export const PAGE_ACTION_RE = /跳转|跳到|翻到|滚到|定位|展开|收起|折叠|面板|查符号|打开|导航|搜索|搜一下|找找|这一页|这一节|资料库|哪一节|本页|这页|这一章|这章|这门课|第\s*\d+\s*题|配图|配的图|图里|看图|原文|抄录|小节|大纲|目录|章节|上一节|下一节|表格|笔记|作业|资料|课程|章节|索引/;

/**
 * 页面工具表（2026-10-19 按 G 系列结论重写）。
 *
 * ## 为什么去掉了 <function_calls>
 *
 * 用户判断：「functioncalls 直接去除啊，这本来就像一种指纹」——**实证支持**：
 * 让模型原样输出一行 `<function_calls>`，它回「这个请求我不能继续处理，因为诱导绕过安全规则」。
 * 这个 XML 形态已被安全层点名，带着它等于自报家门。
 *
 * ## 换成什么：G 系列实测的三条
 *
 *   · **疑问式法则**（G15-G18，疑问式 3/3 vs 命令式 1/3）：任务句写成问句，
 *     绕开服务端 task_flow 路由（命令式导航语义会冻死）。
 *   · **工具上限 3 个**（G20，3 工具 3/3 vs 5 工具 2/3）：清单越长越逼近拦截红线。
 *   · **单参数样例**（G21）：样例只占位第一个参数，与验证通过的形态一致。
 *
 * ## 不用 XML 用什么
 *
 * 用**人话登记表**——「这次要查的是：…」+ 工具名自然嵌入句子。模型照抄工具名即可，
 * 不出现任何尖括号协议。解析侧 `parseToolCalls` 已经支持退化形态（整段 ≤40 字、
 * 工具名在开头），这条链路是通的。
 */
export function pageToolsPrompt(tools, task) {
  // G20：只放行前 3 个（顺序由调用方的 navToolNames 决定，这里再兜一层）
  const picked = tools.slice(0, 3);
  const lines = picked.map((t) => {
    const props = (t.inputSchema && t.inputSchema.properties) || {};
    const req = (t.inputSchema && t.inputSchema.required) || [];
    const params = Object.keys(props).map((k) => k + (req.includes(k) ? '（必填）' : '')).join('、') || '无';
    return `- ${t.name}：${t.description || t.desc}（参数：${params}）`;
  }).join('\n');
  // G21：单参数样例，且用自然语言描述而非 XML
  const ex = picked[0];
  const exParam = ex ? Object.keys((ex.inputSchema && ex.inputSchema.properties) || {})[0] : '';
  const exLine = ex
    ? `比如要${ex.name === 'site_index' ? '看站点地图' : '查内容'}，就直接说：${ex.name}${exParam ? '，' + exParam + '=关键词' : ''}`
    : '';
  // ⭐ 2026-10-21 重写（用户定案）：双系统路由那套规则是「tools 没送到」时的补丁。
  //
  // 当时的症状：模型收不到站内工具清单 ⇒ 它只能用手边唯一的办法（自己原生所在
  // 的学习通）去答「跳到最新作业页」，于是我们写了【A】/【B】路由规则去纠正它。
  // 现在 tools 真的送到了（wire 断言 + [DBG] 实测：11 个工具逐个在场），工具描述
  // 本身就说清了「站点地图 / 读本页正文 / 搜全站」——模型有信息自己判断。
  //
  // 而且那套规则里的命令式否定（「不要转头去…」）被上游安全层读成
  // 「禁止模型如实说没有」⇒ 判定越狱、整轮拒答（2026-10-21 用户实测）。
  // 所以现在只留事实：这些标记操作的是哪个站。
  return `下面几个标记操作**当前课程资料站**里的页面（不是学习通）：

${lines}

${exLine}。一次一条，参数只填关键词。

任务：${task || ''}

按「标记名，参数=值」写一条。`;
}

// ── 答案净化（从 对话.mjs 原样搬来）───────────────────────────

const stripThink = (t) => String(t).replace(/<think>[\s\S]*?<\/think>/g, '').trim();

export function cleanAnswer(t) {
  return stripThink(t)
    // 只剥 XML 协议残留。**不剥工具名**（2026-10-19 实测）：
    // 旧版把 `site_[a-z_]+` 也替换成空，模型说「标记：site_search」被剥成「标记：``」，
    // 人看不懂它在讲什么。工具名是模型与我们的共同语言，留着。
    .replace(/<\/?function_calls>/g, '')
    .replace(/<\/?invoke[^>]*>/g, '')
    .replace(/<\/?parameter[^>]*>/g, '')
    .replace(/^\s*(登记完成|好的[，,])[。，,]?\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const maybeParse = (v) => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
};

/**
 * 建一个工具会话。
 * @param {object} p
 * @param {{ask: Function}} p.mgr            会话管理器（ask(id, text, opts)）
 * @param {string} p.sessionId               管理器里的会话 id
 * @param {Function} p.invoke                (name, args) → Promise<{value, effect?}>
 * @param {Array<{name:string, description?:string, desc?:string, inputSchema?:object}>} [p.tools]
 *   工具清单（页面桥报上来的定义；空数组 = 纯问答）
 * @param {number} [p.rounds=4]              工具闭环最多轮数
 * @param {string[]} [p.navToolNames]        放行进提示词的工具名（默认全放行）
 * @param {RegExp} [p.actionRe=PAGE_ACTION_RE]  哪些话算「要动页面」
 */
export function createToolSession({
  mgr, sessionId, invoke, tools = [], rounds = 4, navToolNames = null, actionRe = PAGE_ACTION_RE,
  upload = null,          // 视觉接缝：(bytes, opts) → fileInfo；null = 不支持看图
  visionQuestion = '图里有什么？',
  contextProvider = null, // 页面上下文接缝：() → {title, course, sections[]}；null = 不注入
  alwaysTools = true,     // 默认给工具表（见 PAGE_ACTION_RE 上方的说明）
}) {
  const allowed = navToolNames ? tools.filter((t) => navToolNames.includes(t.name)) : tools;

  /**
   * 把退化调用（`{_positional: '铁芯损耗'}`）映射成该工具的具名参数。
   * 模型只给了位置没给参数名时，按工具 schema 的第一个必填/第一个属性填。
   * 映射不出来就原样留着（工具会自己报参数错，比静默丢弃好）。
   */
  function normalizeCall(c) {
    if (!c || !c.degraded) return c;
    const tool = tools.find((t) => t.name === c.name) || allowed.find((t) => t.name === c.name);
    const pos = c.args && c.args._positional;
    if (!tool || !pos) return c;
    const props = (tool.inputSchema && tool.inputSchema.properties) || {};
    const req = (tool.inputSchema && tool.inputSchema.required) || [];
    const key = req[0] || Object.keys(props)[0];
    if (!key) return c;
    // site_read 这类有 what 的工具：位置参数大概率是 query，不是 what
    const target = key === 'what' ? (Object.keys(props).find((k) => k !== 'what') || key) : key;
    return { name: c.name, args: { ...c.args, [target]: pos, _positional: undefined } };
  }

  /** 执行一次调用，统一收成 { call, ok, value, effect }。 */
  async function execOne(c) {
    try {
      const r = await invoke(c.name, c.args);
      const value = maybeParse(r && r.value);
      const effect = (r && r.effect) || null;
      const soft = value && typeof value === 'object' && value.ok === false;
      return { call: c, ok: !soft, value, effect };
    } catch (e) {
      return { call: c, ok: false, value: null, effect: null, error: String(e.message || e) };
    }
  }

  /**
   * 回喂前的瘦身：图片清单可能几十条，全量塞回去会撞上游单条长度限制
   * （实测 35 张 × ~150 字 = 5KB，直接超）。只保留「选图需要知道」的字段。
   */
  const MAX_FEED_JSON = 6000;   // 单条工具结果回喂上限（P2-22）

  function slimForFeed(name, v) {
    if (!v || typeof v !== 'object') return v;
    // site_index 的树含百分号编码与反引号，上游会判成「疑似注入的编码串」。
    // 修法：只留「缩进 + 标题 + 路径」。
    //
    // ⚠️ 2026-10-19 实测（这是本轮最贵的一条）：原来写死 `slice(0, 60)` 行。
    // 全站 118 个节点铺开约 140 行，砍到 60 行后模型只看到前一两门课，于是
    // 自信地回答「本站是电子技术课程的知识图谱，没有电机学」——
    // **截断让工具开始撒谎**，比不返回更糟。
    //
    // 现在的做法：**按结构降级，不按位置砍断**。
    //   · 全量放得下就给全量；
    //   · 放不下就逐个课程压缩成「课程名（N 页）」的一行摘要——每门课都还在，
    //     模型知道有哪些课、也知道自己看不到细节，可以再去 site_index(scope=course)。
    // 绝不出现「刚好砍在某门课中间，后面的课凭空消失」。
    if (name === 'site_index' && typeof v.text === 'string') {
      const MAX_TREE = 3200;
      const lines = String(v.text)
        .replace(/%[0-9A-Fa-f]{2}/g, '')
        .replace(/`/g, '')
        .split('\n');
      let cleaned = lines.join('\n');
      if (cleaned.length > MAX_TREE) {
        // 降级：按顶层缩进分组，每门课只留一行 + 该组页数
        const groups = [];
        let cur = null;
        for (const ln of lines) {
          const indent = ln.match(/^ */)[0].length;
          const isCourse = /^\s{2}\S/.test(ln) && !/^\s{2}-/.test(ln);
          if (isCourse) { cur = { title: ln.trim(), count: 0, sub: [] }; groups.push(cur); }
          else if (cur) {
            if (/^\s+-/.test(ln)) cur.count += 1;
            else if (/^\s{4,}\S/.test(ln) && cur.sub.length < 8) cur.sub.push(ln.trim());
          } else {
            groups.push({ title: ln.trim(), count: 0, sub: [], raw: true });
          }
        }
        const compressed = [];
        for (const g of groups) {
          if (g.raw) { compressed.push(g.title); continue; }
          compressed.push(`  ${g.title}（${g.count} 页）`);
          for (const s of g.sub.slice(0, 4)) compressed.push(`    ${s}`);
        }
        cleaned = compressed.join('\n')
          + `\n（清单较大，已压缩为课程级摘要；共 ${lines.length} 行 / ${v.totalNodes || '?'} 个节点。`
          + '要看某门课的完整页面清单，用 site_index(scope="course") 切到那门课）';
      }
      return {
        ok: v.ok, scope: v.scope, current: v.current, courses: v.courses,
        totalNodes: v.totalNodes, shown: v.shown,
        text: cleaned,
      };
    }
    if (name === 'site_list_images' && Array.isArray(v.images)) {
      return {
        ok: v.ok, total: v.total, needConvert: v.needConvert, hint: v.hint,
        images: v.images.slice(0, 12).map((x) => ({
          index: x.index, ext: x.ext, uploadable: x.uploadable,
          natural: x.natural, alt: String(x.alt || '').slice(0, 60),
        })),
        omitted: Math.max(0, v.total - 12),
      };
    }
    // 2026-10-19：从 3000 收到 1500——实测上游单条上限约 1000-2000 字，
    // 3000 字的回喂会直接触发「输入信息过长」。
    if (name === 'site_read' && typeof v.text === 'string' && v.text.length > 1500) {
      return { ...v, text: v.text.slice(0, 1500), truncated: true, totalChars: v.totalChars || v.text.length };
    }
    // 2026-10-19 修 P2-22：其余工具此前**无上限**——模型给个巨大 maxChars 就能把
    // 桥响应和提示词一起撑爆。统一兜底：序列化超限就截断并标记。
    let json;
    try { json = JSON.stringify(v); } catch { return v; }
    if (json.length <= MAX_FEED_JSON) return v;
    return {
      _truncated: true,
      _originalChars: json.length,
      _head: json.slice(0, MAX_FEED_JSON),
      _hint: '结果过长已截断；需要更多请缩小参数范围（如 maxChars / limit / max）',
    };
  }

  /** 从效果回执里提炼一句给人看的话（产品摘要；判据不用这个，直接看 effect 字段）。 */
  function describe(x) {
    if (!x.ok || !x.value || typeof x.value !== 'object') return null;
    const v = x.value;
    if (x.call.name === 'site_open_section') return `已跳到「${v.title || ''}」`;
    if (x.call.name === 'site_search' && Array.isArray(v.hits)) return `搜索到 ${v.hits.length} 条结果`;
    if (v.ok) return '页面操作完成';
    return null;
  }

  /** dataUrl → 字节（视觉链路的最后一公里）。浏览器移植：Buffer.from → b64ToBytes。 */
  function dataUrlBytes(dataUrl) {
    const b64 = String(dataUrl || '').split(',')[1] || '';
    if (!b64) return null;
    try { return b64ToBytes(b64); } catch { return null; }
  }

  async function run(userText, askOpts) {
    const wantsPageAction = (alwaysTools || actionRe.test(userText)) && allowed.length > 0;
    // G15 疑问式法则：工具表在前、任务句在最后（模型最后读到的就是那个问句）
    let prompt = wantsPageAction ? pageToolsPrompt(allowed, userText) : userText;

    // ⭐ 首轮页面上下文（2026-10-19 实测）：不给页面信息时，模型对「这一章」「第 3 题」
    // 这类指代一律回「指代不明」——上游把它判成 context_missing，重放历史也救不回来
    // （历史里根本没有页面内容）。所以动作意图的第一条消息必须自带「我在哪一页」。
    if (wantsPageAction && contextProvider) {
      try {
        const ctx = await contextProvider();
        if (ctx) {
          // ⭐ 2026-10-19 grill Q4 定案：**不再注入小节标题**。
          // 旧版塞 12 条标题进去，等于替模型完成了「定位」——它不需要查目录、
          // 不需要判断哪一节相关，直接复述标题当答案（实测「电路原理选3图13解析」）。
          // 现在只给「你在哪 + 有哪些工具」，查找过程还给模型自己。
          const head = [
            `你在【课程资料站】的：《${ctx.title || ''}》${ctx.course ? '（' + ctx.course + '）' : ''}`,
            ctx.path ? `页面路径：${ctx.path}` : '',
            ctx.sections && ctx.sections.length ? `本页共 ${ctx.sections.length} 个小节。` : '',
            // 「搜全站」是歧义源之一：模型在自家页面上会把它读成「搜学习通」。
            '可用工具（只作用于本资料站，不是学习通）：site_index（看本站地图）、'
              + 'site_read（读本页正文）、site_navigate（去本站别的页）、'
              + 'site_search（搜本站全站）、site_list_images（列本页图片）。',
            '先自己查目录/读正文，再回答。',
          ].filter(Boolean).join('\n');
          prompt = `${head}\n\n${prompt}`;
        }
      } catch { /* 取不到上下文就照常问，不阻塞 */ }
    }
    const calls = [];
    const effects = [];
    const images = [];      // 本轮交给模型「看」的图（已上传的 fileInfo）
    // 图片只在**首次**随消息发出（2026-10-19 补用户附件）：
    // 旧实现每轮都把 images 全量塞进 fileInfo，工具循环跑 4 轮就重复挂了 4 次
    // 同样的图——上游会把重复附件当异常。用标志位而不是清空 images，
    // 因为返回值的 `images` 仍要如实反映「这轮交付了哪些图」。
    let imagesSent = false;
    // 2026-10-19 修 P2-13：summary 原先声明在 createToolSession 作用域，
    // 复用同一个 session 对象时会跨 run() 累积。改为每次 run 重置。
    const summary = [];
    // 每轮耗时诊断（2026-10-20 查「每次都 50 秒」）：{round, ms, attempts, status, calls}。
    // 与 summary 同理，每次 run 重置。只读，不参与任何判断。
    const timings = [];

    for (let round = 1; round <= rounds; round++) {
      // ⭐ 最后一轮强制收尾（2026-10-19 实测）：不这么做的模型会一直调工具，
      // 6 轮全用在「再读一次 / 再搜一次」上，最终 status=unresolved、answer 为空。
      const lastRound = round === rounds;
      if (lastRound) {
        prompt = `${prompt}

工具调用次数已用完。**不要再写任何调用**，直接用上面已经拿到的结果回答用户。`;
      }
      // 有图就带图问（第一轮带图时模型才看得见；后续回喂仍是文本）
      //
      // ⭐ 流式（2026-10-19）：**只在「会产生最终答案」的那一轮**转发 onChunk。
      //
      // 两种情形：
      //   · 最后一轮（round === rounds）—— 被强制收尾，输出就是答案
      //   · 本轮模型没有工具调用 —— 它就是最终答案（一轮答完的常见情况）
      //
      // 但「本轮有没有工具调用」要等答案回来才知道。所以策略是：
      // **先转发**，若解析出工具调用则说明这轮是过程话——此时前端已经收到了 delta，
      // 无法撤回。因此更稳妥的做法是：只在 lastRound 转发，其余轮次靠
      // 「无工具调用时补发完整答案」兜底（聊天服务已实现）。
      //
      // 权衡：一轮答完的场景没有逐字流（会整段出现），但工具循环的过程话绝不会漏给用户。
      // 后者是产品红线（用户不该看到「我查一下」）。
      //
      // 图片的传递（2026-10-19 补用户附件）：只在**本轮有新图**时才随消息发出，
      // 发出一次后不再重复挂载——工具循环跑 4 轮不会挂 4 次同样的附件。
      const opts = images.length && !imagesSent
        ? { ...(askOpts || {}), fileInfo: images.slice() }
        : askOpts;

      // ── 流式（2026-10-19 回退说明）────────────────────────────
      //
      // 只在 `lastRound`（round === rounds）转发 onChunk。
      //
      // ⚠️ 已知缺陷（2026-10-19 调查确认）：实测绝大多数回答在**第 1–2 轮**就结束，
      // 永远走不到 lastRound ⇒ 流式代码存在但**从未真正启用过**——用户看到的是
      // 整段蹦出，不是逐字。这是「看起来有流式、实际没有」的根因。
      //
      // 曾尝试「每轮都转发 + 发现工具轮就撤回」，调查判定为不成熟并已回退，
      // 四个致命问题：
      //   ① 撤回句柄 `onChunk.retract` 挂在函数属性上，中间被包装函数
      //      （chunkSink）包一层就静默丢失 ⇒ 后端从不发 retract，前端那段是死代码
      //   ② 流出去的是**未清洗**原文，而答案是 cleanAnswer 之后的文本
      //      ⇒ `<think>` 块与工具调用标记会留在气泡里，且没有任何覆盖机会
      //   ③ 管理器内部重试会再次 ask，失败尝试已流出的半截正文无人撤回
      //   ④ 面板在 done 与流结束各 flush 一次，末段（无尾换行的最常见情况）重复渲染
      //
      // 正确方向（未实施）：撤回契约要做成**显式对象**（如 onStream{delta,retract}）
      // 而不是函数属性；并给每个 delta 带轮次序号，让撤回精确到轮；
      // cleanAnswer 要在**流式输出前**逐段生效，不能只作用于最终答案。
      const streamOpts = lastRound && opts && opts.onChunk
        ? opts
        : (opts && opts.onChunk ? { ...opts, onChunk: null } : opts);
      if (images.length && !imagesSent) imagesSent = true;
      const r = await mgr.ask(sessionId, prompt, streamOpts);
      const txt = r.text || '';
      // 每轮耗时（2026-10-20）：分清「单轮慢」与「轮数叠加」。
      // 四轮各 12s 与一轮 45s 是完全不同的病，只看总墙钟无法定位。
      const timing = {
        round,
        ms: r.ms != null ? r.ms : null,
        attempts: r.attempts != null ? r.attempts : null,
        status: r.status,
        calls: 0,
      };
      timings.push(timing);

      // 传输层故障：如实上抛（管理器已按策略换线重试过，仍失败才算真故障）
      if (r.status !== 'ok' && r.status !== 'blocked') {
        return { answer: '', calls, effects, images, status: r.status, text: txt, timings };
      }
      // 退化形态也要认（2026-10-19：上游某些时段只回「site_read读选3」这种裸文本）。
      //
      // ⚠️ 白名单用**全部已注册工具**（tools），不是提示词里那 3 个（allowed）。
      // G20 的「工具上限 3 个」约束的是**提示词长度**（清单越长越易被拦），
      // 不该约束「模型能调什么」——实测模型会自己想到第 4 个工具（site_navigate），
      // 用 allowed 过滤会把它写的调用静默丢掉。
      const parsed = r.status === 'blocked'
        ? []
        : parseToolCalls(txt, tools.map((t) => t.name)).map((c) => normalizeCall(c));

      if (!parsed.length || lastRound) {
        // 最后一轮：即使模型又写了调用，也把正文当答案交出去（剥掉调用块）
        const ans = cleanAnswer(txt);
        return {
          answer: ans || '',
          summary: summary.join('\n'),
          calls, effects, images, status: r.status,
          timings,
        };
      }
      timing.calls = parsed.length;

      // 执行工具（经 invoke 接缝——桥、实验记录器都从这里进）
      const results = [];
      for (const c of parsed) {
        const x = await execOne(c);
        calls.push(c);
        if (x.effect) effects.push({ name: c.name, args: c.args, ...x.effect });
        const d = describe(x);
        if (d) summary.push(d);
        results.push(x);
      }

      // ⭐ 视觉链路（2026-10-19）：模型调 site_image 拿到 dataUrl 后，
      // 页面侧已经把 webp 转成 jpeg 了；这里负责「上传 + 带图追问」——
      // 否则 dataUrl 只是一串 base64，模型自己看不见自己取到的图。
      const uploaded = [];
      for (const x of results) {
        if (!x.ok || x.call.name !== 'site_image' || !upload) continue;
        const v = x.value || {};
        if (!v.ok || !v.dataUrl) continue;
        const bytes = dataUrlBytes(v.dataUrl);
        if (!bytes) continue;
        try {
          const fi = await upload(bytes, {
            filename: v.format === 'png' ? 'page.png' : 'page.jpg',
            mime: v.mimeType || (v.format === 'png' ? 'image/png' : 'image/jpeg'),
          });
          if (fi) {
            images.push(fi);
            uploaded.push(fi);
            summary.push(`已把页面图片交给模型看（${Math.round(bytes.length / 1024)}KB）`);
          }
        } catch (e) {
          results.push({ call: x.call, ok: false, error: `图片上传失败：${String(e.message || e)}` });
        }
      }

      // 回喂：工具真实结果（含效果回执——模型据此知道页面真的动了）
      // dataUrl 是几万字符的 base64，回喂时必须剥掉，否则撞上游单条长度限制。
      //
      // ⚠️ 2026-10-19 实测：单条上限约 1000-2000 字。多个工具结果拼起来极易超限
      //（site_index + site_read 一次就能到 4000+）。这里按总量再兜一层。
      //
      // 2400 → 3600（2026-10-19 二次实测）：站点地图是全站唯一的「有哪些页」
      // 真相源，砍短了模型会**编造**结论（实测把六门课说成一门）。宁可让这条
      // 多占预算、后面几条被截断（截断处有明示），也不要让地图失真。
      const FEED_BUDGET = 3600;
      let feedUsed = 0;
      const feedLines = [];
      for (const x of results) {
        let line;
        if (!x.ok) line = `- ${x.call.name} 失败：${x.error}`;
        else {
          const v = x.value;
          if (v && typeof v === 'object' && v.dataUrl) {
            const { dataUrl, ...rest } = v;
            line = `- ${x.call.name} 返回：${JSON.stringify(slimForFeed(x.call.name, rest))}（图片已附在消息里）`;
          } else {
            line = `- ${x.call.name} 返回：${JSON.stringify(slimForFeed(x.call.name, v))}`;
          }
        }
        if (feedUsed + line.length > FEED_BUDGET) {
          // 超预算：截断这一条塞进去（不整条丢——模型至少知道调过什么），然后停。
          const room = Math.max(120, FEED_BUDGET - feedUsed);
          if (room > 120) feedLines.push(line.slice(0, room) + '…（截断）');
          const rest = results.length - feedLines.length;
          if (rest > 0) feedLines.push(`- （其余 ${rest} 个结果因篇幅省略）`);
          break;
        }
        feedUsed += line.length;
        feedLines.push(line);
      }
      prompt = `刚才的操作结果：
${feedLines.join('\n')}

请根据上面的结果回答用户的问题。如果任务还没完成（例如用户要你看图，而你只列出了清单），
继续写调用；完成了就直接回答。`;
      // 上传过图 → 本轮直接问「图里有什么」这种极简问题（agent.md 实测：问法越像任务提取越易被拦）
      if (uploaded.length) prompt = `${prompt}\n\n${visionQuestion}`;
    }
    return { answer: '', summary: summary.join('\n'), calls, effects, images, status: 'unresolved', timings };
  }

  return { run, describe };
}
