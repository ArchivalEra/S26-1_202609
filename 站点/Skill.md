# S26-1 课程知识库 · WebMCP 交互 Skill

本文件为纯文本契约，随构建原样发布至 `https://isui.ren/repo/S26-1_202609/Skill.md`，用于外部 Agent 或本地小模型接入本站点已有的浏览器 WebMCP 接口。

- 仅需读取原始 Markdown / LaTeX 正文，不需要操作浏览器页面：优先直读只读镜像入口 `https://isui.ren/repo/S26-1_202609/machine/Birthright.html`。
- 需要让浏览器页面翻页、跳转小节、展开折叠解答、点开符号气泡、按当前视图检索或转码/截图：接入本页的 WebMCP 工具。

---

## 一、如何接入已有的站点 WebMCP

站点页面内嵌了 `webmcp-loader.js`、`webmcp-shim.js`、`webmcp-tools.js` 与 `webmcp-relay.js`。

1. **开启 WebMCP 与 Relay 中继**：
   - 在本机回环预览地址（`127.0.0.1` / `localhost` / `[::1]`）打开时，工具会自动注册；公网地址需在 URL 加 `?relay=1`（或 `?webmcp=1`），或在浏览器控制台设置：

```js
localStorage.setItem("webmcp_relay", "on");
localStorage.setItem("webmcp", "on");
```

2. **两种连接路径**：
   - **标准 MCP 客户端**：运行 `@mcp-b/webmcp-local-relay`（默认监听 `ws://127.0.0.1:9333`，与页面内的 `assets/vendor/webmcp/widget.html` 握手），再由 MCP 客户端调用工具：

```bash
npx -y @mcp-b/webmcp-local-relay@latest
```

   - **页面内直接调试 / 浏览器自动化**：页面已将全部工具注册至 `document.modelContext`（并由 shim 同步到 `navigator.modelContext`），同时暴露统一执行入口：

```js
await window.__mcpTools.runTool("site_get_page_info", {});
```

---

## 二、已注册的 11 个站点工具

所有工具均走页面 DOM 或静态索引（`search/index.json`、`#nav-structure-json`、`#site-pages-json`），无后端接口。

### 1. 页面状态与目录

| 工具名 | 用途 | 参数 |
| :--- | :--- | :--- |
| `site_get_page_info` | 获取当前页标题、课程、URL、小节清单、高亮目录项、折叠计数、显示设置与阅读进度 | `{}` |
| `site_index` | 获取课程导航树（与侧边栏一致） | `scope`: `"course"`（默认）\| `"all"`；`match`: 过滤关键词；`paths`: `boolean`；`max`: `number` |

### 2. 检索、阅读与符号

| 工具名 | 用途 | 参数 |
| :--- | :--- | :--- |
| `site_search` | 检索全站索引或当前页正文 | `query`（**必填**）；`scope`: `"site"`（默认）\| `"page"` |
| `site_read` | 读取 Markdown 内容（`page` 默认前 30 行，可用 `offset`/`limit` 分页） | `what`: `"page"`\|`"outline"`\|`"section"`\|`"panel"`\|`"symbols"`；`query`；`limit`（默认 30，上限 400）；`offset`；`maxChars`；`includeCollapsed`；`links` |
| `site_show_symbol` | 点击本页符号气泡，返回简明释义、全部义项（`here` 标记当前语境）及详情链接 | `term`（**必填**，如 `"sym-U"` 或 `"U"`） |

### 3. 导航与界面控制

| 工具名 | 用途 | 参数 |
| :--- | :--- | :--- |
| `site_navigate` | 站内跳转（通过 SPA 路由切换，不整页刷新，保持 WebMCP 连接不断开） | `to`: `"section"`\|`"link"`\|`"page"`\|`"prev"`\|`"next"`\|`"home"`\|`"back"`\|`"top"`\|`"bottom"`；`query`；`anchor`；`path`；`hash` |
| `site_panels` | 批量开合折叠面板（解答 / 提示等） | `action`: `"open"`\|`"close"`\|`"toggle"`；`match`（可选标题匹配） |
| `site_view` | 调整明暗主题、主题色相与侧栏开关 | `theme`: `"light"`\|`"dark"`；`hue`: `0-360`；`sidebar`: `"open"`\|`"closed"`\|`"toggle"` |

### 4. 图片与版面截图

| 工具名 | 用途 | 参数 |
| :--- | :--- | :--- |
| `site_list_images` | 列出正文配图（`index`、`src`、`ext`、`alt`、`natural`、`box`、`uploadable`） | `includeIcons`: `boolean`；`max`: `number` |
| `site_image` | 用浏览器 Canvas 将页面配图转码并压缩为 JPEG/PNG dataURL（默认限宽 1400px、体积 120KB） | `index` 或 `src`；`format`: `"jpeg"`\|`"png"`；`quality`；`maxWidth`；`maxBytes` |
| `site_capture_view` | 截取元素或视口区域图片（`selector` 如 `".article-content"` 或 `rect`） | `selector`；`rect`；`format`: `"jpeg"`\|`"png"`；`quality`；`fullPage`；`reason` |

---

## 三、零依赖本地 WebSocket 转发器示例（对接 `widget.html`）

如果不想接完整 MCP 客户端，或者要把页面工具直接桥接给任意小模型 / CLI / HTTP 脚本，可直接运行下面这份零第三方依赖的 Node.js 脚本（Node 20+）。它实现页面内置 `assets/vendor/webmcp/widget.html` 的 WebSocket 握手协议（端口 `9333`），并同时在 `http://127.0.0.1:9334` 提供 `/tools` 与 `/invoke` HTTP 接口。

```js
// relay-forwarder.mjs —— 运行：node relay-forwarder.mjs
import http from 'node:http';
import crypto from 'node:crypto';

const WS_PORT = 9333;
const HTTP_PORT = 9334;
let activeTab = null; // { socket, tabId, url, title, tools, pending }

function sendFrame(socket, obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([head, payload]));
}

function attachWsDecoder(socket, onMessage) {
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2)); off = 10;
      }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      buf = buf.subarray(need);
      if (opcode === 0x8) { socket.end(); return; }
      if (opcode === 0x9) {
        socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
        continue;
      }
      if (opcode === 0x1) onMessage(payload.toString('utf8'));
    }
  });
}

// 1. WebSocket 服务：与页面内 widget.html 握手并接收工具清单 / 调用回执
const wsServer = http.createServer((_, res) => res.writeHead(426).end('Upgrade Required'));
wsServer.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  const protos = String(req.headers['sec-websocket-protocol'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const chosen = protos.includes('webmcp.v1') ? 'webmcp.v1' : (protos[0] || '');
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    ...(chosen ? [`Sec-WebSocket-Protocol: ${chosen}`] : []),
    '', '',
  ];
  socket.write(headers.join('\r\n'));

  const state = { socket, tabId: '', url: '', title: '', tools: [], pending: new Map() };
  sendFrame(socket, {
    type: 'server-hello', service: 'webmcp-local-relay', version: 1,
    host: '127.0.0.1', instanceId: 'local-forwarder', port: WS_PORT,
  });

  attachWsDecoder(socket, (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'hello') {
      state.tabId = msg.tabId; state.url = msg.url; state.title = msg.title;
      activeTab = state;
      sendFrame(socket, { type: 'hello/accepted' });
      console.log(`[ws] connected: ${msg.title} (${msg.url})`);
    } else if (msg.type === 'tools/list' || msg.type === 'tools/changed') {
      state.tools = Array.isArray(msg.tools) ? msg.tools : [];
      console.log(`[ws] tools (${state.tools.length}): ${state.tools.map((t) => t.name).join(', ')}`);
    } else if (msg.type === 'result' && state.pending.has(msg.callId)) {
      const { resolve, timer } = state.pending.get(msg.callId);
      clearTimeout(timer);
      state.pending.delete(msg.callId);
      resolve(msg.result);
    }
  });
  socket.on('close', () => { if (activeTab === state) activeTab = null; });
});
wsServer.listen(WS_PORT, '127.0.0.1', () => {
  console.log(`WebSocket relay listening on ws://127.0.0.1:${WS_PORT}`);
});

// 2. 本地 HTTP 转发接口：供小模型 / CLI 直接查询与调用
http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'GET' && req.url === '/tools') {
    if (!activeTab) return res.end(JSON.stringify({ connected: false, tools: [] }));
    return res.end(JSON.stringify({
      connected: true, tabId: activeTab.tabId, url: activeTab.url,
      title: activeTab.title, tools: activeTab.tools,
    }));
  }
  if (req.method === 'POST' && req.url === '/invoke') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      if (!activeTab) return res.writeHead(503).end(JSON.stringify({ error: 'no_active_tab' }));
      let data;
      try { data = JSON.parse(body || '{}'); } catch { return res.writeHead(400).end(JSON.stringify({ error: 'bad_json' })); }
      const callId = crypto.randomUUID();
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          activeTab?.pending.delete(callId);
          reject(new Error('timeout'));
        }, 30000);
        activeTab.pending.set(callId, { resolve, timer });
        sendFrame(activeTab.socket, {
          type: 'invoke', callId, toolName: data.toolName, args: data.args || {},
        });
      }).catch((e) => ({ isError: true, content: [{ type: 'text', text: e.message }] }));
      res.end(JSON.stringify(result));
    });
    return;
  }
  res.writeHead(404).end(JSON.stringify({ error: 'not_found' }));
}).listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`HTTP forwarder listening on http://127.0.0.1:${HTTP_PORT}`);
});
```

启动转发器并用带 `?relay=1` 的浏览器打开站点页面后，任意脚本或小模型即可直接调用：

```bash
# 查看已连接页面与 11 个工具清单
curl -s http://127.0.0.1:9334/tools

# 调用工具读取当前页大纲
curl -s -X POST http://127.0.0.1:9334/invoke \
  -H 'Content-Type: application/json' \
  -d '{"toolName":"site_read","args":{"what":"outline"}}'
```
