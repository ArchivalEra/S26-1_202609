# S26-1 站点浏览器便利函数（HELPERS）

本文件随构建原样发布到 `https://isui.ren/repo/S26-1_202609/HELPERS.md`，只说明当前页面按需加载的 `window.__siteHelpers`（实现见仓内 `站点/plugins/site-helpers.mjs`）。

- **只想直接读取源文（Markdown / TeX）**：不需要打开交互页或加载脚本，直接读取 [`Birthright.html`](https://isui.ren/repo/S26-1_202609/machine/Birthright.html)（任意 `.html` 页面对应 `machine/...json`）。
- **需要在浏览器页内检索、翻页、展开折叠解答、查符号或取图转码**：在页面加载 `?helpers=1`。

---

## 一、按需加载与全局入口（默认零负载）

1. **按需激活**：正常访问静态页面不加载 `site-helpers.js`（零字节下发）。在 URL 查询串加 `?helpers=1`（如 `https://isui.ren/repo/S26-1_202609/?helpers=1`），页面引导脚本按 `new URLSearchParams(location.search).get("helpers") === "1"` 注入 `assets/plugins/site-helpers.js`，挂载 `window.__siteHelpers`。
2. **SPA 切页保活**：调用 `site_navigate` 跨页（`to: "page"` / `"link"` / `"prev"` / `"next"` / `"home"`）走 `window.__spaRouter.navigate(..., { soft: true })` 软替换正文、目录与符号词典，不刷新 `document`，`window.__siteHelpers` 持续保留在内存中；若路由器缺失或结构非标准页，则拒绝跳转并报错，不强行整页重载。
3. **全局导出对象 `window.__siteHelpers`**：

```js
// 推荐入口：统一返回 { ok, value, feed?, error? }（恒 resolve）
const res = await window.__siteHelpers.runTool("site_get_page_info", {});
// call 与 runTool 等价
const nav = await window.__siteHelpers.call("site_navigate", { to: "page", path: "课程总览/工程数学/index.md" });
// 查看全部 11 个函数定义与 inputSchema
const defs = window.__siteHelpers.defs();
// 直接使用底层页面视图方法（pageInfo / readContent / siteIndex / navigate / ...）
const view = window.__siteHelpers.createPageView();
```

---

## 二、11 个 `site_*` 便利函数

所有函数均为纯客户端 DOM 与静态 JSON 操作（无后端服务）：

### 1. 页面状态与目录

| 函数名 | 用途 | 参数 |
| :--- | :--- | :--- |
| `site_get_page_info` | 返回当前页标题、课程、URL、`data-site-path`、hash、小节清单、当前 TOC、折叠开关统计、显示设置与滚动进度 | `{}` |
| `site_index` | 读取导航树（与侧栏一致，数据源 `assets/nav-structure.json`） | `scope`: `"course"`（默认）\| `"all"`；`match`: 过滤词；`paths`: `boolean`（返回完整路径）；`max`: `number`（默认 `course=60` / `all=140`） |

### 2. 检索、正文与符号

| 函数名 | 用途 | 参数 |
| :--- | :--- | :--- |
| `site_search` | 全站标题/小节索引检索（直读 `search/index.json`）或页内正文查找 | `query`（**必填**）；`scope`: `"site"`（默认）\| `"page"` |
| `site_read` | 按行分页读取本页 Markdown（默认每次 30 行） | `what`: `"page"`（默认）\| `"outline"` \| `"section"` \| `"panel"` \| `"symbols"`；`query`；`limit`（默认 30，上限 400）；`offset`（默认 0，从 `next_offset` 续读）；`maxChars`（默认 12000，上限 20000）；`includeCollapsed`；`links` |
| `site_show_symbol` | 直读页内 `#sym-glossary-json` 返回符号标题、释义、全部义项 `senses`（`here` 标出当前语境）及 `detailHref`；无 JSON 夹具时回退点击气泡 | `term`（**必填**，如 `"通用:sym-U"`、`"sym-U"` 或 `"U"`）；`popup`: `boolean`（可选，`true` 时同步点开页面视觉气泡） |

### 3. 导航与界面控制

| 函数名 | 用途 | 参数 |
| :--- | :--- | :--- |
| `site_navigate` | 站内跳转与滚屏（跨页校验 `assets/site-pages.json` / 侧栏清单，SPA 软切不中断 `__siteHelpers`） | `to`: `"section"`（默认）\| `"link"` \| `"page"` \| `"prev"` \| `"next"` \| `"home"` \| `"back"` \| `"top"` \| `"bottom"`；`query`；`anchor`；`path`；`hash` |
| `site_panels` | 展开、收起或切换折叠面板（解答 / 提示等） | `action`: `"open"` \| `"close"` \| `"toggle"`（默认）；`match`（可选标题匹配） |
| `site_view` | 设置明暗主题、主题色相与侧栏开关 | `theme`: `"light"` \| `"dark"`；`hue`: `0-360`；`sidebar`: `"open"` \| `"closed"` \| `"toggle"` |

### 4. 图片与版面截图

| 函数名 | 用途 | 参数 |
| :--- | :--- | :--- |
| `site_list_images` | 列出正文配图（`index`、`src`、`abs`、`ext`、`alt`、`natural`、`box`、`uploadable`） | `includeIcons`: `boolean`；`max`: `number`（默认 50） |
| `site_image` | 用浏览器 Canvas 将页面配图（含 webp/jxl）转为 JPEG/PNG dataURL（超体积自动降质量，最低 40） | `index` 或 `src`；`format`: `"jpeg"`（默认）\| `"png"`；`quality`（1–100，默认 82）；`maxWidth`（默认 1400）；`maxBytes`（默认 120000） |
| `site_capture_view` | 截取指定元素或视口区域图片（无宿主全屏权限时仍支持元素/区域截图） | `selector`（如 `".article-content"`）；`rect`；`format`；`quality`；`fullPage`；`reason` |

---

## 三、`runTool` 回执格式与静态只读数据文件

- **回执结构**：`runTool(name, args)` 返回 `{ ok, value, feed }`，其中 `feed` 为自描述纯文本摘要（单条硬限 950 字符，超长截断并提示用 `offset`/`limit` 续读；`site_index` 全局过长时压缩为课程级计数摘要）。
- **静态索引与源文直读接口**（无需注入 JS，可直接 `fetch`）：
  - `search/index.json`（全站页面、锚点与倒排配置，桶在 `search/g/<0..63>.json`，分片在 `search/t/<id>.json`）
  - `assets/nav-structure.json`（共享侧栏树）与 `assets/site-pages.json`（全站合法页面路径清单）
  - `machine/symbols/index.json`（全站符号目录与分包）及各 `.html` 对应的 `machine/...json`（大图分片见同目录 `_index.json`）
