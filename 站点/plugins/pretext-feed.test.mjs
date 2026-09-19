/**
 * pretext 资料门户插件的测试。
 *
 * 客户端脚本串测契约；纯函数测算法本身（masonry 分配、列数、高度预测——
 * 它们是 FEED_JS 内联逻辑的可测规范，两边算法必须一致）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { distributeCards, columnCount, predictedHeight, FEED_JS } from "./pretext-feed.mjs";

describe("pretext-feed：masonry 分配", () => {
  it("最短列优先：新卡片进当前最矮的列", () => {
    // 高度 [10,10,10,30]：前 3 张各开一列，第 4 张进最矮的列 0
    const cols = distributeCards([10, 10, 10, 30], 3);
    assert.deepEqual(cols.map(c => c.length), [2, 1, 1]);
    assert.deepEqual(cols[0], [0, 3]);
  });

  it("单列退化：全部进同一列且保序", () => {
    const cols = distributeCards([5, 1, 9], 1);
    assert.deepEqual(cols, [[0, 1, 2]]);
  });

  it("空输入与非法列数不炸", () => {
    assert.deepEqual(distributeCards([], 3), [[], [], []]);
    assert.deepEqual(distributeCards([1], 0).length, 1);
  });
});

describe("pretext-feed：列数与高度预测", () => {
  it("列数随容器宽度变化，窄容器退化为 1 列", () => {
    assert.equal(columnCount(100, 240, 380), 1);
    assert.equal(columnCount(760, 240, 380), 3);
    assert.equal(columnCount(240, 240, 380), 1);
  });

  it("predictedHeight = 内边距×2 + 标题行×行高 + 间隙 + 摘要行×行高 + 间隙 + meta 行×行高", () => {
    const spec = { padY: 14, titleLineHeight: 24, lineHeight: 22, metaLineHeight: 20, gap: 8 };
    // 标题 1 行、摘要 3 行、meta 1 行
    const h = predictedHeight({ title: "T", snippet: "S", meta: "M" }, spec,
      (t) => (t === "T" ? 1 : t === "S" ? 3 : 1));
    assert.equal(h, 28 + 24 + 8 + 66 + 8 + 20);
  });
});

describe("pretext-feed：客户端脚本契约", () => {
  it("是 module 脚本，经动态 import 加载 vendored pretext（失败可降级）", () => {
    assert.ok(FEED_JS.startsWith("/* pretext-feed"));
    assert.ok(FEED_JS.includes('await import("../vendor/layout.js?v=0.0.9")'));
    assert.ok(!FEED_JS.match(/^import /m), "顶层静态 import 会让失败静默，禁止");
  });

  it("支持 dom 基线、压测与 bench 三个 URL 参数", () => {
    assert.ok(FEED_JS.includes('"feedmode"'));
    assert.ok(FEED_JS.includes('"feedstress"'));
    assert.ok(FEED_JS.includes('"bench"'));
    assert.ok(FEED_JS.includes("__pretextBench"));
  });

  it("dom 基线路线必须保留 offsetHeight 逐卡读（那是被对照的原版策略）", () => {
    assert.ok(FEED_JS.includes("offsetHeight"));
  });

  it("渲染后暴露预测误差（maxPredictErr），证明预测可用而非黑箱", () => {
    assert.ok(FEED_JS.includes("maxPredictErr"));
  });
});
