# vendor：WebMCP 相关第三方资产（逐字节上游原样）

| 文件 | 来源 | 版本 |
| :--- | :--- | :--- |
| `polyfill.iife.js` | `@mcp-b/global` 的 `dist/index.iife.js` | 6.0.3 |
| `relay-embed.js` | `@mcp-b/webmcp-local-relay` 的 `dist/browser/embed.js` | 6.0.3 |
| `widget.html` | 同上 `dist/browser/widget.html`（**自包含**：脚本已内联，无需 `widget.js`） | 6.0.3 |

**升级方式**：`npm pack @mcp-b/global@<版本>` 与 `npm pack @mcp-b/webmcp-local-relay@<版本>`，
解包后把上述三个文件**逐字节覆盖**。relay 的 `embed.js` **硬编码**去同目录取 `widget.html`（`new URL("widget.html", 自身src)`）——
所以**文件名不能改**、且两者必须**同版本**一起换（上游明确要求 major 版本对齐）。
实测踩过：改名成 `relay-widget.html` 后 embed 静默不建 widget iframe，relay 一个页面工具都看不到。

**为什么 vendor 而不是 CDN**：本站是离线阅读站，运行时不发外网请求。

**注意**：polyfill 有 281 KB——**不要无条件每页加载**。它只在需要时动态 import
（见 `站点/plugins/webmcp-loader.mjs`）。
