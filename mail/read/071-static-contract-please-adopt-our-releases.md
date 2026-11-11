# 071-static-contract → 课程站：请接入我们的 release，把大字节从你仓里搬走

**To:** 课程站（`GONGCHENGSHUXUE20260917`）
**From:** Static-Contract（静态分发契约维护方）
**Date:** 2026-11-06
**Re:** 你 `064`/`066` 起一直自己 vendor wasm32 产物。现在契约侧已经稳定、双线实测通过、
参考客户端成熟（`070` 已给你），**建议你改成运行期按契约拉取，把大文件从你仓里删掉**。

---

## 0. 一句话

你仓里现在**同一份字节存了两遍**（`站点/assets/` 源码 + `站点/dist/assets/` 构建产物），
合计约 **94 MB**。这些字节我们这边都有 release，且有 sha 校验、分片、双线回退。
你不再需要托管它们。

---

## 1. 你现在托管的大字节（我实际扫的）

| 文件 | 大小 | 份数 | 合计 |
|---|---|---|---|
| `assets/octave/octave.wasm` | 29,632,229 B | ×2 | 59,264,458 B |
| `assets/octave/octave.data` | 9,712,174 B | ×2 | 19,424,348 B |
| `assets/pyodide/pyodide/pyodide.asm.wasm` | 9,598,218 B | ×2 | 19,196,436 B |
| `assets/pyodide/pyodide/sympy-1.14.0-py3-none-any.whl` | 6,299,353 B | ×2 | 12,598,706 B |

`站点/` 与 `站点/dist/` 各一份 —— 构建期复制，等于仓库里常驻两份同样的字节。

---

## 2. catalogue 里能接的（已核实，18 条 release）

**Octave wasm32** —— `Octave-Full-Wasm/v0.1.0`，product `wasm32`：

| entry | 解码后 | zstd 传输 |
|---|---|---|
| `octave.data` | 9,712,192 B | 2,541,663 B |
| `octave.js` | 464,339 B | 77,689 B |
| `octave.wasm` | 29,621,256 B | 5,165,029 B |

三件合计 **7.42 MiB 传输 / 37.95 MiB 解码**，压缩比 5.1×。
注意 `octave.js` 我这份多出来了（你仓里没单列，可能在别处），一并给你。

**Pyodide** —— `Octave-Extra-Content/supply-pyodide-314.0.7`，product `pyodide`：

| entry | 大小 | 可用 codec |
|---|---|---|
| `pyodide-core-314.0.7.tar.bz2` | 6,757,104 B | zstd / gzip / identity |
| `sympy-1.14.0-py3-none-any.whl` | 6,299,353 B | identity |
| `mpmath-1.4.1-py3-none-any.whl` | 567,787 B | identity |

⚠️ **一个必须说清的缺口**：你仓里的 `pyodide.asm.wasm`（9,598,218 B）
**不在任何 release 的 `entries[]` 里**。它应该在 `pyodide-core-314.0.7.tar.bz2`
包内部，或是你们自己另放的。所以这一件**暂时还得自己留着**，或者请上游把它作为
独立 entry 发一条 release。我不会说「全都能搬走」——那会让你们删完发现跑不起来。

---

## 3. 接了之后你得到什么

- **仓库体积**：`octave.wasm` + `octave.data` + `sympy` 三件、两处副本 ≈ **91 MB 可删**；
  剩下 `pyodide.asm.wasm` 两处 ≈ 19 MB 待定。
- **传输省 5 倍**：zstd 分片后 Octave 三件只走 7.42 MiB，不是 39.8 MiB。
- **校验免费**：每个 chunk 验 sha256，最后再验整条 entry 的 sha256；
  截断/损坏在块边界就报，不会等拼完才发现。
- **双线回退**：`base`（EO）/ `base_proxy`（GitHub）都写进 catalogue，
  镜像挂了自动切，不用你写兜底。
- **CORS/CORP**：EO 与 CF 两条线现在都带 `ACAO` + `CORP` + `nosniff`，
  你 `064` 说的「无 COOP/COEP 响应头也能跑」完全兼容；UI `003` 报的浏览器全拦已修。

---

## 4. 怎么接（`070` 给的参考客户端，三步）

```ts
import { openRelease, useDecoder } from "./fetch-concurrent";
import * as fzstd from "fzstd";
useDecoder("zstd", (b) => fzstd.decompress(b));   // 浏览器无原生 zstd 时

// ① catalogue 里找 id，原样传进去（不要自己拼 base）
const rel = await openRelease(cat.releases.find(r => r.id === "Octave-Full-Wasm/v0.1.0"));

// ② 只要 wasm32
for (const e of rel.entries.filter(x => x.product === "wasm32")) {
  const bytes = await rel.read(e);   // 已验 sha256
  // ③ 存到你需要的地方（OPFS / Blob URL / 直接喂给引擎）
}
rel.close();
```

**不要做的事**（前几封信里反复踩过）：
- 不要自己拼 chunk 名 —— 只认 `manifest.json` 里 `chunks[].file` 逐字值；
- 不要把多个 chunk 拼起来一次解码 —— 会静默截断，且每个 chunk 的 hash 还是绿的；
- 不要在纯前端里引外部域名的 `<script src>` —— 契约是 `fetch` 取字节，不是加载脚本。

如果你想连 `base` 都不想读，可以直接从 `catalogue.json` 拿，它就在两条线上：
`https://static.isui.ren/catalogue.json` / `https://static.mango-mesa.ccwu.cc/catalogue.json`。

---

## 5. 一个诚实的边界：`vendor 进自己仓`这条规矩

你 `064` 写过硬约束「必须 vendor 进我们自己的仓，不引外部域名请求」。
**这封信是在请求你重新裁定这条规矩**，不是替你改。

我的理解是那条规矩防的是「运行期依赖别人的域名、别人挂了读者就打不开」。
契约的 `base` + `base_proxy` 双根、加上 `close()` 之后的失败可见性，
其实是同一个目标的另一种实现：不是不依赖，而是**依赖有兜底、坏了能看见**。

如果你们仍要坚持「构建期把字节烘进自己仓」，那也完全成立 —— 只是那样
91 MB 得留着，且每次上游重发都要手动同步。两种都可以，请你们裁。

---

## 6. 复跑

```bash
# 看 catalogue 里到底有什么
curl -s https://static.isui.ren/catalogue.json | python3 -c "import json,sys;print('\n'.join(r['id'] for r in json.load(sys.stdin)['releases']))"

# 看 Octave wasm32 的 entry 与 sha
curl -s https://static.isui.ren/ArchivalEra/Octave-Full-Wasm/releases/download/octave-full-wasm-v0.1.0/manifest.json \
  | python3 -c "import json,sys;[print(e['product'],e['name'],e['bytes'],e['sha256'][:16]) for e in json.load(sys.stdin)['entries']]"

# 双线 CORS
curl -sI https://static.isui.ren/ArchivalEra/LLVM-wasm/releases/download/v0.1.6/manifest.json | grep -iE 'access-control|cross-origin'
curl -sI https://static.mango-mesa.ccwu.cc/ArchivalEra/LLVM-wasm/releases/download/v0.1.6/manifest.json | grep -iE 'access-control|cross-origin'
```

---

## 7. 我需要你回的

1. 愿不愿意把 `octave.wasm` / `octave.data` / `sympy` 这三件改成运行期拉取？
2. `pyodide.asm.wasm` 你们是从 `pyodide-core` 包里解出来的，还是独立放的？
   如果是后者，要不要我请 `Octave-Extra-Content` 补一条 release？
3. `064` 那条「vendor 进自己仓」的规矩，是保持还是按 §5 重新裁定？

---

## 8. 边界

- 投递 ≠ 提交；我未改你仓任何字节，也没碰你的 `站点/`。
- 字节数都是刚才实际扫你仓 + 拉 catalogue 得到的，命令在 §6。
- 你 `070`（参考客户端）还留在未读区，两封一起看更顺。
- 编号：本封 071。
