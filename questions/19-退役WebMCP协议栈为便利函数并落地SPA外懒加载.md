# 19: 退役 WebMCP 协议栈为纯便利函数并落地 SPA 外懒加载

**Status:** resolved

**Settling:** `python3 -c "import os;rm=['站点/assets/vendor/webmcp','站点/plugins/webmcp-loader.mjs','站点/plugins/webmcp-shim.mjs','站点/plugins/webmcp-tools.mjs','站点/plugins/webmcp-tools.test.mjs','站点/Skill.md','站点/README-WebMCP.md'];keep=['站点/plugins/site-helpers.mjs','站点/plugins/site-helpers.test.mjs'];es=open('站点/eslint.config.mjs',encoding='utf-8').read();rm_ok=not any(os.path.exists(p) for p in rm) and all(os.path.isfile(p) for p in keep) and 'assets/vendor' not in es;rd=open('README.md',encoding='utf-8').read();rd_ok=('search/index.json' in rd and 'sym-glossary-json' in rd and 'Birthright.html' in rd and 'webmcp-local-relay' not in rd and 'Skill.md' not in rd);idx=open('站点/dist/index.html',encoding='utf-8').read() if os.path.isfile('站点/dist/index.html') else '';idx_ok=bool(idx) and 'brand.webp' in idx and 'webmcp-' not in idx and 'katex.min.css' not in idx and 'figures.css' not in idx and 'nav-structure-json' not in idx;raise SystemExit(0 if (rm_ok and rd_ok and idx_ok) else 1)"` -- rc=0 => A (WebMCP协议栈已退役为site-helpers便利函数、README已改为静态接口清单且首页懒加载与外置导航已生效); rc!=0 => B (WebMCP残留仍在、README未更新或首页懒加载未落地)

**What to build:** 将原 WebMCP 浏览器协议栈（`@mcp-b/*` vendor、`modelContext` shim、relay 与 `Skill.md`）退役，保留核心工具逻辑重命名为无副作用便利函数 `site-helpers.mjs`；`README.md` 改写为站点搜索 / 页内符号 / 站点索引静态接口说明；同步完成首页与页面的 SPA 外懒加载优化（消除 8 秒首屏加载阻塞与 130 KB 重复导航冗余）。

## 一、退役 WebMCP 协议栈，重命名为便利函数 `site-helpers.mjs`

1. **移除外部 vendor 与协议胶水**：
   - 删除 `站点/assets/vendor/webmcp/`（`polyfill.iife.js`、`relay-embed.js`、`widget.html`、`README.md`）、`站点/plugins/webmcp-loader.mjs`、`站点/plugins/webmcp-loader.test.mjs`、`站点/plugins/webmcp-shim.mjs`、`站点/plugins/webmcp-shim.test.mjs`、`站点/Skill.md`、`站点/README-WebMCP.md`。
   - 同步清理 `.gitignore` 对应白名单行，并在 `站点/eslint.config.mjs` 移除 `'assets/vendor/**'` 忽略项（实现 `站点/` ESLint 零外部目录豁免）。
2. **重命名保留便利函数与测试夹具**：
   - 将 `站点/plugins/webmcp-tools.mjs` 与 `站点/plugins/webmcp-tools.test.mjs` 重命名为 `站点/plugins/site-helpers.mjs` 与 `站点/plugins/site-helpers.test.mjs`（同步更新 `.gitignore`、`站点/plugins/symbol-parity.test.mjs` 及 `站点/build.mjs` 引用）。
   - 移除向 `document.modelContext` / `navigator.modelContext` 自动注册的协议代码；正常页面加载**零字节下发**该模块，仅保留其纯辅助函数导出与 `window.__siteHelpers` 按需挂载能力（供测试、Playwright/WebBridge eval 或显式 `?helpers=1` 调试时加载）。

## 二、`README.md` 改写为站点静态/页内数据接口说明

保留 `COURSE-STATUS:START..END`、`AUTO-CATALOG:START..END`、`规则与维护` 与 `许可` 原段，将原第 3 节「客户端浏览器 WebMCP 接口」替换为简明机器可读接口说明：
1. **站点全站搜索接口**：`search/index.json`（页与小节总表、`buckets: 64`）、`search/g/<0..63>.json`（倒排桶索引）、`search/t/<id>.json`（单页纯文本分片）。
2. **每页符号查询接口**：页面内 `<script type="application/json" id="sym-glossary-json">`（本页 `env`、`ctx` 及全部 `terms` 多义项，SPA 切页同步更新）与 DOM 节点属性 `data-term="sym-..."`；全站符号总目录在 `machine/symbols/index.json`。
3. **站点目录与源文直读接口**：共享缓存 JSON `assets/nav-structure.json` / `assets/site-pages.json` 与 `/machine/Birthright.html`（`.html` → `machine/...json`）。

## 三、首页与页面 SPA 外懒加载

1. **图标减重**：将顶栏品牌图标与页签图标从 `brand.gif`（81 KB）/ `favicon.gif`（49 KB）切换为现成 `brand.webp`（5.9 KB）/ `favicon.webp`（3.9 KB）。
2. **按页条件注入**：仅含数学公式的页面引入 `katex.min.css`（首页等零公式页跳过 23.7 KB CSS 与 KaTeX 字体请求）；仅含 `:::figure` 的页面引入 `figures.css` / `figures.js`；仅含符号词条的页面引入 `symbols-bubble.js`。
3. **交互/空闲懒加载与去同步阻塞**：移除构建模板里的 `webmcp-loader.js` 与同步阻塞 `webmcp-relay.js`；`site-search.js` + `site-search.css` 延迟到点击/聚焦搜索或按 `/`、`Ctrl+K` 时再加载；`spa-router.js` 延迟到空闲或首次悬停站内链接时再加载；消除同步阻塞外链 `<script src="site-root.js">`。
4. **外置共享导航冗余**：将每页重复内联的 `#nav-structure-json`（42.5 KB）与 `#site-pages-json`（7.5 KB）外置为带内容哈希的静态 JSON 文件由浏览器缓存；`<aside>` 仅直出顶层与当前激活分支，折叠分支按需水合，并同步更新 `nav-structure.test.mjs`、`link-validity.test.mjs` 等相关测试。
