// 数学字体子集完整性闸门（2026-10-29）。
//
// ## 为什么必须有这一条
//
// 站点的数学字体是 **STIX Two Math 的子集**（46 KB），只含生成那一刻统计到的字符。
// 子集的好处是体积小 6 倍、只有一个请求；代价是**新内容用到子集外的字符就缺字**
// （浏览器画成一个方框，页面不报错、构建不报错、测试也不报错）。
//
// 这个缺陷的症状极隐蔽：某天新写一页用到 `⋔`（或任何生僻符号），公式里出现一个空框，
// 而所有自动闸门都是绿的。所以这里把它变成**构建后可测的判据**：
// 扫全站产物里公式用到的每个字符，逐个问字体「你有这个字形吗」，缺哪个报哪个。
//
// ## 判据取自字体本身，不是猜
//
// 用 fontTools 读 woff2 的 cmap 表——这是渲染器真正会查的那张表。
// 不用「字符在某个白名单里」这种间接判据：白名单会和字体实际内容漂移。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { KATEX_STYLESHEET } from '../math/render.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '../dist');
const FONT = path.join(HERE, '../assets/fonts/stix2math-subset.woff2');

function walkHtml(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkHtml(p, out);
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

/** 全站公式用到的字符集合（取 data-math-plain —— IR 的纯文本投影）。 */
function usedMathChars() {
  const chars = new Set();
  for (const file of walkHtml(DIST)) {
    const s = readFileSync(file, 'utf8');
    for (const m of s.matchAll(/data-math-plain="([^"]*)"/g)) {
      for (const ch of m[1]) chars.add(ch);
    }
  }
  return chars;
}

/**
 * 读字体 cmap 里的全部码位。
 *
 * 用仓库里现成的 uv 环境跑，不引入 Python 依赖到 Node 侧：
 * 没有 uv 时跳过（返回 null），由测试给出「未查」而不是假绿。
 */
function fontCodepoints() {
  const script = `
import sys
from fontTools.ttLib import TTFont
f = TTFont(sys.argv[1])
cmap = f.getBestCmap()
print(' '.join(str(c) for c in sorted(cmap)))
`;
  // ⚠️ 不要依赖预建的 venv：`/tmp` 是 tmpfs，重启即空（本仓记过这条），
  // 用预建路径的闸门会在干净环境里永远报「未检查」——闸门一脆，就没人再信它。
  // 改成用 **uv run --with** 现场拉起：uv 有全局缓存，第二次起很快，且不写仓库。
  const attempts = [
    { cmd: 'uv', args: ['run', '--quiet', '--with', 'fonttools', '--with', 'brotli',
                        '--python', '3.13', 'python', '-c', script, FONT] },
    { cmd: '/tmp/uvf/bin/python', args: ['-c', script, FONT] },
    { cmd: 'python3', args: ['-c', script, FONT] },
  ];
  for (const { cmd, args } of attempts) {
    try {
      const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 120000 });
      const set = new Set(out.trim().split(/\s+/).filter(Boolean).map(Number));
      if (set.size) return set;
    } catch (_e) { /* 试下一个 */ }
  }
  return null;
}

test('数学字体子集必须覆盖全站公式用到的所有字符', () => {
  assert.ok(existsSync(FONT), '缺数学字体：assets/fonts/stix2math-subset.woff2');
  const cps = fontCodepoints();
  if (!cps) {
    // 不能假装通过：明确标出「这一项没查」。
    assert.fail('读不到字体 cmap——本项未检查，不等于通过。'
      + '需要 uv（或 python3 带 fontTools+brotli）：uv run --with fonttools --with brotli python -c ...');
  }

  const used = usedMathChars();
  // 空格不是字形，跳过；换行同理。
  const ignore = new Set([' ', '\n', '\t', '\u00a0', '\u200b', '\u200c', '\u200d']);
  const missing = [];
  for (const ch of used) {
    if (ignore.has(ch)) continue;
    const cp = ch.codePointAt(0);
    // 中文由正文回退字体渲染，数学字体不管——跳过 CJK 与全角标点
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0xff00 && cp <= 0xffef)) continue;
    if (!cps.has(cp)) missing.push({ ch, cp: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0') });
  }

  assert.deepEqual(missing, [],
    `数学字体子集缺这些字符（页面上会显示成方框），需要重新生成子集：\n`
    + missing.map((m) => `  ${m.ch}  ${m.cp}`).join('\n'));
});

test('数学公式样式引用的每个本地 woff2 都随站点发布', () => {
  const cssPath = path.join(DIST, KATEX_STYLESHEET);
  const code = readFileSync(cssPath, 'utf8');
  const wanted = [...code.matchAll(/url\(\s*["']?([^"')]+\.woff2)(?:[?#][^"')]*)?["']?\s*\)/g)]
    .map((match) => match[1]).filter((url) => !/^(?:[a-z]+:|\/\/)/i.test(url));
  const missing = wanted.filter((font) => !existsSync(path.resolve(path.dirname(cssPath), font)));
  assert.deepEqual(missing, [], `${KATEX_STYLESHEET} 引用了未发布的字体文件：\n${missing.join('\n')}`);
});

test('STIX 数学字体子集文件在位（全站公式字符校验依赖它）', () => {
  assert.ok(existsSync(path.join(HERE, '../assets/fonts/stix2math-subset.woff2')),
    '缺 STIX 数学字体子集文件');
});
