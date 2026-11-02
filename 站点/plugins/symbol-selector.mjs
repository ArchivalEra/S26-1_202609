// symbol-selector.mjs —— 「什么是一个符号」的唯一真相。
//
// ## 这个模块为什么存在（2026-11-01 站长定案）
//
// 「符号系统冒不了泡」是本仓**反复发作**的问题家族。历次修的都是发作点
// （KaTeX 堆叠盒抢点击、z-index、编辑态抢事件），但每一轮之后下一轮还会冒。
//
// 这次的病根找齐了：**「什么是一个符号」在全站有 5 处消费、4 种写法**——
//
//   消费处                     | 语义             | 当时的写法
//   ---------------------------|------------------|---------------------------
//   prose-terms（冒泡点击）     | 点谁能冒泡        | a.sym-gloss, .ML__latex [data-term], .katex [data-term]
//   webmcp-tools（MCP 读面）    | 助手看到谁是符号  | 前两个 + a.sym-gloss[data-term]（多了限定）
//   formula-cells（编辑守卫）   | 点符号不进编辑    | [data-term]（**更宽**：任意容器）
//   figures（让路守卫）×3       | 图里点符号不抢事件 | a.sym-gloss（**更窄**：只有正文链接）
//   CSS（强调色）               | 谁看着像符号      | a.sym-gloss ×3 作用域 + 公式内两个
//
// 四种写法**选出的集合不一样**。漂移的后果分两面：
//   · 亮了但点不出泡（强调色命中、点击未命中）—— 读者觉得「这站是坏的」；
//   · 点得出泡但没亮（点击命中、强调色未命中）—— 读者根本不知道那是符号。
// 两面都比「统一」糟。
//
// ## 接口
//
// 只有两个导出：
//   SYMBOL_SELECTORS   三条形状（数组，给测试与需要逐条比对的消费方）
//   SYMBOL_SELECTOR    逗号连接的完整选择器（给 closest / querySelectorAll）
//
// 没有函数、没有状态 —— 它是**常量**，不是逻辑。加新的符号形状（比如未来
// 换公式引擎）= 往数组里加一行，五个消费处同批生效，奇偶校验测试守住 CSS 侧。
//
// ## 三条形状的语义（为什么要这三条）
//
//   a.sym-gloss             正文令牌链接。由 decorateAnchors 生成，**必带** data-term
//                           （render.mjs 里写死），所以不需要 [data-term] 限定。
//   .ML__latex [data-term]  公式内部的符号锚（2026-10-29 换引擎后的容器名）。
//   .katex [data-term]      同上，旧引擎兼容（旧产物与聊天面板里还有）。

/** 三条形状：任何一条命中的元素就是一个符号。顺序即语义分组（正文 / 公式现役 / 公式兼容）。 */
export const SYMBOL_SELECTORS = [
  'a.sym-gloss',
  '.ML__latex [data-term]',
  '.katex [data-term]',
];

/** 完整选择器：closest() 与 querySelectorAll() 都吃这个形态。 */
export const SYMBOL_SELECTOR = SYMBOL_SELECTORS.join(', ');
