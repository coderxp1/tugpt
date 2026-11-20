/**
 * Clean model text before a person sees it. Model text is never evidence that anything ran: only the
 * server's own tool execution produces tool_start/tool_result events and tool rows.
 *
 * Observed on the private model (TuGPT Scout on Ollama, Nov 20): the chat template ends the last message
 * without <|eot|>, so the model sometimes keeps writing after its answer. The special header tokens are
 * dropped from the text, which leaves a bare role word glued to the previous text ("}assistant\n\n",
 * "approval.assistant\n\n") followed by more turns, invented tool results and text-form tool calls such
 * as [{"name": "create_entities", "parameters": {...}}]. Rules here:
 *   - a turn ends at the first leaked role header (cutAtTurnBoundary / TurnBoundaryFilter);
 *   - text-form tool calls for an offered tool are removed; they are never executed;
 *   - when no tool ran successfully in the turn, result-like JSON is removed as well.
 */

/** A role header the template leaked as text: the role word right after punctuation or at a line start. */
const BOUNDARY = /(?:(?<=[^\p{L}\p{N}\s])|^)(?:assistant|ipython|user)\n\n/mu;
/** The same at the very end of the text, when the model stopped right after a header. */
const TRAILING_HEADER = /(?:(?<=[^\p{L}\p{N}\s])|^)(?:assistant|ipython|user)\s*$/mu;
/** Longest possible boundary ("assistant\n\n" is 11 characters) plus one. */
const HOLD = 12;

export function cutAtTurnBoundary(text: string): string {
  const m = BOUNDARY.exec(text);
  const head = m ? text.slice(0, m.index) : text;
  return head.replace(TRAILING_HEADER, '');
}

/** Streaming form of cutAtTurnBoundary: holds back a short tail until it cannot be the start of a header. */
export class TurnBoundaryFilter {
  private all = '';
  private sent = 0;
  ended = false;

  push(chunk: string): string {
    if (this.ended) return '';
    this.all += chunk;
    const m = BOUNDARY.exec(this.all);
    if (m) {
      const out = this.all.slice(this.sent, Math.max(this.sent, m.index));
      this.sent = Math.max(this.sent, m.index);
      this.ended = true;
      return out;
    }
    const safe = Math.max(this.sent, this.all.length - HOLD);
    const out = this.all.slice(this.sent, safe);
    this.sent = safe;
    return out;
  }

  flush(): string {
    if (this.ended) return '';
    this.ended = true;
    const rest = this.all.slice(this.sent);
    const cleaned = (this.all.slice(0, this.sent) + rest).replace(TRAILING_HEADER, '');
    return cleaned.slice(this.sent);
  }
}

interface JsonBlock { readonly start: number; readonly end: number; readonly value: unknown; readonly closed: boolean }

/** JSON objects/arrays embedded in text, string-aware; an unterminated block runs to the end. */
function jsonBlocks(text: string): JsonBlock[] {
  const out: JsonBlock[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') { i++; continue; }
    let depth = 0; let inStr = false; let esc = false; let end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    if (end < 0) { out.push({ start: i, end: text.length, value: undefined, closed: false }); break; }
    let value: unknown;
    try { value = JSON.parse(text.slice(i, end)); } catch { value = undefined; }
    if (value !== undefined) { out.push({ start: i, end, value, closed: true }); i = end; } else i++;
  }
  return out;
}

const objects = (v: unknown): Record<string, unknown>[] =>
  (Array.isArray(v) ? v : [v]).filter((o): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o));

const FRAGMENT_CALL = /^[[{]\s*\{?\s*"name"\s*:\s*"([A-Za-z0-9_-]{1,64})"/;

function isTextToolCall(b: JsonBlock, text: string, offered: ReadonlySet<string>): boolean {
  if (!b.closed) { const m = FRAGMENT_CALL.exec(text.slice(b.start)); return !!m && offered.has(m[1]); }
  return objects(b.value).some((o) => typeof o.name === 'string' && offered.has(o.name) && ('parameters' in o || 'arguments' in o));
}

function isResultLike(b: JsonBlock, text: string): boolean {
  if (!b.closed) return /^[[{]\s*[{"]/.test(text.slice(b.start));
  return objects(b.value).length > 0;
}

function removeBlocks(text: string, keep: (b: JsonBlock) => boolean): string {
  let out = ''; let at = 0;
  for (const b of jsonBlocks(text)) { if (keep(b)) continue; out += text.slice(at, b.start); at = b.end; }
  return out + text.slice(at);
}

/**
 * The text of a turn in which tools were offered. Returns '' when nothing presentable is left; the
 * caller then uses a fixed server text.
 */
export function cleanToolTurnText(text: string, opts: { readonly offered: ReadonlySet<string>; readonly anySucceeded: boolean }): string {
  let t = cutAtTurnBoundary(text);
  t = removeBlocks(t, (b) => !isTextToolCall(b, t, opts.offered));
  if (!opts.anySucceeded) t = removeBlocks(t, (b) => !isResultLike(b, t));
  return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
