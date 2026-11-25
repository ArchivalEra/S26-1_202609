/**
 * 全站符号系统深核心（唯一对外出口）。
 */

export {
  SYMBOL_SELECTORS,
  SYMBOL_SELECTOR,
  SYMBOL_RUNTIME_ASSET,
  SYMBOL_JSON_SCRIPT_ID,
  escHtml,
  plainBubbleText,
  formatSymbolAnchor,
} from './contracts.mjs';
export { parseFrontmatter, readPageSymbolPolicy } from './frontmatter.mjs';
export {
  parseGlossaryDict,
  parseGlossaryMatch,
  stripDictFences,
  validateMatchSyntax,
  applySymbolExclusions,
} from './fences.mjs';
export { autoWrapTerms, renderGlossary } from './prose.mjs';
export { SYMBOLS_BUBBLE_JS } from './runtime.mjs';
export { createSymbolCatalog } from './catalog.mjs';
