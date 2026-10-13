/**
 * 折叠面板深链接模块的测试。
 *
 * 客户端脚本没有 DOM 可跑，所以测的是能钉死契约的部分：
 *  1. 脚本串必须是合法 JS（语法坏掉等于整页脚本全崩，必须构建期就拦住）。
 *  2. 必须同时挂 DOMContentLoaded 与 hashchange——少了前者刷新直达失效，
 *     少了后者页内点击失效。
 *  3. 必须向上找祖先 <details>——只开目标自己，嵌套时内容照样看不见。
 *  4. 不得引用外部依赖（fetch/import/CDN）——离线可用是站点硬约束。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DISCLOSURE_ANCHOR_JS } from "./disclosure-anchor.mjs";

describe("disclosure-anchor：客户端脚本契约", () => {
  it("脚本串是语法合法的 JavaScript", () => {
    assert.doesNotThrow(() => new Function(DISCLOSURE_ANCHOR_JS));
  });

  it("同时挂了 DOMContentLoaded 与 hashchange 两个时机", () => {
    assert.ok(DISCLOSURE_ANCHOR_JS.includes('"DOMContentLoaded"'));
    assert.ok(DISCLOSURE_ANCHOR_JS.includes('"hashchange"'));
  });

  it("沿 parentElement 向上展开祖先 <details>（嵌套面板也要可见）", () => {
    assert.ok(DISCLOSURE_ANCHOR_JS.includes("parentElement"));
    assert.ok(DISCLOSURE_ANCHOR_JS.includes('tagName === "DETAILS"'));
    assert.ok(DISCLOSURE_ANCHOR_JS.includes("node.open = true"));
  });

  it("零外部依赖：不 fetch、不 import、不碰 CDN（离线硬约束）", () => {
    assert.ok(!/\bfetch\s*\(/.test(DISCLOSURE_ANCHOR_JS));
    assert.ok(!/\bimport\s*[\s(]/.test(DISCLOSURE_ANCHOR_JS));
    assert.ok(!/https?:\/\//.test(DISCLOSURE_ANCHOR_JS));
  });

  it("hash 为空或找不到目标时安全返回，不炸", () => {
    // 无法真跑 DOM，但至少断言存在空 hash 与 null 的守卫分支
    assert.ok(DISCLOSURE_ANCHOR_JS.includes("if (!raw) return;"));
    assert.ok(DISCLOSURE_ANCHOR_JS.includes("if (!el) return;"));
  });

  it("展开面板后重滚一次（修「跟着算一遍」锚点漂移，2026-10-13）", () => {
    // 展开 <details> 会改变目标自身的文档位置：原生锚点滚动按「展开前」几何算的
    // 落点已经不准，必须在布局稳定后补一次 scrollIntoView。
    assert.ok(DISCLOSURE_ANCHOR_JS.includes("opened = true"));
    assert.ok(DISCLOSURE_ANCHOR_JS.includes("requestAnimationFrame"));
    assert.ok(DISCLOSURE_ANCHOR_JS.includes("scrollIntoView"));
  });

  it("只有真的展开过面板才重滚（面板本就开着时不抢用户的滚动）", () => {
    // 条件必须挂在 opened 上；无条件重滚会在每次 hashchange 时粗暴抢走滚动位置
    assert.ok(/if\s*\(\s*opened\s*\)/.test(DISCLOSURE_ANCHOR_JS));
  });
});
