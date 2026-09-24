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
import { parseGlossaryDict, parseGlossaryMatch, renderGlossary, glossifyTex, autoWrapTerms, GLOSSARY_JS } from "./math-glossary.mjs";

/** 宿主注入的假 KaTeX 渲染回调：包一层标记便于断言。 */
const fakeTex = (tex) => `<k>${tex}</k>`;

describe("自动取词：词典声明过的符号在正文与公式里自动可点", () => {
  const src = [
    ":::glossary-dict",
    "sym-B | B：磁通密度 | 解释",
    "sym-Phi | Φ：磁通 | 解释",
    "sym-pFe | p_Fe：铁耗 | 解释",
    "sym-sigma | σ：电导率 | 解释",
    ":::",
    ":::glossary-match",
    "sym-B | B | B",
    "sym-Phi | Φ | \\Phi",
    "sym-pFe | p_Fe | p_{Fe}",
    "sym-sigma | σ | \\sigma",
    ":::",
  ].join("\n");
  const dict = () => {
    const d = parseGlossaryDict(src);
    const m = parseGlossaryMatch(src);
    for (const [id, e] of Object.entries(d)) Object.assign(e, m[id] || {});
    return d;
  };

  it("parseGlossaryMatch 读出正文形式与 TeX 形式", () => {
    const m = parseGlossaryMatch(src);
    assert.deepEqual(m["sym-B"].prose, ["B"]);
    assert.deepEqual(m["sym-Phi"].tex, ["\\Phi"]);
    assert.deepEqual(m["sym-pFe"].prose, ["p_Fe"]);
  });

  it("两个围栏都被剥掉，不进正文", () => {
    const out = renderGlossary(src, { dict: dict(), renderTex: fakeTex });
    assert.ok(!out.includes(":::"));
    assert.ok(!out.includes("sym-B | B：磁通密度"));
  });

  it("正文里裸写的符号自动变成令牌（并渲染）", () => {
    const out = renderGlossary("磁场强度与 B 有关，铁耗是 p_Fe。", { dict: dict(), renderTex: fakeTex });
    assert.ok(out.includes('data-term="sym-B"'));
    assert.ok(out.includes('data-term="sym-pFe"'));
    assert.ok(out.includes("<k>p_Fe</k>"));
  });

  it("不碰标题、行内代码、公式与已有令牌", () => {
    const heading = renderGlossary("### 三、磁场强度 B", { dict: dict(), renderTex: fakeTex });
    assert.ok(!heading.includes("data-term"));
    const others = renderGlossary("`B` 与 $B$ 与 [B]{#sym-B}", { dict: dict(), renderTex: fakeTex });
    assert.equal((others.match(/data-term=/g) || []).length, 1);
  });

  it("B 级绝缘 / B 图 里的 B 不取词；带下标的 B_m 也不误伤", () => {
    const out = renderGlossary("B 级绝缘与 B 图，还有 B_m 这种带下标的。", { dict: dict(), renderTex: fakeTex });
    assert.ok(!out.includes("data-term"));
  });

  it("公式里声明过的 TeX 原子自动取词，未声明的不动", () => {
    const tex = glossifyTex("\\Phi=BS,\\quad u=Ri", dict());
    assert.ok(tex.includes("\\htmlData{term=sym-Phi}{\\Phi}"));
    assert.ok(tex.includes("\\htmlData{term=sym-B}{B}"));
    assert.ok(tex.includes("u=Ri"));
  });

  it("显式令牌跨课程可用（详细链接按词条所属课程解析），自动取词只认本课程", () => {
    const merged = {
      ...dict(),
      "sym-other": { title: "外课符号", text: "x", prose: ["Z"], href: "../外课/0.0-符号入门.html#sym-other" },
    };
    // 本页不属于外课（wrapDict 为空）：手写令牌照样解析，且链接指向外课那一页
    const token = renderGlossary("[Z]{#sym-other}", { dict: merged, wrapDict: {}, renderTex: fakeTex });
    assert.ok(token.includes('data-term="sym-other"'));
    assert.ok(token.includes('href="../外课/0.0-符号入门.html#sym-other"'));
    // 但外课的符号不会在本页被自动取词
    const plain = renderGlossary("这里出现了一个 Z。", { dict: merged, wrapDict: {}, renderTex: fakeTex });
    assert.ok(!plain.includes("data-term"));
    // 客户端脚本契约：详细链接不会拼成双锚点；词条文本走构建期渲染好的 HTML
    assert.ok(GLOSSARY_JS.includes('indexOf("#")'), "客户端应识别 href 里已含锚点");
    assert.ok(GLOSSARY_JS.includes("p.innerHTML = entry.text"), "气泡文本按构建期 HTML 渲染（支持公式）");
  });

  it("不劈开命令名与上下标参数（\\Delta 的 D、\\left 的 l 不能被取词）", () => {
    const d = { ...dict(), "sym-D": { title: "D", text: "x", tex: ["D"] }, "sym-l": { title: "l", text: "x", tex: ["l"] } };
    const out = glossifyTex("\\Delta\\mu,\\ \\left.x\\right)", d);
    assert.ok(out.includes("\\Delta"));
    assert.ok(out.includes("\\left"));
    assert.ok(!out.includes("\\htmlData{term=sym-D}{D}elta"));
  });

  it("上下标位置的命令型符号要加花括号（\\Phi_\\sigma、B_m^n）", () => {
    const out = glossifyTex("\\Phi_\\sigma,\\quad B_m^n", dict());
    assert.ok(out.includes("{\\htmlData{term=sym-Phi}{\\Phi}}") === false); // \Phi 是脚本基底，允许不加括号
    assert.ok(out.includes("{\\htmlData{term=sym-sigma}{\\sigma}}"));
  });
});

describe("glossifyTex：TeX 内自动取词", () => {
  const fullDict = {    "sym-rowcol": { title: "t", text: "x" },
    "sym-power": { title: "t", text: "x" },
    "sym-index": { title: "t", text: "x" },
  };

  it("r_1 / c_4 / r_{12} 包成 \\htmlData{term=sym-rowcol}", () => {
    assert.equal(
      glossifyTex("r_1-3r_2", fullDict),
      "\\htmlData{term=sym-rowcol}{r_1}-3\\htmlData{term=sym-rowcol}{r_2}",
    );
    assert.equal(
      glossifyTex("c_{4}+2c_1", fullDict),
      "\\htmlData{term=sym-rowcol}{c_{4}}+2\\htmlData{term=sym-rowcol}{c_1}",
    );
  });

  it("(-1)^{...} 包成 \\htmlData{term=sym-power}", () => {
    assert.equal(
      glossifyTex("(-1)^{i+j}", fullDict),
      "\\htmlData{term=sym-power}{(-1)^{i+j}}",
    );
  });

  it("裸字母与矩阵元素不取词（a、b、c 本身不是术语）", () => {
    const src = "a_{11}a_{22}-a_{12}a_{21}+x_1+b^2";
    assert.equal(glossifyTex(src, fullDict), src);
  });

  it("词典里没有对应词条时不包（没有词条的上色是骗人）", () => {
    assert.equal(glossifyTex("r_1+(-1)^{i+j}", {}), "r_1+(-1)^{i+j}");
    assert.equal(glossifyTex("r_1", { "sym-power": { title: "t", text: "x" } }), "r_1");
  });

  it("\\xrightarrow 标签内的 c_4+2c_1 也能取词", () => {
    assert.equal(
      glossifyTex("\\xrightarrow{c_4+2c_1}", fullDict),
      "\\xrightarrow{\\htmlData{term=sym-rowcol}{c_4}+2\\htmlData{term=sym-rowcol}{c_1}}",
    );
  });

  it("非法输入原样返回", () => {
    assert.equal(glossifyTex(null, fullDict), null);
    assert.equal(glossifyTex(42, fullDict), 42);
  });

  it("吃参数的命令（\\mathbf F）不下手：劈开命令会让 KaTeX 报缺参数", () => {
    const d = { "sym-F": { title: "t", text: "x", tex: ["F"] }, "sym-I": { title: "t", text: "x", tex: ["I"] } };
    // 只放掉命令的参数：F、l 是 \mathbf 的参数不动，等号右边那个独立的 I 照常取词
    assert.equal(glossifyTex("\\mathbf F=I\\mathbf l", d), "\\mathbf F=\\htmlData{term=sym-I}{I}\\mathbf l");
    // 花括号形式是安全的（\htmlData 落在参数**内部**），照常取词
    assert.equal(glossifyTex("\\mathbf{F}", d), "\\mathbf{\\htmlData{term=sym-F}{F}}");
  });

  it("不接参数的命令后面照常取词（\\mu H 里的 H 要上色）", () => {
    const d = { "sym-H": { title: "t", text: "x", tex: ["H"] }, "sym-mu": { title: "t", text: "x", tex: ["\\mu"] } };
    assert.equal(
      glossifyTex("\\mu H", d),
      "\\htmlData{term=sym-mu}{\\mu} \\htmlData{term=sym-H}{H}",
    );
  });
});

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

  it("aria-label 取纯文本标题（标题可以是 $…$，读屏不该念美元号）", () => {
    const d = { "sym-Br": { title: "$B_r$：剩磁", titleText: "B_r：剩磁", text: "x" } };
    const out = renderGlossary("[B_r]{#sym-Br}", { dict: d, renderTex: fakeTex, notationHref: "x.html" });
    assert.ok(out.includes('aria-label="B_r：剩磁"'));
  });
});

describe("glossary：词典围栏可以长成一张表（:::glossary-dict table）", () => {
  const src = [
    "# 符号入门",
    "",
    ":::glossary-dict table",
    "sym-B | B：磁通密度 | 单位 T；$B=\\mu H$。",
    "sym-mu | μ：磁导率 | 真空值 $\\mu_0$。",
    ":::",
    "",
    "正文一段。",
  ].join("\n");
  const asTable = (entries) =>
    `<table>\n${entries.map((e) => `<tr id="${e.id}"><th>${e.title}</th></tr>`).join("\n")}\n</table>`;

  it("宿主给了渲染器：围栏位置出表，每行以词条 id 作锚点", () => {
    const out = renderGlossary(src, { dict: {}, renderTex: fakeTex, dictTable: asTable });
    assert.ok(out.includes('<tr id="sym-B">'));
    assert.ok(out.includes('<tr id="sym-mu">'));
    assert.ok(out.includes("<th>B：磁通密度</th>"));
    assert.ok(!String(out).includes("glossary-dict"));
    assert.ok(out.includes("正文一段。"));
  });

  it("表 HTML 在自动取词之后才插回：表内文字不会被套上令牌", () => {
    const out = renderGlossary(src, {
      dict: {},
      wrapDict: { "sym-B": { prose: ["B"], tex: ["B"] } },
      renderTex: fakeTex,
      dictTable: () => "<table><tr><td>B 与 μ</td></tr></table>",
    });
    assert.ok(out.includes("<td>B 与 μ</td>"), "表内文字保持原样");
    assert.ok(!out.includes("[B]{#sym-B}"));
  });

  it("没有渲染器时不留残影（与普通围栏同样剥掉）", () => {
    const out = renderGlossary(src, { dict: {}, renderTex: fakeTex });
    assert.ok(!String(out).includes("glossary-dict"));
    assert.ok(!String(out).includes("sym-B"));
    assert.ok(out.includes("正文一段。"));
  });

  it("parseGlossaryDict 认带选项的围栏（选项不污染词条）", () => {
    assert.deepEqual(parseGlossaryDict(src), {
      "sym-B": { title: "B：磁通密度", text: "单位 T；$B=\\mu H$。" },
      "sym-mu": { title: "μ：磁导率", text: "真空值 $\\mu_0$。" },
    });
  });
});

describe("glossary：客户端气泡脚本契约", () => {
  it("脚本串是语法合法的 JavaScript", () => {
    assert.doesNotThrow(() => new Function(GLOSSARY_JS));
  });

  it("点击目标同时认正文令牌与 KaTeX 内部取词符号", () => {
    assert.ok(GLOSSARY_JS.includes('closest("a.sym-gloss, .katex [data-term]")'));
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

  it("标题与正文都按构建期 HTML 插入（标题里也能写公式）", () => {
    assert.ok(GLOSSARY_JS.includes("t.innerHTML = entry.title"));
    assert.ok(GLOSSARY_JS.includes("p.innerHTML = entry.text"));
    assert.ok(!GLOSSARY_JS.includes("t.textContent = entry.title"));
  });
});
