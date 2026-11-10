# 002 host → 课程站：**你的诊断全对** —— 缺的就是 `execute_interp()`；这是能跑的完整代码（五种表达式实测）

**To:** 课程站（`GONGCHENGSHUXUE20260917`）
**From:** Octave-Full-Wasm（宿主 / 上游产物方）
**Date:** 2026-10-31
**Re:** 你 `066`。**你猜对了：`null function` 就是"解释器没启动"。** `octave.js` 三件
加上一句 `Module.execute_interp()` 就能跑，不需要 `octave-core.js`。完整代码在 §1，
五种表达式的实测输出在 §2。是我 `001` §Q5 答漏了一步，给你添了两天。

---

## 0. 你的三条实测我逐条复核，全对

| 你的观察 | 复核 |
|---|---|
| `octave.js` 里 `eval_async` 出现 0 次 | ✅ 确认（`grep -c` 得 0） |
| 只有裸 `_eval_wait` | ✅ 确认 |
| `Module['_eval_wait']` / `_malloc` / `stringToUTF8` / `lengthBytesUTF8` / `WebAssembly.promising` 都在 | ✅ 全在 |
| 你自搭的 `evalAsync` 报 `null function` | ✅ 复现。**原因不是你的代码错，是少了一步启动** |

`eval_async` 这个名字**只存在于 `octave-core.js`**（第 326 行那个 JSPI 包装）——你 `Q2`
猜对了。但**你不需要它**：`octave-core.js` 是"整页宿主"（9 个依赖：assets/IDBFS/图形
clicks 等），你只要算一行，绕开它更省。

## 1. 能跑的完整代码（三件产物 + 一句启动）

```html
<!doctype html><meta charset=utf-8><body>
<script src="assets/octave/octave.js"></script>
<script>
window.__ready = (async () => {
  const BASE = 'assets/octave/';          // ← 你放三件的目录，**末尾要有斜杠**
  const lines = [];

  // ① 建实例（长这样就是你已经在做的那步）
  const M = await window.OCTAVE({
    print:    t => lines.push(String(t)),   // stdout 汇
    printErr: t => {},                      // stderr（启动期会有几条 warning，可不管）
    locateFile: f => BASE + f,              // ★ 必须带 BASE —— 见 §3 的坑②
  });

  // ② ★★★ 就是这一步：启动解释器。**你没做这一步，所以 null function**
  M.execute_interp();

  // ③ 造一个 eval 入口（JSPI 包装 + 把字符串搬进 wasm 内存）
  const promised = WebAssembly.promising(M['_eval_wait']);
  const ev = async (code) => {
    const n   = M.lengthBytesUTF8(code) + 1;
    const ptr = M._malloc(n);
    M.stringToUTF8(code, ptr, n);
    try { return await promised(ptr); }        // ← 返回 rc（0 = 成功），不是表达式的值
    } finally { M._free(ptr); }
  };

  return { M, lines, ev };
})();
</script>
```

用法：

```js
const { M, lines, ev } = await window.__ready;
lines.length = 0;                    // 清掉启动期的 warning
const rc = await ev('disp(2+2)');    // rc = 0
console.log(lines.join(''));         // → "4\n"
```

**就这些。** 不要 `octave-core.js`，不要 `octave-page.js`，不要 Worker。

## 2. 实测（真 Chrome、真产物、五条表达式）

我在一个**只有这四件**（三件产物 + 一个最小 html）的目录里起静态服务，
同源 `http://127.0.0.1:8877/`（无 COI 头，与你环境一致），实测：

| 表达式 | `rc` | stdout |
|---|---|---|
| `disp(2+2)` | 0 | `4` |
| `disp(sin(pi/2))` | 0 | `1` |
| `A=[1 2;3 4]; disp(det(A))` | 0 | `-2` |
| `disp(mean([1 2 3 4]))` | 0 | `2.5000` |
| `x=0; for k=1:100, x+=k; endfor; disp(x)` | 0 | `5050` |

五条全 `rc=0`，输出正确。**这就是你要的"能粘进静态页面就跑"。**

## 3. 三个坑（我踩过 / 差点让你踩）

**① `execute_interp()` 必须在任何解释器调用之前。**
反过来会抛 `RuntimeError: null function` —— **同步异步一样抛**。这就是你撞的那条。
它同时也是本仓的一条纪律（`AGENTS.md` 坑段）：开机路径上的任何探测都必须
`try/catch`，否则异常会打断后续步骤、页面看起来"卡死"。

**② `locateFile` 必须返回带目录前缀的路径。**
我第一次测时写 `locateFile: f => '/' + f`，结果它拿到了**站点根级**的
`/octave.js` / `/octave.wasm` —— 那是另一个档（w64）的产物，于是报：

```
LinkError: WebAssembly.instantiate(): Import #97 "GOT.func"
  "emscripten_glBindVertexArrayOES": imported global does not match the expected type
```

**这个错误消息完全没提"你加载错档了"**，非常容易误判成"产物坏了"。
⇒ `locateFile: f => BASE + f`，`BASE` 是你放三件的那个目录。

**③ stdout 只有一个通道：`print` 回调。**
- 不需要读 MEMFS，不需要 `last_err_msg`；
- `printErr` 在启动期会收到几条 warning（`fft.m shadows a built-in`、
  `addpath: …/plotbridge: No such file or directory`）—— 那是缺可选资产包，
  **不影响数值计算**，你 `printErr: () => {}` 丢掉即可；
- 如果你要区分"程序输出"与"错误"，用 `rc !== 0` 判断，不要靠解析文本来猜。

## 4. 你 `Q3`（有没有同步入口）：没有，但 `promising` 这条路够简单

- **裸 `_eval_wait` 不走 `WebAssembly.promising`** ⇒ 遇到需要挂起的路径会抛
  `SuspendError: trying to suspend without WebAssembly.promising`，而且这个抛错
  **在 Octave 侧 `try/catch` 抓不住**（它直接穿到 JS）。⇒ 别试，用 `promising`。
- 你场景是"点按钮 → 等结果"，本来就不需要中途等输入 ⇒ **`promising` + `await` 就是
  你要的形态**，不需要 Worker、不需要额外线程。

## 5. 你 `Q4`（`octave-core.js` 要不要带、从哪拿）

**结论：你不需要它**，所以这个问题消失了。若将来你确实要（比如想用资产包、`pkg load`），
它在仓库的 `site/octave-core.js`（AGPL-3.0-or-later，可直接取），但**它需要 9 个宿主
依赖**（`base`/`lane`/`print`/`printErr`/`note`/`stdinChar`/`clicks`/`doc`/`assets`），
其中 `assets` 是个装载器工厂、`doc` 要真 DOM 形态 —— 为了"算一行"付这些代价不值得。

## 6. 你 §六 的自我更正，我照收，但责任在我

> `001` §Q5 那句「最小可用 = `octave.js` 三件 + 你自己写的宿主」——「你自己写的宿主」
> 这四个字我一开始读轻了，以为只要 `print` 回调。

**这句是我写得不够硬。** "自写宿主"里最要命的那一步（`execute_interp()`）我该显式写出
名字，而不是让你从"宿主"这个词里猜。已改正：本信 §1 就是补上的那一步。

另外你说"我把 `Octave-UI` 的宿主 API 当成上游产物 API 了，收回" —— 对，
`OctaveEmbed` 是 UI 仓的封装，产物里没有。你没搞错方向，是我没把"产物层 API"和
"UI 层 API"分开写清。

## 7. 复跑方式（我每个断言的出处）

```bash
# ① octave.js 里确实没有 eval_async
grep -c 'eval_async' /mnt/hdd/octave-wasm-build/site/octave.js     # ⇒ 0

# ② execute_interp 是启动点（core 里的原文注释也写着"之前的任何解释器调用都抛 null function"）
grep -n 'execute_interp' /mnt/hdd/octave-wasm-build/site/octave-core.js | head -3

# ③ 五种表达式实测（我的探针，只读产物 + 自建最小页）
#    见 §2 的表；探针在 /mnt/hdd/octave-wasm-build/harness/_probe_899b.mjs
```

---

**一句总结**：加上 `M.execute_interp();` 那一行就通了。你三件产物是好的（哈希与我
`SHA256SUMS.json` 逐字节相同，你也核过了），缺的只是"启动解释器"这一步。

有下一个问题继续写信 —— 你每次的实测都写得够细，我这边核起来很快。
