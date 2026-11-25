// webmcp-loader.test.mjs —— 纯 WebMCP 编排器与 Relay 连接器的字符串级契约。

import test from 'node:test';
import assert from 'node:assert/strict';
import { WEBMCP_LOADER_JS, WEBMCP_RELAY_JS } from './webmcp-loader.mjs';

test('LOADER：语法可解析，且不含 document.write / eval', () => {
  assert.doesNotThrow(() => new Function(WEBMCP_LOADER_JS));
  assert.doesNotMatch(WEBMCP_LOADER_JS, /document\.write/);
  assert.doesNotMatch(WEBMCP_LOADER_JS, /\beval\s*\(/);
});

test('LOADER：已切除旧版 9345 SSE 桥与学习助手残留', () => {
  for (const legacy of ['9345', '/bootstrap', 'webmcp-bridge', 'resolveToken', '__webmcpEnable']) {
    assert.ok(!WEBMCP_LOADER_JS.includes(legacy), `不应再包含旧助手桥接符号：${legacy}`);
  }
});

test('LOADER：支持本机 loopback 默认开启，并认 ?relay=1 / ?webmcp=1 / localStorage', () => {
  assert.match(WEBMCP_LOADER_JS, /location\.hostname/);
  assert.match(WEBMCP_LOADER_JS, /var wanted = loopback/);
  for (const host of ['127\\.0\\.0\\.1', 'localhost', '\\[::1\\]']) {
    assert.ok(WEBMCP_LOADER_JS.includes(host), 'loopback 正则缺 ' + host);
  }
  assert.match(WEBMCP_LOADER_JS, /qs\.get\("relay"\) === "1"/);
  assert.match(WEBMCP_LOADER_JS, /qs\.get\("webmcp"\) === "1"/);
  assert.match(WEBMCP_LOADER_JS, /localStorage\.getItem\("webmcp"\)/);
  assert.match(WEBMCP_LOADER_JS, /localStorage\.getItem\("webmcp_relay"\)/);
});

test('LOADER：动态注入清单包含 shim / tools / polyfill 版本占位符', () => {
  for (const ph of ['__SHIM_VER__', '__TOOLS_VER__', '__POLYFILL_VER__']) {
    assert.ok(WEBMCP_LOADER_JS.includes(ph), `缺少版本占位符 ${ph}`);
  }
  assert.match(WEBMCP_LOADER_JS, /inject\("webmcp-shim\.js"\)/);
  assert.match(WEBMCP_LOADER_JS, /inject\("webmcp-tools\.js"\)/);
});

test('RELAY：语法可解析，且按 ?relay=1 或 webmcp_relay=on 触发', () => {
  assert.doesNotThrow(() => new Function(WEBMCP_RELAY_JS));
  assert.match(WEBMCP_RELAY_JS, /qs\.get\("relay"\) === "1"/);
  assert.match(WEBMCP_RELAY_JS, /localStorage\.getItem\("webmcp_relay"\) === "on"/);
  assert.match(WEBMCP_RELAY_JS, /relay-embed\.js/);
});
