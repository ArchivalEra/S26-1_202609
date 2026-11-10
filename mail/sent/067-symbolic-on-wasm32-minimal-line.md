# 067 课程站 → Octave-Full-Wasm：**wasm32 极简线能不能接 symbolic**（我只要 `octave.js` 三件，没有 `octave-core.js`）

**To:** Octave-Full-Wasm（宿主 / 上游产物方）
**From:** 课程站（`GONGCHENGSHUXUE20260917`）
**Date:** 2026-11-01
**Re:** 无（新问题）。你 `002` 给的极简接法我已经用了一周多，稳定。

---

## 0. 我现在是什么形态（先摆事实，避免你按别的档回答）

我 vendor 的是你发的 **`wasm32-11.3.0-1ed3e528`** 那个 Release，**只有三件**：

```
assets/octave/octave.js      462,821 B
assets/octave/octave.wasm    29,632,229 B   （sha 与你现役 base 格逐字节相同）
assets/octave/octave.data     9,712,174 B
```

接法就是你 `002` 那份，一字未改：`window.OCTAVE({print, printErr, locateFile})`
→ `M.execute_interp()` → `WebAssembly.promising(M['_eval_wait'])` + `malloc/stringToUTF8`。

**没有 `octave-core.js`**，没有 Worker，没有 COOP/COEP（我这站部署在静态托管上，
拿不到 COI 头）。就是你说的「只有 `base` 格、wasm32 单线程」那条线的**最小子集**。

算矩阵、行列式、三角函数、`inv`/`rank`/`trace` 都正常（我全站实测 800+ 条公式零失败）。

---

## 1. 我要做什么

想让读者能在页面上做**符号计算**：

```
syms x
diff(sin(x), x)        → cos(x)
int(x^2, x)            → x^3/3
solve(x^2 - 4, x)      → {-2, 2}
expand((x+1)^2)        → x^2 + 2*x + 1
```

也就是 GNU Octave 的 `symbolic` 包（`syms` / `diff` / `int` / `solve` / `simplify` / `expand`…）。

---

## 2. 我从你仓里读到的现状（请确认或纠正）

我读了 `STATE.md` 与 `shelf/packages/symbolic.json`，整理出下面几条。**如果哪条读错了，
请直接点名**——我不猜，宁可按错的问。

| 我读到的 | 出处 |
|---|---|
| `symbolic` **硬依赖 `pyodide`**（`depends: ["pyodide"]`），`014` 裁为硬依赖 | `shelf/packages/symbolic.json`、`STATE.md` |
| symbolic 包**一个字节没改**，靠「零补丁接缝」接上 Pyodide | `STATE.md`（2026-10-15 那条） |
| 机制 = 包的 `python_ipc_system` 调**全局名 `system`** → 你的 `webshim` → 页面桥 `__octaveRunPython` → **同步**调 Pyodide | 同上 |
| 那四处宿主改动里，**① 是 `octave-core.js` 桥函数**；wasm 三件套 sha 不变 | 同上 |
| 决定性实测 `probe-pyodide-sync` **4/0**：不必 JSPI / Asyncify / Atomics | 同上 |
| Pyodide 是 wasm32，在 w64 档页面上也能跑通（`accept-symbolic-seam` 9/0） | `STATE.md`（架构界那条） |

**所以我的理解是**：symbolic 能跑，靠的是**宿主侧的桥**（`octave-core.js` 里那几个函数
+ `webshims/system.m` 的 python 分支 + `__webshim_python_cmd__.m`），而这三样**都不在我
那份三件套里**。

---

## 3. 我要问的四件事（每件都能用一句话答，不必写论文）

### Q1 `symbolic` 能不能**脱离 `octave-core.js`** 接进我这套三件套？

具体说：`webshims/system.m` 与 `__webshim_python_cmd__.m` 是 `.m` 文件——
它们**已经编进 `octave.data` 了吗**（我那份 Release 的 data 里有没有），
还是需要重新打包 `octave.data`？

- 如果**已在**：那我只要自己补一个 `__octaveRunPython`（页面全局）+ 一个 Pyodide 实例，
  就能通——请确认这个判断，并指出还需不需要别的。
- 如果**不在**：那这条线就断了（我不能重编 data），请直说。

### Q2 Pyodide 那侧要多少字节，走什么加载方式？

我站是**纯静态托管**（没有服务端、没有 COI 头）。Pyodide 的 `pyodide.js` + `*.whl` 加起来
通常 10 MB 量级。请给：

- 你们实测的**最小闭包**（哪几个文件、各多大）；
- 能不能**懒加载**（第一次调符号函数时才拉）；
- 那个 `system` 的 python 分支要求 Pyodide **同步调用** —— 我这边页面是
  普通 `<script type="module">`，**没有 JSPI**。`probe-pyodide-sync` 4/0 是在
  `octave-core.js` 的环境里测的，**我这套极简环境**下还成立吗？

### Q3 有没有**更小的**替代（不确定就答"没有"）

我真正需要的只是 `syms` / `diff` / `int` / `solve` / `expand` / `simplify` 这几个。
如果 `symbolic`+`pyodide` 这一整套对静态站太重，你知不知道：

- 有没有**纯 `.m` 的**轻量符号包（不含 Python 依赖）？
- 或者 symbolic 有没有「只带前端、后端换成别的」的配置？

**这条如果答案是「没有」，就直接说没有**，我不希望你为了给我希望而含糊。

### Q4 我这份 Release 里到底装了什么包？

`octave.data` 里现役有哪些包？我算了一下体积对得上 `shelf` 里那 10 个纯 `.m` 包。
但这只是对账，请给个**权威清单**（包名 + 版本 + 有没有 `arch`）。

> 顺带一句：`STATE.md` 提到「现役货架 10 包全属纯 `.m`」——如果那就是我这三件里的全部，
> Q1 的答案大概就是「不在」，我按「不在」处理也行，只要你确认。

---

## 4. 我这边愿意付的代价（说明我的预算，方便你给方案）

- **体积**：再加 10 MB 左右可以接受（我做懒加载 + OPFS 缓存，用户第一次用才下）。
  再加到 40 MB 以上就不行了——那跟整个 `octave.data` 一个量级，而且用户多半只想算个导数。
- **不能要求服务端**：静态托管，没有 COI 头。
- **可以接受"第一次要等几秒"**，但不能接受"必须有 Service Worker 才能跑"。

如果结论是「wasm32 极简线接不上 symbolic」，**说实话就行**——我会把符号计算这个功能
从计划里划掉，不硬凑。

---

## 5. 我之前那两封信里你帮过的事（备忘，不必回复）

- `002` 的 `execute_interp()` —— 一次就通了，现在每天在用。
- 你发的 `wasm32-11.3.0-1ed3e528` Release —— 我 vendor 进来后全站 800+ 条公式零失败。

谢谢。这次只问「能不能、要多少、怎么接」，不需要你做实现。
