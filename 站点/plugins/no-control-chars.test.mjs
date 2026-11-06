// no-control-chars.test.mjs —— 源 Markdown 里不许有控制字符（2026-11-06 实弹）。
//
// ## 病因
//
// 用脚本（Python/Node）写回内容时，字符串里的 `\a`（0x07）、`\b`（0x08）会被
// 当转义序列**吃掉**：`\alpha` 变成 `[0x07]lpha`、`\boldsymbol` 变成
// `[0x08]oldsymbol`。文件看着"正常"（控制字符不可见），但 KaTeX 拿到缺了反斜杠的
// 源码必然 katex-error。
//
// 实测：2026-11-06 写 `作业4.md` 的双签段时，Python 字符串里 12 个 `\alpha` 与
// 4 个 `\boldsymbol` 全被吃，构建报 **8 处「这条公式排不了」**。逐字节查出
// 12 个 0x07 + 4 个 0x08 才定位到。
//
// ## 判据
//
// 源 md 里除 `\n`（换行）与 `\t`（缩进）之外**不许出现任何 C0 控制字符**。
// 这类字符在编辑器里不可见，靠人眼永远查不出来，只能机器拦。
//
// 注意：`\r`（0x0D）也拦——本仓统一 LF，出现 CR 说明某个工具按 CRLF 写过。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const COURSES = path.join(ROOT, '课程总览');

function walkMd(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkMd(p, out);
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

test('源 Markdown 里不许有控制字符（它们会吃掉公式的反斜杠）', () => {
  const bad = [];
  for (const f of walkMd(COURSES)) {
    const s = readFileSync(f, 'utf8');
    const hits = [];
    for (let i = 0; i < s.length; i += 1) {
      const code = s.charCodeAt(i);
      if (code < 32 && code !== 10 && code !== 9) {
        hits.push({ code: `0x${code.toString(16).padStart(2, '0')}`, ctx: s.slice(Math.max(0, i - 30), i + 15) });
        if (hits.length >= 3) break;
      }
    }
    if (hits.length) bad.push({ file: path.relative(ROOT, f), hits });
  }
  assert.deepEqual(bad, [],
    '这些文件里有不可见的控制字符——最可能是脚本写回时 `\\a` / `\\b` 被当转义吃掉：\n'
    + bad.map((b) => `  ${b.file}\n` + b.hits.map((h) => `    ${h.code} … ${JSON.stringify(h.ctx)}`).join('\n')).join('\n')
    + '\n  处置：把控制字符换回 `\\alpha` / `\\boldsymbol` 等正确写法（逐字节修，别用会转义的字符串）。');
});
