/**
 * 工具目录：**「有哪些工具、各自是什么」的唯一真相源**（2026-10-16 候选 1）。
 *
 * ## 它解决什么
 * 同一个工具的 name / description / inputSchema 从前在**五处各写一份**：
 *   ① `lib/endpoint-direct.mjs` 的 `TOOL_DEFS`
 *   ② 同文件的 `dispatch` 改名表（`readPage` → `read_page`）
 *   ③ `lib/endpoint-stdio.mjs` 的 `tools/list` 手工 `map`（还把 `title` 丢掉）
 *   ④ `站点/plugins/webmcp-tools.mjs` 的 5 个 `site_*`（另一个文件、另一套命名）
 *   ⑤ 破甲话术里手抄的工具清单（用于「让学习通 AI 输出调用」）
 *   ⇒ **改一处必漏四处**。
 *
 * ## 结构
 * 一个条目 = 一次定义，字段分三层：
 *   - **协议层**：`name`（给 MCP 客户端的全名）、`description`、`inputSchema`
 *   - **人称层**：`title`（给人看的中文短名）
 *   - **实现层**：`coreMethod` —— 读层 `ReadCore` 上的方法名（**改名表收到这里**，
 *     从前单独有一份 `dispatch` 表，`readPage` ↔ `read_page` 的对应散在调用点）
 *   - **课程层**：`course` —— **「这在课程里叫什么」**，供破甲话术生成
 *     （实测结论：让 AI 配合的关键是**把工具包装成课程内的正常事物**，
 *      见 `.zcode/handoff.md` §0.44/§0.45 的四要素配方）
 *
 * ## 两组前缀（互不相撞，有测试钉死）
 *   - `course_*`：读层（Node、stdio MCP、不需要浏览器）
 *   - `site_*`  ：浏览器侧（页面 WebMCP，给「跳转/搜索/气泡」这类交互）
 *   - 另有 relay 的保留名 `webmcp_*`（不是我们的，但也要避开）
 *
 * 零依赖、纯数据 —— 读层（Node）与浏览器侧（构建期内联）都能消费。
 */

/** 工具名前缀（协议层用）。 */
export const TOOL_PREFIX = 'course_';

/** 浏览器侧前缀。 */
export const SITE_PREFIX = 'site_';

/** relay 的固定管理工具名——我们的工具名不得与它们相撞。 */
export const RELAY_RESERVED = [
  'webmcp_list_sources',
  'webmcp_list_tools',
  'webmcp_call_tool',
  'webmcp_open_page',
];

/**
 * **读层工具目录**（5 个）。`course` 字段给破甲话术用：
 * 「这在课程里叫什么」——把工具说成**课程内的事物**，AI 才肯配合（§0.44 配方）。
 */
export const COURSE_TOOLS = [
  {
    name: 'ask',
    coreMethod: 'ask',
    title: '搜并取正文',
    description: '在主路径上用一次调用完成「搜全站 → 定位到命中小节 → 取该小节正文」。'
      + '适合「某课里 X 是怎么讲的」这类问题。可用 course 限定课程、budget 限字符数。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '查询词（中文按字面子串匹配）' },
        course: { type: 'string', description: '限定课程名，如「电机学」' },
        limit: { type: 'integer', description: '最多返回几个小节（默认 3，上限 10）' },
        budget: { type: 'integer', description: '每节字符预算（默认 4000，上限 20000）' },
      },
      required: ['query'],
    },
    course: {
      label: '资料检索标记',
      scene: '课程资料整理时，按关键词把散在各章的讲法一次取齐',
      params: { query: '要查的关键词', course: '限定的课程', limit: '取几段', budget: '每段多长' },
    },
  },
  {
    name: 'search',
    coreMethod: 'search',
    title: '搜全站',
    description: '只要命中列表（标题、小节锚点、摘要、命中次数、分数），不取正文。'
      + '适合先看看有哪些相关页面。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        course: { type: 'string' },
        category: { type: 'string', description: '类别，如「作业」「课堂笔记」「教材解析」' },
        limit: { type: 'integer', description: '默认 20，上限 200' },
      },
      required: ['query'],
    },
    course: {
      label: '全站检索标记',
      scene: '先看有哪些页讲了某个主题（只要清单，不要正文）',
      params: { query: '要查的关键词', course: '限定的课程', category: '限定的类别', limit: '取几条' },
    },
  },
  {
    name: 'read_page',
    coreMethod: 'readPage',
    title: '读整页',
    description: '取某一页的完整正文（来自源 markdown，保留 LaTeX 公式与 frontmatter）。'
      + '用 path（仓库相对路径）或 (course, category, file) 三元组指定。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '仓库相对路径，如 课程/电机学/作业/2026-10-15-xxx.md' },
        course: { type: 'string' },
        category: { type: 'string' },
        file: { type: 'string', description: '文件名（可与 course/category 组合）' },
        anchor: { type: 'string', description: '只取该小节（锚点 id）' },
      },
    },
    course: {
      label: '整页调阅标记',
      scene: '把某一整页的资料调出来看（作业页、笔记页、解析页）',
      params: { path: '资料路径', course: '课程总览', category: '类别', file: '文件名', anchor: '小节' },
    },
  },
  {
    name: 'symbol',
    coreMethod: 'symbol',
    title: '查符号',
    description: '查符号词典：给出符号的含义（含多义项与当前课程语境标记）。'
      + '用 id（如 sym-U）或 q（模糊匹配）指定。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '词条 id，如 sym-U、sym-Z' },
        q: { type: 'string', description: '模糊查询（在 id/标题/正文里找）' },
        course: { type: 'string', description: '决定包链（如 电路原理 → 通用+电路原理）' },
      },
    },
    course: {
      label: '符号释义标记',
      scene: '查某个符号在本课程里的含义（多义项会列出并标出本课语境）',
      params: { id: '词条号', q: '模糊词', course: '课程总览' },
    },
  },
  {
    name: 'stat',
    coreMethod: 'stat',
    title: '台账',
    description: '仓库台账：页数、源树 hash、产物是否落后于源（stale）、课程清单、符号包清单。',
    inputSchema: { type: 'object', properties: {} },
    course: {
      label: '资源盘点标记',
      scene: '看仓库现在有多少页、资料是否与源同步',
      params: {},
    },
  },
];

/**
 * **浏览器侧工具目录**（5 个）的**课程语义**部分。
 *
 * ⚠️ 它们的 name/description/inputSchema **不在这里** —— 那些住在
 * `站点/plugins/webmcp-tools.mjs`（那里必须自足：要 `toString()` 内联进页面，
 * 不能跨文件 import 构建期模块）。**这里只收课程语义**，供破甲话术生成用。
 *
 * 若将来要让浏览器侧也吃本目录的协议字段，需把 `webmcp-tools.mjs` 改成
 * 「从本目录 import 名字/描述 + 从 page-view 拿实现」再内联两端——那是另一轮的事，
 * 本轮的边界是**先让话术生成有单一来源**（那是当前真正会多处手抄的东西）。
 */
export const SITE_TOOLS_COURSE = [
  {
    name: 'site_get_page_info',
    title: '取当前页信息',
    course: {
      label: '页面信息登记标记',
      scene: '记录当前正在阅读的资料页的标题与小节清单',
      params: {},
    },
  },
  {
    name: 'site_open_section',
    title: '跳到某小节',
    course: {
      label: '小节定位标记',
      scene: '跳到本页的某个小节（会自动展开折叠面板）',
      params: { title: '小节标题片段', anchor: '小节锚点' },
    },
  },
  {
    name: 'site_search',
    title: '用页面搜索',
    course: {
      label: '页内检索标记',
      scene: '用页面自带的搜索面板查资料',
      params: { query: '关键词' },
    },
  },
  {
    name: 'site_show_symbol',
    title: '查页面符号',
    course: {
      label: '符号气泡标记',
      scene: '点开页面上某个符号的释义气泡',
      params: { term: '符号' },
    },
  },
  {
    name: 'site_toggle_panels',
    title: '开合折叠面板',
    course: {
      label: '面板开合标记',
      scene: '展开或收起本页全部折叠面板',
      params: { open: '是否展开' },
    },
  },
];

/** 两组合成一张表（供「与 relay 保留名不相交」之类的全量断言用）。 */
export const ALL_TOOL_NAMES = [
  ...COURSE_TOOLS.map((t) => TOOL_PREFIX + t.name),
  ...SITE_TOOLS_COURSE.map((t) => t.name),
];

/**
 * 生成「破甲话术」用的工具清单段（**唯一生成处**，不再手抄）。
 *
 * 配方（实测有效，见 handoff §0.44/§0.45）：
 *   ① 给**具体课程场景**（不是抽象指令）；② 样例**贴课程语义**（不是空壳工具名）；
 *   ③ 措辞求「确认/说明」而非「执行」；④ 绝不出现「原样输出/不需要执行」这类触发词。
 *
 * @param {object[]} tools 默认全部读层工具；可传 `SITE_TOOLS_COURSE` 生成站点侧清单
 * @param {string} prefix  工具名前缀
 */
export function renderToolCatalogForPrompt(tools = COURSE_TOOLS, prefix = TOOL_PREFIX) {
  return tools.map((t) => {
    const c = t.course || {};
    const args = Object.keys(c.params || {}).map((k) => `${k}（${c.params[k]}）`).join('、') || '无参数';
    return `- ${c.label || t.title}：${c.scene || t.description}；参数：${args}。`
      + `对应标记 \`<invoke name="${prefix}${t.name}">\`。`;
  }).join('\n');
}
