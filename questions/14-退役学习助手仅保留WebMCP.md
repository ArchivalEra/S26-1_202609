# 14: 彻底退役学习助手，仅保留纯 WebMCP 与站点阅读接口

**What to build:** 移除站内已失效的「学习助手」面板、加密激活材料与旧油猴聊天桥依赖，仅保留纯静态阅读功能与浏览器侧 WebMCP 接口（`webmcp-tools` / `webmcp-shim` / `webmcp-loader` / `webmcp-relay`），完成与学习助手的全面切割。

## 一、拟切除清单（学习助手专属资产与耦合点）

1. **助手面板与聊天渲染插件**：移除 `站点/plugins/chat-panel.mjs`、`站点/plugins/chat-panel.test.mjs`、`站点/plugins/chat-render.mjs`、`站点/plugins/chat-render.test.mjs` 及 `.gitignore` 对应白名单行。
2. **构建装配与激活密钥**：清理 `站点/build.mjs` 中 `--assistant-secrets` 参数、`ASSISTANT_KEY` / `<html data-assistant-key>`、顶栏 `#assistant-toggle` 手形按钮、`chat-panel.css` / `chat-panel.js` 写盘与 HTML 注入，以及 `window.__mcpTools` 注释中的 `assistant-bundle.js` 引用。
3. **主题样式与顶栏测试**：清理 `站点/assets/theme/shirone-reader.css` 中 `.hand-btn*` 与 `#assistant-toggle` 规则，同步收敛 `站点/plugins/accent-colors.test.mjs` 为现存四个顶栏按钮（`#pack-toggle`、`#notebook-toggle`、`#palette-toggle`、`#search-toggle`）。
4. **部署流水线**：移除 `.github/workflows/deploy.yml` 中的 `Materialize assistant secrets` 步骤及 `--assistant-secrets` 构建分支。
5. **桥接与注释收口**：审查 `站点/plugins/page-bridge.mjs`（`127.0.0.1:9345` SSE 旧桥）与 `站点/plugins/webmcp-loader.mjs`（`resolveToken` / `9345` / `__webmcpEnable`），明确仅保留浏览器 WebMCP（`document.modelContext` + `navigator.modelContext` + `@mcp-b/webmcp-local-relay` `?relay=1`）或精简后无助手语义的中性桥，并清理 `spa-router.test.mjs` / `webmcp-loader.test.mjs` 中失效的「学习助手」表述。

## 二、硬性保留边界（手术禁区）

- 保留全部 `site_*` WebMCP 工具定义、`webmcp-shim` 双注册机制、`webmcp-loader` / `webmcp-relay` 按需加载与 `站点/assets/vendor/webmcp/`（`polyfill.iife.js`、`relay-embed.js`、`widget.html`）。
- 保留 `/machine/` 全站镜像产物、`spa-router` 的 `soft=true` 无刷新导航（防止切换页面断开 WebMCP 连接）、能力包（KaTeX / MathLive / Octave）及全部课程页面。
- 完成后必须通过 `(cd 站点 && node build.mjs && node --test plugins/)`、`.githooks/check-markdown.py`、`zreflect/registry.py --run commit` 与本地离线 `act`。

**Settling:** `python3 -c "import os;rm=['站点/plugins/chat-panel.mjs','站点/plugins/chat-panel.test.mjs','站点/plugins/chat-render.mjs','站点/plugins/chat-render.test.mjs'];keep=['站点/plugins/webmcp-tools.mjs','站点/plugins/webmcp-shim.mjs','站点/plugins/webmcp-loader.mjs','站点/assets/vendor/webmcp/widget.html'];b=open('站点/build.mjs',encoding='utf-8').read();c=open('站点/assets/theme/shirone-reader.css',encoding='utf-8').read();w=open('.github/workflows/deploy.yml',encoding='utf-8').read();bad=any(os.path.exists(p) for p in rm) or any(not os.path.isfile(p) for p in keep) or any(k in b for k in ('assistant-toggle','chat-panel','data-assistant-key','--assistant-secrets')) or ('assistant-toggle' in c or '.hand-btn' in c) or ('ASSISTANT_SECRETS' in w or '--assistant-secrets' in w);raise SystemExit(1 if bad else 0)"` -- rc=0 => A (学习助手全栈已彻底切除且浏览器 WebMCP 核心保留完整); rc!=0 => B (学习助手残留仍在或 WebMCP 核心文件缺失)

**Status:** resolved
