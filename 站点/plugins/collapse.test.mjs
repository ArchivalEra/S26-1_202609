/**
 * 折叠块模块的测试。
 *
 * 这些断言来自真实踩过的坑：
 *  1. <summary> 后与 </details> 前必须留空行 —— 否则 marked 把整块当 raw HTML
 *     透传，内部的 **粗体**、行内代码、列表都不解析。
 *  2. 嵌套必须用深度计数匹配 —— 用非贪婪正则会内外层错配。
 *  3. 代码围栏内的 ::: 绝不能被当成折叠块语法（否则文档没法写它自己）。
 *  4. 未闭合的 :::collapse 必须原样输出 —— 绝不能吞掉后面整篇内容。
 *  5. 产物必须是原生 <details>，**零 JavaScript**、零水合。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderCollapse } from "./collapse.mjs";

describe("折叠块：基本转换", () => {
  it("把 :::collapse 列表转成多个原生 <details>", () => {
    const src = [
      "题面",
      ":::collapse",
      "- 提示 1",
      "  先看这一行。",
      "- 提示 2",
      "  再看那一行。",
      ":::",
    ].join("\n");
    const out = renderCollapse(src);
    assert.ok(String(out).includes("<details"));
    assert.ok(String(out).includes("<summary"));
    assert.equal((out.match(/<details/g) || []).length, 2);
    assert.equal((out.match(/<\/details>/g) || []).length, 2);
    assert.ok(String(out).includes("提示 1"));
    assert.ok(String(out).includes("先看这一行。"));
    assert.ok(!String(out).includes(":::collapse"));
  });

  it("产物是原生 <details>，不含任何 script（零 JS）", () => {
    const out = renderCollapse(":::collapse\n- 标题\ntext\n:::");
    assert.ok(!(/<script/i).test(String(out)));
    assert.ok(!(/\son[a-z]+\s*=/i).test(String(out))); // 无内联事件处理器
    assert.ok(String(out).includes("<details"));
  });

  it("summary 后与 </details> 前都留了空行（否则内部 Markdown 不解析）", () => {
    const out = renderCollapse(":::collapse\n- 标题\n正文 **粗体**\n:::");
    assert.ok(String(out).includes("**粗体**")); // 正文原样留给 marked 解析
    const lines = out.split("\n");
    const si = lines.findIndex((l) => l.includes("</summary>"));
    const di = lines.findIndex((l) => l.trim() === "</details>");
    assert.ok(si >= 0 && di > si, "应能找到 summary 与 details 闭合");
    assert.equal(lines[si + 1].trim(), "", "summary 后一行必须为空行");
    assert.equal(lines[di - 1].trim(), "", "</details> 前一行必须为空行");
  });
});

describe("折叠块：选项与标记", () => {
  it("accordion 用同名 <details name=...> 分组（原生手风琴，零 JS）", () => {
    const out = renderCollapse(":::collapse accordion\n- A\na\n- B\nb\n:::");
    const names = [...out.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(names.length, 2);
    assert.equal(names[0], names[1]); // 同组
  });

  it("不给 accordion 时没有 name（各项独立开合）", () => {
    const out = renderCollapse(":::collapse\n- A\na\n- B\nb\n:::");
    assert.ok(!String(out).includes('name="'));
  });

  it("expand 选项让所有项默认展开", () => {
    const out = renderCollapse(":::collapse expand\n- A\na\n- B\nb\n:::");
    assert.equal((out.match(/open/g) || []).length, 2);
  });

  it(":+ 让该项默认展开，:- 保持收起", () => {
    const out = renderCollapse(":::collapse\n- 展开我 :+\nx\n- 收起我 :-\ny\n:::");
    assert.ok(String(out).includes("展开我"));
    assert.ok(String(out).includes("收起我"));
    assert.ok(!String(out).includes(":+")); // 标记已被剥掉
    assert.ok(!String(out).includes(":-"));
    assert.equal((out.match(/\bopen\b/g) || []).length, 1);
  });

  it("选项大小写不敏感", () => {
    const out = renderCollapse(":::collapse ACCORDION\n- A\na\n- B\nb\n:::");
    assert.ok(String(out).includes('name="'));
  });
});

describe("折叠块：必须避开的坑", () => {
  it("代码围栏里的 ::: 原样保留（文档要能写它自己）", () => {
    const src = ["```markdown", ":::collapse", "- 这是示例，不该被转换", ":::", "```"].join("\n");
    const out = renderCollapse(src);
    assert.equal(out, src);
    assert.ok(!String(out).includes("<details"));
  });

  it("波浪号围栏同样受保护", () => {
    const src = ["~~~", ":::collapse", "- x", "~~~"].join("\n");
    assert.equal(renderCollapse(src), src);
  });

  it("**未闭合**的 :::collapse 原样输出，不吞后续内容", () => {
    const src = [":::collapse", "- 标题", "", "后面还有一整篇正文", "## 标题二", "段落"].join("\n");
    const out = renderCollapse(src);
    assert.ok(String(out).includes("后面还有一整篇正文"));
    assert.ok(String(out).includes("## 标题二"));
    assert.ok(!String(out).includes("<details"));
  });

  it("嵌套：深度计数保证外层不被内层 ::: 提前收尾（不做递归转换，有意为之）", () => {
    const src = [
      ":::collapse",
      "- 外层",
      "  :::collapse",
      "  - 内层",
      "  内容",
      "  :::",
      ":::",
    ].join("\n");
    const out = renderCollapse(src);
    // 只产出一个面板（外层）。内层的 ::: 作为正文原样保留，不递归转换——
    // 折叠套折叠在教学场景只会让学生迷路，所以明确不支持。
    assert.equal((out.match(/<details/g) || []).length, 1);
    assert.ok(String(out).includes("外层"));
    assert.ok(String(out).includes("内层"));       // 内层文字没丢
    assert.ok(String(out).includes(":::collapse")); // 内层语法原样保留（显示为字面量）
    // 关键：外层闭合必须在内层内容之后 ⇒ 配对正确、没被内层提前收尾
    assert.ok(out.lastIndexOf("</details>") > out.indexOf("内容"));
  });

  it("普通正文（无 collapse）原样返回，零开销", () => {
    const src = "# 标题\n\n普通段落，含 `code` 与 $x^2$。\n";
    assert.equal(renderCollapse(src), src);
  });

  it("不含列表的折叠块退化成单个面板，标题取首行", () => {
    const out = renderCollapse(":::collapse\n单面板标题\n正文内容\n:::");
    assert.equal((out.match(/<details/g) || []).length, 1);
    assert.ok(String(out).includes("单面板标题"));
    assert.ok(String(out).includes("正文内容"));
  });

  it("空输入与非法输入不炸", () => {
    assert.equal(renderCollapse(""), "");
    assert.ok(String(renderCollapse(":::collapse expand accordion\n- A\na\n- B\nb\n:::")).includes("<details"));
  });

  it("标题里的 HTML 被转义，不会破坏结构", () => {
    const out = renderCollapse(":::collapse\n- a < b & c\n正文\n:::");
    assert.ok(out.includes("a &lt; b &amp; c"));
    assert.ok(!String(out).includes("< b"));
  });
});
