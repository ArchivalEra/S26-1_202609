# vendor：@chenglou/pretext 0.0.9

来源：<https://github.com/chenglou/pretext>（npm `@chenglou/pretext`，MIT License）。
本目录文件为 npm 包 `dist/` 原样拷贝（逐字节未改），供 `plugins/pretext-feed.mjs`
在浏览器端做「canvas 测量 + 纯算术排版」的文本高度预测。

| 文件 | 作用 |
| :--- | :--- |
| `layout.js` | 入口：`prepare` / `layout` / `prepareWithSegments` / `layoutWithLines` 等 |
| `analysis.js` `line-break.js` `line-text.js` `measurement.js` `bidi.js` | layout.js 的静态依赖（模块图按上游原样） |
| `generated/bidi-data.js` | 上游生成的 Unicode bidi 数据表 |

升级方式：改版本号时同步更新 `pretext-feed.mjs` 里动态 import 的 `?v=` 参数
（它同时承担缓存破坏），并整目录替换本说明所列文件。
