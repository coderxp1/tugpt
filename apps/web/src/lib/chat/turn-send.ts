/**
 * Turn handling shared by the plain chat route and agent turns (lib/chat/turns.ts
 * has the contract). Steps around the existing flow:
 *   decideTurn:  before retrieval or any write; loads the turn by indexed lookups.
 *   claimRetry:  a retry takes the turn's run lease (Q-13) BEFORE the model is called;
 *                refused -> 409, never a second concurrent run. Fails closed.
 *   openTurn:    writes (or, for a retry, reuses) the user message.
 *   claimFresh:  a fresh turn takes its lease right after its user message exists, so
 *                its status reads 'pending' while it runs. Best effort: the unique user
 *                message already makes a fresh send idempotent.
 *   run.release: after the answer is stored (an unreleased lease expires on its own).
 *
 * withServerTurnId (USAGE-1, Q-16): a send without a turnId gets a server-minted one before
 * decideTurn, so it runs exactly like a client's fresh turn (user message stamped, lease,
 * attempt 0) and every model call it makes is metered against that turn. The id is a random
 * UUID echoed in the 'user'/'done'/'error' events; a client can adopt it for GET .../turns/{id}
 * and retry: true.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { PRIVATE_HEADERS } from './request';
import {
  appendMessage, ChatStoreError, claimTurnRun, loadTurn, releaseTurnRun, type ChatDb, type Mention, type StoredMessage,
} from './store';
import {
  assembleTurn, claimRefusalCode, decideSend, publicTurn, TURN_CONFLICT_TEXT, type SendDecision, type TurnView,
} from './turns';

export interface TurnRequest { readonly turnId: string | null; readonly retry: boolean }
export interface TurnScope { readonly organizationId: string; readonly userId: string; readonly threadId: string }

/**
 * A turn-less send becomes a fresh turn with a server-minted id; a client's turnId (fresh,
 * repeat or retry) passes through unchanged. parseTurnRequest already refuses retry without a turnId.
 */
export function withServerTurnId(req: TurnRequest, mint: () => string = randomUUID): TurnRequest {
  if (req.turnId) return req;
  return { turnId: mint().toLowerCase(), retry: false };
}

type Conflict = Extract<SendDecision, { kind: 'conflict' }>;

export function turnConflictResponse(c: Pick<Conflict, 'code' | 'turn'>): NextResponse {
  return NextResponse.json({ error: TURN_CONFLICT_TEXT[c.code], code: c.code, turn: publicTurn(c.turn) }, { status: 409, headers: PRIVATE_HEADERS });
}

/** The turn as the caller sees it now (RLS), or null when it was never stored. */
export async function currentTurn(db: ChatDb, scope: TurnScope, turnId: string, withHistory = false): Promise<TurnView | null> {
  const parts = await loadTurn(db, scope.organizationId, scope.threadId, turnId, { withHistory });
  return parts ? assembleTurn(parts, Date.now()) : null;
}

/** null: go ahead (fresh send, or turn-less). TurnView: retry that turn (with .before). NextResponse: 409, no model call. */
export async function decideTurn(db: ChatDb, scope: TurnScope, req: TurnRequest, content: string): Promise<TurnView | null | NextResponse> {
  if (!req.turnId) return null;
  const d = decideSend(await currentTurn(db, scope, req.turnId, req.retry), req.retry, content);
  if (d.kind === 'conflict') return turnConflictResponse(d);
  return d.kind === 'retry' ? d.turn : null;
}

export interface TurnRun { release(): Promise<void> }
const NO_RUN: TurnRun = { release: async () => undefined };

function heldRun(control: ChatDb, scope: TurnScope, turnId: string, runId: string): TurnRun {
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await releaseTurnRun(control, { ...scope, turnId, runId });
    },
  };
}

/**
 * The retry's lease. Claimed against the answer this request saw, so a retry that lost a
 * race (another attempt is running, or already stored a newer answer) is answered with 409
 * and the turn as it is now. A database without turn runs (pre-Q-13) runs unlocked, as in Q-12.
 */
export async function claimRetry(control: ChatDb, db: ChatDb, scope: TurnScope, turn: TurnView): Promise<TurnRun | NextResponse> {
  const c = await claimTurnRun(control, { ...scope, turnId: turn.id, expectedAnswerId: turn.assistantMessage?.id ?? null, requireLatest: true });
  if (c.outcome === 'claimed') return heldRun(control, scope, turn.id, c.runId);
  if (c.outcome === 'unsupported') return NO_RUN;
  const now = (await currentTurn(db, scope, turn.id)) ?? turn;
  return turnConflictResponse({ code: claimRefusalCode(c.outcome, now), turn: now });
}

/** A fresh turn's lease (best effort; see the header). */
export async function claimFresh(control: ChatDb, scope: TurnScope, turnId: string | null): Promise<TurnRun> {
  if (!turnId) return NO_RUN;
  try {
    const c = await claimTurnRun(control, { ...scope, turnId, expectedAnswerId: null, requireLatest: false });
    return c.outcome === 'claimed' ? heldRun(control, scope, turnId, c.runId) : NO_RUN;
  } catch { return NO_RUN; }
}

export interface OpenedTurn { readonly userMessage: StoredMessage; readonly turnId: string | null; readonly retried: boolean }

/**
 * The turn's user message. A concurrent send of the same turn loses the
 * unique index race and is answered like any repeat (409 TURN_EXISTS).
 * On a database without turn ids (expand window) the send proceeds turn-less.
 */
export async function openTurn(db: ChatDb, input: {
  organizationId: string; threadId: string; content: string; mentions: readonly Mention[];
}, req: TurnRequest, retry: TurnView | null, reload: () => Promise<TurnView | null>): Promise<OpenedTurn | NextResponse> {
  if (retry) return { userMessage: retry.userMessage, turnId: retry.id, retried: true };
  const base = { organizationId: input.organizationId, threadId: input.threadId, role: 'user' as const, content: input.content, mentions: input.mentions };
  if (!req.turnId) return { userMessage: await appendMessage(db, base), turnId: null, retried: false };
  try {
    return { userMessage: await appendMessage(db, { ...base, turnId: req.turnId }), turnId: req.turnId, retried: false };
  } catch (e) {
    if (!(e instanceof ChatStoreError)) throw e;
    if (e.code === 'TURNS_UNSUPPORTED') return { userMessage: await appendMessage(db, base), turnId: null, retried: false };
    if (e.code !== 'TURN_EXISTS') throw e;
    const turn = await reload();
    if (!turn) throw new ChatStoreError('STORE_UNAVAILABLE');
    return turnConflictResponse({ code: turn.status === 'pending' ? 'TURN_IN_PROGRESS' : 'TURN_EXISTS', turn });
  }
}
