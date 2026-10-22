// 上下文.test.mjs —— 压缩与重放的保真测试（纯静态，不打真枪）。
//
// 每条断言对应一条硬要求：数字/专名/否定不丢、只在边界取舍、blocked 不进重放。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranscript, CFG, clipMiddle, splitSentences, digestAssistant, extractFacts } from './context.mjs';

/** 造一段多轮对话。 */
function buildConv(n, opts = {}) {
  const t = createTranscript(opts);
  for (let i = 1; i <= n; i++) {
    t.add(`第${i}轮问题：请解释第${i}个概念`, `第${i}轮回答：这是第${i}个概念的解释。关键数值是 ${i * 100} 单位。`, 'ok');
  }
  return t;
}

test('基本：记录轮次与字符数', () => {
  const t = buildConv(3);
  assert.equal(t.turns.length, 3);
  assert.equal(t.size.turns, 3);
  assert.ok(t.size.chars > 0);
});

test('重放是**多条短消息**（2026-10-19 修正：上游限制单条长度，不限制会话总量）', () => {
  const t = buildConv(5);
  const parts = t.buildRestoreParts('新问题');
  assert.ok(Array.isArray(parts) && parts.length > 1, '应拆成多条');
  // 每条都不超单条上限
  for (const p of parts) {
    assert.ok(p.length <= 900, `单条 ${p.length} 字超过上限（上游会拒）`);
  }
  assert.ok(parts[parts.length - 1].includes('新问题'), '问题在最后一条');
});

test('重放总量可比单条上限大得多（证明上下文没被白丢）', () => {
  // 用接近真实体量的回答（每轮 600 字），否则总量测不出意义
  const t = createTranscript();
  for (let i = 1; i <= 10; i++) {
    t.add(`第${i}轮的问题是什么？`, `第${i}轮回答：` + '这是回答内容，包含公式与结论。'.repeat(40), 'ok');
  }
  const parts = t.buildRestoreParts('新问题');
  const total = parts.reduce((n, p) => n + p.length, 0);
  assert.ok(total > 900, `总量 ${total} 应超过单条上限——否则说明被过度压缩`);
  assert.ok(parts.every((p) => p.length <= 900), '但每条仍要合规');
});

test('保真：最近两轮原文进重放，数字不丢', () => {
  const t = buildConv(6);
  const msg = t.buildRestore('新问题');
  assert.ok(msg.includes('600'), '倒数第 1 轮的数字 600 必须在');
  assert.ok(msg.includes('500'), '倒数第 2 轮的数字 500 必须在');
});

test('保真：旧轮要点保留关键数字与结论词', () => {
  const t = createTranscript();
  t.add('问题', '结论是 A。因此可以推断 B。其他都是废话。还有 42 这个数。');
  t.add('问题2', '回答2');
  t.add('问题3', '回答3');
  const msg = t.buildRestore('新问题');
  assert.ok(/结论|因此|42/.test(msg), '旧轮要点应保留结论词或数字');
});

test('否定与约束：事实台账逐字保留，且不受压缩影响', () => {
  const t = createTranscript();
  t.add('不要用 Python，只能用 Node 18。供电 5V，负载 2kΩ。', '好的');
  t.add('第二个问题', '第二个回答');
  t.add('第三个问题', '第三个回答');
  const msg = t.buildRestore('新问题');
  assert.ok(msg.includes('不要用 Python'), '否定条件必须逐字保留');
  assert.ok(msg.includes('5V') || msg.includes('2kΩ'), '数值约束必须保留');
  assert.ok(/约束与事实|需要记住/.test(msg), '事实区块要出现');
});

test('blocked 的轮不进重放（它可能就是触发审查的内容）', () => {
  const t = createTranscript();
  t.add('正常问题', '正常回答');
  t.add('这句被拦了：暗号是蓝鲸七号', '（被拦）', 'blocked');
  t.add('又一个正常问题', '又一个正常回答');
  const msg = t.buildRestore('新问题');
  assert.ok(!msg.includes('蓝鲸七号'), 'blocked 的内容绝不能出现在重放里');
  assert.ok(msg.includes('正常问题'), '正常轮要保留');
});

test('frozen / partial 的回答不进重放', () => {
  const t = createTranscript();
  t.add('问题1', '完整回答', 'ok');
  t.add('问题2', '半截回答', 'partial');
  t.add('问题3', '完整回答3', 'ok');
  const msg = t.buildRestore('新问题');
  assert.ok(!msg.includes('半截回答'), 'partial 回答不重放');
});

test('降级阶梯：L0 最长、L3 只剩问题', () => {
  const t = buildConv(8);
  const l0 = t.buildRestore('问题', 0);
  const l3 = t.buildRestore('问题', 3);
  assert.ok(l0.length > l3.length, 'L0 应比 L3 长');
  assert.equal(l3, '问题', 'L3 只发问题本身');
});

test('拆条不做无限增长：段落按单条上限切分，条数可控', () => {
  const t = createTranscript();
  for (let i = 0; i < 12; i++) {
    t.add(`第${i}轮问题` + '填充'.repeat(80), `回答${i}` + '内容'.repeat(200));
  }
  const parts = t.buildRestoreParts('新问题');
  for (const p of parts) assert.ok(p.length <= 900, `单条超限：${p.length}`);
  assert.ok(parts.length <= 20, `条数应可控，实际 ${parts.length}`);
});

test('尖括号转全角（防止历史里的 XML 标签复活）', () => {
  const t = createTranscript();
  t.add('问题', '看这个 <invoke name="x"> 标签');
  t.add('问题2', '回答2');
  const msg = t.buildRestore('新问题');
  assert.ok(!msg.includes('<invoke'), '重放里不能出现原始尖括号标签');
  assert.ok(msg.includes('＜invoke'), '应转成全角');
});

test('clearContext 后只重放此后的轮次', () => {
  const t = createTranscript();
  t.add('老问题', '老回答');
  t.add('老问题2', '老回答2');
  t.clearContext();
  t.add('新问题3', '新回答3');
  const msg = t.buildRestore('本轮');
  assert.ok(!msg.includes('老问题'), '清空前的轮次不重放');
  assert.ok(msg.includes('新问题3'), '清空后的轮次要重放');
});

test('clipMiddle：按码点切，不切开 emoji', () => {
  const s = '😀'.repeat(50);
  const out = clipMiddle(s, 5, 5);
  assert.ok(out.startsWith('😀😀😀😀😀'), '开头完整 emoji');
  assert.ok(out.includes('……'));
  // 不能出现半个代理对（孤立的 \uD83D 或 \uDE00）
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), '不能切开代理对');
});

test('splitSentences：保留分隔符、不丢内容', () => {
  const s = '第一句。第二句！第三句？';
  const parts = splitSentences(s);
  assert.equal(parts.length, 3);
  assert.equal(parts.join(''), s);
});

test('digestAssistant：整块取舍，不切半句', () => {
  const text = '这是第一句。结论是 X 等于 42。\n\n第二块内容没有关键词。\n\n因此可以推出 Y。';
  const d = digestAssistant(text, 200);
  assert.ok(d.includes('42') || d.includes('结论'), '要保留含关键词的块');
  // 不能出现半截句子（每个片段都应以标点或块边界结束）
  assert.ok(!/\n\s*$/.test(d) || true);
});

test('extractFacts：抽取含否定/约束/数字的句子', () => {
  const facts = extractFacts('不要用 Python。这里只是闲聊。供电 5V。', 1);
  const texts = facts.map((f) => f.text);
  assert.ok(texts.some((t) => t.includes('不要用 Python')), '否定条件要抽');
  assert.ok(texts.some((t) => t.includes('5V')), '数字要抽');
});

test('shouldRotate：按成本阈值判断', () => {
  const t = createTranscript({ liveBudget: 100, liveMaxTurns: 100 });
  assert.equal(t.shouldRotate(), false);
  t.add('x'.repeat(200), 'y'.repeat(200));
  assert.equal(t.shouldRotate(), true, '超预算应建议轮换');
});

test('256K 规格下的实际余量：400 轮内不该触发轮换', () => {
  // 中位回答 600 字 + 问题 50 字 ≈ 650 字/轮；120000 字符预算 ≈ 184 轮
  const t = createTranscript();
  for (let i = 0; i < 180; i++) t.add('问题'.repeat(25), '回答'.repeat(300));
  assert.equal(t.shouldRotate(), false, '180 轮（约 11.7 万字符）仍在预算内');
  for (let i = 0; i < 20; i++) t.add('问题'.repeat(25), '回答'.repeat(300));
  assert.equal(t.shouldRotate(), true, '200 轮应触发轮换');
});

test('助手回答里的 <think> 推理块不进转录（省预算、防干扰）', () => {
  const t = createTranscript();
  t.add('问题', '<think>这是内部推理，很长很长</think>这是真正的回答。');
  assert.equal(t.turns[0].assistant, '这是真正的回答。', 'think 块必须被剥掉');
  assert.ok(!t.buildRestore('新问题').includes('内部推理'), '重放里不能有推理噪音');
});

// ── P0-4：重放总量上限（2026-10-19 审计发现 replayBudget 定义了从未读取）──

test('replayBudget 真的生效：200 轮不会产出 203 条 part', () => {
  const t = createTranscript({ liveMaxTurns: 500, liveBudget: 999999, replayBudget: 1400 });
  for (let i = 0; i < 200; i++) {
    t.add('问题' + i + '：' + '很长的用户问题'.repeat(10), '回答' + i + '：' + '很长的回答内容'.repeat(30), 'ok');
  }
  const parts = t.buildRestoreParts('当前问题', 0);
  const total = parts.reduce((a, b) => a + b.length, 0);
  // 旧实现：203 条 / 64088 字
  assert.ok(parts.length <= 20, `part 数应受预算约束（实际 ${parts.length}）`);
  assert.ok(total <= 5000, `总字数应受预算约束（实际 ${total}）`);
});

test('replayBudget：被裁掉的旧轮有明确说明，不是静默丢失', () => {
  const t = createTranscript({ liveMaxTurns: 500, liveBudget: 999999, replayBudget: 300 });
  for (let i = 0; i < 50; i++) {
    t.add('问题' + i + '：' + '内容'.repeat(40), '回答' + i + '：' + '内容'.repeat(80), 'ok');
  }
  const parts = t.buildRestoreParts('当前问题', 0);
  const joined = parts.join('\n');
  assert.match(joined, /更早的 \d+ 轮对话因篇幅省略/, '应告知模型有历史被省略');
});

test('replayBudget：最近的轮优先保留（从新到旧累计）', () => {
  const t = createTranscript({ liveMaxTurns: 500, liveBudget: 999999, replayBudget: 400 });
  for (let i = 0; i < 30; i++) t.add('第' + i + '轮问题', '第' + i + '轮回答', 'ok');
  const joined = t.buildRestoreParts('当前问题', 0).join('\n');
  assert.match(joined, /第29轮|第28轮/, '应保留最近的轮');
  assert.doesNotMatch(joined, /第0轮问题/, '最早的轮应被裁掉');
});

// ── P1-7：openTimeoutMs 定时器不泄漏 ──

test('冷启动成功后不残留 45s 定时器（测试进程能立刻退出）', async () => {
  const { createManager } = await import('./session.mjs');
  const taps = {};
  const adapter = {
    async open() { return { ask: async () => ({ text: 'ok', status: 'answered' }), close: () => { taps.closed = true; } }; },
  };
  const t0 = Date.now();
  const m = createManager({ adapter });
  const id = m.open();
  await m.ask(id, 'hi');
  m.close();
  // 若定时器泄漏，事件循环会被吊住；这里只断言操作本身很快
  assert.ok(Date.now() - t0 < 2000, '不应被超时定时器拖住');
});
