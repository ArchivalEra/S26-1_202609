# 17: 彻底退役能力胶囊与站内计算，重计算与图形交互外包隔壁 Octave 站

**What to build:** 彻底退役顶栏「能力胶囊」（资源包下载与计算笔记本弹窗）、OPFS 分块下载（Octave WASM / Pyodide / MathLive / 客户端 KaTeX）、页内公式编辑计算单元格（`.fcell`）及 `{:calc}` 站内求值链路，将计算与图形栈交由隔壁 Octave 站承担。

## 一、拟切除清单（能力胶囊、OPFS、MathLive 与站内求值耦合）

1. **核心模块与测试切除**：
   - 移除 `站点/plugins/capability-pack.mjs`、`站点/plugins/capability-pack.test.mjs`、`站点/plugins/pack-runtime.mjs`、`站点/plugins/pack-runtime-iife.test.mjs`、`站点/plugins/pack-capsule.test.mjs`、`站点/plugins/pack-fixes.test.mjs`、`站点/plugins/pack-popover.test.mjs`。
   - 移除 `站点/plugins/formula-cells.mjs`、`站点/plugins/formula-cells.test.mjs`、`站点/plugins/edit-state.test.mjs`、`站点/plugins/formula-editable.test.mjs`。
   - 移除 `站点/plugins/static-release.mjs`、`站点/plugins/static-release.test.mjs`、`站点/assets/mathlive/`（`mathlive-browser.min.js`、`LICENSE.txt`、`LICENSE-browser.txt`），同步移除 `.gitignore` 对应白名单行；若一并下线 `{:calc}` 构建转译，同步处置 `站点/math/to-octave.mjs`、`站点/plugins/to-octave.test.mjs` 与 `站点/plugins/calc-marker.test.mjs`（或保留纯静态跳转/复制出口并删去 WASM 计算注入）。
2. **构建装配（`站点/build.mjs`）**：
   - 移除顶栏 `#pack-capsule`（`#pack-toggle`、`#notebook-toggle`）、`#pack-popover`、`#notebook-popover` 模板 HTML 与 `pack-runtime.js` / `formula-cells.js` / `static-release.js` / `assets/math/{to-octave,parser,lexer,commands}.js` 的构建写出与引用。
   - 清理 `renderOneMath` 中的 `{:calc}` / `translateToOctave` / `data-octave-code` 注入，以及 `raw` 中 `{:calc}` 标记的剥除/外链降级处理（同步清理 `课程总览/` 残留的「站内 Octave 求值播放按钮」说明文案）。
3. **主题样式、路由与 WebMCP 读面**：
   - 清理 `站点/assets/theme/shirone-reader.css` 中 `.pack-capsule`、`.pack-popover`、`.notebook-popover`、`.fcell*` 全部样式，同步更新 `站点/plugins/accent-colors.test.mjs`（顶栏按钮收口为 `#palette-toggle` 与 `#search-toggle` 两组）。
   - 清理 `站点/assets/theme/shirone-reader.js` 中的 `.fcell-body` 适配逻辑与 `站点/plugins/spa-router.mjs` 中的 `window.__packCellsReset` 钩子。
   - 清理 `站点/plugins/webmcp-tools.mjs` 中 `.fcell` / `fcellResultOf` 读面逻辑及 `站点/plugins/webmcp-tools.test.mjs` 对应 `.fcell` 测例，同步更新 `README.md` 与 `站点/Skill.md` 中过时表述。

## 二、硬性保留边界（手术禁区）

- **符号与数学核心不动摇**：保留 `站点/symbols/` 深核心与四适配器、`站点/math/{lexer,parser,commands,ir,terms,render,index}.mjs`、`站点/assets/katex/`（build-time KaTeX 渲染）以及全站 `25369` 条公式零错误渲染与符号气泡。
- **WebMCP 与 `/machine/` 完整保留**：保留全部 `site_*` 工具、`webmcp-shim` / `webmcp-loader` / `webmcp-relay`、`站点/plugins/figures.mjs`、`/machine/`（含 `Birthright.html` 与 `/machine/symbols/`）及 `spa-router` 无刷新导航。
- **全闸门通过**：完成后必须通过 `(cd 站点 && npm run build && npm test && node --test math/math.test.mjs)`、`node --test ../工具/mcp-端点/test/{read-core,endpoint}.test.mjs`、`.githooks/check-markdown.py`、`FACTS.json` 刷新、`zreflect/registry.py --run commit` 与离线 `act`。

**Settling:** `python3 -c "import os;rm=['站点/plugins/capability-pack.mjs','站点/plugins/pack-runtime.mjs','站点/plugins/formula-cells.mjs','站点/plugins/static-release.mjs','站点/assets/mathlive/mathlive-browser.min.js'];keep=['站点/symbols/index.mjs','站点/plugins/webmcp-tools.mjs','站点/plugins/figures.mjs','站点/math/parser.mjs'];b=open('站点/build.mjs',encoding='utf-8').read();c=open('站点/assets/theme/shirone-reader.css',encoding='utf-8').read();sp=open('站点/plugins/spa-router.mjs',encoding='utf-8').read();bad=any(os.path.exists(p) for p in rm) or any(not os.path.isfile(p) for p in keep) or any(k in b for k in ('pack-capsule','pack-popover','notebook-popover','pack-runtime','formula-cells','static-release','data-octave-code')) or any(k in c for k in ('.pack-capsule','.pack-popover','.notebook-popover','.fcell')) or '__packCellsReset' in sp;raise SystemExit(1 if bad else 0)"` -- rc=0 => A (能力胶囊、OPFS、MathLive 与站内求值全栈已彻底切除且核心符号/阅读/WebMCP 保留完整); rc!=0 => B (能力胶囊或站内求值残留仍在或核心文件缺失)

**Status:** ready-for-human
