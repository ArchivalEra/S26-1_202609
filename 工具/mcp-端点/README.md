# MCP 读层（本地离线）

把本仓库的内容暴露成 **MCP 工具**，供任意 MCP 客户端（Claude Desktop、Cursor、ZCode…）调用。
**全离线、零依赖**（只用 Node 内置模块 + 仓内既有的零依赖纯函数）。

设计文档：`.zcode/MCP读层设计.md`（内部详版）、`.zcode/外审-MCP读层设计.md`（去标识外审版）。

## 怎么用

客户端配置：

```json
{
  "mcpServers": {
    "课程仓库": {
      "command": "node",
      "args": ["/绝对路径/工具/mcp-端点/server.mjs"]
    }
  }
}
```

命令行冒烟：

```bash
printf '%s\n%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"course_stat","arguments":{}}}' \
 | node 工具/mcp-端点/server.mjs
```

**前置**：`站点/dist/` 必须已构建（`cd 站点 && node build.mjs`）。产物缺失时只有搜索类工具不可用
（报 `index_not_built`），读页/查符号/台账**照常可用**。

## 五个工具

| 工具 | 一句话 |
| :--- | :--- |
| `course_ask` | **主路径**：搜全站 → 定位命中小节 → 取该小节正文，**一次调用**完成 |
| `course_search` | 只要命中列表（标题、小节锚点、摘要、命中次数、分数） |
| `course_read_page` | 取整页正文（来自**源 markdown**，保留 LaTeX 公式与 frontmatter） |
| `course_symbol` | 查符号词典（含多义项与当前课程语境标记） |
| `course_stat` | 台账：页数、源树 hash、**产物是否落后于源**（stale）、课程与符号包清单 |

工具名带 `course_` 前缀——避开浏览器侧 WebMCP relay 的固定管理工具（`webmcp_*`），
有测试断言两者不相交。

## 架构（端口与适配器）

```
MCP 客户端
   │ stdio JSON-RPC（换行分隔）
   ▼
endpoint-stdio.mjs ──┐  Endpoint 端口
   ▼                 │
read-core.mjs（深核心：零 fs、零 JSON-RPC）
   ├─ 检索核心.mjs        进程内：复用 站点/plugins/site-search.mjs 的纯函数
   ├─ 切块.mjs            纯函数：小节内按块选段（保公式、不切围栏）
   └── 被驱动端口
        SearchCorpus ← corpus-dist.mjs（读构建产物）
        Catalog      ← catalog-source.mjs（页面清单 + 源 markdown + 标题锚点）
        SymbolPacks  ← packs-source.mjs（符号词典）
```

| 文件 | 职责 |
| :--- | :--- |
| `server.mjs` | 入口：装配适配器、起 stdio |
| `lib/read-core.mjs` | 深核心：五个工具的行为 |
| `lib/检索核心.mjs` | 检索流程（与浏览器端**同一套纯函数**） |
| `lib/切块.mjs` | 切块：`buildCutIndex` / `planExcerpt`（纯函数） |
| `lib/corpus-dist.mjs` | 检索产物适配器 + stale 判定 |
| `lib/catalog-source.mjs` | 页面清单与源 markdown 适配器 + 锚点反推 |
| `lib/packs-source.mjs` | 符号词典适配器 |
| `lib/endpoint-direct.mjs` | 进程内传输（测试替身 + 库用） |
| `lib/endpoint-stdio.mjs` | stdio 传输（MCP） |
| `test/*.test.mjs` | 43 项测试 |

## 两条硬不变量（都有测试钉死）

1. **检索只有一份实现**：读层的检索结果与站内搜索面板**逐项一致**——
   `test/parity-browser.snapshot.json` 是浏览器端真实抓取的快照（17 条查询），
   `test/检索核心.test.mjs` 断言「前 12 条命中序列 + 总命中数」逐项相同。谁改了排序/折叠/打分，这条测试立刻红。

2. **正文保公式**：`ask` 在小节内选段时，**窗口两端切点的未闭合围栏栈必须逐元素相等**——
   一条等式同时保证 `$$` 公式、代码围栏、`<details>` 都不被切开。
   切点恒在行首；`:::collapse` 内嵌表格/公式整块进出。

## 坐标纪律（容易搞错的一处）

命中位置在**折叠文本坐标系**里（从构建后 HTML 抽取的纯文本，已剥 KaTeX、已 NFKC/小写折叠），
它**不是**源 markdown 偏移。所以：

- 命中位置**只用来定位小节**（`sectionForPosition`）；
- 小节内选段一律在**源 markdown** 上按块重选（`planExcerpt`）；
- `planExcerpt` 的**入参里没有命中位置**——误用在类型层就发生不了。

## 前置重构（构建期，2026-10-15）

为了让读层与构建期共用同一份定义，做了两处改动：

1. **`站点/页面清单.mjs`**：`TARGET_FILES`（114 条）从 `build.mjs` 抽出成独立模块——
   `build.mjs` 与读层共同 import。验收：抽完后构建产物 **502 个文件逐字节一致**。
2. **`站点/dist/search/index.json` 增加 `sourceHash`**：构建期对清单内每个源文件内容取 sha256 再整体取一次。
   读层靠它判 `stale`——**用内容 hash 而非 mtime**（`git checkout` 会改 mtime）。

## 测试

```bash
cd 工具/mcp-端点 && node --test test/*.test.mjs      # 43 项
cd 站点 && node --test plugins/*.test.mjs            # 106 项（读层改了 site-search，一并跑）
```

parity 快照的刷新（改了检索相关代码后）：用 in-app 浏览器对真实页面跑 `test/parity.mjs` 的查询集，
抓 `.search-hit` 的 href 与总命中数，写回 `test/parity-browser.snapshot.json`。
