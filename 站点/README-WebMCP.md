# 浏览器侧 WebMCP（页面与外部 Agent / MCP 客户端交互）

把**站点页面**的交互能力（跳小节、读内容、查符号、开合折叠、图片转码/截图）注册成 WebMCP 工具，经本机 relay 中继或页面 `modelContext` 接口提供给任意外部 Agent、小模型或 MCP 客户端。

与站点只读源文镜像 `/machine/`（`Birthright.html` → `.json`）的分工：

| | `/machine/`（只读源文镜像） | 本层（浏览器侧 WebMCP） |
| :--- | :--- | :--- |
| 给什么 | **内容**——渲染前原始 Markdown、TeX 与图片 URL | **交互与视图**——跳锚点、翻页、开合折叠、点符号气泡、Canvas 转码/截图 |
| 需要浏览器吗 | 不需要（纯 HTTP GET） | **需要**（动作发生在打开的页面上） |
| 面向模型的接入文档 | `machine/Birthright.html` | [`Skill.md`](./Skill.md)（线上 `/Skill.md`） |

## 怎么开

### 1. 浏览器侧（Firefox / Chromium）

Firefox 如启用原生 API，可在 `about:config` 设置：

```text
dom.modelcontext.enabled         = true
dom.modelcontext.testing.enabled = true
```

零配置浏览器也可以直接使用站点按需加载的 `@mcp-b/global` polyfill。

### 2. 页面侧

打开站点任意页，URL 加参数：

| 参数 | 作用 |
| :--- | :--- |
| `?relay=1` | 连本机 relay（**要中继就必须加**） |
| `?webmcp=1` | 强制加载 polyfill（公网环境调试用） |

也可持久化：`localStorage.setItem('webmcp_relay', 'on')`（同理 `webmcp`）；本机回环预览地址（`127.0.0.1` / `localhost`）默认启用 `wanted`。

### 3. 本机 relay（或零依赖 WS 转发器）

运行官方 relay（默认端口 `9333`）：

```bash
npx -y @mcp-b/webmcp-local-relay@latest
```

或者直接按 [`Skill.md`](./Skill.md) 中附带的零依赖 Node.js WebSocket 转发器示例启动，即可通过 HTTP/JSON 对接任意小模型。

## 十一个站点工具

| 工具 | 做什么 |
| :--- | :--- |
| `site_get_page_info` | 我在哪：标题、课程、URL、小节清单、当前高亮目录项、面板开合数、显示设置、阅读进度 |
| `site_read` | **读内容（Markdown）**：`what=page` 整页正文（支持 `offset`/`limit` 分页）/ `outline` 只列标题 / `section` 某一节 / `panel` 某折叠面板 / `symbols` 本页符号清单 |
| `site_index` | 站点目录树：`scope=course` 当前课 / `all` 全站（支持 `match` 过滤与 `paths` 控制路径） |
| `site_navigate` | 去别处：`to=section` 本页小节 / `link` 侧栏某页 / `page` 按路径 / `prev`/`next` / `home` / `back` / `top`/`bottom`（走 SPA 无刷新切换，不中断连接） |
| `site_search` | 找内容：`scope=site` 全站索引 / `scope=page` 页内查找（返回片段与所在小节） |
| `site_show_symbol` | 查符号：点开气泡，返回标题、简明释义、全部义项（当前语境标 `here`）与详情链接 |
| `site_panels` | 折叠面板：`action=open/close/toggle`，可用 `match` 只作用于标题匹配的那些 |
| `site_view` | 显示设置：`theme` 明暗 / `hue` 主题色相 / `sidebar` 侧栏开合 |
| `site_list_images` | **列本页图片**：下标、地址、格式、alt、尺寸、`uploadable`（本站多为 webp） |
| `site_image` | **转码**：把页面图用 canvas 转成 JPEG/PNG dataUrl，自动限宽限体积 |
| `site_capture_view` | 截图：整屏走宿主 `__siteCapture`；给 `selector`/`rect` 时走页面内区域截图 |

## 三种加载形态（`window.__webmcpMode`）

加载器**按需**决定是否加载 281 KB 的 polyfill：

| 形态 | 触发 | 行为 |
| :--- | :--- | :--- |
| `native-document` | 已有 `document.modelContext` | 直接注入 shim + tools，**不载 polyfill** |
| `polyfill+wanted` | 本机 loopback、`?relay=1`/`?webmcp=1` 或 `localStorage` | 载 polyfill → 注入 shim + tools |
| `absent` | 未触发 | **什么都不做**（普通读者零额外请求） |

## 三个模块

| 文件 | 职责 |
| :--- | :--- |
| `webmcp-loader.mjs` | 编排器：判形态 → （必要时）载 polyfill → **按顺序**注入 shim 与 tools，并提供 `WEBMCP_RELAY_JS` |
| `webmcp-shim.mjs` | **双注册**：同一 `execute` 同时进 `navigator` 与 `document` 两个注册表 |
| `webmcp-tools.mjs` | 十一个站点工具（走 DOM 与静态索引，与真人操作同源）与 `window.__mcpTools.runTool` |

## 两个实测踩到的坑（别再踩）

1. **vendor 的 `widget.html` 不能改名**。relay 的 `embed.js` 硬编码取同目录 `widget.html`；改名后 embed 静默不建 iframe。
2. **relay 连接器不能带 `defer`**。它要在解析期用 `document.write` 插入 `relay-embed.js` 以便 `document.currentScript.src` 有效。

## 测试

```bash
cd 站点 && node --test plugins/webmcp-shim.test.mjs plugins/webmcp-loader.test.mjs plugins/webmcp-tools.test.mjs
```
