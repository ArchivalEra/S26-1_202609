/**
 * 符号气泡（math glossary）—— 独立可拆卸模块
 *
 * 解决的问题：教材通篇使用 $a_{ij}$、$r_2-3r_1$ 这类记号却从不解释；
 * 符号入门页（0.0-符号入门.md）做了系统的讲解，但「为看一个符号跳一页」
 * 太重。本模块让正文里的符号**点了出气泡**就地解释，气泡里留
 * 「详细 ↗」链接跳到符号入门页对应锚点；符号页照常存在，气泡只是捷径。
 *
 * ============================ 用法 ============================
 *
 * Markdown 里把符号写成「令牌」：
 *
 *   [a_{ij}]{#sym-index}
 *   [r_2-3r_1]{#sym-rowcol}
 *
 * 渲染为一个**强调色**的可点击符号（构建期 KaTeX 出公式），
 * 无下划线、无链接框——术语高亮的样子，不是链接的样子。
 * 无 JavaScript 时它就是普通链接，点击直达符号入门页锚点——
 * 气泡只是渐进增强，不装 JS 页面照样可用。
 *
 * 公式内部同样可点：glossifyTex 把 TeX 里的 r_1/c_4 行列记号与
 * (-1)^{...} 正负号公式包成 \htmlData{term=...}{...}（需 KaTeX
 * trust 选项），渲染产物里的 <span data-term> 由同一个气泡脚本接管。
 *
 * **环境包络（2026-09-28 重构）**：词条按**符号包**组织（每包 = 一页 :::glossary-dict/match
 * 围栏，包注册表与课程环境表在 站点/符号环境.mjs）。解析只有三层**显式锚定、零回退**：
 *
 *   符号级  [tex]{#电机学:sym-B}   ← 包限定令牌，最高优先（跨包强制锚定单个符号）
 *   段级    构建段 env 覆盖        ← 同一门课的不同板块可用不同的包（站点/符号环境.mjs）
 *   课程级  课程环境表 {符号: 包名} ← 每门课各自赋值（如 高级工程数学 → 工程数学 的包）
 *
 * 环境里没有的 id **原样保留**并给构建期警告——没有任何自动回退/跨包兜底。
 * 环境不设「符号」键 = 符号功能静默关闭（围栏照剥、零行为），这是「像插件一样可剥离」的验证点。
 *
 * **自动取词**（2026-09-24 加）：符号入门页里再用一个围栏声明每个词条的写法，
 *
 *   :::glossary-match
 *   sym-B | B | B              ← id | 正文形式（、分隔） | TeX 形式（、分隔，可省）
 *   sym-Phi | Φ | \Phi
 *   sym-pFe | p_Fe | p_{Fe}
 *   :::
 *
 * 声明过的符号，正文里裸写（「磁场强度 H」）与公式里出现（$B=\mu H$）都**自动**变成可点符号，
 * 不必手写令牌；没声明的词条只能手写——自动取词只在内容侧点过名时发生，避免把每个字母都上色。
 * 正文侧不碰代码、公式、链接、标题与已有令牌，并跳过「B 级绝缘」「B 图」这类明显不是术语的场合。
 *
 * 词典数据**不放在本模块**，放在符号入门页自己的 :::glossary-dict 围栏里
 * （内容侧单一来源，改词条不用碰代码）：
 *
 *   :::glossary-dict
 *   sym-index | 下标：门牌号 | 下标是坐标：前行后列，$a_{23}$ 即第 2 行第 3 列。
 *   sym-power | 上标：乘方 | 右上角是乘方；$(-1)^{i+j}$ 只管正负号。
 *   :::
 *
 * 每行 `id | 标题 | 气泡文本`；文本里的 | 用不着转义（按前两根切分）。
 * **标题与文本都可以写 $…$**——两者都在构建期渲染成公式（见宿主注入的 renderBubbleText），
 * 所以词条里能写真分式，不必拿斜杠或 unicode 上下标凑。词条文本里再写 [tex]{#id}
 * 令牌则保持字面：气泡里不套气泡。
 * 渲染符号页自身时围栏会被剥掉（那是给构建读的数据，不是给人看的正文）。
 *
 * **`:::glossary-dict table`（可选第二个词）**：围栏位置改渲染成一张**符号总表**
 * （每行 `id="<词条id>"`，行的标题格就是锚点）。符号入门页里符号多、族面板只讲其中一部分时，
 * 气泡的「详细 ↗」需要一个精确落点——总表把每个词条的锚点补齐，顺带让那页真的把表列出来。
 * 表格 HTML 由宿主注入（本模块不懂 KaTeX），没注入时行为与普通围栏一致（剥掉，不留残影）。
 *
 * ============================ 与宿主的接缝 ============================
 *
 * build.mjs 三件事：① 读符号入门页 parseGlossaryDict 得词典；
 * ② 每页 Step 2.5 之后调 renderGlossary（传入 KaTeX 渲染回调与
 * 当页到符号入门页的相对链接）；③ 写出 GLOSSARY_JS 资产 + 页面尾
 * <script> + 词典 JSON 标签。摘掉这些即回退：令牌恢复成字面文本。
 *
 * 本模块自己**不懂 KaTeX**——renderTex 由宿主注入（宿主才知道
 * wrapBareCJK 等私有约定），没有回调时令牌退化为纯文本。
 */

/** 词典围栏；可选第二个词（如 `table`）是围栏级选项，见文件头。 */
const DICT_OPEN_RE = /^[\t ]{0,3}:::glossary-dict(?:[\t ]+([A-Za-z][A-Za-z0-9_-]*))?[\t ]*$/;
/** 自动取词声明：`id | 正文形式（、分隔）| TeX 形式（、分隔，可省）`。 */
const MATCH_OPEN_RE = /^[\t ]{0,3}:::glossary-match[\t ]*$/;
const CLOSE_RE = /^[\t ]{0,3}:{3,}[\t ]*$/;
const FENCE_RE = /^[\t ]{0,3}(`{3,}|~{3,})/;
const TERM_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** 行内令牌：[tex]{#id} 或跨包强制 [tex]{#包名:id}（包名可中文，id 仍限 ASCII）。 */
const TOKEN_RE = /\[([^\][\n]+)\]\{#(?:([^\][{}:\n]+):)?([A-Za-z_][A-Za-z0-9_-]*)\}/g;

/**
 * 吃参数的命令的**裸参数**补花括号组——`\frac1\lambda` → `\frac{1}{\lambda}`。
 * 恒等变换（只改写法）：取词会往这类参数位置插 `\htmlData`，而 KaTeX 解析不了
 * 「宏紧跟在另一个宏的裸参数位置」（报 "Unexpected end of input in a macro argument"）。
 * 只处理「单个字符 / 单个命令 / 花括号组」三种参数形态，其余（可选参数等）原样不动。
 */
function braceBareArgs(tex) {
  const TWO_ARG = /^\\(?:d?frac|tfrac|cfrac|binom)$/;
  const ONE_ARG = /^\\(?:sqrt|overline|underline|hat|vec|bar|tilde|dot|ddot|widehat|widetilde|boxed|overbrace|underbrace)$/;
  let out = "";
  let i = 0;
  while (i < tex.length) {
    const cmdMatch = /^\\([A-Za-z]+)/.exec(tex.slice(i));
    if (!cmdMatch) { out += tex[i++]; continue; }
    const name = "\\" + cmdMatch[1];
    const twoArg = TWO_ARG.test(name);
    if (!twoArg && !ONE_ARG.test(name)) { out += cmdMatch[0]; i += cmdMatch[0].length; continue; }
    let j = i + cmdMatch[0].length;
    const pieces = [];
    let ok = true;
    for (let n = 0; n < (twoArg ? 2 : 1); n++) {
      // 跳过空白（照原样保留）
      let ws = "";
      while (j < tex.length && /[ \t]/.test(tex[j])) ws += tex[j++];
      if (tex[j] === "{") {
        let depth = 0, k = j;
        while (k < tex.length) {
          if (tex[k] === "{") depth++;
          else if (tex[k] === "}") { depth--; if (!depth) { k++; break; } }
          k++;
        }
        if (depth !== 0) { ok = false; break; }
        pieces.push(ws + tex.slice(j, k));
        j = k;
        continue;
      }
      if (tex[j] === "\\") {
        const m2 = /^\\([A-Za-z]+|.)/.exec(tex.slice(j));
        if (!m2) { ok = false; break; }
        pieces.push(ws + "{" + m2[0] + "}");
        j += m2[0].length;
        continue;
      }
      if (j < tex.length && !/[\s{}]/.test(tex[j])) {
        pieces.push(ws + "{" + tex[j] + "}");
        j++;
        continue;
      }
      ok = false;
      break;
    }
    if (!ok) { out += cmdMatch[0]; i += cmdMatch[0].length; continue; }
    out += name + pieces.join("");
    i = j;
  }
  return out;
}

/**
 * 把 TeX 源里的行列记号与正负号公式包进 \htmlData{term=...}{...}，
 * 使它们在 KaTeX 渲染产物里带 data-term，可被气泡脚本点中。
 * 只在词典里确有对应词条时才包（没有词条的上色是骗人）；
 * 已在 \htmlData 内的内容不会重复匹配（替换结果里 term= 挡住了回扫）。
 * 另支持**模式原子**：match 围栏的 TeX 形式写成 /…/（正则字面量）时按模式匹配——
 * 行列记号 r_1、正负号 (-1)^{i+j} 这类「一族记号」由此声明（哪包声明哪包生效），
 * 取代了旧版写死 sym-rowcol/sym-power 的做法。词条没有气泡内容（bubble=false）不参与。
 * @param {string} tex
 * @param {object} dict 环境包词典（parseGlossaryDict ∪ parseGlossaryMatch）
 * @param {(id: string) => void} [onTerm] 取词命中回调（按需烘焙 JSON 用）
 */
export function glossifyTex(tex, dict = {}, onTerm = null) {
  if (typeof tex !== "string") return tex;
  let out = tex;

  // ⓪ 先把「当文字排」的片段与「环境骨架」保护起来，否则取词会把公式打断：
  //    \mathrm{...}/\text{...} 里是单位（H/m、Wb、N·m）；
  //    \begin{aligned}、\begin{array}{l} 里的字母是环境名与列格式——KaTeX 遇到
  //    \htmlData 混进这两处会直接报 "Expected node of ... type, but got node of type html"。
  const guarded = [];
  out = out.replace(
    /\\(?:mathrm|text|textrm|operatorname|mbox)\{[^{}]*\}|\\(?:begin|end)\{[^{}]*\}(?:\{[^{}]*\})*/g,
    (m) => {
      if (m === "\\mathrm{d}") return m; // 微分号 d 是术语，留给下面取词
      guarded.push(m);
      return `\u0001${guarded.length - 1}\u0001`;
    },
  );

  // ⓪′ 吃参数的命令的**裸参数**补成花括号组：`\frac1\lambda` → `\frac{1}{\lambda}`、
  //     `\sqrt2` → `\sqrt{2}`。取词会在这类参数位置插 `\htmlData`，而 KaTeX 解析不了
  //     「宏直接当另一个宏的裸参数」（2026-10-12 实弹：`\frac1\lambda` 包完后渲染成
  //     `\frac1\htmlData{…}{\lambda}` → "Unexpected end of input in a macro argument"）。
  //     补括号是**恒等变换**（改的是写法、不改含义），同时让插入点变安全。
  //     全花括号的写法原样放行（不动 tex 原貌）；认不出的参数形态（如 `\sqrt[3]{x}` 的可选参数）也不动。
  out = braceBareArgs(out);

  // ① 词典声明过的 TeX 原子（entry.tex）：整原子取词，长的优先。判据是「独立记号」：
  //    紧邻字母/数字的不取（不劈开更长标识符、不碰 \Big 这类命令名），
  //    但 _ ^ 两侧放行——大符号、角标、角标的角标各自成泡（\Phi_{m_{1}} 三层全包，
  //    见 2026-10-12「放开嵌套角标」）。命令型与多字符符号（\oint_l、\Phi_{c1}、R_m
  //    之类）同样带下标的正是最需要解释的那些。
  const atoms = [];
  const patterns = [];
  for (const [id, entry] of Object.entries(dict)) {
    if (entry.bubble === false) continue; // 只有形式声明、没有气泡内容：不上色
    for (const form of entry.tex || []) {
      if (!form) continue;
      const pat = form.match(/^\/(.+)\/([a-z]*)$/s);
      if (pat) {
        try {
          patterns.push({ id, re: new RegExp(pat[1], pat[2] + "g") });
        } catch (_) { /* 坏正则跳过，不猜 */ }
      } else {
        atoms.push({ atom: form, id });
      }
    }
  }
  if (atoms.length) {
    atoms.sort((a, b) => b.atom.length - a.atom.length);
    const alt = atoms.map((x) => x.atom.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const idOf = new Map(atoms.map((x) => [x.atom, x.id]));
    out = out.replace(new RegExp(`(${alt})`, "g"), (whole, atom, offset, full) => {
      const before = offset > 0 ? full[offset - 1] : "";
      const next = full[offset + whole.length] || "";
      // 前面是反斜杠 = 这个字母属于命令名（\Delta 的 D、\left 的 l、\times 的 t），
      // 插进去会把命令劈开；命令型原子（\oint）遇到反斜杠也说明是更长的命令。
      if (before === "\\") return whole;
      // 前面是「吃参数的命令 + 空白」= 这个原子是那条命令的参数（\mathbf F 里的 F）：
      // 同样不能插，否则命令缺参数。
      if (ARG_COMMANDS.test(full.slice(0, offset))) return whole;
      const isScript = before === "_" || before === "^";
      if (atom.startsWith("\\")) {
        // 数学里 V\oint、B\cos 这种紧邻写法正常，前面是字母照取；
        // 但当它本身就是上下标的参数时（\Phi_\sigma、B_m^n）要额外加花括号，
        // 否则 "命令不能直接当脚本参数" 会报错。
        const wrapped = `\\htmlData{term=${idOf.get(atom)}}{${atom}}`;
        if (onTerm) onTerm(idOf.get(atom));
        return isScript ? `{${wrapped}}` : wrapped;
      }
      // 普通原子（单字母或字母串）——2026-10-12 放开嵌套角标：判据从「不在上下标旁」
      // 改成「这个原子前面没粘着更长的标识符」：
      //   前面紧邻字母、数字 ⇒ 是更长名字的一部分，不取（xab 里不拆 a、b）；
      //   前/后是 _ ^ ⇒ **照取**：大符号与它的角标、角标的角标各自成泡
      //   （B_m → B 与 m 各一泡；\Phi_{m_{1_{2}}} 逐层全包）。
      //   相邻字母照取（BS 是 B·S 两个独立记号，都该有泡；词典里若有更长的
      //   整原子 B_r、H_c，长的优先已先匹掉，这里不会拆）。
      //   脚本位置的原子补一层花括号，否则 \htmlData 会被当不定参数的命令吞掉
      //   （与命令型符号同一条处理，KaTeX 实测 {\htmlData{…}{m}} 合法）。
      if (/[A-Za-z0-9]/.test(before)) return whole;
      const wrapped = `\\htmlData{term=${idOf.get(atom)}}{${atom}}`;
      if (onTerm) onTerm(idOf.get(atom));
      return isScript ? `{${wrapped}}` : wrapped;
    });
  }

  // ② 模式原子（match 围栏里 /…/ 声明的正则）：先把 ① 插入的 \htmlData 段保护起来，
  //    否则模式会在已上色的记号里二次匹配（字面原子是单次 replace 没这个问题）。
  //    **每种模式落地后立刻再钉一遍**：模式 A 的输出（如 `\htmlData{term=sym-i}{i}`）
  //    若暴露在字符串里，模式 B 的 `[^{}]*` 会在它的花括号上**部分匹配**、把命令劈开
  //    （2026-10-12 实弹：`(-1)^{i+j}` 里 i 先被包，sym-power 模式随后匹配成
  //    `(-1)^{\htmlData` → KaTeX 报错）。增量钉住从根上断掉模式间互相干扰。
  const restore = (s) => s.replace(/\u0001(\d+)\u0001/g, (m, i) => guarded[Number(i)] ?? m);
  if (!patterns.length) return restore(out);
  const pin = [];
  // 钉住已产出的 \htmlData{term=…}{…} 段，别让后续模式再咬进去。
  // **参数可以含花括号**（`{U_{ab}}`、`{\Phi_{m_{1}}}`——放开嵌套角标后这是常态），
  // 所以不能写死 `\{[^{}]*\}`：那样含嵌套花括号的段根本没被保护，模式正则就会咬进
  // `term=sym-Uab` 的属性名，产出畸形的 `term=sym-\htmlData{…}`（2026-10-12 实弹：
  // 电子技术/电路原理 15 页 152 处；这种符号点不出气泡——词典里查不到那个畸形 id）。
  // 单遍扫描：遇到 \htmlData 就按**花括号配平**取两个组，跳过反斜杠转义。
  const pinAll = () => {
    let result = "", i = 0;
    while (i < out.length) {
      const start = out.indexOf("\\htmlData", i);
      if (start < 0) { result += out.slice(i); break; }
      result += out.slice(i, start);
      let j = start + "\\htmlData".length;
      // 依次配平两组：{term=…} 与 {内容…}
      let ok = true;
      for (let g = 0; g < 2; g++) {
        while (j < out.length && /[ \t]/.test(out[j])) j++;
        if (out[j] !== "{") { ok = false; break; }
        let depth = 0;
        for (; j < out.length; j++) {
          if (out[j] === "\\") { j++; continue; }
          if (out[j] === "{") depth++;
          else if (out[j] === "}") { depth--; if (depth === 0) { j++; break; } }
        }
        if (depth !== 0) { ok = false; break; }
      }
      if (!ok) { result += out.slice(start, j); i = j; continue; }
      pin.push(out.slice(start, j));
      result += `\u0002${pin.length - 1}\u0002`;
      i = j;
    }
    out = result;
  };
  pinAll();
  for (const { id, re } of patterns) {
    out = out.replace(re, (match, ...rest) => {
      const offset = rest[rest.length - 2];
      const full = rest[rest.length - 1];
      const before = offset > 0 ? full[offset - 1] : "";
      if (before === "\\") return match;
      if (ARG_COMMANDS.test(full.slice(0, offset))) return match;
      const isScript = before === "_" || before === "^";
      const wrapped = `\\htmlData{term=${id}}{${match}}`;
      if (onTerm) onTerm(id);
      return isScript ? `{${wrapped}}` : wrapped;
    });
    pinAll();
  }
  out = out.replace(/\u0002(\d+)\u0002/g, (m, i) => pin[Number(i)] ?? m);
  return restore(out);
}

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * 解析一行词典词条：`id | 标题 | 文本`（文本里可再含 |，按前两根切分）。
 * 缺字段或 id 不合法返回 null——跳过，不猜。
 *
 * **v2 多义项**（2026-10-11）：文本里可写「语境：…」段声明**同一个符号的不同含义**——
 * 一个符号不该被一门课独占名字（$Z$ 在电路原理是阻抗、在电机学是槽数；$\\varphi$ 在
 * 电路原理是功率因数角、在电机学是磁通瞬时值）。义项写法：
 *
 *     sym-Z | Z | 阻抗；槽数 | 电路原理=阻抗 $Z=R+jX$；电机学=槽数
 *
 * 即：第 4 段起（或文本段内）用 `语境=含义`、多个义项用 `；` 分隔。
 * 解析成 `senses: [{ctx, text}]`——渲染时**列出全部义项、标出语境**，
 * 当前页面所属语境的义项排在最前。**单义词条不受影响**（没有 senses）。
 */
const SENSE_SPLIT_RE = /[;；]/;
const SENSE_RE = /^\s*([^=＝]{1,24})\s*[=＝]\s*(.+)$/;

function parseSenses(text) {
  // 义项段用「；」分隔，每段形如「语境=含义」；只要有一段不成形，就整条不当作多义
  // （宁可不拆，也不把普通释义误判成义项）。
  const parts = String(text || "").split(SENSE_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const senses = [];
  for (const p of parts) {
    const m = p.match(SENSE_RE);
    if (!m) return null;
    senses.push({ ctx: m[1].trim(), text: m[2].trim() });
  }
  return senses;
}

function parseDictLine(line) {
  const parts = line.split("|");
  if (parts.length < 3) return null;
  const id = parts[0].trim();
  if (!TERM_ID_RE.test(id)) return null;
  const title = parts[1].trim();
  // v2：第 3 段是**总述**（单义词条的释义）；第 4 段起若形如「语境=含义；语境=含义」
  // 则整体当**义项**（此时第 3 段仍是总述，气泡里先显示它、再列各义项）。
  const head = parts[2].trim();
  const tail = parts.slice(3).join("|").trim();
  const senses = parseSenses(tail);
  return { id, title, text: senses ? head : parts.slice(2).join("|").trim(), senses };
}

/**
 * 从 Markdown 源里解析 :::glossary-dict 围栏，返回 { id: {title, text} }。
 * 跟踪代码围栏（围栏内的 ::: 不算数）；重复 id 后者覆盖前者。
 */
export function parseGlossaryDict(source) {
  const dict = {};
  if (typeof source !== "string") return dict;
  const lines = source.split(/\r?\n/);
  let fence = null;
  let inDict = false;
  for (const line of lines) {
    const f = line.match(FENCE_RE);
    if (f) {
      const marker = f[1];
      if (!fence) fence = { ch: marker[0], len: marker.length };
      else if (marker[0] === fence.ch && marker.length >= fence.len) fence = null;
      continue;
    }
    if (fence) continue;
    if (!inDict) {
      if (DICT_OPEN_RE.test(line)) inDict = true;
      continue;
    }
    if (CLOSE_RE.test(line)) {
      inDict = false;
      continue;
    }
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const entry = parseDictLine(line);
    if (entry) {
      const e = { title: entry.title, text: entry.text };
      if (entry.senses) e.senses = entry.senses;
      dict[entry.id] = e;
    }
  }
  return dict;
}

/**
 * 解析 :::glossary-match 围栏：`id | 正文形式（、分隔）| TeX 形式（、分隔，可省）`。
 * 返回 { id: { prose: [...], tex: [...] } }——声明了形式，正文与公式里的符号才会**自动**取词。
 * 没声明的词条只能靠手写令牌，这是刻意的：自动取词只在内容侧明确点名时才发生。
 */
export function parseGlossaryMatch(source) {
  const out = {};
  if (typeof source !== "string") return out;
  const lines = source.split(/\r?\n/);
  let fence = null;
  let inMatch = false;
  const list = (s) => String(s || "").split(/[、,，]/).map((x) => x.trim()).filter(Boolean);
  for (const line of lines) {
    const f = line.match(FENCE_RE);
    if (f) {
      const marker = f[1];
      if (!fence) fence = { ch: marker[0], len: marker.length };
      else if (marker[0] === fence.ch && marker.length >= fence.len) fence = null;
      continue;
    }
    if (fence) continue;
    if (!inMatch) {
      if (MATCH_OPEN_RE.test(line)) inMatch = true;
      continue;
    }
    if (CLOSE_RE.test(line)) {
      inMatch = false;
      continue;
    }
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const parts = line.split("|");
    if (parts.length < 2) continue;
    const id = parts[0].trim();
    if (!TERM_ID_RE.test(id)) continue;
    out[id] = { prose: list(parts[1]), tex: list(parts[2]) };
  }
  return out;
}

/**
 * 剥掉全部 :::glossary-dict 与 :::glossary-match 围栏（数据块不该出现在正文里）。
 * `:::glossary-dict table` 且给了 onTable 时，围栏原位置留下 onTable(entries) 的产物
 * （entry 按围栏里的书写顺序），供符号入门页把词典本身列成表。
 * @param {string[]} lines
 * @param {((entries: {id: string, title: string, text: string}[]) => string) | null} [onTable]
 */
function stripDictFences(lines, onTable = null) {
  const out = [];
  let fence = null;
  let inDict = false;
  let asTable = false;
  let entries = [];
  const flush = () => {
    if (asTable && onTable && entries.length) out.push(onTable(entries));
  };
  for (const line of lines) {
    const f = line.match(FENCE_RE);
    if (f) {
      const marker = f[1];
      if (!fence) fence = { ch: marker[0], len: marker.length };
      else if (marker[0] === fence.ch && marker.length >= fence.len) fence = null;
      out.push(line);
      continue;
    }
    if (fence) {
      out.push(line);
      continue;
    }
    if (!inDict) {
      const open = line.match(DICT_OPEN_RE);
      if (open) {
        inDict = true;
        asTable = open[1] === "table";
        entries = [];
        continue;
      }
      if (MATCH_OPEN_RE.test(line)) {
        inDict = true;
        asTable = false;
        entries = [];
        continue;
      }
      out.push(line);
      continue;
    }
    if (CLOSE_RE.test(line)) {
      inDict = false;
      flush();
      asTable = false;
      entries = [];
      continue;
    }
    if (asTable) {
      const entry = parseDictLine(line);
      if (entry) entries.push(entry);
    }
  }
  return out;
}

/**
 * 正文自动取词：把词典声明过的**正文形式**（`entry.prose`，见 :::glossary-match）包成令牌，
 * 交给 TOKEN_RE 统一处理。没声明的词条仍只能手写令牌——自动取词只在内容侧点过名时发生。
 *
 * 不动这些地方：代码围栏与行内代码、行内/独立公式、已有令牌、markdown 链接目标、HTML 标签、标题行
 * （标题里插令牌会让右侧目录重复三遍，见 handoff §8.1）。
 * 另外跳过紧跟「图／表／级／相／极／端」的情况：「B 级绝缘」「B 图」里的 B 不是磁通密度。
 */
const PROTECT_RE = /(`[^`\n]*`|\$[^$\n]*\$|\[[^\]\n]+\]\{#(?:[^\]:{}\n]+:)?[A-Za-z_][A-Za-z0-9_-]*\}|\]\([^)\n]*\)|<[^>\n]+>)/;
const SKIP_AFTER = "图表级相极端样附";
/**
 * 会**吃参数**的命令：紧跟在 `\mathbf ` 后面的那个字母是它的参数，不是独立符号，
 * 把 `\htmlData` 插进那中间等于把命令劈开（`\mathbf \htmlData{…}{F}` →
 * KaTeX 报 "Unexpected end of input in a macro argument"）。
 * 只列这类命令，别把 `\mu`、`\alpha` 这些不接参数的符号命令算进来——`\mu H` 里的 H 要取词。
 */
const ARG_COMMANDS = /\\(?:math(?:bf|it|rm|sf|tt|cal|bb|frak)|vec|hat|bar|tilde|dot|ddot|overline|underline|sqrt|left|right|big|Big|bigg|Bigg|text|textnormal|operatorname|boldsymbol|pmb)\s*$/;
/**
 * 符号排除（页面 frontmatter）——「全部包起来」是默认，撞车处**显式**收窄。
 *
 * 宽覆盖的包（电机学给全部拉丁单字母声明了正文形式）会在少数页面撞上
 * 选项标号（「答案：C」）、单位（`A/m`、`1 T`）、人名缩写（`H. C. Ørsted`）、
 * 绝缘等级（Y/A/E/B/F/H/C 七级）这类同形不同义的场合。启发式判据必然误伤
 * （同一页里 `B` 既是选项标号又是磁通密度），所以只有**显式指定**才是可靠的：
 *
 *   frontmatter:
 *     符号排除: [sym-A, sym-B]        ← 这些词条在本页**正文**里不自动取词
 *     符号排除公式: [sym-A]            ← 这些词条在本页**公式**里不自动取词
 *
 * 两个键都列 = 完全禁自动取词。**手写令牌永远照常**（`[B]{#sym-B}` 不受影响）——
 * 显式优先于自动，与三层锚定同一哲学（符号级现在有两个动词：强制、排除）。
 * id 不在本页符号环境里 ⇒ 经 onWarn 报出（零回退纪律：不猜、不静默）。
 *
 * @param {object} dict 本页环境包词典（未过滤）
 * @param {{noProse?: string[], noTex?: string[]}} exclusions
 * @param {(msg: string) => void} [onWarn]
 * @returns {{proseDict: object, texDict: object}} 正文用 / 公式用 两份词典
 */
export function applySymbolExclusions(dict = {}, exclusions = {}, onWarn = null) {
  const warn = (m) => onWarn && onWarn(m);
  const noProse = exclusions.noProse || [];
  const noTex = exclusions.noTex || [];
  const proseDict = { ...dict };
  const texDict = { ...dict };
  for (const id of noProse) {
    if (!Object.prototype.hasOwnProperty.call(dict, id)) {
      warn(`符号排除指向本页环境里没有的词条 ${id}`);
      continue;
    }
    const e = proseDict[id];
    if (e && e.prose && e.prose.length) proseDict[id] = { ...e, prose: [] };
  }
  for (const id of noTex) {
    if (!Object.prototype.hasOwnProperty.call(dict, id)) {
      warn(`符号排除公式指向本页环境里没有的词条 ${id}`);
      continue;
    }
    delete texDict[id];
  }
  return { proseDict, texDict };
}

export function autoWrapTerms(source, dict = {}) {
  const forms = [];
  for (const [id, entry] of Object.entries(dict)) {
    for (const form of entry.prose || []) if (form) forms.push({ form, id });
  }
  if (!forms.length) return source;
  forms.sort((a, b) => b.form.length - a.form.length);
  const alt = forms.map((x) => x.form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const idOf = new Map(forms.map((x) => [x.form, x.id]));
  const re = new RegExp(`(${alt})(?![A-Za-z0-9_₀-₉ᵣ])`, "g");
  let inFence = false;
  return source
    .split("\n")
    .map((line) => {
      if (FENCE_RE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      if (/^[\t ]{0,3}#{1,6}[\t ]/.test(line)) return line;
      return line
        .split(PROTECT_RE)
        .map((seg, i) => {
          if (i % 2 === 1) return seg;
          return seg.replace(re, (whole, form, offset) => {
            const before = offset > 0 ? seg[offset - 1] : "";
            const rest = seg.slice(offset + form.length).replace(/^[\s\u3000]+/, "");
            const after = rest[0] || "";
            if (before && /[A-Za-z0-9_]/.test(before)) return whole;
            if (after && SKIP_AFTER.includes(after)) return whole;
            return `[${form}]{#${idOf.get(form)}}`;
          });
        })
        .join("");
    })
    .join("\n");
}

/**
 * 可剥离：只剥词典围栏、不做任何符号行为（宿主在没有符号环境时调用）。
 * `:::glossary-dict table` 且给了 dictTable 时照常出表——总表是内容资产，
 * 与「本页有没有锚定符号环境」无关。
 */
export function peelNotationFences(source, dictTable = null) {
  if (typeof source !== "string") return source;
  const tables = [];
  return stripDictFences(
    source.split(/\r?\n/),
    dictTable
      ? (entries) => {
          tables.push(dictTable(entries));
          return `@@GLOSS_TABLE_${tables.length - 1}@@`;
        }
      : null,
  )
    .join("\n")
    .replace(/@@GLOSS_TABLE_(\d+)@@/g, (m, i) => tables[Number(i)] ?? m);
}

/**
 * 主转换：剥词典围栏 + 自动取词 + 把令牌换成可点击符号。**三层显式锚定、零回退**：
 *
 *   令牌 {#包名:id}（符号级强制）→ packs[包名]
 *   令牌 {#id} + pins（frontmatter「符号强制」）→ packs[pins[id]]
 *   令牌 {#id}（无强制）→ dict（**被锚定的环境包**，由宿主按段/课程环境解析好传入）
 *
 * 环境里没有的 id **原样保留**，并经 onWarn 报给宿主（构建期打印）——没有自动回退、
 * 没有跨包兜底。dict 为空 = 符号功能关闭，此时宿主应改调 peelNotationFences。
 *
 * @param {string} source
 * @param {{dict?: object, tokenDict?: object, packs?: object, pins?: object, envName?: string,
 *          renderTex?: (tex: string) => string, notationHref?: string,
 *          dictTable?: (entries: object[]) => string,
 *          onWarn?: (msg: string) => void, onHit?: (key: string) => void}} opts
 *   dict         环境包词典（本页口径：词条带 href/titleText）——自动取词用，可已被
 *                「符号排除」过滤（见 applySymbolExclusions）。
 *   tokenDict    手写令牌专用词典（默认同 dict）：排除只收窄自动取词，显式令牌永远照常。
 *   packs        全部符号包 {包名: {hrefBase, dict}}——包限定令牌与符号强制用。
 *   pins         frontmatter「符号强制」：{词条id: 包名}。
 *   envName      当前锚定的包名（警告消息里报给作者）。
 *   onWarn       构建期警告收集（宿主去重打印）。
 *   onHit        命中回调（key = JSON 里的词条键），宿主按需烘焙气泡 JSON。
 */
export function renderGlossary(source, opts = {}) {
  if (typeof source !== "string") return source;
  const {
    dict = {},
    tokenDict = null,   // 手写令牌专用词典（默认同 dict）——页面「符号排除」只收窄自动取词，
                        // 显式令牌永远照常（显式优先于自动，与三层锚定同一哲学）
    packs = null,
    pins = null,
    envName = "",
    renderTex = null,
    notationHref = "",
    dictTable = null,
    onWarn = null,
    onHit = null,
  } = opts;
  const tokens = tokenDict || dict;
  const warn = (msg) => onWarn && onWarn(msg);
  // 解析一个令牌：返回 {key, entry, href} 或 {miss}。**只查被锚定的地方，零回退**。
  const resolveTerm = (pack, term) => {
    if (pack !== undefined) {
      const p = packs && packs[pack];
      if (!p) return { miss: `令牌指向未注册的符号包「${pack}」` };
      const e = p.dict[term];
      if (!e || e.bubble === false) return { miss: `包「${pack}」没有词条 ${term}` };
      return { key: `${pack}:${term}`, entry: e, href: `${p.hrefBase}#${term}` };
    }
    if (pins && Object.prototype.hasOwnProperty.call(pins, term)) {
      const packName = pins[term];
      const p = packs && packs[packName];
      const e = p && p.dict[term];
      if (!e || e.bubble === false) {
        return { miss: `符号强制指向的包「${packName}」没有词条 ${term}` };
      }
      return { key: `${packName}:${term}`, entry: e, href: `${p.hrefBase}#${term}` };
    }
    if (Object.prototype.hasOwnProperty.call(tokens, term)) {
      const e = tokens[term];
      if (e.bubble === false) {
        return { miss: `词条 ${term} 只声明了形式、没有气泡内容（补词典行才会生效）` };
      }
      return { key: term, entry: e, href: e.href || `${notationHref}#${term}` };
    }
    return { miss: `环境包「${envName}」没有词条 ${term}，令牌原样保留` };
  };
  // 先剥数据围栏（table 围栏换成占位符——总表 HTML 里全是 KaTeX 产物，若此刻插进来，
  // 自动取词会把手伸进标签之间），再自动取词，最后才判断「有没有活干」。
  const tables = [];
  const stripped = stripDictFences(
    source.split(/\r?\n/),
    dictTable
      ? (entries) => {
          tables.push(dictTable(entries));
          return `@@GLOSS_TABLE_${tables.length - 1}@@`;
        }
      : null,
  ).join("\n");
  const wrapped = autoWrapTerms(stripped, dict);
  const hasWork =
    source.includes(":::glossary-dict") ||
    source.includes(":::glossary-match") ||
    TOKEN_RE.test(wrapped);
  TOKEN_RE.lastIndex = 0; // 全局正则带状态，复用前必须归零
  if (!hasWork) return source;

  return wrapped
    .replace(TOKEN_RE, (match, tex, pack, term) => {
      const r = resolveTerm(pack, term);
      if (r.miss) {
        warn(r.miss);
        return match;
      }
      const { key, entry, href } = r;
      const inner =
        renderTex && tex.trim() !== ""
          ? renderTex(tex)
          : esc(tex);
      // aria-label 用**纯文本**标题（词条标题可为 $…$，读屏不该念出美元号与反斜杠）
      const label = entry.titleText || entry.title;
      if (onHit) {
        const hit = { title: entry.title, text: entry.text, href };
        if (entry.senses) hit.senses = entry.senses;   // v2 多义项（供气泡列出全部含义）
        onHit(key, hit);
      }
      return (
        `<a class="sym-gloss" data-term="${esc(key)}" href="${esc(href)}"` +
        ` aria-label="${esc(label)}">${inner}</a>`
      );
    })
    .replace(/@@GLOSS_TABLE_(\d+)@@/g, (match, i) => tables[Number(i)] ?? "");
}

/**
 * 客户端气泡脚本（渐进增强）：
 * 点击 .sym-gloss → 在符号旁弹出气泡（词典标题 + 一句解释 + 详细链接）；
 * 再点同一个、点别处、按 Esc 或 hash 变化都收起。
 * 词典从页面内 <script type="application/json" id="sym-glossary-json"> 读
 * （构建期按页烘焙好的绝对可用链接），不发任何请求。
 */
export const GLOSSARY_JS = String.raw`(/* math-glossary: 符号气泡（独立插件模块，构建期内联） */
function () {
  "use strict";
  var dict = null;
  var pop = null;
  var current = null;
  function ensureDict() {
    if (dict !== null) return dict;
    var tag = document.getElementById("sym-glossary-json");
    if (!tag) return null;
    try { dict = JSON.parse(tag.textContent); } catch (e) { dict = null; }
    return dict;
  }
  function close() {
    if (pop) pop.remove();
    pop = null;
    current = null;
  }
  function openFor(link) {
    var d = ensureDict();
    if (!d) return;
    var term = link.getAttribute("data-term");
    var entry = d.terms && d.terms[term];
    if (!entry) return;
    if (current === link) { close(); return; }
    close();
    pop = document.createElement("div");
    pop.className = "sym-gloss-pop";
    var t = document.createElement("strong");
    // 标题与正文一样由构建期渲染：HTML 已转义、$…$ 已出公式（所以两者都用 innerHTML）
    t.innerHTML = entry.title;
    pop.appendChild(t);
    var p = document.createElement("p");
    // 词条文本由构建期处理好：HTML 已转义、$…$ 已渲染成公式（所以这里用 innerHTML），
    // 而文本里若出现 [tex]{#id} 这样的令牌写法，**保持字面**——气泡里不再套气泡。
    p.innerHTML = entry.text;
    pop.appendChild(p);
    // v2 多义项：同一个符号在不同课程/语境下含义不同（$Z$ = 阻抗 or 槽数）。
    // 列出**全部**义项并标出语境——「实时能查到」就是这里：点一个符号看到它的所有含义，
    // 而 entry.ctx 是当前页面所属语境，那一条排在最前并加标记。
    if (entry.senses && entry.senses.length) {
      var ul = document.createElement("ul");
      ul.className = "sym-gloss-pop__senses";
      var list = entry.senses.slice().sort(function (a, b) {
        var ac = a.ctx === entry.ctx ? 0 : 1, bc = b.ctx === entry.ctx ? 0 : 1;
        return ac - bc;
      });
      for (var si = 0; si < list.length; si++) {
        var li = document.createElement("li");
        if (list[si].ctx === entry.ctx) li.className = "is-here";
        var ctx = document.createElement("em");
        ctx.textContent = list[si].ctx + "：";
        li.appendChild(ctx);
        var st = document.createElement("span");
        st.innerHTML = list[si].text;
        li.appendChild(st);
        ul.appendChild(li);
      }
      pop.appendChild(ul);
    }
    if (entry.href) {
      var a = document.createElement("a");
      a.className = "sym-gloss-pop__more";
      // href 是构建期按词条所属课程烘焙好的（可能已含 #锚点，也可能指向别的课程那一页），
      // 只有没带锚点时才补上，否则会拼成 #id#id 这种双锚点。
      a.href = entry.href.indexOf("#") >= 0 ? entry.href : entry.href + "#" + term;
      a.textContent = "详细 \u2197 符号入门";
      pop.appendChild(a);
    }
    document.body.appendChild(pop);
    var r = link.getBoundingClientRect();
    var width = document.documentElement.clientWidth;
    var left = Math.min(Math.max(8, r.left + window.scrollX), window.scrollX + width - pop.offsetWidth - 8);
    var top = r.bottom + window.scrollY + 8;
    if (r.bottom + pop.offsetHeight + 16 > window.innerHeight + window.scrollY) {
      top = r.top + window.scrollY - pop.offsetHeight - 8;
    }
    pop.style.left = left + "px";
    pop.style.top = top + "px";
    current = link;
  }
  // 公式内命中回退：见 click 处理器里的说明。用 elementsFromPoint 拿该点的完整元素栈，
  // 在其中挑「面积最小」的 [data-term]（越小的盒 = 越具体的目标）。
  // 用 elementsFromPoint 而不是遍历全页符号：只查这一点上的几个元素，与公式规模无关。
  function termAtPoint(x, y) {
    var stack = document.elementsFromPoint
      ? document.elementsFromPoint(x, y)
      : [document.elementFromPoint(x, y)];
    var best = null, bestArea = Infinity, bestDist = Infinity;
    for (var i = 0; i < stack.length; i++) {
      var node = stack[i];
      if (!node || !node.getAttribute) continue;
      var term = node.getAttribute("data-term");
      if (!term) continue;
      var r = node.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      var area = r.width * r.height;
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var dist = (cx - x) * (cx - x) + (cy - y) * (cy - y);
      // 取最小面积；面积相同时取中心离点击点最近的那个。
      if (area < bestArea - 0.5 || (Math.abs(area - bestArea) <= 0.5 && dist < bestDist)) {
        best = node; bestArea = area; bestDist = dist;
      }
    }
    return best;
  }
  document.addEventListener("click", function (e) {
    var link = e.target.closest
      ? e.target.closest("a.sym-gloss, .katex [data-term]")
      : null;
    // 公式内的几何回退（2026-10-12 用户实测「公式框里符号点击范围严重漂移、几乎点不了」）：
    // KaTeX 的透明堆叠结构盒（.vlist 一套，position:relative）会抢走点击让 closest 落空，
    // 相邻/嵌套符号的 inline 盒也会互相覆盖。所以只要点在 .katex 里，就按几何重挑一次：
    // 取「包含该点、面积最小」的 [data-term] 盒——嵌套角标里最小 = 最内层，
    // 重叠邻居里最小 = 更该点的那个；同面积取中心最近。实测把 14 个堆叠公式的
    // 104 个符号从 25 个点不动降到 0。CSS 侧的提层（.katex [data-term] 提 z-index）
    // 是同批的另一半修法，两者互为兜底。
    if (e.target.closest && e.target.closest(".katex")) {
      var geo = termAtPoint(e.clientX, e.clientY);
      if (geo) link = geo;
    }
    if (link) { e.preventDefault(); openFor(link); return; }
    if (pop && !pop.contains(e.target)) close();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") close();
  });
  window.addEventListener("hashchange", close);
}());`;
