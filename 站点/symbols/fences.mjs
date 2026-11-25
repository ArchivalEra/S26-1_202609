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

/**
 * 从 Markdown 源里解析 :::glossary-dict 围栏，返回 { id: {title, text, senses?} }。
 */
export function parseGlossaryDict(source) {
  const dict = {};
  if (typeof source !== 'string') return dict;
  const lines = source.split(/\r?\n/);
  let fence = null;
  let inDict = false;
  for (const line of lines) {
    const f = FENCE_RE.exec(line);
    if (f) {
      const marker = f[1];
      if (!fence) fence = { ch: marker[0], len: marker.length };
      else if (marker.startsWith(fence.ch) && marker.length >= fence.len) fence = null;
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
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
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
 */
export function parseGlossaryMatch(source) {
  const out = {};
  if (typeof source !== 'string') return out;
  const lines = source.split(/\r?\n/);
  let fence = null;
  let inMatch = false;
  const list = (s) => String(s || '').split(/[、,，]/).map((x) => x.trim()).filter(Boolean);
  for (const line of lines) {
    const f = FENCE_RE.exec(line);
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
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const parts = line.split('|');
    if (parts.length < 2) continue;
    const id = parts[0].trim();
    if (!TERM_ID_RE.test(id)) continue;
    const prose = list(parts[1]);
    const tex = list(parts[2]);
    if (out[id]) {
      out[id] = {
        prose: [...new Set([...out[id].prose, ...prose])],
        tex: [...new Set([...out[id].tex, ...tex])],
      };
    } else {
      out[id] = { prose, tex };
    }
  }
  return out;
}

/**
 * 剥掉全部 :::glossary-dict 与 :::glossary-match 围栏；
 * `:::glossary-dict table` 且提供 onTable 时在原位留出表占位。
 */
export function stripDictFences(lines, onTable = null) {
  const out = [];
  let fence = null;
  let inDict = false;
  let asTable = false;
  let entries = [];
  const flush = () => {
    if (asTable && onTable && entries.length) out.push(onTable(entries));
  };
  for (const line of lines) {
    const f = FENCE_RE.exec(line);
    if (f) {
      const marker = f[1];
      if (!fence) fence = { ch: marker[0], len: marker.length };
      else if (marker.startsWith(fence.ch) && marker.length >= fence.len) fence = null;
      out.push(line);
      continue;
    }
    if (fence) {
      out.push(line);
      continue;
    }
    if (!inDict) {
      const open = DICT_OPEN_RE.exec(line);
      if (open) {
        inDict = true;
        asTable = open[1] === 'table';
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
 * 校验 match 规则是否存在被列表分隔符「、,，」切碎的裸正则碎片。
 */
export function validateMatchSyntax(packName, matches) {
  const warnings = [];
  for (const [id, m] of Object.entries(matches || {})) {
    for (const form of [...(m.prose || []), ...(m.tex || [])]) {
      if (!form.includes('/')) continue;
      if (form.startsWith('/') && /^\/(.+)\/([a-z]*)$/s.test(form)) continue;
      warnings.push(
        `包「${packName}」的 ${id} 声明「${form}」像被列表分隔符切碎的正则——若确要整条正则，`
        + '请把「、。，」写成 \\u3001\\u3002\\uff0c 转义（否则该声明静默失效）',
      );
    }
  }
  return warnings;
}

/**
 * 应用页面级「符号排除」「符号排除公式」。
 */
export function applySymbolExclusions(dict = {}, exclusions = {}, onWarn = null) {
  const warn = (m) => onWarn?.(m);
  const noProse = exclusions.noProse || exclusions.prose || [];
  const noTex = exclusions.noTex || exclusions.tex || [];
  const proseDict = { ...dict };
  const texDict = { ...dict };
  for (const id of noProse) {
    if (!Object.hasOwn(dict, id)) {
      warn(`符号排除指向本页环境里没有的词条 ${id}`);
      continue;
    }
    const e = proseDict[id];
    if (e?.prose && e.prose.length) proseDict[id] = { ...e, prose: [] };
  }
  for (const id of noTex) {
    if (!Object.hasOwn(dict, id)) {
      warn(`符号排除公式指向本页环境里没有的词条 ${id}`);
      continue;
    }
    delete texDict[id];
  }
  return { proseDict, texDict };
}
