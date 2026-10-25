// proto.test.mjs —— 协议栈浏览器移植版测试（计划书步骤 3，零网络）。
//
// 结构分三块：
//   ① 原样搬运 .zcode/学习通API/chaoxing.test.mjs 的纯函数测试
//      （terminalKind / extractChunks / parseToolCalls / isBlockedText 家族，
//       含定时器契约的源码断言）——**协议零改动则测试零改动**（计划书第四节步骤 3
//       的验收方式），一条不少；
//   ② 源码契约（移植特有）：伪装头删干净、无上游明文、base 参数化；
//   ③ 环境替换的新纯函数：b64ToBytes。
//
// 网络路径（connect/ask/apply）需要真实 WS，超出本步——不测。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  terminalKind, extractChunks, parseToolCalls, isBlockedText, isContextMissingText,
  isTooLongText, b64ToBytes, createAssistant,
} from './proto.mjs';

// ══════════════════════════════════════════════════════════
// ① 原测试原样搬运（源：chaoxing.test.mjs，仅改 import 目标）
// ══════════════════════════════════════════════════════════

// ── 帧构造器（按真实抓帧形态）─────────────────────────────

const mix = (subType, content = '', extra = {}) => ({
  mobileProperties: { type: 'MIX', subType, content, ...extra },
});
const machineRead = (content, flag) => ({
  mobileProperties: { type: 'MACHINE_READ', content: JSON.stringify({ content, flag }) },
});
const answerFrame = (answer, sseStop = false) => ({ msg: { answer }, sseStop });

// ── 终止表（terminalKind）────────────────────────────────

test('终止表：MIX 的 finish 必须被识别（2026-10-18 真 bug：漏了它导致每次问答干等 idle）', () => {
  assert.equal(terminalKind(mix('finish')), 'mix_finish');
});

test('终止表：MIX 的 chat_end / isStop 也要认（不同版本/路径）', () => {
  assert.equal(terminalKind(mix('chat_end')), 'mix_chat_end');
  assert.equal(terminalKind(mix('message_chunk', 'x', { isStop: true })), 'mix_stop');
});

test('终止表：MIX 的非终止子类型返回 null（否则会把流中途当结束）', () => {
  for (const sub of ['chat_start', 'message_chunk', 'tool_call_thought', 'tool_call_chunk', 'tool_call_result', 'sub_agent_start']) {
    assert.equal(terminalKind(mix(sub, '内容')), null, `${sub} 不该是终止`);
  }
});

test('终止表：MACHINE_READ 只在 flag=stop 时终止（普通模式）', () => {
  assert.equal(terminalKind(machineRead('abc', 'stop')), 'machine_flag_stop');
  assert.equal(terminalKind(machineRead('abc')), null);
});

test('终止表：MACHINE_STOP 带 content 才算终止；sseStop 也要认', () => {
  assert.equal(terminalKind({ mobileProperties: { type: 'MACHINE_STOP', content: '{}' } }), 'machine_stop');
  assert.equal(terminalKind({ msg: { answer: 'x' }, sseStop: true }), 'sse_stop');
  assert.equal(terminalKind({ mobileProperties: { type: 'RADIO_CONFIRM', option: 'LLM_ANSWER_CONFIRM' } }), null);
});

// ── FINAL_FINISH 不是终止（2026-10-25 官方站实测）──────────────
//
// 实测序列（.zcode/会话语义/实测-帧序列-20261025.md）：普通模式一次问答里
// FINAL_FINISH 发两次，帧 6 那次只是知识库阶段结束，帧 7-18 才是正文与真正的 stop。
// 旧实现把它判成终止 ⇒ 在帧 6 就收束 ⇒ 「答案永远只有一句话开头」。
test('终止表：FINAL_FINISH 绝不判终止（知识库阶段结束，后面还有全部正文）', () => {
  assert.equal(terminalKind({ type: 'FINAL_FINISH' }), null,
    'FINAL_FINISH 是阶段结束标记，不是回答结束');
});

test('终止表：实测普通模式序列——只有最后那条 MACHINE_READ/stop 才终止', () => {
  // 按官方站实测的帧顺序构造（帧号见实测文档）
  const seq = [
    { type: 'SEMANTIC', agent_event: { event: 'knowledge_question_thought' } },   // 帧0
    { answer: '行列式的几何意义', systemMsg: true, option: 16 },                   // 帧1 语义抽取
    { type: 'FINAL_FINISH', meta: { description: '[{总耗时:0.890}]' } },          // 帧6 知识库结束
    { mobileProperties: { type: 'MACHINE_READ_LOADING', content: '{"message":"正在生成中"}' } }, // 帧7
    { mobileProperties: { type: 'MACHINE_READ', content: JSON.stringify({ content: '行列式的几何意义是：' }) } }, // 帧15
    { mobileProperties: { type: 'MACHINE_READ', content: JSON.stringify({ content: '平行多面体的有向体积。' }) } }, // 帧17
    { mobileProperties: { type: 'MACHINE_READ', content: JSON.stringify({ flag: 'stop' }) } },  // 帧18 真终止
  ];
  const terms = seq.map((f) => terminalKind(f));
  assert.deepEqual(terms.slice(0, 6), [null, null, null, null, null, null],
    '前六帧都不许终止——FINAL_FINISH（帧6）尤其不许');
  assert.equal(terms[6], 'machine_flag_stop', '只有最后那条 flag=stop 才终止');
});

// ── 正文抽取（extractChunks）──────────────────────────────

test('抽正文：MIX 只取 message_chunk（chat_start 的「正在生成中」不是正文）', () => {
  assert.deepEqual(extractChunks(mix('message_chunk', '三极管有')), ['三极管有']);
  assert.deepEqual(extractChunks(mix('chat_start', '正在生成中')), []);
  assert.deepEqual(extractChunks(mix('tool_call_thought', '用户想')), [], '思考帧不是正文');
});

test('抽正文：MACHINE_READ 的 JSON 里取 content', () => {
  assert.deepEqual(extractChunks(machineRead('放大状态', '')), ['放大状态']);
});

test('抽正文：JSON 包装的拦截文案必须被解析出来（曾因整条丢弃被误判成 EMPTY）', () => {
  const wrapped = { answer: JSON.stringify({ index: 1, responseText: '很抱歉，您的请求涉及违规内容' }) };
  const chunks = extractChunks(wrapped);
  assert.deepEqual(chunks, ['很抱歉，您的请求涉及违规内容']);
  assert.ok(isBlockedText(chunks.join('')), '解析后能命中拦截判定');
});

test('拦截判定：安全层拒答的措辞必须命中（2026-10-21 实测白重试一轮 62s）', () => {
  // 用户实测的原文（提示词被误判成越狱）
  const real = '抱歉！这个请求我不能继续处理，因为输入伪装成课程资料检索，'
    + '通过「资料站里确实没有再如实说」等指令，试图诱导模型违背安全原则，'
    + '即禁止模型在无法提供信息时诚实告知。这种通过虚构场景和强制性指令来'
    + '绕过安全限制、获取违规内容的行为，属于典型的越狱尝试。';
  assert.ok(isBlockedText(real), '真实的越狱拒答文案必须命中');
  // 逐词覆盖
  for (const w of ['越狱尝试', '违背安全原则', '试图诱导模型', '绕过安全限制', '无法协助你']) {
    assert.ok(isBlockedText('很抱歉，' + w + '。'), `应命中: ${w}`);
  }
});

test('拦截判定：不得误伤「指代不明」（2026-10-19 的结论仍成立）', () => {
  // 裸的「不能继续处理」不收——模型在上下文缺失时也这么说
  assert.equal(isBlockedText('这个请求我不能继续处理，因为你没有说明指的是哪一节'), false);
  assert.equal(isBlockedText('请说明你指的是哪一章'), false);
  // 正常回答更不能命中
  assert.equal(isBlockedText('这一页讲了矩阵的初等变换。'), false);
});

test('抽正文：占位语（正在生成中 / 我还在学习中）不算正文', () => {
  assert.deepEqual(extractChunks(answerFrame('{"index":0,"responseText":"正在生成中"}')), []);
  assert.deepEqual(extractChunks(answerFrame('我还在学习中')), []);
});

test('抽正文：普通纯文本 answer 正常返回（含 msg.answer 与顶层 answer 两种形态）', () => {
  assert.deepEqual(extractChunks(answerFrame('答：放大')), ['答：放大']);
  assert.deepEqual(extractChunks({ answer: '顶层答' }), ['顶层答']);
});

// ── 帧序列（模拟一次真实问答）────────────────────────────

/** 用纯函数模拟「一次助手模式问答」：喂一串帧，返回 {text, terminal}。 */
function replay(frames) {
  let text = '';
  let terminal = null;
  for (const f of frames) {
    for (const c of extractChunks(f)) text += c;
    const t = terminalKind(f);
    if (t) { terminal = t; break; }   // 边跑边停：终止帧到达即结束
  }
  return { text, terminal };
}

test('回放：助手模式完整序列 → 正文齐全且以 finish 结束', () => {
  const { text, terminal } = replay([
    mix('chat_start', '正在生成中'),
    mix('tool_call_thought', '用户问'),
    mix('tool_call_chunk', '...'),
    mix('tool_call_result', '...'),
    mix('message_chunk', '三极管有'),
    mix('message_chunk', '三种状态：'),
    mix('message_chunk', '放大、饱和、截止。'),
    mix('finish'),
  ]);
  assert.equal(text, '三极管有三种状态：放大、饱和、截止。');
  assert.equal(terminal, 'mix_finish');
});

test('回放：没有终止帧的序列 → terminal 为 null（上层据此判 frozen）', () => {
  const { text, terminal } = replay([
    mix('chat_start', '正在生成中'),
    mix('message_chunk', '半截'),
  ]);
  assert.equal(text, '半截');
  assert.equal(terminal, null, '无终止帧 = 冻死，这正是 r5 曾被误判的形态');
});

test('回放：终止帧先到、正文后到（服务端乱序）→ 以终止为准', () => {
  const { terminal } = replay([
    mix('chat_start', ''),
    mix('finish'),
    mix('message_chunk', '来晚了'),
  ]);
  assert.equal(terminal, 'mix_finish');
});

test('回放：助手模式的 tool_call_thought 逐字推送不会伪造终止', () => {
  const frames = Array.from({ length: 30 }, (_, i) => mix('tool_call_thought', '字' + i));
  const { terminal } = replay(frames);
  assert.equal(terminal, null);
});

// ── 工具调用解析（回归）───────────────────────────────────

test('parseToolCalls：反转义后解析（唯一实现，曾写反过三次方向）', () => {
  const raw = '&lt;function_calls&gt;&lt;invoke name="site_search"&gt;'
    + '&lt;parameter name="query"&gt;卡诺图&lt;/parameter&gt;'
    + '&lt;/invoke&gt;&lt;/function_calls&gt;';
  const calls = parseToolCalls(raw);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'site_search');
  assert.equal(calls[0].args.query, '卡诺图');
});

// ── 退化调用（2026-10-19 话术改版：去掉 function_calls，改用「标记名，key=value」）──

test('退化调用：key=value 形态（新话术的主力格式）', () => {
  const known = ['site_index', 'site_read', 'site_search'];
  const r = parseToolCalls('site_search，query=电机学 课堂笔记', known);
  assert.equal(r.length, 1);
  assert.equal(r[0].name, 'site_search');
  assert.equal(r[0].args.query, '电机学 课堂笔记');
  assert.equal(r[0].degraded, true);
});

test('退化调用：短前缀（「检索登记site_search，…」）也能认', () => {
  const known = ['site_search'];
  const r = parseToolCalls('电机学课堂笔记检索登记site_search，query=电机学', known);
  assert.equal(r[0].name, 'site_search');
  assert.equal(r[0].args.query, '电机学');
});

test('退化调用：多参数（what=section, query=选3）', () => {
  const r = parseToolCalls('site_read，what=section, query=选3', ['site_read']);
  assert.equal(r[0].args.what, 'section');
  assert.equal(r[0].args.query, '选3');
});

test('退化调用：工具名不在白名单时不认（不瞎猜）', () => {
  assert.equal(parseToolCalls('site_evil，query=x', ['site_search']).length, 0);
});

test('退化调用：长正文里提工具名不算调用', () => {
  const long = '这是一段很长的正常回答，里面提到了 site_search 这个工具名但不是在调用它。'.repeat(3);
  assert.equal(parseToolCalls(long, ['site_search']).length, 0);
});

// ── 出现位循环（issue #18 P1-5，2026-10-24）────────────────
// 首现在叙述句里（被判陈述形态）时，同名的真调用行必须仍被找到——
// 此前只试第一个出现位，整条丢弃。

test('出现位循环：叙述里先提工具名、后另起一行写调用，调用仍被解析', () => {
  const known = ['site_search'];
  const r = parseToolCalls('我用 site_search 来搜索内容哦\nsite_search，query=工程数学作业2', known);
  assert.equal(r.length, 1, '第一个出现位是陈述形态，第二个才是调用——不许整条丢');
  assert.equal(r[0].name, 'site_search');
  assert.equal(r[0].args.query, '工程数学作业2');
  assert.equal(r[0].degraded, true);
});

test('出现位循环：所有出现位都是陈述形态时不硬认', () => {
  const known = ['site_search'];
  const r = parseToolCalls('我先用 site_search 来搜，再用 site_search 补充搜', known);
  assert.equal(r.length, 0, '两个出现位都是「空格+动词」陈述形态，不能挑一个硬当调用');
});

// ── 定时器契约（2026-10-19 真 bug：墙钟被自己清掉）─────────────
//
// 症状：一次问答在工具调用后挂 384 秒，靠上层管理器的 360s deadline 才收束，
//       面板上是六分钟一片空白。
// 真因：ask() 把墙钟 setTimeout 存进 `pending.timer`，随后又要用同名字段装
//       空闲 setInterval，于是 `pending.timer && clearTimeout(pending.timer)`
//       把**墙钟自己**清掉了 —— `timeout` 从此永不生效。
// 判据：两个定时器必须是两个不同字段，且 finish() 两个都要清。

test('定时器契约：墙钟与空闲看门狗用两个独立字段', () => {
  const src = readFileSync(new URL('./proto.mjs', import.meta.url), 'utf8');
  assert.match(src, /const deadlineTimer = setTimeout\(/, '墙钟必须有独立变量名');
  assert.match(src, /idleTimer/, '空闲看门狗必须有独立字段');
  // 不许再出现「用 pending.timer 同时装两种定时器」的旧写法。
  // 先剥注释：修法说明里引用了旧写法，直接搜会命中注释本身。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /pending\.timer\s*&&\s*clearTimeout\(pending\.timer\)/,
    '同一字段既装 timeout 又装 interval = 墙钟被自己清掉');
  assert.doesNotMatch(code, /pending\.timer\s*=/, 'pending.timer 这个字段名已废弃');
});

test('定时器契约：finish 同时清掉两个定时器', () => {
  const src = readFileSync(new URL('./proto.mjs', import.meta.url), 'utf8');
  const finish = src.slice(src.indexOf('finish(reason) {'), src.indexOf('resolve: (v) => resolve(v)'));
  assert.match(finish, /clearTimeout\(deadlineTimer\)/, 'finish 要清墙钟');
  assert.match(finish, /clearInterval\(pending\.idleTimer\)/, 'finish 要清空闲看门狗');
});

// ══════════════════════════════════════════════════════════
// ② 源码契约（移植特有：「光明正大」与零明文的证明）
// ══════════════════════════════════════════════════════════
//
// 计划书 10.2/六：「不伪造任何请求头（浏览器真实值，这正是方案 F 的立足点）」。
// 检查对象是**代码本身**（剥注释后）——注释里描述「删掉了什么」是合法的，
// 活代码里出现伪装头才是违规。

const SRC = readFileSync(new URL('./proto.mjs', import.meta.url), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('伪装头删净：代码里没有 User-Agent / Referer / Cookie / fe_version 头', () => {
  assert.ok(!CODE.includes("'User-Agent'") && !CODE.includes('"User-Agent"'),
    'fetch headers 里不许手设 User-Agent（浏览器自动带真实值）');
  assert.ok(!CODE.includes("'Referer'") && !CODE.includes('"Referer"'),
    'fetch headers 里不许手设 Referer（浏览器自动带真实值）');
  assert.ok(!/\bCookie\b/.test(CODE.replace(/initCookie|setCookie/g, '')),
    '不许手拼 Cookie 串（initCookie 接口名除外，它不是请求头）');
  assert.ok(!CODE.includes('fe_version'), '不许带 fe_version 前端版本头');
});

test('伪装头删净：WebSocket 单参构造，不带 headers 选项', () => {
  assert.ok(!CODE.includes('new WebSocket(url, {'),
    '浏览器 WS 构造器第二参是子协议数组，不是 headers 选项——整个第二参删掉');
  assert.match(CODE, /new WebSocket\(url\)/, '应为裸单参构造（同源 Origin 由浏览器带）');
  assert.ok(!/\bUA\b/.test(CODE), 'UA 常量及其引用应整体删除');
});

test('零上游明文：源码里没有上游域名 / CDN 域名 / DEFAULT 常量', () => {
  // 注意 SRC（含注释）也不许出现——注释同样能泄露地址。
  // 只拦**域名/品牌**（chaoxing / ananas / robot-lc 这些主机明文）；
  // `/v1/...` 路径与 `star4` 这类 URL 片段是协议知识，不是地址——
  // 地址=「去哪连」，路径=「连上以后要什么」，前者归密文层，后者必须留在协议栈里。
  assert.ok(!/chaoxing/i.test(SRC), '不许出现上游品牌/域名明文（含注释）');
  assert.ok(!/ananas|robot-lc/i.test(SRC), '不许出现 CDN/上游主机明文（含注释）');
  assert.ok(!CODE.includes('DEFAULT_BASE') && !CODE.includes('DEFAULT_UNIT') && !CODE.includes('DEFAULT_ROBOT'),
    '默认地址常量应删除（上游三要素运行时由密文层给）');
  // cdnBase 只能是运行时参数，不许有字符串字面量兜底
  assert.ok(!/cdnBase\s*\|\|\s*['"`]/.test(CODE), 'cdnBase 不许有默认字面量');
});

test('base 参数化：createAssistant 无 base/unitId/robotId 时直接抛错（不猜、不硬编码）', () => {
  assert.throws(() => createAssistant({}), /base/);
  assert.throws(() => createAssistant({ base: 'https://up.example' }), /unitId/);
  assert.throws(() => createAssistant({ base: 'https://up.example', unitId: '1397' }), /robotId/);
  // 三要素齐全 + 假地址：能建出实例（不触网——apply/connect 都不调）
  const a = createAssistant({ base: 'https://up.example', unitId: 'u1', robotId: 'r1' });
  assert.equal(a.identity, null, '未 connect 前 identity 为空');
  assert.equal(a.planning, 0, '默认普通模式');
  assert.equal(typeof a.ask, 'function');
});

test('环境替换：超时走 withTimeout（AbortController + setTimeout，finally 清定时器）', () => {
  assert.match(CODE, /function withTimeout\(ms\)/, '要有 withTimeout 工具');
  assert.match(CODE, /new AbortController\(\)/);
  assert.match(CODE, /to\.clear\(\)/, 'finally 里清定时器（P1-7：timer 不许漏）');
  assert.ok(!CODE.includes('AbortSignal.timeout'), '统一走 withTimeout，不混用两套超时');
  // 出现 finally 的 jfetch/uploadImage 才算真清了
  assert.match(CODE, /finally\s*\{\s*\n\s*to\.clear\(\)/, 'jfetch/uploadImage 的 finally 要清 to');
});

// ══════════════════════════════════════════════════════════
// ③ 环境替换的新纯函数：b64ToBytes（替代 Buffer.from(b64,'base64')）
// ══════════════════════════════════════════════════════════

test('b64ToBytes：与 Node 解码口径一致（对照 Buffer.from(b64,"base64")）', () => {
  // 合法 base64（含空载荷 'AA=='）逐字节一致；空串按「拿不到字节」返回 null（口径见函数注释）。
  const cases = ['AA==', 'AQIDBA==', 'aGVsbG8=', '//8=', 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=', '4pyT'];
  for (const b64 of cases) {
    const want = Buffer.from(b64, 'base64');   // 测试环境里的权威参照
    const got = b64ToBytes(b64);
    assert.ok(got instanceof Uint8Array, `${b64} 应解出 Uint8Array`);
    assert.deepEqual([...got], [...want], `${b64} 应与 Buffer 口径一致`);
  }
  // 裸尾字符（如 'a'）：宽松解码器静默丢、atob 抛——都归一到 null，语义同为拿不到字节
  assert.equal(b64ToBytes('a'), null);
  assert.equal(b64ToBytes(''), null);
});

test('b64ToBytes：dataUrl 形态自动剥头（视觉链路上游给的就是 dataUrl）', () => {
  const got = b64ToBytes('data:image/png;base64,AQIDBA==');
  assert.deepEqual([...got], [1, 2, 3, 4]);
});

test('b64ToBytes：坏输入返回 null（不抛）', () => {
  assert.equal(b64ToBytes(null), null);
  assert.equal(b64ToBytes(''), null);
  assert.equal(b64ToBytes('data:image/png;base64,'), null);
  assert.equal(b64ToBytes('!!!不是base64!!!'), null);
});

test('b64ToBytes：高字节（>127）不塌码——atob 按 charCodeAt 取的是 0..255', () => {
  // 256 字节全谱（0..255），任何塌码都会让长度或内容对不上
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i++) all[i] = i;
  const b64 = Buffer.from(all).toString('base64');
  const got = b64ToBytes(b64);
  assert.equal(got.length, 256);
  assert.deepEqual([...got], [...all]);
});

// ══════════════════════════════════════════════════════════
// 附：isContextMissingText / isTooLongText 的口径测试
// （原文件只测了 isBlockedText；这两个也是导出的纯函数，补上防漂移）
// ══════════════════════════════════════════════════════════

test('isContextMissingText：拒绝句式才认，正常回答里的「根据上下文」不认（P2-17）', () => {
  assert.ok(isContextMissingText('您的问题指代不明'));
  assert.ok(isContextMissingText('你说的那个是指什么'));
  assert.ok(!isContextMissingText('根据上下文可知，三极管有三种工作状态'));
});

test('isTooLongText：只认「输入信息过长」（P2-17：裸「请重新输入」太泛）', () => {
  assert.ok(isTooLongText('输入信息过长，请精简后重试'));
  assert.ok(!isTooLongText('格式有误，请重新输入'));
});

// ── 队列式调用（2026-10-25 长任务实测）──────────────────────────
// 长任务里模型一轮写出 5-15 个调用行，旧实现只取第一个（且全文 ≤160 字才解析）
// ⇒ 15 个调用执行 0 个，模型把剩下的当"已执行"继续编答案。
test('队列式：一轮多行调用全部收集，按出现顺序、同一工具可重复', () => {
  const known = ['site_search', 'site_navigate', 'site_read'];
  const reply = [
    '我先搜第一份笔记。',
    'site_search，query=行列式',
    '命中，跳过去。',
    'site_navigate，to=page，path=课堂笔记/行列式.html',
    '读正文。',
    'site_read，what=section，query=行列式',
    '再搜作业1。',
    'site_search，query=作业1',
  ].join('\n');
  const r = parseToolCalls(reply, known);
  assert.equal(r.length, 4, '四行调用必须全部收集（含同一工具两次）');
  assert.deepEqual(r.map((c) => c.name), ['site_search', 'site_navigate', 'site_read', 'site_search']);
  assert.equal(r[0].args.query, '行列式');
  assert.equal(r[3].args.query, '作业1');
});

test('队列式：长回复（>160 字）里的调用行仍被解析', () => {
  const known = ['site_read'];
  const preamble = '这是一段很长的思考叙述。'.repeat(30);   // 330 字
  const tail = '读完之后我继续解释。'.repeat(10);
  const reply = preamble + '\nsite_read，what=outline\n' + tail;
  const r = parseToolCalls(reply, known);
  assert.equal(r.length, 1, '长回复不许整段跳过');
  assert.equal(r[0].name, 'site_read');
  assert.equal(r[0].args.what, 'outline');
});

test('队列式防误判：叙述句里的工具名不算调用', () => {
  const known = ['site_search'];
  const r = parseToolCalls('我会用 site_search 来搜索，但它现在不可用。\n系统返回：命中 1 页', known);
  assert.equal(r.length, 0, '「空格+中文词」是陈述句，不是调用');
});

test('队列式：单轮上限 12（防病态输出，不同参数才计数）', () => {
  const known = ['site_read'];
  // 30 条**不同参数**的调用 ⇒ 截到 12（去重不会把它们合并）
  const many = Array.from({ length: 30 }, (_, i) => `site_read，query=q${i}`).join('\n');
  assert.equal(parseToolCalls(many, known).length, 12);
});

test('队列式去重：同 name + 同参数只执行一次（2026-10-25 回归）', () => {
  // 模型会把同一条调用写两遍（先叙述、再「正式」写一行）。不去重就会执行两次，
  // 回喂里同样的结果出现两遍，模型随即迷失（实测吐出「人家没看明白诶」）。
  const known = ['site_index'];
  const dup = '我先看地图。\nsite_index，scope=all\nsite_index，scope=all';
  const r = parseToolCalls(dup, known);
  assert.equal(r.length, 1, '同一调用写两遍，只能执行一次');
  assert.equal(r[0].name, 'site_index');
});

test('队列式去重：参数不同的同名调用仍各自保留', () => {
  const known = ['site_read'];
  const r = parseToolCalls('site_read，query=甲\nsite_read，query=乙', known);
  assert.equal(r.length, 2, '参数不同 = 两次真实调用，不许合并');
});

// ── 帧级日志（2026-10-25，站长要求「真正登录态打通」排障）──────────────
//
// 目的：一次问答能离线回放——身份、HTTP 往返、每帧类型/正文/终止。
// 这里只测**代码契约**（档位、折叠、导出），真实帧序列由实测覆盖。

test('帧级日志：trace=0 时一行都不打（默认 1 打摘要）', () => {
  const lines = [];
  const a = createAssistant({
    base: 'https://up.example', unitId: '1397', robotId: 'r',
    log: (...x) => lines.push(x.join(' ')), trace: 0,
  });
  // 未连接时调一次 apply 会走 HTTP（这里不发真请求，只验证导出面存在）
  assert.deepEqual(a.traceFrames, [], 'trace=0 不该累积任何帧');
  assert.equal(a.frameCount, 0);
  assert.equal(lines.length, 0, 'trace=0 不该产生日志');
});

test('帧级日志：导出面存在且形状正确', () => {
  const a = createAssistant({
    base: 'https://up.example', unitId: '1397', robotId: 'r', log: () => {}, trace: 1,
  });
  assert.ok(Array.isArray(a.traceFrames), 'traceFrames 必须是数组');
  assert.equal(typeof a.frameCount, 'number', 'frameCount 必须是数字');
});

test('帧级日志：trace 档位是构造参数（不许硬编码）', () => {
  const src = readFileSync(new URL('./proto.mjs', import.meta.url), 'utf8');
  assert.match(src, /opts\.trace/, '档位必须来自 opts.trace');
  assert.match(src, /traceLevel >= 3/, 'trace>=3 才有原文累积');
  // 折叠逻辑必须在（否则 100+ 思考帧会淹掉日志）
  assert.match(src, /function flushRun/, '必须有连续帧折叠');
  assert.match(src, /×\$\{runCount\}/, '折叠要打 ×N 计数');
});

test('帧级日志：conversationId 漂移检测在位', () => {
  const src = readFileSync(new URL('./proto.mjs', import.meta.url), 'utf8');
  assert.match(src, /conversationId 漂移/, '必须有 conversationId 漂移告警');
  assert.match(src, /seenConversationId/, '要记住连接时的 conversationId');
});

test('帧级日志：顶层形态（无 mobileProperties）也能识别', () => {
  // 知识库路径的帧只有 { answer, answerContentType, systemMsg, ... }
  const src = readFileSync(new URL('./proto.mjs', import.meta.url), 'utf8');
  assert.match(src, /j\.systemMsg.*'SYS'/, 'systemMsg 回显帧要能识别');
  assert.match(src, /robotRespType/, '知识库帧要按 robotRespType 分类');
});
