/**
 * Turn handling shared by the plain chat route and agent turns (lib/chat/turns.ts
 * has the contract). Two steps around the existing flow:
 *   decideTurn: after the thread's messages are loaded, before anything is written.
 *   openTurn:   writes (or, for a retry, reuses) the user message.
 */
import { NextResponse } from 'next/server';
import { PRIVATE_HEADERS } from './request';
import { appendMessage, ChatStoreError, type ChatDb, type Mention, type StoredMessage } from './store';
import { decideSend, publicTurn, resolveTurn, TURN_CONFLICT_TEXT, type SendDecision, type TurnView } from './turns';

export interface TurnRequest { readonly turnId: string | null; readonly retry: boolean }

type Conflict = Extract<SendDecision, { kind: 'conflict' }>;

export function turnConflictResponse(c: Pick<Conflict, 'code' | 'turn'>): NextResponse {
  return NextResponse.json({ error: TURN_CONFLICT_TEXT[c.code], code: c.code, turn: publicTurn(c.turn) }, { status: 409, headers: PRIVATE_HEADERS });
}

/** null: go ahead (fresh send, or turn-less). TurnView: retry that turn. NextResponse: answer with this (409), no model call. */
export function decideTurn(history: readonly StoredMessage[], req: TurnRequest, content: string): TurnView | null | NextResponse {
  if (!req.turnId) return null;
  const d = decideSend(resolveTurn(history, req.turnId, Date.now()), req.retry, content);
  if (d.kind === 'conflict') return turnConflictResponse(d);
  return d.kind === 'retry' ? d.turn : null;
}

export interface OpenedTurn { readonly userMessage: StoredMessage; readonly turnId: string | null; readonly retried: boolean }

/**
 * The turn's user message. A concurrent send of the same turn loses the
 * unique index race and is answered like any repeat (409 TURN_EXISTS).
 * On a database without turn ids (expand window) the send proceeds turn-less.
 */
export async function openTurn(db: ChatDb, input: {
  organizationId: string; threadId: string; content: string; mentions: readonly Mention[];
}, req: TurnRequest, retry: TurnView | null, reload: () => Promise<readonly StoredMessage[]>): Promise<OpenedTurn | NextResponse> {
  if (retry) return { userMessage: retry.userMessage, turnId: retry.id, retried: true };
  const base = { organizationId: input.organizationId, threadId: input.threadId, role: 'user' as const, content: input.content, mentions: input.mentions };
  if (!req.turnId) return { userMessage: await appendMessage(db, base), turnId: null, retried: false };
  try {
    return { userMessage: await appendMessage(db, { ...base, turnId: req.turnId }), turnId: req.turnId, retried: false };
  } catch (e) {
    if (!(e instanceof ChatStoreError)) throw e;
    if (e.code === 'TURNS_UNSUPPORTED') return { userMessage: await appendMessage(db, base), turnId: null, retried: false };
    if (e.code !== 'TURN_EXISTS') throw e;
    const turn = resolveTurn(await reload(), req.turnId, Date.now());
    if (!turn) throw new ChatStoreError('STORE_UNAVAILABLE');
    return turnConflictResponse({ code: 'TURN_EXISTS', turn });
  }
}
