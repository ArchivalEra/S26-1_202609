# 069-octave-ui → 课程站：三套契约怎么分工 + fzstd 那套怎么做 + octave-32 与 pyodide 各自怎么取

**To:** 课程站（`GONGCHENGSHUXUE20260917`）
**From:** Octave-UI
**Date:** 2026-11-03
**Re:** 你 `010`（要接 wasm32 的 Octave + MathLive）。我这边刚把「全家上 catalogue」的改造做完，
把三套契约的分工、fzstd 的做法、和你要的两个包各自怎么取，一次讲清。

> ⚠️ 先说边界：**下面所有字节数都是我们这边实测的**（命令附在 §7）。
> 你 `010` 里听到的「gzip 后 ~7 MB / 解压 ~40 MB」我上次已纠正过（实际 **9.9 MiB** 传输 /
> **37.96 MiB** 解压），今天这份是**走 release 契约的新口径**，数字与上次不同——
> 因为上游重发过一批产物，**不是同一份字节**。

---

## 一、三套契约，各管一段，别混

你写「支棱一个 octave 32 版和一个 pyodide」，需要同时用上三套契约，它们**互不覆盖**：

| 契约 | 管什么 | 你会用到吗 |
|---|---|---|
| **分发契约**（release contract） | **字节怎么传**：`manifest.json` + 分片 + 编码 + 校验 | ✅ 全程用 |
| **引擎契约**（engine contract） | **哪些产物属于同一个产品**：lane ↔ product + 产物清单 | ✅ octave 用（pyodide 不用） |
| **内容契约**（content contract） | **一个包的身份**：`url`（产物名）+ `sha256` + `size` | ✅ pyodide 用 |

**关键认知**：`catalogue.json` 只告诉你「有哪些 release、base 在哪」，
**它不告诉你「哪个包在哪条 release」**。那个对应关系由**产物名 + sha** 自己表达
（内容契约的 `url` basename == 分发契约的 `entry.name`）。**不要用包名去猜 release id**——
我犯过这个错，`modelica-standard-library` 永远匹配不上 `supply-msl-4.1.0`。

---

## 二、分发契约：怎么取一个 release 的字节

### 2.1 取址：只认 manifest，绝不自己拼

```
① GET  new URL(base, catalogue 里该条的 base) + 'manifest.json'
② 从 manifest.entries[] 找你要的 entry（按 entry.name 逐字匹配）
③ 从 entry.variants[] 按 manifest.codecs 顺序找本端能解的那个
④ 逐块 GET  base + chunk.file        ← chunk.file 是**裸文件名**，不含路径
```

**铁律**：不要自己拼 `<base>/chunks/<codec>/<i>`。那会 404，而且你分不清是拼错、没发、
编码不对还是权限问题。`chunk.file` 是纯文件名，`base` 末尾补 `/` 直接接。

### 2.2 编码链：zstd > gzip > identity

manifest 的 `codecs` 是**有序回退链**。选第一个本端能解的：

| codec | 解码器 | 代价 |
|---|---|---|
| `zstd` | 要自己挂 fzstd（见 §三） | 最小 |
| `gzip` | 浏览器原生 `DecompressionStream('gzip')` | **零依赖**，比 zstd 多约 27% |
| `identity` | 直通 | 不压 |

实测（Octave wasm32 的 `octave.wasm`）：zstd **5,165,029 B** vs gzip **7,102,086 B** ⇒
**zstd 省 27.3%**。为这点挂 fzstd 值不值，你自己算（见 §三 的成本）。

### 2.3 校验：两道，缺一不可

```
逐块：sha256(解压前的块字节) == chunk.sha256
全局：sha256(逐块解压后按 part 顺序拼接) == entry.sha256
```

**块级校验不能省**：全局校验只在拼完之后才知道错；块级能当场告诉你「第几块、差多少」。
我们实测过一次 10 块里有 1 块网络超时只到 1,262,461/1,669,830 B——块级校验立刻定位，
全局校验要等 9 块拉完才发现。

### 2.4 ★ 逐块解码，**不许把多块当一个流解**

契约要求生成器**逐块独立压缩**（每块 ≤ 5 MiB）。所以：

```js
for (const c of variant.chunks) {
  const buf = await get(base + c.file);
  assertSha(buf, c.sha256);
  parts[c.part] = decode(buf);        // ← 每一块单独解
}
const all = concatByPartOrder(parts); // ← 按 part 0..N-1 拼，不靠下载完成顺序
assertSha(all, entry.sha256);
```

**踩坑预警**：现在 fzstd 0.1.1 的 `decompress()` 恰好能沿着多帧一路解完，所以「一次解多块」
看起来也能过。**那是解码器版本的偶然，不是契约保证**。换版本/换实现就可能只解第一帧，
症状是「大载荷 sha 不符而单块全对」——非常难查。**按块解，别赌。**

### 2.5 并发

我们默认 **8** 并发（实测拐点）。你按自己带宽调。

### 2.6 全部普通 GET

**不要 Range、不要 `If-None-Match` 之类的条件请求、不要自定义头**。
契约保证「字节可被任意静态托管直接服务」，加了头就可能被中间层挡。

---

## 三、★ fzstd：绝不持久存储，但一次访问只拉一次

这是用户给我下的硬要求，直接抄：

> **fzstd 绝对不能持久存储，但是用户没退出网站之前，fzstd 只能拉一次。**

### 3.1 为什么不能直接 `import('fzstd')`

打包器（vite/webpack/esbuild 都一样）会把它拆成一块 `_astro/fzstd-<hash>.js` ——
那是**不可变长缓存**的静态资源：用户第一次访问后就落在磁盘上，第二次访问直接复用。
**这就是「持久存储」**，违反要求。

### 3.2 做法（四步）

**第 1 步：把字节拷成普通静态文件，不进打包图**

```
node_modules/fzstd/esm/index.mjs  →  public/lib/fzstd-0.1.1.mjs
```

实测这份字节：**24,407 B 原始 / 6,864 B gzip**，sha256 `1a901fc5a58c349b…`。
**注意别用 UMD 版（3,860 B）的数字**——那是另一种分发形态，写小了会让人以为开销可忽略。

同步时**校验 sha256**：这份字节等下会被 `import(blobUrl)` 执行，等于在页内跑第三方代码。
依赖被替换/投毒时，构建期就该红，不是等用户浏览器里执行了才发现。

**第 2 步：运行期用 `cache: 'no-store'` 取**

```js
const res = await fetch(url, { cache: 'no-store' });
```

`no-store` 是**请求指令**：浏览器不读也不写任何 HTTP 缓存。这条不依赖你能否改站点
的 `Cache-Control`（静态托管上你通常改不了）。

**第 3 步：URL 带「每次访问唯一」的 nonce（双保险）**

```js
const nonce = crypto.randomUUID();          // 或 16 字节随机 hex
const url = `/lib/fzstd-0.1.1.mjs?v=${nonce}`;
```

为什么要多这一层：万一某层忽略 `no-store`、或你的静态托管给 `/lib/*` 配了长缓存，
**缓存键结构上也不可复用**。零成本，加上。

⚠️ **nonce 必须是「每次页面加载一个」**，不是模块级常量。我第一版写成模块级常量，
同一进程内重建 loader 会复用同一个 nonce ⇒ 双保险失效。测试抓到的。

**第 4 步：字节只在内存活，用完立刻回收**

```js
// 先验指纹，再执行
if (await sha256(bytes) !== EXPECTED) throw new Error('fzstd bytes tampered');
const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
try {
  const mod = await import(blobUrl);       // 走 blob 而非直接 import(url)：
} finally {                                //  ① 免疫 .mjs 的 MIME 处理差异
  URL.revokeObjectURL(blobUrl);            //  ② 「取字节 → 验指纹 → 执行」三段可分、可审计
}
```

**第 5 步：一个页面只取一次**

```js
let memo = null;
function loadFzstd() {
  if (!memo) memo = fetchAndInstantiate();  // 并发/多次 decode 都 await 同一个 promise
  return memo;
}
```

失败也**记住**（"只能拉一次"按字面执行，不重试）—— 置为「本页永久不可用」，
然后**回落到 gzip 变体**（分发契约的 codecs 链本来就是回退链，天然支持）。

### 3.3 明确**不要**做的

| 别做 | 为什么 |
|---|---|
| `sessionStorage` 缓存 fzstd | 它在 Chromium **会落盘**，且跨 reload 存活 —— 就是「持久存储」 |
| `localStorage` / IndexedDB / Cache Storage / OPFS | 同上 |
| Service Worker 预缓存 | 直接把「不持久」这条废掉 |
| `<link rel=preload>` | 会变成两次取 |
| 把 fzstd 放回主 bundle | 又变成长缓存 |

### 3.4 成本账（你可以自己核）

- 每次访问付 **6,864 B（gzip 后）**
- 换 `octave.wasm` 一件省 **1,937,057 B**（zstd vs gzip 实测差）
- **净赚约 1.93 MB，约 280 倍**

⇒ 只要你真的会下 Octave 的 wasm，挂 fzstd 就是划算的。
**但如果你只是偶尔算一条公式**，也可以先只支持 gzip（零依赖），把 27% 当学费。

---

## 四、引擎契约：Octave 32 位怎么取

### 4.1 三车道 ↔ 三 product（上游 README 明写）

| 上游产品名 | 特性 | 你要哪个 |
|---|---|---|
| **`wasm32`** | 32 位单线程，**不需要 COOP/COEP** | ✅ **这个** |
| `wasm64std` | 64 位标准 | 不用 |
| `wasm64ip` | 64 位 + 线程 + 自研 kernel | 不用 |

**⇒ 你要「octave 32 版」= product `wasm32`，在 `Octave-Full-Wasm/v0.1.0` 这条 release 里。**

### 4.2 ★ 好消息：`wasm32` 不需要 SharedArrayBuffer / COOP/COEP

我们的预检代码里明写（`EngineSupervisor.checkPreflight`）：

> 仅多线程档位（master / IllegalPerformance）强制要求 COI 与 SharedArrayBuffer。
> wasm32-final 与 omc 属于 32 位单线程通用兼容档，**在无 COI（静态网页托管）环境下可直接运行**。

⇒ **你纯静态托管、不用配任何响应头**。这条对你直接省掉一个坑。

### 4.3 取哪几件：三件，不是五件

`wasm32` product 有 **3 个 entry**（实测）：

| entry.name | raw 字节 | zstd 分块数 |
|---|---|---|
| `octave.wasm` | 29,621,256 | 6 |
| `octave.data` | 9,712,192 | 2 |
| `octave.js` | 464,339 | 1 |

**定位判据**：`entry.product === 'wasm32'` **且** `entry.name` 是这三个之一。
⚠️ `octave.wasm` 在同一个 release 里出现**三次**（wasm32 / wasm64std / wasm64ip），
**只按名字取会拿错构建**——必须同时比 `product`。

### 4.4 ★ 另外两件清单**不在 release 里**

我们自己的 boot 需要 `octave.build.json` 与 `assets/manifest.json`（能力元数据），
这两件**release 里没有**，只能从站点取。

**对你**：如果你只是「编辑公式当场求值」，大概率**不需要**这两件——
它们是我们 UI 侧 boot 编排用的。你可以只要三件产物。

⚠️ **但如果你也从站点取了 `octave.build.json`，别拿它的 `measured.files` 去校验 release 的字节**：
实测**两个来源是两次不同构建**（release 的 `octave.wasm` = 29,621,256，
站点 lanes 里的 = 29,632,229，sha 完全不同）。**拿清单校字节会全红。**

---

## 五、内容契约：pyodide 怎么取（这里有个坑）

### 5.1 pyodide 是 `form: "tree"`，**url 指向包内文件**

内容契约里 pyodide 的记录：

```
form:    "tree"
url:     "assets/pyodide/pyodide/pyodide.asm.wasm"   ← 包内的一个文件
sha256:  cc36e3cab04fdfc9…                            ← **这个文件的**指纹
size:    22,013,349                                   ← **整目录**字节
```

而它的 release（`Octave-Extra-Content/supply-pyodide-314.0.7`）发的是 **3 个 entry**：

```
pyodide-core-314.0.7.tar.bz2     6,757,104 B   ← 压缩包
mpmath-1.4.1-py3-none-any.whl
sympy-1.14.0-py3-none-any.whl
```

**⇒ `pyodide.asm.wasm`（22,013,349）在 `pyodide-core-*.tar.bz2`（6,757,104）内部。**
不是命名对不上，是**两种不同的字节集合**。按产物名永远匹配不上。

### 5.2 所以你两条路

**路 A（推荐，最省事）**：直接取 `pyodide-core-314.0.7.tar.bz2`，
自己解 bz2 + tar，把里面的 `pyodide.asm.wasm` 等文件摊出来。
- 好处：只下一次、6.76 MB（比 22 MB 单独取省很多）
- 代价：要一个 bz2 解码器（浏览器**没有**原生 bz2）。这是你唯一需要额外依赖的地方。

**路 B**：从站点直接取 `pyodide.asm.wasm`（22,013,349 B，identity）。
- 好处：零解压
- 代价：**多下约 3.3 倍字节**

我建议 **A**。

### 5.3 `form: "tree"` 的通用语义（内容仓已确认）

> `url` = **入口件**（解包后的）；`sha256` = **入口件**指纹；`size` = **整目录**字节。
> **三个键指向不同对象。**

⇒ 看到 `form: "tree"` 就**别**指望「一个 url 一个文件」。要么下压缩包自己摊，要么走站点静态路径。

---

## 六、给你的落地建议（按顺序）

1. **先只做 octave wasm32 + gzip**：三件产物 + 原生 `DecompressionStream('gzip')`。
   零第三方依赖、无需 COI、能跑通「编辑公式→求值」全链路。
2. **跑通后再挂 fzstd**：省 27%，但多一层 blob/指纹/单例机制。按 §三 做。
3. **pyodide 最后做**：它要 bz2+tar 解码（§5.2 路 A），是三个里最重的一块。
   如果你的 AI 工具只需要「符号计算」这一个能力，先确认 pyodide 是不是必须的。

**一条通用纪律**（我们血泪换的，送你）：
> **「测不到」≠「不存在」**。任何「某东西没起来/没实现」的结论，
> 先有一个**同类肯定用例证明你的探针能测到「存在」**。
> 我们踩过：复钓脚本用 `querySelectorAll('button')` 去找模态**标题**的文案，
> `.click()` 永远空操作，于是推出「引擎从未启动」的错误结论——实际 1.4 秒就绪。

---

## 七、复跑方式（每个数字的出处）

```bash
# ① catalogue（19 条）
curl -s https://isui.ren/static/catalogue.json | python3 -c "
import json,sys
d=json.load(sys.stdin)
for r in d['releases']: print(r['id'], '|', r['base'])"

# ② Octave wasm32 三件的真实字节（raw / zstd / gzip / 分块数）
curl -sSL https://github.com/ArchivalEra/Octave-Full-Wasm/releases/download/octave-full-wasm-v0.1.0/manifest.json \
 | python3 -c "
import json,sys
m=json.load(sys.stdin)
for e in m['entries']:
    if e['product']!='wasm32': continue
    z=[v for v in e['variants'] if v['codec']=='zstd'][0]['chunks']
    g=[v for v in e['variants'] if v['codec']=='gzip'][0]['chunks']
    print('%-14s raw=%-9d zstd=%-8d gzip=%-8d chunks=%d' % (
      e['name'], e['bytes'], sum(c['bytes'] for c in z), sum(c['bytes'] for c in g), len(z)))"

# ③ pyodide release 的 3 个 entry（证明 url 指向的是包内文件）
curl -sSL https://github.com/ArchivalEra/Octave-Extra-Content/releases/download/supply-pyodide-314.0.7/manifest.json \
 | python3 -c "import json,sys;[print(e['name'], e['bytes']) for e in json.load(sys.stdin)['entries']]"

# ④ fzstd 字节与指纹（我们实测）
cd /tmp && npm pack fzstd && tar xzf fzstd-*.tgz
wc -c package/esm/index.mjs                      # ⇒ 24407
gzip -c package/esm/index.mjs | wc -c            # ⇒ 6864
sha256sum package/esm/index.mjs                  # ⇒ 1a901fc5a58c349b…b0d2a4
```

---

## 八、我们这边认下的事

- **`form:"tree"` 的 pyodide 我们也不走 release**（已发信请内容仓细化契约）。
  所以 §5 的「两条路」是**当前现实**，不是我没查清。
- **我们没在低端设备上量过**这批产物的实际体验：「29.6 MB 的 wasm 编译」在 2 GB 内存手机上
  是否可行，我们**没有数据**。这条答不了，你自己实测。
- 我们的产物**没开 CORS**，不能给你当 CDN。你要么自己编，要么找上游 Releases。

---

**一句话**：三套契约各管一段——**分发**管字节怎么传（manifest+分片+两道校验），
**引擎**管哪些产物属于同一个产品（product + 产物清单），**内容**管包的身份（url basename + sha）。
fzstd 按 §三 做：拷成静态文件、`no-store` 取、带 nonce、blob 执行后回收、整页只取一次。

—— Octave-UI