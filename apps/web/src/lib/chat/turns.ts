/**
 * Idempotent chat turns (Q-12, 20261121100001).
 *
 * A turn is one user message plus the assistant/tool messages written for it.
 * The client picks the turn id (a UUID v4) BEFORE it sends and keeps it until
 * the turn settles. After an ambiguous failure (network error, 5xx, a stream
 * that ended without 'done'/'error') it never re-sends blindly:
 *   1. GET /api/v1/chat/threads/{threadId}/turns/{turnId}
 *        404              -> the server never stored the turn; send it again (same turnId).
 *        status pending   -> still running (or the server is about to settle it); poll.
 *        status complete  -> show turn.assistantMessage; done.
 *        status error | stopped | interrupted -> offer "Retry"; POST with retry: true.
 *   2. POST .../messages { content, turnId, retry: true } re-runs the turn on the
 *      EXISTING user message: no second user message is ever written.
 *
 * Statuses: complete | error | stopped come from the turn's latest assistant
 * message. Without one, the turn is 'pending' while the request can still be
 * running (PENDING_WINDOW_MS, above the route's maxDuration) and 'interrupted'
 * after that (the server died before it could store an answer).
 *
 * Pure functions only; the routes do the I/O.
 */
import type { StoredMessage } from './store';

export const PENDING_WINDOW_MS = 150_000;

export type TurnStatus = 'complete' | 'error' | 'stopped' | 'pending' | 'interrupted';

export interface TurnView {
  readonly id: string;
  readonly status: TurnStatus;
  readonly userMessage: StoredMessage;
  /** The latest answer for this turn (a retried turn keeps its earlier attempts in the thread). */
  readonly assistantMessage: StoredMessage | null;
  /** True when this is the thread's latest user turn (only that one can be retried). */
  readonly latest: boolean;
  /** Messages before the user message: the model's history when the turn is retried. */
  readonly before: readonly StoredMessage[];
}

/** The public shape (GET .../turns/{turnId} and 409 bodies). */
export function publicTurn(t: TurnView) {
  return { id: t.id, status: t.status, latest: t.latest, userMessage: t.userMessage, assistantMessage: t.assistantMessage };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** turnId/retry from a request body: absent = a turn-less send (unchanged behaviour). */
export function parseTurnRequest(body: Record<string, unknown>): { turnId: string | null; retry: boolean } | null {
  const { turnId, retry } = body;
  if (retry !== undefined && typeof retry !== 'boolean') return null;
  if (turnId === undefined || turnId === null) return retry ? null : { turnId: null, retry: false };
  if (typeof turnId !== 'string' || !UUID.test(turnId)) return null;
  return { turnId: turnId.toLowerCase(), retry: retry === true };
}

/** The turn in a thread's messages (ascending by created_at), or null when no user message opened it. */
export function resolveTurn(messages: readonly StoredMessage[], turnId: string, now: number): TurnView | null {
  const idx = messages.findIndex((m) => m.role === 'user' && m.turnId === turnId);
  if (idx < 0) return null;
  const userMessage = messages[idx];
  let assistantMessage: StoredMessage | null = null;
  for (const m of messages) if (m.role === 'assistant' && m.turnId === turnId) assistantMessage = m;
  let status: TurnStatus;
  if (assistantMessage) status = assistantMessage.status;
  else {
    const age = now - Date.parse(userMessage.createdAt);
    status = Number.isFinite(age) && age < PENDING_WINDOW_MS ? 'pending' : 'interrupted';
  }
  let lastUser = -1;
  messages.forEach((m, i) => { if (m.role === 'user') lastUser = i; });
  return { id: turnId, status, userMessage, assistantMessage, latest: lastUser === idx, before: messages.slice(0, idx) };
}

export type SendDecision =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'retry'; readonly turn: TurnView }
  | { readonly kind: 'conflict'; readonly code: 'TURN_EXISTS' | 'TURN_IN_PROGRESS' | 'TURN_NOT_LATEST' | 'TURN_CONFLICT'; readonly turn: TurnView };

/** What a POST with this turn id does, given the turn's current state. Never calls the model for a settled turn. */
export function decideSend(existing: TurnView | null, retry: boolean, content: string): SendDecision {
  if (!existing) return { kind: 'fresh' }; // includes retry of a turn the server never stored
  if (existing.userMessage.content !== content) return { kind: 'conflict', code: 'TURN_CONFLICT', turn: existing };
  if (!retry || existing.status === 'complete') return { kind: 'conflict', code: 'TURN_EXISTS', turn: existing };
  if (existing.status === 'pending') return { kind: 'conflict', code: 'TURN_IN_PROGRESS', turn: existing };
  if (!existing.latest) return { kind: 'conflict', code: 'TURN_NOT_LATEST', turn: existing };
  return { kind: 'retry', turn: existing };
}

export const TURN_CONFLICT_TEXT: Record<Extract<SendDecision, { kind: 'conflict' }>['code'], string> = {
  TURN_EXISTS: 'This message was already sent',
  TURN_IN_PROGRESS: 'This message is still being answered',
  TURN_NOT_LATEST: 'Only the latest message can be retried',
  TURN_CONFLICT: 'This turn id was used for a different message',
};

/**
 * The model's view of earlier messages: no tool notes, no failed answers, and
 * for a retried turn only its latest answer (earlier stopped attempts stay
 * visible in the thread but are not replayed to the model).
 */
export function modelHistory(messages: readonly StoredMessage[], limit: number): { role: 'user' | 'assistant'; content: string }[] {
  const lastForTurn = new Map<string, string>();
  for (const m of messages) if (m.role === 'assistant' && m.turnId) lastForTurn.set(m.turnId, m.id);
  return messages
    .filter((m) => m.role !== 'tool' && m.status !== 'error')
    .filter((m) => m.role !== 'assistant' || !m.turnId || lastForTurn.get(m.turnId) === m.id)
    .slice(-limit)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
}
