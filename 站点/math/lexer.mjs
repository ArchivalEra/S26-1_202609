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
 *   ③ 实测语料只有 **125 个命令、6 个环境**（见 `.kimi-code/` 的语料测绘），
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
const STRUCT_CHARS = { '{': 'open', '}': 'close', _: 'sub', '^': 'sup', '&': 'amp' };

function readEnvName(text, i, n, start, name, state) {
  let k = i;
  while (k < n && /[\t \n]/.test(text[k])) k += 1;
  if (text[k] !== '{') {
    state.problems.push({
      code: 'lex-env-name-missing',
      severity: 'error',
      start, end: i,
      message: `\\${name} 后面没有环境名（应写成 \\${name}{pmatrix}）`,
    });
    state.push('cs', name, start, i, { envName: null });
    return i;
  }
  const close = text.indexOf('}', k + 1);
  if (close < 0) {
    state.problems.push({
      code: 'lex-unclosed-env-name',
      severity: 'error',
      start: k, end: n,
      message: `\\${name} 后面的环境名缺右花括号`,
    });
    state.push('cs', name, start, i, { envName: text.slice(k + 1).trim() });
    return n;
  }
  const envName = text.slice(k + 1, close).trim();
  if (name === 'begin') state.envs.push(envName);
  state.push('cs', name, start, close + 1, { envName });
  return close + 1;
}

function readBackslash(text, i, n, state) {
  const start = i;
  let cur = i + 1;
  if (cur >= n) {
    state.problems.push({
      code: 'lex-dangling-backslash',
      severity: 'error',
      start, end: start + 1,
      message: '公式末尾有一个孤立的反斜杠，后面缺命令名',
    });
    state.push('sym', '\\', start, start + 1);
    return cur;
  }
  if (/[a-zA-Z]/.test(text[cur])) {
    let j = cur;
    while (j < n && /[a-zA-Z]/.test(text[j])) j += 1;
    const name = text.slice(cur, j);
    state.commands.add(name);
    if (name === 'begin' || name === 'end') return readEnvName(text, j, n, start, name, state);
    state.push('cs', name, start, j);
    return j;
  }
  const next = text[cur];
  cur += 1;
  state.push('sym', next, start, cur, { escaped: true });
  return cur;
}

function readNumber(text, i, n, state) {
  const start = i;
  let cur = i;
  while (cur < n && /\d/.test(text[cur])) cur += 1;
  if (text[cur] === '.' && /\d/.test(text[cur + 1] || '')) {
    cur += 1;
    while (cur < n && /\d/.test(text[cur])) cur += 1;
  }
  state.push('char', text.slice(start, cur), start, cur, { numeric: true });
  return cur;
}

function readNumberOrChar(text, i, n, state) {
  if (/\d/.test(text[i])) return readNumber(text, i, n, state);
  const start = i;
  let cur = i + 1;
  const ch = text[i];
  if (ch >= '\uD800' && ch <= '\uDBFF' && cur < n) cur += 1;
  state.push('char', text.slice(start, cur), start, cur);
  return cur;
}

function checkBraceBalance(tokens, problems) {
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
}

export function tokenize(src) {
  const tokens = [];
  const problems = [];
  const commands = new Set();
  const envs = [];
  const text = String(src);
  const n = text.length;
  const push = (kind, value, start, end, extra) => tokens.push({ kind, value, start, end, ...extra });
  const state = { tokens, problems, commands, envs, push };

  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '\\') { i = readBackslash(text, i, n, state); continue; }
    if (/[\t \n\r]/.test(ch)) {
      const start = i;
      while (i < n && /[\t \n\r]/.test(text[i])) i += 1;
      push('space', text.slice(start, i), start, i);
      continue;
    }
    if (STRUCT_CHARS[ch]) { push(STRUCT_CHARS[ch], ch, i, i + 1); i += 1; continue; }
    i = readNumberOrChar(text, i, n, state);
  }

  checkBraceBalance(tokens, problems);
  return { tokens, problems, commands, envs, isDelimiterToken };
}

function handleEndEnv(tok, stack, problems) {
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
    if (tok.value === 'begin') stack.push(tok);
    else if (tok.value === 'end') handleEndEnv(tok, stack, problems);
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
