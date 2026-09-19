/**
 * 符号气泡模块的测试。
 *
 * 这些断言钉的是真实约束：
 *  1. 令牌 [tex]{#id} 只认合法 id——不认的**原样保留**，
 *     显式的坏令牌好过静默吞内容（与 collapse 的 {#id} 同一条纪律）。
 *  2. 词典里没有的 term 原样保留——令牌指向不存在的词条必须看得见。
 *  3. :::glossary-dict 围栏是给构建读的数据，渲染时必须剥干净；
 *     但代码围栏里的 ::: 不能误伤（文档要能写它自己）。
 *  4. 客户端脚本串必须语法合法、零外部请求（离线硬约束）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGlossaryDict, renderGlossary, GLOSSARY_JS } from "./math-glossary.mjs";

/** 宿主注入的假 KaTeX 渲染回调：包一层标记便于断言。 */
const fakeTex = (tex) => `<k>${tex}</k>`;

describe("glossary：词典解析 parseGlossaryDict", () => {
  it("按 `id | 标题 | 文本` 解析，文本里再出现 | 不切分", () => {
    const src = [":::glossary-dict", "sym-index | 下标 | 前行后列 | 从 1 数起", ":::"].join("\n");
    const d = parseGlossaryDict(src);
    assert.deepEqual(d["sym-index"], { title: "下标", text: "前行后列 | 从 1 数起" });
  });

  it("忽略围栏外的行、空行、# 注释；非法 id 的行跳过不猜", () => {
    const src = [
      "外面这行不算",
      ":::glossary-dict",
      "# 注释",
      "sym-a | A | 内容 A",
      "9bad | B | 不合法",
      "短 | 只有标题",
      ":::",
      "围栏外也不算",
    ].join("\n");
    const d = parseGlossaryDict(src);
    assert.deepEqual(Object.keys(d), ["sym-a"]);
  });

  it("代码围栏里的 :::glossary-dict 不算数", () => {
    const src = ["```markdown", ":::glossary-dict", "sym-x | X | 陷阱", ":::", "```"].join("\n");
    assert.deepEqual(parseGlossaryDict(src), {});
  });

  it("空输入与非法输入不炸", () => {
    assert.deepEqual(parseGlossaryDict(""), {});
    assert.deepEqual(parseGlossaryDict(null), {});
  });
});

describe("glossary：令牌渲染 renderGlossary", () => {
  const dict = { "sym-index": { title: "下标", text: "前行后列" } };

  it("令牌换成 <a class=sym-gloss>，tex 走宿主渲染回调，href 带锚点", () => {
    // notationHref 由宿主传入前已 encodeURI（模块只负责拼接锚点，不做编码）
    const out = renderGlossary("看这个 [a_{23}]{#sym-index} 就懂了。", {
      dict,
      renderTex: fakeTex,
      notationHref: "../x/0.0-%E7%AC%A6%E5%8F%B7%E5%85%A5%E9%97%A8.html",
    });
    assert.ok(out.includes('<a class="sym-gloss" data-term="sym-index"'));
    assert.ok(out.includes('href="../x/0.0-%E7%AC%A6%E5%8F%B7%E5%85%A5%E9%97%A8.html#sym-index"'));
    assert.ok(out.includes("<k>a_{23}</k>"));
    assert.ok(out.includes('aria-label="下标"'));
    assert.ok(!String(out).includes("{#sym-index}"));
  });

  it("没有 renderTex 时退化为纯文本符号（模块自身不懂 KaTeX）", () => {
    const out = renderGlossary("[a_{23}]{#sym-index}", { dict, notationHref: "x.html" });
    assert.ok(out.includes(">a_{23}</a>"));
  });

  it("词典里没有的 term 原样保留（坏令牌必须看得见）", () => {
    const src = "[x]{#sym-nope}";
    assert.equal(renderGlossary(src, { dict, renderTex: fakeTex }), src);
  });

  it("普通方括号文本、markdown 链接不被误伤", () => {
    const src = "[链接文字](a.md#b) 和 [普通方括号] 不动。";
    assert.equal(renderGlossary(src, { dict, renderTex: fakeTex }), src);
  });

  it(":::glossary-dict 围栏被剥掉；围栏外的正文保留", () => {
    const src = [
      "# 符号入门",
      ":::glossary-dict",
      "sym-index | 下标 | 前行后列",
      ":::",
      "正文一段。",
    ].join("\n");
    const out = renderGlossary(src, { dict, renderTex: fakeTex });
    assert.ok(!String(out).includes("glossary-dict"));
    assert.ok(!String(out).includes("前行后列"));
    assert.ok(out.includes("# 符号入门"));
    assert.ok(out.includes("正文一段。"));
  });

  it("没有令牌也没有词典围栏的源原样返回，零开销", () => {
    const src = "# 普通\n\n正文 $x^2$。\n";
    assert.equal(renderGlossary(src, { dict, renderTex: fakeTex }), src);
  });

  it("无 opts 一律不炸", () => {
    assert.equal(renderGlossary("[a]{#sym-index}"), "[a]{#sym-index}");
    assert.equal(renderGlossary(null), null);
  });
});

describe("glossary：客户端气泡脚本契约", () => {
  it("脚本串是语法合法的 JavaScript", () => {
    assert.doesNotThrow(() => new Function(GLOSSARY_JS));
  });

  it("从页面内 JSON 标签读词典，不发任何请求（离线硬约束）", () => {
    assert.ok(GLOSSARY_JS.includes('getElementById("sym-glossary-json")'));
    assert.ok(!/\bfetch\s*\(/.test(GLOSSARY_JS));
    assert.ok(!/\bimport\s*[\s(]/.test(GLOSSARY_JS));
    assert.ok(!/https?:\/\//.test(GLOSSARY_JS));
  });

  it("气泡可收起：再点同一个、点别处、Esc、hash 变化四条路都在", () => {
    assert.ok(GLOSSARY_JS.includes("if (current === link) { close(); return; }"));
    assert.ok(GLOSSARY_JS.includes("if (pop && !pop.contains(e.target)) close();"));
    assert.ok(GLOSSARY_JS.includes('"Escape"'));
    assert.ok(GLOSSARY_JS.includes('addEventListener("hashchange", close)'));
  });

  it("气泡里有「详细」链接指向词条锚点", () => {
    assert.ok(GLOSSARY_JS.includes('entry.href + "#" + term'));
  });
});
