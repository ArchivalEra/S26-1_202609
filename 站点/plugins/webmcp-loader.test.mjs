// webmcp-loader.test.mjs —— 编排器的字符串级契约（2026-10-19 补）。
//
// 为什么有了这个文件：用户在真实使用里报「永远是连不上助手」，根因是两个
// 只在**真浏览器**里才暴露的缺口，两者都能用字符串契约守住：
//
//   ① **token 没人送**：页面桥与聊天面板都只读 localStorage，而没有任何
//      东西往那里写 ⇒ /chat 与 /events 永远 401。
//   ② **「本机默认开」从没生效**：本机判断写在 shouldBridge() 里，而它
//      只在 injectPlugins 内部被调用；injectPlugins 又要 wanted 为真。
//      于是不带 query 打开本机站点时形态判成 absent，工具一个都不注册。
//
// 这两条都是「代码看起来在，但从未被执行到」——纯字符串断言正好抓这种。

import test from 'node:test';
import assert from 'node:assert/strict';
import { WEBMCP_LOADER_JS } from './webmcp-loader.mjs';

// ── 语法与基本形状 ─────────────────────────────────────────

test('LOADER：语法可解析', () => {
  assert.doesNotThrow(() => new Function(WEBMCP_LOADER_JS));
});

test('LOADER：不碰 document.write / eval', () => {
  assert.doesNotMatch(WEBMCP_LOADER_JS, /document\.write/);
  assert.doesNotMatch(WEBMCP_LOADER_JS, /\beval\s*\(/);
});

// ── ① 本机默认启用（修「工具表永远是空」）────────────────────

test('LOADER：本机 hostname 直接算 wanted（不带任何 query 也启用）', () => {
  // 这三行必须同时出现：判 loopback、拿它初始化 wanted、再 || 上其它开关。
  assert.match(WEBMCP_LOADER_JS, /location\.hostname/, '要按 hostname 判本机');
  assert.match(WEBMCP_LOADER_JS, /var wanted = loopback/, 'wanted 必须以 loopback 为初值');
  // 三个回环写法都要认：127.0.0.1 / localhost / [::1]
  for (const host of ['127\\.0\\.0\\.1', 'localhost', '\\[::1\\]']) {
    assert.ok(WEBMCP_LOADER_JS.includes(host), 'loopback 正则缺 ' + host);
  }
});

// ── ② token 三级来源（修「永远 401」）────────────────────────

test('LOADER：有 resolveToken，且三级来源齐全', () => {
  assert.match(WEBMCP_LOADER_JS, /function resolveToken\(\)/, '缺 resolveToken');
  // ① localStorage
  assert.match(WEBMCP_LOADER_JS, /localStorage\.getItem\("webmcp_bridge_token"\)/, '缺 localStorage 来源');
  // ② query
  assert.match(WEBMCP_LOADER_JS, /qs\.get\("token"\)/, '缺 ?token= 来源');
  // ③ 问桥要
  assert.match(WEBMCP_LOADER_JS, /\/bootstrap/, '缺 /bootstrap 兜底');
});

test('LOADER：拿到 token 要写回 localStorage（刷新后不必再握手）', () => {
  assert.match(WEBMCP_LOADER_JS, /localStorage\.setItem\("webmcp_bridge_token"/);
});

test('LOADER：注入页面桥前先解析 token（顺序不能反）', () => {
  // 页面桥在 IIFE 里一次性读 TOKEN，注入之后再塞就晚了。
  const inject = WEBMCP_LOADER_JS.slice(
    WEBMCP_LOADER_JS.indexOf('function injectBridge()'),
    WEBMCP_LOADER_JS.indexOf('function injectBridgeTag('),
  );
  assert.ok(inject.length > 0, '找不到 injectBridge');
  assert.match(inject, /resolveToken\(\)/, 'injectBridge 必须先 await resolveToken');
  assert.match(inject, /\.then\(/, 'resolveToken 返回 Promise，要 then 链');
});

test('LOADER：resolveToken 失败不 reject（拿不到 token 只是退回 401，不该卡死注入）', () => {
  assert.match(WEBMCP_LOADER_JS, /\.catch\(function \(\) \{ clearTimeout\(timer\); return ""; \}\)/);
});

test('LOADER：/bootstrap 请求带 3s 超时', () => {
  assert.match(WEBMCP_LOADER_JS, /setTimeout\(function \(\) \{ try \{ ctrl && ctrl\.abort\(\); \} catch \(e\) \{\} \}, 3000\)/);
});
