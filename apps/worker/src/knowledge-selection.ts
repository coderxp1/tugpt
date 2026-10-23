/**
 * Knowledge selection — the canonical implementation lives in
 * @tugpt/database (knowledge-selection.ts) so the worker's draft
 * grounding and the web app's retrieval preview select
 * identically. This module re-exports it for the worker's own
 * import paths; do not fork the algorithm here.
 */
export {
  selectKnowledgeEntries,
  type KnowledgeEntryRow,
  type KnowledgeSelectionOptions,
} from '@tugpt/database';
