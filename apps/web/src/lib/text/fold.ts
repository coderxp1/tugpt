/**
 * Text folding for search: compatibility-decompose (NFKD), drop combining
 * marks, lower-case, and spell out letters that do not decompose (ß → ss).
 * "José", "JOSE", "Jose\u0301" and "jose" all fold to "jose"; "ﬁ" folds to "fi".
 * Used by every search box so they all behave the same.
 */
const MARKS = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g;

export function foldText(value: string): string {
  return value.normalize('NFKD').replace(MARKS, '').toLowerCase().replace(/ß/g, 'ss');
}

/** Folded, whitespace-separated search words; empty when the query is blank. */
export function searchWords(query: string): string[] {
  return foldText(query).split(/\s+/).filter(Boolean);
}
