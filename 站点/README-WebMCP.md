# 浏览器侧 WebMCP（页面与浏览器内置 AI 交互）

把**站点页面**的交互能力（跳小节、开搜索、查符号、开合折叠）注册成 WebMCP 工具，
经本机 relay 中继给任意 MCP 客户端。

与 [`工具/mcp-端点/`](../工具/mcp-端点/README.md)（读层）的分工：

| | 读层（`工具/mcp-端点/`） | 本层（浏览器侧） |
| :--- | :--- | :--- |
| 给什么 | **内容**——搜全站、取正文、查符号 | **交互**——跳锚点、开搜索面板、点符号气泡、开合折叠 |
| 需要浏览器吗 | 不需要 | **需要**（动作发生在打开的页面上） |
| 前置 | `站点/dist/` 已构建 | 同上 + 浏览器开了 WebMCP + relay 在跑 |

## 怎么开

### 1. 浏览器侧（Firefox）

Firefox 自带 WebMCP，但默认关闭。`about:config` 设：

```
dom.modelcontext.enabled         = true
dom.modelcontext.testing.enabled = true
```

### 2. 页面侧

打开站点任意页，URL 加参数：

| 参数 | 作用 |
| :--- | :--- |
| `?relay=1` | 连本机 relay（**要中继就必须加**） |
| `?webmcp=1` | 强制加载 polyfill（调试用） |

也可以持久化：控制台执行 `localStorage.setItem('webmcp_relay','on')`（同理 `webmcp`）。

### 3. 本机 relay

```bash
npx -y @mcp-b/webmcp-local-relay@latest --widget-origin 'http://127.0.0.1:8899'
```

然后 MCP 客户端就能看到页面注册的工具。

## 十个站点工具

| 工具 | 做什么 |
| :--- | :--- |
| `site_get_page_info` | 我在哪：标题、课程、URL、小节清单、当前高亮目录项、面板开合数、显示设置、阅读进度 |
| `site_read` | **读内容（Markdown）**：`what=page` 整页正文 / `outline` 只列标题 / `section` 某一节 / `panel` 某折叠面板 / `symbols` 本页符号清单 |
| `site_navigate` | 去别处：`to=section` 本页小节 / `link` 侧栏某页 / `page` 按路径 / `prev`/`next` / `home` / `back` / `top`/`bottom` |
| `site_search` | 找内容：`scope=site` 全站索引 / `scope=page` 页内查找（返回片段与所在小节） |
| `site_show_symbol` | 查符号：点开气泡，返回标题、解释、全部义项（当前语境标 `is-here`）与「详细」链接 |
| `site_panels` | 折叠面板：`action=open/close/toggle`，可用 `match` 只作用于标题匹配的那些 |
| `site_view` | 显示设置：`theme` 明暗 / `hue` 主题色相 / `sidebar` 侧栏开合 |
| `site_list_images` | **列本页图片**：下标、地址、格式、alt、尺寸、`uploadable`（本站是 webp，学习通只收 jpg/png） |
| `site_image` | **转码**：把页面图（webp/jxl 都行）用 canvas 转成 JPEG/PNG dataUrl，自动限宽限体积 |
| `site_capture_view` | 截图：整屏走宿主 `__siteCapture`；给 `selector`/`rect` 时走页面内区域截图 |

### 图片链路（2026-10-19）

学习通只收 **jpg/png**，而本站配图是 **webp**。完整链路：

```
site_list_images  →  site_image（canvas 解码 webp → JPEG dataUrl）
                  →  工具会话的 upload 接缝（上传）
                  →  带图追问「图里有什么？」
```

`工具会话.mjs` 的 `upload` 接缝负责后两步；产品（`对话.mjs`）与实验（`续航器.mjs` 的 M7 臂）
都注入同一个 `mgr.uploadImage`。实测：模型自己列出 35 张 webp → 选第 1 张 → 转码 →
上传 → 准确描述出「24V 端口、上支路中点 B 标 3V、下支路中点 A 标 5V」。

## 四种加载形态（`window.__webmcpMode`）

加载器**按需**决定要不要付 polyfill 那 281 KB：

| 形态 | 触发 | 行为 |
| :--- | :--- | :--- |
| `native-document` | 已有 `document.modelContext`（Chrome 的 WebMCP 预览版） | 直接注入 shim + tools，**不载 polyfill** |
| `polyfill+shim` | 有 `navigator.modelContext`（Firefox 开了 pref） | 载 polyfill → 注入 shim + tools |
| `polyfill-forced` | `?webmcp=1` 或 `localStorage.webmcp='on'` | 同上（调试） |
| `absent` | 都没有且没强制 | **什么都不做**（与不带本模块时完全一致） |

## 三个模块

| 文件 | 职责 |
| :--- | :--- |
| `webmcp-loader.mjs` | 编排器：判形态 → （必要时）载 polyfill → **按顺序**注入 shim 与 tools |
| `webmcp-shim.mjs` | **双注册**：同一 `execute` 同时进 `navigator` 与 `document` 两个注册表 |
| `webmcp-tools.mjs` | 五个站点工具（走 DOM、与真人操作同一条路径） |

**顺序神圣**：shim 必须在**任何工具注册之前**包好两个注册表，否则抓不到已注册的工具。
所以由一个编排器统管，而不是三个并列 `<script>`。

## 两套注册表为什么要 shim

WebMCP 现在有**两套互不可见的注册表**（2026-10-15 实测，详见 `.zcode/需求书-浏览器内置AI与MCP端点.md` §3）：

| | 规范 / `@mcp-b` 生态 | Firefox 原生 |
| :--- | :--- | :--- |
| 全局 | `document.modelContext` | **`navigator.modelContext`** |
| `getTools()` | Promise | **同步数组** |
| 调用 | `executeTool` | **`invokeTool`** |

只经 `navigator` 注册的工具，relay（只认 `document` 那套）**一个也看不到**。
shim 让同一个工具对象同时进两个注册表——不桥接调用路径，简单且不依赖任何一方的内部实现。

## 两个实测踩到的坑（别再踩）

1. **vendor 的 `widget.html` 不能改名**。relay 的 `embed.js` **硬编码**去同目录取
   `widget.html`（`new URL("widget.html", 自身src)`）；改名后 embed **静默不建** widget iframe，
   relay 一个页面工具都看不到（实测：`relayIframe: 0`）。
2. **relay 连接器不能带 `defer`**。它要在**解析期**用 `document.write` 插入 embed.js——
   而 embed.js 靠 `document.currentScript.src` 定位 widget.html，动态 `createElement`
   注入时 `currentScript` 为 null，embed 直接 throw。`defer` 脚本执行时 `readyState` 已是
   `interactive`，`document.write` 会毁掉文档。所以它必须是普通同步脚本。

## 可拆卸

删掉三个 `站点/plugins/webmcp-*.mjs`、`站点/assets/vendor/webmcp/`、
`build.mjs` 里的 WebMCP 段与页面模板里的两行 `<script>` 即整体回退——
站点行为与不带本模块时完全一致。

## 测试

```bash
cd 站点 && node --test plugins/webmcp-shim.test.mjs    # 6 项（双注册契约）
```

浏览器端实测（端到端）：Firefox + relay，`tools/list` 应看到 5 个 `site_*` 工具，
`site_get_page_info` 返回标题与小节清单。
