/**
 * `:::glossary-dict` 与 `:::glossary-match` 围栏解析、校验与页面排除规则。
 */

const DICT_OPEN_RE = /^[\t ]{0,3}:::glossary-dict(?:[\t ]+([A-Za-z][A-Za-z0-9_-]*))?[\t ]*$/;
const MATCH_OPEN_RE = /^[\t ]{0,3}:::glossary-match[\t ]*$/;
const CLOSE_RE = /^[\t ]{0,3}:{3,}[\t ]*$/;
const FENCE_RE = /^[\t ]{0,3}(`{3,}|~{3,})/;
export const TERM_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

// 仅在「分号后紧跟合法 `语境=`」处切分多义项，避免义项正文内部的公式等号或分号被误切。
const SENSE_SPLIT_RE = /[;；](?=\s*[^\s=＝$\\()（）]{1,24}\s*[=＝])/;
// 语境名不能含空白、$、反斜杠或括号（防止公式里的 `$u_2=M...$` 被误切为多义项）。
const SENSE_RE = /^\s*([^\s=＝$\\()（）]{1,24})\s*[=＝]\s*(.+)$/;

function parseSenses(text) {
  const parts = String(text || '').split(SENSE_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const senses = [];
  for (const p of parts) {
    const m = SENSE_RE.exec(p);
    if (!m) return null;
    senses.push({ ctx: m[1].trim(), text: m[2].trim() });
  }
  return senses;
}

function parseDictLine(line) {
  const parts = line.split('|');
  if (parts.length < 3) return null;
  const id = parts[0].trim();
  if (!TERM_ID_RE.test(id)) return null;
  const title = parts[1].trim();
  const head = parts[2].trim();
  const tail = parts.slice(3).join('|').trim();
  const senses = parseSenses(tail);
  return { id, title, text: senses ? head : parts.slice(2).join('|').trim(), senses };
}

function stepFence(line, fence) {
  const f = FENCE_RE.exec(line);
  if (!f) return { matched: false, fence };
  const marker = f[1];
  if (!fence) return { matched: true, fence: { ch: marker[0], len: marker.length } };
  if (marker[0] === fence.ch && marker.length >= fence.len) return { matched: true, fence: null };
  return { matched: true, fence };
}

function isIgnorableLine(line) {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

function addDictEntry(dict, line) {
  if (isIgnorableLine(line)) return;
  const entry = parseDictLine(line);
  if (!entry) return;
  dict[entry.id] = entry.senses
    ? { title: entry.title, text: entry.text, senses: entry.senses }
    : { title: entry.title, text: entry.text };
}

/**
 * 从 Markdown 源里解析 :::glossary-dict 围栏，返回 { id: {title, text, senses?} }。
 */
export function parseGlossaryDict(source) {
  const dict = {};
  if (typeof source !== 'string') return dict;
  let fence = null;
  let inDict = false;
  for (const line of source.split(/\r?\n/)) {
    const step = stepFence(line, fence);
    fence = step.fence;
    if (step.matched || fence) continue;
    if (!inDict) {
      inDict = DICT_OPEN_RE.test(line);
      continue;
    }
    if (CLOSE_RE.test(line)) {
      inDict = false;
      continue;
    }
    addDictEntry(dict, line);
  }
  return dict;
}

const splitList = (s) => String(s || '').split(/[、,，]/).map((x) => x.trim()).filter(Boolean);

function mergeMatchEntry(out, line) {
  const parts = line.split('|');
  if (parts.length < 2) return;
  const id = parts[0].trim();
  if (!TERM_ID_RE.test(id)) return;
  const prose = splitList(parts[1]);
  const tex = splitList(parts[2]);
  if (!out[id]) {
    out[id] = { prose, tex };
    return;
  }
  out[id] = {
    prose: [...new Set([...out[id].prose, ...prose])],
    tex: [...new Set([...out[id].tex, ...tex])],
  };
}

/**
 * 解析 :::glossary-match 围栏：`id | 正文形式（、分隔）| TeX 形式（、分隔，可省）`。
 */
export function parseGlossaryMatch(source) {
  const out = {};
  if (typeof source !== 'string') return out;
  let fence = null;
  let inMatch = false;
  for (const line of source.split(/\r?\n/)) {
    const step = stepFence(line, fence);
    fence = step.fence;
    if (step.matched || fence) continue;
    if (!inMatch) {
      inMatch = MATCH_OPEN_RE.test(line);
      continue;
    }
    if (CLOSE_RE.test(line)) {
      inMatch = false;
      continue;
    }
    if (!isIgnorableLine(line)) mergeMatchEntry(out, line);
  }
  return out;
}

function handleStripOutside(state, line) {
  const open = DICT_OPEN_RE.exec(line);
  if (open || MATCH_OPEN_RE.test(line)) {
    state.inDict = true;
    state.asTable = open?.[1] === 'table';
    state.entries = [];
    return;
  }
  state.out.push(line);
}

function handleStripInside(state, line, onTable) {
  if (!CLOSE_RE.test(line)) {
    const entry = state.asTable ? parseDictLine(line) : null;
    if (entry) state.entries.push(entry);
    return;
  }
  state.inDict = false;
  if (state.asTable && onTable && state.entries.length) state.out.push(onTable(state.entries));
  state.asTable = false;
  state.entries = [];
}

/**
 * 剥掉全部 :::glossary-dict 与 :::glossary-match 围栏；
 * `:::glossary-dict table` 且提供 onTable 时在原位留出表占位。
 */
export function stripDictFences(lines, onTable = null) {
  const state = { out: [], fence: null, inDict: false, asTable: false, entries: [] };
  for (const line of lines) {
    const step = stepFence(line, state.fence);
    state.fence = step.fence;
    if (step.matched || state.fence) {
      state.out.push(line);
      continue;
    }
    if (!state.inDict) handleStripOutside(state, line);
    else handleStripInside(state, line, onTable);
  }
  return state.out;
}

function isBrokenRegexForm(form) {
  if (!form.includes('/')) return false;
  return !(form.startsWith('/') && /^\/(.+)\/([a-z]*)$/s.test(form));
}

/**
 * 校验 match 规则是否存在被列表分隔符「、,，」切碎的裸正则碎片。
 */
export function validateMatchSyntax(packName, matches) {
  const warnings = [];
  for (const [id, m] of Object.entries(matches || {})) {
    for (const form of [...(m.prose || []), ...(m.tex || [])]) {
      if (!isBrokenRegexForm(form)) continue;
      warnings.push(
        `包「${packName}」的 ${id} 声明「${form}」像被列表分隔符切碎的正则——若确要整条正则，`
        + '请把「、。，」写成 \\u3001\\u3002\\uff0c 转义（否则该声明静默失效）',
      );
    }
  }
  return warnings;
}

function excludeProseIds(dict, proseDict, ids, onWarn) {
  for (const id of ids) {
    if (!Object.hasOwn(dict, id)) {
      onWarn?.(`符号排除指向本页环境里没有的词条 ${id}`);
      continue;
    }
    const e = proseDict[id];
    if (e?.prose?.length) proseDict[id] = { ...e, prose: [] };
  }
}

function excludeTexIds(dict, texDict, ids, onWarn) {
  for (const id of ids) {
    if (!Object.hasOwn(dict, id)) {
      onWarn?.(`符号排除公式指向本页环境里没有的词条 ${id}`);
      continue;
    }
    delete texDict[id];
  }
}

/**
 * 应用页面级「符号排除」「符号排除公式」。
 */
export function applySymbolExclusions(dict = {}, exclusions = {}, onWarn = null) {
  const proseDict = { ...dict };
  const texDict = { ...dict };
  excludeProseIds(dict, proseDict, exclusions.noProse || exclusions.prose || [], onWarn);
  excludeTexIds(dict, texDict, exclusions.noTex || exclusions.tex || [], onWarn);
  return { proseDict, texDict };
}
