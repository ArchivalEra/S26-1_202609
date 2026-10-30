/**
 * TeX 词法器：把公式源切成记号流。**零依赖、纯函数、永不抛异常**。
 *
 * ## 为什么自己写，而不是用 KaTeX 的 `__parse`
 *
 * 这是 2026-10-29 站长定案「彻底重构，别再吃以前的东西」的直接后果。
 * KaTeX 的 AST 确实现成（`__parse()` 能给出完整树与精确偏移），但：
 *   ① 我们要换掉的正是 KaTeX 本身，把新架构建在它的私有 API 上，
 *      等于换完渲染器还得再迁一次词法层；
 *   ② `__parse` 是 `__` 前缀的内部导出，升级即可能变化，而它决定了全站公式的解析结果；
 *   ③ 实测语料只有 **125 个命令、6 个环境**（见 `.zcode/` 的语料测绘），
 *      自建词法器的工作量远小于「长期依赖一个无稳定性承诺的私有 API」。
 *
 * ## 它负责什么
 *
 * 只负责**切分与分类**，不负责语义、不负责排版、不报「命令不存在」以外的话。
 * 括号配平、环境配对也在这里查——因为那是词法问题，不是语义问题。
 *
 * ## 记号种类（kind）
 *
 * | kind | 例子 | 说明 |
 * | :--- | :--- | :--- |
 * | `cs`   | `\frac`、`\alpha`、`\begin` | 控制序列（反斜杠 + 字母串） |
 * | `sym`  | `\frac` 之外的 `\+`、`\,`、`\{` | 控制符号（反斜杠 + 单个非字母） |
 * | `char` | `x`、`2`、`+`、`=` | 单个字符（含 Unicode） |
 * | `space`| 空格、换行 | 数学模式里通常被吞掉，保留位置供诊断 |
 * | `open` | `{` | 组开始 |
 * | `close`| `}` | 组结束 |
 * | `sub`  | `_` | 下标标记 |
 * | `sup`  | `^` | 上标标记 |
 * | `amp`  | `&` | 环境的列分隔 |
 * | `rowbreak` | `\\` | 环境的换行 |
 */

/** 控制符号里「不是重音、是定界符」的那一批。它们参与配平。 */
const DELIM_COMMANDS = new Set([
  '{', '}', 'lbrace', 'rbrace', 'langle', 'rangle', 'lvert', 'rvert', 'vert',
  'lVert', 'rVert', 'lbrack', 'rbrack', '(', ')', '[', ']', '|', 'lfloor',
  'rfloor', 'lceil', 'rceil', '.', 'backslash', 'uparrow', 'downarrow',
]);

/** `\left` / `\right` 后面的定界符可以是一个字符，也可以是上面这些命令。 */
const isDelimiterToken = (tok) =>
  tok && (
    (tok.kind === 'char' && '()[]|.'.includes(tok.value)) ||
    ((tok.kind === 'cs' || tok.kind === 'sym') && DELIM_COMMANDS.has(tok.value))
  );

/**
 * 切词。
 *
 * @param {string} src 公式源（不含 `$` 定界符）
 * @returns {{
 *   tokens: Token[],
 *   problems: Problem[],
 *   commands: Set<string>,   // 出现过哪些控制序列（诊断与「不认识的命令」检查用）
 *   envs: string[],          // 出现过哪些环境
 * }}
 */
export function tokenize(src) {
  const tokens = [];
  const problems = [];
  const commands = new Set();
  const envs = [];
  const text = String(src);
  let i = 0;
  const n = text.length;

  const push = (kind, value, start, end, extra) => {
    tokens.push({ kind, value, start, end, ...extra });
  };

  while (i < n) {
    const ch = text[i];

    // ── 控制序列 / 控制符号 ──────────────────────────────────────────
    if (ch === '\\') {
      const start = i;
      i += 1;
      if (i >= n) {
        // 末尾孤零零一个反斜杠：这是写错了，但要给出位置而不是崩掉
        problems.push({
          code: 'lex-dangling-backslash',
          severity: 'error',
          start, end: start + 1,
          message: '公式末尾有一个孤立的反斜杠，后面缺命令名',
        });
        push('sym', '\\', start, start + 1);
        continue;
      }
      const next = text[i];
      if (/[a-zA-Z]/.test(next)) {
        // 控制字：吃连续的字母
        let j = i;
        while (j < n && /[a-zA-Z]/.test(text[j])) j += 1;
        const name = text.slice(i, j);
        i = j;
        commands.add(name);
        if (name === 'begin' || name === 'end') {
          // 读环境名：跳过空白与 `{`
          let k = i;
          while (k < n && /[\t \n]/.test(text[k])) k += 1;
          if (text[k] === '{') {
            const close = text.indexOf('}', k + 1);
            if (close < 0) {
              problems.push({
                code: 'lex-unclosed-env-name',
                severity: 'error',
                start: k, end: n,
                message: `\\${name} 后面的环境名缺右花括号`,
              });
              push('cs', name, start, i, { envName: text.slice(k + 1).trim() });
              i = n;
              continue;
            }
            const envName = text.slice(k + 1, close).trim();
            if (name === 'begin') envs.push(envName);
            push('cs', name, start, close + 1, { envName });
            i = close + 1;
            continue;
          }
          problems.push({
            code: 'lex-env-name-missing',
            severity: 'error',
            start, end: i,
            message: `\\${name} 后面没有环境名（应写成 \\${name}{pmatrix}）`,
          });
          push('cs', name, start, i, { envName: null });
          continue;
        }
        push('cs', name, start, i);
        continue;
      }
      // 控制符号：反斜杠 + 单个非字母字符（`\\`、`\,`、`\{`）
      i += 1;
      // ⚠️ 2026-10-30：必须记下「这是一个被转义的字符」。`\{` `\}` `\|` 在 TeX 里
      // 是**转义的字面字符**，与裸 `{` `}` `|` 是两种东西：
      //   · 裸 `}` 是分组结束；
      //   · `\}` 是一个字面右大括号（做定界符时必须写成 `\right\}`）。
      // 原来两者都成 `sym value="}"`，信息在词法层就丢了——于是
      // `\left. … \right\}`（方程组/分段定义的标准写法）编回时变成 `\right}`，
      // KaTeX 直接 parse error。
      push('sym', next, start, i, { escaped: true });
      continue;
    }

    // ── 空白 ───────────────────────────────────────────────────────
    if (/[\t \n\r]/.test(ch)) {
      const start = i;
      while (i < n && /[\t \n\r]/.test(text[i])) i += 1;
      push('space', text.slice(start, i), start, i);
      continue;
    }

    // ── 结构字符 ───────────────────────────────────────────────────
    if (ch === '{') { push('open', ch, i, i + 1); i += 1; continue; }
    if (ch === '}') { push('close', ch, i, i + 1); i += 1; continue; }
    if (ch === '_') { push('sub', ch, i, i + 1); i += 1; continue; }
    if (ch === '^') { push('sup', ch, i, i + 1); i += 1; continue; }
    if (ch === '&') { push('amp', ch, i, i + 1); i += 1; continue; }

    // `\\` 换行：反斜杠后面跟反斜杠，上一分支已把它当控制符号；
    // 这里单独识别「命令形式的换行」以外的普通字符路径。
    // ── 普通字符 ───────────────────────────────────────────────────
    const start = i;
    // 数字与小数点合成一个记号：`3.14` 是一个数，不是 3 . 1 4 四个记号。
    // 但 `2.3.4` 这种畸形要拆开，所以只在「前面是数字」时吃小数点。
    if (/[0-9]/.test(ch)) {
      while (i < n && /[0-9]/.test(text[i])) i += 1;
      if (text[i] === '.' && /[0-9]/.test(text[i + 1] || '')) {
        i += 1;
        while (i < n && /[0-9]/.test(text[i])) i += 1;
      }
      push('char', text.slice(start, i), start, i, { numeric: true });
      continue;
    }
    // 单个字符（含 Unicode 汉字、希腊字母、运算符）
    i += 1;
    // 代理对（emoji 之类）：别把半个码元当字符
    if (ch >= '\uD800' && ch <= '\uDBFF' && i < n) i += 1;
    push('char', text.slice(start, i), start, i);
  }

  // ── 结构性检查：花括号配平 ────────────────────────────────────────
  // 这一步放在切词之后而不是解析器里，因为「不配平」是词法层就能确定的事实，
  // 而解析器只有在那儿撞墙才知道（那时报出的位置往往是错的）。
  const stack = [];
  for (const tok of tokens) {
    if (tok.kind === 'open') stack.push(tok);
    else if (tok.kind === 'close') {
      if (!stack.length) {
        problems.push({
          code: 'lex-unmatched-close',
          severity: 'error',
          start: tok.start, end: tok.end,
          message: '多了一个右花括号 `}`',
        });
      } else stack.pop();
    }
  }
  for (const open of stack) {
    problems.push({
      code: 'lex-unclosed-group',
      severity: 'error',
      start: open.start, end: open.end,
      message: '这个左花括号 `{` 没有配对的 `}`',
    });
  }

  return { tokens, problems, commands, envs, isDelimiterToken };
}

/**
 * 环境配对检查：`\begin{X}` 与 `\end{X}` 必须同名、按栈配对。
 *
 * 单独一个函数而不是塞进 tokenize：环境名只在 `begin`/`end` 记号上，
 * 但配对是跨记号的全局性质，与切词无关。构建期与测试各调一次。
 *
 * @param {Token[]} tokens
 * @returns {Problem[]}
 */
export function checkEnvironments(tokens) {
  const problems = [];
  const stack = [];
  for (const tok of tokens) {
    if (tok.kind !== 'cs') continue;
    if (tok.value === 'begin') {
      stack.push(tok);
    } else if (tok.value === 'end') {
      const open = stack.pop();
      if (!open) {
        problems.push({
          code: 'env-unmatched-end',
          severity: 'error',
          start: tok.start, end: tok.end,
          message: `\\end{${tok.envName || '?'}} 没有对应的 \\begin`,
        });
      } else if (open.envName !== tok.envName) {
        problems.push({
          code: 'env-name-mismatch',
          severity: 'error',
          start: tok.start, end: tok.end,
          message: `\\begin{${open.envName}} 与 \\end{${tok.envName}} 不配对`,
        });
      }
    }
  }
  for (const open of stack) {
    problems.push({
      code: 'env-unclosed',
      severity: 'error',
      start: open.start, end: open.end,
      message: `\\begin{${open.envName}} 没有对应的 \\end`,
    });
  }
  return problems;
}
