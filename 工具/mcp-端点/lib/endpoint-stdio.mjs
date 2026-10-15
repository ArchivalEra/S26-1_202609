/**
 * `Endpoint` 端口的 **stdio adapter**：MCP 的 stdio 传输（设计文档 §4 第 7 步）。
 *
 * ## 三条硬规矩（踩过才知道）
 * ① **换行分隔 JSON**，不是 LSP 的 `Content-Length` 分帧——MCP stdio 每行一个 JSON-RPC 消息。
 * ② **stdout 只写协议**：任何日志都必须走 stderr，否则污染帧、客户端解析失败。
 * ③ **握手顺序**：`initialize` → 客户端发 `notifications/initialized` → 之后才允许 `tools/list` / `tools/call`。
 *    未握手就调用，回 `-32002`。
 *
 * 协议错（`-32700/-32601/-32602`）与工具错（`isError`）**分开**：工具错不升级成协议错，否则断会话。
 */

import { createDirectEndpoint } from './endpoint-direct.mjs';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'course-read-layer', version: '0.1.0' };

/**
 * 起 stdio 服务。
 * @param {{ core:object, input?:NodeJS.ReadableStream, output?:NodeJS.WritableStream, log?:(s:string)=>void }} opts
 */
export function createStdioEndpoint(opts) {
  const core = opts.core;
  const input = opts.input || process.stdin;
  const output = opts.output || process.stdout;
  const log = opts.log || ((s) => process.stderr.write(s + '\n'));

  const direct = createDirectEndpoint(core);
  let initialized = false;

  const send = (msg) => { output.write(JSON.stringify(msg) + '\n'); };
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message, data) => send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

  async function handle(msg) {
    const { id, method, params } = msg;

    if (method === 'initialize') {
      initialized = true;
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
      return;
    }
    if (method === 'notifications/initialized') return; // 通知无回复
    if (method === 'ping') { reply(id, {}); return; }

    if (!initialized) { fail(id, -32002, '未握手：先发 initialize'); return; }

    if (method === 'tools/list') {
      reply(id, { tools: direct.list().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      return;
    }
    if (method === 'tools/call') {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      if (!name) { fail(id, -32602, 'tools/call 缺少 name'); return; }
      const r = await direct.call(name, args);
      // 工具错走 result.isError（**不升级成协议错**）
      reply(id, {
        content: r.content,
        ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}),
        ...(r.isError ? { isError: true } : {}),
      });
      return;
    }

    fail(id, -32601, `未知方法：${method}`);
  }

  /** 逐行读、逐行处理（换行分隔 JSON）。 */
  function listen() {
    let buf = '';
    input.setEncoding('utf-8');
    input.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { fail(null, -32700, 'JSON 解析失败'); continue; }
        Promise.resolve(handle(msg)).catch((e) => {
          log(`[error] ${e && e.stack ? e.stack : e}`);
          if (msg && msg.id != null) fail(msg.id, -32603, String(e && e.message || e));
        });
      }
    });
    log(`[course-read-layer] stdio 已就绪（协议 ${PROTOCOL_VERSION}）`);
    return { close() { try { input.destroy(); } catch { /* noop */ } } };
  }

  return { listen, list: () => direct.list(), call: (n, a) => direct.call(n, a) };
}
