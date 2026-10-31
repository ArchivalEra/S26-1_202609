// 段位模块（`lib/site-url.mjs`）的契约闸门。
//
// ## 这个模块为什么存在
//
// 2026-10-31 修 GitRoll 时，`read-core.mjs` 里同时散着**四份手抄的路径规则**：
// `courseOf` / `categoryOf` / `resolveRef` / `catalog-source.pages()`。
// 四份 = 四个会漂的点，而且代价已经付过一次：仓库把 `课程/` 改名成 `课程总览/`，
// 读层按课程过滤**静默失效**（不报错，只是永远过滤掉所有命中），11 条测试红了
// 很久没人知道原因。
//
// 现在收成一个深模块：五个纯函数，顶层目录名只出现一次。
//
// ## 这条闸门测什么
//
// ① **互逆性**：`toUrl(toSource(u)) === u`，覆盖首页/目录页/普通页三个边界；
// ② **克隆等价**：`toUrl` 复刻了构建期 `htmlPathOf` 的三条分支 —— 必须对同一输入
//    给出同一结果。这不是「重复实现」，是**刻意解耦**（读层不引构建期模块，
//    那会拖进 CSS/JS 常量），代价是必须用测试锁住两者等价；
// ③ **顶层目录名只有一份**：`read-core` 里不许再出现 `'课程总览'` 字面；
// ④ **判据是「第一段是顶层目录」**，不是「第二段像课程名」——后者在
//    `README.md` / `维护条例.md` 这类站点级页面上会误报。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TOP_DIR, HOME_SOURCE, segmentsOf, courseOf, categoryOf, toSourcePath, toUrl, toSource,
} from '../lib/site-url.mjs';
import { htmlPathOf } from '../../../站点/plugins/nav-structure.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, '../lib');

test('互逆：toUrl 与 toSource 在三个边界上互为反函数', () => {
  const cases = [
    '',                          // 首页（网址是空串）
    `${TOP_DIR}/`,               // 顶层目录索引
    `${TOP_DIR}/工程数学/`,       // 课程索引
    `${TOP_DIR}/工程数学/作业/`,  // 类目索引
    `${TOP_DIR}/工程数学/作业/作业1.html`, // 普通页
  ];
  for (const u of cases) {
    assert.equal(toUrl(toSource(u)), u, `toUrl(toSource('${u}')) 应等于 '${u}'`);
  }
  assert.equal(toSource(''), HOME_SOURCE, '首页网址空串对应 README.md');
  assert.equal(toSource(`${TOP_DIR}/`), `${TOP_DIR}/index.md`, '目录网址对应 index.md');
});

test('克隆等价：toUrl 与构建期 htmlPathOf 对同一输入给出同一结果', () => {
  // 读层刻意不 import 构建期模块（那会拖进 CSS/JS 常量）。代价就是这条断言：
  // 两边规则必须一直等价，谁改了另一处都要在这里红。
  const sources = [
    'README.md',
    '维护条例.md',
    `${TOP_DIR}/index.md`,
    `${TOP_DIR}/工程数学/index.md`,
    `${TOP_DIR}/工程数学/作业/index.md`,
    `${TOP_DIR}/工程数学/作业/作业1.md`,
    `${TOP_DIR}/电路原理/作业/习题册第二章.md`,
    '站点/符号包/通用.md',
  ];
  for (const src of sources) {
    assert.equal(toUrl(src), htmlPathOf(src),
      `'${src}' 的网址：本模块给 '${toUrl(src)}'，构建期给 '${htmlPathOf(src)}' —— 两边必须一致`);
  }
});

test('课程/类目判据：第一段必须是顶层目录（不是「第二段像课程名」）', () => {
  // 反例优先：站点级页面的第二段可能是任意文字，不能靠它猜课程。
  assert.equal(courseOf('README.md'), '', '首页没有课程');
  assert.equal(courseOf('维护条例.md'), '', '站点级页面没有课程');
  assert.equal(courseOf(`${TOP_DIR}/index.md`), '', '顶层目录本身没有课程');
  assert.equal(courseOf(`${TOP_DIR}/工程数学/index.md`), '工程数学');
  assert.equal(courseOf(`${TOP_DIR}/工程数学/作业/作业1.html`), '工程数学');
  assert.equal(categoryOf(`${TOP_DIR}/工程数学/作业/作业1.html`), '作业');
  assert.equal(categoryOf(`${TOP_DIR}/工程数学/index.md`), '', '课程索引没有类目');
});

test('segmentsOf：去掉首尾斜杠后分段（`课程总览/` 与 `课程总览` 同结果）', () => {
  assert.deepEqual(segmentsOf(`${TOP_DIR}/`), [TOP_DIR]);
  assert.deepEqual(segmentsOf(TOP_DIR), [TOP_DIR]);
  assert.deepEqual(segmentsOf('/' + TOP_DIR + '/工程数学/'), [TOP_DIR, '工程数学']);
  assert.deepEqual(segmentsOf(''), []);
});

test('toSourcePath：三项都要给，缺一返回 null（不拼半个路径）', () => {
  assert.equal(toSourcePath({ course: '工程数学', category: '作业', file: '作业1.md' }),
    `${TOP_DIR}/工程数学/作业/作业1.md`);
  assert.equal(toSourcePath({ course: '工程数学', category: '作业' }), null);
  assert.equal(toSourcePath({}), null);
});

test('顶层目录名只在这个模块里出现（read-core 不许再写死）', () => {
  // 这是本模块存在的核心理由：改名 = 改一个常量，不是 grep 全仓。
  const rc = fs.readFileSync(path.join(LIB, 'read-core.mjs'), 'utf8');
  assert.ok(!new RegExp(`'${TOP_DIR}'`).test(rc),
    `read-core.mjs 里又出现 '${TOP_DIR}' 字面 —— 顶层目录名只该在 site-url.mjs 里出现一次`);
  const cat = fs.readFileSync(path.join(LIB, 'catalog-source.mjs'), 'utf8');
  assert.ok(!new RegExp(`'${TOP_DIR}'`).test(cat),
    `catalog-source.mjs 里又出现 '${TOP_DIR}' 字面`);
});
