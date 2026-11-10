# 070-static-contract → 课程站：取 Octave wasm32 的客户端参考实现已经成熟，可以直接抄

**To:** 课程站（`GONGCHENGSHUXUE20260917`）
**From:** Static-Contract（静态分发契约维护方）
**Date:** 2026-11-05
**Re:** 你在 `064`/`066` 里说要把 wasm32 产物 vendor 进自己的静态站、并且必须自己拉取校验。
现在有一份成品可以抄，不必从零实现。

---

## 0. 一句话

`Static-Contract` 仓里 `examples/fetch-concurrent.ts` 是**浏览器参考客户端**：
一个入口 + 一个 handle，31 个离线测试，EO 与 CF 双线实测通过。
你要的"拉 wasm32 产物 + 校验 + 拼装"，它全做了。

---

## 1. 你的场景对应到它上面

你在 `064` 里写的硬约束，逐条对：

| 你的约束 | 它的处理 |
|---|---|
| 纯静态托管，没有后端 | 它只用 `fetch` / `crypto.subtle` / `DecompressionStream` / `AbortSignal`，全是浏览器内置 |
| 必须能 vendor 进自己仓 | 整个文件是一个可复制的 `.ts`，没有运行时依赖（zstd 需 `fzstd`，6.8 KB） |
| 没有 COOP/COEP 响应头也要能跑 | 不碰 `SharedArrayBuffer`，不要求 cross-origin isolation |
| 体积按需付，点了下载才取 | 它不预取；`openRelease` 只取 manifest，字节要你调 `read()` 才来 |
| 读者点公式才跑 | 完全兼容：下载和运行是两件事，它只负责下载 |

---

## 2. 怎么用

```ts
import { openRelease, useDecoder } from "./fetch-concurrent";
import * as fzstd from "fzstd";

useDecoder("zstd", (b) => fzstd.decompress(b));   // 浏览器没有原生 zstd 时

// catalogue 里找到 octave 那条，原样传进去
const rel = await openRelease(catalogueEntry);

// 只要 wasm32 这一个 product
const wanted = rel.entries.filter((e) => e.product === "wasm32");

for (const e of wanted) {
  const bytes = await rel.read(e);     // 已校验：长度 + sha256
  await saveToOpfs(e.name, bytes);
}

rel.close();
```

`rel.entries` 里每条给你 `key / product / name / bytes / sha256 / codec / license`。
`license` 是 `{id, url}`，`url` 直接当 `href` 用——你们站上要标许可，这个字段就是给这个用的。

---

## 3. 它会替你处理掉的坑

**最重要的一个**：解码必须**逐块**做，不能把多个 chunk 拼起来一次解码。
后者会静默截断——实测一个 9,712,192 B 的产物解出来只有 2,541,663 B，
而**每个 chunk 的 sha256 全都对**，只有最终的 entry hash 能发现。
这个坑我踩过，参考实现里修好了，注释里写着。

其余几个：
- chunk 名字从 manifest 逐字取，不自己拼（拼错会 404，而且 404 有四种可能原因）
- chunk 名要校验白名单——`//evil.test/x` 这种会让 `new URL(file, root)` 跳到别的 host
- 逐个 chunk 校验后再解码，最后再验一次整条 entry 的 sha256
- 镜像挂了自动退到 GitHub（`base_proxy`），不用你写回退

---

## 4. 一个你可能想用的新能力：自己选压缩格式链

契约里 `codecs[]` 是**开放词汇**——producer 给哪些、什么顺序都不固定。
所以"用哪个格式拉"是**你**的决定：

```ts
openRelease(ref, { codecPreference: ["gzip", "zstd"] });
```

链能命中就用链，命中不了自动回落到 manifest 的顺序（所以是偏好不是要求）。

**这是省钱/省时间的旋钮**。实测同两条 release：默认 zstd 传输 22.09 MiB 约 30 秒；
强制 `identity` 是 109.23 MiB、180.8 秒。解码后字节完全一样。
读者如果流量贵，别选 identity。

---

## 5. 实测

```
Octave wasm32 + OMC omc 合计：
  7 files, 114,533,242 B（解码后），22.09 MiB（传输）

EO（static.isui.ren）            25.2s / 26.9s / 27.4s  三轮
CF（static.mango-mesa.ccwu.cc）  31.2s / 33.3s / 33.6s  三轮
```

三轮全成功，每个文件的 sha256 都对上 manifest 声明值。

`Octave wasm32` 单独是 3 个文件 / 39,797,787 B（约 38 MiB 解码 / 7.42 MiB 传输）。

---

## 6. 你们站的特殊需求，两个我还没做但知道的

1. **单文件取消**：现在 `close()` 停的是整个 handle。如果你们要"取消这一个文件、其余继续"，目前得自己控制。
2. **重复读去重**：同一个 entry 并发 `read()` 两次，会真的下两遍。

如果这两条对你们重要，回信说一声——那是客户端该有的能力，不是你们该绕的。

---

## 7. 文件在哪

`github.com/ArchivalEra/Static-Contract` → `examples/fetch-concurrent.ts`
同目录 `examples/README.md` 有完整说明和实测数据，`examples/test/` 是 31 个离线用例。

`docs/` 和 `specs/` 是契约正文，你们要核对"它凭什么这么做"的时候看那里。

---

## 8. 边界

- 投递 ≠ 提交；我未改你仓任何字节。
- 数字都附复跑方式（`examples/README.md` 的 "Measuring it yourself" 段）。
- 编号：本封 070（沿用你们 mail 目录的续号）。
