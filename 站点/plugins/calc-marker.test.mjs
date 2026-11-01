// 可算性**只认手动标记**（2026-11-01 站长定案）。
//
// ## 为什么推倒重来
//
// 前三轮都试过「构建期自动判哪条公式能算」，每轮都在加判据：
//   第 1 轮 3 条 → 第 2 轮 6 条 → 第 3 轮 10 条，**还在冒新形态**。
// 而且每加一条都可能误伤 —— 实测代价：
//   · `] [` 被当成并置 ⇒ 所有矩阵乘法失去播放按钮；
//   · 判据要区分「2 pi（隐含乘法，必错）」与「2*pi（合法）」，
//     就得继续加更细的正则，而数学排版里的隐含乘法是**无穷形态**。
//
// 站长原话「自动匹配效果太好笑了」。观察到的具体现象：真正想算的 3×3 矩阵
// 没有按钮，旁边一个孤立的 `1` 反倒有按钮、点开得到 `= 1`。
//
// 所以形态改成：**md 里显式写 `$$…$$ {:calc}` 才挂播放按钮**。
// 标记是**声明**不是提示 —— 标错了构建期直接抛错（不静默降级成坏按钮）。
//
// ## 这条闸门锁什么
//
// ① 默认**一个按钮都不挂**（没有标记就没有 data-octave-code）；
// ② 标了 `{:calc}` 才挂，且挂的是转译产物；
// ③ 标了但算不了 ⇒ **构建抛错**，报错要点名文件/公式/原因/处置；
// ④ 标记不能漏进正文（它是元数据，不是公式的一部分）。
//
// 判据取这四条而不是「翻译器支持什么」——后者是前者的实现细节，会变。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = fs.readFileSync(path.join(HERE, '../build.mjs'), 'utf8');
const TOCTC = fs.readFileSync(path.join(HERE, '../math/to-octave.mjs'), 'utf8');
// 真跑一遍转译器（不是读源码）——下面 ⑫ 第二条要验证「分离后能算」。
const { translate } = await import(path.join(HERE, '../math/to-octave.mjs'));
const { parse } = await import(path.join(HERE, '../math/parser.mjs'));
const tr = (tex) => {
  try { return translate(parse(tex).expr.root); } catch (e) { return { ok: false, reason: String(e && e.message) }; }
};

test('① build.mjs 里没有「自动判可算」那条路了', () => {
  // 旧的形状：`const t = translateToOctave(...); if (t.ok && t.code) { computable = true }`
  // —— 它对**每一条**公式都跑翻译器，跑通就挂按钮。
  // 现在的形状：只有 calcMarked 才跑翻译器。
  const seg = BUILD.slice(BUILD.indexOf('const calcMarked'), BUILD.indexOf('let htmlOut = out.html'));
  assert.ok(seg.length > 100, '找不到可算性判定段');
  assert.match(seg, /if \(calcMarked\)/, '翻译器必须只在 calcMarked 时才跑');
  // 反面：不许再出现「无条件跑翻译器、跑通就 true」的形态
  assert.ok(!/if \(t\.ok && t\.code\) \{ computable = true/.test(BUILD),
    '「自动判可算」的旧写法又回来了 —— 那条路已经证明不通（误伤矩阵乘法、给孤立常数挂按钮）');
  assert.ok(!/let computable = false/.test(BUILD), 'computable 这个自动判定位还在');
});

test('② 标记解析：`$$…$$ {:calc}` 剥掉标记后进渲染，且 flag 透传', () => {
  const seg = BUILD.slice(BUILD.indexOf('// 2.1 Display Math'), BUILD.indexOf('// 2.2 Inline Math'));
  // 正则必须能吃到尾部的 {:calc}（用字符串查找，避免在测试里再写一遍易碎的正则）
  assert.ok(seg.includes('{:'), '没有匹配尾部 {:calc} 的正则');
  assert.ok(seg.includes('calc'), '没有 calc 这个标记名');
  assert.match(seg, /calc: !!mark/, '标记没有透传给 renderOneMath');
});

test('③ 标了但算不了 ⇒ 构建抛错（不静默降级）', () => {
  const seg = BUILD.slice(BUILD.indexOf('const calcMarked'), BUILD.indexOf('let htmlOut = out.html'));
  // 转译失败要抛
  assert.match(seg, /if \(!t\.ok \|\| !t\.code\)[\s\S]*?throw new Error/, '转译失败没有抛错');
  // 转译器抛异常也要抛
  assert.match(seg, /catch \(e\)[\s\S]*?throw new Error/, '转译器异常没有转成构建错误');
  // 报错要能定位：必须带 relPath 与公式原文
  assert.match(seg, /\$\{relPath\}/, '报错没带文件路径，构建日志没法定位');
  assert.match(seg, /公式：\$\{src/, '报错没带公式原文');
  // 还要给处置办法（要么改公式、要么去掉标记）
  assert.match(seg, /要么把公式改写|要么去掉 \{:calc\}/, '报错没说怎么办');
});

test('④ 标记不进正文：剥标记后再 trim', () => {
  // `{:calc}` 若留在公式源里，KaTeX 会把它当普通文本排出来
  // （页面上就是公式旁边多一行 `{:calc}`）。所以必须先剥、后 trim。
  const seg = BUILD.slice(BUILD.indexOf('// 2.1 Display Math'), BUILD.indexOf('// 2.2 Inline Math'));
  // 正则的第二组是标记，回调里只把第一组（tex）交给渲染
  assert.match(seg, /\(whole, tex, mark\)/, '回调参数不对：标记可能被当成公式内容');
  assert.match(seg, /tex\.trim\(\)/, '公式源没有 trim');
});

test('⑤ 转译器不再靠「一堆启发式判据」决定能不能算', () => {
  // 判据堆到 10 条还在冒新形态，是这次推倒的直接原因。
  // 现在 translate() 只保留**转译 + 最低限度的结构合法性**（空括号、残缺运算符），
  // 「这条公式适不适合给读者算」改由**作者标记**决定。
  //
  // 用条数作判据：这些 `if (... ) return fail(...)` 的**数量**不能回到两位数。
  const seg = TOCTC.slice(TOCTC.indexOf('export function translate('), TOCTC.indexOf('function emitSequence'));
  const fails = (seg.match(/return fail\(/g) || []).length;
  assert.ok(fails <= 8, `translate() 里又有 ${fails} 条启发式判据了 —— 这条路已证明会无限膨胀，`
    + '要加新的「能不能算」规则请改成作者标记，不要恢复自动判据');
});

// ══════════════════════════════════════════════════════════════════
// 2026-11-01 站长：**题号与题目分离**。
//
// 「全站都改，题号与题目分离，这样又有几个公式可以算了」。
//
// 病因：题号 `(1)` 被写进公式里（`$$(1)\quad\begin{pmatrix}…\end{pmatrix}$$`），
// 译出来是 `(1) [3 2 -4; …]` —— 两个操作数并置，Octave 语法错。
// 但题号**本来就不是公式的一部分**，它是排版的标签。分离之后：
// 公式回到纯矩阵 ⇒ 能算，题号回到正文 ⇒ 可读性反而更好。
//
// 判据：`{:calc}` 标记的公式里**不许有题号前缀**（换行/空白后紧跟 `(N)`
// 或 `(N)\quad`）。有前缀就说明没分离干净 —— 那样的公式译不出合法产物。
// ══════════════════════════════════════════════════════════════════

test('⑫ 标了 {:calc} 的公式不许带题号前缀（题号是排版标签，不是公式的一部分）', () => {
  // 扫全站 md：凡是 `$$…$$ {:calc}` 且公式开头是 `(N)` 的都算没分离干净。
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.name.endsWith('.md')) out.push(p);
    }
    return out;
  };
  const ROOT = path.resolve(HERE, '../..');
  const files = walk(path.join(ROOT, '课程总览'));
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    // $$(N)...$$ {:calc}
    const re = /\$\$\s*\([0-9]+\)[\s\S]*?\$\$\s*\{:\s*calc\s*\}/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      bad.push(`${path.relative(ROOT, f)}: ${m[0].slice(0, 60).replace(/\n/g, ' ')}`);
    }
  }
  assert.deepEqual(bad, [],
    `这些标记公式还带题号前缀，先把题号移到公式外：\n  ${bad.join('\n  ')}`);
});

test('⑫ 题号分离后的公式仍然能算出结果（至少不是空跑）', () => {
  // 反例优先：确认 `(1) [3 2 -4; …]` 这种形态**确实**算不了 —— 这是分离的理由。
  const withNumber = tr('(1)\\quad\\begin{pmatrix}3&2&-4\\\\3&2&-4\\\\1&2&-1\\end{pmatrix}');
  assert.equal(withNumber.ok, false, '带题号的公式本该算不了（并置），若现在能算说明判据变了');
  // 分离之后能算
  const bare = tr('\\begin{pmatrix}3&2&-4\\\\3&2&-4\\\\1&2&-1\\end{pmatrix}');
  assert.equal(bare.ok, true, '分离题号后的纯矩阵必须能算');
  assert.match(bare.code, /\[3 2 -4; 3 2 -4; 1 2 -1\]/);
});
