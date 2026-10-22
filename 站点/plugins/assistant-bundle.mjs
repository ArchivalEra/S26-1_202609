// assistant-bundle.mjs —— 把站点侧的助手协议栈打成一个浏览器可用的 IIFE（阶段二 T11）
//
// 为什么需要它：`站点/plugins/assistant/` 下是 ES module（互相 import），
// 而页面里的其他插件都是「构建期写盘的自包含 IIFE」（见 build.mjs 的
// `WEBMCP_TOOLS_JS` / `CHAT_JS` 模式）。浏览器不能直接跑裸 ESM 目录，
// 所以这里在构建期把它们拼成一个 IIFE——与 `build-user-script.mjs` 的
// inline 手法同源，但**方向相反**：那边是把 Node 模块塞进油猴脚本，
// 这边是把站点模块塞进页面。
//
// 产物暴露：`window.__assistantClient.createAssistantClient` ——
// 由 assistant-wire.mjs 消费（它也在同一个 bundle 里，末尾自己接线）。

import { readFileSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);

/** 去掉 `import ... from './xxx.mjs'` 与 `export ` 前缀（单文件 IIFE 内不需要）。 */
function inline(src) {
  return src
    // 别名 import（import { a as b }）→ var b = a;
    .replace(/^import \{\s*([\w$]+)\s+as\s+([\w$]+)\s*\}\s*from\s*'[^']*';?$/gm, 'var $2 = $1;')
    // 普通名字 import（import { a, b }）→ var a = a; 不行，会自引用。
    // 改为：先记录名字，靠同一作用域内的后续声明天然可见（IIFE 内都是 var/function 提升）。
    // 所以这里直接删掉整行即可。
    .replace(/^import \{[^}]*\}\s*from\s*'[^']*';?$/gm, '')
    .replace(/^import \* as ([\w$]+)\s+from\s*'[^']*';?$/gm, 'var $1 = {};')
    .replace(/^import[^\n]*\n/gm, '')
    .replace(/^export \{[^}]*\};?$/gm, '')
    .replace(/^export async function/gm, 'async function')
    .replace(/^export function/gm, 'function')
    .replace(/^export const/gm, 'const')
    .replace(/^export let/gm, 'let')
    .replace(/^export default /gm, '');
}

/**
 * 组装 bundle 源码。
 * @param {string} siteDir  站点根目录（含 plugins/）
 * @returns {string} 可直接写盘为 .js 的源码
 */
export function buildAssistantBundleJS(siteDir) {
  const dir = path.join(siteDir, 'plugins', 'assistant');
  // 顺序即依赖序：proto（底层）→ context → session → toolcycle → chatsvc → index → wire
  const files = [
    ['proto.mjs', null],
    ['context.mjs', null],
    ['session.mjs', null],
    ['toolcycle.mjs', null],
    ['chatsvc.mjs', null],
    ['index.mjs', null],
  ];
  const parts = files.map(([f]) => {
    const src = readFileSync(path.join(dir, f), 'utf8');
    return `// ─── ${f} ───\n${inline(src)}`;
  });

  // assistant-wire.mjs 在站点 plugins/ 下（不在 assistant/ 子目录）
  const wire = readFileSync(path.join(siteDir, 'plugins', 'assistant-wire.mjs'), 'utf8');
  parts.push(`// ─── assistant-wire.mjs ───\n${inline(wire)}`);

  return `(function () {
"use strict";
if (typeof window === "undefined") return;

${parts.join('\n\n')}

// ─── 对外暴露 + 自动接线（阶段二 T11）──────────────────────────
// 面板与工具都由页面自己拥有；插件只提供跨 origin 通道。
// 插件注入晚于站点脚本是常态（油猴 document-end），所以这里轮询等待。
window.__assistantClient = { createAssistantClient: createAssistantClient };

window.__assistantAutoWire = function () {
  return wireAssistant({
    win: window,
    createAssistantClient: createAssistantClient,
    runTool: function (name, args) {
      // webmcp-tools.js 在页面里暴露了 window.__mcpTools.runTool（若有）；
      // 没有（旧构建/未加载）就明确失败，不静默伪装成功。
      var t = window.__mcpTools;
      if (!t || typeof t.runTool !== "function") {
        return Promise.resolve({ ok: false, error: "页面没有工具执行器（__mcpTools.runTool 缺失）" });
      }
      return t.runTool(name, args);
    },
  });
};

// 立即尝试一次（插件可能已经在了）；没在就由调用方/轮询处理。
try { window.__assistantAutoWire(); } catch (e) { /* 不阻塞页面 */ }
})();`;
}
