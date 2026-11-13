#!/usr/bin/env node
/**
 * 学习通作业逐题爬取（2026-11-13 实测跑通，变压器训练用 56 题）
 *
 * 原理（详见 工具/查学习通作业.md 第八节）：
 *   GET /mooc-ans/work/phone/doHomeWork?…&index=N 逐题拉，index 0 起。
 *   ⚠️ 不要点「下一题」按钮——submitOnce 只放一轮、循环点被吞。
 *   正确做法是导航式逐题 GET，每题独立、无状态。
 *
 * 用法：
 *   node 工具/学习通爬题.mjs <配置JSON>
 * 配置 JSON 形如：
 *   {
 *     "base": "https://mooc1-api.chaoxing.com",
 *     "courseId": "249967970", "classId": "154248884",
 *     "workId": "58075489", "workAnswerId": "55188493",
 *     "enc": "f4e8354c5f6895742261952849c9316b",
 *     "total": 56,
 *     "out": "/tmp/chaoxing-变压器56题.json"
 *   }
 * 参数来源：workId/enc 从列表 <li data> 拿；workAnswerId 在 doHomeWork 表单 hidden。
 * 输出：{ work, fetched, questions:[{ index, questionId, stem, options[] }] }
 */

import fs from 'node:fs';

const WB = 'http://127.0.0.1:10086/command';
const SESSION = 'chaoxing-crawler';

async function ev(code) {
  const r = await fetch(WB, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'evaluate', args: { code }, session: SESSION }),
  });
  return r.json();
}

function clean(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

async function detectTotal(cfg) {
  // 从 task-work 骨架页拿「共包含 N 道题目」，避免硬编码题数
  const url = `${cfg.base}/mooc-ans/work/phone/task-work`
    + `?taskrefId=${cfg.workId}&courseId=${cfg.courseId}&classId=${cfg.classId}`
    + `&userId=${cfg.userId || ''}&role=&source=0&enc_task=${cfg.enc}`
    + `&cpi=${cfg.cpi || ''}&vx=0&fromGroup=0`;
  const code = `(async () => { const r = await fetch(${JSON.stringify(url)}, { credentials: "include" }); return await r.text(); })()`;
  const res = await ev(code);
  const html = res.data?.value || '';
  const m = html.match(/共包含\s*(\d+)\s*道题目/) || html.match(/共包含(\d+)道/);
  if (!m) throw new Error('无法从 task-work 页探测题目总数');
  return Number(m[1]);
}

async function fetchQuestion(cfg, index) {
  const url = `${cfg.base}/mooc-ans/work/phone/doHomeWork`
    + `?courseId=${cfg.courseId}&classId=${cfg.classId}&workId=${cfg.workId}`
    + `&workAnswerId=${cfg.workAnswerId}&knowledgeid=0&enc=${cfg.enc}`
    + `&mooc=1&source=0&index=${index}`;
  // 在页面上下文 fetch（同源带 cookie），返回纯 HTML 字符串
  const code = `(async () => { const r = await fetch(${JSON.stringify(url)}, { credentials: "include" }); return await r.text(); })()`;
  const res = await ev(code);
  if (!res.data || res.data.type !== 'string') {
    return { index, error: 'fetch failed: ' + (res.error?.message || 'no data') };
  }
  const html = res.data.value;
  // 题干：singleQuesId 区域里第一个 <p>
  const qStart = html.indexOf('singleQuesId');
  const seg = qStart >= 0 ? html.slice(qStart, qStart + 6000) : html;
  const ps = [...seg.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
    .map((m) => clean(m[1])).filter(Boolean);
  const stem = ps[0] || '';
  // 选项：span.choose 的 aria-label（「选项B.铁芯损耗不变、铜损耗变大」）
  const opts = [...seg.matchAll(/aria-label="([^"]*选项[^"]*)"/g)]
    .map((m) => clean(m[1])).filter(Boolean);
  // 题面里的图（2026-11-13 加）：公式图（ananas/latex）与配图都收。
  // 公式图是题干的 LaTeX 渲染结果——只抓文本会丢公式，图 URL 必须带着。
  // 判断题没有选项（对/错是固定的），options 留空即可。
  const imgs = [...new Set([...seg.matchAll(/<img[^>]+src="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((s) => /ananas|chaoxing|aliyuncs/i.test(s) && !/popClose|loading|prev_new|next_new/.test(s))
    .map((s) => (s.startsWith('//') ? 'https:' + s
      : (s.startsWith('/') ? 'https://mooc1.chaoxing.com' + s : s))))];
  // 题号与 questionId
  const qid = (html.match(/id="questionId"[^>]*value="([^"]+)"/) || [])[1] || '';
  const idx = (html.match(/id="index"[^>]*value="([^"]+)"/) || [])[1] || String(index);
  return { index: Number(idx), questionId: qid, stem, options: opts, images: imgs };
}

async function nav(url) {
  const r = await fetch(WB, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'navigate', args: { url, newTab: true, group_title: '学习通爬题' }, session: SESSION }),
  });
  return r.json();
}

async function main() {
  const cfgPath = process.argv[2];
  if (!cfgPath) { console.error('用法: node 工具/学习通爬题.mjs <配置JSON>'); process.exit(1); }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  // 先导航到作业列表建立会话（WebBridge 要求 session 有 tab 才能 evaluate）
  await nav(cfg.base + '/work/stu-work?vx=0');
  await new Promise((r) => setTimeout(r, 1500));
  // 题数不硬编码：从 task-work 骨架页探测「共包含 N 道题目」
  const total = cfg.total ? Number(cfg.total) : await detectTotal(cfg);
  console.log('探测到题目总数:', total);
  const out = { work: cfg.workId, title: cfg.title || '', fetchedAt: new Date().toISOString(),
    questions: [] };
  for (let i = 0; i < total; i++) {
    const q = await fetchQuestion(cfg, i);
    out.questions.push(q);
    process.stdout.write(`\r[${i + 1}/${total}] ${q.questionId} ${q.stem.slice(0, 30)}`);
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log('\n抓取完成');
  fs.writeFileSync(cfg.out, JSON.stringify(out, null, 1), 'utf8');
  console.log('已写出:', cfg.out, '| 题目数:', out.questions.length);
  const bad = out.questions.filter((q) => !q.stem);
  if (bad.length) console.warn('⚠️ 空题干:', bad.length, '题');
}

main().catch((e) => { console.error(e); process.exit(1); });
