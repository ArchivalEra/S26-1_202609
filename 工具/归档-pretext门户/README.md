# 归档：pretext 资料门户（试验）

**归档日期**：2026-09-19。**结论：试验成功、实用性不足，封存待用。**
卡片门户对「长文阅读型」学习仓库没有实际价值——它服务的是卡片流场景，
而本站首页的 AUTO-CATALOG 静态列表已经够用且零成本。之后若要做卡片式
首页/资料门户（课程多了以后），从这里整目录翻出即可。

## 这是什么

把 [@chenglou/pretext](https://github.com/chenglou/pretext)（MIT，0.0.9）
的「canvas 一次性测宽 + 纯算术排版」移植为本站插件，做预测式卡片流：
卡片高度全部由 `prepare()/layout()` 预测，**布局阶段零 offsetHeight、零 reflow**。

## 目录内容

| 文件 | 说明 |
| :--- | :--- |
| `pretext-feed.mjs` | 插件本体：`FEED_JS`（客户端 module 脚本）+ 纯函数（`distributeCards`/`columnCount`/`predictedHeight`，即 masonry 分配算法的可测规范） |
| `pretext-feed.test.mjs` | 9 项测试（node:test） |
| `vendor/` | @chenglou/pretext 0.0.9 完整 dist 模块图（逐字节上游原样），来源与升级方式见 `vendor/README.md` |

## 试验数据（Chromium 146 / Electron 41，1440×900 实测）

| 场景 | DOM 测量基线 | pretext 预测 |
| :--- | :--- | :--- |
| 25 卡 | 8.3ms | 59.6ms（含 prepare 冷启动） |
| 300 卡 | 76ms（随卡数线性增长） | **49.6ms（基本恒定）** |
| longtask | 0 | 0 |
| 预测误差 | — | ≤1 行（卡片自然高度，只影响分列不影响显示） |
| 300 卡页滚动 4 秒往返 | — | 105fps、0 longtask |

**诚实结论**：小规模下 DOM 测量反而更快；pretext 的价值在规模（成本恒定）
与 resize（只重跑 layout 热路径）。卡片少于几十张时不必用它。

## 复活步骤（当时接缝的全部清单）

1. `vendor/` 整目录拷回 `站点/assets/vendor/`。
2. `pretext-feed.mjs`/`pretext-feed.test.mjs` 拷回 `站点/plugins/`。
3. `build.mjs` 四处接缝：
   - 顶部 `import { FEED_JS } from './plugins/pretext-feed.mjs';`
   - copyDir 之后：`fs.writeFileSync(dist/assets/plugins/pretext-feed.js, FEED_JS)`
   - 元数据循环之后：`extractSnippet()` 函数 + `portalCards` 构建（按 course/category/title 排序，meta 字段 = 类别·状态·更新日期）
   - 页面循环里 `const feedSectionHtml = relPath === 'README.md' ? buildPortalSection() : '';`，模板 `${htmlContent}${feedSectionHtml}`，首页尾部 `<script type="module" src=".../pretext-feed.js?v=N">`
4. CSS 恢复 `.pretext-portal` / `.pretext-feed` / `.pretext-card` 样式块
   （与测量参数严格一致：snippet 14px/22px、title 16px/24px、卡片内边距 14、列 gap 12）。
5. `.gitignore` 逐文件白名单恢复。
6. 调试要点（当时踩的坑）：npm 包 dist 是**多文件模块图**（漏文件报含糊的
   「Failed to fetch」）；动态 import 挂 `?v=版本` 做缓存破坏，**顶层静态
   import 失败会静默**（禁用，用动态 import + try/catch 降级到静态列表）。
