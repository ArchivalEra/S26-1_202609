# 15: 重写 README（三种交互方式）与小模型通用 WebMCP Skill（含 WS 转发器示例）

**What to build:** 在学习助手退役后，重修 `站点/Skill.md`（从旧学习通口令升级为面向任意小模型的 WebMCP 交互规范 + 可运行 WebSocket 转发器示例）并重写 `README.md`，用简明结构交代仓库的三种核心交互方式并直链 `Skill.md`。

## 一、`站点/Skill.md` 重写要求（纯文本契约，构建直拷至 `/Skill.md`）

1. **移除旧学习通口令协议**：废弃原「写一行 `site_search，query=...`」等文本提示词格式，改为标准 JSON-RPC / WebSocket 工具交互说明。
2. **阐明浏览器侧 WebMCP 接入方式**：说明如何通过 `?relay=1`（或 `localStorage.webmcp_relay='on'`）配合 `@mcp-b/webmcp-local-relay`（默认 `ws://127.0.0.1:9333`）或直接读取 `window.__mcpTools` / `document.modelContext` 调用全套 `site_*` 工具，并附上精简准确的工具清单与参数摘要（适合小上下文模型一次读完）。
3. **内置可运行 WebSocket 转发器示例**：在 `Skill.md` 中直接附带一份极简、零冗余的本地 WS 转发器代码示例（实现 `widget.html` 握手 `hello` / `hello/accepted` / `tools/list` / `invoke` / `result` 或桥接给外部 HTTP/CLI 小模型），确保任意能力较弱的小模型照抄示例即可完成接管与工具调用。

## 二、`README.md` 重写要求（三种交互方式 + 门禁合规）

1. **清晰列出仓库的三种交互方式**：
   - **① 人类自己导航**：在线阅读站浏览器入口，涵盖顶栏全部控件说明（须满足 `.githooks/hook_lib.py` 的 `BUTTON_HINTS` 校验：导航/汉堡、调色盘/强调色、搜索、昼夜/深浅/深色、能力包/公式编辑/计算内核，不再提及已退役的学习助手）。
   - **② 机器直读 `/machine/`**：说明 `https://isui.ren/repo/S26-1_202609/machine/Birthright.html` 总树入口、`.html` → `machine/.../.json` 源文映射，以及大页面按小节拆片的 `_index.json` 用法。
   - **③ 客户端浏览器 WebMCP 接口**：说明通过浏览器打开站点并开启 WebMCP/Relay，同时给出直达 `Skill.md`（线上 `/repo/S26-1_202609/Skill.md` 及仓内相对路径）的醒目链接，方便直接喂给任何 Agent / 小模型。
2. **保留仓库既有真相源锚点**：完整保留 `<!-- COURSE-STATUS:START --> ... <!-- COURSE-STATUS:END -->`、`<!-- AUTO-CATALOG:START --> ... <!-- AUTO-CATALOG:END -->`、规则/维护导航与许可声明；若提及 `站点/README-WebMCP.md` 同步旧描述一并校准。

**Settling:** `python3 -c "r=open('README.md',encoding='utf-8').read();s=open('站点/Skill.md',encoding='utf-8').read();ok_r=('COURSE-STATUS:START' in r and 'AUTO-CATALOG:START' in r and '/machine/Birthright.html' in r and 'Skill.md' in r and '学习助手' not in r);ok_s=('site_search，query=' not in s and ('WebSocket' in s or 'ws://' in s) and chr(96)*3 in s and 'site_' in s and 'relay' in s.lower());raise SystemExit(0 if (ok_r and ok_s) else 1)"` -- rc=0 => A (README三种交互入口与Skill.md及WS转发器示例均已重写就绪); rc!=0 => B (README或Skill.md仍为旧版或缺少WS转发器/链接)

**Status:** ready-for-agent
