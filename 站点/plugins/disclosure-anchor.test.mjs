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
});
