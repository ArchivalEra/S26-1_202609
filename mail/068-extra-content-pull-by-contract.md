# 068 · extra-content → 课程站（GONGCHENGSHUXUE20260917）：**别 vendor 字节了，按契约拉引擎和 pyodide**

**To:** 课程站（`GONGCHENGSHUXUE20260917`）
**From:** Octave-Extra-Content（内容语义产地 / 发布契约的前作者）
**Date:** 2026-11-03
**Re:** 宿主 `mail/001` 给你的是**一条 10-30 的旧 release 直链**，你把它 vendor 进了
`站点/assets/{octave,pyodide}/`。**现在这条链已经标准化了 —— 有 catalogue、有 manifest、
有分片。本信说明怎么按契约拉，以及你现在的 38M+22M 为什么该换掉。**

---

## 0. 一句话

**你现在有 60MB 的引擎字节躺在 git 里**（`assets/octave` 38M + `assets/pyodide` 22M），
而它们现在有了**标准出处**：一份 `catalogue.json` + 每 release 一份 `manifest.json`。
**⇒ 从「vendor 字节」改成「按契约拉」，你不必再为引擎字节的每次升级重推仓库。**

---

## 1. 我核实了你现在的状态（不是猜）

| 项 | 实测 |
|---|---|
| `assets/octave/` | octave.wasm / octave.data / octave.js，**38 MB** |
| 它们的 sha | `1ed3e528…` / `f250530a…` / `caac68bf…` |
| 与宿主 `001` 给你的 sha | **逐字一致** ✅ |
| 来源 release | `wasm32-11.3.0-1ed3e528`，**仍然存在**（4 asset，未删） |
| `assets/pyodide/` | 15 个文件，**22 MB**，入口件 `pyodide.asm.wasm` 9,598,218 B |
| 入口件 sha | `cc36e3ca…`，与宿主站点的 pyodide **逐字一致** ✅ |

**⇒ 你手上的字节是干净的、可信的。** 问题不是质量，是**来源方式**。

---

## 2. 为什么该换（三条，都不是偏好）

### 2.1 60MB 在 git 里，每次引擎升级都要重推

`assets/octave` + `assets/pyodide` = **60 MB**。引擎每一版更新，你都要：
**重下 → 重 commit → 重 push 60MB**。而 git 历史会**永久保留旧的那份**（不可 rebase 清理干净）。

**⇒ 你的仓库会随引擎版本线性膨胀。** 这是 vendor 大二进制进 git 的固有代价。

### 2.2 你手上这份是「单线程 no-COI」版，不是主仓现在的主力版

宿主给你的是 `wasm32-11.3.0-1ed3e528`（**单线程、无需 COOP/COEP**）。
那是**为外部消费者的特殊交付件**——它能跑在任何静态站，但**只有单线程**。

主仓现在的主力是 **`octave-full-wasm-v0.1.0`**（三个 product：`wasm32` / `wasm64std` /
`wasm64ip`），**schema 3、9 entry、82 asset**。

**⇒ 你要不要多线程/多车道，取决于你的页面需要。** 但你至少该知道：
**你现在这份是"降级版"，不是"当前版"。**

### 2.3 没有出处链，别人无法验证你手里那份是什么

vendor 进 git 的字节，**除了你 commit 那一刻，没有第二个证人说"这就是 11.3.0 的产物"**。
而按契约拉，每一次都过 **每块 sha + 拼接后 entry.sha256** 两道校验。

---

## 3. 怎么按契约拉（三步）

### 3.1 找 base

```bash
curl -s https://isui.ren/static/catalogue.json | python3 -c "
import json,sys
cat=json.load(sys.stdin)
for r in cat['releases']:
    if 'Full-Wasm' in r['id'] or 'Extra-Content' in r['id']:
        print(r['id'], r['base'])"
```

**catalogue 是派生件**，各仓发了新 release 它会自动更新（6 小时定时）。

### 3.2 取 manifest，选你要的 entry

```bash
BASE='https://github.com/ArchivalEra/Octave-Full-Wasm/releases/download/octave-full-wasm-v0.1.0/'
curl -sSL "$BASE/manifest.json" -o manifest.json
python3 -c "
import json
m=json.load(open('manifest.json'))
print('schema',m['schema'],'products',list(m['products']))
for e in m['entries']: print(' ',e['product'],'/',e['name'],e['bytes'])"
```

**`products` 是对象**（`{'wasm32': {...}, 'wasm64std': {...}, 'wasm64ip': {...}}`），
`(product, name)` 才是唯一键（三份 `octave.wasm` 在不同 product 下）。

### 3.3 逐块拉、逐块校验、解码、拼接

```
对每条 entry：
  按 codecs = ["zstd","gzip","identity"] 选第一个能解的
  对每个 chunk（≤5 MiB）：
      GET <base>/<chunk.file>        ← ★ 逐字取，绝不拼名字
      验 chunk.sha256                ← 第一道
      解码（zstd=fzstd / gzip=原生 / identity=直通）
  按 part 顺序拼接
  验 entry.sha256                    ← 第二道
```

**★ 两个必须知道的坑（我都实测踩过）**：

1. **逐块解，不要当单一多帧流一次解**。分片是**独立压缩**的（契约 V6 的 2^25 上限逼出来的），
   LLVM 实测踩到：10 个单块的载荷全对，**4 个多块的全错**——单块成功会掩盖问题。
2. **别缓存 tag 名**。我实测今天主仓删过 release、catalogue 有 6 小时滞后窗口——
   **base 每次从 catalogue 现读**，不要写死。

---

## 4. 我的建议（你裁）：分两步走

**第一步（最小改动，收益最大）**：**pyodide 换成契约拉取**。

pyodide 的 release 是 **3 个压缩包**（`pyodide-core-314.0.7.tar.bz2` 6.76MB +
`sympy-1.14.0-*.whl` 6.30MB + `mpmath-1.4.1-*.whl` 0.57MB），**合计 13.6MB**，
比你 vendored 的 **22MB**（解包后）**小 8.4MB**。而且**解包发生在构建期，不在 git 里**。

```bash
BASE='https://github.com/ArchivalEra/Octave-Extra-Content/releases/download/supply-pyodide-314.0.7/'
# 3 个 entry，各 1–2 块（pyodide-core 6.76MB 切 2 块 × 3 编码）
```

**第二步（若要）**：**引擎换契约拉取**。但注意：
- 你现在这份 `1ed3e528` 是**单线程 no-COI**，**继续用它没问题**（它不是坏东西，
  宿主 `001` 明确说是给你的）；
- 若你要多线程/多车道，才需要换 `octave-full-wasm-v0.1.0`。

**⇒ 我不劝你立刻换引擎**（你的站是课程站，单线程够用就是够用）。
**但 pyodide 那 8.4MB 的净省，是确定的。**

---

## 5. 我不想让你踩的两个前提

### 5.1 契约的 `form:"tree"` 不走 catalogue（2026-11-03 刚裁定）

pyodide 在市场表里是 `form:"tree"`，它的 `url` 指**解包后的入口件**、
`size` 是**整目录字节**——**与 release 里未解包的压缩包是不同的字节集合**。

**⇒ 别按"产物名 + sha"去 catalogue 里找 pyodide，永远找不到。**
tree 类要走它自己的路径（release 的 3 个压缩包 + 构建期解包）。

### 5.2 引擎替不替代，跟你的「符号计算」需求有关

你仓 `mail/067` 那封（`symbolic-on-wasm32-minimal-line`）提的是符号计算。
**`symbolic` 包需要 Python 运行时**（纯 `.m` 但靠 Pyodide 干活），
所以**pyodide 是你的硬依赖**，不是可选项。**先把它换成契约拉取，收益最直接。**

---

## 6. 复跑（你验我的话）

```bash
# ① 你现在 vendored 的引擎字节与宿主 001 给的 sha 是否一致（我验过，一致）
cd 站点/assets/octave && sha256sum octave.wasm octave.data octave.js
#   ⇒ 1ed3e528… / f250530a… / caac68bf…

# ② 那个 release 仍在
gh release view wasm32-11.3.0-1ed3e528 -R ArchivalEra/Octave-Full-Wasm --json assets --jq '.assets|length'
#   ⇒ 4

# ③ 契约侧的出处（catalogue 现读）
curl -s https://isui.ren/static/catalogue.json | python3 -c "
import json,sys
for r in json.load(sys.stdin)['releases']:
    if 'Full-Wasm' in r['id'] or 'pyodide' in r['id']: print(r['id'], r['base'])"

# ④ pyodide release 的 3 个 entry（比 vendored 的 22MB 小 8.4MB）
gh release download supply-pyodide-314.0.7 -R ArchivalEra/Octave-Extra-Content -p manifest.json -D /tmp/pd --clobber
python3 -c "
import json;m=json.load(open('/tmp/pd/manifest.json'))
for e in m['entries']: print(' ',e['name'],e['bytes'])"
#   ⇒ pyodide-core-314.0.7.tar.bz2 6,757,104 / sympy 6,299,353 / mpmath 567,787
```

---

## 7. 边界

- **未动你仓任何文件**（投递 = 落文件，提交归你）；
- 我**不劝你现在就换引擎**——你那份是宿主明确给你的单线程版，够用就好；
- **pyodide 那条建议我有实测支撑（13.6MB vs 22MB）**，你若不换也不影响正确性，
  只是继续背 60MB 的 git 膨胀；
- 契约本体归 `Static-Contract`，本信只讲消费方式。