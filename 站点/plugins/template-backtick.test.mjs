// 插件与数学模块必须能被 Node 解析（守「模板串被裸反引号截断」）。
//
// ## 为什么必须机械化
//
// 本仓多个插件把 CSS/JS 整段塞进 `String.raw` 模板串导出（`CHAT_JS`、`CHAT_CSS`、
// `PACK_RUNTIME_JS`、`FIGURES_JS`、`SEARCH_JS`、`SPA_ROUTER_JS`…）。
// 在这些模板串的**注释里**写代码名时顺手加反引号（例如
// 反引号包住 execute_interp() 这种名字），会提前闭合模板串 ——
// 整个模块变成语法错误。
//
// 症状极具误导性：`SyntaxError: Unexpected identifier 'x'`，报错行指在**注释中间**，
// 真正的问题是「模板串被截短了」。2026-10-31 一天内在 pack-runtime.mjs 上踩了六次。
//
// 规矩 repo 里早有：注释里的代码名一律用直角引号「」。靠人记不住，所以做成闸门。
//
// ## 判据：交给引擎，不自己写词法分析
//
// 第一版我手写了个字符状态机去「找模板串、跳过 ${...} 插值」，结果把普通代码里的
// 合法单行模板串全判成违规（`const x = \`a\` + b` 之类），一次报出十几处假阳性。
// 手写 JS 词法分析这件事本身就是错的解法。
//
// 正确判据简单得多：**这个文件 Node 能不能解析**。断串必然语法错误；
// 没断串必然能解析。用 `node --check`，零假阳性、零漏报。
//
// 代价：它测不出「反引号用了但没断串」这种风格问题 —— 但那本来不是缺陷，
// 真正要防的只有断串。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(HERE, '..');

function targets() {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (/\.test\.mjs$/.test(name)) continue;
      if (/\.mjs$/.test(name)) out.push(p);
    }
  };
  walk(path.join(SITE, 'plugins'));
  walk(path.join(SITE, 'math'));
  return out;
}

test('插件与数学模块都能被 Node 解析（断串必然过不了这一关）', () => {
  const files = targets();
  assert.ok(files.length > 10, `只扫到 ${files.length} 个文件 —— 路径变了？`);
  const bad = [];
  for (const f of files) {
    try {
      // `node --check` 只做语法检查，不执行 —— 不会因为缺 DOM 而失败。
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe', timeout: 20000 });
    } catch (e) {
      const msg = String(e.stderr || e.message || '').split('\n').slice(0, 4).join('\n');
      bad.push({ file: path.relative(SITE, f), msg });
    }
  }
  assert.deepEqual(bad, [],
    '这些文件有语法错误（模板串被裸反引号截断是最常见原因：'
    + '注释里的代码名请用直角引号「」，不要用反引号）：\n'
    + bad.map((b) => `── ${b.file}\n${b.msg}`).join('\n'));
});

test('闸门自检：故意造一个断串必须被抓到', () => {
  // 用一个临时文件验证「node --check 这条路真的会红」，
  // 免得哪天 node 行为变了、闸门变成永远绿。

  const tmp = path.join(os.tmpdir(), `bt-probe-${process.pid}.mjs`);
  writeFileSync(tmp, [
    'export const X = `(function () {',
    '  // 这里写了 `foo()` —— 裸反引号会截断模板串',
    '})();`;',
  ].join('\n'));
  try {
    let threw = false;
    try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
    catch (e) { threw = true; }
    assert.ok(threw, '断串没被 node --check 抓到 —— 闸门失效了');
  } finally {
    try { unlinkSync(tmp); } catch (e) {}
  }
});
