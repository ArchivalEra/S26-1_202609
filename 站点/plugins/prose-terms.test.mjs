/**
 * 正文符号取词模块的测试（原 math-glossary.test.mjs）。
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
import { parseGlossaryDict, parseGlossaryMatch, renderGlossary, autoWrapTerms, applySymbolExclusions, GLOSSARY_JS } from "./prose-terms.mjs";

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
  const hits = [];

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


  it("包限定令牌（符号级强制）解析到指定包，环境包查不到则原样保留并告警", () => {
    const packs = {
      "电机学": { hrefBase: "../电机学/0.0-符号入门.html", dict: { "sym-B": { title: "B：磁通密度", text: "x", titleText: "B：磁通密度" } } },
    };
    const out = renderGlossary("[B]{#电机学:sym-B}", {
      dict: {}, packs, renderTex: fakeTex, onHit: (k) => hits.push(k),
    });
    assert.ok(out.includes('data-term="电机学:sym-B"'));
    assert.ok(out.includes('href="../电机学/0.0-符号入门.html#sym-B"'));
    assert.deepEqual(hits, ["电机学:sym-B"]);
    // 指向未注册的包：原样保留 + 警告（零回退）
    const warns = [];
    const bad = renderGlossary("[X]{#不存在的包:sym-X}", { dict: {}, packs, onWarn: (m) => warns.push(m) });
    assert.equal(bad, "[X]{#不存在的包:sym-X}");
    assert.ok(warns[0].includes("未注册的符号包"));
    assert.ok(GLOSSARY_JS.includes('indexOf("#")'), "客户端应识别 href 里已含锚点");
    assert.ok(GLOSSARY_JS.includes("p.innerHTML = entry.text"), "气泡文本按构建期 HTML 渲染（支持公式）");
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
  const hits2 = [];

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

  it("环境包查不到的 term：原样保留 + onWarn（零回退，可见的坏令牌）", () => {
    const warns = [];
    const src = "[x]{#sym-nope}";
    assert.equal(renderGlossary(src, { dict, renderTex: fakeTex, onWarn: (m) => warns.push(m) }), src);
    assert.ok(warns[0].includes("sym-nope"));
  });

  it("符号级强制（frontmatter pins）：环境里没有的词条经 pin 解析到指定包", () => {
    const packs = {
      "工程数学": { hrefBase: "../gc/0.0.html", dict: { "sym-matrix": { title: "矩阵", text: "x", titleText: "矩阵" } } },
    };
    const out = renderGlossary("[a_{ij}]{#sym-matrix}", {
      dict: {}, packs, pins: { "sym-matrix": "工程数学" }, renderTex: fakeTex, onHit: (k) => hits2.push(k),
    });
    assert.ok(out.includes('data-term="工程数学:sym-matrix"'));
    assert.deepEqual(hits2, ["工程数学:sym-matrix"]);
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
      dict: { "sym-B": { prose: ["B"], tex: ["B"] } },
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
    // 2026-10-29 换引擎：公式容器类名是 .ML__latex（旧 .katex 保留兼容）
    assert.ok(GLOSSARY_JS.includes('.ML__latex [data-term]'));
    assert.ok(GLOSSARY_JS.includes('a.sym-gloss'));
  });

  it("公式内命中漂移有几何回退：点在公式容器里就按元素栈重挑最小盒", () => {
    // 根因（2026-10-12 实测）：KaTeX 透明堆叠结构盒抢走点击，closest 落空 →
    // 公式里下标位符号点不动（14 个堆叠公式 104 个符号里 25 个失败）。
    assert.ok(GLOSSARY_JS.includes('closest(".katex")'), "只在公式内启用回退，正文令牌不受影响");
    assert.ok(GLOSSARY_JS.includes("elementsFromPoint"), "用该点的元素栈定位，不遍历全页符号");
    assert.ok(GLOSSARY_JS.includes("bestArea"), "按面积最小挑最具体的目标（嵌套角标取最内层）");
    assert.ok(/area <= 0|width <= 0/.test(GLOSSARY_JS), "零面积盒跳过，不拿结构盒当目标");
    assert.ok(GLOSSARY_JS.includes("data-term"), "回退目标仍必须是带 data-term 的符号");
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

describe("v2 多义项：一个符号的多重含义（不按课程独占名字）", () => {
  const src = [
    ":::glossary-dict",
    "sym-Z | Z | 阻抗；槽数 | 电路原理=阻抗 $Z=R+jX$；电机学=槽数",
    "sym-U | U | 电压：两点间的电位差",
    ":::",
  ].join("\n");

  it("义项解析成 senses（语境=含义），单义词条不受影响", () => {
    const d = parseGlossaryDict(src);
    assert.deepEqual(d["sym-Z"].senses, [
      { ctx: "电路原理", text: "阻抗 $Z=R+jX$" },
      { ctx: "电机学", text: "槽数" },
    ]);
    assert.equal(d["sym-U"].senses, undefined);
    assert.equal(d["sym-U"].text, "电压：两点间的电位差");
  });

  it("不是「语境=含义」形状时不当多义（宁可不拆，也不误判普通释义）", () => {
    const d = parseGlossaryDict([":::glossary-dict", "sym-x | x | 甲；乙；丙", ":::"].join("\n"));
    assert.equal(d["sym-x"].senses, undefined);
  });

  it("命中时 senses 随 onHit 传出（气泡才列得出全部义项）", () => {
    const d = parseGlossaryDict(src);
    let hit = null;
    renderGlossary("[Z]{#sym-Z}", { dict: d, renderTex: fakeTex, onHit: (k, e) => (hit = e) });
    assert.equal(hit.senses.length, 2);
    assert.equal(hit.senses[0].ctx, "电路原理");
  });

  it("客户端气泡按 senses 列义项，并认当前语境（is-here 标记）", () => {
    assert.ok(GLOSSARY_JS.includes("sym-gloss-pop__senses"));
    assert.ok(GLOSSARY_JS.includes("entry.ctx"));
    assert.ok(GLOSSARY_JS.includes("is-here"));
  });
});

describe("符号排除：页面级显式禁自动取词（显式优先于自动）", () => {
  // 宽覆盖包的典型：给全部单字母声明了正文与公式形式
  const wide = () => ({
    "sym-A": { title: "A", text: "A 相", prose: ["A"], tex: ["A"] },
    "sym-B": { title: "B", text: "磁通密度", prose: ["B"], tex: ["B"] },
    "sym-H": { title: "H", text: "磁场强度", prose: ["H"], tex: ["H"] },
  });

  it("正文排除：被禁 id 的 prose 清空、其余照常；公式词典不受影响", () => {
    const { proseDict, texDict } = applySymbolExclusions(wide(), { noProse: ["sym-A", "sym-B"] });
    assert.deepEqual(proseDict["sym-A"].prose, []);
    assert.deepEqual(proseDict["sym-B"].prose, []);
    assert.deepEqual(proseDict["sym-H"].prose, ["H"]);
    // tex 词典是独立副本：正文排除不动公式
    assert.deepEqual(texDict["sym-A"].tex, ["A"]);
  });

  it("公式排除：被禁 id 从 tex 词典整体剔除，其余照常", () => {
    const { texDict, proseDict } = applySymbolExclusions(wide(), { noTex: ["sym-A"] });
    assert.equal(texDict["sym-A"], undefined);
    assert.deepEqual(texDict["sym-B"].tex, ["B"]);
    assert.deepEqual(proseDict["sym-A"].prose, ["A"]); // 正文不受影响
  });

  it("两个键都列 = 完全禁自动取词；未列的词条照常出泡", () => {
    const { proseDict, texDict } = applySymbolExclusions(wide(), { noProse: ["sym-A"], noTex: ["sym-A"] });
    assert.deepEqual(proseDict["sym-A"].prose, []);
    assert.equal(texDict["sym-A"], undefined);
    // 端到端（正文侧）：不再包 sym-A，sym-H 照常。
    // 公式侧的排除现在归 站点/math/terms.mjs 的 `exclude.tex`，由那边的测试覆盖。
    const out = renderGlossary("答案 A 与 H", { dict: proseDict, tokenDict: wide(), renderTex: fakeTex });
    assert.ok(!out.includes('data-term="sym-A"'));
    assert.ok(out.includes('data-term="sym-H"'));
  });

  it("显式令牌不受排除影响（tokenDict 全量）：[A]{#sym-A} 照常出泡", () => {
    const { proseDict, texDict } = applySymbolExclusions(wide(), { noProse: ["sym-A"], noTex: ["sym-A"] });
    const out = renderGlossary("[A]{#sym-A}", {
      dict: proseDict, tokenDict: wide(), renderTex: fakeTex, onHit: () => {},
    });
    assert.ok(out.includes('data-term="sym-A"'));
  });

  it("排除的 id 不在本页环境里 ⇒ 警告（不静默、不猜）", () => {
    const warns = [];
    applySymbolExclusions(wide(), { noProse: ["sym-Zzz"] }, (m) => warns.push(m));
    assert.equal(warns.length, 1);
    assert.ok(warns[0].includes("sym-Zzz"));
  });

  it("没有排除时两份词典都等于原词典（零行为）", () => {
    const d = wide();
    const { proseDict, texDict } = applySymbolExclusions(d, {});
    assert.deepEqual(Object.keys(proseDict), Object.keys(d));
    assert.deepEqual(Object.keys(texDict), Object.keys(d));
  });
});
