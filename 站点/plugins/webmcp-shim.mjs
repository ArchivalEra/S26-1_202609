/**
 * WebMCP 双注册 shim —— 独立可拆卸模块。
 *
 * ## 它解决什么问题
 * WebMCP 在本仓要面对**两套注册表**（2026-10-15 实测，见 `.zcode/需求书-浏览器内置AI与MCP端点.md` §3）：
 *
 *   | | 规范 / `@mcp-b` 生态 | Firefox 原生 |
 *   | :--- | :--- | :--- |
 *   | 全局 | `document.modelContext` | **`navigator.modelContext`** |
 *   | `getTools()` | Promise | **同步数组** |
 *   | 调用 | `executeTool` | **`invokeTool`** |
 *
 * 两套**互不可见**：只经 `navigator` 注册的工具，中继（relay）一个也看不到。
 *
 * ## 解法：不桥接「调用」，只做「双注册」
 * 同一个 `execute` 闭包**同时**注册进两个注册表——两边各自调用时执行的都是同一份代码。
 * 这比桥接调用路径简单得多，且不依赖任何一方的内部实现。
 *
 * ## 为什么必须**最先加载**
 * shim 之前注册的工具抓不到（`execute` 闭包已经进了原生注册表、没经过我们的包装）。
 * 所以本脚本要排在业务脚本之前。
 *
 * ## 可拆卸
 * 删掉本文件、build.mjs 里的注入段、页面模板里的 `<script>` 即回退——
 * 页面行为与不带 WebMCP 时完全一致（本 shim 不做任何 UI）。
 */

/** 双注册 shim 的源码（构建期内联进页面，避免多一次请求）。 */
export const WEBMCP_SHIM_JS = `(function () {
"use strict";
var nav = (typeof navigator !== "undefined") ? navigator.modelContext : null;
var doc = (typeof document !== "undefined") ? document.modelContext : null;
if (!nav || !doc || nav === doc) return;   // 缺任一注册表、或本就同一个 → 什么都不做

var seen = Object.create(null);

function dual(self, other) {
  if (!self || typeof self.registerTool !== "function") return;
  var reg = self.registerTool.bind(self);
  var unreg = (typeof self.unregisterTool === "function") ? self.unregisterTool.bind(self) : null;

  self.registerTool = function (tool) {
    var name = tool && tool.name;
    return Promise.resolve(reg(tool)).then(function (r) {
      if (!name || seen[name]) return r;
      seen[name] = true;
      try { Promise.resolve(other.registerTool(tool)).catch(function () {}); } catch (e) {}
      return r;
    });
  };

  if (unreg) {
    self.unregisterTool = function (arg) {
      var name = (arg && arg.name) ? arg.name : arg;
      return Promise.resolve(unreg(arg)).then(function (r) {
        if (name && seen[name]) {
          delete seen[name];
          try { if (typeof other.unregisterTool === "function") Promise.resolve(other.unregisterTool(arg)).catch(function () {}); } catch (e) {}
        }
        return r;
      });
    };
  }
}

dual(nav, doc);
dual(doc, nav);
})();`;

/**
 * 可测试的核心逻辑：给定两个注册表（形状同 `navigator/document.modelContext`），
 * 返回包装后的对象。构建期只内联上面的字符串；测试直接调本函数验行为。
 *
 * @param {{registerTool:Function, unregisterTool?:Function}} self
 * @param {{registerTool:Function, unregisterTool?:Function}} other
 * @returns {{registerTool:Function, unregisterTool?:Function}}
 */
export function makeDual(self, other) {
  const seen = new Set();
  const reg = self.registerTool.bind(self);
  const unreg = typeof self.unregisterTool === 'function' ? self.unregisterTool.bind(self) : null;

  const out = {
    async registerTool(tool) {
      const name = tool && tool.name;
      const r = await reg(tool);
      if (name && !seen.has(name)) {
        seen.add(name);
        try { await other.registerTool(tool); } catch { /* 对方不接受也不影响本侧 */ }
      }
      return r;
    },
  };
  if (unreg) {
    out.unregisterTool = async (arg) => {
      const name = (arg && arg.name) ? arg.name : arg;
      const r = await unreg(arg);
      if (name && seen.has(name)) {
        seen.delete(name);
        try { if (typeof other.unregisterTool === 'function') await other.unregisterTool(arg); } catch { /* noop */ }
      }
      return r;
    };
  }
  return out;
}
