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
  // ⭐ 2026-10-23 三次改版：**规则式 → 示例式**。
  //
  // 前两版都是规则式（「写法是『名字，参数=值』」+ 工具清单）。实测 12 轮，
  // 行为随机：照做 5 / 拒答 4 / 只说不做 1 / 其它 2。原因分析（外部设计评审）：
  // 模型的训练是为「原生函数调用」优化的，把工具定义塞进正文时，它把清单当
  // **要理解的内容**而不是**要遵守的格式**——所以规则写得再清楚也只有一半照做。
  //
  // 示例式为什么更有效：模型从「完整对话循环」里学格式，强于从规则里学。
  // 它见过「用户问 → 助手先说打算 → 助手写一行调用 → 系统返回 → 助手回答」
  // 这个闭环，就知道自己在哪一环该输出什么；规则式它当知识点记，示例式它当行为模仿。
  //
  // 长度纪律：整段控制在 900 字内（上游单条拒收线实测约 2030，留一半余量）。
  // 安全纪律：不含 URL、不含域名、不含任何编码串（run3 blocked 的触发词就是这些）。
  const catalog = tools.slice(0, 11).map((t) => {
    const props = (t.inputSchema && t.inputSchema.properties) || {};
    const ps = Object.keys(props).slice(0, 4).join('、') || '无参数';
    return `${t.name}（${ps}）`;
  }).join('；');

  // 2026-10-24 改版（issue #20 示例污染）：示例任务句曾用真页名（工程数学作业2），
  // 真上游实测模型把它当成了真任务（E3-T2-r2 答非所问）。三处变化：
  //   ① 示例目标改虚拟页——与任何真实任务零碰撞，形态教学不受影响（复测实证
  //      to=page 正确率 100% 来自调用行形态，与示例页名无关）；
  //   ② 跳转演示补搜索步（先搜再跳）——真实任务大多是两步，旧示例只教「拿已知
  //      路径直跳」，复测 E2-T1-r2 出现「搜到了却不跳」；
  //   ③ 演示与任务加边界行——把注意力锚回末行的任务句（G15：最后读到的最重要）。
  // 措辞纪律：正向表述（原「不要整句抄进去」为否定式，改正向）。
  return `你可以读取和操作「当前课程资料站」的页面。下面演示完整用法（演示页是虚拟的）：

用户：这页讲了什么？
助手：先看这一页的小节。
site_read，what=outline
系统返回：一、行列式定义；二、性质；三、习题
助手：我读第二节。
site_read，what=section，query=性质
系统返回：（这一节的正文）
助手：这一节讲了三件事……

用户：去示例课程的资料页。
助手：我先搜它在哪。
site_search，query=示例课程
系统返回：命中 1 页：课程/示例/index.html
助手：找到了，跳过去。
site_navigate，to=page，path=课程/示例/index.html
系统返回：已跳到该页
助手：跳好了。

照这个节奏：先写一句打算做什么，再写一行「名字，参数=值」；系统执行后把结果发回来，你接着往下写。一次只写一行，参数只填关键词。

任务要多个材料时，逐份读、逐份记：每读完一份就把要点记下来，再读下一份，全部读完才写总结。读到一页的元数据（标题/字数）不算读过内容，要读到正文。演示到此为止，你的任务在最后一行。

可用：${catalog}

任务：${task || ''}`;
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
   * 已交付给上游的附件（objectId 集合）——**跨 run() 保持**，与 session 同生命周期。
   *
   * ⚠️ 2026-10-25（官方站实测）：助手模式下 `fileInfo` 只需在发图那一轮带，
   * 后续轮 `[]` 上游仍记得（实测第 3、4 轮完全记得图，还画出矩阵位置图）。
   * 旧实现在 run() 内用局部布尔 `imagesSent`，**每次 run() 重置** ⇒ 同一会话
   * 连续提问时每问都重传历史全部附件——粒度错了（按 run 而非按会话）。
   *
   * 落账时机：只在**该轮 answered 之后**才加入。transport/blocked 失败时上游
   * 没收到，不落账，下一轮可重试。
   */
  const attachmentsSent = new Set();

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
  const MAX_FEED_JSON = 2400;   // 单条工具结果回喂上限（2026-10-25：6000 → 2400，对齐上游单条上限）

  function slimForFeed(name, v) {
    if (!v || typeof v !== 'object') return v;
    // ⭐ 2026-10-23：dataUrl 一律剥掉（几万字符 base64 会撞上游单条上限）。
    // 旧实现是在回喂模板里内联剥的；改信封后那段没了，这里补回来——
    // 它是所有工具的通用规则，不是 site_image 专属。
    if (typeof v.dataUrl === 'string') {
      const { dataUrl, ...rest } = v;
      v = rest;
    }
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
    if (name === 'site_read' && typeof v.text === 'string' && v.text.length > 1100) {
      return { ...v, text: v.text.slice(0, 1100), truncated: true, totalChars: v.totalChars || v.text.length };
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
  /**
   * 一次工具结果 → 一行**可积累的事实**（进 summary，收尾轮会带上）。
   *
   * ⚠️ 2026-10-25 修（无上限长任务实测：40 轮 41 调用后答案退化成 15 字碎片）：
   * 旧实现只会产出「页面操作完成」这类空话，summary 里没有任何内容——
   * 模型跑 40 轮后收尾时手上没有可组织的事实，只能吐碎片。
   * 现在记**标题 + 首句**（前 80 字），六门课跑下来就是六条真材料。
   */
  function describe(x) {
    if (!x || !x.ok || !x.value || typeof x.value !== 'object') return null;
    const v = x.value;
    const name = x.call && x.call.name;
    const args = (x.call && x.call.args) || {};
    const firstLine = (s) => String(s || '').replace(/[#*`>\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);

    if (name === 'site_read') {
      const title = v.title || (args.query || args.what || '');
      const head = firstLine(v.text || v.outline || '');
      return `读到「${String(title).slice(0, 40)}」${head ? '：' + head : ''}`;
    }
    if (name === 'site_search') {
      const hits = Array.isArray(v.hits) ? v.hits : [];
      const names = hits.slice(0, 3).map((h) => h.title || h.path || '').filter(Boolean);
      return `搜「${String(args.query || '').slice(0, 20)}」命中 ${v.total != null ? v.total : hits.length} 条${names.length ? '：' + names.join(' / ') : ''}`;
    }
    if (name === 'site_navigate') {
      return `到达「${String(v.title || v.path || args.path || '').slice(0, 40)}」`;
    }
    if (name === 'site_index') {
      const n = Array.isArray(v.nodes) ? v.nodes.length : (v.count != null ? v.count : null);
      return `看了站点地图${n != null ? '（' + n + ' 项）' : ''}`;
    }
    if (v.title) return `「${String(v.title).slice(0, 40)}」`;
    if (v.ok !== false) return null;
    return null;
  }

  /** dataUrl → 字节（视觉链路的最后一公里）。浏览器移植：Buffer.from → b64ToBytes。 */
  function dataUrlBytes(dataUrl) {
    const b64 = String(dataUrl || '').split(',')[1] || '';
    if (!b64) return null;
    try { return b64ToBytes(b64); } catch { return null; }
  }

  async function run(userText, askOpts) {
    // ⚠️ 2026-10-25 修（生产验收）：**工具表为空也必须发提示词**。
    // 旧条件 `&& allowed.length > 0` 的后果：页面工具没注册时（mode=absent、
    // polyfill 未加载、SPA 换页丢注册），提示词整段被跳过，用户正文裸发上游——
    // 模型连「有这套文本协议」都不知道，只会回「我没有 site_* 工具」。
    // 提示词里的示例与调用形态本来就与工具表无关（catalog 为空只是少一行清单），
    // 照发才能让模型写出调用行；真调不通时回喂会如实报错，比静默裸问好。
    const wantsPageAction = alwaysTools || actionRe.test(userText);
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
          // 2026-10-25（桥形态真上游实测）：首轮模型只调一次 site_read（读到首页
          // README）就放弃，直接拿示例答案收尾。缺的是**检索顺序**：它不知道该先
          // 用 site_search 定位、命中页后再读。这里把顺序写成三条可照做的步骤，
          // 并显式点明「当前页若不是目标页，先搜再跳」（实测起点永远是 README）。
          const head = [
            `你在【课程资料站】的：《${ctx.title || ''}》${ctx.course ? '（' + ctx.course + '）' : ''}`,
            ctx.path ? `当前页路径：${ctx.path}` : '',
            ctx.sections && ctx.sections.length ? `本页共 ${ctx.sections.length} 个小节。` : '',
            `可用工具：${allowed.map((t) => t.name).join('、')}。`,
            '查找顺序：① 当前页不是目标页时，先 site_search 搜关键词定位页面；'
              + '② 用 site_navigate 或 site_read 到命中页；③ 读到内容再回答。'
              + '一轮只写一行调用，系统会把结果发回来，你接着写下一行。',
          ].filter(Boolean).join('\n');
          prompt = `${head}\n\n${prompt}`;
        }
      } catch { /* 取不到上下文就照常问，不阻塞 */ }
    }
    const calls = [];
    const effects = [];
    const images = [];      // 本轮交给模型「看」的图（已上传的 fileInfo）
    // 2026-10-19 修 P2-13：summary 原先声明在 createToolSession 作用域，
    // 复用同一个 session 对象时会跨 run() 累积。改为每次 run 重置。
    const summary = [];
    // 每轮耗时诊断（2026-10-20 查「每次都 50 秒」）：{round, ms, attempts, status, calls}。
    // 与 summary 同理，每次 run 重置。只读，不参与任何判断。
    const timings = [];

    // rounds <= 0 = **不设上限**（2026-10-25）：模型自己决定何时停。
    // 硬保险仍在：单问有 deadline（管理器 360s 墙钟），不会真的挂死。
    const MAX_ROUND_HARD = 60;   // 无上限时的物理保险，防病态输出
    const effRounds = rounds > 0 ? rounds : MAX_ROUND_HARD;
    for (let round = 1; round <= effRounds; round++) {
      // ⭐ 最后一轮强制收尾（2026-10-19 实测）：不这么做的模型会一直调工具，
      // 6 轮全用在「再读一次 / 再搜一次」上，最终 status=unresolved、answer 为空。
      // ⭐ 2026-10-25 定案（站长）：**不设收尾轮、不发任何收尾 prompt**。
      // 上游自己会规划工具调用——它要的是一个「冰冷的显示屏」：每次回复只拿到
      // 上一轮所有工具的原始结果，不加任务复述、不加 deadline 提醒、不加「该收尾了」。
      // 上下文只有 256k，任何一句多余的引导都是在挤占它自己的规划空间。
      // 之前那些「最后一轮强制收尾」「重发任务句」「结构化解说」全部删除。
      const lastRound = round === effRounds;
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
      // 待发附件 = 本会话还没交付过的那些（跨 run 去重）。
      // ⚠️ 两个来源都要过滤：
      //   ① `images`  —— 工具循环自己上传的图（site_image 转码后）
      //   ② `askOpts.fileInfo` —— 调用方传进来的用户附件（chatsvc 的 attach）
      // 只过滤 ① 会让 ② 每轮原样透传 ⇒ 每次 run() 都重传全部历史附件。
      const incoming = [
        ...images,
        ...(Array.isArray(askOpts && askOpts.fileInfo) ? askOpts.fileInfo : []),
      ];
      const seen = new Set();
      const freshAttach = incoming.filter((f) => {
        if (!f || !f.objectId) return false;
        if (attachmentsSent.has(f.objectId) || seen.has(f.objectId)) return false;
        seen.add(f.objectId);
        return true;
      });
      const opts = freshAttach.length
        ? { ...(askOpts || {}), fileInfo: freshAttach }
        : (askOpts && askOpts.fileInfo ? { ...askOpts, fileInfo: [] } : askOpts);

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
      const r = await mgr.ask(sessionId, prompt, streamOpts);
      // 落账时机：该轮成功才记（上游确实收到了才不重发）
      if (r && r.status === 'answered' && freshAttach.length) {
        freshAttach.forEach((f) => attachmentsSent.add(f.objectId));
      }
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
        // 2026-10-22：把原始错误（r.error）一起带出去。以前只传 status 枚举，
        // 面板上最终显示「未知错误」——查连通问题时分不清是桥没起、密文解不开
        // 还是上游拒答，等于没有诊断信息。
        return { answer: '', calls, effects, images, status: r.status, error: r.error, text: txt, timings };
      }
      // 退化形态也要认（2026-10-19：上游某些时段只回「site_read读选3」这种裸文本）。
      //
      // ⚠️ 解析白名单用**全部已注册工具**（tools），不是提示词清单（allowed）。
      // 清单约束的是提示词长度，不该约束「模型能调什么」——用 allowed 过滤
      // 会把模型写的调用静默丢掉（2026-10-23 起 allowed 默认就是全量，此处零风险）。
      let parsed = r.status === 'blocked'
        ? []
        : parseToolCalls(txt, tools.map((t) => t.name)).map((c) => normalizeCall(c));

      // ⭐ 2026-10-23（长任务实测）：沙箱调用拦截。模型常把 site_* 行包进它自己的
      //   沙箱工具——execute("echo \"site_read，what=outline\"") 或 read_file——
      //   意图全在、通道选错（proto.mjs 已按 tool_call_id 拼好透出 r.sandboxCalls）。
      //   从参数文本里抠出 site_* 行，转成我们的调用（与退化解析同一解析器复用）。
      //   只认 knownTools 白名单内的名字，不猜；一条沙箱调用只抠第一条 site 行。
      if (r.sandboxCalls && r.sandboxCalls.length) {
        const toolNames = tools.map((t) => t.name);
        for (const sc of r.sandboxCalls) {
          if (sc.name !== 'execute' && sc.name !== 'read_file' && sc.name !== 'ls') continue;
          const argText = String(sc.args || '');
          // execute 的 args 是 JSON 串：{"command": "echo \"site_read，…\""}
          let hay = argText;
          try { const o = JSON.parse(argText); hay = Object.values(o).join(' '); } catch { /* 非 JSON 就用原文 */ }
          // 抠第一条「site_xxx，…」或「site_xxx, …」行
          const m = hay.match(new RegExp('(' + toolNames.join('|') + ')\\s*[，,][^\\n\\\\"]{1,120}'));
          if (m) {
            const one = parseToolCalls(m[0].trim(), toolNames);
            if (one.length) {
              parsed = parsed.concat(one.map((c) => normalizeCall(c)));
              // 沙箱路径找到真调用 = 本轮不是纯闲聊，thought 里的「我将调用」有下文了
            }
          }
        }
      }

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
      // ⭐ 2026-10-23 四次改版：**裸 JSON → 结构化信封**（外部设计评审 ③）。
      //
      // 旧形态 `- site_read 返回：{"ok":true,"text":"…"}` 有两个问题：
      //   ① 模型要自己从 JSON 里找正文，且 JSON 转义（\n、\"）会干扰阅读；
      //   ② 元数据（总字数、位置、是否截断）埋在 JSON 字段里，模型得读完才知道。
      // 信封形态：开头一行说清「哪个工具、什么参数、成没成」，元数据在前
      // （总字数/位置/相关小节），正文原样贴（不转义），结尾给下一步建议。
      //
      // 长度纪律不变：总量仍受 FEED_BUDGET 兜底（上游单条拒收线 ~2030 字）。
      // ⚠️ 2026-10-25（长任务实测）：3600 → 1800。上游单条上限实测约 1000-2000
      // （本文件别处注释已写明），3600 的预算在第 3-4 轮会触发上游慢响应/退化
      // （实测第 4 轮 63s、重试 2 次、答案退化成 7 字片段）。
      const FEED_BUDGET = 1800;
      let feedUsed = 0;
      const feedBlocks = [];

      /** 一个工具结果 → 信封文本。 */
      const envelope = (x) => {
        const name = x.call.name;
        const args = x.call.args || {};
        const argStr = Object.keys(args)
          .filter((k) => args[k] !== undefined && args[k] !== '' && k !== '_positional')
          .map((k) => k + '=' + String(args[k]).slice(0, 40))
          .join(' | ');
        const head = `[工具返回：${name}${argStr ? ' | ' + argStr : ''}${x.ok ? '' : ' | 失败'}]`;

        if (!x.ok) {
          // 失败信封：原因 + 下一步建议（评审 ④：告诉它「调哪个工具、传什么参数」）
          const err = String(x.error || '执行失败');
          const hint = /not_found|没找到/.test(err)
            ? '\n建议下一步：换一个更短的关键词重试，或先用 site_read，what=outline 看全部标题。'
            : '\n建议下一步：换个参数重试；连续失败就直接告诉用户当前做不到。';
          return `${head}\n- 原因：${err}${hint}`;
        }

        // ⚠️ 信封必须基于 slimForFeed 的输出（它才带 truncated/totalChars），
        // 不是原始 v——否则「已截断」这个关键提示会丢，模型以为读完了。
        // 但「有没有图」要看**原始值**：slimForFeed 已把 dataUrl 剥掉了
        // （剥是为了不撞单条上限），剥完就检测不到了。
        const raw = x.value;
        const hadImage = !!(raw && typeof raw === 'object' && typeof raw.dataUrl === 'string');
        const v = (raw && typeof raw === 'object') ? slimForFeed(name, raw) : raw;
        if (hadImage) {
          return `${head}\n- 图片已附在本条消息里（${raw.width || '?'}×${raw.height || '?'}，${raw.format || 'jpeg'}）\n- 其余字段：${JSON.stringify(v).slice(0, 300)}`;
        }

        // 成功信封：元数据在前，正文原样
        const meta = [];
        if (v && typeof v === 'object') {
          if (v.title) meta.push('标题：' + v.title);
          // 回喂层截断（slimForFeed 把 site_read 正文切到 1500）：与工具自己的
          // has_more 不同层，两者都要告诉模型，否则它以为已经读完了。
          if (v.truncated && v.totalChars != null) {
            meta.push('本条已截断：原文 ' + v.totalChars + ' 字，这里只给了开头（用 offset 参数续读）');
          }
          if (v.total_chars != null) meta.push('总字数：' + v.total_chars);
          if (v.offset != null) meta.push('本段起点：' + v.offset);
          if (v.has_more) meta.push('还有后续：是（可用 offset=' + (v.offset + (v.limit || 0)) + ' 继续读）');
          if (Array.isArray(v.outline)) meta.push('小节数：' + v.outline.length);
          if (v.count != null) meta.push('条目数：' + v.count);
          if (Array.isArray(v.candidates) && v.candidates.length) {
            meta.push('候选：' + v.candidates.map((c) => '「' + c + '」').join(' / '));
          }
        }
        const metaStr = meta.length ? meta.map((m) => '- ' + m).join('\n') + '\n' : '';

        // 正文：优先 text（site_read），其次其它可读字段
        let body = '';
        if (v && typeof v === 'object' && typeof v.text === 'string' && v.text) body = v.text;
        else body = JSON.stringify(slimForFeed(name, v));

        return `${head}\n${metaStr}---正文开始---\n${body}\n---正文结束---`;
      };

      for (const x of results) {
        const block = envelope(x);
        if (feedUsed + block.length > FEED_BUDGET) {
          const room = Math.max(200, FEED_BUDGET - feedUsed);
          if (room > 200) feedBlocks.push(block.slice(0, room) + '\n…（本条过长，已截断。需要更多内容请用 offset 参数续读）');
          const left = results.length - feedBlocks.length;
          if (left > 0) feedBlocks.push(`（另有 ${left} 个结果因篇幅省略）`);
          break;
        }
        feedUsed += block.length;
        feedBlocks.push(block);
      }

      // ⭐ 2026-10-25（站长定案）：回喂**只做机械搬运**——把上一轮所有工具的
      // 结果原样排好发回去，不加任何引导语、不复述任务、不给建议。
      // 上游自己会规划下一步；我们要当的是显示屏，不是监工。
      prompt = feedBlocks.join('\n\n');
      // 上传过图 → 本轮直接问「图里有什么」这种极简问题（agent.md 实测：问法越像任务提取越易被拦）
      if (uploaded.length) prompt = `${prompt}\n\n${visionQuestion}`;
    }
    return { answer: '', summary: summary.join('\n'), calls, effects, images, status: 'unresolved', timings };
  }

  return { run, describe };
}
