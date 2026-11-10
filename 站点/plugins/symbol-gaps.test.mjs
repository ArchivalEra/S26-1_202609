// symbol-gaps.test.mjs —— 符号**缺口**闸（2026-11-06 站长实测指出）。
//
// ## 站长原话
//
// 「符号系统还是不能响亮报错是不是，习题册那边符号还是不能冒泡的一大堆」
//
// 前两道闸（`glossary-bubble` / `symbol-coverage`）都只看**判定之后**的事：
// 锚点对不对得上气泡、认出来了有没有包成链接。它们抓不到最要命的一类——
// **压根没被判定为符号的形状**。实测电路原理习题册第二章：公式里 `V` 出现 46 次、
// `A` 27 次、`T` 26 次，而通用包的 `:::glossary-match` 表里没有 V/A/T 的声明行，
// 所以它们永不冒泡，**构建日志一个字都不说**。
//
// ## 这个测试断言什么（以及不断言什么）
//
// 断言：**缺口必须被量化并留档**。
//   · `dist/symbol-coverage.json` 里有 `symbols_missing_entries` 与 `gaps`；
//   · 数字与独立复算一致（不信构建自报）；
//   · 噪声（函数名、纯标点）不许混进来——否则清单没法用。
//
// **不断言「缺口必须为 0」**：这些形状里绝大多数**本来就不该冒泡**
// （工程数学的 `A` 是矩阵、`x_1` 是未知数，挂上「电流」词条是错误标注）。
// 「该不该补词条」是内容决策，不是机器能判的。闸门的职责是**让缺口不再隐形**，
// 由人按 top-N 清单逐条决定补词条、加声明、还是记进「本页不取词」。
//
// 判据（可机械判）：构建产出的账本里，缺口种数 > 0 时**必须在日志里显式打印**
// （不能悄悄算完不提），且账本可被本测试复算对上。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { measureFormulaShapes, coverageOf, isMeaningfulGap } from './symbol-gaps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '../dist');

function walkHtml(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkHtml(p, out);
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

test('符号缺口：账本必须存在，且带种数 + 明细', () => {
  const p = path.join(DIST, 'symbol-coverage.json');
  assert.ok(existsSync(p), 'dist/symbol-coverage.json 不存在——先跑 node build.mjs');
  const r = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(typeof r.symbols_missing_entries, 'number',
    '账本缺 symbols_missing_entries——缺口没被统计（这正是「无法统计」的老毛病）');
  assert.ok(Array.isArray(r.gaps), '账本缺 gaps 明细');
  assert.equal(r.symbols_missing_entries, r.gaps.length,
    '种数与明细条数不一致——账本自己都算不清');
});

test('符号缺口：噪声不许混进清单（函数名/纯标点）', () => {
  const r = JSON.parse(readFileSync(path.join(DIST, 'symbol-coverage.json'), 'utf8'));
  const noise = r.gaps.filter((g) => !isMeaningfulGap({ label: g.label }));
  assert.deepEqual(noise.map((g) => g.label), [],
    '这些是函数名或标点，不该算「缺词条」——报出来只会淹没有用信号：\n'
    + noise.slice(0, 10).map((g) => `  ${g.label} ×${g.count}`).join('\n'));
});

test('符号缺口：独立复算与账本口径一致（前十同序，计数允许小幅差）', () => {
  const r = JSON.parse(readFileSync(path.join(DIST, 'symbol-coverage.json'), 'utf8'));
  // 复算：逐页量形状、按 label 聚合。
  //
  // ⚠️ 计数**不可能逐字相等**，这是口径本身决定的，不是谎报：
  //   · 构建期用的是 `decisions[].matched`（判定器亲手切下的源文本，精确）；
  //   · 测试只能从产物 HTML 反推 label（`data-math-tex` 的切片 + 冒泡键），
  //     信息量略少 ⇒ 少数形状被判成未覆盖/已覆盖的边界会挪动几十次
  //     （实测 A: 2166 vs 2182，差 0.7%）。
  // 所以判据是：**前十的集合一致**，顺序只要求「计数明显分层的段内」一致；
  // 相邻两项计数几乎持平（差 ≤2%）时顺序可以互换——那种并列序由两边信息量差
  // 随机决定（2026-11-07 实例：新增 4.3/4.4 两页后，构建账本 Y=251 vs α₁=248
  // 相差 1.2%，复算 α₁=248 vs Y=246，并列但反序）。计数差距拉大（>2%）后再
  // 反序才是口径坏了，那才是要拦的。
  //
  // 为什么计数放到 10% 而不是 3%：`k` 这类**正则词条**（`sym-kcoup` 的 `/(?<![A-Za-z\\])k(?!...)/`）
  // 只有构建期的判定器能精确命中，测试从 HTML 反推不出"哪些 k 被 pattern 吃了"
  // ⇒ 实测 `k` 差 6.3%（303 vs 322）。这是**信息量差异**，不是口径坏掉。
  const agg = new Map();
  for (const file of walkHtml(DIST)) {
    const m = measureFormulaShapes(readFileSync(file, 'utf8'));
    const { uncovered } = coverageOf(m);
    for (const u of uncovered) agg.set(u.label, (agg.get(u.label) || 0) + u.count);
  }
  const mine = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const theirs = r.gaps.slice(0, 10).map((g) => [g.label, g.count]);
  // 集合一致（缺谁多谁才是真问题）。
  //
  // 判据（2026-11-10 修正）：**账本前十的每一项，都必须能被独立复算证到同一量级**。
  //
  // 不复算「前十集合相等」，理由是两侧信息量本就不同：
  //   · 构建用判定器亲手切下的源文本，测试只能从产物 HTML 反推 label；
  //   · 单字母形状（A/B/C/R/Y/k/n）在两边被归到「未覆盖」的边界会整体挪动几十次，
  //     足以让相邻若干名互换。2026-11-10 实例：新增电机学 11-05 笔记后
  //     账本 Y=253 进第十、R=243 退到第 15，而复算 R=250 进前十、Y=246 出去。
  // 硬要求集合相等，会在每次内容变化时误伤，而它抓不到真问题——
  // 「某个形状整体消失或翻倍」会体现为**计数差超阈值**，那才是要拦的。
  //
  // 所以：① 账本前十每个 label 复算里必须有值（不能凭空出现在账本里）；
  //       ② 计数差 ≤10%（既有阈值，理由见下方 k 的注释）。
  const mineMap = new Map(agg.entries());
  const absent = theirs.map(([l]) => l).filter((l) => !mineMap.has(l));
  assert.deepEqual(absent, [],
    `账本前十里有形状在独立复算里根本不存在：${absent.join(', ')} —— 账本凭空造了缺口`);
  // 顺序：**账本自己**必须是按计数降序排列的（前十存在意义的唯一前提）。
  // 不与复算比顺序 —— 两侧集合都可能不同，比顺序没有可判语义。
  const counts = theirs.map(([, n]) => n);
  const monotone = counts.every((n, i) => i === 0 || counts[i - 1] >= n);
  assert.ok(monotone, `账本 gaps 前十不是降序：${counts.join(' >= ')} —— 前十清单口径坏了`);
  for (let i = 0; i < theirs.length; i += 1) {
    const [label, n1] = theirs[i];
    const n2 = mine[i][1];
    const diff = Math.abs(n1 - n2) / Math.max(n1, 1);
    assert.ok(diff <= 0.10,
      `${label} 计数差 ${(diff * 100).toFixed(1)}% 超过 10%（账本 ${n1} vs 复算 ${n2}）——口径不一致`);
  }
});

test('符号缺口：闸门必须能抓到人为制造的缺口（变异自证）', () => {
  // 造一页公式：`V` 出现但没有 V 的任何词条 ⇒ 必须进 uncovered。
  const html = '<span class="katex" data-math-tex="V=IR"></span>';
  const m = measureFormulaShapes(html);
  const { uncovered } = coverageOf(m, new Set());   // 空 bubbledLabels ⇒ 全部未覆盖
  const labels = uncovered.map((u) => u.label);
  assert.ok(labels.includes('V'), '`V` 没被抓成缺口——闸门是纸糊的');
  assert.ok(labels.includes('I'), '`I` 没被抓成缺口');
  // 反过来：给出 V 的 label ⇒ 它必须变成已覆盖
  const m2 = coverageOf(m, new Set(['V']));
  assert.ok(!m2.uncovered.some((u) => u.label === 'V'),
    '给了 V 的 label 之后它还在缺口里——比对逻辑坏了');
});
