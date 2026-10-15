/**
 * `Endpoint` 端口的 **Direct adapter**：进程内直调（设计文档 §3.2 的传输接缝）。
 *
 * 作用有二：
 *   ① 测试用——`StdioEndpoint` 的替身（同一份 `call()` 契约，不必起子进程）；
 *   ② 库用——脚本里直接 `call('search', {...})`，不经过 JSON-RPC。
 *
 * **工具名带 `course_` 前缀**（设计文档 §5.2）：避免与浏览器 relay 的固定管理工具
 * `webmcp_*` 重名；`TOOL_NAMES` 导出供「与 relay 已知名不相交」的测试用。
 */

export const TOOL_PREFIX = 'course_';

/** relay 的固定管理工具名（本站工具名不得与它们相撞）。 */
export const RELAY_RESERVED = [
  'webmcp_list_sources',
  'webmcp_list_tools',
  'webmcp_call_tool',
  'webmcp_open_page',
];

/** 四个工具 + stat 的定义（name/description/inputSchema）。 */
export const TOOL_DEFS = [
  {
    name: 'ask',
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
  },
  {
    name: 'search',
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
  },
  {
    name: 'read_page',
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
  },
  {
    name: 'symbol',
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
  },
  {
    name: 'stat',
    title: '台账',
    description: '仓库台账：页数、源树 hash、产物是否落后于源（stale）、课程清单、符号包清单。',
    inputSchema: { type: 'object', properties: {} },
  },
];

/**
 * 建 Direct endpoint。
 * @param {object} core `createReadCore` 的产物
 */
export function createDirectEndpoint(core) {
  const dispatch = {
    ask: (a) => core.ask(a),
    search: (a) => core.search(a),
    read_page: (a) => core.readPage(a),
    symbol: (a) => core.symbol(a),
    stat: () => core.stat(),
  };

  return {
    list() {
      return TOOL_DEFS.map((d) => ({
        name: TOOL_PREFIX + d.name,
        title: d.title,
        description: d.description,
        inputSchema: d.inputSchema,
      }));
    },
    async call(name, args) {
      const bare = name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
      const fn = dispatch[bare];
      if (!fn) {
        return { isError: true, code: 'unknown_tool', content: [{ type: 'text', text: `未知工具：${name}` }] };
      }
      try {
        const result = fn(args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }], structuredContent: result };
      } catch (e) {
        return {
          isError: true,
          code: e.code || 'internal',
          content: [{ type: 'text', text: `${e.code || 'error'}: ${e.message}` }],
        };
      }
    },
  };
}
