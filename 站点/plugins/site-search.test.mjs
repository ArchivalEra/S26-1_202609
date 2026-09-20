/**
 * 自持搜索模块的测试（node:test，零依赖）。
 * 重点：折叠规则、正文抽取（KaTeX/行内标签/块级边界）、短语相邻校验、构建产物可用性，
 * 以及 **SEARCH_JS 内联的纯函数与模块版本行为一致**——两边算法一旦分叉，线上就会出现
 * 「本地测得好、浏览器搜不到」这种最难查的问题。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  foldSearchText,
  queryGrams,
  hashGram,
  verifyPhrase,
  sectionForPosition,
  countOccurrences,
  makeSnippet,
  scoreSearchHit,
  gramPositions,
  extractSearchDoc,
  buildSearchBundle,
  decodeHtmlEntities,
  SEARCH_JS,
  SEARCH_CSS
} from './site-search.mjs';

// ---------------------------------------------------------------- 折叠

test('foldSearchText 合并汉字旁的空格、保留字母数字之间的空格', () => {
  assert.equal(foldSearchText('第 1 章'), '第1章');
  assert.equal(foldSearchText('矩阵 MATLAB'), '矩阵matlab');
  assert.equal(foldSearchText('rank a'), 'rank a');
  assert.equal(foldSearchText('行列 式 的 性质'), '行列式的性质');
});

test('foldSearchText 走 NFKC 且小写', () => {
  assert.equal(foldSearchText('Ａ（１）'), 'a(1)');
  assert.equal(foldSearchText('SciPy'), 'scipy');
});

test('foldSearchText 保留段落边界（换行），只折叠段内空白', () => {
  assert.equal(foldSearchText('第一段  内容\n\n第二段'), '第一段内容\n第二段');
});

test('decodeHtmlEntities 处理命名与数字实体', () => {
  assert.equal(decodeHtmlEntities('A &amp; B &lt;x&gt; &#20013; &#x4e2d;'), 'A & B <x> 中 中');
  assert.equal(decodeHtmlEntities('&unknown;'), '&unknown;');
});

// ---------------------------------------------------------------- 正文抽取

test('extractSearchDoc 排除 KaTeX 与脚本，保留正文', () => {
  const html = `
    <div class="article-content">
      <p>行列式的定义</p>
      <span class="katex"><span class="katex-mathml"><math><annotation>\\begin{vmatrix}a&amp;b\\\\c&amp;d\\end{vmatrix}</annotation></math></span><span class="katex-html">ad−bc</span></span>
      <script>var x = "噪声";</script>
      <p>沙路法则</p>
    </div>`;
  const doc = extractSearchDoc(html, { url: '/a', title: 'A' });
  assert.ok(doc.text.includes('行列式的定义'));
  assert.ok(doc.text.includes('沙路法则'));
  assert.ok(!doc.text.includes('begin{vmatrix}'));
  assert.ok(!doc.text.includes('噪声'));
});

test('extractSearchDoc 行内标签不留分隔符，块级标签留边界', () => {
  const doc = extractSearchDoc('<p>用<strong>行列</strong>式计算</p><p>下一段</p>', { url: '/a' });
  assert.ok(doc.text.includes('用行列式计算'), `实际：${JSON.stringify(doc.text)}`);
  assert.ok(doc.text.includes('式计算\n下一段'), `实际：${JSON.stringify(doc.text)}`);
});

test('extractSearchDoc 抽出带锚点的小标题及其偏移', () => {
  const html = '<h2 id="sym-rowcol">符号族</h2><p>正文甲</p><h3 id="sym-power">幂次</h3><p>正文乙</p>';
  const doc = extractSearchDoc(html, { url: '/a' });
  assert.equal(doc.headings.length, 2);
  assert.equal(doc.headings[0].a, 'sym-rowcol');
  assert.equal(doc.headings[1].a, 'sym-power');
  assert.equal(doc.text.slice(doc.headings[0].s, doc.headings[0].s + 3), '符号族');
  assert.ok(sectionForPosition(doc.headings, doc.headings[1].s + 2).a === 'sym-power');
  assert.ok(sectionForPosition(doc.headings, 0).a === 'sym-rowcol');
});

// ---------------------------------------------------------------- 短语校验

test('verifyPhrase 要求逐字相邻', () => {
  // 「沙路法则」的 bigram：沙路(0) 路法(1) 法则(2)
  assert.deepEqual(verifyPhrase([[0], [1], [2]]), [0]);
  assert.deepEqual(verifyPhrase([[10], [11], [12]]), [10]);
  // 散落出现（不连续）不应命中
  assert.deepEqual(verifyPhrase([[0], [5], [9]]), []);
  // 顺序反了不应命中
  assert.deepEqual(verifyPhrase([[9], [5], [0]]), []);
});

test('verifyPhrase 返回全部命中点', () => {
  assert.deepEqual(verifyPhrase([[0, 7, 20], [1, 8, 21], [2, 9, 22]]), [0, 7, 20]);
});

test('gramPositions 不跨段、不含空白的 gram', () => {
  const map = gramPositions('ab cd\nef');
  assert.ok(map.has('ab'));
  assert.ok(!map.has('b '));
  assert.ok(!map.has('d\n'));
  assert.ok(map.has('ef'));
});

test('小标题同时给出匹配文本 t 与原样显示文本 d', () => {
  const doc = extractSearchDoc('<h2 id="a">开始之前：前置检查（必读）</h2><p>正文</p>', { url: '/x' });
  assert.equal(doc.headings[0].t, '开始之前:前置检查(必读)');   // 折叠后：全角标点变半角
  assert.equal(doc.headings[0].d, '开始之前：前置检查（必读）'); // 显示时保持原样
});

test('位置映射用的是折叠后正文的偏移，且能定位到小节', () => {
  const doc = extractSearchDoc('<h2 id="s1">甲</h2><p>无关内容</p><h2 id="s2">乙</h2><p>这里出现沙路法则</p>', { url: '/x' });
  const index = doc.text.indexOf('沙路法则');
  assert.equal(sectionForPosition(doc.headings, index).a, 's2');
});

// ---------------------------------------------------------------- 打分与摘要

test('scoreSearchHit 标题命中优先于正文命中', () => {
  const titleHit = scoreSearchHit({ titleHit: true, titleExact: true, headingHits: 0, total: 1, firstPos: 0, chars: 5000 });
  const bodyHit = scoreSearchHit({ titleHit: false, titleExact: false, headingHits: 0, total: 6, firstPos: 0, chars: 5000 });
  assert.ok(titleHit > bodyHit, `${titleHit} 应大于 ${bodyHit}`);
});

test('makeSnippet 标出命中并给出总数', () => {
  const text = '前文'.repeat(40) + '沙路法则' + '后文'.repeat(40) + '沙路法则';
  const snippet = makeSnippet(text, '沙路法则', { radius: 10 });
  assert.equal(snippet.total, 2);
  assert.ok(snippet.html.includes('<mark>沙路法则</mark>'));
  assert.ok(snippet.html.startsWith('…'));
});

test('countOccurrences 不重复计数重叠之外的位置', () => {
  assert.equal(countOccurrences('aaaa', 'aa'), 2);
  assert.equal(countOccurrences('abc', 'z'), 0);
});

// ---------------------------------------------------------------- 构建产物

function buildFixture() {
  const docs = [
    extractSearchDoc('<h2 id="s1">沙路法则</h2><p>沙路法则只适用于二三阶行列式，别乱用。</p>', { url: '/sand.html', title: '沙路法则' }),
    extractSearchDoc('<h2 id="s2">矩阵</h2><p>银行排队的方式与沙、路、法、则无关，这里是散落的字。</p>', { url: '/bank.html', title: '矩阵入门' }),
    extractSearchDoc('<h2 id="s3">行列式</h2><p>二阶与三阶行列式的计算方法。</p>', { url: '/det.html', title: '行列式' })
  ];
  return buildSearchBundle(docs, { buckets: 8 });
}

test('buildSearchBundle 产出 index/桶/正文三类文件', () => {
  const { files, stats } = buildFixture();
  assert.ok(files['search/index.json']);
  assert.ok(files['search/t/0.json']);
  assert.ok(files['search/g/0.json']);
  assert.equal(stats.pages, 3);
  const index = JSON.parse(files['search/index.json']);
  assert.equal(index.buckets, 8);
  assert.equal(index.docs.length, 3);
  assert.equal(index.docs[0].url, '/sand.html');
});

// 在 Node 里重放客户端那套流程（取桶 → 短语校验），验证真实检索行为。
function searchInBundle(files, rawQuery) {
  const data = JSON.parse(files['search/index.json']);
  const query = foldSearchText(rawQuery);
  const grams = queryGrams(query);
  const buckets = new Map();
  for (const gram of grams.bigrams.concat(grams.unigrams)) {
    const number = hashGram(gram) % data.buckets;
    if (!buckets.has(number)) buckets.set(number, JSON.parse(files[`search/g/${number}.json`]));
  }
  const hitUrls = [];
  for (const doc of data.docs) {
    let matched = false;
    if (grams.bigrams.length) {
      const perGram = grams.bigrams.map((gram) => {
        const bucket = buckets.get(hashGram(gram) % data.buckets);
        return bucket && bucket.grams[gram] ? bucket.grams[gram][doc.id] : undefined;
      });
      if (!perGram.some((postings) => !postings)) {
        matched = verifyPhrase(perGram).length > 0;
      }
    } else {
      const lists = grams.unigrams.map((ch) => {
        const bucket = buckets.get(hashGram(ch) % data.buckets);
        return bucket && bucket.uni[ch] ? bucket.uni[ch] : undefined;
      });
      matched = !lists.some((list) => !list || list.indexOf(doc.id) < 0);
    }
    if (!matched && foldSearchText(doc.title).indexOf(query) >= 0) matched = true;
    if (matched) hitUrls.push(doc.url);
  }
  return hitUrls;
}

test('中文按字面子串命中：散落同字不算命中', () => {
  const { files } = buildFixture();
  assert.deepEqual(searchInBundle(files, '沙路法则').sort(), ['/sand.html']);
  assert.deepEqual(searchInBundle(files, '法则沙路'), []);            // 顺序反了不算
  assert.ok(searchInBundle(files, '砂路法则').length === 0);          // 生造词不命中
  assert.deepEqual(searchInBundle(files, '行列式').sort(), ['/det.html', '/sand.html'].sort());
});

test('单字查询走单字倒排', () => {
  const { files } = buildFixture();
  assert.deepEqual(searchInBundle(files, '银').sort(), ['/bank.html']);
});

test('正文命中位置能映射到小节锚点', () => {
  const doc = extractSearchDoc('<h2 id="s1">甲</h2><p>无关内容</p><h2 id="s2">乙</h2><p>这里出现沙路法则</p>', { url: '/x' });
  const index = doc.text.indexOf('沙路法则');
  assert.equal(sectionForPosition(doc.headings, index).a, 's2');
});

// ---------------------------------------------------------------- 客户端脚本

test('SEARCH_JS 可解析，且内联函数与模块版本行为一致', () => {
  assert.doesNotThrow(() => new Function(SEARCH_JS));
  assert.ok(SEARCH_CSS.includes('.search-hit-section'));

  const windowStub = {};
  const documentStub = { getElementById: () => null, addEventListener: () => {}, documentElement: { dataset: {} } };
  // 只求内联函数挂上去；DOM 取不到时脚本会提前 return，不会碰事件绑定。
  new Function('window', 'document', 'location', SEARCH_JS)(windowStub, documentStub, { pathname: '/' });
  const internal = windowStub.__siteSearch;
  assert.ok(internal, 'SEARCH_JS 应把内部函数挂到 window.__siteSearch');

  const samples = ['第 1 章 行列式', 'Ａ（１）', 'MATLAB 函数', '沙路  法则'];
  for (const sample of samples) {
    assert.equal(internal.foldSearchText(sample), foldSearchText(sample), `折叠不一致：${sample}`);
  }
  assert.deepEqual(internal.queryGrams('沙路法则'), queryGrams('沙路法则'));
  assert.equal(internal.hashGram('沙路'), hashGram('沙路'));
  assert.deepEqual(internal.verifyPhrase([[3], [4], [5]]), verifyPhrase([[3], [4], [5]]));
  assert.equal(internal.makeSnippet('前沙路法则后', '沙路法则', { radius: 1 }).html,
    makeSnippet('前沙路法则后', '沙路法则', { radius: 1 }).html);
});
