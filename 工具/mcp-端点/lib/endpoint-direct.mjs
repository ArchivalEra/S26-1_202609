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


// 工具目录（name / title / description / inputSchema / coreMethod）住在 tool-catalog.mjs ——
// **唯一真相源**（2026-10-16 候选 1）。本文件从前自己写一份 TOOL_DEFS、加一份 dispatch 改名表、
// stdio 那边再 map 一遍，改一处必漏四处；现在只剩「从目录取 + 派发到 core」。
import { COURSE_TOOLS, TOOL_PREFIX, RELAY_RESERVED } from './tool-catalog.mjs';

export { TOOL_PREFIX, RELAY_RESERVED };

/**
 * 建 Direct endpoint。
 * @param {object} core `createReadCore` 的产物
 */
export function createDirectEndpoint(core) {
  // 派发表**从目录派生**（每条自带 coreMethod）——不再手写改名表。
  const dispatch = {};
  for (const d of COURSE_TOOLS) {
    dispatch[d.name] = (a) => core[d.coreMethod](a);
  }

  return {
    list() {
      return COURSE_TOOLS.map((d) => ({
        name: TOOL_PREFIX + d.name,
        title: d.title,
        description: d.description,
        inputSchema: d.inputSchema,
        coreMethod: d.coreMethod,
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
