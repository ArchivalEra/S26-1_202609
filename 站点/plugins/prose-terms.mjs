/**
 * 正文符号取词兼容出口（实际逻辑已收口进深核心 `站点/symbols/`）。
 */

export {
  parseGlossaryDict,
  parseGlossaryMatch,
  applySymbolExclusions,
  autoWrapTerms,
  renderGlossary,
  SYMBOLS_BUBBLE_JS as GLOSSARY_JS,
} from '../symbols/index.mjs';
