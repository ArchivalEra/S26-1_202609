#!/usr/bin/env node
/**
 * parity 快照生成器（浏览器侧）——2026-10-22 新增。
 *
 * 为什么需要：`parity-browser.snapshot.json` 是 2026-10-15 手工抓的，没有生成器。
 * 于是**页面集合一变（如新增 技法库.md），快照就过时**，parity 测试报顺序偏移，
 * 而没人能重新生成——只能靠猜，或者长期红着。
 *
 * 用法（三步）：
 *   cd 站点 && node build.mjs --canonical-root / --assistant-secrets <secrets.json>
 *   cd 站点/dist && python3 -m http.server 8899 &
 *   node 工具/mcp-端点/test/parity-browser.mjs
 *
 * 抓法：**驱动真实 UI**——填搜索框、读渲染出的 `.search-hit`。
 * 不走 `window.__siteSearch`（它只暴露内部纯函数，检索入口在闭包里）。
 * 前 12 条与总命中数取自 DOM，与读层的取法一致，可逐项比对。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARITY_QUERIES } from './parity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'parity-browser.snapshot.json');
const BASE = process.env.PARITY_BASE || 'http://127.0.0.1:8899';
const CLOAK = '/mnt/hdd/HUAWEI-codearts/cloakbrowser-install/node_modules/cloakbrowser/dist/index.js';

async function main() {
  const { launch } = await import(CLOAK);
  const browser = await launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);

  // 打开搜索面板
  await page.evaluate(() => {
    const btn = document.getElementById('search-toggle');
    if (btn) btn.click();
  });
  await page.waitForTimeout(1200);

  const snapshot = {};
  for (const q of PARITY_QUERIES) {
    // 填输入框（走真实 input 事件，让面板自己触发检索）
    await page.evaluate((query) => {
      const input = document.getElementById('search-input');
      if (!input) return;
      input.value = query;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, q);
    await page.waitForTimeout(900);   // 等 debounce + 渲染

    const r = await page.evaluate((query) => {
      const hits = [...document.querySelectorAll('#search-results a.search-hit')];
      // 总命中数：「仅显示相关度最高的 N 页（共 M 页命中）」
      let total = hits.length;
      const panel = document.getElementById('search-results');
      const txt = panel ? panel.textContent || '' : '';
      const m = txt.match(/共\s*(\d+)\s*页命中/);
      if (m) total = Number(m[1]);
      return {
        total,
        hits: hits.slice(0, 12).map((a) => {
          try { return new URL(a.getAttribute('href'), location.href).href; }
          catch { return String(a.getAttribute('href')); }
        }),
      };
    }, q);
    snapshot[q] = r;
    console.log(`${q.padEnd(10)} → total=${r.total} hits=${r.hits.length}`);
  }

  fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2));
  console.log('\n已写出:', OUT);
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
