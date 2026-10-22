/**
 * Knowledge selection (FAQ v1) — which of an organization's enabled
 * FAQ entries, if any, are relevant to the customer's message.
 *
 * DETERMINISTIC ON PURPOSE. V1 has no embeddings and no model call:
 * token-overlap scoring between the message and each entry's
 * question+answer, a positive-score threshold, and hard caps. The
 * properties that matter are the negative ones:
 *
 *   - No overlap → NO entries. The prompt is then exactly the
 *     pre-FAQ prompt, and the anti-invention guardrail governs the
 *     answer (decline + capture the lead) instead of the model
 *     improvising from an irrelevant entry.
 *   - Caps bound the blast radius: at most `maxEntries` entries and
 *     `maxChars` of entry text ever enter a prompt, however large
 *     the knowledge base grows.
 *   - Same input → same output. Selection never depends on timing,
 *     randomness, or a provider, so a draft can be re-derived and
 *     the behavior is unit-testable without mocks of a model.
 *
 * Tokenization is deliberately simple: lowercase, split on
 * non-alphanumerics, drop tokens shorter than 3 characters and a
 * small stopword set for Spanish and English. Accent folding is
 * applied so "horario" matches "¿Cuál es el horario?" regardless of
 * diacritics in either text.
 */

export interface KnowledgeEntryRow {
  question: string;
  answer: string;
}

export interface KnowledgeSelectionOptions {
  maxEntries?: number;
  maxChars?: number;
}

const DEFAULT_MAX_ENTRIES = 5;
const DEFAULT_MAX_CHARS = 4000;

const STOPWORDS = new Set([
  'que', 'qué', 'como', 'cómo', 'cuando', 'cuándo', 'donde', 'dónde',
  'cual', 'cuál', 'para', 'por', 'con', 'sin', 'los', 'las', 'una',
  'uno', 'del', 'por favor', 'hola', 'gracias',
  'the', 'and', 'for', 'you', 'your', 'are', 'can', 'what', 'when',
  'where', 'which', 'how', 'much', 'many', 'does', 'have', 'has',
  'please', 'thanks', 'hello',
]);

function tokenize(text: string): Set<string> {
  const folded = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const tokens = new Set<string>();
  for (const raw of folded.split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 && !STOPWORDS.has(raw)) {
      tokens.add(raw);
    }
  }
  return tokens;
}

/**
 * Select the entries relevant to `sourceText`, best first.
 * Returns an empty array when nothing clears the overlap bar —
 * callers must treat that as "no knowledge for this message", not
 * as an error.
 */
export function selectKnowledgeEntries(
  entries: readonly KnowledgeEntryRow[],
  sourceText: string,
  options: KnowledgeSelectionOptions = {}
): KnowledgeEntryRow[] {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const messageTokens = tokenize(sourceText);
  if (messageTokens.size === 0) {
    return [];
  }

  const scored: Array<{ entry: KnowledgeEntryRow; score: number }> = [];
  for (const entry of entries) {
    const entryTokens = tokenize(`${entry.question} ${entry.answer}`);
    let score = 0;
    for (const token of messageTokens) {
      if (entryTokens.has(token)) {
        score += 1;
      }
    }
    if (score > 0) {
      scored.push({ entry, score });
    }
  }

  // Stable, deterministic order: score desc, then question text —
  // so two runs over the same data select identically even when the
  // database returns rows in a different order.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.entry.question.localeCompare(b.entry.question);
  });

  const selected: KnowledgeEntryRow[] = [];
  let chars = 0;
  for (const { entry } of scored) {
    if (selected.length >= maxEntries) break;
    const size = entry.question.length + entry.answer.length;
    if (chars + size > maxChars && selected.length > 0) break;
    selected.push(entry);
    chars += size;
  }
  return selected;
}
